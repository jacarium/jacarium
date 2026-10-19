#!/usr/bin/env node
/**
 * The desktop tab bar's "N open" menu (src/components/features/documents/TabBar.jsx,
 * shared by Documents, Kanban, Tasks and Workflows), on a narrow window where
 * the tabs overflow.
 *
 * THE BUGS: the panel and its rows had rounded corners (the active row's
 * blue bar curved at its ends where the panel's radius clipped it), and the
 * panel rendered UNDER the resizable sidebar where it reached left over it -
 * not a z-index matter: the editor column is overflow-hidden and clipped the
 * absolutely positioned panel.
 *
 * Now: the "N open" button, the panel and its rows are square, like the
 * tabs; the panel is portalled to the body (fixed, placed under the button,
 * right-aligned to it, z-40: above the sidebar, its resize handle and the
 * editor toolbar, below the z-50 modals), follows a sidebar resize, closes on
 * outside click and Escape; the phone's header menu is unchanged (in place).
 *
 * Live (headless Chromium): a 700px window with two Documents tabs, dark and
 * light: corners 0px, elementFromPoint over the sidebar area inside the panel
 * is the panel, the panel's edges meet the button's, Escape and an outside
 * click close it, a collapsed and a resized sidebar keep it aligned; a 1280px
 * window shows no overflow button; the phone's menu stays in the header.
 *
 * SKIPs like tests/mobile-ui.test.mjs. Run: node tests/tabbar-overflow-menu.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.TABBAR_TEST_PORT || 5201);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (TABBAR_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

async function open(device, { theme = 'dark', sidebar = true, sidebarWidth = null } = {}) {
  const context = await browser.newContext({ ...device, reducedMotion: 'reduce', colorScheme: theme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(1800);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.evaluate(async ({ theme, sidebar, sidebarWidth }) => {
    const { db } = await import('/src/db/database.js');
    await db.documents.clear();
    const a = await db.documents.add({ title: 'Day 29 - How To Fix the Issues Reported by Bandit', content: '# Day 29\n\nText.', category: 'Supply Chain Security', stableId: 'sid-a', createdAt: new Date(), updatedAt: new Date() });
    const b = await db.documents.add({ title: 'Kubernetes upgrade runbook', content: '# Runbook\n\nSteps.', category: 'Operations', stableId: 'sid-b', createdAt: new Date(), updatedAt: new Date() });
    localStorage.setItem('documentOpenTabs', JSON.stringify([{ id: a, title: 'Day 29 - How To Fix the Issues Reported by Bandit', category: 'Supply Chain Security', inCloud: false }, { id: b, title: 'Kubernetes upgrade runbook', category: 'Operations', inCloud: false }]));
    localStorage.setItem('currentDocumentId', JSON.stringify(a));
    localStorage.setItem('whatsNewLastSeen', '99.0.0');
    localStorage.setItem('innerSidebarVisible', JSON.stringify(sidebar));
    if (sidebarWidth) localStorage.setItem('document-sidebar-width', JSON.stringify(sidebarWidth)); else localStorage.removeItem('document-sidebar-width');
    if (theme === 'light') localStorage.setItem('app-theme', JSON.stringify('light')); else localStorage.removeItem('app-theme');
  }, { theme, sidebar, sidebarWidth });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1800);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  return { context, page, errors };
}
const geometry = (page) => page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const button = q('[data-testid="tabs-overflow"]');
  const panel = q('[data-testid="tabs-overflow-menu"]');
  if (!button || !panel) return { button: !!button, panel: !!panel };
  const rows = Array.from(panel.querySelectorAll('[data-testid="tabs-overflow-item"]'));
  // the resizable sidebar: the editor column's previous sibling (the column holds the tab strip)
  const column = Array.from(document.querySelectorAll('div.flex-1.flex.flex-col.overflow-hidden')).find((d) => d.querySelector('[data-testid="document-tabs"]'));
  const sidebar = column ? column.previousElementSibling : null;
  const pb = r(panel);
  // a point inside the panel, 12px in from its left edge, 10px below its top: with the panel reaching
  // over the sidebar, that point is over the sidebar's area
  const probe = { x: pb.left + 12, y: pb.top + 10 };
  const hit = document.elementFromPoint(probe.x, probe.y);
  return {
    button: r(button), panel: pb, inBody: panel.parentElement === document.body, position: getComputedStyle(panel).position, zIndex: getComputedStyle(panel).zIndex,
    radii: { button: getComputedStyle(button).borderRadius, panel: getComputedStyle(panel).borderRadius, rows: rows.map((row) => getComputedStyle(row).borderRadius) },
    activeBar: rows.map((row) => getComputedStyle(row).borderLeftWidth + ' ' + getComputedStyle(row).borderLeftColor),
    sidebarRight: sidebar ? r(sidebar).right : null,
    hitInsidePanel: !!hit && panel.contains(hit), hitTag: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null,
    rowCount: rows.length, viewport: { w: window.innerWidth, h: window.innerHeight },
  };
});

try {
  for (const theme of ['dark', 'light']) {
    const run = await open({ viewport: { width: 700, height: 640 } }, { theme });
    const { page } = run;
    const overflow = page.locator('[data-testid="tabs-overflow"]');
    check(`${theme}: at 700px the two tabs overflow and the "2 open" button shows`, await overflow.count() === 1 && /2 open/.test(await overflow.textContent()));
    await overflow.click(); await page.waitForTimeout(300);
    const g = await geometry(page);
    check(`${theme}: the panel is in the body, fixed, z-index 40 (above the sidebar and its handle, below the modals)`, g.inBody && g.position === 'fixed' && g.zIndex === '40', JSON.stringify({ inBody: g.inBody, position: g.position, z: g.zIndex }));
    check(`${theme}: the button, the panel and both rows are square (0px corners)`, g.radii.button === '0px' && g.radii.panel === '0px' && g.radii.rows.length === 2 && g.radii.rows.every((x) => x === '0px'), JSON.stringify(g.radii));
    check(`${theme}: the panel hangs under the button, right-aligned to it, fully on screen`, Math.abs(g.panel.right - g.button.right) <= 1 && Math.abs(g.panel.top - g.button.bottom) <= 2 && g.panel.left >= 0 && g.panel.right <= g.viewport.w, JSON.stringify({ panel: g.panel, button: g.button }));
    check(`${theme}: the panel reaches over the sidebar and elementFromPoint there is the panel, not the sidebar`, g.sidebarRight != null && g.panel.left < g.sidebarRight && g.hitInsidePanel, JSON.stringify({ sidebarRight: g.sidebarRight, panelLeft: g.panel.left, hit: g.hitTag }));
    check(`${theme}: the active row carries the 2px blue bar (straight, no radius), the other none`, g.activeBar.length === 2 && g.activeBar.filter((b) => /^2px rgb/.test(b) && !/rgba\(0, 0, 0, 0\)/.test(b)).length === 1, JSON.stringify(g.activeBar));
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    check(`${theme}: Escape closes it`, await page.locator('[data-testid="tabs-overflow-menu"]').count() === 0);
    await overflow.click(); await page.waitForTimeout(200);
    await page.mouse.click(400, 500); await page.waitForTimeout(200);
    check(`${theme}: an outside click closes it`, await page.locator('[data-testid="tabs-overflow-menu"]').count() === 0);
    await overflow.click(); await page.waitForTimeout(200);
    await page.locator('[data-testid="tabs-overflow-item"]').nth(1).click(); await page.waitForTimeout(400);
    check(`${theme}: a row click switches the tab and closes the panel`, await page.locator('[data-testid="tabs-overflow-menu"]').count() === 0 && /Kubernetes/.test(await page.locator('[data-testid="document-tab"].border-l-os-blue, [data-testid="document-tab"]').last().textContent()));
    check(`${theme}: no page errors`, run.errors.length === 0, run.errors.slice(0, 3).join(' | '));
    await run.context.close();
  }
  // a resized sidebar and a collapsed one: the panel stays under its button
  const wide = await open({ viewport: { width: 700, height: 640 } }, { sidebarWidth: 360 });
  await wide.page.locator('[data-testid="tabs-overflow"]').click(); await wide.page.waitForTimeout(300);
  const gw = await geometry(wide.page);
  check('with the sidebar resized to 360px the panel still hangs right-aligned under the button, above the sidebar', Math.abs(gw.panel.right - gw.button.right) <= 1 && gw.hitInsidePanel, JSON.stringify({ panel: gw.panel, button: gw.button, hit: gw.hitTag }));
  await wide.context.close();
  const collapsed = await open({ viewport: { width: 700, height: 640 } }, { sidebar: false });
  const overflowC = collapsed.page.locator('[data-testid="tabs-overflow"]');
  if (await overflowC.count()) {
    await overflowC.click(); await collapsed.page.waitForTimeout(300);
    const gc = await geometry(collapsed.page);
    check('with the sidebar collapsed the panel hangs right-aligned under the button', Math.abs(gc.panel.right - gc.button.right) <= 1 && gc.inBody, JSON.stringify({ panel: gc.panel, button: gc.button }));
  } else {
    check('with the sidebar collapsed both tabs fit at 700px (no overflow button, nothing to position)', true);
  }
  await collapsed.context.close();
  // the normal desktop: no overflow, nothing of this
  const desk = await open({ viewport: { width: 1280, height: 800 } });
  check('at 1280px the tabs fit: no "N open" button, no panel', await desk.page.locator('[data-testid="tabs-overflow"]').count() === 0 && await desk.page.locator('[data-testid="tabs-overflow-menu"]').count() === 0);
  await desk.context.close();
  // the phone: the header's menu, in place as before
  const phone = await open(pw.devices['iPhone 14 Pro']);
  const po = phone.page.locator('[data-testid="tabs-overflow"]');
  check('phone: the header has the "2 open" menu', await po.count() === 1);
  await po.click(); await phone.page.waitForTimeout(300);
  const pg = await phone.page.evaluate(() => { const p = document.querySelector('[data-testid="tabs-overflow-menu"]'); return p ? { inBody: p.parentElement === document.body, position: getComputedStyle(p).position, radius: getComputedStyle(p).borderRadius } : null; });
  check('phone: the menu opens in the header, not portalled (absolute, square), unchanged', !!pg && !pg.inBody && pg.position === 'absolute' && pg.radius === '0px', JSON.stringify(pg));
  await phone.context.close();
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
