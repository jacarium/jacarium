/**
 * The change tracker: a Dexie middleware that notices the app's own writes
 * to the synchronised tables (src/utils/mergeCore.js SYNC_TABLES) and
 * records them in _syncState for src/sync/syncEngine.js to push - an added
 * or updated row as dirty, a deleted row as a tombstone. Writes the engine
 * makes while applying the server's changes carry a mark on their
 * transaction (idbtrans.__syncRemote) and are left alone.
 *
 * Installed by src/db/database.js right where the database is defined -
 * Dexie builds its middleware stack when the database opens, so the
 * tracker must exist before the first open. It imports nothing of the
 * engine: the engine subscribes to `changeSignal` to learn that a push is
 * due.
 */
import { SYNC_TABLES } from '../utils/mergeCore';
import { generateStableId } from '../utils/stableId';

export const STATE_TABLE = '_syncState';

const signalListeners = new Set();
export const changeSignal = {
  subscribe(fn) { signalListeners.add(fn); return () => signalListeners.delete(fn); },
  notify() { for (const fn of signalListeners) { try { fn(); } catch (error) { console.error('[Sync] change listener failed:', error); } } },
};

/** The sync key of a row of `table` (its identity across devices), or null. */
export function syncKeyFor(table, row, primaryKeyPath) {
  const spec = SYNC_TABLES[table];
  if (!spec || !row) return null;
  if (spec.idField === 'primary') {
    const key = primaryKeyPath ? row[primaryKeyPath] : undefined;
    return key == null ? null : String(key);
  }
  const value = row[spec.idField];
  return typeof value === 'string' && value !== '' ? value : null;
}

function ensureIdentity(table, row) {
  const spec = SYNC_TABLES[table];
  // Only the sync-specific identity is minted here: documents' stableId
  // and cards' yjsId are the app's own (createDocument, the import's
  // prepare, the v23 backfill), and a row that still lacks one simply has
  // no sync key until the app assigns it.
  if (!spec || spec.idField !== 'syncId') return row;
  if (typeof row.syncId === 'string' && row.syncId !== '') return row;
  return { ...row, syncId: generateStableId() };
}

export function stateKey(table, key) {
  return [table, key];
}

/** A comparable form of a row (Dates as ISO strings, key order fixed; Blobs by size+type). */
function serialize(row) {
  return JSON.stringify(row, (key, value) => {
    if (value instanceof Date) return value.toISOString();
    if (typeof Blob !== 'undefined' && value instanceof Blob) return `blob:${value.type}:${value.size}`;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.keys(value).sort().reduce((acc, k) => { acc[k] = value[k]; return acc; }, {});
    }
    return value;
  });
}

const installed = new WeakSet();

/** Install the tracker on a Dexie instance (once; before it opens). */
export function installSyncTracker(database) {
  if (installed.has(database)) return;
  installed.add(database);
  database.use({
    stack: 'dbcore',
    name: 'syncTracker',
    create(downlevel) {
      const hasState = downlevel.schema.tables.some((t) => t.name === STATE_TABLE);
      if (!hasState) return downlevel;
      const stateTable = () => downlevel.table(STATE_TABLE);
      return {
        ...downlevel,
        // every read/write transaction also covers the bookkeeping table,
        // so the tracker can write there from inside the app's own writes
        transaction(stores, mode, options) {
          if (mode === 'readwrite' && !stores.includes(STATE_TABLE) && stores.some((s) => SYNC_TABLES[s])) {
            return downlevel.transaction([...stores, STATE_TABLE], mode, options);
          }
          return downlevel.transaction(stores, mode, options);
        },
        table(name) {
          const table = downlevel.table(name);
          const spec = SYNC_TABLES[name];
          if (!spec) return table;
          const primaryKeyPath = table.schema.primaryKey.keyPath;

          async function markDirty(trans, rows, deleted) {
            const keys = [];
            const values = [];
            for (const row of rows) {
              const key = syncKeyFor(name, row, primaryKeyPath);
              if (!key) continue;
              keys.push(stateKey(name, key));
              values.push(key);
            }
            if (!keys.length) return;
            const existing = await stateTable().getMany({ trans, keys });
            const now = Date.now();
            const puts = values.map((key, i) => ({
              collection: name,
              key,
              rev: existing[i]?.rev || 0,
              seq: existing[i]?.seq || 0,
              dirty: 1,
              deleted: deleted ? 1 : 0,
              updatedAt: now,
            }));
            await stateTable().mutate({ type: 'put', trans, values: puts });
            changeSignal.notify();
          }

          return {
            ...table,
            async mutate(req) {
              if (req.trans && req.trans.__syncRemote) return table.mutate(req);
              if (req.type === 'add' || req.type === 'put') {
                let request = req;
                if (Array.isArray(req.values) && req.values.length) {
                  request = { ...req, values: req.values.map((row) => ensureIdentity(name, row)) };
                }
                // what the rows looked like before: a write that changes
                // nothing (the Tasks page re-reading the CLI, a save of an
                // unchanged form) must not be announced as a change, or two
                // devices would hand the same rows back and forth
                let before = new Map();
                try {
                  let priorKeys = [];
                  if (req.type === 'put' && Array.isArray(req.values) && req.values.length && primaryKeyPath) {
                    priorKeys = req.values.map((row) => row[primaryKeyPath]).filter((k) => k !== undefined);
                  } else if (req.updates && Array.isArray(req.updates.keys)) priorKeys = req.updates.keys;
                  else if (req.type === 'put' && Array.isArray(req.keys)) priorKeys = req.keys;
                  if (priorKeys.length) {
                    const rows = await table.getMany({ trans: req.trans, keys: priorKeys });
                    rows.forEach((row, i) => { if (row) before.set(JSON.stringify(priorKeys[i]), serialize(row)); });
                  }
                } catch {
                  before = new Map();
                }
                const res = await table.mutate(request);
                try {
                  let keys = [];
                  if (res.results && res.results.length) keys = res.results;
                  else if (req.updates && Array.isArray(req.updates.keys)) keys = req.updates.keys;
                  else if (Array.isArray(req.keys)) keys = req.keys;
                  else if (req.criteria) {
                    const found = await table.query({ trans: req.trans, values: false, query: { index: table.schema.getIndexByKeyPath(req.criteria.index) || table.schema.primaryKey, range: req.criteria.range } });
                    keys = found.result || [];
                  }
                  if (keys.length) {
                    const rows = await table.getMany({ trans: req.trans, keys });
                    const changed = rows.filter((row, i) => row && before.get(JSON.stringify(keys[i])) !== serialize(row));
                    await markDirty(req.trans, changed, false);
                  }
                } catch (error) {
                  console.error('[Sync] tracking a write failed:', error);
                }
                return res;
              }
              if (req.type === 'delete' || req.type === 'deleteRange') {
                let rows = [];
                try {
                  if (req.type === 'delete') {
                    rows = (await table.getMany({ trans: req.trans, keys: req.keys })).filter(Boolean);
                  } else {
                    const found = await table.query({ trans: req.trans, values: true, query: { index: table.schema.primaryKey, range: req.range } });
                    rows = found.result || [];
                  }
                } catch (error) {
                  console.error('[Sync] reading rows before a delete failed:', error);
                }
                const res = await table.mutate(req);
                try {
                  if (rows.length) await markDirty(req.trans, rows, true);
                } catch (error) {
                  console.error('[Sync] tracking a delete failed:', error);
                }
                return res;
              }
              return table.mutate(req);
            },
          };
        },
      };
    },
  });
}
