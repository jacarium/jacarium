#!/usr/bin/env node
/**
 * "Ask AI About This" in the Documents editor opens Quick AI, not the AI
 * Chat sidebar (src/components/features/documents/DocumentEditor.jsx,
 * TextSelectionMenu.jsx). The real editor in jsdom with a recorded fetch:
 *   1. right-click on a selection -> the menu -> "Ask AI About This" opens
 *      the Quick AI panel (its input, "Enter to submit"), with the note
 *      "Your highlighted text is included with the question." and a
 *      one-line muted preview; no aiChatSidebarStateChange / addAIContext
 *      event is sent; the selection in the textarea is untouched;
 *   2. Enter sends ONE request to /api/ai/ask whose message carries the
 *      exact selection (no sanitising: an IP stays an IP) and the question,
 *      through resolveAiRequestSettings (provider ollama, the default
 *      model); the answer shows as before;
 *   3. Insert Selected puts the answer on a NEW LINE directly below the
 *      selection: a selection ending mid-line -> after that line; a
 *      selection ending at a line break -> right there, no blank line; the
 *      selected text is unchanged; "/ai" is never stripped on this path;
 *   4. Esc closes the panel with nothing changed (content and selection);
 *   5. nothing configured -> the friendly "No AI provider configured"
 *      message and no request.
 * Run: node tests/ask-ai-quick-ai.test.mjs
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
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-ai-quick-ai-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = console.log;
let failures = 0; let total = 0;
function check(name, cond, detail = '') { total += 1; if (cond) report(`PASS: ${name}`); else { failures += 1; report(`FAIL: ${name}${detail ? ` | ${String(detail).slice(0, 500)}` : ''}`); } }
async function waitFor(fn, timeout = 5000) { const t0 = Date.now(); for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() - t0 > timeout) return null; await sleep(20); } }

const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import DocumentEditor from '@worktree/src/components/features/documents/DocumentEditor.jsx';
import { BUILTIN_COMMANDS } from '@worktree/src/utils/slashCommands.js';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
import * as aiRequestSettings from '@worktree/src/utils/aiRequestSettings.js';
const api = { aiRequestSettings };
let setView = null; let key = 0;
function Host() {
  const [view, set] = React.useState(null);
  setView = set;
  const [content, setContent] = React.useState('');
  api.getContent = () => content;
  api.setContent = setContent;
  if (!view) return null;
  return React.createElement(DocumentEditor, { key: view.key, documentId: 1, document: { id: 1, title: 'Notes', inCloud: false }, content, onContentChange: (e) => setContent(e.target.value), templates: BUILTIN_COMMANDS, engineTemplates: [{ id: 'g', name: 'Google', url: 'https://g/{q}' }], onSearchInEngine: () => {} });
}
const whenReady = (fn) => { const go = () => (setView ? fn() : setTimeout(go, 10)); go(); };
api.mount = () => whenReady(() => setView({ key: ++key }));
api.unmount = () => whenReady(() => setView(null));
window.__harness = api;
createRoot(document.getElementById('root')).render(React.createElement(NotificationProvider, null, React.createElement(Host)));
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' }, resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
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
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'localStorage', 'sessionStorage', 'File', 'FileReader', 'Blob']) define(name, window[name]);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); define('IntersectionObserver', FakeObserver);
window.ResizeObserver = FakeObserver; window.IntersectionObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {}; window.HTMLElement.prototype.scrollTo = function () {};
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
let MODELS = {};
const requests = [];
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const stubFetch = async (url, options = {}) => {
  const u = String(url);
  if (/\/api\/ai\/health/.test(u)) return json({ status: 'online' });
  if (/\/api\/ai\/models/.test(u)) return json(MODELS);
  if (/\/api\/ai\/ask/.test(u)) { requests.push({ url: u, body: JSON.parse(options.body || '{}') }); return json({ response: 'ANSWER' }); }
  return json({}, 404);
};
define('fetch', stubFetch); window.fetch = stubFetch;
const origLog = console.log; const origErr = console.error; const origWarn = console.warn;
const quiet = (fn) => (...a) => { const s = String(a[0] ?? ''); if (/^\[|^===|Warning:|act\(|Dexie|Error|no backend/.test(s)) return; fn(...a); };
console.log = quiet(origLog); console.error = quiet(origErr); console.warn = quiet(origWarn);

createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const H = window.__harness;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const setNative = (el, value) => { const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const key = (el, k, init = {}) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const OLLAMA = { ollama: ['qwen3:30b', 'llama3'], anthropic: [], defaults: { provider: 'ollama', model: 'qwen3:30b' } };
const NOTHING = { anthropic: [], openai: [], gemini: [], ollama: [], defaults: { provider: '', model: '' } };
const { forgetAiModelChoice, NO_AI_PROVIDER_MESSAGE } = H.aiRequestSettings;
const sidebarEvents = [];
for (const name of ['aiChatSidebarStateChange', 'addAIContext']) window.addEventListener(name, () => sidebarEvents.push(name));
const quickAiInput = () => $('input[placeholder="for loop in bash, sort function..."]');
const editor = () => $('.sc-editor-textarea');

async function mount(content) {
  await waitFor(() => H.setContent);
  H.unmount(); await waitFor(() => (!editor() ? true : null));
  H.setContent(content);
  H.mount();
  const ta = await waitFor(() => editor());
  await waitFor(() => (H.getContent() === content ? true : null));
  await sleep(60);
  return ta;
}
async function askAbout(ta, start, end) {
  ta.focus(); ta.setSelectionRange(start, end);
  ta.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }));
  const item = await waitFor(() => $('[data-testid="selection-ask-ai"]'));
  if (!item) return null;
  click(item);
  return waitFor(() => quickAiInput());
}
const responseArea = (ta) => waitFor(() => { const t = $$('textarea').find((x) => x !== ta && x.value && x.value !== 'Generating response...'); return t || null; }, 3000);

/* 1. the menu opens Quick AI */
report('\n--- 1. right-click -> Ask AI About This -> Quick AI ---');
MODELS = OLLAMA; forgetAiModelChoice(); requests.length = 0; sidebarEvents.length = 0;
const CONTENT = 'alpha 10.0.0.1 beta\ngamma delta\n';
let ta = await mount(CONTENT);
let input = await askAbout(ta, 6, 19);   // "10.0.0.1 beta"
check('right-click on a selection shows the menu; "Ask AI About This" opens the Quick AI panel (not the chat sidebar: no aiChatSidebarStateChange / addAIContext event)', !!input && sidebarEvents.length === 0 && !$('[data-testid="selection-ask-ai"]') && /Quick AI/.test(document.body.textContent) && /Enter to submit/.test(document.body.textContent), `input=${!!input} events=${sidebarEvents.join()}`);
if (!input) { report(`\n${total - failures}/${total} checks passed`); process.exit(1); }
check('the note sits ABOVE the input (between the header and the field) and the hint stays under the input', (() => { const note = $('[data-testid="quick-ai-context-note"]'); const hint = $$('p').find((p) => /Enter to submit/.test(p.textContent)); return !!note && !!(note.compareDocumentPosition(input) & window.Node.DOCUMENT_POSITION_FOLLOWING) && !!(input.compareDocumentPosition(hint) & window.Node.DOCUMENT_POSITION_FOLLOWING); })());
check('the note says the highlighted text is included, with a muted one-line preview of the selection', /Your highlighted text is included with the question\./.test($('[data-testid="quick-ai-context-note"]')?.textContent || '') && $('[data-testid="quick-ai-context-preview"]')?.textContent === '10.0.0.1 beta', $('[data-testid="quick-ai-context-note"]')?.textContent);
check('the textarea keeps its selection and content', ta.selectionStart === 6 && ta.selectionEnd === 19 && H.getContent() === CONTENT);

/* 2. the request */
report('\n--- 2. the request ---');
setNative(input, 'what is this'); await sleep(30);
key(input, 'Enter');
let area = await responseArea(ta);
check('Enter sends ONE request to /api/ai/ask through the resolver (ollama, the default model)', requests.length === 1 && /\/api\/ai\/ask$/.test(requests[0].url) && requests[0].body.provider === 'ollama' && requests[0].body.model === 'qwen3:30b', JSON.stringify(requests.map((r) => [r.url, r.body.provider, r.body.model])));
check('...whose message carries the exact selection (the IP as typed, no sanitising) and the question', requests[0]?.body.message === 'Selected text:\n10.0.0.1 beta\n\nQuestion: what is this', JSON.stringify(requests[0]?.body.message));
check('the answer shows in the response area as before', area?.value === 'ANSWER', area?.value);

/* 3. where the answer lands */
report('\n--- 3. Insert Selected: a new line below the selection ---');
area.setSelectionRange(0, 6); area.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true })); await sleep(30);
const insertBtn = $$('button').find((b) => /Insert Selected/.test(b.textContent));
check('Insert Selected is offered once part of the answer is selected', !!insertBtn && !insertBtn.disabled);
click(insertBtn);
await waitFor(() => (H.getContent() !== CONTENT ? true : null));
check('a selection ending mid-line: the answer starts on its own line directly below that line; the selected text is unchanged', H.getContent() === 'alpha 10.0.0.1 beta\nANSWER\ngamma delta\n', JSON.stringify(H.getContent()));
check('the panel closed', !quickAiInput());
// a selection that ends at a line break
requests.length = 0;
ta = await mount(CONTENT);
input = await askAbout(ta, 0, 20);   // "alpha 10.0.0.1 beta\n"
setNative(input, 'q'); await sleep(30); key(input, 'Enter');
area = await responseArea(ta);
area.setSelectionRange(0, 6); area.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true })); await sleep(30);
click($$('button').find((b) => /Insert Selected/.test(b.textContent)));
await waitFor(() => (H.getContent() !== CONTENT ? true : null));
check('a selection ending at a line break: the answer goes right there, no blank line in between', H.getContent() === 'alpha 10.0.0.1 beta\nANSWER\ngamma delta\n', JSON.stringify(H.getContent()));
// "/ai" inside the selection is never stripped on this path; the last line without a trailing newline
requests.length = 0;
ta = await mount('run /ai now');
input = await askAbout(ta, 4, 7);   // "/ai"
setNative(input, 'q'); await sleep(30); key(input, 'Enter');
area = await responseArea(ta);
area.setSelectionRange(0, 6); area.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true })); await sleep(30);
click($$('button').find((b) => /Insert Selected/.test(b.textContent)));
await waitFor(() => (H.getContent() !== 'run /ai now' ? true : null));
check('a selection on the last line (no trailing newline): the answer on a new last line; "/ai" in the selection is kept', H.getContent() === 'run /ai now\nANSWER', JSON.stringify(H.getContent()));

/* 4. Esc */
report('\n--- 4. Esc ---');
requests.length = 0;
ta = await mount(CONTENT);
input = await askAbout(ta, 6, 19);
key(input, 'Escape');
await waitFor(() => (!quickAiInput() ? true : null));
check('Esc closes the panel with nothing changed: content, selection, no request', !quickAiInput() && H.getContent() === CONTENT && ta.selectionStart === 6 && ta.selectionEnd === 19 && requests.length === 0);
input = await askAbout(ta, 6, 19);
check('...and the next Ask AI starts clean (empty input, the note again)', !!input && input.value === '' && !!$('[data-testid="quick-ai-context-note"]'));
key(input, 'Escape'); await waitFor(() => (!quickAiInput() ? true : null));

/* 5. nothing configured */
report('\n--- 5. nothing configured ---');
MODELS = NOTHING; forgetAiModelChoice(); requests.length = 0;
ta = await mount(CONTENT);
input = await askAbout(ta, 6, 19);
setNative(input, 'q'); await sleep(30); key(input, 'Enter');
area = await responseArea(ta);
check('nothing configured: the friendly "No AI provider configured" message, and no request', area?.value === NO_AI_PROVIDER_MESSAGE && requests.length === 0, `${JSON.stringify(area?.value)}; ${requests.length}`);
check('the sidebar never heard from this path', sidebarEvents.length === 0);
check('TextSelectionMenu offers "Ask AI About This" through onAskAI; the editor no longer dispatches the chat-context events from the selection menu', /onAskAI/.test(fs.readFileSync(path.join(REPO, 'src/components/features/documents/TextSelectionMenu.jsx'), 'utf8')) && !/handleAddSelectionAsContext/.test(fs.readFileSync(path.join(REPO, 'src/components/features/documents/DocumentEditor.jsx'), 'utf8')));

report(`\n${total - failures}/${total} checks passed`);
H.unmount();
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
