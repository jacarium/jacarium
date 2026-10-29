/**
 * Orphaned-tasks banner on the Tasks page.
 *
 * db.tasks is a cache of every TaskWarrior instance's tasks; the Tasks page
 * lists tasks per instance (t.instanceId === instance.id). A row whose
 * instanceId is null/missing, or points at an id with no row in
 * db.taskwarriorInstances, is therefore invisible everywhere and never
 * reaches any CLI. The page now shows the Documents editor's notice strip
 * (shared src/components/common/NoticeBanner.jsx) with
 * "N Tasks in TaskWarrior not belonging to any TaskWarrior instance." and an
 * underlined "Clean it?" action that deletes exactly those rows from the
 * cache (src/utils/tasks.js getOrphanedTasks / deleteOrphanedTasks).
 *
 * Proved here with the REAL TasksPage mounted in jsdom over fake-indexeddb
 * (fetch stubbed to fail and logged by route: no backend, every CLI call is
 * a harmless no-op; the page's own mount-time install check and auto-sync
 * are let settle before the cleanup's no-fetch window opens):
 *   1. helpers: null and dangling instanceIds count, tasks of existing
 *      instances (including one whose data path does not exist - its tasks
 *      are cache-only on purpose) do not; deleteOrphanedTasks removes only
 *      the orphans, returns the count, never touches the purge list or fetch;
 *   2. deleting an instance through deleteInstance() also deletes its tasks
 *      (no orphans); a row whose instance row vanished otherwise is surfaced;
 *   3. the banner: correct plural / singular wording, the shared strip's
 *      classes, an underlined keyboard-focusable text button; clicking it
 *      removes the orphans only, fires no fetch, leaves the purge list alone,
 *      hides the banner and posts "Removed N orphaned tasks"; a double click
 *      runs the cleanup once; no banner at zero;
 *   4. the Documents editor still renders its offline / read-only banners
 *      through the shared component with the original classes and text.
 *
 * Synthetic data only.
 *
 * Run:  node tests/tasks-orphaned-banner.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb
 *   (prints "SKIP:" and exits 0 when the test-only deps are missing)
 * Exit code 0 = all checks passed (or skipped), 1 = failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

function resolvable(name) { try { req.resolve(name); return true; } catch { return false; } }
for (const dep of ['esbuild', 'dexie', 'react', 'react-dom']) {
  if (!resolvable(dep)) { console.error(`Missing dependency "${dep}". Run: npm install`); process.exit(1); }
}
for (const dep of ['fake-indexeddb', 'jsdom']) {
  if (!resolvable(dep)) { console.log(`SKIP: test-only dependency "${dep}" not installed (npm install --no-save jsdom fake-indexeddb)`); process.exit(0); }
}

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-orphaned-banner-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The app's own console chatter is filtered below; the test's result lines
// always go through the unfiltered console so a failing check is never
// swallowed by that filter (a "✗ no backend ..." line once was).
const report = console.log;
let failures = 0;
let total = 0;
function check(name, cond, detail = '') {
  total += 1;
  if (cond) report(`  ✓ ${name}`);
  else { failures += 1; report(`  ✗ ${name}${detail ? ` -- ${detail}` : ''}`); }
}
async function waitFor(fn, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(25);
  }
}

// ---------- source-level: the Documents editor uses the shared strip ----------
report('\n--- 0. source: shared NoticeBanner ---');
const editorSrc = fs.readFileSync(path.join(REPO, 'src/components/features/documents/DocumentEditor.jsx'), 'utf8');
const tasksSrc = fs.readFileSync(path.join(REPO, 'src/components/TasksPage.jsx'), 'utf8');
check('DocumentEditor renders its four notices (offline, read-only, server copy, sync) through NoticeBanner (no copied strip markup left)',
  /import NoticeBanner, \{ NoticeBannerAction \} from '\.\.\/\.\.\/common\/NoticeBanner'/.test(editorSrc) &&
  (editorSrc.match(/<NoticeBanner /g) || []).length === 4 &&
  !/px-4 py-2 bg-(purple|orange|amber)-50 dark:bg-\1-900\/20 text-\1-700/.test(editorSrc));
check('TasksPage renders the orphan banner through the same NoticeBanner + NoticeBannerAction',
  /import NoticeBanner, \{ NoticeBannerAction \} from '\.\/common\/NoticeBanner'/.test(tasksSrc) &&
  /<NoticeBanner tone="warning" testId="orphaned-tasks-banner"/.test(tasksSrc) && /<NoticeBannerAction /.test(tasksSrc));

// ---------- bundle ----------
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import TasksPage from '@worktree/src/components/TasksPage.jsx';
import DocumentEditor from '@worktree/src/components/features/documents/DocumentEditor.jsx';
import NoticeBanner, { NoticeBannerAction } from '@worktree/src/components/common/NoticeBanner.jsx';
import { NotificationProvider, useNotifications } from '@worktree/src/contexts/NotificationContext.jsx';
import { db } from '@worktree/src/db/database.js';
import { createTask, getTasks, getOrphanedTasks, deleteOrphanedTasks, describeOrphanedTasks, getPurgedTaskUUIDs, addPurgedTaskUUIDs } from '@worktree/src/utils/tasks.js';
import { createInstance, deleteInstance, getAllInstances } from '@worktree/src/utils/taskwarriorInstances.js';

const api = { db, createTask, getTasks, getOrphanedTasks, deleteOrphanedTasks, describeOrphanedTasks, getPurgedTaskUUIDs, addPurgedTaskUUIDs, createInstance, deleteInstance, getAllInstances, history: [] };
let setView = null;
let key = 0;
function Probe() { const { history } = useNotifications(); api.history = history; return null; }
function Host() {
  const [view, set] = React.useState(null);
  setView = set;
  if (!view) return null;
  if (view.kind === 'tasks') return React.createElement(TasksPage, { key: view.key });
  if (view.kind === 'editor') return React.createElement(DocumentEditor, { key: view.key, templates: [], locked: false, onContentChange: () => {}, ...view.props });
  if (view.kind === 'banner') return React.createElement(NoticeBanner, { key: view.key, tone: view.props.tone, title: view.props.title, testId: 'probe-banner' },
    React.createElement('span', null, view.props.text), React.createElement(NoticeBannerAction, { testId: 'probe-action', onClick: () => {} }, 'Act'));
  return null;
}
api.mount = (kind, props = {}) => setView({ kind, props, key: ++key });
api.unmount = () => setView(null);
window.__harness = api;
createRoot(document.getElementById('root')).render(React.createElement(NotificationProvider, null, React.createElement(Probe), React.createElement(Host)));
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
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

// ---------- jsdom + fake IndexedDB ----------
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
// No backend: every CLI/backend call fails fast; we log each attempt with
// its route so a call can be attributed (the page's mount-time
// initialisation legitimately tries /api/taskwarrior/check and the active
// instance's /api/taskwarrior/export; the cleanup must try nothing).
const fetchLog = [];
const failingFetch = (url, options = {}) => {
  fetchLog.push(`${options.method || 'GET'} ${String(url)}`);
  return Promise.reject(new Error('no backend in test'));
};
define('fetch', failingFetch); window.fetch = failingFetch;
const origLog = console.log; const origErr = console.error; const origWarn = console.warn;
const quiet = (fn) => (...a) => { const s = String(a[0] ?? ''); if (/^\[|Warning:|act\(|Dexie|Error|no backend/.test(s)) return; fn(...a); };
console.log = quiet(origLog); console.error = quiet(origErr); console.warn = quiet(origWarn);

createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const H = window.__harness;
await waitFor(() => H.mount);
const banner = () => document.querySelector('[data-testid="orphaned-tasks-banner"]');
const cleanBtn = () => document.querySelector('[data-testid="orphaned-tasks-clean"]');
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const now = new Date().toISOString();

/* ================================================================== */
report('\n--- 1. helpers: what counts as orphaned ---');
/* ================================================================== */
const alpha = await H.createInstance({ name: 'Alpha Lab', category: 'General', isActive: 1, dataPath: '/tmp/synthetic-alpha' });
const needsPath = await H.createInstance({ name: 'Needs Path', category: 'General', dataPath: '/home/other/.task-missing' });
const a1 = await H.createTask({ description: 'Alpha task one', status: 'pending', instanceId: alpha.id, entry: now, modified: now });
const a2 = await H.createTask({ description: 'Alpha task two', status: 'completed', instanceId: alpha.id, entry: now, modified: now });
const np1 = await H.createTask({ description: 'Cache-only task of the needs-a-data-path instance', status: 'pending', instanceId: needsPath.id, entry: now, modified: now });
const o1 = await H.createTask({ description: 'No instance at all', status: 'pending', instanceId: null, entry: now, modified: now });
const o2 = await H.createTask({ description: 'Dangling instance id', status: 'pending', instanceId: 999, entry: now, modified: now });
const o3 = await H.createTask({ description: 'Missing instanceId field', status: 'deleted', entry: now, modified: now });
H.addPurgedTaskUUIDs(['aaaaaaaa-0000-4000-8000-000000000099']);
const purgedBefore = JSON.stringify(H.getPurgedTaskUUIDs());
check('describeOrphanedTasks: plural and singular wording',
  H.describeOrphanedTasks(3) === '3 Tasks in TaskWarrior not belonging to any TaskWarrior instance.' &&
  H.describeOrphanedTasks(1) === '1 Task in TaskWarrior not belonging to any TaskWarrior instance.');
const orphans = await H.getOrphanedTasks();
check('getOrphanedTasks: null, missing and dangling instanceIds count (3); tasks of existing instances do not (incl. the needs-a-data-path one)',
  orphans.map((t) => t.id).sort().join() === [o1, o2, o3].sort().join(), JSON.stringify(orphans.map((t) => [t.id, t.instanceId])));

/* ================================================================== */
report('\n--- 2. instance deletion today ---');
/* ================================================================== */
const gone = await H.createInstance({ name: 'Doomed', category: 'General' });
const g1 = await H.createTask({ description: 'Doomed task', status: 'pending', instanceId: gone.id, entry: now, modified: now });
await H.deleteInstance(gone.id);
check('deleteInstance() removes the instance AND its cached tasks (no orphan left behind)',
  (await H.db.tasks.get(g1)) === undefined && !(await H.getAllInstances()).some((i) => i.id === gone.id) && (await H.getOrphanedTasks()).length === 3);
const ghost = await H.createInstance({ name: 'Ghost', category: 'General' });
const gh1 = await H.createTask({ description: 'Left behind', status: 'pending', instanceId: ghost.id, entry: now, modified: now });
await H.db.taskwarriorInstances.delete(ghost.id); // the instance row vanishes without deleteInstance (e.g. a replace import that dropped it)
check('a task whose instance row disappeared some other way IS surfaced as orphaned (4 now)',
  (await H.getOrphanedTasks()).some((t) => t.id === gh1) && (await H.getOrphanedTasks()).length === 4);

/* ================================================================== */
report('\n--- 3. the banner on the real Tasks page ---');
/* ================================================================== */
H.mount('tasks');
let b = await waitFor(banner, 15000);
check('banner shows with the plural wording and the count across ALL instances',
  !!b && b.textContent.includes('4 Tasks in TaskWarrior not belonging to any TaskWarrior instance.'), b?.textContent);
check('it is the shared Documents notice strip (same tinted classes, icon, role=status)',
  !!b && b.getAttribute('role') === 'status' && b.dataset.tone === 'warning' &&
  ['px-4', 'py-2', 'bg-amber-50', 'dark:bg-amber-900/20', 'text-amber-700', 'dark:text-amber-200', 'text-sm', 'flex', 'items-center', 'gap-2'].every((c) => b.classList.contains(c)) &&
  !!b.querySelector('svg path'), b?.className);
let btn = cleanBtn();
check('"Clean it?" is an underlined text-style button (no box), keyboard focusable, with a visible focus style',
  !!btn && btn.tagName === 'BUTTON' && btn.getAttribute('type') === 'button' && btn.textContent.trim() === 'Clean it?' &&
  btn.classList.contains('underline') && btn.classList.contains('focus-visible:ring-2') && !btn.className.includes('border') &&
  !btn.className.includes('bg-') && btn.tabIndex === 0, btn?.className);
btn.focus();
check('the button takes keyboard focus', document.activeElement === btn);

// The banner shows as soon as the instances are loaded, while the page's
// mount-time initialisation is still running: the install check and the
// active instance's auto-sync from the CLI both hit the (failing) backend
// after that. Let that finish - both routes attempted, the page's loading
// and syncing spinners gone - before opening the counting window, so the
// window holds only what the cleanup itself does.
const mountRoutes = ['/api/taskwarrior/check', '/api/taskwarrior/export'];
const settled = await waitFor(() => (mountRoutes.every((r) => fetchLog.some((l) => l.includes(r))) && !document.querySelector('.animate-spin') ? true : null), 15000);
check('the page\'s own mount-time initialisation tried the backend (install check + active-instance auto-sync) and settled',
  settled === true, JSON.stringify(fetchLog));

const tasksBefore = await H.getTasks();
const fetchBefore = fetchLog.length;
const historyBefore = H.history.length;
// Double click: two clicks before any render commits.
click(btn);
click(btn);
const hidden = await waitFor(async () => (!banner() ? true : null), 8000);
check('after clicking, the banner disappears', hidden === true);
const tasksAfter = await H.getTasks();
check('only the 4 orphans were deleted; the tasks of Alpha Lab and the needs-a-data-path instance are intact',
  tasksAfter.length === tasksBefore.length - 4 && [a1, a2, np1].every((id) => tasksAfter.some((t) => t.id === id)) &&
  ![o1, o2, o3, gh1].some((id) => tasksAfter.some((t) => t.id === id)), JSON.stringify(tasksAfter.map((t) => t.id)));
check('no backend / TaskWarrior CLI call was made by the cleanup', fetchLog.length === fetchBefore, `fetch during the cleanup: ${JSON.stringify(fetchLog.slice(fetchBefore))}`);
check('the purge list is untouched (these are not TaskWarrior deletions)', JSON.stringify(H.getPurgedTaskUUIDs()) === purgedBefore);
await sleep(100);
const successes = H.history.slice(0, H.history.length - historyBefore).filter((n) => /Removed \d+ orphaned task/.test(n.message || ''));
check('one success notification "Removed 4 orphaned tasks" (the double click ran the cleanup once)',
  successes.length === 1 && successes[0].message === 'Removed 4 orphaned tasks' && successes[0].type === 'success',
  JSON.stringify(H.history.slice(0, 3).map((n) => [n.type, n.message])));
check('no banner while there are no orphans', !banner());

// Singular wording + banner refresh on load
H.unmount();
await sleep(50);
await H.createTask({ description: 'Single orphan', status: 'pending', instanceId: 4242, entry: now, modified: now });
H.mount('tasks');
b = await waitFor(banner, 15000);
check('one orphan: "1 Task in TaskWarrior not belonging to any TaskWarrior instance."',
  !!b && b.textContent.includes('1 Task in TaskWarrior not belonging to any TaskWarrior instance.') && !b.textContent.includes('1 Tasks'), b?.textContent);
click(cleanBtn());
await waitFor(async () => (!banner() ? true : null), 8000);
check('cleaned again: "Removed 1 orphaned task" (singular) and the banner is gone',
  !banner() && H.history.some((n) => n.message === 'Removed 1 orphaned task'));
H.unmount();

/* ================================================================== */
report('\n--- 4. the Documents editor banners still render through the shared strip ---');
/* ================================================================== */
H.mount('banner', { tone: 'readonly', title: 'Read-only:', text: 'This document is shared by another team member. You can view but not edit.' });
const probe = await waitFor(() => document.querySelector('[data-testid="probe-banner"]'));
check('NoticeBanner readonly tone = the original read-only banner classes, bold lead-in, message, and the action button',
  !!probe && ['px-4', 'py-2', 'bg-purple-50', 'dark:bg-purple-900/20', 'text-purple-700', 'dark:text-purple-200', 'text-sm', 'flex', 'items-center', 'gap-2'].every((c) => probe.classList.contains(c)) &&
  probe.querySelector('span.font-medium')?.textContent === 'Read-only:' && probe.textContent.includes('shared by another team member') &&
  probe.querySelector('[data-testid="probe-action"]')?.classList.contains('underline'), probe?.className);
H.mount('editor', { document: { id: 1, title: 'Synthetic cloud doc', content: 'body', category: 'General', inCloud: true, ownerId: 'someone-else@machine', updatedAt: Date.now() }, isOnline: false });
const offline = await waitFor(() => document.querySelector('[data-testid="document-offline-banner"]'), 15000);
check('DocumentEditor: the offline read-only banner renders via NoticeBanner with its original text and orange classes',
  !!offline && offline.textContent.includes('Offline - Read Only') && offline.textContent.includes('Shared documents require an online connection for editing') &&
  offline.classList.contains('bg-orange-50') && offline.classList.contains('dark:text-orange-200'), offline?.className);
H.unmount();

report(`\n${total - failures}/${total} checks passed`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
