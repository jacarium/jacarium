/**
 * Where the spell checker must not look: a CodeMirror view plugin that marks
 * every code range of the Markdown (fenced ``` / ~~~ blocks, indented code,
 * inline `code`), every URL (link targets, autolinks, bare http(s) links),
 * the HTML tags and blocks and the [[toc]] / [[pagebreak]] / [[header]] ...
 * and [[doc:...]] directives with spellcheck="false". The native checker (Chromium's, the
 * OS's on macOS) honours the attribute on the element it finds a word in,
 * so prose keeps its squiggles and `kubectl get pods` does not.
 *
 * The ranges come from the Lezer Markdown tree (markdownLanguage.js) for the
 * visible part of the document only - the decorations are rebuilt when the
 * document or the viewport changes, which keeps a 50,000-line document as
 * cheap as a short one. Bare URLs and the directives are not tree nodes
 * (the directives are this app's own syntax), so they are matched on the
 * visible text.
 */
import { Decoration, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/** The Lezer Markdown node names whose text is never prose. */
export const SKIP_NODES = new Set([
  'FencedCode', 'CodeBlock', 'InlineCode', 'URL', 'HTMLBlock', 'HTMLTag', 'Autolink', 'LinkTitle',
  'CommentBlock', 'ProcessingInstructionBlock',
]);

/** Bare http(s) links, the PDF / preview directives ([[toc]], [[/toc]], [[pagebreak]], ...) and the document links ([[doc:...]], src/utils/docLinks.js). */
export const SKIP_TEXT = /\[\[doc:[^\]\n]*\]\]|\[\[\/?[a-z]+\]\]|https?:\/\/[^\s)>\]]+/g;

const noSpell = Decoration.mark({ attributes: { spellcheck: 'false' }, class: 'cm-nospell' });

/**
 * The [from, to) ranges to skip between `from` and `to` of `state`
 * (sorted, non-overlapping). Exported for the tests.
 */
export function skipRanges(state, from, to) {
  const ranges = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (!SKIP_NODES.has(node.name)) return undefined;
      ranges.push({ from: node.from, to: node.to });
      return false;   // nothing inside a skipped node needs a mark of its own
    },
  });
  const text = state.sliceDoc(from, to);
  for (const match of text.matchAll(SKIP_TEXT)) {
    ranges.push({ from: from + match.index, to: from + match.index + match[0].length });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const range of ranges) {
    if (range.to <= range.from) continue;
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ from: range.from, to: range.to });
  }
  return merged;
}

function build(view) {
  const marks = [];
  for (const { from, to } of view.visibleRanges) {
    for (const range of skipRanges(view.state, from, to)) marks.push(noSpell.range(range.from, range.to));
  }
  return Decoration.set(marks, true);
}

export const spellcheckSkip = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
  }
}, { decorations: (plugin) => plugin.decorations });
