import DOMPurify from 'dompurify';

/**
 * ```latex fenced blocks rendered as maths (the Documents preview and the
 * PDF export), the way ```mermaid blocks are (src/utils/mermaidDiagrams.js):
 * the renderer (src/utils/interactiveMarkdown.js) emits an inert placeholder
 * - <div class="latex-block" data-latex="pending"> with the source as an
 * escaped code block - and renderLatexBlocks() fills it in afterwards,
 * loading KaTeX (and its stylesheet, fonts bundled) the first time a
 * document has one. Fenced blocks only: no inline $...$, no $$...$$.
 *
 * Each block is display maths. Blank-line-separated parts of a block are
 * separate displays (one formula under the other, each centred); a line
 * break inside a part is a line break of the formula (`\\`, `aligned`,
 * `cases` work as in LaTeX).
 *
 * Security: KaTeX runs with trust: false (no \href, \url, \includegraphics,
 * \htmlClass, \htmlStyle, \htmlData ...), expansion and size limits
 * (MAX_EXPAND, MAX_SIZE_EM) and a source length cap (MAX_SOURCE_CHARS) so a
 * hostile or huge formula cannot stall the preview, and its HTML + MathML
 * output goes through DOMPurify with exactly the elements and attributes
 * that output needs, the inline style attributes reduced to KaTeX's own
 * sizing properties with plain numeric values (sanitizeLatexHtml). A
 * formula that does not parse becomes an error box with KaTeX's message,
 * the source still shown; nothing throws out of the render.
 */

export const LATEX_PENDING_SELECTOR = '.latex-block[data-latex="pending"]';
/** KaTeX's macro expansion budget (its default is 1000): a `\def\a{\a\a}\a` bomb stops here. */
export const MAX_EXPAND = 1000;
/** KaTeX's cap on user-given sizes, in em (\rule{9999em}{...}, \kern): clamped, never a page-wide box. */
export const MAX_SIZE_EM = 40;
/** A block longer than this is not parsed at all (an error box instead). */
export const MAX_SOURCE_CHARS = 20000;
/** The most displays one block renders (a blank line starts a new one). */
export const MAX_PARTS = 50;

const KATEX_OPTIONS = Object.freeze({
  displayMode: true,
  output: 'htmlAndMathml',
  throwOnError: true,      // caught below: the error becomes a readable box with the message (not KaTeX's red source)
  trust: false,
  strict: 'ignore',        // unicode text in maths and the like render rather than warn; no security weight
  maxExpand: MAX_EXPAND,
  maxSize: MAX_SIZE_EM,
  globalGroup: false,
});

// ---------------------------------------------------------------- the sanitizer
// What KaTeX's htmlAndMathml output is made of, and nothing else.
const ALLOWED_TAGS = [
  '#text',   // a custom ALLOWED_TAGS replaces DOMPurify's whole default list, text nodes included
  'div',     // the sanitizer's own wrapper only (KaTeX emits spans)
  'span', 'svg', 'path', 'line', 'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'ms',
  'msup', 'msub', 'msubsup', 'mfrac', 'mroot', 'msqrt', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd',
  'mstyle', 'mpadded', 'mphantom', 'menclose', 'mglyph', 'mlabeledtr', 'mmultiscripts', 'mprescripts', 'none',
];
const ALLOWED_ATTR = [
  'class', 'style', 'aria-hidden', 'title',
  // svg (stretchy delimiters and the square root sign)
  'xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'd', 'x1', 'x2', 'y1', 'y2', 'stroke-width',
  // MathML
  'encoding', 'mathvariant', 'display', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'minsize', 'maxsize',
  'movablelimits', 'accent', 'accentunder', 'columnalign', 'columnlines', 'columnspacing', 'rowspacing', 'rowlines',
  'frame', 'mathcolor', 'mathbackground', 'mathsize', 'scriptlevel', 'displaystyle', 'notation', 'linethickness',
  'height', 'depth', 'lspace', 'voffset', 'symmetric', 'largeop', 'form', 'rowalign',
];
// the inline styles KaTeX writes (sizes and offsets in em, the \color colours) - with plain values only
const STYLE_PROPS = new Set([
  'height', 'width', 'min-width', 'vertical-align', 'top', 'left', 'margin-left', 'margin-right', 'margin-top',
  'padding-left', 'padding-right', 'padding-top', 'padding-bottom', 'border-bottom-width', 'border-top-width',
  'border-left-width', 'border-right-width', 'color', 'border-color', 'background-color', 'font-size',
  'transform', 'position', 'display', 'text-align',
]);
const STYLE_LENGTH = /^-?\d*\.?\d+(em|ex|px|pt|%)?$/;
const STYLE_COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\(\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*(,\s*\d*\.?\d+\s*)?\))$/;
const STYLE_TRANSFORM = /^(scale|translate|scaleX|scaleY)\([-\d.,\s%em]*\)$/;
const STYLE_WORD = /^[a-z-]+$/;

/** A style attribute reduced to KaTeX's own properties with plain values: anything else (url(), expression(), unknown properties) is dropped. */
export function sanitizeStyle(value) {
  const kept = [];
  for (const decl of String(value || '').split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || !val || /[(]/.test(val) && !(prop === 'transform' || /^(color|border-color|background-color)$/.test(prop))) continue;
    const ok = /color$/.test(prop) ? STYLE_COLOR.test(val)
      : prop === 'transform' ? STYLE_TRANSFORM.test(val)
        : /^(position|display|text-align)$/.test(prop) ? STYLE_WORD.test(val)
          : STYLE_LENGTH.test(val) || (prop === 'font-size' && STYLE_WORD.test(val));
    if (ok) kept.push(`${prop}:${val}`);
  }
  return kept.join(';');
}

let hookInstalled = false;
function installStyleHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'style' && node && node.closest && node.closest('.latex-sanitize-root')) {
      data.attrValue = sanitizeStyle(data.attrValue);
      if (!data.attrValue) data.keepAttr = false;
    }
  });
}

/**
 * KaTeX's output through DOMPurify: the allowed elements and attributes above (html, MathML and svg profiles are
 * not used - the lists are the whole of it), no URI-bearing attributes at all, the style attributes reduced.
 */
export function sanitizeLatexHtml(html) {
  installStyleHook();
  return DOMPurify.sanitize(`<div class="latex-sanitize-root">${html}</div>`, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: false,
    FORBID_TAGS: ['a', 'img', 'iframe', 'script', 'style', 'object', 'embed', 'foreignObject', 'use', 'animate', 'set', 'form', 'input', 'button'],
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset', 'action', 'formaction', 'onload', 'onerror', 'onclick'],
  }).replace(/^<div class="latex-sanitize-root">/, '').replace(/<\/div>$/, '');
}

// ---------------------------------------------------------------- rendering
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The parts of a block: blank-line-separated formulas (each one display). */
export function splitFormulas(source) {
  return String(source || '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n(?:[ \t]*\n)*/).map((s) => s.trim()).filter(Boolean);
}

let katexPromise = null;
function loadKatex() {
  if (!katexPromise) {
    katexPromise = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([mod]) => mod.default || mod);
    katexPromise.catch(() => { katexPromise = null; });
  }
  return katexPromise;
}

/**
 * The HTML of one block's source: the sanitized displays, or an error box ({ html, error }). Exported for the
 * tests (`katex` given; the live path loads it).
 */
export function renderLatexSource(katex, source) {
  const text = String(source || '');
  if (text.length > MAX_SOURCE_CHARS) {
    return { html: errorBox(`The block is ${text.length.toLocaleString('en')} characters long; at most ${MAX_SOURCE_CHARS.toLocaleString('en')} are rendered.`), error: 'too long' };
  }
  const parts = splitFormulas(text);
  if (parts.length > MAX_PARTS) return { html: errorBox(`The block has ${parts.length} formulas; at most ${MAX_PARTS} are rendered.`), error: 'too many parts' };
  if (!parts.length) return { html: '', error: null };
  const out = [];
  for (const part of parts) {
    try {
      out.push(sanitizeLatexHtml(katex.renderToString(part, KATEX_OPTIONS)));
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      return { html: errorBox(message.replace(/^KaTeX parse error:\s*/, '')), error: message };
    }
  }
  return { html: out.join(''), error: null };
}

function errorBox(message) {
  return `<div class="latex-block-error mermaid-diagram-error" role="alert"><div class="mermaid-diagram-error-title">LaTeX</div><div class="mermaid-diagram-error-message">${escapeHtml(message)}</div></div>`;
}

export function findLatexTargets(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(LATEX_PENDING_SELECTOR));
}

function readSource(el) {
  const code = el.querySelector('code');
  return code ? code.textContent : '';
}

function apply(el, html, failed) {
  for (const child of Array.from(el.children)) if (child.classList.contains('latex-block-output')) child.remove();
  const out = el.ownerDocument.createElement('div');
  out.className = 'latex-block-output';
  out.innerHTML = html;   // sanitized above (sanitizeLatexHtml / escapeHtml)
  el.insertBefore(out, el.firstChild);
  el.setAttribute('data-latex', failed ? 'error' : 'rendered');
}

/**
 * Render every ```latex placeholder in `container` (the same contract as renderMermaidDiagrams: never throws for
 * bad source, each failure an error box; resolves once every target is handled or the call was aborted; the
 * aborted ones go back to "pending"). `load` is the test seam for the KaTeX import.
 */
export async function renderLatexBlocks(container, { signal = null, load = loadKatex } = {}) {
  const result = { rendered: 0, failed: 0 };
  const targets = findLatexTargets(container);
  if (!targets.length) return result;
  for (const el of targets) el.setAttribute('data-latex', 'rendering');
  const release = () => { for (const el of targets) if (el.getAttribute('data-latex') === 'rendering') el.setAttribute('data-latex', 'pending'); };
  if (signal) { if (signal.aborted) { release(); return result; } signal.addEventListener('abort', release, { once: true }); }
  let katex = null, loadError = null;
  try { katex = await load(); } catch (err) { loadError = err instanceof Error ? err : new Error(String(err)); }
  try {
    for (const el of targets) {
      if (signal && signal.aborted) break;
      if (!container.isConnected || !container.contains(el) || el.getAttribute('data-latex') !== 'rendering') continue;
      if (loadError) { apply(el, errorBox(`KaTeX could not be loaded: ${loadError.message}`), true); result.failed += 1; continue; }
      const { html, error } = renderLatexSource(katex, readSource(el));
      apply(el, html, !!error);
      if (error) result.failed += 1; else result.rendered += 1;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', release);
    release();
  }
  return result;
}
