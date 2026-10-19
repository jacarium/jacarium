/**
 * Guards the Documents editor against macOS "Add period with double-space"
 * (src/utils/macPeriodSubstitution.js, attached to the editor textarea in
 * src/components/features/documents/DocumentEditor.jsx).
 *
 * THE BUG: on macOS with System Settings > Keyboard > Text Input > Input
 * Sources > Edit... > "Add period with double-space" enabled (the default,
 * NSAutomaticPeriodSubstitutionEnabled=1), typing `a<space><space>` in the
 * editor became `a.<space>`, destroying Markdown hard line breaks (two
 * trailing spaces). It is not app code: AppKit asks Chromium's text-input
 * view to replace the first space with ". " (-insertText:replacementRange:),
 * Chromium commits it as IME text with a replacement range and Blink applies
 * it with InputMethodController::ReplaceTextAndMoveCaret(): selection moved
 * onto the space, then a cancelable `beforeinput` {inputType: "insertText",
 * data: ". "}, then the insert. That exact event shape is what this test
 * replays - native macOS text substitution cannot be driven from a test
 * (synthetic key events bypass AppKit), so the guard's event path is
 * simulated and the guard's behaviour in a real Chromium editing session
 * (execCommand inside beforeinput, undo) is verified in section 3.
 *
 * What this proves:
 *   section 1 - the handler on a bare textarea (jsdom): the substitution
 *     event is cancelled and the text keeps two spaces with the caret after
 *     them; a genuinely typed "." then " " (collapsed selection) is left
 *     alone; a "." typed over a selected space is left alone; ". " replacing
 *     selected non-space text (e.g. an accepted spelling correction) is left
 *     alone; IME composition events are left alone; an already-cancelled
 *     event is not touched; the fallback path fires an `input` event.
 *   section 2 - the REAL DocumentEditor mounted in jsdom over a fake
 *     IndexedDB: the substitution replayed on its textarea leaves "a  " in
 *     both the DOM and the parent's React state; normal typing including a
 *     real ". " still reaches the parent; "/wf" still opens Quick Workflow;
 *     the guard is attached to the mounted textarea element.
 *   section 3 - real Chromium (Vite dev server + headless Chrome, SKIPs with
 *     exit 0 when no Chrome/CHROME_BIN or SKIP_BROWSER_TESTS=1): with the
 *     app's own editor, the replayed substitution yields two spaces via
 *     document.execCommand('insertText') and Cmd+Z-style undo
 *     (execCommand('undo')) removes just that space, then the earlier typed
 *     text - i.e. the native undo stack survived.
 *
 * Run:  node tests/documents-mac-period-substitution.test.mjs
 * Preconditions (checked at startup):
 *   - repo deps installed:   npm install
 *   - test-only deps:        npm install --no-save jsdom fake-indexeddb
 * Environment: CHROME_BIN, SMOKE_PORT (default 5231) for section 3.
 * Exit code 0 = all checks passed (or section 3 skipped), 1 = failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

function requireResolvable(name, hint) {
  try { req.resolve(name); } catch { console.error(`Missing dependency "${name}". ${hint}`); process.exit(1); }
}
requireResolvable('react', 'Run: npm install');
requireResolvable('react-dom', 'Run: npm install');
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom fake-indexeddb');
requireResolvable('fake-indexeddb', 'Run: npm install --no-save jsdom fake-indexeddb');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); } catch { last = null; }
    if (last) return last;
    await sleep(stepMs);
  }
  return last;
}
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-mac-period-'));

/**
 * Replay exactly what Blink does for the macOS substitution: the selection
 * is already on the space being replaced when the cancelable beforeinput
 * fires; if nobody cancels, ". " replaces that range (the "default action").
 */
function replaySubstitution(window, textarea, start, end) {
  textarea.setSelectionRange(start, end);
  const ev = new window.InputEvent('beforeinput', { inputType: 'insertText', data: '. ', cancelable: true, bubbles: true });
  const notCancelled = textarea.dispatchEvent(ev);
  if (notCancelled) {
    // default action (what the OS substitution would have done)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, textarea.value.slice(0, start) + '. ' + textarea.value.slice(end));
    textarea.setSelectionRange(start + 2, start + 2);
    textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: '. ' }));
  }
  return !notCancelled;
}
/** A real keyboard character: collapsed selection, then value spliced at the caret. */
function typeChar(window, textarea, ch) {
  const pos = textarea.selectionStart;
  textarea.setSelectionRange(pos, pos);
  const ev = new window.InputEvent('beforeinput', { inputType: 'insertText', data: ch, cancelable: true, bubbles: true });
  const notCancelled = textarea.dispatchEvent(ev);
  if (notCancelled) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, textarea.value.slice(0, pos) + ch + textarea.value.slice(pos));
    textarea.setSelectionRange(pos + ch.length, pos + ch.length);
    textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
  }
  return !notCancelled;
}

let exitCode = 1;
try {
  const { JSDOM } = await import(req.resolve('jsdom'));

  // =====================================================================
  // Section 1: the handler on a bare textarea
  // =====================================================================
  {
    const H = await import(path.join(REPO, 'src', 'utils', 'macPeriodSubstitution.js'));
    const dom = new JSDOM('<!doctype html><html><body><textarea id="t"></textarea></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
    const { window } = dom;
    const ta = window.document.getElementById('t');
    const detach = H.attachMacPeriodSubstitutionGuard(ta);
    const inputs = [];
    ta.addEventListener('input', (e) => inputs.push({ inputType: e.inputType, data: e.data, value: ta.value }));
    const reset = (v) => { ta.value = v; ta.setSelectionRange(v.length, v.length); inputs.length = 0; };

    // a<space> is typed, then the OS replaces that space with ". "
    reset('a ');
    let cancelled = replaySubstitution(window, ta, 1, 2);
    check('section 1: the macOS ". " substitution over the first space is cancelled', cancelled);
    check('section 1: the text keeps two spaces ("a  ") with the caret after them', ta.value === 'a  ' && ta.selectionStart === 3 && ta.selectionEnd === 3, JSON.stringify([ta.value, ta.selectionStart]));
    check('section 1: the fallback path notified listeners with one input event for the space', inputs.length === 1 && inputs[0].data === ' ' && inputs[0].value === 'a  ', JSON.stringify(inputs));

    // mid-document: "hello world" with the caret after "hello " -> "hello  world"
    reset('hello world');
    cancelled = replaySubstitution(window, ta, 5, 6);
    check('section 1: works mid-line - "hello world" becomes "hello  world"', cancelled && ta.value === 'hello  world' && ta.selectionStart === 7, JSON.stringify([ta.value, ta.selectionStart]));

    // Markdown hard line break: "line one " + space, then a newline typed
    reset('line one ');
    replaySubstitution(window, ta, 8, 9);
    typeChar(window, ta, '\n');
    typeChar(window, ta, 'x');
    check('section 1: Markdown hard line break survives ("line one  \\nx")', ta.value === 'line one  \nx', JSON.stringify(ta.value));

    // a genuinely typed period then space: two events, collapsed selection - untouched
    reset('end');
    let c1 = typeChar(window, ta, '.');
    let c2 = typeChar(window, ta, ' ');
    check('section 1: a real "." then " " typed by the user is not intercepted', !c1 && !c2 && ta.value === 'end. ', JSON.stringify(ta.value));

    // a "." typed over a selected space (data ".", not ". ") - untouched
    reset('a b');
    ta.setSelectionRange(1, 2);
    let ev = new window.InputEvent('beforeinput', { inputType: 'insertText', data: '.', cancelable: true, bubbles: true });
    check('section 1: "." typed over a selected space is left to the browser', ta.dispatchEvent(ev) === true && ta.value === 'a b');

    // ". " replacing selected non-space text (e.g. an accepted correction) - untouched
    reset('teh ');
    ta.setSelectionRange(0, 3);
    ev = new window.InputEvent('beforeinput', { inputType: 'insertText', data: '. ', cancelable: true, bubbles: true });
    check('section 1: ". " replacing selected non-space text is left to the browser', ta.dispatchEvent(ev) === true && ta.value === 'teh ');

    // ". " with a collapsed selection (nothing being replaced) - untouched
    reset('a ');
    ta.setSelectionRange(2, 2);
    ev = new window.InputEvent('beforeinput', { inputType: 'insertText', data: '. ', cancelable: true, bubbles: true });
    check('section 1: ". " inserted with a collapsed selection is left to the browser', ta.dispatchEvent(ev) === true && ta.value === 'a ');

    // IME composition: never touched
    reset('a ');
    ta.setSelectionRange(1, 2);
    ev = new window.InputEvent('beforeinput', { inputType: 'insertText', data: '. ', isComposing: true, cancelable: true, bubbles: true });
    const imeA = ta.dispatchEvent(ev);
    ev = new window.InputEvent('beforeinput', { inputType: 'insertCompositionText', data: '. ', cancelable: true, bubbles: true });
    const imeB = ta.dispatchEvent(ev);
    check('section 1: IME composition events (isComposing / insertCompositionText) are left alone', imeA && imeB && ta.value === 'a ');

    // an event someone else already cancelled is not touched
    reset('a ');
    ta.setSelectionRange(1, 2);
    ev = new window.InputEvent('beforeinput', { inputType: 'insertText', data: '. ', cancelable: true, bubbles: true });
    ev.preventDefault();
    const before = ta.value;
    ta.dispatchEvent(ev);
    check('section 1: an already-cancelled event is not acted on', ta.value === before && ta.selectionStart === 1 && ta.selectionEnd === 2);

    // pure predicate
    reset('a ');
    ta.setSelectionRange(1, 2);
    check('section 1: isMacPeriodSubstitution() recognises the shape and nothing else',
      H.isMacPeriodSubstitution({ inputType: 'insertText', data: '. ' }, ta) === true
      && H.isMacPeriodSubstitution({ inputType: 'insertText', data: '.' }, ta) === false
      && H.isMacPeriodSubstitution({ inputType: 'insertReplacementText', data: '. ' }, ta) === false
      && H.isMacPeriodSubstitution({ inputType: 'insertText', data: '. ', isComposing: true }, ta) === false
      && H.isMacPeriodSubstitution(null, ta) === false);

    // detached: the substitution goes through again
    detach();
    reset('a ');
    cancelled = replaySubstitution(window, ta, 1, 2);
    check('section 1: after detaching, the substitution is no longer intercepted (control)', !cancelled && ta.value === 'a. ');
  }

  // =====================================================================
  // Section 2: the real DocumentEditor in jsdom
  // =====================================================================
  const editorSrc = fs.readFileSync(path.join(REPO, 'src', 'components', 'features', 'documents', 'DocumentEditor.jsx'), 'utf8');
  check('section 2: DocumentEditor imports and attaches the guard', /import \{ attachMacPeriodSubstitutionGuard \} from '\.\.\/\.\.\/\.\.\/utils\/macPeriodSubstitution'/.test(editorSrc) && /attachMacPeriodSubstitutionGuard\(textareaElement\)/.test(editorSrc));
  const guardSrc = fs.readFileSync(path.join(REPO, 'src', 'utils', 'macPeriodSubstitution.js'), 'utf8');
  check('section 2: the guard re-inserts the space through execCommand(\'insertText\') so native undo keeps working', /execCommand\('insertText', false, ' '\)/.test(guardSrc));

  const ENTRY = path.join(WORKDIR, 'entry.jsx');
  fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import DocumentEditor from '@worktree/src/components/features/documents/DocumentEditor.jsx';
import { BUILTIN_COMMANDS } from '@worktree/src/utils/slashCommands.js';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';

const api = {};
let setContentExternal = null;
function Host() {
  const [content, setContent] = React.useState('');
  setContentExternal = setContent;
  api.getContent = () => content;
  return React.createElement(DocumentEditor, {
    documentId: 1,
    document: { id: 1, title: 'Notes', inCloud: false },
    content,
    onContentChange: (e) => setContent(e.target.value),
    templates: BUILTIN_COMMANDS, // as the Documents page hands them in: the built-in "/" commands, then its templates
    locked: false,
    isOnline: true,
  });
}
api.setContent = (v) => setContentExternal && setContentExternal(v);
window.__harness = api;
createRoot(document.getElementById('root')).render(
  React.createElement(NotificationProvider, null, React.createElement(Host))
);
`);

  const { build } = await import(req.resolve('esbuild'));
  const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    outfile: BUNDLE,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' },
    resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
    nodePaths: [path.join(REPO, 'node_modules')],
    plugins: [{
      name: 'alias',
      setup(b) {
        b.onResolve({ filter: /^@worktree\// }, (args) => ({ path: path.join(REPO, args.path.replace(/^@worktree\//, '')) }));
        b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => {
          if (isBuiltin(args.path)) return { path: args.path, external: true };
          try { return { path: req.resolve(args.path) }; } catch { return null; }
        });
      },
    }],
    logLevel: 'warning',
  });

  await import(req.resolve('fake-indexeddb/auto'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  // Every Node global we shadow with a jsdom one is recorded so section 3 can
  // hand the real ones back (Node's WebSocket/fetch reject jsdom's Event).
  const savedGlobals = new Map();
  // Load Node's lazy fetch/WebSocket (undici) now, while `Event` is still
  // Node's own: its MessageEvent class captures the global Event at load.
  void globalThis.fetch; void globalThis.WebSocket;
  const define = (name, value) => {
    if (!savedGlobals.has(name)) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  // Only the ones Node's fetch/WebSocket rely on; jsdom's window/document stay
  // in place for the still-mounted React editor's timers.
  const restoreGlobals = (names) => {
    for (const name of names) {
      const desc = savedGlobals.get(name);
      if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name];
    }
  };
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement',
    'Element', 'Node', 'Event', 'InputEvent', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'localStorage', 'sessionStorage']) {
    define(name, window[name]);
  }
  define('getComputedStyle', window.getComputedStyle.bind(window));
  define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  define('cancelAnimationFrame', (id) => clearTimeout(id));
  class FakeObserver { observe() {} unobserve() {} disconnect() {} }
  define('ResizeObserver', FakeObserver); define('IntersectionObserver', FakeObserver);
  window.ResizeObserver = FakeObserver; window.IntersectionObserver = FakeObserver;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.scrollTo = function () {};
  window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }));
  window.indexedDB = globalThis.indexedDB; window.IDBKeyRange = globalThis.IDBKeyRange;
  const failingFetch = () => Promise.reject(new Error('no backend in test'));
  define('fetch', failingFetch); window.fetch = failingFetch;
  const origLog = console.log; const origErr = console.error; const origWarn = console.warn;
  const quiet = (fn) => (...a) => { const s = String(a[0] ?? ''); if (/^\[|Warning:|act\(|Dexie|Error/.test(s)) return; fn(...a); };
  console.log = quiet(origLog); console.error = quiet(origErr); console.warn = quiet(origWarn);

  createRequire(import.meta.url)(BUNDLE);
  const { document } = window;
  const H = window.__harness;
  const textarea = await waitFor(() => document.querySelector('textarea'));
  check('section 2: the real DocumentEditor mounted in jsdom', !!textarea);
  const resetDoc = async (text) => {
    H.setContent(text);
    await waitFor(() => document.querySelector('textarea').value === text);
    const ta = document.querySelector('textarea');
    ta.setSelectionRange(text.length, text.length);
    return ta;
  };

  // The substitution replayed on the editor's own textarea
  let ta = await resetDoc('a ');
  let cancelled = replaySubstitution(window, ta, 1, 2);
  check('section 2: the editor cancels the ". " substitution', cancelled);
  check('section 2: the editor textarea keeps "a  "', ta.value === 'a  ' && ta.selectionStart === 3, JSON.stringify([ta.value, ta.selectionStart]));
  check('section 2: the parent\'s React state received "a  " (onContentChange ran)', await waitFor(() => H.getContent() === 'a  '), JSON.stringify(H.getContent()));

  // Hard line break end to end
  ta = await resetDoc('line one ');
  replaySubstitution(window, ta, 8, 9);
  typeChar(window, ta, '\n');
  typeChar(window, ta, 'l');
  check('section 2: a Markdown hard line break ("line one  \\nl") reaches the parent state', await waitFor(() => H.getContent() === 'line one  \nl'), JSON.stringify(H.getContent()));

  // Normal typing incl. a real ". " still works
  ta = await resetDoc('The end');
  typeChar(window, ta, '.');
  typeChar(window, ta, ' ');
  typeChar(window, ta, 'N');
  check('section 2: normal typing with a real ". " still reaches the parent ("The end. N")', await waitFor(() => H.getContent() === 'The end. N'), JSON.stringify(H.getContent()));

  // Slash commands still work after the guard is attached
  ta = await resetDoc('Notes\n');
  ta.setSelectionRange(ta.value.length, ta.value.length);
  typeChar(window, ta, '/'); typeChar(window, ta, 'w'); typeChar(window, ta, 'f');
  // typing offers the entry in the "/" popup; Enter runs it
  await waitFor(() => document.querySelector('[data-slash-entry="quick-workflow"]'));
  ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const wf = await waitFor(() => Array.from(document.querySelectorAll('span')).find((s) => s.textContent === 'Quick Workflow' && !s.closest('[data-slash-entry]')));
  check('section 2: "/wf" still opens Quick Workflow', !!wf);
  if (wf) { wf.closest('.drag-handle').querySelector('button').click(); }
  await waitFor(() => !Array.from(document.querySelectorAll('span')).some((s) => s.textContent === 'Quick Workflow'));

  // And a substitution attempted right after a slash command token does not corrupt it
  ta = await resetDoc('see /wf ');
  replaySubstitution(window, ta, 7, 8);
  check('section 2: substitution after a slash token keeps the token intact ("see /wf  ")', await waitFor(() => H.getContent() === 'see /wf  '), JSON.stringify(H.getContent()));

  // =====================================================================
  // Section 3: real Chromium - execCommand inside beforeinput + undo
  // =====================================================================
  {
    restoreGlobals(['fetch', 'Event', 'CustomEvent']); // the live helper drives Vite/CDP with Node's own fetch/WebSocket/Event
    const { launchDocumentsApp, createNewDocument } = await import(path.join(REPO, 'tests', 'helpers', 'live-documents-app.mjs'));
    const PORT = Number(process.env.SMOKE_PORT || 5231);
    const app = await launchDocumentsApp({ port: PORT, profilePrefix: 'doc-mac-period-' });
    if (app.skip) {
      console.log(`SKIP: section 3 (real Chromium) - ${app.skip}`);
    } else {
      try {
        check('section 3: Documents page shows the empty-state New Document button on a fresh profile', await createNewDocument(app));
        const hasTa = await app.waitFor(`!!document.querySelector('textarea')`, 10000);
        check('section 3: editor textarea mounted', hasTa);
        await app.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); })()`);
        await app.send('Input.insertText', { text: 'abc ' });
        await sleep(300);
        const typed = await app.evaluate(`document.querySelector('textarea').value`);
        check('section 3: typed "abc " through Chromium\'s input path', typed === 'abc ', JSON.stringify(typed));
        // Replay the substitution shape (selection on the space, beforeinput insertText ". ")
        const after = await app.evaluate(`(() => {
          const ta = document.querySelector('textarea');
          ta.setSelectionRange(3, 4);
          const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: '. ', cancelable: true, bubbles: true });
          const notCancelled = ta.dispatchEvent(ev);
          return { cancelled: !notCancelled, value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
        })()`);
        check('section 3: in real Chromium the guard cancels the event and execCommand inserts the second space ("abc  ")',
          after.cancelled && after.value === 'abc  ' && after.start === 5 && after.end === 5, JSON.stringify(after));
        const undo1 = await app.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); const ok = document.execCommand('undo'); return { ok, value: ta.value }; })()`);
        check('section 3: undo removes just the re-inserted space ("abc ")', undo1.ok && undo1.value === 'abc ', JSON.stringify(undo1));
        const undo2 = await app.evaluate(`(() => { const ta = document.querySelector('textarea'); const ok = document.execCommand('undo'); return { ok, value: ta.value }; })()`);
        check('section 3: a second undo reaches the earlier typing (undo stack intact)', undo2.ok && undo2.value !== 'abc ', JSON.stringify(undo2));
        check('section 3: no page exceptions', app.errors.length === 0, app.errors.join(' | '));
      } finally {
        await app.close();
      }
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error('ERROR:', err && err.stack || err);
  exitCode = 1;
} finally {
  try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(exitCode);
