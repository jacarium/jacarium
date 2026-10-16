/**
 * A linked desktop profile synchronises ONLY through its home-server link.
 *
 * The REAL Electron app (tests/helpers/electron-app.mjs, Playwright) on a
 * throwaway profile that is linked to a test home server: the real backend
 * in accounts mode behind an HTTPS front with a self-signed certificate (as
 * a home server behind Caddy's `tls internal` is), linked through
 * electron/home-server.cjs so the device token and the certificate pin are
 * in the profile before the app starts. Every request the renderer makes is
 * recorded (Playwright sees them all), as is every request that reaches the
 * home server.
 *
 * What this test proves:
 *   - the renderer sends NO /api/sync/* request to the app's local backend
 *     (its own requests to that backend are seen, so the record is live) and
 *     none to the home server directly;
 *   - the pull reaches the home server from the main process: with the
 *     device's bearer token and without a browser Origin, through the pinned
 *     certificate (the pin is the server's root, the link status says so);
 *   - the connection indicator reports the home server as connected;
 *   - the "handshake failed ... net_error -202" line Chromium prints when
 *     the renderer itself reaches the home server (the central server's
 *     Socket.IO, for instance) is the first attempt against the OS trust
 *     store, which the app's certificate-error handler then overrides with
 *     the pin: the request succeeds and the line is harmless.
 *
 * Needs openssl, the backend venv and a GUI; skips (exit 0 with a SKIP
 * line) like the other Electron tests otherwise.
 * Run: node tests/desktop-linked-sync-transport.test.mjs
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launchElectronApp, sleep } from './helpers/electron-app.mjs';
import { reapOnExit } from './helpers/reap.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const homeServer = require('../electron/home-server.cjs');
const PYTHON = fs.existsSync(path.join(REPO, 'backend', 'venv', 'bin', 'python')) ? path.join(REPO, 'backend', 'venv', 'bin', 'python') : 'python3';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
if (process.env.SKIP_ELECTRON_TESTS) { console.log('SKIP: SKIP_ELECTRON_TESTS is set'); process.exit(0); }
if (spawnSync('openssl', ['version'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: openssl is not installed'); process.exit(0); }

// ---- the home server: the real backend (accounts) behind a self-signed HTTPS front ----
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-desktop-server-'));
const FLASK_PORT = await freePort();
const TLS_PORT = await freePort();
// a self-signed certificate for 127.0.0.1 is its own root: the backend
// serves it at /api/tls/root.crt (~/tls/root.crt), so the link pins a root
fs.mkdirSync(path.join(DATA, 'tls'), { recursive: true });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  '-keyout', path.join(DATA, 'tls', 'key.pem'), '-out', path.join(DATA, 'tls', 'root.crt')], { stdio: 'ignore' });
const backend = reapOnExit(spawn(PYTHON, ['app.py'], {
  cwd: path.join(REPO, 'backend'),
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_'))), HOME: DATA, PORT: String(FLASK_PORT), JACARIUM_AUTH_MODE: 'accounts', JACARIUM_BEHIND_PROXY: '1', JACARIUM_REPORTS_ROOT: path.join(DATA, 'reports'), JACARIUM_KNOWN_HOSTS: path.join(DATA, '.ssh', 'known_hosts') },
  stdio: ['ignore', 'pipe', 'pipe'],
}));
let backendLog = '';
backend.stdout.on('data', (d) => { backendLog += d; });
backend.stderr.on('data', (d) => { backendLog += d; });
let up = false;
for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${FLASK_PORT}/health`)).ok; } catch { await sleep(250); } }
// every request that reaches the home server, with what tells a browser's
// request (Origin) from the main process's (a bearer token, no Origin)
const serverSeen = [];
const front = https.createServer({ key: fs.readFileSync(path.join(DATA, 'tls', 'key.pem')), cert: fs.readFileSync(path.join(DATA, 'tls', 'root.crt')) }, (req, res) => {
  serverSeen.push({ method: req.method, url: req.url, origin: req.headers.origin || null, bearer: /^Bearer /.test(req.headers.authorization || ''), cookie: !!req.headers.cookie });
  const upstream = http.request({ host: '127.0.0.1', port: FLASK_PORT, method: req.method, path: req.url, headers: req.headers }, (up2) => { res.writeHead(up2.statusCode, up2.headers); up2.pipe(res); });
  upstream.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
await new Promise((resolve) => front.listen(TLS_PORT, '127.0.0.1', resolve));
const HOME = `https://127.0.0.1:${TLS_PORT}`;
const stopServer = () => { try { backend.kill('SIGTERM'); } catch { /* gone */ } front.close(); fs.rmSync(DATA, { recursive: true, force: true }); };
if (!up) { console.log('FAIL: the backend did not start\n' + backendLog.slice(-1200)); stopServer(); process.exit(1); }

// ---- the account, and the profile linked to it (what Settings > General does) ----
const CSRF = { 'X-Requested-With': 'Jacarium', 'Content-Type': 'application/json' };
const setupCode = fs.readFileSync(path.join(DATA, 'setup-code'), 'utf8').trim();
const setup = await fetch(`http://127.0.0.1:${FLASK_PORT}/api/auth/setup`, { method: 'POST', headers: CSRF, body: JSON.stringify({ setupCode, username: 'alice', password: 'alices password' }) });
if (setup.status !== 201) { console.log(`FAIL: the account was not created (${setup.status})`); stopServer(); process.exit(1); }
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-desktop-profile-'));
const storePath = path.join(userDataDir, homeServer.STORE_FILE);
const pinsPath = path.join(userDataDir, 'central-server-cert-pins.json');
// (no keychain here: the token is stored in the clear, which the app reads as is)
const noKeychain = { isEncryptionAvailable: () => false };
let linked = null;
try {
  linked = await homeServer.linkHomeServer({ url: HOME, username: 'alice', password: 'alices password', deviceName: 'test desktop', storePath, pinsPath, safeStorage: noKeychain });
} catch (error) {
  console.log(`FAIL: linking the profile failed: ${error.message}`); stopServer(); process.exit(1);
}
check('the profile is linked over HTTPS with the served root pinned', linked.username === 'alice' && homeServer.homeServerStatus({ storePath, pinsPath, safeStorage: noKeychain }).tls?.pin === 'root', JSON.stringify(homeServer.homeServerStatus({ storePath, pinsPath, safeStorage: noKeychain }).tls));
serverSeen.length = 0;

// ---- the app on that profile ----
const launched = await launchElectronApp({ profilePrefix: 'linked-desktop-', userDataDir, env: { PORT: '' } });
if (launched.skip) { console.log('SKIP: ' + launched.skip); stopServer(); process.exit(0); }
const rendererSeen = [];
let electronStderr = '';
try {
  const { page, app } = launched;
  try { app.process().stderr.on('data', (d) => { electronStderr += d; }); } catch { /* not available: the -202 check is skipped below */ }
  page.on('request', (r) => rendererSeen.push({ method: r.method(), url: r.url() }));
  const appPath = await page.evaluate(() => window.electronAPI.getAppPath());
  check('the window runs on the throwaway profile', path.resolve(appPath) === path.resolve(userDataDir), appPath);
  const localPort = await page.evaluate(() => window.electronAPI.getBackendPort());
  const LOCAL = `http://localhost:${localPort}`;
  const status = await page.evaluate(() => window.electronAPI.homeServerStatus());
  check('the app sees the link (alice, root pin)', status?.linked && status.username === 'alice' && status.tls?.pin === 'root', JSON.stringify(status));

  // the engine's first cycle (the version gate, the pull, then /api/auth/me) and a bit more
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !serverSeen.some((r) => /^\/api\/sync\/pull/.test(r.url))) await sleep(250);
  await sleep(3000);

  const pulls = serverSeen.filter((r) => /^\/api\/sync\/pull/.test(r.url));
  check('the home server received the pull - with the device token, without a browser Origin (the main process, not the renderer)', pulls.length > 0 && pulls.every((r) => r.bearer && !r.origin && !r.cookie), JSON.stringify(pulls.slice(0, 2)));
  check('the pull went through the pinned certificate and was answered (the backend logged it 200)', /GET \/api\/sync\/pull[^\n]*" 200/.test(backendLog), backendLog.split('\n').filter((l) => /api\/sync/.test(l)).slice(-2).join(' | '));
  // (the record is live for the local backend too: a request to it from the
  // page is seen - the app's own ones at start-up happened before the window
  // was handed over)
  await page.evaluate((url) => fetch(`${url}/health`).catch(() => null), LOCAL);
  const toLocal = rendererSeen.filter((r) => r.url.startsWith(LOCAL));
  check('a renderer request to the local backend is recorded (so the record below is live)', toLocal.some((r) => r.url === `${LOCAL}/health`), `${toLocal.length} request(s), e.g. ${toLocal[0]?.url}`);
  const strayLocal = toLocal.filter((r) => /\/api\/sync\//.test(r.url));
  check('...but never for /api/sync/* (no stray pull at the local backend)', strayLocal.length === 0, JSON.stringify(strayLocal.slice(0, 3)));
  const strayAny = rendererSeen.filter((r) => /\/api\/sync\//.test(r.url));
  check('no /api/sync/* request leaves the renderer at all (the engine runs on the home-server transport)', strayAny.length === 0, JSON.stringify(strayAny.slice(0, 3)));
  check('the renderer never reaches the home server directly on its own', !rendererSeen.some((r) => r.url.startsWith(HOME)), JSON.stringify(rendererSeen.filter((r) => r.url.startsWith(HOME)).slice(0, 3)));
  let indicator = null;
  for (let i = 0; i < 40 && !/^Connected to your home server/.test(indicator?.title || ''); i++) {
    indicator = await page.evaluate(() => { const el = document.querySelector('[data-testid="connection-indicator"]'); return el ? { state: el.getAttribute('data-state'), title: el.getAttribute('title') } : null; });
    if (!/^Connected/.test(indicator?.title || '')) await sleep(250);
  }
  check('the connection indicator reports the home server as connected', indicator?.state === 'online', JSON.stringify(indicator));

  // ---- the -202 line: Chromium's first attempt, overridden by the pin ----
  // The renderer itself reaching the home server (as the central server's
  // Socket.IO does) goes through Chromium's network stack, which does not
  // know the server's private root: it logs "handshake failed ... net_error
  // -202" (ERR_CERT_AUTHORITY_INVALID), asks the app, and the app's
  // certificate-error handler accepts the pinned certificate - the request
  // then succeeds. The line is the trace of that first attempt, nothing more.
  const direct = await page.evaluate((url) => fetch(`${url}/api/version`).then((r) => r.status).catch((e) => `error: ${e.message}`), HOME);
  check('a renderer request to the home server succeeds through the pinned certificate', direct === 200, String(direct));
  await sleep(1000);
  if (electronStderr) {
    check('...and Chromium logged its own refused first attempt (handshake failed, net_error -202) - the harmless line seen in the app log', /net_error -202/.test(electronStderr), electronStderr.split('\n').filter((l) => /handshake failed/.test(l)).slice(0, 2).join(' | ') || electronStderr.slice(-300));
  } else {
    console.log('SKIP: the Electron stderr was not captured here - the -202 line is not checked');
  }
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  await launched.close();
  stopServer();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
