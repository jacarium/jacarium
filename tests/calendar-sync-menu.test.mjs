#!/usr/bin/env node
/**
 * "Sync active calendar" lives in the Calendars sidebar's hamburger menu,
 * not in its header.
 *
 * No sidebar header carries a sync/refresh button any more (the Documents
 * sidebar set the pattern: its header keeps the central-server status dot,
 * the actions are in the menu). The Calendars header used to have a
 * RefreshCw button for the active calendar - emptied by the "text buttons
 * and menus: text only" clean-up, then dropped on purpose: the action moved
 * into the menu opened by the header's Menu button, under the "New ..."
 * items, disabled and reading "Syncing..." while a sync runs.
 *
 * Proved with the REAL CalendarSidebar mounted in jsdom:
 *   1. the header has the title, the status dot and the Menu button, and no
 *      button named or titled "Sync active calendar";
 *   2. the menu opened from the header lists New Event, Add Calendar, then
 *      "Sync active calendar"; clicking it calls onSyncCalendar once and
 *      closes the menu;
 *   3. while isSyncing the item reads "Syncing..." and is disabled: a click
 *      does not call onSyncCalendar;
 *   4. the Documents sidebar header (source) has no sync/refresh button
 *      either.
 *
 * Run:  node tests/calendar-sync-menu.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom
 *   (prints "SKIP:" and exits 0 when the test-only dep is missing)
 * Exit code 0 = all checks passed (or skipped), 1 = failure.
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
for (const dep of ['esbuild', 'react', 'react-dom']) {
  if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); }
}
if (!resolvable('jsdom')) { console.log('SKIP: test-only dependency "jsdom" not installed (npm install --no-save jsdom)'); process.exit(0); }

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-sync-menu-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; let total = 0;
const report = console.log;
function check(name, cond, detail = '') {
  total += 1;
  if (cond) report(`PASS: ${name}`);
  else { failures += 1; report(`FAIL: ${name}${detail ? ` | ${String(detail).slice(0, 400)}` : ''}`); }
}
async function waitFor(fn, timeout = 5000) {
  const t0 = Date.now();
  for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() - t0 > timeout) return null; await sleep(20); }
}

// ---------- source: the Documents header ----------
const docs = fs.readFileSync(path.join(REPO, 'src/components/features/documents/DocumentSidebar.jsx'), 'utf8');
const docsHeader = (docs.match(/<SidebarHeader[\s\S]*?\n      \/>/) || [''])[0];
check('the Documents sidebar header has no sync/refresh button (status dot kept)', docsHeader.length > 0 && !/[Ss]ync|[Rr]efresh/.test(docsHeader) && /status=\{centralServerStatus\}/.test(docsHeader));

// ---------- bundle ----------
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import CalendarSidebar from '@worktree/src/components/features/calendars/CalendarSidebar.jsx';
let setView = null; let key = 0;
function Host() {
  const [view, set] = React.useState(null);
  setView = set;
  if (!view) return null;
  return React.createElement(CalendarSidebar, { key: view.key, ...view.props });
}
// the root renders asynchronously: a mount before the first render waits for it
const whenMounted = (fn) => { const go = () => (setView ? fn() : setTimeout(go, 10)); go(); };
window.__harness = { mount: (props) => whenMounted(() => setView({ props, key: ++key })), unmount: () => whenMounted(() => setView(null)) };
createRoot(document.getElementById('root')).render(React.createElement(Host));
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
  nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (args) => ({ path: path.join(REPO, args.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => { if (isBuiltin(args.path)) return { path: args.path, external: true }; try { return { path: req.resolve(args.path) }; } catch { return null; } });
  } }],
  logLevel: 'warning',
});

// ---------- jsdom ----------
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'localStorage', 'sessionStorage']) define(name, window[name]);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); window.ResizeObserver = FakeObserver;
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
const origErr = console.error; console.error = (...a) => { if (/Warning:|act\(/.test(String(a[0] ?? ''))) return; origErr(...a); };
createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const H = window.__harness;
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const buttons = () => Array.from(document.querySelectorAll('button'));
const menuItem = () => buttons().find((b) => /^(Sync active calendar|Syncing…)$/.test(b.textContent.trim())) || null;

/* ---------- 1. the header ---------- */
let synced = 0;
const props = { calendars: [{ id: 'cal-1', summary: 'Team calendar', backgroundColor: '#4285f4' }], activeTab: 'cal-1', syncStatus: 'online', onSyncCalendar: () => { synced += 1; }, onNewEvent: () => {}, onAddCalendar: () => {} };
H.mount(props);
const menuBtn = await waitFor(() => document.querySelector('button[aria-label="Menu"]'));
check('the header shows the Calendars title, the status dot and the Menu button', !!menuBtn && /Calendars/.test(document.body.textContent) && !!document.querySelector('[title="Google Calendar synced"]'), document.body.innerHTML.slice(0, 300));
check('the header has no "Sync active calendar" button (no button named or titled so, no RefreshCw icon)',
  !buttons().some((b) => /Sync active calendar/.test(b.getAttribute('aria-label') || '') || /Sync active calendar/.test(b.getAttribute('title') || '')) && !document.querySelector('svg.lucide-refresh-cw'));
check('before the menu opens there is no sync item', menuItem() === null);

/* ---------- 2. the menu item ---------- */
click(menuBtn);
const item = await waitFor(menuItem);
check('the menu opened from the header lists "Sync active calendar"', !!item && item.textContent.trim() === 'Sync active calendar' && !item.disabled, item ? item.outerHTML.slice(0, 200) : 'no item');
const labels = buttons().map((b) => b.textContent.trim()).filter((t) => /^(New Event|Add Calendar|Sync active calendar)$/.test(t));
check('it sits under the "New ..." items: New Event, Add Calendar, Sync active calendar', labels.join(' | ') === 'New Event | Add Calendar | Sync active calendar', labels.join(' | '));
if (item) click(item);
await sleep(50);
check('clicking it calls onSyncCalendar once and closes the menu', synced === 1 && menuItem() === null, `synced=${synced} itemStill=${!!menuItem()}`);

/* ---------- 3. while syncing ---------- */
H.unmount();
await waitFor(() => (document.querySelector('button[aria-label="Menu"]') ? null : true));
H.mount({ ...props, isSyncing: true, syncStatus: 'checking' });
const menuBtn2 = await waitFor(() => document.querySelector('button[aria-label="Menu"]'));
click(menuBtn2);
const busy = await waitFor(menuItem);
check('while syncing the item reads "Syncing..." and is disabled', !!busy && busy.textContent.trim() === 'Syncing…' && busy.disabled, busy ? busy.outerHTML.slice(0, 200) : 'no item');
if (busy) click(busy);
await sleep(50);
check('a click on the disabled item does not call onSyncCalendar', synced === 1, synced);
check('the header still has no sync button while syncing (status dot reads syncing)', !buttons().some((b) => /Sync active calendar/.test(b.getAttribute('aria-label') || '')) && !!document.querySelector('[title="Syncing Google Calendar..."]'));

report(`\n${total - failures}/${total} checks passed`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
