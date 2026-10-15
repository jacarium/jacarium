/**
 * Taskwarrior follows the account.
 *
 * The app's Tasks page works CLI-first: every change goes to Taskwarrior
 * and the page re-reads `task export` into db.tasks, which synchronises
 * with the home server like every other table (src/sync/syncEngine.js; a
 * task's identity is its Taskwarrior uuid). This module closes the loop on
 * the receiving side: whenever the engine applies task rows that came from
 * another device, they are imported into THIS device's Taskwarrior (the
 * instance of the same name - initialised under ~/.task/<name> when it does
 * not exist here yet), and a task purged elsewhere is purged here too.
 *
 * `task import` is idempotent by uuid, so applying the same rows twice is
 * harmless; the tracker ignores a re-read that changes nothing, so two
 * devices never hand the same rows back and forth.
 *
 * Two more duties: (1) an instance whose paths point at another machine
 * (absolute paths from an old export) is rewritten once to ~/.task/<name>
 * before it is used here (src/utils/taskwarriorPaths.js) - a tracked
 * update, so the rewrite synchronises once; (2) `reapplyAll()` reconciles
 * everything already in the database with this device's Taskwarrior: rows
 * that arrived while no follower was listening (an import, a link made
 * before this version, a CLI that was not found at the time) are imported
 * now, idempotently - only tasks the CLI does not have, or has in an older
 * modification, are pushed. It runs once at start and on demand (Settings >
 * General > Taskwarrior).
 */
import { db } from '../db/database';
import { addPurgedTaskUUIDs, pushTaskWarriorTasks, purgeTaskWarriorTask, toTaskWarriorJson, fetchTaskWarriorTasks, convertTaskWarriorTimestamp } from '../utils/tasks';
import { initializeInstance, validateInstance, updateInstance } from '../utils/taskwarriorInstances';
import { normaliseInstancePaths, isAbsoluteTaskPath } from '../utils/taskwarriorPaths';

let started = false;
let queue = [];
let timer = null;
let cliMissingWarned = false;
const stats = { imported: 0, purged: 0, initialised: 0, errors: 0, rewritten: 0 };
let reconcileTimer = null;

export function getTaskwarriorFollowStats() {
  return { ...stats };
}

/** Queue applied changes (the engine's syncApplied detail.changes). Exported for tests. */
export function queueApplied(changes, { schedule = true } = {}) {
  for (const entry of changes || []) {
    if (entry.collection === 'tasks' || entry.collection === 'taskwarriorInstances') queue.push(entry);
  }
  if (schedule && queue.length && !timer) timer = setTimeout(() => { timer = null; flush().catch((error) => console.error('[Taskwarrior follow] failed:', error)); }, 300);
}

function onSyncApplied(event) {
  queueApplied(event?.detail?.changes || []);
}

/** The instance with this device's paths: another machine's path is rewritten once in the database (`force`: any absolute path, after it failed to validate here). */
async function localInstance(instance, { force = false } = {}) {
  const { row, rewritten } = normaliseInstancePaths(instance, force ? { foreign: isAbsoluteTaskPath } : {});
  if (!rewritten) return instance;
  try {
    await updateInstance(instance.id, { rcPath: row.rcPath, dataPath: row.dataPath });
    stats.rewritten += 1;
    console.info(`[Taskwarrior follow] "${instance.name}": paths from another machine replaced by ${row.dataPath}`);
  } catch (error) {
    console.error(`[Taskwarrior follow] could not rewrite the paths of "${instance.name}":`, error.message);
  }
  return row;
}

async function instanceReady(input) {
  if (!input || !input.dataPath) return false;
  let instance = await localInstance(input);
  try {
    let result = await validateInstance(instance.rcPath || null, instance.dataPath);
    if (result?.valid) return true;
    // an absolute path that does not exist here (another machine's): this device's ~/.task/<name> instead
    if (isAbsoluteTaskPath(instance.dataPath)) {
      instance = await localInstance(instance, { force: true });
      result = await validateInstance(instance.rcPath || null, instance.dataPath);
      if (result?.valid) return true;
    }
    // the instance arrived from another device: create its directory and rc here
    await initializeInstance(instance.dataPath, instance.rcPath || '', {});
    stats.initialised += 1;
    return true;
  } catch (error) {
    if (!cliMissingWarned) {
      cliMissingWarned = true;
      console.warn('[Taskwarrior follow] Taskwarrior is not available here; synchronised tasks stay in the app only:', error.message);
    }
    return false;
  }
}

/** Apply the queued task changes to this device's Taskwarrior. Exported for tests. */
export async function flush() {
  const batch = queue;
  queue = [];
  if (!batch.length) return stats;
  const instances = new Map();
  const upserts = new Map();      // instanceId -> rows
  const purges = new Map();       // instanceId -> uuids
  for (const entry of batch) {
    if (entry.collection === 'taskwarriorInstances' && !entry.deleted && entry.row) {
      instances.set(entry.row.id, entry.row);
      continue;
    }
    if (entry.collection !== 'tasks' || !entry.row) continue;
    const instanceId = entry.row.instanceId;
    if (instanceId == null) continue;
    if (entry.deleted) {
      if (!purges.has(instanceId)) purges.set(instanceId, []);
      purges.get(instanceId).push(entry.row.uuid || entry.key);
    } else {
      if (!upserts.has(instanceId)) upserts.set(instanceId, []);
      upserts.get(instanceId).push(entry.row);
    }
  }
  const instanceIds = new Set([...instances.keys(), ...upserts.keys(), ...purges.keys()]);
  for (const instanceId of instanceIds) {
    let instance = instances.get(instanceId) || await db.taskwarriorInstances.get(instanceId);
    if (!instance) continue;
    if (!(await instanceReady(instance))) continue;
    instance = (await db.taskwarriorInstances.get(instanceId)) || instance;   // the paths may have been rewritten
    const rows = upserts.get(instanceId) || [];
    if (rows.length) {
      try {
        await pushTaskWarriorTasks(rows.map(toTaskWarriorJson), instance.rcPath || null, instance.dataPath || null);
        stats.imported += rows.length;
      } catch (error) {
        stats.errors += 1;
        console.error(`[Taskwarrior follow] importing ${rows.length} task(s) into "${instance.name}" failed:`, error.message);
      }
    }
    for (const uuid of purges.get(instanceId) || []) {
      if (!uuid) continue;
      addPurgedTaskUUIDs([uuid]);
      const result = await purgeTaskWarriorTask({ uuid }, instance.rcPath || null, instance.dataPath || null);
      if (result?.success) stats.purged += 1; else stats.errors += 1;
    }
  }
  return stats;
}

/**
 * Reconcile every instance and task in the database with this device's
 * Taskwarrior: instances get initialised here when missing, tasks the CLI
 * does not know (or knows in an older modification) are imported. Idempotent;
 * a second run pushes nothing. Returns the counts.
 */
export async function reapplyAll() {
  const result = { instances: 0, initialised: 0, imported: 0, skipped: 0, errors: [], unavailable: false };
  const before = stats.initialised;
  for (const stored of await db.taskwarriorInstances.toArray()) {
    if (!stored.dataPath) continue;
    result.instances += 1;
    if (!(await instanceReady(stored))) { result.unavailable = cliMissingWarned; continue; }
    const instance = (await db.taskwarriorInstances.get(stored.id)) || stored;
    const rows = await db.tasks.where('instanceId').equals(instance.id).toArray();
    if (!rows.length) continue;
    try {
      const known = new Map();
      for (const t of await fetchTaskWarriorTasks(instance.rcPath || null, instance.dataPath || null)) known.set(String(t.uuid).toLowerCase(), convertTaskWarriorTimestamp(t.modified) || t.modified || '');
      const missing = rows.filter((row) => {
        const have = known.get(String(row.uuid || '').toLowerCase());
        if (have === undefined) return true;
        // Taskwarrior stamps to the second; the app's rows may carry milliseconds
        const seconds = (value) => Math.floor(Date.parse(String(value || '')) / 1000);
        const mine = seconds(row.modified);
        const theirs = seconds(have);
        return Number.isFinite(mine) && Number.isFinite(theirs) && mine > theirs;
      });
      result.skipped += rows.length - missing.length;
      if (missing.length) {
        await pushTaskWarriorTasks(missing.map(toTaskWarriorJson), instance.rcPath || null, instance.dataPath || null);
        result.imported += missing.length;
        stats.imported += missing.length;
      }
    } catch (error) {
      stats.errors += 1;
      result.errors.push(`${instance.name}: ${error.message}`);
      console.error(`[Taskwarrior follow] reconciling "${instance.name}" failed:`, error.message);
    }
  }
  result.initialised = stats.initialised - before;
  return result;
}
export const reapplyTasksToTaskwarrior = reapplyAll;

export function startTaskwarriorFollow({ reconcile = true } = {}) {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('syncApplied', onSyncApplied);
  // what is already in the database (rows applied before this follower ran) catches up once
  if (reconcile && !reconcileTimer) reconcileTimer = setTimeout(() => { reconcileTimer = null; reapplyAll().catch((error) => console.error('[Taskwarrior follow] reconcile failed:', error)); }, 5000);
}

export function stopTaskwarriorFollow() {
  if (!started) return;
  started = false;
  window.removeEventListener('syncApplied', onSyncApplied);
  if (reconcileTimer) { clearTimeout(reconcileTimer); reconcileTimer = null; }
  if (timer) { clearTimeout(timer); timer = null; }
  queue = [];
}
