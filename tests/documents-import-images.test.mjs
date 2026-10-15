/**
 * Images in Export Category (JSON) -> Import from JSON
 * (src/utils/documentAttachments.js, wired into DocumentSidebar's
 * handleExportCategory and documentImport.js importDocumentFromJson),
 * against the REAL modules in jsdom over fake-indexeddb. Synthetic data
 * only: the images are 1x1 PNGs built in this test / in
 * tests/fixtures/documents-import/documents-with-images.json.
 *
 * THE FORMAT: the file stays a plain JSON array of documents; a document
 * that references images (`![alt](attachment:<filename>)`) carries them in
 * a `media` array, each entry encoded like the database backup's media rows
 * (`data` = base64 data URL, plus filename/mimeType/size/uploadedAt/tags).
 * Documents reference images by FILENAME (no ids to remap); a shared image
 * is embedded in every document that uses it, so any one document in the
 * file is self-contained.
 *
 * What this proves:
 *   1. Export: only the images the category's documents actually reference
 *      are embedded (an unreferenced library image and another category's
 *      image are not); an image shared by two documents is in both; the
 *      encoding is a data URL that decodes back to the same bytes; a
 *      reference whose image is missing from the library is a WARNING in
 *      the export log (the export still succeeds and keeps the link);
 *      documents without images get no `media` key.
 *   2. Export through the real sidebar context menu, then Import from
 *      JSON into a FRESH DB (no documents, no media): the documents are
 *      back, the media library holds the images, every `attachment:`
 *      reference resolves to the stored bytes (what the preview's image
 *      resolver looks up), the shared image is stored ONCE, and the import
 *      log says how many images were added.
 *   3. Re-import into the SAME DB: identical images are reused (no
 *      duplicate media rows), the log says "already in the library".
 *   4. Filename collision: a DIFFERENT local image already named like an
 *      imported one is kept; the imported image is stored as name-2.png
 *      and the document's links (with and without ?width=) are rewritten
 *      to it; a second, different collision becomes name-3.png; re-importing
 *      the same image reuses the earlier renamed copy.
 *   5. Backward compatibility: old bare-array files (no `media`) validate
 *      and import exactly as before; the valid-documents fixture is
 *      unchanged; a `media` that is not a list is rejected clearly; broken
 *      entries (no data / not base64 / no filename) are skipped with a
 *      warning while the document still imports.
 *   6. The import modal previews "N documents, M images to import" (unique
 *      filenames) and shows the importer's image log lines.
 *
 * Run:  node tests/documents-import-images.test.mjs
 * Preconditions (checked at startup, with instructions printed if missing):
 *   - repo deps installed:               npm install
 *   - test-only deps (not in package.json, install without saving):
 *                                        npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import zlib from 'node:zlib';
import { setupDocumentsEnv, fixture, makeChecker, byText, click, waitFor, typeInto, sleep } from './helpers/jsdom-documents-env.mjs';

const { check, summary } = makeChecker();
const { mod, window, downloads } = await setupDocumentsEnv('documents-import-images');
const { documents, documentImport, documentAttachments, media: mediaUtils, db, renderSidebar, unmountSidebar, getImportExport } = mod;
const { createDocument, getDocuments, getDocumentsMetadata, getCategories } = documents;
const { validateDocumentsImport, importDocumentFromJson } = documentImport;
const { attachReferencedMedia, importDocumentMedia, findAttachmentFilenames, countImportImages, rewriteAttachmentReferences, blobToDataURL } = documentAttachments;

/* ---------- tiny synthetic PNGs built here (1x1, solid colour) ---------- */
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
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b]))), chunk('IEND', Buffer.alloc(0))]);
}
const RED = png([255, 0, 0]);
const GREEN = png([0, 255, 0]);
const BLUE = png([0, 0, 255]);
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const blobOf = (buf) => new Blob([buf], { type: 'image/png' });

async function addMedia(filename, buf, extra = {}) {
  return db.media.add({ filename, blob: blobOf(buf), mimeType: 'image/png', size: buf.length, tags: [], uploadedAt: '2026-01-02T03:04:05.000Z', ...extra });
}
async function mediaBytes(filename) {
  const rec = await db.media.where('filename').equals(filename).first();
  return rec ? Buffer.from(await rec.blob.arrayBuffer()) : null;
}
const mediaNames = async () => (await db.media.toArray()).map((m) => m.filename).sort();
async function resetTables() {
  await db.documents.clear();
  await db.documentCategories.clear();
  await db.media.clear();
}
/** The preview's lookup: every attachment: reference in a document resolves to stored bytes. */
async function referencesResolve(content) {
  const names = findAttachmentFilenames(content);
  const bytes = await Promise.all(names.map(mediaBytes));
  return names.length > 0 && bytes.every((b) => b !== null);
}

/* ================================================================== */
console.log('\n--- 0. helpers ---');
/* ================================================================== */
{
  check('findAttachmentFilenames strips ?width= and de-duplicates', JSON.stringify(findAttachmentFilenames('![a](attachment:a.png?width=50%) ![b](attachment:b.png) ![a](attachment:a.png) "attachment:c.png"')) === JSON.stringify(['a.png', 'b.png', 'c.png']));
  check('rewriteAttachmentReferences renames only that file and keeps ?width=', rewriteAttachmentReferences('![a](attachment:a.png?width=50) ![ab](attachment:a.png.bak) ![a](attachment:a.png)', 'a.png', 'a-2.png') === '![a](attachment:a-2.png?width=50) ![ab](attachment:a.png.bak) ![a](attachment:a-2.png)');
  check('blobToDataURL produces the DB-backup encoding and round-trips the bytes', (await blobToDataURL(blobOf(RED))) === dataUrl(RED));
  check('countImportImages counts unique filenames across documents', countImportImages(JSON.parse(fixture('documents-with-images.json'))) === 2 && countImportImages(JSON.parse(fixture('valid-documents.json'))) === 0 && countImportImages(null) === 0);
}

/* ================================================================== */
console.log('\n--- 1. export embeds only referenced images ---');
/* ================================================================== */
await resetTables();
{
  await addMedia('red.png', RED, { tags: ['synthetic'] });
  await addMedia('shared.png', BLUE);
  await addMedia('unused.png', GREEN);
  await addMedia('other-category.png', GREEN);
  await createDocument({ title: 'Pic one', content: '# One\n\n![r](attachment:red.png)\n![s](attachment:shared.png?width=120)\n', category: 'Pictures' });
  await createDocument({ title: 'Pic two', content: 'Uses ![s](attachment:shared.png) and ![gone](attachment:missing.png)', category: 'Pictures' });
  await createDocument({ title: 'Text only', content: 'no images', category: 'Pictures' });
  await createDocument({ title: 'Elsewhere', content: '![o](attachment:other-category.png)', category: 'Other' });

  const logs = [];
  const picDocs = (await getDocuments()).filter((d) => d.category === 'Pictures');
  const { docs, stats } = await attachReferencedMedia(picDocs, (u) => { if (u.log) logs.push({ log: u.log, type: u.logType || 'info' }); });
  const one = docs.find((d) => d.title === 'Pic one');
  const two = docs.find((d) => d.title === 'Pic two');
  const text = docs.find((d) => d.title === 'Text only');
  check('a document with images gets a media list with exactly its referenced images', one.media.map((m) => m.filename).sort().join() === 'red.png,shared.png');
  check('the shared image is embedded in both documents that reference it', two.media.map((m) => m.filename).join() === 'shared.png');
  check('a document without images has no media key', !('media' in text));
  check('unreferenced and other-category images are not embedded', !docs.some((d) => (d.media || []).some((m) => /unused|other-category/.test(m.filename))));
  const red = one.media.find((m) => m.filename === 'red.png');
  check('entries carry filename/mimeType/size/uploadedAt/tags and a data URL (DB-backup encoding)', red.mimeType === 'image/png' && red.size === RED.length && red.uploadedAt === '2026-01-02T03:04:05.000Z' && JSON.stringify(red.tags) === '["synthetic"]' && red.data === dataUrl(RED));
  check('the input documents are not mutated', !('media' in picDocs[0]));
  check('stats: 2 distinct images, 3 references, 1 missing', stats.images === 2 && stats.embedded === 3 && stats.missing.length === 1 && stats.missing[0].filename === 'missing.png', JSON.stringify(stats));
  check('a missing referenced image is a WARNING in the log, not a failure', logs.some((l) => l.type === 'warning' && /"missing\.png" referenced by "Pic two" is not in the media library/.test(l.log)), JSON.stringify(logs));
  check('the log summarizes the embedded images', logs.some((l) => /^Embedded 2 images \(.* encoded, 3 references\)$/.test(l.log)), JSON.stringify(logs.map((l) => l.log)));
  check('the missing link is left untouched in the content', two.content.includes('attachment:missing.png'));
  check('the whole export validates for Import from JSON', validateDocumentsImport(docs) === true);
}

/* ================================================================== */
console.log('\n--- 2. real context-menu export -> import into a fresh DB ---');
/* ================================================================== */
let exportedFile = null;
{
  const list = await getDocumentsMetadata();
  renderSidebar({ documents: list, categories: await getCategories() });
  const header = Array.from(document.querySelectorAll('span.text-sm.font-medium.truncate')).find((s) => s.textContent === 'Pictures');
  const before = downloads.length;
  header.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  click(window, await waitFor(() => byText(document, /^Export Category \(JSON\)$/), 2000));
  check('the export window reaches "Export Complete"', !!(await waitFor(() => byText(document, /^Export Complete$/, 'h3'), 8000)));
  check('the export window says "→ JSON with images"', !!byText(document, /→ JSON with images$/, 'p'));
  const pane = document.querySelector('.os-terminal');
  check('the export log shows the missing-image warning and the embedded count', !!pane && /missing\.png.*not in the media library/.test(pane.textContent) && /Embedded 2 images/.test(pane.textContent));
  const file = downloads[before];
  exportedFile = file ? await file.text() : null;
  const data = exportedFile ? JSON.parse(exportedFile) : null;
  check('the download holds 3 documents with 2 distinct embedded images', Array.isArray(data) && data.length === 3 && countImportImages(data) === 2, file?.name);
  const closeBtn = byText(document, /^(Close|Done)$/);
  if (closeBtn) click(window, closeBtn);
  await sleep(50);
  unmountSidebar();

  // Fresh DB
  await resetTables();
  check('fresh DB: no documents, no media', (await db.documents.count()) === 0 && (await db.media.count()) === 0);
  const results = [];
  for (const d of data) results.push(await importDocumentFromJson(d));
  const rows = await getDocuments();
  check('the 3 documents are back in Pictures', rows.length === 3 && rows.every((r) => r.category === 'Pictures'));
  check('the media library holds exactly red.png and shared.png (shared stored once)', (await mediaNames()).join() === 'red.png,shared.png');
  check('stored bytes match the originals', (await mediaBytes('red.png')).equals(RED) && (await mediaBytes('shared.png')).equals(BLUE));
  check('every attachment: reference in "Pic one" resolves (what the preview looks up)', await referencesResolve(rows.find((r) => r.title === 'Pic one').content));
  check('content is unchanged (no rewriting when nothing collided)', rows.find((r) => r.title === 'Pic one').content === '# One\n\n![r](attachment:red.png)\n![s](attachment:shared.png?width=120)\n');
  // The file lists documents newest-first ("Pic two" before "Pic one"), so
  // whichever document comes first ADDS shared.png and the other REUSES it.
  const added = results.flatMap((r) => r.images.imported).sort();
  const reused = results.flatMap((r) => r.images.reused);
  check('results: red.png and shared.png were each added exactly once, shared.png reused by the other document', added.join() === 'red.png,shared.png' && reused.join() === 'shared.png' && results.every((r) => r.images.renamed.length === 0), JSON.stringify(results.map((r) => r.images)));
  const allLogs = results.flatMap((r) => r.logs.map((l) => l.message));
  check('the import log lines say what happened (one "added", one "already in the library")', allLogs.some((m) => /1 image \(1 added\)/.test(m)) && allLogs.some((m) => /2 images \(1 added, 1 already in the library\)/.test(m)), JSON.stringify(allLogs));
  check('a text-only document has no image logs', results.some((r) => r.logs.length === 0 && r.images.imported.length === 0));
  check('media metadata (tags, uploadedAt, mimeType, size) is restored', (await db.media.where('filename').equals('red.png').first()).tags.join() === 'synthetic' && (await db.media.where('filename').equals('red.png').first()).uploadedAt === '2026-01-02T03:04:05.000Z');
}

/* ================================================================== */
console.log('\n--- 3. re-import into the same DB: identical images are reused ---');
/* ================================================================== */
{
  const data = JSON.parse(exportedFile);
  const results = [];
  for (const d of data) results.push(await importDocumentFromJson(d));
  check('documents are created again (6) but no media row is duplicated (still 2)', (await db.documents.count()) === 6 && (await db.media.count()) === 2, `${await db.media.count()} media rows: ${(await mediaNames()).join()}`);
  check('every image result is "reused", none added or renamed', results.every((r) => r.images.imported.length === 0 && r.images.renamed.length === 0) && results.some((r) => r.images.reused.length === 2));
  check('the log says "already in the library"', results.some((r) => r.logs.some((l) => /2 images \(2 already in the library\)/.test(l.message))));
}

/* ================================================================== */
console.log('\n--- 4. filename collision with a DIFFERENT local image ---');
/* ================================================================== */
await resetTables();
{
  await addMedia('red.png', GREEN); // a local stranger owning the name
  const data = JSON.parse(exportedFile);
  const one = data.find((d) => d.title === 'Pic one');
  const result = await importDocumentFromJson(one);
  check('the local image is kept untouched', (await mediaBytes('red.png')).equals(GREEN));
  check('the imported image is stored as red-2.png with the right bytes', (await mediaBytes('red-2.png'))?.equals(RED) === true, (await mediaNames()).join());
  check('the result reports the rename', JSON.stringify(result.images.renamed) === JSON.stringify([['red.png', 'red-2.png']]) && result.images.imported.join() === 'shared.png');
  const stored = (await getDocuments()).find((d) => d.id === result.id);
  check('the document\'s links point at red-2.png (shared.png untouched, ?width kept)', stored.content === '# One\n\n![r](attachment:red-2.png)\n![s](attachment:shared.png?width=120)\n', stored.content);
  check('every reference in the stored document resolves', await referencesResolve(stored.content));
  check('the log carries a warning naming both files', result.logs.some((l) => l.type === 'warning' && /"red\.png" already exists here - stored as "red-2\.png"/.test(l.message)), JSON.stringify(result.logs));
  // A third, different image under the same name -> red-3.png
  const third = { ...one, media: [{ ...one.media.find((m) => m.filename === 'red.png'), data: dataUrl(BLUE) }] };
  const r3 = await importDocumentFromJson(third);
  check('a second collision becomes red-3.png', r3.images.renamed[0][1] === 'red-3.png' && (await mediaBytes('red-3.png')).equals(BLUE), (await mediaNames()).join());
  // Re-importing the same document again: red.png still collides with the local red.png, but the identical copy already lives as red-2.png -> reused, links rewritten there, nothing written
  const mediaBefore = await db.media.count();
  const r4 = await importDocumentFromJson(one);
  const stored4 = (await getDocuments()).find((d) => d.id === r4.id);
  check('a re-import reuses the earlier renamed copy (red-2.png): no red-4.png, links rewritten, no new media row', r4.images.reused.slice().sort().join() === 'red.png,shared.png' && r4.images.renamed.length === 0 && stored4.content.includes('attachment:red-2.png') && (await db.media.count()) === mediaBefore, JSON.stringify(r4.images));
}

/* ================================================================== */
console.log('\n--- 5. backward compatibility and broken media entries ---');
/* ================================================================== */
await resetTables();
{
  const old = JSON.parse(fixture('valid-documents.json'));
  check('an old bare-array file (no media) still validates', validateDocumentsImport(old) === true);
  const r = await importDocumentFromJson(old[0]);
  check('...and imports with no image activity', typeof r.id === 'number' && r.logs.length === 0 && (await db.media.count()) === 0);
  check('a document whose media is not a list is rejected clearly', validateDocumentsImport([{ title: 't', content: 'c', media: 'nope' }]) === 'Invalid document structure: Documents at positions 1 have a "media" field that is not a list of images');
  check('media: null / media: [] are accepted (treated as no images)', validateDocumentsImport([{ title: 't', content: 'c', media: null }, { title: 'u', media: [] }]) === true);
  const broken = await importDocumentFromJson({ title: 'Broken media', content: '![a](attachment:a.png) ![b](attachment:b.png)', media: [
    { filename: 'a.png', mimeType: 'image/png' }, // no data
    { filename: 'b.png', data: 'data:image/png;base64,@@@not-base64@@@' },
    { data: dataUrl(RED) }, // no filename
    'garbage',
    { filename: 'ok.png', data: dataUrl(RED) },
  ] });
  check('broken entries are skipped with reasons while the document still imports', typeof broken.id === 'number' && broken.images.skipped.length === 4 && broken.images.imported.join() === 'ok.png', JSON.stringify(broken.images.skipped));
  check('each skipped entry is a warning line in the log', broken.logs.filter((l) => l.type === 'warning').length === 4 && broken.logs.some((l) => /"a\.png" skipped: media entry has no base64 data/.test(l.message)));
  check('a duplicate entry for one filename inside a document is processed once', (await importDocumentMedia({ content: '', media: [{ filename: 'twice.png', data: dataUrl(RED) }, { filename: 'twice.png', data: dataUrl(RED) }] })).imported.join() === 'twice.png' && (await db.media.where('filename').equals('twice.png').count()) === 1);
  check('the shipped fixture documents-with-images.json validates and imports 2 images for 3 documents', validateDocumentsImport(JSON.parse(fixture('documents-with-images.json'))) === true);
}

/* ================================================================== */
console.log('\n--- 6. UI: preview counts and image log lines ---');
/* ================================================================== */
await resetTables();
{
  renderSidebar({ documents: [], categories: [], onRefreshDocuments: async () => {} });
  const menuButton = Array.from(document.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-menu'));
  click(window, menuButton);
  await sleep(10);
  click(window, byText(document, /^Import from JSON$/));
  await sleep(10);
  typeInto(window, document.querySelector('textarea'), fixture('documents-with-images.json'));
  await sleep(10);
  click(window, byText(document, /^Import Documents$/));
  check('the progress modal reaches "Import Complete"', !!(await waitFor(() => byText(document, /^Import Complete$/, 'h3'), 8000)));
  check('the subtitle previews "3 documents, 2 images to import"', !!byText(document, /^3 documents, 2 images to import$/, 'p'));
  const pane = document.querySelector('.os-terminal');
  check('the log shows the image lines per document (2 added, then 1 already in the library)', !!pane && /2 images \(2 added\)/.test(pane.textContent) && /1 image \(1 already in the library\)/.test(pane.textContent), pane && pane.textContent.slice(0, 600));
  check('the two fixture images are in the media library once each, and the missing reference did not break anything', (await mediaNames()).join() === 'red-dot.png,shared.png' && (await db.documents.count()) === 3);
  check('every reference that had an image resolves; the never-exported one stays a dangling link', await referencesResolve((await getDocuments()).find((d) => d.title === 'Diagram page 📝').content) && (await mediaBytes('never-exported.png')) === null);
  const stats = document.querySelector('[data-testid="import-stats"]');
  check('the statistics block reports the images (2 added, 1 already in the library)', !!stats && /2 images added, 1 already in the library/.test(stats.textContent), stats && stats.textContent.slice(0, 300));
  click(window, byText(document, /^Close$/));
  await waitFor(() => !byText(document, /^Import Complete$/, 'h3'), 2000);
  unmountSidebar();
  void mediaUtils; void getImportExport;
}

process.exit(summary());
