#!/usr/bin/env node
/**
 * The kernel diagnostics tabs (Stack Traces, Hung Tasks, OOM Killer:
 * backend/templates/tabs/sosreport_kernel_*.html, styled by
 * tabs/_kernel_diag.html) inside the REAL app's diagnostics frame.
 *
 * THE REWORK: the old tabs were built from Tailwind utilities the frame
 * does not compile (a four-column grid with no min-width, grey colours)
 * and Font Awesome icons: the facts overlapped ("File:" drawn over
 * "Kernel:"), the Code bytes and the call trace sat in the UI font, the
 * file path was a link to nowhere, there was no summary, no grouping, no
 * filter, no copy. Now every tab is an incident board: a summary strip
 * (counts by type, first/last, a per-day/hour bar strip, offender chips),
 * a filter row and collapsible rows with a facts list that wraps, a
 * monospace stack with the faulting frame marked and "?" frames muted,
 * the raw lines and a Copy button. Coloured left accents are SQUARE on
 * the accent side; ordinary cards, chips and buttons keep the token radius.
 *
 * Static: the templates carry no utility class the frame lacks, no Font
 * Awesome icon, no |safe, and keep the ids the drivers use (oom-filter,
 * oom-blocks, oom-entry).
 *
 * Live (Vite from this checkout + playwright-core's Chromium; the backend
 * calls on localhost:8080 are answered by routes from HTML rendered by
 * tests/helpers/kernel-tabs/render.py with the backend venv over the
 * synthetic diagnostics mock, so the user's own app on :8080 is never
 * touched): in dark and light, each tab renders in the frame, nothing in
 * the strip, the row titles or the facts overflows its box, the stack is
 * monospace, "?" frames are muted, the faulting byte <0f> is highlighted,
 * the accent rows have square left corners and round right ones while
 * buttons and the strip keep the token radius, the filter narrows the
 * list and reports "N of M shown", the Copy button exists for every
 * expanded row, and at 420 px the frame has no horizontal scroll.
 * Screenshots of every state go to KT_OUT (or a temp dir).
 *
 * SKIPS (exit 0) without playwright-core / Chromium, without backend/venv
 * or python3, or with SKIP_BROWSER_TESTS set.
 * Run: node tests/kernel-tabs-frame.test.mjs
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
const TABS = ['kernel_stack_traces', 'kernel_hung_task', 'kernel_oom_killer'];
const LABELS = { kernel_stack_traces: 'Stack Traces', kernel_hung_task: 'Hung Tasks', kernel_oom_killer: 'OOM Killer' };

// ---- static ----
{
  const dir = path.join(REPO, 'backend', 'templates', 'tabs');
  for (const name of ['sosreport_kernel_stack_traces.html', 'sosreport_kernel_hung_task.html', 'sosreport_kernel_oom_killer.html', '_kernel_diag.html', '_kernel_diag_macros.html']) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    const utilities = ['grid-cols-', 'col-span-', 'bg-gray-', 'text-gray-', 'md:', 'whitespace-pre-wrap', 'shadow-md', 'space-y-'].filter((c) => src.includes(c));
    check(`${name}: no utility class the frame does not compile, no Font Awesome, no |safe, no &nbsp;`, utilities.length === 0 && !src.includes('class="fas') && !/\|\s*safe/.test(src) && !src.includes('&nbsp;'), utilities.join(','));
  }
  const oom = fs.readFileSync(path.join(dir, 'sosreport_kernel_oom_killer.html'), 'utf8');
  check('the OOM tab keeps the ids the drivers use (oom-filter, oom-blocks, oom-entry)', /id="oom-filter"/.test(oom) && /id="oom-blocks"/.test(oom) && /oom-entry/.test(oom));
  const css = fs.readFileSync(path.join(dir, '_kernel_diag.html'), 'utf8');
  check('the accent rows are square on the accent side (border-radius 0 <r> <r> 0) and the stack is a monospace <pre> that scrolls sideways', /\.kd-row \{[^}]*border-radius: 0 var\(--radius-sm[^}]*\}/.test(css) && /\.kd-stack \{[^}]*overflow-x: auto[^}]*white-space: pre/.test(css));
  check('the script never builds HTML from report text (no innerHTML / insertAdjacentHTML / document.write)', !/innerHTML|insertAdjacentHTML|document\.write/.test(css));
}

// ---- live ----
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(failed ? 1 : 0); }
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
const OUT = process.env.KT_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-tabs-frame-'));
fs.mkdirSync(OUT, { recursive: true });
let HTML_DIR = process.env.KT_HTML_DIR;
if (!HTML_DIR) {
  if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot render the tabs'); process.exit(failed ? 1 : 0); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-tabs-fixture-'));
  const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
  if (gen.status !== 0) { console.log('SKIP: could not build the synthetic diagnostics fixture: ' + (gen.stderr || '').slice(0, 200)); process.exit(failed ? 1 : 0); }
  const fixture = path.join(work, 'sosreport-web-01-2026-10-13-abcdef');
  HTML_DIR = path.join(work, 'html');
  const ren = spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'kernel-tabs', 'render.py'), '--out', HTML_DIR, '--fixture', fixture], { encoding: 'utf8' });
  check('the three tabs render through Flask over the synthetic report', ren.status === 0, (ren.stderr || '').slice(-300));
  if (ren.status !== 0) process.exit(1);
}
const REPORT = { name: 'sosreport-web-01-2026-10-13-abcdef', path: '/tmp/kernel-tabs-frame/sosreport-web-01-2026-10-13-abcdef', type: 'sosreport', modified: 1760000000 };
const tabs = JSON.parse(fs.readFileSync(path.join(HTML_DIR, 'tabs.json'), 'utf8'));
const html = Object.fromEntries(TABS.map((t) => [t, fs.readFileSync(path.join(HTML_DIR, `${t}.html`), 'utf8')]));
const isNew = html.kernel_stack_traces.includes('class="panel rounded-lg shadow-sm kd"');  // KT_HTML_DIR may hold the OLD templates (before/after shots)

const PORT = Number(process.env.SMOKE_PORT || 5307);
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
      localStorage.setItem('diagnosticsReportsDirectory', '/tmp/kernel-tabs-frame');
      localStorage.removeItem('diagnostics-page-session');
    } catch { /* storage off */ }
  }, { theme });
  // the catch-alls first: playwright matches the LAST registered route first
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
  page.on('pageerror', (e) => console.log('pageerror', String(e.message).slice(0, 160)));
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
  return { context, page };
}

const clickButton = (page, label) => page.evaluate((label) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === label); if (!b) return false; b.click(); return true; }, label);
const clickSidebarSpan = (page, label) => page.evaluate((label) => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === label); if (!s) return false; s.closest('div.cursor-pointer').click(); return true; }, label);

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
    const { context, page } = await open(theme);
    await clickButton(page, 'Tools'); await sleep(400);
    check(`${theme}: the Diagnostics page opens`, await clickButton(page, 'Diagnostics'));
    const opened = await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name)); if (!b) return false; b.click(); return true; }, REPORT.name, { timeout: 20000 }).then(() => true).catch(() => false);
    check(`${theme}: the synthetic report is listed and opens`, opened);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('div.cursor-pointer span')).some((s) => s.textContent.trim() === 'Kernel'), null, { timeout: 20000 }).catch(() => {});
    check(`${theme}: the Kernel tab is listed`, await clickSidebarSpan(page, 'Kernel'));
    await sleep(600);
    // the sub-tabs only render once the parent is expanded (its chevron button)
    const expandedKernel = await page.evaluate(() => {
      const span = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === 'Kernel');
      const row = span && span.closest('div.cursor-pointer').parentElement;
      const btn = row && row.querySelector('button[title="Expand"]');
      if (btn) { btn.click(); return 'expanded'; }
      return row && row.querySelector('button[title="Collapse"]') ? 'already' : 'no chevron';
    });
    check(`${theme}: the Kernel tab expands its sub-tabs`, expandedKernel === 'expanded' || expandedKernel === 'already', expandedKernel);
    await sleep(400);
    for (const tab of TABS) {
      const label = LABELS[tab];
      check(`${theme}: ${label} sub-tab clicked`, await clickSidebarSpan(page, label));
      const frame = await diagnosticsFrame(page, '.panel');
      check(`${theme}: ${label} rendered in the diagnostics frame`, !!frame);
      if (!frame) continue;
      await sleep(900);
      const iframe = await page.$('iframe[title="Diagnostics content"]');
      // An element shot of the out-of-process frame only paints what is
      // inside the viewport, so the viewport grows to the frame's content
      // height for the frame shots (and shrinks back after).
      const shot = async (name, el) => {
        const file = path.join(OUT, `${tab}-${theme}-${name}.png`);
        if (el) {
          const h = await frame.evaluate(() => document.body.scrollHeight);
          await page.setViewportSize({ width: 1360, height: Math.min(6000, h + 140) });
          await sleep(700);
          await el.screenshot({ path: file });
          await page.setViewportSize({ width: 1360, height: 900 });
          await sleep(300);
        } else {
          await page.screenshot({ path: file });
        }
        console.log(`  screenshot: ${file}`);
      };
      await shot('collapsed');
      const expanded = await frame.evaluate(() => { const d = document.querySelector('details.kd-row, details'); if (!d) return false; d.open = true; return true; });
      await sleep(700);
      await shot('expanded', iframe);
      if (isNew) {
        check(`${theme}: ${label}: the first row expands`, expanded);
        const probe = await frame.evaluate(() => {
          const r = (el) => el.getBoundingClientRect();
          const cs = (el) => getComputedStyle(el);
          const over = [];
          document.querySelectorAll('.kd-row[open] .kd-facts dd, .kd-row-title, .kd-strip, .kd-stat-value').forEach((el) => { if (el.scrollWidth > el.clientWidth + 1) over.push(el.className + ':' + el.scrollWidth + '>' + el.clientWidth); });
          const stack = document.querySelector('.kd-row[open] .kd-stack');
          const unreliable = document.querySelector('.kd-row[open] .kd-frame-unreliable');
          const fault = document.querySelector('.kd-row[open] .kd-frame-fault');
          const codeFault = document.querySelector('.kd-row[open] .kd-code-fault');
          const row = document.querySelector('.kd-row');
          const rowCs = cs(row);
          const btn = document.querySelector('.kd-btn');
          const strip = document.querySelector('.kd-strip');
          const tag = document.querySelector('.kd-tag');
          const accents = [...document.querySelectorAll('.kd-row, .kd-note')].map((el) => ({ cls: el.className.split(' ')[0], tl: cs(el).borderTopLeftRadius, bl: cs(el).borderBottomLeftRadius, tr: cs(el).borderTopRightRadius, left: cs(el).borderLeftWidth, leftColor: cs(el).borderLeftColor, rightColor: cs(el).borderRightColor }));
          return {
            over, mono: stack ? cs(stack).fontFamily : '', stackWrap: stack ? cs(stack).whiteSpace : '', stackOverflow: stack ? cs(stack).overflowX : '',
            muted: unreliable ? cs(unreliable).opacity : '', faultWeight: fault ? cs(fault).fontWeight : '', codeFault: codeFault ? codeFault.textContent : '',
            codeFaultBg: codeFault ? cs(codeFault).backgroundColor : '',
            accents, rowLeftColor: rowCs.borderLeftColor, rowRightColor: rowCs.borderRightColor,
            btnRadius: btn ? cs(btn).borderRadius : '', stripRadius: strip ? cs(strip).borderRadius : '', tagRadius: tag ? cs(tag).borderRadius : '',
            frameW: document.documentElement.clientWidth, stripW: strip ? r(strip).width : 0,
            selectBgs: Array.from(document.querySelectorAll('.kd-select')).map((el) => getComputedStyle(el).backgroundImage),
            rows: document.querySelectorAll('.kd-row').length, copy: document.querySelectorAll('.kd-row[open] .kd-copy').length, shown: (document.querySelector('.kd-shown') || {}).textContent,
          };
        });
        check(`${theme}: ${label}: no fact, title, stat or strip overflows its box`, probe.over.length === 0, probe.over.join(', '));
        check(`${theme}: ${label}: the stack is a monospace block that keeps its lines and scrolls sideways`, /mono|Consolas/i.test(probe.mono) && probe.stackWrap === 'pre' && probe.stackOverflow === 'auto', JSON.stringify({ mono: probe.mono, wrap: probe.stackWrap, ov: probe.stackOverflow }));
        if (tab !== 'kernel_oom_killer') {
          check(`${theme}: ${label}: "?" frames are muted and the marked frame is bold`, probe.muted !== '' && Number(probe.muted) <= 0.6 && Number(probe.faultWeight) >= 600, JSON.stringify({ muted: probe.muted, weight: probe.faultWeight }));
        }
        if (tab === 'kernel_stack_traces') {
          check(`${theme}: the faulting byte <0f> is highlighted in the Code line`, probe.codeFault === '<0f>' && probe.codeFaultBg !== 'rgba(0, 0, 0, 0)', JSON.stringify({ t: probe.codeFault, bg: probe.codeFaultBg }));
        }
        check(`${theme}: ${label}: every coloured left accent is square on its left corners and keeps the token radius on the right`,
          probe.accents.length > 0 && probe.accents.every((a) => a.tl === '0px' && a.bl === '0px' && a.tr !== '0px' && parseFloat(a.left) >= 3 && a.leftColor !== a.rightColor), JSON.stringify(probe.accents.slice(0, 3)));
        check(`${theme}: ${label}: buttons, the strip and the tags keep the app's rounded corners`, probe.btnRadius === '8px' && probe.stripRadius === '8px' && probe.tagRadius === '6px', JSON.stringify({ btn: probe.btnRadius, strip: probe.stripRadius, tag: probe.tagRadius }));
        check(`${theme}: ${label}: each dropdown draws one chevron (no frame arrow under the kd icon)`, probe.selectBgs.length > 0 && probe.selectBgs.every((b) => b === 'none'), JSON.stringify(probe.selectBgs));
        check(`${theme}: ${label}: a Copy button in the expanded row and the shown count`, probe.copy >= 1 && /shown/.test(probe.shown || ''), JSON.stringify({ copy: probe.copy, shown: probe.shown }));
        // the filter: a term that matches one row only
        const filtered = await frame.evaluate(async (term) => {
          const input = document.querySelector('.kd-search');
          input.value = term; input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          const rows = [...document.querySelectorAll('.kd-row')];
          const visible = rows.filter((r) => !r.hidden).length;
          input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          return { visible, total: rows.length, shown: document.querySelector('.kd-shown').textContent, after: rows.filter((r) => !r.hidden).length };
        }, { kernel_stack_traces: 'rcu_sched', kernel_hung_task: 'jbd2', kernel_oom_killer: 'payments-api' }[tab]);
        check(`${theme}: ${label}: the search narrows the list to the matching row and says "1 of N shown", clearing restores it`, filtered.visible === 1 && filtered.total > 1 && filtered.after === filtered.total, JSON.stringify(filtered));
      }
      // narrow: the frame at 420 px
      await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.dataset.w = f.style.width; f.style.width = '420px'; });
      await sleep(900);
      await shot('narrow-420', iframe);
      if (isNew) {
        const narrow = await frame.evaluate(() => { const w = document.documentElement.clientWidth; const over = []; document.querySelectorAll('.kd-strip, .kd-row, .kd-facts, .kd-filters').forEach((el) => { if (el.getBoundingClientRect().right > w + 1) over.push(el.className.split(' ')[0]); }); return { w, pageOver: document.documentElement.scrollWidth > w + 1, over }; });
        check(`${theme}: ${label}: at ${narrow.w}px no horizontal page scroll and no block past the edge`, !narrow.pageOver && narrow.over.length === 0 && narrow.w <= 430, JSON.stringify(narrow));
      }
      await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w || ''; });
      await sleep(300);
    }
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message)));
    await context.close();
  }
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
