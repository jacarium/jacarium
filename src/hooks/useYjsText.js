/**
 * React Hook for Yjs Text Synchronization
 * Provides smooth collaborative editing with CRDT conflict resolution
 */

import { useState, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { getYjsProvider, cleanupYjsProvider } from '../utils/yjsProvider';
import { isWebSocketConnected, onConnectionStatusChange } from '../utils/cloudWebSocket';
import { updateDocument } from '../utils/documents';

/**
 * Hook to synchronize a textarea with Yjs collaborative text
 *
 * @param {string} documentId - The cloud document ID (UUID) to sync
 * @param {object} socket - Socket.io instance
 * @param {object} textareaRef - Ref to the textarea element
 * @param {string} initialContent - Initial content if document is new
 * @param {function} onContentChange - Callback when content changes
 * @param {number} localDocumentId - The local IndexedDB document ID for syncing
 * @returns {object} - { content, cursors, awareness }
 */
export function useYjsText(documentId, socket, textareaRef, initialContent = '', onContentChange, localDocumentId = null) {
  const [content, setContent] = useState(initialContent);
  const [cursors, setCursors] = useState({});
  const [isConnected, setIsConnected] = useState(false);
  const [isReady, setIsReady] = useState(false); // Track if Yjs is ready for this document (STATE for re-render)
  const ytextRef = useRef(null);
  const awarenessRef = useRef(null);
  const isLocalChangeRef = useRef(false);
  const currentDocumentIdRef = useRef(documentId);
  const documentContentRef = useRef(initialContent); // Track content for THIS specific document
  const lastSyncedToYjsRef = useRef(initialContent); // Track what we last sent to Yjs
  const remoteCursorsRef = useRef({}); // Track remote cursor positions for prediction
  const secondaryTimeoutRef = useRef(null); // Track secondary fallback timeout
  const readyDocumentIdRef = useRef(null); // Track WHICH document we're ready for (prevents cross-doc contamination)
  const storeSyncTimerRef = useRef(null); // Debounce timer for the IndexedDB content mirror
  const pendingStoreContentRef = useRef(null); // Latest ytext content not yet mirrored to IndexedDB

  // Server reported it could NOT load this document's persisted state
  // (corrupted/undecryptable snapshot - stateLoadFailed on sync-step2). The
  // server's "empty" doc is a placeholder, not a new document: we must NOT
  // seed it from local content (a peer with a divergent local copy could be
  // doing the same, and the CRDT would merge unrelated histories into garbled
  // text). Instead the local IndexedDB copy stays visible, read-only, until
  // the server document is explicitly reseeded ("Sync to Cloud").
  const [serverLoadFailed, setServerLoadFailed] = useState(false);
  const serverLoadFailedRef = useRef(false); // synchronous mirror for updateContent guard
  // Bumped when the server reseeds this document from an explicit re-upload:
  // forces a full provider teardown + fresh sync (our current Y.Doc history -
  // an empty degraded placeholder, or a pre-failure history the rebuilt doc
  // no longer shares - must not be merged into the new document).
  const [providerEpoch, setProviderEpoch] = useState(0);
  // The server refused one of our edits (yjs-update-rejected): this identity
  // may read the document but not edit it (its Read & Write grant is missing
  // or was withdrawn). The editor goes read-only, updateContent is blocked,
  // and the provider is torn down for a fresh sync so the refused edit is
  // dropped and the true server state is shown. Per document.
  const [writeRejected, setWriteRejected] = useState(false);
  const writeRejectedRef = useRef(false);

  /**
   * Build the awareness 'cursor' field for a local cursor position.
   *
   * Besides the absolute indices (kept for backwards compatibility with peers
   * running older builds), this attaches Yjs RELATIVE positions (anchor/head).
   * Absolute indices are only meaningful against the exact document state the
   * sender had when broadcasting; when both users type at the same time, the
   * receiver's document contains concurrent edits the sender hadn't seen yet,
   * so the absolute index lands in the wrong place and the rendered remote
   * cursor visibly "flickers" until the peer re-broadcasts. Relative positions
   * are anchored to CRDT item IDs, so the receiver can resolve them against
   * its OWN current document state and always get the right index, regardless
   * of message timing.
   */
  const encodeCursorField = (position, selectionEnd) => {
    const field = { position, selectionEnd };
    const ytext = ytextRef.current;
    try {
      if (ytext && ytext.doc) {
        field.anchor = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, position));
        field.head = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, selectionEnd));
      }
    } catch (error) {
      // Fall back to absolute-only cursor data
      console.warn('[useYjsText] Could not encode relative cursor position:', error);
    }
    return field;
  };

  /**
   * Resolve a cursor entry's anchor/head relative positions against the
   * current local Y.Doc, returning the entry with up-to-date absolute
   * position/selectionEnd. Entries without relative data (older peers) are
   * returned unchanged.
   */
  const resolveCursorEntry = (entry) => {
    const ytext = ytextRef.current;
    if (!ytext || !ytext.doc || (!entry.anchor && !entry.head)) {
      return entry;
    }
    let { position, selectionEnd } = entry;
    try {
      if (entry.anchor) {
        const abs = Y.createAbsolutePositionFromRelativePosition(
          Y.createRelativePositionFromJSON(entry.anchor), ytext.doc);
        if (abs && abs.type === ytext) position = abs.index;
      }
      if (entry.head) {
        const abs = Y.createAbsolutePositionFromRelativePosition(
          Y.createRelativePositionFromJSON(entry.head), ytext.doc);
        if (abs && abs.type === ytext) selectionEnd = abs.index;
      }
    } catch (error) {
      console.warn('[useYjsText] Could not resolve relative cursor position:', error);
      return entry;
    }
    if (position === entry.position && selectionEnd === entry.selectionEnd) {
      return entry;
    }
    return { ...entry, position, selectionEnd };
  };

  // Update content when initialContent changes (from parent)
  // But only if we're not in the middle of switching documents
  // AND only if we haven't initialized Yjs yet for THIS document (avoid overwriting server content)
  useEffect(() => {
    if (currentDocumentIdRef.current === documentId && readyDocumentIdRef.current !== documentId) {
      console.log(`[useYjsText] Updating documentContentRef with initialContent: ${initialContent?.length || 0} chars (not ready for ${documentId} yet)`);
      setContent(initialContent);
      documentContentRef.current = initialContent; // Keep ref in sync
      lastSyncedToYjsRef.current = initialContent; // Reset baseline
    }
  }, [initialContent, documentId]);

  // Keep documentContentRef in sync with content state at all times
  // This ensures we always have the latest content, including user edits before WebSocket connects
  useEffect(() => {
    documentContentRef.current = content;
  }, [content]);

  // Monitor WebSocket connection status
  useEffect(() => {
    if (!documentId || !socket) return;

    const checkConnection = () => {
      const connected = isWebSocketConnected();
      setIsConnected(connected);
      // console.log(`[useYjsText] WebSocket connection status: ${connected}`);
    };

    // Check immediately
    checkConnection();

    // Listen for connection status changes
    const unsubscribe = onConnectionStatusChange(checkConnection);
    return unsubscribe;
  }, [documentId, socket]);

  useEffect(() => {
    // Clear refs immediately when document changes to prevent cross-contamination
    if (currentDocumentIdRef.current !== documentId) {
      console.log(`[useYjsText] Document changed from ${currentDocumentIdRef.current} to ${documentId}, clearing refs`);
      setIsReady(false); // Mark as NOT ready during transition
      readyDocumentIdRef.current = null; // Clear ready document ID
      ytextRef.current = null;
      awarenessRef.current = null;
      serverLoadFailedRef.current = false; // Failure state is per-document
      setServerLoadFailed(false);
      writeRejectedRef.current = false; // so is a refused edit
      setWriteRejected(false);
      setCursors({});
      remoteCursorsRef.current = {}; // Clear remote cursor tracking
      currentDocumentIdRef.current = documentId;
      documentContentRef.current = initialContent; // Store THIS document's content
      lastSyncedToYjsRef.current = initialContent; // Reset baseline
      setContent(initialContent); // Set to new document's content immediately
    }

    if (!documentId || !socket) {
      // Intentional teardown sync: no doc/socket means the editor must not
      // treat the CRDT as ready.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsReady(false);
      return;
    }

    // console.log(`[useYjsText] Setting up for document: ${documentId}, connected: ${isConnected}`);
    // console.log(`[useYjsText] Current content length: ${documentContentRef.current.length}`);

    // Get Yjs provider
    const { ydoc, awareness, provider } = getYjsProvider(documentId, socket);
    const ytext = ydoc.getText('content');

    ytextRef.current = ytext;
    awarenessRef.current = awareness;

    // Keep our per-document "server couldn't load this doc" flag in sync with
    // the provider. This both picks up a failure reported before this effect
    // ran and reacts to later reports (e.g. the server restarts with a
    // corrupted snapshot and the flag arrives on the reconnect resync).
    const applyLoadFailed = (failed) => {
      if (currentDocumentIdRef.current !== documentId) return;
      serverLoadFailedRef.current = failed;
      setServerLoadFailed(failed);
    };
    if (provider.serverStateLoadFailed !== serverLoadFailedRef.current) {
      applyLoadFailed(provider.serverStateLoadFailed);
    }
    const unsubscribeLoadFailed = provider.onStateLoadFailedChange(applyLoadFailed);
    const unsubscribeReseeded = provider.onReseeded(() => {
      // The server rebuilt this document from an explicit re-upload ("Sync
      // Changes"). Resync from scratch via a provider teardown/re-create: our
      // current Y.Doc's history (the empty degraded placeholder, or a
      // pre-failure history the rebuilt document no longer shares) must not
      // be merged into the new one.
      console.log(`[useYjsText] Document ${documentId} reseeded on server - tearing down provider for a fresh sync`);
      applyLoadFailed(false);
      setProviderEpoch((epoch) => epoch + 1);
    });
    const unsubscribeRejected = provider.onWriteRejected(() => {
      // No write permission: go read-only for this document and drop the
      // refused local edit by resyncing from scratch (same teardown as a
      // reseed; the fresh provider takes the server's content as truth and,
      // with the flag set, never seeds it from the local copy).
      if (currentDocumentIdRef.current !== documentId) return;
      console.warn(`[useYjsText] The server refused an edit to ${documentId} - read-only, resyncing from the server`);
      writeRejectedRef.current = true;
      setWriteRejected(true);
      setProviderEpoch((epoch) => epoch + 1);
    });

    // console.log(`[useYjsText] Registering whenSynced callback for ${documentId}`);

    // Initialize function - used both for sync and offline mode
    const initializeYjsDocument = () => {
      // Don't re-initialize if already ready FOR THIS SPECIFIC DOCUMENT
      // Check the REF (not state) because state updates are async
      if (readyDocumentIdRef.current === documentId) {
        console.log(`[useYjsText] Already initialized for ${documentId}, skipping re-initialization (CRDT will merge)`);
        return;
      }

      // Double-check we're still on this document (user might have switched)
      if (currentDocumentIdRef.current !== documentId) {
        console.log(`[useYjsText] Document changed during initialization (current: ${currentDocumentIdRef.current}, initializing: ${documentId}), ignoring`);
        return;
      }

      // Mark as ready IMMEDIATELY (both ref and state)
      // Ref is for synchronous checks, state is for re-renders
      console.log(`[useYjsText] ✓ Marking document ${documentId} as READY`);
      readyDocumentIdRef.current = documentId; // Set ref FIRST (synchronous)
      setIsReady(true); // Set state SECOND (async, triggers re-render)

      // Server couldn't load this document's persisted state: its emptiness
      // is a failure placeholder, NOT a new document. Don't take it as
      // content and - critically - don't seed it from our local copy (see
      // the serverLoadFailed comment above for the divergent-reseed hazard).
      // The textarea keeps showing the local IndexedDB copy; updateContent
      // is blocked while the flag is set, and DocumentEditor renders the
      // read-only failure banner.
      if (provider.serverStateLoadFailed) {
        console.warn(`[useYjsText] Server state load FAILED for ${documentId} - showing local copy read-only, NOT reseeding the server`);
        applyLoadFailed(true);
        lastSyncedToYjsRef.current = documentContentRef.current;
        return;
      }

      // Check if server had content. A document we may not write to is never
      // seeded from the local copy either: the server's state (even empty)
      // is what this reader is allowed to see.
      if (ytext.length > 0 || writeRejectedRef.current) {
        // Server has content - use it (it's the source of truth)
        const serverContent = ytext.toString();
        // console.log(`[useYjsText] Using server content (${serverContent.length} chars), local was ${documentContentRef.current.length} chars`);
        setContent(serverContent);
        documentContentRef.current = serverContent; // Update ref with server content
        lastSyncedToYjsRef.current = serverContent; // Set baseline to server content

        // CRITICAL: Update textarea directly with server content
        // This ensures the editor shows content immediately when opening a shared document
        if (textareaRef?.current) {
          console.log(`[useYjsText] About to update textarea - current: ${textareaRef.current.value.length}, new: ${serverContent.length}`);
          textareaRef.current.value = serverContent;
          console.log(`[useYjsText] Updated textarea with server content (${serverContent.length} chars)`);
        } else {
          console.warn(`[useYjsText] No textarea ref available to update!`);
        }

        // Sync server content to IndexedDB so offline mode has latest content
        if (localDocumentId) {
          updateDocument(localDocumentId, { content: serverContent })
            .then(() => {
              // console.log(`[useYjsText] Saved server content to IndexedDB (${serverContent.length} chars)`);
            })
            .catch(error => {
              console.error('[useYjsText] Error saving server content to IndexedDB:', error);
            });
        }
      } else {
        // Server is empty - use current content (includes any edits made before connection)
        // documentContentRef is kept in sync with content state, so it has latest value
        const currentContent = documentContentRef.current;
        const textareaValue = textareaRef?.current?.value || '';
        console.log(`[useYjsText] Server empty - currentContent length: ${currentContent?.length || 0}, initialContent: ${initialContent?.length || 0}, textarea: ${textareaValue.length} chars`);
        if (currentContent) {
          console.log(`[useYjsText] Server empty, initializing with current content (${currentContent.length} chars)`);

          // Ensure textarea has the content BEFORE we insert into Yjs
          if (textareaRef?.current && textareaRef.current.value !== currentContent) {
            console.log(`[useYjsText] WARNING: Textarea value mismatch! Fixing - textarea: ${textareaRef.current.value.length}, expected: ${currentContent.length}`);
            textareaRef.current.value = currentContent;
          }

          // CRITICAL: Mark as local change so observer doesn't treat our own insert as remote
          // This prevents duplication when:
          // 1. We start offline and connect later (server echoes back our content)
          // 2. Server doesn't persist state (fresh start each time)
          isLocalChangeRef.current = true;
          try {
            ydoc.transact(() => {
              ytext.insert(0, currentContent);
            });
          } finally {
            // Use finally to ensure flag is reset even if insert fails
            isLocalChangeRef.current = false;
          }

          lastSyncedToYjsRef.current = currentContent; // Set baseline
        } else {
          // console.log(`[useYjsText] Server empty and no local content - starting fresh`);
          lastSyncedToYjsRef.current = ''; // Set baseline to empty
        }
      }

      // console.log(`[useYjsText] ✓ Yjs READY for document ${documentId} - updates will now be synced`);
    };

    // NOTE: we deliberately do NOT capture a "server has content initially"
    // flag here. ytext is a freshly created provider Y.Doc at this point, so
    // its length is ALWAYS 0 regardless of the server's real state - branching
    // on it is what caused the duplication bug. The only trustworthy signal is
    // the real sync-step2 (provider.synced / whenSynced), read at init time.
    console.log(`[useYjsText] Setup for ${documentId} - ytext.length: ${ytext?.length || 0} (pre-sync, not the server's state), localContent: ${documentContentRef.current?.length || 0}`);

    // Wait for initial sync to complete before inserting local content
    // This prevents overwriting server content with stale local data
    provider.whenSynced(() => {
      console.log(`[useYjsText] whenSynced callback fired for ${documentId} - isReady: ${isReady}`);
      initializeYjsDocument();
    });

    // Fallback timeout for whenSynced in case it never fires.
    //
    // CRITICAL: seed local content into the Y.Doc ONLY on positive
    // confirmation we are genuinely OFFLINE - never on elapsed time while
    // connected. `serverHasContentInitially` is captured from a freshly
    // created provider Y.Doc, so it is ALWAYS false on first open regardless
    // of what the server actually holds; the old code branched on it and, when
    // connected-but-slow (cold snapshot load, reconnect backoff, normal
    // latency), took "haven't heard back yet" to mean "server is empty" and
    // seeded the full local IndexedDB copy as fresh CRDT insert ops. When the
    // real sync-step2 then arrived carrying the server's actual content, the
    // two merged and the document DUPLICATED itself for every peer (the old
    // "server echoes back our content" comment was wrong - isLocalChangeRef
    // only suppresses the local DOM echo, it does nothing at the CRDT op
    // level, so the duplicate insert still happened and synced out).
    //
    // The definitive answer about server state is provider.synced (set true in
    // handleSyncStep2, the same machinery behind stateLoadFailed): initialize
    // ONLY from whenSynced (real confirmation - empty or not) when online. When
    // online we do NOT force-seed on a timer at all; whenSynced fires as soon
    // as sync-step2 arrives, and the provider re-syncs on reconnect, so a slow
    // server just means we wait rather than corrupt the document.
    const syncFallbackTimeout = setTimeout(() => {
      const alreadyReady = readyDocumentIdRef.current === documentId;
      const socketConnected = isWebSocketConnected();
      console.log(`[useYjsText] Timeout callback (3s) - alreadyReady: ${alreadyReady}, socketConnected: ${socketConnected}, providerSynced: ${provider.synced}`);
      if (alreadyReady) return;

      if (!socketConnected) {
        // Genuinely offline - safe to initialize from the local copy so the
        // user can keep editing; the CRDT will reconcile on reconnect.
        console.log('[useYjsText] Offline confirmed (WebSocket disconnected) - initializing with local content');
        initializeYjsDocument();
      } else {
        // Online but sync-step2 hasn't arrived yet. Do NOT seed from local -
        // that is exactly the duplication bug. Wait for whenSynced, which
        // gives a definitive answer about the server's real content.
        console.log('[useYjsText] Online but not yet synced - waiting for real sync-step2 (whenSynced), NOT seeding from local');
      }
    }, 3000);

    // Listen to Yjs text changes
    const handleYTextChange = async (event) => {
      // CRITICAL: Ignore changes until initialization is complete FOR THIS DOCUMENT
      // Use REF (not state) for synchronous check to avoid race condition
      if (readyDocumentIdRef.current !== documentId) {
        console.log(`[useYjsText] Ignoring Yjs change - not ready yet (readyDocId: ${readyDocumentIdRef.current}, currentDocId: ${documentId})`);
        return;
      }

      const newContent = ytext.toString();
      const isLocal = isLocalChangeRef.current;

      // For REMOTE changes ONLY, update the DOM directly (bypass React)
      if (!isLocal) {
        if (!textareaRef?.current) {
          console.error('[COLLAB] textareaRef unavailable for remote change');
        } else {
          const textarea = textareaRef.current;
          const cursorStart = textarea.selectionStart || 0;
          const cursorEnd = textarea.selectionEnd || 0;

          // Calculate cursor offset based on delta
          let position = 0;
          let offsetStart = 0;
          let offsetEnd = 0;

          if (event?.delta) {
            event.delta.forEach(change => {
              if (change.retain !== undefined) {
                position += change.retain;
              }
              if (change.insert !== undefined) {
                const insertLength = typeof change.insert === 'string' ? change.insert.length : 1;
                if (position <= cursorStart) {
                  offsetStart += insertLength;
                  offsetEnd += insertLength;
                } else if (position < cursorEnd) {
                  offsetEnd += insertLength;
                }
                position += insertLength;
              }
              if (change.delete !== undefined) {
                if (position < cursorStart) {
                  const deleteLength = Math.min(change.delete, cursorStart - position);
                  offsetStart -= deleteLength;
                  offsetEnd -= deleteLength;
                } else if (position < cursorEnd) {
                  offsetEnd -= Math.min(change.delete, cursorEnd - position);
                }
              }
            });
          }

          // Update DOM directly (no React re-render)
          textarea.value = newContent;

          // Restore cursor with adjustment
          const adjustedStart = Math.max(0, Math.min(newContent.length, cursorStart + offsetStart));
          const adjustedEnd = Math.max(0, Math.min(newContent.length, cursorEnd + offsetEnd));
          textarea.setSelectionRange(adjustedStart, adjustedEnd);

          // CRITICAL: Broadcast adjusted cursor position to other users
          // This ensures that when Alice types, Bob's cursor appears in the correct position on Alice's screen
          if (awarenessRef.current) {
            awarenessRef.current.setLocalStateField('cursor', encodeCursorField(adjustedStart, adjustedEnd));
          }

          // CRITICAL: Update lastSyncedToYjsRef so next local edit diffs against this
          lastSyncedToYjsRef.current = newContent;
        }
      }

      // Re-resolve remote cursors that carry relative positions against the
      // just-changed document (local AND remote changes). This is what keeps a
      // peer's cursor pinned to the right spot while text shifts around it,
      // instead of waiting for that peer to re-broadcast an absolute index.
      const trackedCursors = remoteCursorsRef.current;
      if (Object.keys(trackedCursors).length > 0) {
        let cursorsChanged = false;
        const resolvedCursors = {};
        Object.entries(trackedCursors).forEach(([userId, entry]) => {
          const resolved = resolveCursorEntry(entry);
          if (resolved !== entry) cursorsChanged = true;
          resolvedCursors[userId] = resolved;
        });
        if (cursorsChanged) {
          remoteCursorsRef.current = resolvedCursors;
          setCursors(resolvedCursors);
        }
      }

      // DON'T update React state for collaborative documents - we're using uncontrolled textarea
      // The DOM is already updated directly above, and setContent would trigger a re-render that resets the textarea
      // Only update the ref for consistency
      documentContentRef.current = newContent;

      // Mirror the Yjs body into IndexedDB (only for THIS document) so that
      // everything reading the store - snapshot uploads on title/category
      // autosave, exports, the next session's initial render - sees the live
      // content instead of the doc-open-time copy.
      // NOTE: the readiness check must use readyDocumentIdRef, NOT the
      // `isReady` state: this observer is registered before the whenSynced
      // callback flips isReady, so the closure permanently captured `false`
      // and the mirror never ran (documents went stale until reopened).
      // Debounced so sustained typing costs one store write per pause, not
      // one per keystroke; the pending write is flushed on cleanup.
      if (readyDocumentIdRef.current === documentId && localDocumentId) {
        pendingStoreContentRef.current = newContent;
        if (storeSyncTimerRef.current) clearTimeout(storeSyncTimerRef.current);
        storeSyncTimerRef.current = setTimeout(async () => {
          storeSyncTimerRef.current = null;
          const pending = pendingStoreContentRef.current;
          pendingStoreContentRef.current = null;
          if (pending == null) return;
          try {
            await updateDocument(localDocumentId, { content: pending });
          } catch (error) {
            console.error('[COLLAB-ERROR] IndexedDB error:', error);
          }
        }, 400);
      }

      // Note: isLocalChangeRef is reset in updateContent() immediately after the transaction
    };

    ytext.observe(handleYTextChange);

    // Listen to awareness changes (cursors)
    const handleAwarenessChange = () => {
      const states = awareness.getStates();
      const newCursors = {};

      // console.log(`[useYjsText] Awareness changed - total states: ${states.size}, my clientID: ${awareness.clientID}`);

      states.forEach((state, clientId) => {
        // console.log(`[useYjsText] State for client ${clientId}:`, state);

        // Skip our own cursor
        if (clientId === awareness.clientID) {
          // console.log(`[useYjsText] Skipping own cursor (clientID: ${clientId})`);
          return;
        }

        if (state.cursor) {
          const userId = state.user?.name || clientId;
          // Resolve relative positions (if the peer sent them) against OUR
          // current document state - see encodeCursorField for why. The
          // anchor/head are kept on the entry so later text changes can
          // re-resolve without waiting for the peer's next broadcast.
          newCursors[userId] = resolveCursorEntry({
            position: state.cursor.position,
            selectionEnd: state.cursor.selectionEnd || state.cursor.position,
            anchor: state.cursor.anchor,
            head: state.cursor.head,
            color: state.user?.color || '#666',
            name: state.user?.name || `User ${clientId}`
          });
          // console.log(`[useYjsText] Added cursor for user: ${userId}, pos: ${state.cursor.position}`);
        } else {
          // console.log(`[useYjsText] No cursor data for client ${clientId}`);
        }
      });

      console.log('[useYjsText] Awareness change - setting cursors:', newCursors);
      remoteCursorsRef.current = newCursors; // Store for local adjustment
      setCursors(newCursors);
    };

    // console.log(`[useYjsText] Registered awareness change handler for document ${documentId}`);
    awareness.on('change', handleAwarenessChange);

    // Cleanup on unmount or when switching documents
    return () => {
      clearTimeout(syncFallbackTimeout);
      // Clear secondary fallback timeout if it exists
      if (secondaryTimeoutRef.current) {
        clearTimeout(secondaryTimeoutRef.current);
        secondaryTimeoutRef.current = null;
      }
      console.log(`[useYjsText] Cleanup for ${documentId} - clearing ready state`);
      // Flush any pending (debounced) IndexedDB content mirror so switching
      // documents never loses the last few hundred ms of typing from the store
      if (storeSyncTimerRef.current) {
        clearTimeout(storeSyncTimerRef.current);
        storeSyncTimerRef.current = null;
      }
      if (pendingStoreContentRef.current != null && localDocumentId) {
        const pending = pendingStoreContentRef.current;
        pendingStoreContentRef.current = null;
        updateDocument(localDocumentId, { content: pending }).catch((error) => {
          console.error('[COLLAB-ERROR] IndexedDB flush error:', error);
        });
      }
      setIsReady(false); // Mark as not ready during cleanup
      readyDocumentIdRef.current = null; // Clear ready document ID
      remoteCursorsRef.current = {}; // Clear remote cursor tracking
      unsubscribeLoadFailed();
      unsubscribeReseeded();
      unsubscribeRejected();
      ytext.unobserve(handleYTextChange);
      awareness.off('change', handleAwarenessChange);
      cleanupYjsProvider(documentId);
    };
    // providerEpoch: bumped on server-side reseed to force teardown + fresh sync.
    // Other referenced values are deliberately excluded: isReady would cause
    // an infinite loop (as noted), and initialContent/textareaRef are
    // captured once per document identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, socket, providerEpoch]); // Don't include isReady - would cause infinite loop

  /**
   * Update local content (called from textarea onChange)
   */
  const updateContent = (newContent, cursorPosition) => {
    // Read-only while the server can't serve this document's real state:
    // any edit would be relayed as a yjs-update and effectively re-seed the
    // broken server doc from this client. The editor UI is already read-only
    // (DocumentEditor), this is the defense-in-depth backstop.
    if (serverLoadFailedRef.current) {
      console.log('[useYjsText] updateContent blocked - server could not load this document\'s persisted state (read-only until reseeded)');
      return;
    }
    if (writeRejectedRef.current) {
      console.log('[useYjsText] updateContent blocked - the server refused this identity\'s edits (read-only)');
      return;
    }
    // Critical check: Only update if Yjs is fully ready for THIS SPECIFIC document
    if (!isReady || readyDocumentIdRef.current !== documentId || !ytextRef.current || !ytextRef.current.doc) {
      console.log('[useYjsText] updateContent blocked - isReady:', isReady, 'readyDocId:', readyDocumentIdRef.current, 'currentDocId:', documentId, 'ytext:', !!ytextRef.current, 'doc:', !!ytextRef.current?.doc);
      return;
    }
    console.log('[useYjsText] updateContent called - content length:', newContent.length, 'cursorPos:', cursorPosition);

    const ytext = ytextRef.current;

    // CRITICAL: Get current Yjs state (includes all remote updates)
    const currentYjsContent = ytext.toString();

    // Don't update if textarea content matches Yjs exactly
    if (currentYjsContent === newContent) {
      // Update baseline even if skipping (for next time)
      lastSyncedToYjsRef.current = newContent;
      return;
    }

    isLocalChangeRef.current = true;

    // Calculate delta between current Yjs state and textarea
    // This properly handles remote changes that were applied to the DOM
    // Declare variables outside transact so we can use them for cursor adjustment
    let changePosition = 0;
    let deleteCount = 0;
    let insertLength = 0;

    try {
      ytext.doc.transact(() => {
        // Find what changed using character-level diff
        let i = 0;
        const minLen = Math.min(currentYjsContent.length, newContent.length);

        // Find first difference
        while (i < minLen && currentYjsContent[i] === newContent[i]) {
          i++;
        }

        // Find last common part
        let yjsEnd = currentYjsContent.length;
        let newEnd = newContent.length;
        while (yjsEnd > i && newEnd > i &&
               currentYjsContent[yjsEnd - 1] === newContent[newEnd - 1]) {
          yjsEnd--;
          newEnd--;
        }

        // Apply delta
        changePosition = i;
        deleteCount = yjsEnd - i;
        const insertText = newContent.substring(i, newEnd);
        insertLength = insertText.length;

        if (deleteCount > 0) {
          ytext.delete(i, deleteCount);
        }
        if (insertLength > 0) {
          ytext.insert(i, insertText);
        }
      });

      // Update baseline to new content
      lastSyncedToYjsRef.current = newContent;

      // CRITICAL: Adjust remote cursors optimistically based on local change
      // This prevents cursor "lag" on the local screen
      const netChange = insertLength - deleteCount; // Net change in content length
      const currentCursors = remoteCursorsRef.current;
      const adjustedCursors = {};

      console.log('[useYjsText] Adjusting cursors - changePos:', changePosition, 'netChange:', netChange, 'currentCursors:', currentCursors);

      Object.entries(currentCursors).forEach(([userId, cursorData]) => {
        // Cursors carrying Yjs relative positions were already re-resolved
        // against the post-edit document by the ytext observer (which runs
        // synchronously at the end of the transaction above) - shifting them
        // again here would double-apply the change.
        if (cursorData.anchor || cursorData.head) {
          adjustedCursors[userId] = cursorData;
          return;
        }
        const pos = cursorData.position;
        const selEnd = cursorData.selectionEnd || pos;

        // Adjust cursor position based on change
        let newPos = pos;
        let newSelEnd = selEnd;

        if (pos > changePosition) {
          // Cursor is after the change - shift it
          newPos = Math.max(changePosition, pos + netChange);
        } else if (pos === changePosition && insertLength > 0) {
          // Cursor is at change position and we're inserting - shift it
          newPos = pos + insertLength;
        }

        if (selEnd > changePosition) {
          newSelEnd = Math.max(changePosition, selEnd + netChange);
        } else if (selEnd === changePosition && insertLength > 0) {
          newSelEnd = selEnd + insertLength;
        }

        adjustedCursors[userId] = {
          ...cursorData,
          position: newPos,
          selectionEnd: newSelEnd
        };
      });

      // Update cursors state with adjusted positions
      console.log('[useYjsText] Setting adjusted cursors:', adjustedCursors);
      remoteCursorsRef.current = adjustedCursors;
      setCursors(adjustedCursors);
    } finally {
      isLocalChangeRef.current = false;
    }

    // Update awareness with cursor position
    if (awarenessRef.current && cursorPosition !== undefined) {
      awarenessRef.current.setLocalStateField('cursor', encodeCursorField(cursorPosition, cursorPosition));
    }
  };

  /**
   * Update cursor position
   */
  const updateCursor = (position, selectionEnd) => {
    if (!awarenessRef.current) {
      console.log('[useYjsText] Cannot update cursor - awareness not ready');
      return;
    }

    awarenessRef.current.setLocalStateField('cursor', encodeCursorField(position, selectionEnd || position));
  };

  /**
   * Set user info (name, color)
   * This can be called before sync completes since it's just metadata
   */
  const setUserInfo = (name, color) => {
    if (!awarenessRef.current) {
      console.log('[useYjsText] Cannot set user info - awareness not ready, will retry...');
      // Retry after a short delay (awareness might not be set up yet)
      setTimeout(() => {
        if (awarenessRef.current) {
          // console.log(`[useYjsText] Retry: Setting user info: ${name}, ${color}`);
          awarenessRef.current.setLocalStateField('user', {
            name,
            color
          });
        }
      }, 100);
      return;
    }

    // console.log(`[useYjsText] Setting user info: ${name}, ${color}`);
    awarenessRef.current.setLocalStateField('user', {
      name,
      color
    });
  };

  return {
    content,
    cursors,
    isConnected,
    updateContent,
    updateCursor,
    setUserInfo,
    // Deliberate ref read: consumers (DocumentEditor) address the live CRDT
    // directly and cache-bust with yjsContentVersion; storing ytext in state
    // would just duplicate the mutable object identity.
    // eslint-disable-next-line react-hooks/refs
    ytext: ytextRef.current, // Expose ytext for direct manipulation
    isReady, // Expose ready state (now reactive)
    // True when the server reported it could not load this document's
    // persisted state: DocumentEditor renders the local copy read-only with
    // an explanatory banner while this is set.
    serverLoadFailed,
    // True once the server refused this identity's edit to the document (no
    // Read & Write grant): DocumentEditor renders it read-only with the
    // "shared by another team member" banner and says so once.
    writeRejected
  };
}

