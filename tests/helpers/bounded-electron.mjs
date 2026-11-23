/**
 * Every step a test takes against a launched Electron app is bounded.
 *
 * Playwright's electronApplication.evaluate() (the main process, over the
 * Node inspector) and page.evaluate() (a window, over CDP) have no timeout of
 * their own: when the process they talk to stops answering - a main process
 * blocked in a native call, an inspector that went away - the await never
 * returns and the whole suite stands still (a full run once stood for 17
 * minutes on one evaluate after a second-instance hand-over). boundElectronApp()
 * wraps an ElectronApplication so that
 *   - app.evaluate / app.evaluateHandle / app.firstWindow reject after
 *     ELECTRON_STEP_TIMEOUT_MS (default 30 s), and the evaluate of the pages
 *     app.firstWindow() / app.windows() hand out after
 *     ELECTRON_PAGE_STEP_TIMEOUT_MS (default 120 s: a page step may render a
 *     PDF or type a long document), with an error that names the step: a hang
 *     is a FAIL, never a suite that stands still;
 *   - app.close() never hangs either: when the app does not close in time its
 *     process is killed (SIGKILL), so no window is left on the screen;
 *   - on a timeout of a main-process step on macOS, the main thread's stack is
 *     sampled once (`sample <pid>`) and its top frames go into the error, so
 *     the report says where the process was standing.
 *   - close() also ends what the app started and left behind (the backend it
 *     spawns): the process tree is read before closing and whatever of it is
 *     still alive afterwards is killed, so a run leaves no orphan.
 *
 * And no test reaches the user's real keychain: launchElectron() - the one
 * way a test starts Electron - always adds --use-mock-keychain, so Electron's
 * safeStorage works on a mock key and macOS never shows "... wants to use
 * your confidential information stored in ... Safe Storage" on the screen of
 * whoever owns the machine (that prompt blocks the app's main thread until it
 * is answered: the cause of the 17-minute stall). A test that spawns the
 * executable itself passes withMockKeychain(args).
 * tests/helpers/packaged-app.mjs and tests/helpers/electron-app.mjs launch
 * through launchElectron(); so does every test that launches Electron itself.
 */
import { spawnSync } from 'node:child_process';

/** Chromium's switch for a mock OS keychain (Electron's safeStorage then never opens the login keychain). */
export const MOCK_KEYCHAIN_ARG = '--use-mock-keychain';
/** The launch arguments with the mock keychain switch (once). */
export const withMockKeychain = (args = []) => (args.includes(MOCK_KEYCHAIN_ARG) ? [...args] : [...args, MOCK_KEYCHAIN_ARG]);

/**
 * Start Electron for a test: `electron` is playwright-core's _electron, `options` what _electron.launch takes.
 * The mock keychain is always on and the returned app is bounded (boundElectronApp).
 */
export async function launchElectron(electron, options = {}, bounds = {}) {
  return boundElectronApp(await electron.launch({ ...options, args: withMockKeychain(options.args || []) }), bounds);
}

/**
 * The pids below `pid` in the process tree, read from `ps` ([] when unreadable).
 * SAFETY: only the tree of a process this test process started itself is ever read:
 * `pid` must be a whole number above 1 whose parent is `owner` (this process), and
 * neither `owner` nor any of its ancestors is ever returned. Anything else gives [],
 * so a stand-in app reporting pid 1 (launchd) or some unrelated pid can never turn
 * close() into a kill of the user's whole session.
 */
export function descendantPids(pid, { run = spawnSync, owner = process.pid } = {}) {
  const root = Number(pid);
  if (!Number.isInteger(root) || root <= 1 || root === owner) return [];
  let table;
  try { table = String(run('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 10000 }).stdout || ''); } catch { return []; }
  const children = new Map();
  const parentOf = new Map();
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !Number.isInteger(parent)) continue;
    parentOf.set(child, parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  if (parentOf.get(root) !== owner) return [];
  const protectedPids = new Set([0, 1, owner]);
  for (let p = parentOf.get(owner), hops = 0; p && hops < 64; p = parentOf.get(p), hops++) protectedPids.add(p);
  const out = []; const seen = new Set([root]); const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      if (seen.has(child) || protectedPids.has(child)) continue;
      seen.add(child); out.push(child); queue.push(child);
    }
  }
  return out;
}

/** Start time of each pid as `ps` prints it (missing: not running); used so a reused pid is never killed. */
export function startTimes(pids, { run = spawnSync } = {}) {
  const out = new Map();
  if (!pids.length) return out;
  try {
    const text = String(run('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 10000 }).stdout || '');
    for (const line of text.split('\n')) { const m = line.trim().match(/^(\d+)\s+(.+)$/); if (m) out.set(Number(m[1]), m[2].trim()); }
  } catch { /* unreadable: nothing is known, so nothing will be killed */ }
  return out;
}

export const STEP_TIMEOUT_MS = (() => { const n = Number(process.env.ELECTRON_STEP_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 30000; })();
export const PAGE_STEP_TIMEOUT_MS = (() => { const n = Number(process.env.ELECTRON_PAGE_STEP_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 120000; })();
const BOUND = Symbol.for('jacarium.boundElectron');

export class ElectronStepTimeout extends Error {
  constructor(what, ms, detail = '') {
    super(`${what} did not answer within ${ms} ms${detail ? `\n${detail}` : ''}`);
    this.name = 'ElectronStepTimeout';
    this.step = what;
  }
}

/** The promise, or an ElectronStepTimeout after ms. onTimeout() may return text for the error (where the process stood). */
export function bounded(promise, what, ms = STEP_TIMEOUT_MS, onTimeout = null) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      let detail = '';
      try { detail = (onTimeout && onTimeout()) || ''; } catch { detail = ''; }
      reject(new ElectronStepTimeout(what, ms, detail));
    }, ms);
  });
  // the original promise may settle (or reject) after the race is lost: never an unhandled rejection
  Promise.resolve(promise).catch(() => {});
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Where a process's main thread stands (macOS `sample`), a few frames; '' elsewhere or when it cannot be read. */
export function mainThreadStack(pid, { run = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'darwin' || !pid || process.env.ELECTRON_HANG_SAMPLE === '0') return '';
  try {
    const r = run('sample', [String(pid), '2', '-mayDie'], { encoding: 'utf8', timeout: 15000 });
    const text = String(r.stdout || '');
    const start = text.indexOf('Call graph:');
    if (start < 0) return '';
    const lines = text.slice(start).split('\n');
    const main = lines.findIndex((l) => /Thread_\d+.*(main-thread|CrBrowserMain|DispatchQueue_1: com\.apple\.main-thread)/.test(l));
    const frames = lines.slice(main < 0 ? 1 : main, (main < 0 ? 1 : main) + 80).map((l) => l.replace(/\s+\(in [^)]*\)/, '').replace(/\s+\[0x[0-9a-f]+\]/g, '').trimEnd()).filter(Boolean);
    return `main thread of pid ${pid} (sampled):\n${frames.join('\n')}`;
  } catch {
    return '';
  }
}

/** Bound a window's evaluate (in place). */
export function boundPage(page, ms = PAGE_STEP_TIMEOUT_MS) {
  if (!page || page[BOUND]) return page;
  const evaluate = page.evaluate.bind(page);
  page.evaluate = (...args) => bounded(evaluate(...args), 'a window (page.evaluate)', ms);
  page[BOUND] = true;
  return page;
}

/**
 * Wrap an ElectronApplication (in place; returned for chaining). Idempotent.
 * @param {import('playwright-core').ElectronApplication} app
 * @param {{ ms?: number, pageMs?: number, closeMs?: number }} [options]
 */
export function boundElectronApp(app, { ms = STEP_TIMEOUT_MS, pageMs = PAGE_STEP_TIMEOUT_MS, closeMs = 20000 } = {}) {
  if (!app || app[BOUND]) return app;
  const pid = () => { try { return app.process().pid; } catch { return null; } };
  const where = () => mainThreadStack(pid());
  const evaluate = app.evaluate.bind(app);
  app.evaluate = (...args) => bounded(evaluate(...args), 'the main process (electronApplication.evaluate)', ms, where);
  if (typeof app.evaluateHandle === 'function') {
    const evaluateHandle = app.evaluateHandle.bind(app);
    app.evaluateHandle = (...args) => bounded(evaluateHandle(...args), 'the main process (electronApplication.evaluateHandle)', ms, where);
  }
  const firstWindow = app.firstWindow.bind(app);
  app.firstWindow = async (...args) => boundPage(await bounded(firstWindow(...args), 'the first window (electronApplication.firstWindow)', Math.max(ms, 60000), where), pageMs);
  const windows = app.windows.bind(app);
  app.windows = () => windows().map((page) => boundPage(page, pageMs));
  // what the app started and is still the same process afterwards (the start time read before), ended
  const reap = (started, startedAt) => {
    const now = startTimes(started);
    for (const child of started) {
      if (!startedAt.has(child) || now.get(child) !== startedAt.get(child)) continue;
      try { process.kill(child, 'SIGKILL'); } catch { /* already gone */ }
    }
  };
  /**
   * End the app outright, as a crash would (SIGKILL through its child-process handle), and what it had started
   * with it: a test that needs a dead instance must not leave that instance's backend running.
   */
  app.killHard = async () => {
    const started = descendantPids(pid());
    const startedAt = startTimes(started);
    try { const child = app.process(); if (child && child.exitCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
    reap(started, startedAt);
  };
  const close = app.close.bind(app);
  app.close = async () => {
    // what the app started (its backend, their workers), read while the tree still hangs together
    const started = descendantPids(pid());
    const startedAt = startTimes(started);
    let failure = null;
    try {
      await bounded(close(), 'closing the app (electronApplication.close)', closeMs);
    } catch (error) {
      // it did not close: no window may stay on the screen and no test may wait for it
      try { const child = app.process(); if (child && child.exitCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
      if (!(error instanceof ElectronStepTimeout)) failure = error;
    }
    // ...and nothing of it stays behind: a child that outlived the app (a backend whose parent was killed) is ended
    // (only a pid still carrying the start time read above: the same process, not a reused pid)
    reap(started, startedAt);
    if (failure) throw failure;
  };
  app[BOUND] = true;
  return app;
}
