/**
 * Child processes that must not outlive the test that spawned them.
 *
 * A test that is interrupted (Ctrl-C, a runner's timeout, a SIGTERM from a
 * tool) never reaches its own close(): the headless Chrome, the Vite dev
 * server and the backends it started stay behind, their pages still
 * running. One such orphan - a headless Chrome of a visual test whose run
 * had been killed, its tab at localhost:5173 signed in to an accounts
 * backend on :8080 - kept pulling /api/sync/pull from localhost:8080 every
 * 30 s for a day, into the log of whatever listened there next (the
 * packaged desktop app's backend, which answered 401 each time). Another -
 * a backend (python app.py) started by a live test, left on :8080 for two
 * hours after the test's own process was gone - blocked the packaged app
 * from starting at all.
 *
 * reapOnExit(child) kills the child when this process ends for any reason
 * it can observe: a normal exit, an uncaught error, SIGINT, SIGTERM or
 * SIGHUP. spawnReaped(cmd, args, options) spawns the child as the leader of
 * its own process group (detached) and registers it, so the kill takes the
 * whole group - the child and whatever it started (a browser's helpers, a
 * server's workers) - not only the leader. (A SIGKILL of the test process
 * itself cannot be caught; nothing helps there.)
 */
import os from 'node:os';
import { spawn } from 'node:child_process';

const children = new Set();
let installed = false;

function alive(child) {
  return child.pid && child.exitCode === null && !child.signalCode;
}

/** SIGKILL the child's process group when it leads one, else the child alone. */
function killHard(child) {
  if (!alive(child)) return;
  if (child.ownsGroup) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* no group of its own: the child alone */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

function reapAll() {
  for (const child of children) {
    // 'exit' handlers cannot wait, so the kill is the one that needs no grace
    killHard(child);
  }
  children.clear();
}

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', reapAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    // the default for these is to die without running 'exit' handlers:
    // kill the children first, then end with the conventional status
    process.on(signal, () => { reapAll(); process.exit(128 + os.constants.signals[signal]); });
  }
}

/** Kill `child` (a ChildProcess) when this process ends, however it ends. Returns the child. */
export function reapOnExit(child) {
  install();
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

/**
 * spawn() with the child as the leader of its own process group, reaped
 * with that group when this process ends. The returned ChildProcess is the
 * usual one (its kill() still signals the leader alone; killGroup(child)
 * signals the whole group).
 */
export function spawnReaped(cmd, args, options = {}) {
  const child = spawn(cmd, args, { ...options, detached: true });
  child.ownsGroup = true;
  return reapOnExit(child);
}

/** Send `signal` (default SIGTERM) to the child's whole process group, or to the child alone when it leads none. */
export function killGroup(child, signal = 'SIGTERM') {
  if (!alive(child)) return;
  if (child.ownsGroup) {
    try { process.kill(-child.pid, signal); return; } catch { /* fall through */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}
