#!/usr/bin/env node
/**
 * The reading aids live on the Documents page (Playwright against the Vite
 * dev server, no backend): Settings > Accessibility changes the computed
 * style of the editor and of its Preview (and, for the app-wide options, of
 * the chrome around them); the document itself is unchanged (its stored
 * text, and a preview rendered the way the export renders keeps today's
 * values); the reading ruler is one band that follows the pointer, snaps to
 * text lines, is 1 / 3 / 5 lines tall, masks, moves with the arrows when
 * the Preview has focus and follows the caret in the editor, and never
 * overlaps the first glyph; with the ruler off the editor marks no line;
 * zen mode hides the rail, the sidebar and the tabs and ends on Esc and on
 * its shortcut; hidden images leave a placeholder whose button brings the
 * image back; high contrast recolours the window; the reading fonts load
 * when chosen. Screenshots go to READING_AIDS_SHOTS_DIR
 * (/private/tmp/claude-501/shots/reading-aids).
 *
 * Needs playwright-core with Chromium. Port READING_AIDS_TEST_PORT (5213).
 * Run: node tests/reading-aids-live.test.mjs
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
const PORT = Number(process.env.READING_AIDS_TEST_PORT || 5213);
const OUT = process.env.READING_AIDS_SHOTS_DIR || '/private/tmp/claude-501/shots/reading-aids';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (READING_AIDS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const DOC = ['# Reading aids', '', 'A first paragraph with a [link](https://example.test/page) and `inline code` in it, long enough to wrap when the pane is narrow or the column is set, and then some more words so that it wraps onto a third line at the usual width of the pane.', '', 'A second paragraph, so the ruler has a neighbour to mask.', '', '![A diagram](https://example.test/a.png)', '', '```bash', 'echo "hello"', '```', ''].join('\n');

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => {
  try {
    localStorage.setItem('whatsNewLastSeen', '99.0.0');
    if (!localStorage.getItem('app-theme')) localStorage.setItem('app-theme', 'dark');
  } catch { /* storage */ }
});
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
await context.route('**/api/version', (r) => r.fulfill({ json: { app: '4.3.1', protocol: 2 } }));
await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
await context.route('**/socket.io/**', (r) => r.abort());
await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
await context.route('https://example.test/**', (r) => (r.request().url().endsWith('.png') ? r.fulfill({ status: 200, contentType: 'image/png', body: PNG }) : r.fulfill({ status: 200, contentType: 'text/html', body: '<p>page</p>' })));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }).catch(() => {}); };
const clickButton = (label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
const openSettings = async (tab) => {
  if (!(await page.locator('[data-testid="settings-modal"]').count())) { await page.locator('[data-testid="sidebar-brand-mark"]').click(); await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 }); }
  await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: tab }).click(); await sleep(200);
};
const closeSettings = async () => { if (await page.locator('[data-testid="settings-modal"]').count()) { await page.keyboard.press('Escape'); await sleep(300); } };
const toggle = async (testId) => { await page.locator(`[data-testid="${testId}"]`).click(); await sleep(150); };
const choose = async (testId, value) => { await page.locator(`[data-testid="${testId}"]`).selectOption(value); await sleep(150); };
const segment = async (testId, label) => { await page.locator(`[data-testid="${testId}"] button`, { hasText: label }).click(); await sleep(150); };
const SURF = '[data-testid="reading-aids-surface"]';
const isPreview = () => page.evaluate((s) => !!document.querySelector(`${s} .markdown-preview`), SURF);
const toPreview = async () => { for (let i = 0; i < 3 && !(await isPreview()); i++) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await sleep(400); } await page.locator(`${SURF} .markdown-preview p`).first().waitFor({ timeout: 15000 }); await sleep(200); };
const toEditor = async () => { for (let i = 0; i < 3 && (await isPreview()); i++) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await sleep(400); } await page.locator(`${SURF} .sc-editor-cm .cm-content`).waitFor({ timeout: 15000 }); await sleep(200); };
const probe = () => page.evaluate((s) => {
  const cs = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
  const surf = document.querySelector(s);
  const p = surf && surf.querySelector('.markdown-preview p');
  const pv = surf && surf.querySelector('.markdown-preview');
  const sc = surf && surf.querySelector('.sc-editor-cm .cm-scroller');
  const cc = surf && surf.querySelector('.sc-editor-cm .cm-content');
  const html = document.documentElement;
  const tab = document.querySelector('[data-testid="document-tab"]');
  const rail = document.querySelector('nav.w-16');
  return {
    pLine: cs(p, 'lineHeight'), pLetter: cs(p, 'letterSpacing'), pWord: cs(p, 'wordSpacing'), pMargin: cs(p, 'marginBottom'), pAlign: cs(p, 'textAlign'), pFont: cs(p, 'fontFamily'), pColor: cs(p, 'color'),
    pvPadLeft: cs(pv, 'paddingLeft'), pvBg: cs(pv, 'backgroundColor'), link: cs(pv && pv.querySelector('a'), 'color'), linkDeco: cs(pv && pv.querySelector('a'), 'textDecorationLine'), linkBg: cs(pv && pv.querySelector('a'), 'backgroundColor'),
    codeFont: cs(pv && pv.querySelector('pre code'), 'fontFamily'), codeLetter: cs(pv && pv.querySelector('pre code'), 'letterSpacing'),
    scLine: cs(sc, 'lineHeight'), scLetter: cs(sc, 'letterSpacing'), scFont: cs(sc, 'fontFamily'), ccPadLeft: cs(cc, 'paddingLeft'), ccAlign: cs(cc, 'textAlign'),
    codeBlockFont: cs(cc && cc.querySelector('.cm-line.cm-code-block'), 'fontFamily'), codeBlockLetter: cs(cc && cc.querySelector('.cm-line.cm-code-block'), 'letterSpacing'),
    markedLines: cc ? cc.querySelectorAll('.cm-activeLine, [class*="ruler"]').length : null, firstLineBg: cs(cc && cc.querySelector('.cm-line'), 'backgroundColor'), firstLineBgImage: cs(cc && cc.querySelector('.cm-line'), 'backgroundImage'),
    editorBg: cs(surf && surf.querySelector('.sc-editor-cm.cm-editor'), 'backgroundColor'), editorColor: cs(surf && surf.querySelector('.sc-editor-cm.cm-editor'), 'color'),
    htmlFilter: cs(html, 'filter'), htmlClasses: html.className, htmlStyle: html.getAttribute('style') || '',
    tabFont: cs(tab, 'fontFamily'), tabLetter: cs(tab, 'letterSpacing'), tabColor: cs(tab, 'color'), railBg: cs(rail, 'backgroundColor'), bodyBg: cs(document.body, 'backgroundColor'),
    surfaceClasses: surf ? surf.className : null, rail: !!rail && getComputedStyle(rail).display !== 'none', tabs: document.querySelectorAll('[data-testid="document-tab"]').length, zen: html.classList.contains('zen-mode'), hint: !!document.querySelector('[data-testid="zen-badge"]') && !document.querySelector('[data-testid="zen-hint"]'),   /* the Zen label in the status corner (no footer bar) */
    sidebar: !!document.querySelector('[data-testid="document-sidebar"]'), dialog: !!document.querySelector('[data-testid="settings-modal"]'),
    ruler: (() => { const c = document.querySelector('[data-testid="reading-ruler"]'); if (!c) return { mounted: false }; const b = c.querySelector('[data-testid="reading-ruler-band"]'); const r = b.getBoundingClientRect(); const cr = c.getBoundingClientRect(); const bs = getComputedStyle(b); return { mounted: true, hidden: c.hidden, mode: c.getAttribute('data-mode'), lines: c.getAttribute('data-lines'), top: r.top, height: r.height, left: r.left, width: r.width, clipLeft: cr.left, clipTop: cr.top, clipRight: cr.right, clipBottom: cr.bottom, boxShadow: bs.boxShadow, bg: bs.backgroundColor, border: bs.borderLeftWidth }; })(),
  };
}, SURF);
// the line box of the text at a point (what the band should cover)
const lineAt = (sel, x, y) => page.evaluate(([sel, x, y]) => { const r = document.caretRangeFromPoint(x, y); if (!r || r.startContainer.nodeType !== 3) return null; const rect = r.getClientRects()[0] || r.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(r.startContainer.parentElement).lineHeight); const el = document.querySelector(sel); return { top: rect.top, height: rect.height, lineHeight: lh, elLeft: el.getBoundingClientRect().left, text: r.startContainer.textContent.slice(0, 20) }; }, [sel, x, y]);
const firstGlyph = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = walker.nextNode())) { if (n.textContent.trim()) { const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 1); const b = r.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right }; } } return null; }, sel);
const exportProbe = () => page.evaluate(async (text) => {
  const { processInteractiveMarkdown } = await import('/src/utils/interactiveMarkdown.js');
  const c = document.createElement('div'); c.className = 'markdown-preview pdf-export-root'; c.style.cssText = 'position: fixed; left: -10000px; top: 0; width: 700px;';
  c.innerHTML = processInteractiveMarkdown(text); document.body.appendChild(c);
  const p = c.querySelector('p'); const cs = getComputedStyle(p);
  const out = { textAlign: cs.textAlign, paddingLeft: getComputedStyle(c).paddingLeft, images: c.querySelectorAll('img').length, placeholders: c.querySelectorAll('.ra-image-placeholder').length, html: c.innerHTML };
  c.remove(); return out;
}, DOC);
const storedDoc = () => page.evaluate(async () => { const { db } = await import('/src/db/database.js'); const docs = await db.documents.toArray(); return docs.length ? docs[docs.length - 1].content : null; });
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  check('New Document', await clickButton('New Document'));
  await page.locator('.sc-editor-cm .cm-content').waitFor({ timeout: 15000 }); await sleep(500);
  await page.locator('.sc-editor-cm .cm-content').click();
  await page.keyboard.insertText(DOC); await sleep(800);
  await page.keyboard.press('ArrowUp'); await sleep(200);
  const base = await probe();
  const exportBase = await exportProbe();
  check('today\'s editor: a reading-aids surface with the surface class alone; <html> carries ra-app and - this context\'s OS asks for less motion (Follow system) - ra-reduce-motion, nothing else; line-height 1.6 (of 14 px), 24 px padding, the mono font', /^ra-surface\b/.test(base.surfaceClasses) && !/ra-ruler|ra-high-contrast|ra-links/.test(base.surfaceClasses) && base.htmlClasses.split(/\s+/).filter((c) => c.startsWith('ra-')).join() === 'ra-app,ra-reduce-motion'&& base.htmlStyle === '' && base.scLine === '22.4px' && base.ccPadLeft === '24px' && /Red Hat Mono/.test(base.scFont), JSON.stringify(base));
  check('with the ruler off (the default) the editor marks no line: no cm-activeLine or ruler class on any line, the caret\'s line transparent, no band in the DOM', base.markedLines === 0 && base.firstLineBg === 'rgba(0, 0, 0, 0)' && base.firstLineBgImage === 'none' && base.ruler.mounted === false, JSON.stringify([base.markedLines, base.firstLineBg, base.ruler]));
  await toPreview();
  const basePv = await probe();
  check('the Preview today: line height 1.7 (27.2 px), 16 px after a paragraph, 24 px padding, left, the reading font, code in the mono font', basePv.pLine === '27.2px' && basePv.pMargin === '16px' && basePv.pvPadLeft === '24px' && basePv.pAlign === 'start' && /Red Hat Text/.test(basePv.pFont) && /Red Hat Mono/.test(basePv.codeFont), JSON.stringify(basePv));
  await shot('dark-default-preview');

  // ---- reading text everywhere: the font and spacing reach the chrome too; code stays mono; the column is documents-only
  await openSettings('Accessibility');
  check('the Accessibility page: two groups (the column, the alignment and zen in the reading group; no Documents-only group), the sample surface, Reset disabled at the defaults', (await page.locator('[data-testid="ra-group-app"]').count()) === 1 && (await page.locator('[data-testid="ra-group-reading"]').count()) === 1 && (await page.locator('[data-testid="ra-group-documents"]').count()) === 0 && (await page.locator('[data-testid="ra-group-reading"] #ra-line-width').count()) === 1 && (await page.locator('[data-testid="ra-sample"]').count()) === 1 && (await page.locator('[data-testid="ra-reset"]').isDisabled()));
  await choose('ra-line-height', '2');
  await choose('ra-paragraph-spacing', '2');
  await choose('ra-line-width', '60');
  await choose('ra-font', 'opendyslexic');
  await page.locator('[data-testid="ra-letter-spacing"]').focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');   // 0.05 em
  await page.locator('[data-testid="ra-word-spacing"]').focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');   // 0.2 em
  await segment('ra-text-align', /^Justified$/);
  await closeSettings();
  const fontLoaded = await page.evaluate(async () => { await document.fonts.ready; return Array.from(document.fonts).some((f) => /OpenDyslexic/i.test(f.family) && f.status === 'loaded'); });
  let c = await probe();
  check('the Preview follows at once: line height 2 (32 px), 2 em after a paragraph (32 px), 0.05 em letters (0.8 px), 0.2 em words, OpenDyslexic (loaded, bundled), justified, a 60 ch column', c.pLine === '32px' && c.pMargin === '32px' && c.pLetter === '0.8px' && c.pWord === '3.2px' && /OpenDyslexic/.test(c.pFont) && fontLoaded && c.pAlign === 'justify' && parseFloat(c.pvPadLeft) > 100, JSON.stringify(c));
  check('...the reading font and the letter spacing reach the chrome (the tab label), the code block keeps the mono font with no letter spacing', /OpenDyslexic/.test(c.tabFont) && parseFloat(c.tabLetter) > 0.5 && /Red Hat Mono/.test(c.codeFont) && /^(0px|normal)$/.test(c.codeLetter), JSON.stringify([c.tabFont, c.tabLetter, c.codeFont, c.codeLetter]));
  check('the stored document is the typed text, unchanged', (await storedDoc()) === DOC);
  const exportNow = await exportProbe();
  check('a preview rendered the export\'s way keeps the column off, left alignment and the same markup (the app-wide font is the reader\'s screen, not the document)', exportNow.textAlign === 'start' && exportNow.paddingLeft === exportBase.paddingLeft && exportNow.html === exportBase.html, JSON.stringify(exportNow).slice(0, 300));
  await shot('dark-opendyslexic-wide-spacing-preview');
  await toEditor();
  c = await probe();
  check('the editor follows too: line height 2 (28 px of 14 px), 0.7 px letters, OpenDyslexic, justified, the column\'s padding; its code-block line keeps the mono font and no letter spacing', c.scLine === '28px' && c.scLetter === '0.7px' && /OpenDyslexic/.test(c.scFont) && c.ccAlign === 'justify' && parseFloat(c.ccPadLeft) > 100 && /Red Hat Mono/.test(c.codeBlockFont) && /^(0px|normal)$/.test(c.codeBlockLetter), JSON.stringify(c));
  await shot('dark-opendyslexic-wide-spacing-editor');

  // ---- the ruler: a band that follows the pointer, snaps to lines, 1 / 3 / 5 lines, mask, the arrows, the caret
  await openSettings('Accessibility');
  await toggle('ra-ruler'); await toggle('ra-links');
  await segment('ra-text-align', /^Left$/);
  // the sample is a reading area: the band shows there under the pointer
  await page.locator('[data-testid="ra-sample-preview"]').scrollIntoViewIfNeeded(); await sleep(150);
  const sampleP = await page.locator('[data-testid="ra-sample-preview"] p').first().boundingBox();
  await page.mouse.move(sampleP.x + 40, sampleP.y + 10); await sleep(120);
  c = await probe();
  check('the ruler works in the settings\' sample: the band shows under the pointer, inside the sample', c.ruler.mounted && !c.ruler.hidden && c.ruler.top >= sampleP.y - 2 && c.ruler.top + c.ruler.height <= sampleP.y + sampleP.height + 2, JSON.stringify([c.ruler, sampleP]));
  await closeSettings();
  await toPreview();
  const pBox = await page.locator(`${SURF} .markdown-preview p`).first().boundingBox();
  const x = pBox.x + 60; const y1 = pBox.y + 16; // the first line
  await page.mouse.move(x, y1); await sleep(120);
  c = await probe();
  let line = await lineAt(`${SURF} .markdown-preview`, x, y1);
  const glyph = await firstGlyph(`${SURF} .markdown-preview p`);
  check('highlight: one band, line-height tall (32 px), over the first text line under the pointer, full width of the Preview\'s visible box, tinted, no edge (no box-shadow, no border)', !c.ruler.hidden && c.ruler.mode === 'highlight' && c.ruler.lines === '1' && near(c.ruler.height, 32, 1) && near(c.ruler.top, line.top + line.height / 2 - 16, 2) && near(c.ruler.left, c.ruler.clipLeft) && c.ruler.width >= 600 && c.ruler.boxShadow === 'none' && c.ruler.border === '0px' && c.ruler.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify([c.ruler, line]));
  check('...nothing is drawn over the first glyph: the band has no edge, it is a flat tint the text sits on', c.ruler.boxShadow === 'none' && glyph.left >= c.ruler.left, JSON.stringify([glyph, c.ruler.left]));
  const y2 = y1 + 32;   // the second line of the same paragraph
  await page.mouse.move(x, y2); await sleep(120);
  const c2 = await probe();
  check('...it follows the pointer to the next line and snaps to it (one line height down, same height)', near(c2.ruler.top, c.ruler.top + 32, 2) && near(c2.ruler.height, 32, 1), JSON.stringify([c.ruler.top, c2.ruler.top]));
  await page.mouse.move(x, y1 + 8); await sleep(120);
  const c3 = await probe();
  check('...a pointer anywhere within a line gives the same band (snapped, not centred on the pointer)', near(c3.ruler.top, c.ruler.top, 2), JSON.stringify([c.ruler.top, c3.ruler.top]));
  await shot('dark-ruler-highlight-preview');
  // the toolbar above the Preview: the band follows everywhere - it snaps to the toolbar row
  const toolbar = await page.locator('[data-testid="editor-mode-toggle"]').boundingBox();
  await page.mouse.move(toolbar.x, toolbar.y + 4); await sleep(120);
  c = await probe();
  check('...over the toolbar the band snaps to the toolbar row (the band follows everywhere)', c.ruler.hidden === false && c.ruler.top <= toolbar.y + 4 && c.ruler.top + c.ruler.height >= toolbar.y + 4 && c.ruler.height < 80, JSON.stringify([toolbar, c.ruler]));
  // the keyboard: focus the Preview, ArrowDown moves the band one line
  await page.mouse.move(x, y1); await sleep(120);
  await page.evaluate((s) => document.querySelector(`${s} .markdown-preview`).focus(), SURF);
  const before = (await probe()).ruler.top;
  await page.keyboard.press('ArrowDown'); await sleep(150);
  const after = (await probe()).ruler.top;
  await page.keyboard.press('ArrowUp'); await sleep(150);
  const backUp = (await probe()).ruler.top;
  check('with the Preview focused, ArrowDown moves the band one line down and ArrowUp one line up', near(after, before + 32, 3) && near(backUp, before, 3), JSON.stringify([before, after, backUp]));
  // 3 and 5 lines, mask
  await openSettings('Accessibility');
  await segment('ra-ruler-lines', /^3 lines$/);
  await closeSettings();
  await page.mouse.move(x, y1 + 32); await sleep(150);
  c = await probe();
  check('3 lines: the band is three lines tall, centred on the line under the pointer', c.ruler.lines === '3' && near(c.ruler.height, 96, 2) && near(c.ruler.top + 48, (await lineAt(`${SURF} .markdown-preview`, x, y1 + 32)).top + 8 + 8, 6), JSON.stringify(c.ruler));
  await openSettings('Accessibility');
  await segment('ra-ruler-lines', /^5 lines$/);
  await segment('ra-ruler-mode', /^Mask$/);
  await closeSettings();
  await page.mouse.move(x, y1 + 32); await sleep(150);
  c = await probe();
  // the mask: a pointer-transparent shade over the whole window (the mask colour) with a hole the band's size
  const maskColor = await page.evaluate(() => { const s = document.querySelector('[data-testid="reading-ruler-shade"]'); return s && !s.hidden ? getComputedStyle(s).backgroundColor : 'none'; });
  check('5 lines + Mask: the band is five lines tall and transparent, the window dimmed by the shade (the mask colour) but the band, the clip no wider than the Preview', c.ruler.mode === 'mask' && c.ruler.lines === '5' && near(c.ruler.height, 160, 2) && c.ruler.bg === 'rgba(0, 0, 0, 0)' && /rgba?\(|color\(/.test(maskColor) && maskColor !== 'none' && c.ruler.clipLeft <= pBox.x && c.ruler.clipRight >= pBox.x + pBox.width && c.ruler.clipRight <= 1360, JSON.stringify([c.ruler, maskColor]));
  await shot('dark-ruler-mask-preview');
  check('highlighted links: the Preview\'s link is underlined on a tint', c.linkDeco === 'underline' && c.linkBg !== 'rgba(0, 0, 0, 0)' && c.htmlClasses.includes('ra-links'), JSON.stringify([c.linkDeco, c.linkBg]));
  // the editor: the caret
  await openSettings('Accessibility');
  await segment('ra-ruler-lines', /^1 line$/);
  await segment('ra-ruler-mode', /^Highlight$/);
  await closeSettings();
  await toEditor();
  const l3 = await page.locator(`${SURF} .sc-editor-cm .cm-line`).nth(2).boundingBox();
  await page.mouse.click(l3.x + 20, l3.y + 10); await sleep(200);
  await page.evaluate(() => { document.dispatchEvent(new PointerEvent('pointermove', { clientX: -10, clientY: -10, bubbles: true, pointerType: 'mouse' })); }); await sleep(150);   // the pointer off the window: the band stays with the caret
  c = await probe();
  const caretRect = await page.evaluate(() => { const r = window.getSelection().getRangeAt(0).getClientRects()[0] || window.getSelection().getRangeAt(0).getBoundingClientRect(); return { top: r.top, height: r.height }; });
  check('the editor: the band sits on the caret\'s line (the line the click landed on), 28 px tall, with no line class added', !c.ruler.hidden && near(c.ruler.height, 28, 2) && c.ruler.top <= caretRect.top + 1 && c.ruler.top + c.ruler.height >= caretRect.top + caretRect.height - 1 && c.markedLines === 0, JSON.stringify([c.ruler, caretRect]));
  const caretTop = c.ruler.top;
  await page.keyboard.press('ArrowDown'); await sleep(200);
  c = await probe();
  check('...and follows the caret with the keyboard (ArrowDown: the band moves down)', c.ruler.top > caretTop + 10, JSON.stringify([caretTop, c.ruler.top]));
  await page.keyboard.type('x'); await sleep(200);
  check('...and while typing it stays on the caret\'s line', !(await probe()).ruler.hidden);
  await page.keyboard.press('Backspace'); await sleep(100);
  await shot('dark-ruler-editor');
  // off: the band is gone, the editor marks no line
  await openSettings('Accessibility');
  await toggle('ra-ruler');
  await closeSettings();
  c = await probe();
  check('ruler off: the overlay is unmounted at once, no line class, the caret\'s line transparent', c.ruler.mounted === false && c.markedLines === 0 && c.firstLineBg === 'rgba(0, 0, 0, 0)', JSON.stringify([c.ruler, c.markedLines]));

  // ---- hidden images (app-wide, one observer)
  await openSettings('Accessibility');
  await toggle('ra-hide-images');
  await closeSettings();
  await toPreview();
  await sleep(200);
  const hidden = await page.evaluate((s) => { const sf = document.querySelector(s); const box = sf.querySelector('[data-testid="ra-image-placeholder"]'); const img = sf.querySelector('.markdown-preview img'); return { box: !!box, text: box && box.querySelector('.ra-image-alt').textContent, imgHidden: img ? img.hidden : null }; }, SURF);
  check('hide images: the Preview shows a placeholder with the alt text, the image hidden', hidden.box && hidden.text === 'Image: A diagram' && hidden.imgHidden === true, JSON.stringify(hidden));
  await page.locator('[data-testid="ra-image-placeholder"] button').click(); await sleep(200);
  const shown = await page.evaluate((s) => { const sf = document.querySelector(s); return { boxes: sf.querySelectorAll('[data-testid="ra-image-placeholder"]').length, imgHidden: sf.querySelector('.markdown-preview img').hidden }; }, SURF);
  check('Show image brings it back and drops the placeholder', shown.boxes === 0 && shown.imgHidden === false, JSON.stringify(shown));
  const exportHidden = await exportProbe();
  check('the export\'s rendering still has its image and no placeholder', exportHidden.images === 1 && exportHidden.placeholders === 0 && exportHidden.html === exportBase.html);

  // ---- colour: high contrast, a palette, greyscale - the whole window
  await openSettings('Accessibility');
  await toggle('ra-high-contrast');
  await closeSettings();
  c = await probe();
  check('high contrast (dark): the Preview on black with white text and a light link; the rail and the tab label follow (the window, not the pane)', c.htmlClasses.includes('ra-high-contrast') && c.pvBg === 'rgb(0, 0, 0)' && c.pColor === 'rgb(255, 255, 255)' && c.link === 'rgb(138, 180, 255)' && c.railBg === 'rgb(0, 0, 0)' && c.tabColor === 'rgb(255, 255, 255)', JSON.stringify([c.pvBg, c.pColor, c.link, c.railBg, c.tabColor]));
  await shot('dark-high-contrast-preview');
  await toEditor();
  c = await probe();
  check('...the editor on black in white too', c.editorBg === 'rgb(0, 0, 0)' && c.editorColor === 'rgb(255, 255, 255)', JSON.stringify([c.editorBg, c.editorColor]));
  await shot('dark-high-contrast-editor');
  await openSettings('Accessibility');
  await toggle('ra-high-contrast');
  await choose('ra-color-vision', 'deuteranopia');
  await closeSettings();
  await toPreview();
  c = await probe();
  check('the deuteranopia palette: the link is the Okabe-Ito blue (dark variant), a class on <html>', c.link === 'rgb(39, 135, 190)' && c.htmlClasses.includes('ra-cv-deuteranopia'), JSON.stringify([c.link, c.htmlClasses]));
  await shot('dark-deuteranopia-preview');
  await openSettings('Accessibility');
  await choose('ra-color-vision', 'none');
  await toggle('ra-greyscale');
  await closeSettings();
  c = await probe();
  check('greyscale: a grayscale(1) filter on <html> (the whole window)', c.htmlFilter === 'grayscale(1)', c.htmlFilter);

  // ---- zen mode: the button, Esc, the shortcut
  await openSettings('Accessibility');
  await toggle('ra-greyscale');
  await toggle('ra-zen'); await sleep(200);
  c = await probe();
  check('zen from the settings: the mode is on while the dialog is open', c.zen && c.dialog, JSON.stringify([c.zen, c.dialog]));
  await page.keyboard.press('Escape'); await sleep(400);
  c = await probe();
  // zen follows Line width (Off here: the pane's width with the normal padding); the way out is the Zen label in the status corner
  check('...Esc closes the dialog first, zen stays: no rail, no document sidebar column, the tab bar still there, no footer bar - the Zen label in the status corner names the chords (zen\'s column follows Line width: the Dyslexia profile\'s 70 ch here)', !c.dialog && c.zen && !c.rail && !c.sidebar && c.tabs >= 1 && c.hint && parseFloat(c.pvPadLeft) >= 20 && /Esc or /.test(await page.locator('[data-testid="zen-badge"]').getAttribute('title')), JSON.stringify(c));
  await shot('dark-zen-preview');
  await page.locator(`${SURF} .markdown-preview`).click(); await sleep(100);
  await page.keyboard.press('Escape'); await sleep(400);
  c = await probe();
  check('Esc leaves zen: the rail, the sidebar and the tabs are back', !c.zen && c.rail && c.sidebar && c.tabs >= 1 && !c.hint, JSON.stringify(c));
  const isMac = await page.evaluate(() => /Mac/.test(navigator.platform));
  const chord = isMac ? 'Meta+Shift+E' : 'Control+Shift+E';
  await page.keyboard.press(chord); await sleep(400);
  c = await probe();
  check(`the shortcut (${chord}) enters zen`, c.zen && !c.rail && c.hint, JSON.stringify(c));
  await page.keyboard.press(chord); await sleep(400);
  c = await probe();
  check('...and leaves it', !c.zen && c.rail);
  await openSettings('Shortcuts');
  check('Settings > Shortcuts lists the Reading group with Zen mode bound and the ruler unassigned', (await page.locator('[data-testid="shortcuts-section-reading"]').count()) === 1 && /E$/.test((await page.locator('[data-testid="shortcut-chord-reading.zen"]').textContent()).trim()) && (await page.locator('[data-testid="shortcut-row-reading.ruler"]').count()) === 1);
  await closeSettings();

  // ---- a light theme: the ruler in both modes, high contrast on white
  await page.evaluate(() => localStorage.setItem('app-theme', 'light'));
  await page.reload({ waitUntil: 'load' }); await sleep(1500); await dismiss();
  if (!(await page.locator(SURF).count())) { const tab = page.locator('[data-testid="document-tab"]').first(); if (await tab.count()) await tab.click().catch(() => {}); }
  await page.locator(SURF).waitFor({ timeout: 15000 });
  c = await probe();
  check('after a reload in the light theme the settings hold (stored on this device): highlighted links and the font are still on, zen is not (a mode of the moment)', c.htmlClasses.includes('ra-links') && /OpenDyslexic/.test(c.htmlStyle) && !c.zen, c.htmlClasses + ' ' + c.htmlStyle);
  await toPreview();
  await openSettings('Accessibility');
  await toggle('ra-ruler');
  await closeSettings();
  const pBoxL = await page.locator(`${SURF} .markdown-preview p`).first().boundingBox();
  await page.mouse.move(pBoxL.x + 60, pBoxL.y + 16); await sleep(150);
  c = await probe();
  check('light: the highlight band shows under the pointer', !c.ruler.hidden && c.ruler.mode === 'highlight', JSON.stringify(c.ruler));
  await shot('light-ruler-highlight-preview');
  await openSettings('Accessibility');
  await segment('ra-ruler-mode', /^Mask$/);
  await segment('ra-ruler-lines', /^3 lines$/);
  await closeSettings();
  await page.mouse.move(pBoxL.x + 60, pBoxL.y + 16); await sleep(150);
  const textOnMask = await page.evaluate((s) => { const p = document.querySelectorAll(`${s} .markdown-preview p`)[1]; return getComputedStyle(p).color; }, SURF);
  check('light: the mask dims towards the page\'s own colour (the masked text keeps its colour; the veil is the surface at 55 %)', (await probe()).ruler.mode === 'mask' && textOnMask === 'rgb(36, 41, 47)');
  await shot('light-ruler-mask-preview');
  await openSettings('Accessibility');
  await toggle('ra-high-contrast');
  await closeSettings();
  await page.mouse.move(toolbar.x, toolbar.y + 4); await sleep(100);
  c = await probe();
  check('high contrast (light): black text on white, the link a strong blue, the rail white, the body white', c.pvBg === 'rgb(255, 255, 255)' && c.pColor === 'rgb(0, 0, 0)' && c.link === 'rgb(0, 0, 238)' && c.railBg === 'rgb(255, 255, 255)' && c.bodyBg === 'rgb(255, 255, 255)', JSON.stringify([c.pvBg, c.pColor, c.link, c.railBg, c.bodyBg]));
  await shot('light-high-contrast-preview');
  await openSettings('Accessibility');
  await page.locator('[data-testid="ra-reset"]').click(); await sleep(200);
  check('Reset to defaults disables itself and clears the storage', (await page.locator('[data-testid="ra-reset"]').isDisabled()) && (await page.evaluate(() => localStorage.getItem('documentsReadingAids'))) === null);
  await closeSettings();
  c = await probe();
  check('...the Preview is back to today\'s values, <html> to ra-app and ra-reduce-motion (the emulated OS asks) alone, no ruler in the DOM', c.pLine === '27.2px' && c.pMargin === '16px' && c.pvPadLeft === '24px' && /Red Hat Text/.test(c.pFont) && c.htmlClasses.split(/\s+/).filter((k) => k.startsWith('ra-')).join() === 'ra-app,ra-reduce-motion' && c.htmlStyle === '' && c.ruler.mounted === false && !/\bra-(ruler|hide-images|links|high-contrast|cv-)/.test(c.surfaceClasses), JSON.stringify(c));
  check('the stored document is still the typed text', (await storedDoc()) === DOC);
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`  screenshots: ${OUT}`);
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
