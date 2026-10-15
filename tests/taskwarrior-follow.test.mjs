/**
 * Guards "Taskwarrior follows the account" (src/sync/taskwarriorFollow.js):
 * two devices of one account, each with its OWN real Taskwarrior, kept
 * aligned through the app's synchronisation. Everything is real: the
 * engine (src/sync/syncEngine.js) on two Dexie databases (fake-indexeddb),
 * the REAL backends (backend/app.py) and the REAL `task` CLI.
 *
 *   device A = a browser signed in to the home server S (accounts mode):
 *              its Taskwarrior is the account's, under the account's home
 *              on S (~/.task/work);
 *   device B = a linked desktop profile: its own backend L (app-token
 *              mode with a profile home) and its own Taskwarrior there.
 *   Both synchronise their app data with S (as a browser session / a device
 *   would).
 *
 * Proves (synthetic data only, throwaway directories):
 *   1. an instance created on A and tasks added through A's Taskwarrior CLI
 *      reach B's app AND B's Taskwarrior (the instance is initialised there);
 *   2. a task modified on B's CLI comes back to A's Taskwarrior with the same
 *      uuid and content, no duplicate row, its modification stamp not older
 *      than B's edit (Taskwarrior 3.4's `import` re-stamps an existing task
 *      with its own clock, so the stamps are compared as a window, never for
 *      equality: B's edit <= A's stamp <= the moment of the check);
 *   3. completing a task on A completes it on B;
 *   4. no ping-pong: a re-read of `task export` that changes nothing marks
 *      nothing dirty on either device (updateTask keeps the real `modified`);
 *   5. concurrent edits of the same task on both sides: the newer one wins
 *      in both Taskwarriors;
 *   6. a task purged on A is purged on B (and remembered as purged there);
 *   7. rows applied while no follower listened are reconciled by reapplyAll()
 *      (instance initialised, tasks imported once, a second run pushes nothing);
 *   8. an instance with another machine's absolute paths is rewritten once to
 *      ~/.task/<name>, initialised there, and the rewrite synchronises once.
 *
 * Skips cleanly when the `task` CLI is not installed. Needs fake-indexeddb +
 * jsdom + esbuild (npm install --no-save jsdom fake-indexeddb) and the
 * backend venv. Run: node tests/taskwarrior-follow.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PYTHON = fs.existsSync(path.join(REPO, 'backend', 'venv', 'bin', 'python')) ? path.join(REPO, 'backend', 'venv', 'bin', 'python') : 'python3';

const taskVersion = spawnSync('task', ['--version'], { encoding: 'utf8' });
if (taskVersion.error || taskVersion.status !== 0) {
  console.log('SKIP: the Taskwarrior CLI (task) is not installed here');
  process.exit(0);
}
for (const dep of ['fake-indexeddb', 'esbuild', 'dexie', 'jsdom']) {
  try { req.resolve(dep); } catch { console.error(`Missing dependency "${dep}". Run: npm install --no-save jsdom fake-indexeddb`); process.exit(1); }
}

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a browser-ish global environment for Dexie + the engine --------------
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://console.test/' });
for (const key of ['window', 'document', 'FileReader', 'Blob', 'CustomEvent', 'Event']) {
  if (!(key in globalThis) || key === 'window' || key === 'document') Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.Blob = dom.window.Blob;
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
for (const k of ['db_migration_complete', 'workflows_migration_complete', 'env_vars_migration_complete']) globalThis.window.localStorage.setItem(k, 'true');
globalThis.localStorage = globalThis.window.localStorage;

// ---- two backends on free ports ----------------------------------------------
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const TMP = fs.mkdtempSync(path.join('/tmp', 'tw-follow-'));   // short: Taskwarrior + unix paths
const S_DATA = path.join(TMP, 'server');       // the home server's volume (accounts)
const L_HOME = path.join(TMP, 'desktop-home'); // the desktop's HOME
const L_PROFILE = path.join(TMP, 'desktop-profile', 'backend'); // the profile's backend home
for (const d of [S_DATA, L_HOME, L_PROFILE]) fs.mkdirSync(d, { recursive: true });
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_') && k !== 'APP_AUTH_TOKEN' && k !== 'TASKRC' && k !== 'TASKDATA'));
const logs = { S: '', L: '' };
function backend(tag, port, env) {
  const child = spawn(PYTHON, ['app.py'], { cwd: path.join(REPO, 'backend'), env: { ...baseEnv, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { logs[tag] += d; });
  child.stderr.on('data', (d) => { logs[tag] += d; });
  return child;
}
const S_PORT = await freePort();
const L_PORT = await freePort();
const S = backend('S', S_PORT, {
  HOME: S_DATA, JACARIUM_AUTH_MODE: 'accounts',
  JACARIUM_REPORTS_ROOT: path.join(S_DATA, 'reports'),
  JACARIUM_KNOWN_HOSTS: path.join(S_DATA, '.ssh', 'known_hosts'),
});
const L = backend('L', L_PORT, {
  HOME: L_HOME, APP_AUTH_TOKEN: 'synthetic-app-token',
  JACARIUM_PROFILE_HOME: L_PROFILE, JACARIUM_ENV_FILE: path.join(L_PROFILE, '.jacarium.env'),
  JACARIUM_KNOWN_HOSTS: path.join(L_PROFILE, '.ssh', 'known_hosts'),
});
const S_URL = `http://127.0.0.1:${S_PORT}`;
const L_URL = `http://127.0.0.1:${L_PORT}`;
async function waitUp(url) {
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${url}/health`)).ok) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}
const stopAll = () => { for (const c of [S, L]) { try { c.kill('SIGTERM'); } catch { /* gone */ } } fs.rmSync(TMP, { recursive: true, force: true }); };
if (!(await waitUp(S_URL)) || !(await waitUp(L_URL))) { console.log('FAIL: a backend did not start\n' + logs.S.slice(-1200) + logs.L.slice(-1200)); stopAll(); process.exit(1); }

// ---- the account: one session per device -------------------------------------
const CSRF = { 'X-Requested-With': 'Jacarium', 'Content-Type': 'application/json' };
const setupCode = fs.readFileSync(path.join(S_DATA, 'setup-code'), 'utf8').trim();
async function session(body, pathName) {
  const r = await fetch(`${S_URL}${pathName}`, { method: 'POST', headers: CSRF, body: JSON.stringify(body) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error(`no cookie from ${pathName}: ${r.status} ${await r.text()}`);
  return cookie;
}
const cookieA = await session({ setupCode, username: 'alice', password: 'alices password' }, '/api/auth/setup');
const cookieB = await session({ username: 'alice', password: 'alices password' }, '/api/auth/login');
const me = await (await fetch(`${S_URL}/api/auth/me`, { headers: { ...CSRF, Cookie: cookieA } })).json();
const aliceHome = path.join(S_DATA, 'users', String(me.user.id));
const transportFor = (cookie) => ({ fetch: (p, init = {}) => fetch(`${S_URL}${p}`, { ...init, headers: { ...CSRF, ...(init.headers || {}), Cookie: cookie } }) });

// The app's own API calls (apiFetch) go through the global fetch: give the
// browser device its session cookie on S and the desktop device its app
// token on L, as the browser / the Electron bridge would.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const u = String(url);
  const headers = { ...(init.headers || {}) };
  if (u.startsWith(S_URL) && !headers.Cookie) headers.Cookie = cookieA;
  if (u.startsWith(L_URL)) headers['X-App-Token'] = 'synthetic-app-token';
  return realFetch(url, { ...init, headers });
};

// ---- bundle the app code twice (one module graph = one `db`) ----------------
const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-follow-bundle-'));
async function device(name, dbName, backendUrl) {
  const entry = path.join(WORK, `${name}-entry.mjs`);
  fs.writeFileSync(entry, `
    globalThis.__JACARIUM_DB_NAME = ${JSON.stringify(dbName)};
    export * as engine from '@worktree/src/sync/syncEngine.js';
    export * as follow from '@worktree/src/sync/taskwarriorFollow.js';
    export * as tasks from '@worktree/src/utils/tasks.js';
    export * as instances from '@worktree/src/utils/taskwarriorInstances.js';
    export * as importer from '@worktree/src/utils/importDatabase.js';
    export { db } from '@worktree/src/db/database.js';
  `);
  const out = path.join(WORK, `${name}.cjs`);
  await build({
    entryPoints: [entry], bundle: true, outfile: out, format: 'cjs', platform: 'node',
    loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx' },
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', 'globalThis.__JACARIUM_BACKEND_URL': JSON.stringify(backendUrl) },
    resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
    plugins: [{ name: 'alias', setup(b) {
      b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
      b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
    } }],
    logLevel: 'error',
  });
  const mod = req(out);
  await mod.db.open();
  return { name, ...mod };
}
const A = await device('A', 'Jacarium-follow-A', S_URL);
const B = await device('B', 'Jacarium-follow-B', L_URL);
await A.engine.startSync({ transport: transportFor(cookieA), listen: false, immediate: false });
await B.engine.startSync({ transport: transportFor(cookieB), listen: false, immediate: false });

// Both devices share this test's window, so the follower is driven by hand:
// the changes announced while THIS device synchronises go to ITS follower.
async function sync(d) {
  const applied = [];
  const listener = (e) => applied.push(...(e.detail?.changes || []));
  globalThis.window.addEventListener('syncApplied', listener);
  try { await d.engine.syncNow(); } finally { globalThis.window.removeEventListener('syncApplied', listener); }
  d.follow.queueApplied(applied, { schedule: false });
  await d.follow.flush();
  return applied;
}
const dirtyCount = (d) => d.db._syncState.where('dirty').equals(1).count();

// ---- the Taskwarrior instances on each side -----------------------------------
const RC = '~/.task/work/taskrc';
const DATA = '~/.task/work';
const twA = { rc: path.join(aliceHome, '.task', 'work', 'taskrc') };
const twB = { rc: path.join(L_PROFILE, '.task', 'work', 'taskrc') };
function cli(tw, args) {
  const r = spawnSync('task', [`rc:${tw.rc}`, 'rc.confirmation=off', 'rc.verbose=nothing', ...args], { encoding: 'utf8', env: { ...baseEnv, HOME: TMP } });
  if (r.status !== 0 && !/No matches|has no tasks/.test(r.stderr + r.stdout)) throw new Error(`task ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
const exportOf = (tw) => { const out = cli(tw, ['export']); return out.trim() ? JSON.parse(out) : []; };
// Taskwarrior stamps are whole seconds (20261014T010803Z); `task import` of an
// existing task re-stamps `modified` with the importing side's clock (3.4.x),
// so a stamp that came through an import is compared as a window: not older
// than the edit it carries, not in the future.
const stampMs = (s) => Date.parse(String(s).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
const stampBetween = (stamp, notBefore, notAfterMs = Date.now() + 1000) => Number.isFinite(stampMs(stamp)) && stampMs(stamp) >= stampMs(notBefore) && stampMs(stamp) <= notAfterMs;
const sameTask = (a, b) => !!a && !!b && a.uuid === b.uuid && a.description === b.description && a.status === b.status && JSON.stringify(a.tags || []) === JSON.stringify(b.tags || []) && (a.priority || '') === (b.priority || '') && (a.project || '') === (b.project || '');
const byUuid = (tw, uuid) => exportOf(tw).find((t) => t.uuid === uuid);
// the Tasks page's re-read of this device's Taskwarrior into its database
const reread = async (d) => {
  const inst = await d.db.taskwarriorInstances.where('name').equals('work').first();
  const r = await d.tasks.syncFromTaskWarrior(inst.id, inst.rcPath, inst.dataPath);
  if (!r.success) throw new Error(`re-read on ${d.name} failed: ${r.error}`);
};

try {
  // ---- 1: instance + tasks created on A (through its CLI) reach B's app and B's Taskwarrior ----
  const init = await A.instances.initializeInstance(DATA, RC, {});
  check('A initialises the "work" instance under the account home on the server', init?.success === true && fs.existsSync(twA.rc), JSON.stringify(init).slice(0, 160));
  await A.instances.createInstance({ name: 'work', rcPath: RC, dataPath: DATA, isActive: true });
  cli(twA, ['add', 'Buy milk', 'project:home', '+errand']);
  cli(twA, ['add', 'Write the report', 'project:work', 'priority:M']);
  const uuids = exportOf(twA).map((t) => t.uuid);
  await reread(A);
  check('1. A has the two rows after its re-read, keyed by uuid', (await A.db.tasks.count()) === 2 && (await A.db._syncState.get(['tasks', uuids[0]])) != null, `${await A.db.tasks.count()}`);
  await sync(A);
  const appliedB = await sync(B);
  const instB = await B.db.taskwarriorInstances.where('name').equals('work').first();
  check('1. the instance row reached B (its own local id, same paths)', instB && instB.rcPath === RC && instB.dataPath === DATA, JSON.stringify(instB)?.slice(0, 160));
  check('1. B applied the instance and both tasks', appliedB.filter((c) => c.collection === 'tasks').length === 2 && appliedB.some((c) => c.collection === 'taskwarriorInstances'), JSON.stringify(appliedB.map((c) => c.collection)));
  check("1. B's instance was initialised under the desktop profile's home", fs.existsSync(twB.rc) && fs.existsSync(path.join(L_PROFILE, '.task', 'work')), twB.rc);
  const milkB = byUuid(twB, uuids[0]);
  check("1. ...and the tasks are in B's Taskwarrior with the same uuid, project, tag", milkB?.description === 'Buy milk' && milkB.project === 'home' && (milkB.tags || []).includes('errand'), JSON.stringify(milkB)?.slice(0, 200));
  check('1. B holds the tasks under ITS instance id', (await B.db.tasks.where('instanceId').equals(instB.id).count()) === 2);
  check('1. the follower counted 2 imports and 1 initialisation', B.follow.getTaskwarriorFollowStats().imported === 2 && B.follow.getTaskwarriorFollowStats().initialised === 1, JSON.stringify(B.follow.getTaskwarriorFollowStats()));

  // ---- 2: modified on B's CLI -> A's Taskwarrior, same uuid, modification stamp preserved ----
  await sleep(1100);   // Taskwarrior stamps whole seconds
  cli(twB, [uuids[0], 'modify', 'priority:H', 'due:tomorrow']);
  const modifiedOnB = byUuid(twB, uuids[0]).modified;
  await reread(B);
  await sync(B);
  await sync(A);
  const milkA = byUuid(twA, uuids[0]);
  check("2. the modification made on B is in A's Taskwarrior", milkA?.priority === 'H' && !!milkA.due, JSON.stringify(milkA)?.slice(0, 200));
  check("2. ...as B's version of the task (same uuid, description, status, tags, priority), its stamp not older than B's edit and not in the future", sameTask(milkA, byUuid(twB, uuids[0])) && stampBetween(milkA?.modified, modifiedOnB), `${milkA?.modified} vs B's edit ${modifiedOnB}`);
  check('2. A still has exactly one row per uuid (no duplicate from the round trip)', (await A.db.tasks.where('uuid').equals(uuids[0]).count()) === 1 && (await A.db.tasks.count()) === 2);
  check('2. the app row on A carries the new priority', (await A.db.tasks.where('uuid').equals(uuids[0]).first())?.priority === 'H');

  // ---- 3: completed on A -> completed on B ----
  await sleep(1100);
  cli(twA, [uuids[1], 'done']);
  await reread(A);
  await sync(A);
  await sync(B);
  check("3. a task completed on A is completed in B's Taskwarrior", byUuid(twB, uuids[1])?.status === 'completed', JSON.stringify(byUuid(twB, uuids[1]))?.slice(0, 160));

  // ---- 4: no ping-pong ----
  await reread(A); await reread(B);
  check('4. a re-read that changes nothing marks nothing dirty on A', (await dirtyCount(A)) === 0, `${await dirtyCount(A)}`);
  check('4. ...nor on B', (await dirtyCount(B)) === 0, `${await dirtyCount(B)}`);
  const statusBefore = await (await transportFor(cookieA).fetch('/api/sync/status')).json();
  await sync(A); await sync(B); await reread(A); await reread(B); await sync(A); await sync(B);
  const statusAfter = await (await transportFor(cookieA).fetch('/api/sync/status')).json();
  check('4. another round of re-reads and syncs pushes nothing to the server (latest revision unchanged)', statusAfter.latest === statusBefore.latest && statusAfter.records === statusBefore.records, `${JSON.stringify(statusBefore)} -> ${JSON.stringify(statusAfter)}`);

  // ---- 5: concurrent edits on both CLIs: the newer wins in both Taskwarriors ----
  await sleep(1100);
  cli(twA, [uuids[0], 'modify', 'description:Buy milk and bread']);   // older
  await sleep(1100);
  cli(twB, [uuids[0], 'modify', '+urgent']);                             // newer
  await reread(A); await reread(B);
  await sync(A);   // A pushes first
  await sync(B);   // B's push conflicts but is newer -> wins
  await sync(A);   // A takes B's version into its Taskwarrior
  const afterA = byUuid(twA, uuids[0]);
  const afterB = byUuid(twB, uuids[0]);
  check("5. B's newer edit is in A's Taskwarrior", (afterA?.tags || []).includes('urgent'), JSON.stringify(afterA)?.slice(0, 200));
  check("5. both Taskwarriors agree on the task (B's newer version on both sides; A's stamp not older than B's edit)", sameTask(afterA, afterB) && (afterA?.tags || []).includes('urgent') && stampBetween(afterA?.modified, afterB?.modified), `${afterA?.description} ${afterA?.modified} / ${afterB?.description} ${afterB?.modified}`);
  check('5. ...and the older concurrent edit was kept as a version on the server', ((await (await transportFor(cookieA).fetch(`/api/sync/versions?collection=tasks&key=${uuids[0]}`)).json()).versions || []).some((v) => v.body?.description === 'Buy milk and bread'));

  // ---- 6: purged on A -> purged on B ----
  cli(twA, [uuids[1], 'delete']);
  await reread(A); await sync(A); await sync(B);
  check("6. a deletion on A deletes in B's Taskwarrior", byUuid(twB, uuids[1])?.status === 'deleted', JSON.stringify(byUuid(twB, uuids[1]))?.slice(0, 120));
  cli(twA, [uuids[1], 'purge']);
  await reread(A);
  check('6. the purge leaves a tombstone on A', (await A.db._syncState.get(['tasks', uuids[1]]))?.deleted === 1 && (await A.db.tasks.where('uuid').equals(uuids[1]).count()) === 0);
  await sync(A); await sync(B);
  check("6. the task is gone from B's Taskwarrior and B's app", !byUuid(twB, uuids[1]) && (await B.db.tasks.where('uuid').equals(uuids[1]).count()) === 0, JSON.stringify(exportOf(twB).map((t) => t.uuid)));
  check('6. B remembers it as purged (a stale export cannot bring it back)', B.tasks.getPurgedTaskUUIDs().includes(uuids[1]));
  check('6. the remaining task is untouched on both sides', byUuid(twA, uuids[0]) && byUuid(twB, uuids[0]));
  // 7. rows that reached a device while NO follower was listening (an import, a link made with an earlier
  //    version, a CLI missing at the time) are reconciled by reapplyAll() - idempotently
  console.log('\n--- 7. reconciliation of rows applied without a follower ---');
  const opsInst = await A.instances.createInstance({ name: 'ops', category: 'General', rcPath: '~/.task/ops/taskrc', dataPath: '~/.task/ops', isActive: false });
  const initOps = await A.instances.initializeInstance('~/.task/ops', '~/.task/ops/taskrc', {});
  check('7. A initialises a second instance "ops"', initOps?.success === true, JSON.stringify(initOps).slice(0, 120));
  const twAops = { rc: path.join(aliceHome, '.task', 'ops', 'taskrc') };
  cli(twAops, ['add', 'Rotate the certificate', 'project:ops']);
  cli(twAops, ['add', 'Check the backups', 'project:ops']);
  const opsUuids = exportOf(twAops).map((t) => t.uuid);
  const rOps = await A.tasks.syncFromTaskWarrior(opsInst.id, '~/.task/ops/taskrc', '~/.task/ops');
  check('7. A re-read the two ops tasks into its database', rOps.success && (await A.db.tasks.where('instanceId').equals(opsInst.id).count()) === 2);
  await A.engine.syncNow();
  // B synchronises with its follower NOT fed (as before this version, or with the CLI missing at the time)
  await B.engine.syncNow();
  const twBops = { rc: path.join(L_PROFILE, '.task', 'ops', 'taskrc') };
  check('7. B has the ops instance and tasks in its database but nothing in its Taskwarrior yet', (await B.db.taskwarriorInstances.where('name').equals('ops').count()) === 1 && (await B.db.tasks.where('uuid').equals(opsUuids[0]).count()) === 1 && !fs.existsSync(twBops.rc));
  const rec1 = await B.follow.reapplyAll();
  check('7. reapplyAll initialises "ops" under the desktop profile and imports the two tasks', rec1.initialised === 1 && rec1.imported === 2 && rec1.errors.length === 0 && fs.existsSync(twBops.rc) && byUuid(twBops, opsUuids[0])?.description === 'Rotate the certificate' && byUuid(twBops, opsUuids[1]), JSON.stringify(rec1));
  check('7. ...and leaves the "work" instance alone (its tasks were already there: skipped, not re-imported)', rec1.instances === 2 && rec1.skipped >= 1, JSON.stringify(rec1));
  const countBefore = exportOf(twBops).length;
  const rec2 = await B.follow.reapplyAll();
  check('7. a second run pushes nothing (idempotent, no duplicates)', rec2.imported === 0 && rec2.initialised === 0 && rec2.errors.length === 0 && exportOf(twBops).length === countBefore && exportOf(twBops).filter((t) => t.uuid === opsUuids[0]).length === 1, JSON.stringify(rec2));
  await reread(B); await sync(B); await sync(A);
  check('7. the reconciliation did not create a sync storm (nothing dirty on either side afterwards)', (await dirtyCount(A)) === 0 && (await dirtyCount(B)) === 0);

  // 8. an instance whose paths point at another machine (an old export's absolute paths) is rewritten once
  //    to ~/.task/<name>, initialised there, and the rewrite synchronises once (no ping-pong)
  console.log('\n--- 8. foreign absolute instance paths are rewritten once ---');
  const legacy = await A.instances.createInstance({ name: 'Legacy Box', category: 'General', rcPath: '/Users/someone/.config/support-console-work/backend/.taskrc', dataPath: '/Users/someone/.config/support-console-work/backend/.task', isActive: false });
  await A.db.tasks.add({ uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', description: 'Carried over task', status: 'pending', entry: new Date().toISOString(), modified: new Date().toISOString(), instanceId: legacy.id, tags: [] });
  await A.engine.syncNow();
  const appliedLegacy = await sync(B);
  check('8. B received the instance with the foreign paths', appliedLegacy.some((c) => c.collection === 'taskwarriorInstances' && c.row?.name === 'Legacy Box'));
  const legacyB = await B.db.taskwarriorInstances.where('name').equals('Legacy Box').first();
  check('8. B rewrote the paths to ~/.task/legacy-box (+ .taskrc, the rc keeps its name) in its database', legacyB?.dataPath === '~/.task/legacy-box' && legacyB?.rcPath === '~/.task/legacy-box/.taskrc', String(JSON.stringify(legacyB)).slice(0, 200));
  const twBlegacy = { rc: path.join(L_PROFILE, '.task', 'legacy-box', '.taskrc') };
  check('8. ...initialised it there and imported the task; nothing was created at the old path', fs.existsSync(twBlegacy.rc) && byUuid(twBlegacy, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')?.description === 'Carried over task' && !fs.existsSync('/Users/someone/.config/support-console-work'), twBlegacy.rc);
  check('8. the follower counted one rewrite', B.follow.getTaskwarriorFollowStats().rewritten === 1);
  await sync(B); await sync(A);
  const legacyA = await A.db.taskwarriorInstances.where('name').equals('Legacy Box').first();
  check('8. the rewritten paths reached A (one synchronised rewrite)', legacyA?.dataPath === '~/.task/legacy-box' && legacyA?.rcPath === '~/.task/legacy-box/.taskrc', String(JSON.stringify(legacyA)).slice(0, 200));
  await sync(A); await sync(B);
  check('8. no ping-pong: nothing dirty on either side after another round', (await dirtyCount(A)) === 0 && (await dirtyCount(B)) === 0 && B.follow.getTaskwarriorFollowStats().rewritten === 1);

  // 9. Import Database on the server (the browser): the account's Taskwarrior gets the instance and the
  //    tasks by itself; the linked desktop creates the same ~-relative paths and gets the tasks on its pull;
  //    an instance that already has its rc and data is not overwritten; a second import adds nothing twice
  console.log('\n--- 9. an old export imported on the server reaches both Taskwarriors ---');
  const importFile = { version: '1.0', formatVersion: 2, documents: [], documentTemplates: [], jqlTemplates: [], engineTemplates: [],
    taskwarriorInstances: [{ id: 7, name: 'Imported', category: 'General', rcPath: '/data/users/old/.config/support-console-main/backend/.taskrc', dataPath: '/data/users/old/.config/support-console-main/backend/.task', isActive: 0 }],
    taskwarriorTasks: { Imported: [
      { uuid: '12121212-3434-4565-8787-909090909090', description: 'Imported task one', status: 'pending', entry: '20260901T080000Z', modified: '20260901T080000Z', project: 'import' },
      { uuid: '13131313-3434-4565-8787-909090909090', description: 'Imported task two', status: 'pending', entry: '20260901T080100Z', modified: '20260901T080100Z' },
    ] } };
  const m9 = await A.importer.mergeImportDatabase(importFile);
  const impA = await A.db.taskwarriorInstances.where('name').equals('Imported').first();
  check('9. the import rewrote the foreign paths to ~/.task/imported/.taskrc', impA?.dataPath === '~/.task/imported' && impA?.rcPath === '~/.task/imported/.taskrc', String(JSON.stringify(impA)).slice(0, 200));
  check('9. the two tasks are in the server device database under that instance', (await A.db.tasks.where('instanceId').equals(impA.id).count()) === 2, String(JSON.stringify(m9.tasks || m9.taskwarriorTasks || m9)).slice(0, 160));
  const recA = await A.follow.reapplyAll();   // what the Import dialog runs when it closes
  const twAimp = { rc: path.join(aliceHome, '.task', 'imported', '.taskrc') };
  check("9. the server initialised ~/.task/imported under the account's home and imported both tasks", recA.errors.length === 0 && fs.existsSync(twAimp.rc) && fs.existsSync(path.join(aliceHome, '.task', 'imported')) && byUuid(twAimp, '12121212-3434-4565-8787-909090909090')?.description === 'Imported task one' && byUuid(twAimp, '13131313-3434-4565-8787-909090909090'), JSON.stringify(recA));
  await reread(A); await A.engine.syncNow();
  await sync(B);
  const twBimp = { rc: path.join(L_PROFILE, '.task', 'imported', '.taskrc') };
  check('9. the desktop created the same relative paths under its home and has both tasks', fs.existsSync(twBimp.rc) && fs.existsSync(path.join(L_PROFILE, '.task', 'imported')) && byUuid(twBimp, '12121212-3434-4565-8787-909090909090')?.project === 'import' && byUuid(twBimp, '13131313-3434-4565-8787-909090909090'), twBimp.rc);
  const rcBefore = fs.readFileSync(twBimp.rc, 'utf8') + '# kept by the user\n';
  fs.writeFileSync(twBimp.rc, rcBefore);
  const m9b = await A.importer.mergeImportDatabase(importFile);
  const recA2 = await A.follow.reapplyAll();
  await A.engine.syncNow(); await sync(B);
  const recB2 = await B.follow.reapplyAll();
  check('9. a second import of the same file adds nothing (merge skips, nothing imported into either Taskwarrior)', (m9b.taskwarriorInstances?.created || 0) === 0 && recA2.imported === 0 && recB2.imported === 0 && exportOf(twAimp).length === 2 && exportOf(twBimp).length === 2, JSON.stringify({ recA2, recB2 }).slice(0, 200));
  check('9. an instance that already has its rc and data is left as it is (the rc kept the user\'s line)', fs.readFileSync(twBimp.rc, 'utf8') === rcBefore);

  check('no follower errors in the whole run', A.follow.getTaskwarriorFollowStats().errors === 0 && B.follow.getTaskwarriorFollowStats().errors === 0, JSON.stringify([A.follow.getTaskwarriorFollowStats(), B.follow.getTaskwarriorFollowStats()]));
} catch (error) {
  check('the scenario ran to the end', false, error.stack || error.message);
  console.log(logs.S.slice(-1500)); console.log(logs.L.slice(-1500));
} finally {
  A.engine.stopSync(); B.engine.stopSync();
  stopAll();
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
