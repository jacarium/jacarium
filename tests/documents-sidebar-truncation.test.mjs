/**
 * Guards the Documents sidebar against long titles widening the list, and
 * the Linux-only "gap on the right" that came with it.
 *
 * THE BUG: on Linux, expanding a category whose documents have long titles
 * showed an empty strip down the right of the Documents sidebar; macOS never
 * showed it. Linux Chromium draws classic scrollbars that take layout width
 * (~10px), macOS overlay scrollbars take none - so any vertically overflowing
 * list loses that strip on Linux. The row chain itself must never add
 * horizontal overflow on top of that (a long title in a flex item without
 * `min-w-0`/`truncate` would size the row to the full text), and the Electron
 * main process opts Linux into overlay scrollbars so the layout matches macOS.
 * Real-browser measurements for this live in tests/linux/examples/.
 *
 * What this checks, on the REAL DocumentSidebar (real CategoryList /
 * CategorySection / ItemList) mounted in jsdom with synthetic titles:
 *   1. each document row renders its title in a `truncate` span that carries
 *      the full title as a `title` tooltip;
 *   2. the span's flex parent shrinks (`min-w-0` + `flex-1`), and every flex
 *      item on the chain from the span up to the sidebar's scroll container
 *      is allowed to shrink (`min-w-0`, `truncate` or `flex-shrink-0`);
 *   3. nothing on that chain is content-sized or non-wrapping
 *      (`w-max`, `min-w-max`, `w-fit`, `whitespace-nowrap`, `inline-*`, `table`);
 *   4. the scroll container is a block-level, vertically scrolling element
 *      (`overflow-y-auto`, no horizontal scrolling requested);
 *   5. electron/main.cjs enables Chromium's `OverlayScrollbar` feature on
 *      Linux (and only on Linux), before app ready.
 *
 * Run:  node tests/documents-sidebar-truncation.test.mjs
 * Preconditions (checked at startup, with instructions printed if missing):
 *   - repo deps installed:               npm install
 *   - test-only deps (not in package.json, install without saving):
 *                                        npm install --no-save jsdom fake-indexeddb
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
requireResolvable('jsdom', 'Run: npm install --no-save jsdom fake-indexeddb');
requireResolvable('fake-indexeddb', 'Run: npm install --no-save jsdom fake-indexeddb');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// ---------- browser globals (same recipe as tests/helpers/run-client.mjs) ----------
const { JSDOM } = await import(req.resolve('jsdom'));
await import(req.resolve('fake-indexeddb/auto'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
const define = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    try { globalThis[name] = value; } catch { /* ignore */ }
  }
};
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'localStorage', 'sessionStorage']) {
  define(name, window[name]);
}
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
define('ResizeObserver', FakeObserver);
define('IntersectionObserver', FakeObserver);
window.ResizeObserver = FakeObserver;
window.IntersectionObserver = FakeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = window.matchMedia || ((q) => ({
  matches: false, media: q,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, dispatchEvent() { return false; },
}));
window.indexedDB = globalThis.indexedDB;
window.IDBKeyRange = globalThis.IDBKeyRange;
// The sidebar persists its expanded categories here; expand the fixture category
window.localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General', 'Ops']));

// ---------- bundle the real sidebar ----------
const { build } = await import(req.resolve('esbuild'));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-sidebar-truncation-'));
const BUNDLE = path.join(WORKDIR, 'sidebar.cjs');
await build({
  entryPoints: [path.join(here, 'helpers', 'document-sidebar-entry.mjs')],
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

// ---------- synthetic fixture (no real documents) ----------
const LONG = 'An extremely long synthetic document title ' + 'lorem ipsum dolor sit amet consectetur '.repeat(6);
const documents = [
  { id: 1, title: 'Short', content: '', category: 'General', updatedAt: 3 },
  { id: 2, title: 'A considerably longer document title that will not fit in the sidebar width', content: '', category: 'General', updatedAt: 2 },
  { id: 3, title: LONG, content: '', category: 'General', updatedAt: 1 },
  { id: 4, title: 'Ops ' + 'padding words '.repeat(20), content: '', category: 'Ops', locked: true, updatedAt: 1 },
];

const { mountSidebar } = req(BUNDLE);
mountSidebar(documents);
await new Promise((r) => setTimeout(r, 50)); // let effects settle

const has = (el, cls) => el.classList.contains(cls);
const CONTENT_SIZED = ['w-max', 'min-w-max', 'w-fit', 'whitespace-nowrap', 'inline-flex', 'inline-block', 'inline', 'table'];

// ---------- 1 + 2 + 3: the row chain for every document ----------
const scroller = Array.from(document.querySelectorAll('div')).find((d) => has(d, 'overflow-y-auto') && d.getAttribute('data-document-list') === 'true');
check('the sidebar has a vertical scroll container around the category list', !!scroller);
check('the sidebar no longer carries a title-filter input (content search moved to "Find in Files")', !document.querySelector('input[placeholder="Search documents..."]'));

for (const doc of documents) {
  const span = Array.from(document.querySelectorAll('span.truncate')).find((s) => s.textContent === doc.title);
  const short = doc.title.slice(0, 24) + (doc.title.length > 24 ? '...' : '');
  check(`row "${short}" renders the title in a truncate span`, !!span);
  if (!span) continue;
  check(`row "${short}" exposes the full title as a tooltip`, span.getAttribute('title') === doc.title);

  const group = span.parentElement;
  check(`row "${short}": the title's flex parent may shrink (flex-1 min-w-0)`, has(group, 'flex') && has(group, 'flex-1') && has(group, 'min-w-0'), group.className);

  const offenders = [];
  const rigidFlexItems = [];
  let inScroller = false;
  for (let el = span; el && el !== document.body; el = el.parentElement) {
    if (el === scroller) { inScroller = true; break; }
    const bad = CONTENT_SIZED.filter((c) => has(el, c));
    if (bad.length) offenders.push(`<${el.tagName.toLowerCase()} class="${el.className}"> has ${bad.join(' ')}`);
    const parent = el.parentElement;
    const isFlexItem = parent && has(parent, 'flex') && !has(parent, 'flex-col');
    if (isFlexItem && !(has(el, 'min-w-0') || has(el, 'truncate') || has(el, 'flex-shrink-0'))) {
      rigidFlexItems.push(`<${el.tagName.toLowerCase()} class="${el.className}">`);
    }
  }
  check(`row "${short}" is inside the scroll container`, inScroller);
  check(`row "${short}": no content-sized/non-wrapping element between the title and the scroll container`, offenders.length === 0, offenders.join('; '));
  check(`row "${short}": every flex item on the chain is allowed to shrink`, rigidFlexItems.length === 0, rigidFlexItems.join('; '));
}

// ---------- 4: the scroll container itself ----------
if (scroller) {
  check('the scroll container scrolls vertically only (overflow-y-auto, no overflow-x-*)', has(scroller, 'overflow-y-auto') && !Array.from(scroller.classList).some((c) => c.startsWith('overflow-x-')), scroller.className);
  check('the scroll container is not content-sized', !CONTENT_SIZED.some((c) => has(scroller, c)), scroller.className);
}

// ---------- 5: Electron opts Linux into overlay scrollbars ----------
const main = fs.readFileSync(path.join(REPO, 'electron', 'main.cjs'), 'utf8');
const guarded = /if \(process\.platform === 'linux'\) \{[^}]*appendSwitch\(\s*'enable-features',[^}]*OverlayScrollbar[^}]*\}/s.test(main);
check('electron/main.cjs enables the OverlayScrollbar feature on Linux only', guarded);
check('the OverlayScrollbar switch is added before app.whenReady()', guarded && main.indexOf('OverlayScrollbar') < main.indexOf('app.whenReady().then('));
check('existing enable-features values are preserved (merged, not overwritten)', /getSwitchValue\('enable-features'\)/.test(main));

// ---------- summary ----------
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed.length ? 1 : 0);
