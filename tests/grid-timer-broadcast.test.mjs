/**
 * Guards a broadcast-amplification regression in the game countdown timers:
 *
 *   jacarium-central/grid-game.js (startCountdownTimer) and
 *   jacarium-central/quiz-game.js (startQuizQuestionTimer) used to call
 *   broadcastGameState / broadcastQuizGameState from their 1-second
 *   setInterval, re-sending the ENTIRE game payload (board, players,
 *   scoreHistory, answeredTiles, questions, ...) to the whole room every
 *   single second - even though the only thing that changed on a tick is
 *   the countdown number, and every real state change (tile select, buzz,
 *   answer, typing transitions) already broadcasts full state from its own
 *   handler.
 *
 *   The fix: per-second ticks now emit a tiny room-scoped event instead -
 *     'grid-timer-tick'  { gameId, gameTimeRemaining, questionTimeRemaining, serverTime }
 *     'quiz-timer-tick'  { gameId, timeRemaining, timestamp }
 *   and the clients (src/hooks/useGridEventListeners.js,
 *   src/hooks/useQuizEventListeners.js, jacarium-central/public/grid.js,
 *   jacarium-central/public/quiz.js) merge those numbers into their
 *   existing local state, while 'grid-state-update' / 'quiz-state-update'
 *   (full payload) continue to fire only on actual state-changing events.
 *
 * This test spins up a REAL jacarium-central (random free port, temp
 * DATA_DIR), registers clients over the real TOFU auth flow, and drives real
 * socket.io-client connections through a grid game and a quiz game. It
 * asserts:
 *   (a) countdown ticks are the lightweight event with ONLY the countdown
 *       fields - no board/players/scoreHistory - and the full-state event
 *       does NOT fire once per second any more,
 *   (b) a real state-changing event (grid-select-tile) still delivers the
 *       full state correctly,
 *   (c) a client that replaces state on full updates and merges ticks (the
 *       exact merge the shipped clients perform) reconstructs a complete,
 *       current view: full board/players plus a live countdown,
 *   (d) sockets outside the game room receive neither ticks nor state.
 *
 * Run:  node tests/grid-timer-broadcast.test.mjs
 * Preconditions: central server deps installed (cd jacarium-central && npm ci)
 *                and repo deps installed (npm install, for socket.io-client).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SERVER_DIR = path.join(REPO, 'jacarium-central');

if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) {
  console.error('jacarium-central dependencies missing. Run: cd jacarium-central && npm ci');
  process.exit(1);
}
if (!fs.existsSync(path.join(REPO, 'node_modules', 'socket.io-client'))) {
  console.error('socket.io-client missing. Run: npm install');
  process.exit(1);
}

const repoRequire = createRequire(path.join(REPO, 'package.json'));
const { io: ioClient } = repoRequire('socket.io-client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-timer-test-'));
console.log('work/log dir:', WORKDIR);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startRealServer() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dataDir = path.join(WORKDIR, 'server-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(WORKDIR, 'server.log');
  const logStream = fs.createWriteStream(logPath);
  const proc = spawn('node', ['server.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, DEBUG_LOGGING: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logStream.write(d));
  proc.stderr.on('data', (d) => logStream.write(d));

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(200);
    up = await new Promise((resolve) => {
      const r = http.get(`${url}/api/health`, (res) => { res.resume(); resolve(true); });
      r.on('error', () => resolve(false));
      r.setTimeout(1000, () => { r.destroy(); resolve(false); });
    });
  }
  return { url, proc, up };
}

async function registerMachine(url, machineId) {
  const res = await fetch(`${url}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine_id: machineId }),
  });
  const json = await res.json();
  return json.secret;
}

async function connectAuthed(url, machineId) {
  const secret = await registerMachine(url, machineId);
  const socket = ioClient(url, { transports: ['websocket'], reconnection: false, timeout: 5000 });
  const received = { gridStates: [], gridTicks: [], quizStates: [], quizTicks: [] };
  socket.on('grid-state-update', (d) => received.gridStates.push(d));
  socket.on('grid-timer-tick', (d) => received.gridTicks.push(d));
  socket.on('quiz-state-update', (d) => received.quizStates.push(d));
  socket.on('quiz-timer-tick', (d) => received.quizTicks.push(d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`auth timeout for ${machineId}`)), 8000);
    socket.on('connect', () => socket.emit('authenticate', { machine_id: machineId, client_secret: secret }));
    socket.on('authenticated', (d) => {
      clearTimeout(t);
      if (d && d.success === false) reject(new Error(`auth rejected: ${d.error}`));
      else resolve();
    });
    socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
  return { socket, received, machineId };
}

/**
 * Mirror of the shipped client merge logic:
 *  - full 'grid-state-update' replaces the tracked fields (as
 *    useGridEventListeners.js / public/grid.js do),
 *  - 'grid-timer-tick' merges ONLY the countdown fields into existing state.
 */
function makeMirrorClient() {
  let state = {};
  return {
    onFullUpdate(d) {
      state = {
        ...state,
        gameState: d.state,
        board: d.board,
        players: d.players,
        scoreHistory: d.scoreHistory,
        currentTile: d.currentTile,
        gameTimeRemaining: d.gameTimeRemaining,
        timeRemaining: d.questionTimeRemaining,
        serverTime: d.serverTime ?? null,
      };
    },
    onTick(d) {
      state = {
        ...state,
        gameTimeRemaining: d.gameTimeRemaining,
        timeRemaining: d.questionTimeRemaining,
        serverTime: d.serverTime ?? state.serverTime,
      };
    },
    get state() { return state; },
  };
}

const GAME_ID = 'grid-timer-test-game';
const HOST_ID = 'host@grid-timer-test';
const PLAYER_ID = 'player@grid-timer-test';

const BOARD = [
  { categoryId: 'cat-a', difficulty: 1, points: 100, question: 'Q?', answer: 'A', answered: false },
  { categoryId: 'cat-b', difficulty: 1, points: 100, question: 'R?', answer: 'B', answered: false },
];

async function gridPart(srv) {
  console.log('\n--- Grid: per-second ticks are lightweight, real events still full ---');

  const host = await connectAuthed(srv.url, HOST_ID);
  const player = await connectAuthed(srv.url, PLAYER_ID);
  const outsider = await connectAuthed(srv.url, 'outsider@grid-timer-test');

  // Both players enter the lobby room; outsider never joins.
  host.socket.emit('grid-join', { gameId: GAME_ID, playerId: HOST_ID, playerName: 'Host', clientType: 'app', timestamp: Date.now() });
  await sleep(150);
  player.socket.emit('grid-join', { gameId: GAME_ID, playerId: PLAYER_ID, playerName: 'P2', clientType: 'app', timestamp: Date.now() });
  await sleep(300);

  const mirror = makeMirrorClient();
  player.socket.on('grid-state-update', (d) => { if (d.gameId === GAME_ID) mirror.onFullUpdate(d); });
  player.socket.on('grid-timer-tick', (d) => { if (d.gameId === GAME_ID) mirror.onTick(d); });

  // Start the game: server creates authoritative state and starts the 300s
  // game timer.
  host.socket.emit('grid-start', {
    gameId: GAME_ID,
    board: BOARD,
    selectedCategories: ['cat-a', 'cat-b'],
    players: [{ id: HOST_ID, name: 'Host' }, { id: PLAYER_ID, name: 'P2' }],
  });

  // Let the initial full-state broadcast land, then measure a quiet window
  // in which ONLY the timer is running (nobody selects/buzzes/answers).
  await sleep(500);
  const fullStatesAtStart = player.received.gridStates.length;
  check('grid-start delivers an initial full grid-state-update',
    fullStatesAtStart >= 1, `count=${fullStatesAtStart}`);

  await sleep(3400); // ~3 timer ticks with no real state change

  const quietFullStates = player.received.gridStates.length - fullStatesAtStart;
  const ticks = player.received.gridTicks;

  check('(a) NO grid-state-update fires during a countdown-only window',
    quietFullStates === 0, `extra full states=${quietFullStates}`);
  check('(a) grid-timer-tick fires roughly once per second',
    ticks.length >= 2 && ticks.length <= 5, `ticks=${ticks.length}`);

  const allowedKeys = ['gameId', 'gameTimeRemaining', 'questionTimeRemaining', 'serverTime'];
  const badTick = ticks.find((t) => {
    const keys = Object.keys(t).sort();
    return keys.length !== allowedKeys.length || keys.some((k) => !allowedKeys.includes(k));
  });
  check('(a) every tick carries ONLY countdown fields (no board/players/scoreHistory)',
    ticks.length > 0 && !badTick,
    badTick ? `unexpected keys: ${Object.keys(badTick).join(',')}` : `keys ok on ${ticks.length} ticks`);

  const countsDown = ticks.length >= 2 && ticks.every((t, i) =>
    i === 0 || t.gameTimeRemaining < ticks[i - 1].gameTimeRemaining);
  check('(a) tick gameTimeRemaining strictly counts down',
    countsDown, JSON.stringify(ticks.map((t) => t.gameTimeRemaining)));

  check('(d) socket outside the game room receives no ticks and no state',
    outsider.received.gridTicks.length === 0 && outsider.received.gridStates.length === 0,
    `ticks=${outsider.received.gridTicks.length} states=${outsider.received.gridStates.length}`);

  // (c) mirror client: full state must have survived the tick-only window,
  // with the countdown taken from the latest tick.
  const m = mirror.state;
  const lastTick = ticks[ticks.length - 1];
  check('(c) mirrored client still has the full board after tick-only merges',
    Array.isArray(m.board) && m.board.length === BOARD.length, `board=${m.board && m.board.length}`);
  check('(c) mirrored client still has all players with scores',
    Array.isArray(m.players) && m.players.length === 2 && m.players.every((p) => typeof p.score === 'number'),
    JSON.stringify(m.players && m.players.map((p) => `${p.id}:${p.score}`)));
  check('(c) mirrored countdown tracks the latest tick (timer visibly updates)',
    lastTick && m.gameTimeRemaining === lastTick.gameTimeRemaining && m.gameTimeRemaining < 300,
    `mirror=${m.gameTimeRemaining} lastTick=${lastTick && lastTick.gameTimeRemaining}`);

  // (b) a REAL state change must still broadcast the full payload.
  const fullStatesBeforeSelect = player.received.gridStates.length;
  host.socket.emit('grid-select-tile', { gameId: GAME_ID, playerId: HOST_ID, tile: BOARD[0] });
  await sleep(600);

  const selectStates = player.received.gridStates.slice(fullStatesBeforeSelect);
  const questionState = selectStates.find((s) => s.state === 'question');
  check('(b) grid-select-tile still triggers a full grid-state-update',
    !!questionState, `new full states=${selectStates.length}`);
  check('(b) that full update carries board, players, scoreHistory and currentTile',
    !!questionState &&
      Array.isArray(questionState.board) && questionState.board.length === BOARD.length &&
      Array.isArray(questionState.players) && questionState.players.length === 2 &&
      questionState.scoreHistory && typeof questionState.scoreHistory === 'object' &&
      questionState.currentTile && questionState.currentTile.categoryId === 'cat-a');
  check('(c) mirrored client picked up the question state from the full update',
    mirror.state.gameState === 'question' &&
      mirror.state.currentTile && mirror.state.currentTile.categoryId === 'cat-a',
    `state=${mirror.state.gameState}`);

  // During the question the question timer runs: ticks must keep flowing
  // (and stay lightweight) without extra full states beyond the typing
  // transitions, which are real state changes with their own broadcasts.
  const ticksBeforeQuestion = player.received.gridTicks.length;
  await sleep(2500);
  const questionTicks = player.received.gridTicks.slice(ticksBeforeQuestion);
  check('question-phase countdown also arrives as lightweight ticks',
    questionTicks.length >= 1 && questionTicks.every((t) => !('board' in t) && !('players' in t)),
    `ticks=${questionTicks.length}`);

  host.socket.disconnect();
  player.socket.disconnect();
  outsider.socket.disconnect();
  await sleep(200);
}

const QUIZ_GAME_ID = 'quiz-timer-test-game';
const QUIZ_HOST_ID = 'quizhost@grid-timer-test';
const QUIZ_PLAYER_ID = 'quizplayer@grid-timer-test';

async function quizPart(srv) {
  console.log('\n--- Quiz: same guarantee for the quiz question timer ---');

  const host = await connectAuthed(srv.url, QUIZ_HOST_ID);
  const player = await connectAuthed(srv.url, QUIZ_PLAYER_ID);

  host.socket.emit('quiz-join', { gameId: QUIZ_GAME_ID, playerId: QUIZ_HOST_ID, playerName: 'QHost', clientType: 'app', timestamp: Date.now() });
  await sleep(150);
  player.socket.emit('quiz-join', { gameId: QUIZ_GAME_ID, playerId: QUIZ_PLAYER_ID, playerName: 'QP2', clientType: 'app', timestamp: Date.now() });
  await sleep(300);

  host.socket.emit('quiz-start', {
    gameId: QUIZ_GAME_ID,
    questions: [
      { id: 'q1', question: 'First?', answer: 'one', hints: ['h1', 'h2'], category: 'Test' },
      { id: 'q2', question: 'Second?', answer: 'two', hints: ['h1', 'h2'], category: 'Test' },
    ],
    timestamp: Date.now(),
  });

  await sleep(500);
  const fullStatesAtStart = player.received.quizStates.length;
  check('quiz-start delivers initial full quiz-state-update(s)',
    fullStatesAtStart >= 1, `count=${fullStatesAtStart}`);

  await sleep(3400);

  const quietFullStates = player.received.quizStates.length - fullStatesAtStart;
  const ticks = player.received.quizTicks;
  check('NO quiz-state-update fires during a countdown-only window',
    quietFullStates === 0, `extra full states=${quietFullStates}`);
  check('quiz-timer-tick fires roughly once per second',
    ticks.length >= 2 && ticks.length <= 5, `ticks=${ticks.length}`);

  const allowedKeys = ['gameId', 'timeRemaining', 'timestamp'];
  const badTick = ticks.find((t) => {
    const keys = Object.keys(t).sort();
    return keys.length !== allowedKeys.length || keys.some((k) => !allowedKeys.includes(k));
  });
  check('every quiz tick carries ONLY { gameId, timeRemaining, timestamp }',
    ticks.length > 0 && !badTick,
    badTick ? `unexpected keys: ${Object.keys(badTick).join(',')}` : `keys ok on ${ticks.length} ticks`);

  const countsDown = ticks.length >= 2 && ticks.every((t, i) =>
    i === 0 || t.timeRemaining < ticks[i - 1].timeRemaining);
  check('quiz tick timeRemaining strictly counts down',
    countsDown, JSON.stringify(ticks.map((t) => t.timeRemaining)));

  host.socket.disconnect();
  player.socket.disconnect();
  await sleep(200);
}

// ===========================================================================

let exitCode = 1;
let srv = null;
try {
  srv = await startRealServer();
  check('real jacarium-central started', srv.up);
  if (srv.up) {
    await gridPart(srv);
    await quizPart(srv);
  }
  exitCode = results.every((r) => r.pass) ? 0 : 1;
  console.log(`\nSUMMARY: ${results.filter((r) => r.pass).length}/${results.length} passed`);
} catch (e) {
  console.error('TEST DRIVER ERROR:', e);
} finally {
  if (srv && srv.proc) srv.proc.kill();
  if (exitCode === 0) {
    try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    console.log(`server logs kept for inspection in: ${WORKDIR}`);
  }
  process.exit(exitCode);
}
