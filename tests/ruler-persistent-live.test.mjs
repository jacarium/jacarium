#!/usr/bin/env node
/**
 * The reading ruler stays put (Playwright against the Vite dev server, no
 * backend). With the ruler in Mask mode the mask is over the editor right
 * after the page opens, with no pointer movement, the band on the first
 * line; the pointer over a line moves the band there; the pointer leaving
 * (to the rail) keeps the mask and the band where it was; typing moves the
 * band to the caret; scrolling with the pointer away keeps the band at the
 * same screen position; a dialog over the page (Settings) keeps the mask,
 * which sits below the dialog; Highlight mode keeps its band when the
 * pointer leaves; the Preview gets the mask without a pointer; another page
 * (Tasks) takes the overlay off the editor's box; back on Documents it
 * returns.
 *
 * Needs playwright-core with Chromium. Port RULER_TEST_PORT (5225).
 * Run: node tests/ruler-persistent-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.RULER_TEST_PORT || 5225);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (RULER_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

const DOC = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the reading text, long enough to read as a sentence on its own.`).join('\n');
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
// the ruler is on in Mask mode before the app loads: the mask must be there from the first paint, no pointer needed
await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); localStorage.setItem('documentsReadingAids', JSON.stringify({ ruler: true, rulerMode: 'mask' })); } catch { /* storage */ } });
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().evaluate((el) => el.click()); break; } await sleep(300); } await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' }).catch(() => {}); };
// clicks through the DOM, so the pointer never moves
const clickButton = (label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
const railClick = (label) => page.evaluate((label) => { const b = document.querySelector(`nav.w-16 button[aria-label="${label}"]`); if (!b) return false; b.click(); return true; }, label);
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const probe = () => page.evaluate(() => {
  const c = document.querySelector('[data-testid="reading-ruler"]');
  if (!c) return { mounted: false };
  const b = c.querySelector('[data-testid="reading-ruler-band"]');
  const r = b.getBoundingClientRect(); const cr = c.getBoundingClientRect();
  const ed = document.querySelector('.sc-editor-cm'); const er = ed ? ed.getBoundingClientRect() : null;
  const sel = window.getSelection(); let caretTop = null;
  if (sel && sel.rangeCount) { const line = (sel.getRangeAt(0).startContainer.nodeType === 1 ? sel.getRangeAt(0).startContainer : sel.getRangeAt(0).startContainer.parentElement); const lr = line && line.closest ? line.closest('.cm-line') : null; if (lr) caretTop = lr.getBoundingClientRect().top; }
  const firstLine = document.querySelector('.sc-editor-cm .cm-line');
  return { mounted: true, hidden: c.hidden, mode: c.dataset.mode, top: r.top, height: r.height, clip: { left: cr.left, top: cr.top, width: cr.width, height: cr.height }, z: getComputedStyle(c).zIndex, shadow: (() => { const s = document.querySelector('[data-testid="reading-ruler-shade"]'); return !!s && !s.hidden; })(), editor: er && { left: er.left, top: er.top, width: er.width, height: er.height }, caretTop, firstLineTop: firstLine ? firstLine.getBoundingClientRect().top : null, scrollTop: document.querySelector('.sc-editor-cm .cm-scroller')?.scrollTop };
});
const lineBox = (n) => page.evaluate((n) => { const l = document.querySelectorAll('.sc-editor-cm .cm-line')[n]; const r = l.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2, top: r.top, height: r.height }; }, n);
const overlaps = (a, b) => a && b && a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  check('New Document (through the DOM: the pointer has not moved)', await clickButton('New Document'));
  await page.locator('.sc-editor-cm .cm-content').waitFor({ timeout: 15000 }); await sleep(600);
  let c = await probe();
  check('mask on, page just opened, no pointer: the overlay is present over the editor, in mask mode (the shadow dims the rest), the band on the first line', c.mounted && c.hidden === false && c.mode === 'mask' && c.shadow && overlaps(c.clip, c.editor) && near(c.top, c.firstLineTop, 2), JSON.stringify(c));
  check('the overlay sits below dialogs and menus (z-index 40)', c.z === '40', c.z);
  // text to read and to scroll
  await page.evaluate(() => { const cm = document.querySelector('.sc-editor-cm .cm-content'); cm.focus(); });
  await page.keyboard.insertText(DOC); await sleep(500);
  c = await probe();
  check('typing: the band is on the caret\'s line (the last line typed)', !c.hidden && c.caretTop != null && near(c.top, c.caretTop, 2), JSON.stringify([c.top, c.caretTop]));
  await page.evaluate(() => { document.querySelector('.sc-editor-cm .cm-scroller').scrollTop = 0; }); await sleep(300);
  // the pointer over line 5 moves the band there
  const l5 = await lineBox(4);
  await page.mouse.move(l5.x, l5.y); await sleep(150);
  c = await probe();
  check('the pointer over line 5: the band follows it', !c.hidden && near(c.top, l5.top, 2), JSON.stringify([c.top, l5.top]));
  // the pointer over the rail: the band follows onto the rail (its item or a free band there), the mask stays on
  await page.mouse.move(30, 400); await sleep(250);
  const onRail = await probe();
  const railBox = await page.evaluate(() => { const r = document.querySelector('nav.w-16').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  check('the pointer over the rail: the band follows onto the rail (the band\'s clip is the rail, the band under the pointer), the mask still on', !onRail.hidden && onRail.mode === 'mask' && onRail.shadow && onRail.clip.left >= railBox.left - 1 && onRail.clip.left + onRail.clip.width <= railBox.right + 1 && onRail.top <= 400 && onRail.top + onRail.height >= 400, JSON.stringify({ onRail, railBox }));
  // the pointer leaves the window: the band stays where it was
  await page.evaluate(() => { document.dispatchEvent(new PointerEvent('pointermove', { clientX: -10, clientY: -10, bubbles: true, pointerType: 'mouse' })); }); await sleep(250);
  const left = await probe();
  check('the pointer leaves the window: the band stays where it was (on the rail), the mask on', !left.hidden && left.shadow && near(left.top, onRail.top, 1), JSON.stringify([onRail.top, left.top]));
  // scrolling with the pointer away: the band keeps its screen position, the mask stays
  await page.evaluate(() => { document.querySelector('.sc-editor-cm .cm-scroller').scrollTop = 200; }); await sleep(300);
  c = await probe();
  check('scrolling the editor with the pointer away: the band keeps its screen position (same top), the mask stays', !c.hidden && c.shadow && near(c.top, left.top, 2) && c.scrollTop === 200, JSON.stringify([left.top, c.top, c.scrollTop]));
  // typing moves it to the caret again
  await page.evaluate(() => { document.querySelector('.sc-editor-cm .cm-content').focus(); });
  await page.keyboard.press('End'); await page.keyboard.type(' more'); await sleep(300);
  c = await probe();
  check('typing again: the band is on the caret\'s line', !c.hidden && c.caretTop != null && near(c.top, c.caretTop, 2), JSON.stringify([c.top, c.caretTop]));
  // a dialog over the page keeps the mask (below the dialog)
  await page.locator('[data-testid="sidebar-brand-mark"]').evaluate((el) => el.click());
  await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 }); await sleep(300);
  c = await probe();
  check('the Settings dialog open over the page: the ruler moves into the dialog (its overlay in the dialog\'s layer), still shown, the mask still dimming (the dialog and the page behind alike)', !c.hidden && parseInt(c.z, 10) > 50 && c.shadow, JSON.stringify(c));
  await page.keyboard.press('Escape'); await sleep(300);
  // highlight mode keeps its band when the pointer leaves
  await setAids({ ruler: true, rulerMode: 'highlight' }); await sleep(400);
  await page.evaluate(() => { document.querySelector('.sc-editor-cm .cm-scroller').scrollTop = 0; }); await sleep(300);
  const l3 = await lineBox(2);
  await page.mouse.move(l3.x, l3.y); await sleep(150);
  await page.evaluate(() => { document.dispatchEvent(new PointerEvent('pointermove', { clientX: -10, clientY: -10, bubbles: true, pointerType: 'mouse' })); }); await sleep(250);
  c = await probe();
  check('highlight mode: the band stays on line 3 when the pointer leaves the window', !c.hidden && c.mode === 'highlight' && !c.shadow && near(c.top, l3.top, 2), JSON.stringify([c, l3.top]));
  // the Preview gets the mask with no pointer over it
  await setAids({ ruler: true, rulerMode: 'mask' }); await sleep(300);
  await page.locator('[data-testid="editor-mode-toggle"]').evaluate((el) => el.click()); await sleep(600);
  const pv = await page.evaluate(() => { const p = document.querySelector('[data-testid="reading-aids-surface"] .markdown-preview'); if (!p) return null; const r = p.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
  c = await probe();
  // the editor's area is gone with the toggle: the observer finds the next reading area (the Preview) and the band takes its first line
  check('the Preview (toggled through the DOM, the pointer off the window): the mask is over it at once, the band on its first line', !!pv && !c.hidden && c.mode === 'mask' && c.shadow && overlaps(c.clip, pv) && c.top >= pv.top - 8 && c.top < pv.top + 80, JSON.stringify([c, pv]));
  await page.mouse.move(pv.left + 40, pv.top + 30); await sleep(300);
  c = await probe();
  check('the pointer over the Preview: the band under the pointer, the mask on', !!pv && !c.hidden && c.mode === 'mask' && c.shadow && overlaps(c.clip, pv) && c.top - 2 <= pv.top + 30 && c.top + c.height + 2 >= pv.top + 30, JSON.stringify([c, pv]));
  // another page: the overlay leaves the editor's box; back on Documents it returns
  const editorBox = pv;
  check('to Tasks', await railClick('Tasks')); await sleep(800);
  await page.mouse.move(editorBox.left + 60, editorBox.top + 40); await sleep(300);
  c = await probe();
  // the page pane is a reading area on every page: on Tasks the overlay is over Tasks' pane (the same box as the Preview had)
  check('on Tasks the overlay is present over the page pane (a reading area on every page), the band under the pointer', c.hidden === false && c.mode === 'mask' && overlaps(c.clip, editorBox) && c.clip.width > 600 && c.top - 2 <= editorBox.top + 40 && c.top + c.height + 2 >= editorBox.top + 40, JSON.stringify([c, editorBox]));
  check('back to Documents', await railClick('Documents')); await sleep(800);
  await page.mouse.move(pv.left + 40, pv.top + 30); await sleep(300);
  c = await probe();
  check('back on Documents, the pointer over the Preview: the mask is over the Preview again', !c.hidden && c.mode === 'mask' && c.shadow && overlaps(c.clip, pv), JSON.stringify([c, pv]));
  // ---- the band follows the pointer over whatever reading area is under it (the page pane and the sidebars
  //      included); an inner area only refines the snapping while the pointer is over it; controls keep the band
  const moveTo = async (x, y) => { await page.mouse.move(x, y); await sleep(260); };
  const onBox = (c, b) => !!b && c.top <= b.y + b.height + 1 && c.top + c.height >= b.y - 1;   // the band's line within the element's extent
  const holdsY = (c, y) => c.top - 2 <= y && c.top + c.height + 2 >= y;                          // the band's line holds the pointer's height
  const sidebarBox = async () => { const b = await page.locator('[data-side="left"][data-ra-area]').first().boundingBox(); return b; };
  const clipIn = (c, b) => !!b && Math.abs(c.clip.left - b.x) <= 2 && c.clip.width <= b.width + 2;
  await setAids({ ruler: true, rulerMode: 'mask' }); await sleep(300);
  // Documents: a sidebar row, the editor, the toolbar, the resize handle
  check('to Documents (again)', await railClick('Documents')); await sleep(500);
  if (!(await page.locator('.sc-editor-cm .cm-line').count())) { await page.locator('[data-testid="editor-mode-toggle"]').evaluate((el) => el.click()); await sleep(500); }   // back from the Preview to the editor
  await page.locator('[data-side="left"] button', { hasText: /^General/ }).first().click().catch(() => {}); await sleep(400);
  const docRow = await page.locator('[data-side="left"] .sc-row', { hasText: /Untitled/ }).first().boundingBox();
  if (docRow) await moveTo(docRow.x + 30, docRow.y + docRow.height / 2);
  let c0 = await probe(); let sb = await sidebarBox();
  check('Documents: the pointer over a document row in the sidebar puts the band on that row, the mask clipped to the sidebar', !!docRow && onBox(c0, docRow) && clipIn(c0, sb) && c0.shadow, JSON.stringify({ c0, docRow, sb }));
  const editorLine = await lineBox(2);
  await moveTo(editorLine.x, editorLine.y);
  c0 = await probe();
  check('Documents: back over the editor the band follows (line 3), the clip the editor again', Math.abs(c0.top - editorLine.top) <= 2 && c0.clip.left >= 300, JSON.stringify([c0, editorLine]));
  const toolbar = await page.locator('[data-testid="editor-mode-toggle"]').boundingBox();
  await moveTo(toolbar.x + toolbar.width / 2, toolbar.y + toolbar.height / 2);
  let c1 = await probe();
  const toolbarRow = await page.locator('.sc-editor-toolbar').first().boundingBox();
  check('Documents: the pointer over the toolbar snaps the band to the toolbar row (the band follows everywhere)', toolbarRow && Math.abs(c1.top - toolbarRow.y) <= 2 && Math.abs(c1.height - toolbarRow.height) <= 2, JSON.stringify([c1, toolbarRow]));
  const handle = await page.locator('[data-side="left"] [data-ra-control]').first().boundingBox();
  if (handle) await moveTo(handle.x + handle.width / 2, 450);
  c1 = await probe();
  check('Documents: the pointer over the sidebar\'s resize handle follows too (a band in the sidebar under the pointer)', !!handle && c1.top <= 450 && c1.top + c1.height >= 450 && c1.clip.left < 300, JSON.stringify([c0.top, c1, handle]));
  // Kanban with no boards: the sidebar's empty-state text, the empty page, the text again
  check('to Kanban', await railClick('Kanban')); await sleep(600);
  const snippet = await page.locator('[data-side="left"] .ra-reading').first().boundingBox();
  if (snippet) await moveTo(snippet.x + 20, snippet.y + snippet.height / 2);
  c0 = await probe();
  check('Kanban: the pointer over the sidebar\'s empty-state text puts the band on it', !!snippet && onBox(c0, snippet), JSON.stringify([c0, snippet]));
  await moveTo(800, 500);
  c0 = await probe();
  check('Kanban: the pointer out in the empty page moves the band to the page pane at the pointer\'s height (no snippet holds it)', holdsY(c0, 500) && c0.clip.width > 600, JSON.stringify(c0));
  if (snippet) await moveTo(snippet.x + 20, snippet.y + snippet.height / 2);
  c0 = await probe();
  check('Kanban: back over the text it snaps to it again', !!snippet && onBox(c0, snippet), JSON.stringify([c0, snippet]));
  // Tasks: the sidebar's text block and the page both ways
  check('to Tasks (again)', await railClick('Tasks')); await sleep(600);
  const taskText = await page.locator('[data-side="left"] .ra-reading, [data-side="left"] p').first().boundingBox();
  if (taskText) await moveTo(taskText.x + 20, taskText.y + taskText.height / 2);
  c0 = await probe();
  await moveTo(800, 600);
  c1 = await probe();
  check('Tasks: from the sidebar\'s text block to the page and the band follows both ways', !!taskText && onBox(c0, taskText) && holdsY(c1, 600) && c1.clip.width > 600, JSON.stringify([c0, c1, taskText]));
  // JQL Search: the sidebar and back; an element snap, then away
  check('to JQL Search', await railClick('JQL Search')); await sleep(600);
  sb = await sidebarBox();
  if (sb) await moveTo(sb.x + sb.width / 2, 400);
  c0 = await probe();
  check('JQL Search: the pointer over the sidebar puts the band there (clipped to the sidebar)', !!sb && clipIn(c0, sb) && holdsY(c0, 400), JSON.stringify([c0, sb]));
  const jqlText = await page.locator('[data-ra-area]:not([data-side]) p, [data-ra-area]:not([data-side]) h1, [data-ra-area]:not([data-side]) h2, [data-ra-area]:not([data-side]) label').first().boundingBox();
  if (jqlText) await moveTo(jqlText.x + 10, jqlText.y + jqlText.height / 2);
  c0 = await probe();
  await moveTo(900, 700);
  c1 = await probe();
  check('JQL Search: the band snaps to a text element, then follows the pointer away from it to the page at the pointer\'s height', !!jqlText && onBox(c0, jqlText) && holdsY(c1, 700) && c1.clip.width > 600, JSON.stringify([c0, c1, jqlText]));
  // a panel (Notifications): a reading area when open
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('toggleNotificationSidebar'))); await sleep(600);
  const panel = await page.locator('[data-side][data-ra-area]', { hasText: /Notifications/ }).first().boundingBox();
  if (panel) await moveTo(panel.x + panel.width / 2, panel.y + panel.height / 2);
  c0 = await probe();
  check('a panel (Notifications) open: the pointer over it puts the band there, clipped to the panel', !!panel && clipIn(c0, panel) && holdsY(c0, panel.y + panel.height / 2), JSON.stringify([c0, panel]));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('toggleNotificationSidebar'))); await sleep(400);
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
