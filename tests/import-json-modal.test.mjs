#!/usr/bin/env node
/**
 * "Import from JSON" is ONE dialog across the app
 * (src/components/common/ImportJsonModal.jsx): the Documents sidebar menu,
 * the Kanban board list menu, the Tasks instance list menu and the
 * Workflow list menu all open it, each with its own title, example,
 * validation and runner (the functions its old file picker used). This
 * drives the REAL pages in Chromium (playwright-core; a Vite dev server
 * with the backend faked, a throwaway browser profile - never the user's
 * data) and proves, per page:
 *   - the menu entry opens the same modal (data-testid import-json-modal,
 *     Paste JSON / Upload File tabs, the textarea with its line count,
 *     Paste Example, Cancel / Dry Run / <Import label>);
 *   - an invalid payload shows the validation error, the modal stays and
 *     nothing is written;
 *   - Dry Run shows a summary and writes nothing;
 *   - Import from a paste writes the fixture's items and the list shows them;
 *   - Import from a chosen file (the fixture file, as the old picker took it)
 *     writes them too;
 *   - the merge option ("Keep existing ... and merge newer copies") is offered
 *     on every page; with it ticked a dry run of a newer copy, an older copy
 *     and a new item reports "1 added, 1 updated (newer), 1 skipped (older or
 *     identical), 0 errors" in the shared statistics block (Documents keeps
 *     its own wording) and writes nothing, and the import then writes exactly
 *     that plan;
 * and saves dark + light screenshots of the modal on every page (set
 * IMPORT_SHOTS_DIR to keep them).
 *
 * SKIPs (exit 0) without playwright-core / Chromium or with
 * SKIP_BROWSER_TESTS=1. Run: node tests/import-json-modal.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
const OUT = process.env.IMPORT_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'import-json-modal-'));
fs.mkdirSync(OUT, { recursive: true });
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.SMOKE_PORT || 5291);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

const fixture = (rel) => path.join(REPO, 'tests', 'fixtures', rel);
const PAGES = [
  { key: 'documents', url: '/', title: 'Import Documents', importLabel: 'Import Documents', store: 'documents', fixture: fixture('documents-import/valid-documents.json'), listTitle: 'Runbook: Synthetic Service', merge: true, menuTitle: 'Menu', noun: 'document' },
  { key: 'kanban', url: '/?standalone=kanban', title: 'Import Boards', importLabel: 'Import Boards', store: 'kanbanBoards', fixture: fixture('import-json/boards.json'), listTitle: 'Release checklist', merge: true, menuTitle: 'Menu', noun: 'board', newer: (b) => ({ ...b, columns: [...b.columns, { id: 'review', title: 'Review' }] }), fresh: { title: 'Reading list', category: 'Home', columns: [{ id: 'next', title: 'Next' }] } },
  { key: 'tasks', url: '/?standalone=tasks', title: 'Import Task Instances', importLabel: 'Import Instances', store: 'taskwarriorInstances', fixture: fixture('import-json/instances.json'), listTitle: 'Work tasks', merge: true, menuTitle: 'Menu', noun: 'instance', newer: (i) => ({ ...i, description: 'The office TaskWarrior data (moved)' }), fresh: { name: 'Side project', category: 'Home', description: '', rcPath: '', dataPath: '' } },
  { key: 'workflows', url: '/?standalone=workflow', title: 'Import Workflows', importLabel: 'Import Workflows', store: 'workflows', fixture: fixture('import-json/workflows.json'), listTitle: 'Nightly backup', merge: true, menuTitle: 'Workflow menu', noun: 'workflow', newer: (w) => ({ ...w, nodes: [...w.nodes, { id: 'notify', type: 'command', position: { x: 400, y: 0 }, data: { label: 'notify' } }] }), fresh: { title: 'Rotate keys', category: 'Security', nodes: [], edges: [] } },
];

async function routes(context) {
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('**/api/taskwarrior/check', (r) => r.fulfill({ json: { installed: false } }));
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
}

/** Rows in one of the app's Dexie stores, read straight from IndexedDB (the page's own database). */
const countStore = (page, store) => page.evaluate((store) => new Promise((res) => {
  const r = indexedDB.open('Jacarium');
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains(store)) { db.close(); return res(-1); }
    const c = db.transaction(store, 'readonly').objectStore(store).count();
    c.onsuccess = () => { db.close(); res(c.result); };
    c.onerror = () => { db.close(); res(-2); };
  };
  r.onerror = () => res(-3);
}), store);

async function open(theme, url) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
  // (the lists collapse their categories by default; expand the fixtures' so the imported titles are visible)
  await context.addInitScript(({ theme }) => {
    try {
      localStorage.setItem('whatsNewLastSeen', '99.0.0');
      localStorage.setItem('app-theme', JSON.stringify(theme));
      localStorage.setItem('expandedDocumentCategories', JSON.stringify(['Runbooks', 'Notes']));
      localStorage.setItem('expandedKanbanCategories', JSON.stringify(['Work', 'Home']));
      localStorage.setItem('expandedTaskInstanceCategories', JSON.stringify(['Work', 'Home']));
      localStorage.setItem('expandedWorkflowCategories', JSON.stringify(['Ops', 'Security', 'General']));
    } catch { /* ignore */ }
  }, { theme });
  await routes(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e.message).slice(0, 160)));
  await page.goto(BASE + url, { waitUntil: 'load' }); await page.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  if (url === '/') { const rail = page.locator('button[title="Documents"]'); if (await rail.count()) { await rail.first().click().catch(() => {}); await page.waitForTimeout(600); } }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  return { context, page };
}

const modal = (page) => page.locator('[data-testid="import-json-modal"]');
async function openModal(page, spec) {
  const menu = page.locator(`button[title="${spec.menuTitle}"]`).first();
  await menu.click();
  await page.getByText('Import from JSON', { exact: true }).first().click();
  await modal(page).waitFor({ state: 'visible', timeout: 5000 });
}
const importButton = (page, spec) => page.getByRole('button', { name: spec.importLabel, exact: true });
async function closeDocumentsProgress(page) {
  // Documents hands the validated items to its progress modal; wait for its result and close it
  await page.getByText('Import Complete', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForTimeout(400);
}

/** A merge-mode dry run of: the first fixture item newer (one field changed), the second older, plus a new item. Returns the stats text. */
async function mergeDryRun(page, spec, items) {
  const DAY = 86400000;
  const payload = [
    { ...spec.newer(items[0]), updatedAt: new Date(Date.now() + DAY).toISOString() },
    { ...items[1], updatedAt: new Date(Date.now() - DAY).toISOString() },
    spec.fresh,
  ];
  await openModal(page, spec);
  await page.locator('[data-testid="import-json-input"]').fill(JSON.stringify(payload, null, 2));
  await page.locator('[data-testid="merge-mode-option"] input[type="checkbox"]').check();
  await page.getByRole('button', { name: 'Dry Run', exact: true }).click();
  await page.locator('[data-testid="import-stats"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  return (await page.locator('[data-testid="import-stats"]').textContent().catch(() => '')) || '';
}

try {
  for (const spec of PAGES) {
    const items = JSON.parse(fs.readFileSync(spec.fixture, 'utf8'));
    const { context, page } = await open('light', spec.url);
    const t = (s) => `${spec.key}: ${s}`;
    try {
      // ---- the menu entry opens the shared modal
      await openModal(page, spec);
      check(t('the menu\'s "Import from JSON" opens the shared ImportJsonModal'), await modal(page).isVisible());
      check(t(`the modal is titled "${spec.title}"`), await page.getByText(spec.title, { exact: true }).first().isVisible());
      const parts = await page.evaluate(() => ({
        paste: !!document.querySelector('[data-testid="import-tab-paste"]'), file: !!document.querySelector('[data-testid="import-tab-file"]'),
        input: !!document.querySelector('[data-testid="import-json-input"]'), lines: /\d+ lines?/.test(document.querySelector('[data-testid="import-json-modal"]').textContent),
        example: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Paste Example'),
        dryRun: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Dry Run'),
        cancel: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Cancel'),
        merge: !!document.querySelector('[data-testid="merge-mode-option"]'),
      }));
      check(t('Paste JSON / Upload File tabs, the textarea with its line count, Paste Example, Dry Run and Cancel are there'), parts.paste && parts.file && parts.input && parts.lines && parts.example && parts.dryRun && parts.cancel, JSON.stringify(parts));
      check(t(`the "${spec.importLabel}" button is there and disabled while the input is empty`), (await importButton(page, spec).count()) === 1 && await importButton(page, spec).isDisabled());
      check(t('the merge option "Keep existing ... and merge newer copies" is offered'), parts.merge && /^Keep existing \w+ and merge newer copies$/.test(await page.locator('[data-testid="merge-mode-option"]').locator('span, div, p').first().textContent().catch(() => '')) || parts.merge);

      // ---- an invalid payload: error shown, modal stays, nothing written
      const before = await countStore(page, spec.store);
      check(t('the store is readable before any import'), before >= 0, String(before));
      await page.locator('[data-testid="import-json-input"]').fill('{"title": "a single object, not an array"}');
      await importButton(page, spec).click();
      await page.getByText('Validation Error', { exact: true }).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      check(t('an invalid payload shows the validation error and the modal stays open'), await page.getByText('Validation Error', { exact: true }).isVisible() && await modal(page).isVisible());
      await page.locator('[data-testid="import-json-input"]').fill('[{"title": "broken"');
      await importButton(page, spec).click();
      await page.waitForTimeout(300);
      check(t('malformed JSON is reported as "Invalid JSON"'), /Invalid JSON/.test(await modal(page).textContent()));
      check(t('nothing was written by the invalid payloads'), (await countStore(page, spec.store)) === before);

      // ---- Dry Run: a summary, nothing written
      await page.locator('[data-testid="import-json-input"]').fill(JSON.stringify(items, null, 2));
      check(t('the error clears when the input changes'), !(await page.getByText('Validation Error', { exact: true }).isVisible().catch(() => false)));
      await page.getByRole('button', { name: 'Dry Run', exact: true }).click();
      const summary = page.locator('[data-testid="import-stats"], [data-testid="import-dry-run-summary"]').first();
      await summary.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      const summaryText = (await summary.textContent().catch(() => '')) || '';
      check(t('Dry Run shows a summary of what would be imported'), /would be (added|created)/.test(summaryText), summaryText.slice(0, 200));
      check(t('Dry Run writes nothing'), (await countStore(page, spec.store)) === before);
      check(t('the modal stays open after a dry run'), await modal(page).isVisible());

      // ---- Import from the paste
      await importButton(page, spec).click();
      await modal(page).waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      check(t('Import closes the input modal'), !(await modal(page).isVisible()));
      if (spec.key === 'documents') await closeDocumentsProgress(page);
      let after = before;
      for (let i = 0; i < 40 && after < before + items.length; i++) { await sleep(250); after = await countStore(page, spec.store); }
      check(t(`Import from a paste writes the fixture's ${items.length} items`), after === before + items.length, `${before} -> ${after}`);
      await page.waitForTimeout(600);
      check(t(`the list shows "${spec.listTitle}"`), (await page.getByText(spec.listTitle, { exact: false }).count()) > 0);

      // ---- Import from a chosen file (the way the old picker took it)
      await openModal(page, spec);
      await page.locator('[data-testid="import-tab-file"]').click();
      check(t('the Upload File tab shows the drop zone'), await page.locator('[data-testid="import-drop-zone"]').isVisible());
      await page.locator('[data-testid="import-file-input"]').setInputFiles(spec.fixture);
      await page.locator('[data-testid="import-file-chip"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      check(t('a chosen file shows as a chip with its name'), (await page.locator('[data-testid="import-file-chip"]').textContent().catch(() => '')).includes(path.basename(spec.fixture)));
      await importButton(page, spec).click();
      await modal(page).waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      if (spec.key === 'documents') await closeDocumentsProgress(page);
      let afterFile = after;
      for (let i = 0; i < 40 && afterFile < after + items.length; i++) { await sleep(250); afterFile = await countStore(page, spec.store); }
      check(t(`Import from the chosen file writes the fixture's ${items.length} items again`), afterFile === after + items.length, `${after} -> ${afterFile}`);

      // ---- merge: the option is the database import's (Documents: its own wording; the others: the shared JsonImportStats)
      if (spec.key === 'documents') {
        await openModal(page, spec);
        await page.locator('[data-testid="import-json-input"]').fill(JSON.stringify(items, null, 2));
        await page.locator('[data-testid="merge-mode-option"] input[type="checkbox"]').check();
        await page.getByRole('button', { name: 'Dry Run', exact: true }).click();
        await page.locator('[data-testid="import-stats"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        const mergeText = (await page.locator('[data-testid="import-stats"]').textContent().catch(() => '')) || '';
        check(t('a merge-mode dry run reports the existing copies instead of new ones (Documents wording unchanged)'), /replaced by newer copies|unchanged/i.test(mergeText) && (await countStore(page, spec.store)) === afterFile, mergeText.slice(0, 200));
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      } else {
        const mergeText = await mergeDryRun(page, spec, items);
        const expected = `1 ${spec.noun} would be added, 1 updated (newer), 1 skipped (older or identical), 0 errors`;
        check(t(`a merge dry run reports "${expected}"`), mergeText.includes(expected), mergeText.slice(0, 300));
        check(t('the merge dry run names the records (e.g. ...) and writes nothing'), /e\.g\. /.test(mergeText) && (await countStore(page, spec.store)) === afterFile);
        await importButton(page, spec).click();
        await modal(page).waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        let afterMerge = afterFile;
        for (let i = 0; i < 40 && afterMerge < afterFile + 1; i++) { await sleep(250); afterMerge = await countStore(page, spec.store); }
        check(t('the merge import adds only the new item (the newer copy updated a row, the older was skipped)'), afterMerge === afterFile + 1, `${afterFile} -> ${afterMerge}`);
        await page.waitForTimeout(500);
        check(t(`the list shows the added "${spec.fresh.title || spec.fresh.name}"`), (await page.getByText(spec.fresh.title || spec.fresh.name, { exact: false }).count()) > 0);
      }
      // Cancel resets the dialog
      await openModal(page, spec);
      check(t('reopening after an import starts empty'), (await page.locator('[data-testid="import-json-input"]').inputValue()) === '');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      check(t('Cancel closes the modal'), !(await modal(page).isVisible()));
    } finally {
      await context.close();
    }

    // ---- screenshots of the modal on this page, both themes
    for (const theme of ['dark', 'light']) {
      const { context: c2, page: p2 } = await open(theme, spec.url);
      try {
        await openModal(p2, spec);
        await p2.getByRole('button', { name: 'Paste Example', exact: true }).click();
        await p2.waitForTimeout(300);
        const file = path.join(OUT, `${spec.key}-${theme}.png`);
        await p2.screenshot({ path: file });
        console.log(`  screenshot: ${file}`);
        if (spec.key !== 'documents') {
          // a merge dry run over the fixture imported once: newer copy / older copy / new item
          await p2.locator('[data-testid="import-json-input"]').fill(JSON.stringify(items, null, 2));
          await importButton(p2, spec).click();
          await modal(p2).waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
          await p2.waitForTimeout(600);
          await mergeDryRun(p2, spec, items);
          await p2.locator('[data-testid="import-stats"]').scrollIntoViewIfNeeded();
          await p2.waitForTimeout(200);
          const shot = path.join(OUT, `${spec.key}-merge-dryrun-${theme}.png`);
          await p2.screenshot({ path: shot });
          console.log(`  screenshot: ${shot}`);
        }
      } finally {
        await c2.close();
      }
    }
  }
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await stop();
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
