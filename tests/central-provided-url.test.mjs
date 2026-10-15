/**
 * Guards how the app finds its central server (src/utils/cloudCentralSync.js:
 * providedCentralServer, getCentralServerUrl, centralUnavailableReason,
 * socketTargetFor, centralCredentials / account tickets, the desktop
 * transport through the main process) and the words the pages show when
 * there is none (src/utils/centralAvailability.js).
 *
 * The central server comes with the home server (3.2: nothing to configure,
 * no manual URL, no secrets). What this test proves with the REAL modules
 * under jsdom and fake bridges (no network):
 *   1. a linked desktop derives `<home server URL>/central` from GET
 *      /api/version through the main-process fetch; a URL left in storage
 *      by an earlier version is ignored (nothing reads it); no IPC tells the
 *      main process any host (the certificate scope is the home server's);
 *   2. socketTargetFor: origin + `/central/socket.io` for a path URL, the
 *      default path otherwise;
 *   3. requests to the provided server go through the main process
 *      (homeServerFetch with the /central/... path, the headers as given, no
 *      token added here), answer as a Response-like object;
 *   4. credentials: a ticket from POST /api/auth/central-ticket
 *      (X-Account-Ticket header), cached until shortly before it expires,
 *      renewed after; nothing of it in storage; /api/register never called;
 *   5. a browser signed in: `<page origin>/central` from the backend
 *      capabilities; signed out: no central server ('signed-out'), the
 *      credentials throw NO_CENTRAL_SERVER, the hint says to sign in;
 *   6. an unlinked desktop: 'not-linked', the hint names Settings > General >
 *      Home server (action 'settings'); a home server without a ticket key:
 *      'no-account-sign-in'; one that provides no central server:
 *      'no-central'; the old 'cloudCentralServerUrl' storage key is never
 *      read.
 *
 * Needs jsdom (npm install --no-save jsdom) and esbuild.
 * Run: node tests/central-provided-url.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
for (const dep of ['esbuild', 'jsdom']) { try { req.resolve(dep); } catch { console.error(`Missing dependency "${dep}". Run: npm install --no-save jsdom`); process.exit(1); } }
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'central-provided-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  export * as central from '@worktree/src/utils/cloudCentralSync.js';
  export * as availability from '@worktree/src/utils/centralAvailability.js';
  export * as platform from '@worktree/src/utils/platform.js';
`);
const STUBS = {
  siblings: 'export const updateDocument = async () => {}; export const updateWorkflow = async () => {}; export const updateInstance = async () => {}; export function generateUUID() { return "00000000-0000-4000-8000-000000000000"; } export async function getBackendUrl() { return location.origin; } export const apiFetch = (url, init) => fetch(url, init);',
};
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^\.\/(documents|workflows|taskwarriorInstances|uuid|backendUrl)$/ }, (a) => (/src\/utils\/(cloudCentralSync|platform)\.js$/.test(a.importer) ? { path: 'siblings', namespace: 'stub' } : null));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }],
  logLevel: 'error',
});

const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://console.example.test/' });
for (const k of ['window', 'document', 'location']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
globalThis.localStorage = dom.window.localStorage;
const { central, availability, platform } = createRequire(import.meta.url)(BUNDLE);

const HOME = 'https://pi.example.test';
const calls = [];
let ticketsIssued = 0;
let ticketLifetime = 600;
let versionAnswer = () => ({ app: '3.2.0', protocol: 2, capabilities: { central: { provided: true, path: '/central', accountSignIn: true } } });
const homeAnswers = (p) => ({
  '/api/version': versionAnswer,
  '/api/auth/central-ticket': () => ({ ticket: `v1.t${++ticketsIssued}.sig`, expiresAt: Math.floor(Date.now() / 1000) + ticketLifetime, identity: 'alice@account-u1' }),
  '/central/api/health': () => ({ status: 'ok', name: 'Central behind pi', account_sign_in: true }),
})[p]?.();
const desktop = ({ linked = true } = {}) => ({
  isElectron: true, getUsername: async () => 'robbo', getHostname: async () => 'laptop',
  homeServerStatus: async () => (linked ? { linked: true, url: HOME, userId: 'u1', username: 'alice', displayName: 'Alice Example' } : { linked: false }),
  homeServerLink: async () => ({}), homeServerUnlink: async () => ({}),
  homeServerFetch: async (p, init) => { calls.push({ path: p, init }); const a = homeAnswers(p); return { ok: !!a, status: a ? 200 : 404, text: JSON.stringify(a || { error: 'no' }) }; },
});
let fetchCalls = [];
globalThis.fetch = async (url, init = {}) => { fetchCalls.push({ url: String(url), init }); return { ok: false, status: 404, json: async () => ({ error: 'unexpected' }), text: async () => '{"error":"unexpected"}' }; };
const storageKeysRead = [];
const realGetItem = dom.window.localStorage.getItem.bind(dom.window.localStorage);
Object.defineProperty(globalThis, 'localStorage', { value: new Proxy(dom.window.localStorage, { get(t, k) { if (k === 'getItem') return (key) => { storageKeysRead.push(key); return realGetItem(key); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } }), configurable: true, writable: true });

try {
  // ---- 1. linked desktop ----
  window.electronAPI = desktop();
  localStorage.setItem('cloudCentralServerUrl', 'https://192.0.2.10:3000');   // what 3.0.x stored
  const provided = await central.providedCentralServer();
  check('1. a linked desktop derives the provided central server from GET /api/version', provided?.url === `${HOME}/central` && provided.desktop === true && provided.homeServerUrl === HOME && provided.path === '/central', JSON.stringify(provided));
  check('1. ...asked through the main-process fetch', calls.some((c) => c.path === '/api/version'));
  check('1. the URL in use is the provided one; nothing reads the old storage key', central.getCentralServerUrl() === `${HOME}/central` && !storageKeysRead.includes('cloudCentralServerUrl'), storageKeysRead.join(','));
  check('1. there is no reason for unavailability', central.centralUnavailableReason() === '' && central.providedCentralServerSync()?.url === `${HOME}/central`);
  check('1. the module exposes no manual configuration any more', !['setCentralServerUrl', 'setManualCentralUrl', 'isManualCentralUrl', 'getCentralEnrollmentSecret', 'ensureRegisteredWithCentral', 'getStoredClientSecret', 'testCentralServerConnection', 'adoptAccountCentralServerUrl'].some((k) => typeof central[k] === 'function'));

  // ---- 2. the socket target ----
  check('2. socketTargetFor: the origin and the engine path under the URL path', JSON.stringify(central.socketTargetFor(`${HOME}/central`)) === JSON.stringify({ url: HOME, path: '/central/socket.io' }));
  check('2. ...a trailing slash is not a path segment', central.socketTargetFor(`${HOME}/central/`).path === '/central/socket.io');
  check('2. ...a plain URL keeps the default path', JSON.stringify(central.socketTargetFor('https://sync.example.test:3000')) === JSON.stringify({ url: 'https://sync.example.test:3000', path: '/socket.io' }));

  // ---- 3. the transport ----
  calls.length = 0; fetchCalls = [];
  const health = await central.fetchWithTimeout(`${HOME}/central/api/health`, { method: 'GET', headers: { 'X-Account-Ticket': 'v1.x.y' } });
  const viaMain = calls.find((c) => c.path === '/central/api/health');
  check('3. a request to the provided server goes through the main process with the /central path and the headers as given', !!viaMain && viaMain.init.method === 'GET' && viaMain.init.headers['X-Account-Ticket'] === 'v1.x.y' && fetchCalls.length === 0, JSON.stringify(viaMain));
  check('3. ...and answers as a Response-like object', health.ok && health.status === 200 && (await health.json()).name === 'Central behind pi' && typeof (await health.text()) === 'string');
  const miss = await central.fetchWithTimeout(`${HOME}/central/api/missing`, { method: 'POST', body: '{}' });
  check('3. a non-2xx answer keeps its status', !miss.ok && miss.status === 404);

  // ---- 4. credentials ----
  calls.length = 0; fetchCalls = [];
  const cred = await central.centralCredentials();
  check('4. centralCredentials gives a ticket from POST /api/auth/central-ticket', cred.kind === 'ticket' && cred.value === 'v1.t1.sig' && calls.some((c) => c.path === '/api/auth/central-ticket' && c.init.method === 'POST'), JSON.stringify(cred));
  check('4. the auth header is X-Account-Ticket', (await central.getCentralAuthHeaders())['X-Account-Ticket'] === 'v1.t1.sig');
  check('4. the ticket is cached (one issue for three uses) and /api/register is never called', ticketsIssued === 1 && !calls.some((c) => /register/.test(c.path)) && fetchCalls.length === 0);
  check('4. ...and nothing of it is kept in storage', !Object.keys(dom.window.localStorage).some((k) => /ticket|secret/i.test(k)) && !JSON.stringify(dom.window.localStorage).includes('v1.t1'));
  central.resetIdentityCache(); window.electronAPI = desktop();
  ticketLifetime = 30; await central.providedCentralServer();
  await central.accountTicket(); const first = ticketsIssued;
  await central.accountTicket();
  check('4. a ticket within the renewal margin is fetched again', ticketsIssued === first + 1, `${first} -> ${ticketsIssued}`);
  ticketLifetime = 600;
  check('4. the identity is the account\'s', (await central.getMachineId()) === 'alice@account-u1' && (await central.getDisplayName()) === 'Alice Example');

  // ---- 5. a browser ----
  const browserBackend = (user) => async (url) => {
    const u = String(url); fetchCalls.push({ url: u });
    const body = u.endsWith('/api/capabilities') ? { authMode: 'accounts', auth: { mode: 'accounts', user }, capabilities: { central: { provided: true, path: '/central', accountSignIn: true } } }
      : u.endsWith('/api/auth/central-ticket') ? { ticket: 'v1.browser.sig', expiresAt: Math.floor(Date.now() / 1000) + 600, identity: 'bob@account-u2' }
      : null;
    return { ok: !!body, status: body ? 200 : 404, json: async () => body || { error: 'no' }, text: async () => JSON.stringify(body || { error: 'no' }) };
  };
  central.resetIdentityCache(); platform.__resetPlatformForTests();
  window.electronAPI = undefined;
  dom.window.localStorage.clear();
  fetchCalls = [];
  globalThis.fetch = browserBackend({ id: 'u2', username: 'bob', displayName: 'Bob' });
  await platform.initializePlatform();
  const inBrowser = await central.providedCentralServer();
  check('5. a signed-in browser derives <page origin>/central from the backend capabilities', inBrowser?.url === 'https://console.example.test/central' && inBrowser.desktop === false, JSON.stringify(inBrowser));
  const cred5 = await central.centralCredentials();
  check('5. ...and its credential is the ticket of the session', cred5.kind === 'ticket' && cred5.value === 'v1.browser.sig' && fetchCalls.some((c) => c.url.endsWith('/api/auth/central-ticket')), JSON.stringify(cred5));
  check('5. requests to the provided server use fetch (same origin)', await (async () => { fetchCalls = []; await central.fetchWithTimeout('https://console.example.test/central/api/health', { method: 'GET' }); return fetchCalls.length === 1 && fetchCalls[0].url === 'https://console.example.test/central/api/health'; })());
  central.resetIdentityCache(); platform.__resetPlatformForTests();
  globalThis.fetch = browserBackend(null);
  await platform.initializePlatform();
  check('5. a signed-out browser has no central server (signed-out)', (await central.providedCentralServer()) === null && central.getCentralServerUrl() === '' && central.centralUnavailableReason() === 'signed-out', central.centralUnavailableReason());
  let thrown = null;
  try { await central.centralCredentials(); } catch (e) { thrown = e; }
  check('5. ...its credentials throw NO_CENTRAL_SERVER', thrown?.code === 'NO_CENTRAL_SERVER', thrown?.message);
  const hint5 = availability.centralHint('share documents');
  check('5. ...and the hint says to sign in, with no settings action', /Sign in to a home server to share documents/.test(hint5.message) && hint5.action === null, hint5.message);

  // ---- 6. the other reasons ----
  central.resetIdentityCache(); platform.__resetPlatformForTests();
  window.electronAPI = desktop({ linked: false });
  check('6. an unlinked desktop profile: not-linked', (await central.providedCentralServer()) === null && central.centralUnavailableReason() === 'not-linked');
  const hint6 = availability.centralHint('share boards');
  check('6. ...the hint names Settings > General > Home server and opens Settings', /Link this profile to your home server \(Settings > General > Home server\) to share boards/.test(hint6.message) && hint6.action === 'settings', hint6.message);
  central.resetIdentityCache();
  window.electronAPI = desktop();
  versionAnswer = () => ({ app: '3.2.0', protocol: 2, capabilities: { central: { provided: true, path: '/central', accountSignIn: false } } });
  check('6. a home server without a ticket key: no-account-sign-in', (await central.providedCentralServer()) === null && central.centralUnavailableReason() === 'no-account-sign-in' && /redeploy/i.test(availability.centralHint().message), availability.centralHint().message);
  central.resetIdentityCache();
  versionAnswer = () => ({ app: '3.2.0', protocol: 2, capabilities: {} });
  check('6. a home server that provides no central server: no-central', (await central.providedCentralServer()) === null && central.centralUnavailableReason() === 'no-central' && /provides no central server/.test(availability.centralHint().message));
  check('6. the old storage key was never read by the module', !storageKeysRead.includes('cloudCentralServerUrl'), storageKeysRead.filter((k) => /central/i.test(k)).join(','));
} catch (error) {
  check('the scenario ran to the end', false, error.stack || error.message);
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
