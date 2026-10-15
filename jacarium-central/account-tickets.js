/**
 * Account tickets - a signed-in user of the home server (the console with
 * accounts, deploy/Containerfile) is recognised here WITHOUT the enrollment
 * secret or the per-machine pairing secret.
 *
 * How: the console and this server share one random 256-bit key, generated
 * at deploy time on the host (deploy/remote-host.sh: <central state>/keys/
 * account-ticket.key, 0600) and handed to both containers through their
 * environment files (ACCOUNT_TICKET_KEY here, JACARIUM_CENTRAL_TICKET_KEY
 * there). The console mints a short-lived ticket for a signed-in user
 * (POST /api/auth/central-ticket: session cookie in a browser, device token
 * on a linked desktop) and the client presents it to this server - in the
 * X-Account-Ticket header on REST calls, as `account_ticket` in the socket's
 * 'authenticate' payload. The ticket names the account's identity on this
 * server (`<username>@account-<id>`, the same formula the clients and the
 * console use), so a ticket can only ever authenticate as that identity.
 *
 * Why a shared key and not a call back to the console: nothing has to be
 * reachable for the check (no internal route that could be exposed), the
 * verification is a constant-time HMAC compare, and a ticket forged without
 * the key is impossible; the key never leaves the host. A server without
 * the key (development, tests) accepts no tickets and says so.
 *
 * Format: v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(key, "v1." + payload))>
 * payload: { iss: 'jacarium-home', sub: <user id>, u: <username>,
 *            n: <display name>, mid: <machine_id>, iat, exp }  (seconds)
 * backend/central_ticket.py mints exactly this.
 */
const crypto = require('crypto');

const ACCOUNT_TICKET_KEY = (process.env.ACCOUNT_TICKET_KEY || '').trim();
const KEY_OK = /^[0-9a-fA-F]{64}$/.test(ACCOUNT_TICKET_KEY);
const KEY = KEY_OK ? Buffer.from(ACCOUNT_TICKET_KEY, 'hex') : null;
const ISSUER = 'jacarium-home';
const MAX_LIFETIME_SECONDS = 60 * 60;   // a ticket the console minted for longer is refused
const CLOCK_SKEW_SECONDS = 60;
const ACCOUNT_MACHINE_ID_RE = /^[A-Za-z0-9._-]{1,64}@account-[0-9a-z]{1,12}$/;

function isAccountAuthEnabled() {
  return KEY_OK;
}

function b64urlDecode(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(text).length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Verify a ticket. Returns { ok: true, identity: { machineId, userId,
 * username, displayName, expiresAt } } or { ok: false, error, code }.
 * Never throws.
 */
function verifyAccountTicket(ticket, nowSeconds = Date.now() / 1000) {
  if (!KEY_OK) {
    return { ok: false, code: 'ACCOUNT_SIGN_IN_NOT_ACCEPTED', error: 'This central server does not accept account sign-in (it has no ticket key): a development server, or a deployment missing its key.' };
  }
  if (typeof ticket !== 'string' || ticket.length > 4096) {
    return { ok: false, code: 'ACCOUNT_TICKET_INVALID', error: 'Malformed account ticket' };
  }
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) {
    return { ok: false, code: 'ACCOUNT_TICKET_INVALID', error: 'Malformed account ticket' };
  }
  const expected = crypto.createHmac('sha256', KEY).update(`v1.${parts[1]}`).digest();
  const given = b64urlDecode(parts[2]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, code: 'ACCOUNT_TICKET_INVALID', error: 'The account ticket was not issued by this server\'s home server' };
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch {
    return { ok: false, code: 'ACCOUNT_TICKET_INVALID', error: 'Malformed account ticket' };
  }
  if (!payload || typeof payload !== 'object' || payload.iss !== ISSUER) {
    return { ok: false, code: 'ACCOUNT_TICKET_INVALID', error: 'Malformed account ticket' };
  }
  const iat = Number(payload.iat);
  const exp = Number(payload.exp);
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp - iat > MAX_LIFETIME_SECONDS || iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    return { ok: false, code: 'ACCOUNT_TICKET_INVALID', error: 'Malformed account ticket' };
  }
  if (exp <= nowSeconds) {
    return { ok: false, code: 'ACCOUNT_TICKET_EXPIRED', error: 'The account ticket has expired; the app asks the home server for a new one' };
  }
  const machineId = typeof payload.mid === 'string' ? payload.mid : '';
  const username = typeof payload.u === 'string' ? payload.u : '';
  if (!ACCOUNT_MACHINE_ID_RE.test(machineId) || !username || !machineId.startsWith(`${username}@account-`)) {
    return { ok: false, code: 'ACCOUNT_TICKET_INVALID', error: 'Malformed account ticket' };
  }
  return {
    ok: true,
    identity: {
      machineId,
      userId: String(payload.sub == null ? '' : payload.sub),
      username,
      displayName: typeof payload.n === 'string' ? payload.n : '',
      expiresAt: exp,
    },
  };
}

// Failed ticket checks per address: a stream of forged tickets becomes 429s
// (REST) or a disconnect (socket) instead of a free oracle.
const TICKET_FAILURE_LIMIT = Number(process.env.TICKET_FAILURE_LIMIT) || 20;
const TICKET_FAILURE_WINDOW_MS = Number(process.env.TICKET_FAILURE_WINDOW_MS) || 15 * 60 * 1000;
const ticketFailures = new Map(); // ip -> { count, windowStart }

function ticketFailuresExceeded(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  const entry = ticketFailures.get(key);
  if (!entry || now - entry.windowStart >= TICKET_FAILURE_WINDOW_MS) return false;
  return entry.count >= TICKET_FAILURE_LIMIT;
}

function recordTicketFailure(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  let entry = ticketFailures.get(key);
  if (!entry || now - entry.windowStart >= TICKET_FAILURE_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    ticketFailures.set(key, entry);
  }
  entry.count += 1;
  if (ticketFailures.size > 10000) {
    for (const [k, v] of ticketFailures) {
      if (now - v.windowStart >= TICKET_FAILURE_WINDOW_MS) ticketFailures.delete(k);
    }
  }
  return Math.ceil((entry.windowStart + TICKET_FAILURE_WINDOW_MS - now) / 1000);
}

module.exports = {
  isAccountAuthEnabled,
  verifyAccountTicket,
  ticketFailuresExceeded,
  recordTicketFailure,
  ACCOUNT_MACHINE_ID_RE,
};
