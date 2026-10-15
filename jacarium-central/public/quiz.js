// Quiz Web Client
// Connects to the Jacarium central server via WebSocket and joins quiz games
//
// Server uses Socket.IO rooms for game isolation:
// - Each game has its own room identified by gameId
// - Events are only broadcast to players in the same game
// - No cross-game event leakage
// - Improved scalability for concurrent games

let socket = null;
let gameId = null;
let playerId = null;
let playerName = null;
let currentQuestionIndex = 0;
let questions = [];
let players = [];
let hintsRevealed = 0;
let timeRemaining = 30;
let timerInterval = null;
let hasAnswered = false;
let scoreHistory = {}; // Track score progression for each player
let currentQuestionAnswers = []; // Track who has answered current question
let lobbyName = 'Quiz Lobby'; // Default lobby name

// Constants
const POINTS_PER_QUESTION = 100;
const POINTS_DEDUCTION_PER_HINT = 25;
const QUESTION_TIME_SECONDS = 30;

// Extract game ID from URL
function getGameIdFromUrl() {
  const path = window.location.pathname;
  const match = path.match(/\/quiz\/([^/]+)/);
  return match ? match[1] : null;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  gameId = getGameIdFromUrl();

  if (!gameId) {
    showError('Invalid quiz URL. Please check your link.');
    return;
  }

  document.getElementById('gameIdDisplay').textContent = `Game ID: ${gameId}`;

  // Generate a unique player ID for this session
  playerId = `web-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Connect to WebSocket
  connectWebSocket();

  // Enable/disable submit button based on input
  const answerInput = document.getElementById('answerInput');
  answerInput.addEventListener('input', (e) => {
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = !e.target.value.trim() || hasAnswered;
  });

  // Submit on Enter key
  answerInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && answerInput.value.trim() && !hasAnswered) {
      submitAnswer();
    }
  });

  // Anti-cheat: Detect copy events on question text
  document.addEventListener('copy', handleCopyEvent);
});

function handleCopyEvent() {
  // Only track during active quiz
  const quizScreen = document.getElementById('quizScreen');
  if (!quizScreen.classList.contains('active')) {
    return;
  }

  // Get the selected text
  const selectedText = window.getSelection().toString().trim();

  // Only flag if they're copying a substantial portion of the question
  // Increased threshold to avoid false positives from highlighting/selecting text
  if (selectedText.length > 30) {
    const questionText = document.getElementById('questionText').textContent;

    // Check if copied text is from the question and is a significant portion (>40% of question)
    if (questionText && questionText.includes(selectedText)) {
      const percentageOfQuestion = (selectedText.length / questionText.length) * 100;

      if (percentageOfQuestion > 40) {

        // Mark ourselves as having triggered anti-cheat
        const myPlayer = players.find(p => p.id === playerId);
        if (myPlayer) {
          myPlayer.antiCheat = true;
        }

        console.log('[Anti-Cheat] Copy detected:', selectedText.length, 'chars,', percentageOfQuestion.toFixed(1), '% of question');

        // Notify server about anti-cheat trigger
        socket.emit('quiz-anticheat-trigger', {
          gameId,
          playerId,
          timestamp: Date.now()
        });
      }
    }
  }
}

// The page is served at /quiz/<id> by the central server itself and at
// <console>/central/quiz/<id> behind the console, which strips /central
// before forwarding. Whatever precedes /quiz/ in the page's own path is the
// prefix, and Socket.IO's engine lives at <prefix>/socket.io.
function pagePrefix() {
  const match = window.location.pathname.match(/^(.*?)\/quiz\/[^/]+/);
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

  // Quiz event listeners
  socket.on('quiz-join', (data) => {
    if (data.gameId === gameId) {
      addOrUpdatePlayer(data.playerId, data.playerName, 0, data.clientType, 'ready');
    }
  });

  socket.on('quiz-start', (data) => {
    if (data.gameId === gameId) {
      questions = data.questions || [];
      // Initialize score history for all players
      players.forEach(player => {
        scoreHistory[player.id] = [0];
      });
      if (questions.length > 0) {
        startQuiz();
      }
    }
  });

  // Note: quiz-submit-guess and quiz-next-question are no longer needed
  // Server broadcasts quiz-state-update instead

  socket.on('quiz-end', (data) => {
    if (data.gameId === gameId) {
      // Record final scores for all players
      players.forEach(player => {
        if (!scoreHistory[player.id]) {
          scoreHistory[player.id] = [0];
        }
        scoreHistory[player.id].push(player.score || 0);
      });

      showResults();
    }
  });

  socket.on('quiz-sync-players', (data) => {
    if (data.gameId === gameId) {
      // Successfully joined - show lobby screen
      document.getElementById('joinScreen').style.display = 'none';
      document.getElementById('lobbyScreen').classList.add('active');

      // Update lobby name if provided
      if (data.lobbyName) {
        lobbyName = data.lobbyName;
        updateLobbyTitle();
      }

      // Ensure all players have scores (default to 0 if missing)
      // Preserve local antiCheat flags, clientType, and connected state when updating from server
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
          clientType,
          // Preserve connected state - if server doesn't send it, use existing or default to true
          connected: p.connected !== undefined ? p.connected : (existingPlayer?.connected ?? true)
        };
      });
      updatePlayersList();
    }
  });

  socket.on('quiz-anticheat-trigger', (data) => {
    if (data.gameId === gameId) {
      const player = players.find(p => p.id === data.playerId);
      if (player) {
        player.antiCheat = true;
      }
    }
  });

  socket.on('lobby-name-update', (data) => {
    if (data.gameId === gameId) {
      lobbyName = data.lobbyName;
      updateLobbyTitle();
    }
  });

  // Lightweight per-second countdown tick. The server no longer re-sends the
  // full quiz payload from its 1s timer - only timeRemaining arrives here.
  socket.on('quiz-timer-tick', (data) => {
    if (data.gameId !== gameId) return;
    timeRemaining = data.timeRemaining;
    updateTimerDisplay();
  });

  // Server-authoritative state updates
  socket.on('quiz-state-update', (data) => {
    if (data.gameId !== gameId) return;

    // Update all state from server
    const { state: serverState, currentQuestionIndex: qIdx, timeRemaining: time,
            players: serverPlayers, scoreHistory: serverScoreHistory,
            questionAnswers: serverAnswers, questions: serverQuestions,
            currentQuestionAnswer, lobbyName: serverLobbyName } = data;

    // Update lobby name if provided
    if (serverLobbyName) {
      lobbyName = serverLobbyName;
      updateLobbyTitle();
    }

    // Check if question changed
    const questionChanged = qIdx !== currentQuestionIndex;

    // Reset ALL local state when question changes
    if (questionChanged) {
      hintsRevealed = 0;
      hasAnswered = false;  // Re-enable answering
      window.revealedAnswer = null;  // Clear revealed answer
      // Clear answer input if it exists
      const answerInput = document.getElementById('answerInput');
      if (answerInput) {
        answerInput.value = '';
        answerInput.disabled = false;
        answerInput.placeholder = 'Type your answer here...';
      }
      const submitBtn = document.getElementById('submitBtn');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Answer';
      }
    }

    // Only process currentQuestionAnswer if server explicitly sent it (when revealing)
    // Server omits this field during normal gameplay, only includes it when revealing
    if ('currentQuestionAnswer' in data && currentQuestionAnswer && !questionChanged) {
      window.revealedAnswer = currentQuestionAnswer;

      // Show the answer box
      const correctAnswerBox = document.getElementById('correctAnswerBox');
      const correctAnswerText = document.getElementById('correctAnswerText');
      correctAnswerText.textContent = currentQuestionAnswer;
      correctAnswerBox.style.display = 'block';

      // Hide input section
      document.getElementById('answerSection').style.display = 'none';
      document.getElementById('actionsSection').style.display = 'none';
    } else if (questionChanged) {
      // Clear revealed answer for new question
      window.revealedAnswer = null;
    }

    currentQuestionIndex = qIdx;
    timeRemaining = time;

    // Ensure all players have scores
    // Preserve local antiCheat flags and connected state when updating from server
    players = serverPlayers.map(p => {
      const existingPlayer = players.find(existing => existing.id === p.id);
      return {
        ...p,
        score: p.score ?? 0,
        antiCheat: existingPlayer?.antiCheat || p.antiCheat || false,
        // Preserve connected state - if server doesn't send it, use existing or default to true
        connected: p.connected !== undefined ? p.connected : (existingPlayer?.connected ?? true)
      };
    });
    scoreHistory = serverScoreHistory;
    currentQuestionAnswers = serverAnswers || [];

    // Update questions if not already set OR if quiz ended (server sends full questions with answers)
    if (serverQuestions && serverQuestions.length > 0) {
      if (!questions || questions.length === 0) {
        questions = serverQuestions;
      } else if (serverState === 'ended' && serverQuestions[0]?.answer) {
        // Quiz ended and we received full questions with answers - update them
        questions = serverQuestions;
      }
    }

    // Update UI based on current state
    if (questions.length > 0) {
      // Only call showQuestion when question actually changes
      if (questionChanged) {
        showQuestion();
      } else {
        // Just update the display without resetting state
        updateQuestionDisplay();
      }
      updateLeaderboard();
      // Timer is updated in updateQuestionDisplay/showQuestion
    }

    // Handle quiz ended
    if (serverState === 'ended') {
      showResults();
    }
  });

  socket.on('quiz-join-rejected', (data) => {
    if (data.gameId === gameId) {
      showError(data.reason || 'Unable to join this game.');

      // Re-enable join button
      const joinBtn = document.getElementById('joinBtn');
      const joinBtnText = document.getElementById('joinBtnText');
      const joinBtnSpinner = document.getElementById('joinBtnSpinner');

      if (joinBtn) {
        joinBtn.disabled = false;
        joinBtnText.style.display = 'inline';
        joinBtnSpinner.style.display = 'none';
      }
    }
  });

  socket.on('connect_error', () => {
    showError('Failed to connect to server. Please try again.');
  });
}

// Invoked from quiz.html (form onsubmit) - ESLint cannot see HTML references
// eslint-disable-next-line no-unused-vars
function joinQuiz(event) {
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

  // Send join event with clientType: 'web'
  socket.emit('quiz-join', {
    gameId,
    playerId,
    playerName,
    clientType: 'web',
    timestamp: Date.now()
  });

  // Don't show lobby immediately - wait for server confirmation via quiz-sync-players
}

function updateLobbyTitle() {
  const lobbyTitleEl = document.getElementById('lobbyTitle');
  if (lobbyTitleEl) {
    lobbyTitleEl.textContent = lobbyName;
  }
}

function addOrUpdatePlayer(id, name, score, clientType, status) {
  const existingIndex = players.findIndex(p => p.id === id);

  if (existingIndex >= 0) {
    
    players[existingIndex] = {
      ...players[existingIndex],
      name,
      score: score ?? players[existingIndex].score ?? 0,
      clientType,
      status: status || players[existingIndex].status || 'ready',
      antiCheat: players[existingIndex].antiCheat || false,
      connected: true // Mark as reconnected (or keep connected)
    };
  } else {
    players.push({
      id,
      name,
      score: score || 0,
      clientType: clientType || 'app',
      status: status || 'ready',
      antiCheat: false,
      connected: true // New players start as connected
    });
    // Initialize score history for new player
    if (!scoreHistory[id]) {
      scoreHistory[id] = [0];
    }
  }

  updatePlayersList();
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
    const isHost = player.id === players[0]?.id; // First player is typically the host

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

function startQuiz() {
  currentQuestionIndex = 0;
  hintsRevealed = 0;
  hasAnswered = false;

  document.getElementById('lobbyScreen').classList.remove('active');
  document.getElementById('quizScreen').classList.add('active');

  showQuestion();
}

function showQuestion() {
  if (currentQuestionIndex >= questions.length) {
    showResults();
    return;
  }

  // Reset state for new question
  hintsRevealed = 0;
  hasAnswered = false;
  currentQuestionAnswers = []; // Reset answers for new question
  window.revealedAnswer = null; // Clear any previous revealed answer

  // Clear input for new question
  const answerInput = document.getElementById('answerInput');
  answerInput.value = '';
  answerInput.disabled = false;
  answerInput.placeholder = 'Type your answer here...';

  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled = true; // Disabled until text is typed
  submitBtn.textContent = 'Submit Answer'; // Reset button text

  document.getElementById('hintBtn').disabled = false;
  document.getElementById('hintsContainer').style.display = 'none';
  document.getElementById('hintsContainer').innerHTML = '';
  document.getElementById('correctAnswerBox').style.display = 'none';
  document.getElementById('answerSection').style.display = 'block';
  document.getElementById('actionsSection').style.display = 'flex';

  // Update display after clearing state
  updateQuestionDisplay();

  // Hide source during quiz (only show in final results)
  document.getElementById('sourceContainer').style.display = 'none';

  // Update timer display from server
  updateTimerDisplay();

  // Don't start local timer - server manages time
  updateLeaderboard();
}

// Update question display without resetting state or clearing input
function updateQuestionDisplay() {
  if (currentQuestionIndex >= questions.length) return;

  const question = questions[currentQuestionIndex];
  const currentPoints = POINTS_PER_QUESTION - (hintsRevealed * POINTS_DEDUCTION_PER_HINT);

  document.getElementById('questionNumber').textContent =
    `Question ${currentQuestionIndex + 1} of ${questions.length}`;
  document.getElementById('categoryBadge').textContent = question.category || 'Quiz';
  document.getElementById('questionText').textContent = question.question;
  document.getElementById('pointsAvailable').textContent = currentPoints;

  // Update timer display
  updateTimerDisplay();

  // Show revealed answer if available (only if not cleared for new question)
  if (window.revealedAnswer) {
    const correctAnswerBox = document.getElementById('correctAnswerBox');
    const correctAnswerText = document.getElementById('correctAnswerText');
    correctAnswerText.textContent = window.revealedAnswer;
    correctAnswerBox.style.display = 'block';
  } else {
    // Hide answer box if no revealed answer
    document.getElementById('correctAnswerBox').style.display = 'none';
  }
}

function updateTimerDisplay() {
  // Update timer elements if they exist
  const timeRemainingEl = document.getElementById('timeRemaining');
  if (timeRemainingEl) {
    timeRemainingEl.textContent = timeRemaining;
  }

  const timerEl = document.getElementById('timer');
  if (timerEl) {
    timerEl.textContent = `${timeRemaining}s`;
  }
}

// Invoked from quiz.html (hint button onclick) - ESLint cannot see HTML references
// eslint-disable-next-line no-unused-vars
function requestHint() {
  const question = questions[currentQuestionIndex];

  if (hintsRevealed >= question.hints.length) {
    return;
  }

  const hint = question.hints[hintsRevealed];
  hintsRevealed++;

  const currentPoints = POINTS_PER_QUESTION - (hintsRevealed * POINTS_DEDUCTION_PER_HINT);
  document.getElementById('pointsAvailable').textContent = currentPoints;

  const hintsContainer = document.getElementById('hintsContainer');

  if (hintsRevealed === 1) {
    hintsContainer.style.display = 'block';
    hintsContainer.innerHTML = `
      <div class="hints-title">💡 Hints:</div>
      <ul id="hintsList"></ul>
    `;
  }

  const hintsList = document.getElementById('hintsList');
  const hintEl = document.createElement('li');
  hintEl.className = 'hint-item';
  hintEl.textContent = hint;
  hintsList.appendChild(hintEl);

  if (hintsRevealed >= question.hints.length) {
    document.getElementById('hintBtn').disabled = true;
  }
}

function submitAnswer() {
  if (hasAnswered) return;

  const answerInput = document.getElementById('answerInput');
  const myAnswer = answerInput.value.trim();

  if (!myAnswer) {
    return;
  }

  hasAnswered = true;

  const question = questions[currentQuestionIndex];

  // Submit answer to server (server will validate and update scores)
  socket.emit('quiz-submit-guess', {
    gameId,
    playerId,
    questionId: question.id,
    answer: myAnswer,
    hintsRevealed: hintsRevealed,
    timestamp: Date.now()
  });

  // Disable input and button
  answerInput.disabled = true;
  answerInput.placeholder = 'Answer submitted';
  document.getElementById('submitBtn').disabled = true;
  document.getElementById('submitBtn').textContent = '✓ Submitted';
  document.getElementById('hintBtn').disabled = true;

  // Server will handle showing the answer and advancing
}

function updateLeaderboard() {
  const container = document.getElementById('leaderboard');
  if (!container) {
    return;
  }

  const sortedPlayers = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));

  // Get current question ID to filter answers for this question
  const currentQuestion = questions[currentQuestionIndex];
  const currentQuestionId = currentQuestion ? currentQuestion.id : null;

  container.innerHTML = sortedPlayers.map((player, index) => {
    const position = index + 1;
    const isMe = player.id === playerId;

    // Check if player answered current question
    const hasAnswered = currentQuestionAnswers.some(
      ans => ans.playerId === player.id && ans.questionId === currentQuestionId
    );
    const isDisconnected = player.connected === false;

    let badges = '';
    if (isDisconnected) {
      badges += '<span class="player-badge badge-disconnected">Disconnected</span>';
    }
    if (isMe && !isDisconnected) {
      badges += '<span class="player-badge badge-you">You</span>';
    }
    if (hasAnswered && !isDisconnected) {
      badges += '<span class="player-badge badge-answered">✓ Answered</span>';
    }

    return `
      <div class="standings-item" style="${isDisconnected ? 'opacity: 0.6;' : ''}">
        <div class="standings-left">
          <span class="player-rank">#${position}</span>
          <span class="player-name">${escapeHtml(player.name)}</span>
          ${badges}
        </div>
        <span class="player-score">${player.score || 0}</span>
      </div>
    `;
  }).join('');
}

function showResults() {
  if (timerInterval) {
    clearInterval(timerInterval);
  }

  document.getElementById('quizScreen').classList.remove('active');
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

    // Determine rank color
    let rankColor = '#808080'; // gray for default
    if (isWinner && !isDraw) {
      rankColor = '#eab308'; // yellow for winner
    } else if (isDraw) {
      rankColor = '#808080'; // gray for draw
    } else if (index === 2) {
      rankColor = '#f97316'; // orange for 3rd place
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

  // Score progression graph
  renderScoreGraph();

  // Questions, Answers & Sources
  renderQuestionsSources();
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

function renderScoreGraph() {
  const svg = document.getElementById('scoreGraph');
  const graphWidth = 500;
  const graphHeight = 200;
  const padding = { top: 15, right: 15, bottom: 30, left: 45 };
  const chartWidth = graphWidth - padding.left - padding.right;
  const chartHeight = graphHeight - padding.top - padding.bottom;

  // Player colors
  const colors = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6'];

  // Calculate max score for Y-axis
  const maxScore = Math.max(...players.map(p => p.score || 0), 100);
  const yMax = Math.ceil(maxScore / 100) * 100;
  const yScale = chartHeight / yMax;
  const xStep = chartWidth / questions.length;

  // Generate Y-axis labels
  const yLabels = [];
  const stepSize = yMax / 4;
  for (let i = 0; i <= 4; i++) {
    yLabels.push(Math.round(i * stepSize));
  }

  let svgContent = '';

  // Grid lines
  yLabels.forEach(val => {
    const y = padding.top + chartHeight - (val * yScale);
    svgContent += `
      <line x1="${padding.left}" y1="${y}" x2="${padding.left + chartWidth}" y2="${y}" stroke="#4a4a4a" stroke-width="1" />
      <text x="${padding.left - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="#b0b0b0">${val}</text>
    `;
  });

  // X-axis labels (question numbers)
  questions.forEach((_, idx) => {
    const x = padding.left + (idx + 1) * xStep;
    svgContent += `<text x="${x}" y="${padding.top + chartHeight + 15}" text-anchor="middle" font-size="10" fill="#b0b0b0">Q${idx + 1}</text>`;
  });

  // Player score lines
  players.forEach((player, playerIdx) => {
    const history = scoreHistory[player.id] || [0];
    const color = colors[playerIdx % colors.length];

    // Extend history to cover all questions (carry forward last score)
    const extendedHistory = [];
    for (let i = 0; i <= questions.length; i++) {
      if (i < history.length) {
        extendedHistory.push(history[i]);
      } else {
        // Carry forward the last known score
        extendedHistory.push(history[history.length - 1] || 0);
      }
    }

    // Build path
    const pathData = extendedHistory.map((score, idx) => {
      const x = padding.left + idx * xStep;
      const y = padding.top + chartHeight - (score * yScale);
      return idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
    }).join(' ');

    svgContent += `<path d="${pathData}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;

    // Points
    extendedHistory.forEach((score, idx) => {
      const x = padding.left + idx * xStep;
      const y = padding.top + chartHeight - (score * yScale);
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

function renderQuestionsSources() {
  const container = document.getElementById('questionsSources');

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
