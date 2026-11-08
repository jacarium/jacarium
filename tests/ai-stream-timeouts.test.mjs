#!/usr/bin/env node
/**
 * The AI reply reader and the timeouts the AI paths share
 * (src/utils/aiStream.js), with a stubbed backend (no network):
 *
 *   1. a slow stream completes: chunks keep coming with gaps shorter than
 *      the idle timeout, however long the whole takes (the old Quick AI
 *      aborted at 30 s total);
 *   2. a stalled stream hits the idle timeout: the request is aborted and
 *      the error names the silence and what to check;
 *   3. Cancel: the caller's signal aborts the request (an AbortError, the
 *      reader cancelled), with what arrived so far kept by the caller;
 *   4. the done event's finishReason / truncated reach the result (length,
 *      max_tokens, MAX_TOKENS count as truncated), a backend error event is
 *      thrown, a non-streaming JSON answer is read the same way;
 *   5. readWithIdleTimeout (the chat page's loop) times out the same way;
 *   6. the constants are sane and shared: no AbortSignal.timeout on the
 *      Quick AI paths, the chat page reads with the idle timeout, every
 *      caller sends the configured max tokens (resolveAiRequestSettings
 *      takes the backend's default), the default is 4096.
 *
 * Run: node tests/ai-stream-timeouts.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = await import(path.join(REPO, 'src/utils/aiStream.js'));

const enc = new TextEncoder();
const sse = (ev) => enc.encode(`data: ${JSON.stringify(ev)}\n\n`);
/** A fake backend: `script` is a list of [delayMs, event] pairs streamed as SSE; `hang` stops after them without closing. */
function fakeFetch(script, { hang = false, status = 200, json = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
    if (json) return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
    let cancelled = false;
    const stream = new ReadableStream({
      async start(controller) {
        for (const [delay, ev] of script) {
          await sleep(delay);
          if (cancelled || init.signal.aborted) return;
          controller.enqueue(sse(ev));
        }
        if (!hang) controller.close();
      },
      cancel() { cancelled = true; },
    });
    init.signal.addEventListener('abort', () => { cancelled = true; });
    return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// ---- 1. a slow stream completes (gaps 60 ms, idle timeout 200 ms, the whole 600 ms)
{
  const script = [[60, { type: 'thinking_start' }], [60, { type: 'thinking', content: 'hmm' }], [60, { type: 'thinking', content: ' more' }], [60, { type: 'thinking_end' }], [60, { type: 'content', content: 'Hello' }], [60, { type: 'content', content: ' world' }], [60, { type: 'done', finishReason: 'stop', truncated: false }]];
  const f = fakeFetch(script);
  const events = [];
  const t0 = Date.now();
  const r = await S.streamAiReply({ url: 'http://backend.test/api/ai/ask', body: { message: 'hi', stream: true }, fetchImpl: f, idleTimeoutMs: 200, onEvent: (e) => events.push(e.type) });
  check(`1. a slow stream completes: the whole took ${Date.now() - t0} ms with a 200 ms idle timeout; the content and thinking collected, every event seen`, r.content === 'Hello world' && r.thinking === 'hmm more' && !r.truncated && r.finishReason === 'stop' && events.join() === 'thinking_start,thinking,thinking,thinking_end,content,content,done', JSON.stringify([r, events]));
  check('1. the request carried the body as JSON (stream: true)', f.calls[0].body.stream === true && f.calls[0].body.message === 'hi');
}
// ---- 2. a stalled stream
{
  const f = fakeFetch([[20, { type: 'content', content: 'partial' }]], { hang: true });
  const t0 = Date.now();
  let err = null;
  try { await S.streamAiReply({ url: 'x', body: {}, fetchImpl: f, idleTimeoutMs: 250 }); } catch (e) { err = e; }
  check(`2. a stalled stream hits the idle timeout (after ${Date.now() - t0} ms): an AiIdleTimeoutError naming the silence, the request aborted`, err && err.name === 'AiIdleTimeoutError' && /No reply from the model for 0 seconds|No reply from the model/.test(err.message) && /check that the ai backend/i.test(err.message) && f.calls[0].signal.aborted && Date.now() - t0 < 2000, err && err.message);
}
// ---- 3. Cancel
{
  const f = fakeFetch([[30, { type: 'content', content: 'a' }], [30, { type: 'content', content: 'b' }], [5000, { type: 'done' }]]);
  const controller = new AbortController();
  const seen = [];
  const run = S.streamAiReply({ url: 'x', body: {}, fetchImpl: f, idleTimeoutMs: 10000, signal: controller.signal, onEvent: (e) => { seen.push(e); if (seen.length === 2) controller.abort(); } });
  let err = null;
  const t0 = Date.now();
  try { await run; } catch (e) { err = e; }
  check(`3. Cancel: the caller's signal aborts the request (AbortError after ${Date.now() - t0} ms, not 5 s), what arrived was delivered to the caller`, err && err.name === 'AbortError' && seen.map((e) => e.content).join('') === 'ab' && f.calls[0].signal.aborted && Date.now() - t0 < 2000, err && err.message);
  const pre = new AbortController(); pre.abort();
  let err2 = null;
  try { await S.streamAiReply({ url: 'x', body: {}, fetchImpl: fakeFetch([[10, { type: 'done' }]]), signal: pre.signal }); } catch (e) { err2 = e; }
  check('3. an already-aborted signal: AbortError at once', err2 && err2.name === 'AbortError');
}
// ---- 4. finish reasons, errors, JSON answers
{
  const r1 = await S.streamAiReply({ url: 'x', body: {}, fetchImpl: fakeFetch([[5, { type: 'content', content: 'cut' }], [5, { type: 'done', finishReason: 'length', truncated: true }]]) });
  const r2 = await S.streamAiReply({ url: 'x', body: {}, fetchImpl: fakeFetch([[5, { type: 'content', content: 'cut' }], [5, { type: 'done', finishReason: 'max_tokens' }]]) });
  const r3 = await S.streamAiReply({ url: 'x', body: {}, fetchImpl: fakeFetch([[5, { type: 'done', finishReason: 'MAX_TOKENS' }]]) });
  const r4 = await S.streamAiReply({ url: 'x', body: {}, fetchImpl: fakeFetch([[5, { type: 'content', content: 'ok' }], [5, { type: 'done', finishReason: 'end_turn' }]]) });
  check('4. the done event: length / max_tokens / MAX_TOKENS are truncated (Ollama, Anthropic, Gemini), end_turn is not', r1.truncated && r1.finishReason === 'length' && r2.truncated && r3.truncated && !r4.truncated && r4.content === 'ok', JSON.stringify([r1, r2, r3, r4]));
  let err = null;
  try { await S.streamAiReply({ url: 'x', body: {}, fetchImpl: fakeFetch([[5, { type: 'content', content: 'a' }], [5, { error: 'Read timed out at the provider' }]]) }); } catch (e) { err = e; }
  check('4. a backend error event mid-stream is thrown with its message', err && /Read timed out at the provider/.test(err.message));
  const rj = await S.streamAiReply({ url: 'x', body: {}, fetchImpl: fakeFetch([], { json: { response: 'plain answer', finishReason: 'length', truncated: true } }) });
  check('4. a non-streaming JSON answer ({ response, finishReason, truncated }) is read the same way', rj.content === 'plain answer' && rj.truncated && rj.finishReason === 'length');
  let err5 = null;
  try { await S.streamAiReply({ url: 'x', body: {}, fetchImpl: fakeFetch([], { json: { error: 'OPENAI_API_KEY not found' }, status: 500 }) }); } catch (e) { err5 = e; }
  check('4. an HTTP error carries the backend\'s detail', err5 && /OPENAI_API_KEY not found/.test(err5.message));
}
// ---- 5. readWithIdleTimeout
{
  const stalled = new ReadableStream({ start() { /* never */ } });
  const reader = stalled.getReader();
  const c = new AbortController();
  let err = null;
  try { await S.readWithIdleTimeout(reader, c, 120); } catch (e) { err = e; }
  check('5. readWithIdleTimeout: a stalled read times out, aborts the controller and throws the idle error', err && err.name === 'AiIdleTimeoutError' && c.signal.aborted);
  const live = new ReadableStream({ start(ctrl) { setTimeout(() => { ctrl.enqueue(enc.encode('x')); ctrl.close(); }, 30); } });
  const r = await S.readWithIdleTimeout(live.getReader(), new AbortController(), 500);
  check('5. ...and a live read resolves', !r.done && r.value.length === 1);
}
// ---- 6. the constants and the wiring
{
  check('6. constants: the idle timeout is minutes (>= 120 s), the request timeout >= the idle one, the probe timeout a few seconds, the default max tokens 4096', S.AI_IDLE_TIMEOUT_MS >= 120000 && S.AI_REQUEST_TIMEOUT_MS >= S.AI_IDLE_TIMEOUT_MS && S.AI_PROBE_TIMEOUT_MS <= 10000 && S.AI_DEFAULT_MAX_TOKENS === 4096);
  const editor = read('src/components/features/documents/DocumentEditor.jsx');
  const popup = read('src/components/features/documents/AskAIPopup.jsx');
  check('6. Quick AI (the editor panel and the Ask AI popup) streams through streamAiReply with Cancel and no AbortSignal.timeout on /api/ai/ask', /streamAiReply\(\{\s*url: `\$\{backendUrl\}\/api\/ai\/ask`/.test(editor) && /streamAiReply\(\{\s*url: `\$\{await getBackendUrl\(\)\}\/api\/ai\/ask`/.test(popup) && !/api\/ai\/ask[\s\S]{0,600}AbortSignal\.timeout/.test(editor) && !/AbortSignal\.timeout/.test(popup) && /quick-ai-cancel/.test(editor) && /ask-ai-cancel/.test(popup));
  check('6. ...and both show the cut-off note with Continue', /quick-ai-truncated/.test(editor) && /quick-ai-continue/.test(editor) && /ask-ai-truncated/.test(popup) && /ask-ai-continue/.test(popup) && /stream: true/.test(editor) && /stream: true/.test(popup));
  const page = read('src/components/AIChatPage.jsx');
  const side = read('src/components/common/AIChatSidebar.jsx');
  check('6. the AI Chat page reads its stream with the idle timeout, sends maxTokens, marks a truncated reply and offers Continue', /readWithIdleTimeout\(reader, abortControllerRef\.current, AI_IDLE_TIMEOUT_MS\)/.test(page) && /maxTokens: aiSettings\.maxTokens/.test(page) && /data\.truncated/.test(page) && /ai-truncated-note/.test(page) && /handleSendMessage\(CONTINUE_PROMPT\)/.test(page) && !/maxTokens: 2000/.test(page));
  check('6. the AI chat sidebar sends maxTokens (the backend read maxTokens while it sent max_tokens: the setting never arrived), marks a truncated reply, offers Continue, probes with the shared timeout', /maxTokens: aiSettings\.maxTokens/.test(side) && /data\.truncated/.test(side) && /ai-truncated-note/.test(side) && /AbortSignal\.timeout\(AI_PROBE_TIMEOUT_MS\)/.test(side) && !/AbortSignal\.timeout\(3000\)/.test(side) && !/maxTokens: 2000/.test(side));
  const settings = read('src/utils/aiRequestSettings.js');
  check('6. resolveAiRequestSettings takes the backend\'s configured default max tokens (Settings > AI Providers), else 4096 - no fixed 2000', /configured > 0 \? configured : AI_DEFAULT_MAX_TOKENS/.test(settings) && !/maxTokens = 2000/.test(settings));
  const backend = read('backend/ai_chat.py');
  check('6. the backend: a (connect, read) timeout pair with a long read, request_max_tokens reads maxTokens and max_tokens and the setting, the routes answer finishReason / truncated, the stream ends with done + truncated, /api/ai/ask streams', /CUSTOM_AI_TIMEOUT = \(CUSTOM_AI_CONNECT_TIMEOUT, CUSTOM_AI_READ_TIMEOUT\)/.test(backend) && /CUSTOM_AI_READ_TIMEOUT = 600/.test(backend) && /for key in \('maxTokens', 'max_tokens'\)/.test(backend) && /reply_json\("response", response_message\)/.test(backend) && /reply_json\("message", response_message\)/.test(backend) && /yield \{'type': 'done', 'finishReason': finish, 'truncated': is_truncated\(finish\)\}/.test(backend) && /if data\.get\('stream'\):/.test(backend) && /'maxTokens': default_max_tokens\(\)/.test(backend));
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
