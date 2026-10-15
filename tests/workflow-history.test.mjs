/**
 * Guards the undo/redo history of the workflow canvas
 * (src/components/workflow/workflowHistory.js), the pure part behind
 * src/hooks/useWorkflowHistory.js and the builder's Ctrl/Cmd+Z shortcuts.
 *
 * What this test proves:
 *   - recording pushes the pre-change snapshot, undo returns it and parks
 *     the current state for redo, redo returns that and re-parks the undone
 *     one; both are null (not an exception) at the ends;
 *   - a new record after an undo drops the redo branch;
 *   - batching: changes with the same key inside the window record nothing
 *     more (typing a word is one step), the window slides with every
 *     continuation, a different key or a pause past the window starts a
 *     new step, and a null key never batches (one step per drag);
 *   - undo/redo reset the batch so the next change is always a new step;
 *   - the history is capped at `limit` entries, oldest first out;
 *   - the inputs are never mutated.
 *
 * Run:  node tests/workflow-history.test.mjs
 * Preconditions: none beyond Node (no deps).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const { createHistory, recordSnapshot, undoHistory, redoHistory, canUndo, canRedo } =
  await import(path.join(REPO, 'src', 'components', 'workflow', 'workflowHistory.js'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ' | ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const snap = (n) => ({ nodes: [{ id: 'a', position: { x: n, y: 0 }, data: {} }], edges: [] });

// ---------- basic undo / redo ----------
{
  let h = createHistory();
  check('fresh history has nothing to undo or redo', !canUndo(h) && !canRedo(h) && undoHistory(h, snap(0)) === null && redoHistory(h, snap(0)) === null);

  h = recordSnapshot(h, snap(0), { now: 1000 }); // about to move a -> 1
  h = recordSnapshot(h, snap(1), { now: 2000 }); // about to move a -> 2
  check('recording pushes the pre-change snapshots in order', canUndo(h) && eq(h.past.map((s) => s.nodes[0].position.x), [0, 1]));

  const u1 = undoHistory(h, snap(2));
  check('undo hands back the last snapshot and parks the current state for redo',
    u1.snapshot.nodes[0].position.x === 1 && eq(u1.history.past.map((s) => s.nodes[0].position.x), [0]) && u1.history.future[0].nodes[0].position.x === 2);
  const u2 = undoHistory(u1.history, u1.snapshot);
  check('a second undo reaches the first snapshot and leaves nothing to undo',
    u2.snapshot.nodes[0].position.x === 0 && !canUndo(u2.history) && canRedo(u2.history));

  const r1 = redoHistory(u2.history, u2.snapshot);
  check('redo returns the most recently undone state and re-parks the undone one',
    r1.snapshot.nodes[0].position.x === 1 && eq(r1.history.past.map((s) => s.nodes[0].position.x), [0]) && eq(r1.history.future.map((s) => s.nodes[0].position.x), [2]));
  const r2 = redoHistory(r1.history, r1.snapshot);
  check('redo to the end restores the latest state and empties the redo stack',
    r2.snapshot.nodes[0].position.x === 2 && !canRedo(r2.history) && redoHistory(r2.history, r2.snapshot) === null);

  const branched = recordSnapshot(u2.history, u2.snapshot, { now: 3000 });
  check('a new change after undo discards the redo branch', !canRedo(branched) && branched.past.length === 1);
}

// ---------- batching ----------
{
  let h = createHistory();
  const opts = (now) => ({ key: 'edit:node-1', batchMs: 1000, now });
  h = recordSnapshot(h, snap(0), opts(1000)); // first keystroke
  h = recordSnapshot(h, snap(1), opts(1500)); // continues
  h = recordSnapshot(h, snap(2), opts(2400)); // still within 1000ms of the previous one
  check('typing within the window is one step: only the pre-batch snapshot is kept',
    h.past.length === 1 && h.past[0].nodes[0].position.x === 0, `${h.past.length} entries`);
  check('the window slides with every continuation', h.lastAt === 2400);

  const paused = recordSnapshot(h, snap(3), opts(3500)); // > 1000ms after the last keystroke
  check('a pause longer than the window starts a new step', paused.past.length === 2 && paused.past[1].nodes[0].position.x === 3);

  const otherKey = recordSnapshot(h, snap(3), { key: 'edit:node-2', batchMs: 1000, now: 2500 });
  check('a different key starts a new step even inside the window', otherKey.past.length === 2);

  const noKey = recordSnapshot(recordSnapshot(createHistory(), snap(0), { now: 1 }), snap(1), { now: 2 });
  check('a null key never batches (one entry per drag)', noKey.past.length === 2);

  const undone = undoHistory(h, snap(2));
  const after = recordSnapshot(undone.history, undone.snapshot, opts(2450));
  check('undo resets the batch: the next change with the same key is a new step', after.past.length === 1 && undone.history.lastKey === null);
}

// ---------- limit and immutability ----------
{
  let h = createHistory();
  for (let i = 0; i < 7; i++) h = recordSnapshot(h, snap(i), { now: i, limit: 5 });
  check('the history keeps at most `limit` entries, oldest first out',
    h.past.length === 5 && eq(h.past.map((s) => s.nodes[0].position.x), [2, 3, 4, 5, 6]));

  const base = recordSnapshot(createHistory(), snap(0), { now: 1 });
  const frozenPast = base.past.slice();
  recordSnapshot(base, snap(1), { now: 2 });
  undoHistory(base, snap(1));
  check('recording and undoing never mutate the input history', eq(base.past, frozenPast) && base.future.length === 0);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
