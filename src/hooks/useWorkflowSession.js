import { useState, useEffect, useRef } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import { useLocalStorage } from './useLocalStorage';
import {
  cleanNodesForStorage,
  getMaxNodeId,
  attachNodeHandlers,
  sortNodesByStacking
} from '../components/workflow/workflowNodeUtils';
import { getWorkflows, createWorkflow, updateWorkflow, getWorkflow } from '../utils/workflows';
import { startCloudSync } from '../utils/cloudSync';
import { canEditSharedWorkflow } from '../utils/workflowSharing';
import { useNotifications } from '../contexts/NotificationContext';
import useWorkflowHistory from './useWorkflowHistory';

/** The entry a workflow gets in the tab bar. */
const tabFor = (workflow) => ({
  id: workflow.id,
  title: workflow.title,
  category: workflow.category,
  inCloud: workflow.inCloud
});

/** The two nodes (and the edge between them) every new workflow starts with. */
function newWorkflowContent() {
  const beginPlayNode = {
    id: 'node-1',
    type: 'beginplay',
    position: { x: 250, y: 250 },
    data: {}
  };
  const resultNode = {
    id: 'node-2',
    type: 'result',
    position: { x: 550, y: 250 },
    data: {}
  };
  const initialEdge = {
    id: 'edge-1',
    source: 'node-1',
    target: 'node-2',
    sourceHandle: 'exec-out',
    targetHandle: 'exec-in',
    type: 'execution'
  };
  return { nodes: [beginPlayNode, resultNode], edges: [initialEdge] };
}

/**
 * The editor session of the Workflow Builder: which workflows exist, which
 * one is on the canvas (React Flow node/edge state, title, category), the
 * open tabs, and everything that moves content between the canvas and
 * IndexedDB - restore on mount, debounced auto-save, save-before-switch,
 * and reconciliation when the team sharing delivers or deletes workflows.
 *
 * Undo/redo (useWorkflowHistory) belongs to the session too: its history is
 * per workflow and starts empty whenever the canvas is (re)loaded.
 *
 * `onBeforeSwitch` runs right before another workflow replaces the canvas
 * (used to abort a running execution). It is read through a ref so the
 * caller can hand in a closure over hooks declared after this one.
 */
export default function useWorkflowSession({ onBeforeSwitch } = {}) {
  const { addNotification } = useNotifications();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [workflowTitle, setWorkflowTitle] = useState('Untitled Workflow');
  const [workflowCategory, setWorkflowCategory] = useState('General');
  const [currentWorkflow, setCurrentWorkflow] = useState(null);
  const [currentWorkflowId, setCurrentWorkflowId] = useLocalStorage('currentWorkflowId', null);
  const [openTabs, setOpenTabs] = useLocalStorage('workflowOpenTabs', []);
  const [workflows, setWorkflows] = useState([]);
  const [isOwner, setIsOwner] = useState(true); // may edit (false: shared by a teammate, read-only)
  // Next `node-<n>` id; bumped past the loaded workflow's ids
  const nodeIdCounterRef = useRef(0);
  const history = useWorkflowHistory({ nodes, edges, setNodes, setEdges });

  // Refs for always getting current state in event handlers (fixes closure bug)
  const currentWorkflowRef = useRef(null);
  const openTabsRef = useRef([]);
  const lastSavedWorkflowRef = useRef({ title: '', category: '', nodes: [], edges: [] });
  const onBeforeSwitchRef = useRef(onBeforeSwitch);
  onBeforeSwitchRef.current = onBeforeSwitch;

  // Keep refs in sync with state
  useEffect(() => {
    currentWorkflowRef.current = currentWorkflow;
  }, [currentWorkflow]);

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  // A workflow shared by a teammate is editable only with write permission
  useEffect(() => {
    async function checkOwnership() {
      if (currentWorkflow && currentWorkflow.inCloud) {
        const owner = await canEditSharedWorkflow(currentWorkflow);
        setIsOwner(owner);
        console.log('[WorkflowBuilder] Workflow ownership check:', {
          workflowId: currentWorkflow.id,
          title: currentWorkflow.title,
          isOwner: owner,
          ownerId: currentWorkflow.ownerId
        });
      } else {
        setIsOwner(true); // Unshared workflows are always editable
      }
    }
    checkOwnership();
  }, [currentWorkflow]);

  // Load workflows on mount and connect to the team's central server
  useEffect(() => {
    loadWorkflows();

    // Connect to the central server (shared workflows arrive over its
    // socket) if not already connected; the standalone workflow window has
    // no main shell to do it. Not stopped on unmount: the connection
    // persists across page navigations.
    console.log('[WorkflowBuilder] Ensuring the central server connection is started');
    startCloudSync();
    // Intentional mount-only load + sync start
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore workflow from session
  useEffect(() => {
    async function restoreWorkflow() {
      if (currentWorkflowId && !currentWorkflow) {
        const allWorkflows = await getWorkflows();
        const workflow = allWorkflows.find(w => w.id === currentWorkflowId);
        if (workflow) {
          loadWorkflowIntoEditor(workflow);
        }
      }
    }
    restoreWorkflow();
    // setters/loaders are recreated per render; the listed state is the trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkflowId, currentWorkflow, workflows]);

  // Auto-save workflow when nodes or edges change
  useEffect(() => {
    if (!currentWorkflow) return;
    if (!isOwner) return; // Don't auto-save if not the owner

    const timeoutId = setTimeout(async () => {
      if (!(await persistEditorContent())) return;
      // Reload workflow list to show updated timestamp
      await loadWorkflows();
    }, 500); // Debounce by 500ms

    return () => clearTimeout(timeoutId);
    // Debounced auto-save keyed on the edited data; helper fns are stable in
    // behavior and intentionally excluded to avoid re-arming the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, workflowTitle, workflowCategory, currentWorkflow, isOwner]);

  // Listen for shared workflows arriving (or being withdrawn) from the team
  useEffect(() => {
    async function handleCloudWorkflowsReceived(event) {
      // Use refs to get current values (fixes closure bug with empty dependency array)
      const currentWf = currentWorkflowRef.current;
      const tabs = openTabsRef.current;

      console.log('[WorkflowBuilder] Shared workflows received:', event.detail);
      console.log('[WorkflowBuilder] Current state:', {
        currentWorkflowId: currentWf?.id,
        currentWorkflowTitle: currentWf?.title,
        openTabsCount: tabs.length,
        openTabIds: tabs.map(t => ({ id: t.id, title: t.title }))
      });

      // Show notification if workflows were received
      const { processed } = event.detail || {};
      if (processed > 0) {
        addNotification({
          type: 'success',
          title: 'Shared workflows',
          message: `Received ${processed} shared workflow${processed > 1 ? 's' : ''} from the team.`
        });
      }

      // Reload workflows to show newly synced workflows (skip tab management - we handle it below)
      const workflowsAfterReload = await loadWorkflows(true);

      // Tabs whose workflow no longer exists (deleted, or a teammate stopped sharing it)
      const deletedTabIds = tabs
        .filter(tab => !workflowsAfterReload.find(w => w.id === tab.id))
        .map(tab => tab.id);
      const remainingTabs = tabs.filter(t => !deletedTabIds.includes(t.id));

      if (deletedTabIds.length > 0) {
        console.log('[WorkflowBuilder] Workflows deleted by central server removal:', deletedTabIds);
        setOpenTabs(remainingTabs);
      }

      // Clear/switch editor if current workflow was deleted (even if not in a tab)
      const currentWorkflowDeleted = currentWf && !workflowsAfterReload.find(w => w.id === currentWf.id);

      if (currentWorkflowDeleted) {
        console.log('[WorkflowBuilder] Current workflow was deleted, switching tabs');

        if (remainingTabs.length > 0) {
          // Switch to the last remaining tab
          const nextTab = remainingTabs[remainingTabs.length - 1];
          const nextWorkflow = await getWorkflow(nextTab.id);
          if (nextWorkflow) {
            loadWorkflowIntoEditor(nextWorkflow);
          }
        } else {
          // Current workflow deleted and no tabs left, clear everything
          console.log('[WorkflowBuilder] Current workflow deleted and no remaining tabs - clearing editor');
          clearEditor('');
        }
      }

      // Update tab metadata for all tabs that still exist
      let currentWorkflowUpdated = false;
      for (const tab of remainingTabs) {
        const updatedWorkflow = await getWorkflow(tab.id);
        if (updatedWorkflow) {
          console.log(`[WorkflowBuilder] Tab ${tab.id} (${tab.title}) - found update, inCloud:`, updatedWorkflow.inCloud);

          // Always update tab metadata (for the shared badge, styling, etc.)
          setOpenTabs(prev => prev.map(t =>
            t.id === updatedWorkflow.id
              ? { ...t, title: updatedWorkflow.title, category: updatedWorkflow.category, inCloud: updatedWorkflow.inCloud, ownerId: updatedWorkflow.ownerId }
              : t
          ));

          // Only update workflow state if this workflow is currently visible
          if (currentWf?.id === updatedWorkflow.id) {
            console.log('[WorkflowBuilder] Workflow is currently active - updating full content:', updatedWorkflow.title);
            loadWorkflowIntoEditor(updatedWorkflow);
            currentWorkflowUpdated = true;
          }
        }
      }

      // If current workflow exists but wasn't updated (e.g., not in tabs), update it separately
      if (currentWf && !currentWorkflowUpdated) {
        const updatedCurrentWorkflow = await getWorkflow(currentWf.id);
        if (updatedCurrentWorkflow) {
          console.log('[WorkflowBuilder] Updating current workflow full content (not in tabs):', updatedCurrentWorkflow.title);
          loadWorkflowIntoEditor(updatedCurrentWorkflow);
        }
      }
    }

    window.addEventListener('cloudWorkflowsReceived', handleCloudWorkflowsReceived);
    return () => window.removeEventListener('cloudWorkflowsReceived', handleCloudWorkflowsReceived);
    // Mount-only subscription; the handler reads current values via refs
    // (see comment above about the closure fix)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadWorkflows(skipTabManagement = false) {
    const allWorkflows = await getWorkflows();
    setWorkflows(allWorkflows);

    // Skip tab management if it's being handled elsewhere (e.g., in the shared-workflows handler)
    if (skipTabManagement) {
      return allWorkflows;
    }

    // Close tabs for workflows that no longer exist (deleted, or a teammate stopped sharing them) and
    // sync the tab data with the workflows (inCloud status, title). Through the updater form, never from
    // openTabsRef: the ref is written by an effect after a render, so right after openInTab() queued a tab
    // (handleNewWorkflow, the duplicate action) it may still hold the previous list - and this used to
    // replace the tabs with that stale list, closing the tab that was just opened. Whether that happened
    // depended on how fast getWorkflows() came back: with Dexie 4.4 the read is fast enough that it did,
    // every time. The updater sees the queued state, so the race is gone whatever the timing.
    const workflowIds = new Set(allWorkflows.map(w => w.id));
    setOpenTabs(tabs => tabs
      .filter(tab => workflowIds.has(tab.id))
      .map(tab => {
        const workflow = allWorkflows.find(w => w.id === tab.id);
        return workflow ? { ...tab, ...tabFor(workflow) } : tab;
      }));
    return allWorkflows;
  }

  /**
   * Make `workflow` the active editor content: strips stale execution state,
   * bumps the node id counter past any existing ids and records the loaded
   * content as the last-saved baseline so auto-save doesn't re-write it.
   */
  function loadWorkflowIntoEditor(workflow) {
    // Stacking order in the array keeps the MiniMap consistent with the canvas
    const cleanedNodes = sortNodesByStacking(cleanNodesForStorage(workflow.nodes || []));
    const workflowEdges = workflow.edges || [];

    nodeIdCounterRef.current = getMaxNodeId(cleanedNodes);

    setCurrentWorkflow(workflow);
    setCurrentWorkflowId(workflow.id);
    setWorkflowTitle(workflow.title);
    setWorkflowCategory(workflow.category);
    setNodes(attachNodeHandlers(cleanedNodes, setNodes, history.recorder));
    setEdges(workflowEdges);
    history.clear();

    lastSavedWorkflowRef.current = {
      title: workflow.title,
      category: workflow.category,
      nodes: cleanedNodes,
      edges: workflowEdges
    };
  }

  // Empty the editor (no active workflow)
  function clearEditor(title = 'Untitled Workflow') {
    setCurrentWorkflow(null);
    setCurrentWorkflowId(null);
    setWorkflowTitle(title);
    setWorkflowCategory('General');
    setNodes([]);
    setEdges([]);
    history.clear();
    lastSavedWorkflowRef.current = { title: '', category: '', nodes: [], edges: [] };
  }

  /**
   * Write the canvas (title, category, nodes, edges) to the current
   * workflow's record when it differs from the last saved state. Reads the
   * record first so the sharing metadata written by the sync is preserved.
   * Resolves true when something was written.
   */
  async function persistEditorContent() {
    // Clean nodes - remove functions and execution state
    const cleanNodes = cleanNodesForStorage(nodes);

    const last = lastSavedWorkflowRef.current;
    const hasChanges =
      workflowTitle !== last.title ||
      workflowCategory !== last.category ||
      JSON.stringify(cleanNodes) !== JSON.stringify(last.nodes) ||
      JSON.stringify(edges) !== JSON.stringify(last.edges);

    if (!hasChanges) {
      return false;
    }

    const latestWorkflow = await getWorkflow(currentWorkflow.id);
    if (!latestWorkflow) return false;

    const updatedWorkflow = {
      ...latestWorkflow, // Use latest from DB to preserve the sharing metadata
      title: workflowTitle,
      category: workflowCategory,
      nodes: cleanNodes,
      edges
    };

    await updateWorkflow(currentWorkflow.id, updatedWorkflow);
    setCurrentWorkflow(updatedWorkflow);

    lastSavedWorkflowRef.current = {
      title: workflowTitle,
      category: workflowCategory,
      nodes: cleanNodes,
      edges
    };
    return true;
  }

  // Save current workflow (only if there are changes)
  async function saveCurrentWorkflow() {
    if (!currentWorkflow) return;
    if (!(await persistEditorContent())) return;

    // Update tab
    setOpenTabs(tabs => tabs.map(t =>
      t.id === currentWorkflow.id ? { ...t, title: workflowTitle, category: workflowCategory, inCloud: currentWorkflow.inCloud } : t
    ));

    // Reload workflows list
    await loadWorkflows();
  }

  /** Add `workflow` to the tab bar (if not there yet) and show it. */
  function openInTab(workflow) {
    if (!openTabs.some(t => t.id === workflow.id)) {
      setOpenTabs(tabs => [...tabs, tabFor(workflow)]);
    }
    loadWorkflowIntoEditor(workflow);
  }

  // Create new workflow
  async function handleNewWorkflow() {
    const newWorkflowId = await createWorkflow({
      title: 'Untitled Workflow',
      category: 'General',
      ...newWorkflowContent()
    });

    const allWorkflows = await getWorkflows();
    const workflow = allWorkflows.find(w => w.id === newWorkflowId);

    if (workflow) {
      openInTab(workflow);
    }

    await loadWorkflows();
  }

  // Open workflow from list
  async function handleWorkflowClick(workflow) {
    // If clicking on the already-active workflow, do nothing
    // This prevents overwriting current work when clicking on the active workflow
    if (currentWorkflow?.id === workflow.id) {
      return;
    }

    // Save current workflow before switching (only saves if there are changes)
    if (currentWorkflow) {
      await saveCurrentWorkflow();
    }

    onBeforeSwitchRef.current?.();

    // Always reload from database to get latest saved version (list data might be stale)
    const freshWorkflow = await getWorkflow(workflow.id);
    if (!freshWorkflow) return;

    openInTab(freshWorkflow);
  }

  // Handle tab click
  async function handleTabClick(tab) {
    // Save current workflow before switching (only saves if there are changes)
    if (currentWorkflow && currentWorkflow.id !== tab.id) {
      await saveCurrentWorkflow();
    }

    onBeforeSwitchRef.current?.();

    const allWorkflows = await getWorkflows();
    const workflow = allWorkflows.find(w => w.id === tab.id);
    if (workflow) {
      loadWorkflowIntoEditor(workflow);
    }
  }

  // Handle tab close
  async function handleTabClose(tabId) {
    // Save current workflow before closing if it's the one being closed
    if (currentWorkflow?.id === tabId) {
      await saveCurrentWorkflow();
    }

    const newTabs = openTabs.filter(t => t.id !== tabId);
    setOpenTabs(newTabs);

    // If closing current workflow, switch to another or clear
    if (currentWorkflow?.id === tabId) {
      if (newTabs.length > 0) {
        await handleTabClick(newTabs[newTabs.length - 1]);
      } else {
        clearEditor();
      }
    }
  }

  // Handle tab reorder
  function handleTabReorder(fromIndex, toIndex) {
    const newTabs = [...openTabs];
    const [removed] = newTabs.splice(fromIndex, 1);
    newTabs.splice(toIndex, 0, removed);
    setOpenTabs(newTabs);
  }

  // Close tabs to left
  async function handleCloseTabsToLeft(tabId) {
    // Save current workflow before closing tabs
    if (currentWorkflow) {
      await saveCurrentWorkflow();
    }

    const tabIndex = openTabs.findIndex(t => t.id === tabId);
    if (tabIndex > 0) {
      setOpenTabs(openTabs.slice(tabIndex));
    }
  }

  // Close tabs to right
  async function handleCloseTabsToRight(tabId) {
    // Save current workflow before closing tabs
    if (currentWorkflow) {
      await saveCurrentWorkflow();
    }

    const tabIndex = openTabs.findIndex(t => t.id === tabId);
    if (tabIndex < openTabs.length - 1) {
      setOpenTabs(openTabs.slice(0, tabIndex + 1));
    }
  }

  // Close other tabs
  async function handleCloseOtherTabs(tabId) {
    // Save current workflow before closing tabs
    if (currentWorkflow) {
      await saveCurrentWorkflow();
    }

    const tab = openTabs.find(t => t.id === tabId);
    if (tab) {
      setOpenTabs([tab]);
    }
  }

  // Close all tabs
  async function handleCloseAllTabs() {
    // Save current workflow before closing all tabs
    if (currentWorkflow) {
      await saveCurrentWorkflow();
    }

    setOpenTabs([]);
    clearEditor();
  }

  return {
    // canvas state
    nodes, setNodes, onNodesChange,
    edges, setEdges, onEdgesChange,
    nodeIdCounterRef,
    history,
    // the open workflow
    currentWorkflow, setCurrentWorkflow,
    workflowTitle, setWorkflowTitle,
    workflowCategory, setWorkflowCategory,
    isOwner,
    // the library and the tab bar
    workflows,
    openTabs, setOpenTabs,
    // persistence
    loadWorkflows,
    loadWorkflowIntoEditor,
    clearEditor,
    saveCurrentWorkflow,
    openInTab,
    // user actions
    handleNewWorkflow,
    handleWorkflowClick,
    handleTabClick,
    handleTabClose,
    handleTabReorder,
    handleCloseTabsToLeft,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
    handleCloseAllTabs
  };
}
