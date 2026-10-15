/**
 * Game registry management (all game types), including the periodic
 * stale-game sweep.
 */

const { gameRegistry, gridGames, quizGames, tilesGames } = require('./state');

// ============================================================================
// Cleanup tuning
// ============================================================================
//
// All three are overridable via environment variables (used by the
// socket-level tests to exercise the sweep on a short clock).
//
// GAME_ABANDONED_GRACE_MS is the reconnection window: a game (lobby or
// playing) is only removed once EVERY player has been disconnected for this
// long. Deliberate leaves ("Quit Game", closing the floating window) and
// crashes both mark players disconnected rather than removing them, so a
// player can always come back within the grace period.
function envMs(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const GAME_CLEANUP_INTERVAL_MS = envMs('GAME_CLEANUP_INTERVAL_MS', 30 * 1000);
const GAME_ABANDONED_GRACE_MS = envMs('GAME_ABANDONED_GRACE_MS', 3 * 60 * 1000);
const GAME_ENDED_LINGER_MS = envMs('GAME_ENDED_LINGER_MS', 60 * 1000);

// ============================================================================
// Game Registry (All game types)
// ============================================================================

/**
 * Register a new game in the registry
 */
function registerGame(gameId, mode, hostId) {
  gameRegistry.set(gameId, {
    gameId,
    mode, // 'quiz' or 'grid'
    status: 'lobby',
    hostId,
    players: [],
    lobbyName: null,
    quizType: null, // For Quiz mode
    questions: null, // For Quiz mode
    selectedCategories: null, // For Grid mode
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    // Timestamp of the moment the LAST connected player disconnected.
    // null while at least one player is connected. Drives the abandoned-game
    // sweep (see sweepStaleGames).
    allDisconnectedSince: null
  });
  console.log(`[Registry] Registered ${mode} game: ${gameId}`);
}

/**
 * Update game status (lobby -> playing -> ended)
 */
function updateGameStatus(gameId, status) {
  const game = gameRegistry.get(gameId);
  if (game) {
    game.status = status;
    if (status === 'playing' && !game.startedAt) {
      game.startedAt = Date.now();
    }
    if (status === 'ended' && !game.endedAt) {
      game.endedAt = Date.now();
    }
    console.log(`[Registry] Game ${gameId} status: ${status}`);
  }
}

/**
 * Update lobby name in registry
 */
function updateLobbyName(gameId, lobbyName) {
  const game = gameRegistry.get(gameId);
  if (game) {
    game.lobbyName = lobbyName;
    console.log(`[Registry] Game ${gameId} lobby name: ${lobbyName}`);
  }
}

/**
 * Update player list in registry
 */
function updateGamePlayers(gameId, players) {
  const game = gameRegistry.get(gameId);
  if (game) {
    // Preserve extra per-player fields (score, clientType, socketId - Tiles
    // relies on socketId at start time) instead of stripping down to
    // {id, name, connected}; only normalize the connected flag.
    game.players = players.map(p => ({
      ...p,
      connected: p.connected !== false
    }));

    // Cleanup: If no players remain (all removed, not just disconnected), unregister the game
    if (players.length === 0) {
      console.log(`[Registry] Game ${gameId} has no players, cleaning up...`);
      removeGame(gameId);
      return;
    }

    refreshDisconnectTracking(game);
  }
}

/**
 * Keep allDisconnectedSince in sync with the current player list:
 * stamped when the last connected player goes away, cleared as soon as
 * anyone is connected again.
 */
function refreshDisconnectTracking(game) {
  if (game.players.some(p => p.connected)) {
    game.allDisconnectedSince = null;
  } else if (!game.allDisconnectedSince) {
    game.allDisconnectedSince = Date.now();
    console.log(`[Registry] Game ${game.gameId} has no connected players - reconnection grace period started`);
  }
}

/**
 * Remove game from registry
 */
function unregisterGame(gameId) {
  if (gameRegistry.delete(gameId)) {
    console.log(`[Registry] Unregistered game: ${gameId}`);
  }
}

/**
 * Remove a game from the registry AND clean up every piece of associated
 * authoritative state (grid/quiz/tiles maps), clearing any running timers
 * so no interval outlives its game.
 */
function removeGame(gameId) {
  const gridGame = gridGames.get(gameId);
  if (gridGame) {
    if (gridGame.gameTimer) clearInterval(gridGame.gameTimer);
    if (gridGame.questionTimer) clearInterval(gridGame.questionTimer);
    gridGames.delete(gameId);
    console.log(`[Grid] Cleaned up game state for ${gameId}`);
  }

  const quizGame = quizGames.get(gameId);
  if (quizGame) {
    if (quizGame.questionTimer) clearInterval(quizGame.questionTimer);
    quizGames.delete(gameId);
    console.log(`[Quiz] Cleaned up game state for ${gameId}`);
  }

  if (tilesGames.delete(gameId)) {
    console.log(`[Tiles] Cleaned up game state for ${gameId}`);
  }

  unregisterGame(gameId);
}

/**
 * Periodic sweep for stale games.
 *
 * Rules (in order):
 *  - a game whose player list is completely empty is removed immediately;
 *  - an ended game is removed GAME_ENDED_LINGER_MS after it ended (clients
 *    get a window to display final scores);
 *  - a lobby or in-progress game is removed only once ALL of its players
 *    have been disconnected for GAME_ABANDONED_GRACE_MS. As long as a single
 *    player is connected - or a disconnected player comes back within the
 *    grace period - the game survives, so "leave then reconnect" keeps
 *    working by design.
 *
 * Note this deliberately does NOT use game age (createdAt): the previous
 * implementation removed any game older than a minute as soon as its last
 * player left, which destroyed the reconnection window entirely, and it
 * removed still-occupied lobbies older than a minute.
 */
function sweepStaleGames(now = Date.now()) {
  for (const [gameId, game] of gameRegistry.entries()) {
    if (game.players.length === 0) {
      console.log(`[Cleanup] Removing game ${gameId} - no players`);
      removeGame(gameId);
      continue;
    }

    if (game.status === 'ended') {
      const endedAt = game.endedAt || game.startedAt || game.createdAt;
      if (now - endedAt > GAME_ENDED_LINGER_MS) {
        console.log(`[Cleanup] Removing ended game ${gameId}`);
        removeGame(gameId);
      }
      continue;
    }

    // Lobby or playing: expire only after the reconnection grace period.
    if (game.players.some(p => p.connected)) {
      game.allDisconnectedSince = null;
      continue;
    }
    if (!game.allDisconnectedSince) {
      // Players were marked disconnected without going through
      // updateGamePlayers - start the grace period now.
      game.allDisconnectedSince = now;
      continue;
    }
    if (now - game.allDisconnectedSince >= GAME_ABANDONED_GRACE_MS) {
      const minutes = Math.round((now - game.allDisconnectedSince) / 60000);
      console.log(`[Cleanup] Removing game ${gameId} - all players disconnected for ${minutes} minute(s)`);
      removeGame(gameId);
    }
  }
}

module.exports = {
  GAME_CLEANUP_INTERVAL_MS,
  GAME_ABANDONED_GRACE_MS,
  GAME_ENDED_LINGER_MS,
  registerGame,
  updateGameStatus,
  updateLobbyName,
  updateGamePlayers,
  unregisterGame,
  removeGame,
  sweepStaleGames
};
