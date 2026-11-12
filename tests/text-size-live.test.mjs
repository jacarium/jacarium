#!/usr/bin/env node
/**
 * Text size (Settings > Accessibility) live, at 150 % and 200 % (Playwright
 * against the Vite dev server, no backend): on the Documents page the
 * Preview's text, the editor's text, its gutter and its code-block line
 * grow by the factor (the code in its mono font), the reading ruler's band
 * still snaps to the taller lines; on AI Chat a message's markdown grows
 * from its own base; a task description (.ra-reading) grows; the chrome
 * (a tab label, the settings' hints) keeps its size until "Scale the
 * interface too" is on, when the root rem grows and the reading text is not
 * scaled twice; on every main page nothing overflows or clips at 200 % with
 * the interface scaled. Shortcuts step the stops. Screenshots at 150 % and
 * 200 % go to READING_AIDS_SHOTS_DIR/text-size.
 *
 * Needs playwright-core with Chromium. Port TEXT_SIZE_TEST_PORT (5221).
 * Run: node tests/text-size-live.test.mjs
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
const PORT = Number(process.env.TEXT_SIZE_TEST_PORT || 5221);
const OUT = path.join(process.env.READING_AIDS_SHOTS_DIR || '/private/tmp/claude-501/shots/reading-aids', 'text-size');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (TEXT_SIZE_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const DOC = ['# Text size', '', 'A paragraph long enough to wrap onto several lines when the text grows, so the ruler has lines to snap to and the column has something to show at two hundred per cent.', '', '```bash', 'echo "hello"', '```', ''].join('\n');
const PAGES = ['Documents', 'Calendars', 'Robin', 'Kanban', 'Tasks', 'Workflow Builder', 'Diagnostics', 'JQL Search', 'Tools'];

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
const loadAids = () => page.evaluate(async () => { const m = await import('/src/utils/readingAids.js'); return m.loadReadingAids(); });
const goTo = async (label) => {
  const b = page.locator(`nav.w-16 button[aria-label="${label}"]`);
  if (await b.count()) { await b.first().click(); await page.mouse.move(700, 450); await sleep(700); return true; }
  // a page that did not fit in the rail (a scaled interface) sits in its "..." menu; a page reachable from neither is a failure, not a skip
  const more = page.locator('[data-testid="rail-more"]');
  if (!(await more.count())) return false;
  await more.click(); await sleep(200);
  const item = page.locator('[data-testid="rail-more-menu"] button', { hasText: label }).first();
  if (!(await item.count())) { await page.keyboard.press('Escape'); return false; }
  await item.click(); await page.mouse.move(700, 450); await sleep(700); return true;
};
const openSettings = async (tab) => { if (!(await page.locator('[data-testid="settings-modal"]').count())) { await page.locator('[data-testid="sidebar-brand-mark"]').click(); await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 }); } await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: tab }).click(); await sleep(250); };
const closeSettings = async () => { if (await page.locator('[data-testid="settings-modal"]').count()) { await page.keyboard.press('Escape'); await sleep(300); } };
const SURF = '[data-testid="reading-aids-surface"]';
const isPreview = () => page.evaluate((s) => !!document.querySelector(`${s} .markdown-preview`), SURF);
const toPreview = async () => { for (let i = 0; i < 3 && !(await isPreview()); i++) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await sleep(400); } await page.locator(`${SURF} .markdown-preview p`).first().waitFor({ timeout: 15000 }); await sleep(200); };
const toEditor = async () => { for (let i = 0; i < 3 && (await isPreview()); i++) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await sleep(400); } await page.locator(`${SURF} .sc-editor-cm .cm-content`).waitFor({ timeout: 15000 }); await sleep(200); };
const px = (v) => parseFloat(v);
const probe = () => page.evaluate((s) => {
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  const surf = document.querySelector(s);
  const p = surf && surf.querySelector('.markdown-preview p');
  const code = surf && surf.querySelector('.markdown-preview pre code');
  const ed = surf && surf.querySelector('.sc-editor-cm.cm-editor');
  const gutter = surf && surf.querySelector('.sc-editor-cm .cm-gutters');
  const block = surf && surf.querySelector('.sc-editor-cm .cm-line.cm-code-block');
  const line = surf && surf.querySelector('.sc-editor-cm .cm-line');
  const tab = document.querySelector('[data-testid="document-tab"]');
  const html = document.documentElement;
  const band = document.querySelector('[data-testid="reading-ruler-band"]');
  return {
    pSize: cs(p, 'fontSize'), pLine: cs(p, 'lineHeight'), codeSize: cs(code, 'fontSize'), codeFont: cs(code, 'fontFamily'),
    edSize: cs(ed, 'fontSize'), gutterSize: cs(gutter, 'fontSize'), blockSize: cs(block, 'fontSize'), blockFont: cs(block, 'fontFamily'), lineHeight: line ? line.getBoundingClientRect().height : null,
    tabSize: cs(tab, 'fontSize'), rootSize: cs(html, 'fontSize'), htmlClasses: html.className, scale: html.style.getPropertyValue('--ra-text-scale'),
    band: band && !band.closest('[hidden]') ? band.getBoundingClientRect().height : null,
  };
}, SURF);
const survey = () => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const visible = (el) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05; };
  const overflow = []; const clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[data-testid="reading-ruler"], script, style') || !visible(el)) continue;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (r.right > vw + 1 && r.left < vw && cs.position !== 'fixed' && !el.closest('[class*="overflow-x-auto"], [class*="overflow-auto"], [class*="overflow-hidden"], [class*="overflow-x-hidden"]')) overflow.push(`${el.tagName.toLowerCase()}.${String(el.className).toString().slice(0, 30)} right=${Math.round(r.right)}`);
    if (el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible' && !el.querySelector('.truncate') && !el.closest('[title]')) clipped.push(`${el.textContent.trim().slice(0, 30)} ${el.scrollWidth}>${el.clientWidth}`);
  }
  return { vw, scrollWidth: document.documentElement.scrollWidth, overflow: overflow.slice(0, 10), clipped: clipped.slice(0, 10) };
});
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const near = (a, b, tol) => Math.abs(a - b) <= tol;

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  check('New Document', await clickButton('New Document'));
  await page.locator('.sc-editor-cm .cm-content').waitFor({ timeout: 15000 }); await sleep(500);
  await page.locator('.sc-editor-cm .cm-content').click();
  await page.keyboard.insertText(DOC); await sleep(600);
  const baseEd = await probe();
  await toPreview();
  const base = await probe();
  check('today: the Preview at 16 px, its code at 85 % (13.6 px), the editor at 14 px with a 12 px gutter, the tab label at its size, no scale on <html>', base.pSize === '16px' && base.codeSize === '13.6px' && baseEd.edSize === '14px' && baseEd.gutterSize === '12px' && base.scale === '' && base.rootSize === '16px', JSON.stringify([base, baseEd]));
  const tabBase = px(base.tabSize);

  for (const scale of [150, 200]) {
    const f = scale / 100;
    await goTo('Documents'); await toPreview();
    await setAids({ textScale: scale, ruler: true }); await sleep(400);
    let c = await probe();
    check(`${scale} %: the Preview's text is ${16 * f} px and its code ${13.6 * f} px in the mono font; the tab label and the root rem are unchanged (only the reading text grows)`, near(px(c.pSize), 16 * f, 0.5) && near(px(c.codeSize), 13.6 * f, 0.6) && /Red Hat Mono/.test(c.codeFont) && px(c.tabSize) === tabBase && c.rootSize === '16px' && c.scale === String(f), JSON.stringify(c));
    // the ruler snaps to the taller lines: the band is one (scaled) line tall
    const pBox = await page.locator(`${SURF} .markdown-preview p`).first().boundingBox();
    await page.mouse.move(pBox.x + 40, pBox.y + 16 * f * 1.7 * 0.5); await sleep(150);
    c = await probe();
    check(`${scale} %: the ruler's band is one scaled line tall (${(27.2 * f).toFixed(1)} px)`, c.band !== null && near(c.band, 27.2 * f, 1.5), JSON.stringify(c.band));
    await shot(`documents-preview-${scale}`);
    await toEditor();
    c = await probe();
    check(`${scale} %: the editor's text is ${14 * f} px, its gutter ${12 * f} px, its code-block line proportional (0.92 em) in the mono font`, near(px(c.edSize), 14 * f, 0.3) && near(px(c.gutterSize), 12 * f, 0.3) && near(px(c.blockSize), 14 * f * 0.92, 0.4) && /Red Hat Mono/.test(c.blockFont), JSON.stringify(c));
    await page.locator(`${SURF} .sc-editor-cm .cm-line`).first().click(); await sleep(200);
    c = await probe();
    const caretLine = await page.evaluate(() => { const sel = window.getSelection(); if (!sel || !sel.rangeCount) return null; const n = sel.getRangeAt(0).startContainer; const el = (n.nodeType === 1 ? n : n.parentElement).closest('.cm-line'); return el ? el.getBoundingClientRect().height : null; });
    check(`${scale} %: in the editor the band follows the caret, as tall as the caret's own line (${caretLine} px at this size)`, c.band !== null && caretLine && near(c.band, caretLine, 1.5), JSON.stringify([c.band, caretLine, c.lineHeight]));
    await shot(`documents-editor-${scale}`);
    await toPreview();
    // AI Chat: a message's markdown grows from its own base
    await goTo('Robin');
    const chat = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); const base = cs.getPropertyValue('--sc-chat-font').trim(); const m = document.querySelector('.sc-chat-markdown'); return { base, size: m ? getComputedStyle(m).fontSize : null }; });
    check(`${scale} %: AI Chat - the chat markdown base is ${chat.base}${chat.size ? `, a message's text ${chat.size}` : ' (no message to measure without a backend)'}`, chat.base === '0.875rem' && (!chat.size || near(px(chat.size), 14 * f, 0.5)), JSON.stringify(chat));
    await shot(`ai-chat-${scale}`);
    await goTo('Tasks'); await shot(`tasks-${scale}`);
    await goTo('Diagnostics'); await shot(`diagnostics-${scale}`);
    // the interface too: the root rem grows, the Preview is not scaled twice
    await setAids({ scaleChrome: true }); await sleep(400);
    await goTo('Documents'); await toPreview();
    c = await probe();
    check(`${scale} %, interface too: the root rem is ${16 * f} px, the tab label scaled, the Preview still ${16 * f} px (not twice), the editor's size from the rem`, near(px(c.rootSize), 16 * f, 0.5) && near(px(c.tabSize), tabBase * f, 0.6) && near(px(c.pSize), 16 * f, 0.5) && c.htmlClasses.includes('ra-scale-chrome'), JSON.stringify(c));
    for (const label of PAGES) {
      const reached = await goTo(label);
      check(`${scale} %, interface too, ${label}: the page is reachable from the rail or its ... menu`, reached);
      if (!reached) continue;
      const s = await survey();
      check(`${scale} %, interface too, ${label}: nothing overflows - no horizontal page scroll, no visible element past the right edge, no clipped button`, s.scrollWidth <= s.vw + 1 && s.overflow.length === 0 && s.clipped.length === 0, JSON.stringify(s));
    }
    await openSettings('Accessibility');
    const settings = await survey();
    check(`${scale} %, interface too, Settings: nothing overflows or clips`, settings.scrollWidth <= settings.vw + 1 && settings.overflow.length === 0 && settings.clipped.length === 0, JSON.stringify(settings));
    if (scale === 200) await shot('settings-200-interface');
    await closeSettings();
    await setAids({ scaleChrome: false, ruler: false });
  }
  // the slider: arrows move 5 %, a typed value, End / Home to the ends; each applies to the open document
  await goTo('Documents'); await toPreview();
  await setAids({ textScale: 100, scaleChrome: false, ruler: false });
  await openSettings('Accessibility');
  const sliderL = page.locator('[data-testid="ra-text-scale"]');
  await sliderL.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await sleep(600);
  const at115 = { stored: (await loadAids()).textScale, text: await sliderL.getAttribute('aria-valuetext'), html: await page.evaluate(() => document.documentElement.style.getPropertyValue('--ra-text-scale')) };
  await sliderL.fill('185'); await sleep(600);
  const at185 = { stored: (await loadAids()).textScale, text: await sliderL.getAttribute('aria-valuetext') };
  await page.keyboard.press('End'); await sleep(600);
  const atEnd = (await loadAids()).textScale;
  await page.keyboard.press('Home'); await sleep(600);
  const atHome = (await loadAids()).textScale;
  check('the slider: three ArrowRights from 100 give 115 % (stored, "115 %", --ra-text-scale 1.15), a typed 185 gives 185 %, End 200, Home 90', at115.stored === 115 && at115.text === '115 %' && at115.html === '1.15' && at185.stored === 185 && at185.text === '185 %' && atEnd === 200 && atHome === 90, JSON.stringify([at115, at185, atEnd, atHome]));
  await sliderL.fill('115'); await sleep(600);
  await closeSettings();
  let cs = await probe();
  check('115 %: the open document\'s Preview is 18.4 px', near(px(cs.pSize), 18.4, 0.3), cs.pSize);
  await openSettings('Accessibility'); await sliderL.fill('185'); await sleep(600); await closeSettings();
  cs = await probe();
  check('185 %: the open document\'s Preview is 29.6 px', near(px(cs.pSize), 29.6, 0.3), cs.pSize);
  await shot('documents-preview-185');
  // the shortcuts step 5 % (bound here to test them: Alt+Shift+Period / Comma / Digit0)
  await page.evaluate(async () => { const st = await import('/src/shortcuts/store.js'); const save = st.saveOverrides || st.setOverrides || st.writeOverrides; if (save) save({ 'reading.textLarger': 'Alt+Shift+Period', 'reading.textSmaller': 'Alt+Shift+Comma', 'reading.textReset': 'Alt+Shift+Digit0' }); });
  await sleep(300);
  await setAids({ textScale: 100 });
  await page.keyboard.press('Alt+Shift+Period'); await sleep(200);
  const up = (await loadAids()).textScale;
  await page.keyboard.press('Alt+Shift+Comma'); await page.keyboard.press('Alt+Shift+Comma'); await sleep(200);
  const down = (await loadAids()).textScale;
  await page.keyboard.press('Alt+Shift+Digit0'); await sleep(200);
  const reset = (await loadAids()).textScale;
  check('the shortcuts: increase goes 100 -> 105, decrease twice 105 -> 95, reset back to 100 (bound for the test; unassigned by default)', up === 105 && down === 95 && reset === 100, JSON.stringify([up, down, reset]));
  await page.evaluate(async () => { const st = await import('/src/shortcuts/store.js'); const save = st.saveOverrides || st.setOverrides || st.writeOverrides; if (save) save({}); });
  await page.evaluate(async () => { const m = await import('/src/utils/readingAids.js'); m.resetReadingAids(); });
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`  screenshots: ${OUT}`);
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
