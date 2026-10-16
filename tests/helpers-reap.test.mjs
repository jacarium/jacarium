/**
 * Guards tests/helpers/reap.mjs: a child registered with reapOnExit() is
 * gone when the process that spawned it ends - by a normal exit and by a
 * SIGTERM (what a runner's timeout or a kill sends; the default action
 * would skip every cleanup and leave the child behind, as happened with a
 * headless Chrome of a visual test, see the helper's header).
 * Run: node tests/helpers-reap.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A test-like parent: spawns a grandchild that would live for minutes,
// registers it, reports its pid, then idles until told to exit (or killed).
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-test-'));
const parentScript = path.join(WORK, 'parent.mjs');
fs.writeFileSync(parentScript, `
  import { spawn } from 'node:child_process';
  import { reapOnExit } from ${JSON.stringify(path.join(here, 'helpers', 'reap.mjs'))};
  const child = reapOnExit(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  process.stdout.write(JSON.stringify({ pid: child.pid }) + '\\n');
  process.stdin.on('data', (d) => { if (String(d).includes('exit')) process.exit(0); });
  setInterval(() => {}, 1000);
`);

async function startParent() {
  const parent = spawn(process.execPath, [parentScript], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pid = await new Promise((resolve, reject) => {
    let out = '';
    parent.stdout.on('data', (d) => { out += d; const m = out.match(/\{[^\n]*\}/); if (m) resolve(JSON.parse(m[0]).pid); });
    parent.once('exit', () => reject(new Error('the parent ended before reporting')));
    setTimeout(() => reject(new Error('no pid reported')), 10000);
  });
  return { parent, pid };
}
async function untilGone(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (!alive(pid)) return true; await sleep(100); }
  return !alive(pid);
}

try {
  // ---- 1. a normal exit ----
  let { parent, pid } = await startParent();
  check('1. the grandchild runs while the parent runs', alive(pid), String(pid));
  parent.stdin.write('exit\n');
  await new Promise((resolve) => parent.once('exit', resolve));
  check('   ...and is gone once the parent exited normally', await untilGone(pid));

  // ---- 2. SIGTERM (a runner's timeout, a kill) ----
  ({ parent, pid } = await startParent());
  check('2. the grandchild runs', alive(pid), String(pid));
  parent.kill('SIGTERM');
  const code = await new Promise((resolve) => parent.once('exit', (c, s) => resolve(c ?? s)));
  check('   the parent ended with the conventional status for SIGTERM (143)', code === 143, String(code));
  check('   ...and the grandchild is gone', await untilGone(pid));

  // ---- 3. SIGINT (Ctrl-C) ----
  ({ parent, pid } = await startParent());
  parent.kill('SIGINT');
  await new Promise((resolve) => parent.once('exit', resolve));
  check('3. after SIGINT the grandchild is gone too', await untilGone(pid));
} catch (error) {
  check('the run completed', false, error.message);
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
