/**
 * Shared mutable state and configuration constants for the Jacarium central server.
 *
 * This module is the leaf of the dependency graph: every other module may
 * require() it, and it requires nothing feature-specific itself.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || process.argv[2] || 3000;
// The address to listen on: every interface by default (a development
// server), 127.0.0.1 inside the console container (deploy/entrypoint.sh),
// where Caddy is the only client.
const HOST = process.env.HOST || '0.0.0.0';
// Raw CORS_ORIGIN value ('' when unset). server.js turns it into the actual
// policy via cors-policy.js: unset means "desktop-app origins only", NOT '*'.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const USE_HTTPS = process.env.USE_HTTPS === 'true';
// Optional shared enrollment secret. When set, a previously-unseen
// machine_id can only register (POST /api/register) by presenting it in the
// X-Enrollment-Secret header; when unset, enrollment stays open
// (trust-on-first-use) exactly as before, with a startup warning.
// Admin-configured (deploy-podman.sh passes it through); users enter the
// same value once in the app's Cloud Settings.
const ENROLLMENT_SECRET = (process.env.ENROLLMENT_SECRET || '').trim();
// Behind the console's reverse proxy (deploy/Caddyfile, path /central/*)
// the client address is in X-Forwarded-For: TRUST_PROXY=1 makes req.ip
// (rate limits, logs) the real client, not the proxy. Only set it when the
// proxy is the only way in, as the deploy scripts arrange.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// TLS material is never part of the checkout. Resolution order:
//   1. CERT_PATH env var;
//   2. ./certs next to the server - this is where deploy-podman.sh mounts
//      the operator's certs inside the container (read-only);
//   3. ~/.config/jacarium/central/certs - where
//      generate-certs.sh writes by default for non-container runs.
function defaultCertPath() {
  const local = path.join(__dirname, 'certs');
  if (fs.existsSync(path.join(local, 'key.pem')) && fs.existsSync(path.join(local, 'cert.pem'))) {
    return local;
  }
  return path.join(os.homedir(), '.config', 'jacarium', 'central', 'certs');
}
const CERT_PATH = process.env.CERT_PATH || defaultCertPath();
const SSL_KEY = path.join(CERT_PATH, 'key.pem');
const SSL_CERT = path.join(CERT_PATH, 'cert.pem');

// Opt-in debug logging: set DEBUG_LOGGING=1 to enable verbose per-request/
// per-event logs. Errors, security events and lifecycle logs always print.
const DEBUG_LOGGING = process.env.DEBUG_LOGGING === '1';
function debugLog(...args) {
  if (DEBUG_LOGGING) console.log(...args);
}

// Connected clients map: machineId -> socket
const connectedClients = new Map();

// One identity may be connected from several devices at once (an account's
// browser and its linked desktop share one machine_id, see the console's
// src/utils/cloudCentralSync.js): the map's value is a ClientLink that
// fans every emit out to all of that identity's sockets. Handlers that
// scope a message to a document room ask the link (inRoom / emitToRoom).
class ClientLink {
  constructor(id) {
    this.id = id;
    this.sockets = new Set();
  }
  emit(event, payload) {
    for (const s of this.sockets) s.emit(event, payload);
  }
  /** Emit to the sockets of this identity that joined `room` (except one socket id). */
  emitToRoom(room, event, payload, exceptSocketId = null) {
    for (const s of this.sockets) {
      if (s.id !== exceptSocketId && s.rooms && s.rooms.has(room)) s.emit(event, payload);
    }
  }
  inRoom(room) {
    for (const s of this.sockets) if (s.rooms && s.rooms.has(room)) return true;
    return false;
  }
  get size() {
    return this.sockets.size;
  }
}

/** Register an authenticated socket under its identity; returns the link. */
function attachClientSocket(machineId, socket) {
  let link = connectedClients.get(machineId);
  if (!link) {
    link = new ClientLink(machineId);
    connectedClients.set(machineId, link);
  }
  link.sockets.add(socket);
  return link;
}

/** Forget a socket; the identity leaves the map with its last socket. Returns the sockets left. */
function detachClientSocket(machineId, socket) {
  const link = connectedClients.get(machineId);
  if (!link) return 0;
  link.sockets.delete(socket);
  if (link.sockets.size === 0) connectedClients.delete(machineId);
  return link.sockets.size;
}
// Display names: machineId -> the label the client chose for itself at
// 'authenticate' / 'set-display-name' (a browser identity's chosen name;
// the desktop's OS username). Labels only - identity is the machineId.
const displayNames = new Map();

// Cursor tracking: documentId -> { machineId -> { position, name, timestamp } }
const documentCursors = new Map();

// Upper bound on queued messages per type. Uploads are queued (full body)
// until every active machine has received them or they expire; without a
// cap one client could grow server memory without limit. Oldest entries are
// dropped first (they are also the ones closest to expiry).
const MAX_QUEUE_PER_TYPE = Number(process.env.MAX_QUEUE_PER_TYPE) || 500;

/** Push onto a queue array, trimming the oldest entries beyond the cap. */
function pushBounded(queue, message) {
  queue.push(message);
  if (queue.length > MAX_QUEUE_PER_TYPE) {
    const dropped = queue.splice(0, queue.length - MAX_QUEUE_PER_TYPE);
    console.log(`[Queue] Cap ${MAX_QUEUE_PER_TYPE} reached - dropped ${dropped.length} oldest message(s)`);
  }
  return queue.length;
}

// A Set of machine ids that also remembers when each was last active, so
// machines that stopped polling/connecting can be pruned (see
// pruneStaleMachines). Every existing `.add()` call site records activity
// without change. This matters beyond memory: message delivery is
// considered complete only once every active machine has received it, so
// a never-pruned ghost machine kept every message queued until expiry.
class ActiveMachines extends Set {
  constructor() {
    super();
    this.lastSeen = new Map();
  }
  add(machineId) {
    super.add(machineId);
    this.lastSeen.set(machineId, Date.now());
    return this;
  }
  delete(machineId) {
    this.lastSeen.delete(machineId);
    return super.delete(machineId);
  }
  clear() {
    this.lastSeen.clear();
    super.clear();
  }
}

// In-memory message queue (documents, workflows, and kanban boards)
// With WebSockets, we can push immediately, but keep queue for reconnection scenarios
const messageQueue = {
  documents: [], // Array of { id, sender, document, timestamp, deliveredTo: Set() }
  workflows: [], // Array of { id, sender, workflow, timestamp, deliveredTo: Set() }
  kanbanBoards: [], // Array of { id, sender, board, cards, timestamp, deliveredTo: Set() }
  taskwarriorInstances: [], // Array of { id, sender, instance, timestamp, deliveredTo: Set() }
  activeMachines: new ActiveMachines() // Track active machines for cleanup
};

/**
 * Drop machines that are neither connected over WebSocket nor seen over
 * HTTP for longer than maxAgeMs. Returns the pruned ids.
 */
function pruneStaleMachines(maxAgeMs, now = Date.now()) {
  const pruned = [];
  for (const machineId of [...messageQueue.activeMachines]) {
    if (connectedClients.has(machineId)) continue;
    const seen = messageQueue.activeMachines.lastSeen.get(machineId) || 0;
    if (now - seen > maxAgeMs) {
      messageQueue.activeMachines.delete(machineId);
      pruned.push(machineId);
    }
  }
  return pruned;
}

// Message ID counter.
// NOTE: this is a primitive `let`, so it cannot be exported directly -
// a destructured require() would only capture the value at require-time.
// All modules must obtain new IDs through nextMessageId() instead.
let messageIdCounter = 0;

function nextMessageId() {
  return ++messageIdCounter;
}

// Registry of all active games (Quiz and Grid)
// gameId -> { mode: 'quiz'|'grid', status: 'lobby'|'playing'|'ended', hostId, players: [], createdAt, startedAt }
const gameRegistry = new Map();

// Active Grid games: gameId -> gameState
const gridGames = new Map();

// Active Quiz games: gameId -> quizGameState
const quizGames = new Map();

// Active Tiles games: lobbyId -> gameState
const tilesGames = new Map();

// Socket.IO instance (set when server starts).
// NOTE: same live-binding issue as messageIdCounter - server.js assigns it
// once at startup via setIoInstance(io); readers must call getIoInstance().
let ioInstance = null;

function setIoInstance(io) {
  ioInstance = io;
}

function getIoInstance() {
  return ioInstance;
}

module.exports = {
  PORT,
  HOST,
  CORS_ORIGIN,
  USE_HTTPS,
  TRUST_PROXY,
  ENROLLMENT_SECRET,
  CERT_PATH,
  SSL_KEY,
  SSL_CERT,
  DEBUG_LOGGING,
  debugLog,
  connectedClients,
  ClientLink,
  attachClientSocket,
  detachClientSocket,
  displayNames,
  documentCursors,
  messageQueue,
  MAX_QUEUE_PER_TYPE,
  pushBounded,
  pruneStaleMachines,
  nextMessageId,
  gameRegistry,
  gridGames,
  quizGames,
  tilesGames,
  setIoInstance,
  getIoInstance
};
