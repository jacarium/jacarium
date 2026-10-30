/**
 * The Documents editor's selection stays painted while its right-click
 * menu is open, in the real browser (Chrome over CDP with the Flask
 * backend) - on the Vite dev server AND on a production build of the UI
 * (tests/helpers/live-documents-app.mjs, build: 'production'):
 *
 *   - with "bravo" selected and the menu open, the textarea is still the
 *     active element with the same selection (a textarea's selection is
 *     only painted while it is focused), the textarea names the menu
 *     (aria-controls);
 *   - the paint itself: the pixels of the selected text's line with the
 *     menu open are the pixels of the focused, selected textarea without
 *     the menu (the menu sits below the line), and differ from the line
 *     with nothing selected - the highlight is there, in the normal
 *     selection colour, in the light and the dark theme;
 *   - the keys reach the menu from the textarea: ArrowDown marks Cut
 *     active (data-active, aria-activedescendant on the textarea), the
 *     selection untouched; Enter runs Cut (the text goes, the clipboard
 *     has it); Escape closes the menu with the focus and the selection
 *     still in the editor; a click outside closes it the same way;
 *   - the AI item still gets the selection (Ask AI opens with it);
 *   - without a selection the menu is Paste alone (no Cut, no Copy, no AI
 *     items), screenshots dark and light; with one, Cut and Copy are there;
 *   - screenshots of the menu over the highlighted selection, dark and
 *     light, in EDITOR_SELECTION_SHOTS_DIR (default: a temp dir).
 *
 * LIVE_VITE_PORT / LIVE_BACKEND_PORT pick other ports (5173 / 8080).
 * Needs backend/venv, Chrome and the ports free; skips cleanly otherwise.
 * Synthetic text only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, createNewDocument, REPO, sleep } from './helpers/live-documents-app.mjs';
import { dismissWhatsNew } from './helpers/visual-snapshots.mjs';

const VITE_PORT = Number(process.env.LIVE_VITE_PORT || 5173);
const FLASK_PORT = Number(process.env.LIVE_BACKEND_PORT || 8080);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!existsSync(PYTHON)) { console.log('SKIP: backend/venv missing'); process.exit(0); }
if (!(await portFree(VITE_PORT)) || !(await portFree(FLASK_PORT))) { console.log(`SKIP: port ${VITE_PORT} or ${FLASK_PORT} is busy`); process.exit(0); }
if (spawnSync('node', ['-e', "require.resolve('pngjs')"], { cwd: REPO, stdio: 'ignore' }).status !== 0) { console.log('SKIP: pngjs missing'); process.exit(0); }

const DATA = mkdtempSync(path.join(tmpdir(), 'editor-selection-data-'));
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
const outDir = process.env.EDITOR_SELECTION_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'editor-selection-shots-'));
mkdirSync(outDir, { recursive: true });
const { PNG } = await import('pngjs');

// one run per build; the backend is shared, each run signs in with its own user
for (const build of ['dev', 'production']) {
  const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: `editor-selection-${build}-`, build, backendUrl: `http://localhost:${FLASK_PORT}` });
  if (app.skip) { console.log(`SKIP: ${app.skip}`); stopBackend(); process.exit(0); }
  const tag = `[${build}]`;
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const has = (sel) => app.evaluate(`!!${q(sel)}`);
  const value = () => app.evaluate(`document.querySelector('textarea').value`);
  const active = () => app.evaluate(`(() => { const a = document.activeElement; return a ? (a.getAttribute('data-testid') || a.tagName) : ''; })()`);
  const selection = () => app.evaluate(`(() => { const ta = document.querySelector('textarea'); return [ta.selectionStart, ta.selectionEnd]; })()`);
  const keyChord = async (key, code, vk) => {
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(250);
  };
  const noMotion = () => app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }'; document.head.appendChild(s); })()`);
  const setTheme = async (theme) => { await app.evaluate(`document.documentElement.classList.${theme === 'dark' ? 'add' : 'remove'}('dark')`); await sleep(300); };
  const select = (a, b) => app.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.setSelectionRange(${a}, ${b}); return ta.value.slice(${a}, ${b}); })()`);
  // the menu opens from a right-click BELOW the first line (its own box must not cover the selected text)
  const openMenu = async () => {
    const b = await app.evaluate(`(() => { const r = document.querySelector('textarea').getBoundingClientRect(); return [r.left + 60, r.top + 90]; })()`);
    await app.evaluate(`document.querySelector('textarea').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${b[0]}, clientY: ${b[1]}, view: window })); true`);
    await app.waitFor(`!!document.querySelector('[data-testid="editor-context-menu"]')`, 3000);
    await sleep(300);
  };
  // the first text line of the textarea, as a clip
  const lineClip = () => app.evaluate(`(() => { const r = document.querySelector('textarea').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(Math.min(r.width, 420)), height: 32, scale: 1 }; })()`);
  const linePixels = async () => { const clip = await lineClip(); const r = await app.send('Page.captureScreenshot', { format: 'png', clip }); return PNG.sync.read(Buffer.from(r.result.data, 'base64')).data; };
  const differing = (a, b) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 4) { if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++; } return n; };
  const shot = async (name) => { const f = path.join(outDir, `${name}.png`); const r = await app.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };

  try {
    await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await app.waitFor(`!!document.querySelector('[data-testid="brand-hero"]')`, 15000);
    const user = build === 'dev' ? { setupCode, username: 'alice', password: 'alices password', displayName: 'Alice Example' } : { username: 'alice', password: 'alices password' };
    const created = await app.evaluate(`fetch('http://localhost:${FLASK_PORT}/api/auth/${build === 'dev' ? 'setup' : 'login'}', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Jacarium' }, body: JSON.stringify(${JSON.stringify(user)}) }).then((r) => r.status)`);
    check(`${tag} signed in`, created === 201 || created === 200, String(created));
    await app.send('Page.reload');
    await sleep(5000);
    await noMotion();
    await dismissWhatsNew(app);
    await app.waitFor(`!!document.querySelector('[data-testid="sidebar-brand-mark"]')`, 20000);
    await createNewDocument(app);
    await app.waitFor(`!!document.querySelector('textarea')`, 10000);
    await app.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: `http://localhost:${VITE_PORT}` });
    await app.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); })()`);
    await app.send('Input.insertText', { text: 'alpha bravo charlie\n\n\n\n\n' });
    await sleep(600);

    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await select(19, 19);
      const plain = await linePixels();
      check(`${tag} ${theme}: "bravo" is selected`, (await select(6, 11)) === 'bravo');
      const selectedFocused = await linePixels();
      check(`${tag} ${theme}: (the selection is painted while the textarea is focused: the line differs from the unselected one)`, differing(plain, selectedFocused) > 40, String(differing(plain, selectedFocused)));
      await openMenu();
      check(`${tag} ${theme}: with the menu open the textarea is still the active element with the same selection, and names the menu`, (await active()) === 'TEXTAREA' && JSON.stringify(await selection()) === '[6,11]' && await app.evaluate(`document.querySelector('textarea').getAttribute('aria-controls') === document.querySelector('[data-testid="editor-context-menu"]').id`), `${await active()} ${JSON.stringify(await selection())}`);
      const withMenu = await linePixels();
      check(`${tag} ${theme}: the selection is painted while the menu is open, exactly as without the menu (the same highlight colour)`, differing(selectedFocused, withMenu) < 10 && differing(plain, withMenu) > 40, `menu vs focused: ${differing(selectedFocused, withMenu)}, menu vs plain: ${differing(plain, withMenu)}`);
      const f = await shot(`editor-selection-menu-${build}-${theme}`);
      check(`${tag} ${theme}: the screenshot renders`, PNG.sync.read(readFileSync(f)).width > 0);
      await keyChord('Escape', 'Escape', 27);
      check(`${tag} ${theme}: Escape closes the menu; the focus and the selection stay in the editor`, !(await has('[data-testid="editor-context-menu"]')) && (await active()) === 'TEXTAREA' && JSON.stringify(await selection()) === '[6,11]');
    }
    await setTheme('light');

    // without a selection: Paste alone
    const itemIds = () => app.evaluate(`Array.from(document.querySelectorAll('[data-testid="editor-context-menu"] [role="menuitem"]')).map((b) => b.getAttribute('data-testid')).join(',')`);
    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await select(19, 19);
      await openMenu();
      check(`${tag} ${theme}: without a selection the menu is Paste alone`, (await itemIds()) === 'selection-paste', await itemIds());
      const f = await shot(`editor-menu-no-selection-${build}-${theme}`);
      check(`${tag} ${theme}: the no-selection menu renders`, PNG.sync.read(readFileSync(f)).width > 0);
      await keyChord('Escape', 'Escape', 27);
    }
    await setTheme('light');
    await select(6, 11);
    await openMenu();
    check(`${tag} with a selection Cut and Copy are there`, (await itemIds()).startsWith('selection-cut,selection-copy,selection-paste'), await itemIds());
    await keyChord('Escape', 'Escape', 27);

    // the keys reach the menu from the textarea
    await select(6, 11);
    await openMenu();
    await keyChord('ArrowDown', 'ArrowDown', 40);
    check(`${tag} ArrowDown marks Cut active and announces it on the textarea; the selection is untouched`, await app.evaluate(`(() => { const cut = document.querySelector('[data-testid="selection-cut"]'); const ta = document.querySelector('textarea'); return cut.getAttribute('data-active') === 'true' && ta.getAttribute('aria-activedescendant') === cut.id && document.activeElement === ta; })()`) && JSON.stringify(await selection()) === '[6,11]', JSON.stringify(await selection()));
    await keyChord('ArrowDown', 'ArrowDown', 40);
    await keyChord('ArrowUp', 'ArrowUp', 38);
    check(`${tag} ArrowDown then ArrowUp is back on Cut`, await app.evaluate(`document.querySelector('[data-testid="selection-cut"]').getAttribute('data-active') === 'true'`));
    await keyChord('Enter', 'Enter', 13);
    await sleep(300);
    check(`${tag} Enter runs Cut: the text goes, the clipboard has it, the menu is closed`, (await value()).startsWith('alpha  charlie') && (await app.evaluate(`navigator.clipboard.readText().catch(() => 'ERROR')`)) === 'bravo' && !(await has('[data-testid="editor-context-menu"]')), (await value()).slice(0, 30));
    // a click outside
    await select(0, 5);
    await openMenu();
    const outside = await app.evaluate(`(() => { const r = document.querySelector('textarea').getBoundingClientRect(); return [r.left + 300, r.top + 300]; })()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: outside[0], y: outside[1], button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: outside[0], y: outside[1], button: 'left', clickCount: 1 });
    await sleep(300);
    check(`${tag} a click outside closes the menu, the editor keeps the focus`, !(await has('[data-testid="editor-context-menu"]')) && (await active()) === 'TEXTAREA');
    // the AI item still gets the selection
    await select(0, 5);
    await openMenu();
    await app.evaluate(`${q('[data-testid="selection-ask-ai"]')}.click(); true`);
    await sleep(600);
    check(`${tag} Ask AI About This opens with the selection`, await app.evaluate(`/alpha/.test(document.body.textContent) && !document.querySelector('[data-testid="editor-context-menu"]') && !!Array.from(document.querySelectorAll('textarea, input, [contenteditable], div')).find((el) => (el.value || el.textContent || '').includes('alpha') && !el.closest('.editor') && el !== document.querySelector('textarea'))`));
    await keyChord('Escape', 'Escape', 27);
    check(`${tag} no runtime exception`, app.errors.length === 0, app.errors.join(' || ').slice(0, 300));
  } catch (e) {
    check(`${tag} editor selection run`, false, e.stack || String(e));
  } finally {
    await app.close();
  }
}
stopBackend();
console.log(`\nscreenshots: ${outDir}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
