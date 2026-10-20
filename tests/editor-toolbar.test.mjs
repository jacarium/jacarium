#!/usr/bin/env node
/**
 * The Documents editor's toolbar (src/components/features/documents/
 * DocumentEditor.jsx, ToolbarMenu.jsx, src/hooks/toolbarMenu.js).
 *
 * Desktop: four groups - Text (Bold, Italic, Strikethrough, Code), Heading
 * (a menu labelled with the caret line's level), List (a menu: Bullet,
 * Numbered, Task; then Outdent, Indent), Link + Insert (a menu: Table,
 * Image, Table of contents, the five callouts, Quote, Horizontal rule,
 * Code block, the PDF directives) - then a separator and the Edit/Preview toggle,
 * LEFT-aligned right after the last group (no spacer). Phone: seven
 * controls that fit without scrolling - Bold, Italic, Heading, List, Link,
 * More (holding the rest), the toggle. The strip is a WAI-ARIA toolbar
 * (one tab stop, Left/Right/Home/End), the dropdowns WAI-ARIA menus
 * (menuitem / menuitemradio + aria-checked, arrows, Escape returns focus).
 *
 * Proved with the REAL DocumentEditor mounted in jsdom (fake-indexeddb, no
 * backend), desktop and - through MobileProvider and a phone matchMedia
 * stub - the phone layout:
 *   1. the desktop strip: the controls in that order, the separators, the
 *      toggle last and directly after a separator, no spacer; one tab stop,
 *      Right/Left/Home/End move the focus;
 *   2. Heading: the button reads the caret line's level (the pilcrow / H1..H3),
 *      the menu's radio items check it (aria-checked only - no visible
 *      tick); choosing a level replaces the
 *      line's "#" prefix; Paragraph strips it; there is no keyboard chord
 *      for headings (typing # is quicker and Alt chords are unreliable);
 *   3. List: the menu checks the caret line's kind; choosing a kind
 *      replaces the marker (every selected line, numbered 1., 2.);
 *      choosing the current kind removes it; Tab / Shift+Tab inside a list
 *      indent / outdent the line (and only there: Tab on a plain line is
 *      left to the browser);
 *   4. Link: the button and Ctrl/Cmd+K insert "[link text](url)";
 *   5. Code: inline for a one-line selection, a fence for a multi-line one;
 *   6. Insert: the items in order with the callouts grouped; Tip inserts the
 *      callout; the PDF group inserts the app's own directives
 *      ([[pagebreak]], [[blankpage]] on their own paragraph; [[centerpage]],
 *      [[header]], [[footer]] wrapping the selection or a placeholder);
 *      Escape closes the menu and focuses its button;
 *   7. the "/" popup's new built-ins: /hr, /quote, /toc, /code run the
 *      toolbar's helpers in place of the typed command; /pagebreak,
 *      /blankpage, /centerpage, /header, /footer insert the PDF directives;
 *   7b. shortcut labels follow the platform (src/utils/shortcuts.js): ⌘I,
 *      ⇥ / ⇧⇥ on a Mac, Ctrl+I, Tab / Shift+Tab elsewhere; Bold and Link
 *      carry no chord anywhere (Cmd/Ctrl+B is the desktop menu's Toggle
 *      Sidebar, Cmd/Ctrl+K the command palette's) and the editor ignores
 *      Ctrl/Cmd+K, +B and +R (no link, bold or Replace chord; Replace is
 *      the Find bar's "+ Replace"); Ctrl/Cmd+F and +I still work; the
 *      heading chords are gone;
 *   8. the phone strip: exactly those seven controls, More holds the rest,
 *      the toggle follows the separator (no margin-left: auto, no spacer);
 *   9. a locked document: only the toggle.
 *
 * Run:  node tests/editor-toolbar.test.mjs
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
for (const dep of ['esbuild', 'dexie', 'react', 'react-dom']) {
  if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); }
}
for (const dep of ['fake-indexeddb', 'jsdom']) {
  if (!resolvable(dep)) { console.log(`SKIP: test-only dependency "${dep}" not installed (npm install --no-save jsdom fake-indexeddb)`); process.exit(0); }
}

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-toolbar-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = console.log;
let failures = 0; let total = 0;
function check(name, cond, detail = '') {
  total += 1;
  if (cond) report(`PASS: ${name}`);
  else { failures += 1; report(`FAIL: ${name}${detail ? ` | ${String(detail).slice(0, 400)}` : ''}`); }
}
async function waitFor(fn, timeout = 5000) {
  const t0 = Date.now();
  for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() - t0 > timeout) return null; await sleep(20); }
}

// ---------- bundle ----------
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import DocumentEditor from '@worktree/src/components/features/documents/DocumentEditor.jsx';
import { BUILTIN_COMMANDS } from '@worktree/src/utils/slashCommands.js';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
import { MobileProvider } from '@worktree/src/contexts/MobileContext.jsx';

const api = {};
let setView = null;
let key = 0;
function Host() {
  const [view, set] = React.useState(null);
  setView = set;
  const [content, setContent] = React.useState('');
  api.getContent = () => content;
  api.setContent = setContent;
  if (!view) return null;
  const editor = React.createElement(DocumentEditor, {
    key: view.key,
    documentId: 1,
    document: { id: 1, title: 'Notes', inCloud: false },
    content,
    onContentChange: (e) => setContent(e.target.value),
    templates: BUILTIN_COMMANDS,
    locked: !!view.locked,
    isOnline: true,
  });
  // keyed: the provider reads the media queries when it mounts, so a phone mount gets a fresh one
  return React.createElement(MobileProvider, { key: view.key }, editor);
}
const whenReady = (fn) => { const go = () => (setView ? fn() : setTimeout(go, 10)); go(); };
api.mount = (opts = {}) => whenReady(() => setView({ ...opts, key: ++key }));
api.unmount = () => whenReady(() => setView(null));
window.__harness = api;
createRoot(document.getElementById('root')).render(React.createElement(NotificationProvider, null, React.createElement(Host)));
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
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement',
  'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'localStorage', 'sessionStorage']) {
  define(name, window[name]);
}
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); define('IntersectionObserver', FakeObserver);
window.ResizeObserver = FakeObserver; window.IntersectionObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.scrollTo = function () {};
// The phone layout is decided by two media queries: this stub answers them as a phone or a desktop, per mount
let phone = false;
window.matchMedia = (q) => ({ matches: phone && (/max-width: 767px/.test(q) || /pointer: coarse/.test(q)), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
const failingFetch = () => Promise.reject(new Error('no backend in test'));
define('fetch', failingFetch); window.fetch = failingFetch;
const origLog = console.log; const origErr = console.error; const origWarn = console.warn;
const quiet = (fn) => (...a) => { const s = String(a[0] ?? ''); if (/^\[|Warning:|act\(|Dexie|Error|no backend/.test(s)) return; fn(...a); };
console.log = quiet(origLog); console.error = quiet(origErr); console.warn = quiet(origWarn);

createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const H = window.__harness;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (el, k, init = {}) => { const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }); el.dispatchEvent(e); return e.defaultPrevented; };
const setNative = (el, value) => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); };
async function mount(opts = {}) {
  phone = !!opts.mobile;
  await waitFor(() => H.setContent); // the host has rendered
  H.unmount();
  await waitFor(() => (!$('textarea') ? true : null));
  H.setContent(opts.content || '');
  H.mount({ locked: !!opts.locked });
  const textarea = await waitFor(() => $('textarea'));
  await sleep(30);
  return textarea;
}
async function setContent(textarea, text, start = text.length, end = start) {
  setNative(textarea, text);
  await waitFor(() => (H.getContent() === text ? true : null));
  textarea.focus();
  textarea.setSelectionRange(start, end);
  textarea.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  await sleep(40);
}
const content = async (expected, timeout = 2000) => waitFor(() => (typeof expected === 'function' ? (expected(H.getContent()) ? H.getContent() : null) : (H.getContent() === expected ? expected : null)), timeout) ?? H.getContent();
const stripTestIds = () => $$('[data-testid="editor-toolbar"] > button, [data-testid="editor-toolbar"] > span > button').map((b) => b.getAttribute('data-testid'));
const menu = (id) => $(`[data-testid="${id}"]`);
const items = (id) => Array.from(menu(id)?.querySelectorAll('[role="menuitem"], [role="menuitemradio"]') || []);
const headings = (id) => Array.from(menu(id)?.querySelectorAll('[role="presentation"]') || []).map((h) => h.textContent.trim());
async function openMenu(buttonId, menuId) { if (menu(menuId)) return menu(menuId); /* already open: the button would toggle it closed */ click($(`[data-testid="${buttonId}"]`)); return waitFor(() => menu(menuId)); }

/* ================================================================== */
report('\n--- 1. the desktop strip ---');
/* ================================================================== */
let ta = await mount({ content: 'Intro\n\n## Title\n\ntext' });
const toolbar = $('[data-testid="editor-toolbar"]');
check('the strip is role="toolbar" with a name', toolbar?.getAttribute('role') === 'toolbar' && !!toolbar.getAttribute('aria-label'));
check('desktop: Bold, Italic, Strikethrough, Code | Heading | List, Outdent, Indent | Link, Insert | toggle - in that order',
  stripTestIds().join() === 'tb-bold,tb-italic,tb-strike,tb-code,heading-menu-button,list-menu-button,tb-outdent,tb-indent,tb-link,insert-menu-button,editor-mode-toggle', stripTestIds().join());
const separators = Array.from(toolbar.children).filter((c) => c.getAttribute('role') === 'separator');
check('four separators: after the text group, the heading, the list group and the insert group', separators.length === 4, separators.length);
const toggle = $('[data-testid="editor-mode-toggle"]');
check('the toggle is the strip\'s LAST element and follows a separator directly - no spacer, no margin-left: auto, no flex-1 element before it',
  toolbar.lastElementChild === toggle && toggle.previousElementSibling?.getAttribute('role') === 'separator' && !/ml-auto|flex-1|grow/.test(toggle.className) && !Array.from(toolbar.children).some((c) => /ml-auto|flex-1|grow/.test(c.className || '')),
  `${toggle.previousElementSibling?.outerHTML.slice(0, 60)} | ${toggle.className}`);
const mobileCss = fs.readFileSync(path.join(REPO, 'src/mobile.css'), 'utf8');
check('mobile.css no longer pushes the toggle to the right (no margin-left: auto on .sc-editor-mode) and lets a labelled button grow', !/sc-editor-mode[^\n]*margin-left: auto/.test(mobileCss) && /\.sc-editor-toolbar > button \{ min-width: 36px; width: auto;/.test(mobileCss));
const buttons = () => $$('[data-testid="editor-toolbar"] button');
check('one tab stop: exactly one button has tabindex 0, the rest -1', buttons().filter((b) => b.tabIndex === 0).length === 1 && buttons().filter((b) => b.tabIndex === -1).length === buttons().length - 1, buttons().map((b) => b.tabIndex).join());
buttons()[0].focus();
key(buttons()[0], 'ArrowRight');
check('ArrowRight moves the focus to the next control and the tab stop with it', document.activeElement === buttons()[1] && buttons()[1].tabIndex === 0 && buttons()[0].tabIndex === -1);
key(document.activeElement, 'End');
check('End focuses the last control (the toggle)', document.activeElement === toggle);
key(document.activeElement, 'ArrowRight');
check('ArrowRight wraps to the first', document.activeElement === buttons()[0]);
key(document.activeElement, 'ArrowLeft');
check('ArrowLeft wraps to the last', document.activeElement === toggle);
key(document.activeElement, 'Home');
check('Home focuses the first', document.activeElement === buttons()[0]);
check('every control is named (aria-label or text)', buttons().every((b) => (b.getAttribute('aria-label') || b.textContent).trim().length > 0));

/* ================================================================== */
report('\n--- 2. Heading ---');
/* ================================================================== */
const label = () => $('[data-testid="heading-menu-button-label"]')?.textContent.trim();
await setContent(ta, 'Intro\n\n## Title\n\ntext', 10);
check('the Heading button reads "H2" with the caret in a "## " line', label() === 'H2', label());
await setContent(ta, 'Intro\n\n## Title\n\ntext', 2);
check('...and the pilcrow on a plain line (a labelled control shows no icon but its chevron)', label() === '\u00b6' && !$('[data-testid="heading-menu-button"] svg.lucide-pilcrow'), label());
await setContent(ta, 'Intro\n\n## Title\n\ntext', 10);
let m = await openMenu('heading-menu-button', 'heading-menu');
check('the menu is role="menu" with four menuitemradio entries: Paragraph, Heading 1, 2, 3 - and no shortcut hints (typing # is the shortcut)', m?.getAttribute('role') === 'menu' && items('heading-menu').map((i) => i.getAttribute('role')).every((r) => r === 'menuitemradio') && items('heading-menu').map((i) => i.textContent.trim()).join('|') === 'Paragraph|Heading 1|Heading 2|Heading 3' && !items('heading-menu').some((i) => i.querySelector('.text-xs')), items('heading-menu').map((i) => i.textContent.trim()).join('|'));
check('Heading 2 is checked (aria-checked) and focused when the menu opens', await waitFor(() => (document.activeElement?.getAttribute('data-menu-item') === 'heading-2' ? true : null)) && items('heading-menu').find((i) => i.getAttribute('data-menu-item') === 'heading-2').getAttribute('aria-checked') === 'true');
check('the button says the menu is open (aria-expanded)', $('[data-testid="heading-menu-button"]').getAttribute('aria-expanded') === 'true');
check('the current level is marked for assistive technology only: no visible tick in the menu, no "selected" fill (the button label shows it)', !menu('heading-menu').querySelector('svg.lucide-check') && !items('heading-menu').some((i) => /bg-os-blue|selected/.test(i.className)));
key(document.activeElement, 'ArrowDown');
check('ArrowDown moves to Heading 3', document.activeElement?.getAttribute('data-menu-item') === 'heading-3');
click(document.activeElement);
check('choosing Heading 3 replaces the line\'s prefix ("### Title"), closes the menu', (await content('Intro\n\n### Title\n\ntext')) === 'Intro\n\n### Title\n\ntext' && !menu('heading-menu'), JSON.stringify(H.getContent()));
await waitFor(() => (label() === 'H3' ? true : null));
check('the button now reads "H3"', label() === 'H3', label());
m = await openMenu('heading-menu-button', 'heading-menu');
click(items('heading-menu')[0]);
check('Paragraph strips the prefix', (await content('Intro\n\nTitle\n\ntext')) === 'Intro\n\nTitle\n\ntext', JSON.stringify(H.getContent()));
await setContent(ta, 'Intro\n\nTitle\n\ntext', 8);
check('there is no heading chord: Ctrl+Alt+1 and Option+Command+1 are not taken and change nothing', !key(ta, '1', { ctrlKey: true, altKey: true, code: 'Digit1' }) && !key(ta, '\u00a1', { metaKey: true, altKey: true, code: 'Digit1' }) && H.getContent() === 'Intro\n\nTitle\n\ntext', JSON.stringify(H.getContent()));
await setContent(ta, '', 0);
m = await openMenu('heading-menu-button', 'heading-menu');
click(items('heading-menu')[2]);
await content((c) => c === '## Heading 2');
check('on an empty line, Heading 2 inserts "## Heading 2" with the placeholder title selected', H.getContent() === '## Heading 2' && ta.selectionStart === 3 && ta.selectionEnd === 12, `${JSON.stringify(H.getContent())} ${ta.selectionStart}-${ta.selectionEnd}`);

/* ================================================================== */
report('\n--- 3. List ---');
/* ================================================================== */
await setContent(ta, 'a\n- item\nb', 5);
m = await openMenu('list-menu-button', 'list-menu');
const checked = () => items('list-menu').filter((i) => i.getAttribute('aria-checked') === 'true').map((i) => i.getAttribute('data-menu-item')).join();
check('the List menu lists Bullet, Numbered, Task as menuitemradio; Bullet is checked on a "- " line', items('list-menu').map((i) => i.getAttribute('data-menu-item')).join() === 'list-bullet,list-numbered,list-task' && checked() === 'list-bullet', checked());
check('...with no visible tick either', !menu('list-menu').querySelector('svg.lucide-check'));
click(items('list-menu')[1]);
check('Numbered replaces the marker ("1. item")', (await content('a\n1. item\nb')) === 'a\n1. item\nb', JSON.stringify(H.getContent()));
await setContent(ta, 'a\n1. item\nb', 5);
m = await openMenu('list-menu-button', 'list-menu');
check('...and is now the checked kind', checked() === 'list-numbered', checked());
click(items('list-menu')[1]);
check('choosing the current kind removes the marker', (await content('a\nitem\nb')) === 'a\nitem\nb', JSON.stringify(H.getContent()));
await setContent(ta, 'a\nitem\nb', 3);
m = await openMenu('list-menu-button', 'list-menu');
click(items('list-menu')[2]);
check('Task adds "- [ ] "', (await content('a\n- [ ] item\nb')) === 'a\n- [ ] item\nb', JSON.stringify(H.getContent()));
await setContent(ta, 'one\ntwo\nthree', 0, 13);
m = await openMenu('list-menu-button', 'list-menu');
click(items('list-menu')[1]);
check('a three-line selection becomes 1. 2. 3.', (await content('1. one\n2. two\n3. three')) === '1. one\n2. two\n3. three', JSON.stringify(H.getContent()));
await setContent(ta, 'a\n- item\nb', 5);
check('Tab inside a list line indents it by two spaces (prevented)', key(ta, 'Tab') && (await content('a\n  - item\nb')) === 'a\n  - item\nb', JSON.stringify(H.getContent()));
await setContent(ta, 'a\n  - item\nb', 7);
check('Shift+Tab outdents it', key(ta, 'Tab', { shiftKey: true }) && (await content('a\n- item\nb')) === 'a\n- item\nb', JSON.stringify(H.getContent()));
await setContent(ta, 'plain line', 3);
const before = H.getContent();
check('Tab on a plain line is NOT taken (the browser moves the focus), text unchanged', !key(ta, 'Tab') && H.getContent() === before);
await setContent(ta, 'a\n- item\nb', 5);
click($('[data-testid="tb-indent"]'));
check('the Indent button indents the caret\'s whole line', (await content('a\n  - item\nb')) === 'a\n  - item\nb', JSON.stringify(H.getContent()));
click($('[data-testid="tb-outdent"]'));
check('the Outdent button outdents it', (await content('a\n- item\nb')) === 'a\n- item\nb', JSON.stringify(H.getContent()));

/* ================================================================== */
report('\n--- 4. Link, 5. Code ---');
/* ================================================================== */
await setContent(ta, 'see ', 4);
click($('[data-testid="tb-link"]'));
check('the Link button inserts "[link text](url)"', (await content('see [link text](url)')) === 'see [link text](url)', JSON.stringify(H.getContent()));
await setContent(ta, 'see ', 4);
check('Ctrl+K is not the editor\'s (the command palette\'s, app-wide): not prevented, nothing inserted', !key(ta, 'k', { ctrlKey: true }) && (await sleep(60), H.getContent() === 'see '), JSON.stringify(H.getContent()));
await setContent(ta, 'x', 0, 1);
check('Ctrl+B is not the editor\'s either (the desktop menu\'s Toggle Sidebar): not prevented, no bold', !key(ta, 'b', { ctrlKey: true }) && (await sleep(60), H.getContent() === 'x'), JSON.stringify(H.getContent()));
const findHeading = () => $$('span').find((el) => /^Find( & Replace)?$/.test(el.textContent.trim()));
check('Ctrl+R is not Replace any more: not prevented, no Find bar', !key(ta, 'r', { ctrlKey: true }) && (await sleep(60), !findHeading()), findHeading()?.textContent);
check('Ctrl+F still opens Find (prevented)', key(ta, 'f', { ctrlKey: true }) && !!(await waitFor(() => findHeading())), findHeading()?.textContent);
check('...and the Find bar offers "+ Replace" - the way to Replace now', !!$$('button').find((b) => b.textContent.trim() === '+ Replace'), $$('button').map((b) => b.textContent.trim()).filter(Boolean).join('|'));
click($$('button').find((b) => b.title === 'Close (Esc)'));
await waitFor(() => (!findHeading() ? true : null));
await setContent(ta, 'x', 0, 1);
check('Ctrl+I still wraps the selection in italics (prevented)', key(ta, 'i', { ctrlKey: true }) && (await content('*x*')) === '*x*', JSON.stringify(H.getContent()));
await setContent(ta, 'run ls now', 4, 6);
click($('[data-testid="tb-code"]'));
check('Code with a one-line selection wraps it in backticks', (await content('run `ls` now')) === 'run `ls` now', JSON.stringify(H.getContent()));
await setContent(ta, 'a\nb', 0, 3);
click($('[data-testid="tb-code"]'));
check('Code with a multi-line selection makes a fenced block', /```\na\nb\n```/.test(await content((c) => /```/.test(c))), JSON.stringify(H.getContent()));
await setContent(ta, 'x', 0, 1);
click($('[data-testid="tb-bold"]'));
check('Bold wraps the selection', (await content('**x**')) === '**x**');
await setContent(ta, 'x', 0, 1);
click($('[data-testid="tb-strike"]'));
check('Strikethrough wraps the selection', (await content('~~x~~')) === '~~x~~');

/* ================================================================== */
report('\n--- 6. Insert ---');
/* ================================================================== */
await setContent(ta, 'Intro', 5);
m = await openMenu('insert-menu-button', 'insert-menu');
check('the Insert menu lists Table, Image, Table of contents, [Callouts] Note..Caution, [Blocks] Quote, Horizontal rule, Code block, [PDF] Page break, Blank page, Centered page, Page header, Page footer',
  items('insert-menu').map((i) => i.getAttribute('data-menu-item')).join() === 'table,image,toc,callout-note,callout-tip,callout-important,callout-warning,callout-caution,quote,rule,code-block,pagebreak,blankpage,centerpage,pdf-header,pdf-footer' && headings('insert-menu').join() === 'Callouts,Blocks,PDF',
  `${items('insert-menu').map((i) => i.getAttribute('data-menu-item')).join()} | ${headings('insert-menu').join()}`);
check('its items are role="menuitem" and the first is focused', items('insert-menu').every((i) => i.getAttribute('role') === 'menuitem') && await waitFor(() => (document.activeElement?.getAttribute('data-menu-item') === 'table' ? true : null)));
key(document.activeElement, 'Escape');
check('Escape closes the menu and returns the focus to its button', await waitFor(() => (!menu('insert-menu') ? true : null)) && document.activeElement === $('[data-testid="insert-menu-button"]'));
m = await openMenu('insert-menu-button', 'insert-menu');
click(items('insert-menu').find((i) => i.getAttribute('data-menu-item') === 'callout-tip'));
check('Tip inserts "> [!TIP]" with a quoted placeholder on its own paragraph', (await content('Intro\n\n> [!TIP]\n> Tip text')) === 'Intro\n\n> [!TIP]\n> Tip text', JSON.stringify(H.getContent()));
await setContent(ta, 'Intro', 5);
m = await openMenu('insert-menu-button', 'insert-menu');
click(items('insert-menu').find((i) => i.getAttribute('data-menu-item') === 'pagebreak'));
check('PDF > Page break inserts the app\'s [[pagebreak]] directive on its own paragraph (the preview marks it, the PDF export breaks the page)', (await content('Intro\n\n[[pagebreak]]')) === 'Intro\n\n[[pagebreak]]', JSON.stringify(H.getContent()));
const css = fs.readFileSync(path.join(REPO, 'src/index.css'), 'utf8');
check('no div-based page break of the editor\'s own is left (index.css has only the [[pagebreak]] marker styles)', !/\.page-break\b/.test(css) && /\.markdown-preview \.pdf-directive \{/.test(css));
await setContent(ta, 'Intro', 5);
m = await openMenu('insert-menu-button', 'insert-menu');
click(items('insert-menu').find((i) => i.getAttribute('data-menu-item') === 'blankpage'));
check('PDF > Blank page inserts [[blankpage]]', (await content('Intro\n\n[[blankpage]]')) === 'Intro\n\n[[blankpage]]', JSON.stringify(H.getContent()));
await setContent(ta, 'Cover title', 0, 11);
m = await openMenu('insert-menu-button', 'insert-menu');
click(items('insert-menu').find((i) => i.getAttribute('data-menu-item') === 'centerpage'));
check('PDF > Centered page wraps the selection: [[centerpage]] / the lines / [[/centerpage]], each tag on its own line, caret after', (await content('[[centerpage]]\nCover title\n[[/centerpage]]')) === '[[centerpage]]\nCover title\n[[/centerpage]]' && ta.selectionStart === H.getContent().length, JSON.stringify(H.getContent()));
await setContent(ta, 'Intro', 5);
m = await openMenu('insert-menu-button', 'insert-menu');
click(items('insert-menu').find((i) => i.getAttribute('data-menu-item') === 'pdf-header'));
check('PDF > Page header with no selection inserts "[[header]]\nExample Header\n[[/header]]" on its own paragraph, the placeholder selected', (await content('Intro\n\n[[header]]\nExample Header\n[[/header]]')) === 'Intro\n\n[[header]]\nExample Header\n[[/header]]' && H.getContent().slice(ta.selectionStart, ta.selectionEnd) === 'Example Header', `${JSON.stringify(H.getContent())} sel=${ta.selectionStart}-${ta.selectionEnd}`);
await setContent(ta, 'Intro\n\nbody', 5);
m = await openMenu('insert-menu-button', 'insert-menu');
click(items('insert-menu').find((i) => i.getAttribute('data-menu-item') === 'pdf-footer'));
check('PDF > Page footer between paragraphs: "[[footer]]\nExample Footer\n[[/footer]]" with blank lines around, placeholder selected', (await content('Intro\n\n[[footer]]\nExample Footer\n[[/footer]]\n\nbody')) === 'Intro\n\n[[footer]]\nExample Footer\n[[/footer]]\n\nbody' && H.getContent().slice(ta.selectionStart, ta.selectionEnd) === 'Example Footer', `${JSON.stringify(H.getContent())} sel=${ta.selectionStart}-${ta.selectionEnd}`);
await setContent(ta, 'line one\nline two', 0, 17);
m = await openMenu('insert-menu-button', 'insert-menu');
click(items('insert-menu').find((i) => i.getAttribute('data-menu-item') === 'pdf-header'));
check('PDF > Page header with two selected lines wraps them: "[[header]]\nline one\nline two\n[[/header]]"', (await content('[[header]]\nline one\nline two\n[[/header]]')) === '[[header]]\nline one\nline two\n[[/header]]', JSON.stringify(H.getContent()));
await setContent(ta, 'Intro', 5);
m = await openMenu('insert-menu-button', 'insert-menu');
click(items('insert-menu').find((i) => i.getAttribute('data-menu-item') === 'rule'));
check('Horizontal rule inserts ---', /Intro\n---\n/.test(await content((c) => /---/.test(c))), JSON.stringify(H.getContent()));
await setContent(ta, '', 0);
m = await openMenu('insert-menu-button', 'insert-menu');
click(items('insert-menu').find((i) => i.getAttribute('data-menu-item') === 'table'));
check('Table inserts the 3x3 table', /\| Header 1 \| Header 2 \| Header 3 \|/.test(await content((c) => /Header 1/.test(c))));
m = await openMenu('insert-menu-button', 'insert-menu');
check('typeahead: "p" jumps to Page break', (key(document.activeElement, 'p'), document.activeElement?.getAttribute('data-menu-item') === 'pagebreak'), document.activeElement?.getAttribute('data-menu-item'));
key(document.activeElement, 'Escape');
await waitFor(() => (!menu('insert-menu') ? true : null));

/* ================================================================== */
report('\n--- 7. the "/" built-ins ---');
/* ================================================================== */
async function slash(cmd, start = '') {
  await setContent(ta, start, start.length);
  setNative(ta, start + cmd);
  ta.setSelectionRange(start.length + cmd.length, start.length + cmd.length);
  await waitFor(() => (H.getContent() === start + cmd ? true : null));
  await sleep(60);
  const popup = $$('.fixed .text-sm.font-medium').map((e) => e.textContent.trim());
  key(ta, 'Enter');
  await sleep(80);
  return popup;
}
let popup = await slash('/hr', 'Intro\n\n');
check('/hr is offered and Enter inserts a horizontal rule in place of the command', popup.some((t) => /\/hr/.test(t)) && /^Intro\n\n\n---\n$/.test(await content((c) => /---/.test(c) && !/\/hr/.test(c))), JSON.stringify(H.getContent()));
popup = await slash('/quote', 'Intro\n\n');
check('/quote starts a block quote', popup.some((t) => /\/quote/.test(t)) && /^Intro\n\n> quote$/.test(await content((c) => /> /.test(c) && !/\/quote/.test(c))), JSON.stringify(H.getContent()));
popup = await slash('/code', 'Intro\n\n');
check('/code inserts a fenced code block', popup.some((t) => /\/code/.test(t)) && /^Intro\n\n\n```\ncode here\n```\n$/.test(await content((c) => /```/.test(c) && !/\/code/.test(c))), JSON.stringify(H.getContent()));
popup = await slash('/toc', '# One\n\n## Two\n\n');
check('/toc inserts the table of contents (inside its [[toc]] markers) in place of the typed command', popup.some((t) => /\/toc/.test(t)) && /# Table of Contents/.test(await content((c) => /Table of Contents/.test(c))) && !H.getContent().includes('\n\n/toc'), JSON.stringify(H.getContent()));
const commands = await import(path.join(REPO, 'src', 'utils', 'slashCommands.js'));
check('BUILTIN_COMMANDS lists the callouts, /hr /quote /toc /code, the PDF directives (/pagebreak /blankpage /centerpage /header /footer, each described "PDF: ..."), then the Quick commands', commands.BUILTIN_COMMANDS.map((c) => c.name).join() === '/note,/tip,/important,/warning,/caution,/hr,/quote,/toc,/code,/pagebreak,/blankpage,/centerpage,/header,/footer,/wf,/ai,/task' && commands.PDF_COMMANDS.every((c) => /^PDF: /.test(c.description)), commands.BUILTIN_COMMANDS.map((c) => c.name).join());
popup = await slash('/pagebreak', 'Intro\n\n');
check('/pagebreak is offered with its PDF hint and Enter inserts [[pagebreak]] in place of the command', popup.some((t) => /\/pagebreak/.test(t)) && (await content('Intro\n\n[[pagebreak]]')) === 'Intro\n\n[[pagebreak]]', JSON.stringify(H.getContent()));
popup = await slash('/header', 'Intro\n\n');
check('/header inserts "[[header]]\nExample Header\n[[/header]]" in place of the command, the placeholder selected', popup.some((t) => /\/header/.test(t)) && (await content('Intro\n\n[[header]]\nExample Header\n[[/header]]')) === 'Intro\n\n[[header]]\nExample Header\n[[/header]]' && H.getContent().slice(ta.selectionStart, ta.selectionEnd) === 'Example Header', `${JSON.stringify(H.getContent())} sel=${ta.selectionStart}-${ta.selectionEnd}`);
popup = await slash('/footer', 'Intro\n\n');
check('/footer inserts "[[footer]]\nExample Footer\n[[/footer]]"', popup.some((t) => /\/footer/.test(t)) && (await content('Intro\n\n[[footer]]\nExample Footer\n[[/footer]]')) === 'Intro\n\n[[footer]]\nExample Footer\n[[/footer]]', JSON.stringify(H.getContent()));

/* ================================================================== */
report('\n--- 7b. shortcut labels per platform ---');
/* ================================================================== */
const shortcuts = await import(path.join(REPO, 'src', 'utils', 'shortcuts.js'));
check('formatShortcut on a Mac: the symbols in Apple\'s order (⌃⌥⇧⌘ then the key)', shortcuts.formatShortcut('Mod+B', true) === '⌘B' && shortcuts.formatShortcut('Shift+Tab', true) === '⇧⇥' && shortcuts.formatShortcut('Tab', true) === '⇥' && shortcuts.formatShortcut('Shift+Ctrl+Mod+Alt+K', true) === '⌃⌥⇧⌘K' && shortcuts.formatShortcut('Mod+Shift+F', true) === '⇧⌘F',
  [shortcuts.formatShortcut('Mod+B', true), shortcuts.formatShortcut('Shift+Tab', true), shortcuts.formatShortcut('Mod+Shift+F', true)].join());
check('formatShortcut elsewhere: Ctrl+B, Shift+Tab, Ctrl+Shift+F', shortcuts.formatShortcut('Mod+B', false) === 'Ctrl+B' && shortcuts.formatShortcut('Shift+Tab', false) === 'Shift+Tab' && shortcuts.formatShortcut('Mod+Shift+F', false) === 'Ctrl+Shift+F' && shortcuts.formatShortcut('Mod+Alt+1', false) === 'Ctrl+Alt+1');
const setPlatform = (p) => { Object.defineProperty(window.navigator, 'platform', { value: p, configurable: true }); Object.defineProperty(window.navigator, 'userAgentData', { value: undefined, configurable: true }); };
setPlatform('MacIntel');
check('isMac reads navigator.platform (MacIntel)', shortcuts.isMac() === true);
ta = await mount({ content: 'Intro\n\nTitle' });
const titles = () => ['tb-bold', 'tb-italic', 'tb-link', 'tb-indent', 'tb-outdent'].map((id) => $(`[data-testid="${id}"]`).title).join(' | ');
check('on a Mac the tooltips read ⌘I, ⇥ / ⇧⇥ - Bold and Link carry no chord - nothing Windows-style', titles() === 'Bold | Italic (⌘I) | Insert link | Increase indent (⇥ in a list) | Decrease indent (⇧⇥ in a list)' && !/Ctrl|Alt\b|Shift/.test(titles()), titles());
m = await openMenu('heading-menu-button', 'heading-menu');
check('on a Mac the Heading menu shows no shortcut text either', items('heading-menu').map((i) => i.textContent.trim()).join('|') === 'Paragraph|Heading 1|Heading 2|Heading 3', items('heading-menu').map((i) => i.textContent.trim()).join('|'));
key(document.activeElement, 'Escape'); await waitFor(() => (!menu('heading-menu') ? true : null));
await setContent(ta, 'see ', 4);
check('on a Mac ⌘K (metaKey) inserts nothing either: not prevented, the content stays', !key(ta, 'k', { metaKey: true }) && (await sleep(60), H.getContent() === 'see '), JSON.stringify(H.getContent()));
await setContent(ta, 'x', 0, 1);
check('on a Mac ⌘B (metaKey) inserts nothing: not prevented', !key(ta, 'b', { metaKey: true }) && (await sleep(60), H.getContent() === 'x'), JSON.stringify(H.getContent()));
check('on a Mac ⌘I (metaKey) still wraps in italics', key(ta, 'i', { metaKey: true }) && (await content('*x*')) === '*x*', JSON.stringify(H.getContent()));
const noTitles = () => Array.from(document.querySelectorAll('[data-testid="editor-toolbar"] [title]')).map((b) => b.title).filter((t) => /Ctrl|Alt\b/.test(t));
check('no control in the Mac strip carries a Ctrl/Alt label', noTitles().length === 0, noTitles().join(' | '));
setPlatform('Win32');
check('isMac is false for Win32', shortcuts.isMac() === false);
ta = await mount({ content: 'Intro\n\nTitle' });
check('on Windows the tooltips read Ctrl+I, Tab / Shift+Tab (Bold and Link none)', titles() === 'Bold | Italic (Ctrl+I) | Insert link | Increase indent (Tab in a list) | Decrease indent (Shift+Tab in a list)', titles());
window.electronAPI = { platform: 'win32' };
ta = await mount({ content: 'x' });
check('in the desktop app the same: Bold shows no shortcut (its menu takes Cmd/Ctrl+B for Toggle Sidebar); Italic keeps Ctrl+I', $('[data-testid="tb-bold"]').title === 'Bold' && $('[data-testid="tb-italic"]').title === 'Italic (Ctrl+I)', $('[data-testid="tb-bold"]').title);
window.electronAPI = { platform: 'darwin' };
check('...and Electron\'s process.platform decides the platform (darwin -> Mac symbols)', shortcuts.isMac() === true);
delete window.electronAPI;
setPlatform('');

/* ================================================================== */
report('\n--- 8. the phone ---');
/* ================================================================== */
ta = await mount({ mobile: true, content: 'a\n- item' });
check('phone: Bold, Italic, Heading, List, Link, More, toggle - seven controls, no Insert button, no outdent/indent in the strip',
  stripTestIds().join() === 'tb-bold,tb-italic,heading-menu-button,list-menu-button,tb-link,more-menu-button,editor-mode-toggle', stripTestIds().join());
const ptoolbar = $('[data-testid="editor-toolbar"]');
const ptoggle = $('[data-testid="editor-mode-toggle"]');
check('phone: the toggle follows the separator directly (no spacer, no ml-auto)', ptoolbar.lastElementChild === ptoggle && ptoggle.previousElementSibling?.getAttribute('role') === 'separator' && !Array.from(ptoolbar.children).some((c) => /ml-auto|flex-1|grow/.test(c.className || '')));
m = await openMenu('more-menu-button', 'more-menu');
check('phone: More holds Strikethrough, Code, Outdent, Indent, Table, Image, Table of contents, the callouts, Quote, Horizontal rule, Code block, the PDF directives - grouped Text / List / Insert / Callouts / Blocks / PDF',
  items('more-menu').map((i) => i.getAttribute('data-menu-item')).join() === 'strike,code,outdent,indent,table,image,toc,callout-note,callout-tip,callout-important,callout-warning,callout-caution,quote,rule,code-block,pagebreak,blankpage,centerpage,pdf-header,pdf-footer' && headings('more-menu').join() === 'Text,List,Insert,Callouts,Blocks,PDF',
  `${items('more-menu').map((i) => i.getAttribute('data-menu-item')).join()} | ${headings('more-menu').join()}`);
check('phone: the menu is portalled to the body, fixed, z-40', m.parentElement === document.body && /fixed/.test(m.className) && /z-40/.test(m.className));
await setContent(ta, 'a\n- item', 5);
m = await openMenu('more-menu-button', 'more-menu');
click(items('more-menu').find((i) => i.getAttribute('data-menu-item') === 'indent'));
check('phone: More > Increase indent indents the list line', (await content('a\n  - item')) === 'a\n  - item', JSON.stringify(H.getContent()));
m = await openMenu('more-menu-button', 'more-menu');
click(items('more-menu').find((i) => i.getAttribute('data-menu-item') === 'callout-tip'));
check('phone: More > Tip inserts the callout', /> \[!TIP\]\n> Tip text/.test(await content((c) => /TIP/.test(c))), JSON.stringify(H.getContent()));
m = await openMenu('heading-menu-button', 'heading-menu');
check('phone: the Heading menu works too', !!m && items('heading-menu').length === 4);
key(document.activeElement, 'Escape');

/* ================================================================== */
report('\n--- 9. locked ---');
/* ================================================================== */
ta = await mount({ locked: true, content: 'x' });
check('a locked document shows only the toggle', stripTestIds().join() === 'editor-mode-toggle', stripTestIds().join());

report(`\n${total - failures}/${total} checks passed`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
