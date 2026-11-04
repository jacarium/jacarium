/**
 * The Diagnostics pages Flask serves itself (backend/templates/index.html and
 * layout.html with every tab of a sosreport and a must-gather) through a real
 * backend and Chromium: a screenshot of each page in light and dark, and an
 * audit of every Font Awesome icon on it - the `<i class="fas fa-...">`
 * elements - whether its glyph is there (a `::before` content and the icon
 * font loaded) or blank / tofu. The icon font is used by these pages alone:
 * the app's own Diagnostics frame maps the registry's icon names to its
 * React icons and injects styles.css only.
 *
 *   captureDiagnosticsIcons({ out, label, port, reportsRoot })
 *     -> { skip } | { pages: [{ type, tab, theme, file, icons, missing: [...], font }], reportsRoot }
 *
 * The backend runs on `port` (ICONS_BACKEND_PORT, default 8081 - never the
 * user's 8080) with JACARIUM_AUTH_MODE=none and the mock reports
 * (tests/fixtures/diagnostics-mock/generate.py) as its reports root, under a
 * scratch HOME; it dies with the caller (tests/helpers/reap.mjs). Chromium
 * is playwright-core's. Used by tests/diagnostics-icons.test.mjs and, with
 * a label, for the before / after screenshots of an icon-font update.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnReaped, killGroup } from './reap.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
export const MOCK_REPORTS = { sosreport: 'sosreport-web-01-2026-10-13-abcdef', mustgather: 'must-gather.local.1234567890' };

/** The mock reports, generated into `dir` (or a new temporary directory). Returns the directory, or null. */
export function generateMockReports(dir = null) {
  const out = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-icons-reports-'));
  const r = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', out, '--no-archives'], { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(path.join(out, MOCK_REPORTS.sosreport)) ? out : null;
}

// runs in the page: every Font Awesome <i> that is laid out, with its glyph state
const AUDIT = `(() => {
  const out = { icons: 0, missing: [], families: {} };
  for (const el of document.querySelectorAll('i[class*="fa-"], span[class*="fa-"]')) {
    if (!el.getClientRects().length) continue;
    const cls = [...el.classList].filter((c) => /^fa/.test(c)).join(' ');
    const before = getComputedStyle(el, '::before');
    const content = (before.content || '').replace(/^"|"$/g, '');
    const family = before.fontFamily.replace(/"/g, '');
    const weight = before.fontWeight || '400';
    out.icons += 1;
    const loaded = document.fonts.check(weight + ' 16px "' + family + '"');
    out.families[family] = (out.families[family] || 0) + 1;
    if (!content || content === 'none' || content === 'normal' || !/Awesome/.test(family) || !loaded) out.missing.push(cls + ' (' + (content || 'no content') + ', ' + family + (loaded ? '' : ' not loaded') + ')');
  }
  return out;
})()`;

/**
 * @param {{ out: string, label?: string, port?: number, reportsRoot?: string | null, viewport?: { width: number, height: number }, log?: Function }} options
 */
export async function captureDiagnosticsIcons({ out, label = 'icons', port = Number(process.env.ICONS_BACKEND_PORT || 8081), reportsRoot = null, viewport = { width: 1360, height: 900 }, log = () => {} } = {}) {
  if (!fs.existsSync(PYTHON)) return { skip: 'backend/venv missing' };
  let pw;
  try { pw = req('playwright-core'); } catch { return { skip: 'playwright-core is not installed' }; }
  if (!(await portFree(port))) return { skip: `port ${port} is busy (ICONS_BACKEND_PORT picks another)` };
  const root = reportsRoot || generateMockReports();
  if (!root) return { skip: 'the mock reports could not be generated' };
  fs.mkdirSync(out, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-icons-home-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JACARIUM_'))), HOME: home, PORT: String(port), JACARIUM_AUTH_MODE: 'none', JACARIUM_REPORTS_ROOT: root, FLASK_DEBUG: '0' };
  const backend = spawnReaped(PYTHON, ['app.py'], { cwd: path.join(REPO, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let backendLog = '';
  backend.stdout.on('data', (d) => { backendLog += d; });
  backend.stderr.on('data', (d) => { backendLog += d; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await sleep(250); } }
  const stop = () => { killGroup(backend, 'SIGTERM'); fs.rmSync(home, { recursive: true, force: true }); };
  if (!up) { stop(); return { skip: `the backend did not come up on :${port}: ${backendLog.slice(-300)}` }; }

  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) { stop(); return { skip: `no Chromium for playwright-core: ${e.message.slice(0, 100)}` }; }
  const pages = [];
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 1 });
      // the Flask pages read the html.dark class (the chart colours); the app's dark theme is that class
      if (theme === 'dark') await context.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('dark')); });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const record = async (type, tab) => {
        await page.evaluate(() => document.fonts.ready);
        await sleep(150);
        const audit = await page.evaluate(AUDIT);
        const file = path.join(out, `${label}-${type}-${tab}-${theme}.png`);
        await page.screenshot({ path: file });
        pages.push({ type, tab, theme, file, icons: audit.icons, missing: audit.missing, families: audit.families, errors: errors.splice(0) });
        log(`  ${theme} ${type}/${tab}: ${audit.icons} icons${audit.missing.length ? ', MISSING ' + audit.missing.length : ''} -> ${path.basename(file)}`);
      };
      // the index page (the report form and its icons)
      await page.goto(`${base}/`, { waitUntil: 'load' });
      await record('index', 'index');
      for (const [type, name] of Object.entries(MOCK_REPORTS)) {
        await page.goto(`${base}/`, { waitUntil: 'load' });
        await page.selectOption('#report_type', type);
        await page.fill('#directory', path.join(root, name));
        await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('form button[type="submit"], form input[type="submit"]')]);
        // the sidebar: every tab and sub-tab, as switchTab(...) is called from the buttons
        const tabs = await page.evaluate(() => [...document.querySelectorAll('[onclick*="switchTab("]')].map((b) => { const m = /switchTab\('([^']+)'(?:,\s*'([^']+)')?\)/.exec(b.getAttribute('onclick')); return m ? { tab: m[1], parent: m[2] || null } : null; }).filter(Boolean));
        await record(type, 'layout');
        for (const t of tabs) {
          await page.evaluate(({ tab, parent }) => window.switchTab(tab, parent), t);
          for (let i = 0; i < 80; i++) {
            const busy = await page.evaluate(() => { const c = document.getElementById('tab-container'); return !c || !c.children.length || !!c.querySelector('.fa-spinner'); });
            if (!busy) break;
            await sleep(125);
          }
          await record(type, t.parent ? `${t.parent}.${t.tab}` : t.tab);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    stop();
  }
  return { pages, reportsRoot: root, base };
}
