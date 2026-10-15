/**
 * Guards the desktop-to-home-server version check (src/utils/homeServer.js
 * evaluateVersions + the sync engine's gate in src/sync/syncEngine.js):
 *   - same app version: nothing to say, sync runs;
 *   - different app version, same protocol: a notice (which side is newer,
 *     a link to the server's downloads), sync runs;
 *   - different protocol: PAUSED - the engine's cycle makes no request,
 *     status.paused says why, local work stays; back to matching
 *     protocols, the pause lifts and sync runs again;
 *   - an old server without the endpoint (404): old-server notice,
 *     protocol 1 assumed, sync runs;
 *   - unreachable: no pause (transient), the error shows, sync waits.
 * Run: node tests/home-server-version.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
for (const dep of ['fake-indexeddb', 'esbuild', 'dexie', 'jsdom']) { try { req.resolve(dep); } catch { console.error(`Missing dependency "${dep}". Run: npm install --no-save jsdom fake-indexeddb`); process.exit(1); } }
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };

await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://console.test/' });
for (const key of ['window', 'document']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
globalThis.localStorage = dom.window.localStorage;
for (const k of ['db_migration_complete', 'workflows_migration_complete', 'env_vars_migration_complete']) localStorage.setItem(k, 'true');

const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'home-server-version-'));
const entry = path.join(WORK, 'entry.mjs');
fs.writeFileSync(entry, `
  globalThis.__JACARIUM_DB_NAME = 'Jacarium-version-test';
  export * as hs from '@worktree/src/utils/homeServer.js';
  export * as engine from '@worktree/src/sync/syncEngine.js';
  export { db } from '@worktree/src/db/database.js';
`);
const bundle = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [entry], bundle: true, outfile: bundle, format: 'cjs', platform: 'node',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx' }, define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }], logLevel: 'error',
});
const { hs, engine, db } = req(bundle);
await db.open();
const desktop = { app: '3.0.0', protocol: 1 };
const server = (over) => ({ reachable: true, linked: true, url: 'https://pi.example.test', app: '3.0.0', protocol: 1, legacy: false, error: null, ...over });

try {
  // ---- what the versions mean ----
  check('same version: nothing to say', hs.evaluateVersions({ desktop, server: server({}) }).state === 'same');
  let v = hs.evaluateVersions({ desktop, server: server({ app: '3.1.0' }) });
  check('server newer, same protocol: a notice with the downloads link, not paused', v.state === 'server-newer' && !v.paused && /Desktop 3\.0\.0, home server 3\.1\.0/.test(v.message) && v.downloadsUrl === 'https://pi.example.test/api/downloads/', JSON.stringify(v).slice(0, 200));
  v = hs.evaluateVersions({ desktop, server: server({ app: '2.9.9' }) });
  check('server older, same protocol: a notice to update the server, not paused', v.state === 'server-older' && !v.paused && /Update the home server/.test(v.message));
  v = hs.evaluateVersions({ desktop, server: server({ app: '4.0.0', protocol: 2 }) });
  check('server with a newer protocol: paused, "update the desktop app", download link', v.state === 'incompatible' && v.paused && /Update the desktop app/.test(v.message) && /nothing is merged or wiped/.test(v.message));
  v = hs.evaluateVersions({ desktop: { app: '4.0.0', protocol: 2 }, server: server({ app: '3.0.0', protocol: 1 }) });
  check('desktop with a newer protocol: paused, "update the home server"', v.state === 'incompatible' && v.paused && /Update the home server/.test(v.message));
  v = hs.evaluateVersions({ desktop, server: server({ app: null, protocol: 1, legacy: true }) });
  check('an old server without the endpoint: old-server notice, protocol 1 assumed, not paused', v.state === 'server-older' && !v.paused && /before 3\.0\.0/.test(v.message));
  v = hs.evaluateVersions({ desktop: { app: '4.0.0', protocol: 2 }, server: server({ app: null, protocol: 1, legacy: true }) });
  check('...but a protocol-2 desktop against it is paused', v.state === 'incompatible' && v.paused);
  v = hs.evaluateVersions({ desktop, server: server({ reachable: false, error: 'timeout' }) });
  check('unreachable: not paused (transient), the error is the message', v.state === 'unreachable' && !v.paused && v.message === 'timeout');
  check('not linked: nothing', hs.evaluateVersions({ desktop, server: { linked: false } }).state === 'not-linked');
  check('compareVersions orders X.Y.Z numerically', hs.compareVersions('2.10.0', '2.9.9') > 0 && hs.compareVersions('3.0.0', '3.0.0') === 0 && hs.compareVersions('2.6.0', '3.0.0') < 0);

  // ---- the engine's gate ----
  let calls = 0;
  const transport = { fetch: async (p, init = {}) => { calls += 1; const n = p.includes('push') ? (JSON.parse(init.body || '{}').changes || []).length : 0; return { ok: true, status: 200, json: async () => (p.includes('pull') ? { changes: [], seq: 0, latest: 0, generation: 1 } : { results: Array.from({ length: n }, (_, i) => ({ status: 'ok', rev: 1, seq: i + 1 })), latest: n, generation: 1 }) }; } };
  let verdict = { ok: false, reason: 'Synchronisation paused: versions do not match' };
  await engine.startSync({ transport, listen: false, immediate: false, gate: async () => verdict });
  await db.documents.add({ title: 'Local work', content: 'stays', category: 'General', updatedAt: Date.now(), stableId: 'sid-local' });
  await engine.syncNow();
  let status = engine.getSyncStatus();
  check('with the gate closed (incompatible) a cycle makes NO request and reports the pause', calls === 0 && status.paused === verdict.reason && !status.syncing, JSON.stringify({ calls, paused: status.paused }));
  check('...the local work is untouched and still pending', (await db.documents.count()) === 1 && status.pending === 1);
  let gateThrows = true;
  const throwing = async () => { if (gateThrows) throw new Error("Error invoking remote method 'home-server:version': Cannot find module '../protocol.json'"); return verdict; };
  engine.stopSync();
  await engine.startSync({ transport, listen: false, immediate: false, gate: throwing });
  await engine.syncNow();
  status = engine.getSyncStatus();
  check('a gate that THROWS (a broken build) is an error: no request, lastError says why, nothing counts as finished', calls === 0 && /protocol\.json/.test(status.lastError || '') && status.lastPullAt === null && status.lastPushAt === null, JSON.stringify(status));
  gateThrows = false;
  verdict = { ok: false, reason: 'timeout', transient: true };
  await engine.syncNow();
  status = engine.getSyncStatus();
  check('an unreachable server (transient) is an error, not a pause, and still no request', calls === 0 && status.paused === null && status.lastError === 'timeout');
  verdict = { ok: true };
  await engine.syncNow();
  status = engine.getSyncStatus();
  check('once the versions match the pause lifts and the cycle runs (pull + push)', calls >= 2 && status.paused === null && status.lastError === null && status.pending === 0, JSON.stringify({ calls, status }));
  engine.stopSync();
} catch (error) {
  check('the scenario ran to the end', false, error.stack || error.message);
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
