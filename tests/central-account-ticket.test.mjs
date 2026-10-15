/**
 * Guards "a signed-in user of the home server needs no pairing at the
 * central server behind it" (backend/central_ticket.py + POST
 * /api/auth/central-ticket in backend/auth.py; jacarium-central/
 * account-tickets.js + client-registry.js requireClientAuth + the socket
 * 'authenticate' handler).
 *
 * The two servers share one 256-bit key (ACCOUNT_TICKET_KEY /
 * JACARIUM_CENTRAL_TICKET_KEY); the console mints a short-lived HMAC ticket
 * naming the account's identity (`<username>@account-<id>`), the client
 * presents it instead of an enrollment secret and a pairing secret.
 *
 * What this test proves against REAL spawned servers (synthetic data):
 *   1. the console reports the provided central server (/api/capabilities,
 *      /api/version: {provided, path, accountSignIn}); a ticket needs a
 *      session (401 without), names the identity, is audited;
 *   2. REST: X-Account-Ticket authenticates WITHOUT any registration -
 *      uploads, pending, removal as the account identity; the identity is
 *      recorded in clients.json with no secret hash, so no secret can ever
 *      stand in for it (401/403 ACCOUNT_IDENTITY);
 *   3. forged identity impossible: a ticket signed with another key, a
 *      tampered payload, an expired ticket, a ticket used to claim another
 *      machine_id -> refused with a code and nothing stored; the
 *      ownership rule still holds (ownerId must be the ticket's identity);
 *      repeated failures from one address -> 429;
 *   4. socket: authenticate with account_ticket -> authenticated as the
 *      account, display name from the ticket, the connected-users list
 *      names it; no ticket and no secret -> refused and disconnected; a
 *      secret-paired teammate (enrollment secret) works alongside;
 *   5. a central server without the key (development) refuses tickets with
 *      a clear message (REST 403 ACCOUNT_SIGN_IN_NOT_ACCEPTED, socket the
 *      same) and the console without a key answers 409 for a ticket;
 *   6. the deployed shape - the key and NO enrollment secret - closes pairing:
 *      POST /api/register answers 403 ACCOUNT_SIGN_IN_ONLY, a client secret
 *      authenticates nothing, the ticket is the only way in, and the startup
 *      log says so.
 *
 * Needs: backend venv; cd jacarium-central && npm ci; npm install
 * (socket.io-client). Run: node tests/central-account-ticket.test.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SERVER_DIR = path.join(REPO, 'jacarium-central');
const req = createRequire(path.join(REPO, 'package.json'));
const PYTHON = fs.existsSync(path.join(REPO, 'backend', 'venv', 'bin', 'python')) ? path.join(REPO, 'backend', 'venv', 'bin', 'python') : 'python3';
if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) { console.log('SKIP: jacarium-central/node_modules missing (cd jacarium-central && npm ci)'); process.exit(0); }
const { io: ioClient } = req('socket.io-client');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 260) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

const KEY = crypto.randomBytes(32).toString('hex');
const OTHER_KEY = crypto.randomBytes(32).toString('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'account-ticket-'));
const S_DATA = path.join(TMP, 'home'); const C_DATA = path.join(TMP, 'central'); const C2_DATA = path.join(TMP, 'central-nokey'); const S2_DATA = path.join(TMP, 'home-nokey'); const C3_DATA = path.join(TMP, 'central-keyonly');
for (const d of [S_DATA, C_DATA, C2_DATA, S2_DATA, C3_DATA]) fs.mkdirSync(d, { recursive: true });
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_') && k !== 'ACCOUNT_TICKET_KEY' && k !== 'ENROLLMENT_SECRET'));
const logs = { S: '', C: '', C2: '', S2: '', C3: '' };
const S_PORT = await freePort(); const C_PORT = await freePort(); const C2_PORT = await freePort(); const S2_PORT = await freePort(); const C3_PORT = await freePort();
const backendEnv = (home, port, extra) => ({ ...baseEnv, HOME: home, PORT: String(port), JACARIUM_AUTH_MODE: 'accounts', JACARIUM_REPORTS_ROOT: path.join(home, 'reports'), JACARIUM_KNOWN_HOSTS: path.join(home, '.ssh', 'known_hosts'), ...extra });
const S = spawn(PYTHON, ['app.py'], { cwd: path.join(REPO, 'backend'), env: backendEnv(S_DATA, S_PORT, { JACARIUM_CENTRAL_PATH: '/central', JACARIUM_CENTRAL_TICKET_KEY: KEY }), stdio: ['ignore', 'pipe', 'pipe'] });
const S2 = spawn(PYTHON, ['app.py'], { cwd: path.join(REPO, 'backend'), env: backendEnv(S2_DATA, S2_PORT, { JACARIUM_CENTRAL_PATH: '/central' }), stdio: ['ignore', 'pipe', 'pipe'] });
const C = spawn('node', ['server.js'], { cwd: SERVER_DIR, env: { ...baseEnv, PORT: String(C_PORT), DATA_DIR: C_DATA, ENROLLMENT_SECRET: 'team-secret', ACCOUNT_TICKET_KEY: KEY, TRUST_PROXY: '1', TICKET_FAILURE_LIMIT: '9' }, stdio: ['ignore', 'pipe', 'pipe'] });
const C2 = spawn('node', ['server.js'], { cwd: SERVER_DIR, env: { ...baseEnv, PORT: String(C2_PORT), DATA_DIR: C2_DATA }, stdio: ['ignore', 'pipe', 'pipe'] });
// the deployed shape: the key, no enrollment secret
const C3 = spawn('node', ['server.js'], { cwd: SERVER_DIR, env: { ...baseEnv, PORT: String(C3_PORT), DATA_DIR: C3_DATA, ACCOUNT_TICKET_KEY: KEY, TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
for (const [tag, child] of [['S', S], ['C', C], ['C2', C2], ['S2', S2], ['C3', C3]]) { child.stdout.on('data', (d) => { logs[tag] += d; }); child.stderr.on('data', (d) => { logs[tag] += d; }); }
const S_URL = `http://127.0.0.1:${S_PORT}`; const C_URL = `http://127.0.0.1:${C_PORT}`; const C2_URL = `http://127.0.0.1:${C2_PORT}`; const S2_URL = `http://127.0.0.1:${S2_PORT}`; const C3_URL = `http://127.0.0.1:${C3_PORT}`;
async function waitUp(url) { for (let i = 0; i < 300; i++) { try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ } await sleep(200); } return false; }
const stopAll = () => { for (const c of [S, S2, C, C2, C3]) { try { c.kill('SIGTERM'); } catch { /* gone */ } } fs.rmSync(TMP, { recursive: true, force: true }); };
if (!(await waitUp(`${S_URL}/health`)) || !(await waitUp(`${S2_URL}/health`)) || !(await waitUp(`${C_URL}/api/health`)) || !(await waitUp(`${C2_URL}/api/health`)) || !(await waitUp(`${C3_URL}/api/health`))) {
  console.log('FAIL: a server did not start\n' + logs.S.slice(-800) + logs.C.slice(-800) + logs.C2.slice(-800) + logs.S2.slice(-800)); stopAll(); process.exit(1);
}

const CSRF = { 'X-Requested-With': 'Jacarium', 'Content-Type': 'application/json' };
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A ticket the way the console mints it (to forge variants of it). */
function mintLike({ key = KEY, sub = 'u', u = 'alice', n = 'Alice Example', mid, iat = Math.floor(Date.now() / 1000), exp = Math.floor(Date.now() / 1000) + 600, iss = 'jacarium-home' }) {
  const body = b64url(JSON.stringify({ exp, iat, iss, mid, n, sub, u }));
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(`v1.${body}`).digest();
  return `v1.${body}.${b64url(sig)}`;
}
const registryOnCentral = () => { try { return JSON.parse(fs.readFileSync(path.join(C_DATA, 'clients.json'), 'utf8')); } catch { return {}; } };
async function socketAuth(url, payload, { timeout = 4000 } = {}) {
  const socket = ioClient(url, { transports: ['websocket'], reconnection: false });
  const events = [];
  socket.on('connected-users', (p) => events.push(p));
  const answer = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), timeout);
    socket.on('connect', () => socket.emit('authenticate', payload));
    socket.on('authenticated', (a) => { clearTimeout(t); resolve(a); });
    socket.on('connect_error', (e) => { clearTimeout(t); resolve({ error: e.message }); });
  });
  return { socket, answer, events, disconnected: () => socket.disconnected };
}

try {
  // ---- 1. the console side ----
  const setupCode = fs.readFileSync(path.join(S_DATA, 'setup-code'), 'utf8').trim();
  let r = await fetch(`${S_URL}/api/auth/setup`, { method: 'POST', headers: CSRF, body: JSON.stringify({ setupCode, username: 'alice', password: 'alices password', displayName: 'Alice Example' }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const me = (await json(r))?.user;
  check('1. the administrator account exists', r.status === 201 && !!cookie && me?.username === 'alice', String(r.status));
  const ACCOUNT_ID = `alice@account-${String(me.id).replace(/[^0-9a-zA-Z]/g, '').slice(0, 12).toLowerCase()}`;
  const caps = await json(await fetch(`${S_URL}/api/capabilities`, { headers: { ...CSRF, Cookie: cookie } }));
  check('1. /api/capabilities announces the provided central server with account sign-in', caps?.capabilities?.central?.provided === true && caps.capabilities.central.path === '/central' && caps.capabilities.central.accountSignIn === true, JSON.stringify(caps?.capabilities?.central));
  const version = await json(await fetch(`${S_URL}/api/version`));
  check('1. /api/version (no session) says the same and speaks protocol 2', version?.capabilities?.central?.provided === true && version.protocol === 2, JSON.stringify({ p: version?.protocol, c: version?.capabilities?.central }));
  r = await fetch(`${S_URL}/api/auth/central-ticket`, { method: 'POST', headers: CSRF, body: '{}' });
  check('1. a ticket needs a session (401 without)', r.status === 401);
  r = await fetch(`${S_URL}/api/auth/central-ticket`, { method: 'POST', headers: { ...CSRF, Cookie: cookie }, body: '{}' });
  const minted = await json(r);
  check('1. a signed-in user gets a ticket naming the account identity, with its expiry and the central path', r.status === 200 && /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(minted?.ticket || '') && minted.identity === ACCOUNT_ID && minted.expiresAt > Date.now() / 1000 + 300 && minted.centralPath === '/central', JSON.stringify({ ...minted, ticket: minted?.ticket?.slice(0, 12) }));
  const TICKET = minted.ticket;
  const payload = JSON.parse(Buffer.from(TICKET.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  check('1. the ticket payload carries issuer, user, display name and identity; the signature is the shared-key HMAC the central server expects', payload.iss === 'jacarium-home' && payload.u === 'alice' && payload.n === 'Alice Example' && payload.mid === ACCOUNT_ID && mintLike({ ...payload }) === TICKET, JSON.stringify(payload));
  const audit = fs.readFileSync(path.join(S_DATA, 'accounts-audit.log'), 'utf8');
  check('1. issuing the ticket is audited (user, identity, session) - and never the ticket itself', /central-ticket user=alice identity=alice@account-\S+ ip=\S+ device=session/.test(audit) && !audit.includes(TICKET), audit.split('\n').filter((l) => /central/.test(l)).join(' / '));
  r = await fetch(`${S_URL}/api/auth/central-ticket`, { method: 'POST', headers: { ...CSRF, Cookie: cookie }, body: '{}' });
  check('1. a second ticket is not audited again within the hour', r.status === 200 && (fs.readFileSync(path.join(S_DATA, 'accounts-audit.log'), 'utf8').match(/central-ticket user=alice/g) || []).length === 1);

  // ---- 2. REST at the central server, by ticket, no registration ----
  check('2. the central server reports account sign-in accepted', (await json(await fetch(`${C_URL}/api/health`)))?.account_sign_in === true);
  check('2. nothing is registered yet', Object.keys(registryOnCentral()).length === 0);
  const doc = { title: 'Runbook by ticket', content: 'from the account', ownerId: ACCOUNT_ID, category: 'General', cloudLastUpdated: Date.now() };
  r = await fetch(`${C_URL}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Account-Ticket': TICKET }, body: JSON.stringify({ machine_id: ACCOUNT_ID, document: doc }) });
  check('2. an upload with the ticket succeeds without any /api/register', r.status === 200 && (await json(r))?.success !== false, `${r.status}`);
  const entry = registryOnCentral()[ACCOUNT_ID];
  check('2. the identity is recorded as an account identity, with NO secret hash', entry && entry.account?.username === 'alice' && !entry.secretHash, JSON.stringify(entry));
  r = await fetch(`${C_URL}/api/pending?machine_id=${encodeURIComponent(ACCOUNT_ID)}`, { headers: { 'X-Account-Ticket': TICKET } });
  check('2. GET /api/pending works by ticket', r.status === 200, `${r.status} ${(await r.text()).slice(0, 80)}`);
  r = await fetch(`${C_URL}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Account-Ticket': TICKET }, body: JSON.stringify({ document: doc }) });
  check('2. machine_id may be left out: the ticket names the identity', r.status === 200, `${r.status}`);
  r = await fetch(`${C_URL}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Enrollment-Secret': 'team-secret' }, body: JSON.stringify({ machine_id: ACCOUNT_ID }) });
  const regBody = await json(r);
  check('2. the account identity cannot be re-keyed through /api/register (it is known, no secret matches)', r.status === 403 && regBody?.code === 'MACHINE_ID_ALREADY_REGISTERED', `${r.status} ${JSON.stringify(regBody)}`);
  r = await fetch(`${C_URL}/api/pending?machine_id=${encodeURIComponent(ACCOUNT_ID)}`, { headers: { 'X-Client-Secret': 'a'.repeat(64) } });
  check('2. a client secret can never stand in for an account identity (403 ACCOUNT_IDENTITY)', r.status === 403 && (await json(r))?.code === 'ACCOUNT_IDENTITY', `${r.status}`);
  check('2. ...and still no secret hash was stored', !registryOnCentral()[ACCOUNT_ID]?.secretHash);
  r = await fetch(`${C_URL}/api/documents/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent(doc.title)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Account-Ticket': TICKET }, body: JSON.stringify({ machine_id: ACCOUNT_ID }) });
  check('2. the owner removes its document by ticket', r.status === 200, `${r.status} ${(await r.text()).slice(0, 80)}`);

  // ---- 3. forged identities ----
  const forged = [
    ['another key', mintLike({ key: OTHER_KEY, mid: ACCOUNT_ID }), 401, 'ACCOUNT_TICKET_INVALID'],
    ['tampered payload (another identity under the real signature)', TICKET.replace(/^(v1\.)([^.]+)(\..*)$/, (m, a, body, c) => a + b64url(JSON.stringify({ ...payload, mid: 'mallory@account-000000000000', u: 'mallory' })) + c), 401, 'ACCOUNT_TICKET_INVALID'],
    ['expired', mintLike({ mid: ACCOUNT_ID, iat: Math.floor(Date.now() / 1000) - 1200, exp: Math.floor(Date.now() / 1000) - 600 }), 401, 'ACCOUNT_TICKET_EXPIRED'],
    ['a lifetime longer than the console ever issues', mintLike({ mid: ACCOUNT_ID, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 }), 401, 'ACCOUNT_TICKET_INVALID'],
    ['an identity that is not an account identity', mintLike({ mid: 'robbo@laptop', u: 'robbo' }), 401, 'ACCOUNT_TICKET_INVALID'],
    ['garbage', 'v1.not.a.ticket', 401, 'ACCOUNT_TICKET_INVALID'],
  ];
  for (const [label, ticket, status, code] of forged) {
    r = await fetch(`${C_URL}/api/pending?machine_id=${encodeURIComponent(ACCOUNT_ID)}`, { headers: { 'X-Account-Ticket': ticket } });
    const body = await json(r);
    check(`3. ${label} -> ${status} ${code}`, r.status === status && body?.code === code, `${r.status} ${JSON.stringify(body)}`);
  }
  check('3. no forged identity reached the registry', Object.keys(registryOnCentral()).join(',') === ACCOUNT_ID, Object.keys(registryOnCentral()).join(','));
  r = await fetch(`${C_URL}/api/pending?machine_id=${encodeURIComponent('bob@account-000000000000')}`, { headers: { 'X-Account-Ticket': TICKET } });
  check('3. a valid ticket cannot claim another machine_id (403 IDENTITY_MISMATCH)', r.status === 403 && (await json(r))?.code === 'IDENTITY_MISMATCH');
  r = await fetch(`${C_URL}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Account-Ticket': TICKET }, body: JSON.stringify({ document: { ...doc, title: 'Forged', ownerId: 'bob@account-000000000000' } }) });
  check('3. the ownership rule holds: an upload naming another owner is refused (403)', r.status === 403 && /ownerId/.test((await json(r))?.error || ''));
  // six forged + one mismatch so far; two more reach the limit of 9 in this run -> 429 even for a VALID ticket from that address
  for (let i = 0; i < 2; i++) await fetch(`${C_URL}/api/pending?machine_id=x`, { headers: { 'X-Account-Ticket': 'v1.bad.bad' } });
  r = await fetch(`${C_URL}/api/pending?machine_id=${encodeURIComponent(ACCOUNT_ID)}`, { headers: { 'X-Account-Ticket': TICKET } });
  check('3. repeated failed tickets from one address are rate limited (429), a valid ticket included', r.status === 429 && (await json(r))?.code === 'ACCOUNT_TICKET_RATE_LIMITED', `${r.status}`);
  check('3. the failures are logged with the address', /Account ticket rejected from 127\.0\.0\.1: ACCOUNT_TICKET_INVALID/.test(logs.C));

  // ---- 4. the socket (a fresh central server state is not needed: the limiter is per address and only REST was hit;
  //         the socket path shares it, so wait for nothing: the limit above was reached on purpose - start the socket
  //         checks on the standalone-free second port by restarting the limiter window? No: use the forwarded address.)
  // TRUST_PROXY=1: the address comes from X-Forwarded-For on REST; a socket handshake carries no such header here,
  // so its address is the loopback one that is now rate limited - prove that first, then continue with a header.
  let s = await socketAuth(C_URL, { machine_id: ACCOUNT_ID, account_ticket: TICKET, display_name: 'Alice Example' });
  check('4. the socket shares the per-address limit (refused with the rate-limit code, then disconnected)', s.answer?.success === false && s.answer?.code === 'ACCOUNT_TICKET_RATE_LIMITED', JSON.stringify(s.answer));
  await sleep(200); s.socket.disconnect();
  // a teammate paired with the enrollment secret (another address through the forwarded header)
  r = await fetch(`${C_URL}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Enrollment-Secret': 'team-secret', 'X-Forwarded-For': '198.51.100.7' }, body: JSON.stringify({ machine_id: 'teammate@desk' }) });
  const teammate = await json(r);
  check('4. a teammate still pairs with the enrollment secret (the forwarded address counts as the client)', r.status === 200 && !!teammate?.secret && /Registration attempt from 198\.51\.100\.7/.test(logs.C), `${r.status}`);
  const observer = ioClient(C_URL, { transports: ['websocket'], reconnection: false, extraHeaders: { 'X-Forwarded-For': '198.51.100.7' } });
  const presence = [];
  observer.on('connected-users', (p) => presence.push(p));
  const obsAnswer = await new Promise((resolve) => { observer.on('connect', () => observer.emit('authenticate', { machine_id: 'teammate@desk', client_secret: teammate.secret, display_name: 'Teammate' })); observer.on('authenticated', resolve); setTimeout(() => resolve({ timeout: true }), 4000); });
  check('4. the secret-paired teammate authenticates alongside', obsAnswer?.success === true, JSON.stringify(obsAnswer));
  const account = ioClient(C_URL, { transports: ['websocket'], reconnection: false, extraHeaders: { 'X-Forwarded-For': '203.0.113.9' } });
  const accAnswer = await new Promise((resolve) => { account.on('connect', () => account.emit('authenticate', { machine_id: ACCOUNT_ID, account_ticket: TICKET })); account.on('authenticated', resolve); setTimeout(() => resolve({ timeout: true }), 4000); });
  check('4. the account authenticates over the socket with its ticket (no secret, no display_name needed)', accAnswer?.success === true && accAnswer.machine_id === ACCOUNT_ID, JSON.stringify(accAnswer));
  await sleep(300);
  const last = presence[presence.length - 1] || {};
  check('4. the connected-users list names the account with the display name from the ticket', (last.users || []).includes(ACCOUNT_ID) && last.names?.[ACCOUNT_ID] === 'Alice Example', JSON.stringify(last));
  account.disconnect();
  s = await socketAuth(C_URL, { machine_id: ACCOUNT_ID });
  // (this address is rate limited; the refusal must still be a clean answer, not a hang)
  check('4. no ticket and no secret -> refused and disconnected, with a code', s.answer?.success === false && typeof s.answer?.code === 'string', JSON.stringify(s.answer));
  await sleep(200); check('4. ...the socket is closed by the server', s.disconnected());
  const bad = ioClient(C_URL, { transports: ['websocket'], reconnection: false, extraHeaders: { 'X-Forwarded-For': '203.0.113.10' } });
  const badAnswer = await new Promise((resolve) => { bad.on('connect', () => bad.emit('authenticate', { machine_id: ACCOUNT_ID, account_ticket: mintLike({ key: OTHER_KEY, mid: ACCOUNT_ID }) })); bad.on('authenticated', resolve); setTimeout(() => resolve({ timeout: true }), 4000); });
  check('4. a forged ticket over the socket is refused with its code', badAnswer?.success === false && badAnswer.code === 'ACCOUNT_TICKET_INVALID', JSON.stringify(badAnswer));
  await sleep(100);
  check('4. ...logged with the forwarded client address, not the proxy\'s (TRUST_PROXY applies to the socket too)', /Account ticket rejected from 203\.0\.113\.10: ACCOUNT_TICKET_INVALID/.test(logs.C), logs.C.split('\n').filter((l) => /rejected from/.test(l)).slice(-2).join(' / '));
  observer.disconnect();

  // ---- 5. no key anywhere (a development server) ----
  check('5. a central server without the key reports account sign-in not accepted', (await json(await fetch(`${C2_URL}/api/health`)))?.account_sign_in === false && /Account sign-in: not accepted/.test(logs.C2));
  r = await fetch(`${C2_URL}/api/pending?machine_id=${encodeURIComponent(ACCOUNT_ID)}`, { headers: { 'X-Account-Ticket': TICKET } });
  check('5. ...a ticket is refused there with a message that names the missing key', r.status === 403 && /ticket key/.test((await json(r))?.error || ''));
  const sa = ioClient(C2_URL, { transports: ['websocket'], reconnection: false });
  const saAnswer = await new Promise((resolve) => { sa.on('connect', () => sa.emit('authenticate', { machine_id: ACCOUNT_ID, account_ticket: TICKET })); sa.on('authenticated', resolve); setTimeout(() => resolve({ timeout: true }), 4000); });
  check('5. ...and over the socket too', saAnswer?.success === false && saAnswer.code === 'ACCOUNT_SIGN_IN_NOT_ACCEPTED' && /ticket key/.test(saAnswer.error || ''), JSON.stringify(saAnswer));
  const setupCode2 = fs.readFileSync(path.join(S2_DATA, 'setup-code'), 'utf8').trim();
  r = await fetch(`${S2_URL}/api/auth/setup`, { method: 'POST', headers: CSRF, body: JSON.stringify({ setupCode: setupCode2, username: 'carol', password: 'carols password', displayName: 'Carol' }) });
  const cookie2 = (r.headers.get('set-cookie') || '').split(';')[0];
  const caps2 = await json(await fetch(`${S2_URL}/api/capabilities`, { headers: { ...CSRF, Cookie: cookie2 } }));
  r = await fetch(`${S2_URL}/api/auth/central-ticket`, { method: 'POST', headers: { ...CSRF, Cookie: cookie2 }, body: '{}' });
  check('5. a console with a provided central server but no key says so (capabilities accountSignIn false, ticket 409)', caps2?.capabilities?.central?.provided === true && caps2.capabilities.central.accountSignIn === false && r.status === 409 && (await json(r))?.code === 'ACCOUNT_SIGN_IN_NOT_ACCEPTED', `${r.status} ${JSON.stringify(caps2?.capabilities?.central)}`);

  // ---- 6. the deployed shape: the key and no enrollment secret -> pairing closed ----
  check('6. the key-only server says pairing is closed at startup', /Pairing: closed \(account sign-in only\)/.test(logs.C3) && /Account sign-in: accepted/.test(logs.C3), logs.C3.split('\n').filter((l) => /Pairing|Account sign-in/.test(l)).join(' / '));
  r = await fetch(`${C3_URL}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machine_id: 'stranger@laptop' }) });
  check('6. POST /api/register is refused (403 ACCOUNT_SIGN_IN_ONLY) and records nothing', r.status === 403 && (await json(r))?.code === 'ACCOUNT_SIGN_IN_ONLY' && !fs.existsSync(path.join(C3_DATA, 'clients.json')), `${r.status}`);
  r = await fetch(`${C3_URL}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Enrollment-Secret': 'anything' }, body: JSON.stringify({ machine_id: 'stranger@laptop' }) });
  check('6. ...an enrollment secret does not open it either', r.status === 403 && (await json(r))?.code === 'ACCOUNT_SIGN_IN_ONLY');
  r = await fetch(`${C3_URL}/api/pending?machine_id=stranger@laptop`, { headers: { 'X-Client-Secret': 'a'.repeat(64) } });
  check('6. a client secret authenticates nothing there (401)', r.status === 401, `${r.status}`);
  const ticket6 = (await json(await fetch(`${S_URL}/api/auth/central-ticket`, { method: 'POST', headers: { ...CSRF, Cookie: cookie }, body: '{}' })))?.ticket;
  r = await fetch(`${C3_URL}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Account-Ticket': ticket6 }, body: JSON.stringify({ document: { ...doc, title: 'By ticket on the key-only server' } }) });
  check('6. the account ticket is the way in (200)', r.status === 200 && !!JSON.parse(fs.readFileSync(path.join(C3_DATA, 'clients.json'), 'utf8'))[ACCOUNT_ID]?.account, `${r.status}`);
} catch (error) {
  check('the scenario ran to the end', false, error.stack || error.message);
  console.log(logs.S.slice(-1200)); console.log(logs.C.slice(-1200));
} finally {
  stopAll();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
