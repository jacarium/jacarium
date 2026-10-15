import { useState } from 'react';
import { cleanNodesForStorage } from '../components/workflow/workflowNodeUtils';
import { getWorkflows, createWorkflow, updateWorkflow, deleteWorkflow, getWorkflow } from '../utils/workflows';
import { downloadBlob } from '../utils/exportHelpers';
import { serializeWorkflows, parseWorkflowsExport, workflowExportFileName } from '../utils/workflowTransfer';
import { useNotifications } from '../contexts/NotificationContext';

/**
 * Everything the workflow list's menus do to the library: rename (workflow
 * or category), move between categories, delete, duplicate, multi-select
 * with bulk delete / move, and JSON / Base64 export and import. Built on
 * the editor session so a change to the open workflow is written with the
 * canvas's current content and reflected in the title/category/tabs.
 *
 * Also owns the open/closed state of the confirmation and transfer modals
 * the builder renders.
 */
export default function useWorkflowLibraryActions(session) {
  const {
    workflows,
    currentWorkflow, setCurrentWorkflow,
    nodes, edges,
    workflowTitle, setWorkflowTitle,
    setWorkflowCategory,
    openTabs, setOpenTabs,
    loadWorkflows,
    loadWorkflowIntoEditor,
    clearEditor,
    saveCurrentWorkflow,
    openInTab,
    handleTabClose
  } = session;
  const { addNotification } = useNotifications();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedWorkflows, setSelectedWorkflows] = useState([]);
  const [workflowToDelete, setWorkflowToDelete] = useState(null);
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [showBulkMoveModal, setShowBulkMoveModal] = useState(false);
  const [showBase64Modal, setShowBase64Modal] = useState(false);
  const [base64Data, setBase64Data] = useState('');
  const [base64Mode, setBase64Mode] = useState('export'); // 'export' or 'import'

  /** The open workflow with the canvas's current content and `overrides` applied. */
  function currentWorkflowWithCanvas(overrides) {
    return {
      ...currentWorkflow,
      title: workflowTitle,
      nodes: cleanNodesForStorage(nodes),
      edges,
      ...overrides
    };
  }

  function notifyFailure(title, message, error) {
    console.error(message, error);
    addNotification({ type: 'error', title, message });
  }

  // Rename workflow
  async function handleRenameWorkflow(workflowId, newTitle) {
    try {
      // If renaming the current workflow, use current state (has latest nodes/edges)
      // Otherwise, fetch from database
      let workflowToUpdate;
      if (currentWorkflow?.id === workflowId) {
        workflowToUpdate = currentWorkflowWithCanvas({ title: newTitle });
      } else {
        const workflow = workflows.find(w => w.id === workflowId);
        if (!workflow) return;
        workflowToUpdate = { ...workflow, title: newTitle };
      }

      await updateWorkflow(workflowId, workflowToUpdate);

      // Update current workflow if it's the one being renamed
      if (currentWorkflow?.id === workflowId) {
        setWorkflowTitle(newTitle);
        setCurrentWorkflow({ ...currentWorkflow, title: newTitle });
      }

      // Update tabs
      setOpenTabs(tabs => tabs.map(t =>
        t.id === workflowId ? { ...t, title: newTitle } : t
      ));

      // Reload workflows list
      await loadWorkflows();
    } catch (error) {
      notifyFailure('Rename Failed', 'Failed to rename workflow.', error);
    }
  }

  // Rename category
  async function handleRenameCategory(oldCategory, newCategory) {
    try {
      // Find all workflows in the old category
      const workflowsToUpdate = workflows.filter(w => (w.category || 'General') === oldCategory);

      // Update each workflow's category
      for (const workflow of workflowsToUpdate) {
        await updateWorkflow(workflow.id, { ...workflow, category: newCategory });
      }

      // Update current workflow if it's in the renamed category
      if (currentWorkflow && (currentWorkflow.category || 'General') === oldCategory) {
        setWorkflowCategory(newCategory);
        setCurrentWorkflow({ ...currentWorkflow, category: newCategory });
      }

      // Update tabs
      setOpenTabs(tabs => tabs.map(t => {
        const workflow = workflows.find(w => w.id === t.id);
        if (workflow && (workflow.category || 'General') === oldCategory) {
          return { ...t, category: newCategory };
        }
        return t;
      }));

      // Reload workflows list
      await loadWorkflows();
    } catch (error) {
      notifyFailure('Rename Failed', 'Failed to rename category.', error);
    }
  }

  // Change workflow category (drag and drop)
  async function handleWorkflowCategoryChange(workflowId, newCategory) {
    try {
      // If it's the current workflow, save it first with the new category
      if (currentWorkflow?.id === workflowId) {
        const updatedWorkflow = currentWorkflowWithCanvas({ category: newCategory });
        await updateWorkflow(workflowId, updatedWorkflow);

        // Update state to reflect the new category
        setWorkflowCategory(newCategory);
        setCurrentWorkflow(updatedWorkflow);
      } else {
        // For non-current workflows, just update the category
        const workflowToUpdate = await getWorkflow(workflowId);
        if (!workflowToUpdate) return;

        await updateWorkflow(workflowId, {
          ...workflowToUpdate,
          category: newCategory
        });
      }

      // Update tabs
      setOpenTabs(tabs => tabs.map(t =>
        t.id === workflowId ? { ...t, category: newCategory } : t
      ));

      // Reload workflows list
      await loadWorkflows();
    } catch (error) {
      notifyFailure('Move Failed', 'Failed to move workflow.', error);
    }
  }

  // Delete workflow (after the confirmation modal)
  async function confirmDelete() {
    if (!workflowToDelete) return;

    try {
      if (currentWorkflow?.id === workflowToDelete.id) {
        // Close the tab without saving (since we're about to delete it)
        const newTabs = openTabs.filter(t => t.id !== workflowToDelete.id);
        setOpenTabs(newTabs);

        // Switch to another tab or clear
        if (newTabs.length > 0) {
          const allWorkflows = await getWorkflows();
          const workflow = allWorkflows.find(w => w.id === newTabs[newTabs.length - 1].id);
          if (workflow) {
            loadWorkflowIntoEditor(workflow);
          }
        } else {
          clearEditor('');
        }
      } else {
        // Different workflow, just close the tab normally
        await handleTabClose(workflowToDelete.id);
      }

      // Now delete from database
      await deleteWorkflow(workflowToDelete.id);

      // Reload list
      await loadWorkflows();

      setWorkflowToDelete(null);
    } catch (error) {
      notifyFailure('Delete Failed', 'Failed to delete workflow.', error);
    }
  }

  // Duplicate workflow
  async function handleDuplicateWorkflow(workflow) {
    try {
      // Save current workflow before duplicating
      if (currentWorkflow) {
        await saveCurrentWorkflow();
      }

      // Generate a unique title
      let newTitle = `${workflow.title} (Copy)`;
      let counter = 1;

      // Check if title already exists and increment counter if needed
      while (workflows.some(w => w.title === newTitle)) {
        counter++;
        newTitle = `${workflow.title} (Copy ${counter})`;
      }

      // Create a copy of the workflow with a new ID
      const newWorkflowId = await createWorkflow({
        title: newTitle,
        category: workflow.category || 'General',
        nodes: workflow.nodes || [],
        edges: workflow.edges || [],
        inCloud: false, // a copy is not shared with the team
        ownerId: null,
        cloudLastUpdated: null
      });

      // Reload workflows list
      await loadWorkflows();

      // Open the duplicated workflow
      const allWorkflows = await getWorkflows();
      const newWorkflow = allWorkflows.find(w => w.id === newWorkflowId);

      if (newWorkflow) {
        openInTab(newWorkflow);
      }
    } catch (error) {
      notifyFailure('Duplicate Failed', 'Failed to duplicate workflow.', error);
    }
  }

  // Selection mode functions
  function toggleSelectionMode() {
    setSelectionMode(!selectionMode);
    setSelectedWorkflows([]);
  }

  function toggleWorkflowSelection(workflowId) {
    setSelectedWorkflows(prev => {
      if (prev.includes(workflowId)) {
        return prev.filter(id => id !== workflowId);
      } else {
        return [...prev, workflowId];
      }
    });
  }

  function exitSelectionMode() {
    setSelectedWorkflows([]);
    setSelectionMode(false);
  }

  // Bulk delete
  function handleBulkDelete() {
    if (selectedWorkflows.length === 0) return;
    setShowBulkDeleteModal(true);
  }

  async function confirmBulkDelete() {
    if (selectedWorkflows.length === 0) return;

    try {
      for (const workflowId of selectedWorkflows) {
        await deleteWorkflow(workflowId);
        // Close tab if open
        await handleTabClose(workflowId);
      }

      await loadWorkflows();
      exitSelectionMode();
      setShowBulkDeleteModal(false);
    } catch (error) {
      notifyFailure('Delete Failed', 'Failed to delete workflows.', error);
    }
  }

  // Bulk move
  function handleBulkMove() {
    setShowBulkMoveModal(true);
  }

  async function confirmBulkMove(targetCategory) {
    if (!targetCategory) {
      addNotification({
        type: 'alert',
        title: 'No Category Selected',
        message: 'Please select or enter a category.'
      });
      return;
    }

    if (selectedWorkflows.length === 0) return;

    try {
      for (const workflowId of selectedWorkflows) {
        // If this is the current workflow, update it with current state
        if (currentWorkflow?.id === workflowId) {
          const updatedWorkflow = currentWorkflowWithCanvas({ category: targetCategory });
          await updateWorkflow(workflowId, updatedWorkflow);
          setWorkflowCategory(targetCategory);
          setCurrentWorkflow(updatedWorkflow);
        } else {
          // For non-current workflows, just update the category
          const workflow = workflows.find(w => w.id === workflowId);
          if (workflow) {
            await updateWorkflow(workflowId, { ...workflow, category: targetCategory });
          }
        }
      }

      // Update tabs with new category
      setOpenTabs(tabs => tabs.map(t =>
        selectedWorkflows.includes(t.id) ? { ...t, category: targetCategory } : t
      ));

      await loadWorkflows();
      exitSelectionMode();
      setShowBulkMoveModal(false);
    } catch (error) {
      notifyFailure('Move Failed', 'Failed to move workflows.', error);
    }
  }

  /**
   * Download workflows as a JSON file: all of them (the menu's "Export All"),
   * or `workflowsToExport` - a single workflow, a selection or a category
   * (`category` names the file). Always an array, the format "Import from
   * JSON" reads (src/utils/workflowTransfer.js).
   */
  async function handleExportAll(workflowsToExport = null, { category = null } = {}) {
    try {
      const list = workflowsToExport || await getWorkflows();
      const blob = new Blob([serializeWorkflows(list)], { type: 'application/json' });
      downloadBlob(blob, workflowExportFileName({ workflows: list, category }));
    } catch (error) {
      notifyFailure('Export Failed', 'Failed to export workflows.', error);
    }
  }

  /**
   * Create a workflow for every entry of an exported list (JSON file or
   * Base64 text). Returns false when the data is not a list.
   */
  async function importWorkflowList(importedWorkflows, invalidFormatMessage) {
    if (!Array.isArray(importedWorkflows)) {
      addNotification({
        type: 'error',
        title: 'Invalid Format',
        message: invalidFormatMessage
      });
      return false;
    }

    for (const workflow of importedWorkflows) {
      await createWorkflow({
        title: workflow.title || 'Imported Workflow',
        category: workflow.category || 'General',
        nodes: workflow.nodes || [],
        edges: workflow.edges || []
      });
    }

    await loadWorkflows();
    addNotification({
      type: 'success',
      title: 'Import Successful',
      message: `Successfully imported ${importedWorkflows.length} workflow${importedWorkflows.length !== 1 ? 's' : ''}.`
    });
    return true;
  }

  // Import workflows from a JSON file
  function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        await importWorkflowList(parseWorkflowsExport(text), 'Invalid workflow file format. Expected an array of workflows.');
      } catch (error) {
        notifyFailure('Import Failed', 'Failed to import workflows. Please check the file format.', error);
      }
    };
    input.click();
  }

  // Export workflows as Base64 (all of them unless a subset is given)
  async function handleExportBase64(workflowsToExport = null) {
    try {
      const list = workflowsToExport || await getWorkflows();
      const jsonString = JSON.stringify(list);
      const base64 = btoa(unescape(encodeURIComponent(jsonString)));

      await navigator.clipboard.writeText(base64);
      setBase64Data(base64);
      setBase64Mode('export');
      setShowBase64Modal(true);
    } catch (error) {
      notifyFailure('Export Failed', 'Failed to export to Base64: ' + error.message, error);
    }
  }

  // Import workflows from Base64
  function handleImportBase64() {
    setBase64Data('');
    setBase64Mode('import');
    setShowBase64Modal(true);
  }

  function closeBase64Modal() {
    setShowBase64Modal(false);
    setBase64Data('');
  }

  async function confirmBase64Import() {
    try {
      const jsonString = decodeURIComponent(escape(atob(base64Data.trim())));
      if (await importWorkflowList(parseWorkflowsExport(jsonString), 'Invalid workflow format: Expected an array of workflows.')) {
        closeBase64Modal();
      }
    } catch (error) {
      notifyFailure('Import Failed', 'Failed to import from Base64: ' + error.message, error);
    }
  }

  return {
    // list edits
    handleRenameWorkflow,
    handleRenameCategory,
    handleWorkflowCategoryChange,
    handleDuplicateWorkflow,
    // delete confirmation
    workflowToDelete,
    requestDelete: setWorkflowToDelete,
    cancelDelete: () => setWorkflowToDelete(null),
    confirmDelete,
    // multi-select + bulk actions
    selectionMode,
    selectedWorkflows,
    toggleSelectionMode,
    toggleWorkflowSelection,
    handleBulkDelete,
    showBulkDeleteModal,
    closeBulkDelete: () => setShowBulkDeleteModal(false),
    confirmBulkDelete,
    handleBulkMove,
    showBulkMoveModal,
    closeBulkMove: () => setShowBulkMoveModal(false),
    confirmBulkMove,
    // transfer
    handleExportAll,
    handleImport,
    handleExportBase64,
    handleImportBase64,
    showBase64Modal,
    base64Mode,
    base64Data,
    setBase64Data,
    closeBase64Modal,
    confirmBase64Import
  };
}
