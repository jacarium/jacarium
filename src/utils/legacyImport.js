/**
 * Adopting a browser's pre-sign-in data into an account's database.
 *
 * Before accounts existed the app in a browser kept everything in one
 * IndexedDB database, 'Jacarium'. With sign-in each account has its
 * own (Jacarium-<user id>, src/db/database.js), which starts empty.
 * On an account's first sign-in in a browser that still holds the old
 * database, src/main.jsx offers to copy it over (src/components/auth/
 * AuthGate.jsx) - copy, table by table, row by row, ids included, so every
 * reference between tables (instanceId, boardId, ...) and every media blob
 * stays exactly as it was. The old database is left in place; a marker
 * in localStorage remembers the decision per account, and Settings >
 * General offers to delete the old database once the user is sure.
 *
 * Only tables that exist in both databases are copied, and only into an
 * empty target table (a non-empty one is never merged over - that is what
 * Settings > Import Database is for).
 *
 * Where it does NOT apply: the desktop app. A desktop profile keeps the one
 * 'Jacarium' database whether it is linked to a home server or not (that
 * database IS its replica of the account), so there is no "old" database
 * next to an account one - the offer and the "delete old data" control
 * never show there, and deleteLegacyDatabase refuses to touch the live
 * database. And an old database that holds no user data (only seeded or
 * empty tables) is not offered either: the check reads it without creating
 * it (Dexie.exists, then an open in dynamic mode).
 */
import Dexie from 'dexie';

export const LEGACY_DATABASE_NAME = 'Jacarium';

/** Tables whose rows are the user's own data (seeded reference tables are not). */
export const USER_DATA_TABLES = ['documents', 'documentCategories', 'documentTemplates', 'templates', 'engineTemplates', 'workflows', 'kanbanBoards', 'kanbanCards', 'taskwarriorInstances', 'tasks', 'customReports', 'calendarEventTemplates', 'sshCommands', 'openshiftTemplates', 'media'];

/** True where an account database sits next to the old one: the browser signed in to a server with accounts. The desktop app keeps the one database and is excluded. */
export function legacyDatabaseApplies() {
  if (typeof window === 'undefined') return false;
  if (window.electronAPI) return false;   // the desktop: 'Jacarium' is the live database
  const live = typeof globalThis !== 'undefined' ? globalThis.__JACARIUM_DB_NAME : null;
  return !live || live !== LEGACY_DATABASE_NAME;
}

function markerKey(userId) {
  return `legacyImportDecided:${userId}`;
}

export async function legacyDatabaseExists() {
  if (!legacyDatabaseApplies()) return false;
  try {
    return await Dexie.exists(LEGACY_DATABASE_NAME);
  } catch {
    return false;
  }
}

/**
 * True when the old database holds user data (rows in USER_DATA_TABLES).
 * Never creates the database: nothing is opened unless it exists, and the
 * open is in dynamic mode (the stored schema as it is).
 */
export async function legacyDatabaseHasUserData() {
  if (!(await legacyDatabaseExists())) return false;
  const legacy = new Dexie(LEGACY_DATABASE_NAME);
  try {
    await legacy.open();
    for (const table of legacy.tables) {
      if (!USER_DATA_TABLES.includes(table.name)) continue;
      if ((await table.count()) > 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    try { legacy.close(); } catch { /* not open */ }
  }
}

export function legacyImportDecided(userId) {
  try {
    return window.localStorage.getItem(markerKey(userId)) !== null;
  } catch {
    return true;
  }
}

export function rememberLegacyDecision(userId, decision) {
  try {
    window.localStorage.setItem(markerKey(userId), decision);
  } catch {
    // storage unavailable: the prompt shows again next time, which is fine
  }
}

/** True when the account should be asked about the old database: it applies here, holds user data, and this account has not decided yet. */
export async function shouldOfferLegacyImport(userId) {
  if (!userId || legacyImportDecided(userId)) return false;
  return legacyDatabaseHasUserData();
}

/** True when Settings should offer to delete the old database: it applies, holds user data, and was not deleted already. */
export async function shouldOfferLegacyDelete(userId) {
  if (userId && legacyImportDecided(userId) && window.localStorage.getItem(markerKey(userId)) === 'deleted') return false;
  return legacyDatabaseHasUserData();
}

/**
 * Copy every table of the legacy database into `targetDb` (an opened Dexie
 * instance of the account's database). Returns { tables, rows, skipped }.
 */
export async function importLegacyDatabase(targetDb, onProgress = () => {}) {
  const legacy = new Dexie(LEGACY_DATABASE_NAME);
  await legacy.open(); // dynamic mode: the stored schema as it is
  const result = { tables: 0, rows: 0, skipped: [] };
  try {
    const targetNames = new Set(targetDb.tables.map((t) => t.name));
    for (const table of legacy.tables) {
      if (!targetNames.has(table.name)) {
        result.skipped.push(`${table.name} (not in this version)`);
        continue;
      }
      const target = targetDb.table(table.name);
      if ((await target.count()) > 0) {
        result.skipped.push(`${table.name} (already has data)`);
        continue;
      }
      const rows = await table.toArray();
      if (rows.length === 0) continue;
      if (table.schema.primKey.keyPath) {
        // the key lives inside each row (every app table: ++id or &key)
        await target.bulkPut(rows);
      } else {
        // out-of-line keys: carry the keys along
        const keys = await table.toCollection().primaryKeys();
        await target.bulkPut(rows, keys);
      }
      result.tables += 1;
      result.rows += rows.length;
      onProgress({ table: table.name, rows: rows.length });
    }
  } finally {
    legacy.close();
  }
  return result;
}

/** Remove the old database for good (Settings > General, after confirmation); never the live one. */
export async function deleteLegacyDatabase(userId = null) {
  if (!legacyDatabaseApplies()) throw new Error('This is the database in use here, not an old one - nothing was deleted');
  await Dexie.delete(LEGACY_DATABASE_NAME);
  if (userId) rememberLegacyDecision(userId, 'deleted');
}
