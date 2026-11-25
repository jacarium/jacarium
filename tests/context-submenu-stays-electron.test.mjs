/**
 * A context menu with a submenu stays where it is when the submenu opens,
 * in the REAL Electron app (Playwright _electron through
 * tests/helpers/electron-app.mjs: a throwaway userData directory, the mock
 * keychain) - the renderer the user saw the editor's menu jump up the window
 * in when "Search In" was hovered near the bottom of a long document. The
 * same assertions as tests/context-submenu-stays-live.test.mjs, for a
 * right-click near the bottom and near the top of the editor:
 *
 *   - hovering "Search In" opens the submenu and the main menu's rectangle
 *     is the same within 1 px, right away and once settled;
 *   - the submenu is fully inside the window;
 *   - the submenu is beside the "Search In" row, sharing its height, not
 *     over it.
 *
 * Skips cleanly without playwright-core, with SKIP_ELECTRON_TESTS, or when
 * the app cannot start. Synthetic text and template names only.
 */
import { launchElectronDocumentsApp } from './helpers/electron-app.mjs';
import { createNewDocument, setEditorContent, sleep } from './helpers/live-documents-app.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail !== '' ? ' | ' + String(detail).slice(0, 700) : ''}`); if (!ok) failed++; };
const app = await launchElectronDocumentsApp({ profilePrefix: 'context-submenu-electron-' });
if (app.skip) { console.log(`SKIP: ${app.skip}`); process.exit(0); }

const MENU = '[data-testid="editor-context-menu"]';
const ROW = '[data-testid="selection-search-in"]';
const SUB = '[data-testid="selection-search-in-submenu"]';
const TEMPLATES = [
  ['Access', 'Example Access One'], ['Access', 'Example Access Two'],
  ['Documentation', 'Example Docs 1.0'], ['Documentation', 'Example Docs 2.0'], ['Documentation', 'Example Docs 3.0'], ['Documentation', 'Example Docs 4.0'],
];
const DOC = '# Long sample\n\n' + Array.from({ length: 90 }, (_, i) => `Line ${i + 1}: alpha bravo charlie delta echo foxtrot golf hotel india juliet.`).join('\n\n') + '\n';
const rectOf = (sel) => app.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
const same = (a, b) => !!a && !!b && ['left', 'top', 'right', 'bottom'].every((k) => Math.abs(a[k] - b[k]) <= 1);
const mouseMove = (x, y) => app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });

async function scenario(where) {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await mouseMove(5, 5);
  await sleep(200);
  // a word on a visible line near that edge of the editor is selected, and the menu opened on it
  const at = await app.evaluate(`(() => {
    const surface = document.querySelector('.sc-editor-cm').editorSurface;
    const box = surface.view.scrollDOM.getBoundingClientRect();
    const y = ${JSON.stringify(where)} === 'bottom' ? Math.min(box.bottom, window.innerHeight) - 40 : box.top + 30;
    let pos = surface.view.posAtCoords({ x: box.left + 140, y });
    const text = surface.value;
    while (pos > 0 && !/\\w/.test(text[pos])) pos--;
    let from = pos; let to = pos;
    while (from > 0 && /\\w/.test(text[from - 1])) from--;
    while (to < text.length && /\\w/.test(text[to])) to++;
    surface.focus(); surface.setSelectionRange(from, to, 'none', { scrollIntoView: false });
    const c = surface.view.coordsAtPos(Math.floor((from + to) / 2));
    const p = { x: Math.round(c.left), y: Math.round((c.top + c.bottom) / 2), word: text.slice(from, to), viewport: { width: window.innerWidth, height: window.innerHeight } };
    document.querySelector('.sc-editor-cm .cm-content').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: p.x, clientY: p.y, view: window }));
    return p;
  })()`);
  await app.waitFor(`!!document.querySelector(${JSON.stringify(MENU)})`, 4000);
  await sleep(400);
  const tag = `near the ${where}`;
  const before = await rectOf(MENU);
  const row0 = await rectOf(ROW);
  const vp = at.viewport;
  const inside = (r) => !!r && r.left >= 0 && r.top >= 0 && r.right <= vp.width && r.bottom <= vp.height;
  check(`${tag}: the menu opens inside the window with the Search In row (a selection: "${at.word}")`, inside(before) && !!row0, JSON.stringify({ before, row0, at }));
  if (!row0) return;
  await mouseMove(Math.round(row0.left + 40), Math.round((row0.top + row0.bottom) / 2 - 2));
  await mouseMove(Math.round(row0.left + 44), Math.round((row0.top + row0.bottom) / 2));
  await app.waitFor(`!!document.querySelector(${JSON.stringify(SUB)})`, 3000);
  const soon = await rectOf(MENU);
  await sleep(500);
  const after = await rectOf(MENU);
  const sub = await rectOf(SUB);
  const row = await rectOf(ROW);
  check(`${tag}: hovering Search In opens the submenu`, !!sub, 'no submenu');
  check(`${tag}: the main menu did not move or resize (within 1 px), right away and once settled`, same(before, soon) && same(before, after), JSON.stringify({ before, soon, after }));
  check(`${tag}: the submenu is fully inside the window`, inside(sub), JSON.stringify({ sub, vp }));
  check(`${tag}: the submenu is adjacent to the Search In row (beside it, sharing its height, not over it)`, !!sub && !!row && (Math.abs(sub.left - row.right) <= 2 || Math.abs(sub.right - row.left) <= 2) && sub.top < row.bottom && sub.bottom > row.top, JSON.stringify({ sub, row }));
  const names = await app.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(SUB + ' [role="menuitem"]')})).map((b) => b.textContent.trim()).join('|')`);
  check(`${tag}: the submenu lists the templates`, names === TEMPLATES.map((t) => t[1]).join('|'), names);
}

try {
  check('the Electron renderer shows the Documents page', await createNewDocument(app) && await app.waitFor(`!!(document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface)`, 10000));
  // the search templates, written to the app's own database; the page reads them when it loads
  const seeded = await app.evaluate(`(async () => {
    const names = (await indexedDB.databases()).map((d) => d.name);
    for (const name of names) {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (!db.objectStoreNames.contains('engineTemplates')) { db.close(); continue; }
      await new Promise((res, rej) => {
        const tx = db.transaction('engineTemplates', 'readwrite');
        const store = tx.objectStore('engineTemplates');
        store.clear();
        for (const [category, name2] of ${JSON.stringify(TEMPLATES)}) store.add({ name: name2, category, urlTemplate: 'https://search.example.com/?q={query}', description: '' });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
      return name;
    }
    return null;
  })()`);
  check('the search templates are in the app\'s database', !!seeded, String(seeded));
  await app.page.reload({ waitUntil: 'load' });
  await sleep(2500);
  await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /^Got it!$/.test(x.textContent.trim())); if (b) b.click(); return true; })()`);
  if (!(await app.evaluate(`!!(document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface)`))) await createNewDocument(app);
  check('the editor is back after the reload', !!(await app.waitFor(`!!(document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface)`, 10000)));
  await setEditorContent(app, DOC);
  await sleep(600);
  await scenario('bottom');
  await scenario('top');
  check('no renderer error', app.errors.length === 0, app.errors.join(' || '));
} catch (e) {
  check('context submenu in Electron', false, e.stack || String(e));
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
