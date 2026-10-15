/**
 * Documents "Import from JSON" (sidebar hamburger menu -> ImportFlow:
 * ImportInputModal -> ImportModal -> DocumentsPage.handleImportDocument),
 * end to end against the REAL modules in jsdom over fake-indexeddb: the
 * real DocumentSidebar (which owns the flow), the real modals, the real
 * src/utils/documentImport.js (validation + field mapping), the real
 * src/utils/documents.js over the real Dexie schema. No mocks of the code
 * under test; synthetic data only (tests/fixtures/documents-import/).
 *
 * THE FLOW: paste JSON or choose/drop a .json file -> "Import Documents"
 * (or "Dry Run") parses it and runs validateDocumentsImport (nothing is
 * written unless it returns true) -> the progress modal runs
 * runDocumentsImport, which creates ONE document per array item through
 * importDocumentFromJson() (title/content/category/locked only; fresh
 * id/stableId/updatedAt; a missing category is "General"), logs each
 * result and ends in the statistics block -> Close.
 *
 * What this proves:
 *   1. validateDocumentsImport accepts an array of documents (each with a
 *      title or content string) and rejects, with a specific message and
 *      no write: non-arrays (incl. a single document object and a whole
 *      Export Database backup, each with a pointed hint), an empty array,
 *      items that are not objects, items missing both title and content,
 *      and non-text title/content.
 *   2. toImportedDocument maps only title/content/category/locked, drops
 *      id/stableId/updatedAt/cloud fields, defaults the category to
 *      General (also for a non-string category) and coerces locked.
 *   3. Imported rows come back through the normal list path
 *      (getDocumentsMetadata: indexed updatedAt set, newest first), under
 *      the right category in getCategories() (a new category appears
 *      without a managed row), with fresh unique stableIds and ids.
 *   4. Content survives byte for byte: Markdown with a bash code fence, a
 *      mermaid block, a table, Unicode/emoji, tabs/quotes/backslashes, a
 *      trailing-whitespace line, and a 2 MB body.
 *   5. Re-importing the same file creates the documents again (no
 *      de-duplication by title or stableId) - reported as a product
 *      question, asserted here so a change is deliberate.
 *   6. UI, paste mode: hamburger -> "Import from JSON" -> paste ->
 *      Import Documents -> progress modal logs every document and reaches
 *      "Import Complete" with the statistics -> Close; the rows are in the
 *      DB and the sidebar lists the new category after a refresh.
 *   7. UI, file mode: choosing a file through the hidden input and dropping
 *      one on the zone both show a compact file chip (name + size, with
 *      "Choose different file" and a Remove button; no content preview) and
 *      import; a non-JSON drop shows "Please drop a JSON file".
 *   8. UI, errors: malformed JSON, an empty array, a single object, a
 *      database backup and a bad-items file each show a Validation Error
 *      with the specific message and write NOTHING (not even the valid
 *      items of a partly-bad file); an empty file leaves the buttons disabled.
 *   9. Round trips: Export All (JSON) -> import into an emptied DB
 *      reproduces title/content/category/locked; Export as Base64 ->
 *      Import from Base64 too; the Export Database file is rejected whole
 *      with the "use Import Database" hint, and its "documents" array
 *      imports.
 *
 * Run:  node tests/documents-import-json.test.mjs
 * Preconditions (checked at startup, with instructions printed if missing):
 *   - repo deps installed:               npm install
 *   - test-only deps (not in package.json, install without saving):
 *                                        npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { setupDocumentsEnv, fixture, makeChecker, typeInto, byText, click, waitFor, chooseFile, dropFile, sleep } from './helpers/jsdom-documents-env.mjs';

const { check, summary } = makeChecker();
const { mod, window, downloads } = await setupDocumentsEnv('documents-import-json');
const { documents, documentImport, documentCategories, collectExportData, db, renderSidebar, unmountSidebar, getImportExport } = mod;
const { createDocument, getDocument, getDocuments, getDocumentsMetadata, getCategories } = documents;
const { validateDocumentsImport, toImportedDocument, importDocumentFromJson, looksLikeDatabaseBackup } = documentImport;

const VALID = JSON.parse(fixture('valid-documents.json'));
const byTitle = (rows, title) => rows.find((d) => d.title === title);
async function resetTables() {
  await db.documents.clear();
  await db.documentCategories.clear();
}
async function importAll(items) {
  const ids = [];
  for (const item of items) ids.push((await importDocumentFromJson(item)).id);
  return ids;
}

/* ================================================================== */
console.log('\n--- 1. validateDocumentsImport ---');
/* ================================================================== */
{
  check('an array of documents validates (fixture valid-documents.json)', validateDocumentsImport(VALID) === true);
  check('an array with a single title-only document validates', validateDocumentsImport([{ title: 'T' }]) === true);
  check('an array with a single content-only document validates', validateDocumentsImport([{ content: 'C' }]) === true);
  for (const [label, value] of [['null', null], ['a string', 'x'], ['a number', 1], ['true', true], ['an empty object', {}]]) {
    const r = validateDocumentsImport(value);
    check(`${label} is rejected with the generic "Expected an array" message`, r === 'Invalid format: Expected an array of documents', r);
  }
  const single = validateDocumentsImport(JSON.parse(fixture('single-document.json')));
  check('a single document object is rejected with the "wrap it in [ ... ]" hint', /single document - wrap it in \[ \.\.\. \]/.test(single), single);
  const backup = JSON.parse(fixture('database-backup.json'));
  check('looksLikeDatabaseBackup recognizes the Export Database shape', looksLikeDatabaseBackup(backup) && !looksLikeDatabaseBackup(VALID) && !looksLikeDatabaseBackup({ documents: 'x' }));
  const backupMsg = validateDocumentsImport(backup);
  check('a database backup is rejected pointing at Import Database / its "documents" array', /Import Database/.test(backupMsg) && /"documents" array/.test(backupMsg), backupMsg);
  check('an empty array is rejected', validateDocumentsImport([]) === 'Array is empty: No documents to import');
  const items = JSON.parse(fixture('invalid-items.json'));
  const r1 = validateDocumentsImport(items);
  check('items that are not objects are reported first, by 1-based position (null at 3, string at 4)', r1 === 'Invalid document structure: Items at positions 3, 4 are not document objects', r1);
  const r2 = validateDocumentsImport(items.filter((d) => d !== null && typeof d === 'object'));
  check('a non-text title is reported by position', r2 === 'Invalid document structure: Documents at positions 3 have a title or content that is not text', r2);
  const r3 = validateDocumentsImport([{ title: 'ok', content: 'ok' }, { category: 'x' }, { title: '', content: '' }, { title: null }]);
  check('missing title+content is reported by position (empty strings and null count as missing)', r3 === 'Invalid document structure: Documents at positions 2, 3, 4 are missing both title and content', r3);
  const r4 = validateDocumentsImport([{ title: 'ok', content: { nested: true } }, { title: 'ok', content: ['x'] }, { title: 'ok', content: 7 }]);
  check('object/array/number content is rejected as non-text', r4 === 'Invalid document structure: Documents at positions 1, 2, 3 have a title or content that is not text', r4);
}

/* ================================================================== */
console.log('\n--- 2. toImportedDocument field mapping ---');
/* ================================================================== */
{
  const exported = {
    id: 99, stableId: 'aaaaaaaa-0000-4000-8000-000000000099', title: 'Exported', content: 'body', category: 'Ops',
    locked: true, updatedAt: 1, inCloud: true, ownerId: 'machine-x', cloudDocumentId: 'room-1', permissions: { read: ['*'] }, createdAt: 2,
  };
  const m = toImportedDocument(exported);
  check('only title/content/category/locked are taken', JSON.stringify(Object.keys(m).sort()) === JSON.stringify(['category', 'content', 'locked', 'title']), JSON.stringify(m));
  check('values pass through', m.title === 'Exported' && m.content === 'body' && m.category === 'Ops' && m.locked === true);
  check('missing title -> "Untitled Document", missing content -> "", missing category -> "General", missing locked -> false',
    JSON.stringify(toImportedDocument({ content: 'c' })) === JSON.stringify({ title: 'Untitled Document', content: 'c', category: 'General', locked: false }));
  check('a non-string category (number/null/object/"") falls back to General',
    ['General'].every((g) => [5, null, { a: 1 }, ''].every((c) => toImportedDocument({ title: 't', category: c }).category === g)));
  check('locked is coerced to a boolean ("yes"/1/null -> false; true -> true)',
    toImportedDocument({ title: 't', locked: 'yes' }).locked === false && toImportedDocument({ title: 't', locked: 1 }).locked === false && toImportedDocument({ title: 't', locked: null }).locked === false && toImportedDocument({ title: 't', locked: true }).locked === true);
}

/* ================================================================== */
console.log('\n--- 3. rows, list visibility, categories, identities ---');
/* ================================================================== */
await resetTables();
{
  const t0 = Date.now();
  const ids = await importAll(VALID);
  check('one row per imported document, ids are fresh and unique', ids.length === 4 && new Set(ids).size === 4 && ids.every((id) => typeof id === 'number'), JSON.stringify(ids));
  const rows = await getDocumentsMetadata();
  check('all imported documents come back through getDocumentsMetadata()', rows.length === 4 && VALID.every((d) => byTitle(rows, d.title || 'Untitled Document')), JSON.stringify(rows.map((r) => r.title)));
  check('every row has an indexed updatedAt set at import time', rows.every((r) => typeof r.updatedAt === 'number' && r.updatedAt >= t0), JSON.stringify(rows.map((r) => r.updatedAt)));
  check('the list is newest first (updatedAt descending)', rows.every((r, i) => i === 0 || rows[i - 1].updatedAt >= r.updatedAt));
  check('every row got a fresh, unique stableId (not from the file)', rows.every((r) => /^[0-9a-f-]{36}$/.test(r.stableId)) && new Set(rows.map((r) => r.stableId)).size === 4);
  check('categories map: Runbooks / Notes / General (content-only doc)', byTitle(rows, 'Runbook: Synthetic Service 🚀').category === 'Runbooks' && byTitle(rows, 'Notes – ünïcödé 日本語').category === 'Notes' && byTitle(rows, 'Content-only (no category)').category === 'General' && byTitle(rows, 'Title-only document').category === 'Runbooks');
  check('locked is preserved (true for the Notes doc, false elsewhere)', byTitle(rows, 'Notes – ünïcödé 日本語').locked === true && byTitle(rows, 'Runbook: Synthetic Service 🚀').locked === false);
  check('a title-only document is stored with empty content', (await getDocument(byTitle(rows, 'Title-only document').id)).content === '');
  check('imported documents are NOT marked as cloud documents', rows.every((r) => !r.inCloud && !r.ownerId && !r.cloudDocumentId));
  const cats = await getCategories();
  check('getCategories() lists the new categories (document-derived) and General', ['Runbooks', 'Notes', 'General'].every((c) => cats.includes(c)) && new Set(cats).size === cats.length, JSON.stringify(cats));
  check('no managed category row is created by the import (categories are derived from documents)', (await documentCategories.getDocumentCategories()).length === 0);
  check('documents by category: 2 Runbooks, 1 Notes', (await documents.getDocumentsByCategory('Runbooks')).length === 2 && (await documents.getDocumentsByCategory('Notes')).length === 1);
}

/* ================================================================== */
console.log('\n--- 4. content fidelity ---');
/* ================================================================== */
await resetTables();
{
  const big = 'x'.repeat(1024 * 1024) + '\n```mermaid\nsequenceDiagram\n  A->>B: hi 📝\n```\n' + 'y'.repeat(1024 * 1024);
  const items = [...VALID, { title: 'Two megabytes', content: big, category: 'Big' }];
  await importAll(items);
  const stored = await getDocuments();
  for (const item of items) {
    const row = byTitle(stored, item.title);
    const expected = typeof item.content === 'string' ? item.content : '';
    check(`"${item.title}" content is byte-for-byte identical (${expected.length} chars)`, !!row && row.content === expected, row ? `${row.content.length} chars` : 'missing');
  }
  const md = byTitle(stored, 'Runbook: Synthetic Service 🚀').content;
  check('code fence, mermaid block, table, tab, backslash and trailing-whitespace line are intact',
    md.includes('```bash\n# restart') && md.includes('```mermaid\ngraph TD\n  A[Request] -->|validate| B{Valid?}') && md.includes('| unicode | ünïcödé – 日本語 – العربية |') && md.includes('tabs\there') && md.includes('back\\slash') && md.includes('Trailing whitespace line   \n') && md.endsWith('Final line without newline'));
  check('Unicode title round-trips', !!byTitle(stored, 'Notes – ünïcödé 日本語'));
}

/* ================================================================== */
console.log('\n--- 5. duplicates (product question: no de-duplication) ---');
/* ================================================================== */
await resetTables();
{
  await importAll(VALID);
  const first = await getDocumentsMetadata();
  await importAll(VALID);
  const second = await getDocumentsMetadata();
  check('importing the same file twice creates every document again (no dedupe by title)', first.length === 4 && second.length === 8 && second.filter((d) => d.title === 'Runbook: Synthetic Service 🚀').length === 2);
  const exportedTwice = [{ ...VALID[0], stableId: 'aaaaaaaa-0000-4000-8000-00000000abcd', id: 7 }];
  await importAll(exportedTwice);
  await importAll(exportedTwice);
  const sameStable = (await getDocumentsMetadata()).filter((d) => d.stableId === 'aaaaaaaa-0000-4000-8000-00000000abcd');
  check('a stableId in the file is never reused: both copies get fresh ids (so the DB never holds two rows with one stableId)', sameStable.length === 0 && (await db.documents.count()) === 10);
}

/* ================================================================== */
console.log('\n--- 6. UI flow (real DocumentSidebar): paste -> validate -> progress -> Done ---');
/* ================================================================== */
await resetTables();
const refreshCalls = [];
function sidebarProps(extra = {}) {
  return { documents: [], categories: [], onRefreshDocuments: async () => { refreshCalls.push(1); }, ...extra };
}
// React 18 commits a click's state in a microtask: give it a tick between
// each click and the next query.
const tick = () => sleep(10);
async function openImportModal() {
  const menuButton = Array.from(document.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-menu'));
  if (!menuButton) return null;
  click(window, menuButton);
  await tick();
  const item = byText(document, /^Import from JSON$/);
  if (!item) return null;
  click(window, item);
  await tick();
  return document.querySelector('textarea');
}
// "Import Documents" parses + validates the input, then hands over to the
// progress modal (or shows the Validation Error in place).
async function validateAndWait(re, tag = 'div', timeoutMs = 5000) {
  click(window, byText(document, /^Import Documents$/));
  return waitFor(() => byText(document, re, tag), timeoutMs);
}
{
  renderSidebar(sidebarProps());
  const textarea = await openImportModal();
  check('hamburger menu -> "Import from JSON" opens the input modal with a textarea', !!textarea);
  check('"Import Documents" and "Dry Run" are disabled while the textarea is empty', byText(document, /^Import Documents$/).disabled === true && byText(document, /^Dry Run$/).disabled === true);
  typeInto(window, textarea, fixture('valid-documents.json'));
  await tick();
  check('the line counter follows the pasted text', !!byText(document, /^\d+ lines$/, 'div'));
  const done = await validateAndWait(/^Import Complete$/, 'h3', 8000);
  check('a valid paste reaches the progress modal and "Import Complete"', !!done);
  check('the sidebar asked the page to refresh its list once the import finished', refreshCalls.length === 1);
  const log = document.querySelector('.os-terminal');
  check('the log reports each document and the completion line', !!log && VALID.every((d) => log.textContent.includes(`Imported "${d.title}"`)) && /Import completed\. 4 document\(s\) imported\./.test(log.textContent), log && log.textContent.slice(0, 300));
  const stats = document.querySelector('[data-testid="import-stats"]');
  check('the statistics block shows "Import complete" with 4 documents', !!stats && /Import complete/.test(stats.textContent) && /4 documents created in 3 categories \(3 new categories\)/.test(stats.textContent), stats && stats.textContent.slice(0, 200));
  const rows = await getDocumentsMetadata();
  check('the four documents are in the DB with their categories', rows.length === 4 && byTitle(rows, 'Notes – ünïcödé 日本語')?.category === 'Notes');
  click(window, byText(document, /^Close$/));
  check('Close closes the progress modal', !!(await waitFor(() => !byText(document, /^Import Complete$/, 'h3'), 2000)));
  renderSidebar(sidebarProps({ documents: rows, categories: await getCategories() }));
  const headers = Array.from(document.querySelectorAll('span.text-sm.font-medium.truncate')).map((s) => s.textContent);
  check('after a refresh the sidebar lists the imported categories', ['Runbooks', 'Notes', 'General'].every((c) => headers.includes(c)), JSON.stringify(headers));
}

/* ================================================================== */
console.log('\n--- 7. UI flow: file mode (choose + drop) ---');
/* ================================================================== */
await resetTables();
{
  renderSidebar(sidebarProps());
  await openImportModal();
  click(window, byText(document, /^Upload File$/));
  await tick();
  const input = document.querySelector('input[type="file"]');
  check('the Upload File tab shows the drop zone and a hidden file input', !!input && !!document.querySelector('[data-testid="import-drop-zone"]'));
  chooseFile(window, input, new window.File([fixture('valid-documents.json')], 'documents-export.json', { type: 'application/json' }));
  const chip = await waitFor(() => document.querySelector('[data-testid="import-file-chip"]'), 3000);
  check('a chosen file is shown as a compact chip (name + size), with no content preview', !!chip && !!byText(document, /^documents-export\.json$/, 'p') && !!byText(document, /^\d+\.\d+ KB$/, 'p') && !document.querySelector('pre.os-terminal') && !byText(document, /^File Preview$/, 'div'));
  check('the buttons enable once the file has been read', !!(await waitFor(() => !byText(document, /^Import Documents$/).disabled, 3000)));
  check('the chip offers "Choose different file" and a Remove button; Remove clears the file and disables the buttons again', !!byText(document, /^Choose different file$/) && !!document.querySelector('[data-testid="import-file-chip"] button[aria-label="Remove file"]') && (() => { click(window, document.querySelector('[data-testid="import-file-chip"] button[aria-label="Remove file"]')); return true; })() && !!(await waitFor(() => !document.querySelector('[data-testid="import-file-chip"]') && byText(document, /^Import Documents$/).disabled, 2000)));
  // Remove while the file is still being read: the late read result must not repopulate the input
  chooseFile(window, document.querySelector('input[type="file"]'), new window.File([fixture('valid-documents.json')], 'documents-export.json', { type: 'application/json' }));
  await waitFor(() => document.querySelector('[data-testid="import-file-chip"]'), 3000);
  click(window, document.querySelector('[data-testid="import-file-chip"] button[aria-label="Remove file"]'));
  await sleep(100);
  check('Remove during the read discards the read (buttons stay disabled, no chip)', !document.querySelector('[data-testid="import-file-chip"]') && byText(document, /^Import Documents$/).disabled);
  chooseFile(window, document.querySelector('input[type="file"]'), new window.File([fixture('valid-documents.json')], 'documents-export.json', { type: 'application/json' }));
  check('choosing again after a Remove reads the file and enables the buttons', !!(await waitFor(() => document.querySelector('[data-testid="import-file-chip"]') && !byText(document, /^Import Documents$/).disabled, 3000)));
  check('a chosen file imports', !!(await validateAndWait(/^Import Complete$/, 'h3', 8000)) && (await db.documents.count()) === 4);
  click(window, byText(document, /^Close$/));
  await waitFor(() => !byText(document, /^Import Complete$/, 'h3'), 2000);

  // Drop
  await openImportModal();
  click(window, byText(document, /^Upload File$/));
  await tick();
  const zone = document.querySelector('[data-testid="import-drop-zone"]');
  dropFile(window, zone, new window.File(['hello'], 'notes.txt', { type: 'text/plain' }));
  check('dropping a non-JSON file shows "Please drop a JSON file"', !!(await waitFor(() => byText(document, /^Please drop a JSON file$/, 'div'), 2000)));
  dropFile(window, zone, new window.File([JSON.stringify([{ title: 'Dropped', content: 'via drag and drop', category: 'Drops' }])], 'drop.json', { type: 'application/json' }));
  check('dropping a .json file loads it (the error clears, the chip shows the file)', !!(await waitFor(() => document.querySelector('[data-testid="import-file-chip"]'), 3000)) && !!byText(document, /^drop\.json$/, 'p') && !byText(document, /^Please drop a JSON file$/, 'div'));
  check('a dropped file imports', !!(await validateAndWait(/^Import Complete$/, 'h3', 8000)) && !!byTitle(await getDocumentsMetadata(), 'Dropped'));
  click(window, byText(document, /^Close$/));
  await waitFor(() => !byText(document, /^Import Complete$/, 'h3'), 2000);
}

/* ================================================================== */
console.log('\n--- 8. UI flow: errors write nothing ---');
/* ================================================================== */
await resetTables();
{
  const cases = [
    ['malformed.json', /^Invalid JSON: /],
    ['empty-array.json', /^Array is empty: No documents to import$/],
    ['single-document.json', /wrap it in \[ \.\.\. \]/],
    ['database-backup.json', /Use Import Database from the app menu/],
    ['invalid-items.json', /^Invalid document structure: Items at positions 3, 4 are not document objects$/],
  ];
  for (const [file, re] of cases) {
    renderSidebar(sidebarProps());
    const textarea = await openImportModal();
    typeInto(window, textarea, fixture(file));
    await tick();
    const err = await validateAndWait(re, 'div', 3000);
    check(`${file}: a Validation Error with the specific message is shown`, !!err && !!byText(document, /^Validation Error$/, 'div'), err ? err.textContent : 'no error element');
    await sleep(600); // longer than the success hand-over delay: no progress modal may appear
    check(`${file}: no progress modal, nothing written`, !byText(document, /^Import Complete$/, 'h3') && !byText(document, /^Importing Documents/, 'h3') && (await db.documents.count()) === 0);
    click(window, byText(document, /^Cancel$/));
    await waitFor(() => !document.querySelector('textarea'), 2000);
  }
  renderSidebar(sidebarProps());
  const textarea = await openImportModal();
  typeInto(window, textarea, fixture('empty-file.json'));
  await tick();
  check('empty-file.json: Import Documents / Dry Run stay disabled (nothing to parse)', byText(document, /^Import Documents$/).disabled === true && byText(document, /^Dry Run$/).disabled === true);
  typeInto(window, textarea, '   \n  ');
  await tick();
  check('whitespace only: Import Documents stays disabled', byText(document, /^Import Documents$/).disabled === true);
  click(window, byText(document, /^Cancel$/));
  await waitFor(() => !document.querySelector('textarea'), 2000);
  unmountSidebar();
}

/* ================================================================== */
console.log('\n--- 9. round trips ---');
/* ================================================================== */
await resetTables();
{
  const ie = getImportExport();
  check('useImportExport exposes the export functions', typeof ie.exportToJSON === 'function' && typeof ie.loadDocumentsWithContent === 'function' && typeof ie.exportToBase64 === 'function' && typeof ie.importFromBase64 === 'function');
  await importAll(VALID);
  const original = (await getDocuments()).map((d) => ({ title: d.title, content: d.content, category: d.category, locked: d.locked }));
  const snapshot = (rows) => JSON.stringify(rows.map((d) => ({ title: d.title, content: d.content, category: d.category, locked: d.locked })).sort((a, b) => a.title.localeCompare(b.title)));

  // (a) Export All (JSON): what the sidebar does - metadata list -> re-read content -> file
  const metadata = await getDocumentsMetadata();
  check('the sidebar list is metadata only (no content key)', metadata.every((d) => !('content' in d)));
  await ie.exportToJSON(await ie.loadDocumentsWithContent(metadata), 'documents', {});
  const file = downloads.at(-1);
  check('Export All (JSON) downloads documents-YYYY-MM-DD.json', !!file && /^documents-\d{4}-\d{2}-\d{2}\.json$/.test(file.name), file?.name);
  const exportedText = await file.text();
  const exported = JSON.parse(exportedText);
  check('the export is a JSON array of full records (id, stableId, title, content, category, locked, updatedAt)', Array.isArray(exported) && exported.length === 4 && exported.every((d) => ['id', 'stableId', 'title', 'content', 'category', 'locked', 'updatedAt'].every((k) => k in d)));
  check('the exported file validates for Import from JSON', validateDocumentsImport(exported) === true);
  await resetTables(); // "fresh DB": no documents, no categories
  await importAll(exported);
  const reimported = await getDocuments();
  check('Export All (JSON) -> Import from JSON into a fresh DB reproduces title/content/category/locked', snapshot(reimported) === snapshot(original));
  check('the re-imported rows have new ids and new stableIds', reimported.every((d) => !exported.some((e) => e.id === d.id && e.stableId === d.stableId)));
  const catsAfter = await getCategories();
  check('the categories exist again (derived from the documents)', ['Runbooks', 'Notes', 'General'].every((c) => catsAfter.includes(c)), JSON.stringify(catsAfter));

  // (b) Export as Base64 -> Import from Base64 (same per-document import path)
  let clipboard = '';
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => { clipboard = t; } }, configurable: true });
  await ie.exportToBase64(await ie.loadDocumentsWithContent(await getDocumentsMetadata()));
  const decoded = ie.importFromBase64(clipboard);
  check('Export as Base64 -> importFromBase64 yields the same 4 records', Array.isArray(decoded) && decoded.length === 4 && validateDocumentsImport(decoded) === true && snapshot(decoded) === snapshot(original));

  // (c) Export Database -> Import from JSON: rejected whole, its documents array imports
  const backup = await collectExportData(() => {}, { fetchTasks: async () => { throw new Error('no backend in this test'); } });
  const whole = validateDocumentsImport(backup);
  check('the Export Database object is rejected with the Import Database hint', typeof whole === 'string' && /Import Database/.test(whole), whole);
  check('...and its "documents" array validates and matches the Documents export', validateDocumentsImport(backup.documents) === true && snapshot(backup.documents) === snapshot(original));
  await resetTables();
  await importAll(backup.documents);
  check('importing the backup\'s "documents" array reproduces the documents', snapshot(await getDocuments()) === snapshot(original));
}

process.exit(summary());
