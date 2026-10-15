/**
 * Guards "Delete all my data on the server" across devices
 * (src/sync/syncEngine.js generations, backend/account_data.py):
 *
 *   1. two devices of one account share documents, a board with a card and
 *      a template; device B then goes offline and keeps editing (an edit, a
 *      new document) without synchronising;
 *   2. device A deletes all the account's data on the server (fresh
 *      password + typed username): the server backs up first, empties the
 *      store and bumps the generation; A empties itself right away after
 *      taking a snapshot;
 *   3. B reconnects: whether it pulls first or pushes first, it does NOT
 *      resurrect anything - it empties itself (its offline edits included,
 *      after a snapshot) and the server stays empty;
 *   4. life goes on at the new generation: B creates a document, A receives it;
 *   5. the backup restores through Import Database (merge): the documents,
 *      the board with its card and the template come back.
 *
 * Real backend (accounts mode), real engine on fake-indexeddb, synthetic data.
 * Run: node tests/sync-delete-all.test.mjs
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
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://console.test/' });
for (const key of ['window', 'document', 'FileReader', 'Blob']) {
  if (!(key in globalThis) || key === 'window' || key === 'document') Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.Blob = dom.window.Blob;
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
for (const k of ['db_migration_complete', 'workflows_migration_complete', 'env_vars_migration_complete']) globalThis.window.localStorage.setItem(k, 'true');
globalThis.localStorage = globalThis.window.localStorage;

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-delete-all-'));
const backend = spawn(PYTHON, ['app.py'], { cwd: path.join(REPO, 'backend'), env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_'))), HOME: DATA, PORT: String(PORT), JACARIUM_AUTH_MODE: 'accounts', JACARIUM_REPORTS_ROOT: path.join(DATA, 'reports'), JACARIUM_KNOWN_HOSTS: path.join(DATA, '.ssh', 'known_hosts') }, stdio: ['ignore', 'pipe', 'pipe'] });
let backendLog = '';
backend.stdout.on('data', (d) => { backendLog += d; }); backend.stderr.on('data', (d) => { backendLog += d; });
const BASE = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(`${BASE}/health`)).ok; } catch { await sleep(250); } }
const stopBackend = () => { try { backend.kill('SIGTERM'); } catch { /* gone */ } fs.rmSync(DATA, { recursive: true, force: true }); };
if (!up) { console.log('FAIL: the backend did not start\n' + backendLog.slice(-1500)); stopBackend(); process.exit(1); }
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
const transportFor = (cookie) => ({ fetch: (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { ...CSRF, ...(init.headers || {}), Cookie: cookie } }) });
const serverStatus = async () => (await transportFor(cookieA).fetch('/api/sync/status')).json();

const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-delete-all-bundle-'));
async function device(name, dbName) {
  const entry = path.join(WORK, `${name}-entry.mjs`);
  fs.writeFileSync(entry, `
    globalThis.__JACARIUM_DB_NAME = ${JSON.stringify(dbName)};
    export * as engine from '@worktree/src/sync/syncEngine.js';
    export * as importer from '@worktree/src/utils/importDatabase.js';
    export { db } from '@worktree/src/db/database.js';
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
  await mod.db.open();
  return { name, ...mod };
}
const A = await device('A', 'Jacarium-delete-A');
const B = await device('B', 'Jacarium-delete-B');
await A.engine.startSync({ transport: transportFor(cookieA), listen: false, immediate: false });
await B.engine.startSync({ transport: transportFor(cookieB), listen: false, immediate: false });
const counts = async (d) => ({ documents: await d.db.documents.count(), boards: await d.db.kanbanBoards.count(), cards: await d.db.kanbanCards.count(), templates: await d.db.templates.count(), state: await d.db._syncState.count() });

try {
  // ---- 1: the shared world, then B goes offline ----
  const docA = await A.db.documents.add({ title: 'Runbook', content: 'v1', category: 'General', updatedAt: Date.now(), stableId: 'sid-runbook' });
  await A.db.documents.add({ title: 'Notes', content: 'n', category: 'General', updatedAt: Date.now(), stableId: 'sid-notes' });
  const boardId = await A.db.kanbanBoards.add({ title: 'Sprint', category: 'Work', createdAt: new Date(), updatedAt: new Date() });
  await A.db.kanbanCards.add({ boardId, title: 'Fix it', column: 'todo', createdAt: new Date(), updatedAt: new Date(), yjsId: 'card-1' });
  await A.db.templates.add({ name: 'My JQL', category: 'General', query: 'project = X', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await A.engine.syncNow();
  await B.engine.syncNow();
  const before = await counts(B);
  check('1. B received the documents, the board with its card and the template', before.documents === 2 && before.boards === 1 && before.cards === 1 && before.templates === 1, JSON.stringify(before));
  const runbookB = await B.db.documents.where('stableId').equals('sid-runbook').first();
  await B.db.documents.update(runbookB.id, { content: 'B offline edit', updatedAt: Date.now() + 1000 });
  await B.db.documents.add({ title: 'Written offline', content: 'x', category: 'General', updatedAt: Date.now() + 1000, stableId: 'sid-offline' });
  check('1. B has pending changes it could not send (offline)', (await B.db._syncState.where('dirty').equals(1).count()) === 2);

  // ---- 2: A deletes everything on the server ----
  let refused = null;
  try { await A.engine.deleteAllServerData({ password: 'wrong', confirmUsername: 'alice' }); } catch (e) { refused = e; }
  check('2. a wrong password is refused and nothing changes', refused?.status === 403 && (await counts(A)).documents === 2 && (await serverStatus()).records === 5);
  const answer = await A.engine.deleteAllServerData({ password: 'alices password', confirmUsername: 'alice' });
  check('2. the deletion succeeds: 5 records removed, generation 2, a backup named', answer.ok && answer.deleted.records === 5 && answer.generation === 2 && /before-delete\.json$/.test(answer.backups[0]), JSON.stringify(answer).slice(0, 200));
  const afterA = await counts(A);
  check('2. A emptied itself right away (tables and sync state)', afterA.documents === 0 && afterA.boards === 0 && afterA.cards === 0 && afterA.templates === 0 && afterA.state === 0, JSON.stringify(afterA));
  const snapsA = await A.db._syncSnapshots.toArray();
  check('2. ...after a snapshot of what it had (Export Database format)', snapsA.some((s) => /deleted on the server/.test(s.reason) && JSON.parse(s.json).documents.length === 2), snapsA.map((s) => s.reason).join(' / '));
  const status2 = await serverStatus();
  check('2. the server store is empty at generation 2', status2.records === 0 && status2.generation === 2, JSON.stringify(status2));

  // ---- 3: B reconnects - push first (the worst case) ----
  await B.engine.push();
  const afterB = await counts(B);
  const status3 = await serverStatus();
  check('3. B pushing its offline edits first is refused (stale generation) and B empties itself instead', afterB.documents === 0 && afterB.state === 0 && status3.records === 0 && status3.generation === 2, JSON.stringify({ afterB, status3 }));
  check('3. ...after a snapshot holding its offline work (nothing lost by accident)', (await B.db._syncSnapshots.toArray()).some((s) => /deleted on the server/.test(s.reason) && JSON.parse(s.json).documents.some((d) => d.title === 'Written offline')));
  await B.engine.syncNow();
  check('3. a full sync afterwards changes nothing: still empty everywhere', (await counts(B)).documents === 0 && (await serverStatus()).records === 0);
  // a device that pulls first behaves the same: simulate with A given a stale generation
  await A.db._syncMeta.put({ key: 'generation', value: 1 });
  await A.db.documents.add({ title: 'Ghost', content: 'g', category: 'General', updatedAt: Date.now(), stableId: 'sid-ghost' });
  await A.engine.syncNow();
  check('3. a device pulling first with a stale generation empties itself too (no ghost on the server)', (await counts(A)).documents === 0 && (await serverStatus()).records === 0);

  // ---- 4: life goes on ----
  await B.db.documents.add({ title: 'Fresh start', content: 'after the deletion', category: 'General', updatedAt: Date.now(), stableId: 'sid-fresh' });
  await B.engine.syncNow();
  await A.engine.syncNow();
  check('4. a document created on B after the deletion reaches A (generation 2)', (await A.db.documents.where('stableId').equals('sid-fresh').first())?.content === 'after the deletion' && (await serverStatus()).records === 1);

  // ---- 5: the backup restores through Import Database ----
  const list = await (await transportFor(cookieA).fetch('/api/account/backups')).json();
  const backup = await (await transportFor(cookieA).fetch(`/api/account/backups/${encodeURIComponent(list.backups[0].name)}`)).json();
  check('5. the backup downloads in Export Database format', backup.version === '1.0' && backup.documents.length === 2 && backup.kanbanBoards.length === 1 && backup.kanbanCards.length === 1 && backup.jqlTemplates.length === 1, Object.keys(backup).join(','));
  const summary = await A.importer.mergeImportDatabase(backup);
  const restored = await counts(A);
  const card = await A.db.kanbanCards.toArray();
  const board = await A.db.kanbanBoards.toArray();
  check('5. importing it (merge) brings the documents, the board with its card and the template back', restored.documents === 3 && restored.boards === 1 && restored.cards === 1 && restored.templates === 1 && card[0].boardId === board[0].id, JSON.stringify({ restored, summary: Object.keys(summary) }));
  await A.engine.syncNow();
  await B.engine.syncNow();
  check('5. ...and the restored data synchronises to B like any other', (await counts(B)).documents === 3 && (await counts(B)).cards === 1);
} catch (error) {
  check('the scenario ran to the end', false, (error.stack || error.message) + '\n' + backendLog.slice(-800));
} finally {
  A.engine.stopSync(); B.engine.stopSync();
  stopBackend();
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
