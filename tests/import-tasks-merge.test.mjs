/**
 * Regression test for "the dry run said one task would be added, but the
 * Tasks page shows the same tasks as before" after a database import.
 *
 * Root causes (all in src/utils/importDatabase.js, proved here against the
 * REAL importDatabase.js + src/db/database.js + src/utils/tasks.js +
 * src/utils/taskwarriorInstances.js on real Dexie over fake-indexeddb; the
 * TaskWarrior backend HTTP API is the only thing stubbed):
 *
 *   1. Deleting a task on the Tasks page hard-deletes its row (deleteTask(id,
 *      true)) and records the uuid in the local purge list. A file exported
 *      before that deletion still holds the task; the merge found no local
 *      row for the uuid and counted it as "created", resurrecting a task the
 *      user had deleted - as pending, straight from the file. The purge list
 *      is the local tombstone and now wins: the task is reported as
 *      "skipped (deleted here)" (summary.tasks.purgedHere), not as an addition.
 *   2. Tasks kept the export file's instanceId while instances are matched
 *      by NAME (merge) or recreated with fresh auto-increment ids (replace),
 *      so an imported task could point at an instance id that exists only on
 *      the exporting machine. The Tasks page lists tasks by instanceId, so
 *      the row existed but was never shown. Both paths now remap instanceId.
 *   3. Replace mode wiped tasks through deleteTask(id, true), adding every
 *      pre-existing uuid to the purge list, after which syncFromTaskWarrior
 *      ignored the CLI's copy of those tasks forever.
 *   4. New tasks whose status is deleted/completed were reported like any
 *      other addition although they never appear among the pending tasks (and
 *      a deleted task the CLI no longer has is removed again by the sync that
 *      runs when the Tasks page opens). The tasks summary now labels them
 *      "(deleted)" / "(completed)" and carries a note the modal renders.
 *
 * Fixture data is synthetic throughout.
 *
 * Run:  node tests/import-tasks-merge.test.mjs
 * Preconditions:
 *   - repo deps installed (esbuild, dexie, react):  npm install  -> exit 1 if missing
 *   - test-only deps (not in package.json):  npm install --no-save jsdom fake-indexeddb
 *     -> prints "SKIP:" and exits 0 if missing (tests/run-all.sh installs them)
 * Exit code 0 = all checks passed (or skipped), 1 = failure (details on stdout).
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
function resolvable(name) {
  try { req.resolve(name); return true; } catch { return false; }
}
for (const dep of ['esbuild', 'dexie', 'react', 'react-dom']) {
  if (!resolvable(dep)) {
    console.error(`Missing dependency "${dep}". Run: npm install`);
    process.exit(1);
  }
}
for (const dep of ['fake-indexeddb', 'jsdom']) {
  if (!resolvable(dep)) {
    console.log(`SKIP: test-only dependency "${dep}" not installed (npm install --no-save jsdom fake-indexeddb)`);
    process.exit(0);
  }
}

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'import-tasks-merge-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let total = 0;
function check(name, cond, detail = '') {
  total += 1;
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

// ---------- environment: fake IndexedDB + localStorage stub + TW backend stub ----------
const lsStore = new Map([
  ['db_migration_complete', 'true'],
  ['workflows_migration_complete', 'true'],
  ['env_vars_migration_complete', 'true'],
]);
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
  key: (i) => Array.from(lsStore.keys())[i] ?? null,
  get length() { return lsStore.size; },
};
// tasks.js -> backendUrl.js reads window.electronAPI to pick the backend URL.
globalThis.window = globalThis;
await import(req.resolve('fake-indexeddb/auto'));

// Stand-in for the Flask /api/taskwarrior/* routes: `twTasks` is what the
// TaskWarrior CLI would return from `task export` (status.any). Only the
// endpoints tasks.js hits in this test are modelled.
let twTasks = [];
const okJson = (payload) => ({ ok: true, status: 200, statusText: 'OK', json: async () => payload });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (u.endsWith('/api/taskwarrior/export')) return okJson(twTasks);
  if (u.endsWith('/api/taskwarrior/delete')) {
    twTasks = twTasks.map((t) => (t.uuid === body.uuid ? { ...t, status: 'deleted', end: new Date().toISOString() } : t));
    return okJson({ success: true });
  }
  if (u.endsWith('/api/taskwarrior/purge')) {
    twTasks = twTasks.filter((t) => t.uuid !== body.uuid);
    return okJson({ success: true });
  }
  if (u.endsWith('/api/taskwarrior/import')) return okJson({ success: true, count: body.tasks.length });
  throw new Error(`unexpected backend call in test: ${u}`);
};

// ---------- bundle the real modules under test ----------
const { build } = await import(req.resolve('esbuild'));
const DB_ENTRY = path.join(WORKDIR, 'db-entry.mjs');
const DB_BUNDLE = path.join(WORKDIR, 'db-bundle.cjs');
fs.writeFileSync(DB_ENTRY, [
  `export * from ${JSON.stringify(path.join(REPO, 'src/utils/importDatabase.js'))};`,
  `export { db } from ${JSON.stringify(path.join(REPO, 'src/db/database.js'))};`,
  `export { createTask, getTasks, deleteTask, deleteTaskWarriorTask, syncFromTaskWarrior, getPurgedTaskUUIDs } from ${JSON.stringify(path.join(REPO, 'src/utils/tasks.js'))};`,
  `export { createInstance, getAllInstances, getInstanceTasks } from ${JSON.stringify(path.join(REPO, 'src/utils/taskwarriorInstances.js'))};`,
].join('\n'));
await build({
  entryPoints: [DB_ENTRY],
  bundle: true,
  outfile: DB_BUNDLE,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const {
  runImport, db,
  createTask, getTasks, deleteTask, deleteTaskWarriorTask, syncFromTaskWarrior, getPurgedTaskUUIDs,
  createInstance, getAllInstances, getInstanceTasks,
} = req(DB_BUNDLE);

// Quiet the helpers' progress logging so the check lines stay readable.
const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[')) return;
  realLog(...args);
};
const realError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[')) return;
  realError(...args);
};

// Minimal valid import file skeleton (the modal requires these arrays).
function baseImport(overrides = {}) {
  return {
    version: '1.0',
    documents: [],
    documentTemplates: [],
    jqlTemplates: [],
    engineTemplates: [],
    ...overrides,
  };
}

// What exportDatabase() writes for tasks/instances: the rows verbatim
// (getTasks() / getAllInstances()), JSON round-tripped.
async function snapshotExport() {
  return JSON.parse(JSON.stringify(baseImport({
    tasks: await getTasks(),
    taskwarriorInstances: await getAllInstances(),
  })));
}

// What the Tasks page shows for an instance: TasksPage.loadTasks filters
// getTasks() by `t.instanceId === instance.id`; getInstanceTasks() is the
// indexed equivalent. Both are checked so the two lookups cannot drift.
async function visibleOnTasksPage(instance) {
  const viaFilter = (await getTasks()).filter((t) => t.instanceId === instance.id);
  const viaIndex = await getInstanceTasks(instance.id);
  const key = (rows) => rows.map((t) => t.uuid).sort().join(',');
  if (key(viaFilter) !== key(viaIndex)) throw new Error('loadTasks filter and getInstanceTasks disagree');
  return viaFilter;
}

const uuidsOf = (rows) => rows.map((t) => t.uuid).sort();
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

/* ================================================================== */
console.log('\n--- 1. the reported bug: a task deleted on the Tasks page is in an older export ---');
/* ================================================================== */
await db.tasks.clear();
await db.taskwarriorInstances.clear();
lsStore.delete('taskwarrior_purged_uuids');

const work = await createInstance({ name: 'Work', dataPath: '/tmp/synthetic-work', isActive: 1 });
const keepId = await createTask({ description: 'Keep me', instanceId: work.id, status: 'pending' });
const deleteMeId = await createTask({ description: 'Delete me', instanceId: work.id, status: 'pending' });
const keep = await db.tasks.get(keepId);
const deleteMe = await db.tasks.get(deleteMeId);
// The CLI holds the same two tasks (created through the app, synced to it).
twTasks = [keep, deleteMe].map((t) => ({ ...t, id: undefined }));

const exportBeforeDelete = await snapshotExport();
check('precondition: the export made before the deletion contains both tasks with their instanceId',
  exportBeforeDelete.tasks.length === 2 && exportBeforeDelete.tasks.every((t) => t.instanceId === work.id) &&
  exportBeforeDelete.taskwarriorInstances[0]?.id === work.id);

// Delete "Delete me" exactly the way TasksPage.handleDeleteTask does for a
// pending task: `task delete` in the CLI (soft delete there), then a HARD
// local delete that records the uuid in the purge list.
const twDelete = await deleteTaskWarriorTask(deleteMe, null, work.dataPath);
await deleteTask(deleteMeId, true);
check('precondition: Tasks-page delete = CLI soft delete + local hard delete + uuid on the purge list',
  twDelete.success && twTasks.find((t) => t.uuid === deleteMe.uuid)?.status === 'deleted' &&
  (await db.tasks.get(deleteMeId)) === undefined && getPurgedTaskUUIDs().includes(deleteMe.uuid));
const visibleBefore = uuidsOf(await visibleOnTasksPage(work));
check('precondition: the Tasks page shows only "Keep me"', visibleBefore.join() === keep.uuid);

const dry = await runImport(exportBeforeDelete, true, { dryRun: true });
check('dry run does NOT count the deleted task as an addition (0 new)',
  dry.summary.tasks.created === 0, JSON.stringify(dry.summary.tasks));
check('dry run reports it instead as skipped because it was deleted here, naming the task',
  dry.summary.tasks.purgedHere === 1 && dry.summary.tasks.samples.purgedHere[0] === 'Delete me' &&
  dry.summary.tasks.invalid === 0 && dry.summary.tasks.via === 'db',
  JSON.stringify(dry.summary.tasks));
check('dry run: "Keep me" is matched (unchanged), the purged one counted under skipped, nothing written',
  dry.summary.tasks.skipped === 2 && (await db.tasks.count()) === 1 && dry.totals.created === 0,
  JSON.stringify(dry.totals));

const real = await runImport(exportBeforeDelete, true, { dryRun: false });
check('real merge: identical statistics to the dry run',
  JSON.stringify(real.summary.tasks) === JSON.stringify(dry.summary.tasks),
  JSON.stringify({ dry: dry.summary.tasks, real: real.summary.tasks }));
check('real merge: the deleted task is not resurrected (no row for its uuid)',
  (await db.tasks.where('uuid').equals(deleteMe.uuid).count()) === 0);
check('the Tasks page shows exactly what the statistics promised: same tasks as before',
  uuidsOf(await visibleOnTasksPage(work)).join() === visibleBefore.join());

// The Tasks page auto-syncs from the CLI when it opens; the CLI still has
// the task as `deleted` but it is purge-listed, so it must stay gone.
const sync = await syncFromTaskWarrior(work.id, null, work.dataPath);
check('sync from the CLI after the import keeps the deleted task gone and "Keep me" visible',
  sync.success && uuidsOf(await visibleOnTasksPage(work)).join() === keep.uuid, JSON.stringify(sync));

/* ================================================================== */
console.log('\n--- 2. deleted/completed tasks from ANOTHER machine: created, but reported as such ---');
/* ================================================================== */
const foreignDeleted = { uuid: 'aaaaaaaa-0000-4000-8000-000000000001', description: 'Other machine deleted', status: 'deleted', instanceId: work.id, entry: iso(-7200e3), modified: iso(-3600e3), end: iso(-3600e3), tags: [], annotations: [], depends: [] };
const foreignDone = { uuid: 'aaaaaaaa-0000-4000-8000-000000000002', description: 'Other machine done', status: 'completed', instanceId: work.id, entry: iso(-7200e3), modified: iso(-3600e3), end: iso(-3600e3), tags: [], annotations: [], depends: [] };
const foreignPending = { uuid: 'aaaaaaaa-0000-4000-8000-000000000003', description: 'Other machine pending', status: 'pending', instanceId: work.id, entry: iso(-7200e3), modified: iso(-3600e3), tags: [], annotations: [], depends: [] };
const foreignFile = baseImport({
  taskwarriorInstances: exportBeforeDelete.taskwarriorInstances,
  tasks: [foreignDeleted, foreignDone, foreignPending],
});
const dry2 = await runImport(foreignFile, true, { dryRun: true });
check('dry run: 3 new tasks, the non-pending ones labelled with their status in the samples',
  dry2.summary.tasks.created === 3 &&
  dry2.summary.tasks.samples.created.includes('Other machine deleted (deleted)') &&
  dry2.summary.tasks.samples.created.includes('Other machine done (completed)') &&
  dry2.summary.tasks.samples.created.includes('Other machine pending'),
  JSON.stringify(dry2.summary.tasks.samples));
check('dry run: createdByStatus breaks the additions down and the note says they are not pending',
  JSON.stringify(dry2.summary.tasks.createdByStatus) === JSON.stringify({ deleted: 1, completed: 1, pending: 1 }) &&
  /1 deleted, 1 completed of the new tasks are not pending/.test(dry2.summary.tasks.note || '') &&
  /dropped again on the next sync/.test(dry2.summary.tasks.note || ''),
  JSON.stringify({ by: dry2.summary.tasks.createdByStatus, note: dry2.summary.tasks.note }));
check('dry run: a file with only pending additions carries no note',
  !(await runImport(baseImport({ tasks: [foreignPending] }), true, { dryRun: true })).summary.tasks.note);

const real2 = await runImport(foreignFile, true, { dryRun: false });
check('real merge: rows created with their file status; only the pending one joins the pending list',
  real2.summary.tasks.created === 3 &&
  (await db.tasks.where('uuid').equals(foreignDeleted.uuid).first())?.status === 'deleted' &&
  (await visibleOnTasksPage(work)).filter((t) => t.status === 'pending').length === 2);
// The CLI on this machine has never seen the foreign deleted task: the
// Tasks page's open-time sync drops it again (tasks.js orphan cleanup).
const sync2 = await syncFromTaskWarrior(work.id, null, work.dataPath);
check('after the open-time CLI sync the imported deleted task is gone again (as the note warns), the others stay',
  sync2.success &&
  (await db.tasks.where('uuid').equals(foreignDeleted.uuid).count()) === 0 &&
  (await db.tasks.where('uuid').equals(foreignDone.uuid).count()) === 1 &&
  (await db.tasks.where('uuid').equals(foreignPending.uuid).count()) === 1);

// Tombstone vs live copy of the SAME uuid: decided by `modified`.
const keepNow = await db.tasks.get(keepId);
const olderTombstone = baseImport({ tasks: [{ ...keepNow, id: 900, status: 'deleted', modified: iso(-86400e3) }] });
const r3 = await runImport(olderTombstone, true, { dryRun: false });
check('an OLDER deleted copy in the file does not overwrite the live local task',
  r3.summary.tasks.updated === 0 && (await db.tasks.get(keepId)).status === 'pending', JSON.stringify(r3.summary.tasks));
const newerTombstone = baseImport({ tasks: [{ ...keepNow, id: 900, status: 'deleted', end: iso(60e3), modified: iso(60e3) }] });
const r4 = await runImport(newerTombstone, true, { dryRun: false });
check('a NEWER deleted copy in the file marks the live local task deleted (tombstone wins by modified)',
  r4.summary.tasks.updated === 1 && (await db.tasks.get(keepId)).status === 'deleted', JSON.stringify(r4.summary.tasks));
await db.tasks.update(keepId, { status: 'pending', end: null, modified: keepNow.modified });

/* ================================================================== */
console.log('\n--- 3. merge: instanceId is remapped to the local instance of the same name ---');
/* ================================================================== */
const crossMachine = baseImport({
  taskwarriorInstances: [
    { id: 7, name: 'Work', category: 'General', description: '', rcPath: '/home/other/.taskrc', dataPath: '/home/other/.task', isActive: 1, createdAt: iso(-9e6), updatedAt: iso(-9e6) },
    { id: 9, name: 'Home', category: 'General', description: '', rcPath: '', dataPath: '/home/other/.task-home', isActive: 0, createdAt: iso(-9e6), updatedAt: iso(-9e6) },
  ],
  tasks: [
    { uuid: 'bbbbbbbb-0000-4000-8000-000000000001', description: 'Remote work task', status: 'pending', instanceId: 7, entry: iso(-3600e3), modified: iso(-3600e3), tags: [], annotations: [], depends: [] },
    { uuid: 'bbbbbbbb-0000-4000-8000-000000000002', description: 'Remote home task', status: 'pending', instanceId: 9, entry: iso(-3600e3), modified: iso(-3600e3), tags: [], annotations: [], depends: [] },
    { uuid: 'bbbbbbbb-0000-4000-8000-000000000003', description: 'Instance not in file', status: 'pending', instanceId: 42, entry: iso(-3600e3), modified: iso(-3600e3), tags: [], annotations: [], depends: [] },
  ],
});
const tasksBefore3 = await db.tasks.count();
const dry3 = await runImport(crossMachine, true, { dryRun: true });
check('dry run: 1 new instance (Home), Work matched; 3 new tasks; nothing written',
  dry3.summary.taskwarriorInstances.created === 1 && dry3.summary.taskwarriorInstances.created + dry3.summary.taskwarriorInstances.skipped + dry3.summary.taskwarriorInstances.filled === 2 &&
  dry3.summary.tasks.created === 3 && (await db.tasks.count()) === tasksBefore3 && (await db.taskwarriorInstances.count()) === 1,
  JSON.stringify({ i: dry3.summary.taskwarriorInstances, t: dry3.summary.tasks }));
const real3 = await runImport(crossMachine, true, { dryRun: false });
const home = (await getAllInstances()).find((i) => i.name === 'Home');
const remoteWork = await db.tasks.where('uuid').equals('bbbbbbbb-0000-4000-8000-000000000001').first();
const remoteHome = await db.tasks.where('uuid').equals('bbbbbbbb-0000-4000-8000-000000000002').first();
const unmapped = await db.tasks.where('uuid').equals('bbbbbbbb-0000-4000-8000-000000000003').first();
check('real merge: same counts as the dry run',
  real3.summary.tasks.created === 3 && real3.summary.taskwarriorInstances.created === 1);
check('the task of the file\'s instance 7 ("Work") now points at the LOCAL Work instance and is visible there',
  remoteWork?.instanceId === work.id && (await visibleOnTasksPage(work)).some((t) => t.uuid === remoteWork.uuid),
  JSON.stringify({ got: remoteWork?.instanceId, want: work.id }));
check('the task of the file\'s new instance 9 ("Home") points at the newly created local Home instance',
  !!home && home.id !== 9 && remoteHome?.instanceId === home.id && (await visibleOnTasksPage(home)).length === 1,
  JSON.stringify({ home: home?.id, got: remoteHome?.instanceId }));
check('a merge-created instance comes in inactive (isActive is machine-local)', home?.isActive === 0);
check('a task whose instance is not in the file keeps its instanceId as-is (legacy files)', unmapped?.instanceId === 42);
check('no imported task is left pointing at the file\'s instance ids',
  (await db.tasks.toArray()).every((t) => t.instanceId !== 7 && t.instanceId !== 9));

/* ================================================================== */
console.log('\n--- 4. replace mode: same-machine round trip keeps tasks attached; no purge-list pollution ---');
/* ================================================================== */
await db.tasks.clear();
await db.taskwarriorInstances.clear();
lsStore.delete('taskwarrior_purged_uuids');
const work2 = await createInstance({ name: 'Work', dataPath: '/tmp/synthetic-work', isActive: 1 });
const rtId = await createTask({ description: 'Round trip', instanceId: work2.id, status: 'pending' });
const rt = await db.tasks.get(rtId);
const roundTrip = await snapshotExport();
const dry4 = await runImport(roundTrip, false, { dryRun: true });
check('replace dry run: 1 instance and 1 task deleted + recreated, nothing written',
  dry4.summary.tasks.deleted === 1 && dry4.summary.tasks.created === 1 &&
  dry4.summary.taskwarriorInstances.deleted === 1 && dry4.summary.taskwarriorInstances.created === 1 &&
  (await db.tasks.get(rtId))?.uuid === rt.uuid, JSON.stringify(dry4.summary.tasks));
const real4 = await runImport(roundTrip, false, { dryRun: false });
const work3 = (await getAllInstances()).find((i) => i.name === 'Work');
const rtAfter = await db.tasks.where('uuid').equals(rt.uuid).first();
check('replace real run: summary identical to the plan',
  JSON.stringify(real4.summary.tasks) === JSON.stringify(dry4.summary.tasks) &&
  JSON.stringify(real4.summary.taskwarriorInstances) === JSON.stringify(dry4.summary.taskwarriorInstances));
check('the recreated instance has a NEW auto-increment id (IndexedDB never reuses keys)',
  !!work3 && work3.id !== work2.id, JSON.stringify({ before: work2.id, after: work3?.id }));
check('the recreated task points at the recreated instance and is visible on the Tasks page',
  rtAfter?.instanceId === work3?.id && uuidsOf(await visibleOnTasksPage(work3)).join() === rt.uuid,
  JSON.stringify({ got: rtAfter?.instanceId, want: work3?.id }));
check('wiping the old rows did not put their uuids on the purge list',
  !getPurgedTaskUUIDs().includes(rt.uuid), JSON.stringify(getPurgedTaskUUIDs()));

/* ================================================================== */
console.log('\n--- 5. UI: the statistics panel shows the status labels and the note ---');
/* ================================================================== */
const UI_ENTRY = path.join(WORKDIR, 'ui-entry.jsx');
const UI_BUNDLE = path.join(WORKDIR, 'ui-bundle.cjs');
fs.writeFileSync(UI_ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ImportDBModal from '@worktree/src/components/common/modals/ImportDBModal.jsx';

const fakeResult = (mode, dryRun) => ({
  mode, dryRun,
  summary: {
    tasks: { created: 2, updated: 0, filled: 0, skipped: 2, deleted: 0, invalid: 0, errors: [],
      samples: { created: ['Other machine deleted (deleted)', 'Other machine pending'], updated: [], filled: [], tombstoned: [], purgedHere: ['Delete me'] },
      via: 'db', purgedHere: 1, tombstoned: 0,
      createdByStatus: { deleted: 1, pending: 1 },
      note: '1 deleted of the new tasks is not pending (Completed/Deleted sections only); a deleted task the TaskWarrior CLI no longer has is dropped again on the next sync' },
  },
  totals: { created: 2, updated: 0, filled: 0, skipped: 2, deleted: 0, invalid: 0 },
});
createRoot(document.getElementById('root')).render(
  <ImportDBModal
    isOpen={true}
    onClose={() => {}}
    onImport={async (data, mergeMode) => fakeResult(mergeMode ? 'merge' : 'replace', false)}
    onDryRun={async (data, mergeMode) => fakeResult(mergeMode ? 'merge' : 'replace', true)}
  />
);
`);
await build({
  entryPoints: [UI_ENTRY],
  bundle: true,
  outfile: UI_BUNDLE,
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
  logLevel: 'silent',
});

const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node',
  'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'File', 'FileReader']) {
  define(name, window[name]);
}
define('getComputedStyle', window.getComputedStyle.bind(window));
define('localStorage', window.localStorage);
define('sessionStorage', window.sessionStorage);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));

createRequire(import.meta.url)(UI_BUNDLE);
await sleep(100);

const doc = window.document;
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const buttonByText = (text) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const fileInput = doc.querySelector('input[type="file"]');
const file = new window.File([JSON.stringify(baseImport({ tasks: [foreignPending] }))], 'export.json', { type: 'application/json' });
Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(150);
click(doc.querySelector('input[type="checkbox"]'));
await sleep(30);
click(buttonByText('Dry Run'));
await sleep(60);
const stats = doc.querySelector('[data-testid="import-stats"]');
const note = doc.querySelector('[data-testid="import-stats-note"]');
check('stats panel lists the new tasks with their status labels',
  !!stats && stats.textContent.includes('Other machine deleted (deleted)') && stats.textContent.includes('Tasks'),
  stats?.textContent);
check('stats panel renders the tasks note under the Tasks row',
  !!note && /1 deleted of the new tasks is not pending/.test(note.textContent) && note.closest('tr')?.textContent.includes('Tasks'),
  note?.textContent);
const detail = doc.querySelector('[data-testid="import-stats-task-detail"]');
check('the task row detail line reports the purged task as "skipped (deleted here)" and the rest of the breakdown',
  !!detail && /2 new, 1 unchanged, 1 skipped \(deleted here\)/.test(detail.textContent) &&
  /app task cache/.test(detail.textContent),
  detail?.textContent);

/* ================================================================== */
console.log(`\n${total - failures}/${total} checks passed`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
