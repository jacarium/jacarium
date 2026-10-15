/**
 * Cloud WebSocket Service
 * Handles real-time communication with central server via WebSocket
 */

import { io } from 'socket.io-client';
import { getMachineId, getDisplayName, getCentralServerUrl, getCentralAuthHeaders, centralCredentials, providedCentralServer, socketTargetFor } from './cloudCentralSync';

// Upload/remove helpers below all need a live, authenticated socket.
function assertSocketConnected() {
  if (!socket || !socket.connected) {
    throw new Error('WebSocket not connected');
  }
}

let socket = null;
let isConnected = false;
let isAuthenticated = false;
let connectionStatusCallbacks = [];
let updateCallbacks = {
  documents: [],
  workflows: [],
  boards: []
};
let cursorCallbacks = [];
let contentUpdateCallbacks = [];
let chatMessageCallbacks = [];
let connectedUsersCallbacks = [];
let connectedUsersList = [];
let connectedUserNames = {}; // machine_id -> display name, from the server

// Quiz game callbacks
let quizJoinCallbacks = [];
let quizStartCallbacks = [];
let quizSubmitGuessCallbacks = [];
let quizNextQuestionCallbacks = [];
let quizEndCallbacks = [];
let quizChallengeCallbacks = [];
let quizChallengeResponseCallbacks = [];
let quizSyncPlayersCallbacks = [];
let quizAntiCheatTriggerCallbacks = [];
let quizRequestSyncCallbacks = [];
let quizSyncStateCallbacks = [];
let quizJoinRejectedCallbacks = [];
let quizStateUpdateCallbacks = [];
let quizTimerTickCallbacks = [];

// Lobby callbacks (shared between Quiz and Grid)
let lobbyNameUpdateCallbacks = [];

// Grid game callbacks
let gridJoinCallbacks = [];
let gridStartCallbacks = [];
let gridSelectTileCallbacks = [];
let gridBuzzCallbacks = [];
let gridAnswerCallbacks = [];
let gridEndCallbacks = [];
let gridSyncPlayersCallbacks = [];
let gridRequestSyncCallbacks = [];
let gridReturnToBoardCallbacks = [];
let gridStateUpdateCallbacks = [];
let gridTimerTickCallbacks = [];
let gridJoinRejectedCallbacks = [];

// Tiles game callbacks
let tilesLobbyCreatedCallbacks = [];
let tilesPlayerJoinedCallbacks = [];
let tilesPlayerLeftCallbacks = [];
let tilesGameStartedCallbacks = [];
let tilesGameStateUpdateCallbacks = [];
let tilesGameEndedCallbacks = [];

/**
 * Get WebSocket connection status
 */
export function isWebSocketConnected() {
  return isConnected && isAuthenticated;
}

/**
 * Get the socket instance (for Yjs integration)
 */
export function getSocket() {
  return socket;
}

/**
 * Register callback for connection status changes
 */
export function onConnectionStatusChange(callback) {
  connectionStatusCallbacks.push(callback);
  // Call immediately with current status
  callback({ connected: isConnected });

  return () => {
    connectionStatusCallbacks = connectionStatusCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for document updates
 */
export function onDocumentsUpdate(callback) {
  updateCallbacks.documents.push(callback);

  return () => {
    updateCallbacks.documents = updateCallbacks.documents.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for workflow updates
 */
export function onWorkflowsUpdate(callback) {
  updateCallbacks.workflows.push(callback);

  return () => {
    updateCallbacks.workflows = updateCallbacks.workflows.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for board updates
 */
export function onBoardsUpdate(callback) {
  updateCallbacks.boards.push(callback);

  return () => {
    updateCallbacks.boards = updateCallbacks.boards.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for cursor updates
 */
export function onCursorsUpdate(callback) {
  cursorCallbacks.push(callback);

  return () => {
    cursorCallbacks = cursorCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for content updates
 */
export function onContentUpdate(callback) {
  contentUpdateCallbacks.push(callback);

  return () => {
    contentUpdateCallbacks = contentUpdateCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for chat messages
 */
export function onChatMessage(callback) {
  chatMessageCallbacks.push(callback);

  return () => {
    chatMessageCallbacks = chatMessageCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for connected users updates
 */
export function onConnectedUsersUpdate(callback) {
  connectedUsersCallbacks.push(callback);

  // Call immediately with current list (and the display names the server
  // knows for them, machine_id -> name)
  callback(connectedUsersList, connectedUserNames);

  return () => {
    connectedUsersCallbacks = connectedUsersCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz join events
 */
export function onQuizJoin(callback) {
  quizJoinCallbacks.push(callback);
  return () => {
    quizJoinCallbacks = quizJoinCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz start events
 */
export function onQuizStart(callback) {
  quizStartCallbacks.push(callback);
  return () => {
    quizStartCallbacks = quizStartCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz guess submission events
 */
export function onQuizSubmitGuess(callback) {
  quizSubmitGuessCallbacks.push(callback);
  return () => {
    quizSubmitGuessCallbacks = quizSubmitGuessCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz hint request events
 */
/**
 * Register callback for Quiz next question events
 */
export function onQuizNextQuestion(callback) {
  quizNextQuestionCallbacks.push(callback);
  return () => {
    quizNextQuestionCallbacks = quizNextQuestionCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz end events
 */
export function onQuizEnd(callback) {
  quizEndCallbacks.push(callback);
  return () => {
    quizEndCallbacks = quizEndCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz challenges
 */
export function onQuizChallenge(callback) {
  quizChallengeCallbacks.push(callback);
  return () => {
    quizChallengeCallbacks = quizChallengeCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz challenge responses
 */
export function onQuizChallengeResponse(callback) {
  quizChallengeResponseCallbacks.push(callback);
  return () => {
    quizChallengeResponseCallbacks = quizChallengeResponseCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz player sync
 */
export function onQuizSyncPlayers(callback) {
  quizSyncPlayersCallbacks.push(callback);
  return () => {
    quizSyncPlayersCallbacks = quizSyncPlayersCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz anti-cheat trigger
 */
export function onQuizAntiCheatTrigger(callback) {
  quizAntiCheatTriggerCallbacks.push(callback);
  return () => {
    quizAntiCheatTriggerCallbacks = quizAntiCheatTriggerCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz sync request events
 */
export function onQuizRequestSync(callback) {
  quizRequestSyncCallbacks.push(callback);
  return () => {
    quizRequestSyncCallbacks = quizRequestSyncCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz sync state events (response to sync request)
 */
export function onQuizSyncState(callback) {
  quizSyncStateCallbacks.push(callback);
  return () => {
    quizSyncStateCallbacks = quizSyncStateCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz join rejected events
 */
export function onQuizJoinRejected(callback) {
  quizJoinRejectedCallbacks.push(callback);
  return () => {
    quizJoinRejectedCallbacks = quizJoinRejectedCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Quiz state update events (server-authoritative)
 */
export function onQuizStateUpdate(callback) {
  quizStateUpdateCallbacks.push(callback);
  return () => {
    quizStateUpdateCallbacks = quizStateUpdateCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for lightweight per-second Quiz countdown ticks
 * ({ gameId, timeRemaining, timestamp })
 */
export function onQuizTimerTick(callback) {
  quizTimerTickCallbacks.push(callback);
  return () => {
    quizTimerTickCallbacks = quizTimerTickCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for lobby name update events (Quiz and Grid)
 */
export function onLobbyNameUpdate(callback) {
  lobbyNameUpdateCallbacks.push(callback);
  return () => {
    lobbyNameUpdateCallbacks = lobbyNameUpdateCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Grid join events
 */
export function onGridJoin(callback) {
  gridJoinCallbacks.push(callback);
  return () => {
    gridJoinCallbacks = gridJoinCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Grid start events
 */
export function onGridStart(callback) {
  gridStartCallbacks.push(callback);
  return () => {
    gridStartCallbacks = gridStartCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Grid tile selection events
 */
export function onGridSelectTile(callback) {
  gridSelectTileCallbacks.push(callback);
  return () => {
    gridSelectTileCallbacks = gridSelectTileCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Grid buzz events
 */
export function onGridBuzz(callback) {
  gridBuzzCallbacks.push(callback);
  return () => {
    gridBuzzCallbacks = gridBuzzCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Grid answer events
 */
export function onGridAnswer(callback) {
  gridAnswerCallbacks.push(callback);
  return () => {
    gridAnswerCallbacks = gridAnswerCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Grid end events
 */
export function onGridEnd(callback) {
  gridEndCallbacks.push(callback);
  return () => {
    gridEndCallbacks = gridEndCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Grid player sync
 */
export function onGridSyncPlayers(callback) {
  gridSyncPlayersCallbacks.push(callback);
  return () => {
    gridSyncPlayersCallbacks = gridSyncPlayersCallbacks.filter(cb => cb !== callback);
  };
}

export function onGridRequestSync(callback) {
  gridRequestSyncCallbacks.push(callback);
  return () => {
    gridRequestSyncCallbacks = gridRequestSyncCallbacks.filter(cb => cb !== callback);
  };
}

export function onGridReturnToBoard(callback) {
  gridReturnToBoardCallbacks.push(callback);
  return () => {
    gridReturnToBoardCallbacks = gridReturnToBoardCallbacks.filter(cb => cb !== callback);
  };
}

export function onGridStateUpdate(callback) {
  gridStateUpdateCallbacks.push(callback);
  return () => {
    gridStateUpdateCallbacks = gridStateUpdateCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for lightweight per-second Grid countdown ticks
 * ({ gameId, gameTimeRemaining, questionTimeRemaining, serverTime })
 */
export function onGridTimerTick(callback) {
  gridTimerTickCallbacks.push(callback);
  return () => {
    gridTimerTickCallbacks = gridTimerTickCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Grid join rejected events
 */
export function onGridJoinRejected(callback) {
  gridJoinRejectedCallbacks.push(callback);
  return () => {
    gridJoinRejectedCallbacks = gridJoinRejectedCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Get current list of connected users
 */
export function getConnectedUsers() {
  return connectedUsersList;
}

/**
 * Notify all connection status listeners
 */
function notifyConnectionStatus(connected) {
  isConnected = connected;
  connectionStatusCallbacks.forEach(callback => {
    try {
      callback({ connected });
    } catch (error) {
      console.error('[WebSocket] Error in connection status callback:', error);
    }
  });
}

/**
 * Connect to WebSocket server
 */
let connectInFlight = null;

export async function connectWebSocket() {
  // Registration and machine-id lookups happen before the socket exists, so
  // two callers arriving together (two pages mounting) would otherwise both
  // pass the "already connected" check and open two managers.
  if (connectInFlight) {
    return connectInFlight;
  }
  connectInFlight = connectWebSocketNow().finally(() => {
    connectInFlight = null;
  });
  return connectInFlight;
}

async function connectWebSocketNow() {
  // the home server may provide the central server (then its URL is derived)
  try { await providedCentralServer(); } catch { /* no home server answer */ }
  const serverUrl = getCentralServerUrl();
  if (!serverUrl) {
    console.log('[WebSocket] No central server (not signed in to / linked with a home server that provides one)');
    return false;
  }

  if (socket) {
    // Either connected, or a connection is in flight / being retried by
    // Socket.IO's own reconnection - never open a second manager.
    console.log(socket.connected ? '[WebSocket] Already connected' : '[WebSocket] Connection already in progress');
    return true;
  }

  try {
    const machineId = await getMachineId();
    // The label the server shows teammates for us (chat, connected users);
    // the identity itself is the verified machine_id.
    const displayName = await getDisplayName();

    // What proves our identity: a ticket of the home server (the central
    // server recognises signed-in users of it, nothing is paired). Fetched
    // again at every (re)connect since a ticket expires.
    await centralCredentials(serverUrl);

    console.log('[WebSocket] Connecting to:', serverUrl);
    console.log('[WebSocket] URL type:', typeof serverUrl);
    console.log('[WebSocket] URL length:', serverUrl.length);

    // Parse URL to ensure proper format
    let parsedUrl;
    try {
      parsedUrl = new URL(serverUrl);
      console.log('[WebSocket] Parsed URL:', {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        href: parsedUrl.href
      });
    } catch (e) {
      console.error('[WebSocket] URL parsing error:', e);
      throw new Error('Invalid server URL');
    }

    // Create socket connection (the engine path lives under the server
    // URL's own path, e.g. /central/socket.io behind the home server)
    const target = socketTargetFor(serverUrl);
    socket = io(target.url, {
      path: target.path,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      // Timeout configuration to match server
      timeout: 20000,           // Connection timeout
      upgrade: true,            // Allow upgrade from polling to websocket
      rememberUpgrade: true,    // Remember the upgrade
      forceNew: false          // Reuse existing connection if available
    });

    // Connection event handlers
    let authTimeout = null;

    socket.on('connect', () => {
      console.log('[WebSocket] Socket connected - awaiting authentication');

      // Authenticate with machine ID + a fresh account ticket and our
      // display name
      const connecting = socket;
      centralCredentials(serverUrl).then((credentials) => {
        if (socket !== connecting || !connecting.connected) return;
        connecting.emit('authenticate', {
          machine_id: machineId,
          account_ticket: credentials.value,
          display_name: displayName
        });
      }).catch((error) => {
        console.error('[WebSocket] No credential for the central server:', error.message);
        isAuthenticated = false;
        notifyConnectionStatus(false);
      });

      // Set timeout for authentication - if server doesn't respond in 3s, mark as offline
      authTimeout = setTimeout(() => {
        console.warn('[WebSocket] Authentication timeout - server not responding');
        isAuthenticated = false;
        notifyConnectionStatus(false);
      }, 3000);
    });

    socket.on('authenticated', (data) => {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }

      if (data && data.success === false) {
        console.error('[WebSocket] Authentication rejected by server:', data.error);
        isAuthenticated = false;
        notifyConnectionStatus(false);
        return;
      }

      console.log('[WebSocket] Authenticated as:', data.machine_id);
      isAuthenticated = true;
      notifyConnectionStatus(true);
    });

    socket.on('disconnect', (reason) => {
      console.log('[WebSocket] Disconnected:', reason);
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      isAuthenticated = false;
      notifyConnectionStatus(false);
    });

    socket.on('connect_error', (error) => {
      console.error('[WebSocket] Connection error:', error.message);
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      isAuthenticated = false;
      notifyConnectionStatus(false);
    });

    socket.on('reconnect', (attemptNumber) => {
      console.log('[WebSocket] Reconnected after', attemptNumber, 'attempts');
    });

    socket.on('reconnect_attempt', (attemptNumber) => {
      console.log('[WebSocket] Reconnection attempt', attemptNumber);
    });

    // Update event handlers
    socket.on('documents-update', (data) => {
      console.log('[WebSocket] Received documents update:', data.documents.length, 'document(s)');
      updateCallbacks.documents.forEach(callback => {
        try {
          callback(data.documents);
        } catch (error) {
          console.error('[WebSocket] Error in documents update callback:', error);
        }
      });
    });

    // a teammate's identity moved (the server's identity-renamed): our
    // copies of what it owned, and the permissions it granted us, follow
    socket.on('identity-renamed', (data) => {
      import('./cloudReown')
        .then((m) => m.applyIdentityRename(data || {}))
        .catch((error) => console.error('[WebSocket] identity-renamed failed:', error));
    });

    socket.on('workflows-update', (data) => {
      console.log('[WebSocket] Received workflows update:', data.workflows.length, 'workflow(s)');
      updateCallbacks.workflows.forEach(callback => {
        try {
          callback(data.workflows);
        } catch (error) {
          console.error('[WebSocket] Error in workflows update callback:', error);
        }
      });
    });

    socket.on('boards-update', (data) => {
      console.log('[WebSocket] Received boards update:', data.boards.length, 'board(s)');
      updateCallbacks.boards.forEach(callback => {
        try {
          callback(data.boards);
        } catch (error) {
          console.error('[WebSocket] Error in boards update callback:', error);
        }
      });
    });

    socket.on('upload-success', (data) => {
      console.log('[WebSocket] Upload successful, message ID:', data.message_id);
    });

    socket.on('upload-error', (data) => {
      console.error('[WebSocket] Upload error:', data.error);
    });

    socket.on('removal-success', (data) => {
      console.log('[WebSocket] Removal successful, message ID:', data.message_id);
    });

    socket.on('removal-error', (data) => {
      console.error('[WebSocket] Removal error:', data.error);
    });

    // Cursor tracking events
    socket.on('cursors-update', (data) => {
      cursorCallbacks.forEach(callback => {
        try {
          callback(data.documentId, data.cursors);
        } catch (error) {
          console.error('[WebSocket] Error in cursor update callback:', error);
        }
      });
    });

    socket.on('cursor-removed', (data) => {
      cursorCallbacks.forEach(callback => {
        try {
          callback(data.documentId, { [data.userId]: null });
        } catch (error) {
          console.error('[WebSocket] Error in cursor removed callback:', error);
        }
      });
    });

    // Real-time content updates
    socket.on('content-update', (data) => {
      contentUpdateCallbacks.forEach(callback => {
        try {
          callback(data.documentId, data.content, data.cursorPosition, data.userId);
        } catch (error) {
          console.error('[WebSocket] Error in content update callback:', error);
        }
      });
    });

    // Chat message events
    socket.on('chat-message', (data) => {
      console.log('[WebSocket] Received chat message:', data);
      chatMessageCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in chat message callback:', error);
        }
      });
    });

    // Connected users list updates
    socket.on('connected-users', (data) => {
      console.log('[WebSocket] Received connected users:', data);
      connectedUsersList = data.users || [];
      connectedUserNames = (data.names && typeof data.names === 'object') ? data.names : {};
      connectedUsersCallbacks.forEach(callback => {
        try {
          callback(connectedUsersList, connectedUserNames);
        } catch (error) {
          console.error('[WebSocket] Error in connected users callback:', error);
        }
      });
    });

    // Quiz game event listeners
    socket.on('quiz-join', (data) => {
      console.log('[WebSocket] Quiz join event:', data);
      quizJoinCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz join callback:', error);
        }
      });
    });

    socket.on('quiz-join-rejected', (data) => {
      console.log('[WebSocket] Quiz join rejected:', data);
      quizJoinRejectedCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz join rejected callback:', error);
        }
      });
    });

    socket.on('quiz-start', (data) => {
      console.log('[WebSocket] Quiz start event:', data);
      quizStartCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz start callback:', error);
        }
      });
    });

    socket.on('quiz-submit-guess', (data) => {
      quizSubmitGuessCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz submit guess callback:', error);
        }
      });
    });

    socket.on('quiz-next-question', (data) => {
      quizNextQuestionCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz next question callback:', error);
        }
      });
    });

    socket.on('quiz-end', (data) => {
      console.log('[WebSocket] Quiz end event:', data);
      quizEndCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz end callback:', error);
        }
      });
    });

    // Quiz challenge events
    socket.on('quiz-challenge', (data) => {
      console.log('[WebSocket] Received Quiz challenge:', data);
      quizChallengeCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz challenge callback:', error);
        }
      });
    });

    socket.on('quiz-challenge-response', (data) => {
      console.log('[WebSocket] Received Quiz challenge response:', data);
      quizChallengeResponseCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz challenge response callback:', error);
        }
      });
    });

    socket.on('quiz-sync-players', (data) => {
      console.log('[WebSocket] Received Quiz player sync:', data);
      quizSyncPlayersCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz sync players callback:', error);
        }
      });
    });

    socket.on('quiz-anticheat-trigger', (data) => {
      console.log('[WebSocket] Received Quiz anti-cheat trigger:', data);
      quizAntiCheatTriggerCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz anti-cheat trigger callback:', error);
        }
      });
    });

    socket.on('quiz-request-sync', (data) => {
      console.log('[WebSocket] Received Quiz sync request:', data);
      quizRequestSyncCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz request sync callback:', error);
        }
      });
    });

    socket.on('quiz-sync-state', (data) => {
      console.log('[WebSocket] Received Quiz state sync:', data);
      quizSyncStateCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz sync state callback:', error);
        }
      });
    });

    socket.on('quiz-state-update', (data) => {
      quizStateUpdateCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz state update callback:', error);
        }
      });
    });

    // Lightweight per-second countdown tick (no console.log - fires every second)
    socket.on('quiz-timer-tick', (data) => {
      quizTimerTickCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in quiz timer tick callback:', error);
        }
      });
    });

    // Lobby event handlers (shared between Quiz and Grid)
    socket.on('lobby-name-update', (data) => {
      console.log('[WebSocket] Received lobby name update:', data);
      lobbyNameUpdateCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in lobby name update callback:', error);
        }
      });
    });

    // Grid event handlers
    socket.on('grid-join', (data) => {
      console.log('[WebSocket] Grid join event:', data);
      gridJoinCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid join callback:', error);
        }
      });
    });

    socket.on('grid-join-rejected', (data) => {
      console.log('[WebSocket] Grid join rejected:', data);
      gridJoinRejectedCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid join rejected callback:', error);
        }
      });
    });

    socket.on('grid-start', (data) => {
      console.log('[WebSocket] Grid start event:', data);
      gridStartCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid start callback:', error);
        }
      });
    });

    socket.on('grid-select-tile', (data) => {
      console.log('[WebSocket] Grid select tile event:', data);
      gridSelectTileCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid select tile callback:', error);
        }
      });
    });

    socket.on('grid-buzz', (data) => {
      console.log('[WebSocket] Grid buzz event:', data);
      gridBuzzCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid buzz callback:', error);
        }
      });
    });

    socket.on('grid-answer', (data) => {
      console.log('[WebSocket] Grid answer event:', data);
      gridAnswerCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid answer callback:', error);
        }
      });
    });

    socket.on('grid-end', (data) => {
      console.log('[WebSocket] Grid end event:', data);
      gridEndCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid end callback:', error);
        }
      });
    });

    socket.on('grid-sync-players', (data) => {
      console.log('[WebSocket] Received Grid player sync:', data);
      gridSyncPlayersCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid sync players callback:', error);
        }
      });
    });

    socket.on('grid-request-sync', (data) => {
      console.log('[WebSocket] Received Grid sync request:', data);
      gridRequestSyncCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid request sync callback:', error);
        }
      });
    });

    socket.on('grid-return-to-board', (data) => {
      console.log('[WebSocket] Received Grid return to board:', data);
      gridReturnToBoardCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid return to board callback:', error);
        }
      });
    });

    socket.on('grid-state-update', (data) => {
      console.log('[WebSocket] Received Grid state update:', data);
      gridStateUpdateCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid state update callback:', error);
        }
      });
    });

    // Lightweight per-second countdown tick (no console.log - fires every second)
    socket.on('grid-timer-tick', (data) => {
      gridTimerTickCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in grid timer tick callback:', error);
        }
      });
    });

    // Tiles game event listeners
    socket.on('tiles-lobby-created', (data) => {
      console.log('[WebSocket] Tiles lobby created:', data);
      tilesLobbyCreatedCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in tiles lobby created callback:', error);
        }
      });
    });

    socket.on('tiles-player-joined', (data) => {
      console.log('[WebSocket] Tiles player joined:', data);
      tilesPlayerJoinedCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in tiles player joined callback:', error);
        }
      });
    });

    socket.on('tiles-player-left', (data) => {
      console.log('[WebSocket] Tiles player left:', data);
      tilesPlayerLeftCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in tiles player left callback:', error);
        }
      });
    });

    socket.on('tiles-game-started', (data) => {
      console.log('[WebSocket] Tiles game started:', data);
      tilesGameStartedCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in tiles game started callback:', error);
        }
      });
    });

    socket.on('tiles-game-state-update', (data) => {
      console.log('[WebSocket] Tiles game state update:', data);
      tilesGameStateUpdateCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in tiles game state update callback:', error);
        }
      });
    });

    socket.on('tiles-game-ended', (data) => {
      console.log('[WebSocket] Tiles game ended:', data);
      tilesGameEndedCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in tiles game ended callback:', error);
        }
      });
    });

    socket.on('tiles-join-rejected', (data) => {
      console.log('[WebSocket] Tiles join rejected:', data);
      tilesJoinRejectedCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[WebSocket] Error in tiles join rejected callback:', error);
        }
      });
    });

    // Wait for authentication or timeout
    return new Promise((resolve) => {
      let resolved = false;

      const authSuccessHandler = (data) => {
        if (!resolved) {
          resolved = true;
          socket.off('authenticated', authSuccessHandler);
          socket.off('connect_error', authErrorHandler);
          socket.off('disconnect', authDisconnectHandler);
          // Server may reject authentication (invalid/missing client secret)
          resolve(!(data && data.success === false));
        }
      };

      const authErrorHandler = () => {
        if (!resolved) {
          resolved = true;
          socket.off('authenticated', authSuccessHandler);
          socket.off('connect_error', authErrorHandler);
          socket.off('disconnect', authDisconnectHandler);
          resolve(false);
        }
      };

      const authDisconnectHandler = () => {
        if (!resolved) {
          resolved = true;
          socket.off('authenticated', authSuccessHandler);
          socket.off('connect_error', authErrorHandler);
          socket.off('disconnect', authDisconnectHandler);
          resolve(false);
        }
      };

      socket.once('authenticated', authSuccessHandler);
      socket.once('connect_error', authErrorHandler);
      socket.once('disconnect', authDisconnectHandler);

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.off('authenticated', authSuccessHandler);
          socket.off('connect_error', authErrorHandler);
          socket.off('disconnect', authDisconnectHandler);
          console.error('[WebSocket] Connection timeout - server did not authenticate');
          resolve(false);
        }
      }, 5000);
    });
  } catch (error) {
    console.error('[WebSocket] Failed to connect:', error);
    notifyConnectionStatus(false);
    return false;
  }
}

/**
 * Disconnect from WebSocket server
 */
export function disconnectWebSocket() {
  if (socket) {
    console.log('[WebSocket] Disconnecting...');
    // Belt and braces: a manual disconnect() does not auto-reconnect, but
    // also switch the manager's reconnection off so no timer that is
    // already armed (e.g. mid-backoff) can bring the socket back.
    try {
      if (socket.io && socket.io.opts) socket.io.opts.reconnection = false;
      if (socket.io && typeof socket.io.reconnection === 'function') socket.io.reconnection(false);
    } catch {
      // Not a real socket.io manager (tests) - disconnect() below is enough.
    }
    socket.disconnect();
    socket = null;
    isAuthenticated = false;
    notifyConnectionStatus(false);
  }
}

/**
 * Upload document via WebSocket
 */
export async function uploadDocumentViaWebSocket(document) {
  assertSocketConnected();

  const machineId = await getMachineId();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Upload timeout'));
    }, 10000);

    const successHandler = (data) => {
      clearTimeout(timeout);
      socket.off('upload-success', successHandler);
      socket.off('upload-error', errorHandler);
      resolve(data);
    };

    const errorHandler = (data) => {
      clearTimeout(timeout);
      socket.off('upload-success', successHandler);
      socket.off('upload-error', errorHandler);
      reject(new Error(data.error));
    };

    socket.once('upload-success', successHandler);
    socket.once('upload-error', errorHandler);

    socket.emit('upload-document', {
      machine_id: machineId,
      document
    });
  });
}

/**
 * Upload workflow via WebSocket
 */
export async function uploadWorkflowViaWebSocket(workflow) {
  assertSocketConnected();

  const machineId = await getMachineId();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Upload timeout'));
    }, 10000);

    const successHandler = (data) => {
      clearTimeout(timeout);
      socket.off('upload-success', successHandler);
      socket.off('upload-error', errorHandler);
      resolve(data);
    };

    const errorHandler = (data) => {
      clearTimeout(timeout);
      socket.off('upload-success', successHandler);
      socket.off('upload-error', errorHandler);
      reject(new Error(data.error));
    };

    socket.once('upload-success', successHandler);
    socket.once('upload-error', errorHandler);

    socket.emit('upload-workflow', {
      machine_id: machineId,
      workflow
    });
  });
}

/**
 * Upload board via WebSocket
 */
export async function uploadBoardViaWebSocket(board, cards) {
  assertSocketConnected();

  const machineId = await getMachineId();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Upload timeout'));
    }, 10000);

    const successHandler = (data) => {
      clearTimeout(timeout);
      socket.off('upload-success', successHandler);
      socket.off('upload-error', errorHandler);
      resolve(data);
    };

    const errorHandler = (data) => {
      clearTimeout(timeout);
      socket.off('upload-success', successHandler);
      socket.off('upload-error', errorHandler);
      reject(new Error(data.error));
    };

    socket.once('upload-success', successHandler);
    socket.once('upload-error', errorHandler);

    socket.emit('upload-board', {
      machine_id: machineId,
      board,
      cards
    });
  });
}

/**
 * Remove document via WebSocket
 */
export async function removeDocumentViaWebSocket(ownerId, title) {
  assertSocketConnected();

  const machineId = await getMachineId();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Removal timeout'));
    }, 10000);

    const successHandler = (data) => {
      clearTimeout(timeout);
      socket.off('removal-success', successHandler);
      socket.off('removal-error', errorHandler);
      resolve(data);
    };

    const errorHandler = (data) => {
      clearTimeout(timeout);
      socket.off('removal-success', successHandler);
      socket.off('removal-error', errorHandler);
      reject(new Error(data.error));
    };

    socket.once('removal-success', successHandler);
    socket.once('removal-error', errorHandler);

    socket.emit('remove-document', {
      machine_id: machineId,
      ownerId,
      title
    });
  });
}

/**
 * Remove workflow via WebSocket
 */
export async function removeWorkflowViaWebSocket(ownerId, title) {
  assertSocketConnected();

  const machineId = await getMachineId();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Removal timeout'));
    }, 10000);

    const successHandler = (data) => {
      clearTimeout(timeout);
      socket.off('removal-success', successHandler);
      socket.off('removal-error', errorHandler);
      resolve(data);
    };

    const errorHandler = (data) => {
      clearTimeout(timeout);
      socket.off('removal-success', successHandler);
      socket.off('removal-error', errorHandler);
      reject(new Error(data.error));
    };

    socket.once('removal-success', successHandler);
    socket.once('removal-error', errorHandler);

    socket.emit('remove-workflow', {
      machine_id: machineId,
      ownerId,
      title
    });
  });
}

/**
 * Remove board via WebSocket
 */
export async function removeBoardViaWebSocket(cloudBoardId, ownerId) {
  assertSocketConnected();

  const machineId = await getMachineId();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Removal timeout'));
    }, 10000);

    const successHandler = (data) => {
      clearTimeout(timeout);
      socket.off('removal-success', successHandler);
      socket.off('removal-error', errorHandler);
      resolve(data);
    };

    const errorHandler = (data) => {
      clearTimeout(timeout);
      socket.off('removal-success', successHandler);
      socket.off('removal-error', errorHandler);
      reject(new Error(data.error));
    };

    socket.once('removal-success', successHandler);
    socket.once('removal-error', errorHandler);

    socket.emit('remove-board', {
      machine_id: machineId,
      cloudBoardId,
      ownerId
    });
  });
}

/**
 * Send cursor position and selection update to server
 */
export async function sendCursorUpdate(documentId, position, selectionEnd = null) {
  if (!socket || !socket.connected) {
    return; // Silently fail if not connected
  }

  const machineId = await getMachineId();

  socket.emit('cursor-update', {
    documentId,
    position,
    selectionEnd: selectionEnd || position,
    name: await getDisplayName(),
    machineId
  });
}

/**
 * Tell the server our display name changed (Settings > General > Your
 * name, browser identities only) so teammates see it without a reconnect.
 */
export async function sendDisplayNameUpdate() {
  if (!socket || !socket.connected) {
    return false; // the next 'authenticate' carries it
  }
  socket.emit('set-display-name', { display_name: await getDisplayName() });
  return true;
}

/**
 * Notify server that user left the document
 */
export async function sendCursorRemoved(documentId) {
  if (!socket || !socket.connected) {
    return; // Silently fail if not connected
  }

  const machineId = await getMachineId();

  socket.emit('cursor-removed', {
    documentId,
    machineId
  });
}

/**
 * Send content update to server (real-time collaboration)
 */
export async function sendContentUpdate(documentId, content, cursorPosition) {
  if (!socket || !socket.connected) {
    return; // Silently fail if not connected
  }

  const machineId = await getMachineId();

  socket.emit('content-update', {
    documentId,
    content,
    cursorPosition,
    machineId
  });
}

/**
 * Send chat message to server
 */
export async function sendChatMessage(message) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send chat message - not connected');
    return;
  }

  const machineId = await getMachineId();
  const username = await getDisplayName();

  const chatMessage = {
    username,
    userId: machineId,
    message,
    timestamp: Date.now()
  };

  console.log('[WebSocket] Sending chat message:', chatMessage);
  socket.emit('chat-message', chatMessage);
}

/**
 * Send Quiz join event
 */
export async function sendQuizJoin(gameId, playerId, playerName) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send quiz join - not connected');
    return false;
  }

  socket.emit('quiz-join', {
    gameId,
    playerId,
    playerName: playerName || playerId.split('@')[0],
    clientType: 'app',
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Quiz start event (host only)
 */
export async function sendQuizStart(gameId, questions) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send quiz start - not connected');
    return false;
  }

  socket.emit('quiz-start', {
    gameId,
    questions,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Quiz guess submission
 */
export async function sendQuizSubmitGuess(gameId, playerId, questionId, answer, hintsRevealed = 0) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot submit quiz guess - not connected');
    return false;
  }

  socket.emit('quiz-submit-guess', {
    gameId,
    playerId,
    questionId,
    answer,  // Send only the answer text - server will validate and score
    hintsRevealed,  // Send hints revealed for point calculation
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Quiz next question event (host only)
 */
export async function sendQuizNextQuestion(gameId, questionIndex) {
  if (!socket || !socket.connected) {
    return false;
  }

  socket.emit('quiz-next-question', {
    gameId,
    questionIndex,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Quiz end event (host only)
 */
export async function sendQuizEnd(gameId, finalScores) {
  if (!socket || !socket.connected) {
    return false;
  }

  socket.emit('quiz-end', {
    gameId,
    finalScores,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Quiz challenge to another user
 */
export async function sendQuizChallenge(targetUserId, gameId) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send Quiz challenge - not connected');
    return false;
  }

  const machineId = await getMachineId();
  const username = await getDisplayName();

  const challenge = {
    challengerId: machineId,
    challengerName: username,
    targetUserId,
    gameId,
    timestamp: Date.now()
  };

  console.log('[WebSocket] Sending Quiz challenge:', challenge);
  socket.emit('quiz-challenge', challenge);
  return true;
}

/**
 * Send Quiz challenge response (accept/decline)
 */
export async function sendQuizChallengeResponse(challengerId, accepted, gameId = null) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send Quiz challenge response - not connected');
    return false;
  }

  const machineId = await getMachineId();
  const username = await getDisplayName();

  const response = {
    responderId: machineId,
    responderName: username,
    challengerId,
    accepted,
    gameId,
    timestamp: Date.now()
  };

  console.log('[WebSocket] Sending Quiz challenge response:', response);
  socket.emit('quiz-challenge-response', response);
  return true;
}

/**
 * Send Quiz player list sync (host broadcasts full player list)
 */
export async function sendQuizSyncPlayers(gameId, players) {
  if (!socket || !socket.connected) {
    return false;
  }

  socket.emit('quiz-sync-players', {
    gameId,
    players,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Notify server that player is leaving the quiz game
 */
export async function sendQuizLeave(gameId, playerId) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send quiz leave - not connected');
    return false;
  }

  socket.emit('quiz-leave', {
    gameId,
    playerId,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Notify server that player is leaving the grid game
 */
export async function sendGridLeave(gameId, playerId) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send grid leave - not connected');
    return false;
  }

  socket.emit('grid-leave', {
    gameId,
    playerId,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send lobby name update (works for both Quiz and Grid)
 */
export async function sendLobbyNameUpdate(gameId, lobbyName) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send lobby name update - not connected');
    return false;
  }

  socket.emit('lobby-name-update', {
    gameId,
    lobbyName,
    timestamp: Date.now()
  });

  return true;
}

export async function sendLobbyMetadataUpdate(gameId, { quizType, questions, selectedCategories }) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send lobby metadata update - not connected');
    return false;
  }

  socket.emit('lobby-metadata-update', {
    gameId,
    quizType,
    questions,
    selectedCategories
  });

  return true;
}

/**
 * Send Quiz anti-cheat trigger
 */
export async function sendQuizAntiCheatTrigger(gameId, playerId) {
  if (!socket || !socket.connected) {
    return false;
  }

  socket.emit('quiz-anticheat-trigger', {
    gameId,
    playerId,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Request quiz state sync (for reconnection)
 */
export async function sendQuizRequestSync(gameId, requesterId) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send quiz sync request - not connected');
    return false;
  }

  socket.emit('quiz-request-sync', {
    gameId,
    requesterId,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send quiz state sync (host responding to sync request)
 */
export async function sendQuizSyncState(gameId, requesterId, gameState) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send quiz state sync - not connected');
    return false;
  }

  socket.emit('quiz-sync-state', {
    gameId,
    requesterId,
    ...gameState,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Grid join event
 */
export async function sendGridJoin(gameId, playerId, playerName) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send grid join - not connected');
    return false;
  }

  socket.emit('grid-join', {
    gameId,
    playerId,
    playerName: playerName || playerId.split('@')[0],
    clientType: 'app',
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Grid start event (host only)
 */
export async function sendGridStart(gameId, board, selectedCategories, players) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send grid start - not connected');
    return false;
  }

  socket.emit('grid-start', {
    gameId,
    board,
    selectedCategories,
    players,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Grid tile selection event
 */
export async function sendGridSelectTile(gameId, playerId, tile) {
  if (!socket || !socket.connected) {
    return false;
  }

  socket.emit('grid-select-tile', {
    gameId,
    playerId,
    tile,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Grid buzz event
 */
export async function sendGridBuzz(gameId, playerId) {
  if (!socket || !socket.connected) {
    return false;
  }

  socket.emit('grid-buzz', {
    gameId,
    playerId,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Grid answer event
 */
export async function sendGridAnswer(gameId, playerId, answer, correct) {
  if (!socket || !socket.connected) {
    return false;
  }

  socket.emit('grid-answer', {
    gameId,
    playerId,
    answer,
    correct,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Grid end event (host only)
 */
export async function sendGridEnd(gameId, finalScores) {
  if (!socket || !socket.connected) {
    return false;
  }

  socket.emit('grid-end', {
    gameId,
    finalScores,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send Grid player sync
 */
export async function sendGridSyncPlayers(gameId, players) {
  if (!socket || !socket.connected) {
    return false;
  }

  socket.emit('grid-sync-players', {
    gameId,
    players,
    timestamp: Date.now()
  });

  return true;
}

export async function sendGridRequestSync(gameId, requesterId) {
  if (!socket || !socket.connected) {
    return false;
  }

  socket.emit('grid-request-sync', {
    gameId,
    requesterId
  });

  return true;
}

/**
 * Send Grid return to board event (sync state transitions)
 */
export async function sendGridReturnToBoard(gameId) {
  if (!socket || !socket.connected) {
    return false;
  }

  socket.emit('grid-return-to-board', {
    gameId,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Fetch available games from the server
 */
export async function fetchAvailableGames(playerId) {
  try {
    const centralServerUrl = getCentralServerUrl();

    // If no central server URL is configured, return empty array
    if (!centralServerUrl) {
      console.warn('[WebSocket] No central server URL configured');
      return [];
    }

    // /api/games requires pairing auth like every other sync endpoint (it
    // returns full question data): send our machine_id + client secret.
    const machineId = await getMachineId();
    const url = `${centralServerUrl}/api/games?playerId=${encodeURIComponent(playerId)}&machine_id=${encodeURIComponent(machineId)}`;
    console.log('[WebSocket] Fetching games from:', url);

    const response = await fetch(url, {
      headers: await getCentralAuthHeaders(centralServerUrl)
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch games: ${response.status}`);
    }

    const data = await response.json();
    console.log('[WebSocket] Games API response:', data);
    return data.games || [];
  } catch (error) {
    console.error('[WebSocket] Failed to fetch games:', error);
    return [];
  }
}

// ============================================
// TILES GAME FUNCTIONS
// ============================================

/**
 * Create Tiles lobby
 */
export async function sendTilesCreateLobby(lobbyId, playerId, playerName, gridSize, isSinglePlayer) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot create Tiles lobby - not connected');
    return false;
  }

  console.log('[WebSocket] Sending tiles-create-lobby:', {
    lobbyId,
    playerId,
    playerName,
    gridSize,
    isSinglePlayer
  });

  socket.emit('tiles-create-lobby', {
    lobbyId,
    playerId,
    playerName,
    gridSize,
    isSinglePlayer,
    timestamp: Date.now()
  });

  console.log('[WebSocket] tiles-create-lobby emitted');
  return true;
}

/**
 * Join Tiles lobby
 */
export async function sendTilesJoinLobby(lobbyId, playerId, playerName) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot join Tiles lobby - not connected');
    return false;
  }

  socket.emit('tiles-join-lobby', {
    lobbyId,
    playerId,
    playerName,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Start Tiles game
 */
export async function sendTilesStart(lobbyId) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot start Tiles - not connected');
    return false;
  }

  socket.emit('tiles-start', {
    lobbyId,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Click cell in Tiles game
 */
export async function sendTilesCellClick(lobbyId, playerId, row, col) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot click Tiles cell - not connected');
    return false;
  }

  socket.emit('tiles-cell-click', {
    lobbyId,
    playerId,
    row,
    col,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Give up in Tiles game
 */
export async function sendTilesGiveUp(lobbyId, playerId) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot give up - not connected');
    return false;
  }

  socket.emit('tiles-give-up', {
    lobbyId,
    playerId,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Leave Tiles lobby
 */
export async function sendTilesLeaveLobby(lobbyId, playerId) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot leave Tiles lobby - not connected');
    return false;
  }

  socket.emit('tiles-leave-lobby', {
    lobbyId,
    playerId,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Send game invite to a user
 */
export async function sendGameInvite(gameId, gameMode, targetMachineId) {
  if (!socket || !socket.connected) {
    console.warn('[WebSocket] Cannot send game invite - not connected');
    return false;
  }

  socket.emit('game-invite', {
    gameId,
    gameMode,
    targetMachineId,
    timestamp: Date.now()
  });

  return true;
}

/**
 * Register callback for Tiles lobby created
 */
export function onTilesLobbyCreated(callback) {
  tilesLobbyCreatedCallbacks.push(callback);
  return () => {
    tilesLobbyCreatedCallbacks = tilesLobbyCreatedCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Tiles player joined
 */
export function onTilesPlayerJoined(callback) {
  tilesPlayerJoinedCallbacks.push(callback);
  return () => {
    tilesPlayerJoinedCallbacks = tilesPlayerJoinedCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Tiles player left
 */
export function onTilesPlayerLeft(callback) {
  tilesPlayerLeftCallbacks.push(callback);
  return () => {
    tilesPlayerLeftCallbacks = tilesPlayerLeftCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Tiles game started
 */
export function onTilesGameStarted(callback) {
  tilesGameStartedCallbacks.push(callback);
  return () => {
    tilesGameStartedCallbacks = tilesGameStartedCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Tiles game state update
 */
export function onTilesGameStateUpdate(callback) {
  tilesGameStateUpdateCallbacks.push(callback);
  return () => {
    tilesGameStateUpdateCallbacks = tilesGameStateUpdateCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Register callback for Tiles game ended
 */
export function onTilesGameEnded(callback) {
  tilesGameEndedCallbacks.push(callback);
  return () => {
    tilesGameEndedCallbacks = tilesGameEndedCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Listen for tiles-join-rejected events
 */
let tilesJoinRejectedCallbacks = [];

export function onTilesJoinRejected(callback) {
  tilesJoinRejectedCallbacks.push(callback);
  return () => {
    tilesJoinRejectedCallbacks = tilesJoinRejectedCallbacks.filter(cb => cb !== callback);
  };
}
