#!/usr/bin/env node
/**
 * Single sign-on end to end: the container image, a real identity provider
 * (Keycloak, pinned by digest, a throwaway realm of synthetic users:
 * tests/fixtures/sso/keycloak-realm.json) and a real browser (Playwright
 * Chromium), plus the desktop app's home-server link (electron/home-server.cjs,
 * the main-process module, against the same server).
 *
 * The two containers share one pod, so "localhost" is the same place for the
 * browser, for Jacarium's backend and for Keycloak: the issuer is
 * http://localhost:<KC port> (the development override for http on localhost)
 * and Jacarium is https://localhost:<port> with its self-signed certificate.
 * Single sign-on is configured through /data/sso.env, rewritten between the
 * phases and picked up by a container restart.
 *
 *   0. no sso.env, on an accounts database of the previous release: the
 *      migration ran (backup next to it), the administrator's old password
 *      signs in, and nothing of single sign-on shows - login page, Settings,
 *      Users;
 *   1. configured, default (linked accounts only): the button; a Keycloak
 *      sign-in without an account is refused with our text; an invalid, a
 *      replayed and a foreign-browser callback are refused; error_description
 *      is not reflected; the administrator links an identity from Settings
 *      (password, then Keycloak), signs out, signs in with it, sees it in
 *      Users, unlinks it; an administrator's invite links a verified email;
 *      the SSO-only account confirms with SSO and sets its first password;
 *      the desktop links with that password and administers with a step-up;
 *   2. auto-create with an allow-list and an administrator group: a staff
 *      member gets an account, a guest is refused, the Keycloak user NAMED
 *      "admin" gets nothing of the administrator's, the group member is an
 *      administrator;
 *   3. passwords for administrators only, and sign-out at the provider;
 *   4. sso.env removed again: the page is as in 0, passwords work, the
 *      SSO-only account gets a password from the administrator.
 * Screenshots (light, dark, large text) go to SSO_E2E_SHOTS when set.
 *
 * Needs podman (or docker with pods: not supported, SKIP), playwright-core
 * with Chromium, the backend venv, and an image of this tree:
 *   SSO_E2E_IMAGE=localhost/jacarium:sso-e2e node tests/sso-keycloak-live.test.mjs
 * Without SSO_E2E_IMAGE the test builds one (deploy/Containerfile, cached).
 * Ports: SSO_E2E_PORT (18446) and SSO_E2E_KC_PORT (18081). SSO_E2E_KEEP=1
 * leaves the pod and the data for inspection.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const PORT = Number(process.env.SSO_E2E_PORT || 18446);
const KC_PORT = Number(process.env.SSO_E2E_KC_PORT || 18081);
const BASE = `https://localhost:${PORT}`;
const ISSUER = `http://localhost:${KC_PORT}/realms/jacarium-demo`;
// Keycloak 26.8.2-2 (2026-11-12), the manifest list for amd64 and arm64
const KEYCLOAK = 'quay.io/keycloak/keycloak@sha256:c68e286cacd87b942ac1939a0a1481461109d6acd3a57dc496969a319a76bbf0';
const POD = `jacarium-sso-${process.pid}`;
const SHOTS = process.env.SSO_E2E_SHOTS || '';
const ADMIN_PASSWORD = 'synthetic-admin-password-1';
const KC = { alice: 'synthetic-alice-pass-1', bob: 'synthetic-bob-pass-1', rita: 'synthetic-rita-pass-1', carol: 'synthetic-carol-pass-1', adminsso: 'synthetic-adminsso-pass-1', admin: 'synthetic-impostor-pass-1' };

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail !== '' ? ' | ' + String(detail).slice(0, 700) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = (why) => { console.log(`SKIP: ${why}`); process.exit(0); };

if (process.env.SKIP_CONTAINER_TESTS === '1' || process.env.SKIP_BROWSER_TESTS) skip('SKIP_CONTAINER_TESTS / SKIP_BROWSER_TESTS is set');
if (spawnSync('podman', ['--version'], { stdio: 'ignore' }).status !== 0) skip('podman is not installed (the test needs a pod)');
if (spawnSync('podman', ['info'], { stdio: 'ignore' }).status !== 0) skip('podman is installed but its engine is not running');
let pw;
try { pw = require('playwright-core'); } catch { skip('playwright-core is not installed'); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(PYTHON)) skip('the backend venv is missing (it seeds the accounts database)');
const PLATFORM = { x64: 'linux/amd64', arm64: 'linux/arm64' }[process.arch];
if (!PLATFORM) skip(`no image platform for ${process.arch}`);
const run = (args, opts = {}) => spawnSync('podman', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { skip(`Chromium could not start (${String(e.message).split('\n')[0]})`); }

let IMAGE = process.env.SSO_E2E_IMAGE || '';
let builtHere = false;
if (!IMAGE) {
  IMAGE = `localhost/jacarium:sso-e2e-${process.pid}`;
  console.log(`Building ${IMAGE} (set SSO_E2E_IMAGE to use an image of this tree)...`);
  const build = run(['build', '--platform', PLATFORM, '--format', 'docker', '-f', path.join(REPO, 'deploy', 'Containerfile'), '-t', IMAGE, REPO], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (build.status !== 0) { console.log('FAIL: the image did not build\n' + (build.stderr || '').slice(-1500)); await browser.close(); process.exit(1); }
  builtHere = true;
}
if (run(['image', 'exists', IMAGE]).status !== 0) { await browser.close(); skip(`the image ${IMAGE} does not exist`); }
if (run(['image', 'exists', KEYCLOAK]).status !== 0) {
  console.log('Pulling Keycloak (pinned by digest)...');
  if (run(['pull', '-q', '--platform', PLATFORM, KEYCLOAK]).status !== 0) { await browser.close(); skip('Keycloak could not be pulled (no network?)'); }
}

// ---- the data volume: an accounts database as the previous release left it ---------------------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'jacarium-sso-e2e-'));
const DATA = path.join(WORK, 'data');
const REALM = path.join(WORK, 'realm');
fs.mkdirSync(DATA); fs.mkdirSync(REALM);
fs.writeFileSync(path.join(REALM, 'jacarium-demo-realm.json'), fs.readFileSync(path.join(here, 'fixtures', 'sso', 'keycloak-realm.json'), 'utf8').replaceAll('localhost:18446', `localhost:${PORT}`));
const SEED = `
import sqlite3, sys, time
sys.path.insert(0, sys.argv[2])
import accounts
c = sqlite3.connect(sys.argv[1], isolation_level=None)
c.executescript("""
CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0, oidc_subject TEXT, created_at REAL NOT NULL,
    password_changed_at REAL NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at REAL NOT NULL, last_seen REAL NOT NULL, user_agent TEXT);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE device_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at REAL NOT NULL, last_seen REAL, revoked INTEGER NOT NULL DEFAULT 0);
""")
now = time.time()
c.execute("INSERT INTO users VALUES ('11111111-1111-4111-8111-111111111111', 'admin', 'Site Administrator', ?, 'admin', 0, NULL, ?, ?, 0)", (accounts.hash_password(sys.argv[3]), now, now))
c.execute("INSERT INTO users VALUES ('22222222-2222-4222-8222-222222222222', 'dave', 'Dave Example', ?, 'user', 0, NULL, ?, ?, 0)", (accounts.hash_password(sys.argv[3]), now, now))
c.close()
`;
const seeded = spawnSync(PYTHON, ['-c', SEED, path.join(DATA, 'accounts.sqlite'), path.join(REPO, 'backend'), ADMIN_PASSWORD], { encoding: 'utf8' });
if (seeded.status !== 0) { console.log('FAIL: seeding the old database\n' + seeded.stderr.slice(-800)); await browser.close(); process.exit(1); }

function cleanup() {
  if (process.env.SSO_E2E_KEEP === '1') { console.log(`kept: pod ${POD}, data ${WORK}`); return; }
  run(['pod', 'rm', '-f', POD]);
  // the container wrote the volume as its own user: remove it from inside a throwaway container when needed
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { run(['unshare', 'rm', '-rf', WORK]); }
  if (builtHere) run(['rmi', IMAGE]);
}

// ---- HTTPS without a browser (the self-signed certificate) -----------------------------------------
function api(method, urlPath, { body, cookie = '', headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, rejectUnauthorized: false, timeout: 30000,
      headers: { 'X-Requested-With': 'Jacarium', Host: `localhost:${PORT}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', (e) => resolve({ status: 0, text: String(e), json: null, headers: {} }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}
async function passwordSession(username, password) {
  const r = await api('POST', '/api/auth/login', { body: { username, password } });
  return { status: r.status, json: r.json, cookie: (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ') };
}
const logs = () => { const r = run(['logs', `${POD}-app`]); return (r.stdout || '') + (r.stderr || ''); };
async function waitHealthy() {
  for (let i = 0; i < 120; i++) { const r = await api('GET', '/health'); if (r.status === 200 && r.json?.status === 'healthy') return true; await sleep(1500); }
  return false;
}
// rewrite /data/sso.env (null removes it) and restart the app container
async function configure(settings) {
  const file = path.join(DATA, 'sso.env');
  const text = settings === null ? null : ['# single sign-on for the end-to-end test', `JACARIUM_PUBLIC_URL=${BASE}`, `JACARIUM_OIDC_ISSUER=${ISSUER}`, 'JACARIUM_OIDC_CLIENT_ID=jacarium',
    'JACARIUM_OIDC_CLIENT_SECRET=synthetic-client-secret-for-tests', 'JACARIUM_OIDC_ALLOW_INSECURE_LOCALHOST=1', 'NOT_OURS=ignored', ...Object.entries(settings).map(([k, v]) => `JACARIUM_OIDC_${k}=${v}`)].join('\n') + '\n';
  // written from inside the container: the volume belongs to its user
  const script = text === null ? 'rm -f /data/sso.env' : `cat > /data/sso.env <<'EOF_SSO'\n${text}EOF_SSO\nchmod 644 /data/sso.env`;
  const wrote = run(['exec', `${POD}-app`, '/bin/sh', '-c', script]);
  if (wrote.status !== 0) throw new Error(`could not write sso.env: ${wrote.stderr}`);
  void file;
  run(['restart', '-t', '15', `${POD}-app`]);
  if (!(await waitHealthy())) throw new Error('the app container did not come back\n' + logs().slice(-1500));
}

// ---- the browser -----------------------------------------------------------------------------------
async function newContext({ dark = false, large = false, width = 1280, height = 860 } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
  await context.addInitScript(([isDark, isLarge]) => {
    try {
      localStorage.setItem('whatsNewLastSeen', '99.0.0');
      localStorage.setItem('app-theme', isDark ? 'dark' : 'light');
      if (isLarge) localStorage.setItem('documentsReadingAids', JSON.stringify({ textScale: 150, scaleChrome: true }));
    } catch { /* an opaque origin (Keycloak's pages are fine without it) */ }
  }, [dark, large]);
  return context;
}
const onApp = (page) => page.url().startsWith(BASE);
// the What's New window greets every new account: put it away, as a person would
async function dismissWhatsNew(page) {
  for (let i = 0; i < 8; i++) {
    const button = page.getByRole('button', { name: /^Got it!$/ });
    if (await button.count()) { await button.first().click().catch(() => {}); await sleep(200); return; }
    await sleep(250);
  }
}
async function settle(page) {
  // back on Jacarium and either the app (the rail) or the sign-in page is there
  await page.waitForFunction((base) => location.href.startsWith(base) && !location.pathname.startsWith('/api/') && (document.querySelector('nav.w-16') || document.querySelector('[data-testid="login-form"]')), BASE, { timeout: 60000 });
  await sleep(400);
  if (await page.$('nav.w-16')) await dismissWhatsNew(page);
  return { app: !!(await page.$('nav.w-16')), login: !!(await page.$('[data-testid="login-form"]')), alert: (await page.$('[role="alert"]')) ? (await page.textContent('[role="alert"]')).trim() : '', url: page.url() };
}
async function keycloakSignIn(page, username) {
  await page.waitForURL((u) => String(u).startsWith(`http://localhost:${KC_PORT}/`), { timeout: 30000 });
  await page.waitForSelector('#password', { timeout: 30000 });
  const name = await page.$('#username');
  if (name && await name.isEditable()) await name.fill(username);
  await page.fill('#password', KC[username]);
  await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), page.click('#kc-login')]);
}
/** The whole sign-in through the button; returns settle()'s answer. */
async function ssoSignIn(context, username) {
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.click('[data-testid="sso-sign-in"]');
  await keycloakSignIn(page, username);
  const state = await settle(page);
  return { page, ...state };
}
async function passwordSignIn(context, username, password) {
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="login-form"]');
  if (await page.$('[data-testid="admin-password-sign-in"]')) await page.click('[data-testid="admin-password-sign-in"]');
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[autocomplete="current-password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('nav.w-16') || document.querySelector('[role="alert"]'), null, { timeout: 60000 });
  await sleep(400);
  if (await page.$('nav.w-16')) await dismissWhatsNew(page);
  return { page, app: !!(await page.$('nav.w-16')), alert: (await page.$('[role="alert"]')) ? (await page.textContent('[role="alert"]')).trim() : '' };
}
const whoAmI = (page) => page.evaluate(async () => { const r = await fetch('/api/auth/me', { credentials: 'include' }); return r.ok ? (await r.json()).user : null; });
async function openSettings(page, tab = 'general') {
  await page.evaluate((t) => window.dispatchEvent(new CustomEvent('openAppSettings', { detail: { tab: t } })), tab);
  await page.waitForSelector(tab === 'users' ? '[data-testid="users-settings"]' : '[data-testid="account-section"]', { timeout: 30000 });
  await sleep(500);
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}
// the Users table's shape: headers, a row's buttons, and whether it fits its container without scrolling sideways
const usersTable = (page) => page.evaluate(() => { const t = document.querySelector('[data-testid="users-settings"] table'); return { headers: Array.from(t.querySelectorAll('th')).map((h) => h.textContent.trim()).filter(Boolean).join(),
  buttons: Array.from(t.querySelectorAll('[data-testid="user-row-admin"] td:last-child button')).map((b) => b.textContent.trim()).join(), fits: t.scrollWidth <= t.parentElement.clientWidth + 1 }; });
const signOut = async (page) => { await openSettings(page); await page.click('[data-testid="sign-out"]'); };

try {
  // ---- the pod ----------------------------------------------------------------------------------------
  let r = run(['pod', 'create', '--name', POD, '-p', `127.0.0.1:${PORT}:8443`, '-p', `127.0.0.1:${KC_PORT}:${KC_PORT}`]);
  if (r.status !== 0) throw new Error(`the pod could not be created (are ports ${PORT} / ${KC_PORT} free?): ${r.stderr}`);
  r = run(['run', '-d', '--pod', POD, '--name', `${POD}-kc`, '--pull=never', '-v', `${REALM}:/opt/keycloak/data/import:ro,Z`,
    '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=kcadmin', '-e', 'KC_BOOTSTRAP_ADMIN_PASSWORD=synthetic-kc-admin-pass-1',
    KEYCLOAK, 'start-dev', `--http-port=${KC_PORT}`, '--import-realm', `--hostname=http://localhost:${KC_PORT}`, '--http-management-port=19000']);
  check('Keycloak starts (pinned by digest, the synthetic realm imported)', r.status === 0, r.stderr);
  r = run(['run', '-d', '--pod', POD, '--name', `${POD}-app`, '--pull=never', '-v', `${DATA}:/data:Z,U`, IMAGE]);
  check('the Jacarium container starts in the same pod', r.status === 0, r.stderr);
  let discovery = null;
  for (let i = 0; i < 150 && !discovery; i++) { try { const d = await fetch(`${ISSUER}/.well-known/openid-configuration`); if (d.ok) discovery = await d.json(); } catch { /* not up yet */ } if (!discovery) await sleep(2000); }
  check('Keycloak serves the realm\'s discovery document with our issuer', discovery?.issuer === ISSUER, discovery ? discovery.issuer : (run(['logs', '--tail', '30', `${POD}-kc`]).stdout || '').slice(-900));
  if (!discovery) throw new Error('Keycloak did not come up');
  check('Jacarium answers /health over HTTPS', await waitHealthy(), logs().slice(-900));

  // ==== 0. not configured: an upgraded server, nothing of single sign-on =================================
  let log = logs();
  check('0: without sso.env the start-up line says single sign-on is off', /single sign-on: off/.test(log) && !/single sign-on: on/.test(log), log.split('\n').filter((l) => /sign-on/.test(l)).join(' | '));
  const listing = run(['exec', `${POD}-app`, 'ls', '/data']).stdout || '';
  check('0: the previous release\'s accounts database was migrated with a backup next to it', /accounts\.sqlite\.before-sso/.test(listing), listing);
  let caps = (await api('GET', '/api/capabilities')).json;
  check('0: capabilities: accounts mode, single sign-on off', caps?.auth?.mode === 'accounts' && caps.auth.sso?.enabled === false && caps.auth.setupRequired === false, JSON.stringify(caps?.auth));
  check('0: the SSO routes answer 404', (await api('POST', '/api/auth/sso/begin', { body: {} })).status === 404 && (await api('GET', '/api/auth/sso/callback?code=c&state=s')).status === 404);
  let ctx = await newContext();
  let page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="login-form"]');
  const plainLogin = await page.evaluate(() => ({ sso: document.querySelectorAll('[data-testid^="sso-"], [data-testid="admin-password-sign-in"]').length, inputs: document.querySelectorAll('[data-testid="login-form"] input').length,
    buttons: Array.from(document.querySelectorAll('[data-testid="login-form"] button')).map((b) => `${b.textContent.trim()}:${/btn-primary/.test(b.className)}`) }));
  check('0: the sign-in page is the plain one: two fields, one primary "Sign in", no SSO button', plainLogin.sso === 0 && plainLogin.inputs === 2 && plainLogin.buttons.join() === 'Sign in:true', JSON.stringify(plainLogin));
  await shot(page, '0-login-not-configured-light');
  await page.close();
  let signed = await passwordSignIn(ctx, 'admin', ADMIN_PASSWORD);
  check('0: the administrator signs in with the password the old database held; the app loads', signed.app && (await whoAmI(signed.page))?.username === 'admin', signed.alert);
  page = signed.page;
  await openSettings(page);
  check('0: Settings > General shows the account with its password form and no single sign-on part', !!(await page.$('[data-testid="account-password-form"]')) && !(await page.$('[data-testid="account-sso"]')) && !(await page.$('[data-testid="account-no-password"]'))
    && (await page.$$('[data-testid="account-password-form"] input')).length === 2);
  await shot(page, '0-settings-not-configured-light');
  await openSettings(page, 'users');
  const plainUsers = await page.evaluate(() => ({ headers: Array.from(document.querySelectorAll('[data-testid="users-settings"] th')).map((t) => t.textContent.trim()).filter(Boolean), sso: document.querySelectorAll('[data-testid^="user-sso-"], [data-testid="create-user-sso-email"]').length,
    buttons: Array.from(document.querySelectorAll('[data-testid="user-row-admin"] button')).map((b) => b.textContent.trim()).filter(Boolean).join() }));
  const plainTable = await usersTable(page);
  check('0: Settings > Users has its old columns and no single sign-on controls', plainUsers.headers.join() === 'Username,Name,Role,Status' && plainUsers.sso === 0 && plainUsers.buttons === 'Password,Demote,Disable,Delete', JSON.stringify(plainUsers));
  await ctx.close();

  // ==== 1. configured, default: linked accounts only ========================================================
  await configure({});
  log = logs();
  check('1: sso.env is read (five settings; a foreign name in it is ignored and said so)', /single sign-on: \d+ setting\(s\) read from \/data\/sso\.env/.test(log) && /sso\.env: ignoring NOT_OURS/.test(log) && /single sign-on: on, issuer http:\/\/localhost:\d+\/realms\/jacarium-demo; linked accounts only/.test(log),
    log.split('\n').filter((l) => /sign-on|sso\.env/.test(l)).slice(-5).join(' | '));
  check('1: the client secret is in no log line', !log.includes('synthetic-client-secret-for-tests'));
  caps = (await api('GET', '/api/capabilities')).json;
  check('1: capabilities: single sign-on on, passwords too, no auto-create', caps.auth.sso.enabled === true && caps.auth.sso.passwordLogin === true && caps.auth.sso.autoCreate === false && !JSON.stringify(caps).includes('synthetic-client-secret'), JSON.stringify(caps.auth.sso));
  for (const [name, options] of [['light', {}], ['dark', { dark: true }], ['large-text', { large: true }]]) {
    const c = await newContext(options);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForSelector('[data-testid="sso-sign-in"]');
    await sleep(500);
    const box = await p.evaluate(() => { const b = document.querySelector('[data-testid="sso-sign-in"]').getBoundingClientRect(); const s = document.querySelector('[data-testid="password-sign-in"]').getBoundingClientRect(); return { top: b.top, pwTop: s.top, w: b.width, vw: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }; });
    check(`1: the sign-in page (${name}): the SSO button above the password form, inside the window`, box.top < box.pwTop && box.w > 100 && !box.overflow, JSON.stringify(box));
    await shot(p, `1-login-configured-${name}`);
    await c.close();
  }

  // a Keycloak identity without an account
  ctx = await newContext();
  let result = await ssoSignIn(ctx, 'alice');
  check('1: alice signs in at Keycloak but has no account here: back on the sign-in page with OUR sentence, the code gone from the address', result.login && !result.app && /No account on this server is linked to that identity/.test(result.alert) && !/sso_error/.test(result.url), JSON.stringify({ alert: result.alert, url: result.url }));
  check('1: ...and she is not signed in', (await whoAmI(result.page)) === null);
  await shot(result.page, '1-login-refused-no-account');
  check('1: ...no account was created for her', !(await api('GET', '/api/admin/users', { cookie: (await passwordSession('admin', ADMIN_PASSWORD)).cookie })).json.users.some((u) => u.username === 'alice'));
  // hostile callbacks
  page = await ctx.newPage();
  await page.goto(`${BASE}/api/auth/sso/callback?code=made-up&state=made-up`, { waitUntil: 'load' });
  let landed = await settle(page);
  check('1: a made-up callback lands on the sign-in page: "did not start in this browser"', landed.login && /did not start in this browser/.test(landed.alert), landed.alert);
  await page.goto(`${BASE}/api/auth/sso/callback?error=server_error&error_description=${encodeURIComponent('Your account is locked. Call 555-0100')}`, { waitUntil: 'load' });
  landed = await settle(page);
  check('1: the provider\'s error_description is not shown anywhere on the page', landed.login && !(await page.content()).includes('555-0100') && /identity provider could not be reached or answered with an error/.test(landed.alert), landed.alert);
  await ctx.close();
  // a sign-in started in one browser and completed in another (login CSRF: the attacker starts it and hands the
  // victim the provider's address; the victim's browser comes back with a real code and state, but without the cookie)
  const a = await newContext(); const b = await newContext();
  const pa = await a.newPage();
  await pa.goto(BASE, { waitUntil: 'load' });
  const started = await pa.evaluate(async () => { const r = await fetch('/api/auth/sso/begin', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Jacarium' }, body: '{"purpose":"login"}' }); return { status: r.status, body: await r.json() }; });
  check('1: (browser A started a sign-in: the provider\'s address with a state, the sealed cookie in A only)', started.status === 200 && /state=/.test(started.body.url) && (await a.cookies(BASE)).some((c) => c.name === '__Host-jacarium_sso' && c.httpOnly && c.secure && c.sameSite === 'Lax'),
    JSON.stringify((await a.cookies(BASE)).map((c) => [c.name, c.httpOnly, c.secure, c.sameSite])));
  const pb = await b.newPage();
  let callbackSeen = '';
  pb.on('request', (request) => { if (request.url().includes('/api/auth/sso/callback')) callbackSeen = request.url(); });
  await pb.goto(started.body.url, { waitUntil: 'load' });
  await keycloakSignIn(pb, 'alice');
  landed = await settle(pb);
  check('1: browser B signed in at Keycloak with that address and came back with a real code and state: refused (state), B is signed in as nobody', /code=/.test(callbackSeen) && /state=/.test(callbackSeen) && landed.login && /did not start in this browser/.test(landed.alert) && (await whoAmI(pb)) === null,
    JSON.stringify({ callbackSeen: callbackSeen.slice(0, 80), alert: landed.alert }));
  // a completed sign-in cannot be completed again: browser A finishes its own round-trip with that answer (alice has
  // no account here, so it ends in "no account"), and the very same address a second time is refused as spent
  await pa.goto(callbackSeen, { waitUntil: 'load' });
  landed = await settle(pa);
  const firstUse = landed.alert;
  await pa.goto(callbackSeen, { waitUntil: 'load' });
  landed = await settle(pa);
  check('1: a callback address works once: used in the browser that started it, then refused when replayed', /No account on this server is linked/.test(firstUse) && landed.login && /did not start in this browser/.test(landed.alert) && (await whoAmI(pa)) === null, `${firstUse} | ${landed.alert}`);
  await a.close(); await b.close();

  // the administrator links an identity from Settings
  ctx = await newContext();
  signed = await passwordSignIn(ctx, 'admin', ADMIN_PASSWORD);
  page = signed.page;
  await openSettings(page);
  check('1: Settings > General now has the single sign-on part with a link form', !!(await page.$('[data-testid="account-sso-link-form"]')) && !(await page.$('[data-testid="account-sso-identity"]')));
  await shot(page, '1-settings-link-form-light');
  await page.fill('[data-testid="account-sso-password"]', 'not the password');
  await page.click('[data-testid="account-sso-link"]');
  await page.waitForFunction(() => /Wrong password/.test(document.querySelector('[data-testid="account-sso-status"]')?.textContent || ''), null, { timeout: 15000 });
  check('1: linking with a wrong password is refused there and then', onApp(page));
  await page.fill('[data-testid="account-sso-password"]', ADMIN_PASSWORD);
  await page.click('[data-testid="account-sso-link"]');
  await keycloakSignIn(page, 'adminsso');
  await settle(page);
  await page.waitForSelector('[data-testid="account-sso-identity"]', { timeout: 30000 });
  const linkedText = (await page.textContent('[data-testid="account-sso"]')).replace(/\s+/g, ' ');
  check('1: back from Keycloak the app is still signed in (the Strict session cookie survived the landing), Settings reopened on the linked identity', (await whoAmI(page))?.sso?.issuer === ISSUER && /Linked to localhost:\d+/.test(linkedText) && /Single sign-on is linked to this account/.test(linkedText) && !/sso=/.test(page.url()), linkedText);
  await shot(page, '1-settings-linked-light');
  await openSettings(page, 'users');
  check('1: Settings > Users says the administrator is linked, under Status; the table has the columns, buttons and width it had without single sign-on', (await page.textContent('[data-testid="user-sso-state-admin"]')).trim() === 'SSO linked' && !(await page.$('[data-testid="user-sso-state-dave"]'))
    && JSON.stringify(await usersTable(page)) === JSON.stringify(plainTable), JSON.stringify(await usersTable(page)));
  await page.click('[data-testid="user-row-dave"] button');
  await page.waitForSelector('[data-testid="user-sso-dave"]');
  check('1: a user\'s expanded row has the single sign-on part: not linked, "Approve an email"', /Not linked/.test(await page.textContent('[data-testid="user-sso-dave"]')) && !!(await page.$('[data-testid="user-sso-invite-dave"]')));
  await shot(page, '1-users-light');
  await signOut(page);
  await settle(page);
  check('1: signing out returns to the sign-in page (locally: no provider sign-out by default)', onApp(page) && !!(await page.$('[data-testid="login-form"]')));
  await ctx.close();
  ctx = await newContext();
  result = await ssoSignIn(ctx, 'adminsso');
  let who = await whoAmI(result.page);
  check('1: the linked identity signs in as the administrator: the app loads straight from the landing page', result.app && who?.username === 'admin' && who.role === 'admin' && !/sso=/.test(result.url), JSON.stringify({ alert: result.alert, who }));
  page = result.page;
  await openSettings(page);
  await page.fill('[data-testid="account-sso-password"]', ADMIN_PASSWORD);
  await page.click('[data-testid="account-sso-unlink"]');
  await page.waitForSelector('[data-testid="account-sso-link-form"]', { timeout: 15000 });
  check('1: unlinking with the password brings the link form back', (await whoAmI(page))?.sso === null && /Unlinked/.test(await page.textContent('[data-testid="account-sso-status"]')));
  await ctx.close();
  ctx = await newContext();
  result = await ssoSignIn(ctx, 'adminsso');
  check('1: the unlinked identity no longer signs in', result.login && /No account on this server is linked/.test(result.alert));
  await ctx.close();

  // the administrator's approval for a verified email; the SSO-only account sets its first password
  const adminCookie = (await passwordSession('admin', ADMIN_PASSWORD)).cookie;
  const created = await api('POST', '/api/admin/users', { cookie: adminCookie, body: { username: 'carol', displayName: 'Carol Example', ssoEmail: 'carol@example.test' } });
  check('1: the administrator creates carol without a password, waiting for her verified email', created.status === 201 && created.json.user.hasPassword === false && created.json.user.ssoInviteEmail === 'carol@example.test', created.text.slice(0, 200));
  ctx = await newContext();
  result = await ssoSignIn(ctx, 'carol');
  who = await whoAmI(result.page);
  check('1: carol signs in with Keycloak and is that account (linked by the approval, no password)', result.app && who?.username === 'carol' && who.hasPassword === false && who.sso?.issuer === ISSUER, JSON.stringify({ alert: result.alert, who }));
  page = result.page;
  await openSettings(page);
  check('1: her Settings say the account has no password and offer "Confirm with single sign-on"; no unlink (it would lock her out)', !!(await page.$('[data-testid="account-no-password"]')) && !!(await page.$('[data-testid="account-sso-confirm"]')) && !(await page.$('[data-testid="account-sso-unlink"]'))
    && (await page.$$('[data-testid="account-password-form"] input')).length === 1);
  await shot(page, '1-settings-sso-only-light');
  // make the session's SSO time old, as after a while, then set a password: refused until confirmed
  run(['exec', `${POD}-app`, 'python3.14', '-c', "import sqlite3; c = sqlite3.connect('/data/accounts.sqlite'); c.execute('UPDATE sessions SET sso_at = sso_at - 3600 WHERE sso_at IS NOT NULL'); c.commit()"]);
  await page.fill('[data-testid="account-new-password"]', 'synthetic-carol-local-1');
  await page.click('[data-testid="account-password-submit"]');
  await page.waitForFunction(() => /Confirm with single sign-on first/.test(document.querySelector('[data-testid="account-password-status"]')?.textContent || ''), null, { timeout: 15000 });
  check('1: an hour after her sign-in the first password is refused until she confirms with single sign-on', (await whoAmI(page))?.hasPassword === false);
  await page.click('[data-testid="account-sso-confirm"]');
  await keycloakSignIn(page, 'carol');
  await settle(page);
  await page.waitForFunction(() => /Confirmed with single sign-on/.test(document.querySelector('[data-testid="account-password-status"]')?.textContent || ''), null, { timeout: 30000 });
  check('1: Keycloak asked for her password again (prompt=login), and Settings reopened saying it is confirmed', onApp(page));
  await page.fill('[data-testid="account-new-password"]', 'synthetic-carol-local-1');
  await page.click('[data-testid="account-password-submit"]');
  await page.waitForFunction(() => /Password set/.test(document.querySelector('[data-testid="account-password-status"]')?.textContent || ''), null, { timeout: 15000 });
  who = await whoAmI(page);
  check('1: the password is set; the account now has both ways in and can unlink', who?.hasPassword === true && !!(await page.$('[data-testid="account-sso-unlink"]')) && (await passwordSession('carol', 'synthetic-carol-local-1')).status === 200);
  await ctx.close();

  // the desktop app's home-server link (the Electron main-process module) with that password
  const homeServer = require('../electron/home-server.cjs');
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'jacarium-sso-desktop-'));
  const desktop = { storePath: path.join(store, 'profile', 'home-server.json'), pinsPath: path.join(store, 'profile', 'central-server-cert-pins.json'),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(`enc:${Buffer.from(t).toString('base64')}`), decryptString: (buf) => Buffer.from(String(buf).slice(4), 'base64').toString() } };
  try {
    const linked = await homeServer.linkHomeServer({ url: BASE, username: 'carol', password: 'synthetic-carol-local-1', deviceName: 'sso test laptop', ...desktop });
    const meOverToken = await homeServer.homeServerFetch('/api/auth/me', {}, desktop);
    const body = JSON.parse(meOverToken.text || '{}');
    // administering from the desktop: a state-changing admin call needs the password once (step-up) - for an
    // account that also signs in with single sign-on exactly as for any other
    const stepUp = await homeServer.homeServerFetch('/api/auth/step-up', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Jacarium' }, body: JSON.stringify({ password: 'synthetic-carol-local-1' }) }, desktop);
    check('1: ...and the desktop\'s password step-up is accepted for her', stepUp.status === 200, `${stepUp.status} ${stepUp.text}`.slice(0, 200));
    check('1: the desktop links to the server as carol with the password she set (a device token; her identity shows over it)', linked.username === 'carol' && !!linked.deviceId && body?.user?.username === 'carol' && body.user.sso?.issuer === ISSUER, JSON.stringify({ linked, body }).slice(0, 300));
    await homeServer.unlinkHomeServer({ ...desktop });
  } catch (e) {
    check('1: the desktop links to the server as carol with the password she set', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e));
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
  let refused = null;

  // ==== 2. auto-create with an allow-list and an administrator group ============================================
  await configure({ AUTO_CREATE: '1', ALLOWED_GROUPS: 'staff', ADMIN_GROUPS: 'jacarium-admins' });
  check('2: the start-up line names the rules', /accounts are created at the first sign-in; allow-list: groups staff; administrators by group: jacarium-admins/.test(logs()));
  ctx = await newContext();
  result = await ssoSignIn(ctx, 'alice');
  who = await whoAmI(result.page);
  check('2: alice (staff) gets an account at her first sign-in: user, no password, her Keycloak name', result.app && who?.username === 'alice' && who.role === 'user' && who.hasPassword === false && who.displayName === 'Alice Example', JSON.stringify({ alert: result.alert, who }));
  await ctx.close();
  ctx = await newContext();
  result = await ssoSignIn(ctx, 'bob');
  check('2: bob (guests) is refused: not in a group that may use this server', result.login && /not in a group that may use this server/.test(result.alert) && (await whoAmI(result.page)) === null, result.alert);
  await ctx.close();
  ctx = await newContext();
  result = await ssoSignIn(ctx, 'admin');
  const adminNow = (await api('GET', '/api/admin/users', { cookie: adminCookie })).json.users.find((u) => u.username === 'admin');
  check('2: the Keycloak user NAMED "admin" (staff, verified email) is not the administrator: refused, told to link from Settings; the administrator stays unlinked', result.login && /not linked to your identity/.test(result.alert)
    && (await whoAmI(result.page)) === null && adminNow.sso === null, JSON.stringify({ alert: result.alert, adminNow }));
  await shot(result.page, '2-login-refused-takeover');
  await ctx.close();
  ctx = await newContext();
  result = await ssoSignIn(ctx, 'rita');
  who = await whoAmI(result.page);
  check('2: rita (jacarium-admins) is an administrator', result.app && who?.username === 'rita' && who.role === 'admin', JSON.stringify(who));
  page = result.page;
  await openSettings(page, 'users');
  const rows = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('[data-testid^="user-sso-state-"]')).map((e) => [e.dataset.testid.replace('user-sso-state-', ''), e.textContent.trim()])));
  check('2: Users lists who is linked and who has no password', rows.alice === 'SSO linked, no password' && rows.rita === 'SSO linked, no password' && rows.carol === 'SSO linked' && rows.admin === undefined && rows.dave === undefined, JSON.stringify(rows));
  await shot(page, '2-users-light');
  for (const [name, options] of [['dark', { dark: true }], ['large-text', { large: true }]]) {
    const c = await newContext(options);
    const s2 = await ssoSignIn(c, 'rita');
    await openSettings(s2.page);
    await s2.page.evaluate(() => document.querySelector('[data-testid="account-sso"]')?.scrollIntoView({ block: 'center' }));
    await sleep(400);
    const fits = await s2.page.evaluate(() => { const e = document.querySelector('[data-testid="account-sso"]'); const r = e.getBoundingClientRect(); const panel = e.closest('[role="dialog"]').getBoundingClientRect(); return { inside: r.left >= panel.left - 1 && r.right <= panel.right + 1, w: r.width }; });
    check(`2: Settings > General, the single sign-on part (${name}) stays inside the dialog`, fits.inside && fits.w > 200, JSON.stringify(fits));
    await shot(s2.page, `2-settings-sso-${name}`);
    await openSettings(s2.page, 'users');
    await shot(s2.page, `2-users-${name}`);
    await c.close();
  }
  const auditEntries = (await api('GET', '/api/admin/audit?limit=500', { cookie: adminCookie })).json.entries;
  const audit = auditEntries.map((e) => e.action);
  check('2: the audit log has the sign-ins, the creations with their role (rita: admin by group), the links, the unlink, the refusals, the confirmation and the desktop link', ['sso-sign-in', 'sso-user-created', 'sso-linked', 'sso-linked-by-invite', 'sso-unlinked', 'sso-refused', 'sso-link-refused', 'sso-confirmed', 'password-set', 'device-linked', 'step-up'].every((x) => audit.includes(x))
    && auditEntries.some((e) => e.action === 'sso-user-created' && e.fields.user === 'rita' && e.fields.role === 'admin') && auditEntries.some((e) => e.action === 'sso-user-created' && e.fields.user === 'alice' && e.fields.role === 'user'), [...new Set(audit)].join(','));
  await ctx.close();

  // ==== 3. passwords for administrators only; sign-out at the provider ============================================
  await configure({ AUTO_CREATE: '1', ALLOWED_GROUPS: 'staff', DISABLE_PASSWORD_LOGIN: '1', END_SESSION: '1' });
  ctx = await newContext();
  page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="sso-sign-in"]');
  check('3: the sign-in page shows the SSO button and a quiet administrator link; no password fields', (await page.$$('[data-testid="login-form"] input')).length === 0 && !!(await page.$('[data-testid="admin-password-sign-in"]')));
  await shot(page, '3-login-admins-only-light');
  await page.close();
  refused = await passwordSession('carol', 'synthetic-carol-local-1');
  check('3: carol\'s right password is refused (PASSWORD_LOGIN_DISABLED); a wrong one is 401 as ever', refused.status === 403 && refused.json?.code === 'PASSWORD_LOGIN_DISABLED' && (await passwordSession('carol', 'wrong-password-x')).status === 401);
  signed = await passwordSignIn(ctx, 'admin', ADMIN_PASSWORD);
  check('3: the administrator still gets in with the password, through the link (the way back in if the provider is down)', signed.app && (await whoAmI(signed.page))?.username === 'admin', signed.alert);
  await ctx.close();
  ctx = await newContext();
  result = await ssoSignIn(ctx, 'alice');
  page = result.page;
  await openSettings(page);
  await Promise.all([page.waitForURL((u) => String(u).startsWith(`http://localhost:${KC_PORT}/realms/jacarium-demo/protocol/openid-connect/logout`), { timeout: 30000 }), page.click('[data-testid="sign-out"]')]);
  check('3: signing out of an SSO session goes on to Keycloak\'s sign-out page, naming our client and return address', /client_id=jacarium/.test(page.url()) && page.url().includes(encodeURIComponent(`${BASE}/`)), page.url());
  const gone = await ctx.newPage();
  await gone.goto(BASE, { waitUntil: 'load' });
  check('3: ...and the Jacarium session is over', (await settle(gone)).login && (await whoAmI(gone)) === null);
  await ctx.close();

  // ==== 4. turned off again ===========================================================================================
  await configure(null);
  check('4: without sso.env the next start says off again', /single sign-on: off/.test(logs().split('\n').filter((l) => /single sign-on:/.test(l)).pop() || ''));
  ctx = await newContext();
  page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="login-form"]');
  check('4: the sign-in page is the plain one again', (await page.$$('[data-testid^="sso-"]')).length === 0 && (await page.$$('[data-testid="login-form"] input')).length === 2);
  await page.close();
  signed = await passwordSignIn(ctx, 'carol', 'synthetic-carol-local-1');
  check('4: carol (linked, with a password) signs in with her password', signed.app && (await whoAmI(signed.page))?.username === 'carol', signed.alert);
  await openSettings(signed.page);
  check('4: her Settings show no single sign-on part while it is off', !(await signed.page.$('[data-testid="account-sso"]')) && (await signed.page.$$('[data-testid="account-password-form"] input')).length === 2);
  await ctx.close();
  check('4: alice (single sign-on only) cannot sign in with any password', (await passwordSession('alice', 'synthetic-alice-pass-1')).status === 401);
  const aliceId = (await api('GET', '/api/admin/users', { cookie: adminCookie })).json.users.find((u) => u.username === 'alice').id;
  const reset = await api('POST', `/api/admin/users/${aliceId}/password`, { cookie: (await passwordSession('admin', ADMIN_PASSWORD)).cookie, body: { newPassword: 'synthetic-alice-local-1' } });
  check('4: the administrator sets a password for her, and she signs in', reset.status === 200 && (await passwordSession('alice', 'synthetic-alice-local-1')).status === 200, reset.text.slice(0, 200));
  check('4: the SSO routes are 404 again', (await api('POST', '/api/auth/sso/begin', { body: {} })).status === 404);
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 5).join(' ') : String(e));
  console.log(String(e && e.message).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2500));
  if (process.env.SSO_E2E_DEBUG) console.log(logs().slice(-3000));
} finally {
  try { await browser.close(); } catch { /* gone */ }
  cleanup();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
