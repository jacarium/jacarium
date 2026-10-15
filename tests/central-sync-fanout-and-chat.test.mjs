/**
 * Guards three jacarium-central resource/identity fixes:
 *
 * 1. FAN-OUT (sync-handlers.js): cursor-update / content-update used to push
 *    the full document content and cursor map to EVERY connected client on
 *    every keystroke, whatever they had open. They are now scoped to a room
 *    keyed by documentId (the same room id the Yjs sync uses); a client
 *    joins it the first time it sends cursor/content traffic for that doc.
 *
 * 2. CHAT IDENTITY (socket-handlers.js): chat payloads were relayed
 *    verbatim including the client-supplied username/userId, so any client
 *    could impersonate a teammate. The relay now rebuilds the message from
 *    the VERIFIED machineId (username derived server-side, same rule the
 *    client uses for itself) and only passes the text through.
 *
 * 3. MEMORY (state.js / server.js): queued upload bodies were unbounded and
 *    activeMachines was never pruned - and because delivery is only
 *    considered complete once every active machine has received a message,
 *    a ghost machine kept every message queued until expiry. pushBounded()
 *    caps each queue (oldest dropped) and pruneStaleMachines() forgets
 *    machines neither connected nor seen for the message timeout.
 *
 * What this test proves:
 *   Part A (real spawned server, 3 authenticated clients): B, who viewed the
 *     same document as A, receives A's cursors/content/cursor-removed; C,
 *     viewing another document, receives none of it. A's chat message
 *     arrives at B and C with A's verified identity even though A claimed to
 *     be someone else; an empty message is dropped; the sender gets no echo.
 *   Part B (state.js in-process): pushBounded trims to the cap keeping the
 *     newest; ActiveMachines records lastSeen on add; pruneStaleMachines
 *     removes only stale, non-connected machines.
 *
 * Run:  node tests/central-sync-fanout-and-chat.test.mjs
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
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const repoRequire = createRequire(path.join(REPO, 'package.json'));
const { io: ioClient } = repoRequire('socket.io-client');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

// ================= Part A: real server =================
console.log('--- Part A: fan-out + chat identity (spawned server)');
const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-test-'));
const server = spawn('node', ['server.js'], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* wait */ } await sleep(100); }

async function client(id) {
  const reg = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machine_id: id }) });
  const { secret } = await reg.json();
  const socket = await new Promise((resolve, reject) => {
    const s = ioClient(base, { transports: ['websocket'] });
    s.on('connect', () => s.emit('authenticate', { machine_id: id, client_secret: secret }));
    s.on('authenticated', (d) => (d.success ? resolve(s) : reject(new Error(d.error))));
  });
  const received = [];
  for (const ev of ['cursors-update', 'content-update', 'cursor-removed', 'chat-message']) {
    socket.on(ev, (d) => received.push({ ev, d }));
  }
  return { id, socket, received, clear: () => { received.length = 0; } };
}

const A = await client('a@test');
const B = await client('b@test');
const C = await client('c@test');

try {
  // Establish rooms: A and B view doc-1, C views doc-2
  A.socket.emit('cursor-update', { documentId: 'doc-1', position: 1, name: 'A' });
  B.socket.emit('cursor-update', { documentId: 'doc-1', position: 2, name: 'B' });
  C.socket.emit('cursor-update', { documentId: 'doc-2', position: 3, name: 'C' });
  await sleep(300);
  [A, B, C].forEach((c) => c.clear());

  A.socket.emit('cursor-update', { documentId: 'doc-1', position: 10, name: 'A' });
  await sleep(300);
  check('cursor-update: B (same doc) receives cursors-update for doc-1',
    B.received.some((m) => m.ev === 'cursors-update' && m.d.documentId === 'doc-1' && m.d.cursors['a@test'] && m.d.cursors['a@test'].position === 10));
  check('cursor-update: C (other doc) receives nothing', C.received.length === 0, JSON.stringify(C.received).slice(0, 120));
  check('cursor-update: sender does not get its own cursor back',
    A.received.every((m) => m.ev !== 'cursors-update' || !m.d.cursors['a@test']));

  [A, B, C].forEach((c) => c.clear());
  A.socket.emit('content-update', { documentId: 'doc-1', content: 'hello from A', cursorPosition: 5 });
  await sleep(300);
  check('content-update: B (same doc) receives the content',
    B.received.some((m) => m.ev === 'content-update' && m.d.documentId === 'doc-1' && m.d.content === 'hello from A' && m.d.userId === 'a@test'));
  check('content-update: sender receives its own echo (client filters it)', A.received.some((m) => m.ev === 'content-update'));
  check('content-update: C (other doc) receives nothing', C.received.length === 0, JSON.stringify(C.received).slice(0, 120));

  [A, B, C].forEach((c) => c.clear());
  A.socket.emit('cursor-removed', { documentId: 'doc-1' });
  await sleep(300);
  check('cursor-removed: B receives it', B.received.some((m) => m.ev === 'cursor-removed' && m.d.userId === 'a@test'));
  check('cursor-removed: C does not', C.received.length === 0);

  // Chat identity
  [A, B, C].forEach((c) => c.clear());
  A.socket.emit('chat-message', { username: 'mallory', userId: 'mallory@evil', message: 'hi team', timestamp: 1, extra: 'x' });
  await sleep(300);
  const bChat = B.received.find((m) => m.ev === 'chat-message');
  check('chat: B receives the message', Boolean(bChat), JSON.stringify(B.received).slice(0, 160));
  check('chat: identity is the verified sender, not the claimed one',
    bChat && bChat.d.username === 'a' && bChat.d.userId === 'a@test' && bChat.d.message === 'hi team', bChat && JSON.stringify(bChat.d));
  check('chat: extra client fields are not relayed', bChat && !('extra' in bChat.d));
  check('chat: C receives it too (all other clients)', C.received.some((m) => m.ev === 'chat-message' && m.d.userId === 'a@test'));
  check('chat: sender gets no echo', !A.received.some((m) => m.ev === 'chat-message'));
  [A, B, C].forEach((c) => c.clear());
  A.socket.emit('chat-message', { username: 'x', message: '   ' });
  A.socket.emit('chat-message', { username: 'x', message: 42 });
  A.socket.emit('chat-message', null);
  await sleep(300);
  check('chat: empty / non-string / null messages dropped', B.received.length === 0 && C.received.length === 0);
} catch (error) {
  check('unexpected error (part A)', false, error.stack || String(error));
} finally {
  [A, B, C].forEach((c) => c.socket.close());
  server.kill('SIGTERM');
  await sleep(200);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// ================= Part B: state.js in-process =================
console.log('--- Part B: pushBounded / ActiveMachines / pruneStaleMachines');
process.env.MAX_QUEUE_PER_TYPE = '5';
const state = serverRequire('./state');
const q = [];
for (let i = 1; i <= 8; i++) state.pushBounded(q, { id: i });
check('pushBounded caps at MAX_QUEUE_PER_TYPE keeping the newest', q.length === 5 && q[0].id === 4 && q[4].id === 8, JSON.stringify(q));
check('MAX_QUEUE_PER_TYPE honors the env override', state.MAX_QUEUE_PER_TYPE === 5);

const am = state.messageQueue.activeMachines;
am.add('old@test');
am.lastSeen.set('old@test', Date.now() - 60 * 60 * 1000);
am.add('fresh@test');
am.add('connected-but-old@test');
am.lastSeen.set('connected-but-old@test', Date.now() - 60 * 60 * 1000);
state.connectedClients.set('connected-but-old@test', { id: 'fake' });
check('ActiveMachines.add records lastSeen', typeof am.lastSeen.get('fresh@test') === 'number' && am.has('fresh@test'));
const pruned = state.pruneStaleMachines(30 * 60 * 1000);
check('pruneStaleMachines removes only stale, non-connected machines',
  pruned.length === 1 && pruned[0] === 'old@test' && !am.has('old@test') && am.has('fresh@test') && am.has('connected-but-old@test'), JSON.stringify(pruned));
check('delete clears lastSeen', am.delete('fresh@test') && !am.lastSeen.has('fresh@test'));
state.connectedClients.delete('connected-but-old@test');

if (results.some((r) => !r.pass)) console.log('--- server log tail ---\n' + serverLog.slice(-1500));
const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
