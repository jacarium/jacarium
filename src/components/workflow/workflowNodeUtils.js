/**
 * Pure helpers for manipulating React Flow node arrays in the workflow
 * builder: serialisation, id bookkeeping, change-handler wiring and clearing
 * execution state.
 */

/** Result fields the execution engine writes into a node's `data`, by type. */
const OUTPUT_DATA_KEYS = {
  visualizer: ['data'],
  result: ['outputValue'],
  comparison: ['result'],
  storage: ['storedData', 'savedCount'],
  variablereference: ['storedData']
};

/** Strip functions (onChange handlers) so nodes can be persisted. */
export function cleanNodesForStorage(nodesToClean) {
  return nodesToClean.map(node => {
    const cleanData = {};
    for (const [key, value] of Object.entries(node.data || {})) {
      if (typeof value !== 'function') {
        cleanData[key] = value;
      }
    }
    return { ...node, data: cleanData };
  });
}

/** Highest numeric suffix among `node-<n>` ids (0 when none). */
export function getMaxNodeId(nodes) {
  return nodes.reduce((max, node) => {
    const match = /^node-(\d+)$/.exec(node.id);
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);
}

const zOf = (node) => (typeof node.zIndex === 'number' ? node.zIndex : 0);

/**
 * Keep the node array in stacking order (ascending effective zIndex, ties in
 * their existing order). The main canvas already stacks by zIndex, so this
 * changes nothing there; but React Flow's MiniMap simply paints nodes in
 * array order, so the array itself has to follow the stacking for the
 * minimap to match the canvas. Returns the same array when already sorted.
 */
export function sortNodesByStacking(nodes) {
  for (let i = 1; i < nodes.length; i++) {
    if (zOf(nodes[i]) < zOf(nodes[i - 1])) {
      return nodes
        .map((node, index) => ({ node, index, z: zOf(node) }))
        .sort((a, b) => a.z - b.z || a.index - b.index)
        .map((entry) => entry.node);
    }
  }
  return nodes;
}

/** Layer-menu actions understood by reorderNode(). */
export const Z_ORDER_ACTIONS = ['front', 'forward', 'backward', 'back'];

/**
 * Change one node's stacking position relative to the others.
 *
 * Stacking is React Flow's per-node top-level `zIndex` (every node starts at
 * the default, 0); among equal values the later node in the array is drawn on
 * top, which is how ties are resolved here too.
 *   front    -> above every other node (max + 1)
 *   back     -> below every other node (min - 1)
 *   forward  -> just above the node that is currently immediately above it
 *   backward -> just below the node that is currently immediately below it
 * Returns the same array when nothing changes.
 */
export function reorderNode(nodes, nodeId, action) {
  const index = nodes.findIndex((n) => n.id === nodeId);
  if (index === -1 || !Z_ORDER_ACTIONS.includes(action)) return nodes;

  const myZ = zOf(nodes[index]);
  const others = nodes.map((n, i) => ({ z: zOf(n), i })).filter((o) => o.i !== index);
  const above = others.filter((o) => o.z > myZ || (o.z === myZ && o.i > index)).map((o) => o.z);
  const below = others.filter((o) => o.z < myZ || (o.z === myZ && o.i < index)).map((o) => o.z);

  let nextZ = myZ;
  if (action === 'front' && above.length) nextZ = Math.max(...others.map((o) => o.z)) + 1;
  if (action === 'back' && below.length) nextZ = Math.min(...others.map((o) => o.z)) - 1;
  if (action === 'forward' && above.length) nextZ = Math.min(...above) + 1;
  if (action === 'backward' && below.length) nextZ = Math.max(...below) - 1;

  if (nextZ === myZ) return nodes;
  return nodes.map((n) => (n.id === nodeId ? { ...n, zIndex: nextZ } : n));
}

/**
 * Build the `data.onChange` callback that merges partial updates into a node.
 * With a `recorder` (useWorkflowHistory) every edit is recorded for undo
 * first, batched per node so typing into a field is one step.
 */
export function createNodeChangeHandler(nodeId, setNodes, recorder = null) {
  return (updates) => {
    recorder?.record(`edit:${nodeId}`);
    setNodes((nds) =>
      nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...updates } } : n))
    );
  };
}

/**
 * Return a copy of `node` with its onChange handler attached. Every path that
 * puts a node on the canvas (load, palette drop, connection menu, paste) goes
 * through here.
 */
export function withNodeChangeHandler(node, setNodes, recorder = null) {
  return {
    ...node,
    data: { ...node.data, onChange: createNodeChangeHandler(node.id, setNodes, recorder) }
  };
}

/** Attach onChange handlers to every node (used after loading from storage and on undo/redo). */
export function attachNodeHandlers(loadedNodes, setNodes, recorder = null) {
  return loadedNodes.map(node => withNodeChangeHandler(node, setNodes, recorder));
}

/** True when keyboard input should go to the element itself (typing), not the canvas. */
export function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

/** True when the user has highlighted text somewhere on the page. */
export function hasTextSelection(selection) {
  return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}

/**
 * Decide whether Ctrl/Cmd+C should be taken over as "copy selected nodes".
 * The browser's native copy must win whenever the user is typing in a field
 * or has text highlighted (e.g. JSON in a Visualizer/Result output); the
 * shortcut only copies nodes when nothing is selected as text and at least
 * one node is selected on the canvas.
 */
export function shouldCopyNodesOnShortcut({ target, selection, nodes }) {
  if (isEditableTarget(target)) return false;
  if (hasTextSelection(selection)) return false;
  return (nodes || []).some((n) => n.selected);
}

/** Edges of `edgeType` ('execution' | 'data') attached to `nodeId` on either end. */
export function nodePinEdges(edges, nodeId, edgeType) {
  return edges.filter((e) => e.type === edgeType && (e.source === nodeId || e.target === nodeId));
}

/**
 * "Clear Execution Pins" / "Clear Data Pins": drop every edge of `edgeType`
 * attached to `nodeId`, leaving the node, its other edge type and all other
 * nodes' wiring untouched. Returns the same array when nothing is attached.
 */
export function clearNodePins(edges, nodeId, edgeType) {
  const kept = edges.filter((e) => !(e.type === edgeType && (e.source === nodeId || e.target === nodeId)));
  return kept.length === edges.length ? edges : kept;
}

/** Reset transient execution status on every node (keeps output values). */
export function clearNodeStatuses(nodes) {
  return nodes.map((n) => ({ ...n, data: { ...n.data, status: null } }));
}

/**
 * Reset status *and* the values the engine pushed into visualiser-style nodes
 * (Visualizer, Result, Comparison, Set/Get Variable) without touching the
 * node's own configuration.
 */
export function clearNodeOutputs(nodes) {
  return nodes.map((n) => {
    const data = { ...n.data, status: null };
    delete data.error;
    for (const key of OUTPUT_DATA_KEYS[n.type] || []) {
      delete data[key];
    }
    return { ...n, data };
  });
}

/** Text shown for a node's value: pretty JSON for objects, String() otherwise. */
export function formatNodeValue(value) {
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}
