import { useState, useRef, useEffect, useCallback } from 'react';
import {
  createHistory,
  recordSnapshot,
  undoHistory,
  redoHistory,
  canUndo,
  canRedo
} from '../components/workflow/workflowHistory';
import { cleanNodesForStorage, attachNodeHandlers } from '../components/workflow/workflowNodeUtils';

/** Batch windows per kind of change (see workflowHistory.js). */
const BATCH_MS = {
  edit: 1000,   // typing into a node field
  nudge: 1000,  // arrow-key moves and note resizing (many small changes)
  delete: 50    // React Flow reports a deletion as a node change AND an edge change
};

/**
 * Undo / redo for the canvas. `recorder.record(key)` is called by whoever is
 * about to change nodes or edges (the canvas hook, the node field handlers)
 * and snapshots the current state; undo() / redo() put a snapshot back and
 * re-attach the node change handlers. The recorder is a stable object that
 * reads the latest nodes/edges through refs, so handlers created at load
 * time keep working.
 *
 * Nothing is recorded unless record() is called: the execution engine's
 * status updates and the restore itself never create history.
 */
export default function useWorkflowHistory({ nodes, edges, setNodes, setEdges }) {
  const [history, setHistory] = useState(createHistory);
  // The latest canvas state, for record() calls from event handlers
  const latestRef = useRef({ nodes, edges });
  useEffect(() => {
    latestRef.current = { nodes, edges };
  }, [nodes, edges]);

  // Stable so it can be baked into node change handlers
  const [recorder] = useState(() => ({
    /**
     * Snapshot the state before a change. `key` batches continuations
     * ('edit:<nodeId>', 'nudge', 'delete'); without one every call is a step.
     */
    record(key = null) {
      const { nodes: currentNodes, edges: currentEdges } = latestRef.current;
      const snapshot = { nodes: cleanNodesForStorage(currentNodes), edges: currentEdges };
      const batchMs = key ? BATCH_MS[key.split(':')[0]] || 0 : 0;
      setHistory((h) => recordSnapshot(h, snapshot, { key, batchMs }));
    }
  }));

  const restore = useCallback((snapshot) => {
    setNodes(attachNodeHandlers(snapshot.nodes, setNodes, recorder));
    setEdges(snapshot.edges);
  }, [setNodes, setEdges, recorder]);

  // Undo/redo take the current canvas from the render they were created in
  // (event handlers run after that render), so no ref read is needed here
  const current = () => ({ nodes: cleanNodesForStorage(nodes), edges });

  const undo = () => {
    const step = undoHistory(history, current());
    if (!step) return;
    setHistory(step.history);
    restore(step.snapshot);
  };

  const redo = () => {
    const step = redoHistory(history, current());
    if (!step) return;
    setHistory(step.history);
    restore(step.snapshot);
  };

  /** Forget everything (another workflow was loaded). */
  const clear = useCallback(() => setHistory(createHistory()), []);

  return {
    recorder,
    undo,
    redo,
    clear,
    canUndo: canUndo(history),
    canRedo: canRedo(history)
  };
}
