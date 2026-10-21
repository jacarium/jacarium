import { useState, useCallback, useEffect } from 'react';
import { useShortcut } from '../shortcuts/useShortcut';
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  SelectionMode
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Workflow } from 'lucide-react';
import { useSessionPersistence, useLocalStorage } from '../hooks/useLocalStorage';
import ResizableSidebar from './ResizableSidebar';
import VerticalResizableDivider from './VerticalResizableDivider';
import WorkflowNodeLibrary from './workflow/WorkflowNodeLibrary';
import WorkflowList from './workflow/WorkflowList';
import EnvironmentVariables from './workflow/EnvironmentVariables';
import ConfirmationModal from './common/ConfirmationModal';
import TabBar from './features/documents/TabBar';
import BeginPlayNode from './workflow/nodes/BeginPlayNode';
import StringVariableNode from './workflow/nodes/StringVariableNode';
import IntegerVariableNode from './workflow/nodes/IntegerVariableNode';
import TextVariableNode from './workflow/nodes/TextVariableNode';
import BooleanVariableNode from './workflow/nodes/BooleanVariableNode';
import ObjectVariableNode from './workflow/nodes/ObjectVariableNode';
import ArrayVariableNode from './workflow/nodes/ArrayVariableNode';
import RESTAPINode from './workflow/nodes/RESTAPINode';
import SSHNode from './workflow/nodes/SSHNode';
import MakeArrayNode from './workflow/nodes/MakeArrayNode';
import TransformationNode from './workflow/nodes/TransformationNode';
import DelayNode from './workflow/nodes/DelayNode';
import BranchNode from './workflow/nodes/BranchNode';
import SwitchNode from './workflow/nodes/SwitchNode';
import SequenceNode from './workflow/nodes/SequenceNode';
import ForLoopNode from './workflow/nodes/ForLoopNode';
import StorageNode from './workflow/nodes/StorageNode';
import VisualizerNode from './workflow/nodes/VisualizerNode';
import ResultNode from './workflow/nodes/ResultNode';
import VariableReferenceNode from './workflow/nodes/VariableReferenceNode';
import ComparisonNode from './workflow/nodes/ComparisonNode';
import NoteNode from './workflow/nodes/NoteNode';
import IdeaNode from './workflow/nodes/IdeaNode';
import { getNoteColor } from './workflow/nodes/noteColors';
import ExecutionEdge from './workflow/edges/ExecutionEdge';
import DataEdge from './workflow/edges/DataEdge';
import ConnectionMenu from './workflow/ConnectionMenu';
import NodeSearchMenu from './workflow/NodeSearchMenu';
import NodeContextMenu from './workflow/NodeContextMenu';
import ExecutionToolbar from './workflow/ExecutionToolbar';
import FloatingSSHTerminal from './workflow/FloatingSSHTerminal';
import Base64TransferModal from './workflow/Base64TransferModal';
import TransferTextModal from './common/TransferTextModal';
import BulkMoveCategoryModal from './workflow/BulkMoveCategoryModal';
import WorkflowTabContextMenu from './workflow/WorkflowTabContextMenu';
import { ANNOTATION_NODE_TYPES, NODE_CATEGORIES } from './workflow/workflowNodeCategories';
import { isEditableTarget, shouldCopyNodesOnShortcut, nodePinEdges } from './workflow/workflowNodeUtils';
import useWorkflowExecution from '../hooks/useWorkflowExecution';
import useWorkflowSession from '../hooks/useWorkflowSession';
import useWorkflowLibraryActions from '../hooks/useWorkflowLibraryActions';
import ImportJsonModal from './common/ImportJsonModal';
import JsonImportStats from './common/JsonImportStats';
import { validateWorkflowsImport, runWorkflowsImport } from '../utils/workflowsImport';
import { jsonMergeLabel, jsonMergeHint } from '../utils/jsonImportMerge';
import useWorkflowCanvas, { FIT_VIEW_OPTIONS } from '../hooks/useWorkflowCanvas';
import { getWorkflow } from '../utils/workflows';
import { addWorkflowAsAIContext } from '../utils/workflowAIContext';
import { onConnectionStatusChange } from '../utils/cloudWebSocket';
import { EmptyState, Button } from './ui';
import { useMobile } from '../contexts/MobileContext';
import MobileWorkflowView, { MobileWorkflowToolbar } from './mobile/MobileWorkflowView';

// Register custom node types
const nodeTypes = {
  beginplay: BeginPlayNode,
  string: StringVariableNode,
  integer: IntegerVariableNode,
  text: TextVariableNode,
  boolean: BooleanVariableNode,
  object: ObjectVariableNode,
  array: ArrayVariableNode,
  restapi: RESTAPINode,
  ssh: SSHNode,
  makearray: MakeArrayNode,
  transformation: TransformationNode,
  delay: DelayNode,
  branch: BranchNode,
  switch: SwitchNode,
  sequence: SequenceNode,
  forloop: ForLoopNode,
  storage: StorageNode,
  variablereference: VariableReferenceNode,
  visualizer: VisualizerNode,
  result: ResultNode,
  comparison: ComparisonNode,
  // Freeform / mind-map nodes (no execution semantics)
  note: NoteNode,
  idea: IdeaNode
};

// MiniMap swatches: notes keep their own colour, everything else is "data purple"
function miniMapNodeColor(node) {
  return ANNOTATION_NODE_TYPES.includes(node.type)
    ? getNoteColor(node.data?.color).solid
    : '#9333ea';
}

// Register custom edge types
const edgeTypes = {
  execution: ExecutionEdge,
  data: DataEdge
};

/** Workflow list order: newest first, or by title. */
function sortWorkflows(workflows, sortBy) {
  return [...workflows].sort((a, b) => {
    if (sortBy === 'title') {
      return a.title.localeCompare(b.title);
    } else if (sortBy === 'date') {
      return (b.updatedAt || 0) - (a.updatedAt || 0); // Newest first
    }
    return 0;
  });
}

/**
 * The Workflows page: library + node palette on the left, tabs and the
 * React Flow canvas on the right. The state lives in three hooks -
 * useWorkflowSession (what is open, tabs, load/save), useWorkflowLibraryActions
 * (what the list's menus do) and useWorkflowCanvas (what happens on the
 * canvas) - plus useWorkflowExecution for Run/Stop/Clear.
 */
export default function WorkflowBuilder() {
  const [splitViewEnabled, setSplitViewEnabled] = useSessionPersistence('workflowSplitViewEnabled', false);
  const [splitPosition, setSplitPosition] = useSessionPersistence('workflowSplitPosition', 50);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [workflowSortBy, setWorkflowSortBy] = useLocalStorage('workflowSortBy', 'date');
  const [nodeLibraryCollapsed, setNodeLibraryCollapsed] = useLocalStorage('nodeLibraryCollapsed', false);
  // Snap dragged nodes to the background grid; remembered per viewer (useLocalStorage guards storage with try/catch)
  const [snapToGrid, setSnapToGrid] = useLocalStorage('workflowSnapToGrid', false);
  const [tabContextMenu, setTabContextMenu] = useState(null); // { x, y, tabId }
  const [showEnvVariables, setShowEnvVariables] = useState(false);
  const [centralServerStatus, setCentralServerStatus] = useState(null);
  // On a phone workflows are read-only: a list instead of the canvas, no
  // node library, no create/rename/delete (src/components/mobile/MobileWorkflowView.jsx)
  const { isMobile } = useMobile();

  // Which workflow is open, its canvas state, the tabs, load/save/restore.
  // Switching workflows aborts a running execution; that callback closes
  // over the execution hook declared below and only runs from event
  // handlers, so the order of the two hook calls is fine.
  const session = useWorkflowSession({
    onBeforeSwitch: () => {
      if (isExecuting) abortExecution();
    }
  });
  const {
    nodes, setNodes, onNodesChange,
    edges, setEdges, onEdgesChange,
    nodeIdCounterRef,
    history,
    currentWorkflow,
    isOwner,
    workflows,
    openTabs,
    loadWorkflows,
    handleNewWorkflow,
    handleWorkflowClick,
    handleTabClick,
    handleTabClose,
    handleTabReorder,
    handleCloseTabsToLeft,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
    handleCloseAllTabs
  } = session;

  // Run / stop / clear lifecycle + interactive SSH hand-off
  const {
    isExecuting,
    executeWorkflow,
    stopWorkflow,
    abortExecution,
    clearOutputs,
    interactiveSSH,
    completeInteractiveSSH,
    cancelInteractiveSSH
  } = useWorkflowExecution({
    nodes,
    edges,
    setNodes,
    currentWorkflow
  });

  // What the list's menus do to the library (rename, move, delete, duplicate,
  // bulk actions, import/export) and the modals those actions open
  const {
    handleRenameWorkflow,
    handleRenameCategory,
    handleWorkflowCategoryChange,
    handleDuplicateWorkflow,
    workflowToDelete, requestDelete, cancelDelete, confirmDelete,
    selectionMode, selectedWorkflows, toggleSelectionMode, toggleWorkflowSelection,
    handleBulkDelete, showBulkDeleteModal, closeBulkDelete, confirmBulkDelete,
    handleBulkMove, showBulkMoveModal, closeBulkMove, confirmBulkMove,
    handleExportAll, jsonExport, closeJsonExport, downloadJsonExport, handleImport, showImportModal, closeImportModal, confirmJsonImport, handleExportBase64, handleImportBase64,
    showBase64Modal, base64Mode, base64Data, setBase64Data, closeBase64Modal, confirmBase64Import
  } = useWorkflowLibraryActions(session);

  // Connecting, dropping, selecting, copying and the canvas menus; every
  // change goes through the history recorder for undo
  const {
    setReactFlowInstance,
    isValidConnection, fitCanvas, spaceHeld,
    selectedCount, alignSelected, distributeSelected, tidyCanvas,
    onPaneMouseMove, onPaneContextMenu, onCanvasDoubleClick,
    quickAdd, openQuickAddAtPointer, closeQuickAdd, handleQuickAddSelect,
    onNodesChange: onTrackedNodesChange, onEdgesChange: onTrackedEdgesChange,
    onNodeDragStart, onNodeDragStop,
    onConnect, onConnectStart, onConnectEnd,
    onDrop, onDragOver,
    onSelectionStart, onSelectionEnd,
    onNodeContextMenu, onEdgeClick, onEdgeUpdate,
    connectionMenuPosition, connectionType, handleConnectionMenuSelect, closeConnectionMenu,
    nodeContextMenu, handleNodeContextAction, closeNodeContextMenu,
    copySelectedNodes, pasteNodes
  } = useWorkflowCanvas({ nodes, edges, setNodes, setEdges, onNodesChange, onEdgesChange, nodeIdCounterRef, recorder: history.recorder });

  // Check if inner sidebar should be visible
  const [innerSidebarVisible, setInnerSidebarVisible] = useState(() => {
    const saved = localStorage.getItem('innerSidebarVisible');
    return saved !== null ? JSON.parse(saved) : true;
  });

  // Listen to WebSocket connection status
  useEffect(() => {
    // the central server's connection (none arrives when this app has no
    // central server: the status stays null)
    const unsubscribe = onConnectionStatusChange(({ connected }) => {
      setCentralServerStatus(connected ? 'online' : 'offline');
    });

    return unsubscribe;
  }, []);

  // Listen for inner sidebar visibility changes
  useEffect(() => {
    function handleVisibilityChange(event) {
      setInnerSidebarVisible(event.detail.visible);
    }
    window.addEventListener('innerSidebarVisibilityChange', handleVisibilityChange);
    return () => window.removeEventListener('innerSidebarVisibilityChange', handleVisibilityChange);
  }, []);

  // The canvas shortcuts (src/shortcuts/registry.js, scope 'workflow-canvas':
  // undo/redo, fit, Tab quick-add, copy/paste of nodes). None of them runs
  // while an editable field has focus (native undo/copy apply there - a
  // handler that returns false declines and the event goes on untouched).
  const onCanvas = (e) => !isEditableTarget(e.target);
  useShortcut('workflow.undo', () => (isOwner ? history.undo() : false), { when: onCanvas });
  useShortcut('workflow.redo', () => (isOwner ? history.redo() : false), { when: onCanvas });
  useShortcut('workflow.fit', () => fitCanvas(), { when: onCanvas });
  // quick-add palette at the pointer (owners only; Space is the pan key)
  useShortcut('workflow.quickAdd', () => (isOwner && currentWorkflow ? openQuickAddAtPointer() : false), { when: onCanvas });
  // copy selected nodes - unless the user has highlighted text (e.g. inside
  // a Visualizer/Result output): then the browser's native copy must win
  useShortcut('workflow.copyNodes', (event) => {
    if (!shouldCopyNodesOnShortcut({ target: event.target, selection: window.getSelection(), nodes })) return false;
    copySelectedNodes();
    return true;
  }, { when: onCanvas });
  useShortcut('workflow.pasteNodes', () => pasteNodes(), { when: onCanvas });

  // Handle tab context menu
  function handleTabContextMenu(e, tabId) {
    e.preventDefault();
    e.stopPropagation();
    setTabContextMenu({ x: e.clientX, y: e.clientY, tabId });
  }

  const closeTabContextMenu = useCallback(() => setTabContextMenu(null), []);

  // Run one of the session's close-tabs actions for the menu's tab, then dismiss the menu
  async function closeTabsVia(closeTabs) {
    await closeTabs(tabContextMenu.tabId);
    setTabContextMenu(null);
  }

  async function handleAddWorkflowAsAIContext() {
    if (!tabContextMenu) return;

    const workflow = await getWorkflow(tabContextMenu.tabId);
    if (workflow) {
      addWorkflowAsAIContext(workflow);
    }

    setTabContextMenu(null);
  }

  // Split view drag handlers
  useEffect(() => {
    if (!isDraggingSplit) return;

    function handleMouseMove(e) {
      const container = document.getElementById('workflow-container');
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      const newPercent = ((e.clientX - containerRect.left) / containerRect.width) * 100;

      // Constrain between 20% and 80%
      setSplitPosition(Math.min(Math.max(newPercent, 20), 80));
    }

    function handleMouseUp() {
      setIsDraggingSplit(false);
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingSplit, setSplitPosition]);

  function toggleSplitView() {
    setSplitViewEnabled(!splitViewEnabled);
  }

  function handleSplitDragStart() {
    setIsDraggingSplit(true);
  }

  return (
    <div className="flex h-full">
      {/* Node Library & Workflow List Sidebar */}
      {(innerSidebarVisible || isMobile) && (
        <ResizableSidebar
          defaultWidth={288}
          minWidth={200}
          maxWidth={400}
          storageKey="workflowBuilder-sidebar-width"
          position="right"
          className="bg-os-card flex flex-col"
        >
          {(width) => {
            const list = (
                <WorkflowList
                  workflows={sortWorkflows(workflows, workflowSortBy)}
                  onWorkflowClick={handleWorkflowClick}
                  onWorkflowDelete={requestDelete}
                  onWorkflowDuplicate={handleDuplicateWorkflow}
                  onWorkflowRename={handleRenameWorkflow}
                  onCategoryRename={handleRenameCategory}
                  onWorkflowCategoryChange={handleWorkflowCategoryChange}
                  onNewWorkflow={handleNewWorkflow}
                  currentWorkflowId={currentWorkflow?.id}
                  selectionMode={selectionMode}
                  selectedWorkflows={selectedWorkflows}
                  onToggleSelectionMode={toggleSelectionMode}
                  onToggleWorkflowSelection={toggleWorkflowSelection}
                  onBulkDelete={handleBulkDelete}
                  onBulkMove={handleBulkMove}
                  onExportAll={handleExportAll}
                  onImport={handleImport}
                  onExportBase64={handleExportBase64}
                  onImportBase64={handleImportBase64}
                  splitViewEnabled={splitViewEnabled}
                  onToggleSplitView={toggleSplitView}
                  onOpenVariables={() => setShowEnvVariables(true)}
                  onWorkflowsChanged={loadWorkflows}
                  sortBy={workflowSortBy}
                  onSortChange={setWorkflowSortBy}
                  centralServerStatus={centralServerStatus}
                  readOnly={isMobile}
                />
            );
            // a phone has no canvas to drag nodes onto: the list alone
            if (isMobile) return list;
            return (
            <VerticalResizableDivider
              defaultTopHeight={60}
              minTopHeight={30}
              maxTopHeight={80}
              storageKey="workflow-sidebar-vertical-split"
              bottomCollapsed={nodeLibraryCollapsed}
              topContent={list}
              bottomContent={
                <WorkflowNodeLibrary
                  width={width}
                  isCollapsed={nodeLibraryCollapsed}
                  onCollapsedChange={setNodeLibraryCollapsed}
                />
              }
            />
            );
          }}
        </ResizableSidebar>
      )}

      {/* Main Canvas */}
      <div id="workflow-container" className="flex-1 flex overflow-hidden relative">
        {/* Backdrop during split resize */}
        {isDraggingSplit && (
          <div
            className="fixed inset-0"
            style={{
              zIndex: 2147483646,
              cursor: 'col-resize'
            }}
          />
        )}

        {/* Left Pane - Workflow Editor */}
        <div
          className="flex flex-col h-full overflow-hidden min-w-0"
          style={{ width: splitViewEnabled ? `${splitPosition}%` : '100%' }}
        >
        {/* (min-h-0 on a phone: a flex item's min-height is auto, so the
            reader below could grow past the screen instead of scrolling) */}
        <div className={`flex-1 flex flex-col ${isMobile ? 'min-h-0' : ''}`}>
        {/* Tabs */}
        <TabBar
          tabs={openTabs}
          activeTabId={currentWorkflow?.id}
          onTabClick={handleTabClick}
          onTabClose={handleTabClose}
          onTabReorder={handleTabReorder}
          onTabContextMenu={handleTabContextMenu}
          paneId="workflow"
          pageTitle="Workflows"
        />

        {/* React Flow Canvas */}
        {openTabs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState icon={Workflow} title="No Workflow Selected" description={isMobile ? 'Open a workflow from the list - workflows are made and edited on the desktop' : 'Create a new workflow or select one from the list'} action={isMobile ? null : <Button variant="primary" size="lg" onClick={handleNewWorkflow}>New Workflow</Button>} />
          </div>
        ) : currentWorkflow && isMobile ? (
          <div className="flex-1 min-h-0 flex flex-col bg-os-card" data-testid="mobile-workflow-page">
            <MobileWorkflowToolbar isExecuting={isExecuting} onRun={executeWorkflow} onStop={stopWorkflow} onClear={clearOutputs} />
            <MobileWorkflowView nodes={nodes} edges={edges} />
          </div>
        ) : currentWorkflow ? (
          <div className="flex-1 flex flex-col bg-os-card">
            {/* Execution Toolbar */}
            <ExecutionToolbar
              isExecuting={isExecuting}
              onRun={executeWorkflow}
              onStop={stopWorkflow}
              onClear={clearOutputs}
              canUndo={isOwner && history.canUndo}
              canRedo={isOwner && history.canRedo}
              onUndo={history.undo}
              onRedo={history.redo}
              canEdit={isOwner}
              snapToGrid={snapToGrid}
              onToggleSnap={() => setSnapToGrid(!snapToGrid)}
              selectedCount={selectedCount}
              onAlign={alignSelected}
              onDistribute={distributeSelected}
              onTidy={tidyCanvas}
            />

            {/* Read-only banner for a workflow shared by someone else, without write access */}
            {currentWorkflow?.inCloud && !isOwner && (
              <div className="px-4 py-2 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-200 text-sm flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                <span className="font-medium">Read-only:</span>
                <span>This workflow is shared by another team member. You can view but not edit.</span>
              </div>
            )}

            {/* Canvas (grab cursor while Space is held: see useWorkflowCanvas) */}
            <div className={`flex-1 ${spaceHeld ? 'workflow-space-pan' : ''}`} onDoubleClick={isOwner ? onCanvasDoubleClick : undefined}>
              <ReactFlow
              key={currentWorkflow.cloudLastUpdated ? `${currentWorkflow.id}-${currentWorkflow.cloudLastUpdated}` : currentWorkflow.id}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={isOwner ? onTrackedNodesChange : undefined}
              onEdgesChange={isOwner ? onTrackedEdgesChange : undefined}
              onNodeDragStart={isOwner ? onNodeDragStart : undefined}
              onNodeDragStop={isOwner ? onNodeDragStop : undefined}
              onSelectionDragStart={isOwner ? onNodeDragStart : undefined}
              onSelectionDragStop={isOwner ? onNodeDragStop : undefined}
              onConnect={isOwner ? onConnect : undefined}
              isValidConnection={isValidConnection}
              snapToGrid={snapToGrid}
              snapGrid={[12, 12]}
              onConnectStart={isOwner ? onConnectStart : undefined}
              onConnectEnd={isOwner ? onConnectEnd : undefined}
              onInit={setReactFlowInstance}
              onDrop={isOwner ? onDrop : undefined}
              onDragOver={isOwner ? onDragOver : undefined}
              onEdgeClick={isOwner ? onEdgeClick : undefined}
              onEdgeUpdate={isOwner ? onEdgeUpdate : undefined}
              onNodeContextMenu={isOwner ? onNodeContextMenu : undefined}
              onPaneContextMenu={isOwner ? onPaneContextMenu : undefined}
              onPaneMouseMove={onPaneMouseMove}
              nodesDraggable={isOwner}
              nodesConnectable={isOwner}
              nodesFocusable={isOwner}
              edgesFocusable={isOwner}
              edgesUpdatable={isOwner}
              edgeUpdaterRadius={20}
              connectionRadius={20}
              connectionLineStyle={{ stroke: '#9333ea', strokeWidth: 2 }}
              // Moving around (Figma / Blueprints style): a left-drag on empty
              // canvas draws a selection box, Space+left-drag or middle/right-drag
              // pans, the trackpad / wheel scrolls the canvas, pinch or
              // Ctrl/Cmd+wheel zooms, F fits everything into view.
              // Partial: a node is selected as soon as the box touches any part
              // of it (Figma/Miro style) rather than only when fully enclosed.
              selectionOnDrag={true}
              selectionMode={SelectionMode.Partial}
              onSelectionStart={onSelectionStart}
              onSelectionEnd={onSelectionEnd}
              panOnDrag={[1, 2]}
              panActivationKeyCode="Space"
              panOnScroll
              zoomOnScroll={false}
              zoomOnPinch
              selectionKeyCode="Shift"
              multiSelectionKeyCode="Control"
              deleteKeyCode={['Backspace', 'Delete']}
              zoomOnDoubleClick={false}
              minZoom={0.2}
              maxZoom={2}
              fitView
              fitViewOptions={FIT_VIEW_OPTIONS}
              // Stacking is governed solely by each node's own zIndex (default
              // order, or the right-click layer menu). React Flow's default
              // would lift a selected node (+1000) and its edges above
              // everything, which made "Send to Back" look like it did nothing
              // until the node was deselected.
              elevateNodesOnSelect={false}
              elevateEdgesOnSelect={false}
              defaultEdgeOptions={{ type: 'data' }}
              // React Flow is MIT-licensed; the credit lives in the README's
              // licences line rather than as an unthemed panel on the canvas
              proOptions={{ hideAttribution: true }}
            >
              <Controls />
              {/* Raised above the app's status corner (StatusCorner, fixed
                  bottom-right), which would otherwise cover its corner */}
              <MiniMap
                position="bottom-right"
                style={{ marginBottom: 56 }}
                nodeColor={miniMapNodeColor}
                nodeClassName={(node) => `minimap-node-${node.type}`}
                maskColor="rgba(0, 0, 0, 0.2)"
                pannable
                zoomable
              />
              <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
            </ReactFlow>
            </div>
          </div>
        ) : null}
        </div>
        </div>

      {/* Split View Resizer */}
      {splitViewEnabled && (
        <div
          className="shrink-0 border-r border-os-border cursor-col-resize hover:border-blue-400 transition-colors"
          onMouseDown={handleSplitDragStart}
          style={{
            zIndex: 10
          }}
        />
      )}

      {/* Right Pane - Second Workflow Canvas (Split View) */}
      {splitViewEnabled && (
        <div
          className="flex flex-col h-full overflow-hidden min-w-0"
          style={{ width: `${100 - splitPosition}%` }}
        >
          <div className="flex-1 bg-os-card-secondary flex items-center justify-center">
            <div className="text-center text-os-text-muted">
              <Workflow size={64} className="mx-auto mb-4 opacity-50" />
              <p className="text-sm">Split view placeholder</p>
              <p className="text-xs mt-2">Future: Open second workflow here</p>
            </div>
          </div>
        </div>
      )}
      </div>

      {/* Connection Menu (a wire dropped on empty canvas) */}
      {connectionMenuPosition && connectionType && (
        <ConnectionMenu
          position={connectionMenuPosition}
          onSelectNode={handleConnectionMenuSelect}
          onClose={closeConnectionMenu}
          connectionType={connectionType}
        />
      )}

      {/* Quick-add palette (right-click / double-click / Tab on empty canvas) */}
      {quickAdd && (
        <NodeSearchMenu
          position={quickAdd}
          categories={NODE_CATEGORIES}
          onSelect={handleQuickAddSelect}
          onClose={closeQuickAdd}
          placeholder="Add a node..."
        />
      )}

      {/* Node Context Menu (layer order) */}
      {nodeContextMenu && (
        <NodeContextMenu
          position={nodeContextMenu}
          onAction={handleNodeContextAction}
          onClose={closeNodeContextMenu}
          hasExecPins={nodePinEdges(edges, nodeContextMenu.nodeId, 'execution').length > 0}
          hasDataPins={nodePinEdges(edges, nodeContextMenu.nodeId, 'data').length > 0}
        />
      )}

      {/* Environment Variables Modal */}
      {showEnvVariables && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-os-card rounded-lg shadow-xl w-full max-w-4xl mx-4 h-[80vh] overflow-hidden">
            <EnvironmentVariables onClose={() => setShowEnvVariables(false)} />
          </div>
        </div>
      )}

      {/* Base64 Export/Import Modal */}
      {showBase64Modal && (
        <Base64TransferModal
          mode={base64Mode}
          data={base64Data}
          onDataChange={setBase64Data}
          onClose={closeBase64Modal}
          onImport={confirmBase64Import}
        />
      )}

      {/* Export ... (JSON): the file's text to see and copy, or download */}
      {jsonExport && (
        <TransferTextModal
          mode="export"
          format="json"
          data={jsonExport.text}
          filename={jsonExport.filename}
          onDownload={downloadJsonExport}
          onClose={closeJsonExport}
        />
      )}

      {/* Import from JSON (the list menu) */}
      <ImportJsonModal
        isOpen={showImportModal}
        onClose={closeImportModal}
        title="Import Workflows"
        description="Upload a JSON file or paste JSON data: an array of workflows, as the JSON exports write it. Dry Run checks the data and shows what would be imported without writing anything."
        importLabel="Import Workflows"
        validateFn={validateWorkflowsImport}
        onDryRun={(items, { mergeMode }) => runWorkflowsImport(items, { dryRun: true, mergeMode })}
        renderStats={(result) => <JsonImportStats result={result} noun="workflow" importLabel="Import Workflows" />}
        onValidated={(items, { mergeMode }) => { confirmJsonImport(items, { mergeMode }); }}
        mergeLabel={jsonMergeLabel('workflows')}
        mergeHint={(checked) => jsonMergeHint(checked, { noun: 'workflow', plural: 'workflows', keyLabel: 'title and category' })}
        exampleData={[
          { title: 'Example Workflow', category: 'General', nodes: [{ id: 'n1', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } }], edges: [] },
        ]}
      />

      {/* Delete Workflow Confirmation Modal */}
      <ConfirmationModal
        isOpen={!!workflowToDelete}
        onClose={cancelDelete}
        onConfirm={confirmDelete}
        title="Delete Workflow"
        message={`Are you sure you want to delete "${workflowToDelete?.title}"?\n\nThis action cannot be undone.`}
        confirmText="Delete"
        dangerous={true}
      />

      {/* Bulk Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={showBulkDeleteModal}
        onClose={closeBulkDelete}
        onConfirm={confirmBulkDelete}
        title="Delete Workflows"
        message={`Are you sure you want to delete ${selectedWorkflows.length} workflow${selectedWorkflows.length !== 1 ? 's' : ''}?\n\nThis action cannot be undone.`}
        confirmText="Delete"
        dangerous={true}
      />

      {/* Bulk Move Category Modal */}
      {showBulkMoveModal && (
        <BulkMoveCategoryModal
          categories={Array.from(new Set(workflows.map(w => w.category || 'General')))}
          onClose={closeBulkMove}
          onConfirm={confirmBulkMove}
        />
      )}

      {/* Tab Context Menu */}
      {tabContextMenu && (
        <WorkflowTabContextMenu
          position={tabContextMenu}
          onAddAIContext={handleAddWorkflowAsAIContext}
          onCloseTabsToLeft={() => closeTabsVia(handleCloseTabsToLeft)}
          onCloseTabsToRight={() => closeTabsVia(handleCloseTabsToRight)}
          onCloseOtherTabs={() => closeTabsVia(handleCloseOtherTabs)}
          onCloseAllTabs={() => closeTabsVia(handleCloseAllTabs)}
          onClose={closeTabContextMenu}
        />
      )}

      {/* Interactive SSH Terminal (opened by an SSH node mid-execution) */}
      {interactiveSSH && (
        <FloatingSSHTerminal
          sshConfig={interactiveSSH.config}
          onComplete={completeInteractiveSSH}
          onCancel={cancelInteractiveSSH}
        />
      )}
    </div>
  );
}
