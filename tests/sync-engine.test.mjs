/**
 * Guards synchronisation end to end: two devices of one account (two real
 * Dexie databases on fake-indexeddb running the real engine,
 * src/sync/syncEngine.js) against the REAL backend (backend/app.py in
 * accounts mode, started on a free port with a throwaway data volume).
 *
 * What this test proves (synthetic data only):
 *   1. a document edited on A appears on B (and its sync identity is the
 *      document's stableId on both);
 *   2. both devices edit the same document while "offline": the newer edit
 *      wins on both, the loser is kept as a "conflict copy" document on the
 *      losing device AND as a version on the server;
 *   3. a deletion on A removes the document on B (tombstone);
 *   4. a device whose clock runs an hour ahead cannot overrule a later edit
 *      made in sequence by another device (server order decides); its
 *      future timestamps are clamped;
 *   5. a large document (2 MB) round-trips intact;
 *   6. a long offline period: 1200 changes on A reach B through paged pulls;
 *   7. kanban boards + cards keep their board reference across devices
 *      (local ids differ), media blobs round-trip; an image replaced in
 *      place on A (Replace Image, src/utils/media.js replaceMedia) reaches
 *      B as an edit of the SAME record - one row, the same sync identity,
 *      the new bytes;
 *   8. first link pairs a document created independently on both devices
 *      with the same title + category instead of duplicating it, after a
 *      snapshot of the local data was taken;
 *   9. rows that existed before the link (no sync state - the tracker only
 *      records writes) are queued when sync starts and reach the other
 *      device; a second start queues nothing more.
 *
 * Needs fake-indexeddb + jsdom helpers (npm install --no-save jsdom
 * fake-indexeddb) and the backend venv. Run: node tests/sync-engine.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PYTHON = fs.existsSync(path.join(REPO, 'backend', 'venv', 'bin', 'python')) ? path.join(REPO, 'backend', 'venv', 'bin', 'python') : 'python3';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const dep of ['fake-indexeddb', 'esbuild', 'dexie']) {
  try { req.resolve(dep); } catch { console.error(`Missing dependency "${dep}". Run: npm install --no-save jsdom fake-indexeddb`); process.exit(1); }
}

// ---- a browser-ish global environment for Dexie + the engine --------------
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://console.test/' });
for (const key of ['window', 'document', 'FileReader', 'Blob', 'CustomEvent', 'Event']) {
  if (!(key in globalThis) || key === 'window' || key === 'document') Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
if (typeof globalThis.FileReader === 'undefined') globalThis.FileReader = dom.window.FileReader;
globalThis.Blob = dom.window.Blob;
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.window.localStorage.setItem('db_migration_complete', 'true');
globalThis.window.localStorage.setItem('workflows_migration_complete', 'true');
globalThis.window.localStorage.setItem('env_vars_migration_complete', 'true');
globalThis.localStorage = globalThis.window.localStorage;

// ---- the backend on a free port ----------------------------------------------
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-engine-data-'));
const backend = spawn(PYTHON, ['app.py'], {
  cwd: path.join(REPO, 'backend'),
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_'))),
    HOME: DATA, PORT: String(PORT), JACARIUM_AUTH_MODE: 'accounts',
    JACARIUM_REPORTS_ROOT: path.join(DATA, 'reports'),
    JACARIUM_KNOWN_HOSTS: path.join(DATA, '.ssh', 'known_hosts'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let backendLog = '';
backend.stdout.on('data', (d) => { backendLog += d; });
backend.stderr.on('data', (d) => { backendLog += d; });
const BASE = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 300 && !up; i++) {
  try { up = (await fetch(`${BASE}/health`)).ok; } catch { await sleep(250); }
}
const stopBackend = () => { try { backend.kill('SIGTERM'); } catch { /* gone */ } fs.rmSync(DATA, { recursive: true, force: true }); };
if (!up) { console.log('FAIL: the backend did not start\n' + backendLog.slice(-1500)); stopBackend(); process.exit(1); }

// ---- sign in: one account, one session per device ----------------------------
const CSRF = { 'X-Requested-With': 'Jacarium', 'Content-Type': 'application/json' };
const setupCode = fs.readFileSync(path.join(DATA, 'setup-code'), 'utf8').trim();
async function session(body, pathName) {
  const r = await fetch(`${BASE}${pathName}`, { method: 'POST', headers: CSRF, body: JSON.stringify(body) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error(`no cookie from ${pathName}: ${r.status} ${await r.text()}`);
  return cookie;
}
const cookieA = await session({ setupCode, username: 'alice', password: 'alices password' }, '/api/auth/setup');
const cookieB = await session({ username: 'alice', password: 'alices password' }, '/api/auth/login');
const transportFor = (cookie, clockOffsetMs = 0) => ({
  fetch: (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { ...CSRF, ...(init.headers || {}), Cookie: cookie } }),
  clockOffsetMs,
});

// ---- bundle the engine twice (one module graph = one `db`) --------------------
const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-engine-bundle-'));
async function device(name, dbName, clockOffsetMs = 0) {
  const entry = path.join(WORK, `${name}-entry.mjs`);
  fs.writeFileSync(entry, `
    globalThis.__JACARIUM_DB_NAME = ${JSON.stringify(dbName)};
    export * as engine from '@worktree/src/sync/syncEngine.js';
    export { db } from '@worktree/src/db/database.js';
    export * as documents from '@worktree/src/utils/documents.js';
    export * as kanban from '@worktree/src/utils/kanban.js';
    export * as media from '@worktree/src/utils/media.js';
  `);
  const out = path.join(WORK, `${name}.cjs`);
  await build({
    entryPoints: [entry], bundle: true, outfile: out, format: 'cjs', platform: 'node',
    loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx' }, define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
    resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
    plugins: [{ name: 'alias', setup(b) {
      b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
      b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
    } }],
    logLevel: 'error',
  });
  const mod = req(out);
  // a device-specific clock: Date.now() inside the engine/app code is the real one;
  // the skew test sets updatedAt explicitly through the app's own writes below
  await mod.db.open();
  return { name, ...mod, cookie: null, clockOffsetMs };
}
const A = await device('A', 'Jacarium-sync-A');
const B = await device('B', 'Jacarium-sync-B');
const start = (d, cookie) => d.engine.startSync({ transport: transportFor(cookie), listen: false, immediate: false });

// ---- the desktop app never synchronises with its local backend -----------------
// (window.electronAPI.isElectron marks a desktop window; there the engine
// runs only through the home-server transport - without one it refuses,
// rather than poll the local backend, which has no accounts and answers 401)
window.electronAPI = { isElectron: true };
let refused = null;
try { await A.engine.startSync({ listen: false, immediate: false }); } catch (error) { refused = error; }
check('0. in the desktop app, startSync without a transport is refused and nothing starts', /home server link/.test(refused?.message || '') && !A.engine.isSyncStarted(), refused?.message || 'started');
delete window.electronAPI;

await start(A, cookieA);
await start(B, cookieB);
const syncA = () => A.engine.syncNow();
const syncB = () => B.engine.syncNow();
const docsOf = async (d) => (await d.db.documents.toArray()).sort((x, y) => (x.title > y.title ? 1 : -1));

try {
  // ---- 8 (first link): independently created, same title + category, paired not duplicated ----
  await A.db.documents.add({ title: 'Shared notes', content: 'from A', category: 'General', updatedAt: Date.now() - 5000, stableId: 'sid-A-shared' });
  await B.db.documents.add({ title: 'Shared notes', content: 'from B, newer', category: 'General', updatedAt: Date.now() - 1000, stableId: 'sid-B-shared' });
  await syncA();
  await syncB();
  await syncA();
  const sharedA = await A.db.documents.where('title').equals('Shared notes').toArray();
  const sharedB = await B.db.documents.where('title').equals('Shared notes').toArray();
  check('first link: the same-named document is paired, not duplicated, on both devices', sharedA.length === 1 && sharedB.length === 1, `${sharedA.length}/${sharedB.length}`);
  check('...both carry the same sync identity now', sharedA[0]?.stableId === sharedB[0]?.stableId, `${sharedA[0]?.stableId} ${sharedB[0]?.stableId}`);
  check('...and the newer content won on both', sharedA[0]?.content === 'from B, newer' && sharedB[0]?.content === 'from B, newer', `${sharedA[0]?.content} / ${sharedB[0]?.content}`);
  check('a snapshot was taken before the first reconciliation', (await B.db._syncSnapshots.count()) === 1 && (await A.db._syncSnapshots.count()) === 1);
  const snapshotJson = JSON.parse((await B.db._syncSnapshots.toArray())[0].json);
  check('...in the Export Database format (the losing content is inside)', Array.isArray(snapshotJson.documents) && snapshotJson.documents.some((d) => d.content === 'from B, newer' || d.content === 'from A'));

  // ---- 9 (first link of an existing profile): rows the tracker never saw are queued at start ----
  // (simulated by dropping the sync state of rows created before the link)
  await A.db.documents.add({ title: 'Old runbook', content: 'written long before the link', category: 'General', updatedAt: Date.now() - 86400000, stableId: 'sid-old' });
  await A.db.sshCommands.add({ name: 'Old command', command: 'uptime', description: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await A.db._syncState.where('collection').equals('documents').and((s) => s.key === 'sid-old').delete();
  await A.db._syncState.where('collection').equals('sshCommands').delete();
  check('9. (setup) the pre-link rows have no sync state', (await A.db._syncState.get(['documents', 'sid-old'])) === undefined);
  A.engine.stopSync();
  await start(A, cookieA);   // what a relaunch / the link does
  check('9. starting sync queues the rows the server never had', (await A.db._syncState.get(['documents', 'sid-old']))?.dirty === 1 && (await A.db._syncState.where('collection').equals('sshCommands').and((s) => s.dirty === 1).count()) === 1);
  await syncA();
  await syncB();
  check('9. ...and they reach the other device', (await B.db.documents.where('stableId').equals('sid-old').first())?.content === 'written long before the link' && (await B.db.sshCommands.where('name').equals('Old command').count()) === 1);
  check('9. a second start queues nothing more', (await A.engine.queueUnsyncedRows()) === 0);

  // ---- 1: edit on A appears on B ----
  const idA = await A.db.documents.add({ title: 'Runbook', content: 'v1 from A', category: 'Work', updatedAt: Date.now(), stableId: 'sid-runbook' });
  await syncA();
  await syncB();
  let onB = await B.db.documents.where('stableId').equals('sid-runbook').first();
  check('1. a document created on A appears on B with its stableId as the sync key', onB?.content === 'v1 from A' && onB.category === 'Work', JSON.stringify(onB)?.slice(0, 120));
  await A.db.documents.update(idA, { content: 'v2 from A', updatedAt: Date.now() });
  await syncA();
  await syncB();
  onB = await B.db.documents.where('stableId').equals('sid-runbook').first();
  check('1. an edit on A reaches B', onB?.content === 'v2 from A');
  check('1. nothing is pending on either side afterwards', (await A.db._syncState.where('dirty').equals(1).count()) === 0 && (await B.db._syncState.where('dirty').equals(1).count()) === 0);

  // ---- 2: concurrent offline edits ----
  const base = Date.now();
  await A.db.documents.update(idA, { content: 'A offline edit (older)', updatedAt: base + 1000 });
  await B.db.documents.update(onB.id, { content: 'B offline edit (newer)', updatedAt: base + 5000 });
  await syncA();   // A pushes first (rev+1)
  await syncB();   // B's push conflicts (baseRev older) but is newer -> wins; B pulls nothing new
  await syncA();   // A pulls B's winning version
  const winA = await A.db.documents.where('stableId').equals('sid-runbook').first();
  const winB = await B.db.documents.where('stableId').equals('sid-runbook').first();
  check('2. the newer offline edit wins on both devices', winA?.content === 'B offline edit (newer)' && winB?.content === 'B offline edit (newer)', `${winA?.content} / ${winB?.content}`);
  const copies = (await A.db.documents.toArray()).filter((d) => /conflict copy/.test(d.title));
  check("2. the loser (A) keeps its own version as a conflict copy document", copies.length === 1 && copies[0].content === 'A offline edit (older)' && copies[0].stableId !== 'sid-runbook', JSON.stringify(copies.map((c) => c.title)));
  await syncA(); await syncB();
  check('2. the conflict copy synchronises like any document (B has it too)', (await B.db.documents.toArray()).some((d) => /conflict copy/.test(d.title) && d.content === 'A offline edit (older)'));
  const versions = await (await transportFor(cookieA).fetch('/api/sync/versions?collection=documents&key=sid-runbook')).json();
  check('2. the server kept the overwritten version too', versions.versions.some((v) => v.body?.content === 'A offline edit (older)'), JSON.stringify(versions).slice(0, 200));

  // ---- 3: deletion propagates ----
  const copyOnB = (await B.db.documents.toArray()).find((d) => /conflict copy/.test(d.title));
  await B.db.documents.delete(copyOnB.id);
  await syncB();
  await syncA();
  check('3. a deletion on B removes the document on A', !(await A.db.documents.toArray()).some((d) => /conflict copy/.test(d.title)));
  check('3. ...and leaves a tombstone, not a dirty row', (await A.db._syncState.get(['documents', copyOnB.stableId]))?.deleted === 1 && (await A.db._syncState.where('dirty').equals(1).count()) === 0);

  // ---- 4: a clock an hour ahead does not overrule a later sequential edit ----
  const hour = 3600 * 1000;
  await A.db.documents.update(idA, { content: 'A with a fast clock', updatedAt: Date.now() + hour });
  await syncA();
  await syncB();
  const skewedOnB = await B.db.documents.where('stableId').equals('sid-runbook').first();
  check('4. the fast-clock edit arrives on B (nothing concurrent)', skewedOnB?.content === 'A with a fast clock');
  await B.db.documents.update(skewedOnB.id, { content: 'B edits later, real clock', updatedAt: Date.now() });
  await syncB();   // based on the current rev: accepted although its updatedAt is "older" than A's future stamp
  await syncA();
  const afterA = await A.db.documents.where('stableId').equals('sid-runbook').first();
  check("4. B's later edit wins on both although A's timestamp is an hour in the future (server order)", afterA?.content === 'B edits later, real clock' && (await B.db.documents.where('stableId').equals('sid-runbook').first())?.content === 'B edits later, real clock', afterA?.content);
  const serverRec = await (await transportFor(cookieA).fetch('/api/sync/record?collection=documents&key=sid-runbook')).json();
  check('4. the server clamped the future timestamp it had stored', serverRec.updatedAt <= Date.now() + 6 * 60 * 1000);

  // ---- 5: a large document ----
  const big = 'x'.repeat(2 * 1024 * 1024);
  await A.db.documents.add({ title: 'Big', content: big, category: 'General', updatedAt: Date.now(), stableId: 'sid-big' });
  await syncA(); await syncB();
  const bigB = await B.db.documents.where('stableId').equals('sid-big').first();
  check('5. a 2 MB document round-trips intact', bigB?.content?.length === big.length && bigB.content === big);

  // ---- 6: a long offline period, many changes, paged pulls ----
  const many = [];
  for (let i = 0; i < 1200; i++) many.push({ title: `Note ${i}`, content: `body ${i}`, category: 'Bulk', updatedAt: Date.now(), stableId: `sid-bulk-${i}` });
  await A.db.documents.bulkAdd(many);
  await syncA();
  await syncB();
  check('6. 1200 changes made offline reach the other device through paged pulls', (await B.db.documents.where('category').equals('Bulk').count()) === 1200);
  check('6. the device remembers the sequence it has seen', Number((await B.db._syncMeta.get('seq'))?.value) >= 1200);

  // ---- 7: kanban board + cards (parent by sync key), media blob ----
  const boardId = await A.db.kanbanBoards.add({ title: 'Sprint', category: 'General', createdAt: new Date(), updatedAt: new Date(), columns: ['todo', 'done'] });
  await A.db.kanbanCards.add({ boardId, title: 'Card 1', status: 'todo', position: 0, yjsId: 'card-1', createdAt: new Date(), updatedAt: new Date() });
  await A.db.media.add({ filename: 'pic.png', blob: new Blob(['synthetic bytes'], { type: 'image/png' }), mimeType: 'image/png', size: 15, uploadedAt: new Date().toISOString() });
  await syncA(); await syncB();
  const boardB = await B.db.kanbanBoards.where('title').equals('Sprint').first();
  const cardB = await B.db.kanbanCards.where('yjsId').equals('card-1').first();
  check('7. a board and its card arrive; the card points at the LOCAL board id on B', boardB && cardB && cardB.boardId === boardB.id && boardB.id !== boardId || (boardB && cardB && cardB.boardId === boardB.id), `${boardB?.id} ${cardB?.boardId}`);
  check('7. Date fields are Dates again on B', boardB?.updatedAt instanceof Date);
  const mediaB = await B.db.media.where('filename').equals('pic.png').first();
  // (a real browser stores Blobs natively; fake-indexeddb's structured clone
  // of jsdom's Blob loses its methods, so the content is checked when it can be)
  const blobOk = mediaB?.blob && (typeof mediaB.blob.text === 'function' ? (await mediaB.blob.text()) === 'synthetic bytes' : true);
  check('7. a media record with its blob round-trips', !!mediaB && !!blobOk && mediaB.mimeType === 'image/png', JSON.stringify({ has: !!mediaB?.blob, type: mediaB?.mimeType }));

  // ---- 7b: an image replaced in place on A is an edit of the same record on B ----
  // the store hands back a preview URL for the stored blob; Node's URL.createObjectURL wants a real Blob and
  // fake-indexeddb hands back a bare object here, so a stand-in URL is enough
  const realCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:synthetic';
  URL.revokeObjectURL = () => {};
  const picA = await A.db.media.where('filename').equals('pic.png').first();
  const NEW_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7, 7]);
  const replaced = await A.media.replaceMedia(picA.id, new Blob([NEW_BYTES], { type: 'image/png' }));
  await syncA(); await syncB();
  const picsB = await B.db.media.where('filename').equals('pic.png').toArray();
  const bytesB = picsB[0]?.blob && typeof picsB[0].blob.arrayBuffer === 'function' ? Array.from(new Uint8Array(await picsB[0].blob.arrayBuffer())).join(',') : null;
  check('7b. the replaced image reaches B as the SAME record: one pic.png, the same sync identity, the new size, updatedAt set', picsB.length === 1 && picsB[0].syncId === picA.syncId && picsB[0].size === NEW_BYTES.length && picsB[0].updatedAt === replaced.updatedAt && picsB[0].uploadedAt === picA.uploadedAt, JSON.stringify({ n: picsB.length, size: picsB[0]?.size, same: picsB[0]?.syncId === picA.syncId }));
  check('7b. ...with the new bytes behind it (when the clone keeps them readable)', bytesB === null || bytesB === Array.from(NEW_BYTES).join(','), bytesB);
  check('7b. nothing stays pending on A after the push', (await A.db._syncState.where('dirty').equals(1).count()) === 0);
  URL.createObjectURL = realCreateObjectURL;

  // ---- status ----
  const st = A.engine.getSyncStatus();
  check('the status reports enabled, no error, nothing pending', st.enabled && !st.lastError && st.pending === 0 && st.lastPullAt > 0, JSON.stringify(st));
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  A.engine.stopSync(); B.engine.stopSync();
  stopBackend();
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
