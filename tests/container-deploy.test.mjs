/**
 * The browser deployment end to end: builds deploy/Containerfile, runs the
 * image with a throwaway /data volume published on 127.0.0.1 only, and
 * drives it over HTTPS the way a browser would (synthetic data only).
 *
 * Proves that
 *   - the image builds (UI build stage with the central server's
 *     dependencies, Taskwarrior build stage, Caddy, Node, UBI 9 runtime)
 *     and starts: /health answers over HTTPS on the chosen
 *     bind address with the self-signed certificate it generated into
 *     <data>/certs; the container runs as a non-root user;
 *   - the app loads: / is the built index.html, its assets are served, and
 *     an unknown path is not the API;
 *   - the backend is reachable only through the proxy (only 8443 is
 *     published, on the bind address; /api/capabilities says auth mode
 *     "accounts");
 *   - sign-in: without a session the API answers 401, a state-changing
 *     request without X-Requested-With 403; the one-time setup code on the
 *     volume (and in the log) creates the administrator and a __Host-
 *     Secure/HttpOnly/SameSite=Strict session; a second account sees none
 *     of the first one's settings, Taskwarrior data or reports, and is no
 *     administrator; the open deployment (JACARIUM_AUTH_MODE=none)
 *     still starts and answers without a session;
 *   - synchronisation: /api/sync/* push and pull a record for the signed-in
 *     account into its own sync.sqlite, another account's feed stays empty;
 *   - Settings read/write through the API with write-only secrets: a saved
 *     Jira PAT never comes back (set / not set only), nor does it appear in
 *     any later GET, and saving without it keeps it (the env file on the
 *     volume still holds it);
 *   - Diagnostics browses the reports volume: a synthetic sosreport copied
 *     into <data>/reports is listed, a path outside the root is refused,
 *     ".." traversal and a symlink escape are refused;
 *   - the Jira proxy allowlist refuses traversal / odd paths; with no PAT
 *     configured it answers 503 (nothing is sent anywhere);
 *   - cross-site requests (Sec-Fetch-Site: cross-site, non-navigation) are
 *     refused by the proxy while same-origin ones pass;
 *   - Taskwarrior and the ssh client are present inside the container;
 *   - the Socket.IO endpoint answers a polling handshake through the proxy;
 *   - the central server IN the container (3.2): /central/api/health and
 *     the Socket.IO handshake answer on the console origin, its keys are
 *     generated 0600 under <data>/central/keys and are in no process
 *     argument, a signed-in user's ticket (POST /api/auth/central-ticket)
 *     authenticates REST and the websocket, pairing is closed
 *     (403 ACCOUNT_SIGN_IN_ONLY), an unauthenticated client is refused, the
 *     desktop's "Origin: file://" handshake passes the cross-site guard while
 *     a foreign page's is refused, the central server killed inside the
 *     container is restarted in place, and a container started with
 *     JACARIUM_CENTRAL=off has no /central route and no team features.
 *
 * Skips (exit 0 with a SKIP line) when neither podman nor docker is
 * available, when the engine is not running, or with
 * SKIP_CONTAINER_TESTS=1. The image build can take 10-20 minutes the first
 * time (Python dependencies) and needs a VM with 4 GB+ of memory on macOS
 * (podman machine set --memory 6144).
 *
 * Run:  node tests/container-deploy.test.mjs
 * Env:  CONTAINER_TEST_PORT (default 18443), CONTAINER_TEST_IMAGE (default
 *       jacarium:test), CONTAINER_TEST_KEEP=1 keeps the container
 *       and data dir for inspection.
 */
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const PORT = Number(process.env.CONTAINER_TEST_PORT || 18443);
const IMAGE = process.env.CONTAINER_TEST_IMAGE || 'jacarium:test';
const NAME = `jacarium-test-${process.pid}`;
const BIND = '127.0.0.1';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.SKIP_CONTAINER_TESTS === '1') { console.log('SKIP: SKIP_CONTAINER_TESTS=1'); process.exit(0); }
const engine = ['podman', 'docker'].find((e) => spawnSync(e, ['--version'], { stdio: 'ignore' }).status === 0);
if (!engine) { console.log('SKIP: neither podman nor docker is installed'); process.exit(0); }
if (spawnSync(engine, ['info'], { stdio: 'ignore' }).status !== 0) { console.log(`SKIP: ${engine} is installed but its engine is not running`); process.exit(0); }

const run = (args, opts = {}) => spawnSync(engine, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

// ---- HTTPS client that accepts the self-signed certificate ----------------
// The session: the cookie the sign-in set (sent with every request unless
// `anonymous`), and the X-Requested-With header the backend requires on
// state-changing requests (left out with `noCsrf` to prove the refusal).
const session = { cookie: '' };
function request(method, urlPath, { body, headers = {}, json = true, anonymous = false, noCsrf = false, cookie = undefined, port = PORT } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const jar = cookie !== undefined ? cookie : (anonymous ? '' : session.cookie);
    const req = https.request({
      host: BIND, port, method, path: urlPath, rejectUnauthorized: false,
      headers: {
        ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(noCsrf ? {} : { 'X-Requested-With': 'Jacarium' }),
        ...(jar ? { Cookie: jar } : {}),
        ...headers,
      },
      timeout: 30000,
    }, (res) => {
      // The socket is released before 'end': read the certificate now.
      const cert = res.socket?.getPeerCertificate?.() || null;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (json) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed, cert });
      });
    });
    req.on('error', (error) => resolve({ status: 0, error: String(error), text: '', json: null }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (data !== undefined) req.write(data);
    req.end();
  });
}

// ---- build ------------------------------------------------------------------
console.log(`Building ${IMAGE} with ${engine} (this can take a while)...`);
// --format docker as deploy-podman.sh builds it: the OCI format has no
// HEALTHCHECK, so the container's health would be "n/a".
const build = run(['build', '--format', 'docker', '-f', path.join(REPO, 'deploy', 'Containerfile'), '-t', IMAGE, REPO], { stdio: ['ignore', 'pipe', 'pipe'] });
check('the image builds', build.status === 0, (build.stderr || '').split('\n').filter(Boolean).slice(-6).join(' / '));
if (build.status !== 0) { console.log(`\n${failed} check(s) failed`); process.exit(1); }

// The build superseded the previous test image and the untagged ui /
// taskwarrior stage images; deploy/prune-images.sh removes only images
// carrying this project's label and none a container uses (the layer cache
// lives in podman's hidden intermediate images and survives).
const prune = (args = []) => spawnSync('bash', [path.join(REPO, 'deploy', 'prune-images.sh'), '--component', 'deploy', ...args],
  { encoding: 'utf8', env: { ...process.env, CONTAINER_RUNTIME: engine } });
const pruned = prune();
check('superseded project images are pruned after the build', pruned.status === 0, (pruned.stdout || '').trim().split('\n').pop());
// What may remain untagged: the newest result of each intermediate stage
// (ui, taskwarrior) - it is that stage's build cache - and nothing else: no
// superseded final image, no second image of a stage.
const danglingOurs = run(['images', '--filter', 'label=com.jacarium.image=deploy', '--filter', 'dangling=true',
  '--format', '{{.ID}} {{index .Labels "com.jacarium.stage"}}']);
const leftover = (danglingOurs.stdout || '').trim().split('\n').filter(Boolean).map((l) => l.split(' '));
const stagesLeft = leftover.map(([, stage]) => stage);
check('no untagged final image of this project is left behind, at most one cached image per stage',
  !stagesLeft.includes('app') && new Set(stagesLeft).size === stagesLeft.length && stagesLeft.every((s) => ['ui', 'taskwarrior'].includes(s)),
  leftover.map(([id, stage]) => `${id}(${stage})`).join(' ') || 'none');

// ---- run with a throwaway /data -----------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jacarium-container-'));
fs.mkdirSync(path.join(dataDir, 'reports', 'sosreport-synthetic-node-2026-10-10'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'reports', 'sosreport-synthetic-node-2026-10-10', 'hostname'), 'synthetic-node\n');
fs.mkdirSync(path.join(dataDir, 'outside'));
fs.writeFileSync(path.join(dataDir, 'outside', 'secret.txt'), 'not for the browser\n');
fs.symlinkSync(path.join('/data', 'outside'), path.join(dataDir, 'reports', 'escape'));

const started = run(['run', '-d', '--name', NAME, '-p', `${BIND}:${PORT}:8443`, '-v', `${dataDir}:/data:Z,U`, IMAGE]);
check('the container starts', started.status === 0, started.stderr);

const cleanup = () => {
  if (process.env.CONTAINER_TEST_KEEP === '1') { console.log(`kept: container ${NAME}, image ${IMAGE}, data ${dataDir}`); return; }
  run(['rm', '-f', NAME]);
  fs.rmSync(dataDir, { recursive: true, force: true });
  // Drop the test tag (an image shared with another tag, e.g. :latest, is
  // only untagged) and whatever that leaves untagged of ours; the cached
  // layers stay, so the next run rebuilds in seconds when nothing changed.
  run(['rmi', IMAGE]);
  prune();
};

try {
  // ---- up over HTTPS --------------------------------------------------------
  let health = null;
  for (let i = 0; i < 90 && !health; i++) {
    const r = await request('GET', '/health');
    if (r.status === 200 && r.json?.status === 'healthy') health = r;
    else await sleep(2000);
  }
  check(`/health answers over HTTPS on ${BIND}:${PORT}`, !!health, health ? '' : run(['logs', NAME]).stderr.slice(-800));
  if (!health) throw new Error('container did not come up');

  // The Containerfile's HEALTHCHECK (curl /health every 30 s) is kept by
  // the docker image format and the engine runs it: the container reports
  // real health, not "n/a" (podman starts the first check after one
  // interval, so this waits up to ~70 s).
  const healthStatus = () => (run(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}', NAME]).stdout || '').trim();
  let reported = healthStatus();
  for (let i = 0; i < 70 && reported !== 'healthy'; i++) { await sleep(1000); reported = healthStatus(); }
  check('the container reports a real health status (HEALTHCHECK kept by --format docker)', reported === 'healthy', reported);
  check('the self-signed certificate was generated into <data>/certs', fs.existsSync(path.join(dataDir, 'certs', 'cert.pem')) && fs.existsSync(path.join(dataDir, 'certs', 'key.pem')));
  const rootCrt = await request('GET', '/api/tls/root.crt', { anonymous: true, json: false });
  check('/api/tls/root.crt serves that certificate as the root to pin (the console terminates TLS itself), no sign-in', rootCrt.status === 200 && rootCrt.text.trim() === fs.readFileSync(path.join(dataDir, 'certs', 'cert.pem'), 'utf8').trim() && /x-pem-file/.test(rootCrt.headers['content-type'] || ''), `${rootCrt.status} ${rootCrt.headers['content-type']}`);
  fs.mkdirSync(path.join(dataDir, 'tls'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'tls', 'root.crt'), '-----BEGIN CERTIFICATE-----\nc3ludGhldGljIHByb3h5IHJvb3Q=\n-----END CERTIFICATE-----\n');
  const proxyRoot = await request('GET', '/api/tls/root.crt', { anonymous: true, json: false });
  check('...a root copied to <data>/tls/root.crt (the reverse proxy\'s) wins, read per request (no restart)', proxyRoot.status === 200 && /c3ludGhldGlj/.test(proxyRoot.text), proxyRoot.text.slice(0, 60));
  fs.rmSync(path.join(dataDir, 'tls'), { recursive: true, force: true });
  check('...and it is the one served (CN jacarium, SAN localhost/127.0.0.1)', /jacarium/.test(health.cert?.subject?.CN || '') && /127\.0\.0\.1/.test(health.cert?.subjectaltname || ''), `${health.cert?.subject?.CN} ${health.cert?.subjectaltname}`);
  const whoami = run(['exec', NAME, 'id', '-u']);
  check('the container runs as a non-root user', whoami.stdout.trim() !== '0' && whoami.stdout.trim() !== '', whoami.stdout.trim());
  const ports = run(['port', NAME]);
  check('only 8443 is published, on the bind address', /8443\/tcp -> 127\.0\.0\.1:/.test(ports.stdout) && !/0\.0\.0\.0/.test(ports.stdout), ports.stdout.trim());

  // ---- the app loads ----------------------------------------------------------
  const index = await request('GET', '/', { json: false });
  const asset = (index.text.match(/\/assets\/[^"']+\.js/) || [])[0];
  check('/ serves the built app (index.html with a script bundle)', index.status === 200 && /<div id="root">/.test(index.text) && !!asset, `${index.status} ${asset}`);
  const assetResponse = asset ? await request('GET', asset, { json: false }) : { status: 0 };
  check('the bundle is served', assetResponse.status === 200 && /javascript/.test(assetResponse.headers?.['content-type'] || ''), String(assetResponse.status));
  check('the proxy sets security headers', (index.headers['x-content-type-options'] || '') === 'nosniff' && !index.headers.server, JSON.stringify({ xcto: index.headers['x-content-type-options'], server: index.headers.server }));
  // caching: the page is revalidated every time, the hashed chunks never (a stale
  // index.html after a redeploy would ask for chunks that no longer exist)
  check('index.html is served with Cache-Control: no-cache', /^no-cache$/i.test(index.headers['cache-control'] || ''), index.headers['cache-control']);
  // the branding and the other files Vite copied from public/ are static and public (a browser asks for
  // them without a session, and the favicon, the apple-touch-icon and the manifest must answer 200 with
  // their type and no-cache so an icon change shows up); only the API is behind the sign-in
  for (const [p, type] of [['/favicon.ico', /image\/(x-icon|vnd\.microsoft\.icon)/], ['/favicon.png', /image\/png/], ['/favicon.svg', /image\/svg\+xml/], ['/apple-touch-icon.png', /image\/png/], ['/icon-192.png', /image\/png/], ['/icon-512.png', /image\/png/], ['/manifest.webmanifest', /application\/manifest\+json|application\/json/], ['/brand/icon-small.svg', /image\/svg\+xml/], ['/brand/mark.svg', /image\/svg\+xml/]]) {
    const a = await request('GET', p, { anonymous: true, json: false });
    check(`${p} is served anonymously with its type and no-cache`, a.status === 200 && type.test(a.headers['content-type'] || '') && /^no-cache$/i.test(a.headers['cache-control'] || ''), `${a.status} ${a.headers['content-type']} ${a.headers['cache-control']}`);
  }
  const quiz = await request('GET', '/quizData/', { anonymous: true, json: false });
  check('quizData (game content, no secrets) stays public like the rest of the build', quiz.status === 200 || quiz.status === 404 || quiz.status === 403, String(quiz.status));
  const unknown = await request('GET', '/no-such-page', { anonymous: true, json: false });
  check('a path that is not a file of the build still reaches the backend (not served as a file)', unknown.status !== 200 || !/<div id="root">/.test(unknown.text), String(unknown.status));
  const healthFile = await request('GET', '/health', { anonymous: true, json: false });
  check('/health is the backend\'s, not a file', healthFile.status === 200 && !/<div id="root">/.test(healthFile.text), String(healthFile.status));
  check('a hashed asset is served immutable for a year', /max-age=31536000/.test(assetResponse.headers?.['cache-control'] || '') && /immutable/.test(assetResponse.headers?.['cache-control'] || ''), assetResponse.headers?.['cache-control']);
  const unionList = run(['exec', NAME, 'sh', '-c', 'ls /data/ui-assets/assets | wc -l; ls /data/ui-assets/.builds | wc -l']);
  const [unionFiles, builds] = unionList.stdout.trim().split('\n').map((x) => Number(x.trim()));
  check('the hashed assets are kept on the data volume (the previous build survives one redeploy)', unionFiles > 0 && builds === 1, unionList.stdout.trim().replace(/\n/g, ' '));
  const fromVolume = asset ? await request('GET', asset.replace(/-[A-Za-z0-9_-]+\.js$/, '-missing.js'), { json: false }) : { status: 0 };
  check('an asset that no build has is a 404, not a directory listing', fromVolume.status === 404 && !/<a href/.test(fromVolume.text || ''), String(fromVolume.status));

  // ---- sign-in: the first run creates the administrator with the setup code ----
  let caps = await request('GET', '/api/capabilities', { anonymous: true });
  check('/api/capabilities: auth mode "accounts" behind the proxy, setup required, no user', caps.status === 200 && caps.json?.authMode === 'accounts' && caps.json?.auth?.setupRequired === true && caps.json?.auth?.user === null, caps.text);
  let r = await request('GET', '/api/taskwarrior/check', { anonymous: true });
  check('an API route without a session answers 401 (with setupRequired)', r.status === 401 && r.json?.setupRequired === true, r.text);
  r = await request('PUT', '/api/settings', { body: { values: {} }, anonymous: true, noCsrf: true });
  check('a state-changing request without X-Requested-With is refused (403)', r.status === 403, r.text);
  const codeFile = path.join(dataDir, 'setup-code');
  check('the one-time setup code was written to the data volume', fs.existsSync(codeFile));
  const setupCode = fs.existsSync(codeFile) ? fs.readFileSync(codeFile, 'utf8').trim() : '';
  check('...and printed in the container log', /setup code/.test(run(['logs', NAME]).stdout + run(['logs', NAME]).stderr) && setupCode.length === 20, setupCode);
  r = await request('POST', '/api/auth/setup', { body: { setupCode: 'wrong-wrong-wrongx', username: 'alice', password: 'alices password' }, anonymous: true });
  check('setup with a wrong code is refused', r.status === 403, r.text);
  r = await request('POST', '/api/auth/setup', { body: { setupCode, username: 'alice', password: 'alices password', displayName: 'Alice' }, anonymous: true });
  const setCookie = (r.headers?.['set-cookie'] || [])[0] || '';
  session.cookie = setCookie.split(';')[0];
  check('setup with the code creates the administrator and signs in', r.status === 201 && r.json?.user?.role === 'admin' && session.cookie.startsWith('__Host-jacarium_session='), r.text.slice(0, 200));
  check('the session cookie is Secure, HttpOnly, SameSite=Strict', /Secure/.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), setCookie);
  check('the setup code file is gone', !fs.existsSync(codeFile));
  const aliceId = r.json?.user?.id;
  r = await request('GET', '/api/auth/me');
  check('/api/auth/me returns the administrator', r.status === 200 && r.json?.user?.username === 'alice');
  caps = await request('GET', '/api/capabilities');
  check('/api/capabilities with the session: the user, admin, the account\'s reports root and the shared one, browser features provided',
    caps.json?.auth?.user?.username === 'alice' && caps.json?.auth?.admin === true && caps.json?.reportsRoot === `/data/users/${aliceId}/reports` && caps.json?.sharedReportsRoot === '/data/reports'
    && caps.json?.capabilities?.settings && caps.json?.capabilities?.jiraProxy && caps.json?.capabilities?.whois, caps.text);

  // ---- settings: write-only secrets, per account ----------------------------------
  const SECRET = 'synthetic-jira-pat-c0ffee';
  r = await request('PUT', '/api/settings', { body: { values: { JIRA_EMAIL: 'someone@example.test', DEFAULT_AI_PROVIDER: 'anthropic' }, secrets: { JIRA_PAT: SECRET } } });
  check('settings PUT saves and reports the secret as stored', r.status === 200 && r.json?.secrets?.JIRA_PAT === true && r.json?.values?.JIRA_EMAIL === 'someone@example.test', r.text);
  r = await request('GET', '/api/settings');
  check('settings GET never returns the secret', r.status === 200 && !r.text.includes(SECRET) && r.json?.secrets?.JIRA_PAT === true, r.text);
  r = await request('PUT', '/api/settings', { body: { values: { JIRA_EMAIL: 'someone@example.test', DEFAULT_AI_PROVIDER: 'openai' } } });
  check('saving again without the secret keeps it', r.status === 200 && r.json?.secrets?.JIRA_PAT === true && r.json?.values?.DEFAULT_AI_PROVIDER === 'openai', r.text);
  const envFile = path.join(dataDir, 'users', aliceId, '.jacarium.env');
  check("the env file lives under the account's home on the /data volume and holds the secret", fs.existsSync(envFile) && fs.readFileSync(envFile, 'utf8').includes(`JIRA_PAT=${SECRET}`));
  check('nothing was written to the pre-accounts settings file', !fs.existsSync(path.join(dataDir, '.jacarium.env')));

  // ---- diagnostics: the account's own reports and the shared /data/reports -----------
  r = await request('POST', '/list_reports', { body: { directory: '/data/reports' } });
  check('Diagnostics lists the sosreport copied into the shared <data>/reports', r.status === 200 && (r.json?.reports || []).some((x) => x.name === 'sosreport-synthetic-node-2026-10-10'), r.text);
  r = await request('POST', '/list_reports', { body: {} });
  check("the default is the account's own (empty) reports directory", r.status === 200 && (r.json?.reports || []).length === 0, r.text);
  for (const [label, directory] of [['an absolute path outside both roots', '/data/outside'], ['".." traversal', '../../../outside'], ['a symlink pointing outside', '/data/reports/escape'], ['/etc', '/etc'], ['the server\'s own files', '/data/.ssh']]) {
    r = await request('POST', '/list_reports', { body: { directory } });
    check(`browsing ${label} is refused (403)`, r.status === 403, `${r.status} ${r.text}`);
  }
  r = await request('POST', '/load_tab', { body: { report_type: 'sosreport', tab: 'system', directory: '/data/reports/escape' } });
  check('load_tab refuses the symlink escape too', r.status === 403, String(r.status));

  // ---- the proxied integrations ------------------------------------------------------
  r = await request('GET', '/api/jira/project/search');
  check('the Jira proxy is reachable (the test token is not a real one: Jira answers, or the call fails, but it is attempted)', r.status !== 403, `${r.status}`);
  r = await request('GET', '/api/jira/..%2Fx');
  check('Jira proxy refuses traversal', r.status === 400 || r.status === 404, String(r.status));
  r = await request('GET', '/api/jira/project%20search');
  check('Jira proxy refuses odd characters', r.status === 400, String(r.status));
  r = await request('POST', '/api/workflow/http-request', { body: { url: 'http://127.0.0.1:8080/api/capabilities' } });
  check('workflow HTTP refuses loopback (the backend itself) via the SSRF guard', r.status === 400, r.text);
  r = await request('POST', '/api/whois', { body: { domain: 'not a domain' } });
  check('WHOIS refuses a bad domain', r.status === 400, r.text);

  // ---- cross-site protection at the proxy ---------------------------------------
  r = await request('GET', '/api/capabilities', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', Origin: 'https://evil.example' } });
  check('a cross-site (non-navigation) request is refused by the proxy (403)', r.status === 403, String(r.status));
  r = await request('POST', '/api/whois', { body: { domain: 'not a domain' }, headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors' } });
  check('a same-site request from another port is refused too (before the route sees it)', r.status === 403, String(r.status));
  r = await request('GET', '/api/capabilities', { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' } });
  check('a same-origin request passes', r.status === 200, String(r.status));
  r = await request('GET', '/', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' }, json: false });
  check('a cross-site navigation (a link to the app) still loads the app', r.status === 200, String(r.status));

  // ---- tools inside the container ---------------------------------------------------
  const tw = await request('GET', '/api/taskwarrior/check');
  check('Taskwarrior is installed in the container', tw.status === 200 && tw.json?.installed === true && /2\.6/.test(tw.json?.version || ''), tw.text);
  const ssh = run(['exec', NAME, 'ssh', '-V']);
  check('the ssh client is installed in the container', ssh.status === 0 && /OpenSSH/.test(ssh.stderr + ssh.stdout), (ssh.stderr + ssh.stdout).trim());
  check('known_hosts lives on the volume', fs.existsSync(path.join(dataDir, '.ssh', 'known_hosts')));

  // ---- the Taskwarrior routes cannot run programs or reach outside /data/.task ------
  r = await request('POST', '/api/taskwarrior/command', { body: { command: 'execute id' } });
  check('there is no run-any-task-command route', r.status === 404, String(r.status));
  r = await request('POST', '/api/taskwarrior/reports/execute', { body: { reportName: 'next', filter: 'execute id', format: 'json' } });
  check('a report filter that could become `task execute` is refused', r.status === 400 && /not allowed/.test(r.json?.error || ''), r.text);
  r = await request('POST', '/api/taskwarrior/reports/execute', { body: { reportName: 'next', filter: 'status:pending +synthetic', format: 'json' } });
  check("an ordinary report filter runs against the account's own default instance (its taskrc is created on first use)", r.status === 200 && Array.isArray(r.json?.tasks) && fs.existsSync(path.join(dataDir, 'users', aliceId, '.taskrc')), r.text);
  const envBefore = fs.readFileSync(envFile, 'utf8');
  r = await request('POST', '/api/taskwarrior/instances/init', { body: { rcPath: `/data/users/${aliceId}/.jacarium.env`, dataPath: '~/.task/x', config: { JIRA_URL: 'https://attacker.example' } } });
  check('an instance taskrc cannot be written over the settings file', r.status === 400 && fs.readFileSync(envFile, 'utf8') === envBefore, r.text);
  r = await request('POST', '/api/taskwarrior/export', { body: { dataPath: '/data/.ssh' } });
  check("an instance data directory outside the account's ~/.task is refused", r.status === 500 && /must be inside/.test(r.json?.error || ''), r.text);
  r = await request('POST', '/api/taskwarrior/export', { body: { dataPath: '/data/.task' } });
  check("the server's shared /data/.task is refused too", r.status === 500 && /must be inside/.test(r.json?.error || ''), r.text);
  r = await request('POST', '/api/taskwarrior/instances/init', { body: { rcPath: '~/.task/personal/taskrc', dataPath: '~/.task/personal', config: { color: 'off' } } });
  check("an instance under ~/.task initializes under the account's home", r.status === 200 && fs.existsSync(path.join(dataDir, 'users', aliceId, '.task', 'personal', 'taskrc')), r.text);
  r = await request('PUT', '/api/settings', { body: { values: { TASKDATA: '/data/.ssh' } } });
  check('settings cannot set a process-steering variable', r.status === 400 && fs.readFileSync(envFile, 'utf8') === envBefore, r.text);

  // ---- a second account: isolated from the first ---------------------------------
  r = await request('POST', '/api/admin/users', { body: { username: 'bob', password: 'bobs password', displayName: 'Bob' } });
  check('the administrator creates a second account', r.status === 201 && r.json?.user?.username === 'bob', r.text);
  r = await request('POST', '/api/auth/login', { body: { username: 'bob', password: 'bobs password' }, anonymous: true });
  const bobCookie = ((r.headers?.['set-cookie'] || [])[0] || '').split(';')[0];
  const bobId = r.json?.user?.id;
  check('bob signs in', r.status === 200 && bobCookie.startsWith('__Host-jacarium_session='), r.text);
  r = await request('GET', '/api/settings', { cookie: bobCookie });
  check("bob does not see alice's settings", r.status === 200 && !r.json?.values?.JIRA_EMAIL && !r.json?.secrets?.JIRA_PAT && !r.text.includes(SECRET), r.text);
  r = await request('POST', '/api/taskwarrior/export', { body: { dataPath: `/data/users/${aliceId}/.task` }, cookie: bobCookie });
  check("bob cannot read alice's Taskwarrior data", r.status === 500 && /must be inside/.test(r.json?.error || ''), r.text);
  r = await request('GET', '/api/capabilities', { cookie: bobCookie });
  check("bob's reports root is his own", r.json?.reportsRoot === `/data/users/${bobId}/reports`, r.text);
  r = await request('GET', '/api/admin/users', { cookie: bobCookie });
  check('bob is no administrator (403 on admin routes)', r.status === 403);
  // ---- synchronisation: the account's data on the server -----------------------
  r = await request('GET', '/api/sync/status');
  check('sync is enabled for a signed-in account', r.status === 200 && r.json?.enabled === true && r.json?.latest === 0, r.text);
  r = await request('POST', '/api/sync/push', { body: { device: 'test-device', changes: [{ collection: 'documents', key: 'sid-synthetic-1', baseRev: 0, updatedAt: Date.now(), deleted: false, body: { title: 'Synthetic doc', content: 'hello', category: 'General', stableId: 'sid-synthetic-1' } }] } });
  check('a change is accepted (rev 1)', r.status === 200 && r.json?.results?.[0]?.status === 'ok' && r.json?.results?.[0]?.rev === 1, r.text);
  r = await request('GET', '/api/sync/pull?since=0');
  check('the change feed returns it', r.status === 200 && r.json?.changes?.[0]?.key === 'sid-synthetic-1' && r.json?.changes?.[0]?.body?.title === 'Synthetic doc', r.text);
  check("the account's sync store lives under its home on the volume", fs.existsSync(path.join(dataDir, 'users', aliceId, 'sync.sqlite')));
  r = await request('GET', '/api/sync/pull?since=0', { cookie: bobCookie });
  check("bob's feed does not contain alice's record", r.status === 200 && (r.json?.changes || []).length === 0, r.text);
  r = await request('GET', '/api/sync/status', { anonymous: true });
  check('the sync routes need a session', r.status === 401);
  caps = await request('GET', '/api/capabilities');
  check('capabilities announce sync', caps.json?.capabilities?.sync === true);

  r = await request('POST', '/api/auth/logout', { cookie: bobCookie });
  check('bob signs out', r.status === 200);
  r = await request('GET', '/api/auth/me', { cookie: bobCookie });
  check("...and his cookie is dead", r.status === 401);

  // ---- the open deployment (JACARIUM_AUTH_MODE=none) still works -----------------
  const NONE = `${NAME}-none`;
  const noneData = fs.mkdtempSync(path.join(os.tmpdir(), 'jacarium-container-none-'));
  const noneStarted = run(['run', '-d', '--name', NONE, '-p', `${BIND}:${PORT + 1}:8443`, '-v', `${noneData}:/data:Z,U`, '-e', 'JACARIUM_AUTH_MODE=none', IMAGE]);
  check('a container without sign-in starts', noneStarted.status === 0, noneStarted.stderr);
  let noneHealth = null;
  for (let i = 0; i < 90 && !noneHealth; i++) {
    const h = await request('GET', '/health', { port: PORT + 1, anonymous: true });
    if (h.status === 200) noneHealth = h; else await sleep(2000);
  }
  r = await request('GET', '/api/capabilities', { port: PORT + 1, anonymous: true });
  check('...reports auth mode "none" and the shared reports root', noneHealth && r.json?.authMode === 'none' && r.json?.reportsRoot === '/data/reports', r.text);
  r = await request('GET', '/api/taskwarrior/check', { port: PORT + 1, anonymous: true });
  check('...and answers an API route without any session', r.status === 200, r.text);
  check('...with no setup code written', !fs.existsSync(path.join(noneData, 'setup-code')));
  run(['rm', '-f', NONE]);
  fs.rmSync(noneData, { recursive: true, force: true });

  // ---- Socket.IO through the proxy ---------------------------------------------------
  const sio = await request('GET', '/socket.io/?EIO=4&transport=polling', { json: false });
  check('the Socket.IO endpoint answers a polling handshake through the proxy', sio.status === 200 && /^0\{"sid"/.test(sio.text), `${sio.status} ${sio.text.slice(0, 60)}`);

  // ---- the central server in the container ----------------------------------------------
  await centralInContainer();

} catch (error) {
  check('the run completed', false, error.message);
} finally {
  cleanup();
}

async function centralInContainer() {
  const { createRequire } = await import('node:module');
  const { io: ioClient } = createRequire(path.join(REPO, 'package.json'))('socket.io-client');
  const sockets = [];
  const OFF = `${NAME}-off`;
  const offData = fs.mkdtempSync(path.join(os.tmpdir(), 'jacarium-container-off-'));
  const done = () => {
    for (const s of sockets) { try { s.disconnect(); } catch { /* closed */ } }
    if (process.env.CONTAINER_TEST_KEEP === '1') { console.log(`kept: container ${OFF}`); return; }
    run(['rm', '-f', OFF]);
    fs.rmSync(offData, { recursive: true, force: true });
  };
  try {
    let r = await request('GET', '/central/api/health', { anonymous: true });
    check('central: /central/api/health is the central server, through the console origin, with account sign-in on', r.status === 200 && r.json?.status === 'ok' && r.json?.account_sign_in === true, `${r.status} ${r.text.slice(0, 120)}`);
    const logText = () => run(['logs', NAME]).stderr + run(['logs', NAME]).stdout;
    check('central: the entrypoint started it on loopback and the log carries its lines with a prefix', /starting the central server on 127\.0\.0\.1:3000/.test(logText()) && /\[central\] .*Pairing: closed/.test(logText()));
    check('central: the keys were generated 0600 under <data>/central/keys', ['yjs-encryption.key', 'account-ticket.key'].every((k) => { try { return (fs.statSync(path.join(dataDir, 'central', 'keys', k)).mode & 0o777) === 0o600 && fs.readFileSync(path.join(dataDir, 'central', 'keys', k), 'utf8').trim().length === 64; } catch { return false; } }));
    const key = fs.readFileSync(path.join(dataDir, 'central', 'keys', 'account-ticket.key'), 'utf8').trim();
    const cmdlines = run(['exec', NAME, 'sh', '-c', 'cat /proc/*/cmdline 2>/dev/null | tr "\\0" " "']).stdout || '';
    check('central: the keys are in no process argument', !cmdlines.includes(key) && cmdlines.includes('server.js'));
    check('central: only 8443 is published (the central server has no port of its own)', !/3000/.test(run(['port', NAME]).stdout || ''));
    r = await request('GET', '/api/version', { anonymous: true });
    check('central: /api/version announces the provided central server with account sign-in and protocol 2', r.json?.capabilities?.central?.provided === true && r.json?.capabilities?.central?.path === '/central' && r.json?.capabilities?.central?.accountSignIn === true && r.json?.protocol === 2, r.text.slice(0, 200));
    const polling = await request('GET', '/central/socket.io/?EIO=4&transport=polling', { anonymous: true, json: false });
    check('central: the Socket.IO polling handshake answers under /central/socket.io', polling.status === 200 && /^0\{"sid"/.test(polling.text), `${polling.status} ${polling.text.slice(0, 60)}`);
    r = await request('GET', '/central/api/pending?machine_id=x', { anonymous: true });
    check('central: an unauthenticated REST client is refused (401)', r.status === 401, `${r.status}`);
    r = await request('POST', '/central/api/register', { anonymous: true, body: { machine_id: 'browser-00000000@x' } });
    check('central: pairing is closed (403 ACCOUNT_SIGN_IN_ONLY): the account ticket is the only way in', r.status === 403 && r.json?.code === 'ACCOUNT_SIGN_IN_ONLY', `${r.status}`);
    r = await request('GET', '/central/api/health', { anonymous: true, headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', Origin: 'https://evil.example' } });
    check('central: a cross-site page is refused at /central too (403)', r.status === 403, `${r.status}`);
    r = await request('GET', '/central/api/health', { anonymous: true, headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'websocket', Origin: 'file://' } });
    check('central: the desktop renderer (Origin: file://) passes the guard', r.status === 200, `${r.status}`);
    // the signed-in administrator of this container (the session from the sign-in checks above)
    r = await request('POST', '/api/auth/central-ticket', { body: {} });
    const ticket = r.json?.ticket;
    const identity = r.json?.identity;
    check('central: the signed-in user gets a ticket for the central server', r.status === 200 && /^v1\./.test(ticket || '') && /@account-/.test(identity || ''), r.text.slice(0, 120));
    r = await request('POST', '/central/api/documents', { anonymous: true, headers: { 'X-Account-Ticket': ticket }, body: { machine_id: identity, document: { title: 'Runbook in the container', content: 'x', ownerId: identity, category: 'General', cloudLastUpdated: Date.now() } } });
    check('central: REST with the ticket works through /central', r.status === 200, `${r.status} ${r.text.slice(0, 100)}`);
    let registry = {};
    for (let i = 0; i < 20 && !registry[identity]; i++) { try { registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'central', 'data', 'clients.json'), 'utf8')); } catch { /* not written yet */ } if (!registry[identity]) await sleep(500); }
    check('central: the identity is on record under <data>/central/data as an account identity without a secret', !!registry[identity]?.account && !registry[identity]?.secretHash, JSON.stringify(registry).slice(0, 200));
    const origin = `https://${BIND}:${PORT}`;
    const connect = (headers, auth) => new Promise((resolve) => {
      const s = ioClient(origin, { path: '/central/socket.io', transports: ['websocket'], reconnection: false, rejectUnauthorized: false, extraHeaders: headers });
      sockets.push(s);
      const t = setTimeout(() => resolve({ timeout: true }), 8000);
      s.on('connect', () => { if (auth) s.emit('authenticate', auth); else resolve({ connected: true }); });
      s.on('authenticated', (a) => { clearTimeout(t); resolve(a); });
      s.on('connect_error', (e) => { clearTimeout(t); resolve({ error: e.message, status: e.description || e.context?.statusCode }); });
    });
    let a = await connect({ Origin: 'file://', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'websocket' }, { machine_id: identity, account_ticket: ticket });
    check('central: a desktop-style websocket (Origin: file://) through /central/socket.io authenticates with the ticket', a?.success === true && a.machine_id === identity, JSON.stringify(a));
    a = await connect({ Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'websocket' }, { machine_id: identity, account_ticket: ticket });
    check('central: a browser-style same-origin websocket authenticates too', a?.success === true, JSON.stringify(a));
    a = await connect({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'websocket' }, { machine_id: identity, account_ticket: ticket });
    check('central: a foreign page\'s websocket is refused by the proxy', !!a?.error, JSON.stringify(a));
    a = await connect({ Origin: 'file://', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'websocket' }, { machine_id: identity });
    check('central: a websocket without a ticket is refused', a?.success === false && typeof a.code === 'string', JSON.stringify(a));
    a = await connect({ Origin: 'file://', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'websocket' }, { machine_id: identity, account_ticket: `${ticket.slice(0, -4)}AAAA` });
    check('central: a tampered ticket is refused', a?.success === false && a.code === 'ACCOUNT_TICKET_INVALID', JSON.stringify(a));
    const rejectedFrom = (logText().match(/Account ticket rejected from (\S+):/g) || []).map((l) => l.replace(/^.*from /, '').replace(/:$/, ''));
    check('central: the refused tickets are logged with a client address (forwarded by Caddy)', rejectedFrom.length > 0 && rejectedFrom.every((ip) => /^(\d+\.){3}\d+$|^[0-9a-f:.]+$/i.test(ip)), `from ${rejectedFrom.join(',')}`);
    // supervision: the central server killed inside the container comes back; the console never went down
    const pidBefore = (run(['exec', NAME, 'cat', '/tmp/central.pid']).stdout || '').trim();
    run(['exec', NAME, 'sh', '-c', 'kill -9 $(cat /tmp/central.pid)']);
    let back = null;
    for (let i = 0; i < 30 && !back; i++) { await sleep(1000); const h = await request('GET', '/central/api/health', { anonymous: true }); const pid = (run(['exec', NAME, 'cat', '/tmp/central.pid']).stdout || '').trim(); if (h.status === 200 && pid && pid !== pidBefore) back = pid; }
    const consoleUp = await request('GET', '/health', { anonymous: true });
    check('central: killed inside the container, it is restarted in place while the console stays up', !!back && consoleUp.status === 200 && /central server exited with status 137; restarting in 1s/.test(logText()), `pid ${pidBefore} -> ${back}`);
    check('central: the container is still the same one (no container restart)', (run(['inspect', '--format', '{{.State.Health.Status}}', NAME]).stdout || '').trim() === 'healthy' && (run(['inspect', '--format', '{{.RestartCount}}', NAME]).stdout || '').trim() === '0');

    // JACARIUM_CENTRAL=off: no central server, no route, no team features
    const OFFPORT = PORT + 3;
    const offStart = run(['run', '-d', '--name', OFF, '-p', `${BIND}:${OFFPORT}:8443`, '-e', 'JACARIUM_CENTRAL=off', '-v', `${offData}:/data:Z,U`, IMAGE]);
    check('central: a container with JACARIUM_CENTRAL=off starts', offStart.status === 0, offStart.stderr);
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { const h = await request('GET', '/health', { port: OFFPORT, anonymous: true }); if (h.status === 200) up = true; else await sleep(1000); }
    r = await request('GET', '/central/api/health', { port: OFFPORT, anonymous: true });
    check('central: ...it has no /central route (the block is stripped, not a 502) and no keys were generated', up && r.status !== 200 && r.status !== 502 && r.json?.account_sign_in === undefined && !fs.existsSync(path.join(offData, 'central')), `${r.status}`);
    r = await request('GET', '/api/version', { port: OFFPORT, anonymous: true });
    check('central: ...and /api/version says no central server is provided (the app shows the hint, no errors)', r.json?.capabilities?.central?.provided === false, r.text.slice(0, 120));
    check('central: ...and its log says so', /no central server \(JACARIUM_CENTRAL=off\)/.test(run(['logs', OFF]).stderr + run(['logs', OFF]).stdout));
  } finally {
    done();
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
