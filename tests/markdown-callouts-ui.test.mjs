#!/usr/bin/env node
/**
 * GitHub-style callouts in the real Documents page (headless Chromium):
 *   - the preview renders the five types with the theme's colours (border,
 *     tint and icon per type, told apart; Important and Caution - both red
 *     families - differ in icon and title), in dark and in light;
 *   - the toolbar's "Insert callout" menu inserts the marker around the
 *     selection, each selected line quoted; the slash menu offers /note ...
 *     /caution and inserts the marker;
 *   - on the phone the preview renders them too (its own padding and icon size).
 * Writes /tmp/jacarium-callouts/{dark,light}-callouts.png (desktop preview)
 * and phone-callouts.png.
 *
 * SKIPs like tests/mobile-ui.test.mjs (no Chromium, no port, Vite down).
 * Run: node tests/markdown-callouts-ui.test.mjs
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
const PORT = Number(process.env.CALLOUTS_UI_TEST_PORT || 5196);
const OUT = '/tmp/jacarium-callouts';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (CALLOUTS_UI_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]}) - npx playwright install chromium`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const MD = [
  '# Callouts',
  '> [!NOTE]\n> A note: something worth knowing.',
  '> [!TIP]\n> A tip: a shortcut.',
  '> [!IMPORTANT]\n> Important: read this.',
  '> [!WARNING] Before you run it\n> Back up first.',
  '> [!CAUTION]\n> Caution: this is destructive.',
].join('\n\n');
const TYPES = ['note', 'tip', 'important', 'warning', 'caution'];

async function open(device, { theme = 'dark' } = {}) {
  const context = await browser.newContext({ ...device, reducedMotion: 'reduce', colorScheme: theme === 'light' ? 'light' : 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.evaluate(async ({ md, theme }) => {
    const { db } = await import('/src/db/database.js');
    await db.documents.clear();
    const id = await db.documents.add({ title: 'Callouts', content: md, category: 'General', stableId: 'sid-callouts', createdAt: new Date(), updatedAt: new Date() });
    localStorage.setItem('documentOpenTabs', JSON.stringify([{ id, title: 'Callouts', category: 'General', inCloud: false }]));
    localStorage.setItem('currentDocumentId', JSON.stringify(id));
    localStorage.setItem('whatsNewLastSeen', '99.0.0');
    if (theme === 'light') localStorage.setItem('app-theme', JSON.stringify('light')); else localStorage.removeItem('app-theme');
  }, { md: MD, theme });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  return { context, page, errors };
}
const toPreview = async (page) => {
  if (!(await page.locator('.markdown-preview').count())) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(600); }
};
const measure = (page) => page.evaluate((types) => {
  const probe = document.createElement('div'); document.body.appendChild(probe);
  const rgb = (token) => { probe.style.backgroundColor = ''; probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue(token).trim(); return getComputedStyle(probe).backgroundColor; };
  const tokens = { note: rgb('--os-blue'), tip: rgb('--os-status-success'), important: rgb('--os-code-keyword'), warning: rgb('--os-terminal-warning'), caution: rgb('--os-terminal-error') };
  const out = {};
  for (const type of types) {
    const el = document.querySelector(`.markdown-preview .md-callout-${type}`);
    if (!el) { out[type] = null; continue; }
    const cs = getComputedStyle(el);
    const title = el.querySelector('.md-callout-title');
    const icon = el.querySelector('.md-callout-icon');
    const ics = icon && getComputedStyle(icon);
    out[type] = { bar: cs.borderLeftColor, barWidth: cs.borderLeftWidth, bg: cs.backgroundColor, title: title?.textContent.trim(), titleColor: title && getComputedStyle(title).color, icon: !!icon && (ics.maskImage !== 'none' || ics.webkitMaskImage !== 'none'), iconSize: ics && ics.width, iconColor: ics && ics.backgroundColor, token: tokens[type] };
  }
  probe.remove();
  return out;
}, TYPES);
const sameRgb = (a, b) => a && b && a.replace(/\s/g, '') === b.replace(/\s/g, '');

try {
  for (const theme of ['dark', 'light']) {
    const desk = await open({ viewport: { width: 1280, height: 900 } }, { theme });
    const { page } = desk;
    await toPreview(page);
    const m = await measure(page);
    check(`${theme}: the five callouts render in the preview, each with the bar, the tint and the icon in its type's token colour`, TYPES.every((t) => m[t] && sameRgb(m[t].bar, m[t].token) && m[t].barWidth === '3px' && m[t].icon && sameRgb(m[t].iconColor, m[t].token) && sameRgb(m[t].titleColor, m[t].token) && m[t].bg !== 'rgba(0, 0, 0, 0)'), JSON.stringify(m).slice(0, 500));
    check(`${theme}: the five colours are five different colours; the titles name the types (Warning carries its custom title)`, new Set(TYPES.map((t) => m[t]?.bar)).size === 5 && m.note.title === 'Note' && m.tip.title === 'Tip' && m.important.title === 'Important' && m.warning.title === 'Before you run it' && m.caution.title === 'Caution', JSON.stringify(TYPES.map((t) => [t, m[t]?.bar, m[t]?.title])));
    check(`${theme}: Important and Caution are told apart by their icons (different masks) and titles`, await page.evaluate(() => { const a = getComputedStyle(document.querySelector('.md-callout-important .md-callout-icon')); const b = getComputedStyle(document.querySelector('.md-callout-caution .md-callout-icon')); return (a.maskImage || a.webkitMaskImage) !== (b.maskImage || b.webkitMaskImage); }));
    const region = page.locator('.markdown-preview');
    await region.screenshot({ path: path.join(OUT, `${theme}-callouts.png`) });
    check(`${theme}: no page errors`, desk.errors.length === 0, desk.errors.slice(0, 3).join(' | '));
    if (theme === 'dark') {
      // the editor: the toolbar menu and the slash entries (a second toggle click within 1s would
      // escalate to preview-all, so wait it out, then leave the preview)
      await page.waitForTimeout(1200);
      await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(500);
      if (await page.locator('.markdown-preview').count()) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(500); }
      const textarea = page.locator('.sc-editor-textarea');
      check('the editor is back (textarea present)', await textarea.count() === 1);
      await textarea.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
      await page.locator('[data-testid="insert-menu-button"]').click(); await page.waitForTimeout(200);
      const items = await page.locator('[data-testid="insert-menu"] [data-menu-item^="callout-"]').allTextContents();
      check('the toolbar\'s Insert menu lists the callouts Note, Tip, Important, Warning, Caution', items.map((t) => t.trim()).join() === 'Note,Tip,Important,Warning,Caution', items.join());
      const dmenu = await page.evaluate(() => { const menu = document.querySelector('[data-testid="insert-menu"]'); const b = document.querySelector('[data-testid="insert-menu-button"]').getBoundingClientRect(); const r = menu.getBoundingClientRect(); const rows = Array.from(menu.querySelectorAll('[role="menuitem"]')); return { inBody: menu.parentElement === document.body, underButton: Math.abs(r.top - b.bottom) <= 6 && Math.abs(r.left - b.left) <= 1, reachable: rows.every((row) => { const rr = row.getBoundingClientRect(); const hit = document.elementFromPoint(rr.left + 10, rr.top + rr.height / 2); return hit && menu.contains(hit); }) }; });
      check('desktop: the menu is portalled under its button (left-aligned) and every row is reachable', dmenu.inBody && dmenu.underButton && dmenu.reachable, JSON.stringify(dmenu));
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      check('desktop: Escape closes the menu', await page.locator('[data-testid="insert-menu"]').count() === 0);
      await page.locator('[data-testid="insert-menu-button"]').click(); await page.waitForTimeout(200);
      await page.locator('[data-testid="insert-menu"] [data-menu-item="callout-tip"]').click(); await page.waitForTimeout(300);
      const afterInsert = await textarea.inputValue();
      check('choosing Tip inserts "> [!TIP]" with a quoted placeholder line on its own paragraph', /\n\n> \[!TIP\]\n> Tip text$/.test(afterInsert), JSON.stringify(afterInsert.slice(-60)));
      // a selection of two lines becomes a quoted body under the marker
      await textarea.fill('first line\nsecond line'); await page.waitForTimeout(200);
      await textarea.evaluate((el) => { el.focus(); el.setSelectionRange(0, el.value.length); });
      await page.locator('[data-testid="insert-menu-button"]').click(); await page.waitForTimeout(200);
      await page.locator('[data-testid="insert-menu"] [data-menu-item="callout-warning"]').click(); await page.waitForTimeout(300);
      check('a two-line selection is wrapped: the marker, then each line quoted', (await textarea.inputValue()) === '> [!WARNING]\n> first line\n> second line', JSON.stringify(await textarea.inputValue()));
      // the slash menu
      await textarea.fill('Intro\n\n'); await page.waitForTimeout(200);
      await textarea.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
      await page.keyboard.type('/cau'); await page.waitForTimeout(400);
      const slashItems = await page.evaluate(() => Array.from(document.querySelectorAll('.fixed .text-sm.font-medium')).map((e) => e.textContent.trim()));
      check('typing "/cau" offers the Caution callout (/caution) entry in the slash menu', slashItems.some((t) => /\/caution/.test(t)), slashItems.join());
      await page.keyboard.press('Enter'); await page.waitForTimeout(300);
      check('Enter inserts the Caution marker in place of the command', /^Intro\n\n> \[!CAUTION\]\n> $/.test(await textarea.inputValue()), JSON.stringify(await textarea.inputValue()));
    }
    await desk.context.close();
  }
  // the phone
  const phone = await open(pw.devices['iPhone 14 Pro'], { theme: 'dark' });
  await phone.page.waitForTimeout(500);
  await toPreview(phone.page);
  const pm = await measure(phone.page);
  const pIcon = await phone.page.evaluate(() => { const i = document.querySelector('.md-callout-icon'); return i ? getComputedStyle(i).width : null; });
  check('phone: the five callouts render in the preview with the phone\'s 18px icons', TYPES.every((t) => pm[t] && sameRgb(pm[t].bar, pm[t].token)) && pIcon === '18px', JSON.stringify({ pIcon, pm: TYPES.map((t) => pm[t]?.bar) }));
  await phone.page.screenshot({ path: path.join(OUT, 'phone-callouts.png') });
  // the toolbar's "Insert callout" menu on the phone: the toolbar is a horizontal scroll strip
  // (overflow-x: auto) that clipped an in-place dropdown - the menu is portalled, fixed, under
  // its button, every row reachable; a choice inserts the callout
  await phone.page.waitForTimeout(1200);
  await phone.page.locator('[data-testid="editor-mode-toggle"]').click(); await phone.page.waitForTimeout(500);
  if (await phone.page.locator('.markdown-preview').count()) { await phone.page.locator('[data-testid="editor-mode-toggle"]').click(); await phone.page.waitForTimeout(500); }
  const pta = phone.page.locator('.sc-editor-textarea');
  check('phone: the editor is back', await pta.count() === 1);
  await pta.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  // on the phone the callouts live in the toolbar's "More" menu (the strip fits without scrolling;
  // the menu is capped at the space under its button and scrolls, so a row is reachable once scrolled into view)
  await phone.page.locator('[data-testid="more-menu-button"]').tap(); await phone.page.waitForTimeout(300);
  const pmenu = await phone.page.evaluate(() => {
    const menu = document.querySelector('[data-testid="more-menu"]');
    const button = document.querySelector('[data-testid="more-menu-button"]');
    if (!menu) return { menu: false };
    const r = menu.getBoundingClientRect(); const b = button.getBoundingClientRect();
    const rows = Array.from(menu.querySelectorAll('[data-menu-item^="callout-"]')).map((row) => { row.scrollIntoView({ block: 'nearest' }); const rr = row.getBoundingClientRect(); const hit = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2); return { type: row.getAttribute('data-menu-item'), reachable: !!hit && menu.contains(hit) }; });
    return { menu: true, inBody: menu.parentElement === document.body, position: getComputedStyle(menu).position, z: getComputedStyle(menu).zIndex, underButton: Math.abs(r.top - b.bottom) <= 6, onScreen: r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight, rows };
  });
  check('phone: the Insert callout menu is portalled (fixed, z-40), hangs under its button, fully on screen, every row reachable (elementFromPoint is the menu, not the editor)', pmenu.menu && pmenu.inBody && pmenu.position === 'fixed' && pmenu.z === '40' && pmenu.underButton && pmenu.onScreen && pmenu.rows.length === 5 && pmenu.rows.every((r) => r.reachable), JSON.stringify(pmenu));
  await phone.page.locator('[data-testid="more-menu"] [data-menu-item="callout-tip"]').tap(); await phone.page.waitForTimeout(300);
  check('phone: tapping Tip inserts the callout and closes the menu', /> \[!TIP\]\n> Tip text$/.test(await pta.inputValue()) && await phone.page.locator('[data-testid="more-menu"]').count() === 0, JSON.stringify((await pta.inputValue()).slice(-40)));
  await phone.page.locator('[data-testid="more-menu-button"]').tap(); await phone.page.waitForTimeout(200);
  await phone.page.touchscreen.tap(200, 500); await phone.page.waitForTimeout(200);
  check('phone: a tap outside closes the menu', await phone.page.locator('[data-testid="more-menu"]').count() === 0);
  check('phone: no page errors', phone.errors.length === 0, phone.errors.slice(0, 3).join(' | '));
  await phone.context.close();
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
