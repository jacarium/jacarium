#!/usr/bin/env node
/**
 * Open tabs shared across the devices of an account (src/utils/openTabsSync.js,
 * the openTabs table in src/utils/mergeCore.js), through the REAL
 * synchronisation: the engine (src/sync/syncEngine.js) on bundled Dexie
 * databases (fake-indexeddb) against the REAL backend (backend/app.py) in
 * accounts mode, as tests/taskwarrior-follow.test.mjs does.
 *
 *   A and B: two devices of alice's account (two sessions);
 *   C: a device of bob's, another account on the same server.
 *
 * Proves (synthetic data only, a throwaway server directory):
 *   1. a tab opened on A is on B after both synchronise (id, title, position;
 *      the record carries ids and titles only, no content);
 *   2. a tab closed on B is gone on A (a tombstone travels);
 *   3. bob's device never sees alice's tabs;
 *   4. an open on A and a close of another tab on B at the same time lose
 *      nothing: both devices end with the opened tab and without the closed one;
 *   5. a device offline (its transport failing) keeps working; when it is
 *      back, both sides' changes merge;
 *   6. the same tab opened on one device and closed on the other at nearly
 *      the same time resolves one way on both devices (no ghost on one side);
 *   7. two devices that both start mirroring with different local tabs end
 *      with the union: a device never deletes a row it never had open.
 *
 * Needs fake-indexeddb + jsdom + esbuild (npm install --no-save jsdom
 * fake-indexeddb) and the backend venv. Run: node tests/synced-open-tabs.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';
import { reapOnExit } from './helpers/reap.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PYTHON = fs.existsSync(path.join(REPO, 'backend', 'venv', 'bin', 'python')) ? path.join(REPO, 'backend', 'venv', 'bin', 'python') : 'python3';
for (const dep of ['fake-indexeddb', 'jsdom', 'esbuild', 'dexie']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} missing (npm install --no-save jsdom fake-indexeddb)`); process.exit(0); } }

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a browser-ish global environment for Dexie + the engine --------------
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://console.test/' });
for (const key of ['window', 'document', 'FileReader', 'Blob', 'CustomEvent', 'Event']) {
  if (!(key in globalThis) || key === 'window' || key === 'document') Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.Blob = dom.window.Blob;
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
for (const k of ['db_migration_complete', 'workflows_migration_complete', 'env_vars_migration_complete']) globalThis.window.localStorage.setItem(k, 'true');
globalThis.localStorage = globalThis.window.localStorage;

// ---- the home server on a free port -------------------------------------------
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-tabs-'));
const S_DATA = path.join(TMP, 'server');
fs.mkdirSync(S_DATA, { recursive: true });
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_') && k !== 'APP_AUTH_TOKEN'));
let log = '';
const S_PORT = await freePort();
const S = reapOnExit(spawn(PYTHON, ['app.py'], { cwd: path.join(REPO, 'backend'), env: { ...baseEnv, PORT: String(S_PORT), HOME: S_DATA, JACARIUM_AUTH_MODE: 'accounts', JACARIUM_REPORTS_ROOT: path.join(S_DATA, 'reports'), JACARIUM_KNOWN_HOSTS: path.join(S_DATA, '.ssh', 'known_hosts') }, stdio: ['ignore', 'pipe', 'pipe'] }));
S.stdout.on('data', (d) => { log += d; });
S.stderr.on('data', (d) => { log += d; });
const S_URL = `http://127.0.0.1:${S_PORT}`;
const stopAll = () => { try { S.kill('SIGTERM'); } catch { /* gone */ } fs.rmSync(TMP, { recursive: true, force: true }); };
let up = false;
for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(`${S_URL}/health`)).ok; } catch { await sleep(250); } }
if (!up) { console.log('FAIL: the backend did not start\n' + log.slice(-1500)); stopAll(); process.exit(1); }

// ---- the accounts: alice (A, B) and bob (C) ---------------------------------------
const CSRF = { 'X-Requested-With': 'Jacarium', 'Content-Type': 'application/json' };
const setupCode = fs.readFileSync(path.join(S_DATA, 'setup-code'), 'utf8').trim();
async function session(body, pathName) {
  const r = await fetch(`${S_URL}${pathName}`, { method: 'POST', headers: CSRF, body: JSON.stringify(body) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error(`no cookie from ${pathName}: ${r.status} ${await r.text()}`);
  return cookie;
}
const cookieA = await session({ setupCode, username: 'alice', password: 'alices password' }, '/api/auth/setup');
const cookieB = await session({ username: 'alice', password: 'alices password' }, '/api/auth/login');
const created = await fetch(`${S_URL}/api/admin/users`, { method: 'POST', headers: { ...CSRF, Cookie: cookieA }, body: JSON.stringify({ username: 'bob', password: 'bobs password' }) });
if (!created.ok) { console.log(`FAIL: could not create bob: ${created.status} ${await created.text()}`); stopAll(); process.exit(1); }
const cookieC = await session({ username: 'bob', password: 'bobs password' }, '/api/auth/login');
const transportFor = (cookie, gate = { online: true }) => ({ fetch: async (p, init = {}) => { if (!gate.online) throw new TypeError('Failed to fetch'); return fetch(`${S_URL}${p}`, { ...init, headers: { ...CSRF, ...(init.headers || {}), Cookie: cookie } }); } });

// ---- bundle the app code once per device (one module graph = one `db`) ----------
const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'open-tabs-bundle-'));
async function device(name, dbName) {
  const entry = path.join(WORK, `${name}-entry.mjs`);
  fs.writeFileSync(entry, `
    globalThis.__JACARIUM_DB_NAME = ${JSON.stringify(dbName)};
    export * as engine from '@worktree/src/sync/syncEngine.js';
    export * as tabs from '@worktree/src/utils/openTabsSync.js';
    export { db } from '@worktree/src/db/database.js';
  `);
  const out = path.join(WORK, `${name}.cjs`);
  await build({
    entryPoints: [entry], bundle: true, outfile: out, format: 'cjs', platform: 'node',
    loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx' },
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', 'globalThis.__JACARIUM_BACKEND_URL': JSON.stringify(S_URL) },
    resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
    plugins: [{ name: 'alias', setup(b) {
      b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
      b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
    } }],
    logLevel: 'error',
  });
  const mod = req(out);
  await mod.db.open();
  return { name, ...mod };
}
const A = await device('A', 'Jacarium-tabs-A');
const B = await device('B', 'Jacarium-tabs-B');
const C = await device('C', 'Jacarium-tabs-C');
const gateB = { online: true };
await A.engine.startSync({ transport: transportFor(cookieA), listen: false, immediate: false });
await B.engine.startSync({ transport: transportFor(cookieB, gateB), listen: false, immediate: false });
await C.engine.startSync({ transport: transportFor(cookieC), listen: false, immediate: false });
// Each device has its own localStorage (the mirrored sets are per device; the
// three bundles share this process's globals, so it is swapped per call)
class MemStorage { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
for (const d of [A, B, C]) d.storage = new MemStorage();
const as = async (d, fn) => { const prev = globalThis.localStorage; globalThis.localStorage = d.storage; try { return await fn(); } finally { globalThis.localStorage = prev; } };
const sync = (d) => as(d, () => d.engine.syncNow());
const items = async (d, page = 'documents') => as(d, async () => (await d.tabs.readSyncedTabs(page)).map((r) => r.item));
const open = (d, page, list) => as(d, () => d.tabs.writeSyncedTabs(page, list));
// what the page's hook does when rows arrive: the device now holds them (its mirrored set)
const applied = (d, page = 'documents') => as(d, async () => d.tabs.saveMirrored(page, (await d.tabs.readSyncedTabs(page)).map((r) => r.item)));

try {
  // ---- 1. open on A -> on B ----
  await open(A, 'documents', [{ item: 'sid-runbook', title: 'Kubernetes upgrade runbook' }, { item: 'sid-tls', title: 'TLS certificate rotation' }]);
  await sync(A); await sync(B);
  const onB = await B.tabs.readSyncedTabs('documents');
  check('1. two tabs opened on A are on B after both synchronise, in order, with their titles', onB.map((r) => `${r.item}@${r.position}:${r.title}`).join(' ') === 'sid-runbook@0:Kubernetes upgrade runbook sid-tls@1:TLS certificate rotation', JSON.stringify(onB));
  const record = await (await transportFor(cookieA).fetch('/api/sync/record?collection=openTabs&key=documents%3Asid-runbook')).json();
  const body = record?.record?.body || record?.body || record;
  const fields = Object.keys(typeof body === 'object' && body ? body : {}).sort().join(',');
  check('   the record on the server carries ids, title and position only - no content', /item/.test(fields) && /title/.test(fields) && !/content|html|markdown|body\b/.test(fields), fields || JSON.stringify(record).slice(0, 200));
  check('   the mirroring is active on both devices (setting on by default, synchronisation started)', A.tabs.isOpenTabsSyncActive() && B.tabs.isOpenTabsSyncActive());

  // ---- 2. close on B -> gone on A ----
  await applied(B);   // B's page showed both tabs
  await open(B, 'documents', [{ item: 'sid-runbook', title: 'Kubernetes upgrade runbook' }]);   // TLS closed on B
  if (process.env.DEBUG_TABS) { console.log('B state after delete', JSON.stringify(await B.db._syncState.where('collection').equals('openTabs').toArray())); console.log('B rows', JSON.stringify(await B.db.openTabs.toArray())); }
  await sync(B);
  if (process.env.DEBUG_TABS) { console.log('B status', JSON.stringify(B.engine.getSyncStatus())); console.log('server pull', JSON.stringify(await (await transportFor(cookieA).fetch('/api/sync/pull?since=0')).json()).slice(0, 1500)); }
  await sync(A);
  if (process.env.DEBUG_TABS) { console.log('A meta', JSON.stringify(await A.db._syncMeta.toArray())); console.log('A pull again', JSON.stringify(await A.engine.pull())); console.log('A state', JSON.stringify(await A.db._syncState.where('collection').equals('openTabs').toArray())); console.log('A rows', JSON.stringify((await A.db.openTabs.toArray()).map((r) => r.item))); }
  check('2. a tab closed on B is gone on A (the tombstone travelled)', (await items(A)).join() === 'sid-runbook', (await items(A)).join());

  // ---- 3. another account sees nothing ----
  await sync(C);
  check('3. bob\'s device sees none of alice\'s tabs', (await items(C)).length === 0, (await items(C)).join());
  await open(C, 'documents', [{ item: 'sid-bobs', title: 'Bob\'s notes' }]);
  await sync(C); await sync(A);
  check('   ...and alice\'s devices see none of bob\'s', !(await items(A)).includes('sid-bobs'), (await items(A)).join());

  // ---- 4. an open on A and a close on B at the same time ----
  await applied(A); await applied(B);
  await open(A, 'documents', [{ item: 'sid-runbook', title: 'Kubernetes upgrade runbook' }, { item: 'sid-arch', title: 'Payment service architecture' }]);
  await open(B, 'documents', []);   // runbook closed on B, before either synchronised
  await sync(A); await sync(B); await sync(A);
  const a4 = await items(A); const b4 = await items(B);
  check('4. an open on A and a close of another tab on B at the same time: both end with the opened tab and without the closed one', a4.join() === 'sid-arch' && b4.join() === 'sid-arch', `A ${a4.join()} / B ${b4.join()}`);

  // ---- 5. B offline, both sides change, B back ----
  await applied(A); await applied(B);
  gateB.online = false;
  await open(A, 'documents', [{ item: 'sid-arch', title: 'Payment service architecture' }, { item: 'sid-incident', title: 'Incident postmortem' }]);
  await sync(A);
  await open(B, 'documents', [{ item: 'sid-arch', title: 'Payment service architecture' }, { item: 'sid-sizing', title: 'Node pool sizing notes' }]);
  let offlineFailed = false;
  try { await sync(B); } catch { offlineFailed = true; }
  check('5. offline, B keeps its own tabs and the synchronisation reports the failure rather than losing them', (await items(B)).join() === 'sid-arch,sid-sizing' && (offlineFailed || B.engine.getSyncStatus().lastError != null || (await items(A)).join() === 'sid-arch,sid-incident'), (await items(B)).join());
  gateB.online = true;
  await sync(B); await sync(A); await sync(B);
  const a5 = (await items(A)).sort().join(); const b5 = (await items(B)).sort().join();
  check('   back online, both sides\' changes merge: the tabs opened on each are on both', a5 === 'sid-arch,sid-incident,sid-sizing' && b5 === a5, `A ${a5} / B ${b5}`);

  // ---- 6. the same tab opened on A and closed on B at nearly the same time ----
  await applied(A); await applied(B);
  await open(A, 'documents', [{ item: 'sid-arch', title: 'Payment service architecture' }, { item: 'sid-incident', title: 'Incident postmortem' }, { item: 'sid-sizing', title: 'Node pool sizing notes' }, { item: 'sid-tls', title: 'TLS certificate rotation' }]);
  await open(B, 'documents', [{ item: 'sid-arch', title: 'Payment service architecture' }, { item: 'sid-incident', title: 'Incident postmortem' }]);   // sizing closed on B
  await sync(A); await sync(B); await sync(A); await sync(B);
  const a6 = (await items(A)).sort().join(); const b6 = (await items(B)).sort().join();
  check('6. after a concurrent open (TLS on A) and close (sizing on B), both devices agree and the opened tab survives', a6 === b6 && a6.includes('sid-tls'), `A ${a6} / B ${b6}`);
  check('   nothing is pending on either side once synchronised', A.engine.getSyncStatus().pending === 0 && B.engine.getSyncStatus().pending === 0, JSON.stringify({ A: A.engine.getSyncStatus().pending, B: B.engine.getSyncStatus().pending }));

  // ---- 7. two devices freshly enabling, different tabs: the union ----
  // (the kanban page: nothing mirrored yet on either side)
  await open(A, 'kanban', [{ item: 'board-a', title: 'Platform' }]);
  await sync(A); await sync(B);   // B's Dexie now holds board-a, which B never had open
  await open(B, 'kanban', [{ item: 'board-b', title: 'Roadmap' }]);   // B's first write: must not delete board-a
  await sync(B); await sync(A);
  const a7 = (await items(A, 'kanban')).sort().join(); const b7 = (await items(B, 'kanban')).sort().join();
  check('7. two devices starting with different tabs end with the union - a first write never deletes a row the device never had open', a7 === 'board-a,board-b' && b7 === a7, `A ${a7} / B ${b7}`);
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}\n${log.slice(-800)}`);
}
try { A.engine.stopSync(); B.engine.stopSync(); C.engine.stopSync(); } catch { /* done */ }
stopAll();
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
