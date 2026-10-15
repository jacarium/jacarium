import { useState, useCallback, useRef, useEffect } from 'react';
import { addEdge } from 'reactflow';
import { NO_EXEC_INPUT_NODE_TYPES, NODE_CATEGORIES } from '../components/workflow/workflowNodeCategories';
import { alignNodes, distributeNodes, tidyLayout } from '../components/workflow/workflowLayout';
import { describeConnectionProblem } from '../components/workflow/workflowConnections';
import { useNotifications } from '../contexts/NotificationContext';
import {
  withNodeChangeHandler,
  reorderNode,
  sortNodesByStacking,
  clearNodePins,
  isEditableTarget
} from '../components/workflow/workflowNodeUtils';

/** How "fit view" frames the workflow (initial load and the F shortcut). */
export const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1 };

/** Control-flow nodes: every output pin they offer is an execution pin. */
const CONTROL_FLOW_NODE_TYPES = ['branch', 'switch', 'sequence', 'forloop'];

/** Edge type for a pair of handles: execution when either side is an exec pin. */
function edgeTypeFor({ sourceHandle, targetHandle }) {
  const isExecution =
    (sourceHandle && sourceHandle.includes('exec')) ||
    (targetHandle && targetHandle.includes('exec'));
  return isExecution ? 'execution' : 'data';
}

/**
 * Whether a wire dragged off `connectionInfo`'s handle carries execution:
 * either the handle id says so ('exec-in' / 'exec-out') or it is an output
 * of a control-flow node, whose named pins (true/false, case-N, loop-body,
 * ...) are all execution pins.
 */
function isExecutionConnection(connectionInfo, nodes) {
  const { nodeId, handleId, handleType } = connectionInfo;
  const sourceNode = nodes.find(n => n.id === nodeId);
  const isControlFlowNode = sourceNode && CONTROL_FLOW_NODE_TYPES.includes(sourceNode.type);
  return !!(handleId && handleId.includes('exec')) || (isControlFlowNode && handleType === 'source');
}

/**
 * Everything the user does on the React Flow canvas that is not plain
 * React Flow bookkeeping: typed edges on connect / reconnect, the "drop a
 * wire on empty space" node menu, palette drops, the marquee text-selection
 * guard, the node right-click menu (layer order, pin clearing), Ctrl+click
 * edge deletion and the node clipboard.
 *
 * Every change is announced to the history `recorder` (useWorkflowHistory)
 * before it is applied: explicitly here for connects, drops, pastes and
 * menu actions, and through the wrapped onNodesChange / onEdgesChange for
 * what React Flow does on its own (deleting, moving with the keyboard,
 * resizing). A mouse drag is one step, recorded when it starts.
 *
 * The builder keeps the ReactFlow element itself and the keyboard listener.
 */
export default function useWorkflowCanvas({ nodes, edges, setNodes, setEdges, onNodesChange, onEdgesChange, nodeIdCounterRef, recorder }) {
  const { addNotification } = useNotifications();
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const draggingRef = useRef(false);

  // Wiring rules (workflowConnections.js): React Flow asks while a wire is
  // dragged so the hovered pin can show valid / invalid; a drop on a pin
  // that will not take the wire is explained in a notification
  const nodesById = {};
  for (const node of nodes) nodesById[node.id] = node;
  const isValidConnection = useCallback((connection) => describeConnectionProblem(connection, nodesById) === null,
    // nodesById is rebuilt per render from nodes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes]);

  // Space held (outside text fields) turns a left-drag on the pane into a pan
  // (React Flow's panActivationKeyCode); this mirrors the key so the pane can
  // show a grab cursor meanwhile.
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    function onKeyDown(event) {
      if (event.code === 'Space' && !event.repeat && !isEditableTarget(event.target)) setSpaceHeld(true);
    }
    function onKeyUp(event) {
      if (event.code === 'Space') setSpaceHeld(false);
    }
    function onBlur() {
      setSpaceHeld(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  /** Frame the whole workflow (the F / Shift+1 shortcut). */
  const fitCanvas = useCallback(() => {
    reactFlowInstance?.fitView(FIT_VIEW_OPTIONS);
  }, [reactFlowInstance]);

  // Layout tools (workflowLayout.js): each is one undo step
  const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);

  const alignSelected = useCallback((mode) => {
    recorder.record();
    setNodes((nds) => alignNodes(nds, nds.filter((n) => n.selected).map((n) => n.id), mode));
  }, [setNodes, recorder]);

  const distributeSelected = useCallback((axis) => {
    recorder.record();
    setNodes((nds) => distributeNodes(nds, nds.filter((n) => n.selected).map((n) => n.id), axis));
  }, [setNodes, recorder]);

  /** Auto-tidy the whole workflow along its execution flow, then frame it. */
  const tidyCanvas = useCallback(() => {
    recorder.record();
    setNodes((nds) => tidyLayout(nds, edges));
    // Frame the result once React Flow has applied the new positions
    setTimeout(() => reactFlowInstance?.fitView(FIT_VIEW_OPTIONS), 50);
  }, [setNodes, edges, recorder, reactFlowInstance]);


  // Node drags: one history entry per drag, taken when it starts. The
  // position changes React Flow streams meanwhile carry dragging: true and
  // the final one carries no position at all, so onTrackedNodesChange
  // ignores them; keyboard nudges (position without dragging) are batched.
  const onNodeDragStart = useCallback(() => {
    draggingRef.current = true;
    recorder.record();
  }, [recorder]);

  const onNodeDragStop = useCallback(() => {
    draggingRef.current = false;
  }, []);

  const onTrackedNodesChange = useCallback((changes) => {
    for (const change of changes) {
      if (change.type === 'remove') {
        recorder.record('delete');
        break;
      }
      if (change.type === 'position' && change.position && !change.dragging && !draggingRef.current) {
        recorder.record('nudge');
        break;
      }
      if (change.type === 'dimensions' && change.resizing) {
        recorder.record('nudge');
        break;
      }
    }
    onNodesChange(changes);
  }, [onNodesChange, recorder]);

  const onTrackedEdgesChange = useCallback((changes) => {
    if (changes.some((change) => change.type === 'remove')) {
      recorder.record('delete');
    }
    onEdgesChange(changes);
  }, [onEdgesChange, recorder]);

  // Where the wire was dropped, and which handle it came from
  const [connectionMenuPosition, setConnectionMenuPosition] = useState(null);
  const [connectionInfo, setConnectionInfo] = useState(null); // { nodeId, handleId, handleType }
  const [nodeContextMenu, setNodeContextMenu] = useState(null); // { x, y, nodeId }
  const clipboardRef = useRef({ nodes: [], edges: [] });

  /** A fresh node of `type` at `position`, wired for in-place editing. */
  const createNode = useCallback((type, position) => withNodeChangeHandler({
    id: `node-${++nodeIdCounterRef.current}`,
    type,
    position,
    data: {}
  }, setNodes, recorder), [setNodes, nodeIdCounterRef, recorder]);

  // Quick-add palette: a node search menu opened on empty canvas by a
  // right-click (React Flow reports it on mouseup when the right button did
  // not pan), a double-click, or the Tab key - the last one at the pointer's
  // last position over the pane, or the middle of the canvas. The node is
  // placed where the menu was opened.
  const [quickAdd, setQuickAdd] = useState(null); // { x, y } screen position
  const lastPanePointerRef = useRef(null);

  const onPaneMouseMove = useCallback((event) => {
    lastPanePointerRef.current = { x: event.clientX, y: event.clientY };
  }, []);

  const openQuickAdd = useCallback((position) => {
    setQuickAdd(position);
  }, []);

  const onPaneContextMenu = useCallback((event) => {
    event.preventDefault();
    setQuickAdd({ x: event.clientX, y: event.clientY });
  }, []);

  /** A double-click on the pane itself (not on a node) opens the palette there. */
  const onCanvasDoubleClick = useCallback((event) => {
    if (event.target?.classList?.contains('react-flow__pane')) {
      setQuickAdd({ x: event.clientX, y: event.clientY });
    }
  }, []);

  /** Tab: open the palette at the pointer, or at the canvas centre. */
  const openQuickAddAtPointer = useCallback(() => {
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) return;
    const rect = pane.getBoundingClientRect();
    const at = lastPanePointerRef.current;
    const inside = at && at.x >= rect.left && at.x <= rect.right && at.y >= rect.top && at.y <= rect.bottom;
    setQuickAdd(inside ? at : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, []);

  const closeQuickAdd = useCallback(() => setQuickAdd(null), []);

  const handleQuickAddSelect = useCallback((nodeType) => {
    if (!quickAdd || !reactFlowInstance) {
      setQuickAdd(null);
      return;
    }
    recorder.record();
    const newNode = createNode(nodeType, reactFlowInstance.screenToFlowPosition(quickAdd));
    setNodes((nds) => sortNodesByStacking(nds.concat(newNode)));
    setQuickAdd(null);
  }, [quickAdd, reactFlowInstance, createNode, setNodes, recorder]);

  const onConnect = useCallback(
    (params) => {
      // Validate nodes exist
      const sourceNode = nodes.find(n => n.id === params.source);
      const targetNode = nodes.find(n => n.id === params.target);

      if (!sourceNode || !targetNode) {
        console.warn('Source or target node not found');
        return;
      }

      const edgeType = edgeTypeFor(params);

      // Validate that target node supports the connection type
      if (edgeType === 'execution' && params.targetHandle === 'exec-in') {
        if (NO_EXEC_INPUT_NODE_TYPES.includes(targetNode.type)) {
          console.warn(`Cannot connect execution edge to ${targetNode.type} node (no execution input)`);
          return;
        }
      }

      recorder.record();
      setEdges((eds) => addEdge({ ...params, type: edgeType }, eds));
    },
    [setEdges, nodes, recorder]
  );

  const onConnectStart = useCallback((event, { nodeId, handleId, handleType }) => {
    // Track the connection attempt
    setConnectionInfo({
      nodeId,
      handleId,
      handleType, // 'source' or 'target'
    });
  }, []);

  const onConnectEnd = useCallback((event) => {
    if (!connectionInfo || !reactFlowInstance) {
      setConnectionInfo(null);
      return;
    }

    const targetIsPane = !!event.target?.classList?.contains('react-flow__pane');

    if (targetIsPane && connectionInfo) {
      // Dragged to empty space - show connection menu
      setConnectionMenuPosition({ x: event.clientX, y: event.clientY });
      return;
    }

    // Dropped on a pin that refuses the wire: say why instead of doing nothing
    const pin = event.target?.closest?.('.react-flow__handle');
    if (pin) {
      const other = { nodeId: pin.getAttribute('data-nodeid'), handleId: pin.getAttribute('data-handleid') };
      const connection = connectionInfo.handleType === 'source'
        ? { source: connectionInfo.nodeId, sourceHandle: connectionInfo.handleId, target: other.nodeId, targetHandle: other.handleId }
        : { source: other.nodeId, sourceHandle: other.handleId, target: connectionInfo.nodeId, targetHandle: connectionInfo.handleId };
      const problem = describeConnectionProblem(connection, nodesById, NODE_CATEGORIES);
      if (problem) {
        addNotification({ type: 'alert', title: 'Cannot connect', message: problem });
      }
      setConnectionInfo(null);
    }
    // Otherwise keep connectionInfo - the connection menu needs it for the new node
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionInfo, reactFlowInstance, nodes, addNotification]);

  const closeConnectionMenu = useCallback(() => {
    setConnectionMenuPosition(null);
    setConnectionInfo(null);
  }, []);

  /** Add a node of `nodeType` where the wire was dropped and wire it up. */
  const handleConnectionMenuSelect = useCallback((nodeType) => {
    if (!connectionInfo || !reactFlowInstance || !connectionMenuPosition) {
      closeConnectionMenu();
      return;
    }

    const isExecution = isExecutionConnection(connectionInfo, nodes);

    // Validate that the target node type supports execution input
    if (isExecution && NO_EXEC_INPUT_NODE_TYPES.includes(nodeType)) {
      console.warn(`Cannot connect execution edge to ${nodeType} node (no execution input)`);
      closeConnectionMenu();
      return;
    }

    recorder.record();
    const newNode = createNode(nodeType, reactFlowInstance.screenToFlowPosition({
      x: connectionMenuPosition.x,
      y: connectionMenuPosition.y,
    }));
    setNodes((nds) => sortNodesByStacking(nds.concat(newNode)));

    // Wire from the dragged handle to the new node's matching input, or - when
    // the drag started on a target handle - from the new node's output to it
    const { nodeId, handleId, handleType } = connectionInfo;
    const newEdge = handleType === 'target'
      ? {
        source: newNode.id,
        target: nodeId,
        sourceHandle: isExecution ? 'exec-out' : 'data-out',
        targetHandle: handleId
      }
      : {
        source: nodeId,
        target: newNode.id,
        sourceHandle: handleId,
        targetHandle: isExecution ? 'exec-in' : 'data-in'
      };

    setEdges((eds) => eds.concat({
      id: `edge-${Date.now()}`,
      ...newEdge,
      type: isExecution ? 'execution' : 'data'
    }));

    closeConnectionMenu();
  }, [connectionInfo, connectionMenuPosition, reactFlowInstance, nodes, setNodes, setEdges, createNode, closeConnectionMenu, recorder]);

  // Which flavour of the connection menu to show for the pending wire
  const connectionType = connectionInfo
    ? `${isExecutionConnection(connectionInfo, nodes) ? 'execution' : 'data'}-${connectionInfo.handleType}`
    : null;

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow');
      if (!type || !reactFlowInstance) return;

      recorder.record();
      const newNode = createNode(type, reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      }));
      setNodes((nds) => sortNodesByStacking(nds.concat(newNode)));
    },
    [reactFlowInstance, setNodes, createNode, recorder]
  );

  // Marquee (drag-select box): a mousedown+drag on the pane would also start a
  // native text selection and highlight any selectable text the box sweeps
  // across (node labels, Visualizer/Result JSON output). Disable text
  // selection on the body only while the box is being drawn and drop any
  // range it produced. Drags that start inside a field/<pre> never start on
  // the pane, so intentional text selection is unaffected.
  // Note: React Flow calls onSelectionEnd on every pane mouseup (a mouseup
  // inside a node bubbles up to the pane), so the guard only acts when a box
  // was actually started - otherwise it would wipe a selection the user just
  // made by dragging inside a <pre>.
  const marqueeActiveRef = useRef(false);
  const onSelectionEnd = useCallback(function endGuard() {
    if (!marqueeActiveRef.current) return;
    marqueeActiveRef.current = false;
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    document.removeEventListener('mouseup', endGuard, true);
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
    }
  }, []);

  const onSelectionStart = useCallback(() => {
    marqueeActiveRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    // Fallback in case the drag ends outside the pane
    document.addEventListener('mouseup', onSelectionEnd, true);
  }, [onSelectionEnd]);

  // Right-click on a node - open the layer-order menu at the cursor
  const onNodeContextMenu = useCallback((event, node) => {
    event.preventDefault();
    setNodeContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
  }, []);

  const closeNodeContextMenu = useCallback(() => setNodeContextMenu(null), []);

  // Layer order (persists via zIndex) or pin clearing (drops that node's
  // execution/data edges; the node and its other edge type stay)
  const handleNodeContextAction = useCallback((action) => {
    if (nodeContextMenu) {
      const { nodeId } = nodeContextMenu;
      recorder.record();
      if (action === 'clear-exec' || action === 'clear-data') {
        setEdges((eds) => clearNodePins(eds, nodeId, action === 'clear-exec' ? 'execution' : 'data'));
      } else {
        setNodes((nds) => sortNodesByStacking(reorderNode(nds, nodeId, action)));
      }
    }
    setNodeContextMenu(null);
  }, [nodeContextMenu, setNodes, setEdges, recorder]);

  // Handle edge click - Ctrl+Click to delete
  const onEdgeClick = useCallback((event, edge) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      recorder.record();
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    }
  }, [setEdges, recorder]);

  // Handle edge reconnection - drag from edge endpoint to reconnect
  const onEdgeUpdate = useCallback((oldEdge, newConnection) => {
    recorder.record();
    setEdges((eds) => addEdge(
      { ...newConnection, type: edgeTypeFor(newConnection) },
      eds.filter((e) => e.id !== oldEdge.id)
    ));
  }, [setEdges, recorder]);

  /** Ctrl/Cmd+C: remember the selected nodes and the edges between them. */
  function copySelectedNodes() {
    const selectedNodes = nodes.filter(n => n.selected);
    const selectedNodeIds = new Set(selectedNodes.map(n => n.id));
    const selectedEdges = edges.filter(e => selectedNodeIds.has(e.source) && selectedNodeIds.has(e.target));

    clipboardRef.current = {
      nodes: selectedNodes,
      edges: selectedEdges
    };
  }

  /** Ctrl/Cmd+V: add copies with fresh ids, offset so they do not overlap the originals. */
  function pasteNodes() {
    if (!clipboardRef.current.nodes.length) return;
    recorder.record();

    const offsetX = 50;
    const offsetY = 50;
    const idMapping = {};

    const newNodes = clipboardRef.current.nodes.map(node => {
      const newId = `node-${++nodeIdCounterRef.current}`;
      idMapping[node.id] = newId;

      return withNodeChangeHandler({
        ...node,
        id: newId,
        position: {
          x: node.position.x + offsetX,
          y: node.position.y + offsetY
        },
        selected: false
      }, setNodes, recorder);
    });

    const newEdges = clipboardRef.current.edges.map(edge => ({
      ...edge,
      id: `edge-${Date.now()}-${Math.random()}`,
      source: idMapping[edge.source],
      target: idMapping[edge.target]
    }));

    setNodes(nds => sortNodesByStacking([...nds, ...newNodes]));
    setEdges(eds => [...eds, ...newEdges]);
  }

  return {
    // React Flow wiring
    setReactFlowInstance,
    isValidConnection,
    fitCanvas,
    spaceHeld,
    // layout tools
    selectedCount: selectedIds.length,
    alignSelected,
    distributeSelected,
    tidyCanvas,
    onPaneMouseMove,
    onPaneContextMenu,
    onCanvasDoubleClick,
    // quick-add palette
    quickAdd,
    openQuickAdd,
    openQuickAddAtPointer,
    closeQuickAdd,
    handleQuickAddSelect,
    onNodesChange: onTrackedNodesChange,
    onEdgesChange: onTrackedEdgesChange,
    onNodeDragStart,
    onNodeDragStop,
    onConnect,
    onConnectStart,
    onConnectEnd,
    onDrop,
    onDragOver,
    onSelectionStart,
    onSelectionEnd,
    onNodeContextMenu,
    onEdgeClick,
    onEdgeUpdate,
    // "drop a wire on empty space" menu
    connectionMenuPosition,
    connectionType,
    handleConnectionMenuSelect,
    closeConnectionMenu,
    // node right-click menu
    nodeContextMenu,
    handleNodeContextAction,
    closeNodeContextMenu,
    // clipboard
    copySelectedNodes,
    pasteNodes
  };
}
