/**
 * The phone layout in a real browser (Playwright Chromium with the iPhone
 * 14 Pro descriptor - 393x852 CSS px, a coarse pointer - against the Vite
 * dev server), and the desktop layout unchanged beside it:
 *   - on the phone: <html data-mobile="true">, the bottom bar with
 *     Documents / Workflows / Kanban / Tasks / More and no icon rail; every
 *     page has a header with the sidebar button; the page never scrolls
 *     sideways; the "More" sheet lists Robin, Calendars, JQL Search,
 *     Diagnostics, Tools, Team Chat, Notifications, Settings;
 *   - the drawer opens from the header, closes when a document is picked;
 *     the row chevron opens the document's context menu as a bottom sheet
 *     without opening the document;
 *   - Workflows: the list has no "New workflow", the open workflow shows
 *     the "View only · edit on desktop" toolbar and the reader, no canvas,
 *     and its row menu offers no Delete/Duplicate; Kanban swipes columns
 *     (the next one peeking in, no strip above them); Robin has its header
 *     and composer; Settings
 *     opens full-screen from More;
 *   - at a desktop viewport with a mouse: no data-mobile, no bottom bar, the
 *     icon rail is there, no chevrons in the lists, the editor toolbar has
 *     its desktop look (the rendering the desktop has always had).
 * Screenshots go to MOBILE_SHOTS_DIR when set.
 * Skips (exit 0 with a SKIP line) without playwright-core and its Chromium
 * (npx playwright install chromium), or when the Vite port is busy.
 * Run: node tests/mobile-ui.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { reapOnExit } from './helpers/reap.mjs';
import { COLOR_PROBE } from './helpers/color.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
// what a user types into a Transform on the desktop (node.data.code): seven lines, the first one long enough to wrap on a phone
const TRANSFORM_CODE = 'const body = typeof input === "string" ? input : JSON.stringify(input);\nconst checks = body.split("\\n").filter(Boolean);\nreturn {\n  healthy: checks.every((c) => /ok/i.test(c)),\n  checked: checks.length,\n  at: new Date().toISOString(),\n};';
const PORT = Number(process.env.MOBILE_TEST_PORT || 5195);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (MOBILE_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]}) - npx playwright install chromium`); process.exit(0); }

const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
const outDir = process.env.MOBILE_SHOTS_DIR || null;
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const shot = async (page, name) => { if (outDir) await page.screenshot({ path: path.join(outDir, `${name}.png`) }); };

async function open(device, { colorScheme = 'dark', theme = null } = {}) {
  const context = await browser.newContext({ ...device, reducedMotion: 'reduce', colorScheme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  if (theme) await page.evaluate((t) => localStorage.setItem('app-theme', t), theme);
  // synthetic documents, a workflow and tasks through the app's own modules (served by Vite)
  await page.evaluate(async ({ TRANSFORM_CODE }) => {
    const { db } = await import('/src/db/database.js');
    const now = Date.now();
    await db.documents.clear();
    await db.documents.bulkAdd([
      { title: 'Kubernetes upgrade runbook', content: '# Kubernetes upgrade runbook\n\nStep by step.\n', category: 'Runbooks', createdAt: new Date(now - 1000), updatedAt: new Date(now - 1000), stableId: 'sid-mui-1' },
      { title: 'TLS certificate rotation', content: '# TLS\n', category: 'Runbooks', createdAt: new Date(now - 2000), updatedAt: new Date(now - 2000), stableId: 'sid-mui-2' },
    ]);
    const { createWorkflow } = await import('/src/utils/workflows.js');
    await db.workflows.clear();
    await createWorkflow({ title: 'Health check and notify', category: 'Operations', nodes: [
      { id: 'n0', type: 'note', position: { x: 0, y: -200 }, data: { text: 'Runs every five minutes.' } },
      { id: 'n1', type: 'beginplay', position: { x: 0, y: 0 }, data: {} },
      { id: 'n2', type: 'restapi', position: { x: 300, y: 0 }, data: { method: 'GET', url: 'https://api.example.test/health' } },
      { id: 'n3', type: 'comparison', position: { x: 450, y: 0 }, data: { operator: '==' } },
      { id: 'n4', type: 'string', position: { x: 450, y: 200 }, data: { value: 'ok' } },
      { id: 'n5', type: 'branch', position: { x: 600, y: 0 }, data: {} },
      { id: 'n6', type: 'result', position: { x: 900, y: 0 }, data: {} },
      { id: 'n7', type: 'restapi', position: { x: 900, y: 200 }, data: { method: 'POST', url: 'https://alerts.example.test/page' } },
      // a Transform with code typed in the desktop editor (node.data.code, several lines, one long enough to wrap)
      { id: 'n9', type: 'transformation', position: { x: 450, y: -200 }, data: { code: TRANSFORM_CODE } },
    ], edges: [
      { id: 'e1', source: 'n1', sourceHandle: 'exec-out', target: 'n2', targetHandle: 'exec-in', type: 'execution' },
      { id: 'e2', source: 'n2', sourceHandle: 'exec-out', target: 'n9', targetHandle: 'exec-in', type: 'execution' },
      { id: 'e2b', source: 'n9', sourceHandle: 'exec-out', target: 'n5', targetHandle: 'exec-in', type: 'execution' },
      { id: 'e2t', source: 'n2', sourceHandle: 'data-out', target: 'n9', targetHandle: 'data-in', type: 'data' },
      { id: 'e2c', source: 'n2', sourceHandle: 'data-out', target: 'n3', targetHandle: 'left-in', type: 'data' },
      { id: 'e2d', source: 'n4', sourceHandle: 'data-out', target: 'n3', targetHandle: 'right-in', type: 'data' },
      { id: 'e2e', source: 'n3', sourceHandle: 'data-out', target: 'n5', targetHandle: 'data-in', type: 'data' },
      { id: 'e3', source: 'n5', sourceHandle: 'true', target: 'n6', targetHandle: 'exec-in', type: 'execution' },
      { id: 'e4', source: 'n5', sourceHandle: 'false', target: 'n7', targetHandle: 'exec-in', type: 'execution' },
    ] });
    await db.taskwarriorInstances.clear(); await db.tasks.clear();
    const instanceId = await db.taskwarriorInstances.add({ syncId: 'inst-mui', name: 'Platform work', category: 'General', description: 'Platform team tasks', rcPath: '~/.task/platform/.taskrc', dataPath: '~/.task/platform', isActive: 1, inCloud: false, ownerId: null, createdAt: new Date(), updatedAt: new Date() });
    const { createTask } = await import('/src/utils/tasks.js');
    const ts = (d) => new Date(d).toISOString();
    const day = 86400000;
    await createTask({ uuid: 'mui-1', instanceId, description: 'Investigate pod evictions on node-pool-b', status: 'pending', project: 'platform', priority: 'H', tags: ['kubernetes'], due: ts(now), entry: ts(now - 2 * day), modified: ts(now), start: ts(now - 75000), urgency: 20.0 });
    await createTask({ uuid: 'mui-2', instanceId, description: 'Rotate TLS certificates on the edge gateway', status: 'pending', project: 'security', priority: 'M', tags: ['tls'], due: ts(now - day), entry: ts(now - 3 * day), modified: ts(now), urgency: 16.5 });
    await createTask({ uuid: 'mui-3', instanceId, description: 'Archive the old staging cluster', status: 'completed', project: 'platform', entry: ts(now - 6 * day), modified: ts(now - day), end: ts(now - day), urgency: 0 });
    localStorage.removeItem('taskInstanceOpenTabs');
    const { createBoard, createCard } = await import('/src/utils/kanban.js');
    await db.kanbanBoards.clear(); await db.kanbanCards.clear();
    const board = await createBoard({ title: 'Platform Q4 roadmap', category: 'Platform', columns: [{ id: 'progress', title: 'In progress', color: '#4a9eff' }, { id: 'done', title: 'Done', color: '#5FCF9A' }] });
    await createCard({ boardId: board.id, title: 'Upgrade production to Kubernetes 1.34', status: 'progress', position: 0 });
    localStorage.removeItem('documentOpenTabs');
  }, { TRANSFORM_CODE });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  return { context, page, errors };
}
const state = (page) => page.evaluate(() => ({
  mobile: document.documentElement.getAttribute('data-mobile'),
  nav: !!document.querySelector('[data-testid="mobile-bottom-nav"]'),
  rail: !!document.querySelector('[title="Jacarium - Settings"], [aria-label="Jacarium - Settings"]'),
  header: document.querySelector('[data-testid="mobile-page-header"]')?.textContent || null,
  scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
  chevrons: document.querySelectorAll('[data-testid="row-menu-button"]').length,
}));
const openDrawer = async (page) => { await page.locator('[data-testid="mobile-open-sidebar"]').first().click(); await page.waitForTimeout(400); };
// The drawer meets the bottom bar: its aside's bottom edge IS the bar's top
// edge (no seam where the page shows through, no overlap), and a probe in
// the 4 px just above the bar lands inside the drawer. Both offsets come
// from one CSS variable (--sc-mobile-nav-height, src/mobile.css).
const seam = (page) => page.evaluate(() => {
  const aside = document.querySelector('[data-testid="mobile-drawer"] aside'); const nav = document.querySelector('[data-testid="mobile-bottom-nav"]');
  if (!aside || !nav) return { ok: false, why: 'no drawer or no bar' };
  const a = aside.getBoundingClientRect(); const n = nav.getBoundingClientRect();
  const probes = [1, 2, 3, 4].map((dy) => { const el = document.elementFromPoint(Math.round(a.left + a.width / 2), n.top - dy); return !!el && !!el.closest('[data-testid="mobile-drawer"] aside'); });
  const inset = getComputedStyle(document.documentElement).getPropertyValue('--sc-mobile-nav-height').trim();
  return { ok: Math.abs(a.bottom - n.top) <= 0.5 && probes.every(Boolean), asideBottom: a.bottom, navTop: n.top, navHeight: n.height, probes, inset };
});
// rows are looked up inside the drawer: the header names the open item too
const inDrawer = (page, text) => page.locator('[data-testid="mobile-drawer"]').getByText(text, { exact: true }).first();
const expand = async (page, name) => { const c = inDrawer(page, name); if (await c.count()) { await c.click().catch(() => {}); await page.waitForTimeout(300); } };
// Escape closes the drawer and the hook-based menus; a menu that only
// closes on an outside press (the workflow list's) goes with a tap on the
// scrim or the header
const closeOverlays = async (page) => {
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  const scrim = page.locator('[data-testid="mobile-drawer-scrim"]');
  if (await scrim.count()) { await scrim.click({ position: { x: 380, y: 400 }, force: true }).catch(() => {}); await page.waitForTimeout(200); }
  if (await page.locator('.sc-context-menu').count()) { await page.mouse.click(200, 120); await page.waitForTimeout(200); }
  const more = page.locator('[data-testid="mobile-more-backdrop"]');
  if (await more.count()) { await more.click({ position: { x: 200, y: 20 }, force: true }).catch(() => {}); await page.waitForTimeout(200); }
};
const nav = async (page, p) => { await closeOverlays(page); await page.locator(`[data-testid="mobile-nav-${p}"]`).click(); await page.waitForTimeout(900); };

try {
  // ================= the phone =================
  const phone = await open(pw.devices['iPhone 14 Pro']);
  const { page } = phone;
  let s = await state(page);
  check('phone: data-mobile is set, the bottom bar shows, the icon rail does not', s.mobile === 'true' && s.nav && !s.rail, JSON.stringify(s));
  check('phone: the Documents page has its header with the sidebar button, no sideways scroll', /Documents/.test(s.header || '') && s.scrollW <= s.innerW, JSON.stringify(s));
  const navLabels = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="mobile-bottom-nav"] button')).map((b) => b.textContent.trim()));
  check('phone: the bar reads Documents, Workflows, Kanban, Tasks, More', navLabels.join(',') === 'Documents,Workflows,Kanban,Tasks,More', navLabels.join(','));
  await shot(page, 'phone-01-documents');

  // the drawer, a document, the chevron
  await openDrawer(page);
  check('phone: the header button opens the drawer over a scrim', !!(await page.locator('[data-testid="mobile-drawer-scrim"]').count()) && (await page.locator('[data-testid="mobile-drawer"] aside').boundingBox())?.width === 324);
  await shot(page, 'phone-02-documents-drawer');
  {
    const g = await seam(page);
    check('phone: the Documents drawer meets the bottom bar exactly (aside.bottom === bar.top, the 4 px above the bar are the drawer)', g.ok, JSON.stringify(g));
    // every page's drawer, the same way
    for (const p of ['workflow', 'kanban', 'tasks']) {
      await nav(page, p); await openDrawer(page);
      const gp = await seam(page);
      check(`phone: the ${p} drawer meets the bottom bar exactly`, gp.ok, JSON.stringify(gp));
    }
    // with a home-indicator inset (Chromium's safe-area override, when this build has it): the bar grows, the drawer still meets it
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: 34, right: 0 } }).catch(() => cdp.send('Emulation.setSafeAreaInsetsOverride', { top: 0, left: 0, bottom: 34, right: 0 }));
      await page.waitForTimeout(300);
      const gi = await seam(page);
      check('phone: with a 34 px home-indicator inset the bar is 95 px and the drawer still meets it', gi.ok && Math.round(gi.navHeight) === 95, JSON.stringify(gi));
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: 0, right: 0 } }).catch(() => {});
      await cdp.detach().catch(() => {});
    } catch (e) {
      console.log(`SKIP: safe-area inset emulation not available in this Chromium (${String(e.message).split('\n')[0].slice(0, 80)})`);
    }
    await nav(page, 'documents'); await openDrawer(page);
  }
  s = await state(page);
  const doc = inDrawer(page, 'Kubernetes upgrade runbook');
  if (!(await doc.isVisible().catch(() => false))) await expand(page, 'Runbooks');
  s = await state(page);
  check('phone: every document row carries the chevron', s.chevrons >= 2, String(s.chevrons));
  const chevron = page.locator('[data-testid="row-menu-button"]').first();
  const before = await page.evaluate(() => document.querySelector('[data-testid="mobile-page-header"]')?.textContent);
  await chevron.click();
  await page.waitForTimeout(400);
  const menu = page.locator('.sc-context-menu').first();
  const menuBox = await menu.boundingBox();
  const rowBox = await chevron.evaluate((b) => { const r = b.closest('.sc-row').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  const menuItems = await page.evaluate(() => Array.from(document.querySelectorAll('.sc-context-menu button')).map((b) => b.textContent.trim()).filter(Boolean));
  const dropdown = await page.evaluate(() => { const m = document.querySelector('.sc-context-menu'); const s = document.querySelector('[data-testid="row-menu-scrim"]'); const corner = document.querySelector('[data-testid="status-corner"]'); return { placement: m?.getAttribute('data-placement'), scrim: !!s, scrimBg: s ? getComputedStyle(s).backgroundColor : null, cornerDisplay: corner ? getComputedStyle(corner).display : 'none', innerW: window.innerWidth, barTop: document.querySelector('[data-testid="mobile-bottom-nav"]').getBoundingClientRect().top }; });
  check('phone: the chevron opens the document\'s context menu with the desktop actions', /Duplicate/.test(menuItems.join()) && /Share with the Team/.test(menuItems.join()), menuItems.join(' | '));
  check('phone: ...as a dropdown anchored under the row, 12px from the edges, over a scrim', !!menuBox && Math.round(menuBox.x) === 12 && Math.round(menuBox.width) === dropdown.innerW - 24 && (dropdown.placement === 'below' ? Math.abs(menuBox.y - (rowBox.bottom + 4)) <= 1 : menuBox.y >= 0) && dropdown.scrim && /rgba\(8, 6, 14/.test(dropdown.scrimBg), JSON.stringify({ menuBox, rowBox, dropdown }));
  check('phone: ...kept within the band above the bottom bar', !!menuBox && menuBox.y + menuBox.height <= dropdown.barTop, JSON.stringify({ bottom: menuBox && menuBox.y + menuBox.height, barTop: dropdown.barTop }));
  check('phone: the connection indicator is hidden while a dropdown is open', dropdown.cornerDisplay === 'none', dropdown.cornerDisplay);
  // the Move to Category submenu opens full width under its item
  const moveItem = page.locator('.sc-context-menu button', { hasText: 'Move to Category' }).first();
  if (await moveItem.count()) {
    await moveItem.click(); await page.waitForTimeout(300);
    const sub = await page.locator('.sc-submenu').first().boundingBox();
    const itemBox = await moveItem.boundingBox();
    check('phone: the Move to Category submenu opens full width under its item', !!sub && Math.round(sub.x) === 12 && sub.width >= dropdown.innerW - 25 && (Math.abs(sub.y - (itemBox.y + itemBox.height + 4)) <= 1 || sub.y + sub.height <= itemBox.y), JSON.stringify({ sub, itemBox }));
  }
  // a tap on the scrim closes the menu
  // (tapped where nothing but the scrim is: the menu and its submenu cover part of it)
  const bare = await page.evaluate(() => { for (let y = 4; y < window.innerHeight; y += 4) { const el = document.elementFromPoint(200, y); if (el && el.getAttribute('data-testid') === 'row-menu-scrim') return y; } return null; });
  check('phone: some of the scrim is left uncovered to tap', bare != null, String(bare));
  if (bare != null) await page.mouse.click(200, bare);
  await page.waitForTimeout(300);
  check('phone: a tap on the scrim closes the dropdown (and the scrim goes with it)', (await page.locator('.sc-context-menu').count()) === 0 && (await page.locator('[data-testid="row-menu-scrim"]').count()) === 0);
  const cornerAfter = await page.evaluate(() => { const c = document.querySelector('[data-testid="status-corner"]'); return c ? getComputedStyle(c).display : 'missing'; });
  check('phone: ...the drawer stays, so the connection indicator stays hidden behind it', cornerAfter === 'none' && (await page.locator('[data-testid="mobile-drawer"]').count()) === 1, cornerAfter);
  await closeOverlays(page);
  const cornerFree = await page.evaluate(() => { const c = document.querySelector('[data-testid="status-corner"]'); return c ? getComputedStyle(c).display : 'missing'; });
  check('phone: the connection indicator shows again once nothing covers the page', cornerFree !== 'none', cornerFree);
  await openDrawer(page);
  if (!(await doc.isVisible().catch(() => false))) await expand(page, 'Runbooks');
  const after = await page.evaluate(() => document.querySelector('[data-testid="mobile-page-header"]')?.textContent);
  check('phone: ...without opening the document (the header is unchanged, the drawer still open)', before === after && !!(await page.locator('[data-testid="mobile-drawer"]').count()), `${before} -> ${after}`);
  const chevronBox = await chevron.boundingBox();
  check('phone: the chevron\'s tap target is at least 44px', !!chevronBox && chevronBox.width >= 44 && chevronBox.height >= 44, JSON.stringify(chevronBox));
  await shot(page, 'phone-03-row-menu');
  await closeOverlays(page);
  await openDrawer(page);
  if (!(await doc.isVisible().catch(() => false))) await expand(page, 'Runbooks');
  await doc.click();
  await page.waitForTimeout(800);
  s = await state(page);
  check('phone: picking a document closes the drawer and names it in the header with "1 open"', !(await page.locator('[data-testid="mobile-drawer"]').count()) && /Kubernetes upgrade runbook/.test(s.header || '') && /1 open/.test(s.header || ''), s.header);
  const toggle = page.locator('[data-testid="editor-mode-toggle"]');
  check('phone: the editor toolbar ends with the edit/preview button', await toggle.count() === 1);
  await shot(page, 'phone-04-document');

  // Workflows: read-only
  await nav(page, 'workflow');
  await openDrawer(page);
  check('phone: the workflow list has no "New workflow" button', (await page.locator('[data-testid="workflow-new"]').count()) === 0 && (await page.locator('[title="Select multiple"]').count()) === 0);
  const wf = inDrawer(page, 'Health check and notify');
  if (!(await wf.isVisible().catch(() => false))) await expand(page, 'Operations');
  await page.locator('[data-testid="row-menu-button"]').first().click();
  await page.waitForTimeout(300);
  const wfMenu = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="workflow-context-menu"] button')).map((b) => b.textContent.trim()));
  check('phone: the workflow row menu keeps AI context and exports, offers no Duplicate/Delete/Share', wfMenu.some((t) => /Add as AI Context/.test(t)) && !wfMenu.some((t) => /Duplicate|Delete|Share with the Team/.test(t)), wfMenu.join(' | '));
  const wfDrop = await page.evaluate(() => { const m = document.querySelector('[data-testid="workflow-context-menu"]'); const r = m?.getBoundingClientRect(); return { x: r?.x, w: r?.width, placement: m?.getAttribute('data-placement'), scrim: !!document.querySelector('[data-testid="row-menu-scrim"]'), innerW: window.innerWidth }; });
  check('phone: the workflow row menu is the same anchored dropdown over a scrim', Math.round(wfDrop.x) === 12 && Math.round(wfDrop.w) === wfDrop.innerW - 24 && !!wfDrop.placement && wfDrop.scrim, JSON.stringify(wfDrop));
  await closeOverlays(page);
  await openDrawer(page);
  if (!(await wf.isVisible().catch(() => false))) await expand(page, 'Operations');
  await wf.click();
  await page.waitForTimeout(800);
  if (process.env.MOBILE_DEBUG) { console.log('after workflow click', JSON.stringify(await state(page)), 'drawer', await page.locator('[data-testid="mobile-drawer"]').count(), 'menu', await page.locator('.sc-context-menu').count()); await shot(page, 'phone-05a-after-click'); }
  const wfPage = await page.evaluate(() => ({ readonly: document.querySelector('[data-testid="mobile-workflow-readonly"]')?.textContent, reader: !!document.querySelector('[data-testid="mobile-workflow-view"]'), canvas: !!document.querySelector('.react-flow'), nodes: document.querySelectorAll('[data-testid="mobile-workflow-node"]').length, run: !!document.querySelector('[data-testid="mobile-workflow-run"]') }));
  check('phone: the open workflow is the read-only reader (no canvas), with the "View only" toolbar and Run', wfPage.readonly === 'View only · edit on desktop' && wfPage.reader && !wfPage.canvas && wfPage.nodes === 8 && wfPage.run, JSON.stringify(wfPage));
  // the Transform's card: the whole code as the desktop editor holds it, nothing cut, no "more lines" tap, the card tall enough for it
  const transformCard = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="mobile-workflow-node"][data-node-type="transformation"]');
    const body = card?.querySelector('[data-testid="mobile-workflow-node-body"]');
    if (!body) return { missing: true };
    const s = getComputedStyle(body);
    return { text: body.textContent, lines: Math.round(body.getBoundingClientRect().height / parseFloat(s.lineHeight)), clipped: body.scrollHeight > body.clientHeight + 1 || card.scrollHeight > card.clientHeight + 1, more: /more line|show less/.test(card.textContent), overflowX: body.scrollWidth > body.clientWidth + 1 };
  });
  // the data-input chips: tall enough to tap, readable in this theme, and a tap scrolls to the source's card and lights it
  const inputChip = await page.evaluate(() => {
    const chip = document.querySelector('[data-testid="mobile-workflow-node"][data-node-type="comparison"] [data-testid="mobile-workflow-input"]');
    if (!chip) return { missing: true };
    const r = chip.getBoundingClientRect();
    return { height: r.height, text: chip.textContent.replace(/\s+/g, ' ').trim(), source: chip.getAttribute('data-source-id') };
  });
  await page.locator('[data-testid="mobile-workflow-node"][data-node-type="comparison"] [data-testid="mobile-workflow-input"]').first().click();
  await page.waitForTimeout(500);
  const afterTap = await page.evaluate(() => { const lit = document.querySelector('[data-testid="mobile-workflow-node"][data-lit="true"]'); const r = lit?.getBoundingClientRect(); const view = document.querySelector('[data-testid="mobile-workflow-view"]').getBoundingClientRect(); return { lit: lit?.getAttribute('data-node-id') || null, inView: !!r && r.top >= view.top - 1 && r.bottom <= view.bottom + 1, ring: lit ? getComputedStyle(lit).boxShadow : null }; });
  check('phone: a card\'s input chip names the pin, the source node and its value, is at least 44px tall, and a tap scrolls to the source card and lights it', !inputChip.missing && inputChip.height >= 44 && /^left ←\s*REST API\s*"https:\/\/api\.example\.test\/health"$/.test(inputChip.text) && afterTap.lit === inputChip.source && afterTap.inView && afterTap.ring !== 'none', JSON.stringify({ inputChip, afterTap }));
  // the vertical gap between consecutive cards is the same with or without a connector line
  const cardGaps = await page.evaluate(() => { const cards = Array.from(document.querySelectorAll('[data-testid="mobile-workflow-node"]')); const out = []; for (let i = 1; i < cards.length; i++) out.push(Math.round(cards[i].getBoundingClientRect().top - cards[i - 1].getBoundingClientRect().bottom)); return out; });
  check('phone: every pair of consecutive cards is the same distance apart, connector line or not (a Result after a Branch no longer sits against it)', cardGaps.length >= 4 && cardGaps.every((g) => g === cardGaps[0]) && cardGaps[0] >= 14, JSON.stringify(cardGaps));
  check('phone: the Transform card shows the ENTIRE code typed on the desktop - every line, long lines wrapped, nothing clipped, no "more lines" tap', transformCard.text === TRANSFORM_CODE && !transformCard.clipped && !transformCard.more && !transformCard.overflowX && transformCard.lines > TRANSFORM_CODE.split('\n').length, JSON.stringify(transformCard).slice(0, 400));
  await shot(page, 'phone-05-workflow');

  // Kanban
  // a run on the phone: the cards show the live states the canvas nodes carry, Clear wipes the outputs
  await page.route('https://api.example.test/**', async (route) => { await new Promise((r) => setTimeout(r, 600)); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('ok') }); });
  await page.route('https://alerts.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"sent":true}' }));
  await page.route('**/api/workflow/http-request', async (route) => { await new Promise((r) => setTimeout(r, 600)); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, status: 200, statusText: 'OK', body: 'ok' }) }); });
  await page.locator('[data-testid="mobile-workflow-run"]').click();
  const seenRunning = await page.waitForSelector('[data-testid="mobile-workflow-node"][data-status="processing"]', { timeout: 8000 }).then(() => true).catch(() => false);
  const midRun = await page.evaluate(() => ({ running: Array.from(document.querySelectorAll('[data-status="processing"]')).map((c) => c.getAttribute('data-node-type')), stopEnabled: !document.querySelector('[data-testid="mobile-workflow-stop"]').disabled, clearDisabled: document.querySelector('[data-testid="mobile-workflow-clear"]').disabled, text: Array.from(document.querySelectorAll('[data-testid="mobile-workflow-node-status"]')).map((e) => e.textContent).join(',') }));
  check('phone: Run marks the node being executed as running (live, from the same node state as the desktop), Stop enabled, Clear disabled meanwhile', seenRunning && midRun.running.length >= 1 && midRun.stopEnabled && midRun.clearDisabled && /running/.test(midRun.text || ''), JSON.stringify(midRun));
  const done = await page.waitForSelector('[data-testid="mobile-workflow-node"][data-node-type="result"][data-status="complete"], [data-testid="mobile-workflow-node"][data-status="error"]', { timeout: 20000 }).then(() => true).catch(() => false);
  const afterRun = await page.evaluate(() => ({ states: Array.from(document.querySelectorAll('[data-testid="mobile-workflow-node"]')).map((c) => `${c.getAttribute('data-node-type')}:${c.getAttribute('data-status') || '-'}`), outputs: document.querySelectorAll('[data-testid="mobile-workflow-node-output"]').length, fields: document.querySelectorAll('[data-testid="mobile-workflow-view"] input, [data-testid="mobile-workflow-view"] textarea, [data-testid="mobile-workflow-view"] select').length }));
  check('phone: the run finishes along the TRUE path: Begin Play, REST, Branch and the Result done (the Comparison is data, evaluated on demand), the POST on FALSE untouched; still no editable fields', done && afterRun.states.filter((s) => /:complete$/.test(s)).length >= 4 && afterRun.states.includes('result:complete') && !afterRun.states.some((s) => /:error$/.test(s)) && afterRun.states.filter((s) => /^restapi:/.test(s)).includes('restapi:-') && afterRun.fields === 0, JSON.stringify(afterRun));
  await page.waitForFunction(() => !document.querySelector('[data-testid="mobile-workflow-clear"]').disabled, null, { timeout: 10000 }).catch(() => {});
  await page.locator('[data-testid="mobile-workflow-clear"]').click(); await page.waitForTimeout(300);
  const wfCleared = await page.evaluate(() => ({ marks: document.querySelectorAll('[data-testid="mobile-workflow-node"][data-status]').length, outputs: document.querySelectorAll('[data-testid="mobile-workflow-node-output"]').length }));
  check('phone: Clear removes the run\'s marks and outputs', wfCleared.marks === 0 && wfCleared.outputs === 0, JSON.stringify(wfCleared));
  await page.unroute('https://api.example.test/**'); await page.unroute('https://alerts.example.test/**'); await page.unroute('**/api/workflow/http-request');
  await nav(page, 'kanban');
  await openDrawer(page);
  const board = inDrawer(page, 'Platform Q4 roadmap');
  if (!(await board.isVisible().catch(() => false))) await expand(page, 'Platform');
  await board.click();
  await page.waitForTimeout(800);
  check('phone: picking a board closes the drawer (also when it was the open one)', !(await page.locator('[data-testid="mobile-drawer"]').count()));
  const kanban = await page.evaluate(() => { const el = document.querySelector('.sc-kanban-columns'); const cols = el ? Array.from(el.querySelectorAll('.sc-kanban-column')) : []; const header = document.querySelector('[data-testid="mobile-page-header"]')?.getBoundingClientRect(); const r = el?.getBoundingClientRect(); const second = cols[1]?.getBoundingClientRect(); return { pager: !!document.querySelector('[data-testid="mobile-column-pager"]'), snap: el ? getComputedStyle(el).scrollSnapType : null, column: cols[0]?.getBoundingClientRect().width, gap: header && r ? Math.round(r.top - header.bottom) : null, peek: second ? Math.round(window.innerWidth - second.left) : null }; });
  check('phone: the board swipes its columns (scroll snap, 318px columns), the next one peeking in at the right edge, nothing between the header and the columns', !kanban.pager && /x/.test(kanban.snap || '') && Math.round(kanban.column) === 318 && kanban.gap === 0 && kanban.peek > 20, JSON.stringify(kanban));
  await shot(page, 'phone-06-kanban');

  // the Tasks filters: a dropdown under the toolbar's filter icon on a phone
  await closeOverlays(page);
  if (!/Platform work/.test((await state(page)).header || '')) { await nav(page, 'tasks'); await page.waitForTimeout(1200); }
  await page.waitForSelector('.sc-task-card', { timeout: 8000 }).catch(() => {});
  const cardsBefore = await page.locator('.sc-task-card').count();
  await page.locator('[data-testid="tasks-filter-button"]').click(); await page.waitForTimeout(400);
  const filters = await page.evaluate(() => { const m = document.querySelector('[data-testid="mobile-task-filters"]'); const btn = document.querySelector('[data-testid="tasks-filter-button"]').getBoundingClientRect(); const r = m?.getBoundingClientRect(); return { menu: !!m, isMenu: m?.classList.contains('sc-context-menu'), placement: m?.getAttribute('data-placement'), top: r ? Math.round(r.top) : null, buttonBottom: Math.round(btn.bottom), x: r ? Math.round(r.x) : null, scrim: !!document.querySelector('[data-testid="row-menu-scrim"]'), panel: !!document.querySelector('[data-testid="tasks-filter-panel"]'), rows: Array.from(document.querySelectorAll('[data-testid="mobile-task-filters"] [role="menuitemcheckbox"]')).map((b) => Math.round(b.getBoundingClientRect().height)), heads: Array.from(document.querySelectorAll('[data-testid="mobile-task-filters"] .uppercase')).map((h) => h.textContent) }; });
  check('phone: the filter icon opens the filters as a dropdown anchored under it, over the scrim, with STATUS/PROJECT/TAG sections of 44px rows and no inline panel', filters.menu && filters.isMenu && !!filters.placement && filters.scrim && !filters.panel && filters.x === 12 && (filters.placement !== 'below' || Math.abs(filters.top - (filters.buttonBottom + 4)) <= 1) && filters.rows.length >= 5 && filters.rows.every((h) => h >= 44) && filters.heads.join() === 'Status,Project,Tag', JSON.stringify(filters));
  await page.locator('[data-testid="task-filter-status-completed"]').click(); await page.waitForTimeout(500);
  const filtered = await page.evaluate(() => ({ menu: !!document.querySelector('[data-testid="mobile-task-filters"]'), checked: document.querySelector('[data-testid="task-filter-status-completed"]')?.getAttribute('aria-checked'), cards: document.querySelectorAll('.sc-task-card').length, badge: document.querySelector('[data-testid="tasks-filter-count"]')?.textContent, clear: !!document.querySelector('[data-testid="task-filter-clear"]') }));
  check('phone: toggling a status filters the list while the dropdown stays open, with a check mark, the badge and a Clear row', filtered.menu && filtered.checked === 'true' && filtered.cards < cardsBefore && filtered.badge === '1' && filtered.clear, JSON.stringify({ cardsBefore, ...filtered }));
  await page.locator('[data-testid="task-filter-clear"]').click(); await page.waitForTimeout(500);
  const cleared = await page.evaluate(() => ({ cards: document.querySelectorAll('.sc-task-card').length, badge: !!document.querySelector('[data-testid="tasks-filter-count"]'), clear: !!document.querySelector('[data-testid="task-filter-clear"]') }));
  check('phone: Clear filters resets the list and the badge', cleared.cards === cardsBefore && !cleared.badge && !cleared.clear, JSON.stringify(cleared));
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  check('phone: Escape closes the filter dropdown (and its scrim)', (await page.locator('[data-testid="mobile-task-filters"]').count()) === 0 && (await page.locator('[data-testid="row-menu-scrim"]').count()) === 0);

  // More: Robin and Settings
  await nav(page, 'more');
  const more = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="mobile-more-sheet"] [role="menuitem"]')).map((b) => b.textContent.trim()));
  check('phone: the More sheet lists the other pages, Team Chat, Notifications and Settings', more.join(',') === 'Robin,Calendars,JQL Search,Diagnostics,Tools,Team Chat,Notifications,Settings', more.join(','));
  await shot(page, 'phone-07-more');
  await page.locator('[data-testid="mobile-more-ai-chat"]').click();
  await page.waitForTimeout(1000);
  s = await state(page);
  const robin = await page.evaluate(() => ({ composer: !!document.querySelector('.sc-chat-composer textarea'), rows: document.querySelector('.sc-chat-composer textarea')?.rows, fifth: document.querySelector('[data-testid="mobile-nav-more"]')?.textContent.trim() }));
  check('phone: Robin has its header, a one-line composer, and the bar\'s fifth slot reads "Robin"', !!s.header && robin.composer && robin.rows === 1 && robin.fifth === 'Robin', JSON.stringify({ header: s.header, robin }));
  await shot(page, 'phone-08-robin');
  await page.locator('[data-testid="mobile-nav-more"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="mobile-more-settings"]').click();
  await page.waitForTimeout(800);
  const settings = await page.evaluate(() => { const m = document.querySelector('.sc-modal-backdrop > .bg-os-modal'); const r = m?.getBoundingClientRect(); return r ? { w: r.width, h: r.height, innerW: window.innerWidth, innerH: window.innerHeight, text: m.textContent.slice(0, 60) } : null; });
  check('phone: Settings opens full-screen from More', !!settings && settings.w >= settings.innerW && settings.h >= settings.innerH - 1 && /Settings/i.test(settings.text), JSON.stringify(settings));
  await shot(page, 'phone-09-settings');
  // Application Settings > General: the open-tabs toggle (disabled here: no server to synchronise with), persisted
  const phoneToggle = await page.evaluate(() => { const t = document.querySelector('[data-testid="sync-open-tabs"]'); const section = t?.closest('[data-testid="open-tabs-section"]'); return { present: !!t, role: t?.getAttribute('role'), disabled: !!t?.disabled, checked: t?.getAttribute('aria-checked'), hint: section?.textContent || '', // the Settings modal itself (an earlier revision matched "Application Settings" in the page text, which only
  // Robin's "no models configured" state - behind the modal, and timing-dependent now - happened to contain)
  header: !!t?.closest('.sc-modal-backdrop') && /Settings/.test(document.querySelector('.sc-modal-backdrop')?.textContent || '') }; });
  check('phone: Application Settings > General shows "Sync open tabs across devices" as a switch, disabled without a server, saying it needs synchronisation', phoneToggle.present && phoneToggle.header && phoneToggle.role === 'switch' && phoneToggle.disabled && phoneToggle.checked === 'true' && /Needs synchronisation/.test(phoneToggle.hint), JSON.stringify(phoneToggle));
  await closeOverlays(page);
  await page.evaluate(() => localStorage.setItem('openTabsSyncEnabled', 'false'));
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(2000);
  await page.locator('[data-testid="mobile-nav-more"]').click(); await page.waitForTimeout(300);
  await page.locator('[data-testid="mobile-more-settings"]').click(); await page.waitForTimeout(800);
  check('phone: the setting persists across a reload (off stays off)', (await page.evaluate(() => document.querySelector('[data-testid="sync-open-tabs"]')?.getAttribute('aria-checked'))) === 'false');
  await page.evaluate(() => localStorage.removeItem('openTabsSyncEnabled'));
  await closeOverlays(page);
  for (const p of ['calendars', 'search', 'diagnostics', 'tools']) {
    await page.locator('[data-testid="mobile-nav-more"]').click(); await page.waitForTimeout(300);
    await page.locator(`[data-testid="mobile-more-${p}"]`).click(); await page.waitForTimeout(900);
    s = await state(page);
    check(`phone: ${p} has the header with the sidebar button and no sideways scroll`, !!s.header && s.scrollW <= s.innerW && (await page.locator('[data-testid="mobile-open-sidebar"]').count()) === 1, JSON.stringify(s));
  }
  // Tools: the same "N open" menu as the Documents page (the shared TabBar)
  await openDrawer(page);
  for (const name of ['Hash Calculator', 'SLA Calculator']) {
    const row = inDrawer(page, name);
    if (!(await row.count())) await expand(page, 'Calculate');
    await inDrawer(page, name).click(); await page.waitForTimeout(600);
    await openDrawer(page);
  }
  await closeOverlays(page);
  const toolsHeader = await page.evaluate(() => ({ title: document.querySelector('[data-testid="mobile-page-header"] .sc-mobile-header-title')?.textContent, open: document.querySelector('[data-testid="tabs-overflow"]')?.textContent.trim() }));
  check('phone: Tools names the open tool in the header with a "2 open" menu button', toolsHeader.title === 'SLA Calculator' && toolsHeader.open === '2 open', JSON.stringify(toolsHeader));
  await page.locator('[data-testid="tabs-overflow"]').click(); await page.waitForTimeout(300);
  const toolsMenu = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="tabs-overflow-item"]')).map((b) => ({ title: b.querySelector('span')?.textContent, active: /text-os-text-primary/.test(b.className), h: Math.round(b.getBoundingClientRect().height), radius: getComputedStyle(b).borderTopLeftRadius })));
  check('phone: the Tools "N open" menu lists both tools, the active one marked, 44px rows with a straight left edge', toolsMenu.length === 2 && toolsMenu.map((t) => t.title).join(',') === 'Hash Calculator,SLA Calculator' && toolsMenu.filter((t) => t.active).length === 1 && toolsMenu[1].active && toolsMenu.every((t) => t.h >= 44 && t.radius === '0px'), JSON.stringify(toolsMenu));
  await page.locator('[data-testid="tabs-overflow-item"]').first().click(); await page.waitForTimeout(400);
  check('phone: picking a tool in the menu switches to it', (await page.evaluate(() => document.querySelector('[data-testid="mobile-page-header"] .sc-mobile-header-title')?.textContent)) === 'Hash Calculator');
  await page.locator('[data-testid="tabs-overflow"]').click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Close SLA Calculator' }).click(); await page.waitForTimeout(400);
  check('phone: the X in the menu closes that tool ("1 open")', (await page.locator('[data-testid="tabs-overflow"]').textContent()).trim() === '1 open' && (await page.locator('[data-testid="tabs-overflow-item"]').count()) === 1);
  await page.getByRole('button', { name: 'Close Hash Calculator' }).click(); await page.waitForTimeout(400);
  const toolsEmpty = await page.evaluate(() => ({ title: document.querySelector('[data-testid="mobile-page-header"] .sc-mobile-header-title')?.textContent, menu: !!document.querySelector('[data-testid="tabs-overflow"]'), empty: /No Tool Selected/.test(document.body.innerText) }));
  check('phone: closing the last tool leaves the "Tools" header without a menu and the empty state', toolsEmpty.title === 'Tools' && !toolsEmpty.menu && toolsEmpty.empty, JSON.stringify(toolsEmpty));
  check('phone: no page errors', phone.errors.length === 0, phone.errors.slice(0, 3).join(' | '));
  await phone.context.close();

  // ================= contrast, in the dark and the light theme ==========
  // Every piece of the phone chrome reads in every theme: the text of the
  // header, the workflow toolbar and reader, the task card and Robin's
  // composer is measured against the surface it sits on (the backgrounds
  // composited up the tree) - 4.5:1 for text, 3:1 for icons, borders and
  // lines. Jacaranda is the dark theme, "light" the light one. The helpers
  // are installed on the window once per page.
  const MEASURE = `window.__measure = (() => {
    const C = ${COLOR_PROBE};   // the shared colour helper: any syntax Chrome reports (rgb, oklch, color-mix results)
    const parse = (c) => { const v = C.parse(c); return v ? { r: v[0], g: v[1], b: v[2], a: v[3] } : { r: 0, g: 0, b: 0, a: 0 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const ratio = (a, b) => { const [h, l] = [lum(a), lum(b)].sort((x, y) => y - x); return Math.round(((h + 0.05) / (l + 0.05)) * 100) / 100; };
    // the surface under an element: its ancestors' backgrounds composited, from the first opaque one up
    const surface = (el) => { const layers = []; let n = el; while (n && n.nodeType === 1) { const bg = parse(getComputedStyle(n).backgroundColor); if (bg.a > 0) layers.unshift(bg); if (bg.a >= 1) break; n = n.parentElement; } let out = { r: 255, g: 255, b: 255, a: 1 }; for (const l of layers) out = over(l, out); return out; };
    // text (or an icon's currentColor) against what is behind it, the element's own background included
    const text = (el, pseudo = null) => { if (!el) return null; const bg = surface(el); const fg = parse(getComputedStyle(el, pseudo).color); let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity) || 1; return ratio(over({ ...fg, a: fg.a * o }, bg), bg); };
    // the element's own colour property (a border, a background) against its parent's surface
    const own = (el, prop) => { if (!el) return null; const bg = surface(el.parentElement); return ratio(over(parse(getComputedStyle(el)[prop]), bg), bg); };
    const q = (sel) => document.querySelector(sel);
    const byText = (sel, re) => Array.from(document.querySelectorAll(sel)).find((e) => re.test(e.textContent.trim()));
    // the leaf chips and actions of a task card's metadata row, each with its contrast
    const chips = (card) => Array.from(card?.querySelectorAll('.sc-task-meta span, .sc-task-meta button') || []).filter((e) => e.textContent.trim() && !e.querySelector('span, button')).map((e) => ({ t: e.textContent.trim().slice(0, 14), r: text(e) }));
    return { text, own, q, byText, chips, surface, parse, ratio };
  })();`;
  for (const theme of ['dark', 'light']) {
    const run = await open(pw.devices['iPhone 14 Pro'], { colorScheme: theme, theme });
    const tp = run.page;
    await tp.evaluate(MEASURE);
    await tp.evaluate(() => { for (const st of document.querySelectorAll('style')) if (/caret-color: transparent/.test(st.textContent)) st.disabled = true; });
    const applied = await tp.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), theme: document.documentElement.getAttribute('data-theme') }));
    check(`${theme}: the theme is applied`, applied.dark === (theme === 'dark') && applied.theme === theme, JSON.stringify(applied));
    await openDrawer(tp);
    if (!(await inDrawer(tp, 'Kubernetes upgrade runbook').isVisible().catch(() => false))) await expand(tp, 'Runbooks');
    await inDrawer(tp, 'Kubernetes upgrade runbook').click(); await tp.waitForTimeout(600);
    await closeOverlays(tp);
    const header = await tp.evaluate(() => { const { text, q } = window.__measure; const h = q('[data-testid="mobile-page-header"]'); return { title: text(h?.querySelector('.font-semibold')), subtitle: text(h?.querySelector('.text-\\[12px\\]')), open: text(q('[data-testid="tabs-overflow"]')), sidebar: text(q('[data-testid="mobile-open-sidebar"]')) }; });
    check(`${theme}: the page header's title, subtitle and "N open" reach 4.5:1, the sidebar button 3:1`, header.title >= 4.5 && header.subtitle >= 4.5 && header.open >= 4.5 && header.sidebar >= 3, JSON.stringify(header));
    await tp.locator('[data-testid="tabs-overflow"]').first().click(); await tp.waitForTimeout(400);
    const chrome = await tp.evaluate(() => { const { surface, q } = window.__measure; const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const header = q('[data-testid="mobile-page-header"]'); const nav = q('[data-testid="mobile-bottom-nav"]'); const menu = q('[data-testid="tabs-overflow-menu"]');
      return { header: lum(surface(header.querySelector('.sc-mobile-header-item'))), headerBg: getComputedStyle(header).backgroundColor, nav: lum(surface(nav)), navBg: getComputedStyle(nav).backgroundColor, menu: menu ? lum(surface(menu)) : null }; });
    check(`${theme}: the top bar wears the bottom bar's dark chrome${theme === 'light' ? ' (the light theme too)' : ''}, and the "N open" menu that opens from it is in the page's theme`, chrome.header < 0.05 && chrome.nav < 0.05 && chrome.menu != null && (theme === 'light' ? chrome.menu > 0.5 : chrome.menu < 0.05) && (theme === 'light' ? chrome.headerBg === chrome.navBg : true), JSON.stringify(chrome));
    await closeOverlays(tp);
    await nav(tp, 'workflow'); await openDrawer(tp);
    if (!(await inDrawer(tp, 'Health check and notify').isVisible().catch(() => false))) await expand(tp, 'Operations');
    await inDrawer(tp, 'Health check and notify').click(); await tp.waitForTimeout(900);
    await closeOverlays(tp);
    const wf = await tp.evaluate(() => { const { text, own, q, byText } = window.__measure;
      const reader = q('[data-testid="mobile-workflow-view"]');
      // the connector lines (not the empty spacer that keeps the gap even where no line is drawn)
      const connectors = Array.from(reader?.querySelectorAll('div.w-\\[2px\\]:not([data-link="false"])') || []).map((c) => own(c, 'backgroundColor'));
      return {
        run: text(q('[data-testid="mobile-workflow-run"]')), stop: text(q('[data-testid="mobile-workflow-stop"]')), readonly: text(q('[data-testid="mobile-workflow-readonly"]')),
        noteTitle: text(q('[data-testid="mobile-workflow-note"] > div')), noteText: text(q('[data-testid="mobile-workflow-note"] > div + div')), noteBorder: own(q('[data-testid="mobile-workflow-note"]'), 'borderTopColor'),
        get: text(byText('[data-testid="mobile-workflow-node"] span', /^GET$/)), post: text(byText('[data-testid="mobile-workflow-node"] span', /^POST$/)),
        tru: text(byText('[data-testid="mobile-workflow-node"] span', /^TRUE$/)), fals: text(byText('[data-testid="mobile-workflow-node"] span', /^FALSE$/)),
        url: text(byText('[data-node-type="restapi"] [data-testid="mobile-workflow-node-body"]', /health/)), value: text(byText('[data-node-type="comparison"] span.font-mono', /ok/)),
        connectors,
      }; });
    const wfText = ['readonly', 'noteTitle', 'noteText', 'get', 'post', 'tru', 'fals', 'url', 'value'];
    check(`${theme}: the workflow toolbar and reader text reach 4.5:1 (Run/Stop icons, the note's border and the connectors 3:1)`, wfText.every((k) => wf[k] >= 4.5) && wf.run >= 3 && wf.stop >= 3 && wf.noteBorder >= 3 && wf.connectors.length >= 2 && wf.connectors.every((c) => c >= 3), JSON.stringify(wf));
    await nav(tp, 'tasks'); await tp.waitForTimeout(1200);
    await tp.waitForSelector('.sc-task-card', { timeout: 8000 }).catch(async () => console.log('tasks did not render: ' + JSON.stringify(await state(tp))));
    const card = await tp.evaluate(() => { const { text, own, q, chips } = window.__measure;
      const active = q('.sc-task-card-active');
      const pending = Array.from(document.querySelectorAll('.sc-task-card:not(.sc-task-card-active)')).find((c) => !/line-through/.test(c.querySelector('.sc-task-title')?.className || ''));
      const rect = (el) => el?.getBoundingClientRect();
      const done = Array.from(document.querySelectorAll('.sc-task-card')).find((c) => /line-through/.test(c.querySelector('.sc-task-title')?.className || ''));
      return { activeTitle: text(active?.querySelector('.sc-task-title')), activeBorder: own(active, 'borderTopColor'), activeChips: chips(active), pendingTitle: text(pending?.querySelector('.sc-task-title')), pendingChips: chips(pending), doneTitle: text(done?.querySelector('.sc-task-title')), doneChips: chips(done),
        left: rect(active)?.left, right: rect(active) ? window.innerWidth - rect(active).right : null, sectionLeft: rect(active?.closest('.px-6')?.querySelector('button'))?.left };
    });
    check(`${theme}: the active task card's title reaches 4.5:1 and its border 3:1; every chip and action in it 4.5:1`, card.activeTitle >= 4.5 && card.activeBorder >= 3 && card.activeChips.length >= 5 && card.activeChips.every((c) => c.r >= 4.5), JSON.stringify({ title: card.activeTitle, border: card.activeBorder, chips: card.activeChips }));
    check(`${theme}: a pending task card's title and chips reach 4.5:1`, card.pendingTitle >= 4.5 && card.pendingChips.length >= 3 && card.pendingChips.every((c) => c.r >= 4.5), JSON.stringify({ title: card.pendingTitle, chips: card.pendingChips }));
    check(`${theme}: a completed task card's title and chips reach 4.5:1`, card.doneTitle >= 4.5 && card.doneChips.length >= 1 && card.doneChips.every((c) => c.r >= 4.5), JSON.stringify({ title: card.doneTitle, chips: card.doneChips }));
    check(`${theme}: the task cards use the width (the mockup's 14px margins), aligned with their section header`, card.left != null && card.left <= 16 && card.right <= 16 && card.sectionLeft != null && card.sectionLeft === card.left, JSON.stringify({ left: card.left, right: card.right, sectionLeft: card.sectionLeft }));
    await tp.locator('[data-testid="mobile-nav-more"]').click(); await tp.waitForTimeout(300);
    await tp.locator('[data-testid="mobile-more-ai-chat"]').click(); await tp.waitForTimeout(1000);
    const composer = await tp.evaluate(() => { const { text, q, parse, ratio } = window.__measure;
      const ta = q('.sc-chat-composer textarea'); const corner = q('[data-testid="status-corner"]'); const send = q('.sc-chat-composer > button');
      const r = (el) => el?.getBoundingClientRect();
      const overlaps = corner && send ? (r(corner).left < r(send).right && r(corner).right > r(send).left && r(corner).top < r(send).bottom && r(corner).bottom > r(send).top) : false;
      const wrap = ta?.closest('.sc-chat-composer')?.parentElement;
      const cs = ta ? getComputedStyle(ta) : null;
      return { text: text(ta), placeholder: text(ta, '::placeholder'), caret: cs ? ratio(parse(cs.caretColor === 'auto' ? cs.color : cs.caretColor), parse(cs.backgroundColor)) : null,
        overlaps, left: ta ? Math.round(r(ta).left) : null, right: send && wrap ? Math.round(r(wrap).right - r(send).right) : null, cornerAboveComposer: corner && wrap ? r(corner).bottom <= r(wrap).top + 1 : null }; });
    check(`${theme}: Robin's composer text and placeholder reach 4.5:1, the caret 3:1`, composer.text >= 4.5 && composer.placeholder >= 4.5 && composer.caret >= 3, JSON.stringify(composer));
    check(`${theme}: the composer sits at the mockup's 12px margins and the connection indicator clears it`, composer.left === 12 && composer.right === 12 && !composer.overlaps && composer.cornerAboveComposer === true, JSON.stringify(composer));
    await tp.locator('[data-testid="mobile-nav-more"]').click(); await tp.waitForTimeout(400);
    const sheet = await tp.evaluate(() => { const { own, q } = window.__measure; const backdrop = q('[data-testid="mobile-more-backdrop"]'); const sheet = q('[data-testid="mobile-more-sheet"]'); return { backdropRadius: backdrop ? getComputedStyle(backdrop).borderTopLeftRadius : null, handle: own(sheet?.querySelector('.sc-sheet-handle'), 'backgroundColor'), sheetLum: sheet ? (() => { const s = getComputedStyle(sheet).backgroundColor; const { parse } = window.__measure; const c = parse(s); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); })() : null }; });
    check(`${theme}: the More backdrop is square and the sheet's handle shows (3:1), the sheet in the page's theme`, sheet.backdropRadius === '0px' && sheet.handle >= 3 && (theme === 'light' ? sheet.sheetLum > 0.5 : sheet.sheetLum < 0.05), JSON.stringify(sheet));
    await closeOverlays(tp);
    await nav(tp, 'documents'); await openDrawer(tp);
    const drawer = await tp.evaluate(() => { const { parse } = window.__measure; const scrim = document.querySelector('[data-testid="mobile-drawer-scrim"]'); const aside = document.querySelector('[data-testid="mobile-drawer"] aside'); const c = window.__measure.surface(aside.firstElementChild || aside); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return { scrimRadius: scrim ? getComputedStyle(scrim).borderTopLeftRadius : null, asideLum: 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) }; });
    check(`${theme}: the drawer's scrim is square and the drawer is in the page's theme`, drawer.scrimRadius === '0px' && (theme === 'light' ? drawer.asideLum > 0.5 : drawer.asideLum < 0.05), JSON.stringify(drawer));
    await closeOverlays(tp);
    check(`${theme}: no page errors`, run.errors.length === 0, run.errors.slice(0, 3).join(' | '));
    await run.context.close();
  }
  // ================= scrolling, page by page =================
  // Every page's main area is height-constrained so that it scrolls inside
  // the shell instead of growing past the bottom bar (a flex item's
  // min-height is auto: one missing min-h-0 on the way down and the
  // overflow is clipped behind the bar). With more content than fits, each
  // page's scroll container scrolls to its end while the bar stays put and
  // the document itself never scrolls; a full-screen panel (Team Chat,
  // Notifications) ends above the bar with its input in reach, a back
  // button in its header and its name in the bar's fifth slot.
  const heavy = await open(pw.devices['iPhone 14 Pro']);
  const hp = heavy.page;
  // Robin's backend: health and a model list, so the conversation renders (nothing is sent)
  await hp.route('**/api/ai/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await hp.route('**/api/ai/models', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ollama: ['llama3.1:8b'] }) }));
  await hp.evaluate(async () => {
    const { db } = await import('/src/db/database.js');
    const now = Date.now(); const day = 86400000;
    await db.documents.clear();
    const docs = [];
    for (let i = 0; i < 40; i++) docs.push({ title: `Document ${String(i + 1).padStart(2, '0')}`, content: `# Document ${i + 1}\n\n` + 'A paragraph of text that goes on for a while so the reader has something to scroll.\n\n'.repeat(60), category: i < 20 ? 'Runbooks' : 'Notes', createdAt: new Date(now - i * 1000), updatedAt: new Date(now - i * 1000), stableId: `sid-scroll-${i}` });
    await db.documents.bulkAdd(docs);
    const { createWorkflow } = await import('/src/utils/workflows.js');
    await db.workflows.clear();
    const nodes = [{ id: 'b', type: 'beginplay', position: { x: 0, y: 0 }, data: {} }]; const edges = []; let prev = 'b';
    for (let i = 0; i < 12; i++) { const id = 'r' + i; nodes.push({ id, type: 'restapi', position: { x: 300 * (i + 1), y: 0 }, data: { method: 'GET', url: 'https://api.example.test/' + i } }); edges.push({ id: 'e' + i, source: prev, sourceHandle: 'exec-out', target: id, targetHandle: 'exec-in' }); prev = id; }
    await createWorkflow({ title: 'Long one', category: 'Ops', nodes, edges });
    const { createBoard, createCard } = await import('/src/utils/kanban.js');
    await db.kanbanBoards.clear(); await db.kanbanCards.clear();
    const board = await createBoard({ title: 'Big board', category: 'Platform', columns: [{ id: 'todo', title: 'To do', color: '#4a9eff' }, { id: 'done', title: 'Done', color: '#5FCF9A' }] });
    for (let i = 0; i < 16; i++) await createCard({ boardId: board.id, title: `Card ${i + 1}: something to do on the cluster`, description: 'A description line.', status: 'todo', position: i });
    await db.taskwarriorInstances.clear(); await db.tasks.clear();
    const instanceId = await db.taskwarriorInstances.add({ syncId: 'inst-scroll', name: 'Platform work', category: 'General', description: 'x', rcPath: '~/.task/p/.taskrc', dataPath: '~/.task/p', isActive: 1, inCloud: false, ownerId: null, createdAt: new Date(), updatedAt: new Date() });
    const { createTask } = await import('/src/utils/tasks.js');
    const ts = (d) => new Date(d).toISOString();
    for (let i = 0; i < 25; i++) await createTask({ uuid: `scroll-${i}`, instanceId, description: `Task ${i + 1}: investigate something on node-pool-${i}`, status: 'pending', project: 'platform', priority: 'M', tags: ['k8s'], due: ts(now + i * day), entry: ts(now - day), modified: ts(now), urgency: 10 - i * 0.1 });
    const msgs = [];
    for (let i = 0; i < 30; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i + 1}: a line of chat that is long enough to wrap onto a second line on a phone.`, timestamp: new Date(now - (30 - i) * 60000).toISOString() });
    const conv = { id: 'conv-scroll', name: 'Long conversation', createdAt: new Date(now - 3600000).toISOString(), messages: msgs, settings: { provider: 'ollama', model: 'llama3.1:8b', temperature: 0, maxTokens: 2000, datasets: { documentIds: [], lastUpdated: null } } };
    localStorage.setItem('aiChatPageConversations', JSON.stringify([conv])); localStorage.setItem('aiChatPageCurrentConversation', conv.id);
    localStorage.removeItem('documentOpenTabs'); localStorage.removeItem('taskInstanceOpenTabs');
  });
  await hp.reload({ waitUntil: 'load' }); await hp.waitForTimeout(2500);
  // the page's main scroll container: the visible overflow-y auto/scroll element with the most to scroll, inside `within`
  const scrollState = (page, within = 'body') => page.evaluate((sel) => {
    const root = document.querySelector(sel) || document.body;
    const bar = document.querySelector('[data-testid="mobile-bottom-nav"]')?.getBoundingClientRect();
    const barTop = bar ? bar.top : window.innerHeight;
    let main = null;
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY) || el.clientHeight === 0 || el.closest('[data-testid="mobile-bottom-nav"]')) continue;
      const room = el.scrollHeight - el.clientHeight;
      if (room > 1 && (!main || room > main.room)) main = { el, room };
    }
    if (!main) return { main: null, barTop, docScrollable: document.scrollingElement.scrollHeight > window.innerHeight + 1 };
    const el = main.el; const r = el.getBoundingClientRect();
    el.scrollTo(0, 99999);
    const after = document.querySelector('[data-testid="mobile-bottom-nav"]')?.getBoundingClientRect();
    return { main: el.getAttribute('data-testid') || el.className.toString().split(' ').slice(0, 3).join('.'), room: main.room, scrolledTo: el.scrollTop, bottom: Math.round(r.bottom), barTop: Math.round(barTop), barMoved: !!bar && !!after && after.top !== bar.top, docScrollable: document.scrollingElement.scrollHeight > window.innerHeight + 1 };
  }, within);
  const scrolls = async (page, name, within) => {
    const st = await scrollState(page, within);
    check(`scroll: ${name} scrolls inside the shell to its end, above the bar, and the bar stays put`, !!st.main && st.scrolledTo >= st.room - 2 && st.bottom <= st.barTop + 1 && !st.barMoved && !st.docScrollable, JSON.stringify(st));
  };
  await openDrawer(hp);
  if (!(await inDrawer(hp, 'Document 01').isVisible().catch(() => false))) await expand(hp, 'Runbooks');
  await scrolls(hp, 'the Documents drawer (40 rows)', '[data-testid="mobile-drawer"]');
  await inDrawer(hp, 'Document 01').click(); await hp.waitForTimeout(800); await closeOverlays(hp);
  await scrolls(hp, 'the document editor');
  await hp.locator('[data-testid="editor-mode-toggle"]').first().click(); await hp.waitForTimeout(600);
  await scrolls(hp, 'the document reader');
  await nav(hp, 'workflow'); await openDrawer(hp);
  if (!(await inDrawer(hp, 'Long one').isVisible().catch(() => false))) await expand(hp, 'Ops');
  await inDrawer(hp, 'Long one').click(); await hp.waitForTimeout(1000); await closeOverlays(hp);
  await scrolls(hp, 'the workflow reader (13 nodes)');
  const lastNode = await hp.evaluate(() => { const nodes = document.querySelectorAll('[data-testid="mobile-workflow-node"]'); const last = nodes[nodes.length - 1]?.getBoundingClientRect(); const bar = document.querySelector('[data-testid="mobile-bottom-nav"]').getBoundingClientRect(); return { count: nodes.length, lastBottom: last ? Math.round(last.bottom) : null, barTop: Math.round(bar.top) }; });
  check('scroll: the last node of the workflow is reachable (fully above the bar once scrolled to the end)', lastNode.count === 13 && lastNode.lastBottom != null && lastNode.lastBottom <= lastNode.barTop, JSON.stringify(lastNode));
  await nav(hp, 'kanban'); await openDrawer(hp);
  if (!(await inDrawer(hp, 'Big board').isVisible().catch(() => false))) await expand(hp, 'Platform');
  await inDrawer(hp, 'Big board').click(); await hp.waitForTimeout(1000); await closeOverlays(hp);
  await scrolls(hp, 'a Kanban column (16 cards)');
  await nav(hp, 'tasks'); await hp.waitForTimeout(1200);
  await hp.waitForSelector('.sc-task-card', { timeout: 8000 }).catch(() => {});
  await scrolls(hp, 'the Tasks list (25 tasks)');
  await hp.locator('[data-testid="mobile-nav-more"]').click(); await hp.waitForTimeout(300);
  await hp.locator('[data-testid="mobile-more-ai-chat"]').click(); await hp.waitForTimeout(1500);
  await hp.waitForSelector('.sc-chat-bubble', { timeout: 8000 }).catch(() => {});
  await scrolls(hp, 'Robin (30 messages)');
  const robinInput = await hp.evaluate(() => { const ta = document.querySelector('.sc-chat-composer textarea'); const bar = document.querySelector('[data-testid="mobile-bottom-nav"]').getBoundingClientRect(); const r = ta?.getBoundingClientRect(); return { present: !!ta, bottom: r ? Math.round(r.bottom) : null, barTop: Math.round(bar.top), bubbles: document.querySelectorAll('.sc-chat-bubble').length }; });
  check('scroll: Robin\'s composer sits above the bar, the seeded messages shown', robinInput.present && robinInput.bottom <= robinInput.barTop && robinInput.bubbles >= 20, JSON.stringify(robinInput));
  for (const pg of ['calendars', 'search', 'diagnostics', 'tools']) {
    await hp.locator('[data-testid="mobile-nav-more"]').click(); await hp.waitForTimeout(300);
    await hp.locator(`[data-testid="mobile-more-${pg}"]`).click(); await hp.waitForTimeout(900);
    if (pg === 'search') { await scrolls(hp, 'JQL Search (the query builder)'); continue; }
    const st = await hp.evaluate(() => { const bar = document.querySelector('[data-testid="mobile-bottom-nav"]').getBoundingClientRect(); const header = document.querySelector('[data-testid="mobile-page-header"]')?.getBoundingClientRect(); const below = Array.from(document.querySelectorAll('button, input, textarea, a')).filter((el) => !el.closest('[data-testid="mobile-bottom-nav"], [data-testid="status-corner"]') && el.getClientRects().length && el.getBoundingClientRect().top >= bar.top).map((el) => (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 20)); return { docScrollable: document.scrollingElement.scrollHeight > window.innerHeight + 1, headerTop: header ? Math.round(header.top) : null, below: below.slice(0, 5) }; });
    check(`scroll: ${pg} keeps its header at the top, the document does not scroll, nothing interactive is below the bar`, !st.docScrollable && st.headerTop === 0 && st.below.length === 0, JSON.stringify(st));
  }
  // Team Chat and Notifications: full-screen panels above the bar
  await hp.locator('[data-testid="mobile-nav-more"]').click(); await hp.waitForTimeout(300);
  await hp.locator('[data-testid="mobile-more-chat"]').click(); await hp.waitForTimeout(900);
  const chat = await hp.evaluate(() => { const bar = document.querySelector('[data-testid="mobile-bottom-nav"]').getBoundingClientRect(); const drawer = document.querySelector('[data-testid="mobile-drawer"][data-full]'); const input = drawer?.querySelector('input[type="text"], textarea'); const send = drawer?.querySelector('button[type="submit"]'); const r = input?.getBoundingClientRect(); const back = drawer?.querySelector('[data-testid="mobile-panel-back"]'); return { drawer: !!drawer, drawerBottom: drawer ? Math.round(drawer.getBoundingClientRect().bottom) : null, barTop: Math.round(bar.top), input: !!input, inputBottom: r ? Math.round(r.bottom) : null, inputVisible: r ? r.height > 0 && r.bottom <= bar.top : false, send: !!send, back: !!back, fifth: document.querySelector('[data-testid="mobile-nav-more"]')?.textContent.trim(), docScrollable: document.scrollingElement.scrollHeight > window.innerHeight + 1 }; });
  check('scroll: Team Chat fills the screen above the bar, its message input in reach with the Send button', chat.drawer && chat.drawerBottom <= chat.barTop + 1 && chat.input && chat.inputVisible && chat.send && !chat.docScrollable, JSON.stringify(chat));
  check('phone: Team Chat has a back button in its header and the bar names it in the fifth slot', chat.back && chat.fifth === 'Team Chat', JSON.stringify(chat));
  await hp.locator('[data-testid="mobile-panel-back"]').click(); await hp.waitForTimeout(400);
  const afterBack = await hp.evaluate(() => ({ drawer: !!document.querySelector('[data-testid="mobile-drawer"][data-full]'), fifth: document.querySelector('[data-testid="mobile-nav-more"]')?.textContent.trim() }));
  check('phone: the back button closes Team Chat and the fifth slot names the page again', !afterBack.drawer && afterBack.fifth !== 'Team Chat', JSON.stringify(afterBack));
  await hp.locator('[data-testid="mobile-nav-more"]').click(); await hp.waitForTimeout(300);
  await hp.locator('[data-testid="mobile-more-notifications"]').click(); await hp.waitForTimeout(900);
  const notif = await hp.evaluate(() => { const bar = document.querySelector('[data-testid="mobile-bottom-nav"]').getBoundingClientRect(); const drawer = document.querySelector('[data-testid="mobile-drawer"][data-full]'); return { drawer: !!drawer, drawerBottom: drawer ? Math.round(drawer.getBoundingClientRect().bottom) : null, barTop: Math.round(bar.top), back: !!drawer?.querySelector('[data-testid="mobile-panel-back"]'), fifth: document.querySelector('[data-testid="mobile-nav-more"]')?.textContent.trim() }; });
  check('phone: Notifications fills the screen above the bar, with a back button, named in the fifth slot', notif.drawer && notif.drawerBottom <= notif.barTop + 1 && notif.back && notif.fifth === 'Notifications', JSON.stringify(notif));
  await hp.locator('[data-testid="mobile-panel-back"]').click(); await hp.waitForTimeout(400);
  check('scroll: no page errors', heavy.errors.length === 0, heavy.errors.slice(0, 3).join(' | '));
  await heavy.context.close();

  // ================= the desktop =================
  const desktop = await open({ viewport: { width: 1280, height: 800 } });
  s = await state(desktop.page);
  check('desktop: no data-mobile, no bottom bar, the icon rail is there', s.mobile === null && !s.nav && s.rail, JSON.stringify(s));
  check('desktop: no phone header, no chevrons in the lists', s.header === null && s.chevrons === 0, JSON.stringify(s));
  const desk = await desktop.page.evaluate(() => ({ strip: !!document.querySelector('[data-testid="document-tabs"]') || !document.querySelector('[data-testid="mobile-page-header"]'), scrim: getComputedStyle(document.body).backgroundColor, drawer: !!document.querySelector('[data-testid="mobile-drawer"]') }));
  check('desktop: the desktop document tabs, no drawer', desk.strip && !desk.drawer, JSON.stringify(desk));
  await shot(desktop.page, 'desktop-01');
  // Application Settings > General on the desktop: the same toggle
  await desktop.page.locator('[title="Jacarium - Settings"], [aria-label="Jacarium - Settings"]').first().click(); await desktop.page.waitForTimeout(800);
  const deskToggle = await desktop.page.evaluate(() => { const t = document.querySelector('[data-testid="sync-open-tabs"]'); return { present: !!t, disabled: !!t?.disabled, checked: t?.getAttribute('aria-checked'), header: !!t?.closest('.sc-modal-backdrop') && /Settings/.test(document.querySelector('.sc-modal-backdrop')?.textContent || ''), general: !!document.querySelector('[data-testid="open-tabs-section"]') }; });
  check('desktop: Application Settings > General shows the "Sync open tabs across devices" switch (disabled without a server, on by default)', deskToggle.present && deskToggle.header && deskToggle.general && deskToggle.disabled && deskToggle.checked === 'true', JSON.stringify(deskToggle));
  await desktop.page.keyboard.press('Escape'); await desktop.page.waitForTimeout(300);
  // the desktop's Tasks filters are the inline panel, unchanged
  await desktop.page.locator('[title="Tasks"], [aria-label="Tasks"]').first().click().catch(async () => { await desktop.page.getByRole('button', { name: /^Tasks$/ }).first().click(); }); await desktop.page.waitForTimeout(1500);
  await desktop.page.locator('[data-testid="tasks-filter-button"]').first().click().catch(() => {}); await desktop.page.waitForTimeout(400);
  const deskFilters = await desktop.page.evaluate(() => ({ panel: !!document.querySelector('[data-testid="tasks-filter-panel"]'), dropdown: !!document.querySelector('[data-testid="mobile-task-filters"]'), badge: !!document.querySelector('[data-testid="tasks-filter-count"]'), chips: document.querySelectorAll('[data-testid="tasks-filter-panel"] button').length }));
  check('desktop: the filter icon toggles the inline chip panel (no dropdown, no badge)', deskFilters.panel && !deskFilters.dropdown && !deskFilters.badge && deskFilters.chips >= 5, JSON.stringify(deskFilters));
  check('desktop: no page errors', desktop.errors.length === 0, desktop.errors.slice(0, 3).join(' | '));
  await desktop.context.close();

  // ================= the desktop task card, every theme =================
  for (const theme of ['dark', 'light', 'gradient-blue-purple']) {
    const run = await open({ viewport: { width: 1280, height: 800 } }, theme === 'dark' ? {} : { colorScheme: theme === 'light' ? 'light' : 'dark', theme });
    const dp = run.page;
    await dp.evaluate(MEASURE);
    await dp.locator('[title="Tasks"], [aria-label="Tasks"]').first().click().catch(async () => { await dp.getByRole('button', { name: /^Tasks$/ }).first().click(); }); await dp.waitForTimeout(1500);
    await dp.waitForSelector('.sc-task-card', { timeout: 8000 }).catch(() => {});
    const cards = await dp.evaluate(() => { const { text, own, chips } = window.__measure;
      const all = Array.from(document.querySelectorAll('.sc-task-card'));
      return all.map((card) => ({ title: text(card.querySelector('.sc-task-title')), border: own(card, 'borderTopColor'), chips: chips(card), active: card.classList.contains('sc-task-card-active') })); });
    const bad = cards.flatMap((c) => [...(c.title < 4.5 ? [{ t: 'title', r: c.title }] : []), ...c.chips.filter((x) => x.r < 4.5)]);
    check(`desktop (${theme}): every task card's title, chips and actions reach 4.5:1 (${cards.length} cards)`, cards.length >= 3 && cards.some((c) => c.active) && cards.every((c) => c.chips.length >= 3) && bad.length === 0, JSON.stringify(bad.slice(0, 8)));
    await run.context.close();
  }
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
