/**
 * Guards the optional enrollment gate on jacarium-central registration
 * (ENROLLMENT_SECRET; jacarium-central/client-registry.js + api-routes.js)
 * and the per-IP registration rate limit.
 *
 * THE HOLE (audit H4): POST /api/register issued a fresh per-machine secret
 * to ANY previously-unseen machine_id with no gate at all, so anyone who
 * could reach the server could enroll a device and receive every synced
 * document, workflow and board.
 *
 * THE FIX: when the server is started with ENROLLMENT_SECRET, the
 * "unseen machine_id" branch requires the same value in the
 * X-Enrollment-Secret header (constant-time compare) before a per-machine
 * secret is minted; the response tells the user to enter the enrollment
 * secret (a dormant path since 3.2: the app itself uses account tickets;
 * the Node clients of the tests and a development server still pair this
 * way). Already-paired devices are untouched (they keep
 * authenticating with their per-machine secret and never need the
 * enrollment secret again, so rotating it does not lock them out). With
 * ENROLLMENT_SECRET unset, enrollment stays open exactly as before and the
 * server logs a warning at startup. Every attempt is logged with IP +
 * machine_id and capped per IP (429 + Retry-After).
 *
 * What this test proves against REAL spawned servers:
 *   Part A (no secret): open enrollment works unchanged; the startup log
 *     carries the OPEN warning; an already-registered id still gets the
 *     idempotent 200 with its secret, 403 without.
 *   Part B (secret set, plain HTTP): startup log shows "gated" plus the
 *     cleartext warning; missing / wrong / empty / prefix / suffix secrets
 *     -> 403 with the code
 *     ENROLLMENT_SECRET_REQUIRED, and NO per-machine secret is minted (the
 *     id stays unknown to every authenticated route); the correct secret
 *     -> 200 + secret; that device then authenticates over REST and
 *     Socket.IO WITHOUT the enrollment secret; the same id re-registering
 *     with its own per-machine secret needs no enrollment secret either.
 *   Part C (rate limit, REGISTRATION_RATE_LIMIT=4): the 5th attempt from
 *     one IP is 429 with Retry-After, even with a correct secret; the
 *     in-process limiter resets after its window.
 *
 * Run:  node tests/central-enrollment-secret.test.mjs
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
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function spawnServer(extraEnv) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-test-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir };
  delete env.ENROLLMENT_SECRET;
  delete env.REGISTRATION_RATE_LIMIT;
  Object.assign(env, extraEnv);
  const proc = spawn('node', ['server.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not yet */ }
    if (!up) await sleep(100);
  }
  if (!up) { console.error('server did not start:\n' + log); proc.kill('SIGKILL'); process.exit(1); }
  await sleep(150); // let the startup banner flush
  return {
    proc, base, dataDir, getLog: () => log,
    async stop() { proc.kill('SIGTERM'); await sleep(200); fs.rmSync(dataDir, { recursive: true, force: true }); }
  };
}

const register = (base, machineId, headers = {}) => fetch(`${base}/api/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ machine_id: machineId })
});

// ================= Part A: no ENROLLMENT_SECRET (open, unchanged) =================
console.log('--- Part A: ENROLLMENT_SECRET unset');
const a = await spawnServer({});
try {
  check('startup: enrollment OPEN warning logged', /Pairing: OPEN/.test(a.getLog()) && /no ACCOUNT_TICKET_KEY and no ENROLLMENT_SECRET/.test(a.getLog()));
  let res = await register(a.base, 'alice@open');
  let body = await res.json();
  check('open enrollment: new machine_id gets a secret (200)', res.status === 200 && typeof body.secret === 'string' && body.secret.length >= 32, `${res.status}`);
  const aliceSecret = body.secret;
  res = await register(a.base, 'alice@open', { 'X-Client-Secret': aliceSecret });
  body = await res.json();
  check('open enrollment: re-register with own secret -> idempotent 200, no new secret', res.status === 200 && body.registered === false && !body.secret, `${res.status}`);
  res = await register(a.base, 'alice@open');
  body = await res.json();
  check('open enrollment: re-register without secret -> 403 with pairing guidance', res.status === 403 && /already paired/.test(body.error) && body.code === 'MACHINE_ID_ALREADY_REGISTERED', `${res.status} ${body.error}`);
  res = await register(a.base, 'bob@open', { 'X-Enrollment-Secret': 'ignored-when-open' });
  check('open enrollment: a stray enrollment header is harmless', res.status === 200);
  check('attempts are logged with IP + machine_id', /Registration attempt from 127\.0\.0\.1 for machine_id "alice@open"/.test(a.getLog()));
} catch (error) {
  check('unexpected error (part A)', false, error.stack || String(error));
} finally {
  await a.stop();
}

// ================= Part B: ENROLLMENT_SECRET set =================
console.log('--- Part B: ENROLLMENT_SECRET set');
const SECRET = 'team-enrollment-secret-for-tests-only';
const b = await spawnServer({ ENROLLMENT_SECRET: SECRET });
let sock = null;
try {
  check('startup: enrollment gated', /Pairing: gated/.test(b.getLog()));
  check('startup: cleartext warning when USE_HTTPS is false', /cross the network in cleartext/.test(b.getLog()));
  check('startup: no OPEN warning', !/ENROLLMENT_SECRET is not set/.test(b.getLog()));

  const rejected = async (label, headers) => {
    const res = await register(b.base, 'carol@gated', headers);
    const body = await res.json();
    check(`gated: ${label} -> 403 with the code`,
      res.status === 403 && body.code === 'ENROLLMENT_SECRET_REQUIRED' && /[Ee]nrollment secret/.test(body.error) && !body.secret, `${res.status} ${body.error}`);
  };
  await rejected('no enrollment header', {});
  await rejected('wrong secret', { 'X-Enrollment-Secret': 'nope' });
  await rejected('empty secret', { 'X-Enrollment-Secret': '' });
  await rejected('secret prefix', { 'X-Enrollment-Secret': SECRET.slice(0, -1) });
  await rejected('secret + suffix', { 'X-Enrollment-Secret': SECRET + 'x' });
  await rejected('secret in body instead of header', { 'X-Client-Secret': SECRET });

  // Nothing was minted for carol: authenticated routes must still not know her
  let res = await fetch(`${b.base}/api/pending?machine_id=carol@gated`, { headers: { 'X-Client-Secret': 'anything' } });
  check('gated: rejected id was never registered (pending -> 401 unknown machine_id)', res.status === 401, `${res.status}`);
  check('gated: rejection logged with reason', /Enrollment rejected for new machine_id "carol@gated" from 127\.0\.0\.1: (missing|wrong)/.test(b.getLog()));

  res = await register(b.base, 'carol@gated', { 'X-Enrollment-Secret': SECRET });
  let body = await res.json();
  check('gated: correct secret -> 200 + per-machine secret', res.status === 200 && body.registered === true && typeof body.secret === 'string', `${res.status}`);
  const carolSecret = body.secret;

  res = await fetch(`${b.base}/api/pending?machine_id=carol@gated`, { headers: { 'X-Client-Secret': carolSecret } });
  check('paired device uses ONLY its per-machine secret on REST (no enrollment header)', res.status === 200, `${res.status}`);
  sock = ioClient(b.base, { transports: ['websocket'] });
  const authed = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 4000);
    sock.on('connect', () => sock.emit('authenticate', { machine_id: 'carol@gated', client_secret: carolSecret }));
    sock.on('authenticated', (d) => { clearTimeout(t); resolve(Boolean(d.success)); });
  });
  check('paired device authenticates over Socket.IO without the enrollment secret', authed);

  res = await register(b.base, 'carol@gated', { 'X-Client-Secret': carolSecret });
  body = await res.json();
  check('gated: known id re-registering with its own secret needs no enrollment secret (idempotent 200)', res.status === 200 && body.registered === false, `${res.status}`);
  res = await register(b.base, 'carol@gated');
  body = await res.json();
  check('gated: known id without any secret -> 403 pairing message (not enrollment message)', res.status === 403 && body.code === 'MACHINE_ID_ALREADY_REGISTERED', `${res.status}`);
} catch (error) {
  check('unexpected error (part B)', false, error.stack || String(error));
} finally {
  if (sock) sock.close();
  await b.stop();
}

// ================= Part C: rate limit =================
console.log('--- Part C: registration rate limit');
const c = await spawnServer({ ENROLLMENT_SECRET: SECRET, REGISTRATION_RATE_LIMIT: '4' });
try {
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await register(c.base, `guess${i}@rl`, { 'X-Enrollment-Secret': 'wrong' })).status);
  }
  check('first 4 attempts are evaluated normally (403 wrong secret)', statuses.every((s) => s === 403), statuses.join(','));
  let res = await register(c.base, 'legit@rl', { 'X-Enrollment-Secret': SECRET });
  const body = await res.json();
  check('5th attempt from the same IP -> 429 even with the correct secret', res.status === 429 && /Too many registration attempts/.test(body.error), `${res.status}`);
  check('429 carries Retry-After', Number(res.headers.get('retry-after')) > 0, res.headers.get('retry-after'));
  check('rate limit hit is logged', /rate limit exceeded for 127\.0\.0\.1/.test(c.getLog()));
  res = await fetch(`${c.base}/api/health`);
  check('other endpoints unaffected by the limiter', res.status === 200);
} catch (error) {
  check('unexpected error (part C)', false, error.stack || String(error));
} finally {
  await c.stop();
}

// In-process: window reset + constant-time verify helper
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
process.env.ENROLLMENT_SECRET = SECRET;
process.env.REGISTRATION_RATE_LIMIT = '2';
process.env.REGISTRATION_RATE_WINDOW_MS = '1000';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-unit-'));
const reg = serverRequire('./client-registry');
check('verifyEnrollmentSecret: exact match', reg.verifyEnrollmentSecret(SECRET) === true);
check('verifyEnrollmentSecret: mismatch / empty / non-string', !reg.verifyEnrollmentSecret('x') && !reg.verifyEnrollmentSecret('') && !reg.verifyEnrollmentSecret(null) && !reg.verifyEnrollmentSecret(undefined));
check('isEnrollmentGated true when configured', reg.isEnrollmentGated() === true);
const t0 = 1_000_000;
check('rate limit: within budget', reg.checkRegistrationRateLimit('10.9.9.9', t0).allowed && reg.checkRegistrationRateLimit('10.9.9.9', t0 + 1).allowed);
check('rate limit: over budget', reg.checkRegistrationRateLimit('10.9.9.9', t0 + 2).allowed === false);
check('rate limit: other IP unaffected', reg.checkRegistrationRateLimit('10.9.9.8', t0 + 2).allowed === true);
check('rate limit: window resets', reg.checkRegistrationRateLimit('10.9.9.9', t0 + 1001).allowed === true);
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
