/**
 * Regression test for the "Keep existing data" (merge) import mode that
 * appeared to import nothing.
 *
 * Bug: merge mode only ever wrote a matched record when the imported copy
 * had a strictly NEWER timestamp - but every create* helper (createDocument,
 * createDocumentTemplate, ...) stamps updatedAt with the time of creation and
 * ignores the timestamp of the data it was given. A local database seeded by
 * the replace path (or by normal use) is therefore always "newer" than the
 * file it came from, so incomplete local records could never be completed.
 * Separately, merge-created rows were inserted verbatim: a row whose
 * updatedAt was missing/null was created but, because the app lists
 * documents via orderBy('updatedAt') and IndexedDB drops rows with a
 * non-key indexed value from the index, it never showed up in the UI.
 * Finally OpenShiftMasthead's import handler ignored the merge flag and ran
 * its own inline wipe+replace.
 *
 * Proved here against the REAL src/utils/importDatabase.js +
 * src/db/database.js + src/utils/documents.js on real Dexie over
 * fake-indexeddb (no mocks of the code under test):
 *
 *   1. a record present in the file but not locally is inserted - and is
 *      visible through getDocumentsMetadata() even when the file carries no
 *      usable updatedAt (missing or null);
 *   2. a matched local record whose fields are blank ('' / [] / absent) has
 *      exactly those fields completed from the import - even though the
 *      local record was created via createDocument and so carries a newer
 *      updatedAt than the file;
 *   3. non-blank local values (content, timestamps, stableId, position,
 *      false/0) are preserved on such a match;
 *   4. the documented "strictly newer import replaces the record" rule still
 *      holds;
 *   5. re-merging the same file is a no-op (nothing created/filled);
 *   6. the same fill-in semantics apply to the hand-rolled kanban board/card
 *      loops and to document categories (position kept);
 *   7. isBlank / missingFieldFills / mergeTotals unit behaviour.
 *
 * And, in jsdom against the REAL ImportDBModal:
 *   8. the "Keep existing data" checkbox is passed to onImport as the second
 *      argument (true when checked, false when not), and both hosts
 *      (CompactSidebar, OpenShiftMasthead) route that flag to
 *      mergeImportDatabase (source-level check).
 *
 * Fixture data is synthetic throughout.
 *
 * Run:  node tests/import-merge-fill-missing.test.mjs
 * Preconditions:
 *   - repo deps installed (esbuild, dexie, react):  npm install  -> exit 1 if missing
 *   - test-only deps (not in package.json):  npm install --no-save jsdom fake-indexeddb
 *     -> prints "SKIP:" and exits 0 if missing (tests/run-all.sh installs them)
 * Exit code 0 = all checks passed (or skipped), 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

// ---------- precondition checks ----------
function resolvable(name) {
  try { req.resolve(name); return true; } catch { return false; }
}
for (const dep of ['esbuild', 'dexie', 'react', 'react-dom']) {
  if (!resolvable(dep)) {
    console.error(`Missing dependency "${dep}". Run: npm install`);
    process.exit(1);
  }
}
for (const dep of ['fake-indexeddb', 'jsdom']) {
  if (!resolvable(dep)) {
    console.log(`SKIP: test-only dependency "${dep}" not installed (npm install --no-save jsdom fake-indexeddb)`);
    process.exit(0);
  }
}

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'import-merge-fill-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let total = 0;
function check(name, cond, detail = '') {
  total += 1;
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

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
await import(req.resolve('fake-indexeddb/auto'));

// ---------- bundle the real modules under test ----------
const { build } = await import(req.resolve('esbuild'));
const DB_ENTRY = path.join(WORKDIR, 'db-entry.mjs');
const DB_BUNDLE = path.join(WORKDIR, 'db-bundle.cjs');
fs.writeFileSync(DB_ENTRY, [
  `export * from ${JSON.stringify(path.join(REPO, 'src/utils/importDatabase.js'))};`,
  `export { db } from ${JSON.stringify(path.join(REPO, 'src/db/database.js'))};`,
  `export { createDocument, getDocumentsMetadata } from ${JSON.stringify(path.join(REPO, 'src/utils/documents.js'))};`,
  `export { createDocumentTemplate, getDocumentTemplates } from ${JSON.stringify(path.join(REPO, 'src/utils/documentTemplates.js'))};`,
].join('\n'));
await build({
  entryPoints: [DB_ENTRY],
  bundle: true,
  outfile: DB_BUNDLE,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const {
  mergeImportDatabase, runImport, mergeTotals, isBlank, missingFieldFills, db,
  createDocument, getDocumentsMetadata, createDocumentTemplate, getDocumentTemplates,
} = req(DB_BUNDLE);

// Quiet the create* helpers' progress logging so the check lines stay readable.
const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[')) return;
  realLog(...args);
};

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

const T_OLD = 1_000_000; // far older than anything createDocument stamps

/* ================================================================== */
console.log('\n--- unit: isBlank / missingFieldFills / mergeTotals ---');
/* ================================================================== */
check('null/undefined/""/"  "/[]/{} are blank',
  [null, undefined, '', '   ', [], {}].every(isBlank));
check('false, 0, "x", [1], {a:1}, Date, Blob-like are NOT blank',
  [false, 0, 'x', [1], { a: 1 }, new Date(), new Uint8Array(1)].every((v) => !isBlank(v)));
const fills = missingFieldFills(
  { id: 7, title: 'kept', content: '', tags: [], locked: false, count: 0, note: null },
  { id: 99, title: 'imported', content: 'body', tags: ['t'], locked: true, count: 5, note: 'n', extra: '', added: 'yes' },
);
check('fills only the blank local fields, never id / non-blank values / blank imports',
  JSON.stringify(fills) === JSON.stringify({ content: 'body', tags: ['t'], note: 'n', added: 'yes' }),
  JSON.stringify(fills));
check('mergeTotals sums every per-type counter',
  JSON.stringify(mergeTotals({
    a: { created: 1, updated: 2, filled: 3, skipped: 4, deleted: 0, invalid: 1 },
    b: { created: 1, updated: 0, skipped: 1, deleted: 7 },
  })) === JSON.stringify({ created: 2, updated: 2, filled: 3, skipped: 5, deleted: 7, invalid: 1 }));

/* ================================================================== */
console.log('\n--- merge: locally-created (newer) records get their blanks filled ---');
/* ================================================================== */
await db.documents.clear();
await db.documentTemplates.clear();

// Seed the way a replace-import (or the app itself) does: through the
// create* helpers, which stamp updatedAt = now regardless of input.
const incompleteId = await createDocument({ title: 'Runbook Partial', category: 'Ops', content: '' });
const completeId = await createDocument({ title: 'Runbook Complete', category: 'Ops', content: 'local body' });
// createDocumentTemplate returns the stored row (createDocument returns the id)
const partialTmplId = (await createDocumentTemplate({ name: 'Template Partial', category: 'Ops', content: 'local tmpl body', description: '', tags: [] })).id;

const incompleteBefore = await db.documents.get(incompleteId);
const completeBefore = await db.documents.get(completeId);
const partialTmplBefore = await db.documentTemplates.get(partialTmplId);
check('precondition: locally created records carry a fresh (newer than file) updatedAt',
  incompleteBefore.updatedAt > T_OLD && completeBefore.updatedAt > T_OLD && partialTmplBefore.updatedAt > T_OLD);

const importFile = () => baseImport({
  documents: [
    // matches Runbook Partial (old-style export, no stableId), OLDER stamp,
    // has the content the local copy lacks
    { id: 501, title: 'Runbook Partial', category: 'Ops', content: 'imported body', locked: false, updatedAt: T_OLD },
    // matches Runbook Complete, OLDER stamp, different content -> must lose
    { id: 502, title: 'Runbook Complete', category: 'Ops', content: 'imported other body', updatedAt: T_OLD },
    // not local; NO updatedAt at all
    { id: 503, title: 'Runbook New', category: 'Ops', content: 'new body' },
    // not local; updatedAt null (not a valid IndexedDB key)
    { id: 504, title: 'Runbook Null Stamp', category: 'Ops', content: 'null stamp body', updatedAt: null },
  ],
  documentTemplates: [
    { id: 601, name: 'Template Partial', category: 'Ops', content: 'imported tmpl body', description: 'imported desc', tags: ['ops'], updatedAt: T_OLD },
    { id: 602, name: 'Template New', category: 'Ops', content: 'new tmpl body' },
  ],
});

const summary = await mergeImportDatabase(importFile());

const incompleteAfter = await db.documents.get(incompleteId);
const completeAfter = await db.documents.get(completeId);
check('blank content of the matched local record is filled from the (older) import',
  incompleteAfter.content === 'imported body', JSON.stringify(incompleteAfter));
check('filling keeps the local updatedAt, stableId and id',
  incompleteAfter.updatedAt === incompleteBefore.updatedAt &&
  incompleteAfter.stableId === incompleteBefore.stableId &&
  incompleteAfter.id === incompleteId);
check('non-blank local content is preserved against an older import',
  completeAfter.content === 'local body' && completeAfter.updatedAt === completeBefore.updatedAt);
check('complete local record is byte-for-byte untouched',
  JSON.stringify(completeAfter) === JSON.stringify(completeBefore));

const visibleDocs = await getDocumentsMetadata(); // orderBy('updatedAt') - the app's listing
const newDoc = visibleDocs.find((d) => d.title === 'Runbook New');
const nullStampDoc = visibleDocs.find((d) => d.title === 'Runbook Null Stamp');
check('record absent locally is inserted and LISTED by the app (no updatedAt in file)',
  !!newDoc, JSON.stringify(visibleDocs.map((d) => d.title)));
check('record absent locally is inserted and LISTED by the app (updatedAt: null in file)',
  !!nullStampDoc);
check('inserted records got an indexable updatedAt, a stableId and createDocument-style defaults',
  typeof newDoc?.updatedAt === 'number' && typeof newDoc?.stableId === 'string' && newDoc.locked === false &&
  typeof nullStampDoc?.updatedAt === 'number' && (await db.documents.get(newDoc.id)).content === 'new body');
check('nothing deleted: 2 local + 2 created', (await db.documents.count()) === 4);
check('documents summary is {2 created, 0 updated, 1 filled, 1 skipped}',
  summary.documents.created === 2 && summary.documents.updated === 0 &&
  summary.documents.filled === 1 && summary.documents.skipped === 1,
  JSON.stringify(summary.documents));

const partialTmplAfter = await db.documentTemplates.get(partialTmplId);
check('template: blank description and empty tags filled, non-blank content kept',
  partialTmplAfter.description === 'imported desc' &&
  JSON.stringify(partialTmplAfter.tags) === JSON.stringify(['ops']) &&
  partialTmplAfter.content === 'local tmpl body' &&
  partialTmplAfter.updatedAt === partialTmplBefore.updatedAt,
  JSON.stringify(partialTmplAfter));
const listedTmpls = await getDocumentTemplates();
const newTmpl = listedTmpls.find((t) => t.name === 'Template New');
check('template absent locally is inserted, listed, with tags/description defaults and an updatedAt',
  !!newTmpl && Array.isArray(newTmpl.tags) && newTmpl.description === '' && typeof newTmpl.updatedAt === 'number',
  JSON.stringify(newTmpl));
check('templates summary is {1 created, 0 updated, 1 filled, 0 skipped}',
  summary.documentTemplates.created === 1 && summary.documentTemplates.filled === 1 &&
  summary.documentTemplates.updated === 0 && summary.documentTemplates.skipped === 0,
  JSON.stringify(summary.documentTemplates));

/* ================================================================== */
console.log('\n--- merge: re-merging the same file is a no-op ---');
/* ================================================================== */
const again = await mergeImportDatabase(importFile());
check('second merge creates/fills nothing (documents)',
  again.documents.created === 0 && again.documents.filled === 0 && again.documents.updated === 0,
  JSON.stringify(again.documents));
check('second merge creates/fills nothing (templates)',
  again.documentTemplates.created === 0 && again.documentTemplates.filled === 0,
  JSON.stringify(again.documentTemplates));
check('document count unchanged after re-merge', (await db.documents.count()) === 4);

/* ================================================================== */
console.log('\n--- merge: a strictly newer import still replaces the record ---');
/* ================================================================== */
const T_FUTURE = Date.now() + 10 * 60 * 1000;
const newer = await mergeImportDatabase(baseImport({
  documents: [
    { id: 502, title: 'Runbook Complete', category: 'Ops', content: 'newer body', updatedAt: T_FUTURE },
  ],
}));
const replaced = await db.documents.get(completeId);
check('newer import overwrites content and carries its timestamp',
  replaced.content === 'newer body' && replaced.updatedAt === T_FUTURE && newer.documents.updated === 1,
  JSON.stringify(newer.documents));
check('overwrite keeps the local id and stableId',
  replaced.id === completeId && replaced.stableId === completeBefore.stableId);

/* ================================================================== */
console.log('\n--- merge: kanban boards/cards and categories fill blanks too ---');
/* ================================================================== */
await db.kanbanBoards.clear();
await db.kanbanCards.clear();
await db.documentCategories.clear();

const nowDate = new Date();
const boardId = await db.kanbanBoards.add({ title: 'Board One', category: 'General', description: '', createdAt: nowDate, updatedAt: nowDate });
const cardId = await db.kanbanCards.add({ boardId, yjsId: 'card-yjs-0001', title: 'Card One', description: '', status: 'todo', position: 0, createdAt: nowDate, updatedAt: nowDate });
const catId = await db.documentCategories.add({ name: 'Ops', position: 3, createdAt: Date.now(), updatedAt: Date.now() });

const kanbanSummary = await mergeImportDatabase(baseImport({
  kanbanBoards: [
    { id: 41, title: 'Board One', category: 'General', description: 'imported board desc', createdAt: T_OLD, updatedAt: T_OLD },
  ],
  kanbanCards: [
    { id: 71, boardId: 41, yjsId: 'card-yjs-0001', title: 'Card One (renamed in file)', description: 'imported card desc', status: 'done', position: 5, createdAt: T_OLD, updatedAt: T_OLD },
    { id: 72, boardId: 41, yjsId: 'card-yjs-0002', title: 'Card Two', status: 'todo', position: 1 },
  ],
  documentCategories: [
    { id: 11, name: 'Ops', icon: 'server', position: 0, createdAt: T_OLD, updatedAt: T_OLD },
  ],
}));

const boardAfter = await db.kanbanBoards.get(boardId);
const cardAfter = await db.kanbanCards.get(cardId);
const cards = await db.kanbanCards.toArray();
const catAfter = await db.documentCategories.get(catId);
check('board: blank description filled, timestamps kept',
  boardAfter.description === 'imported board desc' && boardAfter.updatedAt === nowDate.getTime() || boardAfter.updatedAt?.getTime?.() === nowDate.getTime(),
  JSON.stringify(boardAfter));
check('card: blank description filled; title/status/position kept',
  cardAfter.description === 'imported card desc' && cardAfter.title === 'Card One' &&
  cardAfter.status === 'todo' && cardAfter.position === 0,
  JSON.stringify(cardAfter));
check('new card inserted on the LOCAL board id with a createdAt/updatedAt',
  cards.length === 2 && cards.find((c) => c.yjsId === 'card-yjs-0002')?.boardId === boardId &&
  cards.find((c) => c.yjsId === 'card-yjs-0002')?.updatedAt != null,
  JSON.stringify(cards));
check('category: blank icon filled, local position kept',
  catAfter.icon === 'server' && catAfter.position === 3 && (await db.documentCategories.count()) === 1,
  JSON.stringify(catAfter));
check('kanban/category summaries report the fills',
  kanbanSummary.kanbanBoards.filled === 1 && kanbanSummary.kanbanCards.filled === 1 &&
  kanbanSummary.kanbanCards.created === 1 && kanbanSummary.documentCategories.filled === 1,
  JSON.stringify({ b: kanbanSummary.kanbanBoards, c: kanbanSummary.kanbanCards, cat: kanbanSummary.documentCategories }));

/* ================================================================== */
console.log('\n--- dry run: same code, same stats, zero writes (merge mode) ---');
/* ================================================================== */
// Snapshot every table the merge touches plus localStorage, dry-run a file
// that exercises create / fill / skip / invalid, prove nothing moved, then
// run it for real and prove the real summary is identical to the plan.
const TABLES = ['documents', 'documentTemplates', 'documentCategories', 'kanbanBoards', 'kanbanCards',
  'workflows', 'templates', 'engineTemplates', 'sshCommands', 'media', 'tasks'];
const snapshot = async () => {
  const out = {};
  for (const t of TABLES) out[t] = await db[t].toArray();
  out.__ls = Array.from(lsStore.entries());
  return JSON.stringify(out);
};
// Strip nothing: the summaries carry only counts, labels and reasons - no
// ids - so plan and real run must be byte-identical.
const dryRunFile = () => baseImport({
  documents: [
    { id: 1, title: 'Runbook Partial', category: 'Ops', content: 'x', updatedAt: T_OLD },     // complete now -> skipped
    { id: 2, title: 'Runbook Dry New', category: 'Ops', content: 'dry body' },                 // created
    'not-a-record',                                                                              // invalid
  ],
  documentTemplates: [
    { id: 3, name: 'Template Dry New', category: 'Ops', content: 'y' },                        // created
  ],
  sshCommands: [
    { id: 4, name: 'list-pods', command: 'kubectl get pods', description: '' },               // created
  ],
  kanbanBoards: [
    { id: 41, title: 'Board One', category: 'General', description: 'imported board desc', updatedAt: T_OLD }, // skipped
  ],
  kanbanCards: [
    { id: 73, boardId: 999, yjsId: 'card-yjs-0003', title: 'Orphan Card', status: 'todo' },   // invalid: board missing
    { id: 74, boardId: 41, yjsId: 'card-yjs-0004', title: 'Card Four', status: 'todo', position: 2 }, // created
  ],
  media: [
    { id: 5, filename: 'diagram.png', uploadedAt: T_OLD },                                    // invalid: no data
  ],
  localStorage: { kanbanSortBy: 'imported-value', neverSetBefore: 'v' },                      // 1 skipped, 1 created
});

lsStore.set('kanbanSortBy', 'local-value'); // exists locally -> merge must leave it alone
const before = await snapshot();
const plan = await runImport(dryRunFile(), true, { dryRun: true });
const afterDry = await snapshot();
check('dry run: reports mode/dryRun flags', plan.mode === 'merge' && plan.dryRun === true);
check('dry run: NOTHING was written (all tables + localStorage identical)', before === afterDry);
check('dry run: plan counts documents {1 created, 0 updated, 0 filled, 1 skipped, 1 invalid}',
  plan.summary.documents.created === 1 && plan.summary.documents.filled === 0 &&
  plan.summary.documents.skipped === 1 && plan.summary.documents.invalid === 1 &&
  plan.summary.documents.errors[0]?.reason === 'not a record object',
  JSON.stringify(plan.summary.documents));
check('dry run: invalid kanban card names its missing board; media without data is invalid with a reason',
  plan.summary.kanbanCards.invalid === 1 && plan.summary.kanbanCards.created === 1 &&
  /board \(id 999\) is not in the import file/.test(plan.summary.kanbanCards.errors[0]?.reason) &&
  plan.summary.kanbanCards.errors[0]?.label === 'Orphan Card' &&
  plan.summary.media.invalid === 1 && /base64/.test(plan.summary.media.errors[0]?.reason),
  JSON.stringify({ c: plan.summary.kanbanCards, m: plan.summary.media }));
check('dry run: samples list the identifiers of affected records',
  plan.summary.documents.samples.created.includes('Runbook Dry New / Ops') &&
  plan.summary.sshCommands.samples.created.includes('list-pods'),
  JSON.stringify(plan.summary.documents.samples));
check('dry run: localStorage plan is {1 created, 1 skipped} and nothing was set',
  plan.summary.localStorage.created === 1 && plan.summary.localStorage.skipped === 1 &&
  !lsStore.has('neverSetBefore'));
check('dry run: totals roll the plan up',
  plan.totals.created === 5 && plan.totals.invalid === 3 && plan.totals.skipped === 3,
  JSON.stringify(plan.totals));

const real = await runImport(dryRunFile(), true, { dryRun: false });
const afterReal = await snapshot();
check('real run: summary is byte-identical to the dry-run plan',
  JSON.stringify(real.summary) === JSON.stringify(plan.summary) &&
  JSON.stringify(real.totals) === JSON.stringify(plan.totals),
  JSON.stringify({ plan: plan.totals, real: real.totals }));
check('real run: actually wrote (state changed, +1 doc, +1 template, +1 ssh command, +1 card, +1 ls key)',
  afterReal !== before &&
  (await db.documents.count()) === 5 && (await db.documentTemplates.count()) === 3 &&
  (await db.sshCommands.count()) === 1 && (await db.kanbanCards.count()) === 3 &&
  lsStore.get('neverSetBefore') === 'v' && lsStore.get('kanbanSortBy') !== 'imported-value');
check('real run: invalid records were not written (no orphan card, no media row)',
  !(await db.kanbanCards.toArray()).some((c) => c.title === 'Orphan Card') && (await db.media.count()) === 0);

/* ================================================================== */
console.log('\n--- dry run: replace mode plan equals what replace then does ---');
/* ================================================================== */
const replaceFile = () => baseImport({
  documents: [
    { id: 1, title: 'Only Doc', category: 'Ops', content: 'only', updatedAt: T_OLD },
  ],
  kanbanBoards: [{ id: 9, title: 'Fresh Board', category: 'General' }],
  kanbanCards: [
    { id: 90, boardId: 9, yjsId: 'card-yjs-0090', title: 'Fresh Card', status: 'todo', position: 0 },
    { id: 91, boardId: 8, yjsId: 'card-yjs-0091', title: 'Lost Card', status: 'todo', position: 0 },
  ],
});
const beforeReplacePlan = await snapshot();
const docCountBefore = await db.documents.count();
const replacePlanResult = await runImport(replaceFile(), false, { dryRun: true });
check('replace dry run: mode/dryRun flags and nothing written',
  replacePlanResult.mode === 'replace' && replacePlanResult.dryRun === true &&
  (await snapshot()) === beforeReplacePlan);
check('replace dry run: would delete every existing document and create the file\'s',
  replacePlanResult.summary.documents.deleted === docCountBefore &&
  replacePlanResult.summary.documents.created === 1 &&
  replacePlanResult.summary.kanbanCards.created === 1 && replacePlanResult.summary.kanbanCards.invalid === 1,
  JSON.stringify({ d: replacePlanResult.summary.documents, c: replacePlanResult.summary.kanbanCards }));
const replaceReal = await runImport(replaceFile(), false, { dryRun: false });
check('replace real run: summary identical to the plan',
  JSON.stringify(replaceReal.summary) === JSON.stringify(replacePlanResult.summary),
  JSON.stringify({ plan: replacePlanResult.totals, real: replaceReal.totals }));
check('replace real run: database now holds exactly the file\'s records',
  (await db.documents.count()) === 1 && (await db.documentTemplates.count()) === 0 &&
  (await db.kanbanBoards.count()) === 1 && (await db.kanbanCards.count()) === 1 &&
  (await db.sshCommands.count()) === 0);

/* ================================================================== */
console.log('\n--- UI: the "Keep existing data" checkbox maps to merge mode; Dry Run ---');
/* ================================================================== */
const UI_ENTRY = path.join(WORKDIR, 'ui-entry.jsx');
const UI_BUNDLE = path.join(WORKDIR, 'ui-bundle.cjs');
fs.writeFileSync(UI_ENTRY, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ImportDBModal from '@worktree/src/components/common/modals/ImportDBModal.jsx';

window.__imports = [];
window.__dryRuns = [];
// Hosts return runImport()'s result; the modal renders it.
const fakeResult = (mode, dryRun) => ({
  mode, dryRun,
  summary: {
    documents: { created: 1, updated: 0, filled: 2, skipped: 3, deleted: 0, invalid: 1,
      errors: [{ label: 'Broken Row', reason: 'not a record object' }],
      samples: { created: ['Runbook UI / Ops'], updated: [], filled: ['Runbook Partial / Ops'] } },
  },
  totals: { created: 1, updated: 0, filled: 2, skipped: 3, deleted: 0, invalid: 1 },
});
const root = createRoot(document.getElementById('root'));
// A new key remounts the modal with fresh state (file, checkbox, results).
window.__remount = (key) => root.render(
  <ImportDBModal
    key={key}
    isOpen={true}
    onClose={() => {}}
    onImport={async (data, mergeMode) => { window.__imports.push([data, mergeMode]); return fakeResult(mergeMode ? 'merge' : 'replace', false); }}
    onDryRun={async (data, mergeMode) => { window.__dryRuns.push([data, mergeMode]); return fakeResult(mergeMode ? 'merge' : 'replace', true); }}
  />
);
window.__remount(1);
`);
await build({
  entryPoints: [UI_ENTRY],
  bundle: true,
  outfile: UI_BUNDLE,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
  nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{
    name: 'alias',
    setup(b) {
      b.onResolve({ filter: /^@worktree\// }, (args) => ({
        path: path.join(REPO, args.path.replace(/^@worktree\//, '')),
      }));
      b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => {
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        try { return { path: req.resolve(args.path) }; } catch { return null; }
      });
    },
  }],
  logLevel: 'silent',
});

const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node',
  'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'File', 'FileReader']) {
  define(name, window[name]);
}
define('getComputedStyle', window.getComputedStyle.bind(window));
define('localStorage', window.localStorage);
define('sessionStorage', window.sessionStorage);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));

createRequire(import.meta.url)(UI_BUNDLE);
await sleep(100);

const doc = window.document;
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const buttonByText = (text) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

// Feed the modal a synthetic export file through its hidden <input type=file>.
const fileInput = doc.querySelector('input[type="file"]');
check('modal renders its file input', !!fileInput);
const payload = baseImport({ documents: [{ id: 1, title: 'Runbook UI', category: 'Ops', content: 'x', updatedAt: T_OLD }] });
const file = new window.File([JSON.stringify(payload)], 'export.json', { type: 'application/json' });
Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(150); // FileReader.onload + re-render

const checkbox = doc.querySelector('input[type="checkbox"]');
const importBtn = buttonByText('Import Database');
const dryRunBtn = buttonByText('Dry Run');
const stats = () => doc.querySelector('[data-testid="import-stats"]');
check('file parsed: preview shows 1 document and the merge checkbox appears',
  doc.body.textContent.includes('1 documents') && !!checkbox && !!importBtn && !importBtn.disabled);
check('a Dry Run button sits beside Import Database in the footer, enabled',
  !!dryRunBtn && !dryRunBtn.disabled && dryRunBtn.parentElement === importBtn.parentElement);
check('merge checkbox is labelled as the keep-existing option and is off by default',
  checkbox && !checkbox.checked && checkbox.closest('label')?.textContent.includes('Keep existing data'));
check('no statistics shown before any run', !stats());

click(checkbox);
await sleep(30);
check('clicking the checkbox turns it on and shows the Merge Mode notice',
  checkbox.checked && doc.body.textContent.includes('Merge Mode'));

// Dry run first: uses the selected mode, shows stats, does NOT import.
click(dryRunBtn);
await sleep(60);
check('Dry Run -> onDryRun(data, true) with the SAME selected mode, and no onImport call',
  window.__dryRuns.length === 1 && window.__dryRuns[0][1] === true &&
  window.__dryRuns[0][0]?.documents?.[0]?.title === 'Runbook UI' && window.__imports.length === 0,
  JSON.stringify({ dry: window.__dryRuns.map((i) => i[1]), imports: window.__imports.length }));
check('dry-run statistics panel renders per-type counts, samples and invalid reasons',
  !!stats() && stats().textContent.includes('nothing was written') &&
  stats().textContent.includes('Documents') && stats().textContent.includes('Runbook UI / Ops') &&
  stats().textContent.includes('Broken Row') && stats().textContent.includes('not a record object') &&
  /1 would be added, 0 would be replaced by newer copies, 2 would be completed/.test(stats().textContent),
  stats()?.textContent);
check('after a dry run the user still has to click Import (button enabled, no auto-import)',
  !buttonByText('Import Database').disabled && window.__imports.length === 0);

// Now the real import in merge mode.
click(buttonByText('Import Database'));
await sleep(60);
check('checked -> onImport(data, true) (merge mode)',
  window.__imports.length === 1 && window.__imports[0][1] === true,
  JSON.stringify(window.__imports.map((i) => i[1])));
check('after the real import the same statistics panel shows "Import complete" and a Reload App button',
  !!stats() && stats().textContent.includes('Import complete') && !!buttonByText('Reload App') &&
  !buttonByText('Import Database') && !buttonByText('Dry Run'),
  stats()?.textContent);

// Fresh modal instance for the unchecked (replace) path.
window.__imports.length = 0;
window.__dryRuns.length = 0;
window.__remount(2);
await sleep(50);
const fileInput2 = doc.querySelector('input[type="file"]');
check('remounted modal starts clean (file input back, no stats)', !!fileInput2 && !stats());
Object.defineProperty(fileInput2, 'files', { value: [file], configurable: true });
fileInput2.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(150);
check('replace path: checkbox off, Warning notice shown',
  !doc.querySelector('input[type="checkbox"]').checked && doc.body.textContent.includes('replace all existing data'));
click(buttonByText('Dry Run'));
await sleep(60);
check('unchecked Dry Run -> onDryRun(data, false); replace-mode stats say what would be deleted/created',
  window.__dryRuns.length === 1 && window.__dryRuns[0][1] === false &&
  !!stats() && stats().textContent.includes('Dry run (replace mode)') &&
  /existing records would be deleted/.test(stats().textContent) && window.__imports.length === 0,
  stats()?.textContent);
click(buttonByText('Import Database'));
await sleep(60);
check('unchecked -> onImport(data, false) (replace mode)',
  window.__imports.length === 1 && window.__imports[0][1] === false &&
  window.__imports[0][0]?.documents?.[0]?.title === 'Runbook UI',
  JSON.stringify(window.__imports.map((i) => i[1])));

// Both hosts must hand the mode flag (and the dry-run request) to runImport
// in ../utils/importDatabase - not to an inline wipe (the OpenShiftMasthead
// handler used to ignore the flag entirely).
for (const host of ['src/components/CompactSidebar.jsx', 'src/components/OpenShiftMasthead.jsx']) {
  const src = fs.readFileSync(path.join(REPO, host), 'utf8');
  const handler = src.slice(src.indexOf('async function runDatabaseImport('));
  check(`${path.basename(host)}: import + dry run both route through runImport(importData, mergeMode, { dryRun })`,
    /runImport\(importData,\s*mergeMode,\s*\{\s*dryRun\s*\}\)/.test(handler) &&
    /handleConfirmImport\(importData,\s*mergeMode[^)]*\)\s*\{\s*return runDatabaseImport\(importData,\s*mergeMode,\s*false\)/.test(handler) &&
    /handleDryRunImport\(importData,\s*mergeMode[^)]*\)\s*\{\s*return runDatabaseImport\(importData,\s*mergeMode,\s*true\)/.test(handler) &&
    /onImport=\{handleConfirmImport\}/.test(src) && /onDryRun=\{handleDryRunImport\}/.test(src) &&
    !/deleteDocument\(/.test(handler));
}

/* ================================================================== */
console.log('');
console.log = realLog;
fs.rmSync(WORKDIR, { recursive: true, force: true });
if (failures === 0) {
  console.log(`ALL ${total} CHECKS PASSED`);
  process.exit(0);
} else {
  console.log(`${failures}/${total} CHECK(S) FAILED`);
  process.exit(1);
}
