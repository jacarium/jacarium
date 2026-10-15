import DOMPurify from 'dompurify';

/**
 * Mermaid diagram rendering for the Documents preview and PDF export.
 *
 * processInteractiveMarkdown (interactiveMarkdown.js) turns every
 * ```mermaid fenced block into an inert placeholder:
 *
 *   <div class="mermaid-diagram" data-mermaid="pending">
 *     <pre><code class="language-mermaid">…source…</code></pre>
 *   </div>
 *
 * so the synchronous markdown pass stays synchronous and mermaid itself is
 * only ever loaded here, on demand, with a dynamic import(): the package is
 * ~2.5 MB of lazy chunks and must not land in the entry or DocumentsPage
 * bundles, and documents without diagrams never pay for it.
 *
 * renderMermaidDiagrams() then replaces each placeholder's content with the
 * rendered SVG (the source <pre> stays in the DOM, hidden by index.css, so a
 * theme change can re-render from it) or, when mermaid rejects the source,
 * with an inline error box above the still-visible source block.
 *
 * Security: document content is user-authored and synced from other
 * machines. Mermaid runs with securityLevel 'strict' (no click/href
 * interactions, labels sanitized) and htmlLabels off (labels are SVG <text>,
 * never <foreignObject> HTML), and its SVG output is additionally passed
 * through DOMPurify's SVG profile before it touches the DOM - the same
 * sanitizer the markdown pipeline already uses. The error message is
 * inserted as text, never markup.
 *
 * Offline: mermaid is bundled from node_modules and fetches nothing at
 * runtime (no CDN, no fonts - the theme's font stack is system fonts).
 *
 * State machine on data-mermaid: pending -> rendering -> rendered | error.
 * "rendering" is set synchronously before the first await so a concurrent
 * call (the preview's MutationObserver, a theme change) never double-renders
 * the same element; an aborted call resets its unfinished elements to
 * "pending" so the next call picks them up.
 */

export const MERMAID_PENDING_SELECTOR = '.mermaid-diagram[data-mermaid="pending"]';

/** Mermaid font stack: system fonts only, so nothing is fetched offline. */
export const DEFAULT_MERMAID_FONT = '"trebuchet ms", verdana, arial, sans-serif';

/** The mermaid theme matching the app's current light/dark state. */
export function mermaidThemeForApp() {
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  return dark ? 'dark' : 'default';
}

let mermaidModulePromise = null;
function loadMermaidModule() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((mod) => mod.default || mod);
    // A failed load (e.g. missing chunk) must not be cached forever
    mermaidModulePromise.catch(() => { mermaidModulePromise = null; });
  }
  return mermaidModulePromise;
}

// mermaid.initialize() is global; re-run it only when the theme/font differ
// from the last initialization (a theme toggle), not per diagram.
let initializedKey = null;
function ensureInitialized(mermaid, theme, fontFamily) {
  const key = `${theme}|${fontFamily}`;
  if (initializedKey === key) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // SVG <text> labels only: keeps <foreignObject> HTML out of the output
    // (DOMPurify's SVG profile drops it, and Chrome taints canvases that
    // draw SVG images containing it, which would blank the PDF export).
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    // Errors surface as a thrown parse error handled below, not as
    // mermaid's own "syntax error" bomb graphic injected into the DOM.
    suppressErrorRendering: true,
    theme,
    fontFamily,
  });
  initializedKey = key;
}

// Memoize sanitized SVG by (theme, font, source): toggling the preview or
// the theme back and forth, or the same diagram in several documents, then
// costs nothing. Bounded so a long session can't grow it without limit.
const SVG_CACHE_LIMIT = 100;
const svgCache = new Map();
function cacheGet(key) {
  const hit = svgCache.get(key);
  if (hit !== undefined) {
    // refresh LRU position
    svgCache.delete(key);
    svgCache.set(key, hit);
  }
  return hit;
}
function cacheSet(key, svg) {
  svgCache.set(key, svg);
  if (svgCache.size > SVG_CACHE_LIMIT) {
    svgCache.delete(svgCache.keys().next().value);
  }
}

// Unique per render call: mermaid keys the SVG's scoped <style> rules and
// marker ids on it, so two diagrams in one document must never share one.
let renderCounter = 0;
const renderSalt = Math.random().toString(36).slice(2, 8);
function nextRenderId() {
  renderCounter += 1;
  return `mermaid-diagram-${renderSalt}-${renderCounter}`;
}

function sanitizeSvg(svg) {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // mermaid's scoped stylesheet lives in a <style> inside the SVG
    ADD_TAGS: ['style'],
  });
}

function readSource(el) {
  const code = el.querySelector('code');
  return code ? code.textContent : '';
}

function clearOutput(el) {
  for (const child of Array.from(el.children)) {
    if (child.classList.contains('mermaid-diagram-output') || child.classList.contains('mermaid-diagram-error')) {
      child.remove();
    }
  }
}

function applySvg(el, theme, svg) {
  clearOutput(el);
  const out = el.ownerDocument.createElement('div');
  out.className = 'mermaid-diagram-output';
  out.innerHTML = svg; // already DOMPurify-sanitized
  el.insertBefore(out, el.firstChild);
  el.setAttribute('data-mermaid', 'rendered');
  el.setAttribute('data-mermaid-theme', theme);
  // Runs on the live DOM every time a dark render is inserted (fresh or from
  // the cache), so the cache keeps holding mermaid's own output per theme and
  // a light render is never post-processed.
  if (theme === 'dark') ensureDarkLabelContrast(out);
}

/* ------------------------------------------------------------------------ *
 * Dark-theme label contrast
 *
 * Mermaid's dark theme paints node labels light (#ccc) on dark node fills.
 * Author styling (`classDef x fill:#fef9c3,stroke:#ca8a04`, `style N
 * fill:...`, `:::x`) only replaces the FILL - the label keeps the theme's
 * light text, and a pastel box with light-grey text is unreadable (measured
 * 1.4:1). The same diagram is fine in the light theme, where the default
 * text is dark. After every dark render, re-check each label against the
 * shape it sits on and, when the author did not choose a text colour
 * themselves, give it whichever of dark/light text contrasts better.
 *
 * Author-set colours are respected: `classDef ... color:#fde68a` is emitted
 * as `style="color:#fde68a !important"` on the label group and
 * `style="fill:#fde68a !important"` on its <text>, and any label carrying
 * either is left alone.
 * ------------------------------------------------------------------------ */

/** WCAG 2.x minimum contrast for normal text. */
export const MIN_LABEL_CONTRAST = 4.5;
export const DARK_LABEL_TEXT = '#111827';
export const LIGHT_LABEL_TEXT = '#f8fafc';
const CONTRAST_MARKER = 'data-contrast-fill';

/**
 * Parse a CSS colour as the browser reports it (rgb()/rgba()/#hex/#hex4/8,
 * plus the few keywords mermaid themes use) into [r, g, b, a]. Returns null
 * for `none`, `transparent`, `currentColor`, gradients and anything else.
 */
export function parseCssColor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v || v === 'none' || v === 'transparent' || v === 'currentcolor' || v.startsWith('url(')) return null;
  const keywords = { white: [255, 255, 255, 1], black: [0, 0, 0, 1] };
  if (keywords[v]) return keywords[v];
  let m = v.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), Number.isFinite(a) ? a : 1];
  }
  m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split('').map((c) => parseInt(c + c, 16));
      return [r, g, b, h.length === 4 ? a / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
  }
  return null;
}

/** WCAG relative luminance of an [r, g, b] triple (0 = black, 1 = white). */
export function relativeLuminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1..21) between two colours (strings or parsed). */
export function contrastRatio(a, b) {
  const ca = Array.isArray(a) ? a : parseCssColor(a);
  const cb = Array.isArray(b) ? b : parseCssColor(b);
  if (!ca || !cb) return null;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The label colour to use on `fill`: null when `currentText` already meets
 * MIN_LABEL_CONTRAST (keep the theme's choice), otherwise whichever of
 * DARK_LABEL_TEXT / LIGHT_LABEL_TEXT contrasts better with the fill.
 */
export function pickLabelColor(fill, currentText) {
  const bg = parseCssColor(fill);
  if (!bg) return null;
  const current = contrastRatio(currentText, bg);
  if (current !== null && current >= MIN_LABEL_CONTRAST) return null;
  return contrastRatio(DARK_LABEL_TEXT, bg) >= contrastRatio(LIGHT_LABEL_TEXT, bg) ? DARK_LABEL_TEXT : LIGHT_LABEL_TEXT;
}

// Inline style / presentation attribute first (what classDef emits), then the
// cascade (the theme's scoped <style> rules) via getComputedStyle. The style
// attribute is read as text as well: jsdom's CSSOM (the unit tests) does not
// model SVG's `fill`, while mermaid always writes it as `fill:#xxx !important`.
function inlineFill(el) {
  const viaCssom = el.style && el.style.getPropertyValue && el.style.getPropertyValue('fill');
  if (viaCssom) return viaCssom;
  const m = ((el.getAttribute && el.getAttribute('style')) || '').match(/(?:^|;)\s*fill\s*:\s*([^;!]+)/i);
  return m ? m[1].trim() : '';
}

function effectiveFill(el) {
  if (!el) return null;
  const inline = inlineFill(el);
  if (inline) return inline;
  const attr = el.getAttribute && el.getAttribute('fill');
  if (attr) return attr;
  const view = el.ownerDocument.defaultView;
  return view ? view.getComputedStyle(el).fill : null;
}

// Write `fill: color !important` inline (an inline declaration is the only
// thing that beats the theme's `.label text { fill }` rule; a presentation
// attribute would lose to it). Falls back to editing the style attribute
// text where the CSSOM does not know `fill` (jsdom).
function setImportantFill(el, color) {
  if (el.style && el.style.setProperty) el.style.setProperty('fill', color, 'important');
  if (!/(?:^|;)\s*fill\s*:/i.test(el.getAttribute('style') || '')) {
    const rest = (el.getAttribute('style') || '').replace(/;?\s*$/, '');
    el.setAttribute('style', `${rest ? rest + ';' : ''}fill:${color} !important`);
  }
}

function clearImportantFill(el) {
  if (el.style && el.style.removeProperty) el.style.removeProperty('fill');
  const stripped = (el.getAttribute('style') || '').replace(/(?:^|;)\s*fill\s*:[^;]*/gi, '').replace(/^;+|;+$/g, '');
  if (stripped) el.setAttribute('style', stripped);
  else el.removeAttribute('style');
}

function isVisibleShape(el) {
  if (!el) return false;
  const fill = parseCssColor(effectiveFill(el));
  if (!fill || fill[3] === 0) return false;
  const view = el.ownerDocument.defaultView;
  if (view) {
    const cs = view.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.fillOpacity) === 0 || parseFloat(cs.opacity) === 0) return false;
  }
  return true;
}

// A label group (or its texts) the AUTHOR coloured: mermaid writes the
// classDef/style `color:` onto the label group as `style="color:..."` and as
// `style="fill:..."` on the text - always the style attribute. A `fill`
// presentation attribute is theme/renderer output and counts as the current
// colour (effectiveFill), never as an author choice.
function authorColoredLabel(group, texts) {
  const groupStyle = (group && group.getAttribute('style')) || '';
  if (/(^|;)\s*color\s*:/i.test(groupStyle)) return true;
  return texts.some((t) => {
    if (t.hasAttribute(CONTRAST_MARKER)) return false; // ours, not the author's
    return /(^|;)\s*fill\s*:/i.test(t.getAttribute('style') || '');
  });
}

function fixLabel(shape, texts, labelGroup) {
  if (!shape || !texts.length) return 0;
  // Re-runs start from the theme's colour: drop what a previous pass set
  for (const t of texts) {
    if (t.hasAttribute(CONTRAST_MARKER)) {
      clearImportantFill(t);
      t.removeAttribute(CONTRAST_MARKER);
    }
  }
  if (authorColoredLabel(labelGroup, texts)) return 0;
  if (!isVisibleShape(shape)) return 0;
  const fill = effectiveFill(shape);
  const color = pickLabelColor(fill, effectiveFill(texts[0]));
  if (!color) return 0;
  for (const t of texts) {
    setImportantFill(t, color);
    t.setAttribute(CONTRAST_MARKER, color);
  }
  return 1;
}

const SHAPE_SELECTOR = ':scope > rect, :scope > polygon, :scope > path, :scope > circle, :scope > ellipse, :scope > g > rect, :scope > g > polygon, :scope > g > path';

/**
 * Dark theme only: make every label readable on the shape it sits on unless
 * the author chose a text colour. Covers flowchart/state/class/ER nodes
 * (g.node), subgraph/cluster titles, edge labels, and sequence/state notes
 * and actors. Returns the number of labels recoloured. Idempotent.
 */
export function ensureDarkLabelContrast(root) {
  if (!root || !root.querySelectorAll) return 0;
  let fixed = 0;
  const textsIn = (scope) => (scope ? Array.from(scope.querySelectorAll('text, tspan')) : []);

  // Nodes: shape is the direct child (or one g deeper for composite looks);
  // the label lives in g.label, never counted as the shape.
  for (const node of root.querySelectorAll('g.node')) {
    const shape = Array.from(node.querySelectorAll(SHAPE_SELECTOR)).find((s) => !s.closest('.label'));
    const label = node.querySelector(':scope > .label, :scope > g > .label') || node.querySelector('.label');
    fixed += fixLabel(shape, textsIn(label), label);
  }
  // Subgraph / cluster titles
  for (const cluster of root.querySelectorAll('g.cluster')) {
    const shape = cluster.querySelector(':scope > rect, :scope > g > rect');
    const label = cluster.querySelector('.cluster-label') || cluster;
    fixed += fixLabel(shape, textsIn(label).filter((t) => t.closest('.cluster-label') || label === cluster), label);
  }
  // Edge labels: text on the label's own background chip
  for (const edgeLabel of root.querySelectorAll('.edgeLabel')) {
    const shape = edgeLabel.querySelector('rect');
    const label = edgeLabel.querySelector('.label') || edgeLabel;
    fixed += fixLabel(shape, textsIn(edgeLabel), label);
  }
  // Sequence / state notes and sequence actors: rect + sibling text
  for (const shape of root.querySelectorAll('rect.note, rect.actor, rect.actor-top, rect.actor-bottom')) {
    const parent = shape.parentElement;
    if (!parent) continue;
    const texts = Array.from(parent.children).filter((c) => c.tagName === 'text' && (c.classList.contains('noteText') || c.classList.contains('actor')));
    fixed += fixLabel(shape, texts.flatMap((t) => [t, ...Array.from(t.querySelectorAll('tspan'))]), null);
  }
  return fixed;
}

function applyError(el, theme, error) {
  clearOutput(el);
  const doc = el.ownerDocument;
  const box = doc.createElement('div');
  box.className = 'mermaid-diagram-error';
  const title = doc.createElement('div');
  title.className = 'mermaid-diagram-error-title';
  title.textContent = 'Mermaid diagram could not be rendered';
  const message = doc.createElement('div');
  message.className = 'mermaid-diagram-error-message';
  // Text node, never markup: the message echoes user-authored source
  message.textContent = String((error && error.message) || error || 'Unknown error').trim().slice(0, 2000);
  box.appendChild(title);
  box.appendChild(message);
  el.insertBefore(box, el.firstChild);
  el.setAttribute('data-mermaid', 'error');
  el.setAttribute('data-mermaid-theme', theme);
}

/**
 * Placeholders that renderMermaidDiagrams(container, { theme }) would touch:
 * every pending one, plus already-rendered ones drawn with a different theme
 * (a theme toggle re-renders those). Errors are theme-independent and are
 * left alone until the source changes.
 */
export function findMermaidTargets(container, theme = mermaidThemeForApp()) {
  if (!container) return [];
  return Array.from(container.querySelectorAll('.mermaid-diagram')).filter((el) => {
    const state = el.getAttribute('data-mermaid');
    if (state === 'pending') return true;
    return state === 'rendered' && el.getAttribute('data-mermaid-theme') !== theme;
  });
}

/**
 * Render every ```mermaid placeholder inside `container`.
 *
 * Never throws for bad diagram source: each failure becomes an inline error
 * box while the other diagrams still render. Resolves once every target has
 * been handled (or the call was aborted), so callers that need the finished
 * DOM (the PDF export) can simply await it.
 *
 * @param {HTMLElement} container - rendered .markdown-preview root
 * @param {object} [options]
 * @param {string} [options.theme] - mermaid theme; defaults to the app's light/dark state
 * @param {string} [options.fontFamily] - font stack for labels (the PDF export passes
 *   its Helvetica stack so measured and drawn glyph widths agree)
 * @param {AbortSignal} [options.signal] - abort when the preview unmounts or the
 *   document changes mid-render; no DOM is touched afterwards
 * @param {() => Promise<object>} [options.load] - test seam: replaces the mermaid import
 * @returns {Promise<{rendered: number, failed: number}>}
 */
export async function renderMermaidDiagrams(container, options = {}) {
  const {
    theme = mermaidThemeForApp(),
    fontFamily = DEFAULT_MERMAID_FONT,
    signal = null,
    load = loadMermaidModule,
  } = options;
  const result = { rendered: 0, failed: 0 };
  const targets = findMermaidTargets(container, theme);
  if (!targets.length) return result;

  // Claim the targets synchronously (see the state machine note above)
  const pendingOwned = new Set(targets);
  for (const el of targets) el.setAttribute('data-mermaid', 'rendering');
  const releaseUnfinished = () => {
    for (const el of pendingOwned) {
      if (el.getAttribute('data-mermaid') === 'rendering') el.setAttribute('data-mermaid', 'pending');
    }
    pendingOwned.clear();
  };
  if (signal) {
    if (signal.aborted) {
      releaseUnfinished();
      return result;
    }
    signal.addEventListener('abort', releaseUnfinished, { once: true });
  }
  const stillMine = (el) =>
    !(signal && signal.aborted) && pendingOwned.has(el) && container.isConnected && container.contains(el);

  let mermaid = null;
  let loadError = null;
  try {
    mermaid = await load();
  } catch (err) {
    loadError = err instanceof Error ? err : new Error(String(err));
  }

  try {
    // Skipped elements (aborted, container unmounted, element replaced) are
    // deliberately NOT dropped from pendingOwned here: the finally block
    // releases them back to "pending" so they never get stuck in
    // "rendering" if their tree is shown again.
    for (const el of targets) {
      if (signal && signal.aborted) break;
      if (!stillMine(el)) continue;
      const source = readSource(el);
      const cacheKey = `${theme}|${fontFamily}\n${source}`;
      let svg = cacheGet(cacheKey);
      let error = loadError;
      if (svg === undefined && !error) {
        try {
          ensureInitialized(mermaid, theme, fontFamily);
          const rendered = await mermaid.render(nextRenderId(), source);
          svg = sanitizeSvg(rendered.svg);
          cacheSet(cacheKey, svg);
        } catch (err) {
          error = err;
        }
      }
      if (!stillMine(el)) continue;
      if (error) {
        applyError(el, theme, error);
        result.failed += 1;
      } else {
        applySvg(el, theme, svg);
        result.rendered += 1;
      }
      pendingOwned.delete(el);
    }
  } finally {
    if (signal) signal.removeEventListener('abort', releaseUnfinished);
    releaseUnfinished();
  }
  return result;
}

/* ------------------------------------------------------------------------ *
 * "Download SVG" (Documents preview context menu)
 *
 * The preview's diagram is a DOMPurify-sanitized SVG that relies on the app
 * page around it: `width="100%"` sized by the container, the page's
 * background behind it (mermaid's dark theme draws light text and never
 * paints its own background), and mermaid's scoped <style> inside it.
 * serializeDiagramSvg turns the LIVE element (so a dark render carries the
 * label-contrast overrides applied above) into a standalone file: XML
 * declaration, explicit xmlns/width/height/viewBox, every paint/text value
 * written onto the elements as presentation attributes (no stylesheet, no
 * style attributes, no filters - see inlineComputedStyles for why), and a
 * background rect matching the theme so a dark diagram does not become light
 * text on transparent in a browser or Inkscape. Nothing is fetched or
 * embedded: fonts stay the system font stack the diagram already names.
 * ------------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Background painted behind an exported diagram, per mermaid theme. */
export const MERMAID_EXPORT_BACKGROUNDS = { default: '#ffffff', dark: '#1e1e1e' };

/**
 * `<doc-title>-diagram-<index>.svg`, with the title made safe for file
 * names the same way the ZIP/PDF exports do (useImportExport.js
 * sanitizeZipEntryName: reserved characters -> "-", whitespace -> "_").
 */
export function diagramExportFilename(title, index) {
  const safe = String(title || '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\p{Cc}/gu, '-') // control characters
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 80);
  const n = Number.isInteger(index) && index > 0 ? index : 1;
  return `${safe || 'Untitled'}-diagram-${n}.svg`;
}

function parseViewBox(value) {
  const parts = String(value || '').trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) return parts;
  return null;
}

/*
 * Mermaid styles almost everything through its scoped stylesheet: edge
 * strokes (`#id .flowchart-link{stroke:...;fill:none}`), marker fills,
 * message lines, label colours, and - in the "neo" look - gradient strokes
 * and drop-shadow filters on node shapes. It also writes its edge draw-in
 * animation onto every edge as an inline style
 * (`style="stroke-dasharray: 0 0 <length> 4; stroke-dashoffset: 0"`).
 * Browsers handle all of that; SVG importers with partial CSS support do
 * not: Adobe Illustrator dropped every edge line (a dash pattern starting
 * with zero-length dashes, then the `.edge-pattern-solid{stroke-dasharray:0}`
 * rule) while keeping the default-filled arrowheads, and painted the
 * `[data-look="neo"] polygon{filter:drop-shadow(...)}` rule as a smeared
 * shadow on decision diamonds.
 *
 * The export is therefore made fully self-describing and free of anything
 * such an importer can misread: every graphic/text leaf carries the COMPUTED
 * value of its paint and text properties as plain presentation attributes
 * (hex colours, unit-less numbers, alpha folded into fill/stroke-opacity),
 * solid edges carry no dash pattern at all (only genuinely dotted/dashed
 * strokes keep a plain repeating pattern), `style` attributes, the
 * stylesheet, filters and data-* attributes are dropped. Browsers render the
 * computed values exactly as before; only mermaid's subtle drop shadows on
 * "neo" shapes are not reproduced (a deliberate trade-off).
 */
const PAINT_PROPS = [
  ['fill', 'rgb(0, 0, 0)'], ['fill-opacity', '1'], ['fill-rule', 'nonzero'],
  ['stroke', 'none'], ['stroke-width', '1'], ['stroke-opacity', '1'], ['stroke-dasharray', 'none'],
  ['stroke-dashoffset', '0'], ['stroke-linecap', 'butt'], ['stroke-linejoin', 'miter'], ['stroke-miterlimit', '4'],
  ['opacity', '1'], ['visibility', 'visible'], ['display', 'inline'],
];
const TEXT_PROPS = [
  ['font-family', ''], ['font-size', ''], ['font-weight', '400'], ['font-style', 'normal'],
  ['text-anchor', 'start'], ['dominant-baseline', 'auto'], ['letter-spacing', 'normal'], ['text-decoration', 'none'],
];
// Properties a group can carry that its leaves do not inherit as paint
const GROUP_PROPS = [['opacity', '1'], ['visibility', 'visible'], ['display', 'inline']];
// Written on every leaf even when they equal the initial value: the file
// must not rely on an importer's defaults for what is visible.
const ALWAYS_ON_LEAVES = new Set(['fill', 'stroke']);
const LEAF_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'use', 'image']);
const TEXT_TAGS = new Set(['text', 'tspan']);
// Containers whose own style/opacity matters for what is drawn inside them
const GROUP_TAGS = new Set(['svg', 'g', 'a', 'marker', 'symbol', 'switch']);

const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/**
 * A computed colour as a presentation-attribute value: `#rrggbb` (with the
 * alpha returned separately so the caller can fold it into *-opacity),
 * `none`, or an unchanged paint server reference (`url(#gradient)`).
 * @returns {{ value: string, alpha: number }}
 */
export function colorToAttribute(raw) {
  const v = String(raw || '').trim();
  if (!v || v === 'none') return { value: 'none', alpha: 1 };
  const parsed = parseCssColor(v);
  if (parsed) return { value: `#${toHex(parsed[0])}${toHex(parsed[1])}${toHex(parsed[2])}`, alpha: parsed[3] };
  // url("#id") -> url(#id): quotes inside an attribute confuse some importers
  const url = v.match(/^url\(\s*["']?([^"')]+)["']?\s*\)$/);
  if (url) return { value: `url(${url[1]})`, alpha: 1 };
  return { value: v, alpha: 1 };
}

/**
 * A computed stroke-dasharray as a plain, importer-safe pattern: unit-less
 * numbers, `none` for anything that draws as a solid line, mermaid's draw-in
 * animation pattern (`0 0 <length> 4`) and "dash, zero gap" patterns treated
 * as solid, and a repeated two-value unit with an odd tail (mermaid's dotted
 * `0 0 2 2 2 2 ... 4`) reduced to the unit.
 * @param {string} raw - computed value
 * @param {number|null} pathLength - the live element's total length, if known
 */
export function normalizeDashArray(raw, pathLength = null) {
  const v = String(raw || '').trim();
  if (!v || v === 'none') return 'none';
  const parts = v.split(/[\s,]+/).filter(Boolean).map((p) => parseFloat(p)).filter(Number.isFinite);
  if (!parts.length) return 'none';
  let leadingZeroPairs = 0;
  while (parts.length >= 2 && parts[0] === 0 && parts[1] === 0) {
    parts.splice(0, 2);
    leadingZeroPairs += 1;
  }
  if (!parts.length || parts.every((p) => p === 0)) return 'none';
  if (parts.length === 2 && parts[1] === 0) return 'none';
  // mermaid's draw-in animation writes "0 0 <length> 4" on every edge, with
  // <length> a few units short of the path (the arrow margin): the leading
  // zero pair followed by one dash/gap pair is that signature - solid.
  if (leadingZeroPairs > 0 && parts.length === 2) return 'none';
  if (parts.length <= 2 && pathLength && parts[0] >= pathLength * 0.9) return 'none';
  if (parts.length >= 4) {
    const [a, b] = parts;
    const body = parts.length % 2 === 1 ? parts.slice(0, -1) : parts;
    if (body.every((val, i) => val === (i % 2 ? b : a))) return `${a} ${b}`;
  }
  return parts.join(' ');
}

const stripPx = (v) => String(v).trim().replace(/px$/, '');

function liveLength(el) {
  try {
    return typeof el.getTotalLength === 'function' ? el.getTotalLength() : null;
  } catch {
    return null;
  }
}

function readProp(cs, name) {
  const raw = cs.getPropertyValue ? cs.getPropertyValue(name) : cs[name];
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

function applyLeafAttributes(src, dst, cs, tag) {
  const props = TEXT_TAGS.has(tag) ? [...PAINT_PROPS, ...TEXT_PROPS] : PAINT_PROPS;
  const out = new Map();
  for (const [name, initial] of props) {
    const raw = readProp(cs, name);
    if (raw === '') continue;
    let value;
    if (name === 'fill' || name === 'stroke') {
      const c = colorToAttribute(raw);
      value = c.value;
      if (c.alpha < 1) {
        const key = `${name}-opacity`;
        const current = parseFloat(readProp(cs, key));
        out.set(key, String(+(c.alpha * (Number.isFinite(current) ? current : 1)).toFixed(3)));
      }
    } else if (name === 'stroke-dasharray') {
      value = normalizeDashArray(raw, liveLength(src));
    } else if (/^(stroke-width|stroke-dashoffset|font-size|letter-spacing|stroke-miterlimit)$/.test(name)) {
      value = stripPx(raw);
    } else {
      value = raw;
    }
    if (!out.has(name) && (ALWAYS_ON_LEAVES.has(name) || value !== initial) && value !== '') out.set(name, value);
  }
  // An explicit width whenever there is a stroke, so nothing rests on defaults
  if (out.get('stroke') && out.get('stroke') !== 'none' && !out.has('stroke-width')) {
    const w = stripPx(readProp(cs, 'stroke-width'));
    out.set('stroke-width', w || '1');
  }
  if (out.get('stroke') === 'none') {
    out.delete('stroke-width');
    out.delete('stroke-dasharray');
    out.delete('stroke-dashoffset');
  }
  for (const [name, value] of out) dst.setAttribute(name, value);
  return out.size > 0;
}

function applyGroupAttributes(dst, cs) {
  let any = false;
  for (const [name, initial] of GROUP_PROPS) {
    const raw = readProp(cs, name);
    if (raw && raw !== initial) {
      dst.setAttribute(name, raw);
      any = true;
    }
  }
  return any;
}

/**
 * Make `clone` (a deep clone of the live `live` element, walked in parallel -
 * call before anything is removed from either) self-describing: computed
 * paint/text properties become presentation attributes on every leaf,
 * groups keep only their effective opacity/visibility/display, and `style`,
 * `filter` and data-* attributes are removed. `computeStyle(el)` defaults to
 * the live document's getComputedStyle.
 * @returns {number} elements that received at least one attribute
 */
export function inlineComputedStyles(live, clone, computeStyle) {
  const view = live.ownerDocument && live.ownerDocument.defaultView;
  const compute = computeStyle || (view ? (el) => view.getComputedStyle(el) : null);
  if (!compute) return 0;
  const liveEls = [live, ...Array.from(live.querySelectorAll('*'))];
  const cloneEls = [clone, ...Array.from(clone.querySelectorAll('*'))];
  if (liveEls.length !== cloneEls.length) return 0;
  let touched = 0;
  for (let i = 0; i < liveEls.length; i++) {
    const src = liveEls[i];
    const dst = cloneEls[i];
    const tag = String(src.tagName).toLowerCase();
    const cs = compute(src);
    if (!cs) continue;
    // Only trust the environment once it actually reports computed paint;
    // otherwise keep the element's own inline style rather than lose it.
    const captured = readProp(cs, 'fill') !== '' || readProp(cs, 'stroke') !== '';
    let any = false;
    if (LEAF_TAGS.has(tag)) any = captured && applyLeafAttributes(src, dst, cs, tag);
    else if (GROUP_TAGS.has(tag)) any = captured && applyGroupAttributes(dst, cs);
    if (captured) dst.removeAttribute('style');
    dst.removeAttribute('filter');
    for (const attr of Array.from(dst.attributes)) {
      if (/^data-/i.test(attr.name)) dst.removeAttribute(attr.name);
    }
    if (any) touched += 1;
  }
  return touched;
}


/* ------------------------------------------------------------------------ *
 * Markers -> plain paths
 *
 * Adobe Illustrator's SVG importer collapses ANY <path> that carries a
 * marker-start/marker-end reference into a single-point, unstroked path
 * (verified with mermaid's markers and with the plainest possible marker
 * definition alike) while it expands the arrowhead separately - so every
 * flowchart edge and sequence message lost its line and kept its arrowhead.
 * The export therefore draws each referenced marker as an ordinary <g> of
 * plain shapes placed with the exact marker transform (vertex, tangent
 * angle for orient="auto", markerUnits, viewBox scale, refX/refY) and drops
 * the marker attributes and definitions. Browsers draw the same geometry.
 * ------------------------------------------------------------------------ */

const MARKER_ATTRS = ['marker-start', 'marker-mid', 'marker-end'];
const round3 = (n) => String(Math.round(n * 1000) / 1000);

function parseUrlRef(value) {
  const m = String(value || '').match(/^url\(\s*["']?#([^"')]+)["']?\s*\)$/);
  return m ? m[1] : null;
}

// Vertex and tangent direction at both ends of a live geometry element
function endpointGeometry(el) {
  try {
    if (typeof el.getTotalLength !== 'function' || typeof el.getPointAtLength !== 'function') return null;
    const len = el.getTotalLength();
    if (!(len > 0)) return null;
    const eps = Math.min(1, len / 2);
    const at = (d) => { const pt = el.getPointAtLength(d); return { x: pt.x, y: pt.y }; };
    const angle = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const s0 = at(0); const s1 = at(eps); const e1 = at(len - eps); const e0 = at(len);
    return { start: { point: s0, angle: angle(s0, s1) }, end: { point: e0, angle: angle(e1, e0) } };
  } catch {
    return null;
  }
}

/**
 * The transform that places a <marker>'s content at `vertex` the way the
 * browser renders it: translate to the vertex, rotate per `orient`, scale by
 * the stroke width (unless markerUnits="userSpaceOnUse") and by the
 * viewBox-to-marker-size ratio (preserveAspectRatio meet), then move the
 * reference point (refX, refY) onto the vertex.
 */
export function markerTransform(marker, vertex, tangentAngle, strokeWidth = 1, isStart = false) {
  const mw = parseFloat(marker.getAttribute('markerWidth')) || 3;
  const mh = parseFloat(marker.getAttribute('markerHeight')) || 3;
  const vb = parseViewBox(marker.getAttribute('viewBox'));
  const viewScale = vb ? Math.min(mw / vb[2], mh / vb[3]) : 1;
  const units = (marker.getAttribute('markerUnits') || 'strokeWidth').trim();
  const k = viewScale * (units === 'userSpaceOnUse' ? 1 : (strokeWidth || 1));
  const orient = (marker.getAttribute('orient') || '0').trim();
  let angle = 0;
  if (orient === 'auto') angle = tangentAngle;
  else if (orient === 'auto-start-reverse') angle = isStart ? tangentAngle + 180 : tangentAngle;
  else angle = parseFloat(orient) || 0;
  const refX = parseFloat(marker.getAttribute('refX')) || 0;
  const refY = parseFloat(marker.getAttribute('refY')) || 0;
  return `translate(${round3(vertex.x)} ${round3(vertex.y)}) rotate(${round3(angle)}) scale(${round3(k)}) translate(${round3(-refX)} ${round3(-refY)})`;
}

/**
 * Replace marker references in `clone` with baked arrowhead groups, using
 * the paired `live` elements for geometry. Same parallel walk as
 * inlineComputedStyles (call it before anything is removed from either
 * tree). When an element's geometry cannot be read (no getPointAtLength),
 * its marker reference is left in place and the definitions are kept.
 * @returns {number} arrowheads baked
 */
export function bakeMarkers(live, clone) {
  const liveEls = [live, ...Array.from(live.querySelectorAll('*'))];
  const cloneEls = [clone, ...Array.from(clone.querySelectorAll('*'))];
  if (liveEls.length !== cloneEls.length) return 0;
  const doc = clone.ownerDocument;
  const markers = Array.from(clone.querySelectorAll('marker'));
  let baked = 0;
  for (let i = 0; i < cloneEls.length; i++) {
    const dst = cloneEls[i];
    if (!MARKER_ATTRS.some((a) => dst.hasAttribute(a))) continue;
    const geom = endpointGeometry(liveEls[i]);
    if (!geom) continue;
    const strokeWidth = parseFloat(dst.getAttribute('stroke-width')) || 1;
    for (const [attr, key] of [['marker-start', 'start'], ['marker-end', 'end']]) {
      const id = parseUrlRef(dst.getAttribute(attr));
      if (!id) continue;
      const marker = markers.find((m) => m.getAttribute('id') === id);
      if (marker) {
        const g = doc.createElementNS(SVG_NS, 'g');
        g.setAttribute('class', 'mermaid-export-marker');
        g.setAttribute('transform', markerTransform(marker, geom[key].point, geom[key].angle, strokeWidth, key === 'start'));
        for (const child of Array.from(marker.children)) g.appendChild(child.cloneNode(true));
        dst.parentNode.insertBefore(g, dst.nextSibling);
        baked += 1;
      }
      dst.removeAttribute(attr);
    }
    dst.removeAttribute('marker-mid');
  }
  if (!clone.querySelector('[marker-start], [marker-mid], [marker-end]')) {
    for (const m of markers) m.remove();
  }
  return baked;
}

/**
 * Serialize a rendered diagram's <svg> element as a standalone SVG document.
 *
 * @param {SVGSVGElement} svgEl - the live, sanitized diagram element
 * @param {object} [options]
 * @param {'default'|'dark'} [options.theme] - picks the background colour
 * @param {string} [options.background] - explicit background (e.g. the preview
 *   pane's computed background); ignored when transparent/unparseable
 * @returns {string} XML text of the SVG file
 */
export function serializeDiagramSvg(svgEl, options = {}) {
  if (!svgEl || String(svgEl.tagName).toLowerCase() !== 'svg') {
    throw new Error('serializeDiagramSvg: expected an <svg> element');
  }
  const { theme = 'default', background, computeStyle } = options;
  const doc = svgEl.ownerDocument;
  const clone = svgEl.cloneNode(true);

  // Self-describing paint/text attributes from the LIVE element's computed
  // styles (see inlineComputedStyles) - before anything is removed from the
  // clone, so the two trees still line up. The stylesheet and filter
  // definitions are then dropped: every value they contributed is now on
  // the elements, and importers with partial CSS support misapplied them.
  inlineComputedStyles(svgEl, clone, computeStyle);
  // Arrowheads as plain shapes (see bakeMarkers); the marker attributes and
  // definitions go with them.
  bakeMarkers(svgEl, clone);
  for (const el of Array.from(clone.querySelectorAll('style, filter'))) el.remove();

  // Defense in depth: the input is already DOMPurify-sanitized; make sure a
  // standalone file can never carry script, HTML islands or handlers anyway.
  for (const el of Array.from(clone.querySelectorAll('script, foreignObject, foreignobject, iframe, object, embed'))) el.remove();
  for (const el of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }

  // Size: explicit width/height from the viewBox (mermaid sets width="100%"
  // and sizes the element through the container); derive a viewBox from the
  // rendered box if a diagram lacks one.
  let viewBox = parseViewBox(clone.getAttribute('viewBox'));
  if (!viewBox) {
    const rect = typeof svgEl.getBoundingClientRect === 'function' ? svgEl.getBoundingClientRect() : null;
    const w = (rect && rect.width) || parseFloat(clone.getAttribute('width')) || 800;
    const h = (rect && rect.height) || parseFloat(clone.getAttribute('height')) || 600;
    viewBox = [0, 0, Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
    clone.setAttribute('viewBox', viewBox.join(' '));
  }
  clone.setAttribute('width', String(viewBox[2]));
  clone.setAttribute('height', String(viewBox[3]));

  // Background: the page is not part of the file. Prefer the caller's
  // (opaque) colour, else the theme's.
  const wanted = parseCssColor(background);
  const fill = wanted && wanted[3] > 0 ? background : (MERMAID_EXPORT_BACKGROUNDS[theme] || MERMAID_EXPORT_BACKGROUNDS.default);
  const bg = doc.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('class', 'mermaid-export-background');
  bg.setAttribute('x', String(viewBox[0]));
  bg.setAttribute('y', String(viewBox[1]));
  bg.setAttribute('width', String(viewBox[2]));
  bg.setAttribute('height', String(viewBox[3]));
  bg.setAttribute('fill', fill);
  // Always the FIRST child: SVG paints in document order (mermaid's sequence
  // renderer had its <style> after the actor groups, and a background
  // inserted "after the stylesheet" covered the actors and lifelines).
  clone.insertBefore(bg, clone.firstChild);

  let xml = new XMLSerializer().serializeToString(clone);
  // The serializer declares the namespace for an SVG-namespace element; an
  // element that came through HTML parsing without one gets it here.
  if (!/^<svg[^>]*\sxmlns=("|')http:\/\/www\.w3\.org\/2000\/svg\1/.test(xml)) {
    xml = xml.replace(/^<svg/, `<svg xmlns="${SVG_NS}"`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`;
}
