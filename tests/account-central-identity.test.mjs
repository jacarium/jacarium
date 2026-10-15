/**
 * Guards "the cloud identity is the account, and the home server is the
 * gateway to the central server" end to end (src/utils/cloudCentralSync.js
 * accountIdentity / providedCentralServer / account tickets, backend
 * /api/auth/central-ticket, jacarium-central account-tickets.js):
 *
 *   0. a browser that is NOT signed in has no central server at all: no
 *      URL, no credentials (NO_CENTRAL_SERVER), nothing registered anywhere;
 *   1. the same browser signs in: its identity becomes the account's
 *      (`alice@account-...`, display name from the account), the central
 *      server is `<page origin>/central`, and a document is shared with the
 *      account's ticket - no pairing, no secret, nothing in browser storage;
 *      the central server records the identity without a secret hash;
 *   2. "clear site data": empty storage, a new database, sign in again ->
 *      the same identity, the same URL, a fresh ticket, nothing to re-pair;
 *      the shared document can be removed as its owner;
 *   3. a second device (another session) of the account: same identity;
 *   4. switching accounts in ONE browser: sign out as alice, sign in as bob
 *      -> bob's identity and display name, the central socket is bob's
 *      (presence never shows alice), browser-local keys (purge list) are per
 *      account; back to alice -> alice again; a database that synchronised
 *      with one account refuses another (the desktop profile case);
 *   5. pairing is closed on the deployed shape: POST /api/register at the
 *      central server answers 403 ACCOUNT_SIGN_IN_ONLY.
 *
 * Everything is real: the home server (backend/app.py in accounts mode with
 * the ticket key), the jacarium-central (with the same key), a console-like
 * proxy that fronts both on one origin (tests/helpers/central-proxy.mjs,
 * what deploy/Caddyfile does), the app's modules bundled for jsdom +
 * fake-indexeddb. Synthetic data, throwaway dirs.
 * Needs: backend venv; cd jacarium-central && npm ci; npm install
 * --no-save jsdom fake-indexeddb. Run: node tests/account-central-identity.test.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';
import { startConsoleProxy } from './helpers/central-proxy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SERVER_DIR = path.join(REPO, 'jacarium-central');
const req = createRequire(path.join(REPO, 'package.json'));
const PYTHON = fs.existsSync(path.join(REPO, 'backend', 'venv', 'bin', 'python')) ? path.join(REPO, 'backend', 'venv', 'bin', 'python') : 'python3';
if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) { console.log('SKIP: jacarium-central/node_modules missing (cd jacarium-central && npm ci)'); process.exit(0); }
for (const dep of ['fake-indexeddb', 'esbuild', 'dexie', 'jsdom']) {
  try { req.resolve(dep); } catch { console.error(`Missing dependency "${dep}". Run: npm install --no-save jsdom fake-indexeddb`); process.exit(1); }
}
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 260) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ---- the home server, the central server and the console-like proxy in front ----
const KEY = crypto.randomBytes(32).toString('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'account-identity-'));
const S_DATA = path.join(TMP, 'home'); const C_DATA = path.join(TMP, 'central');
fs.mkdirSync(S_DATA, { recursive: true }); fs.mkdirSync(C_DATA, { recursive: true });
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_') && k !== 'ACCOUNT_TICKET_KEY' && k !== 'ENROLLMENT_SECRET'));
const logs = { S: '', C: '' };
const S_PORT = await freePort(); const C_PORT = await freePort();
const S = spawn(PYTHON, ['app.py'], { cwd: path.join(REPO, 'backend'), env: { ...baseEnv, HOME: S_DATA, PORT: String(S_PORT), JACARIUM_AUTH_MODE: 'accounts', JACARIUM_REPORTS_ROOT: path.join(S_DATA, 'reports'), JACARIUM_KNOWN_HOSTS: path.join(S_DATA, '.ssh', 'known_hosts'), JACARIUM_CENTRAL_PATH: '/central', JACARIUM_CENTRAL_TICKET_KEY: KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
const C = spawn('node', ['server.js'], { cwd: SERVER_DIR, env: { ...baseEnv, PORT: String(C_PORT), DATA_DIR: C_DATA, ACCOUNT_TICKET_KEY: KEY, TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
for (const [tag, child] of [['S', S], ['C', C]]) { child.stdout.on('data', (d) => { logs[tag] += d; }); child.stderr.on('data', (d) => { logs[tag] += d; }); }
const S_URL = `http://127.0.0.1:${S_PORT}`; const C_URL = `http://127.0.0.1:${C_PORT}`;
async function waitUp(url) { for (let i = 0; i < 300; i++) { try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ } await sleep(200); } return false; }
const proxy = await startConsoleProxy({ centralUrl: C_URL, backendUrl: S_URL });
const ORIGIN = proxy.url;   // what the browser's address bar shows: the console origin
const stopAll = () => { for (const c of [S, C]) { try { c.kill('SIGTERM'); } catch { /* gone */ } } proxy.close(); fs.rmSync(TMP, { recursive: true, force: true }); };
if (!(await waitUp(`${S_URL}/health`)) || !(await waitUp(`${C_URL}/api/health`))) { console.log('FAIL: a server did not start\n' + logs.S.slice(-1000) + logs.C.slice(-1000)); stopAll(); process.exit(1); }

// ---- a browser-ish environment at the console origin ----
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${ORIGIN}/` });
// (Node's own Event/CustomEvent stay: Dexie's BroadcastChannel needs them)
for (const key of ['window', 'document', 'FileReader', 'Blob', 'location']) {
  if (!(key in globalThis) || key === 'window' || key === 'document') Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.localStorage = dom.window.localStorage;
const seedStorage = () => { for (const k of ['db_migration_complete', 'workflows_migration_complete', 'env_vars_migration_complete']) localStorage.setItem(k, 'true'); };
seedStorage();

// ---- the account ----
const CSRF = { 'X-Requested-With': 'Jacarium', 'Content-Type': 'application/json' };
const setupCode = fs.readFileSync(path.join(S_DATA, 'setup-code'), 'utf8').trim();
async function session(body, pathName) {
  const r = await fetch(`${S_URL}${pathName}`, { method: 'POST', headers: CSRF, body: JSON.stringify(body) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error(`no cookie from ${pathName}: ${r.status} ${await r.text()}`);
  return cookie;
}
const cookie1 = await session({ setupCode, username: 'alice', password: 'alices password', displayName: 'Alice Example' }, '/api/auth/setup');
const me = await (await fetch(`${S_URL}/api/auth/me`, { headers: { ...CSRF, Cookie: cookie1 } })).json();
const ACCOUNT_ID = `alice@account-${String(me.user.id).replace(/[^0-9a-zA-Z]/g, '').slice(0, 12).toLowerCase()}`;

// the app's requests to the console origin carry the session of the "current browser"
let currentCookie = '';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const u = String(url);
  const headers = { ...(init.headers || {}) };
  if (u.startsWith(ORIGIN) && currentCookie && !headers.Cookie) headers.Cookie = currentCookie;
  return realFetch(url, { ...init, headers });
};

// ---- the app's modules, a fresh instance per "browser context" ----
const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'account-identity-bundle-'));
const entry = path.join(WORK, 'entry.mjs');
fs.writeFileSync(entry, `
  export * as central from '@worktree/src/utils/cloudCentralSync.js';
  export * as platform from '@worktree/src/utils/platform.js';
  export * as ws from '@worktree/src/utils/cloudWebSocket.js';
  export * as tasks from '@worktree/src/utils/tasks.js';
  export * as storage from '@worktree/src/utils/accountStorage.js';
  export * as engine from '@worktree/src/sync/syncEngine.js';
  export { db } from '@worktree/src/db/database.js';
`);
const bundle = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [entry], bundle: true, outfile: bundle, format: 'cjs', platform: 'node',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', 'globalThis.__JACARIUM_BACKEND_URL': JSON.stringify(ORIGIN) },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }],
  logLevel: 'error',
});
let contexts = 0;
async function browserContext({ dbName, cookie }) {
  currentCookie = cookie;
  globalThis.__JACARIUM_DB_NAME = dbName;
  // a fresh copy of the bundle = fresh module state (what a page load gives a browser)
  const copy = path.join(WORK, `bundle-${++contexts}.cjs`);
  fs.copyFileSync(bundle, copy);
  const mod = req(copy);
  await mod.platform.initializePlatform();   // what src/main.jsx does first
  await mod.db.open();
  return mod;
}
const registryOnCentral = () => { try { return JSON.parse(fs.readFileSync(path.join(C_DATA, 'clients.json'), 'utf8')); } catch { return {}; } };
const registrations = () => (logs.C.match(/Registration attempt/g) || []).length;
const secretKeysInStorage = () => Object.keys(localStorage).filter((k) => /secret|ticket|cloudCentralServerUrl/i.test(k));

try {
  // ---- 0: not signed in: no central server ----
  const b0 = await browserContext({ dbName: 'Jacarium-identity-anon', cookie: '' });
  const browserId = await b0.central.getMachineId();
  check('0. without sign-in the identity is the generated browser one', /^browser-[0-9a-f]{8}@/.test(browserId), browserId);
  check('0. ...and there is no central server: no URL, reason signed-out', (await b0.central.providedCentralServer()) === null && b0.central.getCentralServerUrl() === '' && b0.central.centralUnavailableReason() === 'signed-out', b0.central.centralUnavailableReason());
  let thrown = null;
  try { await b0.central.centralCredentials(); } catch (e) { thrown = e; }
  check('0. ...credentials throw NO_CENTRAL_SERVER, nothing is registered', thrown?.code === 'NO_CENTRAL_SERVER' && Object.keys(registryOnCentral()).length === 0 && registrations() === 0, thrown?.message);
  check('0. ...and the socket does not even try', (await b0.ws.connectWebSocket()) === false);

  // ---- 1: the same browser signs in ----
  const b1 = await browserContext({ dbName: 'Jacarium-identity-anon', cookie: cookie1 });
  const id1 = await b1.central.getMachineId();
  check('1. signed in, the identity is the account\'s', id1 === ACCOUNT_ID, `${id1} vs ${ACCOUNT_ID}`);
  check('1. ...and the display name is the account\'s', (await b1.central.getDisplayName()) === 'Alice Example', await b1.central.getDisplayName());
  const provided1 = await b1.central.providedCentralServer();
  check('1. the central server is <page origin>/central, provided by the home server', provided1?.url === `${ORIGIN}/central` && b1.central.getCentralServerUrl() === `${ORIGIN}/central`, JSON.stringify(provided1));
  const cred1 = await b1.central.centralCredentials();
  check('1. the credential is a ticket of the session', cred1.kind === 'ticket' && /^v1\./.test(cred1.value));
  const docId = await b1.db.documents.add({ title: 'Shared runbook', content: 'from alice', category: 'General', createdAt: new Date(), updatedAt: new Date() });
  const uploaded = await b1.central.uploadDocumentToCentral(await b1.db.documents.get(docId));
  const doc1 = await b1.db.documents.get(docId);
  check('1. a document is shared through /central with the ticket, owned by the account', uploaded?.success !== false && doc1.inCloud === true && doc1.ownerId === ACCOUNT_ID, JSON.stringify({ uploaded, ownerId: doc1.ownerId }));
  const entry1 = registryOnCentral()[ACCOUNT_ID];
  check('1. the central server records the account identity WITHOUT a secret hash; no registration happened', entry1 && entry1.account?.username === 'alice' && !entry1.secretHash && registrations() === 0, JSON.stringify(entry1));
  check('1. nothing of it is in browser storage (no URL, no secret, no ticket)', secretKeysInStorage().length === 0, JSON.stringify(Object.keys(localStorage)));

  // ---- 2: clear site data, sign in again ----
  localStorage.clear();
  seedStorage();
  const cookie2 = await session({ username: 'alice', password: 'alices password' }, '/api/auth/login');
  const b2 = await browserContext({ dbName: 'Jacarium-identity-cleared', cookie: cookie2 });
  check('2. after clearing site data the identity is the SAME and the URL is derived again', (await b2.central.getMachineId()) === ACCOUNT_ID && (await b2.central.providedCentralServer())?.url === `${ORIGIN}/central`);
  const cred2 = await b2.central.centralCredentials();
  check('2. a ticket again (the home server mints it; nothing to re-pair), still no registration', cred2.kind === 'ticket' && /^v1\./.test(cred2.value) && registrations() === 0);
  check('2. the central server still knows exactly one identity', Object.keys(registryOnCentral()).join(',') === ACCOUNT_ID, Object.keys(registryOnCentral()).join(','));
  check('2. the display name is the account\'s', (await b2.central.getDisplayName()) === 'Alice Example');
  // the document comes back through the home-server sync in real life; here its row is restored by hand
  const restoredId = await b2.db.documents.add({ ...doc1, id: undefined });
  const removed = await b2.central.removeDocumentFromCentral(await b2.db.documents.get(restoredId));
  check('2. the shared document can be removed from the cloud as its owner', removed?.success === true && (await b2.db.documents.get(restoredId)).inCloud === false, JSON.stringify(removed));

  // ---- 3: a second device of the account ----
  localStorage.clear();
  seedStorage();
  const cookie3 = await session({ username: 'alice', password: 'alices password' }, '/api/auth/login');
  const b3 = await browserContext({ dbName: 'Jacarium-identity-device2', cookie: cookie3 });
  check('3. a second device of the account has the same identity and the same central server', (await b3.central.getMachineId()) === ACCOUNT_ID && b3.central.getCentralServerUrl() === '' && (await b3.central.providedCentralServer())?.url === `${ORIGIN}/central`);
  check('3. the account identity is recognised as such', b3.central.isAccountIdentity(ACCOUNT_ID) && !b3.central.isBrowserIdentity(ACCOUNT_ID) && !b3.central.isAccountIdentity(browserId));

  // ---- 4: switching accounts in one browser ----
  // an observer on the central server sees who is connected (a second account, over the proxy)
  const created = await (await realFetch(`${S_URL}/api/admin/users`, { method: 'POST', headers: { ...CSRF, Cookie: cookie1 }, body: JSON.stringify({ username: 'observer', password: 'observers password', displayName: 'Observer' }) })).json();
  const cookieObs = await session({ username: 'observer', password: 'observers password' }, '/api/auth/login');
  const obsTicket = (await (await realFetch(`${S_URL}/api/auth/central-ticket`, { method: 'POST', headers: { ...CSRF, Cookie: cookieObs }, body: '{}' })).json()).ticket;
  const { io: ioClient } = req('socket.io-client');
  const presence = [];
  const observer = ioClient(ORIGIN, { path: '/central/socket.io', transports: ['websocket'], reconnection: false });
  observer.on('connected-users', (p) => presence.push(p));
  await new Promise((resolve, reject) => { observer.on('connect', () => observer.emit('authenticate', { account_ticket: obsTicket, display_name: 'Observer' })); observer.on('authenticated', resolve); observer.on('connect_error', reject); setTimeout(() => reject(new Error('observer timeout')), 5000); });
  const lastPresence = () => presence[presence.length - 1] || { users: [], names: {} };
  const until = async (pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(50); } return pred(); };

  // alice connects from this browser (b3 is her session, localStorage is hers)
  b3.tasks.addPurgedTaskUUIDs(['11111111-1111-4111-8111-111111111111']);
  check('4. alice\'s purge list is stored under a key of her own', Object.keys(localStorage).some((k) => k === `taskwarrior_purged_uuids:${me.user.id}`), JSON.stringify(Object.keys(localStorage)));
  check('4. alice connects to the central server over the socket, through /central/socket.io on the console origin', (await b3.ws.connectWebSocket()) === true && (await until(() => lastPresence().users.includes(ACCOUNT_ID))), JSON.stringify(lastPresence()));
  check('4. ...presence shows her display name', lastPresence().names?.[ACCOUNT_ID] === 'Alice Example');

  // sign out (the socket goes down with the account), sign in as bob in the SAME browser storage
  b3.ws.disconnectWebSocket();
  await until(() => !lastPresence().users.includes(ACCOUNT_ID));
  check('4. after sign-out alice is gone from presence', !lastPresence().users.includes(ACCOUNT_ID));
  const bobUser = await (await realFetch(`${S_URL}/api/admin/users`, { method: 'POST', headers: { ...CSRF, Cookie: cookie1 }, body: JSON.stringify({ username: 'bob', password: 'bobs password 1', displayName: 'Bob Example' }) })).json();
  const BOB_ID = `bob@account-${String(bobUser.user.id).replace(/[^0-9a-zA-Z]/g, '').slice(0, 12).toLowerCase()}`;
  const cookieBob = await session({ username: 'bob', password: 'bobs password 1' }, '/api/auth/login');
  const b4 = await browserContext({ dbName: `Jacarium-${bobUser.user.id}`, cookie: cookieBob });
  check('4. bob\'s identity is his own', (await b4.central.getMachineId()) === BOB_ID && (await b4.central.getDisplayName()) === 'Bob Example', await b4.central.getMachineId());
  check('4. bob\'s purge list is empty (alice\'s key is not his)', b4.tasks.getPurgedTaskUUIDs().length === 0 && b4.storage.scopedKey('x') === `x:${bobUser.user.id}`);
  check('4. bob connects; presence shows bob and never alice', (await b4.ws.connectWebSocket()) === true && (await until(() => lastPresence().users.includes(BOB_ID))) && !lastPresence().users.includes(ACCOUNT_ID) && lastPresence().names?.[BOB_ID] === 'Bob Example', JSON.stringify(lastPresence()));
  check('4. bob is on record at the central server as an account identity too', !!registryOnCentral()[BOB_ID]?.account && !registryOnCentral()[BOB_ID]?.secretHash);
  b4.ws.disconnectWebSocket();
  await until(() => !lastPresence().users.includes(BOB_ID));

  // back to alice
  const cookieA5 = await session({ username: 'alice', password: 'alices password' }, '/api/auth/login');
  const b5 = await browserContext({ dbName: `Jacarium-${me.user.id}`, cookie: cookieA5 });
  check('4. signing back in as alice gives alice again (identity, name, purge list)', (await b5.central.getMachineId()) === ACCOUNT_ID && (await b5.central.getDisplayName()) === 'Alice Example' && b5.tasks.getPurgedTaskUUIDs().length === 1);
  check('4. a database that synchronised with one account refuses another (the relinked desktop profile)', await (async () => {
    const t = { fetch: async () => ({ ok: true, status: 200, json: async () => ({ changes: [], seq: 0, latest: 0, results: [] }) }) };
    await b5.engine.startSync({ transport: t, listen: false, immediate: false, accountId: me.user.id });
    b5.engine.stopSync();
    try { await b5.engine.startSync({ transport: t, listen: false, immediate: false, accountId: bobUser.user.id }); return false; } catch (e) { return e.code === 'OTHER_ACCOUNT'; }
  })());
  check('4. ...while the same account may start again', await b5.engine.startSync({ transport: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ changes: [], seq: 0, latest: 0, results: [] }) }) }, listen: false, immediate: false, accountId: me.user.id }) === true);
  b5.engine.stopSync();
  observer.disconnect();

  // ---- 5: pairing is closed on this shape ----
  const reg = await realFetch(`${ORIGIN}/central/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machine_id: 'stranger@laptop' }) });
  const regBody = await reg.json();
  check('5. a stranger cannot pair at /central/api/register (403 ACCOUNT_SIGN_IN_ONLY)', reg.status === 403 && regBody?.code === 'ACCOUNT_SIGN_IN_ONLY' && !registryOnCentral()['stranger@laptop'], `${reg.status} ${JSON.stringify(regBody)}`);
  check('5. ...and the central server said so at startup', /Pairing: closed \(account sign-in only\)/.test(logs.C));
} catch (error) {
  check('the scenario ran to the end', false, error.stack || error.message);
  console.log(logs.S.slice(-1500)); console.log(logs.C.slice(-1500));
} finally {
  stopAll();
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
