import { NODE_CATEGORIES } from './workflowNodeCategories';
import { compatibleCategoriesFor } from './nodeSearch';
import NodeSearchMenu from './NodeSearchMenu';

/**
 * The menu shown when a wire is dropped on empty canvas: the node types
 * whose pins can take the other end of that wire (nodeSearch.js
 * compatibleCategoriesFor), searchable. Picking one adds it at the drop
 * point and wires it up (useWorkflowCanvas.handleConnectionMenuSelect).
 *
 * @param {'execution-source'|'execution-target'|'data-source'|'data-target'} connectionType
 */
export default function ConnectionMenu({ position, onSelectNode, onClose, connectionType }) {
  return (
    <NodeSearchMenu
      position={position}
      categories={compatibleCategoriesFor(NODE_CATEGORIES, connectionType)}
      onSelect={onSelectNode}
      onClose={onClose}
    />
  );
}
