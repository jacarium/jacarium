#!/usr/bin/env node
/**
 * The reader's place across Editor <-> Preview, the parts that run without a
 * browser (src/utils/interactiveMarkdown.js renderWithSourceLines,
 * src/utils/previewPlace.js; the live behaviour is in
 * tests/editor-preview-place-live.test.mjs):
 *
 *   1. with `sourceLines`, every top-level block of the preview carries
 *      data-source-line = the 1-based line it starts on in the document as
 *      written: a heading, a paragraph, a list, a fenced block, a table, a
 *      blockquote, an hr - and the lines stay right after a [[toc]] block, a
 *      [[pagebreak]] and a [[centerpage]] pair (the markers inject newlines the
 *      renderer discounts), after a [[doc:...]] link and an interactive field;
 *      the HTML is otherwise marked's (the same elements, text and ids);
 *   2. without the option (the PDF export, every other caller) no attribute is
 *      emitted - the HTML is byte for byte what it was; the native exporter
 *      renders without it (static);
 *   3. previewBlockForLine: the nearest preceding block, the first block for
 *      a line above all, null without blocks; previewTopVisibleLine with
 *      stubbed geometry: the first block whose bottom is below the top edge;
 *      scrollPreviewToBlock sets the offset from the rects.
 *
 * Run:  node tests/preview-place.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, REPO } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { check, summary } = makeChecker();
const { mod, window } = await setupDocumentsEnv('preview-place', { entry: path.join(here, 'helpers', 'preview-place-entry.mjs') });
const { processInteractiveMarkdown, previewBlockForLine, previewTopVisibleLine, scrollPreviewToBlock } = mod;
const { document } = window;
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const MD = [
  '# Title',                                   // 1
  '',
  'Intro paragraph.',                          // 3
  '',
  '[[toc]]',                                   // 5
  '- [Section one](#section-one)',             // 6
  '[[/toc]]',                                  // 7
  '',
  '## Section one',                            // 9
  '',
  '- item a',                                  // 11
  '- item b',
  '',
  '```python',                                 // 14
  'print(1)',
  '```',
  '',
  '[[pagebreak]]',                             // 18
  '',
  '| a | b |',                                 // 20
  '|---|---|',
  '| 1 | 2 |',
  '',
  '> quoted',                                  // 24
  '',
  '[[centerpage]]',                            // 26
  '# Cover',                                   // 27
  '[[/centerpage]]',                           // 28
  '',
  '---',                                       // 30
  '',
  'See [[doc:Some title]] and [[input:name:Your name]] here.',   // 32
  '',
  '## Section two',                            // 34
  '',
  'Last paragraph.',                           // 36
].join('\n');

const render = (md, opts) => { const div = document.createElement('div'); div.innerHTML = processInteractiveMarkdown(md, opts); return div; };
const lineOf = (el) => Number(el.getAttribute('data-source-line'));

console.log('\n--- 1. the source lines ---');
let root = render(MD, { sourceLines: true });
const find = (selector) => root.querySelector(selector);
check('the heading, the intro and section one carry their lines (1, 3, 9)', lineOf(find('h1')) === 1 && lineOf(find('p')) === 3 && lineOf(find('h2')) === 9, [find('h1')?.outerHTML, find('p')?.outerHTML].join(' '));
check('the list, the fence and the table (11, 14, 20): the lines stay right after the [[toc]] block', lineOf(root.querySelectorAll('ul')[1] || find('ul')) === 11 && lineOf(find('pre')) === 14 && lineOf(find('table')) === 20, Array.from(root.querySelectorAll('[data-source-line]')).map((e) => e.tagName + ':' + lineOf(e)).join(' '));
check('the blockquote after the [[pagebreak]] (24) and the hr after the [[centerpage]] pair (30)', lineOf(find('blockquote')) === 24 && lineOf(find('hr')) === 30, Array.from(root.querySelectorAll('[data-source-line]')).map((e) => e.tagName + ':' + lineOf(e)).join(' '));
check('the cover heading inside the centred page keeps its line (27), the paragraph with a doc link and a field (32), section two (34), the last paragraph (36)', lineOf(root.querySelector('.pdf-centerpage h1, h1[data-source-line="27"]')) === 27 && Array.from(root.querySelectorAll('p')).some((p) => lineOf(p) === 32) && Array.from(root.querySelectorAll('h2')).some((h) => lineOf(h) === 34) && Array.from(root.querySelectorAll('p')).some((p) => lineOf(p) === 36), Array.from(root.querySelectorAll('[data-source-line]')).map((e) => e.tagName + ':' + lineOf(e)).join(' '));
const lines = Array.from(root.querySelectorAll('[data-source-line]')).map(lineOf);
check('the lines ascend in document order', lines.every((n, i) => i === 0 || n >= lines[i - 1]), lines.join(','));
const plain = render(MD);
const strip = (html) => html.replace(/ data-source-line="\d+"/g, '');
check('the HTML is otherwise the plain render (the same elements, text and ids once the attribute is stripped)', strip(root.innerHTML) === plain.innerHTML, strip(root.innerHTML).slice(0, 200));
check('the attribute survives the sanitiser and sits on top-level blocks only (none inside a list item or a table cell)', root.querySelectorAll('[data-source-line]').length >= 10 && !root.querySelector('li [data-source-line], td [data-source-line]'));

console.log('\n--- 2. without the option ---');
check('no data-source-line without sourceLines (the PDF export, every other caller)', !plain.innerHTML.includes('data-source-line'));
const pdfNative = read('src/utils/pdfExportNative.js');
check('the native PDF exporter renders without source lines', /processInteractiveMarkdown\(doc\.content \|\| '', \{ resolveDocLink \}\)/.test(pdfNative) && !/sourceLines/.test(pdfNative));
const editor = read('src/components/features/documents/DocumentEditor.jsx');
check('the editor\'s preview render asks for them', /processInteractiveMarkdown\(text, \{ resolveDocLink, sourceLines: true \}\)/.test(editor));

console.log('\n--- 3. the place helpers ---');
const container = document.createElement('div');
container.innerHTML = '<p data-source-line="3">a</p><div class="md-chunk"><h2 data-source-line="9">b</h2><pre data-source-line="14">c</pre></div><p data-source-line="36">d</p>';
check('previewBlockForLine: the nearest preceding block (line 20 -> the block of 14), an exact line, the first block for a line above all, the last for a line past the end', lineOf(previewBlockForLine(container, 20)) === 14 && lineOf(previewBlockForLine(container, 9)) === 9 && lineOf(previewBlockForLine(container, 1)) === 3 && lineOf(previewBlockForLine(container, 999)) === 36);
check('...null without blocks', previewBlockForLine(document.createElement('div'), 5) === null);
// stubbed geometry: the container's top at 100, the blocks 50 px tall from 0, scrolled by `scrollTop`
const blocks = Array.from(container.querySelectorAll('[data-source-line]'));
let scrollTop = 0;
container.getBoundingClientRect = () => ({ top: 100, bottom: 500 });
Object.defineProperty(container, 'scrollTop', { get: () => scrollTop, set: (v) => { scrollTop = v; }, configurable: true });
blocks.forEach((b, i) => { b.getBoundingClientRect = () => ({ top: 100 + i * 50 - scrollTop, bottom: 150 + i * 50 - scrollTop }); });
check('previewTopVisibleLine: at the top the first block (3); scrolled 60 px the second (9); 120 px the third (14)', previewTopVisibleLine(container) === 3 && (scrollTop = 60, previewTopVisibleLine(container)) === 9 && (scrollTop = 120, previewTopVisibleLine(container)) === 14);
scrollTop = 0;
scrollPreviewToBlock(container, blocks[2]);
check('scrollPreviewToBlock: the offset that puts the block at the top edge (100 px for the third block)', scrollTop === 100, String(scrollTop));

summary();
