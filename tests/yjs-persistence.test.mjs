/**
 * Guards the encrypted at-rest persistence of Yjs documents added in
 * jacarium-central/yjs-persistence.js + yjs-sync.js. Before that feature,
 * an idle document evicted from memory (or any server restart) silently
 * became an EMPTY Y.Doc - collaborators who never received certain edits
 * locally could never get them back.
 *
 * What this test proves (each is a real end-to-end check, not a mock):
 *   1.  DEBOUNCE: a burst of yjs-updates causes exactly ONE disk write,
 *       after the quiet period - never one write per update.
 *   2.  IMMEDIATE FLUSH ON LAST DISCONNECT: the snapshot hits disk right
 *       when the room empties, long before the debounce window or the
 *       eviction grace period would have elapsed.
 *   3.  ENCRYPTION: the persisted file is genuine AES-256-GCM ciphertext -
 *       the document text is NOT recoverable from the raw bytes (a plaintext
 *       Yjs encoding of the same doc DOES contain the text, as a control),
 *       and the documented file format (version|IV|tag|ciphertext, AAD =
 *       documentId) decrypts correctly with the key.
 *   4.  ROUND TRIP: content survives BOTH a full server restart and an
 *       in-process eviction, restored through the normal yjs sync flow.
 *   5.  CORRUPTION: a truncated/garbage snapshot logs a clear error and
 *       falls back to an empty doc; the server does not crash.
 *   6.  MISSING/MALFORMED KEY: no key -> memory-only mode with a clear
 *       warning and NO files ever written (never plaintext); malformed key
 *       -> server refuses to start (exit 1).
 *   7.  CLEANUP ON REMOVAL: remove-document deletes the persisted snapshot.
 *   8.  AWARENESS: after eviction + reload-from-disk, presence starts fresh
 *       (no stale awareness replayed to a reconnecting client) and live
 *       relaying still works.
 *   9.  GRACEFUL SHUTDOWN: SIGTERM flushes in-memory docs (still inside the
 *       debounce window) to disk before exit.
 *
 * Self-contained, no test framework, same conventions as
 * tests/yjs-sync-rooms-eviction.test.mjs:
 *   - Part A spawns REAL jacarium-centrals (random free port, temp
 *     DATA_DIR, throwaway per-run encryption key) and drives real
 *     socket.io-client connections through the real TOFU auth flow.
 *   - Part B loads yjs-sync.js in-process against a minimal Socket.IO server
 *     so the yjsDocs Map and the on-disk snapshot can be observed directly,
 *     with millisecond-scale YJS_PERSIST_DEBOUNCE_MS /
 *     YJS_DOC_EVICTION_GRACE_MS overrides.
 *
 * Run:  node tests/yjs-persistence.test.mjs
 * Preconditions: central server deps installed (cd jacarium-central && npm ci)
 *                and repo deps installed (npm install, for socket.io-client).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yjs-persist-test-'));
console.log('work/log dir:', WORKDIR);

// Throwaway key for this run only - never touches real key material.
const TEST_KEY = crypto.randomBytes(32).toString('hex');

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

function snapshotFile(dataDir, documentId) {
  return path.join(dataDir, 'documents', `${documentId}.ydoc`);
}

/** Decrypt a snapshot file exactly per the documented on-disk format. */
function decryptSnapshotFile(filePath, documentId, keyHex) {
  const buf = fs.readFileSync(filePath);
  if (buf[0] !== 1) throw new Error(`unexpected format version ${buf[0]}`);
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const ciphertext = buf.subarray(29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  decipher.setAAD(Buffer.from(documentId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** base64 Yjs full-state update for a text doc, and its plain Uint8Array. */
function buildTextUpdate(text) {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return { b64: Buffer.from(update).toString('base64'), raw: update };
}

function emptyStateVectorB64() {
  const doc = new Y.Doc();
  const sv = Buffer.from(Y.encodeStateVector(doc)).toString('base64');
  doc.destroy();
  return sv;
}

/** Extract the ytext 'content' string carried by a base64 sync-step2 update. */
function textFromUpdateB64(b64) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(Buffer.from(b64, 'base64')));
  const text = doc.getText('content').toString();
  doc.destroy();
  return text;
}

// ===========================================================================
// Part A - real jacarium-central processes
// ===========================================================================

async function startRealServer(label, dataDir, extraEnv) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  fs.mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(WORKDIR, `server-${label}.log`);
  const logStream = fs.createWriteStream(logPath);
  const proc = spawn('node', ['server.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DEBUG_LOGGING: '',
      YJS_STORAGE_ENCRYPTION_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logStream.write(d));
  proc.stderr.on('data', (d) => logStream.write(d));
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(200);
    up = await new Promise((resolve) => {
      const r = http.get(`${url}/api/health`, (res) => { res.resume(); resolve(true); });
      r.on('error', () => resolve(false));
      r.setTimeout(1000, () => { r.destroy(); resolve(false); });
    });
  }
  return { url, proc, logPath, exited, readLog: () => fs.readFileSync(logPath, 'utf8'), up };
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
  const received = { updates: [], awareness: [], step2: [] };
  socket.on('yjs-update', (d) => received.updates.push(d));
  socket.on('yjs-awareness-update', (d) => received.awareness.push(d));
  socket.on('yjs-sync-step2', (d) => received.step2.push(d));
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

function waitForEvent(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

async function partA() {
  console.log('\n--- Part A: real server - flush-on-disconnect, encryption, restart round trip, removal, shutdown, corruption, key handling ---');

  const dataDir = path.join(WORKDIR, 'data-A');
  const DOC_ID = crypto.randomUUID(); // matches the app's cloudDocumentId shape
  const MARKER = `SECRET-CONTENT-${crypto.randomUUID()}`;
  const sv = emptyStateVectorB64();

  // Long debounce/grace: anything that hits disk quickly can ONLY be the
  // immediate room-empty flush, not the debounce timer or eviction path.
  const keyedEnv = {
    YJS_STORAGE_ENCRYPTION_KEY: TEST_KEY,
    YJS_PERSIST_DEBOUNCE_MS: '5000',
    YJS_DOC_EVICTION_GRACE_MS: '10000',
  };

  // ---- A1: immediate flush the moment the room becomes empty ----
  const srv1 = await startRealServer('A1-keyed', dataDir, keyedEnv);
  check('real server started with encryption key', srv1.up);
  if (!srv1.up) { srv1.proc.kill(); return; }
  check('startup log announces persistence enabled',
    srv1.readLog().includes('Encrypted Yjs document persistence enabled'));

  const alice = await connectAuthed(srv1.url, 'alice@persist-test');
  alice.socket.emit('yjs-sync-step1', { documentId: DOC_ID, stateVector: sv });
  await waitForEvent(alice.socket, 'yjs-sync-step2');
  const { b64: updateB64 } = buildTextUpdate(MARKER);
  alice.socket.emit('yjs-update', { documentId: DOC_ID, update: updateB64 });
  await sleep(400);

  const file = snapshotFile(dataDir, DOC_ID);
  check('no snapshot yet while editor is connected (still inside 5s debounce)',
    !fs.existsSync(file));

  const disconnectedAt = Date.now();
  alice.socket.disconnect();
  let appearedAfterMs = -1;
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(file)) { appearedAfterMs = Date.now() - disconnectedAt; break; }
    await sleep(50);
  }
  check('snapshot written immediately when last viewer disconnects (before debounce 5000ms / grace 10000ms)',
    appearedAfterMs >= 0 && appearedAfterMs < 3000,
    `appeared after ${appearedAfterMs}ms`);

  // ---- A2: the file is genuine ciphertext in the documented format ----
  if (fs.existsSync(file)) {
    const rawBytes = fs.readFileSync(file);
    const { raw: plaintextUpdate } = buildTextUpdate(MARKER);
    check('control: a PLAINTEXT Yjs encoding of the same doc DOES contain the text',
      Buffer.from(plaintextUpdate).includes(Buffer.from(MARKER, 'utf8')));
    check('persisted file does NOT contain the document text (genuine ciphertext)',
      !rawBytes.includes(Buffer.from(MARKER, 'utf8')),
      `${rawBytes.length} bytes`);
    check('file layout matches documented format (version=1, len > 29-byte header)',
      rawBytes[0] === 1 && rawBytes.length > 29);
    let decrypted = null;
    try { decrypted = decryptSnapshotFile(file, DOC_ID, TEST_KEY); } catch { /* checked below */ }
    check('file decrypts with the key + documentId AAD and yields the document text',
      decrypted !== null && textFromUpdateB64(Buffer.from(decrypted).toString('base64')) === MARKER);
  }

  srv1.proc.kill('SIGKILL'); // hard kill: restart recovery must NOT rely on the shutdown flush
  await srv1.exited;
  await sleep(200);

  // ---- A3 + A6: restart round trip via normal sync flow, then removal ----
  const srv2 = await startRealServer('A2-restart', dataDir, keyedEnv);
  check('server restarted against same data dir', srv2.up);
  const bob = await connectAuthed(srv2.url, 'bob@persist-test');
  bob.socket.emit('yjs-sync-step1', { documentId: DOC_ID, stateVector: sv });
  const step2 = await waitForEvent(bob.socket, 'yjs-sync-step2');
  check('after full restart, sync-step2 restores the exact content from the encrypted snapshot',
    step2.documentId === DOC_ID && textFromUpdateB64(step2.update) === MARKER,
    `got ${textFromUpdateB64(step2.update).length} chars`);
  check('restart log confirms doc was restored from snapshot, not created empty',
    srv2.readLog().includes(`Restored Y.Doc for document ${DOC_ID} from encrypted snapshot`));

  // Removal flow: teach the server the (ownerId, title) -> docId mapping via
  // a real upload, then remove and expect the snapshot file to be deleted.
  bob.socket.emit('upload-document', {
    machine_id: 'bob@persist-test',
    document: { title: 'Persist Test Doc', ownerId: 'bob@persist-test', cloudDocumentId: DOC_ID, content: MARKER },
  });
  await waitForEvent(bob.socket, 'upload-success');
  check('snapshot file still present before removal', fs.existsSync(file));
  bob.socket.emit('remove-document', {
    machine_id: 'bob@persist-test',
    ownerId: 'bob@persist-test',
    title: 'Persist Test Doc',
  });
  await waitForEvent(bob.socket, 'removal-success');
  await sleep(300);
  check('remove-document deletes the persisted snapshot from disk', !fs.existsSync(file));
  check('removal log confirms the purge',
    srv2.readLog().includes(`Purging Yjs state for removed document "Persist Test Doc" (yjs id: ${DOC_ID})`));
  bob.socket.disconnect();
  srv2.proc.kill();
  await srv2.exited;
  await sleep(200);

  // ---- A7(9): graceful shutdown flushes docs still inside the debounce ----
  const DOC_ID2 = crypto.randomUUID();
  const MARKER2 = `SHUTDOWN-CONTENT-${crypto.randomUUID()}`;
  const srv3 = await startRealServer('A3-shutdown', dataDir, keyedEnv);
  const carol = await connectAuthed(srv3.url, 'carol@persist-test');
  carol.socket.emit('yjs-sync-step1', { documentId: DOC_ID2, stateVector: sv });
  await waitForEvent(carol.socket, 'yjs-sync-step2');
  carol.socket.emit('yjs-update', { documentId: DOC_ID2, update: buildTextUpdate(MARKER2).b64 });
  await sleep(400);
  const file2 = snapshotFile(dataDir, DOC_ID2);
  check('no snapshot before SIGTERM (editor connected, inside 5s debounce)', !fs.existsSync(file2));
  srv3.proc.kill('SIGTERM');
  const code3 = await srv3.exited;
  await sleep(200);
  check('SIGTERM exits cleanly (code 0)', code3 === 0, `code=${code3}`);
  check('shutdown log reports the flush', srv3.readLog().includes('Flushed 1 Yjs document snapshot(s) to disk'));
  let shutdownContent = null;
  try {
    shutdownContent = textFromUpdateB64(Buffer.from(decryptSnapshotFile(file2, DOC_ID2, TEST_KEY)).toString('base64'));
  } catch { /* checked below */ }
  check('graceful shutdown persisted the un-debounced document content',
    shutdownContent === MARKER2);
  try { carol.socket.disconnect(); } catch { /* server already gone */ }

  // ---- A4(5): corrupted snapshot -> clear error + empty doc, no crash ----
  fs.writeFileSync(file2, Buffer.concat([fs.readFileSync(file2).subarray(0, 20), Buffer.from('garbage!')]));
  const srv4 = await startRealServer('A4-corrupt', dataDir, keyedEnv);
  const dave = await connectAuthed(srv4.url, 'dave@persist-test');
  dave.socket.emit('yjs-sync-step1', { documentId: DOC_ID2, stateVector: sv });
  const step2corrupt = await waitForEvent(dave.socket, 'yjs-sync-step2');
  check('corrupted snapshot falls back to an EMPTY doc (no crash)',
    textFromUpdateB64(step2corrupt.update) === '');
  check('corruption is loudly logged',
    srv4.readLog().includes(`snapshot for document ${DOC_ID2} is corrupted or undecryptable`));
  const health = await new Promise((resolve) => {
    const r = http.get(`${srv4.url}/api/health`, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', () => resolve(0));
  });
  check('server still healthy after hitting the corrupted snapshot', health === 200);
  dave.socket.disconnect();
  srv4.proc.kill();
  await srv4.exited;
  await sleep(200);

  // ---- A5(6a): missing key -> memory-only mode, warning, NO files ----
  const noKeyDir = path.join(WORKDIR, 'data-nokey');
  const srv5 = await startRealServer('A5-nokey', noKeyDir, {
    YJS_PERSIST_DEBOUNCE_MS: '200',
    YJS_DOC_EVICTION_GRACE_MS: '400',
  });
  check('server starts WITHOUT the key (option b: feature-off, not server-down)', srv5.up);
  check('missing key logs a clear one-time warning',
    srv5.readLog().includes('YJS_STORAGE_ENCRYPTION_KEY is not set') &&
    srv5.readLog().includes('persistence is DISABLED'));
  const erin = await connectAuthed(srv5.url, 'erin@persist-test');
  const frank = await connectAuthed(srv5.url, 'frank@persist-test');
  erin.socket.emit('yjs-sync-step1', { documentId: DOC_ID, stateVector: sv });
  frank.socket.emit('yjs-sync-step1', { documentId: DOC_ID, stateVector: sv });
  await sleep(400);
  const noKeyUpdate = buildTextUpdate('memory-only-content').b64;
  erin.socket.emit('yjs-update', { documentId: DOC_ID, update: noKeyUpdate });
  await sleep(400);
  check('real-time relay still works in memory-only mode',
    frank.received.updates.some((u) => u.documentId === DOC_ID && u.update === noKeyUpdate));
  erin.socket.disconnect();
  frank.socket.disconnect();
  await sleep(1200); // past debounce(200) + grace(400) + margin: every trigger had its chance
  const docsDir = path.join(noKeyDir, 'documents');
  const leftoverFiles = fs.existsSync(docsDir) ? fs.readdirSync(docsDir) : [];
  check('NO snapshot files are ever written without a key (no plaintext fallback)',
    leftoverFiles.length === 0, JSON.stringify(leftoverFiles));
  srv5.proc.kill();
  await srv5.exited;

  // ---- A5b(6b): malformed key -> refuse to start ----
  const srv6 = await startRealServer('A6-badkey', path.join(WORKDIR, 'data-badkey'), {
    YJS_STORAGE_ENCRYPTION_KEY: 'not-a-valid-key',
  });
  const code6 = await Promise.race([srv6.exited, sleep(5000).then(() => 'timeout')]);
  check('malformed key refuses to start (exit code 1)', code6 === 1, `exit=${code6}`);
  check('malformed key logs a clear fatal error',
    srv6.readLog().includes('FATAL: YJS_STORAGE_ENCRYPTION_KEY is set but invalid'));
  if (code6 === 'timeout') srv6.proc.kill('SIGKILL');
}

// ===========================================================================
// Part B - in-process yjs-sync.js: debounce write-count, pre-eviction flush,
//          eviction round trip, awareness freshness
// ===========================================================================

const B_DEBOUNCE_MS = 500;
const B_GRACE_MS = 700;
const B_DATA_DIR = path.join(WORKDIR, 'data-B');

function loadYjsSyncInProcess() {
  process.env.DEBUG_LOGGING = '';
  process.env.DATA_DIR = B_DATA_DIR;
  process.env.YJS_STORAGE_ENCRYPTION_KEY = TEST_KEY;
  process.env.YJS_PERSIST_DEBOUNCE_MS = String(B_DEBOUNCE_MS);
  process.env.YJS_DOC_EVICTION_GRACE_MS = String(B_GRACE_MS);
  // All of these read env at require time - bust every cached copy.
  for (const mod of ['./yjs-sync.js', './yjs-persistence.js', './client-registry.js', './state.js']) {
    delete serverRequire.cache[serverRequire.resolve(mod)];
  }
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
    io,
    async client() {
      const s = ioClient(url, { transports: ['websocket'], reconnection: false });
      const received = { updates: [], awareness: [], step2: [] };
      s.on('yjs-update', (d) => received.updates.push(d));
      s.on('yjs-awareness-update', (d) => received.awareness.push(d));
      s.on('yjs-sync-step2', (d) => received.step2.push(d));
      await new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
      clients.push(s);
      return { socket: s, received };
    },
    async close() {
      clients.forEach((c) => c.disconnect());
      io.close();
      await new Promise((r) => httpServer.close(r));
    },
  };
}

/** Poll a file and count distinct completed writes (mtime transitions). */
function startWriteCounter(filePath, intervalMs = 25) {
  const seen = [];
  const timer = setInterval(() => {
    try {
      const { mtimeMs } = fs.statSync(filePath);
      if (seen[seen.length - 1] !== mtimeMs) seen.push(mtimeMs);
    } catch { /* not written yet */ }
  }, intervalMs);
  return { count: () => seen.length, stop: () => clearInterval(timer) };
}

async function partB() {
  console.log(`\n--- Part B: in-process (debounce ${B_DEBOUNCE_MS}ms, grace ${B_GRACE_MS}ms) ---`);
  const yjsSync = loadYjsSyncInProcess();
  check('in-process module reflects the env timing overrides',
    yjsSync.PERSIST_DEBOUNCE_MS === B_DEBOUNCE_MS && yjsSync.DOC_EVICTION_GRACE_MS === B_GRACE_MS);
  const h = await makeHarness(yjsSync);
  const sv = emptyStateVectorB64();

  // ---- B1: debounce - a burst of updates causes exactly one write ----
  {
    const DOC = 'debounce-doc';
    const file = snapshotFile(B_DATA_DIR, DOC);
    const counter = startWriteCounter(file);
    const a = await h.client();
    a.socket.emit('yjs-sync-step1', { documentId: DOC, stateVector: sv });
    await sleep(200);

    // One local doc for the whole burst (a single Yjs client editing), so the
    // server's merged state equals this doc's final text exactly.
    const burstDoc = new Y.Doc();
    const burstText = burstDoc.getText('content');
    for (let i = 0; i < 8; i++) {
      burstText.insert(burstText.length, `edit-${i};`);
      a.socket.emit('yjs-update', {
        documentId: DOC,
        update: Buffer.from(Y.encodeStateAsUpdate(burstDoc)).toString('base64'),
      });
      await sleep(100); // 100ms apart: every update lands inside the 500ms debounce window
    }
    const text = burstText.toString();
    burstDoc.destroy();
    check('B1: zero disk writes during the 8-update burst (debounce holding)',
      counter.count() === 0 && !fs.existsSync(file), `writes=${counter.count()}`);
    await sleep(B_DEBOUNCE_MS + 500); // let the debounce fire once
    const writesAfterQuiet = counter.count();
    check('B1: exactly ONE disk write after the quiet period, not one per update',
      writesAfterQuiet === 1, `writes=${writesAfterQuiet} for 8 updates`);
    const persisted = textFromUpdateB64(Buffer.from(decryptSnapshotFile(file, DOC, TEST_KEY)).toString('base64'));
    check('B1: the single write captured the FINAL state of the burst', persisted === text);
    counter.stop();
    // Keep `a` connected: its room must stay occupied so no flush-on-empty
    // or eviction interferes with the pure-debounce measurement above.
  }

  // ---- B2: pre-eviction flush (trigger #3) works even if trigger #2's file
  //          vanishes, then the evicted doc round-trips from disk ----
  {
    const DOC = 'evict-flush-doc';
    const file = snapshotFile(B_DATA_DIR, DOC);
    const text = 'survives-eviction';
    const b = await h.client();
    b.socket.emit('yjs-sync-step1', { documentId: DOC, stateVector: sv });
    await sleep(200);
    b.socket.emit('yjs-update', { documentId: DOC, update: buildTextUpdate(text).b64 });
    await sleep(200);
    b.socket.disconnect();
    await sleep(300);
    check('B2: room-empty flush wrote the snapshot before eviction was due', fs.existsSync(file));
    fs.unlinkSync(file); // sabotage trigger #2's output; trigger #3 must recover it
    await sleep(B_GRACE_MS + 500);
    check('B2: doc was evicted from memory after the grace period', !yjsSync.yjsDocs.has(DOC));
    check('B2: pre-eviction flush re-wrote the snapshot (guaranteed final safety net)',
      fs.existsSync(file));

    // Reconnect: normal sync flow must restore the content from disk.
    const c = await h.client();
    c.socket.emit('yjs-sync-step1', { documentId: DOC, stateVector: sv });
    await sleep(400);
    check('B2: evicted-then-reloaded doc round-trips via normal yjs sync',
      c.received.step2.some((d) => d.documentId === DOC && textFromUpdateB64(d.update) === text),
      JSON.stringify(c.received.step2.map((d) => textFromUpdateB64(d.update))));
    c.socket.disconnect();
  }

  // ---- B3: awareness/presence starts fresh after eviction + reload ----
  {
    const DOC = 'aware-doc';
    const text = 'aware-content';
    const a = await h.client();
    const b = await h.client();
    a.socket.emit('yjs-sync-step1', { documentId: DOC, stateVector: sv });
    b.socket.emit('yjs-sync-step1', { documentId: DOC, stateVector: sv });
    await sleep(200);
    a.socket.emit('yjs-update', { documentId: DOC, update: buildTextUpdate(text).b64 });
    a.socket.emit('yjs-awareness-update', { documentId: DOC, update: 'cursor-of-A-before-eviction' });
    await sleep(300);
    check('B3: baseline - awareness relays to the other viewer while both connected',
      b.received.awareness.some((d) => d.documentId === DOC && d.update === 'cursor-of-A-before-eviction'));

    a.socket.disconnect();
    b.socket.disconnect();
    await sleep(B_GRACE_MS + 500);
    check('B3: doc evicted (its next open will reload from disk)', !yjsSync.yjsDocs.has(DOC));

    // C reconnects to the reloaded-from-disk doc: content must be back, but
    // NO stale awareness may be replayed (server relays presence only, never
    // stores it - the snapshot contains document state exclusively).
    const c = await h.client();
    c.socket.emit('yjs-sync-step1', { documentId: DOC, stateVector: sv });
    await sleep(600);
    check('B3: reloaded doc delivered its content to the reconnecting client',
      c.received.step2.some((d) => d.documentId === DOC && textFromUpdateB64(d.update) === text));
    check('B3: ZERO awareness events replayed after eviction+reload (no stale cursors)',
      c.received.awareness.length === 0, JSON.stringify(c.received.awareness));

    // Fresh presence repopulates normally as people (re)connect.
    const d = await h.client();
    d.socket.emit('yjs-sync-step1', { documentId: DOC, stateVector: sv });
    await sleep(200);
    d.socket.emit('yjs-awareness-update', { documentId: DOC, update: 'cursor-of-D-after-reload' });
    await sleep(300);
    check('B3: fresh awareness relays normally after the reload',
      c.received.awareness.length === 1 && c.received.awareness[0].update === 'cursor-of-D-after-reload',
      JSON.stringify(c.received.awareness.map((x) => x.update)));
  }

  await h.close();
  await sleep(200);
}

// ===========================================================================

let exitCode = 1;
try {
  await partA();
  await partB();
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
