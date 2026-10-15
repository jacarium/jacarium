/**
 * Guards the Grid "closed the game window -> impossible to reconnect" bug.
 *
 * Root cause: the periodic stale-game sweep (previously inline in
 * jacarium-central/server.js) removed any game whose players were all
 * disconnected as soon as the game was older than ONE MINUTE - it compared
 * against game AGE (now - createdAt), not against how long the players had
 * been disconnected. Closing the floating Grid window sends 'grid-leave',
 * which marks the player disconnected (correct, reconnectable state), but
 * within <=30s the sweep deleted the registry entry AND the authoritative
 * gridGames state, so GET /api/games no longer returned the game and there
 * was nothing left to reconnect to. The same sweep also deleted any
 * still-occupied lobby older than a minute.
 *
 * The fix (jacarium-central/game-registry.js sweepStaleGames): games are
 * expired only after ALL players have been disconnected for a grace period
 * (GAME_ABANDONED_GRACE_MS, default 3 minutes), tracked via
 * allDisconnectedSince - never via game age.
 *
 * Two layers of verification:
 *
 * 1) UNIT: requires the real game-registry module in-process and drives
 *    sweepStaleGames() with synthetic clocks. This directly encodes the
 *    regression: a game far older than the old 1-minute threshold whose
 *    players disconnected only seconds ago MUST survive, and an occupied
 *    lobby MUST survive regardless of age.
 *
 * 2) END-TO-END: spins up a REAL jacarium-central (random port, short
 *    sweep interval + grace via env) and drives real socket.io clients
 *    through: join -> start -> score points -> grid-leave (window close) ->
 *    verify the game stays listed with canReconnect=true across several
 *    sweep ticks -> grid-join again -> verify the reconnected client
 *    receives the authoritative state with its prior score intact and the
 *    API reflects the reconnection -> leave again -> verify the game IS
 *    removed once the grace period truly expires.
 *
 * Run:  node tests/grid-leave-reconnect.test.mjs
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
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-reconnect-test-'));
console.log('work/log dir:', WORKDIR);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

// ===========================================================================
// Part 1: unit-level sweep semantics (in-process, synthetic clock)
// ===========================================================================

function unitPart() {
  console.log('\n--- Unit: sweepStaleGames uses disconnect duration, never game age ---');

  const { gameRegistry, gridGames } = serverRequire('./state');
  const registry = serverRequire('./game-registry');
  const {
    registerGame, updateGameStatus, updateGamePlayers,
    sweepStaleGames, GAME_ABANDONED_GRACE_MS, GAME_ENDED_LINGER_MS
  } = registry;

  const now = Date.now();
  const TEN_MIN = 10 * 60 * 1000;

  // (a) THE regression: game far older than the old 1-minute threshold,
  // players disconnected only "just now" -> must survive the sweep.
  registerGame('grid-old-abandoned-recently', 'grid', 'host@u');
  const g1 = gameRegistry.get('grid-old-abandoned-recently');
  g1.createdAt = now - TEN_MIN;
  g1.startedAt = now - TEN_MIN;
  g1.status = 'playing';
  updateGamePlayers('grid-old-abandoned-recently', [
    { id: 'host@u', name: 'Host', connected: false },
    { id: 'p2@u', name: 'P2', connected: false },
  ]);
  gridGames.set('grid-old-abandoned-recently', { gameTimer: null, questionTimer: null, players: g1.players });

  sweepStaleGames(now + 1000); // 1s after everyone disconnected
  check('(unit) 10-minute-old game whose players left 1s ago SURVIVES the sweep',
    gameRegistry.has('grid-old-abandoned-recently') && gridGames.has('grid-old-abandoned-recently'));

  sweepStaleGames(now + Math.floor(GAME_ABANDONED_GRACE_MS / 2));
  check('(unit) still present halfway through the grace period',
    gameRegistry.has('grid-old-abandoned-recently'));

  sweepStaleGames(now + GAME_ABANDONED_GRACE_MS + 1000);
  check('(unit) removed (registry AND gridGames) once grace period elapses',
    !gameRegistry.has('grid-old-abandoned-recently') && !gridGames.has('grid-old-abandoned-recently'));

  // (b) Occupied lobby much older than the old 1-minute LOBBY_TIMEOUT ->
  // must never be removed while a player is connected.
  registerGame('grid-old-occupied-lobby', 'grid', 'host2@u');
  const g2 = gameRegistry.get('grid-old-occupied-lobby');
  g2.createdAt = now - TEN_MIN;
  updateGamePlayers('grid-old-occupied-lobby', [{ id: 'host2@u', name: 'Host2', connected: true }]);

  sweepStaleGames(now + GAME_ABANDONED_GRACE_MS * 3);
  check('(unit) occupied 10-minute-old lobby survives indefinitely',
    gameRegistry.has('grid-old-occupied-lobby'));

  // (c) Player disconnects, then reconnects within grace -> the sweep must
  // clear the tracking and never expire the game afterwards.
  updateGamePlayers('grid-old-occupied-lobby', [{ id: 'host2@u', name: 'Host2', connected: false }]);
  sweepStaleGames(now + 1000);
  check('(unit) grace tracking starts when last player disconnects',
    gameRegistry.has('grid-old-occupied-lobby') && g2.allDisconnectedSince !== null);
  updateGamePlayers('grid-old-occupied-lobby', [{ id: 'host2@u', name: 'Host2', connected: true }]);
  sweepStaleGames(now + GAME_ABANDONED_GRACE_MS * 3);
  check('(unit) reconnection within grace clears tracking; game survives',
    gameRegistry.has('grid-old-occupied-lobby') && g2.allDisconnectedSince === null);

  // (d) Ended games linger briefly for final scores, then go away.
  registerGame('grid-ended', 'grid', 'host3@u');
  updateGamePlayers('grid-ended', [{ id: 'host3@u', name: 'Host3', connected: true }]);
  updateGameStatus('grid-ended', 'ended');
  sweepStaleGames(Date.now() + 1000);
  check('(unit) freshly ended game lingers for final-score display',
    gameRegistry.has('grid-ended'));
  sweepStaleGames(Date.now() + GAME_ENDED_LINGER_MS + 1000);
  check('(unit) ended game removed after linger window',
    !gameRegistry.has('grid-ended'));

  // (e) Empty player list -> removed immediately.
  registerGame('grid-empty', 'grid', 'host4@u');
  sweepStaleGames(Date.now());
  check('(unit) game with empty player list removed immediately',
    !gameRegistry.has('grid-empty'));

  // Cleanup shared maps for good measure.
  gameRegistry.clear();
  gridGames.clear();
}

// ===========================================================================
// Part 2: end-to-end against a real server with a short sweep clock
// ===========================================================================

const SWEEP_MS = 300;
const GRACE_MS = 2500;

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
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DEBUG_LOGGING: '',
      GAME_CLEANUP_INTERVAL_MS: String(SWEEP_MS),
      GAME_ABANDONED_GRACE_MS: String(GRACE_MS),
    },
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

// machineId -> pairing secret, so /api/games (which requires pairing auth
// like every other sync route) can be queried as a registered app client.
const pairingSecrets = new Map();

async function registerMachine(url, machineId) {
  const res = await fetch(`${url}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine_id: machineId }),
  });
  const json = await res.json();
  if (json.secret) pairingSecrets.set(machineId, json.secret);
  return json.secret;
}

async function connectAuthed(url, machineId) {
  const secret = await registerMachine(url, machineId);
  const socket = ioClient(url, { transports: ['websocket'], reconnection: false, timeout: 5000 });
  const received = { gridStates: [] };
  socket.on('grid-state-update', (d) => received.gridStates.push(d));
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

async function fetchGames(url, playerId) {
  // Same request shape as the desktop app's fetchAvailableGames(): the
  // querying player is a registered app client and presents its secret.
  const res = await fetch(
    `${url}/api/games?playerId=${encodeURIComponent(playerId)}&machine_id=${encodeURIComponent(playerId)}`,
    { headers: { 'X-Client-Secret': pairingSecrets.get(playerId) || '' } }
  );
  const json = await res.json();
  return json.games || [];
}

const GAME_ID = 'grid-reconnect-test-game';
const HOST_ID = 'host@reconnect-test';
const PLAYER_ID = 'player@reconnect-test';

const BOARD = [
  { categoryId: 'cat-a', categoryTitle: 'A', difficulty: 100, points: 100, question: { question: 'Q one?', answer: 'one' }, answered: false },
  { categoryId: 'cat-b', categoryTitle: 'B', difficulty: 100, points: 100, question: { question: 'Q two?', answer: 'two' }, answered: false },
];

async function e2ePart(srv) {
  console.log('\n--- E2E: leave via window close, reconnect with prior state intact ---');

  const host = await connectAuthed(srv.url, HOST_ID);
  const player = await connectAuthed(srv.url, PLAYER_ID);

  // Lobby: both players join.
  host.socket.emit('grid-join', { gameId: GAME_ID, playerId: HOST_ID, playerName: 'Host', clientType: 'app', timestamp: Date.now() });
  await sleep(150);
  player.socket.emit('grid-join', { gameId: GAME_ID, playerId: PLAYER_ID, playerName: 'P2', clientType: 'app', timestamp: Date.now() });
  await sleep(300);

  // Start the game (host becomes selector) and score 100 points as host:
  // select tile -> buzz during typing -> answer correct.
  host.socket.emit('grid-start', {
    gameId: GAME_ID,
    board: BOARD,
    selectedCategories: ['cat-a', 'cat-b'],
    players: [{ id: HOST_ID, name: 'Host' }, { id: PLAYER_ID, name: 'P2' }],
  });
  await sleep(400);
  host.socket.emit('grid-select-tile', { gameId: GAME_ID, playerId: HOST_ID, tile: BOARD[0] });
  await sleep(300);
  host.socket.emit('grid-buzz', { gameId: GAME_ID, playerId: HOST_ID });
  await sleep(200);
  host.socket.emit('grid-answer', { gameId: GAME_ID, playerId: HOST_ID, answer: 'one', correct: true });
  await sleep(400);

  const preLeave = host.received.gridStates[host.received.gridStates.length - 1];
  const hostScorePreLeave = preLeave && preLeave.players.find((p) => p.id === HOST_ID)?.score;
  check('host scored 100 points before leaving', hostScorePreLeave === 100, `score=${hostScorePreLeave}`);

  // Both clients "close the floating window": the shell dispatches
  // floatingQuizClosing and GridGameMode sends grid-leave.
  player.socket.emit('grid-leave', { gameId: GAME_ID, playerId: PLAYER_ID, timestamp: Date.now() });
  await sleep(150);
  host.socket.emit('grid-leave', { gameId: GAME_ID, playerId: HOST_ID, timestamp: Date.now() });

  // Survive several sweep ticks while inside the grace period.
  await sleep(SWEEP_MS * 4);

  let games = await fetchGames(srv.url, HOST_ID);
  let game = games.find((g) => g.gameId === GAME_ID);
  check('game still listed by /api/games after leave (across >=3 sweep ticks)', !!game);
  check('game is reconnectable: canReconnect=true, 0 connected players, still playing',
    !!game && game.canReconnect === true && game.connectedPlayerCount === 0 && game.status === 'playing',
    game ? `canReconnect=${game.canReconnect} connected=${game.connectedPlayerCount} status=${game.status}` : 'game missing');

  // Reconnect: exactly what GameBrowser's Reconnect button does - grid-join
  // then grid-request-sync.
  const statesBefore = host.received.gridStates.length;
  host.socket.emit('grid-join', { gameId: GAME_ID, playerId: HOST_ID, playerName: 'Host', clientType: 'app', timestamp: Date.now() });
  await sleep(400);
  host.socket.emit('grid-request-sync', { gameId: GAME_ID, requesterId: HOST_ID });
  await sleep(400);

  const rejoinStates = host.received.gridStates.slice(statesBefore).filter((s) => s.gameId === GAME_ID);
  const rejoined = rejoinStates[rejoinStates.length - 1];
  check('reconnecting host receives authoritative grid-state-update(s)',
    rejoinStates.length >= 1, `count=${rejoinStates.length}`);
  const hostAfter = rejoined && rejoined.players.find((p) => p.id === HOST_ID);
  check('rejoined state: host is connected again with prior score intact',
    !!hostAfter && hostAfter.connected !== false && hostAfter.score === 100,
    hostAfter ? `connected=${hostAfter.connected} score=${hostAfter.score}` : 'host missing from state');
  check('rejoined state: board and score history preserved',
    !!rejoined && Array.isArray(rejoined.board) && rejoined.board.length === BOARD.length &&
      rejoined.scoreHistory && Array.isArray(rejoined.scoreHistory[HOST_ID]),
    rejoined ? `board=${rejoined.board.length}` : 'no state');

  games = await fetchGames(srv.url, HOST_ID);
  game = games.find((g) => g.gameId === GAME_ID);
  check('/api/games reflects the reconnection (1 connected, no longer canReconnect)',
    !!game && game.connectedPlayerCount === 1 && game.canReconnect === false,
    game ? `connected=${game.connectedPlayerCount} canReconnect=${game.canReconnect}` : 'game missing');

  // The game must also survive sweeps WHILE someone is connected, well past
  // the grace period (the old sweep would have killed a 1-minute-old game;
  // here grace is 2.5s so this window is equivalent to many multiples).
  await sleep(GRACE_MS + SWEEP_MS * 3);
  games = await fetchGames(srv.url, HOST_ID);
  check('game survives well past the grace period while host is connected',
    games.some((g) => g.gameId === GAME_ID));

  // Abandon for real: host leaves again and nobody comes back.
  host.socket.emit('grid-leave', { gameId: GAME_ID, playerId: HOST_ID, timestamp: Date.now() });
  await sleep(GRACE_MS + SWEEP_MS * 3);
  games = await fetchGames(srv.url, HOST_ID);
  check('fully abandoned game IS removed once the grace period expires',
    !games.some((g) => g.gameId === GAME_ID));

  host.socket.disconnect();
  player.socket.disconnect();
  await sleep(200);
}

// ===========================================================================

let exitCode = 1;
let srv = null;
try {
  unitPart();

  srv = await startRealServer();
  check('real jacarium-central started', srv.up);
  if (srv.up) {
    await e2ePart(srv);
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
