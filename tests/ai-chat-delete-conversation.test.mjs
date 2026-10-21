#!/usr/bin/env node
/**
 * The AI Chat sidebar's bin (src/components/common/AIChatSidebar.jsx): with
 * ONE conversation it CLEARS it in place (messages and contexts removed, the
 * default model applied - a fresh chat, same id), with several it removes
 * that one; a chat with messages or context asks first (ConfirmationModal),
 * an empty single one leaves the bin disabled (nothing to clear); a reply
 * still in flight is aborted and never lands in the emptied chat. Robin's
 * page (AIChatPage) already replaces a deleted last chat with a fresh one;
 * it now stops a running stream first (source check; robin-duplicate-chat
 * keeps its id guarantees).
 * Run: node tests/ai-chat-delete-conversation.test.mjs
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

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-delete-'));
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import AIChatSidebar from '@worktree/src/components/common/AIChatSidebar.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
let setView = null; let key = 0;
function Host() { const [view, set] = React.useState(null); setView = set; if (!view) return null; return React.createElement(AIChatSidebar, { key: view.key, isOpen: true, onClose: () => {} }); }
const whenReady = (fn) => { const go = () => (setView ? fn() : setTimeout(go, 10)); go(); };
window.__harness = { mount: () => whenReady(() => setView({ key: ++key })), unmount: () => whenReady(() => setView(null)) };
createRoot(document.getElementById('root')).render(React.createElement(NotificationProvider, null, React.createElement(Host)));
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
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
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'localStorage', 'sessionStorage']) define(name, window[name]);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); define('IntersectionObserver', FakeObserver); window.ResizeObserver = FakeObserver; window.IntersectionObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {}; window.HTMLElement.prototype.scrollTo = function () {};
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
const MODELS = { ollama: ['qwen3:30b', 'llama3'], anthropic: [], openai: [], gemini: [], ssh: [], defaults: { provider: 'ollama', model: 'qwen3:30b' } };
let pending = null;   // { resolve, reject, signal } of a chat request held open
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const stubFetch = (url, options = {}) => {
  const u = String(url);
  if (/\/api\/ai\/health/.test(u)) return Promise.resolve(json({ status: 'online' }));
  if (/\/api\/ai\/models/.test(u)) return Promise.resolve(json(MODELS));
  if (/\/api\/ai\/chat$/.test(u)) {
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const entry = { resolve: () => resolve(json({ message: 'LATE ANSWER' })), reject, signal };
      if (signal) signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      pending = entry;
    });
  }
  return Promise.resolve(json({}, 404));
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
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const setNative = (el, value) => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const bin = () => $('[data-testid="ai-chat-delete"]');
const chatInput = () => $$('textarea').find((t) => /Type your message|No AI models|offline/.test(t.placeholder));
const sendBtn = () => $$('button').find((b) => b.querySelector('svg.lucide-send'));
const stored = () => JSON.parse(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => /aiChatConversations$/.test(k))) || '[]');
const confirmButton = () => $$('button').find((b) => /^(Clear|Delete)$/.test(b.textContent.trim()));
window.localStorage.clear();
H.mount();
await waitFor(() => bin());
await sleep(300);

report('\n--- 1. the only conversation ---');
check('an empty only conversation: the bin is disabled (nothing to clear)', bin().disabled === true && /Nothing to clear/.test(bin().title));
setNative(chatInput(), 'Test'); await sleep(30); click(sendBtn());
await waitFor(() => (pending ? true : null));
check('a message in flight: the bin is enabled ("Clear conversation") and the request is pending', bin().disabled === false && /Clear conversation/.test(bin().title) && !!pending);
const firstId = stored()[0]?.id;
click(bin());
const confirmBtn = await waitFor(() => confirmButton());
check('the bin asks first: "Clear this conversation?"', !!confirmBtn && /Clear this conversation\?/.test(document.body.textContent));
click(confirmBtn);
await waitFor(() => (pending.signal.aborted ? true : null));
check('confirming aborts the pending request', pending.signal.aborted === true);
pending.resolve();   // the backend answers anyway - too late
await sleep(200);
const after = stored();
check('the conversation is cleared in place: same id, no messages, no context, the default model; the late answer never lands', after.length === 1 && after[0].id === firstId && after[0].messages.length === 0 && (after[0].contexts || []).length === 0 && after[0].settings.provider === 'ollama' && after[0].settings.model === 'qwen3:30b' && !/LATE ANSWER/.test(document.body.textContent), JSON.stringify(after.map((c) => [c.id, c.messages.length, c.settings])));
check('...and the bin is disabled again, the input free', bin().disabled === true && chatInput().disabled === false);

report('\n--- 2. a context counts as content ---');
window.dispatchEvent(new window.CustomEvent('addAIContext', { detail: { contextData: { kind: 'document', title: 'Doc', category: '', content: 'hello', source: { kind: 'document', id: 1 } } } }));
await waitFor(() => $('[data-testid="ai-context-chip"]'));
check('a new chat with a context: the bin is enabled; two conversations now, so it reads Delete', bin().disabled === false && stored().length === 2 && /Delete conversation/.test(bin().title));
click(bin());
const del = await waitFor(() => confirmButton());
check('it asks "Delete this conversation?"', !!del && /Delete this conversation\?/.test(document.body.textContent));
click($$('button').find((b) => b.textContent.trim() === 'Cancel'));
await sleep(50);
check('Cancel keeps it', stored().length === 2 && !!$('[data-testid="ai-context-chip"]'));
click(bin()); await waitFor(() => confirmButton()); click(confirmButton());
await waitFor(() => (stored().length === 1 ? true : null));
check('confirming with several conversations removes just that one; the other (cleared earlier) stays', stored().length === 1 && stored()[0].id === firstId && !$('[data-testid="ai-context-chip"]'));

report('\n--- 3. several, the current one empty ---');
window.dispatchEvent(new window.CustomEvent('addAIContext', { detail: { contextData: { kind: 'document', title: 'Doc', category: '', content: 'hello', source: { kind: 'document', id: 1 } } } }));
await waitFor(() => $('[data-testid="ai-context-chip"]'));
click($('[data-testid="ai-context-remove"]'));
await waitFor(() => (!$('[data-testid="ai-context-chip"]') ? true : null));
check('a second conversation emptied again (its context removed): the bin is enabled (several) and deletes without asking', bin().disabled === false && stored().length === 2, `${stored().length}`);
click(bin()); await sleep(100);
check('...gone at once, no dialog', stored().length === 1 && !confirmButton());

report('\n--- 4. Robin\'s page (source) ---');
const page = fs.readFileSync(path.join(REPO, 'src/components/AIChatPage.jsx'), 'utf8');
check('AIChatPage stops a running stream before deleting the current chat, and still replaces a deleted last chat with a fresh one on newChatSettings()', /conversationToDelete === currentConversationId && isLoading\) handleStopGeneration\(\);/.test(page) && /if \(filtered\.length === 0\) \{\s*const newConv = \{\s*id: newConversationId\(\)/.test(page) && /\.\.\.newChatSettings\(\),/.test(page));

report(`\n${total - failures}/${total} checks passed`);
H.unmount();
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
