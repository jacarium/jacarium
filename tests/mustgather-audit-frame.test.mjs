#!/usr/bin/env node
/**
 * The must-gather Audit page (backend/templates/tabs/mustgather_audit.html,
 * one page over every audit event) inside the REAL app's diagnostics frame:
 * one sidebar entry with no sub-tabs; nothing above the content card (the
 * app's title is the heading); every filter visible at once, the selects as
 * additive tag pickers, the text boxes with several values; the search runs for real (the route goes to the Flask test client
 * over the synthetic must-gather through tests/helpers/diagnostics-api.py);
 * the default view lists the newest 200 with the visuals from the cached
 * scan; the one search box (time text too), the status and Category
 * selects (categories counted over every event, beyond the scan's sample),
 * removable filter chips, clicks on the bars and the histogram; Load older;
 * the SA tag, the raw JSON, masked bodies with Reveal; the Changes category
 * with chips, diffs, group by object, the changed-field and change-type
 * filters; the two-window must-gather (the broken axis, the fills after five
 * theme toggles, the body filters disabled without bodies); at 360, 420,
 * 768, 1360 and 1920 px nothing is clipped, every select has one chevron;
 * dark and light; screenshots.
 *
 * Vite from this checkout + playwright-core's Chromium; the backend calls
 * on localhost:8080 are answered by routes from HTML rendered by
 * tests/helpers/diagnostics-render.py (--report-type mustgather) over the
 * synthetic must-gather, so the user's own app on :8080 is never touched.
 * Screenshots go to AU_OUT (or a temp dir).
 *
 * SKIPS (exit 0) without playwright-core / Chromium, without backend/venv
 * or python3, or with SKIP_BROWSER_TESTS set.
 * Run: node tests/mustgather-audit-frame.test.mjs
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
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TABS = ['audit', 'log_collection'];   // Log Collection: the table header the Audit header must match

// ---- static ----
{
  const registry = fs.readFileSync(path.join(REPO, 'backend', 'log_viewer.py'), 'utf8');
  const mg = registry.slice(registry.indexOf("'mustgather': {"));
  const keys = [...mg.matchAll(/^        '([a-z_]+)': \{/gm)].map((m) => m[1]);
  check('the must-gather registry: one Audit entry right before Log Collection, no sub-tabs', keys.slice(-2).join() === 'audit,log_collection' && !/'audit':\s*\{[^}]*'sub_tabs'/.test(mg) && !/'audit_(events|security|users|changes)'/.test(mg), keys.join(','));
  const dir = path.join(REPO, 'backend', 'templates', 'tabs');
  for (const name of ['_audit.html', 'mustgather_audit.html']) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    const utilities = ['grid-cols-', 'col-span-', 'bg-gray-', 'text-gray-', 'md:', 'space-y-'].filter((c) => src.includes(c));
    check(`${name}: no utility class the frame lacks, no Font Awesome, no marked-safe output, no innerHTML`, utilities.length === 0 && !src.includes('class="fas') && !/\|\s*safe/.test(src) && !/innerHTML|insertAdjacentHTML|document\.write/.test(src), utilities.join(','));
  }
  const shared = fs.readFileSync(path.join(dir, '_audit.html'), 'utf8');
  // The charts are built by the shared helper (diagChart.timeSeries for the histogram, diagChart.categoryBars for the
  // bars): the legend, the tooltip and the theme bridge's re-theme live there, so the template holds no Chart.js config.
  check('event rows carry a square coloured left accent (border-radius 0 r r 0) and both charts go through the shared helper (no Chart.js config in the template)', /\.au-ev \{[^}]*border-radius: 0 var\(--radius-sm/.test(shared) && /window\.diagChart\.timeSeries\(/.test(shared) && /window\.diagChart\.categoryBars\(/.test(shared) && !/new Chart\(/.test(shared) && !/legend: \{ display: false, labels/.test(shared));
}

// ---- live ----
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(failed ? 1 : 0); }
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
const OUT = process.env.AU_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'mg-audit-frame-'));
fs.mkdirSync(OUT, { recursive: true });
const MG_NAME = 'must-gather.local.1234567890';
let HTML_DIR = process.env.AU_HTML_DIR;
if (!HTML_DIR) {
  if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot render the tabs'); process.exit(failed ? 1 : 0); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-audit-fixture-'));
  const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
  if (gen.status !== 0) { console.log('SKIP: could not build the synthetic diagnostics fixture: ' + (gen.stderr || '').slice(0, 200)); process.exit(failed ? 1 : 0); }
  HTML_DIR = path.join(work, 'html');
  const ren = spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', HTML_DIR, '--fixture', path.join(work, MG_NAME), '--report-type', 'mustgather', '--tabs', ...TABS], { encoding: 'utf8' });
  check('the Audit page renders through Flask over the synthetic must-gather', ren.status === 0, (ren.stderr || '').slice(-300));
  if (ren.status !== 0) process.exit(1);
}
const REPORT = { name: MG_NAME, path: '/tmp/mg-audit-frame/' + MG_NAME, type: 'mustgather', modified: 1760000000 };
// A second must-gather with two capture windows a day apart and the Default profile (tests/helpers/audit-gap-fixture.py):
// the overview's broken time axis, the Events histogram's break and the greyed-out body filters
const GAP_NAME = 'must-gather.local.gap';
const GAP_REPORT = { name: GAP_NAME, path: '/tmp/mg-audit-frame/' + GAP_NAME, type: 'mustgather', modified: 1760000001 };
let GAP_HTML = {};
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-audit-gap-'));
  const gen = spawnSync(PYTHON, ['-I', path.join(REPO, 'tests', 'helpers', 'audit-gap-fixture.py'), '--out', work, '--profile', 'Default'], { encoding: 'utf8' });
  const ren = gen.status === 0 ? spawnSync(PYTHON, ['-I', path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', path.join(work, 'html'), '--fixture', path.join(work, GAP_NAME), '--report-type', 'mustgather', '--tabs', 'audit'], { encoding: 'utf8' }) : gen;
  check('the two-window must-gather renders its Audit page', ren.status === 0, (ren.stderr || '').slice(-300));
  if (ren.status === 0) GAP_HTML = { audit: fs.readFileSync(path.join(work, 'html', 'audit.html'), 'utf8') };
}
// The Events search runs for real: the route goes to the Flask test client over the synthetic must-gather (tests/helpers/diagnostics-api.py);
// the busy-state checks delay the answer (searchDelay ms) or fail it (searchError), and count the Cancel button's /audit_events_cancel calls
const searches = [];
let searchDelay = 0, searchError = null;
const cancels = [];
async function answerSearch(route) {
  let body = {}; try { body = route.request().postDataJSON() || {}; } catch { /* no body */ }
  searches.push(body.query || {});
  if (searchDelay) await sleep(searchDelay);
  if (searchError) { route.fulfill({ status: 500, json: { error: searchError } }); return; }
  const tmp = path.join(OUT, `req-${process.pid}-${searches.length}.json`);
  fs.writeFileSync(tmp, JSON.stringify(body));
  const out = spawnSync(PYTHON, ['-I', path.join(REPO, 'tests', 'helpers', 'diagnostics-api.py'), '--path', '/audit_events_search', '--body-file', tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.unlinkSync(tmp);
  let parsed = { status: 500, json: { error: (out.stderr || '').slice(-300) } };
  try { parsed = JSON.parse(out.stdout); } catch { /* the error above */ }
  route.fulfill({ status: parsed.status, json: parsed.json });
}
const tabs = JSON.parse(fs.readFileSync(path.join(HTML_DIR, 'tabs.json'), 'utf8'));
const html = Object.fromEntries(TABS.map((t) => [t, fs.readFileSync(path.join(HTML_DIR, `${t}.html`), 'utf8')]));

const PORT = Number(process.env.SMOKE_PORT || 5313);
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
      localStorage.setItem('diagnosticsReportsDirectory', '/tmp/mg-audit-frame');
      localStorage.removeItem('diagnostics-page-session');
    } catch { /* storage off */ }
  }, { theme });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.5', protocol: 2 } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
  await context.route('http://localhost:8080/list_reports', (r) => r.fulfill({ json: { reports: [REPORT, GAP_REPORT] } }));
  await context.route('http://localhost:8080/get_tabs', (r) => r.fulfill({ json: { tabs, report_type: 'mustgather', directory: REPORT.path } }));
  await context.route('http://localhost:8080/get_tab_data', (r) => r.fulfill({ json: {} }));
  await context.route('http://localhost:8080/audit_events_search', answerSearch);
  await context.route('http://localhost:8080/audit_events_cancel', (r) => { cancels.push(Date.now()); r.fulfill({ json: { ok: true } }); });
  await context.route('http://localhost:8080/audit_event_body', (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } r.fulfill({ json: { body: `REVEALED-${body.part}-${body.audit_id}` } }); });
  await context.route('http://localhost:8080/static/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(REPO, 'backend', 'static', 'styles.css'), 'utf8') }));
  await context.route('http://localhost:8080/load_tab', (r) => {
    let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ }
    const key = body.sub_tab || body.tab;
    const set = body.directory === GAP_REPORT.path ? GAP_HTML : html;
    r.fulfill({ json: { html: set[key] || `<div class="panel rounded-lg shadow-sm"><p>${key} (not part of this test)</p></div>` } });
  });
  const page = await context.newPage();
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => { errors.push(String(e.message)); console.log('pageerror', String(e.message).slice(0, 160)); });
  page.on('console', (msg) => { if (msg.type() === 'error' && !/favicon|ERR_FAILED|404|CloudSync|WebSocket/.test(msg.text())) consoleErrors.push(msg.text()); });
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  return { context, page, errors, consoleErrors };
}

const clickButton = (page, label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label); if (!b) return false; b.click(); return true; }, label);
const clickSidebarSpan = (page, label) => page.evaluate((label) => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label); if (!s) return false; s.closest('div.cursor-pointer').click(); return true; }, label);
// The sidebar also has a top-level "Events" (the Kubernetes events): the Audit one is the entry right after "Audit"
const clickSidebarAfter = (page, group, label) => page.evaluate(({ group, label }) => { const all = Array.from(document.querySelectorAll('div.cursor-pointer span')); const i = all.findIndex((el) => el.textContent.trim() === group); const s = all.slice(i + 1).find((el) => el.textContent.trim() === label); if (!s) return false; s.closest('div.cursor-pointer').click(); return true; }, { group, label });
const loaded = (frame, marker) => frame.waitForFunction((m) => { const r = document.querySelector(m); return !!(r && r.dataset.loaded); }, marker, { timeout: 60000 }).then(() => true).catch(() => false);
// Wait until a page's status line settles after a search was triggered (the busy class goes, the text changes)
const settled = (frame, statusId, before) => frame.waitForFunction(({ id, before }) => { const el = document.getElementById(id); return el && !el.classList.contains('ui-busy') && el.textContent !== before && !/^(Searching|Loading)/.test(el.textContent); }, { id: statusId, before }, { timeout: 60000 }).then(() => true).catch(() => false);
const expandGroup = (page, label) => page.evaluate((label) => {
  const span = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label);
  const row = span && span.closest('div.cursor-pointer').parentElement;
  const btn = row && row.querySelector('button[title="Expand"]');
  if (btn) { btn.click(); return 'expanded'; }
  return row && row.querySelector('button[title="Collapse"]') ? 'already' : 'no chevron';
}, label);
const sidebarLabels = (page) => page.evaluate(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).map((s) => s.textContent.trim()));

// The computed design of a table header cell (the active column and a plain one) and its sort button's marker: the same function
// reads the Log Collection table and the Audit events header, the check compares the two.
const headStyles = ({ active, plain, numeric }) => {
  const pick = (s, keys) => Object.fromEntries(keys.map((k) => [k, s[k]]));
  const CELL = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'color', 'lineHeight', 'whiteSpace', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'backgroundColor', 'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor'];
  const BTN = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'color', 'cursor', 'backgroundColor', 'borderTopWidth', 'paddingLeft'];
  const cell = (sel) => { const c = document.querySelector(sel); const b = c.querySelector('.lc-sort'); const cs = getComputedStyle(c); const ms = b ? getComputedStyle(b, '::after') : null; return { cell: pick(cs, CELL), button: b ? pick(getComputedStyle(b), BTN) : null, marker: ms ? { content: ms.content, color: ms.color } : null, ariaSort: c.getAttribute('aria-sort'), height: Math.round(c.getBoundingClientRect().height), text: c.textContent.trim() }; };
  return { active: cell(active), plain: cell(plain), numericAlign: getComputedStyle(document.querySelector(numeric)).textAlign };
};
// An element's box on the page (frame coordinates plus the frame's place), for a clipped screenshot
const boxOnPage = async (page, frame, selector, extra = 0) => {
  const r = await frame.evaluate(({ selector, extra }) => { const el = document.querySelector(selector); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height + extra }; }, { selector, extra });
  if (!r) return null;
  const f = await page.evaluate(() => { const b = document.querySelector('iframe[title="Diagnostics content"]').getBoundingClientRect(); return { x: b.left, y: b.top }; });
  return { x: Math.max(0, f.x + r.x - 2), y: Math.max(0, f.y + r.y - 2), width: r.w + 4, height: r.h + 4 };
};
// The content pane's viewport and the frame's place in it (page coordinates) and the pane's scroll position
const paneBox = (page) => page.evaluate(() => {
  const f = document.querySelector('iframe[title="Diagnostics content"]');
  let sc = f.parentElement; while (sc && !(sc.scrollHeight > sc.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
  const s = sc || document.scrollingElement; const sr = s.getBoundingClientRect(); const fr = f.getBoundingClientRect();
  return { top: sr.top, bottom: sr.bottom, left: sr.left, right: sr.right, frameTop: fr.top, frameLeft: fr.left, scrollTop: s.scrollTop };
});

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

// Every Audit page must render to its end inside the frame: the frame's
// height (the parent sets it from the frame's reports) matches the page's
// scrollHeight, the last visible section sits inside it and scrolls into
// view, the fragment ends with its closing markup, no page / console errors.
async function complete(page, frame, label, theme, src, errors, consoleErrors) {
  await sleep(1500);
  const m = await frame.evaluate(() => {
    const root = document.querySelector('#diagnostics-content') || document.body;
    const sections = Array.from(root.querySelectorAll('.au-card, .ae-main, .au-strip, .au-head, .lc-band, .au-profile, .au-note')).filter((el) => el.getBoundingClientRect().height > 0);
    const last = sections[sections.length - 1];
    const r = last ? last.getBoundingClientRect() : null;
    if (last) last.scrollIntoView({ block: 'end' });
    return { scrollHeight: document.body.scrollHeight, sections: sections.length, lastBottom: r ? Math.round(r.bottom) : -1, lastId: last ? (last.id || last.className.split(' ')[0]) : '' };
  });
  const frameH = await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); return { style: parseFloat(f.style.height) || 0, client: f.clientHeight }; });
  // scroll the parent so the frame's bottom is on screen, then check the last section is in the viewport
  const seen = await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.scrollIntoView({ block: 'end' }); const r = f.getBoundingClientRect(); return { bottom: Math.round(r.bottom), vh: window.innerHeight }; });
  check(`${theme}: ${label} renders to its end: frame height ${frameH.client}px = page ${m.scrollHeight}px, the last section (${m.lastId}) ends inside it at ${m.lastBottom}px and scrolls into view`,
    m.sections >= 1 && Math.abs(frameH.client - m.scrollHeight) <= 2 && m.lastBottom > 0 && m.lastBottom <= m.scrollHeight + 2 && seen.bottom <= seen.vh + 2, JSON.stringify({ frameH, m, seen }));
  check(`${theme}: ${label}: the fragment ends with its closing markup, no page errors, no console errors`, /<\/div>\s*$/.test(src) && errors.length === 0 && consoleErrors.length === 0, JSON.stringify({ end: src.trimEnd().slice(-30), errors: errors.slice(0, 2), consoleErrors: consoleErrors.slice(0, 2) }));
  await page.evaluate(() => window.scrollTo(0, 0));
}

// The layout probe, run inside the frame at one width. It walks every visible
// element of the page and reports:
//   clipped  - content wider than its box (scrollWidth > clientWidth), except
//              the intended scrollers (pre/code, raw JSON, command lines) and
//              cells that ellipsise on purpose;
//   past     - anything whose right edge lies beyond the frame;
//   tall     - a table cell above 90 px (five lines) that is not an expanded
//              detail: a column squeezed into letter-by-letter wrapping;
//   headers  - a column header clipped or pushed past its table's card;
//   gaps     - more than 300 px of blank background between painted things,
//              at the top, or after the last one.
const layout = (frame) => frame.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const root = document.querySelector('#diagnostics-content') || document.body;
  const rect = (el) => el.getBoundingClientRect();
  const visible = (el) => { const r = rect(el); return r.width > 0 && r.height > 0; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const scroller = (el) => el.matches('pre, code, canvas, .au-raw, .au-cmd-text, .ui-sr') || !!el.closest('pre, code, .au-raw, .au-cmd-text');   // .ui-sr: the live region, clipped to 1px on purpose
  const clipped = []; const past = []; const tall = []; const headers = []; const painted = [];
  root.querySelectorAll('*').forEach((el) => {
    if (!visible(el)) return;
    const r = rect(el);
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own || el.matches('canvas, svg, input, select, button, i, hr, .lc-stack, .au-bar')) painted.push([r.top + scrollY, r.bottom + scrollY]);
    if (scroller(el)) return;
    if (r.right > w + 1) {
      // text an ancestor ellipsises on purpose (overflow hidden) is clipped, not past the edge: the ancestor itself must fit
      let clip = null;
      for (let p = el.parentElement; p && p !== root; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') { clip = p; break; } }
      if (!clip || rect(clip).right > w + 1) past.push(name(el) + ' right ' + Math.round(r.right));
    }
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
      const cs = getComputedStyle(el);
      if (!(cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible')) clipped.push(name(el) + ' ' + el.scrollWidth + '>' + el.clientWidth);
    }
    if (el.tagName === 'TD' && r.height > 90 && !el.closest('.au-ev-body, .au-body')) tall.push(name(el) + ' ' + Math.round(r.height) + 'px in #' + ((el.closest('table') || {}).id || '?') + ' "' + el.textContent.trim().slice(0, 50) + '"');
    if (el.tagName === 'TH') {
      const wrap = el.closest('.au-table-wrap, .lc-table-wrap, .au-card, .panel') || root;
      if (r.right > rect(wrap).right + 1 || el.scrollWidth > el.clientWidth + 1) headers.push(name(el) + ' "' + el.textContent.trim() + '" right ' + Math.round(r.right) + ' > ' + Math.round(rect(wrap).right));
    }
  });
  painted.sort((a, b) => a[0] - b[0]);
  const gaps = []; let bottom = 0;
  for (const [t, b] of painted) { if (t - bottom > 300) gaps.push(Math.round(bottom) + '-' + Math.round(t)); bottom = Math.max(bottom, b); }
  const total = document.body.scrollHeight;
  if (total - bottom > 300) gaps.push('tail ' + Math.round(bottom) + '-' + total);
  const pageOver = document.documentElement.scrollWidth > w + 1;
  const ok = !pageOver && !clipped.length && !past.length && !tall.length && !headers.length && !gaps.length;
  return { w, total, ok, pageOver, clipped: clipped.slice(0, 6), past: past.slice(0, 6), tall: tall.slice(0, 6), headers: headers.slice(0, 6), gaps, counts: { clipped: clipped.length, past: past.length, tall: tall.length, headers: headers.length } };
});

// The frame's scroll container (the diagnostics pane scrolls, not the window).
const scrollFrameTo = (page, y) => page.evaluate((y) => {
  const f = document.querySelector('iframe[title="Diagnostics content"]');
  let sc = f.parentElement; while (sc && !(sc.scrollHeight > sc.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
  const target = sc || document.scrollingElement;
  const r0 = f.getBoundingClientRect(); const t0 = target.getBoundingClientRect ? target.getBoundingClientRect().top : 0;
  target.scrollTop = y < 0 ? 0 : target.scrollTop + (r0.top - t0) + y;
  const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
}, y);

// Set the frame's width: a viewport width for the wide sizes (the frame is
// the viewport minus the app's rails), an explicit iframe width for narrow.
async function frameWidth(page, fw) {
  await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); if (f.dataset.w === undefined) f.dataset.w = f.style.width; });
  if (fw >= 1360) { await page.setViewportSize({ width: fw, height: 1000 }); await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w; }); }
  else { await page.setViewportSize({ width: 1360, height: 1000 }); await page.evaluate((fw) => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = fw + 'px'; }, fw); }
  await sleep(900);
}

// The frame top to bottom at its current width, in slices of at most 6000 px
// (<label>.png, <label>-part2.png, ...): the viewport grows to the slice, the
// pane scrolls the slice into view and the frame's box is clipped out.
async function shoot(page, file) {
  const SLICE = 6000;
  const vw = await page.evaluate(() => window.innerWidth);
  const total = await page.evaluate(() => document.querySelector('iframe[title="Diagnostics content"]').getBoundingClientRect().height);
  await page.setViewportSize({ width: vw, height: SLICE + 200 }); await sleep(400);
  for (let y = 0, part = 0; y < total; y += SLICE, part++) {
    const box = await scrollFrameTo(page, y); await sleep(200);
    const clipY = Math.max(0, box.y);
    const out = part ? file.replace(/\.png$/, `-part${part + 1}.png`) : file;
    await page.screenshot({ path: out, clip: { x: box.x, y: clipY, width: box.w, height: Math.max(1, Math.min(total - y, SLICE, SLICE + 200 - clipY)) } });
    console.log(`  screenshot: ${out}`);
  }
  await scrollFrameTo(page, -1);
  await page.setViewportSize({ width: vw, height: 1000 }); await sleep(300);
}

// Every select on the page: the frame's own arrow (a background-image the
// frame stylesheet sets with !important) is gone, the select fills its
// wrapper, and the wrapper's one chevron sits inside the select's box.
const selects = (frame) => frame.evaluate(() => {
  const bad = []; let n = 0;
  document.querySelectorAll('select').forEach((sel) => {
    n++;
    const wrap = sel.parentElement; const r = sel.getBoundingClientRect(); const wr = wrap.getBoundingClientRect();
    const chevrons = Array.from(wrap.querySelectorAll('svg'));
    const inside = chevrons.filter((c) => { const cr = c.getBoundingClientRect(); return cr.left >= r.left - 1 && cr.right <= r.right + 1 && cr.top >= r.top - 1 && cr.bottom <= r.bottom + 1; });
    const bg = getComputedStyle(sel).backgroundImage;
    if (bg !== 'none' || chevrons.length !== 1 || inside.length !== 1 || Math.abs(wr.width - r.width) > 1) bad.push(`${sel.id || sel.className} bg=${bg.slice(0, 20)} chevrons=${chevrons.length} inside=${inside.length} w=${Math.round(r.width)}/${Math.round(wr.width)}`);
  });
  return { n, bad };
});

const WIDTHS = [360, 420, 768, 1360, 1920];
async function widths(page, frame, label, theme) {
  for (const fw of WIDTHS) {
    await frameWidth(page, fw);
    if (label === 'audit' && (fw === 420 || fw === 1920)) {
      const hdr = await frame.evaluate(() => ({ head: getComputedStyle(document.getElementById('audit-events-head')).display, sel: getComputedStyle(document.getElementById('audit-events-sort-narrow')).display, selOpts: document.getElementById('ae-sort').options.length }));
      check(`${theme}: ${label} at ${fw}px: ${fw === 420 ? 'the header row is hidden and the "Sort by" select shown' : 'the header row is shown and the "Sort by" select hidden'}`, fw === 420 ? (hdr.head === 'none' && hdr.sel !== 'none' && hdr.selOpts === 12) : (hdr.head !== 'none' && hdr.sel === 'none'), JSON.stringify(hdr));
    }
    const m = await layout(frame);
    check(`${theme}: ${label} at ${m.w}px (${fw}): nothing clipped or past the edge, no squeezed cell, every header visible, no blank run`, m.ok && (fw >= 1360 ? m.w > 900 : Math.abs(m.w - fw) <= 2), JSON.stringify(m));
    if (fw === 1920 || fw === 420) { const s = await selects(frame); check(`${theme}: ${label} at ${m.w}px: ${s.n} select(s), each without the frame's arrow, one chevron inside its box, as wide as its wrapper`, s.bad.length === 0, s.bad.join('; ')); }
    if (fw === 1920) await shoot(page, path.join(OUT, `${label}-wide-1920-${theme}.png`));
    if (fw === 420) await shoot(page, path.join(OUT, `${label}-narrow-420-${theme}.png`));
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w || ''; }); await sleep(300);
}

try {
  for (const theme of ['dark', 'light']) {
    let { context, page, errors, consoleErrors } = await open(theme);
    await clickButton(page, 'Tools'); await sleep(400);
    check(`${theme}: the Diagnostics page opens`, await clickButton(page, 'Diagnostics'));
    const opened = await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name)); if (!b) return false; b.click(); return true; }, REPORT.name, { timeout: 20000 }).then(() => true).catch(() => false);
    check(`${theme}: the synthetic must-gather is listed and opens`, opened);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).some((s) => s.textContent.trim() === 'Audit'), null, { timeout: 20000 }).catch(() => {});
    const labels = await sidebarLabels(page);
    check(`${theme}: Audit is one sidebar entry right before Log Collection, with no sub-tabs (no chevron, no Events / Security Events / Users & Agents / Changes entries)`,
      labels.slice(-2).join() === 'Audit,Log Collection' && (await expandGroup(page, 'Audit')) === 'no chevron' && !labels.some((l) => ['Security Events', 'Users & Agents', 'Changes'].includes(l)) && labels.filter((l) => l === 'Events').length === 1, labels.join(','));
    // Log Collection first: the reference header, at 1920 for the side-by-side shot
    check(`${theme}: Log Collection opens (the reference table header)`, await clickSidebarSpan(page, 'Log Collection'));
    const lcFrame = await diagnosticsFrame(page, '#lc-table');
    let lcHead = null;
    if (lcFrame) {
      await sleep(600);
      await frameWidth(page, 1920);
      lcHead = await lcFrame.evaluate(headStyles, { active: '.lc-table th.lc-th-size', plain: '.lc-table th:nth-child(2)', numeric: '.lc-table th.lc-th-size' });
      const box = await boxOnPage(page, lcFrame, '.lc-table thead', 96);
      if (box) { await page.screenshot({ path: path.join(OUT, `lc-header-1920-${theme}.png`), clip: box }); }
      await frameWidth(page, 1360);
    }
    check(`${theme}: Audit opens`, await clickSidebarSpan(page, 'Audit'));
    let frame = await diagnosticsFrame(page, '#audit-events');
    check(`${theme}: the Audit page rendered and its first search finished`, !!frame && await loaded(frame, '#audit-events'));
    if (!frame) { await context.close(); continue; }

    // The page: the app's own title above, then the content card only (no own heading, no second card title); every filter always visible, no "More filters", no group toggle
    const shape = await frame.evaluate(() => {
      const root = document.getElementById('audit-events');
      const card = document.getElementById('audit-events-card');
      const above = []; for (let el = card.previousElementSibling; el; el = el.previousElementSibling) if (!['STYLE', 'SCRIPT'].includes(el.tagName)) above.push(el.tagName + ':' + el.textContent.trim().slice(0, 30));
      // the cards around the search box: the ancestors between #diagnostics-content and the input that draw a border and round corners
      const bordered = []; for (let el = document.getElementById('ae-q').parentElement; el && el.id !== 'diagnostics-content'; el = el.parentElement) { const cs = getComputedStyle(el); if (parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderTopLeftRadius) > 0) bordered.push(el.id || el.className.split(' ')[0]); }
      const searchBtn = document.getElementById('ae-search').getBoundingClientRect(), limitSel = document.getElementById('ae-limit').getBoundingClientRect();
      const rule = Array.from(document.styleSheets).some((sh) => { try { return Array.from(sh.cssRules).some((r) => /calendar-picker-indicator/.test(r.selectorText || '') && /display: none/.test(r.style ? r.style.cssText : '')); } catch (e) { return false; } });
      return { above, order: Array.from(card.children).map((c) => c.id || c.className.split(' ')[0]), extras: root.querySelectorAll('h2, .au-break, .au-table, table:not(.au-diff), #audit-profile, .au-strip, #audit-events-presets, #audit-events-advanced, details.au-advanced, #ae-group, .au-f-from, input[placeholder="HH:MM"]').length,
        moreFilters: /More filters/.test(root.textContent), category: Array.from(document.querySelectorAll('#ae-category option')).map((o) => o.value + (o.disabled ? '(off)' : '')), selects: document.querySelectorAll('select').length,
        inputsVisible: ['ae-q', 'ae-user', 'ae-verb', 'ae-resource', 'ae-namespace', 'ae-name', 'ae-status', 'ae-category', 'ae-range', 'ae-apiserver', 'ae-node', 'ae-ip', 'ae-agent', 'ae-text', 'ae-limit', 'ae-stage', 'ae-hasbody', 'ae-field', 'ae-ctype', 'ae-search'].filter((id) => { const el = document.getElementById(id); const r = el && el.getBoundingClientRect(); return !(r && r.width > 0 && r.height > 0); }),
        datalistRule: rule, scope: root.dataset.scope, bordered, searchRow: Math.abs(searchBtn.top - limitSel.top) < 4 && searchBtn.left > limitSel.left, frameWidth: document.documentElement.clientWidth };
    });
    check(`${theme}: nothing above the content card (the app's title is the only heading; no h2 in the page); the order is filter rows, chips, status line, visuals, note, sort-by (narrow), header, table, footer; every filter visible at once (no "More filters" toggle), no group toggle, no profile / strip / tables / From-To`,
      shape.above.length === 0 && shape.order.join() === 'audit-events-form,audit-events-chips,audit-events-status,audit-events-visuals,audit-events-note,audit-events-sort-narrow,audit-events-head,audit-events-list,ae-foot' && shape.extras === 0 && !shape.moreFilters && shape.inputsVisible.length === 0 && shape.datalistRule, JSON.stringify(shape));
    check(`${theme}: exactly one card between the page and the search box (the frame's tab panel; the Audit content draws none of its own) and the Search button shares the last filter row at ${shape.frameWidth}px`,
      shape.bordered.length === 1 && shape.bordered[0] === 'audit-events' && shape.searchRow && shape.frameWidth >= 900, JSON.stringify({ bordered: shape.bordered, searchRow: shape.searchRow, w: shape.frameWidth }));
    check(`${theme}: the Category select offers the classified categories (sensitive deletes, RBAC changes, secret reads, impersonation, deprecated, changes) and the Changes option is live on this bodies fixture`,
      shape.category.join() === ',sensitive_deletes,rbac_changes,secret_reads,impersonation,deprecated,changes', JSON.stringify(shape.category));

    // The default view; the selects as additive tag pickers; the multi-value search box; the status / category / apiserver multi-pick; chips
    const ev = await frame.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const root = document.getElementById('audit-events');
      const status = document.getElementById('audit-events-status');
      const rows = () => Array.from(document.querySelectorAll('#audit-events-list .au-ev'));
      const settle = async (before) => { for (let i = 0; i < 240; i++) { if (!status.classList.contains('ui-busy') && status.textContent !== before && !/^(Searching|Loading)/.test(status.textContent)) return; await wait(250); } };
      const charts = () => window.auEvents.charts;
      const chips = () => Array.from(document.querySelectorAll('#audit-events-chips .au-chip')).map((c) => c.dataset.filter + '=' + c.dataset.value);
      const total = () => Number((/^[A-Za-z ]+: ([\d,]+) match/.exec(status.textContent) || [0, '0'])[1].replace(/,/g, ''));
      const pick = async (id, v) => { const b = status.textContent; const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change')); await settle(b); };
      const typeSearch = async (id, v) => { const b = status.textContent; document.getElementById(id).value = v; document.getElementById('ae-search').click(); await settle(b); };
      const removeChip = async (field, value) => { const b = status.textContent; const c = Array.from(document.querySelectorAll('#audit-events-chips .au-chip')).find((x) => x.dataset.filter === field && (value === undefined || x.dataset.value === value)); if (!c) return false; c.click(); await settle(b); return true; };
      const clearAll = async () => { for (let i = 0; i < 20 && document.querySelector('#audit-events-chips .au-chip'); i++) { const b = status.textContent; document.querySelector('#audit-events-chips .au-chip').click(); await settle(b); } };
      const out = { start: status.textContent, rows: rows().length, codes: rows().map((r) => Number(r.dataset.code)), scope: root.dataset.scope };
      out.desc = rows().every((r, i, a) => i === 0 || a[i - 1].dataset.ts >= r.dataset.ts);
      out.successes = out.codes.filter((c) => c >= 200 && c < 300).length;
      const hist = charts()['audit-events-hist'], codesChart = charts()['audit-events-codes'], verbsChart = charts()['audit-events-verbs'];
      out.visuals = { hist: !!hist, histPoints: hist ? hist.data.datasets[0].data.filter((p) => p.y !== null).length : 0, histTotal: hist ? hist.data.datasets[0].data.reduce((s, p) => s + (p.y || 0), 0) + hist.data.datasets[1].data.reduce((s, p) => s + (p.y || 0), 0) : 0,
        codes: codesChart ? codesChart.data.labels : [], codesTotal: codesChart ? codesChart.data.datasets[0].data.reduce((s, n) => s + n, 0) : 0, verbs: verbsChart ? verbsChart.data.labels : [], verbsTotal: verbsChart ? verbsChart.data.datasets[0].data.reduce((s, n) => s + n, 0) + verbsChart.data.datasets[1].data.reduce((s, n) => s + n, 0) : 0 };
      // the verb select is an additive picker: create, then delete; the select resets; picked options marked; OR = the two counts add up
      await pick('ae-verb', 'create');
      const nCreate = total();
      out.create = { status: status.textContent, chips: chips(), sel: document.getElementById('ae-verb').value, marked: Array.from(document.querySelectorAll('#ae-verb option')).filter((o) => o.disabled).map((o) => o.textContent), allCreate: rows().every((r) => r.dataset.verb === 'create') };
      await pick('ae-verb', 'delete');
      const nBoth = total();
      out.both = { status: status.textContent, chips: chips(), allIn: rows().every((r) => ['create', 'delete'].includes(r.dataset.verb)), marked: Array.from(document.querySelectorAll('#ae-verb option')).filter((o) => o.disabled).map((o) => o.textContent) };
      await removeChip('verbs', 'create');
      const nDelete = total();
      out.deleteOnly = { status: status.textContent, chips: chips(), allDelete: rows().every((r) => r.dataset.verb === 'delete'), marked: Array.from(document.querySelectorAll('#ae-verb option')).filter((o) => o.disabled).map((o) => o.textContent), sum: nCreate + nDelete === nBoth, nCreate, nDelete, nBoth };
      await removeChip('verbs', 'delete');
      out.verbsGone = { status: status.textContent, chips: chips(), scope: root.dataset.scope, marked: Array.from(document.querySelectorAll('#ae-verb option')).filter((o) => o.disabled).length };
      // the search box: create,"cannot list" = free text, two search chips, no verb tag, OR across the values
      await typeSearch('ae-q', 'create,"cannot list"');
      out.search = { status: status.textContent, chips: chips(), q: document.getElementById('ae-q').value, verbTags: window.auTags.verbs.length, total: total(),
        allMatch: rows().every((r) => /create|cannot list/.test(r.textContent.toLowerCase())) };
      await removeChip('q', 'cannot list');
      out.searchOne = { total: total(), chips: chips() };
      await removeChip('q'); await removeChip('q');
      // search AND a verb tag
      await typeSearch('ae-q', 'create,delete'); const nQ = total();
      await pick('ae-verb', 'delete'); out.and = { chips: chips(), total: total(), narrower: total() < nQ && total() <= nDelete, allDelete: rows().every((r) => r.dataset.verb === 'delete') };
      await clearAll();
      // the one box matches a time
      await typeSearch('ae-q', '13:5');
      out.time = { status: status.textContent, allMatch: rows().length > 0 && rows().every((r) => r.dataset.ts.includes('13:5')), scope: root.dataset.scope, chips: chips(), codesTotal: charts()['audit-events-codes'].data.datasets[0].data.reduce((s, n) => s + n, 0) };
      await clearAll();
      // status: 403 then 429 (OR), the code bar follows the matches; the box over every forbidden event reaches the old denial outside the scan's sample
      await pick('ae-status', '403');
      out.forbidden = { status: status.textContent, rows: rows().length, all403: rows().every((r) => Number(r.dataset.code) === 403), codes: charts()['audit-events-codes'].data.labels, chips: chips(), sel: document.getElementById('ae-status').value };
      await pick('ae-status', '429');
      out.status2 = { status: status.textContent, chips: chips(), all: rows().every((r) => [403, 429].includes(Number(r.dataset.code))), codes: charts()['audit-events-codes'].data.labels.slice().sort().join() };
      await removeChip('status', '429');
      await typeSearch('ae-q', 'registry-creds-old');
      out.old = { status: status.textContent, rows: rows().length, user: rows()[0] && rows()[0].dataset.user, chips: chips() };
      await removeChip('q'); out.chipGone = { status: status.textContent, chips: chips() };
      await removeChip('status'); out.allAgain = { status: status.textContent, scope: root.dataset.scope, chips: chips() };
      // the Category select: a server-side category, several of them OR; counts over every event (beyond the first 100)
      await pick('ae-category', 'impersonation');
      const asLines = rows().map((r) => r.querySelector('.au-who .au-as-line'));
      const asName = asLines[0] && asLines[0].querySelector('.au-who-name');
      out.imp = { status: status.textContent, rows: rows().length, asLines: asLines.filter(Boolean).length, asText: asName && asName.textContent, asTitle: asName && asName.title, asLabel: asLines[0] && asLines[0].querySelector('.au-as').textContent, asFits: asLines.every((l) => l && l.scrollWidth <= l.clientWidth + 1 && l.getBoundingClientRect().height > 0), chips: chips(), sel: document.getElementById('ae-category').value };
      const nImp = total();
      await pick('ae-category', 'secret_reads');
      out.cat2 = { status: status.textContent, chips: chips(), total: total(), nImp, marked: Array.from(document.querySelectorAll('#ae-category option')).filter((o) => o.disabled && !o.dataset.off).map((o) => o.value) };
      await removeChip('category', 'impersonation');
      out.secretReads = { status: status.textContent, allSecrets: rows().length > 0 && rows().every((r) => /secrets/.test(r.dataset.resource) && !r.dataset.user.startsWith('system:')), total: total() };
      await removeChip('category');
      await pick('ae-category', 'sensitive_deletes'); out.sensitive = { status: status.textContent, allDeletes: rows().length > 0 && rows().every((r) => /^delete/.test(r.dataset.verb)) }; await removeChip('category');
      await pick('ae-category', 'rbac_changes'); out.rbac = { status: status.textContent, allRbac: rows().length > 0 && rows().every((r) => /role/.test(r.dataset.resource)) }; await removeChip('category');
      await pick('ae-category', 'deprecated'); out.deprecated = { status: status.textContent, rows: rows().length }; await removeChip('category');
      // apiserver and node: several values
      await pick('ae-apiserver', 'openshift-apiserver'); const nA = total(); await pick('ae-apiserver', 'oauth-server'); out.apiservers = { chips: chips(), total: total(), nA, more: total() > nA };
      await clearAll();
      await pick('ae-node', 'master-0'); const nN = total(); await pick('ae-node', 'master-1'); out.nodes = { chips: chips(), total: total(), nN, more: total() > nN };
      await clearAll();
      // a click on the verb bar adds a verb tag; a click on a histogram bucket adds from / to tags
      let before = status.textContent; const vc = charts()['audit-events-verbs']; const meta = vc.getDatasetMeta(0).data[0]; const rect = vc.canvas.getBoundingClientRect();
      vc.canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + meta.x - 2, clientY: rect.top + meta.y })); await settle(before);
      out.barClick = { chips: chips(), status: status.textContent, firstLabel: vc.data.labels[0] };
      await removeChip('verbs');
      before = status.textContent; const hc = charts()['audit-events-hist']; const pts = hc.getDatasetMeta(0).data; const idx = pts.findIndex((p) => p && p.height !== 0); const hr = hc.canvas.getBoundingClientRect(); const pt = pts[idx];
      hc.canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: hr.left + pt.x, clientY: hr.top + hc.chartArea.bottom - 2 })); await settle(before);
      const h2 = charts()['audit-events-hist'];
      const geometry = (c) => { if (!c) return null; const ca = c.chartArea, xs = c.scales.x, meta = c.getDatasetMeta(0).data, pts = c.data.datasets[0].data; const widths = meta.map((m) => m.width); const off = meta.map((m, i) => Math.abs(m.x - xs.getPixelForValue(pts[i].x))); const first = meta[0], last = meta[meta.length - 1];
        return { bars: meta.length, minW: Math.min(...widths), maxW: Math.max(...widths), maxOffset: Math.max(...off), firstLeft: first.x - first.width / 2 - ca.left, lastRightGap: ca.right - (last.x + last.width / 2), ticks: xs.ticks.map((t) => t.label) }; };
      out.histClick = { chips: chips(), status: status.textContent, rows: rows().length, sameMinute: rows().length > 0 && rows().every((r) => r.dataset.ts.slice(0, 16) === rows()[0].dataset.ts.slice(0, 16)),
        drawn: !!h2 && !document.getElementById('audit-events-hist-wrap').hidden, buckets: h2 ? h2.data.datasets[0].data.length : 0, note: document.getElementById('audit-events-hist-note').textContent, step: document.getElementById('audit-events-hist-step').textContent, geo: geometry(h2),
        labelled: ['audit-events-codes', 'audit-events-verbs'].every((id) => { const c = charts()[id]; return c && c.scales.y.ticks.length === c.data.labels.length && c.scales.y.ticks.every((t, i) => t.label === c.data.labels[i]); }) };
      await removeChip('from');
      out.histCleared = { chips: chips(), scope: root.dataset.scope, geo: geometry(charts()['audit-events-hist']) };
      // a user filter whose matches span 3 minutes: per 5 s, 37 equal bars; an hour: per 1 min
      document.getElementById('ae-user').value = 'demo-app:default'; document.getElementById('ae-q').value = 'bob-admin';
      before = status.textContent; document.getElementById('ae-search').click(); await settle(before);
      out.threeMin = { status: status.textContent, step: document.getElementById('audit-events-hist-step').textContent, geo: geometry(charts()['audit-events-hist']), width: charts()['audit-events-hist'].chartArea.width };
      await clearAll();
      await pick('ae-range', 'last60');
      out.hour = { status: status.textContent, step: document.getElementById('audit-events-hist-step').textContent, geo: geometry(charts()['audit-events-hist']) };
      await clearAll();
      return out;
    });
    check(`${theme}: the default view lists the newest 200 of every event ("${ev.start}"), newest first, successes among them; the visuals come from the cached scan: the histogram, the status-code and verb bars add up to the 3,048 events`,
      /^Events: 3,048 match · showing the newest 200 · scanned 16 files in [\d.]+ s$/.test(ev.start) && ev.rows === 200 && ev.desc && ev.successes > 100 && ev.scope === 'scan' && ev.visuals.hist && ev.visuals.histPoints > 100 && ev.visuals.histTotal === 3048 && ev.visuals.codesTotal === 3048 && ev.visuals.verbsTotal === 3048 && ev.visuals.codes.includes('403') && ev.visuals.verbs.includes('get'), JSON.stringify({ start: ev.start, rows: ev.rows, visuals: ev.visuals }));
    check(`${theme}: the verb select is an additive picker: create gives a "verb: create" tag (the select back to "Any verb", create marked), then delete adds a second tag (OR: ${ev.deleteOnly.nCreate} + ${ev.deleteOnly.nDelete} = ${ev.deleteOnly.nBoth}); removing create keeps delete; removing delete restores the whole capture`,
      ev.create.chips.join() === 'verbs=create' && ev.create.sel === '' && ev.create.marked.join() === '✓ create' && ev.create.allCreate && ev.both.chips.join() === 'verbs=create,verbs=delete' && ev.both.allIn && ev.both.marked.length === 2
      && ev.deleteOnly.chips.join() === 'verbs=delete' && ev.deleteOnly.allDelete && ev.deleteOnly.sum && ev.deleteOnly.marked.join() === '✓ delete' && ev.verbsGone.chips.length === 0 && ev.verbsGone.scope === 'scan' && ev.verbsGone.marked === 0 && /^Events: 3,048 match/.test(ev.verbsGone.status), JSON.stringify({ c: ev.create, b: ev.both, d: ev.deleteOnly, g: ev.verbsGone }));
    check(`${theme}: the search box takes several values as free text: create,"cannot list" gives two search chips and no verb tag, matches events holding either string anywhere (more than the create verb alone); search AND a verb tag narrows`,
      ev.search.chips.join() === 'q=create,q=cannot list' && ev.search.verbTags === 0 && ev.search.q === '' && ev.search.allMatch && ev.search.total > ev.deleteOnly.nCreate && ev.searchOne.chips.join() === 'q=create' && ev.searchOne.total < ev.search.total && ev.searchOne.total >= ev.deleteOnly.nCreate && ev.and.chips.join() === 'q=create,q=delete,verbs=delete' && ev.and.narrower && ev.and.allDelete, JSON.stringify({ s: ev.search, one: ev.searchOne, and: ev.and }));
    check(`${theme}: the one box matches the time text (13:5); with a filter the visuals follow the matches (the status bars add up to the match count)`,
      ev.time.allMatch && /^Events: (\d+) match/.test(ev.time.status) && ev.time.scope === 'search' && ev.time.codesTotal === Number(/^Events: ([\d,]+) match/.exec(ev.time.status)[1].replace(/,/g, '')) && ev.time.chips.join() === 'q=13:5', JSON.stringify(ev.time));
    check(`${theme}: status 403 lists the 413 forbidden decisions (the code bar shows 403 only, the select back to "Any status"); 429 added = 433 (OR); the box over every forbidden event finds the old denial outside the scan's sample; the chips remove one value each`,
      /^Events: 413 match · showing the newest 200/.test(ev.forbidden.status) && ev.forbidden.rows === 200 && ev.forbidden.all403 && ev.forbidden.codes.join() === '403' && ev.forbidden.sel === '' && ev.forbidden.chips.join() === 'status=403'
      && /^Events: 433 match/.test(ev.status2.status) && ev.status2.all && ev.status2.codes === '403,429' && /^Events: 1 match · showing all 1/.test(ev.old.status) && ev.old.user === 'svc-deployer' && ev.old.chips.slice().sort().join() === 'q=registry-creds-old,status=403'
      && /^Events: 413 match/.test(ev.chipGone.status) && ev.allAgain.scope === 'scan' && ev.allAgain.chips.length === 0 && /^Events: 3,048 match/.test(ev.allAgain.status), JSON.stringify({ f: ev.forbidden.status, s2: ev.status2, old: ev.old, gone: ev.chipGone, all: ev.allAgain }));
    check(`${theme}: the Category picker: Impersonation 4 (each row with an "acting as" line naming the impersonated identity in full), plus Secret reads = 17 (OR, both marked), Secret reads alone 13; Sensitive deletes 38; RBAC changes 21; Deprecated APIs 39`,
      /^Impersonation: 4 match · showing all 4/.test(ev.imp.status) && ev.imp.rows === 4 && ev.imp.asLines === 4 && ev.imp.asFits && ev.imp.asLabel === 'acting as' && ev.imp.asTitle === 'system:serviceaccount:demo-app:default' && ev.imp.asText === 'SAdemo-app:default' && ev.imp.chips.join() === 'category=impersonation' && ev.imp.sel === ''
      && ev.cat2.total === 17 && ev.cat2.chips.join() === 'category=impersonation,category=secret_reads' && ev.cat2.marked.slice().sort().join() === 'impersonation,secret_reads' && /^Secret reads: 13 match/.test(ev.secretReads.status) && ev.secretReads.allSecrets
      && /^Sensitive deletes: 38 match/.test(ev.sensitive.status) && ev.sensitive.allDeletes && /^RBAC changes: 21 match/.test(ev.rbac.status) && ev.rbac.allRbac && /^Deprecated APIs: 39 match/.test(ev.deprecated.status), JSON.stringify({ imp: ev.imp, c2: ev.cat2, sr: ev.secretReads, s: ev.sensitive, r: ev.rbac, d: ev.deprecated }));
    check(`${theme}: apiserver and node pickers take several values (the count grows with the second pick)`, ev.apiservers.chips.join() === 'apiserver=openshift-apiserver,apiserver=oauth-server' && ev.apiservers.more && ev.nodes.chips.join() === 'node=master-0,node=master-1' && ev.nodes.more, JSON.stringify({ a: ev.apiservers, n: ev.nodes }));
    check(`${theme}: a click on the verb bar adds a verb tag; a click on a histogram bucket adds from / to tags for that minute, the histogram redraws per second for the one-minute range (no gap note), every bar in both charts carries its label; removing the from tag restores the whole capture`,
      ev.barClick.chips.join() === 'verbs=' + ev.barClick.firstLabel && ev.histClick.chips.some((c) => /^from=/.test(c)) && ev.histClick.chips.some((c) => /^to=/.test(c)) && ev.histClick.sameMinute && ev.histClick.drawn && ev.histClick.buckets >= 1 && ev.histClick.note === '' && /per \d+ s/.test(ev.histClick.step) && ev.histClick.labelled && ev.histCleared.chips.length === 0 && ev.histCleared.scope === 'scan', JSON.stringify({ bar: ev.barClick, hist: ev.histClick, cleared: ev.histCleared }));
    const even = (g) => g && g.bars >= 1 && g.maxW - g.minW <= 1 && g.maxOffset <= 2 && g.firstLeft >= -1 && g.firstLeft <= g.minW && g.lastRightGap >= -1 && g.lastRightGap <= g.minW;   // equal widths, each bar centred on its bucket, full bars at both edges, no empty slot
    check(`${theme}: the histogram's bars are equal, centred on their buckets and fill the plot edge to edge: the whole capture (${ev.histCleared.geo && ev.histCleared.geo.bars} bars per 1 min from the scan), a 3-minute user filter (${ev.threeMin.geo && ev.threeMin.geo.bars} bars per 5 s, seconds on the ticks), an hour (${ev.hour.geo && ev.hour.geo.bars} bars per 1 min)`,
      even(ev.histCleared.geo) && ev.histCleared.geo.bars >= 100 && ev.histCleared.geo.bars <= 120 && even(ev.threeMin.geo) && ev.threeMin.geo.bars === 37 && /per 5 s/.test(ev.threeMin.step) && /^\d\d:\d\d:\d\d$/.test(ev.threeMin.geo.ticks[0]) && /^Events: 4 match/.test(ev.threeMin.status)
      && even(ev.hour.geo) && ev.hour.geo.bars === 60 && /per 1 min/.test(ev.hour.step), JSON.stringify({ all: ev.histCleared.geo, three: ev.threeMin, hour: ev.hour }));

    // Load older, the SA tag, the raw JSON, a masked body and Reveal
    const more = await frame.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const status = document.getElementById('audit-events-status');
      const rows = () => Array.from(document.querySelectorAll('#audit-events-list .au-ev'));
      const settle = async (before) => { for (let i = 0; i < 240; i++) { if (!status.classList.contains('ui-busy') && status.textContent !== before && !/^(Searching|Loading)/.test(status.textContent)) return; await wait(250); } };
      const clearAll = async () => { for (let i = 0; i < 20 && document.querySelector('#audit-events-chips .au-chip'); i++) { const b = status.textContent; document.querySelector('#audit-events-chips .au-chip').click(); await settle(b); } };
      const out = {};
      document.getElementById('ae-user').value = 'system:serviceaccount'; document.getElementById('ae-limit').value = '100';
      let before = status.textContent; document.getElementById('ae-search').click(); await settle(before);
      const firstPage = rows().map((r) => r.dataset.auditId);
      const more = document.getElementById('audit-events-more');
      out.moreShown = !more.hidden;
      before = status.textContent; more.click(); await settle(before);
      const all = rows().map((r) => r.dataset.auditId);
      out.older = { rows: all.length, unique: new Set(all).size, desc: rows().every((r, i, a) => i === 0 || a[i - 1].dataset.ts >= r.dataset.ts), firstKept: all.slice(0, firstPage.length).join() === firstPage.join(), status: status.textContent, allSa: rows().every((r) => r.dataset.user.startsWith('system:serviceaccount')) };
      // the user filter also matches groups and the impersonated identity: a group match says so, an impersonation shows its "acting as" line
      await clearAll();
      document.getElementById('ae-user').value = 'system:nodes';
      before = status.textContent; document.getElementById('ae-search').click(); await settle(before);
      const viaRows = rows().filter((r) => r.querySelector('.au-who .au-via'));
      out.viaGroup = { status: status.textContent, rows: rows().length, hints: viaRows.length, hint: viaRows.length ? viaRows[0].querySelector('.au-who .au-via').textContent : '', nonNodeUsers: rows().filter((r) => !r.dataset.user.startsWith('system:node:')).length };
      await clearAll();
      document.getElementById('ae-user').value = 'demo-app:default'; document.getElementById('ae-q').value = 'bob-admin';   // the impersonated identity through the user filter, the requester through the search box
      before = status.textContent; document.getElementById('ae-search').click(); await settle(before);
      out.viaImp = { status: status.textContent, rows: rows().length, impRows: rows().filter((r) => r.dataset.user === 'bob-admin' && r.querySelector('.au-who .au-as-line')).length, noCheckbox: !document.getElementById('ae-groups') };
      await clearAll();
      document.getElementById('ae-user').value = 'system:serviceaccount'; document.getElementById('ae-limit').value = '100';
      before = status.textContent; document.getElementById('ae-search').click(); await settle(before);
      const firstPage2 = rows().map((r) => r.dataset.auditId);
      before = status.textContent; document.getElementById('audit-events-more').click(); await settle(before);
      out.older.firstKept = rows().map((r) => r.dataset.auditId).slice(0, firstPage2.length).join() === firstPage2.join();
      const sa = rows()[0].querySelector('.au-who-main .au-who-name');
      out.sa = { text: sa.textContent, title: sa.title, tag: !!sa.querySelector('.au-sa') };
      rows()[0].open = true;
      out.raw = (rows()[0].querySelector('.au-raw:not(.au-body-text)') || {}).textContent || '';
      await clearAll();
      // a Secret write with a body: masked, Reveal through the proxy
      document.getElementById('ae-limit').value = '200'; document.getElementById('ae-resource').value = 'secrets'; document.getElementById('ae-hasbody').checked = true;
      before = status.textContent; document.getElementById('ae-search').click(); await settle(before);
      const withBody = rows().find((r) => r.querySelector('.au-reveal[data-part="request"]'));
      out.bodyRow = !!withBody;
      if (withBody) {
        withBody.open = true;
        const det = withBody.querySelector('.au-reveal[data-part="request"]').closest('.au-body'); det.open = true;
        const pre = det.querySelector('.au-body-text'); out.masked = pre.textContent;
        det.querySelector('.au-reveal').click(); await wait(800);
        out.revealed = pre.textContent; out.revealLabel = det.querySelector('.au-reveal').textContent.trim();
      }
      // the fake Secret values never reach the page's text (the app's compiled CSS holds Tailwind's placeholder- utilities, so the text, not the markup)
      out.htmlClean = !/placeholder-/.test(document.getElementById('diagnostics-content').textContent.replace(/REVEALED-[^\s<]*/g, '')) && !Array.from(document.querySelectorAll('input')).some((i) => /placeholder-/.test(i.value));
      await clearAll();
      return out;
    });
    check(`${theme}: Load older continues the service-account search: 200 rows after two pages of 100, no duplicates, newest first, the first page kept, all service accounts`,
      more.moreShown && more.older.rows === 200 && more.older.unique === 200 && more.older.desc && more.older.firstKept && more.older.allSa, JSON.stringify(more.older));
    check(`${theme}: the User filter always matches groups and the impersonated identity (no checkbox): system:nodes (nobody's username) lists the node users through their group, each row with a "via group system:nodes" hint; demo-app:default lists bob-admin's impersonations with their "acting as" line`,
      more.viaGroup.rows > 0 && more.viaGroup.hints === more.viaGroup.rows && more.viaGroup.hint === 'via group system:nodes' && more.viaGroup.nonNodeUsers === 0 && more.viaImp.rows === 4 && more.viaImp.impRows === 4 && /^Events: 4 match/.test(more.viaImp.status) && more.viaImp.noCheckbox, JSON.stringify({ g: more.viaGroup, i: more.viaImp }));
    check(`${theme}: a service account shows as namespace:name behind an SA tag with the full name in the title; a row opens to its raw JSON; a Secret write shows a masked request body and Reveal replaces it through the proxy; no placeholder value in the page`,
      more.sa.tag && !more.sa.text.startsWith('system:serviceaccount:') && more.sa.title.startsWith('system:serviceaccount:') && more.raw.includes('"auditID"') && more.bodyRow && /•••• \(\d+ bytes\)/.test(more.masked) && more.revealed.startsWith('REVEALED-request-') && more.revealLabel === 'Hide values' && more.htmlClean, JSON.stringify({ sa: more.sa, raw: more.raw.slice(0, 40), bodyRow: more.bodyRow, masked: (more.masked || '').slice(0, 60), revealed: (more.revealed || '').slice(0, 40), label: more.revealLabel, clean: more.htmlClean }));

    // The table header: sticky, every column a sort button; the sorts run server-side over all matches; the narrow "Sort by" select; non-resource rows show the URI path
    const srt = await frame.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const status = document.getElementById('audit-events-status');
      const rows = () => Array.from(document.querySelectorAll('#audit-events-list .au-ev'));
      const settle = async (before) => { for (let i = 0; i < 240; i++) { if (!status.classList.contains('ui-busy') && status.textContent !== before && !/^(Searching|Loading)/.test(status.textContent)) return; await wait(250); } };
      const head = document.getElementById('audit-events-head');
      const aria = () => Array.from(head.querySelectorAll('button[data-sort]')).filter((b) => b.closest('.au-th').getAttribute('aria-sort')).map((b) => b.dataset.sort + ':' + b.closest('.au-th').getAttribute('aria-sort'));
      const out = { sticky: getComputedStyle(head).position, top: getComputedStyle(head).top, cells: Array.from(head.children).map((c) => c.textContent.trim()), aria: aria(), narrowSel: getComputedStyle(document.getElementById('audit-events-sort-narrow')).display, latencyCol: rows()[0] && rows()[0].querySelector('.au-latency') ? rows()[0].querySelector('.au-latency').textContent : null, latencyChip: !!document.querySelector('#audit-events-list .au-what .au-tag') };
      let before = status.textContent; head.querySelector('button[data-sort="latency"]').click(); await settle(before);
      out.latency = { status: status.textContent, aria: aria(), first: rows().slice(0, 3).map((r) => r.querySelector('.au-latency').textContent), sel: document.getElementById('ae-sort').value, watches: rows().filter((r) => r.dataset.verb === 'watch').length, marker: getComputedStyle(head.querySelector('button[data-sort="latency"]'), '::after').content };
      before = status.textContent; head.querySelector('button[data-sort="latency"]').click(); await settle(before);
      out.latencyAsc = { status: status.textContent, aria: aria(), first: rows().slice(0, 3).map((r) => r.querySelector('.au-latency').textContent), sel: document.getElementById('ae-sort').value, marker: getComputedStyle(head.querySelector('button[data-sort="latency"]'), '::after').content };
      before = status.textContent; document.getElementById('audit-events-more').click(); await settle(before);
      const ids = rows().map((r) => r.dataset.auditId);
      out.more = { rows: ids.length, unique: new Set(ids).size, ordered: rows().every((r, i, a) => i === 0 || (parseFloat(a[i - 1].querySelector('.au-latency').textContent) || 0) <= (parseFloat(r.querySelector('.au-latency').textContent) || 0) || a[i - 1].querySelector('.au-latency').textContent.endsWith('ms') && !r.querySelector('.au-latency').textContent.endsWith('ms')) };
      before = status.textContent; head.querySelector('button[data-sort="user"]').click(); await settle(before);
      out.user = { status: status.textContent, aria: aria(), ordered: rows().every((r, i, a) => i === 0 || a[i - 1].dataset.user.toLowerCase() <= r.dataset.user.toLowerCase()) };
      before = status.textContent; const sel = document.getElementById('ae-sort'); sel.value = 'status'; sel.dispatchEvent(new Event('change')); await settle(before);
      out.statusSort = { status: status.textContent, aria: aria(), ordered: rows().every((r, i, a) => i === 0 || Number(a[i - 1].dataset.code) >= Number(r.dataset.code)) };
      before = status.textContent; sel.value = 'time'; sel.dispatchEvent(new Event('change')); await settle(before);
      out.back = { status: status.textContent, aria: aria() };
      document.getElementById('ae-q').value = '/metrics';
      before = status.textContent; document.getElementById('ae-search').click(); await settle(before);
      out.nonres = { status: status.textContent, what: rows().slice(0, 2).map((r) => r.querySelector('.au-what').textContent.trim()), none: rows().some((r) => /\(none\)/.test(r.textContent)), title: rows()[0] && rows()[0].querySelector('.au-path').title, verbCell: rows()[0] && rows()[0].querySelector('.au-verb-cell').textContent };
      const chip = document.querySelector('#audit-events-chips .au-chip'); before = status.textContent; chip.click(); await settle(before);
      return out;
    });
    check(`${theme}: the events table has a sticky header (When · Who · Verb · Object · Latency · Status · From) with the time column marked newest-first; Latency is its own right-aligned column, no chip inside Object; the narrow "Sort by" select is hidden at this width`,
      srt.sticky === 'sticky' && srt.top === '0px' && srt.cells.join() === 'When,Who,Verb,Object,Latency,Status,From' && srt.aria.join() === 'time:descending' && srt.narrowSel === 'none' && typeof srt.latencyCol === 'string' && !srt.latencyChip, JSON.stringify({ sticky: srt.sticky, cells: srt.cells, aria: srt.aria, narrow: srt.narrowSel, lat: srt.latencyCol }));
    check(`${theme}: a click on Latency sorts ALL matches server-side (the planted 8.5 s, 6.2 s, 3.2 s first: the slowest of the whole capture, not of the newest 200), aria-sort descending with a ▾ marker, the status line says "sorted by latency, slowest first", no watches among the rows; a second click reverses (fastest first, ▴); Load older continues the order without duplicates`,
      /sorted by latency, slowest first · showing 200/.test(srt.latency.status) && srt.latency.first.join() === '8.5 s,6.2 s,3.2 s' && srt.latency.aria.join() === 'latency:descending' && /25BE|▾/.test(srt.latency.marker) && srt.latency.sel === 'latency' && srt.latency.watches === 0
      && /sorted by latency, fastest first/.test(srt.latencyAsc.status) && srt.latencyAsc.aria.join() === 'latency:ascending' && /25B4|▴/.test(srt.latencyAsc.marker) && srt.latencyAsc.first.every((t) => /^1 ms$/.test(t)) && srt.latencyAsc.sel === 'latency_asc' && srt.more.rows === 400 && srt.more.unique === 400 && srt.more.ordered, JSON.stringify({ l: srt.latency, a: srt.latencyAsc, m: srt.more }));
    check(`${theme}: Who sorts by user (A to Z), the narrow select sorts by status (highest first), and "newest first" restores the time order with its marker`,
      /sorted by user, user A to Z/.test(srt.user.status) && srt.user.aria.join() === 'user:ascending' && srt.user.ordered && /sorted by status, highest status first/.test(srt.statusSort.status) && srt.statusSort.ordered && srt.statusSort.aria.join() === 'status:descending' && !/sorted by/.test(srt.back.status) && srt.back.aria.join() === 'time:descending', JSON.stringify({ u: srt.user, s: srt.statusSort, b: srt.back }));
    check(`${theme}: non-resource requests show their URI path as the object ("get /metrics", the full URI in the title), never "(none)"`,
      /^Events: 3 match/.test(srt.nonres.status) && srt.nonres.what.every((w) => w === 'get /metrics') && !srt.nonres.none && srt.nonres.title === '/metrics' && srt.nonres.verbCell === 'get', JSON.stringify(srt.nonres));

    // The header design: the Audit header cells and sort buttons computed exactly like the Log Collection table's (the shared include)
    const auHead = await frame.evaluate(headStyles, { active: '#audit-events-head .au-th:first-child', plain: '#audit-events-head .au-th:nth-child(2)', numeric: '#audit-events-head .au-th.au-num' });
    const diffs = [];
    if (lcHead) {
      for (const part of ['active', 'plain']) {
        for (const k of Object.keys(lcHead[part].cell)) if (lcHead[part].cell[k] !== auHead[part].cell[k]) diffs.push(`${part}.cell.${k}: lc ${lcHead[part].cell[k]} / au ${auHead[part].cell[k]}`);
        for (const k of Object.keys(lcHead[part].button)) if (lcHead[part].button[k] !== auHead[part].button[k]) diffs.push(`${part}.button.${k}: lc ${lcHead[part].button[k]} / au ${auHead[part].button[k]}`);
        if (lcHead[part].marker.content !== auHead[part].marker.content || lcHead[part].marker.color !== auHead[part].marker.color) diffs.push(`${part}.marker: lc ${JSON.stringify(lcHead[part].marker)} / au ${JSON.stringify(auHead[part].marker)}`);
        if (lcHead[part].ariaSort !== auHead[part].ariaSort) diffs.push(`${part}.aria-sort: lc ${lcHead[part].ariaSort} / au ${auHead[part].ariaSort}`);
        if (Math.abs(lcHead[part].height - auHead[part].height) > 1) diffs.push(`${part}.height: lc ${lcHead[part].height} / au ${auHead[part].height}`);
      }
      if (lcHead.numericAlign !== 'right' || auHead.numericAlign !== 'right') diffs.push(`numeric align: lc ${lcHead.numericAlign} / au ${auHead.numericAlign}`);
    }
    check(`${theme}: the Audit events header matches the Log Collection table header exactly: font, size, weight, letter-spacing, uppercase, muted colour, padding, background, bottom border and height of the cells; the sort buttons; the active column's primary colour, "\u25BE" marker and aria-sort="descending" (When / Size), no marker on a plain column (Who / Name); numbers right-aligned (Latency / Size)`,
      !!lcHead && diffs.length === 0 && auHead.active.text === 'When' && lcHead.active.text === 'Size' && auHead.plain.text === 'Who' && lcHead.plain.text === 'Name' && /25BE|\u25BE/.test(auHead.active.marker.content) && auHead.plain.marker.content === 'none', JSON.stringify({ diffs, au: auHead, lc: lcHead }).slice(0, 1400));
    await frameWidth(page, 1920);
    {
      const box = await boxOnPage(page, frame, '#audit-events-head', 96);
      if (box) await page.screenshot({ path: path.join(OUT, `audit-header-1920-${theme}.png`), clip: box });
      // both headers side by side (the backend venv's Pillow; the two shots stay either way)
      const lc = path.join(OUT, `lc-header-1920-${theme}.png`), au = path.join(OUT, `audit-header-1920-${theme}.png`), both = path.join(OUT, `headers-side-by-side-${theme}.png`);
      if (fs.existsSync(lc) && fs.existsSync(au)) {
        const py = "import sys\nfrom PIL import Image\na, b = Image.open(sys.argv[1]), Image.open(sys.argv[2])\nout = Image.new('RGB', (a.width + b.width + 24, max(a.height, b.height) + 16), (128, 128, 128))\nout.paste(a, (8, 8)); out.paste(b, (a.width + 16, 8)); out.save(sys.argv[3])";
        const r = spawnSync(PYTHON, ['-I', '-c', py, au, lc, both], { encoding: 'utf8' });
        if (r.status === 0) console.log(`  screenshot: ${both} (Audit left, Log Collection right)`);
      }
    }
    await frameWidth(page, 1360);

    // The busy state where the action happens: the search answer delayed 1.5 s; the page scrolled to the table first (the status line out of view)
    searchDelay = 1500;
    const busyProbe = () => {
      const head = document.getElementById('audit-events-head'), list = document.getElementById('audit-events-list'), pill = document.getElementById('ui-busy-pill'), narrow = document.getElementById('audit-events-sort-narrow');
      const bar = (el) => { const b = getComputedStyle(el, '::before'); return { h: b.height, bg: b.backgroundColor, img: b.backgroundImage.slice(0, 30) }; };
      const loading = Array.from(document.querySelectorAll('.ui-loading')).map((e) => e.id || e.dataset.sort || e.className);
      const spinner = (b) => b ? getComputedStyle(b, '::after').width : null;
      return { loading, busy: list.getAttribute('aria-busy'), headBar: bar(head), narrowBar: bar(narrow), headShift: head.style.transform, headTop: head.getBoundingClientRect().top, narrowTop: narrow.getBoundingClientRect().top, headDisplay: getComputedStyle(head).display,
        pill: { hidden: pill.hidden, text: pill.textContent.trim(), cls: pill.className, top: pill.getBoundingClientRect().top, bottom: pill.getBoundingClientRect().bottom, cancel: !document.getElementById('ui-busy-cancel').hidden, retry: !document.getElementById('ui-busy-retry').hidden },
        rows: Array.from(document.querySelectorAll('#audit-events-list .au-ev')).map((r) => r.dataset.auditId), status: document.getElementById('audit-events-status').textContent, live: document.getElementById('ui-busy-live').textContent,
        trigger: spinner(document.querySelector('#audit-events-head .lc-sort.ui-loading')), more: { text: document.getElementById('audit-events-more').textContent, disabled: document.getElementById('audit-events-more').disabled, hidden: document.getElementById('audit-events-more').hidden },
        search: { cls: document.getElementById('ae-search').className, disabled: document.getElementById('ae-search').disabled, spin: getComputedStyle(document.getElementById('ae-search'), '::before').width } };
    };
    const headY = await frame.evaluate(() => document.getElementById('audit-events-head').getBoundingClientRect().top);
    await scrollFrameTo(page, headY + 160); await sleep(400);   // past the header: it must follow the view's top
    const pane0 = await paneBox(page);
    const b0 = await frame.evaluate(busyProbe);
    await frame.evaluate(() => document.querySelector('#audit-events-head .lc-sort[data-sort="latency"]').click());
    await sleep(120);
    const b1 = await frame.evaluate(busyProbe); const pane1 = await paneBox(page);
    await sleep(500);
    const b2 = await frame.evaluate(busyProbe); const pane2 = await paneBox(page);
    await settled(frame, 'audit-events-status', b0.status); await sleep(300);
    const b3 = await frame.evaluate(busyProbe); const pane3 = await paneBox(page);
    const inView = (pane, y) => pane.frameTop + y >= pane.top - 1 && pane.frameTop + y <= pane.bottom;
    check(`${theme}: a header click while scrolled past the table top: at once the clicked header shows a spinner for its marker, the table is aria-busy and dimmed with the old rows kept, the progress bar runs along the top of the header, which follows the view's top (in view at ${Math.round(pane1.frameTop + b1.headTop - pane1.top)} px from the pane's top); no pill yet`,
      b1.loading.includes('latency') && b1.trigger === '9px' && b1.busy === 'true' && b1.rows.join() === b0.rows.join() && b1.rows.length > 0 && b1.headBar.h === '2px' && b1.headBar.bg !== 'rgba(0, 0, 0, 0)' && b0.headBar.bg === 'rgba(0, 0, 0, 0)' && b1.headShift.startsWith('translateY(') && inView(pane1, b1.headTop) && pane1.frameTop + b1.headTop - pane1.top < 12 && b1.pill.hidden && b1.live === 'Searching' && /^Searching/.test(b1.status),
      JSON.stringify({ b1, pane1 }).slice(0, 1200));
    check(`${theme}: after 300 ms the floating pill "Searching… N s" with Cancel sits inside the pane's viewport, near its bottom`,
      !b2.pill.hidden && /^Searching… \d+\.\d s/.test(b2.pill.text) && b2.pill.cancel && !b2.pill.retry && inView(pane2, b2.pill.top) && inView(pane2, b2.pill.bottom) && pane2.bottom - (pane2.frameTop + b2.pill.bottom) < 40 && b2.busy === 'true',
      JSON.stringify({ pill: b2.pill, pane2 }));
    check(`${theme}: on completion everything clears (no spinner, aria-busy false, no bar, no pill, "N events loaded" announced) and the view stays at the table: the header at the top of the pane (${Math.round(pane3.frameTop + b3.headTop - pane3.top)} px), not the top of the page`,
      b3.loading.length === 0 && b3.busy === 'false' && b3.headBar.bg === 'rgba(0, 0, 0, 0)' && b3.pill.hidden && /^\d+ events loaded$/.test(b3.live) && /sorted by latency/.test(b3.status) && Math.abs(pane3.frameTop + b3.headTop - pane3.top) <= 3 && pane3.scrollTop > 100 && b3.rows.join() !== b0.rows.join(),
      JSON.stringify({ b3, pane3 }).slice(0, 1200));
    // Load older: the button itself says Loading…
    await frame.evaluate(() => document.getElementById('audit-events-more').click()); await sleep(120);
    const m1 = await frame.evaluate(busyProbe);
    await settled(frame, 'audit-events-status', b3.status); await sleep(200);
    const m2 = await frame.evaluate(busyProbe);
    check(`${theme}: Load older turns into "Loading…" with a spinner, disabled, while the older page loads, then reads Load older again`,
      m1.more.text === 'Loading…' && m1.more.disabled && !m1.more.hidden && m1.loading.includes('audit-events-more') && m1.busy === 'true' && m2.more.text === 'Load older' && !m2.more.disabled && m2.rows.length === b3.rows.length * 2, JSON.stringify({ m1: m1.more, m2: m2.more, rows: [b3.rows.length, m2.rows.length] }));
    // Cancel: the pill's button drops the search at once, the rows stay, the backend is told, the late answer is ignored
    const cancelsBefore = cancels.length;
    await frame.evaluate(() => document.querySelector('#audit-events-head .lc-sort[data-sort="user"]').click()); await sleep(450);
    const c1 = await frame.evaluate(busyProbe);
    await frame.evaluate(() => document.getElementById('ui-busy-cancel').click()); await sleep(150);
    const c2 = await frame.evaluate(busyProbe);
    await sleep(1700);
    const c3 = await frame.evaluate(busyProbe);
    check(`${theme}: Cancel in the pill aborts the search: the pill goes, the busy state clears, the rows and the sort marker stay as they were, the status says cancelled, /audit_events_cancel was called once, and the answer arriving later changes nothing`,
      !c1.pill.hidden && c2.pill.hidden && c2.busy === 'false' && c2.loading.length === 0 && c2.rows.join() === m2.rows.join() && /^Search cancelled/.test(c2.status) && cancels.length === cancelsBefore + 1 && c3.rows.join() === m2.rows.join() && c3.status === c2.status && c3.pill.hidden
      && await frame.evaluate(() => document.querySelector('#audit-events-head .au-th[aria-sort]').textContent.trim() === 'Latency' && document.getElementById('ae-sort').value === 'latency'), JSON.stringify({ c1: c1.pill, c2: { pill: c2.pill, busy: c2.busy, status: c2.status, loading: c2.loading }, cancels: cancels.length - cancelsBefore, c3: c3.status }));
    // An error: the same pill with Retry, which repeats the request
    searchDelay = 0; searchError = 'boom';
    await frame.evaluate(() => document.querySelector('#audit-events-head .lc-sort[data-sort="verb"]').click());
    await settled(frame, 'audit-events-status', c3.status); await sleep(200);
    const e1 = await frame.evaluate(busyProbe);
    searchError = null;
    await frame.evaluate(() => document.getElementById('ui-busy-retry').click());
    await settled(frame, 'audit-events-status', e1.status); await sleep(200);
    const e2 = await frame.evaluate(busyProbe);
    { const i = consoleErrors.findIndex((m) => /status of 500/.test(m)); if (i >= 0) consoleErrors.splice(i, 1); }   // the deliberate 500 above, logged by the browser
    check(`${theme}: a failed search shows "Search failed: boom" in the pill with Retry (no Cancel), the rows kept; Retry repeats the request and the verb sort lands`,
      /Search failed: boom/.test(e1.status) && !e1.pill.hidden && /Search failed: boom/.test(e1.pill.text) && e1.pill.retry && !e1.pill.cancel && e1.pill.cls.includes('ui-error') && e1.busy === 'false' && e1.rows.join() === m2.rows.join() && e2.pill.hidden && /sorted by verb/.test(e2.status) && e2.busy === 'false', JSON.stringify({ e1: { status: e1.status, pill: e1.pill }, e2: { status: e2.status, pill: e2.pill } }));
    // A fast search shows no pill at all
    const reveals = await frame.evaluate(async () => {
      const pill = document.getElementById('ui-busy-pill'); let n = 0;
      const mo = new MutationObserver(() => { if (!pill.hidden) n++; }); mo.observe(pill, { attributes: true, attributeFilter: ['hidden'] });
      const status = document.getElementById('audit-events-status'); const before = status.textContent;
      document.querySelector('#audit-events-head .lc-sort[data-sort="status"]').click();
      for (let i = 0; i < 200; i++) { if (!status.classList.contains('ui-busy') && status.textContent !== before) break; await new Promise((r) => setTimeout(r, 50)); }
      await new Promise((r) => setTimeout(r, 400)); mo.disconnect();
      return { n, status: status.textContent, hidden: pill.hidden };
    });
    check(`${theme}: a search answered within 300 ms never shows the pill`, reveals.n === 0 && reveals.hidden && /sorted by status/.test(reveals.status), JSON.stringify(reveals));
    // The busy state at 420 (the header hidden: the bar and spinner on the "Sort by" row, the pill in the pane) and at 1920, with screenshots of the pane
    searchDelay = 1500;
    for (const fw of [420, 1920]) {
      await frameWidth(page, fw);
      const sel = fw === 420 ? '#audit-events-sort-narrow' : '#audit-events-head';
      const y = await frame.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().top, sel);
      await scrollFrameTo(page, fw === 420 ? y - 60 : y + 120); await sleep(400);   // wide: past the header, which follows; narrow: the Sort by row in view (it does not stick)
      const before = await frame.evaluate(() => document.getElementById('audit-events-status').textContent);
      if (fw === 420) await frame.evaluate(() => { const s = document.getElementById('ae-sort'); s.value = 'latency'; s.dispatchEvent(new Event('change')); });
      else await frame.evaluate(() => document.querySelector('#audit-events-head .lc-sort[data-sort="latency"]').click());
      await sleep(600);
      const w1 = await frame.evaluate(busyProbe); const pw = await paneBox(page);
      await page.screenshot({ path: path.join(OUT, `audit-busy-${fw}-${theme}.png`), clip: { x: pw.left, y: pw.top, width: pw.right - pw.left, height: pw.bottom - pw.top } }); console.log(`  screenshot: ${path.join(OUT, `audit-busy-${fw}-${theme}.png`)}`);
      const barOk = fw === 420 ? (w1.headDisplay === 'none' && w1.narrowBar.h === '2px' && w1.narrowBar.bg !== 'rgba(0, 0, 0, 0)' && inView(pw, w1.narrowTop)) : (w1.headBar.h === '2px' && w1.headBar.bg !== 'rgba(0, 0, 0, 0)' && inView(pw, w1.headTop) && w1.loading.includes('latency'));
      check(`${theme}: at ${fw} px the busy state is in view while scrolled to the table: ${fw === 420 ? 'the progress bar and spinner on the "Sort by" row (the header hidden)' : 'the progress bar on the header and the spinner on the clicked column'}, the pill inside the pane`,
        barOk && w1.busy === 'true' && !w1.pill.hidden && inView(pw, w1.pill.top) && inView(pw, w1.pill.bottom) && (w1.pill.bottom + pw.frameTop) <= pw.bottom, JSON.stringify({ w1, pw }).slice(0, 1000));
      await settled(frame, 'audit-events-status', before); await sleep(300);
    }
    searchDelay = 0;
    await frameWidth(page, 1360);
    await frame.evaluate(async () => { const s = document.getElementById('ae-sort'); s.value = 'time'; s.dispatchEvent(new Event('change')); });
    await settled(frame, 'audit-events-status', ''); await sleep(200);

    // What changed: the Changes category, chips, a diff, the changed-field filter and a change-type pick
    const chg = await frame.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const status = document.getElementById('audit-events-status');
      const rows = () => Array.from(document.querySelectorAll('#audit-events-list .au-ev'));
      const settle = async (before) => { for (let i = 0; i < 240; i++) { if (!status.classList.contains('ui-busy') && status.textContent !== before && !/^(Searching|Loading)/.test(status.textContent)) return; await wait(250); } };
      const chips = () => Array.from(document.querySelectorAll('#audit-events-chips .au-chip')).map((c) => c.dataset.filter + '=' + c.dataset.value);
      const pick = async (id, v) => { const b = status.textContent; const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change')); await settle(b); };
      const removeChip = async (field, value) => { const b = status.textContent; const c = Array.from(document.querySelectorAll('#audit-events-chips .au-chip')).find((x) => x.dataset.filter === field && (value === undefined || x.dataset.value === value)); if (!c) return false; c.click(); await settle(b); return true; };
      const out = {};
      await pick('ae-category', 'changes');
      out.changes = { status: status.textContent, rows: rows().length, withChips: rows().filter((r) => r.querySelector('summary .au-hl')).length, chips: chips() };
      const imgRow = rows().find((r) => Array.from(r.querySelectorAll('summary .au-hl')).some((c) => c.textContent === 'image → 1.5.0'));
      if (imgRow) { imgRow.open = true; out.diff = Array.from(imgRow.querySelectorAll('.au-diff tbody tr')).map((tr) => Array.from(tr.children).map((td) => td.textContent)); out.oldKnown = !imgRow.textContent.includes('old values are unknown'); }
      let before = status.textContent; document.getElementById('ae-field').value = 'spec.replicas'; document.getElementById('ae-search').click(); await settle(before);
      out.field = { status: status.textContent, rows: rows().length, chips: chips(), allReplicas: rows().length > 0 && rows().every((r) => Array.from(r.querySelectorAll('summary .au-hl')).some((c) => /replicas/.test(c.textContent))) };
      await removeChip('changed_field');
      await pick('ae-ctype', 'rbac');
      out.ctype = { status: status.textContent, rows: rows().length, allRbac: rows().length > 0 && rows().every((r) => Array.from(r.querySelectorAll('summary .au-hl')).some((c) => /rule|bound|binding/.test(c.textContent))), chips: chips() };
      await removeChip('change_types'); await removeChip('category');
      out.end = status.textContent;
      return out;
    });
    check(`${theme}: the Changes category lists the successful writes with bodies ("${chg.changes.status}"), chips on every row; the story deployment's image bump opens to its field diff (old 1.4.0, new 1.5.0, the old value known from an earlier write in the same search)`,
      /^Changes: \d+ match/.test(chg.changes.status) && chg.changes.rows > 50 && chg.changes.withChips === chg.changes.rows && chg.changes.chips.join() === 'category=changes' && Array.isArray(chg.diff) && chg.diff.some((r) => /image$/.test(r[0]) && /1\.4\.0/.test(r[1]) && /1\.5\.0/.test(r[2])) && chg.oldKnown, JSON.stringify({ c: chg.changes, diff: chg.diff }));
    check(`${theme}: the changed-field filter (spec.replicas) keeps only writes that changed it (a tag); the rbac change-type pick only RBAC changes (a tag); clearing restores the whole capture`,
      chg.field.allReplicas && chg.field.chips.slice().sort().join() === 'category=changes,changed_field=spec.replicas' && /^Changes: \d+ match/.test(chg.field.status) && chg.ctype.allRbac && chg.ctype.chips.slice().sort().join() === 'category=changes,change_types=rbac' && /^Events: 3,048 match/.test(chg.end), JSON.stringify({ field: chg.field, ctype: chg.ctype, end: chg.end }));
    await complete(page, frame, 'the Audit page', theme, html.audit, errors, consoleErrors);
    await page.screenshot({ path: path.join(OUT, `audit-${theme}.png`) }); console.log(`  screenshot: ${path.join(OUT, `audit-${theme}.png`)}`);
    await widths(page, frame, 'audit', theme);
    // the narrow and wide shots: a namespace plus a one-minute range (the user's own filter), the Forbidden status, the Impersonation and Changes categories
    const views = [
      ['audit-latency', async () => { Array.from(document.querySelectorAll('#audit-events-chips .au-chip')).forEach((c) => c.click()); await new Promise((r) => setTimeout(r, 1500)); document.querySelector('#audit-events-head button[data-sort="latency"]').click(); }],
      ['audit-minute', async () => { document.getElementById('ae-namespace').value = 'demo-app'; document.getElementById('ae-search').click(); await new Promise((r) => setTimeout(r, 1500)); const hc = window.auEvents.charts['audit-events-hist']; const pts = hc.getDatasetMeta(0).data; const idx = pts.findIndex((p) => p && p.height !== 0); const hr = hc.canvas.getBoundingClientRect(); const pt = pts[idx]; hc.canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: hr.left + pt.x, clientY: hr.top + hc.chartArea.bottom - 2 })); }],
      ['audit-forbidden', async () => { Array.from(document.querySelectorAll('#audit-events-chips .au-chip')).forEach((c) => c.click()); await new Promise((r) => setTimeout(r, 1500)); const s = document.getElementById('ae-status'); s.value = '403'; s.dispatchEvent(new Event('change')); }],
      ['audit-impersonation', async () => { Array.from(document.querySelectorAll('#audit-events-chips .au-chip')).forEach((c) => c.click()); await new Promise((r) => setTimeout(r, 1500)); const s = document.getElementById('ae-category'); s.value = 'impersonation'; s.dispatchEvent(new Event('change')); }],
      ['audit-changes', async () => { Array.from(document.querySelectorAll('#audit-events-chips .au-chip')).forEach((c) => c.click()); await new Promise((r) => setTimeout(r, 1500)); const s = document.getElementById('ae-category'); s.value = 'changes'; s.dispatchEvent(new Event('change')); }],
    ];
    for (const [label, apply] of views) {
      const before = await frame.evaluate(() => document.getElementById('audit-events-status').textContent);
      await frame.evaluate(apply);
      await settled(frame, 'audit-events-status', before);
      await frame.evaluate(() => { const r = document.querySelector('#audit-events-list .au-ev'); if (r) r.open = true; });
      await widths(page, frame, label, theme);
    }

    // The two-window must-gather (Default profile): the broken axis of the histogram after five theme toggles, the pixels under the bars, the body filters disabled
    await context.close();
    ({ context, page } = await open(theme));
    await clickButton(page, 'Tools'); await sleep(400); await clickButton(page, 'Diagnostics');
    const openedGap = await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name)); if (!b) return false; b.click(); return true; }, GAP_NAME, { timeout: 20000 }).then(() => true).catch(() => false);
    check(`${theme}: the two-window must-gather opens`, openedGap);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).some((s) => s.textContent.trim() === 'Audit'), null, { timeout: 20000 }).catch(() => {});
    await clickSidebarSpan(page, 'Audit');
    frame = await diagnosticsFrame(page, '#audit-events');
    check(`${theme}: the two-window Audit page rendered and searched`, !!frame && await loaded(frame, '#audit-events'));
    if (frame) {
      await sleep(800);
      for (let i = 0; i < 5; i++) { await page.evaluate(() => document.documentElement.classList.toggle('dark')); await sleep(350); }
      await sleep(600);
      const gap = await frame.evaluate(() => {
        const c = window.auEvents.charts['audit-events-hist'];
        if (!c) return { missing: true };
        const ca = c.chartArea, ds = c.data.datasets[0], xs = c.scales.x;
        // the windows: the bars on either side of the break (a bar chart holds no null point)
        const bars = c.getDatasetMeta(0).data;
        const wins = []; let cur = null;
        bars.forEach((bar, i) => { if (c.$gaps.some((g) => bar.x > g.x0 && bar.x < g.x1)) { cur = null; return; } if (cur && c.$gaps.some((g) => cur.x1 < g.x0 && bar.x > g.x1)) cur = null; if (!cur) { cur = { x0: bar.x - bar.width / 2, x1: bar.x + bar.width / 2 }; wins.push(cur); } cur.x1 = bar.x + bar.width / 2; });
        const tallest = (w) => { let best = null; c.getDatasetMeta(0).data.forEach((bar, i) => { const p = ds.data[i]; if (!p || p.y === null) return; if (bar.x >= w.x0 - 1 && bar.x <= w.x1 + 1 && (!best || p.y > best.y)) best = { x: bar.x, y: p.y, base: bar.base, top: bar.y }; }); return best; };
        const samples = wins.map((w) => { const t = tallest(w); return t ? Array.from(c.ctx.getImageData(Math.round(t.x), Math.round((t.base + t.top) / 2), 1, 1).data) : [0, 0, 0, 0]; });
        const codes = window.auEvents.charts['audit-events-codes'];
        const bar = codes ? Array.from(codes.ctx.getImageData(Math.round(codes.chartArea.left + 6), Math.round(codes.getDatasetMeta(0).data[0].y), 1, 1).data) : [0, 0, 0, 0];
        const inBreak = c.getDatasetMeta(0).data.filter((bar) => c.$gaps.some((g) => bar.x > g.x0 && bar.x < g.x1)).length;
        return { gaps: c.$gaps, width: ca.width, windows: wins.map((w) => w.x1 - w.x0), ticks: xs.ticks.map((t) => t.label), nulls: ds.data.filter((p) => p.y === null).length, inBreak, samples, bar, dark: document.documentElement.classList.contains('dark'),
          note: document.getElementById('audit-events-hist-note').textContent, status: document.getElementById('audit-events-status').textContent, step: document.getElementById('audit-events-hist-step').textContent,
          disabled: Array.from(document.querySelectorAll('#audit-events-bodyfilters [disabled], #ae-category option[disabled]')).map((e) => e.id || e.value), tips: Array.from(document.querySelectorAll('#audit-events-bodyfilters [title], #ae-category option[title]')).map((e) => e.title) };
      });
      const breakW = gap.gaps && gap.gaps.length === 1 ? gap.gaps[0].x1 - gap.gaps[0].x0 : -1;
      check(`${theme}: the two capture windows a day apart draw on a broken axis: one ${Math.round(breakW)} px break labelled "no events for 24 h 3 min", each window at least 30% of the plot, no bar inside the break, the date on each window's first tick, the gap note with the exact from / to; "Events: 3,625 match", per 1 min over the active time`,
        breakW >= 20 && breakW <= 40 && /no events for 24 h 3 min/.test(gap.gaps[0].label) && gap.windows.length === 2 && gap.windows.every((w) => w >= 0.3 * gap.width) && gap.nulls === 0 && gap.inBreak === 0 && gap.ticks[0] === '10-12 12:40' && gap.ticks.includes('10-13 14:40') && /no events for 24 h 3 min \(2026-10-12 14:37 → 2026-10-13 14:40\)/.test(gap.note) && /^Events: 3,625 match/.test(gap.status) && /per 1 min/.test(gap.step), JSON.stringify({ gaps: gap.gaps, windows: gap.windows, width: gap.width, ticks: gap.ticks, nulls: gap.nulls, inBreak: gap.inBreak, note: gap.note, status: gap.status }));
      const blue = (p) => p[3] > 0 && p[2] > p[0] && (p[0] + p[1] + p[2]) > 60;
      check(`${theme}: after five theme toggles (now ${gap.dark ? 'dark' : 'light'}) the histogram's bars are the accent blue in both windows and the status bar keeps its colour (no black fill)`,
        gap.samples.length === 2 && gap.samples.every(blue) && gap.bar[3] === 255 && (gap.bar[0] + gap.bar[1] + gap.bar[2]) > 60, JSON.stringify({ samples: gap.samples, bar: gap.bar }));
      check(`${theme}: with no request bodies the body filters (has body, changed field, the change-type picker) and the Changes category are disabled with the tooltip "No request bodies recorded in these audit logs"`,
        gap.disabled.slice().sort().join() === 'ae-ctype,ae-field,ae-hasbody,changes' && gap.tips.length >= 3 && gap.tips.every((t) => t === 'No request bodies recorded in these audit logs'), JSON.stringify({ disabled: gap.disabled, tips: gap.tips.slice(0, 4) }));
      await page.screenshot({ path: path.join(OUT, `audit-gap-after-toggles-${gap.dark ? 'dark' : 'light'}.png`) }); console.log(`  screenshot: ${path.join(OUT, `audit-gap-after-toggles-${gap.dark ? 'dark' : 'light'}.png`)}`);
      for (let i = 0; i < 5; i++) { await page.evaluate(() => document.documentElement.classList.toggle('dark')); await sleep(350); }
      await widths(page, frame, 'audit-default-profile', theme);
    }
    await context.close();
  }
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
