/**
 * Screenshots of Settings > Performance in the real app (Vite, browser mode), light and dark, for review:
 *   node tests/helpers/performance-settings-shots.mjs <view.json> <out dir>      env: SHOTS_PORT (default 5357)
 * view.json: the /api/settings/parallel answer to show (e.g. the real blueprint's on this machine). The backend's
 * other routes are answered with nothing (the panel needs only this one).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(REPO, 'package.json'));
const pw = req('playwright-core');
const [viewFile, out] = process.argv.slice(2);
const view = JSON.parse(fs.readFileSync(viewFile, 'utf8'));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.SHOTS_PORT || 5357);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch { await sleep(250); } }
const browser = await pw.chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce', colorScheme: theme });
    await context.addInitScript((t) => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify(t)); } catch { /* storage off */ } }, theme);
    await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'not in this view' } }));
    await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
    await context.route('**/api/version', (r) => r.fulfill({ json: { app: '4.2.0', protocol: 2 } }));
    await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
    await context.route('**/api/settings/parallel', (r) => r.fulfill({ json: view }));
    await context.route('**/socket.io/**', (r) => r.abort());
    await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
    await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
    await page.locator('[title="Jacarium - Settings"], [aria-label="Jacarium - Settings"]').first().click();
    await page.waitForTimeout(600);
    await page.locator('.sc-rail-tab', { hasText: /^Performance$/ }).click();
    await page.waitForTimeout(600);
    const shown = await page.evaluate(() => (document.querySelector('[data-testid="parallel-cores"]') || {}).textContent || '');
    console.log(`${theme}: ${shown}`);
    await page.screenshot({ path: path.join(out, `settings-performance-${theme}.png`) });
    await context.close();
  }
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
