#!/usr/bin/env node
/*
 * The shared Log Viewer (tabs/_log_view.html + diagLogView in backend/static/diagnostics-ui.js) run against BOTH
 * adapters with the same assertions: the sosreport one (the streamed journal parse, answered here from canned SSE
 * rows) and the must-gather one (the paged /mustgather_log_search, answered for real by the Flask test client over
 * the synthetic gather through tests/helpers/diagnostics-api.py, page by page).
 *
 * Static: both templates only pick their adapter (the shared include, the viewer macro, the modal, the mount call,
 * nothing else); the shared pieces exist; the frame allow-lists the must-gather routes.
 *
 * Browser (the app in Vite, playwright-core): for each adapter - the shared layout (the picker, the date range, the
 * actions, the status, the filter row, the table with the adapter's column labels, the pager); the sources listed
 * (a must-gather's grouped by namespace, with the host services); Load Logs fills the table and the status; the
 * charts appear; the search, Filter out, the level and the process selects filter the rows with the right counts;
 * a click on a severity bar sets the level filter; the pager pages; the Level header sorts; Export CSV downloads
 * the filtered rows with the adapter's file name; a slow load shows Abort and the busy pill, Abort stops it (the
 * must-gather one calls the cancel route); a cross-link query fills the search; no horizontal overflow at 1920,
 * 1010 and 420; dark and light screenshots of both viewers at 1360 side by side (LOGVIEW_OUT).
 *
 *   node tests/diagnostics-log-view.test.mjs        env: SMOKE_PORT, LOGVIEW_OUT, SKIP_BROWSER_TESTS=1 (static only)
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
{
  const ui = read('backend/static/diagnostics-ui.js');
  check('diagnostics-ui.js defines diagLogView (mount, the sosreport and must-gather adapters, the SSE reader)', /window\.diagLogView = \{ mount: mount, adapters: adapters, sseReader: sseReader, applyQuery: applyQueryWhenMounted \};/.test(ui) && /mustgather\(opts\) \{/.test(ui) && /sosreport\(opts\) \{/.test(ui) && /'\/mustgather_log_search'/.test(ui) && /'\/parse_log_viewer_stream'/.test(ui));
  check('the viewer macro and the modal live in tabs/_log_view.html; the lv-* rules in the shared stylesheet', /macro viewer\(sources, unavailable=\[\], date_range=None, source_noun='log file', columns=/.test(read('backend/templates/tabs/_log_view.html')) && /macro alert_modal\(\)/.test(read('backend/templates/tabs/_log_view.html')) && /#diagnostics-content \.lv-slider-track/.test(read('backend/static/styles.css')) && /#diagnostics-content \.ui-logview-group/.test(read('backend/static/styles.css')));
  for (const [file, adapter] of [['sosreport_log_viewer.html', 'sosreport'], ['mustgather_log_viewer.html', 'mustgather']]) {
    const t = read('backend/templates/tabs/' + file);
    check(`${file} only picks the ${adapter} adapter: the shared include, the viewer macro, the modal and the mount call; no markup, script function, table or style of its own`,
      /\{% import "tabs\/_log_view\.html" as logview %\}/.test(t) && /logview\.viewer\(/.test(t) && /logview\.alert_modal\(\)/.test(t) && new RegExp(`adapters\\.${adapter}\\(`).test(t) && /diagLogView\.mount\(/.test(t)
      && !/<style/.test(t) && !/<table/.test(t) && !/function /.test(t) && !/id="log-search"/.test(t) && t.split('\n').length < 30, t.split('\n').length + ' lines');
  }
  const diag = read('src/components/DiagnosticsPage.jsx');
  check('the frame allow-lists the must-gather search, cancel and date range (plain requests) beside the sosreport stream', /'\/mustgather_log_search', '\/mustgather_log_cancel', '\/mustgather_log_date_range'\]/.test(diag) && /DIAGNOSTICS_API_STREAM_ALLOWLIST = new Set\(\['\/parse_log_viewer_stream'\]\)/.test(diag));
  const reg = read('backend/log_viewer.py');
  check('the must-gather registry has the Log Viewer under Log Collection (parsers.mustgather.log_viewer), as the sosreport does', /'log_collection': \{\s*'module': 'parsers\.mustgather\.log_collection',[\s\S]{0,300}'sub_tabs': \{\s*'log_viewer': \{\s*'module': 'parsers\.mustgather\.log_viewer',\s*'icon': 'fas fa-file-alt',\s*'label': 'Log Viewer'/.test(reg));
}
if (process.env.SKIP_BROWSER_TESTS) { console.log(failed ? `\n${failed} check(s) failed` : '\nAll static checks passed (browser part skipped)'); process.exit(failed ? 1 : 0); }
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot render the tabs'); process.exit(failed ? 1 : 0); }
const OUT = process.env.LOGVIEW_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-logview-'));
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// The fixtures: both synthetic reports, the Log Viewer tab of each rendered through Flask
// ---------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-logview-fixture-'));
const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
if (gen.status !== 0) { console.log('SKIP: could not build the synthetic diagnostics fixtures: ' + (gen.stderr || '').slice(0, 200)); process.exit(failed ? 1 : 0); }
const NAMES = { sosreport: 'sosreport-web-01-2026-10-13-abcdef', mustgather: 'must-gather.local.1234567890' };
// this test's copy of the gather also carries two container logs in shapes real gathers have and the synthetic one
// lacks: a raw RFC3339 log without the CRI prefix (a previous run of the cache) and a sidecar's log without any
// timestamps (the picker lists both; the date range and the load must take them)
{
  const mg = path.join(work, NAMES.mustgather);
  const inner = fs.readdirSync(mg).map((d) => path.join(mg, d)).find((d) => fs.existsSync(path.join(d, 'namespaces')));
  const cache = path.join(inner, 'namespaces', 'demo-app', 'pods', 'demo-cache-6c8d7f9b4-pqrst', 'cache', 'cache', 'logs');
  fs.writeFileSync(path.join(cache, 'previous.log'), Array.from({ length: 30 }, (_, i) => `2026-10-12T08:${String(i).padStart(2, '0')}:00.000000000Z [info] cache warming ${i}`).join('\n') + '\n');
  const envoy = path.join(inner, 'namespaces', 'demo-app', 'pods', 'demo-web-7d9f8b6c5-klmno', 'envoy', 'envoy', 'logs');
  fs.mkdirSync(envoy, { recursive: true });
  fs.writeFileSync(path.join(envoy, 'current.log'), ['envoy starting', 'listening on :8080'].concat(Array.from({ length: 9 }, (_, i) => `GET /healthz 200 ${i}`), ['draining']).join('\n') + '\n');
}
const reports = {};
for (const type of ['sosreport', 'mustgather']) {
  const htmlDir = path.join(work, 'html-' + type);
  const ren = spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', htmlDir, '--fixture', path.join(work, NAMES[type]), '--report-type', type, '--tabs', 'log_viewer'], { encoding: 'utf8' });
  check(`the ${type} Log Viewer renders through Flask over the synthetic report`, ren.status === 0, (ren.stderr || '').slice(-400));
  if (ren.status !== 0) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  // the report's path is its real directory: the must-gather search runs for real through the Flask test client
  reports[type] = { name: NAMES[type], path: path.join(work, NAMES[type]), type, modified: 1760000000, html: { log_viewer: fs.readFileSync(path.join(htmlDir, 'log_viewer.html'), 'utf8') }, tabs: JSON.parse(fs.readFileSync(path.join(htmlDir, 'tabs.json'), 'utf8')) };
}

// the sosreport adapter's rows: canned SSE over 420 rows (7 processes, the levels in a known mix, two days)
const SEV = ['info', 'warning', 'error', 'debug', 'info', 'other', 'critical'];
const ROWS = Array.from({ length: 420 }, (_, i) => ({ timestamp: `Oct ${13 + (i % 2)} ${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`, timestamp_obj: `2026-10-${13 + (i % 2)}T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`, severity: SEV[i % 7], hostname: 'web-01', process: ['systemd', 'kernel', 'sshd', 'crond', 'NetworkManager', 'example-app', 'dnf'][i % 7], pid: String(1000 + i), message: `synthetic line ${i} (${SEV[i % 7]})${i % 10 === 0 ? ' edge case' : ''}` }));
const expectRows = ({ search = [], exclude = [], severity = '', process = '' } = {}) => ROWS.filter((r) => { const t = `${r.timestamp} ${r.severity} ${r.hostname} ${r.process} ${r.pid} ${r.message}`.toLowerCase(); return (!severity || r.severity === severity) && (!process || r.process === process) && (!search.length || search.some((s) => t.includes(s))) && !(exclude.length && exclude.some((s) => t.includes(s))); });

const PORT = Number(process.env.SMOKE_PORT || 5341);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(failed ? 1 : 0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

// the backend answers of the two adapters: canned SSE for the sosreport stream, the real search for the must-gather
let delay = 0;
const calls = { stream: 0, search: 0, cancel: 0, range: 0, lastStream: null };
function backend(route, body) {
  const tmp = path.join(OUT, `req-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(body));
  const out = spawnSync(PYTHON, ['-I', path.join(REPO, 'tests', 'helpers', 'diagnostics-api.py'), '--path', route, '--body-file', tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.unlinkSync(tmp);
  let parsed = { status: 500, json: { error: (out.stderr || '').slice(-300) } };
  try { parsed = JSON.parse(out.stdout); } catch { /* the error above */ }
  return parsed;
}
async function open(theme) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: theme, acceptDownloads: true });
  await context.addInitScript(({ theme, dir }) => {
    try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify(theme)); localStorage.setItem('diagnosticsReportsDirectory', dir); localStorage.removeItem('diagnostics-page-session'); } catch { /* storage off */ }
    // every document (the app and each frame the app creates) keeps its own errors with their stacks
    window.__errs = []; window.addEventListener('error', (e) => { window.__errs.push(((e.error && e.error.stack) || e.message || '').slice(0, 700)); });
  }, { theme, dir: work });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.6', protocol: 2 } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
  await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
  await context.route('http://localhost:8080/list_reports', (r) => r.fulfill({ json: { reports: Object.values(reports).map(({ name, path: p, type, modified }) => ({ name, path: p, type, modified })) } }));
  await context.route('http://localhost:8080/get_tabs', (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const rep = Object.values(reports).find((x) => x.path === body.directory) || reports.sosreport; r.fulfill({ json: { tabs: rep.tabs, report_type: rep.type, directory: rep.path } }); });
  await context.route('http://localhost:8080/get_tab_data', (r) => r.fulfill({ json: {} }));
  await context.route('http://localhost:8080/static/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: read('backend/static/styles.css') }));
  await context.route('http://localhost:8080/load_tab', async (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const rep = Object.values(reports).find((x) => x.path === body.directory); const key = body.sub_tab || body.tab; r.fulfill({ json: { html: (rep && rep.html[key]) || `<div class="panel rounded-lg shadow-sm"><p>${key} (not rendered)</p></div>` } }); });
  await context.route('http://localhost:8080/parse_log_viewer_stream', async (r) => { calls.stream += 1; let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } calls.lastStream = body; if (delay) await sleep(delay); const q = (body.query || []).map((t) => String(t).toLowerCase()), ex = (body.exclude || []).map((t) => String(t).toLowerCase()); const keep = (e) => { const text = `${e.hostname} ${e.process} ${e.message}`.toLowerCase(); return (!body.level || e.severity === body.level) && (!body.process || e.process === body.process) && (!q.length || q.some((t) => text.includes(t))) && (!ex.length || !ex.some((t) => text.includes(t))); }; const rows = (q.length || ex.length || body.level || body.process) ? ROWS.filter(keep) : ROWS; if (rows !== ROWS) { r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ entries: rows, total_count: rows.length, scanned: ROWS.length, file: 1, files: 1, done: false }) + '\n\ndata: ' + JSON.stringify({ done: true }) + '\n\n' }); return; } r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ entries: ROWS.slice(0, 200), total_count: ROWS.length, file: 1, files: 1 }) + '\n\n' + 'data: ' + JSON.stringify({ entries: ROWS.slice(200), total_count: ROWS.length, file: 1, files: 1 }) + '\n\n' + 'data: {"done": true}\n\n' }); });
  await context.route('http://localhost:8080/get_log_date_range', async (r) => { calls.range += 1; let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } if (body.directory === reports.mustgather.path) { const a = backend('/get_log_date_range', body); r.fulfill({ status: a.status, json: a.json }); } else r.fulfill({ json: { date_range: { start: '2026-10-13T00:00:00', end: '2026-10-14T23:59:00' } } }); });
  await context.route('http://localhost:8080/mustgather_log_search', async (r) => { calls.search += 1; let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } if (delay) await sleep(delay); const a = backend('/mustgather_log_search', body); r.fulfill({ status: a.status, json: a.json }); });
  await context.route('http://localhost:8080/mustgather_log_date_range', async (r) => { calls.range += 1; let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const a = backend('/mustgather_log_date_range', body); r.fulfill({ status: a.status, json: a.json }); });
  await context.route('http://localhost:8080/mustgather_log_cancel', async (r) => { calls.cancel += 1; let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const a = backend('/mustgather_log_cancel', body); r.fulfill({ status: a.status, json: a.json }); });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.stack || e.message).slice(0, 400)));
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  return { context, page, errors };
}
const clickButton = (page, label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
const clickSidebar = (page, label, after) => page.evaluate(({ label, after }) => { const all = Array.from(document.querySelectorAll('div.cursor-pointer span')); const from = after ? all.findIndex((el) => el.textContent.trim() === after) + 1 : 0; const s = all.slice(from).find((el) => el.textContent.trim() === label); if (!s) return false; s.closest('div.cursor-pointer').click(); return true; }, { label, after });
const expandGroup = (page, label) => page.evaluate((label) => { const span = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label); const row = span && span.closest('div.cursor-pointer').parentElement; const btn = row && row.querySelector('button[title="Expand"]'); if (btn) { btn.click(); return 'expanded'; } return row && row.querySelector('button[title="Collapse"]') ? 'already' : 'no chevron'; }, label);
async function frameFor(page, key) {
  for (let i = 0; i < 80; i++) {
    const h = await page.$(`iframe[title="Diagnostics content"][data-tab="${key}"]`);
    if (h) { const f = await h.contentFrame(); if (f) { try { if (await f.evaluate(() => document.readyState === 'complete' && !!document.querySelector('#diagnostics-content'))) return f; } catch { /* navigating */ } } }
    await sleep(250);
  }
  return null;
}
async function frameWidth(page, fw) {
  await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); if (f.dataset.w === undefined) f.dataset.w = f.style.width; });
  if (fw >= 1360) { await page.setViewportSize({ width: fw, height: 1000 }); await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w; }); }
  else { await page.setViewportSize({ width: 1360, height: 1000 }); await page.evaluate((fw) => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = fw + 'px'; }, fw); }
  await sleep(600);
}
const resetWidth = async (page) => { await page.setViewportSize({ width: 1360, height: 900 }); await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w || ''; }); await sleep(300); };
const overflow = (frame) => frame.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [];
  document.querySelectorAll('#diagnostics-content *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    if (el.closest('svg') && el.tagName !== 'svg') return;
    if (el.closest('#log-file-dropdown-panel, #date-calendar, #alert-modal')) return;   // the pop-overs are fixed boxes
    if (r.right > w + 1) {
      let clip = null;
      for (let p = el.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) { clip = p; break; } }
      if (!clip || clip.getBoundingClientRect().right > w + 1) bad.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' right ' + Math.round(r.right));
    }
  });
  return { w, pageOver: document.documentElement.scrollWidth > w + 1, bad: bad.slice(0, 6) };
});
// the viewer's state as the page shows it
const state = (frame) => frame.evaluate(() => {
  const t = (id) => (document.getElementById(id) || {}).textContent || '';
  const rows = Array.from(document.querySelectorAll('#log-table-body tr'));
  return {
    loaded: t('loaded-count').trim(), top: t('entry-count-top').trim(), status: t('entry-count').trim(), rows: rows.length,
    first: rows[0] ? Array.from(rows[0].cells).map((c) => c.textContent.trim().slice(0, 60)) : null,
    levels: rows.map((r) => r.getAttribute('data-severity')),
    loadLabel: t('load-logs-btn').trim(), exportDisabled: !!(document.getElementById('export-csv-btn') || {}).disabled,
    chartsShown: Array.from(document.querySelectorAll('[data-chart-card]')).filter((c) => !c.hidden).length,
    processes: Array.from(document.querySelectorAll('#process-filter option')).map((o) => o.value).filter(Boolean),
    pager: Array.from(document.querySelectorAll('#pagination-controls button')).map((b) => b.textContent.trim()).filter(Boolean),
    pill: !!(document.getElementById('ui-busy-pill') && document.getElementById('ui-busy-pill').getBoundingClientRect().height > 0 && getComputedStyle(document.getElementById('ui-busy-pill')).visibility !== 'hidden'),
    noResults: !(document.getElementById('no-results') || { classList: { contains: () => true } }).classList.contains('hidden'),
  };
});
const waitLoaded = async (frame) => { for (let i = 0; i < 80; i++) { const s = await state(frame); if (/^Loaded [\d,]+ entries$/.test(s.loaded) && s.loadLabel === 'Load Logs') return s; await sleep(250); } return state(frame); };

// the same exercise for both adapters
async function exercise(page, frame, type, theme, errors) {
  const tag = `${theme}: ${type}`;
  const MG = type === 'mustgather';
  // the layout: the shared markup with the adapter's column labels, the picker with the sources
  const layout = await frame.evaluate(() => ({
    ids: ['log-view', 'single-date-button', 'date-slider-container', 'date-slider-start', 'date-slider-end', 'log-file-dropdown-btn', 'log-file-list', 'get-range-btn', 'load-logs-btn', 'export-csv-btn', 'log-search', 'log-exclude', 'severity-filter', 'process-filter', 'log-table-body', 'pagination-controls', 'alert-modal'].filter((id) => !document.getElementById(id)),
    heads: Array.from(document.querySelectorAll('#log-view thead th')).map((h) => h.textContent.trim().split(/\s/)[0] + (h.textContent.includes('/') ? h.textContent.trim().replace(/\s+/g, ' ').split(' ').slice(0, 3).join(' ') : '')),
    headText: Array.from(document.querySelectorAll('#log-view thead th')).map((h) => h.textContent.trim().replace(/\s+/g, ' ')),
    sources: Array.from(document.querySelectorAll('.log-file-item')).map((l) => l.getAttribute('data-log-name')),
    groups: Array.from(document.querySelectorAll('.ui-logview-group')).map((g) => g.textContent.trim()),
    checked: Array.from(document.querySelectorAll('.log-file-checkbox:checked')).map((c) => c.getAttribute('data-name')),
    labels: [document.getElementById('date-start-label').textContent, document.getElementById('date-end-label').textContent],
    picker: document.getElementById('log-file-selection-display').textContent.trim(),
    primary: document.getElementById('load-logs-btn').classList.contains('btn-primary'),
  }));
  check(`${tag}: the shared viewer markup (every id), Load Logs the primary button, the table head with the adapter's labels`, layout.ids.length === 0 && layout.primary && (MG ? layout.headText.join('|').startsWith('Timestamp|Level|Pod / node|Container / service|Message') : layout.headText.join('|').startsWith('Timestamp|Level|Hostname|Process|Message')), JSON.stringify(layout).slice(0, 500));
  if (MG) check(`${tag}: the picker lists the container logs grouped by namespace (${layout.groups.length} groups) and the host services, nothing checked at first, the slider on the gather's day`, layout.groups.length >= 5 && layout.groups.includes('Containers: payments-demo') && layout.groups.includes('Host services') && layout.sources.some((s) => s.includes('payments-worker-7b8c9d0e1-efghi/worker (previous)')) && layout.checked.length === 0 && layout.picker === 'No files selected' && layout.labels[0] === '2026-10-12', JSON.stringify(layout).slice(0, 500));
  else check(`${tag}: the picker lists the report's log files with the system journal checked, the slider on the report's range`, layout.sources.length >= 3 && layout.checked.length === 1 && /journalctl/.test(layout.checked[0]) && /^\d{4}-\d{2}-\d{2}$/.test(layout.labels[0]), JSON.stringify(layout).slice(0, 500));
  // the calendar: the shared date-range picker (diagDateRange). Opened on the slider's range: the start and the end in
  // the selected role (white on the selected blue, 4.5:1), the days between on the band, nothing else tinted, no cell
  // bordered, the days outside the logs' dates disabled with a tooltip, SVG chevrons that change the month, the start
  // cell focused; a click then a click sets the range (the label and the slider follow), hovering previews the band,
  // a disabled day does nothing, the arrow keys move and Enter picks, Escape closes
  {
    const lum = (rgb) => { const m = rgb.match(/[\d.]+/g) || [0, 0, 0]; const f = (v) => { v = Number(v) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const calState = () => frame.evaluate(() => {
      const probe = (v) => { const p = document.createElement('div'); p.style.background = v; document.body.appendChild(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c; };
      const cells = Array.from(document.querySelectorAll('#cal-grid .ui-dr-day')).map((b) => { const cs = getComputedStyle(b); return { d: b.dataset.date, cls: b.className, bg: cs.backgroundColor, fg: cs.color, border: cs.borderTopWidth, disabled: b.disabled, title: b.title, tab: b.tabIndex }; });
      return { sel: probe('var(--btn-selected-bg)'), band: probe('var(--btn-selected-tint-strong)'), cells, labels: [document.getElementById('date-start-label').textContent, document.getElementById('date-end-label').textContent], display: document.getElementById('single-date-display').textContent.trim(), slider: [document.getElementById('date-slider-start').value, document.getElementById('date-slider-end').value], title: document.getElementById('cal-month-year').textContent, navSvg: [!!document.querySelector('#cal-prev-month svg'), !!document.querySelector('#cal-next-month svg')], open: !document.getElementById('date-calendar').classList.contains('hidden'), focused: document.activeElement && document.activeElement.classList.contains('ui-dr-day') ? document.activeElement.dataset.date : null };
    });
    const clickDay = async (d) => { await frame.evaluate((d) => { const b = document.querySelector(`#cal-grid .ui-dr-day[data-date="${d}"]`); if (b) b.click(); }, d); await sleep(150); };
    const plus = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
    await frame.evaluate(() => document.getElementById('single-date-button').click()); await sleep(300);
    const c0 = await calState();
    const [s0, s1] = c0.labels;
    const startCell = c0.cells.find((c) => c.d === s0), endCell = c0.cells.find((c) => c.d === s1);
    const between = c0.cells.filter((c) => c.d > s0 && c.d < s1), others = c0.cells.filter((c) => c.d < s0 || c.d > s1);
    check(`${tag}: the calendar opens on ${c0.title} with the start ${s0} and the end ${s1} in the selected role (${startCell ? contrast(startCell.fg, startCell.bg).toFixed(1) : '-'}:1), the ${between.length} days between on the band, no other day tinted, no cell bordered, the ${others.length} days outside the logs' dates disabled with a tooltip, SVG chevrons, the start cell focused`,
      c0.open && !!startCell && !!endCell && startCell.bg === c0.sel && endCell.bg === c0.sel && contrast(startCell.fg, startCell.bg) >= 4.5 && /\bui-dr-start\b/.test(startCell.cls) && /\bui-dr-end\b/.test(endCell.cls) && between.every((c) => c.bg === c0.band && /\bui-dr-in\b/.test(c.cls)) && others.every((c) => c.bg !== c0.sel && c.bg !== c0.band) && c0.cells.every((c) => c.border === '0px') && others.every((c) => c.disabled && /Outside the logs' dates/.test(c.title)) && c0.navSvg[0] && c0.navSvg[1] && c0.focused === s0,
      JSON.stringify({ title: c0.title, labels: c0.labels, start: startCell, end: endCell, betweenBad: between.filter((c) => c.bg !== c0.band).slice(0, 2), othersOn: others.filter((c) => !c.disabled || c.bg === c0.sel || c.bg === c0.band).slice(0, 3), bordered: c0.cells.filter((c) => c.border !== '0px').length, nav: c0.navSvg, focused: c0.focused, sel: c0.sel, band: c0.band }).slice(0, 1200));
    await frame.evaluate(() => document.getElementById('cal-next-month').click()); await sleep(150);
    const t1 = (await calState()).title;
    await frame.evaluate(() => document.getElementById('cal-prev-month').click()); await sleep(150);
    const t2 = (await calState()).title;
    check(`${tag}: the chevrons move a month forward (${t1}) and back (${t2})`, t1 !== c0.title && t2 === c0.title, JSON.stringify([c0.title, t1, t2]));
    // a click, a hover (the preview band), a click: the label and the slider follow; a disabled day does nothing
    const single = s0 === s1;
    const a = s0, b = single ? s0 : plus(s0, 1);
    await clickDay(a);
    const c1 = await calState();
    await frame.evaluate((d) => { const b = document.querySelector(`#cal-grid .ui-dr-day[data-date="${d}"]`); if (b) b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); }, s1); await sleep(150);
    const hov = await calState();
    const previewN = hov.cells.filter((c) => c.cls.split(' ').includes('ui-dr-preview')).length;
    await clickDay(b);
    const c2 = await calState();
    check(`${tag}: a click sets the start (${c1.display}), hovering ${s1} previews the band (${previewN} days), the second click sets the range (${c2.display}): the header label and the slider follow (${c2.labels.join(' to ')}, slider ${c2.slider.join('-')})`,
      c1.display === a && c1.slider.join('-') === c0.slider.join('-') && previewN === Math.max(0, between.length) && c2.display === (single ? a : `${a} - ${b}`) && c2.labels[0] === a && c2.labels[1] === b && c2.slider[0] === '0' && c2.slider[1] === (single ? '0' : '1'), JSON.stringify({ c1: c1.display, previewN, c2: { display: c2.display, labels: c2.labels, slider: c2.slider } }));
    const dis = c2.cells.find((c) => c.disabled);
    if (dis) { await clickDay(dis.d); const c3 = await calState(); check(`${tag}: a disabled day (${dis.d}) is not clickable: the range stays`, c3.display === c2.display && c3.labels.join() === c2.labels.join(), JSON.stringify(c3.display)); }
    // the keyboard: the focus on the start, ArrowRight moves a day (when it is one of the logs' days), Enter picks, Escape closes
    await frame.evaluate((d) => { const b = document.querySelector(`#cal-grid .ui-dr-day[data-date="${d}"]`); if (b) b.focus(); }, a);
    await page.keyboard.press('ArrowRight'); await sleep(120);
    const k1 = await calState();
    await page.keyboard.press('Enter'); await sleep(150);
    const k2 = await calState();
    await page.keyboard.press('Escape'); await sleep(200);
    const k3 = await calState();
    check(`${tag}: ArrowRight moves the focus to ${single ? 'the next day (disabled: the focus stays)' : plus(a, 1)}, Enter starts a new range there (${k2.display}), Escape closes the calendar`, (single ? k1.focused === a : k1.focused === plus(a, 1)) && k2.display === (single ? a : plus(a, 1)) && !k3.open, JSON.stringify({ k1: k1.focused, k2: k2.display, open: k3.open }));
    // the whole range again for the rest of the run: Clear (it closes the calendar), then the two clicks
    await frame.evaluate(() => document.getElementById('single-date-button').click()); await sleep(250);
    await frame.evaluate(() => document.getElementById('cal-clear').click()); await sleep(200);
    await frame.evaluate(() => document.getElementById('single-date-button').click()); await sleep(250);
    await clickDay(s0); await clickDay(s1);
    const back = await calState();
    await frame.evaluate(() => document.getElementById('single-date-button').click()); await sleep(150);
    check(`${tag}: the range set back to ${s0} to ${s1} through the calendar (slider ${back.slider.join('-')})`, back.labels[0] === s0 && back.labels[1] === s1 && back.slider[0] === '0', JSON.stringify(back.labels));
  }
  // a cross-link's source list (diagLinks -> diagLogView.applyQuery): the named sources checked and nothing else, their
  // range read, the logs loaded, the term in the search; a name nothing matches says so
  {
    const link = MG ? 'sources=payments-demo/payments-worker-7b8c9d0e1-efghi&q=ConfigError' : 'sources=' + encodeURIComponent('journalctl (system)') + '&q=edge%20case';
    const r0 = calls.range;
    const routed = await frame.evaluate((q) => window.diagLinks.applyQuery(q), link);
    let ls = await waitLoaded(frame);
    const dl = await frame.evaluate(() => ({ checked: Array.from(document.querySelectorAll('.log-file-checkbox:checked')).map((c) => c.getAttribute('data-name')), search: document.getElementById('log-search').value, display: document.getElementById('log-file-selection-display').textContent.trim() }));
    check(`${tag}: the deep link "${decodeURIComponent(link)}" is routed to the viewer: ${dl.checked.length} source(s) checked (${dl.checked.join(', ')}), the range read, the logs loaded (${ls.loaded}), the term in the search (${dl.search})`,
      routed && calls.range > r0 && /^Loaded/.test(ls.loaded) && (MG ? dl.checked.length === 3 && dl.checked.every((n) => /payments-worker-7b8c9d0e1-efghi\/worker \((current|previous|previous\.insecure)\)$/.test(n)) && dl.search === 'ConfigError' : dl.checked.length === 1 && /journalctl \(system\)/.test(dl.checked[0]) && dl.search === 'edge case'), JSON.stringify({ routed, dl, loaded: ls.loaded }));
    if (MG) {
      await frame.evaluate(() => window.diagLinks.applyQuery('sources=host:masters')); ls = await waitLoaded(frame);
      const hosts = await frame.evaluate(() => Array.from(document.querySelectorAll('.log-file-checkbox:checked')).map((c) => c.getAttribute('data-name')));
      check(`${tag}: "sources=host:masters" checks the masters' host service logs only (${hosts.join(', ')}) and loads them (${ls.loaded})`, hosts.length === 2 && hosts.every((n) => /^masters\//.test(n)) && /^Loaded/.test(ls.loaded), JSON.stringify(hosts));
      await frame.evaluate(() => window.diagLinks.applyQuery('sources=payments-demo/payments-worker-7b8c9d0e1-efghi/worker,host:masters/kubelet_service.log')); ls = await waitLoaded(frame);
      const mix = await frame.evaluate(() => Array.from(document.querySelectorAll('.log-file-checkbox:checked')).map((c) => c.getAttribute('data-name')));
      check(`${tag}: one container (its three logs) and one host file by name (${mix.length} sources: ${mix.join(', ')})`, mix.length === 4 && mix.filter((n) => /\/worker \(/.test(n)).length === 3 && mix.includes('masters/kubelet_service.log'), JSON.stringify(mix));
    }
    await frame.evaluate(() => window.diagLinks.applyQuery('sources=nowhere/nothing')); await sleep(400);
    const none = await frame.evaluate(() => ({ modal: !document.getElementById('alert-modal').classList.contains('hidden'), title: document.getElementById('alert-modal-title').textContent, checked: document.querySelectorAll('.log-file-checkbox:checked').length }));
    await frame.evaluate(() => document.getElementById('alert-modal-ok').click()); await sleep(100);
    check(`${tag}: a source list nothing matches says so ("${none.title}") and checks nothing`, none.modal && none.title === 'No Matching Logs' && none.checked === 0, JSON.stringify(none));
    await page.screenshot({ path: path.join(OUT, `logview-deeplink-${type}-${theme}.png`), fullPage: false });
    // the picker as the next steps expect it: nothing picked on the must-gather (they pick), the journal on the sosreport
    await frame.evaluate((MG) => { document.querySelectorAll('.log-file-checkbox').forEach((c) => { c.checked = !MG && /journalctl \(system\)/.test(c.getAttribute('data-name')); c.dispatchEvent(new Event('change', { bubbles: true })); }); }, MG);
    await frame.evaluate(() => { const f = document.getElementById('log-search'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(300);
  }
  // the short page the user saw: nothing loaded, the frame's content ends just below the empty table, the pane has
  // room to spare. The picker and the calendar must still paint whole: the frame grows under the panel (the body's
  // min-height through the height bridge), the panel inside the iframe's box and the pane's view as the app's
  // document sees them, its end and its last item reachable, the search field the head's full width; the frame
  // shrinks back on close
  const appBox = () => page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); let s = f.parentElement; while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement; const r = f.getBoundingClientRect(); const sr = s.getBoundingClientRect(); return { frame: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }, pane: { top: sr.top, bottom: sr.bottom } }; });
  const appHit = (x, y) => page.evaluate(({ x, y }) => { const f = document.querySelector('iframe[title="Diagnostics content"]'); const r = f.getBoundingClientRect(); return document.elementFromPoint(r.left + x, r.top + y) === f; }, { x, y });
  const shortPage = async (fw, id, btnId, label) => {
    const before = await appBox();
    await frame.evaluate((btnId) => document.getElementById(btnId).click(), btnId); await sleep(700);
    const after = await appBox();
    const p = await frame.evaluate((id) => {
      const panel = document.getElementById(id); const r = panel.getBoundingClientRect();
      const body = panel.querySelector('.ui-popover-body'); if (body) body.scrollTop = body.scrollHeight;
      const items = Array.from(panel.querySelectorAll('.log-file-item')); const last = items[items.length - 1]; const lr = last ? last.getBoundingClientRect() : null;
      const head = panel.querySelector('.ui-popover-head'); const input = head && head.querySelector('input'); const hr = head && head.getBoundingClientRect(); const ir = input && input.getBoundingClientRect();
      const probe = lr ? [lr.left + lr.width / 2, lr.top + lr.height / 2] : [r.left + r.width / 2, r.bottom - 20];
      const at = document.elementFromPoint(probe[0], probe[1]);
      return { open: !panel.classList.contains('hidden'), placement: panel.getAttribute('data-placement'), top: r.top, bottom: r.bottom, left: r.left, right: r.right, probe, lastInPanel: !lr || (lr.top >= r.top - 1 && lr.bottom <= r.bottom + 1), lastHit: !lr || (!!at && (at === last || last.contains(at))), searchFull: !ir || Math.abs((hr.width - 16) - ir.width) <= 2, searchW: ir ? Math.round(ir.width) : null, headW: hr ? Math.round(hr.width) : null, bodyH: body ? body.clientHeight : null, frameH: document.documentElement.clientHeight, bodyMin: document.body.style.minHeight };
    }, id);
    const hit = await appHit(p.probe[0], p.probe[1]);
    const fx = after.frame.left, fy = after.frame.top;
    const inFrame = fy + p.top >= after.frame.top - 1 && fy + p.bottom <= after.frame.bottom + 1 && fx + p.left >= after.frame.left - 1 && fx + p.right <= after.frame.right + 1;
    const inPane = fy + p.top >= after.pane.top - 1 && fy + p.bottom <= after.pane.bottom + 1;
    await frame.evaluate((btnId) => document.getElementById(btnId).click(), btnId); await sleep(700);
    const closed = await appBox();
    const minBack = await frame.evaluate(() => document.body.style.minHeight === '');
    check(`${tag}: ${label} on the short page at ${fw}: opens ${p.placement} (the frame ${Math.round(before.frame.height)} -> ${Math.round(after.frame.height)} px), whole inside the iframe's box and the pane's view, its end under the pointer from the app, the last item reachable by scrolling the list, the search the head's full width; closed, the frame is back at ${Math.round(closed.frame.height)} px`, p.open && p.placement === 'below' && inFrame && inPane && hit && p.lastInPanel && p.lastHit && p.searchFull && after.frame.height >= before.frame.height && closed.frame.height <= before.frame.height + 2 && minBack, JSON.stringify({ p, before: before.frame.height, after: after.frame.height, closed: closed.frame.height, inFrame, inPane, hit, minBack }));
  };
  for (const fw of [1010, 1360, 1920]) {
    await frameWidth(page, fw); await page.setViewportSize({ width: Math.max(fw, 1360), height: 1200 }); await sleep(500);
    await shortPage(fw, 'log-file-dropdown-panel', 'log-file-dropdown-btn', 'the file picker');
    await shortPage(fw, 'date-calendar', 'single-date-button', 'the calendar');
  }
  await resetWidth(page);
  // the message box: Load Logs with nothing picked opens the alert dialog, its OK button the primary role (never the brand purple)
  if (MG) {
    await frame.evaluate(() => document.getElementById('load-logs-btn').click()); await sleep(300);
    const dlg = await frame.evaluate(() => { const m = document.getElementById('alert-modal'); const ok = document.getElementById('alert-modal-ok'); const load = document.getElementById('load-logs-btn'); const cs = getComputedStyle(ok); return { open: !m.classList.contains('hidden'), title: document.getElementById('alert-modal-title').textContent, cls: ok.className, bg: cs.backgroundColor, loadBg: getComputedStyle(load).backgroundColor, role: m.getAttribute('role'), card: !!m.querySelector('.ui-modal-card') }; });
    await frame.evaluate(() => document.getElementById('alert-modal-ok').click()); await sleep(200);
    const closed = await frame.evaluate(() => document.getElementById('alert-modal').classList.contains('hidden'));
    check(`${tag}: the alert dialog ("${dlg.title}") is the shared modal with OK on the primary button role, the same colour as Load Logs; OK closes it`, dlg.open && dlg.title === 'No Files Selected' && dlg.cls === 'btn btn-primary' && dlg.bg === dlg.loadBg && dlg.role === 'dialog' && dlg.card && closed, JSON.stringify(dlg));
  }
  // the sources to read: the must-gather picks the crash pod's previous log and the masters' kubelet journal
  if (MG) {
    await frame.evaluate(() => { document.querySelectorAll('.log-file-checkbox').forEach((c) => { const n = c.getAttribute('data-name'); c.checked = /payments-worker-7b8c9d0e1-efghi\/worker \((previous|current)\)$/.test(n) || n === 'masters/kubelet_service.log'; c.dispatchEvent(new Event('change', { bubbles: true })); }); });
    await sleep(200);
    check(`${tag}: three sources picked`, (await frame.evaluate(() => document.getElementById('log-file-selection-display').textContent.trim())) === '3 files selected' || (await frame.evaluate(() => document.querySelectorAll('.log-file-checkbox:checked').length)) === 3);
  }
  // Load Logs
  const before = { ...calls };
  await frame.evaluate(() => document.getElementById('load-logs-btn').click());
  let s = await waitLoaded(frame);
  const totalSos = ROWS.length;
  // the must-gather's rows: the previous log (10) + the current one (0) + the masters' kubelet journal (900)
  const total = MG ? Number((s.loaded.match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, '')) : totalSos;
  check(`${tag}: Load Logs reads the sources through the adapter (${MG ? 'the paged search, ' + (calls.search - before.search) + ' pages' : 'the stream'}) and the status says "Loaded N entries" (${s.loaded}); the table shows the first page of 100; the charts appear; Export enabled`, /^Loaded [\d,]+ entries$/.test(s.loaded) && (MG ? total > 500 && calls.search - before.search >= 1 : total === totalSos && calls.stream - before.stream === 1) && s.rows === 100 && s.top === `Showing 1-100 of ${total.toLocaleString()}` && s.chartsShown === 2 && !s.exportDisabled, JSON.stringify(s).slice(0, 500));
  if (MG) {
    const row = await frame.evaluate(() => { const rows = Array.from(document.querySelectorAll('#log-table-body tr')); const prev = rows.find((r) => /payments-worker/.test(r.cells[2].textContent)); return prev ? { host: prev.cells[2].textContent.trim(), proc: prev.cells[3].textContent.trim(), badges: Array.from(prev.cells[1].querySelectorAll('.ui-badge')).map((b) => b.textContent.trim()) } : null; });
    check(`${tag}: a must-gather row shows the pod as the host, the container as the process and the previous badge after the level`, row && row.host === 'payments-demo/payments-worker-7b8c9d0e1-efghi' && row.proc === 'worker' && row.badges.includes('previous'), JSON.stringify(row));
  }
  // the filters: the search, Filter out, the level and the process selects, with the counts
  const setField = async (id, value) => { await frame.evaluate(({ id, value }) => { const f = document.getElementById(id); f.value = value; f.dispatchEvent(new Event('input', { bubbles: true })); }, { id, value }); await sleep(400); };
  const setSelect = async (id, value) => { await frame.evaluate(({ id, value }) => { const f = document.getElementById(id); f.value = value; f.dispatchEvent(new Event('change', { bubbles: true })); }, { id, value }); await sleep(300); };
  const countOf = (st) => Number((st.top.match(/of ([\d,]+)/) || [0, '0'])[1].replace(/,/g, ''));
  if (!MG) {
    await setField('log-search', 'edge case, critical'); s = await state(frame);
    check(`${tag}: the search with two terms (any of them) keeps ${expectRows({ search: ['edge case', 'critical'] }).length} rows and says "in the loaded"`, countOf(s) === expectRows({ search: ['edge case', 'critical'] }).length && /in the loaded 420/.test(s.top), s.top);
    await setField('log-exclude', 'warning'); s = await state(frame);
    check(`${tag}: Filter out drops the rows matching its term (${expectRows({ search: ['edge case', 'critical'], exclude: ['warning'] }).length} left)`, countOf(s) === expectRows({ search: ['edge case', 'critical'], exclude: ['warning'] }).length, s.top);
    await setField('log-search', ''); await setField('log-exclude', '');
    await setSelect('severity-filter', 'error'); s = await state(frame);
    check(`${tag}: the level select keeps that level (${expectRows({ severity: 'error' }).length} error rows); the process list follows the level`, countOf(s) === expectRows({ severity: 'error' }).length && s.levels.every((l) => l === 'error') && s.processes.length === 1, JSON.stringify({ top: s.top, processes: s.processes }));
    await setSelect('severity-filter', '');
    await setSelect('process-filter', 'kernel'); s = await state(frame);
    check(`${tag}: the process select keeps that process (${expectRows({ process: 'kernel' }).length} rows)`, countOf(s) === expectRows({ process: 'kernel' }).length, s.top);
    await setSelect('process-filter', '');
  } else {
    await setField('log-search', 'DATABASE_URL'); s = await state(frame);
    check(`${tag}: the search keeps the rows naming DATABASE_URL (the crash pod's traceback) and says "in the loaded"`, countOf(s) >= 2 && countOf(s) < total && /in the loaded/.test(s.top) && s.first && /payments-worker/.test(s.first[2]), s.top);
    await setField('log-exclude', 'ConfigError'); const s2 = await state(frame);
    check(`${tag}: Filter out drops the rows matching its term`, countOf(s2) < countOf(s) && countOf(s2) >= 1, s2.top);
    await setField('log-search', ''); await setField('log-exclude', '');
    const srcs = await frame.evaluate(() => Array.from(document.querySelectorAll('#process-filter option')).map((o) => [o.value, o.textContent.trim()].join('=')));
    check(`${tag}: the source select groups by what wrote the rows: "All Sources", the container ns/pod/container, the host service by its name`, srcs[0] === '=All Sources' && srcs.includes('payments-demo/payments-worker-7b8c9d0e1-efghi/worker=payments-demo/payments-worker-7b8c9d0e1-efghi/worker') && srcs.includes('host:kubelet=kubelet'), JSON.stringify(srcs));
    await setSelect('process-filter', 'payments-demo/payments-worker-7b8c9d0e1-efghi/worker'); s = await state(frame);
    check(`${tag}: the source select keeps that container's rows (the 10 lines of the previous log)`, countOf(s) === 10 && s.levels.length === 10, s.top);
    await setSelect('process-filter', '');
    await setSelect('severity-filter', 'info'); s = await state(frame);
    check(`${tag}: the level select keeps that level`, countOf(s) > 0 && countOf(s) < total && s.levels.every((l) => l === 'info'), s.top);
    await setSelect('severity-filter', '');
  }
  // the source chart: its title per adapter, a click on a bar picks that source (the exact key) in the select
  const srcChart = await frame.evaluate(async () => {
    const canvas = document.getElementById('processChart'); const chart = window.Chart && window.Chart.getChart(canvas); if (!chart) return { error: 'no chart' };
    const title = canvas.closest('[data-chart-card]').querySelector('h3').textContent.trim();
    const meta = chart.getDatasetMeta(0); const i = chart.data.keys.length > 1 ? 1 : 0; const bar = meta.data[i]; if (!bar) return { error: 'no bar', title };
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + bar.x, y = rect.top + (bar.y + bar.base) / 2;
    const target = document.elementFromPoint(x, y) || canvas;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    await new Promise((r) => setTimeout(r, 300));
    return { title, key: chart.data.keys[i], label: chart.data.labels[i], value: document.getElementById('process-filter').value, rows: document.querySelectorAll('#log-table-body tr').length, keys: chart.data.keys };
  });
  check(`${tag}: the source chart is "${srcChart.title}" and a click on its "${srcChart.label}" bar picks that source (${srcChart.key}) in the select`, srcChart.title === (MG ? 'Logs per Source' : 'Logs per Process') && srcChart.value === srcChart.key && (MG ? srcChart.keys.includes('host:kubelet') : srcChart.keys.includes('kernel')), JSON.stringify(srcChart));
  await page.screenshot({ path: path.join(OUT, `logview-sources-${type}-${theme}.png`), fullPage: false });
  await setSelect('process-filter', '');
  // a click on a severity bar sets the level filter (the shared chart click resolver)
  const picked = await frame.evaluate(async () => {
    const canvas = document.getElementById('severityChart'); const chart = window.Chart && window.Chart.getChart(canvas); if (!chart) return { error: 'no chart' };
    const meta = chart.getDatasetMeta(0); const i = chart.data.keys ? chart.data.keys.indexOf('warning') : 2; const bar = meta.data[i]; if (!bar) return { error: 'no bar' };
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + bar.x, y = rect.top + (bar.y + bar.base) / 2;
    const target = document.elementFromPoint(x, y) || canvas;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    await new Promise((r) => setTimeout(r, 300));
    return { value: document.getElementById('severity-filter').value, key: chart.data.keys && chart.data.keys[i] };
  });
  check(`${tag}: a click on the Warning bar of the severity chart sets the level filter to warning`, picked.value === 'warning', JSON.stringify(picked));
  await setSelect('severity-filter', '');
  // the pager and the sort
  await setSelect('page-size', '50'); s = await state(frame);
  check(`${tag}: rows per page 50: 50 rows, the shared pager with the page numbers`, s.rows === 50 && s.pager.includes('2') && s.top.startsWith('Showing 1-50 of'), JSON.stringify({ rows: s.rows, pager: s.pager, top: s.top }));
  await frame.evaluate(() => { const b = Array.from(document.querySelectorAll('#pagination-controls button')).find((x) => x.textContent.trim() === '2'); b && b.click(); }); await sleep(300); s = await state(frame);
  check(`${tag}: page 2 shows rows 51-100`, s.top.startsWith('Showing 51-100 of'), s.top);
  await frame.evaluate(() => { window.sortTable(1); }); await sleep(300); s = await state(frame);
  check(`${tag}: the Level header sorts the rows (ascending)`, s.levels.length === 50 && [...s.levels].sort().join() === s.levels.join(), s.levels.slice(0, 8).join(','));
  await frame.evaluate(() => { window.sortTable(0); }); await setSelect('page-size', '100');
  // Export CSV: the filtered rows, the adapter's file name
  await setSelect('process-filter', MG ? 'payments-demo/payments-worker-7b8c9d0e1-efghi/worker' : 'kernel');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), frame.evaluate(() => document.getElementById('export-csv-btn').click())]);
  const csvPath = download ? await download.path() : null;
  const csv = csvPath ? fs.readFileSync(csvPath, 'utf8') : '';
  const want = MG ? 10 : expectRows({ process: 'kernel' }).length;
  check(`${tag}: Export CSV downloads the ${want} filtered rows with the header, named ${MG ? 'mustgather-logs' : 'logs'}_<from>_to_<to>_<n>entries.csv`, !!download && new RegExp(`^${MG ? 'mustgather-logs' : 'logs'}_\\d{4}-\\d{2}-\\d{2}_to_\\d{4}-\\d{2}-\\d{2}_${want}entries\\.csv$`).test(download.suggestedFilename()) && csv.split('\n')[0] === '"Timestamp","Level","Hostname","Process","PID","Message"' && csv.trim().split('\n').length === want + 1, download ? download.suggestedFilename() + ' ' + csv.split('\n').length : 'no download');
  await frame.evaluate(() => { const m = document.getElementById('alert-modal'); m && m.classList.add('hidden'); });
  await setSelect('process-filter', '');
  // the filters go with the load: a term in the search at Load Logs is applied server-side (plain substrings, the
  // comma / quoted OR), the rows that arrive are the matches across every selected file, and the status says so
  {
    const term = MG ? 'DATABASE_URL, "ConfigError"' : 'edge case, critical';
    await setField('log-search', term);
    const searchesBefore = calls.search;
    await frame.evaluate(() => document.getElementById('load-logs-btn').click()); s = await waitLoaded(frame);
    const scope = await frame.evaluate(() => ({ top: document.getElementById('entry-count-top').textContent, rows: document.querySelectorAll('#log-table-body tr').length, loaded: (document.getElementById('loaded-count') || {}).textContent }));
    const n = Number((scope.top.match(/— ([\d,]+) match/) || [0, '0'])[1].replace(/,/g, ''));
    const want = MG ? null : expectRows({ search: ['edge case', 'critical'] }).length;
    const sent = MG ? null : calls.lastStream;
    check(`${tag}: Load Logs with "${term}" in the search loads the matches only (${scope.loaded.trim()}) and the status says "${scope.top}"`,
      /^Loaded [\d,]+ entries$/.test(scope.loaded.trim()) && new RegExp(`^Showing 1-\\d+ of ${n.toLocaleString()} — ${n.toLocaleString()} match(es)? across all ${MG ? 3 : 1} files?$`).test(scope.top) && n > 0 && (MG ? calls.search > searchesBefore && n < 910 : n === want && sent && JSON.stringify(sent.query) === JSON.stringify(['edge case', 'critical'])), JSON.stringify({ scope, n, want, sent: sent && sent.query }));
    await page.screenshot({ path: path.join(OUT, `logview-serverfilter-${type}-${theme}.png`), fullPage: false });
    await setField('log-exclude', MG ? 'ConfigError' : 'critical'); s = await state(frame);
    check(`${tag}: a filter typed since narrows the loaded matches client-side and the status says so (${s.top})`, /after the filters typed since\)$/.test(s.top) && countOf(s) < n, s.top);
    await setField('log-search', ''); await setField('log-exclude', '');
    await frame.evaluate(() => document.getElementById('load-logs-btn').click()); s = await waitLoaded(frame);
    check(`${tag}: a plain load again: every row back (${s.loaded}), the status without a scope (${s.top})`, /^Loaded [\d,]+ entries$/.test(s.loaded) && /^Showing 1-\d+ of [\d,]+$/.test(s.top), s.top);
  }
  // the loading feedback, the same for both adapters: while the pages / chunks come, the status line and the busy
  // pill read "Loading logs… N entries (k of n files)" (Cancel on the pill), and the table already holds rows
  await frame.evaluate(() => { window.__prog = []; const li = document.getElementById('loading-indicator'); const mo = new MutationObserver(() => { const cancel = document.getElementById('ui-busy-cancel'); const pill = document.getElementById('ui-busy-pill'); window.__prog.push({ t: li.textContent.trim(), rows: document.querySelectorAll('#log-table-body tr').length, pill: ((document.getElementById('ui-busy-pill-text') || {}).textContent || '').trim(), pillShown: !!(pill && !pill.hidden), cancel: !!(cancel && !cancel.hidden) }); }); mo.observe(li, { childList: true, characterData: true, subtree: true }); });
  delay = 1200;
  await frame.evaluate(() => document.getElementById('load-logs-btn').click()); s = await waitLoaded(frame);
  delay = 0;
  const prog = await frame.evaluate(() => window.__prog);
  const line = prog.find((p) => /^Loading logs… [\d,]+ entries \(\d+ of \d+ files\)$/.test(p.t));
  check(`${tag}: a slow load reports its progress the same way: "${line ? line.t : '-'}" in the status line and on the busy pill with Cancel, the rows already in the table`, !!line && line.rows > 0 && line.pillShown && line.pill.startsWith(line.t) && line.cancel, JSON.stringify(prog).slice(0, 700));
  // the busy state and Abort: a slow answer shows Abort Loading and the busy pill; Abort stops it
  delay = 2500;
  await frame.evaluate(() => document.getElementById('load-logs-btn').click()); await sleep(700);
  const busy = await state(frame);
  const cancelsBefore = calls.cancel;
  await frame.evaluate(() => document.getElementById('load-logs-btn').click()); await sleep(400);
  const after = await state(frame);
  delay = 0;
  await sleep(2800);
  check(`${tag}: a slow load shows "Abort Loading" and the busy pill; Abort returns the button and the rows stay${MG ? '; the cancel route is called' : ''}`, busy.loadLabel === 'Abort Loading' && busy.pill && after.loadLabel === 'Load Logs' && (!MG || calls.cancel > cancelsBefore), JSON.stringify({ busy: busy.loadLabel, pill: busy.pill, after: after.loadLabel, cancels: calls.cancel - cancelsBefore }));
  // the rows again after the abort (what the abort left is the adapter's business), then a cross-link query fills the search
  await frame.evaluate(() => document.getElementById('load-logs-btn').click()); await waitLoaded(frame);
  await frame.evaluate(() => window.diagLinks.applyQuery(window.MG_QUERY));
  await sleep(500); s = await state(frame);
  check(`${tag}: a cross-link query fills the search field and filters the rows`, (await frame.evaluate(() => document.getElementById('log-search').value)) === (MG ? 'ConfigError' : 'edge case') && /in the loaded/.test(s.top), s.top);
  await setField('log-search', '');
  if (MG) {
    // Get Date Range over the container logs real gathers carry: a raw RFC3339 log (no CRI prefix) and one without timestamps
    const pick = async (src) => { await frame.evaluate((src) => { const re = new RegExp(src); document.querySelectorAll('.log-file-checkbox').forEach((c) => { c.checked = re.test(c.getAttribute('data-name')); c.dispatchEvent(new Event('change', { bubbles: true })); }); }, src); await sleep(200); };
    const rangeState = () => frame.evaluate(() => ({ labels: [document.getElementById('date-start-label').textContent, document.getElementById('date-end-label').textContent], note: (document.getElementById('date-range-note') || {}).textContent || '', noteHidden: !!(document.getElementById('date-range-note') || {}).hidden, sliderHidden: !!document.querySelector('.lv-slider').hidden, modal: !document.getElementById('alert-modal').classList.contains('hidden'), modalTitle: document.getElementById('alert-modal-title').textContent, picked: document.querySelectorAll('.log-file-checkbox:checked').length }));
    const getRange = async () => { const r0 = calls.range; await frame.evaluate(() => document.getElementById('get-range-btn').click()); for (let i = 0; i < 60 && calls.range === r0; i++) await sleep(100); await sleep(700); return calls.range > r0; };
    await pick('demo-cache-6c8d7f9b4-pqrst\\/cache \\(previous\\)$|demo-web-7d9f8b6c5-klmno\\/envoy \\(current\\)$');
    let called = await getRange();
    let rs = await rangeState();
    check(`${tag}: Get Date Range over a raw RFC3339 container log and one without timestamps (${rs.picked} picked) calls the must-gather's own route: the bounds from the dated log (${rs.labels.join(' to ')}), the note names the undated one, the slider stays, no error dialog`, called && rs.picked === 2 && rs.labels[0] === '2026-10-12' && rs.labels[1] === '2026-10-12' && /^1 of 2 selected logs carry no timestamps \(demo-app\/demo-web-7d9f8b6c5-klmno\/envoy \(current\)\); they load in file order, the date range applies to the rest\.$/.test(rs.note) && !rs.noteHidden && !rs.sliderHidden && !rs.modal, JSON.stringify(rs));
    await page.screenshot({ path: path.join(OUT, `logview-mustgather-range-1360-${theme}.png`), fullPage: false });
    await frame.evaluate(() => document.getElementById('load-logs-btn').click()); s = await waitLoaded(frame);
    const mixed = await frame.evaluate(() => { const rows = Array.from(document.querySelectorAll('#log-table-body tr')); const envoy = rows.filter((r) => /envoy/.test(r.cells[3].textContent)); return { undated: envoy.filter((r) => r.cells[0].textContent.trim() === '').length, envoyOrder: envoy.slice(0, 2).map((r) => r.cells[4].textContent.trim()), dated: rows.filter((r) => /^Oct 12 08:/.test(r.cells[0].textContent.trim()) && /cache/.test(r.cells[3].textContent)).length, loaded: document.getElementById('loaded-count').textContent.trim() }; });
    check(`${tag}: Load Logs over that selection (${mixed.loaded}): the undated log's lines are rows without a time, in file order, beside the dated rows of the raw RFC3339 log`, /^Loaded 42 entries/.test(mixed.loaded) && mixed.undated === 12 && mixed.envoyOrder.join('|') === 'envoy starting|listening on :8080' && mixed.dated === 30, JSON.stringify(mixed));
    await pick('demo-web-7d9f8b6c5-klmno\\/envoy \\(current\\)$');
    called = await getRange();
    rs = await rangeState();
    check(`${tag}: Get Date Range over an undated log alone: no error dialog, the note says it loads in file order, the slider and the calendar hidden`, called && !rs.modal && rs.note === 'This log carries no timestamps; it loads in file order.' && rs.sliderHidden && (await frame.evaluate(() => document.getElementById('single-date-button').hidden)), JSON.stringify(rs));
    await frame.evaluate(() => document.getElementById('load-logs-btn').click()); s = await waitLoaded(frame);
    check(`${tag}: Load Logs reads the undated log whole without a date range (${s.loaded}), the rows in file order`, /^Loaded 12 entries/.test(s.loaded) && s.rows === 12 && s.first && s.first[0] === '' && s.first[4] === 'envoy starting', JSON.stringify(s).slice(0, 300));
    // the three dated sources again for the rest of the run: the slider is back, the note gone
    await pick('payments-worker-7b8c9d0e1-efghi\\/worker \\((previous|current)\\)$|^masters\\/kubelet_service\\.log$');
    called = await getRange();
    rs = await rangeState();
    check(`${tag}: a dated selection again: the slider back with the logs' bounds (${rs.labels.join(' to ')}), the note gone`, called && !rs.sliderHidden && rs.noteHidden && /^2026-10-1\d$/.test(rs.labels[0]), JSON.stringify(rs));
    await frame.evaluate(() => document.getElementById('load-logs-btn').click()); s = await waitLoaded(frame);
  }
  // the popovers: the file picker and the calendar open below their button inside the pane's viewport (what the user
  // sees: the frame never scrolls, the pane does), the search field visible and focused, at every width, with the
  // button near the top of the view, in the middle of it, and near the bottom of a short view (the one place the
  // panel flips above, and still fits)
  const popover = (id, btnId, focusId) => frame.evaluate(({ id, btnId, focusId }) => {
    const panel = document.getElementById(id); const btn = document.getElementById(btnId);
    const vp = window.diagnosticsViewport; const r = panel.getBoundingClientRect(); const b = btn.getBoundingClientRect();
    const w = document.documentElement.clientWidth;
    const focus = focusId ? document.getElementById(focusId) : null; const fr = focus ? focus.getBoundingClientRect() : null;
    const at = fr ? document.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2) : null;
    const body = panel.querySelector('.ui-popover-body');
    return { open: !panel.classList.contains('hidden'), placement: panel.getAttribute('data-placement'), top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right), height: Math.round(r.height), w, vp, btnTop: Math.round(b.top), btnBottom: Math.round(b.bottom),
      inView: !!vp && r.height > 80 && r.top >= vp.top - 1 && r.bottom <= vp.top + vp.height + 1 && r.left >= -1 && r.right <= w + 1,
      focusVisible: !fr || (!!at && (at === focus || focus.contains(at))), focused: !focus || document.activeElement === focus, focusAt: fr ? [fr.left + fr.width / 2, fr.top + fr.height / 2] : null,
      bodyScrolls: !!body && body.scrollHeight > body.clientHeight + 1 };
  }, { id, btnId, focusId });
  // the point of the frame the search field sits at is the frame itself in the app (not clipped away by the pane)
  const onScreen = (pt) => pt ? page.evaluate(({ x, y }) => { const f = document.querySelector('iframe[title="Diagnostics content"]'); const r = f.getBoundingClientRect(); return document.elementFromPoint(r.left + x, r.top + y) === f; }, { x: pt[0], y: pt[1] }) : true;
  const scrollPane = async (y) => { await frame.evaluate((y) => window.diagnosticsScrollTo(y), y); await sleep(450); };
  const btnY = () => frame.evaluate(() => { const b = document.getElementById('log-file-dropdown-btn').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, vh: (window.diagnosticsViewport || {}).height || 0 }; });
  for (const fw of [1920, 1010, 420]) {
    await frameWidth(page, fw);
    for (const mode of ['button near the top', 'button mid-view', 'button near the bottom of a short view']) {
      if (mode === 'button near the bottom of a short view') { await page.setViewportSize({ width: Math.max(fw, 1360), height: 520 }); await sleep(400); }
      const b = await btnY();
      await scrollPane(mode === 'button near the top' ? b.top - 40 : mode === 'button mid-view' ? b.top - b.vh / 2 : b.bottom - b.vh + 48);
      await frame.evaluate(() => document.getElementById('log-file-dropdown-btn').click()); await sleep(250);
      const pk = await popover('log-file-dropdown-panel', 'log-file-dropdown-btn', 'log-file-search');
      const seen = await onScreen(pk.focusAt);
      const want = mode === 'button near the bottom of a short view' ? 'above' : 'below';
      check(`${tag}: the file picker at ${fw}, ${mode}: open ${want} the button, whole inside the pane's viewport and the frame, the search field visible and focused${pk.bodyScrolls ? ', the list scrolling inside' : ''}`, pk.open && pk.placement === want && pk.inView && pk.focusVisible && pk.focused && seen, JSON.stringify(pk));
      await frame.evaluate(() => document.getElementById('log-file-dropdown-btn').click()); await sleep(100);
      check(`${tag}: the picker closes on the button again (${fw}, ${mode})`, !(await popover('log-file-dropdown-panel', 'log-file-dropdown-btn', null)).open);
      if (mode === 'button near the bottom of a short view') { await page.setViewportSize({ width: Math.max(fw, 1360), height: 1000 }); await sleep(400); }
    }
  }
  await resetWidth(page);
  // the calendar: its own button near the top of the view
  await scrollPane(await frame.evaluate(() => document.getElementById('single-date-button').getBoundingClientRect().top - 40));
  await frame.evaluate(() => document.getElementById('single-date-button').click()); await sleep(250);
  const cal = await popover('date-calendar', 'single-date-button', null);
  await frame.evaluate(() => document.getElementById('single-date-button').click()); await sleep(100);
  check(`${tag}: the calendar opens below its button inside the pane's viewport and closes on the button again`, cal.open && cal.placement === 'below' && cal.inView && !(await popover('date-calendar', 'single-date-button', null)).open, JSON.stringify(cal));
  // the picture: the viewer's header in view, the picker open below its button
  { const b = await btnY(); await scrollPane(b.top - 200); }
  await frame.evaluate(() => document.getElementById('log-file-dropdown-btn').click()); await sleep(300);
  await page.screenshot({ path: path.join(OUT, `logview-picker-${type}-1360-${theme}.png`), fullPage: false });
  await frame.evaluate(() => document.getElementById('log-file-dropdown-btn').click()); await sleep(100);
  // no horizontal overflow at every width
  for (const fw of [1920, 1010, 420]) { await frameWidth(page, fw); const o = await overflow(frame); check(`${tag}: no horizontal overflow at ${fw}`, !o.pageOver && o.bad.length === 0, JSON.stringify(o)); }
  await resetWidth(page);
  await page.screenshot({ path: path.join(OUT, `logview-${type}-1360-${theme}.png`), fullPage: false });
  const inFrame = (await frame.evaluate(() => window.__errs || [])).concat(await page.evaluate(() => (window.__errs || []).map((x) => 'app: ' + x)));
  if (errors.length || inFrame.length) { check(`${tag}: no page error`, false, errors.concat(inFrame).join(' | ')); errors.length = 0; } else check(`${tag}: no page error`, true);
}
const MG_QUERY_BY = { sosreport: 'edge case', mustgather: 'ConfigError' };
const sidebars = {};

try {
  for (const theme of ['dark', 'light']) {
    const { context, page, errors } = await open(theme);
    await clickButton(page, 'Tools'); await sleep(400); await clickButton(page, 'Diagnostics'); await sleep(600);
    for (const type of ['sosreport', 'mustgather']) {
      const rep = reports[type];
      const opened = await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name) && el.offsetParent); if (!b) return false; b.click(); return true; }, rep.name, { timeout: 20000 }).then(() => true).catch(() => false);
      check(`${theme}: the ${type} report opens`, opened);
      await page.waitForFunction(() => document.querySelectorAll('div.cursor-pointer span').length > 3, null, { timeout: 20000 }).catch(() => {});
      await sleep(400);
      // both report types: the Log Viewer under the Log Collection group (the last entry of a must-gather's sidebar; a sosreport's has Sos Report after it)
      await expandGroup(page, 'Log Collection'); await sleep(300);
      const side = await page.evaluate(() => { const rows = Array.from(document.querySelectorAll('div.cursor-pointer')).filter((d) => d.offsetParent && d.querySelector('span')); const labels = rows.map((r) => r.querySelector('span').textContent.trim()); const i = labels.lastIndexOf('Log Collection'); const viewer = rows.find((r) => r.querySelector('span').textContent.trim() === 'Log Viewer'); const group = rows[i]; const icon = (el) => { const svg = el && el.querySelector('svg'); return svg ? svg.innerHTML.replace(/\s+/g, ' ').trim() : ''; }; return { tail: labels.slice(i, i + 2), groupIcon: icon(group), viewerIcon: icon(viewer) }; });
      sidebars[type] = side;
      check(`${theme}: the ${type} sidebar shows Log Viewer right under the Log Collection group`, side.tail[0] === 'Log Collection' && side.tail[1] === 'Log Viewer', JSON.stringify(side).slice(0, 300));
      await clickSidebar(page, 'Log Viewer', 'Log Collection');
      const frame = await frameFor(page, 'log_viewer');
      check(`${theme}: the ${type} Log Viewer renders in the frame`, !!frame);
      if (frame) {
        await sleep(900);
        // the frame's own errors with their stacks (a cross-frame pageerror carries the message alone)
        await frame.evaluate((q) => { window.MG_QUERY = q; window.__errs = []; window.addEventListener('error', (e) => { window.__errs.push(((e.error && e.error.stack) || e.message || '').slice(0, 600)); }); }, MG_QUERY_BY[type]);
        await exercise(page, frame, type, theme, errors);
      }
      await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => /Load different report/.test(el.textContent) && el.offsetParent); if (b) b.click(); });
      await sleep(600);
    }
    check(`${theme}: both sidebars show Log Collection -> Log Viewer in the same position with the same icons`, sidebars.sosreport && sidebars.mustgather && JSON.stringify(sidebars.sosreport) === JSON.stringify(sidebars.mustgather) && sidebars.sosreport.viewerIcon.length > 0, JSON.stringify(sidebars).slice(0, 400));
    await context.close();
  }
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
