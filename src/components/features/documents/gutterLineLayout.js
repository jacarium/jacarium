/**
 * Line-height layout for the document editor's line-number gutter.
 *
 * The editor is a plain <textarea> with a separately rendered gutter, so the
 * gutter has to know how many visual rows each logical line occupies once the
 * browser soft-wraps it. Row COUNTS are always MEASURED (a hidden mirror of
 * the textarea, so word boundaries, tabs, letter-spacing and the actually
 * loaded font all match), never estimated from character counts - estimates
 * diverge from real wrapping and made the gutter "jump then fix" on every
 * keystroke.
 *
 * Row HEIGHT, however, is not taken from the mirror: Chrome lays a
 * <textarea>'s rows out on its 1/64px layout grid slightly differently from a
 * <div>'s (22.4px becomes 22.390625px in the textarea but 22.40625px in a
 * div), and a mirror's last row is reported ~2px short. Summing raw mirror
 * heights therefore drifts away from the real text by a couple of px per
 * edited paragraph and ~2px per 120 rows. So the mirror only answers "how
 * many rows", the textarea itself is calibrated once for "how tall is a row"
 * (measureTextareaRowPitch), and gutter heights are rows * pitch - exact
 * multiples of what the textarea uses, so the gutter and the text stack
 * identically.
 *
 * To keep that cheap, each distinct logical line's row count is measured once
 * and cached by its text: a keystroke only measures the line it touched (one
 * small layout), while a freshly opened document measures all of its lines in
 * a single batch. The cache is keyed on everything that can move wrap points
 * (width, font, spacing, tab size, loaded web fonts) and dropped when the key
 * changes.
 */

/** 14px font-size * 1.6 line-height, matching the textarea's inline style. */
export const BASE_LINE_HEIGHT = 22.4;

/** Chrome's LayoutUnit is 1/64 css px; block and line boxes land on this grid. */
export function snapToLayoutUnit(px) {
  return Math.round(px * 64) / 64;
}

/**
 * Flat, uncalibrated layout (one row per line). Used before the textarea has
 * been measured or while it is hidden; consumers should not display numbers
 * for it (`calibrated: false`) because it cannot know about wrapping yet.
 */
export function flatLineLayout(lineCount, rowHeight = BASE_LINE_HEIGHT) {
  const heights = new Float64Array(lineCount);
  const cumulative = new Float64Array(lineCount);
  let sum = 0;
  for (let i = 0; i < lineCount; i++) {
    heights[i] = rowHeight;
    sum += rowHeight;
    cumulative[i] = sum;
  }
  return { lineCount, heights, cumulative, totalHeight: sum, rowHeight, calibrated: false, measuredCount: 0 };
}

/**
 * Compute per-line heights from cached per-line ROW COUNTS, measuring only the
 * lines the cache does not know yet.
 *
 * @param {string[]} lines            logical lines of the document
 * @param {{ key: string, map: Map<string, number> }} cache  text -> rows; cleared when `cacheKey` changes
 * @param {string} cacheKey           everything that affects wrapping
 * @param {(lines: string[]) => ArrayLike<number>} measureRows  real-layout row counter for uncached, non-empty, distinct lines
 * @param {number} [rowHeight]        px per visual row (the textarea's calibrated pitch)
 */
export function computeLineLayout(lines, cache, cacheKey, measureRows, rowHeight = BASE_LINE_HEIGHT) {
  const lineCount = lines.length;
  const heights = new Float64Array(lineCount);
  const cumulative = new Float64Array(lineCount);

  if (cache.key !== cacheKey) {
    cache.key = cacheKey;
    cache.map = new Map();
  }

  // Distinct, non-empty lines the cache has not measured yet (empty lines are
  // always exactly one row). NaN marks a line as queued so duplicates are
  // measured once.
  const missing = [];
  for (let i = 0; i < lineCount; i++) {
    const line = lines[i];
    if (line.length > 0 && !cache.map.has(line)) {
      cache.map.set(line, NaN);
      missing.push(line);
    }
  }

  if (missing.length > 0) {
    const measured = measureRows(missing);
    for (let i = 0; i < missing.length; i++) {
      const rows = measured[i];
      cache.map.set(missing[i], Number.isFinite(rows) && rows >= 1 ? Math.round(rows) : 1);
    }
  }

  let sum = 0;
  for (let i = 0; i < lineCount; i++) {
    const line = lines[i];
    const h = (line.length > 0 ? cache.map.get(line) : 1) * rowHeight;
    heights[i] = h;
    sum += h;
    cumulative[i] = sum;
  }

  // Long editing sessions churn through many distinct line texts; once the
  // cache is well past the document's size, keep only what is still in it.
  if (cache.map.size > lineCount * 2 + 2000) {
    const keep = new Map();
    for (let i = 0; i < lineCount; i++) {
      const line = lines[i];
      if (line.length > 0) keep.set(line, cache.map.get(line));
    }
    cache.map = keep;
  }

  return { lineCount, heights, cumulative, totalHeight: sum, rowHeight, calibrated: true, measuredCount: missing.length };
}

/**
 * Real-layout row counter: renders the given lines in a hidden mirror of the
 * textarea (same width, padding, font and wrapping rules) and returns how
 * many visual rows each line occupies. One layout for the whole batch.
 *
 * Each line is preceded by a marker span; the batch is terminated by a marker
 * followed by a non-empty probe row rather than a bare empty span - an empty
 * span alone on the trailing row is positioned ~2px high by Chrome, which
 * used to make the last line of every batch (i.e. the line just typed) short.
 *
 * @param {string[]} lines
 * @param {HTMLTextAreaElement} textarea
 * @param {CSSStyleDeclaration} [cs]  computed style of `textarea` (avoids recomputing)
 * @returns {number[]} rows per line (>= 1)
 */
export function measureLinesWithMirror(lines, textarea, cs) {
  const doc = textarea.ownerDocument;
  const win = doc.defaultView;
  const style = cs || win.getComputedStyle(textarea);
  const nominalRow = parseFloat(style.lineHeight) || BASE_LINE_HEIGHT;

  const div = doc.createElement('div');
  div.style.position = 'fixed';
  div.style.visibility = 'hidden';
  div.style.top = '-9999px';
  div.style.left = '-9999px';
  div.style.width = `${textarea.clientWidth}px`;
  div.style.boxSizing = 'border-box';
  div.style.padding = style.padding;
  div.style.border = 'none';
  div.style.font = style.font;
  div.style.lineHeight = style.lineHeight;
  div.style.letterSpacing = style.letterSpacing;
  div.style.wordSpacing = style.wordSpacing;
  div.style.textIndent = style.textIndent;
  div.style.textTransform = style.textTransform;
  div.style.wordBreak = style.wordBreak;
  div.style.tabSize = style.tabSize;
  div.style.textRendering = style.textRendering;
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.overflowWrap = 'break-word';
  div.style.overflow = 'hidden';

  const fragment = doc.createDocumentFragment();
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const marker = doc.createElement('span');
    markers.push(marker);
    fragment.appendChild(marker);
    fragment.appendChild(doc.createTextNode(lines[i] + '\n'));
  }
  const end = doc.createElement('span');
  markers.push(end);
  fragment.appendChild(end);
  fragment.appendChild(doc.createTextNode('M')); // probe row: keeps `end` on a real, full-height row
  div.appendChild(fragment);
  doc.body.appendChild(div);

  const tops = markers.map((m) => m.getBoundingClientRect().top);
  doc.body.removeChild(div);

  const rows = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    rows[i] = Math.max(1, Math.round((tops[i + 1] - tops[i]) / nominalRow));
  }
  return rows;
}

/**
 * Calibrate how tall one visual row really is inside THIS <textarea>: a hidden
 * clone (cloneNode, so it keeps the same classes, inline styles and ancestors -
 * the textarea's unitless `line-height: 1.6` is floored to 22.390625px by the
 * inner editor, whereas an explicit `22.4px` rounds up to 22.40625px) is
 * filled with 1 and then 257 single-row lines and the growth per row is
 * snapped to Chrome's 1/64px layout grid. Falls back to the CSS line-height
 * when the environment has no layout.
 *
 * @param {HTMLTextAreaElement} textarea
 * @param {CSSStyleDeclaration} [cs]
 * @returns {number} px per row
 */
export function measureTextareaRowPitch(textarea, cs) {
  const doc = textarea.ownerDocument;
  const win = doc.defaultView;
  const style = cs || win.getComputedStyle(textarea);
  const fallback = parseFloat(style.lineHeight) || BASE_LINE_HEIGHT;

  const clone = textarea.cloneNode(false);
  clone.removeAttribute('id');
  clone.removeAttribute('name');
  clone.setAttribute('aria-hidden', 'true');
  clone.tabIndex = -1;
  clone.value = '';
  clone.style.position = 'absolute';
  clone.style.visibility = 'hidden';
  clone.style.pointerEvents = 'none';
  clone.style.top = '0';
  clone.style.left = '0';
  clone.style.width = `${textarea.getBoundingClientRect().width}px`;
  clone.style.height = '10px';
  clone.style.overflow = 'hidden';
  const host = textarea.parentElement || doc.body;
  host.appendChild(clone);

  const ROWS = 256;
  clone.value = 'a';
  const one = clone.scrollHeight;
  clone.value = Array(ROWS + 1).fill('a').join('\n');
  const many = clone.scrollHeight;
  host.removeChild(clone);

  const pitch = snapToLayoutUnit((many - one) / ROWS);
  // Sanity: within half a px of the CSS line-height, otherwise the measurement is not trustworthy
  return Number.isFinite(pitch) && Math.abs(pitch - fallback) <= 0.5 ? pitch : fallback;
}
