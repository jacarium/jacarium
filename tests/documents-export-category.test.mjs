/**
 * Documents "Export Category (JSON)" (category header context menu in the
 * sidebar -> DocumentSidebar.handleExportCategory -> ExportProgressModal
 * job -> useImportExport.exportCategory -> exportToJSON -> downloadBlob),
 * end to end against the REAL modules in jsdom over fake-indexeddb, and
 * its round trip through "Import from JSON". No mocks of the code under
 * test; synthetic data only.
 *
 * THE FLOW: right-click a category header -> "Export Category (JSON)" ->
 * the export window runs a job that takes the sidebar's metadata-only list
 * filtered to `(doc.category || 'General') === name`, re-reads those
 * records from the DB (content included), serializes the FULL records as
 * a JSON array and downloads `documents-<category>-<YYYY-MM-DD>.json`
 * through a blob URL + <a download> click (Electron and the browser both
 * take that path; Electron shows its save dialog for it).
 *
 * THE BUG: the file name only lower-cased the category and replaced
 * whitespace, so a category like `Ops/Prod: "Live"?` produced a name with
 * `/`, `:`, `"` and `?` in it and the download manager rewrote it (or, with
 * the slash, treated it as a path). It is now sanitized like ZIP entry
 * names: documents-ops-prod-live-<date>.json.
 *
 * What this proves:
 *   1. Export Category (JSON) contains exactly that category's documents -
 *      locked and cloud-flagged ones included, nothing from other
 *      categories - as full records (id, stableId, title, content,
 *      category, locked, updatedAt, cloud fields where set) with content
 *      byte for byte (Unicode/emoji, code fences, mermaid), even though the
 *      sidebar's list has no content.
 *   2. "General" exports the documents stored with category "General" AND
 *      those stored with no category (the sidebar shows both there).
 *   3. The file name is documents-<sanitized-category>-<date>.json: lower
 *      case, whitespace and filesystem-illegal characters collapsed to "-",
 *      never empty; the ZIP sibling is untouched.
 *   4. An empty category exports an empty JSON array `[]` and the job
 *      completes (the file is still saved; the import side then reports
 *      "Array is empty").
 *   5. Through the real UI: right-click the category header -> "Export
 *      Category (JSON)" -> the export window reaches "Export Complete" and
 *      the download holds that category's documents.
 *   6. Round trip into a FRESH DB (no documents, no categories): Export
 *      Category (JSON) -> Import from JSON reproduces every document with
 *      identical title/content/category/locked, the category reappears in
 *      getCategories(), and the rows get new ids/stableIds.
 *   7. Round trip into the SAME DB: the documents are created a second time
 *      (no de-duplication) - a product question, pinned here.
 *
 * Run:  node tests/documents-export-category.test.mjs
 * Preconditions (checked at startup, with instructions printed if missing):
 *   - repo deps installed:               npm install
 *   - test-only deps (not in package.json, install without saving):
 *                                        npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { setupDocumentsEnv, fixture, makeChecker, byText, click, waitFor, sleep } from './helpers/jsdom-documents-env.mjs';

const { check, summary } = makeChecker();
const { mod, window, downloads } = await setupDocumentsEnv('documents-export-category');
const { documents, documentImport, db, renderSidebar, unmountSidebar, getImportExport } = mod;
const { createDocument, getDocuments, getDocumentsMetadata, getCategories } = documents;
const { validateDocumentsImport, importDocumentFromJson } = documentImport;

const VALID = JSON.parse(fixture('valid-documents.json'));
const MD = VALID[0].content; // bash fence + mermaid + table + Unicode/emoji
const WEIRD = 'Ops/Prod: "Live"?';
const today = new Date().toISOString().split('T')[0];
const snapshot = (rows) => JSON.stringify(rows.map((d) => ({ title: d.title, content: d.content, category: d.category, locked: d.locked })).sort((a, b) => a.title.localeCompare(b.title)));
const byTitle = (rows, title) => rows.find((d) => d.title === title);

async function resetTables() {
  await db.documents.clear();
  await db.documentCategories.clear();
}
async function seed() {
  await resetTables();
  await createDocument({ title: 'Runbook: Synthetic Service 🚀', content: MD, category: 'Runbooks' });
  await createDocument({ title: 'Locked runbook', content: 'locked body', category: 'Runbooks', locked: true });
  await createDocument({ title: 'Cloud runbook', content: 'cloud body', category: 'Runbooks', inCloud: true, ownerId: 'machine-synthetic', cloudDocumentId: 'room-synthetic' });
  await createDocument({ title: 'Notes – ünïcödé 日本語', content: 'notes body', category: 'Notes', locked: true });
  await createDocument({ title: 'Weird category doc', content: 'weird body', category: WEIRD });
  await createDocument({ title: 'Explicit General', content: 'g1', category: 'General' });
  await createDocument({ title: 'No category at all', content: 'g2' });
  await db.documents.where('title').equals('No category at all').modify((d) => { delete d.category; }); // createDocument defaults it; store a truly category-less row
}
/** What the sidebar does: metadata list -> exportCategory (re-reads content) -> download. */
async function exportCategoryLikeSidebar(name) {
  const ie = getImportExport();
  const list = await getDocumentsMetadata();
  const before = downloads.length;
  await ie.exportCategory(await ie.loadDocumentsWithContent(list.filter((d) => (d.category || 'General') === name)), name, 'documents', {});
  const file = downloads[before];
  return { file, data: file ? JSON.parse(await file.text()) : null };
}

/* ================================================================== */
console.log('\n--- 1. exactly that category, full records, content intact ---');
/* ================================================================== */
await seed();
{
  const { file, data } = await exportCategoryLikeSidebar('Runbooks');
  check('the download is documents-runbooks-<date>.json', !!file && file.name === `documents-runbooks-${today}.json`, file?.name);
  check('exactly the 3 Runbooks documents (locked and cloud ones included), nothing else', Array.isArray(data) && data.length === 3 && data.every((d) => d.category === 'Runbooks') && ['Runbook: Synthetic Service 🚀', 'Locked runbook', 'Cloud runbook'].every((t) => byTitle(data, t)), JSON.stringify(data?.map((d) => d.title)));
  check('full records: id, stableId, title, content, category, locked, updatedAt', data.every((d) => ['id', 'stableId', 'title', 'content', 'category', 'locked', 'updatedAt'].every((k) => k in d)), JSON.stringify(Object.keys(data[0])));
  check('cloud fields are written where set', byTitle(data, 'Cloud runbook').inCloud === true && byTitle(data, 'Cloud runbook').ownerId === 'machine-synthetic' && byTitle(data, 'Cloud runbook').cloudDocumentId === 'room-synthetic');
  check('locked is written', byTitle(data, 'Locked runbook').locked === true && byTitle(data, 'Runbook: Synthetic Service 🚀').locked === false);
  check('content is byte for byte (bash fence, mermaid, table, Unicode/emoji, escapes)', byTitle(data, 'Runbook: Synthetic Service 🚀').content === MD);
  const text = await file.text();
  check('the file is pretty-printed JSON (2-space indent) and parses back to the same records', text.startsWith('[\n  {\n    "') && JSON.stringify(JSON.parse(text)) === JSON.stringify(data));
  check('the file text keeps Unicode unescaped', text.includes('🚀') && text.includes('日本語'));
}

/* ================================================================== */
console.log('\n--- 2. General = stored "General" + category-less rows ---');
/* ================================================================== */
{
  const { data } = await exportCategoryLikeSidebar('General');
  check('General exports the explicit General doc and the category-less doc', data.length === 2 && !!byTitle(data, 'Explicit General') && !!byTitle(data, 'No category at all'), JSON.stringify(data.map((d) => [d.title, d.category])));
  check('the category-less row is written without a category (as stored)', !('category' in byTitle(data, 'No category at all')));
}

/* ================================================================== */
console.log('\n--- 3. file name sanitization ---');
/* ================================================================== */
{
  const { file, data } = await exportCategoryLikeSidebar(WEIRD);
  check(`"${WEIRD}" -> documents-ops-prod-live-<date>.json (no / : " ? in the name)`, !!file && file.name === `documents-ops-prod-live-${today}.json`, file?.name);
  check('...and it holds that category\'s document with the raw category name inside', data.length === 1 && data[0].category === WEIRD);
  const ie = getImportExport();
  const cases = [
    ['  Spaced   Out  ', 'documents-spaced-out-'],
    ['Ünïcödé 日本語 📝', 'documents-ünïcödé-日本語-📝-'],
    ['...', 'documents-category-'],
    ['???', 'documents-category-'],
    ['a\\b|c<d>e*f', 'documents-a-b-c-d-e-f-'],
    ['tab\there', 'documents-tab-here-'],
  ];
  for (const [name, prefix] of cases) {
    const before = downloads.length;
    await ie.exportCategory([{ title: 'x', content: 'y', category: name }], name, 'documents', {});
    const got = downloads[before]?.name;
    check(`category ${JSON.stringify(name)} -> ${prefix}<date>.json`, got === `${prefix}${today}.json`, got);
  }
}

/* ================================================================== */
console.log('\n--- 4. empty category ---');
/* ================================================================== */
{
  const ie = getImportExport();
  const before = downloads.length;
  const logs = [];
  const ok = await ie.exportCategory([], 'Empty Folder', 'documents', { onProgress: (u) => { if (u.log) logs.push(u.log); } });
  const file = downloads[before];
  check('an empty category still completes and downloads documents-empty-folder-<date>.json', ok === true && !!file && file.name === `documents-empty-folder-${today}.json`, file?.name);
  check('the file is an empty JSON array', (await file.text()) === '[]');
  check('the progress log reports the save with its size', logs.some((l) => /^Saved documents-empty-folder-.*\.json \(2 B\)$/.test(l)), JSON.stringify(logs));
  check('the import side rejects that file with "Array is empty"', validateDocumentsImport(JSON.parse(await file.text())) === 'Array is empty: No documents to import');
}

/* ================================================================== */
console.log('\n--- 5. through the real sidebar context menu ---');
/* ================================================================== */
{
  const list = await getDocumentsMetadata();
  renderSidebar({ documents: list, categories: await getCategories(), onImportDocument: importDocumentFromJson });
  const header = Array.from(document.querySelectorAll('span.text-sm.font-medium.truncate')).find((s) => s.textContent === 'Runbooks');
  check('the sidebar renders the Runbooks category header', !!header);
  const before = downloads.length;
  header.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const item = await waitFor(() => byText(document, /^Export Category \(JSON\)$/), 2000);
  check('right-click opens the category context menu with "Export Category (JSON)"', !!item);
  click(window, item);
  const done = await waitFor(() => byText(document, /^Export Complete$/, 'h3'), 8000);
  check('the export window reaches "Export Complete"', !!done);
  check('the window names the category and the count', !!byText(document, /^"Runbooks" \(3 documents\) → JSON with images$/, 'p'));
  const file = downloads[before];
  check('the download is that category\'s file', !!file && file.name === `documents-runbooks-${today}.json`, file?.name);
  const data = file ? JSON.parse(await file.text()) : null;
  check('...with its 3 documents and their content', Array.isArray(data) && data.length === 3 && byTitle(data, 'Runbook: Synthetic Service 🚀')?.content === MD);
  const closeBtn = byText(document, /^(Close|Done)$/);
  if (closeBtn) click(window, closeBtn);
  await sleep(50);
  unmountSidebar();
}

/* ================================================================== */
console.log('\n--- 6. round trip into a fresh DB ---');
/* ================================================================== */
{
  const { data: exported } = await exportCategoryLikeSidebar('Runbooks');
  const original = snapshot((await getDocuments()).filter((d) => d.category === 'Runbooks'));
  await resetTables();
  check('fresh DB: no documents, no categories', (await db.documents.count()) === 0 && (await getCategories()).length === 0);
  check('the exported file validates for Import from JSON', validateDocumentsImport(exported) === true);
  for (const d of exported) await importDocumentFromJson(d);
  const rows = await getDocuments();
  check('every document is back with identical title/content/category/locked', rows.length === 3 && snapshot(rows) === original);
  check('the Runbooks category reappears in getCategories()', (await getCategories()).includes('Runbooks'));
  check('the rows are new (ids and stableIds differ from the file)', rows.every((r) => !exported.some((e) => e.id === r.id || e.stableId === r.stableId)));
  check('cloud flags from the file are NOT carried over (the copy is a local document)', rows.every((r) => !r.inCloud && !r.ownerId && !r.cloudDocumentId));
  check('the locked flag IS carried over', byTitle(rows, 'Locked runbook').locked === true);

  /* ---- 7. round trip into the same DB ---- */
  for (const d of exported) await importDocumentFromJson(d);
  const twice = await getDocumentsMetadata();
  check('re-importing into the same DB creates the documents again (6 rows, each title twice) - no de-duplication', twice.length === 6 && ['Runbook: Synthetic Service 🚀', 'Locked runbook', 'Cloud runbook'].every((t) => twice.filter((d) => d.title === t).length === 2));
}

process.exit(summary());
