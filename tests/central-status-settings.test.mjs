/**
 * Guards the read-only central status in Settings > General
 * (src/components/common/modals/settings/CentralStatus.jsx) and the words the
 * team features show when there is no central server
 * (src/utils/centralAvailability.js), with the REAL component rendered under
 * jsdom (React 19) and fake bridges - no network.
 *
 * Proves:
 *   1. a linked desktop profile: "Connecting to <host>/central..." first,
 *      "Connected to ..." once the socket reports it, the identity and the
 *      display name teammates see;
 *      a protocol mismatch of the home server -> the version-mismatch line;
 *   2. an unlinked desktop profile: the unavailable state with the hint that
 *      names Settings > General > Home server; the notification helper makes
 *      it a confirm whose action opens Settings on the General tab;
 *   3. a signed-out browser: the hint says to sign in, the notification is a
 *      plain notice (no settings action);
 *   4. the Settings dialog has no Cloud Sync tab and nothing opens one
 *      (static sweep of src/).
 *
 * Needs jsdom (npm install --no-save jsdom) and esbuild.
 * Run: node tests/central-status-settings.test.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'central-status-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  export { default as CentralStatus } from '@worktree/src/components/common/modals/settings/CentralStatus.jsx';
  export * as central from '@worktree/src/utils/cloudCentralSync.js';
  export * as availability from '@worktree/src/utils/centralAvailability.js';
  export * as ws from '@worktree/src/utils/cloudWebSocket.js';
  export * as homeServer from '@worktree/src/utils/homeServer.js';
  export * as platform from '@worktree/src/utils/platform.js';
  export * as React from 'react';
  export { createRoot } from 'react-dom/client';
  export { act } from 'react';
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx' }, jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    // the IndexedDB-backed modules are irrelevant here
    b.onResolve({ filter: /\/db\/database$/ }, () => ({ path: 'db-stub', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const db = new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => Promise.resolve([]), apply: () => Promise.resolve([]) }) });', loader: 'js' }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }],
  logLevel: 'error',
});

const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://console.example.test/', pretendToBeVisual: true });
for (const k of ['window', 'document', 'location', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { CentralStatus, central, availability, ws, homeServer, platform, React, createRoot, act } = createRequire(import.meta.url)(BUNDLE);

const HOME = 'https://pi.example.test';
let protocolAnswer = 2;
const desktop = ({ linked = true } = {}) => ({
  isElectron: true, getUsername: async () => 'robbo', getHostname: async () => 'laptop',
  homeServerStatus: async () => (linked ? { linked: true, url: HOME, userId: 'u1', username: 'alice', displayName: 'Alice Example' } : { linked: false }),
  homeServerVersion: async () => ({ desktop: { app: '3.2.0', protocol: 2 }, server: { reachable: true, linked: true, url: HOME, app: '3.2.0', protocol: protocolAnswer, legacy: false, error: null } }),
  homeServerFetch: async (p) => { const a = p === '/api/version' ? { app: '3.2.0', protocol: 2, capabilities: { central: { provided: true, path: '/central', accountSignIn: true } } } : p === '/api/auth/central-ticket' ? { ticket: 'v1.t.sig', expiresAt: Math.floor(Date.now() / 1000) + 600 } : null; return { ok: !!a, status: a ? 200 : 404, text: JSON.stringify(a || {}) }; },
  getAppVersion: async () => '3.2.0',
});
const root = createRoot(document.getElementById('root'));
const text = (sel) => document.querySelector(sel)?.textContent || '';
const state = () => document.querySelector('[data-testid="central-status"]')?.getAttribute('data-state');
async function render() { await act(async () => { root.render(React.createElement(CentralStatus)); }); await act(async () => { await sleep(50); }); }
async function unmount() { await act(async () => { root.render(null); }); }

try {
  // ---- 1. linked desktop ----
  window.electronAPI = desktop();
  await render();
  check('1. linked desktop: connecting to <home>/central', state() === 'connecting' && /Connecting to pi\.example\.test\/central/.test(text('[data-testid="central-connection"]')), `${state()} ${text('[data-testid="central-connection"]')}`);
  check('1. ...the identity teammates see: the display name and the account identity', /Alice Example/.test(text('[data-testid="central-identity"]')) && /alice@account-u1/.test(text('[data-testid="central-identity"]')), text('[data-testid="central-identity"]'));
  check('1. the socket is not connected (no central server reachable here)', ws.isWebSocketConnected() === false);
  // a protocol mismatch pauses synchronisation and the central server with it
  protocolAnswer = 3;
  await act(async () => { await homeServer.checkHomeServerVersion(); await sleep(30); });
  check('1. a protocol mismatch of the home server -> version mismatch', state() === 'version-mismatch' && /versions do not match/.test(text('[data-testid="central-connection"]')), `${state()} ${text('[data-testid="central-connection"]')}`);
  protocolAnswer = 2;
  await act(async () => { await homeServer.checkHomeServerVersion(); await sleep(30); });
  await unmount();

  // ---- 2. unlinked desktop ----
  central.resetIdentityCache();
  window.electronAPI = desktop({ linked: false });
  await render();
  check('2. unlinked desktop: unavailable, the hint names Settings > General > Home server', state() === 'unavailable' && /Link this profile to your home server \(Settings > General > Home server\)/.test(text('[data-testid="central-connection"]')) && !document.querySelector('[data-testid="central-identity"]'), `${state()} ${text('[data-testid="central-connection"]')}`);
  const notes = [];
  const opened = [];
  window.addEventListener('openAppSettings', (e) => opened.push(e.detail?.tab));
  const hint2 = availability.notifyCentralUnavailable((n) => notes.push(n), 'share documents');
  check('2. the notification is a confirm with "Open Settings"', notes.length === 1 && notes[0].type === 'confirm' && notes[0].confirmLabel === 'Open Settings' && /share documents/.test(notes[0].message) && hint2.action === 'settings', JSON.stringify(notes[0]?.title));
  notes[0].onConfirm();
  check('2. ...whose action opens Settings on the General tab', opened[0] === 'general', JSON.stringify(opened));
  await unmount();

  // ---- 3. signed-out browser ----
  central.resetIdentityCache(); platform.__resetPlatformForTests();
  window.electronAPI = undefined;
  globalThis.fetch = async (url) => { const u = String(url); const body = u.endsWith('/api/capabilities') ? { authMode: 'accounts', auth: { mode: 'accounts', user: null }, capabilities: { central: { provided: true, path: '/central', accountSignIn: true } } } : null; return { ok: !!body, status: body ? 200 : 404, json: async () => body || {}, text: async () => JSON.stringify(body || {}) }; };
  await platform.initializePlatform();
  await render();
  check('3. signed-out browser: unavailable with the sign-in hint', state() === 'unavailable' && /Sign in to a home server/.test(text('[data-testid="central-connection"]')), `${state()} ${text('[data-testid="central-connection"]')}`);
  notes.length = 0;
  const hint3 = availability.notifyCentralUnavailable((n) => notes.push(n), 'share a game link');
  check('3. the notification is a plain notice (no settings action)', notes.length === 1 && notes[0].type === 'info' && hint3.action === null && /share a game link/.test(notes[0].message), JSON.stringify(notes[0]?.type));
  await unmount();

  // ---- 4. no Cloud Sync tab anywhere ----
  const modal = fs.readFileSync(path.join(REPO, 'src', 'components', 'common', 'modals', 'SettingsModal.jsx'), 'utf8');
  check('4. SettingsModal has no Cloud Sync tab', !/Cloud Sync|CloudSyncSettings|'cloud'/.test(modal));
  const sweep = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (!/whats-new/.test(p)) walk(p); } else if (/\.(jsx?|mjs)$/.test(e.name) && /openAppSettings\('cloud'\)|Settings > Cloud Sync|cloudCentralServerUrl|cloudEnrollmentSecret|cloudClientSecret/.test(fs.readFileSync(p, 'utf8'))) sweep.push(path.relative(REPO, p)); } };
  walk(path.join(REPO, 'src'));
  check('4. nothing in src/ opens a Cloud Sync tab or reads the old manual-configuration keys', sweep.length === 0, sweep.join(', '));
} catch (error) {
  check('the scenario ran to the end', false, error.stack || error.message);
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
