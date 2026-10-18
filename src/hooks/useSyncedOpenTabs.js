import { useEffect, useRef } from 'react';
import { readSyncedTabs, writeSyncedTabs, planApply, loadMirrored, saveMirrored, isOpenTabsSyncActive, OPEN_TABS_CHANGED_EVENT } from '../utils/openTabsSync';
import { subscribeSyncStatus } from '../sync/syncEngine';

/**
 * Keeps a page's open tabs in step with the account's other devices
 * (src/utils/openTabsSync.js). The page owns its tab list as before; this
 * hook mirrors it:
 *
 *  - synced -> local, first: when the page mounts, when the synchronisation
 *    starts or the setting is switched on, and whenever rows arrive (the
 *    engine's 'syncApplied' event for the openTabs collection), rows with
 *    no local tab are opened - `resolve(item)` gives the local tab for an
 *    id, or null when the item is not here (deleted, not shared: dropped
 *    quietly) - appended, never made active; local tabs this device had
 *    mirrored whose row is gone were closed elsewhere: `onClose(tab)`
 *    closes them here the way the page closes a tab (the page's own close
 *    handler, so an active tab closed elsewhere gives way to its
 *    neighbour); the order of the tabs that have rows follows the rows'
 *    positions; when the page shows nothing (`active` null - a fresh
 *    device, or the shown item gone), the first tab that arrived is opened
 *    through the page's own open path, `onOpen(tab)` (the one a tap on the
 *    tab takes: it loads the content; appending a tab alone shows nothing);
 *    a row that arrived before its item did (the document, the board) is
 *    applied once the item arrives (`itemCollection`: the item table's
 *    'syncApplied' re-applies);
 *  - local -> synced, then: the page's tabs are written to the table -
 *    `itemOf(tab)` gives a tab's cross-device id (a stableId, a syncId, a
 *    calendar or tool id; may be async; null for a tab that cannot be
 *    synchronised), `titleOf(tab)` its title - deleting only the rows of
 *    tabs this device itself closed (the mirrored set, persisted per page,
 *    so a page that was away, or a restarted device, never wipes what was
 *    opened elsewhere meanwhile).
 *
 * The two directions run one after the other (a queue), never interleaved.
 * The active tab, the scroll positions and the editors' unsaved state are
 * never touched. Nothing happens without a server, signed out, or with the
 * setting off.
 */
export default function useSyncedOpenTabs({ page, tabs, setTabs, itemOf, titleOf, resolve, onClose, onOpen = null, active = null, itemCollection = null, enabled = true }) {
  const tabsRef = useRef(tabs);
  const handlers = useRef({ itemOf, titleOf, resolve, onClose, onOpen, setTabs, active });
  const chain = useRef(Promise.resolve());
  // the latest callbacks and the shown item, for the listeners below (they outlive a render)
  useEffect(() => { handlers.current = { itemOf, titleOf, resolve, onClose, onOpen, setTabs, active }; });

  const run = (fn) => {
    const next = chain.current.then(fn, fn);
    chain.current = next.catch(() => {});
    return next;
  };
  const withItems = async (list) => Promise.all(list.map(async (tab) => ({ tab, item: await handlers.current.itemOf(tab) })));

  // local -> synced
  const mirror = () => run(async () => {
    if (!enabled || !isOpenTabsSyncActive()) return;
    const current = await withItems(tabsRef.current);
    const list = current.filter(({ item }) => item != null).map(({ tab, item }) => ({ item: String(item), title: handlers.current.titleOf(tab) }));
    try {
      await writeSyncedTabs(page, list);
    } catch (error) {
      console.warn('[Open tabs] could not mirror the tabs:', error?.message || error);
    }
  });

  // synced -> local
  const apply = () => run(async () => {
    if (!enabled || !isOpenTabsSyncActive()) return;
    const rows = await readSyncedTabs(page);
    const current = await withItems(tabsRef.current);
    const mirrored = loadMirrored(page);
    const plan = planApply(current.map(({ item }) => ({ item })), rows, mirrored);
    const opened = [];
    for (const { item } of plan.open) {
      const tab = await handlers.current.resolve(item);
      if (tab != null) opened.push({ item, tab });
    }
    if (opened.length) {
      const keyed = new Map(current.map(({ tab, item }) => [tab, item == null ? null : String(item)]));
      for (const { item, tab } of opened) keyed.set(tab, item);
      const rank = new Map(plan.order.map((item, i) => [item, i]));
      handlers.current.setTabs((prev) => {
        const have = new Set(prev.map((tab) => keyed.get(tab)).filter(Boolean));
        const next = [...prev, ...opened.filter(({ item }) => !have.has(item)).map(({ tab }) => tab)];
        // the order the rows give: tabs with a row by position, the rest after, as they were
        return next.map((tab, i) => ({ tab, i, r: rank.has(keyed.get(tab)) ? rank.get(keyed.get(tab)) : Number.MAX_SAFE_INTEGER })).sort((a, b) => (a.r - b.r) || (a.i - b.i)).map(({ tab }) => tab);
      });
    }
    for (const { tab, item } of current) if (item != null && plan.close.includes(String(item))) handlers.current.onClose(tab);
    // what this device now holds as reconciled: its tabs minus the closed ones, plus the opened ones
    const held = current.filter(({ item }) => item != null && !plan.close.includes(String(item))).map(({ item }) => String(item));
    saveMirrored(page, [...held, ...opened.map(({ item }) => item)]);
    // nothing shown on this page: the first tab that arrived is to be shown,
    // the way a tap on it would - once it has rendered (the tabs effect
    // below), so the page's open path finds it among the tabs and switches
    // to it instead of adding it again
    if (opened.length && handlers.current.onOpen && handlers.current.active == null) pendingOpen.current = opened[0].tab;
  });

  // the page's tabs changed: mirror them (the first run, at mount, comes after the apply below)
  const mounted = useRef(false);
  const pendingOpen = useRef(null);
  useEffect(() => {
    tabsRef.current = tabs;
    if (mounted.current) mirror();
    // the synced-in tab to show has rendered: open it through the page's path
    // (the handlers effect above ran first: it holds this render's callbacks)
    const pending = pendingOpen.current;
    if (pending && tabs.includes(pending)) {
      pendingOpen.current = null;
      if (handlers.current.active == null) handlers.current.onOpen(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, tabs, enabled]);

  // at mount and whenever the mirroring (re)starts: what arrived first, then this page's own tabs;
  // rows arriving later: apply
  useEffect(() => {
    if (!enabled) return undefined;
    mounted.current = true;
    const refresh = () => { apply().catch((error) => console.warn('[Open tabs] could not apply the synchronised tabs:', error?.message || error)); mirror(); };
    const onApplied = (e) => { const c = e.detail?.collections || []; if (!e.detail || e.detail.reset || c.includes('openTabs') || (itemCollection && c.includes(itemCollection))) apply().catch((error) => console.warn('[Open tabs] could not apply the synchronised tabs:', error?.message || error)); };
    window.addEventListener('syncApplied', onApplied);
    window.addEventListener(OPEN_TABS_CHANGED_EVENT, refresh);
    let wasActive = isOpenTabsSyncActive();
    const unsubscribe = subscribeSyncStatus(() => { const now = isOpenTabsSyncActive(); if (now && !wasActive) refresh(); wasActive = now; });
    refresh();
    return () => { mounted.current = false; window.removeEventListener('syncApplied', onApplied); window.removeEventListener(OPEN_TABS_CHANGED_EVENT, refresh); unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, enabled]);
}
