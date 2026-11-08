/**
 * The Markdown language of the CodeMirror editor surface: the Lezer Markdown
 * parser (CommonMark plus GFM's tables, task lists, strikethrough and
 * autolinks) wrapped as a CodeMirror Language, and nothing more.
 *
 * @codemirror/lang-markdown would give the same tree, but it statically
 * imports @codemirror/lang-html (and through it the CSS and JavaScript
 * grammars plus autocompletion) for the HTML inside Markdown - about
 * 200 KB the Documents editor has no use for. The parse tree here serves one
 * purpose: telling the spell checker where the code, the URLs and the
 * directives are (spellcheckSkip.js). No syntax highlighting is applied
 * (the editor shows plain Markdown, as the textarea did), so the tree costs
 * only the incremental parse.
 */
import { Language, defineLanguageFacet, languageDataProp, syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { parser, GFM } from '@lezer/markdown';

const data = defineLanguageFacet({ commentTokens: { block: { open: '<!--', close: '-->' } } });

const gfmParser = parser.configure([
  GFM,
  { props: [languageDataProp.add({ Document: data })] },
]);

export const markdownLanguage = new Language(data, gfmParser, [], 'markdown');

/**
 * Has the Markdown tree moved on in this update? The parser fills the tree in
 * idle time (the language's own worker dispatches as it goes, with neither a
 * document nor a viewport change), so a decoration built from the tree must
 * build again when it does - the first build after a mount or a jump
 * (Preview -> Editor at a far place) runs before the parse reaches the
 * viewport and finds no code blocks at all.
 */
export const treeChanged = (update) => syntaxTree(update.startState) !== syntaxTree(update.state);

/** A document this long leaves the parse to the worker: the tree reaches a far viewport in its own time. */
export const ENSURE_TREE_MAX_CHARS = 2_000_000;

/**
 * The tree that covers `upto` (the end of the visible range): the one parsed
 * so far when it reaches that far; else the parser is pushed there for up to
 * `budgetMs` (the tree a decoration builds from is complete for the screen
 * on the first paint), falling back to what there is - a huge document
 * (ENSURE_TREE_MAX_CHARS) is never pushed, its worker catches up.
 */
export function treeFor(state, upto, budgetMs = 10) {
  const tree = syntaxTree(state);
  if (tree.length >= upto || state.doc.length > ENSURE_TREE_MAX_CHARS) return tree;
  return ensureSyntaxTree(state, upto, budgetMs) || tree;
}
