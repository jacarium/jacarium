/**
 * TaskWarrior side of the database backup (File > Database > Export /
 * Import): format helpers, the export collector and the pure planner the
 * import uses to diff a backup against the CLI.
 *
 * WHY TASKS ARE NOT PLAIN DATABASE ROWS IN THE BACKUP
 *
 * For every instance with a working CLI the TaskWarrior data files are the
 * source of truth: the Tasks page re-syncs from `task export` whenever an
 * instance opens, every mutation goes CLI-first, and the sync removes
 * local rows the CLI no longer has. db.tasks is a cache of that, plus one
 * piece of app-only state - the purge list (uuids the user permanently
 * deleted here; see tasks.js getPurgedTaskUUIDs). So the backup carries
 * tasks the way TaskWarrior itself exchanges them:
 *
 *   formatVersion: 2
 *   taskwarriorInstances: [...rows]            name is the cross-machine
 *                                              identity; rcPath/dataPath are
 *                                              hints (another machine's
 *                                              filesystem)
 *   taskwarriorTasks: { "<instance name>": [ TaskWarrior JSON task, ... ] }
 *                                              `task export` (every status)
 *                                              of that instance when the CLI
 *                                              answered, otherwise the
 *                                              db.tasks rows converted with
 *                                              the same mapping the sync
 *                                              pushes (toTaskWarriorJson)
 *   taskwarriorTasksSource: { "<instance name>": "cli" | "db" }
 *   taskTombstones: [uuid, ...]                the purge list
 *   taskwarriorReports: [...rows + instanceName]
 *
 * Files without `taskwarriorTasks` (format 1: a flat `tasks` array of app
 * rows with numeric instanceIds) are still imported through the database
 * merge in importDatabase.js.
 *
 * Import identity/recency: uuid, and TaskWarrior's `modified` (the CLI
 * maintains it; the app's updatedAt does not exist for tasks). Deletions
 * are tombstones: a `status: deleted` copy that is newer than the local
 * live copy marks it deleted, a uuid in taskTombstones is marked deleted
 * here too and joins the local purge list, and a uuid on the LOCAL purge
 * list is never resurrected from a backup.
 */
import {
  getPurgedTaskUUIDs,
  fetchTaskWarriorTasks,
  toTaskWarriorJson,
  convertToTaskWarriorTimestamp,
} from './tasks';

export const BACKUP_FORMAT_VERSION = 2;

/** True for a format-2 file: tasks carried per instance as TaskWarrior JSON. */
export function hasTaskwarriorTasks(importData) {
  const t = importData?.taskwarriorTasks;
  return t !== null && typeof t === 'object' && !Array.isArray(t);
}

/** Number of TaskWarrior JSON tasks a format-2 file carries (all instances). */
export function countTaskwarriorTasks(importData) {
  if (!hasTaskwarriorTasks(importData)) return 0;
  return Object.values(importData.taskwarriorTasks)
    .reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
}

/** The instance name a backup files an instance's tasks under. */
export function instanceKey(instance) {
  const name = typeof instance?.name === 'string' ? instance.name.trim() : '';
  return name || 'New Instance'; // createInstance()'s default name
}

/**
 * A TaskWarrior (YYYYMMDDTHHMMSSZ), ISO or numeric timestamp as
 * milliseconds, or null when absent/unparseable.
 */
export function twMillis(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  const iso = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : value;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const uuidOf = (t) => (typeof t?.uuid === 'string' && t.uuid.trim() ? t.uuid.trim().toLowerCase() : null);

/** Human label for a task in the statistics: description, status suffix when not pending. */
export function taskLabel(t) {
  const desc = (typeof t?.description === 'string' && t.description.trim()) || uuidOf(t) || '';
  const status = (typeof t?.status === 'string' && t.status.trim()) || 'pending';
  return status === 'pending' ? desc : `${desc} (${status})`;
}

/**
 * "2 pending, 1 completed, 3 deleted" for a list of TaskWarrior JSON tasks.
 * The three main statuses are always listed (so a line of only deleted
 * tasks reads as such); any other status (waiting, recurring) follows when
 * present. Deleted tasks are part of `task export` (status.any) and of the
 * backup: they are the tombstones a merge needs, and the Tasks page only
 * shows them in its Deleted section (never when the app purged them).
 */
export function describeStatuses(rows) {
  const counts = new Map([['pending', 0], ['completed', 0], ['deleted', 0]]);
  for (const t of rows || []) {
    const status = (typeof t?.status === 'string' && t.status.trim()) || 'pending';
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  const parts = [...counts.entries()]
    .filter(([status, n]) => n > 0 || ['pending', 'completed', 'deleted'].includes(status))
    .map(([status, n]) => `${n} ${status}`);
  const deleted = counts.get('deleted');
  return parts.join(', ') + (deleted > 0 ? '; deleted tasks are kept as tombstones for merges' : '');
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/**
 * Collect the TaskWarrior section of a backup.
 *
 * @param {Object} args
 * @param {Object[]} args.instances - db.taskwarriorInstances rows
 * @param {Object[]} args.tasks - db.tasks rows (the cache; fallback source)
 * @param {Object[]} args.reports - db.taskwarriorReports rows
 * @param {Function} [args.report] - progress callback ({ log, logType })
 * @param {Function} [args.fetchTasks] - test seam; defaults to fetchTaskWarriorTasks
 * @returns {Promise<{ taskwarriorTasks, taskwarriorTasksSource, taskTombstones, taskwarriorReports }>}
 */
export async function collectTaskwarriorBackup({ instances, tasks, reports, report, fetchTasks = fetchTaskWarriorTasks }) {
  const log = (message, logType) => report?.({ log: message, ...(logType ? { logType } : {}) });
  const taskwarriorTasks = {};
  const taskwarriorTasksSource = {};
  const instanceNameById = new Map();

  for (const instance of instances || []) {
    const key = instanceKey(instance);
    instanceNameById.set(instance.id, key);
    const cached = () => (tasks || [])
      .filter((t) => t.instanceId === instance.id && uuidOf(t))
      .map(toTaskWarriorJson);
    let rows;
    let source;
    try {
      const fetched = await fetchTasks(instance.rcPath || null, instance.dataPath || null);
      if (Array.isArray(fetched)) {
        rows = fetched;
        source = 'cli';
      } else {
        // a caller that declines the CLI read (the sync engine's safety
        // snapshot passes a fetchTasks that answers null) gets the cached rows
        rows = cached();
        source = 'db';
      }
    } catch (error) {
      rows = cached();
      source = 'db';
      log(`TaskWarrior CLI not reachable for "${key}" (${error?.message || error}); exported the app's ${rows.length} cached tasks instead`, 'warning');
    }
    // Two instances with the same name file their tasks together (the
    // import matches instances by name, so they would merge anyway).
    taskwarriorTasks[key] = [...(taskwarriorTasks[key] || []), ...rows];
    taskwarriorTasksSource[key] = taskwarriorTasksSource[key] === 'db' ? 'db' : source;
    log(`Read ${rows.length} task${rows.length === 1 ? '' : 's'} for "${key}" from ${source === 'cli' ? 'the TaskWarrior CLI' : 'the app database'} (${describeStatuses(rows)})`);
  }

  const orphans = (tasks || []).filter((t) => !instanceNameById.has(t.instanceId));
  if (orphans.length > 0) {
    log(`${orphans.length} cached task${orphans.length === 1 ? '' : 's'} belong to no TaskWarrior instance and are not visible in the app; not exported`, 'warning');
  }

  const taskwarriorReports = (reports || [])
    .filter((r) => instanceNameById.has(r.instanceId))
    .map((r) => ({ ...r, instanceName: instanceNameById.get(r.instanceId) }));

  return {
    taskwarriorTasks,
    taskwarriorTasksSource,
    taskTombstones: [...new Set(getPurgedTaskUUIDs().filter((u) => typeof u === 'string' && u))],
    taskwarriorReports,
  };
}

/* ------------------------------------------------------------------ */
/* Import planning (CLI path)                                          */
/* ------------------------------------------------------------------ */

/**
 * Decide what a backup does to one instance's TaskWarrior data. Pure: the
 * dry run and the real run call this with the same inputs and act (or not)
 * on `toPush` / `newTombstones`.
 *
 * @param {Object} args
 * @param {Object[]} args.fileTasks - TaskWarrior JSON tasks from the backup
 * @param {Object[]} args.localTasks - `task export` of the local instance
 * @param {Iterable<string>} args.purged - local purge list (never resurrected)
 * @param {Iterable<string>} args.tombstones - backup's taskTombstones
 * @param {Date} [args.now]
 * @returns {{
 *   decisions: Array<{ uuid: string|null, label: string,
 *     outcome: 'created'|'updated'|'tombstoned'|'skipped'|'purgedHere'|'invalid',
 *     status: string, reason?: string }>,
 *   toPush: Object[],        // TaskWarrior JSON to hand to `task import`
 *   newTombstones: string[], // uuids to add to the local purge list
 * }}
 */
export function planCliTasks({ fileTasks, localTasks, purged, tombstones, now = new Date() }) {
  const purgedSet = new Set([...(purged || [])].map((u) => String(u).toLowerCase()));
  const tombstoneSet = new Set([...(tombstones || [])].filter((u) => typeof u === 'string' && u).map((u) => u.toLowerCase()));
  const localByUuid = new Map();
  for (const t of localTasks || []) {
    const uuid = uuidOf(t);
    if (uuid && !localByUuid.has(uuid)) localByUuid.set(uuid, t);
  }

  const decisions = [];
  const toPush = [];
  const seen = new Set();
  const decide = (uuid, label, outcome, status, reason) => {
    decisions.push({ uuid, label, outcome, status, ...(reason ? { reason } : {}) });
  };

  for (const t of fileTasks || []) {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      decide(null, '', 'invalid', 'pending', 'not a task object');
      continue;
    }
    const label = taskLabel(t);
    const status = (typeof t.status === 'string' && t.status.trim()) || 'pending';
    const uuid = uuidOf(t);
    if (!uuid) {
      decide(null, label, 'invalid', status, 'task has no uuid');
      continue;
    }
    if (seen.has(uuid)) {
      decide(uuid, label, 'skipped', status, 'duplicate uuid in the file');
      continue;
    }
    seen.add(uuid);
    if (purgedSet.has(uuid)) {
      decide(uuid, label, 'purgedHere', status);
      continue;
    }
    if (tombstoneSet.has(uuid)) {
      // The file itself says this task was purged on the exporting machine;
      // handled with the tombstones below.
      decide(uuid, label, 'skipped', status, 'purged on the exporting machine');
      continue;
    }
    const local = localByUuid.get(uuid);
    if (!local) {
      decide(uuid, label, 'created', status);
      toPush.push(t);
      continue;
    }
    const fileMod = twMillis(t.modified ?? t.entry);
    const localMod = twMillis(local.modified ?? local.entry);
    if (fileMod != null && localMod != null && fileMod > localMod) {
      const localStatus = (typeof local.status === 'string' && local.status) || 'pending';
      if (status === 'deleted' && localStatus !== 'deleted') {
        decide(uuid, label, 'tombstoned', status);
      } else {
        decide(uuid, label, 'updated', status);
      }
      toPush.push(t);
    } else {
      decide(uuid, label, 'skipped', status);
    }
  }

  const nowTW = convertToTaskWarriorTimestamp(now.toISOString());
  const newTombstones = [];
  for (const uuid of tombstoneSet) {
    if (purgedSet.has(uuid)) continue; // already a tombstone here
    newTombstones.push(uuid);
    const local = localByUuid.get(uuid);
    if (local && local.status !== 'deleted') {
      // Mark the live local copy deleted with the CLI's own data (a partial
      // JSON object would blank the other fields on import).
      const { id: _twId, urgency: _urgency, ...rest } = local;
      toPush.push({ ...rest, status: 'deleted', end: nowTW, modified: nowTW });
      decide(uuid, taskLabel({ ...local, status: 'deleted' }), 'tombstoned', 'deleted');
    }
  }

  return { decisions, toPush, newTombstones };
}

/**
 * Apply what `task import` actually reported (see backend
 * parse_import_output) to the planned decisions: a pushed uuid TaskWarrior
 * neither added nor modified becomes invalid. Returns a new decisions list.
 */
export function confirmPushedDecisions(decisions, pushResult) {
  const added = new Set((pushResult?.added || []).map((u) => String(u).toLowerCase()));
  const modified = new Set((pushResult?.modified || []).map((u) => String(u).toLowerCase()));
  if (added.size === 0 && modified.size === 0 && !Array.isArray(pushResult?.added)) {
    // Backend without per-task results (older backend): trust the plan.
    return decisions;
  }
  return decisions.map((d) => {
    if (!['created', 'updated', 'tombstoned'].includes(d.outcome)) return d;
    if (added.has(d.uuid) || modified.has(d.uuid)) return d;
    return { ...d, outcome: 'invalid', reason: 'TaskWarrior did not report importing it' };
  });
}
