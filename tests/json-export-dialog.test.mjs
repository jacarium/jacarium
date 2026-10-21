#!/usr/bin/env node
/**
 * Kanban's and Tasks' "Export ... (JSON)" open the shared transfer dialog
 * (src/components/common/TransferTextModal.jsx) like Workflows' - in the
 * real app (Chromium, playwright-core, a Vite dev server, the backend
 * faked, a throwaway profile):
 *   - Kanban: the board list's "Export All (JSON)" shows exactly
 *     JSON.stringify(boards, null, 2) (what the file export wrote), Copy
 *     puts that text on the clipboard ("Copied"), Download .json downloads
 *     the same content as kanban-boards-YYYY-MM-DD.json, and the copied
 *     text imports through "Import from JSON" (round trip);
 *   - Tasks: the menu's "Export All (JSON)", the row's "Export Instance
 *     (JSON)" and the category's "Export Category (JSON)" open the dialog
 *     with the matching instances; Copy, Download .json
 *     (task-instances-YYYY-MM-DD.json, the same content) and the round trip
 *     through "Import from JSON";
 *   - the buttons are text buttons (no icon).
 * Screenshots (set EXPORT_SHOTS_DIR), dark and light.
 *
 * SKIPs (exit 0) without playwright-core / Chromium or with
 * SKIP_BROWSER_TESTS=1. Run: node tests/json-export-dialog.test.mjs
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
const OUT = process.env.EXPORT_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'json-export-dialog-'));
fs.mkdirSync(OUT, { recursive: true });
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.SMOKE_PORT || 5300);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

async function open(theme, railLabel) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce', colorScheme: theme, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addInitScript(({ theme }) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify(theme)); localStorage.setItem('expandedKanbanCategories', JSON.stringify(['Work', 'Home'])); localStorage.setItem('expandedTaskInstanceCategories', JSON.stringify(['Work', 'Home'])); } catch { /* ignore */ } }, { theme });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.2', protocol: 2 } }));
  await context.route('**/api/taskwarrior/check', (r) => r.fulfill({ json: { installed: false } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e.message).slice(0, 160)));
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  return { context, page, goRail: async () => { await page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.getAttribute('title') || x.getAttribute('aria-label') || x.textContent.trim()) === label); if (b) b.click(); }, railLabel); await page.waitForTimeout(1200); } };
}
const modal = (page) => page.locator('[data-testid="transfer-modal-json"]');
const text = (page) => page.locator('[data-testid="transfer-text"]').inputValue();
const screenshot = async (page, name) => { const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file }); console.log(`  screenshot: ${file}`); };
const noIcons = (page) => page.evaluate(() => ['transfer-copy', 'transfer-download', 'transfer-close'].every((id) => !document.querySelector(`[data-testid="${id}"] svg`)));
async function copyDownloadClose(page, t, expectedText, expectedName) {
  await page.locator('[data-testid="transfer-copy"]').click(); await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(t('Copy writes exactly the shown text and says "Copied"'), clip === expectedText && (await page.locator('[data-testid="transfer-copy"]').textContent()).trim() === 'Copied');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.locator('[data-testid="transfer-download"]').click()]);
  const saved = await download.path();
  const content = saved ? fs.readFileSync(saved, 'utf8') : null;
  check(t(`Download .json: ${expectedName} with the same content`), download.suggestedFilename() === expectedName && content === expectedText, `${download.suggestedFilename()} / ${content?.length} vs ${expectedText.length}`);
  await page.locator('[data-testid="transfer-close"]').click(); await page.waitForTimeout(200);
  check(t('Close closes the dialog'), !(await modal(page).isVisible()));
  return clip;
}
const today = new Date().toISOString().split('T')[0];

try {
  for (const theme of ['light', 'dark']) {
    const t = (s) => `${theme}: ${s}`;
    // ---------------- Kanban
    {
      const { context, page, goRail } = await open(theme, 'Kanban');
      try {
        await page.evaluate(async () => { const { createBoard } = await import('/src/utils/kanban.js'); await createBoard({ title: 'Release checklist', category: 'Work', columns: [{ id: 'todo', title: 'To Do' }, { id: 'done', title: 'Done' }] }); await createBoard({ title: 'Garden plan', category: 'Home', columns: [{ id: 'ideas', title: 'Ideas' }] }); });
        await goRail();
        const expected = await page.evaluate(async () => { const { getBoards } = await import('/src/utils/kanban.js'); return JSON.stringify(await getBoards(), null, 2); });
        await page.locator('button[title="Menu"]').first().click();
        await page.getByText('Export All (JSON)', { exact: true }).first().click();
        await modal(page).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        const shown = await text(page);
        check(t('Kanban: "Export All (JSON)" opens the dialog with exactly the file export\'s text (JSON.stringify(boards, null, 2))'), await modal(page).isVisible() && shown === expected && JSON.parse(shown).length === 2, shown.slice(0, 100));
        check(t('Kanban: the buttons are text buttons without icons'), await noIcons(page));
        await screenshot(page, `kanban-export-${theme}`);
        const clip = await copyDownloadClose(page, t, expected, `kanban-boards-${today}.json`);
        await page.locator('button[title="Menu"]').first().click();
        await page.getByText('Import from JSON', { exact: true }).first().click();
        await page.locator('[data-testid="import-json-modal"]').waitFor({ state: 'visible', timeout: 5000 });
        await page.locator('[data-testid="import-json-input"]').fill(clip);
        await page.getByRole('button', { name: 'Import Boards', exact: true }).click();
        await page.waitForTimeout(800);
        const boards = await page.evaluate(async () => { const { getBoards } = await import('/src/utils/kanban.js'); return (await getBoards()).map((b) => b.title).sort(); });
        check(t('Kanban: the copied text imports through "Import from JSON" (round trip: the two boards again)'), boards.join() === 'Garden plan,Garden plan,Release checklist,Release checklist', boards.join());
      } finally { await context.close(); }
    }
    // ---------------- Tasks
    {
      const { context, page, goRail } = await open(theme, 'Tasks');
      try {
        await page.evaluate(async () => { const { createInstance } = await import('/src/utils/taskwarriorInstances.js'); await createInstance({ name: 'Work tasks', category: 'Work', description: 'office', rcPath: '~/.taskrc-work', dataPath: '~/.task-work' }); await createInstance({ name: 'Home tasks', category: 'Home', description: 'chores', rcPath: '~/.taskrc-home', dataPath: '~/.task-home' }); });
        await goRail();
        const all = await page.evaluate(async () => { const { getAllInstances } = await import('/src/utils/taskwarriorInstances.js'); return await getAllInstances(); });
        await page.locator('button[title="Menu"]').first().click();
        await page.getByText('Export All (JSON)', { exact: true }).first().click();
        await modal(page).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        const shownAll = await text(page);
        const parsedAll = JSON.parse(shownAll);
        check(t('Tasks: "Export All (JSON)" opens the dialog with the instances as the file export writes them (pretty-printed array of both)'), await modal(page).isVisible() && parsedAll.length === 2 && parsedAll.map((i) => i.name).sort().join() === 'Home tasks,Work tasks' && shownAll === JSON.stringify(parsedAll, null, 2), shownAll.slice(0, 100));
        check(t('Tasks: the buttons are text buttons without icons'), await noIcons(page));
        await screenshot(page, `tasks-export-${theme}`);
        const clip = await copyDownloadClose(page, t, shownAll, `task-instances-${today}.json`);
        // the row and the category entries
        await page.locator('.sc-row').filter({ hasText: 'Work tasks' }).first().click({ button: 'right' });
        await page.getByText('Export Instance (JSON)', { exact: true }).first().click();
        await modal(page).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        const one = JSON.parse(await text(page));
        check(t('Tasks: the row\'s "Export Instance (JSON)" opens the dialog with that one instance (file task-instance-<name>-<date>.json)'), one.length === 1 && one[0].name === 'Work tasks' && (await page.locator('[data-testid="transfer-download"]').getAttribute('title')).includes(`task-instance-Work tasks-${today}.json`));
        await page.locator('[data-testid="transfer-close"]').click(); await page.waitForTimeout(200);
        await page.getByText('Home', { exact: true }).first().click({ button: 'right' }); // the category header's label
        await page.getByText('Export Category (JSON)', { exact: true }).first().click();
        await modal(page).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        const cat = JSON.parse(await text(page));
        check(t('Tasks: the category\'s "Export Category (JSON)" opens the dialog with that category\'s instances'), cat.length === 1 && cat[0].name === 'Home tasks' && (await page.locator('[data-testid="transfer-download"]').getAttribute('title')).includes(`task-instances-Home-${today}.json`));
        await page.locator('[data-testid="transfer-close"]').click(); await page.waitForTimeout(200);
        // round trip
        await page.locator('button[title="Menu"]').first().click();
        await page.getByText('Import from JSON', { exact: true }).first().click();
        await page.locator('[data-testid="import-json-modal"]').waitFor({ state: 'visible', timeout: 5000 });
        await page.locator('[data-testid="import-json-input"]').fill(clip);
        await page.getByRole('button', { name: 'Import Instances', exact: true }).click();
        await page.waitForTimeout(800);
        const names = await page.evaluate(async () => { const { getAllInstances } = await import('/src/utils/taskwarriorInstances.js'); return (await getAllInstances()).map((i) => i.name).sort(); });
        check(t('Tasks: the copied text imports through "Import from JSON" (round trip)'), names.join() === 'Home tasks,Home tasks,Work tasks,Work tasks' && all.length === 2, names.join());
      } finally { await context.close(); }
    }
  }
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await stop();
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
