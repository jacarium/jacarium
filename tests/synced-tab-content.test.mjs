#!/usr/bin/env node
/**
 * A tab that arrives from another device shows its content when it is
 * shown (3.2.2: the tab appeared on the phone, empty, until closed and
 * reopened - it was appended to the page's tab list without going through
 * the page's open path, which is what loads a document).
 *
 * The app runs in headless Chromium (Vite dev server); the other device is
 * played by a scripted synchronisation transport handed to the real engine
 * (src/sync/syncEngine.js): each pull answers with the rows "the other
 * device" pushed - the openTabs row BEFORE the document itself, and in a
 * second run AFTER it. Then, on the phone and on the desktop:
 *   - the Documents page shows the tab AND the document's content;
 *   - the Kanban page shows the board that arrived with its tab;
 * and a page that is already showing something keeps it (the arrival is
 * appended, not switched to).
 *
 * SKIPs like tests/mobile-ui.test.mjs (no Chromium, no port, Vite down).
 * Run: node tests/synced-tab-content.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.SYNCED_TAB_TEST_PORT || 5189);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (SYNCED_TAB_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]}) - npx playwright install chromium`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

// the rows "the other device" pushed, as the server hands them out
let seq = 0;
const now = () => new Date().toISOString();
const change = (collection, key, body) => ({ collection, key, rev: 1, seq: ++seq, updatedAt: Date.now(), deleted: false, body, device: 'device-other', conflict: null });
const docRow = (sid, title, content) => change('documents', sid, { title, content, category: 'General', createdAt: now(), updatedAt: now(), locked: false, inCloud: false });
const tabRow = (page, item, title, position = 0) => change('openTabs', `${page}:${item}`, { page, item, title, position, openedAt: Date.now(), updatedAt: Date.now() });
const boardRow = (sid, title) => change('kanbanBoards', sid, { title, category: 'Platform', columns: [{ id: 'todo', title: 'To do', color: '#4a9eff' }, { id: 'done', title: 'Done', color: '#5FCF9A' }], createdAt: now(), updatedAt: now(), inCloud: false });

async function open(device) {
  const context = await browser.newContext({ ...device, reducedMotion: 'reduce', colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.evaluate(async () => {
    const { db } = await import('/src/db/database.js');
    await db.documents.clear(); await db.kanbanBoards.clear(); await db.kanbanCards.clear(); await db.table('openTabs').clear();
    localStorage.removeItem('documentOpenTabs'); localStorage.removeItem('kanbanOpenTabs'); localStorage.removeItem('currentDocumentId'); localStorage.removeItem('currentKanbanBoardId');
    localStorage.removeItem('openTabsMirrored:documents'); localStorage.removeItem('openTabsMirrored:kanban');
    localStorage.setItem('whatsNewLastSeen', '99.0.0');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  // the real engine with the scripted transport: each pull answers with the next queued page
  await page.evaluate(async () => {
    const engine = await import('/src/sync/syncEngine.js');
    window.__pull = [];
    window.__seq = 0;
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const transport = { fetch: async (p, init = {}) => {
      if (p.startsWith('/api/sync/pull')) { const next = window.__pull.shift(); if (next) { window.__seq = next.seq; return ok({ ...next, now: Date.now() }); } return ok({ changes: [], seq: window.__seq, latest: window.__seq, more: false, generation: 1, now: Date.now() }); }
      if (p.startsWith('/api/sync/push')) { const body = JSON.parse(init.body || '{}'); return ok({ results: (body.changes || []).map((c, i) => ({ status: 'ok', rev: 1, seq: 1000 + i })), latest: 1000, generation: 1, now: Date.now() }); }
      return ok({ enabled: true, latest: window.__seq, records: 0, tombstones: 0, generation: 1, now: Date.now() });
    } };
    await engine.startSync({ transport, listen: false, immediate: false });
  });
  return { context, page, errors };
}
// the other device's rows arrive: one synchronisation cycle delivering them
const arrive = async (page, changes) => {
  await page.evaluate(async (list) => { window.__pull.push({ changes: list, seq: list[list.length - 1].seq, latest: list[list.length - 1].seq, more: false, generation: 1 }); const engine = await import('/src/sync/syncEngine.js'); await engine.syncNow(); }, changes);
  await page.waitForTimeout(900);
};
const documentsState = (page) => page.evaluate(() => ({
  header: document.querySelector('[data-testid="mobile-page-header"]')?.textContent || null,
  tabs: Array.from(document.querySelectorAll('[data-testid="document-tab"], [data-testid="tabs-overflow-item"]')).map((t) => t.textContent.trim()),
  open: document.querySelector('[data-testid="tabs-overflow"]')?.textContent.trim() || null,
  editor: document.querySelector('.sc-editor-textarea, textarea.resize-none')?.value || '',
  preview: document.querySelector('.markdown-preview')?.textContent || '',
  empty: /No Document Selected/.test(document.body.innerText),
  stored: JSON.parse(localStorage.getItem('documentOpenTabs') || '[]').map((t) => t.title),
}));
const showsDocument = (s, title, content) => (s.editor.includes(content) || s.preview.includes(content)) && !s.empty && (s.stored.includes(title));

try {
  // ---- the phone, Documents: the tab BEFORE the document ----
  let phone = await open(pw.devices['iPhone 14 Pro']);
  let p = phone.page;
  await arrive(p, [tabRow('documents', 'sid-remote-1', 'Remote runbook')]);
  let s = await documentsState(p);
  check('phone: an openTabs row that arrives before its document opens nothing yet (dropped quietly, no empty tab)', s.stored.length === 0 && s.empty, JSON.stringify(s));
  await arrive(p, [docRow('sid-remote-1', 'Remote runbook', '# Remote runbook\n\nSynced content line one.')]);
  await p.waitForTimeout(1200);
  s = await documentsState(p);
  check('phone: once the document arrives the tab opens AND its content is shown (the page\'s open path ran)', showsDocument(s, 'Remote runbook', 'Synced content line one') && /Remote runbook/.test(s.header || ''), JSON.stringify(s).slice(0, 500));
  // a second tab arriving while one is shown: appended, the shown one stays
  await arrive(p, [docRow('sid-remote-2', 'Second runbook', '# Second runbook\n\nOther content.'), tabRow('documents', 'sid-remote-2', 'Second runbook', 1)]);
  await p.waitForTimeout(1000);
  s = await documentsState(p);
  check('phone: a further tab arriving while a document is shown is appended, the shown document is not switched', s.stored.join() === 'Remote runbook,Second runbook' && (s.editor.includes('Synced content line one') || s.preview.includes('Synced content line one')) && s.open === '2 open', JSON.stringify({ stored: s.stored, open: s.open }));
  check('phone: no page errors', phone.errors.length === 0, phone.errors.slice(0, 3).join(' | '));
  await phone.context.close();

  // ---- the phone, Documents: the document BEFORE the tab ----
  phone = await open(pw.devices['iPhone 14 Pro']);
  p = phone.page;
  await arrive(p, [docRow('sid-remote-3', 'Third runbook', '# Third runbook\n\nContent that came first.')]);
  await arrive(p, [tabRow('documents', 'sid-remote-3', 'Third runbook')]);
  await p.waitForTimeout(1200);
  s = await documentsState(p);
  check('phone: a tab arriving after its document opens with the content shown', showsDocument(s, 'Third runbook', 'Content that came first') && /Third runbook/.test(s.header || ''), JSON.stringify(s).slice(0, 500));
  // Kanban: the board and its tab (tab first)
  await p.locator('[data-testid="mobile-nav-kanban"]').click(); await p.waitForTimeout(900);
  await arrive(p, [tabRow('kanban', 'board-remote-1', 'Remote board')]);
  await arrive(p, [boardRow('board-remote-1', 'Remote board')]);
  await p.waitForTimeout(1500);
  const kb = await p.evaluate(() => ({ header: document.querySelector('[data-testid="mobile-page-header"]')?.textContent || '', columns: Array.from(document.querySelectorAll('.sc-kanban-column')).length, text: document.body.innerText.slice(0, 400), stored: JSON.parse(localStorage.getItem('kanbanOpenTabs') || '[]').map((t) => t.title) }));
  check('phone: a Kanban board that arrives with its tab is shown (its columns rendered), not an empty page', /Remote board/.test(kb.header) && kb.columns >= 2 && /To do/.test(kb.text) && kb.stored.join() === 'Remote board', JSON.stringify(kb).slice(0, 400));
  await phone.context.close();

  // ---- the desktop, Documents: the tab BEFORE the document ----
  const desk = await open({ viewport: { width: 1280, height: 800 } });
  const d = desk.page;
  await arrive(d, [tabRow('documents', 'sid-remote-4', 'Desktop runbook')]);
  await arrive(d, [docRow('sid-remote-4', 'Desktop runbook', '# Desktop runbook\n\nDesktop content line.')]);
  await d.waitForTimeout(1200);
  s = await documentsState(d);
  check('desktop: the tab is in the strip and the editor shows the document\'s content', s.tabs.some((t) => /Desktop runbook/.test(t)) && showsDocument(s, 'Desktop runbook', 'Desktop content line'), JSON.stringify(s).slice(0, 500));
  check('desktop: no page errors', desk.errors.length === 0, desk.errors.slice(0, 3).join(' | '));
  await desk.context.close();
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
