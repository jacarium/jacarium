#!/usr/bin/env node
/**
 * The must-gather Log Collection tab (backend/templates/tabs/
 * mustgather_log_collection.html) inside the REAL app's diagnostics frame:
 * the tab is the LAST entry of the must-gather sidebar, every section
 * lists its entries largest first (bytes), the Name header sorts by name
 * and the Size header back to largest first, the top-level section shows
 * the recursive directory totals, and nothing overflows at 420 px.
 *
 * Vite from this checkout + playwright-core's Chromium; the backend calls
 * on localhost:8080 are answered by routes from HTML rendered by
 * tests/helpers/diagnostics-render.py (--report-type mustgather) over the
 * synthetic must-gather, so the user's own app on :8080 is never touched.
 * Screenshots (dark and light) go to MG_OUT (or a temp dir).
 *
 * SKIPS (exit 0) without playwright-core / Chromium, without backend/venv
 * or python3, or with SKIP_BROWSER_TESTS set.
 * Run: node tests/mustgather-log-collection-frame.test.mjs
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
  const mg = registry.slice(registry.indexOf("'mustgather': {"));
  const keys = [...mg.matchAll(/^        '([a-z_]+)': \{/gm)].map((m) => m[1]);
  check('the must-gather registry ends with log_collection (a single tab)', keys[keys.length - 1] === 'log_collection' && !/'log_collection':\s*\{[^}]*'sub_tabs'/.test(mg), keys.join(','));
  const src = fs.readFileSync(path.join(REPO, 'backend', 'templates', 'tabs', 'mustgather_log_collection.html'), 'utf8');
  const shared = fs.readFileSync(path.join(REPO, 'backend', 'templates', 'tabs', '_log_collection.html'), 'utf8');
  const utilities = ['grid-cols-', 'col-span-', 'bg-gray-', 'text-gray-', 'md:', 'space-y-'].filter((c) => src.includes(c) || shared.includes(c));
  check('the template imports the shared lc-* design (tabs/_log_collection.html); neither carries a utility class the frame lacks, Font Awesome, marked-safe output or innerHTML; no Log Viewer button', utilities.length === 0 && src.includes('import "tabs/_log_collection.html"') && shared.includes('.lc-table') && !(src + shared).includes('class="fas') && !/\|\s*safe/.test(src + shared) && !/innerHTML/.test(src + shared) && !src.includes('log-collection-open-viewer'), utilities.join(','));
}

// ---- live ----
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(failed ? 1 : 0); }
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
const OUT = process.env.MG_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'mg-log-collection-frame-'));
fs.mkdirSync(OUT, { recursive: true });
const MG_NAME = 'must-gather.local.1234567890';
let HTML_DIR = process.env.MG_HTML_DIR;
if (!HTML_DIR) {
  if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot render the tab'); process.exit(failed ? 1 : 0); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-log-collection-fixture-'));
  const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
  if (gen.status !== 0) { console.log('SKIP: could not build the synthetic diagnostics fixture: ' + (gen.stderr || '').slice(0, 200)); process.exit(failed ? 1 : 0); }
  HTML_DIR = path.join(work, 'html');
  const ren = spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', HTML_DIR, '--fixture', path.join(work, MG_NAME), '--report-type', 'mustgather', '--tabs', 'log_collection'], { encoding: 'utf8' });
  check('the tab renders through Flask over the synthetic must-gather', ren.status === 0, (ren.stderr || '').slice(-300));
  if (ren.status !== 0) process.exit(1);
}
const REPORT = { name: MG_NAME, path: '/tmp/mg-log-collection-frame/' + MG_NAME, type: 'mustgather', modified: 1760000000 };
const tabs = JSON.parse(fs.readFileSync(path.join(HTML_DIR, 'tabs.json'), 'utf8'));
const html = { log_collection: fs.readFileSync(path.join(HTML_DIR, 'log_collection.html'), 'utf8') };

const PORT = Number(process.env.SMOKE_PORT || 5312);
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
      localStorage.setItem('diagnosticsReportsDirectory', '/tmp/mg-log-collection-frame');
      localStorage.removeItem('diagnostics-page-session');
    } catch { /* storage off */ }
  }, { theme });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.4', protocol: 2 } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
  await context.route('http://localhost:8080/list_reports', (r) => r.fulfill({ json: { reports: [REPORT] } }));
  await context.route('http://localhost:8080/get_tabs', (r) => r.fulfill({ json: { tabs, report_type: 'mustgather', directory: REPORT.path } }));
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
const sidebarLabels = (page) => page.evaluate(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).map((s) => s.textContent.trim()));


// The Log Collection page's live checks (shared by the sosreport and the
// must-gather frame tests): the one table largest first, the bars
// proportional to the bytes, the chips, the search, the Name / Size sort,
// nothing overflowing at the current width.
async function probeLogCollection(frame) {
  return frame.evaluate(() => {
    const rows = () => Array.from(document.querySelectorAll('tr.lc-row'));
    const visible = () => rows().filter((r) => !r.hidden);
    const sizes = (list) => list.map((r) => Number(r.dataset.size));
    const descending = (list) => { const s = list.filter((n) => n >= 0); return s.every((n, i) => i === 0 || s[i - 1] >= n); };
    const all = rows();
    const maxFile = Math.max(...all.filter((r) => !r.querySelector('.lc-bar-dir')).map((r) => Number(r.dataset.size)));
    const barsOk = all.filter((r) => !r.querySelector('.lc-bar-dir') && Number(r.dataset.size) > 0).every((r) => { const w = parseFloat(r.querySelector('.lc-bar i').style.width); return Math.abs(w - 100 * Number(r.dataset.size) / maxFile) < 0.06; });
    const barPx = all.slice(0, 2).map((r) => r.querySelector('.lc-bar i').getBoundingClientRect().width);
    const chips = Array.from(document.querySelectorAll('.lc-chip'));
    const sections = chips.filter((c) => c.dataset.section).map((c) => c.dataset.section);
    const initialDesc = descending(sizes(visible()));
    // a section chip filters the rows to that section
    chips.find((c) => c.dataset.section === sections[0]).click();
    const chipOk = visible().every((r) => r.dataset.section === sections[0]) && visible().length > 0;
    chips.find((c) => !c.dataset.section).click();
    // the search narrows by name
    const search = document.getElementById('lc-search');
    const first = all[0].dataset.name;
    search.value = first; search.dispatchEvent(new Event('input', { bubbles: true }));
    return new Promise((resolve) => setTimeout(() => {
      const searchOk = visible().length >= 1 && visible().every((r) => r.dataset.name.toLowerCase().includes(first.toLowerCase()));
      const shownText = document.getElementById('lc-shown').textContent;
      search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        // Name sorts by name, Size back to largest first
        document.querySelector('.lc-sort[data-key="name"]').click();
        const byName = visible().map((r) => r.dataset.name);
        const nameOk = byName.join() === byName.slice().sort((a, b) => a.localeCompare(b)).join();
        document.querySelector('.lc-sort[data-key="size"]').click();
        const sizeOk = descending(sizes(visible())) && document.querySelector('.lc-sort[data-key="size"]').classList.contains('lc-sorted');
        const w = document.documentElement.clientWidth;
        const over = [];
        document.querySelectorAll('.lc-band, .lc-controls, .lc-table-wrap, .lc-table, .lc-head').forEach((el) => { const r = el.getBoundingClientRect(); if (r.right > w + 1 || el.scrollWidth > el.clientWidth + 1) over.push(el.className.split(' ')[0] + ':' + Math.round(r.right) + '/' + el.scrollWidth + '>' + el.clientWidth); });
        const sizeCells = all.slice(0, 3).map((r) => r.querySelector('.lc-td-size')).map((td) => ({ w: td.getBoundingClientRect().width, right: Math.round(td.getBoundingClientRect().right), text: td.textContent.trim() }));
        const legend = Array.from(document.querySelectorAll('.lc-legend span')).map((s) => s.textContent);
        const stack = Array.from(document.querySelectorAll('#lc-stack span')).map((s) => parseFloat(s.style.width));
        resolve({ rows: all.length, initialDesc, barsOk, barPx, sections, chipOk, searchOk, shownText, nameOk, sizeOk, over, w, pageOver: document.documentElement.scrollWidth > w + 1, sizeCells, legend, stackSum: stack.reduce((a, b) => a + b, 0), largest: (document.getElementById('lc-largest') || {}).textContent });
      }, 250);
    }, 250));
  });
}

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
    check(`${theme}: the synthetic must-gather is listed and opens`, opened);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).some((s) => s.textContent.trim() === 'Log Collection'), null, { timeout: 20000 }).catch(() => {});
    const labels = await sidebarLabels(page);
    check(`${theme}: Log Collection is the LAST entry of the must-gather sidebar (after Security & Certificates)`, labels[labels.length - 1] === 'Log Collection' && labels.includes('Security & Certificates') && labels.filter((l) => l === 'Log Collection').length === 1, labels.join(','));
    check(`${theme}: Log Collection opens`, await clickSidebarSpan(page, 'Log Collection'));
    await sleep(200);
    const frame = await diagnosticsFrame(page, '#log-collection-overview');
    check(`${theme}: exactly one card between the page and the Log Collection search box (the frame's tab panel; the page draws no card of its own around it)`, !!frame && await frame.evaluate(() => { const b = []; for (let el = document.getElementById('lc-search').parentElement; el && el.id !== 'diagnostics-content'; el = el.parentElement) { const cs = getComputedStyle(el); if (parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderTopLeftRadius) > 0) b.push(el.id || el.className.split(' ')[0]); } return b.length === 1 && b[0] === 'log-collection-overview'; }));
    check(`${theme}: the tab rendered in the diagnostics frame`, !!frame);
    if (!frame) { await context.close(); continue; }
    await sleep(800);
    const probe = await probeLogCollection(frame);
    const extra = await frame.evaluate(() => {
      const first = Array.from(document.querySelectorAll('tr.lc-row')).find((r) => r.dataset.section === 'pod_logs');
      const segs = first ? Array.from(first.querySelectorAll('.lc-td-name > span')).map((s) => s.className + ':' + s.textContent) : [];
      const dirRow = Array.from(document.querySelectorAll('tr.lc-row')).find((r) => r.dataset.section === 'top');
      const dirBar = dirRow ? dirRow.querySelector('.lc-bar-dir') : null;
      const hiddenExtras = Array.from(document.querySelectorAll('tr.lc-row[data-extra]')).filter((r) => r.hidden).length;
      const showAll = document.getElementById('lc-show-all');
      const before = Array.from(document.querySelectorAll('tr.lc-row')).filter((r) => !r.hidden).length;
      if (showAll) showAll.click();
      const after = Array.from(document.querySelectorAll('tr.lc-row')).filter((r) => !r.hidden).length;
      if (showAll) showAll.click();
      return { segs, dirBar: !!dirBar, hiddenExtras, before, after, total: document.querySelectorAll('tr.lc-row').length, noButton: !document.getElementById('log-collection-open-viewer') };
    });
    check(`${theme}: one table largest first across the six sections, bars proportional to the bytes, the chips filter, the search narrows, Name / Size sorting, no Open Log Viewer button`,
      probe.initialDesc && probe.barsOk && probe.sections.length === 6 && probe.chipOk && probe.searchOk && probe.nameOk && probe.sizeOk && extra.noButton, JSON.stringify(probe));
    check(`${theme}: the band splits the size by top-level directory (legend ~100%, largest directory first) and names the largest file (the workers' kubelet log)`, Math.abs(probe.stackSum - 100) < 0.5 && probe.legend.length > 1 && probe.legend.filter((l) => !/^other /.test(l)).every((l, i, arr) => i === 0 || parseFloat(arr[i - 1].split('·').pop()) >= parseFloat(l.split('·').pop())) && /workers\/kubelet_service\.log/.test(probe.largest), JSON.stringify({ sum: probe.stackSum, legend: probe.legend.slice(0, 3), largest: probe.largest }));
    check(`${theme}: a container log shows namespace / pod / container as muted segments with the file as the detail; directory rows carry the grey bar; the rows beyond the top 15 per section hide until "Show all"`,
      extra.segs.length >= 5 && extra.segs[1].startsWith('lc-seg-muted:') && extra.segs.some((s) => s.startsWith('lc-detail:')) && extra.dirBar && extra.hiddenExtras > 0 && extra.before === extra.total - extra.hiddenExtras && extra.after === extra.total, JSON.stringify(extra));
    check(`${theme}: nothing overflows at ${probe.w}px`, probe.over.length === 0 && !probe.pageOver, probe.over.join(', '));
    await sleep(300);
    const file = path.join(OUT, `mustgather-log-collection-${theme}.png`); await page.screenshot({ path: file }); console.log(`  screenshot: ${file}`);
    await page.setViewportSize({ width: 1920, height: 1000 }); await sleep(700);
    const wide = await probeLogCollection(frame);
    check(`${theme}: at ${wide.w}px the table fills the width and nothing overflows`, wide.over.length === 0 && !wide.pageOver && wide.w > 1300, JSON.stringify({ w: wide.w, over: wide.over }));
    const wideFile = path.join(OUT, `mustgather-log-collection-wide-1920-${theme}.png`); await page.screenshot({ path: wideFile }); console.log(`  screenshot: ${wideFile}`);
    await page.setViewportSize({ width: 1360, height: 900 }); await sleep(400);
    await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.dataset.w = f.style.width; f.style.width = '420px'; });
    await sleep(900);
    const narrow = await probeLogCollection(frame);
    check(`${theme}: at ${narrow.w}px no horizontal scroll, the size cells whole and inside the frame, sorting still works`, !narrow.pageOver && narrow.over.length === 0 && narrow.w <= 430 && narrow.sizeCells.every((c) => c.right <= narrow.w && c.w > 60 && /KiB|MiB|B/.test(c.text)) && narrow.nameOk && narrow.sizeOk, JSON.stringify({ w: narrow.w, over: narrow.over, cells: narrow.sizeCells }));
    const iframe = await page.$('iframe[title="Diagnostics content"]');
    const h = await frame.evaluate(() => document.body.scrollHeight);
    await page.setViewportSize({ width: 1360, height: Math.min(6000, h + 140) }); await sleep(600);
    const narrowFile = path.join(OUT, `mustgather-log-collection-narrow-420-${theme}.png`); await iframe.screenshot({ path: narrowFile }); console.log(`  screenshot: ${narrowFile}`);
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w || ''; });
    check(`${theme}: no uncaught page errors`, errors.filter((e) => !/ResizeObserver/.test(e)).length === 0, errors.slice(0, 2).join(' | '));
    await context.close();
  }
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
