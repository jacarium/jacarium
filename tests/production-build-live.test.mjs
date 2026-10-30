/**
 * The critical interactions against a PRODUCTION build of the UI - the
 * packaged app's build (minified, console dropped, production React) served
 * by `vite preview` - in headless Chrome over CDP with the real Flask
 * backend (tests/helpers/live-documents-app.mjs with build: 'production').
 *
 * Why: development React and production React commit a state update raised
 * inside a browser event at different moments. A capture-phase listener
 * that closed a menu before the item's own click ran left every item of the
 * Media Library's ... menu dead in the packaged app while every dev-server
 * test passed. Everything here runs through REAL mouse clicks and key events
 * (Input.dispatchMouseEvent / dispatchKeyEvent), the way the user does it:
 *
 *   - the build is a production one (no Vite client, no React development
 *     build, the app's console output dropped);
 *   - the Media Library's ... menu, every item: Preview (the lightbox),
 *     Edit Tags (the editor, a tag saved), Replace Image (replace mode),
 *     Download (the browser download is handed an anchor), Delete (the
 *     confirmation, cancelled), Insert into Document (the attachment: link
 *     in the editor);
 *   - the Upload tab's footer actions: a pending row, Cancel in the footer
 *     clears it, Upload in the footer stores;
 *   - Escape layering: the preview closes first, the library next, the
 *     focus back on the editor's Insert button;
 *   - the editor's right-click menu: Copy puts the selection on the
 *     clipboard, Paste reproduces it, Cut removes it, Escape closes the menu
 *     (the shared ContextMenu's keyboard handling);
 *   - the seasonal logo: hovering the rail's mark paints the hover tone.
 *
 * PROD_CHECKS=media-menu,upload,escape,editor-clipboard,logo-hover limits
 * the run to the named sections (all by default); PROD_VITE_PORT and
 * PROD_BACKEND_PORT pick other ports; PROD_BUILD=dev runs the same checks
 * on the dev server (to see what it hides; the suite runs the build).
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

// PROD_VITE_PORT / PROD_BACKEND_PORT: other ports when 5173 / 8080 are taken (the built app is told the backend's)
const VITE_PORT = Number(process.env.PROD_VITE_PORT || 5173);
const FLASK_PORT = Number(process.env.PROD_BACKEND_PORT || 8080);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!existsSync(PYTHON)) { console.log('SKIP: backend/venv missing'); process.exit(0); }
if (!(await portFree(VITE_PORT)) || !(await portFree(FLASK_PORT))) { console.log(`SKIP: port ${VITE_PORT} or ${FLASK_PORT} is busy`); process.exit(0); }
const SECTIONS = new Set((process.env.PROD_CHECKS || 'media-menu,upload,escape,editor-clipboard,logo-hover').split(',').map((s) => s.trim()).filter(Boolean));
const section = (name) => SECTIONS.has(name);

function png([r, g, b]) {
  const crc = (buf) => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(Buffer.from([0, r, g, b]));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const RED = png([255, 0, 0]), GREEN = png([0, 255, 0]);

const DATA = mkdtempSync(path.join(tmpdir(), 'production-live-data-'));
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

// PROD_BUILD=dev runs the same checks on the dev server - to see what the dev server hides, not for the suite
const BUILD = process.env.PROD_BUILD === 'dev' ? 'dev' : 'production';
const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'production-live-', build: BUILD, backendUrl: `http://localhost:${FLASK_PORT}` });
if (app.skip) { console.log(`SKIP: ${app.skip}`); stopBackend(); process.exit(0); }

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const has = (sel) => app.evaluate(`!!${q(sel)}`);
const text = (sel) => app.evaluate(`(${q(sel)} || {}).textContent || ''`);
const value = () => app.evaluate(`document.querySelector('textarea').value`);
const active = () => app.evaluate(`(() => { const a = document.activeElement; return a ? (a.getAttribute('data-testid') || a.tagName) : ''; })()`);
const keyChord = async (key, code, vk, modifiers = 0, commands = []) => {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, commands });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
};
const escape = async () => { await keyChord('Escape', 'Escape', 27); await sleep(300); };
// a REAL mouse click at the centre of an element (found by a selector, or by a selector and its text)
const clickAt = async (x, y) => {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(300);
};
const centreOf = (sel, re = null) => app.evaluate(`(() => { const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)})); const el = ${re ? `els.find((e) => ${re}.test(e.textContent.trim()))` : 'els[0]'}; if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const realClick = async (sel, re = null) => { const c = await centreOf(sel, re); if (!c) return false; await clickAt(c[0], c[1]); return true; };
const pickFiles = async (files) => {
  const doc = await app.send('DOM.getDocument', { depth: 1 });
  const node = await app.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '[data-testid="media-upload-input"]' });
  await app.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files });
};
const mediaNames = () => app.evaluate(`(async () => { const r = indexedDB.open(globalThis.__JACARIUM_DB_NAME || 'Jacarium'); const dbx = await new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); const all = await new Promise((res, rej) => { const t = dbx.transaction('media').objectStore('media').getAll(); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); dbx.close(); return all.map((m) => m.filename + (m.tags && m.tags.length ? '[' + m.tags.join(',') + ']' : '')).sort(); })()`);
const openLibraryFromEditor = async () => {
  await realClick('[data-testid="insert-menu-button"]');
  await app.waitFor(`!!document.querySelector('[data-testid="insert-menu"]')`, 5000);
  await realClick('[data-testid="insert-menu"] [role="menuitem"], [data-testid="insert-menu"] button', '/^Image$/');
  return app.waitFor(`!!document.querySelector('[data-testid="media-library"]')`, 8000);
};
const toBrowse = async () => { await realClick('[data-testid="media-tab-browse"]'); await app.waitFor(`Array.from(document.querySelectorAll('img[alt]')).some((i) => i.alt === 'pic.png')`, 5000); };
const openCardMenu = async () => {
  const c = await app.evaluate(`(() => { const img = Array.from(document.querySelectorAll('img[alt]')).find((i) => i.alt === 'pic.png'); const btn = img && img.closest('.group').querySelector('button[title="Actions"]'); if (!btn) return null; const r = btn.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!c) return false;
  await clickAt(c[0], c[1]);
  return app.waitFor(`!!document.querySelector('[data-testid="media-context-menu"]')`, 3000);
};
const menuItem = (label) => realClick('[data-testid="media-context-menu"] button', `/^${label}$/`);

try {
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await app.waitFor(`!!document.querySelector('[data-testid="brand-hero"]')`, 15000);
  if (BUILD === 'dev') console.log('INFO: PROD_BUILD=dev - the dev server, not the production build');
  check('the page is served from a production build (no Vite client script, hashed assets)', BUILD === 'dev' || (app.build === 'production' && await app.evaluate(`!document.querySelector('script[src*="@vite/client"]') && !!document.querySelector('script[src*="/assets/index-"], script[src^="./assets/index-"]')`)));
  check('...with production React (no development-only hook on the root) and the app\'s console output dropped', BUILD === 'dev' || await app.evaluate(`(() => { const root = document.getElementById('root'); const keys = root ? Object.keys(root) : []; const devRoot = keys.some((k) => k.startsWith('__reactContainer')) && !!(root && root._reactRootContainer && root._reactRootContainer._internalRoot && root._reactRootContainer._internalRoot.current && root._reactRootContainer._internalRoot.current.mode & 8); const hasDevtoolsGlobal = typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ === 'object' && window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers && Array.from(window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.values()).some((r) => r.bundleType === 1); return !devRoot && !hasDevtoolsGlobal; })()`));
  const created = await app.evaluate(`fetch('http://localhost:${FLASK_PORT}/api/auth/setup', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Jacarium' }, body: JSON.stringify({ setupCode: ${JSON.stringify(setupCode)}, username: 'alice', password: 'alices password', displayName: 'Alice Example' }) }).then((r) => r.status)`);
  check('the synthetic administrator is created and signed in (the built app reaches the backend)', created === 201, String(created));
  await app.send('Page.reload');
  await sleep(5000);
  await dismissWhatsNew(app);
  await app.waitFor(`!!document.querySelector('[data-testid="sidebar-brand-mark"]')`, 20000);
  check('the app is signed in after the reload (the built app found the backend through the seam)', await has('[data-testid="sidebar-brand-mark"]'));
  await createNewDocument(app);
  await app.waitFor(`!!document.querySelector('textarea')`, 10000);
  await app.evaluate(`(() => { if (!window.__anchorClicks) { window.__anchorClicks = 0; HTMLAnchorElement.prototype.click = function () { window.__anchorClicks += 1; }; } })()`);

  if (section('media-menu') || section('upload') || section('escape')) {
    // a stored image, through the picker + Enter
    check('the Media Library opens from the editor\'s Insert menu (real clicks)', await openLibraryFromEditor());
    await realClick('[data-testid="media-tab-upload"]');
    await app.waitFor(`!!document.querySelector('[data-testid="media-upload-input"]')`, 5000);
    const red = path.join(DATA, 'pic.png'); writeFileSync(red, RED);
    await pickFiles([red]);
    await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
    await keyChord('Enter', 'Enter', 13);
    await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
    check('(setup) pic.png is stored', (await mediaNames()).join(',') === 'pic.png', (await mediaNames()).join(','));
    await toBrowse();
  }

  if (section('media-menu')) {
    check('the ... menu opens with a real click and lists every item', await openCardMenu() && (await app.evaluate(`Array.from(document.querySelectorAll('[data-testid="media-context-menu"] button')).map((b) => b.textContent.trim()).join('|')`)) === 'Insert into Document|Preview|Edit Tags|Replace Image|Download|Delete', await app.evaluate(`Array.from(document.querySelectorAll('[data-testid="media-context-menu"] button')).map((b) => b.textContent.trim()).join('|')`));
    // Preview
    await menuItem('Preview');
    check('Preview opens the lightbox', await app.waitFor(`!!document.querySelector('[data-testid="media-preview"]')`, 3000) && !(await has('[data-testid="media-context-menu"]')));
    await escape();
    check('(Escape closes the lightbox)', !(await has('[data-testid="media-preview"]')) && await has('[data-testid="media-library"]'));
    // Edit Tags
    await openCardMenu();
    await menuItem('Edit Tags');
    check('Edit Tags opens the tag editor with its field focused', await app.waitFor(`!!document.querySelector('[data-testid="media-tag-editor"] input')`, 3000) && (await active()) === 'INPUT');
    await app.send('Input.insertText', { text: 'prod' });
    await keyChord('Enter', 'Enter', 13);
    await app.waitFor(`!document.querySelector('[data-testid="media-tag-editor"]')`, 3000);
    check('...and Enter saves the tag', (await mediaNames()).join(',') === 'pic.png[prod]', (await mediaNames()).join(','));
    // Replace Image
    await openCardMenu();
    await menuItem('Replace Image');
    check('Replace Image opens the Upload tab in replace mode', await app.waitFor(`!!document.querySelector('[data-testid="media-replace-banner"]')`, 3000) && /Replacing pic\.png/.test(await text('[data-testid="media-replace-banner"]')));
    await realClick('[data-testid="media-replace-cancel"]');
    await app.waitFor(`!document.querySelector('[data-testid="media-replace-banner"]')`, 3000);
    await toBrowse();
    // Download
    await app.evaluate(`window.__anchorClicks = 0; true`);
    await openCardMenu();
    await menuItem('Download');
    await sleep(300);
    check('Download hands the browser a download (an anchor click) and the menu closes', (await app.evaluate(`window.__anchorClicks`)) === 1 && !(await has('[data-testid="media-context-menu"]')), String(await app.evaluate(`window.__anchorClicks`)));
    // Delete
    await openCardMenu();
    await menuItem('Delete');
    check('Delete asks first', await app.waitFor(`/Delete Image/.test(document.body.textContent)`, 3000));
    await realClick('button', '/^Cancel$/');
    await sleep(300);
    check('...Cancel keeps the image', !/Delete Image/.test(await app.evaluate('document.body.textContent')) && (await mediaNames()).length === 1);
    // Insert into Document
    await openCardMenu();
    await menuItem('Insert into Document');
    await sleep(500);
    check('Insert into Document closes the library and puts the attachment: link in the editor', !(await has('[data-testid="media-library"]')) && /attachment:pic\.png/.test(await value()), (await value()).slice(0, 80));
  }

  if (section('upload')) {
    if (await has('[data-testid="media-library"]')) { await escape(); }
    check('the library opens again', await openLibraryFromEditor());
    await realClick('[data-testid="media-tab-upload"]');
    await app.waitFor(`!!document.querySelector('[data-testid="media-upload-input"]')`, 5000);
    const green = path.join(DATA, 'second.png'); writeFileSync(green, GREEN);
    await pickFiles([green]);
    await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
    check('a pending row puts Cancel and Upload in the footer, in view', await app.evaluate(`(() => { const panel = document.querySelector('[data-testid="media-library"]').getBoundingClientRect(); return ['media-upload-cancel', 'media-upload-confirm'].every((id) => { const r = document.querySelector('[data-testid="' + id + '"]').getBoundingClientRect(); return r.top >= panel.top && r.bottom <= panel.bottom && r.bottom <= window.innerHeight; }); })()`));
    await realClick('[data-testid="media-upload-cancel"]');
    await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 3000);
    check('Cancel in the footer (a real click) clears the row', !(await has('[data-testid="media-pending-row"]')) && (await mediaNames()).length === 1);
    await pickFiles([green]);
    await app.waitFor(`!!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
    await realClick('[data-testid="media-upload-confirm"]');
    await app.waitFor(`!document.querySelector('[data-testid="media-pending-row"]')`, 5000);
    check('Upload in the footer (a real click) stores the image', (await mediaNames()).some((n) => n.startsWith('second.png')), (await mediaNames()).join(','));
  }

  if (section('escape')) {
    if (!(await has('[data-testid="media-library"]'))) { check('the library opens for the Escape checks', await openLibraryFromEditor()); }
    await toBrowse();
    await app.evaluate(`(() => { const img = Array.from(document.querySelectorAll('img[alt]')).find((i) => i.alt === 'pic.png'); img.closest('[class*="aspect-square"]').click(); })()`);
    await app.waitFor(`!!document.querySelector('[data-testid="media-preview"]')`, 3000);
    await escape();
    check('Escape closes the preview first, the library stays', !(await has('[data-testid="media-preview"]')) && await has('[data-testid="media-library"]'));
    await escape();
    check('the next Escape closes the library, the focus back on the Insert button', !(await has('[data-testid="media-library"]')) && (await active()) === 'insert-menu-button', await active());
  }

  if (section('editor-clipboard')) {
    await app.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: `http://localhost:${VITE_PORT}` });
    await app.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); })()`);
    await app.send('Input.insertText', { text: 'alpha bravo charlie' });
    await sleep(500);
    const select = (a, b) => app.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.setSelectionRange(${a}, ${b}); return ta.value.slice(${a}, ${b}); })()`);
    const openEditorMenu = async () => {
      const b = await app.evaluate(`(() => { const r = document.querySelector('textarea').getBoundingClientRect(); return [r.left + 60, r.top + 30]; })()`);
      await app.evaluate(`document.querySelector('textarea').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${b[0]}, clientY: ${b[1]}, view: window })); true`);
      await app.waitFor(`!!document.querySelector('[data-testid="editor-context-menu"]')`, 3000);
      await sleep(300);
    };
    const readClip = () => app.evaluate(`navigator.clipboard.readText().catch((e) => 'ERROR ' + e.message)`);
    await select(6, 11);
    await openEditorMenu();
    check('the editor menu: Copy (a real click) puts the selection on the clipboard', await realClick('[data-testid="selection-copy"]') && (await readClip()) === 'bravo', await readClip());
    await select(19, 19);
    await openEditorMenu();
    await realClick('[data-testid="selection-paste"]');
    await sleep(300);
    check('Paste (a real click) reproduces it through the editor', (await value()) === 'alpha bravo charliebravo', await value());
    await select(12, 19);
    await openEditorMenu();
    await realClick('[data-testid="selection-cut"]');
    await sleep(300);
    check('Cut (a real click) removes the selection and puts it on the clipboard', (await value()) === 'alpha bravo bravo' && (await readClip()) === 'charlie', `${await value()} | ${await readClip()}`);
    await select(0, 5);
    await openEditorMenu();
    await escape();
    check('Escape closes the editor menu (the shared ContextMenu) and the editor keeps the focus', !(await has('[data-testid="editor-context-menu"]')) && (await active()) === 'TEXTAREA', await active());
  }

  if (section('logo-hover')) {
    // (no transitions: the hover tone is read right after the mouse moves)
    await app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }'; document.head.appendChild(s); })()`);
    const probe = () => app.evaluate(`(() => { const c = document.querySelector('[data-testid="sidebar-brand-mark"]'); const slot = c && (c.closest('button') || c); if (!slot) return null; const r = slot.getBoundingClientRect(); return { bg: getComputedStyle(slot).backgroundColor, box: [r.left + r.width / 2, r.top + r.height / 2] }; })()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 700 });
    await sleep(250);
    const rest = await probe();
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rest.box[0], y: rest.box[1] });
    await sleep(300);
    const hovered = await probe();
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 700 });
    await sleep(250);
    const after = await probe();
    check('hovering the seasonal logo paints the hover tone on its square, gone when the mouse leaves', rest && hovered && hovered.bg !== rest.bg && after.bg === rest.bg, JSON.stringify([rest?.bg, hovered?.bg, after?.bg]));
  }
  check('no runtime exception', app.errors.length === 0, app.errors.join(' || ').slice(0, 300));
} catch (e) {
  check('production build run', false, e.stack || String(e));
} finally {
  await app.close();
  stopBackend();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
