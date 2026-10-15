/**
 * Undo history of the workflow canvas, as pure functions over an immutable
 * value so the rules can be tested without React.
 *
 * A snapshot is { nodes, edges } as they were BEFORE a change. Every call to
 * recordSnapshot() pushes the pre-change state onto `past` and empties
 * `future`; undo moves the last past entry back onto the canvas and parks
 * the current state in `future`, redo the other way round.
 *
 * Batching: a change that continues the previous one (same `key`, within
 * `batchMs` of the last record) records nothing - the entry taken at the
 * start of the batch already holds the state to go back to. That is how
 * typing into a node field, nudging with the arrow keys or resizing a note
 * end up as one undo step each. The window slides: every continuation
 * pushes the deadline out again.
 */

/** Entries kept per workflow; older ones fall off the start. */
export const HISTORY_LIMIT = 100;

export function createHistory() {
  return { past: [], future: [], lastKey: null, lastAt: 0 };
}

export const canUndo = (history) => history.past.length > 0;
export const canRedo = (history) => history.future.length > 0;

/**
 * Record `snapshot` (the state before the change about to happen).
 * @param {Object} history
 * @param {{nodes: Array, edges: Array}} snapshot
 * @param {Object} [options]
 * @param {string|null} [options.key] - batch key; null never batches
 * @param {number} [options.batchMs] - how long a batch stays open after its last change
 * @param {number} [options.now] - timestamp (injectable for tests)
 * @param {number} [options.limit]
 */
export function recordSnapshot(history, snapshot, { key = null, batchMs = 0, now = Date.now(), limit = HISTORY_LIMIT } = {}) {
  const continuesBatch = key !== null && key === history.lastKey && now - history.lastAt < batchMs;
  if (continuesBatch) {
    return { ...history, lastAt: now };
  }
  return {
    past: [...history.past, snapshot].slice(-limit),
    future: [],
    lastKey: key,
    lastAt: now
  };
}

/**
 * Step back: the snapshot to put on the canvas and the history after it,
 * with `current` (what is on the canvas now) parked for redo. null when
 * there is nothing to undo.
 */
export function undoHistory(history, current) {
  if (!canUndo(history)) return null;
  return {
    snapshot: history.past[history.past.length - 1],
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, current],
      lastKey: null,
      lastAt: 0
    }
  };
}

/** Step forward again; null when there is nothing to redo. */
export function redoHistory(history, current) {
  if (!canRedo(history)) return null;
  return {
    snapshot: history.future[history.future.length - 1],
    history: {
      past: [...history.past, current],
      future: history.future.slice(0, -1),
      lastKey: null,
      lastAt: 0
    }
  };
}
