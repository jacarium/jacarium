/**
 * Socket-based sync handlers (documents / workflows / kanban boards,
 * cursors, real-time content updates, connected-users broadcasting).
 * These are called from the connection handler in socket-handlers.js and
 * are a separate code path from the REST routes in api-routes.js.
 * Extracted verbatim from server.js (structural refactor only; the only
 * mechanical change is `++messageIdCounter` -> `nextMessageId()`).
 */

const {
  connectedClients,
  displayNames,
  documentCursors,
  messageQueue,
  pushBounded,
  nextMessageId,
  debugLog
} = require('./state');
// Encrypted Yjs snapshot persistence: uploads teach the server the
// (ownerId, title) -> cloudDocumentId mapping; explicit removal purges the
// in-memory Y.Doc AND its persisted snapshot. All no-ops when
// YJS_STORAGE_ENCRYPTION_KEY is unset (memory-only mode).
const { recordDocumentId, lookupDocumentId, forgetDocumentId } = require('./yjs-persistence');
const { purgeDocument, reseedDegradedDocument } = require('./yjs-sync');
// Uploads must carry the authenticated machine_id as ownerId (and never a
// `_type` marker) - see checkUploadOwnership for the full rationale.
const { checkUploadOwnership } = require('./client-registry');

// ============================================================================
// WebSocket Handlers
// ============================================================================

/**
 * Send pending messages to a newly connected client
 */
function sendPendingMessages(socket, machineId) {
  const pendingDocs = [];
  const pendingWorkflows = [];
  const pendingBoards = [];

  // Check documents
  for (const msg of messageQueue.documents) {
    if (!msg.deliveredTo.has(machineId)) {
      pendingDocs.push(msg.document);
      msg.deliveredTo.add(machineId);
    }
  }

  // Check workflows
  for (const msg of messageQueue.workflows) {
    if (!msg.deliveredTo.has(machineId)) {
      pendingWorkflows.push(msg.workflow);
      msg.deliveredTo.add(machineId);
    }
  }

  // Check boards
  for (const msg of messageQueue.kanbanBoards) {
    if (!msg.deliveredTo.has(machineId)) {
      pendingBoards.push({ board: msg.board, cards: msg.cards });
      msg.deliveredTo.add(machineId);
    }
  }

  if (pendingDocs.length > 0) {
    console.log(`[WebSocket] Sending ${pendingDocs.length} pending document(s) to ${machineId}`);
    socket.emit('documents-update', { documents: pendingDocs });
  }

  if (pendingWorkflows.length > 0) {
    console.log(`[WebSocket] Sending ${pendingWorkflows.length} pending workflow(s) to ${machineId}`);
    socket.emit('workflows-update', { workflows: pendingWorkflows });
  }

  if (pendingBoards.length > 0) {
    console.log(`[WebSocket] Sending ${pendingBoards.length} pending board(s) to ${machineId}`);
    socket.emit('boards-update', { boards: pendingBoards });
  }
}

/**
 * Handle document upload via WebSocket
 */
function handleDocumentUpload(data, socket) {
  const { machine_id, document } = data;

  console.log(`\n[WebSocket] Document upload from ${machine_id}: "${document?.title}"`);

  if (!document || !document.title || !document.ownerId) {
    socket.emit('upload-error', { error: 'Document must have title and ownerId' });
    return;
  }

  // machine_id here is the VERIFIED socket identity (socket-handlers.js
  // overwrites it after requireSocketAuth). Refuse to broadcast anything
  // claiming another user's ownerId, or a smuggled removal marker.
  const ownershipError = checkUploadOwnership(document, machine_id);
  if (ownershipError) {
    socket.emit('upload-error', { error: ownershipError });
    return;
  }

  // Remember which Yjs documentId this (ownerId, title) refers to, so a later
  // remove-document (which carries only ownerId+title) can delete the
  // encrypted snapshot for the right document.
  if (document.cloudDocumentId) {
    recordDocumentId(document.ownerId, document.title, document.cloudDocumentId);
    // If this document's Yjs state is DEGRADED (persisted snapshot exists but
    // could not be loaded), this explicit re-upload is the designated escape
    // hatch: rebuild the Yjs doc from exactly this uploaded copy. No-op for
    // healthy documents.
    reseedDegradedDocument(document.cloudDocumentId, document.content);
  }

  messageQueue.activeMachines.add(machine_id);

  // Add to queue for fallback
  const message = {
    id: nextMessageId(),
    sender: machine_id,
    document,
    timestamp: Date.now(),
    deliveredTo: new Set([machine_id])
  };
  pushBounded(messageQueue.documents, message);

  // Broadcast to all connected clients except sender
  let broadcastCount = 0;
  for (const [clientId, clientSocket] of connectedClients.entries()) {
    if (clientId !== machine_id) {
      clientSocket.emit('documents-update', { documents: [document] });
      message.deliveredTo.add(clientId);
      broadcastCount++;
    }
  }

  debugLog(`[WebSocket] Document broadcasted to ${broadcastCount} client(s)`);

  // Clean up if all active clients received it
  if (message.deliveredTo.size >= messageQueue.activeMachines.size) {
    const index = messageQueue.documents.indexOf(message);
    if (index > -1) {
      messageQueue.documents.splice(index, 1);
      debugLog(`[WebSocket] Document message removed from queue (all clients received)`);
    }
  }

  socket.emit('upload-success', { message_id: message.id });
}

/**
 * Handle workflow upload via WebSocket
 */
function handleWorkflowUpload(data, socket) {
  const { machine_id, workflow } = data;

  console.log(`\n[WebSocket] Workflow upload from ${machine_id}: "${workflow?.title}"`);

  if (!workflow || !workflow.title || !workflow.ownerId) {
    socket.emit('upload-error', { error: 'Workflow must have title and ownerId' });
    return;
  }

  const ownershipError = checkUploadOwnership(workflow, machine_id);
  if (ownershipError) {
    socket.emit('upload-error', { error: ownershipError });
    return;
  }

  messageQueue.activeMachines.add(machine_id);

  const message = {
    id: nextMessageId(),
    sender: machine_id,
    workflow,
    timestamp: Date.now(),
    deliveredTo: new Set([machine_id])
  };
  pushBounded(messageQueue.workflows, message);

  let broadcastCount = 0;
  for (const [clientId, clientSocket] of connectedClients.entries()) {
    if (clientId !== machine_id) {
      clientSocket.emit('workflows-update', { workflows: [workflow] });
      message.deliveredTo.add(clientId);
      broadcastCount++;
    }
  }

  debugLog(`[WebSocket] Workflow broadcasted to ${broadcastCount} client(s)`);

  if (message.deliveredTo.size >= messageQueue.activeMachines.size) {
    const index = messageQueue.workflows.indexOf(message);
    if (index > -1) {
      messageQueue.workflows.splice(index, 1);
    }
  }

  socket.emit('upload-success', { message_id: message.id });
}

/**
 * Handle board upload via WebSocket
 */
function handleBoardUpload(data, socket) {
  const { machine_id, board, cards } = data;

  console.log(`\n[WebSocket] Board upload from ${machine_id}: "${board?.title}"`);

  if (!board || !board.title || !board.ownerId) {
    socket.emit('upload-error', { error: 'Board must have title and ownerId' });
    return;
  }

  const ownershipError = checkUploadOwnership(board, machine_id);
  if (ownershipError) {
    socket.emit('upload-error', { error: ownershipError });
    return;
  }

  messageQueue.activeMachines.add(machine_id);

  const message = {
    id: nextMessageId(),
    sender: machine_id,
    board,
    cards: cards || [],
    timestamp: Date.now(),
    deliveredTo: new Set([machine_id])
  };
  pushBounded(messageQueue.kanbanBoards, message);

  let broadcastCount = 0;
  for (const [clientId, clientSocket] of connectedClients.entries()) {
    if (clientId !== machine_id) {
      clientSocket.emit('boards-update', { boards: [{ board, cards: cards || [] }] });
      message.deliveredTo.add(clientId);
      broadcastCount++;
    }
  }

  debugLog(`[WebSocket] Board broadcasted to ${broadcastCount} client(s)`);

  if (message.deliveredTo.size >= messageQueue.activeMachines.size) {
    const index = messageQueue.kanbanBoards.indexOf(message);
    if (index > -1) {
      messageQueue.kanbanBoards.splice(index, 1);
    }
  }

  socket.emit('upload-success', { message_id: message.id });
}

/**
 * Handle document removal via WebSocket
 */
function handleDocumentRemoval(data, socket) {
  const { machine_id, ownerId, title } = data;

  console.log(`\n[WebSocket] Document removal from ${machine_id}: "${title}"`);

  if (ownerId !== machine_id) {
    socket.emit('removal-error', { error: 'Permission denied: Only owner can remove' });
    return;
  }

  // The document is no longer shared: drop its in-memory Y.Doc, cancel any
  // pending save/eviction timers, and delete its encrypted on-disk snapshot.
  const yjsDocumentId = lookupDocumentId(ownerId, title);
  if (yjsDocumentId) {
    console.log(`[WebSocket] Purging Yjs state for removed document "${title}" (yjs id: ${yjsDocumentId})`);
    purgeDocument(yjsDocumentId);
  }
  forgetDocumentId(ownerId, title);

  const removalDoc = {
    _type: 'removal',
    ownerId,
    title
  };

  const message = {
    id: nextMessageId(),
    sender: machine_id,
    document: removalDoc,
    timestamp: Date.now(),
    deliveredTo: new Set([machine_id])
  };
  pushBounded(messageQueue.documents, message);

  let broadcastCount = 0;
  for (const [clientId, clientSocket] of connectedClients.entries()) {
    if (clientId !== machine_id) {
      clientSocket.emit('documents-update', { documents: [removalDoc] });
      message.deliveredTo.add(clientId);
      broadcastCount++;
    }
  }

  debugLog(`[WebSocket] Document removal broadcasted to ${broadcastCount} client(s)`);

  if (message.deliveredTo.size >= messageQueue.activeMachines.size) {
    const index = messageQueue.documents.indexOf(message);
    if (index > -1) {
      messageQueue.documents.splice(index, 1);
    }
  }

  socket.emit('removal-success', { message_id: message.id });
}

/**
 * Handle workflow removal via WebSocket
 */
function handleWorkflowRemoval(data, socket) {
  const { machine_id, ownerId, title } = data;

  console.log(`\n[WebSocket] Workflow removal from ${machine_id}: "${title}"`);

  if (ownerId !== machine_id) {
    socket.emit('removal-error', { error: 'Permission denied: Only owner can remove' });
    return;
  }

  const removalWorkflow = {
    _type: 'removal',
    ownerId,
    title
  };

  const message = {
    id: nextMessageId(),
    sender: machine_id,
    workflow: removalWorkflow,
    timestamp: Date.now(),
    deliveredTo: new Set([machine_id])
  };
  pushBounded(messageQueue.workflows, message);

  let broadcastCount = 0;
  for (const [clientId, clientSocket] of connectedClients.entries()) {
    if (clientId !== machine_id) {
      clientSocket.emit('workflows-update', { workflows: [removalWorkflow] });
      message.deliveredTo.add(clientId);
      broadcastCount++;
    }
  }

  debugLog(`[WebSocket] Workflow removal broadcasted to ${broadcastCount} client(s)`);

  if (message.deliveredTo.size >= messageQueue.activeMachines.size) {
    const index = messageQueue.workflows.indexOf(message);
    if (index > -1) {
      messageQueue.workflows.splice(index, 1);
    }
  }

  socket.emit('removal-success', { message_id: message.id });
}

/**
 * Handle board removal via WebSocket
 */
function handleBoardRemoval(data, socket) {
  const { machine_id, cloudBoardId, ownerId } = data;

  console.log(`\n[WebSocket] Board removal from ${machine_id}, cloudBoardId: ${cloudBoardId}`);

  if (ownerId !== machine_id) {
    socket.emit('removal-error', { error: 'Permission denied: Only owner can remove' });
    return;
  }

  const removalBoard = {
    _type: 'removal',
    cloudBoardId,
    ownerId
  };

  const message = {
    id: nextMessageId(),
    sender: machine_id,
    board: removalBoard,
    cards: [],
    timestamp: Date.now(),
    deliveredTo: new Set([machine_id])
  };
  pushBounded(messageQueue.kanbanBoards, message);

  let broadcastCount = 0;
  for (const [clientId, clientSocket] of connectedClients.entries()) {
    if (clientId !== machine_id) {
      clientSocket.emit('boards-update', { boards: [{ board: removalBoard, cards: [] }] });
      message.deliveredTo.add(clientId);
      broadcastCount++;
    }
  }

  debugLog(`[WebSocket] Board removal broadcasted to ${broadcastCount} client(s)`);

  if (message.deliveredTo.size >= messageQueue.activeMachines.size) {
    const index = messageQueue.kanbanBoards.indexOf(message);
    if (index > -1) {
      messageQueue.kanbanBoards.splice(index, 1);
    }
  }

  socket.emit('removal-success', { message_id: message.id });
}

/**
 * Handle cursor position update
 */
function handleCursorUpdate(data, socket, io, machineId) {
  const { documentId, position, selectionEnd, name } = data;

  if (!documentId || position === undefined || !machineId) {
    return;
  }

  // Initialize document cursor map if needed
  if (!documentCursors.has(documentId)) {
    documentCursors.set(documentId, new Map());
  }

  const docCursors = documentCursors.get(documentId);

  // Update cursor position and selection for this user
  docCursors.set(machineId, {
    position,
    selectionEnd: selectionEnd !== undefined ? selectionEnd : position,
    name: name || machineId,
    timestamp: Date.now()
  });

  // Scope to the document's room (the same room id the Yjs sync uses):
  // only sockets viewing this document receive its cursors, instead of
  // every connected client receiving every document's cursor traffic.
  socket.join(documentId);
  for (const [clientId, clientSocket] of connectedClients.entries()) {
    if (!clientSocket.inRoom(documentId)) continue;
    // Send all cursors for this document to the client
    const cursors = {};
    for (const [userId, cursorData] of docCursors.entries()) {
      if (userId !== clientId) {
        cursors[userId] = cursorData;
      }
    }

    clientSocket.emit('cursors-update', {
      documentId,
      cursors
    });
  }
}

/**
 * Handle cursor removal (user left document)
 */
function handleCursorRemoved(data, socket, io, machineId) {
  const { documentId } = data;

  if (!documentId || !machineId) {
    return;
  }

  if (documentCursors.has(documentId)) {
    const docCursors = documentCursors.get(documentId);
    docCursors.delete(machineId);

    // Clean up empty document maps
    if (docCursors.size === 0) {
      documentCursors.delete(documentId);
    } else {
      // Broadcast cursor removal to the other clients viewing this document
      // Use socket.id to prevent echo, not machineId (allows multiple windows on same machine)
      for (const [, clientSocket] of connectedClients.entries()) {
        clientSocket.emitToRoom(documentId, 'cursor-removed', {
          documentId,
          userId: machineId
        }, socket.id);
      }
    }
  }
}

/**
 * Clean up all cursors for a disconnected user
 */
function cleanupUserCursors(machineId) {
  for (const [documentId, docCursors] of documentCursors.entries()) {
    if (docCursors.has(machineId)) {
      docCursors.delete(machineId);

      // Notify the other users viewing this document
      for (const [clientId, clientSocket] of connectedClients.entries()) {
        if (clientId !== machineId && clientSocket.inRoom(documentId)) {
          clientSocket.emit('cursor-removed', {
            documentId,
            userId: machineId
          });
        }
      }

      // Clean up empty document maps
      if (docCursors.size === 0) {
        documentCursors.delete(documentId);
      }
    }
  }
}

/**
 * Handle real-time content update
 */
function handleContentUpdate(data, socket, io, machineId) {
  const { documentId, content, cursorPosition } = data;

  if (!documentId || content === undefined || !machineId) {
    return;
  }

  debugLog(`[WebSocket] Content update from ${machineId} (socket ${socket.id}) for doc ${documentId} (${content.length} chars)`);

  // Scope to the document's room: the full content used to be pushed to
  // EVERY connected client on every keystroke, regardless of what they had
  // open. Sender stays included (client-side components filter echoes).
  socket.join(documentId);
  let broadcastCount = 0;
  for (const [, clientSocket] of connectedClients.entries()) {
    if (!clientSocket.inRoom(documentId)) continue;
    clientSocket.emit('content-update', {
      documentId,
      content,
      cursorPosition,
      userId: machineId,
      timestamp: Date.now()
    });
    broadcastCount++;
  }

  if (broadcastCount > 0) {
    debugLog(`[WebSocket] Content broadcasted to ${broadcastCount} client(s)`);
  }
}

/**
 * Broadcast connected users list to all clients
 */
/**
 * An identity moved to another one (POST /api/reown: a device's old
 * "browser-xxxx@host" or "user@host" identity became the account's):
 * everything queued or indexed under the old id now belongs to the new
 * one, so the new identity can remove its items and peers that were
 * offline receive them with the right owner. `titles` are the document
 * titles the caller owns (the Yjs index is keyed by a hash of owner+title,
 * so it cannot be enumerated by owner). Returns what was moved.
 */
function renameIdentity(oldId, newId, titles = []) {
  const counts = { queued: 0, documentsRemapped: 0 };
  const rewrite = (item) => {
    if (!item || typeof item !== 'object') return false;
    let changed = false;
    if (item.ownerId === oldId) { item.ownerId = newId; changed = true; }
    if (item.permissions && typeof item.permissions === 'object' && Object.prototype.hasOwnProperty.call(item.permissions, oldId)) {
      item.permissions[newId] = item.permissions[oldId];
      delete item.permissions[oldId];
      changed = true;
    }
    return changed;
  };
  for (const type of ['documents', 'workflows', 'kanbanBoards', 'taskwarriorInstances']) {
    for (const message of messageQueue[type]) {
      let changed = false;
      if (message.sender === oldId) { message.sender = newId; changed = true; }
      for (const field of ['document', 'workflow', 'board', 'instance']) {
        if (rewrite(message[field])) changed = true;
      }
      if (message.deliveredTo && message.deliveredTo.has(oldId)) { message.deliveredTo.delete(oldId); message.deliveredTo.add(newId); }
      if (changed) counts.queued++;
    }
  }
  messageQueue.activeMachines.delete(oldId);
  if (displayNames.has(oldId) && !displayNames.has(newId)) displayNames.set(newId, displayNames.get(oldId));
  displayNames.delete(oldId);
  for (const title of titles) {
    if (typeof title !== 'string' || !title) continue;
    const documentId = lookupDocumentId(oldId, title);
    if (!documentId) continue;
    recordDocumentId(newId, title, documentId);
    forgetDocumentId(oldId, title);
    counts.documentsRemapped++;
  }
  return counts;
}

function broadcastConnectedUsers(io) {
  const users = Array.from(connectedClients.keys());
  // names: machine_id -> the display name each client chose (see
  // 'authenticate' / 'set-display-name'); absent for clients that sent none.
  const names = {};
  for (const id of users) {
    if (displayNames.has(id)) names[id] = displayNames.get(id);
  }
  debugLog(`[WebSocket] Broadcasting connected users list: ${users.length} user(s)`);
  io.emit('connected-users', { users, names });
}

module.exports = {
  sendPendingMessages,
  handleDocumentUpload,
  handleWorkflowUpload,
  handleBoardUpload,
  handleDocumentRemoval,
  handleWorkflowRemoval,
  handleBoardRemoval,
  handleCursorUpdate,
  handleCursorRemoved,
  cleanupUserCursors,
  handleContentUpdate,
  renameIdentity,
  broadcastConnectedUsers
};
