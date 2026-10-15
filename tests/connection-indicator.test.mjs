/**
 * Guards the bottom-right connection indicator
 * (src/components/common/ConnectionIndicator.jsx, pure state in
 * src/utils/connectionState.js) in the shared status corner
 * (src/components/common/StatusCorner.jsx) next to the debug status bar.
 *
 * THE REQUIREMENT: "online" means this client is synchronising with its
 * home server, "offline" means it is not - and the tooltip says why. There
 * is no setting behind it: the state follows the real sync engine
 * (src/sync/syncEngine.js), the home-server version gate and the browser's
 * network events.
 *
 * The REAL components run under jsdom (React 19, fake-indexeddb for the
 * engine's database) with a transport the test controls:
 *   - desktop, no link: offline / not-linked, a plain status (no button);
 *   - browser, no session: offline / signed-out;
 *   - the engine started, the server unreachable (fetch rejects): offline /
 *     unreachable, the tooltip names the server and "click to retry";
 *   - the gate reports a protocol mismatch: update-required with its own
 *     tooltip;
 *   - a cycle in flight: syncing (spinner), then online once it succeeded;
 *   - the session gone (401): offline / auth;
 *   - the browser loses the network ('offline' event): offline / no-network,
 *     back to online on 'online';
 *   - a click on the indicator synchronises now (the transport is called);
 *   - pure: pending changes show their count;
 *   - the corner: only StatusCorner is fixed, the indicator is its last
 *     child, the debug bar (toggled live) sits to its left, and nothing in
 *     src/ still refers to the removed Offline Mode.
 *
 * Run:  node tests/connection-indicator.test.mjs
 * Preconditions: npm install, plus the test-only deps the jsdom tests share
 *   (npm install --no-save jsdom fake-indexeddb - see tests/run-all.sh).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
for (const dep of ['jsdom', 'fake-indexeddb', 'esbuild', 'dexie']) { try { req.resolve(dep); } catch { console.log(`Missing test-only dependency "${dep}". Install it without saving: npm install --no-save jsdom fake-indexeddb`); process.exit(1); } }

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${!pass && detail ? ` (${String(detail).slice(0, 300)})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ---------- static structure ----------
const appSrc = read('src/App.jsx');
const cornerSrc = read('src/components/common/StatusCorner.jsx');
const barSrc = read('src/components/common/DebugStatusBar.jsx');
const iconSrc = read('src/components/common/ConnectionIndicator.jsx');
check('App.jsx mounts StatusCorner in every window branch (9)', (appSrc.match(/<StatusCorner \/>/g) || []).length === 9);
check('only StatusCorner is position: fixed', /\bfixed\b/.test(cornerSrc) && !/\bfixed\b/.test(barSrc.replace(/\/\/[^\n]*/g, '')) && !/\bfixed\b/.test(iconSrc.replace(/\/\/[^\n]*/g, '')));
check('StatusCorner mounts ONE connection indicator (no separate sync / offline icons)', /<ConnectionIndicator \/>/.test(cornerSrc) && !/SyncIndicator|OfflineModeIndicator/.test(cornerSrc) && !fs.existsSync(path.join(REPO, 'src/components/common/SyncIndicator.jsx')) && !fs.existsSync(path.join(REPO, 'src/components/common/OfflineModeIndicator.jsx')));
const sweep = [];
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (!/whats-new|node_modules|venv|__pycache__|static/.test(p)) walk(p); } else if (/\.(jsx?|mjs|cjs|py)$/.test(e.name) && /Offline Mode|offlineMode|OfflineModeError|isOfflineMode|OFFLINE_MODE/.test(fs.readFileSync(p, 'utf8'))) sweep.push(path.relative(REPO, p)); } };
for (const dir of ['src', 'electron', 'backend']) if (fs.existsSync(path.join(REPO, dir))) walk(path.join(REPO, dir));
check('nothing in src/, electron/ or backend/ refers to Offline Mode any more', sweep.length === 0, sweep.join(', '));

// ---------- jsdom + fake-indexeddb ----------
const { JSDOM } = req('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'https://console.example.test/' });
const { window } = dom;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver', 'FileReader', 'Blob']) {
  if (window[key] !== undefined) Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
for (const k of ['db_migration_complete', 'workflows_migration_complete', 'env_vars_migration_complete']) localStorage.setItem(k, 'true');
await import(req.resolve('fake-indexeddb/auto'));
for (const k of ['indexedDB', 'IDBKeyRange']) { const v = globalThis[k] || window[k]; globalThis[k] = v; window[k] = v; }
let networkOnline = true;
Object.defineProperty(window.navigator, 'onLine', { get: () => networkOnline, configurable: true });

const listeners = { debug: null, metrics: null };
let debugEnabled = false;
const desktopBridge = {
  isElectron: true,
  getDebugBarEnabled: async () => debugEnabled,
  onDebugBarChanged: (cb) => { listeners.debug = cb; return () => { listeners.debug = null; }; },
  onDebugMetrics: (cb) => { listeners.metrics = cb; return () => { listeners.metrics = null; }; },
};
window.electronAPI = desktopBridge;

// ---------- bundle the real components and the engine ----------
const { build } = await import(req.resolve('esbuild'));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-indicator-'));
const ENTRY = path.join(WORKDIR, 'entry.mjs');
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
fs.writeFileSync(ENTRY, `
  export { default as StatusCorner } from '@worktree/src/components/common/StatusCorner.jsx';
  export { connectionState } from '@worktree/src/utils/connectionState.js';
  export * as engine from '@worktree/src/sync/syncEngine.js';
  export * as React from 'react';
  export { createRoot } from 'react-dom/client';
  export { act } from 'react';
`);
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node',
  jsx: 'automatic', loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }],
  logLevel: 'warning',
});
const realLog = console.log; const realWarn = console.warn; const realError = console.error;
const quiet = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };
const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realError; };
const { StatusCorner, connectionState, engine, React, createRoot, act } = req(BUNDLE);

const flush = (ms = 30) => act(async () => { await sleep(ms); });
const corner = () => document.querySelector('[data-testid="status-corner"]');
const icon = () => document.querySelector('[data-testid="connection-indicator"]');
const state = () => icon()?.getAttribute('data-state');
const reason = () => icon()?.getAttribute('data-reason');
const title = () => icon()?.getAttribute('title') || '';
const bar = () => document.querySelector('[aria-label="Debug status bar"]');

// a controllable home-server transport for the engine
let mode = 'ok';           // 'ok' | 'reject' | 'unauthorized' | 'slow'
let release = null;        // resolves the slow answer
const transportCalls = [];
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const transport = {
  fetch: async (p, init = {}) => {
    transportCalls.push(`${init.method || 'GET'} ${p}`);
    if (mode === 'reject') throw new TypeError('Failed to fetch');
    if (mode === 'unauthorized') return answer(401, { error: 'Not signed in' });
    if (mode === 'slow') await new Promise((r) => { release = r; });
    if (/^\/api\/sync\/pull/.test(p)) return answer(200, { changes: [], seq: 0, more: false, now: Date.now(), generation: 1 });
    if (/^\/api\/sync\/push/.test(p)) return answer(200, { results: [], seq: 0, now: Date.now() });
    return answer(404, { error: 'not found' });
  },
};
let gateVerdict = { ok: true };
const gate = async () => gateVerdict;

let exitCode = 1;
let root;
try {
  root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(StatusCorner)); });
  await flush();

  // ---- 1. desktop, not linked ----
  check('1. corner rendered with the indicator as its last child', Boolean(corner()) && corner()?.lastElementChild === icon());
  check('1. desktop without a link: offline / not-linked, naming Settings > General > Home server', state() === 'offline' && reason() === 'not-linked' && /Not linked to a home server/.test(title()) && /Settings > General > Home server/.test(title()), `${state()} ${reason()} ${title()}`);
  check('1. ...a plain status (nothing to click), icon-only with the tooltip as aria-label', icon()?.tagName === 'DIV' && icon()?.getAttribute('role') === 'status' && icon()?.getAttribute('aria-label') === title() && Boolean(icon()?.querySelector('svg')) && (icon()?.textContent || '').trim() === '');
  check('1. ...changes are kept on this device', /kept on this device/.test(title()));
  check('1. the container is pointer-events-none and the indicator opts back in', /pointer-events-none/.test(corner()?.className || '') && /pointer-events-auto/.test(icon()?.className || ''));
  check('1. the indicator does not position itself', !/\bfixed\b|bottom-|right-/.test(icon()?.className || ''));

  // ---- 2. browser, signed out ----
  window.electronAPI = undefined;
  await act(async () => { root.render(null); });
  await act(async () => { root.render(React.createElement(StatusCorner)); });
  await flush();
  check('2. browser without a session: offline / signed-out ("Not connected to your home server")', state() === 'offline' && reason() === 'signed-out' && /Not connected to your home server/.test(title()), `${state()} ${reason()} ${title()}`);

  // ---- 3. the engine starts, the server is unreachable ----
  mode = 'reject';
  quiet();
  await act(async () => { await engine.startSync({ transport, gate, listen: false }); });
  loud();
  await flush();
  check('3. server unreachable: offline / unreachable, "Home server unreachable", click to retry', state() === 'offline' && reason() === 'unreachable' && /Home server unreachable/.test(title()) && /click to retry/.test(title()), `${state()} ${reason()} ${title()}`);
  check('3. ...rendered as a button now that the engine runs', icon()?.tagName === 'BUTTON');

  // ---- 4. a click synchronises now ----
  mode = 'ok';
  transportCalls.length = 0;
  await act(async () => { icon().click(); });
  await flush(80);
  check('4. a click synchronises now: the transport was called, the state is online', transportCalls.length > 0 && state() === 'online' && /Connected to your home server/.test(title()) && /in sync/.test(title()), `${transportCalls.length} ${state()} ${title()}`);
  check('4. online uses a green cloud', /text-green/.test(icon()?.className || ''));

  // ---- 5. the gate pauses synchronisation: update required ----
  gateVerdict = { ok: false, reason: 'Synchronisation paused: versions do not match' };
  await act(async () => { await engine.syncNow(); });
  await flush();
  check('5. a protocol mismatch: update-required with its own tooltip', state() === 'update-required' && /Update required/.test(title()) && /versions do not match/.test(title()), `${state()} ${title()}`);
  gateVerdict = { ok: true };

  // ---- 6. a cycle in flight: syncing, then online ----
  mode = 'slow';
  let cycle;
  await act(async () => { cycle = engine.syncNow(); await sleep(20); });
  check('6. while a cycle runs: syncing (spinner)', state() === 'syncing' && Boolean(icon()?.querySelector('.animate-spin')), state());
  mode = 'ok';
  await act(async () => { release?.(); await cycle; });
  await flush();
  check('6. ...then online again', state() === 'online', state());

  // ---- 7. the session is gone ----
  mode = 'unauthorized';
  quiet();
  await act(async () => { await engine.syncNow(); });
  loud();
  await flush();
  check('7. a 401 from the home server: offline / auth ("sign in again")', state() === 'offline' && reason() === 'auth' && /sign in again/.test(title()), `${state()} ${reason()} ${title()}`);
  mode = 'ok';
  await act(async () => { await engine.syncNow(); });
  await flush();
  check('7. ...online once a sync succeeds', state() === 'online', state());

  // ---- 8. the browser loses its network ----
  networkOnline = false;
  await act(async () => { window.dispatchEvent(new window.Event('offline')); });
  await flush();
  check("8. the browser's 'offline' event: offline / no-network", state() === 'offline' && reason() === 'no-network' && /no network connection/.test(title()), `${state()} ${reason()} ${title()}`);
  networkOnline = true;
  await act(async () => { window.dispatchEvent(new window.Event('online')); });
  await flush(80);
  check("8. ...and 'online' brings it back", state() === 'online', state());

  // ---- 9. the debug bar toggled live sits to the left ----
  debugEnabled = true;
  window.electronAPI = { ...desktopBridge, isElectron: false };
  await act(async () => { root.render(null); });
  await act(async () => { root.render(React.createElement(StatusCorner)); });
  await flush();
  await act(async () => { listeners.debug?.(true); });
  await flush();
  check('9. debug bar ON live: bar and indicator are siblings, bar first, indicator in the corner', Boolean(bar()) && Boolean(icon()) && bar()?.parentElement === corner() && corner()?.lastElementChild === icon() && Array.from(corner()?.children || []).indexOf(bar()) < Array.from(corner()?.children || []).indexOf(icon()));
  await act(async () => { listeners.debug?.(false); });
  await flush();
  check('9. debug bar OFF: the indicator stays', !bar() && Boolean(icon()));

  // ---- 10. the pure state: pending count, precedence ----
  const base = { enabled: true, syncing: false, lastError: null, lastErrorStatus: null, pending: 0, paused: null, lastPullAt: null };
  check('10. pending changes: "pending" with the count in the tooltip', connectionState({ sync: { ...base, pending: 3 } }).state === 'pending' && /3 change\(s\)/.test(connectionState({ sync: { ...base, pending: 3 } }).title));
  check('10. no network wins over everything', connectionState({ sync: { ...base, syncing: true }, networkOnline: false }).reason === 'no-network');
  check('10. the version check alone (paused) is update-required', connectionState({ sync: base, versionCheck: { paused: true, title: 'Synchronisation paused: versions do not match' } }).state === 'update-required');
  check('10. the version check alone (unreachable) is offline / unreachable', connectionState({ sync: base, versionCheck: { state: 'unreachable', message: 'The home server did not answer.' } }).reason === 'unreachable');
  check('10. desktop auth loss names the Home server section', /Settings > General > Home server/.test(connectionState({ sync: { ...base, lastError: 'sync request failed (HTTP 401)', lastErrorStatus: 401 }, desktop: true }).title));
  // the indicator shows the count while pending in the DOM too
  await act(async () => { root.render(null); });

  exitCode = results.every((r) => r.pass) ? 0 : 1;
  console.log(`\nSUMMARY: ${results.filter((r) => r.pass).length}/${results.length} passed`);
} catch (e) {
  console.error('TEST DRIVER ERROR:', e);
} finally {
  try { engine.stopSync(); } catch { /* ignore */ }
  try { await act(async () => { root?.unmount(); }); } catch { /* ignore */ }
  try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(exitCode);
}
