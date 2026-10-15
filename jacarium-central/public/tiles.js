// Tiles Web Client
//
// The page is served at /tiles/<id> by the central server itself and at
// <console>/central/tiles/<id> behind the console, which strips /central
// before forwarding. Whatever precedes /tiles/ in the page's own path is the
// prefix, and Socket.IO's engine lives at <prefix>/socket.io.
function pagePrefix() {
  const match = window.location.pathname.match(/^(.*?)\/tiles\/[^/]+/);
  return match ? match[1] : '';
}

let socket;
let gameId;
let playerId;
let playerName;
let gameState = {};
let gridSize = 5;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Get gameId from URL path (/tiles/:gameId)
  const path = window.location.pathname;
  const match = path.match(/\/tiles\/([^/]+)/);
  gameId = match ? match[1] : null;

  if (!gameId) {
    showError('No game ID provided');
    return;
  }

  document.getElementById('gameIdDisplay').textContent = `Game: ${gameId}`;

  // Generate a unique player ID for this session
  playerId = `web-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Initialize socket connection (the engine path follows the page's prefix)
  socket = io(window.location.origin, { path: `${pagePrefix()}/socket.io` });

  // Setup socket listeners
  setupSocketListeners();
});

function setupSocketListeners() {
  socket.on('connect', () => {
    console.log('Connected to server');
  });

  socket.on('tiles-player-joined', (data) => {
    // Show lobby screen on first join
    if (document.getElementById('joinScreen').style.display !== 'none') {
      showScreen('lobbyScreen');
    }

    // Update lobby name if provided
    if (data.lobbyName) {
      document.getElementById('lobbyTitle').textContent = data.lobbyName;
    }

    updateLobby(data.players);
  });

  socket.on('tiles-player-left', (data) => {
    updateLobby(data.players);
  });

  socket.on('tiles-game-started', (data) => {
    console.log('[Tiles Web] Game started event received:', data);
    // Server sends: { lobbyId, myGrid, opponentStates, timestamp }
    gameState.grid = data.myGrid;
    gameState.players = {};
    gridSize = data.myGrid ? data.myGrid.length : 5;

    console.log('[Tiles Web] Grid size:', gridSize, 'Player ID:', playerId);
    console.log('[Tiles Web] Opponent states:', data.opponentStates);

    // Initialize my player state
    gameState.players[playerId] = {
      name: playerName || 'You',
      moves: 0,
      completed: false,
      gaveUp: false
    };

    // Initialize opponent player states
    if (data.opponentStates && data.opponentStates.length > 0) {
      data.opponentStates.forEach(opp => {
        gameState.players[opp.id] = {
          name: opp.name,
          moves: opp.moves,
          completed: opp.solved,
          gaveUp: opp.gaveUp || false,
          grid: opp.grid || []
        };
      });
    }

    console.log('[Tiles Web] Game state players:', gameState.players);
    console.log('[Tiles Web] Showing board screen');
    try {
      showScreen('boardScreen');
      console.log('[Tiles Web] Screen changed to boardScreen');
      renderBoard();
      console.log('[Tiles Web] Board rendered');
      updateLeaderboard();
      console.log('[Tiles Web] Leaderboard updated');
    } catch (error) {
      console.error('[Tiles Web] Error during game start:', error);
    }
  });

  socket.on('tiles-game-state-update', (data) => {
    // Server sends: { lobbyId, myGrid, myMoves, mySolved, opponentStates, timestamp }
    gameState.grid = data.myGrid;

    // Update my player state
    if (!gameState.players) gameState.players = {};
    gameState.players[playerId] = {
      moves: data.myMoves,
      completed: data.mySolved,
      gaveUp: gameState.players[playerId]?.gaveUp || false
    };

    // Update opponent states
    if (data.opponentStates) {
      data.opponentStates.forEach(opp => {
        gameState.players[opp.id] = {
          name: opp.name,
          moves: opp.moves,
          completed: opp.solved,
          gaveUp: opp.gaveUp || false,
          grid: opp.grid || []
        };
      });
    }

    updateMovesCounter();
    updateBoard();
    renderOpponentGrids();
    updateLeaderboard();
  });

  socket.on('tiles-game-ended', (data) => {
    showResults(data);
  });

  socket.on('tiles-join-rejected', (data) => {
    showError(data.reason || 'Failed to join game');
    document.getElementById('joinBtn').disabled = false;
    document.getElementById('joinBtnText').style.display = 'inline';
    document.getElementById('joinBtnSpinner').style.display = 'none';
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server');
  });
}

// Invoked from tiles.html (form onsubmit) - ESLint cannot see HTML references
// eslint-disable-next-line no-unused-vars
function joinTiles(event) {
  event.preventDefault();

  const nameInput = document.getElementById('playerName');
  playerName = nameInput.value.trim();

  if (!playerName) {
    showError('Please enter your name');
    return;
  }

  // Disable join button and show spinner
  document.getElementById('joinBtn').disabled = true;
  document.getElementById('joinBtnText').style.display = 'none';
  document.getElementById('joinBtnSpinner').style.display = 'inline-block';

  // Emit join event
  socket.emit('tiles-join-lobby', {
    lobbyId: gameId,
    playerId: playerId,
    playerName: playerName,
    clientType: 'web'
  });
}

function updateLobby(players) {
  const playersList = document.getElementById('playersList');
  const playerCount = document.getElementById('playerCount');

  playerCount.textContent = players.length;

  playersList.innerHTML = players.map((player, index) => {
    const isDisconnected = player.connected === false;
    const isMe = player.id === playerId;
    const isHost = index === 0;

    // Infer clientType from player ID if missing (web players have IDs starting with "web-")
    let clientType = player.clientType;
    if (!clientType) {
      clientType = player.id.startsWith('web-') ? 'web' : 'app';
    }

    const icon = isDisconnected ? '🌐' : (clientType === 'web' ? '🌐' : '💻');

    // Build badges
    let leftBadges = '';
    let rightBadges = '';

    // Left side: "You" badge
    if (isMe && !isDisconnected) {
      leftBadges += '<span class="player-badge badge-you">You</span>';
    }

    // Right side: Status badges
    if (isDisconnected) {
      rightBadges += '<span class="player-badge badge-disconnected">Disconnected</span>';
    } else if (player.status === 'pending') {
      rightBadges += '<span class="player-badge badge-pending">Pending</span>';
    } else if (player.status === 'ready' && !isMe) {
      rightBadges += '<span class="player-badge badge-ready">Ready</span>';
    }

    if (isHost && isMe) {
      rightBadges += '<span class="player-badge badge-host">Host</span>';
    }

    return `
      <div class="player-item" style="${isDisconnected ? 'opacity: 0.6;' : ''}">
        <div class="player-left">
          <span class="player-icon">${icon}</span>
          <span class="player-name">${player.name}</span>
          ${leftBadges}
        </div>
        <div>
          ${rightBadges}
        </div>
      </div>
    `;
  }).join('');
}

function renderBoard() {
  // Render my grid (center)
  const board = document.getElementById('tilesBoard');
  board.className = `tiles-board size-${gridSize}`;

  const grid = gameState.grid || [];
  board.innerHTML = '';

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const isOn = grid[row] && grid[row][col];
      const tile = document.createElement('div');
      tile.className = `tile ${isOn ? 'on' : ''}`;
      tile.dataset.row = row;
      tile.dataset.col = col;
      tile.addEventListener('click', () => handleTileClick(row, col));
      board.appendChild(tile);
    }
  }

  updateMovesCounter();
  renderOpponentGrids();

  // Setup give up button
  document.getElementById('giveUpBtn').onclick = handleGiveUp;
}

function renderOpponentGrids() {
  const opponentsLeft = document.getElementById('opponentsLeft');
  const opponentsRight = document.getElementById('opponentsRight');

  if (!opponentsLeft || !opponentsRight) return;

  // Get opponents from gameState
  const opponents = Object.entries(gameState.players || {})
    .filter(([id]) => id !== playerId)
    .map(([id, player]) => ({ id, ...player }));

  // Clear containers
  opponentsLeft.innerHTML = '';
  opponentsRight.innerHTML = '';

  if (opponents.length === 0) return;

  // Split opponents between left and right
  const midPoint = Math.ceil(opponents.length / 2);
  const leftOpponents = opponents.slice(0, midPoint);
  const rightOpponents = opponents.slice(midPoint);

  // Render left opponents
  leftOpponents.forEach(opp => {
    opponentsLeft.appendChild(createOpponentGrid(opp));
  });

  // Render right opponents
  rightOpponents.forEach(opp => {
    opponentsRight.appendChild(createOpponentGrid(opp));
  });
}

function createOpponentGrid(opponent) {
  const container = document.createElement('div');
  container.style.textAlign = 'center';

  // Name and moves
  const header = document.createElement('div');
  header.style.fontSize = '10px';
  header.style.fontWeight = '500';
  header.style.color = '#b0b0b0';
  header.style.marginBottom = '4px';
  header.textContent = opponent.name || 'Opponent';

  const moves = document.createElement('div');
  moves.style.fontSize = '10px';
  moves.style.fontWeight = 'bold';
  moves.style.color = '#f0f0f0';
  moves.style.marginBottom = '4px';
  moves.textContent = `Moves: ${opponent.gaveUp ? '∞' : opponent.moves || 0}${opponent.completed ? ' ✓' : ''}`;

  // Small grid (non-interactive, just for display)
  const gridContainer = document.createElement('div');
  gridContainer.className = 'tiles-board-small';
  gridContainer.style.display = 'inline-grid';
  gridContainer.style.gap = '2px';
  gridContainer.style.gridTemplateColumns = `repeat(${gridSize}, 1fr)`;

  // Render actual opponent grid tiles
  const oppGrid = opponent.grid || [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const isOn = oppGrid[row] && oppGrid[row][col];
      const tile = document.createElement('div');
      tile.style.width = '16px';
      tile.style.height = '16px';
      tile.style.borderRadius = '2px';
      tile.style.border = '1px solid #3a3a3a';
      // Purple when ON, dark when OFF (matching the main tiles)
      tile.style.backgroundColor = isOn ? '#a855f7' : '#2a2a2a';
      tile.style.boxShadow = isOn ? '0 0 4px rgba(168, 85, 247, 0.5)' : 'none';
      gridContainer.appendChild(tile);
    }
  }

  container.appendChild(header);
  container.appendChild(moves);
  container.appendChild(gridContainer);

  return container;
}

function updateBoard() {
  const grid = gameState.grid || [];
  const tiles = document.querySelectorAll('.tile');
  const myStatus = gameState.players?.[playerId];

  console.log('[Tiles Web] updateBoard - myStatus:', myStatus);

  tiles.forEach(tile => {
    const row = parseInt(tile.dataset.row);
    const col = parseInt(tile.dataset.col);
    const isOn = grid[row] && grid[row][col];

    if (isOn) {
      tile.classList.add('on');
    } else {
      tile.classList.remove('on');
    }

    // Disable tiles if player gave up or completed
    if (myStatus?.gaveUp || myStatus?.completed) {
      tile.classList.add('disabled');
      tile.style.pointerEvents = 'none'; // Prevent clicking
    } else {
      tile.classList.remove('disabled');
      tile.style.pointerEvents = 'auto'; // Allow clicking
    }
  });
}

function updateMovesCounter() {
  const myStatus = gameState.players?.[playerId];
  const moves = myStatus?.moves || 0;
  document.getElementById('movesCount').textContent = moves;

  // Disable give up button if already gave up or completed
  const giveUpBtn = document.getElementById('giveUpBtn');
  const waitingMsg = document.getElementById('waitingMessage');

  if (myStatus?.gaveUp || myStatus?.completed) {
    giveUpBtn.disabled = true;
    if (waitingMsg) {
      waitingMsg.style.display = 'block';
    }
  } else {
    if (waitingMsg) {
      waitingMsg.style.display = 'none';
    }
  }
}

function handleTileClick(row, col) {
  console.log('[Tiles Web] Tile clicked:', row, col);
  console.log('[Tiles Web] Game state:', gameState);
  console.log('[Tiles Web] Player ID:', playerId);

  const myStatus = gameState.players?.[playerId];
  console.log('[Tiles Web] My status:', myStatus);

  // Don't allow clicks if player gave up or completed
  if (myStatus?.gaveUp || myStatus?.completed) {
    console.log('[Tiles Web] Click ignored - player completed or gave up');
    return;
  }

  console.log('[Tiles Web] Emitting tiles-cell-click');
  socket.emit('tiles-cell-click', {
    lobbyId: gameId,
    playerId: playerId,
    row: row,
    col: col
  });
}

function handleGiveUp() {
  if (!confirm('Are you sure you want to give up?')) {
    return;
  }

  socket.emit('tiles-give-up', {
    lobbyId: gameId,
    playerId: playerId
  });

  document.getElementById('giveUpBtn').disabled = true;

  // Disable all tiles
  document.querySelectorAll('.tile').forEach(tile => {
    tile.classList.add('disabled');
  });
}

function updateLeaderboard() {
  // Leaderboard removed from UI, this function is now a no-op
  // Keeping it to avoid breaking existing code that calls it
}

function showResults(data) {
  // Server sends: { lobbyId, winner, playerResults, duration, timestamp }
  const results = data.playerResults || [];

  // Sort results: completed (by moves), then gave up
  const sortedResults = [...results].sort((a, b) => {
    if (a.gaveUp && !b.gaveUp) return 1;
    if (!a.gaveUp && b.gaveUp) return -1;
    if (a.gaveUp && b.gaveUp) return 0;
    return a.moves - b.moves;
  });

  // Find winner (first non-gave-up player)
  const winner = sortedResults.find(p => !p.gaveUp);

  // Display winner announcement
  const winnerAnnouncement = document.getElementById('winnerAnnouncement');
  if (winner) {
    winnerAnnouncement.innerHTML = `
      <div class="winner-label">Winner: <span class="winner-name">${winner.name}</span></div>
      <div class="winner-moves">${winner.moves} moves</div>
    `;
  } else {
    winnerAnnouncement.innerHTML = `
      <div class="winner-label">All players gave up!</div>
    `;
  }

  // Display final standings
  const finalStandings = document.getElementById('finalStandings');
  finalStandings.innerHTML = sortedResults.map((player, index) => {
    const rank = player.gaveUp ? 'Unranked' : `#${index + 1}`;
    const rankClass = index === 0 && !player.gaveUp ? 'first' :
                     index === 1 && !player.gaveUp ? 'second' :
                     index === 2 && !player.gaveUp ? 'third' : '';

    return `
      <div class="final-standings-item ${index === 0 && !player.gaveUp ? 'winner' : ''}">
        <div class="standing-left">
          <div class="standing-rank ${rankClass}">${rank}</div>
          <div class="standing-name">${player.name}</div>
        </div>
        <div class="standing-moves ${player.gaveUp ? 'gave-up' : ''}">${player.gaveUp ? '∞' : player.moves}</div>
      </div>
    `;
  }).join('');

  showScreen('resultsScreen');
}

function showScreen(screenId) {
  // Hide all screens
  document.getElementById('joinScreen').style.display = 'none';
  document.getElementById('lobbyScreen').classList.remove('active');
  document.getElementById('boardScreen').classList.remove('active');
  document.getElementById('resultsScreen').classList.remove('active');

  // Show requested screen
  if (screenId === 'lobbyScreen') {
    document.getElementById('lobbyScreen').classList.add('active');
  } else if (screenId === 'boardScreen') {
    document.getElementById('boardScreen').classList.add('active');
  } else if (screenId === 'resultsScreen') {
    document.getElementById('resultsScreen').classList.add('active');
  } else {
    // Default to join screen
    document.getElementById('joinScreen').style.display = 'block';
  }
}

function showError(message) {
  const errorEl = document.getElementById('errorMessage');
  errorEl.textContent = message;
  errorEl.style.display = 'block';

  setTimeout(() => {
    errorEl.style.display = 'none';
  }, 5000);
}
