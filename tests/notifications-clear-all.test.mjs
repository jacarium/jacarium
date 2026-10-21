#!/usr/bin/env node
/**
 * The bell in the compact rail (src/components/CompactSidebar.jsx): a
 * right-click opens the rail's context menu (the same one the page icons use
 * for "Open in External Window") with "Clear All Notifications"; it asks
 * first (ConfirmationModal) and then removes every notification and the
 * badge (NotificationContext.clearHistory - the same handler the
 * notification sidebar's bin uses). Cancel changes nothing; the item is
 * disabled with nothing to clear; a plain click on the bell still toggles
 * the Notifications sidebar; the other rail icons keep their own menu. The
 * history lives in the provider's memory only (not persisted, not synced),
 * so a reload starts empty by construction - checked here by remounting.
 * Run: node tests/notifications-clear-all.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
function resolvable(name) { try { req.resolve(name); return true; } catch { return false; } }
for (const dep of ['esbuild', 'dexie', 'react', 'react-dom']) { if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); } }
for (const dep of ['fake-indexeddb', 'jsdom']) { if (!resolvable(dep)) { console.log(`SKIP: test-only dependency "${dep}" not installed`); process.exit(0); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; let total = 0;
const report = console.log;
function check(name, cond, detail = '') { total += 1; if (cond) report(`PASS: ${name}`); else { failures += 1; report(`FAIL: ${name}${detail ? ` | ${String(detail).slice(0, 500)}` : ''}`); } }
async function waitFor(fn, timeout = 5000) { const t0 = Date.now(); for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() - t0 > timeout) return null; await sleep(20); } }

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'notifications-clear-'));
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import CompactSidebar from '@worktree/src/components/CompactSidebar.jsx';
import { NotificationProvider, useNotifications } from '@worktree/src/contexts/NotificationContext.jsx';
import { ChatProvider } from '@worktree/src/contexts/ChatContext.jsx';
import { ThemeProvider } from '@worktree/src/contexts/ThemeContext.jsx';
let setView = null; let key = 0;
const api = {};
function Probe() { const n = useNotifications(); api.addNotification = n.addNotification; api.history = () => n.history; return null; }
function Host() { const [view, set] = React.useState(null); setView = set; if (!view) return null; return React.createElement(React.Fragment, null, React.createElement(Probe), React.createElement(CompactSidebar, { key: view.key, currentPage: 'documents', onPageChange: () => {} })); }
const whenReady = (fn) => { const go = () => (setView ? fn() : setTimeout(go, 10)); go(); };
api.mount = () => whenReady(() => setView({ key: ++key })); api.unmount = () => whenReady(() => setView(null));
window.__harness = api;
createRoot(document.getElementById('root')).render(React.createElement(NotificationProvider, null, React.createElement(ChatProvider, null, React.createElement(ThemeProvider, null, React.createElement(Host)))));
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.mp3': 'dataurl', '.wav': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' }, resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }], logLevel: 'warning',
});
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'localStorage', 'sessionStorage', 'Audio']) define(name, window[name]);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); define('IntersectionObserver', FakeObserver); window.ResizeObserver = FakeObserver; window.IntersectionObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {}; window.HTMLElement.prototype.scrollTo = function () {};
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
if (!window.Audio) window.Audio = class { play() { return Promise.resolve(); } pause() {} load() {} };
const failingFetch = () => Promise.reject(new Error('no backend in test'));
define('fetch', failingFetch); window.fetch = failingFetch;
const origLog = console.log; const origErr = console.error; const origWarn = console.warn;
const quiet = (fn) => (...a) => { const s = String(a[0] ?? ''); if (/^\[|^===|Warning:|act\(|Dexie|Error|no backend|Audio|Not implemented/.test(s)) return; fn(...a); };
console.log = quiet(origLog); console.error = quiet(origErr); console.warn = quiet(origWarn);
createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const H = window.__harness;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const rightClick = (el) => el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 700 }));
const bell = () => $('[data-testid="rail-notifications"]');
const badge = () => bell()?.querySelector('span.bg-purple-500');
const events = [];
window.addEventListener('toggleNotificationSidebar', () => events.push('toggle'));
H.mount();
await waitFor(() => bell());
await sleep(100);

report('\n--- the bell ---');
rightClick(bell());
let menu = await waitFor(() => $('[data-testid="rail-notifications-menu"]'));
check('a right-click on the bell opens the rail context menu with "Clear All Notifications", disabled while there is nothing to clear', !!menu && /Clear All Notifications/.test(menu.textContent) && $('[data-testid="rail-clear-notifications"]').disabled === true && !/Open in External Window|Open in New Tab/.test(menu.textContent));
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await waitFor(() => (!$('[data-testid="rail-notifications-menu"]') ? true : null));
H.addNotification({ type: 'info', title: 'Deploy done', message: 'checkout rolled out' });
H.addNotification({ type: 'warning', title: 'Sync', message: 'retrying' });
await waitFor(() => badge());
check('two notifications: the badge shows', !!badge() && H.history().length === 2);
rightClick(bell());
menu = await waitFor(() => $('[data-testid="rail-notifications-menu"]'));
check('the item is enabled now, with the menu\'s icon style (lucide Trash2, 14px, secondary colour)', !!menu && $('[data-testid="rail-clear-notifications"]').disabled === false && !!$('[data-testid="rail-clear-notifications"] svg.lucide-trash-2.text-os-text-secondary'));
click($('[data-testid="rail-clear-notifications"]'));
const confirmBtn = await waitFor(() => $$('button').find((b) => b.textContent.trim() === 'Clear all'));
check('it asks "Clear all notifications?" (2 will be removed), the menu closed', !!confirmBtn && /Clear all notifications\?/.test(document.body.textContent) && /2 notifications will be removed/.test(document.body.textContent) && !$('[data-testid="rail-notifications-menu"]'));
click($$('button').find((b) => b.textContent.trim() === 'Cancel'));
await sleep(50);
check('Cancel changes nothing', H.history().length === 2 && !!badge() && !$$('button').some((b) => b.textContent.trim() === 'Clear all'));
rightClick(bell()); await waitFor(() => $('[data-testid="rail-notifications-menu"]'));
click($('[data-testid="rail-clear-notifications"]'));
click(await waitFor(() => $$('button').find((b) => b.textContent.trim() === 'Clear all')));
await waitFor(() => (H.history().length === 0 ? true : null));
check('confirming empties the list and the badge', H.history().length === 0 && !badge());
H.unmount(); await sleep(50); H.mount(); await waitFor(() => bell());
check('after a remount (a reload: the history is in memory only, nothing is persisted or synced) it stays empty', H.history().length === 0 && !badge());
events.length = 0;
click(bell());
check('a plain click on the bell still toggles the Notifications sidebar', events.includes('toggle'));

report('\n--- the other icons ---');
const other0 = $$('button').find((b) => /\b(Calendars|Robin|Kanban|Tasks)\b/.test(b.textContent) && b !== bell() && !b.closest('[data-testid="rail-notifications-menu"]'));
rightClick(other0);
const other = await waitFor(() => $$('button').find((b) => /Open in External Window|Open in New Tab/.test(b.textContent)));
check('a page icon keeps its own menu (Open in External Window / New Tab) without the clear item', !!other && !$('[data-testid="rail-notifications-menu"]') && !/Clear All Notifications/.test(other.closest('div').textContent));
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const src = fs.readFileSync(path.join(REPO, 'src/components/CompactSidebar.jsx'), 'utf8');
check('the bell\'s menu reuses the rail menu mechanism (useContextMenu, the same classes) and the shared clearHistory handler', /isContextMenuType\('notifications'\)/.test(src) && /openContextMenu\(e, item\.contextMenu\)/.test(src) && /onConfirm=\{\(\) => \{ clearHistory\(\);/.test(src));
check('NotificationContext keeps the history in memory only (no persistence, nothing to sync)', !/localStorage|indexedDB|fetch\(/.test(fs.readFileSync(path.join(REPO, 'src/contexts/NotificationContext.jsx'), 'utf8')));

report(`\n${total - failures}/${total} checks passed`);
H.unmount();
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
