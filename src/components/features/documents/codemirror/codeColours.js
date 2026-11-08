/**
 * Syntax colours inside fenced code in the editor: the same highlight.js
 * set-up as the preview (src/utils/codeHighlight.js - the five grammars,
 * the .hljs-* classes the theme colours in src/index.css), turned into
 * CodeMirror mark decorations. Nothing from highlight.js is inserted as
 * HTML: its output is read as a token stream (tokensFromHljsHtml) whose
 * class ranges become marks on the editor's own text.
 *
 * What keeps it cheap on a big document:
 *   - only the fenced blocks that intersect the viewport are highlighted
 *     (view.visibleRanges, the Lezer tree the surface already parses);
 *   - a block is highlighted once: a cache keyed on the language and a hash
 *     of the content, bounded (CACHE_LIMIT blocks, the oldest out);
 *   - an edit maps the existing marks through the change at once and
 *     re-highlights after DEBOUNCE_MS of quiet - the touched block is the
 *     only one whose key changed, the others come from the cache;
 *   - a block past CAP (lines or bytes) gets the block tint only, no colours;
 *   - a fence without a supported language gets no colours: no auto-detect.
 *
 * The marks sit beside the code-block tint (codeBlocks.js), the doc-link
 * chips and the spell-check skip; the text stays the document's (a live
 * document's Y.Text is untouched).
 */
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import { treeChanged, treeFor } from './markdownLanguage';
import { highlightCode, resolveHighlightLanguage } from '../../../../utils/codeHighlight';

/** Past either, a block is tinted but not coloured. One constant, for the tests and the docs. */
export const CAP = Object.freeze({ lines: 2000, bytes: 100 * 1024 });
export const DEBOUNCE_MS = 150;
export const CACHE_LIMIT = 64;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" };

/**
 * highlight.js's HTML (escaped text in nested <span class="hljs-..."> elements)
 * as [{ from, to, cls }] over the ORIGINAL code's offsets. Null when the
 * markup does not add up to the code (a guard: no marks are better than
 * misplaced ones).
 */
export function tokensFromHljsHtml(html, code) {
  const tokens = [];
  const stack = [];
  let pos = 0;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const ch = html[i];
    if (ch === '<') {
      if (html.startsWith('<span class="', i)) {
        const end = html.indexOf('">', i + 13);
        if (end === -1) return null;
        stack.push({ cls: html.slice(i + 13, end), from: pos });
        i = end + 2;
      } else if (html.startsWith('</span>', i)) {
        const open = stack.pop();
        if (!open) return null;
        if (pos > open.from) tokens.push({ from: open.from, to: pos, cls: open.cls });
        i += 7;
      } else {
        return null;
      }
    } else if (ch === '&') {
      const semi = html.indexOf(';', i);
      const name = semi === -1 ? '' : html.slice(i + 1, semi);
      if (Object.prototype.hasOwnProperty.call(ENTITIES, name)) { pos += 1; i = semi + 1; } else { pos += 1; i += 1; }
    } else {
      pos += 1;
      i += 1;
    }
  }
  if (stack.length || pos !== code.length) return null;
  return tokens;
}

/** FNV-1a over the string, hex. */
function hashOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16) + ':' + s.length;
}

const cache = new Map();   // key -> { code, tokens }
export const stats = { highlights: 0, cacheHits: 0, skippedCap: 0, skippedLanguage: 0 };
/** The cache's size and an estimate of its memory (the token arrays and the code kept for the hit check). */
export function cacheStats() {
  let tokens = 0, chars = 0;
  for (const v of cache.values()) { tokens += v.tokens.length; chars += v.code.length; }
  return { blocks: cache.size, tokens, approxBytes: tokens * 40 + chars * 2 };
}
export function clearCache() { cache.clear(); }

/** The tokens of `code` as `language`, from the cache or highlight.js. */
export function tokensFor(code, language) {
  const key = language + '\u0000' + hashOf(code);
  const hit = cache.get(key);
  if (hit && hit.code === code) { cache.delete(key); cache.set(key, hit); stats.cacheHits += 1; return hit.tokens; }
  const html = highlightCode(code, language);
  stats.highlights += 1;
  const tokens = html == null ? [] : (tokensFromHljsHtml(html, code) || []);
  cache.set(key, { code, tokens });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return tokens;
}

/** Is a block of this many lines / bytes coloured? */
export function withinCap(code) {
  if (code.length > CAP.bytes) return false;
  let lines = 1;
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) { lines += 1; if (lines > CAP.lines) return false; }
  return true;
}

/**
 * The colour marks for the fenced blocks of `state` intersecting `ranges`
 * (a list of { from, to }): language from the fence's info string, the
 * code from its CodeText, the tokens from the cache. Exported for the tests.
 */
export function colourDecorations(state, ranges) {
  const marks = [];
  const tree = treeFor(state, ranges.length ? ranges[ranges.length - 1].to : 0);
  const seen = new Set();
  for (const { from, to } of ranges) {
    tree.iterate({
      from, to,
      enter: (node) => {
        if (node.name !== 'FencedCode') return undefined;
        if (seen.has(node.from)) return false;
        seen.add(node.from);
        let info = '';
        let codeFrom = -1, codeTo = -1;
        const cursor = node.node.cursor();
        if (cursor.firstChild()) {
          do {
            if (cursor.name === 'CodeInfo') info = state.sliceDoc(cursor.from, cursor.to);
            else if (cursor.name === 'CodeText') { if (codeFrom === -1) codeFrom = cursor.from; codeTo = cursor.to; }
          } while (cursor.nextSibling());
        }
        if (codeFrom === -1) return false;
        const language = resolveHighlightLanguage(info);
        if (!language) { stats.skippedLanguage += 1; return false; }
        const code = state.sliceDoc(codeFrom, codeTo);
        if (!withinCap(code)) { stats.skippedCap += 1; return false; }
        for (const t of tokensFor(code, language)) marks.push(Decoration.mark({ class: t.cls }).range(codeFrom + t.from, codeFrom + t.to));
        return false;
      },
    });
  }
  return Decoration.set(marks, true);
}

const setColours = StateEffect.define();
/** The current colour marks (a state field; exported for the tests). */
export const coloursField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setColours)) return e.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const scheduler = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.timer = null;
    this.schedule(0);
  }
  update(update) {
    if (update.docChanged) this.schedule(DEBOUNCE_MS);
    else if (update.viewportChanged || treeChanged(update)) this.schedule(0);   // the parse landing: the blocks on screen colour now
  }
  schedule(ms) {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.rebuild(); }, ms);
  }
  rebuild() {
    const view = this.view;
    if (!view.dom.isConnected && typeof document !== 'undefined' && document.body && !document.body.contains(view.dom)) return;
    const decorations = colourDecorations(view.state, view.visibleRanges);
    view.dispatch({ effects: setColours.of(decorations) });
  }
  destroy() { if (this.timer !== null) clearTimeout(this.timer); }
});

/** The extension: the colour marks (a state field) and their scheduler. */
export const codeColours = [coloursField, scheduler];
