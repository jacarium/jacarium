/**
 * Escape in the Media Library, in the real browser (Chrome over CDP, the
 * Vite dev server and the Flask backend, like the other live tests):
 *
 *   - opened from the Documents sidebar menu, a real Escape key closes it
 *     and the focus is back on the sidebar's Menu button;
 *   - opened from the editor's Insert menu (Image): with the preview open,
 *     Escape closes the preview and the library stays; with the ... menu
 *     open, Escape closes the menu first; with a pending row in the Upload
 *     tab (the file picker), Escape cancels the row and the library stays;
 *     the next Escape closes the library and the focus is back on the
 *     Insert button;
 *   - the focus stays inside the library while it is open (Tab from the
 *     last control wraps).
 *
 * Needs backend/venv, Chrome and ports 5173/8080 free; skips cleanly
 * otherwise. Synthetic data only (a 1x1 PNG made here).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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

function png([r, g, b]) {
  const crc = (buf) => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(Buffer.from([0, r, g, b]));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const RED = png([255, 0, 0]);

const DATA = mkdtempSync(path.join(tmpdir(), 'media-escape-data-'));
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

const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'media-escape-' });
if (app.skip) { console.log(`SKIP: ${app.skip}`); stopBackend(); process.exit(0); }

const noMotion = () => app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }'; document.head.appendChild(s); })()`);
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const has = (sel) => app.evaluate(`!!${q(sel)}`);
const clickSel = (sel) => app.evaluate(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`);
const clickText = (tag, re) => app.evaluate(`(() => { const el = Array.from(document.querySelectorAll(${JSON.stringify(tag)})).find((b) => ${re}.test(b.textContent.trim())); if (!el) return false; el.click(); return true; })()`);
const active = () => app.evaluate(`(() => { const a = document.activeElement; if (!a) return ''; return (a.getAttribute('data-testid') || a.getAttribute('title') || a.getAttribute('aria-label') || a.tagName) + (a.closest('.sc-modal-backdrop') ? ' [in modal]' : ''); })()`);
const keyChord = async (key, code, vk, modifiers = 0) => {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
};
const escape = async () => { await keyChord('Escape', 'Escape', 27); await sleep(250); };
const libraryOpen = () => has('[data-testid="media-library"]');
const pickFile = async (file) => {
  const doc = await app.send('DOM.getDocument', { depth: 1 });
  const node = await app.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '[data-testid="media-upload-input"]' });
  await app.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [file] });
};

try {
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
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

  // ---- from the sidebar menu: Escape closes, the focus is back on the Menu button ----
  const sidebarMenuButton = 'button[title="Menu"][aria-label="Menu"]';
  check('the sidebar menu opens', await clickSel(sidebarMenuButton));
  await sleep(300);
  check('the Media Library opens from it', await clickText('button', '/^Media Library$/') && await app.waitFor(`!!document.querySelector('[data-testid="media-library"]')`, 8000));
  check('the library holds the focus', /\[in modal\]/.test(await active()), await active());
  await escape();
  check('a real Escape closes the library', !(await libraryOpen()));
  check('...and the focus is back on the sidebar\'s Menu button', (await active()) === 'Menu', await active());

  // ---- from the editor's Insert menu: the layers first ----
  const openFromEditor = async () => {
    await clickSel('[data-testid="insert-menu-button"]');
    await app.waitFor(`!!document.querySelector('[data-testid="insert-menu"]')`, 5000);
    const item = await clickText('[data-testid="insert-menu"] [role="menuitem"], [data-testid="insert-menu"] button', '/^Image$/');
    return item && await app.waitFor(`!!document.querySelector('[data-testid="media-library"]')`, 8000);
  };
  check('the Media Library opens from the editor\'s Insert menu', await openFromEditor());
  // a stored image, through the picker
  await clickSel('[data-testid="media-tab-upload"]');
  await app.waitFor(`!!document.querySelector('[data-testid="media-upload-input"]')`, 5000);
  const redFile = path.join(DATA, 'pic.png');
  writeFileSync(redFile, RED);
  await pickFile(redFile);
  await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  check('a pending row from the picker, the name field focused', (await active()) === 'media-pending-name [in modal]', await active());
  await escape();
  check('Escape cancels the pending row and the library stays', !(await has('[data-testid="media-pending-row"]')) && await libraryOpen());
  await pickFile(redFile);
  await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  await keyChord('Enter', 'Enter', 13);
  await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  await clickSel('[data-testid="media-tab-browse"]');
  await app.waitFor(`Array.from(document.querySelectorAll('img[alt]')).some((i) => i.alt === 'pic.png')`, 5000);
  // the preview
  await app.evaluate(`(() => { const img = Array.from(document.querySelectorAll('img[alt]')).find((i) => i.alt === 'pic.png'); img.closest('[class*="aspect-square"]').click(); })()`);
  await app.waitFor(`!!document.querySelector('[data-testid="media-preview"]')`, 5000);
  await escape();
  check('Escape closes the preview first, the library stays', !(await has('[data-testid="media-preview"]')) && await libraryOpen());
  // the ... menu
  await app.evaluate(`(() => { const img = Array.from(document.querySelectorAll('img[alt]')).find((i) => i.alt === 'pic.png'); img.closest('.group').querySelector('button[title="Actions"]').click(); })()`);
  await app.waitFor(`!!document.querySelector('[data-testid="media-context-menu"]')`, 5000);
  await escape();
  check('Escape closes the ... menu first, the library stays', !(await has('[data-testid="media-context-menu"]')) && await libraryOpen());
  // the tag editor, from its field
  await app.evaluate(`(() => { const img = Array.from(document.querySelectorAll('img[alt]')).find((i) => i.alt === 'pic.png'); img.closest('.group').querySelector('button[title="Actions"]').click(); })()`);
  await app.waitFor(`!!document.querySelector('[data-testid="media-context-menu"]')`, 5000);
  await clickText('[data-testid="media-context-menu"] button', '/^Edit Tags$/');
  await app.waitFor(`!!document.querySelector('[data-testid="media-tag-editor"] input')`, 5000);
  check('the tag editor\'s field has the focus', (await active()) === 'INPUT [in modal]', await active());
  await escape();
  check('Escape in the tag editor\'s field closes the editor only', !(await has('[data-testid="media-tag-editor"]')) && await libraryOpen());
  // the focus stays inside: Tab from the last control wraps
  await app.evaluate(`(() => { const items = Array.from(document.querySelectorAll('.sc-modal-backdrop button, .sc-modal-backdrop input, .sc-modal-backdrop select')).filter((el) => !el.disabled); items[items.length - 1].focus(); })()`);
  await keyChord('Tab', 'Tab', 9);
  await sleep(100);
  check('Tab from the last control stays inside the library', /\[in modal\]/.test(await active()), await active());
  await escape();
  check('the last Escape closes the library', !(await libraryOpen()));
  check('...and the focus is back on the Insert button', (await active()) === 'insert-menu-button', await active());
  check('no runtime exception', app.errors.length === 0, app.errors.join(' || ').slice(0, 300));
} catch (e) {
  check('media escape run', false, e.stack || String(e));
} finally {
  await app.close();
  stopBackend();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
