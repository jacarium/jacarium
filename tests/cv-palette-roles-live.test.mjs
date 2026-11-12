#!/usr/bin/env node
/**
 * Every colour role follows the colour-vision palettes (Playwright against
 * the Vite dev server, no backend). For each palette in light and dark: the
 * info note in Settings (its background, text and border), the five
 * callouts of a document's Preview, a danger button, the eight chart
 * categories and the collaborator colours on <body>, and the rail of a
 * gradient scheme take the palette's colours - not the theme's blue - with
 * the note's text at 4.5:1 or better; the theme gallery's swatches keep the
 * real theme colours (they depict a theme rather than paint the UI).
 * Screenshots of Settings, Tasks, Kanban, Calendars and Diagnostics under
 * blue-weak and red-weak go to READING_AIDS_SHOTS_DIR/roles.
 *
 * Needs playwright-core with Chromium. Port CV_ROLES_TEST_PORT (5224).
 * Run: node tests/cv-palette-roles-live.test.mjs
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
const PORT = Number(process.env.CV_ROLES_TEST_PORT || 5224);
const OUT = path.join(process.env.READING_AIDS_SHOTS_DIR || '/private/tmp/claude-501/shots/reading-aids', 'roles');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (CV_ROLES_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const DOC = ['# Roles', '', '> [!NOTE]', '> a note', '', '> [!TIP]', '> a tip', '', '> [!IMPORTANT]', '> important', '', '> [!WARNING]', '> a warning', '', '> [!CAUTION]', '> caution', ''].join('\n');
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
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const goTo = async (label) => { const b = page.locator(`nav.w-16 button[aria-label="${label}"]`); if (await b.count()) { await b.first().click(); } else { await page.locator('[data-testid="rail-more"]').click(); await sleep(200); await page.locator('[data-testid="rail-more-menu"] button', { hasText: label }).first().click(); } await page.mouse.move(700, 450); await sleep(700); };
const openSettings = async (tab) => { if (!(await page.locator('[data-testid="settings-modal"]').count())) { await page.locator('[data-testid="sidebar-brand-mark"]').click(); await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 }); } await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: tab }).click(); await sleep(250); };
const closeSettings = async () => { if (await page.locator('[data-testid="settings-modal"]').count()) { await page.keyboard.press('Escape'); await sleep(300); } };
const SURF = '[data-testid="reading-aids-surface"]';
const toPreview = async () => { for (let i = 0; i < 3 && !(await page.evaluate((s) => !!document.querySelector(`${s} .markdown-preview`), SURF)); i++) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await sleep(400); } await page.locator(`${SURF} .markdown-preview .md-callout`).first().waitFor({ timeout: 15000 }); await sleep(200); };
// colours resolved to rgb on a canvas; the body's tokens the same way
const probe = () => page.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgb = (c, over = '#ffffff') => { if (!c) return null; ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = over; ctx.fillRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return `rgb(${d[0]}, ${d[1]}, ${d[2]})`; };
  const lum = (s) => { const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(s); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return m ? 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]) : 0; };
  const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const probe = document.createElement('div'); document.body.appendChild(probe);
  const token = (n) => { probe.style.backgroundColor = ''; probe.style.backgroundColor = `var(${n})`; return rgb(getComputedStyle(probe).backgroundColor); };
  const cardBg = rgb(getComputedStyle(document.body).getPropertyValue('--os-card').trim() || '#fff');
  const note = document.querySelector('[data-testid="ra-active-note"]');
  const noteCs = note && getComputedStyle(note);
  const noteBg = noteCs && rgb(noteCs.backgroundColor, cardBg);
  const noteFg = noteCs && rgb(noteCs.color, noteBg || cardBg);
  const callouts = Array.from(document.querySelectorAll('.markdown-preview .md-callout')).map((c) => ({ cls: Array.from(c.classList).find((k) => k.startsWith('md-callout-')) || 'note', color: rgb(getComputedStyle(c).borderLeftColor) }));
  const danger = Array.from(document.querySelectorAll('button')).find((b) => /Wipe Database/.test(b.textContent) && b.offsetParent);
  const rail = document.querySelector('nav.w-16');
  const swatch = document.querySelector('[data-testid="scheme-card-light"] span[title="accent"]');
  const out = {
    tokens: { infoFg: token('--status-info-fg'), infoBg: token('--status-info-bg'), infoBorder: token('--status-info-border'), accent: token('--os-blue'), dangerFg: token('--btn-danger-fg'), railActive: token('--os-rail-active'), buttonBg: token('--btn-primary-bg'), rail: token('--os-rail'), cats: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => token(`--chart-cat-${n}`)) },
    note: note ? { bg: noteBg, fg: noteFg, border: rgb(noteCs.borderTopColor), ratio: contrast(noteFg, noteBg) } : null,
    callouts, danger: danger ? rgb(getComputedStyle(danger).color) : null, railBg: rail ? getComputedStyle(rail).backgroundColor : null, railImage: rail ? getComputedStyle(rail).backgroundImage : null,
    swatch: swatch ? swatch.style.background : null,
  };
  probe.remove(); return out;
});
const THEME_BLUE = { light: 'rgb(0, 102, 204)', dark: 'rgb(74, 158, 255)' };
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  for (const mode of ['dark', 'light']) {
    await page.evaluate((m) => localStorage.setItem('app-theme', m), mode);
    await page.reload({ waitUntil: 'load' }); await sleep(1200); await dismiss();
    // the document with the five callouts, typed (the editor's own input path): into the editor the reload restored, else a new one
    await goTo('Documents');
    let editor = false;
    for (let i = 0; i < 60 && !editor; i++) {
      editor = (await page.locator('.sc-editor-cm .cm-content').count()) > 0;
      // the document comes back in the mode it was left in (Preview after the last pass): back to the editor
      if (!editor && (await page.locator('[data-testid="editor-mode-toggle"]').count())) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await sleep(500); editor = (await page.locator('.sc-editor-cm .cm-content').count()) > 0; }
      if (!editor && (await clickButton('New Document'))) { await sleep(600); editor = (await page.locator('.sc-editor-cm .cm-content').count()) > 0; }
      if (!editor) await sleep(250);
    }
    check(`${mode}: the editor is open (restored by the reload, or a new document)`, editor, await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent && b.textContent.trim()).map((b) => b.textContent.trim()).slice(0, 30).join(', ')));
    await sleep(400);
    await page.locator('.sc-editor-cm .cm-content').click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText(DOC); await sleep(600);
    for (const kind of ['protanopia', 'deuteranopia', 'tritanopia']) {
      await setAids({ colorVision: kind, highlightLinks: true }); await sleep(400);
      await goTo('Documents'); await toPreview();
      const docs = await probe();
      const distinct = new Set(docs.callouts.map((c) => c.color)).size;
      check(`${mode} + ${kind}: the five callouts (note, tip, important, warning, caution) each take a distinct palette colour, none the theme's blue`, docs.callouts.length === 5 && distinct === 5 && !docs.callouts.some((c) => c.color === THEME_BLUE[mode]), JSON.stringify(docs.callouts));
      check(`${mode} + ${kind}: the eight chart categories on <body> are distinct and none is the theme's blue; the collaborator colours draw from them`, new Set(docs.tokens.cats).size === 8 && !docs.tokens.cats.includes(THEME_BLUE[mode]) && !docs.tokens.cats.includes('rgb(37, 99, 235)'), JSON.stringify(docs.tokens.cats));
      await openSettings('Accessibility');
      const st = await probe();
      check(`${mode} + ${kind}: the info note in Settings is painted from the info family (background, text and border the tokens), its text at 4.5:1 or better, its border apart from the accent and from the theme's blue`, !!st.note && st.note.bg === st.tokens.infoBg && st.note.border === st.tokens.infoBorder && st.note.ratio >= 4.5 && st.tokens.infoBorder !== st.tokens.accent && st.note.border !== THEME_BLUE[mode] && st.note.border !== 'rgb(191, 219, 254)', JSON.stringify(st.note) + ' ' + JSON.stringify(st.tokens));
      await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: 'General' }).click(); await sleep(250);
      const gen = await probe();
      check(`${mode} + ${kind}: the danger button's text is the palette's danger colour (--btn-danger-fg)`, !!gen.danger && gen.danger === gen.tokens.dangerFg, JSON.stringify([gen.danger, gen.tokens.dangerFg]));
      await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: 'Theme' }).click(); await sleep(300);
      const th = await probe();
      check(`${mode} + ${kind}: the theme gallery's accent swatch keeps the real theme colour (it depicts a theme, it does not paint the UI)`, !!th.swatch && /#0066CC|rgb\(0, 102, 204\)/i.test(th.swatch), th.swatch);
      if (kind === 'tritanopia' && mode === 'dark') await shot('blue-weak-settings');
      if (kind === 'protanopia' && mode === 'dark') await shot('red-weak-settings');
      await closeSettings();
      if (mode === 'dark' && (kind === 'tritanopia' || kind === 'protanopia')) {
        const tag = kind === 'tritanopia' ? 'blue-weak' : 'red-weak';
        for (const [label, name] of [['Tasks', 'tasks'], ['Kanban', 'kanban'], ['Calendars', 'calendars'], ['Diagnostics', 'diagnostics']]) { await goTo(label); await shot(`${tag}-${name}`); }
      }
    }
    // a gradient scheme's rail under a palette takes the palette rail; its selected item the palette accent
    await page.evaluate(() => localStorage.setItem('app-theme', 'gradient-red-purple'));
    await page.reload({ waitUntil: 'load' }); await sleep(1200); await dismiss();
    await setAids({ colorVision: 'deuteranopia' }); await sleep(400);
    const gr = await probe();
    check(`${mode} base, gradient scheme + deuteranopia: the rail is the palette's rail (no gradient image), the active item the palette's button colour`, gr.railBg === gr.tokens.rail && gr.railImage === 'none' && gr.tokens.railActive === gr.tokens.buttonBg, JSON.stringify([gr.railBg, gr.tokens.rail, gr.railImage, gr.tokens.railActive, gr.tokens.buttonBg]));
    await setAids({ colorVision: 'none', highlightLinks: false });
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`  screenshots: ${OUT}`);
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
