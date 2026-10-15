/**
 * Guards two jacarium-central hardening changes:
 *
 * 1. GET /api/games required no authentication and returned every lobby's
 *    full quiz question data (answers included) and generated grid board.
 *    It now sits behind requireClientAuth like every other sync route; the
 *    only caller (src/utils/cloudWebSocket.js fetchAvailableGames, in the
 *    desktop app) sends machine_id + X-Client-Secret. The browser game pages
 *    join by direct link and never call it.
 *
 * 2. CORS_ORIGIN defaulted to '*'. With no configuration, any web page in
 *    any browser could issue cross-origin requests against the server. The
 *    default is now "desktop-app origins only" (jacarium-central/
 *    cors-policy.js): no Origin header (non-browser clients), `null` /
 *    `file://` (packaged Electron renderer), and http(s)://localhost|127.0.0.1
 *    (Vite dev server). The browser game pages are served by this same
 *    server and are same-origin, so CORS never applied to them. An explicit
 *    CORS_ORIGIN keeps the old behaviour verbatim ('*', one origin, or a
 *    comma-separated list).
 *
 * What this test proves:
 *   Part A (cors-policy.js in-process): the exact origin classification.
 *   Part B (REAL spawned server, no CORS_ORIGIN):
 *     - /api/games: 401 without a secret, 403 with a wrong one, 200 with
 *       valid pairing auth;
 *     - CORS: a foreign Origin gets NO Access-Control-Allow-Origin (on a
 *       plain request, a preflight, and the Socket.IO handshake); `null`,
 *       `file://` and localhost dev origins are reflected; a request with no
 *       Origin still works;
 *     - a real socket.io-client (no Origin header) still authenticates.
 *   Part C (REAL spawned server, CORS_ORIGIN='*'): the foreign Origin gets
 *     '*' - explicit configuration is honored unchanged.
 *
 * Run:  node tests/central-games-auth-and-cors.test.mjs
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
const { isDesktopAppOrigin, buildCorsOrigin } = serverRequire('./cors-policy');
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

async function spawnServer(extraEnv) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'games-cors-test-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir };
  delete env.CORS_ORIGIN;
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
  if (!up) {
    console.error('server did not start:\n' + log);
    proc.kill('SIGKILL');
    process.exit(1);
  }
  return { proc, base, dataDir, getLog: () => log };
}

const acao = (res) => res.headers.get('access-control-allow-origin');

// ================= Part A: policy unit checks =================
console.log('--- Part A: cors-policy.js');
check('no Origin header allowed', isDesktopAppOrigin(undefined) && isDesktopAppOrigin(''));
check('"null" (packaged Electron fetch) allowed', isDesktopAppOrigin('null'));
check('"file://" (packaged Electron WebSocket) allowed', isDesktopAppOrigin('file://'));
check('http://localhost:5173 (Vite dev) allowed', isDesktopAppOrigin('http://localhost:5173'));
check('http://127.0.0.1:5173 allowed', isDesktopAppOrigin('http://127.0.0.1:5173'));
check('http://[::1]:5173 allowed', isDesktopAppOrigin('http://[::1]:5173'));
check('https://localhost allowed', isDesktopAppOrigin('https://localhost'));
check('foreign https origin denied', !isDesktopAppOrigin('https://evil.example'));
check('foreign http origin denied', !isDesktopAppOrigin('http://sync.example.test:3000'));
check('lookalike host denied', !isDesktopAppOrigin('http://localhost.evil.example'));
check('non-http scheme denied', !isDesktopAppOrigin('chrome-extension://abc'));
check('garbage denied', !isDesktopAppOrigin('not an origin'));
let built = buildCorsOrigin(undefined);
check('unset -> function policy, configured=false', typeof built.origin === 'function' && built.configured === false);
built = buildCorsOrigin('*');
check("'*' -> '*' verbatim, configured=true", built.origin === '*' && built.configured === true);
// A configured list is ADDED to the desktop-app origins (a team with desktop
// and browser users), compared case-insensitively and without a trailing slash.
const allows = (policy, origin) => new Promise((resolve) => policy.origin(origin, (err, ok) => resolve(!err && !!ok)));
built = buildCorsOrigin('https://a.example');
check('single origin -> policy function, configured=true', typeof built.origin === 'function' && built.configured === true && built.list.length === 1);
check('single origin: the listed origin allowed', await allows(built, 'https://a.example'));
check('single origin: desktop origins still allowed', await allows(built, 'null') && await allows(built, 'file://') && await allows(built, 'http://localhost:5173'));
check('single origin: another origin denied', !(await allows(built, 'https://b.example')));
built = buildCorsOrigin(' https://a.example, https://b.example:8443/ ');
check('comma list -> both allowed, slash and case ignored', built.list.length === 2 && await allows(built, 'https://a.example') && await allows(built, 'HTTPS://b.example:8443'));
check('comma list: foreign denied', !(await allows(built, 'https://c.example')));
check("list containing '*' -> '*'", buildCorsOrigin('https://a.example,*').origin === '*');
built = buildCorsOrigin('   ');
check('whitespace-only -> treated as unset', typeof built.origin === 'function' && built.configured === false);

// ================= Part B: real server, default CORS =================
console.log('--- Part B: spawned server, CORS_ORIGIN unset');
const s1 = await spawnServer({});
let sock = null;
try {
  check('startup log announces the safe default', /CORS_ORIGIN not set/.test(s1.getLog()));

  // --- /api/games auth ---
  const reg = await fetch(`${s1.base}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machine_id: 'alice@test' })
  });
  const { secret } = await reg.json();

  let res = await fetch(`${s1.base}/api/games?playerId=alice@test`);
  check('/api/games without machine_id/secret -> 4xx', res.status === 400 || res.status === 401, `${res.status}`);
  res = await fetch(`${s1.base}/api/games?playerId=alice@test&machine_id=alice@test`);
  check('/api/games without secret -> 401', res.status === 401, `${res.status}`);
  res = await fetch(`${s1.base}/api/games?playerId=alice@test&machine_id=alice@test`, { headers: { 'X-Client-Secret': 'wrong' } });
  check('/api/games with wrong secret -> 403', res.status === 403, `${res.status}`);
  res = await fetch(`${s1.base}/api/games?playerId=alice@test&machine_id=alice@test`, { headers: { 'X-Client-Secret': secret } });
  const body = await res.json();
  check('/api/games with valid pairing auth -> 200 + games array', res.status === 200 && Array.isArray(body.games), `${res.status}`);

  // /api/stats (process memory/uptime + queue sizes) is gated the same way
  res = await fetch(`${s1.base}/api/stats`);
  check('/api/stats without auth -> 4xx', res.status === 400 || res.status === 401, `${res.status}`);
  res = await fetch(`${s1.base}/api/stats?machine_id=alice@test`, { headers: { 'X-Client-Secret': 'wrong' } });
  check('/api/stats with wrong secret -> 403', res.status === 403, `${res.status}`);
  res = await fetch(`${s1.base}/api/stats?machine_id=alice@test`, { headers: { 'X-Client-Secret': secret } });
  const stats = await res.json();
  check('/api/stats with valid pairing auth -> 200 with memory/uptime', res.status === 200 && typeof stats.uptime === 'number' && stats.memory && typeof stats.memory.rss === 'number', `${res.status}`);

  // --- CORS headers ---
  res = await fetch(`${s1.base}/api/health`, { headers: { Origin: 'https://evil.example' } });
  check('foreign Origin: no Access-Control-Allow-Origin', res.ok && acao(res) === null, `acao=${acao(res)}`);
  res = await fetch(`${s1.base}/api/register`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
  });
  check('foreign Origin preflight: no Access-Control-Allow-Origin', acao(res) === null, `status=${res.status} acao=${acao(res)}`);
  res = await fetch(`${s1.base}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://evil.example' } });
  check('foreign Origin Socket.IO handshake: no Access-Control-Allow-Origin', acao(res) === null, `status=${res.status} acao=${acao(res)}`);

  res = await fetch(`${s1.base}/api/health`, { headers: { Origin: 'null' } });
  check('Origin null (packaged Electron): reflected', acao(res) === 'null', `acao=${acao(res)}`);
  res = await fetch(`${s1.base}/api/health`, { headers: { Origin: 'file://' } });
  check('Origin file:// : reflected', acao(res) === 'file://', `acao=${acao(res)}`);
  res = await fetch(`${s1.base}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
  check('Origin http://localhost:5173 (dev): reflected', acao(res) === 'http://localhost:5173', `acao=${acao(res)}`);
  res = await fetch(`${s1.base}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'null' } });
  check('Origin null Socket.IO handshake: reflected', res.ok && acao(res) === 'null', `status=${res.status} acao=${acao(res)}`);
  res = await fetch(`${s1.base}/api/health`);
  check('no Origin (curl-style): still 200', res.status === 200);

  // --- real socket.io client (Node: no Origin header) still works ---
  sock = ioClient(s1.base, { transports: ['websocket'] });
  const authed = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 4000);
    sock.on('connect', () => sock.emit('authenticate', { machine_id: 'alice@test', client_secret: secret }));
    sock.on('authenticated', (d) => { clearTimeout(t); resolve(Boolean(d.success)); });
  });
  check('socket.io-client authenticates under the default policy', authed);
} catch (error) {
  check('unexpected error (part B)', false, error.stack || String(error));
} finally {
  if (sock) sock.close();
  s1.proc.kill('SIGTERM');
  await sleep(200);
  fs.rmSync(s1.dataDir, { recursive: true, force: true });
}

// ================= Part C: explicit CORS_ORIGIN='*' =================
console.log("--- Part C: spawned server, CORS_ORIGIN='*'");
const s2 = await spawnServer({ CORS_ORIGIN: '*' });
try {
  check('startup log does not warn when configured', !/CORS_ORIGIN not set/.test(s2.getLog()));
  const res = await fetch(`${s2.base}/api/health`, { headers: { Origin: 'https://evil.example' } });
  check("explicit '*' still allows any origin", acao(res) === '*', `acao=${acao(res)}`);
  const sio = await fetch(`${s2.base}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://evil.example' } });
  check("explicit '*' applies to Socket.IO too", acao(sio) === '*', `acao=${acao(sio)}`);
} catch (error) {
  check('unexpected error (part C)', false, error.stack || String(error));
} finally {
  s2.proc.kill('SIGTERM');
  await sleep(200);
  fs.rmSync(s2.dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
