/**
 * The CodeMirror editor surface (src/components/features/documents/codemirror/),
 * on its own: the textarea API it answers for DocumentEditor, the Markdown
 * ranges the spell checker must skip, the macOS period guard, the history
 * and the Yjs binding - with the real modules bundled by esbuild into
 * jsdom (no layout: positions are not measured here;
 * tests/editor-codemirror-live.test.mjs does that in a browser).
 *
 * What this test proves:
 *   - diffChange: the one change between two texts (common prefix and
 *     suffix kept), null when equal;
 *   - skipRanges on the real Markdown tree: ``` and ~~~ fences, indented
 *     code, inline code, a link's target, an autolink, a bare URL, an HTML
 *     tag and the [[toc]] / [[/toc]] directives are skipped, the prose
 *     around them is not; the marks in the DOM carry spellcheck="false"
 *     while the content is spellcheck="true" (and "false" once switched);
 *   - the surface as a textarea: value get/set (a set keeps the selection
 *     and does NOT fire onChange, a typed change does with the new value),
 *     selectionStart / End / Direction, setSelectionRange (clamped,
 *     backward), select(), focus, readOnly (no typing, aria-readonly),
 *     placeholder, scroll and size properties present, the find bar's
 *     marks as decorations;
 *   - the macOS "Add period with double-space" guard: an insertText of
 *     ". " over selected spaces is cancelled and one space inserted;
 *   - history: Cmd/Ctrl+Z-style undo reverts a typed change; replaceDocument
 *     (a document switch) starts a fresh state - no undo into the previous
 *     document, no selection or find marks, the read-only state kept;
 *   - the Yjs binding (y-codemirror.next) between two surfaces on two
 *     Y.Docs: a local edit reaches the other view (no onChange there - it
 *     is remote text), a remote caret is drawn with the peer's name and
 *     colour, undo reverts only the local edit, `.value =` on a bound
 *     surface travels too, unbindYjs returns to a local history.
 *
 * Run: node tests/editor-codemirror-surface.test.mjs
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
for (const dep of ['esbuild', 'yjs', 'y-protocols/awareness']) {
  if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); }
}
if (!resolvable('jsdom')) { console.log('SKIP: test-only dependency "jsdom" not installed (npm install --no-save jsdom fake-indexeddb)'); process.exit(0); }

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the bundle: the surface and what the test needs beside it ----------
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-cm-surface-'));
const ENTRY = path.join(WORKDIR, 'entry.js');
fs.writeFileSync(ENTRY, `
export { CodeMirrorSurface, diffChange } from '@worktree/src/components/features/documents/codemirror/CodeMirrorSurface.js';
export { skipRanges } from '@worktree/src/components/features/documents/codemirror/spellcheckSkip.js';
export { markdownLanguage } from '@worktree/src/components/features/documents/codemirror/markdownLanguage.js';
export { EditorState } from '@codemirror/state';
export * as Y from 'yjs';
export { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';
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

// ---------- jsdom ----------
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
const { CodeMirrorSurface, diffChange, skipRanges, markdownLanguage, EditorState, Y, Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } = mod;
const { document } = window;

// ---------- diffChange ----------
check('diffChange: equal texts give null', diffChange('abc', 'abc') === null);
check('diffChange: an insertion in the middle', JSON.stringify(diffChange('hello world', 'hello big world')) === JSON.stringify({ from: 6, to: 6, insert: 'big ' }));
check('diffChange: a deletion', JSON.stringify(diffChange('hello big world', 'hello world')) === JSON.stringify({ from: 6, to: 10, insert: '' }));
check('diffChange: a replacement', JSON.stringify(diffChange('a cat sat', 'a dog sat')) === JSON.stringify({ from: 2, to: 5, insert: 'dog' }));
check('diffChange: overlapping prefix and suffix ("aaa" -> "aa") is one deletion', JSON.stringify(diffChange('aaa', 'aa')) === JSON.stringify({ from: 2, to: 3, insert: '' }));
check('diffChange: the whole text', JSON.stringify(diffChange('', 'x')) === JSON.stringify({ from: 0, to: 0, insert: 'x' }) && JSON.stringify(diffChange('x', '')) === JSON.stringify({ from: 0, to: 1, insert: '' }));

// ---------- skipRanges on the real tree ----------
const MD = [
  'Prose with a mispeled word.',                      // 0
  '```bash',                                          // 1 fenced
  'kubectl get podz',                                 // 2
  '```',                                              // 3
  'More prose, then `inline cde` here.',              // 4
  '~~~',                                              // 5 tilde fence
  'tilde fencd',                                      // 6
  '~~~',                                              // 7
  '',                                                 // 8
  '    indented cde block',                           // 9 indented code
  '',                                                 // 10
  'A [link txt](https://exmaple.com/pth "ttl") and <https://auto.lnk/x> and https://bare.lnk/y here.',   // 11
  'An <span class="x">html tg</span> and [[toc]] and [[/toc]] and [[pagebreak]] directives.',             // 12
  'Last prose lne.',                                  // 13
].join('\n');
const state = EditorState.create({ doc: MD, extensions: [markdownLanguage] });
const ranges = skipRanges(state, 0, MD.length).map((r) => MD.slice(r.from, r.to));
const skipped = (needle) => ranges.some((r) => r.includes(needle));
check('fenced ``` code is skipped (whole block)', skipped('kubectl get podz'), JSON.stringify(ranges));
check('a ~~~ fence is skipped', skipped('tilde fencd'));
check('indented code is skipped', skipped('indented cde block'));
check('inline code is skipped', skipped('`inline cde`'));
check('a link target and title are skipped, its text is not', skipped('https://exmaple.com/pth') && !skipped('link txt'), JSON.stringify(ranges));
check('an autolink and a bare URL are skipped', skipped('https://auto.lnk/x') && skipped('https://bare.lnk/y'));
check('HTML tags are skipped, their text is not', skipped('<span class="x">') && !skipped('html tg'), JSON.stringify(ranges));
check('the [[toc]], [[/toc]] and [[pagebreak]] directives are skipped', skipped('[[toc]]') && skipped('[[/toc]]') && skipped('[[pagebreak]]'));
check('the prose is not skipped', !skipped('mispeled') && !skipped('More prose') && !skipped('Last prose lne') && !skipped('directives'));
check('the ranges are sorted and do not overlap', skipRanges(state, 0, MD.length).every((r, i, all) => i === 0 || r.from >= all[i - 1].to));

// ---------- the surface as a textarea ----------
const events = [];
const a = new CodeMirrorSurface({ parent: document.getElementById('a'), doc: 'hello world', placeholder: 'Type here', handlers: { onChange: (e) => events.push(['change', e.target.value]), onSelect: () => events.push(['select']) } });
check('isCodeMirror, not managing Yjs, with the surface reachable from its DOM', a.isCodeMirror === true && a.managesYjs === false && document.querySelector('.sc-editor-cm').editorSurface === a);
check('value reads the document', a.value === 'hello world');
a.setSelectionRange(6, 11);
check('setSelectionRange / selectionStart / selectionEnd / direction', a.selectionStart === 6 && a.selectionEnd === 11 && a.selectionDirection === 'forward');
a.setSelectionRange(6, 11, 'backward');
check('a backward selection reports its direction', a.selectionDirection === 'backward' && a.selectionStart === 6 && a.selectionEnd === 11);
a.setSelectionRange(-5, 999);
check('setSelectionRange clamps to the document', a.selectionStart === 0 && a.selectionEnd === 11);
a.setSelectionRange(6, 11);
events.length = 0;
a.value = 'hello big world';
check('`.value =` applies the one differing change and keeps the selection on the same text', a.value === 'hello big world' && a.selectionStart === 10 && a.selectionEnd === 15, JSON.stringify([a.selectionStart, a.selectionEnd]));
check('`.value =` does not fire onChange (not typing), the selection change is reported', !events.some((e) => e[0] === 'change') && events.some((e) => e[0] === 'select'), JSON.stringify(events));
events.length = 0;
a.view.dispatch({ changes: { from: 0, to: 0, insert: 'Oh ' }, userEvent: 'input.type' });
check('a typed change fires onChange with the new value', events.some((e) => e[0] === 'change' && e[1] === 'Oh hello big world'), JSON.stringify(events));
a.select();
check('select() selects everything', a.selectionStart === 0 && a.selectionEnd === a.value.length);
a.focus();
check('focus() focuses the content; hasFocus', document.activeElement === a.contentDOM && a.hasFocus === true);
check('the content is spellcheck="true" with autocorrect and autocapitalize off', a.contentDOM.getAttribute('spellcheck') === 'true' && a.contentDOM.getAttribute('autocorrect') === 'off' && a.contentDOM.getAttribute('autocapitalize') === 'off');
a.spellcheck = false;
check('spellcheck = false switches the attribute', a.contentDOM.getAttribute('spellcheck') === 'false');
a.spellcheck = true;
check('the placeholder is set and changes', a.placeholder === 'Type here' && (a.placeholder = 'Other', a.placeholder === 'Other'));
a.readOnly = true;
check('readOnly: the content is no longer editable and says so', a.readOnly === true && a.view.state.readOnly === true && a.contentDOM.getAttribute('contenteditable') !== 'true' && a.contentDOM.getAttribute('aria-readonly') === 'true');
a.readOnly = false;
check('and back', a.view.state.readOnly === false && a.contentDOM.getAttribute('contenteditable') === 'true');
check('scroll and size properties exist (the scroller\'s)', typeof a.scrollTop === 'number' && typeof a.clientHeight === 'number' && typeof a.scrollHeight === 'number' && typeof a.getBoundingClientRect().top === 'number');
check('tagName / disabled / ownerDocument / closest / contains answer like an element', a.tagName === 'CM-EDITOR' && a.disabled === false && a.ownerDocument === document && a.closest('body') === document.body && a.contains(a.contentDOM));
a.value = 'prose `code` and https://x.y/z [[toc]]\n```\nfenced\n```';
await sleep(30);
const marks = Array.from(document.querySelectorAll('#a .cm-nospell')).map((m) => [m.textContent, m.getAttribute('spellcheck')]);
check('the skipped ranges are spellcheck="false" marks in the DOM (the inline code split by the code-block marks, all of them false)', marks.length >= 4 && marks.every((m) => m[1] === 'false') && marks.map((m) => m[0]).join('').includes('`code`') && marks.some((m) => m[0] === '[[toc]]'), JSON.stringify(marks));
a.setSearchMatches([{ start: 0, end: 5 }, { start: 6, end: 12 }], 1);
await sleep(10);
check('the find bar\'s matches are decorations, the current one marked', document.querySelectorAll('#a .cm-searchMatch').length === 2 && document.querySelectorAll('#a .cm-searchMatch-current').length === 1 && document.querySelector('#a .cm-searchMatch-current').textContent === '`code`');
a.setSearchMatches([], -1);
check('and are cleared', document.querySelectorAll('#a .cm-searchMatch').length === 0);

// the macOS period guard
a.value = 'a  ';
a.setSelectionRange(1, 2);   // the OS replaces the first space with ". " (selected while it asks)
const period = new window.InputEvent('beforeinput', { inputType: 'insertText', data: '. ', bubbles: true, cancelable: true });
a.contentDOM.dispatchEvent(period);
check('the double-space period substitution is cancelled and one space inserted after the run', period.defaultPrevented && a.value === 'a   ' && a.selectionStart === 3, JSON.stringify([a.value, a.selectionStart]));
a.value = 'ab';
a.setSelectionRange(1, 1);
const plain = new window.InputEvent('beforeinput', { inputType: 'insertText', data: '. ', bubbles: true, cancelable: true });
a.contentDOM.dispatchEvent(plain);
check('an insertText of ". " with a collapsed selection is left alone', !plain.defaultPrevented && a.value === 'ab');

// history
a.value = 'base';
a.view.dispatch({ changes: { from: 4, to: 4, insert: ' typed' }, userEvent: 'input.type' });
a.undo();
check('undo reverts a typed change', a.value === 'base', JSON.stringify(a.value));
a.view.dispatch({ changes: { from: 4, to: 4, insert: ' more' }, userEvent: 'input.type' });
a.setSearchMatches([{ start: 0, end: 4 }], 0);
a.readOnly = true;
a.replaceDocument('the next document');
check('replaceDocument: the new text, no selection, no undo into the previous document, no find marks, the read-only state kept', a.value === 'the next document' && a.selectionStart === 0 && a.selectionEnd === 0 && (a.undo(), a.value === 'the next document') && document.querySelectorAll('#a .cm-searchMatch').length === 0 && a.readOnly === true && a.contentDOM.getAttribute('contenteditable') !== 'true', JSON.stringify([a.value, a.selectionStart]));
a.readOnly = false;
check('and the surface is still reachable from its (new) DOM', document.querySelector('.sc-editor-cm').editorSurface === a && a.contentDOM.getAttribute('spellcheck') === 'true');

// ---------- the Yjs binding between two surfaces ----------
const docA = new Y.Doc(); const docB = new Y.Doc();
docA.on('update', (u, origin) => { if (origin !== 'remote') Y.applyUpdate(docB, u, 'remote'); });
docB.on('update', (u, origin) => { if (origin !== 'remote') Y.applyUpdate(docA, u, 'remote'); });
const awA = new Awareness(docA); const awB = new Awareness(docB);
// (relayed asynchronously, as a network does: a synchronous relay would re-enter the view update that published the state)
awA.on('update', ({ added, updated, removed }, origin) => { if (origin !== 'remote') { const u = encodeAwarenessUpdate(awA, added.concat(updated, removed)); setTimeout(() => applyAwarenessUpdate(awB, u, 'remote'), 0); } });
awB.on('update', ({ added, updated, removed }, origin) => { if (origin !== 'remote') { const u = encodeAwarenessUpdate(awB, added.concat(updated, removed)); setTimeout(() => applyAwarenessUpdate(awA, u, 'remote'), 0); } });
awA.setLocalStateField('user', { name: 'alice', color: '#ff0000' });
awB.setLocalStateField('user', { name: 'bob', color: '#0000ff' });
const ytextA = docA.getText('content'); const ytextB = docB.getText('content');
ytextA.insert(0, 'shared text');
const changesB = [];
const b = new CodeMirrorSurface({ parent: document.getElementById('b'), doc: '', handlers: { onChange: (e) => changesB.push(e.target.value) } });
a.bindYjs(ytextA, awA);
b.bindYjs(ytextB, awB);
check('binding takes the Y.Text\'s content into both views; managesYjs', a.value === 'shared text' && b.value === 'shared text' && a.managesYjs && b.managesYjs);
changesB.length = 0;
a.view.dispatch({ changes: { from: 11, to: 11, insert: ' from A' }, userEvent: 'input.type' });
check('a typed edit in A reaches the Y.Text and B\'s view', ytextA.toString() === 'shared text from A' && b.value === 'shared text from A', JSON.stringify([ytextA.toString(), b.value]));
check('B does not report the remote text as a change of its own', changesB.length === 0, JSON.stringify(changesB));
a.value = 'shared text from A, set';
check('`.value =` on a bound surface travels through the binding too', ytextB.toString() === 'shared text from A, set' && b.value === ytextB.toString());
b.view.dispatch({ changes: { from: 0, to: 0, insert: 'B: ' }, userEvent: 'input.type' });
check('an edit in B reaches A', a.value === 'B: shared text from A, set');
a.undo();
check('undo in A (the Y.UndoManager behind Cmd/Ctrl+Z) reverts only A\'s last local edit, B\'s stays', a.value === 'B: shared text from A' && b.value === a.value, JSON.stringify([a.value, b.value]));
// B's caret, as y-codemirror.next publishes it (anchor / head relative positions), drawn in A
awB.setLocalStateField('cursor', { anchor: Y.createRelativePositionFromTypeIndex(ytextB, 3), head: Y.createRelativePositionFromTypeIndex(ytextB, 3) });
await sleep(30);
const caret = document.querySelector('#a .cm-ySelectionCaret');
check('B\'s caret is drawn in A with B\'s name and colour', !!caret && /bob/.test(caret.textContent) && /0, 0, 255|#0000ff/i.test(caret.getAttribute('style') || ''), caret ? caret.outerHTML.slice(0, 200) : 'no caret');
// the hook's own cursor format (position + relative anchor / head) is drawn as well
awB.setLocalStateField('cursor', { position: 3, selectionEnd: 5, anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytextB, 3)), head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytextB, 5)) });
await sleep(30);
check('a textarea peer\'s cursor field (position + anchor / head JSON) is drawn too, with its selection', !!document.querySelector('#a .cm-ySelectionCaret') && document.querySelectorAll('#a .cm-ySelection').length >= 1);
a.unbindYjs();
check('unbindYjs: a local document again', a.managesYjs === false);
a.view.dispatch({ changes: { from: 0, to: 0, insert: 'local ' }, userEvent: 'input.type' });
check('after unbinding, edits stay local', a.value.startsWith('local ') && !ytextA.toString().startsWith('local '));
a.destroy(); b.destroy();
check('destroy removes the editor DOM', !document.querySelector('#a .cm-editor') && !document.querySelector('#b .cm-editor'));

fs.rmSync(WORKDIR, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
