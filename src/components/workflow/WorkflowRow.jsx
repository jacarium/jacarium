import { Workflow, SquareCheckBig, Cloud, Crown } from 'lucide-react';
import { ListRow } from '../common/sidebar/ListRow';
import InlineEdit from '../common/inputs/InlineEdit';
import { getUserBorderStyle } from '../../utils/userColors';
import { isSharedWorkflow } from '../../utils/workflowSharing';

/**
 * One workflow in the list. Click opens it (or toggles it in selection
 * mode), double-click renames it in place when the user may edit it, and it
 * can be dragged onto another category. Cloud workflows are tinted purple
 * and show a crown when this app owns them; the left border carries the
 * owner's colour.
 */
export default function WorkflowRow({
  workflow,
  isActive,
  isSelected,
  isEditing,
  selectionMode,
  currentMachineId,
  onClick,
  onDoubleClick,
  onRename,
  onStopEditing,
  onContextMenu,
  onDragStart,
  onDragEnd
}) {
  const isShared = isSharedWorkflow(workflow);
  const isMine = workflow.ownerId === currentMachineId;
  const ownerStyle = isShared && workflow.ownerId
    ? getUserBorderStyle(workflow.ownerId)
    : !isShared && currentMachineId
    ? getUserBorderStyle(currentMachineId)
    : undefined;

  if (isEditing) {
    return (
      <div
        className="w-full flex items-center gap-2 px-4 py-3 text-sm border-l-4 border-os-blue bg-blue-50"
        style={ownerStyle}
      >
        <Workflow size={14} className="text-os-blue shrink-0" />
        <InlineEdit
          value={workflow.title || 'Untitled'}
          onSave={(newTitle) => {
            onRename(newTitle);
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
          inputClassName="text-sm"
        />
      </div>
    );
  }

  return (
    <ListRow role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
      draggable={!selectionMode}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={`flex items-center px-4 py-3 text-sm transition-colors border-l-4 cursor-pointer ${
 isSelected
 ?'bg-os-blue/10 border-os-blue'
 : isActive && isShared
 ?'bg-purple-100 hover:bg-purple-200'
 : isActive
 ?'bg-blue-50 border-os-blue'
 : isShared
 ?'bg-purple-50 hover:bg-purple-100'
 :'border-transparent hover:bg-os-card-secondary'
 }`}
      style={ownerStyle}
    >
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {selectionMode && (
            <SquareCheckBig
              size={16}
              className={`shrink-0 ${isSelected ?'text-os-text-primary':'text-os-text-muted'}`}
            />
          )}
          <Workflow
            size={14}
            className={`shrink-0 ${
 isSelected
 ?'text-os-text-primary'
 : isActive && isShared
 ?'text-purple-700'
 : isActive
 ?'text-os-blue'
 :'text-os-text-muted'
 }`}
          />
          <span className={`text-sm truncate ${
 isSelected
 ?'text-os-text-primary font-medium'
 : isActive && isShared
 ?'text-purple-700'
 : isActive
 ?'text-os-blue font-medium'
 :'text-os-text-primary'
 }`}>
            {workflow.title || 'Untitled'}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isShared && (
            <div className="flex items-center gap-0.5" title={isMine ? 'Shared with the team by you' : `Shared with the team by ${workflow.ownerId || 'Unknown'}`}>
              {isMine && (
                <Crown size={10} className="text-purple-600" />
              )}
              <Cloud size={12} className="text-purple-600" />
            </div>
          )}
        </div>
      </div>
    </ListRow>
  );
}
