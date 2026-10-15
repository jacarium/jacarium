/**
 * Finding a node type by name: the ranking behind the node library's filter
 * box, the connection menu (a wire dropped on empty canvas) and the quick-add
 * palette. Pure functions over the category list (workflowNodeCategories.js
 * NODE_CATEGORIES, passed in so this module stays dependency-free).
 */

/** Categories whose nodes have no execution pins at all. */
const PIN_LESS_CATEGORIES = ['Variables', 'Notes'];

/**
 * The categories (and the nodes within them) that can sit at the far end of
 * a wire dragged off a pin, for the ConnectionMenu's `connectionType`:
 *   execution-source  the wire leaves an exec output: nodes with an exec input
 *   execution-target  the wire leaves an exec input: nodes with an exec output
 *   data-source       the wire leaves a data output: nodes that take data
 *   data-target       the wire leaves a data input: nodes that produce data
 * Anything else shows every category. Empty categories are dropped.
 */
export function compatibleCategoriesFor(categories, connectionType) {
  const keep = (predicate) => categories
    .map(category => ({ ...category, nodes: category.nodes.filter(node => predicate(node, category)) }))
    .filter(category => category.nodes.length > 0);

  switch (connectionType) {
    case 'execution-source':
      // Variables and notes have no execution pins; Begin Play has no exec input
      return keep((node, category) => !PIN_LESS_CATEGORIES.includes(category.category) && node.type !== 'beginplay');
    case 'execution-target':
      // Only nodes with an execution output (notes have none)
      return keep((node, category) => category.category !== 'Notes' &&
        (node.type === 'beginplay' || category.category === 'Control Flow' || category.category === 'Actions'));
    case 'data-source':
      // All nodes except Begin Play can receive data
      return keep((node) => node.type !== 'beginplay');
    case 'data-target':
      // Variables, notes and the action nodes that output data
      return keep((node, category) => PIN_LESS_CATEGORIES.includes(category.category) ||
        node.type === 'restapi' || node.type === 'transformation' || node.type === 'visualizer');
    default:
      return categories;
  }
}

/**
 * How well `node` matches `query` (lower is better; null when it does not
 * match): an exact label first, then a label starting with the query, a
 * word of the label starting with it, the label containing it, then the
 * description and finally the type id.
 */
export function nodeMatchRank(node, query) {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const label = node.label.toLowerCase();
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  if (label.split(/\s+/).some(word => word.startsWith(q))) return 2;
  if (label.includes(q)) return 3;
  if ((node.description || '').toLowerCase().includes(q)) return 4;
  if (node.type.toLowerCase().includes(q)) return 5;
  return null;
}

/**
 * The matching nodes of every category, best match first and ties in
 * category order; each entry carries its category name. With an empty
 * query every node is listed in category order.
 */
export function rankNodes(categories, query) {
  const entries = [];
  categories.forEach((category, categoryIndex) => {
    category.nodes.forEach((node, nodeIndex) => {
      const rank = nodeMatchRank(node, query);
      if (rank !== null) entries.push({ node, category: category.category, rank, order: categoryIndex * 1000 + nodeIndex });
    });
  });
  return entries
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ node, category }) => ({ ...node, category }));
}

/** The categories with only their nodes that match `query` (empty ones dropped). */
export function filterCategories(categories, query) {
  return categories
    .map(category => ({ ...category, nodes: category.nodes.filter(node => nodeMatchRank(node, query) !== null) }))
    .filter(category => category.nodes.length > 0);
}
