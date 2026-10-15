/**
 * Guards the jacarium-central side of "one identity per account":
 *
 *   1. one identity connected from two devices at once: both sockets
 *      authenticate, both receive a teammate's upload, the connected-users
 *      list names the identity once, and when one device leaves the other
 *      still receives (state.js ClientLink);
 *   2. POST /api/reown: a device's old identity hands its items to the new
 *      one - proof of BOTH secrets required (wrong old secret -> 403
 *      OLD_SECRET_INVALID, same id -> 400); queued messages for an offline
 *      machine come out under the new owner, the Yjs document index moves,
 *      permissions granted by the old id move, every connected client is
 *      told (`identity-renamed`), sockets of the old identity are cut;
 *   3. the old identity is retired: its secret no longer authenticates and
 *      it cannot register again (403 MACHINE_ID_RETIRED); the new identity
 *      can delete the moved document.
 *
 * Runs a REAL server (random port, temp DATA_DIR, synthetic data).
 * Preconditions: cd jacarium-central && npm ci; npm install (socket.io-client).
 * Run: node tests/central-identity-reown.test.mjs
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
if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) { console.error('jacarium-central dependencies missing. Run: cd jacarium-central && npm ci'); process.exit(1); }
const repoRequire = createRequire(path.join(REPO, 'package.json'));
const { io: ioClient } = repoRequire('socket.io-client');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reown-test-'));
const server = spawn('node', ['server.js'], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, YJS_STORAGE_ENCRYPTION_KEY: '00'.repeat(32) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not yet */ } if (!up) await sleep(100); }
if (!up) { console.error('server did not start:\n' + serverLog); server.kill(); process.exit(1); }
const stop = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } fs.rmSync(dataDir, { recursive: true, force: true }); };

const register = async (id) => (await (await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machine_id: id }) })).json());
const api = (id, secret) => ({
  post: (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Secret': secret }, body: JSON.stringify({ machine_id: id, ...body }) }),
  del: (p) => fetch(`${base}${p}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Client-Secret': secret }, body: JSON.stringify({ machine_id: id }) }),
  get: (p) => fetch(`${base}${p}${p.includes('?') ? '&' : '?'}machine_id=${encodeURIComponent(id)}`, { headers: { 'X-Client-Secret': secret } }),
});
function connect(id, secret, name) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { transports: ['websocket'], reconnection: false });
    const events = [];
    s.onAny((event, payload) => events.push({ event, payload }));
    s.on('connect', () => s.emit('authenticate', { machine_id: id, client_secret: secret, display_name: name }));
    s.on('authenticated', (d) => (d.success ? resolve({ socket: s, events }) : reject(new Error(d.error))));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('authenticate timeout')), 5000);
  });
}
const waitFor = async (events, event, pred = () => true, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = events.find((e) => e.event === event && pred(e.payload)); if (hit) return hit.payload; await sleep(30); } return null; };

const OLD = 'browser-0a1b2c3d@console';
const NEW = 'alice@account-0123456789ab';
const PEER = 'bob@peer-host';
const OFFLINE = 'carol@offline-laptop';
try {
  const oldReg = await register(OLD); const newReg = await register(NEW); const peerReg = await register(PEER); const offReg = await register(OFFLINE);
  check('four identities registered', [oldReg, newReg, peerReg, offReg].every((r) => r.secret));
  const oldApi = api(OLD, oldReg.secret); const newApi = api(NEW, newReg.secret); const peerApi = api(PEER, peerReg.secret); const offApi = api(OFFLINE, offReg.secret);

  // ---- 1: one identity, two devices ----
  const devA = await connect(NEW, newReg.secret, 'Alice');
  const devB = await connect(NEW, newReg.secret, 'Alice');
  const peer = await connect(PEER, peerReg.secret, 'Bob');
  const users = await waitFor(peer.events, 'connected-users', (p) => p.users.includes(NEW));
  check('1. both devices of the identity authenticated; the connected-users list names it once', users && users.users.filter((u) => u === NEW).length === 1 && users.names?.[NEW] === 'Alice', JSON.stringify(users));
  peer.socket.emit('upload-document', { document: { title: 'From Bob', content: 'hello', ownerId: PEER, cloudDocumentId: 'doc-bob-1' } });
  check('1. a teammate uploads a document over its socket', !!(await waitFor(peer.events, 'upload-success')));
  const gotA = await waitFor(devA.events, 'documents-update', (p) => p.documents?.[0]?.title === 'From Bob');
  const gotB = await waitFor(devB.events, 'documents-update', (p) => p.documents?.[0]?.title === 'From Bob');
  check('1. BOTH devices of the identity receive it', !!gotA && !!gotB);
  devB.socket.disconnect();
  await sleep(300);
  peer.socket.emit('upload-document', { document: { title: 'From Bob 2', content: 'again', ownerId: PEER, cloudDocumentId: 'doc-bob-2' } });
  check('1. ...another upload after one device left', !!(await waitFor(peer.events, 'upload-success', (p) => p.message_id !== 1)));
  check('1. the remaining device still receives (the identity stayed connected)', !!(await waitFor(devA.events, 'documents-update', (p) => p.documents?.[0]?.title === 'From Bob 2')));
  const still = await waitFor(peer.events, 'connected-users', (p) => p.users.includes(NEW) && p.users.includes(PEER));
  check('1. ...and is still listed', !!still);

  // ---- 2: re-own ----
  // the offline machine is known (it polled once) and then stays away: uploads queue for it
  const poll0 = await offApi.get('/api/pending'); check('2. the offline machine polled once (now known to the server)', poll0.ok);
  const oldSock = await connect(OLD, oldReg.secret, 'old browser');
  const up1 = await oldApi.post('/api/documents', { document: { title: 'Runbook', content: 'owned by the old browser', ownerId: OLD, cloudDocumentId: 'doc-old-1', permissions: { [PEER]: 'write' } } });
  const up2 = await oldApi.post('/api/workflows', { workflow: { title: 'Old workflow', ownerId: OLD, steps: [] } });
  check('2. the old identity shares a document (granting Bob write) and a workflow', up1.ok && up2.ok, `${up1.status} ${up2.status}`);
  // a document shared BY the peer WITH the old identity: its permission entry must follow too
  const up3 = await peerApi.post('/api/documents', { document: { title: 'Shared with old', content: 'x', ownerId: PEER, cloudDocumentId: 'doc-bob-3', permissions: { [OLD]: 'read' } } });
  check('2. Bob shares a document with the old identity', up3.ok);

  let r = await newApi.post('/api/reown', { old_machine_id: OLD, old_client_secret: 'wrong' });
  check('2. a wrong old secret is refused (403 OLD_SECRET_INVALID)', r.status === 403 && (await r.json()).code === 'OLD_SECRET_INVALID');
  r = await newApi.post('/api/reown', { old_machine_id: NEW, old_client_secret: newReg.secret });
  check('2. the same identity twice is refused (400)', r.status === 400);
  r = await newApi.post('/api/reown', { old_machine_id: OLD, old_client_secret: 'x' });
  check('2. the NEW identity\'s own secret is required too (a bad X-Client-Secret is 403)', (await fetch(`${base}/api/reown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Secret': 'nope' }, body: JSON.stringify({ machine_id: NEW, old_machine_id: OLD, old_client_secret: oldReg.secret }) })).status === 403);
  r = await newApi.post('/api/reown', { old_machine_id: OLD, old_client_secret: oldReg.secret, documents: ['Runbook'] });
  const reown = await r.json();
  check('2. re-own with both secrets succeeds and reports what moved', r.ok && reown.success && reown.from === OLD && reown.to === NEW && reown.queued >= 3 && reown.documentsRemapped === 1, JSON.stringify(reown));
  const renamed = await waitFor(peer.events, 'identity-renamed', (p) => p.from === OLD && p.to === NEW);
  check('2. every connected client is told (identity-renamed)', !!renamed && !!(await waitFor(devA.events, 'identity-renamed')));
  await sleep(300);
  check('2. the old identity\'s socket was cut', oldSock.socket.connected === false);
  const pending = await (await offApi.get('/api/pending')).json();
  const queuedDoc = (pending.documents || []).find((d) => d.title === 'Runbook');
  const queuedWf = (pending.workflows || []).find((w) => w.title === 'Old workflow');
  const queuedShared = (pending.documents || []).find((d) => d.title === 'Shared with old');
  check('2. the offline machine receives the queued document under the NEW owner, Bob\'s permission kept', queuedDoc?.ownerId === NEW && queuedDoc.permissions?.[PEER] === 'write', JSON.stringify(queuedDoc)?.slice(0, 200));
  check('2. ...and the queued workflow too', queuedWf?.ownerId === NEW, JSON.stringify(queuedWf));
  check('2. ...and Bob\'s document now names the NEW identity in its permissions', queuedShared?.permissions?.[NEW] === 'read' && !queuedShared.permissions[OLD], JSON.stringify(queuedShared?.permissions));
  const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'clients.json'), 'utf8'));
  check('2. the registry marks the old identity retired (secret gone, points at the new one)', registry[OLD]?.retiredTo === NEW && !registry[OLD].secretHash, JSON.stringify(registry[OLD]));

  // ---- 3: retired ----
  r = await oldApi.get('/api/pending');
  check('3. the old secret no longer authenticates', r.status === 401 || r.status === 403, String(r.status));
  let rejected = null;
  try { await connect(OLD, oldReg.secret, 'old'); } catch (e) { rejected = e; }
  check('3. ...nor over the socket', !!rejected);
  const reg = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machine_id: OLD }) });
  const regBody = await reg.json();
  check('3. the old identity cannot be registered again (403 MACHINE_ID_RETIRED, naming the new one)', reg.status === 403 && regBody.code === 'MACHINE_ID_RETIRED' && regBody.retired_to === NEW, JSON.stringify(regBody));
  r = await newApi.del(`/api/documents/${encodeURIComponent(NEW)}/${encodeURIComponent('Runbook')}`);
  check('3. the new identity can delete the moved document (owner now)', r.ok, await r.text());
  r = await peerApi.del(`/api/documents/${encodeURIComponent(NEW)}/${encodeURIComponent('Old workflow')}`);
  check('3. a teammate still cannot delete what is not theirs', r.status === 403);
  devA.socket.disconnect(); peer.socket.disconnect();
} catch (e) {
  check('the run completed', false, `${e.message}\n${e.stack}\n${serverLog.slice(-1500)}`);
} finally {
  stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
