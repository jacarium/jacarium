/**
 * Quiz game mode (authoritative server) - game lifecycle, question timer
 * and state broadcasting.
 * Extracted verbatim from server.js (structural refactor only).
 */

const { quizGames, gameRegistry, getIoInstance, debugLog } = require('./state');
const { updateGameStatus, unregisterGame } = require('./game-registry');

// ============================================================================
// Quiz Game State (Authoritative Server)
// ============================================================================

// Quiz constants
const QUESTION_TIME_SECONDS = 30;  // 30 seconds per question

/**
 * Create a new Quiz game
 */
function createQuizGame(gameId, hostId, players, questions, quizType) {
  const scoreHistory = {};
  players.forEach(p => {
    scoreHistory[p.id] = [0]; // Start at 0
  });

  const game = {
    gameId,
    hostId,
    players: players.map(p => ({ ...p, score: 0 })),
    questions,  // Full question array
    quizType,
    currentQuestionIndex: 0,
    timeRemaining: QUESTION_TIME_SECONDS,
    questionAnswers: [],  // History of { questionId, playerId, correct, pointsEarned }
    scoreHistory,
    hintsRevealed: 0,  // Track global hint level for current question
    state: 'playing',  // 'playing' | 'ended'
    questionTimer: null,  // Timer interval ID
    pendingScoreUpdates: [],  // Pending score updates to apply when question ends
    isTransitioning: false  // Flag to prevent race conditions during question transitions
  };

  quizGames.set(gameId, game);

  console.log(`[Quiz] Created game ${gameId} with ${players.length} players and ${questions.length} questions`);
  return game;
}

// ============================================================================
// Quiz Game Timers and Management
// ============================================================================

/**
 * Start the quiz question countdown timer
 */
function startQuizQuestionTimer(gameId) {
  const game = quizGames.get(gameId);
  if (!game) return;

  debugLog(`[Quiz Timer] Starting timer for Q${game.currentQuestionIndex}`);

  // Clear existing timer if any - critical to prevent multiple timers
  if (game.questionTimer) {
    debugLog(`[Quiz Timer] Clearing existing timer first`);
    clearInterval(game.questionTimer);
    game.questionTimer = null;
  }

  // Reset time to full duration
  game.timeRemaining = QUESTION_TIME_SECONDS;

  // Broadcast initial state immediately (full time)
  broadcastQuizGameState(gameId, false);

  // Start new timer
  game.questionTimer = setInterval(() => {
    const g = quizGames.get(gameId);
    if (!g) {
      clearInterval(game.questionTimer);
      return;
    }

    g.timeRemaining--;
    debugLog(`[Quiz Timer] Q${g.currentQuestionIndex} - ${g.timeRemaining}s remaining`);
    // Per-second ticks only carry the countdown value. Full state (players,
    // scoreHistory, the whole stripped question list, ...) is broadcast by
    // the actual state-changing events, not from the timer.
    broadcastQuizTimerTick(gameId);

    if (g.timeRemaining <= 0) {
      clearInterval(g.questionTimer);
      g.questionTimer = null;

      // Auto-advance to next question when time expires
      handleQuizQuestionTimeout(gameId);
    }
  }, 1000);
}

/**
 * Handle when question timer expires
 */
function handleQuizQuestionTimeout(gameId) {
  const game = quizGames.get(gameId);
  if (!game) return;

  // Don't process if already transitioning (e.g., all players answered)
  if (game.isTransitioning) {
    debugLog(`[Quiz] Timer expired but already transitioning - skipping`);
    return;
  }

  debugLog(`[Quiz] Question ${game.currentQuestionIndex + 1} timed out in game ${gameId}`);

  // Mark that we're transitioning
  game.isTransitioning = true;

  // Apply pending score updates first, then reveal answer so points update together
  debugLog(`[Quiz] Applying pending scores for Q${game.currentQuestionIndex} (timeout)`);
  applyPendingScoreUpdates(gameId);

  // Now reveal answer with updated scores
  debugLog(`[Quiz] Revealing answer for Q${game.currentQuestionIndex} (timeout)`);
  broadcastQuizGameState(gameId, true);

  // Wait 3 seconds to show answer, then move on
  setTimeout(() => {
    const g = quizGames.get(gameId);
    if (!g) return;

    debugLog(`[Quiz] Timeout fired, advancing from Q${g.currentQuestionIndex} to Q${g.currentQuestionIndex + 1} (timeout)`);

    // Move to next question or end quiz
    if (g.currentQuestionIndex < g.questions.length - 1) {
      // Advance to next question
      g.currentQuestionIndex++;
      g.hintsRevealed = 0;
      g.pendingScoreUpdates = [];  // Clear pending scores for new question
      g.isTransitioning = false;  // Clear transition flag

      // Start timer (which broadcasts initial state)
      debugLog(`[Quiz] Starting timer for new Q${g.currentQuestionIndex} (timeout)`);
      startQuizQuestionTimer(gameId);
      // Don't broadcast again - startQuizQuestionTimer already broadcasts
    } else {
      endQuizGame(gameId);
    }
  }, 3000);
}

/**
 * Apply all pending score updates for the current question
 * Called when question ends (timer expires or manually advancing)
 */
function applyPendingScoreUpdates(gameId) {
  const game = quizGames.get(gameId);
  if (!game) return;

  if (game.pendingScoreUpdates.length === 0) {
    debugLog(`[Quiz] No pending score updates to apply for game ${gameId}`);
    return;
  }

  debugLog(`[Quiz] Applying ${game.pendingScoreUpdates.length} pending score updates for game ${gameId}`);

  // Apply all pending score updates
  game.pendingScoreUpdates.forEach(update => {
    game.players = game.players.map(p =>
      p.id === update.playerId ? { ...p, score: p.score + update.pointsEarned } : p
    );
  });

  // Update score history for all players
  game.players.forEach(p => {
    game.scoreHistory[p.id] = [...(game.scoreHistory[p.id] || [0]), p.score];
  });

  // Clear pending updates
  game.pendingScoreUpdates = [];

  debugLog(`[Quiz] Score updates applied for game ${gameId}`);
}

/**
 * End a Quiz game
 */
function endQuizGame(gameId) {
  const game = quizGames.get(gameId);
  if (!game) return;

  // Clear timer
  if (game.questionTimer) {
    clearInterval(game.questionTimer);
    game.questionTimer = null;
  }

  // Apply any remaining pending score updates
  applyPendingScoreUpdates(gameId);

  game.state = 'ended';

  console.log(`[Quiz] Game ${gameId} ended`);

  // Update registry status
  updateGameStatus(gameId, 'ended');

  // Broadcast final state to all players in the game room
  broadcastQuizGameState(gameId, false);

  // Keep game in memory for a bit so clients can see final scores
  setTimeout(() => {
    cleanupQuizGame(gameId);
    unregisterGame(gameId);
    console.log(`[Quiz] Removed game ${gameId} from memory`);
  }, 60000); // Remove after 1 minute
}

/**
 * Cleanup quiz game timers and state
 */
function cleanupQuizGame(gameId) {
  const game = quizGames.get(gameId);
  if (game && game.questionTimer) {
    clearInterval(game.questionTimer);
    game.questionTimer = null;
  }
  quizGames.delete(gameId);
}

/**
 * Broadcast a lightweight per-second countdown tick to the game room.
 *
 * Deliberately tiny: it carries ONLY timeRemaining (plus a timestamp).
 * Sending broadcastQuizGameState() from the 1s timer used to re-send the
 * whole payload - players, scoreHistory and a freshly answer-stripped copy
 * of EVERY question - each second to every room. Real state changes already
 * broadcast full state from their own handlers.
 */
function broadcastQuizTimerTick(gameId) {
  const game = quizGames.get(gameId);
  const ioInstance = getIoInstance();
  if (!game || !ioInstance) return;

  ioInstance.to(gameId).emit('quiz-timer-tick', {
    gameId,
    timeRemaining: game.timeRemaining,
    timestamp: Date.now()
  });
}

/**
 * Broadcast quiz game state to all players in the game room
 */
function broadcastQuizGameState(gameId, revealAnswer = false) {
  const game = quizGames.get(gameId);
  const ioInstance = getIoInstance();
  if (!game || !ioInstance) return;

  // Get lobby name from game registry
  const registryGame = gameRegistry.get(gameId);
  const lobbyName = registryGame ? registryGame.lobbyName : null;

  // Strip answers from questions to prevent cheating during gameplay
  // But send full questions with answers when quiz has ended (for results screen)
  const questionsToSend = game.state === 'ended'
    ? game.questions  // Send WITH answers when ended
    : game.questions.map(q => {
        const { answer: _answer, ...questionWithoutAnswer } = q;
        return questionWithoutAnswer;
      });

  // Build state update object
  const stateUpdate = {
    gameId,
    state: game.state,
    currentQuestionIndex: game.currentQuestionIndex,
    timeRemaining: game.timeRemaining,
    hintsRevealed: game.hintsRevealed,
    players: game.players,
    scoreHistory: game.scoreHistory,
    questionAnswers: game.questionAnswers,
    questions: questionsToSend,
    quizType: game.quizType,
    lobbyName,
    timestamp: Date.now()
  };

  // Log player connection states
  const playerStates = game.players.map(p => `${p.name}:${p.connected !== false ? 'C' : 'D'}`).join(', ');
  debugLog(`[Quiz Broadcast] Players: ${playerStates}`);

  // Only include currentQuestionAnswer when explicitly revealing
  // Don't include it at all during normal gameplay to avoid unnecessary updates
  if (revealAnswer && game.questions[game.currentQuestionIndex]) {
    stateUpdate.currentQuestionAnswer = game.questions[game.currentQuestionIndex].answer;
    debugLog(`[Quiz Broadcast] Q${game.currentQuestionIndex} REVEALING answer: "${stateUpdate.currentQuestionAnswer}"`);
  } else {
    debugLog(`[Quiz Broadcast] Q${game.currentQuestionIndex} regular update (no answer reveal)`);
  }
  // If not revealing, don't include the field at all (undefined in JS, omitted from JSON)

  ioInstance.to(gameId).emit('quiz-state-update', stateUpdate);
}

module.exports = {
  QUESTION_TIME_SECONDS,
  createQuizGame,
  startQuizQuestionTimer,
  handleQuizQuestionTimeout,
  applyPendingScoreUpdates,
  endQuizGame,
  cleanupQuizGame,
  broadcastQuizGameState,
  broadcastQuizTimerTick
};
