#!/usr/bin/env node
/*
 * The shared Log Viewer under load, both adapters: 10,000 entries loaded (the sosreport stream in chunks, the
 * must-gather search in pages, both answered here with synthetic rows), then the pane scrolled over the table for
 * three seconds while the app's and the frame's animation frames and long tasks are sampled. Guards the things
 * that would make scrolling crawl: the table holding more than the current page of rows (rows-per-page + the
 * header's row), a scroll handler doing layout work on every event, a long task on the main thread. Reports the
 * average and the slowest frame, the long tasks and the rendered rows for each viewer, at the default page size
 * and at the largest one (500); the assertions hold at the default.
 *
 *   node tests/diagnostics-log-view-perf.test.mjs        env: SMOKE_PORT
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

let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot render the tabs'); process.exit(0); }

// the fixtures: both synthetic reports, the Log Viewer tab of each rendered through Flask
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-logview-perf-'));
const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
if (gen.status !== 0) { console.log('SKIP: could not build the synthetic diagnostics fixtures: ' + (gen.stderr || '').slice(0, 200)); process.exit(0); }
const NAMES = { sosreport: 'sosreport-web-01-2026-10-13-abcdef', mustgather: 'must-gather.local.1234567890' };
const reports = {};
for (const type of ['sosreport', 'mustgather']) {
  const htmlDir = path.join(work, 'html-' + type);
  const ren = spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', htmlDir, '--fixture', path.join(work, NAMES[type]), '--report-type', type, '--tabs', 'log_viewer'], { encoding: 'utf8' });
  check(`the ${type} Log Viewer renders through Flask over the synthetic report`, ren.status === 0, (ren.stderr || '').slice(-400));
  if (ren.status !== 0) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  reports[type] = { name: NAMES[type], path: path.join(work, NAMES[type]), type, modified: 1760000000, html: { log_viewer: fs.readFileSync(path.join(htmlDir, 'log_viewer.html'), 'utf8') }, tabs: JSON.parse(fs.readFileSync(path.join(htmlDir, 'tabs.json'), 'utf8')) };
}

// 10,000 rows per adapter: long messages, a traceback every so often, the levels in a mix, badges on the must-gather rows
const N = 10000;
const SEV = ['info', 'warning', 'error', 'debug', 'info', 'other', 'critical', 'info'];
const PROCS = ['systemd', 'kernel', 'sshd', 'crond', 'NetworkManager', 'example-app', 'dnf'];
const stamp = (i) => `2026-10-${12 + (i % 2)}T${String(Math.floor(i / 500) % 24).padStart(2, '0')}:${String(Math.floor(i / 8) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
const label = (i) => `Oct ${12 + (i % 2)} ${stamp(i).slice(11)}`;
const message = (i) => (i % 37 === 0
  ? `Traceback (most recent call last):\n  File "/app/worker.py", line ${i % 200}, in <module>\n    main()\n  File "/app/db.py", line 17, in connect\nConfigError("DATABASE_URL is not set") row ${i}`
  : `synthetic line ${i} (${SEV[i % SEV.length]}) request_id=${(i * 7919).toString(16)} path=/api/items/${i % 400} took ${(i % 900) + 12} ms from 10.0.${i % 255}.${(i * 3) % 255}`);
const sosRow = (i) => ({ timestamp: label(i), timestamp_obj: stamp(i), severity: SEV[i % SEV.length], hostname: 'web-01', process: PROCS[i % PROCS.length], pid: String(1000 + i), message: message(i), badges: [] });
const mgRow = (i) => ({ timestamp: label(i), timestamp_obj: stamp(i), severity: SEV[i % SEV.length], hostname: i % 3 ? 'payments-demo/payments-worker-7b8c9d0e1-efghi' : 'masters', process: i % 3 ? 'worker' : 'kubelet', pid: '', message: message(i), badges: i % 3 ? [{ kind: 'muted', text: 'previous' }, { kind: 'muted', text: 'stderr' }] : [] });
const sosRows = Array.from({ length: N }, (_, i) => sosRow(i));
const mgRows = Array.from({ length: N }, (_, i) => mgRow(i));
const PAGE = 2000;

// the app in Vite, the backend faked at localhost:8080
const PORT = Number(process.env.SMOKE_PORT || 5361);
const BASE = `http://localhost:${PORT}`;
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(failed ? 1 : 0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

async function open() {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light' });
  await context.addInitScript((dir) => {
    try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify('light')); localStorage.setItem('diagnosticsReportsDirectory', dir); localStorage.removeItem('diagnostics-page-session'); } catch { /* storage off */ }
    window.__errs = []; window.addEventListener('error', (e) => { window.__errs.push(((e.error && e.error.stack) || e.message || '').slice(0, 700)); });
  }, work);
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
  // the sosreport stream: five chunks of 2,000 with the file progress, then done
  await context.route('http://localhost:8080/parse_log_viewer_stream', (r) => {
    const chunks = [];
    for (let i = 0; i < N; i += PAGE) chunks.push({ entries: sosRows.slice(i, i + PAGE), total_count: N, file: 1, files: 1, done: false });
    r.fulfill({ status: 200, contentType: 'text/event-stream', body: chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: ' + JSON.stringify({ done: true }) + '\n\n' });
  });
  // the must-gather search: pages of 2,000 by cursor
  await context.route('http://localhost:8080/mustgather_log_search', (r) => {
    let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ }
    const at = body.cursor ? Number(body.cursor.offset) || 0 : 0;
    const entries = mgRows.slice(at, at + PAGE);
    const done = at + PAGE >= N;
    r.fulfill({ json: { ok: true, entries, cursor: done ? null : { file: 0, offset: at + PAGE }, done, files: (body.paths || []).length, scanned: at + entries.length } });
  });
  await context.route('http://localhost:8080/mustgather_log_cancel', (r) => r.fulfill({ json: { ok: true } }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.stack || e.message).slice(0, 400)));
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  return { context, page, errors };
}
const clickButton = (page, label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label && el.offsetParent); if (!b) return false; b.click(); return true; }, label);
const clickSidebar = (page, label, after) => page.evaluate(({ label, after }) => { const all = Array.from(document.querySelectorAll('div.cursor-pointer span')); const from = after ? all.findIndex((el) => el.textContent.trim() === after) : -1; const span = all.slice(from + 1).find((el) => el.textContent.trim() === label); const row = span && span.closest('div.cursor-pointer'); if (!row) return false; row.click(); return true; }, { label, after });
// the group's chevron opens it (a click on the row itself selects the group and loads its first tab instead)
const expandGroup = (page, label) => page.evaluate((label) => { const span = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label); const row = span && span.closest('div.cursor-pointer'); if (!row) return 'no row'; const btn = row.parentElement.querySelector('button[title="Expand"]') || row.querySelector('button[title="Expand"]'); if (btn) { btn.click(); return 'expanded'; } if (row.parentElement.querySelector('button[title="Collapse"]')) return 'already'; row.click(); return 'clicked'; }, label);
async function frameFor(page, key) {
  for (let i = 0; i < 80; i++) {
    const h = await page.$(`iframe[title="Diagnostics content"][data-tab="${key}"]`);
    if (h) { const f = await h.contentFrame(); if (f) { try { if (await f.evaluate(() => document.readyState === 'complete' && !!document.querySelector('#diagnostics-content'))) return f; } catch { /* navigating */ } } }
    await sleep(250);
  }
  return null;
}
const loadedText = (frame) => frame.evaluate(() => (document.getElementById('loaded-count') || {}).textContent || '');
async function waitLoaded(frame) { for (let i = 0; i < 240; i++) { const t = await loadedText(frame); if (/^Loaded [\d,]+ entries$/.test(t.trim())) return t.trim(); await sleep(250); } return await loadedText(frame); }

// the samplers: animation-frame gaps and long tasks, in the app's document and in the frame's
const SAMPLER = `(() => { window.__perf = { frames: [], long: [], on: true }; let last = performance.now(); const tick = (t) => { window.__perf.frames.push(t - last); last = t; if (window.__perf.on) requestAnimationFrame(tick); }; requestAnimationFrame(tick); try { window.__perfObs = new PerformanceObserver((l) => { l.getEntries().forEach((e) => window.__perf.long.push(Math.round(e.duration))); }); window.__perfObs.observe({ entryTypes: ['longtask'] }); } catch { /* no longtask entries */ } })()`;
const COLLECT = `(() => { window.__perf.on = false; try { window.__perfObs.disconnect(); } catch { /* none */ } const f = window.__perf.frames.slice(2); f.sort((a, b) => a - b); const avg = f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0; return { frames: f.length, avg: Math.round(avg * 10) / 10, p95: Math.round((f[Math.floor(f.length * 0.95)] || 0) * 10) / 10, max: Math.round((f[f.length - 1] || 0) * 10) / 10, long: window.__perf.long.slice() }; })()`;
async function scrollRun(page, frame, seconds) {
  // the mouse over the table, the wheel down then up, a step every 50 ms; the pane scrolls, the app posts the viewport
  await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); let s = f.parentElement; while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement; s.scrollTop = 0; });
  await sleep(300);
  await page.mouse.move(860, 600);
  await page.evaluate(SAMPLER); await frame.evaluate(SAMPLER);
  const steps = Math.round(seconds * 1000 / 50);
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, i < steps / 2 ? 240 : -240); await sleep(50); }
  await sleep(200);
  const app = await page.evaluate(COLLECT); const inner = await frame.evaluate(COLLECT);
  return { app, frame: inner };
}

try {
  for (const type of ['sosreport', 'mustgather']) {
    // a fresh app per report: the picker and the sidebar start clean
    const { context, page, errors } = await open();
    await clickButton(page, 'Tools'); await sleep(400); await clickButton(page, 'Diagnostics'); await sleep(600);
    const MG = type === 'mustgather';
    const rep = reports[type];
    const opened = await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name) && el.offsetParent); if (!b) return false; b.click(); return true; }, rep.name, { timeout: 20000 }).then(() => true).catch(() => false);
    check(`the ${type} report opens`, opened);
    await page.waitForFunction(() => document.querySelectorAll('div.cursor-pointer span').length > 3, null, { timeout: 20000 }).catch(() => {});
    await sleep(400);
    // the group may already be open (its first sub-tab auto-opened): a click then closes it, so the sub-tab is looked for before and after
    let cs = await clickSidebar(page, 'Log Viewer', 'Log Collection');
    const eg = cs ? true : await expandGroup(page, 'Log Collection'); await sleep(300);
    if (!cs) cs = await clickSidebar(page, 'Log Viewer', 'Log Collection');
    const frame = await frameFor(page, 'log_viewer');
    check(`the ${type} Log Viewer renders in the frame`, !!frame, JSON.stringify({ eg, cs, frames: await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map((f) => f.dataset.tab + ':' + f.title)), labels: await page.evaluate(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).map((s) => s.textContent.trim()).slice(0, 40)), errs: (await page.evaluate(() => window.__errs || [])).slice(0, 3), pageErrors: errors.slice(0, 3) }));
    if (!frame) { await context.close(); continue; }
    await sleep(900);
    if (MG) {
      await frame.evaluate(() => { document.querySelectorAll('.log-file-checkbox').forEach((c) => { const n = c.getAttribute('data-name'); c.checked = /payments-worker-7b8c9d0e1-efghi\/worker \((previous|current)\)$/.test(n) || n === 'masters/kubelet_service.log'; c.dispatchEvent(new Event('change', { bubbles: true })); }); });
      await sleep(200);
    }
    const t0 = Date.now();
    await frame.evaluate(() => document.getElementById('load-logs-btn').click());
    const loaded = await waitLoaded(frame);
    const loadMs = Date.now() - t0;
    check(`${type}: 10,000 entries load (${loaded}, ${loadMs} ms)`, loaded === 'Loaded 10,000 entries', loaded);
    const rows = await frame.evaluate(() => ({ tr: document.querySelectorAll('#log-table-body tr').length, pageSize: Number(document.getElementById('page-size').value), showing: (document.getElementById('entry-count-top') || {}).textContent }));
    check(`${type}: the table holds one page of rows (${rows.tr} rows, ${rows.pageSize} per page)`, rows.tr <= rows.pageSize + 1 && rows.tr > 0, JSON.stringify(rows));
    const m = await scrollRun(page, frame, 3);
    const worstLong = Math.max(0, ...m.app.long, ...m.frame.long);
    check(`${type}: scrolling the loaded table for 3 s at ${rows.pageSize} rows per page: the app's frames average ${m.app.avg} ms (p95 ${m.app.p95}, max ${m.app.max}, ${m.app.frames} frames), the frame's ${m.frame.avg} ms (p95 ${m.frame.p95}, max ${m.frame.max}); long tasks app [${m.app.long.join(', ')}] frame [${m.frame.long.join(', ')}]`,
      m.app.avg <= 20 && m.frame.avg <= 20 && worstLong <= 100 && m.app.frames > 60, JSON.stringify(m));
    // the largest page size, for the record (500 rows in the table): the same run, the numbers in the line
    await frame.evaluate(() => { const s = document.getElementById('page-size'); s.value = '500'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(900);
    const rows500 = await frame.evaluate(() => document.querySelectorAll('#log-table-body tr').length);
    const m500 = await scrollRun(page, frame, 3);
    check(`${type}: at 500 rows per page (${rows500} rows): the app's frames average ${m500.app.avg} ms (p95 ${m500.app.p95}, max ${m500.app.max}), the frame's ${m500.frame.avg} ms (max ${m500.frame.max}); long tasks app [${m500.app.long.join(', ')}] frame [${m500.frame.long.join(', ')}]`, rows500 === 500 && m500.app.avg <= 40, JSON.stringify(m500));
    await frame.evaluate(() => { const s = document.getElementById('page-size'); s.value = '100'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(500);
    const inFrame = (await frame.evaluate(() => window.__errs || [])).concat(await page.evaluate(() => (window.__errs || []).map((x) => 'app: ' + x)));
    if (errors.length || inFrame.length) { check(`${type}: no page error`, false, errors.concat(inFrame).join(' | ')); errors.length = 0; } else check(`${type}: no page error`, true);
    await context.close();
  }
} catch (e) {
  check('the browser part ran', false, String(e.stack || e).slice(0, 800));
} finally {
  await stop();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
