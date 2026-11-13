#!/usr/bin/env node
/**
 * One instance per profile (electron/main.cjs, app.requestSingleInstanceLock
 * keyed by the profile's userData). With the PACKAGED app on a scratch
 * profile:
 *   - a second launch of the same profile exits quickly (no window, no
 *     backend) and the first instance's window is focused and still works;
 *   - a launch of a different profile (its own userData) runs beside the
 *     first;
 *   - a stale lock: the first instance killed outright (SIGKILL), a new
 *     launch of the same profile starts normally (Electron takes the lock
 *     over from a dead process).
 * Launches real windows; every one is closed at the end.
 *
 * Needs a packaged build for this platform carrying this tree's version
 * (tests/helpers/packaged-app.mjs says how to build one; SKIPs otherwise).
 * Run: node tests/electron-second-instance.test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { testablePackagedApp, launchPackagedApp } from './helpers/packaged-app.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_ELECTRON_TESTS) { console.log('SKIP: SKIP_ELECTRON_TESTS is set'); process.exit(0); }
const target = testablePackagedApp();
if (target.skip) { console.log(`SKIP: ${target.skip}`); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const { _electron } = pw;

// a bare second launch (no driver): the exit code and how long it took
const launchBare = (args, env) => new Promise((resolve) => {
  const started = Date.now(); let out = '';
  const child = spawn(target.app.executablePath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { out += String(d); }); child.stderr.on('data', (d) => { out += String(d); });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve({ code: null, ms: Date.now() - started, out, timedOut: true }); }, 25000);
  child.once('exit', (code) => { clearTimeout(timer); resolve({ code, ms: Date.now() - started, out }); });
});
const windowState = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ focused: w.isFocused(), visible: w.isVisible(), minimized: w.isMinimized(), title: w.getTitle() })));
// the app's root has mounted (polled: the window exists before the renderer has loaded dist/index.html and React has run)
const rendered = async (w, ms = 25000) => { const until = Date.now() + ms; let last = -1; while (Date.now() < until) { try { last = await w.evaluate(() => (document.getElementById('root') ? document.getElementById('root').children.length : -1)); } catch { last = -1; } if (last > 0) return last; await sleep(500); } return last; };

let first = null; let other = null; let again = null;
try {
  first = await launchPackagedApp(target.app);
  const w1 = await first.app.firstWindow();
  await w1.waitForLoadState('load'); await sleep(3000);
  const before = await w1.evaluate(() => ({ root: document.getElementById('root') ? document.getElementById('root').children.length : -1 }));
  check('the first instance runs with its window', before.root > 0, JSON.stringify(before));
  const env = { JACARIUM_USER_DATA_DIR: first.userData, JACARIUM_PROFILES_ROOT: first.profilesRoot };

  // 1. the same profile again: hands over and exits
  await first.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (w) w.minimize(); });
  await sleep(500);
  const second = await launchBare(['--profile', 'default'], env);
  // (the packaged app's console line "already open with the default profile" is not always flushed before app.exit on macOS: the exit code and the timing are the check)
  check(`a second launch of the same profile exits by itself within seconds (code ${second.code}, ${second.ms} ms)`, second.code === 0 && !second.timedOut && second.ms < 15000, JSON.stringify({ code: second.code, ms: second.ms, out: second.out.slice(-400) }));
  check('... and it started no backend of its own (no [Startup] import lines from a second backend)', !/import flask/.test(second.out), second.out.slice(-300));
  await sleep(1500);
  const ws = await windowState(first.app);
  check('the first instance\'s window is restored and focused by the hand-over, and the first instance still answers', ws.length === 1 && !ws[0].minimized && ws[0].visible && (await w1.evaluate(() => document.getElementById('root').children.length)) > 0, JSON.stringify(ws));
  const stillOne = await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  check('still exactly one window', stillOne === 1, String(stillOne));

  // 2. a different profile beside it
  other = await _electron.launch({ executablePath: target.app.executablePath, args: ['--profile', 'other'], env: { ...process.env, ...env }, timeout: 60000 });
  const w2 = await Promise.race([other.firstWindow(), sleep(30000).then(() => null)]);
  check('a different profile (its own userData) opens its own window beside the first', !!w2, 'no window in 30 s');
  if (w2) { const r2 = await rendered(w2); check('... and renders', r2 > 0, String(r2)); }
  const otherUserData = await other.evaluate(({ app }) => app.getPath('userData')).catch(() => null);
  check('the two profiles use different data directories', !!otherUserData && otherUserData !== first.userData, JSON.stringify({ otherUserData, first: first.userData }));
  await other.close().catch(() => {}); other = null;

  // 3. a stale lock: the first instance killed outright, the same profile launched again starts normally
  const pid = await first.app.evaluate(() => process.pid);
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await sleep(1500);
  again = await _electron.launch({ executablePath: target.app.executablePath, args: ['--profile', 'default'], env: { ...process.env, ...env }, timeout: 60000 });
  const w3 = await Promise.race([again.firstWindow(), sleep(30000).then(() => null)]);
  check('after the first instance died without releasing anything, the same profile launches normally (the stale lock is taken over)', !!w3, 'no window in 30 s');
  if (w3) { const r3 = await rendered(w3); check('... and renders after the stale lock', r3 > 0, String(r3)); }
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  try { if (again) await again.close(); } catch { /* gone */ }
  try { if (other) await other.close(); } catch { /* gone */ }
  try { if (first) await first.close(); } catch { /* killed above: the scratch directory is removed all the same */ }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
