#!/usr/bin/env node
/**
 * The README's accessibility screenshots, reproducible, with synthetic
 * content only (scripts/screenshots/content.mjs: the same documents and
 * board as the marketing shots; the Diagnostics shot opens the synthetic
 * sosreport tests/helpers/diagnostics-driver/make_fixture.py builds).
 *
 *   node scripts/screenshots/accessibility.mjs [--out <dir>] [--port <n>] [--only a,b] [--png] [--keep-png]
 *
 * Runs the Vite dev server on a spare port (default 5243) and headless
 * Chromium through playwright-core with a fresh profile, so nothing of the
 * owner's data is read; every /api request is answered inside the page,
 * except on the Diagnostics shot, where a scratch Flask backend on port+1000
 * serves the synthetic report. Each shot applies a ready-made profile of
 * Settings > Accessibility (src/utils/readingAidProfiles.js) and is written
 * at 1440x900 @2x as WebP (cwebp -q 82; --png keeps PNG, also the fallback
 * when cwebp is missing) into docs/screenshots/ as a11y-<id>.webp.
 *
 * Shots: settings, dyslexia, low-vision, focus, colour-vision.
 * See README.md next to this file.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as C from './content.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(REPO, 'package.json'));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = (name) => args.includes(name);
if (flag('--help') || flag('-h')) {
  console.log(`usage: node scripts/screenshots/accessibility.mjs [--out <dir>] [--port <n>] [--only <ids>] [--png] [--keep-png]

  --out <dir>    output directory (default docs/screenshots)
  --port <n>     Vite port (default 5243; the Diagnostics shot's scratch backend takes port+1000)
  --only <ids>   comma-separated shot ids: settings, dyslexia, low-vision, focus, colour-vision
  --png          write PNG instead of WebP
  --keep-png     keep the PNG next to the WebP
`);
  process.exit(0);
}
const OUT = path.resolve(opt('--out', path.join(REPO, 'docs', 'screenshots')));
const PORT = Number(opt('--port', 5243));
const FLASK = PORT + 1000;
const ONLY = opt('--only', '') ? new Set(opt('--only', '').split(',').map((s) => s.trim())) : null;
const wanted = (id) => !ONLY || ONLY.has(id);
const PNG = flag('--png');
const KEEP_PNG = flag('--keep-png');
const FIXTURE_ROOT = path.join(os.tmpdir(), 'diag-reports');
const FIXTURE_REPORT = 'sosreport-synthetic-2026';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const die = (why) => { console.error(why); process.exit(1); };

let pw;
try { pw = req('playwright-core'); } catch { die('playwright-core is not installed (npm install)'); }
if (!(await portFree(PORT))) die(`port ${PORT} is busy (--port for another)`);
const cwebp = PNG ? null : (spawnSync('cwebp', ['-version'], { stdio: 'ignore' }).status === 0 ? 'cwebp' : null);
if (!PNG && !cwebp) console.warn('cwebp not found: writing PNG (brew install webp, or --png to silence this)');
fs.mkdirSync(OUT, { recursive: true });

// ---- the scratch backend for Diagnostics (optional: the shot is skipped without it) ----
let flask = null; let token = null;
const stopFlask = () => { if (flask) { try { flask.kill('SIGTERM'); } catch { /* gone */ } } };
if (wanted('colour-vision')) {
  const python = path.join(REPO, 'backend', 'venv', 'bin', 'python');
  const ok = fs.existsSync(python) && (await portFree(FLASK));
  const fx = ok && await new Promise((resolve) => { const r = spawn('python3', [path.join(REPO, 'tests', 'helpers', 'diagnostics-driver', 'make_fixture.py')], { stdio: 'ignore', env: { ...process.env, TMPDIR: os.tmpdir() } }); r.once('exit', (code) => resolve(code === 0)); r.once('error', () => resolve(false)); });
  const fixture = ['/tmp/diag-reports', FIXTURE_ROOT].map((d) => path.join(d, FIXTURE_REPORT)).find((d) => fs.existsSync(d));
  if (fx && fixture) {
    token = randomBytes(16).toString('hex');
    flask = spawn(python, ['app.py'], { cwd: path.join(REPO, 'backend'), env: { ...process.env, APP_AUTH_TOKEN: token, PORT: String(FLASK), FLASK_DEBUG: '0' }, stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${FLASK}/health`)).ok; } catch { await sleep(250); } if (flask.exitCode !== null) break; }
    if (!up) { console.warn('the scratch backend did not come up: skipping the Diagnostics shot'); stopFlask(); flask = null; }
  } else {
    console.warn('backend/venv, python3 or the synthetic fixture is missing: skipping the Diagnostics shot');
  }
}

// ---- Vite + Chromium ----
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const browser = ready ? await pw.chromium.launch() : null;
const stop = async () => { if (browser) { try { await browser.close(); } catch { /* gone */ } } try { vite.kill('SIGTERM'); } catch { /* gone */ } stopFlask(); };
process.on('SIGINT', async () => { await stop(); process.exit(130); });
if (!ready) { await stop(); die('the Vite dev server did not come up'); }

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce', colorScheme: 'dark' });
const fixtureRoot = ['/tmp/diag-reports', FIXTURE_ROOT].find((d) => fs.existsSync(path.join(d, FIXTURE_REPORT))) || FIXTURE_ROOT;
await context.addInitScript(({ dir }) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); localStorage.setItem('expandedDocumentCategories', JSON.stringify(['Runbooks', 'Incidents', 'Checklists', 'Architecture', 'Meetings', 'General'])); localStorage.setItem('diagnosticsReportsDirectory', dir); } catch { /* storage off */ } }, { dir: fixtureRoot });
// no request leaves the page: the API is answered here, except for the Diagnostics report, served by the scratch backend
const cors = (origin) => ({ 'access-control-allow-origin': origin || '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type, x-app-token, authorization', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' });
await context.route(/^http:\/\/(localhost|127\.0\.0\.1):8080\//, async (route) => {
  const r = route.request(); const origin = r.headers().origin;
  if (r.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors(origin) }); return; }
  if (/\/socket\.io\//.test(r.url())) { await route.abort(); return; }
  if (!flask) { await route.fulfill({ status: 404, headers: cors(origin), json: { error: 'no backend in the screenshot run' } }); return; }
  try {
    const res = await route.fetch({ url: r.url().replace(/^http:\/\/(localhost|127\.0\.0\.1):8080/, `http://127.0.0.1:${FLASK}`), headers: { ...r.headers(), 'x-app-token': token } });
    await route.fulfill({ status: res.status(), headers: { ...res.headers(), ...cors(origin) }, body: await res.body() });
  } catch (e) { await route.fulfill({ status: 502, body: String(e) }); }
});
await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
await context.route('**/api/version', (r) => r.fulfill({ json: { app: '0.0.0', protocol: 2 } }));
await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
const page = await context.newPage();

const dismiss = async () => { for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); await sleep(150); } else break; } };
const goTo = async (label) => { const b = page.locator(`nav.w-16 button[aria-label="${label}"]`); if (await b.count()) { await b.first().click(); } else { await page.locator('[data-testid="rail-more"]').click(); await sleep(200); await page.locator('[data-testid="rail-more-menu"] button', { hasText: label }).first().click(); } await sleep(700); };
// applyProfile() sets every option: the profile's values over the defaults, stored like any setting
const profile = (id) => page.evaluate(async (id) => { const p = await import('/src/utils/readingAidProfiles.js'); p.applyProfile(id); }, id);
const openDoc = async (title) => { const row = page.locator('.sc-row', { hasText: title }).first(); await row.waitFor({ timeout: 15000 }); await row.click(); await sleep(1200); };
const preview = async () => { const b = page.locator('button[title="Preview"]'); if (await b.count()) { await b.first().click(); await sleep(1200); } };
const tidy = () => page.evaluate(() => { for (const el of document.querySelectorAll('[role="alert"]')) el.remove(); });
const files = [];
async function shot(id) {
  await tidy(); await sleep(300);
  const png = path.join(OUT, `a11y-${id}.png`);
  await page.screenshot({ path: png });
  if (cwebp) {
    const webp = path.join(OUT, `a11y-${id}.webp`);
    const r = spawnSync(cwebp, ['-quiet', '-q', '82', '-metadata', 'none', png, '-o', webp], { stdio: 'inherit' });
    if (r.status === 0) { if (!KEEP_PNG) fs.unlinkSync(png); files.push(webp); log('shot', path.basename(webp), `${(fs.statSync(webp).size / 1024).toFixed(0)} KB`); return; }
  }
  files.push(png); log('shot', path.basename(png), `${(fs.statSync(png).size / 1024).toFixed(0)} KB`);
}

try {
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500); await dismiss();
  // the seed: the marketing shots' documents and board, through the app's own database module
  await page.evaluate(async (C) => {
    const { db } = await import('/src/db/database.js');
    const now = new Date().toISOString();
    let pos = 0;
    for (const c of C.CATEGORIES) await db.documentCategories.add({ name: c.name, icon: c.icon, position: pos++, createdAt: now, updatedAt: now });
    for (const d of C.DOCUMENTS) await db.documents.add({ title: d.title, content: d.content, category: d.category, locked: false, updatedAt: d.updatedAt, stableId: crypto.randomUUID() });
    await db.kanbanBoards.add({ title: C.KANBAN.title, category: C.KANBAN.category, columns: C.KANBAN.columns, createdAt: new Date(C.KANBAN.createdAt), updatedAt: new Date(C.KANBAN.updatedAt) });
  }, { CATEGORIES: C.CATEGORIES, DOCUMENTS: C.DOCUMENTS, KANBAN: C.KANBAN });
  await page.reload({ waitUntil: 'load' }); await sleep(1500); await dismiss();

  if (wanted('settings')) {
    await profile('default');
    await page.locator('[data-testid="sidebar-brand-mark"]').click();
    await page.locator('[data-testid="settings-modal"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="settings-modal"] .sc-rail-tab', { hasText: 'Accessibility' }).click(); await sleep(600);
    await shot('settings');
    await page.keyboard.press('Escape'); await sleep(400);
  }

  const DOC = C.OPEN_DOCUMENTS[0];
  const readingShot = async (id, profileId, hover) => {
    await profile(profileId); await sleep(300);
    await goTo('Documents'); await openDoc(DOC); await preview();
    const surface = page.locator('[data-testid="reading-aids-surface"] .markdown-preview').first();
    // the ruler follows pointer moves: leave the text and come back, so the band is drawn for this profile
    if (hover && await surface.count()) { const box = await surface.boundingBox(); if (box) { await page.mouse.move(box.x - 40, 300); await sleep(200); await page.mouse.move(box.x + box.width / 2, box.y + Math.min(260, box.height / 2), { steps: 4 }); } }
    await sleep(500);
    if (process.env.A11Y_SHOTS_DEBUG) log('ruler', JSON.stringify(await page.evaluate(() => { const b = document.querySelector('.ra-ruler-band'); const m = document.querySelector('.ra-ruler-shade'); const r = b && b.getBoundingClientRect(); return { html: document.documentElement.className, band: r && [r.x, r.y, r.width, r.height], bandStyle: b && b.getAttribute('style'), shade: !!m, bandCount: document.querySelectorAll('.ra-ruler-band').length }; })));
    await shot(id);
  };
  if (wanted('dyslexia')) await readingShot('dyslexia', 'dyslexia', true);
  if (wanted('low-vision')) await readingShot('low-vision', 'lowVision', false);
  if (wanted('focus')) await readingShot('focus', 'focus', true);

  if (wanted('colour-vision') && flask) {
    await profile('cvGreen'); await sleep(300);
    await goTo('Tools'); await goTo('Diagnostics'); await sleep(1500);
    const opened = await page.evaluate(async (name) => { for (let i = 0; i < 80; i++) { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name)); if (b) { b.click(); return true; } await new Promise((r) => setTimeout(r, 250)); } return false; }, FIXTURE_REPORT);
    if (!opened) console.warn('the synthetic report did not appear in Diagnostics: skipping the colour-vision shot');
    else { await sleep(6000); await page.mouse.move(2, 898); await shot('colour-vision'); }
  }
  await profile('default');
} finally {
  await stop();
}
log('done:', files.length ? files.map((f) => path.relative(REPO, f)).join(', ') : 'nothing written');
