#!/usr/bin/env node
/*
 * The must-gather detail pages on the shared component (backend/static/diagnostics-ui.js diagDetail + diagCode,
 * backend/templates/tabs/_detail.html, _ui.html detail_page()).
 *
 * Static: every must-gather template with a detail imports the shared include, registers its list with
 * diagDetail and carries no JSON regex highlighter, panel toggling or "Back" scroll code of its own; the frame
 * inlines highlight.js (json + yaml) and js-yaml; the stylesheet has the detail and code-viewer rules.
 *
 * Browser (the app in Vite, playwright-core, the synthetic must-gather rendered through Flask like
 * diagnostics-ui-consistency.test.mjs): the Pods page's row for the planted CrashLoopBackOff pod opens its detail -
 * the bar (Back, the breadcrumb, the status badge, the quick actions, Previous / Next), the title, the pod's own
 * Findings, every section, the page's strip and list hidden, the pane scrolled to the detail's top; the JSON viewer
 * (opened on request): the exact JSON text (the round trip: the viewer's text is JSON.stringify of the object,
 * and parses back to it; on the YAML toggle js-yaml reads it back to the same object), line numbers, the search
 * marks every match, counts them and walks them with Next / Previous and Enter, "Filter lines" keeps only the
 * matching lines, metadata.managedFields folded from the start and unfolded on its chevron, the key click copies
 * the path; the TLS secret's data masked with Reveal and the copy text masked too; Back returns the list at the
 * same scroll position with the row highlighted and focused; Escape goes back; the cross-link query
 * "detail=<key>" opens a detail; no horizontal overflow at 360, 420, 1010, 1360 and 1920 on the Pod, Node and
 * Deployment details; dark and light screenshots of the three at 1360 (DETAIL_OUT).
 *
 *   node tests/diagnostics-detail-pages.test.mjs        env: SMOKE_PORT, DETAIL_OUT, SKIP_BROWSER_TESTS=1 (static only)
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
const TABS_DIR = path.join(REPO, 'backend', 'templates', 'tabs');

// ---------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------
{
  const ui = read('backend/static/diagnostics-ui.js');
  check('diagnostics-ui.js defines diagDetail (register / open / back / header / findings / section / kv / cards / table / masked) and diagCode (render / text)',
    /window\.diagDetail = \{ register: register, open: openKey, back:/.test(ui) && /window\.diagCode = \{ render: render, text:/.test(ui) && /function cards\(/.test(ui) && /function masked\(/.test(ui));
  check('diagLinks hands a "detail=<key>" query to diagDetail before the search field', /if \(window\.diagDetail && window\.diagDetail\.applyQuery\(q\)\) return true;/.test(ui));
  check('diagCode shows JSON by default, offers the YAML toggle, folds metadata.managedFields, masks secret-ish keys and a Secret\'s data',
    /opts\.format === 'yaml' \? 'yaml' : 'json'/.test(ui) && /data-format/.test(ui) && /'metadata\.managedFields'/.test(ui) && /opts\.kind === 'Secret'/.test(ui) && /MASKED_VALUE_/.test(ui));
  const css = read('backend/static/styles.css');
  for (const cls of ['.ui-detail-bar', '.ui-detail-crumbs', '.ui-detail-title', '.ui-detail-section', '.ui-detail-cards', '.ui-code-view', '.ui-code-bar', '.ui-code-line', '.ui-code-mark', '.ui-code-current', '.ui-code-fold', '.ui-masked-dots', 'tr.ui-row-hl']) check(`styles.css styles ${cls}`, css.includes(cls));
  check('the code viewer colours highlight.js tokens from the theme tokens (no highlight.js stylesheet)', /\.ui-code-view \.hljs-attr \{ color: var\(--link/.test(css) && !/highlight\.js\/styles/.test(read('src/components/DiagnosticsPage.jsx')));
  check('_ui.html has the detail_page() macro with the bar, the title, the findings slot and the body', /macro detail_page\(id, back='Back'\)/.test(read('backend/templates/tabs/_ui.html')) && /data-detail-back/.test(read('backend/templates/tabs/_ui.html')) && /ui-detail-findings/.test(read('backend/templates/tabs/_ui.html')));
  check('_detail.html carries the shared sections (conditions, events, containers, ownership, code, page)', /window\.k8sDetail = \{ page: page, ownerLink: ownerLink/.test(read('backend/templates/tabs/_detail.html')));
  const DETAIL_TEMPLATES = ['mustgather_pod', 'mustgather_nodes', 'mustgather_deployment', 'mustgather_events', 'mustgather_daemonset', 'mustgather_statefulset', 'mustgather_replicaset', 'mustgather_pdb', 'mustgather_mcp', 'mustgather_csr', 'mustgather_tls_secrets', 'mustgather_alerts', 'mustgather_system'];
  const wrong = [];
  for (const t of DETAIL_TEMPLATES) {
    const src = fs.readFileSync(path.join(TABS_DIR, t + '.html'), 'utf8');
    if (!/\{% import "tabs\/_detail\.html" as detail %\}/.test(src)) wrong.push(t + ': no _detail import');
    if (!/ui\.detail_page\('/.test(src)) wrong.push(t + ': no detail_page()');
    if (!/detail\.k8s_detail_script\(\)/.test(src)) wrong.push(t + ': no shared script');
    if (!/D\.register\(/.test(src) && !/diagDetail\.register\(/.test(src)) wrong.push(t + ': no diagDetail.register');
    if (!/data-detail/.test(src)) wrong.push(t + ': rows without data-detail');
  }
  check(`every must-gather detail page (${DETAIL_TEMPLATES.length}) is on the shared component`, wrong.length === 0, wrong.join(', '));
  const leftovers = [];
  for (const f of fs.readdirSync(TABS_DIR)) {
    if (!f.endsWith('.html')) continue;
    const src = fs.readFileSync(path.join(TABS_DIR, f), 'utf8');
    for (const [name, re] of [['highlightJSON', /function highlightJSON|highlightJSON\(/], ['renderJSONWithoutHighlight', /renderJSONWithoutHighlight/], ['a panel toggled by style.display', /DetailsPanel\.style|Panel\.style\.(setProperty|display)/], ['the old Back scroll (lastClickedRow)', /lastClickedRow/], ['a "Filter YAML lines" box', /Filter (YAML|JSON) lines/], ['findScrollableParent', /findScrollableParent/]]) {
      if (re.test(src)) leftovers.push(`${f}: ${name}`);
    }
  }
  check('no template keeps a JSON regex highlighter, a display-toggled panel, a Back scroll of its own or a "Filter YAML lines" box (the gaps bug lived in the regex highlighter)', leftovers.length === 0, leftovers.join(', '));
  const yamlWords = [];
  for (const t of DETAIL_TEMPLATES) {
    const src = fs.readFileSync(path.join(TABS_DIR, t + '.html'), 'utf8');
    if (/\b(Pod|Node|Event|Secret|MCP|CSR|PDB|Alert|Operator|Deployment|Daemon Set|Stateful Set|Replica Set) YAML\b/.test(src) || /Copy YAML/.test(src)) yamlWords.push(t);
  }
  check('the headings and buttons say JSON (what the viewer shows by default), not YAML', yamlWords.length === 0, yamlWords.join(', '));
  const diag = read('src/components/DiagnosticsPage.jsx');
  check('the frame inlines js-yaml and asks the app to highlight (codeHighlight.js, the one highlight.js entry point, through the "/highlight" message)', /getDiagnosticsCodeScriptTags/.test(diag) && /js-yaml\/dist\/js-yaml\.min\.js\?raw/.test(diag) && /highlightCode\(text, language\)/.test(diag) && !/highlight\.js\/lib/.test(diag) && /diagnosticsApiRequest\('\/highlight'/.test(read('backend/static/diagnostics-ui.js')));
  check('the detail parsers exist (detail.py, managed_fields.py) and the pod / nodes / deployment parsers attach _detail', fs.existsSync(path.join(REPO, 'backend/parsers/mustgather/detail.py')) && fs.existsSync(path.join(REPO, 'backend/parsers/mustgather/managed_fields.py')) && /_detail'\] = detail\.pod_detail/.test(read('backend/parsers/mustgather/pod.py')) && /_detail'\] = detail\.node_detail/.test(read('backend/parsers/mustgather/nodes.py')) && /_detail'\] = detail\.deployment_detail/.test(read('backend/parsers/mustgather/deployment.py')));
}
if (process.env.SKIP_BROWSER_TESTS) { console.log(failed ? `\n${failed} check(s) failed` : '\nAll static checks passed (browser part skipped)'); process.exit(failed ? 1 : 0); }
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot render the tabs'); process.exit(failed ? 1 : 0); }
const OUT = process.env.DETAIL_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-detail-'));
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// The fixture: the synthetic must-gather, the four tabs rendered through Flask
// ---------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-detail-fixture-'));
const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
if (gen.status !== 0) { console.log('SKIP: could not build the synthetic diagnostics fixtures: ' + (gen.stderr || '').slice(0, 200)); process.exit(failed ? 1 : 0); }
const NAME = 'must-gather.local.1234567890';
const KEYS = ['pod', 'nodes', 'deployment', 'tls_secrets', 'log_viewer'];
const htmlDir = path.join(work, 'html');
const ren = spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', htmlDir, '--fixture', path.join(work, NAME), '--report-type', 'mustgather', '--tabs', ...KEYS], { encoding: 'utf8' });
check('the Pods, Nodes, Deployment and TLS Secrets tabs render through Flask over the synthetic must-gather', ren.status === 0, (ren.stderr || '').slice(-400));
if (ren.status !== 0) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
const report = { name: NAME, path: '/tmp/diagnostics-detail/' + NAME, type: 'mustgather', modified: 1760000000, html: Object.fromEntries(KEYS.map((k) => [k, fs.readFileSync(path.join(htmlDir, `${k}.html`), 'utf8')])), tabs: JSON.parse(fs.readFileSync(path.join(htmlDir, 'tabs.json'), 'utf8')) };
const CRASH = 'payments-demo/payments-worker-7b8c9d0e1-efghi';
function backend(route, body) {
  const tmp = path.join(OUT, `req-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(body));
  const out = spawnSync(PYTHON, ['-I', path.join(REPO, 'tests', 'helpers', 'diagnostics-api.py'), '--path', route, '--body-file', tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.unlinkSync(tmp);
  let parsed = { status: 500, json: { error: (out.stderr || '').slice(-300) } };
  try { parsed = JSON.parse(out.stdout); } catch { /* the error above */ }
  return parsed;
}

const PORT = Number(process.env.SMOKE_PORT || 5339);
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
    try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify(theme)); localStorage.setItem('diagnosticsReportsDirectory', '/tmp/diagnostics-detail'); localStorage.removeItem('diagnostics-page-session'); } catch { /* storage off */ }
  }, { theme });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.6', protocol: 2 } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
  await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
  await context.route('http://localhost:8080/list_reports', (r) => r.fulfill({ json: { reports: [{ name: report.name, path: report.path, type: report.type, modified: report.modified }] } }));
  await context.route('http://localhost:8080/get_tabs', (r) => r.fulfill({ json: { tabs: report.tabs, report_type: report.type, directory: report.path } }));
  await context.route('http://localhost:8080/get_tab_data', (r) => r.fulfill({ json: {} }));
  await context.route('http://localhost:8080/static/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: read('backend/static/styles.css') }));
  await context.route('http://localhost:8080/load_tab', async (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const key = body.sub_tab || body.tab; r.fulfill({ json: { html: report.html[key] || `<div class="panel rounded-lg shadow-sm"><p>${key} (not rendered)</p></div>` } }); });
  // the Log Viewer's backend (where Open logs lands): the real must-gather search over the synthetic gather, through
  // the Flask test client (the report's listed directory is a stand-in; the gather itself is under work/)
  await context.route('http://localhost:8080/mustgather_log_date_range', (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const a = backend('/mustgather_log_date_range', { ...body, directory: path.join(work, NAME) }); r.fulfill({ status: a.status, json: a.json }); });
  await context.route('http://localhost:8080/mustgather_log_search', (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const a = backend('/mustgather_log_search', { ...body, directory: path.join(work, NAME) }); r.fulfill({ status: a.status, json: a.json }); });
  await context.route('http://localhost:8080/mustgather_log_cancel', (r) => r.fulfill({ json: { ok: true } }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
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
const labelOf = (key) => { for (const t of report.tabs) { if (t.tab_name === key) return { group: null, label: t.label.trim() }; for (const s of t.sub_tabs || []) if (s.tab_name === key) return { group: t.label.trim(), label: s.label.trim() }; } return null; };
async function openTab(page, key) {
  const where = labelOf(key);
  if (where.group) { await expandGroup(page, where.group); await sleep(200); await clickSidebar(page, where.label, where.group); } else { await clickSidebar(page, where.label); }
  const frame = await frameFor(page, key);
  if (frame) await sleep(900);
  return frame;
}
async function frameWidth(page, fw) {
  await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); if (f.dataset.w === undefined) f.dataset.w = f.style.width; });
  if (fw >= 1360) { await page.setViewportSize({ width: fw, height: 1000 }); await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w; }); }
  else { await page.setViewportSize({ width: 1360, height: 1000 }); await page.evaluate((fw) => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = fw + 'px'; }, fw); }
  await sleep(600);
}
const resetWidth = async (page) => { await page.setViewportSize({ width: 1360, height: 900 }); await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w || ''; }); await sleep(300); };
// nothing in the detail reaches past the frame's right edge, except inside a scroll box of its own
const overflow = (frame) => frame.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [];
  const view = document.querySelector('.ui-detail:not([hidden])') || document.body;
  view.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    if (el.closest('svg') && el.tagName !== 'svg') return;
    if (r.right > w + 1) {
      let clip = null;
      for (let p = el.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) { clip = p; break; } }
      if (!clip || clip.getBoundingClientRect().right > w + 1) bad.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/)[0] : '') + ' right ' + Math.round(r.right));
    }
  });
  return { w, pageOver: document.documentElement.scrollWidth > w + 1, bad: bad.slice(0, 6) };
});
const state = (frame) => frame.evaluate(() => {
  const v = document.querySelector('.ui-detail:not([hidden])');
  if (!v) return { open: false };
  const r = v.getBoundingClientRect();
  return {
    open: true, top: r.top, title: v.querySelector('.ui-detail-title').textContent, crumbs: Array.from(v.querySelectorAll('.ui-detail-crumb')).map((c) => c.textContent), badge: v.querySelector('.ui-detail-badge').textContent.trim(),
    actions: Array.from(v.querySelectorAll('.ui-detail-actions button')).map((b) => b.textContent.trim()), pos: v.querySelector('.ui-detail-pos').textContent,
    links: Array.from(v.querySelectorAll('.ui-detail-actions button[data-tab]')).map((b) => [b.textContent.trim(), b.getAttribute('data-tab'), b.getAttribute('data-sub-tab') || '', b.getAttribute('data-query') || ''].join('|')),
    sections: Array.from(v.querySelectorAll('details.ui-detail-section > summary')).map((s) => s.textContent.trim()), findings: Array.from(v.querySelectorAll('.ui-finding-title')).map((f) => f.textContent),
    focused: document.activeElement === v.querySelector('.ui-detail-title'), stripHidden: Array.from(document.querySelectorAll('#diagnostics-content > .ui-findings, #diagnostics-content > .ui-note')).every((s) => s.hidden), listHidden: Array.from(document.querySelectorAll('#diagnostics-content > div[id]')).filter((d) => !d.classList.contains('ui-detail')).every((d) => d.hidden),
    viewport: window.diagnosticsViewport,
  };
});

try {
  for (const theme of ['dark', 'light']) {
    const { context, page, errors } = await open(theme);
    await clickButton(page, 'Tools'); await sleep(400); await clickButton(page, 'Diagnostics'); await sleep(600);
    const opened = await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name) && el.offsetParent); if (!b) return false; b.click(); return true; }, report.name, { timeout: 20000 }).then(() => true).catch(() => false);
    check(`${theme}: the must-gather report opens`, opened);
    await page.waitForFunction(() => document.querySelectorAll('div.cursor-pointer span').length > 3, null, { timeout: 20000 }).catch(() => {});
    await sleep(400);

    // ---- the Pod detail
    const frame = await openTab(page, 'pod');
    check(`${theme}: the Pods page renders`, !!frame);
    if (!frame) { await context.close(); continue; }
    // the list scrolled so the crash pod's row is in view, then the row clicked
    const before = await frame.evaluate((key) => {
      const row = document.querySelector(`tr[data-detail="${key}"]`); if (!row) return null;
      const y = row.getBoundingClientRect().top - 120; window.diagnosticsScrollTo(y); return { rowTop: row.getBoundingClientRect().top, asked: y };
    }, CRASH);
    await sleep(600);
    const savedTop = await frame.evaluate(() => window.diagnosticsViewport && window.diagnosticsViewport.top);
    // the pane scrolls as far as its content allows (the ask may be past the end): down the page, and no further than asked
    check(`${theme}: the list scrolled down to the crash pod's row before the click (pane top ${savedTop}, asked ${before && Math.round(before.asked)})`, before && savedTop !== null && savedTop > 200 && savedTop <= before.asked + 1, JSON.stringify({ before, savedTop }));
    await frame.evaluate((key) => { document.querySelector(`tr[data-detail="${key}"]`).click(); }, CRASH);
    await sleep(900);
    let s = await state(frame);
    check(`${theme}: the row opens the detail: the title, the breadcrumb Pods / namespace / name, the CrashLoopBackOff badge, the quick actions and Previous / Next`,
      s.open && s.title === 'payments-worker-7b8c9d0e1-efghi' && s.crumbs.join('/') === 'Pods/payments-demo/payments-worker-7b8c9d0e1-efghi' && s.badge === 'CrashLoopBackOff' && s.actions.join(',') === 'Copy name,Copy JSON,Open events,Open logs' && /^\d+ of \d+$/.test(s.pos), JSON.stringify(s).slice(0, 600));
    check(`${theme}: Open logs links to the Log Viewer with the pod's sources (sources=<ns>/<pod>), Open events to the Events page searched for the pod`, s.links.includes('Open logs|log_collection|log_viewer|sources=' + CRASH) && s.links.some((l) => l.startsWith('Open events|system|events|')), JSON.stringify(s.links));
    check(`${theme}: the pod's own Findings strip (CrashLoopBackOff with the exit code, 42 restarts, Ready False, the oc edit) sits under the title`, s.open && s.findings.some((f) => f === 'worker is in CrashLoopBackOff') && s.findings.some((f) => f === 'worker restarted 42 times') && s.findings.some((f) => f.startsWith('Ready is False')) && s.findings.some((f) => f.startsWith('Edited by oc')), s.open && s.findings.join(' | '));
    check(`${theme}: the sections: Summary, Containers, Conditions, Volumes, Scheduling, Events, Container logs, Field ownership, Pod JSON`, s.open && ['Summary', 'Containers 1', 'Conditions 5', 'Volumes 1', 'Scheduling', 'Events 2', 'Container logs 3', 'Field ownership 3', 'Pod JSON'].every((t) => s.sections.includes(t)), s.open && s.sections.join(' | '));
    check(`${theme}: the page's own strip and the list are hidden while the detail is open; the title has the focus`, s.open && s.stripHidden && s.listHidden && s.focused, JSON.stringify({ strip: s.stripHidden, list: s.listHidden, focused: s.focused }));
    check(`${theme}: the detail opens with the pane scrolled to its top (view top ${s.open && Math.round(s.top)}, pane top ${s.viewport && s.viewport.top})`, s.open && s.viewport && Math.abs(s.viewport.top - (s.top - 8)) <= 12, JSON.stringify({ top: s.top, viewport: s.viewport }));
    const sum = await frame.evaluate(() => { const dl = document.querySelector('.ui-detail:not([hidden]) details.ui-detail-section .ui-kv'); const kv = {}; dl.querySelectorAll('div').forEach((d) => { kv[d.querySelector('dt').textContent] = d.querySelector('dd').textContent.trim(); }); const link = dl.querySelector('dd button.ui-link[data-tab="compute"]'); return { kv, nodeLink: link && link.textContent }; });
    check(`${theme}: the Summary grid: namespace, the node as a link to the Node detail, phase, QoS, IP, age, the owner ReplicaSet, the service account`, sum.kv.Namespace === 'payments-demo' && sum.nodeLink === 'master-1' && sum.kv.Phase === 'Running' && sum.kv.QoS === 'Burstable' && sum.kv['Pod IP'] === '10.128.2.77' && /^4 h/.test(sum.kv.Age) && /ReplicaSet payments-worker-7b8c9d0e1/.test(sum.kv.Owner) && sum.kv['Service account'] === 'default', JSON.stringify(sum).slice(0, 500));
    const card = await frame.evaluate(() => { const c = document.querySelector('.ui-detail-card'); const kv = {}; c.querySelectorAll('.ui-kv > div').forEach((d) => { kv[d.querySelector('dt').textContent] = d.querySelector('dd').textContent.trim(); }); return { title: c.querySelector('.ui-detail-card-title').textContent, badges: Array.from(c.querySelectorAll('.ui-detail-card-head .ui-badge')).map((b) => b.textContent), kv }; });
    check(`${theme}: the container card: waiting: CrashLoopBackOff, 42 restarts, not ready; the last state with exit code 1 (Error); requests / limits; the env from a secret by name only`, card.title === 'worker' && card.badges.join(',') === 'waiting: CrashLoopBackOff,42 restarts,not ready' && /terminated, Error, exit code 1/.test(card.kv['Last state']) && /cpu 100m, memory 128 MiB/.test(card.kv.Requests) && /DATABASE_URL ← secret postgres-demo-credentials\/url/.test(card.kv.Env), JSON.stringify(card).slice(0, 600));
    // the events section: newest first, Warning in amber, linked to the Events page
    const ev = await frame.evaluate(() => { const sec = Array.from(document.querySelectorAll('.ui-detail:not([hidden]) details.ui-detail-section')).find((d) => d.querySelector('summary').textContent.trim().startsWith('Events')); const rows = Array.from(sec.querySelectorAll('tbody tr')).map((r) => Array.from(r.cells).map((c) => c.textContent.trim())); return { rows, link: !!sec.querySelector('button.ui-link[data-tab="system"][data-sub-tab="events"]') }; });
    check(`${theme}: the Events section: BackOff (Warning, 42) first, then Pulled, with a link to the Events page`, ev.rows.length === 2 && ev.rows[0][0] === 'Warning' && ev.rows[0][1] === 'BackOff' && ev.rows[0][3] === '42' && ev.rows[1][1] === 'Pulled' && ev.link, JSON.stringify(ev).slice(0, 400));
    const logs = await frame.evaluate(() => { const sec = Array.from(document.querySelectorAll('.ui-detail:not([hidden]) details.ui-detail-section')).find((d) => d.querySelector('summary').textContent.trim().startsWith('Container logs')); return Array.from(sec.querySelectorAll('tbody tr')).map((r) => Array.from(r.cells).slice(0, 3).map((c) => c.textContent.trim())); });
    check(`${theme}: the Container logs section lists current (empty) and previous with their sizes`, logs.length === 3 && logs[0].join('|') === 'worker|current (empty)|0 B' && logs[1].join('|') === 'worker|previous|994 B', JSON.stringify(logs));
    // field ownership (folded): newest first, the person's tool flagged
    const own = await frame.evaluate(() => { const sec = Array.from(document.querySelectorAll('.ui-detail:not([hidden]) details.ui-detail-section')).find((d) => d.querySelector('summary').textContent.trim().startsWith('Field ownership')); const wasOpen = sec.open; sec.open = true; const rows = Array.from(sec.querySelectorAll('tbody tr')).map((r) => ({ manager: r.cells[0].textContent.trim(), kind: r.cells[0].querySelector('.ui-badge').textContent, fields: r.cells[2].querySelectorAll('.ui-chip').length })); return { wasOpen, rows, note: sec.querySelector('.ui-detail-section-body p').textContent }; });
    check(`${theme}: Field ownership (folded at first): kubelet (status), oc (human), kube-controller-manager (controller), newest first, the person's edit summarised`, !own.wasOpen && own.rows.map((r) => r.kind).join(',') === 'status,human,controller' && /^human oc$/.test(own.rows[1].manager) && own.rows[1].fields === 1 && /Last edited by a person.s tool: oc 12 min before the gather/.test(own.note), JSON.stringify(own).slice(0, 500));
    // no horizontal overflow at every width
    for (const fw of [1920, 1360, 1010, 420, 360]) {
      await frameWidth(page, fw);
      const o = await overflow(frame);
      check(`${theme}: the Pod detail has no horizontal overflow at ${fw}`, !o.pageOver && o.bad.length === 0, JSON.stringify(o));
    }
    await resetWidth(page);
    if (theme === 'dark' || theme === 'light') { await page.screenshot({ path: path.join(OUT, `detail-pod-1360-${theme}.png`), fullPage: false }); }

    // ---- the JSON viewer, opened on request
    const jsonSec = await frame.evaluate(() => { const sec = Array.from(document.querySelectorAll('.ui-detail:not([hidden]) details.ui-detail-section')).find((d) => d.querySelector('summary').textContent.trim() === 'Pod JSON'); const empty = !sec.querySelector('.ui-code-view'); sec.open = true; sec.dispatchEvent(new Event('toggle')); return { empty }; });
    await sleep(500);
    const v = await frame.evaluate((key) => {
      const sec = Array.from(document.querySelectorAll('.ui-detail:not([hidden]) details.ui-detail-section')).find((d) => d.querySelector('summary').textContent.trim() === 'Pod JSON');
      const view = sec.querySelector('.ui-code-view');
      const lines = Array.from(view.querySelectorAll('.ui-code-line'));
      const copy = view.querySelector('.ui-code-bar [data-copy]');
      // the exact text: what the viewer holds equals JSON.stringify of the object (its parser-private keys left out)
      const raw = window.diagCode.text(window.__podRaw || null);
      const managed = lines.find((l) => l.getAttribute('data-path') === 'metadata.managedFields');
      const hiddenAfter = managed ? lines.slice(lines.indexOf(managed) + 1, lines.indexOf(managed) + 5).map((l) => l.hidden) : null;
      return { empty: false, lines: lines.length, numbers: lines.slice(0, 3).map((l) => l.getAttribute('data-n')), hasToolbar: !!view.querySelector('.ui-code-search input') && !!view.querySelector('.ui-code-formats'), copyLabel: copy && copy.textContent, copyStartsWithBrace: copy && copy.getAttribute('data-copy').startsWith('{\n  "apiVersion": "v1",'), managedFolded: !!(managed && managed.querySelector('.ui-code-folded')), hiddenAfter, highlighted: view.querySelectorAll('.hljs-attr').length > 50, raw: raw };
    }, CRASH);
    check(`${theme}: the Pod JSON section renders the code viewer only when opened: line numbers, the toolbar (search, Next / Previous, Filter lines, Wrap, Fold / Unfold all, Copy JSON, the JSON | YAML toggle), highlight.js tokens`, jsonSec.empty && v.lines > 100 && v.numbers.join(',') === '1,2,3' && v.hasToolbar && v.copyLabel === 'Copy JSON' && v.copyStartsWithBrace && v.highlighted, JSON.stringify(v).slice(0, 500));
    check(`${theme}: metadata.managedFields is folded from the start (its lines hidden, the marker shown)`, v.managedFolded && v.hiddenAfter && v.hiddenAfter.every(Boolean), JSON.stringify({ folded: v.managedFolded, hidden: v.hiddenAfter }));
    // the round trip: the copy text is the exact JSON of the object (the viewer's lines joined), and parses back
    const rt = await frame.evaluate(() => {
      const view = document.querySelector('.ui-detail:not([hidden]) .ui-code-view');
      const copyText = view.querySelector('.ui-code-bar [data-copy]').getAttribute('data-copy');
      const joined = Array.from(view.querySelectorAll('.ui-code-line')).map((l) => { const c = l.querySelector('.ui-code-line-text'); return c.textContent; }).join('\n') + '\n';
      let parsed = null; try { parsed = JSON.parse(copyText); } catch (e) { parsed = 'ERR ' + e.message; }
      const stringified = typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) + '\n' : '';
      return { same: joined === copyText, exact: stringified === copyText, kind: parsed && parsed.kind, name: parsed && parsed.metadata && parsed.metadata.name, noPrivate: parsed && !('_detail' in parsed) && !('_age_seconds' in parsed), gapsAfterNumbers: /:\s\n/.test(copyText) };
    });
    check(`${theme}: the round trip: the shown lines are the copied text, which is exactly JSON.stringify(object, null, 2) and parses back to the pod (no parser-private keys, nothing lost after a number)`, rt.same && rt.exact && rt.kind === 'Pod' && rt.name === 'payments-worker-7b8c9d0e1-efghi' && rt.noPrivate && !rt.gapsAfterNumbers, JSON.stringify(rt));
    // the search: every match marked, the count, Next / Previous / Enter walk them, the current one marked and scrolled into the box
    const search = await frame.evaluate(async () => {
      const view = document.querySelector('.ui-detail:not([hidden]) .ui-code-view');
      const input = view.querySelector('.ui-code-search input');
      input.value = 'image'; input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const count = () => view.querySelector('.ui-code-count').textContent;
      const current = () => { const m = view.querySelector('.ui-code-current'); return m ? m.closest('.ui-code-line').getAttribute('data-n') : null; };
      const marks = view.querySelectorAll('.ui-code-mark').length;
      const out = { marks, count0: count(), line0: current(), hits: view.querySelectorAll('.ui-code-hit').length };
      view.querySelector('.ui-code-bar button:nth-of-type(2)').click(); await new Promise((r) => setTimeout(r, 50));
      out.count1 = count(); out.line1 = current();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await new Promise((r) => setTimeout(r, 50));
      out.count2 = count(); out.line2 = current();
      view.querySelector('.ui-code-bar button:nth-of-type(1)').click(); await new Promise((r) => setTimeout(r, 50));
      out.count3 = count(); out.line3 = current();
      const cur = view.querySelector('.ui-code-current').closest('.ui-code-line').getBoundingClientRect(), box = view.getBoundingClientRect();
      out.inBox = cur.top >= box.top && cur.bottom <= box.bottom;
      // Filter lines keeps only the matching lines
      const filter = view.querySelectorAll('.ui-code-bar input[type="checkbox"]')[0]; filter.click(); await new Promise((r) => setTimeout(r, 50));
      const lines = Array.from(view.querySelectorAll('.ui-code-line'));
      out.shown = lines.filter((l) => !l.hidden).length; out.allShownMatch = lines.filter((l) => !l.hidden).every((l) => /image/i.test(l.textContent));
      filter.click();
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 300));
      out.cleared = view.querySelectorAll('.ui-code-mark').length === 0 && count() === '';
      return out;
    });
    check(`${theme}: the search marks every "image" (${search.marks}), counts "1 of n", Next / Enter / Previous walk the matches, the current match is in the viewer's box, Filter lines keeps the ${search.shown} matching lines, clearing removes the marks`,
      search.marks >= 3 && search.count0 === '1 of ' + search.marks && search.count1 === '2 of ' + search.marks && search.count2 === '3 of ' + search.marks && search.count3 === '2 of ' + search.marks && search.line1 !== search.line0 && search.line3 === search.line1 && search.inBox && search.shown === search.hits && search.allShownMatch && search.cleared, JSON.stringify(search));
    // the fold chevron unfolds managedFields; the key click copies its path
    const fold = await frame.evaluate(async () => {
      const view = document.querySelector('.ui-detail:not([hidden]) .ui-code-view');
      // the search walked a match inside managedFields and opened it on the way: the chevron toggles either way
      const folded = () => { const l = view.querySelector('.ui-code-line[data-path="metadata.managedFields"]'); return { folded: !!l.querySelector('.ui-code-folded'), nextHidden: l.nextElementSibling.hidden }; };
      const s0 = folded();
      view.querySelector('.ui-code-line[data-path="metadata.managedFields"] [data-fold]').click(); await new Promise((r) => setTimeout(r, 50));
      const s1 = folded();
      view.querySelector('.ui-code-line[data-path="metadata.managedFields"] [data-fold]').click(); await new Promise((r) => setTimeout(r, 50));
      const s2 = folded();
      const key = view.querySelector('.ui-code-line[data-path="metadata.managedFields"] .hljs-attr[data-copy]');
      return { s0, s1, s2, keyPath: key && key.getAttribute('data-copy'), keyTitle: key && key.title };
    });
    check(`${theme}: the chevron folds and unfolds managedFields (its lines hidden exactly when folded); the key carries its path for Copy`, fold.s1.folded !== fold.s0.folded && fold.s2.folded === fold.s0.folded && fold.s0.nextHidden === fold.s0.folded && fold.s1.nextHidden === fold.s1.folded && fold.keyPath === 'metadata.managedFields' && /Copy the path metadata\.managedFields/.test(fold.keyTitle), JSON.stringify(fold));
    // the YAML toggle: the same object as YAML, Copy copies YAML, js-yaml reads it back
    const yaml = await frame.evaluate(async () => {
      const view = document.querySelector('.ui-detail:not([hidden]) .ui-code-view');
      view.querySelector('.ui-code-formats [data-format="yaml"]').click(); await new Promise((r) => setTimeout(r, 200));
      const copy = view.querySelector('.ui-code-bar [data-copy]');
      const text = copy.getAttribute('data-copy');
      let back = null; try { back = window.jsyaml.load(text); } catch (e) { back = 'ERR ' + e.message; }
      const json = window.diagCode.text(back, 'json');
      const first = view.querySelector('.ui-code-line .ui-code-line-text').textContent;
      const managed = view.querySelector('.ui-code-line[data-path="metadata.managedFields"]');
      const out = { label: copy.textContent, first, startsPlain: text.startsWith('apiVersion: v1\nkind: Pod\n'), back: typeof back === 'object' ? back.metadata.name : back, jsonOfBack: json, managedFolded: !!(managed && managed.querySelector('.ui-code-folded')) };
      view.querySelector('.ui-code-formats [data-format="json"]').click(); await new Promise((r) => setTimeout(r, 200));
      out.backToJson = view.querySelector('.ui-code-bar [data-copy]').textContent === 'Copy JSON';
      return out;
    });
    const jsonText = await frame.evaluate(() => document.querySelector('.ui-detail:not([hidden]) .ui-code-view .ui-code-bar [data-copy]').getAttribute('data-copy'));
    check(`${theme}: the YAML toggle shows the same object as YAML (js-yaml), Copy YAML copies it, js-yaml reads it back to the identical object, managedFields folded there too, and JSON comes back`, yaml.label === 'Copy YAML' && yaml.first === 'apiVersion: v1' && yaml.startsPlain && yaml.back === 'payments-worker-7b8c9d0e1-efghi' && yaml.jsonOfBack === jsonText && yaml.managedFolded && yaml.backToJson, JSON.stringify(yaml).slice(0, 400));
    await resetWidth(page);
    if (errors.length) check(`${theme}: no page error while the Pod detail was exercised`, false, errors.join(' | '));

    // ---- Back: the list returns at the same scroll position, the row highlighted and focused; Escape too
    await frame.evaluate(() => { document.querySelector('.ui-detail:not([hidden]) [data-detail-back]').click(); });
    await sleep(900);
    const back = await frame.evaluate((key) => { const row = document.querySelector(`tr[data-detail="${key}"]`); return { listShown: !document.querySelector('#podListPanel').hidden, detailHidden: document.querySelector('#podDetail').hidden, stripShown: !document.querySelector('#diagnostics-content > .ui-findings').hidden, top: window.diagnosticsViewport && window.diagnosticsViewport.top, hl: row.classList.contains('ui-row-hl'), focused: document.activeElement === row, rowTop: row.getBoundingClientRect().top }; }, CRASH);
    check(`${theme}: Back shows the list again at the scroll position it had (pane top ${back.top} vs ${savedTop}), the strip back, the opened row highlighted and focused`, back.listShown && back.detailHidden && back.stripShown && Math.abs(back.top - savedTop) <= 40 && back.hl && back.focused, JSON.stringify(back));
    await frame.evaluate((key) => { document.querySelector(`tr[data-detail="${key}"]`).click(); }, CRASH);
    await sleep(500);
    await frame.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await sleep(500);
    check(`${theme}: Escape goes back to the list`, await frame.evaluate(() => document.querySelector('#podDetail').hidden && !document.querySelector('#podListPanel').hidden));
    // the cross-link query opens a detail
    await frame.evaluate((key) => { window.diagLinks.applyQuery('detail=' + key); }, 'payments-demo/payments-api-5f6d7c8b9-zabcd');
    await sleep(700);
    s = await state(frame);
    check(`${theme}: the cross-link query "detail=<namespace>/<name>" opens that pod's detail (the OOMKilled pod, its finding on top)`, s.open && s.title === 'payments-api-5f6d7c8b9-zabcd' && s.findings.some((f) => f.startsWith('api was OOMKilled')), JSON.stringify({ open: s.open, title: s.title, findings: s.findings }).slice(0, 300));
    // Previous / Next walk the list's order
    const nav = await frame.evaluate(async () => { const v = document.querySelector('.ui-detail:not([hidden])'); const pos0 = v.querySelector('.ui-detail-pos').textContent; v.querySelector('[data-detail-next]').click(); await new Promise((r) => setTimeout(r, 300)); return { pos0, pos1: v.querySelector('.ui-detail-pos').textContent, title: v.querySelector('.ui-detail-title').textContent }; });
    check(`${theme}: Next opens the following row's detail (${nav.pos0} -> ${nav.pos1})`, nav.pos0 !== nav.pos1 && nav.title !== 'payments-api-5f6d7c8b9-zabcd', JSON.stringify(nav));
    await frame.evaluate(() => window.diagDetail.back());
    await sleep(300);

    // ---- the Node detail: capacity meters, the pods on the node
    // Open logs end to end: the Log Viewer opens with the pod's two container logs checked, their range read, the rows loaded
    {
      const podFrame = await frameFor(page, 'pod');
      const opened = podFrame ? await podFrame.evaluate((key) => { window.diagDetail.open(key); const b = Array.from(document.querySelectorAll('.ui-detail:not([hidden]) .ui-detail-actions button')).find((x) => x.textContent.trim() === 'Open logs'); if (!b) return false; b.click(); return true; }, CRASH) : false;
      const lv = opened ? await frameFor(page, 'log_viewer') : null;
      let st = null;
      for (let i = 0; lv && i < 80; i++) { st = await lv.evaluate(() => ({ checked: Array.from(document.querySelectorAll('.log-file-checkbox:checked')).map((c) => c.getAttribute('data-name')), loaded: ((document.getElementById('loaded-count') || {}).textContent || '').trim(), labels: [document.getElementById('date-start-label').textContent, document.getElementById('date-end-label').textContent], search: (document.getElementById('log-search') || {}).value, modal: (document.getElementById('alert-modal-title') || {}).textContent, errs: (window.__errs || []).slice(0, 2), types: Array.from(document.querySelectorAll('.log-file-checkbox')).slice(0, 3).map((c) => c.dataset.type + ':' + c.dataset.namespace + '/' + c.dataset.pod), hasApply: typeof (window.diagLogView && window.diagLogView.applyQuery) })); if (/^Loaded [\d,]+ entries$/.test(st.loaded)) break; await sleep(250); }
      check(`${theme}: Open logs opens the Log Viewer with the pod's three container logs checked (${st ? st.checked.join(', ') : '-'}), their range (${st ? st.labels.join(' to ') : '-'}) and the rows loaded (${st ? st.loaded : '-'})`, !!lv && !!st && st.checked.length === 3 && st.checked.every((n) => /payments-worker-7b8c9d0e1-efghi\/worker \((current|previous|previous\.insecure)\)$/.test(n)) && /^Loaded 20 entries$/.test(st.loaded) && st.labels[0] === '2026-10-12', JSON.stringify({ opened, st }));
    }
    const nodesFrame = await openTab(page, 'nodes');
    check(`${theme}: the Nodes page renders`, !!nodesFrame);
    if (nodesFrame) {
      await nodesFrame.evaluate(() => { document.querySelector('tr[data-detail="master-0"]').click(); });
      await sleep(800);
      const n = await nodesFrame.evaluate(() => {
        const v = document.querySelector('.ui-detail:not([hidden])');
        const meters = Array.from(v.querySelectorAll('.ui-meter')).map((m) => ({ now: m.getAttribute('aria-valuenow'), max: m.getAttribute('aria-valuemax'), text: m.querySelector('.ui-meter-value').textContent, width: parseFloat(m.querySelector('.ui-meter-fill').style.width) }));
        const sections = Array.from(v.querySelectorAll('details.ui-detail-section > summary')).map((s) => s.textContent.trim());
        const podsSec = Array.from(v.querySelectorAll('details.ui-detail-section')).find((d) => d.querySelector('summary').textContent.trim().startsWith('Pods on this node'));
        return { title: v.querySelector('.ui-detail-title').textContent, badge: v.querySelector('.ui-detail-badge').textContent.trim(), meters, sections, podRows: podsSec.querySelectorAll('tbody tr').length, podLinks: podsSec.querySelectorAll('tbody button.ui-link[data-tab="workloads"]').length,
          links: Array.from(v.querySelectorAll('.ui-detail-actions button[data-tab]')).map((b) => [b.textContent.trim(), b.getAttribute('data-tab'), b.getAttribute('data-sub-tab') || '', b.getAttribute('data-query') || ''].join('|')) };
      });
      check(`${theme}: Open node logs links to the Log Viewer with the node's journals and its role's host service logs (sources=node:master-0,host:masters)`, n.links.includes('Open node logs|log_collection|log_viewer|sources=node:master-0,host:masters'), JSON.stringify(n.links));
      check(`${theme}: the Node detail: Ready badge, the capacity meters (cpu 7.5 of 8 = 93.8%, pods 250 of 250), Conditions, Taints, the 4 pods on it linked to their details, Node JSON`, n.title === 'master-0' && n.badge === 'Ready' && n.meters.length >= 4 && n.meters[0].text === '93.8%' && Math.abs(n.meters[0].width - 93.8) < 0.2 && n.meters.some((m) => m.now === '250' && m.max === '250') && ['Summary', 'Capacity', 'Conditions 4', 'Taints 0', 'Pods on this node 4', 'Node JSON'].every((t) => n.sections.includes(t)) && n.podRows === 4 && n.podLinks === 4, JSON.stringify(n).slice(0, 600));
      for (const fw of [1920, 1010, 360]) { await frameWidth(page, fw); const o = await overflow(nodesFrame); check(`${theme}: the Node detail has no horizontal overflow at ${fw}`, !o.pageOver && o.bad.length === 0, JSON.stringify(o)); }
      await resetWidth(page);
      await page.screenshot({ path: path.join(OUT, `detail-node-1360-${theme}.png`), fullPage: false });
    }

    // ---- the Deployment detail: replicas, the ReplicaSets, the kubectl edit
    const depFrame = await openTab(page, 'deployment');
    check(`${theme}: the Deployment page renders`, !!depFrame);
    if (depFrame) {
      await depFrame.evaluate(() => { document.querySelector('tr[data-detail="payments-demo/payments-worker"]').click(); });
      await sleep(800);
      const dd = await depFrame.evaluate(() => {
        const v = document.querySelector('.ui-detail:not([hidden])');
        const rsSec = Array.from(v.querySelectorAll('details.ui-detail-section')).find((d) => d.querySelector('summary').textContent.trim().startsWith('ReplicaSets'));
        const rs = Array.from(rsSec.querySelectorAll('tbody tr')).map((r) => Array.from(r.cells).map((c) => c.textContent.trim()));
        return { badge: v.querySelector('.ui-detail-badge').textContent.trim(), findings: Array.from(v.querySelectorAll('.ui-finding-title')).map((f) => f.textContent), sections: Array.from(v.querySelectorAll('details.ui-detail-section > summary')).map((s) => s.textContent.trim()), rs, rsLink: !!rsSec.querySelector('button.ui-link[data-tab="workloads"][data-sub-tab="replicaset"]') };
      });
      check(`${theme}: the Deployment detail: 0/1 available badge, the findings (0 of 1, the rollout stalled, the kubectl edit 12 min before), the pod template, Conditions, its ReplicaSet (revision 3, 1 wanted, 0 ready) linked, Events, Field ownership, Deployment JSON`,
        dd.badge === '0/1 available' && dd.findings[0] === '0 of 1 replicas available' && dd.findings.some((f) => f.startsWith('The rollout is not progressing')) && dd.findings.some((f) => f === 'Edited by kubectl-edit 12 min before the gather') && ['Pod template 1', 'Conditions 2', 'ReplicaSets 1', 'Events 1', 'Field ownership 3', 'Deployment JSON'].every((t) => dd.sections.includes(t)) && dd.rs.length === 1 && dd.rs[0][0] === 'payments-worker-7b8c9d0e1' && dd.rs[0][1] === '3 (current)' && dd.rs[0][2] === '1' && dd.rs[0][3] === '0' && dd.rsLink, JSON.stringify(dd).slice(0, 700));
      for (const fw of [1920, 1010, 360]) { await frameWidth(page, fw); const o = await overflow(depFrame); check(`${theme}: the Deployment detail has no horizontal overflow at ${fw}`, !o.pageOver && o.bad.length === 0, JSON.stringify(o)); }
      await resetWidth(page);
      await page.screenshot({ path: path.join(OUT, `detail-deployment-1360-${theme}.png`), fullPage: false });
    }

    // ---- the TLS secret: the data masked in the JSON viewer, Reveal shows one value, the copy text stays masked
    const tlsFrame = await openTab(page, 'tls_secrets');
    check(`${theme}: the TLS Secrets page renders`, !!tlsFrame);
    if (tlsFrame) {
      const masked = await tlsFrame.evaluate(async () => {
        document.querySelector('tbody tr[data-detail]').click(); await new Promise((r) => setTimeout(r, 500));
        const v = document.querySelector('.ui-detail:not([hidden])');
        const sec = Array.from(v.querySelectorAll('details.ui-detail-section')).find((d) => d.querySelector('summary').textContent.trim() === 'Secret JSON');
        sec.open = true; sec.dispatchEvent(new Event('toggle')); await new Promise((r) => setTimeout(r, 400));
        const view = sec.querySelector('.ui-code-view');
        const dots = view.querySelectorAll('.ui-masked-dots').length;
        const crt = view.querySelector('.ui-code-line[data-path="data.tls.crt"]');
        const copy0 = view.querySelector('.ui-code-bar [data-copy]').getAttribute('data-copy');
        const revealBtn = crt.querySelector('[data-reveal]'); revealBtn.click(); await new Promise((r) => setTimeout(r, 100));
        const crt2 = view.querySelector('.ui-code-line[data-path="data.tls.crt"]');
        const copy1 = view.querySelector('.ui-code-bar [data-copy]').getAttribute('data-copy');
        const revealAll = Array.from(view.querySelectorAll('.ui-code-bar button')).find((b) => b.textContent === 'Reveal secrets'); revealAll.click(); await new Promise((r) => setTimeout(r, 100));
        return { dots, crtMasked: /tls\.crt.*••••••/.test(crt.textContent) && /Reveal/.test(crt.textContent), copyMasked: /"tls\.crt": "\*\*\*\*\*\*"/.test(copy0) && !/UkVEQUNURUQ=/.test(copy0), revealed: /tls\.crt.*UkVEQUNURUQ=/.test(crt2.textContent) && /Hide/.test(crt2.textContent), copyAfter: /"tls\.crt": "UkVEQUNURUQ="/.test(copy1) && /"tls\.key": "\*\*\*\*\*\*"/.test(copy1), allShown: view.querySelectorAll('.ui-masked-dots').length === 0 };
      });
      check(`${theme}: the Secret's data is masked in the viewer and in the copy text; Reveal shows that one value (and the copy follows); Reveal secrets shows them all`, masked.dots >= 2 && masked.crtMasked && masked.copyMasked && masked.revealed && masked.copyAfter && masked.allShown, JSON.stringify(masked));
    }
    if (errors.length) check(`${theme}: no page error during the detail pages`, false, errors.join(' | '));
    else check(`${theme}: no page error during the detail pages`, true);
    await context.close();
  }
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
