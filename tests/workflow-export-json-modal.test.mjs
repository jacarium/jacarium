#!/usr/bin/env node
/**
 * "Export Workflow (JSON)" / "Export All (JSON)" / "Export Category as JSON"
 * open the transfer dialog (src/components/workflow/TransferTextModal.jsx,
 * the Base64 dialog in its json format) instead of only downloading a
 * file - in the real app (Chromium, playwright-core, a Vite dev server, the
 * backend faked, a throwaway profile):
 *   - the row's context-menu entry opens the dialog with EXACTLY the text
 *     the file export writes (serializeWorkflows, pretty-printed) and its
 *     line count, read-only, monospace;
 *   - Copy writes exactly that text to the clipboard and says "Copied";
 *   - Download .json downloads the same content under the same file name
 *     the export always used (workflowExportFileName);
 *   - the copied text imports cleanly through "Import from JSON" (round
 *     trip: a second workflow with the same title, category, nodes, edges);
 *   - the list menu's "Export All (JSON)" and the category's "Export
 *     Category as JSON" open the same dialog.
 * Screenshots (set EXPORT_SHOTS_DIR), dark and light.
 *
 * SKIPs (exit 0) without playwright-core / Chromium or with
 * SKIP_BROWSER_TESTS=1. Run: node tests/workflow-export-json-modal.test.mjs
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
const OUT = process.env.EXPORT_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-export-json-'));
fs.mkdirSync(OUT, { recursive: true });
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.SMOKE_PORT || 5299);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

const WORKFLOW = {
  title: 'Nightly backup', category: 'Ops',
  nodes: [
    { id: 'n1', type: 'beginplay', position: { x: 0, y: 0 }, data: { label: 'Begin' } },
    { id: 'n2', type: 'restapi', position: { x: 200, y: 0 }, data: { label: 'Fetch status', method: 'POST', url: 'https://api.example.internal/backup' } },
    { id: 'n3', type: 'result', position: { x: 400, y: 0 }, data: { label: 'Done' } },
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
    { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
  ],
};

async function open(theme) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce', colorScheme: theme, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addInitScript(({ theme }) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify(theme)); localStorage.setItem('expandedWorkflowCategories', JSON.stringify(['Ops', 'General'])); } catch { /* ignore */ } }, { theme });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.2', protocol: 2 } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e.message).slice(0, 160)));
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  // the Workflow Builder page, with one workflow created through the app's API
  await page.evaluate(async (wf) => { const { createWorkflow } = await import('/src/utils/workflows.js'); await createWorkflow(wf); }, WORKFLOW);
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.getAttribute('title') || x.getAttribute('aria-label') || x.textContent.trim()) === 'Workflow Builder'); if (b) b.click(); });
  await page.waitForTimeout(1200);
  return { context, page };
}
const modal = (page) => page.locator('[data-testid="transfer-modal-json"]');
const screenshot = async (page, name) => { const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file }); console.log(`  screenshot: ${file}`); };

try {
  for (const theme of ['light', 'dark']) {
    const t = (s) => `${theme}: ${s}`;
    const { context, page } = await open(theme);
    try {
      // what the file export writes for this workflow (the same serializer, on the stored row)
      const expected = await page.evaluate(async () => {
        const { getWorkflows } = await import('/src/utils/workflows.js');
        const { serializeWorkflows, workflowExportFileName } = await import('/src/utils/workflowTransfer.js');
        const list = (await getWorkflows()).filter((w) => w.title === 'Nightly backup');
        return { text: serializeWorkflows(list), filename: workflowExportFileName({ workflows: list }), all: serializeWorkflows(await getWorkflows()) };
      });

      // ---- the row's context menu
      await page.locator('.sc-row').filter({ hasText: 'Nightly backup' }).first().click({ button: 'right' });
      await page.getByText('Export Workflow (JSON)', { exact: true }).first().click();
      await modal(page).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      check(t('"Export Workflow (JSON)" opens the JSON export dialog'), await modal(page).isVisible());
      const shown = await page.locator('[data-testid="transfer-text"]').inputValue();
      check(t('the dialog shows exactly the text the file export writes (pretty-printed array, same serializer)'), shown === expected.text && shown.startsWith('[\n  {') && /"title": "Nightly backup"/.test(shown), shown.slice(0, 120));
      const box = await page.evaluate(() => { const ta = document.querySelector('[data-testid="transfer-text"]'); const cs = getComputedStyle(ta); return { readOnly: ta.readOnly, mono: /mono/i.test(cs.fontFamily), lines: document.querySelector('[data-testid="transfer-line-count"]')?.textContent.trim() }; });
      check(t('read-only, monospace, with the line count'), box.readOnly && box.mono && box.lines === `${expected.text.split('\n').length} lines`, JSON.stringify(box));
      check(t('the buttons: Copy, Download .json, Close'), ['transfer-copy', 'transfer-download', 'transfer-close'].every((id) => true) && (await page.locator('[data-testid="transfer-copy"]').textContent()).trim() === 'Copy' && (await page.locator('[data-testid="transfer-download"]').textContent()).trim() === 'Download .json' && (await page.locator('[data-testid="transfer-close"]').textContent()).trim() === 'Close');
      await screenshot(page, `export-json-modal-${theme}`);

      // ---- Copy
      await page.locator('[data-testid="transfer-copy"]').click(); await page.waitForTimeout(200);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      check(t('Copy writes exactly that text to the clipboard and the button says "Copied"'), clip === expected.text && (await page.locator('[data-testid="transfer-copy"]').textContent()).trim() === 'Copied', clip.slice(0, 80));
      await screenshot(page, `export-json-modal-copied-${theme}`);

      // ---- Download .json: the same file as before
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.locator('[data-testid="transfer-download"]').click()]);
      const saved = await download.path();
      const content = saved ? fs.readFileSync(saved, 'utf8') : null;
      check(t('Download .json downloads the same content under the same file name as the export always did'), download.suggestedFilename() === expected.filename && content === expected.text, `${download.suggestedFilename()} vs ${expected.filename}`);
      await page.locator('[data-testid="transfer-close"]').click(); await page.waitForTimeout(200);
      check(t('Close closes the dialog'), !(await modal(page).isVisible()));

      // ---- round trip: the copied text through "Import from JSON"
      await page.locator('button[title="Workflow menu"]').first().click();
      await page.getByText('Import from JSON', { exact: true }).first().click();
      await page.locator('[data-testid="import-json-modal"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('[data-testid="import-json-input"]').fill(clip);
      await page.getByRole('button', { name: 'Import Workflows', exact: true }).click();
      await page.locator('[data-testid="import-json-modal"]').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
      const after = await page.evaluate(async () => { const { getWorkflows } = await import('/src/utils/workflows.js'); return (await getWorkflows()).filter((w) => w.title === 'Nightly backup').map((w) => ({ category: w.category, nodes: w.nodes, edges: w.edges })); });
      check(t('the copied JSON imports cleanly: a second workflow with the same title, category, nodes and edges'), after.length === 2 && JSON.stringify(after[0]) === JSON.stringify(after[1]), JSON.stringify(after).slice(0, 200));

      // ---- the list menu's "Export All (JSON)" and the category's "Export Category as JSON"
      await page.locator('button[title="Workflow menu"]').first().click();
      await page.getByText('Export All (JSON)', { exact: true }).first().click();
      await modal(page).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      const allText = await page.locator('[data-testid="transfer-text"]').inputValue();
      check(t('"Export All (JSON)" opens the same dialog with every workflow'), await modal(page).isVisible() && JSON.parse(allText).length === 2 && (await page.locator('[data-testid="transfer-download"]').getAttribute('title')).includes('workflows-export-'));
      await page.locator('[data-testid="transfer-close"]').click(); await page.waitForTimeout(200);
      await page.locator('.sc-row').filter({ hasText: /^Ops/ }).first().click({ button: 'right' });
      const cat = page.getByText('Export Category as JSON', { exact: true }).first();
      if (await cat.count()) {
        await cat.click();
        await modal(page).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        check(t('"Export Category as JSON" opens the dialog with the category\'s file name'), await modal(page).isVisible() && (await page.locator('[data-testid="transfer-download"]').getAttribute('title')).includes('ops-workflows-'));
        await page.locator('[data-testid="transfer-close"]').click();
      } else {
        check(t('"Export Category as JSON" is offered on the category header'), false, 'menu item not found');
      }
    } finally { await context.close(); }
  }
} catch (e) {
  check('the run completed', false, e.stack || e.message);
} finally {
  await stop();
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
