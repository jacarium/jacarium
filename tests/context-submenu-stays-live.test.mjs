#!/usr/bin/env node
/**
 * A context menu with a submenu stays where it is when the submenu opens.
 * The Documents editor's right-click menu has one ("Search In", the engine
 * templates by category - the shared ContextSubmenu of
 * src/components/common/menus/ContextMenu.jsx). The submenu used to be laid
 * out inside the menu's own box, so opening it made the menu "taller" to the
 * shared placement, which then moved the whole menu up the window.
 *
 * In Chromium AND WebKit (Playwright, against the Vite dev server, no
 * backend), with a long document, for a right-click near the BOTTOM of the
 * window, near the TOP, and near the bottom of a narrow window (no room at
 * the right of the row):
 *
 *   - the menu opens at the pointer, inside the window;
 *   - hovering "Search In" opens the submenu and the main menu's rectangle is
 *     the same within 1 px - right away and after the placement settled;
 *   - the submenu is fully inside the window;
 *   - the submenu is adjacent to the "Search In" row: beside it (its left
 *     edge at the row's right edge, or its right edge at the row's left edge
 *     when flipped), sharing some of the row's height, and it does not
 *     cover the row;
 *   - the submenu lists the templates under their categories, and choosing
 *     one closes the whole menu;
 *   - the keys: ArrowRight on the row opens the submenu, ArrowLeft closes it,
 *     the menu not moving; leaving the row with the pointer closes it.
 *
 * Synthetic documents and template names only (example.com).
 * Port SUBMENU_TEST_PORT (5352); SUBMENU_ENGINES=chromium,webkit.
 * Run: node tests/context-submenu-stays-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.SUBMENU_TEST_PORT || 5352);
const ENGINES = (process.env.SUBMENU_ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail !== '' ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (SUBMENU_TEST_PORT)`); process.exit(0); }
const browsers = {};
for (const engine of ENGINES) {
  try { browsers[engine] = await pw[engine].launch(); } catch (e) { console.log(`SKIP (${engine}): it could not start (${String(e.message).split('\n')[0]})`); }
}
if (!Object.keys(browsers).length) { console.log('SKIP: no browser engine could start'); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { for (const b of Object.values(browsers)) { try { await b.close(); } catch { /* gone */ } } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

const MENU = '[data-testid="editor-context-menu"]';
const ROW = '[data-testid="selection-search-in"]';
const SUB = '[data-testid="selection-search-in-submenu"]';
const TEMPLATES = [
  ['Access', 'Example Access One'], ['Access', 'Example Access Two'],
  ['Documentation', 'Example Docs 1.0'], ['Documentation', 'Example Docs 2.0'], ['Documentation', 'Example Docs 3.0'], ['Documentation', 'Example Docs 4.0'],
];
const DOC = '# Long sample\n\n' + Array.from({ length: 90 }, (_, i) => `Line ${i + 1}: alpha bravo charlie delta echo foxtrot golf hotel india juliet.`).join('\n\n') + '\n';

async function open(browser, viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General'])); } catch { /* no storage */ } });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await page.evaluate(async ([doc, templates]) => {
    const { db } = await import('/src/db/database.js');
    await db.documents.clear();
    await db.engineTemplates.clear();
    for (const [category, name] of templates) await db.engineTemplates.add({ name, category, urlTemplate: 'https://search.example.com/?q={query}', description: '' });
    const id = await db.documents.add({ title: 'Long sample', content: doc, category: 'General', stableId: 'sid-long', createdAt: new Date(), updatedAt: new Date() });
    localStorage.setItem('documentOpenTabs', JSON.stringify([{ id, title: 'Long sample' }]));
    localStorage.setItem('currentDocumentId', JSON.stringify(id));
  }, [DOC, TEMPLATES]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.sc-editor-cm .cm-content', { timeout: 60000 });
  await sleep(1200);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(250); }
  return { context, page, errors };
}
const rectOf = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }, sel);
const same = (a, b) => !!a && !!b && ['left', 'top', 'right', 'bottom'].every((k) => Math.abs(a[k] - b[k]) <= 1);
const inside = (r, vp) => !!r && r.left >= 0 && r.top >= 0 && r.right <= vp.width && r.bottom <= vp.height;
// beside the row (either side, within 2 px), sharing some of its height, not over it
const adjacent = (sub, row) => !!sub && !!row && (Math.abs(sub.left - row.right) <= 2 || Math.abs(sub.right - row.left) <= 2) && sub.top < row.bottom && sub.bottom > row.top;

// a selection on a visible line `fromTop` px below the editor's top (or above its bottom when negative), and a right-click on it
async function openMenuAt(page, where) {
  await page.keyboard.press('Escape').catch(() => {}); await sleep(150);
  const at = await page.evaluate((w) => {
    const surface = document.querySelector('.sc-editor-cm').editorSurface;
    const box = surface.view.scrollDOM.getBoundingClientRect();
    const y = w === 'bottom' ? Math.min(box.bottom, window.innerHeight) - 40 : box.top + 30;
    const x = box.left + 140;
    let pos = surface.view.posAtCoords({ x, y });
    const text = surface.value;
    while (pos > 0 && !/\w/.test(text[pos])) pos--;   // a blank line between paragraphs: the word before it
    let from = pos; let to = pos;
    while (from > 0 && /\w/.test(text[from - 1])) from--;
    while (to < text.length && /\w/.test(text[to])) to++;
    surface.focus(); surface.setSelectionRange(from, to, 'none', { scrollIntoView: false });
    const c = surface.view.coordsAtPos(Math.floor((from + to) / 2));
    return { x: Math.round(c.left), y: Math.round((c.top + c.bottom) / 2), word: text.slice(from, to) };
  }, where);
  await sleep(200);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.waitForSelector(MENU, { timeout: 5000 });
  await sleep(400);
  return at;
}

async function scenario(tag, page, viewport, where) {
  const at = await openMenuAt(page, where);
  const before = await rectOf(page, MENU);
  const row0 = await rectOf(page, ROW);
  check(`${tag}: the menu opens inside the window, with the Search In row (a selection: "${at.word}")`, inside(before, viewport) && !!row0, JSON.stringify({ before, row0, at }));
  if (!row0) return;
  check(`${tag}: ...at the pointer (its box touches the pointer's column and row)`, at.x >= before.left - 2 && at.x <= before.right + 2 && (Math.abs(before.top - at.y) <= 6 || Math.abs(before.bottom - at.y) <= 6 || (before.top <= at.y && before.bottom >= at.y)), JSON.stringify({ before, at }));
  await page.hover(ROW);
  await page.waitForSelector(SUB, { timeout: 3000 }).catch(() => {});
  const soon = await rectOf(page, MENU);
  await sleep(500);
  const after = await rectOf(page, MENU);
  const sub = await rectOf(page, SUB);
  const row = await rectOf(page, ROW);
  check(`${tag}: hovering Search In opens the submenu`, !!sub, 'no submenu');
  check(`${tag}: the main menu did not move or resize (within 1 px), right away and once settled`, same(before, soon) && same(before, after), JSON.stringify({ before, soon, after }));
  check(`${tag}: the submenu is fully inside the window`, inside(sub, viewport), JSON.stringify({ sub, viewport }));
  check(`${tag}: the submenu is adjacent to the Search In row (beside it, sharing its height, not over it)`, adjacent(sub, row), JSON.stringify({ sub, row }));
  const listed = await page.evaluate((s) => { const e = document.querySelector(s); return e ? { items: Array.from(e.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent.trim()), text: e.textContent } : null; }, SUB);
  check(`${tag}: the submenu lists the templates under their categories`, !!listed && listed.items.join('|') === TEMPLATES.map((t) => t[1]).join('|') && /Access/i.test(listed.text) && /Documentation/i.test(listed.text), JSON.stringify(listed));
  // every row of the submenu can be reached with the pointer without the menu closing (the pointer crosses from the row)
  const last = await page.evaluate((s) => { const items = document.querySelectorAll(`${s} [role="menuitem"]`); const r = items[items.length - 1].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }, SUB);
  await page.mouse.move(Math.round(row.left + row.width / 2), Math.round(row.top + row.height / 2));
  await page.mouse.move(Math.round((sub.left + sub.right) / 2), Math.round(Math.max(sub.top + 6, Math.min(sub.bottom - 6, row.top + row.height / 2))), { steps: 6 });
  await page.mouse.move(last.x, last.y, { steps: 6 });
  await sleep(250);
  check(`${tag}: the pointer crosses into the submenu and reaches its last row; the menu still has not moved`, !!(await rectOf(page, SUB)) && same(before, await rectOf(page, MENU)), JSON.stringify(await rectOf(page, MENU)));
  await page.mouse.click(last.x, last.y);
  await sleep(400);

  check(`${tag}: choosing a template closes the whole menu, submenu included`, !(await rectOf(page, MENU)) && !(await rectOf(page, SUB)));
}

async function keys(tag, page) {
  await openMenuAt(page, 'bottom');
  const before = await rectOf(page, MENU);
  await page.focus(ROW);
  await page.keyboard.press('ArrowRight'); await sleep(400);
  const sub = await rectOf(page, SUB);
  check(`${tag}: ArrowRight on the row opens the submenu, the menu not moving`, !!sub && same(before, await rectOf(page, MENU)) && (await page.getAttribute(ROW, 'aria-expanded')) === 'true', JSON.stringify({ sub, menu: await rectOf(page, MENU), before }));
  await page.focus(ROW);
  await page.keyboard.press('ArrowLeft'); await sleep(300);
  check(`${tag}: ArrowLeft closes it, the menu not moving`, !(await rectOf(page, SUB)) && same(before, await rectOf(page, MENU)) && (await page.getAttribute(ROW, 'aria-expanded')) === 'false');
  await page.hover(ROW); await sleep(300);
  const copy = await rectOf(page, '[data-testid="selection-copy"]');
  await page.mouse.move(Math.round(copy.left + 20), Math.round(copy.top + copy.height / 2), { steps: 4 }); await sleep(300);
  check(`${tag}: the pointer leaving the row for another item closes the submenu, the menu not moving`, !(await rectOf(page, SUB)) && same(before, await rectOf(page, MENU)));
  await page.keyboard.press('Escape'); await sleep(200);
  check(`${tag}: Escape closes the menu`, !(await rectOf(page, MENU)));
}

try {
  for (const [engine, browser] of Object.entries(browsers)) {
    for (const [name, viewport] of [['wide', { width: 1280, height: 820 }], ['narrow', { width: 720, height: 640 }]]) {
      const { context, page, errors } = await open(browser, viewport);
      try {
        await scenario(`${engine} ${name}, near the bottom`, page, viewport, 'bottom');
        await scenario(`${engine} ${name}, near the top`, page, viewport, 'top');
        if (name === 'wide') await keys(`${engine} keys`, page);
        check(`${engine} ${name}: no page error`, errors.length === 0, errors.join(' || '));
      } finally { await context.close(); }
    }
  }
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 5).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
