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
 * packaged desktop app's backend, which answered 401 each time).
 * reapOnExit(child) kills the child when this process ends for any reason
 * it can observe: a normal exit, an uncaught error, SIGINT, SIGTERM or
 * SIGHUP. (A SIGKILL of the test process itself cannot be caught; nothing
 * helps there.)
 */
import os from 'node:os';

const children = new Set();
let installed = false;

function reapAll() {
  for (const child of children) {
    // 'exit' handlers cannot wait, so the kill is the one that needs no grace
    try { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); } catch { /* already gone */ }
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
