#!/usr/bin/env node
/**
 * Right-clicking a document tab near the right edge must never blank the
 * app (Playwright against the Vite dev server, no backend). Many open
 * tabs (the strip overflows), the right-most visible tab is right-clicked:
 * its menu appears inside the viewport, "Close" works, and the app stays
 * rendered - the root keeps its content, no page error, no React error in
 * the console. The same with the reading ruler's mask on (Focus profile),
 * for a tab in the overflow menu, in a short window, and for the other
 * context menus near the right and bottom edges.
 *
 * Needs playwright-core with Chromium. Port TAB_MENU_TEST_PORT (5245).
 * Run: node tests/tab-menu-crash-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.TAB_MENU_TEST_PORT || 5245);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (TAB_MENU_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

const N = 14;
async function open(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', colorScheme: 'dark' });
  await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General'])); } catch { /* storage */ } });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  const page = await context.newPage();
  const errors = []; const consoleErrors = [];
  page.on('pageerror', (e) => { errors.push(`${e.message}\n${(e.stack || '').split('\n').slice(0, 8).join('\n')}`); });
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (!/Failed to fetch|\/api\/|404|ERR_|WebSocket|socket\.io/.test(t)) consoleErrors.push(t.slice(0, 600)); } });
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await page.evaluate(async (n) => {
    const { db } = await import('/src/db/database.js');
    await db.documents.clear();
    const tabs = [];
    for (let i = 1; i <= n; i++) { const id = await db.documents.add({ title: `Sample note ${i} with a long title`, content: `# Sample ${i}\n\nText ${i}.`, category: 'General', stableId: `sid-${i}`, createdAt: new Date(), updatedAt: new Date() }); tabs.push({ id, title: `Sample note ${i} with a long title`, category: 'General', inCloud: false }); }
    localStorage.setItem('documentOpenTabs', JSON.stringify(tabs));
    localStorage.setItem('currentDocumentId', JSON.stringify(tabs[tabs.length - 1].id));
    localStorage.setItem('innerSidebarVisible', 'false');
  }, N);
  await page.reload({ waitUntil: 'load' }); await sleep(1800);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  return { context, page, errors, consoleErrors };
}
const alive = (page) => page.evaluate(() => { const root = document.getElementById('root'); return { children: root ? root.children.length : -1, text: root ? root.innerText.length : -1, rail: !!document.querySelector('nav.w-16') }; });
const setAids = (page, patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const visibleTabs = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="document-tab"]')).map((t) => { const r = t.getBoundingClientRect(); return { text: t.textContent.trim().slice(0, 30), left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width }; }).filter((t) => t.w > 0 && t.right <= window.innerWidth + 1 && t.left >= 0));
const menuBox = (page) => page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => /^Close This Tab$/.test(el.textContent.trim()) && el.closest('.fixed')); if (!b) return null; const m = b.closest('.fixed'); const r = m.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight, vw: window.innerWidth, vh: window.innerHeight }; });

const strip = (page) => page.evaluate(() => { const s = document.querySelector('.sc-tab-strip'); if (!s) return null; const r = s.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrollLeft: s.scrollLeft, scrollWidth: s.scrollWidth, clientWidth: s.clientWidth }; });
const allTabs = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="document-tab"]')).map((t) => { const r = t.getBoundingClientRect(); return { text: t.textContent.trim().slice(0, 30), left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width }; }));
const wheel = async (page, s, dy, times) => { await page.mouse.move(s.left + s.clientWidth / 2, (s.top + s.bottom) / 2); for (let i = 0; i < times; i++) await page.mouse.wheel(0, dy); await sleep(400); };
// a right-click at (x, y): the app stays rendered, no error, and the menu (when expected) sits inside the viewport
async function rightClick(tag, page, errors, consoleErrors, x, y, expectMenu = true) {
  const before = await alive(page);
  await page.mouse.move(x, y); await sleep(100);
  await page.mouse.click(x, y, { button: 'right' }); await sleep(500);
  const after = await alive(page);
  const menu = await menuBox(page);
  check(`${tag}: the app stays rendered (root ${after.children} children, ${after.text} chars)`, after.children > 0 && after.text > 50 && after.rail && after.text >= before.text / 2, JSON.stringify({ before, after }));
  check(`${tag}: no page error, no React error in the console`, errors.length === 0 && consoleErrors.length === 0, [...errors, ...consoleErrors].join(' || '));
  if (expectMenu) check(`${tag}: the tab menu opens inside the viewport`, !!menu && menu.inViewport, JSON.stringify(menu));
  await page.keyboard.press('Escape').catch(() => {}); await sleep(200);
  return menu;
}

// the scrolled strip: wheeled to its end, a tab cut by the strip's right edge, a right-click mid-scroll, an overflow entry
async function scrolledScenarios(tag, page, errors, consoleErrors) {
  let s = await strip(page);
  check(`${tag}: the strip overflows (scrollWidth ${s && s.scrollWidth} > clientWidth ${s && s.clientWidth})`, !!s && s.scrollWidth > s.clientWidth + 50, JSON.stringify(s));
  if (!s) return;
  await wheel(page, s, 600, 40); s = await strip(page);
  check(`${tag}: the wheel scrolls the strip to its end (scrollLeft ${s.scrollLeft})`, s.scrollLeft >= s.scrollWidth - s.clientWidth - 2, JSON.stringify(s));
  let tabs = await allTabs(page);
  const fully = tabs.filter((t) => t.w > 0 && t.right <= s.right + 1 && t.left >= s.left - 1);
  const last = fully[fully.length - 1];
  if (last) await rightClick(`${tag}: at the strip's end, the last fully visible tab`, page, errors, consoleErrors, last.left + 30, (last.top + last.bottom) / 2);
  // the tab's own close button (the pointer is there when one is about to close it)
  const closeBtn = await page.evaluate(() => { const tabs = Array.from(document.querySelectorAll('[data-testid="document-tab"]')); const s = document.querySelector('.sc-tab-strip').getBoundingClientRect(); const vis = tabs.filter((t) => { const r = t.getBoundingClientRect(); return r.width > 0 && r.right <= s.right + 1 && r.left >= s.left - 1; }); const t = vis[vis.length - 1]; const b = t && t.querySelector('button'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  if (closeBtn) await rightClick(`${tag}: the last visible tab's close button`, page, errors, consoleErrors, closeBtn.x, closeBtn.y);
  await wheel(page, s, -600, 20); s = await strip(page); tabs = await allTabs(page);
  const cut = tabs.find((t) => t.w > 0 && t.left < s.right - 8 && t.right > s.right);
  check(`${tag}: mid-strip, a tab is cut by the strip's right edge`, !!cut, JSON.stringify({ s, tabs: tabs.slice(0, 3) }));
  if (cut) await rightClick(`${tag}: the tab cut by the right edge`, page, errors, consoleErrors, s.right - 6, (cut.top + cut.bottom) / 2);
  // mid-scroll: the wheel and the right-click without a pause between them
  await page.mouse.move(s.left + s.clientWidth / 2, (s.top + s.bottom) / 2); await page.mouse.wheel(0, 300);
  await page.mouse.click(s.right - 40, (s.top + s.bottom) / 2, { button: 'right' }); await sleep(500);
  const mid = await alive(page);
  check(`${tag}: a right-click mid-scroll keeps the app rendered, no errors`, mid.children > 0 && mid.text > 50 && errors.length === 0 && consoleErrors.length === 0, JSON.stringify({ mid, errors, consoleErrors }));
  await page.keyboard.press('Escape').catch(() => {}); await sleep(200);
  const overflow = page.locator('[data-testid="tabs-overflow"]');
  if (await overflow.count()) {
    await overflow.evaluate((el) => el.click()); await sleep(400);
    const item = page.locator('[data-testid="tabs-overflow-menu"] button, [role="menu"] button').first();
    if (await item.count()) { const b = await item.boundingBox(); await rightClick(`${tag}: an overflow-menu entry`, page, errors, consoleErrors, b.x + b.width / 2, b.y + b.height / 2, false); }
    await page.keyboard.press('Escape').catch(() => {}); await sleep(200);
  }
}

async function scenario(tag, page, errors, consoleErrors) {
  const before = await alive(page);
  const tabs = await visibleTabs(page);
  check(`${tag}: the strip shows several tabs (${tabs.length} visible of ${N})`, tabs.length >= 3 && tabs.length < N, JSON.stringify(tabs.slice(-2)));
  const last = tabs[tabs.length - 1];
  await page.mouse.click(last.left + Math.min(40, last.w / 2), (last.top + last.bottom) / 2, { button: 'right' }); await sleep(500);
  const after = await alive(page);
  const menu = await menuBox(page);
  if (!menu) console.log('  fixed elements now: ' + JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('.fixed')).map((el) => ({ cls: el.className.slice(0, 60), text: el.textContent.trim().slice(0, 80), r: (({ left, top, right, bottom }) => [left, top, right, bottom])(el.getBoundingClientRect()) })))).slice(0, 1200));
  check(`${tag}: right-clicking the right-most visible tab keeps the app rendered (root ${after.children} children, ${after.text} chars of text, the rail there)`, after.children > 0 && after.text > 50 && after.rail && after.text >= before.text / 2, JSON.stringify({ before, after, errors, consoleErrors }));
  check(`${tag}: the tab menu opens inside the viewport`, !!menu && menu.inViewport, JSON.stringify(menu));
  check(`${tag}: no page error, no React error in the console`, errors.length === 0 && consoleErrors.length === 0, [...errors, ...consoleErrors].join(' || '));
  if (menu) {
    const n0 = (await page.evaluate(() => JSON.parse(localStorage.getItem('documentOpenTabs') || '[]').length));
    await page.locator('.fixed button', { hasText: /^Close This Tab$/ }).first().click(); await sleep(500);
    const n1 = (await page.evaluate(() => JSON.parse(localStorage.getItem('documentOpenTabs') || '[]').length));
    const after2 = await alive(page);
    check(`${tag}: "Close" closes that tab (${n0} -> ${n1}) and the app stays rendered`, n1 === n0 - 1 && after2.children > 0 && after2.text > 50, JSON.stringify({ n0, n1, after2, errors }));
  }
  await page.keyboard.press('Escape').catch(() => {});
}

try {
  // 1. the desktop layout, reading aids off
  let { page, errors, consoleErrors, context } = await open(1360, 900);
  await scenario('desktop, aids off', page, errors, consoleErrors);
  await scrolledScenarios('desktop, aids off', page, errors, consoleErrors);
  // 2. a tab reached through the overflow menu
  const overflow = page.locator('[data-testid="tabs-overflow"]');
  if (await overflow.count()) {
    await overflow.evaluate((el) => el.click()); await sleep(400);
    const item = page.locator('[role="menu"] button, [data-testid="tabs-overflow-panel"] button').first();
    if (await item.count()) { const b = await item.boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' }); await sleep(400); }
    const a = await alive(page);
    check('a right-click on an overflow-menu entry keeps the app rendered, no errors', a.children > 0 && a.text > 50 && errors.length === 0 && consoleErrors.length === 0, JSON.stringify({ a, errors, consoleErrors }));
    await page.keyboard.press('Escape'); await sleep(200);
  }
  // 3. the ruler's mask (Focus profile)
  await setAids(page, { ruler: true, rulerMode: 'mask', rulerLines: 3 }); await sleep(400);
  await page.mouse.move(700, 450); await sleep(200);
  await scenario('desktop, Focus mask on', page, errors, consoleErrors);
  await scrolledScenarios('desktop, Focus mask on', page, errors, consoleErrors);
  await setAids(page, { ruler: false });
  await context.close();
  // 4. a short, narrow window
  ({ page, errors, consoleErrors, context } = await open(900, 520));
  await scenario('short window', page, errors, consoleErrors);
  await scrolledScenarios('short window', page, errors, consoleErrors);
  await context.close();
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
