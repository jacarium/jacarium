/**
 * Real-browser driver for the Documents page: a Vite dev server plus
 * headless Chrome controlled over CDP, with the handful of UI actions the
 * PDF-export tests need (new document, type markdown, Export PDF via the
 * sidebar context menu, capture the PDF blob the export hands to the browser).
 *
 * Every session uses a throwaway Chrome profile (fresh IndexedDB - never the
 * user's documents) and forces the app into its light theme so results do
 * not depend on the machine's prefers-color-scheme.
 *
 * launchDocumentsApp() resolves to { skip: reason } (not an error) when no
 * Chrome/Chromium binary is found or SKIP_BROWSER_TESTS is set, so callers
 * can exit 0 with a SKIP line and ./tests/run-all.sh stays green on machines
 * without a browser. Set CHROME_BIN=/path/to/chrome to run there.
 *
 * Same conventions as tests/documents-pdf-export-smoke.mjs and
 * tests/documents-mermaid-live.test.mjs (which predate this helper and keep
 * their own inline copies).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './reap.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) || null;
}

const stop = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode) return resolve();
  child.once('exit', resolve);
  child.kill();
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
});

/**
 * @param {{ port: number, profilePrefix?: string }} options
 * @returns {Promise<{ skip: string } | {
 *   evaluate: (expression: string) => Promise<any>,
 *   send: (method: string, params?: object) => Promise<any>,
 *   waitFor: (expression: string, timeoutMs: number, stepMs?: number) => Promise<any>,
 *   errors: string[],
 *   close: () => Promise<void>,
 * }>}
 */
export async function launchDocumentsApp({ port, profilePrefix = 'documents-live-', debugPort = port + 1000, chromeArgs = [] }) {
  // debugPort / chromeArgs: a second Chrome against the SAME Vite port (two
  // browser contexts with their own storage, as two teammates) needs its own
  // CDP port; chromeArgs adds flags such as --ignore-certificate-errors.
  if (process.env.SKIP_BROWSER_TESTS) {
    return { skip: 'SKIP_BROWSER_TESTS is set - not launching Chrome. Unset it to run this real-browser check.' };
  }
  const chromeBin = findChrome();
  if (!chromeBin) {
    return { skip: 'no Chrome/Chromium binary found - set CHROME_BIN=/path/to/chrome to run this real-browser check.' };
  }
  const url = `http://localhost:${port}/`;

  // (Chrome and Vite die with this process, however it ends: an interrupted
  // test must not leave a signed-in tab polling the backend port for days -
  // tests/helpers/reap.mjs)
  const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) { // up to 60s: Vite may re-optimize deps after a lockfile change
    try { ready = (await fetch(url)).ok; } catch { await sleep(250); }
  }
  if (!ready) {
    await stop(vite);
    return { skip: `Vite dev server did not come up on :${port} (port in use?) - set SMOKE_PORT to another port and re-run.` };
  }

  const profile = mkdtempSync(path.join(tmpdir(), profilePrefix));
  const chrome = reapOnExit(spawn(chromeBin, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1400,900',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, ...chromeArgs, 'about:blank',
  ], { stdio: 'ignore' }));
  let ws = null;
  const close = async () => {
    try { ws && ws.close(); } catch { /* already closed */ }
    await stop(chrome);
    await stop(vite);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    let targets;
    for (let i = 0; i < 40 && !targets; i++) {
      try { targets = await (await fetch(`http://localhost:${debugPort}/json`)).json(); } catch { await sleep(250); }
    }
    const page = targets.find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));

    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
      return r.result?.result?.value;
    };
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

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url });
    await sleep(5000);
    // Known light state: ThemeContext's default is 'auto' (prefers-color-scheme)
    await evaluate(`document.documentElement.classList.remove('dark')`);

    return { evaluate, send, waitFor, errors, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Click the empty-state "New Document" button; true when it existed. */
export async function createNewDocument(app) {
  const ok = await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'New Document'); if (!b) return false; b.click(); return true; })()`);
  await sleep(1500);
  return ok;
}

/**
 * Create another document with the Documents sidebar header's "+" button
 * (title "Add new"); the new document becomes the current one and opens in
 * its own tab. Returns true when the button existed.
 */
export async function createDocumentViaSidebar(app) {
  const ok = await app.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button[title="Add new"]'));
    // Several sidebars can carry an add button; take the one under the
    // "Documents" header.
    const b = buttons.find((el) => /Documents/.test((el.closest('div')?.parentElement?.textContent) || '')) || buttons[0];
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1500);
  return ok;
}

/** The open editor tabs (TabBar) in open order, as their visible titles. */
export function openTabTitles(app) {
  return app.evaluate(`Array.from(document.querySelectorAll('div[draggable="true"]')).filter(t => t.closest('.flex') && t.textContent.trim()).map(t => t.textContent.trim())`);
}

/** Switch to the n-th open tab (0-based, open order) by clicking it. */
export async function clickTab(app, index) {
  const ok = await app.evaluate(`(() => { const tabs = Array.from(document.querySelectorAll('div[draggable="true"]')); const t = tabs[${index}]; if (!t) return false; t.click(); return true; })()`);
  await sleep(800);
  return ok;
}

/**
 * Press the editor toolbar's preview button once. It cycles
 * OFF -> Preview -> Preview (all documents) -> OFF; a second click within 1s
 * of entering Preview escalates to the global "all documents" mode, so
 * callers that want plain on/off leave a pause between clicks.
 */
export async function clickPreviewButton(app) {
  const ok = await app.evaluate(`(() => { const b = document.querySelector('button[title="Preview"], button[title="Edit"], button[title^="Preview (all documents)"]'); if (!b) return false; b.click(); return true; })()`);
  await sleep(800);
  return ok;
}

/**
 * Snapshot of what the editor pane shows RIGHT NOW, without touching it:
 * whether the preview pane or the textarea is mounted, the textarea's text,
 * and the line-number gutter's state (computed visibility of the numbers
 * block and how many line rows it holds). `previewTitle` is the toolbar
 * button's current title, i.e. the mode the editor believes it is in.
 */
export function readEditorState(app) {
  return app.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    const preview = document.querySelector('.markdown-preview');
    const btn = document.querySelector('button[title="Preview"], button[title="Edit"], button[title^="Preview (all documents)"]');
    // Gutter: the 48px column left of the textarea; its inner block toggles
    // visibility until the textarea has been measured.
    let gutter = null;
    if (ta) {
      const column = Array.from(document.querySelectorAll('div')).find((d) => d.style && d.style.width === '48px' && d.firstElementChild && d.parentElement && d.parentElement.contains(ta));
      const block = column && column.firstElementChild;
      if (block) {
        gutter = { visibility: getComputedStyle(block).visibility, rows: block.children.length, numbers: Array.from(block.children).slice(0, 3).map((c) => c.textContent).join(',') };
      }
    }
    return {
      previewOpen: !!preview,
      previewText: preview ? preview.textContent.trim().slice(0, 80) : null,
      hasTextarea: !!ta,
      textareaValue: ta ? ta.value : null,
      textareaLines: ta ? ta.value.split('\\n').length : null,
      gutter,
      previewTitle: btn ? btn.title : null,
    };
  })()`);
}

/** Replace the editor's whole text (select-all + insertText) and let autosave run. */
export async function setEditorContent(app, text) {
  await app.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.select(); })()`);
  await app.send('Input.insertText', { text });
  await sleep(1500);
  return app.evaluate(`document.querySelector('textarea') && document.querySelector('textarea').value`);
}

/**
 * Run "Export PDF" from the sidebar context menu of the (only) document and
 * return the PDF bytes the export produced, or null on timeout. The blob capture
 * is installed once per page (the export's download goes through
 * URL.createObjectURL + an anchor click, which headless Chrome cannot
 * download).
 */
export async function exportDocumentPdf(app, { timeoutMs = 90000, title = /Untitled/i } = {}) {
  await app.evaluate(`(() => {
    if (!window.__pdfCaptureInstalled) {
      window.__pdfCaptureInstalled = true;
      const origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { if (blob && blob.type === 'application/pdf') (window.__pdfBlobs = window.__pdfBlobs || []).push(blob); return origCreate(blob); };
      HTMLAnchorElement.prototype.click = function () { /* no download in headless */ };
    }
    window.__pdfBlobs = [];
    // Fresh profile: sidebar categories start collapsed - expand them so the
    // document row (and its context menu) exists
    for (const b of document.querySelectorAll('button[title="Expand"]')) b.click();
  })()`);
  await sleep(400);
  // The document title appears both in the editor tab bar and in the sidebar
  // list; the sidebar row is the leftmost match and owns the context menu.
  const opened = await app.evaluate(`(() => {
    const matches = Array.from(document.querySelectorAll('span, div, p')).filter(e => e.children.length === 0 && ${title.toString()}.test(e.textContent));
    if (!matches.length) return false;
    const target = matches.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    const r = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 10, clientY: r.top + 5, view: window }));
    return true;
  })()`);
  if (!opened) return null;
  await sleep(300);
  const clicked = await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Export PDF'); if (!b) return false; b.click(); return true; })()`);
  if (!clicked) return null;
  // The options dialog (page size / orientation) with its remembered or
  // default choice: its Export button starts the export
  const started = await app.waitFor(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Export' && el.closest('.bg-os-modal') && document.getElementById('pdf-export-page-size')); if (!b) return false; b.click(); return true; })()`, 10000);
  if (!started) return null;
  let b64 = null;
  const deadline = Date.now() + timeoutMs;
  while (!b64 && Date.now() < deadline) {
    await sleep(400);
    b64 = await app.evaluate(`(async () => { const b = window.__pdfBlobs && window.__pdfBlobs[0]; if (!b) return null; const buf = await b.arrayBuffer(); let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); })()`);
  }
  // dismiss any context menu left open
  await app.evaluate(`document.body.click()`);
  return b64 ? Buffer.from(b64, 'base64') : null;
}
