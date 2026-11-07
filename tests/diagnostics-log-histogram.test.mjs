#!/usr/bin/env node
/*
 * Log Collection > Histogram (tabs/_log_histogram.html + diagLogHistogram in backend/static/diagnostics-ui.js, the
 * engine in backend/parsers/log_histogram.py) in the real app, against BOTH report types, with the analysis answered
 * for real by the Flask routes through tests/helpers/diagnostics-api.py over synthetic reports with planted
 * anomalies (tests/fixtures/diagnostics-mock/mock_log_anomalies.py; documentation addresses, .test names).
 *
 * Static: the registry (Histogram under Log Collection for both report types, after the Log Viewer), the frame's
 * allow-lists (the stream and the cancel), the templates (the shared range / source macros of the Log Viewer, the
 * page macro, nothing but the mount call), the controller sets text only (no innerHTML in diagLogHistogram).
 *
 * Browser (Vite on SMOKE_PORT, default 5343; playwright-core), dark and light, for each report type: the page shows
 * the Log Viewer's date range and picker with Analyze (the system journal selected on a sosreport, a default
 * selection on a must-gather); Analyze shows the busy state, then the Findings strip, the timeline with its shaded
 * anomaly windows, the sources chart, the ranked anomalies (the planted ones), the messages; a report line holding
 * HTML (<img onerror>, <script>) shows as text and runs nothing; the kind filter and a click on a bucket narrow the
 * anomalies; an anomaly's Open goes to the Log Viewer on its sources, its minute window (the note says so) and its
 * search term, and the rows loaded are that window's; a slow analysis shows Cancel, which stops it (the cancel route
 * is called); no horizontal overflow at 1920, 1010 and 420; screenshots of both report types in both themes
 * (LOGHIST_OUT, default a temporary directory).
 *
 *   node tests/diagnostics-log-histogram.test.mjs        env: SMOKE_PORT, LOGHIST_OUT, SKIP_BROWSER_TESTS=1 (static only)
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
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1500) : ''}`); if (!ok) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ---------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------
const ui = read('backend/static/diagnostics-ui.js');
const page = read('src/components/DiagnosticsPage.jsx');
const reg = read('backend/log_viewer.py');
const shared = read('backend/templates/tabs/_log_histogram.html');
const lv = read('backend/templates/tabs/_log_view.html');
check('the registry: Histogram (parsers.<type>.log_histogram) under Log Collection after the Log Viewer, for both report types', /'log_viewer': \{\s*'module': 'parsers\.sosreport\.log_viewer'[\s\S]*?'log_histogram': \{\s*'module': 'parsers\.sosreport\.log_histogram',\s*'icon': 'fas fa-chart-column',\s*'label': 'Histogram'/.test(reg) && /'log_viewer': \{\s*'module': 'parsers\.mustgather\.log_viewer'[\s\S]*?'log_histogram': \{\s*'module': 'parsers\.mustgather\.log_histogram',\s*'icon': 'fas fa-chart-column',\s*'label': 'Histogram'/.test(reg));
check('the frame allow-lists the Histogram\'s stream and cancel; the sidebar maps its icon', /DIAGNOSTICS_API_STREAM_ALLOWLIST = new Set\(\[[^\]]*'\/log_histogram_stream'/.test(page) && /DIAGNOSTICS_API_ALLOWLIST = new Set\(\[[^\]]*'\/log_histogram_cancel'/.test(page) && /'fas fa-chart-column': ChartColumn/.test(page));
check('the Histogram is never AI context (/get_tab_data refuses it)', /AI_CONTEXT_EXCLUDED = \{\("sosreport", "log_histogram"\), \("mustgather", "log_histogram"\)\}/.test(reg));
check('the page reuses the Log Viewer\'s controls (range_picker, source_picker of tabs/_log_view.html), which the viewer itself uses too', /logview\.range_picker\(/.test(shared) && /logview\.source_picker\(/.test(shared) && /\{% macro range_picker\(/.test(lv) && /\{% macro source_picker\(/.test(lv) && /\{\{ range_picker\(date_range\) \}\}/.test(lv) && /\{\{ source_picker\(sources, unavailable, source_noun, checked_type\) \}\}/.test(lv));
for (const t of ['sosreport', 'mustgather']) {
  const src = read(`backend/templates/tabs/${t}_log_histogram.html`);
  check(`the ${t} template only picks the report type (the page macro, the mount call)`, src.includes('import "tabs/_log_histogram.html" as lh') && src.includes("lh.page('" + t + "'") && src.includes('diagLogHistogram.mount(') && !/<style|<table|innerHTML|\|\s*safe/.test(src) && src.split('\n').length < 12);
}
const ctl = ui.slice(ui.indexOf('diagLogHistogram: Log Collection > Histogram'));
check('the controller sets text only: no innerHTML / insertAdjacentHTML / outerHTML in diagLogHistogram; the shared sourceRange drives the controls', ctl.length > 1000 && !/innerHTML|insertAdjacentHTML|outerHTML/.test(ctl) && /window\.diagLogView\.sourceRange\(/.test(ctl) && /window\.diagLogView\.alerter\(\)/.test(ctl));
check('the Log Viewer mounts the same shared controls (sourceRange) and reads its window from it', /const sr = sourceRange\(adapter, showAlert\);/.test(ui) && /const range = sr\.window\(\);/.test(ui));
check('the cross-link grammar carries a minute window and a level: sources=..[&from=..][&to=..][&level=..][&q=..]', ui.includes("const QUERY = /^sources=([^&]*)((?:&(?:from|to|level)=[^&]*)*)(?:&q=(.*))?$/;") && /sr\.setWindow\(opt\.from, opt\.to\)/.test(ui));
check('diagChart.timeSeries takes bands (the shaded anomaly windows)', /bands: \[\{ from, to, role, id \}\]/.test(ui) && /chart\.\$diagBands = spec\.bands \|\| \[\]/.test(ui));

if (process.env.SKIP_BROWSER_TESTS) { console.log(failed ? `\n${failed} check(s) failed` : '\nAll static checks passed (browser part skipped)'); process.exit(failed ? 1 : 0); }
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot render the tabs'); process.exit(failed ? 1 : 0); }
const OUT = process.env.LOGHIST_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-loghist-shots-'));
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// The fixtures: a sosreport and a must-gather with planted anomalies
// ---------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-loghist-fixture-'));
const gen = spawnSync(PYTHON, ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock'))}); import mock_log_anomalies as m; a = m.planted_sosreport(${JSON.stringify(work)}); b = m.planted_mustgather(${JSON.stringify(work)}); print(json.dumps([a[0], b[0]]))`], { encoding: 'utf8' });
if (gen.status !== 0) { console.log('SKIP: could not build the synthetic fixtures: ' + (gen.stderr || '').slice(-300)); process.exit(failed ? 1 : 0); }
const [SOS, MG] = JSON.parse(gen.stdout.trim().split('\n').pop());
// a report line that holds HTML: a rare error the page must show as text
const journal = path.join(SOS, 'sos_commands', 'logs', 'journalctl_--no-pager');
{
  const lines = fs.readFileSync(journal, 'utf8').split('\n');
  const hostile = 'Oct 12 16:40:01 node-01.example.test kernel: BUG: unable to handle page fault <img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  const at = lines.findIndex((l) => l.startsWith('Oct 12 16:40:02'));
  lines.splice(at > 0 ? at : lines.length - 1, 0, hostile);
  fs.writeFileSync(journal, lines.join('\n'));
}
const reports = {};
for (const [type, dir] of [['sosreport', SOS], ['mustgather', MG]]) {
  const htmlDir = path.join(work, 'html-' + type);
  const ren = spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', htmlDir, '--fixture', dir, '--report-type', type, '--tabs', 'log_histogram', 'log_viewer'], { encoding: 'utf8' });
  check(`the ${type} Histogram and Log Viewer render through Flask over the synthetic report`, ren.status === 0, (ren.stderr || '').slice(-400));
  if (ren.status !== 0) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  reports[type] = { name: path.basename(dir), path: dir, type, modified: 1760000000, html: { log_histogram: fs.readFileSync(path.join(htmlDir, 'log_histogram.html'), 'utf8'), log_viewer: fs.readFileSync(path.join(htmlDir, 'log_viewer.html'), 'utf8') }, tabs: JSON.parse(fs.readFileSync(path.join(htmlDir, 'tabs.json'), 'utf8')) };
}
check('the sosreport page preselects the system journal and offers Analyze; the must-gather page preselects within its budget', /data-path="[^"]*journalctl_--no-pager"[^>]*\n?\s*[^>]*checked/.test(reports.sosreport.html.log_histogram) && reports.sosreport.html.log_histogram.includes('id="lh-analyze"') && (reports.mustgather.html.log_histogram.match(/class="ui-check log-file-checkbox"[^>]*checked/g) || []).length >= 1 + 0 * 1);

const PORT = Number(process.env.SMOKE_PORT || 5343);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(failed ? 1 : 0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

const calls = { stream: 0, cancel: 0, viewerStream: 0, lastViewer: null, lastStream: null };
let delay = 0;
function backend(route, body) {
  const tmp = path.join(work, `req-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(body));
  const out = spawnSync(PYTHON, ['-I', path.join(REPO, 'tests', 'helpers', 'diagnostics-api.py'), '--path', route, '--body-file', tmp], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  fs.unlinkSync(tmp);
  let parsed = { status: 500, json: { error: (out.stderr || '').slice(-300) } };
  try { parsed = JSON.parse(out.stdout); } catch { /* the error above */ }
  return parsed;
}
const body = (r) => { try { return r.request().postDataJSON() || {}; } catch { return {}; } };
async function open(theme) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
  await context.addInitScript(({ theme, dir }) => {
    try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify(theme)); localStorage.setItem('diagnosticsReportsDirectory', dir); localStorage.removeItem('diagnostics-page-session'); } catch { /* storage off */ }
    window.__errs = []; window.addEventListener('error', (e) => { window.__errs.push(((e.error && e.error.stack) || e.message || '').slice(0, 700)); });
  }, { theme, dir: work });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '4.2.0', protocol: 2 } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
  await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
  await context.route('http://localhost:8080/list_reports', (r) => r.fulfill({ json: { reports: Object.values(reports).map(({ name, path: p, type, modified }) => ({ name, path: p, type, modified })) } }));
  await context.route('http://localhost:8080/get_tabs', (r) => { const b = body(r); const rep = Object.values(reports).find((x) => x.path === b.directory) || reports.sosreport; r.fulfill({ json: { tabs: rep.tabs, report_type: rep.type, directory: rep.path } }); });
  await context.route('http://localhost:8080/get_tab_data', (r) => r.fulfill({ json: {} }));
  await context.route('http://localhost:8080/static/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: read('backend/static/styles.css') }));
  await context.route('http://localhost:8080/load_tab', (r) => { const b = body(r); const rep = Object.values(reports).find((x) => x.path === b.directory); const key = b.sub_tab || b.tab; r.fulfill({ json: { html: (rep && rep.html[key]) || `<div class="panel rounded-lg shadow-sm"><p>${key} (not rendered)</p></div>` } }); });
  // the Histogram's stream and cancel, and the Log Viewer's reads: the real routes over the synthetic reports
  await context.route('http://localhost:8080/log_histogram_stream', async (r) => { calls.stream += 1; const b = body(r); calls.lastStream = b; if (delay) await sleep(delay); const a = backend('/log_histogram_stream', b); r.fulfill({ status: a.status, contentType: a.text !== undefined ? 'text/event-stream' : 'application/json', body: a.text !== undefined ? a.text : JSON.stringify(a.json) }); });
  await context.route('http://localhost:8080/log_histogram_cancel', (r) => { calls.cancel += 1; const a = backend('/log_histogram_cancel', body(r)); r.fulfill({ status: a.status, json: a.json }); });
  await context.route('http://localhost:8080/parse_log_viewer_stream', (r) => { calls.viewerStream += 1; const b = body(r); calls.lastViewer = b; const a = backend('/parse_log_viewer_stream', b); r.fulfill({ status: a.status, contentType: 'text/event-stream', body: a.text !== undefined ? a.text : '' }); });
  for (const route of ['/get_log_date_range', '/mustgather_log_date_range', '/mustgather_log_search', '/mustgather_log_cancel']) {
    await context.route('http://localhost:8080' + route, (r) => { const b = body(r); if (route === '/mustgather_log_search') calls.lastViewer = b; const a = backend(route, b); r.fulfill({ status: a.status, json: a.json }); });
  }
  const pg = await context.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e.stack || e.message).slice(0, 400)));
  await pg.goto(BASE + '/', { waitUntil: 'load' }); await pg.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = pg.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await pg.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await pg.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  return { context, page: pg, errors };
}
const clickButton = (pg, label) => pg.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
const clickSidebar = (pg, label, after) => pg.evaluate(({ label, after }) => { const all = Array.from(document.querySelectorAll('div.cursor-pointer span')); const from = after ? all.findIndex((el) => el.textContent.trim() === after) + 1 : 0; const s = all.slice(from).find((el) => el.textContent.trim() === label); if (!s) return false; s.closest('div.cursor-pointer').click(); return true; }, { label, after });
const expandGroup = (pg, label) => pg.evaluate((label) => { const span = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label); const row = span && span.closest('div.cursor-pointer').parentElement; const btn = row && row.querySelector('button[title="Expand"]'); if (btn) { btn.click(); return 'expanded'; } return row && row.querySelector('button[title="Collapse"]') ? 'already' : 'no chevron'; }, label);
async function frameFor(pg, key) {
  for (let i = 0; i < 120; i++) {
    const h = await pg.$(`iframe[title="Diagnostics content"][data-tab="${key}"]`);
    if (h) { const f = await h.contentFrame(); if (f) { try { if (await f.evaluate(() => document.readyState === 'complete' && !!document.querySelector('#diagnostics-content'))) return f; } catch { /* navigating */ } } }
    await sleep(250);
  }
  return null;
}
async function frameWidth(pg, fw) {
  await pg.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); if (f.dataset.w === undefined) f.dataset.w = f.style.width; });
  if (fw >= 1360) { await pg.setViewportSize({ width: fw, height: 1000 }); await pg.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w; }); }
  else { await pg.setViewportSize({ width: 1360, height: 1000 }); await pg.evaluate((fw) => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = fw + 'px'; }, fw); }
  await sleep(700);
}
const resetWidth = async (pg) => { await pg.setViewportSize({ width: 1360, height: 900 }); await pg.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w || ''; }); await sleep(300); };
const overflow = (frame) => frame.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [];
  document.querySelectorAll('#diagnostics-content *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    if (el.closest('svg') && el.tagName !== 'svg') return;
    if (el.closest('#log-file-dropdown-panel, #date-calendar, #alert-modal')) return;
    if (r.right > w + 1) {
      let clip = null;
      for (let p = el.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) { clip = p; break; } }
      if (!clip || clip.getBoundingClientRect().right > w + 1) bad.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' right ' + Math.round(r.right));
    }
  });
  return { w, pageOver: document.documentElement.scrollWidth > w + 1, bad: bad.slice(0, 6) };
});
const hist = (frame) => frame.evaluate(() => {
  const t = (id) => (document.getElementById(id) || {}).textContent || '';
  const rows = Array.from(document.querySelectorAll('#lh-anomalies-body tr.ui-xrow'));
  const charts = (window.diagChart && window.diagChart.charts()) || [];
  const tl = charts.find((c) => c.canvas && c.canvas.id === 'lh-timeline');
  return {
    shown: !document.getElementById('lh-results').hidden, status: t('lh-status').trim(), summary: t('lh-summary').trim(),
    findings: Array.from(document.querySelectorAll('#lh-findings .ui-finding-title')).map((e) => e.textContent.trim()),
    findingLinks: Array.from(document.querySelectorAll('#lh-findings [data-query]')).map((e) => e.getAttribute('data-query')),
    kinds: rows.map((r) => (r.querySelector('[data-col=kind]') || {}).textContent.trim()),
    whats: rows.map((r) => (r.querySelector('[data-col=what]') || {}).textContent.trim()),
    opens: rows.map((r) => (r.querySelector('[data-query]') || { getAttribute: () => '' }).getAttribute('data-query')),
    count: t('lh-anomalies-count').trim(), templates: document.querySelectorAll('#lh-templates-body tr.ui-xrow').length,
    timeline: !!tl, bands: tl ? (tl.$diagBands || []).length : 0, groups: !!charts.find((c) => c.canvas && c.canvas.id === 'lh-groups'),
    button: t('lh-analyze').trim(), xss: window.__xss, injected: document.querySelectorAll('#diagnostics-content img[onerror]').length + Array.from(document.querySelectorAll('#diagnostics-content script')).filter((x) => /__xss/.test(x.textContent)).length,
    mounted: !!(document.getElementById('log-histogram') || {}).$lh, alert: (document.getElementById('alert-modal') && !document.getElementById('alert-modal').classList.contains('hidden')) ? t('alert-modal-title') + ': ' + t('alert-modal-message') : '',
    errs: (window.__errs || []).slice(0, 3), pill: (document.querySelector('.ui-busy-pill') || {}).textContent || (window.parent !== window ? '' : ''),
  };
});
async function analyze(frame) {
  await frame.evaluate(() => document.getElementById('lh-analyze').click());
  for (let i = 0; i < 240; i++) { const s = await hist(frame); if (s.shown && s.button === 'Analyze' && s.count) return s; await sleep(250); }
  return hist(frame);
}
// a screenshot of the whole page: the viewport as tall as the frame (the app's pane scrolls, a full-page shot would
// stop at the window), then back
async function shot(pg, file) {
  const h = await pg.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); const r = f ? f.getBoundingClientRect() : null; return r ? Math.ceil(r.top + r.height + 40) : 900; });
  const vp = pg.viewportSize();
  await pg.setViewportSize({ width: vp.width, height: Math.min(7000, Math.max(900, h)) });
  await sleep(500);
  await pg.screenshot({ path: path.join(OUT, file) });
  await pg.setViewportSize(vp);
  await sleep(300);
}
async function openHistogram(pg, rep) {
  await pg.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name) && el.offsetParent); if (!b) return false; b.click(); return true; }, rep.name, { timeout: 20000 }).catch(() => {});
  await pg.waitForFunction(() => document.querySelectorAll('div.cursor-pointer span').length > 3, null, { timeout: 20000 }).catch(() => {});
  await sleep(400);
  await expandGroup(pg, 'Log Collection');
  await sleep(300);
  await clickSidebar(pg, 'Histogram', 'Log Collection');
  return frameFor(pg, 'log_histogram');
}

try {
  for (const theme of ['dark', 'light']) {
    const { context, page: pg, errors } = await open(theme);
    await clickButton(pg, 'Tools'); await sleep(400); await clickButton(pg, 'Diagnostics'); await sleep(600);
    // ---- the sosreport
    const f = await openHistogram(pg, reports.sosreport);
    check(`${theme}: the sosreport Histogram opens under Log Collection`, !!f);
    if (!f) { await context.close(); continue; }
    const before = await f.evaluate(() => ({ selected: (document.getElementById('log-file-selection-display') || {}).textContent, slider: !!document.getElementById('date-slider-start'), cal: !!document.getElementById('date-calendar'), analyze: !!document.getElementById('lh-analyze'), hidden: document.getElementById('lh-results').hidden }));
    check(`${theme}: the Log Viewer's controls (date range, calendar, picker with the system journal) and Analyze; nothing analysed yet`, /journalctl \(system\)/.test(before.selected) && before.slider && before.cal && before.analyze && before.hidden, JSON.stringify(before));
    const s = await analyze(f);
    check(`${theme}: Analyze shows the results: the summary, the Findings strip with the top anomalies, the timeline with shaded windows, the sources chart, the messages`, s.shown && /lines in \d+ message templates/.test(s.summary) && s.findings.length >= 4 && s.timeline && s.bands >= 5 && s.groups && s.templates >= 10, JSON.stringify({ ...s, opens: undefined, whats: undefined, calls: { stream: calls.stream, last: calls.lastStream } }));
    const want = ['Error spike', 'Volume spike', 'Burst', 'New', 'Stopped', 'Rare'];
    check(`${theme}: the planted anomalies are ranked (an error spike, a volume spike, bursts, a new message, a stopped heartbeat, a rare error)`, want.every((k) => s.kinds.includes(k)) && s.whats.some((w) => /nfs/.test(w)) && s.whats.some((w) => /XFS/.test(w)) && s.whats.some((w) => /PLEG is healthy/.test(w)), JSON.stringify(s.kinds) + JSON.stringify(s.whats.slice(0, 8)));
    check(`${theme}: a report line holding HTML (<img onerror>, <script>) shows as text and runs nothing`, s.xss === undefined && s.injected === 0 && s.whats.some((w) => w.includes('<img src=x onerror=')), JSON.stringify({ xss: s.xss, injected: s.injected }));
    check(`${theme}: each anomaly and finding carries its Log Viewer link: sources, the minute window, the term`, s.opens.length && s.opens.every((q) => /^sources=[^&]+&from=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}&to=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(q)) && s.findingLinks.some((q) => q.startsWith('sources=')), JSON.stringify(s.opens.slice(0, 3)));
    check(`${theme}: the analysis asked the stream with the selection and the slider's whole days`, calls.lastStream && calls.lastStream.report_type === 'sosreport' && calls.lastStream.paths.length === 1 && /T00:00$/.test(calls.lastStream.start || '') && /T23:59$/.test(calls.lastStream.end || ''), JSON.stringify(calls.lastStream));
    // the kind filter, then a click on the 14:00 bucket
    const kinds = await f.evaluate(() => { const sel = document.getElementById('lh-kind'); sel.value = 'burst'; sel.dispatchEvent(new Event('change')); const k = Array.from(document.querySelectorAll('#lh-anomalies-body tr.ui-xrow')).map((r) => r.querySelector('[data-col=kind]').textContent.trim()); sel.value = ''; sel.dispatchEvent(new Event('change')); return k; });
    check(`${theme}: the kind filter narrows the anomalies (Burst only)`, kinds.length >= 2 && kinds.every((k) => k === 'Burst'), JSON.stringify(kinds));
    const pos = await f.evaluate(() => { const c = window.diagChart.charts().find((x) => x.canvas.id === 'lh-timeline'); if (!c || !c.$axis) return null; const p = c.$axis.points.find((q) => q.bucket.t === '2026-10-12T14:00:00'); const r = c.canvas.getBoundingClientRect(); const x = c.scales.x.getPixelForValue(p.x); const y = c.chartArea.bottom - 3; return { x, y, w: r.width }; });
    if (pos) await f.locator('#lh-timeline').click({ position: { x: pos.x, y: pos.y } });
    await sleep(400);
    const win = await f.evaluate(() => ({ chip: document.getElementById('lh-window-chip').textContent, hidden: document.getElementById('lh-window-chip').hidden, whats: Array.from(document.querySelectorAll('#lh-anomalies-body tr.ui-xrow')).map((r) => r.querySelector('[data-col=what]').textContent.trim()) }));
    check(`${theme}: a click on the 14:00 bucket lists the anomalies in it (the nfs burst) and shows a removable chip`, !win.hidden && /14:00/.test(win.chip) && win.whats.length >= 1 && win.whats.some((w) => /nfs/.test(w)), JSON.stringify(win));
    await f.evaluate(() => document.getElementById('lh-window-chip').click());
    // an expanded anomaly shows its template and first line
    await sleep(300);
    const details = await f.evaluate(() => { const row = Array.from(document.querySelectorAll('#lh-anomalies-body tr.ui-xrow')).find((r) => /nfs/.test(r.querySelector('[data-col=what]').textContent)); row.querySelector('[data-col=what]').click(); const p = row.nextElementSibling; return { open: p && !p.hidden, text: p ? p.textContent : '' }; });
    check(`${theme}: an anomaly's details show its message template and first line`, details.open && /Message template/.test(details.text) && /First line/.test(details.text) && /nfs01\.example\.test not responding/.test(details.text), JSON.stringify(details).slice(0, 300));
    await shot(pg, `histogram-sosreport-${theme}.png`);
    for (const w of [1920, 1010, 420]) {
      await frameWidth(pg, w);
      const o = await overflow(f);
      check(`${theme}: no horizontal overflow at ${w} px (sosreport)`, !o.pageOver && !o.bad.length, JSON.stringify(o));
      if (w === 420) await pg.screenshot({ path: path.join(OUT, `histogram-sosreport-${theme}-narrow.png`), fullPage: false });
    }
    await resetWidth(pg);
    // ---- Open in Log Viewer: the nfs burst
    const q = await f.evaluate(() => { const row = Array.from(document.querySelectorAll('#lh-anomalies-body tr.ui-xrow')).find((r) => /nfs/.test(r.querySelector('[data-col=what]').textContent) && /Burst/.test(r.querySelector('[data-col=kind]').textContent)); const b = row && row.querySelector('[data-query]'); if (!b) return null; const qq = b.getAttribute('data-query'); b.click(); return qq; });
    const v = q ? await frameFor(pg, 'log_viewer') : null;
    let landed = null;
    if (v) {
      for (let i = 0; i < 120; i++) {
        landed = await v.evaluate(() => ({ search: (document.getElementById('log-search') || {}).value, note: (document.getElementById('date-range-note') || {}).textContent || '', noteHidden: (document.getElementById('date-range-note') || {}).hidden, loaded: (document.getElementById('loaded-count') || {}).textContent || '', rows: Array.from(document.querySelectorAll('#log-table-body tr')).map((r) => (r.cells[0] || {}).textContent.trim()).slice(0, 400) }));
        if (/^Loaded \d/.test(landed.loaded) && !/…$/.test(landed.loaded)) break;
        await sleep(250);
      }
    }
    check(`${theme}: Open in Log Viewer: the Log Viewer opens with the term in the search and the minute window named under the range`, !!v && landed && /not responding/i.test(landed.search || '') && !landed.noteHidden && /Window 2026-10-12 14:00 - 14:20/.test(landed.note), JSON.stringify(landed).slice(0, 400) + ' q=' + q);
    check(`${theme}: ... the read is that window (from 14:00 to 14:20) and the rows loaded are the burst's lines`, calls.lastViewer && calls.lastViewer.start_date === '2026-10-12T14:00' && calls.lastViewer.end_date === '2026-10-12T14:20' && landed && /^Loaded (\d{3,})/.test(landed.loaded) && landed.rows.length > 0 && landed.rows.every((t) => /Oct 12 14:(0|1)\d/.test(t)), JSON.stringify({ last: calls.lastViewer, loaded: landed && landed.loaded, first: landed && landed.rows.slice(0, 3) }));
    // ---- the must-gather
    await pg.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => /Load different report/.test(el.textContent) && el.offsetParent); if (b) b.click(); });
    await sleep(600);
    const m = await openHistogram(pg, reports.mustgather);
    if (m) {
      const sel = await m.evaluate(() => (document.getElementById('log-file-selection-display') || {}).textContent);
      const ms = await analyze(m);
      check(`${theme}: the must-gather Histogram analyses its default selection (${sel}) and finds the planted anomalies (the new reconcile errors, the expired certificate, the crash's panic)`, ms.shown && ms.kinds.includes('New') && ms.whats.some((w) => /reconcile failed/.test(w)) && ms.whats.some((w) => /tls handshake failed|certificate/.test(w)) && ms.whats.some((w) => /panic/.test(w)), JSON.stringify({ kinds: ms.kinds, whats: ms.whats.slice(0, 6), sel }));
      check(`${theme}: the must-gather links name the containers (ns/pod/container)`, ms.opens.some((qq) => qq.includes('sources=demo-app%2Fapi-0%2Fapi')), JSON.stringify(ms.opens.slice(0, 4)));
      await shot(pg, `histogram-mustgather-${theme}.png`);
      for (const w of [1010, 420]) {
        await frameWidth(pg, w);
        const o = await overflow(m);
        check(`${theme}: no horizontal overflow at ${w} px (must-gather)`, !o.pageOver && !o.bad.length, JSON.stringify(o));
      }
      await resetWidth(pg);
      // ---- Cancel: a slow analysis
      delay = 4000;
      const cancelsBefore = calls.cancel;
      await m.evaluate(() => { document.getElementById('lh-kind').value = ''; document.getElementById('lh-analyze').click(); });
      await sleep(600);
      const mid = await m.evaluate(() => ({ button: document.getElementById('lh-analyze').textContent.trim(), status: document.getElementById('lh-status').textContent }));
      await m.evaluate(() => document.getElementById('lh-analyze').click());
      await sleep(800);
      const after = await m.evaluate(() => ({ button: document.getElementById('lh-analyze').textContent.trim(), status: document.getElementById('lh-status').textContent }));
      delay = 0;
      check(`${theme}: a slow analysis shows Cancel; Cancel stops it (the cancel route is called, Analyze is back, the status says so)`, mid.button === 'Cancel' && /Analyzing/.test(mid.status) && after.button === 'Analyze' && /cancelled/i.test(after.status) && calls.cancel > cancelsBefore, JSON.stringify({ mid, after, cancels: calls.cancel - cancelsBefore }));
      await sleep(4500);   // the slow answer lands after the cancel: ignored
      const late = await m.evaluate(() => document.getElementById('lh-status').textContent);
      check(`${theme}: the answer that arrives after a cancel is ignored`, /cancelled/i.test(late), late);
    } else check(`${theme}: the must-gather Histogram opens`, false);
    const frameErrs = await pg.evaluate(() => window.__errs || []);
    check(`${theme}: no uncaught error in the app or the frames`, !errors.length && !frameErrs.length, JSON.stringify(errors.concat(frameErrs)).slice(0, 600));
    await context.close();
  }
} finally {
  await stop();
}
// the AI context: /get_tab_data refuses the Histogram (the real route)
const ai = backend('/get_tab_data', { directory: SOS, report_type: 'sosreport', tab: 'log_histogram' });
check('/get_tab_data answers no data for the Histogram (not AI context)', ai.status === 200 && ai.json && ai.json.data === null && /not shared as AI context/.test(ai.json.excluded || ''), JSON.stringify(ai));
console.log(`\nScreenshots: ${OUT}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
