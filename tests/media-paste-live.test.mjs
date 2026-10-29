/**
 * The Media Library's paste and rename, in the real browser (Chrome over
 * CDP, the Vite dev server and the Flask backend, like the other live
 * tests): signed in, a document open, the Media Library from the Documents
 * sidebar menu, the Upload tab, then
 *
 *   - Ctrl/Cmd+V with a PNG on the clipboard: the clipboard is written with
 *     navigator.clipboard.write (permission granted over CDP) and the key
 *     chord sent as a real key event with the Paste editing command; when
 *     the environment cannot give the page the OS clipboard (headless
 *     Chrome without focus), the same paste event is raised in the page
 *     with a DataTransfer holding the image, and the log says so;
 *   - the pending row names the image screenshot-YYYY-MM-DD-HHMMSS.png, the
 *     name field has focus, typing replaces the name, Enter stores it, the
 *     Browse tab lists it;
 *   - a drop (a DataTransfer with two files) gives two rows with the files'
 *     names; one renamed to a name the library has shows and gets -2;
 *   - the file picker (DOM.setFileInputFiles on the hidden input) gives a
 *     row; Escape cancels it;
 *   - a text paste into the search field is not taken;
 *   - an SVG with a script, uploaded and shown in Browse and in the
 *     preview, runs nothing (images are rendered through <img>);
 *   - no layout break: the modal keeps its width with rows pending, the
 *     rows are visible inside the scroll area;
 *   - screenshots of the Upload tab with pending rows, dark and light, in
 *     MEDIA_SHOTS_DIR (default: a temp dir).
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
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!existsSync(PYTHON)) { console.log('SKIP: backend/venv missing'); process.exit(0); }
if (!(await portFree(VITE_PORT)) || !(await portFree(FLASK_PORT))) { console.log(`SKIP: port ${VITE_PORT} or ${FLASK_PORT} is busy`); process.exit(0); }
if (spawnSync('node', ['-e', "require.resolve('pngjs')"], { cwd: REPO, stdio: 'ignore' }).status !== 0) { console.log('SKIP: pngjs missing'); process.exit(0); }

// a 1x1 PNG of a solid colour, built here
function png([r, g, b]) {
  const crc = (buf) => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(Buffer.from([0, r, g, b]));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const RED = png([255, 0, 0]), GREEN = png([0, 255, 0]), BLUE = png([0, 0, 255]);

const DATA = mkdtempSync(path.join(tmpdir(), 'media-paste-data-'));
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

const outDir = process.env.MEDIA_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'media-paste-shots-'));
mkdirSync(outDir, { recursive: true });
const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'media-paste-' });
if (app.skip) { console.log(`SKIP: ${app.skip}`); stopBackend(); process.exit(0); }

const { PNG } = await import('pngjs');
const pixelSpread = (file) => { const p = PNG.sync.read(readFileSync(file)); let min = 255, max = 0; for (let i = 0; i < p.data.length; i += 4 * 97) { const l = (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3; if (l < min) min = l; if (l > max) max = l; } return max - min; };
const shot = async (name) => { const f = path.join(outDir, `${name}.png`); const r = await app.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f; };
const setTheme = async (theme) => { await app.evaluate(`document.documentElement.classList.${theme === 'dark' ? 'add' : 'remove'}('dark')`); await sleep(300); };
const noMotion = () => app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }'; document.head.appendChild(s); })()`);
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const has = (sel) => app.evaluate(`!!${q(sel)}`);
const text = (sel) => app.evaluate(`(${q(sel)} || {}).textContent || ''`);
const value = (sel) => app.evaluate(`(${q(sel)} || {}).value || ''`);
const clickSel = (sel) => app.evaluate(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`);
const clickText = (tag, re) => app.evaluate(`(() => { const el = Array.from(document.querySelectorAll(${JSON.stringify(tag)})).find((b) => ${re}.test(b.textContent.trim())); if (!el) return false; el.click(); return true; })()`);
const keyChord = async (key, code, vk, modifiers = 0, commands = []) => {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, commands });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
};
const b64 = (buf) => buf.toString('base64');
// the same event the browser raises for Ctrl/Cmd+V, with the image in a DataTransfer (the fallback when the OS clipboard is out of reach)
const syntheticPaste = (name, type, base64, targetSel = 'body') => app.evaluate(`(() => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));
  const file = new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });
  const dt = new DataTransfer(); dt.items.add(file);
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  (${q(targetSel)} || document.body).dispatchEvent(ev);
  return ev.defaultPrevented;
})()`);
const names = () => app.evaluate(`(async () => { const r = indexedDB.open(globalThis.__JACARIUM_DB_NAME || 'Jacarium'); const dbx = await new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); const all = await new Promise((res, rej) => { const t = dbx.transaction('media').objectStore('media').getAll(); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); dbx.close(); return all.map((m) => m.filename).sort(); })()`);

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

  // ---- the Media Library from the Documents sidebar menu, the Upload tab ----
  const menuOpened = await clickSel('[data-testid="documents-sidebar-menu"]') || await clickText('button', '/^Menu$|^More$/') || await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => /menu/i.test(el.getAttribute('aria-label') || el.title || '')); if (!b) return false; b.click(); return true; })()`);
  await sleep(300);
  const itemClicked = await clickText('button', '/^Media Library$/');
  check('the Media Library opens from the Documents sidebar menu', menuOpened && itemClicked && await app.waitFor(`!!document.querySelector('[data-testid="media-tab-upload"]')`, 8000), `${menuOpened} ${itemClicked}`);
  await clickSel('[data-testid="media-tab-upload"]');
  await app.waitFor(`!!document.querySelector('[data-testid="media-upload-drop"]')`, 5000);
  check('the Upload tab says a paste works too', /Ctrl\+V|Cmd\+V/.test(await text('[data-testid="media-upload-drop"]')));
  const modalBefore = await app.evaluate(`(() => { const b = document.querySelector('[data-testid="media-tab-upload"]').closest('.bg-os-modal').getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; })()`);

  // ---- Ctrl/Cmd+V: the OS clipboard when the page can have it, the same event otherwise ----
  let realClipboard = false;
  try {
    await app.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: `http://localhost:${VITE_PORT}` });
    await app.evaluate(`window.focus(); document.body.focus(); true`);
    const written = await app.evaluate(`(async () => { try { const bytes = Uint8Array.from(atob(${JSON.stringify(b64(RED))}), (c) => c.charCodeAt(0)); await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]); return 'ok'; } catch (e) { return 'error: ' + e.message; } })()`);
    if (written === 'ok') {
      const mac = process.platform === 'darwin';
      await keyChord('v', 'KeyV', 86, mac ? 4 : 2, ['Paste']);
      realClipboard = await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 3000).catch(() => false);
    }
    console.log(`INFO: OS clipboard path: write ${written}; a key chord produced a pending row: ${!!realClipboard}`);
  } catch (e) {
    console.log(`INFO: OS clipboard path unavailable here (${String(e).slice(0, 120)})`);
  }
  if (!realClipboard) {
    const consumed = await syntheticPaste('whatever', 'image/png', b64(RED));
    check('the paste event with an image is consumed by the Upload tab', consumed === true, String(consumed));
  }
  await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  const pastedName = await value('[data-testid="media-pending-name"]');
  check(`the pasted image is a pending row named screenshot-YYYY-MM-DD-HHMMSS.png (${pastedName})`, /^screenshot-\d{4}-\d{2}-\d{2}-\d{6}\.png$/.test(pastedName), pastedName);
  check('the name field has focus and shows the image came from the clipboard', await app.evaluate(`document.activeElement === document.querySelector('[data-testid="media-pending-name"]')`) && /clipboard/i.test(await text('[data-testid="media-pending-row"]')));
  check('the row shows a preview of the image', await app.evaluate(`(() => { const img = document.querySelector('[data-testid="media-pending-row"] img'); return !!img && img.naturalWidth === 1 && img.naturalHeight === 1; })()`));
  for (const theme of ['dark', 'light']) { await setTheme(theme); const f = await shot(`media-upload-pending-${theme}`); check(`the Upload tab with a pending row renders (${theme})`, pixelSpread(f) > 40); }
  await setTheme('light');
  const modalAfter = await app.evaluate(`(() => { const b = document.querySelector('[data-testid="media-tab-upload"]').closest('.bg-os-modal').getBoundingClientRect(); const row = document.querySelector('[data-testid="media-pending-row"]').getBoundingClientRect(); const area = document.querySelector('[data-testid="media-pending-row"]').closest('.overflow-y-auto').getBoundingClientRect(); return { size: [Math.round(b.width), Math.round(b.height)], rowInside: row.top >= area.top - 1 && row.bottom <= area.bottom + 1 && row.left >= area.left - 1 && row.right <= area.right + 1 }; })()`);
  check('the modal keeps its size and the pending row sits inside the scroll area', JSON.stringify(modalAfter.size) === JSON.stringify(modalBefore) && modalAfter.rowInside, JSON.stringify([modalBefore, modalAfter]));
  // rename by typing (select all, then the new name), Enter stores
  await app.evaluate(`(() => { const el = document.querySelector('[data-testid="media-pending-name"]'); el.focus(); el.select(); })()`);
  await app.send('Input.insertText', { text: 'pasted diagram.png' });
  await sleep(100);
  check('typing replaces the name (the field shows the typed name)', (await value('[data-testid="media-pending-name"]')) === 'pasted diagram.png', await value('[data-testid="media-pending-name"]'));
  check('the row says what it will be stored as (whitespace to underscore)', /pasted_diagram\.png/.test(await text('[data-testid="media-pending-row"]')));
  await keyChord('Enter', 'Enter', 13);
  await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  let stored = await names();
  check('Enter stores the pasted image under the typed name', JSON.stringify(stored) === '["pasted_diagram.png"]', stored.join(','));

  // ---- a drop with two files; a rename onto a taken name gets -2 ----
  await app.evaluate(`(() => {
    const mk = (name, b) => new File([Uint8Array.from(atob(b), (c) => c.charCodeAt(0))], name, { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(mk('green one.png', ${JSON.stringify(b64(GREEN))})); dt.items.add(mk('blue.png', ${JSON.stringify(b64(BLUE))}));
    const el = document.querySelector('[data-testid="media-upload-drop"]');
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await app.waitFor(`document.querySelectorAll('[data-testid="media-pending-row"]').length === 2`, 5000);
  const dropNames = await app.evaluate(`Array.from(document.querySelectorAll('[data-testid="media-pending-name"]')).map((el) => el.value)`);
  check('two dropped files become two rows named after the files, sanitised', JSON.stringify(dropNames) === '["green_one.png","blue.png"]', dropNames.join(','));
  await app.evaluate(`(() => { const el = document.querySelectorAll('[data-testid="media-pending-name"]')[1]; el.focus(); el.select(); })()`);
  await app.send('Input.insertText', { text: 'pasted_diagram.png' });
  await sleep(100);
  check('a name the library already has shows the -2 it will be stored as', /pasted_diagram-2\.png/.test(await app.evaluate(`document.querySelectorAll('[data-testid="media-pending-row"]')[1].textContent`)));
  await clickSel('[data-testid="media-upload-confirm"]');
  await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  stored = await names();
  check('Upload stores both, the second as pasted_diagram-2.png', JSON.stringify(stored) === '["green_one.png","pasted_diagram-2.png","pasted_diagram.png"]', stored.join(','));

  // ---- the file picker (a real file through DOM.setFileInputFiles), then Escape ----
  const pick = path.join(DATA, 'picked shot.png');
  writeFileSync(pick, RED);
  const doc = await app.send('DOM.getDocument', { depth: 1 });
  const node = await app.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '[data-testid="media-upload-input"]' });
  await app.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [pick] });
  await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  check('a file from the picker becomes a row named after the file', (await value('[data-testid="media-pending-name"]')) === 'picked_shot.png', await value('[data-testid="media-pending-name"]'));
  await keyChord('Escape', 'Escape', 27);
  await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  check('Escape cancels the pending row without storing', (await names()).length === 3);

  // ---- a text paste into the search field is not taken ----
  await clickSel('[data-testid="media-tab-browse"]');
  await app.waitFor(`!!document.querySelector('input[placeholder^="Search"]')`, 5000);
  const textConsumed = await app.evaluate(`(() => { const el = document.querySelector('input[placeholder^="Search"]'); el.focus(); const dt = new DataTransfer(); dt.setData('text/plain', 'hello'); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev.defaultPrevented; })()`);
  check('a text paste into the search field is left to the field (not consumed, nothing pending)', textConsumed === false && !(await has('[data-testid="media-pending-row"]')));

  // ---- an SVG with a script: stored, shown, nothing runs ----
  await clickSel('[data-testid="media-tab-upload"]');
  await app.waitFor(`!!document.querySelector('[data-testid="media-upload-drop"]')`, 5000);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>window.__svgRan = 1;</script><rect width="4" height="4" fill="red"/></svg>');
  await syntheticPaste('x.svg', 'image/svg+xml', b64(svg));
  await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  check('a pasted SVG is named with its type\'s extension', /\.svg$/.test(await value('[data-testid="media-pending-name"]')), await value('[data-testid="media-pending-name"]'));
  await keyChord('Enter', 'Enter', 13);
  await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  await clickSel('[data-testid="media-tab-browse"]');
  await app.waitFor(`Array.from(document.querySelectorAll('img')).some((i) => /\\.svg$/.test(i.alt))`, 5000);
  await app.evaluate(`(() => { const img = Array.from(document.querySelectorAll('img')).find((i) => /\\.svg$/.test(i.alt)); img.closest('[class*="aspect-square"]').click(); return true; })()`);
  await sleep(500);
  check('the SVG renders in Browse and in the preview (an <img>) and its script never runs', await app.evaluate(`document.querySelectorAll('img[alt$=".svg"]').length >= 2 && window.__svgRan === undefined`), String(await app.evaluate(`[document.querySelectorAll('img[alt$=".svg"]').length, window.__svgRan]`)));
  await keyChord('Escape', 'Escape', 27);
  check('no runtime exception', app.errors.length === 0, app.errors.join(' || ').slice(0, 300));
} catch (e) {
  check('media paste and rename run', false, e.stack || String(e));
} finally {
  await app.close();
  stopBackend();
}
console.log(`\nscreenshots: ${outDir}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
