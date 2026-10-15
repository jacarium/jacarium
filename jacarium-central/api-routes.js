/**
 * REST API routes and static game-page routes, exported as an Express
 * Router mounted at '/' by server.js (paths preserved exactly).
 * Extracted verbatim from server.js (structural refactor only; mechanical
 * changes: `app.` -> `router.`, `++messageIdCounter` -> `nextMessageId()`).
 */

const express = require('express');
const path = require('path');

const {
  connectedClients,
  messageQueue,
  pushBounded,
  nextMessageId,
  gameRegistry,
  debugLog
} = require('./state');
const {
  clientRegistry,
  verifyClientSecret,
  registerClient,
  retireClient,
  requireClientAuth,
  checkUploadOwnership,
  isEnrollmentGated,
  isPairingClosed,
  verifyEnrollmentSecret,
  checkRegistrationRateLimit,
  isAccountAuthEnabled,
} = require('./client-registry');
const { renameIdentity } = require('./sync-handlers');
// Same Yjs snapshot bookkeeping as the WebSocket handlers in
// sync-handlers.js - these HTTP routes are the client's fallback path when
// the WebSocket is down, and must keep snapshot state consistent too.
const { recordDocumentId, lookupDocumentId, forgetDocumentId } = require('./yjs-persistence');
const { purgeDocument, reseedDegradedDocument } = require('./yjs-sync');

const router = express.Router();

/**
 * The web game pages: /quiz/:gameId, /grid/:gameId, /tiles/:gameId serve
 * their page. The pages reference their script and Socket.IO's by URLs
 * relative to the page (../tiles.js), so they work both here and behind the
 * console at <console>/central/tiles/<id> (the proxy strips the prefix, this
 * server never sees it). A trailing slash would shift those relative URLs by
 * one segment: it is redirected away, relatively, so the prefix survives.
 */
function gamePage(label, file) {
  return (req, res) => {
    const { gameId } = req.params;
    if (req.path.endsWith('/')) {
      return res.redirect(`../${encodeURIComponent(gameId)}`);
    }
    console.log(`[${label}] Serving ${label.toLowerCase()} page for game: ${gameId}`);
    res.sendFile(path.join(__dirname, 'public', file));
  };
}
router.get('/quiz/:gameId', gamePage('Quiz', 'quiz.html'));
router.get('/grid/:gameId', gamePage('Grid', 'grid.html'));
router.get('/tiles/:gameId', gamePage('Tiles', 'tiles.html'));

/**
 * Health check endpoint
 */
router.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    name: 'Jacarium central server',
    version: '2.0.0',
    mode: 'websocket',
    uptime: process.uptime(),
    queued_messages: messageQueue.documents.length + messageQueue.workflows.length + messageQueue.kanbanBoards.length,
    active_machines: messageQueue.activeMachines.size,
    connected_clients: connectedClients.size,
    // signed-in users of the home server are recognised by ticket (no pairing)
    account_sign_in: isAccountAuthEnabled()
  });
});

/**
 * Register a client (trust-on-first-use pairing)
 * POST /api/register
 * Body: { machine_id }
 * Optional: X-Client-Secret header (for idempotent re-registration checks)
 *
 * - New machine_id: issues and returns a fresh secret (returned exactly once).
 *   If ENROLLMENT_SECRET is configured, the request must carry it in the
 *   X-Enrollment-Secret header (403 otherwise); if not configured,
 *   enrollment is open (trust-on-first-use) as before.
 * - Known machine_id + correct secret: confirms registration, no new secret.
 * - Known machine_id + missing/wrong secret: 403. An existing identity can
 *   never be hijacked or silently re-keyed through this endpoint.
 * Every attempt is logged with the caller's IP and rate-limited per IP.
 */
router.post('/api/register', (req, res) => {
  try {
    const { machine_id } = req.body || {};
    const presentedSecret = req.get('X-Client-Secret') || (req.body && req.body.client_secret);
    const presentedEnrollment = req.get('X-Enrollment-Secret');
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

    const limit = checkRegistrationRateLimit(ip);
    if (!limit.allowed) {
      console.log(`[Auth] ❌ Registration rate limit exceeded for ${ip} (machine_id "${machine_id}")`);
      res.set('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: `Too many registration attempts from this address. Try again in ${limit.retryAfterSeconds} seconds.`
      });
    }

    if (!machine_id || typeof machine_id !== 'string') {
      console.log(`[Auth] ❌ Registration attempt from ${ip} without machine_id`);
      return res.status(400).json({ error: 'Missing machine_id' });
    }

    const existing = clientRegistry[machine_id];
    console.log(`[Auth] Registration attempt from ${ip} for machine_id "${machine_id}" (${existing ? 'known' : 'new'}${isEnrollmentGated() ? ', enrollment gated' : ''}${isPairingClosed() ? ', pairing closed' : ''})`);

    if (!existing && isPairingClosed()) {
      // the home server vouches for its users: nothing pairs here
      console.log(`[Auth] ❌ Pairing refused for new machine_id "${machine_id}" from ${ip}: this server recognises signed-in users of its home server only`);
      return res.status(403).json({
        error: 'This central server recognises signed-in users of its home server only: sign in there (or link the desktop profile to it) to use the team features.',
        code: 'ACCOUNT_SIGN_IN_ONLY'
      });
    }

    if (!existing) {
      // First contact. With an enrollment secret configured, the caller
      // must present it before any per-machine secret is minted.
      if (isEnrollmentGated() && !verifyEnrollmentSecret(presentedEnrollment)) {
        console.log(`[Auth] ❌ Enrollment rejected for new machine_id "${machine_id}" from ${ip}: ${presentedEnrollment ? 'wrong' : 'missing'} enrollment secret`);
        return res.status(403).json({
          error: 'Enrollment secret missing or incorrect.',
          code: 'ENROLLMENT_SECRET_REQUIRED'
        });
      }
      // Issue a new secret (trust-on-first-use)
      const secret = registerClient(machine_id);
      return res.json({
        success: true,
        registered: true,
        machine_id,
        secret
      });
    }

    if (existing.retiredTo) {
      console.log(`[Auth] ❌ Registration rejected for retired machine_id "${machine_id}" from ${ip} (moved to "${existing.retiredTo}")`);
      return res.status(403).json({
        error: `This identity was moved to "${existing.retiredTo}" and retired. Sign in to that account; it owns the items now.`,
        code: 'MACHINE_ID_RETIRED',
        retired_to: existing.retiredTo
      });
    }

    if (verifyClientSecret(machine_id, presentedSecret)) {
      // Already registered, correct secret presented - idempotent success
      existing.lastSeen = Date.now();
      return res.json({
        success: true,
        registered: false,
        machine_id
      });
    }

    console.log(`[Auth] ❌ Registration rejected for already-registered machine_id "${machine_id}" from ${ip}: ${presentedSecret ? 'wrong' : 'missing'} client secret`);
    return res.status(403).json({
      error: 'This machine_id is already paired with this server under a different secret. If this device lost its pairing, ask the server admin to remove it from clients.json and pair again; if this is a different device, it must use its own machine_id.',
      code: 'MACHINE_ID_ALREADY_REGISTERED'
    });
  } catch (error) {
    console.error('[Auth] Registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/reown  (authenticated as the NEW identity)
 * Body: { machine_id, old_machine_id, old_client_secret, documents: [titles] }
 *
 * A device's previous identity (a browser's generated "browser-xxxx@host",
 * the desktop's "user@host") hands everything it owns to the identity of
 * the account it now signs in with. Proof of BOTH identities is required:
 * the new one's secret (requireClientAuth) and the old one's. Queued
 * messages and the Yjs document index move over, every connected client is
 * told (`identity-renamed`, so peers rewrite ownerId and permissions in
 * their copies), and the old identity is retired.
 */
router.post('/api/reown', requireClientAuth, (req, res) => {
  try {
    const newId = req.machineId;
    const body = req.body || {};
    const oldId = body.old_machine_id;
    const oldSecret = body.old_client_secret;
    if (!oldId || typeof oldId !== 'string') {
      return res.status(400).json({ error: 'Missing old_machine_id' });
    }
    if (oldId === newId) {
      return res.status(400).json({ error: 'The old and the new identity are the same' });
    }
    if (!clientRegistry[oldId] || !verifyClientSecret(oldId, oldSecret)) {
      console.log(`[Auth] ❌ Re-own of "${oldId}" by "${newId}" rejected: missing/invalid secret for the old identity`);
      return res.status(403).json({
        error: 'The previous identity\'s pairing secret is missing or wrong: re-owning is only possible from a device that is still paired as that identity.',
        code: 'OLD_SECRET_INVALID'
      });
    }
    const titles = Array.isArray(body.documents) ? body.documents.filter((t) => typeof t === 'string').slice(0, 5000) : [];
    const moved = renameIdentity(oldId, newId, titles);
    retireClient(oldId, newId);
    const announcement = { from: oldId, to: newId, timestamp: Date.now() };
    for (const [clientId, link] of connectedClients.entries()) {
      link.emit('identity-renamed', announcement);
      if (clientId === oldId) {
        // whoever is still connected as the old identity must come back as the new one
        for (const s of link.sockets) s.disconnect(true);
      }
    }
    console.log(`[Auth] Re-owned: "${oldId}" -> "${newId}" (${moved.queued} queued message(s), ${moved.documentsRemapped} document index entr(y/ies))`);
    res.json({ success: true, from: oldId, to: newId, ...moved });
  } catch (error) {
    console.error('[Auth] Re-own error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload document to central server (message queue)
 * POST /api/documents
 * Body: { machine_id, document }
 */
router.post('/api/documents', requireClientAuth, (req, res) => {
  try {
    const { document } = req.body;
    // Use the VERIFIED identity from requireClientAuth, not raw body input
    const machine_id = req.machineId;

    debugLog(`  📤 UPLOAD REQUEST from machine: ${machine_id}`);
    debugLog(`     Document:`, {
      title: document?.title,
      ownerId: document?.ownerId,
      inCloud: document?.inCloud,
      category: document?.category
    });

    if (!machine_id || !document) {
      console.log(`  ❌ Missing machine_id or document`);
      return res.status(400).json({ error: 'Missing machine_id or document' });
    }

    if (!document.title || !document.ownerId) {
      console.log(`  ❌ Document missing title or ownerId`);
      return res.status(400).json({ error: 'Document must have title and ownerId' });
    }

    // Security check: the payload may only claim the verified identity as
    // owner and may not smuggle a removal marker (same rule as DELETE below).
    const ownershipError = checkUploadOwnership(document, machine_id);
    if (ownershipError) {
      return res.status(403).json({ error: ownershipError });
    }

    // Remember which Yjs documentId this (ownerId, title) refers to, so a
    // later removal can delete the right encrypted snapshot.
    if (document.cloudDocumentId) {
      recordDocumentId(document.ownerId, document.title, document.cloudDocumentId);
      // Explicit re-upload of a DEGRADED document (snapshot exists but could
      // not be loaded) rebuilds its Yjs state from this uploaded copy - the
      // designated escape hatch. No-op for healthy documents.
      reseedDegradedDocument(document.cloudDocumentId, document.content);
    }

    // Track active machine
    messageQueue.activeMachines.add(machine_id);
    debugLog(`  ✓ Active machines:`, Array.from(messageQueue.activeMachines));

    // Add message to queue
    const message = {
      id: nextMessageId(),
      sender: machine_id,
      document,
      timestamp: Date.now(),
      deliveredTo: new Set([machine_id]) // Sender already has it
    };

    pushBounded(messageQueue.documents,message);

    debugLog(`  ✓ Added to queue: Message #${message.id}`);
    debugLog(`     Queue size: ${messageQueue.documents.length} documents`);
    debugLog(`     Delivered to: [${machine_id}]`);
    debugLog(`     Pending for: ${messageQueue.activeMachines.size - 1} other machine(s)`);

    res.json({
      success: true,
      message_id: message.id,
      queued_at: message.timestamp
    });
  } catch (error) {
    console.error('  ❌ Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload workflow to central server (message queue)
 * POST /api/workflows
 * Body: { machine_id, workflow }
 */
router.post('/api/workflows', requireClientAuth, (req, res) => {
  try {
    const { workflow } = req.body;
    // Use the VERIFIED identity from requireClientAuth, not raw body input
    const machine_id = req.machineId;

    if (!machine_id || !workflow) {
      return res.status(400).json({ error: 'Missing machine_id or workflow' });
    }

    if (!workflow.title || !workflow.ownerId) {
      return res.status(400).json({ error: 'Workflow must have title and ownerId' });
    }

    // Security check: only the verified identity may be claimed as owner
    const ownershipError = checkUploadOwnership(workflow, machine_id);
    if (ownershipError) {
      return res.status(403).json({ error: ownershipError });
    }

    // Track active machine
    messageQueue.activeMachines.add(machine_id);

    // Add message to queue
    const message = {
      id: nextMessageId(),
      sender: machine_id,
      workflow,
      timestamp: Date.now(),
      deliveredTo: new Set([machine_id]) // Sender already has it
    };

    pushBounded(messageQueue.workflows,message);

    console.log(`[Queue] Added workflow message #${message.id}: "${workflow.title}" from ${machine_id}`);

    res.json({
      success: true,
      message_id: message.id,
      queued_at: message.timestamp
    });
  } catch (error) {
    console.error('[Workflows] Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Poll for pending documents and workflows (message queue)
 * GET /api/pending?machine_id=xxx
 */
router.get('/api/pending', requireClientAuth, (req, res) => {
  try {
    const { machine_id } = req.query;

    debugLog(`  📥 POLL REQUEST from machine: ${machine_id}`);

    if (!machine_id) {
      console.log(`  ❌ Missing machine_id parameter`);
      return res.status(400).json({ error: 'Missing machine_id parameter' });
    }

    // Track active machine
    const wasNew = !messageQueue.activeMachines.has(machine_id);
    messageQueue.activeMachines.add(machine_id);

    if (wasNew) {
      console.log(`  ✓ New machine added to active list`);
    }
    debugLog(`  Active machines (${messageQueue.activeMachines.size}):`, Array.from(messageQueue.activeMachines));
    debugLog(`  Queue state:`, {
      documentsInQueue: messageQueue.documents.length,
      workflowsInQueue: messageQueue.workflows.length,
      kanbanBoardsInQueue: messageQueue.kanbanBoards.length,
      taskInstancesInQueue: messageQueue.taskwarriorInstances.length
    });

    // Get messages not yet delivered to this machine
    const pendingDocuments = [];
    const pendingWorkflows = [];
    const pendingKanbanBoards = [];

    // Documents
    debugLog(`  Checking ${messageQueue.documents.length} document(s) in queue...`);
    const documentsToRemove = [];
    for (let i = 0; i < messageQueue.documents.length; i++) {
      const msg = messageQueue.documents[i];

      debugLog(`    Message #${msg.id} - "${msg.document.title}"`);
      debugLog(`      Sender: ${msg.sender}`);
      debugLog(`      Delivered to: [${Array.from(msg.deliveredTo).join(', ')}]`);

      // Skip if already delivered to this machine
      if (msg.deliveredTo.has(machine_id)) {
        debugLog(`      ⏭️  Already delivered to this machine - skipping`);
        continue;
      }

      debugLog(`      ✓ New for this machine - adding to pending`);

      // Add to pending
      pendingDocuments.push(msg.document);

      // Mark as delivered
      msg.deliveredTo.add(machine_id);

      // Check if all active machines have received it
      let allDelivered = true;
      const stillPending = [];
      for (const activeMachine of messageQueue.activeMachines) {
        if (!msg.deliveredTo.has(activeMachine)) {
          allDelivered = false;
          stillPending.push(activeMachine);
        }
      }

      if (allDelivered) {
        debugLog(`      🗑️  All machines received - marking for removal`);
        documentsToRemove.push(i);
      } else {
        debugLog(`      ⏳ Still pending for: [${stillPending.join(', ')}]`);
      }
    }

    // Workflows
    const workflowsToRemove = [];
    for (let i = 0; i < messageQueue.workflows.length; i++) {
      const msg = messageQueue.workflows[i];

      // Skip if already delivered to this machine
      if (msg.deliveredTo.has(machine_id)) {
        continue;
      }

      // Add to pending
      pendingWorkflows.push(msg.workflow);

      // Mark as delivered
      msg.deliveredTo.add(machine_id);

      // Check if all active machines have received it
      let allDelivered = true;
      for (const activeMachine of messageQueue.activeMachines) {
        if (!msg.deliveredTo.has(activeMachine)) {
          allDelivered = false;
          break;
        }
      }

      // Mark for removal if delivered to all
      if (allDelivered) {
        workflowsToRemove.push(i);
      }
    }

    // Remove delivered messages (in reverse order to maintain indices)
    for (let i = documentsToRemove.length - 1; i >= 0; i--) {
      const msgId = messageQueue.documents[documentsToRemove[i]].id;
      debugLog(`[Queue] Removing fully delivered document message #${msgId}`);
      messageQueue.documents.splice(documentsToRemove[i], 1);
    }

    for (let i = workflowsToRemove.length - 1; i >= 0; i--) {
      const msgId = messageQueue.workflows[workflowsToRemove[i]].id;
      debugLog(`[Queue] Removing fully delivered workflow message #${msgId}`);
      messageQueue.workflows.splice(workflowsToRemove[i], 1);
    }

    // Kanban Boards
    const kanbanBoardsToRemove = [];
    for (let i = 0; i < messageQueue.kanbanBoards.length; i++) {
      const msg = messageQueue.kanbanBoards[i];

      // Skip if already delivered to this machine
      if (msg.deliveredTo.has(machine_id)) {
        continue;
      }

      // Add to pending
      pendingKanbanBoards.push({
        board: msg.board,
        cards: msg.cards
      });

      // Mark as delivered
      msg.deliveredTo.add(machine_id);

      // Check if all active machines have received it
      let allDelivered = true;
      for (const activeMachine of messageQueue.activeMachines) {
        if (!msg.deliveredTo.has(activeMachine)) {
          allDelivered = false;
          break;
        }
      }

      // Mark for removal if delivered to all
      if (allDelivered) {
        kanbanBoardsToRemove.push(i);
      }
    }

    // Remove delivered kanban board messages
    for (let i = kanbanBoardsToRemove.length - 1; i >= 0; i--) {
      const msgId = messageQueue.kanbanBoards[kanbanBoardsToRemove[i]].id;
      debugLog(`[Queue] Removing fully delivered kanban board message #${msgId}`);
      messageQueue.kanbanBoards.splice(kanbanBoardsToRemove[i], 1);
    }

    // Task instances
    const pendingTaskInstances = [];
    const taskInstancesToRemove = [];
    if (messageQueue.taskwarriorInstances) {
      for (let i = 0; i < messageQueue.taskwarriorInstances.length; i++) {
        const msg = messageQueue.taskwarriorInstances[i];

        // Skip if already delivered to this machine
        if (msg.deliveredTo.has(machine_id)) {
          continue;
        }

        // Add to pending
        pendingTaskInstances.push(msg.instance);

        // Mark as delivered
        msg.deliveredTo.add(machine_id);

        // Check if all active machines have received it
        let allDelivered = true;
        for (const activeMachine of messageQueue.activeMachines) {
          if (!msg.deliveredTo.has(activeMachine)) {
            allDelivered = false;
            break;
          }
        }

        // Mark for removal if delivered to all
        if (allDelivered) {
          taskInstancesToRemove.push(i);
        }
      }

      // Remove delivered task instance messages
      for (let i = taskInstancesToRemove.length - 1; i >= 0; i--) {
        const msgId = messageQueue.taskwarriorInstances[taskInstancesToRemove[i]].id;
        debugLog(`[Queue] Removing fully delivered task instance message #${msgId}`);
        messageQueue.taskwarriorInstances.splice(taskInstancesToRemove[i], 1);
      }
    }

    debugLog(`  📦 RESPONSE to ${machine_id}:`);
    debugLog(`     Documents: ${pendingDocuments.length}`);
    if (pendingDocuments.length > 0) {
      pendingDocuments.forEach(doc => {
        debugLog(`       - "${doc.title}" (owner: ${doc.ownerId})`);
      });
    }
    debugLog(`     Workflows: ${pendingWorkflows.length}`);
    if (pendingWorkflows.length > 0) {
      pendingWorkflows.forEach(wf => {
        debugLog(`       - "${wf.title}" (owner: ${wf.ownerId})`);
      });
    }
    debugLog(`     Kanban Boards: ${pendingKanbanBoards.length}`);
    if (pendingKanbanBoards.length > 0) {
      pendingKanbanBoards.forEach(kb => {
        debugLog(`       - "${kb.board.title}" (owner: ${kb.board.ownerId})`);
      });
    }
    debugLog(`     Task Instances: ${pendingTaskInstances.length}`);
    if (pendingTaskInstances.length > 0) {
      pendingTaskInstances.forEach(ti => {
        debugLog(`       - "${ti.name}" (owner: ${ti.ownerId})`);
      });
    }
    debugLog(`     Remaining in queue: ${messageQueue.documents.length} docs, ${messageQueue.workflows.length} workflows, ${messageQueue.kanbanBoards.length} boards, ${messageQueue.taskwarriorInstances?.length || 0} task instances`);

    res.json({
      documents: pendingDocuments,
      workflows: pendingWorkflows,
      boards: pendingKanbanBoards,
      taskInstances: pendingTaskInstances,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('  ❌ Poll error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete document from central server (queue removal message)
 * DELETE /api/documents/:ownerId/:title
 * Body: { machine_id }
 */
router.delete('/api/documents/:ownerId/:title', requireClientAuth, (req, res) => {
  try {
    const { ownerId, title } = req.params;
    // Use the VERIFIED identity from requireClientAuth, not raw body input
    const machine_id = req.machineId;

    // Security check: only owner can delete (machine_id is verified above)
    if (ownerId !== machine_id) {
      return res.status(403).json({ error: 'Permission denied: Only owner can delete' });
    }

    // The document is no longer shared: drop its in-memory Y.Doc and delete
    // its encrypted on-disk snapshot (same as the WebSocket removal path).
    const decodedTitle = decodeURIComponent(title);
    const yjsDocumentId = lookupDocumentId(ownerId, decodedTitle);
    if (yjsDocumentId) {
      console.log(`[Documents] Purging Yjs state for removed document "${decodedTitle}" (yjs id: ${yjsDocumentId})`);
      purgeDocument(yjsDocumentId);
    }
    forgetDocumentId(ownerId, decodedTitle);

    // Track active machine
    messageQueue.activeMachines.add(machine_id);

    // Add removal message to queue
    const removalMessage = {
      id: nextMessageId(),
      sender: machine_id,
      document: {
        _type: 'removal',
        ownerId,
        title: decodeURIComponent(title)
      },
      timestamp: Date.now(),
      deliveredTo: new Set([machine_id])
    };

    pushBounded(messageQueue.documents,removalMessage);

    console.log(`[Queue] Added document removal message #${removalMessage.id}: "${title}" from ${machine_id}`);

    res.json({
      success: true,
      message_id: removalMessage.id
    });
  } catch (error) {
    console.error('[Documents] Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete workflow from central server (queue removal message)
 * DELETE /api/workflows/:ownerId/:title
 * Body: { machine_id }
 */
router.delete('/api/workflows/:ownerId/:title', requireClientAuth, (req, res) => {
  try {
    const { ownerId, title } = req.params;
    // Use the VERIFIED identity from requireClientAuth, not raw body input
    const machine_id = req.machineId;

    // Security check: only owner can delete (machine_id is verified above)
    if (ownerId !== machine_id) {
      return res.status(403).json({ error: 'Permission denied: Only owner can delete' });
    }

    // Track active machine
    messageQueue.activeMachines.add(machine_id);

    // Add removal message to queue
    const removalMessage = {
      id: nextMessageId(),
      sender: machine_id,
      workflow: {
        _type: 'removal',
        ownerId,
        title: decodeURIComponent(title)
      },
      timestamp: Date.now(),
      deliveredTo: new Set([machine_id])
    };

    pushBounded(messageQueue.workflows,removalMessage);

    console.log(`[Queue] Added workflow removal message #${removalMessage.id}: "${title}" from ${machine_id}`);

    res.json({
      success: true,
      message_id: removalMessage.id
    });
  } catch (error) {
    console.error('[Workflows] Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload kanban board to central server (message queue)
 * POST /api/kanban/boards
 * Body: { machine_id, board, cards }
 */
router.post('/api/kanban/boards', requireClientAuth, (req, res) => {
  try {
    const { board, cards } = req.body;
    // Use the VERIFIED identity from requireClientAuth, not raw body input
    const machine_id = req.machineId;

    debugLog(`  📤 KANBAN UPLOAD REQUEST from machine: ${machine_id}`);
    debugLog(`     Board:`, {
      title: board?.title,
      ownerId: board?.ownerId,
      inCloud: board?.inCloud
    });

    if (!machine_id || !board) {
      console.log(`  ❌ Missing machine_id or board`);
      return res.status(400).json({ error: 'Missing machine_id or board' });
    }

    if (!board.title || !board.ownerId) {
      console.log(`  ❌ Board missing title or ownerId`);
      return res.status(400).json({ error: 'Board must have title and ownerId' });
    }

    // Security check: only the verified identity may be claimed as owner
    const ownershipError = checkUploadOwnership(board, machine_id);
    if (ownershipError) {
      return res.status(403).json({ error: ownershipError });
    }

    // Track active machine
    messageQueue.activeMachines.add(machine_id);
    debugLog(`  ✓ Active machines:`, Array.from(messageQueue.activeMachines));

    // Add message to queue
    const message = {
      id: nextMessageId(),
      sender: machine_id,
      board,
      cards: cards || [],
      timestamp: Date.now(),
      deliveredTo: new Set([machine_id]) // Sender already has it
    };

    pushBounded(messageQueue.kanbanBoards,message);

    debugLog(`  ✓ Added to queue: Message #${message.id}`);
    debugLog(`     Queue size: ${messageQueue.kanbanBoards.length} boards`);
    debugLog(`     Delivered to: [${machine_id}]`);
    debugLog(`     Pending for: ${messageQueue.activeMachines.size - 1} other machine(s)`);

    res.json({
      success: true,
      message_id: message.id,
      queued_at: message.timestamp
    });
  } catch (error) {
    console.error('  ❌ Kanban upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload task instance to central server (message queue)
 * POST /api/taskwarrior/instances
 * Body: { machine_id, instance }
 */
router.post('/api/taskwarrior/instances', requireClientAuth, (req, res) => {
  try {
    const { instance } = req.body;
    // Use the VERIFIED identity from requireClientAuth, not raw body input
    const machine_id = req.machineId;

    debugLog(`  📤 TASK INSTANCE UPLOAD REQUEST from machine: ${machine_id}`);
    debugLog(`     Instance:`, {
      name: instance?.name,
      ownerId: instance?.ownerId,
      inCloud: instance?.inCloud,
      category: instance?.category
    });

    if (!machine_id || !instance) {
      console.log(`  ❌ Missing machine_id or instance`);
      return res.status(400).json({ error: 'Missing machine_id or instance' });
    }

    if (!instance.name || !instance.ownerId) {
      console.log(`  ❌ Instance missing name or ownerId`);
      return res.status(400).json({ error: 'Instance must have name and ownerId' });
    }

    // Security check: only the verified identity may be claimed as owner
    const ownershipError = checkUploadOwnership(instance, machine_id);
    if (ownershipError) {
      return res.status(403).json({ error: ownershipError });
    }

    // Track active machine
    messageQueue.activeMachines.add(machine_id);
    debugLog(`  ✓ Active machines:`, Array.from(messageQueue.activeMachines));

    // Add message to queue
    const message = {
      id: nextMessageId(),
      sender: machine_id,
      instance,
      timestamp: Date.now(),
      deliveredTo: new Set([machine_id]) // Sender already has it
    };

    pushBounded(messageQueue.taskwarriorInstances,message);

    debugLog(`  ✓ Added to queue: Message #${message.id}`);
    debugLog(`     Queue size: ${messageQueue.taskwarriorInstances.length} task instances`);
    debugLog(`     Delivered to: [${machine_id}]`);
    debugLog(`     Pending for: ${messageQueue.activeMachines.size - 1} other machine(s)`);

    res.json({
      success: true,
      message_id: message.id,
      queued_at: message.timestamp
    });
  } catch (error) {
    console.error('  ❌ Task instance upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete kanban board from central server (queue removal message)
 * DELETE /api/kanban/boards/:ownerId/:title
 * Body: { machine_id }
 */
router.delete('/api/kanban/boards/:ownerId/:title', requireClientAuth, (req, res) => {
  try {
    const { ownerId, title } = req.params;
    // Use the VERIFIED identity from requireClientAuth, not raw body input
    const machine_id = req.machineId;

    // Security check: only owner can delete (machine_id is verified above)
    if (ownerId !== machine_id) {
      return res.status(403).json({ error: 'Permission denied: Only owner can delete' });
    }

    // Track active machine
    messageQueue.activeMachines.add(machine_id);

    // Add removal message to queue
    const removalMessage = {
      id: nextMessageId(),
      sender: machine_id,
      board: {
        _type: 'removal',
        ownerId,
        title: decodeURIComponent(title)
      },
      cards: [],
      timestamp: Date.now(),
      deliveredTo: new Set([machine_id])
    };

    pushBounded(messageQueue.kanbanBoards,removalMessage);

    console.log(`[Queue] Added kanban board removal message #${removalMessage.id}: "${title}" from ${machine_id}`);

    res.json({
      success: true,
      message_id: removalMessage.id
    });
  } catch (error) {
    console.error('[Kanban] Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get server statistics (admin endpoint)
 * GET /api/stats?machine_id=xxx   (X-Client-Secret required)
 *
 * Exposes process memory/uptime and queue sizes; no unauthenticated caller
 * exists, so it sits behind the same pairing auth as every other API route.
 */
router.get('/api/stats', requireClientAuth, (req, res) => {
  res.json({
    queued_documents: messageQueue.documents.length,
    queued_workflows: messageQueue.workflows.length,
    queued_kanban_boards: messageQueue.kanbanBoards.length,
    active_machines: messageQueue.activeMachines.size,
    connected_clients: connectedClients.size,
    total_messages: messageQueue.documents.length + messageQueue.workflows.length + messageQueue.kanbanBoards.length,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

/**
 * List available games
 * GET /api/games?playerId=xxx&machine_id=xxx   (X-Client-Secret required)
 *
 * Only the desktop app lists lobbies (src/utils/cloudWebSocket.js
 * fetchAvailableGames); the browser game pages join by direct link. The
 * response carries full quiz question data (answers included) and the
 * generated grid board, so it must not be readable without pairing auth.
 */
router.get('/api/games', requireClientAuth, (req, res) => {
  try {
    const { playerId } = req.query;
    debugLog(`[Games API] Request from playerId: ${playerId}`);
    debugLog(`[Games API] gameRegistry size: ${gameRegistry.size}`);

    const games = Array.from(gameRegistry.values()).map(game => {
      const wasPlayerInGame = game.players.some(p => p.id === playerId);
      const isPlayerCurrentlyInGame = game.players.some(p => p.id === playerId && p.connected);
      const connectedPlayerCount = game.players.filter(p => p.connected).length;

      return {
        gameId: game.gameId,
        mode: game.mode,
        status: game.status,
        hostId: game.hostId,
        lobbyName: game.lobbyName,
        quizType: game.quizType,
        questions: game.questions,
        selectedCategories: game.selectedCategories,
        aiGeneratedBoard: game.aiGeneratedBoard,
        playerCount: game.players.length,
        connectedPlayerCount,
        createdAt: game.createdAt,
        startedAt: game.startedAt,
        // Indicate if this player can reconnect
        canReconnect: wasPlayerInGame && !isPlayerCurrentlyInGame && game.status !== 'ended'
      };
    });

    debugLog(`[Games API] Returning ${games.length} games`);
    res.json({ games });
  } catch (error) {
    console.error('[Games API] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
