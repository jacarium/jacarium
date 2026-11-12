#!/usr/bin/env node
/**
 * Context menus stay inside the window (Playwright against the Vite dev
 * server, no backend). The maintainer right-clicked a word near the bottom
 * of the Documents editor to add it to the dictionary and the menu opened
 * partly below the window. The editor's menu is the app's own
 * (TextSelectionMenu on the shared ContextMenu; the desktop app only
 * reports the misspelled word and its suggestions over IPC, after the menu
 * opened - so the menu grows once it is on screen). Every menu now goes
 * through one placement (src/hooks/usePopupPosition.js): below / right of
 * the pointer when it fits, flipped above / left when not, clamped with a
 * capped height and scrolling inside when it fits nowhere, re-measured as
 * it renders, grows, and on resize.
 *
 *  - a misspelled word on the editor's last visible line: the menu, with the
 *    suggestions and "Add to dictionary" joined, is fully inside the window;
 *    "Add to dictionary" is visible and clickable (the IPC call is made);
 *  - the same near the right edge: the menu flips to the left of the pointer;
 *  - at 200 % with the interface scaled, in a short window (1400x520): the
 *    menu fits or scrolls inside; Arrow Down reaches the last item, in view;
 *  - the Documents sidebar's context menu on the last visible row of a long
 *    list opens above the pointer, inside the window;
 *  - a dropdown near the bottom (the rail's ... menu in the short window) is
 *    inside the window;
 *  - no page errors.
 *
 * The desktop bridge is faked (window.electronAPI.onEditorContextMenu and
 * spellcheck.addWord), so the spelling report can be injected; synthetic
 * text only. Needs playwright-core with Chromium. Port CONTEXT_MENU_TEST_PORT (5237).
 * Run: node tests/context-menu-in-view-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';
import { EDITOR_EXPR } from './helpers/editor-surface.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.CONTEXT_MENU_TEST_PORT || 5237);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1000) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (CONTEXT_MENU_TEST_PORT)`); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
await context.addInitScript(() => {
  try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); } catch { /* storage */ }
});
// the desktop bridge's spelling part, installed once the app has booted as a browser (the boot calls the real bridge
// without guards): the editor subscribes when it mounts, the test reports a word, "Add to dictionary" is recorded;
// anything else asked of the bridge is a stub answering undefined
const fakeBridge = () => page.evaluate(() => {
  window.__spellAdded = [];
  const base = {
    onEditorContextMenu: (cb) => { window.__editorContextMenu = cb; return () => { window.__editorContextMenu = null; }; },
    spellcheck: { addWord: async (word) => { window.__spellAdded.push(word); return { ok: true }; } },
  };
  window.electronAPI = new Proxy(base, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => Promise.resolve(undefined) : undefined)) });
});
await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
await context.route('**/socket.io/**', (r) => r.abort());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { const m = String(e.message || e); if (!/Failed to fetch|\/api\//.test(m)) errors.push(m); });
const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); } };
const domClick = (locator) => locator.first().evaluate((el) => el.click());
// the rail's button, or the ... menu's row when the rail overflows (a short window)
const goTo = async (label) => { const b = page.locator(`nav.w-16 button[aria-label="${label}"]`); if (await b.count()) { await domClick(b); } else { await domClick(page.locator('[data-testid="rail-more"]')); await sleep(250); await domClick(page.locator('[data-testid="rail-more-menu"] button', { hasText: label })); } await page.mouse.move(700, 450); await sleep(600); };
const setAids = (patch) => page.evaluate(async (patch) => { const m = await import('/src/utils/readingAids.js'); m.saveReadingAids(patch); }, patch);
const newDocument = async () => {
  const nd = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'New Document' && el.offsetParent); if (!b) return false; b.click(); return true; });
  await page.locator('.sc-editor-cm .cm-content').waitFor({ timeout: 15000 }); await sleep(300);
  return nd;
};
const setText = (text) => page.evaluate(([expr, value]) => { const s = eval(expr); s.focus(); s.value = value; s.setSelectionRange(0, 0); }, [EDITOR_EXPR, text]);
// the centre of the word "wrod" on the last line fully visible in the editor (after scrolling to the end)
const lastVisibleWord = () => page.evaluate(() => {
  const scroller = document.querySelector('.sc-editor-cm .cm-scroller');
  scroller.scrollTop = scroller.scrollHeight;
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const box = scroller.getBoundingClientRect();
    const lines = Array.from(document.querySelectorAll('.sc-editor-cm .cm-line')).filter((l) => { const r = l.getBoundingClientRect(); return r.height > 0 && r.bottom <= box.bottom + 1 && r.top >= box.top - 1; });
    const line = lines[lines.length - 1];
    if (!line) return resolve(null);
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const i = node.textContent.indexOf('wrod');
      if (i >= 0) { const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 4); const r = range.getBoundingClientRect(); return resolve({ x: r.left + r.width / 2, y: r.top + r.height / 2, line: line.textContent.trim(), lineBottom: line.getBoundingClientRect().bottom, vh: window.innerHeight }); }
    }
    resolve(null);
  })));
});
const MENU = '[data-testid="editor-context-menu"]';
const menuBox = (sel) => page.evaluate((sel) => {
  const m = document.querySelector(sel);
  if (!m) return null;
  const r = m.getBoundingClientRect();
  const items = Array.from(m.querySelectorAll('[role="menuitem"]').length ? m.querySelectorAll('[role="menuitem"]') : m.querySelectorAll(':scope > button')).map((b) => b.textContent.trim());   // the sidebars' own menus are plain buttons
  const add = Array.from(m.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent.trim() === 'Add to dictionary');
  const ar = add && add.getBoundingClientRect();
  return {
    role: m.getAttribute('role'), testId: m.getAttribute('data-testid'), label: m.getAttribute('aria-label'),
    left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, vw: window.innerWidth, vh: window.innerHeight,
    inside: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    placement: m.dataset.placement, maxHeight: m.style.maxHeight, overflowY: getComputedStyle(m).overflowY, scrolls: m.scrollHeight > m.clientHeight + 1,
    items,
    add: add ? { top: ar.top, bottom: ar.bottom, visibleInMenu: ar.top >= r.top - 1 && ar.bottom <= r.bottom + 1, inside: ar.top >= 0 && ar.bottom <= window.innerHeight } : null,
  };
}, sel);
const report = (word, x, y) => page.evaluate(([word, x, y]) => { if (typeof window.__editorContextMenu !== 'function') return false; window.__editorContextMenu({ misspelledWord: word, suggestions: ['word', 'wood', 'rod', 'ward', 'wordy', 'wad'], x, y }); return true; }, [word, x, y]);
const text = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the long document has a wrod in it that the checker would flag.`).join('\n');

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await dismiss();
  await fakeBridge();
  check('New Document', await newDocument());
  check('the desktop bridge is faked: the editor subscribed to the spelling report when it mounted', await page.evaluate(() => typeof window.__editorContextMenu === 'function'));
  await setText(text); await sleep(400);

  // ---- a word on the last visible line, near the bottom of the window
  let w = await lastVisibleWord();
  check(`the editor shows the long text; the last fully visible line ("${w && w.line.slice(0, 12)}...") ends ${w && Math.round(w.vh - w.lineBottom)} px above the window's bottom`, !!w && w.vh - w.lineBottom < 120, JSON.stringify(w));
  await page.mouse.click(w.x, w.y, { button: 'right' }); await sleep(350);
  let m = await menuBox(MENU);
  check('a right-click there opens the editor\'s menu inside the window (before the spelling report)', m && m.inside, JSON.stringify(m));
  check('the spelling report arrives (the fake IPC, the word the menu was opened on)', await report('wrod', w.x, w.y));
  await sleep(400);
  m = await menuBox(MENU);
  check(`...the menu grows by six suggestions and "Add to dictionary" (${m && m.items.length} items) and stays fully inside the window - flipped above the pointer`, m && m.inside && m.items.includes('Add to dictionary') && m.items.filter((t) => ['word', 'wood', 'rod', 'ward', 'wordy', 'wad'].includes(t)).length === 6 && m.placement === 'above' && m.bottom <= w.y, JSON.stringify(m));
  check('"Add to dictionary" is visible, inside the menu and the window', m && m.add && m.add.visibleInMenu && m.add.inside, JSON.stringify(m && m.add));
  await page.getByRole('menuitem', { name: 'Add to dictionary' }).click(); await sleep(300);
  const added = await page.evaluate(() => window.__spellAdded.slice());
  check('...and clickable: the word goes to the dictionary over the bridge and the menu closes', added.join() === 'wrod' && !(await page.locator(MENU).count()), JSON.stringify(added));

  // ---- near the right edge
  const edge = await page.evaluate(() => { const s = document.querySelector('.sc-editor-cm .cm-scroller'); s.scrollTop = 0; const r = document.querySelector('.sc-editor-cm .cm-content').getBoundingClientRect(); return { x: Math.min(window.innerWidth - 12, r.right - 6), y: r.top + 20, vw: window.innerWidth }; });
  await sleep(200);
  await page.mouse.click(edge.x, edge.y, { button: 'right' }); await sleep(350);
  m = await menuBox(MENU);
  check(`near the right edge (x ${Math.round(edge.x)} of ${edge.vw}): the menu flips to the left of the pointer, fully inside`, m && m.inside && m.right <= edge.x + 1 && m.left < edge.x, JSON.stringify(m));
  await page.keyboard.press('Escape'); await sleep(200);

  // ---- 200 % with the interface scaled, in a short window: fits or scrolls inside; the keyboard reaches the last item
  await setAids({ textScale: 200, scaleChrome: true }); await page.setViewportSize({ width: 1400, height: 520 }); await sleep(800);
  w = await lastVisibleWord();
  check('200 %, 1400x520: a word on the last visible line is found', !!w, JSON.stringify(w));
  await page.mouse.click(w.x, w.y, { button: 'right' }); await sleep(350);
  await report('wrod', w.x, w.y); await sleep(450);
  m = await menuBox(MENU);
  check(`200 %, 1400x520: the grown menu (${m && m.items.length} items, ${m && Math.round(m.height)} px of ${m && m.vh}) is inside the window${m && m.scrolls ? ', capped and scrolling inside' : ''}`, m && m.inside && (m.scrolls ? m.overflowY === 'auto' && m.maxHeight !== '' : true), JSON.stringify(m));
  const n = m ? m.items.length : 0;
  // the keyboard in the menu: a right-click in the editor leaves the focus there (the editor's own rule), so the menu
  // takes it first - Tab / the menu's focus() - and Arrow Down walks the items from the top
  await page.evaluate((sel) => document.querySelector(sel).focus(), MENU);
  const enabled = await page.evaluate((sel) => document.querySelectorAll(`${sel} [role="menuitem"]:not([disabled])`).length, MENU);
  for (let i = 0; i < enabled; i++) await page.keyboard.press('ArrowDown');   // from the menu itself: the first press lands on the first item, the last on the last
  await sleep(200);
  const last = await page.evaluate((sel) => { const menu = document.querySelector(sel); const items = Array.from(menu.querySelectorAll('[role="menuitem"]:not([disabled])')); const a = document.activeElement; const r = a.getBoundingClientRect(); const mr = menu.getBoundingClientRect(); return { isLast: a === items[items.length - 1], enabled: items.length, text: a.textContent.trim(), inView: r.top >= mr.top - 1 && r.bottom <= mr.bottom + 1 && r.bottom <= window.innerHeight }; }, MENU);
  check(`Arrow Down ${enabled} times (of ${n} items) reaches the last enabled item ("${last.text}", ${last.enabled} enabled), scrolled into view inside the menu and the window`, last.isLast && last.inView, JSON.stringify(last));
  await page.keyboard.press('Escape'); await sleep(200);
  await setAids({ textScale: 100, scaleChrome: false }); await sleep(400);

  // ---- the Documents sidebar's context menu on the last visible row of a long list (still the short window)
  // a long list: 25 documents in the local store (synthetic titles), the page reloaded to list them, "General" unfolded
  await page.evaluate(async () => { const m = await import('/src/utils/documents.js'); for (let i = 1; i <= 25; i++) await m.createDocument({ title: `Sample note ${String(i).padStart(2, '0')}`, content: `Sample ${i}`, category: 'General' }); });
  await goTo('Tasks'); await goTo('Documents'); await sleep(600);
  const general = page.locator('[data-side="left"] button', { hasText: /^General/ }).first();
  if (await general.count()) { await general.click(); await sleep(400); }
  // the last document row fully inside the window (the list runs on below it)
  const rowsL = page.locator('[data-side="left"] .sc-row', { hasText: /Sample note/ });
  const rowCount = await rowsL.count();
  const vh = (await page.viewportSize()).height;
  let row = { count: rowCount };
  for (let i = rowCount - 1; i >= 0; i--) { const b = await rowsL.nth(i).boundingBox(); if (b && b.height > 0 && b.y >= 0 && b.y + b.height <= vh) { row = { count: rowCount, index: i, x: b.x + b.width / 2, y: b.y + b.height / 2, bottomGap: vh - (b.y + b.height) }; break; } }
  check(`the sidebar lists the documents (${row.count} rows, the last fully visible one #${row.index}); it sits ${row.bottomGap != null ? Math.round(row.bottomGap) : '?'} px above the window's bottom`, row.count >= 6 && row.bottomGap < 200, JSON.stringify(row));
  await rowsL.nth(row.index).click({ button: 'right' }); await sleep(400);
  m = await menuBox('.sc-context-menu');
  const menusNow = await page.evaluate(([x, y]) => ({ under: (() => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}.${String(e.className).slice(0, 60)}` : null; })(), menus: Array.from(document.querySelectorAll('[role="menu"], .sc-context-menu')).map((el) => { const r = el.getBoundingClientRect(); return `${el.tagName}.${String(el.className).slice(0, 40)} role=${el.getAttribute('role')} testid=${el.getAttribute('data-testid')} ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)} items=${el.querySelectorAll('[role="menuitem"]').length} placement=${el.dataset.placement} style=${el.style.cssText}`; }), mobile: document.documentElement.getAttribute('data-mobile'), vh: window.innerHeight }), [row.x, row.y]);
  check(`the row's context menu (${m && m.items.length} items, ${m && Math.round(m.height)} px in a ${m && m.vh} px window) stays fully inside the window: ${m && m.placement === 'above' ? 'flipped above the pointer' : 'on the roomier side, capped and scrolling inside'}`, m && m.inside && m.items.length >= 4 && (m.placement === 'above' || (m.scrolls && m.overflowY === 'auto')), JSON.stringify({ m, menusNow }));
  await page.keyboard.press('Escape'); await sleep(200);

  // ---- a dropdown near the bottom: the rail's ... menu in the short window
  const more = page.locator('[data-testid="rail-more"]');
  check('the short window overflows the rail: a ... button', (await more.count()) === 1);
  await domClick(more); await sleep(350);
  const rail = await page.evaluate(() => { const m = document.querySelector('[data-testid="rail-more-menu"]'); if (!m) return null; const r = m.getBoundingClientRect(); const b = document.querySelector('[data-testid="rail-more"]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: window.innerHeight, inside: r.top >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth, besideRail: r.left >= b.right, items: m.querySelectorAll('[role="menuitem"], button').length, scrolls: m.scrollHeight > m.clientHeight + 1 }; });
  check(`the ... menu (${rail && rail.items} entries) opens beside the rail, inside the window${rail && rail.scrolls ? ' (scrolling inside)' : ''}`, rail && rail.inside && rail.besideRail, JSON.stringify(rail));
  await page.keyboard.press('Escape'); await sleep(200);
  await page.setViewportSize({ width: 1360, height: 900 }); await sleep(300);
  await goTo('Documents');
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 14).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
