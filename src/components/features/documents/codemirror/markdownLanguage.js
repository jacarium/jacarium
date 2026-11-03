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
import { Language, defineLanguageFacet, languageDataProp } from '@codemirror/language';
import { parser, GFM } from '@lezer/markdown';

const data = defineLanguageFacet({ commentTokens: { block: { open: '<!--', close: '-->' } } });

const gfmParser = parser.configure([
  GFM,
  { props: [languageDataProp.add({ Document: data })] },
]);

export const markdownLanguage = new Language(data, gfmParser, [], 'markdown');
