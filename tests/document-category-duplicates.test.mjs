/**
 * Guards the Documents sidebar against duplicate categories: two managed
 * category rows with the same name, and what the UI did with them.
 *
 * THE BUG (reproduced in real Chromium/Electron against the dev server):
 * categories are identified by NAME everywhere - documents.category, the
 * sidebar's expanded-state list, and the React `key` of each header - but
 * nothing kept the managed `documentCategories` table free of two rows with
 * the same name. Two writes could create such a pair and both survive a
 * restart:
 *   1. renaming a category to the name of an EXISTING category
 *      (renameDocumentCategory never checked the target name);
 *   2. submitting the "New Category" modal twice before the first insert
 *      landed (double Enter / key auto-repeat / Enter + button click): the
 *      duplicate check and the insert were separate, non-atomic steps.
 * getCategories() then returned the name twice, CategoryList rendered two
 * headers with the same key, and React's duplicate-key reconciliation leaked
 * one more orphan header on EVERY later list change (2 -> 4 -> 6 -> 8 rows).
 * The orphan rows kept stale click handlers (so they toggled the same
 * category), never re-rendered (so no hover chevron), and the two live rows
 * shared one expanded-state entry (so they opened together).
 *
 * What this checks against the REAL modules (Dexie over fake-indexeddb, the
 * real DocumentSidebar/CategoryList in jsdom, no mocks of the code under test):
 *   1. two concurrent createDocumentCategory() calls with the same name
 *      insert ONE row (the second returns the first row, created: false);
 *   2. renameCategory() onto an existing name is refused with
 *      code DUPLICATE_CATEGORY and changes nothing (managed or
 *      document-derived target);
 *   3. self-heal: an already-corrupted table (three rows with one name, one
 *      of them carrying an icon) collapses to one row on the next read, the
 *      lowest id survives, the icon is inherited, every document keeps its
 *      category, and getCategories() lists the name once;
 *   4. merge-mode import of a file that itself carries duplicate category
 *      rows creates one local row;
 *   5. CategoryList renders a repeated name once, never logs React's
 *      duplicate-key warning, and the header list stays exact across
 *      re-renders that reorder the list (the orphan-leak scenario);
 *   6. the New Category modal submitted twice (Enter, Enter) writes one row.
 *
 * Run:  node tests/document-category-duplicates.test.mjs
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
requireResolvable('dexie', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom fake-indexeddb');
requireResolvable('fake-indexeddb', 'Run: npm install --no-save jsdom fake-indexeddb');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- browser globals (same recipe as tests/documents-sidebar-truncation.test.mjs) ----------
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
// database.js runs its legacy-migration checks on import; mark them done.
for (const flag of ['db_migration_complete', 'workflows_migration_complete', 'env_vars_migration_complete']) {
  window.localStorage.setItem(flag, 'true');
}

// Capture React's duplicate-key warning (console.error in development builds).
const consoleErrors = [];
const origError = console.error;
console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); };
const duplicateKeyWarnings = () => consoleErrors.filter((m) => /same key/i.test(m));

// ---------- bundle the real modules + sidebar ----------
const { build } = await import(req.resolve('esbuild'));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'document-category-duplicates-'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [path.join(here, 'helpers', 'document-category-entry.mjs')],
  bundle: true,
  outfile: BUNDLE,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
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
const { documentCategories, documents, importDatabase, db, renderSidebar, unmountSidebar } = req(BUNDLE);
const { createDocumentCategory, getDocumentCategories, DUPLICATE_CATEGORY } = documentCategories;
const { createDocument, getDocumentsMetadata, getCategories, renameCategory } = documents;

const catRows = async () => (await db.documentCategories.toArray()).sort((a, b) => a.id - b.id);
const names = (rows) => rows.map((c) => c.name);
async function resetTables() {
  await db.documentCategories.clear();
  await db.documents.clear();
}

// ---------- 1: concurrent create with the same name (double-submitted modal) ----------
await resetTables();
{
  const [first, second] = await Promise.all([
    createDocumentCategory({ name: 'Twin Cat' }),
    createDocumentCategory({ name: 'Twin Cat' }),
  ]);
  const rows = await catRows();
  check('concurrent create x2 with the same name inserts exactly one row', rows.length === 1 && rows[0].name === 'Twin Cat', JSON.stringify(names(rows)));
  const created = [first, second].filter((c) => c.created === true);
  const reused = [first, second].filter((c) => c.created === false);
  check('one call reports created: true, the other returns the same row with created: false', created.length === 1 && reused.length === 1 && created[0].id === reused[0].id, JSON.stringify({ first, second }));
  const again = await createDocumentCategory({ name: 'Twin Cat' });
  check('a later create with the same name is a no-op returning the existing row', again.created === false && again.id === rows[0].id && (await catRows()).length === 1);
}

// ---------- 2: rename onto an existing name is refused ----------
await resetTables();
{
  await createDocumentCategory({ name: 'Work Notes' });
  await createDocumentCategory({ name: 'New Category' });
  const docId = await createDocument({ title: 'Renamed Doc', content: '', category: 'New Category' });
  await createDocument({ title: 'Loose Doc', content: '', category: 'Loose Papers' }); // document-derived category, not managed

  let err = null;
  try { await renameCategory('New Category', 'Work Notes'); } catch (e) { err = e; }
  check('renameCategory onto an existing managed name throws with code DUPLICATE_CATEGORY', err && err.code === DUPLICATE_CATEGORY, err && err.message);
  const rows = await catRows();
  check('refused rename leaves the managed rows untouched (no second "Work Notes")', names(rows).join('|') === 'Work Notes|New Category', JSON.stringify(names(rows)));
  const doc = (await getDocumentsMetadata()).find((d) => d.id === docId);
  check('refused rename leaves the document in its original category', doc && doc.category === 'New Category', doc && doc.category);

  err = null;
  try { await renameCategory('New Category', 'Loose Papers'); } catch (e) { err = e; }
  check('renameCategory onto a document-derived (unmanaged) name is refused too', err && err.code === DUPLICATE_CATEGORY);

  await renameCategory('New Category', 'Fresh Name');
  const after = await catRows();
  const movedDoc = (await getDocumentsMetadata()).find((d) => d.id === docId);
  check('a rename to a free name still works and re-tags the documents', names(after).join('|') === 'Work Notes|Fresh Name' && movedDoc.category === 'Fresh Name', JSON.stringify(names(after)));
}

// ---------- 3: self-heal of an already-corrupted table ----------
await resetTables();
{
  const now = new Date().toISOString();
  await db.documentCategories.bulkAdd([
    { name: 'Work Notes', icon: null, position: 0, createdAt: now, updatedAt: now },
    { name: 'Work Notes', icon: 'robot', position: 1, createdAt: now, updatedAt: now },
    { name: 'Other', icon: null, position: 2, createdAt: now, updatedAt: now },
    { name: 'Work Notes', icon: 'archive', position: 3, createdAt: now, updatedAt: now },
  ]);
  const before = await catRows();
  const survivorId = before[0].id;
  await createDocument({ title: 'Doc A', content: 'a', category: 'Work Notes' });
  await createDocument({ title: 'Doc B', content: 'b', category: 'Work Notes' });
  await createDocument({ title: 'Doc C', content: 'c', category: 'Other' });

  const repaired = await getDocumentCategories();
  check('getDocumentCategories() collapses three same-named rows to one', names(repaired).join('|') === 'Work Notes|Other', JSON.stringify(names(repaired)));
  const survivor = repaired.find((c) => c.name === 'Work Notes');
  check('the row created first (lowest id) is the survivor', survivor && survivor.id === survivorId, survivor && `id=${survivor.id}, expected ${survivorId}`);
  check('the survivor inherits the icon from its first twin that had one', survivor && survivor.icon === 'robot', survivor && survivor.icon);
  check('the repair is persisted (raw table now has two rows)', (await catRows()).length === 2);
  const docs = await getDocumentsMetadata();
  check('no document lost its category during the repair', docs.filter((d) => d.category === 'Work Notes').length === 2 && docs.filter((d) => d.category === 'Other').length === 1, JSON.stringify(docs.map((d) => [d.title, d.category])));
  const list = await getCategories();
  check('getCategories() lists each name once', new Set(list).size === list.length && list.includes('Work Notes') && list.includes('Other'), JSON.stringify(list));
}

// ---------- 4: merge import of a file that carries duplicate category rows ----------
await resetTables();
{
  const t = '2024-01-01T00:00:00.000Z';
  await importDatabase.mergeImportDatabase({
    version: '1.0',
    documents: [],
    documentTemplates: [],
    jqlTemplates: [],
    engineTemplates: [],
    documentCategories: [
      { id: 7, name: 'Imported Twice', icon: null, position: 0, createdAt: t, updatedAt: t },
      { id: 8, name: 'Imported Twice', icon: null, position: 1, createdAt: t, updatedAt: t },
    ],
  });
  const rows = await catRows();
  check('merge import of a file with duplicate category rows creates one local row', rows.length === 1 && rows[0].name === 'Imported Twice', JSON.stringify(names(rows)));
}

// ---------- 5: rendering a repeated name (the orphan-leak scenario) ----------
await resetTables();
{
  const docs = [{ id: 1, title: 'Doc one', content: '', category: 'Zeta', updatedAt: 1 }];
  const headers = () => Array.from(document.querySelectorAll('span.text-sm.font-medium.truncate')).map((s) => s.textContent);
  window.localStorage.setItem('expandedDocumentCategories', JSON.stringify([]));

  renderSidebar({ documents: docs, categories: ['Zeta', 'Zeta'] });
  await sleep(30);
  check('a name repeated in `categories` renders as ONE header', headers().join('|') === 'Zeta', JSON.stringify(headers()));

  // Each later create sorts before Zeta, which is exactly what leaked one orphan row per change.
  renderSidebar({ documents: docs, categories: ['Alpha', 'Zeta', 'Zeta'] });
  await sleep(30);
  check('after adding a category the headers are exact (no orphan row)', headers().join('|') === 'Alpha|Zeta', JSON.stringify(headers()));
  renderSidebar({ documents: docs, categories: ['Alpha', 'Beta', 'Zeta', 'Zeta'] });
  await sleep(30);
  renderSidebar({ documents: docs, categories: ['Alpha', 'Beta', 'Gamma', 'Zeta', 'Zeta'] });
  await sleep(30);
  check('three list changes later the headers are still exact', headers().join('|') === 'Alpha|Beta|Gamma|Zeta', JSON.stringify(headers()));
  check('React never warned about children with the same key', duplicateKeyWarnings().length === 0, duplicateKeyWarnings()[0]);

  const zetaButton = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.startsWith('Zeta')).pop();
  zetaButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const visibleDocs = Array.from(document.querySelectorAll('span.truncate')).filter((s) => s.textContent === 'Doc one').length;
  check('clicking the header expands one category and shows its document once', visibleDocs === 1, `document rows visible: ${visibleDocs}`);
  unmountSidebar();
}

// ---------- 6: the New Category modal submitted twice writes one row ----------
await resetTables();
{
  let refreshes = 0;
  renderSidebar({ documents: [], categories: [], onRefreshDocuments: async () => { refreshes += 1; } });
  await sleep(30);
  // The sidebar root: the flex column holding the DOCUMENTS header and the
  // document list (the old title-filter input is gone; content search lives
  // in the "Find in Files" window)
  let sidebarRoot = document.querySelector('[data-document-list="true"]');
  while (sidebarRoot && !(sidebarRoot.classList.contains('flex-col') && sidebarRoot.classList.contains('h-full'))) sidebarRoot = sidebarRoot.parentElement;
  const headerButtons = sidebarRoot.firstElementChild.querySelectorAll('button');
  headerButtons[headerButtons.length - 1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const newCategoryItem = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'New Category');
  check('the sidebar menu offers "New Category"', !!newCategoryItem);
  newCategoryItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const input = document.querySelector('input[placeholder="Enter category name..."]');
  check('the New Category modal is open with its name input', !!input);
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setValue.call(input, 'Double Enter');
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(10);
  // Enter twice before the first create's async duplicate check can finish.
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(300);
  const rows = await catRows();
  check('submitting the modal twice creates exactly one category row', rows.length === 1 && rows[0].name === 'Double Enter', JSON.stringify(names(rows)));
  check('the modal closed after the create', !document.querySelector('input[placeholder="Enter category name..."]'));
  check('the parent was asked to refresh once', refreshes === 1, `refreshes=${refreshes}`);
  unmountSidebar();
}

// ---------- summary ----------
console.error = origError;
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed.length ? 1 : 0);
