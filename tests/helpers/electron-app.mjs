/**
 * Launch the REAL Electron app for a test, driven with Playwright's
 * _electron API (same launch recipe as tests/diagnostics-live-driver.mjs,
 * which stays the interactive tool). playwright-core is a pinned
 * devDependency: installing it `--no-save` on demand, as the driver does,
 * made npm prune the suite's other `--no-save` test packages (jsdom,
 * fake-indexeddb) mid-run; the on-demand install below is only a fallback.
 *
 *   - starts the Vite dev server on :5173 (the only origin the backend's
 *     CORS allow-list and electron/main.cjs's DEV_SERVER_URL agree on);
 *   - points Electron's userData at a throwaway directory
 *     (JACARIUM_USER_DATA_DIR, honoured by main.cjs in development
 *     only), so the app starts with an EMPTY IndexedDB and never reads or
 *     writes the user's own documents;
 *   - returns the first window as a Playwright Page plus helpers to create
 *     a document, type markdown into the editor, trigger Export PDF from
 *     the sidebar context menu and capture the PDF bytes the export hands
 *     to the browser's download path.
 *
 * launchElectronApp() resolves to { skip: reason } (not an error) when
 * SKIP_ELECTRON_TESTS is set, when playwright-core cannot be installed, or
 * when the dev server / app window do not come up, so tests exit 0 with a
 * SKIP line and ./tests/run-all.sh stays green on machines that cannot run
 * a GUI app.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VITE_PORT = 5173;

const stop = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode) return resolve();
  child.once('exit', resolve);
  child.kill();
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
});

async function ensurePlaywright() {
  if (!existsSync(path.join(REPO, 'node_modules', 'playwright-core'))) {
    try {
      execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'playwright-core'], { cwd: REPO, stdio: 'ignore' });
    } catch {
      return null;
    }
  }
  try {
    return (await import('playwright-core'))._electron;
  } catch {
    return null;
  }
}

/**
 * @param {{ profilePrefix?: string }} [options]
 * @returns {Promise<{ skip: string } | {
 *   app: import('playwright-core').ElectronApplication,
 *   page: import('playwright-core').Page,
 *   userDataDir: string,
 *   close: () => Promise<void>,
 * }>}
 */
export async function launchElectronApp({ profilePrefix = 'electron-test-', args = [], env = {}, expectWindow = null } = {}) {
  if (process.env.SKIP_ELECTRON_TESTS) {
    return { skip: 'SKIP_ELECTRON_TESTS is set - not launching the Electron app.' };
  }
  const electron = await ensurePlaywright();
  if (!electron) return { skip: 'playwright-core is not available (npm install --no-save playwright-core failed) - Electron test skipped.' };

  const url = `http://localhost:${VITE_PORT}/`;
  // A dev server already running on :5173 (a developer's `npm run dev`, or
  // one started by hand to read its output while debugging) is reused and
  // left running; otherwise one is started here and stopped on close().
  let vite = null;
  let ready = false;
  try { ready = (await fetch(url)).ok; } catch { /* not running */ }
  if (!ready) {
    vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(VITE_PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
    for (let i = 0; i < 240 && !ready; i++) {
      try { ready = (await fetch(url)).ok; } catch { await sleep(250); }
    }
  }
  if (!ready) {
    await stop(vite);
    return { skip: `Vite dev server did not come up on :${VITE_PORT} (port in use?) - Electron test skipped.` };
  }

  const userDataDir = mkdtempSync(path.join(tmpdir(), profilePrefix));
  let app = null;
  const close = async () => {
    try { if (app) await app.close(); } catch { /* already closed */ }
    await stop(vite);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  try {
    app = await electron.launch({
      args: [REPO, ...args],
      cwd: REPO,
      env: { ...process.env, JACARIUM_USER_DATA_DIR: userDataDir, NODE_ENV: 'development', ...env },
      timeout: 60000,
    });
    // In development the app also opens DevTools, which Playwright reports
    // as a window of its own (devtools://...) and may hand out first: pick
    // the window that shows the app (or the one `expectWindow` matches,
    // e.g. the profile picker's file:// page).
    const wanted = expectWindow || ((w) => w.url().startsWith(url));
    let page = null;
    for (let i = 0; i < 240 && !page; i++) {
      page = app.windows().find(wanted) || null;
      if (!page) await sleep(250);
    }
    if (!page) throw new Error(`no window at ${url}`);
    await page.waitForLoadState('domcontentloaded');
    if (expectWindow) return { app, page, userDataDir, close };
    // Known light state + the first-run What's New window dismissed
    await page.waitForTimeout(4000);
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    for (let i = 0; i < 10; i++) {
      const closed = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Got it!'); if (!b) return false; b.click(); return true; });
      if (closed) break;
      await page.waitForTimeout(300);
    }
    return { app, page, userDataDir, close };
  } catch (err) {
    await close();
    return { skip: `Electron app did not start (${err?.message || err}) - Electron test skipped.` };
  }
}

/** Click the empty-state "New Document" button on the Documents page. */
export async function createNewDocument(page) {
  const ok = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'New Document'); if (!b) return false; b.click(); return true; });
  await page.waitForTimeout(1500);
  return ok;
}

/** Replace the editor textarea's text and let autosave run. */
export async function setEditorText(page, text) {
  const ta = page.locator('textarea').first();
  await ta.click();
  await ta.fill(text);
  await page.waitForTimeout(1500);
}

/**
 * Export the current document as PDF through the sidebar context menu and
 * return the bytes (captured from the download the export triggers), or
 * null when the menu/button was not found or nothing arrived in time.
 */
export async function exportDocumentPdf(page, { timeoutMs = 120000, title = /Untitled/i, pageSize = null, landscape = null } = {}) {
  await page.evaluate(() => {
    if (!window.__pdfCaptureInstalled) {
      window.__pdfCaptureInstalled = true;
      const origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { if (blob && blob.type === 'application/pdf') (window.__pdfBlobs = window.__pdfBlobs || []).push(blob); return origCreate(blob); };
      HTMLAnchorElement.prototype.click = function () { /* no download */ };
    }
    window.__pdfBlobs = [];
    for (const b of document.querySelectorAll('button[title="Expand"]')) b.click();
  });
  await page.waitForTimeout(400);
  const opened = await page.evaluate((titleSource) => {
    const re = new RegExp(titleSource, 'i');
    const matches = Array.from(document.querySelectorAll('span, div, p')).filter((e) => e.children.length === 0 && re.test(e.textContent));
    if (!matches.length) return false;
    const target = matches.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    const r = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 10, clientY: r.top + 5, view: window }));
    return true;
  }, title.source);
  if (!opened) return null;
  await page.waitForTimeout(300);
  const clicked = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Export PDF'); if (!b) return false; b.click(); return true; });
  if (!clicked) return null;
  // The options dialog (page size / orientation): set what was asked for,
  // then its Export button starts the export
  const dialog = await page.waitForSelector('#pdf-export-page-size', { timeout: 10000 }).catch(() => null);
  if (!dialog) return null;
  await page.evaluate(({ pageSize: ps, landscape: ls }) => {
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (!el || value == null) return;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('pdf-export-page-size', ps);
    set('pdf-export-orientation', ls == null ? null : (ls ? 'landscape' : 'portrait'));
  }, { pageSize, landscape });
  await page.waitForTimeout(200);
  const started = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Export' && el.closest('.bg-os-modal')); if (!b) return false; b.click(); return true; });
  if (!started) return null;
  const deadline = Date.now() + timeoutMs;
  let b64 = null;
  while (!b64 && Date.now() < deadline) {
    await page.waitForTimeout(400);
    b64 = await page.evaluate(async () => { const b = window.__pdfBlobs && window.__pdfBlobs[0]; if (!b) return null; const buf = await b.arrayBuffer(); let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); });
  }
  // Dismiss the export progress modal ("Done" after success, "Close"
  // otherwise) so the editor is clickable again, then any leftover menu
  for (let i = 0; i < 20; i++) {
    const closed = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => /^(Done|Close)$/.test(el.textContent.trim())); if (!b) return false; b.click(); return true; });
    if (!closed) break;
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => document.body.click());
  return b64 ? Buffer.from(b64, 'base64') : null;
}

/** The export progress modal's log lines and heading (for cancel/error checks). */
export function readExportModal(page) {
  return page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll('h2, h3')).map((h) => h.textContent.trim()).find((t) => /^Export/.test(t)) || null;
    const logs = Array.from(document.querySelectorAll('.os-terminal, [class*="terminal"]')).flatMap((t) => t.textContent.split('\n')).map((s) => s.trim()).filter(Boolean);
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim()).filter((t) => /Cancel export|Close|Done/.test(t));
    return { heading, logs, buttons };
  });
}

/**
 * The Electron app behind the same driver shape as
 * tests/helpers/live-documents-app.mjs's launchDocumentsApp():
 *   { evaluate(expression), send(cdpMethod, params), waitFor, errors, close }
 * so the live Documents tests (and that module's action helpers:
 * createNewDocument, setEditorContent, exportDocumentPdf, ...) run
 * unchanged against the real app. `send` goes through a Playwright CDP
 * session and resolves `{ result }` like the raw-WebSocket driver did.
 */
export async function launchElectronDocumentsApp({ profilePrefix = 'electron-documents-' } = {}) {
  const launched = await launchElectronApp({ profilePrefix });
  if (launched.skip) return launched;
  const { page, close } = launched;
  const errors = [];
  page.on('pageerror', (err) => errors.push('EXCEPTION: ' + (err?.message || String(err))));
  const cdp = await page.context().newCDPSession(page);
  const send = async (method, params = {}) => ({ result: await cdp.send(method, params) });
  const evaluate = (expression) => page.evaluate(expression);
  const waitFor = async (expression, timeoutMs, stepMs = 250) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(stepMs);
    }
    return last;
  };
  return { evaluate, send, waitFor, errors, close, page, app: launched.app };
}
