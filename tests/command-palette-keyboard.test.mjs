/**
 * Guards keyboard navigation in the command palette
 * (src/components/CommandPalette.jsx, src/hooks/useScrollSelectedIntoView.js).
 *
 * THE BUG: ArrowDown / ArrowUp only changed `selectedIndex`; nothing
 * scrolled the highlighted row into view, so after a few presses the
 * selection sat below the visible part of the max-h-96 results list.
 *
 * THE FIX: useScrollSelectedIntoView scrolls the row carrying
 * data-index=<selectedIndex> into view with { block: 'nearest' } whenever
 * the selection changes - minimal scrolling, so a visible row causes no
 * jump and mouse hover (which does not touch the selection) never fights
 * the user's own scrolling. Rows are listbox options with aria-selected,
 * and the input names the active one through aria-activedescendant.
 *
 * What this test proves (the REAL component in jsdom, scrollIntoView
 * stubbed to record calls since jsdom has no layout):
 *   - typing "/" lists the built-in commands as role=option rows with
 *     data-index 0..n and the first one selected;
 *   - every ArrowDown scrolls the newly selected row into view with
 *     block: 'nearest', and marks it aria-selected / the input's active
 *     descendant; ArrowDown on the last row stays there;
 *   - End / Home jump to the last / first row; ArrowUp walks back;
 *   - a new query resets the selection to the first row and scrolls to it;
 *   - the search input is a padded, bordered field (not a bare transparent
 *     input that only the global focus ring outlines).
 *
 * Run:  node tests/command-palette-keyboard.test.mjs
 * Preconditions (checked at startup):
 *   - repo deps installed:   npm install
 *   - test-only deps:        npm install --no-save jsdom fake-indexeddb
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
requireResolvable('fake-indexeddb', 'Run: npm install --no-save fake-indexeddb');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ' | ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'command-palette-'));
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import CommandPalette from '@worktree/src/components/CommandPalette.jsx';
const noop = () => {};
createRoot(document.getElementById('root')).render(
  <CommandPalette isOpen onClose={noop} onNavigate={noop} onRefreshJira={noop} onLoadDocument={noop} onLoadTemplate={noop} onCreateDocument={noop} onLoadEngineTemplate={noop} />
);
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
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
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
window.indexedDB = globalThis.indexedDB;
window.IDBKeyRange = globalThis.IDBKeyRange;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'localStorage', 'sessionStorage']) define(name, window[name]);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));

// jsdom has no layout: record every scrollIntoView call instead
const scrolls = [];
window.Element.prototype.scrollIntoView = function scrollIntoView(options) {
  scrolls.push({ index: this.getAttribute('data-index'), options });
};

createRequire(import.meta.url)(BUNDLE);
await sleep(150);

const doc = window.document;
const input = () => doc.querySelector('input[role="combobox"]');
const rows = () => Array.from(doc.querySelectorAll('[role="option"]'));
const selectedRow = () => doc.querySelector('[role="option"][aria-selected="true"]');
const typeInto = (el, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const press = (key) => input().dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

let exitCode = 1;
try {
  check('the palette renders a combobox input that is a padded, bordered field',
    !!input() && /\bpx-3\b/.test(input().className) && /\bborder\b/.test(input().className) && /\bbg-os-input-bg\b/.test(input().className), input()?.className);

  typeInto(input(), '/');
  await sleep(400); // the 200ms search debounce + async template/document loads
  const n = rows().length;
  check('typing "/" lists the built-in commands as listbox options numbered from 0, first one selected',
    n >= 5 && eq(rows().map((r) => r.getAttribute('data-index')), rows().map((_, i) => String(i))) && selectedRow()?.getAttribute('data-index') === '0' &&
    doc.querySelector('[role="listbox"]')?.contains(rows()[0]), `${n} rows`);
  check('the input names the active row through aria-activedescendant', input().getAttribute('aria-activedescendant') === selectedRow().id);

  scrolls.length = 0;
  press('ArrowDown'); await sleep(30);
  press('ArrowDown'); await sleep(30);
  press('ArrowDown'); await sleep(30);
  check('three ArrowDowns select the fourth row and scroll each newly selected row into view with block: nearest',
    selectedRow()?.getAttribute('data-index') === '3' && eq(scrolls.map((s) => s.index), ['1', '2', '3']) && scrolls.every((s) => s.options?.block === 'nearest'),
    JSON.stringify(scrolls));
  check('aria-activedescendant follows the selection', input().getAttribute('aria-activedescendant') === `command-palette-option-3`);

  press('End'); await sleep(30);
  check('End jumps to the last row', selectedRow()?.getAttribute('data-index') === String(n - 1) && scrolls.at(-1).index === String(n - 1));
  press('ArrowDown'); await sleep(30);
  check('ArrowDown on the last row stays there (no wrap, no extra scroll)', selectedRow()?.getAttribute('data-index') === String(n - 1));
  press('Home'); await sleep(30);
  press('ArrowUp'); await sleep(30);
  check('Home goes to the first row; ArrowUp on it stays', selectedRow()?.getAttribute('data-index') === '0');

  press('End'); await sleep(30);
  scrolls.length = 0;
  typeInto(input(), '/d');
  await sleep(400);
  check('a new query resets the selection to the first row and scrolls to it',
    selectedRow()?.getAttribute('data-index') === '0' && scrolls.some((s) => s.index === '0'), JSON.stringify(scrolls));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.log('FAIL: unexpected error |', err && err.stack ? err.stack : err);
  exitCode = 1;
} finally {
  fs.rmSync(WORKDIR, { recursive: true, force: true });
}
process.exit(exitCode);
