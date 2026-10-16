/**
 * Synchronisation of the app's database with the home server
 * (backend/sync_api.py, backend/sync_store.py): every device of an account
 * converges on the same records, with the semantics of "Import with merge"
 * (src/utils/mergeCore.js, shared with src/utils/importDatabase.js) plus
 * what a live two-way sync needs.
 *
 * How it works
 *   - Every synchronised table (SYNC_TABLES) carries a sync identity per
 *     row (documents: stableId, kanban cards: yjsId, keyed tables: their
 *     key, others: syncId), minted once; the v27 upgrade backfilled it.
 *   - A Dexie middleware watches the app's own writes: an added / updated
 *     row is marked dirty in _syncState, a deleted row leaves a tombstone
 *     there. Writes the engine makes while applying the server's changes
 *     are marked on their transaction and not tracked.
 *   - push(): dirty rows (full bodies; Blobs as data URLs; a card's board
 *     and a task's instance referenced by sync key, never by the local
 *     auto-increment id) go to the server with the revision they are based
 *     on. The server answers ok (new rev) or conflict (a concurrent edit
 *     won: the winner comes back and is applied here; a lost document
 *     edit is kept as a "conflict copy" document, and the server keeps the
 *     losing body as a version too).
 *   - pull(): the server's change feed since the last seen sequence,
 *     applied in order. A change to a row this device edited meanwhile is
 *     a concurrent edit: the strictly newer updatedAt wins (importedIsNewer),
 *     the loser is kept (conflict copy for documents), nothing is lost
 *     silently. Rows this device never synchronised are paired with a
 *     server row by the import's natural key (title + category, name, ...)
 *     before anything is created twice; the first reconciliation of a
 *     non-empty database is preceded by a snapshot in export format
 *     (_syncSnapshots, downloadable from Settings).
 *   - Order comes from the server (seq, rev): a device's clock only
 *     matters between two edits of the SAME revision, and the server
 *     clamps a clock that runs ahead.
 *   - When: at start, when the window regains focus or the browser comes
 *     back online, every 30 s while visible, and pullNow() before a
 *     document opens; dirty rows are pushed 1.5 s after the last change.
 */
import { db } from '../db/database';
import { SYNC_TABLES, SYNC_TABLE_NAMES, toMillis, importedIsNewer, missingFieldFills } from '../utils/mergeCore';
import { generateStableId } from '../utils/stableId';
import { STATE_TABLE, changeSignal, installSyncTracker, stateKey, syncKeyFor } from './tracker';
import { snapshotLabel } from './snapshotLabel';
import { isDesktopApp } from '../utils/platform';

const PUSH_DEBOUNCE_MS = 1500;
const PULL_INTERVAL_MS = 30000;
const PUSH_BATCH = 200;
const META_SEQ = 'seq';
const META_DEVICE = 'device';
const META_FIRST_SYNC = 'firstSyncAt';
const META_FIRST_SNAPSHOT = 'firstSyncSnapshotAt';   // the "before first sync" snapshot was taken (once per replica)
const MAX_SNAPSHOTS = 3;   // the newest ones kept; older ones are pruned when a new one is taken
const META_ACCOUNT = 'account';   // the account this database synchronised with
const META_GENERATION = 'generation';   // the server store's generation this database last saw

const status = {
  enabled: false,
  syncing: false,
  lastPullAt: null,
  lastPushAt: null,
  lastError: null,
  lastErrorStatus: null,   // the HTTP status behind lastError (401: the session/link is gone), else null
  pending: 0,
  conflicts: 0,
  serverSkewMs: 0,
  snapshotCount: 0,
  generation: null,
  paused: null,       // why synchronisation is paused (incompatible versions), else null
};
const listeners = new Set();
let transport = null;      // { fetch(path, options) -> Response, device }
let gate = null;           // async () => { ok, reason, transient } - checked before every cycle
let started = false;
let pushTimer = null;
let pullTimer = null;
let running = null;        // the in-flight sync cycle (Promise)
let pullWaiters = [];
let unsubscribeSignal = null;

function emit() {
  for (const fn of listeners) {
    try { fn({ ...status }); } catch (error) { console.error('[Sync] listener failed:', error); }
  }
}

export function getSyncStatus() {
  return { ...status };
}

export function subscribeSyncStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setStatus(partial) {
  Object.assign(status, partial);
  emit();
}

// ---------------------------------------------------------------------------
// identities
// ---------------------------------------------------------------------------
function specOf(table) {
  return SYNC_TABLES[table] || null;
}

/** The sync key of a row (its identity across devices), or null. */
export function syncKeyOf(table, row) {
  return syncKeyFor(table, row, db.table(table).schema.primKey.keyPath);
}

/** Kept for callers that install the tracker late (database.js already does). */
export function installTracker(database = db) {
  installSyncTracker(database);
}

// (the change tracker lives in src/sync/tracker.js, installed by database.js)
const STATE = STATE_TABLE;

/** Run `fn` inside a transaction whose writes the tracker ignores (remote changes). */
async function untracked(tables, fn) {
  const names = [...new Set([...tables, STATE, '_syncMeta'])];
  return db.transaction('rw', names, async (tx) => {
    // the DBCore transaction object is what the middleware sees
    if (tx.idbtrans) tx.idbtrans.__syncRemote = true;
    return fn(tx);
  });
}

// ---------------------------------------------------------------------------
// bodies: what travels through the server
// ---------------------------------------------------------------------------
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [header, base64] = String(dataUrl).split(',');
  const mime = (header.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const binary = atob(base64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function parentSyncKey(table, localId) {
  if (localId == null) return null;
  const parent = await db.table(table).get(localId);
  return parent ? syncKeyOf(table, parent) : null;
}

async function parentLocalId(table, syncKey) {
  if (!syncKey) return null;
  const row = await findLocal(table, syncKey);
  return row ? row.id : null;
}

/** The row as sent to the server. */
export async function encodeBody(table, row) {
  const spec = specOf(table);
  const { id: _id, ...body } = row;
  for (const field of spec.localFields || []) delete body[field];
  if (spec.parent) {
    body[`${spec.parent.field}Sync`] = await parentSyncKey(spec.parent.table, row[spec.parent.field]);
    delete body[spec.parent.field];
  }
  for (const field of spec.blobFields || []) {
    if (body[field] instanceof Blob) body[field] = await blobToDataUrl(body[field]);
  }
  return JSON.parse(JSON.stringify(body)); // Dates -> ISO strings, drop undefined
}

/** A server body as a local row (without id); null when its parent is missing locally. */
export async function decodeBody(table, body) {
  const spec = specOf(table);
  const row = { ...body };
  if (spec.parent) {
    const parentId = await parentLocalId(spec.parent.table, row[`${spec.parent.field}Sync`]);
    delete row[`${spec.parent.field}Sync`];
    if (parentId == null) return null;
    row[spec.parent.field] = parentId;
  }
  for (const field of spec.dateFields || []) {
    if (typeof row[field] === 'string') {
      const t = Date.parse(row[field]);
      if (!Number.isNaN(t)) row[field] = new Date(t);
    }
  }
  for (const field of spec.blobFields || []) {
    if (typeof row[field] === 'string' && row[field].startsWith('data:')) row[field] = dataUrlToBlob(row[field]);
  }
  return row;
}

// ---------------------------------------------------------------------------
// local lookups
// ---------------------------------------------------------------------------
async function findLocal(table, key) {
  const spec = specOf(table);
  const t = db.table(table);
  if (spec.idField === 'primary') {
    // keyed tables: the key is the primary key (strings; numbers for cache-like ids)
    const row = await t.get(key);
    if (row) return row;
    const asNumber = Number(key);
    return Number.isFinite(asNumber) && String(asNumber) === key ? t.get(asNumber) : undefined;
  }
  return t.where(spec.idField).equals(key).first();
}

async function getState(table, key) {
  return db.table(STATE).get(stateKey(table, key));
}

async function putState(table, key, partial) {
  const existing = (await getState(table, key)) || { collection: table, key, rev: 0, seq: 0, dirty: 0, deleted: 0, updatedAt: 0 };
  await db.table(STATE).put({ ...existing, ...partial, collection: table, key });
}

async function getMeta(key) {
  const row = await db.table('_syncMeta').get(key);
  return row ? row.value : undefined;
}

async function setMeta(key, value) {
  await db.table('_syncMeta').put({ key, value });
}

export async function getDeviceId() {
  let id = await getMeta(META_DEVICE);
  if (!id) {
    id = `device-${generateStableId().slice(0, 8)}`;
    await setMeta(META_DEVICE, id);
  }
  return id;
}

/**
 * Queue for upload every row the server has never had: a profile that
 * existed before it was linked holds its documents and the rest without
 * any sync state (the tracker records only what is WRITTEN after it was
 * installed), so without this only the tables the app rewrites at startup
 * would ever reach the server. Runs at every sync start; cheap when there
 * is nothing to do. Pairing on the first pull (natural keys) still decides
 * whether such a row is the same record as one the server already has.
 */
export async function queueUnsyncedRows() {
  let queued = 0;
  for (const table of SYNC_TABLE_NAMES) {
    const spec = specOf(table);
    const rows = await db.table(table).toArray();
    if (!rows.length) continue;
    const keys = rows.map((r) => syncKeyOf(table, r));
    const states = await db.table(STATE).bulkGet(keys.map((k) => stateKey(table, k || '')));
    const missing = [];
    for (let i = 0; i < rows.length; i++) {
      if (!keys[i]) continue;                       // no identity yet: the tracker mints one on the next write
      if (states[i]) continue;                      // known to the engine (dirty, synced or a tombstone)
      missing.push({ collection: table, key: keys[i], rev: 0, seq: 0, dirty: 1, deleted: 0, updatedAt: toMillis(spec.timestamp(rows[i])) ?? Date.now() });
    }
    if (missing.length) {
      await db.table(STATE).bulkPut(missing);
      queued += missing.length;
    }
  }
  if (queued) console.log(`[Sync] queued ${queued} existing record(s) the server never had`);
  return queued;
}

/** Rows of a table the server has never had (no state row, or none with a revision). */
async function unsyncedRows(table) {
  const rows = await db.table(table).toArray();
  if (!rows.length) return [];
  const keys = rows.map((r) => syncKeyOf(table, r));
  const states = await db.table(STATE).bulkGet(keys.map((k) => stateKey(table, k || '')));
  return rows.filter((r, i) => keys[i] && (!states[i] || !states[i].rev));
}

// ---------------------------------------------------------------------------
// conflict copies (documents)
// ---------------------------------------------------------------------------
async function keepConflictCopy(table, local, reason) {
  if (table !== 'documents') return null;
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const copy = {
    ...local,
    id: undefined,
    stableId: generateStableId(),
    title: `${local.title || 'Untitled'} (conflict copy ${when})`,
    updatedAt: Date.now(),
    inCloud: false,
    ownerId: undefined,
    cloudDocumentId: undefined,
    permissions: undefined,
  };
  delete copy.id;
  const id = await db.documents.add(copy); // tracked: it synchronises like any document
  console.warn(`[Sync] kept a conflict copy of "${local.title}" (${reason}) as document ${id}`);
  status.conflicts += 1;
  announceConflict({ table, id: local.id, title: local.title, outcome: 'remote-won', copyId: id, copyTitle: copy.title, reason });
  return id;
}

/** A conflict the pages may tell the user about ('syncConflict' on window): { table, id, title, outcome, copyId?, copyTitle? }. */
function announceConflict(detail) {
  if (typeof window === 'undefined') return;
  try { const EventCtor = window.CustomEvent || CustomEvent; window.dispatchEvent(new EventCtor('syncConflict', { detail })); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// applying the server's changes
// ---------------------------------------------------------------------------
// `onApplied` hears every row this device changed on the server's behalf
// (the Taskwarrior follower applies task rows to the local CLI)
async function applyChange(change, { pairUnsynced, deviceId = null, onApplied = null }) {
  const table = change.collection;
  const spec = specOf(table);
  if (!spec) return 'ignored';
  const key = change.key;
  let state = await getState(table, key);
  if (state && state.rev >= change.rev) return 'seen';   // our own write, or already applied

  let local = await findLocal(table, key);
  let paired = false;

  if (change.deleted) {
    if (!local) {
      await putState(table, key, { rev: change.rev, seq: change.seq, dirty: 0, deleted: 1 });
      return 'tombstone';
    }
    const localTs = spec.timestamp(local);
    if (state?.dirty && !state.deleted && importedIsNewer(localTs, change.updatedAt)) {
      // edited here after it was deleted elsewhere: the edit is newer and wins (it will be pushed)
      await putState(table, key, { rev: change.rev, seq: change.seq });
      return 'kept';
    }
    await untracked([table], async () => { await db.table(table).delete(local.id); });
    await putState(table, key, { rev: change.rev, seq: change.seq, dirty: 0, deleted: 1 });
    if (onApplied) onApplied({ collection: table, key, deleted: true, row: local });
    return 'deleted';
  }

  const body = await decodeBody(table, change.body || {});
  if (body === null) return 'orphan';   // its parent is not here (yet)
  if (spec.idField !== 'primary') body[spec.idField] = key;

  if (!local && pairUnsynced && spec.naturalKey) {
    // first link: a row created here independently with the same natural
    // key becomes the same record (import semantics: the newer content
    // wins, the kept side is completed from the other, nothing duplicated)
    const wanted = spec.naturalKey(body);
    if (wanted != null) {
      const candidate = (await unsyncedRows(table)).find((r) => spec.naturalKey(r) === wanted);
      if (candidate) {
        const oldKey = syncKeyOf(table, candidate);
        await untracked([table], async () => {
          await db.table(table).update(candidate.id, spec.idField === 'primary' ? {} : { [spec.idField]: key });
        });
        if (oldKey && oldKey !== key) await db.table(STATE).delete(stateKey(table, oldKey));
        local = await db.table(table).get(candidate.id);
        state = null;
        paired = true;
      }
    }
  }

  if (!local) {
    let newId = null;
    await untracked([table], async () => { newId = await db.table(table).add(body); });
    await putState(table, key, { rev: change.rev, seq: change.seq, dirty: 0, deleted: 0 });
    if (onApplied) onApplied({ collection: table, key, deleted: false, row: { ...body, id: newId } });
    return 'created';
  }

  const localTs = spec.timestamp(local);
  const remoteTs = spec.timestamp(body) ?? change.updatedAt;
  const keepLocalFields = {};
  for (const field of spec.localFields || []) if (local[field] !== undefined) keepLocalFields[field] = local[field];

  // This revision displaced an edit of THIS device on the server (a
  // concurrent edit elsewhere was newer): the row here still holds that
  // edit - keep it as a copy before it is replaced. The server keeps it as
  // a version as well.
  const displacedMine = !!(change.conflict && deviceId && change.conflict.device === deviceId && !paired);
  const dirty = paired || state?.dirty === 1;
  if (!dirty) {
    if (displacedMine) await keepConflictCopy(table, local, 'a newer edit from another device replaced it');
    await untracked([table], async () => { await db.table(table).put({ ...body, ...keepLocalFields, id: local.id }); });
    await putState(table, key, { rev: change.rev, seq: change.seq, dirty: 0, deleted: 0 });
    if (onApplied) onApplied({ collection: table, key, deleted: false, row: { ...body, ...keepLocalFields, id: local.id } });
    return displacedMine ? 'conflict-remote-won' : 'updated';
  }
  // concurrent: this device changed the row since the revision it knew
  if (importedIsNewer(remoteTs, localTs)) {
    if (!paired) await keepConflictCopy(table, local, 'a newer edit arrived from another device');
    await untracked([table], async () => { await db.table(table).put({ ...body, ...keepLocalFields, id: local.id }); });
    await putState(table, key, { rev: change.rev, seq: change.seq, dirty: 0, deleted: 0 });
    if (onApplied) onApplied({ collection: table, key, deleted: false, row: { ...body, ...keepLocalFields, id: local.id } });
    return paired ? 'paired' : 'conflict-remote-won';
  }
  // The local version is newer (or the same): it stays, completed with
  // what it lacks, and is pushed - based on the revision this device
  // actually edited (not the incoming one), so the server sees the
  // concurrent write, keeps the displaced version and tells its author.
  const fills = missingFieldFills(local, body);
  if (Object.keys(fills).length) {
    await untracked([table], async () => { await db.table(table).update(local.id, fills); });
  }
  // A paired row is an import-merge decision taken here (the local copy is
  // in the snapshot): it is pushed on top of the server's revision, not as
  // a concurrent edit. A real concurrent edit keeps its base revision so
  // the server records the conflict.
  await putState(table, key, paired
    ? { rev: change.rev, seq: change.seq, dirty: 1, deleted: 0 }
    : { seq: change.seq, dirty: 1, deleted: 0, pendingRev: change.rev });
  if (!paired) announceConflict({ table, id: local.id, title: local.title, outcome: 'local-won' });
  return paired ? 'paired' : 'conflict-local-won';
}

// ---------------------------------------------------------------------------
// the safety snapshots (Export Database format, downloadable in Settings)
//
// Exactly two moments take one: before this replica's FIRST reconciliation
// with the server (once - the marker is written when the snapshot is taken,
// so a first cycle that fails afterwards does not take another on the next
// start or relink), and before the device empties itself after a real
// generation bump (the account's data deleted on the server). At most
// MAX_SNAPSHOTS are kept: taking a new one prunes the oldest.
// ---------------------------------------------------------------------------
async function localHasData() {
  for (const name of SYNC_TABLE_NAMES) {
    if ((await db.table(name).count()) > 0) return true;
  }
  return false;
}

async function addSnapshot(kind, reason) {
  const { collectExportData } = await import('../utils/exportDatabase');
  const data = await collectExportData(() => {}, { fetchTasks: async () => null });
  const table = db.table('_syncSnapshots');
  await table.add({ createdAt: Date.now(), kind, reason, json: JSON.stringify(data) });
  const all = await table.orderBy('createdAt').reverse().primaryKeys();
  if (all.length > MAX_SNAPSHOTS) await table.bulkDelete(all.slice(MAX_SNAPSHOTS));
  status.snapshotCount = await table.count();
}

async function snapshotBeforeFirstSync() {
  try {
    await addSnapshot('first-sync', 'before the first synchronisation with the server');
    await setMeta(META_FIRST_SNAPSHOT, Date.now());
    return true;
  } catch (error) {
    console.error('[Sync] snapshot before the first sync failed:', error);
    return false;
  }
}

export async function listSnapshots() {
  return (await db.table('_syncSnapshots').orderBy('createdAt').reverse().toArray()).map(({ id, createdAt, kind, reason, json }) => ({ id, createdAt, kind, reason, bytes: json.length, label: snapshotLabel({ kind, reason, createdAt }) }));
}

export async function getSnapshotJson(id) {
  return (await db.table('_syncSnapshots').get(id))?.json || null;
}

// ---------------------------------------------------------------------------
// pull / push
// ---------------------------------------------------------------------------
async function call(path, options = {}) {
  const response = await transport.fetch(path, options);
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const error = new Error(data?.error || `sync request failed (HTTP ${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  if (typeof data?.now === 'number') status.serverSkewMs = Math.round(data.now - Date.now());
  return data;
}

/**
 * The account's data was deleted on the server on purpose ("Delete all my
 * data on the server"): this device empties its synchronised tables as
 * well instead of uploading them again - after a snapshot (Export Database
 * format, downloadable in Settings), so nothing is lost by accident. Pending
 * local changes are dropped with it: they belong to the deleted data.
 */
async function resetLocalForNewGeneration(generation) {
  if (await localHasData()) {
    try {
      await addSnapshot('server-deletion', 'before this device emptied itself after the account\'s data was deleted on the server');
    } catch (error) {
      console.error('[Sync] snapshot before emptying this device failed:', error);
    }
  }
  await untracked(SYNC_TABLE_NAMES, async () => {
    for (const name of SYNC_TABLE_NAMES) await db.table(name).clear();
    await db.table(STATE).clear();
  });
  await setMeta(META_SEQ, 0);
  await setMeta(META_GENERATION, generation);
  console.warn(`[Sync] the account's data was reset on the server (generation ${generation}): this device emptied its synchronised tables`);
  if (typeof window !== 'undefined') {
    const EventCtor = window.CustomEvent || CustomEvent;
    try { window.dispatchEvent(new EventCtor('syncApplied', { detail: { collections: [...SYNC_TABLE_NAMES], changes: [], reset: true } })); } catch { /* best effort */ }
  }
  setStatus({ generation, pending: 0 });
}

/** Adopt the server's generation; true when this device had an older one and emptied itself. */
async function reconcileGeneration(generation) {
  if (typeof generation !== 'number') return false;
  const known = await getMeta(META_GENERATION);
  if (known === undefined) {
    await setMeta(META_GENERATION, generation);
    status.generation = generation;
    return false;
  }
  if (known === generation) return false;
  await resetLocalForNewGeneration(generation);
  return true;
}

export async function pull() {
  const deviceId = await getDeviceId();
  let since = Number(await getMeta(META_SEQ)) || 0;
  const firstSync = !(await getMeta(META_FIRST_SYNC));
  // the snapshot once per replica: not again when an earlier first cycle failed after taking it
  if (firstSync && !(await getMeta(META_FIRST_SNAPSHOT)) && (await localHasData())) await snapshotBeforeFirstSync();
  const applied = new Set();
  const appliedRows = [];
  const onApplied = (entry) => appliedRows.push(entry);
  let orphans = [];
  let more = true;
  let pages = 0;
  while (more && pages < 200) {
    const page = await call(`/api/sync/pull?since=${since}&limit=500`, { method: 'GET' });
    if (await reconcileGeneration(page.generation)) {
      // start over from the (now empty) server feed
      since = 0;
      pages += 1;
      continue;
    }
    for (const change of page.changes || []) {
      const outcome = await applyChange(change, { pairUnsynced: firstSync, deviceId, onApplied });
      if (outcome === 'orphan') orphans.push(change);
      else if (outcome !== 'seen' && outcome !== 'ignored') applied.add(change.collection);
    }
    since = page.seq || since;
    more = page.more === true && (page.changes || []).length > 0;
    pages += 1;
    await setMeta(META_SEQ, since);
  }
  // children whose parent arrived later in the same feed
  for (let round = 0; round < 3 && orphans.length; round++) {
    const retry = orphans;
    orphans = [];
    for (const change of retry) {
      const outcome = await applyChange(change, { pairUnsynced: firstSync, deviceId, onApplied });
      if (outcome === 'orphan') orphans.push(change);
      else if (outcome !== 'seen' && outcome !== 'ignored') applied.add(change.collection);
    }
  }
  if (firstSync) await setMeta(META_FIRST_SYNC, Date.now());
  setStatus({ lastPullAt: Date.now() });
  if (applied.size && typeof window !== 'undefined') {
    const EventCtor = window.CustomEvent || CustomEvent;
    try {
      window.dispatchEvent(new EventCtor('syncApplied', { detail: { collections: [...applied], changes: appliedRows } }));
    } catch (error) {
      console.error('[Sync] could not announce the applied changes:', error);
    }
  }
  return { applied: [...applied], changes: appliedRows, seq: since };
}

export async function push() {
  const device = await getDeviceId();
  let total = 0;
  let conflicts = 0;
  for (let batch = 0; batch < 50; batch++) {
    const dirty = await db.table(STATE).where('dirty').equals(1).limit(PUSH_BATCH).toArray();
    if (!dirty.length) break;
    const changes = [];
    const rowsByIndex = [];
    for (const entry of dirty) {
      const spec = specOf(entry.collection);
      if (!spec) { await db.table(STATE).delete(stateKey(entry.collection, entry.key)); continue; }
      if (entry.deleted) {
        changes.push({ collection: entry.collection, key: entry.key, baseRev: entry.rev || 0, updatedAt: entry.updatedAt || Date.now(), deleted: true });
        rowsByIndex.push(entry);
        continue;
      }
      const row = await findLocal(entry.collection, entry.key);
      if (!row) {
        // gone without a tombstone (a wipe): send the deletion
        changes.push({ collection: entry.collection, key: entry.key, baseRev: entry.rev || 0, updatedAt: entry.updatedAt || Date.now(), deleted: true });
        rowsByIndex.push(entry);
        continue;
      }
      const body = await encodeBody(entry.collection, row);
      const updatedAt = toMillis(spec.timestamp(row)) ?? entry.updatedAt ?? Date.now();
      changes.push({ collection: entry.collection, key: entry.key, baseRev: entry.rev || 0, updatedAt, deleted: false, body });
      rowsByIndex.push(entry);
    }
    if (!changes.length) break;
    const generation = await getMeta(META_GENERATION);
    let answer;
    try {
      answer = await call('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, changes, ...(generation !== undefined ? { generation } : {}) }) });
    } catch (error) {
      if (error.status === 409 && error.data?.code === 'STALE_GENERATION') {
        // the data this device holds was deleted on the server while it was offline
        await resetLocalForNewGeneration(error.data.generation);
        break;
      }
      throw error;
    }
    const results = answer.results || [];
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      const result = results[i] || { status: 'error', error: 'no answer' };
      if (result.status === 'ok') {
        await putState(change.collection, change.key, { rev: result.rev, seq: result.seq, dirty: 0, deleted: change.deleted ? 1 : 0 });
        total += 1;
      } else if (result.status === 'conflict' && result.winner) {
        conflicts += 1;
        // the other device's edit was newer: it wins here too, ours is kept as a copy
        await putState(change.collection, change.key, { dirty: 1 });
        await applyChange({ ...result.winner, rev: result.winner.rev }, { pairUnsynced: false, deviceId: device, onApplied: (entry) => {
          if (typeof window !== 'undefined') {
            const EventCtor = window.CustomEvent || CustomEvent;
            try { window.dispatchEvent(new EventCtor('syncApplied', { detail: { collections: [entry.collection], changes: [entry] } })); } catch { /* announced best effort */ }
          }
        } });
        // after a lost conflict the row carries the winner: nothing of ours remains to push
        await putState(change.collection, change.key, { rev: result.winner.rev, seq: result.winner.seq, dirty: 0, deleted: result.winner.deleted ? 1 : 0 });
      } else {
        console.error(`[Sync] ${change.collection}/${change.key}: ${result.error || result.status}`);
        setStatus({ lastError: result.error || result.status });
      }
    }
    if (dirty.length < PUSH_BATCH) break;
  }
  setStatus({ lastPushAt: Date.now(), pending: await countPending() });
  return { pushed: total, conflicts };
}

async function countPending() {
  try {
    return await db.table(STATE).where('dirty').equals(1).count();
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// the cycle and its triggers
// ---------------------------------------------------------------------------
async function cycle({ pullFirst = true } = {}) {
  if (running) return running;
  running = (async () => {
    if (gate) {
      // the versions must match before a single record travels
      let verdict = { ok: true };
      try { verdict = await gate(); } catch (error) { verdict = { ok: false, reason: error.message, transient: true }; }
      if (!verdict.ok) {
        setStatus({ syncing: false, paused: verdict.transient ? null : verdict.reason, lastError: verdict.transient ? verdict.reason : null, lastErrorStatus: null, pending: await countPending() });
        running = null;
        const waiters = pullWaiters;
        pullWaiters = [];
        for (const resolve of waiters) resolve();
        return;
      }
      if (status.paused) setStatus({ paused: null });
    }
    setStatus({ syncing: true, lastError: null, lastErrorStatus: null });
    try {
      if (pullFirst) await pull();
      await push();
      if (!pullFirst) await pull();
    } catch (error) {
      console.error('[Sync] cycle failed:', error);
      setStatus({ lastError: error.message, lastErrorStatus: error.status || null });
    } finally {
      setStatus({ syncing: false, pending: await countPending() });
      running = null;
      const waiters = pullWaiters;
      pullWaiters = [];
      for (const resolve of waiters) resolve();
    }
  })();
  return running;
}

export function scheduleFlush() {
  if (!started) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; cycle({ pullFirst: false }); }, PUSH_DEBOUNCE_MS);
}

/** Synchronise now; resolves when the cycle ends (or after `timeout` ms). */
export function syncNow({ timeout = 0 } = {}) {
  if (!started) return Promise.resolve();
  const done = cycle({ pullFirst: true });
  if (!timeout) return done;
  return Promise.race([done, new Promise((resolve) => setTimeout(resolve, timeout))]);
}

/** Fetch the latest changes before showing something (a document opening). */
export function pullNow({ timeout = 2500 } = {}) {
  return syncNow({ timeout });
}

function onVisible() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  cycle({ pullFirst: true });
}

/**
 * Start synchronising. `options.transport` injects the HTTP layer
 * ({ fetch(path, init) }): the desktop app passes its home-server transport
 * (src/utils/homeServer.js), tests their own; a signed-in browser uses
 * apiFetch against its backend. Returns false when it cannot start.
 */
export async function startSync(options = {}) {
  if (started) return true;
  if (!options.transport && isDesktopApp()) {
    // The desktop app's local backend keeps no accounts and answers 401 to
    // /api/sync/*: a desktop profile synchronises with its linked home
    // server, through the main process (src/utils/homeServer.js). Without
    // that transport the engine would only poll the local backend for
    // nothing, so it refuses to start.
    throw new Error('The desktop app synchronises through its home server link, never with its local backend');
  }
  if (options.accountId) {
    // a database synchronises with ONE account: a desktop profile relinked
    // to another account must not pour the first account's data into the
    // second (a browser has a database per account already)
    const known = await getMeta(META_ACCOUNT);
    if (known && known !== options.accountId) {
      const error = new Error('This profile\'s data belongs to another account it synchronised with before. Use a separate profile for each account (Switch Profile), or wipe this profile\'s database first.');
      error.code = 'OTHER_ACCOUNT';
      throw error;
    }
    if (!known) await setMeta(META_ACCOUNT, options.accountId);
  }
  gate = typeof options.gate === 'function' ? options.gate : null;
  if (options.transport) {
    transport = options.transport;
  } else {
    const { getBackendUrl, apiFetch } = await import('../utils/backendUrl');
    const base = await getBackendUrl();
    transport = { fetch: (path, init) => apiFetch(`${base}${path}`, { credentials: 'include', ...init }) };
  }
  installTracker();
  try { await queueUnsyncedRows(); } catch (error) { console.error('[Sync] queueing existing records failed:', error); }
  unsubscribeSignal = changeSignal.subscribe(() => scheduleFlush());
  started = true;
  setStatus({ enabled: true, pending: await countPending(), snapshotCount: await db.table('_syncSnapshots').count().catch(() => 0) });
  if (typeof window !== 'undefined' && options.listen !== false) {
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    pullTimer = setInterval(onVisible, PULL_INTERVAL_MS);
  }
  if (options.immediate !== false) await cycle({ pullFirst: true });
  return true;
}

export function stopSync() {
  if (!started) return;
  started = false;
  gate = null;
  if (unsubscribeSignal) { unsubscribeSignal(); unsubscribeSignal = null; }
  if (pushTimer) clearTimeout(pushTimer);
  if (pullTimer) clearInterval(pullTimer);
  pushTimer = null;
  pullTimer = null;
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', onVisible);
    window.removeEventListener('online', onVisible);
    document.removeEventListener('visibilitychange', onVisible);
  }
  setStatus({ enabled: false, syncing: false });
}

export function isSyncStarted() {
  return started;
}

/**
 * "Delete all my data on the server": the server backs the account's data
 * up, empties its store and bumps the generation; this device then empties
 * itself the same way every other device will at its next synchronisation.
 * Returns the server's answer (backups, generation).
 */
export async function deleteAllServerData({ password, confirmUsername, includeFiles = false }) {
  if (!transport) throw new Error('Synchronisation is not running');
  const answer = await call('/api/account/data/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, confirmUsername, includeFiles }) });
  if (typeof answer.generation === 'number') await resetLocalForNewGeneration(answer.generation);
  return answer;
}

/** The account this database synchronised with (null when it never did). */
export async function syncAccountId() {
  return (await getMeta(META_ACCOUNT)) || null;
}

/** Test hook: reset module state (the database is the caller's business). */
export function __resetSyncForTests() {
  stopSync();
  transport = null;
  running = null;
  pullWaiters = [];
  Object.assign(status, { enabled: false, syncing: false, lastPullAt: null, lastPushAt: null, lastError: null, lastErrorStatus: null, pending: 0, conflicts: 0, serverSkewMs: 0, snapshotCount: 0, generation: null, paused: null });
}
