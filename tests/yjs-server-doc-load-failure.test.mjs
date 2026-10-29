/**
 * Guards the "server could not load this document's persisted state" signal
 * added in jacarium-central/yjs-sync.js (+ yjs-persistence.js status API)
 * and its client-side handling (src/utils/yjsProvider.js, src/hooks/
 * useYjsText.js, DocumentEditor's read-only banner).
 *
 * THE PROBLEM: when a document's encrypted snapshot can't be decrypted or
 * applied (rotated key, corrupted file), getYDoc used to silently fall back
 * to an EMPTY Y.Doc - indistinguishable, to clients, from a genuinely new
 * document. The client treats "server empty" as "seed it from my local copy",
 * so a broken server doc got silently re-seeded; with TWO clients holding
 * divergent local copies, the CRDT merges two unrelated histories into
 * garbled/duplicated text (Part A1 proves this risk is real).
 *
 * THE FIX under test:
 *   - sync-step2 carries stateLoadFailed: true for degraded documents;
 *   - the server REJECTS yjs-updates for degraded docs (no reseed race, even
 *     from older clients) and never overwrites the broken snapshot file;
 *   - the degraded state is sticky across eviction and restarts;
 *   - the client shows its local IndexedDB copy READ-ONLY with a banner
 *     instead of an empty doc, and does NOT re-seed the server;
 *   - explicit re-upload ("Sync Changes") is the escape hatch: the server
 *     rebuilds the doc from that one copy, persists it, and emits
 *     yjs-doc-reseeded so open editors resync from scratch and become
 *     editable again;
 *   - genuinely new documents still seed normally (no flag, no banner), and
 *     the pre-existing fully-offline read-only path is unaffected.
 *
 * What this test proves (all real end-to-end checks, no mocks):
 *   Part A - raw socket.io clients against a real spawned server:
 *     A1. RACE REPRO: two clients with DIVERGENT local copies both "reseed"
 *         an empty server doc (the pre-fix client behavior) -> the server's
 *         merged content is garbled (contains BOTH copies), proving the
 *         silent-reseed race is a real data-corruption hazard.
 *     A2. Corrupted snapshot -> step2 carries stateLoadFailed; updates are
 *         rejected (not applied, not broadcast); the corrupt file is never
 *         overwritten or deleted (survives room-empty flush AND eviction);
 *         the degraded state is sticky across eviction reload.
 *     A3. Explicit re-upload reseeds: yjs-doc-reseeded reaches the room, the
 *         doc serves the uploaded content with no flag, the snapshot file is
 *         valid again, and normal updates are accepted afterwards.
 *     A4. A genuinely new document gets NO flag and seeds normally.
 *   Part B - real DocumentsPage/DocumentEditor tree in jsdom (per machine),
 *   real socket.io, real Yjs, real (fake-)IndexedDB:
 *     B1. A client with a local IndexedDB copy of a server-side-broken doc
 *         sees ITS OWN content (not empty), read-only, with the
 *         "Server copy unavailable" banner - and the server is NOT reseeded.
 *     B2. "Sync Changes" recovers: server content restored from the local
 *         copy, banner gone, editor editable again.
 *     B3. Live editing works after recovery (edits reach the server).
 *     B4. A genuinely new uploaded document: editable, no banner, seeds the
 *         server normally.
 *     B5. Fully-offline read-only path unchanged: killing the server makes
 *         cloud docs read-only with the offline banner - and WITHOUT the
 *         server-copy-unavailable banner.
 *
 * Run:  node tests/yjs-server-doc-load-failure.test.mjs
 * Preconditions (checked at startup):
 *   - repo deps installed:               npm install
 *   - central server deps installed:     cd jacarium-central && npm ci
 *   - test-only deps:                    npm install --no-save jsdom fake-indexeddb
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
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SERVER_DIR = path.join(REPO, 'jacarium-central');
const req = createRequire(path.join(REPO, 'package.json'));
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));

// ---------- precondition checks ----------
function requireResolvable(name, hint) {
  try {
    req.resolve(name);
  } catch {
    console.error(`Missing dependency "${name}". ${hint}`);
    process.exit(1);
  }
}
requireResolvable('react', 'Run: npm install');
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('socket.io-client', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom fake-indexeddb');
requireResolvable('fake-indexeddb', 'Run: npm install --no-save jsdom fake-indexeddb');
if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) {
  console.error('jacarium-central dependencies missing. Run: cd jacarium-central && npm ci');
  process.exit(1);
}

const Y = serverRequire('yjs');
const { io: ioClient } = req('socket.io-client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yjs-doc-load-failure-'));
console.log('work/log dir:', WORKDIR);

// Throwaway key for this run only - never touches real key material.
const TEST_KEY = crypto.randomBytes(32).toString('hex');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass });
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

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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

/** base64 Yjs full-state update for a text doc (a fresh, independent history). */
function buildTextUpdate(text) {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return Buffer.from(update).toString('base64');
}

function emptyStateVectorB64() {
  const doc = new Y.Doc();
  const sv = Buffer.from(Y.encodeStateVector(doc)).toString('base64');
  doc.destroy();
  return sv;
}

/** Extract the ytext 'content' string carried by a base64 update. */
function textFromUpdateB64(b64) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(Buffer.from(b64, 'base64')));
  const text = doc.getText('content').toString();
  doc.destroy();
  return text;
}

// ---------- real jacarium-central processes ----------
// the key the spawned central server and the clients' fake home server share (tests/helpers/run-client.mjs mints the account tickets with it)
const ACCOUNT_TICKET_KEY = '0123456789abcdef'.repeat(4);
async function startRealServer(label, dataDir, port, extraEnv = {}) {
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
      YJS_STORAGE_ENCRYPTION_KEY: TEST_KEY,
      YJS_PERSIST_DEBOUNCE_MS: '300',
      YJS_DOC_EVICTION_GRACE_MS: '600',
      // the app clients come in with account tickets (run-client.mjs); the
      // verification sockets below pair with the enrollment secret
      ACCOUNT_TICKET_KEY,
      ENROLLMENT_SECRET: 'synthetic-enrollment',
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
    headers: { 'Content-Type': 'application/json', 'X-Enrollment-Secret': 'synthetic-enrollment' },
    body: JSON.stringify({ machine_id: machineId }),
  });
  const json = await res.json();
  return json.secret;
}

async function connectAuthed(url, machineId) {
  const secret = await registerMachine(url, machineId);
  const socket = ioClient(url, { transports: ['websocket'], reconnection: false, timeout: 5000 });
  const received = { updates: [], step2: [], reseeded: [] };
  socket.on('yjs-update', (d) => received.updates.push(d));
  socket.on('yjs-sync-step2', (d) => received.step2.push(d));
  socket.on('yjs-doc-reseeded', (d) => received.reseeded.push(d));
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

/** step1 -> first step2 for the given doc on this socket. */
async function syncOnce(client, documentId) {
  const p = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`sync timeout for ${documentId}`)), 8000);
    const handler = (d) => {
      if (d.documentId !== documentId) return;
      clearTimeout(t);
      client.socket.off('yjs-sync-step2', handler);
      resolve(d);
    };
    client.socket.on('yjs-sync-step2', handler);
  });
  client.socket.emit('yjs-sync-step1', { documentId, stateVector: emptyStateVectorB64() });
  return p;
}

// ===========================================================================
// Part A - raw socket clients against a real server
// ===========================================================================
async function partA() {
  console.log('\n--- Part A: raw sockets - reseed race repro, degraded signaling, sticky state, explicit reseed recovery ---');

  const dataDir = path.join(WORKDIR, 'data-A');
  const portA = await freePort();

  // ---- A1: the divergent double-reseed race (pre-fix client behavior) ----
  // A genuinely-new doc is exactly what a corrupt-fallback doc looked like to
  // pre-fix clients. Two clients each holding a DIFFERENT local copy both do
  // what the old client did on "server empty": insert their own copy into
  // their own fresh Y.Doc and push the full update.
  let srv = await startRealServer('A1', dataDir, portA);
  check('A: server started with encryption key', srv.up);

  const DOC_RACE = crypto.randomUUID();
  const COPY_1 = 'alpha-machine copy: The quick brown fox jumps over the lazy dog.';
  const COPY_2 = 'beta-machine copy: Lorem ipsum dolor sit amet, consectetur.';
  {
    const c1 = await connectAuthed(srv.url, 'race1@test');
    const c2 = await connectAuthed(srv.url, 'race2@test');
    const s1 = await syncOnce(c1, DOC_RACE);
    const s2 = await syncOnce(c2, DOC_RACE);
    check('A1: a genuinely-new doc carries NO stateLoadFailed flag',
      s1.stateLoadFailed === undefined && s2.stateLoadFailed === undefined);
    // Both "reseed" concurrently, each from its own divergent local copy.
    c1.socket.emit('yjs-update', { documentId: DOC_RACE, update: buildTextUpdate(COPY_1) });
    c2.socket.emit('yjs-update', { documentId: DOC_RACE, update: buildTextUpdate(COPY_2) });
    await sleep(600);
    const c3 = await connectAuthed(srv.url, 'race3@test');
    const merged = textFromUpdateB64((await syncOnce(c3, DOC_RACE)).update);
    check('A1: RACE IS REAL - the CRDT merged both divergent copies into garbled/duplicated content',
      merged !== COPY_1 && merged !== COPY_2 &&
      merged.length === COPY_1.length + COPY_2.length &&
      merged.includes(COPY_1) && merged.includes(COPY_2),
      `merged ${merged.length} chars from ${COPY_1.length}+${COPY_2.length}`);
    c1.socket.disconnect(); c2.socket.disconnect(); c3.socket.disconnect();
  }

  // ---- A2 setup: seed a doc, corrupt its snapshot, restart the server ----
  const DOC1 = crypto.randomUUID();
  const ORIGINAL = `ORIGINAL-SERVER-CONTENT-${crypto.randomUUID()}`;
  {
    const seeder = await connectAuthed(srv.url, 'seeder@test');
    await syncOnce(seeder, DOC1);
    seeder.socket.emit('yjs-update', { documentId: DOC1, update: buildTextUpdate(ORIGINAL) });
    await sleep(300);
    seeder.socket.disconnect(); // room empties -> immediate snapshot flush
  }
  const file1 = snapshotFile(dataDir, DOC1);
  let flushed = false;
  for (let i = 0; i < 60 && !flushed; i++) { await sleep(50); flushed = fs.existsSync(file1); }
  check('A2: snapshot flushed to disk on last disconnect', flushed);

  srv.proc.kill('SIGKILL'); // corrupt-at-rest scenario must not depend on graceful shutdown
  await srv.exited;
  await sleep(200);
  // Corrupt the snapshot: keep the header, garbage the ciphertext (GCM auth
  // will fail on load - same shape as a damaged disk / partial write).
  fs.writeFileSync(file1, Buffer.concat([fs.readFileSync(file1).subarray(0, 20), Buffer.from('garbage!')]));
  const corruptHash = fileHash(file1);

  srv = await startRealServer('A2-corrupt', dataDir, portA);
  check('A2: server restarted against the corrupted snapshot', srv.up);

  // ---- A2: degraded signaling + update rejection + sticky state ----
  const a = await connectAuthed(srv.url, 'alice-raw@test');
  const b = await connectAuthed(srv.url, 'bob-raw@test');
  {
    const s = await syncOnce(a, DOC1);
    check('A2: sync-step2 for the broken doc carries stateLoadFailed: true', s.stateLoadFailed === true);
    check('A2: sync-step2 for the broken doc carries an EMPTY doc (placeholder)', textFromUpdateB64(s.update) === '');
    check('A2: degradation is loudly logged server-side',
      srv.readLog().includes(`Document ${DOC1} is DEGRADED`));

    await syncOnce(b, DOC1); // b joins the room too
    b.received.updates.length = 0;
    a.socket.emit('yjs-update', { documentId: DOC1, update: buildTextUpdate('divergent-copy-from-a') });
    await sleep(500);
    check('A2: update against the degraded doc is rejected (logged)',
      srv.readLog().includes(`Rejected update from alice-raw@test for DEGRADED document ${DOC1}`));
    check('A2: rejected update is NOT broadcast to other viewers',
      b.received.updates.filter((u) => u.documentId === DOC1).length === 0);
    const after = await syncOnce(b, DOC1);
    check('A2: doc stays empty + flagged after the rejected update (no silent reseed)',
      textFromUpdateB64(after.update) === '' && after.stateLoadFailed === true);
  }

  // Room empties -> flush-on-empty fires, then eviction (grace 600ms) with its
  // pre-eviction flush. Neither may touch the broken snapshot file.
  a.socket.disconnect();
  b.socket.disconnect();
  await sleep(1800);
  check('A2: doc was evicted while degraded (eviction path exercised)',
    srv.readLog().includes(`Evicted idle Y.Doc for document: ${DOC1}`));
  check('A2: broken snapshot file NEVER overwritten or deleted (room-empty flush + eviction flush skipped)',
    fs.existsSync(file1) && fileHash(file1) === corruptHash);

  const c = await connectAuthed(srv.url, 'carol-raw@test');
  {
    const s = await syncOnce(c, DOC1);
    check('A2: degraded state is STICKY across eviction + reload from disk',
      s.stateLoadFailed === true && textFromUpdateB64(s.update) === '');
  }

  // ---- A3: explicit re-upload reseeds the degraded doc ----
  const RESEED = `RESEEDED-FROM-LOCAL-COPY-${crypto.randomUUID()}`;
  {
    c.received.reseeded.length = 0;
    c.socket.emit('upload-document', {
      machine_id: 'carol-raw@test',
      document: { title: 'Broken Doc', ownerId: 'carol-raw@test', cloudDocumentId: DOC1, content: RESEED },
    });
    await waitForEvent(c.socket, 'upload-success');
    await sleep(300);
    check('A3: yjs-doc-reseeded is emitted to the document room',
      c.received.reseeded.some((d) => d.documentId === DOC1));
    const s = await syncOnce(c, DOC1);
    check('A3: after reseed, sync serves the uploaded content with NO flag',
      textFromUpdateB64(s.update) === RESEED && s.stateLoadFailed === undefined);
    let onDisk = null;
    try {
      onDisk = textFromUpdateB64(Buffer.from(decryptSnapshotFile(file1, DOC1, TEST_KEY)).toString('base64'));
    } catch { /* checked below */ }
    check('A3: snapshot file is immediately valid again and holds the reseeded content', onDisk === RESEED);

    // Normal updates flow again: extend the SYNCED state (a real incremental
    // edit, not a fresh history) and confirm it lands.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(Buffer.from(s.update, 'base64')));
    doc.getText('content').insert(doc.getText('content').length, '+after-recovery');
    c.socket.emit('yjs-update', { documentId: DOC1, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') });
    doc.destroy();
    await sleep(400);
    const d = await connectAuthed(srv.url, 'dave-raw@test');
    const s2 = await syncOnce(d, DOC1);
    check('A3: updates are accepted again after recovery',
      textFromUpdateB64(s2.update) === RESEED + '+after-recovery' && s2.stateLoadFailed === undefined);
    d.socket.disconnect();
  }

  // ---- A4: an unrelated genuinely-new doc on the same (recovered) server ----
  {
    const DOC_NEW = crypto.randomUUID();
    const s = await syncOnce(c, DOC_NEW);
    check('A4: genuinely-new doc: empty, NO stateLoadFailed flag', textFromUpdateB64(s.update) === '' && s.stateLoadFailed === undefined);
    c.socket.emit('yjs-update', { documentId: DOC_NEW, update: buildTextUpdate('new-doc-seed') });
    await sleep(300);
    const s2 = await syncOnce(c, DOC_NEW);
    check('A4: genuinely-new doc still seeds normally', textFromUpdateB64(s2.update) === 'new-doc-seed');
  }
  c.socket.disconnect();
  srv.proc.kill();
  await srv.exited;
  await sleep(200);
}

// ===========================================================================
// Part B - real app component tree in jsdom
// ===========================================================================

const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle-client.cjs');
async function buildBundle() {
  await build({
    entryPoints: [path.join(here, 'helpers', 'client-app.mjs')],
    bundle: true,
    outfile: BUNDLE,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.woff2': 'dataurl', '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' },
    resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
    nodePaths: [path.join(REPO, 'node_modules')],
    plugins: [{
      name: 'alias',
      setup(bld) {
        bld.onResolve({ filter: /^@worktree\// }, (args) => ({
          path: path.join(REPO, args.path.replace(/^@worktree\//, '')),
        }));
        bld.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => {
          if (isBuiltin(args.path)) return { path: args.path, external: true };
          try { return { path: req.resolve(args.path) }; } catch { return null; }
        });
      },
    }],
    logLevel: 'warning',
  });
}

class Client {
  constructor(name, env) {
    this.name = name;
    this.pending = new Map();
    this.nextId = 1;
    this.log = fs.createWriteStream(path.join(WORKDIR, `${name}.log`));
    this.readyPromise = new Promise((resolve) => { this.onReady = resolve; });
    this.proc = spawn('node', [path.join(here, 'helpers', 'run-client.mjs')], {
      cwd: REPO,
      env: { ...process.env, CLIENT_BUNDLE: BUNDLE, ACCOUNT_TICKET_KEY, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      this.log.write(d);
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (line.startsWith('@@RES ')) {
          const obj = JSON.parse(line.slice(6));
          const p = this.pending.get(obj.id);
          if (p) { this.pending.delete(obj.id); p(obj); }
        } else if (line.startsWith('@@EVT ')) {
          const obj = JSON.parse(line.slice(6));
          if (obj.ready) this.onReady(obj);
          if (obj.fatal) console.error(`[${this.name}] FATAL:`, obj.fatal);
        }
      }
    });
    this.proc.stderr.on('data', (d) => this.log.write(d));
  }
  cmd(cmd, args = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} cmd ${cmd} timeout`));
      }, timeoutMs);
      this.pending.set(id, (obj) => { clearTimeout(t); resolve(obj); });
      this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }
  kill() { try { this.proc.kill(); } catch { /* ignore */ } }
}

async function poll(fn, timeoutMs = 15000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last.ok || Date.now() > deadline) return last;
    await sleep(intervalMs);
  }
}

async function partB() {
  console.log('\n--- Part B: real DocumentsPage/DocumentEditor in jsdom ---');
  await buildBundle();

  const dataDir = path.join(WORKDIR, 'data-B');
  const portB = await freePort();
  const SERVER_URL = `http://127.0.0.1:${portB}`;

  // Seed a cloud document's Yjs state on the server, then corrupt it.
  const DOC_B = crypto.randomUUID();
  const SERVER_CONTENT = 'server-side original content that will be lost to corruption';
  const LOCAL_COPY = 'LOCAL CACHED COPY on alice - this must stay visible and become the reseed source';
  let srv = await startRealServer('B-seed', dataDir, portB);
  check('B: server started', srv.up);
  {
    const seeder = await connectAuthed(srv.url, 'seeder-b@test');
    await syncOnce(seeder, DOC_B);
    seeder.socket.emit('yjs-update', { documentId: DOC_B, update: buildTextUpdate(SERVER_CONTENT) });
    await sleep(300);
    seeder.socket.disconnect();
  }
  const fileB = snapshotFile(dataDir, DOC_B);
  let flushed = false;
  for (let i = 0; i < 60 && !flushed; i++) { await sleep(50); flushed = fs.existsSync(fileB); }
  check('B: seeded snapshot flushed to disk', flushed);
  srv.proc.kill('SIGKILL');
  await srv.exited;
  await sleep(200);
  fs.writeFileSync(fileB, Buffer.concat([fs.readFileSync(fileB).subarray(0, 20), Buffer.from('garbage!')]));
  const corruptHash = fileHash(fileB);
  srv = await startRealServer('B-corrupt', dataDir, portB);
  check('B: server restarted with corrupted snapshot', srv.up);

  const clients = [];
  try {
    // alice: has a LOCAL IndexedDB copy of the cloud doc from an earlier
    // session (simulated via CREATE_DOC_CLOUD_ID - fake-indexeddb is
    // per-process, so prior sessions must be seeded this way).
    const alice = new Client('alice', {
      MACHINE_ID: 'alice@account-test',
      SERVER_URL,
      CREATE_DOC_TITLE: 'Broken Cloud Doc',
      CREATE_DOC_CONTENT: LOCAL_COPY,
      CREATE_DOC_CLOUD_ID: DOC_B,
      CREATE_DOC_OWNER_ID: 'alice@account-test',
    });
    clients.push(alice);
    await alice.readyPromise;
    await sleep(1500);
    check('B1: alice websocket connected', (await alice.cmd('status')).connected);

    const open = await alice.cmd('click-doc', { title: 'Broken Cloud Doc' });
    check('B1: alice opened her local copy of the broken doc', open.ok, open.error);

    // The banner + read-only state appear once the degraded sync-step2 lands.
    const bannerUp = await poll(async () => {
      const r = await alice.cmd('page-contains', { text: 'Server copy unavailable' });
      return { ok: !!r.contains, r };
    });
    check('B1: "Server copy unavailable" banner is shown', bannerUp.ok);
    const ta1 = await alice.cmd('textarea');
    check('B1: alice sees her OWN local content, not an empty document',
      ta1.value === LOCAL_COPY, `got ${ta1.value ? ta1.value.length : null} chars`);
    check('B1: the editor is READ-ONLY', ta1.readOnly === true);

    // A typing attempt must not reach the server (updateContent is blocked).
    await alice.cmd('type', { text: 'X' });
    await sleep(800);
    const verify1 = await connectAuthed(SERVER_URL, 'verify1@test');
    const s1 = await syncOnce(verify1, DOC_B);
    check('B1: server doc is still the empty degraded placeholder (NOT silently reseeded)',
      textFromUpdateB64(s1.update) === '' && s1.stateLoadFailed === true);
    verify1.socket.disconnect();
    check('B1: broken snapshot file untouched on disk', fileHash(fileB) === corruptHash);

    // ---- B2: recovery via the existing "Sync Changes" action ----
    const ctx = await alice.cmd('ctx-doc', { title: 'Broken Cloud Doc' });
    check('B2: context menu offers Sync Changes',
      (ctx.buttons || []).includes('Sync Changes'), JSON.stringify(ctx.buttons));
    const syncClick = await alice.cmd('click-menu', { label: 'Sync Changes' });
    check('B2: alice clicked Sync Changes', syncClick.ok, syncClick.error);

    const recovered = await poll(async () => {
      const banner = await alice.cmd('page-contains', { text: 'Server copy unavailable' });
      const ta = await alice.cmd('textarea');
      return { ok: !banner.contains && ta.readOnly === false && ta.value === LOCAL_COPY, banner, ta };
    });
    check('B2: banner cleared, editor editable again, local content intact',
      recovered.ok,
      recovered.ok ? '' : `banner=${recovered.banner && recovered.banner.contains} readOnly=${recovered.ta && recovered.ta.readOnly} len=${recovered.ta && recovered.ta.value && recovered.ta.value.length}`);

    const verify2 = await connectAuthed(SERVER_URL, 'verify2@test');
    const s2 = await syncOnce(verify2, DOC_B);
    check('B2: server doc now holds the re-uploaded local copy, no failure flag',
      textFromUpdateB64(s2.update) === LOCAL_COPY && s2.stateLoadFailed === undefined);
    let onDisk = null;
    try {
      onDisk = textFromUpdateB64(Buffer.from(decryptSnapshotFile(fileB, DOC_B, TEST_KEY)).toString('base64'));
    } catch { /* checked below */ }
    check('B2: snapshot file valid again with the reseeded content', onDisk === LOCAL_COPY);

    // ---- B3: live editing works after recovery ----
    await alice.cmd('type', { text: ' +recovered-edit' });
    const live = await poll(async () => {
      const s = await syncOnce(verify2, DOC_B);
      return { ok: textFromUpdateB64(s.update) === LOCAL_COPY + ' +recovered-edit', s };
    });
    check('B3: post-recovery edit reached the server', live.ok,
      live.ok ? '' : `server has: ${textFromUpdateB64(live.s.update).length} chars`);
    verify2.socket.disconnect();

    // ---- B4: genuinely-new document is unaffected ----
    const FRESH = 'brand new document content, never on the server before';
    const carol = new Client('carol', {
      MACHINE_ID: 'carol@account-test',
      SERVER_URL,
      CREATE_DOC_TITLE: 'Fresh Doc',
      CREATE_DOC_CONTENT: FRESH,
    });
    clients.push(carol);
    await carol.readyPromise;
    await sleep(1500);
    check('B4: carol websocket connected', (await carol.cmd('status')).connected);
    const cOpen = await carol.cmd('click-doc', { title: 'Fresh Doc' });
    check('B4: carol opened her local doc', cOpen.ok, cOpen.error);
    await carol.cmd('ctx-doc', { title: 'Fresh Doc' });
    const up = await carol.cmd('click-menu', { label: 'Share with the Team' });
    check('B4: carol uploaded it to the cloud', up.ok, up.error);
    await sleep(2500);
    const cDocs = await carol.cmd('docs');
    const cDoc = (cDocs.docs || []).find((d) => d.title === 'Fresh Doc' && d.cloudDocumentId);
    check('B4: uploaded doc has a cloudDocumentId', !!cDoc);
    const cState = await poll(async () => {
      const banner = await carol.cmd('page-contains', { text: 'Server copy unavailable' });
      const ta = await carol.cmd('textarea');
      return { ok: !banner.contains && ta.readOnly === false && ta.value === FRESH, banner, ta };
    });
    check('B4: new doc: NO banner, editable, content intact', cState.ok);
    if (cDoc) {
      const verify3 = await connectAuthed(SERVER_URL, 'verify3@test');
      const s3 = await poll(async () => {
        const s = await syncOnce(verify3, cDoc.cloudDocumentId);
        return { ok: textFromUpdateB64(s.update) === FRESH && s.stateLoadFailed === undefined, s };
      });
      check('B4: new doc seeded the server normally (no flag)', s3.ok);
      verify3.socket.disconnect();
    }

    // ---- B5: the pre-existing fully-offline read-only path still works ----
    srv.proc.kill('SIGKILL');
    await srv.exited;
    const offline = await poll(async () => {
      const st = await alice.cmd('status');
      return { ok: st.connected === false, st };
    });
    check('B5: alice detected the server going away', offline.ok);
    const offBanner = await poll(async () => {
      const r = await alice.cmd('page-contains', { text: 'Offline - Read Only' });
      return { ok: !!r.contains, r };
    });
    check('B5: offline banner shown for the open cloud doc', offBanner.ok);
    const ta5 = await alice.cmd('textarea');
    check('B5: editor read-only while offline', ta5.readOnly === true);
    check('B5: offline placeholder (not the server-failure one) applies',
      (ta5.placeholder || '').includes('offline'), ta5.placeholder);
    const noSrvBanner = await alice.cmd('page-contains', { text: 'Server copy unavailable' });
    check('B5: NO spurious server-copy-unavailable banner while offline', !noSrvBanner.contains);
    check('B5: alice still shows her content offline', ta5.value === LOCAL_COPY + ' +recovered-edit',
      `got ${ta5.value ? ta5.value.length : null} chars`);
  } finally {
    clients.forEach((cl) => cl.kill());
    try { srv.proc.kill(); } catch { /* already gone */ }
  }
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
    console.log(`server/client logs kept for inspection in: ${WORKDIR}`);
  }
  process.exit(exitCode);
}
