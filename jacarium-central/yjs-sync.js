/**
 * Yjs WebSocket Sync Module
 * Handles CRDT-based collaborative editing using Yjs
 */

const Y = require('yjs');
const { encodeStateAsUpdate, applyUpdate } = require('yjs');
const { DEBUG_LOGGING, debugLog, getIoInstance } = require('./state');
// Encrypted at-rest snapshots so documents survive eviction/restart.
// No-ops (memory-only mode) unless YJS_STORAGE_ENCRYPTION_KEY is set -
// see yjs-persistence.js for the key format and on-disk layout.
const persistence = require('./yjs-persistence');
// Who may write to a room: the owner and the identities granted Read & Write,
// as recorded from the owner's uploads (share-permissions.js).
const sharePermissions = require('./share-permissions');

// Cheap guard for socket payload fields that must be present, non-empty
// strings before we dereference/decode them (documentId, base64 blobs).
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// Store Yjs documents in memory (keyed by documentId)
const yjsDocs = new Map();

// Documents whose persisted snapshot EXISTS but could not be loaded
// (corrupted file, wrong/rotated encryption key, unreadable file, or a
// snapshot that decrypted but wasn't a valid Yjs update). Their in-memory
// Y.Doc is an EMPTY PLACEHOLDER, deliberately distinguishable from a
// genuinely new document. While a document is in this set:
//   - sync-step2 responses carry stateLoadFailed: true, so clients show
//     their local copy read-only instead of silently re-seeding the server
//     (two clients with divergent local copies re-seeding concurrently would
//     make the CRDT merge unrelated histories into garbled text);
//   - incoming yjs-updates are rejected (same reseed-race reason);
//   - snapshots are never written, so the broken file on disk - possibly
//     recoverable with the right key - is preserved, and the degraded state
//     stays sticky across eviction and restarts.
// The only way out is an explicit re-upload of the document ("Sync to
// Cloud"), which designates ONE local copy as the new ground truth - see
// reseedDegradedDocument().
const degradedDocs = new Set();

// Pending Y.Doc evictions: documentId -> setTimeout handle.
// A document is scheduled for eviction when the last client viewing it
// disconnects, and un-scheduled if a client joins the room again before the
// grace period elapses (see scheduleEviction/cancelEviction below).
const pendingEvictions = new Map();

// Grace period before an idle (nobody viewing) Y.Doc is dropped from memory.
// Same spirit as server.js's message-queue TTL / stale-game cleanup timers.
// Overridable via env so tests can use a few hundred ms instead of minutes.
const parsedGrace = parseInt(process.env.YJS_DOC_EVICTION_GRACE_MS, 10);
const DOC_EVICTION_GRACE_MS = Number.isFinite(parsedGrace) && parsedGrace >= 0
  ? parsedGrace
  : 5 * 60 * 1000;

// Pending debounced snapshot saves: documentId -> setTimeout handle.
// A save is (re)scheduled on every yjs-update and only actually hits disk
// after the document has been quiet for PERSIST_DEBOUNCE_MS - persisting on
// every update would reintroduce the exact per-keystroke cost the debug-log
// gating above was added to eliminate. Overridable via env for tests, same
// convention as YJS_DOC_EVICTION_GRACE_MS.
const pendingSaves = new Map();
const parsedDebounce = parseInt(process.env.YJS_PERSIST_DEBOUNCE_MS, 10);
const PERSIST_DEBOUNCE_MS = Number.isFinite(parsedDebounce) && parsedDebounce >= 0
  ? parsedDebounce
  : 3000;

/**
 * Persist a document's current state to its encrypted on-disk snapshot RIGHT
 * NOW, cancelling any pending debounced save (the immediate write supersedes
 * it). No-op when persistence is disabled or the doc isn't in memory.
 * Returns true if a snapshot was written.
 */
function persistDocumentNow(documentId, reason) {
  const timer = pendingSaves.get(documentId);
  if (timer) {
    clearTimeout(timer);
    pendingSaves.delete(documentId);
  }
  if (!persistence.isPersistenceEnabled()) return false;
  const ydoc = yjsDocs.get(documentId);
  if (!ydoc) return false;
  if (degradedDocs.has(documentId)) {
    // The in-memory doc is an empty placeholder for a snapshot we could not
    // load. Writing it out would overwrite the broken-but-possibly-
    // recoverable file with a valid EMPTY snapshot, silently converting
    // "known broken" into "genuinely new" - destroying both the data and the
    // signal. Skip until an explicit re-upload reseeds the document.
    debugLog(`[Yjs] Skipping snapshot write for degraded document ${documentId} (${reason}) - preserving the broken on-disk file`);
    return false;
  }
  const written = persistence.persistSnapshot(documentId, encodeStateAsUpdate(ydoc));
  if (written) {
    debugLog(`[Yjs] Persisted snapshot for document ${documentId} (${reason})`);
  }
  return written;
}

/**
 * Durability trigger #1: debounced save during active editing. Every update
 * resets the timer; the snapshot is written once after PERSIST_DEBOUNCE_MS
 * of quiet, NOT once per update.
 */
function schedulePersist(documentId) {
  if (!persistence.isPersistenceEnabled()) return;
  const existing = pendingSaves.get(documentId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingSaves.delete(documentId);
    persistDocumentNow(documentId, `debounce: ${PERSIST_DEBOUNCE_MS}ms of quiet`);
  }, PERSIST_DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  pendingSaves.set(documentId, timer);
}

/**
 * Durability trigger #4: flush every in-memory document on graceful shutdown
 * (SIGTERM/SIGINT - hooked in server.js). Returns how many were written.
 */
function flushAllDocuments(reason = 'shutdown') {
  let flushed = 0;
  for (const documentId of yjsDocs.keys()) {
    if (persistDocumentNow(documentId, reason)) flushed++;
  }
  return flushed;
}

/**
 * Get or create a Yjs document for a given documentId.
 * On a memory miss, first tries the encrypted on-disk snapshot (present when
 * the doc was evicted while idle or the server restarted); only a document
 * with no usable snapshot starts genuinely empty.
 */
function getYDoc(documentId) {
  if (!yjsDocs.has(documentId)) {
    let ydoc = new Y.Doc();
    const { snapshot, loadFailed } = persistence.loadSnapshotWithStatus(documentId);
    let degraded = loadFailed;
    if (snapshot) {
      try {
        applyUpdate(ydoc, snapshot);
        console.log(`[Yjs] Restored Y.Doc for document ${documentId} from encrypted snapshot (${snapshot.length} bytes)`);
      } catch (error) {
        // Decrypted fine (so not tampered/corrupt on disk) but not a valid
        // Yjs update - discard the possibly partially-applied doc entirely.
        // Same degraded treatment as a decrypt failure: persisted state
        // exists but cannot be loaded.
        console.error(`[Yjs] Snapshot for ${documentId} decrypted but could not be applied (${error.message}) - starting with an empty document`);
        try { ydoc.destroy(); } catch { /* ignore */ }
        ydoc = new Y.Doc();
        degraded = true;
      }
    } else if (!degraded) {
      console.log(`[Yjs] Created new Y.Doc for document: ${documentId}`);
    }
    if (degraded) {
      degradedDocs.add(documentId);
      console.error(
        `[Yjs] Document ${documentId} is DEGRADED: persisted state exists but could not be loaded. ` +
        'Clients will be told (stateLoadFailed) to show their local copy read-only; updates are ' +
        'rejected and the broken snapshot file is left untouched until an explicit re-upload reseeds it.'
      );
    } else {
      // A fresh, successfully-initialized doc supersedes any stale flag
      // (e.g. the operator fixed the key/file and the doc was re-opened).
      degradedDocs.delete(documentId);
    }
    yjsDocs.set(documentId, ydoc);
  }
  return yjsDocs.get(documentId);
}

/**
 * Purge a document completely: in-memory Y.Doc, pending save/eviction timers
 * AND its persisted snapshot. Called when a document is explicitly removed
 * from the cloud (remove-document flow) - cancelling the timers matters,
 * otherwise a pending debounced save or pre-eviction flush would immediately
 * recreate the snapshot file we just deleted.
 */
function purgeDocument(documentId) {
  cancelEviction(documentId);
  degradedDocs.delete(documentId);
  sharePermissions.forget(documentId);
  const saveTimer = pendingSaves.get(documentId);
  if (saveTimer) {
    clearTimeout(saveTimer);
    pendingSaves.delete(documentId);
  }
  const ydoc = yjsDocs.get(documentId);
  yjsDocs.delete(documentId);
  if (ydoc) {
    try {
      ydoc.destroy();
    } catch (error) {
      console.error(`[Yjs] Error destroying Y.Doc for ${documentId}:`, error.message);
    }
  }
  persistence.deleteSnapshot(documentId);
}

/**
 * Log every card in a Y.Map - only ever called when DEBUG_LOGGING is on.
 * Kept out of the hot path deliberately: iterating every card of every board
 * on every keystroke was measurable CPU spent purely on console output.
 */
function debugLogCards(cardsMap, label) {
  cardsMap.forEach((card, cardId) => {
    debugLog(`[Yjs]   ${label} ${cardId}:`, {
      id: cardId,
      title: card.get('title'),
      status: card.get('status'),
      priority: card.get('priority')
    });
  });
}

/**
 * True when nobody is currently joined to this document's room.
 * NOTE (verified empirically with two real socket.io-client connections):
 * the adapter removes a room entirely once its last member leaves, and the
 * departure is only reflected in 'disconnect' - during 'disconnecting' the
 * leaving socket is still counted as a member.
 */
function isRoomEmpty(io, documentId) {
  const room = io.sockets.adapter.rooms.get(documentId);
  return !room || room.size === 0;
}

function cancelEviction(documentId) {
  const timer = pendingEvictions.get(documentId);
  if (timer) {
    clearTimeout(timer);
    pendingEvictions.delete(documentId);
    debugLog(`[Yjs] Cancelled pending eviction for document: ${documentId}`);
  }
}

/**
 * Schedule removal of an idle document's Y.Doc from memory. Without this the
 * yjsDocs Map grows once per documentId ever seen and never shrinks.
 * The eviction only happens if the room is STILL empty when the timer fires,
 * so a brief disconnect/reconnect never costs a re-initialization.
 */
function scheduleEviction(io, documentId) {
  if (!yjsDocs.has(documentId) || pendingEvictions.has(documentId)) return;

  const timer = setTimeout(() => {
    pendingEvictions.delete(documentId);
    if (!isRoomEmpty(io, documentId)) {
      debugLog(`[Yjs] Skipping eviction of ${documentId} - clients rejoined`);
      return;
    }
    // Durability trigger #3: guaranteed flush right before the in-memory copy
    // is dropped. Normally redundant (the room-empty flush in the disconnect
    // handler already wrote this exact state), but unconditional as a final
    // safety net - rewriting an unchanged snapshot once per eviction is cheap.
    persistDocumentNow(documentId, 'pre-eviction flush');
    const ydoc = yjsDocs.get(documentId);
    yjsDocs.delete(documentId);
    if (ydoc) {
      try {
        ydoc.destroy();
      } catch (error) {
        console.error(`[Yjs] Error destroying Y.Doc for ${documentId}:`, error.message);
      }
    }
    console.log(`[Yjs] Evicted idle Y.Doc for document: ${documentId} (no viewers for ${DOC_EVICTION_GRACE_MS}ms)`);
  }, DOC_EVICTION_GRACE_MS);

  if (typeof timer.unref === 'function') timer.unref();
  pendingEvictions.set(documentId, timer);
  debugLog(`[Yjs] No clients left in document ${documentId} - eviction scheduled in ${DOC_EVICTION_GRACE_MS}ms`);
}

/**
 * Setup Yjs sync handlers for a Socket.io connection
 */
function setupYjsSync(io, socket, machineId) {
  console.log(`[Yjs] Setting up sync for machine: ${machineId}`);

  // Documents this socket has joined a room for. The client never sends an
  // explicit "opened/closed document" event, so room membership is inferred
  // from the documentId on the sync/update/awareness messages it does send.
  const joinedDocs = new Set();

  const joinDocumentRoom = (documentId) => {
    if (!documentId || joinedDocs.has(documentId)) return;
    socket.join(documentId);
    joinedDocs.add(documentId);
    // A viewer is back: don't drop this doc out from under it.
    cancelEviction(documentId);
    debugLog(`[Yjs] ${machineId} joined room for document: ${documentId}`);
  };

  // Handle sync step 1: Client sends state vector
  socket.on('yjs-sync-step1', (payload) => {
    // Validate the payload SHAPE before touching any field. A malformed or
    // version-skewed client (registration is trust-on-first-use, so this
    // needn't be malicious) could omit documentId/stateVector or send them
    // as the wrong type; the process has no uncaughtException handler, so an
    // unguarded throw in this socket callback would exit Node and take down
    // every other connected client's docs/boards/quizzes/chat.
    if (!isNonEmptyString(payload?.documentId) || !isNonEmptyString(payload?.stateVector)) {
      console.warn(`[Yjs] Rejected malformed yjs-sync-step1 from ${machineId} (bad documentId/stateVector) - ignoring`);
      return;
    }
    const { documentId, stateVector } = payload;
    debugLog(`[Yjs] Sync step 1 from ${machineId} for doc ${documentId}, state vector size: ${stateVector.length} chars (base64)`);

    joinDocumentRoom(documentId);
    const ydoc = getYDoc(documentId);

    // Log current server state BEFORE creating update (debug builds only -
    // the whole iteration is skipped when DEBUG_LOGGING is off)
    if (DEBUG_LOGGING) {
      const cardsMap = ydoc.getMap('cards');
      if (cardsMap.size > 0) {
        debugLog(`[Yjs] Server has ${cardsMap.size} cards before sync-step2:`);
        debugLogCards(cardsMap, 'Card');
      } else {
        debugLog(`[Yjs] Server has no cards for doc ${documentId}`);
      }
    }

    // Convert base64 to Uint8Array and diff against the client's state vector.
    // Even a shape-valid base64 string can decode to bytes that aren't a
    // well-formed Yjs state vector, which makes encodeStateAsUpdate throw;
    // catch it here so one bad message can't crash the server for everyone.
    let update;
    try {
      const stateVectorArray = Uint8Array.from(Buffer.from(stateVector, 'base64'));
      update = encodeStateAsUpdate(ydoc, stateVectorArray);
    } catch (error) {
      console.warn(`[Yjs] Failed to process sync-step1 from ${machineId} for doc ${documentId} (invalid state vector): ${error.message} - ignoring`);
      return;
    }

    debugLog(`[Yjs] Sending sync-step2 to ${machineId}, update size: ${update.length} bytes`);

    // Send back to client. For a degraded document the update describes an
    // EMPTY placeholder, so the response also carries stateLoadFailed: true -
    // "this emptiness is a load failure, not a new document; do not trust it
    // and do not re-seed it". Older clients simply ignore the extra field.
    const response = {
      documentId,
      update: Buffer.from(update).toString('base64')
    };
    if (degradedDocs.has(documentId)) {
      response.stateLoadFailed = true;
    }
    socket.emit('yjs-sync-step2', response);
  });

  // Handle update from client
  socket.on('yjs-update', (payload) => {
    // Validate the payload SHAPE before dereferencing anything (see the
    // sync-step1 handler above for why an unguarded throw here is fatal to
    // the whole process, not just this sender).
    if (!isNonEmptyString(payload?.documentId) || !isNonEmptyString(payload?.update)) {
      console.warn(`[Yjs] Rejected malformed yjs-update from ${machineId} (bad documentId/update) - ignoring`);
      return;
    }
    const { documentId, update } = payload;
    debugLog(`[Yjs] Received update from ${machineId} for doc ${documentId}, size: ${update.length} chars (base64)`);

    joinDocumentRoom(documentId);

    // Reject edits against a degraded document's empty placeholder. Updated
    // clients never send them (they go read-only on stateLoadFailed), but an
    // older client would try to "helpfully" re-seed the doc from its local
    // copy - and if two clients with divergent local copies did that, the
    // CRDT would merge two unrelated histories into garbled text. The doc
    // stays frozen until an explicit re-upload reseeds it.
    if (degradedDocs.has(documentId)) {
      console.warn(`[Yjs] Rejected update from ${machineId} for DEGRADED document ${documentId} - re-upload the document ("Sync Changes") to restore it`);
      return;
    }

    // Write permission: only the owner and the identities the owner granted
    // Read & Write (share-permissions.js, learned from the owner's uploads)
    // may change the document. Everyone else on the team may still read it
    // (sync-step1/2) and show a cursor (awareness), but their edits are
    // dropped here - not applied, not persisted, not broadcast - and the
    // sender is told, so its UI goes read-only and resyncs from the server.
    // A room without a record (shared before records existed) stays open
    // until the owner's next upload records it.
    const verdict = sharePermissions.canWrite(documentId, machineId);
    if (!verdict.allowed) {
      console.warn(`[Yjs] Rejected update from ${machineId} for document ${documentId}: no write permission - not applied, not broadcast`);
      socket.emit('yjs-update-rejected', {
        documentId,
        reason: 'read-only',
        message: 'You can view this document but not edit it.'
      });
      return;
    }

    const ydoc = getYDoc(documentId);

    // Log state BEFORE applying update (debug builds only)
    if (DEBUG_LOGGING) {
      const cardsMapBefore = ydoc.getMap('cards');
      debugLog(`[Yjs] Server state BEFORE applying update: ${cardsMapBefore.size} cards`);
      debugLogCards(cardsMapBefore, 'Card');
    }

    // Decode the base64 payload. A shape-valid string can still be
    // undecodable base64 or decode to bytes that aren't a well-formed Yjs
    // update (buggy/version-skewed client, corruption in transit); guard the
    // decode so it can't throw out of this callback and crash the process.
    // NOTE: we deliberately do NOT pre-validate by applying to a throwaway
    // Y.Doc here - that would add a full-update decode+integrate to EVERY
    // update on the hot path (once per keystroke), the exact per-update cost
    // the DEBUG-gated inspection below was written to avoid, and it is
    // guarded against by tests/yjs-sync-rooms-eviction.test.mjs. The real
    // applyUpdate below is try/caught instead.
    let updateArray;
    try {
      updateArray = Uint8Array.from(Buffer.from(update, 'base64'));
    } catch (error) {
      console.warn(`[Yjs] Rejected undecodable yjs-update from ${machineId} for doc ${documentId}: ${error.message} - not applied, not broadcast`);
      return;
    }

    // Inspect what's in the update by replaying it into a throwaway doc.
    // This has NO functional purpose (the real apply happens below), so the
    // entire computation - not just its output - is skipped unless debugging.
    if (DEBUG_LOGGING) {
      const tempDoc = new Y.Doc();
      applyUpdate(tempDoc, updateArray);
      const tempCards = tempDoc.getMap('cards');
      if (tempCards.size > 0) {
        debugLog(`[Yjs] Update contains ${tempCards.size} cards:`);
        debugLogCards(tempCards, 'Update card');
      } else {
        debugLog(`[Yjs] Update contains no cards (might be a delta update)`);
      }
      tempDoc.destroy();
    }

    // Apply update to server's Y.Doc, guarded so a genuinely-valid-shaped but
    // corrupt update (bad Yjs binary content) can't crash the whole process.
    // Catching AT the mutation is safer than leaning on the process-level
    // uncaughtException handler: that handler exits (taking down every other
    // client), whereas here we simply drop the one bad update and keep
    // serving. A failed apply is NOT broadcast, so peers never see it.
    // (Yjs integrates within a transaction; a mid-apply throw is a rare edge
    // for corrupt input - the update isn't relayed and the process survives.)
    try {
      applyUpdate(ydoc, updateArray);
    } catch (error) {
      console.error(`[Yjs] Failed to apply yjs-update from ${machineId} for doc ${documentId} (corrupt update content): ${error.message} - not broadcast`);
      return;
    }

    // Durability trigger #1: (re)arm the debounced snapshot save. Deliberately
    // NOT a write per update - see schedulePersist.
    schedulePersist(documentId);

    // Log state AFTER applying update (debug builds only)
    if (DEBUG_LOGGING) {
      const cardsMapAfter = ydoc.getMap('cards');
      debugLog(`[Yjs] Server state AFTER applying update: ${cardsMapAfter.size} cards`);
      debugLogCards(cardsMapAfter, 'Card');
    }

    // Broadcast to the other clients viewing THIS document only
    socket.to(documentId).emit('yjs-update', {
      documentId,
      update
    });

    debugLog(`[Yjs] Broadcasted update to other clients in document ${documentId}`);
  });

  // Handle awareness updates (cursor positions)
  socket.on('yjs-awareness-update', ({ documentId, update }) => {
    joinDocumentRoom(documentId);

    // Broadcast awareness to the other clients viewing THIS document only
    socket.to(documentId).emit('yjs-awareness-update', {
      documentId,
      update
    });
  });

  // Capture the document rooms this socket is in BEFORE socket.io removes it
  // from them ('disconnecting' fires first; by 'disconnect' socket.rooms is
  // already empty).
  let leavingDocs = [];
  socket.on('disconnecting', () => {
    leavingDocs = [...socket.rooms].filter((room) => joinedDocs.has(room));
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    console.log(`[Yjs] Client ${machineId} disconnected`);
    // Any document this socket was the last viewer of becomes a candidate for
    // eviction; the Y.Doc is kept for the grace period so a reconnect (network
    // blip, app restart) doesn't force a re-initialization.
    for (const documentId of leavingDocs) {
      if (isRoomEmpty(io, documentId)) {
        // Durability trigger #2: the room just became empty, so flush NOW -
        // don't wait out the debounce window or the eviction grace period.
        // This covers "user stops typing and immediately closes the app".
        persistDocumentNow(documentId, 'last viewer disconnected');
        scheduleEviction(io, documentId);
      }
    }
    leavingDocs = [];
  });
}

/**
 * Initialize a document with initial content
 */
function initializeDocument(documentId, initialContent) {
  const ydoc = getYDoc(documentId);
  const ytext = ydoc.getText('content');

  // Only set if empty
  if (ytext.length === 0 && initialContent) {
    ytext.insert(0, initialContent);
    schedulePersist(documentId);
    console.log(`[Yjs] Initialized document ${documentId} with content length: ${initialContent.length}`);
  }
}

/**
 * Explicit recovery path for a DEGRADED document (snapshot on disk exists but
 * could not be loaded). Called from the document upload handlers: when the
 * owner (or a write-permitted collaborator) re-uploads the document ("Sync to
 * Cloud"), that consciously designates their local copy as the new ground
 * truth, so it is safe to rebuild the Yjs doc from exactly this ONE source -
 * unlike the silent multi-client reseed race this feature exists to prevent.
 *
 * Purges the broken state (in-memory placeholder, timers, the undecryptable
 * snapshot file), rebuilds a fresh Y.Doc seeded with the uploaded content,
 * persists it immediately, and tells every client currently viewing the
 * document to throw away its provider state and resync from scratch
 * (yjs-doc-reseeded) - their old Y.Doc histories (empty placeholders, or
 * pre-failure history the rebuilt doc no longer shares) must not be merged
 * into the new document.
 *
 * No-op (returns false) for documents that are not degraded: normal uploads
 * must never clobber live CRDT state.
 */
function reseedDegradedDocument(documentId, content) {
  if (!degradedDocs.has(documentId)) return false;
  const text = typeof content === 'string' ? content : '';
  console.log(`[Yjs] Reseeding DEGRADED document ${documentId} from explicit re-upload (${text.length} chars)`);
  purgeDocument(documentId); // drops placeholder doc, timers, broken snapshot AND the degraded flag
  initializeDocument(documentId, text);
  persistDocumentNow(documentId, 'degraded document reseeded from re-upload');
  const io = getIoInstance();
  if (io) {
    io.to(documentId).emit('yjs-doc-reseeded', { documentId });
  }
  return true;
}

/**
 * Get current document content (for debugging/persistence)
 */
function getDocumentContent(documentId) {
  const ydoc = getYDoc(documentId);
  const ytext = ydoc.getText('content');
  return ytext.toString();
}

module.exports = {
  setupYjsSync,
  initializeDocument,
  getDocumentContent,
  getYDoc,
  // Cleanup on explicit cloud removal (sync-handlers.js / api-routes.js).
  purgeDocument,
  // Recovery for degraded documents on explicit re-upload (sync-handlers.js /
  // api-routes.js document upload paths).
  reseedDegradedDocument,
  // Graceful-shutdown flush (server.js SIGTERM/SIGINT handler).
  flushAllDocuments,
  // Exposed for tests/introspection only (see tests/yjs-sync-rooms-eviction.test.mjs
  // and tests/yjs-persistence.test.mjs): the live in-memory document map,
  // the degraded-document set and the timing knobs in effect.
  yjsDocs,
  degradedDocs,
  DOC_EVICTION_GRACE_MS,
  PERSIST_DEBOUNCE_MS
};
