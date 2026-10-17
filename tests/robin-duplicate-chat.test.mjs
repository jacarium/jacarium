/**
 * Robin (src/components/AIChatPage.jsx) on a fresh profile showed two
 * "New Chat 1" conversations, both highlighted. The page's mount effect
 * loads the conversations only after an awaited backend health check; in
 * development React runs the effect twice (StrictMode), so two loads ran
 * back to back before the first default chat had been saved, each created
 * one, and `Date.now()` gave both the same id - so both rows matched the
 * current id. Guards:
 *   - src/utils/aiConversations.js: new ids are UUIDs (collision-free);
 *     a stored id reads back as a number when it is one of the old
 *     numeric ids, as a string otherwise;
 *   - the real page under <StrictMode>, with the backend offline and an
 *     empty storage: exactly ONE conversation, one highlighted row, and
 *     the stored current id is that conversation's;
 *   - conversations stored by an earlier version with numeric ids load
 *     as they are (no new chat is added) and the stored numeric current
 *     id still selects its conversation;
 *   - the New chat button and "Clear All" make conversations with
 *     distinct ids even within one millisecond.
 * Needs jsdom (npm install --no-save jsdom fake-indexeddb).
 * Run: node tests/robin-duplicate-chat.test.mjs
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
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const dep of ['jsdom', 'esbuild', 'react']) { try { req.resolve(dep); } catch { console.error(`Missing dependency "${dep}". Run: npm install --no-save jsdom fake-indexeddb`); process.exit(1); } }

// ---- the id helpers, in plain Node ----
const ids = await import(path.join(REPO, 'src', 'utils', 'aiConversations.js'));
check('a stored numeric id (an earlier version\'s Date.now()) reads back as a number', ids.parseConversationId('1700000000000') === 1700000000000);
check('a stored UUID reads back as the string', ids.parseConversationId('3f2a-uuid') === '3f2a-uuid');
check('nothing stored reads back as null', ids.parseConversationId(null) === null && ids.parseConversationId('') === null);
const made = new Set(Array.from({ length: 2000 }, () => ids.newConversationId()));
check('2000 ids made in a burst are all different and never digits-only', made.size === 2000 && [...made].every((id) => typeof id === 'string' && !/^\d+$/.test(id)));
const built = ids.buildConversation({ name: 'New Chat 1', settings: { provider: 'ollama' } });
check('buildConversation: id, name, empty messages, createdAt, settings', typeof built.id === 'string' && built.name === 'New Chat 1' && built.messages.length === 0 && typeof built.createdAt === 'string' && built.settings.provider === 'ollama');

// ---- the real page in jsdom under StrictMode ----
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'robin-duplicate-'));
const ENTRY = path.join(WORK, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import AIChatPage from '@worktree/src/components/AIChatPage.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
export { React, StrictMode, act, createRoot, AIChatPage, NotificationProvider };
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  // development: the StrictMode double effect that made the page create two chats
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
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'localStorage', 'sessionStorage']) define(key, window[key]);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.scrollTo = function () {};
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// the backend is offline: every request fails at once (the health check
// resolves in the same tick for both of StrictMode's effect runs)
const offline = async () => { throw new TypeError('Failed to fetch'); };
globalThis.fetch = offline;
window.fetch = offline;
const silenced = ['[AI Chat Page]', 'Error fetching', 'AI backend'];
const origError = console.error;
console.error = (...args) => { if (!silenced.some((s) => String(args[0]).includes(s))) origError(...args); };

const { React, StrictMode, act, createRoot, AIChatPage, NotificationProvider } = req(BUNDLE);
const stored = () => JSON.parse(window.localStorage.getItem('aiChatPageConversations') || '[]');
const rows = () => Array.from(window.document.querySelectorAll('h3')).filter((h) => h.closest('[data-drawer-pick]'));
const highlighted = () => rows().filter((h) => /text-os-blue/.test(h.className));

async function mount() {
  const root = createRoot(window.document.getElementById('root'));
  await act(async () => { root.render(React.createElement(StrictMode, null, React.createElement(NotificationProvider, null, React.createElement(AIChatPage)))); });
  for (let i = 0; i < 40 && !window.localStorage.getItem('aiChatPageConversations'); i++) { await act(async () => { await sleep(25); }); }
  await act(async () => { await sleep(100); });
  return root;
}

try {
  // ---- 1. a fresh profile ----
  window.localStorage.clear();
  let root = await mount();
  let list = stored();
  check('1. a fresh profile gets exactly ONE default conversation', list.length === 1, `${list.length} stored: ${list.map((c) => c.name).join(', ')}`);
  check('   named "New Chat 1", with a UUID id (not a timestamp)', list[0]?.name === 'New Chat 1' && typeof list[0]?.id === 'string' && !/^\d+$/.test(list[0].id), JSON.stringify(list[0]?.id));
  check('   the list shows one row, and only one is highlighted', rows().length === 1 && highlighted().length === 1, `${rows().length} rows, ${highlighted().length} highlighted`);
  check('   the stored current id is that conversation\'s', window.localStorage.getItem('aiChatPageCurrentConversation') === String(list[0]?.id));
  // New chat twice in the same millisecond: distinct ids
  const newChat = () => Array.from(window.document.querySelectorAll('button[title="New chat"]'))[0];
  await act(async () => { newChat().click(); newChat().click(); });
  await act(async () => { await sleep(50); });
  list = stored();
  check('   two "New chat" taps in one tick make two conversations with distinct ids', list.length === 3 && new Set(list.map((c) => c.id)).size === 3, list.map((c) => `${c.name}:${c.id}`).join(' | '));
  check('   ...and one row is highlighted', highlighted().length === 1, String(highlighted().length));
  await act(async () => { root.unmount(); });

  // ---- 2. conversations from an earlier version, numeric ids ----
  window.localStorage.clear();
  const legacy = [
    { id: 1700000000001, name: 'Old chat A', messages: [], createdAt: '2026-01-01T00:00:00.000Z', settings: { provider: 'ollama', model: 'm', temperature: 0, maxTokens: 2000, datasets: { documentIds: [], lastUpdated: null } } },
    { id: 1700000000002, name: 'Old chat B', messages: [], createdAt: '2026-01-02T00:00:00.000Z', settings: { provider: 'ollama', model: 'm', temperature: 0, maxTokens: 2000, datasets: { documentIds: [], lastUpdated: null } } },
  ];
  window.localStorage.setItem('aiChatPageConversations', JSON.stringify(legacy));
  window.localStorage.setItem('aiChatPageCurrentConversation', '1700000000002');
  root = await mount();
  list = stored();
  check('2. stored conversations load as they are - no chat is added, numeric ids kept', list.length === 2 && list.every((c) => typeof c.id === 'number'), list.map((c) => `${c.name}:${c.id}`).join(' | '));
  check('   the stored numeric current id selects its conversation (one highlighted row: Old chat B)', highlighted().length === 1 && highlighted()[0].textContent.trim() === 'Old chat B', highlighted().map((h) => h.textContent.trim()).join(','));
  const headings = () => Array.from(window.document.querySelectorAll('h2')).map((h) => h.textContent.trim());
  check('   the chat header names it', headings().includes('Old chat B'), headings().join(' | '));
  await act(async () => { root.unmount(); });

  // ---- 3. a stored current id that no longer exists ----
  window.localStorage.setItem('aiChatPageConversations', JSON.stringify(legacy));
  window.localStorage.setItem('aiChatPageCurrentConversation', '42');
  root = await mount();
  check('3. a stale current id falls back to the first conversation (one highlighted)', highlighted().length === 1 && highlighted()[0].textContent.trim() === 'Old chat A', highlighted().map((h) => h.textContent.trim()).join(','));
  await act(async () => { root.unmount(); });
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  console.error = origError;
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
