/**
 * Database import strategies for the Import Database modal.
 *
 * Two entry points, both fed the parsed JSON export file:
 *
 * - replaceImportDatabase(importData): the historical default. Wipes ALL
 *   existing local data and recreates everything from the file. This is a
 *   verbatim extraction of the logic that used to live inline in
 *   CompactSidebar.handleConfirmImport - behavior must not change.
 *
 * - mergeImportDatabase(importData): opt-in merge mode. Never deletes
 *   anything. For each imported record it finds the matching local record
 *   (by a per-type natural identity key - never the auto-increment `id`,
 *   which is meaningless across machines), compares "last updated"
 *   timestamps, and only overwrites the local record when the imported copy
 *   is strictly newer. Records with no local match are created. When the
 *   imported copy is NOT newer (older, equal, or timestamps missing /
 *   incomparable) the local record's existing values are kept, but any
 *   field that is blank locally (absent, null, '', [] or {}) and filled in
 *   the import is copied over ("fill in the gaps", see missingFieldFills).
 *   That last rule matters because every create* helper (createDocument,
 *   createDocumentTemplate, ...) stamps updatedAt with the time of creation
 *   and ignores the timestamp in the data it was given - so a local database
 *   that was seeded by the replace path is always "newer" than the file it
 *   came from, and without gap-filling a merge could never complete an
 *   incomplete local record.
 *
 *   Records the merge creates get the same field defaults the create*
 *   helpers apply (title/name fallbacks, empty content/tags, an indexable
 *   updatedAt/createdAt): the app lists most tables through
 *   orderBy(<index>), and IndexedDB silently leaves a row out of an index
 *   when the indexed field is missing or not a valid key, so a row inserted
 *   verbatim from a file lacking that field would exist but never show up.
 *
 *   Returns a per-type summary (see newSummary()): { created, updated,
 *   filled, skipped, deleted, invalid, errors, samples } (filled = matched
 *   record kept, blank fields completed from the import; skipped = matched
 *   record left byte-for-byte untouched; invalid = could not be imported,
 *   with a reason per record in errors).
 *
 * - runImport(importData, mergeMode, { dryRun }): the entry point the modal
 *   hosts use. With dryRun the very same merge code runs against the real
 *   local data but every write is a no-op (createWriter), and replace mode
 *   returns the plan (replacePlan) the real replace would execute - so the
 *   user can review the statistics and then decide whether to import.
 *
 * Identity keys / timestamps per type (merge mode):
 *   documents               stableId (UUID minted at creation, survives
 *                           rename/recategorize) when both sides carry one;
 *                           title + category fallback for records that
 *                           predate stableId              / updatedAt
 *   documentTemplates       name + category         / updatedAt
 *   jqlTemplates            name + category         / updatedAt (createdAt fallback)
 *   engineTemplates         name + category         / updatedAt (createdAt fallback)
 *   workflows               title + category        / updatedAt (createdAt fallback)
 *   kanbanBoards            title + category        / updatedAt (createdAt fallback)
 *   kanbanCards             yjsId (globally unique) / updatedAt (createdAt fallback)
 *   tasks                   uuid (TaskWarrior UUID) / modified (entry fallback)
 *                           instanceId remapped to the local instance of the
 *                           same name; a uuid on the local purge list (task
 *                           deleted on this machine) is never re-created;
 *                           created non-pending tasks are reported in
 *                           summary.tasks.note / createdByStatus
 *   taskwarriorInstances    name                    / updatedAt (createdAt fallback)
 *   customReports           name                    / updatedAt (createdAt fallback)
 *   documentCategories      name                    / updatedAt (createdAt fallback)
 *   calendarEventTemplates  name                    / updatedAt (createdAt fallback)
 *   sshCommands             name                    / updatedAt (createdAt fallback)
 *   openshiftTemplates      name + category         / updatedAt (createdAt fallback)
 *   gtfobinsExecutables     name                    / updatedAt
 *   media                   filename                / uploadedAt
 *   customGrids/Quizzes     exported random string id, dedupe only (no
 *                           update timestamp exists and the store is a raw
 *                           add-only IndexedDB, so no gap-filling either;
 *                           matching id => skip, otherwise append preserving
 *                           the id so re-merging the same file stays
 *                           idempotent)
 *   gtfobinsFunctions       funcId, dedupe only (no update timestamp; same
 *                           matching-id-skip/append-preserving semantics as
 *                           customGrids/Quizzes)
 *   gtfobinsContexts        contextId, dedupe only (read-only reference set,
 *                           no update timestamp; same dedupe semantics)
 *   localStorage            merge mode only sets keys that do not already
 *                           exist locally (replace mode overwrites them)
 */

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Normalize a timestamp of any shape used across this codebase
 * (Date.now() millis, ISO string, Date object - Dates arrive as ISO
 * strings after JSON export) to milliseconds, or null if unknown.
 */
// The identity / "newer" / gap-filling rules live in mergeCore.js, shared
// with synchronisation (src/sync/syncEngine.js) so import and sync agree.
export { toMillis, importedIsNewer, isBlank, missingFieldFills } from './mergeCore';
import { normaliseInstancePaths } from './taskwarriorPaths';
import { importedIsNewer, keyPart, joinKey, missingFieldFills, withCreateDefaults, indexableTimestamp } from './mergeCore';

/**
 * Complete a matched local row from the imported record without touching
 * any field the local row already has a value for. Reads the FULL local row
 * first: callers often match against a metadata-only projection (documents
 * drop `content`), and a projection would make every dropped field look
 * blank. Returns true when something was written.
 */
async function fillMissingFields(table, localId, record, writer) {
  const full = await table.get(localId);
  if (!full) return false;
  const fills = missingFieldFills(full, record);
  if (Object.keys(fills).length === 0) return false;
  await writer.update(table, localId, fills);
  return true;
}

/* ------------------------------------------------------------------ */
/* Summary bookkeeping + dry-run write sink                            */
/* ------------------------------------------------------------------ */

const SAMPLE_LIMIT = 5;   // identifying labels kept per outcome, per type
const ERROR_LIMIT = 50;   // { label, reason } entries kept per type

/**
 * One entity type's summary. `deleted` is only ever non-zero for replace
 * mode; `errors` explains every record counted under `invalid`; `samples`
 * lists up to SAMPLE_LIMIT identifying labels per outcome so a dry run can
 * show WHICH records would be added / replaced / completed.
 */
export function newSummary() {
  return {
    created: 0, updated: 0, filled: 0, skipped: 0, deleted: 0, invalid: 0,
    errors: [],
    samples: { created: [], updated: [], filled: [] },
  };
}

export function tally(summary, outcome, label) {
  summary[outcome] += 1;
  const bucket = summary.samples[outcome];
  if (bucket && label && bucket.length < SAMPLE_LIMIT) bucket.push(label);
}

export function tallyInvalid(summary, label, reason) {
  summary.invalid += 1;
  if (summary.errors.length < ERROR_LIMIT) summary.errors.push({ label: label || '(unidentified record)', reason });
}

// Human-readable identity from a joinKey() key: '["Title","Cat"]' -> 'Title / Cat'
function labelFromKey(key) {
  if (key == null) return '';
  try {
    return JSON.parse(key).filter(Boolean).join(' / ');
  } catch {
    return String(key);
  }
}

/**
 * Every write the merge performs goes through one of these three functions.
 * In a dry run they return without touching IndexedDB - add() hands back a
 * synthetic negative id so the in-memory bookkeeping (duplicate detection in
 * the file, kanban board id remapping) behaves exactly as in a real run.
 * Reads stay real, so a dry run computes its plan with the same code, over
 * the same local data, as the import that may follow it.
 */
export function createWriter(dryRun) {
  let nextDryId = -1;
  return {
    dryRun,
    add: (table, record) => (dryRun ? Promise.resolve(nextDryId--) : table.add(record)),
    put: (table, record) => (dryRun ? Promise.resolve() : table.put(record)),
    update: (table, id, changes) => (dryRun ? Promise.resolve() : table.update(id, changes)),
  };
}

/**
 * Apply create-time defaults to a record the merge is about to insert: each
 * `defaults` entry (a value, or a function returning one) is used only where
 * the record's own field is blank. Mirrors what the create* helpers do for
 * new records so a merge-created row has the same shape - in particular the
 * indexed field the app lists the table by - as one created in the app.
 */
/**
 * Keep an imported timestamp when it is a usable IndexedDB key (number or
 * parseable string), otherwise substitute `now` so the row lands in the
 * table's updatedAt/createdAt index and is listed by the app. Used through
 * withCreateDefaults, which only consults it when the field is blank - so
 * this also has to cover the unparseable-but-present case explicitly.
 */
/**
 * Generic merge over one Dexie table with an auto-increment `id`.
 * Returns { created, updated, filled, skipped } counts.
 *
 * options.findLocal(imported, localByKey): optional matcher overriding the
 * plain key-map lookup, for types whose identity is richer than one natural
 * key (documents: stableId first, title+category fallback). Receives the
 * prebuilt keyOf->row map so fallbacks stay O(1).
 *
 * options.createDefaults: defaults applied (via withCreateDefaults) to
 * records the merge inserts - never to updates or fills.
 *
 * options.timestampField: name of the updatedAt/createdAt-style field the
 * table is listed by; on create it is forced to an indexable value.
 *
 * options.writer: the write sink from createWriter() (real or dry-run).
 *
 * options.invalidReason: reason recorded when prepare() returns null
 * (the record cannot be imported at all). A function receives the imported
 * record and returns the reason.
 *
 * options.labelOf(imported): human-readable label for the summary samples /
 * errors, for tables whose natural key is not readable (tasks: a uuid).
 *
 * options.track(imported, localId, outcome): called once per imported
 * record that ended up mapped to a local row - the id the merge inserted
 * (a synthetic negative one in a dry run) or the matched local row's id -
 * with the outcome ('created' | 'updated' | 'filled' | 'skipped'). Lets a
 * dependent table (tasks -> taskwarriorInstances) remap its foreign keys.
 *
 * A record that throws (a malformed row, a unique-index violation, ...) is
 * counted as invalid with the error message instead of aborting the whole
 * import half-way through.
 */
export async function mergeDexieTable(table, importedRows, keyOf, timestampOf, options = {}) {
  const {
    localRows, prepare, findLocal, createDefaults = {}, timestampField, labelOf, track,
    writer = createWriter(false), invalidReason = 'record cannot be imported',
  } = options;
  const rows = localRows || await table.toArray();

  const localByKey = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key != null && !localByKey.has(key)) localByKey.set(key, row);
  }

  const summary = newSummary();
  for (const imported of importedRows || []) {
    if (imported === null || typeof imported !== 'object' || Array.isArray(imported)) {
      tallyInvalid(summary, '', 'not a record object');
      continue;
    }
    let label = '';
    try {
      label = labelOf ? labelOf(imported) : labelFromKey(keyOf(imported));
      let local;
      if (findLocal) {
        local = findLocal(imported, localByKey);
      } else {
        const key = keyOf(imported);
        local = key != null ? localByKey.get(key) : undefined;
      }
      const { id: _id, ...rest } = imported;
      const record = prepare ? prepare(rest, local) : rest;
      if (record === null) {
        tallyInvalid(summary, label, typeof invalidReason === 'function' ? invalidReason(imported) : invalidReason);
      } else if (!local) {
        let toInsert = withCreateDefaults(record, createDefaults);
        if (timestampField) {
          toInsert = { ...toInsert, [timestampField]: indexableTimestamp(toInsert[timestampField]) };
        }
        const id = await writer.add(table, toInsert);
        // Register the new row under its key so a second imported row with the
        // same key (a duplicate in the export file) updates/skips it instead of
        // inserting a twin.
        const key = keyOf({ ...toInsert, id });
        if (key != null && !localByKey.has(key)) localByKey.set(key, { ...toInsert, id });
        tally(summary, 'created', labelOf ? label : (labelFromKey(key) || label));
        track?.(imported, id, 'created');
      } else if (importedIsNewer(timestampOf(imported), timestampOf(local))) {
        await writer.put(table, { ...record, id: local.id });
        tally(summary, 'updated', label);
        track?.(imported, local.id, 'updated');
      } else if (await fillMissingFields(table, local.id, record, writer)) {
        tally(summary, 'filled', label);
        track?.(imported, local.id, 'filled');
      } else {
        tally(summary, 'skipped', label);
        track?.(imported, local.id, 'skipped');
      }
    } catch (error) {
      tallyInvalid(summary, label, error?.message || String(error));
    }
  }
  return summary;
}

const updatedOrCreated = (row) => row.updatedAt ?? row.createdAt;

// Convert a base64 data URL from the export file back into a Blob
// (inverse of the export's blobToBase64). Same logic the replace path uses.
// Exported for the Documents JSON import (documentAttachments.js), whose
// per-document `media` entries carry the same encoding.
export function dataURLToBlob(dataURL) {
  const [header, base64] = dataURL.split(',');
  const mimeMatch = header.match(/:(.*?);/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const binary = atob(base64);
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    array[i] = binary.charCodeAt(i);
  }
  return new Blob([array], { type: mimeType });
}

/* ------------------------------------------------------------------ */
/* Tasks (TaskWarrior)                                                 */
/* ------------------------------------------------------------------ */

/**
 * One instance's (or, for a format-1 file, the whole file's) task summary:
 * the common counters plus how the tasks were applied.
 *   via            'cli' (pushed through `task import`, then re-synced) or
 *                  'db' (merged into the db.tasks cache only)
 *   needsDataPath  instance created by this import whose paths do not
 *                  validate on this machine (tasks kept in the cache)
 *   cliError       why the CLI path was not used, when it was not
 *   tombstoned     live tasks marked deleted by the file (counted in updated)
 *   purgedHere     file tasks skipped because they were permanently deleted
 *                  on this machine (counted in skipped; never resurrected)
 *   createdByStatus  new tasks per status; note describes the non-pending ones
 */
function newTaskSummary(instance = null) {
  const s = newSummary();
  s.samples.tombstoned = [];
  s.samples.purgedHere = [];
  return Object.assign(s, {
    instance, via: null, needsDataPath: false, cliError: null,
    tombstoned: 0, purgedHere: 0, createdByStatus: {},
  });
}

function noteCreatedByStatus(s) {
  const hidden = Object.entries(s.createdByStatus || {}).filter(([status]) => status !== 'pending');
  if (hidden.length === 0) return;
  const count = hidden.reduce((n, [, c]) => n + c, 0);
  s.note = `${hidden.map(([status, n]) => `${n} ${status}`).join(', ')} of the new tasks ` +
    `${count === 1 ? 'is' : 'are'} not pending (Completed/Deleted sections only); ` +
    'a deleted task the TaskWarrior CLI no longer has is dropped again on the next sync';
}

/**
 * Merge app task rows (db.tasks shape) into the db.tasks cache: uuid
 * identity, `modified` recency (entry fallback), instanceId remapped through
 * `remapInstance`. A uuid on the local purge list with no local row is the
 * user's own tombstone and is never re-created (skipped, listed under
 * purgedHere). Used for format-1 files and as the offline fallback of the
 * format-2 import.
 */
async function mergeTaskRows(db, rows, { writer, purged, remapInstance, summary = newTaskSummary() }) {
  const { taskLabel } = await import('./taskwarriorBackup');
  const result = await mergeDexieTable(
    db.tasks,
    rows,
    // No uuid -> null key -> treated as brand new
    (t) => (t.uuid ? joinKey(keyPart(t.uuid)) : null),
    (t) => t.modified ?? t.entry,
    {
      writer,
      labelOf: taskLabel,
      prepare: (rest, local) => {
        if (!local && rest.uuid && purged.has(String(rest.uuid).toLowerCase())) return null;
        const target = remapInstance(rest.instanceId);
        return target != null ? { ...rest, instanceId: target } : rest;
      },
      invalidReason: 'deleted on this machine after the file was exported; not re-added',
      track: (imported, _id, outcome) => {
        if (outcome !== 'created') return;
        const status = keyPart(imported.status, 'pending');
        summary.createdByStatus[status] = (summary.createdByStatus[status] || 0) + 1;
      },
    }
  );
  // Purged-here rows come back from mergeDexieTable as invalid (prepare
  // returned null); report them as skipped + purgedHere like the CLI path.
  const purgedErrors = result.errors.filter((e) => e.reason === 'deleted on this machine after the file was exported; not re-added');
  result.errors = result.errors.filter((e) => !purgedErrors.includes(e));
  result.invalid -= purgedErrors.length;
  result.skipped += purgedErrors.length;
  // Accumulate into `summary` (the caller may already have tallied rows it
  // filtered out before handing the rest over).
  for (const key of ['created', 'updated', 'filled', 'skipped', 'deleted', 'invalid']) summary[key] += result[key];
  summary.errors.push(...result.errors.slice(0, Math.max(0, ERROR_LIMIT - summary.errors.length)));
  for (const key of ['created', 'updated', 'filled']) {
    summary.samples[key].push(...result.samples[key].slice(0, Math.max(0, SAMPLE_LIMIT - summary.samples[key].length)));
  }
  summary.via = 'db';
  summary.purgedHere += purgedErrors.length;
  summary.samples.purgedHere.push(...purgedErrors.map((e) => e.label).slice(0, Math.max(0, SAMPLE_LIMIT - summary.samples.purgedHere.length)));
  noteCreatedByStatus(summary);
  return summary;
}

/**
 * Instance name -> { id, existedLocally, rcPath, dataPath } after the
 * instances merge. A matched instance keeps its LOCAL paths (the file's
 * point at another machine's filesystem); one created by this run only has
 * the file's. Local instances the file does not list are included too, so
 * a file whose task section names an instance its instance list lacks
 * still lands somewhere sensible.
 */
async function resolveInstancesByName(db, tracked) {
  const map = new Map();
  for (const { imported, localId, outcome } of tracked) {
    const name = keyPart(imported.name, 'New Instance');
    if (map.has(name)) continue;
    if (outcome === 'created') {
      map.set(name, { name, id: localId, existedLocally: false, rcPath: imported.rcPath || null, dataPath: imported.dataPath || null });
    } else {
      const row = await db.taskwarriorInstances.get(localId);
      map.set(name, { name, id: localId, existedLocally: true, rcPath: row?.rcPath || null, dataPath: row?.dataPath || null });
    }
  }
  for (const row of await db.taskwarriorInstances.toArray()) {
    const name = keyPart(row.name, 'New Instance');
    if (!map.has(name)) map.set(name, { name, id: row.id, existedLocally: true, rcPath: row.rcPath || null, dataPath: row.dataPath || null });
  }
  return map;
}

async function localReportsWithInstanceName(db) {
  const nameById = new Map((await db.taskwarriorInstances.toArray()).map((i) => [i.id, keyPart(i.name, 'New Instance')]));
  return (await db.taskwarriorReports.toArray()).map((r) => ({ ...r, instanceName: nameById.get(r.instanceId) ?? '' }));
}

/**
 * Where one instance's backup tasks can be applied on this machine:
 *   { via: 'cli', localTasks }  the CLI answered `task export` for the
 *                               instance's paths - tasks go through
 *                               `task import`
 *   { via: 'db', cliError, needsDataPath? }  merge into the db.tasks cache
 * An instance that existed locally is probed with ITS paths. One created by
 * this import is probed with the file's paths only after they validate on
 * this machine (an rc file / data directory that does not exist here means
 * "needs a data path": the tasks stay in the cache until the user points the
 * instance at real data). Every call here is read-only.
 */
async function resolveTaskTransport(target, { validateInstance, fetchTaskWarriorTasks }) {
  const rcPath = target.rcPath || null;
  const dataPath = target.dataPath || null;
  if (target.existedLocally) {
    try {
      return { via: 'cli', localTasks: await fetchTaskWarriorTasks(rcPath, dataPath) };
    } catch (error) {
      return { via: 'db', cliError: error?.message || String(error) };
    }
  }
  try {
    const v = await validateInstance(rcPath, dataPath);
    const problems = [...(v?.errors || []), ...(v?.warnings || [])];
    if (v?.valid && !problems.some((w) => /does not exist/i.test(String(w)))) {
      return { via: 'cli', localTasks: await fetchTaskWarriorTasks(rcPath, dataPath) };
    }
    return { via: 'db', needsDataPath: true, cliError: problems.join('; ') || 'instance paths do not validate on this machine' };
  } catch (error) {
    return { via: 'db', needsDataPath: true, cliError: error?.message || String(error) };
  }
}

const PUSHED_OUTCOMES = new Set(['created', 'updated', 'tombstoned']);

function tallyDecisions(s, decisions) {
  for (const d of decisions) {
    switch (d.outcome) {
      case 'created':
        tally(s, 'created', d.label);
        s.createdByStatus[d.status] = (s.createdByStatus[d.status] || 0) + 1;
        break;
      case 'updated':
        tally(s, 'updated', d.label);
        break;
      case 'tombstoned':
        tally(s, 'updated', d.label);
        s.tombstoned += 1;
        if (s.samples.tombstoned.length < SAMPLE_LIMIT) s.samples.tombstoned.push(d.label);
        break;
      case 'purgedHere':
        tally(s, 'skipped', d.label);
        s.purgedHere += 1;
        if (s.samples.purgedHere.length < SAMPLE_LIMIT) s.samples.purgedHere.push(d.label);
        break;
      case 'invalid':
        tallyInvalid(s, d.label, d.reason || 'cannot be imported');
        break;
      default:
        tally(s, 'skipped', d.label);
    }
  }
}

/**
 * Format-2 import of `taskwarriorTasks` / `taskTombstones`, one summary per
 * instance under the key `tasks:<instance name>`. The dry run and the real
 * run share every decision (planCliTasks / mergeDexieTable); only the real
 * run pushes to the CLI, touches the purge list and re-syncs the cache.
 */
async function importTaskwarriorTasks(db, importData, { instanceByName, purged, writer, dryRun }) {
  const { planCliTasks, confirmPushedDecisions, taskLabel } = await import('./taskwarriorBackup');
  const {
    fetchTaskWarriorTasks, pushTaskWarriorTasks, fromTaskWarriorJson, addPurgedTaskUUIDs, syncFromTaskWarrior,
  } = await import('./tasks');
  const { validateInstance } = await import('./taskwarriorInstances');

  const tombstones = [...new Set((importData.taskTombstones || []).filter((u) => typeof u === 'string' && u).map((u) => u.toLowerCase()))];
  const out = {};

  for (const [name, fileRows] of Object.entries(importData.taskwarriorTasks)) {
    const s = newTaskSummary(name);
    out[`tasks:${name}`] = s;
    const rows = Array.isArray(fileRows) ? fileRows : [];
    const target = instanceByName.get(keyPart(name));
    if (!target) {
      s.via = 'db';
      for (const row of rows) tallyInvalid(s, taskLabel(row), 'its TaskWarrior instance is not in the import file');
      continue;
    }

    const transport = await resolveTaskTransport(target, { validateInstance, fetchTaskWarriorTasks });
    s.via = transport.via;
    s.needsDataPath = !!transport.needsDataPath;
    s.cliError = transport.cliError || null;

    if (transport.via === 'cli') {
      const plan = planCliTasks({ fileTasks: rows, localTasks: transport.localTasks, purged, tombstones });
      let decisions = plan.decisions;
      if (!dryRun) {
        if (plan.toPush.length > 0) {
          try {
            decisions = confirmPushedDecisions(decisions, await pushTaskWarriorTasks(plan.toPush, target.rcPath, target.dataPath));
          } catch (error) {
            const reason = `TaskWarrior import failed: ${error?.message || error}`;
            decisions = decisions.map((d) => (PUSHED_OUTCOMES.has(d.outcome) ? { ...d, outcome: 'invalid', reason } : d));
          }
        }
        if (plan.newTombstones.length > 0) addPurgedTaskUUIDs(plan.newTombstones);
        const sync = await syncFromTaskWarrior(target.id, target.rcPath, target.dataPath);
        if (!sync.success) s.syncError = sync.error || 'sync from the CLI failed';
      }
      tallyDecisions(s, decisions);
      noteCreatedByStatus(s);
      continue;
    }

    // Offline fallback: the cache only.
    const converted = [];
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        tallyInvalid(s, '', 'not a task object');
      } else if (typeof row.uuid !== 'string' || !row.uuid.trim()) {
        tallyInvalid(s, taskLabel(row), 'task has no uuid');
      } else if (tombstones.includes(row.uuid.trim().toLowerCase())) {
        tally(s, 'skipped', taskLabel(row));
      } else {
        converted.push(fromTaskWarriorJson(row, target.id));
      }
    }
    await mergeTaskRows(db, converted, { writer, purged, remapInstance: () => target.id, summary: s });
    if (tombstones.length > 0) {
      const tombstoneSet = new Set(tombstones);
      const stamp = new Date().toISOString();
      for (const local of await db.tasks.where('instanceId').equals(target.id).toArray()) {
        const uuid = typeof local.uuid === 'string' ? local.uuid.toLowerCase() : null;
        if (!uuid || !tombstoneSet.has(uuid) || purged.has(uuid) || local.status === 'deleted') continue;
        await writer.update(db.tasks, local.id, { status: 'deleted', end: stamp, modified: stamp });
        tally(s, 'updated', taskLabel({ ...local, status: 'deleted' }));
        s.tombstoned += 1;
        if (s.samples.tombstoned.length < SAMPLE_LIMIT) s.samples.tombstoned.push(taskLabel({ ...local, status: 'deleted' }));
      }
      if (!dryRun) addPurgedTaskUUIDs(tombstones);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Merge mode                                                          */
/* ------------------------------------------------------------------ */

/**
 * Merge the imported export file into the existing local database.
 * Never deletes anything. See module header for per-type semantics.
 * Returns a per-type summary (see newSummary()).
 *
 * options.dryRun: run the exact same matching/decision code against the real
 * local data but write NOTHING (see createWriter) - the returned summary is
 * the plan a real merge of this file would carry out right now.
 */
export async function mergeImportDatabase(importData, { dryRun = false } = {}) {
  const { db } = await import('../db/database');
  const summary = {};
  const writer = createWriter(dryRun);
  const merge = (table, rows, keyOf, timestampOf, options = {}) =>
    mergeDexieTable(table, rows, keyOf, timestampOf, { ...options, writer });

  // --- Document categories (match by name; keep local position order) ---
  {
    const localCats = await db.documentCategories.toArray();
    let nextPos = localCats.length > 0
      ? Math.max(...localCats.map(c => c.position || 0)) + 1
      : 0;
    summary.documentCategories = await merge(
      db.documentCategories,
      importData.documentCategories,
      (c) => joinKey(keyPart(c.name)),
      updatedOrCreated,
      {
        localRows: localCats,
        prepare: (rest, local) => local
          ? { ...rest, position: local.position } // keep local ordering
          : { ...rest, position: nextPos++ },     // append after local ones
      }
    );
  }

  // --- Documents (stableId primary, title + category fallback; updatedAt) ---
  {
    const { generateStableId } = await import('./stableId');

    // Metadata-only projection: matching never needs the (arbitrarily
    // large) `content` body of every local document.
    const localDocMeta = [];
    const localByStableId = new Map();
    await db.documents.each((doc) => {
      const meta = {
        id: doc.id,
        stableId: doc.stableId,
        title: doc.title,
        category: doc.category,
        updatedAt: doc.updatedAt,
      };
      localDocMeta.push(meta);
      if (typeof doc.stableId === 'string' && doc.stableId !== '') {
        localByStableId.set(doc.stableId, meta);
      }
    });

    const importedStableId = (d) =>
      typeof d.stableId === 'string' && d.stableId !== '' ? d.stableId : null;

    summary.documents = await merge(
      db.documents,
      importData.documents,
      (d) => joinKey(keyPart(d.title, 'Untitled'), keyPart(d.category, 'General')),
      (d) => d.updatedAt,
      {
        localRows: localDocMeta,
        // stableId survives rename/recategorize, so it wins whenever both
        // sides carry one. Fallback rules keep old exports working without
        // ever cross-matching two provably different documents:
        //  - imported has a stableId with no local stableId match: fall back
        //    to title+category ONLY against a local that has no stableId of
        //    its own (pre-migration record). A local with a DIFFERENT
        //    stableId is a distinct document that merely shares the name -
        //    matching it would overwrite distinct content, so the import is
        //    created as its own document instead.
        //  - imported has no stableId (old export file): legacy
        //    title+category matching against any local record.
        findLocal: (imported, localByKey) => {
          const sid = importedStableId(imported);
          if (sid != null && localByStableId.has(sid)) return localByStableId.get(sid);
          const candidate = localByKey.get(
            joinKey(keyPart(imported.title, 'Untitled'), keyPart(imported.category, 'General'))
          );
          if (!candidate) return undefined;
          if (sid != null && typeof candidate.stableId === 'string' && candidate.stableId !== '') {
            return undefined; // both have ids and they differ: distinct documents
          }
          return candidate;
        },
        // Creates keep the imported stableId (re-merging the same file stays
        // idempotent) or mint one so every document ends up with an identity;
        // updates from old id-less exports must not erase the local id.
        prepare: (rest, local) => ({
          ...rest,
          stableId: importedStableId(rest) || local?.stableId || generateStableId(),
        }),
        // Same shape createDocument gives a new document; the sidebar lists
        // documents via orderBy('updatedAt'), so that one must be indexable.
        createDefaults: { title: 'Untitled', content: '', category: 'General', locked: false },
        timestampField: 'updatedAt',
      }
    );
  }

  // --- Document templates (name + category; updatedAt) ---
  summary.documentTemplates = await merge(
    db.documentTemplates,
    importData.documentTemplates,
    (t) => joinKey(keyPart(t.name, 'Untitled Template'), keyPart(t.category, 'General')),
    (t) => t.updatedAt,
    {
      createDefaults: {
        name: 'Untitled Template', content: '', tags: () => [], category: 'General', description: '',
      },
      timestampField: 'updatedAt',
    }
  );

  // --- JQL templates (name + category) ---
  summary.jqlTemplates = await merge(
    db.templates,
    importData.jqlTemplates,
    (t) => joinKey(keyPart(t.name), keyPart(t.category, 'General')),
    updatedOrCreated,
    {
      // getTemplates lists via orderBy('createdAt')
      createDefaults: { updatedAt: () => Date.now() },
      timestampField: 'createdAt',
    }
  );

  // --- Search engine templates (name + category) ---
  summary.engineTemplates = await merge(
    db.engineTemplates,
    importData.engineTemplates,
    (t) => joinKey(keyPart(t.name), keyPart(t.category, 'General')),
    updatedOrCreated,
    { createDefaults: { category: 'General', description: '' } }
  );

  // --- Workflows (title + category; updatedAt) ---
  summary.workflows = await merge(
    db.workflows,
    importData.workflows,
    (w) => joinKey(keyPart(w.title, 'Untitled Workflow'), keyPart(w.category, 'General')),
    updatedOrCreated,
    {
      createDefaults: {
        title: 'Untitled Workflow', category: 'General', nodes: () => [], edges: () => [],
        createdAt: () => Date.now(),
      },
      timestampField: 'updatedAt',
    }
  );

  // --- Kanban boards (title + category) + cards (yjsId) ---
  {
    const localBoards = await db.kanbanBoards.toArray();
    const boardByKey = new Map();
    for (const board of localBoards) {
      const key = joinKey(keyPart(board.title), keyPart(board.category, 'General'));
      if (!boardByKey.has(key)) boardByKey.set(key, board);
    }

    // Imported board id -> local board id (existing match or newly created)
    const boardTarget = new Map();
    const boardSummary = newSummary();
    for (const imported of importData.kanbanBoards || []) {
      if (imported === null || typeof imported !== 'object') {
        tallyInvalid(boardSummary, '', 'not a record object');
        continue;
      }
      const key = joinKey(keyPart(imported.title), keyPart(imported.category, 'General'));
      const label = labelFromKey(key);
      try {
        const local = boardByKey.get(key);
        const { id: _id, ...rest } = imported;
        if (!local) {
          const newId = await writer.add(db.kanbanBoards, withCreateDefaults(rest, {
            category: 'General', createdAt: () => new Date(), updatedAt: () => new Date(),
          }));
          boardTarget.set(imported.id, newId);
          tally(boardSummary, 'created', label);
        } else {
          boardTarget.set(imported.id, local.id);
          if (importedIsNewer(updatedOrCreated(imported), updatedOrCreated(local))) {
            await writer.put(db.kanbanBoards, { ...rest, id: local.id });
            tally(boardSummary, 'updated', label);
          } else if (await fillMissingFields(db.kanbanBoards, local.id, rest, writer)) {
            tally(boardSummary, 'filled', label);
          } else {
            tally(boardSummary, 'skipped', label);
          }
        }
      } catch (error) {
        tallyInvalid(boardSummary, label, error?.message || String(error));
      }
    }
    summary.kanbanBoards = boardSummary;

    // Cards: identity is the globally-unique yjsId minted at creation.
    // Cards without a yjsId (legacy) have no reliable cross-machine
    // identity, so they are created as new. Cards whose board is not in the
    // import file are dropped, same as the replace path.
    const { generateCardYjsId } = await import('./kanban');
    const cardByYjsId = new Map();
    await db.kanbanCards.each((card) => {
      if (card.yjsId != null && card.yjsId !== '') {
        cardByYjsId.set(String(card.yjsId), card);
      }
    });

    const cardSummary = newSummary();
    for (const imported of importData.kanbanCards || []) {
      if (imported === null || typeof imported !== 'object') {
        tallyInvalid(cardSummary, '', 'not a record object');
        continue;
      }
      const label = keyPart(imported.title) || (imported.yjsId != null ? `card ${imported.yjsId}` : '');
      try {
        const targetBoardId = boardTarget.get(imported.boardId);
        if (targetBoardId == null) {
          tallyInvalid(cardSummary, label, `its board (id ${imported.boardId}) is not in the import file`);
          continue;
        }
        const local = imported.yjsId != null && imported.yjsId !== ''
          ? cardByYjsId.get(String(imported.yjsId))
          : undefined;
        const { id: _id, ...rest } = imported;
        if (!local) {
          await writer.add(db.kanbanCards, withCreateDefaults({
            ...rest,
            boardId: targetBoardId,
            yjsId: imported.yjsId || generateCardYjsId(),
          }, { createdAt: () => new Date(), updatedAt: () => new Date() }));
          tally(cardSummary, 'created', label);
        } else if (importedIsNewer(updatedOrCreated(imported), updatedOrCreated(local))) {
          await writer.put(db.kanbanCards, { ...rest, boardId: targetBoardId, id: local.id });
          tally(cardSummary, 'updated', label);
        } else if (await fillMissingFields(db.kanbanCards, local.id, { ...rest, boardId: targetBoardId }, writer)) {
          tally(cardSummary, 'filled', label);
        } else {
          tally(cardSummary, 'skipped', label);
        }
      } catch (error) {
        tallyInvalid(cardSummary, label, error?.message || String(error));
      }
    }
    summary.kanbanCards = cardSummary;
  }

  // --- TaskWarrior instances (name) ---
  // rcPath/dataPath point at another machine's filesystem, but the replace
  // path imports them wholesale too, so merge keeps the same policy for
  // field content. isActive is machine-local state: created instances come
  // in inactive, and an overwrite preserves the local active flag so a
  // merge can never end up with two active instances.
  // Merged BEFORE the tasks: instance ids are auto-increment and differ
  // between machines (and between an export and the same machine after the
  // instance was deleted and recreated), so every imported task's
  // instanceId has to be remapped to the local instance of the same name -
  // the Tasks page only ever shows tasks whose instanceId equals a local
  // instance's id, and a task left with the file's id is invisible.
  const instanceTarget = new Map(); // instance id in the file -> local id
  const instanceTracked = [];       // [{ imported, localId, outcome }] in file order
  summary.taskwarriorInstances = await merge(
    db.taskwarriorInstances,
    importData.taskwarriorInstances,
    (i) => joinKey(keyPart(i.name)),
    updatedOrCreated,
    {
      // paths from another machine (absolute) become this app's ~/.task/<name>
      // form (src/utils/taskwarriorPaths.js); the old folders are never used
      prepare: (rest, local) => ({
        ...normaliseInstancePaths(rest).row,
        isActive: local ? local.isActive : 0,
      }),
      track: (imported, localId, outcome) => {
        if (imported.id != null && !instanceTarget.has(imported.id)) instanceTarget.set(imported.id, localId);
        instanceTracked.push({ imported, localId, outcome });
      },
    }
  );

  // Instance name -> where its tasks go on this machine. Matched instances
  // keep their LOCAL paths (the file's point at another filesystem); an
  // instance created by this run only has the file's paths.
  const instanceByName = await resolveInstancesByName(db, instanceTracked);

  const { hasTaskwarriorTasks } = await import('./taskwarriorBackup');
  const { getPurgedTaskUUIDs } = await import('./tasks');
  const purged = new Set(getPurgedTaskUUIDs().map((u) => String(u).toLowerCase()));

  if (hasTaskwarriorTasks(importData)) {
    // --- Format 2: TaskWarrior JSON per instance, applied through the CLI
    // when it answers for the instance, else merged into the db.tasks cache.
    Object.assign(summary, await importTaskwarriorTasks(db, importData, { instanceByName, purged, writer, dryRun }));
  } else {
    // --- Format 1: flat `tasks` array of app rows (uuid; modified) ---
    summary.tasks = await mergeTaskRows(db, importData.tasks, {
      writer, purged,
      remapInstance: (instanceId) => (instanceId != null ? instanceTarget.get(instanceId) : undefined),
    });
  }

  // --- TaskWarrior custom reports (instance name + report name) ---
  if (Array.isArray(importData.taskwarriorReports)) {
    summary.taskwarriorReports = await merge(
      db.taskwarriorReports,
      importData.taskwarriorReports,
      (r) => joinKey(keyPart(r.instanceName), keyPart(r.name)),
      updatedOrCreated,
      {
        localRows: await localReportsWithInstanceName(db),
        prepare: (rest) => {
          const { instanceName, ...row } = rest;
          const target = instanceByName.get(keyPart(instanceName))?.id
            ?? (row.instanceId != null ? instanceTarget.get(row.instanceId) : undefined);
          return target == null ? null : { ...row, instanceId: target };
        },
        invalidReason: 'its TaskWarrior instance is not in the import file',
      }
    );
  }

  // --- Custom reports (name) ---
  summary.customReports = await merge(
    db.customReports,
    importData.customReports,
    (r) => joinKey(keyPart(r.name)),
    updatedOrCreated
  );

  // --- Calendar event templates (name) ---
  summary.calendarEventTemplates = await merge(
    db.calendarEventTemplates,
    importData.calendarEventTemplates,
    (t) => joinKey(keyPart(t.name)),
    updatedOrCreated
  );

  // --- SSH commands (name) ---
  summary.sshCommands = await merge(
    db.sshCommands,
    importData.sshCommands,
    (c) => joinKey(keyPart(c.name)),
    updatedOrCreated
  );

  // --- OpenShift templates (name + category) ---
  summary.openshiftTemplates = await merge(
    db.openshiftTemplates,
    importData.openshiftTemplates,
    (t) => joinKey(keyPart(t.name), keyPart(t.category, 'General')),
    updatedOrCreated,
    { createDefaults: { name: 'Untitled Template', category: 'General', yaml: '', icon: 'FileCode', description: '' } }
  );

  // --- GTFOBins executables (name; updatedAt) ---
  // Same name-identity / newer-updatedAt-wins policy as sshCommands and
  // openshiftTemplates.
  summary.gtfobinsExecutables = await merge(
    db.gtfobinsExecutables,
    importData.gtfobinsExecutables,
    (e) => joinKey(keyPart(e.name)),
    updatedOrCreated
  );

  // --- GTFOBins functions / contexts: id-based dedupe, append-only ---
  // funcId / contextId are the natural identities and neither table carries an
  // update timestamp, so (like custom grids/quizzes) merge never overwrites: a
  // matching id keeps its local values (blank fields are still completed from
  // the import), everything else is appended preserving that id. The null
  // timestamp makes importedIsNewer() always false.
  summary.gtfobinsFunctions = await merge(
    db.gtfobinsFunctions,
    importData.gtfobinsFunctions,
    (f) => joinKey(keyPart(f.funcId)),
    () => null
  );
  summary.gtfobinsContexts = await merge(
    db.gtfobinsContexts,
    importData.gtfobinsContexts,
    (c) => joinKey(keyPart(c.contextId)),
    () => null
  );

  // --- Custom grids / quizzes: id-based dedupe, append-only ---
  // These have no natural identity beyond the random string id minted at
  // creation and no update timestamp, so merge never overwrites: a matching
  // id is skipped, everything else is appended preserving the exported id
  // (which keeps re-merging the same file idempotent).
  {
    const { getAllCustomGrids, getAllCustomQuizzes, addCustomGrid, addCustomQuiz } =
      await import('./customContentDB');

    const mergeCustomContent = async (importedRows, existingRows, addFn) => {
      const existingIds = new Set(existingRows.map(r => r.id));
      const s = newSummary();
      for (const row of importedRows || []) {
        if (row === null || typeof row !== 'object') {
          tallyInvalid(s, '', 'not a record object');
          continue;
        }
        const label = keyPart(row.name) || keyPart(row.title) || keyPart(row.id);
        if (row.id != null && existingIds.has(row.id)) {
          tally(s, 'skipped', label);
          continue;
        }
        const toAdd = {
          ...row,
          id: row.id ?? `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          createdAt: row.createdAt || new Date().toISOString(),
        };
        try {
          if (!dryRun) await addFn(toAdd);
          existingIds.add(toAdd.id); // a twin later in the file is a skip, dry run or not
          tally(s, 'created', label);
        } catch (error) {
          tallyInvalid(s, label, error?.message || String(error));
        }
      }
      return s;
    };

    summary.customGrids = await mergeCustomContent(
      importData.customGrids, await getAllCustomGrids(), addCustomGrid);
    summary.customQuizzes = await mergeCustomContent(
      importData.customQuizzes, await getAllCustomQuizzes(), addCustomQuiz);
  }

  // --- Media (filename; uploadedAt) ---
  summary.media = await merge(
    db.media,
    importData.media,
    (m) => joinKey(keyPart(m.filename)),
    (m) => m.uploadedAt,
    {
      timestampField: 'uploadedAt',
      invalidReason: 'media record has no base64 data to restore the file from',
      prepare: (rest) => {
        const { data, ...withoutData } = rest;
        if (typeof data !== 'string') return null; // unusable record
        return { ...withoutData, blob: dataURLToBlob(data) };
      },
    }
  );

  // --- localStorage: only fill in keys that do not exist locally ---
  if (importData.localStorage) {
    const ls = newSummary();
    Object.entries(importData.localStorage).forEach(([key, value]) => {
      if (localStorage.getItem(key) === null) {
        if (!dryRun) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
        tally(ls, 'created', key);
      } else {
        tally(ls, 'skipped', key);
      }
    });
    summary.localStorage = ls;
  }

  return summary;
}

/**
 * Collapse a per-type import summary (merge or replace) into whole-import
 * totals ({ created, updated, filled, skipped, deleted, invalid }) for the
 * completion notification and the modal's headline.
 */
export function mergeTotals(summary) {
  const totals = { created: 0, updated: 0, filled: 0, skipped: 0, deleted: 0, invalid: 0 };
  for (const counts of Object.values(summary || {})) {
    for (const key of Object.keys(totals)) totals[key] += counts?.[key] || 0;
  }
  return totals;
}

/* ------------------------------------------------------------------ */
/* Replace mode (historical default: full wipe + recreate)             */
/* ------------------------------------------------------------------ */

/**
 * Wipe all existing local data and recreate everything from the export
 * file. Extracted from CompactSidebar.handleConfirmImport - this is the
 * default (checkbox unchecked) behavior. Two deliberate departures from the
 * original: TaskWarrior instances are recreated before the tasks so each
 * task's instanceId can be remapped to the new auto-increment id, and the
 * wiped tasks are not added to the purge list (see the delete loop).
 */
export async function replaceImportDatabase(importData) {
  const { createDocument, deleteDocument } = await import('./documents');
  const { createDocumentTemplate, deleteDocumentTemplate } = await import('./documentTemplates');
  const { saveTemplate, deleteTemplate } = await import('../templates/jqlTemplates');
  const { createEngineTemplate, deleteEngineTemplate } = await import('./engineTemplates');
  const { createDocumentCategory, deleteDocumentCategory } = await import('./documentCategories');
  const { createWorkflow, deleteWorkflow } = await import('./workflows');
  const { createBoard, createCard, deleteBoard } = await import('./kanban');
  const { createTask } = await import('./tasks');
  const { createInstance, deleteInstance } = await import('./taskwarriorInstances');
  const { createCustomReport, deleteCustomReport } = await import('./customReports');
  const { createSSHCommand, deleteSSHCommand } = await import('./sshCommands');
  const { addCustomGrid, addCustomQuiz, deleteCustomGrid, deleteCustomQuiz } = await import('./customContentDB');
  const { createOpenshiftTemplate, deleteOpenshiftTemplate } = await import('./openshiftTemplates');
  const { db } = await import('../db/database');

  // Existing rows are read (metadata only for documents - deletion needs
  // just their ids) by the same helper the dry run uses.
  const existing = await loadExistingForReplace();
  const {
    existingDocs, existingDocTemplates, existingJQLTemplates, existingEngineTemplates, existingWorkflows,
    existingKanbanBoards, existingTasks, existingInstances, existingReports, existingDocCategories,
    existingCalendarTemplates, existingSSHCommands, existingCustomGrids, existingCustomQuizzes,
    existingOpenshiftTemplates,
  } = existing;
  // Computed BEFORE anything is deleted, from the same arrays the deletion
  // loop below consumes - this is exactly what a dry run reports.
  const summary = replacePlan(existing, importData);

  await Promise.all([
    ...existingDocs.map(doc => deleteDocument(doc.id)),
    ...existingDocTemplates.map(tmpl => deleteDocumentTemplate(tmpl.id)),
    ...existingJQLTemplates.map(tmpl => deleteTemplate(tmpl.id)),
    ...existingEngineTemplates.map(tmpl => deleteEngineTemplate(tmpl.id)),
    ...existingWorkflows.map(wf => deleteWorkflow(wf.id)),
    ...existingKanbanBoards.map(board => deleteBoard(board.id)),
    // Plain row deletes, NOT deleteTask(id, true): that helper records every
    // uuid in the purge list (the "user permanently deleted this task"
    // tombstones), which made syncFromTaskWarrior ignore the CLI's copy of
    // every pre-existing task forever after a replace import.
    ...existingTasks.map(task => db.tasks.delete(task.id)),
    ...existingInstances.map(inst => deleteInstance(inst.id)),
    ...existingReports.map(report => deleteCustomReport(report.id)),
    ...existingDocCategories.map(cat => deleteDocumentCategory(cat.id)),
    ...existingCalendarTemplates.map(tmpl => db.calendarEventTemplates.delete(tmpl.id)),
    ...existingSSHCommands.map(cmd => deleteSSHCommand(cmd.id)),
    ...existingCustomGrids.map(grid => deleteCustomGrid(grid.id)),
    ...existingCustomQuizzes.map(quiz => deleteCustomQuiz(quiz.id)),
    ...existingOpenshiftTemplates.map(tmpl => deleteOpenshiftTemplate(tmpl.id))
  ]);

  // TaskWarrior instances first: they get fresh auto-increment ids (IndexedDB
  // never reuses a key, so even a same-machine round trip changes them) and
  // the tasks below must point at the new ids or the Tasks page, which lists
  // tasks by instanceId, never shows them.
  const instanceIdMap = new Map();   // instance id in the file -> new local id
  const instanceIdByName = new Map(); // instance name -> new local id
  for (const instanceData of importData.taskwarriorInstances || []) {
    const { id: oldId, ...instanceWithoutId } = instanceData;
    const created = await createInstance(normaliseInstancePaths(instanceWithoutId).row);
    if (oldId != null && created?.id != null) instanceIdMap.set(oldId, created.id);
    const name = keyPart(instanceData.name, 'New Instance');
    if (created?.id != null && !instanceIdByName.has(name)) instanceIdByName.set(name, created.id);
  }

  // Format-2 tasks (TaskWarrior JSON per instance): replace refills the
  // db.tasks CACHE only. Nothing is pushed to, deleted from or purged in the
  // TaskWarrior data files - the Tasks page re-syncs from the CLI when the
  // instance opens. The file's tombstones become this machine's purge list.
  const { hasTaskwarriorTasks } = await import('./taskwarriorBackup');
  const { fromTaskWarriorJson, setPurgedTaskUUIDs } = await import('./tasks');
  const format2Tasks = hasTaskwarriorTasks(importData);
  if (format2Tasks) {
    for (const [name, rows] of Object.entries(importData.taskwarriorTasks)) {
      const target = instanceIdByName.get(keyPart(name));
      if (target == null || !Array.isArray(rows)) continue;
      for (const row of rows) {
        if (row === null || typeof row !== 'object' || Array.isArray(row) || typeof row.uuid !== 'string' || !row.uuid.trim()) continue;
        await createTask(fromTaskWarriorJson(row, target));
      }
    }
    if (Array.isArray(importData.taskTombstones)) setPurgedTaskUUIDs(importData.taskTombstones);
    for (const report of importData.taskwarriorReports || []) {
      if (report === null || typeof report !== 'object') continue;
      const { id: _id, instanceName, ...row } = report;
      const target = instanceIdByName.get(keyPart(instanceName)) ?? (row.instanceId != null ? instanceIdMap.get(row.instanceId) : undefined);
      if (target == null) continue;
      await db.taskwarriorReports.add({ ...row, instanceId: target });
    }
  }

  await Promise.all([
    ...(importData.documentCategories || []).map(cat => {
      const { id: _id, ...catData } = cat;
      return createDocumentCategory(catData);
    }),
    ...importData.documents.map(doc => createDocument(doc)),
    ...importData.documentTemplates.map(tmpl => createDocumentTemplate(tmpl)),
    ...importData.jqlTemplates.map(tmpl => saveTemplate(tmpl)),
    ...importData.engineTemplates.map(tmpl => createEngineTemplate(tmpl)),
    ...(importData.workflows || []).map(wf => createWorkflow(wf)),
    ...(format2Tasks ? [] : (importData.tasks || [])).map(task => {
      const { id: _id, ...taskData } = task;
      const target = taskData.instanceId != null ? instanceIdMap.get(taskData.instanceId) : undefined;
      return createTask(target != null ? { ...taskData, instanceId: target } : taskData);
    }),
    ...(importData.customReports || []).map(report => {
      const { id: _id, ...reportData } = report;
      return createCustomReport(reportData);
    })
  ]);

  // Import kanban boards and cards (if present, for backward compatibility)
  if (importData.kanbanBoards && importData.kanbanBoards.length > 0) {
    // Create a map of old IDs to new IDs
    const boardIdMap = new Map();

    // Import boards first
    for (const boardData of importData.kanbanBoards) {
      const oldId = boardData.id;
      const { id: _id, ...boardWithoutId } = boardData;
      const newBoard = await createBoard(boardWithoutId);
      boardIdMap.set(oldId, newBoard.id);
    }

    // Import cards with updated board IDs
    if (importData.kanbanCards && importData.kanbanCards.length > 0) {
      for (const cardData of importData.kanbanCards) {
        const { id: _id, boardId, ...cardWithoutId } = cardData;
        const newBoardId = boardIdMap.get(boardId);
        if (newBoardId) {
          await createCard({ ...cardWithoutId, boardId: newBoardId });
        }
      }
    }
  }

  // Import calendar event templates (if present)
  if (importData.calendarEventTemplates && importData.calendarEventTemplates.length > 0) {
    for (const templateData of importData.calendarEventTemplates) {
      const { id: _id, ...templateWithoutId } = templateData;
      await db.calendarEventTemplates.add(templateWithoutId);
    }
  }

  // Import SSH commands (if present)
  if (importData.sshCommands && importData.sshCommands.length > 0) {
    for (const commandData of importData.sshCommands) {
      const { id: _id, ...commandWithoutId } = commandData;
      await createSSHCommand(commandWithoutId);
    }
  }

  // Import custom grids (if present)
  if (importData.customGrids && importData.customGrids.length > 0) {
    for (const gridData of importData.customGrids) {
      // The store was emptied above, so the exported id can stay: a later
      // merge of the same file then recognises the row instead of adding a twin.
      const newGrid = {
        ...gridData,
        id: gridData.id ?? `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        createdAt: gridData.createdAt || new Date().toISOString()
      };
      await addCustomGrid(newGrid);
    }
  }

  // Import custom quizzes (if present)
  if (importData.customQuizzes && importData.customQuizzes.length > 0) {
    for (const quizData of importData.customQuizzes) {
      const newQuiz = {
        ...quizData,
        id: quizData.id ?? `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        createdAt: quizData.createdAt || new Date().toISOString()
      };
      await addCustomQuiz(newQuiz);
    }
  }

  // Import OpenShift templates (if present)
  if (importData.openshiftTemplates && importData.openshiftTemplates.length > 0) {
    for (const templateData of importData.openshiftTemplates) {
      const { id: _id, ...templateWithoutId } = templateData;
      await createOpenshiftTemplate(templateWithoutId);
    }
  }

  // Import GTFOBins functions (if present) - wipe + recreate from the file
  if (importData.gtfobinsFunctions && importData.gtfobinsFunctions.length > 0) {
    await db.gtfobinsFunctions.clear();
    for (const fnData of importData.gtfobinsFunctions) {
      const { id: _id, ...fnWithoutId } = fnData;
      await db.gtfobinsFunctions.add(fnWithoutId);
    }
  }

  // Import GTFOBins executables (if present) - wipe + recreate from the file
  if (importData.gtfobinsExecutables && importData.gtfobinsExecutables.length > 0) {
    await db.gtfobinsExecutables.clear();
    for (const exeData of importData.gtfobinsExecutables) {
      const { id: _id, ...exeWithoutId } = exeData;
      await db.gtfobinsExecutables.add(exeWithoutId);
    }
  }

  // Import GTFOBins contexts (if present) - wipe + recreate from the file
  if (importData.gtfobinsContexts && importData.gtfobinsContexts.length > 0) {
    await db.gtfobinsContexts.clear();
    for (const ctxData of importData.gtfobinsContexts) {
      const { id: _id, ...ctxWithoutId } = ctxData;
      await db.gtfobinsContexts.add(ctxWithoutId);
    }
  }

  // Import media (if present)
  if (importData.media && importData.media.length > 0) {
    // Clear existing media first
    await db.media.clear();

    // Import all media files, converting base64 back to Blobs
    for (const mediaData of importData.media) {
      const { id: _id, data, ...mediaWithoutId } = mediaData;
      const blob = dataURLToBlob(data);
      await db.media.add({
        ...mediaWithoutId,
        blob // Store as Blob for efficiency
      });
    }
  }

  if (importData.localStorage) {
    Object.entries(importData.localStorage).forEach(([key, value]) => {
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    });
  }

  return summary;
}

/**
 * Everything the replace path is about to delete, read through the same
 * getters its deletion loop uses, plus row counts for the tables replace
 * only wipes when the file has rows for them (gtfobins*, media).
 */
async function loadExistingForReplace() {
  const { getDocumentsMetadata } = await import('./documents');
  const { getDocumentTemplates } = await import('./documentTemplates');
  const { getTemplates } = await import('../templates/jqlTemplates');
  const { getEngineTemplates } = await import('./engineTemplates');
  const { getDocumentCategories } = await import('./documentCategories');
  const { getWorkflows } = await import('./workflows');
  const { getBoards } = await import('./kanban');
  const { getTasks } = await import('./tasks');
  const { getAllInstances } = await import('./taskwarriorInstances');
  const { getCustomReports } = await import('./customReports');
  const { getSSHCommands } = await import('./sshCommands');
  const { getAllCustomGrids, getAllCustomQuizzes } = await import('./customContentDB');
  const { getOpenshiftTemplates } = await import('./openshiftTemplates');
  const { db } = await import('../db/database');

  const [existingDocs, existingDocTemplates, existingJQLTemplates, existingEngineTemplates, existingWorkflows, existingKanbanBoards, existingTasks, existingInstances, existingReports, existingDocCategories, existingCalendarTemplates, existingSSHCommands, existingCustomGrids, existingCustomQuizzes, existingOpenshiftTemplates, kanbanCardCount, gtfobinsFunctionCount, gtfobinsExecutableCount, gtfobinsContextCount, mediaCount, taskwarriorReportCount] = await Promise.all([
    getDocumentsMetadata(),
    getDocumentTemplates(),
    getTemplates(),
    getEngineTemplates(),
    getWorkflows(),
    getBoards(),
    getTasks(),
    getAllInstances(),
    getCustomReports(),
    getDocumentCategories(),
    db.calendarEventTemplates.toArray(),
    getSSHCommands(),
    getAllCustomGrids(),
    getAllCustomQuizzes(),
    getOpenshiftTemplates(),
    db.kanbanCards.count(),
    db.gtfobinsFunctions.count(),
    db.gtfobinsExecutables.count(),
    db.gtfobinsContexts.count(),
    db.media.count(),
    db.taskwarriorReports.count(),
  ]);

  return {
    existingDocs, existingDocTemplates, existingJQLTemplates, existingEngineTemplates, existingWorkflows,
    existingKanbanBoards, existingTasks, existingInstances, existingReports, existingDocCategories,
    existingCalendarTemplates, existingSSHCommands, existingCustomGrids, existingCustomQuizzes,
    existingOpenshiftTemplates,
    kanbanCardCount, gtfobinsFunctionCount, gtfobinsExecutableCount, gtfobinsContextCount, mediaCount,
    taskwarriorReportCount,
  };
}

/**
 * The plan a replace import of `importData` carries out against `existing`:
 * per type { deleted: rows wiped, created: rows recreated from the file }.
 * Kanban cards whose board is not in the file are invalid (the create loop
 * drops them); the gtfobins tables and media are wiped only when the file has
 * rows for them, exactly as replaceImportDatabase does. This is both what
 * planReplaceImport() (dry run) returns and the summary the real
 * replaceImportDatabase() returns, so the two cannot drift.
 */
function replacePlan(existing, importData) {
  const plan = {};
  const entry = (deletedCount, rows) => {
    const s = newSummary();
    s.deleted = deletedCount;
    for (const row of rows || []) {
      if (row === null || typeof row !== 'object') {
        tallyInvalid(s, '', 'not a record object');
      } else {
        tally(s, 'created', keyPart(row.title) || keyPart(row.name) || keyPart(row.filename) || keyPart(row.uuid) || keyPart(row.funcId) || keyPart(row.contextId) || '');
      }
    }
    return s;
  };
  const wipeIfPresent = (localCount, rows) => entry((rows || []).length > 0 ? localCount : 0, rows);

  plan.documentCategories = entry(existing.existingDocCategories.length, importData.documentCategories);
  plan.documents = entry(existing.existingDocs.length, importData.documents);
  plan.documentTemplates = entry(existing.existingDocTemplates.length, importData.documentTemplates);
  plan.jqlTemplates = entry(existing.existingJQLTemplates.length, importData.jqlTemplates);
  plan.engineTemplates = entry(existing.existingEngineTemplates.length, importData.engineTemplates);
  plan.workflows = entry(existing.existingWorkflows.length, importData.workflows);
  plan.kanbanBoards = entry(existing.existingKanbanBoards.length, importData.kanbanBoards);
  {
    // Cards go with their boards (deleteBoard removes them); a card whose
    // board is missing from the file is dropped by the create loop.
    const boardIds = new Set((importData.kanbanBoards || []).map((b) => b?.id));
    const s = newSummary();
    s.deleted = existing.kanbanCardCount;
    for (const card of importData.kanbanCards || []) {
      const label = card && typeof card === 'object' ? keyPart(card.title) : '';
      if (card === null || typeof card !== 'object') tallyInvalid(s, '', 'not a record object');
      else if (!boardIds.has(card.boardId)) tallyInvalid(s, label, `its board (id ${card.boardId}) is not in the import file`);
      else tally(s, 'created', label);
    }
    plan.kanbanCards = s;
  }
  const tw = importData.taskwarriorTasks;
  if (tw !== null && typeof tw === 'object' && !Array.isArray(tw)) {
    // Format 2: one row per instance. The wipe count is the cache rows of the
    // local instance with that name; the created count is the file's rows
    // (uuid-less ones are dropped). The CLI data files are never touched.
    const localIdByName = new Map();
    for (const inst of existing.existingInstances) {
      const name = keyPart(inst.name, 'New Instance');
      if (!localIdByName.has(name)) localIdByName.set(name, inst.id);
    }
    const fileNames = new Set(Object.keys(tw).map((n) => keyPart(n)));
    const fileInstanceNames = new Set((importData.taskwarriorInstances || []).map((i) => keyPart(i?.name, 'New Instance')));
    for (const [name, rows] of Object.entries(tw)) {
      const s = newTaskSummary(name);
      s.via = 'db';
      s.cacheOnly = true;
      const localId = localIdByName.get(keyPart(name));
      s.deleted = localId == null ? 0 : existing.existingTasks.filter((t) => t.instanceId === localId).length;
      for (const row of Array.isArray(rows) ? rows : []) {
        const label = row && typeof row === 'object' ? keyPart(row.description) || keyPart(row.uuid) : '';
        if (row === null || typeof row !== 'object' || Array.isArray(row)) tallyInvalid(s, '', 'not a task object');
        else if (typeof row.uuid !== 'string' || !row.uuid.trim()) tallyInvalid(s, label, 'task has no uuid');
        else if (!fileInstanceNames.has(keyPart(name))) tallyInvalid(s, label, 'its TaskWarrior instance is not in the import file');
        else {
          tally(s, 'created', label);
          const status = keyPart(row.status, 'pending');
          s.createdByStatus[status] = (s.createdByStatus[status] || 0) + 1;
        }
      }
      noteCreatedByStatus(s);
      plan[`tasks:${name}`] = s;
    }
    // Cache rows of local instances the file does not mention are wiped too.
    const orphanWipe = existing.existingTasks.filter((t) => {
      const inst = existing.existingInstances.find((i) => i.id === t.instanceId);
      return !inst || !fileNames.has(keyPart(inst.name, 'New Instance'));
    }).length;
    if (orphanWipe > 0) {
      const s = newTaskSummary(null);
      s.via = 'db';
      s.cacheOnly = true;
      s.deleted = orphanWipe;
      plan.tasks = s;
    }
    plan.taskwarriorReports = entry(existing.taskwarriorReportCount, importData.taskwarriorReports);
  } else {
    plan.tasks = entry(existing.existingTasks.length, importData.tasks);
  }
  plan.taskwarriorInstances = entry(existing.existingInstances.length, importData.taskwarriorInstances);
  plan.customReports = entry(existing.existingReports.length, importData.customReports);
  plan.calendarEventTemplates = entry(existing.existingCalendarTemplates.length, importData.calendarEventTemplates);
  plan.sshCommands = entry(existing.existingSSHCommands.length, importData.sshCommands);
  plan.customGrids = entry(existing.existingCustomGrids.length, importData.customGrids);
  plan.customQuizzes = entry(existing.existingCustomQuizzes.length, importData.customQuizzes);
  plan.openshiftTemplates = entry(existing.existingOpenshiftTemplates.length, importData.openshiftTemplates);
  plan.gtfobinsFunctions = wipeIfPresent(existing.gtfobinsFunctionCount, importData.gtfobinsFunctions);
  plan.gtfobinsExecutables = wipeIfPresent(existing.gtfobinsExecutableCount, importData.gtfobinsExecutables);
  plan.gtfobinsContexts = wipeIfPresent(existing.gtfobinsContextCount, importData.gtfobinsContexts);
  plan.media = wipeIfPresent(existing.mediaCount, importData.media);
  if (importData.localStorage) {
    const ls = newSummary();
    for (const key of Object.keys(importData.localStorage)) tally(ls, 'updated', key);
    plan.localStorage = ls;
  }
  return plan;
}

/**
 * Dry run of replace mode: what replaceImportDatabase(importData) would
 * delete and recreate right now. Reads only.
 */
export async function planReplaceImport(importData) {
  return replacePlan(await loadExistingForReplace(), importData);
}

/* ------------------------------------------------------------------ */
/* Entry point used by the Import Database modal hosts                 */
/* ------------------------------------------------------------------ */

/**
 * Run (or dry-run) an import in the mode the user picked.
 *
 * @param {object} importData  parsed export file
 * @param {boolean} mergeMode  true = "keep existing data" merge, false = replace
 * @param {{dryRun?: boolean}} options  dryRun: compute the plan, write nothing
 * @returns {{ mode: 'merge'|'replace', dryRun: boolean, summary: object, totals: object }}
 *   summary is per entity type (see newSummary()); totals is mergeTotals(summary).
 *   A dry run and the real run that follows it use the same code, so their
 *   summaries are directly comparable.
 */
export async function runImport(importData, mergeMode, { dryRun = false } = {}) {
  let summary;
  if (mergeMode) {
    summary = await mergeImportDatabase(importData, { dryRun });
  } else {
    summary = dryRun ? await planReplaceImport(importData) : await replaceImportDatabase(importData);
  }
  return { mode: mergeMode ? 'merge' : 'replace', dryRun, summary, totals: mergeTotals(summary) };
}
