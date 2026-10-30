/**
 * Cut / Copy / Paste in the Documents editor's right-click menu, in the
 * real browser (Chrome over CDP, the Vite dev server and the Flask backend,
 * like the other live tests), with the clipboard permission granted to the
 * page:
 *
 *   - a right-click on the editor WITHOUT a selection opens the menu with
 *     Cut / Copy / Paste (Cut and Copy disabled) and no AI / Search items;
 *   - with a selection it adds the AI / Search items after a separator;
 *   - Copy from the menu puts the selection on the clipboard (read back
 *     with navigator.clipboard.readText), the text stays;
 *   - Paste from the menu at the end of the text reproduces it, through
 *     the editor's own input path (the textarea's value, and the document
 *     saved from it);
 *   - Cut from the menu removes the selection and puts it on the
 *     clipboard; Cmd/Ctrl+Z (a real key event with the Undo command) brings
 *     it back - the native undo stack, as Cmd/Ctrl+X would leave it;
 *   - Escape closes the menu and the editor has the focus again;
 *   - screenshots of the menu with and without a selection, dark and light,
 *     in EDITOR_MENU_SHOTS_DIR (default: a temp dir).
 *
 * Needs backend/venv, Chrome and ports 5173/8080 free; skips cleanly
 * otherwise. Synthetic text only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, createNewDocument, REPO, sleep } from './helpers/live-documents-app.mjs';
import { dismissWhatsNew } from './helpers/visual-snapshots.mjs';

const VITE_PORT = 5173;
const FLASK_PORT = 8080;
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!existsSync(PYTHON)) { console.log('SKIP: backend/venv missing'); process.exit(0); }
if (!(await portFree(VITE_PORT)) || !(await portFree(FLASK_PORT))) { console.log(`SKIP: port ${VITE_PORT} or ${FLASK_PORT} is busy`); process.exit(0); }
if (spawnSync('node', ['-e', "require.resolve('pngjs')"], { cwd: REPO, stdio: 'ignore' }).status !== 0) { console.log('SKIP: pngjs missing'); process.exit(0); }

const DATA = mkdtempSync(path.join(tmpdir(), 'editor-menu-data-'));
const backend = spawn(PYTHON, ['app.py'], {
  cwd: path.join(REPO, 'backend'),
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_'))), HOME: DATA, PORT: String(FLASK_PORT), JACARIUM_AUTH_MODE: 'accounts', JACARIUM_REPORTS_ROOT: path.join(DATA, 'reports'), JACARIUM_KNOWN_HOSTS: path.join(DATA, '.ssh', 'known_hosts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let backendLog = '';
backend.stdout.on('data', (d) => { backendLog += d; });
backend.stderr.on('data', (d) => { backendLog += d; });
let up = false;
for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${FLASK_PORT}/health`)).ok; } catch { await sleep(250); } }
const stopBackend = () => { try { backend.kill('SIGTERM'); } catch { /* gone */ } rmSync(DATA, { recursive: true, force: true }); };
if (!up) { console.log('FAIL: the backend did not start\n' + backendLog.slice(-800)); stopBackend(); process.exit(1); }
const setupCode = readFileSync(path.join(DATA, 'setup-code'), 'utf8').trim();

const outDir = process.env.EDITOR_MENU_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'editor-menu-shots-'));
mkdirSync(outDir, { recursive: true });
const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'editor-menu-' });
if (app.skip) { console.log(`SKIP: ${app.skip}`); stopBackend(); process.exit(0); }

const { PNG } = await import('pngjs');
const pixelSpread = (file) => { const p = PNG.sync.read(readFileSync(file)); let min = 255, max = 0; for (let i = 0; i < p.data.length; i += 4 * 97) { const l = (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3; if (l < min) min = l; if (l > max) max = l; } return max - min; };
const shot = async (name, clip) => { const f = path.join(outDir, `${name}.png`); const r = await app.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }); writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };
const setTheme = async (theme) => { await app.evaluate(`document.documentElement.classList.${theme === 'dark' ? 'add' : 'remove'}('dark')`); await sleep(300); };
const noMotion = () => app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }'; document.head.appendChild(s); })()`);
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const has = (sel) => app.evaluate(`!!${q(sel)}`);
const value = () => app.evaluate(`document.querySelector('textarea').value`);
const mac = process.platform === 'darwin';
const keyChord = async (key, code, vk, modifiers = 0, commands = []) => {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, commands });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
};
// the menu: a real right-click on the textarea (the browser raises contextmenu; Chrome moves the caret to the
// click, so this is for the no-selection case), or the contextmenu event dispatched on the textarea at a
// point, which is what a right-click inside the selected text raises and leaves the selection as it is
const rightClick = async ({ real = false } = {}) => {
  const b = await app.evaluate(`(() => { const r = document.querySelector('textarea').getBoundingClientRect(); return [r.left + 60, r.top + 30]; })()`);
  if (real) {
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b[0], y: b[1], button: 'right', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b[0], y: b[1], button: 'right', clickCount: 1 });
  } else {
    await app.evaluate(`document.querySelector('textarea').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${b[0]}, clientY: ${b[1]}, view: window })); true`);
  }
  await app.waitFor(`!!document.querySelector('[data-testid="editor-context-menu"]')`, 5000);
  await sleep(300);   // the clipboard probe
};
const menuItems = () => app.evaluate(`Array.from(document.querySelectorAll('[data-testid="editor-context-menu"] [role="menuitem"]')).map((b) => (b.getAttribute('data-testid') || '') + (b.disabled ? ':off' : ':on'))`);
const clickItem = (id) => app.evaluate(`(() => { const b = document.querySelector('[data-testid="${id}"]'); if (!b || b.disabled) return false; b.click(); return true; })()`);
const select = (start, end) => app.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.setSelectionRange(${start}, ${end}); return ta.value.slice(${start}, ${end}); })()`);
const readClip = () => app.evaluate(`navigator.clipboard.readText().catch((e) => 'ERROR ' + e.message)`);

try {
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await app.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: `http://localhost:${VITE_PORT}` });
  await noMotion();
  await app.waitFor(`!!document.querySelector('[data-testid="brand-hero"]')`, 15000);
  const created = await app.evaluate(`fetch('http://localhost:${FLASK_PORT}/api/auth/setup', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Jacarium' }, body: JSON.stringify({ setupCode: ${JSON.stringify(setupCode)}, username: 'alice', password: 'alices password', displayName: 'Alice Example' }) }).then((r) => r.status)`);
  check('the synthetic administrator is created and signed in', created === 201, String(created));
  await app.send('Page.reload');
  await sleep(5000);
  await noMotion();
  await dismissWhatsNew(app);
  await app.waitFor(`!!document.querySelector('[data-testid="sidebar-brand-mark"]')`, 20000);
  await createNewDocument(app);
  await app.waitFor(`!!document.querySelector('textarea')`, 10000);
  await app.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); })()`);
  await app.send('Input.insertText', { text: 'alpha bravo charlie' });
  await sleep(800);
  check('the document holds the typed text', (await value()) === 'alpha bravo charlie', await value());
  await app.evaluate(`navigator.clipboard.writeText('').catch(() => null)`);

  // ---- no selection ----
  await select(19, 19);
  await rightClick({ real: true });
  let items = await menuItems();
  check('without a selection the menu opens with Paste alone - no Cut, no Copy, nothing else', items.join(',') === 'selection-paste:off' || items.join(',') === 'selection-paste:on', items.join(','));
  check('...and Paste is off with an empty clipboard (the page may read it)', items.includes('selection-paste:off'), items.join(','));
  check('the menu is role=menu and the first enabled item (none here) leaves the focus in the menu or the editor', await app.evaluate(`document.querySelector('[data-testid="editor-context-menu"]').getAttribute('role') === 'menu'`));
  for (const theme of ['dark', 'light']) { await setTheme(theme); const f = await shot(`editor-menu-no-selection-${theme}`); check(`the menu without a selection renders (${theme})`, pixelSpread(f) > 40); }
  await setTheme('light');
  await keyChord('Escape', 'Escape', 27);
  await sleep(200);
  check('Escape closes the menu and the editor has the focus again', !(await has('[data-testid="editor-context-menu"]')) && (await app.evaluate(`document.activeElement === document.querySelector('textarea')`)));

  // ---- with a selection: Copy ----
  check('"bravo" is selected', (await select(6, 11)) === 'bravo');
  await rightClick();
  items = await menuItems();
  check('with a selection: Cut, Copy, Paste, then Ask AI, Add as AI Context (and Search In when engines exist)', items.slice(0, 5).join(',') === 'selection-cut:on,selection-copy:on,selection-paste:off,selection-ask-ai:on,selection-add-context:on' && (await app.evaluate(`!!document.querySelector('[data-testid="editor-context-menu"] [role="separator"]')`)), items.join(','));
  check('the shortcut labels follow the platform', await app.evaluate(`document.querySelector('[data-testid="selection-copy"]').getAttribute('aria-keyshortcuts')`) === (mac ? '⌘C' : 'Ctrl+C'));
  for (const theme of ['dark', 'light']) { await setTheme(theme); const f = await shot(`editor-menu-selection-${theme}`); check(`the menu with a selection renders (${theme})`, pixelSpread(f) > 40); }
  await setTheme('light');
  check('Copy from the menu is enabled and clicked', await clickItem('selection-copy'));
  await sleep(300);
  check('Copy put the selection on the clipboard and left the text', (await readClip()) === 'bravo' && (await value()) === 'alpha bravo charlie', `${await readClip()} | ${await value()}`);
  check('the menu closed', !(await has('[data-testid="editor-context-menu"]')));

  // ---- Paste at the end ----
  await select(19, 19);
  await rightClick();
  items = await menuItems();
  check('with text on the clipboard Paste is enabled', items.includes('selection-paste:on'), items.join(','));
  check('Paste from the menu is clicked', await clickItem('selection-paste'));
  await sleep(500);
  check('Paste reproduced the text at the caret through the editor (the textarea shows it)', (await value()) === 'alpha bravo charliebravo', await value());

  // ---- Cut, then Undo ----
  check('"charlie" is selected', (await select(12, 19)) === 'charlie');
  await rightClick();
  check('Cut from the menu is clicked', await clickItem('selection-cut'));
  await sleep(500);
  check('Cut removed the selection and put it on the clipboard', (await value()) === 'alpha bravo bravo' && (await readClip()) === 'charlie', `${await value()} | ${await readClip()}`);
  await app.evaluate(`document.querySelector('textarea').focus(); true`);
  await keyChord('z', 'KeyZ', 90, mac ? 4 : 2, ['Undo']);
  await sleep(500);
  check('Cmd/Ctrl+Z brings the cut text back (the native undo stack, as the key would leave it)', (await value()) === 'alpha bravo charliebravo', await value());

  // ---- the document saved what the editor shows ----
  await sleep(2500);
  const saved = await app.evaluate(`(async () => { const r = indexedDB.open(globalThis.__JACARIUM_DB_NAME || 'Jacarium'); const dbx = await new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); const all = await new Promise((res, rej) => { const t = dbx.transaction('documents').objectStore('documents').getAll(); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); dbx.close(); return all.map((d) => d.content); })()`);
  check('the pasted and restored text reached the saved document (the editor\'s own change path)', saved.includes('alpha bravo charliebravo'), JSON.stringify(saved).slice(0, 120));
  check('no runtime exception', app.errors.length === 0, app.errors.join(' || ').slice(0, 300));
} catch (e) {
  check('editor context menu run', false, e.stack || String(e));
} finally {
  await app.close();
  stopBackend();
}
console.log(`\nscreenshots: ${outDir}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
