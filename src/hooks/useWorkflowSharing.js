import { useState } from 'react';
import { uploadWorkflowToCentral, removeWorkflowFromCentral, getCentralServerUrl } from '../utils/cloudCentralSync';
import { getWorkflow, updateWorkflow } from '../utils/workflows';
import { isSharedWorkflow, isSharedByMe, isMineOrUnshared } from '../utils/workflowSharing';
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
    notifyCentralUnavailable(addNotification, 'share workflows');
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

      const wasShared = isSharedWorkflow(latestWorkflow);
      await uploadWorkflowToCentral(latestWorkflow);

      addNotification(wasShared
        ? { type: 'success', title: 'Changes Synced', message: 'Your changes to the workflow are now with the team.' }
        : { type: 'success', title: 'Shared with the Team', message: 'The workflow is now shared with your team.' });

      announceSharingChange();
      onWorkflowsChanged?.();
    } catch (error) {
      console.error('Upload failed:', error);
      addNotification({
        type: 'error',
        title: 'Sharing Failed',
        message: 'Failed to share the workflow: ' + error.message
      });
    }
  }

  async function stopSharing(workflow) {
    try {
      await removeWorkflowFromCentral(workflow);

      addNotification({
        type: 'success',
        title: 'Stopped Sharing',
        message: 'The workflow is no longer shared with your team.'
      });

      announceSharingChange();
      onWorkflowsChanged?.();
    } catch (error) {
      console.error('Remove from cloud failed:', error);
      addNotification({
        type: 'error',
        title: "Couldn't Stop Sharing",
        message: 'Failed to stop sharing:\n' + error.message
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
        title: 'Nothing to Share',
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

    reportBatch(successCount, failCount, 'Changes Synced', 'synced with the team', 'Sync Failed', 'Failed to sync the workflows\' changes with the team.');
    onWorkflowsChanged?.();
  }

  /** Remove every cloud workflow in `candidates` that this app owns from the cloud. */
  async function stopSharingWorkflows(candidates, emptyMessage) {
    const mine = candidates.filter(w => isSharedByMe(w, currentMachineId));

    if (mine.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Nothing to Stop Sharing',
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

    reportBatch(successCount, failCount, 'Stopped Sharing', 'no longer shared', "Couldn't Stop Sharing", 'Failed to stop sharing the workflows.');
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
