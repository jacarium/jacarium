/**
 * TaskWarrior-based tasks export/import (database backup format 2).
 *
 * Proves, against the REAL src/utils/exportDatabase.js (collectExportData),
 * src/utils/importDatabase.js, src/utils/taskwarriorBackup.js,
 * src/utils/tasks.js, src/utils/taskwarriorInstances.js and
 * src/db/database.js on real Dexie over fake-indexeddb, with the Flask
 * /api/taskwarrior/* routes replaced by a small in-memory TaskWarrior fake
 * (uuid upsert like `task import`, `modified` = now on a modify, export of
 * every status, path validation):
 *
 *   1. the export shape: formatVersion 2, tasks per instance as TaskWarrior
 *      JSON from the CLI (or converted cache rows when the CLI does not
 *      answer for an instance), tombstones, reports with instanceName, no
 *      flat `tasks` array, no numeric-id localStorage keys;
 *   2. merge import with the CLI reachable: instances matched by NAME, the
 *      backup diffed against the local `task export` by uuid - new / newer
 *      by `modified` / older skipped / deleted-and-newer tombstone / file
 *      tombstone / deleted-here never resurrected / uuid-less invalid - and
 *      only new+newer pushed through `task import`, then the cache
 *      re-synced;
 *   3. the dry run writes nothing (DB, localStorage, fake CLI) and reports
 *      the same statistics as the real run;
 *   4. a missing instance with an invalid data path is created inactive,
 *      flagged "needs a data path", its tasks kept in the cache only; one
 *      whose path validates goes through the CLI;
 *   5. the offline fallback (backend unreachable) merges into the cache;
 *   6. replace mode refills the cache and the purge list without a single
 *      CLI mutation;
 *   7. old-format files (flat `tasks`) still import;
 *   8. the modal renders one row per instance with the transport and the
 *      breakdown.
 *
 * Fixture data is synthetic throughout (no real task text, uuids or paths).
 *
 * Run:  node tests/taskwarrior-backup.test.mjs
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

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwarrior-backup-'));
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

// ---------- environment ----------
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
globalThis.window = globalThis; // backendUrl.js reads window.electronAPI
await import(req.resolve('fake-indexeddb/auto'));

// ---------- in-memory TaskWarrior fake behind the backend routes ----------
const tw = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const NOW = Date.now();
const cli = {
  stores: new Map(),        // dataPath -> Map(uuid -> TaskWarrior JSON task)
  existingDirs: new Set(),  // data paths that "exist" on this machine
  reachable: true,          // backend up?
  mutations: 0,             // /import, /delete, /purge calls
  calls: [],
};
const store = (dataPath) => {
  const key = dataPath || 'default';
  if (!cli.stores.has(key)) cli.stores.set(key, new Map());
  return cli.stores.get(key);
};
// Read-only view (never creates a store entry: the dry-run snapshot compares stores)
const twExport = (dataPath) => [...(cli.stores.get(dataPath || 'default') ?? new Map()).values()].map((t, i) => ({ ...t, id: i + 1, urgency: 1 }));
const okJson = (payload, status = 200) => ({ ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Internal Server Error', json: async () => payload });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  cli.calls.push(u.replace(/^.*\/api\/taskwarrior\//, ''));
  if (!cli.reachable) throw new TypeError('fetch failed: connection refused');
  const body = opts.body ? JSON.parse(opts.body) : {};
  const dataPath = body.dataPath || null;
  if (u.endsWith('/api/taskwarrior/export')) {
    if (dataPath && !cli.existingDirs.has(dataPath)) return okJson({ success: false, error: `Could not open ${dataPath}` }, 500);
    return okJson(twExport(dataPath));
  }
  if (u.endsWith('/api/taskwarrior/import')) {
    cli.mutations += 1;
    const s = store(dataPath);
    const added = [];
    const modified = [];
    for (const t of body.tasks || []) {
      const { id: _id, urgency: _u, ...task } = t;
      if (!task.uuid) continue;
      if (s.has(task.uuid)) { s.set(task.uuid, { ...task, modified: tw(Date.now()) }); modified.push(task.uuid); }
      else { s.set(task.uuid, { ...task }); added.push(task.uuid); }
    }
    const output = [...added.map((x) => ` add  ${x} ${s.get(x).description}`), ...modified.map((x) => ` mod  ${x} ${s.get(x).description}`)].join('\n');
    return okJson({ success: true, count: (body.tasks || []).length, added, modified, output });
  }
  if (u.endsWith('/api/taskwarrior/instances/validate')) {
    const errors = [];
    const warnings = [];
    if (body.rcPath && !cli.existingDirs.has(body.rcPath)) errors.push(`RC file does not exist: ${body.rcPath}`);
    if (dataPath && !cli.existingDirs.has(dataPath)) warnings.push(`Data directory does not exist: ${dataPath}`);
    return okJson({ success: errors.length === 0, valid: errors.length === 0, errors, warnings, stats: null });
  }
  if (u.endsWith('/api/taskwarrior/delete')) {
    cli.mutations += 1;
    const s = store(dataPath);
    if (s.has(body.uuid)) s.set(body.uuid, { ...s.get(body.uuid), status: 'deleted', end: tw(Date.now()), modified: tw(Date.now()) });
    return okJson({ success: true });
  }
  if (u.endsWith('/api/taskwarrior/purge')) {
    cli.mutations += 1;
    store(dataPath).delete(body.uuid);
    return okJson({ success: true });
  }
  throw new Error(`unexpected backend call in test: ${u}`);
};

// ---------- bundle the real modules ----------
const { build } = await import(req.resolve('esbuild'));
const DB_ENTRY = path.join(WORKDIR, 'db-entry.mjs');
const DB_BUNDLE = path.join(WORKDIR, 'db-bundle.cjs');
fs.writeFileSync(DB_ENTRY, [
  `export * from ${JSON.stringify(path.join(REPO, 'src/utils/importDatabase.js'))};`,
  `export { collectExportData } from ${JSON.stringify(path.join(REPO, 'src/utils/exportDatabase.js'))};`,
  `export { db } from ${JSON.stringify(path.join(REPO, 'src/db/database.js'))};`,
  `export { createTask, getTasks, getPurgedTaskUUIDs, addPurgedTaskUUIDs, getOrphanedTasks, deleteOrphanedTasks, syncFromTaskWarrior } from ${JSON.stringify(path.join(REPO, 'src/utils/tasks.js'))};`,
  `export { createInstance, getAllInstances, getInstanceTasks, createReport } from ${JSON.stringify(path.join(REPO, 'src/utils/taskwarriorInstances.js'))};`,
  `export { planCliTasks, twMillis, hasTaskwarriorTasks, BACKUP_FORMAT_VERSION, describeStatuses } from ${JSON.stringify(path.join(REPO, 'src/utils/taskwarriorBackup.js'))};`,
].join('\n'));
await build({ entryPoints: [DB_ENTRY], bundle: true, outfile: DB_BUNDLE, format: 'cjs', platform: 'node', logLevel: 'silent' });
const {
  runImport, collectExportData, db,
  createTask, getTasks, getPurgedTaskUUIDs, addPurgedTaskUUIDs, getOrphanedTasks, deleteOrphanedTasks, syncFromTaskWarrior,
  createInstance, getAllInstances, getInstanceTasks, createReport,
  planCliTasks, twMillis, hasTaskwarriorTasks, BACKUP_FORMAT_VERSION, describeStatuses,
} = req(DB_BUNDLE);

const realLog = console.log;
console.log = (...args) => { if (typeof args[0] === 'string' && args[0].startsWith('[')) return; realLog(...args); };
const realError = console.error;
console.error = (...args) => { if (typeof args[0] === 'string' && args[0].startsWith('[')) return; realError(...args); };

function baseImport(overrides = {}) {
  return { version: '1.0', documents: [], documentTemplates: [], jqlTemplates: [], engineTemplates: [], ...overrides };
}
const U = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const twTask = (n, desc, status, modifiedMs, extra = {}) => ({
  uuid: U(n), description: desc, status, entry: tw(NOW - 10 * 3600e3), modified: tw(modifiedMs), ...extra,
});
const isoOf = (ms) => new Date(ms).toISOString();
const uuids = (rows) => rows.map((t) => t.uuid).sort();

async function snapshotState() {
  return JSON.stringify({
    tasks: await db.tasks.toArray(),
    instances: await db.taskwarriorInstances.toArray(),
    reports: await db.taskwarriorReports.toArray(),
    ls: [...lsStore.entries()],
    cli: [...cli.stores.entries()].map(([k, v]) => [k, [...v.entries()]]),
    mutations: cli.mutations,
  });
}
async function resetAll() {
  await db.tasks.clear();
  await db.taskwarriorInstances.clear();
  await db.taskwarriorReports.clear();
  lsStore.delete('taskwarrior_purged_uuids');
  lsStore.delete('currentTaskInstanceId');
  lsStore.delete('taskInstanceOpenTabs');
  cli.stores.clear();
  cli.existingDirs.clear();
  cli.reachable = true;
  cli.mutations = 0;
  cli.calls.length = 0;
}

/* ================================================================== */
console.log('\n--- 1. export shape (format 2) ---');
/* ================================================================== */
await resetAll();
const WORK_A = '/tmp/synthetic-a/work';
const HOME_A = '/tmp/synthetic-a/home';
cli.existingDirs.add(WORK_A);
store(WORK_A).set(U(1), twTask(1, 'Work one', 'pending', NOW - 3600e3, { project: 'proj' }));
store(WORK_A).set(U(2), twTask(2, 'Work two', 'completed', NOW - 3600e3, { end: tw(NOW - 3600e3) }));
const workA = await createInstance({ name: 'Work', dataPath: WORK_A, isActive: 1 });
const homeA = await createInstance({ name: 'Home', dataPath: HOME_A }); // CLI does not answer for this one
await createTask({ uuid: U(1), description: 'Work one (cache)', instanceId: workA.id, status: 'pending', modified: isoOf(NOW - 3600e3) });
await createTask({ uuid: U(2), description: 'Work two (cache)', instanceId: workA.id, status: 'completed', modified: isoOf(NOW - 3600e3) });
await createTask({ uuid: U(3), description: 'Home cached task', instanceId: homeA.id, status: 'pending', due: isoOf(NOW + 86400e3), modified: isoOf(NOW - 7200e3), tags: ['t1'] });
await createTask({ uuid: U(4), description: 'Orphan (no instance)', instanceId: 999, status: 'pending' });
addPurgedTaskUUIDs([U(90)]);
await createReport({ instanceId: workA.id, name: 'Urgent', filter: 'priority:H' });
lsStore.set('currentTaskInstanceId', String(workA.id));
lsStore.set('taskInstanceOpenTabs', JSON.stringify([{ id: workA.id }]));
lsStore.set('taskExpandedSections', JSON.stringify({ active: true }));

const logs = [];
const exported = await collectExportData((u) => { if (u.log) logs.push(u.log); });
check('formatVersion 2 sits right after version; no flat `tasks` array',
  exported.formatVersion === 2 && BACKUP_FORMAT_VERSION === 2 && Object.keys(exported)[1] === 'formatVersion' && !('tasks' in exported),
  Object.keys(exported).slice(0, 12).join(','));
check('taskwarriorTasks is keyed by instance name; Work comes from the CLI as TaskWarrior JSON',
  hasTaskwarriorTasks(exported) && uuids(exported.taskwarriorTasks.Work).join() === [U(1), U(2)].join() &&
  exported.taskwarriorTasks.Work[0].description === 'Work one' && /^\d{8}T\d{6}Z$/.test(exported.taskwarriorTasks.Work[0].modified) &&
  exported.taskwarriorTasksSource.Work === 'cli',
  JSON.stringify(exported.taskwarriorTasks?.Work));
check('Home (CLI not answering) is exported from the cache with the syncToTaskWarrior field mapping (TW timestamps, only set fields)',
  exported.taskwarriorTasksSource.Home === 'db' && exported.taskwarriorTasks.Home.length === 1 &&
  exported.taskwarriorTasks.Home[0].uuid === U(3) && /^\d{8}T\d{6}Z$/.test(exported.taskwarriorTasks.Home[0].due) &&
  JSON.stringify(exported.taskwarriorTasks.Home[0].tags) === '["t1"]' && !('instanceId' in exported.taskwarriorTasks.Home[0]) &&
  !('project' in exported.taskwarriorTasks.Home[0]),
  JSON.stringify(exported.taskwarriorTasks?.Home));
check('tombstones = the purge list; reports carry instanceName; instance paths exported as hints',
  JSON.stringify(exported.taskTombstones) === JSON.stringify([U(90)]) &&
  exported.taskwarriorReports.length === 1 && exported.taskwarriorReports[0].instanceName === 'Work' &&
  exported.taskwarriorInstances.find((i) => i.name === 'Work')?.dataPath === WORK_A);
check('numeric-id localStorage keys are not exported; other task UI keys still are',
  !('currentTaskInstanceId' in exported.localStorage) && !('taskInstanceOpenTabs' in exported.localStorage) &&
  'taskExpandedSections' in exported.localStorage, JSON.stringify(Object.keys(exported.localStorage)));
check('orphan cached task (no instance) is reported in the log and not exported',
  logs.some((l) => /1 cached task belong/.test(l)) && logs.some((l) => /not reachable for "Home"/.test(l)),
  logs.join(' | '));
check('the per-instance log line breaks the count down by status (CLI and cache sources alike)',
  logs.some((l) => l === 'Read 2 tasks for "Work" from the TaskWarrior CLI (1 pending, 1 completed, 0 deleted)') &&
  logs.some((l) => l === 'Read 1 task for "Home" from the app database (1 pending, 0 completed, 0 deleted)'),
  logs.join(' | '));
check('describeStatuses: only-deleted export reads as such and says why they are kept; extra statuses listed',
  describeStatuses([{ status: 'deleted' }, { status: 'deleted' }, { status: 'deleted' }]) === '0 pending, 0 completed, 3 deleted; deleted tasks are kept as tombstones for merges' &&
  describeStatuses([{ status: 'pending' }, { status: 'waiting' }, {}]) === '2 pending, 0 completed, 0 deleted, 1 waiting',
  describeStatuses([{ status: 'deleted' }]));
check('the export object is plain JSON', typeof JSON.stringify(exported) === 'string');

/* ================================================================== */
console.log('\n--- 2. merge import, CLI reachable: diff by uuid + modified, push new/newer only ---');
/* ================================================================== */
await resetAll();
const WORK_B = '/tmp/synthetic-b/work';
cli.existingDirs.add(WORK_B);
const workB = await createInstance({ name: 'Work', dataPath: WORK_B, isActive: 1 });
// Local CLI state on machine B
store(WORK_B).set(U(1), twTask(1, 'T1 local older', 'pending', NOW - 7200e3));
store(WORK_B).set(U(2), twTask(2, 'T2 local newer', 'pending', NOW - 3600e3));
store(WORK_B).set(U(3), twTask(3, 'T3 live here', 'pending', NOW - 7200e3));
store(WORK_B).set(U(4), twTask(4, 'T4 live here, purged on A', 'pending', NOW - 7200e3));
store(WORK_B).set(U(5), twTask(5, 'T5 deleted here', 'deleted', NOW - 7200e3, { end: tw(NOW - 7200e3) }));
addPurgedTaskUUIDs([U(5)]);
// The cache mirrors the CLI (as after a sync)
for (const t of twExport(WORK_B)) {
  if (t.uuid === U(5)) continue;
  await createTask({ uuid: t.uuid, description: t.description, status: t.status, instanceId: workB.id, modified: isoOf(twMillis(t.modified)) });
}
const backupB = baseImport({
  formatVersion: 2,
  taskwarriorInstances: [{ id: 7, name: 'Work', category: 'General', description: 'from A', rcPath: '', dataPath: WORK_A, isActive: 1, createdAt: isoOf(NOW - 9e6), updatedAt: isoOf(NOW - 9e6) }],
  taskwarriorTasks: {
    Work: [
      twTask(1, 'T1 newer in file', 'pending', NOW - 3600e3),                       // updated
      twTask(2, 'T2 older in file', 'pending', NOW - 7200e3),                       // skipped
      twTask(3, 'T3 deleted on A', 'deleted', NOW - 3600e3, { end: tw(NOW - 3600e3) }), // tombstoned
      twTask(5, 'T5 back from the dead?', 'pending', NOW - 60e3),                   // purged here -> skipped
      twTask(6, 'T6 new pending', 'pending', NOW - 3600e3),                         // created
      twTask(7, 'T7 new completed', 'completed', NOW - 3600e3, { end: tw(NOW - 3600e3) }), // created (completed)
      { description: 'T8 no uuid', status: 'pending', entry: tw(NOW), modified: tw(NOW) }, // invalid
    ],
  },
  taskTombstones: [U(4)],
  taskwarriorReports: [{ id: 3, instanceId: 7, instanceName: 'Work', name: 'Urgent', filter: 'priority:H', columns: 'id,description', sort: 'due+', isBuiltIn: false, createdAt: isoOf(NOW - 9e6), updatedAt: isoOf(NOW - 9e6) }],
});

const before = await snapshotState();
const dryB = await runImport(backupB, true, { dryRun: true });
const rowDry = dryB.summary['tasks:Work'];
check('dry run wrote nothing: DB, localStorage and the fake CLI are byte-for-byte unchanged, no mutating CLI call',
  (await snapshotState()) === before && cli.mutations === 0 && !cli.calls.some((c) => /import|delete|purge/.test(c)),
  cli.calls.join(','));
check('dry run: one row per instance, applied via the CLI',
  !!rowDry && rowDry.via === 'cli' && rowDry.instance === 'Work' && !rowDry.needsDataPath, JSON.stringify(rowDry));
check('dry run: 2 new (1 pending, 1 completed), 1 updated (newer), 2 tombstoned, 1 unchanged (older), 1 skipped (deleted here), 1 invalid (no uuid)',
  rowDry.created === 2 && rowDry.updated === 3 && rowDry.tombstoned === 2 && rowDry.skipped === 2 && rowDry.purgedHere === 1 &&
  rowDry.invalid === 1 && /no uuid/.test(rowDry.errors[0]?.reason || '') &&
  JSON.stringify(rowDry.createdByStatus) === JSON.stringify({ pending: 1, completed: 1 }) &&
  rowDry.samples.created.includes('T7 new completed (completed)') && rowDry.samples.purgedHere.includes('T5 back from the dead?') &&
  rowDry.samples.tombstoned.length === 2 && /1 completed of the new tasks is not pending/.test(rowDry.note || ''),
  JSON.stringify(rowDry));
check('dry run: report row planned as created, mapped to the local instance',
  dryB.summary.taskwarriorReports?.created === 1, JSON.stringify(dryB.summary.taskwarriorReports));

const realB = await runImport(backupB, true, { dryRun: false });
const rowReal = realB.summary['tasks:Work'];
check('real run: identical statistics to the dry run',
  JSON.stringify(rowReal) === JSON.stringify(rowDry), JSON.stringify({ dry: rowDry, real: rowReal }));
check('exactly one `task import` call, carrying only new + newer + tombstones (5 tasks), nothing else touched the CLI',
  cli.mutations === 1 && cli.calls.filter((c) => c === 'import').length === 1 && cli.calls.filter((c) => /delete|purge/.test(c)).length === 0);
const s = store(WORK_B);
check('CLI now has T1 updated, T2 untouched (older file copy not pushed), T6/T7 added',
  s.get(U(1)).description === 'T1 newer in file' && s.get(U(2)).description === 'T2 local newer' &&
  s.get(U(6))?.status === 'pending' && s.get(U(7))?.status === 'completed');
check('tombstones applied in the CLI: T3 (deleted-and-newer copy) and T4 (file tombstone) are deleted, T4 keeps its description',
  s.get(U(3)).status === 'deleted' && s.get(U(4)).status === 'deleted' && s.get(U(4)).description === 'T4 live here, purged on A' && s.get(U(4)).end);
check('deleted-here task never resurrected: T5 not pushed, still deleted in the CLI, not in the cache',
  s.get(U(5)).status === 'deleted' && s.get(U(5)).description === 'T5 deleted here' &&
  (await db.tasks.where('uuid').equals(U(5)).count()) === 0);
check('file tombstone joined the local purge list (and T5 is still on it)',
  getPurgedTaskUUIDs().includes(U(4)) && getPurgedTaskUUIDs().includes(U(5)), JSON.stringify(getPurgedTaskUUIDs()));
const cacheB = await getInstanceTasks(workB.id);
check('cache re-synced from the CLI after the push: Tasks page shows T1,T2,T3,T4,T6,T7 under the local Work instance',
  uuids(cacheB).join() === [U(1), U(2), U(3), U(4), U(6), U(7)].join() &&
  cacheB.find((t) => t.uuid === U(1)).description === 'T1 newer in file' && cacheB.find((t) => t.uuid === U(3)).status === 'deleted',
  JSON.stringify(uuids(cacheB)));
const workAfter = (await getAllInstances()).find((i) => i.name === 'Work');
check('local instance matched by name keeps its own data path (the file\'s path is a hint only) and stays the only Work instance',
  workAfter.id === workB.id && workAfter.dataPath === WORK_B && (await db.taskwarriorInstances.where('name').equals('Work').count()) === 1);
const report = (await db.taskwarriorReports.toArray())[0];
check('custom report created for the local instance id', report?.name === 'Urgent' && report.instanceId === workB.id && !('instanceName' in report));
const againB = await runImport(backupB, true, { dryRun: false });
check('re-importing the same backup is a no-op for the CLI (0 new, 0 updated, nothing pushed)',
  againB.summary['tasks:Work'].created === 0 && againB.summary['tasks:Work'].updated === 0 && cli.mutations === 1,
  JSON.stringify(againB.summary['tasks:Work']));

/* ================================================================== */
console.log('\n--- 3. missing instances: invalid data path -> cache + flag; valid path -> CLI ---');
/* ================================================================== */
const LAB = '/tmp/synthetic-b/lab';
cli.existingDirs.add(LAB);
const backupMissing = baseImport({
  formatVersion: 2,
  taskwarriorInstances: [
    { id: 8, name: 'Remote', category: 'General', description: '', rcPath: '', dataPath: '/home/other/.task-remote', isActive: 0, createdAt: isoOf(NOW - 9e6), updatedAt: isoOf(NOW - 9e6) },
    { id: 9, name: 'Lab', category: 'General', description: '', rcPath: '', dataPath: LAB, isActive: 1, createdAt: isoOf(NOW - 9e6), updatedAt: isoOf(NOW - 9e6) },
  ],
  taskwarriorTasks: {
    Remote: [twTask(11, 'Remote task', 'pending', NOW - 3600e3)],
    Lab: [twTask(12, 'Lab task', 'pending', NOW - 3600e3)],
  },
  taskTombstones: [],
});
const beforeMissing = await snapshotState();
const dryM = await runImport(backupMissing, true, { dryRun: true });
check('dry run creates no instance, writes nothing',
  (await snapshotState()) === beforeMissing && dryM.summary.taskwarriorInstances.created === 2 && cli.mutations === 1);
check('dry run: Remote flagged "needs a data path" (cache only), Lab planned via the CLI',
  dryM.summary['tasks:Remote'].needsDataPath === true && dryM.summary['tasks:Remote'].via === 'db' &&
  /does not exist/.test(dryM.summary['tasks:Remote'].cliError || '') && dryM.summary['tasks:Remote'].created === 1 &&
  dryM.summary['tasks:Lab'].via === 'cli' && dryM.summary['tasks:Lab'].created === 1 && !dryM.summary['tasks:Lab'].needsDataPath,
  JSON.stringify({ r: dryM.summary['tasks:Remote'], l: dryM.summary['tasks:Lab'] }));
const realM = await runImport(backupMissing, true, { dryRun: false });
const remote = (await getAllInstances()).find((i) => i.name === 'Remote');
const lab = (await getAllInstances()).find((i) => i.name === 'Lab');
check('real run: same statistics; both instances created INACTIVE (Lab with the file\'s ~ path, Remote\'s foreign path rewritten)',
  JSON.stringify(realM.summary['tasks:Remote']) === JSON.stringify(dryM.summary['tasks:Remote']) &&
  JSON.stringify(realM.summary['tasks:Lab']) === JSON.stringify(dryM.summary['tasks:Lab']) &&
  remote?.isActive === 0 && lab?.isActive === 0 && remote.dataPath === '~/.task/remote' && lab.dataPath === LAB,   // the file's absolute path (another machine) is rewritten to ~/.task/<name> on import
  JSON.stringify({ remote: remote?.dataPath, lab: lab?.dataPath }));
check('Remote task lives in the cache under the new instance; the CLI was not asked to import it',
  (await getInstanceTasks(remote.id)).map((t) => t.uuid).join() === U(11) && !store('/home/other/.task-remote').has(U(11)));
check('Lab task went through the CLI and was synced back into the cache',
  store(LAB).get(U(12))?.description === 'Lab task' && (await getInstanceTasks(lab.id)).map((t) => t.uuid).join() === U(12) && cli.mutations === 2);

/* ================================================================== */
console.log('\n--- 4. offline fallback: backend unreachable -> cache merge ---');
/* ================================================================== */
cli.reachable = false;
const backupOffline = baseImport({
  formatVersion: 2,
  taskwarriorInstances: backupB.taskwarriorInstances,
  // T1's cache copy carries the CLI's modified=now stamp from the push in
  // section 2 (TaskWarrior stamps a modified task with the current time), so
  // the file copy must be newer than that to count as an update.
  taskwarriorTasks: { Work: [twTask(13, 'Offline new task', 'pending', NOW - 3600e3), twTask(1, 'T1 even newer', 'pending', Date.now() + 60e3)] },
  taskTombstones: [U(2)],
});
const dryO = await runImport(backupOffline, true, { dryRun: true });
const beforeReal = await snapshotState();
check('dry run offline: via db with the CLI error, 1 new, 1 updated (newer), 1 tombstoned (T2 from the file tombstones)',
  dryO.summary['tasks:Work'].via === 'db' && /connection refused/.test(dryO.summary['tasks:Work'].cliError || '') &&
  dryO.summary['tasks:Work'].created === 1 && dryO.summary['tasks:Work'].updated === 2 && dryO.summary['tasks:Work'].tombstoned === 1 &&
  !dryO.summary['tasks:Work'].needsDataPath && (await snapshotState()) === beforeReal,
  JSON.stringify(dryO.summary['tasks:Work']));
const realO = await runImport(backupOffline, true, { dryRun: false });
const cacheO = await getInstanceTasks(workB.id);
check('real run offline: cache has the new task, T1 replaced by the newer copy, T2 marked deleted; purge list gained T2; CLI untouched',
  JSON.stringify(realO.summary['tasks:Work']) === JSON.stringify(dryO.summary['tasks:Work']) &&
  cacheO.some((t) => t.uuid === U(13)) && cacheO.find((t) => t.uuid === U(1)).description === 'T1 even newer' &&
  cacheO.find((t) => t.uuid === U(2)).status === 'deleted' && getPurgedTaskUUIDs().includes(U(2)) &&
  cli.mutations === 2 && store(WORK_B).get(U(2)).status === 'pending',
  JSON.stringify(cacheO.map((t) => [t.uuid, t.status, t.description])));
cli.reachable = true;

/* ================================================================== */
console.log('\n--- 5. replace mode: cache + purge list only, CLI never touched ---');
/* ================================================================== */
const mutationsBeforeReplace = cli.mutations;
const cliBeforeReplace = JSON.stringify([...cli.stores.entries()].map(([k, v]) => [k, [...v.entries()]]));
const backupReplace = baseImport({
  formatVersion: 2,
  taskwarriorInstances: [{ id: 7, name: 'Work', category: 'General', description: '', rcPath: '', dataPath: WORK_A, isActive: 1, createdAt: isoOf(NOW - 9e6), updatedAt: isoOf(NOW - 9e6) }],
  taskwarriorTasks: { Work: [twTask(21, 'Replaced one', 'pending', NOW - 3600e3), twTask(22, 'Replaced two', 'deleted', NOW - 3600e3, { end: tw(NOW - 3600e3) }), { description: 'no uuid', status: 'pending' }] },
  taskTombstones: [U(77)],
  taskwarriorReports: [{ id: 3, instanceId: 7, instanceName: 'Work', name: 'Replaced report', filter: '', columns: 'id', sort: 'due+', isBuiltIn: false, createdAt: isoOf(NOW - 9e6), updatedAt: isoOf(NOW - 9e6) }],
});
const cachedWorkBefore = (await getInstanceTasks(workB.id)).length;
const allCachedBefore = await db.tasks.count();
const planR = await runImport(backupReplace, false, { dryRun: true });
check('replace dry run: per-instance row (cache only) wipes the local Work cache and creates the file rows; other instances\' cache rows wiped too',
  planR.summary['tasks:Work']?.cacheOnly === true && planR.summary['tasks:Work'].deleted === cachedWorkBefore &&
  planR.summary['tasks:Work'].created === 2 && planR.summary['tasks:Work'].invalid === 1 &&
  planR.summary['tasks:Work'].createdByStatus.deleted === 1 && /1 deleted of the new tasks/.test(planR.summary['tasks:Work'].note || '') &&
  (planR.summary.tasks?.deleted || 0) === allCachedBefore - cachedWorkBefore && planR.summary.taskwarriorReports.created === 1 &&
  (await db.tasks.count()) === allCachedBefore,
  JSON.stringify({ w: planR.summary['tasks:Work'], t: planR.summary.tasks }));
const realR = await runImport(backupReplace, false, { dryRun: false });
const workR = (await getAllInstances()).find((i) => i.name === 'Work');
check('replace real run: summary identical to the plan',
  JSON.stringify(realR.summary['tasks:Work']) === JSON.stringify(planR.summary['tasks:Work']));
check('cache refilled with the file rows under the recreated instance (new id); other instances gone',
  workR && workR.id !== workB.id && uuids(await getInstanceTasks(workR.id)).join() === [U(21), U(22)].join() &&
  (await db.tasks.count()) === 2 && (await getAllInstances()).length === 1);
check('purge list replaced by the file tombstones; report recreated for the new instance id',
  JSON.stringify(getPurgedTaskUUIDs()) === JSON.stringify([U(77)]) &&
  (await db.taskwarriorReports.toArray()).every((r) => r.instanceId === workR.id && r.name === 'Replaced report'));
check('replace never touched the TaskWarrior CLI (no import/delete/purge, data unchanged)',
  cli.mutations === mutationsBeforeReplace && JSON.stringify([...cli.stores.entries()].map(([k, v]) => [k, [...v.entries()]])) === cliBeforeReplace);

/* ================================================================== */
console.log('\n--- 6. old-format file (flat `tasks`) still imports through the cache merge ---');
/* ================================================================== */
const legacy = baseImport({
  taskwarriorInstances: [{ id: 3, name: 'Work', category: 'General', description: '', rcPath: '', dataPath: WORK_A, isActive: 1, createdAt: isoOf(NOW - 9e6), updatedAt: isoOf(NOW - 9e6) }],
  tasks: [{ id: 50, uuid: U(31), description: 'Legacy row', status: 'pending', instanceId: 3, entry: isoOf(NOW - 3600e3), modified: isoOf(NOW - 3600e3), tags: [], annotations: [], depends: [] }],
});
const dryL = await runImport(legacy, true, { dryRun: true });
const realL = await runImport(legacy, true, { dryRun: false });
check('legacy file: single Tasks row via the cache merge, instanceId remapped by name, visible on the Tasks page',
  dryL.summary.tasks?.via === 'db' && dryL.summary.tasks.created === 1 && !('tasks:Work' in dryL.summary) &&
  JSON.stringify(realL.summary.tasks) === JSON.stringify(dryL.summary.tasks) &&
  (await getInstanceTasks(workR.id)).some((t) => t.uuid === U(31)),
  JSON.stringify(dryL.summary.tasks));

/* ================================================================== */
console.log('\n--- 7. planCliTasks is pure and stable ---');
/* ================================================================== */
const planArgs = {
  fileTasks: [twTask(1, 'a', 'pending', NOW), twTask(1, 'a dup', 'pending', NOW), twTask(2, 'b', 'deleted', NOW)],
  localTasks: [twTask(1, 'a local', 'pending', NOW - 1000), twTask(2, 'b local', 'pending', NOW - 1000)],
  purged: [], tombstones: [U(3)],
};
const p1 = planCliTasks({ ...planArgs, now: new Date(NOW) });
const p2 = planCliTasks({ ...planArgs, now: new Date(NOW) });
check('same inputs -> same plan; duplicate uuid in the file is skipped; tombstone for an unknown uuid only joins the purge list',
  JSON.stringify(p1) === JSON.stringify(p2) && p1.decisions.map((d) => d.outcome).join() === 'updated,skipped,tombstoned' &&
  p1.toPush.length === 2 && JSON.stringify(p1.newTombstones) === JSON.stringify([U(3)]),
  JSON.stringify(p1.decisions));

/* ================================================================== */
console.log('\n--- 9. orphan cleanup vs tasks the CLI still owns ---');
/* ================================================================== */
// "Personal Tasks" was deleted and recreated (new auto-increment id) while
// cache rows still carry the old id: they are orphans. The CLI still owns two
// of the uuids (one pending, one deleted); a third uuid was purged by the
// user in the app (purge list) and the CLI keeps it as status:deleted.
await resetAll();
const PERSONAL = '/tmp/synthetic-b/personal';
cli.existingDirs.add(PERSONAL);
const oldPersonal = await createInstance({ name: 'Personal Tasks', dataPath: PERSONAL });
const stale = { oldId: oldPersonal.id };
await db.taskwarriorInstances.delete(oldPersonal.id); // vanished without deleteInstance: rows keep the old id
const personal = await createInstance({ name: 'Personal Tasks', dataPath: PERSONAL, isActive: 1 });
store(PERSONAL).set(U(41), twTask(41, 'Still live in the CLI', 'pending', NOW - 3600e3));
store(PERSONAL).set(U(42), twTask(42, 'Deleted in the CLI, not purged', 'deleted', NOW - 3600e3, { end: tw(NOW - 3600e3) }));
store(PERSONAL).set(U(43), twTask(43, 'Deleted in the app (purge list)', 'deleted', NOW - 3600e3, { end: tw(NOW - 3600e3) }));
addPurgedTaskUUIDs([U(43)]);
for (const n of [41, 42, 43]) await createTask({ uuid: U(n), description: `stale row ${n}`, status: 'pending', instanceId: stale.oldId, modified: isoOf(NOW - 7200e3) });
await createTask({ uuid: U(44), description: 'cache-only orphan (no CLI has it)', status: 'pending', instanceId: stale.oldId, modified: isoOf(NOW - 7200e3) });
check('setup: 4 orphan rows (old instance id), the new instance shows nothing yet',
  (await getOrphanedTasks()).length === 4 && (await getInstanceTasks(personal.id)).length === 0 && personal.id !== stale.oldId);
// Without cleaning: the instance's open-time sync re-attaches the rows the CLI owns.
const syncA = await syncFromTaskWarrior(personal.id, null, PERSONAL);
const afterSyncA = await getInstanceTasks(personal.id);
check('without cleaning: the sync re-attaches the CLI-owned uuids to the new instance by uuid (pending + deleted), skips the purge-listed one',
  syncA.success && uuids(afterSyncA).join() === [U(41), U(42)].join() && afterSyncA.find((t) => t.uuid === U(41)).status === 'pending' &&
  afterSyncA.find((t) => t.uuid === U(42)).status === 'deleted' && (await getOrphanedTasks()).map((t) => t.uuid).sort().join() === [U(43), U(44)].join(),
  JSON.stringify({ sync: syncA, rows: afterSyncA.map((t) => [t.uuid, t.status]) }));
// Now the other order: clean first, then the sync.
await db.tasks.clear();
for (const n of [41, 42, 43, 44]) await createTask({ uuid: U(n), description: `stale row ${n}`, status: 'pending', instanceId: stale.oldId, modified: isoOf(NOW - 7200e3) });
const removed = await deleteOrphanedTasks();
const syncB = await syncFromTaskWarrior(personal.id, null, PERSONAL);
const afterSyncB = await getInstanceTasks(personal.id);
check('cleaning first removes the 4 rows; the next sync rebuilds the CLI-owned ones from the CLI (source of truth), so no live task is hidden',
  removed === 4 && syncB.success && uuids(afterSyncB).join() === [U(41), U(42)].join() && afterSyncB.find((t) => t.uuid === U(41)).status === 'pending' &&
  (await db.tasks.count()) === 2 && cli.mutations === 0,
  JSON.stringify({ removed, rows: afterSyncB.map((t) => [t.uuid, t.status]) }));
check('what cleaning actually loses: only the row no CLI has (44) and the purge-listed one the user deleted (43); purge list unchanged',
  !afterSyncB.some((t) => t.uuid === U(44) || t.uuid === U(43)) && JSON.stringify(getPurgedTaskUUIDs()) === JSON.stringify([U(43)]));
// The export of that instance now reads 3 from the CLI although the page shows 1 pending.
const logs9 = [];
const exported9 = await collectExportData((u) => { if (u.log) logs9.push(u.log); });
check('the export reads the CLI (status.any): 3 tasks, and the log says 1 pending, 0 completed, 2 deleted',
  exported9.taskwarriorTasks['Personal Tasks'].length === 3 &&
  logs9.includes('Read 3 tasks for "Personal Tasks" from the TaskWarrior CLI (1 pending, 0 completed, 2 deleted; deleted tasks are kept as tombstones for merges)'),
  logs9.filter((l) => /Personal/.test(l)).join(' | '));
check('the exported deleted copies carry status deleted (tombstones), and the purge-listed uuid is in taskTombstones',
  exported9.taskwarriorTasks['Personal Tasks'].filter((t) => t.status === 'deleted').length === 2 && exported9.taskTombstones.includes(U(43)));

/* ================================================================== */
console.log('\n--- 8. modal: per-instance rows, transport and breakdown; replace-mode copy ---');
/* ================================================================== */
const UI_ENTRY = path.join(WORKDIR, 'ui-entry.jsx');
const UI_BUNDLE = path.join(WORKDIR, 'ui-bundle.cjs');
fs.writeFileSync(UI_ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ImportDBModal from '@worktree/src/components/common/modals/ImportDBModal.jsx';

const row = (extra) => ({ created: 0, updated: 0, filled: 0, skipped: 0, deleted: 0, invalid: 0, errors: [],
  samples: { created: [], updated: [], filled: [], tombstoned: [], purgedHere: [] }, tombstoned: 0, purgedHere: 0, createdByStatus: {}, ...extra });
const fakeResult = (mode, dryRun) => ({
  mode, dryRun,
  summary: {
    'tasks:Work': row({ instance: 'Work', via: 'cli', created: 3, updated: 2, tombstoned: 1, skipped: 5, purgedHere: 1,
      samples: { created: ['Alpha', 'Beta', 'Gamma (completed)'], updated: ['Delta'], filled: [], tombstoned: ['Epsilon (deleted)'], purgedHere: ['Zeta'] },
      createdByStatus: { pending: 2, completed: 1 } }),
    'tasks:Remote': row({ instance: 'Remote', via: 'db', needsDataPath: true, cliError: 'Data directory does not exist: /home/other/.task-remote', created: 1,
      samples: { created: ['Remote task'], updated: [], filled: [], tombstoned: [], purgedHere: [] } }),
    taskwarriorReports: { created: 1, updated: 0, filled: 0, skipped: 0, deleted: 0, invalid: 0, errors: [], samples: { created: ['Work / Urgent'], updated: [], filled: [] } },
  },
  totals: { created: 5, updated: 2, filled: 0, skipped: 5, deleted: 0, invalid: 0 },
});
window.__remount = (key) => createRoot(document.getElementById('root')).render(
  <ImportDBModal key={key} isOpen={true} onClose={() => {}}
    onImport={async (d, m) => fakeResult(m ? 'merge' : 'replace', false)}
    onDryRun={async (d, m) => fakeResult(m ? 'merge' : 'replace', true)} />
);
window.__remount(1);
`);
await build({
  entryPoints: [UI_ENTRY], bundle: true, outfile: UI_BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
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
  logLevel: 'silent',
});
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node',
  'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'File', 'FileReader']) define(name, window[name]);
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
const file = new window.File([JSON.stringify(backupB)], 'export.json', { type: 'application/json' });
Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(150);
check('preview counts the TaskWarrior tasks per instance and the tombstones',
  doc.body.textContent.includes('7 TaskWarrior tasks in 1 instance, 1 deleted-task tombstone'), doc.body.textContent.slice(0, 400));
check('replace-mode warning says the TaskWarrior data files are untouched',
  /Nothing is\s+deleted, purged or imported in your TaskWarrior data files/.test(doc.body.textContent));
click(doc.querySelector('input[type="checkbox"]'));
await sleep(30);
check('merge-mode notice explains the CLI path and that deleted tasks are not brought back',
  /applied\s+through the TaskWarrior CLI/.test(doc.body.textContent) && /never brought back/.test(doc.body.textContent));
click(buttonByText('Dry Run'));
await sleep(60);
const stats = doc.querySelector('[data-testid="import-stats"]');
const taskRows = [...doc.querySelectorAll('[data-testid="import-stats-task-row"]')];
const details = taskRows.map((r) => r.querySelector('[data-testid="import-stats-task-detail"]')?.textContent || '');
check('one row per instance, labelled "Tasks: <name>"',
  taskRows.length === 2 && taskRows[0].textContent.includes('Tasks: Work') && taskRows[1].textContent.includes('Tasks: Remote'),
  taskRows.map((r) => r.textContent).join(' || '));
check('Work row: "via TaskWarrior CLI: 3 new, 1 updated (newer), 4 unchanged, 1 deleted (tombstone would be applied), 1 skipped (deleted here)"',
  /^via TaskWarrior CLI: 3 new, 1 updated \(newer\), 4 unchanged, 1 deleted \(tombstone would be applied\), 1 skipped \(deleted here\)$/.test(details[0]),
  details[0]);
check('Remote row flags the missing data path with the reason',
  /^needs a data path - kept in the app task cache: 1 new \(Data directory does not exist: \/home\/other\/\.task-remote\)$/.test(details[1]), details[1]);
check('detail lines use the readable secondary text token and the reports row is labelled',
  details.length === 2 && taskRows.every((r) => r.querySelector('[data-testid="import-stats-task-detail"]').className.includes('text-os-text-secondary')) &&
  stats.textContent.includes('TaskWarrior reports'));

/* ================================================================== */
console.log(`\n${total - failures}/${total} checks passed`);
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
