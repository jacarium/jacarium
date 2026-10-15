/**
 * Arranging nodes on the canvas: align / distribute a selection and the
 * "auto-tidy" layout that lines a workflow up along its execution flow, left
 * to right. Pure functions over React Flow node/edge arrays; every function
 * returns a new array and leaves the input alone. Notes and ideas (the
 * annotation nodes) are never moved by the tidy.
 */

// Freeform annotation nodes (same list as workflowNodeCategories.js; kept
// here so this module has no imports and tests can load it in plain Node).
const ANNOTATION_NODE_TYPES = ['note', 'idea'];

/** Size assumed for a node React Flow has not measured yet. */
export const DEFAULT_NODE_SIZE = { width: 250, height: 120 };
/** Tidy spacing: between columns (along the flow) and between rows. */
export const TIDY_GAP = { x: 80, y: 40 };

const widthOf = (node) => node.width || DEFAULT_NODE_SIZE.width;
const heightOf = (node) => node.height || DEFAULT_NODE_SIZE.height;

/** Actions understood by alignNodes(). */
export const ALIGN_MODES = ['left', 'center', 'right', 'top', 'middle', 'bottom'];

/**
 * Line the nodes in `ids` up on one edge (or centre line) of their joint
 * bounding box: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'.
 * Fewer than two nodes, or an unknown mode, leaves the array untouched.
 */
export function alignNodes(nodes, ids, mode) {
  const picked = nodes.filter((n) => ids.includes(n.id));
  if (picked.length < 2 || !ALIGN_MODES.includes(mode)) return nodes;

  const left = Math.min(...picked.map((n) => n.position.x));
  const right = Math.max(...picked.map((n) => n.position.x + widthOf(n)));
  const top = Math.min(...picked.map((n) => n.position.y));
  const bottom = Math.max(...picked.map((n) => n.position.y + heightOf(n)));

  const target = (node) => {
    switch (mode) {
      case 'left': return { x: left };
      case 'center': return { x: Math.round((left + right) / 2 - widthOf(node) / 2) };
      case 'right': return { x: right - widthOf(node) };
      case 'top': return { y: top };
      case 'middle': return { y: Math.round((top + bottom) / 2 - heightOf(node) / 2) };
      case 'bottom': return { y: bottom - heightOf(node) };
      default: return {};
    }
  };

  return nodes.map((n) => (ids.includes(n.id) ? { ...n, position: { ...n.position, ...target(n) } } : n));
}

/**
 * Space the nodes in `ids` evenly along `axis` ('horizontal' | 'vertical'):
 * the first and last stay where they are, the gaps between neighbours
 * become equal. Needs at least three nodes.
 */
export function distributeNodes(nodes, ids, axis) {
  const picked = nodes.filter((n) => ids.includes(n.id));
  if (picked.length < 3 || (axis !== 'horizontal' && axis !== 'vertical')) return nodes;

  const pos = axis === 'horizontal' ? 'x' : 'y';
  const size = axis === 'horizontal' ? widthOf : heightOf;
  const ordered = [...picked].sort((a, b) => a.position[pos] - b.position[pos]);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const span = (last.position[pos] + size(last)) - first.position[pos];
  const total = ordered.reduce((sum, n) => sum + size(n), 0);
  const gap = (span - total) / (ordered.length - 1);

  const next = {};
  let cursor = first.position[pos];
  for (const node of ordered) {
    next[node.id] = Math.round(cursor);
    cursor += size(node) + gap;
  }
  return nodes.map((n) => (n.id in next ? { ...n, position: { ...n.position, [pos]: next[n.id] } } : n));
}

/**
 * Which column (0-based) each non-annotation node belongs in:
 *   - nodes on the execution flow: the longest execution path from a start
 *     node (no incoming execution edge) to them, so a node sits right of
 *     everything that runs before it;
 *   - pin-less data nodes (variables, comparison, ...): one column left of
 *     their earliest consumer (through data edges, transitively);
 *   - nodes attached to nothing: a column of their own at the far right.
 * Cycles in the execution edges are tolerated (a node keeps its first column).
 */
export function tidyColumns(nodes, edges) {
  const placeable = nodes.filter((n) => !ANNOTATION_NODE_TYPES.includes(n.type));
  const ids = new Set(placeable.map((n) => n.id));
  const execOut = {};
  const execInCount = {};
  const dataConsumers = {};
  for (const id of ids) {
    execOut[id] = [];
    execInCount[id] = 0;
    dataConsumers[id] = [];
  }
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    if (edge.type === 'execution') {
      execOut[edge.source].push(edge.target);
      execInCount[edge.target] += 1;
    } else {
      dataConsumers[edge.source].push(edge.target);
    }
  }

  const column = {};
  // Longest path over the execution edges, breadth-first from the starts
  const onFlow = placeable.filter((n) => execOut[n.id].length > 0 || execInCount[n.id] > 0);
  const queue = onFlow.filter((n) => execInCount[n.id] === 0).map((n) => n.id);
  const visits = {};
  for (const id of queue) column[id] = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visits[id] = (visits[id] || 0) + 1;
    if (visits[id] > ids.size) continue; // a cycle: stop re-walking it
    for (const target of execOut[id]) {
      const next = column[id] + 1;
      if (column[target] === undefined || column[target] < next) {
        column[target] = next;
        queue.push(target);
      }
    }
  }
  // A flow node every start of which is inside a cycle never got a column
  for (const n of onFlow) if (column[n.id] === undefined) column[n.id] = 0;

  // Data-only nodes: left of their earliest consumer; walk until stable so a
  // variable feeding another data node also lands left of it
  const dataOnly = placeable.filter((n) => column[n.id] === undefined && dataConsumers[n.id].length > 0);
  let changed = true;
  for (let round = 0; changed && round < ids.size + 1; round++) {
    changed = false;
    for (const n of dataOnly) {
      const consumerColumns = dataConsumers[n.id].map((id) => column[id]).filter((c) => c !== undefined);
      if (consumerColumns.length === 0) continue;
      const wanted = Math.min(...consumerColumns) - 1;
      if (column[n.id] === undefined || column[n.id] !== wanted) {
        column[n.id] = wanted;
        changed = true;
      }
    }
  }

  // Shift so the leftmost column is 0, then park the unattached nodes at the right
  const placed = Object.keys(column);
  const min = placed.length ? Math.min(...placed.map((id) => column[id])) : 0;
  for (const id of placed) column[id] -= min;
  const max = placed.length ? Math.max(...placed.map((id) => column[id])) : -1;
  for (const n of placeable) if (column[n.id] === undefined) column[n.id] = max + 1;

  return column;
}

/**
 * Auto-tidy: columns from tidyColumns(), ordered within a column by the
 * average row of the nodes feeding them (first column by current y), laid
 * out left to right from the top-left of where the workflow already is.
 * Returns the nodes with new positions; annotation nodes are unchanged.
 */
export function tidyLayout(nodes, edges) {
  const column = tidyColumns(nodes, edges);
  const placeable = nodes.filter((n) => column[n.id] !== undefined);
  if (placeable.length === 0) return nodes;

  const feeders = {};
  for (const edge of edges) {
    if (column[edge.source] === undefined || column[edge.target] === undefined) continue;
    (feeders[edge.target] = feeders[edge.target] || []).push(edge.source);
  }

  const columnCount = Math.max(...placeable.map((n) => column[n.id])) + 1;
  const columns = Array.from({ length: columnCount }, () => []);
  for (const n of placeable) columns[column[n.id]].push(n);

  // Row order: first column by current y, later columns by the mean row of
  // their feeders (ties by current y), so wires mostly run straight across
  const row = {};
  columns.forEach((members, index) => {
    const key = (n) => {
      const rows = (feeders[n.id] || []).map((id) => row[id]).filter((r) => r !== undefined);
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.POSITIVE_INFINITY;
    };
    members.sort((a, b) => (index === 0 ? 0 : key(a) - key(b)) || a.position.y - b.position.y);
    members.forEach((n, i) => { row[n.id] = i; });
  });

  const originX = Math.min(...placeable.map((n) => n.position.x));
  const originY = Math.min(...placeable.map((n) => n.position.y));
  const positions = {};
  let x = originX;
  for (const members of columns) {
    let y = originY;
    let widest = 0;
    for (const n of members) {
      positions[n.id] = { x, y };
      y += heightOf(n) + TIDY_GAP.y;
      widest = Math.max(widest, widthOf(n));
    }
    x += widest + TIDY_GAP.x;
  }

  return nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n));
}
