/**
 * The sync engine's safety snapshots (src/sync/syncEngine.js, _syncSnapshots):
 * a copy of the local data in the Export Database format taken ONCE per
 * replica before its first reconciliation with the server, and before the
 * device empties itself after a server-side deletion (a real generation
 * bump). Nothing else creates one, at most three are kept, and Settings
 * lists them with a date, a time and the reason.
 *
 * THE BUG: a linked desktop showed six "Download snapshot" buttons. The
 * "before the first synchronisation" snapshot was taken whenever the first
 * pull had not COMPLETED yet: the marker was written at the end of pull(),
 * so a first cycle that failed after the snapshot (server unreachable,
 * session expired, a bad page) took a new snapshot on the next start /
 * relink / cycle. Now the marker is written when the snapshot is taken.
 *
 * Real engine over fake-indexeddb with a transport the test controls:
 *   1. local data + a first cycle whose pull fails: one snapshot, and the
 *      marker is set right away;
 *   2. relaunch (module state reset, same database), another failing
 *      cycle, then a successful one: still one;
 *   3. relink (stop + start with the same account) and an upgrade
 *      simulation (reset + start again): still one, and no snapshot at all
 *      when there is nothing local;
 *   4. a server-side deletion (generation bump): exactly one more, the
 *      tables empty; the same generation again: none;
 *   5. keep-3: further bumps prune the oldest, newest first in the list;
 *   6. labels: "Before first sync - <date>, <time>" / "Before server
 *      deletion - ..." in the locale's format, also for rows written by the
 *      previous versions (reason text only);
 *   7. Settings renders them as a compact list (static).
 *
 * Run: node tests/sync-snapshots.test.mjs
 * Needs jsdom + fake-indexeddb (npm install --no-save jsdom fake-indexeddb).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
for (const dep of ['jsdom', 'fake-indexeddb', 'esbuild', 'dexie']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} missing (npm install --no-save jsdom fake-indexeddb)`); process.exit(0); } }
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { JSDOM } = req('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://console.example.test/' });
for (const key of ['window', 'document', 'navigator', 'Event', 'CustomEvent', 'FileReader', 'Blob']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
for (const k of ['db_migration_complete', 'workflows_migration_complete', 'env_vars_migration_complete']) localStorage.setItem(k, 'true');
await import(req.resolve('fake-indexeddb/auto'));
for (const k of ['indexedDB', 'IDBKeyRange']) { const v = globalThis[k] || dom.window[k]; globalThis[k] = v; dom.window[k] = v; }

const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-snapshots-'));
const ENTRY = path.join(WORK, 'entry.mjs');
const BUNDLE = path.join(WORK, 'bundle.cjs');
fs.writeFileSync(ENTRY, `
  export * as engine from '@worktree/src/sync/syncEngine.js';
  export * as labels from '@worktree/src/sync/snapshotLabel.js';
  export { db } from '@worktree/src/db/database.js';
`);
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty' }, jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }],
  logLevel: 'error',
});
const realLog = console.log; const realWarn = console.warn; const realError = console.error;
const quiet = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };
const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realError; };
quiet();
const { engine, labels, db } = req(BUNDLE);
loud();

// a home server the test controls
let mode = 'ok';
let generation = 1;
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const transport = {
  fetch: async (p, init = {}) => {
    if (mode === 'reject') throw new TypeError('Failed to fetch');
    if (/^\/api\/sync\/pull/.test(p)) return answer(200, { changes: [], seq: 0, more: false, now: Date.now(), generation });
    if (/^\/api\/sync\/push/.test(p)) {
      const body = JSON.parse(init.body || '{}');
      return answer(200, { results: (body.changes || []).map((c, i) => ({ status: 'ok', rev: i + 1, seq: i + 1 })), seq: (body.changes || []).length, now: Date.now() });
    }
    return answer(404, { error: 'not found' });
  },
};
const snapshots = async () => (await db._syncSnapshots.orderBy('createdAt').toArray()).map((s) => ({ id: s.id, kind: s.kind, reason: s.reason }));
const meta = async (key) => (await db._syncMeta.get(key))?.value;
const start = async () => { quiet(); try { await engine.startSync({ transport, accountId: 'account-1', listen: false }); } finally { loud(); } };
const relaunch = () => { engine.__resetSyncForTests(); };
const sync = async () => { quiet(); try { await engine.syncNow(); } finally { loud(); } };

try {
  // ---- 1. local data, the first cycle's pull fails ----
  await db.documents.add({ title: 'Kept locally', content: 'written before the first sync', category: 'General', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  mode = 'reject';
  await start();
  let snaps = await snapshots();
  check('1. a failing first cycle still took the "before first sync" snapshot (once)', snaps.length === 1 && snaps[0].kind === 'first-sync', JSON.stringify(snaps));
  check('1. ...and the marker is persisted at snapshot time (not only after a completed pull)', !!(await meta('firstSyncSnapshotAt')) && !(await meta('firstSyncAt')), JSON.stringify({ snap: await meta('firstSyncSnapshotAt'), first: await meta('firstSyncAt') }));

  // ---- 2. relaunch, another failure, then success ----
  relaunch();
  await start();
  await sync();
  check('2. a relaunch with the first pull still failing takes no second snapshot', (await snapshots()).length === 1, JSON.stringify(await snapshots()));
  mode = 'ok';
  await sync();
  check('2. the first successful pull completes the first sync (marker) without another snapshot', !!(await meta('firstSyncAt')) && (await snapshots()).length === 1);

  // ---- 3. relink and an upgrade simulation ----
  engine.stopSync();
  await start();
  await sync();
  check('3. relink (stop + start, same account): no new snapshot', (await snapshots()).length === 1);
  relaunch();
  await start();
  await sync(); await sync();
  check('3. an upgrade simulation (module reloaded over the same database) and later cycles: no new snapshot', (await snapshots()).length === 1);

  // ---- 4. a server-side deletion: one snapshot, then quiet ----
  generation = 2;
  await sync();
  snaps = await snapshots();
  check('4. a generation bump takes exactly one "before server deletion" snapshot and empties the tables', snaps.length === 2 && snaps[1].kind === 'server-deletion' && (await db.documents.count()) === 0, JSON.stringify(snaps));
  await sync(); await sync();
  check('4. the same generation again: nothing', (await snapshots()).length === 2);
  relaunch(); await start(); await sync();
  check('4. ...nor after a relaunch (generation remembered)', (await snapshots()).length === 2 && (await meta('generation')) === 2);

  // ---- 5. keep-3 ----
  const firstId = snaps[0].id;
  for (const g of [3, 4]) {
    await db.documents.add({ title: `Local before ${g}`, content: 'x', category: 'General', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await sleep(5);
    generation = g;
    await sync();
  }
  snaps = await snapshots();
  check('5. at most three snapshots are kept: the oldest (the first-sync one) was pruned, the three newest remain', snaps.length === 3 && !snaps.some((s) => s.id === firstId) && snaps.every((s) => s.kind === 'server-deletion'), JSON.stringify(snaps));
  const listed = await engine.listSnapshots();
  check('5. listSnapshots: newest first, with kind, reason and size', listed.length === 3 && listed[0].createdAt >= listed[1].createdAt && listed.every((s) => s.kind && s.reason && s.bytes > 0 && s.label), JSON.stringify(listed.map((s) => s.label)));
  check('5. an empty device: a bump without local data takes no snapshot', await (async () => { generation = 5; await sync(); return (await snapshots()).length === 3; })());

  // ---- 6. labels ----
  const when = new Date(2026, 9, 13, 14, 2).getTime();
  const expectedWhen = new Date(when).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  check('6. "Before first sync - <date>, <time>" (locale format, date and time)', labels.snapshotLabel({ kind: 'first-sync', createdAt: when }) === `Before first sync - ${expectedWhen}` && /2026/.test(expectedWhen) && /\d:\d\d/.test(expectedWhen), labels.snapshotLabel({ kind: 'first-sync', createdAt: when }));
  check('6. "Before server deletion - ..."', labels.snapshotLabel({ kind: 'server-deletion', createdAt: when }) === `Before server deletion - ${expectedWhen}`);
  check('6. rows from earlier versions (reason text only) are labelled by their reason', labels.snapshotLabel({ reason: 'before the first synchronisation with the server', createdAt: when }).startsWith('Before first sync - ') && labels.snapshotLabel({ reason: "before this device emptied itself after the account's data was deleted on the server", createdAt: when }).startsWith('Before server deletion - '));

  // ---- 7. Settings renders a compact list ----
  const settings = fs.readFileSync(path.join(REPO, 'src/components/common/modals/settings/GeneralSettings.jsx'), 'utf8');
  check('7. Settings lists the snapshots one row each with a Download link (no wall of buttons)', /data-testid="sync-snapshot-row"/.test(settings) && /snapshotLabel|snap\.label/.test(settings) && !/Download snapshot \(/.test(settings) && /variant="link"/.test(settings.slice(settings.indexOf('sync-snapshot-row') - 400, settings.indexOf('sync-snapshot-row') + 600)));
  const engineSrc = fs.readFileSync(path.join(REPO, 'src/sync/syncEngine.js'), 'utf8');
  check('7. the engine keeps at most 3 (MAX_SNAPSHOTS) and only two places create one', /MAX_SNAPSHOTS = 3/.test(engineSrc) && (engineSrc.match(/addSnapshot\(/g) || []).length === 3);
} catch (error) {
  check('the scenario ran to the end', false, error.stack || error.message);
} finally {
  try { engine.stopSync(); } catch { /* ignore */ }
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
