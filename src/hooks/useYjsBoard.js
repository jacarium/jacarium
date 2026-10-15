/**
 * React Hook for Yjs Kanban Board Synchronization
 * Provides real-time collaborative editing for Kanban boards with CRDT conflict resolution
 */

import { useState, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { getYjsProvider, cleanupYjsProvider } from '../utils/yjsProvider';
import { isWebSocketConnected, onConnectionStatusChange } from '../utils/cloudWebSocket';
import { updateCard as updateCardInDB, createCard as createCardInDB, deleteCard as deleteCardInDB, getCards, updateBoard as updateBoardInDB, cardYjsKey } from '../utils/kanban';

/**
 * Hook to synchronize a Kanban board with Yjs collaborative state
 *
 * @param {string} cloudBoardId - The cloud board ID (UUID) to sync
 * @param {object} socket - Socket.io instance
 * @param {array} initialCards - Initial cards if board is new
 * @param {object} initialBoard - Initial board data (columns, etc.)
 * @param {function} onCardsChange - Callback when cards change
 * @param {function} onBoardChange - Callback when board structure changes
 * @returns {object} - { cards, board, userInteractions, updateCard, addCard, deleteCard, moveCard, updateBoardColumns, setUserInteraction }
 */
// Pure converter from the Yjs map into a plain array (module scope so the
// sync effect can use it without ordering constraints)
function cardsMapToArray(ycards) {
  const cardsArray = [];
  ycards.forEach((cardMap, cardKey) => {
    const card = {};
    cardMap.forEach((value, key) => {
      card[key] = value;
    });
    if (card.yjsId == null) card.yjsId = cardKey;
    if (card.id == null) {
      const parsed = parseInt(cardKey, 10);
      if (!Number.isNaN(parsed)) card.id = parsed;
    }
    cardsArray.push(card);
  });
  return cardsArray;
}


export function useYjsBoard(cloudBoardId, socket, initialCards = [], initialBoard = null, onCardsChange, onBoardChange) {
  const [cards, setCards] = useState(initialCards);
  const [board, setBoard] = useState(initialBoard);
  const [userInteractions, setUserInteractions] = useState({}); // { userId: { cardId, action } }
  const [connectedUsers, setConnectedUsers] = useState([]); // Array of connected usernames
  const [isConnected, setIsConnected] = useState(false);

  const ycardsRef = useRef(null); // Y.Map of cards
  const yboardRef = useRef(null); // Y.Map of board structure
  const awarenessRef = useRef(null);
  const isLocalChangeRef = useRef(false);
  const isLocalBoardChangeRef = useRef(false);
  const currentBoardIdRef = useRef(cloudBoardId);
  const isReadyRef = useRef(false);
  const boardCardsRef = useRef(initialCards);
  const boardDataRef = useRef(initialBoard);

  // Update cards when initialCards changes
  // BUT: Only if Yjs is not yet ready. Once Yjs is initialized, it's the source of truth
  useEffect(() => {
    if (currentBoardIdRef.current === cloudBoardId && !isReadyRef.current) {
      console.log(`[useYjsBoard] Setting cards from initialCards (${initialCards.length} cards) - Yjs not ready yet`);
      setCards(initialCards);
      boardCardsRef.current = initialCards;
    } else if (currentBoardIdRef.current === cloudBoardId && isReadyRef.current) {
      console.log(`[useYjsBoard] Ignoring initialCards change - Yjs is ready and is source of truth`);
    }
  }, [initialCards, cloudBoardId]);

  // Update board when initialBoard changes
  // BUT: Only if Yjs is not yet ready. Once Yjs is initialized, it's the source of truth
  useEffect(() => {
    if (currentBoardIdRef.current === cloudBoardId && !isReadyRef.current) {
      setBoard(initialBoard);
      boardDataRef.current = initialBoard;
    }
  }, [initialBoard, cloudBoardId]);

  // Keep boardCardsRef in sync with cards state
  useEffect(() => {
    boardCardsRef.current = cards;
  }, [cards]);

  // Keep boardDataRef in sync with board state
  useEffect(() => {
    boardDataRef.current = board;
  }, [board]);

  // Monitor WebSocket connection status
  useEffect(() => {
    if (!cloudBoardId || !socket) return;

    const checkConnection = () => {
      const connected = isWebSocketConnected();
      setIsConnected(connected);
      console.log(`[useYjsBoard] WebSocket connection status: ${connected}`);
    };

    checkConnection();
    const unsubscribe = onConnectionStatusChange(checkConnection);
    return unsubscribe;
  }, [cloudBoardId, socket]);

  useEffect(() => {
    // Clear refs when board changes (board ID changed)
    if (currentBoardIdRef.current !== cloudBoardId) {
      console.log(`[useYjsBoard] Board changed from ${currentBoardIdRef.current} to ${cloudBoardId}`);
      isReadyRef.current = false;
      ycardsRef.current = null;
      yboardRef.current = null;
      awarenessRef.current = null;
      setUserInteractions({});
      currentBoardIdRef.current = cloudBoardId;
      boardCardsRef.current = initialCards;
      boardDataRef.current = initialBoard;
      // Only reset cards/board state when board actually changes
      setCards(initialCards);
      setBoard(initialBoard);
    } else {
      // Board ID hasn't changed, just update refs without resetting state
      // This happens when socket or isConnected changes
      boardCardsRef.current = initialCards;
      boardDataRef.current = initialBoard;
    }

    if (!cloudBoardId || !socket) {
      console.log(`[useYjsBoard] Skipping setup - boardId: ${!!cloudBoardId}, socket: ${!!socket}`);
      isReadyRef.current = false;
      return;
    }

    console.log(`[useYjsBoard] Setting up for board: ${cloudBoardId}, connected: ${isConnected}`);

    // Get Yjs provider
    const { ydoc, awareness, provider } = getYjsProvider(cloudBoardId, socket);
    const ycards = ydoc.getMap('cards');
    const yboard = ydoc.getMap('board');

    ycardsRef.current = ycards;
    yboardRef.current = yboard;
    awarenessRef.current = awareness;

    console.log(`[useYjsBoard] Registering whenSynced callback for ${cloudBoardId}`);

    // Initialize function - used both for sync and offline mode
    const initializeYjsDocument = () => {
      // Don't re-initialize if already ready - let Yjs CRDT handle sync
      if (isReadyRef.current) {
        console.log(`[useYjsBoard] Already initialized, skipping re-initialization (CRDT will merge)`);
        return;
      }

      if (currentBoardIdRef.current !== cloudBoardId) {
        console.log(`[useYjsBoard] Board changed during initialization, ignoring`);
        return;
      }

      // Mark as ready IMMEDIATELY to prevent race condition
      // between whenSynced callback and offline timeout
      isReadyRef.current = true;

      // Check if server had cards
      if (ycards.size > 0) {
        // Server has cards - use them
        const serverCards = cardsMapToArray(ycards);
        console.log(`[useYjsBoard] Using server cards (${serverCards.length} cards)`);
        setCards(serverCards);
        boardCardsRef.current = serverCards;

        // Sync server cards to IndexedDB so offline mode has latest content
        if (boardDataRef.current?.id) {
          const syncCardsToIndexedDB = async () => {
            try {
              const localBoardId = boardDataRef.current.id;
              const existingCards = await getCards(localBoardId);
              const yjsCardIds = new Set(serverCards.map(c => c.id));

              // Update or create cards from server
              for (const card of serverCards) {
                const existing = existingCards.find(c => c.id === card.id);
                if (existing) {
                  await updateCardInDB(card.id, { ...card, boardId: localBoardId });
                } else {
                  await createCardInDB({ ...card, boardId: localBoardId });
                }
              }

              // Delete cards that are no longer on server
              for (const existing of existingCards) {
                if (!yjsCardIds.has(existing.id)) {
                  await deleteCardInDB(existing.id);
                }
              }

              console.log(`[useYjsBoard] Saved ${serverCards.length} server cards to IndexedDB`);
            } catch (error) {
              console.error('[useYjsBoard] Error saving server cards to IndexedDB:', error);
            }
          };
          syncCardsToIndexedDB();
        }
      } else {
        // Server is empty - initialize with current cards
        const currentCards = boardCardsRef.current;
        if (currentCards && currentCards.length > 0) {
          console.log(`[useYjsBoard] Server empty, initializing with current cards (${currentCards.length} cards)`);
          ydoc.transact(() => {
            currentCards.forEach(card => {
              const cardMap = new Y.Map();
              Object.entries(card).forEach(([key, value]) => {
                if (value !== undefined && key !== 'createdAt' && key !== 'updatedAt') {
                  cardMap.set(key, value);
                }
              });
              // Key by the globally-unique yjsId, NOT the per-machine Dexie
              // integer id (see kanban.js createCard). Fall back to the id only
              // for legacy cards that predate yjsId.
              ycards.set(cardYjsKey(card), cardMap);
            });
          });
        }
      }

      // Check if server had board structure
      if (yboard.has('columns')) {
        // Server has board structure - use it
        const serverColumns = yboard.get('columns');
        const columnsArray = JSON.parse(serverColumns);
        console.log(`[useYjsBoard] Using server board structure (${columnsArray.length} columns)`);
        const updatedBoard = { ...boardDataRef.current, columns: columnsArray };
        setBoard(updatedBoard);
        boardDataRef.current = updatedBoard;

        // Sync server board structure to IndexedDB so offline mode has latest content
        if (boardDataRef.current?.id) {
          updateBoardInDB(boardDataRef.current.id, { ...boardDataRef.current, columns: columnsArray })
            .then(() => {
              console.log(`[useYjsBoard] Saved server board structure to IndexedDB (${columnsArray.length} columns)`);
            })
            .catch(error => {
              console.error('[useYjsBoard] Error saving server board structure to IndexedDB:', error);
            });
        }
      } else {
        // Server is empty - initialize with current board structure
        const currentBoard = boardDataRef.current;
        if (currentBoard && currentBoard.columns) {
          console.log(`[useYjsBoard] Server empty, initializing with current board structure (${currentBoard.columns.length} columns)`);
          ydoc.transact(() => {
            yboard.set('columns', JSON.stringify(currentBoard.columns));
          });
        }
      }

      console.log(`[useYjsBoard] ✓ Yjs READY for board ${cloudBoardId}`);
    };

    // Wait for initial sync when online
    provider.whenSynced(() => {
      console.log(`[useYjsBoard] Initial sync completed for ${cloudBoardId}`);
      initializeYjsDocument();
    });

    // Fallback if whenSynced never fires. CRITICAL: only seed local cards into
    // the Y.Doc when we have POSITIVE confirmation we're genuinely offline -
    // never on elapsed time alone. Before this guard, the flat 500ms timeout
    // fired even while online whenever sync-step2 was merely slow (cold
    // snapshot load, reconnect backoff, normal latency); ycards.size is always
    // 0 on a brand-new provider Y.Doc, so initializeYjsDocument treated that as
    // "server confirmed empty" and re-seeded ALL local cards. That resurrects
    // cards deleted server-side (a fresh ycards.set isn't covered by a prior
    // delete's tombstone) and lets stale local content win same-key merges.
    // This mirrors useYjsText.js, which already checks isWebSocketConnected()
    // before its offline fallback. When online, we do nothing here and wait for
    // whenSynced (which fires as soon as the real sync-step2 arrives - genuine
    // confirmation of the server's state, empty or not).
    const offlineInitTimeout = setTimeout(() => {
      if (isReadyRef.current) return;
      if (isWebSocketConnected()) {
        console.log(`[useYjsBoard] Sync not complete yet but WebSocket is connected - waiting for real sync-step2 (whenSynced), NOT seeding from local`);
        return;
      }
      console.log(`[useYjsBoard] Offline confirmed (WebSocket disconnected) - initializing in offline mode`);
      initializeYjsDocument();
    }, 500);

    // Listen to card changes (deep observation for nested Y.Map changes)
    const handleCardsChange = async () => {
      const newCards = cardsMapToArray(ycards);
      const changeType = isLocalChangeRef.current ? 'LOCAL' : 'REMOTE';
      console.log(`[useYjsBoard] ${changeType} cards change detected, new count: ${newCards.length}`, newCards.map(c => ({ id: c.id, title: c.title, status: c.status })));
      console.log(`[DEBUG useYjsBoard] About to call setCards with:`, newCards);

      setCards(newCards);

      console.log(`[DEBUG useYjsBoard] setCards called, cards state should update`);

      // Sync to IndexedDB (for both local and remote changes)
      if (isReadyRef.current && boardDataRef.current?.id) {
        try {
          const localBoardId = boardDataRef.current.id;
          const existingCards = await getCards(localBoardId);

          // Track which cards exist in Yjs
          const yjsCardIds = new Set(newCards.map(c => c.id));

          // Update or create cards from Yjs
          for (const card of newCards) {
            const existing = existingCards.find(c => c.id === card.id);
            if (existing) {
              // Update existing card
              await updateCardInDB(card.id, { ...card, boardId: localBoardId });
            } else {
              // Create new card
              await createCardInDB({ ...card, boardId: localBoardId });
            }
          }

          // Delete cards that are no longer in Yjs
          for (const existing of existingCards) {
            if (!yjsCardIds.has(existing.id)) {
              await deleteCardInDB(existing.id);
            }
          }

          console.log(`[useYjsBoard] Synced ${newCards.length} cards to IndexedDB`);
        } catch (error) {
          console.error('[useYjsBoard] Error syncing cards to IndexedDB:', error);
        }
      }

      // Notify parent component
      if (onCardsChange && !isLocalChangeRef.current) {
        onCardsChange(newCards);
      }

      isLocalChangeRef.current = false;
    };

    // Use observeDeep to catch changes in nested Y.Maps (card properties)
    ycards.observeDeep(handleCardsChange);
    console.log(`[useYjsBoard] Deep observer registered for cards changes`);

    // Listen to board structure changes
    const handleBoardChange = async () => {
      if (!yboard.has('columns')) return;

      const columnsJson = yboard.get('columns');
      const newColumns = JSON.parse(columnsJson);
      const changeType = isLocalBoardChangeRef.current ? 'LOCAL' : 'REMOTE';
      console.log(`[useYjsBoard] ${changeType} board structure change detected, new columns count: ${newColumns.length}`, newColumns.map(c => ({ id: c.id, title: c.title })));

      const updatedBoard = { ...boardDataRef.current, columns: newColumns };
      setBoard(updatedBoard);

      // Sync to IndexedDB (for both local and remote changes)
      if (isReadyRef.current && boardDataRef.current?.id) {
        try {
          await updateBoardInDB(boardDataRef.current.id, { ...boardDataRef.current, columns: newColumns });
          console.log(`[useYjsBoard] Synced board columns to IndexedDB`);
        } catch (error) {
          console.error('[useYjsBoard] Error syncing board to IndexedDB:', error);
        }
      }

      // Notify parent component
      if (onBoardChange && !isLocalBoardChangeRef.current) {
        onBoardChange(updatedBoard);
      }

      isLocalBoardChangeRef.current = false;
    };

    yboard.observe(handleBoardChange);
    console.log(`[useYjsBoard] Observer registered for board structure changes`);

    // Listen to awareness changes (user interactions)
    const handleAwarenessChange = () => {
      const states = awareness.getStates();
      const interactions = {};
      const users = [];

      states.forEach((state, clientId) => {
        if (clientId === awareness.clientID) return; // Skip own awareness

        // Collect all connected users
        if (state.user?.name) {
          users.push(state.user.name);
        }

        // Collect active interactions
        if (state.interaction) {
          const userId = state.user?.name || clientId;
          interactions[userId] = {
            cardId: state.interaction.cardId,
            action: state.interaction.action,
            color: state.user?.color || '#666'
          };
        }
      });

      setUserInteractions(interactions);
      setConnectedUsers(users);
    };

    awareness.on('change', handleAwarenessChange);

    // Cleanup
    return () => {
      console.log(`[useYjsBoard] Cleaning up for board ${cloudBoardId}`);
      clearTimeout(offlineInitTimeout);
      isReadyRef.current = false;
      ycards.unobserveDeep(handleCardsChange);
      yboard.unobserve(handleBoardChange);
      awareness.off('change', handleAwarenessChange);
      cleanupYjsProvider(cloudBoardId);
    };
    // Intentionally keyed only on the board identity and socket: initial*/on*Change
    // props are read as snapshots/latest-callbacks and Yjs handles reconnection,
    // so re-running on their identity changes would tear down the live doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudBoardId, socket]); // Don't re-run on connection changes - Yjs handles reconnection

  /**
   * Convert Y.Map of cards to array. The Dexie `id` and `yjsId` are read from
   * the stored fields (both are persisted into the card map), NOT derived from
   * the map key - the key is now a UUID string, so parsing it as an integer id
   * would be wrong. Legacy cards whose key IS the numeric id and which stored
   * no yjsId keep working: id comes from the stored field and yjsId falls back
   * to the key.
   */
  /**
   * Find the Yjs map key for a card identified by its Dexie `id`. Callers
   * (KanbanPage) still address cards by their local integer id; the map is
   * keyed by yjsId, so we resolve id -> key by scanning the stored `id` field.
   * Falls back to String(cardId) for legacy cards keyed directly by id.
   */
  function findCardKeyById(ycards, cardId) {
    let foundKey = null;
    ycards.forEach((cardMap, cardKey) => {
      if (foundKey != null) return;
      if (cardMap.get('id') === cardId) foundKey = cardKey;
    });
    return foundKey != null ? foundKey : String(cardId);
  }

  /**
   * Update a card
   */
  const updateCard = (cardId, updates) => {
    if (!isReadyRef.current || !ycardsRef.current) {
      console.log('[useYjsBoard] Cannot update card - not ready');
      return;
    }

    const ycards = ycardsRef.current;
    const cardKey = findCardKeyById(ycards, cardId);

    console.log(`[useYjsBoard] Updating card ${cardId} (key ${cardKey}):`, updates);

    isLocalChangeRef.current = true;

    ycards.doc.transact(() => {
      if (!ycards.has(cardKey)) {
        console.warn(`[useYjsBoard] Card ${cardId} not found in Yjs map`);
        return;
      }

      const cardMap = ycards.get(cardKey);
      Object.entries(updates).forEach(([key, value]) => {
        if (value !== undefined && key !== 'createdAt' && key !== 'updatedAt') {
          console.log(`[useYjsBoard] Setting ${key} = ${value} on card ${cardId}`);
          cardMap.set(key, value);
        }
      });
      console.log(`[useYjsBoard] Transaction complete for card ${cardId}`);
    });

    console.log(`[useYjsBoard] Update card finished, waiting for observer...`);
    // The observer will handle updating the state for both local and remote changes
  };

  /**
   * Add a new card
   */
  const addCard = (card) => {
    if (!isReadyRef.current || !ycardsRef.current) {
      console.log('[useYjsBoard] Cannot add card - not ready');
      return;
    }

    const ycards = ycardsRef.current;
    const cardKey = cardYjsKey(card);

    console.log(`[useYjsBoard] Adding card ${card.id} (key ${cardKey}):`, card);

    isLocalChangeRef.current = true;

    ycards.doc.transact(() => {
      const cardMap = new Y.Map();
      Object.entries(card).forEach(([key, value]) => {
        if (value !== undefined && key !== 'createdAt' && key !== 'updatedAt') {
          cardMap.set(key, value);
        }
      });
      ycards.set(cardKey, cardMap);
    });

    // The observer will handle updating the state for both local and remote changes
  };

  /**
   * Delete a card
   */
  const deleteCard = (cardId) => {
    if (!isReadyRef.current || !ycardsRef.current) {
      console.log('[useYjsBoard] Cannot delete card - not ready');
      return;
    }

    const ycards = ycardsRef.current;
    const cardKey = findCardKeyById(ycards, cardId);

    console.log(`[useYjsBoard] Deleting card ${cardId} (key ${cardKey})`);

    isLocalChangeRef.current = true;

    ycards.doc.transact(() => {
      ycards.delete(cardKey);
    });

    // The observer will handle updating the state for both local and remote changes
  };

  /**
   * Move a card to a new status/position
   */
  const moveCard = (cardId, newStatus, newPosition) => {
    updateCard(cardId, { status: newStatus, position: newPosition });
  };

  /**
   * Set user interaction (for awareness)
   */
  const setUserInteraction = (cardId, action) => {
    if (!awarenessRef.current) return;

    awarenessRef.current.setLocalStateField('interaction', {
      cardId,
      action // 'dragging', 'editing', etc.
    });
  };

  /**
   * Clear user interaction
   */
  const clearUserInteraction = () => {
    if (!awarenessRef.current) return;

    awarenessRef.current.setLocalStateField('interaction', null);
  };

  /**
   * Set user info (name, color)
   */
  const setUserInfo = (name, color) => {
    if (!awarenessRef.current) {
      setTimeout(() => {
        if (awarenessRef.current) {
          console.log(`[useYjsBoard] Retry: Setting user info: ${name}, ${color}`);
          awarenessRef.current.setLocalStateField('user', { name, color });
        }
      }, 100);
      return;
    }

    console.log(`[useYjsBoard] Setting user info: ${name}, ${color}`);
    awarenessRef.current.setLocalStateField('user', { name, color });
  };

  /**
   * Update board columns
   */
  const updateBoardColumns = (columns) => {
    if (!isReadyRef.current || !yboardRef.current) {
      console.log('[useYjsBoard] Cannot update board - not ready');
      return;
    }

    const yboard = yboardRef.current;

    console.log(`[useYjsBoard] Updating board columns:`, columns.map(c => ({ id: c.id, title: c.title })));

    isLocalBoardChangeRef.current = true;

    yboard.doc.transact(() => {
      const columnsJson = JSON.stringify(columns);
      console.log(`[useYjsBoard] Setting columns JSON (${columnsJson.length} chars)`);
      yboard.set('columns', columnsJson);
      console.log(`[useYjsBoard] Transaction complete for board columns`);
    });

    console.log(`[useYjsBoard] Update board columns finished, waiting for observer...`);
    // The observer will handle updating the state for both local and remote changes
  };

  // Return object - will create new reference when cards/board/userInteractions change
  return {
    cards,
    board,
    userInteractions,
    connectedUsers,
    isConnected,
    updateCard,
    addCard,
    deleteCard,
    moveCard,
    updateBoardColumns,
    setUserInteraction,
    clearUserInteraction,
    setUserInfo
  };
}
