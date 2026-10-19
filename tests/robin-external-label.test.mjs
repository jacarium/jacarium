#!/usr/bin/env node
/**
 * Robin never calls a local model "external".
 *
 * When Robin was first opened on a profile with only Ollama configured, it
 * showed the yellow "Using External AI Provider" warning - and would have
 * sent the first message to Anthropic - although the header read
 * "Ollama - <model>". A new chat starts with placeholder settings
 * (provider 'anthropic'); the header resolved the model option by falling
 * back to the FIRST configured model, but the warning and the request used
 * the saved placeholder until a model was picked by hand.
 *
 * src/components/AIChatPage.jsx now derives the settings in force from the
 * configured model list: the conversation's own when its model is among
 * them, else the first configured model's - what the header shows IS what
 * is warned about and sent to. Until /api/ai/models has answered the page
 * shows neither the warning nor the "No AI Models Configured" state (and
 * does not send). src/components/common/AIChatSidebar.jsx resolves its
 * settings the same way.
 *
 * Proved with the real AIChatPage in jsdom, the backend stubbed (health ok,
 * models answered after a delay, the chat request recorded), polling the
 * DOM on every tick while the models load:
 *   1. a fresh profile, Ollama only: "External" never appears, before or
 *      after the models load; the header names the Ollama model; a sent
 *      message goes to provider "ollama" with that model;
 *   2. a fresh profile, Anthropic only: the warning appears once the models
 *      are known (not before), the message goes to Anthropic;
 *   3. an existing conversation saved with Ollama, Ollama configured: no
 *      warning; one saved with Anthropic, both configured: the warning;
 *   4. a saved conversation whose model is no longer configured (Ollama
 *      only left): the first configured model is in force, no warning;
 *   5. the Settings default (DEFAULT_AI_PROVIDER / DEFAULT_AI_MODEL, carried
 *      by /api/ai/models) decides a chat's starting model: saved > default
 *      model > default provider's first > first; new chats are stored so;
 *   6. the sidebar resolves its settings the same way (source check).
 * Needs jsdom (npm install --no-save jsdom).
 * Run: node tests/robin-external-label.test.mjs
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
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const dep of ['jsdom', 'esbuild', 'react']) { try { req.resolve(dep); } catch { console.log(`SKIP: missing "${dep}" (npm install --no-save jsdom)`); process.exit(0); } }

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-external-'));
const ENTRY = path.join(WORK, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AIChatPage from '@worktree/src/components/AIChatPage.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
export { React, act, createRoot, AIChatPage, NotificationProvider };
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

const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'DOMParser']) define(key, window[key]);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.scrollTo = function () {};
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---- the stubbed backend: health at once, the model list after a delay, the chat request recorded ----
let MODELS = {};
let MODELS_DELAY = 120;
const requests = [];
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const stubFetch = async (url, options = {}) => {
  const u = String(url);
  if (/\/api\/ai\/health/.test(u)) return json({ status: 'online' });
  if (/\/api\/ai\/models/.test(u)) { await sleep(MODELS_DELAY); return json(MODELS); }
  if (/\/api\/ai\/chat/.test(u)) {
    requests.push({ url: u, body: JSON.parse(options.body || '{}') });
    // a minimal SSE stream the page can read to the end
    const text = 'data: {"type":"content","content":"ok"}\n\ndata: {"type":"done"}\n\n';
    const encoder = new TextEncoder();
    let sent = false;
    return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: encoder.encode(text) })), releaseLock() {} }) }, json: async () => ({ message: 'ok' }) };
  }
  return json({}, 404);
};
globalThis.fetch = stubFetch; window.fetch = stubFetch;
const silenced = ['[AI Chat Page]', '[Stream]', 'Error fetching', 'AI backend', 'Warning:', 'act('];
const origError = console.error; const origLog = console.log; const origWarn = console.warn;
const quiet = (fn) => (...args) => { if (!silenced.some((s) => String(args[0]).includes(s))) fn(...args); };
console.error = quiet(origError); console.warn = quiet(origWarn);
console.log = (...args) => { if (/^(PASS|FAIL|SKIP)/.test(String(args[0]))) origLog(...args); };

const { React, act, createRoot, AIChatPage, NotificationProvider } = req(BUNDLE);
const bodyText = () => window.document.body.textContent;
const warning = () => /Using External AI Provider/.test(bodyText());
const noModels = () => /No AI Models Configured/.test(bodyText());
const headerModel = () => { const btn = Array.from(window.document.querySelectorAll('button')).find((b) => /^(Anthropic|Ollama|OpenAI|Gemini|SSH) - /.test(b.textContent.trim()) || /Select model/.test(b.textContent)); return btn ? btn.textContent.trim() : null; };

/** Mount, and watch the DOM on every tick until the model list has arrived. Returns what was seen while loading. */
async function mountWatching() {
  const root = createRoot(window.document.getElementById('root'));
  await act(async () => { root.render(React.createElement(NotificationProvider, null, React.createElement(AIChatPage))); });
  const seen = { warningWhileLoading: false, noModelsWhileLoading: false, ticks: 0 };
  for (let i = 0; i < 60; i++) {
    await act(async () => { await sleep(10); });
    seen.ticks++;
    if (headerModel() && !/Select model/.test(headerModel())) break; // the list has arrived
    if (warning()) seen.warningWhileLoading = true;
    if (noModels()) seen.noModelsWhileLoading = true;
  }
  await act(async () => { await sleep(60); });
  return { root, seen };
}
async function send(text) {
  const ta = window.document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => { setter.call(ta, text); ta.dispatchEvent(new window.Event('input', { bubbles: true })); });
  const btn = Array.from(window.document.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-send'));
  if (!btn) return null;
  await act(async () => { btn.click(); });
  await act(async () => { await sleep(80); });
  return requests[requests.length - 1] || null;
}
const conversation = (settings) => ({ id: 'conv-1', name: 'Saved chat', messages: [], createdAt: '2026-01-01T00:00:00.000Z', settings: { temperature: 0, maxTokens: 2000, datasets: { documentIds: [], lastUpdated: null }, ...settings } });

try {
  // ---- 1. a fresh profile, Ollama only ----
  window.localStorage.clear(); requests.length = 0;
  MODELS = { ollama: ['qwen3:30b-a3b-thinking-2507-q4_K_M'] };
  let { root, seen } = await mountWatching();
  check('1. Ollama only, fresh profile: "Using External AI Provider" never appears while the models load', !seen.warningWhileLoading, `${seen.ticks} ticks`);
  check('   ...nor "No AI Models Configured" (the page waits for the list)', !seen.noModelsWhileLoading);
  check('   ...nor after: the header names the Ollama model, no warning', !warning() && /^Ollama - qwen3/.test(headerModel() || ''), headerModel());
  let r = await send('hello');
  check('   a message goes to provider "ollama" with that model', r && r.body.provider === 'ollama' && /^qwen3/.test(r.body.model), JSON.stringify(r && { provider: r.body.provider, model: r.body.model }));
  await act(async () => { root.unmount(); });

  // ---- 2. a fresh profile, Anthropic only ----
  window.localStorage.clear(); requests.length = 0;
  MODELS = { anthropic: [{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }] };
  ({ root, seen } = await mountWatching());
  check('2. Anthropic only, fresh profile: no warning before the models are known', !seen.warningWhileLoading);
  check('   ...the warning once they are (a cloud provider is external)', warning() && /^Anthropic - Claude Sonnet 4.5/.test(headerModel() || ''), headerModel());
  r = await send('hello');
  check('   the message goes to Anthropic', r && r.body.provider === 'anthropic' && r.body.model === 'claude-sonnet-4-5', JSON.stringify(r && r.body.provider));
  await act(async () => { root.unmount(); });

  // ---- 3. existing conversations with a saved provider ----
  window.localStorage.clear(); requests.length = 0;
  MODELS = { ollama: ['llama3'], anthropic: [{ id: 'claude-sonnet-4-5', label: 'Claude' }] };
  window.localStorage.setItem('aiChatPageConversations', JSON.stringify([conversation({ provider: 'ollama', model: 'llama3' })]));
  window.localStorage.setItem('aiChatPageCurrentConversation', 'conv-1');
  ({ root, seen } = await mountWatching());
  check('3. a saved Ollama conversation (both providers configured): no warning at any point, header Ollama', !seen.warningWhileLoading && !warning() && /^Ollama - llama3/.test(headerModel() || ''), headerModel());
  await act(async () => { root.unmount(); });
  window.localStorage.clear();
  window.localStorage.setItem('aiChatPageConversations', JSON.stringify([conversation({ provider: 'anthropic', model: 'claude-sonnet-4-5' })]));
  window.localStorage.setItem('aiChatPageCurrentConversation', 'conv-1');
  ({ root, seen } = await mountWatching());
  check('   a saved Anthropic conversation: the warning (after the list), header Anthropic', !seen.warningWhileLoading && warning() && /^Anthropic - Claude/.test(headerModel() || ''), headerModel());
  await act(async () => { root.unmount(); });

  // ---- 4. a saved model that is no longer configured ----
  window.localStorage.clear(); requests.length = 0;
  MODELS = { ollama: ['llama3'] };
  window.localStorage.setItem('aiChatPageConversations', JSON.stringify([conversation({ provider: 'anthropic', model: 'claude-sonnet-4-5' })]));
  window.localStorage.setItem('aiChatPageCurrentConversation', 'conv-1');
  ({ root, seen } = await mountWatching());
  check('4. a saved Anthropic conversation with only Ollama left: the first configured model is in force, no warning', !warning() && /^Ollama - llama3/.test(headerModel() || ''), headerModel());
  r = await send('hello');
  check('   ...and the message goes to Ollama, not to the unconfigured Anthropic', r && r.body.provider === 'ollama' && r.body.model === 'llama3', JSON.stringify(r && r.body.provider));
  await act(async () => { root.unmount(); });

  // ---- 5. the Settings default decides a chat's starting model (shared order, desktop and web) ----
  const { resolveModelOption } = await import(path.join(REPO, 'src', 'utils', 'aiDefaults.js'));
  const opts = [{ provider: 'anthropic', model: 'claude' }, { provider: 'ollama', model: 'llama3' }, { provider: 'ollama', model: 'qwen3' }];
  check('5. resolveModelOption: the saved model wins when listed; else DEFAULT_AI_MODEL; else the default provider\'s first; else the first; null for an empty list',
    resolveModelOption(opts, { provider: 'ollama', model: 'qwen3' }, { provider: 'anthropic', model: 'claude' }).model === 'qwen3'
    && resolveModelOption(opts, { provider: 'openai', model: 'gpt' }, { provider: 'ollama', model: 'qwen3' }).model === 'qwen3'
    && resolveModelOption(opts, null, { provider: 'ollama', model: 'gone' }).model === 'llama3'
    && resolveModelOption(opts, null, { provider: '', model: 'qwen3' }).model === 'qwen3'
    && resolveModelOption(opts, null, { provider: 'gemini', model: '' }).model === 'claude'
    && resolveModelOption(opts, null, null).model === 'claude'
    && resolveModelOption([], null, { provider: 'ollama', model: 'llama3' }) === null);
  const stored = () => JSON.parse(window.localStorage.getItem('aiChatPageConversations') || '[]');
  const BOTH = { anthropic: [{ id: 'claude-sonnet-4-5', label: 'Claude' }], ollama: ['llama3', 'qwen3'] };

  window.localStorage.clear(); requests.length = 0;
  MODELS = { ...BOTH, defaults: { provider: 'ollama', model: 'llama3' } };
  ({ root, seen } = await mountWatching());
  check('   both configured, default = ollama/llama3, fresh profile: Ollama - llama3, no warning', !seen.warningWhileLoading && !warning() && /^Ollama - llama3/.test(headerModel() || ''), headerModel());
  check('   ...and the new chat is STORED with ollama/llama3 (not the Claude placeholder)', await (async () => { for (let i = 0; i < 20; i++) { const c = stored()[0]; if (c?.settings?.provider === 'ollama' && c.settings.model === 'llama3') return true; await act(async () => { await sleep(20); }); } return false; })(), JSON.stringify(stored()[0]?.settings));
  r = await send('hello');
  check('   the message goes to ollama/llama3', r && r.body.provider === 'ollama' && r.body.model === 'llama3', JSON.stringify(r && r.body.provider));
  await act(async () => { const b = Array.from(window.document.querySelectorAll('button[title="New chat"]'))[0]; if (b) b.click(); });
  await act(async () => { await sleep(60); });
  check('   a New chat starts from the default too', stored()[0]?.settings?.provider === 'ollama' && stored()[0]?.settings?.model === 'llama3', JSON.stringify(stored()[0]?.settings));
  await act(async () => { root.unmount(); });

  window.localStorage.clear(); requests.length = 0;
  MODELS = { ...BOTH, defaults: { provider: 'anthropic', model: 'claude-sonnet-4-5' } };
  ({ root, seen } = await mountWatching());
  check('   both configured, default = anthropic: Claude, with the warning', warning() && /^Anthropic - Claude/.test(headerModel() || ''), headerModel());
  await act(async () => { root.unmount(); });

  window.localStorage.clear(); requests.length = 0;
  MODELS = { ...BOTH, defaults: { provider: 'ollama', model: 'not-installed' } };
  ({ root, seen } = await mountWatching());
  check('   the default model missing from the list: the default provider\'s first model (Ollama - llama3), no warning', !warning() && /^Ollama - llama3/.test(headerModel() || ''), headerModel());
  await act(async () => { root.unmount(); });

  window.localStorage.clear(); requests.length = 0;
  MODELS = { ...BOTH, defaults: { provider: '', model: '' } };
  ({ root, seen } = await mountWatching());
  check('   no default: the first in the list (Anthropic comes first), with the warning', warning() && /^Anthropic - Claude/.test(headerModel() || ''), headerModel());
  await act(async () => { root.unmount(); });

  window.localStorage.clear(); requests.length = 0;
  MODELS = { ...BOTH, defaults: { provider: 'anthropic', model: 'claude-sonnet-4-5' } };
  window.localStorage.setItem('aiChatPageConversations', JSON.stringify([conversation({ provider: 'ollama', model: 'qwen3' })]));
  window.localStorage.setItem('aiChatPageCurrentConversation', 'conv-1');
  ({ root, seen } = await mountWatching());
  check('   a saved conversation still wins over the default (saved ollama/qwen3, default anthropic): Ollama - qwen3, no warning', !warning() && /^Ollama - qwen3/.test(headerModel() || '') && stored()[0]?.settings?.model === 'qwen3', headerModel());
  await act(async () => { root.unmount(); });

  // ---- 6. the sidebar ----
  const sidebar = fs.readFileSync(path.join(REPO, 'src/components/common/AIChatSidebar.jsx'), 'utf8');
  check('6. AIChatSidebar resolves its settings through the same resolveModelOption (savedSettings, the API defaults) and starts a new chat from it',
    /const savedSettings = currentConversation\?\.settings \|\| \{/.test(sidebar) && /const currentModelOption = resolveModelOption\(modelOptions, savedSettings, aiDefaults\);/.test(sidebar) && /setAiDefaults\(\{ provider: models\.defaults\?\.provider/.test(sidebar) && /settings: newChatSettings\(\)/.test(sidebar) && /const noModelsConfigured = modelsLoaded && modelOptions\.length === 0;/.test(sidebar));
  const page = fs.readFileSync(path.join(REPO, 'src/components/AIChatPage.jsx'), 'utf8');
  check('   AIChatPage gates the warning and the empty state on modelsLoaded', /modelsLoaded && !noModelsConfigured && aiSettings\.provider !== 'ollama'/.test(page) && /const noModelsConfigured = modelsLoaded && modelOptions\.length === 0;/.test(page));
} catch (e) {
  check('the run completed', false, `${e.message}\n${e.stack}`);
}
fs.rmSync(WORK, { recursive: true, force: true });
origLog(`\n${failed ? `${failed} check(s) failed` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
