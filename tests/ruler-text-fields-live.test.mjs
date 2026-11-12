#!/usr/bin/env node
/**
 * The reading ruler over editable text (Playwright against the Vite dev
 * server, no backend): editable text is reading text. Over a textarea the
 * band follows the visual line under the pointer (soft-wrapped lines
 * included, a scrolled textarea mapped through its scrollTop) and the
 * caret's line while typing; over a single-line text input it sits on the
 * input's line box; buttons, checkboxes and the other controls still keep
 * the last line. Tools > CSV to JSON (the textarea, the tools search
 * input, a button and a checkbox), the AI chat composer, a Workflow note
 * node's textarea.
 *
 * Needs playwright-core with Chromium. Port RULER_FIELDS_TEST_PORT (5240).
 * Run: node tests/ruler-text-fields-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.RULER_FIELDS_TEST_PORT || 5240);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (RULER_FIELDS_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } };
const domClick = (locator) => locator.first().evaluate((el) => el.click());
const goTo = async (label) => { const b = page.locator(`nav.w-16 button[aria-label="${label}"]`); if (await b.count()) { await domClick(b); } else { await domClick(page.locator('[data-testid="rail-more"]')); await sleep(250); await domClick(page.locator('[data-testid="rail-more-menu"] button', { hasText: label })); } await page.mouse.move(700, 450); await sleep(700); };
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const band = () => page.evaluate(() => { const b = document.querySelector('[data-testid="reading-ruler-band"]'); const c = document.querySelector('[data-testid="reading-ruler"]'); if (!b || !c || c.hidden) return null; const r = b.getBoundingClientRect(); return { top: r.top, height: r.height, bottom: r.bottom }; });
// a field's metrics as the ruler reads them: the line height, the top of its first line, its scroll
const metrics = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); let lh = parseFloat(cs.lineHeight); if (!Number.isFinite(lh)) lh = parseFloat(cs.fontSize) * 1.2; const r = el.getBoundingClientRect(); return { lh, contentTop: r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop), top: r.top, height: r.height, left: r.left, width: r.width, right: r.right, scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }; }, sel);
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
const hoverLine = async (m, index) => { await page.mouse.move(m.left + Math.min(40, m.width / 2), m.contentTop + (index + 0.5) * m.lh - m.scrollTop); await sleep(250); return band(); };

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  await setAids({ ruler: true, rulerLines: 1, rulerMode: 'highlight' }); await sleep(400);
  await goTo('Tools');
  // the tool's row in the Tools sidebar (its category may be folded: unfold what is folded first)
  let toolRow = page.locator('[data-side="left"] .sc-row', { hasText: /CSV to JSON/ });
  if (!(await toolRow.count())) { const cat = page.locator('[data-side="left"] button', { hasText: /^Conversion/ }).first(); if (await cat.count()) { await cat.click(); await sleep(400); } toolRow = page.locator('[data-side="left"] .sc-row', { hasText: /CSV to JSON/ }); }
  check('Tools: the CSV to JSON tool is listed', (await toolRow.count()) >= 1);
  await toolRow.first().click(); await sleep(700);
  const TA = 'textarea[placeholder^="name,age,city"]';
  const ta = page.locator(TA);
  check('Tools > CSV to JSON: the CSV input textarea is on the page', (await ta.count()) === 1);
  await ta.fill(['name,age,city', 'alpha,30,Springfield', 'bravo,25,Shelbyville', 'charlie,41,Ogdenville', 'delta,19,North Haverbrook'].join('\n')); await sleep(300);
  let m = await metrics(TA);
  check(`the textarea's metrics are readable (line height ${m && m.lh.toFixed(1)} px, first line at ${m && Math.round(m.contentTop)})`, m && m.lh > 10);
  let b = await hoverLine(m, 1);
  check('the pointer over the 2nd line: the band is on the 2nd line (a textarea is reading text)', b && near(b.top, m.contentTop + m.lh) && near(b.height, m.lh), JSON.stringify({ b, m }));
  b = await hoverLine(m, 2);
  check('...over the 3rd line: the band moves to the 3rd', b && near(b.top, m.contentTop + 2 * m.lh), JSON.stringify({ b, m }));
  // typing: the caret's line
  await ta.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await page.mouse.move(1300, 850); await sleep(200);   // the pointer away from the field
  await page.keyboard.type(',x'); await sleep(300);
  b = await band(); m = await metrics(TA);
  check('typing at the end: the band follows the caret to the 5th line', b && near(b.top, m.contentTop + 4 * m.lh), JSON.stringify({ b, m }));
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await sleep(300);
  b = await band();
  check('ArrowUp twice: the caret\'s line, the 3rd', b && near(b.top, m.contentTop + 2 * m.lh), JSON.stringify({ b, m }));
  // a scrolled textarea: many lines, scrolled by five, the first visible line is line 6
  await ta.fill(Array.from({ length: 40 }, (_, i) => `row${i + 1},${i + 20},town${i + 1}`).join('\n')); await sleep(300);
  await ta.evaluate((el) => { el.scrollTop = 0; });
  m = await metrics(TA);
  await ta.evaluate((el, lh) => { el.scrollTop = Math.round(5 * lh); el.dispatchEvent(new Event('scroll', { bubbles: true })); }, m.lh); await sleep(200);
  m = await metrics(TA);
  check(`the textarea scrolled by ${Math.round(m.scrollTop)} px (five lines)`, m.scrollTop > 0 && m.scrollHeight > m.clientHeight, JSON.stringify(m));
  b = await hoverLine(m, 5);   // the line whose index is 5 is the first visible one
  check('a scrolled textarea maps correctly: the pointer on the first visible line (line 6) puts the band on it, at the content top', b && near(b.top, m.contentTop) && near(b.height, m.lh), JSON.stringify({ b, m }));
  b = await hoverLine(m, 7);
  check('...and on the third visible line (line 8)', b && near(b.top, m.contentTop + 2 * m.lh), JSON.stringify({ b, m }));
  // a soft-wrapped line: one long line of words wraps into visual lines; the band snaps per visual line
  await ta.fill(Array.from({ length: 60 }, (_, i) => `word${i + 1}`).join(' ')); await sleep(300);
  await ta.evaluate((el) => { el.scrollTop = 0; });
  m = await metrics(TA);
  const wrapped = await ta.evaluate((el) => el.scrollHeight > el.clientHeight || (() => { const cs = getComputedStyle(el); const lh = parseFloat(cs.lineHeight); return el.scrollHeight > 2 * lh; })());
  check('one long line soft-wraps into several visual lines', wrapped, JSON.stringify(m));
  b = await hoverLine(m, 1);
  check('the pointer over the 2nd visual line of the wrapped line: the band on that visual line', b && near(b.top, m.contentTop + m.lh) && near(b.height, m.lh), JSON.stringify({ b, m }));
  const lastOnWrap = b;
  // a single-line text input: the band on its line box
  const SEARCH = 'input[placeholder="Search tools..."]';
  const sm = await metrics(SEARCH);
  check('the tools search input is on the page', !!sm);
  await page.mouse.move(sm.left + 30, sm.top + sm.height / 2); await sleep(250);
  b = await band();
  check('the pointer over the search input: the band sits on the input\'s line box', b && near(b.top, sm.top, 2) && near(b.height, sm.height, 2), JSON.stringify({ b, sm }));
  // a button row and a checkbox: the band snaps to their row boxes (the band follows everywhere)
  await hoverLine(m, 1); b = await band();
  const btn = page.locator('[data-ra-area] button', { hasText: /Convert|Copy|Download|Clear/ }).first();
  const bb = (await btn.count()) ? await btn.boundingBox() : null;
  if (bb) { await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(250); }
  let after = await band();
  check(`the pointer over a button (${bb ? 'found' : 'none found'}) snaps the band to the button's row`, bb && after && near(after.top, bb.y, 2) && near(after.height, bb.height, 2), JSON.stringify({ b, after, bb }));
  const cb = page.locator('[data-ra-area] input[type="checkbox"]').first();
  const cbb = (await cb.count()) ? await cb.boundingBox() : null;
  if (cbb) { await page.mouse.move(cbb.x + cbb.width / 2, cbb.y + cbb.height / 2); await sleep(250); }
  after = await band();
  check(`the pointer over a checkbox (${cbb ? 'found' : 'none found'}) snaps to its box too`, cbb && after && after.top <= cbb.y + 1 && after.bottom >= cbb.y + cbb.height - 1, JSON.stringify({ b, after, cbb, lastOnWrap }));

  // ---- Mask mode dims the whole window but the band: the shade's hole is the band; the rest - the sidebar, the rail,
  //      the content around the band - is under the shade; clicks still reach the controls under it
  await setAids({ rulerMode: 'mask' }); await sleep(300);
  await ta.fill(['name,age,city', 'alpha,30,Springfield', 'bravo,25,Shelbyville'].join('\n')); await ta.evaluate((el) => { el.scrollTop = 0; }); await sleep(200);
  m = await metrics(TA);
  await hoverLine(m, 1);
  const shade = () => page.evaluate(() => { const s = document.querySelector('[data-testid="reading-ruler-shade"]'); if (!s || s.hidden) return null; const r = s.getBoundingClientRect(); const hole = (s.dataset.hole || '').split(',').map(Number); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight, pointerEvents: getComputedStyle(s).pointerEvents, bg: getComputedStyle(s).backgroundColor, hole: hole.length === 4 ? { left: hole[0], top: hole[1], right: hole[2], bottom: hole[3] } : null }; });
  const inHole = (s, x, y) => !!s.hole && x >= s.hole.left && x <= s.hole.right && y >= s.hole.top && y <= s.hole.bottom;
  const points = await page.evaluate(() => { const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }; const rail = document.querySelector('nav.w-16'); const side = document.querySelector('[data-side="left"]'); return { rail: rail && box(rail), sidebar: side && box(side) }; });
  let sh = await shade();
  check('mask on, the pointer over the content: the shade covers the whole window (pointer-transparent, the mask colour) with a hole on the band', sh && sh.left <= 0 && sh.top <= 0 && sh.right >= sh.vw && sh.bottom >= sh.vh && sh.pointerEvents === 'none' && sh.hole && near(sh.hole.top, m.contentTop + m.lh) && near(sh.hole.bottom - sh.hole.top, m.lh), JSON.stringify(sh));
  check('...the sidebar and the rail are under the shade (dimmed), the band region is not', sh && points.rail && points.sidebar && !inHole(sh, points.rail.x, points.rail.y) && !inHole(sh, points.sidebar.x, points.sidebar.y) && inHole(sh, (sh.hole.left + sh.hole.right) / 2, (sh.hole.top + sh.hole.bottom) / 2), JSON.stringify({ sh, points }));
  const contentPoint = { x: m.left + 20, y: m.contentTop + m.lh / 2 };
  const sideRow = page.locator('[data-side="left"] button, [data-side="left"] .sc-row').first();
  const srb = (await sideRow.count()) ? await sideRow.boundingBox() : null;
  if (srb) { await page.mouse.move(srb.x + srb.width / 2, srb.y + srb.height / 2); await sleep(300); }
  sh = await shade();
  check('the pointer over the sidebar: the band (the hole) is in the sidebar and the content is under the shade', srb && sh && sh.hole && sh.hole.left <= srb.x + 1 && sh.hole.right >= srb.x + srb.width - 1 && !inHole(sh, contentPoint.x, contentPoint.y), JSON.stringify({ sh, srb, contentPoint }));
  // a click through the shade reaches the control under it
  await page.mouse.click(sm.left + 30, sm.top + sm.height / 2); await sleep(200);
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('placeholder'));
  check('a click on the search input through the shade focuses it (the mask blocks no clicks)', focused === 'Search tools...', String(focused));
  await setAids({ rulerMode: 'highlight' }); await sleep(300);
  sh = await shade();
  check('Highlight mode: no shade', sh === null, JSON.stringify(sh));

  // ---- the AI chat composer
  await goTo('Robin');
  const COMPOSER = '[data-ra-area] textarea';
  const composer = page.locator(COMPOSER).first();
  check('the AI chat page has its composer textarea', (await composer.count()) >= 1);
  // without an AI backend the composer is disabled (typing is covered on the CSV textarea); the pointer still follows its lines
  const composerDisabled = await composer.isDisabled();
  if (!composerDisabled) {
    await composer.click(); await page.keyboard.type('first line'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('second line'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('third line'); await sleep(300);
    const cm0 = await metrics(COMPOSER);
    await page.evaluate(() => { document.dispatchEvent(new PointerEvent('pointermove', { clientX: -10, clientY: -10, bubbles: true, pointerType: 'mouse' })); }); await sleep(200);
    b = await band();
    check('typing in the composer: the band on the caret\'s line (the 3rd)', b && cm0 && near(b.top, cm0.contentTop + 2 * cm0.lh - cm0.scrollTop, 2), JSON.stringify({ b, cm0 }));
  }
  const cm = await metrics(COMPOSER);
  b = await hoverLine(cm, 1);
  check(`the pointer over the composer's 2nd line (the composer ${composerDisabled ? 'disabled, no AI backend' : 'enabled'}): the band on that line`, b && near(b.top, cm.contentTop + cm.lh - cm.scrollTop, 2) && near(b.height, cm.lh, 2), JSON.stringify({ b, cm }));
  if (!composerDisabled) await composer.fill('');

  // ---- a Workflow note node's textarea: a Note node added through the canvas' node search
  await goTo('Workflow Builder');
  const newWf = page.locator('button', { hasText: /^New Workflow$/ }).first();
  if (await newWf.count()) { await domClick(newWf); await sleep(1200); }
  await page.locator('.react-flow__pane').first().waitFor({ timeout: 10000 }).catch(() => {});
  const pane = page.locator('.react-flow__pane').first();
  let noteOk = false; let noteDetail = '';
  if (await pane.count()) {
    const pb = await pane.boundingBox();
    // a double-click on the empty canvas (its pane element itself, away from the start node) opens the node search; Tab with the pointer over it too
    await page.mouse.dblclick(pb.x + 80, pb.y + pb.height - 80); await sleep(500);
    if (!(await page.locator('#workflow-node-search-list').count())) { await page.mouse.move(pb.x + 80, pb.y + pb.height - 80); await page.keyboard.press('Tab'); await sleep(500); }
    const search = page.locator('#workflow-node-search-list').first();
    if (await search.count()) {
      await page.keyboard.type('note'); await sleep(300); await page.keyboard.press('Enter'); await sleep(800);
      const NOTE = '.react-flow__node textarea';
      if (await page.locator(NOTE).count()) {
        await page.locator(NOTE).first().fill('note line one\nnote line two\nnote line three'); await sleep(300);
        const nm = await metrics(NOTE);
        b = await hoverLine(nm, 1);
        noteOk = b && nm && near(b.top, nm.contentTop + nm.lh - nm.scrollTop, 2);
        noteDetail = JSON.stringify({ b, nm });
      } else noteDetail = 'no note node textarea after choosing Note';
    } else noteDetail = 'no node search on right-click';
  } else noteDetail = 'no canvas pane';
  check('a Workflow note node\'s textarea: the pointer over its 2nd line puts the band there', noteOk, noteDetail);

  // ---- menus: the Documents hamburger menu, a row's context menu, a dropdown (the tab strip's overflow panel) - the band
  //      snaps to each item row in the menu's own layer; in Mask mode the rest (the page behind too) is dimmed and the
  //      item row is the hole; the menu's own selected / hovered backgrounds stay readable; closing returns to the page
  await goTo('Documents');
  await page.evaluate(async () => { const m = await import('/src/utils/documents.js'); for (let i = 1; i <= 3; i++) await m.createDocument({ title: `Sample note ${i}`, content: `Sample ${i}`, category: 'General' }); });
  await goTo('Tasks'); await goTo('Documents');
  const rulerState = () => page.evaluate(() => { const c = document.querySelector('[data-testid="reading-ruler"]'); const b = document.querySelector('[data-testid="reading-ruler-band"]'); const s = document.querySelector('[data-testid="reading-ruler-shade"]'); if (!c || c.hidden) return null; const r = b.getBoundingClientRect(); const cr = c.getBoundingClientRect(); const hole = s && !s.hidden ? (s.dataset.hole || '').split(',').map(Number) : null; return { top: r.top, height: r.height, bottom: r.bottom, z: getComputedStyle(c).zIndex, clip: { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom }, shade: !!s && !s.hidden, shadeZ: s ? getComputedStyle(s).zIndex : null, hole: hole && hole.length === 4 ? { left: hole[0], top: hole[1], right: hole[2], bottom: hole[3] } : null }; });
  const onRow = (st, box) => st && Math.abs(st.top - box.y) <= 2 && Math.abs(st.height - box.height) <= 2;
  const ct = await import(path.join(REPO, 'src/utils/customThemes.js'));
  const textContrastUnderBand = (sel) => page.evaluate((sel) => {
    const el = document.querySelector(sel); if (!el) return null;
    const cs = getComputedStyle(el); const band = document.querySelector('[data-testid="reading-ruler-band"]'); const tint = band ? getComputedStyle(band).backgroundColor : 'rgba(0,0,0,0)';
    return { text: cs.color, bg: cs.backgroundColor, tint, label: el.textContent.trim().slice(0, 30) };
  }, sel);
  const composite = (over, under) => { const o = ct.parseColor(over); const u = ct.parseColor(under); if (!o || !u) return under; const a = o.a == null ? 1 : o.a; return `rgb(${Math.round(o.r * a + u.r * (1 - a))}, ${Math.round(o.g * a + u.g * (1 - a))}, ${Math.round(o.b * a + u.b * (1 - a))})`; };
  for (const modeName of ['highlight', 'mask']) {
    await setAids({ rulerMode: modeName }); await sleep(300);
    // the hamburger menu
    await page.locator('[data-side="left"] button[aria-label="Menu"]').first().click(); await sleep(400);
    const menu = page.locator('.sc-menu').first();
    check(`${modeName}: the Documents hamburger menu opens (role menu)`, (await menu.count()) === 1 && (await menu.getAttribute('role')) === 'menu');
    const items = menu.locator('button');
    const n = await items.count();
    const second = n > 1 ? await items.nth(1).boundingBox() : null;
    if (second) { await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2); await sleep(300); }
    let st = await rulerState();
    const menuBox = await menu.boundingBox();
    check(`${modeName}: the pointer over the menu's 2nd item snaps the band to the item row, the overlay in the menu's layer (z above the menu's), the clip the menu`, second && onRow(st, second) && parseInt(st.z, 10) > 50 && st.clip.left >= menuBox.x - 1 && st.clip.right <= menuBox.x + menuBox.width + 1, JSON.stringify({ st, second, menuBox }));
    if (modeName === 'mask') check('mask: the shade is in the menu\'s layer too, with the item row as its hole; the page behind is dimmed', st.shade && parseInt(st.shadeZ, 10) > 50 && st.hole && Math.abs(st.hole.top - second.y) <= 2 && !(st.hole.left <= 100 && st.hole.right >= 100 && st.hole.top <= 600 && st.hole.bottom >= 600), JSON.stringify(st));
    // the selected item (Date Modified, the sort group) keeps readable text under the band
    const selected = await textContrastUnderBand('.sc-menu button[aria-pressed="true"], .sc-menu button[aria-checked="true"], .sc-menu .btn-selected, .sc-menu button');
    if (selected) {
      const bg = composite(modeName === 'highlight' ? selected.tint : 'rgba(0,0,0,0)', selected.bg === 'rgba(0, 0, 0, 0)' ? 'rgb(30,30,30)' : selected.bg);
      const ratio = ct.contrastRatio(selected.text, bg);
      check(`${modeName}: the menu item's text ("${selected.label}") stays readable under the band (${ratio.toFixed(1)}:1)`, ratio >= 4.5, JSON.stringify({ selected, bg, ratio }));
    }
    await page.keyboard.press('Escape'); await sleep(300);
    st = await rulerState();
    check(`${modeName}: the menu closed: the ruler returns to the page (z 40)`, st && st.z === '40', JSON.stringify(st));
    // a row's context menu
    const row = page.locator('[data-side="left"] .sc-row', { hasText: /Sample note/ }).first();
    if (!(await row.count())) { const general = page.locator('[data-side="left"] button', { hasText: /^General/ }).first(); if (await general.count()) { await general.click(); await sleep(300); } }
    const rb = (await row.count()) ? await row.boundingBox() : null;
    if (rb) { await row.click({ button: 'right' }); await sleep(400); }
    const cmenu = page.locator('.sc-context-menu').first();
    const citems = cmenu.locator('button, [role="menuitem"]');
    const citem = (await cmenu.count()) && (await citems.count()) > 1 ? await citems.nth(1).boundingBox() : null;
    if (citem) { await page.mouse.move(citem.x + citem.width / 2, citem.y + citem.height / 2); await sleep(300); }
    st = await rulerState();
    check(`${modeName}: a row's context menu: the band snaps to its 2nd item, in the menu's layer${modeName === 'mask' ? ', the hole on that item' : ''}`, citem && onRow(st, citem) && parseInt(st.z, 10) > 50 && (modeName !== 'mask' || (st.hole && Math.abs(st.hole.top - citem.y) <= 2)), JSON.stringify({ st, citem }));
    await page.keyboard.press('Escape'); await sleep(300);
  }
  // a dropdown: the tab strip's overflow panel at a narrow window (three documents open: the sample notes from the sidebar)
  for (const n of [1, 2]) { const r = page.locator('[data-side="left"] .sc-row', { hasText: new RegExp(`Sample note ${n}$`) }).first(); if (await r.count()) { await r.click(); await sleep(500); } }
  await page.setViewportSize({ width: 600, height: 900 }); await sleep(800);
  const overflow = page.locator('[data-testid="tabs-overflow"]');
  if (await overflow.count()) {
    await overflow.click(); await sleep(400);
    const opt = page.locator('[data-testid="tabs-overflow-menu"] button').first();
    const ob = (await opt.count()) ? await opt.boundingBox() : null;
    if (ob) { await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2); await sleep(300); }
    const st = await rulerState();
    check('a dropdown (the tab strip\'s overflow panel): the band snaps to its first row in the panel\'s layer', ob && onRow(st, ob) && parseInt(st.z, 10) > 40, JSON.stringify({ st, ob }));
    await page.keyboard.press('Escape');
  } else {
    check('the tab strip overflows at 700 px (a dropdown to test)', false, 'no overflow button');
  }
  await page.setViewportSize({ width: 1360, height: 900 }); await sleep(300);
  await setAids({ rulerMode: 'highlight' });
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 14).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
