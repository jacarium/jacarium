/**
 * Reproduction + regression guard for the "asked a second question, AI
 * answered the first one again" report (AIChatPage.jsx streaming flow).
 *
 * Mounts the REAL AIChatPage in jsdom (same esbuild/@worktree machinery as
 * ai-chat-markdown-rendering.test.mjs), mocks the backend fetch with
 * controlled SSE streams that faithfully implement AbortSignal semantics
 * (pending reads reject on abort, like Chromium), and drives multi-turn
 * conversations through the component's own handleSendMessage /
 * handleStreamingResponse. Asserts, per scenario:
 *
 *  A. Sequential two-turn chat: turn-2 request body carries the full
 *     [Q1, A1, Q2] history (Q2 last), and each answer lands in its own
 *     bubble.
 *  B. Stop mid-stream then ask again: after clicking Stop, the aborted
 *     stream must not write into the next question's placeholder, and the
 *     next request's history must end with the new question.
 *  C. Backend mid-stream {error} event: must terminate the stream loop,
 *     surface the error to the user, and not leave a forever-bouncing
 *     empty placeholder (guards the swallowed-throw bug: `throw new
 *     Error(data.error)` was caught by its own enclosing catch).
 *  D. Data after the `done` SSE event must NOT be appended to the message
 *     (guards the break-only-exits-inner-for-loop bug).
 *
 * Run:  node tests/ai-chat-second-question-stream.test.mjs
 * Preconditions: npm install  (plus: npm install --no-save jsdom)
 * Exit code 0 = all checks passed, 1 = failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

function requireResolvable(name, hint) {
  try { req.resolve(name); } catch {
    console.error(`Missing dependency "${name}". ${hint}`);
    process.exit(1);
  }
}
requireResolvable('react', 'Run: npm install');
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-second-question-'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// ---------- harness entry: mount the real page ----------
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import AIChatPage from '@worktree/src/components/AIChatPage.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';

window.__harness = {
  mountPage() {
    const root = createRoot(document.getElementById('root'));
    root.render(
      <NotificationProvider>
        <AIChatPage />
      </NotificationProvider>
    );
    return root;
  },
};
`);

const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY],
  bundle: true,
  outfile: BUNDLE,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
  nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{
    name: 'alias',
    setup(b) {
      b.onResolve({ filter: /^@worktree\// }, (args) => ({
        path: path.join(REPO, args.path.replace(/^@worktree\//, '')),
      }));
      b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => {
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        try { return { path: req.resolve(args.path) }; } catch { return null; }
      });
    },
  }],
  logLevel: 'warning',
});

// ---------- jsdom environment ----------
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
const define = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};
define('window', window);
define('document', window.document);
define('navigator', window.navigator);
define('HTMLElement', window.HTMLElement);
define('HTMLTextAreaElement', window.HTMLTextAreaElement);
define('HTMLInputElement', window.HTMLInputElement);
define('Element', window.Element);
define('Node', window.Node);
define('Event', window.Event);
define('KeyboardEvent', window.KeyboardEvent);
define('MouseEvent', window.MouseEvent);
define('CustomEvent', window.CustomEvent);
define('MutationObserver', window.MutationObserver);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('localStorage', window.localStorage);
define('sessionStorage', window.sessionStorage);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.scrollTo = function () {};
window.matchMedia = window.matchMedia || ((q) => ({
  matches: false, media: q,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, dispatchEvent() { return false; },
}));

// ---------- seed: one empty Ollama conversation, no datasets ----------
const conversation = {
  id: 1,
  name: 'Ollama Chat',
  createdAt: new Date().toISOString(),
  messages: [],
  settings: {
    provider: 'ollama',
    model: 'synthetic-local-model',
    temperature: 0.1,
    maxTokens: 2000,
    datasets: { documentIds: [], lastUpdated: null },
  },
};
window.localStorage.setItem('aiChatPageConversations', JSON.stringify([conversation]));
window.localStorage.setItem('aiChatPageCurrentConversation', '1');

// ---------- mocked backend fetch with faithful abort semantics ----------
const encoder = new TextEncoder();
const jsonResp = (obj) => new Response(JSON.stringify(obj), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

// Every /api/ai/chat-stream call is recorded here with its parsed body and
// an SSE driver: emit(obj) sends one `data:` event, close() ends the stream.
// Abort semantics mirror Chromium: aborting the signal errors the stream so
// a pending reader.read() rejects with AbortError.
const streamRequests = [];
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes('/api/ai/health')) return jsonResp({ status: 'ok' });
  if (u.includes('/api/ai/models')) {
    return jsonResp({
      anthropic: [], openai: [], gemini: [],
      ollama: ['synthetic-local-model'], ssh: [],
    });
  }
  if (u.includes('/api/ai/chat-stream') || u.includes('/api/ai/chat-rag-stream')) {
    let controller = null;
    const record = {
      url: u,
      body: JSON.parse(options.body),
      aborted: false,
      closed: false,
      emit(obj) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      },
      close() { this.closed = true; try { controller.close(); } catch { /* already errored */ } },
    };
    const stream = new ReadableStream({ start(c) { controller = c; } });
    if (options.signal) {
      const onAbort = () => {
        record.aborted = true;
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        try { controller.error(err); } catch { /* already closed */ }
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort);
    }
    streamRequests.push(record);
    return new Response(stream, { status: 200 });
  }
  return new Response('not found', { status: 404 });
};
window.fetch = globalThis.fetch;

// silence the component's [Stream]/[Stream Debug] chatter
const realLog = console.log;
const realErr = console.error;
console.log = () => {};
console.error = () => {};

createRequire(import.meta.url)(BUNDLE);
const harness = window.__harness;

// ---------- driver helpers ----------
const textarea = () => [...window.document.querySelectorAll('textarea')]
  .find((t) => t.placeholder === 'Type your message...');
const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;

async function typeAndSend(text) {
  const ta = textarea();
  if (!ta || ta.disabled) throw new Error(`textarea unavailable (disabled=${ta?.disabled})`);
  valueSetter.call(ta, text);
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(30);
  ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(80); // let handleSendMessage reach the fetch
}

function stopButton() {
  return [...window.document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === 'Stop');
}

// The stored conversation state is the ground truth the NEXT request is
// built from; read it back the same way the component persists it.
function storedMessages() {
  return JSON.parse(window.localStorage.getItem('aiChatPageConversations'))[0].messages;
}

const roleContent = (msgs) => msgs.map((m) => `${m.role}:${m.content}`);

let exitCode = 1;
try {
  harness.mountPage();
  let ta = null;
  for (let i = 0; i < 50 && !ta; i++) {
    await sleep(100);
    ta = textarea();
  }
  console.log = realLog;
  console.error = realErr;
  check('real AIChatPage mounted with seeded Ollama conversation', !!ta);

  // ================= scenario A: sequential two-turn chat =================
  console.log = () => {}; console.error = () => {};
  await typeAndSend('What is the capital of France?');
  const req1 = streamRequests[0];
  check('A: turn-1 request issued', !!req1, `streamRequests=${streamRequests.length}`);
  check('A: turn-1 history is exactly [Q1]',
    req1 && roleContent(req1.body.messages).join('|') === 'user:What is the capital of France?',
    req1 && JSON.stringify(roleContent(req1.body.messages)));

  for (const c of ['The capital', ' of France', ' is Paris.']) {
    req1.emit({ type: 'content', content: c });
    await sleep(40);
  }
  req1.emit({ type: 'done' });
  await sleep(40);
  req1.close();
  await sleep(200);
  console.log = realLog; console.error = realErr;

  check('A: turn-1 answer rendered and input re-enabled',
    window.document.body.textContent.includes('The capital of France is Paris.') &&
    textarea() && !textarea().disabled,
    `disabled=${textarea()?.disabled}`);

  console.log = () => {}; console.error = () => {};
  await typeAndSend('How many moons does Mars have?');
  const req2 = streamRequests[1];
  check('A: turn-2 request issued', !!req2, `streamRequests=${streamRequests.length}`);
  check('A: turn-2 history is [Q1, A1, Q2] with Q2 last',
    req2 && roleContent(req2.body.messages).join('|') ===
      'user:What is the capital of France?|assistant:The capital of France is Paris.|user:How many moons does Mars have?',
    req2 && JSON.stringify(roleContent(req2.body.messages)));

  for (const c of ['Mars has', ' two moons.']) {
    req2.emit({ type: 'content', content: c });
    await sleep(40);
  }
  req2.emit({ type: 'done' });
  await sleep(40);
  req2.close();
  await sleep(200);
  console.log = realLog; console.error = realErr;

  {
    const msgs = storedMessages();
    check('A: turn-2 answer stored in its own message slot',
      msgs.length === 4 &&
      msgs[2].content === 'How many moons does Mars have?' &&
      msgs[3].role === 'assistant' && msgs[3].content === 'Mars has two moons.',
      JSON.stringify(roleContent(msgs)));
  }

  // ============ scenario B: Stop mid-stream, then ask the next question ====
  console.log = () => {}; console.error = () => {};
  await typeAndSend('Tell me a very long story about whales.');
  const req3 = streamRequests[2];
  req3.emit({ type: 'content', content: 'Once upon a time' });
  await sleep(80);

  const stop = stopButton();
  check('B: Stop button visible during streaming', !!stop);
  stop.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  check('B: fetch actually aborted on Stop', req3.aborted);
  check('B: input re-enabled after Stop', textarea() && !textarea().disabled);

  await typeAndSend('What is 2+2?');
  const req4 = streamRequests[3];

  // Even if a rogue late chunk from the stopped stream were still processed,
  // it must not land in the new question's placeholder. With faithful abort
  // the controller is errored so emitting throws - that IS the guarantee.
  let lateChunkRejected = false;
  try { req3.emit({ type: 'content', content: ' LEAKED-FROM-OLD-STREAM' }); }
  catch { lateChunkRejected = true; }
  await sleep(100);

  check('B: turn-4 history ends with the new question (no stray placeholder corruption)',
    req4 && req4.body.messages[req4.body.messages.length - 1].content === 'What is 2+2?' &&
    req4.body.messages[req4.body.messages.length - 1].role === 'user',
    req4 && JSON.stringify(roleContent(req4.body.messages)));

  req4.emit({ type: 'content', content: '2+2 = 4.' });
  await sleep(40);
  req4.emit({ type: 'done' });
  await sleep(40);
  req4.close();
  await sleep(200);
  console.log = realLog; console.error = realErr;

  {
    const msgs = storedMessages();
    const last = msgs[msgs.length - 1];
    check('B: aborted stream cannot write into the new answer',
      lateChunkRejected &&
      last.role === 'assistant' && last.content === '2+2 = 4.' &&
      !JSON.stringify(msgs).includes('LEAKED-FROM-OLD-STREAM'),
      `lateChunkRejected=${lateChunkRejected}, last=${JSON.stringify(last)}`);
  }

  // ===== scenario C: backend {error} SSE event mid-stream must surface =====
  console.log = () => {}; console.error = () => {};
  await typeAndSend('Trigger a backend failure please.');
  const req5 = streamRequests[4];
  req5.emit({ type: 'content', content: 'partial ' });
  await sleep(40);
  req5.emit({ error: 'Ollama exploded: connection reset' });
  await sleep(40);
  req5.close();
  await sleep(250);
  console.log = realLog; console.error = realErr;

  {
    const msgs = storedMessages();
    const last = msgs[msgs.length - 1];
    check('C: mid-stream backend error is surfaced to the user',
      last.role === 'assistant' && String(last.content).includes('Ollama exploded'),
      `last=${JSON.stringify(last)}`);
    check('C: input re-enabled after backend error', textarea() && !textarea().disabled);
  }

  // ===== scenario D: data after `done` must not leak into the message ======
  console.log = () => {}; console.error = () => {};
  await typeAndSend('Final question: what color is the sky?');
  const req6 = streamRequests[5];
  req6.emit({ type: 'content', content: 'Blue.' });
  await sleep(40);
  req6.emit({ type: 'done' });
  await sleep(40);
  // A well-behaved backend never sends anything after done; if one ever does
  // (or a proxy replays buffered bytes), it must be ignored. The fixed
  // component cancels the reader after 'done', which closes the stream -
  // so this emit may throw; both "throws" and "silently ignored" are
  // acceptable, appearing in the message is not.
  try { req6.emit({ type: 'content', content: ' LEAKED-AFTER-DONE' }); } catch { /* stream released - fine */ }
  await sleep(80);
  req6.close();
  await sleep(200);
  console.log = realLog; console.error = realErr;

  {
    const msgs = storedMessages();
    const last = msgs[msgs.length - 1];
    check('D: content after done event is ignored',
      last.role === 'assistant' && last.content === 'Blue.' &&
      !JSON.stringify(msgs).includes('LEAKED-AFTER-DONE'),
      `last=${JSON.stringify(last)}`);
  }

  exitCode = results.every((r) => r.pass) ? 0 : 1;
} catch (e) {
  console.log = realLog;
  console.error = realErr;
  console.error('HARNESS ERROR:', e);
  exitCode = 1;
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(exitCode);
