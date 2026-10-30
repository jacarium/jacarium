/**
 * The Media Library's Upload tab keeps its actions in view, in the real
 * browser (Chrome over CDP, the Vite dev server and the Flask backend, like
 * the other live tests). With rows pending, the drop zone folds to one line
 * (goes, in replace mode), the rows sit at the top of the scroll area and
 * Cancel / Upload (Replace) are in the modal's footer next to Close:
 *
 *   - at 1280x720 and at 1024x640 (the smallest desktop window the layout
 *     is checked at), in plain upload with one and with three rows, every
 *     name field and the action buttons are fully inside the modal's
 *     visible area, nothing covers them (elementFromPoint), no scrolling;
 *   - the same in replace mode with its one row (and the banner);
 *   - the focus is on the first name field when rows arrive, Enter uploads
 *     (the keyboard flow is unchanged), the folded drop zone still takes a
 *     drop and its Browse opens the picker, Cancel clears;
 *   - screenshots of three pending rows and of replace mode, dark and
 *     light, at 1280x720, in MEDIA_ACTIONS_SHOTS_DIR (default: a temp dir).
 *
 * Needs backend/venv, Chrome and ports 5173/8080 free; skips cleanly
 * otherwise. Synthetic data only (1x1 PNGs made here).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { launchDocumentsApp, createNewDocument, REPO, sleep } from './helpers/live-documents-app.mjs';
import { dismissWhatsNew } from './helpers/visual-snapshots.mjs';

const VITE_PORT = 5173;
const FLASK_PORT = 8080;
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!existsSync(PYTHON)) { console.log('SKIP: backend/venv missing'); process.exit(0); }
if (!(await portFree(VITE_PORT)) || !(await portFree(FLASK_PORT))) { console.log(`SKIP: port ${VITE_PORT} or ${FLASK_PORT} is busy`); process.exit(0); }
if (spawnSync('node', ['-e', "require.resolve('pngjs')"], { cwd: REPO, stdio: 'ignore' }).status !== 0) { console.log('SKIP: pngjs missing'); process.exit(0); }

function png([r, g, b]) {
  const crc = (buf) => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(Buffer.from([0, r, g, b]));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const RED = png([255, 0, 0]), GREEN = png([0, 255, 0]), BLUE = png([0, 0, 255]);

const DATA = mkdtempSync(path.join(tmpdir(), 'media-actions-data-'));
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

const outDir = process.env.MEDIA_ACTIONS_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'media-actions-shots-'));
mkdirSync(outDir, { recursive: true });
const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'media-actions-' });
if (app.skip) { console.log(`SKIP: ${app.skip}`); stopBackend(); process.exit(0); }

const { PNG } = await import('pngjs');
const pixelSpread = (file) => { const p = PNG.sync.read(readFileSync(file)); let min = 255, max = 0; for (let i = 0; i < p.data.length; i += 4 * 97) { const l = (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3; if (l < min) min = l; if (l > max) max = l; } return max - min; };
const shot = async (name) => { const f = path.join(outDir, `${name}.png`); const r = await app.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };
const setTheme = async (theme) => { await app.evaluate(`document.documentElement.classList.${theme === 'dark' ? 'add' : 'remove'}('dark')`); await sleep(300); };
const setViewport = async (width, height) => { await app.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(400); };
const noMotion = () => app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }'; document.head.appendChild(s); })()`);
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const has = (sel) => app.evaluate(`!!${q(sel)}`);
const clickSel = (sel) => app.evaluate(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`);
const clickText = (tag, re) => app.evaluate(`(() => { const el = Array.from(document.querySelectorAll(${JSON.stringify(tag)})).find((b) => ${re}.test(b.textContent.trim())); if (!el) return false; el.click(); return true; })()`);
const active = () => app.evaluate(`(() => { const a = document.activeElement; return a ? (a.getAttribute('data-testid') || a.tagName) : ''; })()`);
const keyChord = async (key, code, vk) => {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};
const pickFiles = async (files) => {
  const doc = await app.send('DOM.getDocument', { depth: 1 });
  const node = await app.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '[data-testid="media-upload-input"]' });
  await app.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files });
};
const rows = () => app.evaluate(`document.querySelectorAll('[data-testid="media-pending-row"]').length`);
// every name field and the two action buttons: fully inside the modal panel and the viewport, and the
// element at their centre is themselves (nothing covers them); nothing scrolled
const visibility = () => app.evaluate(`(() => {
  const panel = document.querySelector('[data-testid="media-library"]').getBoundingClientRect();
  const inside = (r) => r.width > 0 && r.height > 0 && r.top >= panel.top && r.bottom <= panel.bottom && r.left >= panel.left && r.right <= panel.right && r.bottom <= window.innerHeight;
  const covered = (el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(hit === el || el.contains(hit)); };
  const out = {};
  for (const [name, sel] of [['cancel', '[data-testid="media-upload-cancel"]'], ['confirm', '[data-testid="media-upload-confirm"]'], ['close', '[data-testid="media-library"] .sc-button-row button:last-child']]) {
    const el = document.querySelector(sel);
    out[name] = el ? (inside(el.getBoundingClientRect()) && !covered(el) ? 'ok' : 'off:' + JSON.stringify(el.getBoundingClientRect())) : 'missing';
  }
  const fields = Array.from(document.querySelectorAll('[data-testid="media-pending-name"]'));
  out.fields = fields.map((el) => (inside(el.getBoundingClientRect()) && !covered(el) ? 'ok' : 'off'));
  const scroller = document.querySelector('[data-testid="media-library"] .overflow-y-auto');
  out.scrolled = scroller ? scroller.scrollTop : 0;
  return out;
})()`);
const allVisible = (v, fieldCount) => v.cancel === 'ok' && v.confirm === 'ok' && v.close === 'ok' && v.fields.length === fieldCount && v.fields.every((f) => f === 'ok') && v.scrolled === 0;
const dropFile = (name, base64) => app.evaluate(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'image/png' })); const el = document.querySelector('[data-testid="media-upload-drop"]'); el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);

const files = { red: path.join(DATA, 'red.png'), green: path.join(DATA, 'green.png'), blue: path.join(DATA, 'blue.png') };
writeFileSync(files.red, RED); writeFileSync(files.green, GREEN); writeFileSync(files.blue, BLUE);

try {
  await setViewport(1280, 720);
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
  await clickSel('button[title="Menu"][aria-label="Menu"]');
  await sleep(300);
  check('the Media Library opens', await clickText('button', '/^Media Library$/') && await app.waitFor(`!!document.querySelector('[data-testid="media-library"]')`, 8000));
  await clickSel('[data-testid="media-tab-upload"]');
  await app.waitFor(`!!document.querySelector('[data-testid="media-upload-input"]')`, 5000);

  for (const [w, h] of [[1280, 720], [1024, 640]]) {
    await setViewport(w, h);
    // one row
    await pickFiles([files.red]);
    await app.waitFor(`document.querySelectorAll('[data-testid="media-pending-row"]').length === 1`, 5000);
    await sleep(200);
    let v = await visibility();
    check(`${w}x${h}: one pending row - the name field, Cancel, Upload and Close are in view, nothing scrolled`, allVisible(v, 1), JSON.stringify(v));
    check(`${w}x${h}: the focus is on the name field`, (await active()) === 'media-pending-name', await active());
    check(`${w}x${h}: the drop zone folded to one line that still offers Browse`, /to add another/.test(await app.evaluate(`${q('[data-testid="media-upload-drop"]')}.textContent`)) && (await app.evaluate(`${q('[data-testid="media-upload-drop"]')}.getBoundingClientRect().height`)) < 80, await app.evaluate(`${q('[data-testid="media-upload-drop"]')}.getBoundingClientRect().height`));
    // three rows: two more through the folded zone (picker, then a drop)
    await pickFiles([files.green]);
    await app.waitFor(`document.querySelectorAll('[data-testid="media-pending-row"]').length === 2`, 5000);
    await dropFile('blue.png', BLUE.toString('base64'));
    await app.waitFor(`document.querySelectorAll('[data-testid="media-pending-row"]').length === 3`, 5000);
    await sleep(200);
    v = await visibility();
    check(`${w}x${h}: three pending rows - every name field and the actions are in view, nothing scrolled`, allVisible(v, 3), JSON.stringify(v));
    check(`${w}x${h}: the footer says what is waiting and the button counts`, /3 images to upload/.test(await app.evaluate(`${q('[data-testid="media-pending-count"]')}.textContent`)) && (await app.evaluate(`${q('[data-testid="media-upload-confirm"]')}.textContent`)) === 'Upload 3');
    if (w === 1280) { for (const theme of ['dark', 'light']) { await setTheme(theme); const f = await shot(`media-upload-three-rows-${theme}`); check(`three rows render (${theme})`, pixelSpread(f) > 40); } await setTheme('light'); }
    await clickSel('[data-testid="media-upload-cancel"]');
    await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
    check(`${w}x${h}: Cancel clears the rows and the full drop zone is back`, (await rows()) === 0 && /Upload Images/.test(await app.evaluate(`${q('[data-testid="media-upload-drop"]')}.textContent`)) && !(await has('[data-testid="media-upload-cancel"]')));
  }

  // Enter in the name field still uploads
  await setViewport(1280, 720);
  await pickFiles([files.red]);
  await app.waitFor(`document.querySelectorAll('[data-testid="media-pending-row"]').length === 1`, 5000);
  await keyChord('Enter', 'Enter', 13);
  await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  await clickSel('[data-testid="media-tab-browse"]');
  await app.waitFor(`Array.from(document.querySelectorAll('img[alt]')).some((i) => i.alt === 'red.png')`, 5000);
  check('Enter in the name field uploads (the keyboard flow is unchanged)', true);

  // replace mode
  for (const [w, h] of [[1280, 720], [1024, 640]]) {
    await setViewport(w, h);
    await clickSel('[data-testid="media-tab-browse"]');
    await app.waitFor(`Array.from(document.querySelectorAll('img[alt]')).some((i) => i.alt === 'red.png')`, 5000);
    await app.evaluate(`(() => { const img = Array.from(document.querySelectorAll('img[alt]')).find((i) => i.alt === 'red.png'); img.closest('.group').querySelector('button[title="Actions"]').click(); })()`);
    await app.waitFor(`!!document.querySelector('[data-testid="media-menu-replace"]')`, 5000);
    await clickSel('[data-testid="media-menu-replace"]');
    await app.waitFor(`!!document.querySelector('[data-testid="media-replace-banner"]')`, 5000);
    await pickFiles([files.green]);
    await app.waitFor(`document.querySelectorAll('[data-testid="media-pending-row"]').length === 1`, 5000);
    await sleep(200);
    const v = await visibility();
    check(`${w}x${h}: replace mode - the banner's row, the name field, Cancel, Replace and Close are in view, nothing scrolled`, allVisible(v, 1) && await has('[data-testid="media-replace-banner"]'), JSON.stringify(v));
    check(`${w}x${h}: in replace mode the drop zone is gone while the row is pending (one image is all it takes)`, !(await has('[data-testid="media-upload-drop"]')) && (await app.evaluate(`${q('[data-testid="media-upload-confirm"]')}.textContent`)) === 'Replace' && /Replacing red\.png/.test(await app.evaluate(`${q('[data-testid="media-pending-count"]')}.textContent`)));
    if (w === 1280) { for (const theme of ['dark', 'light']) { await setTheme(theme); const f = await shot(`media-replace-row-${theme}`); check(`replace mode renders (${theme})`, pixelSpread(f) > 40); } await setTheme('light'); }
    await clickSel('[data-testid="media-replace-cancel"]');
    await app.waitFor(`!document.querySelector('[data-testid="media-replace-banner"]')`, 5000);
  }
  check('no runtime exception', app.errors.length === 0, app.errors.join(' || ').slice(0, 300));
} catch (e) {
  check('media upload actions run', false, e.stack || String(e));
} finally {
  await app.close();
  stopBackend();
}
console.log(`\nscreenshots: ${outDir}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
