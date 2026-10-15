/**
 * Client registry - trust-on-first-use (TOFU) client authentication.
 * Extracted verbatim from server.js (structural refactor only).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
// Client Registry - per-machine identity verification (trust-on-first-use)
// ============================================================================
//
// SECURITY MODEL (deliberate trade-off, like SSH host keys):
// machine_id is a client-generated string (e.g. "username@hostname"), so on
// its own it proves nothing - anyone on the network could claim any
// machine_id and read/delete another engineer's synced data. To bind a
// machine_id to a real client without a full account system or external
// auth provider, we use trust-on-first-use (TOFU) pairing:
//
//   1. The FIRST time a machine_id registers (POST /api/register), the
//      server generates a random 256-bit secret, stores its SHA-256 hash,
//      and returns the secret to the client exactly once. The client
//      persists it locally.
//   2. Every subsequent HTTP request claiming that machine_id must present
//      the secret in the X-Client-Secret header, and every Socket.IO
//      connection must present it in the 'authenticate' payload
//      (client_secret). Missing/wrong secrets are rejected (401/403 or
//      socket disconnect) using constant-time comparison.
//   3. Registration of an ALREADY-KNOWN machine_id without the correct
//      secret is rejected (403) - it can never be used to hijack or
//      silently re-key an existing identity. Only a genuinely new
//      machine_id gets a fresh secret.
//
// TOFU means the very first registration of a machine_id is trusted as-is;
// an attacker who registers someone's machine_id BEFORE the real owner ever
// connects would squat that identity (visible to an admin in clients.json,
// fixable by deleting the entry). This is an accepted trade-off given the
// constraints: simple, self-hosted, install-script-friendly, no external
// auth infrastructure.
//
// Persistence: a plain JSON file (only secret HASHES are stored, never the
// secrets themselves). The rest of this server is in-memory only, so a JSON
// file is the lightest persistence that survives restarts. To reset a
// client (e.g. lost secret), delete its entry from clients.json and restart
// or let the file reload on next write.

const { isAccountAuthEnabled, verifyAccountTicket, ticketFailuresExceeded, recordTicketFailure } = require('./account-tickets');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');

// machine_id -> { secretHash (sha256 hex), createdAt, lastSeen }
let clientRegistry = {};

function loadClientRegistry() {
  try {
    if (fs.existsSync(CLIENTS_FILE)) {
      clientRegistry = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
      console.log(`[Auth] Loaded ${Object.keys(clientRegistry).length} registered client(s) from ${CLIENTS_FILE}`);
    } else {
      console.log(`[Auth] No client registry found at ${CLIENTS_FILE} - starting empty`);
    }
  } catch (error) {
    console.error(`[Auth] Failed to load client registry (${CLIENTS_FILE}):`, error.message);
    console.error('[Auth] Refusing to start with an unreadable registry to avoid silently re-issuing secrets.');
    process.exit(1);
  }
}

function saveClientRegistry() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmpFile = `${CLIENTS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(clientRegistry, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, CLIENTS_FILE);
  } catch (error) {
    console.error('[Auth] Failed to save client registry:', error.message);
  }
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * Constant-time verification of a presented secret against the stored hash
 * for a machine_id. Returns false for unknown machine_id or missing secret.
 */
function verifyClientSecret(machineId, secret) {
  const entry = clientRegistry[machineId];
  if (!entry || !entry.secretHash || !secret || typeof secret !== 'string') {
    return false;
  }
  const expected = Buffer.from(entry.secretHash, 'hex');
  const presented = hashSecret(secret);
  if (expected.length !== presented.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, presented);
}

/**
 * Register a NEW machine_id and return its freshly issued secret.
 * Caller must ensure the machine_id is not already registered.
 */
function registerClient(machineId) {
  const secret = crypto.randomBytes(32).toString('hex');
  clientRegistry[machineId] = {
    secretHash: hashSecret(secret).toString('hex'),
    createdAt: Date.now(),
    lastSeen: Date.now()
  };
  saveClientRegistry();
  console.log(`[Auth] Registered new client: ${machineId}`);
  return secret;
}

/**
 * Retire an identity whose items moved to another one (POST /api/reown):
 * its secret is forgotten, so it can neither authenticate nor be
 * registered again (the entry says where it went).
 */
function retireClient(machineId, newMachineId) {
  const entry = clientRegistry[machineId] || {};
  clientRegistry[machineId] = {
    retiredTo: newMachineId,
    retiredAt: Date.now(),
    createdAt: entry.createdAt || Date.now()
  };
  saveClientRegistry();
  console.log(`[Auth] Retired client ${machineId} -> ${newMachineId}`);
}

/**
 * An account identity recognised by ticket (account-tickets.js): kept in the
 * registry like a paired client so lastSeen / retirement / listings work the
 * same way, but WITHOUT a secret hash - a secret can never authenticate as
 * it, only a ticket of the home server can. An entry that already exists
 * (the identity paired with a secret under an earlier version) keeps its
 * hash: that secret lives with the account on the same home server.
 */
function noteAccountIdentity(identity) {
  const entry = clientRegistry[identity.machineId];
  const account = { userId: identity.userId, username: identity.username };
  if (!entry) {
    clientRegistry[identity.machineId] = { account, createdAt: Date.now(), lastSeen: Date.now() };
    saveClientRegistry();
    console.log(`[Auth] Account identity recognised: ${identity.machineId}`);
    return clientRegistry[identity.machineId];
  }
  entry.lastSeen = Date.now();
  if (!entry.account || entry.account.userId !== account.userId) {
    entry.account = account;
    saveClientRegistry();
  }
  return entry;
}

/**
 * The verified identity behind an account ticket, for a REST request:
 * { machineId, identity } or { status, body } to answer with. `claimed` is
 * the machine_id the request names (must match the ticket's when given).
 */
function authenticateTicket(ticket, claimed, ip) {
  if (ticketFailuresExceeded(ip)) {
    return { status: 429, body: { error: 'Too many failed account tickets from this address. Try again later.', code: 'ACCOUNT_TICKET_RATE_LIMITED' } };
  }
  const result = verifyAccountTicket(ticket);
  if (!result.ok) {
    const retry = recordTicketFailure(ip);
    console.log(`[Auth] ❌ Account ticket rejected from ${ip}: ${result.code} (retry window ${retry}s)`);
    return { status: result.code === 'ACCOUNT_SIGN_IN_NOT_ACCEPTED' ? 403 : 401, body: { error: result.error, code: result.code } };
  }
  if (claimed && claimed !== result.identity.machineId) {
    recordTicketFailure(ip);
    console.log(`[Auth] ❌ Account ticket for "${result.identity.machineId}" from ${ip} used to claim "${claimed}" - rejected`);
    return { status: 403, body: { error: 'The account ticket names another identity than machine_id', code: 'IDENTITY_MISMATCH' } };
  }
  const entry = clientRegistry[result.identity.machineId];
  if (entry && entry.retiredTo) {
    return { status: 403, body: { error: `This identity was moved to "${entry.retiredTo}" and retired.`, code: 'MACHINE_ID_RETIRED', retired_to: entry.retiredTo } };
  }
  noteAccountIdentity(result.identity);
  return { machineId: result.identity.machineId, identity: result.identity };
}

/**
 * Express middleware: require a valid machine_id + X-Client-Secret pair, or
 * an account ticket of the home server (X-Account-Ticket, account-tickets.js).
 * machine_id is taken from the JSON body or the query string (matching how
 * the existing endpoints receive it). On success, req.machineId carries the
 * VERIFIED identity - handlers should trust req.machineId, not raw input.
 */
function requireClientAuth(req, res, next) {
  const machineId = (req.body && req.body.machine_id) || (req.query && req.query.machine_id);
  const secret = req.get('X-Client-Secret') || (req.body && req.body.client_secret);
  const ticket = req.get('X-Account-Ticket');

  if (ticket) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const outcome = authenticateTicket(ticket, machineId, ip);
    if (outcome.status) {
      return res.status(outcome.status).json(outcome.body);
    }
    req.machineId = outcome.machineId;
    req.accountIdentity = outcome.identity;
    return next();
  }

  if (!machineId) {
    return res.status(400).json({ error: 'Missing machine_id' });
  }
  if (!secret) {
    return res.status(401).json({ error: 'Missing X-Client-Secret header. Register via POST /api/register first.' });
  }
  if (!clientRegistry[machineId]) {
    return res.status(401).json({ error: 'Unknown machine_id. Register via POST /api/register first.' });
  }
  if (clientRegistry[machineId].account && !clientRegistry[machineId].secretHash) {
    return res.status(403).json({ error: 'This identity belongs to an account: sign in to the home server, no pairing secret applies.', code: 'ACCOUNT_IDENTITY' });
  }
  if (!verifyClientSecret(machineId, secret)) {
    console.log(`[Auth] ❌ Rejected request for machine_id "${machineId}": invalid client secret`);
    return res.status(403).json({ error: 'Invalid client secret for this machine_id' });
  }

  clientRegistry[machineId].lastSeen = Date.now();
  req.machineId = machineId;
  next();
}

// ============================================================================
// Enrollment gate + registration rate limiting
// ============================================================================
//
// TOFU means the very first registration of a machine_id is trusted as-is.
// With ENROLLMENT_SECRET configured, that first contact must additionally
// present the shared secret (X-Enrollment-Secret header). It is checked ONLY
// on the "unseen machine_id" branch of POST /api/register: already-paired
// devices keep authenticating with their per-machine secret and are not
// affected by enrollment-secret rotation (revoking a device is still a
// clients.json edit). Unset = open enrollment, exactly the old behaviour.

const ENROLLMENT_SECRET = (process.env.ENROLLMENT_SECRET || '').trim();

function isEnrollmentGated() {
  return ENROLLMENT_SECRET.length > 0;
}

/**
 * Pairing is CLOSED on a server that accepts account sign-in (the shape
 * every deployment has since 3.2: the home server fronts this server and
 * vouches for its users with tickets) unless an enrollment secret is set
 * as well - then the gated pairing path stays for clients without an
 * account. A server with neither (development, tests) pairs openly as
 * before, with the startup warning.
 */
function isPairingClosed() {
  return isAccountAuthEnabled() && !isEnrollmentGated();
}

/** Constant-time comparison of a presented enrollment secret. */
function verifyEnrollmentSecret(presented) {
  if (!isEnrollmentGated() || typeof presented !== 'string' || !presented) {
    return false;
  }
  const expected = Buffer.from(ENROLLMENT_SECRET, 'utf8');
  const given = Buffer.from(presented, 'utf8');
  if (expected.length !== given.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, given);
}

// Per-IP cap on /api/register calls. A legitimate client registers once per
// server, so even a small budget is generous; it turns brute force against
// the enrollment secret (or machine_id squatting sprees) into 429s and log
// lines instead of a silent stream of attempts.
const REGISTRATION_RATE_LIMIT = Number(process.env.REGISTRATION_RATE_LIMIT) || 10;
const REGISTRATION_RATE_WINDOW_MS = Number(process.env.REGISTRATION_RATE_WINDOW_MS) || 15 * 60 * 1000;
const registrationAttempts = new Map(); // ip -> { count, windowStart }

/**
 * Record one registration attempt from `ip`. Returns { allowed, remaining,
 * retryAfterSeconds }.
 */
function checkRegistrationRateLimit(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  let entry = registrationAttempts.get(key);
  if (!entry || now - entry.windowStart >= REGISTRATION_RATE_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    registrationAttempts.set(key, entry);
  }
  entry.count += 1;
  // Opportunistic cleanup so the map cannot grow without bound
  if (registrationAttempts.size > 10000) {
    for (const [k, v] of registrationAttempts) {
      if (now - v.windowStart >= REGISTRATION_RATE_WINDOW_MS) registrationAttempts.delete(k);
    }
  }
  const allowed = entry.count <= REGISTRATION_RATE_LIMIT;
  return {
    allowed,
    remaining: Math.max(0, REGISTRATION_RATE_LIMIT - entry.count),
    retryAfterSeconds: Math.ceil((entry.windowStart + REGISTRATION_RATE_WINDOW_MS - now) / 1000)
  };
}

/**
 * Ownership check for every UPLOAD path (socket 'upload-*' events and the
 * POST /api/documents|workflows|kanban/boards|taskwarrior/instances routes).
 *
 * The removal paths already refuse to act unless the payload's ownerId equals
 * the VERIFIED machine_id. Uploads must apply the same rule, otherwise any
 * registered client can broadcast a payload whose ownerId names another user
 * and either overwrite that user's synced item on every peer (receivers
 * accept content updates purely on ownerId match + newer cloudLastUpdated) or
 * delete it everywhere (by smuggling `_type: 'removal'` through the upload
 * path, which the receivers treat exactly like a server-generated removal).
 *
 * Rules:
 *   - `_type` is a server-generated queue marker. Clients never send it on an
 *     upload, so any payload carrying one is rejected outright; removals must
 *     go through the dedicated remove-* event / DELETE route, which enforce
 *     ownership and purge Yjs state.
 *   - `ownerId` must equal the authenticated machine_id. The client always
 *     sets ownerId to its own machine_id on first upload and only ever
 *     re-uploads items it owns, so legitimate traffic is unaffected.
 *
 * Returns null when the payload is acceptable, otherwise an error message.
 */
function checkUploadOwnership(payload, machineId) {
  if (!payload || typeof payload !== 'object') {
    return 'Invalid payload';
  }
  if (payload._type !== undefined) {
    return payload._type === 'removal'
      ? 'Permission denied: removals must use the remove endpoint (owner only)'
      : 'Invalid payload: unexpected _type field';
  }
  if (payload.ownerId !== machineId) {
    console.log(`[Auth] ❌ ${machineId} tried to upload an item owned by "${payload.ownerId}" - rejected`);
    return 'Permission denied: ownerId must match the authenticated machine_id';
  }
  return null;
}

loadClientRegistry();

module.exports = {
  DATA_DIR,
  CLIENTS_FILE,
  clientRegistry,
  loadClientRegistry,
  saveClientRegistry,
  hashSecret,
  verifyClientSecret,
  registerClient,
  retireClient,
  requireClientAuth,
  authenticateTicket,
  noteAccountIdentity,
  isAccountAuthEnabled,
  checkUploadOwnership,
  isEnrollmentGated,
  isPairingClosed,
  verifyEnrollmentSecret,
  checkRegistrationRateLimit,
  REGISTRATION_RATE_LIMIT,
  REGISTRATION_RATE_WINDOW_MS
};
