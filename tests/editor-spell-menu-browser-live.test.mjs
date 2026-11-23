#!/usr/bin/env node
/**
 * Spelling suggestions in a browser: the Documents editor's right-click menu
 * is ours, and a page cannot read the browser's spell checker - so in a
 * browser Shift + right-click is left to the browser (its own menu, with its
 * suggestions), and our menu says so while spell checking is on. Run in
 * Chromium, WebKit AND Firefox (Playwright, against the Vite dev server, no
 * backend):
 *
 *   - a plain right-click in the editor opens our menu and the event is
 *     defaultPrevented (the browser's menu stays shut); with spell checking
 *     on its last row is the hint "Spelling suggestions: Shift + right-click"
 *     (the shift sign on a Mac), a disabled menu item, not a button to press;
 *   - Shift + right-click: the contextmenu event is NOT defaultPrevented and
 *     our menu is not rendered - the browser shows its own. (Whether the
 *     native menu really appears cannot be seen from a page or from
 *     Playwright; what is asserted is that nothing of ours stands in its way.)
 *     A menu of ours that was open closes;
 *   - the press of that Shift + right-click does not extend the selection
 *     from the old caret (Shift + click means "extend" to a browser; its menu
 *     would then be about that range, with no suggestions): with the caret at
 *     the end of the line, the selection afterwards is the word under the
 *     pointer (a Mac's browsers select it as their menu opens) or a caret
 *     inside it; a press inside an existing selection keeps that selection;
 *     in the desktop app's path the press is not taken;
 *   - Firefox keeps Shift + right-click for its own menu and, by default,
 *     does not send the page a contextmenu event for it at all: no event is
 *     accepted there, a prevented one is not;
 *   - the hint names the key as the platform writes it: the shift sign on a
 *     Mac, "Shift" on Linux and Windows (checked with the platform faked);
 *   - every other use of Shift is as before: only the RIGHT button's press is
 *     looked at - Shift + left-click extends the selection from the caret to
 *     the click exactly, Shift + arrow keys and Shift + drag select;
 *   - Ctrl + click, the Mac's other context click, behaves as the right-click
 *     it is: ours without Shift, the browser's with it - asserted when the
 *     engine turns it into a contextmenu event under automation;
 *   - spell checking switched off: our menu, no hint;
 *   - opening our menu reads the clipboard only where that shows nothing (the
 *     desktop app; a browser that already granted the permission): Safari and
 *     Firefox answer a page's clipboard read with a "Paste" button of their
 *     own at the pointer, which would stand where the menu is;
 *   - the desktop app's path (electronAPI.onEditorContextMenu present): no
 *     hint, and the page leaves the event alone as before - there the main
 *     process suppresses the native menu and sends the suggestions - for a
 *     plain and for a Shift + right-click alike: our menu both times.
 *
 * Needs playwright-core with Chromium, WebKit and Firefox (an engine that is not
 * installed is SKIPPED by name). Port SPELL_MENU_TEST_PORT (5348).
 * SPELL_MENU_ENGINES=chromium,webkit,firefox picks the engines.
 * Run: node tests/editor-spell-menu-browser-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.SPELL_MENU_TEST_PORT || 5348);
const ENGINES = (process.env.SPELL_MENU_ENGINES || 'chromium,webkit,firefox').split(',').map((s) => s.trim()).filter(Boolean);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail !== '' ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (SPELL_MENU_TEST_PORT)`); process.exit(0); }
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
const HINT = '[data-testid="spell-browser-hint"]';

async function open(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General'])); } catch { /* no storage */ } });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await page.evaluate(async () => {
    const { db } = await import('/src/db/database.js');
    await db.documents.clear();
    const id = await db.documents.add({ title: 'Spelling sample', content: '# Spelling sample\n\nThis sentense has a mispelled word in it.\n\nA second paragraph of plain text.\n', category: 'General', stableId: 'sid-spell', createdAt: new Date(), updatedAt: new Date() });
    localStorage.setItem('documentOpenTabs', JSON.stringify([{ id, title: 'Spelling sample' }]));
    localStorage.setItem('currentDocumentId', JSON.stringify(id));
    localStorage.removeItem('documentsSpellcheck');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.sc-editor-cm .cm-content', { timeout: 60000 });
  await sleep(1200);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(250); }
  // every contextmenu event, as the page leaves it: read on window in the bubble phase, after the app's handlers
  await page.evaluate(() => {
    window.__menus = [];
    window.__presses = [];
    window.addEventListener('mousedown', (e) => { window.__presses.push({ button: e.button, shift: e.shiftKey, prevented: e.defaultPrevented }); });
    window.addEventListener('contextmenu', (e) => { window.__menus.push({ shift: e.shiftKey, ctrl: e.ctrlKey, button: e.button, prevented: e.defaultPrevented, inEditor: !!(e.target && e.target.closest && e.target.closest('.sc-editor-cm')) }); });
  });
  // ...and every clipboard read the page asks for (Safari and Firefox answer one with their own "Paste" button)
  await page.evaluate(() => {
    window.__reads = 0;
    const clip = navigator.clipboard;
    if (clip && typeof clip.readText === 'function') { const real = clip.readText.bind(clip); clip.readText = (...a) => { window.__reads++; return real(...a); }; }
  });
  return { context, page, errors };
}
// a point on the misspelled word of the editor's third line
const wordPoint = (page) => page.evaluate(() => {
  const lines = Array.from(document.querySelectorAll('.sc-editor-cm .cm-line'));
  const line = lines.find((l) => /sentense/.test(l.textContent));
  const node = Array.from(line.childNodes).find((n) => n.nodeType === 3 && /sentense/.test(n.textContent)) || line.firstChild;
  const range = document.createRange();
  const at = node.textContent.indexOf('sentense');
  range.setStart(node, at + 2); range.setEnd(node, at + 6);
  const r = range.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), spellcheck: document.querySelector('.sc-editor-cm .cm-content').getAttribute('spellcheck') };
});
const menuState = (page) => page.evaluate(([menu, hint]) => {
  const m = document.querySelector(menu);
  const h = m && m.querySelector(hint);
  return { open: !!m, items: m ? Array.from(m.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent.trim()) : [], hint: h ? { text: h.textContent.trim(), disabled: h.disabled === true, role: h.getAttribute('role'), last: m.querySelectorAll('[role="menuitem"]')[m.querySelectorAll('[role="menuitem"]').length - 1] === h } : null };
}, [MENU, HINT]);
const events = async (page) => { const list = await page.evaluate(() => { const l = window.__menus.slice(); window.__menus.length = 0; return l; }); return list; };
const selection = (page) => page.evaluate(() => { const s = document.querySelector('.sc-editor-cm').editorSurface; return { from: s.selectionStart, to: s.selectionEnd, text: s.value.slice(s.selectionStart, s.selectionEnd), focused: s.view.hasFocus }; });
const setSelection = async (page, from, to) => { await page.evaluate(([a, b]) => { const s = document.querySelector('.sc-editor-cm').editorSurface; s.focus(); s.setSelectionRange(a, b); }, [from, to]); await sleep(200); };
const closeMenu = async (page) => { await page.keyboard.press('Escape').catch(() => {}); await sleep(150); };
async function contextClick(page, at, { shift = false, ctrlClick = false } = {}) {
  await events(page);
  await page.evaluate(() => { window.__reads = 0; window.__presses.length = 0; });
  if (shift) await page.keyboard.down('Shift');
  if (ctrlClick) await page.keyboard.down('Control');
  await page.mouse.click(at.x, at.y, { button: ctrlClick ? 'left' : 'right' });
  if (ctrlClick) await page.keyboard.up('Control');
  if (shift) await page.keyboard.up('Shift');
  await sleep(350);
  return { fired: await events(page), menu: await menuState(page), reads: await page.evaluate(() => window.__reads), presses: await page.evaluate(() => window.__presses.slice()), selection: await selection(page) };
}

async function runEngine(engine, browser) {
  const tag = engine;
  const { context, page, errors } = await open(browser);
  try {
    const at = await wordPoint(page);
    const mac = await page.evaluate(async () => (await import('/src/utils/shortcuts.js')).isMac());
    const expectedHint = `Spelling suggestions: ${mac ? '⇧' : 'Shift'} + right-click`;
    check(`${tag}: a browser (no electronAPI), the editor has spell checking on`, at.spellcheck === 'true' && await page.evaluate(() => typeof window.electronAPI === 'undefined'), JSON.stringify(at));

    // ---- a plain right-click: ours, with the hint ----------------------------------------------------
    let r = await contextClick(page, at);
    check(`${tag}: a plain right-click fires one contextmenu in the editor and the page prevents the browser's menu`, r.fired.length === 1 && r.fired[0].inEditor && r.fired[0].prevented === true && r.fired[0].shift === false, JSON.stringify(r.fired));
    check(`${tag}: ...and opens our menu (Paste), whose last row is the hint, a disabled menu item with plain words`, r.menu.open && r.menu.items.some((i) => i.startsWith('Paste')) && !!r.menu.hint && r.menu.hint.text === expectedHint && r.menu.hint.disabled && r.menu.hint.role === 'menuitem' && r.menu.hint.last
      && !/[<`]/.test(r.menu.hint.text), JSON.stringify(r.menu));
    check(`${tag}: opening our menu does not read the clipboard here (no permission granted: a read would bring up the browser's own Paste button or prompt)`, r.reads === 0, r.reads);
    const before = await page.evaluate(() => document.querySelector('.sc-editor-cm').editorSurface.value);
    await page.click(HINT, { force: true }).catch(() => {});
    await sleep(200);
    check(`${tag}: the hint does nothing when clicked (the text is unchanged)`, (await page.evaluate(() => document.querySelector('.sc-editor-cm').editorSurface.value)) === before);
    await closeMenu(page);
    check(`${tag}: Escape closes our menu`, !(await menuState(page)).open);

    // ---- Shift + right-click: the browser's ---------------------------------------------------------------
    r = await contextClick(page, at, { shift: true });
    // (Firefox keeps Shift + right-click to itself: by default the page gets no contextmenu event at all)
    const left = (fired) => (engine === 'firefox' || fired.length >= 1);
    if (engine === 'firefox') console.log(`NOTE (${tag}): Shift + right-click sent the page ${r.fired.length} contextmenu event(s)`);
    check(`${tag}: Shift + right-click fires a contextmenu with shiftKey that the page does NOT prevent`, left(r.fired) && r.fired.every((e) => e.shift === true && e.prevented === false && e.inEditor), JSON.stringify(r.fired));
    check(`${tag}: ...and our menu is not rendered, the clipboard not read (nothing of ours stands in the way of the browser's own)`, r.menu.open === false && r.reads === 0, JSON.stringify(r));
    // with ours open, a Shift + right-click closes it and still leaves the event alone
    await contextClick(page, at);
    r = await contextClick(page, at, { shift: true });
    check(`${tag}: with our menu open, Shift + right-click closes it and is left to the browser`, r.menu.open === false && left(r.fired) && r.fired.every((e) => e.prevented === false), JSON.stringify(r));
    await closeMenu(page);

    // ---- the press does not extend the selection from the old caret ---------------------------------------------------------
    const text = await page.evaluate(() => document.querySelector('.sc-editor-cm').editorSurface.value);
    const word = { from: text.indexOf('sentense'), to: text.indexOf('sentense') + 'sentense'.length };
    const lineEnd = text.indexOf('in it.') + 'in it.'.length;
    const onWord = (sel) => (sel.from === word.from && sel.to === word.to) || (sel.from === sel.to && sel.from > word.from && sel.from < word.to);
    await setSelection(page, lineEnd, lineEnd);
    r = await contextClick(page, at, { shift: true });
    check(`${tag}: with the caret at the end of the line, Shift + right-click on the misspelled word leaves the selection on that word (the word, or a caret inside it) - never a range from the old caret`,
      onWord(r.selection) && r.menu.open === false, JSON.stringify({ selection: r.selection, word, lineEnd }));
    check(`${tag}: ...the press was taken by the page (no native "extend the selection") and the editor has the focus`, r.presses.length === 1 && r.presses[0].prevented === true && r.presses[0].shift === true && r.selection.focused, JSON.stringify(r.presses));
    console.log(`NOTE (${tag}): after Shift + right-click the selection is ${r.selection.from === r.selection.to ? 'a caret inside the word' : `the word "${r.selection.text}"`}`);
    await closeMenu(page);
    // from the start of the document too (an extension backwards would be the other way round)
    await setSelection(page, 0, 0);
    r = await contextClick(page, at, { shift: true });
    check(`${tag}: the same with the caret before the word (the start of the document)`, onWord(r.selection), JSON.stringify(r.selection));
    await closeMenu(page);
    // a press inside an existing selection keeps it, as a right-click does
    const inside = { from: text.indexOf('This'), to: text.indexOf('has a') };
    await setSelection(page, inside.from, inside.to);
    r = await contextClick(page, at, { shift: true });
    check(`${tag}: Shift + right-click inside an existing selection keeps that selection`, r.selection.from === inside.from && r.selection.to === inside.to, JSON.stringify({ selection: r.selection, inside }));
    await closeMenu(page);
    // a plain right-click is not touched: the press is the browser's and CodeMirror's as before
    await setSelection(page, lineEnd, lineEnd);
    r = await contextClick(page, at);
    check(`${tag}: a plain right-click's press is not taken, and nothing is extended from the old caret`, r.presses.length === 1 && r.presses[0].prevented === false && r.menu.open && !(r.selection.to === lineEnd && r.selection.from < lineEnd), JSON.stringify({ presses: r.presses, selection: r.selection }));
    await closeMenu(page);

    // ---- Shift keeps selecting: Shift + LEFT-click extends from the caret exactly as before ----------------------------------
    await setSelection(page, lineEnd, lineEnd);
    await events(page); await page.evaluate(() => { window.__presses.length = 0; });
    const clickPos = await page.evaluate(([x, y]) => document.querySelector('.sc-editor-cm').editorSurface.view.posAtCoords({ x, y }), [at.x, at.y]);
    await page.keyboard.down('Shift'); await page.mouse.click(at.x, at.y, { button: 'left' }); await page.keyboard.up('Shift'); await sleep(300);
    let sel = await selection(page);
    let presses = await page.evaluate(() => window.__presses.slice());
    check(`${tag}: Shift + left-click extends the selection from the caret to the click, exactly (CodeMirror's own selection, no menu)`, sel.from === clickPos && sel.to === lineEnd && presses.length === 1 && presses[0].button === 0
      && !(await menuState(page)).open && (await events(page)).length === 0, JSON.stringify({ sel, clickPos, lineEnd, presses }));
    // ...and backwards, and with the keys
    await setSelection(page, 0, 0);
    await page.keyboard.down('Shift'); await page.mouse.click(at.x, at.y, { button: 'left' }); await page.keyboard.up('Shift'); await sleep(300);
    sel = await selection(page);
    check(`${tag}: ...from a caret before the click as well`, sel.from === 0 && sel.to === clickPos, JSON.stringify({ sel, clickPos }));
    await setSelection(page, word.from, word.from);
    await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight'); await sleep(200);
    sel = await selection(page);
    check(`${tag}: Shift + arrow keys select as before`, sel.from === word.from && sel.to === word.from + 2, JSON.stringify(sel));
    // Shift + drag with the left button: from the caret to where the drag ends
    await setSelection(page, lineEnd, lineEnd);
    await page.keyboard.down('Shift'); await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x - 20, at.y, { steps: 4 }); await page.mouse.up(); await page.keyboard.up('Shift'); await sleep(300);
    sel = await selection(page);
    check(`${tag}: Shift + drag selects from the old caret as before`, sel.to === lineEnd && sel.from < clickPos && sel.from >= word.from - 6, JSON.stringify({ sel, clickPos }));
    await page.mouse.click(at.x, at.y); await sleep(200);

    // ---- Ctrl + click, the Mac's other context click ----------------------------------------------------------
    r = await contextClick(page, at, { ctrlClick: true });
    if (r.fired.length) {
      check(`${tag}: Ctrl + click arrives as a context click and is ours: prevented, our menu with the hint`, r.fired.every((e) => e.prevented === true) && r.menu.open && !!r.menu.hint, JSON.stringify(r));
      await closeMenu(page);
      r = await contextClick(page, at, { shift: true, ctrlClick: true });
      r = await contextClick(page, at, { shift: true, ctrlClick: true });
      check(`${tag}: ...and its press, a LEFT button's, is not taken by the page (the left button is never looked at)`, r.presses.length === 1 && r.presses[0].button === 0 && r.presses[0].prevented === false, JSON.stringify(r.presses));
      check(`${tag}: Shift + Ctrl + click is left to the browser: not prevented, our menu not rendered`, left(r.fired) && r.fired.every((e) => e.shift === true && e.prevented === false) && r.menu.open === false, JSON.stringify(r));
    } else {
      console.log(`NOTE (${tag}): under automation this engine does not turn Ctrl + click into a contextmenu event - not asserted here (it is the same event as a right-click once the browser makes it one)`);
    }
    await closeMenu(page);

    // ---- spell checking off: no hint -----------------------------------------------------------------------------
    await page.evaluate(async () => { (await import('/src/utils/editorSurface.js')).setSpellcheckEnabled(false); });
    await sleep(300);
    r = await contextClick(page, at);
    check(`${tag}: with spell checking switched off the menu is ours, prevented, and has no hint`, (await wordPoint(page)).spellcheck === 'false' && r.menu.open && r.menu.hint === null && r.fired[0]?.prevented === true && r.menu.items.some((i) => i.startsWith('Paste')), JSON.stringify(r));
    await closeMenu(page);
    await page.evaluate(async () => { (await import('/src/utils/editorSurface.js')).setSpellcheckEnabled(true); });
    await sleep(300);
    r = await contextClick(page, at);
    check(`${tag}: switched on again, the hint is back`, r.menu.open && !!r.menu.hint, JSON.stringify(r.menu));
    await closeMenu(page);

    // ---- the desktop app's path ---------------------------------------------------------------------------------------
    await page.evaluate(() => { window.__realApi = window.electronAPI; window.electronAPI = { onEditorContextMenu: () => () => {} }; });
    r = await contextClick(page, at);
    check(`${tag}: desktop path (electronAPI.onEditorContextMenu present): our menu, NO hint, and the page leaves the event to the main process as before (it suppresses the native menu there)`,
      r.menu.open && r.menu.hint === null && r.menu.items.some((i) => i.startsWith('Paste')) && r.fired.length === 1 && r.fired[0].prevented === false, JSON.stringify(r));
    check(`${tag}: desktop path: the clipboard is asked as the menu opens, as before`, r.reads === 1, r.reads);
    await closeMenu(page);
    r = await contextClick(page, at, { shift: true });
    check(`${tag}: desktop path: Shift + right-click is no exception there - our menu again, no hint, and the press is not taken`, r.menu.open && r.menu.hint === null && r.presses.length === 1 && r.presses[0].prevented === false, JSON.stringify(r));
    await closeMenu(page);
    await page.evaluate(() => { window.electronAPI = window.__realApi; delete window.__realApi; });

    // ---- a browser that already granted the clipboard: asked as the menu opens (Paste can be greyed) -----------------
    if (engine === 'chromium') {
      await context.grantPermissions(['clipboard-read'], { origin: new URL(URL_).origin });
      r = await contextClick(page, at);
      check(`${tag}: with the clipboard permission granted, opening the menu reads the clipboard once`, r.menu.open && r.reads === 1, JSON.stringify(r));
      await closeMenu(page);
    }

    // ---- the rule itself (FloatingDraft.jsx applies it too; that component is not mounted anywhere) ---------------------------------------------------
    const rule = await page.evaluate(async () => {
      const m = await import('/src/utils/editorSurface.js');
      const desktop = { electronAPI: { onEditorContextMenu: () => {} } };
      return { browserShift: m.leavesMenuToBrowser({ shiftKey: true }, {}), browserPlain: m.leavesMenuToBrowser({ shiftKey: false }, {}), desktopShift: m.leavesMenuToBrowser({ shiftKey: true }, desktop),
        owns: [m.browserOwnsSpelling({}), m.browserOwnsSpelling(desktop), m.browserOwnsSpelling({ electronAPI: {} })], labels: [m.spellingHintLabel(true), m.spellingHintLabel(false)] };
    });
    check(`${tag}: leavesMenuToBrowser: only Shift, only in a browser; the label per platform`, rule.browserShift === true && rule.browserPlain === false && rule.desktopShift === false && rule.owns.join() === 'true,false,true'
      && rule.labels[0] === 'Spelling suggestions: ⇧ + right-click' && rule.labels[1] === 'Spelling suggestions: Shift + right-click', JSON.stringify(rule));
    // the press rule on a stand-in editor: what Firefox relies on too (it is all done on the press - no contextmenu event is needed)
    const press = await page.evaluate(async () => {
      const m = await import('/src/utils/editorSurface.js');
      const desktop = { electronAPI: { onEditorContextMenu: () => {} } };
      const run = (event, sel, win = {}) => {
        const surface = { selectionStart: sel[0], selectionEnd: sel[1], focused: 0, view: { posAtCoords: () => 12 }, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }, focus() { this.focused++; } };
        let prevented = false;
        const taken = m.takeBrowserMenuPress(surface, { ...event, clientX: 1, clientY: 1, preventDefault() { prevented = true; } }, { win });
        return `${taken}/${prevented}/${surface.selectionStart}-${surface.selectionEnd}/${surface.focused}`;
      };
      return {
        caretElsewhere: run({ button: 2, shiftKey: true }, [40, 40]),
        rangeElsewhere: run({ button: 2, shiftKey: true }, [20, 30]),
        insideRange: run({ button: 2, shiftKey: true }, [5, 20]),
        atRangeEdge: run({ button: 2, shiftKey: true }, [12, 20]),
        plainRight: run({ button: 2, shiftKey: false }, [40, 40]),
        shiftLeft: run({ button: 0, shiftKey: true }, [40, 40]),
        shiftCtrlLeft: run({ button: 0, shiftKey: true, ctrlKey: true }, [40, 40]),
        shiftMiddle: run({ button: 1, shiftKey: true }, [40, 40]),
        desktopShiftRight: run({ button: 2, shiftKey: true }, [40, 40], desktop),
      };
    });
    check(`${tag}: the press rule: Shift + right press outside the selection puts the caret at the pointer, inside it leaves it; any other press (plain right, any left or middle, the desktop app) is not touched`,
      press.caretElsewhere === 'true/true/12-12/1' && press.rangeElsewhere === 'true/true/12-12/1' && press.insideRange === 'true/true/5-20/1' && press.atRangeEdge === 'true/true/12-20/1'
      && [press.plainRight, press.shiftLeft, press.shiftCtrlLeft, press.shiftMiddle, press.desktopShiftRight].every((v) => v === 'false/false/40-40/0'), JSON.stringify(press));
    const labels = await page.evaluate(async () => {
      const m = await import('/src/utils/editorSurface.js');
      const fake = (platform, ua) => { Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => undefined }); Object.defineProperty(navigator, 'platform', { configurable: true, get: () => platform }); Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua }); };
      const out = {};
      fake('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'); out.linux = m.spellingHintLabel();
      fake('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'); out.win = m.spellingHintLabel();
      fake('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'); out.mac = m.spellingHintLabel();
      out.right = m.isRightPress({ button: 2 }); out.left = m.isRightPress({ button: 0, ctrlKey: true, shiftKey: true });
      return out;
    });
    check(`${tag}: the hint per platform: "Shift + right-click" on Linux and Windows, the shift sign on a Mac; only the right button counts as the press`, labels.linux === 'Spelling suggestions: Shift + right-click' && labels.win === labels.linux
      && labels.mac === 'Spelling suggestions: \u21e7 + right-click' && labels.right === true && labels.left === false, JSON.stringify(labels));
    check(`${tag}: no page error`, errors.length === 0, errors.join(' || '));
  } finally {
    await context.close();
  }
}

try {
  for (const [engine, browser] of Object.entries(browsers)) await runEngine(engine, browser);
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 5).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
