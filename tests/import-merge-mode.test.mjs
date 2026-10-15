/**
 * Exercises the opt-in "merge" import mode in src/utils/importDatabase.js
 * (mergeImportDatabase) plus a regression check that the default path
 * (replaceImportDatabase) still performs its historical full wipe+replace.
 *
 * Merge mode contract (checkbox checked in ImportDBModal):
 *   - never deletes existing local records;
 *   - matches imported records to local ones by a per-type identity key
 *     (documents: stableId when both sides carry one, title+category
 *     fallback; document templates: name+category, ...);
 *   - overwrites the local record ONLY when the imported timestamp is
 *     strictly newer (documents/templates: updatedAt);
 *   - creates records that have no local match;
 *   - leaves non-matched local records completely untouched.
 *
 * Also proved here:
 *   - the Dexie v23 upgrade backfills a stableId onto documents created
 *     under the v22 schema (real version-change transaction: the DB is
 *     physically created at v22, seeded, closed, then reopened by the
 *     bundled database.js at v23);
 *   - stableId matching survives rename AND recategorize (the motivating
 *     bug: title+category matching created a duplicate instead of updating
 *     the moved/renamed document in place);
 *   - old-style exports without stableIds still merge via title+category,
 *     and an update from such an export preserves the local stableId;
 *   - two documents that share title+category but carry DIFFERENT stableIds
 *     are treated as distinct (no cross-overwrite);
 *   - re-merging the same file is idempotent (stableIds are kept on create);
 *   - replace mode's createDocument path preserves imported stableIds and
 *     mints them for id-less imports (the export -> wipe -> re-import
 *     migration route).
 *
 * What this test proves against the REAL src/utils/importDatabase.js +
 * src/db/database.js running on real Dexie over fake-indexeddb (no mocks of
 * the code under test), for documents AND document templates:
 *   (a) an imported record matching an existing one with an OLDER updatedAt
 *       does NOT overwrite the local record;
 *   (b) an imported record matching an existing one with a NEWER updatedAt
 *       DOES overwrite it (content and timestamp replaced, same Dexie id);
 *   (c) an imported record with no local match is created;
 *   (d) local records not present in the import file survive byte-for-byte;
 *   (e) a matching record with NO comparable timestamp is left untouched
 *       (conservative rule);
 *   plus a workflows spot-check of the same per-type plumbing, and a
 *   localStorage check (merge only fills keys that don't exist locally).
 *
 * Regression (checkbox unchecked): replaceImportDatabase still wipes ALL
 * pre-existing documents/templates and recreates exactly the imported set -
 * quick behavioral check, not a re-test of every entity type.
 *
 * Self-contained, no test framework, same conventions as the other .mjs
 * tests: the real modules are bundled with esbuild into a temp CJS file and
 * loaded in-process behind a fake-indexeddb + localStorage-stub environment.
 *
 * Run:  node tests/import-merge-mode.test.mjs
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

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'import-merge-test-'));
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

// ---------- pre-seed a REAL v22 database before database.js ever opens ----------
// Documents created under the v22 schema have no stableId. database.js's
// version 23 upgrade must backfill one for every one of them. Create the
// database physically at version 22 (same store declarations database.js
// used at v22), seed legacy documents, and close - the bundled db instance
// opened below then runs the genuine 22 -> 23 version-change upgrade.
const T_LEGACY = 1_500_000;
{
  const DexieMod = req('dexie');
  const Dexie = DexieMod.default || DexieMod;
  const legacy = new Dexie('Jacarium');
  legacy.version(22).stores({
    templates: '++id, name, category, createdAt, updatedAt',
    customFields: '&id, name, createdAt',
    cache: '&key, timestamp',
    invalidProjects: '&name, timestamp',
    documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
    documentTemplates: '++id, name, *tags, category, updatedAt, description',
    engineTemplates: '++id, name, category, urlTemplate, description',
    workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
    envVariables: '&key, value',
    kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
    kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
    tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
    taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
    taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
    customReports: '++id, name, category, description, filter, createdAt, updatedAt',
    documentCategories: '++id, name, position, createdAt, updatedAt',
    syncedCalendars: '&id, summary, syncEnabled, lastSynced, syncStatus, eventCount, createdAt, updatedAt',
    calendarEvents: '&id, calendarId, eventId, startDateTime, endDateTime, lastFetched',
    calendarEventTemplates: '++id, name, *tags, defaultCalendarId, createdAt, updatedAt',
    sshCommands: '++id, name, command, description, createdAt, updatedAt',
    openshiftTemplates: '++id, name, category, yaml, icon, description, createdAt, updatedAt',
    media: '++id, filename, uploadedAt',
  });
  await legacy.open();
  await legacy.documents.bulkAdd([
    { title: 'Legacy-A', category: 'General', content: 'legacy-a', locked: false, updatedAt: T_LEGACY },
    { title: 'Legacy-B', category: 'Ops', content: 'legacy-b', locked: true, updatedAt: T_LEGACY },
  ]);
  legacy.close();
}

// ---------- bundle the real modules under test ----------
const { build } = await import(req.resolve('esbuild'));
const ENTRY = path.join(WORKDIR, 'entry.mjs');
const BUNDLE = path.join(WORKDIR, 'import-merge-bundle.cjs');
fs.writeFileSync(ENTRY, [
  `export * from ${JSON.stringify(path.join(REPO, 'src/utils/importDatabase.js'))};`,
  `export { db } from ${JSON.stringify(path.join(REPO, 'src/db/database.js'))};`,
].join('\n'));
await build({
  entryPoints: [ENTRY],
  bundle: true,
  outfile: BUNDLE,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const { mergeImportDatabase, replaceImportDatabase, db } = req(BUNDLE);

// ---------- tiny assertion helpers ----------
let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

// Minimal valid import file skeleton (the modal requires these arrays).
function baseImport(overrides = {}) {
  return {
    version: '1.0',
    documents: [],
    documentTemplates: [],
    jqlTemplates: [],
    engineTemplates: [],
    ...overrides,
  };
}

const T_OLD = 1_000_000;   // older than local
const T_LOCAL = 2_000_000; // seeded local timestamp
const T_NEW = 3_000_000;   // newer than local

/* ================================================================== */
console.log('\n--- v23 upgrade: legacy documents get a stableId backfilled ---');
/* ================================================================== */
// First touch of the bundled db opens the pre-seeded v22 database at v23,
// running the real upgrade transaction.
const migrated = await db.documents.toArray();
const migA = migrated.find(d => d.title === 'Legacy-A');
const migB = migrated.find(d => d.title === 'Legacy-B');

check('both legacy documents survived the upgrade', migrated.length === 2,
  `count=${migrated.length}`);
check('every legacy document was assigned a stableId',
  migrated.every(d => typeof d.stableId === 'string' && d.stableId.length > 0),
  JSON.stringify(migrated.map(d => d.stableId)));
check('backfilled stableIds are unique',
  new Set(migrated.map(d => d.stableId)).size === migrated.length);
check('backfill left every other field untouched',
  migA?.content === 'legacy-a' && migA?.updatedAt === T_LEGACY && migA?.locked === false &&
  migB?.content === 'legacy-b' && migB?.updatedAt === T_LEGACY && migB?.locked === true);

// Clean slate for the merge-behavior sections below.
await db.documents.clear();

/* ================================================================== */
console.log('\n--- merge mode: documents + document templates ---');
/* ================================================================== */

// Seed local DB directly (preserving controlled timestamps).
await db.documents.bulkAdd([
  { title: 'Alpha', category: 'General', content: 'local-alpha', locked: false, updatedAt: T_LOCAL },
  { title: 'Beta', category: 'General', content: 'local-beta', locked: false, updatedAt: T_LOCAL },
  { title: 'Untouched', category: 'Ops', content: 'local-untouched', locked: true, updatedAt: T_LOCAL },
  // updatedAt present (so the record lives in the updatedAt index like every
  // real document) but unparseable -> merge cannot determine "newer".
  { title: 'NoStamp', category: 'General', content: 'local-nostamp', locked: false, updatedAt: 'not-a-date' },
]);
await db.documentTemplates.bulkAdd([
  { name: 'Tmpl-Old', category: 'General', content: 'local-tmpl-old', tags: [], description: '', updatedAt: T_LOCAL },
  { name: 'Tmpl-New', category: 'General', content: 'local-tmpl-new', tags: [], description: '', updatedAt: T_LOCAL },
  { name: 'Tmpl-Keep', category: 'Ops', content: 'local-tmpl-keep', tags: ['keep'], description: 'stay', updatedAt: T_LOCAL },
]);
await db.workflows.bulkAdd([
  { title: 'Flow', category: 'General', nodes: [{ n: 'local' }], edges: [], updatedAt: T_LOCAL },
]);
lsStore.set('kanbanSortBy', 'local-value');

const untouchedBefore = await db.documents.where('title').equals('Untouched').first();
const tmplKeepBefore = await db.documentTemplates.where('name').equals('Tmpl-Keep').first();

const mergeSummary = await mergeImportDatabase(baseImport({
  documents: [
    // (a) matches Alpha with OLDER timestamp -> must NOT overwrite
    { id: 991, title: 'Alpha', category: 'General', content: 'imported-alpha-old', updatedAt: T_OLD },
    // (b) matches Beta with NEWER timestamp -> must overwrite
    { id: 992, title: 'Beta', category: 'General', content: 'imported-beta-new', updatedAt: T_NEW },
    // (c) no local match -> must be created
    { id: 993, title: 'Gamma', category: 'General', content: 'imported-gamma', updatedAt: T_NEW },
    // same title as Alpha but different category -> distinct item, created
    { id: 994, title: 'Alpha', category: 'Ops', content: 'imported-alpha-ops', updatedAt: T_NEW },
    // (e) matches NoStamp, but local has no timestamp -> conservative skip
    { id: 995, title: 'NoStamp', category: 'General', content: 'imported-nostamp', updatedAt: T_NEW },
  ],
  documentTemplates: [
    { id: 981, name: 'Tmpl-Old', category: 'General', content: 'imported-tmpl-old', updatedAt: T_OLD },
    { id: 982, name: 'Tmpl-New', category: 'General', content: 'imported-tmpl-new', updatedAt: T_NEW },
    { id: 983, name: 'Tmpl-Created', category: 'General', content: 'imported-tmpl-created', updatedAt: T_NEW },
  ],
  workflows: [
    { id: 971, title: 'Flow', category: 'General', nodes: [{ n: 'imported' }], edges: [], updatedAt: T_NEW },
    { id: 972, title: 'Flow-2', category: 'General', nodes: [], edges: [], updatedAt: T_NEW },
  ],
  localStorage: {
    kanbanSortBy: 'imported-value',        // exists locally -> must NOT change
    taskInstancesSortBy: 'imported-only',  // absent locally -> must be set
  },
}));

// Documents
const docs = await db.documents.toArray();
const byTitleCat = (t, c) => docs.find(d => d.title === t && d.category === c);

check('older import does not overwrite (Alpha keeps local content)',
  byTitleCat('Alpha', 'General')?.content === 'local-alpha',
  JSON.stringify(byTitleCat('Alpha', 'General')));
check('older import does not bump local timestamp',
  byTitleCat('Alpha', 'General')?.updatedAt === T_LOCAL);
check('newer import overwrites (Beta gets imported content)',
  byTitleCat('Beta', 'General')?.content === 'imported-beta-new');
check('overwrite carries the imported timestamp',
  byTitleCat('Beta', 'General')?.updatedAt === T_NEW);
check('no-match import is created (Gamma exists)',
  byTitleCat('Gamma', 'General')?.content === 'imported-gamma');
check('same title in a different category is a distinct record (Alpha/Ops created)',
  byTitleCat('Alpha', 'Ops')?.content === 'imported-alpha-ops');
check('local record without a comparable timestamp is left untouched (NoStamp)',
  byTitleCat('NoStamp', 'General')?.content === 'local-nostamp');
check('nothing was deleted: doc count is 4 local + 2 created',
  docs.length === 6, `count=${docs.length}`);

const untouchedAfter = await db.documents.where('title').equals('Untouched').first();
check('non-matched local document survives byte-for-byte',
  JSON.stringify(untouchedAfter) === JSON.stringify(untouchedBefore));

// Alpha and NoStamp were seeded without a stableId (pre-v23 shape); the
// non-newer match keeps their content but completes the blank stableId, so
// they count as "filled", not "skipped".
check('merge summary for documents is {2 created, 1 updated, 2 filled, 0 skipped}',
  mergeSummary.documents.created === 2 &&
  mergeSummary.documents.updated === 1 &&
  mergeSummary.documents.filled === 2 &&
  mergeSummary.documents.skipped === 0,
  JSON.stringify(mergeSummary.documents));

// Document templates
const tmpls = await db.documentTemplates.toArray();
const tmplByName = (n) => tmpls.find(t => t.name === n && t.category === 'General');

check('older imported template does not overwrite',
  tmplByName('Tmpl-Old')?.content === 'local-tmpl-old');
check('newer imported template overwrites',
  tmplByName('Tmpl-New')?.content === 'imported-tmpl-new' &&
  tmplByName('Tmpl-New')?.updatedAt === T_NEW);
check('unmatched imported template is created',
  tmplByName('Tmpl-Created')?.content === 'imported-tmpl-created');
check('non-matched local template survives byte-for-byte',
  JSON.stringify(await db.documentTemplates.where('name').equals('Tmpl-Keep').first())
    === JSON.stringify(tmplKeepBefore));
check('template count is 3 local + 1 created', tmpls.length === 4, `count=${tmpls.length}`);

// Workflows (spot check of the same per-type plumbing)
const flows = await db.workflows.toArray();
check('newer imported workflow overwrites local by title+category',
  flows.find(w => w.title === 'Flow')?.nodes?.[0]?.n === 'imported');
check('unmatched imported workflow created, none deleted',
  flows.length === 2 && flows.some(w => w.title === 'Flow-2'));

// localStorage: merge only fills missing keys
check('merge does not clobber existing localStorage keys',
  lsStore.get('kanbanSortBy') === 'local-value');
check('merge adds localStorage keys that were absent',
  lsStore.get('taskInstancesSortBy') === 'imported-only');

/* ================================================================== */
console.log('\n--- merge mode: overwritten record keeps its Dexie id ---');
/* ================================================================== */
// Beta was overwritten in place: its id must be a small local
// auto-increment id, not the id 992 carried in the import file.
const beta = await db.documents.where('title').equals('Beta').first();
check('overwrite reuses the local id, never the imported id',
  beta && beta.id !== 992);

/* ================================================================== */
console.log('\n--- merge mode: stableId identity survives rename/recategorize ---');
/* ================================================================== */
// The motivating bug: a document renamed or moved to another category
// between export and merge no longer title+category-matches its local copy,
// so merge used to create a duplicate. With stableId as the primary match
// key the renamed/moved import must update the SAME document in place.
await db.documents.clear();
const SID_RENAMED = 'sid-renamed-0001';
const SID_KEPT = 'sid-kept-0002';
const SID_LOCAL_ONLY = 'sid-local-0003';
const SID_PRESERVE = 'sid-preserve-0005';
await db.documents.bulkAdd([
  // renamed AND recategorized by the import (same stableId, newer stamp)
  { stableId: SID_RENAMED, title: 'Old Name', category: 'General', content: 'local-body', locked: false, updatedAt: T_LOCAL },
  // same stableId but OLDER import -> untouched despite the import's rename
  { stableId: SID_KEPT, title: 'Stays', category: 'General', content: 'local-stays', locked: false, updatedAt: T_LOCAL },
  // legacy local without stableId; old-style import matches by title+category
  { title: 'Legacy Match', category: 'Ops', content: 'local-legacy', locked: false, updatedAt: T_LOCAL },
  // has a stableId; import shares title+category but carries a DIFFERENT
  // stableId -> provably distinct document, must not be cross-matched
  { stableId: SID_LOCAL_ONLY, title: 'Shared Name', category: 'General', content: 'local-shared', locked: false, updatedAt: T_LOCAL },
  // has a stableId; matched by an id-less old-style import -> the update
  // must preserve the local stableId
  { stableId: SID_PRESERVE, title: 'Keep Id', category: 'General', content: 'local-keepid', locked: false, updatedAt: T_LOCAL },
]);
const renamedBefore = (await db.documents.toArray()).find(d => d.stableId === SID_RENAMED);

const stablePayload = () => baseImport({
  documents: [
    // (1) rename + move, same stableId, newer -> update in place
    { id: 1, stableId: SID_RENAMED, title: 'New Name', category: 'Archive', content: 'imported-body', updatedAt: T_NEW },
    // (2) same stableId, older -> conservative skip
    { id: 2, stableId: SID_KEPT, title: 'Renamed Elsewhere', category: 'Other', content: 'imported-stays', updatedAt: T_OLD },
    // (3) old-style import (no stableId) matching a legacy local by title+category
    { id: 3, title: 'Legacy Match', category: 'Ops', content: 'imported-legacy', updatedAt: T_NEW },
    // (4) unknown stableId colliding on title+category with SID_LOCAL_ONLY
    { id: 4, stableId: 'sid-import-0004', title: 'Shared Name', category: 'General', content: 'imported-shared', updatedAt: T_NEW },
    // (5) old-style import (no stableId) matching a stableId-bearing local
    { id: 5, title: 'Keep Id', category: 'General', content: 'imported-keepid', updatedAt: T_NEW },
  ],
});

const stableSummary = await mergeImportDatabase(stablePayload());
const sdocs = await db.documents.toArray();
const bySid = (sid) => sdocs.filter(d => d.stableId === sid);

check('renamed+moved import updates the same document in place (no duplicate)',
  bySid(SID_RENAMED).length === 1 &&
  bySid(SID_RENAMED)[0].id === renamedBefore.id &&
  bySid(SID_RENAMED)[0].title === 'New Name' &&
  bySid(SID_RENAMED)[0].category === 'Archive' &&
  bySid(SID_RENAMED)[0].content === 'imported-body',
  JSON.stringify(bySid(SID_RENAMED)));
check('the old title is gone - not left behind as a stale copy',
  !sdocs.some(d => d.title === 'Old Name'));
check('older import with a matching stableId is skipped despite its rename',
  bySid(SID_KEPT).length === 1 && bySid(SID_KEPT)[0].title === 'Stays' &&
  bySid(SID_KEPT)[0].content === 'local-stays');
check('id-less import still matches a legacy local by title+category',
  sdocs.find(d => d.title === 'Legacy Match')?.content === 'imported-legacy');
check('updated legacy local was minted a stableId',
  typeof sdocs.find(d => d.title === 'Legacy Match')?.stableId === 'string' &&
  sdocs.find(d => d.title === 'Legacy Match')?.stableId.length > 0);
check('same title+category but different stableIds stay distinct documents',
  bySid(SID_LOCAL_ONLY).length === 1 &&
  bySid(SID_LOCAL_ONLY)[0].content === 'local-shared' &&
  bySid('sid-import-0004').length === 1 &&
  bySid('sid-import-0004')[0].content === 'imported-shared');
check('id-less import updating a stableId-bearing local preserves its stableId',
  bySid(SID_PRESERVE).length === 1 &&
  bySid(SID_PRESERVE)[0].content === 'imported-keepid');
check('stableId merge summary is {1 created, 3 updated, 1 skipped}',
  stableSummary.documents.created === 1 &&
  stableSummary.documents.updated === 3 &&
  stableSummary.documents.skipped === 1,
  JSON.stringify(stableSummary.documents));
check('document count is 5 local + 1 created', sdocs.length === 6, `count=${sdocs.length}`);

// Re-merging the same file must be a no-op (created docs kept their
// imported stableId, so every record now stable-matches and nothing is
// strictly newer).
const remergeSummary = await mergeImportDatabase(stablePayload());
check('re-merging the same file is idempotent (0 created, 0 updated)',
  remergeSummary.documents.created === 0 &&
  remergeSummary.documents.updated === 0 &&
  remergeSummary.documents.skipped === 5 &&
  (await db.documents.count()) === 6,
  JSON.stringify(remergeSummary.documents));

/* ================================================================== */
console.log('\n--- default (unchecked) path: full wipe + replace regression ---');
/* ================================================================== */
// The DB currently holds merged state (6 docs / 4 templates / 2 workflows).
// Running the default replace path must wipe everything and leave exactly
// the imported set. The two imported docs also prove createDocument's
// stableId handling - one carries an id (preserved: the export -> wipe ->
// re-import migration route), one does not (minted fresh).
await replaceImportDatabase(baseImport({
  documents: [
    { id: 1, title: 'Replaced-Doc', category: 'General', content: 'replaced', updatedAt: T_OLD, stableId: 'sid-replace-0009' },
    { id: 2, title: 'Replaced-Doc-2', category: 'General', content: 'replaced-2', updatedAt: T_OLD },
  ],
  documentTemplates: [
    { id: 1, name: 'Replaced-Tmpl', category: 'General', content: 'replaced-tmpl', updatedAt: T_OLD },
  ],
}));

const docsAfterReplace = await db.documents.toArray();
const tmplsAfterReplace = await db.documentTemplates.toArray();
const flowsAfterReplace = await db.workflows.toArray();

check('replace wipes all pre-existing documents and recreates the imported set',
  docsAfterReplace.length === 2 &&
  docsAfterReplace.some(d => d.title === 'Replaced-Doc') &&
  docsAfterReplace.some(d => d.title === 'Replaced-Doc-2'),
  `count=${docsAfterReplace.length}`);
check('replace-imported document keeps the stableId carried in the file',
  docsAfterReplace.find(d => d.title === 'Replaced-Doc')?.stableId === 'sid-replace-0009');
check('replace-imported document without a stableId is minted one',
  (() => {
    const sid = docsAfterReplace.find(d => d.title === 'Replaced-Doc-2')?.stableId;
    return typeof sid === 'string' && sid.length > 0;
  })());
check('replace wipes all pre-existing document templates',
  tmplsAfterReplace.length === 1 && tmplsAfterReplace[0].name === 'Replaced-Tmpl',
  `count=${tmplsAfterReplace.length}`);
check('replace wipes workflows not present in the import file',
  flowsAfterReplace.length === 0, `count=${flowsAfterReplace.length}`);

/* ================================================================== */
console.log('');
if (failures === 0) {
  console.log('ALL CHECKS PASSED');
  fs.rmSync(WORKDIR, { recursive: true, force: true });
  process.exit(0);
} else {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
