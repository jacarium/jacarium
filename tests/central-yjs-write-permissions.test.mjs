/**
 * The central server enforces WRITE permissions on shared documents and
 * boards (jacarium-central/share-permissions.js + yjs-sync.js), not just the
 * app's UI.
 *
 * THE HOLE: sharing is visible to the whole team by design, and the Yjs room
 * id (cloudDocumentId / cloudBoardId) travels inside every shared payload.
 * Before this, yjs-update accepted edits from ANY authenticated socket, so a
 * member without Read & Write could change a document's live CRDT state with
 * a modified client; only DocumentEditor / KanbanPage went read-only.
 *
 * THE FIX: the server records owner + permissions per room from the OWNER's
 * uploads (socket upload-document/upload-board, POST /api/documents and
 * /api/kanban/boards), persists them (DATA_DIR/share-permissions.json) and
 * drops yjs-update from anyone who is neither the owner nor 'write': not
 * applied, not persisted, not broadcast; the sender gets yjs-update-rejected.
 * Reading (sync-step1/2) and awareness (cursor presence) stay open to every
 * authenticated member.
 *
 * What this proves against a REAL spawned server (random port, temp
 * DATA_DIR, real registration, real socket.io clients):
 *   - the owner's edits are applied and reach the others;
 *   - a 'write' member's edits are applied and reach the others;
 *   - a 'read' member's and an unlisted member's edits are refused with
 *     yjs-update-rejected, reach nobody, and leave the server state as it was
 *     (a fresh client syncing afterwards sees only the accepted edits);
 *   - awareness from a read-only member still reaches the others;
 *   - the owner re-uploading with changed permissions takes effect at once
 *     (grant and revoke);
 *   - the record survives a server restart (same DATA_DIR);
 *   - POST /api/reown moves the owner's and a member's rights to the new
 *     identity;
 *   - boards (cloudBoardId rooms) are enforced the same way;
 *   - a room never uploaded with a record (shared before records existed)
 *     stays writable for every member - the documented legacy behaviour.
 *
 * Self-contained, no test framework (same conventions as the other
 * tests/central-*.test.mjs files).
 *
 * Run:  node tests/central-yjs-write-permissions.test.mjs
 * Preconditions: central server deps installed (cd jacarium-central && npm ci)
 *                and repo deps installed (npm install, for socket.io-client + yjs).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
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
const Y = repoRequire('yjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ---------- a real server (restartable on the same DATA_DIR) ----------
const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yjs-write-permissions-test-'));
const base = `http://127.0.0.1:${port}`;
let server = null;
let serverLog = '';

async function startServer() {
  server = spawn('node', ['server.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not listening yet */ }
    if (!up) await sleep(100);
  }
  if (!up) {
    console.error('server did not start:\n' + serverLog);
    server.kill('SIGKILL');
    process.exit(1);
  }
}
async function stopServer() {
  if (!server) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, sleep(3000)]);
  server = null;
}
await startServer();

async function register(machineId) {
  const r = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine_id: machineId })
  });
  return (await r.json()).secret;
}

const ALICE = 'alice@test';   // owner
const BOB = 'bob@test';       // Read & Write
const CAROL = 'carol@test';   // Read
const DAVE = 'dave@test';     // not listed at all
const secrets = {};
for (const id of [ALICE, BOB, CAROL, DAVE]) secrets[id] = await register(id);

/** One connected, authenticated client with a recorder of the Yjs events it sees. */
function connect(machineId) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { transports: ['websocket'] });
    const seen = { updates: [], rejected: [], awareness: [], step2: [] };
    s.on('yjs-update', (d) => seen.updates.push(d));
    s.on('yjs-update-rejected', (d) => seen.rejected.push(d));
    s.on('yjs-awareness-update', (d) => seen.awareness.push(d));
    s.on('yjs-sync-step2', (d) => seen.step2.push(d));
    s.on('connect', () => s.emit('authenticate', { machine_id: machineId, client_secret: secrets[machineId] }));
    s.on('authenticated', (d) => (d.success ? resolve({ id: machineId, socket: s, seen }) : reject(new Error(d.error))));
    s.on('connect_error', (e) => reject(e));
  });
}

function emitAndWait(socket, event, payload, okEvent, errEvent) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(okEvent, onOk);
      socket.off(errEvent, onErr);
      resolve({ kind: 'timeout', d: {} });
    }, 3000);
    const onOk = (d) => { clearTimeout(timer); socket.off(errEvent, onErr); resolve({ kind: 'ok', d }); };
    const onErr = (d) => { clearTimeout(timer); socket.off(okEvent, onOk); resolve({ kind: 'err', d }); };
    socket.once(okEvent, onOk);
    socket.once(errEvent, onErr);
    socket.emit(event, payload);
  });
}
const upload = (c, event, payload) => emitAndWait(c.socket, event, { machine_id: c.id, ...payload }, 'upload-success', 'upload-error');

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** Join a room: send our (empty) state vector, wait for sync-step2, apply it. Returns the Y.Doc. */
async function join(c, roomId) {
  const ydoc = new Y.Doc();
  const before = c.seen.step2.length;
  c.socket.emit('yjs-sync-step1', { documentId: roomId, stateVector: b64(Y.encodeStateVector(ydoc)) });
  for (let i = 0; i < 30 && c.seen.step2.length === before; i++) await sleep(100);
  // the LATEST reply for this room: a client that rejoins must start from the
  // server's current state, not from the first reply it ever got
  const step2 = [...c.seen.step2].reverse().find((d) => d.documentId === roomId);
  if (step2) Y.applyUpdate(ydoc, Buffer.from(step2.update, 'base64'));
  return ydoc;
}

/** Make an edit in a local Y.Doc and send the resulting update to the server. Returns the base64 update. */
function sendTextEdit(c, roomId, ydoc, text) {
  let update = null;
  const onUpdate = (u) => { update = u; };
  ydoc.on('update', onUpdate);
  ydoc.getText('content').insert(ydoc.getText('content').length, text);
  ydoc.off('update', onUpdate);
  const encoded = b64(update);
  c.socket.emit('yjs-update', { documentId: roomId, update: encoded });
  return encoded;
}

/** The text a brand-new client sees for a room (the server's real state). */
async function serverText(roomId) {
  const probe = await connect(DAVE);
  const ydoc = await join(probe, roomId);
  const text = ydoc.getText('content').toString();
  probe.socket.close();
  return text;
}

const DOC = 'doc-perm-1';
const BOARD = 'board-perm-1';
const LEGACY = 'doc-legacy-never-uploaded';

let alice, bob, carol, dave;
try {
  alice = await connect(ALICE);
  bob = await connect(BOB);
  carol = await connect(CAROL);
  dave = await connect(DAVE);

  // ================= the owner shares a document with bob: write, carol: read =================
  let r = await upload(alice, 'upload-document', {
    document: { title: 'Runbook', ownerId: ALICE, content: '', cloudDocumentId: DOC, cloudLastUpdated: Date.now(), permissions: { [BOB]: 'write', [CAROL]: 'read' } }
  });
  check('owner upload with permissions accepted', r.kind === 'ok', JSON.stringify(r.d));
  check('the record is persisted on disk', fs.existsSync(path.join(dataDir, 'share-permissions.json')) && JSON.parse(fs.readFileSync(path.join(dataDir, 'share-permissions.json'), 'utf8'))[DOC]?.permissions?.[BOB] === 'write');

  const docs = {};
  for (const c of [alice, bob, carol, dave]) docs[c.id] = await join(c, DOC);
  check('every member may read the room (sync-step2 for all four)', [alice, bob, carol, dave].every((c) => c.seen.step2.some((d) => d.documentId === DOC)));

  // owner edit
  sendTextEdit(alice, DOC, docs[ALICE], 'A');
  await sleep(300);
  check('owner edit reaches the others', [bob, carol, dave].every((c) => c.seen.updates.some((d) => d.documentId === DOC)), `bob=${bob.seen.updates.length} carol=${carol.seen.updates.length} dave=${dave.seen.updates.length}`);
  check('owner edit is not refused', alice.seen.rejected.length === 0);
  for (const c of [bob, carol, dave]) for (const d of c.seen.updates) if (d.documentId === DOC) Y.applyUpdate(docs[c.id], Buffer.from(d.update, 'base64'));
  for (const c of [bob, carol, dave]) c.seen.updates.length = 0;

  // write member edit
  sendTextEdit(bob, DOC, docs[BOB], 'B');
  await sleep(300);
  check('write member edit reaches the owner and the others', [alice, carol, dave].every((c) => c.seen.updates.some((d) => d.documentId === DOC)));
  check('write member edit is not refused', bob.seen.rejected.length === 0);
  for (const c of [alice, carol, dave]) for (const d of c.seen.updates) if (d.documentId === DOC) Y.applyUpdate(docs[c.id], Buffer.from(d.update, 'base64'));
  for (const c of [alice, carol, dave]) c.seen.updates.length = 0;

  // read member edit
  sendTextEdit(carol, DOC, docs[CAROL], 'C');
  await sleep(300);
  check('read member edit is refused with yjs-update-rejected', carol.seen.rejected.some((d) => d.documentId === DOC && d.reason === 'read-only' && /view/.test(d.message || '')), JSON.stringify(carol.seen.rejected));
  check('read member edit reaches nobody', [alice, bob, dave].every((c) => c.seen.updates.length === 0));

  // unlisted member edit
  sendTextEdit(dave, DOC, docs[DAVE], 'D');
  await sleep(300);
  check('unlisted member edit is refused', dave.seen.rejected.some((d) => d.documentId === DOC));
  check('unlisted member edit reaches nobody', [alice, bob, carol].every((c) => c.seen.updates.length === 0));

  check('server state holds only the accepted edits (A, B)', (await serverText(DOC)) === 'AB', JSON.stringify(await serverText(DOC)));

  // awareness from a read-only member still flows (cursor presence is harmless)
  carol.socket.emit('yjs-awareness-update', { documentId: DOC, update: b64(Buffer.from([0])) });
  await sleep(300);
  check('a read-only member\'s awareness (cursor) still reaches the others', [alice, bob].every((c) => c.seen.awareness.some((d) => d.documentId === DOC)));

  // ================= permission change takes effect at once =================
  r = await upload(alice, 'upload-document', {
    document: { title: 'Runbook', ownerId: ALICE, content: 'AB', cloudDocumentId: DOC, cloudLastUpdated: Date.now(), permissions: { [BOB]: 'read', [CAROL]: 'write' } }
  });
  check('owner re-upload with swapped permissions accepted', r.kind === 'ok');
  for (const c of [alice, bob, carol, dave]) { c.seen.updates.length = 0; c.seen.rejected.length = 0; }
  // carol's local doc still holds her refused 'C'; use a fresh view of the server state for her
  docs[CAROL] = await join({ ...carol, seen: carol.seen }, DOC);
  sendTextEdit(carol, DOC, docs[CAROL], 'c');
  sendTextEdit(bob, DOC, docs[BOB], 'b');
  await sleep(300);
  check('newly granted member is accepted', carol.seen.rejected.length === 0 && alice.seen.updates.some((d) => d.documentId === DOC));
  check('revoked member is refused', bob.seen.rejected.some((d) => d.documentId === DOC));
  check('server state: ABc', (await serverText(DOC)) === 'ABc', JSON.stringify(await serverText(DOC)));

  // ================= boards: the same rule on cloudBoardId rooms =================
  r = await upload(alice, 'upload-board', {
    board: { title: 'Roadmap', ownerId: ALICE, cloudBoardId: BOARD, permissions: { [BOB]: 'write' } },
    cards: []
  });
  check('owner board upload accepted', r.kind === 'ok');
  const boards = {};
  for (const c of [alice, bob, carol]) { boards[c.id] = await join(c, BOARD); c.seen.updates.length = 0; c.seen.rejected.length = 0; }
  sendTextEdit(bob, BOARD, boards[BOB], 'x');
  sendTextEdit(carol, BOARD, boards[CAROL], 'y');
  await sleep(300);
  check('board: write member accepted, read-only member refused', bob.seen.rejected.length === 0 && carol.seen.rejected.some((d) => d.documentId === BOARD) && alice.seen.updates.filter((d) => d.documentId === BOARD).length === 1);

  // ================= legacy room: never uploaded with a record =================
  const legacyDocs = {};
  for (const c of [carol, dave]) { legacyDocs[c.id] = await join(c, LEGACY); c.seen.updates.length = 0; c.seen.rejected.length = 0; }
  sendTextEdit(dave, LEGACY, legacyDocs[DAVE], 'L');
  await sleep(300);
  check('a room without a record stays open (legacy behaviour: no record, no refusal)', dave.seen.rejected.length === 0 && carol.seen.updates.some((d) => d.documentId === LEGACY));

  // ================= restart: the record survives =================
  for (const c of [alice, bob, carol, dave]) c.socket.close();
  await stopServer();
  await startServer();
  alice = await connect(ALICE); bob = await connect(BOB); carol = await connect(CAROL);
  const after = {};
  for (const c of [alice, bob, carol]) after[c.id] = await join(c, DOC);
  sendTextEdit(bob, DOC, after[BOB], 'z');
  sendTextEdit(carol, DOC, after[CAROL], 'w');
  await sleep(300);
  check('after a restart the record still applies (bob revoked -> refused, carol write -> accepted)', bob.seen.rejected.some((d) => d.documentId === DOC) && carol.seen.rejected.length === 0 && alice.seen.updates.filter((d) => d.documentId === DOC).length === 1);

  // ================= re-own: rights follow the identity =================
  // carol's device becomes the account identity "carol@account-1"; alice does the same
  const CAROL2 = 'carol@account-1';
  const ALICE2 = 'alice@account-1';
  secrets[CAROL2] = await register(CAROL2);
  secrets[ALICE2] = await register(ALICE2);
  const reown = (newId, oldId) => fetch(`${base}/api/reown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Secret': secrets[newId] },
    body: JSON.stringify({ machine_id: newId, old_machine_id: oldId, old_client_secret: secrets[oldId], documents: [] })
  });
  let res = await reown(CAROL2, CAROL);
  check('re-own of the member identity accepted', res.status === 200, `${res.status}`);
  res = await reown(ALICE2, ALICE);
  check('re-own of the owner identity accepted', res.status === 200, `${res.status}`);
  await sleep(300);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'share-permissions.json'), 'utf8'))[DOC];
  check('the record now names the new identities', stored.ownerId === ALICE2 && stored.permissions[CAROL2] === 'write' && !(CAROL in stored.permissions), JSON.stringify(stored));
  const carol2 = await connect(CAROL2);
  const alice2 = await connect(ALICE2);
  const renamed = {};
  for (const c of [carol2, alice2]) renamed[c.id] = await join(c, DOC);
  sendTextEdit(carol2, DOC, renamed[CAROL2], 'q');
  sendTextEdit(alice2, DOC, renamed[ALICE2], 'r');
  await sleep(300);
  check('renamed member and renamed owner are both accepted', carol2.seen.rejected.length === 0 && alice2.seen.rejected.length === 0 && alice2.seen.updates.some((d) => d.documentId === DOC) && carol2.seen.updates.some((d) => d.documentId === DOC));
  carol2.socket.close(); alice2.socket.close();
  for (const c of [alice, bob, carol]) c.socket.close();
} catch (error) {
  check('unexpected error', false, error.stack || String(error));
} finally {
  for (const c of [alice, bob, carol, dave]) { try { c?.socket?.close(); } catch { /* ignore */ } }
  await stopServer();
  await sleep(200);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('--- server log tail ---\n' + serverLog.slice(-3000));
}
process.exit(failed.length ? 1 : 0);
