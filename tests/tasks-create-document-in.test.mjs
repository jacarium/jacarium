/**
 * Guards the Tasks page's task-row right-click menu and its
 * "Create Document In" entry (src/components/tasks/TaskContextMenu.jsx,
 * wired into src/components/TasksPage.jsx through TaskItem's new
 * onContextMenu prop; the category side submenu is the shared
 * src/components/common/menus/CategorySubmenu.jsx that the Documents
 * sidebar's "Move to Category" row now renders too; pure helpers in
 * src/utils/taskDocument.js and src/utils/openDocument.js).
 *
 * THE FEATURE: right-clicking a task on the Tasks page shows a context menu
 * with "Create Document In"; hovering (or clicking) it opens the same
 * category submenu as the Documents sidebar's "Move to Category" (search
 * box, same category list and order). Picking a category creates ONE
 * document titled with the task's text in that category - through the
 * Documents page's own createDocument(), so the row carries every default
 * and indexed field - then switches to the Documents page (the app's
 * 'openDocument' window event, handled by JQLBuilder) where the new
 * document opens in edit mode with the editor body focused, ready to type.
 *
 * What this proves, with the REAL components mounted in jsdom over a fake
 * IndexedDB (nothing touches the user's data or the network - fetch is
 * stubbed to fail so every best-effort TaskWarrior CLI call is a no-op):
 *   - the pure helpers: title from the task text (trim, whitespace
 *     collapse, empty -> "Untitled Document", long -> cut with an ellipsis,
 *     duplicates allowed), the createDocument record, the navigation
 *     request (event + once-only pending focus), the standalone-window
 *     detection and the sidebar expansion helper;
 *   - on the REAL TasksPage: right-click on a task row opens the menu with
 *     "Create Document In"; hover AND click open the submenu; its entries
 *     are exactly getCategories() (what DocumentsPage feeds the sidebar's
 *     "Move to Category"), in the same order; the search box filters;
 *     picking a category creates exactly one document with the task's text
 *     as title in that category, visible via getDocumentsMetadata() with
 *     the store's defaults; the 'openDocument' event fires with its id and
 *     the editor-focus request is armed; the menu closes; the category is
 *     marked expanded for the Documents sidebar;
 *   - in a standalone Tasks window (?standalone=tasks) the document is still
 *     created but no navigation event fires and a notification says where
 *     it went;
 *   - existing row interactions are unaffected: right-click inside the
 *     inline description editor keeps the native menu, double-click still
 *     opens the inline editor, Esc still cancels it, ctrl+click still
 *     toggles selection, the checkbox still completes the task;
 *   - the REAL DocumentEditor honours the focus request: mounted with the
 *     requested document it focuses the body (caret at the end) and consumes
 *     the request; when that document was in preview mode - or the global
 *     "preview all documents" override was on - it drops to edit mode first;
 *     a document without a request keeps its preview mode;
 *   - the REAL DocumentsPage, mounted with selectedDocumentId (what
 *     JQLBuilder passes after the event) while a STALE persisted
 *     currentDocumentId points at another document, ends with the new
 *     document open in the active tab, the editor focused, and its category
 *     expanded in the sidebar with the row listed;
 *   - the Documents sidebar's own "Move to Category" still works through the
 *     extracted submenu: lists the other categories, filters, moves, offers
 *     "Create New" (which the Tasks submenu does not).
 *
 * Real rendering / contrast of the menu in both themes is covered by
 * tests/tasks-create-document-in-theme.test.mjs (headless Chrome).
 *
 * Run:  node tests/tasks-create-document-in.test.mjs
 * Preconditions (checked at startup):
 *   - repo deps installed:   npm install
 *   - test-only deps:        npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
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
requireResolvable('dexie', 'Run: npm install');
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
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-create-document-in-'));

let exitCode = 1;
try {
  // =====================================================================
  // Section 1: pure helpers (plain ESM, no DOM needed)
  // =====================================================================
  {
    const T = await import(path.join(REPO, 'src', 'utils', 'taskDocument.js'));
    check('section 1: title = task text trimmed', T.documentTitleFromTask('  Rotate the lab certificates  ') === 'Rotate the lab certificates');
    check('section 1: inner whitespace and newlines collapse to single spaces (titles are one line)',
      T.documentTitleFromTask('Rotate\n  the   lab\tcertificates') === 'Rotate the lab certificates');
    check('section 1: empty / blank / missing text -> "Untitled Document" (the Documents page\'s own default)',
      T.documentTitleFromTask('') === T.UNTITLED_DOCUMENT_TITLE && T.documentTitleFromTask('   \n ') === T.UNTITLED_DOCUMENT_TITLE
      && T.documentTitleFromTask(null) === T.UNTITLED_DOCUMENT_TITLE && T.documentTitleFromTask(undefined) === T.UNTITLED_DOCUMENT_TITLE
      && T.UNTITLED_DOCUMENT_TITLE === 'Untitled Document');
    const long = 'word '.repeat(100).trim(); // 499 chars
    const cut = T.documentTitleFromTask(long);
    check('section 1: a very long text is cut to the limit with an ellipsis, no trailing space before it',
      cut.length === T.MAX_TASK_DOCUMENT_TITLE_LENGTH && cut.endsWith('…') && !cut.endsWith(' …') && long.startsWith(cut.slice(0, -1)), `${cut.length} chars`);
    const exact = 'x'.repeat(T.MAX_TASK_DOCUMENT_TITLE_LENGTH);
    check('section 1: text exactly at the limit is kept whole', T.documentTitleFromTask(exact) === exact);
    check('section 1: duplicate titles are allowed (two tasks with the same text -> the same title twice, no suffix)',
      T.documentTitleFromTask('Same') === 'Same' && T.documentTitleFromTask('Same') === 'Same');
    const rec = T.buildDocumentFromTask({ description: ' Fix the pager ' }, 'Runbooks');
    check('section 1: createDocument record - title, EMPTY body, chosen category, nothing else (no task metadata)',
      JSON.stringify(rec) === JSON.stringify({ title: 'Fix the pager', content: '', category: 'Runbooks' }), JSON.stringify(rec));
    check('section 1: a blank category falls back to General', T.buildDocumentFromTask({ description: 'x' }, '  ').category === 'General'
      && T.buildDocumentFromTask({ description: 'x' }, null).category === 'General');

    const O = await import(path.join(REPO, 'src', 'utils', 'openDocument.js'));
    // Minimal window for the non-DOM helpers
    const events = [];
    globalThis.window = {
      location: { search: '' },
      dispatchEvent: (e) => { events.push(e); return true; },
      localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; })(),
    };
    globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
    check('section 1: openDocumentInEditor dispatches the app\'s openDocument event with the id and arms the focus request',
      O.openDocumentInEditor(42) === true && events.length === 1 && events[0].type === 'openDocument'
      && events[0].detail.documentId === 42 && events[0].detail.focusEditor === true && O.peekPendingEditorFocus() === 42);
    check('section 1: the focus request is only for that document', O.takePendingEditorFocus(41) === false && O.peekPendingEditorFocus() === 42);
    check('section 1: ... and is consumed exactly once', O.takePendingEditorFocus(42) === true && O.takePendingEditorFocus(42) === false && O.peekPendingEditorFocus() === null);
    O.openDocumentInEditor(7, { focusEditor: false });
    check('section 1: focusEditor:false navigates without arming a focus request', events.length === 2 && events[1].detail.focusEditor === false && O.peekPendingEditorFocus() === null);
    check('section 1: a missing id is refused', O.openDocumentInEditor(null) === false && O.openDocumentInEditor(undefined) === false && events.length === 2);
    globalThis.window.location.search = '?standalone=tasks';
    check('section 1: a standalone window (no app shell to switch pages) is detected and the request refused',
      O.canNavigateToDocuments() === false && O.openDocumentInEditor(9) === false && events.length === 2 && O.peekPendingEditorFocus() === null);
    globalThis.window.location.search = '';
    const store = globalThis.window.localStorage;
    O.expandDocumentCategoryInSidebar('Ops', store);
    O.expandDocumentCategoryInSidebar('Ops', store);
    O.expandDocumentCategoryInSidebar('Runbooks', store);
    check('section 1: expandDocumentCategoryInSidebar adds to the sidebar\'s persisted list once, keeping order',
      store.getItem(O.EXPANDED_DOCUMENT_CATEGORIES_KEY) === JSON.stringify(['Ops', 'Runbooks']) && O.EXPANDED_DOCUMENT_CATEGORIES_KEY === 'expandedDocumentCategories');
    store.setItem(O.EXPANDED_DOCUMENT_CATEGORIES_KEY, '{corrupt');
    O.expandDocumentCategoryInSidebar('Ops', store);
    check('section 1: a corrupt stored list is replaced, not fatal', store.getItem(O.EXPANDED_DOCUMENT_CATEGORIES_KEY) === JSON.stringify(['Ops']));
    O.expandDocumentCategoryInSidebar('', store);
    check('section 1: an empty category is ignored', store.getItem(O.EXPANDED_DOCUMENT_CATEGORIES_KEY) === JSON.stringify(['Ops']));
    delete globalThis.window; delete globalThis.CustomEvent;
  }

  // =====================================================================
  // Section 2: source guards
  // =====================================================================
  const sidebarSrc = fs.readFileSync(path.join(REPO, 'src', 'components', 'features', 'documents', 'DocumentSidebar.jsx'), 'utf8');
  const taskMenuSrc = fs.readFileSync(path.join(REPO, 'src', 'components', 'tasks', 'TaskContextMenu.jsx'), 'utf8');
  const tasksPageSrc = fs.readFileSync(path.join(REPO, 'src', 'components', 'TasksPage.jsx'), 'utf8');
  const submenuSrc = fs.readFileSync(path.join(REPO, 'src', 'components', 'common', 'menus', 'CategorySubmenu.jsx'), 'utf8');
  check('section 2: the Documents sidebar and the Tasks menu render the SAME CategorySubmenu component',
    /import CategorySubmenu from '\.\.\/\.\.\/common\/menus\/CategorySubmenu'/.test(sidebarSrc) && /<CategorySubmenu\b/.test(sidebarSrc)
    && /import CategorySubmenu from '\.\.\/common\/menus\/CategorySubmenu'/.test(taskMenuSrc) && /<CategorySubmenu\b/.test(taskMenuSrc)
    && !/Search categories\.\.\./.test(sidebarSrc));
  check('section 2: TasksPage creates through createDocument() and lists getCategories() from src/utils/documents.js',
    /import \{ createDocument, getCategories as getDocumentCategoryNames \} from '\.\.\/utils\/documents'/.test(tasksPageSrc));
  check('section 2: every TaskItem on the Tasks page gets the context-menu handler',
    (tasksPageSrc.match(/<TaskItem\b/g) || []).length === (tasksPageSrc.match(/onContextMenu=\{handleTaskContextMenu\}/g) || []).length);
  check('section 2: the menu/submenu use theme tokens only (no hard-coded colours)',
    ![taskMenuSrc, submenuSrc].some((s) => /#[0-9a-fA-F]{3,8}\b/.test(s.replace(/\/\*[\s\S]*?\*\//g, '')) || /rgba?\(/.test(s)));

  // =====================================================================
  // Section 3: the real components in jsdom
  // =====================================================================
  const ENTRY = path.join(WORKDIR, 'entry.jsx');
  fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import TasksPage from '@worktree/src/components/TasksPage.jsx';
import DocumentsPage from '@worktree/src/components/DocumentsPage.jsx';
import DocumentEditor from '@worktree/src/components/features/documents/DocumentEditor.jsx';
import DocumentSidebar from '@worktree/src/components/features/documents/DocumentSidebar.jsx';
import { NotificationProvider, useNotifications } from '@worktree/src/contexts/NotificationContext.jsx';
import { db } from '@worktree/src/db/database.js';
import { createTask, getTasks } from '@worktree/src/utils/tasks.js';
import { createInstance } from '@worktree/src/utils/taskwarriorInstances.js';
import { createDocument, getDocument, getDocumentsMetadata, getCategories } from '@worktree/src/utils/documents.js';
import { createDocumentCategory } from '@worktree/src/utils/documentCategories.js';
import * as openDoc from '@worktree/src/utils/openDocument.js';

const api = { db, createTask, getTasks, createInstance, createDocument, getDocument, getDocumentsMetadata, getCategories, createDocumentCategory, openDoc, history: [], openEvents: [], opened: [] };
window.addEventListener('openDocument', (e) => api.openEvents.push(e.detail));

let setView = null;
let key = 0;
function Probe() {
  const { history } = useNotifications();
  api.history = history;
  return null;
}
function Host() {
  const [view, set] = React.useState(null);
  setView = set;
  if (!view) return null;
  if (view.kind === 'tasks') return React.createElement(TasksPage, { key: view.key });
  if (view.kind === 'editor') return React.createElement(DocumentEditor, { key: view.key, templates: [], locked: false, isOnline: true, onContentChange: () => {}, ...view.props });
  if (view.kind === 'documents') return React.createElement(DocumentsPage, {
    key: view.key,
    selectedDocumentId: view.props.selectedDocumentId,
    onDocumentOpened: (id) => api.opened.push(id),
    createNewDocument: false,
    onDocumentCreated: () => {},
    onNavigate: () => {},
  });
  if (view.kind === 'sidebar') return React.createElement(DocumentSidebar, { key: view.key, ...view.props });
  return null;
}
api.mount = (kind, props = {}) => setView({ kind, props, key: ++key });
api.unmount = () => setView(null);
window.__harness = api;
createRoot(document.getElementById('root')).render(
  React.createElement(NotificationProvider, null, React.createElement(Probe), React.createElement(Host))
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
    loader: { '.woff2': 'dataurl', '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
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

  // ---------- jsdom + fake IndexedDB (same bootstrap as tests/helpers/run-client.mjs) ----------
  await import(req.resolve('fake-indexeddb/auto'));
  const { JSDOM } = await import(req.resolve('jsdom'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  const define = (name, value) => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLSelectElement',
    'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'localStorage', 'sessionStorage']) {
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
  // No backend in this test: every TaskWarrior CLI / backend call must fail fast and harmlessly
  const failingFetch = () => Promise.reject(new Error('no backend in test'));
  define('fetch', failingFetch); window.fetch = failingFetch;
  // Silence the app's chatty console.log/error without hiding test output
  const origLog = console.log; const origErr = console.error; const origWarn = console.warn;
  const quiet = (fn) => (...a) => { const s = String(a[0] ?? ''); if (/^\[|Warning:|act\(|Dexie|Error|no backend/.test(s)) return; fn(...a); };
  console.log = quiet(origLog); console.error = quiet(origErr); console.warn = quiet(origWarn);

  createRequire(import.meta.url)(BUNDLE);
  const { document } = window;
  const H = window.__harness;
  await waitFor(() => H.mount);

  const setNative = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  };
  const setInput = (el, value) => { setNative(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const mouse = (el, type, init = {}) => {
    const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 120, clientY: 80, ...init });
    el.dispatchEvent(ev);
    return ev;
  };
  const menu = () => document.querySelector('[data-testid="task-context-menu"]');
  const submenu = () => document.querySelector('[data-testid="task-create-document-in-submenu"]');
  const submenuEntries = () => Array.from(submenu()?.querySelectorAll('button[role="menuitem"]') || []).map((b) => b.textContent.trim());
  const rows = () => Array.from(document.querySelectorAll('[data-testid="task-item"]'));
  const rowFor = (text) => rows().find((r) => r.textContent.includes(text)) || null;

  // ---- seed: a TaskWarrior instance + tasks, and document categories the sidebar would list ----
  const inst = await H.createInstance({ name: 'Alpha Lab', category: 'General', isActive: 1 });
  const TASK_TEXT = 'Rotate the lab certificates';
  const now = new Date().toISOString();
  const t1 = await H.createTask({ description: `  ${TASK_TEXT} \n before Friday  `, status: 'pending', instanceId: inst.id, entry: now, modified: now });
  const t2 = await H.createTask({ description: 'Replace the pager battery', status: 'pending', instanceId: inst.id, entry: now, modified: now });
  await H.createDocumentCategory({ name: 'Runbooks' });
  await H.createDocumentCategory({ name: 'Ops' });
  await H.createDocument({ title: 'Archive note', content: 'old', category: 'Archive' });
  await H.createDocument({ title: 'General note', content: 'g', category: 'General' });
  const expectedCategories = await H.getCategories();
  check('section 3: seeded - two tasks, managed + ad-hoc document categories', (await H.getTasks()).length === 2 && expectedCategories.includes('Runbooks') && expectedCategories.includes('Ops') && expectedCategories.includes('Archive'), JSON.stringify(expectedCategories));
  const docsBefore = (await H.getDocumentsMetadata()).length;

  // ---- the real Tasks page ----
  H.mount('tasks');
  let row = await waitFor(() => rowFor(TASK_TEXT), 15000);
  check('section 3: the real TasksPage mounted and lists the seeded task', !!row && rows().length === 2, `${rows().length} rows`);

  const cmEvent = mouse(row, 'contextmenu');
  let m = await waitFor(menu);
  check('section 3: right-click on a task row opens the context menu (native menu suppressed)', !!m && cmEvent.defaultPrevented);
  const entryRow = m && m.querySelector('[data-testid="task-create-document-in"]');
  check('section 3: it has a "Create Document In" entry with a submenu chevron', !!entryRow && /^Create Document In$/.test(entryRow.querySelector('button').textContent.trim())
    && entryRow.querySelector('button').getAttribute('aria-haspopup') === 'menu' && !!entryRow.querySelector('svg.lucide-chevron-right'));
  check('section 3: the submenu is closed until hovered', !submenu());

  // hover opens, leaving closes, click opens again
  mouse(entryRow, 'mouseover', { relatedTarget: document.body });
  let sm = await waitFor(submenu);
  check('section 3: hovering the entry opens the side submenu', !!sm);
  check('section 3: the submenu has the same search box as "Move to Category" and lists getCategories() in the same order',
    !!sm && sm.querySelector('input[placeholder="Search categories..."]') && JSON.stringify(submenuEntries()) === JSON.stringify(expectedCategories), JSON.stringify(submenuEntries()));
  check('section 3: the Tasks submenu has no "Create New" footer (that is the Documents sidebar\'s modal flow)', !Array.from(sm.querySelectorAll('button')).some((b) => /Create New/.test(b.textContent)));
  mouse(entryRow, 'mouseout', { relatedTarget: document.body });
  check('section 3: leaving the entry closes the submenu', await waitFor(() => !submenu()));
  entryRow.querySelector('button').click();
  sm = await waitFor(submenu);
  check('section 3: clicking the entry opens the submenu too', !!sm);
  check('section 3: the context menu itself is still open', !!menu());
  setInput(sm.querySelector('input'), 'run');
  check('section 3: the search box filters the categories', await waitFor(() => JSON.stringify(submenuEntries()) === JSON.stringify(['Runbooks'])), JSON.stringify(submenuEntries()));
  setInput(sm.querySelector('input'), 'zzz');
  check('section 3: no match -> "No categories found"', await waitFor(() => submenuEntries().length === 0 && /No categories found/.test(submenu().textContent)));
  setInput(sm.querySelector('input'), '');
  await waitFor(() => submenuEntries().length === expectedCategories.length);

  // ---- pick a category ----
  window.localStorage.removeItem('expandedDocumentCategories');
  Array.from(sm.querySelectorAll('button[role="menuitem"]')).find((b) => b.textContent.trim() === 'Ops').click();
  check('section 3: picking a category closes the menu', await waitFor(() => !menu() && !submenu()));
  const created = await waitFor(async () => { const d = (await H.getDocumentsMetadata()).filter((x) => x.category === 'Ops'); return d.length ? d : null; });
  check('section 3: exactly one document was created (visible via getDocumentsMetadata, the Documents list path)',
    Array.isArray(created) && created.length === 1 && (await H.getDocumentsMetadata()).length === docsBefore + 1, created && JSON.stringify(created.map((d) => d.title)));
  const doc = created && created[0];
  check('section 3: titled with the task\'s text (trimmed, one line) in the chosen category', !!doc && doc.title === `${TASK_TEXT} before Friday` && doc.category === 'Ops', doc && doc.title);
  const full = doc && (await H.getDocument(doc.id));
  check('section 3: the row carries createDocument\'s defaults and indexed fields (empty body, unlocked, updatedAt, stableId)',
    !!full && full.content === '' && full.locked === false && typeof full.updatedAt === 'number' && typeof full.stableId === 'string' && full.stableId.length > 0 && typeof full.id === 'number',
    full && JSON.stringify(Object.keys(full)));
  check('section 3: the app\'s openDocument event fired once with the new id (JQLBuilder switches to Documents on it)',
    H.openEvents.length === 1 && H.openEvents[0].documentId === doc.id && H.openEvents[0].focusEditor === true, JSON.stringify(H.openEvents));
  check('section 3: the editor-focus request is armed for that document', H.openDoc.peekPendingEditorFocus() === doc.id);
  check('section 3: the category is marked expanded for the Documents sidebar', JSON.stringify(JSON.parse(window.localStorage.getItem('expandedDocumentCategories') || '[]')) === JSON.stringify(['Ops']));
  check('section 3: no error notification', !H.history.some((n) => n.type === 'error' && /document/i.test(n.message || '')), JSON.stringify(H.history.map((n) => [n.type, n.title])));
  H.openDoc.takePendingEditorFocus(doc.id); // consumed by the editor in the real app; clear it here

  // ---- a second task with the same text -> a second document, same title (duplicates allowed) ----
  await H.createTask({ description: TASK_TEXT + ' before Friday', status: 'pending', instanceId: inst.id, entry: now, modified: now });
  H.unmount(); await sleep(50); H.mount('tasks');
  const dupRows = await waitFor(() => (rows().filter((r) => r.textContent.includes(TASK_TEXT)).length === 2 ? rows().filter((r) => r.textContent.includes(TASK_TEXT)) : null), 15000);
  mouse(dupRows[1], 'contextmenu');
  m = await waitFor(menu);
  m.querySelector('[data-testid="task-create-document-in"] button').click();
  sm = await waitFor(submenu);
  Array.from(sm.querySelectorAll('button[role="menuitem"]')).find((b) => b.textContent.trim() === 'Ops').click();
  const dup = await waitFor(async () => { const d = (await H.getDocumentsMetadata()).filter((x) => x.category === 'Ops'); return d.length === 2 ? d : null; });
  check('section 3: a task with the same text makes another document with the same title (no suffix, no failure)',
    !!dup && dup.every((d) => d.title === `${TASK_TEXT} before Friday`) && new Set(dup.map((d) => d.id)).size === 2);
  H.openDoc.takePendingEditorFocus(H.openEvents[H.openEvents.length - 1].documentId);

  // ---- existing row interactions are unaffected ----
  row = rowFor('Replace the pager battery');
  const desc = row.querySelector('p');
  desc.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  const inlineInput = await waitFor(() => row.querySelector('input'));
  check('section 3: double-click on the description still opens the inline editor', !!inlineInput && inlineInput.value === 'Replace the pager battery');
  const inputCm = mouse(inlineInput, 'contextmenu');
  await sleep(100);
  check('section 3: right-click INSIDE the inline editor keeps the native menu (no app menu, default not prevented)', !menu() && !inputCm.defaultPrevented);
  inlineInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('section 3: Esc still cancels the inline edit', await waitFor(() => !row.querySelector('input') && row.querySelector('p')?.textContent === 'Replace the pager battery'));
  check('section 3: ... and the task text is unchanged in the store', (await H.getTasks()).find((t) => t.id === t2)?.description === 'Replace the pager battery');
  mouse(row, 'click', { ctrlKey: true });
  check('section 3: ctrl+click still toggles selection', await waitFor(() => rowFor('Replace the pager battery').className.includes('border-os-blue/60')));
  mouse(rowFor('Replace the pager battery'), 'click', { ctrlKey: true });
  check('section 3: ... and toggles it back', await waitFor(() => !rowFor('Replace the pager battery').className.includes('border-os-blue/60')));
  rowFor('Replace the pager battery').querySelector('button').click();
  check('section 3: the checkbox still completes the task', await waitFor(async () => (await H.getTasks()).find((t) => t.id === t2)?.status === 'completed', 8000));
  check('section 3: none of that created documents', (await H.getDocumentsMetadata()).length === docsBefore + 2);
  const openEventsSoFar = H.openEvents.length;

  // ---- standalone Tasks window: no app shell to navigate ----
  dom.reconfigure({ url: 'http://localhost/?standalone=tasks' });
  H.unmount(); await sleep(50); H.mount('tasks');
  row = await waitFor(() => rowFor(TASK_TEXT), 15000);
  mouse(row, 'contextmenu');
  m = await waitFor(menu);
  m.querySelector('[data-testid="task-create-document-in"] button').click();
  sm = await waitFor(submenu);
  Array.from(sm.querySelectorAll('button[role="menuitem"]')).find((b) => b.textContent.trim() === 'Runbooks').click();
  const standaloneDoc = await waitFor(async () => (await H.getDocumentsMetadata()).find((x) => x.category === 'Runbooks'));
  check('section 3: standalone window - the document is still created in the chosen category', !!standaloneDoc && standaloneDoc.title === `${TASK_TEXT} before Friday`);
  check('section 3: standalone window - no navigation event, no focus request', H.openEvents.length === openEventsSoFar && H.openDoc.peekPendingEditorFocus() === null);
  check('section 3: standalone window - a notification says where the document went',
    await waitFor(() => H.history.some((n) => n.type === 'success' && n.title === 'Document created' && /Runbooks/.test(n.message))), JSON.stringify(H.history.map((n) => [n.type, n.title, n.message])));
  dom.reconfigure({ url: 'http://localhost/' });
  H.unmount(); await sleep(50);

  // =====================================================================
  // Section 4: the real DocumentEditor honours the focus request
  // =====================================================================
  const ta = () => document.querySelector('textarea');
  // (a) plain document, request armed -> focused, caret at the end, request consumed
  const eA = await H.createDocument({ title: 'From task A', content: 'hello', category: 'Ops' });
  H.openDoc.openDocumentInEditor(eA);
  H.mount('editor', { documentId: eA, document: { id: eA, title: 'From task A', inCloud: false }, content: 'hello' });
  check('section 4: editor with the requested document focuses the body', await waitFor(() => ta() && document.activeElement === ta()));
  check('section 4: ... caret at the end of the body', ta().selectionStart === 5 && ta().selectionEnd === 5, `${ta().selectionStart}`);
  check('section 4: ... and consumes the request', H.openDoc.peekPendingEditorFocus() === null);
  H.unmount(); await sleep(50);

  // (b) the document was left in preview mode and the global "preview all" override is on -> edit mode + focus
  const eB = await H.createDocument({ title: 'From task B', content: '', category: 'Ops' });
  window.sessionStorage.setItem('documentPreviewModes', JSON.stringify({ [eB]: true }));
  window.localStorage.setItem('previewAllDocuments', 'true');
  H.openDoc.openDocumentInEditor(eB);
  H.mount('editor', { documentId: eB, document: { id: eB, title: 'From task B', inCloud: false }, content: '' });
  check('section 4: a document in preview mode (and "preview all" on) drops to edit mode with the body focused', await waitFor(() => ta() && document.activeElement === ta()));
  check('section 4: ... the per-document preview flag is cleared and "preview all" is switched off',
    JSON.parse(window.sessionStorage.getItem('documentPreviewModes'))[eB] === false && window.localStorage.getItem('previewAllDocuments') === 'false');
  H.unmount(); await sleep(50);

  // (c) no request -> the "preview all" override is left alone (the request is scoped to its document)
  const eC = await H.createDocument({ title: 'Untouched C', content: '# c', category: 'Ops' });
  window.localStorage.setItem('previewAllDocuments', 'true');
  H.mount('editor', { documentId: eC, document: { id: eC, title: 'Untouched C', inCloud: false }, content: '# c' });
  await sleep(300);
  check('section 4: a document without a request stays in preview (no textarea, "preview all" untouched)', !ta() && window.localStorage.getItem('previewAllDocuments') === 'true');
  H.unmount(); await sleep(50);
  window.localStorage.setItem('previewAllDocuments', 'false');
  window.sessionStorage.removeItem('documentPreviewModes');

  // =====================================================================
  // Section 5: the real DocumentsPage opens the new document, even with a
  // stale persisted current document (the lazy-mount race)
  // =====================================================================
  const stale = await H.createDocument({ title: 'Yesterday\'s notes', content: 'old', category: 'General' });
  const fresh = await H.createDocument({ title: 'From task D', content: '', category: 'Ops' });
  window.localStorage.setItem('currentDocumentId', JSON.stringify(stale));
  window.localStorage.setItem('documentOpenTabs', JSON.stringify([{ id: stale, title: 'Yesterday\'s notes', category: 'General' }]));
  window.localStorage.setItem('expandedDocumentCategories', JSON.stringify([]));
  H.openDoc.expandDocumentCategoryInSidebar('Ops');
  H.openDoc.openDocumentInEditor(fresh);
  H.opened.length = 0;
  H.mount('documents', { selectedDocumentId: fresh });
  const activeTab = await waitFor(() => Array.from(document.querySelectorAll('div[draggable]')).find((t) => t.className.includes('border-b-os-blue')), 15000);
  check('section 5: DocumentsPage opened the requested document in the active tab', !!activeTab && /From task D/.test(activeTab.textContent) && /Ops/.test(activeTab.textContent), activeTab && activeTab.textContent.trim());
  check('section 5: ... reported it as opened (JQLBuilder clears selectedDocumentId on that)', await waitFor(() => H.opened.includes(fresh)));
  await sleep(500); // let the documents list load settle - the stale restore must NOT win afterwards
  const activeAfter = Array.from(document.querySelectorAll('div[draggable]')).find((t) => t.className.includes('border-b-os-blue'));
  check('section 5: the stale persisted document did not steal the editor after the list loaded', !!activeAfter && /From task D/.test(activeAfter.textContent), activeAfter && activeAfter.textContent.trim());
  check('section 5: the persisted current document is now the new one', window.localStorage.getItem('currentDocumentId') === JSON.stringify(fresh));
  check('section 5: the editor body is mounted (edit mode) and focused', !!ta() && document.activeElement === ta());
  // Sidebar rows carry the title as a tooltip (span[title]); tab labels do not.
  const sidebarRow = document.querySelector('span[title="From task D"]');
  check('section 5: the sidebar lists the document under its (expanded) category', !!sidebarRow);
  check('section 5: ... highlighted as the active document', !!sidebarRow && /text-os-blue/.test(sidebarRow.className), sidebarRow && sidebarRow.className);
  check('section 5: the stale document is still in its tab (nothing lost)', Array.from(document.querySelectorAll('div[draggable]')).some((t) => /Yesterday/.test(t.textContent)));
  H.unmount(); await sleep(50);

  // =====================================================================
  // Section 6: the Documents sidebar's own "Move to Category" still works
  // =====================================================================
  const moves = [];
  const sbDoc = { id: 9001, title: 'Sidebar doc', category: 'Ops', updatedAt: Date.now() };
  const sbCats = ['Runbooks', 'Ops', 'Archive', 'General'];
  window.localStorage.setItem('expandedDocumentCategories', JSON.stringify(sbCats));
  H.mount('sidebar', {
    documents: [sbDoc], categories: sbCats, categoryData: [], currentDocument: null, rightPaneDocument: null,
    onSelectDocument: () => {}, onCreateDocument: () => {}, onRenameCategory: () => {}, onRefreshDocuments: async () => {},
    onUpdateDocumentCategory: async (d, cat) => { moves.push([d.id, cat]); },
  });
  const sbSpan = await waitFor(() => Array.from(document.querySelectorAll('span')).find((s) => s.textContent === 'Sidebar doc'));
  check('section 6: the real DocumentSidebar mounted with the document row', !!sbSpan);
  mouse(sbSpan, 'contextmenu');
  const moveRow = await waitFor(() => Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Move to Category'));
  check('section 6: right-click on the row shows "Move to Category"', !!moveRow);
  mouse(moveRow.parentElement, 'mouseover', { relatedTarget: document.body });
  const sbSub = await waitFor(() => moveRow.parentElement.querySelector('[role="menu"]'));
  const sbEntries = () => Array.from(sbSub?.querySelectorAll('button[role="menuitem"]') || []).map((b) => b.textContent.trim());
  check('section 6: hovering opens the submenu listing every OTHER category in order, plus "Create New"',
    !!sbSub && JSON.stringify(sbEntries()) === JSON.stringify(['Runbooks', 'Archive', 'General', 'Create New']), JSON.stringify(sbEntries()));
  setInput(sbSub.querySelector('input'), 'arch');
  check('section 6: the search box filters', await waitFor(() => JSON.stringify(sbEntries()) === JSON.stringify(['Archive', 'Create New'])));
  Array.from(sbSub.querySelectorAll('button[role="menuitem"]')).find((b) => b.textContent.trim() === 'Archive').click();
  check('section 6: picking a category moves the document and closes the menu', await waitFor(() => moves.length === 1) && moves[0][0] === 9001 && moves[0][1] === 'Archive'
    && await waitFor(() => !Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Move to Category')));
  mouse(sbSpan, 'contextmenu');
  const moveRow2 = await waitFor(() => Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Move to Category'));
  moveRow2.click();
  const sbSub2 = await waitFor(() => moveRow2.parentElement.querySelector('[role="menu"]'));
  setInput(sbSub2.querySelector('input'), 'Incidents');
  Array.from(sbSub2.querySelectorAll('button[role="menuitem"]')).find((b) => b.textContent.trim() === 'Create New').click();
  const newCatInput = await waitFor(() => Array.from(document.querySelectorAll('input')).find((i) => i.value === 'Incidents'));
  check('section 6: "Create New" opens the New Category modal prefilled with the search text', !!newCatInput);
  H.unmount(); await sleep(50);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('Failed:'); for (const f of failed) console.log(`  - ${f.name}`); }
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error('UNEXPECTED ERROR:', err && err.stack || err);
  exitCode = 1;
} finally {
  try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(exitCode);
