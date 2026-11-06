/**
 * Code blocks in the editor: every line of a fenced (``` / ~~~) or indented
 * code block is drawn as a block - a tinted background, the monospace font,
 * a left edge - the fence lines are dimmed and the fence's info string (the
 * language) shows as a small label; inline `code` gets a subtle mark
 * background. The styles are the .cm-code-* rules in src/index.css, over
 * the theme's tokens (dark and light), next to the preview's code styles.
 *
 * The ranges come from the Lezer Markdown tree the surface already parses
 * (markdownLanguage.js: FencedCode with its CodeMark / CodeInfo / CodeText
 * children, CodeBlock for indented code, InlineCode with its CodeMark
 * backticks), for the visible part of the document only, rebuilt when the
 * document or the viewport changes - like spellcheckSkip.js, so a huge
 * document costs no more than a short one. No syntax colours: plain
 * Markdown text stays plain text, as before.
 */
import { Decoration, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

const blockLine = Decoration.line({ class: 'cm-code-block' });
const firstLine = Decoration.line({ class: 'cm-code-block cm-code-block-first' });
const lastLine = Decoration.line({ class: 'cm-code-block cm-code-block-last' });
const onlyLine = Decoration.line({ class: 'cm-code-block cm-code-block-first cm-code-block-last' });
const fenceMark = Decoration.mark({ class: 'cm-code-fence' });
const infoMark = Decoration.mark({ class: 'cm-code-info' });
const inlineMark = Decoration.mark({ class: 'cm-inline-code' });
const inlineTick = Decoration.mark({ class: 'cm-inline-code-mark' });

/**
 * The decorations for `from`..`to` of `state`: the block's line decorations
 * (first / last marked for the edges), the fence and info marks, the inline
 * code marks. Exported for the tests.
 */
export function codeBlockDecorations(state, from, to) {
  const ranges = [];
  const doc = state.doc;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(Math.max(node.from, node.to - 1)).number;
        for (let n = first; n <= last; n++) {
          const line = doc.line(n);
          if (line.to < from || line.from > to) continue;
          const deco = first === last ? onlyLine : n === first ? firstLine : n === last ? lastLine : blockLine;
          ranges.push(deco.range(line.from));
        }
        if (node.name === 'FencedCode') {
          const cursor = node.node.cursor();
          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'CodeMark') ranges.push(fenceMark.range(cursor.from, cursor.to));
              else if (cursor.name === 'CodeInfo' && cursor.to > cursor.from) ranges.push(infoMark.range(cursor.from, cursor.to));
            } while (cursor.nextSibling());
          }
        }
        return false;
      }
      if (node.name === 'InlineCode') {
        ranges.push(inlineMark.range(node.from, node.to));
        const cursor = node.node.cursor();
        if (cursor.firstChild()) {
          do { if (cursor.name === 'CodeMark') ranges.push(inlineTick.range(cursor.from, cursor.to)); } while (cursor.nextSibling());
        }
        return false;
      }
      return undefined;
    },
  });
  return Decoration.set(ranges, true);
}

function build(view) {
  const sets = [];
  for (const { from, to } of view.visibleRanges) sets.push(codeBlockDecorations(view.state, from, to));
  if (sets.length === 1) return sets[0];
  const all = [];
  for (const set of sets) set.between(0, view.state.doc.length, (f, t, value) => { all.push(value.range(f, t)); });
  return Decoration.set(all, true);
}

/** The extension: the code block styling for the visible ranges. */
export const codeBlocks = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
  }
}, { decorations: (plugin) => plugin.decorations });
