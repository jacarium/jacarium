#!/usr/bin/env node
/**
 * The web game pages behind the console's /central prefix.
 *
 * Since 3.1 the share links of the games point at
 * `<home server>/central/{tiles,grid,quiz}/<id>`: the console's Caddy strips
 * `/central` and forwards to the central server, which serves the page from
 * jacarium-central/public. The pages used to reference `/socket.io/socket.io.js`
 * and `/tiles.js` by absolute root paths and connected Socket.IO at the default
 * `/socket.io` - behind the console those went to the console itself (404,
 * no `io`, no connection). The pages now reference their assets relative to
 * the page (`../tiles.js`) and connect Socket.IO at `<prefix>/socket.io`, the
 * prefix being what precedes `/tiles/` in the page's own path.
 *
 * What this test proves (a REAL spawned central server behind the console
 * stand-in of tests/helpers/central-proxy.mjs, the shape of deploy/Caddyfile):
 *   A. for each game page under /central: the page answers 200, every asset
 *      it references resolves under /central and answers 200 with the right
 *      type (socket.io's client bundle included), the page's script derives
 *      the Socket.IO path from the page's own path; the same pages work at
 *      the root when the central server runs alone (jacarium-central/run.sh);
 *      a trailing slash is redirected relatively (the prefix survives);
 *   B. a real Socket.IO client connects through `/central/socket.io` and the
 *      game handlers answer (an unknown lobby is rejected, a created lobby
 *      is joined); the default `/socket.io` path through the console is NOT
 *      the central server (what broke before);
 *   C. the app builds its share links as `${getCentralServerUrl()}/<game>/<id>`
 *      and getCentralServerUrl ends with the home server's /central;
 *   D. (real browser, when Chrome is found) the tiles page loaded from
 *      <console>/central/tiles/<id> has `io`, its socket is connected through
 *      /central/socket.io, and entering a name joins the lobby a host app
 *      created - the lobby screen lists both players.
 *
 * Run:  node tests/central-game-pages-prefix.test.mjs
 * Preconditions: cd jacarium-central && npm ci; npm install (socket.io-client).
 * Exit code 0 = all checks passed, 1 = a check failed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startConsoleProxy } from './helpers/central-proxy.mjs';
import { findChrome, sleep } from './helpers/live-documents-app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SERVER_DIR = path.join(REPO, 'jacarium-central');
if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) { console.error('jacarium-central dependencies missing. Run: cd jacarium-central && npm ci'); process.exit(1); }
const repoRequire = createRequire(path.join(REPO, 'package.json'));
const { io: ioClient } = repoRequire('socket.io-client');

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${String(detail).slice(0, 300)})` : ''}`); };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ---- a real central server, alone (no ticket key: the development shape) ----
const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'game-pages-'));
const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, HOST: '127.0.0.1' };
delete env.CORS_ORIGIN;
const server = spawn('node', ['server.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const CENTRAL = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${CENTRAL}/api/health`)).ok; } catch { /* not yet */ } if (!up) await sleep(100); }
if (!up) { console.error('the central server did not start:\n' + log); server.kill('SIGKILL'); process.exit(1); }
const proxy = await startConsoleProxy({ centralUrl: CENTRAL });   // no backend: everything outside /central is 404
const CONSOLE = proxy.url;

const GAMES = ['tiles', 'grid', 'quiz'];
const GAME_ID = 'synthetic-lobby-0001';
const scriptSrcs = (html) => Array.from(html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)).map((m) => m[1]);
const otherRefs = (html) => Array.from(html.matchAll(/<(?:link|img)[^>]*\s(?:href|src)="([^"]+)"/g)).map((m) => m[1]);

async function checkPage(base, prefix) {
  for (const game of GAMES) {
    const pageUrl = `${base}${prefix}/${game}/${GAME_ID}`;
    const res = await fetch(pageUrl);
    const html = await res.text();
    const where = prefix ? `under ${prefix}` : 'at the root';
    check(`${game} page ${where}: 200 text/html`, res.status === 200 && /text\/html/.test(res.headers.get('content-type') || ''), `${res.status} ${res.headers.get('content-type')}`);
    const refs = [...scriptSrcs(html), ...otherRefs(html)];
    check(`${game} page ${where}: references its script and socket.io's by relative URLs only`, refs.length >= 2 && refs.every((r) => !r.startsWith('/') && !/^https?:/.test(r)) && refs.some((r) => /socket\.io\.js$/.test(r)) && refs.some((r) => r.endsWith(`${game}.js`)), refs.join(' '));
    for (const ref of refs) {
      const url = new URL(ref, pageUrl);
      const inPrefix = prefix ? url.pathname.startsWith(`${prefix}/`) : true;
      const r = await fetch(url);
      const body = await r.text();
      const type = r.headers.get('content-type') || '';
      const isJs = /javascript/.test(type) && body.length > 1000;
      const realBundle = /socket\.io\.js$/.test(ref) ? /socket\.io|engine\.io/i.test(body.slice(0, 4000)) : body.includes('pagePrefix');
      check(`${game} page ${where}: ${ref} -> ${url.pathname} answers 200 as JavaScript (the real file)`, r.status === 200 && inPrefix && isJs && realBundle, `${r.status} ${type} ${body.length} bytes`);
    }
    // the page's script derives the engine path from the page's own path
    const js = await (await fetch(new URL(`../${game}.js`, pageUrl))).text();
    check(`${game}.js connects Socket.IO at <prefix>/socket.io, the prefix read from the page's path`, js.includes(`\\/${game}\\/[^/]+/`) && js.includes('function pagePrefix()') && js.includes('path: `${pagePrefix()}/socket.io`') && !/\bio\(\)/.test(js) && !js.includes('io(`${protocol}'));
    // a trailing slash would shift the relative URLs: redirected away, relatively
    const slash = await fetch(`${pageUrl}/`, { redirect: 'manual' });
    const location = slash.headers.get('location') || '';
    check(`${game} page ${where}: a trailing slash is redirected relatively (the prefix survives)`, slash.status === 302 && location === `../${GAME_ID}` && new URL(location, `${pageUrl}/`).pathname === `${prefix}/${game}/${GAME_ID}`, `${slash.status} ${location}`);
  }
}

const connectSocket = (url, opts) => new Promise((resolve) => {
  const s = ioClient(url, { ...opts, reconnection: false, timeout: 4000 });
  const done = (r) => { resolve(r); };
  s.on('connect', () => done({ ok: true, socket: s }));
  s.on('connect_error', (e) => { s.close(); done({ ok: false, error: e.message, socket: null }); });
  setTimeout(() => done({ ok: false, error: 'timeout', socket: s }), 5000);
});
const once = (s, event, ms = 4000) => new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); s.once(event, (d) => { clearTimeout(t); resolve(d); }); });

let chrome = null;
try {
  // ---- A. the pages and their assets, behind /central and at the root ----------------
  console.log('--- A. pages and assets');
  check('the console stand-in answers 404 outside /central (nothing else is served there)', (await fetch(`${CONSOLE}/tiles.js`)).status === 404 && (await fetch(`${CONSOLE}/socket.io/socket.io.js`)).status === 404);
  await checkPage(CONSOLE, '/central');
  await checkPage(CENTRAL, '');

  // ---- B. Socket.IO through the prefixed path ------------------------------------------
  console.log('--- B. Socket.IO through /central/socket.io');
  const viaPrefix = await connectSocket(CONSOLE, { path: '/central/socket.io', transports: ['polling', 'websocket'] });
  check('a Socket.IO client connects through <console>/central/socket.io', viaPrefix.ok, viaPrefix.error);
  const viaDefault = await connectSocket(CONSOLE, { path: '/socket.io', transports: ['polling'] });
  check('...while the default /socket.io path through the console is not the central server (what the pages used before)', !viaDefault.ok, viaDefault.error);
  if (viaDefault.socket) viaDefault.socket.close();
  const web = viaPrefix.socket;
  if (web) {
    web.emit('tiles-join-lobby', { lobbyId: 'no-such-lobby', playerId: 'web-1', playerName: 'Web', clientType: 'web' });
    const rejected = await once(web, 'tiles-join-rejected');
    check('the game handlers answer through the prefix (an unknown lobby is rejected)', rejected && /does not exist/.test(rejected.reason), JSON.stringify(rejected));
    // the host app creates a lobby (as TilesGameMode does over its own prefixed socket); the web player joins it
    const host = await connectSocket(CONSOLE, { path: '/central/socket.io', transports: ['websocket'] });
    check('the host app connects through the prefix too (websocket transport)', host.ok, host.error);
    if (host.socket) {
      host.socket.emit('tiles-create-lobby', { lobbyId: GAME_ID, playerId: 'host-app', playerName: 'Host', gridSize: 5, isSinglePlayer: false });
      const created = await once(host.socket, 'tiles-lobby-created');
      check('the lobby is created', created && created.lobbyId === GAME_ID, JSON.stringify(created)?.slice(0, 120));
      const joinedP = once(host.socket, 'tiles-player-joined');
      web.emit('tiles-join-lobby', { lobbyId: GAME_ID, playerId: 'web-1', playerName: 'Web player', clientType: 'web' });
      const joined = await joinedP;
      check('a web player joining through /central/socket.io reaches the host (both players listed)', joined && (joined.players || []).length === 2 && joined.players.some((p) => p.name === 'Web player'), JSON.stringify(joined)?.slice(0, 200));
      web.emit('tiles-leave-lobby', { lobbyId: GAME_ID, playerId: 'web-1' });
      await sleep(200);
      web.close();
      // the host stays in the lobby for part D (the browser joins it)
      chrome = { host: host.socket };
    }
  }

  // ---- C. the app's share links ------------------------------------------------------------
  console.log('--- C. the share links the app builds');
  for (const [game, file] of [['tiles', 'TilesGameMode.jsx'], ['grid', 'GridGameMode.jsx'], ['quiz', 'QuizGameMode.jsx']]) {
    const src = fs.readFileSync(path.join(REPO, 'src', 'components', 'game-modes', file), 'utf8');
    check(`${file} shares \${getCentralServerUrl()}/${game}/<gameId> (the page route of the central server)`, src.includes(`gameUrl={\`\${getCentralServerUrl()}/${game}/\${gameId}\`}`));
  }
  const syncSrc = fs.readFileSync(path.join(REPO, 'src', 'utils', 'cloudCentralSync.js'), 'utf8');
  check('getCentralServerUrl is the provided URL (<home server>/central) and socketTargetFor puts the engine under its path', /export function getCentralServerUrl\(\)[\s\S]*?providedCentralCache\.url/.test(syncSrc) && /path: `\$\{prefix\}\/socket\.io`/.test(syncSrc));
  const entrypoint = fs.readFileSync(path.join(REPO, 'deploy', 'entrypoint.sh'), 'utf8');
  check('the container tells the backend the prefix (JACARIUM_CENTRAL_PATH=/central), which is what getCentralServerUrl ends with', /JACARIUM_CENTRAL_PATH="\$\{JACARIUM_CENTRAL_PATH:-\/central\}"/.test(entrypoint));

  // ---- D. a real browser on the prefixed page -----------------------------------------------
  console.log('--- D. headless Chrome on <console>/central/tiles/<id>');
  const chromeBin = process.env.SKIP_BROWSER_TESTS ? null : findChrome();
  if (!chromeBin) {
    console.log('INFO  no Chrome/Chromium found (or SKIP_BROWSER_TESTS set) - the in-browser check is not run; parts A-C cover the requests');
  } else {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'game-pages-chrome-'));
    const debugPort = await freePort();
    const proc = spawn(chromeBin, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1000,800', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    let ws = null;
    try {
      let targets;
      for (let i = 0; i < 60 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); } catch { await sleep(250); } }
      const page = targets.find((t) => t.type === 'page');
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      let id = 0; const pending = new Map(); const failed = [];
      ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method === 'Network.loadingFailed') failed.push(m.params.errorText); if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) failed.push(`${m.params.response.status} ${m.params.response.url}`); };
      const send = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
      const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed'); return r.result?.result?.value; };
      await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
      await send('Page.navigate', { url: `${CONSOLE}/central/tiles/${GAME_ID}` });
      await sleep(2500);
      const state = await evaluate(`({ io: typeof io, connected: !!(socket && socket.connected), path: socket && socket.io.opts.path, gameId: document.getElementById('gameIdDisplay').textContent })`);
      check('the page has socket.io\'s client, its socket is connected through /central/socket.io and shows the game id', state.io === 'function' && state.connected && state.path === '/central/socket.io' && state.gameId === `Game: ${GAME_ID}`, JSON.stringify(state));
      const realFailures = failed.filter((f) => !/favicon\.ico/.test(f));
      check('no request of the page failed (no 404 on an asset, no refused connection)', realFailures.length === 0, realFailures.join(' | '));
      if (chrome?.host) {
        const joinedP = once(chrome.host, 'tiles-player-joined');
        await evaluate(`(() => { document.getElementById('playerName').value = 'Browser player'; document.querySelector('.join-form').requestSubmit(); return true; })()`);
        const joined = await joinedP;
        await sleep(300);
        const lobby = await evaluate(`({ lobby: document.getElementById('lobbyScreen').classList.contains('active'), names: Array.from(document.querySelectorAll('#playersList .player-name')).map((e) => e.textContent) })`);
        check('entering a name joins the host\'s lobby: the host sees the browser player and the page shows the lobby with both', joined && (joined.players || []).some((p) => p.name === 'Browser player') && lobby.lobby && lobby.names.includes('Host') && lobby.names.includes('Browser player'), JSON.stringify({ joined: joined?.players?.map((p) => p.name), lobby }));
      }
    } finally {
      try { ws && ws.close(); } catch { /* closed */ }
      proc.kill();
      await sleep(300);
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
} catch (error) {
  check('the run completed', false, error.stack || error.message);
} finally {
  try { chrome?.host?.close(); } catch { /* closed */ }
  await proxy.close();
  server.kill('SIGTERM');
  await sleep(300);
  try { server.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(DATA, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('Failed:'); for (const f of failed) console.log(`  - ${f.name}`); }
process.exit(failed.length ? 1 : 0);
