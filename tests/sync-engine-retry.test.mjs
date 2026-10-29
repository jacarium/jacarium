/**
 * The sync engine's retry (src/sync/syncEngine.js call()): a read the
 * server never answered - the transport threw (a refused or reset
 * connection: a home server under load, a flaky network) - or answered
 * 502 / 503 / 504 is tried again, twice, with a short backoff, before the
 * cycle gives up; a write is not (a replayed push would be answered
 * "conflict" by a server that had already applied it), a 4xx is not, and
 * the retries are bounded. The real engine (one Dexie database on
 * fake-indexeddb) against an in-memory fake of the server's sync routes
 * injected as the transport, so every failure is scripted:
 *
 *   1. a pull of 1200 records in three pages whose FIRST page fails once
 *      (TypeError, as fetch throws) completes in the same cycle: every record
 *      is in, the sequence remembered, the fake saw one extra request;
 *   2. a page answered 503 once is retried the same way;
 *   3. a page that fails three times in a row fails the cycle (bounded), and
 *      the next cycle resumes from the last sequence seen;
 *   4. a 400 is not retried (one request, the cycle fails with that error);
 *   5. a push whose POST throws once is NOT retried: the change stays pending
 *      and the next cycle delivers it (the fake saw one POST, then one more).
 *
 * Needs fake-indexeddb + jsdom (npm install --no-save jsdom fake-indexeddb).
 * Run: node tests/sync-engine-retry.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const dep of ['fake-indexeddb', 'jsdom', 'esbuild', 'dexie']) { try { req.resolve(dep); } catch { console.error(`Missing "${dep}": npm install --no-save jsdom fake-indexeddb`); process.exit(1); } }
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://console.test/' });
for (const key of ['window', 'document', 'FileReader', 'Blob', 'CustomEvent', 'Event']) {
  if (!(key in globalThis) || key === 'window' || key === 'document') Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.Blob = dom.window.Blob;
for (const k of ['db_migration_complete', 'workflows_migration_complete', 'env_vars_migration_complete']) globalThis.window.localStorage.setItem(k, 'true');
globalThis.localStorage = globalThis.window.localStorage;

// ---- the engine, bundled once ----
const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-retry-bundle-'));
const entry = path.join(WORK, 'entry.mjs');
fs.writeFileSync(entry, `globalThis.__JACARIUM_DB_NAME = 'Jacarium-sync-retry';\nexport * as engine from '@worktree/src/sync/syncEngine.js';\nexport { db } from '@worktree/src/db/database.js';\n`);
const out = path.join(WORK, 'engine.cjs');
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
const { engine, db } = req(out);
fs.rmSync(WORK, { recursive: true, force: true });
await db.open();

// ---- an in-memory server: the pull feed and the push route, with scripted failures ----
const PAGE = 500;
const server = {
  seq: 0, records: [],             // { collection, key, rev, seq, updatedAt, deleted, body }
  log: [],                         // every request: 'GET /api/sync/pull?since=N' / 'POST /api/sync/push'
  failures: [],                    // scripted: [{ when: (method, path) => boolean, kind: 'throw' | 503 | 400, times }]
  generation: 1,
  add(n, prefix) { for (let i = 0; i < n; i++) { this.seq += 1; this.records.push({ collection: 'documents', key: `${prefix}-${i}`, rev: 1, seq: this.seq, updatedAt: Date.now(), deleted: false, body: { title: `Note ${i}`, content: `body ${i}`, category: 'Bulk', updatedAt: Date.now(), stableId: `${prefix}-${i}` } }); } },
};
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const transport = {
  fetch: async (p, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    server.log.push(`${method} ${p}`);
    const scripted = server.failures.find((f) => f.times > 0 && f.when(method, p));
    if (scripted) {
      scripted.times -= 1;
      if (scripted.kind === 'throw') { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; }
      return json(scripted.kind, { error: scripted.kind === 400 ? 'bad request (scripted)' : 'unavailable (scripted)' });
    }
    const url = new URL(p, 'http://fake.test');
    if (method === 'GET' && url.pathname === '/api/sync/pull') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Math.min(Number(url.searchParams.get('limit') || PAGE), PAGE);
      const rows = server.records.filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
      const page = rows.slice(0, limit);
      return json(200, { changes: page.map((r) => ({ collection: r.collection, key: r.key, rev: r.rev, seq: r.seq, updatedAt: r.updatedAt, deleted: r.deleted, body: r.body })), seq: page.length ? page[page.length - 1].seq : since, more: rows.length > page.length, generation: server.generation, now: Date.now() });
    }
    if (method === 'POST' && url.pathname === '/api/sync/push') {
      const body = JSON.parse(init.body || '{}');
      const results = (body.changes || []).map((c) => { server.seq += 1; const existing = server.records.find((r) => r.collection === c.collection && r.key === c.key); const rev = existing ? existing.rev + 1 : 1; const rec = { collection: c.collection, key: c.key, rev, seq: server.seq, updatedAt: c.updatedAt, deleted: !!c.deleted, body: c.body }; if (existing) Object.assign(existing, rec); else server.records.push(rec); return { status: 'ok', rev, seq: rec.seq }; });
      return json(200, { results, generation: server.generation, now: Date.now() });
    }
    return json(404, { error: `no route ${method} ${url.pathname}` });
  },
  clockOffsetMs: 0,
};
const pullsIn = (log) => log.filter((l) => l.startsWith('GET /api/sync/pull')).length;
const postsIn = (log) => log.filter((l) => l.startsWith('POST /api/sync/push')).length;
const bulk = async () => db.documents.where('category').equals('Bulk').count();
const seqSeen = async () => Number((await db._syncMeta.get('seq'))?.value) || 0;

await engine.startSync({ transport, listen: false, immediate: false });
check('the engine is started with the injected transport', engine.isSyncStarted());

// ---- 1. the first page fails once: the cycle still brings everything ----
server.add(1200, 'sid-bulk');
server.failures = [{ when: (m, p) => m === 'GET' && p.includes('/api/sync/pull?since=0'), kind: 'throw', times: 1 }];
server.log = [];
const t0 = Date.now();
await engine.syncNow();
check('1. a pull whose first page threw once still brings all 1200 records in the same cycle', (await bulk()) === 1200, String(await bulk()));
check('1. the sequence seen is remembered', (await seqSeen()) >= 1200, String(await seqSeen()));
check('1. the fake saw the page asked for again (4 pull requests for 3 pages)', pullsIn(server.log) === 4, server.log.filter((l) => l.startsWith('GET')).join(' | '));
check('1. the retry waited its backoff (>= 300 ms) and the cycle recorded no error', Date.now() - t0 >= 300 && !engine.getSyncStatus().lastError, `${Date.now() - t0} ms, ${engine.getSyncStatus().lastError}`);

// ---- 2. a 503 once ----
server.add(10, 'sid-more');
server.failures = [{ when: (m) => m === 'GET', kind: 503, times: 1 }];
server.log = [];
await engine.syncNow();
check('2. a page answered 503 once is retried and the cycle completes', (await bulk()) === 1210 && pullsIn(server.log) === 2 && !engine.getSyncStatus().lastError, `${await bulk()} ${server.log.join(' | ')}`);

// ---- 3. bounded: three failures in a row fail the cycle; the next cycle resumes ----
server.add(10, 'sid-again');
server.failures = [{ when: (m) => m === 'GET', kind: 'throw', times: 3 }];
server.log = [];
await engine.syncNow();
check('3. three failures in a row: the cycle gives up after 3 attempts with the error recorded', pullsIn(server.log) === 3 && /fetch failed/.test(engine.getSyncStatus().lastError || ''), `${pullsIn(server.log)} ${engine.getSyncStatus().lastError}`);
check('3. ...and the records are not in yet', (await bulk()) === 1210);
server.failures = [];
server.log = [];
await engine.syncNow();
check('3. the next cycle resumes from the sequence seen and brings them', (await bulk()) === 1220 && server.log.some((l) => /since=12\d\d/.test(l)) && !engine.getSyncStatus().lastError, server.log.join(' | '));

// ---- 4. a 400 is not retried ----
server.failures = [{ when: (m) => m === 'GET', kind: 400, times: 5 }];
server.log = [];
await engine.syncNow();
check('4. a 400 is not retried: one request, the cycle fails with that error', pullsIn(server.log) === 1 && /scripted/.test(engine.getSyncStatus().lastError || '') && engine.getSyncStatus().lastErrorStatus === 400, `${pullsIn(server.log)} ${engine.getSyncStatus().lastError}`);
server.failures = [];

// ---- 5. a push whose POST throws once is not retried; the next cycle delivers it ----
await db.documents.add({ title: 'Local note', content: 'written here', category: 'Local', updatedAt: Date.now(), stableId: 'sid-local-1' });
await sleep(50);
server.failures = [{ when: (m) => m === 'POST', kind: 'throw', times: 1 }];
server.log = [];
await engine.syncNow();
check('5. a push whose POST threw is not retried in the cycle (one POST), the change stays pending, the error is recorded', postsIn(server.log) === 1 && engine.getSyncStatus().pending >= 1 && /fetch failed/.test(engine.getSyncStatus().lastError || ''), `${postsIn(server.log)} pending=${engine.getSyncStatus().pending} ${engine.getSyncStatus().lastError}`);
check('5. ...and the server has not got it', !server.records.some((r) => r.key === 'sid-local-1'));
server.log = [];
await engine.syncNow();
check('5. the next cycle pushes it (one more POST), nothing pending, no error', postsIn(server.log) === 1 && server.records.some((r) => r.key === 'sid-local-1') && engine.getSyncStatus().pending === 0 && !engine.getSyncStatus().lastError, `${postsIn(server.log)} pending=${engine.getSyncStatus().pending}`);

await engine.stopSync?.();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
