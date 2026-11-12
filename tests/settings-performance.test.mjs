/**
 * Settings > Performance (src/components/common/modals/settings/PerformanceSettings.jsx, backend/
 * parallel_settings.py): how many CPU cores the backend's parallel work uses - its own category of the rail,
 * after Theme.
 *
 *   static: the rail (General, Editor, Theme, Performance, Integrations, ...), the panel rendered for the
 *     'performance' tab (openAppSettings('performance') reaches it), the API it reads and writes, the backend
 *     blueprint registered;
 *   jsdom, the REAL dialog and panel over a stub of /api/settings/parallel: the BACKEND's core count ("This computer
 *     has N cores; Auto uses M" on the desktop, "The server has ..." in a browser), the choices Auto and 1 (off) to
 *     N, a change sent as {"workers": n} and confirmed ("the next analysis uses n processes"), a refused value's
 *     message, the select disabled with the reason when JACARIUM_WORKERS sets it or the user may not change it,
 *     the note when the backend does not answer, the footer's "apply as you make them".
 *
 * Needs esbuild, jsdom and fake-indexeddb. Run: node tests/settings-performance.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// static
// ---------------------------------------------------------------------------
const modal = read('src/components/common/modals/SettingsModal.jsx');
const panel = read('src/components/common/modals/settings/PerformanceSettings.jsx');
check('the rail: Performance right after Theme, before Integrations', /\{ id: 'theme', label: 'Theme' \},\s*\{ id: 'performance', label: 'Performance' \},\s*\{ id: 'accessibility', label: 'Accessibility' \},\s*\{ id: 'integrations'/.test(modal));
check("the 'performance' tab renders PerformanceSettings; openAppSettings('performance') reaches it (the opener's tab goes to initialTab as it is)", /activeTab === 'performance' && <PerformanceSettings \/>/.test(modal) && /'performance'/.test(read('src/utils/openSettings.js')) && /setAppSettingsTab\(event\?\.detail\?\.tab \|\| 'general'\)/.test(read('src/components/CompactSidebar.jsx')));
check('the panel reads and writes /api/settings/parallel through the backend (never the browser\'s own cores)', /\/api\/settings\/parallel/.test(panel) && /method: 'PUT'/.test(panel) && !/hardwareConcurrency/.test(panel));
check('the backend registers the blueprint; General no longer carries the section', /app\.register_blueprint\(parallel_settings_api\)/.test(read('backend/app.py')) && !/PerformanceSection|parallel-workers/.test(read('src/components/common/modals/settings/GeneralSettings.jsx')));

// ---------------------------------------------------------------------------
// jsdom
// ---------------------------------------------------------------------------
for (const dep of ['esbuild', 'jsdom', 'fake-indexeddb']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} is not installed`); process.exit(failed ? 1 : 0); } }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-performance-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  export { act } from 'react';
  export * as React from 'react';
  export { createRoot };
  export { default as PerformanceSettings } from '@worktree/src/components/common/modals/settings/PerformanceSettings.jsx';
  export { default as SettingsModal } from '@worktree/src/components/common/modals/SettingsModal.jsx';
  export { ThemeProvider } from '@worktree/src/contexts/ThemeContext.jsx';
  export { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }], logLevel: 'error',
});
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'localStorage', 'sessionStorage']) define(key, window[key]);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); window.ResizeObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// the backend's answers: a stateful stub of /api/settings/parallel (the real validation: tests/parallel_settings.test.py)
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const server = { cores: 12, value: 'auto', override: null, canChange: true, reason: null, down: false, puts: [] };
const auto = (n) => Math.max(1, Math.min(n - 1, 8));
const view = () => ({ cores: server.cores, auto: auto(server.cores), value: server.value, effective: server.override ?? (server.value === 'auto' ? auto(server.cores) : Math.min(server.value, server.cores)), override: server.override, max: server.cores, canChange: server.canChange && server.override == null, reason: server.override != null ? "set by JACARIUM_WORKERS in the backend's environment" : server.reason });
const stubFetch = async (url, opts = {}) => {
  const u = String(url);
  if (/\/api\/capabilities/.test(u)) return json({ auth: { mode: 'none' }, capabilities: { settings: false } });
  if (/\/api\/settings\/parallel/.test(u)) {
    if (server.down) return json({ error: 'down' }, 500);
    if ((opts.method || 'GET') === 'PUT') {
      const body = JSON.parse(opts.body || '{}');
      server.puts.push(body);
      const w = body.workers;
      if (w !== 'auto' && !(Number.isInteger(w) && w >= 1 && w <= server.cores)) return json({ error: `workers must be from 1 to ${server.cores} (the cores of this machine), or "auto"` }, 400);
      server.value = w;
      return json(view());
    }
    return json(view());
  }
  return json({ error: 'not mocked ' + u }, 404);
};
define('fetch', stubFetch); window.fetch = stubFetch;
const origErr = console.error; console.error = (...a) => { if (/Warning:|act\(|Dexie|Error loading|not mocked|Failed to/.test(String(a[0] ?? ''))) return; origErr(...a); };
console.warn = () => {};
const { PerformanceSettings, SettingsModal, ThemeProvider, NotificationProvider, React, createRoot, act } = createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const root = createRoot(document.getElementById('root'));
const render = async (el) => { await act(async () => { root.render(el); }); await act(async () => { await sleep(40); }); };
const select = async (el, value) => { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new window.Event('change', { bubbles: true })); }); await act(async () => { await sleep(40); }); };
const text = (id) => ($(`[data-testid="${id}"]`)?.textContent || '').trim();

// ---- the real dialog on the desktop (a fake bridge), opened at 'performance'
window.electronAPI = {
  isElectron: true, setZoomFactor: async () => {}, getZoomFactor: async () => 1, setDebugBarEnabled: async () => {}, getDebugBarEnabled: async () => false, onDebugBarChanged: () => () => {},
  getMachineId: async () => 'm', getUsername: async () => 'user', getHostname: async () => 'host', getAppVersion: async () => '0.0.0', getProfileName: async () => 'default',
  homeServerStatus: async () => ({ linked: false }), homeServerVersion: async () => ({ desktop: { app: '0.0.0', protocol: 2 }, server: { reachable: false, linked: false } }),
};
const dialog = (tab) => React.createElement(NotificationProvider, null, React.createElement(ThemeProvider, null, React.createElement(SettingsModal, { key: tab + Math.random(), isOpen: true, onClose: () => {}, initialTab: tab })));
await render(dialog('performance'));
const rail = $$('[data-testid="settings-modal"] .sc-rail-tab').map((t) => t.textContent.trim());
check("the dialog opened at 'performance': Performance in the rail after Theme, its panel shown", rail.join() === 'General,Editor,Theme,Performance,Accessibility,Integrations,AI Providers,Shortcuts,Debug,About' && !!$('[data-testid="performance-section"]'), rail.join());
check('the desktop: "This computer has 12 cores; Auto uses 8." - the backend\'s machine', text('parallel-cores') === 'This computer has 12 cores; Auto uses 8.', text('parallel-cores'));
const opts = $$('[data-testid="parallel-workers"] option').map((o) => `${o.value}=${o.textContent}`);
check('the choices: Auto (8 processes), 1 (off: one process), 2 to 12 processes; Auto selected', opts[0] === 'auto=Auto (8 processes)' && opts[1] === '1=1 (off: one process)' && opts[2] === '2=2 processes' && opts.at(-1) === '12=12 processes' && opts.length === 13 && $('[data-testid="parallel-workers"]').value === 'auto' && !$('[data-testid="parallel-workers"]').disabled, opts.join(' | '));
check('the footer: the tab applies as you make it', /Changes on this tab apply as you make them\./.test(document.body.textContent));
await select($('[data-testid="parallel-workers"]'), '3');
check('a change is sent as {"workers": 3} and confirmed: "the next analysis uses 3 processes"', JSON.stringify(server.puts.at(-1)) === '{"workers":3}' && $('[data-testid="parallel-workers"]').value === '3' && /Saved: the next analysis uses 3 processes\./.test(text('parallel-status')), text('parallel-status'));
await select($('[data-testid="parallel-workers"]'), '1');
check('1: serial ("the next analysis uses 1 process")', server.value === 1 && /uses 1 process\./.test(text('parallel-status')), text('parallel-status'));
await select($('[data-testid="parallel-workers"]'), 'auto');
check('Auto again: sent as {"workers": "auto"}', JSON.stringify(server.puts.at(-1)) === '{"workers":"auto"}' && server.value === 'auto');
server.cores = 2;
await render(dialog('performance'));
check('a 2-core machine: Auto uses 1 (one process)', text('parallel-cores') === 'This computer has 2 cores; Auto uses 1.' && $$('[data-testid="parallel-workers"] option')[0].textContent === 'Auto (1 process)', text('parallel-cores'));
server.cores = 12;

// ---- the panel alone: a refused value, the override, a user who may not change it, the backend down, a browser
await render(React.createElement(PerformanceSettings));
const realCores = server.cores;
server.cores = 2;   // the server now refuses 3
const el = $('[data-testid="parallel-workers"]');
await act(async () => { const o = document.createElement('option'); o.value = '3'; el.appendChild(o); });
await select(el, '3');
check('a value the backend refuses: its message, in the error role', /workers must be from 1 to 2/.test(text('parallel-status')) && $('[data-testid="parallel-status"]')?.getAttribute('role') === 'alert', text('parallel-status'));
server.cores = realCores;
server.override = 5;
await render(null); await render(React.createElement(PerformanceSettings));
check('JACARIUM_WORKERS sets it: the select disabled, "Set to 5 by JACARIUM_WORKERS in the backend\'s environment."', $('[data-testid="parallel-workers"]').disabled && /Set to 5 by JACARIUM_WORKERS in the backend's environment\./.test(text('parallel-cores')), text('parallel-cores'));
server.override = null; server.canChange = false; server.reason = 'only an administrator of this server can change it';
window.electronAPI = undefined;
await render(null); await render(React.createElement(PerformanceSettings));
check('a browser on a server with accounts, not an administrator: "The server has 12 cores", the select disabled, the reason said', $('[data-testid="parallel-workers"]').disabled && text('parallel-cores') === 'The server has 12 cores; Auto uses 8. Only an administrator of this server can change it.', text('parallel-cores'));
server.down = true;
await render(null); await render(React.createElement(PerformanceSettings));
check('the backend does not answer: a note, no control', !!$('[data-testid="parallel-unavailable"]') && !$('[data-testid="parallel-workers"]'));
await render(null);
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
