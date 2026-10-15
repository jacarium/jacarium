/**
 * Guards the document-list performance fix in src/utils/documents.js:
 * getDocumentsMetadata().
 *
 * Background: getDocuments() returns FULL IndexedDB records - including the
 * arbitrarily large rich-text `content` body - so every caller that only
 * wanted title/category/updatedAt for a list view paid O(n x content-size)
 * in memory. getDocumentsMetadata() iterates the same updatedAt index with a
 * cursor but drops `content` from every row before it is retained, and the
 * list-only call sites (FloatingDraft, DraftSidebar, ChatSidebar,
 * documentCategories, cloudDocuments, cloudCentralSync lookups, DB
 * wipe/import id-scans) were switched to it. Content-dependent callers
 * (CommandPalette content search, DB export, DocumentsPage editor state,
 * DatasetSelectionModal indexing) still use getDocuments()/getDocument().
 *
 * What this test proves against the REAL src/utils/documents.js +
 * src/db/database.js running on real Dexie over fake-indexeddb (no mocks of
 * the code under test):
 *   1. getDocumentsMetadata() returns every document, newest-first by
 *      updatedAt - same count and order as getDocuments().
 *   2. Returned objects have NO `content` property AT ALL (the key is
 *      absent, not set to undefined) while all metadata fields (title,
 *      category, locked, inCloud, ownerId, permissions, updatedAt) survive.
 *   3. getDocuments() and getDocument(id) still return the full `content`
 *      byte-for-byte - including a deliberately large (2 MB) body.
 *   4. Merge safety: spreading a metadata object into updateDocument()
 *      (the exact pattern used by receiveDocumentFromCentral's removal path
 *      and the category rename/delete helpers) leaves the stored content
 *      untouched, because the `content` key is absent rather than undefined.
 *   5. Supporting evidence (deterministic, not timing-based): the JSON
 *      serialization of the metadata list is >50x smaller than the full
 *      list for the seeded dataset.
 *
 * Self-contained, no test framework, same conventions as the other .mjs
 * tests: the real modules are bundled with esbuild (extensionless ESM
 * imports in src/ are Vite-style) into a temp CJS file and loaded in-process
 * behind a fake-indexeddb + localStorage-stub environment.
 *
 * Run:  node tests/documents-metadata-projection.test.mjs
 * Preconditions (checked at startup, with instructions printed if missing):
 *   - repo deps installed:                npm install       (for esbuild/dexie)
 *   - test-only dep (not in package.json): npm install --no-save fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

// ---------- precondition checks ----------
function requireResolvable(name, hint) {
  try {
    req.resolve(name);
  } catch {
    console.error(`Missing dependency "${name}". ${hint}`);
    process.exit(1);
  }
}
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('dexie', 'Run: npm install');
requireResolvable('fake-indexeddb', 'Run: npm install --no-save jsdom fake-indexeddb');

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-metadata-test-'));
console.log('work dir:', WORKDIR);

// ---------- environment: fake IndexedDB + localStorage stub ----------
// database.js runs initializeDatabase() on import and reads localStorage;
// preset the migration flags so no legacy-migration code paths run.
const lsStore = new Map([
  ['db_migration_complete', 'true'],
  ['workflows_migration_complete', 'true'],
  ['env_vars_migration_complete', 'true'],
]);
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
  key: (i) => Array.from(lsStore.keys())[i] ?? null,
  get length() { return lsStore.size; },
};
await import(req.resolve('fake-indexeddb/auto')); // globalThis.indexedDB / IDBKeyRange

// ---------- bundle the real modules under test ----------
const { build } = await import(req.resolve('esbuild'));
const ENTRY = path.join(WORKDIR, 'entry.mjs');
const BUNDLE = path.join(WORKDIR, 'documents-bundle.cjs');
fs.writeFileSync(ENTRY, [
  `export * from ${JSON.stringify(path.join(REPO, 'src/utils/documents.js'))};`,
  `export { db } from ${JSON.stringify(path.join(REPO, 'src/db/database.js'))};`,
].join('\n'));
await build({
  entryPoints: [ENTRY],
  bundle: true,
  outfile: BUNDLE,
  format: 'cjs',
  platform: 'node',
  resolveExtensions: ['.js', '.mjs', '.json'],
  nodePaths: [path.join(REPO, 'node_modules')],
  logLevel: 'warning',
});
const docsApi = req(BUNDLE);
const { getDocuments, getDocumentsMetadata, getDocument, updateDocument, getCategories, db } = docsApi;

// ---------- test scaffolding ----------
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// ---------- seed documents with distinctly-sized content ----------
// Explicit updatedAt values make the expected newest-first order
// deterministic (createDocument stamps Date.now(), which can collide).
const BIG = 'B'.repeat(2 * 1024 * 1024); // 2 MB body
const MEDIUM = 'runbook line\n'.repeat(4000); // ~52 KB
const seeds = [
  { title: 'Oldest tiny note', content: 'hello', category: 'General', locked: false, updatedAt: 1000 },
  { title: 'Medium runbook', content: MEDIUM, category: 'Runbooks', locked: true, updatedAt: 2000 },
  {
    title: 'Huge incident log', content: BIG, category: 'Incidents', locked: false, updatedAt: 3000,
    inCloud: true, ownerId: 'machine-abc', cloudLastUpdated: 999, cloudDocumentId: 'room-1',
    permissions: { 'machine-xyz': 'write' },
  },
  { title: 'Empty draft', content: '', category: 'Draft', locked: false, updatedAt: 4000 },
  { title: 'Newest tiny note', content: 'bye', category: 'General', locked: false, updatedAt: 5000 },
];
const idByTitle = {};
for (const seed of seeds) {
  idByTitle[seed.title] = await db.documents.add({ ...seed });
}
const expectedOrder = [...seeds].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => s.title);

// ---------- 1 + 2: metadata list correctness ----------
const meta = await getDocumentsMetadata();
check('metadata list returns all documents', meta.length === seeds.length,
  `got ${meta.length}, want ${seeds.length}`);
check('metadata list is ordered newest-first by updatedAt',
  JSON.stringify(meta.map((d) => d.title)) === JSON.stringify(expectedOrder),
  `got [${meta.map((d) => d.title).join(', ')}]`);
check('no returned metadata object has a content key (absent, not undefined)',
  meta.every((d) => !('content' in d)),
  `offenders: ${meta.filter((d) => 'content' in d).map((d) => d.title).join(', ') || 'none'}`);

const hugeMeta = meta.find((d) => d.title === 'Huge incident log');
check('metadata fields survive the projection',
  hugeMeta &&
  hugeMeta.id === idByTitle['Huge incident log'] &&
  hugeMeta.category === 'Incidents' &&
  hugeMeta.locked === false &&
  hugeMeta.inCloud === true &&
  hugeMeta.ownerId === 'machine-abc' &&
  hugeMeta.cloudLastUpdated === 999 &&
  hugeMeta.cloudDocumentId === 'room-1' &&
  hugeMeta.updatedAt === 3000 &&
  hugeMeta.permissions && hugeMeta.permissions['machine-xyz'] === 'write',
  JSON.stringify(hugeMeta));
const lockedMeta = meta.find((d) => d.title === 'Medium runbook');
check('locked flag preserved on another row', lockedMeta && lockedMeta.locked === true);

// ---------- 3: full-content paths still return content ----------
const full = await getDocuments();
check('getDocuments() still returns every document in the same order',
  full.length === seeds.length &&
  JSON.stringify(full.map((d) => d.title)) === JSON.stringify(expectedOrder));
const hugeFull = full.find((d) => d.title === 'Huge incident log');
check('getDocuments() still returns the full 2MB content byte-for-byte',
  hugeFull && hugeFull.content === BIG,
  `content length ${hugeFull?.content?.length ?? 'missing'}, want ${BIG.length}`);
check('getDocuments() returns empty-string content as-is (not dropped)',
  full.find((d) => d.title === 'Empty draft')?.content === '');
const single = await getDocument(idByTitle['Medium runbook']);
check('getDocument(id) (the open-in-editor path) returns full content',
  single && single.content === MEDIUM);

// ---------- 4: merge safety of spreading a metadata object into updateDocument ----------
// Exact pattern of receiveDocumentFromCentral's removal path and the
// category helpers: metadata object spread + field overrides.
const spreadUpdate = { ...hugeMeta, inCloud: false, category: 'Renamed' };
await updateDocument(hugeMeta.id, spreadUpdate);
const afterSpread = await getDocument(hugeMeta.id);
check('spreading a metadata object into updateDocument() preserves stored content',
  afterSpread && afterSpread.content === BIG,
  `content length ${afterSpread?.content?.length ?? 'missing'}, want ${BIG.length}`);
check('spread-update applied the metadata changes',
  afterSpread && afterSpread.inCloud === false && afterSpread.category === 'Renamed');

// ---------- 5: serialization-size evidence (deterministic, no timing) ----------
const metaBytes = JSON.stringify(meta).length;
const fullBytes = JSON.stringify(full).length;
console.log(`serialized size: metadata=${metaBytes} bytes, full=${fullBytes} bytes, ` +
  `ratio=${(fullBytes / metaBytes).toFixed(1)}x`);
check('metadata list serializes >50x smaller than full list for this dataset',
  metaBytes * 50 < fullBytes,
  `metadata=${metaBytes}B full=${fullBytes}B`);

// ---------- 6: getCategories() (indexed uniqueKeys, no record scan) ----------
// getCategories() now derives names from db.documents.orderBy('category')
// .uniqueKeys() + index-backed counts instead of toArray()ing every record
// (content bodies included) just to collect category strings. Prove it still
// returns exactly the categories a full scan would find, and still detects
// uncategorized documents.
const allDocsNow = await getDocuments();
const expectedCats = [...new Set(allDocsNow.map((d) => d.category).filter(Boolean))];
const cats = await getCategories();
check('getCategories() returns every category a full scan finds',
  expectedCats.every((c) => cats.includes(c)),
  `missing: ${expectedCats.filter((c) => !cats.includes(c)).join(', ') || 'none'} | got [${cats.join(', ')}]`);
check('getCategories() invents no categories a full scan would not find',
  cats.every((c) => expectedCats.includes(c) || c === 'General'),
  `extra: ${cats.filter((c) => !expectedCats.includes(c) && c !== 'General').join(', ')}`);

// All seeded docs are categorized, so 'General' must only appear if a seed used it.
check('no spurious General when every document is categorized',
  cats.includes('General') === expectedCats.includes('General'));

// Uncategorized detection: null/undefined category has no index entry, and
// '' is indexed but must still count as uncategorized (old filter(Boolean)).
const noCatId = await db.documents.add({ title: 'No category', content: 'x', updatedAt: 6000 });
const emptyCatId = await db.documents.add({ title: 'Empty category', content: 'y', category: '', updatedAt: 7000 });
const catsWithUncat = await getCategories();
check('uncategorized (missing category) documents surface General',
  catsWithUncat.includes('General'));
check('empty-string category is treated as uncategorized, not a category',
  !catsWithUncat.includes(''),
  `got [${catsWithUncat.join(', ')}]`);
await db.documents.delete(noCatId);
await db.documents.delete(emptyCatId);

// ---------- summary ----------
const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED: ' + failed.map((r) => r.name).join(' | '));
}
await db.close();
fs.rmSync(WORKDIR, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
