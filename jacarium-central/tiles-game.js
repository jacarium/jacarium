/**
 * Tiles game mode (authoritative server).
 * Extracted verbatim from server.js (structural refactor only).
 */

const { tilesGames, getIoInstance } = require('./state');
const { updateGameStatus } = require('./game-registry');

// ============================================================================
// Tiles Game Functions
// ============================================================================

/**
 * Create a new Tiles game
 */
function createTilesGame(lobbyId, gridSize, players, isSinglePlayer) {
  // Initialize grids for all players
  const initGrid = () => {
    const grid = Array(gridSize).fill(null).map(() => Array(gridSize).fill(false));

    // Randomize with solvable pattern (make random clicks)
    const randomClicks = Math.floor(Math.random() * 10) + 5;
    for (let i = 0; i < randomClicks; i++) {
      const row = Math.floor(Math.random() * gridSize);
      const col = Math.floor(Math.random() * gridSize);
      toggleTilesCell(grid, row, col);
    }

    return grid;
  };

  // Create a unique grid and move counter for each player
  const playerStates = {};
  players.forEach(player => {
    playerStates[player.id] = {
      grid: initGrid(),
      moves: 0,
      solved: false,
      solvedAt: null,
      gaveUp: false,
      gaveUpAt: null
    };
  });

  const game = {
    lobbyId,
    gridSize,
    players,
    isSinglePlayer,
    playerStates,
    state: 'playing',
    winner: null,
    startTime: Date.now(),
  };

  tilesGames.set(lobbyId, game);
  return game;
}

/**
 * Toggle a cell and its neighbors
 */
function toggleTilesCell(grid, row, col) {
  const gridSize = grid.length;
  const directions = [
    [0, 0],   // self
    [-1, 0],  // up
    [1, 0],   // down
    [0, -1],  // left
    [0, 1],   // right
  ];

  directions.forEach(([dr, dc]) => {
    const newRow = row + dr;
    const newCol = col + dc;

    if (newRow >= 0 && newRow < gridSize && newCol >= 0 && newCol < gridSize) {
      grid[newRow][newCol] = !grid[newRow][newCol];
    }
  });
}

/**
 * Check if grid is solved (all same state)
 */
function checkTilesSolved(grid) {
  if (!grid || grid.length === 0) return false;

  const allOff = grid.every(row => row.every(cell => !cell));
  const allOn = grid.every(row => row.every(cell => cell));

  return allOff || allOn;
}

/**
 * Broadcast Tiles game state
 */
function broadcastTilesGameState(lobbyId) {
  const game = tilesGames.get(lobbyId);
  const ioInstance = getIoInstance();
  if (!game || !ioInstance) return;

  // Send state to each player individually using player.socketId
  game.players.forEach(player => {
    const myState = game.playerStates[player.id];

    // Build opponent states (move count and solved status plus grids)
    const opponentStates = game.players
      .filter(p => p.id !== player.id)
      .map(p => ({
        id: p.id,
        name: p.name,
        moves: game.playerStates[p.id].moves,
        solved: game.playerStates[p.id].solved,
        gaveUp: game.playerStates[p.id].gaveUp,
        grid: game.playerStates[p.id].grid // Include grid so they can see opponent progress
      }));

    // Use player.socketId for both app and web clients
    if (player.socketId) {
      ioInstance.to(player.socketId).emit('tiles-game-state-update', {
        lobbyId,
        myGrid: myState.grid,
        myMoves: myState.moves,
        mySolved: myState.solved,
        opponentStates,
        timestamp: Date.now()
      });
    } else {
      console.warn(`[Tiles] Cannot broadcast to ${player.id} - no socketId`);
    }
  });
}

/**
 * End Tiles game
 */
function endTilesGame(lobbyId, winnerId) {
  const game = tilesGames.get(lobbyId);
  if (!game) return;

  game.state = 'ended';
  game.winner = winnerId;

  updateGameStatus(lobbyId, 'ended');

  // Build final results for all players
  const playerResults = game.players.map(p => ({
    id: p.id,
    name: p.name,
    moves: game.playerStates[p.id].moves,
    solved: game.playerStates[p.id].solved,
    solvedAt: game.playerStates[p.id].solvedAt,
    gaveUp: game.playerStates[p.id].gaveUp
  }));

  getIoInstance().to(lobbyId).emit('tiles-game-ended', {
    lobbyId,
    winner: winnerId,
    playerResults,
    duration: Date.now() - game.startTime,
    timestamp: Date.now()
  });
}

module.exports = {
  createTilesGame,
  toggleTilesCell,
  checkTilesSolved,
  broadcastTilesGameState,
  endTilesGame
};
