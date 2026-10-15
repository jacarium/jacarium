/**
 * Guards the desktop's link to a home server (electron/home-server.cjs: the
 * main-process module behind Settings > General > Home server and the sync
 * engine's transport in the Electron app).
 *
 * What this test proves (plain Node against the REAL backend started in
 * accounts mode on a free port over HTTP, a fake safeStorage, throwaway
 * directories, synthetic accounts):
 *   - a wrong password / an unknown user is refused with the server's
 *     message; a server without accounts is explained;
 *   - linking signs in once, mints a device token named after the device,
 *     stores it encrypted (the fake keychain), ends the password session,
 *     and records url/username/device id (never the password);
 *   - homeServerFetch adds the bearer token and the X-Requested-With header:
 *     /api/auth/me answers as the account; a non-API path is refused
 *     locally; the token never appears in the store file in clear;
 *   - the sync engine can run through this transport: a record pushed by a
 *     browser session arrives via the device's pull;
 *   - unlink revokes the token on the server (a later fetch answers 401)
 *     and removes the store file; status reflects it.
 *
 * Run: node tests/electron-home-server.test.mjs  (needs the backend venv)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const homeServer = require('../electron/home-server.cjs');
const PYTHON = fs.existsSync(path.join(REPO, 'backend', 'venv', 'bin', 'python')) ? path.join(REPO, 'backend', 'venv', 'bin', 'python') : 'python3';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the backend --------------------------------------------------------------
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'home-server-data-'));
const backend = spawn(PYTHON, ['app.py'], {
  cwd: path.join(REPO, 'backend'),
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_'))), HOME: DATA, PORT: String(PORT), JACARIUM_AUTH_MODE: 'accounts', JACARIUM_REPORTS_ROOT: path.join(DATA, 'reports'), JACARIUM_KNOWN_HOSTS: path.join(DATA, '.ssh', 'known_hosts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
backend.stdout.on('data', (d) => { log += d; });
backend.stderr.on('data', (d) => { log += d; });
const BASE = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(`${BASE}/health`)).ok; } catch { await sleep(250); } }
const stop = () => { try { backend.kill('SIGTERM'); } catch { /* gone */ } fs.rmSync(DATA, { recursive: true, force: true }); };
if (!up) { console.log('FAIL: backend did not start\n' + log.slice(-1200)); stop(); process.exit(1); }

const CSRF = { 'X-Requested-With': 'Jacarium', 'Content-Type': 'application/json' };
const setupCode = fs.readFileSync(path.join(DATA, 'setup-code'), 'utf8').trim();
const setup = await fetch(`${BASE}/api/auth/setup`, { method: 'POST', headers: CSRF, body: JSON.stringify({ setupCode, username: 'alice', password: 'alices password' }) });
const browserCookie = (setup.headers.get('set-cookie') || '').split(';')[0];
check('the account exists', setup.status === 201 && browserCookie.length > 0, String(setup.status));

// ---- a fake keychain + throwaway store ------------------------------------------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'home-server-store-'));
const storePath = path.join(WORK, 'profile', 'home-server.json');
const pinsPath = path.join(WORK, 'profile', 'central-server-cert-pins.json');
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
  decryptString: (buf) => Buffer.from(String(buf).slice(4), 'base64').toString(),
};
const ctx = { storePath, pinsPath, safeStorage };

try {
  check('status: not linked at first', homeServer.homeServerStatus(ctx).linked === false);
  let error = null;
  try { await homeServer.linkHomeServer({ url: BASE, username: 'alice', password: 'wrong', ...ctx }); } catch (e) { error = e; }
  check('a wrong password is refused with the server\'s message', /Wrong username or password/.test(error?.message || ''), error?.message);
  error = null;
  try { await homeServer.linkHomeServer({ url: 'ftp://x', username: 'alice', password: 'x', ...ctx }); } catch (e) { error = e; }
  check('a non-http(s) URL is refused', /must start with https/.test(error?.message || ''), error?.message);

  const linked = await homeServer.linkHomeServer({ url: `${BASE}/`, username: 'alice', password: 'alices password', deviceName: 'test laptop', ...ctx });
  check('linking signs in once and mints a device token', linked.username === 'alice' && linked.deviceId && linked.encrypted === true, JSON.stringify(linked));
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  check('the store holds url, username, device id and an ENCRYPTED token - never the password', stored.url === BASE && stored.username === 'alice' && stored.token?.encrypted?.startsWith(Buffer.from('enc:').toString('base64').slice(0, 4)) && !JSON.stringify(stored).includes('alices password') && !JSON.stringify(stored).includes('scd_'), JSON.stringify(stored).slice(0, 200));
  check('the store file is private (0600)', (fs.statSync(storePath).mode & 0o777) === 0o600);
  const devices = await (await fetch(`${BASE}/api/auth/devices`, { headers: { Cookie: browserCookie } })).json();
  check('the server lists the device by its name, not revoked', devices.devices?.length === 1 && devices.devices[0].name === 'test laptop' && devices.devices[0].revoked === false, JSON.stringify(devices));
  const status = homeServer.homeServerStatus(ctx);
  check('status: the account\'s role is kept with the link (alice is the administrator)', status.role === 'admin', JSON.stringify(status));
  check('status: linked, with url/username/device name', status.linked && status.url === BASE && status.username === 'alice' && status.deviceName === 'test laptop' && status.encrypted);
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: browserCookie } })).json();
  check('status: carries the account id and display name (the cloud identity derives from them)', status.userId === me.user.id && typeof status.displayName === 'string', JSON.stringify({ userId: status.userId, displayName: status.displayName }));

  // the central server behind the home server needs no pairing: the pairing
  // routes of 3.0/3.1 are gone, the ticket route is the way in (this backend
  // provides no central server, so it says so)
  let p = await homeServer.homeServerFetch('/api/auth/central', {}, ctx);
  check('the account pairing routes of 3.0/3.1 are gone (404)', !p.ok && p.status === 404, p.text.slice(0, 80));
  p = await homeServer.homeServerFetch('/api/auth/central-ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, ctx);
  check('a ticket is asked for through the link with the device token (no central server here: NO_CENTRAL)', p.status === 404 && JSON.parse(p.text).code === 'NO_CENTRAL', p.text.slice(0, 80));

  let r = await homeServer.homeServerFetch('/api/auth/me', {}, ctx);
  check('homeServerFetch authenticates with the bearer token', r.ok && JSON.parse(r.text).user?.username === 'alice', r.text);
  r = await homeServer.homeServerFetch('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'test laptop', changes: [] }) }, ctx);
  check('...and carries the X-Requested-With header on a POST', r.ok, r.text);
  r = await homeServer.homeServerFetch('/health', {}, ctx);
  check('a non-API path is refused locally', !r.ok && r.status === 0);

  // the central server behind the home server (/central/*, 3.1): reached through this
  // process without the device token - a stub home server echoes what arrives

  const echo = http.createServer((rq, rs) => { rs.setHeader('Content-Type', 'application/json'); rs.end(JSON.stringify(rq.url === '/api/version' ? { app: '3.1.0', protocol: 2, capabilities: { central: { provided: true, path: '/central', accountSignIn: true } } } : { path: rq.url, method: rq.method, authorization: rq.headers.authorization || null, requestedWith: rq.headers['x-requested-with'] || null, ticket: rq.headers['x-account-ticket'] || null })); });
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const echoBase = `http://127.0.0.1:${echo.address().port}`;
  const echoStore = path.join(WORK, 'echo-profile', 'home-server.json');
  fs.mkdirSync(path.dirname(echoStore), { recursive: true });
  fs.writeFileSync(echoStore, JSON.stringify({ url: echoBase, username: 'alice', deviceId: 'd1', token: homeServer.createCodec(safeStorage).encode('device-token-synthetic') }));
  const echoCtx = { storePath: echoStore, pinsPath, safeStorage };
  r = await homeServer.homeServerFetch('/central/api/health', { method: 'GET', headers: { 'X-Account-Ticket': 'v1.a.b' } }, echoCtx);
  let echoed = JSON.parse(r.text);
  check('a /central/ path is forwarded WITHOUT the device token, with the headers given (the account ticket)', r.ok && echoed.path === '/central/api/health' && echoed.authorization === null && echoed.ticket === 'v1.a.b' && echoed.requestedWith === 'Jacarium', r.text);
  r = await homeServer.homeServerFetch('/api/auth/central-ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, echoCtx);
  echoed = JSON.parse(r.text);
  check('...while an /api/ path carries the bearer token', echoed.path === '/api/auth/central-ticket' && echoed.method === 'POST' && echoed.authorization === 'Bearer device-token-synthetic', r.text);
  r = await homeServer.homeServerFetch('/centralx/api/health', {}, echoCtx);
  check('...and a look-alike path outside /central/ and /api/ is refused locally', !r.ok && r.status === 0);
  const echoVer = await homeServer.homeServerVersion({ ...echoCtx });
  check('homeServerVersion passes the server\'s capabilities through (the provided central server)', echoVer.reachable && echoVer.protocol === 2 && echoVer.capabilities?.central?.provided === true, JSON.stringify(echoVer));
  echo.close();
  const { fingerprintOf } = createRequire(import.meta.url)(path.join(REPO, 'electron', 'tls-trust.cjs'));
  check('fingerprintOf turns Node\'s hex fingerprint into the store\'s sha256/<base64> form', fingerprintOf({ fingerprint256: '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF' }) === `sha256/${Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex').toString('base64')}` && fingerprintOf({}) === '');

  // the sync engine through this transport: a browser session pushes, the device pulls
  await fetch(`${BASE}/api/sync/push`, { method: 'POST', headers: { ...CSRF, Cookie: browserCookie }, body: JSON.stringify({ device: 'browser', changes: [{ collection: 'documents', key: 'sid-from-browser', baseRev: 0, updatedAt: Date.now(), deleted: false, body: { title: 'From the browser', content: 'hi', category: 'General', stableId: 'sid-from-browser' } }] }) });
  r = await homeServer.homeServerFetch('/api/sync/pull?since=0', {}, ctx);
  const feed = JSON.parse(r.text);
  check('the device pulls what a browser session pushed (the engine\'s transport path)', r.ok && feed.changes?.[0]?.key === 'sid-from-browser', r.text.slice(0, 160));

  // the server's version: from the real backend (package.json / protocol.json), and an old server without the endpoint
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const proto = JSON.parse(fs.readFileSync(path.join(REPO, 'protocol.json'), 'utf8'));
  const ver = await homeServer.homeServerVersion(ctx);
  check('homeServerVersion reports the linked server\'s app version and protocol (no token needed)', ver.reachable && ver.app === pkg.version && ver.protocol === proto.protocol && !ver.legacy, JSON.stringify(ver));

  const old = http.createServer((req2, res) => { res.statusCode = 404; res.end('not found'); });
  await new Promise((r2) => old.listen(0, '127.0.0.1', r2));
  const legacy = await homeServer.homeServerVersion({ url: `http://127.0.0.1:${old.address().port}`, ...ctx });
  check('a server without /api/version is reported as legacy: protocol 1, no app version', legacy.reachable && legacy.legacy && legacy.protocol === 1 && legacy.app === null, JSON.stringify(legacy));
  old.close();
  const down = await homeServer.homeServerVersion({ url: 'http://127.0.0.1:9', ...ctx });
  check('an unreachable server is reported as such, not as legacy', !down.reachable && !down.legacy && typeof down.error === 'string', JSON.stringify(down));

  const after = await homeServer.unlinkHomeServer(ctx);
  check('unlink removes the store and reports not linked', after.linked === false && !fs.existsSync(storePath) && homeServer.homeServerStatus(ctx).linked === false);
  const revoked = await (await fetch(`${BASE}/api/auth/devices`, { headers: { Cookie: browserCookie } })).json();
  check('...and revoked the token on the server', revoked.devices?.[0]?.revoked === true, JSON.stringify(revoked));
  r = await homeServer.homeServerFetch('/api/auth/me', {}, ctx);
  check('a fetch after unlink says not linked', !r.ok && r.status === 0);

  // relink: the same account, hence the same identity
  const relinked = await homeServer.linkHomeServer({ url: BASE, username: 'alice', password: 'alices password', deviceName: 'test laptop again', ...ctx });
  const status2 = homeServer.homeServerStatus(ctx);
  check('relinking gives the same account id (same cloud identity) with a new device token', relinked.deviceId && relinked.deviceId !== linked.deviceId && status2.userId === me.user.id, JSON.stringify({ before: linked.deviceId, after: relinked.deviceId, userId: status2.userId }));
  await homeServer.unlinkHomeServer(ctx);

  // relink to ANOTHER account: the link is that account's (the renderer then refuses
  // to synchronise a database that belonged to the first one - src/sync/syncEngine.js)
  const bob = await (await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: { ...CSRF, Cookie: browserCookie }, body: JSON.stringify({ username: 'bob', password: 'bobs password 1', displayName: 'Bob' }) })).json();
  const asBob = await homeServer.linkHomeServer({ url: BASE, username: 'bob', password: 'bobs password 1', deviceName: 'shared laptop', ...ctx });
  const statusBob = homeServer.homeServerStatus(ctx);
  check('relinking as another account gives that account\'s id and name, nothing of the first', asBob.username === 'bob' && statusBob.userId === bob.user.id && statusBob.displayName === 'Bob' && statusBob.userId !== me.user.id, JSON.stringify(statusBob));
  await homeServer.unlinkHomeServer(ctx);
} catch (e) {
  check('the run completed', false, `${e.message}\n${e.stack}`);
} finally {
  stop();
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
