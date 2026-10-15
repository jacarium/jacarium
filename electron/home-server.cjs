// The desktop app linked to a home server (the browser deployment with
// accounts, e.g. https://pi.console): this profile's data then synchronises
// with the account there (src/sync/syncEngine.js), exactly as a browser
// signed in on that server does.
//
// How: Settings > General > Home server asks for the server URL, the
// username and the password ONCE. The main process signs in, asks the
// server for a device token (POST /api/auth/devices - a per-device secret
// shown once, revocable there), and keeps it in <userData>/home-server.json
// encrypted with Electron's safeStorage (the OS keychain). The password is
// never stored. Every later request goes through this process with
// `Authorization: Bearer <token>`: the renderer never holds the token, and
// a Node request carries no Sec-Fetch-* headers, so the server's cross-site
// guard is not involved and no CORS preflight happens.
//
// TLS: a certificate the OS trusts passes as it is; otherwise the server's
// own CA root (GET /api/tls/root.crt) is trusted on first use and pinned,
// and every later chain is verified against it (electron/tls-trust.cjs) -
// Caddy's `tls internal` renews its leaf and intermediate, the pin outlives
// both; a chain from another CA is refused until the user trusts it.
//
// Electron-free except for what the caller injects (safeStorage, paths):
// unit-tested with plain Node against the real backend over HTTP
// (tests/electron-home-server.test.mjs).

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { updateCertificatePin } = require('./central-cert-pins.cjs');
const { chainFromSocket, parseCertificates, fingerprintOf, decideTrust, verifyChain, pinRoot, pinEntry } = require('./tls-trust.cjs');

const CSRF_HEADER = { 'X-Requested-With': 'Jacarium' };
const STORE_FILE = 'home-server.json';

function normalizeUrl(raw) {
  const url = new URL(String(raw || '').trim());
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('The server URL must start with https:// (or http:// for a local test server)');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/** Encrypt/decrypt with safeStorage when available, else store as plain text (with a flag). */
function createCodec(safeStorage) {
  const usable = !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
  return {
    encrypted: usable,
    encode(text) {
      if (!usable) return { plain: text };
      return { encrypted: safeStorage.encryptString(text).toString('base64') };
    },
    decode(record) {
      if (!record) return null;
      if (record.encrypted) {
        if (!usable) throw new Error('The stored token is encrypted but the OS keychain is not available');
        return safeStorage.decryptString(Buffer.from(record.encrypted, 'base64'));
      }
      return record.plain || null;
    },
  };
}

/** Read / write the link record ({ url, username, deviceId, token: {encrypted|plain} }). */
function readLink(storePath) {
  try {
    const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function writeLink(storePath, record) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// TLS: the connection is handed to a request only once the server's
// certificate chain is trusted (electron/tls-trust.cjs). Node never calls
// checkServerIdentity for a chain it cannot validate itself, so with
// rejectUnauthorized: false the decision has to be made here, on the
// socket's 'secureConnect', before a single byte - the device token among
// them - is written. The agent's createConnection does exactly that.
// ---------------------------------------------------------------------------

/** GET /api/tls/root.crt over a connection that accepts exactly the leaf being decided about; '' on 404 or any failure. */
function fetchRootCertificate(url, leafFingerprint, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const agent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });
    agent.createConnection = (options, cb) => {
      const socket = tls.connect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, rejectUnauthorized: false });
      socket.once('secureConnect', () => {
        const chain = chainFromSocket(socket);
        let leaf = null;
        try { leaf = parseCertificates(chain[0])[0]; } catch { leaf = null; }
        if (leaf && fingerprintOf(leaf) === leafFingerprint) cb(null, socket);
        else { socket.destroy(); cb(new Error('the server presented another certificate while its root was being fetched')); }
      });
      socket.once('error', (e) => cb(e));
    };
    const req = https.request({ hostname: url.hostname, port: url.port || 443, path: '/api/tls/root.crt', method: 'GET', agent, timeout: timeoutMs, headers: CSRF_HEADER }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(res.statusCode === 200 && /-----BEGIN CERTIFICATE-----/.test(text) ? text : '');
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(''));
    req.end();
  });
}

/**
 * The agent for `url`: connects, decides (tls-trust.cjs decideTrust), pins
 * on first use (the served root when the chain verifies against it, the
 * leaf otherwise - then `rootUnavailable` is recorded for Settings),
 * upgrades a 3.1 leaf pin to the root while the leaf still matches, and
 * hands the socket over only when the chain is trusted. A mismatch destroys
 * the socket, calls onPinMismatch({ host, url, fingerprint, expected, kind,
 * reason, chain }) and fails the request.
 */
function trustedAgent(url, { pinsPath, onPinMismatch }) {
  const agent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });
  agent.createConnection = (options, cb) => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, rejectUnauthorized: false });
    let settled = false;
    const done = (err) => { if (settled) return; settled = true; if (err) { socket.destroy(); cb(err); } else cb(null, socket); };
    socket.once('error', (e) => done(e));
    socket.once('secureConnect', async () => {
      try {
        const chain = chainFromSocket(socket);
        let decision = decideTrust({ pinsPath, host: url.host, hostname: url.hostname, chainPems: chain, authorized: socket.authorized });
        if (decision.decision === 'unpinned' || decision.decision === 'upgrade-candidate') {
          // trusted on first use (or by the leaf pin that still matches): take the
          // server's root now, so renewals of its certificates pass from here on
          const rootPem = await fetchRootCertificate(url, decision.fingerprint);
          if (rootPem && verifyChain(chain, rootPem, url.hostname).ok) {
            pinRoot(pinsPath, url.host, rootPem);
            decision = { ...decision, decision: 'match', kind: 'root', upgraded: decision.decision === 'upgrade-candidate' };
          } else if (decision.decision === 'unpinned') {
            updateCertificatePin(pinsPath, url.host, decision.fingerprint, { rootUnavailable: !rootPem, rootRejected: !!rootPem });
            decision = { ...decision, decision: 'match', kind: 'leaf', rootUnavailable: !rootPem };
          } else {
            decision = { ...decision, decision: 'match', kind: 'leaf' };
          }
        }
        if (decision.decision === 'system' || decision.decision === 'match') return done(null);
        const result = { ...decision, url: url.origin, chain };
        if (onPinMismatch) { try { onPinMismatch(result); } catch { /* the warning is best effort */ } }
        done(new Error(`The certificate of ${url.host} is not the one recorded for this server${decision.reason ? ` (${decision.reason})` : ''}: ${decision.expected || 'no pin'} vs ${decision.fingerprint}`));
      } catch (error) {
        done(error);
      }
    });
  };
  return agent;
}

/**
 * The explicit "trust the new certificate" after a mismatch (the dialog in
 * electron/main.cjs): the root the server serves when the presented chain
 * verifies against it, the presented leaf otherwise.
 */
async function trustPresented({ pinsPath, host, url, chain, fingerprint }) {
  const target = new URL(url);
  const rootPem = await fetchRootCertificate(target, fingerprint);
  if (rootPem && verifyChain(chain, rootPem, target.hostname).ok) return { ...pinRoot(pinsPath, host, rootPem), type: 'root' };
  return { ...updateCertificatePin(pinsPath, host, fingerprint, { rootUnavailable: !rootPem, rootRejected: !!rootPem }), type: 'leaf' };
}

/**
 * One HTTP(S) request to the server. Resolves { status, headers, text }.
 * `pinsPath`: the certificate pin store (https only). Never follows redirects.
 */
function serverRequest(baseUrl, pathName, { method = 'GET', headers = {}, body, pinsPath, timeoutMs = 30000, onPinMismatch } = {}) {
  const url = new URL(pathName.startsWith('http') ? pathName : `${baseUrl}${pathName}`);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        ...CSRF_HEADER,
        ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
      ...(isHttps ? { agent: trustedAgent(url, { pinsPath, onPinMismatch }) } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Link this profile to a server: sign in with the password, mint a device
 * token, store it. Returns { url, username, user, deviceId }.
 */
async function linkHomeServer({ url, username, password, deviceName, storePath, pinsPath, safeStorage, onPinMismatch }) {
  const base = normalizeUrl(url);
  const codec = createCodec(safeStorage);
  const login = await serverRequest(base, '/api/auth/login', { method: 'POST', body: { username, password }, pinsPath, onPinMismatch });
  const loginBody = parse(login.text) || {};
  if (login.status === 404) throw new Error('This server has no sign-in (accounts are not enabled there)');
  if (login.status !== 200) throw new Error(loginBody.error || `Sign-in failed (HTTP ${login.status})`);
  const cookie = ((login.headers['set-cookie'] || [])[0] || '').split(';')[0];
  if (!cookie) throw new Error('The server did not return a session');
  const name = deviceName || `${os.hostname()} (${os.userInfo().username})`;
  const minted = await serverRequest(base, '/api/auth/devices', { method: 'POST', headers: { Cookie: cookie }, body: { name }, pinsPath, onPinMismatch });
  const mintedBody = parse(minted.text) || {};
  // the password-based session is not kept: end it
  serverRequest(base, '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie }, pinsPath }).catch(() => {});
  if (minted.status !== 201 || !mintedBody.token) throw new Error(mintedBody.error || `Could not link this device (HTTP ${minted.status})`);
  const record = {
    url: base,
    username: loginBody.user ? loginBody.user.username : username,
    userId: loginBody.user ? loginBody.user.id : null,
    displayName: loginBody.user ? (loginBody.user.displayName || '') : '',
    role: loginBody.user ? (loginBody.user.role || 'user') : 'user',
    deviceId: mintedBody.id,
    deviceName: name,
    linkedAt: new Date().toISOString(),
    token: codec.encode(mintedBody.token),
  };
  writeLink(storePath, record);
  return { url: base, username: record.username, user: loginBody.user || null, deviceId: record.deviceId, encrypted: codec.encrypted };
}

/** How the linked server's certificate is trusted: { pin: 'root'|'leaf'|null, rootUnavailable, subject }. */
function tlsPinStatus(url, pinsPath) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return { pin: null, rootUnavailable: false, subject: '' };
    const entry = pinEntry(pinsPath, u.host);
    if (!entry) return { pin: null, rootUnavailable: false, subject: '' };
    const raw = require('./central-cert-pins.cjs').readPins(pinsPath)[u.host.toLowerCase()] || {};
    return { pin: entry.type, rootUnavailable: !!raw.rootUnavailable, rootRejected: !!raw.rootRejected, subject: raw.subject || '' };
  } catch {
    return { pin: null, rootUnavailable: false, subject: '' };
  }
}

/** What Settings shows: { linked, url, username, userId, displayName, role, deviceName, linkedAt, encrypted, tls }. */
function homeServerStatus({ storePath, safeStorage, pinsPath }) {
  const record = readLink(storePath);
  if (!record || !record.url || !record.token) return { linked: false };
  const codec = createCodec(safeStorage);
  return { linked: true, url: record.url, username: record.username, userId: record.userId || null, displayName: record.displayName || '', role: record.role || 'user', deviceName: record.deviceName, linkedAt: record.linkedAt, encrypted: !!record.token.encrypted, keychain: codec.encrypted, tls: pinsPath ? tlsPinStatus(record.url, pinsPath) : undefined };
}

/** Forget the link (and revoke the token on the server when it can be reached). */
async function unlinkHomeServer({ storePath, pinsPath, safeStorage }) {
  const record = readLink(storePath);
  if (record && record.url && record.token && record.deviceId) {
    try {
      const token = createCodec(safeStorage).decode(record.token);
      await serverRequest(record.url, `/api/auth/devices/${encodeURIComponent(record.deviceId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, pinsPath, timeoutMs: 8000 });
    } catch {
      // the token stays revocable on the server from any signed-in browser
    }
  }
  try { fs.unlinkSync(storePath); } catch { /* already gone */ }
  return { linked: false };
}

/**
 * A request on behalf of the renderer (the sync engine): path + init as
 * fetch would take them; resolves { ok, status, text }. 401 means the
 * token was revoked or the account disabled - the link is kept so the
 * user sees it in Settings and can link again.
 *
 * /central/... is the central server the home server provides (its
 * /central/* is forwarded there): reached the same way - this process,
 * the pinned certificate - but WITHOUT the device token, which is the home
 * server's alone; the renderer sends the account ticket it got from
 * /api/auth/central-ticket in the headers it passes.
 */
async function homeServerFetch(pathName, init = {}, { storePath, pinsPath, safeStorage, onPinMismatch } = {}) {
  const record = readLink(storePath);
  if (!record || !record.url || !record.token) return { ok: false, status: 0, text: JSON.stringify({ error: 'Not linked to a home server' }) };
  const central = /^\/central\//.test(pathName);
  if (!central && !/^\/api\//.test(pathName)) return { ok: false, status: 0, text: JSON.stringify({ error: 'Only API paths may be requested' }) };
  const headers = { ...(init.headers || {}) };
  if (!central) headers.Authorization = `Bearer ${createCodec(safeStorage).decode(record.token)}`;
  const response = await serverRequest(record.url, pathName, {
    method: init.method || 'GET',
    headers,
    body: init.body,
    pinsPath,
    onPinMismatch,
  });
  // the account's role and name as the server reports them now (Settings
  // shows the administration only for an admin; a demotion takes effect at
  // the next /api/auth/me)
  if (pathName === '/api/auth/me' && response.status === 200) {
    const user = (parse(response.text) || {}).user;
    if (user && (user.role !== record.role || (user.displayName || '') !== (record.displayName || ''))) {
      writeLink(storePath, { ...record, role: user.role || 'user', displayName: user.displayName || '' });
    }
  }
  return { ok: response.status >= 200 && response.status < 300, status: response.status, text: response.text };
}

/**
 * The home server's version and protocol (GET /api/version, no token
 * needed). A server from before the endpoint answers 404 and is reported as
 * legacy: it speaks protocol 1 (the endpoint arrived with it) and an app
 * version before 3.0.0. `url` overrides the linked server (the link form).
 */
async function homeServerVersion({ url, storePath, pinsPath, onPinMismatch } = {}) {
  const base = url ? normalizeUrl(url) : (readLink(storePath) || {}).url;
  if (!base) return { reachable: false, linked: false, url: null, app: null, protocol: null, legacy: false, error: 'Not linked to a home server' };
  try {
    const response = await serverRequest(base, '/api/version', { pinsPath, onPinMismatch, timeoutMs: 8000 });
    if (response.status === 404) return { reachable: true, linked: true, url: base, app: null, protocol: 1, legacy: true, error: null };
    const body = parse(response.text);
    if (response.status !== 200 || !body || typeof body.app !== 'string') {
      return { reachable: true, linked: true, url: base, app: null, protocol: null, legacy: false, error: `Unexpected answer (HTTP ${response.status})` };
    }
    return { reachable: true, linked: true, url: base, app: body.app, protocol: Number(body.protocol) || 1, legacy: false, error: null, capabilities: body.capabilities || null };
  } catch (error) {
    return { reachable: false, linked: true, url: base, app: null, protocol: null, legacy: false, error: error.message };
  }
}

module.exports = {
  STORE_FILE,
  fetchRootCertificate,
  trustedAgent,
  trustPresented,
  tlsPinStatus,
  homeServerVersion,
  normalizeUrl,
  createCodec,
  readLink,
  serverRequest,
  linkHomeServer,
  unlinkHomeServer,
  homeServerStatus,
  homeServerFetch,
};
