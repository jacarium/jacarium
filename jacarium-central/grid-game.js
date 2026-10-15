/**
 * Grid game mode (authoritative server) - constants, game lifecycle,
 * typewriter flow and the countdown timer helpers.
 *
 * NOTE: the countdown timer helpers (startCountdownTimer / startGameTimer /
 * startQuestionTimer) live here rather than in a separate module because
 * they operate directly on gridGames and call broadcastGameState /
 * endGridGame, which would make a separate timers module circularly
 * dependent on this one. Quiz mode has its own timer (startQuizQuestionTimer
 * in quiz-game.js) and does not use these.
 *
 * Extracted verbatim from server.js (structural refactor only).
 */

const { gridGames, getIoInstance, debugLog } = require('./state');
const { updateGameStatus, unregisterGame } = require('./game-registry');

// ============================================================================
// Grid Game Constants and State
// ============================================================================

// Grid game constants
const GRID_BUZZ_WINDOW = 10;  // 10 seconds to buzz in
const GRID_ANSWER_TIME = 10;  // 10 seconds to answer
const GRID_GAME_TIME = 300;  // 5 minutes total game time
const TYPING_SPEED_MS = 50;  // 50ms per character for typewriter effect
const TYPING_DELAY_MS = 1000;  // 1 second delay before starting typewriter

/**
 * Create a new Grid game
 */
function createGridGame(gameId, board, selectedCategories, hostId, players, lobbyName) {
  const game = {
    gameId,
    board,
    selectedCategories,
    hostId,
    players: players.map(p => ({ ...p, score: 0 })),
    scoreHistory: {},
    answeredTiles: [],
    currentTile: null,
    currentBuzzer: null,
    buzzerWindow: false,
    attemptedPlayers: [],
    lastCorrectAnswerer: null, // playerId of who answered correctly, or null
    selector: hostId,
    gameTimeRemaining: GRID_GAME_TIME,
    questionTimeRemaining: 0,
    state: 'board', // 'board', 'question', 'showing-answer', 'ended'
    gameTimer: null,
    questionTimer: null,
    lobbyName: lobbyName || 'Grid Lobby',
    // Typewriter effect state
    typingInProgress: false,
    typingStartTime: null,
    typingDuration: 0,
    typingPausedAt: null,  // Character index where typing paused (when someone buzzed)
    // Incorrect answers for current question
    incorrectAnswers: []  // [{playerId, playerName, answer}]
  };

  // Initialize score history
  players.forEach(p => {
    game.scoreHistory[p.id] = [0];
  });

  gridGames.set(gameId, game);

  // Start game timer
  startGameTimer(gameId);

  console.log(`[Grid] Created game ${gameId} with ${players.length} players`);
  return game;
}

// ============================================================================
// Grid Game Timers
// ============================================================================

/**
 * Start the main game countdown timer
 */
/**
 * Generic countdown timer - handles both game and question timers
 */
function startCountdownTimer(gameId, duration, timerKey, onExpire) {
  const game = gridGames.get(gameId);
  if (!game) return;

  // Clear existing timer if any
  const timerProp = timerKey === 'gameTimeRemaining' ? 'gameTimer' : 'questionTimer';
  if (game[timerProp]) {
    clearInterval(game[timerProp]);
  }

  game[timerKey] = duration;

  const interval = setInterval(() => {
    const g = gridGames.get(gameId);
    if (!g) {
      clearInterval(interval);
      return;
    }

    g[timerKey]--;
    // Per-second ticks only carry the countdown numbers. The full game
    // payload (board, players, scoreHistory, ...) is broadcast by the
    // actual state-changing events (tile select / buzz / answer / typing
    // transitions), not from the timer.
    broadcastTimerTick(gameId);

    if (g[timerKey] <= 0) {
      clearInterval(interval);
      g[timerProp] = null;
      onExpire();
    }
  }, 1000);

  game[timerProp] = interval;
  return interval;
}

function startGameTimer(gameId) {
  startCountdownTimer(
    gameId,
    GRID_GAME_TIME,
    'gameTimeRemaining',
    () => endGridGame(gameId)
  );
}

/**
 * Start question timer (buzz window or answer time)
 */
function startQuestionTimer(gameId, duration, onExpire) {
  startCountdownTimer(
    gameId,
    duration,
    'questionTimeRemaining',
    onExpire
  );
}

/**
 * Broadcast a lightweight per-second countdown tick to the game room.
 *
 * Deliberately tiny: it carries ONLY the two countdown values (plus
 * serverTime for clock sync). Sending broadcastGameState() from the
 * 1s timer used to re-send the entire board/players/scoreHistory payload
 * every second to every room, doubling broadcast traffic for no
 * informational gain - real state changes already broadcast full state
 * from their own handlers.
 */
function broadcastTimerTick(gameId) {
  const game = gridGames.get(gameId);
  const ioInstance = getIoInstance();
  if (!game || !ioInstance) return;

  ioInstance.to(gameId).emit('grid-timer-tick', {
    gameId,
    gameTimeRemaining: game.gameTimeRemaining,
    questionTimeRemaining: game.questionTimeRemaining,
    serverTime: Date.now()
  });
}

/**
 * Broadcast current game state to all players in the game room
 */
function broadcastGameState(gameId) {
  const game = gridGames.get(gameId);
  const ioInstance = getIoInstance();
  if (!game || !ioInstance) return;

  // Send server time for clock synchronization
  const serverTime = Date.now();

  // Broadcast only to players in this game's room
  ioInstance.to(gameId).emit('grid-state-update', {
    gameId,
    state: game.state,
    board: game.board,
    players: game.players,
    scoreHistory: game.scoreHistory,
    currentTile: game.currentTile,
    currentBuzzer: game.currentBuzzer,
    buzzerWindow: game.buzzerWindow,
    attemptedPlayers: game.attemptedPlayers,
    lastCorrectAnswerer: game.lastCorrectAnswerer,
    selector: game.selector,
    gameTimeRemaining: game.gameTimeRemaining,
    questionTimeRemaining: game.questionTimeRemaining,
    answeredTiles: game.answeredTiles,
    lobbyName: game.lobbyName,
    typingInProgress: game.typingInProgress,
    typingStartTime: game.typingStartTime,
    typingDuration: game.typingDuration,
    typingPausedAt: game.typingPausedAt,
    serverTime: serverTime,  // For clock synchronization
    incorrectAnswers: game.incorrectAnswers
  });
}

/**
 * Mark the current tile as answered and add to answered tiles list
 */
function markTileAsAnswered(game) {
  game.board = game.board.map(t =>
    t.categoryId === game.currentTile.categoryId &&
    t.difficulty === game.currentTile.difficulty
      ? { ...t, answered: true }
      : t
  );
  // Store the question object with answer and source merged in
  // Ensure answer and source are at the top level for rendering
  const questionObj = typeof game.currentTile.question === 'object'
    ? game.currentTile.question
    : { question: game.currentTile.question };

  game.answeredTiles.push({
    ...questionObj,
    answer: questionObj.answer || game.currentTile.answer,
    source: questionObj.source || game.currentTile.source
  });
}

/**
 * Update score history for all players (push current scores)
 */
function updateScoreHistory(game) {
  game.players.forEach(p => {
    game.scoreHistory[p.id].push(p.score);
  });
}

/**
 * Reset question-related state and return to board
 */
function resetQuestionState(game) {
  game.state = 'board';
  game.currentTile = null;
  game.currentBuzzer = null;
  game.buzzerWindow = false;
  game.attemptedPlayers = [];
  game.lastCorrectAnswerer = undefined;
}

/**
 * Reopen the buzz window for remaining players
 */
function reopenBuzzWindow(gameId) {
  const game = gridGames.get(gameId);
  if (!game) return;

  game.buzzerWindow = true;
  startQuestionTimer(gameId, GRID_BUZZ_WINDOW, () => {
    handleAllPlayersAttempted(gameId);
  });
}

/**
 * Start typewriter effect for question
 */
function startTyping(gameId) {
  const game = gridGames.get(gameId);
  if (!game || !game.currentTile) return;

  const questionText = game.currentTile.question?.question || game.currentTile.question || '';
  const typingDurationMs = questionText.length * TYPING_SPEED_MS;
  const typingDurationSeconds = Math.ceil(typingDurationMs / 1000);
  

  debugLog(`[Grid] Starting typing delay for ${questionText.length} characters`);

  // Set typing state immediately with future start time
  game.typingInProgress = true;
  game.typingStartTime = Date.now() + TYPING_DELAY_MS;  // Future time when typing will actually start
  game.typingDuration = typingDurationSeconds;
  game.typingPausedAt = null;

  // Broadcast immediately so clients see the delay
  broadcastGameState(gameId);

  // Wait 1 second, then start the typing timer
  setTimeout(() => {
    const g = gridGames.get(gameId);
    if (!g || !g.currentTile || g.state === 'ended') return;

    // If typing was paused (someone buzzed during delay), don't start the timer
    if (!g.typingInProgress) {
      debugLog(`[Grid] Typing was paused during delay, skipping timer start`);
      return;
    }

    debugLog(`[Grid] Typing delay complete, starting character animation for ${questionText.length} characters`);

    // Start timer that will complete typing and open buzz window
    // Don't update typingStartTime - it's already set correctly
    startQuestionTimer(gameId, typingDurationSeconds, () => {
      completeTyping(gameId);
    });
  }, TYPING_DELAY_MS);
}

/**
 * Complete typing and open buzz window
 */
function completeTyping(gameId) {
  const game = gridGames.get(gameId);
  if (!game) return;

  debugLog(`[Grid] Typing complete for game ${gameId}, opening buzz window`);

  game.typingInProgress = false;
  game.typingStartTime = null;
  game.typingDuration = 0;
  game.typingPausedAt = null;
  game.buzzerWindow = true;

  // Start buzz window timer
  startQuestionTimer(gameId, GRID_BUZZ_WINDOW, () => {
    const g = gridGames.get(gameId);
    if (!g) return;

    if (g.state === 'ended') {
      debugLog(`[Grid] Game ended, skipping buzz window timeout`);
      return;
    }

    debugLog(`[Grid] Buzz window expired for game ${gameId} - showing answer`);
    markTileAsAnswered(g);
    g.lastCorrectAnswerer = 'none';
    updateScoreHistory(g);
    g.state = 'showing-answer';
    g.buzzerWindow = false;
    broadcastGameState(gameId);

    setTimeout(() => {
      const game = gridGames.get(gameId);
      if (!game) return;
      if (game.state === 'ended') return;
      game.state = 'board';
      game.currentTile = null;
      broadcastGameState(gameId);
    }, 3000);
  });

  broadcastGameState(gameId);
}

/**
 * Pause typing when someone buzzes in
 */
function pauseTyping(gameId) {
  const game = gridGames.get(gameId);
  if (!game || !game.typingInProgress) return;

  // Calculate how many characters have been typed so far
  const elapsed = Date.now() - game.typingStartTime;
  const questionText = game.currentTile.question?.question || game.currentTile.question || '';

  // If typing hasn't started yet (elapsed < 0), pause at character 0
  const charactersTyped = elapsed < 0
    ? 0
    : Math.min(Math.floor(elapsed / TYPING_SPEED_MS), questionText.length);

  game.typingPausedAt = charactersTyped;
  game.typingInProgress = false;

  // Clear the typing completion timer
  if (game.questionTimer) {
    clearInterval(game.questionTimer);
    game.questionTimer = null;
  }

  debugLog(`[Grid] Typing paused at character ${charactersTyped} of ${questionText.length} (elapsed: ${elapsed}ms)`);
  broadcastGameState(gameId);
}

/**
 * Resume typing after incorrect answer
 */
function resumeTyping(gameId) {
  const game = gridGames.get(gameId);
  if (!game || !game.currentTile || game.typingPausedAt === null) return;

  const questionText = game.currentTile.question?.question || game.currentTile.question || '';
  const remainingChars = questionText.length - game.typingPausedAt;
  const remainingDurationMs = remainingChars * TYPING_SPEED_MS;
  const remainingDurationSeconds = Math.ceil(remainingDurationMs / 1000);

  game.typingInProgress = true;
  game.typingStartTime = Date.now() - (game.typingPausedAt * TYPING_SPEED_MS);
  game.typingDuration = remainingDurationSeconds;

  debugLog(`[Grid] Resuming typing from character ${game.typingPausedAt}, ${remainingChars} chars remaining`);

  // Start timer for remaining typing duration
  startQuestionTimer(gameId, remainingDurationSeconds, () => {
    completeTyping(gameId);
  });

  broadcastGameState(gameId);
}

/**
 * End a Grid game
 */
function endGridGame(gameId) {
  const game = gridGames.get(gameId);
  if (!game) return;

  // Clear timers
  if (game.gameTimer) {
    clearInterval(game.gameTimer);
  }
  if (game.questionTimer) {
    clearInterval(game.questionTimer);
  }

  game.state = 'ended';
  game.gameTimeRemaining = 0;

  console.log(`[Grid] Game ${gameId} ended`);

  // Update registry status
  updateGameStatus(gameId, 'ended');

  // Broadcast final state to all players in the game room
  broadcastGameState(gameId);

  // Keep game in memory for a bit so clients can see final scores
  // Note: Socket.IO rooms are automatically cleaned up when:
  // - Sockets disconnect (automatic)
  // - Sockets explicitly leave (socket.leave)
  // No need to manually remove sockets from room here
  setTimeout(() => {
    gridGames.delete(gameId);
    unregisterGame(gameId);
    console.log(`[Grid] Removed game ${gameId} from memory`);
  }, 60000); // Remove after 1 minute
}

/**
 * Handle when all players have attempted the current question
 */
function handleAllPlayersAttempted(gameId) {
  const game = gridGames.get(gameId);
  if (!game) return;

  // Don't process if game has ended
  if (game.state === 'ended') {
    debugLog(`[Grid] Game ended, skipping all-players-attempted handling`);
    return;
  }

  debugLog(`[Grid] All players attempted question in game ${gameId}`);

  markTileAsAnswered(game);
  game.lastCorrectAnswerer = null; // No one answered correctly

  // Show answer for 3 seconds, then return to board
  game.state = 'showing-answer';
  broadcastGameState(gameId);

  setTimeout(() => {
    const game = gridGames.get(gameId);
    if (!game) return;
    if (game.state === 'ended') return; // Don't reset if game ended

    resetQuestionState(game);
    broadcastGameState(gameId);
  }, 3000);
}

module.exports = {
  GRID_BUZZ_WINDOW,
  GRID_ANSWER_TIME,
  GRID_GAME_TIME,
  TYPING_SPEED_MS,
  TYPING_DELAY_MS,
  createGridGame,
  startCountdownTimer,
  startGameTimer,
  startQuestionTimer,
  broadcastGameState,
  broadcastTimerTick,
  markTileAsAnswered,
  updateScoreHistory,
  resetQuestionState,
  reopenBuzzWindow,
  startTyping,
  completeTyping,
  pauseTyping,
  resumeTyping,
  endGridGame,
  handleAllPlayersAttempted
};
