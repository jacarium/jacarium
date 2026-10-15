#!/usr/bin/env node

/**
 * Smoke-test that the app still BOOTS after a dependency update
 * (npm audit fix, version bumps, lockfile churn).
 *
 * What it checks, in order:
 *  1. Vite dev server: starts `npm run dev` (or reuses one already
 *     listening on :5173), waits for it, and asserts the index HTML
 *     serves with the #root mount point.
 *  2. Electron shell: launches the REAL Electron binary against the dev
 *     server via playwright-core's _electron driver, waits for React to
 *     mount children into #root, lets async init (sockets, IPC, backend
 *     probes) settle, performs one real interaction (clicks the first
 *     visible nav button), and screenshots to /tmp/shots/.
 *  3. Asserts ZERO uncaught page errors in the renderer, and no console
 *     [error] lines other than known-benign local-config noise (missing
 *     JIRA_PAT credentials - expected on machines without a .env).
 *
 * Deliberately NOT named *.test.mjs: tests/run-all.sh auto-runs that
 * glob, and this check opens a GUI window, takes ~1 minute, and may
 * download the Electron binary - run it by hand after dependency
 * updates instead:
 *
 *   node tests/smoke-boot-after-dep-update.mjs
 *
 * Dependencies (auto-handled, per the run-all.sh --no-save convention;
 * neither touches package.json/package-lock.json):
 *  - playwright-core: auto-installed with `npm install --no-save` if
 *    missing. Remove again afterwards with `npm prune` if you care.
 *  - Electron binary: `npm audit fix` / lockfile-driven installs can
 *    bump the electron package WITHOUT downloading the new binary
 *    (empty node_modules/electron/dist/). Auto-repaired by running
 *    node_modules/electron/install.js.
 *
 * Exit code: 0 = app boots cleanly, 1 = any check failed.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_URL = 'http://localhost:5173/';
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/shots';
// Console [error] lines matching any of these are expected local-config
// noise (no credentials on this machine), not boot failures.
const BENIGN_ERROR_PATTERNS = [/JIRA_PAT/i];

const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 0. Preflight: playwright-core + Electron binary ----------

if (!existsSync(path.join(REPO_ROOT, 'node_modules'))) {
  fail('node_modules/ missing - run: npm install');
}

if (!existsSync(path.join(REPO_ROOT, 'node_modules', 'playwright-core'))) {
  console.log('playwright-core missing - installing (npm install --no-save playwright-core)...');
  execFileSync('npm', ['install', '--no-save', 'playwright-core'], {
    cwd: REPO_ROOT, stdio: 'inherit',
  });
}

const electronBin = process.platform === 'darwin'
  ? path.join(REPO_ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(REPO_ROOT, 'node_modules/electron/dist/electron');
if (!existsSync(electronBin)) {
  console.log('Electron binary missing (lockfile-only update skipped the download) - fetching...');
  execFileSync('node', ['install.js'], {
    cwd: path.join(REPO_ROOT, 'node_modules', 'electron'), stdio: 'inherit',
  });
  if (!existsSync(electronBin)) fail('Electron binary still missing after install.js');
}

const { _electron } = await import(
  path.join(REPO_ROOT, 'node_modules', 'playwright-core', 'index.mjs')
);

// ---------- 1. Vite dev server ----------

const alreadyUp = await fetch(DEV_URL).then((r) => r.ok).catch(() => false);
let viteProc = null;
if (alreadyUp) {
  console.log('dev server already listening on :5173 - reusing it');
} else {
  console.log('starting `npm run dev`...');
  viteProc = spawn('npm', ['run', 'dev'], { cwd: REPO_ROOT, stdio: 'ignore', detached: true });
  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline) {
    up = await fetch(DEV_URL).then((r) => r.ok).catch(() => false);
    if (up) break;
    await sleep(500);
  }
  if (!up) fail('dev server did not come up on :5173 within 30s');
}

const html = await fetch(DEV_URL).then((r) => r.text());
if (!html.includes('id="root"')) fail('index HTML served but has no #root mount point');
console.log('PASS: dev server serves index HTML with #root');

// ---------- 2. Electron shell ----------

const cleanup = () => {
  if (viteProc) { try { process.kill(-viteProc.pid); } catch { /* already gone */ } }
};
process.on('exit', cleanup);

mkdirSync(SHOT_DIR, { recursive: true });
const consoleErrors = [];
const pageErrors = [];

console.log('launching Electron shell...');
const app = await _electron.launch({
  executablePath: electronBin,
  args: [REPO_ROOT],
  cwd: REPO_ROOT,
  env: { ...process.env, NODE_ENV: 'development' },
  timeout: 45_000,
}).catch((e) => fail('Electron failed to launch: ' + e.message));

const page = await app.firstWindow();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.waitForFunction(() => {
  const r = document.getElementById('root');
  return r && r.children.length > 0;
}, { timeout: 30_000 }).catch(() => fail('React never mounted anything into #root within 30s'));
console.log('PASS: renderer mounted at', page.url(), '- title:', await page.title());

await sleep(6_000); // let sockets / IPC / backend probes settle

await page.screenshot({ path: path.join(SHOT_DIR, 'smoke-boot-01.png') });

// One real interaction: click the first visible button-ish element.
const clicked = await page.evaluate(() => {
  const els = [...document.querySelectorAll('button, [role="button"], a')]
    .filter((e) => e.offsetParent !== null && e.textContent.trim());
  if (!els.length) return null;
  els[0].click();
  return els[0].textContent.trim().slice(0, 60);
});
if (!clicked) fail('no visible clickable element found - UI likely blank');
await sleep(2_000);
await page.screenshot({ path: path.join(SHOT_DIR, 'smoke-boot-02.png') });
console.log(`PASS: clicked "${clicked}" - screenshots in ${SHOT_DIR}/smoke-boot-0[12].png`);

await app.close();

// ---------- 3. Error triage ----------

if (pageErrors.length) {
  console.error('Uncaught page errors in renderer:');
  for (const e of pageErrors) console.error(' ', e);
  fail(`${pageErrors.length} uncaught page error(s)`);
}
const unexpected = consoleErrors.filter((t) => !BENIGN_ERROR_PATTERNS.some((re) => re.test(t)));
const benignCount = consoleErrors.length - unexpected.length;
if (benignCount) console.log(`note: ${benignCount} benign local-config console error(s) ignored (missing JIRA_PAT)`);
if (unexpected.length) {
  console.error('Unexpected console errors:');
  for (const t of unexpected) console.error(' ', t.slice(0, 500));
  fail(`${unexpected.length} unexpected console error(s)`);
}

console.log('OK: app boots cleanly (dev server + Electron shell, 0 page errors)');
process.exit(0);
