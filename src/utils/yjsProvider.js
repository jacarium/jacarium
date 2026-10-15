/**
 * Yjs Provider for Collaborative Editing
 * Uses Socket.io as the transport layer
 */

import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';

// Store Y.Docs and providers per document
const ydocs = new Map();
const providers = new Map();
const awarenessInstances = new Map();

/**
 * Get or create a Yjs document and provider for a document ID
 */
export function getYjsProvider(documentId, socket) {
  if (!providers.has(documentId)) {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);

    const provider = new SocketIOProvider(documentId, ydoc, awareness, socket);

    ydocs.set(documentId, ydoc);
    providers.set(documentId, provider);
    awarenessInstances.set(documentId, awareness);
  }

  return {
    ydoc: ydocs.get(documentId),
    provider: providers.get(documentId),
    awareness: awarenessInstances.get(documentId)
  };
}

/**
 * Cleanup provider when leaving a document
 */
export function cleanupYjsProvider(documentId) {
  const provider = providers.get(documentId);
  if (provider) {
    provider.destroy();
    providers.delete(documentId);
    ydocs.delete(documentId);
    awarenessInstances.delete(documentId);
  }
}

/**
 * Custom Socket.IO provider for Yjs
 */
class SocketIOProvider {
  constructor(documentId, ydoc, awareness, socket) {
    this.documentId = documentId;
    this.ydoc = ydoc;
    this.awareness = awareness;
    this.socket = socket;
    this.synced = false;
    this.syncCallbacks = [];
    this.isApplyingRemoteUpdate = false; // Flag to prevent echo

    // True when the server reported (via stateLoadFailed on sync-step2) that
    // it could NOT load this document's persisted state - its "empty" doc is
    // a placeholder, not a genuinely new document. Consumers (useYjsText)
    // must not seed the server from local content while this is set.
    this.serverStateLoadFailed = false;
    this.loadFailedCallbacks = [];
    // Fired when the server reseeds a degraded document from an explicit
    // re-upload (yjs-doc-reseeded): consumers must resync from scratch.
    this.reseededCallbacks = [];

    // Bind event handlers
    this._onUpdate = this.handleUpdate.bind(this);
    this._onAwarenessUpdate = this.handleAwarenessUpdate.bind(this);
    this._onSyncStep2 = this.handleSyncStep2.bind(this);
    this._onYjsUpdate = this.handleYjsUpdate.bind(this);
    this._onYjsAwarenessUpdate = this.handleYjsAwarenessUpdate.bind(this);
    this._onDocReseeded = this.handleDocReseeded.bind(this);

    // Listen to local document changes
    this.ydoc.on('update', this._onUpdate);

    // Listen to awareness changes
    this.awareness.on('update', this._onAwarenessUpdate);

    // Listen to server messages
    this.socket.on('yjs-sync-step2', this._onSyncStep2);
    this.socket.on('yjs-update', this._onYjsUpdate);
    this.socket.on('yjs-awareness-update', this._onYjsAwarenessUpdate);
    this.socket.on('yjs-doc-reseeded', this._onDocReseeded);

    // Listen for reconnection to resync
    this._onReconnect = () => {
      // Just do a normal sync
      this.synced = false;
      this.sync();
    };
    this.socket.on('connect', this._onReconnect);

    // Start initial sync
    this.sync();
  }

  sync() {
    // Send state vector to server (sync step 1)
    const stateVector = Y.encodeStateVector(this.ydoc);
    const stateVectorB64 = this.uint8ArrayToBase64(stateVector);

    this.socket.emit('yjs-sync-step1', {
      documentId: this.documentId,
      stateVector: stateVectorB64
    });
  }

  handleSyncStep2({ documentId, update, stateLoadFailed }) {
    if (this.destroyed) return;
    if (documentId !== this.documentId) return;

    // Track the server's "I could not load this document's persisted state"
    // signal BEFORE firing whenSynced callbacks, so they can read it.
    const failed = !!stateLoadFailed;
    const failedChanged = failed !== this.serverStateLoadFailed;
    this.serverStateLoadFailed = failed;
    if (failed) {
      console.warn(`[yjsProvider] Server could not load persisted state for document ${documentId} - treating server copy as unavailable (read-only local view)`);
    }

    // Apply server's state update
    const updateArray = this.base64ToUint8Array(update);

    // Set flag to prevent echo
    this.isApplyingRemoteUpdate = true;
    Y.applyUpdate(this.ydoc, updateArray);
    this.isApplyingRemoteUpdate = false;

    this.synced = true;

    // Call sync callbacks
    this.syncCallbacks.forEach(callback => callback());
    this.syncCallbacks = [];

    if (failedChanged) {
      this.loadFailedCallbacks.forEach(callback => callback(failed));
    }
  }

  /**
   * Wait for initial sync to complete
   */
  whenSynced(callback) {
    if (this.synced) {
      callback();
    } else {
      this.syncCallbacks.push(callback);
    }
  }

  /**
   * Subscribe to changes of the server's stateLoadFailed signal.
   * Returns an unsubscribe function.
   */
  onStateLoadFailedChange(callback) {
    this.loadFailedCallbacks.push(callback);
    return () => {
      this.loadFailedCallbacks = this.loadFailedCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * Subscribe to the server-side "document was reseeded from a re-upload"
   * event. The subscriber is expected to tear this provider down and resync
   * from scratch - the local Y.Doc's history must NOT be merged into the
   * rebuilt document. Returns an unsubscribe function.
   */
  onReseeded(callback) {
    this.reseededCallbacks.push(callback);
    return () => {
      this.reseededCallbacks = this.reseededCallbacks.filter(cb => cb !== callback);
    };
  }

  handleDocReseeded({ documentId }) {
    if (this.destroyed) return;
    if (documentId !== this.documentId) return;
    console.log(`[yjsProvider] Document ${documentId} was reseeded on the server - subscribers must resync from scratch`);
    this.reseededCallbacks.forEach(callback => callback());
  }

  handleUpdate(update) {
    // Don't send updates that came from the network
    if (!this.isApplyingRemoteUpdate) {
      const updateB64 = this.uint8ArrayToBase64(update);

      this.socket.emit('yjs-update', {
        documentId: this.documentId,
        update: updateB64
      });
    }
  }

  handleYjsUpdate({ documentId, update }) {
    if (documentId !== this.documentId) return;

    // Apply update from another client
    const updateArray = this.base64ToUint8Array(update);

    // Set flag to prevent echo, then apply update
    this.isApplyingRemoteUpdate = true;
    Y.applyUpdate(this.ydoc, updateArray);
    this.isApplyingRemoteUpdate = false;
  }

  // Helper: Convert Uint8Array to base64 (handles large arrays)
  uint8ArrayToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Helper: Convert base64 to Uint8Array
  base64ToUint8Array(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  handleAwarenessUpdate({ added, updated, removed }, origin) {
    // Broadcast awareness changes to server (but not if it came from remote)
    if (origin !== 'remote') {
      const changedClients = added.concat(updated).concat(removed);

      const update = encodeAwarenessUpdate(this.awareness, changedClients);
      const updateB64 = this.uint8ArrayToBase64(update);

      this.socket.emit('yjs-awareness-update', {
        documentId: this.documentId,
        update: updateB64
      });
    }
  }

  handleYjsAwarenessUpdate({ documentId, update }) {
    if (documentId !== this.documentId) return;

    // Apply awareness update from another client (with 'remote' origin to prevent echo)
    const updateArray = this.base64ToUint8Array(update);
    applyAwarenessUpdate(this.awareness, updateArray, 'remote');
  }

  destroy() {
    // Remove Yjs event listeners
    this.ydoc.off('update', this._onUpdate);
    this.awareness.off('update', this._onAwarenessUpdate);

    // CRITICAL: Remove socket event listeners to prevent them from firing for other documents
    this.socket.off('yjs-sync-step2', this._onSyncStep2);
    this.socket.off('yjs-update', this._onYjsUpdate);
    this.socket.off('yjs-awareness-update', this._onYjsAwarenessUpdate);
    this.socket.off('yjs-doc-reseeded', this._onDocReseeded);
    this.socket.off('connect', this._onReconnect);

    // Mark as destroyed to prevent handler execution
    this.destroyed = true;
  }
}
