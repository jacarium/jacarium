#!/usr/bin/env node
/**
 * The reading ruler over menus that render inside a sidebar's DOM subtree
 * (Playwright against the Vite dev server, no backend). A context menu or
 * hamburger menu is its own layer and area, whatever its DOM parent: with
 * the ruler in Mask mode, right-clicking a document in the Documents
 * sidebar puts the band on the menu item under the pointer across the
 * menu's full width (left and right edges the menu's own, not clipped at
 * the sidebar's right edge), the clip is the menu's box, and the shade's
 * hole is that item - the sidebar behind the menu is dimmed; the same when
 * the menu is placed so that it sticks out of the sidebar, for the
 * Documents hamburger menu (a .sc-menu inside the sidebar), a Tasks
 * instance row's context menu and the rail's "More pages" menu.
 *
 * Needs playwright-core with Chromium. Port RULER_MENUS_TEST_PORT (5243).
 * Run: node tests/ruler-menus-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.RULER_MENUS_TEST_PORT || 5243);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (RULER_MENUS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); localStorage.setItem('documentsReadingAids', JSON.stringify({ ruler: true, rulerMode: 'mask' })); localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General'])); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().evaluate((el) => el.click()); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }).catch(() => {}); };
const goTo = async (label) => { const b = page.locator(`nav.w-16 button[aria-label="${label}"]`); if (await b.count()) { await b.first().evaluate((el) => el.click()); } else { await page.locator('[data-testid="rail-more"]').evaluate((el) => el.click()); await sleep(200); await page.locator('[data-testid="rail-more-menu"] button', { hasText: label }).first().evaluate((el) => el.click()); } await page.mouse.move(700, 450); await sleep(700); };
const box = (b) => b && { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height };
const ruler = () => page.evaluate(() => {
  const c = document.querySelector('[data-testid="reading-ruler"]'); const b = document.querySelector('[data-testid="reading-ruler-band"]'); const s = document.querySelector('[data-testid="reading-ruler-shade"]');
  if (!c || c.hidden || !b) return null;
  const r = b.getBoundingClientRect(); const cr = c.getBoundingClientRect();
  const hole = s && !s.hidden && s.dataset.hole ? s.dataset.hole.split(',').map(Number) : null;
  return { z: getComputedStyle(c).zIndex, band: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }, clip: { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom }, shade: !!s && !s.hidden, shadeZ: s ? getComputedStyle(s).zIndex : null, hole: hole && { left: hole[0], top: hole[1], right: hole[2], bottom: hole[3] } };
});
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
// a point is dimmed when the shade is shown and the point lies outside its hole
const dimmed = (st, x, y) => st && st.shade && (!st.hole || x < st.hole.left || x > st.hole.right || y < st.hole.top || y > st.hole.bottom);

// the band over `item` (a menu item's box) spans the menu's full width and nothing else is bright
async function menuChecks(tag, menu, item, sidebar) {
  const st = await ruler();
  const ok = st && near(st.band.left, menu.left, 2) && near(st.band.right, menu.right, 2) && near(st.band.top, item.top, 2) && near(st.band.height, item.height, 2);
  check(`${tag}: the band over the item spans the menu's full width (left ${menu.left} / right ${menu.right}), its row the item's, in the menu's layer`, ok && parseInt(st.z, 10) > 50, JSON.stringify({ st, menu, item }));
  check(`${tag}: the clip is the menu's box, not the sidebar's`, st && near(st.clip.left, menu.left, 2) && near(st.clip.right, menu.right, 2) && st.clip.top <= item.top + 1 && st.clip.bottom >= item.bottom - 1, JSON.stringify({ clip: st && st.clip, menu }));
  const sidePoint = sidebar ? { x: sidebar.left + 20, y: Math.min(sidebar.bottom - 10, Math.max(sidebar.top + 10, item.top - 60)) } : null;
  check(`${tag}: the mask's hole is the item across the menu's width; the sidebar behind the menu and the page are dimmed`, st && st.shade && parseInt(st.shadeZ, 10) > 50 && st.hole && near(st.hole.left, menu.left, 2) && near(st.hole.right, menu.right, 2) && near(st.hole.top, item.top, 2) && (!sidePoint || dimmed(st, sidePoint.x, sidePoint.y)) && dimmed(st, 1000, 600), JSON.stringify({ hole: st && st.hole, menu, sidePoint }));
}

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500); await dismiss();
  await page.evaluate(async () => {
    const m = await import('/src/utils/documents.js');
    for (let i = 1; i <= 3; i++) await m.createDocument({ title: `Sample note ${i}`, content: `# Sample ${i}\n\nSample text ${i}.`, category: 'General' });
    const t = await import('/src/utils/taskwarriorInstances.js');
    await t.createInstance({ name: 'Platform work', category: 'General', description: 'Day-to-day platform tasks', rcPath: '~/.taskrc', dataPath: '~/.task' });
  });
  await goTo('Tasks'); await goTo('Documents'); await sleep(500);
  const sidebar = box(await page.locator('[data-side="left"]').first().boundingBox());
  let row = page.locator('[data-side="left"] .sc-row', { hasText: /Sample note 2/ }).first();
  if (!(await row.count())) { await page.locator('[data-side="left"] button', { hasText: /^General/ }).first().click(); await sleep(400); row = page.locator('[data-side="left"] .sc-row', { hasText: /Sample note 2/ }).first(); }
  const rb = box(await row.boundingBox());
  check('the Documents sidebar lists the sample documents', !!rb && !!sidebar, JSON.stringify({ rb, sidebar }));

  // 1. the row's context menu, opened near the row's left: the menu sits inside the sidebar's width or crosses it
  await page.mouse.click(rb.left + 30, rb.top + rb.height / 2, { button: 'right' }); await sleep(400);
  let menu = page.locator('.sc-context-menu').first();
  check('right-clicking a document opens its context menu (a fixed element inside the sidebar\'s subtree)', (await menu.count()) === 1 && (await menu.evaluate((el) => !!el.closest('[data-side="left"]') && getComputedStyle(el).position === 'fixed')));
  let mb = box(await menu.boundingBox());
  let item = box(await menu.locator('button, [role="menuitem"]').first().boundingBox());
  await page.mouse.move(item.left + 20, item.top + item.height / 2); await sleep(300);
  await menuChecks('the document context menu (first item)', mb, item, sidebar);
  check('the menu reaches past the sidebar\'s right edge here (so the width check is meaningful)', mb.right > sidebar.right, JSON.stringify({ mb, sidebar }));
  await page.keyboard.press('Escape'); await sleep(300);

  // 2. the same menu opened at the row's right edge: placed well outside the sidebar
  await page.mouse.click(rb.right - 8, rb.top + rb.height / 2, { button: 'right' }); await sleep(400);
  menu = page.locator('.sc-context-menu').first();
  mb = box(await menu.boundingBox());
  const items = menu.locator('button, [role="menuitem"]');
  item = box(await items.nth(Math.min(2, (await items.count()) - 1)).boundingBox());
  await page.mouse.move(item.left + item.width / 2, item.top + item.height / 2); await sleep(300);
  await menuChecks('the document context menu placed outside the sidebar (third item)', mb, item, sidebar);
  check('that menu lies mostly outside the sidebar', mb.left > sidebar.right - 40, JSON.stringify({ mb, sidebar }));
  await page.keyboard.press('Escape'); await sleep(300);

  // 3. the Documents hamburger menu (a .sc-menu rendered inside the sidebar)
  await page.locator('[data-side="left"] button[aria-label="Menu"]').first().click(); await sleep(400);
  menu = page.locator('.sc-menu').first();
  mb = box(await menu.boundingBox());
  item = box(await menu.locator('button').nth(1).boundingBox());
  await page.mouse.move(item.left + item.width / 2, item.top + item.height / 2); await sleep(300);
  await menuChecks('the Documents hamburger menu (second item)', mb, item, sidebar);
  await page.keyboard.press('Escape'); await sleep(300);

  // 4. a Tasks instance row's context menu
  await goTo('Tasks'); await sleep(500);
  const taskSidebar = box(await page.locator('[data-side="left"]').first().boundingBox());
  const trow = page.locator('[data-side="left"] .sc-row', { hasText: /Platform work/ }).first();
  if (!(await trow.count())) { const g = page.locator('[data-side="left"] button', { hasText: /^General/ }).first(); if (await g.count()) { await g.click(); await sleep(400); } }
  const trb = box(await trow.boundingBox().catch(() => null));
  if (trb) {
    await page.mouse.click(trb.left + 40, trb.top + trb.height / 2, { button: 'right' }); await sleep(400);
    menu = page.locator('.sc-context-menu').first();
    if (await menu.count()) {
      mb = box(await menu.boundingBox());
      item = box(await menu.locator('button, [role="menuitem"]').first().boundingBox());
      await page.mouse.move(item.left + 20, item.top + item.height / 2); await sleep(300);
      await menuChecks('a Tasks instance row\'s context menu', mb, item, taskSidebar);
      await page.keyboard.press('Escape'); await sleep(300);
    } else check('a Tasks instance row opens a context menu', false, 'no .sc-context-menu');
  } else check('the Tasks sidebar lists the seeded instance', false, 'no row');

  // 5. the rail's "More pages" menu
  const more = page.locator('[data-testid="rail-more"]');
  if (await more.count()) {
    await more.click(); await sleep(400);
    menu = page.locator('[data-testid="rail-more-menu"]').first();
    mb = box(await menu.boundingBox());
    item = box(await menu.locator('button').first().boundingBox());
    await page.mouse.move(item.left + item.width / 2, item.top + item.height / 2); await sleep(300);
    await menuChecks('the rail\'s More pages menu', mb, item, null);
    await page.keyboard.press('Escape'); await sleep(300);
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
