/**
 * Socket.IO connection handler.
 *
 * The entire io.on('connection', ...) callback is kept as ONE verbatim,
 * unmodified unit: it relies on a per-connection mutable `machineId`
 * captured by closure across all the socket.on(...) registrations below
 * (plus local helper closures like requireSocketAuth), so it must not be
 * decomposed further.
 *
 * Extracted verbatim from server.js (structural refactor only).
 */

const { setupYjsSync } = require('./yjs-sync');
const {
  connectedClients,
  attachClientSocket,
  detachClientSocket,
  displayNames,
  messageQueue,
  gameRegistry,
  gridGames,
  quizGames,
  tilesGames,
  debugLog
} = require('./state');
const { clientRegistry, verifyClientSecret, authenticateTicket } = require('./client-registry');
const { TRUST_PROXY } = require('./state');

// The client's address for logs and per-address limits: behind the console's
// proxy (TRUST_PROXY, deploy/Caddyfile) it is the first X-Forwarded-For entry,
// as Express's req.ip is for the REST routes.
function clientAddress(socket) {
  const headers = (socket.handshake && socket.handshake.headers) || {};
  if (TRUST_PROXY && typeof headers['x-forwarded-for'] === 'string' && headers['x-forwarded-for']) {
    return headers['x-forwarded-for'].split(',')[0].trim();
  }
  return (socket.handshake && socket.handshake.address) || 'unknown';
}

// The display name a client sends for itself is a label, never an identity:
// one line, at most 32 characters, no "@" (it would read like a machine_id).
// Anything else falls back to the user part of the verified machine_id, the
// derivation every client used before display names existed.
const DISPLAY_NAME_MAX_LENGTH = 32;
function sanitizeDisplayName(name, machineId) {
  const fallback = String(machineId).split('@')[0];
  if (typeof name !== 'string') return fallback;
  const printable = Array.from(name).filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f).join('');
  const cleaned = printable.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > DISPLAY_NAME_MAX_LENGTH || cleaned.includes('@')) return fallback;
  return cleaned;
}
const {
  registerGame,
  updateGameStatus,
  updateLobbyName,
  updateGamePlayers
} = require('./game-registry');
const { fuzzyMatchAnswer } = require('./answer-matching');
const {
  GRID_BUZZ_WINDOW,
  GRID_ANSWER_TIME,
  createGridGame,
  startQuestionTimer,
  broadcastGameState,
  markTileAsAnswered,
  resetQuestionState,
  reopenBuzzWindow,
  startTyping,
  pauseTyping,
  resumeTyping,
  endGridGame,
  handleAllPlayersAttempted
} = require('./grid-game');
const {
  createQuizGame,
  startQuizQuestionTimer,
  applyPendingScoreUpdates,
  endQuizGame,
  broadcastQuizGameState
} = require('./quiz-game');
const {
  createTilesGame,
  toggleTilesCell,
  checkTilesSolved,
  broadcastTilesGameState,
  endTilesGame
} = require('./tiles-game');
const {
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
  broadcastConnectedUsers
} = require('./sync-handlers');

/**
 * Mark a single player as disconnected in one game: registry, the mode's
 * authoritative state (if the game has started) and the appropriate
 * broadcast to remaining players. The player entry is KEPT (connected:
 * false) so they can reconnect; actual removal is the stale-game sweep's
 * job (game-registry.js) once the whole game has been abandoned past the
 * grace period.
 *
 * Shared by the explicit leave events (quiz-leave / grid-leave /
 * tiles-leave-lobby) and by socket disconnect handling - including
 * unauthenticated web game clients, whose players previously were never
 * marked disconnected on disconnect and kept abandoned games listed as
 * "running" forever.
 */
function markGamePlayerDisconnected(io, gameId, playerId) {
  const game = gameRegistry.get(gameId);
  if (!game) return;

  const player = game.players.find(p => p.id === playerId);
  if (!player || player.connected === false) return; // unknown or already marked

  game.players = game.players.map(p =>
    p.id === playerId ? { ...p, connected: false } : p
  );
  updateGamePlayers(gameId, game.players);

  if (game.mode === 'quiz') {
    const quizGame = quizGames.get(gameId);
    if (quizGame) {
      quizGame.players = quizGame.players.map(p =>
        p.id === playerId ? { ...p, connected: false } : p
      );
      console.log(`[Quiz] Marked player ${playerId} as disconnected in active quiz ${gameId}`);
      broadcastQuizGameState(gameId, false);
    } else {
      // In lobby - use quiz-sync-players
      io.to(gameId).emit('quiz-sync-players', {
        gameId,
        players: game.players.map(p => ({ ...p, score: p.score ?? 0 })),
        lobbyName: game.lobbyName,
        timestamp: Date.now()
      });
    }
  } else if (game.mode === 'grid') {
    const gridGame = gridGames.get(gameId);
    if (gridGame && gridGame.players) {
      gridGame.players = gridGame.players.map(p =>
        p.id === playerId ? { ...p, connected: false } : p
      );
      console.log(`[Grid] Marked player ${playerId} as disconnected in active grid game ${gameId}`);
      broadcastGameState(gameId);
    } else {
      // In lobby - use grid-sync-players
      const hostName = game.hostId ? game.hostId.split('@')[0] : 'Host';
      const effectiveLobbyName = game.lobbyName || `${hostName}'s Lobby`;
      io.to(gameId).emit('grid-sync-players', {
        gameId,
        players: game.players.map(p => ({ ...p, score: p.score ?? 0 })),
        lobbyName: effectiveLobbyName,
        timestamp: Date.now()
      });
    }
  } else if (game.mode === 'tiles') {
    const tilesGame = tilesGames.get(gameId);
    if (tilesGame) {
      tilesGame.players = tilesGame.players.map(p =>
        p.id === playerId ? { ...p, connected: false } : p
      );
      console.log(`[Tiles] Marked player ${playerId} as disconnected in active game ${gameId}`);
      broadcastTilesGameState(gameId);
    } else {
      // In lobby - broadcast player list with disconnected status
      io.to(gameId).emit('tiles-player-left', {
        lobbyId: gameId,
        players: game.players,
        timestamp: Date.now()
      });
    }
  }
}

function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`\n[WebSocket] New connection: ${socket.id}`);
    let machineId = null;

    // Games this socket has joined as a game client: gameId -> playerId.
    // Needed so disconnects can mark the right players as disconnected even
    // for sockets that never authenticate (web browser game clients join
    // quiz/grid/tiles without a client secret, so machineId stays null).
    const joinedGames = new Map();

    /**
     * Require a verified (authenticated) socket for sync operations.
     * Rejects if the socket never completed a successful 'authenticate',
     * or if the payload claims a machine_id other than the verified one.
     * Games (quiz/grid/tiles) are deliberately NOT gated - web browser
     * clients join those without a client secret.
     */
    const requireSocketAuth = (data, errorEvent) => {
      if (!machineId) {
        socket.emit(errorEvent, { error: 'Not authenticated. Send a valid authenticate event first.' });
        return false;
      }
      if (data && data.machine_id && data.machine_id !== machineId) {
        console.log(`[Auth] ❌ Socket ${socket.id} (${machineId}) tried to act as "${data.machine_id}" - rejected`);
        socket.emit(errorEvent, { error: 'machine_id does not match authenticated identity' });
        return false;
      }
      return true;
    };

    // Authenticate and register machine ID.
    // The claimed machine_id is only trusted if the accompanying
    // client_secret matches the secret issued at registration
    // (POST /api/register, trust-on-first-use - see Client Registry above).
    socket.on('authenticate', (data) => {
      const claimedId = data && data.machine_id;
      const clientSecret = data && data.client_secret;
      const accountTicket = data && data.account_ticket;
      let accountIdentity = null;

      if (typeof accountTicket === 'string' && accountTicket) {
        // A signed-in user of the home server (account-tickets.js): the
        // ticket names the identity, no pairing secret is involved.
        const ip = clientAddress(socket);
        const outcome = authenticateTicket(accountTicket, claimedId, ip);
        if (outcome.status) {
          console.log(`[Auth] ❌ WebSocket account authentication rejected for "${claimedId || '?'}" (socket ${socket.id}): ${outcome.body.code}`);
          socket.emit('authenticated', { success: false, error: outcome.body.error, code: outcome.body.code });
          socket.disconnect(true);
          return;
        }
        machineId = outcome.machineId;
        accountIdentity = outcome.identity;
      } else {
        if (!claimedId || !verifyClientSecret(claimedId, clientSecret)) {
          const accountOnly = claimedId && clientRegistry[claimedId] && clientRegistry[claimedId].account && !clientRegistry[claimedId].secretHash;
          console.log(`[Auth] ❌ WebSocket authentication rejected for "${claimedId}" (socket ${socket.id}): ${accountOnly ? 'account identity without a ticket' : 'missing/invalid client secret'}`);
          socket.emit('authenticated', {
            success: false,
            error: accountOnly
              ? 'This identity belongs to an account: sign in to the home server (no pairing secret applies).'
              : 'Invalid or missing client secret for this machine_id. Register via POST /api/register first.',
            code: accountOnly ? 'ACCOUNT_IDENTITY' : 'CLIENT_SECRET_INVALID'
          });
          socket.disconnect(true);
          return;
        }
        machineId = claimedId;
      }

      clientRegistry[machineId].lastSeen = Date.now();
      attachClientSocket(machineId, socket);   // one identity, possibly several devices
      messageQueue.activeMachines.add(machineId);
      // The label shown to others for this verified identity (a browser
      // client's chosen name; the desktop sends its OS username, which is
      // also what the fallback derives; an account's name comes with its
      // ticket when the client sends none).
      displayNames.set(machineId, sanitizeDisplayName(data.display_name || (accountIdentity && accountIdentity.displayName), machineId));

      console.log(`[WebSocket] Client authenticated: ${machineId}`);
      console.log(`[WebSocket] Connected clients: ${connectedClients.size}`);

      // Setup Yjs collaborative editing
      setupYjsSync(io, socket, machineId);

      socket.emit('authenticated', { success: true, machine_id: machineId });

      // Send any pending messages for this machine
      sendPendingMessages(socket, machineId);

      // Broadcast updated connected users list to all clients
      broadcastConnectedUsers(io);
    });

    // Upload document
    socket.on('upload-document', (data) => {
      if (!requireSocketAuth(data, 'upload-error')) return;
      handleDocumentUpload({ ...data, machine_id: machineId }, socket, io);
    });

    // Upload workflow
    socket.on('upload-workflow', (data) => {
      if (!requireSocketAuth(data, 'upload-error')) return;
      handleWorkflowUpload({ ...data, machine_id: machineId }, socket, io);
    });

    // Upload kanban board
    socket.on('upload-board', (data) => {
      if (!requireSocketAuth(data, 'upload-error')) return;
      handleBoardUpload({ ...data, machine_id: machineId }, socket, io);
    });

    // Remove document
    socket.on('remove-document', (data) => {
      if (!requireSocketAuth(data, 'removal-error')) return;
      handleDocumentRemoval({ ...data, machine_id: machineId }, socket, io);
    });

    // Remove workflow
    socket.on('remove-workflow', (data) => {
      if (!requireSocketAuth(data, 'removal-error')) return;
      handleWorkflowRemoval({ ...data, machine_id: machineId }, socket, io);
    });

    // Remove kanban board
    socket.on('remove-board', (data) => {
      if (!requireSocketAuth(data, 'removal-error')) return;
      handleBoardRemoval({ ...data, machine_id: machineId }, socket, io);
    });

    // Cursor tracking
    socket.on('cursor-update', (data) => {
      handleCursorUpdate(data, socket, io, machineId);
    });

    socket.on('cursor-removed', (data) => {
      handleCursorRemoved(data, socket, io, machineId);
    });

    // Real-time content sync
    socket.on('content-update', (data) => {
      handleContentUpdate(data, socket, io, machineId);
    });

    // A client renamed itself (Settings > General > Your name): only the
    // label changes, the identity (machine_id, ownership) does not.
    socket.on('set-display-name', (data) => {
      if (!machineId) {
        return; // Unauthenticated sockets have no identity to label
      }
      displayNames.set(machineId, sanitizeDisplayName(data && data.display_name, machineId));
      broadcastConnectedUsers(io);
    });

    // Chat message handler (only authenticated sync clients may broadcast).
    // The payload is NOT relayed verbatim: identity fields come from the
    // verified socket identity, never from the client (a client could
    // otherwise impersonate a teammate by sending someone else's
    // username/userId), and only the message text is passed through.
    socket.on('chat-message', (data) => {
      if (!machineId) {
        return; // Unauthenticated sockets cannot broadcast chat
      }
      const text = data && typeof data.message === 'string' ? data.message : '';
      if (!text.trim()) {
        return;
      }
      const relayed = {
        // The display name this identity registered at 'authenticate' /
        // 'set-display-name' (its machine_id's user part when none)
        username: displayNames.get(machineId) || machineId.split('@')[0],
        userId: machineId,
        message: text.slice(0, 10000),
        timestamp: Date.now()
      };
      console.log('[Chat] Message from', relayed.username, ':', relayed.message);

      // Broadcast to all OTHER authenticated sync clients (not the sender)
      for (const [clientId, clientSocket] of connectedClients.entries()) {
        if (clientId !== machineId) {
          clientSocket.emit('chat-message', relayed);
        }
      }
    });

    // Quiz game handlers
    socket.on('quiz-join', (data) => {
      const { gameId, playerId, playerName, clientType, timestamp } = data;
      const playerType = clientType || 'app';
      console.log(`[Quiz] Player ${playerName} (${playerType}) joined game ${gameId}`);

      // Web clients can only join existing lobbies, not create new ones
      if (!gameRegistry.has(gameId)) {
        if (playerType === 'web') {
          console.log(`[Quiz] Web client ${playerName} attempted to create lobby ${gameId} - rejected`);
          socket.emit('quiz-join-rejected', {
            gameId,
            reason: 'This lobby does not exist. Web clients can only join existing lobbies created from the app.',
            timestamp: Date.now()
          });
          return;
        }
        // Only app clients can create new lobbies
        registerGame(gameId, 'quiz', playerId);
      }

      // Update player list in registry
      const game = gameRegistry.get(gameId);
      let isReconnection = false;
      if (game) {
        const playerExists = game.players.some(p => p.id === playerId);

        // Prevent new players from joining a game already in progress
        if (!playerExists && game.status === 'playing') {
          console.log(`[Quiz] Player ${playerName} attempted to join in-progress game ${gameId} - rejected`);
          socket.emit('quiz-join-rejected', {
            gameId,
            reason: 'Game is already in progress. You can only join games in the lobby.',
            timestamp: Date.now()
          });
          return;
        }

        if (!playerExists) {
          game.players.push({ id: playerId, name: playerName, score: 0, connected: true, status: 'ready', ready: true, clientType: playerType });
        } else {
          // Reconnection - mark as connected and ensure score/status is set, preserve/update clientType
          isReconnection = true;
          game.players = game.players.map(p =>
            p.id === playerId ? { ...p, connected: true, score: p.score || 0, status: 'ready', ready: true, clientType: p.clientType || playerType } : p
          );

          // Also update authoritative quiz game state if it exists
          const quizGame = quizGames.get(gameId);
          if (quizGame) {
            quizGame.players = quizGame.players.map(p =>
              p.id === playerId ? { ...p, connected: true } : p
            );
            debugLog(`[Quiz] Updated authoritative quiz game state for reconnected player ${playerName}`);
          }
        }
      }

      // Join this socket to the game room
      socket.join(gameId);
      joinedGames.set(gameId, playerId);
      debugLog(`[Quiz] Socket ${socket.id} joined room ${gameId}`);

      if (isReconnection) {
        // Player reconnected
        console.log(`[Quiz] Player ${playerName} (${playerId}) reconnected to game ${gameId}`);

        // Check if there's an active quiz game
        const quizGame = quizGames.get(gameId);
        if (quizGame) {
          // Active quiz - broadcast authoritative state immediately
          debugLog(`[Quiz] Broadcasting authoritative state (quiz in progress reconnection)`);
          const playerStates = quizGame.players.map(p => `${p.name}:${p.connected !== false ? 'connected' : 'disconnected'}`).join(', ');
          debugLog(`[Quiz] Current player states: ${playerStates}`);
          broadcastQuizGameState(gameId, false);
        } else if (game.status === 'lobby') {
          // In lobby - use quiz-sync-players
          debugLog(`[Quiz] Broadcasting player list (lobby reconnection)`);
          const playersWithScores = game.players.map(p => ({
            ...p,
            score: p.score ?? 0
          }));
          io.to(gameId).emit('quiz-sync-players', {
            gameId,
            players: playersWithScores,
            lobbyName: game.lobbyName,
            timestamp
          });
        }
      } else {
        // New player - broadcast join to other players in this game room only
        socket.to(gameId).emit('quiz-join', {
          gameId,
          playerId,
          playerName,
          clientType: playerType,
          timestamp
        });

        // Send current player list to the joining player so they can see everyone
        const playersWithScores = game.players.map(p => ({
          ...p,
          score: p.score ?? 0
        }));
        socket.emit('quiz-sync-players', {
          gameId,
          players: playersWithScores,
          lobbyName: game.lobbyName,
          timestamp
        });
      }
    });

    socket.on('quiz-start', (data) => {
      const { gameId, questions, timestamp } = data;
      console.log(`[Quiz] Game ${gameId} started with ${questions?.length || 0} questions`);

      // Update game status to playing
      updateGameStatus(gameId, 'playing');

      // Store questions in registry if not already stored
      const registryGame = gameRegistry.get(gameId);
      if (registryGame && questions) {
        registryGame.questions = questions;

        // Create authoritative quiz game state
        const quizType = registryGame.quizType || 'unknown';
        createQuizGame(gameId, registryGame.hostId, registryGame.players, questions, quizType);

        // Start question timer
        startQuizQuestionTimer(gameId);

        // Broadcast quiz-start event to other players (for initialization)
        // Strip answers from questions to prevent cheating
        const questionsWithoutAnswers = questions.map(q => {
          const { answer: _answer, ...questionWithoutAnswer } = q;
          return questionWithoutAnswer;
        });

        socket.to(gameId).emit('quiz-start', {
          gameId,
          questions: questionsWithoutAnswers,
          timestamp
        });

        // Broadcast initial state to all players
        broadcastQuizGameState(gameId, false);
      }

      // Ensure host is in the game room
      socket.join(gameId);
      debugLog(`[Quiz] Host socket ${socket.id} joined room ${gameId}`);
    });

    socket.on('quiz-submit-guess', (data) => {
      const { gameId, playerId, questionId, answer, hintsRevealed = 0, timestamp } = data;

      const game = quizGames.get(gameId);
      if (!game) {
        console.warn(`[Quiz] No active game found for ${gameId}`);
        return;
      }

      const currentQuestion = game.questions[game.currentQuestionIndex];
      if (!currentQuestion || currentQuestion.id !== questionId) {
        console.warn(`[Quiz] Question mismatch for answer submission`);
        return;
      }

      // Don't accept answers if we're transitioning between questions
      if (game.isTransitioning) {
        debugLog(`[Quiz] ${playerId} tried to answer but we're transitioning - ignoring`);
        return;
      }

      // Check if player already answered this question
      const alreadyAnswered = game.pendingScoreUpdates.some(u => u.playerId === playerId);
      if (alreadyAnswered) {
        debugLog(`[Quiz] ${playerId} already answered question ${questionId}`);
        return;
      }

      // Server-side answer validation using fuzzy matching
      const correct = fuzzyMatchAnswer(answer.trim(), currentQuestion.answer);

      // Calculate points (use player's hint count, not global)
      const POINTS_PER_QUESTION = 100;
      const POINTS_DEDUCTION_PER_HINT = 25;
      const pointsEarned = correct ? Math.max(0, POINTS_PER_QUESTION - (hintsRevealed * POINTS_DEDUCTION_PER_HINT)) : 0;

      debugLog(`[Quiz] ${playerId} answered question ${questionId}: ${correct ? 'correct' : 'incorrect'} (${pointsEarned} points with ${hintsRevealed} hints revealed)`);

      // Store pending score update (don't apply yet - wait until question ends)
      game.pendingScoreUpdates.push({
        playerId,
        questionId,
        correct,
        pointsEarned,
        timestamp
      });

      // Record answer in history (for "Answered" badges)
      game.questionAnswers.push({
        questionId,
        playerId,
        correct,
        pointsEarned,
        timestamp
      });

      // Broadcast state (scores not updated yet)
      broadcastQuizGameState(gameId, false);

      // Check if all players have answered
      const activePlayers = game.players.filter(p => p.connected !== false);
      const answeredCount = game.pendingScoreUpdates.length;

      debugLog(`[Quiz] ${answeredCount}/${activePlayers.length} players answered question ${questionId}`);

      if (answeredCount === activePlayers.length && activePlayers.length > 0) {
        debugLog(`[Quiz] All players answered question ${questionId} - revealing answer and advancing`);

        // Clear the question timer since we're advancing early
        if (game.questionTimer) {
          clearInterval(game.questionTimer);
          game.questionTimer = null;
        }

        // Mark that we're transitioning to prevent duplicate triggers
        game.isTransitioning = true;

        // Apply scores first, then reveal answer so points update together
        debugLog(`[Quiz] Applying pending scores for Q${game.currentQuestionIndex}`);
        applyPendingScoreUpdates(gameId);

        // Now reveal answer with updated scores
        debugLog(`[Quiz] Revealing answer for Q${game.currentQuestionIndex}`);
        broadcastQuizGameState(gameId, true);

        // Wait 3 seconds to show answer, then move to next question
        setTimeout(() => {
          const g = quizGames.get(gameId);
          if (!g) return;

          debugLog(`[Quiz] Timeout fired, advancing from Q${g.currentQuestionIndex} to Q${g.currentQuestionIndex + 1}`);

          if (g.currentQuestionIndex < g.questions.length - 1) {
            // Advance to next question
            g.currentQuestionIndex++;
            g.hintsRevealed = 0;
            g.pendingScoreUpdates = [];  // Clear pending scores for new question
            g.isTransitioning = false;  // Clear transition flag

            // Start timer (which broadcasts initial state)
            debugLog(`[Quiz] Starting timer for new Q${g.currentQuestionIndex}`);
            startQuizQuestionTimer(gameId);
            // Don't broadcast again - startQuizQuestionTimer already broadcasts
          } else {
            endQuizGame(gameId);
          }
        }, 3000);
      }
    });

    socket.on('quiz-anticheat-trigger', (data) => {
      const { gameId, playerId, timestamp } = data;
      console.log(`[Quiz] Anti-cheat triggered for player ${playerId} in game ${gameId}`);

      // Broadcast to other players in this game room only
      socket.to(gameId).emit('quiz-anticheat-trigger', {
        gameId,
        playerId,
        timestamp
      });
    });

    socket.on('quiz-request-sync', (data) => {
      const { gameId, requesterId } = data;
      debugLog(`[Quiz] Player ${requesterId} requested sync for game ${gameId}`);

      const game = quizGames.get(gameId);
      if (game) {
        // Server sends authoritative state directly
        broadcastQuizGameState(gameId, false);
      }
    });

    socket.on('lobby-name-update', (data) => {
      const { gameId, lobbyName, timestamp } = data;
      console.log(`[Lobby] Name updated to "${lobbyName}" for game ${gameId}`);

      // Update the lobby name in the game registry
      updateLobbyName(gameId, lobbyName);

      // Broadcast lobby name change to all players in this game room
      io.to(gameId).emit('lobby-name-update', {
        gameId,
        lobbyName,
        timestamp
      });
    });

    socket.on('lobby-metadata-update', (data) => {
      const { gameId, quizType, questions, selectedCategories, aiGeneratedBoard } = data;
      console.log(`[Lobby] Metadata updated for game ${gameId}`);

      // Update the lobby metadata in the game registry
      const game = gameRegistry.get(gameId);
      if (game) {
        if (quizType !== undefined) game.quizType = quizType;
        if (questions !== undefined) game.questions = questions;
        if (selectedCategories !== undefined) game.selectedCategories = selectedCategories;
        if (aiGeneratedBoard !== undefined) game.aiGeneratedBoard = aiGeneratedBoard;
      }
    });

    socket.on('quiz-next-question', (data) => {
      const { gameId, questionIndex } = data;

      const game = quizGames.get(gameId);
      if (!game) return;

      debugLog(`[Quiz] Host requested move to question ${questionIndex} in game ${gameId} (currently on Q${game.currentQuestionIndex})`);

      // Check if we've already advanced to this question (e.g., via auto-advance)
      // If questionIndex <= currentQuestionIndex, we're already there or past it - ignore
      if (questionIndex <= game.currentQuestionIndex) {
        debugLog(`[Quiz] Already on or past question ${questionIndex} - ignoring manual next request`);
        return;
      }

      // Ignore if already transitioning
      if (game.isTransitioning) {
        debugLog(`[Quiz] Already transitioning - ignoring manual next request`);
        return;
      }

      game.isTransitioning = true;

      // First apply scores, then reveal answer so points update together
      debugLog(`[Quiz] Manual advance: applying scores for Q${game.currentQuestionIndex} before advancing to Q${questionIndex}`);
      applyPendingScoreUpdates(gameId);

      // Now reveal current answer with updated scores
      debugLog(`[Quiz] Manual advance: revealing Q${game.currentQuestionIndex} answer`);
      broadcastQuizGameState(gameId, true);

      // Wait briefly to show answer, then move to next question
      setTimeout(() => {
        const g = quizGames.get(gameId);
        if (!g) return;

        if (questionIndex < g.questions.length) {
          g.currentQuestionIndex = questionIndex;
          g.hintsRevealed = 0;
          g.pendingScoreUpdates = [];  // Clear pending scores for new question
          g.isTransitioning = false;
          startQuizQuestionTimer(gameId);
          // Don't broadcast again - startQuizQuestionTimer already broadcasts
        } else {
          endQuizGame(gameId);
        }
      }, 1500);  // Shorter delay for manual advance
    });

    socket.on('quiz-end', (data) => {
      const { gameId } = data;
      endQuizGame(gameId);
    });

    socket.on('quiz-leave', (data) => {
      const { gameId, playerId } = data;
      console.log(`[Quiz] Player ${playerId} is leaving game ${gameId}`);

      if (joinedGames.get(gameId) === playerId) joinedGames.delete(gameId);
      markGamePlayerDisconnected(io, gameId, playerId);
    });

    // Quiz challenge events
    socket.on('quiz-challenge', (data) => {
      const { challengerId, challengerName, targetUserId, gameId, timestamp } = data;
      console.log(`[Quiz] ${challengerName} challenged ${targetUserId} to quiz (game: ${gameId})`);

      // Broadcast to all OTHER clients (target will receive it)
      socket.broadcast.emit('quiz-challenge', {
        challengerId,
        challengerName,
        targetUserId,
        gameId,
        timestamp
      });
    });

    socket.on('quiz-challenge-response', (data) => {
      const { responderId, responderName, challengerId, accepted, gameId, timestamp } = data;
      console.log(`[Quiz] ${responderName} ${accepted ? 'accepted' : 'declined'} quiz challenge from ${challengerId}`);

      // Broadcast to all OTHER clients (challenger will receive it)
      socket.broadcast.emit('quiz-challenge-response', {
        responderId,
        responderName,
        challengerId,
        accepted,
        gameId,
        timestamp
      });
    });

    socket.on('quiz-sync-players', (data) => {
      const { gameId, players, timestamp } = data;
      debugLog(`[Quiz] Received player sync request for game ${gameId}`);

      // Check if there's an active quiz game (server-authoritative)
      const quizGame = quizGames.get(gameId);
      if (quizGame) {
        debugLog(`[Quiz] Ignoring client player sync - server is authoritative during active quiz`);
        return;
      }

      // Only allow in lobby phase (before quiz starts)
      debugLog(`[Quiz] Syncing ${players.length} players for game ${gameId} (lobby phase)`);

      // Update registry with latest player list
      updateGamePlayers(gameId, players);

      // Get lobby name from registry
      const game = gameRegistry.get(gameId);
      const lobbyName = game ? game.lobbyName : null;

      // Broadcast to other players in this game room only
      socket.to(gameId).emit('quiz-sync-players', {
        gameId,
        players,
        lobbyName,
        timestamp
      });
    });

    socket.on('grid-request-sync', (data) => {
      const { gameId, requesterId } = data;
      debugLog(`[Grid] Player ${requesterId} requested sync for game ${gameId}`);

      // For Grid, server is authoritative - send current state directly to requester
      const game = gridGames.get(gameId);
      if (game) {
        debugLog(`[Grid] Sending current state to ${requesterId}`);

        // Send full game state to the requesting player
        io.to(gameId).emit('grid-state-update', {
          gameId,
          state: game.state,
          board: game.board,
          currentTile: game.currentTile,
          currentBuzzer: game.currentBuzzer,
          buzzerWindow: game.buzzerWindow,
          timeRemaining: game.timeRemaining,
          attemptedPlayers: game.attemptedPlayers,
          selector: game.selector,
          showingAnswer: game.showingAnswer,
          lastCorrectAnswerer: game.lastCorrectAnswerer,
          answeredTiles: game.answeredTiles,
          selectedCategories: game.selectedCategories,
          gameTimeRemaining: game.gameTimeRemaining,
          players: game.players,
          scoreHistory: game.scoreHistory
        });
      } else {
        console.log(`[Grid] Game ${gameId} not found for sync request`);
      }
    });

    socket.on('grid-leave', (data) => {
      const { gameId, playerId } = data;
      console.log(`[Grid] Player ${playerId} is leaving game ${gameId}`);

      if (joinedGames.get(gameId) === playerId) joinedGames.delete(gameId);
      markGamePlayerDisconnected(io, gameId, playerId);
    });

    socket.on('grid-sync-players', (data) => {
      const { gameId, players, timestamp } = data;
      debugLog(`[Grid] Syncing ${players.length} players for game ${gameId}`);

      // Update registry with latest player list
      updateGamePlayers(gameId, players);

      // Update server-side game state
      const game = gridGames.get(gameId);
      if (game) {
        game.players = players;

        // Only end game if all players are gone (not just disconnected)
        // This allows reconnection
        const connectedPlayers = players.filter(p => p.connected !== false);
        if (players.length === 0) {
          console.log(`[Grid] All players removed from game ${gameId}, ending game`);
          endGridGame(gameId);
          return; // Don't broadcast if game is ending
        } else if (connectedPlayers.length === 0 && players.length > 0) {
          console.log(`[Grid] All players disconnected from game ${gameId}, but keeping game alive for reconnection`);
        }
      }

      // Broadcast to other players in this game room only
      const registryGame = gameRegistry.get(gameId);
      // Use stored lobby name or generate default from host's name
      const hostName = registryGame?.hostId ? registryGame.hostId.split('@')[0] : 'Host';
      const effectiveLobbyName = registryGame?.lobbyName || `${hostName}'s Lobby`;
      socket.to(gameId).emit('grid-sync-players', {
        gameId,
        players,
        lobbyName: effectiveLobbyName,
        timestamp
      });
    });

    // Grid game events
    socket.on('grid-join', (data) => {
      const { gameId, playerId, playerName, clientType, timestamp } = data;
      const playerType = clientType || 'app';
      console.log(`[Grid] Player ${playerName} (${playerType}) joined game ${gameId}`);

      // Web clients can only join existing lobbies, not create new ones
      if (!gameRegistry.has(gameId)) {
        if (playerType === 'web') {
          console.log(`[Grid] Web client ${playerName} attempted to create lobby ${gameId} - rejected`);
          socket.emit('grid-join-rejected', {
            gameId,
            reason: 'This lobby does not exist. Web clients can only join existing lobbies created from the app.',
            timestamp: Date.now()
          });
          return;
        }
        // Only app clients can create new lobbies
        registerGame(gameId, 'grid', playerId);
      }

      // Update player list in registry
      const game = gameRegistry.get(gameId);
      let isReconnection = false;
      if (game) {
        const playerExists = game.players.some(p => p.id === playerId);

        // Prevent new players from joining a game already in progress
        if (!playerExists && game.status === 'playing') {
          console.log(`[Grid] Player ${playerName} attempted to join in-progress game ${gameId} - rejected`);
          socket.emit('grid-join-rejected', {
            gameId,
            reason: 'Game is already in progress. You can only join games in the lobby.',
            timestamp: Date.now()
          });
          return;
        }

        if (!playerExists) {
          game.players.push({ id: playerId, name: playerName, score: 0, connected: true, status: 'ready', ready: true, clientType: playerType });
        } else {
          // Reconnection - mark as connected and ensure score/status is set, preserve/update clientType
          isReconnection = true;
          game.players = game.players.map(p =>
            p.id === playerId ? { ...p, connected: true, score: p.score || 0, status: 'ready', ready: true, clientType: p.clientType || playerType } : p
          );
        }

        // Also update authoritative Grid state if game has started
        const gridGame = gridGames.get(gameId);
        if (gridGame && gridGame.players) {
          gridGame.players = gridGame.players.map(p =>
            p.id === playerId ? { ...p, connected: true, status: 'ready', ready: true } : p
          );
        }
      }

      // Join this socket to the game room
      socket.join(gameId);
      joinedGames.set(gameId, playerId);
      debugLog(`[Grid] Socket ${socket.id} joined room ${gameId}`);

      if (isReconnection) {
        // Player reconnected
        console.log(`[Grid] Player ${playerName} reconnected`);

        // If game has started, broadcast full authoritative state
        const gridGame = gridGames.get(gameId);
        if (gridGame) {
          debugLog(`[Grid] Game in progress, broadcasting full authoritative state`);
          broadcastGameState(gameId);
        } else {
          // Still in lobby - broadcast player list sync
          debugLog(`[Grid] Broadcasting player list (lobby reconnection)`);
          const playersWithScores = game.players.map(p => ({
            ...p,
            score: p.score ?? 0
          }));
          // Use stored lobby name or generate default from host's name
          const hostName = game.hostId ? game.hostId.split('@')[0] : 'Host';
          const effectiveLobbyName = game.lobbyName || `${hostName}'s Lobby`;
          io.to(gameId).emit('grid-sync-players', {
            gameId,
            players: playersWithScores,
            lobbyName: effectiveLobbyName,
            timestamp
          });
        }
      } else {
        // New player - broadcast join to other players in this game room only
        socket.to(gameId).emit('grid-join', {
          gameId,
          playerId,
          playerName,
          clientType: playerType,
          timestamp
        });

        // Send current player list to the joining player so they can see everyone
        const playersWithScores = game.players.map(p => ({
          ...p,
          score: p.score ?? 0
        }));
        // Use stored lobby name or generate default from host's name
        const hostName = game.hostId ? game.hostId.split('@')[0] : 'Host';
        const effectiveLobbyName = game.lobbyName || `${hostName}'s Lobby`;
        socket.emit('grid-sync-players', {
          gameId,
          players: playersWithScores,
          lobbyName: effectiveLobbyName,
          timestamp
        });
      }
    });

    socket.on('grid-start', (data) => {
      const { gameId, board, selectedCategories, players } = data;
      console.log(`[Grid] Game ${gameId} started with ${selectedCategories.length} categories`);

      // Update game status to playing
      updateGameStatus(gameId, 'playing');

      // Store selected categories in registry if not already stored
      const registryGame = gameRegistry.get(gameId);
      if (registryGame && selectedCategories) {
        registryGame.selectedCategories = selectedCategories;
      }

      // Ensure host is in the game room
      socket.join(gameId);
      debugLog(`[Grid] Host socket ${socket.id} joined room ${gameId}`);

      // Create authoritative game state
      const lobbyName = registryGame?.lobbyName || 'Grid Lobby';
      createGridGame(gameId, board, selectedCategories, machineId, players, lobbyName);

      // Broadcast initial state to ALL players in the game room
      broadcastGameState(gameId);
    });

    socket.on('grid-select-tile', (data) => {
      const { gameId, playerId, tile } = data;
      const game = gridGames.get(gameId);
      if (!game) return;

      // Ignore tile selections if game has ended
      if (game.state === 'ended') {
        debugLog(`[Grid] ${playerId} tried to select tile but game has ended`);
        return;
      }

      // Validate: is this player the selector?
      if (game.selector !== playerId) {
        debugLog(`[Grid] ${playerId} tried to select but is not selector`);
        return;
      }

      // Validate: is tile already answered?
      const tileOnBoard = game.board.find(t =>
        t.categoryId === tile.categoryId && t.difficulty === tile.difficulty
      );
      if (!tileOnBoard || tileOnBoard.answered) {
        debugLog(`[Grid] Invalid tile selection`);
        return;
      }

      debugLog(`[Grid] ${playerId} selected tile in game ${gameId}`);

      // Update game state
      game.state = 'question';
      game.currentTile = tile;
      game.buzzerWindow = false; // Don't open buzz window yet - typing first
      game.attemptedPlayers = [];
      game.currentBuzzer = null;
      game.lastCorrectAnswerer = undefined; // Clear previous result
      game.incorrectAnswers = []; // Clear incorrect answers for new question

      // Start typewriter effect - buzz window will open after typing completes
      startTyping(gameId);
    });

    socket.on('grid-buzz', (data) => {
      const { gameId, playerId } = data;
      const game = gridGames.get(gameId);
      if (!game) return;

      // Ignore buzzes if game has ended
      if (game.state === 'ended') {
        debugLog(`[Grid] ${playerId} tried to buzz but game has ended`);
        return;
      }

      // Validate: typing must be in progress OR buzz window must be open
      if (!game.typingInProgress && !game.buzzerWindow) {
        debugLog(`[Grid] ${playerId} tried to buzz but neither typing nor buzz window is active`);
        return;
      }

      // Validate: player hasn't already attempted
      if (game.attemptedPlayers.includes(playerId)) {
        debugLog(`[Grid] ${playerId} already attempted this question`);
        return;
      }

      debugLog(`[Grid] ${playerId} buzzed in game ${gameId}`);

      // If typing is in progress, pause it
      if (game.typingInProgress) {
        pauseTyping(gameId);
      }

      // Give buzzer to player
      game.buzzerWindow = false;
      game.currentBuzzer = playerId;

      // Start answer timer
      startQuestionTimer(gameId, GRID_ANSWER_TIME, () => {
        // Answer timeout - deduct points
        const game = gridGames.get(gameId);
        if (!game || !game.currentBuzzer) return;

        // Don't deduct points if game has ended
        if (game.state === 'ended') {
          debugLog(`[Grid] Game ended, skipping timeout penalty for ${game.currentBuzzer}`);
          return;
        }

        debugLog(`[Grid] Answer timeout for ${game.currentBuzzer}`);

        // Deduct points
        game.players = game.players.map(p =>
          p.id === game.currentBuzzer ? { ...p, score: p.score - game.currentTile.points } : p
        );

        // Update score history
        game.players.forEach(p => {
          game.scoreHistory[p.id].push(p.score);
        });

        // Add to attempted
        game.attemptedPlayers.push(game.currentBuzzer);
        game.currentBuzzer = null;

        // Check if players remain
        const remainingPlayers = game.players.filter(p => !game.attemptedPlayers.includes(p.id));

        if (remainingPlayers.length > 0) {
          // If typing was paused, resume it
          if (game.typingPausedAt !== null) {
            resumeTyping(gameId);
          } else {
            // Otherwise, reopen buzz window normally
            game.buzzerWindow = true;
            startQuestionTimer(gameId, GRID_BUZZ_WINDOW, () => {
              // Handle nested buzz window timeout (same logic as above)
              handleAllPlayersAttempted(gameId, io);
            });
          }
        } else {
          handleAllPlayersAttempted(gameId, io);
        }

        broadcastGameState(gameId);
      });

      broadcastGameState(gameId);
    });

    socket.on('grid-answer', (data) => {
      const { gameId, playerId, answer, correct } = data;
      const game = gridGames.get(gameId);
      if (!game) return;

      // Ignore answers if game has ended
      if (game.state === 'ended') {
        debugLog(`[Grid] ${playerId} tried to answer but game has ended`);
        return;
      }

      // Validate: player must have the buzzer
      if (game.currentBuzzer !== playerId) {
        debugLog(`[Grid] ${playerId} tried to answer but doesn't have buzzer`);
        return;
      }

      debugLog(`[Grid] ${playerId} answered: ${correct ? 'correct' : 'incorrect'}`);

      // Clear question timer
      if (game.questionTimer) {
        clearInterval(game.questionTimer);
        game.questionTimer = null;
      }

      // Check again if game ended (race condition protection)
      // Game timer could have expired while this handler was processing
      if (game.state === 'ended') {
        debugLog(`[Grid] Game ended while processing answer from ${playerId} - ignoring answer`);
        return;
      }

      const pointsEarned = correct ? game.currentTile.points : -game.currentTile.points;

      // Update score
      game.players = game.players.map(p =>
        p.id === playerId ? { ...p, score: p.score + pointsEarned } : p
      );

      // Update score history
      game.players.forEach(p => {
        game.scoreHistory[p.id].push(p.score);
      });

      if (correct) {
        // Correct answer - mark tile and return to board
        debugLog(`[Grid] Correct answer! ${playerId} is new selector`);

        game.selector = playerId;
        game.lastCorrectAnswerer = playerId; // Track who answered correctly

        markTileAsAnswered(game);
        game.currentBuzzer = null;

        // Show answer for 3 seconds
        game.state = 'showing-answer';
        broadcastGameState(gameId);

        setTimeout(() => {
          const game = gridGames.get(gameId);
          if (!game) return;
          if (game.state === 'ended') return; // Don't reset if game ended

          resetQuestionState(game);
          broadcastGameState(gameId);
        }, 3000);
      } else {
        // Incorrect answer
        game.attemptedPlayers.push(playerId);
        game.currentBuzzer = null;

        // Store incorrect answer
        const player = game.players.find(p => p.id === playerId);
        if (player && answer) {
          game.incorrectAnswers.push({
            playerId: playerId,
            playerName: player.name,
            answer: answer.trim()
          });
        }

        const remainingPlayers = game.players.filter(p => !game.attemptedPlayers.includes(p.id));

        if (remainingPlayers.length > 0) {
          // If typing was paused, resume it
          if (game.typingPausedAt !== null) {
            resumeTyping(gameId);
          } else {
            // Otherwise, reopen buzz window normally
            reopenBuzzWindow(gameId);
          }
          broadcastGameState(gameId);
        } else {
          handleAllPlayersAttempted(gameId, io);
        }
      }
    });

    // Grid join handled separately - players join before game starts
    // No need for grid-end, grid-sync-players, or grid-return-to-board
    // Server manages all state transitions authoritatively

    // ========================================================================
    // Tiles Game Event Handlers
    // ========================================================================

    debugLog('[Server] Registering tiles-create-lobby handler');

    socket.on('tiles-create-lobby', (data) => {
      debugLog('[Tiles] tiles-create-lobby event received!', data);
      const { lobbyId, playerId, playerName, gridSize, isSinglePlayer } = data;
      console.log(`[Tiles] Creating lobby ${lobbyId} for ${playerName} (grid: ${gridSize}×${gridSize}, single: ${isSinglePlayer})`);

      // Create game in registry
      registerGame(lobbyId, 'tiles', playerId);

      const game = gameRegistry.get(lobbyId);
      if (game) {
        // Add the host as first player
        game.players.push({
          id: playerId,
          name: playerName,
          score: 0,
          connected: true,
          status: 'ready',
          ready: true,
          clientType: 'app',
          socketId: socket.id
        });

        game.gridSize = gridSize;
        game.isSinglePlayer = isSinglePlayer;
        debugLog(`[Tiles] Game created in registry:`, {
          gameId: game.gameId,
          mode: game.mode,
          status: game.status,
          players: game.players.length,
          isSinglePlayer: game.isSinglePlayer
        });

        // Host joins the socket room
        socket.join(lobbyId);
        joinedGames.set(lobbyId, playerId);
      }

      // Send lobby created event
      io.to(lobbyId).emit('tiles-lobby-created', {
        lobbyId,
        players: game.players,
        gridSize,
        isSinglePlayer,
        timestamp: Date.now()
      });

      // If single player, auto-start
      if (isSinglePlayer) {
        setTimeout(() => {
          const tilesGame = createTilesGame(lobbyId, gridSize, game.players, true);
          updateGameStatus(lobbyId, 'playing');

          // Get the player's grid from playerStates
          const player = game.players[0];
          const playerState = tilesGame.playerStates[player.id];

          io.to(lobbyId).emit('tiles-game-started', {
            lobbyId,
            myGrid: playerState.grid,
            timestamp: Date.now()
          });
        }, 500);
      }
    });

    socket.on('tiles-join-lobby', (data) => {
      const { lobbyId, playerId, playerName, clientType } = data;
      const playerType = clientType || 'app';
      console.log(`[Tiles] ${playerName} (${playerType}) joining lobby ${lobbyId}`);

      const game = gameRegistry.get(lobbyId);
      if (!game) {
        console.log(`[Tiles] Lobby ${lobbyId} not found`);
        socket.emit('tiles-join-rejected', {
          lobbyId,
          reason: 'This lobby does not exist.',
          timestamp: Date.now()
        });
        return;
      }

      let isReconnection = false;
      const playerExists = game.players.some(p => p.id === playerId);

      // Prevent new players from joining a game already in progress
      if (!playerExists && game.status === 'playing') {
        console.log(`[Tiles] Player ${playerName} attempted to join in-progress game ${lobbyId} - rejected`);
        socket.emit('tiles-join-rejected', {
          lobbyId,
          reason: 'Game is already in progress. You can only join games in the lobby.',
          timestamp: Date.now()
        });
        return;
      }

      // Check if lobby is full (only for new players, not reconnections)
      if (!playerExists && game.players.length >= 30) {
        console.log(`[Tiles] Lobby ${lobbyId} is full`);
        socket.emit('tiles-join-rejected', {
          lobbyId,
          reason: 'Lobby is full.',
          timestamp: Date.now()
        });
        return;
      }

      if (!playerExists) {
        // New player joining
        game.players.push({
          id: playerId,
          name: playerName,
          score: 0,
          connected: true,
          status: 'ready',
          ready: true,
          clientType: playerType,
          socketId: socket.id
        });
      } else {
        // Reconnection - mark as connected and ensure status is set, preserve/update clientType
        isReconnection = true;
        game.players = game.players.map(p =>
          p.id === playerId ? {
            ...p,
            connected: true,
            socketId: socket.id,
            status: 'ready',
            ready: true,
            clientType: p.clientType || playerType
          } : p
        );

        // Also update authoritative tiles game state if it exists
        const tilesGame = tilesGames.get(lobbyId);
        if (tilesGame && tilesGame.playerStates && tilesGame.playerStates[playerId]) {
          console.log(`[Tiles] Player ${playerName} reconnected to active game ${lobbyId}`);
          // Player state already exists, just mark them as reconnected in the players list
          tilesGame.players = tilesGame.players.map(p =>
            p.id === playerId ? { ...p, connected: true, socketId: socket.id } : p
          );
        }
      }

      // Join this socket to the game room
      socket.join(lobbyId);
      joinedGames.set(lobbyId, playerId);
      debugLog(`[Tiles] Socket ${socket.id} joined room ${lobbyId}`);

      if (isReconnection) {
        // Player reconnected
        console.log(`[Tiles] Player ${playerName} (${playerId}) reconnected to game ${lobbyId}`);

        // Check if there's an active tiles game
        const tilesGame = tilesGames.get(lobbyId);
        if (tilesGame) {
          // Active game - broadcast state immediately
          debugLog(`[Tiles] Broadcasting game state (reconnection during active game)`);
          broadcastTilesGameState(lobbyId);
        } else if (game.status === 'lobby') {
          // In lobby - broadcast player list
          debugLog(`[Tiles] Broadcasting player list (lobby reconnection)`);
          io.to(lobbyId).emit('tiles-player-joined', {
            lobbyId,
            players: game.players,
            lobbyName: game.lobbyName || `${game.hostId?.split('@')[0] || 'Unknown'}'s Tiles`,
            isReconnection: true,
            timestamp: Date.now()
          });
        }
      } else {
        // New player - broadcast join to all players
        io.to(lobbyId).emit('tiles-player-joined', {
          lobbyId,
          players: game.players,
          lobbyName: game.lobbyName || `${game.hostId?.split('@')[0] || 'Unknown'}'s Tiles`,
          timestamp: Date.now()
        });
      }
    });

    socket.on('tiles-start', (data) => {
      const { lobbyId } = data;
      console.log(`[Tiles] Starting game ${lobbyId}`);

      const game = gameRegistry.get(lobbyId);
      if (!game || game.players.length < 1) {
        console.log(`[Tiles] Cannot start - invalid lobby or no players`);
        return;
      }

      const gridSize = game.gridSize || 5;

      // Use only CONNECTED players (filter out disconnected ones)
      const connectedPlayers = game.players.filter(p => p.connected !== false);
      debugLog(`[Tiles] Connected players: ${connectedPlayers.length}/${game.players.length}`);

      const tilesGame = createTilesGame(lobbyId, gridSize, connectedPlayers, false);
      updateGameStatus(lobbyId, 'playing');

      // Send individual grids to each player
      // Use connectedClients map to find current socket for each player
      debugLog(`[Tiles] Sending game-started to ${connectedPlayers.length} players`);

      connectedPlayers.forEach((player) => {
        const playerState = tilesGame.playerStates[player.id];

        // Build opponent states for this player
        const opponentStates = connectedPlayers
          .filter(p => p.id !== player.id)
          .map(p => ({
            id: p.id,
            name: p.name,
            moves: tilesGame.playerStates[p.id].moves,
            solved: tilesGame.playerStates[p.id].solved,
            grid: tilesGame.playerStates[p.id].grid
          }));

        // Use player.socketId for both app and web clients
        if (player.socketId) {
          debugLog(`[Tiles] Sending to player ${player.name} (${player.id}, clientType: ${player.clientType}) via socket ${player.socketId}`);
          debugLog(`[Tiles] Grid size for ${player.name}: ${playerState.grid.length}x${playerState.grid[0]?.length}`);
          io.to(player.socketId).emit('tiles-game-started', {
            lobbyId,
            myGrid: playerState.grid,
            opponentStates,
            timestamp: Date.now()
          });
        } else {
          console.warn(`[Tiles] Player ${player.name} (${player.id}) has no socketId`);
        }
      });
      debugLog(`[Tiles] Game started event sent`);
    });

    socket.on('tiles-cell-click', (data) => {
      const { lobbyId, playerId, row, col } = data;
      const game = tilesGames.get(lobbyId);
      if (!game || game.state !== 'playing') return;

      const playerState = game.playerStates[playerId];
      if (!playerState) {
        console.error(`[Tiles] Player ${playerId} not found in game ${lobbyId}`);
        return;
      }

      debugLog(`[Tiles] ${playerId} clicked cell [${row},${col}] in ${lobbyId}`);

      // Toggle the cell
      toggleTilesCell(playerState.grid, row, col);

      // Increment moves
      playerState.moves++;

      // Check if solved
      if (checkTilesSolved(playerState.grid)) {
        console.log(`[Tiles] Player ${playerId} solved the puzzle in ${playerState.moves} moves!`);
        playerState.solved = true;
        playerState.solvedAt = Date.now();

        // Mark winner if first to solve
        if (!game.winner) {
          game.winner = playerId;
          console.log(`[Tiles] ${playerId} is the winner!`);
        }

        // Check if all connected players have finished (solved or gave up)
        const connectedPlayers = game.players.filter(p => p.connected !== false);
        const allFinished = connectedPlayers.every(p => {
          const state = game.playerStates[p.id];
          return state.solved || state.gaveUp;
        });

        if (allFinished) {
          console.log(`[Tiles] All players finished - ending game`);
          endTilesGame(lobbyId, game.winner);
        } else {
          // Some players still playing, broadcast updated state
          broadcastTilesGameState(lobbyId);
        }
      } else {
        broadcastTilesGameState(lobbyId);
      }
    });

    socket.on('tiles-give-up', (data) => {
      const { lobbyId, playerId } = data;
      console.log(`[Tiles] Player ${playerId} gave up in game ${lobbyId}`);

      const game = tilesGames.get(lobbyId);
      if (!game || game.state !== 'playing') return;

      const playerState = game.playerStates[playerId];
      if (!playerState) return;

      // Mark as gave up
      playerState.gaveUp = true;
      playerState.gaveUpAt = Date.now();
      console.log(`[Tiles] Player ${playerId} marked as gave up`);

      // Check if all connected players have finished
      const connectedPlayers = game.players.filter(p => p.connected !== false);
      const allFinished = connectedPlayers.every(p => {
        const state = game.playerStates[p.id];
        return state.solved || state.gaveUp;
      });

      if (allFinished) {
        console.log(`[Tiles] All players finished - ending game`);
        endTilesGame(lobbyId, game.winner || null);
      } else {
        // Some players still playing, broadcast updated state
        broadcastTilesGameState(lobbyId);
      }
    });

    socket.on('tiles-leave-lobby', (data) => {
      const { lobbyId, playerId } = data;
      console.log(`[Tiles] Player ${playerId} is leaving game ${lobbyId}`);

      if (joinedGames.get(lobbyId) === playerId) joinedGames.delete(lobbyId);
      markGamePlayerDisconnected(io, lobbyId, playerId);

      socket.leave(lobbyId);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      // Mark every game player associated with this socket as disconnected
      // (kept in the player list so they can reconnect; the stale-game sweep
      // removes fully abandoned games after the grace period). This covers:
      //  - authenticated app clients, whose playerId is their machineId;
      //  - unauthenticated web game clients, tracked per-socket via
      //    joinedGames (previously these were never marked disconnected,
      //    so abandoned games stayed listed as "running" forever).
      const toMark = new Map(); // gameId -> Set of playerIds
      const addPlayer = (gameId, playerId) => {
        if (!toMark.has(gameId)) toMark.set(gameId, new Set());
        toMark.get(gameId).add(playerId);
      };

      if (machineId) {
        for (const [gameId, game] of gameRegistry.entries()) {
          if (game.players.some(p => p.id === machineId)) {
            addPlayer(gameId, machineId);
          }
        }
      }
      for (const [gameId, playerId] of joinedGames.entries()) {
        addPlayer(gameId, playerId);
      }

      for (const [gameId, playerIds] of toMark.entries()) {
        for (const playerId of playerIds) {
          console.log(`[WebSocket] Marking player ${playerId} as disconnected in game ${gameId}`);
          markGamePlayerDisconnected(io, gameId, playerId);
        }
      }
      joinedGames.clear();

      if (machineId) {
        const remaining = detachClientSocket(machineId, socket);
        if (remaining === 0) {
          // the identity's last device left: clean up all cursors for this user
          cleanupUserCursors(machineId, io);
          displayNames.delete(machineId);
        }
        console.log(`[WebSocket] Client disconnected: ${machineId}${remaining ? ` (${remaining} other socket(s) of this identity stay connected)` : ''}`);
        console.log(`[WebSocket] Connected clients: ${connectedClients.size}`);

        // Broadcast updated connected users list to all remaining clients
        broadcastConnectedUsers(io);
      } else {
        console.log(`[WebSocket] Unauthenticated client disconnected: ${socket.id}`);
      }
    });
  });
}

module.exports = { registerSocketHandlers };
