/**
 * One way to read an AI reply, for Quick AI (the editor's panel and the Ask AI
 * popup) and the chat: the backend's SSE stream (/api/ai/chat-stream, and
 * /api/ai/ask with stream: true) read chunk by chunk, with the timeouts the
 * AI paths share:
 *
 *   - no total timeout: a reasoning model (qwen3, deepseek-r1, gpt-oss, the
 *     API reasoning models) thinks for minutes; Quick AI used to abort at
 *     30 s with "signal timed out";
 *   - an IDLE timeout instead: nothing received for AI_IDLE_TIMEOUT_MS means a
 *     dead connection. A provider that streams (Ollama, a custom endpoint,
 *     Anthropic) sends its thinking tokens as it goes, so a long think is
 *     fine; one the backend does not stream (OpenAI, Gemini) sends nothing
 *     until the whole reply is ready, so the idle timeout is generous;
 *   - Cancel: the caller's AbortSignal ends the request (an AbortError).
 *
 * The result says how the reply stopped: `truncated` when the token limit
 * cut it off (finishReason length / max_tokens / MAX_TOKENS), so the UI can
 * say so and offer Continue (CONTINUE_PROMPT) instead of ending silently.
 */

/** Nothing received for this long on a stream: the connection is taken as dead (5 minutes). */
export const AI_IDLE_TIMEOUT_MS = 300_000;
/** A non-streaming AI request (the grid and quiz generators): the whole reply within this (10 minutes, as the backend's read timeout). */
export const AI_REQUEST_TIMEOUT_MS = 600_000;
/** A probe (health, the model list): quick or not at all. */
export const AI_PROBE_TIMEOUT_MS = 3_000;
/** The reply length when nothing is configured (the backend's DEFAULT_MAX_TOKENS). */
export const AI_DEFAULT_MAX_TOKENS = 4096;
/** The follow-up that asks a cut-off reply to go on. */
export const CONTINUE_PROMPT = 'Continue exactly where you left off, without repeating what you already wrote.';

export class AiIdleTimeoutError extends Error {
  constructor(ms) {
    super(`No reply from the model for ${Math.round(ms / 1000)} seconds - the connection seems dead. Check that the AI backend and the provider are running, then try again.`);
    this.name = 'AiIdleTimeoutError';
  }
}

/** The sentence a truncated reply gets. */
export function truncationMessage(maxTokens) {
  return `The answer was cut off at the token limit${maxTokens ? ` (${maxTokens} tokens)` : ''}. Continue asks the model to go on; Settings > AI Providers > Default Max Tokens raises the limit.`;
}

/** Is this reply's finish reason a cut-off? */
export const isTruncatedReason = (reason) => /^(length|max_tokens)$/i.test(String(reason || ''));

/**
 * POST `body` to `url` and read the reply: an SSE stream event by event
 * (`onEvent` sees every event: thinking_start / thinking / thinking_end /
 * content / done), or a plain JSON answer ({ response | message, error,
 * finishReason, truncated }) from a route that did not stream. Resolves
 * { content, thinking, finishReason, truncated }; rejects with the backend's
 * error, an AiIdleTimeoutError, or an AbortError when `signal` was aborted.
 */
export async function streamAiReply({ url, body, headers = {}, signal = null, fetchImpl = null, idleTimeoutMs = AI_IDLE_TIMEOUT_MS, onEvent = null }) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const controller = new AbortController();
  let idle = false;
  let idleTimer = null;
  const arm = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idle = true; controller.abort(); }, idleTimeoutMs);
  };
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const result = { content: '', thinking: '', finishReason: null, truncated: false };
  arm();
  try {
    const response = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).error || ''; } catch { /* not JSON */ }
      throw new Error(detail || `The AI request failed (${response.status})`);
    }
    const type = (response.headers && response.headers.get('content-type')) || '';
    if (!/text\/event-stream/i.test(type) || !response.body || typeof response.body.getReader !== 'function') {
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      result.content = String(data.response ?? data.message ?? '');
      result.finishReason = data.finishReason || null;
      result.truncated = !!data.truncated || isTruncatedReason(data.finishReason);
      if (onEvent && result.content) onEvent({ type: 'content', content: result.content });
      if (onEvent) onEvent({ type: 'done', finishReason: result.finishReason, truncated: result.truncated });
      return result;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    // a read that ends with the abort too: a body that does not react to the signal (a proxy's buffer, a
    // test's stub) would otherwise keep Cancel and the idle timeout waiting on it
    const readChunk = () => new Promise((resolve, reject) => {
      const abortErr = () => { const e = new Error('Aborted'); e.name = 'AbortError'; return e; };
      if (controller.signal.aborted) { reject(abortErr()); return; }
      const onAbort = () => reject(abortErr());
      controller.signal.addEventListener('abort', onAbort, { once: true });
      reader.read().then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', onAbort));
    });
    try {
      while (!done) {
        const chunk = await readChunk();
        if (chunk.done) break;
        arm();
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (event.error) throw new Error(event.error);
          if (event.type === 'content') result.content += event.content || '';
          else if (event.type === 'thinking') result.thinking += event.content || '';
          else if (event.type === 'done') {
            done = true;
            result.finishReason = event.finishReason || null;
            result.truncated = !!event.truncated || isTruncatedReason(event.finishReason);
          }
          if (onEvent) onEvent(event);
          if (done) break;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return result;
  } catch (err) {
    if (idle) throw new AiIdleTimeoutError(idleTimeoutMs);
    if ((signal && signal.aborted) || (err && err.name === 'AbortError')) {
      const cancelled = new Error('Cancelled');
      cancelled.name = 'AbortError';
      throw cancelled;
    }
    throw err;
  } finally {
    if (idleTimer !== null) clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * One `reader.read()` with the idle timeout: nothing within `ms` aborts the
 * request (`controller`), cancels the reader and throws an AiIdleTimeoutError
 * (the chat page's own stream loop uses it; streamAiReply has the same inside).
 */
export function readWithIdleTimeout(reader, controller, ms = AI_IDLE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { controller?.abort(); } catch { /* already done */ }
      reader.cancel().catch(() => {});
      reject(new AiIdleTimeoutError(ms));
    }, ms);
    reader.read().then((r) => { clearTimeout(timer); resolve(r); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
