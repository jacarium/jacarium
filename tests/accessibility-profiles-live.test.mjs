#!/usr/bin/env node
/**
 * The accessibility profiles live (Playwright against the Vite dev server,
 * no backend): each card in Settings > Accessibility applies its bundle at
 * once - the computed styles of the Documents Preview (font, line height,
 * letter spacing, the column, the ruler) and of the Tasks page (the font,
 * high contrast, the palette's accent, the saturation filter) follow; a
 * manual change shows Custom based on the profile; Reset brings Default
 * back; the arrows choose from the keyboard. Screenshots of the row in dark
 * and light and of two profiles applied go to READING_AIDS_SHOTS_DIR/profiles.
 *
 * Needs playwright-core with Chromium. Port PROFILES_TEST_PORT (5223).
 * Run: node tests/accessibility-profiles-live.test.mjs
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
const PORT = Number(process.env.PROFILES_TEST_PORT || 5223);
const OUT = path.join(process.env.READING_AIDS_SHOTS_DIR || '/private/tmp/claude-501/shots/reading-aids', 'profiles');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (PROFILES_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const P = await import(path.join(REPO, 'src/utils/readingAidProfiles.js'));
const DOC = ['# Profiles', '', 'A paragraph long enough to wrap onto a few lines so that the column, the spacing and the ruler have something to show when a profile is chosen.', '', 'A second paragraph.', ''].join('\n');

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); if (!localStorage.getItem('app-theme')) localStorage.setItem('app-theme', 'dark'); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
await context.route('**/api/version', (r) => r.fulfill({ json: { app: '4.3.1', protocol: 2 } }));
await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
await context.route('**/socket.io/**', (r) => r.abort());
await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }).catch(() => {}); };
const clickButton = (label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
const goTo = async (label) => {
  const b = page.locator(`nav.w-16 button[aria-label="${label}"]`);
  if (await b.count()) { await b.first().click(); await page.mouse.move(700, 450); await sleep(700); return; }
  // a page that did not fit in the rail (a scaled interface) sits in its "..." menu
  await page.locator('[data-testid="rail-more"]').click(); await sleep(200);
  await page.locator('[data-testid="rail-more-menu"] button', { hasText: label }).first().click(); await page.mouse.move(700, 450); await sleep(700);
};
const openSettings = async (tab) => { if (!(await page.locator('[data-testid="settings-modal"]').count())) { await page.locator('[data-testid="sidebar-brand-mark"]').click(); await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 }); } await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: tab }).click(); await sleep(250); };
const closeSettings = async () => { if (await page.locator('[data-testid="settings-modal"]').count()) { await page.keyboard.press('Escape'); await sleep(300); } };
const SURF = '[data-testid="reading-aids-surface"]';
const isPreview = () => page.evaluate((s) => !!document.querySelector(`${s} .markdown-preview`), SURF);
const toPreview = async () => { for (let i = 0; i < 3 && !(await isPreview()); i++) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await sleep(400); } await page.locator(`${SURF} .markdown-preview p`).first().waitFor({ timeout: 15000 }); await sleep(200); };
const checkedId = () => page.evaluate(() => { const c = document.querySelector('[data-testid="ra-profiles"] [role="radio"][aria-checked="true"]'); return c ? c.getAttribute('data-testid').replace('ra-profile-', '') : null; });
const stateLine = () => page.locator('[data-testid="ra-profile-state"]').textContent();
const probeDocs = () => page.evaluate((s) => {
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  const surf = document.querySelector(s); const p = surf && surf.querySelector('.markdown-preview p'); const pv = surf && surf.querySelector('.markdown-preview');
  const html = document.documentElement;
  return { font: cs(p, 'fontFamily'), line: cs(p, 'lineHeight'), letter: cs(p, 'letterSpacing'), size: cs(p, 'fontSize'), padLeft: cs(pv, 'paddingLeft'), margin: cs(p, 'marginBottom'), align: cs(p, 'textAlign'), bg: cs(pv, 'backgroundColor'), filter: cs(html, 'filter'), classes: html.className, rootSize: cs(html, 'fontSize'), ruler: !!document.querySelector('[data-testid="reading-ruler"]'), rulerMode: document.querySelector('[data-testid="reading-ruler"]')?.getAttribute('data-mode') || null };
}, SURF);
const probeTasks = () => page.evaluate(() => { const cs = (el, p) => (el ? getComputedStyle(el)[p] : null); const h = document.querySelector('h2, h3, p'); return { font: cs(h, 'fontFamily'), bodyBg: cs(document.body, 'backgroundColor'), accent: getComputedStyle(document.body).getPropertyValue('--os-blue').trim(), filter: cs(document.documentElement, 'filter'), rootSize: cs(document.documentElement, 'fontSize') }; });
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const px = (v) => parseFloat(v);

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  check('New Document', await clickButton('New Document'));
  await page.locator('.sc-editor-cm .cm-content').waitFor({ timeout: 15000 }); await sleep(400);
  await page.locator('.sc-editor-cm .cm-content').click();
  await page.keyboard.insertText(DOC); await sleep(500);
  await toPreview();
  const base = await probeDocs();
  await openSettings('Accessibility');
  check('the row of profile cards at the top: a radio group, one card per profile, Default checked', (await page.locator('[data-testid="ra-profiles"][role="radiogroup"] [role="radio"]').count()) === P.PROFILES.length && (await checkedId()) === 'default' && /Profile: Default/.test(await stateLine()));
  await page.locator('[data-testid="ra-profiles-block"]').screenshot({ path: path.join(OUT, 'profiles-row-dark.png') });

  // every card: click, then the Documents Preview and the Tasks page follow
  const expectDocs = {
    comfortable: (d) => Math.abs(px(d.line) - 31.68) < 0.05 && Math.abs(px(d.margin) - 26.4) < 0.05 && px(d.padLeft) > 24 && px(d.size) === 17.6,
    dyslexia: (d) => /Lexend/.test(d.font) && d.letter === '0.8px' && px(d.padLeft) > 24 && d.align === 'start' && d.ruler && d.rulerMode === 'highlight' && d.line === '28.8px',
    lowVision: (d) => /Atkinson/.test(d.font) && d.bg === 'rgb(0, 0, 0)' && d.rootSize === '24px' && px(d.size) === 24,
    focus: (d) => d.ruler && d.rulerMode === 'mask' && d.filter === 'saturate(0.6)' && px(d.padLeft) > 24,
    cvRed: (d) => /ra-cv-protanopia/.test(d.classes), cvGreen: (d) => /ra-cv-deuteranopia/.test(d.classes), cvBlue: (d) => /ra-cv-tritanopia/.test(d.classes),
    calm: (d) => d.filter === 'saturate(0.6)' && d.line === base.line && d.font === base.font,
    default: (d) => d.font === base.font && d.line === base.line && d.padLeft === base.padLeft && d.filter === 'none' && !d.ruler,
  };
  const expectTasks = {
    comfortable: (t) => t.rootSize === '16px', dyslexia: (t) => /Lexend/.test(t.font), lowVision: (t) => t.bodyBg === 'rgb(0, 0, 0)' && t.rootSize === '24px' && /Atkinson/.test(t.font),
    focus: (t) => t.filter === 'saturate(0.6)', cvRed: (t) => t.accent === '#2787be', cvGreen: (t) => t.accent === '#2787be', cvBlue: (t) => t.accent === '#009e73', calm: (t) => t.filter === 'saturate(0.6)', default: (t) => t.filter === 'none' && t.bodyBg !== 'rgb(0, 0, 0)',
  };
  for (const p of P.PROFILES) {
    await openSettings('Accessibility');
    await page.locator(`[data-testid="ra-profile-${p.id}"]`).click(); await sleep(400);
    const checked = await checkedId(); const line = await stateLine();
    if (p.id === 'lowVision' || p.id === 'default') {
      // the card descriptions are rem-sized (text-2xs = 11px at the 16px root): under Low vision (150 %, the interface too) they grow with the root
      const descPx = await page.evaluate((id) => parseFloat(getComputedStyle(document.getElementById(`ra-profile-${id}-desc`)).fontSize), p.id);
      const want = p.id === 'lowVision' ? 16.5 : 11;
      check(`${p.name}: the profile card descriptions read at ${want} px (11 px × the interface scale)`, Math.abs(descPx - want) < 0.6, `font-size ${descPx}px`);
    }
    await closeSettings();
    await goTo('Documents'); await toPreview();
    const d = await probeDocs();
    if (p.id === 'dyslexia') await shot('applied-dyslexia-documents');
    await goTo('Tasks');
    const t = await probeTasks();
    if (p.id === 'lowVision') await shot('applied-low-vision-tasks');
    check(`${p.name}: the card is checked and named in the state line; the Documents Preview and the Tasks page carry its settings`, checked === p.id && line.includes(p.name) && expectDocs[p.id](d) && expectTasks[p.id](t), JSON.stringify({ checked, d, t }));
  }
  // a manual change -> Custom (based on ...); Reset -> Default; the arrows choose
  await openSettings('Accessibility');
  await page.locator('[data-testid="ra-profile-focus"]').click(); await sleep(300);
  await page.locator('[data-testid="ra-line-height"]').selectOption('2'); await sleep(300);
  check('a manual change after Focus: no card checked, "Custom (based on Focus)"', (await checkedId()) === null && /Custom \(based on Focus\)/.test(await stateLine()), await stateLine());
  await page.locator('[data-testid="ra-reset"]').click(); await sleep(300);
  check('Reset to defaults: Default checked again', (await checkedId()) === 'default');
  await page.locator('[data-testid="ra-profile-default"]').focus();
  await page.keyboard.press('ArrowRight'); await sleep(300);
  check('ArrowRight on the checked card chooses the next profile (Comfortable reading) and moves the focus to it', (await checkedId()) === 'comfortable' && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'ra-profile-comfortable');
  await page.keyboard.press('End'); await sleep(300);
  check('End chooses the last profile (Calm)', (await checkedId()) === 'calm');
  await page.locator('[data-testid="ra-reset"]').click(); await sleep(200);
  await closeSettings();
  // the row in the light theme
  await page.evaluate(() => localStorage.setItem('app-theme', 'light'));
  await page.reload({ waitUntil: 'load' }); await sleep(1200); await dismiss();
  await openSettings('Accessibility');
  await page.locator('[data-testid="ra-profiles-block"]').screenshot({ path: path.join(OUT, 'profiles-row-light.png') });
  check('light: Default checked after the reset survived the reload', (await checkedId()) === 'default');
  await closeSettings();
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`  screenshots: ${OUT}`);
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
