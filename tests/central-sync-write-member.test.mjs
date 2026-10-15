/**
 * "Sync Changes" by a Read & Write member: the central server accepts a
 * re-upload of a shared document / board / workflow from an identity its
 * share record (jacarium-central/share-permissions.js) lists as 'write',
 * keeping the owner's ownerId - while everything checkUploadOwnership guards
 * stays guarded.
 *
 * THE BUG: the app offers Sync Changes to Read & Write members (their
 * permissions[me] === 'write'), and their client sends the item with the
 * OWNER's ownerId unchanged - but the anti-forgery rule on the upload paths
 * demanded ownerId === the authenticated identity, so the server answered
 * 403 / upload-error ("Sharing Failed") and the snapshot never went out.
 *
 * THE FIX (client-registry.js checkUploadOwnership + share-permissions.js
 * checkSharedUpload): an upload whose ownerId is not the sender's is accepted
 * when the sender is a 'write' member of that item according to the server's
 * own record, learned from the owner's uploads. The member may not touch the
 * permission map or the ownerId: a payload whose permissions differ from the
 * stored map is refused, and the record is never changed by a member.
 *
 * What this proves against a REAL spawned server (random port, temp
 * DATA_DIR, real registration, socket.io and REST clients):
 *   - the owner shares a document, a board and a workflow with bob: write,
 *     carol: read;
 *   - bob's re-upload (owner's ownerId kept) is accepted on the socket path
 *     and on REST, delivered live to the others and queued for the offline
 *     machine (/api/pending), with the owner's ownerId intact;
 *   - carol's re-upload is refused (403 / upload-error) and reaches nobody;
 *   - bob claiming himself as owner is refused (forgery, unchanged);
 *   - bob re-uploading with a changed permission map (granting carol, or
 *     dropping himself from the map) is refused and the stored record stays;
 *   - an item with no record (never uploaded by its owner here) is still
 *     refused for a non-owner - the legacy rule is the strict one;
 *   - dave, unlisted, is refused.
 *
 * Self-contained, no test framework (same conventions as the other
 * tests/central-*.test.mjs files).
 *
 * Run:  node tests/central-sync-write-member.test.mjs
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-write-member-test-'));
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
  try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not listening yet */ }
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

const ALICE = 'alice@test';  // owner
const BOB = 'bob@test';      // Read & Write
const CAROL = 'carol@test';  // Read
const DAVE = 'dave@test';    // unlisted
const EVE = 'eve@test';      // offline: only ever polls /api/pending
const secrets = {};
for (const id of [ALICE, BOB, CAROL, DAVE, EVE]) secrets[id] = await register(id);

function connect(machineId) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { transports: ['websocket'] });
    const seen = [];
    for (const ev of ['documents-update', 'workflows-update', 'boards-update']) s.on(ev, (d) => seen.push({ ev, d }));
    s.on('connect', () => s.emit('authenticate', { machine_id: machineId, client_secret: secrets[machineId] }));
    s.on('authenticated', (d) => (d.success ? resolve({ id: machineId, socket: s, seen }) : reject(new Error(d.error))));
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
const post = (p, machineId, body) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Client-Secret': secrets[machineId] },
  body: JSON.stringify({ machine_id: machineId, ...body })
});
const pendingFor = async (machineId) => (await fetch(`${base}/api/pending?machine_id=${encodeURIComponent(machineId)}`, { headers: { 'X-Client-Secret': secrets[machineId] } })).json();
const record = (id) => (JSON.parse(fs.readFileSync(path.join(dataDir, 'share-permissions.json'), 'utf8'))[id]);
const clear = (...cs) => cs.forEach((c) => { c.seen.length = 0; });

const PERMS = { [BOB]: 'write', [CAROL]: 'read' };
const DOC = 'doc-wm-1';
const BOARD = 'board-wm-1';
const doc = (extra) => ({ title: 'Runbook', ownerId: ALICE, content: 'v1', cloudDocumentId: DOC, cloudLastUpdated: Date.now(), permissions: PERMS, ...extra });
const board = (extra) => ({ title: 'Roadmap', ownerId: ALICE, cloudBoardId: BOARD, cloudLastUpdated: Date.now(), permissions: PERMS, ...extra });
const workflow = (extra) => ({ title: 'Deploy', ownerId: ALICE, nodes: [], edges: [], cloudLastUpdated: Date.now(), permissions: PERMS, ...extra });

let alice, bob, carol, dave;
try {
  alice = await connect(ALICE);
  bob = await connect(BOB);
  carol = await connect(CAROL);
  dave = await connect(DAVE);
  await pendingFor(EVE); // eve is known to the server but stays offline: uploads queue for her

  // ================= the owner shares all three =================
  let r = await upload(alice, 'upload-document', { document: doc() });
  check('owner shares the document', r.kind === 'ok', JSON.stringify(r.d));
  r = await upload(alice, 'upload-board', { board: board(), cards: [] });
  check('owner shares the board', r.kind === 'ok', JSON.stringify(r.d));
  r = await upload(alice, 'upload-workflow', { workflow: workflow() });
  check('owner shares the workflow', r.kind === 'ok', JSON.stringify(r.d));
  await sleep(300);
  await pendingFor(EVE); // drain eve's queue so later checks see only the member's uploads
  clear(alice, bob, carol, dave);

  // ================= bob (write) syncs his changes: socket =================
  r = await upload(bob, 'upload-document', { document: doc({ content: 'v2 by bob' }) });
  check('socket: write member document sync accepted', r.kind === 'ok', JSON.stringify(r.d));
  r = await upload(bob, 'upload-board', { board: board({ title: 'Roadmap Q4' }), cards: [{ id: 'c1' }] });
  check('socket: write member board sync accepted', r.kind === 'ok', JSON.stringify(r.d));
  r = await upload(bob, 'upload-workflow', { workflow: workflow({ nodes: [{ id: 'n1' }] }) });
  check('socket: write member workflow sync accepted', r.kind === 'ok', JSON.stringify(r.d));
  await sleep(300);
  const aliceGot = alice.seen.filter((m) => m.ev === 'documents-update' && m.d.documents[0].content === 'v2 by bob' && m.d.documents[0].ownerId === ALICE).length === 1
    && alice.seen.some((m) => m.ev === 'boards-update' && m.d.boards[0].board.title === 'Roadmap Q4' && m.d.boards[0].board.ownerId === ALICE)
    && alice.seen.some((m) => m.ev === 'workflows-update' && m.d.workflows[0].nodes.length === 1 && m.d.workflows[0].ownerId === ALICE);
  check('socket: the owner and the others receive bob\'s versions, ownerId still the owner\'s', aliceGot && carol.seen.length === 3 && dave.seen.length === 3, `alice=${alice.seen.length} carol=${carol.seen.length} dave=${dave.seen.length}`);
  const queued = await pendingFor(EVE);
  check('socket: bob\'s versions are queued for the offline machine', queued.documents.length === 1 && queued.documents[0].content === 'v2 by bob' && queued.boards.length === 1 && queued.workflows.length === 1, JSON.stringify({ d: queued.documents.length, b: queued.boards.length, w: queued.workflows.length }));
  check('the stored record is unchanged by a member\'s sync', record(DOC).ownerId === ALICE && record(DOC).permissions[BOB] === 'write' && record(DOC).permissions[CAROL] === 'read');
  clear(alice, bob, carol, dave);

  // ================= bob (write) syncs: REST =================
  let res = await post('/api/documents', BOB, { document: doc({ content: 'v3 by bob (rest)' }) });
  check('rest: write member document sync -> 200', res.status === 200, `${res.status} ${await res.text()}`);
  res = await post('/api/kanban/boards', BOB, { board: board({ title: 'Roadmap Q4 rest' }), cards: [] });
  check('rest: write member board sync -> 200', res.status === 200, `${res.status}`);
  res = await post('/api/workflows', BOB, { workflow: workflow({ nodes: [{ id: 'n1' }, { id: 'n2' }] }) });
  check('rest: write member workflow sync -> 200', res.status === 200, `${res.status}`);
  const q2 = await pendingFor(EVE);
  check('rest: queued for the offline machine with the owner\'s ownerId', q2.documents.length === 1 && q2.documents[0].ownerId === ALICE && q2.documents[0].content === 'v3 by bob (rest)' && q2.boards.length === 1 && q2.workflows.length === 1, JSON.stringify({ d: q2.documents.length, b: q2.boards.length, w: q2.workflows.length }));
  clear(alice, bob, carol, dave);

  // ================= carol (read) and dave (unlisted) are refused =================
  r = await upload(carol, 'upload-document', { document: doc({ content: 'by carol' }) });
  check('socket: read member document sync refused', r.kind === 'err' && /Permission denied/.test(r.d.error), r.d.error);
  r = await upload(carol, 'upload-board', { board: board(), cards: [] });
  check('socket: read member board sync refused', r.kind === 'err', r.d.error);
  r = await upload(carol, 'upload-workflow', { workflow: workflow() });
  check('socket: read member workflow sync refused', r.kind === 'err', r.d.error);
  r = await upload(dave, 'upload-document', { document: doc({ content: 'by dave' }) });
  check('socket: unlisted member document sync refused', r.kind === 'err', r.d.error);
  res = await post('/api/documents', CAROL, { document: doc({ content: 'by carol (rest)' }) });
  check('rest: read member document sync -> 403', res.status === 403, `${res.status}`);
  res = await post('/api/kanban/boards', DAVE, { board: board(), cards: [] });
  check('rest: unlisted member board sync -> 403', res.status === 403, `${res.status}`);
  await sleep(300);
  check('refused syncs reach nobody', alice.seen.length === 0 && bob.seen.length === 0 && dave.seen.length === 0 && (await pendingFor(EVE)).documents.length === 0);
  clear(alice, bob, carol, dave);

  // ================= bob may not change the map or the owner =================
  r = await upload(bob, 'upload-document', { document: doc({ permissions: { [BOB]: 'write', [CAROL]: 'write' } }) });
  check('socket: write member granting someone else refused', r.kind === 'err' && /owner/.test(r.d.error), r.d.error);
  r = await upload(bob, 'upload-document', { document: doc({ permissions: { [BOB]: 'write' } }) });
  check('socket: write member dropping an entry refused', r.kind === 'err', r.d.error);
  r = await upload(bob, 'upload-document', { document: doc({ permissions: {} }) });
  check('socket: write member clearing the map refused', r.kind === 'err', r.d.error);
  r = await upload(bob, 'upload-document', { document: doc({ ownerId: BOB }) });
  check('socket: write member claiming ownership refused (forgery rule intact)', r.kind === 'err' && /Permission denied/.test(r.d.error), r.d.error);
  r = await upload(bob, 'upload-document', { document: doc({ _type: 'removal' }) });
  check('socket: smuggled removal still refused', r.kind === 'err', r.d.error);
  res = await post('/api/documents', BOB, { document: doc({ permissions: { [BOB]: 'write', [DAVE]: 'write' } }) });
  check('rest: write member changing the map -> 403', res.status === 403, `${res.status}`);
  await sleep(300);
  check('nothing of that reached anyone', alice.seen.length === 0 && carol.seen.length === 0 && dave.seen.length === 0);
  check('the stored record is still the owner\'s', record(DOC).permissions[CAROL] === 'read' && !(DAVE in record(DOC).permissions) && record(DOC).ownerId === ALICE);
  // the owner's own payload without a permissions field is fine (an older
  // client, or an item never shared with anyone in particular)
  r = await upload(alice, 'upload-document', { document: doc({ permissions: undefined }) });
  check('owner upload without a permissions field accepted (record emptied)', r.kind === 'ok' && Object.keys(record(DOC).permissions).length === 0, JSON.stringify(record(DOC)));
  r = await upload(bob, 'upload-document', { document: doc({ permissions: undefined }) });
  check('...after which bob is a plain member again: refused', r.kind === 'err', r.d.error);
  clear(alice, bob, carol, dave);

  // ================= no record: a non-owner is refused (strict) =================
  r = await upload(bob, 'upload-document', { document: doc({ cloudDocumentId: 'doc-never-recorded', title: 'Unknown', content: 'x' }) });
  check('socket: an item the server has no record of is refused for a non-owner', r.kind === 'err', r.d.error);
  r = await upload(bob, 'upload-workflow', { workflow: workflow({ title: 'Unknown wf' }) });
  check('socket: a workflow the server has no record of is refused for a non-owner', r.kind === 'err', r.d.error);
} catch (error) {
  check('unexpected error', false, error.stack || String(error));
} finally {
  for (const c of [alice, bob, carol, dave]) { try { c?.socket?.close(); } catch { /* ignore */ } }
  server.kill('SIGTERM');
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('--- server log tail ---\n' + serverLog.slice(-3000));
}
process.exit(failed.length ? 1 : 0);
