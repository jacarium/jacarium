/**
 * One control, table, card, chart and busy-state design across every
 * Diagnostics plugin (sosreport and must-gather), from the shared frame
 * stylesheet (backend/static/styles.css: the ui-* classes and the generic
 * element rules), the shared include (backend/templates/tabs/_ui.html:
 * markup macros) and the shared frame script (backend/static/
 * diagnostics-ui.js: the busy component and the chart helper):
 *
 *   static: no template defines its own input / select / button / table /
 *   card styles or builds a Chart.js config outside the shared pieces (an
 *   allow-list for the justified residue);
 *
 *   render (Vite + Chromium, dark and light): EVERY tab of both mock
 *   reports in the real frame; every visible text input, select, button,
 *   checkbox, table header and card matches the shared computed design
 *   (radius, height, padding, border, background, font, the focus ring),
 *   selects have exactly one chevron, the page has one card level, the
 *   layout probe passes at 420 and 1920, every chart carries the shared
 *   defaults (fonts, grid, legend, tooltip), shows every category label,
 *   draws no black or invisible fill and no line across a gap, and still
 *   does so after five theme toggles;
 *
 *   busy: the plugins with an async action show the shared busy state in
 *   the viewport (also when scrolled down) while a delayed answer is
 *   pending, clear it on completion, and Cancel / Retry work where offered;
 *
 *   components (tests/helpers/diagnostics-probe.mjs, on every tab at 1920
 *   and 420): the Findings strip first with 1+ item and no empty-state
 *   block or empty canvas; every chart in a fixed-height box under the
 *   cap, stable after a wait, resizes and theme toggles, radial charts
 *   without axes, legend swatches = dataset colours, every category label
 *   shown without overlap, 3+ value ticks, stacked segments distinct, the
 *   chart grid 3 columns wide / 1 narrow; every table in the rounded
 *   bordered box with uniform rows, one sort marker on a sortable table
 *   that moves on a click and reorders the rows, non-sortable headers not
 *   clickable; the shared pager (30px buttons, the current page selected,
 *   the ends disabled, hidden on one page, "Page N of M" under 640, page 2
 *   on a click, the window shape and go-to box on 27,527 rows); the filter
 *   bar on one row at 1920 with the width caps, uniform gaps, no stacked
 *   label, every control named, no overflow at 420; meters with a visible
 *   fill proportional to the value and the role of their Finding; chips
 *   with a border, a background, a gap, the selected role when active,
 *   4.5:1 text; the Log Collection band's segments distinct and equal to
 *   their legend swatches and section dots; every details toggles by click
 *   and keyboard and the document follows; expandable rows open by click
 *   and keyboard with the panel aligned to the content and Expand /
 *   Collapse all; plus two reports without data (the old-format sosreport,
 *   an empty must-gather) and a 16-CPU scheduler fixture.
 *
 * Screenshots of every tab (UI_OUT; UI_LABEL prefixes the files, e.g.
 * before / after): wide in both themes, narrow (420 px) for the tabs with a
 * table. Never touches the user's files: synthetic fixtures only.
 *
 * Run: node tests/diagnostics-ui-consistency.test.mjs
 *      UI_REPORTS=sosreport UI_TABS=processes,services  (a subset)
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { probeComponents, stability, toggleDetails, exerciseXrows, exerciseSort, exercisePager, pagerShapes, containment, barSizingCheck, roleColours, fontCheck } from './helpers/diagnostics-probe.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const TABS_DIR = path.join(REPO, 'backend', 'templates', 'tabs');

// ---------------------------------------------------------------------------
// Static: the shared pieces exist; no template restyles a control or builds a chart on its own
// ---------------------------------------------------------------------------
{
  const shared = ['backend/static/styles.css', 'backend/static/diagnostics-ui.js', 'backend/templates/tabs/_ui.html', 'backend/templates/tabs/_table_head.html'];
  check('the shared pieces exist: the frame stylesheet, the frame script (busy + charts) and the markup include', shared.every((p) => fs.existsSync(path.join(REPO, p))), shared.filter((p) => !fs.existsSync(path.join(REPO, p))).join(', '));
  const css = fs.existsSync(path.join(REPO, 'backend/static/styles.css')) ? read('backend/static/styles.css') : '';
  for (const cls of ['.ui-input', '.ui-select', '.ui-select-wrap', '.ui-check', '.ui-chip', '.ui-card', '.ui-table', '.ui-badge', '.ui-empty', '.ui-busy-pill', '.ui-progress']) check(`styles.css defines ${cls}`, css.includes(cls + ' ') || css.includes(cls + ',') || css.includes(cls + '{') || css.includes(cls + ':') || css.includes(cls + ' {'));
  const js = fs.existsSync(path.join(REPO, 'backend/static/diagnostics-ui.js')) ? read('backend/static/diagnostics-ui.js') : '';
  check('diagnostics-ui.js exposes window.diagBusy (start / done / fail / cancel) and window.diagChart (make, timeSeries, categoryBars, retheme)', /window\.diagBusy\s*=/.test(js) && /window\.diagChart\s*=/.test(js) && /start\b/.test(js) && /retheme/.test(js));
  // the templates: no own control styles, no own Chart.js config
  const CONTROL_RULE = /(^|[\s,>+~(])(input|select|button|textarea|table|th|td)\b|\.[a-z]+-(input|select|btn|button|chip|field|table|th|td|card|badge|tag|empty|spinner|pill)\b/;
  const ALLOW = [
    // the Audit page's own layout around the shared controls: the search rows' sizing, the event rows (cards with a severity edge), the diff table
    /_audit\.html: \.au-search|_audit\.html: \.au-ev|_audit\.html: \.au-diff|_audit\.html: \.au-field|_audit\.html: \.au-chip|_audit\.html: \.au-sort|_audit\.html: \.au-pill|_audit\.html: \.au-events/,
    // the Log Collection table's own columns and stacked rows, the section chips with their colour dots
    /_log_collection\.html: \.lc-table|_log_collection\.html: \.lc-chip|_log_collection\.html: \.lc-td|_log_collection\.html: \.lc-th|_log_collection\.html: \.lc-field/,
    // the kernel tabs: the incident rows (cards with a severity edge) and the filter row's sizing
    /_kernel_diag\.html: \.kd-row|_kernel_diag\.html: \.kd-field|_kernel_diag\.html: \.kd-filters/,
    // the shared header include is the design itself
    /_table_head\.html/,
    // the Log Viewer's own layout: the slider, the file list, the log table rows
    /sosreport_log_viewer\.html: \.lv-(table|row|file|slider|range|td|th)/,
    // page-specific accents and sizing on top of the shared pieces: the Audit diff table, the kernel OOM task table's killed rows and
    // the chips' monospace, the Blame rows' coloured edges and command sub-tables, a field's width in a toolbar, a chip's dim part
    /_audit\.html: (#diagnostics-content )?\.au-diff|_audit\.html: \.dark \.au-diff/,
    /_kernel_diag\.html: (\.ui-chip\.kd-chip-mono|\.kd-chip-muted|\.kd-tag svg|\.kd-empty-sources|table\.kd-table|\.kd-stat-value \.kd-tag|\.kd-table tr\.kd-killed)/,
    /_log_collection\.html: (\.lc-controls \.ui-field|\.ui-chip \.lc-dot)/,
    /sosreport_blame\.html: (\.bl-filters \.ui-field|\.bl-table (th, \.bl-table td|tr\.bl-row|td\.bl-name)|\.bl-cmds|\.bl-cmd-table)/,
    /sosreport_sos_report\.html: \.ui-chip \.sr-dim/,
  ];
  const offenders = [];
  const charts = [];
  for (const f of fs.readdirSync(TABS_DIR)) {
    if (!f.endsWith('.html') || f === '_ui.html' || f === '_table_head.html') continue;
    const text = fs.readFileSync(path.join(TABS_DIR, f), 'utf8');
    for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{%[\s\S]*?%\}/g, '').replace(/\{\{[\s\S]*?\}\}/g, '');
      for (const rule of body.matchAll(/([^{}]+)\{/g)) {
        const sel = rule[1].trim().replace(/\s+/g, ' ');
        if (!sel || sel.startsWith('@')) continue;
        if (CONTROL_RULE.test(sel)) { const line = `${f}: ${sel.slice(0, 90)}`; if (!ALLOW.some((a) => a.test(line))) offenders.push(line); }
      }
    }
    text.split('\n').forEach((l, i) => { if (/new Chart\s*\(/.test(l)) charts.push(`${f}:${i + 1}`); });
  }
  if (process.env.UI_VERBOSE) fs.writeFileSync(process.env.UI_VERBOSE, offenders.join('\n') + '\n');
  check(`no template defines its own input / select / button / table / card / badge styles outside the shared stylesheet (${offenders.length} found)`, offenders.length === 0, offenders.slice(0, 20).join('\n'));
  check(`no template builds a Chart.js config on its own: every chart goes through diagChart (${charts.length} found)`, charts.length === 0, charts.join(', '));
  // the control markup: no leftover utility styling on the controls themselves
  const UTIL = /<(input|select|button)\b[^>]*class="[^"]*\b(rounded-(sm|md|lg)|border-gray-\d+|bg-gray-\d+|bg-white|text-white|focus:ring-\d|appearance-none|shadow-(sm|md|xs))\b/;
  const utils = [];
  for (const f of fs.readdirSync(TABS_DIR)) {
    if (!f.endsWith('.html')) continue;
    fs.readFileSync(path.join(TABS_DIR, f), 'utf8').split('\n').forEach((l, i) => { if (UTIL.test(l)) utils.push(`${f}:${i + 1} ${l.trim().slice(0, 100)}`); });
  }
  if (process.env.UI_VERBOSE) fs.appendFileSync(process.env.UI_VERBOSE, '--- utilities ---\n' + utils.join('\n') + '\n');
  check(`no control in a template carries a utility look of its own (rounded-md, border-gray, text-white, appearance-none ...): the shared classes style it (${utils.length} found)`, utils.length === 0, utils.slice(0, 12).join('\n'));
}

{
  // the empty-state phrases are gone from the templates (a missing-data case is a Findings line): zero hits outside
  // a zero-match row (td.ui-match-none), a comment or a macro definition that renders nothing
  const PHRASES = /No (\w+ )?Data Available|not available in this report|not found in this report|class="(ui-empty|empty-state|kd-empty|lc-empty|au-empty)[" ]/;
  const hits = [];
  for (const f of fs.readdirSync(TABS_DIR)) {
    if (!f.endsWith('.html')) continue;
    fs.readFileSync(path.join(TABS_DIR, f), 'utf8').split('\n').forEach((l, i) => { if (PHRASES.test(l) && !/ui-match-none|\{#|^\s*\*|^\s*\/\//.test(l)) hits.push(`${f}:${i + 1} ${l.trim().slice(0, 80)}`); });
  }
  check(`no template carries an empty-state block or phrase (${hits.length} found)`, hits.length === 0, hits.slice(0, 8).join('\n'));
  // the role colours are the theme's --chart-<role> / badge text tokens: no template carries a bare role hex
  const ROLE_HEX = /#(dc2626|ef4444|f87171|b91c1c|f59e0b|d97706|b45309|fbbf24|92400e|22c55e|16a34a|4ade80|15803d|166534|9ca3af|94a3b8)\b/i;
  const roleHex = [];
  for (const f of fs.readdirSync(TABS_DIR)) {
    if (!f.endsWith('.html') || f === '_log_collection.html') continue;
    fs.readFileSync(path.join(TABS_DIR, f), 'utf8').split('\n').forEach((l, i) => { if (ROLE_HEX.test(l.replace(/var\(--[\w-]+,\s*#[0-9a-f]{3,8}\)/gi, ''))) roleHex.push(`${f}:${i + 1} ${l.trim().slice(0, 90)}`); });
  }
  check(`no template carries a bare role colour (red / amber / green / grey hex): the --chart-<role> and badge text tokens carry them (${roleHex.length} found)`, roleHex.length === 0, roleHex.slice(0, 8).join('\n'));
  // the bar sizing is the shared helper's alone: no template (and no app component) sets barThickness / barPercentage
  const THICK = /\b(maxBarThickness|barThickness|barPercentage|categoryPercentage|minBarLength)\b/;
  const thick = [];
  for (const f of fs.readdirSync(TABS_DIR)) {
    if (!f.endsWith('.html')) continue;
    fs.readFileSync(path.join(TABS_DIR, f), 'utf8').split('\n').forEach((l, i) => { if (THICK.test(l.replace(/\/\/.*$/, ''))) thick.push(`${f}:${i + 1} ${l.trim().slice(0, 80)}`); });
  }
  const walkSrc = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkSrc(path.join(dir, e.name)) : /\.(jsx?|mjs|cjs|tsx?)$/.test(e.name) ? [path.join(dir, e.name)] : []);
  for (const f of walkSrc(path.join(REPO, 'src'))) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (THICK.test(l.replace(/\/\/.*$/, ''))) thick.push(`${path.relative(REPO, f)}:${i + 1} ${l.trim().slice(0, 80)}`); });
  const helper = fs.readFileSync(path.join(REPO, 'backend', 'static', 'diagnostics-ui.js'), 'utf8').split('\n');
  const from = helper.findIndex((l) => l.includes('function barSizing(')), to = helper.findIndex((l, i) => i > from && l.includes('function applyBarSizing('));
  const end = helper.findIndex((l, i) => i > to && l === '  }');
  const outside = helper.map((l, i) => [l.replace(/\/\/.*$/, ''), i + 1]).filter(([l, n]) => THICK.test(l) && !(n > from && n <= end + 1));
  check(`no template or app component sets a bar thickness of its own, and diagnostics-ui.js only inside barSizing / applyBarSizing (${thick.length} + ${outside.length} found)`, thick.length === 0 && outside.length === 0, thick.concat(outside.map(([l, n]) => `diagnostics-ui.js:${n} ${l.trim().slice(0, 80)}`)).slice(0, 8).join('\n'));
}
if (process.env.SKIP_BROWSER_TESTS) { console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed'); process.exit(failed ? 1 : 0); }
let pw; try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(failed ? 1 : 0); }
const PYTHON = path.join(REPO, 'backend', 'venv', 'bin', 'python');
if (!fs.existsSync(PYTHON)) { console.log('SKIP: backend/venv missing - cannot render the tabs'); process.exit(failed ? 1 : 0); }
const OUT = process.env.UI_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-ui-'));
fs.mkdirSync(OUT, { recursive: true });
const LABEL = process.env.UI_LABEL || 'after';

// ---------------------------------------------------------------------------
// The fixtures: both mock reports, every tab rendered through Flask
// ---------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-ui-fixture-'));
const gen = spawnSync(PYTHON, [path.join(REPO, 'tests', 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', work, '--no-archives'], { encoding: 'utf8' });
if (gen.status !== 0) { console.log('SKIP: could not build the synthetic diagnostics fixtures: ' + (gen.stderr || '').slice(0, 200)); process.exit(failed ? 1 : 0); }
const NAMES = { sosreport: 'sosreport-web-01-2026-10-13-abcdef', mustgather: 'must-gather.local.1234567890' };
const keysOf = (type) => {
  const r = spawnSync(PYTHON, ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'backend'))}); import log_viewer; reg = log_viewer.PARSERS[${JSON.stringify(type)}]; out = []\nfor k, v in reg.items():\n    out.append(k)\n    out.extend(v.get('sub_tabs', {}).keys())\nprint(json.dumps(out))`], { encoding: 'utf8', cwd: REPO });
  return JSON.parse(r.stdout || '[]');
};
const REPORT_TYPES = (process.env.UI_REPORTS || 'sosreport,mustgather').split(',');
const ONLY = process.env.UI_TABS ? new Set(process.env.UI_TABS.split(',')) : null;
const reports = {};
// The extra fixtures: a sosreport whose scheduler debug lists 16 CPUs (the chart's labels and axes), the old-format
// sosreport the generator writes (a manifest only: every tab without data) and an empty must-gather directory
const SIXTEEN = 'sosreport-sixteen-01-2026-10-13-sixcpu';
const EMPTY_MG = 'must-gather.local.0000000000';
// a sosreport whose scheduler debug lists N CPUs (built from the mock's 8 CPU blocks): CPU 7 with 50x the context
// switches and CPU 9 with a near-zero idle time (the outliers the chart colours and the Findings name)
const CPU_REPORTS = { 16: SIXTEEN, 64: 'sosreport-sixtyfour-01-2026-10-13-cpu64', 128: 'sosreport-onetwoeight-01-2026-10-13-cpu128', 256: 'sosreport-twofivesix-01-2026-10-13-cpu256' };
function withCpus(name, n) {
  fs.cpSync(path.join(work, NAMES.sosreport), path.join(work, name), { recursive: true });
  const sched = path.join(work, name, 'sys', 'kernel', 'debug', 'sched', 'debug');
  if (!fs.existsSync(sched)) return;
  const text = fs.readFileSync(sched, 'utf8');
  const head = text.slice(0, text.indexOf('cpu#0,'));
  const blocks = text.slice(text.indexOf('cpu#0,')).split(/(?=^cpu#\d+,)/m);
  const out = [];
  for (let i = 0; i < n; i++) {
    let b = blocks[i % blocks.length].replace(/cpu#\d+,/, `cpu#${i},`).replace(/(cfs_rq|rt_rq|dl_rq)\[\d+\]/g, `$1[${i}]`);
    b = b.replace(/\.nr_switches\s+:\s+\d+/, `.nr_switches                   : ${i === 7 ? 3500000000 : 60000000 + (i % 13) * 1000000}`);
    b = b.replace(/\.avg_idle\s+:\s+\d+/, `.avg_idle                      : ${i === 9 ? 3 : 400000 + (i % 7) * 50000}`);
    out.push(b);
  }
  fs.writeFileSync(sched, head + out.join(''));
}
if (fs.existsSync(path.join(work, NAMES.sosreport))) Object.entries(CPU_REPORTS).forEach(([n, name]) => withCpus(name, Number(n)));
fs.mkdirSync(path.join(work, EMPTY_MG), { recursive: true });
const EXTRA = [
  { name: SIXTEEN, type: 'sosreport', tabs: ['sched_debug', 'processes'], note: '16 CPUs' },
  { name: CPU_REPORTS[64], type: 'sosreport', tabs: ['sched_debug'], note: '64 CPUs' },
  { name: CPU_REPORTS[128], type: 'sosreport', tabs: ['sched_debug'], note: '128 CPUs' },
  { name: CPU_REPORTS[256], type: 'sosreport', tabs: ['sched_debug'], note: '256 CPUs' },
  { name: 'sosreport-old-01-2026-10-01-oldfmt', type: 'sosreport', tabs: null, note: 'no data' },
  { name: EMPTY_MG, type: 'mustgather', tabs: null, note: 'no data' },
];
const EXTRA_NAMES = new Set(EXTRA.map((e) => e.name));
const targets = REPORT_TYPES.map((type) => ({ name: NAMES[type], type, tabs: null })).concat(EXTRA.filter((e) => REPORT_TYPES.includes(e.type) && fs.existsSync(path.join(work, e.name))));
for (const t of targets) {
  const type = t.type;
  const keys = t.tabs || keysOf(type);
  const htmlDir = path.join(work, 'html-' + t.name);
  const ren = spawnSync(PYTHON, [path.join(REPO, 'tests', 'helpers', 'diagnostics-render.py'), '--out', htmlDir, '--fixture', path.join(work, t.name), '--report-type', type, '--tabs', ...keys], { encoding: 'utf8' });
  check(`every ${type} tab renders through Flask over ${t.note ? t.note + ' (' + t.name + ')' : 'the synthetic report'} (${keys.length} tabs)`, ren.status === 0, (ren.stderr || '').slice(-400));
  if (ren.status !== 0) continue;
  const html = Object.fromEntries(keys.map((k) => [k, fs.readFileSync(path.join(htmlDir, `${k}.html`), 'utf8')]));
  const tabs = JSON.parse(fs.readFileSync(path.join(htmlDir, 'tabs.json'), 'utf8'));
  reports[t.tabs || t.note ? t.name : type] = { name: t.name, path: '/tmp/diagnostics-ui/' + t.name, type, modified: 1760000000, keys, html, tabs, note: t.note || '' };
}
const PORT = Number(process.env.SMOKE_PORT || 5337);
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
const BASE = `http://localhost:${PORT}`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(BASE + '/')).ok; } catch { await sleep(250); } }
if (!ready) { vite.kill(); console.log('SKIP: Vite did not start'); process.exit(failed ? 1 : 0); }
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { vite.kill(); console.log('SKIP: no Chromium for playwright-core: ' + e.message.slice(0, 100)); process.exit(failed ? 1 : 0); }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };

// The Audit search answer: a lab-like histogram - two capture windows (2026-10-21 18:00 to 20:55 and 2026-10-23
// 03:40 to 04:56) 30 h 44 min apart in 5-minute buckets, 361,608 events in all, 17 status codes, 8 verbs - the
// shape that overflowed its card once (the chart box must follow the template's 110 px .au-hist)
const AUDIT_HIST = (() => {
  const step = 300;
  const buckets = [];
  let total = 0, errors = 0;
  const window = (day, h0, m0, h1, m1, per, first) => {
    for (let m = h0 * 60 + m0; m <= h1 * 60 + m1; m += 5) {
      const n = per + Math.round(Math.sin(m / 17) * per * 0.35);
      const e = Math.round(n * 0.028);
      total += n; errors += e;
      const hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = String(m % 60).padStart(2, '0');
      buckets.push({ t: `2026-10-${day}T${hh}:${mm}:00`, label: (m === h0 * 60 + m0 ? `10-${day} ` : '') + `${hh}:${mm}`, n, errors: e, start: m === h0 * 60 + m0, window: first ? 0 : 1 });
    }
  };
  window('21', 18, 0, 20, 55, 9300, true);
  const gap = { gap: true, from: '2026-10-21 21:00', to: '2026-10-23 03:40', minutes: 30 * 60 + 44, seconds: (30 * 60 + 44) * 60, label: 'no events for 30 h 44 min', index: buckets.length };
  buckets.push(gap);
  window('23', 3, 40, 4, 56, 3150, false);
  const codes = [['200', 0.78], ['201', 0.05], ['404', 0.04], ['403', 0.03], ['409', 0.02], ['422', 0.015], ['500', 0.01], ['503', 0.008], ['101', 0.007], ['301', 0.005], ['304', 0.005], ['400', 0.004], ['401', 0.004], ['410', 0.003], ['429', 0.002], ['502', 0.001], ['504', 0.001]]
    .map(([name, share]) => ({ name, count: Math.round(total * share), errors: /^[45]/.test(name) ? Math.round(total * share) : 0 }));
  const verbs = [['get', 0.52], ['list', 0.2], ['watch', 0.14], ['update', 0.05], ['patch', 0.04], ['create', 0.03], ['delete', 0.015], ['deletecollection', 0.005]].map(([name, share]) => ({ name, count: Math.round(total * share), errors: Math.round(total * share * 0.03) }));
  return { total, histogram: { buckets, step_seconds: step, step_minutes: 5, gaps: [gap], windows: [{ first: '2026-10-21 18:00', last: '2026-10-21 20:55', minutes: 176 }, { first: '2026-10-23 03:40', last: '2026-10-23 04:56', minutes: 77 }], max: 12555, mean: 4100, spikes: [], active_minutes: 253, wall_minutes: 2096, errors }, codes, verbs };
})();

// The delayed / failing answers of the busy checks
let delay = 0, failWith = null, loadTabDelay = 0;
// The Log Viewer's streamed entries (null: an empty load): 40 synthetic rows, 8 warnings among them
let logEntries = null;
const LOG_ENTRIES = Array.from({ length: 40 }, (_, i) => {
  const severity = i % 5 === 0 ? 'warning' : i % 11 === 3 ? 'error' : i === 17 ? 'critical' : i % 7 === 2 ? 'debug' : 'info';
  return { timestamp: `2026-10-12 14:${String(10 + Math.floor(i / 2)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`, severity, hostname: 'web-01', process: i % 3 ? 'systemd' : 'kernel', pid: 1000 + i, message: `synthetic line ${i} (${severity})` };
});
const served = [];
async function open(theme) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
  await context.addInitScript(({ theme }) => {
    try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', JSON.stringify(theme)); localStorage.setItem('diagnosticsReportsDirectory', '/tmp/diagnostics-ui'); localStorage.removeItem('diagnostics-page-session'); } catch { /* storage off */ }
  }, { theme });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/api/settings', (r) => r.fulfill({ json: { values: {}, secrets: {}, revision: 1, revisions: {} } }));
  await context.route('**/api/version', (r) => r.fulfill({ json: { app: '3.3.5', protocol: 2 } }));
  await context.route('**/api/capabilities', (r) => r.fulfill({ json: { auth: { mode: 'app-token' }, capabilities: { settings: true } } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  await context.route('http://localhost:8080/**', (r) => r.fulfill({ status: 404, json: { error: 'not faked' } }));
  await context.route('http://localhost:8080/health', (r) => r.fulfill({ json: { status: 'ok' } }));
  await context.route('http://localhost:8080/list_reports', (r) => r.fulfill({ json: { reports: Object.values(reports).map(({ name, path: p, type, modified }) => ({ name, path: p, type, modified })) } }));
  await context.route('http://localhost:8080/get_tabs', (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const rep = Object.values(reports).find((x) => x.path === body.directory) || Object.values(reports)[0]; r.fulfill({ json: { tabs: rep.tabs, report_type: rep.type, directory: rep.path } }); });
  await context.route('http://localhost:8080/get_tab_data', (r) => r.fulfill({ json: {} }));
  await context.route('http://localhost:8080/static/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: read('backend/static/styles.css') }));
  await context.route('http://localhost:8080/load_tab', async (r) => { let body = {}; try { body = r.request().postDataJSON() || {}; } catch { /* no body */ } const rep = Object.values(reports).find((x) => x.path === body.directory); const key = body.sub_tab || body.tab; served.push(key); if (loadTabDelay) await sleep(loadTabDelay); r.fulfill({ json: { html: (rep && rep.html[key]) || `<div class="panel rounded-lg shadow-sm"><p>${key} (not rendered)</p></div>` } }); });
  await context.route('http://localhost:8080/parse_log_viewer_stream', async (r) => { if (delay) await sleep(delay); r.fulfill({ status: 200, contentType: 'text/event-stream', body: (logEntries ? 'data: ' + JSON.stringify({ entries: logEntries }) + '\n\n' : '') + 'data: {"done": true}\n\n' }); });
  // the async actions, answered after `delay` ms (the busy checks) or with an error
  const answer = (json) => async (r) => { if (delay) await sleep(delay); if (failWith) { r.fulfill({ status: 500, json: { error: failWith } }); return; } r.fulfill({ json }); };
  await context.route('http://localhost:8080/audit_events_search', answer({ events: [], returned: 0, limit: 200, total: AUDIT_HIST.total, counted: true, has_more: false, cursor: '', sort: 'time_desc', files: 2, scanned_files: 2, skipped_files: 0, lines: AUDIT_HIST.total, seconds: 0.4, histogram: AUDIT_HIST.histogram, codes: AUDIT_HIST.codes, verbs: AUDIT_HIST.verbs }));
  await context.route('http://localhost:8080/audit_events_cancel', (r) => r.fulfill({ json: { ok: true } }));
  await context.route('http://localhost:8080/get_log_date_range', answer({ min_date: '2026-10-13', max_date: '2026-10-13', files: [] }));
  await context.route('http://localhost:8080/parse_haproxy_log', answer({ ok: true, entries: [], stats: {} }));
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
// The frame of the tab just opened: the iframe carries data-tab (DiagnosticsPage), its document is complete
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
  await sleep(700);
}
const resetWidth = async (page) => { await page.setViewportSize({ width: 1360, height: 900 }); await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); f.style.width = f.dataset.w || ''; }); await sleep(300); };

// The layout probe (the same as the Audit frame test's)
const layout = (frame) => frame.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const root = document.querySelector('#diagnostics-content') || document.body;
  const rect = (el) => el.getBoundingClientRect();
  const visible = (el) => { const r = rect(el); return r.width > 0 && r.height > 0; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const scroller = (el) => el.matches('pre, code, canvas, .au-raw, .au-cmd-text, .ui-sr, .au-sr, .ui-scroll') || !!el.closest('pre, code, .au-raw, .au-cmd-text, .ui-scroll');
  const clipped = []; const past = []; const tall = []; const headers = []; const painted = [];
  root.querySelectorAll('*').forEach((el) => {
    if (!visible(el)) return;
    if (el.tagName !== 'svg' && el.closest('svg')) return;   // a shape's box is the svg's business
    const r = rect(el);
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own || el.matches('canvas, svg, input, select, button, i, hr, .lc-stack, .au-bar')) painted.push([r.top + scrollY, r.bottom + scrollY]);
    if (scroller(el)) return;
    if (r.right > w + 1) { let clip = null; for (let p = el.parentElement; p && p !== root; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') { clip = p; break; } } if (!clip || rect(clip).right > w + 1) past.push(name(el) + ' right ' + Math.round(r.right)); }
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) { const cs = getComputedStyle(el); if (!(cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible') && !/(auto|scroll)/.test(cs.overflowX)) clipped.push(name(el) + ' ' + el.scrollWidth + '>' + el.clientWidth); }
    if (el.tagName === 'TD' && r.height > 90 && getComputedStyle(el).display !== 'block' && !el.closest('.au-ev-body, .au-body') && !el.querySelector('div, ul, table, pre, canvas') && !Array.from(el.parentElement.children).some((c) => c.querySelector('div, ul, table, pre, canvas'))) tall.push(name(el) + ' ' + Math.round(r.height) + 'px "' + el.textContent.trim().slice(0, 50) + '"');
    if (el.tagName === 'TH') { const wrap = el.closest('.ui-table-wrap, .au-table-wrap, .lc-table-wrap, .au-card, .panel, .overflow-x-auto') || root; if ((r.right > rect(wrap).right + 1 && !/(auto|scroll)/.test(getComputedStyle(wrap).overflowX)) || el.scrollWidth > el.clientWidth + 1) headers.push(name(el) + ' "' + el.textContent.trim() + '" right ' + Math.round(r.right) + ' > ' + Math.round(rect(wrap).right)); }
  });
  painted.sort((a, b) => a[0] - b[0]);
  const gaps = []; let bottom = 0;
  for (const [t, b] of painted) { if (t - bottom > 300) gaps.push(Math.round(bottom) + '-' + Math.round(t)); bottom = Math.max(bottom, b); }
  const total = document.body.scrollHeight;
  if (total - bottom > 300) gaps.push('tail ' + Math.round(bottom) + '-' + total);
  const pageOver = document.documentElement.scrollWidth > w + 1;
  const ok = !pageOver && !clipped.length && !past.length && !tall.length && !headers.length && !gaps.length;
  return { w, total, ok, pageOver, clipped: clipped.slice(0, 5), past: past.slice(0, 5), tall: tall.slice(0, 5), headers: headers.slice(0, 5), gaps, counts: { clipped: clipped.length, past: past.length, tall: tall.length, headers: headers.length } };
});

// The design probe: every visible control / header / card against the shared design, charts against the shared defaults
const design = (frame) => frame.evaluate(() => {
  const root = document.querySelector('#diagnostics-content') || document.body;
  const probe = document.createElement('div'); document.body.appendChild(probe);
  const col = (v) => { probe.style.backgroundColor = ''; probe.style.backgroundColor = v; return getComputedStyle(probe).backgroundColor; };
  const tok = (n) => col(`var(${n})`);
  const T = { inputBg: tok('--os-input-bg'), inputBorder: tok('--os-input-border'), border: tok('--os-border'), card: tok('--os-card'), card2: tok('--os-card-secondary'), text: tok('--os-text-primary'), text2: tok('--os-text-secondary'), accent: tok('--os-blue'),
    btn: ['primary', 'secondary', 'danger', 'danger-solid', 'ghost', 'warning', 'success', 'brand', 'quiet', 'selected'].map((r) => tok(`--btn-${r}-bg`)).concat(['rgba(0, 0, 0, 0)', 'transparent']) };
  probe.remove();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
  const bad = { inputs: [], selects: [], buttons: [], checks: [], ths: [], cards: [], charts: [] };
  const n = { inputs: 0, selects: 0, buttons: 0, checks: 0, ths: 0, cards: 0, charts: 0 };
  root.querySelectorAll('input[type="text"], input[type="search"], input[type="number"], input:not([type])').forEach((el) => {
    if (!vis(el)) return; n.inputs++;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const why = [];
    if (cs.borderTopLeftRadius !== '8px') why.push('radius ' + cs.borderTopLeftRadius);
    if (Math.round(r.height) !== 30) why.push('height ' + Math.round(r.height));
    if (cs.borderTopColor !== T.inputBorder) why.push('border ' + cs.borderTopColor);
    if (cs.backgroundColor !== T.inputBg) why.push('bg ' + cs.backgroundColor);
    if (cs.fontSize !== '13px') why.push('font ' + cs.fontSize);
    if (cs.boxShadow !== 'none') why.push('shadow');
    if (why.length) bad.inputs.push(name(el) + ': ' + why.join(', '));
  });
  root.querySelectorAll('select').forEach((el) => {
    if (!vis(el)) return; n.selects++;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const why = [];
    if (cs.borderTopLeftRadius !== '8px') why.push('radius ' + cs.borderTopLeftRadius);
    if (Math.round(r.height) !== 30) why.push('height ' + Math.round(r.height));
    if (cs.borderTopColor !== T.inputBorder) why.push('border ' + cs.borderTopColor);
    if (cs.backgroundColor !== T.inputBg) why.push('bg ' + cs.backgroundColor);
    if (cs.appearance !== 'none') why.push('appearance ' + cs.appearance);
    const wrap = el.closest('.ui-select-wrap');
    const svgs = wrap ? wrap.querySelectorAll('svg').length : 0;
    const hasImg = cs.backgroundImage !== 'none';
    if (!((wrap && svgs === 1 && !hasImg) || (!wrap && hasImg))) why.push('chevrons: svg ' + svgs + ', image ' + hasImg);
    if (why.length) bad.selects.push(name(el) + ': ' + why.join(', '));
  });
  root.querySelectorAll('button').forEach((el) => {
    if (!vis(el)) return; n.buttons++;
    const cs = getComputedStyle(el);
    const why = [];
    const bare = cs.borderTopWidth === '0px' && cs.backgroundColor === 'rgba(0, 0, 0, 0)' && !/\bbtn\b/.test(el.className);   // a text link or an icon button
    if (!bare) {
      if (cs.borderTopLeftRadius !== '8px' && cs.borderTopLeftRadius !== '999px' && cs.borderTopLeftRadius !== '9999px' && cs.borderTopLeftRadius !== '6px') why.push('radius ' + cs.borderTopLeftRadius);
      if (!T.btn.includes(cs.backgroundColor) && cs.backgroundColor !== T.card && cs.backgroundColor !== T.card2) why.push('bg ' + cs.backgroundColor);
    }
    if (why.length) bad.buttons.push(name(el) + ': ' + why.join(', '));
  });
  root.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    if (!vis(el)) return; n.checks++;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const why = [];
    if (Math.round(r.width) !== 16 || Math.round(r.height) !== 16) why.push('size ' + Math.round(r.width) + 'x' + Math.round(r.height));
    if (cs.borderTopLeftRadius !== '5px') why.push('radius ' + cs.borderTopLeftRadius);
    if (why.length) bad.checks.push(name(el) + ': ' + why.join(', '));
  });
  root.querySelectorAll('th, [role="columnheader"]').forEach((el) => {
    if (!vis(el)) return; n.ths++;
    const cs = getComputedStyle(el);
    const why = [];
    if (cs.fontSize !== '12px') why.push('font ' + cs.fontSize);
    if (cs.textTransform !== 'uppercase') why.push('case ' + cs.textTransform);
    if (cs.fontWeight !== '600') why.push('weight ' + cs.fontWeight);
    if (cs.backgroundColor !== T.card2) why.push('bg ' + cs.backgroundColor);
    if (cs.borderBottomWidth !== '1px' || cs.borderBottomColor !== T.border) why.push('border-bottom ' + cs.borderBottomWidth + ' ' + cs.borderBottomColor);
    if (cs.color !== T.text2 && cs.color !== T.text) why.push('colour ' + cs.color);
    if (why.length) bad.ths.push(name(el) + ' "' + el.textContent.trim().slice(0, 20) + '": ' + why.join(', '));
  });
  root.querySelectorAll('.panel, .ui-card').forEach((el) => {
    if (!vis(el)) return; n.cards++;
    const cs = getComputedStyle(el);
    const why = [];
    if (cs.borderTopWidth !== '1px' || cs.borderTopColor !== T.border) why.push('border ' + cs.borderTopWidth + ' ' + cs.borderTopColor);
    if (cs.backgroundColor !== T.card) why.push('bg ' + cs.backgroundColor);
    if (!['14px', '8px'].includes(cs.borderTopLeftRadius)) why.push('radius ' + cs.borderTopLeftRadius);
    // one card level: a card inside a card must be a plain section (no border, no own background), which the shared rules make it
    const inner = el.parentElement && el.parentElement.closest('.panel, .ui-card');
    if (inner && cs.borderTopWidth !== '0px') why.push('nested in ' + name(inner));
    if (inner) return;
    if (why.length) bad.cards.push(name(el) + ': ' + why.join(', '));
  });
  // the charts: the shared defaults, every label, no black / invisible fill, no line across a gap
  const charts = (window.Chart && window.Chart.instances ? Object.values(window.Chart.instances) : []).filter((c) => c.canvas && c.canvas.getBoundingClientRect().width > 0 && c.canvas.getBoundingClientRect().height > 0);
  charts.forEach((c) => {
    n.charts++;
    const why = [];
    const o = c.options || {};
    const legend = o.plugins && o.plugins.legend;
    if (!c.$diag) why.push('not built by diagChart');
    if (legend && legend.display !== false && !(legend.labels && legend.labels.usePointStyle === false && legend.labels.boxWidth === 10)) why.push('legend swatches');
    Object.entries(o.scales || {}).forEach(([k, s]) => {
      if (!s) return;
      if (c.config.type === 'bar' && s.type === 'category' && s.ticks && s.ticks.autoSkip !== false && (c.data.labels || []).length < 64) why.push(k + ' autoSkip');   // from 64 categories the labels thin to every Nth
      const want = window.diagChart ? window.diagChart.norm(window.diagnosticsThemeColor ? window.diagnosticsThemeColor('text') : '') : '';
      if (s.ticks && window.diagChart && window.diagChart.norm(s.ticks.color) !== want) why.push(k + ' tick colour ' + s.ticks.color + ' (want ' + want + ')');
    });
    (c.data.datasets || []).forEach((ds, i) => {
      if (c.config.type === 'line' && ds.spanGaps) why.push('dataset ' + i + ' spans gaps');
      if (c.config.type === 'line' && (ds.tension || 0) > 0.45) why.push('dataset ' + i + ' tension ' + ds.tension);
    });
    const canvas = c.canvas; const r = canvas.getBoundingClientRect(); const pr = canvas.parentElement.getBoundingClientRect();
    if (r.right > pr.right + 1) why.push('overflows its box');
    if (r.height < 40) why.push('too small ' + Math.round(r.height));
    // a black or fully transparent fill where a bar / point / line should be
    try {
      const meta = c.getDatasetMeta(0);
      const el = meta && meta.data && meta.data.find((d) => d && Number.isFinite(d.x) && Number.isFinite(d.y));
      if (el && c.config.type === 'bar') {
        const horizontal = c.options && c.options.indexAxis === 'y';
        const x = horizontal ? Math.round((el.x + el.base) / 2) : Math.round(el.x);
        const y = horizontal ? Math.round(el.y) : Math.round((el.base + el.y) / 2);
        const span = horizontal ? Math.abs(el.x - el.base) : Math.abs(el.base - el.y);
        if (span > 2) { const p = c.ctx.getImageData(x, y, 1, 1).data; if (p[3] === 0 || (p[0] + p[1] + p[2]) < 30) why.push('bar fill ' + Array.from(p).join(',')); }
      }
    } catch (e) { why.push('pixel read ' + e.message); }
    if (why.length) bad.charts.push((canvas.id || 'canvas') + ': ' + why.join(', '));
  });
  return { n, bad, T };
});

async function shot(page, name) { const file = path.join(OUT, `${LABEL}-${name}.png`); await page.screenshot({ path: file }); console.log(`  screenshot: ${file}`); }
// A screenshot of the pane as pixels (pngjs is a transitive dependency of the repo)
const PNG = (() => { try { return req('pngjs').PNG; } catch { return null; } })();
async function stripsUnderCards(page, frame, cards) {
  if (!PNG || !cards.length) return [];
  const problems = [];
  const fr = await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, vw: window.innerWidth, vh: window.innerHeight }; });
  const scroll = await frame.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  for (const c of cards.slice(0, 8)) {
    const top = fr.top + (c.bottom - scroll.y) + 3, left = fr.left + (c.left - scroll.x);
    const width = Math.min(c.right - c.left, fr.width - (c.left - scroll.x));
    if (top < fr.top || top > Math.min(fr.top + fr.height, fr.vh) - 2 || width < 20) continue;   // the strip is not in the viewport: nothing to sample
    const png = PNG.sync.read(await page.screenshot({ clip: { x: Math.max(0, left - 6), y: top, width: Math.min(width + 6, fr.vw - Math.max(0, left - 6)), height: 1 } }));
    const px = (i) => [png.data[i * 4], png.data[i * 4 + 1], png.data[i * 4 + 2]];
    const ref = px(1);   // the gutter beside the card: the page background on that row
    let off = 0;
    for (let i = 8; i < png.width - 2; i++) { const p = px(i); if (Math.abs(p[0] - ref[0]) + Math.abs(p[1] - ref[1]) + Math.abs(p[2] - ref[2]) > 24) off++; }
    if (off > Math.max(4, png.width * 0.02)) problems.push(`${c.name}: ${off} of ${png.width} pixels 3 px under the card are not the page background (rgb ${ref.join(',')})`);
  }
  return problems;
}
const labelOf = (rep, key) => { for (const t of rep.tabs) { if (t.tab_name === key) return { group: null, label: t.label.trim() }; for (const s of t.sub_tabs || []) if (s.tab_name === key) return { group: t.label.trim(), label: s.label.trim() }; } return null; };

try {
  for (const theme of ['dark', 'light']) {
    const { context, page, errors } = await open(theme);
    await clickButton(page, 'Tools'); await sleep(400); await clickButton(page, 'Diagnostics'); await sleep(600);
    for (const rep of Object.values(reports)) {
      const opened = await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name) && el.offsetParent); if (!b) return false; b.click(); return true; }, rep.name, { timeout: 20000 }).then(() => true).catch(() => false);
      check(`${theme}: the ${rep.type} report opens`, opened);
      await page.waitForFunction(() => document.querySelectorAll('div.cursor-pointer span').length > 3, null, { timeout: 20000 }).catch(() => {});
      await sleep(400);
      for (const key of rep.keys) {
        if (ONLY && !ONLY.has(key)) continue;
        const where = labelOf(rep, key);
        if (!where) { check(`${theme}: ${rep.type}/${key} is in the sidebar`, false); continue; }
        if (where.group) { await expandGroup(page, where.group); await sleep(200); await clickSidebar(page, where.label, where.group); } else { await clickSidebar(page, where.label); }
        const frame = await frameFor(page, key);
        check(`${theme}: ${rep.type}/${key} (${where.label}) renders in the frame`, !!frame);
        if (!frame) continue;
        await sleep(900);
        const d = await design(frame);
        const total = Object.values(d.bad).reduce((s, a) => s + a.length, 0);
        check(`${theme}: ${rep.type}/${key}: every visible control follows the shared design (${d.n.inputs} inputs, ${d.n.selects} selects, ${d.n.buttons} buttons, ${d.n.checks} checkboxes, ${d.n.ths} headers, ${d.n.cards} cards, ${d.n.charts} charts; one card level)`,
          total === 0, JSON.stringify(d.bad).slice(0, 1200));
        const tag = `${theme}: ${rep.type}/${key}${rep.note ? ' (' + rep.note + ')' : ''}`;
        // the Audit page: a filtered search draws the mocked two-window histogram (the gap, the 300k-scale counts)
        if (key === 'audit') { await frame.evaluate(() => { const v = document.getElementById('ae-verb'); if (v && v.options.length > 1) { v.selectedIndex = 1; v.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.getElementById('ae-search'); if (b) b.click(); }); await page.waitForTimeout(1500); }
        const wide = await (async () => { await frameWidth(page, 1920); const r = await layout(frame); return r; })();
        const pw = await probeComponents(frame, { width: 1920 });
        const cw = await containment(frame);
        const strips = cw.n.canvases ? await stripsUnderCards(page, frame, cw.cards) : [];
        const rc = await roleColours(frame);
        if (rc.charts || rc.problems.length) check(`${tag}: every chart's role colours are the theme's --chart-<role> tokens, the WARN badge border and the warn finding accent are --chart-warn, the meters' fills are the role tokens (${rc.charts} charts)`, rc.problems.length === 0, rc.problems.join(' | ').slice(0, 1200));
        const fc = await fontCheck(frame);
        check(`${tag}: the frame renders in the app's fonts (Sora / Red Hat Text / Red Hat Mono loaded, --font-sans resolves, ${fc.sampled} sampled elements in those families, no serif fallback)`, fc.problems.length === 0, fc.problems.join(' | ').slice(0, 800));
        const s0 = await stability(frame);
        const narrow = await (async () => { await frameWidth(page, 420); const r = await layout(frame); return r; })();
        const pn = await probeComponents(frame, { width: 420 });
        const cn = await containment(frame);
        check(`${tag}: the layout probe is clean at 1920 and 420 (nothing clipped, past the edge, no tall cell, no header overflow, no blank run)`, wide.ok && narrow.ok, JSON.stringify({ wide: wide.ok ? 'ok' : wide, narrow: narrow.ok ? 'ok' : narrow }).slice(0, 1200));
        const comp = (field, label) => { const bad = pw[field].map((x) => '1920: ' + x).concat(pn[field].map((x) => '420: ' + x)); check(`${tag}: ${label} (${pw.n[field === 'findings' ? 'findingsItems' : field] || 0})`, bad.length === 0, bad.slice(0, 6).join(' | ').slice(0, 1200)); };
        if (key === 'audit' && await frame.evaluate(() => !!document.getElementById('audit-events-hist-note'))) check(`${tag}: the filtered search drew the two-window histogram with its gap note below the chart`, await frame.evaluate(() => { const n = document.getElementById('audit-events-hist-note'); const c = document.getElementById('audit-events-hist'); return !!(n && c && /no events for 30 h 44 min/.test(n.textContent) && n.getBoundingClientRect().top >= c.getBoundingClientRect().bottom - 1); }), await frame.evaluate(() => { const n = document.getElementById('audit-events-hist-note'); return n ? n.textContent.slice(0, 120) : 'no note'; }));
        if (cw.n.canvases || cn.n.canvases) check(`${tag}: every chart canvas lies inside its card and its box, no two cards overlap, no canvas over anything outside its card, and the pixels under each chart card are the page background (${cw.n.canvases} canvases, ${cw.n.cards} cards)`, cw.problems.length === 0 && cn.problems.length === 0 && strips.length === 0, cw.problems.map((x) => '1920: ' + x).concat(cn.problems.map((x) => '420: ' + x), strips).slice(0, 6).join(' | ').slice(0, 1200));
        comp('findings', 'the Findings strip is the first thing on the page with 1+ item');
        comp('empty', 'no empty-state block, wording or empty canvas (the strip says what is missing)');
        comp('charts', 'every chart in a fixed-height box under the cap, radial charts without axes, legend swatches = dataset colours, every category label shown without overlap, 3+ value ticks, stacked segments distinct, the grid 3 columns wide / 1 narrow with equal card heights');
        comp('tables', 'every table in the rounded bordered box with uniform single-line row heights');
        comp('sorts', 'a sortable table shows exactly one sort marker, non-sortable headers do not look clickable');
        comp('pagers', 'the shared pager: 30px buttons at least 28px wide, one current page (btn-selected), the ends disabled, no interactive ellipsis, chevron icons, "Page N of M" only under 640, none outside the component');
        comp('filters', 'the filter bar: one row at 1920 (up to 6 items), selects under 260px and the search under 360px, uniform gaps, no stacked label, every control named, no overflow at 420');
        comp('meters', 'every meter with a value has a visible fill distinct from the track, proportional to the value, and a warn / bad role matches a Finding of that severity');
        comp('chips', 'every chip has a border, a background, a gap to its neighbour, 4.5:1 text, a visible dot; the active chip is the selected role');
        comp('band', 'the Log Collection band: distinct non-transparent segments, legend swatch = segment, section dots = chip dots');
        comp('xrows', 'expandable rows carry the chevron header and button, a panel, Expand / Collapse all, no raw "Details:" label, none outside the component');
        if (rep.note === 'no data') check(`${tag}: a report without data keeps the page short (under 1.5 viewports wide; the narrow layout stacks the reference tables)`, wide.total < 1.5 * 1000 && narrow.total < 3 * 900, JSON.stringify({ wide: wide.total, narrow: narrow.total }));
        if (key === 'sched_debug' && /CPUs$/.test(rep.note || '')) {
          const n = parseInt(rep.note, 10);
          await frameWidth(page, 1920); await sleep(400);
          const r = await frame.evaluate((n) => {
            const out = [];
            const warn = (() => { const p = document.createElement('div'); document.body.appendChild(p); p.style.backgroundColor = window.diagChart.palette().warn; const c = getComputedStyle(p).backgroundColor; p.remove(); return c; })();
            const rgb = (c) => { const t = document.createElement('span'); t.style.color = 'rgb(1, 2, 3)'; t.style.color = String(c); document.body.appendChild(t); const cs = getComputedStyle(t).color; t.remove(); const m = (cs.match(/[\d.]+/g) || []).slice(0, 3).map(Number); return (/^color\(srgb/.test(cs) ? m.map((x) => Math.round(x * 255)) : m).join(','); };   // the opaque channels (a bar's fill carries alpha)
            for (const id of ['nrSwitchesChart', 'nrRunningChart', 'avgIdleChart']) {
              const c = window.Chart && window.Chart.getChart(document.getElementById(id));
              if (!c) { out.push(id + ': no chart'); continue; }
              const card = c.canvas.closest('[data-chart-card]'); const grid = card && card.closest('.ui-grid-charts');
              const cw = card.getBoundingClientRect().width, gw = grid ? grid.getBoundingClientRect().width : 0;
              if (!grid || cw < 0.95 * gw) out.push(id + ': card ' + Math.round(cw) + 'px of the grid ' + Math.round(gw));
              if (c.data.labels.length !== n || c.data.datasets[0].data.length !== n) out.push(id + ': ' + c.data.labels.length + ' labels / ' + c.data.datasets[0].data.length + ' values for ' + n + ' CPUs');
              const meta = c.getDatasetMeta(0);
              if (meta.data.length !== n) out.push(id + ': ' + meta.data.length + ' bars');
              const h = c.canvas.getBoundingClientRect().height; if (h > 482) out.push(id + ': ' + Math.round(h) + 'px tall');
              const ticks = c.scales.x.ticks.length; if ((n < 64 && ticks !== n) || (n >= 64 && (ticks < 8 || ticks > 64))) out.push(id + ': ' + ticks + ' labels shown');
              let unreachable = 0;
              for (let i = 0; i < n; i++) { const e = meta.data[i]; const hits = c.getElementsAtEventForMode({ native: true, x: e.x, y: Math.min(e.y + 2, c.chartArea.bottom - 1) }, 'index', { intersect: false }, false); if (!hits.length || hits[0].index !== i) unreachable++; }
              if (unreachable) out.push(id + ': ' + unreachable + ' CPUs not reachable by hover');
              const bg = meta.data[7] && meta.data[7].options ? meta.data[7].options.backgroundColor : null;
              if (id === 'nrSwitchesChart' && (!bg || rgb(bg) !== rgb(warn))) out.push(id + ': CPU 7 (the switches outlier) is ' + bg + ', not the warn colour ' + warn);
              const bg9 = meta.data[9] && meta.data[9].options ? meta.data[9].options.backgroundColor : null;
              if (id === 'avgIdleChart' && n > 9 && (!bg9 || rgb(bg9) !== rgb(warn))) out.push(id + ': CPU 9 (the idle outlier) is ' + bg9 + ', not the warn colour');
            }
            const strip = (document.querySelector('.ui-findings') || {}).textContent || '';
            if (!/cpu7/.test(strip)) out.push('the Findings do not name cpu7 (context switches far above the median)');
            if (n > 9 && !/cpu9/.test(strip)) out.push('the Findings do not name cpu9 (near-zero idle)');
            return out;
          }, n);
          check(`${tag}: each per-CPU chart spans the whole chart grid (>= 95%), draws one bar per CPU, stays under the height cap, shows ${n < 64 ? 'every' : 'every Nth'} CPU label, is reachable by hover on every bar, and colours the outliers (cpu7 switches, cpu9 idle) in the warn colour with the Findings naming them`, r.length === 0, r.join(' | ').slice(0, 900));
          await resetWidth(page);
        }
        if (key === 'cstates') { const legend = await frame.evaluate(() => { const d = document.getElementById('cstates-legend'); return d ? { open: d.open, rows: d.querySelectorAll('tbody tr').length, visible: d.getBoundingClientRect().height > 40 } : null; }); check(`${tag}: the C-States legend is on the page, open on load, as a table`, legend && legend.open && legend.rows >= 6 && legend.visible, JSON.stringify(legend)); }
        // the cross-link target: a page marks at most ONE field with data-ui-search (diagLinks puts a Findings row's query there)
        const searchFields = await frame.evaluate(() => document.querySelectorAll('[data-ui-search]').length);
        check(`${theme}: ${rep.type}/${key}: at most one data-ui-search field (${searchFields})`, searchFields <= 1);
        const hasTable = await frame.evaluate(() => !!document.querySelector('#diagnostics-content table, #diagnostics-content .au-ev-head'));
        if (hasTable) await shot(page, `${rep.type}${rep.note ? '-' + rep.note.replace(/\s+/g, '') : ''}-${key}-narrow-420-${theme}`);
        await resetWidth(page);
        const cm = await containment(frame);
        if (cm.n.canvases) check(`${tag}: at 1360 too, every chart canvas lies inside its card and no card overlaps another`, cm.problems.length === 0, cm.problems.slice(0, 6).join(' | ').slice(0, 800));
        await page.evaluate(() => { const sc = document.querySelector('iframe[title="Diagnostics content"]'); let s = sc.parentElement; while (s && !(s.scrollHeight > s.clientHeight + 2)) s = s.parentElement; if (s) s.scrollTop = 0; });
        await shot(page, `${rep.type}${rep.note ? '-' + rep.note.replace(/\s+/g, '') : ''}-${key}-wide-${theme}`);
        if (d.n.charts) {
          for (let i = 0; i < 5; i++) { await page.evaluate(() => document.documentElement.classList.toggle('dark')); await sleep(250); }
          await sleep(500);
          const again = await design(frame);
          check(`${tag}: after five theme toggles the ${again.n.charts} chart(s) keep the shared look (no black fill, tick colours re-themed)`, again.bad.charts.length === 0, JSON.stringify(again.bad.charts).slice(0, 800));
          if (!(await page.evaluate((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme))) { await page.evaluate(() => document.documentElement.classList.toggle('dark')); await sleep(250); }
          // the legend swatches after the toggles still equal the datasets
          const pt = await probeComponents(frame, { width: 1360 });
          check(`${tag}: after the theme toggles the legend swatches still equal the dataset colours and the stacked segments stay distinct`, pt.charts.length === 0, pt.charts.slice(0, 4).join(' | ').slice(0, 800));
          // stability: the same canvas heights as at 1920 after the resizes, the toggles and a 2 s wait (a frame that sizes itself to its content never grows them)
          await frameWidth(page, 1920); await sleep(2000);
          const s1 = await stability(frame);
          const grew = s1.charts.filter(([id, h]) => { const b = s0.charts.find((x) => x[0] === id); return b && h > b[1] + 2; });
          check(`${tag}: after 2 s, the resizes and the theme toggles no chart grew and the frame's height is within 3% of its first measure (${s0.charts.length} charts)`, grew.length === 0 && Math.abs(s1.frame - s0.frame) <= Math.max(24, 0.03 * s0.frame), JSON.stringify({ grew, frame: [s0.frame, s1.frame] }).slice(0, 600));
          await resetWidth(page);
        }
        // the interactions: every details toggles, expandable rows, a sort click, the pager
        const det = await toggleDetails(frame);
        if (det.count) check(`${tag}: every details (${det.count}) opens and closes on a click, its content shows and the document follows`, det.problems.length === 0, det.problems.slice(0, 4).join(' | ').slice(0, 800));
        const xr = await exerciseXrows(frame);
        if (xr.tables) check(`${tag}: expandable rows (${xr.tables} tables) open by click and keyboard with aria-expanded, the panel flush with the first content column, the accent on the open row, Expand all / Collapse all`, xr.problems.length === 0, xr.problems.slice(0, 4).join(' | ').slice(0, 800));
        const so = await exerciseSort(frame);
        if (so.tried) check(`${tag}: clicking another sortable header moves the marker and reorders the rows (${so.tried} tables)`, so.problems.length === 0, so.problems.slice(0, 4).join(' | ').slice(0, 800));
        const pg = await exercisePager(frame);
        if (pg.tried) check(`${tag}: the pager goes to page 2 on a click (current moves, the ends enable) and back with Prev (${pg.tried})`, pg.problems.length === 0, pg.problems.slice(0, 4).join(' | ').slice(0, 800));
        if (key === 'processes' || key === 'events') { const bs = await barSizingCheck(frame); check(`${tag}: the shared bar sizing on 1 / 2 / 3 / 5 / 16 / 64 / 256 categories: bars at least 2 px wide, never touching, no wider with more categories, a 1 next to 100,000 still 2 px tall`, bs.length === 0, bs.join(' | ')); }
        if (key === 'log_viewer') { const shapes = await pagerShapes(frame); check(`${tag}: the shared pager on 27,527 rows: [1] 2 3 … 276 on page 1, 1 … 136 137 [138] 139 140 … 276 in the middle, 1 … 274 275 [276] at the end with Next / Last disabled, the go-to box jumps on Enter, one page hides it`, shapes.length === 0, shapes.join(' | ')); }
      }
      // back to the report list for the next report
      await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => /Load different report/.test(el.textContent) && el.offsetParent); if (b) b.click(); });
      await sleep(600);
    }
    // ---- the busy state where a plugin waits: the Log Viewer's load (a stream through the parent proxy), haproxy's log parse, the tab load itself ----
    if (reports.sosreport && !process.env.UI_EXTRA_ONLY && (!ONLY || ONLY.has('log_viewer'))) {
      await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name) && el.offsetParent); if (!b) return false; b.click(); return true; }, reports.sosreport.name, { timeout: 20000 }).catch(() => {});
      await page.waitForFunction(() => document.querySelectorAll('div.cursor-pointer span').length > 3, null, { timeout: 20000 }).catch(() => {});
      await sleep(400);
      await expandGroup(page, 'Log Collection'); await sleep(200); await clickSidebar(page, 'Log Viewer', 'Log Collection');
      const lv = await frameFor(page, 'log_viewer');
      if (lv) {
        await sleep(600);
        delay = 1500;
        const picked = await lv.evaluate(() => { const c = document.querySelector('.log-file-checkbox'); if (!c) return false; if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } return true; });
        await lv.evaluate(() => document.getElementById('load-logs-btn').click());
        await sleep(600);
        const pw = await page.evaluate(() => { const f = document.querySelector('iframe[title="Diagnostics content"]'); let sc = f.parentElement; while (sc && !(sc.scrollHeight > sc.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement; const s = sc || document.scrollingElement; const sr = s.getBoundingClientRect(); const fr = f.getBoundingClientRect(); return { top: sr.top, bottom: sr.bottom, frameTop: fr.top }; });
        const b1 = await lv.evaluate(() => { const pill = document.getElementById('ui-busy-pill'); const bar = document.querySelector('.ui-progress'); const t = document.getElementById('log-table-container'); return { btn: document.getElementById('load-logs-btn').textContent.trim(), danger: document.getElementById('load-logs-btn').classList.contains('btn-danger-solid'), pill: pill ? { hidden: pill.hidden, text: pill.textContent.trim(), top: pill.getBoundingClientRect().top, cancel: !document.getElementById('ui-busy-cancel').hidden } : null, bar: bar ? { h: getComputedStyle(bar, '::before').height, bg: getComputedStyle(bar, '::before').backgroundColor } : null, busy: t && t.getAttribute('aria-busy'), live: (document.getElementById('ui-busy-live') || {}).textContent }; });
        for (let i = 0; i < 40; i++) { const done = await lv.evaluate(() => document.getElementById('load-logs-btn').textContent.trim() === 'Load Logs'); if (done) break; await sleep(100); }
        await sleep(300);
        const b2 = await lv.evaluate(() => { const pill = document.getElementById('ui-busy-pill'); return { btn: document.getElementById('load-logs-btn').textContent.trim(), pill: pill ? pill.hidden : null, bars: document.querySelectorAll('.ui-progress').length, busy: document.getElementById('log-table-container').getAttribute('aria-busy'), live: (document.getElementById('ui-busy-live') || {}).textContent }; });
        check(`${theme}: Log Viewer: while Load Logs streams (answer delayed 1.5 s) the button reads "Abort Loading" in the danger role, the toolbar carries the progress bar, the table is aria-busy and the shared pill "Loading logs… N s" with Cancel sits inside the pane; on completion everything clears and the live region says what loaded`,
          picked && b1.btn === 'Abort Loading' && b1.danger && b1.pill && !b1.pill.hidden && /^Loading logs… \d+\.\d s/.test(b1.pill.text) && b1.pill.cancel && (pw.frameTop + b1.pill.top) > pw.top && (pw.frameTop + b1.pill.top) < pw.bottom && b1.bar && b1.bar.h === '2px' && b1.bar.bg !== 'rgba(0, 0, 0, 0)' && b1.busy === 'true' && b2.btn === 'Load Logs' && b2.pill === true && b2.bars === 0 && b2.busy === 'false' && /entries|No entries/.test(b2.live), JSON.stringify({ picked, b1, b2, pw }).slice(0, 1200));
        // Cancel: the pill's button aborts the stream
        await lv.evaluate(() => document.getElementById('load-logs-btn').click()); await sleep(500);
        const c1 = await lv.evaluate(() => !document.getElementById('ui-busy-pill').hidden);
        await lv.evaluate(() => document.getElementById('ui-busy-cancel').click()); await sleep(200);
        const c2 = await lv.evaluate(() => ({ btn: document.getElementById('load-logs-btn').textContent.trim(), pill: document.getElementById('ui-busy-pill').hidden, busy: document.getElementById('log-table-container').getAttribute('aria-busy') }));
        check(`${theme}: Log Viewer: Cancel in the pill aborts the load (Load Logs again, no pill, the table not busy)`, c1 && c2.btn === 'Load Logs' && c2.pill && c2.busy === 'false', JSON.stringify({ c1, c2 }));
        delay = 0; await sleep(1700);
        // Logs per Severity: a load that streams entries draws the chart with the count on each bar, the warning bar in
        // the WARN badge's colour (the --chart-warn token its border is built from), and a click on the warning bar filters the table to it
        logEntries = LOG_ENTRIES;
        await lv.evaluate(() => document.getElementById('load-logs-btn').click());
        for (let i = 0; i < 60; i++) { const done = await lv.evaluate(() => document.getElementById('load-logs-btn').textContent.trim() === 'Load Logs' && document.querySelectorAll('#log-table-container tbody tr').length > 0); if (done) break; await sleep(100); }
        await sleep(500);
        const sev = await lv.evaluate(() => {
          const canvas = document.getElementById('severityChart'); const c = canvas && Chart.getChart(canvas); if (!c) return { chart: false };
          const rgb = (v) => { const t = document.createElement('span'); t.style.color = v; document.body.appendChild(t); const out = getComputedStyle(t).color.match(/[\d.]+/g).slice(0, 3).map(Number); t.remove(); return out; };
          const i = c.data.labels.findIndex((l) => /^warning$/i.test(l));
          const bar = c.getDatasetMeta(0).data[i];
          const card = canvas.closest('[data-chart-card]');
          const r = canvas.getBoundingClientRect();
          return { chart: true, shown: !!card && !card.hidden && r.height > 50, labels: !!(c.$diag && c.$diag.valueLabels), bar: bar ? rgb(bar.options.backgroundColor) : null, badge: rgb(getComputedStyle(document.documentElement).getPropertyValue('--chart-warn').trim() || 'transparent'), x: bar ? bar.x : 0, y: bar ? (bar.y + bar.base) / 2 : 0, value: c.data.datasets[0].data[i], sizing: !!c.data.datasets[0].maxBarThickness && c.data.datasets[0].minBarLength >= 2 };
        });
        const near = (a, b) => !!a && !!b && a.every((v, k) => Math.abs(v - b[k]) <= 6);
        check(`${theme}: Logs per Severity: 40 streamed entries draw the chart with the count on each bar, the shared bar sizing, the warning bar (8) in the WARN badge's colour`, sev.chart && sev.shown && sev.labels && sev.value === 8 && near(sev.bar, sev.badge) && sev.sizing, JSON.stringify(sev));
        if (sev.chart && sev.x) {
          await lv.locator('#severityChart').click({ position: { x: sev.x, y: sev.y } }); await sleep(600);
          const after = await lv.evaluate(() => { const rows = Array.from(document.querySelectorAll('#log-table-container tbody tr')).filter((r) => r.offsetParent !== null); return { filter: document.getElementById('severity-filter').value, rows: rows.length, all: rows.every((r) => r.dataset.severity === 'warning') }; });
          check(`${theme}: Logs per Severity: a click on the warning bar sets the severity filter to warning and the table shows the 8 warnings only`, after.filter === 'warning' && after.rows === 8 && after.all, JSON.stringify(after));
          await lv.locator('#severityChart').click({ position: { x: sev.x, y: sev.y } }); await sleep(300);
          const back = await lv.evaluate(() => document.getElementById('severity-filter').value);
          check(`${theme}: Logs per Severity: the second click on the same bar clears the filter`, back === '', back);
        }
        await shot(page, `${theme}-log_viewer-severity`);
        logEntries = null;
      } else check(`${theme}: the Log Viewer opens for the busy checks`, false);
      // haproxy: a log parse through the proxy, the select's wrapper shows the spinner
      await expandGroup(page, 'OpenStack'); await sleep(200); await clickSidebar(page, 'HAProxy', 'OpenStack');
      const hp = await frameFor(page, 'haproxy');
      if (hp) {
        await sleep(600);
        const options = await hp.evaluate(() => { const s = document.getElementById('logFileSelect'); return s ? s.options.length : 0; });
        if (options >= 2) {
          delay = 1500;
          await hp.evaluate(() => { const s = document.getElementById('logFileSelect'); s.selectedIndex = s.selectedIndex === 1 ? 0 : 1; s.dispatchEvent(new Event('change')); if (typeof updateLogFile === 'function') updateLogFile(); });
          await sleep(600);
          const h1 = await hp.evaluate(() => { const pill = document.getElementById('ui-busy-pill'); const s = document.getElementById('logFileSelect'); const wrap = s.closest('.ui-select-wrap') || s.parentElement; return { pill: pill ? { hidden: pill.hidden, text: pill.textContent.trim() } : null, loading: wrap.classList.contains('ui-loading'), bars: document.querySelectorAll('.ui-progress').length }; });
          for (let i = 0; i < 40; i++) { const done = await hp.evaluate(() => { const p = document.getElementById('ui-busy-pill'); return !p || p.hidden; }); if (done && i > 10) break; await sleep(100); }
          await sleep(300);
          const h2 = await hp.evaluate(() => ({ pill: document.getElementById('ui-busy-pill').hidden, loading: document.querySelectorAll('.ui-loading').length, bars: document.querySelectorAll('.ui-progress').length }));
          check(`${theme}: haproxy: while the log parse is pending the file select's wrapper shows the spinner and the pill "Loading… N s"; cleared on completion`, h1.pill && !h1.pill.hidden && /^Loading… \d+\.\d s/.test(h1.pill.text) && h1.loading && h2.pill && h2.loading === 0 && h2.bars === 0, JSON.stringify({ h1, h2 }));
          delay = 0;
        } else console.log(`INFO  ${theme}: haproxy has ${options} log file option(s): the parse busy check needs two, skipped`);
      } else check(`${theme}: haproxy opens for the busy checks`, false);
      // the tab load itself: the parent's pill "Loading Blame… N s" while the backend renders (answer delayed 1.5 s)
      loadTabDelay = 1500;
      await expandGroup(page, 'Sos Report'); await sleep(200); await clickSidebar(page, 'Blame', 'Sos Report');
      await sleep(800);
      const p1 = await page.evaluate(() => { const p = document.querySelector('[data-testid="diagnostics-loading-pill"]'); return p ? { text: p.textContent.trim(), cls: p.className, top: p.getBoundingClientRect().top, vh: window.innerHeight } : null; });
      await frameFor(page, 'blame'); await sleep(400);
      const p2 = await page.evaluate(() => !!document.querySelector('[data-testid="diagnostics-loading-pill"]'));
      check(`${theme}: the tab load shows the parent's pill "Loading Blame… N s" at the bottom of the pane while the backend renders, and it goes when the frame arrives`, p1 && /^Loading Blame… \d+\.\d s$/.test(p1.text) && /ui-busy-pill/.test(p1.cls) && p1.top > p1.vh - 120 && !p2, JSON.stringify({ p1, p2 }));
      loadTabDelay = 0;
    }
    // ---- the Findings strip's cross-link: Services' failed unit -> "Open" -> the Log Viewer with the unit's name in its search field (diagLinks + the open-tab bridge with a query) ----
    if (reports.sosreport && !process.env.UI_EXTRA_ONLY && (!ONLY || ONLY.has('services'))) {
      await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => /Load different report/.test(el.textContent) && el.offsetParent); if (b) b.click(); });
      await sleep(600);
      await page.waitForFunction((name) => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(name) && el.offsetParent); if (!b) return false; b.click(); return true; }, reports.sosreport.name, { timeout: 20000 }).catch(() => {});
      await page.waitForFunction(() => document.querySelectorAll('div.cursor-pointer span').length > 3, null, { timeout: 20000 }).catch(() => {});
      await sleep(400);
      await expandGroup(page, 'System'); await sleep(200); await clickSidebar(page, 'Services', 'System');
      const sv = await frameFor(page, 'services');
      const link = sv ? await sv.evaluate(() => { const strip = document.querySelector('.ui-findings'); const b = strip && strip.querySelector('.ui-finding-link[data-tab="log_collection"][data-sub-tab="log_viewer"]'); if (!b) return null; const row = b.closest('.ui-finding'); return { query: b.getAttribute('data-query'), severity: row.className, title: row.querySelector('.ui-finding-title').textContent, first: strip.querySelector('.ui-finding') === row, rows: strip.querySelectorAll('.ui-finding').length, badge: row.querySelector('.ui-badge').textContent.trim(), accent: getComputedStyle(row).borderLeftWidth + ' ' + getComputedStyle(row).borderLeftColor }; }) : null;
      check(`${theme}: the Services page opens with the Findings strip first: the failed unit's row (bad, a 3px left accent, the BAD badge) carries an Open link to the Log Viewer with the unit's name`, link && link.first && /ui-finding-bad/.test(link.severity) && /failed$/.test(link.title) && link.query && link.badge === 'BAD' && /^3px /.test(link.accent), JSON.stringify(link));
      if (link) {
        await sv.evaluate(() => document.querySelector('.ui-finding-link[data-tab="log_collection"][data-sub-tab="log_viewer"]').click());
        const lv2 = await frameFor(page, 'log_viewer');
        let applied = null;
        for (let i = 0; i < 30 && lv2; i++) { applied = await lv2.evaluate(() => { const f = document.querySelector('[data-ui-search]'); return f ? f.value : null; }).catch(() => null); if (applied) break; await sleep(200); }
        const side = await page.evaluate(() => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === 'Log Viewer'); return !!s; });
        check(`${theme}: Open switches the pane to Log Collection > Log Viewer and the unit's name lands in the page's data-ui-search field`, !!lv2 && side && applied === link.query, JSON.stringify({ applied, query: link.query, side }));
      }
    }
    check(`${theme}: no page errors across every tab`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }
} finally {
  await stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
