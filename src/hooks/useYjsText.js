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
 * Hook that owns a live document's Y.Text: the provider's lifecycle, when
 * the text is ready (synced, or confirmed offline), the server's failure
 * and refusal states, the mirror of the text into IndexedDB, and the user's
 * name and colour in the awareness. The editor surface
 * (src/components/features/documents/codemirror/CodeMirrorSurface.js) binds
 * to the Y.Text and the awareness through y-codemirror.next once `isReady`:
 * from then on local edits, remote edits and the peers' carets are the
 * binding's; the hook only seeds the view (and the text) at initialisation.
 *
 * @param {string} documentId - The cloud document ID (UUID) to sync
 * @param {object} socket - Socket.io instance
 * @param {object} textareaRef - Ref to the editor surface (a textarea's API)
 * @param {string} initialContent - Initial content if document is new
 * @param {function} onContentChange - Callback when content changes
 * @param {number} localDocumentId - The local IndexedDB document ID for syncing
 * @returns {object} - { content, ytext, awareness, isReady, updateContent, setUserInfo, ... }
 */
export function useYjsText(documentId, socket, textareaRef, initialContent = '', onContentChange, localDocumentId = null) {
  const [content, setContent] = useState(initialContent);
  const [isConnected, setIsConnected] = useState(false);
  const [isReady, setIsReady] = useState(false); // Track if Yjs is ready for this document (STATE for re-render)
  const ytextRef = useRef(null);
  const awarenessRef = useRef(null);
  const currentDocumentIdRef = useRef(documentId);
  const documentContentRef = useRef(initialContent); // Track content for THIS specific document
  const lastSyncedToYjsRef = useRef(initialContent); // Track what we last sent to Yjs
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
      // The editor keeps showing the local IndexedDB copy; updateContent
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

        // The editor takes the server's content at once (the binding follows when it attaches)
        // This ensures the editor shows content immediately when opening a shared document
        if (textareaRef?.current) {
          console.log(`[useYjsText] About to update the editor - current: ${textareaRef.current.value.length}, new: ${serverContent.length}`);
          textareaRef.current.value = serverContent;
          console.log(`[useYjsText] Updated the editor with server content (${serverContent.length} chars)`);
        } else {
          console.warn(`[useYjsText] No editor ref available to update!`);
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

          // Ensure the editor has the content BEFORE we insert into Yjs
          if (textareaRef?.current && textareaRef.current.value !== currentContent) {
            console.log(`[useYjsText] WARNING: editor value mismatch! Fixing - editor: ${textareaRef.current.value.length}, expected: ${currentContent.length}`);
            textareaRef.current.value = currentContent;
          }

          ydoc.transact(() => {
            ytext.insert(0, currentContent);
          });

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
    const handleYTextChange = async () => {
      // CRITICAL: Ignore changes until initialization is complete FOR THIS DOCUMENT
      // Use REF (not state) for synchronous check to avoid race condition
      if (readyDocumentIdRef.current !== documentId) {
        console.log(`[useYjsText] Ignoring Yjs change - not ready yet (readyDocId: ${readyDocumentIdRef.current}, currentDocId: ${documentId})`);
        return;
      }

      const newContent = ytext.toString();
      // Remote changes reach the view through the surface's binding
      // (y-codemirror.next), which also moves the caret and the peers'
      // carets; before the binding exists the surface takes the text when
      // it binds (bindYjs). Nothing to write into the DOM here.

      // DON'T update React state for collaborative documents - the surface is bound to the Y.Text;
      // setContent would trigger a re-render for nothing
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

    };

    ytext.observe(handleYTextChange);

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
      unsubscribeLoadFailed();
      unsubscribeReseeded();
      unsubscribeRejected();
      ytext.unobserve(handleYTextChange);
      cleanupYjsProvider(documentId);
    };
    // providerEpoch: bumped on server-side reseed to force teardown + fresh sync.
    // Other referenced values are deliberately excluded: isReady would cause
    // an infinite loop (as noted), and initialContent/textareaRef are
    // captured once per document identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, socket, providerEpoch]); // Don't include isReady - would cause infinite loop

  /**
   * Push the whole new text into the Y.Text as one minimal change (what the
   * editor calls before the surface is bound; a bound surface syncs its own
   * edits and never calls this)
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

    // Don't update if the editor's content matches Yjs exactly
    if (currentYjsContent === newContent) {
      // Update baseline even if skipping (for next time)
      lastSyncedToYjsRef.current = newContent;
      return;
    }

    // the one change between the Y.Text and the new text
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
        const deleteCount = yjsEnd - i;
        const insertText = newContent.substring(i, newEnd);
        if (deleteCount > 0) {
          ytext.delete(i, deleteCount);
        }
        if (insertText.length > 0) {
          ytext.insert(i, insertText);
        }
    });

    // Update baseline to new content
    lastSyncedToYjsRef.current = newContent;
    void cursorPosition;   // the caret is the surface's; the binding publishes it
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

  // eslint-disable-next-line react-hooks/refs -- see ytext / awareness below
  return {
    content,
    isConnected,
    updateContent,
    setUserInfo,
    // Deliberate ref reads: consumers (DocumentEditor) address the live CRDT
    // directly and cache-bust with yjsContentVersion; storing ytext in state
    // would just duplicate the mutable object identity. The awareness goes
    // with it, for the CodeMirror surface's binding (remote carets).
    /* eslint-disable react-hooks/refs */
    ytext: ytextRef.current, // Expose ytext for direct manipulation
    awareness: awarenessRef.current,
    /* eslint-enable react-hooks/refs */
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

