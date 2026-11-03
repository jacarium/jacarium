/**
 * The Documents editor's selection stays painted while its right-click
 * menu is open, in the REAL Electron app (Playwright _electron through
 * tests/helpers/electron-app.mjs, a throwaway userData directory): the
 * renderer the packaged app uses, the one the user saw the highlight
 * vanish in. The same checks as tests/editor-selection-visible-live.test.mjs:
 * the editor keeps its selection while the menu has the focus, the
 * selected line's pixels are those of the focused selection without the
 * menu, the keys move within the menu (ArrowDown goes from Cut to Copy,
 * Escape closes with the focus and the selection back in the editor), in
 * the light and the dark theme, with
 * screenshots in EDITOR_SELECTION_SHOTS_DIR (default: a temp dir); without
 * a selection the menu is Paste alone, with one Cut and Copy are there.
 *
 * Skips cleanly without playwright-core, with SKIP_ELECTRON_TESTS, or when
 * the app cannot start. Synthetic text only.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchElectronDocumentsApp } from './helpers/electron-app.mjs';
import { createNewDocument, setEditorContent, sleep } from './helpers/live-documents-app.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const app = await launchElectronDocumentsApp({ profilePrefix: 'editor-selection-electron-' });
if (app.skip) { console.log(`SKIP: ${app.skip}`); process.exit(0); }
const outDir = process.env.EDITOR_SELECTION_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'editor-selection-electron-shots-'));
mkdirSync(outDir, { recursive: true });
const { PNG } = await import('pngjs');

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const has = (sel) => app.evaluate(`!!${q(sel)}`);
const active = () => app.evaluate(`(() => { const a = document.activeElement; return a ? (a.getAttribute('data-testid') || a.tagName) : ''; })()`);
const selection = () => app.evaluate(`(() => { const ta = (document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface); return [ta.selectionStart, ta.selectionEnd]; })()`);
// the editor's focusable element (CodeMirror's content) has the focus
const editorFocused = () => app.evaluate(`document.activeElement === document.querySelector('.sc-editor-cm .cm-content')`);
const keyChord = async (key, code, vk) => {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(250);
};
const setTheme = async (theme) => { await app.evaluate(`document.documentElement.classList.${theme === 'dark' ? 'add' : 'remove'}('dark')`); await sleep(300); };
const select = (a, b) => app.evaluate(`(() => { const ta = (document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface); ta.focus(); ta.setSelectionRange(${a}, ${b}); return ta.value.slice(${a}, ${b}); })()`);
const openMenu = async () => {
  const b = await app.evaluate(`(() => { const r = document.querySelector('.sc-editor-cm .cm-content').getBoundingClientRect(); return [r.left + 60, r.top + 90]; })()`);
  await app.evaluate(`document.querySelector('.sc-editor-cm .cm-content').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${b[0]}, clientY: ${b[1]}, view: window })); true`);
  await app.waitFor(`!!document.querySelector('[data-testid="editor-context-menu"]')`, 3000);
  await sleep(300);
};
const lineClip = () => app.evaluate(`(() => { const r = document.querySelector('.sc-editor-cm .cm-content').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(Math.min(r.width, 420)), height: 32, scale: 1 }; })()`);
const linePixels = async () => { const clip = await lineClip(); const r = await app.send('Page.captureScreenshot', { format: 'png', clip }); return PNG.sync.read(Buffer.from(r.result.data, 'base64')).data; };
const differing = (a, b) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 4) { if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++; } return n; };
const shot = async (name) => { const f = path.join(outDir, `${name}.png`); const r = await app.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };

try {
  await app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; } .cm-cursor { display: none !important; }'; document.head.appendChild(s); })()`);
  check('the Electron renderer shows the Documents page', await createNewDocument(app) && await app.waitFor(`!!(document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface)`, 10000));
  await setEditorContent(app, 'alpha bravo charlie\n\n\n\n\n');
  for (const theme of ['light', 'dark']) {
    await setTheme(theme);
    await select(19, 19);
    const plain = await linePixels();
    check(`${theme}: "bravo" is selected`, (await select(6, 11)) === 'bravo');
    const selectedFocused = await linePixels();
    check(`${theme}: (the selection is painted while the editor is focused)`, differing(plain, selectedFocused) > 40, String(differing(plain, selectedFocused)));
    await openMenu();
    check(`${theme}: with the menu open its first item (Cut) has the focus and the editor's selection is the same`, (await active()) === 'selection-cut' && JSON.stringify(await selection()) === '[6,11]', `${await active()} ${JSON.stringify(await selection())}`);
    const withMenu = await linePixels();
    check(`${theme}: the selection is painted while the menu is open (the editor draws it from its state, focused or not), exactly as without the menu`, differing(selectedFocused, withMenu) < 10 && differing(plain, withMenu) > 40, `menu vs focused: ${differing(selectedFocused, withMenu)}, menu vs plain: ${differing(plain, withMenu)}`);
    const f = await shot(`editor-selection-menu-electron-${theme}`);
    check(`${theme}: the screenshot renders`, PNG.sync.read(readFileSync(f)).width > 0);
    await keyChord('ArrowDown', 'ArrowDown', 40);
    check(`${theme}: ArrowDown moves the focus from Cut to Copy, the selection untouched`, (await active()) === 'selection-copy' && JSON.stringify(await selection()) === '[6,11]', `${await active()} ${JSON.stringify(await selection())}`);
    await keyChord('Escape', 'Escape', 27);
    check(`${theme}: Escape closes the menu; the focus and the selection are back in the editor`, !(await has('[data-testid="editor-context-menu"]')) && (await editorFocused()) && JSON.stringify(await selection()) === '[6,11]', `${await active()} ${JSON.stringify(await selection())}`);
    const itemIds = () => app.evaluate(`Array.from(document.querySelectorAll('[data-testid="editor-context-menu"] [role="menuitem"]')).map((b) => b.getAttribute('data-testid')).join(',')`);
    await openMenu();
    check(`${theme}: with a selection Cut and Copy are there`, (await itemIds()).startsWith('selection-cut,selection-copy,selection-paste'), await itemIds());
    await keyChord('Escape', 'Escape', 27);
    await select(19, 19);
    await openMenu();
    check(`${theme}: without a selection the menu is Paste alone`, (await itemIds()) === 'selection-paste', await itemIds());
    const f2 = await shot(`editor-menu-no-selection-electron-${theme}`);
    check(`${theme}: the no-selection menu renders`, PNG.sync.read(readFileSync(f2)).width > 0);
    await keyChord('Escape', 'Escape', 27);
  }
  check('no runtime exception', app.errors.length === 0, app.errors.join(' || ').slice(0, 300));
} catch (e) {
  check('editor selection in Electron', false, e.stack || String(e));
} finally {
  await app.close();
}
console.log(`\nscreenshots: ${outDir}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
