#!/usr/bin/env node
/**
 * Syntax colours inside fenced code in the editor
 * (src/components/features/documents/codemirror/codeColours.js, wired by
 * CodeMirrorSurface.js; the preview's .hljs-* rules extended to the editor
 * in src/index.css), with the real modules bundled by esbuild into jsdom:
 *
 *   - tokensFromHljsHtml reads highlight.js's markup as class ranges over the
 *     original code (entities counted as one character, nesting kept) and
 *     refuses markup that does not add up;
 *   - a ```python fence gets marks after the debounce whose classes are
 *     exactly the classes the preview gives the same snippet (highlightCode),
 *     on the same text; ```bash / ```yaml / ```json / ```go too;
 *   - no colours for a bare fence or an unsupported language (no auto-detect),
 *     none past the cap (2,000 lines / 100 KB: one constant), the tint stays;
 *   - the cache: the same block in another editor costs no highlight; a
 *     changed block one; the cache is bounded;
 *   - the debounce: five quick insertions cost one highlight, and the marks
 *     are mapped through the changes meanwhile (still there, shifted);
 *   - the chips and the spell-check skip coexist; the document text is untouched;
 *   - static: the stylesheet gives the editor the preview's token rules, the
 *     surface wires the extension (off through the `codeColours: false` option).
 *
 * Run: node tests/editor-code-colours.test.mjs
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

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-code-colours-'));
const ENTRY = path.join(WORKDIR, 'entry.js');
fs.writeFileSync(ENTRY, `
export { CodeMirrorSurface } from '@worktree/src/components/features/documents/codemirror/CodeMirrorSurface.js';
export { tokensFromHljsHtml, colourDecorations, coloursField, tokensFor, withinCap, stats, cacheStats, clearCache, CAP, DEBOUNCE_MS, CACHE_LIMIT } from '@worktree/src/components/features/documents/codemirror/codeColours.js';
export { highlightCode } from '@worktree/src/utils/codeHighlight.js';
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
const dom = new JSDOM('<!doctype html><html><body><div id="a"></div><div id="b"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'CustomEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle']) define(name, window[name]);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver); window.ResizeObserver = FakeObserver;
installEditorSurfaceInJsdom(window);
const mod = createRequire(import.meta.url)(BUNDLE);
const { CodeMirrorSurface, tokensFromHljsHtml, colourDecorations, coloursField, withinCap, stats, cacheStats, clearCache, CAP, DEBOUNCE_MS, CACHE_LIMIT, highlightCode, skipRanges, createDocLinkResolver } = mod;
const { document } = window;

const PY = 'import sys\n\ndef main(argv):\n    """doc"""\n    print("hello <world> & co", argv)  # comment\n    return 0\n';
const previewClasses = (code, lang) => { const div = document.createElement('div'); div.innerHTML = highlightCode(code, lang); return Array.from(div.querySelectorAll('[class]')).map((e) => e.className); };
// the marks the editor holds right now (the state field), not a fresh highlight
const marksOf = (surface) => { const out = []; surface.view.state.field(coloursField).between(0, surface.view.state.doc.length, (f, t, v) => out.push({ from: f, to: t, cls: v.spec.class, text: surface.view.state.doc.sliceString(f, t) })); return out; };
const domMarks = (surface) => Array.from(surface.contentDOM.querySelectorAll('[class*="hljs-"]')).map((e) => e.className);
const sorted = (a) => a.slice().sort().join('|');

console.log('\n--- the token reader ---');
const tokens = tokensFromHljsHtml(highlightCode(PY, 'python'), PY);
check('tokensFromHljsHtml: the ranges cover the keywords, the string (entities as one character), the comment and the function name on the original text', tokens && tokens.some((t) => t.cls === 'hljs-keyword' && PY.slice(t.from, t.to) === 'import') && tokens.some((t) => /hljs-string/.test(t.cls) && PY.slice(t.from, t.to) === '"hello <world> & co"') && tokens.some((t) => t.cls === 'hljs-comment' && PY.slice(t.from, t.to) === '# comment') && tokens.some((t) => /hljs-title/.test(t.cls) && PY.slice(t.from, t.to) === 'main'), JSON.stringify(tokens).slice(0, 300));
check('...every token is within the code and in order', tokens.every((t) => t.from >= 0 && t.to <= PY.length && t.to > t.from));
check('...markup that does not add up is refused (null), as is a stray tag', tokensFromHljsHtml('<span class="x">ab</span>', 'abc') === null && tokensFromHljsHtml('<b>a</b>', 'a') === null && tokensFromHljsHtml('a &amp; b', 'a & b') !== null);

console.log('\n--- the marks ---');
clearCache();
const DOC = `# Title\n\nText with \`inline\` and [[doc:11111111-2222-4333-8444-555555555555]].\n\n\`\`\`python\n${PY}\`\`\`\n\n\`\`\`bash\necho "hi" | grep -c h  # cmt\n\`\`\`\n\n\`\`\`\nplain fence\n\`\`\`\n\n\`\`\`rust\nfn main() {}\n\`\`\`\n`;
const surface = new CodeMirrorSurface({ parent: document.getElementById('a'), doc: DOC, docLinkResolver: createDocLinkResolver([{ id: 1, stableId: '11111111-2222-4333-8444-555555555555', title: 'T' }]), handlers: {} });
await sleep(DEBOUNCE_MS + 150);
let marks = marksOf(surface);
const pyMarks = marks.filter((m) => m.from >= DOC.indexOf(PY) && m.to <= DOC.indexOf(PY) + PY.length);
check('the python fence: the same classes as the preview gives the same snippet, on the same text', sorted(pyMarks.map((m) => m.cls)) === sorted(previewClasses(PY, 'python')) && pyMarks.some((m) => m.text === 'import' && m.cls === 'hljs-keyword'), sorted(pyMarks.map((m) => m.cls)));
const bashMarks = marks.filter((m) => m.from >= DOC.indexOf('echo') && m.to <= DOC.indexOf('# cmt') + 5);
check('the bash fence too (built_in echo, the string, the comment)', sorted(bashMarks.map((m) => m.cls)) === sorted(previewClasses('echo "hi" | grep -c h  # cmt\n', 'bash')), sorted(bashMarks.map((m) => m.cls)));
check('the bare fence and the ```rust fence get no colours (no auto-detect)', !marks.some((m) => m.text === 'plain' || m.text.includes('fn ')) && stats.skippedLanguage >= 1);
check('the DOM carries the marks as spans with the hljs classes, inside the tinted block lines', domMarks(surface).length >= 8 && surface.contentDOM.querySelector('.cm-line.cm-code-block [class*="hljs-"]') !== null, String(domMarks(surface).length));
check('the document text is untouched', surface.value === DOC);
check('the doc-link chip and the inline code mark are still there', surface.contentDOM.querySelectorAll('.cm-doc-link-chip').length === 1 && surface.contentDOM.querySelectorAll('.cm-inline-code').length === 1);
const ranges = skipRanges(surface.view.state, 0, DOC.length);
check('the spell-check skip still covers the fenced code', ranges.some((r) => r.from <= DOC.indexOf(PY) && r.to >= DOC.indexOf(PY) + PY.length - 1));

console.log('\n--- the cap and the languages ---');
check(`withinCap: ${CAP.lines} lines / ${CAP.bytes} bytes is the line`, withinCap('a\n'.repeat(CAP.lines - 1)) && !withinCap('a\n'.repeat(CAP.lines + 1)) && !withinCap('x'.repeat(CAP.bytes + 1)));
const big = `\`\`\`python\n${'x = 1\n'.repeat(CAP.lines + 5)}\`\`\`\n`;
const bigSurface = new CodeMirrorSurface({ parent: document.getElementById('b'), doc: big, handlers: {} });
await sleep(DEBOUNCE_MS + 150);
check('a block past the cap: tinted (the block lines) but no colour marks', bigSurface.contentDOM.querySelectorAll('.cm-line.cm-code-block').length > 0 && marksOf(bigSurface).length === 0 && stats.skippedCap >= 1);
bigSurface.destroy();

console.log('\n--- the cache and the debounce ---');
const before = { ...stats };
const twin = new CodeMirrorSurface({ parent: document.getElementById('b'), doc: DOC, handlers: {} });
await sleep(DEBOUNCE_MS + 150);
check('the same blocks in another editor come from the cache (hits up, highlights unchanged)', stats.cacheHits > before.cacheHits && stats.highlights === before.highlights, JSON.stringify({ before, after: stats }));
twin.destroy();
const h0 = stats.highlights;
const inside = DOC.indexOf('return 0') - 4;   // in the indentation before `return 0`
for (let i = 0; i < 5; i++) { surface.view.dispatch({ changes: { from: inside, insert: 'a' } }); await sleep(20); }
const mapped = marksOf(surface);
check('while typing (before the debounce): the marks are mapped through the changes - the bash comment below moved by the five characters, the python comment above did not', mapped.some((m) => m.cls === 'hljs-comment' && m.from === DOC.indexOf('# cmt') + 5) && mapped.some((m) => m.cls === 'hljs-comment' && m.from === DOC.indexOf('# comment')), JSON.stringify(mapped.filter((m) => m.cls === 'hljs-comment')));
check('...and no highlight has run yet', stats.highlights === h0);
await sleep(DEBOUNCE_MS + 150);
check('after the quiet time: one highlight for the five insertions (the touched block only; the bash block from the cache)', stats.highlights === h0 + 1, `${h0} -> ${stats.highlights}`);
check('...with the block coloured afresh (the return keyword after the inserted characters)', marksOf(surface).some((m) => m.text === 'return' && m.cls === 'hljs-keyword') && surface.value.includes('aaaaa    return 0'));
const cs = cacheStats();
check(`the cache is bounded (${CACHE_LIMIT} blocks) and reports its size`, cs.blocks <= CACHE_LIMIT && cs.blocks >= 2 && cs.approxBytes > 0, JSON.stringify(cs));
surface.destroy();

console.log('\n--- static ---');
const css = read('src/index.css');
check('index.css gives the editor the preview\'s token rules (keyword, string, comment, title, built_in, meta) over the --os-code-* tokens', ['.sc-editor-cm .hljs-keyword', '.sc-editor-cm .hljs-string', '.sc-editor-cm .hljs-comment', '.sc-editor-cm .hljs-title', '.sc-editor-cm .hljs-built_in', '.sc-editor-cm .hljs-meta'].every((s) => css.includes(s)) && css.includes('.sc-editor-cm .hljs-keyword,') && /\.sc-editor-cm \.hljs-meta \.hljs-keyword \{\s*color: var\(--os-code-keyword\);/.test(css));
const surfaceSrc = read('src/components/features/documents/codemirror/CodeMirrorSurface.js');
check('the surface wires the extension after the code-block tint, switchable off for the measurements', /codeBlocks,\n\s*this\._codeColours \? codeColours : \[\],/.test(surfaceSrc) && /codeColours: withCodeColours = true/.test(surfaceSrc));
const off = new CodeMirrorSurface({ parent: document.getElementById('b'), doc: DOC, handlers: {}, codeColours: false });
await sleep(DEBOUNCE_MS + 150);
check('codeColours: false - the tint stays, no colour marks', off.contentDOM.querySelectorAll('.cm-line.cm-code-block').length > 0 && domMarks(off).length === 0);
off.destroy();

console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
