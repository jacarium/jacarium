#!/usr/bin/env node
/**
 * Every one-off AI request honours Settings > Default AI Provider / Model.
 *
 * THE BUG (3.2.7, the desktop app and the web alike): "/ai" + Enter in the
 * Documents editor answered "Error: ANTHROPIC_API_KEY not found in
 * environment variables" whatever the default provider was. Quick AI, Ask
 * AI and Quick Notes' two AI panels took their settings from
 * localStorage.getItem('aiChatSettings') - a key nothing writes - and so
 * always fell back to the hard-coded {provider: 'anthropic', model: claude}.
 * They never read the Settings default, not from Electron's env file nor
 * from the backend. The quiz / grid generators read DEFAULT_AI_PROVIDER
 * from Electron's env file only, so on the web they too sent "anthropic".
 *
 * THE FIX: src/utils/aiRequestSettings.js resolveAiRequestSettings() - the
 * configured model list and the Settings defaults from /api/ai/models (the
 * backend reads the same settings store the Settings dialog writes: the
 * profile's env file on the desktop, the server's on the web), resolved
 * with Robin's order (saved choice if configured > DEFAULT_AI_MODEL >
 * DEFAULT_AI_PROVIDER's first model > the first configured); nothing
 * configured -> the entry point shows "No AI provider configured - set one
 * in Settings > AI." instead of the backend's error. The backend's
 * /api/ai/ask, /chat and /chat-stream treat a missing provider as the
 * configured default too (tests/ai_models_defaults.test.py).
 *
 * Proved here with the real components in jsdom and a recorded fetch:
 *   1. the resolver: desktop-style (electronAPI present with the profile's
 *      DEFAULT_AI_PROVIDER = ollama) and browser-style (no electronAPI): both
 *      take the defaults from /api/ai/models; nothing configured -> null;
 *   2. Quick AI in the real DocumentEditor, opened with "/ai" + Enter:
 *      default ollama -> the request goes to ollama with the default model;
 *      nothing configured -> the friendly message, no request;
 *   3. AskAIPopup: the same two cases;
 *   4. the quiz and grid generators: default ollama -> ollama; nothing
 *      configured -> they throw the friendly message; on the desktop the
 *      env file's DEFAULT_AI_MAX_TOKENS still raises the budget;
 *   5. FloatingDraft (source): both AI paths resolve the same way and show
 *      the message; no entry point reads the dead localStorage key as its
 *      only source any more.
 *
 * Run:  node tests/quick-ai-default-provider.test.mjs
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
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-ai-default-'));
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
import AskAIPopup from '@worktree/src/components/features/documents/AskAIPopup.jsx';
import { BUILTIN_COMMANDS } from '@worktree/src/utils/slashCommands.js';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
import * as aiRequestSettings from '@worktree/src/utils/aiRequestSettings.js';
import * as quiz from '@worktree/src/utils/aiQuizGenerator.js';
import * as grid from '@worktree/src/utils/aiGridGenerator.js';

const api = { aiRequestSettings, quiz, grid };
let setView = null;
let key = 0;
function Host() {
  const [view, set] = React.useState(null);
  setView = set;
  const [content, setContent] = React.useState('');
  api.getContent = () => content;
  api.setContent = setContent;
  if (!view) return null;
  if (view.kind === 'editor') return React.createElement(DocumentEditor, { key: view.key, documentId: 1, document: { id: 1, title: 'Notes', inCloud: false }, content, onContentChange: (e) => setContent(e.target.value), templates: BUILTIN_COMMANDS, locked: false, isOnline: true });
  if (view.kind === 'ask') return React.createElement(AskAIPopup, { key: view.key, visible: true, x: 10, y: 10, selectedText: 'explain this', onInsert: () => {}, onCancel: () => {} });
  return null;
}
const whenReady = (fn) => { const go = () => (setView ? fn() : setTimeout(go, 10)); go(); };
api.mount = (kind) => whenReady(() => setView({ kind, key: ++key }));
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
  'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'localStorage', 'sessionStorage', 'File', 'FileReader', 'Blob']) {
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
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
// AbortSignal.timeout exists in Node; the components use it on fetch
// ---- the stubbed backend ----
let MODELS = {};
const requests = [];
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const stubFetch = async (url, options = {}) => {
  const u = String(url);
  if (/\/api\/ai\/health/.test(u)) return json({ status: 'online' });
  if (/\/api\/ai\/models/.test(u)) return json(MODELS);
  if (/\/api\/ai\/ask/.test(u)) { requests.push({ url: u, body: JSON.parse(options.body || '{}') }); return json({ response: 'ANSWER' }); }
  if (/\/api\/ai\/chat/.test(u)) { requests.push({ url: u, body: JSON.parse(options.body || '{}') }); return json({ message: '[{"question":"q","options":["a","b","c","d"],"correctAnswer":0,"explanation":"e"}]' }); }
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
const setNative = (el, value) => { const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const key = (el, k, init = {}) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const OLLAMA = { ollama: ['qwen3:30b', 'llama3'], anthropic: [{ id: 'claude-sonnet-4-5', label: 'Claude' }], defaults: { provider: 'ollama', model: 'qwen3:30b' } };
const NOTHING = { anthropic: [], openai: [], gemini: [], ollama: [], defaults: { provider: '', model: '' } };
const { resolveAiRequestSettings, forgetAiModelChoice, NO_AI_PROVIDER_MESSAGE, buildModelOptions } = H.aiRequestSettings;

/* ---------- 1. the resolver ---------- */
report('\n--- 1. the resolver, desktop and browser ---');
check('the friendly message names Settings', /No AI provider configured/.test(NO_AI_PROVIDER_MESSAGE) && /Settings/.test(NO_AI_PROVIDER_MESSAGE));
check('buildModelOptions flattens the /api/ai/models answer like the chat UIs do', buildModelOptions(OLLAMA).map((o) => `${o.provider}:${o.model}`).join() === 'anthropic:claude-sonnet-4-5,ollama:qwen3:30b,ollama:llama3');
// desktop: electronAPI present, the profile's env file says ollama - the backend reads the same file, so /api/ai/models carries it
window.electronAPI = { platform: 'darwin', readEnvFile: async () => ({ DEFAULT_AI_PROVIDER: 'ollama', DEFAULT_AI_MODEL: 'qwen3:30b', DEFAULT_AI_MAX_TOKENS: '9000' }) };
MODELS = OLLAMA; forgetAiModelChoice();
let s = await resolveAiRequestSettings();
check('desktop (electronAPI present): default ollama/qwen3:30b', s && s.provider === 'ollama' && s.model === 'qwen3:30b' && s.temperature === 0 && s.maxTokens === 2000, JSON.stringify(s));
delete window.electronAPI;
forgetAiModelChoice();
s = await resolveAiRequestSettings({ temperature: 0.3, maxTokens: 4000 });
check('browser (no electronAPI): the same from /api/ai/models; the caller\'s temperature / max tokens', s && s.provider === 'ollama' && s.model === 'qwen3:30b' && s.temperature === 0.3 && s.maxTokens === 4000, JSON.stringify(s));
MODELS = { ...OLLAMA, defaults: { provider: 'ollama', model: 'gone' } }; forgetAiModelChoice();
s = await resolveAiRequestSettings();
check('the default model missing from the list: the default provider\'s first model', s && s.provider === 'ollama' && s.model === 'qwen3:30b', JSON.stringify(s));
MODELS = { ...OLLAMA, defaults: { provider: '', model: '' } }; forgetAiModelChoice();
s = await resolveAiRequestSettings({ saved: { provider: 'ollama', model: 'llama3' } });
check('a saved choice wins when it is configured', s && s.model === 'llama3', JSON.stringify(s));
s = await resolveAiRequestSettings({ saved: { provider: 'openai', model: 'gpt-4' } });
check('a saved choice that is not configured is ignored (the first configured model)', s && s.provider === 'anthropic', JSON.stringify(s));
MODELS = NOTHING; forgetAiModelChoice();
s = await resolveAiRequestSettings();
check('nothing configured -> null', s === null);

/* ---------- 2. Quick AI in the editor ---------- */
report('\n--- 2. Quick AI ("/ai" + Enter) in the real editor ---');
async function quickAi(models) {
  MODELS = models; forgetAiModelChoice(); requests.length = 0;
  await waitFor(() => H.setContent);
  H.unmount(); await waitFor(() => (!$('textarea') ? true : null));
  H.setContent('');
  H.mount('editor');
  const ta = await waitFor(() => $('textarea'));
  await sleep(50);
  setNative(ta, '/ai');
  ta.setSelectionRange(3, 3);
  await waitFor(() => (H.getContent() === '/ai' ? true : null));
  await sleep(80);
  key(ta, 'Enter');
  const input = await waitFor(() => $('input[placeholder="for loop in bash, sort function..."]'));
  if (!input) return { input: null };
  setNative(input, 'sort a list');
  await sleep(30);
  key(input, 'Enter');
  await sleep(150);
  const area = await waitFor(() => { const t = Array.from(document.querySelectorAll('textarea')).find((x) => x !== ta && x.value && x.value !== 'Generating response...'); return t || null; }, 3000);
  return { input, text: area ? area.value : null };
}
let r = await quickAi(OLLAMA);
check('"/ai" + Enter opens Quick AI; Enter in its input sends ONE request to /api/ai/ask with provider ollama and the default model', !!r.input && requests.length === 1 && /\/api\/ai\/ask$/.test(requests[0].url) && requests[0].body.provider === 'ollama' && requests[0].body.model === 'qwen3:30b', JSON.stringify(requests.map((x) => [x.url, x.body.provider, x.body.model])));
check('...and shows the answer', r.text === 'ANSWER', r.text);
r = await quickAi(NOTHING);
check('nothing configured: the friendly message in the response area, and NO request', !!r.input && requests.length === 0 && r.text === NO_AI_PROVIDER_MESSAGE, `${requests.length} requests; ${JSON.stringify(r.text)}`);
H.unmount(); await sleep(50);

/* ---------- 3. Ask AI ---------- */
report('\n--- 3. Ask AI (AskAIPopup) ---');
async function askAi(models) {
  MODELS = models; forgetAiModelChoice(); requests.length = 0;
  H.unmount(); await sleep(30);
  H.mount('ask');
  const prompt = await waitFor(() => $('input[placeholder="e.g., Explain this, Fix this code, Summarize..."], textarea[placeholder="e.g., Explain this, Fix this code, Summarize..."]'));
  if (!prompt) return { prompt: null };
  setNative(prompt, 'explain');
  await sleep(30);
  key(prompt, 'Enter');
  await sleep(150);
  const area = await waitFor(() => { const t = Array.from(document.querySelectorAll('textarea')).find((x) => x.value && /ANSWER|No AI provider|Error/.test(x.value)); return t || null; }, 3000);
  return { prompt, text: area ? area.value : null };
}
r = await askAi(OLLAMA);
check('Ask AI sends its request to ollama with the default model', !!r.prompt && requests.length === 1 && requests[0].body.provider === 'ollama' && requests[0].body.model === 'qwen3:30b' && r.text === 'ANSWER', JSON.stringify(requests.map((x) => [x.body.provider, x.body.model])) + ' ' + r.text);
r = await askAi(NOTHING);
check('Ask AI, nothing configured: the friendly message, no request', !!r.prompt && requests.length === 0 && r.text === NO_AI_PROVIDER_MESSAGE, `${requests.length}; ${JSON.stringify(r.text)}`);
H.unmount(); await sleep(50);

/* ---------- 4. the generators ---------- */
report('\n--- 4. the quiz and grid generators ---');
MODELS = OLLAMA; forgetAiModelChoice(); requests.length = 0;
// (the stubbed answer is not a usable quiz - only the request matters here)
const attempt = async (fn) => { try { return await fn(); } catch (e) { return e; } };
await attempt(() => H.quiz.generateAIQuizQuestions({ topic: 'bash', numQuestions: 1, difficultyYears: 3 }));
check('generateAIQuizQuestions (browser) sends provider ollama with the default model to /api/ai/chat', requests.length === 1 && /\/api\/ai\/chat$/.test(requests[0].url) && requests[0].body.provider === 'ollama' && requests[0].body.model === 'qwen3:30b', JSON.stringify(requests.map((x) => [x.url, x.body.provider, x.body.model, x.body.maxTokens])));
window.electronAPI = { platform: 'darwin', readEnvFile: async () => ({ DEFAULT_AI_PROVIDER: 'ollama', DEFAULT_AI_MODEL: 'qwen3:30b', DEFAULT_AI_MAX_TOKENS: '9000' }) };
requests.length = 0;
await attempt(() => H.quiz.generateAIQuizQuestions({ topic: 'bash', numQuestions: 1, difficultyYears: 3 }));
check('...on the desktop too, and DEFAULT_AI_MAX_TOKENS from the env file raises the budget', requests.length === 1 && requests[0].body.provider === 'ollama' && requests[0].body.maxTokens === 9000, JSON.stringify(requests.map((x) => [x.body.provider, x.body.maxTokens])));
delete window.electronAPI;
MODELS = NOTHING; forgetAiModelChoice(); MODELS = OLLAMA; forgetAiModelChoice(); requests.length = 0;
const gridOut = await attempt(() => H.grid.generateCategoryFromTopic({ categoryName: 'c', topicName: 'bash' }));
check('generateCategoryFromTopic sends provider ollama too', requests.length === 1 && requests[0].body.provider === 'ollama', `${JSON.stringify(requests.map((x) => [x.body.provider, x.body.model]))} ${gridOut instanceof Error ? gridOut.message : ''}`);
MODELS = NOTHING; forgetAiModelChoice(); requests.length = 0;
let threw = null;
try { await H.quiz.generateAIQuizQuestions({ topic: 'bash', numQuestions: 1 }); } catch (e) { threw = e; }
check('nothing configured: the quiz generator throws the friendly message and sends nothing', threw && threw.message === NO_AI_PROVIDER_MESSAGE && requests.length === 0, String(threw && threw.message));
threw = null;
try { await H.grid.generateCategoryFromTopic({ categoryName: 'c', topicName: 'bash' }); } catch (e) { threw = e; }
check('nothing configured: the grid generator throws it too', threw && threw.message === NO_AI_PROVIDER_MESSAGE && requests.length === 0, String(threw && threw.message));

/* ---------- 5. sources ---------- */
report('\n--- 5. sources ---');
const draft = fs.readFileSync(path.join(REPO, 'src/components/FloatingDraft.jsx'), 'utf8');
check('FloatingDraft: both AI paths resolve through resolveAiRequestSettings and show the message when nothing is configured', (draft.match(/await resolveAiRequestSettings\(\{ saved: savedAiChatSettings\(\) \}\)/g) || []).length === 2 && /setAskAIResponse\(NO_AI_PROVIDER_MESSAGE\)/.test(draft) && /setQuickAIResponse\(NO_AI_PROVIDER_MESSAGE\)/.test(draft) && !/provider: 'anthropic'/.test(draft));
for (const f of ['src/components/features/documents/DocumentEditor.jsx', 'src/components/features/documents/AskAIPopup.jsx', 'src/utils/aiQuizGenerator.js', 'src/utils/aiGridGenerator.js']) {
  const src = fs.readFileSync(path.join(REPO, f), 'utf8');
  check(`${path.basename(f)}: no hard-coded provider 'anthropic' and no env-only DEFAULT_AI_PROVIDER left`, !/provider: 'anthropic'/.test(src) && !/envVars\.DEFAULT_AI_PROVIDER/.test(src));
}
const backend = fs.readFileSync(path.join(REPO, 'backend/ai_chat.py'), 'utf8');
check('backend: /api/ai/ask, /chat and /chat-stream take a missing provider as the configured default (request_provider)', (backend.match(/request_provider\(data, '/g) || []).length === 3 && /setting\('DEFAULT_AI_PROVIDER', ''\) or fallback_provider/.test(backend));

report(`\n${total - failures}/${total} checks passed`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
