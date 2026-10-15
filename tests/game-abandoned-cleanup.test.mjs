/**
 * Guards the "abandoned game never disappears from Running Games" bug
 * (noticed with Tiles, but generic to all three game modes).
 *
 * The stale-game sweep only expires a game once EVERY player shows
 * connected: false - but two abandonment paths never marked players
 * disconnected at all, so `hasConnectedPlayer` stayed true and the game
 * stayed listed as a running game forever:
 *
 *  1. Web browser game clients (jacarium-central/public/*.js) join
 *     quiz/grid/tiles WITHOUT authenticating, so `machineId` is null on
 *     their socket - and the disconnect handler in socket-handlers.js
 *     only marked players for authenticated sockets (`if (machineId)`).
 *     A web player closing their tab was never marked disconnected.
 *  2. In the app, quitting an in-progress game with the X button calls
 *     onBack() (back to mode selection) without emitting a leave event,
 *     and the app's shared socket stays connected - so nothing on the
 *     server ever learned the player left. (Client fix: the X buttons in
 *     Grid/Quiz/Tiles now send grid-leave / quiz-leave / tiles-leave-lobby
 *     first; this test drives those same events at the socket level.)
 *
 * Server fix under test (socket-handlers.js): every game join is tracked
 * per-socket (joinedGames), and on 'disconnect' every associated player -
 * authenticated or not - is marked disconnected via the shared
 * markGamePlayerDisconnected() helper (also now used by the leave events).
 * Combined with the grace-period sweep (game-registry.js), abandoned games
 * are removed after GAME_ABANDONED_GRACE_MS while reconnection keeps
 * working within the window.
 *
 * Scenarios (against a REAL server, short sweep clock via env):
 *  A. Tiles: app host creates lobby, UNAUTHENTICATED web client joins,
 *     game starts. Web client's socket drops -> its player must be marked
 *     disconnected. Host quits via tiles-leave-lobby (the X-button path) ->
 *     0 connected, game stays reconnectable within grace; host rejoins and
 *     receives the live game state; host leaves again -> game is removed
 *     once the grace period expires.
 *  B. Grid lobby: unauthenticated web client joins the lobby and drops ->
 *     marked disconnected (the old disconnect handler skipped the registry
 *     entirely for grid games still in the lobby). Then the host's
 *     authenticated socket drops abruptly (crash) -> 0 connected -> game
 *     expires after grace.
 *
 * Run:  node tests/game-abandoned-cleanup.test.mjs
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
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'game-cleanup-test-'));
console.log('work/log dir:', WORKDIR);

const SWEEP_MS = 300;
const GRACE_MS = 2500;

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
  return socket;
}

/** Unauthenticated socket - exactly what the public web game pages use. */
async function connectWeb(url) {
  const socket = ioClient(url, { transports: ['websocket'], reconnection: false, timeout: 5000 });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('web connect timeout')), 8000);
    socket.on('connect', () => { clearTimeout(t); resolve(); });
    socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
  return socket;
}

async function fetchGame(url, gameId, playerId) {
  // Same request shape as the desktop app's fetchAvailableGames(): the
  // querying player is a registered app client and presents its secret.
  const res = await fetch(
    `${url}/api/games?playerId=${encodeURIComponent(playerId)}&machine_id=${encodeURIComponent(playerId)}`,
    { headers: { 'X-Client-Secret': pairingSecrets.get(playerId) || '' } }
  );
  const json = await res.json();
  return (json.games || []).find((g) => g.gameId === gameId) || null;
}

// ===========================================================================
// Scenario A: Tiles - web tab close + host X-quit, then expiry after grace
// ===========================================================================

const TILES_ID = 'tiles-cleanup-test';
const TILES_HOST = 'tileshost@cleanup-test';
const WEB_PLAYER = 'web-cleanup-guest';

async function tilesScenario(srv) {
  console.log('\n--- Tiles: web disconnect + host quit are both marked; game expires after grace ---');

  const host = await connectAuthed(srv.url, TILES_HOST);
  const hostStates = [];
  host.on('tiles-game-state-update', (d) => hostStates.push(d));

  host.emit('tiles-create-lobby', {
    lobbyId: TILES_ID, playerId: TILES_HOST, playerName: 'TilesHost',
    gridSize: 3, isSinglePlayer: false,
  });
  await sleep(200);

  const web = await connectWeb(srv.url);
  web.emit('tiles-join-lobby', {
    lobbyId: TILES_ID, playerId: WEB_PLAYER, playerName: 'WebGuest', clientType: 'web',
  });
  await sleep(200);

  host.emit('tiles-start', { lobbyId: TILES_ID });
  await sleep(300);

  let game = await fetchGame(srv.url, TILES_ID, TILES_HOST);
  check('tiles game running with 2 connected players (1 app, 1 unauthenticated web)',
    !!game && game.status === 'playing' && game.connectedPlayerCount === 2,
    game ? `status=${game.status} connected=${game.connectedPlayerCount}` : 'game missing');

  // Web player closes their browser tab: raw socket disconnect, no
  // authenticate ever happened on that socket, no leave event sent.
  web.disconnect();
  await sleep(400);

  game = await fetchGame(srv.url, TILES_ID, TILES_HOST);
  check('web player marked disconnected on raw socket drop (was stuck connected forever)',
    !!game && game.connectedPlayerCount === 1,
    game ? `connected=${game.connectedPlayerCount}` : 'game missing');

  // Host quits via the in-game X button: the client now sends
  // tiles-leave-lobby (previously it just unmounted and told nobody).
  host.emit('tiles-leave-lobby', { lobbyId: TILES_ID, playerId: TILES_HOST });
  await sleep(SWEEP_MS * 3);

  game = await fetchGame(srv.url, TILES_ID, TILES_HOST);
  check('fully abandoned tiles game still listed within grace, reconnectable by host',
    !!game && game.connectedPlayerCount === 0 && game.canReconnect === true,
    game ? `connected=${game.connectedPlayerCount} canReconnect=${game.canReconnect}` : 'game missing');

  // Host reconnects within the grace period and gets live game state back.
  const statesBefore = hostStates.length;
  host.emit('tiles-join-lobby', { lobbyId: TILES_ID, playerId: TILES_HOST, playerName: 'TilesHost', clientType: 'app' });
  await sleep(400);
  const rejoin = hostStates.slice(statesBefore).find((s) => s.lobbyId === TILES_ID);
  check('host reconnect within grace receives tiles-game-state-update with their grid',
    !!rejoin && Array.isArray(rejoin.myGrid) && rejoin.myGrid.length === 3,
    rejoin ? `grid=${rejoin.myGrid && rejoin.myGrid.length}` : 'no state update');
  game = await fetchGame(srv.url, TILES_ID, TILES_HOST);
  check('registry reflects the tiles reconnection', !!game && game.connectedPlayerCount === 1,
    game ? `connected=${game.connectedPlayerCount}` : 'game missing');

  // Abandon for good: quit again and let the grace period expire.
  host.emit('tiles-leave-lobby', { lobbyId: TILES_ID, playerId: TILES_HOST });
  await sleep(GRACE_MS + SWEEP_MS * 3);

  game = await fetchGame(srv.url, TILES_ID, TILES_HOST);
  check('abandoned tiles game removed from the browser once grace expires (no more eternal "Running Games" entry)',
    game === null, game ? `still listed: status=${game.status}` : 'gone');

  host.disconnect();
  await sleep(200);
}

// ===========================================================================
// Scenario B: Grid lobby - web drop marked, host crash marked, then expiry
// ===========================================================================

const GRID_ID = 'grid-cleanup-test';
const GRID_HOST = 'gridhost@cleanup-test';
const GRID_WEB = 'web-grid-cleanup-guest';

async function gridLobbyScenario(srv) {
  console.log('\n--- Grid lobby: web drop and host crash both marked; lobby expires after grace ---');

  const host = await connectAuthed(srv.url, GRID_HOST);
  host.emit('grid-join', { gameId: GRID_ID, playerId: GRID_HOST, playerName: 'GridHost', clientType: 'app', timestamp: Date.now() });
  await sleep(200);

  const web = await connectWeb(srv.url);
  web.emit('grid-join', { gameId: GRID_ID, playerId: GRID_WEB, playerName: 'WebGrid', clientType: 'web', timestamp: Date.now() });
  await sleep(200);

  let game = await fetchGame(srv.url, GRID_ID, GRID_HOST);
  check('grid lobby has 2 connected players', !!game && game.status === 'lobby' && game.connectedPlayerCount === 2,
    game ? `status=${game.status} connected=${game.connectedPlayerCount}` : 'game missing');

  // Web player's tab closes while the game is still in the LOBBY: the old
  // disconnect handler skipped the registry update entirely for grid games
  // with no started gridGames state.
  web.disconnect();
  await sleep(400);

  game = await fetchGame(srv.url, GRID_ID, GRID_HOST);
  check('web player marked disconnected in grid LOBBY on raw socket drop',
    !!game && game.connectedPlayerCount === 1,
    game ? `connected=${game.connectedPlayerCount}` : 'game missing');

  // Host's app crashes (abrupt authenticated-socket disconnect).
  host.disconnect();
  await sleep(400);

  game = await fetchGame(srv.url, GRID_ID, GRID_HOST);
  check('host crash marked disconnected; lobby still listed within grace (reconnectable)',
    !!game && game.connectedPlayerCount === 0 && game.canReconnect === true,
    game ? `connected=${game.connectedPlayerCount} canReconnect=${game.canReconnect}` : 'game missing');

  await sleep(GRACE_MS + SWEEP_MS * 3);
  game = await fetchGame(srv.url, GRID_ID, GRID_HOST);
  check('abandoned grid lobby removed once grace expires',
    game === null, game ? `still listed: status=${game.status}` : 'gone');
}

// ===========================================================================

let exitCode = 1;
let srv = null;
try {
  srv = await startRealServer();
  check('real jacarium-central started', srv.up);
  if (srv.up) {
    await tilesScenario(srv);
    await gridLobbyScenario(srv);
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
