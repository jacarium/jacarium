// Grid Web Client
let socket;
let gameId;
let playerId;
let playerName;
let players = [];
let board = [];
let categories = [];
let currentTile = null;
let currentBuzzer = null;
let buzzerWindow = false;
let timeRemaining = 5;
let gameTimeRemaining = 300;
let attemptedPlayers = [];
let showingAnswer = false;
let scoreHistory = {};
let lobbyName = 'Grid Lobby'; // Default lobby name
let selector = null; // playerId of who is currently selecting tiles
let lastCorrectAnswerer = null; // playerId of who answered correctly, or null
let answeredTiles = []; // Array of tile objects that were answered during the game

// Typewriter effect state
let typingInProgress = false;
let typingStartTime = null;
let typingPausedAt = null;
let typewriterInterval = null;

// Incorrect answers for current question
let incorrectAnswers = []; // [{playerId, playerName, answer}]

const GRID_BUZZ_WINDOW = 10;
const GRID_ANSWER_TIME = 10;
const TYPING_SPEED_MS = 50;
const TYPING_DELAY_MS = 1000;

document.addEventListener('DOMContentLoaded', () => {
  gameId = getGameIdFromUrl();

  if (!gameId) {
    showError('Invalid Grid URL. Please check your link.');
    return;
  }

  document.getElementById('gameIdDisplay').textContent = `Game ID: ${gameId}`;

  // Generate a unique player ID for this session
  playerId = `web-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Connect to WebSocket
  connectWebSocket();

  // Handle join form
  // Join form handled by onsubmit in HTML

  // Handle answer input
  const answerInput = document.getElementById('answerInput');
  answerInput.addEventListener('input', (e) => {
    const submitBtn = document.getElementById('submitAnswerBtn');
    submitBtn.disabled = !e.target.value.trim();
  });

  answerInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && answerInput.value.trim()) {
      submitAnswer();
    }
  });

  // Handle buzz button
  document.getElementById('buzzBtn').addEventListener('click', () => {
    buzzIn();
  });

  // Handle submit answer button
  document.getElementById('submitAnswerBtn').addEventListener('click', () => {
    submitAnswer();
  });
});

function getGameIdFromUrl() {
  const path = window.location.pathname;
  const match = path.match(/\/grid\/([^/]+)/);
  return match ? match[1] : null;
}

// The page is served at /grid/<id> by the central server itself and at
// <console>/central/grid/<id> behind the console, which strips /central
// before forwarding. Whatever precedes /grid/ in the page's own path is the
// prefix, and Socket.IO's engine lives at <prefix>/socket.io.
function pagePrefix() {
  const match = window.location.pathname.match(/^(.*?)\/grid\/[^/]+/);
  return match ? match[1] : '';
}

function connectWebSocket() {
  socket = io(window.location.origin, {
    path: `${pagePrefix()}/socket.io`,
    transports: ['websocket', 'polling']
  });

  socket.on('connect', () => {
    // Connected to server
  });

  socket.on('disconnect', () => {
    showError('Connection lost. Please refresh the page.');
  });

  socket.on('grid-join-rejected', (data) => {
    showError(data.reason || 'Unable to join Grid');

    // Re-enable join button
    const joinBtn = document.getElementById('joinBtn');
    const joinBtnText = document.getElementById('joinBtnText');
    const joinBtnSpinner = document.getElementById('joinBtnSpinner');

    if (joinBtn) {
      joinBtn.disabled = false;
      joinBtnText.style.display = 'inline';
      joinBtnSpinner.style.display = 'none';
    }
  });

  socket.on('grid-sync-players', (data) => {
    if (data.gameId === gameId) {
      // Successfully joined - show lobby screen
      document.getElementById('joinScreen').style.display = 'none';
      document.getElementById('lobbyScreen').classList.add('active');

      // Update lobby name if provided
      if (data.lobbyName) {
        lobbyName = data.lobbyName;
        updateLobbyTitle();
      }

      // Preserve local antiCheat flags and clientType when updating from server
      players = (data.players || []).map(p => {
        const existingPlayer = players.find(existing => existing.id === p.id);

        // Infer clientType from player ID if missing (web players have IDs starting with "web-")
        let clientType = p.clientType || existingPlayer?.clientType;
        if (!clientType) {
          clientType = p.id.startsWith('web-') ? 'web' : 'app';
        }

        return {
          ...p,
          score: p.score ?? 0,
          antiCheat: existingPlayer?.antiCheat || p.antiCheat || false,
          clientType
        };
      });
      updatePlayersList();
    }
  });

  socket.on('grid-state-update', (data) => {
    if (data.gameId !== gameId) return;

    const { state, currentTile: tile, currentBuzzer: buzzer, buzzerWindow: buzzWin,
            questionTimeRemaining: time, attemptedPlayers: attempted, gameTimeRemaining: gameTime,
            board: serverBoard, players: serverPlayers, scoreHistory: serverHistory,
            lastCorrectAnswerer: serverLastCorrectAnswerer, lobbyName: serverLobbyName, selector: serverSelector,
            answeredTiles: serverAnsweredTiles, typingInProgress: serverTypingInProgress,
            typingStartTime: serverTypingStartTime,
            typingPausedAt: serverTypingPausedAt, incorrectAnswers: serverIncorrectAnswers } = data;

    // Update lobby name if provided
    if (serverLobbyName) {
      lobbyName = serverLobbyName;
      updateLobbyTitle();
    }

    // Preserve local antiCheat flags
    players = serverPlayers.map(p => {
      const existingPlayer = players.find(existing => existing.id === p.id);
      return {
        ...p,
        score: p.score ?? 0,
        antiCheat: existingPlayer?.antiCheat || p.antiCheat || false
      };
    });

    board = serverBoard || [];
    currentTile = tile;
    currentBuzzer = buzzer;
    buzzerWindow = buzzWin;
    timeRemaining = time;
    attemptedPlayers = attempted || [];
    gameTimeRemaining = gameTime;
    scoreHistory = serverHistory || {};
    showingAnswer = state === 'showing-answer';  // Derive from state
    selector = serverSelector;
    lastCorrectAnswerer = serverLastCorrectAnswerer;
    answeredTiles = serverAnsweredTiles || [];

    // Update typing state
    typingInProgress = serverTypingInProgress || false;
    typingStartTime = serverTypingStartTime;
    typingPausedAt = serverTypingPausedAt;

    // Update incorrect answers
    incorrectAnswers = serverIncorrectAnswers || [];

    // Update UI based on state
    // Grid states: 'board', 'question', 'showing-answer', 'ended'
    if (state === 'board' || state === 'question' || state === 'showing-answer') {
      document.getElementById('lobbyScreen').classList.remove('active');
      document.getElementById('boardScreen').classList.add('active');
      renderBoard();
      updateLeaderboard();
      updateGameTimer();

      if (currentTile) {
        showQuestionScreen();
      } else {
        showBoardScreen();
      }
    } else if (state === 'ended') {
      showResults();
    }

    updateLeaderboard();
    updateGameTimer();
  });

  // Lightweight per-second countdown tick. The server no longer re-sends the
  // full game payload from its 1s timer - only the countdown numbers arrive
  // here and are merged into the existing local state.
  socket.on('grid-timer-tick', (data) => {
    if (data.gameId !== gameId) return;

    gameTimeRemaining = data.gameTimeRemaining;
    timeRemaining = data.questionTimeRemaining;

    updateGameTimer();
    updateQuestionTimers();
  });
}

function startTypewriterAnimation() {
  // Stop any existing animation
  if (typewriterInterval) {
    clearInterval(typewriterInterval);
    typewriterInterval = null;
  }

  const questionElement = document.getElementById('modalQuestion');
  if (!questionElement || !currentTile) return;

  const questionText = currentTile.question?.question || currentTile.question || '';

  // If typing is paused, show up to pause point
  if (!typingInProgress && typingPausedAt !== null) {
    questionElement.textContent = questionText.substring(0, typingPausedAt);
    return;
  }

  // If not typing and not paused, show full question
  if (!typingInProgress) {
    questionElement.textContent = questionText;
    return;
  }

  // Calculate which character we should be at based on elapsed time
  const elapsed = Date.now() - typingStartTime;
  // During delay period (elapsed < 0), show empty string
  let currentCharIndex = elapsed < 0 ? 0 : Math.min(Math.floor(elapsed / TYPING_SPEED_MS), questionText.length);

  // If typing was paused and resumed, start from pause point
  if (typingPausedAt !== null && currentCharIndex < typingPausedAt) {
    currentCharIndex = typingPausedAt;
  }

  // Display characters typed so far with blinking cursor
  const typedText = questionText.substring(0, currentCharIndex);
  questionElement.innerHTML = typedText + '<span class="typing-cursor">_</span>';

  // Continue animation
  typewriterInterval = setInterval(() => {
    if (!typingInProgress) {
      clearInterval(typewriterInterval);
      typewriterInterval = null;
      return;
    }

    const elapsed = Date.now() - typingStartTime;
    const charIndex = elapsed < 0 ? 0 : Math.floor(elapsed / TYPING_SPEED_MS);

    if (charIndex >= questionText.length) {
      // Typing complete - show full text without cursor
      questionElement.textContent = questionText;
      clearInterval(typewriterInterval);
      typewriterInterval = null;
    } else {
      // Show partial text with cursor
      const typedText = questionText.substring(0, charIndex);
      questionElement.innerHTML = typedText + '<span class="typing-cursor">_</span>';
    }
  }, TYPING_SPEED_MS);
}

// Invoked from grid.html (form onsubmit) - ESLint cannot see HTML references
// eslint-disable-next-line no-unused-vars
function joinGrid(event) {
  event.preventDefault();

  const nameInput = document.getElementById('playerName');
  playerName = nameInput.value.trim();

  if (!playerName) {
    showError('Please enter your name');
    return;
  }

  const joinBtn = document.getElementById('joinBtn');
  const joinBtnText = document.getElementById('joinBtnText');
  const joinBtnSpinner = document.getElementById('joinBtnSpinner');

  joinBtn.disabled = true;
  joinBtnText.style.display = 'none';
  joinBtnSpinner.style.display = 'inline-block';

  socket.emit('grid-join', {
    gameId,
    playerId,
    playerName,
    clientType: 'web',
    timestamp: Date.now()
  });

  // Don't show lobby immediately - wait for server confirmation via grid-sync-players
}

function showError(message) {
  const errorEl = document.getElementById('errorMessage');
  errorEl.textContent = message;
  errorEl.style.display = 'block';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateLobbyTitle() {
  const lobbyTitleEl = document.getElementById('lobbyTitle');
  if (lobbyTitleEl) {
    lobbyTitleEl.textContent = lobbyName;
  }
}

function updatePlayersList() {
  const container = document.getElementById('playersList');
  const countSpan = document.getElementById('playerCount');

  countSpan.textContent = players.length;

  if (players.length === 0) {
    container.innerHTML = '<div class="waiting-text">No players yet...</div>';
    return;
  }

  container.innerHTML = players.map(player => {
    const isDisconnected = player.connected === false;
    const icon = isDisconnected ? '🌐' : (player.clientType === 'web' ? '🌐' : '💻');
    const isMe = player.id === playerId;
    const isHost = player.id === players[0]?.id;

    let leftBadges = '';
    let rightBadges = '';

    // Left side: Icon and "You" badge
    if (isMe && !isDisconnected) {
      leftBadges += '<span class="player-badge badge-you">You</span>';
    }

    // Right side: Status and Host badges
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
          <span class="player-icon" style="${isDisconnected ? 'filter: grayscale(100%);' : ''}">${icon}</span>
          <span class="player-name">${escapeHtml(player.name)}</span>
          ${leftBadges}
        </div>
        <div class="player-right">
          ${rightBadges}
        </div>
      </div>
    `;
  }).join('');
}

function renderBoard() {
  if (!board || board.length === 0) return;

  // Extract unique categories from board
  const uniqueCategories = [...new Set(board.map(tile => tile.categoryId))];
  categories = uniqueCategories.map(catId => {
    const tile = board.find(t => t.categoryId === catId);
    return {
      id: catId,
      title: tile.categoryTitle
    };
  });

  // Render category headers
  const headersEl = document.getElementById('categoryHeaders');
  headersEl.innerHTML = categories.map(cat =>
    `<div class="category-header">${escapeHtml(cat.title)}</div>`
  ).join('');

  // Get all difficulty values
  const difficulties = [100, 200, 300, 400, 500];

  // Render grid rows
  const rowsEl = document.getElementById('gridRows');
  rowsEl.innerHTML = difficulties.map(diff => {
    const row = categories.map(cat => {
      const tile = board.find(t => t.categoryId === cat.id && t.difficulty === diff);

      if (!tile) {
        return `<div class="grid-tile" style="opacity: 0.3;">-</div>`;
      }

      const isAnswered = tile.answered;
      const canSelect = selector === playerId && !isAnswered;
      const content = isAnswered ? '✓' : tile.points;

      return `
        <button class="grid-tile ${isAnswered ? 'answered' : canSelect ? 'selectable' : 'not-selectable'}"
             data-category="${tile.categoryId}"
             data-difficulty="${tile.difficulty}"
             ${!canSelect ? 'disabled' : ''}>
          ${content}
        </button>
      `;
    }).join('');

    return `<div class="grid-row">${row}</div>`;
  }).join('');

  // Add click handlers to tiles
  document.querySelectorAll('.grid-tile.selectable').forEach(tileEl => {
    tileEl.addEventListener('click', () => {
      const categoryId = tileEl.getAttribute('data-category');
      const difficulty = parseInt(tileEl.getAttribute('data-difficulty'));
      const tile = board.find(t => t.categoryId === categoryId && t.difficulty === difficulty);
      if (tile && selector === playerId) {
        selectTile(tile);
      }
    });
  });
}

function selectTile(tile) {
  socket.emit('grid-select-tile', {
    gameId,
    playerId,
    tile,
    timestamp: Date.now()
  });
}

function showQuestionScreen() {
  if (!currentTile) return;

  // Hide board, show question
  document.getElementById('boardScreen').classList.remove('active');
  document.getElementById('questionScreen').classList.add('active');

  // Update question header
  document.getElementById('modalCategory').textContent = currentTile.categoryTitle;
  document.getElementById('modalPoints').textContent = `${currentTile.points} pts`;

  // Start typewriter animation if typing is in progress, paused, or show full question
  if (typingInProgress || typingPausedAt !== null) {
    startTypewriterAnimation();
  } else {
    const questionElement = document.getElementById('modalQuestion');
    const questionText = currentTile.question?.question || currentTile.question || '';
    questionElement.textContent = questionText;
  }

  // Show selector indicator if there's a selector
  const selectorIndicator = document.getElementById('selectorIndicator');
  if (selector) {
    const selectorPlayer = players.find(p => p.id === selector);
    if (selectorPlayer) {
      document.getElementById('selectorName').textContent = selectorPlayer.name;
      selectorIndicator.style.display = 'block';
    } else {
      selectorIndicator.style.display = 'none';
    }
  } else {
    selectorIndicator.style.display = 'none';
  }

  updateQuestionTimers();
  updateLeaderboardQuestion();

  // Show/hide sections based on state
  const buzzerSection = document.getElementById('buzzerSection');
  const answeringStatus = document.getElementById('answeringStatus');
  const answerInputSection = document.getElementById('answerInputSection');
  const answerDisplay = document.getElementById('answerDisplay');
  const alreadyAttempted = document.getElementById('alreadyAttempted');
  const buzzBtn = document.getElementById('buzzBtn');

  if (showingAnswer) {
    // Answer is being shown - display it and hide everything else
    answerDisplay.style.display = 'block';
    buzzerSection.style.display = 'none';
    answeringStatus.style.display = 'none';
    answerInputSection.style.display = 'none';
    alreadyAttempted.style.display = 'none';
    displayAnswer(lastCorrectAnswerer);
    return;
  }

  const alreadyBuzzed = attemptedPlayers.includes(playerId);
  const amIBuzzing = currentBuzzer === playerId;
  const someoneElseBuzzing = currentBuzzer && currentBuzzer !== playerId;

  answerDisplay.style.display = 'none';

  if (amIBuzzing) {
    // I'm answering
    buzzerSection.style.display = 'none';
    answeringStatus.style.display = 'none';
    answerInputSection.style.display = 'block';
    alreadyAttempted.style.display = 'none';

    // Display incorrect answers from other players
    const incorrectAnswersAnswering = document.getElementById('incorrectAnswersAnswering');
    if (incorrectAnswers && incorrectAnswers.length > 0) {
      incorrectAnswersAnswering.innerHTML = incorrectAnswers.map(ia => `
        <div class="incorrect-answer-item">
          <div class="incorrect-answer-name">${ia.playerName} guessed:</div>
          <div class="incorrect-answer-text">${ia.answer}</div>
        </div>
      `).join('');
    } else {
      incorrectAnswersAnswering.innerHTML = '';
    }

    document.getElementById('answerInput').focus();
  } else if (someoneElseBuzzing) {
    // Someone else is answering
    buzzerSection.style.display = 'none';
    answeringStatus.style.display = 'block';
    answerInputSection.style.display = 'none';
    alreadyAttempted.style.display = 'none';
    const buzzer = players.find(p => p.id === currentBuzzer);
    document.getElementById('answeringText').textContent = `${buzzer?.name || 'Someone'} is answering...`;
  } else if (alreadyBuzzed) {
    // I already attempted - show gray box
    buzzerSection.style.display = 'none';
    answeringStatus.style.display = 'none';
    answerInputSection.style.display = 'none';
    alreadyAttempted.style.display = 'block';
  } else {
    // I can buzz in
    buzzerSection.style.display = 'block';
    answeringStatus.style.display = 'none';
    answerInputSection.style.display = 'none';
    alreadyAttempted.style.display = 'none';
    // Enable buzz button during typing or buzz window
    buzzBtn.disabled = !typingInProgress && !buzzerWindow;
    if (typingInProgress) {
      buzzBtn.textContent = 'Buzz In';
    } else if (buzzerWindow) {
      buzzBtn.textContent = 'Buzz In';
    } else {
      buzzBtn.textContent = 'Waiting...';
    }

    // Display incorrect answers if any
    const incorrectAnswersDisplay = document.getElementById('incorrectAnswersDisplay');
    if (incorrectAnswersDisplay && incorrectAnswers.length > 0) {
      incorrectAnswersDisplay.innerHTML = incorrectAnswers.map(ia => `
        <div class="incorrect-answer-item">
          <div class="incorrect-answer-header">${escapeHtml(ia.playerName)} guessed:</div>
          <div class="incorrect-answer-text">${escapeHtml(ia.answer)}</div>
        </div>
      `).join('');
    } else if (incorrectAnswersDisplay) {
      incorrectAnswersDisplay.innerHTML = '';
    }
  }
}

function showBoardScreen() {
  // Hide question, show board
  document.getElementById('questionScreen').classList.remove('active');
  document.getElementById('boardScreen').classList.add('active');

  // Reset answer input
  document.getElementById('answerInput').value = '';
  document.getElementById('submitAnswerBtn').disabled = true;

  // Re-render board to update answered tiles
  renderBoard();
}

function updateQuestionTimers() {
  document.getElementById('questionTime').textContent = timeRemaining;
  document.getElementById('modalGameTime').textContent = formatTime(gameTimeRemaining);

  // Hide question timer during typing
  const questionTimerEl = document.querySelector('.question-timer');
  if (questionTimerEl) {
    questionTimerEl.style.display = typingInProgress ? 'none' : 'flex';
  }

  // Update game timer color in question screen
  const gameTimerSmall = document.querySelector('.game-timer-small');
  if (gameTimerSmall) {
    gameTimerSmall.classList.remove('warning', 'critical');
    if (gameTimeRemaining <= 30) {
      gameTimerSmall.classList.add('critical');
    } else if (gameTimeRemaining <= 60) {
      gameTimerSmall.classList.add('warning');
    }
  }
}

function updateGameTimer() {
  const timerDisplay = document.getElementById('gameTimerDisplay');
  const timeEl = document.getElementById('gameTime');

  timeEl.textContent = formatTime(gameTimeRemaining);

  // Update timer styling
  timerDisplay.classList.remove('warning', 'critical');
  if (gameTimeRemaining <= 30) {
    timerDisplay.classList.add('critical');
  } else if (gameTimeRemaining <= 60) {
    timerDisplay.classList.add('warning');
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function buzzIn() {
  // Allow buzzing during typing OR during buzz window
  if ((!typingInProgress && !buzzerWindow) || attemptedPlayers.includes(playerId)) return;

  socket.emit('grid-buzz', {
    gameId,
    playerId,
    timestamp: Date.now()
  });
}

function submitAnswer() {
  const answerInput = document.getElementById('answerInput');
  const answer = answerInput.value.trim();

  if (!answer || !currentTile) return;

  // Validate answer locally
  const isCorrect = fuzzyMatchAnswer(answer, currentTile.question.answer);

  socket.emit('grid-answer', {
    gameId,
    playerId,
    answer,
    correct: isCorrect,
    tileInfo: {
      categoryId: currentTile.categoryId,
      difficulty: currentTile.difficulty
    },
    timestamp: Date.now()
  });

  // Clear input
  answerInput.value = '';
  document.getElementById('submitAnswerBtn').disabled = true;
}

function displayAnswer(lastCorrectAnswerer) {
  if (!currentTile) return;

  const answerDisplay = document.getElementById('answerDisplay');
  const answer = currentTile.question.answer;

  let className = 'answer-box';
  let label = 'Correct Answer';
  let winnerBadge = '';

  if (lastCorrectAnswerer && lastCorrectAnswerer !== 'none') {
    // Someone answered correctly - green box
    className += '';
    const winner = players.find(p => p.id === lastCorrectAnswerer);
    winnerBadge = `<span class="winner-badge">${escapeHtml(winner?.name || 'Someone')}</span>`;
  } else if (lastCorrectAnswerer === null) {
    // People attempted but all wrong - red box
    className += ' incorrect';
  } else {
    // No one attempted - blue box
    className += ' unanswered';
  }

  answerDisplay.className = className;
  answerDisplay.innerHTML = `
    <div class="answer-label-container">
      <div class="answer-label">${label}</div>
      ${winnerBadge}
    </div>
    <div class="answer-value">${escapeHtml(answer)}</div>
  `;
  answerDisplay.style.display = 'block';
}

function updateLeaderboard() {
  const container = document.getElementById('leaderboard');
  if (!container) return;

  const sortedPlayers = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));

  container.innerHTML = `
    <div class="standings-container">
      ${sortedPlayers.map(player => {
        const isMe = player.id === playerId;
        const isDisconnected = player.connected === false;
        const isSelector = player.id === selector;

        let badges = '';
        if (isDisconnected) {
          badges += '<span class="player-badge badge-disconnected" style="font-size: 11px; padding: 2px 6px;">DC</span>';
        } else if (isMe) {
          badges += '<span class="player-badge badge-you" style="font-size: 11px; padding: 2px 6px;">You</span>';
        }

        return `
          <div class="standings-item ${isSelector ? 'selector' : ''} ${isDisconnected ? 'disconnected' : ''}">
            <span class="player-name">${escapeHtml(player.name)}</span>
            <span class="player-score">${player.score || 0}</span>
            ${badges ? `<div class="player-badges">${badges}</div>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function updateLeaderboardQuestion() {
  const container = document.getElementById('leaderboardQuestion');
  if (!container) return;

  // Always hide leaderboard on question screen - only show on board screen
  container.style.display = 'none';
  // (leaderboard rendering removed - deliberately hidden on the question screen)
}

function showResults() {
  // Hide other screens
  document.getElementById('lobbyScreen').classList.remove('active');
  document.getElementById('boardScreen').classList.remove('active');
  document.getElementById('questionScreen').classList.remove('active');

  // Show results
  document.getElementById('resultsScreen').classList.add('active');

  const sortedPlayers = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const highestScore = sortedPlayers.length > 0 ? sortedPlayers[0].score : 0;
  const winners = sortedPlayers.filter(p => p.score === highestScore);
  const isDraw = winners.length === sortedPlayers.length && sortedPlayers.length > 1;
  const hasMultipleWinners = winners.length > 1 && !isDraw;

  // Winner announcement
  const announcementEl = document.getElementById('winnerAnnouncement');
  if (isDraw) {
    announcementEl.innerHTML = `
      <p class="winner-label">It's a Draw!</p>
      <p class="winner-score">${highestScore} points each</p>
    `;
  } else if (hasMultipleWinners) {
    announcementEl.innerHTML = `
      <p class="winner-label">Winners: <span class="winner-name">${winners.map(w => escapeHtml(w.name)).join(', ')}</span></p>
      <p class="winner-score">${highestScore} points</p>
    `;
  } else if (winners.length > 0) {
    announcementEl.innerHTML = `
      <p class="winner-label">Winner: <span class="winner-name">${escapeHtml(winners[0].name)}</span></p>
      <p class="winner-score">${highestScore} points</p>
    `;
  }

  // Final standings
  const standingsEl = document.getElementById('finalStandings');
  standingsEl.innerHTML = sortedPlayers.map((player, index) => {
    const isWinner = player.score === highestScore;
    const isMe = player.id === playerId;
    const isDisconnected = player.connected === false;

    let rankColor = '#808080';
    if (isWinner && !isDraw) {
      rankColor = '#eab308';
    } else if (index === 2) {
      rankColor = '#f97316';
    }

    let badges = '';
    if (isDisconnected) {
      badges += '<span class="player-badge badge-disconnected">Disconnected</span>';
    }
    if (isMe && !isDisconnected) {
      badges += '<span class="player-badge badge-you">You</span>';
    }
    if (player.antiCheat) {
      badges += '<span class="player-badge badge-anticheat">Anti-cheat detected irregular user behaviour</span>';
    }
    if (isWinner && !isDraw) {
      badges += `<svg class="trophy-small" style="display: inline-block; vertical-align: middle;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`;
    }

    return `
      <div class="player-item" style="margin-bottom: 6px; ${isDisconnected ? 'opacity: 0.6;' : ''}">
        <div class="player-left">
          <span class="player-rank" style="color: ${rankColor};">#${index + 1}</span>
          <span class="player-name">${escapeHtml(player.name)}</span>
          ${badges}
        </div>
        <span class="player-score" style="font-size: 18px;">${player.score || 0}</span>
      </div>
    `;
  }).join('');

  // Render score graph
  renderScoreGraph();

  // Render questions, answers & sources
  renderQuestionsSources();
}

function renderQuestionsSources() {
  const container = document.getElementById('questionsSources');
  if (!container) return;

  // Use answeredTiles array which contains tiles in the order they were answered
  const questions = answeredTiles || [];

  container.innerHTML = questions.map((q, index) => {
    let sourceHtml = '';
    if (q.source) {
      // Check if source contains a URL
      const urlMatch = q.source.match(/(https?:\/\/[^\s]+)/);
      if (urlMatch) {
        const url = urlMatch[1];
        const beforeUrl = q.source.substring(0, urlMatch.index);
        const afterUrl = q.source.substring(urlMatch.index + url.length);
        sourceHtml = `
          <div class="qa-source">
            <span class="qa-source-label">Source:</span>
            <span class="qa-source-text">
              ${escapeHtml(beforeUrl)}<a href="${url}" target="_blank" class="qa-source-link">${escapeHtml(url)}</a>${escapeHtml(afterUrl)}
            </span>
          </div>
        `;
      } else {
        sourceHtml = `
          <div class="qa-source">
            <span class="qa-source-label">Source:</span>
            <span class="qa-source-text">${escapeHtml(q.source)}</span>
          </div>
        `;
      }
    }

    // Only show answer if available
    const answerHtml = q.answer ? `
      <div class="qa-answer">
        <span class="qa-answer-label">A:</span>
        <span class="qa-answer-text">${escapeHtml(q.answer)}</span>
      </div>
    ` : '';

    return `
      <div class="question-answer-item">
        <div class="qa-question">
          <span class="qa-label">Q${index + 1}:</span>
          <span class="qa-text">${escapeHtml(q.question)}</span>
        </div>
        ${answerHtml}
        ${sourceHtml}
      </div>
    `;
  }).join('');
}

function renderScoreGraph() {
  const svg = document.getElementById('scoreGraph');
  const graphWidth = 500;
  const graphHeight = 200;
  const padding = { top: 15, right: 15, bottom: 30, left: 45 };
  const chartWidth = graphWidth - padding.left - padding.right;
  const chartHeight = graphHeight - padding.top - padding.bottom;

  const colors = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6'];

  // Find max history length
  let maxHistoryLength = 1;
  players.forEach(player => {
    const history = scoreHistory[player.id] || [0];
    if (history.length > maxHistoryLength) {
      maxHistoryLength = history.length;
    }
  });

  // Calculate min and max scores
  let minScore = 0;
  let maxScore = 100;

  players.forEach(player => {
    const history = scoreHistory[player.id] || [0];
    history.forEach(score => {
      if (score < minScore) minScore = score;
      if (score > maxScore) maxScore = score;
    });
  });

  const yMin = minScore < 0 ? Math.floor(minScore / 50) * 50 : 0;
  const yMax = Math.ceil(maxScore / 50) * 50;
  const yRange = yMax - yMin;
  const yScale = yRange > 0 ? chartHeight / yRange : chartHeight / 100;
  const xStep = chartWidth / (maxHistoryLength > 0 ? maxHistoryLength : 2);

  // Generate Y-axis labels
  const yLabels = [];
  const stepSize = yRange / 4;
  for (let i = 0; i <= 4; i++) {
    yLabels.push(Math.round(yMin + i * stepSize));
  }

  let svgContent = '';

  // Grid lines
  yLabels.forEach(val => {
    const y = padding.top + chartHeight - ((val - yMin) * yScale);
    svgContent += `
      <line x1="${padding.left}" y1="${y}" x2="${padding.left + chartWidth}" y2="${y}" stroke="#4a4a4a" stroke-width="1" />
      <text x="${padding.left - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="#b0b0b0">${val}</text>
    `;
  });

  // Player score lines
  players.forEach((player, playerIdx) => {
    const history = scoreHistory[player.id] || [0];
    const color = colors[playerIdx % colors.length];

    // Build path
    const pathData = history.map((score, idx) => {
      const x = padding.left + idx * xStep;
      const y = padding.top + chartHeight - ((score - yMin) * yScale);
      return idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
    }).join(' ');

    svgContent += `<path d="${pathData}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;

    // Points
    history.forEach((score, idx) => {
      const x = padding.left + idx * xStep;
      const y = padding.top + chartHeight - ((score - yMin) * yScale);
      svgContent += `<circle cx="${x}" cy="${y}" r="3" fill="${color}" stroke="white" stroke-width="1.5" />`;
    });
  });

  // Axes
  svgContent += `
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="#b0b0b0" stroke-width="2" />
    <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${padding.left + chartWidth}" y2="${padding.top + chartHeight}" stroke="#b0b0b0" stroke-width="2" />
  `;

  svg.innerHTML = svgContent;

  // Render legend
  const legendEl = document.getElementById('graphLegend');
  if (legendEl) {
    legendEl.innerHTML = players.map((player, idx) => {
      const color = colors[idx % colors.length];
      const isMe = player.id === playerId;
      return `
        <div class="legend-item">
          <div class="legend-dot" style="background-color: ${color};"></div>
          <span class="legend-name">${escapeHtml(player.name)}${isMe ? ' (You)' : ''}</span>
        </div>
      `;
    }).join('');
  }
}

function fuzzyMatchAnswer(userAnswer, correctAnswer) {
  const normalize = (str) => str.toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an)\s+/i, '');

  const normalizeCompact = (str) => str.toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const convertNumberWords = (str) => {
    const numberMap = {
      'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
      'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
      'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
      'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
      'eighteen': '18', 'nineteen': '19', 'twenty': '20', 'thirty': '30',
      'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
      'eighty': '80', 'ninety': '90', 'hundred': '100', 'thousand': '1000'
    };
    let result = str.toLowerCase();
    for (const [word, num] of Object.entries(numberMap)) {
      result = result.replace(new RegExp(`\\b${word}\\b`, 'g'), num);
    }
    return result;
  };

  const matchesRange = (user, correct) => {
    const rangePattern = /^(\d+(?:\.\d+)?)\s*[-–—to]\s*(\d+(?:\.\d+)?)$/;
    const userMatch = user.match(rangePattern);
    const correctMatch = correct.match(rangePattern);

    if (userMatch && correctMatch) {
      const userLow = parseFloat(userMatch[1]);
      const userHigh = parseFloat(userMatch[2]);
      const correctLow = parseFloat(correctMatch[1]);
      const correctHigh = parseFloat(correctMatch[2]);

      if (Math.abs(userLow - correctLow) < 0.01 && Math.abs(userHigh - correctHigh) < 0.01) {
        return true;
      }
    }
    return false;
  };

  const matchesAlternatives = (user, correct) => {
    if (correct.includes('/')) {
      const alternatives = correct.split('/').map(alt => normalize(alt.trim()));
      return alternatives.some(alt => normalizeCompact(user) === normalizeCompact(alt));
    }
    return false;
  };

  const matchesNumericWithUnits = (user, correct) => {
    const userNum = user.match(/[\d.]+/);
    const correctNum = correct.match(/[\d.]+/);

    if (userNum && correctNum) {
      if (Math.abs(parseFloat(userNum[0]) - parseFloat(correctNum[0])) < 0.01) {
        const userCompact = normalizeCompact(user);
        const correctCompact = normalizeCompact(correct);
        return userCompact === correctCompact;
      }
    }
    return false;
  };

  const userNorm = normalize(userAnswer);
  const correctNorm = normalize(correctAnswer);
  const userCompact = normalizeCompact(userAnswer);
  const correctCompact = normalizeCompact(correctAnswer);

  const userWithNumbers = convertNumberWords(userNorm);
  const correctWithNumbers = convertNumberWords(correctNorm);

  if (userCompact === correctCompact) return true;
  if (normalizeCompact(userWithNumbers) === normalizeCompact(correctWithNumbers)) return true;
  if (matchesRange(userNorm, correctNorm)) return true;
  if (matchesAlternatives(userNorm, correctNorm)) return true;
  if (matchesNumericWithUnits(userNorm, correctNorm)) return true;

  return false;
}
