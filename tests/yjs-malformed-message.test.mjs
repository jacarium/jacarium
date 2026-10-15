/**
 * Guards against "one malformed Yjs socket message crashes the whole server".
 *
 * jacarium-central/yjs-sync.js registers the 'yjs-sync-step1' and
 * 'yjs-update' socket handlers. They used to dereference and decode fields off
 * the incoming payload (stateVector, update) with no shape validation and no
 * try/catch, then hand the bytes to Buffer.from / encodeStateAsUpdate /
 * applyUpdate. server.js had no process-level uncaughtException handler, so a
 * payload with a missing/wrong-type field, or base64 that decodes to bytes
 * that aren't a valid Yjs update, threw synchronously inside the socket
 * callback and EXITED Node - taking down every other connected client's
 * documents, boards, quizzes and chat, not just the sender's. Client
 * registration is trust-on-first-use, so this needs only a buggy or
 * version-skewed client, not a malicious one.
 *
 * THE FIX under test:
 *   - both handlers validate payload shape (documentId + the base64 field must
 *     be non-empty strings) BEFORE using anything, and ignore the message
 *     otherwise;
 *   - the base64 decode + Yjs mutation calls are wrapped in try/catch, so a
 *     shape-valid-but-corrupt update is dropped (and NOT broadcast) instead of
 *     crashing the process;
 *   - a genuinely valid update is still applied and still broadcast to peers
 *     (the guards don't over-reject).
 *
 * This drives the real handlers directly through a fake socket (no network),
 * asserting that NONE of a battery of malformed messages throws out of the
 * handler, and that a valid update round-trips normally.
 *
 * Run:  node tests/yjs-malformed-message.test.mjs
 * Preconditions: cd jacarium-central && npm ci   (yjs available there)
 * Exit code 0 = all checks passed, 1 = failure.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SERVER_DIR = path.join(REPO, 'jacarium-central');

if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) {
  console.error('jacarium-central dependencies missing. Run: cd jacarium-central && npm ci');
  process.exit(1);
}

const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const Y = serverRequire('yjs');
const { setupYjsSync } = serverRequire(path.join(SERVER_DIR, 'yjs-sync.js'));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

// Minimal fake Socket.io socket + io that record what the handlers do.
class FakeSocket {
  constructor() {
    this.handlers = {};
    this.rooms = new Set();
    this.directEmits = [];
    this.broadcasts = [];
  }
  on(ev, fn) { this.handlers[ev] = fn; }
  join(room) { this.rooms.add(room); }
  emit(ev, payload) { this.directEmits.push([ev, payload]); }
  to(room) {
    return { emit: (ev, payload) => this.broadcasts.push([room, ev, payload]) };
  }
  fire(ev, payload) { if (this.handlers[ev]) this.handlers[ev](payload); }
}
const fakeIo = { sockets: { adapter: { rooms: new Map() } }, to: () => ({ emit: () => {} }) };

const socket = new FakeSocket();
setupYjsSync(fakeIo, socket, 'malformed-test-machine');

function firesWithoutThrowing(name, ev, payload) {
  let threw = null;
  try {
    socket.fire(ev, payload);
  } catch (err) {
    threw = err;
  }
  check(`no crash: ${name}`, threw === null, threw ? threw.message : '');
}

// --- yjs-sync-step1: malformed shapes and undecodable/garbage state vectors ---
firesWithoutThrowing('step1 empty object', 'yjs-sync-step1', {});
firesWithoutThrowing('step1 null payload', 'yjs-sync-step1', null);
firesWithoutThrowing('step1 undefined payload', 'yjs-sync-step1', undefined);
firesWithoutThrowing('step1 stateVector wrong type (number)', 'yjs-sync-step1', { documentId: 'd1', stateVector: 42 });
firesWithoutThrowing('step1 stateVector missing', 'yjs-sync-step1', { documentId: 'd1' });
firesWithoutThrowing('step1 documentId wrong type', 'yjs-sync-step1', { documentId: 7, stateVector: 'AAA=' });
firesWithoutThrowing('step1 garbage-but-valid base64 state vector', 'yjs-sync-step1',
  { documentId: 'd1', stateVector: Buffer.from([1, 2, 3, 4, 255, 254, 253]).toString('base64') });

// --- yjs-update: malformed shapes and shape-valid-but-corrupt updates ---
firesWithoutThrowing('update empty object', 'yjs-update', {});
firesWithoutThrowing('update null payload', 'yjs-update', null);
firesWithoutThrowing('update wrong type (object)', 'yjs-update', { documentId: 'd2', update: {} });
firesWithoutThrowing('update missing update field', 'yjs-update', { documentId: 'd2' });
firesWithoutThrowing('update empty string', 'yjs-update', { documentId: 'd2', update: '' });
firesWithoutThrowing('update valid-base64 but corrupt Yjs bytes', 'yjs-update',
  { documentId: 'd2', update: Buffer.from([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]).toString('base64') });

// --- a genuinely valid update must still apply AND broadcast (no over-rejection) ---
const doc = new Y.Doc();
doc.getText('content').insert(0, 'hello world');
const validUpdateB64 = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
socket.broadcasts.length = 0;
let validThrew = null;
try {
  socket.fire('yjs-update', { documentId: 'valid-doc', update: validUpdateB64 });
} catch (err) {
  validThrew = err;
}
check('valid update does not throw', validThrew === null, validThrew ? validThrew.message : '');
const broadcasted = socket.broadcasts.some(
  ([room, ev]) => room === 'valid-doc' && ev === 'yjs-update');
check('valid update is broadcast to peers', broadcasted);

console.log();
if (failures === 0) {
  console.log('RESULT: all checks passed - no malformed message crashes the handler; valid update still works');
  process.exit(0);
}
console.log(`RESULT: ${failures} check(s) FAILED`);
process.exit(1);
