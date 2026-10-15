/**
 * Merge mode ("Keep existing documents and merge newer copies") of the
 * Documents "Import from JSON / Base64" (src/utils/documentImport.js
 * runDocumentsImport({ mergeMode }), the shared MergeModeOption checkbox),
 * against the REAL modules in jsdom over fake-indexeddb. Synthetic data
 * only (1x1 PNGs built here).
 *
 * THE RULES (mirroring src/utils/importDatabase.js merge):
 *   - match by stableId when the file item and a local document both carry
 *     one; else by title + category (trimmed, create defaults) - but never
 *     to a local document that has a DIFFERENT stableId;
 *   - matched + identical title/content/category -> unchanged;
 *   - matched + file updatedAt strictly newer -> replaced (title, content,
 *     category, locked; local id/stableId/cloud fields kept);
 *   - matched otherwise -> only blank local fields filled in (local edits
 *     kept);
 *   - matched + local locked -> left untouched (skipped, counted in locked);
 *   - unmatched -> created, KEEPING the file's stableId so a re-import
 *     matches it (merge off still mints a fresh one);
 *   - images: identical reused, conflicting names renamed, as always.
 *
 * What this proves:
 *   1. Merge off is unchanged: every item created with a fresh stableId.
 *   2. Each rule above, with the stats (Documents + per-category rows:
 *      created / updated / filled / skipped(unchanged) / invalid; locked
 *      note; images added/reused/renamed) and the log lines.
 *   3. The dry run honours the checkbox, writes nothing (byte-identical
 *      snapshots) and equals the real run; re-importing the same file ->
 *      every document unchanged, no media duplicated.
 *   4. Merge-created documents keep the file's stableId; the database merge
 *      importer then matches them by that id (no duplicate rows).
 *   5. UI: the checkbox (shared with ImportDBModal, same label pattern,
 *      unchecked by default, hint changes with the state) in the JSON input
 *      modal and the Base64 modal; toggling clears stale stats; a merge dry
 *      run / import shows the merge wording and columns.
 *
 * Run:  node tests/documents-import-merge.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import zlib from 'node:zlib';
import { setupDocumentsEnv, makeChecker, byText, click, waitFor, typeInto, sleep } from './helpers/jsdom-documents-env.mjs';

const { check, summary } = makeChecker();
const { mod, window } = await setupDocumentsEnv('documents-import-merge');
const { documents, documentImport, importDatabase, db, renderSidebar, unmountSidebar } = mod;
const { createDocument, getDocuments, getDocumentsMetadata, getCategories } = documents;
const { runDocumentsImport, describeDocumentsImport } = documentImport;

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function png([r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b]))), chunk('IEND', Buffer.alloc(0))]);
}
const RED = png([255, 0, 0]);
const GREEN = png([0, 255, 0]);
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const entry = (filename, buf) => ({ filename, mimeType: 'image/png', size: buf.length, uploadedAt: '2026-01-02T03:04:05.000Z', tags: [], data: dataUrl(buf) });
async function addMedia(filename, buf) {
  return db.media.add({ filename, blob: new Blob([buf], { type: 'image/png' }), mimeType: 'image/png', size: buf.length, tags: [], uploadedAt: '2026-01-02T03:04:05.000Z' });
}
async function resetTables() {
  await db.documents.clear();
  await db.documentCategories.clear();
  await db.media.clear();
}
async function snapshot() {
  const media = [];
  for (const m of await db.media.toArray()) media.push({ ...m, blob: Buffer.from(await m.blob.arrayBuffer()).toString('base64') });
  const ls = {};
  for (let i = 0; i < window.localStorage.length; i++) { const k = window.localStorage.key(i); ls[k] = window.localStorage.getItem(k); }
  return JSON.stringify({ documents: await db.documents.toArray(), categories: await db.documentCategories.toArray(), media, ls });
}
const stripRun = (r) => JSON.stringify({ summary: r.summary, totals: r.totals });
const byTitle = (rows, t) => rows.find((d) => d.title === t);

const SID = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OLD = 1700000000000;
const NEWER = 1800000000000;

/** Local state: six documents covering every rule, plus a colliding image. */
async function seed() {
  await resetTables();
  await addMedia('red.png', GREEN); // a different local image owning the name
  const put = async (doc) => { const id = await createDocument(doc); await db.documents.update(id, { updatedAt: doc.updatedAt ?? OLD }); return id; };
  await put({ title: 'By stable id', content: 'local text', category: 'Notes', stableId: SID(1), updatedAt: OLD });        // renamed in the file -> stableId match, newer -> replaced
  await put({ title: 'Same name', content: 'identical body', category: 'Notes', updatedAt: OLD });                         // title+category match, identical -> unchanged
  await put({ title: 'Blank here', content: '', category: 'Notes', updatedAt: NEWER });                                     // match, local newer but content blank -> filled
  await put({ title: 'Locked one', content: 'locked body', category: 'Notes', locked: true, updatedAt: OLD });              // match, locked -> skipped
  await put({ title: 'Shared name', content: 'local distinct', category: 'Notes', stableId: SID(9), updatedAt: OLD });      // same name, DIFFERENT stableId -> created as new
  await put({ title: 'Cloud doc', content: 'cloud body', category: 'Notes', stableId: SID(3), updatedAt: OLD, inCloud: true, ownerId: 'machine-synthetic', cloudDocumentId: 'room-synthetic' }); // newer file -> replaced text, cloud fields kept
}
const FILE = [
  { title: 'Renamed in file', content: 'file text (newer)', category: 'Runbooks', stableId: SID(1), updatedAt: NEWER, media: [entry('red.png', RED)] },
  { title: '  Same name ', content: 'identical body', category: 'Notes', updatedAt: NEWER },
  { title: 'Blank here', content: 'now filled from the file', category: 'Notes', updatedAt: OLD },
  { title: 'Locked one', content: 'should not land', category: 'Notes', updatedAt: NEWER },
  { title: 'Shared name', content: 'file distinct', category: 'Notes', stableId: SID(2), updatedAt: NEWER },
  { title: 'Cloud doc', content: 'cloud body from file', category: 'Notes', stableId: SID(3), updatedAt: NEWER, locked: false },
  { title: 'Brand new', content: 'new', category: 'Runbooks', stableId: SID(4), updatedAt: OLD },
];

/* ================================================================== */
console.log('\n--- 1. merge off: unchanged behaviour ---');
/* ================================================================== */
await seed();
{
  const r = await runDocumentsImport(FILE, { mergeMode: false });
  const rows = await getDocuments();
  check('merge off creates every item as a new document (6 + 7)', r.mergeMode === false && r.summary.documents.created === 7 && rows.length === 13);
  check('merge off mints fresh stableIds (the file\'s ids are not reused)', !rows.some((d) => d.stableId === SID(2) || d.stableId === SID(4)) && rows.filter((d) => d.stableId === SID(1)).length === 1);
  check('merge off still reports the same-title note (exact titles: 4; the padded "  Same name " does not count)', r.summary.documents.sameTitle === 4 && /same title as an existing document/.test(r.summary.documents.note), r.summary.documents.note);
}

/* ================================================================== */
console.log('\n--- 2. merge on: every rule, dry run == real run, nothing written ---');
/* ================================================================== */
await seed();
let dry;
{
  const before = await snapshot();
  const logs = [];
  dry = await runDocumentsImport(FILE, { mergeMode: true, dryRun: true, onProgress: (u) => { if (u.log) logs.push(u.log); } });
  check('the merge dry run writes nothing', (await snapshot()) === before);
  check('the dry run reports mergeMode: true', dry.mergeMode === true && dry.dryRun === true);
  const s = dry.summary.documents;
  check('documents: 2 created (Shared name twin, Brand new), 2 replaced (By stable id, Cloud doc), 1 completed (Blank here), 2 unchanged (Same name, Locked one)', s.created === 2 && s.updated === 2 && s.filled === 1 && s.skipped === 2 && s.invalid === 0, JSON.stringify({ c: s.created, u: s.updated, f: s.filled, s: s.skipped, i: s.invalid }));
  check('samples name the right documents', s.samples.created.join() === 'Shared name,Brand new' && s.samples.updated.join() === 'Renamed in file,Cloud doc' && s.samples.filled.join() === 'Blank here', JSON.stringify(s.samples));
  check('locked: 1, noted', s.locked === 1 && /1 locked document left untouched: Locked one/.test(s.note), s.note);
  check('no same-title note in merge mode (matches are the real outcome)', s.sameTitle === 0 && !/same title/.test(s.note || ''));
  check('category rows carry the outcomes: Notes 1 new / 1 replaced / 1 completed / 2 unchanged, Runbooks (new) 1 new / 1 replaced', dry.summary['category:Notes'].created === 1 && dry.summary['category:Notes'].updated === 1 && dry.summary['category:Notes'].filled === 1 && dry.summary['category:Notes'].skipped === 2 && dry.summary['category:Runbooks'].created === 1 && dry.summary['category:Runbooks'].updated === 1 && dry.summary['category:Runbooks'].isNew === true, JSON.stringify(Object.keys(dry.summary)));
  check('images: the colliding red.png would be stored as red-2.png (links of "Renamed in file" updated)', dry.summary.images.created === 1 && dry.summary.images.renamed[0].to === 'red-2.png' && dry.summary.images.renamed[0].document === 'Renamed in file');
  check('totals count documents once: created 2+1 image, updated 2, filled 1, skipped 2', dry.totals.created === 3 && dry.totals.updated === 2 && dry.totals.filled === 1 && dry.totals.skipped === 2, JSON.stringify(dry.totals));
  check('log lines name the outcomes', logs.some((l) => /Would replace \(file is newer\) "Renamed in file"/.test(l)) && logs.some((l) => /Would fill in empty fields of "Blank here"/.test(l)) && logs.some((l) => /Unchanged \(already here\) "\s*Same name\s*"/.test(l)) && logs.some((l) => /"Locked one" matches a locked document - left untouched/.test(l)) && logs.some((l) => /Would import "Brand new"/.test(l)), JSON.stringify(logs));
  const text = describeDocumentsImport({ kind: 'dry-run', ...dry });
  check('merge wording', text.title === 'Dry run (merge into existing documents) - nothing was written' && text.headline === '2 documents would be added, 2 would be replaced by newer copies, 1 would be completed (empty fields filled in), 2 unchanged in 2 categories (1 new category); 1 locked (left untouched); 1 image would be added, 1 renamed', text.headline);

  const real = await runDocumentsImport(FILE, { mergeMode: true });
  check('the real merge run equals the dry run', stripRun(real) === stripRun(dry));
  const rows = await getDocuments();
  check('8 documents now (6 local + 2 created)', rows.length === 8, String(rows.length));
  const bySid1 = rows.find((d) => d.stableId === SID(1));
  check('stableId match + newer: replaced title/content/category, links rewritten to red-2.png, local id kept', !!bySid1 && bySid1.title === 'Renamed in file' && bySid1.content === 'file text (newer)' && bySid1.category === 'Runbooks' && bySid1.updatedAt === NEWER && !rows.some((d) => d.title === 'By stable id'), JSON.stringify(bySid1 && [bySid1.title, bySid1.category]));
  check('red.png (local, different) kept; red-2.png holds the file\'s image', (await db.media.toArray()).map((m) => m.filename).sort().join() === 'red-2.png,red.png');
  check('identical (title trimmed, category same) -> unchanged', byTitle(rows, 'Same name').content === 'identical body' && byTitle(rows, 'Same name').updatedAt === OLD && rows.filter((d) => /Same name/.test(d.title)).length === 1);
  check('local newer but blank content -> filled, local timestamp kept', byTitle(rows, 'Blank here').content === 'now filled from the file' && byTitle(rows, 'Blank here').updatedAt === NEWER);
  check('locked -> untouched', byTitle(rows, 'Locked one').content === 'locked body' && byTitle(rows, 'Locked one').locked === true && rows.filter((d) => d.title === 'Locked one').length === 1);
  const shared = rows.filter((d) => d.title === 'Shared name');
  check('same name but a different stableId -> created as its own document, keeping the file\'s stableId', shared.length === 2 && shared.some((d) => d.stableId === SID(9) && d.content === 'local distinct') && shared.some((d) => d.stableId === SID(2) && d.content === 'file distinct'));
  const cloud = rows.find((d) => d.stableId === SID(3));
  check('cloud-linked local doc: text replaced, cloud fields untouched', cloud.content === 'cloud body from file' && cloud.inCloud === true && cloud.ownerId === 'machine-synthetic' && cloud.cloudDocumentId === 'room-synthetic');
  check('"Brand new" created with the file\'s stableId', rows.find((d) => d.stableId === SID(4))?.title === 'Brand new');

  // Re-import the same file: everything unchanged, no media duplicated
  const again = await runDocumentsImport(FILE, { mergeMode: true, dryRun: true });
  const a = again.summary.documents;
  check('re-importing the same file: all 7 unchanged (incl. the locked one), 0 created/replaced/filled; the colliding image reuses red-2.png', a.created === 0 && a.updated === 0 && a.filled === 0 && a.skipped === 7 && a.locked === 1 && again.summary.images.skipped === 1 && again.summary.images.created === 0, JSON.stringify({ c: a.created, u: a.updated, f: a.filled, s: a.skipped, l: a.locked, img: again.summary.images.skipped }));
  const realAgain = await runDocumentsImport(FILE, { mergeMode: true });
  check('...and the real re-import changes nothing (8 documents, 2 media rows)', stripRun(realAgain) === stripRun(again) && (await db.documents.count()) === 8 && (await db.media.count()) === 2);
}

/* ================================================================== */
console.log('\n--- 3. older file copy vs local edits; file without stableIds ---');
/* ================================================================== */
await resetTables();
{
  const id = await createDocument({ title: 'Edited locally', content: 'local edit', category: 'Notes' });
  await db.documents.update(id, { updatedAt: NEWER });
  const r = await runDocumentsImport([{ title: 'Edited locally', content: 'older file copy', category: 'Notes', updatedAt: OLD }], { mergeMode: true });
  check('an older file copy never overwrites a local edit (nothing blank to fill -> unchanged)', r.summary.documents.skipped === 1 && (await db.documents.get(id)).content === 'local edit');
  const r2 = await runDocumentsImport([{ title: 'Edited locally', content: 'file copy without timestamps', category: 'Notes' }], { mergeMode: true });
  check('a file copy without updatedAt is never "newer" (unchanged)', r2.summary.documents.skipped === 1 && (await db.documents.get(id)).content === 'local edit');
  const r3 = await runDocumentsImport([{ title: 'edited locally', content: 'x', category: 'Notes' }], { mergeMode: true });
  check('matching is exact (case-sensitive) on title + category: a different case is a new document', r3.summary.documents.created === 1);
}

/* ================================================================== */
console.log('\n--- 4. merge-created stableIds and the database merge importer ---');
/* ================================================================== */
await resetTables();
{
  await runDocumentsImport([{ title: 'Keeps id', content: 'v1', category: 'Notes', stableId: SID(7), updatedAt: OLD }], { mergeMode: true });
  const local = (await getDocuments())[0];
  check('merge-created document carries the file\'s stableId', local.stableId === SID(7));
  const backup = { version: '1.0', documents: [{ id: 99, stableId: SID(7), title: 'Keeps id (renamed elsewhere)', content: 'v2', category: 'Ops', updatedAt: NEWER }], documentTemplates: [], jqlTemplates: [], engineTemplates: [] };
  const dbRun = await importDatabase.runImport(backup, true);
  const after = await getDocuments();
  check('the DB merge importer matches it by stableId (1 replaced, no duplicate row)', dbRun.summary.documents.updated === 1 && after.length === 1 && after[0].title === 'Keeps id (renamed elsewhere)' && after[0].stableId === SID(7), JSON.stringify(dbRun.summary.documents));
  const stable = new Set((await getDocuments()).map((d) => d.stableId));
  check('every document still has a unique stableId', stable.size === after.length && !stable.has(undefined));
}

/* ================================================================== */
console.log('\n--- 5. UI: the checkbox in the JSON modal and the Base64 modal ---');
/* ================================================================== */
await seed();
{
  renderSidebar({ documents: await getDocumentsMetadata(), categories: await getCategories(), onRefreshDocuments: async () => {} });
  await sleep(10);
  const open = async (re) => { click(window, Array.from(document.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-menu'))); await sleep(10); click(window, byText(document, re)); await sleep(10); };
  await open(/^Import from JSON$/);
  const option = document.querySelector('[data-testid="merge-mode-option"]');
  const box = option && option.querySelector('input[type="checkbox"]');
  check('the merge checkbox is there (shared MergeModeOption), unchecked by default, with the "Keep existing documents..." label and the add-as-new hint', !!box && box.checked === false && /Keep existing documents and merge newer copies/.test(option.textContent) && /Every document in the file is added as a new document/.test(option.textContent), option && option.textContent.slice(0, 120));
  typeInto(window, document.querySelector('textarea'), JSON.stringify(FILE));
  await sleep(10);
  click(window, byText(document, /^Dry Run$/));
  let stats = await waitFor(() => document.querySelector('[data-testid="import-stats"]'), 5000);
  check('merge off dry run: "add as new documents" wording, 7 would be created', !!stats && /Dry run \(add as new documents\)/.test(stats.textContent) && /7 documents would be created/.test(stats.textContent), stats && stats.textContent.slice(0, 160));
  click(window, box);
  await sleep(10);
  check('ticking the checkbox clears the stale stats and switches the hint to the merge explanation', !document.querySelector('[data-testid="import-stats"]') && box.checked === true && /locked documents are never changed/.test(option.textContent));
  const before = await snapshot();
  click(window, byText(document, /^Dry Run$/));
  stats = await waitFor(() => document.querySelector('[data-testid="import-stats"]'), 5000);
  check('merge on dry run honours the checkbox: merge wording, Replaced/Completed/Unchanged columns, locked note; nothing written', !!stats && /Dry run \(merge into existing documents\)/.test(stats.textContent) && /2 documents would be added, 2 would be replaced by newer copies, 1 would be completed/.test(stats.textContent) && Array.from(stats.querySelectorAll('th')).map((t) => t.textContent).join('|') === 'Type|New|Replaced|Completed|Unchanged' && /1 locked document left untouched: Locked one/.test(stats.textContent) && (await snapshot()) === before, stats && Array.from(stats.querySelectorAll('th')).map((t) => t.textContent).join('|'));
  click(window, byText(document, /^Import Documents$/));
  check('Import Documents with merge on: progress modal ends with the merge stats', !!(await waitFor(() => byText(document, /^Import Complete$/, 'h3'), 8000)) && !!(await waitFor(() => /Import complete \(merge into existing documents\)/.test(document.querySelector('[data-testid="import-stats"]')?.textContent || ''), 2000)) && (await db.documents.count()) === 8);
  click(window, byText(document, /^Close$/));
  await waitFor(() => !byText(document, /^Import Complete$/, 'h3'), 2000);

  // Base64 modal
  await open(/^Import from Base64$/);
  const option64 = await waitFor(() => document.querySelector('[data-testid="merge-mode-option"]'), 2000);
  const box64 = option64 && option64.querySelector('input[type="checkbox"]');
  check('the Base64 modal has the same checkbox, unchecked by default', !!box64 && box64.checked === false);
  typeInto(window, document.querySelector('textarea'), Buffer.from(JSON.stringify(FILE), 'utf8').toString('base64'));
  await sleep(10);
  click(window, box64);
  await sleep(10);
  const before64 = await snapshot();
  click(window, byText(document, /^Dry Run$/));
  const stats64 = await waitFor(() => document.querySelector('[data-testid="import-stats"]'), 5000);
  check('Base64 merge dry run after the import: everything unchanged, nothing written', !!stats64 && /Dry run \(merge into existing documents\)/.test(stats64.textContent) && /0 documents would be added, 0 would be replaced by newer copies, 0 would be completed \(empty fields filled in\), 7 unchanged/.test(stats64.textContent) && (await snapshot()) === before64, stats64 && stats64.textContent.slice(0, 220));
  click(window, box64);
  await sleep(10);
  check('untoggling clears the Base64 stats too', !document.querySelector('[data-testid="import-stats"]'));
  click(window, byText(document, /^Cancel$/));
  await waitFor(() => !document.querySelector('textarea'), 2000);
  unmountSidebar();
}

process.exit(summary());
