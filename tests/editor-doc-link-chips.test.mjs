#!/usr/bin/env node
/**
 * The document links in the editor (src/components/features/documents/codemirror/docLinkChips.js,
 * wired by CodeMirrorSurface.js / CodeMirrorEditor.jsx; the spell-check skip in spellcheckSkip.js),
 * with the real modules bundled by esbuild into jsdom (no layout):
 *
 *   - an id-form directive ([[doc:<stableId>]]) is drawn as a chip carrying the
 *     linked document's CURRENT title; with custom text the chip shows that text;
 *     the text underneath stays the directive (`.value`, what a live document's
 *     Y.Text would hold); a target that is not on this device is a muted
 *     "Document not found" chip; a title-form directive is left as text;
 *   - the caret inside the directive, or a selection reaching into it, shows
 *     the text (no chip) so editing is possible; the caret right after it
 *     keeps the chip, and Backspace there removes the whole directive (an
 *     atomic range) - and Delete before it too;
 *   - setDocLinkResolver with a renamed document changes the chip's text
 *     without a document change; with no resolver every link is "not found";
 *   - skipRanges (the spell checker's no-go list) covers the directive, and
 *     the chip's DOM carries no spellcheck target;
 *   - the directive inside a code fence gets no chip.
 *
 * Run: node tests/editor-doc-link-chips.test.mjs
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

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-doc-link-chips-'));
const ENTRY = path.join(WORKDIR, 'entry.js');
fs.writeFileSync(ENTRY, `
export { CodeMirrorSurface } from '@worktree/src/components/features/documents/codemirror/CodeMirrorSurface.js';
export { skipRanges } from '@worktree/src/components/features/documents/codemirror/spellcheckSkip.js';
export { docLinkChipRanges } from '@worktree/src/components/features/documents/codemirror/docLinkChips.js';
export { markdownLanguage } from '@worktree/src/components/features/documents/codemirror/markdownLanguage.js';
export { createDocLinkResolver } from '@worktree/src/utils/docLinks.js';
export { EditorState } from '@codemirror/state';
export { deleteCharBackward, deleteCharForward, cursorCharLeft, cursorCharRight } from '@codemirror/commands';
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
const { CodeMirrorSurface, skipRanges, docLinkChipRanges, markdownLanguage, createDocLinkResolver, EditorState, deleteCharBackward, deleteCharForward, cursorCharLeft, cursorCharRight } = mod;
const { document } = window;

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const docs = [{ id: 1, stableId: A, title: 'Runbook: upgrades' }, { id: 2, stableId: B, title: 'Second' }];
const resolve = createDocLinkResolver(docs);
const DOC = `Intro [[doc:${A}]] then [[doc:${B}|custom]] and [[doc:${A}|label]]\nMissing [[doc:99999999-8888-4777-8666-555555555555]] and a title [[doc:Second]]\n\n\`\`\`\n[[doc:${A}]]\n\`\`\`\n`;

const host = document.getElementById('a');
const surface = new CodeMirrorSurface({ parent: host, doc: DOC, docLinkResolver: resolve, handlers: {} });
await sleep(50);
const chips = () => Array.from(surface.contentDOM.querySelectorAll('.cm-doc-link-chip')).map((c) => ({ text: c.textContent, missing: c.classList.contains('cm-doc-link-chip-missing'), title: c.getAttribute('title') }));
const chipSet = () => docLinkChipRanges(surface.view.state, [{ from: 0, to: surface.view.state.doc.length }], surface.docLinkResolver);
const chipCount = () => { let n = 0; chipSet().between(0, surface.view.state.doc.length, () => { n += 1; }); return n; };

console.log('\n--- the chips ---');
check('the decoration set holds one chip per id-form directive outside code (4: three on line 1, the missing one on line 2; the title form and the fenced one get none)', chipCount() === 4, chipCount());
let c = chips();
check('the DOM shows them: the current title, the custom texts, the missing one muted', c.length === 4 && c[0].text === 'Runbook: upgrades' && c[1].text === 'custom' && c[2].text === 'label' && c[3].missing && /^Document not found:/.test(c[3].text), JSON.stringify(c));
check('a chip\'s title tells the target and the directive underneath', /Link to "Runbook: upgrades" - \[\[doc:/.test(c[0].title) && /Document not found - \[\[doc:/.test(c[3].title), JSON.stringify(c));
check('the text underneath is untouched: .value is the directive', surface.value === DOC);
check('the title-form directive stays as text (no chip); the picker converts it', surface.contentDOM.textContent.includes('[[doc:Second]]'));
check('the chip is not a spell-check target (spellcheck="false" on it, no prose inside)', Array.from(surface.contentDOM.querySelectorAll('.cm-doc-link-chip')).every((el) => !el.querySelector('*')));

console.log('\n--- the caret and the selection ---');
const first = DOC.indexOf('[[doc:');
const firstEnd = DOC.indexOf(']]', first) + 2;
surface.setSelectionRange(first + 8, first + 8);
await sleep(20);
check('the caret inside a directive: that one shows as text (3 chips left), the others stay chips', chipCount() === 3 && surface.contentDOM.textContent.includes(`[[doc:${A}]]`), chipCount());
surface.setSelectionRange(first - 2, first + 4);
await sleep(20);
check('a selection reaching into it: the same', chipCount() === 3);
surface.setSelectionRange(firstEnd, firstEnd);
await sleep(20);
check('the caret right after the directive keeps the chip', chipCount() === 4);
deleteCharBackward(surface.view);
await sleep(20);
check('Backspace there removes the whole directive (an atomic range), nothing else', surface.value === DOC.replace(`[[doc:${A}]]`, '') && chipCount() === 3, JSON.stringify(surface.value.slice(0, 40)));
surface.view.dispatch({ changes: { from: first, to: first, insert: `[[doc:${A}]]` } });
surface.setSelectionRange(first, first);
await sleep(20);
deleteCharForward(surface.view);
await sleep(20);
check('Delete before it removes the whole directive too', surface.value === DOC.replace(`[[doc:${A}]]`, ''), surface.value.slice(0, 40));
surface.view.dispatch({ changes: { from: first, to: first, insert: `[[doc:${A}]]` } });
surface.setSelectionRange(first, first);
await sleep(20);
cursorCharRight(surface.view);
check('ArrowRight from before the chip steps over it in one move', surface.selectionStart === firstEnd, surface.selectionStart);
cursorCharLeft(surface.view);
check('...and ArrowLeft steps back over it', surface.selectionStart === first, surface.selectionStart);
check('the document is as it was', surface.value === DOC);

console.log('\n--- the resolver ---');
surface.setSelectionRange(0, 0);
surface.setDocLinkResolver(createDocLinkResolver(docs.map((d) => (d.id === 1 ? { ...d, title: 'Runbook (renamed)' } : d))));
await sleep(20);
c = chips();
check('a renamed document: the chip shows the new title, the custom texts stay, the document is unchanged', c[0].text === 'Runbook (renamed)' && c[1].text === 'custom' && c[2].text === 'label' && surface.value === DOC, JSON.stringify(c));
surface.setDocLinkResolver(createDocLinkResolver(docs.filter((d) => d.id !== 1)));
await sleep(20);
c = chips();
check('a deleted document: its chips turn "Document not found" with the raw label, the other stays', c[0].missing && c[0].text.includes(A) && c[2].missing && c[2].text.includes('label') && !c[1].missing, JSON.stringify(c));
surface.setDocLinkResolver(null);
await sleep(20);
check('no resolver: every id-form chip is "not found"', chips().every((x) => x.missing));
surface.setDocLinkResolver(resolve);
await sleep(20);
check('the resolver back: the titles again', chips()[0].text === 'Runbook: upgrades');
check('the surface reports its resolver', surface.docLinkResolver === resolve);

console.log('\n--- replaceDocument and the spell-check skip ---');
surface.replaceDocument(`fresh [[doc:${B}]] text`);
await sleep(20);
check('a document switch keeps the chips (the resolver travels with the extensions)', chips().length === 1 && chips()[0].text === 'Second');
const state = EditorState.create({ doc: `Prose [[doc:${A}]] more [[doc:Some title|x]] [[toc]] end`, extensions: [markdownLanguage] });
const ranges = skipRanges(state, 0, state.doc.length);
const covered = (needle) => { const i = state.doc.toString().indexOf(needle); return ranges.some((r) => r.from <= i && r.to >= i + needle.length); };
check('skipRanges covers the id-form and the title-form directive (and still [[toc]])', covered(`[[doc:${A}]]`) && covered('[[doc:Some title|x]]') && covered('[[toc]]'), JSON.stringify(ranges));
check('...and not the prose around them', !ranges.some((r) => r.from <= 0 && r.to >= 5) && !covered(' more '));

surface.destroy();
console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
