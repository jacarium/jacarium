#!/usr/bin/env node
/**
 * The desktop's settings scope (electron/account-settings.cjs): "This
 * device" or "My account", enforced as a whole.
 *
 * A REAL accounts-mode backend plays the home server; a stub local backend
 * records what the main process pushes to /api/internal/settings; a fake
 * safeStorage is the keychain. Proved:
 *   1. the scope starts as "device": no overlay is pushed; My account cannot
 *      be chosen while not linked;
 *   2. linked + My account: the account's RESOLVED settings (its file over
 *      the server defaults) are fetched with the device token, the overlay
 *      pushed to the local backend carries plain AND secret values, the
 *      cache file is encrypted (the fake keychain) and 0600, and state()
 *      (what the renderer gets) holds plain values, secrets as set / not
 *      set and the sources - never a secret value; the log never carries
 *      one;
 *   3. a change made "on the phone" (a browser session PUT) reaches the
 *      overlay on the next refresh;
 *   4. write() saves to the account over the token with ifRevision; a
 *      stale revision surfaces as a 409 error with the conflicts;
 *   5. offline: with the server down the cached values still run the
 *      overlay and state() says offline;
 *   6. switching back to This device drops the overlay at once; My account
 *      again re-installs it from the cache before the server answers;
 *   7. copyFromDevice() PUTs the chosen plain keys and secrets (by name)
 *      from the device file to the account;
 *   8. a revoked token (401) wipes the cache, drops the overlay and flips
 *      the scope back to the device; wipe() on unlink does the same.
 * Run: node tests/electron-account-settings.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const { createAccountSettings } = require_(path.join(REPO, 'electron', 'account-settings.cjs'));
const homeServer = require_(path.join(REPO, 'electron', 'home-server.cjs'));
const PYTHON = fs.existsSync(path.join(REPO, 'backend', 'venv', 'bin', 'python')) ? path.join(REPO, 'backend', 'venv', 'bin', 'python') : 'python3';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ---- the home server: a real accounts-mode backend ----
const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'account-settings-data-'));
function startBackend() {
  return spawn(PYTHON, ['app.py'], {
    cwd: path.join(REPO, 'backend'),
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_'))), HOME: DATA, PORT: String(PORT), JACARIUM_AUTH_MODE: 'accounts', JACARIUM_REPORTS_ROOT: path.join(DATA, 'reports'), JACARIUM_KNOWN_HOSTS: path.join(DATA, '.ssh', 'known_hosts') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
let backend = startBackend();
let backendLog = '';
backend.stdout.on('data', (d) => { backendLog += d; });
backend.stderr.on('data', (d) => { backendLog += d; });
const BASE = `http://127.0.0.1:${PORT}`;
async function waitUp() { for (let i = 0; i < 300; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* not yet */ } await sleep(250); } return false; }
if (!(await waitUp())) { console.log('FAIL: backend did not start\n' + backendLog.slice(-1200)); process.exit(1); }
const CSRF = { 'X-Requested-With': 'Jacarium', 'Content-Type': 'application/json' };
const setupCode = fs.readFileSync(path.join(DATA, 'setup-code'), 'utf8').trim();
const setup = await fetch(`${BASE}/api/auth/setup`, { method: 'POST', headers: CSRF, body: JSON.stringify({ setupCode, username: 'alice', password: 'alices password' }) });
const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];
const asAlice = (pathName, init = {}) => fetch(`${BASE}${pathName}`, { ...init, headers: { ...CSRF, Cookie: cookie, ...(init.headers || {}) } });
await asAlice('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ values: { DEFAULT_AI_TEMPERATURE: '0.2' }, secrets: { OPENAI_API_KEY: 'sk-everyone-openai' } }) });
await asAlice('/api/settings', { method: 'PUT', body: JSON.stringify({ values: { DEFAULT_AI_PROVIDER: 'ollama', DEFAULT_AI_MODEL: 'qwen3:30b', CUSTOM_AI_ENDPOINT: 'http://ollama.lan:11434/api/chat' }, secrets: { ANTHROPIC_API_KEY: 'sk-ant-account-secret' } }) });

// ---- the stub local backend: records the overlay pushes ----
const pushes = [];
const local = http.createServer((rq, rs) => {
  let data = ''; rq.on('data', (c) => { data += c; });
  rq.on('end', () => { pushes.push({ url: rq.url, token: rq.headers['x-app-token'], body: data ? JSON.parse(data) : null }); rs.setHeader('Content-Type', 'application/json'); rs.end(JSON.stringify({ ok: true })); });
});
await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
const LOCAL = `http://127.0.0.1:${local.address().port}`;
const localBackend = { post: async (pathName, body) => { const r = await fetch(`${LOCAL}${pathName}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': 'app-token-test' }, body: JSON.stringify(body) }); return { ok: r.ok, status: r.status, text: await r.text() }; } };
const lastPush = () => pushes[pushes.length - 1]?.body;

// ---- the profile: a fake keychain, the home-server link, the scope controller ----
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'account-settings-profile-'));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(`enc:${Buffer.from(t).toString('base64')}`), decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString() };
const linkCtx = { storePath: path.join(WORK, 'home-server.json'), pinsPath: path.join(WORK, 'pins.json'), safeStorage };
const logLines = [];
const changes = [];
const controller = createAccountSettings({
  dir: WORK, safeStorage,
  homeServer: { fetch: (p, init) => homeServer.homeServerFetch(p, init, linkCtx), linked: () => homeServer.homeServerStatus(linkCtx).linked },
  localBackend, log: (m) => logLines.push(m), onChange: (s) => changes.push(s),
});
const SECRETS = ['sk-ant-account-secret', 'sk-everyone-openai', 'sk-device-jira-pat'];
const noSecretIn = (text) => !SECRETS.some((s) => String(text).includes(s));

try {
  // 1. not linked
  check('1. the scope starts as "device"', controller.scope() === 'device');
  let st = await controller.refresh();
  check('   refresh on the device scope only tells the local backend "off" (no account values anywhere)', pushes.length === 1 && lastPush().active === false && !lastPush().values && st.scope === 'device' && st.available === false, JSON.stringify(st));
  let err = null; try { await controller.setScope('account'); } catch (e) { err = e; }
  check('   My account cannot be chosen while not linked', /Link this profile/.test(err?.message || ''), err?.message);

  // 2. link, My account
  await homeServer.linkHomeServer({ url: BASE, username: 'alice', password: 'alices password', deviceName: 'test mac', ...linkCtx });
  st = await controller.setScope('account');
  check('2. My account: the resolved settings arrive (account over everyone) and the overlay is pushed with plain AND secret values', st.scope === 'account' && st.available && lastPush()?.active === true && lastPush().values.DEFAULT_AI_PROVIDER === 'ollama' && lastPush().values.DEFAULT_AI_TEMPERATURE === '0.2' && lastPush().values.ANTHROPIC_API_KEY === 'sk-ant-account-secret' && lastPush().values.OPENAI_API_KEY === 'sk-everyone-openai', JSON.stringify(lastPush()));
  check('   the push carries the app token to the loopback backend', pushes[pushes.length - 1].token === 'app-token-test' && pushes[pushes.length - 1].url === '/api/internal/settings');
  check('   state() for the renderer: plain values, secrets as set / not set, the sources - no secret value anywhere in it', st.values.DEFAULT_AI_PROVIDER === 'ollama' && st.secrets.ANTHROPIC_API_KEY === true && st.secrets.OPENAI_API_KEY === true && st.sources.DEFAULT_AI_PROVIDER === 'account' && st.sources.DEFAULT_AI_TEMPERATURE === 'everyone' && noSecretIn(JSON.stringify(st)) && typeof st.lastSynced === 'string', JSON.stringify(st));
  const cacheRaw = fs.readFileSync(controller.files.cacheFile, 'utf8');
  check('   the cache file is encrypted with the keychain (no secret in clear), 0600', /"encrypted"/.test(cacheRaw) && noSecretIn(cacheRaw) && (fs.statSync(controller.files.cacheFile).mode & 0o777) === 0o600);
  check('   the log never carries a value, only counts and key names', logLines.length > 0 && noSecretIn(logLines.join('\n')), logLines.join(' | '));
  check('   onChange told the renderer', changes.length >= 1);

  // 3. the phone changes the model
  await asAlice('/api/settings', { method: 'PUT', body: JSON.stringify({ values: { DEFAULT_AI_PROVIDER: 'ollama', DEFAULT_AI_MODEL: 'llama3', CUSTOM_AI_ENDPOINT: 'http://ollama.lan:11434/api/chat' }, secrets: {} }) });
  const before = pushes.length;
  st = await controller.refresh();
  check('3. a change made on the phone reaches the overlay on the next refresh', pushes.length === before + 1 && lastPush().values.DEFAULT_AI_MODEL === 'llama3' && st.values.DEFAULT_AI_MODEL === 'llama3', JSON.stringify(lastPush()?.values?.DEFAULT_AI_MODEL));
  const same = pushes.length;
  await controller.refresh();
  check('   an unchanged account is not pushed again', pushes.length === same);

  // 4. write with revisions
  const revBefore = st.revisions.DEFAULT_AI_MODEL;
  err = null;
  try { await controller.write({ values: { DEFAULT_AI_MODEL: 'mistral' }, secrets: {}, ifRevision: { DEFAULT_AI_MODEL: revBefore - 1 } }); } catch (e) { err = e; }
  check('4. a save with a stale ifRevision is refused with the conflicts (409)', err?.status === 409 && err.conflicts?.[0]?.key === 'DEFAULT_AI_MODEL', err?.message);
  st = await controller.write({ values: { DEFAULT_AI_MODEL: 'mistral' }, secrets: { JIRA_PAT: 'sk-device-jira-pat' }, ifRevision: { DEFAULT_AI_MODEL: revBefore } });
  check('   a save with the current revision goes to the account and comes back in the overlay (secret included, state says set)', st.values.DEFAULT_AI_MODEL === 'mistral' && st.secrets.JIRA_PAT === true && lastPush().values.JIRA_PAT === 'sk-device-jira-pat' && noSecretIn(JSON.stringify(st)), JSON.stringify(st.values));
  const phone = await (await asAlice('/api/settings')).json();
  check('   ...the phone sees it too (the same file)', phone.values.DEFAULT_AI_MODEL === 'mistral' && phone.secrets.JIRA_PAT === true);

  // 5. offline
  backend.kill('SIGTERM'); await sleep(600);
  const controller2 = createAccountSettings({ dir: WORK, safeStorage, homeServer: { fetch: (p, init) => homeServer.homeServerFetch(p, init, linkCtx), linked: () => true }, localBackend, log: (m) => logLines.push(m) });
  const beforeOffline = pushes.length;
  st = await controller2.refresh();
  check('5. offline (the server down): the keychain cache runs the overlay and state() says offline with the last-synced time', pushes.length === beforeOffline + 1 && lastPush().active === true && lastPush().values.DEFAULT_AI_MODEL === 'mistral' && lastPush().values.ANTHROPIC_API_KEY === 'sk-ant-account-secret' && st.offline === true && st.available && typeof st.lastSynced === 'string', JSON.stringify({ offline: st.offline, model: st.values.DEFAULT_AI_MODEL }));
  backend = startBackend(); backend.stdout.on('data', (d) => { backendLog += d; }); backend.stderr.on('data', (d) => { backendLog += d; });
  check('   the backend restarts for the rest', await waitUp());

  // 6. the switch
  st = await controller2.setScope('device');
  check('6. This device: the overlay is dropped at once', lastPush().active === false && st.scope === 'device');
  st = await controller2.setScope('account');
  check('   My account again: re-installed (from the server now)', lastPush().active === true && st.scope === 'account' && st.offline === false);

  // 7. the migration copy
  const copy = await controller2.copyFromDevice({ deviceValues: { JIRA_URL: 'https://jira.example.test', JIRA_PAT: 'sk-device-jira-pat', DEFAULT_AI_PROVIDER: 'anthropic', PATH: '/x' }, plainKeys: ['JIRA_URL', 'PATH'], secretKeys: ['JIRA_PAT', 'JIRA_URL'] });
  const after = await (await asAlice('/api/settings')).json();
  check('7. copyFromDevice puts the chosen plain keys and secrets (by name) on the account - a plain key named as a secret or a secret named as plain is skipped', copy.copied.sort().join() === 'JIRA_PAT,JIRA_URL' && after.values.JIRA_URL === 'https://jira.example.test' && after.secrets.JIRA_PAT === true && after.values.DEFAULT_AI_PROVIDER === 'ollama' && !('PATH' in after.values), JSON.stringify({ copied: copy.copied, values: after.values }));

  // 8. revocation
  const devices = await (await asAlice('/api/auth/devices')).json();
  await asAlice(`/api/auth/devices/${devices.devices[0].id}`, { method: 'DELETE' });
  st = await controller2.refresh();
  check('8. a revoked token (401): the cache is wiped, the overlay dropped and the scope back on the device', st.scope === 'device' && st.available === false && !fs.existsSync(controller2.files.cacheFile) && lastPush().active === false, JSON.stringify(st));
  // wipe on unlink
  await homeServer.linkHomeServer({ url: BASE, username: 'alice', password: 'alices password', deviceName: 'test mac 2', ...linkCtx });
  await controller2.setScope('account');
  check('   (re-linked and on the account again)', controller2.scope() === 'account' && fs.existsSync(controller2.files.cacheFile));
  st = await controller2.wipe({ reason: 'unlink' });
  check('   wipe() on unlink: cache gone, scope file gone, overlay off', !fs.existsSync(controller2.files.cacheFile) && !fs.existsSync(controller2.files.scopeFile) && lastPush().active === false && st.scope === 'device');
  check('   the audit log on the server lists the fetches and saves by key name, no value', (() => { const log = fs.readFileSync(path.join(DATA, 'accounts-audit.log'), 'utf8'); return /settings-fetched-with-secrets/.test(log) && /settings-saved/.test(log) && noSecretIn(log); })());
} catch (e) {
  check('the run completed', false, `${e.message}\n${e.stack}`);
} finally {
  try { backend.kill('SIGTERM'); } catch { /* gone */ }
  local.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
