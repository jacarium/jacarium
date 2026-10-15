import { ChevronRight, ChevronDown } from 'lucide-react';
import InlineEdit from '../common/inputs/InlineEdit';

/**
 * One collapsible category row of the workflow list. Double-click renames
 * it in place; it is also a drop target for workflows dragged between
 * categories (`isDragOver` highlights it while one hovers). A category
 * holding cloud workflows is tinted purple.
 */
export default function WorkflowCategoryHeader({
  category,
  count,
  isExpanded,
  isEditing,
  isDragOver,
  hasSharedWorkflows,
  onToggle,
  onStartEditing,
  onRename,
  onStopEditing,
  onContextMenu,
  onDragOver,
  onDragLeave,
  onDrop
}) {
  const Chevron = isExpanded ? ChevronDown : ChevronRight;

  if (isEditing) {
    return (
      <div
        className={`w-full flex items-center gap-2 px-2 py-2 text-sm transition-colors ${
 isDragOver ?'bg-os-blue' :'bg-blue-50/20'
 }`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <Chevron size={16} className="text-os-blue shrink-0" />
        <InlineEdit
          value={category}
          onSave={(newCategory) => {
            onRename(newCategory);
            onStopEditing();
          }}
          onCancel={onStopEditing}
          isEditing={true}
          onEditingChange={(editing) => {
            if (!editing) {
              onStopEditing();
            }
          }}
          className="flex-1 min-w-0"
          inputClassName="text-sm font-medium"
        />
        <span className="text-xs text-os-text-muted shrink-0">{count}</span>
      </div>
    );
  }

  return (
    <button
      onClick={onToggle}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartEditing();
      }}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`sc-row rounded-none w-full flex items-center gap-2 px-2 py-2 text-sm text-os-text-primary transition-colors ${
 isDragOver ?'bg-os-blue/20':'hover:bg-os-card-secondary'
 }`}
    >
      <Chevron size={16} className="text-os-text-secondary shrink-0" />
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        <span className={`font-medium text-left truncate ${hasSharedWorkflows ?'text-purple-700':''}`}>
          {category}
        </span>
      </div>
      <span className="text-xs text-os-text-muted shrink-0">{count}</span>
    </button>
  );
}
