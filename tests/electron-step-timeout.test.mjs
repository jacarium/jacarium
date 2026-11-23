#!/usr/bin/env node
/**
 * The Electron test harness fails instead of hanging
 * (tests/helpers/bounded-electron.mjs): a step against a launched app -
 * electronApplication.evaluate over the Node inspector, a window's
 * page.evaluate, firstWindow, close - is bounded, rejects with the step's
 * name when the process does not answer, and close() kills an app that does
 * not close, so a full suite never stands still on one await and no window
 * is left behind. And no test reaches the user's own keychain: every launch
 * goes through launchElectron(), which adds --use-mock-keychain (a real
 * keychain may answer with a prompt on the owner's screen that blocks the
 * app's main thread - what stalled a full run), and close() ends the
 * processes the app started (its backend), so nothing is orphaned. No
 * Electron is launched here: the app is a stand-in whose calls never return.
 *
 * Run: node tests/electron-step-timeout.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounded, boundElectronApp, boundPage, mainThreadStack, descendantPids, launchElectron, withMockKeychain, MOCK_KEYCHAIN_ARG, ElectronStepTimeout, STEP_TIMEOUT_MS, PAGE_STEP_TIMEOUT_MS } from './helpers/bounded-electron.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 600) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});
const rejects = async (promise) => { try { await promise; return null; } catch (e) { return e; } };

check('the defaults: 30 s for a main-process step, 120 s for a window step (ELECTRON_STEP_TIMEOUT_MS / ELECTRON_PAGE_STEP_TIMEOUT_MS override them)',
  STEP_TIMEOUT_MS === (Number(process.env.ELECTRON_STEP_TIMEOUT_MS) > 0 ? Number(process.env.ELECTRON_STEP_TIMEOUT_MS) : 30000)
  && PAGE_STEP_TIMEOUT_MS === (Number(process.env.ELECTRON_PAGE_STEP_TIMEOUT_MS) > 0 ? Number(process.env.ELECTRON_PAGE_STEP_TIMEOUT_MS) : 120000));
check('an answer in time comes back unchanged', (await bounded(Promise.resolve(42), 'a step', 200)) === 42);
let t = Date.now();
let err = await rejects(bounded(never(), 'the main process (electronApplication.evaluate)', 150, () => 'main thread of pid 1 (sampled):\n  frame'));
check('a step that never answers rejects after the timeout, naming the step, with where the process stood', err instanceof ElectronStepTimeout && /the main process \(electronApplication\.evaluate\) did not answer within 150 ms/.test(err.message)
  && /main thread of pid 1/.test(err.message) && Date.now() - t < 2000, err && err.message);
err = await rejects(bounded(Promise.reject(new Error('real failure')), 'a step', 200));
check('a real failure is passed on as it is', !!err && err.message === 'real failure');
let unhandled = 0;
const onUnhandled = () => { unhandled += 1; };
process.on('unhandledRejection', onUnhandled);
await rejects(bounded(new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 120)), 'a step', 40));
await sleep(250);
process.off('unhandledRejection', onUnhandled);
check('a step that fails after it was given up leaves no unhandled rejection', unhandled === 0, String(unhandled));

// ---- a stand-in ElectronApplication whose calls never return ----------------------------------------
function hungApp() {
  const child = { pid: 4242, exitCode: null, killed: [], kill(signal) { this.killed.push(signal); this.exitCode = 137; } };
  const page = { evaluate: never };
  return { child, page, evaluate: never, evaluateHandle: never, firstWindow: never, windows: () => [page], close: never, process: () => child };
}
let app = hungApp();
boundElectronApp(app, { ms: 120, pageMs: 150, closeMs: 150 });
t = Date.now();
err = await rejects(app.evaluate(() => 1));
check('boundElectronApp: a main-process evaluate that hangs fails within its bound', err instanceof ElectronStepTimeout && /electronApplication\.evaluate/.test(err.message) && Date.now() - t < 20000, err && err.message);
err = await rejects(app.evaluateHandle(() => 1));
check('boundElectronApp: evaluateHandle too', err instanceof ElectronStepTimeout && /evaluateHandle/.test(err.message));
err = await rejects(app.windows()[0].evaluate(() => 1));
check('boundElectronApp: a window\'s evaluate, from app.windows(), fails within the page bound', err instanceof ElectronStepTimeout && /a window \(page\.evaluate\)/.test(err.message) && /150 ms/.test(err.message), err && err.message);
t = Date.now();
await app.close();
check('boundElectronApp: close() on an app that does not close returns and kills its process (no window left behind)', app.child.killed.join() === 'SIGKILL' && Date.now() - t < 5000, app.child.killed.join());
const before = app.evaluate;
check('boundElectronApp is idempotent (wrapping twice changes nothing)', boundElectronApp(app).evaluate === before);

// ---- an app that works: everything passes through ---------------------------------------------------
const closed = [];
const good = { evaluate: async (fn, arg) => fn(arg), firstWindow: async () => ({ evaluate: async (fn) => fn() }), windows: () => [], close: async () => { closed.push(1); }, process: () => ({ pid: undefined, exitCode: 0, kill() { closed.push('killed'); } }) };  // never a real pid: close() reaps a real pid's tree
boundElectronApp(good, { ms: 500 });
const win = await good.firstWindow();
check('a working app answers through the wrapper: evaluate with its argument, firstWindow\'s page, close without a kill', (await good.evaluate((n) => n + 1, 41)) === 42 && (await win.evaluate(() => 'ok')) === 'ok'
  && (await good.close(), closed.join() === '1'));
err = await rejects(boundPage({ evaluate: never }, 100).evaluate(() => 1));
check('boundPage bounds a page handed out elsewhere', err instanceof ElectronStepTimeout);

// ---- where the process stood ---------------------------------------------------------------------------
const SAMPLE = 'Analysis of sampling Jacarium (pid 4242) every 1 millisecond\nCall graph:\n    1870 Thread_1234   DispatchQueue_1: com.apple.main-thread  (serial)\n      1870 start  (in dyld) + 6076  [0x18a]\n        1870 ElectronMain  (in Electron Framework) + 84  [0x10b]\n          1870 -[NSWindow deminiaturize:]  (in AppKit) + 100  [0x1c]\n';
const stack = mainThreadStack(4242, { platform: 'darwin', run: (cmd, args) => ({ stdout: cmd === 'sample' && args[0] === '4242' ? SAMPLE : '' }) });
check('mainThreadStack: on macOS the main thread\'s frames are read from `sample` (addresses and image names trimmed)', /main thread of pid 4242/.test(stack) && /-\[NSWindow deminiaturize:\]/.test(stack) && !/0x1c/.test(stack), stack);
check('mainThreadStack: nothing elsewhere, nothing when sample gives nothing, never a throw', mainThreadStack(4242, { platform: 'linux', run: () => { throw new Error('not called'); } }) === ''
  && mainThreadStack(4242, { platform: 'darwin', run: () => ({ stdout: '' }) }) === '' && mainThreadStack(4242, { platform: 'darwin', run: () => { throw new Error('no sample'); } }) === '' && mainThreadStack(null) === '');

// ---- the mock keychain, on every launch -------------------------------------------------------------------
check('withMockKeychain adds --use-mock-keychain once and keeps the other arguments in order', MOCK_KEYCHAIN_ARG === '--use-mock-keychain' && withMockKeychain(['--profile', 'default']).join(' ') === '--profile default --use-mock-keychain'
  && withMockKeychain(['--use-mock-keychain', 'x']).join(' ') === '--use-mock-keychain x' && withMockKeychain().join() === '--use-mock-keychain');
const launches = [];
const fakeElectron = { launch: async (options) => { launches.push(options); return hungApp(); } };
const launchedApp = await launchElectron(fakeElectron, { executablePath: '/x/Jacarium', args: ['--profile', 'default'], env: { A: '1' }, timeout: 5 }, { ms: 100 });
check('launchElectron passes the options on with the mock keychain added, and hands back a bounded app', launches.length === 1 && launches[0].args.join(' ') === '--profile default --use-mock-keychain' && launches[0].executablePath === '/x/Jacarium'
  && launches[0].env.A === '1' && launches[0].timeout === 5 && (await rejects(launchedApp.evaluate(() => 1))) instanceof ElectronStepTimeout);
await launchElectron(fakeElectron, {});
check('...also when the test gave no arguments at all', launches[1].args.join() === '--use-mock-keychain');

// ---- nothing the app started is left behind ---------------------------------------------------------------------
const PS = '    1     0\n  700     1\n  777   700\n 4242   777\n 4300  4242\n 4301  4242\n 4400  4300\n 9000     1\n 9001  9000\n';
const ps = { run: () => ({ stdout: PS }), owner: 777 };
check('descendantPids reads the process tree below a pid this process started (children and their children, nothing else)', descendantPids(4242, ps).sort().join() === '4300,4301,4400'
  && descendantPids(9001, ps).length === 0 && descendantPids(null).length === 0 && descendantPids(4242, { owner: 777, run: () => { throw new Error('no ps'); } }).length === 0);
check('descendantPids NEVER reads the tree of pid 1, of this process, or of a pid this process did not start (a kill there would end the whole login session)',
  descendantPids(1, ps).length === 0 && descendantPids(777, ps).length === 0 && descendantPids(9000, ps).length === 0 && descendantPids(700, ps).length === 0
  && descendantPids(1).length === 0 && descendantPids(process.pid).length === 0 && descendantPids(process.ppid).length === 0 && descendantPids(-1).length === 0 && descendantPids('1').length === 0);
{
  // a real child of a real process: close() ends it although the "app" itself went away without telling it
  const { spawn } = await import('node:child_process');
  const parent = spawn(process.execPath, ['-e', "const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); console.log(c.pid); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'] });
  const childPid = await new Promise((resolve) => parent.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const standIn = { evaluate: never, firstWindow: never, windows: () => [], process: () => parent, close: async () => { parent.kill('SIGKILL'); await new Promise((r) => parent.once('exit', r)); } };
  boundElectronApp(standIn, { ms: 200, closeMs: 3000 });
  const before = alive(childPid);
  await standIn.close();
  await sleep(300);
  check('close() ends a process the app started and left running (the backend of a killed app is not orphaned)', before && !alive(childPid) && !alive(parent.pid), JSON.stringify({ before, child: alive(childPid), parent: alive(parent.pid) }));
  // killHard: the same for an app a test ends on purpose
  const parent2 = spawn(process.execPath, ['-e', "const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); console.log(c.pid); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'] });
  const childPid2 = await new Promise((resolve) => parent2.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  const standIn2 = boundElectronApp({ evaluate: never, firstWindow: never, windows: () => [], process: () => parent2, close: async () => {} }, { ms: 200 });
  await standIn2.killHard();
  await sleep(300);
  check('killHard() ends the app as a crash would and the process it had started with it', !alive(parent2.pid) && !alive(childPid2), JSON.stringify({ parent: alive(parent2.pid), child: alive(childPid2) }));
  if (Number.isInteger(childPid2) && childPid2 > 1 && childPid2 !== process.pid && childPid2 !== process.ppid && alive(childPid2)) { try { process.kill(childPid2, 'SIGKILL'); } catch { /* gone */ } }
  // tidy up only what is certainly ours: a pid above 1 that is neither this process nor its parent
  if (Number.isInteger(childPid) && childPid > 1 && childPid !== process.pid && childPid !== process.ppid && alive(childPid)) { try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ } }
}

// ---- the harness uses it ---------------------------------------------------------------------------------
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
check('tests/helpers/packaged-app.mjs and tests/helpers/electron-app.mjs launch through launchElectron (mock keychain, bounded, reaped)', /await launchElectron\(_electron, \{/.test(read('tests/helpers/packaged-app.mjs')) && /await launchElectron\(electron, \{/.test(read('tests/helpers/electron-app.mjs'))
  && !/\.launch\(\{/.test(read('tests/helpers/packaged-app.mjs')) && !/electron\.launch\(\{/.test(read('tests/helpers/electron-app.mjs')));
const files = [...fs.readdirSync(path.join(REPO, 'tests')).filter((f) => /\.test\.mjs$/.test(f)).map((f) => `tests/${f}`), ...fs.readdirSync(path.join(REPO, 'tests', 'helpers')).filter((f) => /\.mjs$/.test(f) && f !== 'bounded-electron.mjs').map((f) => `tests/helpers/${f}`)]
  .filter((f) => f !== 'tests/electron-step-timeout.test.mjs');
const direct = files.filter((f) => /\b_?electron\.launch\(/.test(read(f)));
check('no test and no helper calls _electron.launch itself: launchElectron is the only way in', direct.length === 0, direct.join(', '));
const spawners = files.filter((f) => /spawn(Sync|Reaped)?\([^)\n]*executablePath/.test(read(f)));
const bare = spawners.filter((f) => (read(f).match(/spawn(Sync|Reaped)?\([^)\n]*executablePath[^\n]*/g) || []).some((line) => !/withMockKeychain\(/.test(line)));
check(`a test that spawns the packaged executable itself passes withMockKeychain(args) (${spawners.length}: ${spawners.join(', ') || 'none'})`, bare.length === 0, bare.join(', '));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
