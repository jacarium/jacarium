import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { isSharedWorkflow, isSharedByMe } from '../../utils/workflowSharing';
import { MenuItemIcon } from '../common/menus/MenuItemIcon';

const ITEM_CLASS = 'w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2';
// Destructive items (Delete) are red in every menu of the app
const DANGER_ITEM_CLASS = ITEM_CLASS.replace('text-os-text-primary', 'text-red-600');
const Divider = () => <div className="border-t border-os-border my-1"></div>;

/**
 * Cloud entries shared by the selection and category menus: Upload for
 * workflows not in the cloud yet, Sync / Remove / Permissions when the set
 * holds cloud workflows this app owns. Renders nothing when neither
 * applies.
 */
function BatchSharingItems({ workflows, currentMachineId, onShare, onStopSharing, onPermissions, dividerClass }) {
  const hasUnshared = workflows.some(w => !isSharedWorkflow(w));
  const hasOwnShared = workflows.some(w => isSharedByMe(w, currentMachineId));

  if (!hasUnshared && !hasOwnShared) return null;

  return (
    <>
      <div className={dividerClass} />
      {hasUnshared && (
        <button onClick={onShare} className={ITEM_CLASS}>
          <MenuItemIcon action="uploadToCloud" />
          Upload to Cloud
        </button>
      )}
      {hasOwnShared && (
        <button onClick={onShare} className={ITEM_CLASS}>
          <MenuItemIcon action="syncToCloud" />
          Sync to Cloud
        </button>
      )}
      {hasOwnShared && (
        <button onClick={onStopSharing} className={ITEM_CLASS}>
          <MenuItemIcon action="removeFromCloud" />
          Remove from Cloud
        </button>
      )}
      {hasOwnShared && (
        <button onClick={onPermissions} className={ITEM_CLASS}>
          <MenuItemIcon action="managePermissions" />
          Manage Permissions
        </button>
      )}
    </>
  );
}

/**
 * Right-click menu of the workflow list. `menu.type` picks the flavour:
 *   'single'   - one workflow (AI context, duplicate, export, cloud, delete)
 *   'bulk'     - the current selection
 *   'category' - every workflow of a category
 * Every item runs its action and closes the menu; the menu also closes on
 * an outside mousedown and keeps itself inside the window.
 */
export default function WorkflowContextMenu({
  menu,
  workflows,
  selectedWorkflows,
  currentMachineId,
  onClose,
  onExportBase64,
  onExportJson,
  onBulkMove,
  onBulkDelete,
  onDuplicate,
  onDelete,
  onAddAIContext,
  onShare,
  onStopSharing,
  onManagePermissions,
  onShareMany,
  onStopSharingMany,
  onManageManyPermissions
}) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        onClose();
      }
    }

    // Delay adding listener to avoid immediate trigger from the click that opened the menu
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside, true); // Use capture phase
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside, true);
    };
  }, [onClose]);

  // Correct the position using the real rendered menu size
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const menuRect = menuRef.current.getBoundingClientRect();
    const margin = 10;
    let { x, y } = position;
    if (menuRect.right > window.innerWidth - margin) {
      x = Math.max(margin, x - (menuRect.right - window.innerWidth + margin));
    }
    if (menuRect.bottom > window.innerHeight - margin) {
      y = Math.max(margin, y - (menuRect.bottom - window.innerHeight + margin));
    }
    if (x !== position.x || y !== position.y) {
      setPosition({ x, y });
    }
  }, [position]);

  const run = (action) => () => {
    action?.();
    onClose();
  };

  const selectedWorkflowsList = workflows.filter(w => selectedWorkflows.includes(w.id));
  const categoryWorkflowsList = menu.type === 'category'
    ? workflows.filter(w => (w.category || 'General') === menu.category)
    : [];
  const workflow = menu.workflow;
  // The owner and users granted 'write' may sync their changes to the cloud
  const canPushChanges = workflow && isSharedWorkflow(workflow) &&
    (workflow.ownerId === currentMachineId || workflow.permissions?.[currentMachineId] === 'write');

  return (
    <div
      ref={menuRef}
      className="fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px]"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
    >
      {menu.type === 'bulk' && (
        <>
          <div className="px-4 py-2 text-xs font-medium text-os-text-secondary border-b border-os-border">
            {selectedWorkflows.length} workflow{selectedWorkflows.length !== 1 ? 's' : ''} selected
          </div>
          <button onClick={run(() => onExportJson?.(selectedWorkflowsList))} className={ITEM_CLASS}>
            <MenuItemIcon action="exportJson" />
            {selectedWorkflowsList.length === 1 ? 'Export Workflow (JSON)' : `Export ${selectedWorkflowsList.length} Workflows (JSON)`}
          </button>
          <button onClick={run(() => onExportBase64?.(selectedWorkflowsList))} className={ITEM_CLASS}>
            <MenuItemIcon action="exportBase64" />
            Export as Base64
          </button>
          <button onClick={run(onBulkMove)} className={ITEM_CLASS}>
            <MenuItemIcon action="moveToCategory" />
            Move to Category
          </button>

          <BatchSharingItems
            workflows={selectedWorkflowsList}
            currentMachineId={currentMachineId}
            dividerClass="border-t border-os-border my-1"
            onShare={run(() => onShareMany(selectedWorkflowsList, 'No workflows available to sync.'))}
            onStopSharing={run(() => onStopSharingMany(selectedWorkflowsList, 'No cloud workflows that you own selected.'))}
            onPermissions={run(() => onManageManyPermissions(selectedWorkflowsList, 'You can only manage permissions for cloud workflows that you own.'))}
          />

          <Divider />
          <button onClick={run(onBulkDelete)} className={DANGER_ITEM_CLASS}>
            <MenuItemIcon action="delete" danger />
            Delete Selected
          </button>
        </>
      )}

      {menu.type === 'category' && menu.category && (
        <>
          <button onClick={run(() => onExportJson?.(categoryWorkflowsList, { category: menu.category }))} className={ITEM_CLASS}>
            <MenuItemIcon action="exportJson" />
            Export Category as JSON
          </button>
          <button onClick={run(() => onExportBase64?.(categoryWorkflowsList))} className={ITEM_CLASS}>
            <MenuItemIcon action="exportBase64" />
            Export Category as Base64
          </button>
          <BatchSharingItems
            workflows={categoryWorkflowsList}
            currentMachineId={currentMachineId}
            dividerClass="h-px bg-os-border my-1"
            onShare={run(() => onShareMany(categoryWorkflowsList, 'No workflows available to sync in this category.'))}
            onStopSharing={run(() => onStopSharingMany(categoryWorkflowsList, 'No cloud workflows that you own in this category.'))}
            onPermissions={run(() => onManageManyPermissions(categoryWorkflowsList, 'No cloud workflows that you own in this category.'))}
          />
        </>
      )}

      {menu.type === 'single' && workflow && (
        <>
          <button onClick={run(() => onAddAIContext(workflow))} className={ITEM_CLASS}>
            <MenuItemIcon action="aiContext" />
            Add as AI Context
          </button>

          <Divider />

          <button onClick={run(() => onDuplicate(workflow))} className={ITEM_CLASS}>
            <MenuItemIcon action="duplicate" />
            Duplicate
          </button>
          <button onClick={run(() => onExportJson?.([workflow]))} className={ITEM_CLASS}>
            <MenuItemIcon action="exportJson" />
            Export Workflow (JSON)
          </button>
          <button onClick={run(() => onExportBase64?.([workflow]))} className={ITEM_CLASS}>
            <MenuItemIcon action="exportBase64" />
            Export as Base64
          </button>
          <Divider />
          {!isSharedWorkflow(workflow) && (
            <button onClick={run(() => onShare(workflow))} className={ITEM_CLASS}>
              <MenuItemIcon action="uploadToCloud" />
              Upload to Cloud
            </button>
          )}
          {canPushChanges && (
            <button onClick={run(() => onShare(workflow))} className={ITEM_CLASS}>
              <MenuItemIcon action="syncToCloud" />
              Sync to Cloud
            </button>
          )}
          {/* Remove from cloud and permissions - only for the owner */}
          {isSharedByMe(workflow, currentMachineId) && (
            <>
              <button onClick={run(() => onStopSharing(workflow))} className={ITEM_CLASS}>
                <MenuItemIcon action="removeFromCloud" />
                Remove from Cloud
              </button>
              <button onClick={run(() => onManagePermissions(workflow))} className={ITEM_CLASS}>
                <MenuItemIcon action="managePermissions" />
                Manage Permissions
              </button>
            </>
          )}
          <Divider />
          <button onClick={run(() => onDelete(workflow))} className={DANGER_ITEM_CLASS}>
            <MenuItemIcon action="delete" danger />
            Delete Workflow
          </button>
        </>
      )}
    </div>
  );
}
