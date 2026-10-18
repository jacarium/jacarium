#!/usr/bin/env node
/**
 * The Diagnostics Log Viewer's header and filters
 * (backend/templates/tabs/sosreport_log_viewer.html), in the real app frame.
 *
 * THE BUGS:
 *   - The date-range slider had no line: its track and the selected-range
 *     highlight were styled with utility classes (h-1.5, top-1/2,
 *     -translate-y-1/2, bg-blue-500, dark:bg-gray-600) that only this
 *     template uses. The diagnostics frame gets the APP's compiled Tailwind,
 *     which scans src/ only, so those classes did not exist there: two
 *     handles over nothing. The header's controls sat in separate columns
 *     with blank labels, the status floated loose, the two filter fields
 *     carried their whole syntax as a placeholder and were cut off.
 *   - The filters: a quote anywhere opened a phrase, so an apostrophe
 *     ("can't reach") swallowed the rest of the field; a backslash escaped
 *     ANY character, so C:\temp searched for C:temp; the level list shrank
 *     to the chosen level (a change had to go through "All Levels"); after
 *     a reload with a filter set the table, the counts and the export kept
 *     the OLD rows (the filters were only re-applied when every field was
 *     empty); every keystroke re-joined every column of every row per term
 *     (no debounce, no cached text); the shown count never said it was
 *     filtered.
 *
 * Static: the template's slider and controls use the lv-* rules (no
 * utility class the frame lacks), the ids the script and the driver
 * scripts rely on are present, the placeholders are short and the syntax
 * is in the hint; the field parser (extracted from the template and run
 * here) handles commas, quotes, apostrophes, escapes and backslashes.
 *
 * Live (Vite + the Flask backend + the synthetic fixture, like
 * tests/diagnostics-frame-theme.test.mjs; the sandboxed frame is its own
 * CDP target): in dark and light the track and the highlight render with
 * a size and a colour, the handles sit centred on the line, the labels line
 * up with it, the toolbar and the filter row share one height and one
 * baseline, Load Logs is the accent button, the row wraps when narrow;
 * then the 3,400-row fixture is loaded and every filter is checked against
 * counts computed from the fixture's own formulas: search terms, case,
 * commas, quoted phrases, apostrophes, regex characters, backslashes,
 * escaped quotes, trailing commas, exclude, exclude with search, each
 * level, the process list and a process, all together, the counts against
 * "Loaded N entries", debounced typing, a reload with filters set, and a
 * changed date range.
 *
 * SKIPS (exit 0) without Chrome, without backend/venv or when :5173/:8080
 * are busy. Run: node tests/log-viewer-header.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDocumentsApp, sleep } from './helpers/live-documents-app.mjs';
import { startFlask, makeFixture, dismissWhatsNew, VITE_PORT } from './helpers/visual-snapshots.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = '/tmp/diag-reports';
const FIXTURE_REPORT = 'sosreport-synthetic-2026';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const template = fs.readFileSync(path.join(REPO, 'backend', 'templates', 'tabs', 'sosreport_log_viewer.html'), 'utf8');

// ---- static ----
{
  const header = template.slice(template.indexOf('<!-- Date Range Filter -->'), template.indexOf('<!-- Log Table -->'));
  check('the slider track, highlight and inputs are styled by the template\'s own lv-* rules, not by utility classes the frame lacks', /class="lv-slider-track"/.test(header) && /id="date-range-highlight" class="lv-slider-highlight"/.test(header) && !/class="[^"]*(?:h-1\.5|top-1\/2|-translate-y-1\/2|bg-blue-500|bg-gray-300|dark:bg-gray-600)/.test(header));
  const ids = ['single-date-button', 'single-date-display', 'date-calendar', 'cal-prev-month', 'cal-next-month', 'cal-month-year', 'cal-grid', 'cal-today', 'cal-clear', 'date-start-label', 'date-end-label', 'date-slider-container', 'date-range-highlight', 'date-slider-start', 'date-slider-end', 'log-file-dropdown-btn', 'log-file-selection-display', 'log-file-dropdown-panel', 'log-file-search', 'log-file-list', 'select-all-logs', 'clear-all-logs', 'get-range-btn', 'load-logs-btn', 'export-csv-btn', 'loading-indicator', 'logs-loaded-info', 'loaded-count', 'filter-panel', 'log-search', 'log-exclude', 'severity-filter', 'process-filter'];
  const missing = ids.filter((id) => (template.match(new RegExp(`id="${id}"`, 'g')) || []).length !== 1);
  check('every element id the script, the driver scripts and the tests rely on is present exactly once', missing.length === 0, missing.join(','));
  const placeholders = [...header.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]).filter((p) => !/log files/i.test(p));
  check('the two filter fields have short placeholders ("Search logs", "Filter out"); the syntax lives in the hint and the tooltips', placeholders.join('|') === 'Search logs|Filter out' && /id="filter-syntax-hint"[^>]*title="[^"]*commas[^"]*quotes[^"]*backslash/.test(header), placeholders.join('|'));
  check('the driver script still finds the search field by its placeholder', fs.readFileSync(path.join(REPO, 'tests', 'helpers', 'diagnostics-driver', 'logviewer_filter.js'), 'utf8').includes("startsWith('Search logs')"));
  check('Load Logs is the accent button, the actions are grouped, the status sits in the toolbar', /id="load-logs-btn"[^>]*lv-primary/.test(header) && /class="lv-actions">[\s\S]*id="get-range-btn"[\s\S]*id="load-logs-btn"[\s\S]*id="export-csv-btn"[\s\S]*<\/div>\s*<!-- Status Indicators -->\s*<div class="lv-status">/.test(header) && !/&nbsp;/.test(header));
  check('the export says what it exports (the rows the filters show) and exports filteredEntries', /id="export-csv-btn"[^>]*title="[^"]*rows the filters currently show/.test(header) && /exportCsvBtn\?\.addEventListener\('click'[\s\S]{0,600}filteredEntries\.forEach/.test(template));
  check('typing is debounced, the selects apply at once', /const applyFiltersSoon = debounce\(applyFilters, 150\);\s*searchInput\?\.addEventListener\('input', applyFiltersSoon\);\s*document\.getElementById\('log-exclude'\)\?\.addEventListener\('input', applyFiltersSoon\);\s*severityFilter\?\.addEventListener\('change', applyFilters\);/.test(template));
  check('a load re-applies the filters as set (no "only when every field is empty")', !/if \(!searchInput\.value && !severityFilter\.value && !processFilter\.value/.test(template));

  // the field parser, as the template defines it
  const start = template.indexOf('  function parseCommaSeparated(input) {');
  const end = template.indexOf('\n  }\n', start) + 4;
  const parse = new Function(template.slice(start, end) + '\nreturn parseCommaSeparated;')();
  const P = (s) => parse(s).join('|');
  check('parse: comma-separated terms, trimmed, lower-cased, empties dropped', P(' Error , FAIL,, ,timeout, ') === 'error|fail|timeout');
  check('parse: a quoted phrase keeps its comma and spaces', P('"error, fail", warn') === 'error, fail|warn' && P("'a, b'") === 'a, b');
  check('parse: an apostrophe inside a word is text (can\'t reach is one term, the rest still splits)', P("can't reach, fail") === "can't reach|fail");
  check('parse: \\" is a literal quote, \\, a literal comma, \\\\ a backslash', P('\\"disk 90, a\\,b, c\\\\d') === '"disk 90|a,b|c\\d');
  check('parse: a backslash before anything else is text (a Windows path, a regex)', P('C:\\temp\\edge, \\d+') === 'c:\\temp\\edge|\\d+');
  check('parse: regex characters are plain text', P('[code=E42], a.b*c, (retrying') === '[code=e42]|a.b*c|(retrying');
  check('parse: empty and blank input give no terms', P('') === '' && P('   ') === '' && P(',,,') === '');
}

// ---- the fixture's rows, for the expected counts (tests/helpers/diagnostics-driver/make_fixture.py) ----
const MAIN_MSGS = ['info: example-daemon heartbeat ok, queue depth 3', 'warning: example-cache nearing capacity (80 percent)', 'error: example-worker failed to connect to 192.0.2.10:9999', 'debug: example-scheduler trace tick 42', 'notice: example-updater applied synthetic profile'];
const MAIN_SEV = ['info', 'warning', 'error', 'debug', 'info'];
const EDGE_MSGS = ['preferred route refresh ok (no change)', "can't reach 192.0.2.5 (retrying in 5s)", 'ERROR: edge-sync failed [code=E42] for item a.b*c', 'level=warn msg="disk 90 percent full" path=C:\\temp\\edge', 'E0101 12:00:00.000001 1 edge.go:1] watch closed, reconnecting', '<3>edge driver reset after timeout', 'debug: edge trace tick', 'Started Session 7 of user example.'];
const EDGE_SEV = ['other', 'other', 'error', 'warning', 'error', 'error', 'debug', 'other'];
const pad = (n) => String(n).padStart(2, '0');
const rows = [];
for (let i = 0; i < 200; i++) rows.push({ day: 1 + Math.floor(i / 40), ts: `Jan ${pad(1 + Math.floor(i / 40))} ${pad(Math.floor((i % 40) / 3600) % 24)}:${pad(Math.floor((i % 40) / 60) % 60)}:${pad((i % 40) % 60)}`, severity: MAIN_SEV[i % 5], host: 'synthetic-host', process: `example-daemon-${String(i % 20).padStart(3, '0')}`, pid: String(1000 + i), message: MAIN_MSGS[i % 5] });
for (let i = 0; i < 3200; i++) rows.push({ day: 1 + Math.floor(i / 640), ts: `Jan ${pad(1 + Math.floor(i / 640))} ${pad(Math.floor((i % 640) / 3600) % 24)}:${pad(Math.floor((i % 640) / 60) % 60)}:${pad((i % 640) % 60)}`, severity: EDGE_SEV[i % 8], host: 'synthetic-host', process: `edge-${'abc'[i % 3]}`, pid: String(5000 + i), message: EDGE_MSGS[i % 8] });
for (const r of rows) r.text = `${r.ts} ${r.severity} ${r.host} ${r.process} ${r.pid} ${r.message}`.toLowerCase();
const expect = ({ search = [], exclude = [], severity = '', process = '', days = null } = {}) => rows.filter((r) => (!days || days.includes(r.day)) && (!severity || r.severity === severity) && (!process || r.process === process) && (search.length === 0 || search.some((t) => r.text.includes(t))) && !(exclude.length && exclude.some((t) => r.text.includes(t)))).length;

// ---- live ----
const app = await launchDocumentsApp({ port: VITE_PORT, profilePrefix: 'log-viewer-header-' });
if (app.skip) { console.log('SKIP: ' + app.skip); process.exit(failed ? 1 : 0); }
let backend = null;
let frame = null;
try {
  backend = await startFlask();
  if (backend.skip) { console.log('SKIP: ' + backend.skip); process.exit(failed ? 1 : 0); }
  if (!(await makeFixture())) { console.log('SKIP: could not build the synthetic diagnostics fixture (python3 missing?)'); process.exit(failed ? 1 : 0); }
  await app.send('Network.enable');
  await app.send('Network.setExtraHTTPHeaders', { headers: { 'X-App-Token': backend.token } });
  await dismissWhatsNew(app);
  const ev = (s) => app.evaluate(s);
  const clickNav = (label) => ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  await ev(`localStorage.setItem('diagnosticsReportsDirectory', ${JSON.stringify(FIXTURE_ROOT)})`);
  await clickNav('Tools'); await sleep(500);
  await clickNav('Diagnostics');
  const opened = await app.waitFor(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(${JSON.stringify(FIXTURE_REPORT)})); if (!b) return false; b.click(); return true; })()`, 20000);
  check('the synthetic report opens in Diagnostics', opened);
  const listed = await app.waitFor(`(() => { const l = Array.from(document.querySelectorAll('div.cursor-pointer span')).map((s) => s.textContent.trim()); return l.includes('Log Viewer') ? true : null; })()`, 20000);
  check('the Log Viewer tab is listed', listed);
  await ev(`(() => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === 'Log Viewer'); s && s.closest('div.cursor-pointer').click(); })()`);

  // the sandboxed srcdoc frame is an out-of-process frame: its own CDP target on the browser's /json
  const DEBUG_PORT = VITE_PORT + 1000;
  const connectFrame = async () => {
    const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then((r) => r.json()).catch(() => []);
    const t = targets.find((x) => x.type === 'iframe');
    if (!t) return null;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0; const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
    await send('Runtime.enable');
    const fev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'frame eval failed'); return r.result?.result?.value; };
    fev.close = () => { try { ws.close(); } catch { /* closed */ } };
    return fev;
  };
  for (let i = 0; i < 40 && !frame; i++) {
    const f = await connectFrame();
    const ok = f ? await f(`!!document.getElementById('date-slider-container') && !!document.getElementById('log-search')`).catch(() => false) : false;
    if (f && ok) frame = f; else { f && f.close(); await sleep(500); }
  }
  check('the Log Viewer frame rendered (slider and filters present)', !!frame);
  if (!frame) throw new Error('no frame');
  const fev = frame;
  const fwait = async (expression, timeoutMs, stepMs = 250) => { const deadline = Date.now() + timeoutMs; let last; while (Date.now() < deadline) { last = await fev(expression).catch(() => null); if (last) return last; await sleep(stepMs); } return last; };

  // ---- the header, in dark and in light ----
  const geometry = () => fev(`(() => {
    const q = (s) => document.querySelector(s); const r = (el) => el.getBoundingClientRect(); const cs = (el) => getComputedStyle(el);
    const probe = document.createElement('div'); document.body.appendChild(probe);
    const rgb = (token) => { probe.style.backgroundColor = ''; probe.style.backgroundColor = cs(document.documentElement).getPropertyValue(token).trim(); const v = cs(probe).backgroundColor; return v; };
    const track = q('#date-slider-container .lv-slider-track'), hl = q('#date-range-highlight'), s1 = q('#date-slider-start'), s2 = q('#date-slider-end'), l1 = q('#date-start-label'), l2 = q('#date-end-label');
    const mid = (el) => r(el).top + r(el).height / 2;
    const box = (el) => ({ top: Math.round(r(el).top), height: Math.round(r(el).height), left: Math.round(r(el).left), right: Math.round(r(el).right) });
    const out = {
      track: { h: r(track).height, w: r(track).width, bg: cs(track).backgroundColor, cy: mid(track), left: r(track).left, right: r(track).right },
      hl: { h: r(hl).height, w: r(hl).width, bg: cs(hl).backgroundColor, cy: mid(hl) },
      handles: [mid(s1), mid(s2)],
      labels: { l1left: r(l1).left, l2right: r(l2).right },
      toolbar: [...document.querySelectorAll('.lv-toolbar .lv-control')].map(box),
      status: box(q('.lv-status')),
      filters: [...document.querySelectorAll('.lv-filters .lv-control, .lv-filters .lv-hint')].map(box),
      filtersRight: Math.round(r(q('.lv-filters')).right),
      placeholders: [q('#log-search').placeholder, q('#log-exclude').placeholder],
      icons: [...document.querySelectorAll('.lv-filters .lv-field:not(.lv-select-wrap) > svg')].map((s) => Math.round(r(s).width)),
      iconClear: [...document.querySelectorAll('.lv-filters .lv-field:not(.lv-select-wrap)')].map((f) => { const i = f.querySelector('input'); const s = f.querySelector('svg'); return Math.round(r(i).left + parseFloat(cs(i).paddingLeft) - r(s).right); }),
      loadBg: cs(q('#load-logs-btn')).backgroundColor,
      // the three rows' edges: the Date Range row, the toolbar, the filter row
      edges: { left: [r(q('.lv-header label')).left, r(q('#log-file-dropdown-btn')).left, r(q('.lv-filters .lv-field')).left].map(Math.round), right: [r(q('#single-date-button')).right, r(q('.lv-status')).right, r(q('#filter-syntax-hint')).right].map(Math.round) },
      // where each control's text sits: the centre of its content box (a single line centred in it), and its line-height
      textCentre: ['#log-search', '#log-exclude', '#severity-filter', '#process-filter'].map((sel) => { const el = q(sel); const b = r(el); const c = cs(el); return { sel, centre: Math.round((b.top + parseFloat(c.borderTopWidth) + parseFloat(c.paddingTop) + (b.bottom - parseFloat(c.borderBottomWidth) - parseFloat(c.paddingBottom))) / 2 * 2) / 2, lineHeight: c.lineHeight, appearance: c.appearance }; }),
      blue: rgb('--os-blue'), border: rgb('--os-border'),
    };
    probe.remove(); return out;
  })()`);
  const VARIANTS = { dark: { dark: true, theme: 'dark' }, light: { dark: false, theme: 'light' } };
  const trackColours = {};
  for (const [name, v] of Object.entries(VARIANTS)) {
    await ev(`(() => { const h = document.documentElement; h.classList.${v.dark ? 'add' : 'remove'}('dark'); h.setAttribute('data-theme', ${JSON.stringify(v.theme)}); })()`);
    await sleep(800);
    const g = await geometry();
    trackColours[name] = g.track.bg;
    const visible = (c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
    check(`${name}: the slider has a visible track between the handles (height ${g.track.h}px, colour ${g.track.bg} = --os-border)`, g.track.h >= 4 && g.track.w > 200 && visible(g.track.bg) && g.track.bg === g.border, JSON.stringify(g.track));
    check(`${name}: the selected range is highlighted in the accent colour (--os-blue), the full width at first`, g.hl.h >= 4 && Math.abs(g.hl.w - g.track.w) <= 1 && g.hl.bg === g.blue, JSON.stringify({ hl: g.hl, blue: g.blue }));
    check(`${name}: the handles and the highlight sit centred on the line`, Math.abs(g.hl.cy - g.track.cy) <= 1 && g.handles.every((cy) => Math.abs(cy - g.track.cy) <= 1), JSON.stringify({ track: g.track.cy, hl: g.hl.cy, handles: g.handles }));
    check(`${name}: the start and end labels line up with the line's ends`, Math.abs(g.labels.l1left - g.track.left) <= 12 && Math.abs(g.labels.l2right - g.track.right) <= 12, JSON.stringify({ labels: g.labels, left: g.track.left, right: g.track.right }));
    const tops = new Set(g.toolbar.map((b) => b.top)); const heights = new Set(g.toolbar.map((b) => b.height));
    check(`${name}: the toolbar's controls share one height (32px) and one baseline, the status too`, g.toolbar.length === 4 && heights.size === 1 && [...heights][0] === 32 && tops.size === 1 && Math.abs(g.status.top + g.status.height / 2 - ([...tops][0] + 16)) <= 2, JSON.stringify({ toolbar: g.toolbar, status: g.status }));
    const ftops = new Set(g.filters.map((b) => b.top)); const fheights = new Set(g.filters.map((b) => b.height));
    check(`${name}: the filter row's fields, selects and hint share one height and one baseline, with leading icons the text clears`, g.filters.length === 5 && fheights.size === 1 && [...fheights][0] === 32 && ftops.size === 1 && g.icons.length === 2 && g.icons.every((w) => w >= 12) && g.iconClear.every((gap) => gap >= 4), JSON.stringify({ filters: g.filters, icons: g.icons, iconClear: g.iconClear }));
    check(`${name}: the placeholders are short and the fields are not cut off`, g.placeholders.join('|') === 'Search logs|Filter out' && g.filters.every((b) => b.right <= g.filtersRight + 1));
    check(`${name}: Load Logs is the accent button`, g.loadBg === g.blue, `${g.loadBg} vs ${g.blue}`);
    check(`${name}: the Date Range row, the toolbar and the filter row share one left edge and one right edge (the date picker, the status, the hint)`, new Set(g.edges.left).size === 1 && new Set(g.edges.right).size === 1, JSON.stringify(g.edges));
    const centres = g.textCentre.map((t) => t.centre);
    check(`${name}: the text of the two fields and the two selects sits on one line (content-box centres equal with no vertical padding, the selects without native chrome)`, Math.max(...centres) - Math.min(...centres) <= 1 && g.textCentre.slice(2).every((t) => t.appearance === 'none'), JSON.stringify(g.textCentre));
  }
  check('the track follows the theme (a different colour in dark and in light)', trackColours.dark !== trackColours.light, JSON.stringify(trackColours));
  // narrow: the rows wrap instead of overflowing
  await ev(`(() => { const f = document.querySelector('iframe'); f.dataset.lvWidth = f.style.width; f.style.width = '560px'; })()`);
  await sleep(600);
  const narrow = await fev(`(() => { const r = (el) => el.getBoundingClientRect(); const tb = document.querySelector('.lv-toolbar'); const ctl = [...tb.querySelectorAll('.lv-control')].map(r); const fl = document.querySelector('.lv-filters'); const fc = [...fl.querySelectorAll('.lv-control, .lv-hint')].map(r); return { toolbarRows: new Set(ctl.map((b) => Math.round(b.top))).size, toolbarOverflow: ctl.some((b) => b.right > r(tb).right + 1), filterRows: new Set(fc.map((b) => Math.round(b.top))).size, filterOverflow: fc.some((b) => b.right > r(fl).right + 1), width: Math.round(r(tb).width) }; })()`);
  check('at 560px the toolbar and the filter row wrap onto more lines and nothing overflows', narrow.toolbarRows >= 2 && !narrow.toolbarOverflow && narrow.filterRows >= 2 && !narrow.filterOverflow, JSON.stringify(narrow));
  await ev(`(() => { const f = document.querySelector('iframe'); f.style.width = f.dataset.lvWidth || ''; })()`);
  await sleep(400);

  // ---- the filters, on the loaded fixture (both journal captures: 200 + 3,200 rows) ----
  await fev(`document.getElementById('select-all-logs').click()`);
  const selection = await fev(`document.getElementById('log-file-selection-display').textContent.trim()`);
  check('Select All selects both journal captures', /2 files selected/.test(selection), selection);
  const loadAndWait = async (expectedTotal) => {
    await fev(`document.getElementById('load-logs-btn').click()`);
    const done = await fwait(`(() => { const t = document.getElementById('loaded-count').textContent; const m = t.match(/^Loaded ([\\d,]+) entries$/); return m && Number(m[1].replace(/,/g, '')) === ${expectedTotal} ? t : null; })()`, 60000, 300);
    await sleep(400); // the final applyFilters and render
    return done;
  };
  const loaded = await loadAndWait(3400);
  check('Load Logs loads the 3,400 rows and says so ("Loaded 3,400 entries")', loaded === 'Loaded 3,400 entries', loaded);
  const shown = () => fev(`(() => { const t = document.getElementById('entry-count-top').textContent; if (/^No entries/.test(t)) return { count: 0, text: t }; const m = t.match(/of ([\\d,]+)/); return { count: m ? Number(m[1].replace(/,/g, '')) : -1, text: t, rows: document.querySelectorAll('#log-table-body tr, tbody tr').length }; })()`);
  const setText = async (id, value) => { await fev(`(() => { const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(350); };
  const setSelect = async (id, value) => { const got = await fev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`); await sleep(150); return got; };
  const s0 = await shown();
  check('with no filter the shown count equals the loaded count, and nothing says "filtered"', s0.count === 3400 && !/filtered/.test(s0.text), JSON.stringify(s0));

  const searches = [
    ['edge-sync', ['edge-sync'], 'a plain term'],
    ['EDGE-SYNC', ['edge-sync'], 'case does not matter'],
    ['edge-sync, trace tick', ['edge-sync', 'trace tick'], 'comma-separated terms match ANY of them'],
    ['"ok (no change)"', ['ok (no change)'], 'a quoted phrase'],
    ['"depth 3, queue"', ['depth 3, queue'], 'a quoted phrase with a comma matches as a phrase (here: nothing)'],
    ["can't reach", ["can't reach"], 'an apostrophe inside a word (was: swallowed the rest as a quote)'],
    ['[code=E42]', ['[code=e42]'], 'square brackets are text'],
    ['a.b*c', ['a.b*c'], 'regex characters are text'],
    ['C:\\temp', ['c:\\temp'], 'a backslash in a path is text (was: C:temp)'],
    ['\\"disk 90', ['"disk 90'], 'an escaped quote is a literal quote'],
    [' edge-sync , , ', ['edge-sync'], 'spaces around terms and trailing commas are ignored'],
    ['preferred', ['preferred'], '"preferred" rows are found (and are not errors, see the level checks)'],
  ];
  for (const [typed, terms, why] of searches) {
    await setText('log-search', typed);
    const s = await shown();
    const want = expect({ search: terms });
    check(`search ${JSON.stringify(typed)}: ${why} -> ${want} rows`, s.count === want && (want === 0 || /filtered from 3,400/.test(s.text)), JSON.stringify(s));
  }
  await setText('log-search', '');
  check('clearing the search brings every row back', (await shown()).count === 3400);
  await setText('log-exclude', 'edge-');
  check(`filter out "edge-" (every row of the edge capture, by its process name) leaves the main capture: ${expect({ exclude: ['edge-'] })}`, (await shown()).count === expect({ exclude: ['edge-'] }));
  await setText('log-search', 'edge');
  await setText('log-exclude', 'failed');
  check(`search "edge" with "failed" filtered out: ${expect({ search: ['edge'], exclude: ['failed'] })}`, (await shown()).count === expect({ search: ['edge'], exclude: ['failed'] }));
  await setText('log-exclude', '');
  check('clearing the exclude field brings its rows back', (await shown()).count === expect({ search: ['edge'] }));
  await setText('log-search', '');

  // the levels: every level is offered and can be picked directly after another
  const options = await fev(`[...document.getElementById('severity-filter').options].map((o) => o.value).join(',')`);
  check('the level select offers every level, Other included, whatever is loaded', options === ',critical,error,warning,info,debug,other', options);
  for (const level of ['error', 'warning', 'info', 'debug', 'other', 'critical']) {
    const got = await setSelect('severity-filter', level);
    const s = await shown();
    const want = expect({ severity: level });
    check(`level ${level}: ${want} rows (the <3> prefix, the E0101 code, level=warn, "ERROR:" and the words are read; "preferred" and "Started Session" are Other)`, got === level && s.count === want, JSON.stringify({ got, s }));
  }
  await setSelect('severity-filter', '');

  // the processes: the ones in the loaded logs, filtered by one, refreshed on load
  const procs = await fev(`[...document.getElementById('process-filter').options].map((o) => o.value).filter(Boolean)`);
  check('the process select lists the processes of the loaded logs (3 edge-*, 20 example-daemon-*)', procs.length === 23 && procs.includes('edge-a') && procs.includes('example-daemon-019'), procs.join(','));
  await setSelect('process-filter', 'edge-a');
  check(`process edge-a: ${expect({ process: 'edge-a' })} rows`, (await shown()).count === expect({ process: 'edge-a' }));
  await setSelect('severity-filter', 'error');
  const procsOfErrors = await fev(`[...document.getElementById('process-filter').options].map((o) => o.value).filter(Boolean)`);
  check('with a level chosen the process list is the processes of that level (the 3 edge processes and the daemons with errors), the chosen process kept', procsOfErrors.length === 3 + new Set(rows.filter((r) => r.severity === 'error' && r.process.startsWith('example')).map((r) => r.process)).size && procsOfErrors.includes('edge-a') && (await fev(`document.getElementById('process-filter').value`)) === 'edge-a', procsOfErrors.join(','));
  await setText('log-search', 'watch');
  await setText('log-exclude', 'reconnecting, nothing');
  const all = await shown();
  check(`all filters together: level error + process edge-a + search "watch" with "reconnecting" filtered out -> ${expect({ severity: 'error', process: 'edge-a', search: ['watch'], exclude: ['reconnecting', 'nothing'] })} (no entries, says filtered from 3,400)`, all.count === 0 && /filtered from 3,400/.test(all.text), JSON.stringify(all));
  await setText('log-exclude', '');
  const combo = await shown();
  const wantCombo = expect({ severity: 'error', process: 'edge-a', search: ['watch'] });
  check(`level error + process edge-a + search "watch": ${wantCombo} rows, the count says "of ${wantCombo} (filtered from 3,400)", Export CSV enabled`, combo.count === wantCombo && new RegExp(`of ${wantCombo.toLocaleString()} \\(filtered from 3,400\\)`).test(combo.text) && (await fev(`!document.getElementById('export-csv-btn').disabled`)), JSON.stringify(combo));

  // a reload keeps the filters applied (table, counts, export)
  const reloaded = await loadAndWait(3400);
  const afterReload = await shown();
  check('after Load Logs again the filters still apply (was: the old rows stayed in the table, the counts and the export)', reloaded === 'Loaded 3,400 entries' && afterReload.count === wantCombo, JSON.stringify(afterReload));
  await setSelect('severity-filter', ''); await setSelect('process-filter', ''); await setText('log-search', 'edge-sync');

  // debounced typing on 3,400 rows: ten quick keystrokes do not filter synchronously, the last one wins
  const typing = await fev(`(async () => { const i = document.getElementById('log-search'); const before = document.getElementById('entry-count-top').textContent; const t0 = performance.now(); for (const v of ['e', 'ed', 'edg', 'edge', 'edge-', 'edge-s', 'edge-sy', 'edge-syn', 'edge-sync', 'preferred']) { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); } const elapsed = performance.now() - t0; const during = document.getElementById('entry-count-top').textContent; await new Promise((r) => setTimeout(r, 400)); return { elapsed, before, during, after: document.getElementById('entry-count-top').textContent }; })()`);
  check('typing is debounced: ten keystrokes return at once, the count changes only after the pause, to the last value', typing.elapsed < 150 && typing.during === typing.before && /of 400 /.test(typing.after), JSON.stringify(typing));

  // a changed date range: Jan 1 only, with a search set
  await fev(`(() => { const e = document.getElementById('date-slider-end'); e.value = 0; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  const labels = await fev(`[document.getElementById('date-start-label').textContent, document.getElementById('date-end-label').textContent, document.getElementById('date-range-highlight').style.width]`);
  check('dragging the end handle to the first day updates the labels and the highlight', labels[0] === '2026-01-01' && labels[1] === '2026-01-01' && labels[2] === '0%', JSON.stringify(labels));
  const dayOne = await loadAndWait(expect({ days: [1] }));
  const dayOneShown = await shown();
  check(`with the range on Jan 1 Load Logs loads ${expect({ days: [1] })} rows and the search "preferred" still applies: ${expect({ days: [1], search: ['preferred'] })}`, !!dayOne && dayOneShown.count === expect({ days: [1], search: ['preferred'] }), JSON.stringify({ dayOne, dayOneShown }));
  const procsDayOne = await fev(`[...document.getElementById('process-filter').options].map((o) => o.value).filter(Boolean).length`);
  check('the process list is refreshed for the new range (the 20 daemons of Jan 1 plus the 3 edge processes)', procsDayOne === 23, procsDayOne);

  const pageErrors = app.errors.filter((e) => !/favicon|ResizeObserver loop/.test(e));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
} finally {
  if (frame) frame.close();
  await app.close();
  if (backend && backend.stop) await backend.stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
