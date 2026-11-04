/**
 * The Markdown preview of a big document: what makes it bearable, measured
 * (tests/preview-huge-document.test.mjs) rather than guessed.
 *
 * Where the time goes, for the pipeline of src/utils/interactiveMarkdown.js
 * (marked, DOMPurify, the directive wrappers) and the DOM it produces, on
 * one machine in headless Chromium: 200,000 lines of mixed markdown parse
 * in ~0.4 s, sanitise in ~1.1 s, build their DOM in ~0.25 s - and then the
 * browser spends ~3.4 s laying out and painting the 345,000 elements, on
 * the first paint and again whenever a style changes. For the 2,000,000
 * plain lines of the report: parse 2 s, sanitise 3.3 s, DOM 0.7 s, layout +
 * paint 6.4 s.
 *
 * chunkPreviewBlocks(): the layout and paint are the part this file takes
 * away. The preview's top-level blocks are grouped, after the sanitised
 * HTML is in the DOM and before the first paint (a layout effect), into
 * chunks of CHUNK_SIZE blocks, and index.css gives a chunk
 * `content-visibility: auto` with an intrinsic size: the browser then lays
 * out and paints a chunk only when it comes near the viewport, and keeps
 * its real size once it has. Measured: layout + paint 3.4 s -> 0.1 s for
 * the 200,000 lines, 6.4 s -> 0.1 s for the 2,000,000 (the grouping itself
 * 0.1 s / 0.45 s). Below MIN_BLOCKS top-level blocks nothing is grouped -
 * the preview DOM of an ordinary document is exactly what it was. Grouping
 * is content-visibility on chunks rather than on every block because
 * 571,000 individually tracked blocks cost more than they saved (paint
 * 0.8 s -> 6.6 s). The sanitised HTML string, the PDF export (its own
 * container) and the headings are untouched: a chunk is a plain div, every
 * descendant selector, anchor (#heading) and click handler still finds its
 * element, and the browser renders a chunk on demand for find-in-page and
 * scrollIntoView.
 *
 * previewRenderDelay(): the other part is the re-render per change. The
 * preview replaces the editor, so the user's own typing never re-renders it;
 * a collaborator's edits do (the live Y.Text), and on a big document each
 * one cost the whole pipeline again (~5.4 s per edit on the 200,000 lines
 * with the layout, ~2.5 s without). The delay scales with the size so a
 * stream of remote keystrokes on a big document re-renders about as often
 * as a render takes, and a small document still updates at once.
 */

/** Top-level blocks per chunk. */
export const CHUNK_SIZE = 100;
/** A preview with fewer top-level blocks than this is left as it is. */
export const MIN_BLOCKS = 300;
export const CHUNK_CLASS = 'md-chunk';

/**
 * Group `container`'s top-level child nodes into chunks of CHUNK_SIZE
 * (div.md-chunk) when there are at least MIN_BLOCKS of them. Returns the
 * number of chunks made (0 when nothing was grouped, or the container is
 * already chunked).
 * @param {HTMLElement | null} container
 * @param {{ chunkSize?: number, minBlocks?: number }} [options]
 */
export function chunkPreviewBlocks(container, { chunkSize = CHUNK_SIZE, minBlocks = MIN_BLOCKS } = {}) {
  if (!container || container.childNodes.length < minBlocks) return 0;
  if (container.firstElementChild && container.firstElementChild.classList.contains(CHUNK_CLASS)) return 0;
  const nodes = Array.from(container.childNodes);
  const doc = container.ownerDocument;
  const fragment = doc.createDocumentFragment();
  let chunks = 0;
  for (let i = 0; i < nodes.length; i += chunkSize) {
    const chunk = doc.createElement('div');
    chunk.className = CHUNK_CLASS;
    for (let j = i; j < Math.min(i + chunkSize, nodes.length); j++) chunk.appendChild(nodes[j]);
    fragment.appendChild(chunk);
    chunks += 1;
  }
  container.appendChild(fragment);
  return chunks;
}

/**
 * Above this many lines, or this many characters, the preview is rendered
 * after a "Rendering preview of N lines..." state has been painted
 * (src/hooks/useDeferredPreview.js) instead of inside the click's render:
 * measured, 500,000 lines of the report's shape take ~1.5 s of parse and
 * sanitising on a fast machine, 2,000,000 lines ~6 s. Everything below
 * renders as it always did, with no indicator.
 */
export const HUGE_PREVIEW_LINES = 500000;
export const HUGE_PREVIEW_CHARS = 20000000;

/**
 * Whether `text` is above the threshold, with its line count (for the
 * message; counting the newlines of a 64 MB string takes tens of ms, once
 * per document text).
 * @param {string} text
 * @returns {{ huge: boolean, lines: number }}
 */
export function hugePreview(text) {
  const s = typeof text === 'string' ? text : '';
  const lines = countLines(s);
  return { huge: s.length > HUGE_PREVIEW_CHARS || lines > HUGE_PREVIEW_LINES, lines };
}

/** The number of lines of `s` (1 for an empty string). */
export function countLines(s) {
  let lines = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) lines += 1;
  return lines;
}

/** The delay, in ms, before a change to a document of `chars` characters re-renders its preview: 0 up to 200,000 characters (~10,000 lines), then about the render's own cost, at most 2 s. */
export function previewRenderDelay(chars) {
  const n = Number(chars) || 0;
  if (n <= 200000) return 0;
  return Math.min(2000, Math.round(n / 2000));
}
