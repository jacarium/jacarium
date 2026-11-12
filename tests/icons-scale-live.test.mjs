#!/usr/bin/env node
/**
 * Icons scale with the interface, live (Playwright against the Vite dev
 * server, no backend). Under "Scale the interface too" at 150 % and 200 %,
 * the icon-to-button ratio on the rail, a sidebar row, the editor toolbar,
 * a dialog button and a menu item stays what it is at 100 % (within a
 * pixel); at 100 % every lucide icon renders at exactly its size attribute
 * (pixel for pixel as before); the rail still fits (its ... button when it
 * overflows), and the workflow canvas' icons keep their own size.
 *
 * Needs playwright-core with Chromium. Port ICONS_TEST_PORT (5241).
 * Run: node tests/icons-scale-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.ICONS_TEST_PORT || 5241);
const OUT = process.env.ICONS_SHOTS_DIR || '/private/tmp/claude-501/shots/icons';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (ICONS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } };
const domClick = (locator) => locator.first().evaluate((el) => el.click());
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
// an icon and its control: rendered sizes and the ratio
// `dim`: the control's side the ratio is taken against - its height, or its width for the rail, whose buttons the rail
// squeezes vertically before its ... menu takes the overflow (the rail's fit, not the icon's)
const pair = (iconSel, controlSel, dim = 'height') => page.evaluate(([iconSel, controlSel, dim]) => {
  const icon = document.querySelector(iconSel); if (!icon) return null;
  const control = controlSel ? icon.closest(controlSel) : icon.parentElement; if (!control) return null;
  const ir = icon.getBoundingClientRect(); const cr = control.getBoundingClientRect();
  const side = dim === 'width' ? cr.width : cr.height;
  return { icon: ir.width, iconH: ir.height, attr: Number(icon.getAttribute('width')), control: side, controlW: cr.width, controlH: cr.height, ratio: ir.width / side, stroke: getComputedStyle(icon).strokeWidth };
}, [iconSel, controlSel, dim]);
// the Documents sidebar's hamburger menu is a portalled, fixed div: mark the one that holds "New Document" for the selectors
const markMenu = () => page.evaluate(() => { const m = Array.from(document.querySelectorAll('div')).find((d) => getComputedStyle(d).position === 'fixed' && /New Document/.test(d.textContent) && d.querySelector('button svg.lucide')); document.querySelectorAll('[data-test-menu]').forEach((e) => e.removeAttribute('data-test-menu')); if (m) m.setAttribute('data-test-menu', ''); return !!m; });
// every lucide icon on the page: rendered width against its attribute
const allIcons = () => page.evaluate(() => Array.from(document.querySelectorAll('svg.lucide')).filter((s) => s.getClientRects().length && !s.closest('[data-icons-fixed]')).map((s) => ({ attr: Number(s.getAttribute('width')), w: s.getBoundingClientRect().width, name: (s.getAttribute('class') || '').split(' ')[1] })));
const scale = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ra-chrome-scale')) || 1);
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

const SPOTS = [
  ['the rail button', 'nav.w-16 button[aria-label="Documents"] svg.lucide', 'button', 'width'],
  ['a sidebar row', '[data-side="left"] .sc-row svg.lucide, [data-side="left"] button svg.lucide', '.sc-row, button'],
  ['the editor toolbar', '[data-testid="editor-mode-toggle"] svg.lucide', 'button'],
];
try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  const nd = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'New Document' && el.offsetParent); if (!b) return false; b.click(); return true; });
  check('New Document (the editor toolbar)', nd);
  await page.locator('.sc-editor-cm .cm-content').waitFor({ timeout: 15000 }); await sleep(300);
  // 100 %: every icon is its attribute size, pixel for pixel
  let icons = await allIcons();
  check(`at 100 % every lucide icon in view (${icons.length}) renders at exactly its size attribute (${Array.from(new Set(icons.map((i) => i.attr))).sort((a, b) => a - b).join('/')} px)`, icons.length > 20 && icons.every((i) => Math.abs(i.w - i.attr) < 0.5), JSON.stringify(icons.filter((i) => Math.abs(i.w - i.attr) >= 0.5).slice(0, 5)));
  const base = {};
  for (const [name, iconSel, controlSel, dim] of SPOTS) { base[name] = await pair(iconSel, controlSel, dim); check(`100 %: ${name}: an icon of ${base[name] && base[name].attr} px in a ${base[name] && Math.round(base[name].control)} px control`, !!base[name] && base[name].icon === base[name].attr, JSON.stringify(base[name])); }
  // a dialog button (Settings' close) and a menu item (the Documents sidebar's hamburger menu)
  await page.locator('[data-testid="sidebar-brand-mark"]').evaluate((el) => el.click()); await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 }); await sleep(300);
  base.dialog = await pair('[data-testid="settings-modal"] svg.lucide, [data-testid="settings-modal"] svg[data-icon]', 'button, .sc-rail-tab');
  check(`100 %: a dialog button: an icon of ${base.dialog && base.dialog.attr} px`, !!base.dialog && base.dialog.icon === base.dialog.attr, JSON.stringify(base.dialog));
  await page.keyboard.press('Escape'); await sleep(300);
  await page.locator('[data-side="left"] button[aria-label="Menu"]').first().click(); await sleep(400); await markMenu();
  base.menu = await pair('[data-test-menu] svg.lucide', 'button');
  check(`100 %: a menu item: an icon of ${base.menu && base.menu.attr} px`, !!base.menu && base.menu.icon === base.menu.attr, JSON.stringify(base.menu));
  await page.keyboard.press('Escape'); await sleep(200);
  // the reading text scale alone leaves the icons (they follow the interface scale, not the text)
  await setAids({ textScale: 150, scaleChrome: false }); await sleep(500);
  icons = await allIcons();
  check('Text size 150 % without the interface toggle: the icons stay at their attribute size (icons follow the interface scale, not the reading text)', icons.every((i) => Math.abs(i.w - i.attr) < 0.5) && (await scale()) === 1, JSON.stringify(icons.filter((i) => Math.abs(i.w - i.attr) >= 0.5).slice(0, 3)));
  for (const pct of [150, 200]) {
    await setAids({ textScale: pct, scaleChrome: true }); await sleep(700);
    const k = await scale();
    check(`${pct} % with the interface scaled: --ra-chrome-scale is ${k}`, Math.abs(k - pct / 100) < 0.01);
    icons = await allIcons();
    check(`${pct} %: every icon in view renders at its size times ${k} (strokes scale with them)`, icons.length > 20 && icons.every((i) => Math.abs(i.w - i.attr * k) < 0.75), JSON.stringify(icons.filter((i) => Math.abs(i.w - i.attr * k) >= 0.75).slice(0, 5)));
    for (const [name, iconSel, controlSel, dim] of SPOTS) {
      const now = await pair(iconSel, controlSel, dim);
      check(`${pct} %: ${name}: the icon-to-control ratio holds (${base[name] && base[name].ratio.toFixed(3)} -> ${now && now.ratio.toFixed(3)}; icon ${now && Math.round(now.icon)} px in ${now && Math.round(now.control)} px)`, !!now && !!base[name] && Math.abs(now.ratio - base[name].ratio) * now.control <= 1.5, JSON.stringify({ base: base[name], now }));
    }
    await page.locator('[data-testid="sidebar-brand-mark"]').evaluate((el) => el.click()); await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 }); await sleep(300);
    const dialog = await pair('[data-testid="settings-modal"] svg.lucide, [data-testid="settings-modal"] svg[data-icon]', 'button, .sc-rail-tab');
    check(`${pct} %: a dialog button keeps its ratio (${base.dialog && base.dialog.ratio.toFixed(3)} -> ${dialog && dialog.ratio.toFixed(3)})`, !!dialog && Math.abs(dialog.ratio - base.dialog.ratio) * dialog.control <= 1.5, JSON.stringify({ base: base.dialog, dialog }));
    if (pct === 150) await shot('settings-150');
    await page.keyboard.press('Escape'); await sleep(300);
    await page.locator('[data-side="left"] button[aria-label="Menu"]').first().click(); await sleep(400); await markMenu();
    const menu = await pair('[data-test-menu] svg.lucide', 'button');
    check(`${pct} %: a menu item keeps its ratio (${base.menu && base.menu.ratio.toFixed(3)} -> ${menu && menu.ratio.toFixed(3)})`, !!menu && Math.abs(menu.ratio - base.menu.ratio) * menu.control <= 1.5, JSON.stringify({ base: base.menu, menu }));
    await page.keyboard.press('Escape'); await sleep(200);
    // the rail still fits: every button inside the rail, or the ... button present
    const rail = await page.evaluate(() => { const nav = document.querySelector('nav.w-16'); const r = nav.getBoundingClientRect(); const buttons = Array.from(nav.querySelectorAll('button')).filter((b) => b.getClientRects().length); return { inside: buttons.every((b) => { const bb = b.getBoundingClientRect(); return bb.top >= r.top - 1 && bb.bottom <= r.bottom + 1; }), more: !!document.querySelector('[data-testid="rail-more"]'), brand: (() => { const m = document.querySelector('[data-testid="sidebar-brand-mark"] svg'); const b = document.querySelector('[data-testid="sidebar-brand-mark"]'); return m && b ? { icon: m.getBoundingClientRect().width, button: b.getBoundingClientRect().width } : null; })() }; });
    check(`${pct} %: the rail still fits (every button inside the rail; the ... menu takes the overflow: ${rail.more}), the brand mark scaled with its button (${rail.brand && Math.round(rail.brand.icon)} in ${rail.brand && Math.round(rail.brand.button)} px)`, rail.inside && rail.brand && rail.brand.icon > 36 && rail.brand.icon <= rail.brand.button + 1, JSON.stringify(rail));
    await shot(`documents-${pct}`);
  }
  // the workflow canvas keeps its own icon sizes
  await domClick(page.locator('nav.w-16 button[aria-label="Workflow Builder"], [data-testid="rail-more"]')); await sleep(600);
  if (!(await page.locator('.react-flow').count())) { const row = page.locator('[data-testid="rail-more-menu"] button', { hasText: 'Workflow Builder' }); if (await row.count()) { await domClick(row); await sleep(600); } }
  const newWf = page.locator('button', { hasText: /^New Workflow$/ }).first();
  if (await newWf.count()) { await domClick(newWf); await sleep(1200); }
  // the canvas is zoomed by React Flow (its viewport transform); an icon's rendered width is its attribute times that zoom, with no interface scale on top
  const canvasIcons = await page.evaluate(() => { const vp = document.querySelector('.react-flow__viewport'); const m = vp ? /matrix\(([^,]+),/.exec(getComputedStyle(vp).transform) : null; const zoom = m ? parseFloat(m[1]) : 1; return { zoom, icons: Array.from(document.querySelectorAll('[data-icons-fixed] svg.lucide')).filter((s) => s.getClientRects().length).map((s) => ({ attr: Number(s.getAttribute('width')), w: s.getBoundingClientRect().width })) }; });
  check(`the workflow canvas' icons (${canvasIcons.icons.length}, canvas zoom ${canvasIcons.zoom.toFixed(2)}) keep their own size at 200 % (graphics are not interface controls)`, canvasIcons.icons.length === 0 || canvasIcons.icons.every((i) => Math.abs(i.w - i.attr * canvasIcons.zoom) < 0.75), JSON.stringify(canvasIcons));
  await setAids({ textScale: 100, scaleChrome: false }); await sleep(400);
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 14).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
