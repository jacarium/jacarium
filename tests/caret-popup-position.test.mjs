#!/usr/bin/env node
/**
 * Where the Documents editor's caret popups go (src/utils/caretPopup.js,
 * src/components/features/documents/useCaretPopup.js, DocumentEditor.jsx):
 * the "/" menu, the "Link to document" picker ([[doc:, /link, Insert > Link
 * to document) and its "Convert to a permanent link" offer share one
 * placement: below the caret's line when it fits, above it when it does
 * not, capped and scrolling inside when neither side has the room, clamped
 * so it never runs off the right edge; re-placed on resize, scroll and when
 * the list changes size.
 *
 * THE BUG: "/link" near the bottom of the window opened the popup below
 * the caret, so its bottom was cut off.
 *
 * Static (plain Node): placeCaretPopup on the four cases.
 * Live (headless Chromium, the real page):
 *   - the caret on the last line near the bottom: the popup is fully within
 *     the viewport, above the caret (the "/" menu and the picker);
 *   - the caret near the top: below, as before;
 *   - a short window: the height is capped, the list scrolls, the highlighted
 *     entry stays in view after ArrowDown past the fold (both popups);
 *   - a narrow window: clamped to the right edge;
 *   - a resize while open keeps it within the window;
 *   - screenshots of the flipped popup, dark and light.
 *
 * SKIPs like tests/slash-commands-ui.test.mjs. Run: node tests/caret-popup-position.test.mjs
 * (CARET_POPUP_TEST_PORT, default 5207; CARET_POPUP_OUT for the screenshots)
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';
import { pwEditor, pwSetEditorText, EDITOR_EXPR } from './helpers/editor-surface.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.CARET_POPUP_TEST_PORT || 5207);
const OUT = process.env.CARET_POPUP_OUT || '/private/tmp/claude-501/shots/caret-popup';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- static ----
{
  const { placeCaretPopup, CARET_POPUP_GAP, CARET_POPUP_MARGIN } = await import(path.join(REPO, 'src', 'utils', 'caretPopup.js'));
  const viewport = { width: 1280, height: 900 };
  const popup = { width: 384, height: 350 };
  const below = placeCaretPopup({ caret: { left: 100, top: 100, bottom: 120 }, popup, viewport });
  check('room below: the popup opens under the caret line, at its full height', below.placement === 'below' && below.top === 120 + CARET_POPUP_GAP && below.maxHeight === 350 && below.left === 100, JSON.stringify(below));
  const above = placeCaretPopup({ caret: { left: 100, top: 800, bottom: 820 }, popup, viewport });
  check('no room below, room above: it opens above the caret line, its bottom at the gap', above.placement === 'above' && above.top + above.maxHeight === 800 - CARET_POPUP_GAP && above.maxHeight === 350, JSON.stringify(above));
  const capped = placeCaretPopup({ caret: { left: 100, top: 150, bottom: 170 }, popup, viewport: { width: 1280, height: 400 } });
  check('room on neither side: the side with more room (below), the height capped to it', capped.placement === 'below' && capped.maxHeight === 400 - 170 - CARET_POPUP_GAP - CARET_POPUP_MARGIN && capped.top === 180, JSON.stringify(capped));
  const cappedAbove = placeCaretPopup({ caret: { left: 100, top: 300, bottom: 320 }, popup, viewport: { width: 1280, height: 400 } });
  check('...or above when that side has more room, its top at the margin', cappedAbove.placement === 'above' && cappedAbove.top === CARET_POPUP_MARGIN && cappedAbove.maxHeight === 300 - CARET_POPUP_GAP - CARET_POPUP_MARGIN, JSON.stringify(cappedAbove));
  const right = placeCaretPopup({ caret: { left: 1200, top: 100, bottom: 120 }, popup, viewport });
  check('the right edge: clamped so the popup ends at the margin', right.left === 1280 - 384 - CARET_POPUP_MARGIN, JSON.stringify(right));
  const off = placeCaretPopup({ caret: { left: 100, top: 1000, bottom: 1020 }, popup, viewport });
  check('a caret scrolled below the window: anchored at the bottom edge, the popup above it and within the window', off.placement === 'above' && off.top + off.maxHeight <= 900 - CARET_POPUP_MARGIN && off.top >= CARET_POPUP_MARGIN, JSON.stringify(off));
  const narrow = placeCaretPopup({ caret: { left: 300, top: 100, bottom: 120 }, popup, viewport: { width: 320, height: 900 } });
  check('a viewport narrower than the popup: the left margin wins', narrow.left === CARET_POPUP_MARGIN, JSON.stringify(narrow));
}

if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(failed ? 1 : 0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (CARET_POPUP_TEST_PORT)`); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(failed ? 1 : 0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(failed ? 1 : 0); }
fs.mkdirSync(OUT, { recursive: true });

async function open(colorScheme) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', colorScheme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.evaluate(async (theme) => {
    const { db } = await import('/src/db/database.js');
    await db.documents.clear(); await db.documentTemplates.clear();
    const now = new Date();
    const id = await db.documents.add({ title: 'Popups', content: '', category: 'General', stableId: 'sid-popups', createdAt: now, updatedAt: now });
    for (let i = 1; i <= 14; i++) await db.documents.add({ title: `Target ${String(i).padStart(2, '0')}`, content: `# Target ${i}`, category: 'General', stableId: `sid-target-${i}`, createdAt: now, updatedAt: now });
    for (let i = 1; i <= 6; i++) await db.documentTemplates.add({ syncId: `tpl-${i}`, name: `Template ${i}`, description: `Template number ${i}`, category: 'Ops', tags: [], content: `# Template ${i}`, createdAt: now, updatedAt: now });
    localStorage.setItem('documentOpenTabs', JSON.stringify([{ id, title: 'Popups', category: 'General', inCloud: false }]));
    localStorage.setItem('currentDocumentId', JSON.stringify(id));
    localStorage.setItem('whatsNewLastSeen', '99.0.0');
    localStorage.setItem('app-theme', theme);
  }, colorScheme);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  if (await page.locator('.markdown-preview').count()) { await page.locator('[data-testid="editor-mode-toggle"]').click(); await page.waitForTimeout(500); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  return { context, page, errors };
}

const SEL = { slash: '[data-testid="slash-menu"]', link: '[data-testid="doc-link-menu"]' };
/** The popup's rects, the caret's rect and the viewport, or null when the popup is not open. */
const measure = (page, which) => page.evaluate(([sel, expr]) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const list = el.querySelector('[data-caret-popup-list]');
  const lr = list.getBoundingClientRect();
  const s = eval(expr);
  const c = s.coordsAtPos(s.selectionStart);
  const selected = el.querySelector('[aria-selected="true"], [data-slash-entry].bg-purple-100, [data-slash-entry].dark\\:bg-purple-900\\/30');
  const sr = selected ? selected.getBoundingClientRect() : null;
  return {
    placement: el.dataset.placement, top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height,
    list: { top: lr.top, bottom: lr.bottom, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight },
    selected: sr && { top: sr.top, bottom: sr.bottom },
    caret: c && { left: c.left, top: c.top, bottom: c.bottom },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}, [SEL[which], EDITOR_EXPR]);
const within = (m) => m && m.top >= 0 && m.left >= 0 && m.bottom <= m.viewport.height + 0.5 && m.right <= m.viewport.width + 0.5;
const selectedInView = (m) => m && m.selected && m.selected.top >= m.list.top - 0.5 && m.selected.bottom <= m.list.bottom + 0.5;
const closeAll = async (page) => { await page.keyboard.press('Escape'); await page.waitForTimeout(200); };
/** Many lines, the caret at the end of the last one, scrolled into view. */
const toBottom = async (page) => {
  await pwSetEditorText(page, Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`).join('\n') + '\n');
  await page.evaluate((expr) => { const s = eval(expr); s.scrollTop = s.scrollHeight; s.focus(); }, EDITOR_EXPR);
  await page.waitForTimeout(300);
};

try {
  const dark = await open('dark');
  const { page } = dark;
  const ta = pwEditor(page);
  check('the editor is open with an empty document', await ta.count() === 1);

  // near the top: below
  await pwSetEditorText(page, ''); await ta.focus(); await page.keyboard.type('/'); await page.waitForTimeout(400);
  let m = await measure(page, 'slash');
  check('the caret near the top: the "/" menu opens below the caret line, within the window', !!m && m.placement === 'below' && m.top >= m.caret.bottom && within(m), JSON.stringify(m));
  await closeAll(page);

  // near the bottom: above
  await toBottom(page);
  await page.keyboard.type('/'); await page.waitForTimeout(400);
  m = await measure(page, 'slash');
  check('the caret on the last line near the bottom: the "/" menu is fully within the window, above the caret', !!m && m.placement === 'above' && m.bottom <= m.caret.top && within(m) && m.caret.bottom > m.viewport.height - 300, JSON.stringify(m));
  await page.screenshot({ path: path.join(OUT, 'slash-above-dark.png') });
  await closeAll(page);
  await toBottom(page);
  await page.keyboard.type('[[doc:'); await page.waitForTimeout(500);
  m = await measure(page, 'link');
  check('...and so is the "Link to document" picker typed as [[doc:', !!m && m.placement === 'above' && m.bottom <= m.caret.top && within(m), JSON.stringify(m));
  await page.screenshot({ path: path.join(OUT, 'doc-link-above-dark.png') });
  await closeAll(page);
  await pwSetEditorText(page, Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`).join('\n') + '\n');
  await page.evaluate((expr) => { const s = eval(expr); s.scrollTop = s.scrollHeight; s.focus(); }, EDITOR_EXPR);
  await page.keyboard.type('/link'); await page.waitForTimeout(400);
  await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  m = await measure(page, 'link');
  check('...and the picker opened by the /link command (the reported case)', !!m && m.placement === 'above' && within(m), JSON.stringify(m));
  await closeAll(page);

  // a resize while open keeps it within the window
  await toBottom(page);
  await page.keyboard.type('/'); await page.waitForTimeout(400);
  await page.setViewportSize({ width: 1280, height: 600 }); await page.waitForTimeout(400);
  m = await measure(page, 'slash');
  check('a resize while the menu is open: still within the window', !!m && within(m), JSON.stringify(m));
  await closeAll(page);
  await page.setViewportSize({ width: 1280, height: 900 }); await page.waitForTimeout(300);

  // a short window: capped, the list scrolls, the highlighted entry stays in view
  await page.setViewportSize({ width: 1280, height: 420 }); await page.waitForTimeout(300);
  await pwSetEditorText(page, ''); await ta.focus(); await page.keyboard.type('/'); await page.waitForTimeout(400);
  m = await measure(page, 'slash');
  check('a short window: the "/" menu is capped to the room and its list scrolls inside', !!m && within(m) && m.list.scrollHeight > m.list.clientHeight + 10, JSON.stringify(m));
  for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);
  m = await measure(page, 'slash');
  check('...ArrowDown past the fold keeps the highlighted entry visible in the list', !!m && within(m) && selectedInView(m), JSON.stringify(m));
  await closeAll(page);
  await pwSetEditorText(page, ''); await ta.focus(); await page.keyboard.type('[[doc:'); await page.waitForTimeout(500);
  m = await measure(page, 'link');
  check('a short window: the picker is capped and scrolls too', !!m && within(m) && m.list.scrollHeight > m.list.clientHeight + 10, JSON.stringify(m));
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);
  m = await measure(page, 'link');
  check('...with the highlighted document in view after ArrowDown past the fold', !!m && within(m) && selectedInView(m), JSON.stringify(m));
  await closeAll(page);
  await page.setViewportSize({ width: 1280, height: 900 }); await page.waitForTimeout(300);

  // the right edge
  await page.setViewportSize({ width: 560, height: 900 }); await page.waitForTimeout(300);
  await pwSetEditorText(page, 'some words before the command '); await ta.focus(); await page.keyboard.type('/'); await page.waitForTimeout(400);
  m = await measure(page, 'slash');
  check('a narrow window: the menu is clamped to the right edge, never cut off', !!m && within(m) && m.caret.left + m.right - m.left > m.viewport.width, JSON.stringify(m));
  await closeAll(page);
  await pwSetEditorText(page, 'some words before the link '); await ta.focus(); await page.keyboard.type('[[doc:'); await page.waitForTimeout(500);
  m = await measure(page, 'link');
  check('...and so is the picker', !!m && within(m), JSON.stringify(m));
  await closeAll(page);
  await page.setViewportSize({ width: 1280, height: 900 }); await page.waitForTimeout(300);

  // typing filters the list: the popup shrinks and stays placed
  await toBottom(page);
  await page.keyboard.type('/'); await page.waitForTimeout(400);
  const before = await measure(page, 'slash');
  await page.keyboard.type('note'); await page.waitForTimeout(400);
  m = await measure(page, 'slash');
  check('typing a query shrinks the list: the menu is re-placed, still above the caret and within the window', !!m && !!before && m.height < before.height && m.placement === 'above' && m.bottom <= m.caret.top && within(m), JSON.stringify({ before, after: m }));
  await closeAll(page);

  check('dark: no page errors', dark.errors.length === 0, dark.errors.slice(0, 3).join(' | '));
  await dark.context.close();

  // light: the flipped popups look right there too
  const light = await open('light');
  await toBottom(light.page);
  await light.page.keyboard.type('/'); await light.page.waitForTimeout(400);
  m = await measure(light.page, 'slash');
  check('light: the "/" menu flips above the caret near the bottom', !!m && m.placement === 'above' && within(m), JSON.stringify(m));
  await light.page.screenshot({ path: path.join(OUT, 'slash-above-light.png') });
  await closeAll(light.page);
  await toBottom(light.page);
  await light.page.keyboard.type('[[doc:'); await light.page.waitForTimeout(500);
  m = await measure(light.page, 'link');
  check('light: the picker too', !!m && m.placement === 'above' && within(m), JSON.stringify(m));
  await light.page.screenshot({ path: path.join(OUT, 'doc-link-above-light.png') });
  await closeAll(light.page);
  check('light: no page errors', light.errors.length === 0, light.errors.slice(0, 3).join(' | '));
  await light.context.close();
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
