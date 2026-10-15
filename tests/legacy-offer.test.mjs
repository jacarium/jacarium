/**
 * The "data from before sign-in" offer (src/utils/legacyImport.js):
 *   - the desktop app never gets it (its one 'Jacarium' database IS the
 *     replica), and deleteLegacyDatabase refuses to delete that live database;
 *   - in a browser signed in to an account: no old database -> no offer and
 *     the check creates none; an old database with only seeded or empty
 *     tables -> no offer; one with user data -> offered once, Delete removes
 *     it and remembers the decision, a "restart" (fresh module state) shows
 *     nothing again, and nothing recreates the old database.
 * Real Dexie over fake-indexeddb, jsdom window. Run: node tests/legacy-offer.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
for (const dep of ['fake-indexeddb', 'esbuild', 'dexie']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} missing (npm install --no-save jsdom fake-indexeddb)`); process.exit(0); } }
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: (i) => Array.from(store.keys())[i] ?? null, get length() { return store.size; } };
globalThis.window = globalThis;
await import(req.resolve('fake-indexeddb/auto'));
const Dexie = req('dexie');
const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-offer-'));
async function freshModule(n) {
  // a fresh module instance = an app restart
  const out = path.join(WORK, `legacy-${n}.cjs`);
  await build({ entryPoints: [path.join(REPO, 'src/utils/legacyImport.js')], bundle: true, outfile: out, format: 'cjs', platform: 'node', logLevel: 'silent' });
  delete req.cache[out];
  return req(out);
}
const exists = () => Dexie.exists('Jacarium');

// ---- the desktop: the one database is the live one ----
globalThis.__JACARIUM_DB_NAME = undefined;
globalThis.window.electronAPI = { getBackendPort: async () => 8080 };
let legacy = await freshModule(1);
const live = new Dexie('Jacarium'); live.version(1).stores({ documents: '++id, title' }); await live.open(); await live.documents.add({ title: 'my desktop document' }); live.close();
check('desktop: the offer never applies, even though the Jacarium database exists with data', !legacy.legacyDatabaseApplies() && !(await legacy.legacyDatabaseExists()) && !(await legacy.shouldOfferLegacyImport('u1')) && !(await legacy.shouldOfferLegacyDelete('u1')));
let refused = null; try { await legacy.deleteLegacyDatabase('u1'); } catch (e) { refused = e; }
check('desktop: deleteLegacyDatabase refuses to delete the live database', refused && /database in use/.test(refused.message) && (await exists()) === true, refused && refused.message);
await Dexie.delete('Jacarium');
delete globalThis.window.electronAPI;

// ---- the browser signed in as account u1 (database Jacarium-u1) ----
globalThis.__JACARIUM_DB_NAME = 'Jacarium-u1';
legacy = await freshModule(2);
check('browser: no old database -> no offer', (await legacy.shouldOfferLegacyImport('u1')) === false);
check('browser: ...and the check created none', (await exists()) === false);
// an old database with only seeded / empty tables
const seeded = new Dexie('Jacarium'); seeded.version(1).stores({ documents: '++id, title', gtfobinsFunctions: '++id, name', cache: '&key' }); await seeded.open();
await seeded.gtfobinsFunctions.bulkAdd([{ name: 'shell' }, { name: 'file-read' }]); await seeded.cache.put({ key: 'x', value: 1 }); seeded.close();
check('browser: an old database with only seeded or empty tables is not offered', (await legacy.legacyDatabaseExists()) === true && (await legacy.legacyDatabaseHasUserData()) === false && (await legacy.shouldOfferLegacyImport('u1')) === false && (await legacy.shouldOfferLegacyDelete('u1')) === false);
check('browser: ...and it was not deleted (nothing is deleted automatically)', (await exists()) === true);
// real user data in it
const old = new Dexie('Jacarium'); await old.open(); await old.table('documents').add({ title: 'A real old document' }); old.close();
check('browser: an old database with user data is offered (once)', (await legacy.shouldOfferLegacyImport('u1')) === true && (await legacy.shouldOfferLegacyDelete('u1')) === true);
await legacy.deleteLegacyDatabase('u1');
check('browser: Delete removes the old database and remembers the decision', (await exists()) === false && legacy.legacyImportDecided('u1') && localStorage.getItem('legacyImportDecided:u1') === 'deleted');
legacy = await freshModule(3);   // restart
check('browser: after a restart nothing is offered and nothing recreated the old database', (await legacy.shouldOfferLegacyImport('u1')) === false && (await legacy.shouldOfferLegacyDelete('u1')) === false && (await exists()) === false);
check('browser: another account on the same browser is not offered an old database that is gone', (await legacy.shouldOfferLegacyImport('u2')) === false);

fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
