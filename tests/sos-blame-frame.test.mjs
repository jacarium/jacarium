#!/usr/bin/env node
/**
 * The regrouped Diagnostics sidebar (Log Collection -> Log Viewer, Sos
 * Report -> Blame) and the Blame tab (backend/templates/tabs/
 * sosreport_blame.html) inside the REAL app's diagnostics frame.
 *
 * THE CHANGE: the Log Viewer moved under a "Log Collection" group and a
 * "Sos Report" group gained "Blame", where the sos report's own collection
 * time went: a summary strip, a horizontal bar chart of plugin run time
 * (top N / all), the cumulative share line, the return codes per plugin
 * (stacked, 127 "not found" apart), a timeline of the plugins over the run
 * when the manifest records times, and a sortable, filterable plugin table
 * that expands into each plugin's commands. Chart.js is the one the frame
 * already loads for the Processes and SAR tabs; the table is Jinja-
 * rendered; coloured left accents are square, cards and buttons rounded.
 *
 * Static: the registry regroups, the templates carry no utility class the
 * frame lacks, no Font Awesome, no marked-safe output, no innerHTML.
 *
 * Live (Vite from this checkout + playwright-core's Chromium; the backend
 * calls on localhost:8080 are answered by routes from HTML rendered by
 * tests/helpers/diagnostics-render.py with the backend venv over the
 * synthetic diagnostics mock, so the user's own app on :8080 is never
 * touched): in dark and light, the sidebar shows Log Collection with Log
 * Viewer under it and Sos Report with Blame under it, no top-level Log
 * Viewer; Blame renders four charts with a size, the strip, the cmdline
 * block and 24 plugin rows; the timeout row carries a square red accent
 * while the cards keep the token radius; the filter, the "only timeouts"
 * box and the row expansion work; at 420 px nothing scrolls sideways.
 * Screenshots go to BL_OUT (or a temp dir).
 *
 * SKIPS (exit 0) without playwright-core / Chromium, without backend/venv
 * or python3, or with SKIP_BROWSER_TESTS set.
 * Run: node tests/sos-blame-frame.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- static ----
{
  const registry = fs.readFileSync(path.join(REPO, 'backend', 'log_viewer.py'), 'utf8');
  check('the registry: Log Collection holds the Log Viewer, Sos Report holds Blame, and sub-tab ids resolve as tabs (_resolve_tab)',
    /'log_collection':[\s\S]*?'sub_tabs':\s*\{[\s\S]*?'log_viewer':/.test(registry) && /'sos_report':[\s\S]*?'sub_tabs':\s*\{[\s\S]*?'blame':/.test(registry) && /def _resolve_tab/.test(registry));
  const dir = path.join(REPO, 'backend', 'templates', 'tabs');
  for (const name of ['sosreport_blame.html', 'sosreport_sos_report.html', 'sosreport_log_collection.html']) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    const utilities = ['grid-cols-', 'col-span-', 'bg-gray-', 'text-gray-', 'md:', 'space-y-', 'shadow-md'].filter((c) => src.includes(c));
    check(`${name}: no utility class the frame does not compile, no Font Awesome, no marked-safe output, no innerHTML`, utilities.length === 0 && !src.includes('class="fas') && !/\|\s*safe/.test(src) && !/innerHTML|insertAdjacentHTML|document\.write/.test(src), utilities.join(','));
  }
  const page = fs.readFileSync(path.join(REPO, 'src', 'components', 'DiagnosticsPage.jsx'), 'utf8');
  check('DiagnosticsPage resolves a deep link to a sub-tab id (diagnosticsOpenTab("log_viewer")) to its group', /sub_tabs \|\| \[\]\)\.some\(st => st\.tab_name === tab\)/.test(page));
}

// ---- live ----
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(failed ? 1 : 0); }
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
const OUT = process.env.BL_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sos-blame-frame-'));
fs.mkdirSync(OUT, { recursive: true });
const TABS = ['sos_report', 'blame', 'log_collection'];
let HTML_DIR = process.env.BL_HTML_DIR;
if (!HTML_DIR) {
  if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot render the tabs'); process.exit(failed ? 1 : 0); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-blame-fixture-'));
  const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
  if (gen.status !== 0) { console.log('SKIP: could not build the synthetic diagnostics fixture: ' + (gen.stderr || '').slice(0, 200)); process.exit(failed ? 1 : 0); }
  HTML_DIR = path.join(work, 'html');
  const ren = spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', HTML_DIR, '--fixture', path.join(work, 'sosreport-web-01-2026-10-13-abcdef'), '--tabs', ...TABS], { encoding: 'utf8' });
  check('the tabs render through Flask over the synthetic report', ren.status === 0, (ren.stderr || '').slice(-300));
  if (ren.status !== 0) process.exit(1);
}
const REPORT = { name: 'sosreport-web-01-2026-10-13-abcdef', path: '/tmp/sos-blame-frame/sosreport-web-01-2026-10-13-abcdef', type: 'sosreport', modified: 1760000000 };
const tabs = JSON.parse(fs.readFileSync(path.join(HTML_DIR, 'tabs.json'), 'utf8'));
const html = Object.fromEntries(TABS.map((t) => [t, fs.readFileSync(path.join(HTML_DIR, `${t}.html`), 'utf8')]));

const PORT = Number(process.env.SMOKE_PORT || 5309);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(failed ? 1 : 0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

async function open(theme) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
  await context.addInitScript(({ theme }) => {
    try {
      localStorage.setItem('whatsNewLastSeen', '99.0.0');
      localStorage.setItem('app-theme', JSON.stringify(theme));
      localStorage.setItem('diagnosticsReportsDirectory', '/tmp/sos-blame-frame');
      localStorage.removeItem('diagnostics-page-session');
    } catch { /* storage off */ }
  }, { theme });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.3', protocol: 2 } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
  await context.route('http://localhost:8080/list_reports', (r) => r.fulfill({ json: { reports: [REPORT] } }));
  await context.route('http://localhost:8080/get_tabs', (r) => r.fulfill({ json: { tabs, report_type: 'sosreport', directory: REPORT.path } }));
  await context.route('http://localhost:8080/get_tab_data', (r) => r.fulfill({ json: {} }));
  await context.route('http://localhost:8080/static/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(REPO, 'backend', 'static', 'styles.css'), 'utf8') }));
  await context.route('http://localhost:8080/load_tab', (r) => {
    let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ }
    const key = body.sub_tab || body.tab;
    r.fulfill({ json: { html: html[key] || `<div class="panel rounded-lg shadow-sm"><p>${key} (not part of this test)</p></div>` } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(String(e.message)); console.log('pageerror', String(e.message).slice(0, 160)); });
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  return { context, page, errors };
}

const clickButton = (page, label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label); if (!b) return false; b.click(); return true; }, label);
const clickSidebarSpan = (page, label) => page.evaluate((label) => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label); if (!s) return false; s.closest('div.cursor-pointer').click(); return true; }, label);
const expandGroup = (page, label) => page.evaluate((label) => {
  const span = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label);
  const row = span && span.closest('div.cursor-pointer').parentElement;
  const btn = row && row.querySelector('button[title="Expand"]');
  if (btn) { btn.click(); return 'expanded'; }
  return row && row.querySelector('button[title="Collapse"]') ? 'already' : 'no chevron';
}, label);
const sidebarLabels = (page) => page.evaluate(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).map((s) => s.textContent.trim()));

async function diagnosticsFrame(page, marker) {
  for (let i = 0; i < 60; i++) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try { if (await f.evaluate((m) => !!document.querySelector(m), marker)) return f; } catch { /* navigating */ }
    }
    await sleep(250);
  }
  return null;
}

try {
  for (const theme of ['dark', 'light']) {
    const { context, page, errors } = await open(theme);
    await clickButton(page, 'Tools'); await sleep(400);
    check(`${theme}: the Diagnostics page opens`, await clickButton(page, 'Diagnostics'));
    const opened = await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name)); if (!b) return false; b.click(); return true; }, REPORT.name, { timeout: 20000 }).then(() => true).catch(() => false);
    check(`${theme}: the synthetic report is listed and opens`, opened);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).some((s) => s.textContent.trim() === 'Sos Report'), null, { timeout: 20000 }).catch(() => {});
    let labels = await sidebarLabels(page);
    check(`${theme}: the sidebar lists Log Collection and Sos Report as groups and no top-level Log Viewer`, labels.includes('Log Collection') && labels.includes('Sos Report') && !labels.includes('Log Viewer') && !labels.includes('Blame'), labels.join(','));
    check(`${theme}: Log Collection expands to Log Viewer`, ['expanded', 'already'].includes(await expandGroup(page, 'Log Collection')));
    check(`${theme}: Sos Report expands to Blame`, ['expanded', 'already'].includes(await expandGroup(page, 'Sos Report')));
    await sleep(400);
    labels = await sidebarLabels(page);
    const order = ['Log Collection', 'Log Viewer', 'Sos Report', 'Blame'].map((l) => labels.indexOf(l));
    check(`${theme}: the sub-tabs sit under their groups, in order`, order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3], labels.join(','));
    const shotPage = async (name) => { const file = path.join(OUT, `${name}-${theme}.png`); await page.screenshot({ path: file }); console.log(`  screenshot: ${file}`); };
    await shotPage('sidebar-regrouped');

    // the group pages
    check(`${theme}: Sos Report group page opens`, await clickSidebarSpan(page, 'Sos Report'));
    let frame = await diagnosticsFrame(page, '#sos-report-overview');
    check(`${theme}: Sos Report renders with the Open Blame button`, !!frame && await frame.evaluate(() => !!document.getElementById('sos-report-open-blame')));
    await sleep(600);
    await shotPage('sos-report');
    check(`${theme}: Log Collection group page opens`, await clickSidebarSpan(page, 'Log Collection'));
    frame = await diagnosticsFrame(page, '#log-collection-overview');
    check(`${theme}: Log Collection renders the file groups and the Open Log Viewer button`, !!frame && await frame.evaluate(() => document.querySelectorAll('.lc-group').length >= 3 && !!document.getElementById('log-collection-open-viewer')));
    await sleep(600);
    await shotPage('log-collection');

    // Blame
    check(`${theme}: Blame sub-tab clicked`, await clickSidebarSpan(page, 'Blame'));
    frame = await diagnosticsFrame(page, '#sos-blame');
    check(`${theme}: Blame rendered in the diagnostics frame`, !!frame);
    if (!frame) { await context.close(); continue; }
    await sleep(1200);
    const iframe = await page.$('iframe[title="Diagnostics content"]');
    const shotFrame = async (name) => {
      const file = path.join(OUT, `${name}-${theme}.png`);
      const h = await frame.evaluate(() => document.body.scrollHeight);
      await page.setViewportSize({ width: 1360, height: Math.min(6000, h + 140) });
      await sleep(700);
      await iframe.screenshot({ path: file });
      await page.setViewportSize({ width: 1360, height: 900 });
      await sleep(300);
      console.log(`  screenshot: ${file}`);
    };
    await shotPage('blame');
    const probe = await frame.evaluate(() => {
      const cs = (el) => getComputedStyle(el);
      const charts = window.__blameCharts || {};
      const canvases = ['blame-bars', 'blame-cumulative', 'blame-rc', 'blame-gantt'].map((id) => { const c = document.getElementById(id); return c ? { id, w: c.clientWidth, h: c.clientHeight } : { id, missing: true }; });
      const timeoutRow = document.querySelector('tr.bl-row.bl-timeout');
      const firstCell = timeoutRow && timeoutRow.querySelector('td');
      const card = document.querySelector('.bl-card');
      const btn = document.querySelector('.bl-btn');
      const cmdline = document.getElementById('blame-cmdline');
      const over = [];
      document.querySelectorAll('.bl-strip, .bl-stat-value, .bl-card-title, .bl-cmdline').forEach((el) => { if (el.scrollWidth > el.clientWidth + 1) over.push(el.className + ':' + el.scrollWidth + '>' + el.clientWidth); });
      return {
        charts: Object.keys(charts), canvases, rows: document.querySelectorAll('tr.bl-row').length, strip: !!document.querySelector('.bl-strip'),
        timeoutAccent: firstCell ? cs(firstCell).boxShadow : '', timeoutRadius: firstCell ? cs(firstCell).borderRadius : '',
        cardRadius: card ? cs(card).borderRadius : '', btnRadius: btn ? cs(btn).borderRadius : '',
        cmdlineRadius: cmdline ? [cs(cmdline).borderTopLeftRadius, cs(cmdline).borderBottomLeftRadius, cs(cmdline).borderTopRightRadius] : [], cmdlineLeft: cmdline ? cs(cmdline).borderLeftWidth : '',
        cmdlineMono: cmdline ? cs(cmdline).fontFamily : '', over, shown: (document.getElementById('blame-shown') || {}).textContent,
      };
    });
    check(`${theme}: the four charts drew (bars, cumulative, return codes, timeline) on canvases with a size`, probe.charts.length === 4 && probe.canvases.every((c) => !c.missing && c.w > 100 && c.h > 50), JSON.stringify(probe.canvases));
    check(`${theme}: the strip, the cmdline block (monospace, square left accent, rounded right) and the 24 plugin rows`, probe.strip && probe.rows === 24 && /mono|Consolas/i.test(probe.cmdlineMono) && probe.cmdlineRadius[0] === '0px' && probe.cmdlineRadius[1] === '0px' && probe.cmdlineRadius[2] !== '0px' && parseFloat(probe.cmdlineLeft) >= 3, JSON.stringify({ rows: probe.rows, r: probe.cmdlineRadius, l: probe.cmdlineLeft }));
    check(`${theme}: the timed-out plugin's row carries a square red left accent (an inset shadow, no radius) while cards and buttons keep 8px`, /inset/.test(probe.timeoutAccent) && /220, 38, 38/.test(probe.timeoutAccent) && probe.timeoutRadius === '0px' && probe.cardRadius === '8px' && probe.btnRadius === '8px', JSON.stringify({ a: probe.timeoutAccent, c: probe.cardRadius, b: probe.btnRadius }));
    check(`${theme}: nothing in the strip, the card titles or the cmdline overflows`, probe.over.length === 0, probe.over.join(', '));
    // expand the slowest plugin, then screenshot the whole tab
    const expanded = await frame.evaluate(() => { const row = document.querySelector('tr.bl-row'); row.querySelector('.bl-toggle').click(); const cmds = row.nextElementSibling; return { open: !cmds.hidden, cmdRows: cmds.querySelectorAll('tr.bl-cmd').length, exec: (cmds.querySelector('.bl-exec') || {}).textContent, mono: cmds.querySelector('.bl-exec') ? getComputedStyle(cmds.querySelector('.bl-exec')).fontFamily : '' }; });
    check(`${theme}: a plugin row expands into its commands in monospace`, expanded.open && expanded.cmdRows >= 1 && /mono|Consolas/i.test(expanded.mono) && expanded.exec.includes('example-ctl'), JSON.stringify(expanded));
    await sleep(500);
    await shotFrame('blame-expanded');
    // filters
    const filtered = await frame.evaluate(async () => {
      const input = document.getElementById('blame-filter');
      input.value = 'chrony'; input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const after = Array.from(document.querySelectorAll('tr.bl-row')).filter((r) => !r.hidden).map((r) => r.dataset.name);
      const shown = document.getElementById('blame-shown').textContent;
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const box = document.getElementById('blame-only-timeouts'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      const timeouts = Array.from(document.querySelectorAll('tr.bl-row')).filter((r) => !r.hidden).map((r) => r.dataset.name);
      box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      const restored = Array.from(document.querySelectorAll('tr.bl-row')).filter((r) => !r.hidden).length;
      // sort by name ascending: the header click
      const th = Array.from(document.querySelectorAll('#blame-table th')).find((h) => h.dataset.key === 'name'); th.click();
      const firstByName = document.querySelector('tr.bl-row').dataset.name;
      return { after, shown, timeouts, restored, firstByName };
    });
    check(`${theme}: the filter narrows to chrony ("1 of 24 plugins"), "only timeouts" leaves example_app, clearing restores 24, the Plugin header sorts by name`, filtered.after.join() === 'chrony' && /1 of 24/.test(filtered.shown) && filtered.timeouts.join() === 'example_app' && filtered.restored === 24 && filtered.firstByName === 'boot', JSON.stringify(filtered));
    await frame.evaluate(() => { const th = Array.from(document.querySelectorAll('#blame-table th')).find((h) => h.dataset.key === 'seconds'); th.click(); });
    // the bar chart's Show all
    const showAll = await frame.evaluate(async () => { const b = document.getElementById('blame-bars-all'); const before = document.getElementById('blame-bars-box').clientHeight; b.click(); await new Promise((r) => setTimeout(r, 300)); return { before, after: document.getElementById('blame-bars-box').clientHeight, label: b.textContent, bars: window.__blameCharts.bars.data.labels.length }; });
    check(`${theme}: "Show all 24" grows the bar chart to every plugin`, showAll.after > showAll.before && showAll.bars === 24 && /Top 12/.test(showAll.label), JSON.stringify(showAll));
    await frame.evaluate(() => document.getElementById('blame-bars-all').click());
    // narrow
    await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.dataset.w = f.style.width; f.style.width = '420px'; });
    await sleep(1200);
    await shotFrame('blame-narrow-420');
    const narrow = await frame.evaluate(() => { const w = document.documentElement.clientWidth; const over = []; document.querySelectorAll('.bl-strip, .bl-card, .bl-filters, .bl-cmdline, .bl-table-wrap').forEach((el) => { if (el.getBoundingClientRect().right > w + 1) over.push(el.className.split(' ')[0]); }); const canvases = Array.from(document.querySelectorAll('.bl-chart canvas')).map((c) => c.clientWidth); return { w, pageOver: document.documentElement.scrollWidth > w + 1, over, canvases }; });
    check(`${theme}: at ${narrow.w}px no horizontal page scroll, no block past the edge, the charts shrank with the frame`, !narrow.pageOver && narrow.over.length === 0 && narrow.w <= 430 && narrow.canvases.every((w) => w > 100 && w < 420), JSON.stringify(narrow));
    await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w || ''; });
    await sleep(300);
    check(`${theme}: no uncaught page errors`, errors.filter((e) => !/ResizeObserver/.test(e)).length === 0, errors.slice(0, 2).join(' | '));
    await context.close();
  }
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
