import { useState, useEffect, useRef } from 'react';
import { Workflow, Menu, Plus, CheckSquare, X, Loader } from 'lucide-react';
import WorkflowPermissionsModal from '../common/modals/WorkflowPermissionsModal';
import WorkflowListMenu from './WorkflowListMenu';
import WorkflowContextMenu from './WorkflowContextMenu';
import WorkflowCategoryHeader from './WorkflowCategoryHeader';
import WorkflowRow from './WorkflowRow';
import { getMachineId } from '../../utils/cloudCentralSync';
import { addWorkflowAsAIContext } from '../../utils/workflowAIContext';
import useWorkflowSharing from '../../hooks/useWorkflowSharing';
import { isMineOrUnshared } from '../../utils/workflowSharing';
import { EmptyState } from '../ui';

/**
 * The library pane: workflows grouped by collapsible category, with a
 * hamburger menu (sort, import/export, variables), right-click menus, inline
 * renaming, drag-to-category and multi-select. Everything that changes a
 * workflow is delegated to the builder through the on* props; sharing with
 * the team lives in useWorkflowSharing.
 */
export default function WorkflowList({
  workflows = [],
  onWorkflowClick,
  onWorkflowDelete,
  onWorkflowDuplicate,
  onWorkflowRename,
  onCategoryRename,
  onWorkflowCategoryChange,
  onNewWorkflow,
  currentWorkflowId,
  selectionMode = false,
  selectedWorkflows = [],
  onToggleSelectionMode,
  onToggleWorkflowSelection,
  onBulkDelete,
  onBulkMove,
  onExportAll,
  onImport,
  onExportBase64,
  onImportBase64,
  onOpenVariables,
  onWorkflowsChanged,
  sortBy = 'date',
  onSortChange,
  centralServerStatus = null,
  // the phone layout: no new workflow, no selection, no renaming; the
  // menus keep their non-editing entries (sorting, exports, AI context)
  readOnly = false
}) {
  const [expandedCategories, setExpandedCategories] = useState(() => {
    const saved = localStorage.getItem('expandedWorkflowCategories');
    return saved ? JSON.parse(saved) : ['General'];
  });
  const [menuAnchor, setMenuAnchor] = useState(null); // the menu button's rect while the dropdown is open
  const [contextMenu, setContextMenu] = useState(null); // { x, y, type, workflow?, category? }
  const [editingWorkflowId, setEditingWorkflowId] = useState(null);
  const [editingCategory, setEditingCategory] = useState(null);
  const [draggedWorkflow, setDraggedWorkflow] = useState(null);
  const [dragOverCategory, setDragOverCategory] = useState(null);
  const [currentMachineId, setCurrentMachineId] = useState(null);
  const clickTimerRef = useRef(null);
  const menuRef = useRef(null);

  const sharing = useWorkflowSharing({ currentMachineId, onWorkflowsChanged });

  // Group workflows by category
  const categories = [...new Set(workflows.map(w => w.category || 'General'))].sort();

  // Load machine ID on mount
  useEffect(() => {
    async function loadMachineId() {
      const id = await getMachineId();
      setCurrentMachineId(id);
    }
    loadMachineId();
  }, []);

  // Save expanded categories
  useEffect(() => {
    localStorage.setItem('expandedWorkflowCategories', JSON.stringify(expandedCategories));
  }, [expandedCategories]);

  // Cleanup click timer on unmount
  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  // Close the dropdown on outside click. The wrapper (button + menu) is the
  // inside, so a click on the button toggles rather than closes-then-reopens.
  useEffect(() => {
    if (!menuAnchor) return;

    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuAnchor(null);
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
  }, [menuAnchor]);

  function toggleCategory(category) {
    setExpandedCategories(prev =>
      prev.includes(category)
        ? prev.filter(c => c !== category)
        : [...prev, category]
    );
  }

  function handleMenuClick(e) {
    e.stopPropagation();
    setMenuAnchor(menuAnchor ? null : e.currentTarget.getBoundingClientRect());
  }

  function handleWorkflowContextMenu(e, workflow) {
    e.preventDefault();
    e.stopPropagation();

    // If in selection mode and workflows are selected, show bulk actions
    if (selectionMode && selectedWorkflows.length > 0) {
      setContextMenu({ x: e.clientX, y: e.clientY, type: 'bulk' });
    } else {
      setContextMenu({ x: e.clientX, y: e.clientY, type: 'single', workflow });
    }
  }

  function handleCategoryContextMenu(e, category) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'category', category });
  }

  function handleWorkflowRowClick(workflow) {
    if (selectionMode) {
      onToggleWorkflowSelection(workflow.id);
    } else if (readOnly) {
      // no double-click to tell apart (renaming is off), and the phone
      // drawer closes on the tap: open straight away, not after a delay
      onWorkflowClick(workflow);
    } else {
      // Delay onClick to distinguish from double-click
      clickTimerRef.current = setTimeout(() => {
        onWorkflowClick(workflow);
      }, 250);
    }
  }

  function handleWorkflowRowDoubleClick(e, workflow) {
    e.stopPropagation();
    // Clear the single click timer
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    // Only allow rename if not in selection mode and the workflow is ours (unshared, or shared by us)
    if (!selectionMode && isMineOrUnshared(workflow, currentMachineId)) {
      setEditingWorkflowId(workflow.id);
    }
  }

  // Drag and drop handlers
  function handleWorkflowDragStart(e, workflow) {
    setDraggedWorkflow(workflow);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', workflow.id);
  }

  function handleWorkflowDragEnd() {
    setDraggedWorkflow(null);
    setDragOverCategory(null);
  }

  function handleCategoryDragOver(e, category) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (draggedWorkflow && draggedWorkflow.category !== category) {
      setDragOverCategory(category);
    }
  }

  function handleCategoryDragLeave(e, category) {
    // Only clear if we're actually leaving this category's element
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget)) {
      if (dragOverCategory === category) {
        setDragOverCategory(null);
      }
    }
  }

  function handleCategoryDrop(e, category) {
    e.preventDefault();
    setDragOverCategory(null);

    if (draggedWorkflow && draggedWorkflow.category !== category) {
      if (onWorkflowCategoryChange) {
        onWorkflowCategoryChange(draggedWorkflow.id, category);
      }
    }
    setDraggedWorkflow(null);
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-os-card">
      {/* Header */}
      <div className="p-4 border-b border-os-border shrink-0 bg-os-card">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Workflow size={16} className="text-os-text-secondary shrink-0" />
            <span className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide truncate">
              Workflows
            </span>
            {centralServerStatus && (
              <div className="shrink-0" title={
                centralServerStatus === 'checking' ? 'Checking central server...' :
                centralServerStatus === 'online' ? 'Connected to central server' :
                'Central server offline'
              }>
                {centralServerStatus === 'checking' && (
                  <Loader size={12} className="text-os-text-muted animate-spin" />
                )}
                {centralServerStatus === 'online' && (
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                )}
                {centralServerStatus === 'offline' && (
                  <div className="w-2 h-2 rounded-full bg-red-500"></div>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!readOnly && (
            <button
              onClick={onToggleSelectionMode}
              className={`p-1.5 transition-colors ${
 selectionMode
 ?'bg-os-blue text-white hover:bg-os-blue-hover'
 :'hover:bg-os-card-secondary'
 }`}
              title={selectionMode ? 'Exit selection mode' : 'Select multiple'}
            >
              {selectionMode ? <X size={16} /> : <CheckSquare size={16} className="text-os-text-secondary" />}
            </button>
            )}
            {!readOnly && (
            <button
              onClick={onNewWorkflow}
              data-testid="workflow-new"
              className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
              title="New workflow"
            >
              <Plus size={16} className="text-os-text-secondary" />
            </button>
            )}
            <div className="relative" ref={menuRef}>
              <button
                onClick={handleMenuClick}
                className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
                title="Workflow menu"
              >
                <Menu size={16} className="text-os-text-secondary" />
              </button>

              {/* Dropdown Menu */}
              {menuAnchor && (
                <WorkflowListMenu
                  anchorRect={menuAnchor}
                  onClose={() => setMenuAnchor(null)}
                  selectionMode={selectionMode}
                  hasSelection={selectedWorkflows.length > 0}
                  onBulkMove={onBulkMove}
                  onBulkDelete={onBulkDelete}
                  onOpenVariables={onOpenVariables}
                  onNewWorkflow={onNewWorkflow}
                  sortBy={sortBy}
                  onSortChange={onSortChange}
                  onImport={onImport}
                  onImportBase64={onImportBase64}
                  onExportAll={onExportAll}
                  onExportBase64={onExportBase64}
                  readOnly={readOnly}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Workflow List */}
      <div className="flex-1 overflow-y-auto">
        {categories.map(category => {
          const isExpanded = expandedCategories.includes(category);
          const categoryWorkflows = workflows.filter(w => (w.category || 'General') === category);

          return (
            <div key={category}>
              <WorkflowCategoryHeader
                category={category}
                count={categoryWorkflows.length}
                isExpanded={isExpanded}
                isEditing={editingCategory === category}
                isDragOver={dragOverCategory === category}
                hasSharedWorkflows={categoryWorkflows.some(w => w.inCloud === true)}
                onToggle={() => toggleCategory(category)}
                onStartEditing={() => setEditingCategory(category)}
                onRename={(newCategory) => onCategoryRename?.(category, newCategory)}
                onStopEditing={() => setEditingCategory(null)}
                onContextMenu={(e) => handleCategoryContextMenu(e, category)}
                onDragOver={(e) => handleCategoryDragOver(e, category)}
                onDragLeave={(e) => handleCategoryDragLeave(e, category)}
                onDrop={(e) => handleCategoryDrop(e, category)}
              />

              {/* Workflows in Category */}
              {isExpanded && (
                <div>
                  {categoryWorkflows.map(workflow => (
                    <WorkflowRow
                      key={workflow.id}
                      workflow={workflow}
                      isActive={workflow.id === currentWorkflowId && !selectionMode}
                      isSelected={selectionMode && selectedWorkflows.includes(workflow.id)}
                      isEditing={!readOnly && editingWorkflowId === workflow.id && isMineOrUnshared(workflow, currentMachineId)} // Only allow editing if ours
                      selectionMode={selectionMode}
                      currentMachineId={currentMachineId}
                      onClick={() => handleWorkflowRowClick(workflow)}
                      onDoubleClick={readOnly ? undefined : (e) => handleWorkflowRowDoubleClick(e, workflow)}
                      onRename={(newTitle) => onWorkflowRename?.(workflow.id, newTitle)}
                      onStopEditing={() => setEditingWorkflowId(null)}
                      onContextMenu={(e) => handleWorkflowContextMenu(e, workflow)}
                      onDragStart={(e) => handleWorkflowDragStart(e, workflow)}
                      onDragEnd={handleWorkflowDragEnd}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {workflows.length === 0 && (
          <EmptyState compact icon={Workflow} title="No workflows yet" />
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <WorkflowContextMenu
          menu={contextMenu}
          workflows={workflows}
          selectedWorkflows={selectedWorkflows}
          currentMachineId={currentMachineId}
          onClose={() => setContextMenu(null)}
          onExportBase64={onExportBase64}
          onExportJson={onExportAll}
          onBulkMove={onBulkMove}
          onBulkDelete={onBulkDelete}
          onDuplicate={onWorkflowDuplicate}
          onDelete={onWorkflowDelete}
          onAddAIContext={addWorkflowAsAIContext}
          onShare={sharing.shareWorkflow}
          onStopSharing={sharing.stopSharing}
          onManagePermissions={sharing.managePermissions}
          onShareMany={sharing.shareWorkflows}
          onStopSharingMany={sharing.stopSharingWorkflows}
          onManageManyPermissions={sharing.managePermissionsFor}
          readOnly={readOnly}
        />
      )}

      {/* Permissions Modal */}
      <WorkflowPermissionsModal {...sharing.permissionsModal} />
    </div>
  );
}
