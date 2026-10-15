/**
 * The Documents page on a phone (the browser build, src/components/features/
 * documents/TabBar.jsx and the page layout): Playwright WebKit with the
 * iPhone 14 Pro descriptor (393x852 CSS px, DPR 3, portrait and landscape)
 * and Chromium mobile emulation at 393 and 375 px wide, with 1, 5 and 15
 * open tabs carrying long titles - synthetic documents seeded straight into
 * the app's IndexedDB through the Vite dev server.
 *
 * Checks, per browser/viewport/tab count:
 *   - the page never scrolls horizontally (documentElement.scrollWidth <=
 *     innerWidth) and the editor pane stays within the viewport;
 *   - with many tabs the tab strip scrolls INSIDE itself (scrollWidth >
 *     clientWidth of the strip, not of the page);
 *   - the active tab is visible (scrolled into view) and its close button
 *     is at least 32 px and clickable (elementFromPoint hits it);
 *   - the "N open" overflow menu lists every open document and switches;
 *   - inputs are >= 16 px (no iOS zoom on focus); viewport-fit=cover is set.
 * Screenshots go to MOBILE_SHOTS_DIR (kept) or a temp dir (removed).
 * MOBILE_AUDIT_MODE=before only captures (no layout checks) - the record of
 * the state before the fix.
 *
 * Skips without the Playwright browsers (npm install --no-save playwright &&
 * npx playwright install webkit chromium) or when the Vite port is busy.
 * Run: node tests/documents-mobile-tabs.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const BEFORE = process.env.MOBILE_AUDIT_MODE === 'before';
const PORT = Number(process.env.MOBILE_TEST_PORT || 5193);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright'); } catch { console.log('SKIP: playwright is not installed (npm install --no-save playwright && npx playwright install webkit chromium)'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (MOBILE_TEST_PORT)`); process.exit(0); }

const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stopVite = () => { try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); stopVite(); process.exit(0); }
const outDir = process.env.MOBILE_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-tabs-shots-'));
fs.mkdirSync(outDir, { recursive: true });

const TITLES = (n) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(2, '0')} ${['Incident runbook for the payment gateway cluster', 'Quarterly capacity review notes', 'Kubernetes upgrade checklist (long title to overflow)', 'Meeting', 'On-call handover and escalation matrix for the night shift'][i % 5]}`);

async function openApp(browserName, device, label) {
  const browser = await pw[browserName].launch();
  const context = await browser.newContext({ ...device, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  // the dev harness has no backend: WebKit reports its failed /api fetches as page errors
  page.on('pageerror', (e) => { const m = String(e.message || e); if (!/access control checks|Load failed|Failed to fetch|\/api\//.test(m)) errors.push(m); });
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  // what's new, if it shows
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  return { browser, context, page, errors, label };
}

async function seedAndOpen(page, n) {
  // synthetic documents through the app's own database module (served by Vite)
  await page.evaluate(async (titles) => {
    const { db } = await import('/src/db/database.js');
    await db.documents.clear();
    const now = Date.now();
    await db.documents.bulkAdd(titles.map((title, i) => ({ title, content: `# ${title}\n\nSynthetic body ${i}.`, category: 'General', createdAt: new Date(now - i * 1000), updatedAt: new Date(now - i * 1000), stableId: `sid-mobile-${i}` })));
  }, TITLES(n));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(200); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  // the document sidebar and the category keep their open/closed state
  // across reloads, so look before clicking: show the sidebar if hidden,
  // expand the category if the first title is not visible, open every
  // document (each click opens a tab), then hide the sidebar as a phone
  // user would (the rail's "Toggle Sidebar") so the editor gets the width
  const titles = TITLES(n);
  const first = () => page.getByText(titles[0], { exact: true }).first();
  const toggle = page.getByRole('button', { name: /Toggle Sidebar/i }).first();
  const general = page.getByText('General', { exact: true }).first();
  if (!(await general.isVisible().catch(() => false)) && (await toggle.count())) { await toggle.click(); await page.waitForTimeout(400); }
  if (!(await first().isVisible().catch(() => false)) && (await general.count())) { await general.click({ timeout: 5000 }); await page.waitForTimeout(400); }
  for (const title of titles) {
    const item = page.getByText(title, { exact: true }).first();
    if (await item.count()) { await item.scrollIntoViewIfNeeded().catch(() => {}); await item.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(150); }
  }
  for (let i = 0; i < 3 && (await general.isVisible().catch(() => false)) && (await toggle.count()); i++) { await toggle.click().catch(() => {}); await page.waitForTimeout(500); }
  await page.waitForTimeout(300);
}

const STRIP = '[data-testid="document-tabs"], [data-testid="tab-bar"]';
async function measure(page) {
  return page.evaluate((STRIP) => {
    const strip = document.querySelector(STRIP) || Array.from(document.querySelectorAll('div')).find((d) => d.className?.includes?.('overflow-x-auto') && d.querySelector('[title="Close tab"]'));
    const tabs = strip ? Array.from(strip.querySelectorAll('[data-testid="document-tab"], [draggable="true"]')) : [];
    const active = strip ? (strip.querySelector('[data-active="true"]') || tabs.find((t) => /border-b-os-blue|border-b-purple-600|border-b-green-600/.test(t.className))) : null;
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width), height: Math.round(b.height) }; };
    const closeBtn = active ? active.querySelector('[title="Close tab"], [aria-label^="Close"]') : null;
    let closeHit = null;
    if (closeBtn) { const b = closeBtn.getBoundingClientRect(); const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); closeHit = !!el && (closeBtn === el || closeBtn.contains(el)); }
    const overflowMenu = document.querySelector('[data-testid="tabs-overflow"]');
    const editor = document.getElementById('editor-container');
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map((i) => parseFloat(getComputedStyle(i).fontSize)).filter((n) => !Number.isNaN(n));
    return {
      innerWidth: window.innerWidth, pageScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
      strip: r(strip), stripScrollWidth: strip ? strip.scrollWidth : null, stripClientWidth: strip ? strip.clientWidth : null,
      tabCount: tabs.length, active: r(active), close: r(closeBtn), closeHit, overflowMenu: overflowMenu ? overflowMenu.textContent.trim() : null,
      editor: r(editor), minInputFont: inputs.length ? Math.min(...inputs) : null,
      viewportMeta: document.querySelector('meta[name=viewport]')?.getAttribute('content') || '',
    };
  }, STRIP);
}

const matrix = [
  ['webkit', pw.devices['iPhone 14 Pro'], 'iphone14pro-portrait'],
  ['webkit', pw.devices['iPhone 14 Pro landscape'], 'iphone14pro-landscape'],
  ['chromium', { ...pw.devices['iPhone 14 Pro'], defaultBrowserType: 'chromium' }, 'chromium-393'],
  ['chromium', { ...pw.devices['iPhone SE (3rd gen)'], defaultBrowserType: 'chromium' }, 'chromium-375'],
];
const counts = [1, 5, 15];
// a desktop window at the end: the contract there is "nothing changed" -
// full titles, hover-only close buttons, no "N open" menu (two tabs fit)
matrix.push(['chromium', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }, 'desktop-1280']);
const only = process.env.MOBILE_DEVICES ? process.env.MOBILE_DEVICES.split(',') : null;
try {
  for (const [browserName, device, label] of matrix) {
    if (only && !only.includes(label)) continue;
    if (label === 'desktop-1280') {
      let session;
      try { session = await openApp(browserName, device, label); } catch (error) { console.log(`SKIP: ${browserName} could not start (${error.message.slice(0, 100)})`); continue; }
      try {
        await seedAndOpen(session.page, 2);
        const m = await measure(session.page);
        const shot = path.join(outDir, `${label}-2tabs.png`);
        await session.page.screenshot({ path: shot, fullPage: false });
        console.log(`  ${label} / 2 tab(s): ${JSON.stringify({ tabs: m.tabCount, active: m.active, close: m.close, overflow: m.overflowMenu, strip: m.strip?.width, stripScroll: m.stripScrollWidth })}`);
        check(`${label}: 2 tabs opened`, m.tabCount === 2, String(m.tabCount));
        if (!BEFORE) {
          check(`${label}: tabs keep their full width (no phone truncation)`, m.active && m.active.width > 220, JSON.stringify(m.active));
          check(`${label}: the close button keeps its desktop size`, m.close && m.close.width < 32, JSON.stringify(m.close));
          check(`${label}: no "N open" menu while the tabs fit`, m.overflowMenu === null, String(m.overflowMenu));
          const hidden = await session.page.evaluate(() => { const b = document.querySelector('[data-active="true"] [title="Close tab"]'); return b ? getComputedStyle(b).opacity : null; });
          check(`${label}: the close button stays hover-only`, hidden === '0', String(hidden));
        }
      } finally { await session.browser.close(); }
      continue;
    }
    let session;
    try { session = await openApp(browserName, device, label); } catch (error) { console.log(`SKIP: ${browserName} could not start (${error.message.slice(0, 100)}); npx playwright install ${browserName}`); continue; }
    const { browser, page, errors } = session;
    try {
      for (const n of counts) {
        await seedAndOpen(page, n);
        const m = await measure(page);
        const shot = path.join(outDir, `${label}-${n}tabs.png`);
        await page.screenshot({ path: shot, fullPage: false });
        const tag = `${label} / ${n} tab(s)`;
        console.log(`  ${tag}: ${JSON.stringify({ innerWidth: m.innerWidth, pageScrollWidth: m.pageScrollWidth, strip: m.strip?.width, stripScroll: m.stripScrollWidth, tabs: m.tabCount, active: m.active, close: m.close, closeHit: m.closeHit, overflow: m.overflowMenu, editor: m.editor?.width, minInput: m.minInputFont })}`);
        check(`${tag}: ${n} tab(s) opened`, m.tabCount === n, `${m.tabCount}`);
        if (BEFORE) continue;
        check(`${tag}: no horizontal page scroll`, m.pageScrollWidth <= m.innerWidth && m.bodyScrollWidth <= m.innerWidth, `${m.pageScrollWidth}/${m.bodyScrollWidth} vs ${m.innerWidth}`);
        check(`${tag}: the editor pane fits the viewport`, m.editor && m.editor.right <= m.innerWidth && m.editor.width > 0, JSON.stringify(m.editor));
        check(`${tag}: the tab strip fits the viewport`, m.strip && m.strip.right <= m.innerWidth, JSON.stringify(m.strip));
        if (n >= 5) check(`${tag}: the strip scrolls inside itself`, m.stripScrollWidth > m.stripClientWidth, `${m.stripScrollWidth} > ${m.stripClientWidth}`);
        check(`${tag}: the active tab is visible within the strip`, m.active && m.strip && m.active.left >= m.strip.left - 1 && m.active.right <= m.strip.right + 1, JSON.stringify({ active: m.active, strip: m.strip }));
        check(`${tag}: the active tab's close button is >= 32 px and clickable`, m.close && m.close.width >= 32 && m.close.height >= 32 && m.closeHit === true, JSON.stringify({ close: m.close, hit: m.closeHit }));
        if (n >= 5) {
          check(`${tag}: the "N open" menu is offered`, !!m.overflowMenu && new RegExp(`${n}`).test(m.overflowMenu), m.overflowMenu);
          await page.locator('[data-testid="tabs-overflow"]').click();
          await page.waitForTimeout(300);
          const listed = await page.locator('[data-testid="tabs-overflow-item"]').count();
          check(`${tag}: ...and lists every open document`, listed === n, String(listed));
          await page.locator('[data-testid="tabs-overflow-item"]').first().click();
          await page.waitForTimeout(400);
          const after = await measure(page);
          check(`${tag}: picking one switches to it and scrolls it into view`, after.active && after.strip && after.active.left >= after.strip.left - 1 && after.active.right <= after.strip.right + 1, JSON.stringify(after.active));
        }
        check(`${tag}: inputs are 16 px or larger (no zoom on focus)`, m.minInputFont === null || m.minInputFont >= 16, String(m.minInputFont));
        check(`${tag}: viewport-fit=cover is set`, /viewport-fit=cover/.test(m.viewportMeta), m.viewportMeta);
      }
      check(`${label}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 200));
    } finally {
      await browser.close();
    }
  }
  console.log(`screenshots in ${outDir}`);
} catch (error) {
  check('the scenario ran to the end', false, error.stack || error.message);
} finally {
  stopVite();
  if (!process.env.MOBILE_SHOTS_DIR) fs.rmSync(outDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
