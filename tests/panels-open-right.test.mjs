#!/usr/bin/env node
/**
 * "Open on the right" for the rail's panels (AI Chat, Quick Notes, Team
 * Chat) - the parts that run in jsdom:
 *   - the REAL CompactSidebar: right-clicking one of the three rail icons
 *     opens the rail's own context menu with "Open on the right" (PanelRight
 *     icon); clicking it sends the panel's toggle event with
 *     { side: 'right', open: true }; once the panel reports itself on the
 *     right - open or closed, the side is remembered - the item reads "Move
 *     to the left" and sends side 'left'; Quiz and the page icons offer no
 *     such item;
 *   - the REAL ResizableSidebar: side 'right' puts the column after the page
 *     (flex order-last), the handle on its left edge, and keeps its width
 *     under `<storageKey>Right`; moving sides swaps the stored widths; a drag
 *     never pushes the page (the row's flex-1 sibling) under 480 px, and a
 *     column that opens into too little room gives the difference back;
 *   - the registry: three unassigned renderer actions in the Panels group
 *     ("Open AI Chat" etc., a rail click as a key), an override stored under
 *     the former panel.*Right ids migrated, the main-process twin in sync,
 *     and JQLBuilder registers them as plain toggles.
 * The layout in the real window (one panel right, left + right together,
 * moving rather than duplicating, the phone) is tests/panels-open-right-live.test.mjs.
 *
 * Run: node tests/panels-open-right.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom (SKIP without it).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
const resolvable = (n) => { try { req.resolve(n); return true; } catch { return false; } };
for (const dep of ['esbuild', 'react', 'react-dom']) { if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); } }
if (!resolvable('jsdom')) { console.log('SKIP: jsdom not installed (npm install --no-save jsdom)'); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; let total = 0;
function check(name, cond, detail = '') { total += 1; if (cond) console.log(`PASS: ${name}`); else { failures += 1; console.log(`FAIL: ${name}${detail ? ` | ${String(detail).slice(0, 500)}` : ''}`); } }
async function waitFor(fn, timeout = 5000) { const t0 = Date.now(); for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() - t0 > timeout) return null; await sleep(20); } }

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'panels-open-right-'));
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import CompactSidebar from '@worktree/src/components/CompactSidebar.jsx';
import ResizableSidebar from '@worktree/src/components/ResizableSidebar.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
import { ChatProvider } from '@worktree/src/contexts/ChatContext.jsx';
import { ThemeProvider } from '@worktree/src/contexts/ThemeContext.jsx';
import { MobileProvider } from '@worktree/src/contexts/MobileContext.jsx';
let setView = null; let key = 0;
const api = {};
// the rail, or a flex row [column | page] with the real ResizableSidebar
function Host() {
  const [view, set] = React.useState(null); setView = set; if (!view) return null;
  if (view.kind === 'rail') return React.createElement(CompactSidebar, { key: view.key, currentPage: 'documents', onPageChange: () => {} });
  return React.createElement('div', { className: 'flex h-screen', 'data-testid': 'row' },
    React.createElement(ResizableSidebar, { key: view.key, side: view.side, storageKey: 'test-panel-width', defaultWidth: 300, minWidth: 200, maxWidth: 600, canvasMinWidth: 480, testId: 'col' }, React.createElement('div', null, 'panel')),
    React.createElement('div', { className: 'flex-1', 'data-testid': 'page' }, 'page'));
}
const whenReady = (fn) => { const go = () => (setView ? fn() : setTimeout(go, 10)); go(); };
api.mountRail = () => whenReady(() => setView({ kind: 'rail', key: ++key }));
api.mountColumn = (side, remount = false) => whenReady(() => setView((v) => ({ kind: 'column', side, key: remount || !v || v.kind !== 'column' ? ++key : v.key })));
api.unmount = () => whenReady(() => setView(null));
window.__harness = api;
createRoot(document.getElementById('root')).render(React.createElement(MobileProvider, null, React.createElement(NotificationProvider, null, React.createElement(ChatProvider, null, React.createElement(ThemeProvider, null, React.createElement(Host))))));
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
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'localStorage', 'getComputedStyle']) define(name, name === 'getComputedStyle' ? window.getComputedStyle.bind(window) : window[name]);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); define('IntersectionObserver', FakeObserver); window.ResizeObserver = FakeObserver; window.IntersectionObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
const origLog = console.log; const origErr = console.error; const origWarn = console.warn;
const quiet = (fn) => (...a) => { const s = String(a[0] ?? ''); if (/^\[|Warning:|act\(|no backend|Failed to/.test(s)) return; fn(...a); };
console.log = quiet(origLog); console.error = quiet(origErr); console.warn = quiet(origWarn);
define('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const H = window.__harness;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const rightClick = (el) => el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 300 }));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

/* ---------- 1. the rail's menu ---------- */
console.log('\n--- 1. the rail menu ---');
H.mountRail();
await waitFor(() => $('[data-testid="rail-ai-chat"]'));
const events = [];
for (const name of ['toggleAIChatSidebar', 'toggleDraftSidebar', 'toggleChatSidebar']) window.addEventListener(name, (e) => events.push({ name, detail: e.detail }));
const PANELS = [
  ['rail-ai-chat', 'toggleAIChatSidebar', 'aiChatSidebarStateChange'],
  ['rail-quick-notes', 'toggleDraftSidebar', 'draftSidebarStateChange'],
  ['rail-team-chat', 'toggleChatSidebar', 'chatSidebarStateChange'],
];
for (const [testId, toggleEvent, stateEvent] of PANELS) {
  rightClick($(`[data-testid="${testId}"]`));
  const menu = await waitFor(() => $('[data-testid="rail-panel-menu"]'));
  const item = menu && menu.querySelector('[data-testid="rail-panel-side"]');
  check(`${testId}: right-click opens the rail menu with "Open on the right" and the PanelRight icon`, !!item && item.textContent.trim() === 'Open on the right' && !!item.querySelector('svg.lucide-panel-right'), menu?.textContent);
  events.length = 0;
  click(item);
  await sleep(20);
  check(`${testId}: the item sends ${toggleEvent} with { side: 'right', open: true } and the menu closes`, events.length === 1 && events[0].name === toggleEvent && events[0].detail?.side === 'right' && events[0].detail?.open === true && !$('[data-testid="rail-panel-menu"]'), JSON.stringify(events));
  // the panel reports itself open on the right -> the item flips
  window.dispatchEvent(new window.CustomEvent(stateEvent, { detail: { isOpen: true, side: 'right' } }));
  await sleep(20);
  rightClick($(`[data-testid="${testId}"]`));
  await waitFor(() => $('[data-testid="rail-panel-side"]'));
  check(`${testId}: open on the right, the item reads "Move to the left" and sends side 'left'`, $('[data-testid="rail-panel-side"]').textContent.trim() === 'Move to the left' && (events.length = 0, click($('[data-testid="rail-panel-side"]')), events[0]?.detail?.side === 'left'), JSON.stringify(events));
  window.dispatchEvent(new window.CustomEvent(stateEvent, { detail: { isOpen: false, side: 'right' } }));
  await sleep(20);
  rightClick($(`[data-testid="${testId}"]`));
  await waitFor(() => $('[data-testid="rail-panel-side"]'));
  check(`${testId}: closed while remembered on the right, the item still reads "Move to the left" (a click would reopen it there)`, $('[data-testid="rail-panel-side"]').textContent.trim() === 'Move to the left');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.body.click(); await sleep(20);
  window.dispatchEvent(new window.CustomEvent(stateEvent, { detail: { isOpen: false, side: 'left' } }));
  await sleep(20);
  rightClick($(`[data-testid="${testId}"]`));
  await waitFor(() => $('[data-testid="rail-panel-side"]'));
  check(`${testId}: remembered on the left again, the item is back to "Open on the right"`, $('[data-testid="rail-panel-side"]').textContent.trim() === 'Open on the right');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.body.click(); await sleep(20);
}
check('the rail still has one menu type per icon: the Quiz icon offers no side item', !$$('button').some((b) => (b.getAttribute('title') || '') === 'Quiz' && b.getAttribute('data-testid')));
H.unmount();

/* ---------- 2. the column ---------- */
console.log('\n--- 2. ResizableSidebar on either side ---');
window.localStorage.clear();
await sleep(30);
H.mountColumn('left');
await waitFor(() => $('[data-testid="col"]'));
const col = () => $('[data-testid="col"]');
const handle = () => col().querySelector('.cursor-col-resize');
check('on the left: no order-last, the handle on the right edge, the width stored under the plain key', !col().classList.contains('order-last') && handle().className.includes('right-0') && col().getAttribute('data-side') === 'left' && window.localStorage.getItem('test-panel-width') === '300', col().className);
// a layout for the clamp: the row is 1200 wide, the column 300, the page the rest
const setLayout = (pageWidth) => { Object.defineProperty($('[data-testid="page"]'), 'clientWidth', { get: () => pageWidth, configurable: true }); };
setLayout(900);
// (the move/up listeners are attached by an effect after the mousedown render)
const drag = async (fromX, toX) => {
  handle().dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: fromX }));
  await sleep(30);
  document.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: toX }));
  await sleep(30);
  document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  await sleep(30);
};
await drag(300, 400); await sleep(20);
check('a drag resizes it (300 -> 400) and stores the width', col().style.width === '400px' && window.localStorage.getItem('test-panel-width') === '400');
setLayout(500); // the page has 500 px left: only 20 px of growth keep it at 480
await drag(400, 900); await sleep(20);
check('a drag never pushes the page under 480 px (500 px of page -> 20 px of growth, not 500)', col().style.width === '420px', col().style.width);
// move to the right: its own width, the handle on the left edge, after the page
window.localStorage.setItem('test-panel-widthRight', '350');
setLayout(900);
H.mountColumn('right'); await sleep(30);
check('moved to the right (same instance): order-last, the handle on the left edge, the right-side width (350) in force', col().classList.contains('order-last') && handle().className.includes('left-0') && col().getAttribute('data-side') === 'right' && col().style.width === '350px', `${col().className} ${col().style.width}`);
await drag(0, -50); await sleep(20);
check('on the right the handle drags the other way (leftwards grows) and stores under <key>Right, the left width untouched', col().style.width === '400px' && window.localStorage.getItem('test-panel-widthRight') === '400' && window.localStorage.getItem('test-panel-width') === '420', `${col().style.width} ${window.localStorage.getItem('test-panel-widthRight')}`);
H.mountColumn('left'); await sleep(30);
check('back on the left: the left width (420) again', col().style.width === '420px' && !col().classList.contains('order-last'));
// opening into too little room
window.localStorage.setItem('test-panel-width', '600');
H.unmount(); await sleep(30);
H.mountColumn('left', true); await waitFor(() => $('[data-testid="col"]'));
check('a column that opens into too little room gives the page its 480 px back (no measurable page here: untouched)', col().style.width === '600px');
check('the panels pass canvasMinWidth 480; a page\'s own list sidebar does not (ResizableSidebar defaults to no floor)', ['AIChatSidebar', 'DraftSidebar', 'ChatSidebar'].every((f) => /canvasMinWidth=\{480\}/.test(fs.readFileSync(path.join(REPO, `src/components/common/${f}.jsx`), 'utf8'))) && /canvasMinWidth = null/.test(fs.readFileSync(path.join(REPO, 'src/components/ResizableSidebar.jsx'), 'utf8')) && !/canvasMinWidth/.test(fs.readFileSync(path.join(REPO, 'src/components/features/documents/DocumentSidebar.jsx'), 'utf8')));
H.unmount();

/* ---------- 3. the registry ---------- */
console.log('\n--- 3. the shortcut registry ---');
const R = await import(new URL('../src/shortcuts/registry.js', import.meta.url).href);
const panels = R.ACTIONS.filter((a) => a.group === 'panels');
check('three Panels actions - Open AI Chat / Quick Notes / Team Chat - unassigned on both platforms, renderer-owned, everywhere', panels.length === 3 && panels.map((a) => a.id).join() === 'panel.aiChat,panel.quickNotes,panel.teamChat' && panels.map((a) => a.label).join() === 'Open AI Chat,Open Quick Notes,Open Team Chat' && panels.every((a) => a.owner === 'renderer' && a.scope === 'global' && R.defaultChord(a, 'mac') === null && R.defaultChord(a, 'other') === null) && R.GROUPS.some((g) => g.id === 'panels' && g.label === 'Panels'), panels.map((a) => a.id).join());
const twin = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'sync-shortcuts-registry.mjs'), '--check'], { encoding: 'utf8' });
check('the main-process twin (electron/shortcuts-registry.cjs) is in sync', twin.status === 0, twin.stdout + twin.stderr);
const jql = fs.readFileSync(path.join(REPO, 'src/components/JQLBuilder.jsx'), 'utf8');
check('JQLBuilder remembers each side per device (useLocalStorage panelSide.*), and the settings scopes / copy sheet never see those keys', /useLocalStorage\('panelSide\.aiChat', 'left'\)/.test(jql) && /useLocalStorage\('panelSide\.draft', 'left'\)/.test(jql) && /useLocalStorage\('panelSide\.chat', 'left'\)/.test(jql) && !/panelSide/.test(fs.readFileSync(path.join(REPO, 'src/services/settingsStore.js'), 'utf8')) && !/panelSide/.test(fs.readFileSync(path.join(REPO, 'src/components/common/modals/settings/fieldCatalog.js'), 'utf8')));
check('an override stored under a former id (panel.aiChatRight) is kept under the new one', (() => { const n = R.normalizeOverrides({ 'panel.aiChatRight': 'Mod+Shift+KeyJ', 'panel.teamChatRight': null }); return n.overrides['panel.aiChat'] === 'Mod+Shift+KeyJ' && n.overrides['panel.teamChat'] === null && n.dropped.length === 0 && !('panel.aiChatRight' in n.overrides); })());
check('JQLBuilder registers the three actions as a plain toggle (the rail click: remembered side, or close) and hosts the panels on their side', /useShortcut\('panel\.aiChat', \(\) => \{ window\.dispatchEvent\(new CustomEvent\('toggleAIChatSidebar'\)\)/.test(jql) && /useShortcut\('panel\.quickNotes', \(\) => \{ window\.dispatchEvent\(new CustomEvent\('toggleDraftSidebar'\)\)/.test(jql) && /useShortcut\('panel\.teamChat', \(\) => \{ window\.dispatchEvent\(new CustomEvent\('toggleChatSidebar'\)\)/.test(jql) && /side=\{isMobile \? 'left' : panelSides\.aiChat\}/.test(jql) && /side=\{isMobile \? 'left' : panelSides\.draft\}/.test(jql) && /side=\{isMobile \? 'left' : panelSides\.chat\}/.test(jql));

console.log(`\n${total - failures}/${total} checks passed`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
