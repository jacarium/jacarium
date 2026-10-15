/**
 * What may be wired to what. React Flow asks isValidConnection() while a
 * wire is dragged (the hovered pin shows valid / invalid) and the canvas
 * hook asks describeConnectionProblem() when a wire is dropped on a pin that
 * will not take it, to tell the user why.
 */

// Node types that have no execution input (same list as
// workflowNodeCategories.js NO_EXEC_INPUT_NODE_TYPES; kept here so this
// module has no imports and tests can load it in plain Node).
const NO_EXEC_INPUT_NODE_TYPES = ['string', 'integer', 'text', 'boolean', 'object', 'array', 'note', 'idea'];

const EXEC_HANDLE_IDS = ['exec-in', 'exec-out', 'true', 'false', 'default', 'loop-body', 'completed'];

/**
 * 'exec' or 'data' for a handle id on a node of `nodeType`. Sequence's
 * `output-<n>` pins are execution pins; Begin Play's `output-<name>` /
 * `input-<name>` pins carry data, as do data-in/out, left-in/right-in and
 * the note link pins.
 */
export function pinKind(nodeType, handleId) {
  if (!handleId) return 'data';
  if (EXEC_HANDLE_IDS.includes(handleId) || /^case-\d+$/.test(handleId)) return 'exec';
  if (nodeType === 'sequence' && /^output-\d+$/.test(handleId)) return 'exec';
  return 'data';
}

/** A short label for a node type in messages ("String", "REST API"). */
function labelFor(nodeType, categories) {
  for (const category of categories) {
    const node = category.nodes.find((n) => n.type === nodeType);
    if (node) return node.label;
  }
  return nodeType;
}

/**
 * Why `connection` ({ source, sourceHandle, target, targetHandle }) cannot
 * be made, or null when it can. `nodesById` maps id -> node; `categories`
 * (NODE_CATEGORIES) supplies the labels for the message.
 */
export function describeConnectionProblem(connection, nodesById, categories = []) {
  const source = nodesById[connection.source];
  const target = nodesById[connection.target];
  if (!source || !target) return 'That node no longer exists.';
  if (connection.source === connection.target) return 'A node cannot be wired to itself.';

  const from = pinKind(source.type, connection.sourceHandle);
  const to = pinKind(target.type, connection.targetHandle);
  if (from === 'exec' && to === 'data') return 'An execution pin (white) only connects to another execution pin, not to a data pin (purple).';
  if (from === 'data' && to === 'exec') return 'A data pin (purple) only connects to another data pin, not to an execution pin (white).';
  if (to === 'exec' && NO_EXEC_INPUT_NODE_TYPES.includes(target.type)) {
    return `A ${labelFor(target.type, categories)} node has no execution input.`;
  }
  return null;
}

/** React Flow's isValidConnection: true when describeConnectionProblem finds nothing. */
export function isConnectionAllowed(connection, nodesById) {
  return describeConnectionProblem(connection, nodesById) === null;
}
