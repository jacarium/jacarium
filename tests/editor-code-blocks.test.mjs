#!/usr/bin/env node
/**
 * Code blocks in the editor (src/components/features/documents/codemirror/codeBlocks.js,
 * wired by CodeMirrorSurface.js; the .cm-code-* rules in src/index.css), with
 * the real modules bundled by esbuild into jsdom (no layout):
 *
 *   - every line of a ``` fence, a ~~~ fence and an indented block carries the
 *     block line decoration, the first and last lines marked as the edges (a
 *     one-line block is both); the fence lines carry the dimmed fence mark and
 *     the fence's info string the label mark (none for a bare fence);
 *   - inline `code` carries the inline mark, its backticks the tick mark;
 *   - prose, headings and lists get nothing; a change moves the blocks with the
 *     text (a line inserted above, a fence typed in);
 *   - the decorations are built for the visible ranges only (the builder takes
 *     a range: lines outside it get nothing) - the viewport-only behaviour the
 *     browser proves in tests/editor-code-blocks-live.test.mjs;
 *   - the doc-link chips and the spell-check skip coexist with the blocks: a
 *     [[doc:...]] inside a fence is text (no chip) and skipped by the checker;
 *   - static: the stylesheet styles the classes over the theme tokens (no hex
 *     colour), the surface wires the plugin.
 *
 * Run: node tests/editor-code-blocks.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';
import { installEditorSurfaceInJsdom } from './helpers/editor-surface.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
function resolvable(name) { try { req.resolve(name); return true; } catch { return false; } }
for (const dep of ['esbuild', 'yjs']) {
  if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); }
}
if (!resolvable('jsdom')) { console.log('SKIP: test-only dependency "jsdom" not installed (npm install --no-save jsdom fake-indexeddb)'); process.exit(0); }

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-code-blocks-'));
const ENTRY = path.join(WORKDIR, 'entry.js');
fs.writeFileSync(ENTRY, `
export { CodeMirrorSurface } from '@worktree/src/components/features/documents/codemirror/CodeMirrorSurface.js';
export { codeBlockDecorations } from '@worktree/src/components/features/documents/codemirror/codeBlocks.js';
export { skipRanges } from '@worktree/src/components/features/documents/codemirror/spellcheckSkip.js';
export { createDocLinkResolver } from '@worktree/src/utils/docLinks.js';
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node',
  loader: { '.js': 'js', '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"' },
  nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (args) => ({ path: path.join(REPO, args.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => { if (isBuiltin(args.path)) return { path: args.path, external: true }; try { return { path: req.resolve(args.path) }; } catch { return null; } });
  } }],
  logLevel: 'warning',
});

const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="a"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'CustomEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle']) define(name, window[name]);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); window.ResizeObserver = FakeObserver;
installEditorSurfaceInJsdom(window);
const mod = createRequire(import.meta.url)(BUNDLE);
const { CodeMirrorSurface, codeBlockDecorations, skipRanges, createDocLinkResolver } = mod;
const { document } = window;

const A = '11111111-2222-4333-8444-555555555555';
const DOC = [
  '# Title',
  '',
  'Prose with `inline code` here.',
  '',
  '```python title=demo',
  'def f():',
  '    return 1',
  '```',
  '',
  'A paragraph before an indented block (after a list it would be the item\'s continuation, not code).',
  '',
  '    indented one',
  '    indented two',
  '',
  '~~~',
  `[[doc:${A}]] in a fence`,
  '~~~',
  '',
  '- a list item after',
].join('\n');

const surface = new CodeMirrorSurface({ parent: document.getElementById('a'), doc: DOC, docLinkResolver: createDocLinkResolver([{ id: 1, stableId: A, title: 'T' }]), handlers: {} });
await sleep(50);
const state = () => surface.view.state;
const lineNo = (pos) => state().doc.lineAt(pos).number;
const collect = (from = 0, to = state().doc.length) => {
  const out = [];
  codeBlockDecorations(state(), from, to).between(0, state().doc.length, (f, t, v) => { out.push({ from: f, to: t, line: lineNo(f), cls: v.spec.class, kind: v.spec.widget ? 'widget' : (f === t ? 'line' : 'mark') }); });
  return out;
};
const linesWith = (cls, decos = collect()) => decos.filter((d) => d.kind === 'line' && d.cls.split(' ').includes(cls)).map((d) => d.line);
const marksWith = (cls, decos = collect()) => decos.filter((d) => d.kind === 'mark' && d.cls === cls).map((d) => state().doc.sliceString(d.from, d.to));

console.log('\n--- the blocks ---');
const decos = collect();
check('the ``` fence: lines 5-8 carry the block decoration, 5 first and 8 last', linesWith('cm-code-block').filter((n) => n >= 5 && n <= 8).join() === '5,6,7,8' && linesWith('cm-code-block-first').includes(5) && linesWith('cm-code-block-last').includes(8), JSON.stringify(linesWith('cm-code-block')));
check('the indented block: lines 12-13, edges marked', linesWith('cm-code-block').includes(12) && linesWith('cm-code-block').includes(13) && linesWith('cm-code-block-first').includes(12) && linesWith('cm-code-block-last').includes(13));
check('the ~~~ fence: lines 15-17', [15, 16, 17].every((n) => linesWith('cm-code-block').includes(n)) && linesWith('cm-code-block-first').includes(15) && linesWith('cm-code-block-last').includes(17));
check('prose, the heading, the list and the blank lines carry nothing', [1, 2, 3, 4, 9, 10, 11, 14, 18, 19].every((n) => !linesWith('cm-code-block').includes(n)), JSON.stringify(linesWith('cm-code-block')));
check('the fence markers are the dimmed fence marks (``` x2, ~~~ x2)', marksWith('cm-code-fence').join('|') === '```|```|~~~|~~~', marksWith('cm-code-fence').join('|'));
check('the info string is the label mark ("python title=demo"); the bare ~~~ fence has none', marksWith('cm-code-info').join('|') === 'python title=demo');
check('inline code: the whole span carries the inline mark, the backticks the tick mark', marksWith('cm-inline-code').join('|') === '`inline code`' && marksWith('cm-inline-code-mark').join('|') === '`|`');
check('the DOM shows the block lines with the classes and the fence/label/inline spans', surface.contentDOM.querySelectorAll('.cm-line.cm-code-block').length === 9 && surface.contentDOM.querySelectorAll('.cm-code-fence').length === 4 && surface.contentDOM.querySelectorAll('.cm-code-info').length === 1 && surface.contentDOM.querySelectorAll('.cm-inline-code').length === 1, String(surface.contentDOM.querySelectorAll('.cm-line.cm-code-block').length));
check('a one-line block is first and last at once', (() => { const s = new CodeMirrorSurface({ parent: document.createElement('div'), doc: '    one', handlers: {} }); const d = []; codeBlockDecorations(s.view.state, 0, 7).between(0, 7, (f, t, v) => d.push(v.spec.class)); s.destroy(); return d.join() === 'cm-code-block cm-code-block-first cm-code-block-last'; })());

console.log('\n--- the range ---');
const partial = collect(0, state().doc.line(4).to);
check('built for a range: only the inline code of lines 1-4, no block lines', partial.every((d) => d.kind === 'mark') && marksWith('cm-inline-code', partial).length === 1 && linesWith('cm-code-block', partial).length === 0, JSON.stringify(partial));
const tail = collect(state().doc.line(15).from, state().doc.length);
check('...the ~~~ block for the tail range only', linesWith('cm-code-block', tail).join() === '15,16,17', JSON.stringify(linesWith('cm-code-block', tail)));

console.log('\n--- changes ---');
surface.view.dispatch({ changes: { from: 0, insert: 'new first line\n' } });
await sleep(20);
check('a line inserted above: the blocks move down one line', linesWith('cm-code-block').filter((n) => n >= 6 && n <= 9).join() === '6,7,8,9' && surface.contentDOM.querySelectorAll('.cm-line.cm-code-block').length === 9);
surface.view.dispatch({ changes: { from: state().doc.length, insert: '\n```bash\necho hi\n```' } });
await sleep(20);
check('a fence typed at the end: a new block with its label', marksWith('cm-code-info').join('|') === 'python title=demo|bash' && surface.contentDOM.querySelectorAll('.cm-line.cm-code-block').length === 12);

console.log('\n--- with the chips and the spell checker ---');
check('the [[doc:...]] inside the ~~~ fence is text, not a chip', surface.contentDOM.querySelectorAll('.cm-doc-link-chip').length === 0 && surface.contentDOM.textContent.includes(`[[doc:${A}]]`));
const ranges = skipRanges(state(), 0, state().doc.length);
const fenceStart = state().doc.toString().indexOf('~~~');
check('the fenced code is in the spell checker\'s skip ranges', ranges.some((r) => r.from <= fenceStart && r.to >= fenceStart + 10));

console.log('\n--- static ---');
const css = read('src/index.css');
const block = css.slice(css.indexOf('.sc-editor-cm .cm-line.cm-code-block {'));
check('index.css styles the block lines, the fence, the label and inline code over the theme tokens, with no hex colour', ['.sc-editor-cm .cm-line.cm-code-block {', '.sc-editor-cm .cm-code-fence', '.sc-editor-cm .cm-code-info', '.sc-editor-cm .cm-inline-code'].every((s) => block.includes(s)) && /var\(--os-code-bg\)/.test(block) && /var\(--font-mono\)/.test(block) && !/#[0-9a-f]{3,6}\b/i.test(block.slice(0, block.indexOf('.cm-inline-code-mark') + 80)), block.slice(0, 200));
check('the block, the language label and inline code have square corners (no border-radius in the editor\'s code rules)', !/border-[a-z-]*radius/.test(block.slice(0, block.indexOf('.cm-inline-code-mark'))));
const surfaceSrc = read('src/components/features/documents/codemirror/CodeMirrorSurface.js');
check('the surface wires the plugin next to the spell-check skip', /import \{ codeBlocks \} from '\.\/codeBlocks';/.test(surfaceSrc) && /spellcheckSkip,\n\s*codeBlocks,/.test(surfaceSrc));

surface.destroy();
console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
