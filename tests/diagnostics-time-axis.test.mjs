#!/usr/bin/env node
/*
 * The broken time axis's ticks (diagChart.axis / timeTicks in backend/static/diagnostics-ui.js), which the Log
 * Collection Histogram, the Audit page and the Log Viewer's timeline draw with diagChart.timeSeries: the ticks
 * spread over the WHOLE range at round wall-clock instants, the spacing adapts to the span, the date labels each
 * midnight, the first tick and the first after a skipped gap carry date and time.
 *
 * The bug this guards (4.3.0): the ticks were every k-th bucket with the bucket's own label - the time of day,
 * with the date only on a capture window's first bucket - so an analysis over several days showed one day's
 * clock (00:00 ... 24:00, repeated) under bars that covered the whole range.
 *
 * The buckets come from the real bucket plan (backend/parsers/logtime.py bucket_plan, through backend/venv's
 * Python) for: a single day, three days, two weeks, two windows with a multi-day gap, and a range across a DST
 * change (the log's wall clock: naive times, read as UTC - the labels are the same whatever the browser's zone,
 * checked here by running the same layout under TZ=UTC, America/New_York and Australia/Sydney).
 *
 *   node tests/diagnostics-time-axis.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed += 1; };

// the child mode: lay out the scenarios under this process's TZ and print the ticks
const ui = fs.readFileSync(path.join(REPO, 'backend', 'static', 'diagnostics-ui.js'), 'utf8');
const from = ui.indexOf('  var MONTHS = ');
const to = ui.indexOf('  // a bar chart over time buckets on the broken axis');
function load() {
  const ctx = { Map, Date, Math, String, Number, isNaN, BREAK_PX: Number((/var BREAK_PX = (\d+);/.exec(ui) || [])[1] || 28) };
  vm.createContext(ctx);
  vm.runInContext(ui.slice(from, to) + '\n;this.axis = axis; this.timeTicks = timeTicks;', ctx);
  return ctx;
}
if (process.argv[2] === '--layout') {
  const scenarios = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const { axis } = load();
  const out = {};
  for (const [name, sc] of Object.entries(scenarios)) {
    const a = axis(sc.buckets, sc.step).layout(sc.width || 1000);
    out[name] = { interval: a.tickInterval, max: a.max, gaps: a.gaps.map((g) => [g.x0, g.x1]), ticks: a.ticks.map((t) => ({ value: t.value, label: t.label, iso: new Date(t.ms).toISOString().slice(0, 16) })), opens: a.points.filter((p) => p.bucket.start).map((p) => p.start) };
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

check('the tick code is where the test reads it (timeTicks before axis, in diagnostics-ui.js) and diagChart exposes it', from > 0 && to > from && /timeTicks: timeTicks/.test(ui));
check('the axis no longer takes every k-th bucket\'s own label for its ticks', !/n % k === 0\) a\.ticks\.push\(\{ value: p\.start, label: p\.label \}\)/.test(ui));

const PY = [path.join(REPO, 'backend', 'venv', 'bin', 'python3'), path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')].find((p) => fs.existsSync(p));
if (!PY) { console.log('SKIP: backend/venv missing - the bucket plans come from backend/parsers/logtime.py'); process.exit(failed ? 1 : 0); }
const plan = spawnSync(PY, ['-I', '-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'backend'))})
from datetime import datetime, timedelta
from parsers.logtime import bucket_plan
def minutes(a, b, every=1):
    a, b = datetime.fromisoformat(a), datetime.fromisoformat(b)
    out = []
    while a <= b:
        out.append(a); a += timedelta(minutes=every)
    return out
def buckets(stamps):
    p = bucket_plan(stamps, max_buckets=60, min_step=60)
    items = [({'gap': True, 'label': it['label'], 'from': it['from'], 'to': it['to'], 'minutes': it['minutes'], 't': ''} if it['gap'] else
              {'gap': False, 't': it['t'].strftime('%Y-%m-%dT%H:%M:%S'), 'label': it['label'], 'start': it['start'], 'window': it['window']}) for it in p['items']]
    return {'buckets': items, 'step': p['step_seconds']}
sc = {
  'day': buckets(minutes('2026-11-07T00:00', '2026-11-07T23:59')),
  'days3': buckets(minutes('2026-11-05T09:00', '2026-11-07T21:00')),
  'weeks2': buckets(minutes('2026-10-20T00:00', '2026-11-02T18:00', 10)),
  'gap': buckets(minutes('2026-11-01T08:00', '2026-11-01T20:00') + minutes('2026-11-04T10:15', '2026-11-05T02:00')),
  'dst': buckets(minutes('2026-10-31T12:00', '2026-11-02T12:00')),
}
sc['days3wide'] = dict(sc['days3'], width=1800)
print(json.dumps(sc))
`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
check('the bucket plans of the scenarios (the real bucket_plan)', plan.status === 0, plan.stderr);
if (plan.status !== 0) process.exit(1);
const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'time-axis-')), 'scenarios.json');
fs.writeFileSync(tmp, plan.stdout);
const layout = (tz) => { const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--layout', tmp], { encoding: 'utf8', env: { ...process.env, TZ: tz } }); return r.status === 0 ? JSON.parse(r.stdout) : { error: r.stderr }; };
const L = layout('UTC');
const labels = (n) => (L[n] ? L[n].ticks.map((t) => t.label) : []);
const isTime = (l) => /^\d{2}:\d{2}$/.test(l), isDate = (l) => /^[A-Z][a-z]{2} \d{1,2}$/.test(l), isDateTime = (l) => /^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/.test(l);
const increasing = (n) => L[n].ticks.every((t, i, a) => i === 0 || (t.value > a[i - 1].value && t.iso > a[i - 1].iso));
const inRange = (n) => L[n].ticks.every((t) => t.value >= 0 && t.value <= L[n].max);
// a time of day may come back only after the date has moved on (a date label in between)
const noBareRepeat = (n) => { const ls = labels(n); const seen = new Set(); for (const l of ls) { if (!isTime(l)) { seen.clear(); continue; } if (seen.has(l)) return false; seen.add(l); } return true; };

{
  const l = labels('day');
  check(`a single day: the first tick carries the date (Nov 7, at midnight), then times; hourly-or-wider round steps over the whole day (${l.join(' | ')})`, l[0] === 'Nov 7' && l.slice(1).every(isTime) && [3600, 7200, 10800].includes(L.day.interval) && L.day.ticks[L.day.ticks.length - 1].iso >= '2026-11-07T18:00' && increasing('day') && inRange('day'));
}
{
  const l = labels('days3');
  check(`three days: the ticks spread over the whole range (Nov 5 09:00 to Nov 7), the date at each midnight (Nov 6, Nov 7), the first with date and time (${l.join(' | ')})`, l[0] === 'Nov 5 09:00' && l.includes('Nov 6') && l.includes('Nov 7') && L.days3.ticks[L.days3.ticks.length - 1].iso.startsWith('2026-11-07') && increasing('days3') && inRange('days3') && noBareRepeat('days3'));
  check(`...6-hour or 12-hour steps across several days (${L.days3.interval / 3600} h), 6-hour on a wide chart (${L.days3wide.interval / 3600} h: ${labels('days3wide').join(' | ')})`, [21600, 43200].includes(L.days3.interval) && L.days3wide.interval === 21600 && labels('days3wide').filter(isDate).length === 2);
}
{
  const l = labels('weeks2');
  check(`two weeks: day steps, every label a date, Oct 20 to Nov 1 or 2 (${l.join(' | ')})`, L.weeks2.interval >= 86400 && l.every(isDate) && l[0] === 'Oct 20' && /^(Nov 1|Nov 2)$/.test(l[l.length - 1]) && increasing('weeks2') && inRange('weeks2'));
}
{
  const g = L.gap, l = labels('gap');
  const opening = g.ticks.find((t) => t.value === g.gaps[0][1]);
  check(`a multi-day gap: one gap; the window after it opens with a date-and-time tick at the gap's right edge (Nov 4 10:15), no tick inside the gap, the next midnight dated (${l.join(' | ')})`, g.gaps.length === 1 && !!opening && opening.label === 'Nov 4 10:15' && !g.ticks.some((t) => t.value > g.gaps[0][0] && t.value < g.gaps[0][1]) && l[0] === 'Nov 1 08:00' && l.includes('Nov 5') && increasing('gap') && noBareRepeat('gap'));
}
{
  const l = labels('dst');
  const ny = layout('America/New_York'), syd = layout('Australia/Sydney');
  check(`across a DST change (US, 2026-11-01): the log's wall clock - midnights dated (Nov 1, Nov 2), ticks on round wall-clock hours (${l.join(' | ')})`, l.includes('Nov 1') && l.includes('Nov 2') && L.dst.ticks.every((t) => t.iso.endsWith(':00')) && increasing('dst'));
  check('...and the same labels at the same places whatever the browser\'s zone (UTC, New York, Sydney)', JSON.stringify(ny) === JSON.stringify(L) && JSON.stringify(syd) === JSON.stringify(L), JSON.stringify(ny.dst || ny).slice(0, 300));
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
