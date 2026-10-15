/**
 * Shared harness for the Linux-container browser checks under tests/linux/.
 *
 * Drives the REAL app (Vite dev server) in a REAL Chromium over CDP - no
 * test framework, no extra npm dependencies. Designed to run inside the
 * container started by tests/linux/run.sh (Debian Chromium, classic
 * scrollbars, Linux fonts) but works on any machine that has Chrome/Chromium
 * (set CHROME_BIN), which is handy for comparing platforms side by side.
 *
 * Everything here uses a throwaway Chromium profile (fresh IndexedDB /
 * localStorage - never the user's data) and synthetic fixture data only.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const OUT_DIR = process.env.LINUX_OUT || path.join(REPO, 'tests', 'linux', 'out');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IN_CONTAINER = process.env.LINUX_CONTAINER === '1' || existsSync('/run/.containerenv') || existsSync('/.dockerenv');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

export function findChromium() {
  const bin = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!bin) {
    console.error('FAIL: no Chrome/Chromium binary found - set CHROME_BIN=/path/to/chromium (or run via tests/linux/run.sh)');
    process.exit(1);
  }
  return bin;
}

export function ensureOutDir() {
  mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

/** Kill a child process, escalating to SIGKILL after 3s. */
export const stop = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode) return resolve();
  child.once('exit', resolve);
  child.kill();
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
});

/**
 * Start the Vite dev server on a fixed port and wait until it answers.
 * @returns {{ url: string, proc: import('node:child_process').ChildProcess, stop: () => Promise<void> }}
 */
export async function startVite({ port = Number(process.env.SMOKE_PORT || 5198), host = '127.0.0.1' } = {}) {
  // --config: the repo config without file watching (see lib/vite.config.mjs)
  const args = [
    path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', path.join(REPO, 'tests', 'linux', 'lib', 'vite.config.mjs'),
    '--port', String(port), '--strictPort', '--host', host,
  ];
  const proc = spawn(process.execPath, args, { cwd: REPO, stdio: 'ignore' });
  const url = `http://${host}:${port}/`;
  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) { // up to 60s: Vite may (re)optimize deps on first run
    try { ready = (await fetch(url)).ok; } catch { await sleep(250); }
  }
  if (!ready) {
    await stop(proc);
    console.error(`FAIL: Vite dev server did not come up on :${port}`);
    process.exit(1);
  }
  // Warm up: the first request for the entry module starts Vite's dependency
  // pre-bundling, and module requests stall until it finishes (minutes on a
  // cold, small VM). Kick it off and wait for a pre-bundled chunk to be served
  // so the browser never sits on a half-ready server.
  try { await fetch(url + 'src/main.jsx'); } catch { /* server restarts are handled below */ }
  for (let i = 0; i < 1200; i++) { // up to 5 minutes
    try {
      const r = await fetch(url + 'node_modules/.vite/deps/react-dom_client.js');
      if (r.ok && (await r.text()).length > 0) break;
    } catch { /* not yet */ }
    await sleep(250);
  }
  return { url, proc, stop: () => stop(proc) };
}

/**
 * Launch headless Chromium with remote debugging.
 * `overlayScrollbars: true` opts into Chromium's overlay scrollbars on Linux
 * (the macOS-like, zero-width kind); the default is the platform's native
 * scrollbars, i.e. classic layout-taking ones on Linux.
 */
export async function launchChromium({
  debugPort = Number(process.env.SMOKE_PORT || 5198) + 1000,
  width = 1400,
  height = 900,
  overlayScrollbars = false,
  extraFlags = [],
} = {}) {
  const bin = findChromium();
  const profile = mkdtempSync(path.join(tmpdir(), 'jacarium-linux-'));
  const flags = [
    '--headless=new', '--disable-gpu', '--no-first-run', `--window-size=${width},${height}`,
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    ...(IN_CONTAINER || process.getuid?.() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ...(overlayScrollbars ? ['--enable-features=OverlayScrollbar'] : []),
    ...extraFlags,
    'about:blank',
  ];
  const proc = spawn(bin, flags, { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 80 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); } catch { await sleep(250); }
  }
  if (!targets) {
    await stop(proc);
    console.error(`FAIL: Chromium (${bin}) did not expose DevTools on :${debugPort}`);
    process.exit(1);
  }
  const page = targets.find((t) => t.type === 'page');
  return {
    bin, profile, proc, page,
    stop: async () => {
      await stop(proc);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/**
 * Connect to a page target over CDP.
 * @returns {{ send, evaluate, screenshot, nextFrame, errors, close }}
 */
export async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
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
  /** Save a PNG into OUT_DIR; `clip` = {x, y, width, height} in CSS px (2x scale). */
  const screenshot = async (name, clip) => {
    ensureOutDir();
    const r = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...(clip ? { clip: { ...clip, scale: 2 } } : {}),
    });
    const file = path.join(OUT_DIR, name.endsWith('.png') ? name : `${name}.png`);
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };
  const nextFrame = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await send('Runtime.enable');
  await send('Page.enable');
  return { send, evaluate, screenshot, nextFrame, errors, close: () => ws.close() };
}

/** PASS/FAIL bookkeeping shared by the scripts. */
export function makeChecker() {
  const results = [];
  return {
    check(name, cond, detail) {
      results.push({ name, pass: !!cond });
      console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
      return !!cond;
    },
    summary() {
      const failed = results.filter((r) => !r.pass).length;
      console.log(`\n${results.length - failed}/${results.length} checks passed`);
      return failed === 0 ? 0 : 1;
    },
  };
}

/**
 * In-page expression: describe how wide the element(s) matching `selector`
 * are versus their content, plus the same for every ancestor. Any entry with
 * scrollWidth > clientWidth is horizontal overflow; offsetWidth - clientWidth
 * on a scroll container is the scrollbar gutter (0 with overlay scrollbars).
 */
export function measureChainExpr(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: 'no element matches ' + ${JSON.stringify(selector)} };
    const describe = (e) => ({
      tag: e.tagName.toLowerCase(),
      cls: (typeof e.className === 'string' ? e.className : '').trim().replace(/\\s+/g, ' ').slice(0, 80),
      scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, offsetWidth: e.offsetWidth,
      overflowX: getComputedStyle(e).overflowX,
      gutter: e.offsetWidth - e.clientWidth - (parseFloat(getComputedStyle(e).borderLeftWidth) || 0) - (parseFloat(getComputedStyle(e).borderRightWidth) || 0),
      horizontalOverflow: e.scrollWidth > e.clientWidth,
    });
    const chain = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) chain.push(describe(e));
    return { rect: el.getBoundingClientRect().toJSON(), chain };
  })()`;
}

/**
 * Poll an in-page expression until it is truthy. Use it after navigation
 * instead of a fixed sleep: on a cold Vite start the first load can take a
 * while, and Vite may reload the page once more after discovering new
 * dependencies to pre-bundle.
 */
export async function waitFor(evaluate, expression, { timeout = 90000, interval = 250, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return true; } catch { /* page reloading */ }
    await sleep(interval);
  }
  throw new Error(`timed out after ${timeout}ms waiting for: ${label}`);
}

/** Wait until the app has mounted (the left navigation rail is on screen), then let Vite settle. */
export async function waitForApp(evaluate) {
  // Generous: a cold Vite start in a small VM pre-bundles every dependency first.
  await waitFor(evaluate, `!!document.querySelector('#root button')`, { label: 'app to mount', timeout: 180000 });
  await sleep(1500);
}

/**
 * Run an in-page async expression, retrying when Vite's dependency
 * optimizer reloads the page underneath it ("Failed to fetch dynamically
 * imported module") - only happens on the first cold start.
 */
export async function evaluateWithRetry(evaluate, expression, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try { return await evaluate(expression); } catch (e) { lastError = e; await sleep(3000); }
  }
  throw lastError;
}

/** Click the app's left-rail navigation button whose hover label is `label` (e.g. "Documents"). */
export async function clickNavPage(evaluate, label) {
  const ok = await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => Array.from(b.querySelectorAll('div')).some(d => d.textContent.trim() === ${JSON.stringify(label)}));
    if (!btn) return false; btn.click(); return true;
  })()`);
  if (!ok) throw new Error(`navigation button "${label}" not found`);
  await sleep(1500);
}

/** In-page: what kind of scrollbars this Chromium lays out (native vs styled). */
export const scrollbarProbeExpr = `(() => {
  const mk = (css) => {
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    const d = document.createElement('div'); d.className = '__probe'; d.style.cssText = 'width:200px;height:100px;overflow-y:auto';
    d.innerHTML = '<div style="height:1000px"></div>'; document.body.appendChild(d);
    const r = d.offsetWidth - d.clientWidth; d.remove(); s.remove(); return r;
  };
  return {
    userAgent: navigator.userAgent,
    nativeGutter: mk('.__probe{scrollbar-width:auto;scrollbar-color:auto}'),
    thinGutter: mk('.__probe{scrollbar-width:thin}'),
    appStylesGutter: mk(''),
  };
})()`;
