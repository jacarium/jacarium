#!/usr/bin/env node
/**
 * Express 5 in both servers - electron/server.cjs (the desktop's local backend) and jacarium-central
 * (server.js, api-routes.js) - behaves as Express 4 did where it matters, and better where 5 changed things.
 *
 * Static (the migration guide's list):
 *  - express ^5 in both package.json files, body-parser neither a dependency nor an override (express.json is
 *    its JSON parser; the 1.x override of the root existed only for Express 4's copy);
 *  - no removed API in the three server files: res.send(<number>), res.json(obj, status), req.param(),
 *    res.sendfile(), app.del(), res.redirect('back'), express.static.mime;
 *  - every route path is a plain path or :param (path-to-regexp 8 reads *, ?, (), [] differently);
 *  - req.body is given {} when nothing was parsed (5 leaves it undefined; the routes destructure it);
 *  - a four-parameter error handler closes each app (a rejected promise or a throw reaches it in 5, as does a
 *    body the parser refuses) and answers JSON - never the default HTML page with the stack trace;
 *  - the game pages are sent with root + relative name (5 applies the dotfiles rule to every segment of an
 *    absolute path: a checkout under a dot-directory 404'd);
 *  - express.json keeps the 50mb limit and nothing else (tests/audit-mitigations.test.mjs: no stopgap).
 * Live (both servers spawned, throwaway ports and data dir):
 *  - server.cjs: /health open; 401 without the token; the query getter; POST without a body answers the
 *    route's own 400 (not a 500 from destructuring undefined); malformed JSON is 400 JSON without a stack;
 *    a gzip-encoded body is inflated like a plain one; an unknown route is 404; the CORS preflight passes;
 *  - central: /api/health; register without a body / with {} answers "Missing machine_id"; malformed JSON is
 *    400 JSON; a protected route without credentials stays 401; the game page is 200 text/html even from this
 *    checkout's path; the static script is served; a dotfile and a traversal are 404; an unknown route is 404.
 *
 * Run: node tests/express5-servers.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- static -----------------------------------------------------------------------------------------
const rootPkg = JSON.parse(read('package.json'));
const centralPkg = JSON.parse(read('jacarium-central/package.json'));
check('express ^5 in the root and in jacarium-central', /^\^5\./.test(rootPkg.dependencies.express) && /^\^5\./.test(centralPkg.dependencies.express), `${rootPkg.dependencies.express} / ${centralPkg.dependencies.express}`);
// body-parser is nobody's dependency any more (Express 5 brings body-parser 2 through express.json). An
// override may pin it, and then only to 2.4.0 or later: the urgent exception for GHSA-27r3-jxmh-p828
// (docs/security/urgent-updates.md), which an older pin would undo.
const overridePin = (pkg) => (pkg.overrides || {})['body-parser'];
const pinOk = (pin) => pin === undefined || /^\^?2\.(?:[4-9]|\d{2,})\.\d+$|^\^?(?:[3-9]|\d{2,})\./.test(pin);
check('body-parser is no dependency of either; an override, if any, pins 2.4.0 or later (GHSA-27r3-jxmh-p828)',
      !('body-parser' in (rootPkg.dependencies || {})) && !('body-parser' in (centralPkg.dependencies || {})) && pinOk(overridePin(rootPkg)) && pinOk(overridePin(centralPkg)),
      `root override ${overridePin(rootPkg)}, central override ${overridePin(centralPkg)}`);
const lock = JSON.parse(read('package-lock.json'));
const centralLock = JSON.parse(read('jacarium-central/package-lock.json'));
const atLeast240 = (v) => { const [a, b] = v.split('.').map(Number); return a > 2 || (a === 2 && b >= 4); };
check('both locks resolve express 5 and body-parser 2.4.0 or later (the fixed line)', /^5\./.test(lock.packages['node_modules/express'].version) && atLeast240(lock.packages['node_modules/body-parser'].version)
      && /^5\./.test(centralLock.packages['node_modules/express'].version) && atLeast240(centralLock.packages['node_modules/body-parser'].version),
      `${lock.packages['node_modules/body-parser'].version} / ${centralLock.packages['node_modules/body-parser'].version}`);

const FILES = ['electron/server.cjs', 'jacarium-central/server.js', 'jacarium-central/api-routes.js'];
const REMOVED = [/res\.send\(\s*\d+\s*\)/, /res\.json\([^()]*,\s*\d{3}\s*\)/, /req\.param\(/, /\.sendfile\(/, /app\.del\(/, /redirect\(\s*['"]back['"]\s*\)/, /express\.static\.mime/, /\.jsonp\([^()]*,\s*\d{3}\)/];
for (const f of FILES) {
  const src = read(f);
  check(`${f}: none of the APIs Express 5 removed`, !REMOVED.some((re) => re.test(src)), REMOVED.filter((re) => re.test(src)).map(String).join(' '));
  const paths = [...src.matchAll(/(?:app|router)\.(?:get|post|put|delete|all|use)\(\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2]);
  check(`${f}: every route path is a plain path or :param (${paths.length} paths; path-to-regexp 8 syntax)`, paths.every((p) => /^\/(?:[\w.-]+|:[A-Za-z_]\w*)(?:\/(?:[\w.-]+|:[A-Za-z_]\w*))*\/?$/.test(p)), paths.filter((p) => !/^\/(?:[\w.-]+|:[A-Za-z_]\w*)(?:\/(?:[\w.-]+|:[A-Za-z_]\w*))*\/?$/.test(p)).join(' '));
}
for (const f of ['electron/server.cjs', 'jacarium-central/server.js']) {
  const src = read(f);
  check(`${f}: express.json with the 50mb limit, as before (tests/audit-mitigations.test.mjs keeps it free of stopgaps)`, /app\.use\(express\.json\(\{ limit: '50mb' \}\)\);/.test(src));
  check(`${f}: req.body defaults to {} after the parser (Express 4's shape for the routes)`, /if \(req\.body === undefined\) req\.body = \{\};/.test(src));
  const handler = src.indexOf('app.use((err, req, res, next) => {');
  check(`${f}: a four-parameter error handler answers JSON with the error's status, never the HTML page`, handler > 0 && /res\.status\(status\)\.json\(\{ error: message \}\)/.test(src.slice(handler)) && src.indexOf("'entity.parse.failed'", handler) > 0);
  check(`${f}: the error handler is registered after the routes`, handler > src.lastIndexOf(f.endsWith('server.cjs') ? "app.get('/health'" : 'app.use(apiRouter)'));
}
check('api-routes.js: the game pages are sent with root + relative name (the dotfiles rule then sees the file name only)', /res\.sendFile\(file, \{ root: path\.join\(__dirname, 'public'\) \}\)/.test(read('jacarium-central/api-routes.js')));

// --- live ----------------------------------------------------------------------------------------------
async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not yet */ } await sleep(250); }
  return false;
}
async function hit(url, init = {}) {
  const r = await fetch(url, { redirect: 'manual', ...init });
  const text = await r.text();
  return { status: r.status, type: (r.headers.get('content-type') || '').split(';')[0], text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), headers: r.headers };
}
const TOKEN = 'express5-test-token';
const port = Number(process.env.SMOKE_PORT || 18451);
const srv = spawn('node', [path.join(REPO, 'electron', 'server.cjs')], { env: { ...process.env, PORT: String(port), APP_AUTH_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = ''; srv.stderr.on('data', (d) => { srvErr += d; });
const base = `http://127.0.0.1:${port}`;
const auth = { 'X-App-Token': TOKEN };
const cport = port + 1;
const dataDir = mkdtempSync(path.join(tmpdir(), 'express5-central-'));
const central = spawn('node', ['server.js'], { cwd: path.join(REPO, 'jacarium-central'), env: { ...process.env, PORT: String(cport), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
let cErr = ''; central.stderr.on('data', (d) => { cErr += d; });
const cbase = `http://127.0.0.1:${cport}`;
try {
  check('electron/server.cjs starts under Express 5', await waitFor(`${base}/health`), srvErr.slice(0, 300));
  let r = await hit(`${base}/health`);
  check('server.cjs: /health is open and JSON', r.status === 200 && r.json && r.json.status === 'ok');
  r = await hit(`${base}/api/cloud/pending?machine_id=m1`);
  check('server.cjs: 401 without the token', r.status === 401 && r.json && r.json.error === 'Unauthorized');
  r = await hit(`${base}/api/cloud/pending?machine_id=m1`, { headers: auth });
  check('server.cjs: req.query (a getter in 5) still serves the route', r.status === 200 && r.json && r.json.success === true, r.text.slice(0, 120));
  r = await hit(`${base}/api/workflow/execute`, { method: 'POST', headers: auth });
  check('server.cjs: POST without a body answers the route\'s own 400 (req.body is {}, not undefined)', r.status === 400 && r.json && r.json.error === 'Invalid workflow data', `${r.status} ${r.text.slice(0, 120)}`);
  r = await hit(`${base}/api/cloud/receive`, { method: 'POST', headers: auth });
  check('server.cjs: a route that reads optional body fields still answers 200 without a body', r.status === 200 && r.json && r.json.success === true, `${r.status} ${r.text.slice(0, 120)}`);
  r = await hit(`${base}/api/workflow/execute`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{bad' });
  check('server.cjs: malformed JSON is 400 JSON "Malformed JSON body" with no stack trace', r.status === 400 && r.type === 'application/json' && r.json && r.json.error === 'Malformed JSON body' && !/SyntaxError|at JSON\.parse/.test(r.text), `${r.status} ${r.type} ${r.text.slice(0, 120)}`);
  r = await hit(`${base}/api/workflow/execute`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gzipSync(Buffer.from('{"workflow":{"title":"no nodes"}}')) });
  check('server.cjs: a gzip-encoded JSON body is inflated and parsed like a plain one (the route sees the workflow and refuses it for its missing nodes)', r.status === 400 && r.json && r.json.error === 'Invalid workflow data', `${r.status} ${r.type} ${r.text.slice(0, 120)}`);
  r = await hit(`${base}/nope`, { headers: auth });
  check('server.cjs: an unknown route is 404', r.status === 404);
  r = await hit(`${base}/api/workflow/execute`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } });
  check('server.cjs: the CORS preflight passes without a token and reflects the dev origin', r.status === 204 && r.headers.get('access-control-allow-origin') === 'http://localhost:5173', `${r.status} ${r.headers.get('access-control-allow-origin')}`);

  check('jacarium-central starts under Express 5', await waitFor(`${cbase}/api/health`), cErr.slice(0, 300));
  r = await hit(`${cbase}/api/health`);
  check('central: /api/health', r.status === 200 && r.json && r.json.status === 'ok');
  r = await hit(`${cbase}/api/register`, { method: 'POST' });
  check('central: register without a body answers "Missing machine_id" (400), as before', r.status === 400 && r.json && r.json.error === 'Missing machine_id', `${r.status} ${r.text.slice(0, 120)}`);
  r = await hit(`${cbase}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  check('central: malformed JSON is 400 JSON with no stack trace', r.status === 400 && r.type === 'application/json' && r.json && r.json.error === 'Malformed JSON body' && !/SyntaxError/.test(r.text), `${r.status} ${r.text.slice(0, 120)}`);
  r = await hit(`${cbase}/api/pending?machine_id=m1`);
  check('central: a protected route without credentials stays 401', r.status === 401 && r.json && /X-Client-Secret/.test(r.json.error), `${r.status} ${r.text.slice(0, 120)}`);
  r = await hit(`${cbase}/quiz/abc-123`);
  check(`central: the game page is 200 text/html (served through root + name; this checkout is under ${REPO.includes('/.') ? 'a dot-directory' : 'a plain path'})`, r.status === 200 && r.type === 'text/html' && /Jacarium Quiz/.test(r.text), `${r.status} ${r.type} ${r.text.slice(0, 80)}`);
  r = await hit(`${cbase}/quiz/abc-123/`);
  check('central: the trailing-slash form redirects relatively to the page', r.status === 302 && r.headers.get('location') === '../abc-123', `${r.status} ${r.headers.get('location')}`);
  r = await hit(`${cbase}/quiz.js`);
  check('central: the static script is served as JavaScript (text/javascript in Express 5)', r.status === 200 && /javascript/.test(r.type), `${r.status} ${r.type}`);
  r = await hit(`${cbase}/.hidden`);
  check('central: a dotfile under the static root is 404', r.status === 404);
  r = await hit(`${cbase}/..%2Fserver.js`);
  check('central: a traversal attempt is 404', r.status === 404);
  r = await hit(`${cbase}/api/nope`, { method: 'DELETE' });
  check('central: an unknown API route is 404', r.status === 404);
} finally {
  srv.kill(); central.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${failed ? `${failed} check(s) failed` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
