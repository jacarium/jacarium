#!/usr/bin/env node
/**
 * Settings > Shortcuts (src/components/common/modals/settings/
 * ShortcutsSettings.jsx, ShortcutRecorder.jsx; src/shortcuts/store.js): the
 * REAL Settings dialog in jsdom, first as a signed-in browser (localStorage
 * storage), then with a mocked desktop bridge (the main process's
 * getShortcuts / setShortcuts), then on a phone.
 *   1. the tab is in the rail; the list shows every group with the bound
 *      chords (Ctrl labels on a mocked Linux), Unassigned rows, fixed rows
 *      without Change; a browser hides the desktop-only menu actions; the
 *      search filters; the group tabs filter;
 *   2. Change opens the recorder: held modifiers preview, a chord is
 *      recorded and Use binds it (the row, the kbd, localStorage with the
 *      schema version and only the override), the keydown reaches no
 *      shortcut handler meanwhile; Esc cancels; Backspace clears;
 *   3. conflicts: a chord another action holds offers Replace and
 *      replacing unassigns the other; an OS-reserved chord is blocked
 *      (Alt+F4 on Linux); a browser-reserved chord is blocked in the web
 *      build (Ctrl+T); a Linux habit warns (Ctrl+Shift+C) and can be used
 *      anyway; a plain letter for an editor action is blocked;
 *   4. x unassigns; Reset one restores the default; Reset all (confirmed)
 *      clears every override; a bad stored value is dropped on load;
 *   5. a mocked Mac shows ⌘⌥⇧ labels; the desktop bridge: the list shows
 *      the menu actions, a change goes through setShortcuts and a refusal
 *      shows its reason, the broadcast updates the list;
 *   6. a phone has no Shortcuts tab;
 *   7. the shortcuts never travel in a settings payload (source + mocks).
 * Needs jsdom + fake-indexeddb (npm install --no-save jsdom fake-indexeddb).
 * Run: node tests/shortcuts-settings-ui.test.mjs
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
for (const dep of ['esbuild', 'react', 'react-dom', 'dexie']) { if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); } }
for (const dep of ['jsdom', 'fake-indexeddb']) { if (!resolvable(dep)) { console.log(`SKIP: test-only dependency "${dep}" not installed`); process.exit(0); } }

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shortcuts-settings-ui-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = console.log;
let failures = 0; let total = 0;
function check(name, cond, detail = '') { total += 1; if (cond) report(`PASS: ${name}`); else { failures += 1; report(`FAIL: ${name}${detail ? ` | ${String(detail).slice(0, 500)}` : ''}`); } }
async function waitFor(fn, timeout = 6000) { const t0 = Date.now(); for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() - t0 > timeout) return null; await sleep(20); } }

const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import SettingsModal from '@worktree/src/components/common/modals/SettingsModal.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
import { ThemeProvider } from '@worktree/src/contexts/ThemeContext.jsx';
import { initializePlatform } from '@worktree/src/utils/platform.js';
import * as store from '@worktree/src/shortcuts/store.js';
import { useShortcut } from '@worktree/src/shortcuts/useShortcut.js';
import DocumentEditorProbe from '@worktree/src/shortcuts/PageShortcuts.jsx';
let setView = null; let key = 0;
const fired = [];
function Probe() { useShortcut('editor.find', () => { fired.push('editor.find'); }); useShortcut('app.palette', () => { fired.push('app.palette'); }); return React.createElement('textarea', { className: 'sc-editor-textarea', 'data-testid': 'probe-editor' }); }
function Host() {
  const [view, set] = React.useState(null);
  setView = set;
  if (!view) return null;
  return React.createElement(React.Fragment, null, React.createElement(Probe), React.createElement(SettingsModal, { key: view.key, isOpen: true, onClose: () => {}, initialTab: view.tab || 'shortcuts' }));
}
const whenReady = (fn) => { const go = () => (setView ? fn() : setTimeout(go, 10)); go(); };
window.__harness = { mount: (opts = {}) => whenReady(() => setView({ ...opts, key: ++key })), unmount: () => whenReady(() => setView(null)), initializePlatform, store, fired, DocumentEditorProbe };
createRoot(document.getElementById('root')).render(React.createElement(NotificationProvider, null, React.createElement(ThemeProvider, null, React.createElement(Host))));
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }], logLevel: 'warning',
});

await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'DOMParser']) define(key, window[key]);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); window.ResizeObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {};
let viewportMatches = false;   // the phone media query
window.matchMedia = (q) => ({ matches: /max-width|pointer: coarse/.test(q) ? viewportMatches : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
const setPlatform = (p) => { Object.defineProperty(window.navigator, 'platform', { value: p, configurable: true }); Object.defineProperty(window.navigator, 'userAgentData', { value: undefined, configurable: true }); };
setPlatform('Linux x86_64');

// a signed-in browser backend
const capabilities = { auth: { mode: 'accounts', user: { id: 'u1', username: 'alice', displayName: 'Alice', role: 'user' }, admin: false }, capabilities: { settings: true } };
const accountSettings = { values: { DEFAULT_AI_PROVIDER: 'ollama' }, secrets: {}, inherited: {}, revision: 1, revisions: {} };
const payloads = [];
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const stubFetch = async (url, init = {}) => {
  const u = String(url); const method = init.method || 'GET';
  if (init.body) payloads.push(init.body);
  if (/\/api\/capabilities/.test(u)) return json(capabilities);
  if (/\/api\/ai\/models/.test(u)) return json({ anthropic: [], openai: [], gemini: [], ollama: ['qwen3'], defaults: { provider: 'ollama', model: 'qwen3' } });
  if (/\/api\/auth\/me/.test(u)) return json({ user: capabilities.auth.user });
  if (/\/api\/settings$/.test(u)) return json(method === 'PUT' ? { ok: true, ...accountSettings } : accountSettings);
  if (/\/api\/sync\/status/.test(u)) return json({ enabled: true, settingsRevision: 1 });
  return json({ error: 'not mocked ' + u }, 404);
};
define('fetch', stubFetch); window.fetch = stubFetch;
const origErr = console.error; console.error = (...a) => { if (/Warning:|act\(|Dexie|Error loading|not mocked/.test(String(a[0] ?? ''))) return; origErr(...a); };
const origLog = console.log; console.log = (...a) => { if (/^(PASS|FAIL|SKIP|\n|---)/.test(String(a[0] ?? ''))) origLog(...a); };
console.warn = () => {};

createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const H = window.__harness;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const keydown = (el, init) => { const e = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); el.dispatchEvent(e); return e; };
const setNative = (el, value) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const stored = () => { try { return JSON.parse(window.localStorage.getItem('jacarium.shortcuts')); } catch { return null; } };
async function open(tab = 'shortcuts') {
  H.unmount(); await waitFor(() => (!$('[data-testid="settings-modal"]') ? true : null));
  H.mount({ tab });
  await waitFor(() => $('[data-testid="settings-modal"]'));
  await sleep(150);
}
const chordText = (id) => $(`[data-testid="shortcut-chord-${id}"]`)?.textContent.trim();
const rowIds = () => $$('[data-testid^="shortcut-row-"]').map((r) => r.getAttribute('data-testid').slice(13));
const recorder = () => $('[data-testid="shortcut-recorder"]');
async function record(id, init) {
  click($(`[data-testid="shortcut-change-${id}"]`));
  const rec = await waitFor(recorder);
  if (!rec) return null;
  keydown(rec, init);
  await sleep(30);
  return rec;
}

await H.initializePlatform();

/* 1. the list in a browser on Linux */
report('\n--- 1. the tab and the list (browser, Linux) ---');
await open('shortcuts');
const rail = () => $$('[data-testid="settings-modal"] .sc-rail-tab').map((t) => t.textContent.trim());
check('the rail offers Shortcuts after AI Providers', rail().join() === 'General,Integrations,AI Providers,Shortcuts,About', rail().join());
const section = await waitFor(() => $('[data-testid="shortcuts-settings"]'));
check('the Shortcuts section renders, stored on this browser', !!section && /stored on this device \(this browser\)/.test(section.textContent));
check('the groups App, Pages, Editor, Workflow, JQL are listed', ['app', 'pages', 'editor', 'workflow', 'jql'].every((g) => $(`[data-testid="shortcuts-section-${g}"]`)));
check('Linux labels: Find Ctrl+F, Italic Ctrl+I, Find in files Ctrl+Shift+F, palette Ctrl+K, Open in Jira Ctrl+Enter, Redo Ctrl+Shift+Z or Ctrl+Y', chordText('editor.find') === 'Ctrl+F' && chordText('editor.italic') === 'Ctrl+I' && chordText('app.findInFiles') === 'Ctrl+Shift+F' && chordText('app.palette') === 'Ctrl+K' && chordText('jql.openInJira') === 'Ctrl+Enter' && chordText('workflow.redo') === 'Ctrl+Shift+Z' && /or Ctrl\+Y/.test($('[data-testid="shortcut-row-workflow.redo"]').textContent), [chordText('editor.find'), chordText('app.findInFiles'), chordText('jql.openInJira')].join());
check('Bold, Insert link, Find and replace and every Open <page> read Unassigned with a Change button and no x', ['editor.bold', 'editor.insertLink', 'editor.replace', 'page.calendars', 'page.documents'].every((id) => chordText(id) === 'Unassigned' && $(`[data-testid="shortcut-change-${id}"]`) && !$(`[data-testid="shortcut-unassign-${id}"]`)));
check('Indent / Outdent list item are fixed: Tab / Shift+Tab, "fixed", no Change', chordText('editor.indent') === 'Tab' && chordText('editor.outdent') === 'Shift+Tab' && $('[data-testid="shortcut-fixed-editor.indent"]') && !$('[data-testid="shortcut-change-editor.indent"]'));
check('a browser lists no desktop-only menu action (Settings, Toggle sidebar, zoom, Reload)', !rowIds().some((id) => /^app\.(settings|toggleSidebar|zoom|reload|forceReload|fullscreen)/.test(id)) && rowIds().length === 24, rowIds().join());
check('rows name their scope', /When the document editor has focus/.test($('[data-testid="shortcut-row-editor.find"]').textContent) && /On the workflow canvas/.test($('[data-testid="shortcut-row-workflow.fit"]').textContent));
setNative($('[data-testid="shortcuts-search"]'), 'find'); await sleep(50);
check('the search filters by label and chord ("find": Find in document, Find and replace, Find in files)', rowIds().sort().join() === 'app.findInFiles,editor.find,editor.replace', rowIds().join());
setNative($('[data-testid="shortcuts-search"]'), 'zzz'); await sleep(50);
check('no match says so', !!$('[data-testid="shortcuts-empty"]'));
setNative($('[data-testid="shortcuts-search"]'), ''); await sleep(50);
click($('[data-testid="shortcuts-group-editor"]')); await sleep(50);
check('the Editor group tab shows the editor rows only', rowIds().every((id) => id.startsWith('editor.')) && rowIds().length === 7, rowIds().join());
click($$('[data-testid="shortcuts-settings"] [role="tab"]').find((t) => t.textContent.trim() === 'All')); await sleep(50);
check('Reset all is disabled with nothing overridden', $('[data-testid="shortcuts-reset-all"]').disabled === true);

/* 2. the recorder */
report('\n--- 2. the recorder ---');
let rec = await record('editor.find', { key: 'Control', code: 'ControlLeft', ctrlKey: true });
check('Change opens the recorder (a dialog of its own over Settings) naming the action; a held modifier previews', !!rec && rec.getAttribute('aria-modal') === 'true' && /Press the new shortcut for "Find in document"/.test(rec.textContent) && $('[data-testid="recorder-preview"]').textContent.trim() === 'Ctrl' && !$('[data-testid="settings-modal"]').contains(rec), $('[data-testid="recorder-preview"]')?.textContent);
H.fired.length = 0;
const ev = keydown(rec, { key: 'j', code: 'KeyJ', ctrlKey: true }); await sleep(30);
check('Ctrl+J is recorded (preview Ctrl+J, Use enabled), consumed, and no shortcut handler fired while recording', $('[data-testid="recorder-preview"]').textContent.trim() === 'Ctrl+J' && !$('[data-testid="recorder-use"]').disabled && ev.defaultPrevented && H.fired.length === 0, `${$('[data-testid="recorder-preview"]').textContent} fired=${H.fired.join()}`);
check('...and the Use button took focus (Enter confirms)', document.activeElement === $('[data-testid="recorder-use"]'), document.activeElement?.outerHTML?.slice(0, 80));
click($('[data-testid="recorder-use"]'));
await waitFor(() => (chordText('editor.find') === 'Ctrl+J' ? true : null));
check('Use binds it: the row reads Ctrl+J, the recorder is gone, a Reset appears, Reset all is enabled', chordText('editor.find') === 'Ctrl+J' && !recorder() && !!$('[data-testid="shortcut-reset-editor.find"]') && !$('[data-testid="shortcuts-reset-all"]').disabled);
check('localStorage holds { version: 1, overrides: { "editor.find": "Mod+KeyJ" } } - only the override, by physical key', JSON.stringify(stored()) === JSON.stringify({ version: 1, overrides: { 'editor.find': 'Mod+KeyJ' } }), JSON.stringify(stored()));
// the new chord works, the old one does not (the probe textarea has the editor scope)
H.fired.length = 0;
const probe = $('[data-testid="probe-editor"]'); probe.focus();
keydown(probe, { key: 'j', code: 'KeyJ', ctrlKey: true }); keydown(probe, { key: 'f', code: 'KeyF', ctrlKey: true });
check('a rebinding is live: Ctrl+J fires editor.find in the editor, Ctrl+F no longer does', H.fired.join() === 'editor.find', H.fired.join());
rec = await record('editor.italic', { key: 'Escape', code: 'Escape' }); await sleep(30);
check('Esc cancels the recorder, the binding stays and the Settings dialog stays open', !recorder() && chordText('editor.italic') === 'Ctrl+I' && !!$('[data-testid="settings-modal"]'));
rec = await record('editor.italic', { key: 'Backspace', code: 'Backspace' });
await waitFor(() => (chordText('editor.italic') === 'Unassigned' ? true : null));
check('Backspace clears the binding (Unassigned, stored as null)', chordText('editor.italic') === 'Unassigned' && stored().overrides['editor.italic'] === null, JSON.stringify(stored()));

/* 3. conflicts and reserved chords */
report('\n--- 3. conflicts ---');
rec = await record('editor.bold', { key: 'j', code: 'KeyJ', ctrlKey: true });
check('a chord another action holds (Ctrl+J = Find in document) offers Replace', !!$('[data-testid="recorder-conflict"]') && /Ctrl\+J is Find in document/.test($('[data-testid="recorder-conflict"]').textContent) && /^Replace Find in document$/.test($('[data-testid="recorder-use"]').textContent.trim()), $('[data-testid="recorder-use"]')?.textContent);
click($('[data-testid="recorder-use"]'));
await waitFor(() => (chordText('editor.bold') === 'Ctrl+J' ? true : null));
check('Replace binds Bold and unassigns Find in document', chordText('editor.bold') === 'Ctrl+J' && chordText('editor.find') === 'Unassigned' && stored().overrides['editor.find'] === null && stored().overrides['editor.bold'] === 'Mod+KeyJ', JSON.stringify(stored()));
rec = await record('page.calendars', { key: 'F4', code: 'F4', altKey: true });
check('Alt+F4 (Linux desktop) is blocked with the reason, Use disabled', !!$('[data-testid="recorder-blocked"]') && /belongs to the desktop/.test($('[data-testid="recorder-blocked"]').textContent) && $('[data-testid="recorder-use"]').disabled, $('[data-testid="recorder-blocked"]')?.textContent);
keydown(rec, { key: 't', code: 'KeyT', ctrlKey: true }); await sleep(30);
check('Ctrl+T in a browser is blocked (the browser keeps it)', /belongs to the browser/.test($('[data-testid="recorder-blocked"]')?.textContent || '') && $('[data-testid="recorder-use"]').disabled);
keydown(rec, { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }); await sleep(30);
check('Ctrl+Shift+C in a browser is blocked (Chrome\'s inspect) - the Linux-habit warning is the desktop\'s case', /belongs to the browser/.test($('[data-testid="recorder-blocked"]')?.textContent || ''));
keydown(rec, { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }); await sleep(30);
check('Ctrl+Shift+V on Linux warns (paste in terminals) and can be used anyway', !!$('[data-testid="recorder-warning"]') && /paste in Linux terminals/.test($('[data-testid="recorder-warning"]').textContent) && /Use Ctrl\+Shift\+V anyway/.test($('[data-testid="recorder-use"]').textContent) && !$('[data-testid="recorder-use"]').disabled, $('[data-testid="recorder-warning"]')?.textContent || $('[data-testid="recorder-blocked"]')?.textContent);
click($('[data-testid="recorder-use"]'));
await waitFor(() => (chordText('page.calendars') === 'Ctrl+Shift+V' ? true : null));
check('...and binds Open Calendars', chordText('page.calendars') === 'Ctrl+Shift+V');
rec = await record('editor.insertLink', { key: 'b', code: 'KeyB' });
check('a plain letter for an editor action is blocked (it would type)', /would type into text fields/.test($('[data-testid="recorder-blocked"]')?.textContent || ''));
click($('[data-testid="recorder-cancel"]')); await waitFor(() => (!recorder() ? true : null));

/* 4. unassign, reset */
report('\n--- 4. x, Reset one, Reset all ---');
click($('[data-testid="shortcut-unassign-editor.bold"]'));
await waitFor(() => (chordText('editor.bold') === 'Unassigned' ? true : null));
check('x unassigns Bold (back to its default: the override is gone)', chordText('editor.bold') === 'Unassigned' && !('editor.bold' in stored().overrides));
click($('[data-testid="shortcut-reset-editor.find"]'));
await waitFor(() => (chordText('editor.find') === 'Ctrl+F' ? true : null));
check('Reset one restores Find in document to Ctrl+F', chordText('editor.find') === 'Ctrl+F' && !('editor.find' in stored().overrides) && !$('[data-testid="shortcut-reset-editor.find"]'));
click($('[data-testid="shortcuts-reset-all"]'));
const confirmBtn = await waitFor(() => $$('button').find((b) => b.textContent.trim() === 'Reset all' && b !== $('[data-testid="shortcuts-reset-all"]')));
check('Reset all asks first', !!confirmBtn && /Reset all shortcuts\?/.test(document.body.textContent));
click(confirmBtn);
await waitFor(() => (chordText('editor.italic') === 'Ctrl+I' ? true : null));
check('...and confirmed, every override is gone (Italic Ctrl+I, Calendars Unassigned, storage empty)', chordText('editor.italic') === 'Ctrl+I' && chordText('page.calendars') === 'Unassigned' && JSON.stringify(stored().overrides) === '{}' && $('[data-testid="shortcuts-reset-all"]').disabled);
window.localStorage.setItem('jacarium.shortcuts', JSON.stringify({ version: 1, overrides: { 'editor.find': 'Mod+KeyJ', 'nope.x': 'Mod+KeyA', 'editor.italic': 'Ctrl-I' } }));
await H.store.loadOverrides();
await open('shortcuts');
check('a stored value with an unknown id and a bad chord loads what is valid and drops the rest', chordText('editor.find') === 'Ctrl+J' && chordText('editor.italic') === 'Ctrl+I' && JSON.stringify(H.store.getOverrides()) === JSON.stringify({ 'editor.find': 'Mod+KeyJ' }), JSON.stringify(H.store.getOverrides()));
window.localStorage.removeItem('jacarium.shortcuts'); await H.store.loadOverrides();

/* 5. a Mac, and the desktop bridge */
report('\n--- 5. Mac labels, the desktop bridge ---');
setPlatform('MacIntel');
await open('shortcuts');
check('a Mac shows ⌘F, ⌘I, ⇧⌘F, ⌘↩, ⇧⌘Z (no Ctrl+Y alias) and ⇧⇥', chordText('editor.find') === '⌘F' && chordText('editor.italic') === '⌘I' && chordText('app.findInFiles') === '⇧⌘F' && chordText('jql.openInJira') === '⌘↩' && chordText('workflow.redo') === '⇧⌘Z' && !/or /.test($('[data-testid="shortcut-row-workflow.redo"]').textContent) && chordText('editor.outdent') === '⇧⇥', [chordText('editor.find'), chordText('app.findInFiles'), chordText('jql.openInJira')].join());
rec = await record('editor.bold', { key: 'b', code: 'KeyB', metaKey: true });
check('on a Mac ⌘B in a browser is free (no desktop menu): Use ⌘B', $('[data-testid="recorder-preview"]').textContent.trim() === '⌘B' && !$('[data-testid="recorder-conflict"]') && !$('[data-testid="recorder-use"]').disabled);
keydown(rec, { key: 'w', code: 'KeyW', metaKey: true }); await sleep(30);
check('⌘W is blocked (macOS)', /belongs to macOS/.test($('[data-testid="recorder-blocked"]')?.textContent || ''));
keydown(rec, { key: '¡', code: 'Digit1', metaKey: true, altKey: true }); await sleep(30);
check('⌥⌘1 (key "¡") records by physical key as ⌥⌘1', $('[data-testid="recorder-preview"]').textContent.trim() === '⌥⌘1', $('[data-testid="recorder-preview"]').textContent);
click($('[data-testid="recorder-cancel"]')); await waitFor(() => (!recorder() ? true : null));
// the desktop: the bridge owns the storage; Toggle sidebar exists and takes ⌘B
const ipc = [];
let bridgeState = { version: 1, overrides: {}, platform: 'darwin' };
let changeListener = null;
window.electronAPI = {
  isElectron: true, platform: 'darwin',
  getShortcuts: async () => bridgeState,
  setShortcuts: async (overrides) => { ipc.push(overrides); if (overrides['editor.bold'] === 'Mod+KeyQ') return { ok: false, errors: [{ id: 'editor.bold', message: 'refused by the main process' }] }; bridgeState = { ...bridgeState, overrides }; return { ok: true, ...bridgeState }; },
  onShortcutsChanged: (cb) => { changeListener = cb; return () => { changeListener = null; }; },
  readSettings: async () => ({ values: {}, secrets: {} }), writeSettings: async () => ({ values: {}, secrets: {} }),
  homeServerStatus: async () => ({ linked: false }), getZoomFactor: async () => 1, getDebugBarEnabled: async () => false,
  getUsername: async () => 'robin', getHostname: async () => 'mac', getAppToken: async () => 't', getAppVersion: async () => '3.3.0', openExternal: async () => {}, readEnvFile: async () => ({}),
  accountSettingsState: async () => ({ scope: 'device', linked: false }), onAccountSettingsChanged: () => () => {},
};
await H.initializePlatform();
await H.store.loadOverrides();
await open('shortcuts');
check('the desktop lists the menu actions too: Open Settings ⌘,, Toggle sidebar ⌘B, Zoom in ⌘= or ⇧⌘=, Reload ⌘R fixed, Full screen ⌃⌘F fixed', chordText('app.settings') === '⌘,' && chordText('app.toggleSidebar') === '⌘B' && chordText('app.zoomIn') === '⌘=' && /or ⇧⌘=/.test($('[data-testid="shortcut-row-app.zoomIn"]').textContent) && chordText('app.reload') === '⌘R' && !!$('[data-testid="shortcut-fixed-app.reload"]') && chordText('app.fullscreen') === '⌃⌘F' && rowIds().length === 32, [chordText('app.settings'), chordText('app.zoomIn'), chordText('app.fullscreen'), rowIds().length].join());
check('...stored on this device (this profile)', /this profile/.test($('[data-testid="shortcuts-settings"]').textContent));
rec = await record('editor.bold', { key: 'b', code: 'KeyB', metaKey: true });
check('on the desktop ⌘B for Bold meets Toggle sidebar (the menu accelerator fires everywhere): Replace offered', /⌘B is Toggle sidebar/.test($('[data-testid="recorder-conflict"]')?.textContent || '') && /Replace Toggle sidebar/.test($('[data-testid="recorder-use"]').textContent));
click($('[data-testid="recorder-use"]'));
await waitFor(() => (chordText('editor.bold') === '⌘B' ? true : null));
check('Replace goes through the bridge: setShortcuts({ editor.bold: Mod+KeyB, app.toggleSidebar: null }), the list follows the main process\'s answer', JSON.stringify(ipc[ipc.length - 1]) === JSON.stringify({ 'editor.bold': 'Mod+KeyB', 'app.toggleSidebar': null }) && chordText('app.toggleSidebar') === 'Unassigned', JSON.stringify(ipc));
rec = await record('editor.bold', { key: 'q', code: 'KeyQ', metaKey: true, altKey: true });
check('⌥⌘Q passes the renderer\'s checks...', !$('[data-testid="recorder-blocked"]'));
// make the main process refuse: swap the chord the bridge rejects
window.electronAPI.setShortcuts = async (overrides) => { ipc.push(overrides); return { ok: false, errors: [{ id: 'editor.bold', message: 'refused by the main process' }] }; };
click($('[data-testid="recorder-use"]'));
await waitFor(() => $('[data-testid="shortcuts-error"]'));
check('...and a refusal by the main process shows its reason and keeps the previous binding', /refused by the main process/.test($('[data-testid="shortcuts-error"]')?.textContent || '') && chordText('editor.bold') === '⌘B');
changeListener?.({ version: 1, overrides: { 'editor.find': 'Mod+KeyJ' }, platform: 'darwin' });
await waitFor(() => (chordText('editor.find') === '⌘J' ? true : null));
check('the main process\'s broadcast (another window changed a binding) updates the list', chordText('editor.find') === '⌘J' && chordText('editor.bold') === 'Unassigned');
delete window.electronAPI;
await H.initializePlatform();
await H.store.loadOverrides();

/* 6. a phone */
report('\n--- 6. a phone ---');
viewportMatches = true;
window.dispatchEvent(new window.Event('resize'));
await open('general');
await sleep(100);
const tabs = $$('[data-testid="settings-modal"] [role="tab"]').map((t) => t.textContent.trim());
check('a phone has no Shortcuts tab (data-mobile set, the rail without it)', document.documentElement.getAttribute('data-mobile') === 'true' && !tabs.includes('Shortcuts'), `${tabs.join()} mobile=${document.documentElement.getAttribute('data-mobile')}`);
viewportMatches = false;
window.dispatchEvent(new window.Event('resize'));

/* 7. never in a settings payload */
report('\n--- 7. the settings scopes ---');
check('no settings payload carried shortcuts (the store is separate)', !payloads.some((p) => /shortcut/i.test(p)));
const src = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
check('settingsStore.js and the copy sheet know nothing of shortcuts; the store never calls the settings store', !/shortcut/i.test(src('src/services/settingsStore.js')) && !/shortcut/i.test(src('src/components/common/modals/settings/CopySettingsSheet.jsx')) && !/settingsStore/.test(src('src/shortcuts/store.js')));

report(`\n${total - failures}/${total} checks passed`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
