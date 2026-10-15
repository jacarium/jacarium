/**
 * Embedded images in the OTHER Documents JSON exports - Export All (JSON),
 * the single-document "Export Document (JSON)" from the document's context
 * menu, and Export as Base64 (all / single) - through the REAL
 * DocumentSidebar in jsdom over fake-indexeddb, plus their round trips
 * through Import from JSON / Import from Base64. Synthetic data only (1x1
 * PNGs built in this test).
 *
 * All of these go through DocumentSidebar.loadDocumentsWithImages
 * (loadDocumentsWithContent -> attachReferencedMedia, see
 * src/utils/documentAttachments.js and tests/documents-import-images.test.mjs
 * for the per-document `media` format and the import rules). Base64 is the
 * same document array, JSON-serialized and base64-encoded, and Import from
 * Base64 runs the same runDocumentsImport, so images travel
 * through it unchanged.
 *
 * What this proves:
 *   1. Export All (JSON): every document carries exactly the images it
 *      references (none for text-only documents, library images nobody
 *      references are left out), the missing-image warning and the
 *      "Embedded N images" line are in the export log, the window says
 *      "→ JSON with images".
 *   2. Export Document (JSON) from the document's own context menu: only
 *      that document, only its images, file document-<title>-<date>.json.
 *   3. Export All as Base64 (hamburger) and Export as Base64 (document
 *      context menu): the clipboard/modal Base64 decodes to the same
 *      document array with media.
 *   4. Round trips into a FRESH DB: the Export All file through
 *      importDocumentFromJson, and the Base64 string through the real
 *      "Import from Base64" modal - documents back, media library holds
 *      each image once, every attachment: reference resolves.
 *   5. Re-import into the same DB: documents duplicated (by design), media
 *      NOT duplicated.
 *   6. An old bare-array file (no media) still imports.
 *
 * Run:  node tests/documents-export-images.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import zlib from 'node:zlib';
import { setupDocumentsEnv, fixture, makeChecker, byText, click, waitFor, typeInto, sleep } from './helpers/jsdom-documents-env.mjs';

const { check, summary } = makeChecker();
const { mod, window, downloads } = await setupDocumentsEnv('documents-export-images');
const { documents, documentImport, documentAttachments, db, renderSidebar, unmountSidebar, getImportExport } = mod;
const { createDocument, getDocuments, getDocumentsMetadata, getCategories } = documents;
const { validateDocumentsImport, importDocumentFromJson } = documentImport;
const { findAttachmentFilenames, countImportImages } = documentAttachments;

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
const today = new Date().toISOString().split('T')[0];

async function addMedia(filename, buf) {
  return db.media.add({ filename, blob: new Blob([buf], { type: 'image/png' }), mimeType: 'image/png', size: buf.length, tags: [], uploadedAt: '2026-01-02T03:04:05.000Z' });
}
async function mediaBytes(filename) {
  const rec = await db.media.where('filename').equals(filename).first();
  return rec ? Buffer.from(await rec.blob.arrayBuffer()) : null;
}
const mediaNames = async () => (await db.media.toArray()).map((m) => m.filename).sort();
async function referencesResolve(content) {
  const names = findAttachmentFilenames(content);
  return names.length > 0 && (await Promise.all(names.map(mediaBytes))).every((b) => b !== null);
}
async function resetTables() {
  await db.documents.clear();
  await db.documentCategories.clear();
  await db.media.clear();
}
async function seed() {
  await resetTables();
  await addMedia('red.png', RED);
  await addMedia('shared.png', BLUE);
  await addMedia('unused.png', GREEN);
  await addMedia('other.png', GREEN);
  await createDocument({ title: 'Pic one', content: '# One\n\n![r](attachment:red.png)\n![s](attachment:shared.png?width=120)\n', category: 'Pictures' });
  await createDocument({ title: 'Pic two', content: 'Uses ![s](attachment:shared.png) and ![gone](attachment:missing.png)', category: 'Pictures' });
  await createDocument({ title: 'Text only', content: 'no images', category: 'Pictures' });
  await createDocument({ title: 'Elsewhere', content: '![o](attachment:other.png)', category: 'Other' });
}
const mediaOf = (data, title) => (data.find((d) => d.title === title)?.media || []).map((m) => m.filename).sort().join();

// clipboard for the Base64 export
let clipboard = '';
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => { clipboard = t; } }, configurable: true });
const refreshCalls = [];

async function mountSidebar() {
  window.localStorage.setItem('expandedDocumentCategories', JSON.stringify(['Pictures', 'Other']));
  renderSidebar({ documents: await getDocumentsMetadata(), categories: await getCategories(), onRefreshDocuments: async () => { refreshCalls.push(1); } });
  await sleep(10);
}
async function hamburger(re) {
  click(window, Array.from(document.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-menu')));
  await sleep(10);
  const item = byText(document, re);
  if (!item) return false;
  click(window, item);
  await sleep(10);
  return true;
}
async function documentContextMenu(title, re) {
  const row = Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0 && e.textContent.trim() === title)[0];
  if (!row) return false;
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const item = await waitFor(() => byText(document, re), 2000);
  if (!item) return false;
  click(window, item);
  return true;
}
async function waitExportComplete() {
  const done = await waitFor(() => byText(document, /^Export Complete$/, 'h3'), 8000);
  const subtitle = document.querySelector('h3')?.parentElement?.querySelector('p')?.textContent || '';
  const log = document.querySelector('.os-terminal')?.textContent || '';
  const closeBtn = byText(document, /^(Close|Done)$/);
  if (closeBtn) click(window, closeBtn);
  await sleep(50);
  return { done: !!done, subtitle, log };
}

/* ================================================================== */
console.log('\n--- 1. Export All (JSON) ---');
/* ================================================================== */
await seed();
let exportAllText = null;
{
  await mountSidebar();
  const before = downloads.length;
  check('hamburger -> "Export All (JSON)"', await hamburger(/^Export All \(JSON\)$/));
  const { done, subtitle, log } = await waitExportComplete();
  check('the export window reaches "Export Complete"', done);
  check('subtitle: "4 documents → JSON with images"', subtitle === '4 documents → JSON with images', subtitle);
  check('log: missing-image warning and "Embedded 3 images"', /"missing\.png" referenced by "Pic two" is not in the media library/.test(log) && /Embedded 3 images \(.* encoded, 4 references\)/.test(log), log.slice(0, 400));
  const file = downloads[before];
  exportAllText = await file.text();
  const data = JSON.parse(exportAllText);
  check('file documents-<date>.json with 4 documents', file.name === `documents-${today}.json` && data.length === 4, file.name);
  check('each document carries exactly its referenced images', mediaOf(data, 'Pic one') === 'red.png,shared.png' && mediaOf(data, 'Pic two') === 'shared.png' && mediaOf(data, 'Elsewhere') === 'other.png' && !('media' in data.find((d) => d.title === 'Text only')));
  check('unused.png (referenced by nobody) is not in the file', !exportAllText.includes('unused.png') && countImportImages(data) === 3);
  check('the embedded data decodes to the original bytes', data.find((d) => d.title === 'Pic one').media.find((m) => m.filename === 'red.png').data === dataUrl(RED));
  check('the file validates for Import from JSON', validateDocumentsImport(data) === true);
}

/* ================================================================== */
console.log('\n--- 2. Export Document (JSON) from the document context menu ---');
/* ================================================================== */
{
  const before = downloads.length;
  check('right-click "Pic one" -> "Export Document (JSON)"', await documentContextMenu('Pic one', /^Export Document \(JSON\)$/));
  const { done, subtitle, log } = await waitExportComplete();
  check('the export window reaches "Export Complete"', done);
  check('subtitle: "\\"Pic one\\" → JSON with images"', subtitle === '"Pic one" → JSON with images', subtitle);
  check('log: "Embedded 2 images"', /Embedded 2 images/.test(log) && !/missing\.png/.test(log), log.slice(0, 300));
  const file = downloads[before];
  const data = file ? JSON.parse(await file.text()) : null;
  check('file document-Pic one-<date>.json with that one document and its 2 images', !!file && file.name === `document-Pic one-${today}.json` && data.length === 1 && data[0].title === 'Pic one' && mediaOf(data, 'Pic one') === 'red.png,shared.png', file?.name);
  check('its content and category are intact', data[0].content === '# One\n\n![r](attachment:red.png)\n![s](attachment:shared.png?width=120)\n' && data[0].category === 'Pictures');
}

/* ================================================================== */
console.log('\n--- 3. Export as Base64 (all, and a single document) ---');
/* ================================================================== */
let base64All = null;
{
  clipboard = '';
  check('hamburger -> "Export All as Base64"', await hamburger(/^Export All as Base64$/));
  const modalShown = await waitFor(() => byText(document, /^Close$/) && document.querySelector('textarea') && document.querySelector('textarea').value.length > 100, 8000);
  check('the Base64 result modal shows the string and it was copied to the clipboard', !!modalShown && clipboard.length > 100 && document.querySelector('textarea').value === clipboard);
  base64All = clipboard;
  const decoded = getImportExport().importFromBase64(base64All);
  check('decoded Base64 is the same document array with media', Array.isArray(decoded) && decoded.length === 4 && mediaOf(decoded, 'Pic one') === 'red.png,shared.png' && mediaOf(decoded, 'Pic two') === 'shared.png' && !('media' in decoded.find((d) => d.title === 'Text only')));
  click(window, byText(document, /^Close$/));
  await sleep(50);

  clipboard = '';
  check('right-click "Pic two" -> "Export as Base64"', await documentContextMenu('Pic two', /^Export as Base64$/));
  await waitFor(() => clipboard.length > 50, 8000);
  const single = getImportExport().importFromBase64(clipboard);
  check('single-document Base64 holds that document with its image (shared.png) only', Array.isArray(single) && single.length === 1 && single[0].title === 'Pic two' && mediaOf(single, 'Pic two') === 'shared.png');
  const closeBtn = byText(document, /^Close$/);
  if (closeBtn) click(window, closeBtn);
  await sleep(50);
  unmountSidebar();
}

/* ================================================================== */
console.log('\n--- 4. round trips into a fresh DB ---');
/* ================================================================== */
{
  await resetTables();
  const data = JSON.parse(exportAllText);
  for (const d of data) await importDocumentFromJson(d);
  const rows = await getDocuments();
  check('Export All file -> fresh DB: 4 documents back', rows.length === 4);
  check('media library holds red/shared/other once each (unused.png never travelled)', (await mediaNames()).join() === 'other.png,red.png,shared.png');
  check('every reference with an image resolves; missing.png stays a dangling link', await referencesResolve(rows.find((r) => r.title === 'Pic one').content) && await referencesResolve(rows.find((r) => r.title === 'Elsewhere').content) && (await mediaBytes('missing.png')) === null);
  check('bytes match', (await mediaBytes('red.png')).equals(RED) && (await mediaBytes('shared.png')).equals(BLUE) && (await mediaBytes('other.png')).equals(GREEN));

  // Base64 through the real "Import from Base64" modal
  await resetTables();
  refreshCalls.length = 0;
  await mountSidebar();
  check('hamburger -> "Import from Base64"', await hamburger(/^Import from Base64$/));
  const ta = await waitFor(() => document.querySelector('textarea'), 2000);
  typeInto(window, ta, base64All);
  await sleep(10);
  check('the Base64 modal offers Dry Run beside Import Documents', !!byText(document, /^Dry Run$/) && !byText(document, /^Dry Run$/).disabled && !!byText(document, /^Import Documents$/));
  click(window, byText(document, /^Import Documents$/));
  check('the modal imports every document and asks the page to refresh', !!(await waitFor(async () => (await db.documents.count()) === 4, 8000)) && !!(await waitFor(() => refreshCalls.length === 1, 2000)));
  check('the same statistics block shows after the Base64 import, with Close', !!(await waitFor(() => document.querySelector('[data-testid="import-stats"]'), 2000)) && /Import complete/.test(document.querySelector('[data-testid="import-stats"]').textContent) && !!byText(document, /^Close$/));
  click(window, byText(document, /^Close$/));
  check('Base64 round trip: media library holds each image once and references resolve', (await mediaNames()).join() === 'other.png,red.png,shared.png' && await referencesResolve((await getDocuments()).find((r) => r.title === 'Pic one').content));
  await waitFor(() => !document.querySelector('textarea'), 2000);
  unmountSidebar();
}

/* ================================================================== */
console.log('\n--- 5. re-import into the same DB + old files ---');
/* ================================================================== */
{
  for (const d of JSON.parse(exportAllText)) await importDocumentFromJson(d);
  check('re-import: 8 documents, still 3 media rows', (await db.documents.count()) === 8 && (await db.media.count()) === 3, `${await db.media.count()}`);
  const old = JSON.parse(fixture('valid-documents.json'));
  check('an old bare-array file still validates and imports with no image activity', validateDocumentsImport(old) === true && (await importDocumentFromJson(old[0])).logs.length === 0 && (await db.media.count()) === 3);
}

process.exit(summary());
