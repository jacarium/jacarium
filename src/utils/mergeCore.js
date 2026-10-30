/**
 * What "the same record" and "newer" mean - shared by Import with merge
 * (src/utils/importDatabase.js) and synchronisation with the home server
 * (src/sync/syncEngine.js), so the two can never disagree:
 *
 *   - timestamps compare through toMillis(): numbers, Dates and ISO strings
 *     alike; importedIsNewer() is true only when both sides are determinable
 *     and the incoming one is STRICTLY newer;
 *   - a record's natural key (keyPart/joinKey) is what matched records
 *     before every row carried an identity; sync uses it once, when a device
 *     links to the server for the first time, to pair rows that were created
 *     on both sides independently (then both carry the same syncId);
 *   - gap-filling (missingFieldFills) completes a kept local row with the
 *     fields it lacks, never touching what it has.
 *
 * SYNC_TABLES describes every table that synchronises: its sync identity
 * (documents keep their stableId, kanban cards their yjsId, keyed tables
 * their primary key, everything else a syncId minted once), its natural
 * key, its timestamp, and the fields that are Dates in the app's own
 * writes (JSON turns them into strings on the way through the server).
 */

export function toMillis(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * True only when BOTH timestamps are determinable and the imported one is
 * strictly newer. Anything else (missing/unparseable on either side, equal
 * times) means "leave the local record untouched".
 */
export function importedIsNewer(importedTs, localTs) {
  const imported = toMillis(importedTs);
  const local = toMillis(localTs);
  return imported != null && local != null && imported > local;
}

// Normalize one key part: trim strings, fall back to a default for
// empty/missing values (defaults mirror the create* functions so a record
// saved with defaulted fields still matches its exported copy).
export function keyPart(value, fallback = '') {
  const s = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  return s || fallback;
}

export function joinKey(...parts) {
  // JSON.stringify quotes/escapes each part individually, so the joined key
  // is collision-proof regardless of the parts' contents (no delimiter can
  // appear ambiguously) while staying plain printable text. The result is
  // used only as a transient in-memory Map key - never persisted, exported,
  // or compared across sessions - so the encoding is free to change.
  return JSON.stringify(parts);
}

/**
 * True for a value the gap-filling step treats as "nothing here": absent,
 * null, a blank string, an empty array or an empty plain object. Booleans
 * and numbers (false, 0) are real values and are never considered blank, and
 * neither is any non-plain object (Blob, Date, ...).
 */
export function isBlank(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).length === 0;
  }
  return false;
}

/**
 * The subset of `imported` that should be copied onto `local` to complete
 * it: every field that is blank locally (see isBlank) but non-blank in the
 * import. Existing local values are never in the result, so applying it
 * with table.update() keeps everything the user already has (including the
 * local timestamps). `id` is never a candidate. Empty object => nothing to do.
 */
export function missingFieldFills(local, imported) {
  const fills = {};
  for (const [key, value] of Object.entries(imported)) {
    if (key === 'id' || isBlank(value)) continue;
    if (isBlank(local[key])) fills[key] = value;
  }
  return fills;
}

export function withCreateDefaults(record, defaults) {
  const out = { ...record };
  for (const [key, fallback] of Object.entries(defaults)) {
    if (isBlank(out[key])) out[key] = typeof fallback === 'function' ? fallback() : fallback;
  }
  return out;
}

/**
 * Keep an imported timestamp when it is a usable IndexedDB key (number or
 * parseable string), otherwise substitute `now` so the row lands in the
 * table's updatedAt/createdAt index and is listed by the app.
 */
export function indexableTimestamp(value) {
  return toMillis(value) != null ? value : Date.now();
}

const updatedOrCreated = (row) => row.updatedAt ?? row.createdAt;
const byName = (row) => joinKey(keyPart(row.name));
const byNameCategory = (row) => joinKey(keyPart(row.name), keyPart(row.category, 'General'));

/**
 * The synchronised tables. For each:
 *   idField     the field that carries the sync identity (set once, never
 *               changed); 'primary' = the table's own primary key
 *   naturalKey  the import's identity for first-link pairing (null: none)
 *   timestamp   what "newer" compares
 *   dateFields  fields the app writes as Date objects (restored on apply)
 *   blobFields  Blob fields carried as data URLs through the server
 */
export const SYNC_TABLES = {
  documents:              { idField: 'stableId', naturalKey: (d) => joinKey(keyPart(d.title, 'Untitled'), keyPart(d.category, 'General')), timestamp: (d) => d.updatedAt },
  documentTemplates:      { idField: 'syncId', naturalKey: (t) => joinKey(keyPart(t.name, 'Untitled Template'), keyPart(t.category, 'General')), timestamp: (t) => t.updatedAt },
  templates:              { idField: 'syncId', naturalKey: byNameCategory, timestamp: updatedOrCreated },
  engineTemplates:        { idField: 'syncId', naturalKey: byNameCategory, timestamp: updatedOrCreated },
  workflows:              { idField: 'syncId', naturalKey: (w) => joinKey(keyPart(w.title, 'Untitled Workflow'), keyPart(w.category, 'General')), timestamp: updatedOrCreated },
  kanbanBoards:           { idField: 'syncId', naturalKey: (b) => joinKey(keyPart(b.title), keyPart(b.category, 'General')), timestamp: updatedOrCreated, dateFields: ['createdAt', 'updatedAt'] },
  kanbanCards:            { idField: 'yjsId', naturalKey: null, timestamp: updatedOrCreated, dateFields: ['createdAt', 'updatedAt'], parent: { field: 'boardId', table: 'kanbanBoards' } },
  // a task's identity is its Taskwarrior uuid - the same on every device and
  // in the CLI's own data - so an edit made through any device's Taskwarrior
  // meets the same record everywhere (src/sync/taskwarriorFollow.js)
  tasks:                  { idField: 'uuid', naturalKey: null, timestamp: (t) => t.modified ?? t.updatedAt, parent: { field: 'instanceId', table: 'taskwarriorInstances' } },
  taskwarriorInstances:   { idField: 'syncId', naturalKey: byName, timestamp: updatedOrCreated, localFields: ['isActive'] },
  taskwarriorReports:     { idField: 'syncId', naturalKey: null, timestamp: updatedOrCreated, parent: { field: 'instanceId', table: 'taskwarriorInstances' } },
  customReports:          { idField: 'syncId', naturalKey: byName, timestamp: updatedOrCreated },
  documentCategories:     { idField: 'syncId', naturalKey: byName, timestamp: updatedOrCreated },
  syncedCalendars:        { idField: 'primary', naturalKey: null, timestamp: updatedOrCreated },
  calendarEventTemplates: { idField: 'syncId', naturalKey: byName, timestamp: updatedOrCreated },
  sshCommands:            { idField: 'syncId', naturalKey: byName, timestamp: updatedOrCreated },
  openshiftTemplates:     { idField: 'syncId', naturalKey: byNameCategory, timestamp: updatedOrCreated },
  media:                  { idField: 'syncId', naturalKey: (m) => joinKey(keyPart(m.filename)), timestamp: (m) => m.updatedAt || m.uploadedAt, blobFields: ['blob'] },   // updatedAt: a replaced image (src/utils/media.js replaceMedia)
  gtfobinsFunctions:      { idField: 'syncId', naturalKey: (f) => joinKey(keyPart(f.funcId)), timestamp: () => null },
  gtfobinsExecutables:    { idField: 'syncId', naturalKey: byName, timestamp: (e) => e.updatedAt },
  gtfobinsContexts:       { idField: 'syncId', naturalKey: (c) => joinKey(keyPart(c.contextId)), timestamp: () => null },
  customFields:           { idField: 'primary', naturalKey: null, timestamp: (f) => f.createdAt },
  envVariables:           { idField: 'primary', naturalKey: null, timestamp: () => null },
  // the open tabs of the pages, one row per tab (src/utils/openTabsSync.js):
  // the row's id is "<page>:<item>", last writer wins per tab
  openTabs:               { idField: 'primary', naturalKey: null, timestamp: (t) => t.updatedAt },
};

export const SYNC_TABLE_NAMES = Object.keys(SYNC_TABLES);
