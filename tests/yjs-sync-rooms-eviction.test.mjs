/**
 * Guards three regressions in jacarium-central/yjs-sync.js:
 *
 *   1. PER-KEYSTROKE DEBUG COST. The 'yjs-update' handler used to build a
 *      throwaway Y.Doc, apply the incoming update to it and iterate every
 *      card - three times per update, on every keystroke of every
 *      collaborator - purely to produce console output. That work must now
 *      be skipped entirely (not merely silenced) unless DEBUG_LOGGING=1,
 *      and must still be available when DEBUG_LOGGING=1.
 *
 *   2. SERVER-WIDE BROADCASTS. 'yjs-update' / 'yjs-awareness-update' used
 *      socket.broadcast.emit(), so every connected client received every
 *      edit to every document anyone had ever opened. Broadcasts must now be
 *      scoped to the documentId room (joined implicitly from the documentId
 *      the client already sends - there is no client-side "I opened this
 *      document" event).
 *
 *   3. UNBOUNDED yjsDocs MAP. One Y.Doc per documentId ever seen was kept
 *      for the life of the process. An idle document (nobody in its room)
 *      must now be evicted after a grace period, and must NOT be evicted if
 *      a viewer remains or reconnects within the grace period.
 *
 * Self-contained, no test framework:
 *   - Part A spins up a REAL jacarium-central (random free port, temp
 *     DATA_DIR), registers three clients over the real TOFU auth flow, and
 *     drives three real socket.io-client connections.
 *   - Part B loads yjs-sync.js in-process against a minimal Socket.IO server
 *     so the internal yjsDocs Map and Y.Doc construction count can be
 *     observed directly (with a 400ms eviction grace via
 *     YJS_DOC_EVICTION_GRACE_MS instead of the 5min production default).
 *
 * Run:  node tests/yjs-sync-rooms-eviction.test.mjs
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

const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const repoRequire = createRequire(path.join(REPO, 'package.json'));
const { Server: IOServer } = serverRequire('socket.io');
const Y = serverRequire('yjs');
const { io: ioClient } = repoRequire('socket.io-client');

const YJS_SYNC_PATH = serverRequire.resolve('./yjs-sync.js');
const STATE_PATH = serverRequire.resolve('./state.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yjs-sync-test-'));
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

/** base64 Yjs update containing a 'cards' Y.Map with the given cards. */
function buildCardsUpdate(cards) {
  const doc = new Y.Doc();
  const map = doc.getMap('cards');
  doc.transact(() => {
    for (const c of cards) {
      map.set(c.id, new Y.Map());
      const m = map.get(c.id);
      m.set('title', c.title);
      m.set('status', c.status);
      m.set('priority', c.priority);
    }
  });
  const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
  doc.destroy();
  return update;
}

function emptyStateVectorB64() {
  const doc = new Y.Doc();
  const sv = Buffer.from(Y.encodeStateVector(doc)).toString('base64');
  doc.destroy();
  return sv;
}

// ===========================================================================
// Part A - real jacarium-central, real auth, real socket.io-client
// ===========================================================================

async function startRealServer(label, extraEnv) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dataDir = path.join(WORKDIR, `server-data-${label}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(WORKDIR, `server-${label}.log`);
  const logStream = fs.createWriteStream(logPath);
  const proc = spawn('node', ['server.js'], {
    cwd: SERVER_DIR,
    // FORCE_COLOR: '0' - the parent may run with FORCE_COLOR set (CI shells,
    // agent harnesses), which makes Node colorize util.inspect output even
    // though stdout is piped to a log file; the ANSI escapes then break the
    // plain-string log assertions below (e.g. "title: 'Alpha'" becomes
    // "title: \x1b[32m'Alpha'\x1b[39m"). Log files should be plain text.
    env: { ...process.env, FORCE_COLOR: '0', PORT: String(port), DATA_DIR: dataDir, DEBUG_LOGGING: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logStream.write(d));
  proc.stderr.on('data', (d) => logStream.write(d));

  // Wait for the HTTP server to accept connections
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(200);
    up = await new Promise((resolve) => {
      const r = http.get(`${url}/api/health`, (res) => { res.resume(); resolve(true); });
      r.on('error', () => resolve(false));
      r.setTimeout(1000, () => { r.destroy(); resolve(false); });
    });
  }
  return { url, proc, logPath, readLog: () => fs.readFileSync(logPath, 'utf8'), up };
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
  const received = { updates: [], awareness: [] };
  socket.on('yjs-update', (d) => received.updates.push(d));
  socket.on('yjs-awareness-update', (d) => received.awareness.push(d));
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

async function partA_roomScopingAndLogging() {
  console.log('\n--- Part A: real server, room scoping + log gating ---');

  // ---- A1: DEBUG_LOGGING unset ----
  const srv = await startRealServer('nodebug', {});
  check('real server started (DEBUG_LOGGING unset)', srv.up);
  if (!srv.up) return { srv };

  const a = await connectAuthed(srv.url, 'alice@yjs-test');
  const b = await connectAuthed(srv.url, 'bob@yjs-test');
  const c = await connectAuthed(srv.url, 'carol@yjs-test');

  const sv = emptyStateVectorB64();
  // A and B are viewing doc-1; C is viewing doc-2 (room membership is
  // inferred by the server from these messages - no explicit join event)
  a.socket.emit('yjs-sync-step1', { documentId: 'doc-1', stateVector: sv });
  b.socket.emit('yjs-sync-step1', { documentId: 'doc-1', stateVector: sv });
  c.socket.emit('yjs-sync-step1', { documentId: 'doc-2', stateVector: sv });
  await sleep(600);

  const update = buildCardsUpdate([{ id: 'card-1', title: 'Alpha', status: 'todo', priority: 'high' }]);
  a.socket.emit('yjs-update', { documentId: 'doc-1', update });
  a.socket.emit('yjs-awareness-update', { documentId: 'doc-1', update: 'awareness-payload' });
  await sleep(800);

  check('B (same document) receives A\'s yjs-update',
    b.received.updates.some((u) => u.documentId === 'doc-1' && u.update === update),
    JSON.stringify(b.received.updates.map((u) => u.documentId)));
  check('C (different document) does NOT receive A\'s yjs-update',
    c.received.updates.length === 0,
    JSON.stringify(c.received.updates.map((u) => u.documentId)));
  check('B receives A\'s yjs-awareness-update',
    b.received.awareness.some((u) => u.documentId === 'doc-1'),
    JSON.stringify(b.received.awareness.map((u) => u.documentId)));
  check('C does NOT receive A\'s yjs-awareness-update',
    c.received.awareness.length === 0,
    JSON.stringify(c.received.awareness.map((u) => u.documentId)));
  check('A does not receive its own update echoed back',
    a.received.updates.length === 0,
    JSON.stringify(a.received.updates.map((u) => u.documentId)));

  const quietLog = srv.readLog();
  check('no per-update card chatter in log when DEBUG_LOGGING is unset',
    !quietLog.includes('[Yjs] Update contains') &&
    !quietLog.includes('[Yjs] Server state BEFORE applying update') &&
    !quietLog.includes('[Yjs] Received update from'),
    'server-nodebug.log');
  check('lifecycle logging still present when DEBUG_LOGGING is unset',
    quietLog.includes('[Yjs] Created new Y.Doc for document: doc-1') &&
    quietLog.includes('[Yjs] Setting up sync for machine: alice@yjs-test'),
    'server-nodebug.log');

  a.socket.disconnect(); b.socket.disconnect(); c.socket.disconnect();
  srv.proc.kill();
  await sleep(300);

  // ---- A2: DEBUG_LOGGING=1 - same visibility must still be obtainable ----
  const dbg = await startRealServer('debug', { DEBUG_LOGGING: '1' });
  check('real server started (DEBUG_LOGGING=1)', dbg.up);
  if (dbg.up) {
    const d = await connectAuthed(dbg.url, 'dave@yjs-test');
    d.socket.emit('yjs-sync-step1', { documentId: 'doc-9', stateVector: sv });
    await sleep(300);
    d.socket.emit('yjs-update', { documentId: 'doc-9', update });
    await sleep(800);
    const log = dbg.readLog();
    check('DEBUG_LOGGING=1 still logs incoming update line',
      log.includes('[Yjs] Received update from dave@yjs-test for doc doc-9'), 'server-debug.log');
    check('DEBUG_LOGGING=1 still logs throwaway-doc update inspection',
      log.includes('[Yjs] Update contains 1 cards') && log.includes("title: 'Alpha'"), 'server-debug.log');
    check('DEBUG_LOGGING=1 still logs before/after server state',
      log.includes('[Yjs] Server state BEFORE applying update') &&
      log.includes('[Yjs] Server state AFTER applying update: 1 cards'), 'server-debug.log');
    check('DEBUG_LOGGING=1 still logs scoped broadcast',
      log.includes('[Yjs] Broadcasted update to other clients in document doc-9'), 'server-debug.log');
    d.socket.disconnect();
  }
  dbg.proc.kill();
  await sleep(300);
}

// ===========================================================================
// Part B - in-process yjs-sync.js: debug cost + yjsDocs eviction lifecycle
// ===========================================================================

const GRACE_MS = 400;

function loadYjsSync({ debug }) {
  process.env.DEBUG_LOGGING = debug ? '1' : '';
  process.env.YJS_DOC_EVICTION_GRACE_MS = String(GRACE_MS);
  delete serverRequire.cache[YJS_SYNC_PATH];
  delete serverRequire.cache[STATE_PATH];
  return serverRequire('./yjs-sync.js');
}

async function makeHarness(yjsSync) {
  const httpServer = http.createServer();
  const io = new IOServer(httpServer, { cors: { origin: '*' } });
  io.on('connection', (socket) => yjsSync.setupYjsSync(io, socket, `machine-${socket.id}`));
  const port = await freePort();
  await new Promise((r) => httpServer.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${port}`;
  const clients = [];
  return {
    url,
    io,
    async client() {
      const s = ioClient(url, { transports: ['websocket'], reconnection: false });
      await new Promise((res, rej) => {
        s.on('connect', res);
        s.on('connect_error', rej);
      });
      clients.push(s);
      return s;
    },
    async close() {
      clients.forEach((s) => s.disconnect());
      io.close();
      await new Promise((r) => httpServer.close(r));
    },
  };
}

async function partB_debugCost() {
  console.log('\n--- Part B1: throwaway temp-doc work is skipped, not just silenced ---');
  const update = buildCardsUpdate([{ id: 'card-1', title: 'Alpha', status: 'todo', priority: 'high' }]);

  async function countDocsCreatedByUpdate({ debug }) {
    const yjsSync = loadYjsSync({ debug });
    const h = await makeHarness(yjsSync);
    const s = await h.client();
    // First update creates the server-side Y.Doc for this documentId
    s.emit('yjs-update', { documentId: 'cost-doc', update });
    await sleep(400);
    // Now count Y.Doc constructions caused by a SECOND update on the same doc.
    const RealDoc = Y.Doc;
    let constructed = 0;
    class CountingDoc extends RealDoc {
      constructor(...args) { super(...args); constructed++; }
    }
    Y.Doc = CountingDoc;
    try {
      s.emit('yjs-update', { documentId: 'cost-doc', update });
      await sleep(400);
    } finally {
      Y.Doc = RealDoc;
    }
    const hadDoc = yjsSync.yjsDocs.has('cost-doc');
    await h.close();
    await sleep(100);
    return { constructed, hadDoc };
  }

  const off = await countDocsCreatedByUpdate({ debug: false });
  check('DEBUG_LOGGING off: yjs-update constructs ZERO throwaway Y.Docs',
    off.constructed === 0, `constructed=${off.constructed}`);
  check('DEBUG_LOGGING off: the real update was still applied to the live doc',
    off.hadDoc, `yjsDocs.has('cost-doc')=${off.hadDoc}`);

  const on = await countDocsCreatedByUpdate({ debug: true });
  check('DEBUG_LOGGING=1: the inspection Y.Doc is constructed (debug path intact)',
    on.constructed === 1, `constructed=${on.constructed}`);
}

async function partB_eviction() {
  console.log(`\n--- Part B2: yjsDocs eviction (grace ${GRACE_MS}ms) ---`);
  const yjsSync = loadYjsSync({ debug: false });
  const update = buildCardsUpdate([{ id: 'card-1', title: 'Alpha', status: 'todo', priority: 'high' }]);
  const h = await makeHarness(yjsSync);

  // --- idle document is evicted after the grace period, not before ---
  const s1 = await h.client();
  s1.emit('yjs-update', { documentId: 'evict-doc', update });
  await sleep(300);
  check('document is in yjsDocs while a client is viewing it',
    yjsSync.yjsDocs.has('evict-doc'));

  s1.disconnect();
  await sleep(150);
  check('document is NOT evicted immediately on disconnect (grace period)',
    yjsSync.yjsDocs.has('evict-doc'));
  await sleep(GRACE_MS + 400);
  check('document IS evicted once the grace period elapses with an empty room',
    !yjsSync.yjsDocs.has('evict-doc'));

  // --- document with a remaining viewer is never scheduled for eviction ---
  const s2 = await h.client();
  const s3 = await h.client();
  s2.emit('yjs-update', { documentId: 'shared-doc', update });
  s3.emit('yjs-update', { documentId: 'shared-doc', update });
  await sleep(300);
  s2.disconnect();
  await sleep(GRACE_MS + 400);
  check('document with another connected viewer survives a disconnect',
    yjsSync.yjsDocs.has('shared-doc'));
  s3.disconnect();
  await sleep(GRACE_MS + 400);
  check('same document IS evicted once its last viewer leaves',
    !yjsSync.yjsDocs.has('shared-doc'));

  // --- reconnect within the grace period cancels the eviction ---
  const s4 = await h.client();
  s4.emit('yjs-update', { documentId: 'blip-doc', update });
  await sleep(300);
  s4.disconnect();
  await sleep(Math.floor(GRACE_MS / 3));
  const s5 = await h.client();
  s5.emit('yjs-update', { documentId: 'blip-doc', update });
  await sleep(GRACE_MS + 600);
  check('reconnect during the grace period cancels the pending eviction',
    yjsSync.yjsDocs.has('blip-doc'));

  // --- an untouched document is unaffected by other documents' evictions ---
  const s6 = await h.client();
  s6.emit('yjs-update', { documentId: 'stable-doc', update });
  await sleep(300);
  check('unrelated document with a live viewer stays in memory',
    yjsSync.yjsDocs.has('stable-doc'));

  await h.close();
  await sleep(200);
}

// ===========================================================================

let exitCode = 1;
try {
  await partA_roomScopingAndLogging();
  await partB_debugCost();
  await partB_eviction();
  exitCode = results.every((r) => r.pass) ? 0 : 1;
  console.log(`\nSUMMARY: ${results.filter((r) => r.pass).length}/${results.length} passed`);
} catch (e) {
  console.error('TEST DRIVER ERROR:', e);
} finally {
  if (exitCode === 0) {
    try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    console.log(`server logs kept for inspection in: ${WORKDIR}`);
  }
  process.exit(exitCode);
}
