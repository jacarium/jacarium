/**
 * Guards the shared confirmation building blocks used to replace native
 * window.confirm()/alert() dialogs across the app:
 *
 *  1. ConfirmationModal's typed-confirmation mode (confirmPhrase prop,
 *     src/components/common/modals/ConfirmationModal.jsx) - added for the
 *     wipe-database fix. The confirm button (and the Enter key) must stay
 *     inert until the user types the exact phrase, the phrase input must
 *     reset between opens, and cancel/confirm must fire exactly the right
 *     callback.
 *
 *  2. The useConfirmation hook (src/hooks/useConfirmation.js) - the
 *     promise-based bridge that lets former `if (window.confirm(...))` call
 *     sites keep their control flow (`if (await confirm({...}))`). The
 *     returned promise must resolve true only on confirm, false on cancel
 *     AND on Escape (BaseModal's dismiss path), never resolve while a
 *     confirmPhrase is unmet, and each confirmation must be independent.
 *
 * Mounts the REAL components in jsdom (same pattern as
 * ai-chat-markdown-rendering.test.mjs).
 *
 * Run:  node tests/confirmation-modal-typed-phrase.test.mjs
 * Preconditions (checked at startup):
 *   - repo deps installed:   npm install
 *   - test-only deps:        npm install --no-save jsdom
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

// ---------- precondition checks ----------
function requireResolvable(name, hint) {
  try {
    req.resolve(name);
  } catch {
    console.error(`Missing dependency "${name}". ${hint}`);
    process.exit(1);
  }
}
requireResolvable('react', 'Run: npm install');
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'confirmation-modal-'));

// ---------- test scaffolding ----------
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// ---------- harness entry (bundled with the REAL components) ----------
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ConfirmationModal from '@worktree/src/components/common/modals/ConfirmationModal.jsx';
import { useConfirmation } from '@worktree/src/hooks/useConfirmation.js';

// Direct-props harness: parent-controlled isOpen, records callback firings.
function DirectHarness() {
  const [open, setOpen] = React.useState(false);
  const [phrase, setPhrase] = React.useState(null);
  window.__direct = {
    open: (p) => { setPhrase(p ?? null); setOpen(true); },
    close: () => setOpen(false),
    confirms: window.__direct?.confirms ?? [],
    cancels: window.__direct?.cancels ?? [],
  };
  return (
    <ConfirmationModal
      isOpen={open}
      onConfirm={() => { window.__direct.confirms.push(1); setOpen(false); }}
      onCancel={() => { window.__direct.cancels.push(1); setOpen(false); }}
      title="Wipe Database?"
      message="Everything will be deleted."
      type="danger"
      confirmLabel="Wipe Database"
      confirmPhrase={phrase}
    />
  );
}

// Hook harness: promise-based confirm() like converted call sites use.
function HookHarness() {
  const { confirm, confirmationProps } = useConfirmation();
  window.__hook = {
    results: window.__hook?.results ?? [],
    ask: (options) => {
      confirm(options).then((r) => window.__hook.results.push(r));
    },
  };
  return <ConfirmationModal {...confirmationProps} />;
}

createRoot(document.getElementById('direct-root')).render(<DirectHarness />);
createRoot(document.getElementById('hook-root')).render(<HookHarness />);
`);

// ---------- bundle with esbuild ----------
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
  define: { 'process.env.NODE_ENV': '"production"' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
  nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{
    name: 'alias',
    setup(b) {
      b.onResolve({ filter: /^@worktree\// }, (args) => ({
        path: path.join(REPO, args.path.replace(/^@worktree\//, '')),
      }));
      b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => {
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        try { return { path: req.resolve(args.path) }; } catch { return null; }
      });
    },
  }],
  logLevel: 'warning',
});

// ---------- jsdom environment ----------
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM(
  '<!doctype html><html><body><div id="direct-root"></div><div id="hook-root"></div></body></html>',
  { url: 'http://localhost/', pretendToBeVisual: true },
);
const { window } = dom;
const define = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};
define('window', window);
define('document', window.document);
define('navigator', window.navigator);
define('HTMLElement', window.HTMLElement);
define('HTMLInputElement', window.HTMLInputElement);
define('Element', window.Element);
define('Node', window.Node);
define('Event', window.Event);
define('KeyboardEvent', window.KeyboardEvent);
define('MouseEvent', window.MouseEvent);
define('CustomEvent', window.CustomEvent);
define('MutationObserver', window.MutationObserver);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('localStorage', window.localStorage);
define('sessionStorage', window.sessionStorage);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));

// ---------- helpers ----------
const doc = window.document;
const buttons = () => [...doc.querySelectorAll('button')];
const buttonByText = (text) => buttons().find((b) => b.textContent.trim() === text);
const modalInput = () => doc.querySelector('input[type="text"]');
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const type = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const pressEnterOn = (el) => el.dispatchEvent(
  new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
);
const pressEscape = () => doc.dispatchEvent(
  new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
);

// ---------- load bundle ----------
createRequire(import.meta.url)(BUNDLE);
await sleep(100);

let exitCode = 1;
try {
  const direct = window.__direct;
  const hook = window.__hook;

  // ============ section 1: ConfirmationModal without confirmPhrase =========
  check('section 1: modal hidden initially', !buttonByText('Wipe Database'));
  direct.open(null);
  await sleep(50);
  check('section 1: modal renders title/message when opened',
    doc.body.textContent.includes('Wipe Database?') &&
    doc.body.textContent.includes('Everything will be deleted.'));
  check('section 1: no phrase input rendered without confirmPhrase', !modalInput());
  const plainConfirmBtn = buttonByText('Wipe Database');
  check('section 1: confirm button enabled without confirmPhrase',
    !!plainConfirmBtn && !plainConfirmBtn.disabled);
  click(plainConfirmBtn);
  await sleep(50);
  check('section 1: clicking confirm fires onConfirm exactly once',
    direct.confirms.length === 1 && direct.cancels.length === 0,
    `confirms=${direct.confirms.length} cancels=${direct.cancels.length}`);

  direct.open(null);
  await sleep(50);
  click(buttonByText('Cancel'));
  await sleep(50);
  check('section 1: clicking cancel fires onCancel exactly once',
    direct.confirms.length === 1 && direct.cancels.length === 1,
    `confirms=${direct.confirms.length} cancels=${direct.cancels.length}`);

  // ============ section 2: typed-confirmation mode ==========================
  direct.open('DELETE EVERYTHING');
  await sleep(50);
  const input = modalInput();
  check('section 2: phrase input rendered when confirmPhrase set',
    !!input && input.placeholder === 'Type: DELETE EVERYTHING');
  const gatedBtn = buttonByText('Wipe Database');
  check('section 2: confirm button disabled before phrase typed', gatedBtn.disabled);

  click(gatedBtn);
  await sleep(50);
  check('section 2: clicking disabled confirm does nothing', direct.confirms.length === 1);

  pressEnterOn(input);
  await sleep(50);
  check('section 2: Enter with empty phrase does not confirm', direct.confirms.length === 1);

  type(input, 'delete everything');
  await sleep(50);
  check('section 2: case-mismatched phrase keeps confirm disabled',
    buttonByText('Wipe Database').disabled);
  pressEnterOn(input);
  await sleep(50);
  check('section 2: Enter with wrong phrase does not confirm', direct.confirms.length === 1);

  type(input, 'DELETE EVERYTHING');
  await sleep(50);
  check('section 2: exact phrase enables confirm button',
    !buttonByText('Wipe Database').disabled);
  click(buttonByText('Wipe Database'));
  await sleep(50);
  check('section 2: confirm fires once phrase matches',
    direct.confirms.length === 2, `confirms=${direct.confirms.length}`);

  // reopen: the phrase input must start empty and gated again
  direct.open('DELETE EVERYTHING');
  await sleep(50);
  check('section 2: phrase input resets to empty on reopen',
    modalInput().value === '' && buttonByText('Wipe Database').disabled,
    `value="${modalInput().value}"`);

  type(modalInput(), 'DELETE EVERYTHING');
  await sleep(50);
  pressEnterOn(modalInput());
  await sleep(50);
  check('section 2: Enter confirms once phrase matches',
    direct.confirms.length === 3, `confirms=${direct.confirms.length}`);

  // cancel must also clear a partially typed phrase
  direct.open('DELETE EVERYTHING');
  await sleep(50);
  type(modalInput(), 'DELETE EVERY');
  click(buttonByText('Cancel'));
  await sleep(50);
  direct.open('DELETE EVERYTHING');
  await sleep(50);
  check('section 2: cancel clears a partially typed phrase for the next open',
    modalInput().value === '');
  click(buttonByText('Cancel'));
  await sleep(50);

  // ============ section 3: useConfirmation promise semantics ================
  hook.ask({ title: 'Delete Item', message: 'Really delete?', type: 'danger', confirmLabel: 'Delete' });
  await sleep(50);
  check('section 3: hook opens the modal with given labels',
    doc.body.textContent.includes('Delete Item') && !!buttonByText('Delete'));
  click(buttonByText('Delete'));
  await sleep(50);
  check('section 3: confirm resolves the promise with true',
    hook.results.length === 1 && hook.results[0] === true, JSON.stringify(hook.results));
  check('section 3: modal closed after confirm', !buttonByText('Delete'));

  hook.ask({ title: 'Delete Item', message: 'Really delete?', confirmLabel: 'Delete' });
  await sleep(50);
  click(buttonByText('Cancel'));
  await sleep(50);
  check('section 3: cancel resolves the promise with false',
    hook.results.length === 2 && hook.results[1] === false, JSON.stringify(hook.results));

  hook.ask({ title: 'Delete Item', message: 'Really delete?', confirmLabel: 'Delete' });
  await sleep(50);
  pressEscape();
  await sleep(50);
  check('section 3: Escape (dismiss) resolves the promise with false',
    hook.results.length === 3 && hook.results[2] === false, JSON.stringify(hook.results));
  check('section 3: modal closed after Escape', !buttonByText('Delete'));

  // hook + confirmPhrase: promise must stay pending until phrase typed
  hook.ask({ title: 'Wipe', message: 'All gone.', confirmLabel: 'Wipe', confirmPhrase: 'YES WIPE' });
  await sleep(50);
  click(buttonByText('Wipe'));
  pressEnterOn(modalInput());
  await sleep(80);
  check('section 3: promise stays pending while phrase unmet', hook.results.length === 3);
  type(modalInput(), 'YES WIPE');
  await sleep(50);
  click(buttonByText('Wipe'));
  await sleep(50);
  check('section 3: phrase-gated confirm resolves true after typing phrase',
    hook.results.length === 4 && hook.results[3] === true, JSON.stringify(hook.results));

  exitCode = results.every((r) => r.pass) ? 0 : 1;
  console.log(`\nSUMMARY: ${results.filter((r) => r.pass).length}/${results.length} passed`);
} catch (e) {
  console.error('TEST DRIVER ERROR:', e);
} finally {
  fs.rmSync(WORKDIR, { recursive: true, force: true });
  process.exit(exitCode);
}
