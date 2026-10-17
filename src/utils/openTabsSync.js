/**
 * The open tabs of a page, shared by every device of the account.
 *
 * Each open tab of a page (the documents of the left pane, the Kanban
 * boards, the task lists and reports, the calendars, the tools) is one row
 * of the `openTabs` table, its id "<page>:<item>" where `item` is the id the
 * item has on every device (a document's stableId, a board's syncId, a
 * calendar's id, a tool's id) - never the local Dexie id. The table is one
 * of the synchronised ones (src/utils/mergeCore.js), so the rows travel
 * through the account's own channel like everything else (src/sync/): a
 * tab opened here is a row, one closed here is a tombstone, and the
 * other devices apply them (useSyncedOpenTabs). One row per tab means an
 * open on one device and a close of another tab on another never
 * conflict; the same tab opened and closed at nearly the same time
 * resolves last-writer-wins for that tab alone. The rows carry ids,
 * titles and positions - never content.
 *
 * What this device last reconciled as its own open tabs of a page - the
 * "mirrored" item set - is kept per page in localStorage, because a page
 * is unmounted whenever another page is shown and rows keep arriving
 * meanwhile: a local write only ever deletes the rows of tabs THIS device
 * had and closed (in the mirrored set, no longer open), never rows it has
 * never had open (a tab opened elsewhere while this page was away must
 * open here, not be wiped); and a local tab whose row is gone counts as
 * closed elsewhere only when this device had mirrored it (so a tab that
 * was never written yet is not closed by the table's silence).
 *
 * Without a server, or signed out, nothing is pushed and nothing arrives:
 * the pages behave as they always did. Settings > General: "Sync open
 * tabs across devices" (on unless switched off) turns the mirroring off in
 * both directions; the rows already synchronised are left as they are.
 */
import { db } from '../db/database';
import { isSyncStarted } from '../sync/syncEngine';

export const OPEN_TABS_SETTING = 'openTabsSyncEnabled';
export const OPEN_TABS_CHANGED_EVENT = 'openTabsSyncChanged';

export function isOpenTabsSyncEnabled() {
  try { return localStorage.getItem(OPEN_TABS_SETTING) !== 'false'; } catch { return true; }
}

export function setOpenTabsSyncEnabled(enabled) {
  try { localStorage.setItem(OPEN_TABS_SETTING, enabled ? 'true' : 'false'); } catch { /* storage unavailable */ }
  try { window.dispatchEvent(new CustomEvent(OPEN_TABS_CHANGED_EVENT, { detail: { enabled: !!enabled } })); } catch { /* no window */ }
}

/** Whether the tabs are mirrored right now: the setting is on and the account's synchronisation runs. */
export function isOpenTabsSyncActive() {
  return isOpenTabsSyncEnabled() && isSyncStarted();
}

export const tabId = (page, item) => `${page}:${item}`;

/** The items this device last reconciled as its open tabs of `page` (persisted: the page unmounts, the device restarts). */
export function loadMirrored(page) {
  try { const raw = localStorage.getItem(`openTabsMirrored:${page}`); const list = raw ? JSON.parse(raw) : []; return new Set(Array.isArray(list) ? list.map(String) : []); } catch { return new Set(); }
}
export function saveMirrored(page, items) {
  try { localStorage.setItem(`openTabsMirrored:${page}`, JSON.stringify([...new Set([...items].map(String))])); } catch { /* storage unavailable */ }
}

/** The synchronised rows of a page, in tab order. */
export async function readSyncedTabs(page) {
  const rows = await db.table('openTabs').where('page').equals(page).toArray();
  return rows.sort((a, b) => (a.position - b.position) || ((a.openedAt || 0) - (b.openedAt || 0)) || String(a.id).localeCompare(String(b.id)));
}

/**
 * What writing `tabs` ([{ item, title }] in order) over `rows` takes: the
 * rows to put (new, retitled or moved) and the ids to delete - only the
 * rows of tabs this device had (`mirrored`) and no longer has: closed
 * here. A row this device never mirrored (opened elsewhere, maybe while
 * this page was away) is never deleted by a local write. Pure, for the
 * tests.
 */
export function planWrite(page, tabs, rows, mirrored = new Set(), now = Date.now()) {
  const wanted = new Map();
  tabs.forEach((tab, position) => {
    if (tab && tab.item != null && tab.item !== '' && !wanted.has(String(tab.item))) wanted.set(String(tab.item), { title: tab.title == null ? '' : String(tab.title), position });
  });
  const existing = new Map(rows.map((r) => [String(r.item), r]));
  const puts = [];
  for (const [item, { title, position }] of wanted) {
    const row = existing.get(item);
    if (row && row.title === title && row.position === position) continue;
    puts.push({ id: tabId(page, item), page, item, title, position, openedAt: row?.openedAt ?? now, updatedAt: now });
  }
  const deletes = rows.filter((r) => !wanted.has(String(r.item)) && mirrored.has(String(r.item))).map((r) => r.id);
  return { puts, deletes };
}

/**
 * Mirror the page's tabs into the table (see planWrite) and remember them
 * as this device's mirrored set. The rows of tabs opened elsewhere that
 * this page has not applied yet stay (and are applied next).
 */
export async function writeSyncedTabs(page, tabs) {
  const rows = await readSyncedTabs(page);
  const mirrored = loadMirrored(page);
  const { puts, deletes } = planWrite(page, tabs, rows, mirrored);
  if (puts.length || deletes.length) {
    await db.transaction('rw', db.table('openTabs'), async () => {
      if (puts.length) await db.table('openTabs').bulkPut(puts);
      if (deletes.length) await db.table('openTabs').bulkDelete(deletes);
    });
  }
  saveMirrored(page, tabs.filter((t) => t && t.item != null && t.item !== '').map((t) => String(t.item)));
  return { puts: puts.length, deletes: deletes.length };
}

/**
 * What the synchronised rows mean for the local tabs ([{ item }] in order,
 * `item` null for a tab that cannot be synchronised): the items to open
 * (rows with no local tab), the items to close (local tabs this device had
 * mirrored - `mirrored` - whose row is gone: closed elsewhere; a tab not
 * mirrored yet is this device's own, still to be written), and the order
 * the rows give to the tabs that have one. Pure, for the tests.
 */
export function planApply(tabs, rows, mirrored = new Set()) {
  const local = new Set(tabs.map((t) => (t && t.item != null ? String(t.item) : null)).filter(Boolean));
  const remote = new Map(rows.map((r) => [String(r.item), r]));
  const open = rows.filter((r) => !local.has(String(r.item))).map((r) => ({ item: String(r.item), title: r.title, position: r.position }));
  const close = tabs.filter((t) => t && t.item != null && !remote.has(String(t.item)) && mirrored.has(String(t.item))).map((t) => String(t.item));
  const order = rows.map((r) => String(r.item));
  return { open, close, order };
}
