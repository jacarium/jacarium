#!/usr/bin/env node
/**
 * useSyncedOpenTabs (src/hooks/useSyncedOpenTabs.js) and the planning in
 * src/utils/openTabsSync.js, in jsdom with fake-indexeddb and a stubbed
 * synchronisation (the engine is told it is started; rows are put into the
 * openTabs table by hand and announced with the 'syncApplied' event, as the
 * engine does):
 *
 *   - planWrite / planApply: puts, deletes, opens, closes and the order;
 *     a local write deletes only rows of tabs this device had (mirrored)
 *     and closed, never a row it never had open; a tab this device never
 *     mirrored is never closed by its absence from the table;
 *   - a page's tabs are mirrored into the table (ids, titles, positions),
 *     a tab closed on the page becomes a deletion;
 *   - rows that arrive open tabs on the page (appended, resolved to the
 *     local item; unknown items dropped), rows that vanish close them
 *     through the page's own close handler (so an active tab gives way);
 *     the active tab is never changed by an arrival;
 *   - the setting off: nothing is written and nothing is applied, both ways;
 *   - the page away (unmounted) while rows arrive and leave: at the next
 *     mount a tab opened elsewhere appears (not wiped), one closed
 *     elsewhere closes; a restart (fresh hook state, the persisted mirrored
 *     set) keeps the other device's tabs; two devices freshly enabling the
 *     mirroring with different tabs end with the union.
 *
 * Run: node tests/synced-open-tabs-hook.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, sleep } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'helpers', 'synced-open-tabs-entry.mjs');
fs.writeFileSync(entry, `
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { db } from '@worktree/src/db/database.js';
import * as engine from '@worktree/src/sync/syncEngine.js';
import useSyncedOpenTabs from '@worktree/src/hooks/useSyncedOpenTabs.js';
import { planWrite, planApply, readSyncedTabs, writeSyncedTabs, loadMirrored, saveMirrored, setOpenTabsSyncEnabled, isOpenTabsSyncEnabled, isOpenTabsSyncActive } from '@worktree/src/utils/openTabsSync.js';
export { React, useState, act, createRoot, db, engine, useSyncedOpenTabs, planWrite, planApply, readSyncedTabs, writeSyncedTabs, loadMirrored, saveMirrored, setOpenTabsSyncEnabled, isOpenTabsSyncEnabled, isOpenTabsSyncActive };
`);

const { check, summary } = makeChecker();
const env = await setupDocumentsEnv('synced-open-tabs-hook', { entry });
const { mod, window } = env;
const { React, useState, act, createRoot, db, engine, useSyncedOpenTabs, planWrite, planApply, readSyncedTabs, writeSyncedTabs, loadMirrored, saveMirrored, setOpenTabsSyncEnabled, isOpenTabsSyncActive } = mod;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { document } = window;

try {
  // ---- 1. the plans ----
  const rows0 = [];
  let plan = planWrite('documents', [{ item: 'a', title: 'A' }, { item: 'b', title: 'B' }], rows0, new Set(), 1000);
  check('1. planWrite: two tabs over an empty table are two rows with positions 0 and 1', plan.puts.length === 2 && plan.deletes.length === 0 && plan.puts[0].id === 'documents:a' && plan.puts[1].position === 1 && plan.puts[0].openedAt === 1000, JSON.stringify(plan));
  const rows1 = plan.puts;
  plan = planWrite('documents', [{ item: 'b', title: 'B' }], rows1, new Set(['a', 'b']), 2000);
  check('   closing A (which this device had) and keeping B: B moves to position 0, A is deleted', plan.deletes.join() === 'documents:a' && plan.puts.length === 1 && plan.puts[0].item === 'b' && plan.puts[0].position === 0 && plan.puts[0].openedAt === 1000, JSON.stringify(plan));
  plan = planWrite('documents', [{ item: 'b', title: 'B' }], rows1, new Set(['b']), 2000);
  check('   a row this device never had open (opened elsewhere while away) is NOT deleted by a local write', plan.deletes.length === 0 && plan.puts.length === 1 && plan.puts[0].item === 'b', JSON.stringify(plan));
  plan = planWrite('documents', [{ item: 'a', title: 'A' }, { item: 'b', title: 'B' }], rows1, new Set(['a', 'b']), 3000);
  check('   the same tabs again write nothing', plan.puts.length === 0 && plan.deletes.length === 0);
  plan = planWrite('documents', [{ item: 'a', title: 'A renamed' }, { item: 'b', title: 'B' }], rows1, new Set(['a', 'b']), 3000);
  check('   a retitled tab is one put, keeping its openedAt', plan.puts.length === 1 && plan.puts[0].title === 'A renamed' && plan.puts[0].openedAt === 1000);
  plan = planWrite('documents', [{ item: null, title: 'local only' }, { item: 'a', title: 'A' }], [], new Set(), 1);
  check('   a tab without a cross-device id is not written', plan.puts.length === 1 && plan.puts[0].item === 'a');

  let apply = planApply([{ item: 'a' }], [{ item: 'a', position: 0 }, { item: 'c', position: 1 }], new Set(['a']));
  check('   planApply: a row with no local tab is to be opened, nothing closed', apply.open.map((o) => o.item).join() === 'c' && apply.close.length === 0 && apply.order.join() === 'a,c', JSON.stringify(apply));
  apply = planApply([{ item: 'a' }, { item: 'b' }], [{ item: 'a', position: 0 }], new Set(['a', 'b']));
  check('   a local tab this device had mirrored whose row is gone is to be closed', apply.close.join() === 'b' && apply.open.length === 0, JSON.stringify(apply));
  apply = planApply([{ item: 'a' }, { item: 'b' }], [{ item: 'a', position: 0 }], new Set(['a']));
  check('   ...but a tab not mirrored yet (this device\'s own, still to be written) is left alone', apply.close.length === 0, JSON.stringify(apply));
  apply = planApply([{ item: null }, { item: 'a' }], [], new Set(['a']));
  check('   a tab without a cross-device id is never closed by the table (the one with an id, mirrored and gone, is)', apply.close.join() === 'a', JSON.stringify(apply));

  // ---- 2. the hook on a page ----
  await db.open();
  engine.__resetSyncForTests?.();
  // the engine says "started" without a server: the hook needs isSyncStarted()
  await engine.startSync({ transport: { fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) }, listen: false, immediate: false });
  check('2. the mirroring is active (setting on by default, synchronisation started)', isOpenTabsSyncActive());

  const docs = await db.documents.bulkAdd([
    { title: 'Alpha', content: '', category: 'General', stableId: 'sid-alpha', createdAt: new Date(), updatedAt: new Date() },
    { title: 'Beta', content: '', category: 'General', stableId: 'sid-beta', createdAt: new Date(), updatedAt: new Date() },
    { title: 'Gamma', content: '', category: 'Runbooks', stableId: 'sid-gamma', createdAt: new Date(), updatedAt: new Date() },
  ], { allKeys: true });
  const [alphaId, betaId, gammaId] = docs;
  const closed = [];
  let api = null;
  function Page({ initial }) {
    const [tabs, setTabs] = useState(initial);
    const [active, setActive] = useState(initial[0]?.id ?? null);
    api = { tabs, setTabs, active, setActive };
    useSyncedOpenTabs({
      page: 'documents', tabs, setTabs,
      itemOf: async (tab) => (await db.documents.get(tab.id))?.stableId || null,
      titleOf: (tab) => tab.title,
      resolve: async (item) => { const doc = await db.documents.where('stableId').equals(item).first(); return doc ? { id: doc.id, title: doc.title, category: doc.category } : null; },
      onClose: (tab) => { closed.push(tab.id); setTabs((prev) => { const next = prev.filter((t) => t.id !== tab.id); if (active === tab.id) setActive(next[next.length - 1]?.id ?? null); return next; }); },
    });
    return React.createElement('div', { 'data-tabs': tabs.map((t) => t.title).join(','), 'data-active': String(active) });
  }
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Page, { initial: [{ id: alphaId, title: 'Alpha', category: 'General' }] })); });
  await sleep(150);
  let rows = await readSyncedTabs('documents');
  check('   the page\'s open tab is mirrored into the table with its stableId, title and position', rows.length === 1 && rows[0].id === 'documents:sid-alpha' && rows[0].title === 'Alpha' && rows[0].position === 0, JSON.stringify(rows));

  // another device opened Beta: its row arrives (put untracked, as the engine does) and is announced
  await db.table('openTabs').put({ id: 'documents:sid-beta', page: 'documents', item: 'sid-beta', title: 'Beta', position: 1, openedAt: Date.now(), updatedAt: Date.now() });
  await act(async () => { window.dispatchEvent(new window.CustomEvent('syncApplied', { detail: { collections: ['openTabs'], changes: [] } })); });
  await sleep(150);
  check('   a row from another device opens the tab here, resolved to the local document, appended, the active tab untouched', api.tabs.map((t) => t.title).join() === 'Alpha,Beta' && api.tabs[1].id === betaId && api.active === alphaId, JSON.stringify({ tabs: api.tabs, active: api.active }));
  // a row for a document this device does not have is dropped quietly
  await db.table('openTabs').put({ id: 'documents:sid-elsewhere', page: 'documents', item: 'sid-elsewhere', title: 'Elsewhere', position: 2, openedAt: Date.now(), updatedAt: Date.now() });
  await act(async () => { window.dispatchEvent(new window.CustomEvent('syncApplied', { detail: { collections: ['openTabs'], changes: [] } })); });
  await sleep(150);
  check('   a row whose item is not on this device opens nothing', api.tabs.length === 2, api.tabs.map((t) => t.title).join());

  // the page opens Gamma: the table gets it
  await act(async () => { api.setTabs((prev) => [...prev, { id: gammaId, title: 'Gamma', category: 'Runbooks' }]); });
  await sleep(150);
  rows = await readSyncedTabs('documents');
  check('   a tab opened on the page is written (now three rows plus the foreign one)', rows.map((r) => r.item).join() === 'sid-alpha,sid-beta,sid-gamma,sid-elsewhere' || rows.some((r) => r.item === 'sid-gamma'), rows.map((r) => `${r.item}@${r.position}`).join());

  // the other device closed Alpha - the ACTIVE tab here: its row goes, the page's close handler runs, Beta becomes active
  await db.table('openTabs').delete('documents:sid-alpha');
  await act(async () => { window.dispatchEvent(new window.CustomEvent('syncApplied', { detail: { collections: ['openTabs'], changes: [] } })); });
  await sleep(150);
  check('   a row deleted elsewhere closes the tab here through the page\'s own close handler, and the active tab gives way to its neighbour', closed.includes(alphaId) && !api.tabs.some((t) => t.id === alphaId) && api.active !== alphaId && api.active != null, JSON.stringify({ closed, tabs: api.tabs.map((t) => t.title), active: api.active }));

  // the setting off: a new foreign row is not applied, a local open is not written
  setOpenTabsSyncEnabled(false);
  await sleep(50);
  await db.table('openTabs').put({ id: 'documents:sid-alpha', page: 'documents', item: 'sid-alpha', title: 'Alpha', position: 0, openedAt: Date.now(), updatedAt: Date.now() });
  await act(async () => { window.dispatchEvent(new window.CustomEvent('syncApplied', { detail: { collections: ['openTabs'], changes: [] } })); });
  await sleep(150);
  check('   with the setting off a row from elsewhere opens nothing', !api.tabs.some((t) => t.id === alphaId), api.tabs.map((t) => t.title).join());
  await db.table('openTabs').delete('documents:sid-alpha');
  await act(async () => { api.setTabs((prev) => [...prev, { id: alphaId, title: 'Alpha', category: 'General' }]); });
  await sleep(150);
  rows = await readSyncedTabs('documents');
  check('   ...and a tab opened here is not written', !rows.some((r) => r.item === 'sid-alpha'), rows.map((r) => r.item).join());
  setOpenTabsSyncEnabled(true);
  await sleep(150);
  rows = await readSyncedTabs('documents');
  check('   switched on again, the page\'s tabs are mirrored', rows.some((r) => r.item === 'sid-alpha'), rows.map((r) => r.item).join());
  await act(async () => { root.unmount(); });

  // ---- 3. writeSyncedTabs is a no-op for unchanged tabs (no spurious change announced) ----
  const before = await readSyncedTabs('documents');
  await writeSyncedTabs('documents', before.map((r) => ({ item: r.item, title: r.title })));   // (normalises the positions)
  const result = await writeSyncedTabs('documents', before.map((r) => ({ item: r.item, title: r.title })));
  check('3. writing the same tabs again touches no row', result.puts === 0 && result.deletes === 0, JSON.stringify(result));

  // ---- 4. the page away while rows arrive and leave; a restart; two fresh devices ----
  // the state so far: the page is unmounted; its mirrored set is what it last held
  const mirroredNow = loadMirrored('documents');
  check('4. the mirrored set survives the unmount (persisted per page)', mirroredNow.size > 0 && [...mirroredNow].every((i) => /^sid-/.test(i)), [...mirroredNow].join());
  // while the page is away: another device opens Gamma... (ensure a clean start: only Alpha mirrored and local)
  await db.table('openTabs').clear();
  await db.table('openTabs').put({ id: 'documents:sid-alpha', page: 'documents', item: 'sid-alpha', title: 'Alpha', position: 0, openedAt: 1, updatedAt: 1 });
  saveMirrored('documents', ['sid-alpha']);
  await db.table('openTabs').put({ id: 'documents:sid-gamma', page: 'documents', item: 'sid-gamma', title: 'Gamma', position: 1, openedAt: 2, updatedAt: 2 });
  const host4 = document.createElement('div'); document.body.appendChild(host4); const root4 = createRoot(host4);
  const closed4 = [];
  let api4 = null;
  function Page4({ initial }) {
    const [tabs, setTabs] = useState(initial);
    api4 = { tabs, setTabs };
    useSyncedOpenTabs({
      page: 'documents', tabs, setTabs,
      itemOf: async (tab) => (await db.documents.get(tab.id))?.stableId || null,
      titleOf: (tab) => tab.title,
      resolve: async (item) => { const doc = await db.documents.where('stableId').equals(item).first(); return doc ? { id: doc.id, title: doc.title, category: doc.category } : null; },
      onClose: (tab) => { closed4.push(tab.id); setTabs((prev) => prev.filter((t) => t.id !== tab.id)); },
    });
    return null;
  }
  // the page comes back with its own local tabs (Alpha only, as before it went away)
  await act(async () => { root4.render(React.createElement(Page4, { initial: [{ id: alphaId, title: 'Alpha', category: 'General' }] })); });
  await sleep(200);
  let rows4 = await readSyncedTabs('documents');
  check('   a tab opened elsewhere while the page was away opens at the next mount - and its row is NOT wiped by the page\'s own first write', api4.tabs.map((t) => t.title).join() === 'Alpha,Gamma' && rows4.map((r) => r.item).sort().join() === 'sid-alpha,sid-gamma', JSON.stringify({ tabs: api4.tabs.map((t) => t.title), rows: rows4.map((r) => r.item) }));
  await act(async () => { root4.unmount(); });
  // away again: the other device closes Alpha (its row goes) and opens Beta
  await db.table('openTabs').delete('documents:sid-alpha');
  await db.table('openTabs').put({ id: 'documents:sid-beta', page: 'documents', item: 'sid-beta', title: 'Beta', position: 2, openedAt: 3, updatedAt: 3 });
  const host5 = document.createElement('div'); document.body.appendChild(host5); const root5 = createRoot(host5);
  const stored = api4.tabs;   // what the page's localStorage would hold
  await act(async () => { root5.render(React.createElement(Page4, { initial: stored })); });
  await sleep(200);
  rows4 = await readSyncedTabs('documents');
  check('   at the next mount a tab closed elsewhere while away closes here (through the page\'s close handler), the one opened appears', closed4.includes(alphaId) && api4.tabs.map((t) => t.title).join() === 'Gamma,Beta' && rows4.map((r) => r.item).sort().join() === 'sid-beta,sid-gamma', JSON.stringify({ closed: closed4, tabs: api4.tabs.map((t) => t.title), rows: rows4.map((r) => r.item) }));
  await act(async () => { root5.unmount(); });
  // a restart: fresh hook state, the persisted tabs and mirrored set - the other device's tabs stay
  const host6 = document.createElement('div'); document.body.appendChild(host6); const root6 = createRoot(host6);
  await act(async () => { root6.render(React.createElement(Page4, { initial: api4.tabs })); });
  await sleep(200);
  rows4 = await readSyncedTabs('documents');
  check('   a restart (fresh hook state) keeps the other device\'s tabs: nothing wiped, nothing closed', api4.tabs.map((t) => t.title).join() === 'Gamma,Beta' && rows4.map((r) => r.item).sort().join() === 'sid-beta,sid-gamma' && closed4.length === 1, JSON.stringify({ tabs: api4.tabs.map((t) => t.title), rows: rows4.map((r) => r.item) }));
  await act(async () => { root6.unmount(); });
  // two devices freshly enabling with different tabs: this device (nothing mirrored, Alpha open) meets rows from the other (Beta, Gamma)
  saveMirrored('documents', []);
  const host7 = document.createElement('div'); document.body.appendChild(host7); const root7 = createRoot(host7);
  await act(async () => { root7.render(React.createElement(Page4, { initial: [{ id: alphaId, title: 'Alpha', category: 'General' }] })); });
  await sleep(200);
  rows4 = await readSyncedTabs('documents');
  check('   two devices freshly enabling the mirroring with different tabs end with the union, nobody wiped', api4.tabs.map((t) => t.title).sort().join() === 'Alpha,Beta,Gamma' && rows4.map((r) => r.item).sort().join() === 'sid-alpha,sid-beta,sid-gamma', JSON.stringify({ tabs: api4.tabs.map((t) => t.title), rows: rows4.map((r) => r.item) }));
  await act(async () => { root7.unmount(); });

  // ---- a synced-in tab is shown through the page's open path (3.2.2: it arrived empty) ----
  // Page8 shows nothing: the first tab that arrives is opened (onOpen), the next is only appended;
  // a row whose document has not arrived yet is applied when the document's table syncs
  let api8; const opened8 = [];
  function Page8({ initial }) {
    const [tabs, setTabs] = useState(initial);
    const [active, setActive] = useState(null);
    api8 = { tabs, setTabs, active, setActive };
    useSyncedOpenTabs({
      page: 'documents', tabs, setTabs,
      itemOf: async (tab) => (await db.documents.get(tab.id))?.stableId || null,
      titleOf: (tab) => tab.title,
      resolve: async (item) => { const doc = await db.documents.where('stableId').equals(item).first(); return doc ? { id: doc.id, title: doc.title, category: doc.category } : null; },
      onClose: (tab) => setTabs((prev) => prev.filter((t) => t.id !== tab.id)),
      onOpen: (tab) => { opened8.push(tab.title); if (!tabs.includes(tab)) opened8.push('NOT-IN-TABS'); setActive(tab.id); },
      active,
      itemCollection: 'documents',
    });
    return React.createElement('div');
  }
  await db.table('openTabs').clear(); saveMirrored('documents', []);
  const host8 = document.createElement('div'); document.body.appendChild(host8); const root8 = createRoot(host8);
  await act(async () => { root8.render(React.createElement(Page8, { initial: [] })); });
  await sleep(150);
  // the row of a document this device does not have yet
  await db.table('openTabs').put({ id: 'documents:sid-late', page: 'documents', item: 'sid-late', title: 'Late', position: 0, openedAt: 1, updatedAt: 1 });
  await act(async () => { window.dispatchEvent(new window.CustomEvent('syncApplied', { detail: { collections: ['openTabs'], changes: [] } })); });
  await sleep(150);
  check('8. a row whose document has not arrived opens nothing (no empty tab)', api8.tabs.length === 0 && opened8.length === 0, JSON.stringify({ tabs: api8.tabs, opened8 }));
  const lateId = await db.documents.add({ stableId: 'sid-late', title: 'Late', category: 'General', content: 'late body', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await act(async () => { window.dispatchEvent(new window.CustomEvent('syncApplied', { detail: { collections: ['documents'], changes: [] } })); });
  await sleep(150);
  check('   the document arriving (its table synced, no openTabs change) applies the waiting row: the tab opens through onOpen, after it rendered, and is shown', api8.tabs.length === 1 && api8.tabs[0].id === lateId && opened8.join() === 'Late' && api8.active === lateId, JSON.stringify({ tabs: api8.tabs, opened8, active: api8.active }));
  await db.table('openTabs').put({ id: 'documents:sid-beta', page: 'documents', item: 'sid-beta', title: 'Beta', position: 1, openedAt: 2, updatedAt: 2 });
  await act(async () => { window.dispatchEvent(new window.CustomEvent('syncApplied', { detail: { collections: ['openTabs'], changes: [] } })); });
  await sleep(150);
  check('   a tab arriving while one is shown is appended only (onOpen not called, the shown one stays)', api8.tabs.map((t) => t.title).join() === 'Late,Beta' && opened8.join() === 'Late' && api8.active === lateId, JSON.stringify({ tabs: api8.tabs.map((t) => t.title), opened8, active: api8.active }));
  await act(async () => { root8.unmount(); });

  // ---- 9. never two tabs for one document (3.2.4: the same document twice, side by side, both active) ----
  // The page opens a document itself (its own open path, e.g. restoring the last document at start)
  // while apply is resolving the same document from a row: the hook must not add a second tab.
  let api9; let resolveGate = null;
  function Page9({ initial }) {
    const [tabs, setTabs] = useState(initial);
    api9 = { tabs, setTabs };
    useSyncedOpenTabs({
      page: 'documents', tabs, setTabs,
      itemOf: async (tab) => (await db.documents.get(tab.id))?.stableId || null,
      titleOf: (tab) => tab.title,
      resolve: async (item) => { if (resolveGate) await resolveGate; const doc = await db.documents.where('stableId').equals(item).first(); return doc ? { id: doc.id, title: doc.title, category: doc.category } : null; },
      onClose: (tab) => setTabs((prev) => prev.filter((t) => t.id !== tab.id)),
      onOpen: () => {},
      active: null,
    });
    return React.createElement('div');
  }
  await db.table('openTabs').clear(); saveMirrored('documents', []);
  const host9 = document.createElement('div'); document.body.appendChild(host9); const root9 = createRoot(host9);
  await act(async () => { root9.render(React.createElement(Page9, { initial: [] })); });
  await sleep(150);
  await db.table('openTabs').put({ id: 'documents:sid-beta', page: 'documents', item: 'sid-beta', title: 'Beta', position: 0, openedAt: 1, updatedAt: 1 });
  let openGate; resolveGate = new Promise((r) => { openGate = r; });
  await act(async () => { window.dispatchEvent(new window.CustomEvent('syncApplied', { detail: { collections: ['openTabs'], changes: [] } })); });
  await sleep(50);
  // meanwhile the page opens Beta itself (a new tab object of its own, as handleSelectDocument makes)
  await act(async () => { api9.setTabs((prev) => [...prev, { id: betaId, title: 'Beta', category: 'General' }]); });
  openGate(); await sleep(200);
  check('9. a document the page opened itself while a row for it was being applied is open ONCE (was: twice, the same id side by side)', api9.tabs.length === 1 && api9.tabs[0].id === betaId, JSON.stringify(api9.tabs));
  // the page replaces its tab objects (a title refresh from a sync) while a row for an OPEN document is re-applied
  resolveGate = null;
  await act(async () => { api9.setTabs((prev) => prev.map((t) => ({ ...t }))); });
  await act(async () => { window.dispatchEvent(new window.CustomEvent('syncApplied', { detail: { collections: ['openTabs'], changes: [] } })); });
  await sleep(200);
  check('   re-applying the rows after the page replaced its tab objects adds nothing', api9.tabs.length === 1, JSON.stringify(api9.tabs));
  await act(async () => { root9.unmount(); });

  // ---- 10. a stored tab list that already holds duplicates is collapsed on load ----
  let api10;
  function Page10({ initial }) {
    const [tabs, setTabs] = useState(initial);
    api10 = { tabs, setTabs };
    useSyncedOpenTabs({
      page: 'documents', tabs, setTabs,
      itemOf: async (tab) => (await db.documents.get(tab.id))?.stableId || null,
      titleOf: (tab) => tab.title,
      resolve: async (item) => { const doc = await db.documents.where('stableId').equals(item).first(); return doc ? { id: doc.id, title: doc.title, category: doc.category } : null; },
      onClose: (tab) => setTabs((prev) => prev.filter((t) => t.id !== tab.id)),
    });
    return React.createElement('div');
  }
  await db.table('openTabs').clear(); saveMirrored('documents', []);
  const host10 = document.createElement('div'); document.body.appendChild(host10); const root10 = createRoot(host10);
  await act(async () => { root10.render(React.createElement(Page10, { initial: [{ id: alphaId, title: 'Alpha', category: 'General' }, { id: betaId, title: 'Beta', category: 'General' }, { id: alphaId, title: 'Alpha', category: 'General' }] })); });
  await sleep(200);
  check('10. a stored list with the same document twice is collapsed on load (first occurrence kept, order kept)', api10.tabs.map((t) => t.id).join() === `${alphaId},${betaId}`, JSON.stringify(api10.tabs));
  await act(async () => { api10.setTabs((prev) => [...prev, { id: betaId, title: 'Beta', category: 'General' }]); });
  await sleep(100);
  check('   ...and a duplicate added later is collapsed too', api10.tabs.map((t) => t.id).join() === `${alphaId},${betaId}`, JSON.stringify(api10.tabs));
  const rows10 = await readSyncedTabs('documents');
  check('   the mirrored rows hold each document once', rows10.map((r) => r.item).sort().join() === 'sid-alpha,sid-beta', rows10.map((r) => r.item).join());
  await act(async () => { root10.unmount(); });
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
}
fs.rmSync(entry, { force: true });
process.exit(summary());
