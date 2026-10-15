import { useState } from 'react';
import { uploadWorkflowToCentral, removeWorkflowFromCentral, getCentralServerUrl } from '../utils/cloudCentralSync';
import { getWorkflow, updateWorkflow } from '../utils/workflows';
import { isSharedByMe, isMineOrUnshared } from '../utils/workflowSharing';
import { useNotifications } from '../contexts/NotificationContext';
import { notifyCentralUnavailable } from '../utils/centralAvailability';

/** The UI reloads its list after a cloud change through this event (see useWorkflowSession). */
function announceSharingChange() {
  window.dispatchEvent(new CustomEvent('cloudWorkflowsReceived', {
    detail: { total: 0, processed: 0, errors: 0 }
  }));
}

/**
 * The workflow list's cloud actions - "the cloud" being the central server
 * the home server provides (src/utils/workflowSharing.js explains the
 * record fields): upload / sync one or many workflows, remove them from
 * the cloud, and the permissions the owner grants. The "many" variants (a
 * selection or a whole category) report one summary notification for the
 * batch.
 *
 * @param {Object}   params
 * @param {string}   params.currentMachineId - this app's identity on the central server
 * @param {Function} [params.onWorkflowsChanged] - called after any change
 */
export default function useWorkflowSharing({ currentMachineId, onWorkflowsChanged }) {
  const { addNotification } = useNotifications();
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [permissionsWorkflow, setPermissionsWorkflow] = useState(null);
  const [permissionsWorkflows, setPermissionsWorkflows] = useState(null); // For bulk operations

  /** True when a central server is available; otherwise tells the user why nothing happens. */
  function requireCentralServer() {
    if (getCentralServerUrl()) return true;
    notifyCentralUnavailable(addNotification, 'upload workflows to the cloud');
    return false;
  }

  function reportBatch(successCount, failCount, successTitle, successVerb, failTitle, failMessage) {
    if (successCount > 0) {
      addNotification({
        type: 'success',
        title: successTitle,
        message: `${successCount} workflow${successCount !== 1 ? 's' : ''} ${successVerb}${failCount > 0 ? ` (${failCount} failed)` : ''}.`
      });
    }

    if (failCount > 0 && successCount === 0) {
      addNotification({
        type: 'error',
        title: failTitle,
        message: failMessage
      });
    }
  }

  // Share with team / Push changes for a single workflow
  async function shareWorkflow(workflow) {
    if (!requireCentralServer()) return;

    try {
      // IMPORTANT: Fetch the latest version from IndexedDB before syncing
      // The workflow list may be stale if auto-save happened recently
      const latestWorkflow = await getWorkflow(workflow.id);

      if (!latestWorkflow) {
        throw new Error('Workflow not found');
      }

      console.log('[WorkflowList] Syncing latest version of workflow:', latestWorkflow.title);

      await uploadWorkflowToCentral(latestWorkflow);

      addNotification({
        type: 'success',
        title: 'Upload Successful',
        message: 'Workflow uploaded to central server successfully.'
      });

      announceSharingChange();
      onWorkflowsChanged?.();
    } catch (error) {
      console.error('Upload failed:', error);
      addNotification({
        type: 'error',
        title: 'Upload Failed',
        message: 'Failed to upload to central server: ' + error.message
      });
    }
  }

  async function stopSharing(workflow) {
    try {
      await removeWorkflowFromCentral(workflow);

      addNotification({
        type: 'success',
        title: 'Removed from Cloud',
        message: 'Workflow has been removed from central server.'
      });

      announceSharingChange();
      onWorkflowsChanged?.();
    } catch (error) {
      console.error('Remove from cloud failed:', error);
      addNotification({
        type: 'error',
        title: 'Remove Failed',
        message: 'Failed to remove from cloud:\n' + error.message
      });
    }
  }

  /**
   * Upload / sync every local or own cloud workflow in `candidates` (a
   * selection or a category); `emptyMessage` is shown when none qualifies.
   */
  async function shareWorkflows(candidates, emptyMessage) {
    if (!requireCentralServer()) return;

    const shareable = candidates.filter(w => isMineOrUnshared(w, currentMachineId));

    if (shareable.length === 0) {
      addNotification({
        type: 'alert',
        title: 'No Workflows to Sync',
        message: emptyMessage
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const workflow of shareable) {
      try {
        const freshWorkflow = await getWorkflow(workflow.id);
        if (freshWorkflow) {
          await uploadWorkflowToCentral(freshWorkflow);
          successCount++;
        }
      } catch (error) {
        console.error(`Failed to sync ${workflow.title}:`, error);
        failCount++;
      }
    }

    reportBatch(successCount, failCount, 'Synced to Cloud', 'synced to cloud', 'Sync Failed', 'Failed to sync workflows to cloud.');
    onWorkflowsChanged?.();
  }

  /** Remove every cloud workflow in `candidates` that this app owns from the cloud. */
  async function stopSharingWorkflows(candidates, emptyMessage) {
    const mine = candidates.filter(w => isSharedByMe(w, currentMachineId));

    if (mine.length === 0) {
      addNotification({
        type: 'alert',
        title: 'No Workflows to Remove',
        message: emptyMessage
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const workflow of mine) {
      try {
        await removeWorkflowFromCentral(workflow);
        successCount++;
      } catch (error) {
        console.error(`Failed to remove ${workflow.title}:`, error);
        failCount++;
      }
    }

    reportBatch(successCount, failCount, 'Removed from Cloud', 'removed from cloud', 'Remove Failed', 'Failed to remove workflows from cloud.');
    onWorkflowsChanged?.();
  }

  /** Open the permissions modal for one workflow. */
  function managePermissions(workflow) {
    setPermissionsWorkflow(workflow);
    setShowPermissionsModal(true);
  }

  /** Open the bulk permissions modal for the workflows in `candidates` this app shared. */
  function managePermissionsFor(candidates, emptyMessage) {
    const mine = candidates.filter(w => isSharedByMe(w, currentMachineId));

    if (mine.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Cannot Manage Permissions',
        message: emptyMessage
      });
    } else {
      setPermissionsWorkflows(mine);
      setShowPermissionsModal(true);
    }
  }

  function closePermissionsModal() {
    setShowPermissionsModal(false);
    setPermissionsWorkflow(null);
    setPermissionsWorkflows(null);
  }

  async function handleSavePermissions(permissions) {
    // Handle both single and bulk operations
    const targetWorkflows = permissionsWorkflows || (permissionsWorkflow ? [permissionsWorkflow] : []);
    if (targetWorkflows.length === 0) return;

    const isBulk = permissionsWorkflows && permissionsWorkflows.length > 1;

    try {
      let successCount = 0;
      let failCount = 0;

      for (const workflow of targetWorkflows) {
        try {
          await updateWorkflow(workflow.id, {
            permissions: permissions
          });

          // Push the updated record to the team when this app shared it
          if (isSharedByMe(workflow, currentMachineId)) {
            const updatedWorkflow = await getWorkflow(workflow.id);
            if (updatedWorkflow) {
              await uploadWorkflowToCentral(updatedWorkflow);
            }
          }
          successCount++;
        } catch (error) {
          console.error(`Failed to update permissions for ${workflow.title}:`, error);
          failCount++;
        }
      }

      if (successCount > 0) {
        addNotification({
          type: 'success',
          title: 'Permissions Updated',
          message: isBulk
            ? `Permissions updated for ${successCount} workflow${successCount !== 1 ? 's' : ''}${failCount > 0 ? ` (${failCount} failed)` : ''}.`
            : `Permissions for "${targetWorkflows[0].title}" have been updated.`
        });
      }

      if (failCount > 0 && successCount === 0) {
        addNotification({
          type: 'error',
          title: 'Update Failed',
          message: 'Failed to update workflow permissions.'
        });
      }

      // Trigger workflow reload
      onWorkflowsChanged?.();
    } catch (error) {
      console.error('Failed to update permissions:', error);
      addNotification({
        type: 'error',
        title: 'Update Failed',
        message: 'Failed to update workflow permissions.'
      });
    }
  }

  return {
    shareWorkflow,
    stopSharing,
    shareWorkflows,
    stopSharingWorkflows,
    managePermissions,
    managePermissionsFor,
    permissionsModal: {
      isOpen: showPermissionsModal,
      workflow: permissionsWorkflow,
      workflows: permissionsWorkflows,
      onClose: closePermissionsModal,
      onSave: handleSavePermissions
    }
  };
}
