/**
 * The Markdown preview of a huge document, rendered after the "Rendering
 * preview of N lines..." state has been painted.
 *
 * The preview pipeline (src/utils/interactiveMarkdown.js) is synchronous:
 * on a document above HUGE_PREVIEW_LINES / HUGE_PREVIEW_CHARS
 * (src/utils/previewChunks.js) it holds the main thread for seconds, and
 * computed inside render - as it is for every other document - the window
 * froze on the click with nothing to show for it. This hook keeps the
 * ordinary path exactly as it was (the HTML computed synchronously in
 * render, no indicator, no flash) and, for a huge document, answers
 * `pending` first - the caller paints the indicator - and runs the render
 * only after a frame has been painted (requestAnimationFrame, then a
 * macrotask), then answers the HTML.
 *
 *   - leaving the preview, or switching documents, while the render is
 *     still waiting for its frame cancels it; a render already running
 *     cannot be interrupted (it is one synchronous call) and its result is
 *     dropped when the caller has moved on - nothing stale is shown;
 *   - every opening of the preview starts from the indicator (a session
 *     counter: the HTML of an earlier opening is never shown for a
 *     document that may have been edited in between);
 *   - within one opening, a later version of the same document (a
 *     collaborator's edit, already lagged by DocumentEditor) renders in the
 *     background: the previous HTML stays on screen and `pending` stays
 *     false, so no spinner on every remote edit;
 *   - the rendering itself is the caller's `render(source)`: this hook only
 *     decides when.
 *
 * @param {object} args
 * @param {boolean} args.active     the preview is open
 * @param {string} args.source      the document text to render
 * @param {boolean} args.huge       the document is above the threshold
 * @param {string|number} args.documentKey  identifies the document
 * @param {(source: string) => string} args.render
 * @param {number} [args.version]   bumps when `source` changed without the string identity changing (Yjs)
 * @returns {{ html: string | null, pending: boolean }}
 *   html: what to show (null while pending with nothing rendered yet)
 */
import { useEffect, useMemo, useState } from 'react';

export function useDeferredPreview({ active, source, huge, documentKey, render, version = 0 }) {
  // the ordinary document: as before, synchronous, in render
  // (version is a deliberate cache-buster: a Y.Text's string can repeat while its content moved on)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const direct = useMemo(() => (active && !huge ? render(source) : null), [active, huge, source, render, version]);
  // the huge document: { session, key, html } once a render has landed
  const [deferred, setDeferred] = useState(null);
  // one session per opening of the preview: closing it ends the session
  const [session, setSession] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    return () => setSession((s) => s + 1);
  }, [active]);

  useEffect(() => {
    if (!active || !huge) return undefined;
    let cancelled = false;
    let timer = null;
    // one painted frame, then a macrotask: the indicator is on screen before the work starts
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        if (cancelled) return;
        const html = render(source);
        if (!cancelled) setDeferred({ session, key: documentKey, html });
      }, 0);
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); if (timer !== null) clearTimeout(timer); };
  }, [active, huge, source, documentKey, render, version, session]);

  if (!active) return { html: null, pending: false };
  if (!huge) return { html: direct, pending: false };
  const have = deferred && deferred.session === session && deferred.key === documentKey ? deferred.html : null;
  return { html: have, pending: have === null };
}
