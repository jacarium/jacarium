#!/usr/bin/env node
/**
 * "Add as AI Context" sends the REAL content, in the real app (Chromium,
 * playwright-core, a Vite dev server, the backend faked; a throwaway
 * profile). v3.3.2 sent an empty block for a whole document (the sidebar
 * row is metadata only - no `content`) and nothing at all for a workflow
 * (its payload had no kind, so the sidebar dropped it).
 *
 *   - a document created with the sidebar's "+" and typed into the editor:
 *     the sidebar row's "Add as AI Context" opens a new chat whose request
 *     carries the typed text - the editor's live text, before the autosave;
 *   - the tab menu's entry on the open document carries the same live text
 *     (a cloud / Yjs-backed document is covered by
 *     tests/ai-context-yjs-live.test.mjs: the real editor on a fake socket);
 *   - a workflow with several nodes (created through the app's
 *     createWorkflow): the Workflows list's right-click "Add as AI Context"
 *     shows the "Workflow: <name>" chip and the request carries the
 *     readable description;
 *   - a board with cards (createBoard / createCard): the board list's
 *     right-click entry carries the cards.
 * Screenshots (set CTX_SHOTS_DIR): the Document and Workflow tabs of the
 * eye dialog with the real content, dark and light.
 *
 * SKIPs (exit 0) without playwright-core / Chromium or with
 * SKIP_BROWSER_TESTS=1. Run: node tests/ai-context-real-content.test.mjs
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
const OUT = process.env.CTX_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ai-context-real-'));
fs.mkdirSync(OUT, { recursive: true });
let failed = 0; let total = 0;
const check = (name, ok, detail = '') => { total += 1; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.SMOKE_PORT || 5294);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

const ANSWER = 'Understood.';
/** The What's New window (a fresh profile shows it on every load) would intercept clicks. */
async function dismissWhatsNew(page) {
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); return; } await sleep(300); }
}
async function open(theme, url) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
  await context.addInitScript(({ theme }) => {
    try {
      localStorage.setItem('whatsNewLastSeen', '99.0.0');
      localStorage.setItem('app-theme', JSON.stringify(theme));
      localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General', 'Ops']));
      localStorage.setItem('expandedWorkflowCategories', JSON.stringify(['Ops', 'General']));
      localStorage.setItem('expandedKanbanCategories', JSON.stringify(['Work', 'General']));
    } catch { /* ignore */ }
  }, { theme });
  const requests = [];
  // (playwright tries routes last-registered first: the catch-all goes in first)
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.2', protocol: 2 } }));
  await context.route('**/api/ai/health', (r) => r.fulfill({ json: { status: 'online' } }));
  await context.route('**/api/ai/models', (r) => r.fulfill({ json: { ollama: ['qwen3:30b'], anthropic: [], openai: [], gemini: [], ssh: [], defaults: { provider: 'ollama', model: 'qwen3:30b' } } }));
  await context.route('**/api/ai/chat', (r) => { try { requests.push(r.request().postDataJSON()); } catch { requests.push(null); } r.fulfill({ json: { message: ANSWER } }); });
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e.message).slice(0, 160)));
  await page.goto(BASE + url, { waitUntil: 'load' }); await page.waitForTimeout(2500);
  await dismissWhatsNew(page);
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  return { context, page, requests };
}

const chip = (page) => page.locator('[data-testid="ai-context-chip"]');
/** The main shell's rail: open the page by its rail label (the AI chat sidebar lives in the main shell, not in a standalone window). */
async function goRail(page, label) {
  await page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.getAttribute('title') || x.getAttribute('aria-label') || x.textContent.trim()) === label); if (b) b.click(); }, label);
  await page.waitForTimeout(900);
}
const editor = (page) => page.locator('textarea.sc-editor-textarea').first();
// the AI chat sidebar's input (the one beside the context chips)
const chatInput = (page) => page.locator('div:has(> [data-testid="ai-context-chip"]) textarea:visible').first();
async function ask(page, requests, question) {
  requests.length = 0;
  await chatInput(page).fill(question);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 40 && !requests.length; i++) await sleep(250);
  return requests[0]?.messages?.[0]?.content || '';
}
/** Right-click the first visible .sc-row whose label is `text`, then click the menu entry. */
async function rowMenu(page, text, entry) {
  const row = page.locator('.sc-row').filter({ hasText: text }).first();
  await row.click({ button: 'right' });
  await page.getByText(entry, { exact: true }).first().click();
}
const screenshot = async (page, name) => { const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file }); console.log(`  screenshot: ${file}`); };

try {
  for (const theme of ['light', 'dark']) {
    const t = (s) => `${theme}: ${s}`;
    // ---- Documents: a new document typed into the editor (unsaved), then the sidebar row's entry
    {
      const { context, page, requests } = await open(theme, '/');
      try {
        await goRail(page, 'Documents');
        await page.locator('button[title="Add new"]').first().click();
        await page.waitForTimeout(800);
        const TYPED = 'Runbook body: restart app on node-12 at 10.0.0.5, token=abcd1234secret.';
        await editor(page).click(); await editor(page).fill(TYPED);
        await page.waitForTimeout(150); // before the 1s autosave: the live editor text must be what is sent
        const title = (await page.evaluate(() => Array.from(document.querySelectorAll('.sc-row')).map((el) => (el.querySelector('span.text-sm, .truncate') || el).textContent.trim()).find((x) => x && !/^(General|Ops)$/.test(x)))) || 'Untitled';
        await rowMenu(page, title, 'Add as AI Context');
        await chip(page).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        check(t('the sidebar row\'s "Add as AI Context" shows a "Document: ..." chip with no error'), (await chip(page).count()) === 1 && /Document: /.test(await chip(page).first().textContent()) && (await chip(page).first().getAttribute('data-empty')) === 'false', await chip(page).first().textContent().catch(() => 'no chip'));
        const sent = await ask(page, requests, 'what is this?');
        check(t('the request carries the document block with the text typed in the editor (not yet autosaved)'), /--- Document ---\n/.test(sent) && !/Untitled Document|category:/.test(sent) && /Runbook body: restart app on \[REDACTED_HOST_1\] at \[REDACTED_IP_1\]/.test(sent) && /--- End of document ---/.test(sent), sent.slice(0, 300));
        // the eye: the Document tab shows the real content
        await page.locator('[data-testid="ai-context-eye"]').first().click();
        await page.locator('[data-testid="ai-context-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
        check(t('the Document tab shows the real text'), /Runbook body/.test(await page.locator('[data-testid="ctx-text"]').inputValue()));
        await screenshot(page, `document-tab-${theme}`);
        await page.locator('[data-testid="ctx-cancel"]').click();

        // ---- the tab menu's entry on the open document (the editor's live text again)
        const tab = page.locator('[data-testid="document-tab"]').first();
        await tab.click({ button: 'right' });
        await page.getByText('Add as AI Context', { exact: true }).first().click();
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="ai-context-chip"]').length >= 1, null, { timeout: 8000 }).catch(() => {});
        const sent2 = await ask(page, requests, 'and now?');
        check(t('the tab menu\'s "Add as AI Context" carries the same live text'), /Runbook body/.test(sent2) && /--- Document ---\n/.test(sent2), sent2.slice(0, 300));
        // (a cloud / Yjs-backed document needs a socket the dev server has not got: tests/ai-context-yjs-live.test.mjs
        //  mounts the real editor with a fake socket and proves the live Yjs text is what is sent)
      } finally { await context.close(); }
    }

    // ---- Workflows: several nodes through createWorkflow, the list's right-click entry
    {
      const { context, page, requests } = await open(theme, '/');
      try {
        await goRail(page, 'Workflow Builder');
        await page.evaluate(async () => {
          const { createWorkflow } = await import('/src/utils/workflows.js');
          await createWorkflow({ title: 'Nightly backup', category: 'Ops', nodes: [
            { id: 'n1', type: 'beginplay', position: { x: 0, y: 0 }, data: { label: 'Begin' } },
            { id: 'n2', type: 'restapi', position: { x: 200, y: 0 }, data: { label: 'Fetch status', method: 'POST', url: 'https://api.example.internal/backup' } },
            { id: 'n3', type: 'ssh', position: { x: 400, y: 0 }, data: { label: 'Dump', host: 'db01.corp.internal', username: 'backup', command: 'pg_dump app > /backups/app.sql' } },
            { id: 'n4', type: 'transformation', position: { x: 600, y: 0 }, data: { label: 'Parse', code: 'return JSON.parse(input).ok;' } },
            { id: 'n5', type: 'result', position: { x: 800, y: 0 }, data: { label: 'Done' } },
          ], edges: [
            { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
            { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
            { id: 'e3', source: 'n3', target: 'n4', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
            { id: 'e4', source: 'n4', target: 'n5', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
          ] });
        });
        await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(2500); await dismissWhatsNew(page);
        await goRail(page, 'Workflow Builder');
        await rowMenu(page, 'Nightly backup', 'Add as AI Context');
        await chip(page).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        check(t('the Workflows list\'s "Add as AI Context" shows the "Workflow: Nightly backup" chip in a new chat'), (await chip(page).count()) === 1 && /Workflow: Nightly backup/.test(await chip(page).first().textContent()) && (await chip(page).first().getAttribute('data-empty')) === 'false', await chip(page).first().textContent().catch(() => 'no chip'));
        await page.locator('[data-testid="ai-context-eye"]').first().click();
        await page.locator('[data-testid="ai-context-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
        const text = await page.locator('[data-testid="ctx-text"]').inputValue();
        check(t('the eye shows a "Workflow" tab with the readable description'), (await page.locator('[data-testid="ctx-tab-text"]').textContent()) === 'Workflow' && /^--- Workflow ---\n/.test(text) && /Fetch status - REST API POST/.test(text) && /pg_dump app/.test(text), text.slice(0, 200));
        await screenshot(page, `workflow-tab-${theme}`);
        await page.locator('[data-testid="ctx-cancel"]').click();
        const sent = await ask(page, requests, 'what does it do?');
        check(t('the request carries the workflow block: nodes in order with their key fields and the connections'), /--- Workflow ---\n/.test(sent) && !/Nightly backup|\bOps\b|category:/.test(sent) && /api\.example\.internal\/backup/.test(sent) && /pg_dump app/.test(sent) && /\[REDACTED_(HOST|EMAIL)_\d\]/.test(sent) && !/db01\.corp\.internal/.test(sent) && /### Connections/.test(sent) && /--- End of workflow ---/.test(sent), sent.slice(0, 400));
      } finally { await context.close(); }
    }

    // ---- Kanban: a board and its cards, the board list's right-click entry
    {
      const { context, page, requests } = await open(theme, '/');
      try {
        await goRail(page, 'Kanban');
        await page.evaluate(async () => {
          const { createBoard, createCard } = await import('/src/utils/kanban.js');
          const b = await createBoard({ title: 'Release checklist', category: 'Work', columns: [{ id: 'todo', title: 'To Do' }, { id: 'done', title: 'Done' }] });
          await createCard({ boardId: b.id, title: 'Write release notes', status: 'todo', position: 0, description: 'mention node-12' });
          await createCard({ boardId: b.id, title: 'Tag the build', status: 'done', position: 0 });
        });
        await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(2500); await dismissWhatsNew(page);
        await goRail(page, 'Kanban');
        await rowMenu(page, 'Release checklist', 'Add as AI Context');
        await chip(page).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        check(t('the board list\'s "Add as AI Context" shows the "Board: Release checklist" chip'), (await chip(page).count()) === 1 && /Board: Release checklist/.test(await chip(page).first().textContent()) && (await chip(page).first().getAttribute('data-empty')) === 'false');
        const sent = await ask(page, requests, 'status?');
        check(t('the request carries the board block with its cards per column'), /--- Kanban board ---\n/.test(sent) && !/Release checklist|\bWork\b|category:/.test(sent) && /## To Do\n- \*\*Write release notes\*\*/.test(sent) && /## Done\n- \*\*Tag the build\*\*/.test(sent), sent.slice(0, 400));
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
