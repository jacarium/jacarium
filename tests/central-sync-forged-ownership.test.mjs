/**
 * Guards the jacarium-central ownership check on UPLOAD paths.
 *
 * THE BUG: the delete/removal paths (remove-document / remove-workflow /
 * remove-board socket events and the DELETE REST routes) always verified
 * `ownerId === <authenticated machine_id>`, but the upload paths
 * (upload-document / upload-workflow / upload-board socket events and
 * POST /api/documents|workflows|kanban/boards|taskwarrior/instances) trusted
 * whatever `ownerId` / `_type` the client put inside the payload. Receivers
 * (src/utils/cloudCentralSync.js, cloudKanban.js) accept a content update
 * purely on ownerId match + newer cloudLastUpdated, and treat any payload
 * with `_type: 'removal'` exactly like a server-generated removal. So any
 * registered client could overwrite or delete another user's synced
 * documents / workflows / boards on every peer by forging those two fields.
 *
 * THE FIX (jacarium-central/client-registry.js checkUploadOwnership, used
 * by sync-handlers.js and api-routes.js): every upload must carry the
 * VERIFIED identity as ownerId and may not carry a `_type` marker at all
 * (removals go through the dedicated remove paths, which already enforce
 * ownership and purge Yjs state). Legitimate traffic is unaffected: the
 * client always sets ownerId to its own machine_id on first upload and only
 * ever re-syncs items it owns.
 *
 * What this test proves against a REAL spawned server (random port, temp
 * DATA_DIR, real TOFU registration, two real socket.io clients):
 *   - socket + REST: bob's uploads claiming alice as owner are rejected
 *     (upload-error / 403) for documents, workflows, boards and task
 *     instances, and alice receives nothing;
 *   - socket + REST: a smuggled `_type: 'removal'` (or any `_type`) is
 *     rejected;
 *   - the pre-existing removal ownership check is intact;
 *   - alice's own uploads still succeed and reach bob live; alice's own
 *     removal still reaches bob; bob's own REST uploads are queued and
 *     delivered to alice via /api/pending, with nothing forged in the queue.
 *
 * Self-contained, no test framework (same conventions as the other
 * tests/*.test.mjs files).
 *
 * Run:  node tests/central-sync-forged-ownership.test.mjs
 * Preconditions: central server deps installed (cd jacarium-central && npm ci)
 *                and repo deps installed (npm install, for socket.io-client).
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

// ---------- spawn a real server ----------
const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forged-ownership-test-'));
const server = spawn('node', ['server.js'], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const base = `http://127.0.0.1:${port}`;

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    up = r.ok;
  } catch {
    // not listening yet
  }
  if (!up) await sleep(100);
}
if (!up) {
  console.error('server did not start:\n' + serverLog);
  server.kill('SIGKILL');
  process.exit(1);
}

async function register(machineId) {
  const r = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine_id: machineId })
  });
  return (await r.json()).secret;
}

const ALICE = 'alice@test';
const BOB = 'bob@test';
const aliceSecret = await register(ALICE);
const bobSecret = await register(BOB);

function connect(machineId, secret) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { transports: ['websocket'] });
    s.on('connect', () => s.emit('authenticate', { machine_id: machineId, client_secret: secret }));
    s.on('authenticated', (d) => (d.success ? resolve(s) : reject(new Error(d.error))));
  });
}
const alice = await connect(ALICE, aliceSecret);
const bob = await connect(BOB, bobSecret);

// Everything alice/bob receive over the sync channels
const received = { alice: [], bob: [] };
for (const [name, s] of [['alice', alice], ['bob', bob]]) {
  for (const ev of ['documents-update', 'workflows-update', 'boards-update']) {
    s.on(ev, (d) => received[name].push({ ev, d }));
  }
}

/** Emit and wait for either the success or the error reply (or a timeout). */
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

const upload = (socket, event, payload) => emitAndWait(socket, event, payload, 'upload-success', 'upload-error');
const remove = (socket, event, payload) => emitAndWait(socket, event, payload, 'removal-success', 'removal-error');

try {
  // ================= SOCKET: forged uploads by bob =================
  let r;
  r = await upload(bob, 'upload-document', {
    machine_id: BOB,
    document: { title: 'Alice doc', ownerId: ALICE, content: 'pwned', cloudLastUpdated: Date.now() + 1e9 }
  });
  check('socket: forged document ownerId rejected', r.kind === 'err' && /Permission denied/.test(r.d.error), r.d.error);

  r = await upload(bob, 'upload-document', {
    machine_id: BOB,
    document: { _type: 'removal', title: 'Alice doc', ownerId: ALICE }
  });
  check('socket: smuggled _type removal rejected', r.kind === 'err' && /remove endpoint/.test(r.d.error), r.d.error);

  r = await upload(bob, 'upload-document', {
    machine_id: BOB,
    document: { title: 'x', ownerId: ALICE, _type: 'weird' }
  });
  check('socket: unknown _type rejected', r.kind === 'err', r.d.error);

  r = await upload(bob, 'upload-workflow', {
    machine_id: BOB,
    workflow: { title: 'Alice wf', ownerId: ALICE, nodes: [], edges: [] }
  });
  check('socket: forged workflow ownerId rejected', r.kind === 'err' && /Permission denied/.test(r.d.error), r.d.error);

  r = await upload(bob, 'upload-board', {
    machine_id: BOB,
    board: { title: 'Alice board', ownerId: ALICE },
    cards: []
  });
  check('socket: forged board ownerId rejected', r.kind === 'err' && /Permission denied/.test(r.d.error), r.d.error);

  await sleep(300);
  check('socket: alice received nothing from forged uploads', received.alice.length === 0,
    JSON.stringify(received.alice).slice(0, 200));

  // ================= SOCKET: legitimate owner uploads still flow =================
  r = await upload(alice, 'upload-document', {
    machine_id: ALICE,
    document: { title: 'Alice doc', ownerId: ALICE, content: 'hi', cloudDocumentId: 'doc-1', cloudLastUpdated: Date.now() }
  });
  check('socket: own document upload succeeds', r.kind === 'ok', JSON.stringify(r.d));

  r = await upload(alice, 'upload-workflow', {
    machine_id: ALICE,
    workflow: { title: 'Alice wf', ownerId: ALICE, nodes: [], edges: [] }
  });
  check('socket: own workflow upload succeeds', r.kind === 'ok', JSON.stringify(r.d));

  r = await upload(alice, 'upload-board', {
    machine_id: ALICE,
    board: { title: 'Alice board', ownerId: ALICE, cloudBoardId: 'b-1' },
    cards: [{ id: 1 }]
  });
  check('socket: own board upload succeeds', r.kind === 'ok', JSON.stringify(r.d));

  await sleep(300);
  const bobGotDoc = received.bob.some((m) => m.ev === 'documents-update'
    && m.d.documents[0].ownerId === ALICE && m.d.documents[0].content === 'hi');
  const bobGotWf = received.bob.some((m) => m.ev === 'workflows-update' && m.d.workflows[0].ownerId === ALICE);
  const bobGotBoard = received.bob.some((m) => m.ev === 'boards-update'
    && m.d.boards[0].board.ownerId === ALICE && m.d.boards[0].cards.length === 1);
  check('socket: bob received alice\'s doc/workflow/board live', bobGotDoc && bobGotWf && bobGotBoard,
    `doc=${bobGotDoc} wf=${bobGotWf} board=${bobGotBoard}`);

  // ================= SOCKET: removal ownership =================
  r = await remove(bob, 'remove-document', { machine_id: BOB, ownerId: ALICE, title: 'Alice doc' });
  check('socket: bob cannot remove alice\'s doc (existing check intact)', r.kind === 'err', r.d.error);

  received.bob.length = 0;
  r = await remove(alice, 'remove-document', { machine_id: ALICE, ownerId: ALICE, title: 'Alice doc' });
  check('socket: alice removes her own doc', r.kind === 'ok', JSON.stringify(r.d));
  await sleep(300);
  check('socket: bob received alice\'s removal', received.bob.some((m) => m.ev === 'documents-update'
    && m.d.documents[0]._type === 'removal' && m.d.documents[0].ownerId === ALICE));

  // ================= REST =================
  const post = (p, secret, body) => fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Secret': secret },
    body: JSON.stringify(body)
  });
  let res;

  res = await post('/api/documents', bobSecret, { machine_id: BOB, document: { title: 'Alice doc', ownerId: ALICE, content: 'pwned' } });
  check('rest: forged document ownerId -> 403', res.status === 403, `${res.status} ${(await res.json()).error}`);
  res = await post('/api/documents', bobSecret, { machine_id: BOB, document: { _type: 'removal', title: 'Alice doc', ownerId: ALICE } });
  check('rest: smuggled _type removal -> 403', res.status === 403, `${res.status}`);
  res = await post('/api/workflows', bobSecret, { machine_id: BOB, workflow: { title: 'Alice wf', ownerId: ALICE } });
  check('rest: forged workflow ownerId -> 403', res.status === 403, `${res.status}`);
  res = await post('/api/kanban/boards', bobSecret, { machine_id: BOB, board: { title: 'Alice board', ownerId: ALICE }, cards: [] });
  check('rest: forged board ownerId -> 403', res.status === 403, `${res.status}`);
  res = await post('/api/taskwarrior/instances', bobSecret, { machine_id: BOB, instance: { name: 'Alice tasks', ownerId: ALICE } });
  check('rest: forged task instance ownerId -> 403', res.status === 403, `${res.status}`);
  res = await post('/api/documents', bobSecret, { machine_id: ALICE, document: { title: 'Alice doc', ownerId: ALICE, content: 'pwned' } });
  check('rest: bob\'s secret with alice\'s machine_id -> auth rejected', res.status === 403, `${res.status}`);

  res = await post('/api/documents', bobSecret, { machine_id: BOB, document: { title: 'Bob doc', ownerId: BOB, content: 'legit' } });
  check('rest: own document upload -> 200', res.status === 200, `${res.status}`);
  res = await post('/api/workflows', bobSecret, { machine_id: BOB, workflow: { title: 'Bob wf', ownerId: BOB } });
  check('rest: own workflow upload -> 200', res.status === 200, `${res.status}`);
  res = await post('/api/kanban/boards', bobSecret, { machine_id: BOB, board: { title: 'Bob board', ownerId: BOB }, cards: [] });
  check('rest: own board upload -> 200', res.status === 200, `${res.status}`);
  res = await post('/api/taskwarrior/instances', bobSecret, { machine_id: BOB, instance: { name: 'Bob tasks', ownerId: BOB } });
  check('rest: own task instance upload -> 200', res.status === 200, `${res.status}`);

  res = await fetch(`${base}/api/pending?machine_id=${encodeURIComponent(ALICE)}`, {
    headers: { 'X-Client-Secret': aliceSecret }
  });
  const pending = await res.json();
  const onlyLegit = pending.documents.length === 1 && pending.documents[0].ownerId === BOB && pending.documents[0].content === 'legit'
    && pending.workflows.length === 1 && pending.workflows[0].ownerId === BOB
    && pending.boards.length === 1 && pending.boards[0].board.ownerId === BOB
    && pending.taskInstances.length === 1 && pending.taskInstances[0].ownerId === BOB
    && !JSON.stringify(pending).includes('pwned');
  check('rest: alice polls and sees only bob-owned items, nothing forged', onlyLegit,
    JSON.stringify({ d: pending.documents.length, w: pending.workflows.length, b: pending.boards.length, t: pending.taskInstances.length }));
} catch (error) {
  check('unexpected error', false, error.stack || String(error));
} finally {
  alice.close();
  bob.close();
  server.kill('SIGTERM');
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('--- server log tail ---\n' + serverLog.slice(-2000));
}
process.exit(failed.length ? 1 : 0);
