/**
 * Central server connection (the team features: shared documents, workflows, boards)
 * Handles real-time sync via WebSocket connection to central server
 */

import {
  receiveDocumentFromCentral,
  receiveWorkflowFromCentral } from './cloudCentralSync';
import {
  receiveBoardFromCentral
} from './cloudKanban';
import {
  connectWebSocket,
  disconnectWebSocket,
  isWebSocketConnected,
  onConnectionStatusChange,
  onDocumentsUpdate,
  onWorkflowsUpdate,
  onBoardsUpdate
} from './cloudWebSocket';

// the connection state, for the central status in Settings > General (one import)
export { isWebSocketConnected, onConnectionStatusChange };

let unsubscribeCallbacks = [];
let isProcessingDocuments = false;
let isProcessingWorkflows = false;
let isProcessingBoards = false;
let documentQueue = [];
let workflowQueue = [];
let boardQueue = [];

/**
 * Check if cloud sync is enabled in settings
 */
export function isCloudSyncEnabled() {
  // On unless switched off: the central server comes with the home server
  // (nothing to configure), so an app that has one connects by itself.
  return localStorage.getItem('cloudSyncEnabled') !== 'false';
}

/**
 * Set cloud sync enabled status
 */
export function setCloudSyncEnabled(enabled) {
  localStorage.setItem('cloudSyncEnabled', enabled ? 'true' : 'false');
  console.log(`[CloudSync] Cloud sync ${enabled ? 'enabled' : 'disabled'}`);

  // If disabling, stop any active polling
  if (!enabled) {
    stopCloudSync();
  }
}

/**
 * Get connection status
 */
export function isCloudSyncActive() {
  return isWebSocketConnected();
}

/**
 * Start cloud sync via WebSocket
 */
export async function startCloudSync() {
  // Check if cloud sync is enabled
  if (!isCloudSyncEnabled()) {
    console.log('[CloudSync] Cloud sync is disabled in settings. Skipping.');
    return;
  }

  if (isWebSocketConnected()) {
    console.log('[CloudSync] Already connected');
    return;
  }

  console.log('[CloudSync] Starting WebSocket connection...');

  // Connect to WebSocket server
  const connected = await connectWebSocket();

  if (!connected) {
    console.error('[CloudSync] Failed to connect to WebSocket server');
    return;
  }

  // Subscribe to connection status changes
  const unsubscribeStatus = onConnectionStatusChange(({ connected }) => {
    console.log('[CloudSync] Connection status changed:', connected ? 'CONNECTED' : 'DISCONNECTED');

    // Dispatch event to notify UI
    window.dispatchEvent(new CustomEvent('cloudConnectionStatusChanged', {
      detail: { connected }
    }));
  });
  unsubscribeCallbacks.push(unsubscribeStatus);

  // Subscribe to document updates
  const unsubscribeDocs = onDocumentsUpdate(async (documents) => {
    await processDocumentUpdates(documents);
  });
  unsubscribeCallbacks.push(unsubscribeDocs);

  // Subscribe to workflow updates
  const unsubscribeWorkflows = onWorkflowsUpdate(async (workflows) => {
    await processWorkflowUpdates(workflows);
  });
  unsubscribeCallbacks.push(unsubscribeWorkflows);

  // Subscribe to board updates
  const unsubscribeBoards = onBoardsUpdate(async (boards) => {
    await processBoardUpdates(boards);
  });
  unsubscribeCallbacks.push(unsubscribeBoards);

  console.log('[CloudSync] WebSocket sync started');
}

/**
 * Stop cloud sync
 */
export function stopCloudSync() {
  console.log('[CloudSync] Stopping cloud sync');

  // Unsubscribe from all callbacks
  unsubscribeCallbacks.forEach(unsubscribe => unsubscribe());
  unsubscribeCallbacks = [];

  // Disconnect WebSocket
  disconnectWebSocket();
}

/**
 * Process document updates from WebSocket
 */
async function processDocumentUpdates(documents) {
  // Add documents to queue to prevent duplicates
  for (const doc of documents) {
    const key = `${doc.ownerId}-${doc.title}`;
    const existingIndex = documentQueue.findIndex(d => `${d.ownerId}-${d.title}` === key);

    if (existingIndex >= 0) {
      // Replace existing queued document with newer version
      const existingTime = documentQueue[existingIndex].cloudLastUpdated || 0;
      const incomingTime = doc.cloudLastUpdated || 0;

      if (incomingTime > existingTime) {
        console.log(`[CloudSync] Replacing queued document "${doc.title}" with newer version`);
        documentQueue[existingIndex] = doc;
      } else {
        console.log(`[CloudSync] Skipping older version of "${doc.title}"`);
      }
    } else {
      documentQueue.push(doc);
    }
  }

  // If already processing, the queue will be handled when current processing finishes
  if (isProcessingDocuments) {
    console.log('[CloudSync] Already processing documents, queued for next batch');
    return;
  }

  // Process queue
  await processDocumentQueue();
}

/**
 * Process queued documents one by one
 */
async function processDocumentQueue() {
  if (isProcessingDocuments || documentQueue.length === 0) {
    return;
  }

  isProcessingDocuments = true;

  try {
    const batchSize = documentQueue.length;
    console.log(`[CloudSync] Processing ${batchSize} queued document(s)`);

    let processedCount = 0;
    let errorCount = 0;
    // Per-document outcome of receiveDocumentFromCentral, so UI listeners can
    // update just the affected documents instead of reloading everything:
    // { action: 'created'|'updated'|'deleted'|'removed_metadata'|'rejected'|'ignored',
    //   documentId: local IndexedDB id (absent for rejected/ignored) }
    const results = [];

    // Process all queued documents
    while (documentQueue.length > 0) {
      const doc = documentQueue.shift();

      try {
        const result = await receiveDocumentFromCentral(doc);
        console.log(`[CloudSync] Processed document "${doc.title}": ${result.action}`, result);
        results.push({
          action: result.action,
          documentId: result.documentId,
          title: doc.title,
          ownerId: doc.ownerId
        });
        processedCount++;
      } catch (error) {
        console.error(`[CloudSync] Failed to process document "${doc.title}":`, error);
        errorCount++;
      }
    }

    // Dispatch event to notify UI to refresh the affected documents
    window.dispatchEvent(new CustomEvent('cloudDocumentsReceived', {
      detail: {
        total: batchSize,
        processed: processedCount,
        errors: errorCount,
        results
      }
    }));

    if (processedCount > 0) {
      console.log(`[CloudSync] ✓ Successfully synced ${processedCount} document(s)`);
    }
    if (errorCount > 0) {
      console.warn(`[CloudSync] ✗ Failed to sync ${errorCount} document(s)`);
    }
  } catch (error) {
    console.error('[CloudSync] Document processing error:', error);
  } finally {
    isProcessingDocuments = false;

    // Check if more documents were queued while processing
    if (documentQueue.length > 0) {
      console.log(`[CloudSync] Processing ${documentQueue.length} more queued document(s)`);
      setTimeout(() => processDocumentQueue(), 100);
    }
  }
}

/**
 * Process workflow updates from WebSocket
 */
async function processWorkflowUpdates(workflows) {
  // Add workflows to queue to prevent duplicates
  for (const workflow of workflows) {
    const key = `${workflow.ownerId}-${workflow.title}`;
    const existingIndex = workflowQueue.findIndex(w => `${w.ownerId}-${w.title}` === key);

    if (existingIndex >= 0) {
      // Replace existing queued workflow with newer version
      const existingTime = workflowQueue[existingIndex].cloudLastUpdated || 0;
      const incomingTime = workflow.cloudLastUpdated || 0;

      if (incomingTime > existingTime) {
        console.log(`[CloudSync] Replacing queued workflow "${workflow.title}" with newer version`);
        workflowQueue[existingIndex] = workflow;
      } else {
        console.log(`[CloudSync] Skipping older version of "${workflow.title}"`);
      }
    } else {
      workflowQueue.push(workflow);
    }
  }

  // If already processing, the queue will be handled when current processing finishes
  if (isProcessingWorkflows) {
    console.log('[CloudSync] Already processing workflows, queued for next batch');
    return;
  }

  // Process queue
  await processWorkflowQueue();
}

/**
 * Process queued workflows one by one
 */
async function processWorkflowQueue() {
  if (isProcessingWorkflows || workflowQueue.length === 0) {
    return;
  }

  isProcessingWorkflows = true;

  try {
    const batchSize = workflowQueue.length;
    console.log(`[CloudSync] Processing ${batchSize} queued workflow(s)`);

    let processedCount = 0;
    let errorCount = 0;

    // Process all queued workflows
    while (workflowQueue.length > 0) {
      const workflow = workflowQueue.shift();

      try {
        const result = await receiveWorkflowFromCentral(workflow);
        console.log(`[CloudSync] Processed workflow "${workflow.title}": ${result.action}`, result);
        processedCount++;
      } catch (error) {
        console.error(`[CloudSync] Failed to process workflow "${workflow.title}":`, error);
        errorCount++;
      }
    }

    // Dispatch event to notify UI to refresh workflows
    window.dispatchEvent(new CustomEvent('cloudWorkflowsReceived', {
      detail: {
        total: batchSize,
        processed: processedCount,
        errors: errorCount
      }
    }));

    if (processedCount > 0) {
      console.log(`[CloudSync] ✓ Successfully synced ${processedCount} workflow(s)`);
    }
    if (errorCount > 0) {
      console.warn(`[CloudSync] ✗ Failed to sync ${errorCount} workflow(s)`);
    }
  } catch (error) {
    console.error('[CloudSync] Workflow processing error:', error);
  } finally {
    isProcessingWorkflows = false;

    // Check if more workflows were queued while processing
    if (workflowQueue.length > 0) {
      console.log(`[CloudSync] Processing ${workflowQueue.length} more queued workflow(s)`);
      setTimeout(() => processWorkflowQueue(), 100);
    }
  }
}

/**
 * Process board updates from WebSocket
 */
async function processBoardUpdates(boards) {
  // Add boards to queue to prevent duplicates
  for (const item of boards) {
    const key = `${item.ownerId}-${item.board?.title}`;
    const existingIndex = boardQueue.findIndex(b => `${b.ownerId}-${b.board?.title}` === key);

    if (existingIndex >= 0) {
      // Replace existing queued board with newer version
      const existingTime = boardQueue[existingIndex].cloudLastUpdated || 0;
      const incomingTime = item.cloudLastUpdated || 0;

      if (incomingTime > existingTime) {
        console.log(`[CloudSync] Replacing queued board "${item.board?.title}" with newer version`);
        boardQueue[existingIndex] = item;
      } else {
        console.log(`[CloudSync] Skipping older version of "${item.board?.title}"`);
      }
    } else {
      boardQueue.push(item);
    }
  }

  // If already processing, the queue will be handled when current processing finishes
  if (isProcessingBoards) {
    console.log('[CloudSync] Already processing boards, queued for next batch');
    return;
  }

  // Process queue
  await processBoardQueue();
}

/**
 * Process queued boards one by one
 */
async function processBoardQueue() {
  if (isProcessingBoards || boardQueue.length === 0) {
    return;
  }

  isProcessingBoards = true;

  try {
    const batchSize = boardQueue.length;
    console.log(`[CloudSync] Processing ${batchSize} queued board(s)`);

    let processedCount = 0;
    let errorCount = 0;

    // Process all queued boards
    while (boardQueue.length > 0) {
      const item = boardQueue.shift();

      try {
        const result = await receiveBoardFromCentral(item);
        console.log(`[CloudSync] Processed board "${item.board?.title}": ${result.action}`, result);
        processedCount++;
      } catch (error) {
        console.error(`[CloudSync] Failed to process board "${item.board?.title}":`, error);
        errorCount++;
      }
    }

    // Dispatch event to notify UI to refresh kanban boards
    window.dispatchEvent(new CustomEvent('cloudKanbanBoardsReceived', {
      detail: {
        total: batchSize,
        processed: processedCount,
        errors: errorCount
      }
    }));

    if (processedCount > 0) {
      console.log(`[CloudSync] ✓ Successfully synced ${processedCount} board(s)`);
    }
    if (errorCount > 0) {
      console.warn(`[CloudSync] ✗ Failed to sync ${errorCount} board(s)`);
    }
  } catch (error) {
    console.error('[CloudSync] Board processing error:', error);
  } finally {
    isProcessingBoards = false;

    // Check if more boards were queued while processing
    if (boardQueue.length > 0) {
      console.log(`[CloudSync] Processing ${boardQueue.length} more queued board(s)`);
      setTimeout(() => processBoardQueue(), 100);
    }
  }
}

/**
 * Manually trigger a sync check
 * Polls HTTP endpoint for pending updates (as fallback to WebSocket)
 */
export async function syncNow() {
  console.log('[CloudSync] Manual sync check - WebSocket connection:', isWebSocketConnected() ? 'CONNECTED' : 'DISCONNECTED');

  // Try to reconnect WebSocket if disconnected
  if (!isWebSocketConnected()) {
    console.log('[CloudSync] Attempting to reconnect WebSocket...');
    await startCloudSync();
  }

  // Also poll HTTP endpoint for any missed updates
  // This works even if WebSocket is down
  try {
    console.log('[CloudSync] Polling HTTP endpoint for pending updates...');
    const { pollCentralForDocuments } = await import('./cloudCentralSync');
    const result = await pollCentralForDocuments();

    // Process pending documents
    if (result.documents && result.documents.length > 0) {
      console.log(`[CloudSync] Found ${result.documents.length} pending document(s) via HTTP poll`);
      await processDocumentUpdates(result.documents);
    }

    // Process pending workflows
    if (result.workflows && result.workflows.length > 0) {
      console.log(`[CloudSync] Found ${result.workflows.length} pending workflow(s) via HTTP poll`);
      await processWorkflowUpdates(result.workflows);
    }

    // Process pending boards
    if (result.boards && result.boards.length > 0) {
      console.log(`[CloudSync] Found ${result.boards.length} pending board(s) via HTTP poll`);
      await processBoardUpdates(result.boards);
    }

    const totalPending = (result.documents?.length || 0) + (result.workflows?.length || 0) + (result.boards?.length || 0);
    if (totalPending === 0) {
      console.log('[CloudSync] No pending updates found via HTTP poll');
    } else {
      console.log(`[CloudSync] ✓ Synced ${totalPending} item(s) via HTTP poll`);
    }
  } catch (error) {
    console.error('[CloudSync] HTTP poll failed:', error);
    throw error; // Re-throw so UI can show error
  }
}
