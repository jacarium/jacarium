/**
 * Dry run + statistics for the Documents "Import from JSON / Base64"
 * (src/utils/documentImport.js runDocumentsImport, the shared
 * src/components/common/ImportStats.jsx + ImportFooter.jsx, the Documents
 * modals), against the REAL modules in jsdom over fake-indexeddb.
 * Synthetic data only (1x1 PNGs built here).
 *
 * HOW PLAN AND APPLY SHARE CODE: runDocumentsImport(items, { dryRun }) is
 * the one runner. It creates an import session from the database
 * importer's write sink (importDatabase.js createWriter: a dry run's
 * add() stores nothing and hands back a fake id) and an in-session media
 * index (images "added" earlier in the same run), and threads that
 * session through importDocumentFromJson -> createDocument({ writer }) and
 * importDocumentMedia. Every read is real, every write goes through the
 * sink, so the dry run computes exactly the plan the real run executes.
 *
 * What this proves:
 *   1. A dry run writes NOTHING: byte-identical snapshots of the documents,
 *      media and documentCategories tables and of localStorage before and
 *      after (with a file that adds documents, new categories, new and
 *      renamed images).
 *   2. Dry-run statistics equal the real run's statistics for the same file
 *      and DB state (deep-equal apart from the dryRun flag), and the real
 *      run then writes what the dry run predicted.
 *   3. Per-category counts with new-category detection; the same-title
 *      count (reported, not acted on: the documents are still created);
 *      image added / reused / renamed (with the documents whose links get
 *      rewritten) / skipped (with reasons); invalid items with reasons;
 *      sample titles.
 *   4. The ImportStats wording (describeDocumentsImport) for a dry run and
 *      a real import.
 *   5. UI (real DocumentSidebar), with the valid part of the file (the
 *      whole-file validation still rejects a file with an invalid item
 *      before anything runs, so UI statistics only ever show runtime
 *      invalids such as a broken media entry): paste -> Dry Run -> stats
 *      block (no progress modal, nothing written) -> editing the input clears the
 *      stats -> Dry Run again -> Import Documents -> progress modal ends in
 *      the same stats -> Close; the Base64 modal offers Dry Run too and its
 *      dry run writes nothing; the footer is the shared one (Cancel / Dry
 *      Run / Import Documents, then Close); an invalid paste shows the
 *      Validation Error on Dry Run and on Import alike.
 *   6. The database import modal still renders its statistics through the
 *      shared component with its own wording (title, headline, hint,
 *      Import Database label, Reload App after import).
 *
 * Run:  node tests/documents-import-dry-run.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import zlib from 'node:zlib';
import { setupDocumentsEnv, fixture, makeChecker, byText, click, waitFor, typeInto, sleep } from './helpers/jsdom-documents-env.mjs';

const { check, summary } = makeChecker();
const { mod, window } = await setupDocumentsEnv('documents-import-dry-run');
const { documents, documentImport, db, renderSidebar, unmountSidebar, renderImportDBModal, unmountImportDBModal } = mod;
const { createDocument, getDocuments, getDocumentsMetadata, getCategories } = documents;
const { runDocumentsImport, describeDocumentsImport } = documentImport;

/* ---------- tiny synthetic PNGs ---------- */
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
const BLUE = png([0, 0, 255]);
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
/** Byte-identical snapshot of everything an import could touch. */
async function snapshot() {
  const media = [];
  for (const m of await db.media.toArray()) media.push({ ...m, blob: Buffer.from(await m.blob.arrayBuffer()).toString('base64') });
  const ls = {};
  for (let i = 0; i < window.localStorage.length; i++) { const k = window.localStorage.key(i); ls[k] = window.localStorage.getItem(k); }
  return JSON.stringify({ documents: await db.documents.toArray(), categories: await db.documentCategories.toArray(), media, ls });
}
const stripRun = (r) => JSON.stringify({ summary: r.summary, totals: r.totals });

// The file: new category, existing category, same-title doc, shared image,
// an image colliding with a different local one, a broken media entry, an
// invalid item.
const FILE = [
  { title: 'Alpha runbook', content: '![r](attachment:red.png) ![s](attachment:shared.png?width=90)', category: 'Runbooks', media: [entry('red.png', RED), entry('shared.png', BLUE)] },
  { title: 'Beta notes', content: 'body ![s](attachment:shared.png)', category: 'Notes', media: [entry('shared.png', BLUE)] },
  { title: 'Existing title', content: 'a second copy', category: 'Notes' },
  { title: 'Broken images', content: 'x', category: 'Runbooks', media: [{ filename: 'nodata.png' }, entry('ok.png', GREEN)] },
  { category: 'Lonely Cat' }, // no title, no content -> invalid ("item 5")
];
async function seedExisting() {
  await resetTables();
  await createDocument({ title: 'Existing title', content: 'the original', category: 'Notes' });
  await createDocument({ title: 'Other', content: 'o', category: 'Notes' });
  await addMedia('red.png', GREEN); // a DIFFERENT local image owning the name
}

/* ================================================================== */
console.log('\n--- 1. a dry run writes nothing ---');
/* ================================================================== */
await seedExisting();
let dry;
{
  window.localStorage.setItem('synthetic-key', 'untouched');
  const before = await snapshot();
  const logs = [];
  dry = await runDocumentsImport(FILE, { dryRun: true, onProgress: (u) => { if (u.log) logs.push(u.log); } });
  const after = await snapshot();
  check('documents, media, categories and localStorage are byte-identical before and after the dry run', before === after);
  check('the dry run reports dryRun: true and the "nothing was written" log line', dry.dryRun === true && logs.some((l) => /^Dry run finished - nothing was written\. 4 document\(s\) would be imported\.$/.test(l)), JSON.stringify(logs.slice(-2)));
  check('the log says "Would import" per document, not "Imported"', logs.some((l) => /^✓ Would import "Alpha runbook"$/.test(l)) && !logs.some((l) => /^✓ Imported/.test(l)));
}

/* ================================================================== */
console.log('\n--- 2. dry-run stats == real-run stats; the real run writes the plan ---');
/* ================================================================== */
let real;
{
  real = await runDocumentsImport(FILE, { dryRun: false });
  check('the real run returns dryRun: false', real.dryRun === false);
  check('summary + totals of the dry run equal those of the real run (same file, same DB state)', stripRun(dry) === stripRun(real), stripRun(dry).slice(0, 400));
  const rows = await getDocuments();
  check('the real run created the 4 valid documents (and no "Lonely Cat" document)', rows.length === 6 && ['Alpha runbook', 'Beta notes', 'Existing title', 'Broken images'].every((t) => rows.some((r) => r.title === t)) && !rows.some((r) => r.category === 'Lonely Cat'));
  const names = (await db.media.toArray()).map((m) => m.filename).sort().join();
  check('media: red.png kept (local), red-2.png added, shared.png added once, ok.png added', names === 'ok.png,red-2.png,red.png,shared.png', names);
  check('Alpha\'s links point at red-2.png', rows.find((r) => r.title === 'Alpha runbook').content === '![r](attachment:red-2.png) ![s](attachment:shared.png?width=90)');
  const d2 = await runDocumentsImport(FILE, { dryRun: true });
  check('a second dry run on the changed DB now predicts: every image reused (red.png via its earlier red-2.png copy), nothing added, 4 same-title hits', d2.summary.images.skipped === 4 && d2.summary.images.created === 0 && d2.summary.images.renamed.length === 0 && d2.summary.documents.sameTitle === 4, JSON.stringify({ images: { skipped: d2.summary.images.skipped, created: d2.summary.images.created, renamed: d2.summary.images.renamed }, sameTitle: d2.summary.documents.sameTitle }));
}

/* ================================================================== */
console.log('\n--- 3. the statistics ---');
/* ================================================================== */
{
  const s = dry.summary;
  check('documents: 4 created, 1 invalid with its reason (labelled by position: "item 5")', s.documents.created === 4 && s.documents.invalid === 1 && s.documents.errors[0].label === 'item 5' && s.documents.errors[0].reason === 'missing both title and content', JSON.stringify(s.documents.errors));
  check('documents samples list the titles', s.documents.samples.created.join() === 'Alpha runbook,Beta notes,Existing title,Broken images');
  check('same-title: 1 (Existing title in Notes), reported in the note', s.documents.sameTitle === 1 && /1 has the same title as an existing document in the same category.*Existing title/.test(s.documents.note), s.documents.note);
  const keys = Object.keys(s);
  check('summary order: documents, category rows (sorted), images', keys.join() === 'documents,category:Notes,category:Runbooks,images', keys.join());
  check('category rows: Notes (existing) 2, Runbooks (new) 2, labelled accordingly', s['category:Notes'].created === 2 && s['category:Notes'].isNew === false && s['category:Notes'].label === 'Category "Notes"' && s['category:Runbooks'].created === 2 && s['category:Runbooks'].isNew === true && s['category:Runbooks'].label === 'Category "Runbooks" (new)');
  check('category samples list the titles', s['category:Runbooks'].samples.created.join() === 'Alpha runbook,Broken images');
  check('images: 3 added (red-2, shared, ok), 1 reused (shared by Beta), 1 invalid (nodata.png: no base64 data)', s.images.created === 3 && s.images.samples.created.join() === 'shared.png,red-2.png,ok.png' && s.images.skipped === 1 && s.images.reused.join() === 'shared.png' && s.images.invalid === 1 && /no base64 data/.test(s.images.errors[0].reason) && s.images.errors[0].label === 'nodata.png', JSON.stringify({ c: s.images.samples.created, e: s.images.errors }));
  check('images: the rename names both files and the document whose links change', JSON.stringify(s.images.renamed) === JSON.stringify([{ from: 'red.png', to: 'red-2.png', document: 'Alpha runbook' }]) && /red\.png → red-2\.png \(links updated in "Alpha runbook"\)/.test(s.images.note), s.images.note);
  check('totals count documents once (category rows excluded): created 4+3, invalid 2, skipped 1', dry.totals.created === 7 && dry.totals.invalid === 2 && dry.totals.skipped === 1, JSON.stringify(dry.totals));

  const dText = describeDocumentsImport({ kind: 'dry-run', ...dry });
  check('dry-run wording', dText.title === 'Dry run (add as new documents) - nothing was written' && dText.headline === '4 documents would be created in 2 categories (1 new category); 1 with the same title as an existing document; 3 images would be added, 1 already in the library, 1 renamed; 2 invalid' && /click Import Documents/.test(dText.hint), dText.headline);
  const rText = describeDocumentsImport({ kind: 'import', ...real });
  check('real-run wording', rText.title === 'Import complete (add as new documents)' && rText.headline === '4 documents created in 2 categories (1 new category); 1 with the same title as an existing document; 3 images added, 1 already in the library, 1 renamed; 2 invalid' && rText.hint === null, rText.headline);
  const invalidOnly = await runDocumentsImport([null, 'x', { category: 'c' }], { dryRun: true });
  check('a file of only invalid items: 3 invalid rows with reasons, nothing created', invalidOnly.summary.documents.invalid === 3 && invalidOnly.summary.documents.errors.map((e) => e.reason).join('|') === 'not a document object|not a document object|missing both title and content' && invalidOnly.totals.created === 0);
  const empty = describeDocumentsImport({ kind: 'dry-run', ...invalidOnly });
  check('wording with nothing to create', empty.headline === '0 documents would be created in 0 categories; 3 invalid', empty.headline);
}

/* ================================================================== */
console.log('\n--- 5. UI: Dry Run -> stats -> edit clears -> Import -> same stats -> Close ---');
/* ================================================================== */
await seedExisting();
const UI_FILE = FILE.slice(0, 4); // the invalid 5th item would be rejected by validation (see header)
{
  const refreshCalls = [];
  renderSidebar({ documents: await getDocumentsMetadata(), categories: await getCategories(), onRefreshDocuments: async () => { refreshCalls.push(1); } });
  await sleep(10);
  click(window, Array.from(document.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-menu')));
  await sleep(10);
  click(window, byText(document, /^Import from JSON$/));
  await sleep(10);
  const footer = document.querySelector('[data-testid="import-footer"]');
  const labels = () => Array.from(document.querySelector('[data-testid="import-footer"]').querySelectorAll('button')).map((b) => b.textContent.trim());
  check('the shared footer shows Cancel / Dry Run / Import Documents in that order', !!footer && labels().join('|') === 'Cancel|Dry Run|Import Documents', labels().join('|'));
  check('Dry Run and Import Documents are disabled while empty', byText(document, /^Dry Run$/).disabled && byText(document, /^Import Documents$/).disabled);
  const textarea = document.querySelector('textarea');

  // invalid paste: the same Validation Error on Dry Run and on Import
  typeInto(window, textarea, '{"title":"solo"}');
  await sleep(10);
  click(window, byText(document, /^Dry Run$/));
  check('Dry Run on an invalid paste shows the Validation Error', !!(await waitFor(() => byText(document, /wrap it in \[ \.\.\. \]/, 'div'), 2000)) && !document.querySelector('[data-testid="import-stats"]'));
  click(window, byText(document, /^Import Documents$/));
  await sleep(50);
  check('Import Documents on an invalid paste shows the same error and opens no progress modal', !!byText(document, /wrap it in \[ \.\.\. \]/, 'div') && !byText(document, /^Importing Documents/, 'h3') && (await db.documents.count()) === 2);

  // valid paste: dry run
  const before = await snapshot();
  typeInto(window, textarea, JSON.stringify(UI_FILE));
  await sleep(10);
  check('editing the input clears the error', !byText(document, /^Validation Error$/, 'div'));
  click(window, byText(document, /^Dry Run$/));
  const stats = await waitFor(() => document.querySelector('[data-testid="import-stats"]'), 5000);
  check('Dry Run shows the statistics block in the input modal', !!stats && /Dry run \(add as new documents\) - nothing was written/.test(stats.textContent) && /Category "Runbooks" \(new\)/.test(stats.textContent) && /e\.g\. Alpha runbook/.test(stats.textContent), stats && stats.textContent.slice(0, 300));
  check('...with the same-title note, the invalid media entry and the renamed-image note', /1 has the same title as an existing document/.test(stats.textContent) && /1 record cannot be imported/.test(stats.textContent) && /Images: nodata\.png - media entry has no base64 data/.test(stats.textContent) && /red\.png → red-2\.png \(links updated in "Alpha runbook"\)/.test(stats.textContent), stats.textContent.slice(-400));
  check('no progress modal opened and nothing was written', !byText(document, /^Importing Documents/, 'h3') && (await snapshot()) === before);
  check('the footer still offers Dry Run / Import Documents after a dry run', labels().join('|') === 'Cancel|Dry Run|Import Documents');

  // editing clears the stats
  typeInto(window, textarea, JSON.stringify(UI_FILE) + ' ');
  await sleep(10);
  check('editing the input clears the stale statistics', !document.querySelector('[data-testid="import-stats"]'));

  // import
  click(window, byText(document, /^Import Documents$/));
  check('Import Documents opens the progress modal and reaches "Import Complete"', !!(await waitFor(() => byText(document, /^Import Complete$/, 'h3'), 8000)));
  const after = await waitFor(() => document.querySelector('[data-testid="import-stats"]'), 2000);
  check('the progress modal ends with the same statistics block (now "Import complete")', !!after && /Import complete/.test(after.textContent) && /4 documents created in 2 categories \(1 new category\); 1 with the same title as an existing document; 3 images added, 1 already in the library, 1 renamed; 1 invalid/.test(after.textContent), after && after.textContent.slice(0, 300));
  check('the post-import footer is just Close', labels().join('|') === 'Close', labels().join('|'));
  check('the real run wrote the plan and the page was asked to refresh', (await db.documents.count()) === 6 && (await db.media.count()) === 4 && refreshCalls.length === 1);
  click(window, byText(document, /^Close$/));
  await waitFor(() => !byText(document, /^Import Complete$/, 'h3'), 2000);

  // Base64 modal: Dry Run too, and it writes nothing
  const base64 = Buffer.from(JSON.stringify(UI_FILE), 'utf8').toString('base64');
  click(window, Array.from(document.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-menu')));
  await sleep(10);
  click(window, byText(document, /^Import from Base64$/));
  const ta = await waitFor(() => document.querySelector('textarea'), 2000);
  typeInto(window, ta, base64);
  await sleep(10);
  check('the Base64 modal has the shared footer', labels().join('|') === 'Cancel|Dry Run|Import Documents', labels().join('|'));
  const before64 = await snapshot();
  click(window, byText(document, /^Dry Run$/));
  const stats64 = await waitFor(() => document.querySelector('[data-testid="import-stats"]'), 5000);
  check('Base64 Dry Run shows the statistics and writes nothing', !!stats64 && /Dry run \(add as new documents\) - nothing was written/.test(stats64.textContent) && (await snapshot()) === before64);
  check('Base64 dry run on the now-changed DB predicts every image reused and 4 same-title hits', /0 images would be added, 4 already in the library/.test(stats64.textContent) && /4 with the same title/.test(stats64.textContent), stats64.textContent.slice(0, 300));
  click(window, byText(document, /^Cancel$/));
  await waitFor(() => !document.querySelector('textarea'), 2000);
  unmountSidebar();
}

/* ================================================================== */
console.log('\n--- 6. the database import modal still renders its own stats ---');
/* ================================================================== */
{
  const DRY = {
    mode: 'merge', dryRun: true,
    summary: { documents: { created: 1, updated: 0, filled: 1, skipped: 1, deleted: 0, invalid: 1, errors: [{ label: 'Runbook Broken / Ops', reason: 'not a record object' }], samples: { created: ['Runbook New / Ops'], updated: [], filled: ['Runbook Partial / Ops'] } } },
    totals: { created: 1, updated: 0, filled: 1, skipped: 1, deleted: 0, invalid: 1 },
  };
  let imported = false;
  renderImportDBModal({ onDryRun: async () => DRY, onImport: async () => { imported = true; return { ...DRY, dryRun: false }; } });
  await sleep(10);
  const labels = () => Array.from(document.querySelector('[data-testid="import-footer"]').querySelectorAll('button')).map((b) => b.textContent.trim());
  check('DB modal footer: Cancel / Dry Run / Import Database (disabled until a file is loaded)', labels().join('|') === 'Cancel|Dry Run|Import Database' && byText(document, /^Dry Run$/).disabled && byText(document, /^Import Database$/).disabled, labels().join('|'));
  // load a file through the hidden input
  const input = document.querySelector('input[type="file"]');
  const file = new window.File([JSON.stringify({ version: '1', documents: [{ id: 1 }], documentTemplates: [], jqlTemplates: [], engineTemplates: [] })], 'backup.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: { 0: file, length: 1, item: () => file }, configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('the preview appears and the buttons enable', !!(await waitFor(() => byText(document, /^Import Summary:$/, 'p'), 2000)) && !byText(document, /^Dry Run$/).disabled);
  click(window, byText(document, /^Dry Run$/));
  const stats = await waitFor(() => document.querySelector('[data-testid="import-stats"]'), 2000);
  check('DB dry run renders the database wording (title, headline, hint) and its rows', !!stats && /Dry run \(keep existing data mode\) - nothing was written/.test(stats.textContent) && /1 would be added, 0 would be replaced by newer copies, 1 would be completed \(empty fields filled in\), 1 unchanged, 1 invalid/.test(stats.textContent) && /click Import Database to apply exactly this plan/.test(stats.textContent) && /Documents/.test(stats.textContent) && /e\.g\. Runbook New \/ Ops, Runbook Partial \/ Ops/.test(stats.textContent) && /Documents: Runbook Broken \/ Ops - not a record object/.test(stats.textContent), stats && stats.textContent.slice(0, 400));
  check('DB column headers are the database ones (New / Completed / Unchanged / Invalid shown)', Array.from(stats.querySelectorAll('th')).map((t) => t.textContent).join('|') === 'Type|New|Completed|Unchanged|Invalid', Array.from(stats.querySelectorAll('th')).map((t) => t.textContent).join('|'));
  click(window, byText(document, /^Import Database$/));
  check('after the DB import: "Import complete (keep existing data mode)" and Close + Reload App', !!(await waitFor(() => /Import complete \(keep existing data mode\)/.test(document.querySelector('[data-testid="import-stats"]')?.textContent || ''), 2000)) && imported && labels().join('|') === 'Close|Reload App', labels().join('|'));
  unmountImportDBModal();
}

process.exit(summary());
