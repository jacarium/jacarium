/**
 * "Replace Image" in the Media Library, in the real browser (Chrome over
 * CDP, the Vite dev server and the Flask backend, like the other live
 * tests): signed in, a document open, the Media Library from the Documents
 * sidebar menu, a PNG stored through the picker, then
 *
 *   - the ... menu of the image offers Replace Image, which opens the
 *     Upload tab in replace mode: the banner "Replacing <name>" with the
 *     thumbnail and Cancel, the drop zone naming the type, the picker
 *     narrowed to one PNG;
 *   - a PNG from the picker (DOM.setFileInputFiles) is the single pending
 *     row, its name the image's own and read-only; a JPEG from the picker
 *     is refused inline with Replace disabled;
 *   - Replace asks "Replace <name>? Documents using it will show the new
 *     image."; after the confirmation the Browse tab lists the same name
 *     and IndexedDB holds the new bytes under it (one record, the same
 *     id);
 *   - Cancel on the banner leaves the plain Upload tab;
 *   - screenshots of replace mode with the pending row, dark and light,
 *     and of a refused type, in MEDIA_REPLACE_SHOTS_DIR (default: a temp dir).
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
const RED = png([255, 0, 0]), GREEN = png([0, 255, 0]);
// a JPEG by its signature only (the type check reads the declared type and the first bytes; nothing decodes it)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

const DATA = mkdtempSync(path.join(tmpdir(), 'media-replace-data-'));
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

const outDir = process.env.MEDIA_REPLACE_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'media-replace-shots-'));
mkdirSync(outDir, { recursive: true });
const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'media-replace-' });
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
const attr = (sel, name) => app.evaluate(`(${q(sel)} || { getAttribute: () => null }).getAttribute(${JSON.stringify(name)})`);
const clickSel = (sel) => app.evaluate(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`);
const clickText = (tag, re) => app.evaluate(`(() => { const el = Array.from(document.querySelectorAll(${JSON.stringify(tag)})).find((b) => ${re}.test(b.textContent.trim())); if (!el) return false; el.click(); return true; })()`);
const keyChord = async (key, code, vk) => {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};
const pickFile = async (file) => {
  const doc = await app.send('DOM.getDocument', { depth: 1 });
  const node = await app.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '[data-testid="media-upload-input"]' });
  await app.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [file] });
};
// the media records as IndexedDB holds them: name, id, and the bytes as base64
const records = () => app.evaluate(`(async () => { const r = indexedDB.open(globalThis.__JACARIUM_DB_NAME || 'Jacarium'); const dbx = await new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); const all = await new Promise((res, rej) => { const t = dbx.transaction('media').objectStore('media').getAll(); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); dbx.close(); const out = []; for (const m of all) { const buf = new Uint8Array(await m.blob.arrayBuffer()); let s = ''; for (const b of buf) s += String.fromCharCode(b); out.push({ id: m.id, filename: m.filename, mimeType: m.mimeType, size: m.size, tags: m.tags, b64: btoa(s), updatedAt: m.updatedAt || null }); } return out; })()`);
const cardMenu = (name) => app.evaluate(`(() => { const img = Array.from(document.querySelectorAll('img[alt]')).find((i) => i.alt === ${JSON.stringify(name)}); const btn = img && img.closest('.group') && img.closest('.group').querySelector('button[title="Actions"]'); if (!btn) return false; btn.click(); return true; })()`);
const confirmReplace = () => app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Replace' && el.className.includes('btn-brand')); if (!b) return false; b.click(); return true; })()`);

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

  // ---- the Media Library, a PNG stored through the picker ----
  const menuOpened = await clickSel('[data-testid="documents-sidebar-menu"]') || await clickText('button', '/^Menu$|^More$/') || await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => /menu/i.test(el.getAttribute('title') || el.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true; })()`);
  await sleep(300);
  const itemClicked = await clickText('button', '/^Media Library$/');
  check('the Media Library opens from the Documents sidebar menu', menuOpened && itemClicked && await app.waitFor(`!!document.querySelector('[data-testid="media-tab-upload"]')`, 8000), `${menuOpened} ${itemClicked}`);
  await clickSel('[data-testid="media-tab-upload"]');
  await app.waitFor(`!!document.querySelector('[data-testid="media-upload-drop"]')`, 5000);
  const redFile = path.join(DATA, 'diagram.png');
  writeFileSync(redFile, RED);
  await pickFile(redFile);
  await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  await clickSel('[data-testid="media-upload-confirm"]');
  await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  let recs = await records();
  check('(setup) diagram.png is stored with the red pixel', recs.length === 1 && recs[0].filename === 'diagram.png' && recs[0].b64 === RED.toString('base64'), JSON.stringify(recs.map((r) => r.filename)));
  const originalId = recs[0]?.id;

  // ---- Replace Image from the ... menu ----
  await clickSel('[data-testid="media-tab-browse"]');
  await app.waitFor(`Array.from(document.querySelectorAll('img[alt]')).some((i) => i.alt === 'diagram.png')`, 5000);
  check('the image card\'s menu opens', await cardMenu('diagram.png') && await app.waitFor(`!!document.querySelector('[data-testid="media-menu-replace"]')`, 3000));
  check('...with Replace Image between Edit Tags and Download', await app.evaluate(`(() => { const items = Array.from(document.querySelector('[data-testid="media-menu-replace"]').parentElement.querySelectorAll('button')).map((b) => b.textContent.trim()); return items.join('|'); })()`) === 'Preview|Edit Tags|Replace Image|Download|Delete', await app.evaluate(`Array.from(document.querySelector('[data-testid="media-menu-replace"]').parentElement.querySelectorAll('button')).map((b) => b.textContent.trim()).join('|')`));
  await clickSel('[data-testid="media-menu-replace"]');
  await app.waitFor(`!!document.querySelector('[data-testid="media-replace-banner"]')`, 5000);
  check('the Upload tab opens in replace mode: the banner names the image, shows its thumbnail and a Cancel', /Replacing diagram\.png/.test(await text('[data-testid="media-replace-banner"]')) && await has('[data-testid="media-replace-banner"] img') && await has('[data-testid="media-replace-cancel"]'));
  check('the drop zone names the type and the picker takes one PNG', /Drag and drop a PNG image here/.test(await text('[data-testid="media-upload-drop"]')) && (await text('[data-testid="media-upload-hint"]')) === 'Accepts: PNG only (the current image is a PNG)' && (await attr('[data-testid="media-upload-input"]', 'accept')) === 'image/png,.png' && !(await app.evaluate(`${q('[data-testid="media-upload-input"]')}.multiple`)), await attr('[data-testid="media-upload-input"]', 'accept'));

  // a JPEG through the picker: refused inline
  const jpegFile = path.join(DATA, 'photo.jpg');
  writeFileSync(jpegFile, JPEG);
  await pickFile(jpegFile);
  await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  await sleep(300);
  check('a JPEG from the picker is refused inline and Replace stays disabled', /Replace with a PNG image \(the current image is a PNG\)/.test(await text('[data-testid="media-pending"]')) && await app.evaluate(`${q('[data-testid="media-upload-confirm"]')}.disabled`), await text('[data-testid="media-pending"]'));
  await setTheme('light');
  const refusedShot = await shot('media-replace-refused-light');
  check('the refusal renders', pixelSpread(refusedShot) > 40);
  await clickSel('[data-testid="media-upload-cancel"]');
  await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  check('Cancel on the row keeps replace mode', await has('[data-testid="media-replace-banner"]'));

  // the green PNG: the pending row, screenshots, then Replace
  const greenFile = path.join(DATA, 'new version.png');
  writeFileSync(greenFile, GREEN);
  await pickFile(greenFile);
  await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
  await sleep(300);
  check('the PNG is the single pending row, named after the image being replaced and read-only', (await value('[data-testid="media-pending-name"]')) === 'diagram.png' && await app.evaluate(`${q('[data-testid="media-pending-name"]')}.readOnly`) && (await app.evaluate(`document.querySelectorAll('[data-testid="media-pending-row"]').length`)) === 1 && (await text('[data-testid="media-upload-confirm"]')) === 'Replace' && !(await app.evaluate(`${q('[data-testid="media-upload-confirm"]')}.disabled`)));
  for (const theme of ['dark', 'light']) { await setTheme(theme); const f = await shot(`media-replace-${theme}`); check(`replace mode renders (${theme})`, pixelSpread(f) > 40); }
  await setTheme('light');
  await clickSel('[data-testid="media-upload-confirm"]');
  await app.waitFor(`/Replace diagram\\.png\\?/.test(document.body.textContent)`, 5000);
  check('Replace asks first', /Replace diagram\.png\? Documents using it will show the new image\./.test(await app.evaluate('document.body.textContent')));
  recs = await records();
  check('nothing changed before the confirmation', recs.length === 1 && recs[0].b64 === RED.toString('base64'));
  check('the confirmation is clicked', await confirmReplace());
  await app.waitFor(`Array.from(document.querySelectorAll('img[alt]')).some((i) => i.alt === 'diagram.png') && !document.querySelector('[data-testid="media-replace-banner"]')`, 8000);
  recs = await records();
  check('the Browse tab lists the same name; IndexedDB holds the new bytes under it, one record, the same id, updatedAt set', recs.length === 1 && recs[0].filename === 'diagram.png' && recs[0].id === originalId && recs[0].b64 === GREEN.toString('base64') && recs[0].size === GREEN.length && !!recs[0].updatedAt, JSON.stringify(recs.map((r) => [r.filename, r.size, r.updatedAt])));
  check('the card shows the new image (its src is a fresh object URL that loads)', await app.evaluate(`(async () => { const img = Array.from(document.querySelectorAll('img[alt]')).find((i) => i.alt === 'diagram.png'); if (!img) return false; if (!img.complete) await new Promise((res) => { img.onload = res; img.onerror = res; }); const c = document.createElement('canvas'); c.width = 1; c.height = 1; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return d[1] > 200 && d[0] < 60; })()`));

  // ---- Cancel on the banner ----
  check('the menu opens again', await cardMenu('diagram.png') && await app.waitFor(`!!document.querySelector('[data-testid="media-menu-replace"]')`, 3000));
  await clickSel('[data-testid="media-menu-replace"]');
  await app.waitFor(`!!document.querySelector('[data-testid="media-replace-banner"]')`, 5000);
  await clickSel('[data-testid="media-replace-cancel"]');
  await app.waitFor(`!document.querySelector('[data-testid="media-replace-banner"]')`, 5000);
  check('Cancel on the banner leaves the plain Upload tab', /Upload Images/.test(await text('[data-testid="media-upload-drop"]')) && (await attr('[data-testid="media-upload-input"]', 'accept')) === 'image/*');
  await keyChord('Escape', 'Escape', 27);
  check('no runtime exception', app.errors.length === 0, app.errors.join(' || ').slice(0, 300));
} catch (e) {
  check('media replace run', false, e.stack || String(e));
} finally {
  await app.close();
  stopBackend();
}
console.log(`\nscreenshots: ${outDir}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
