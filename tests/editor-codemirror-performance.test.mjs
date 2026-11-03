/**
 * Typing latency of the Documents editor at 10,000 and 50,000 lines, in the
 * REAL Electron app (tests/helpers/electron-app.mjs). The CodeMirror surface
 * replaced a plain <textarea> that re-rendered its whole value on every
 * keystroke (measured here before the switch, production build, 50k lines:
 * 75 ms median keystroke-to-frame with 317 long tasks; the surface measured
 * 7.8 ms median, p95 26 ms, 1 long task, 32 lines in the DOM). The
 * development build (the default here) is about four times slower than
 * the production build (LIVE_BUILD=production) because of React's checks.
 *
 * What is measured, with real key events typed at the end of the document:
 *   - keystroke -> the next animation frame after the input event
 *     (median and p95 over ~160 keystrokes), the editor's own probe;
 *   - long tasks (PerformanceObserver 'longtask', > 50 ms) while typing;
 *   - how long setting the whole document takes (3.8 MB at 50k lines);
 *   - how many lines are in the DOM (virtualisation).
 *
 * The thresholds are generous (a loaded CI machine on the development
 * build must pass; the targets are ~10 ms median, 0 long tasks, < 0.5 s to
 * load): median keystroke-to-frame under 60 ms and p95 under 150 ms at 50k
 * lines, at most 20 long tasks over the typing run (the development build
 * has some; the production build had one), the 3.8 MB load under 3 s,
 * under 500 lines in the DOM. PERF_LINES=10000,50000 chooses the sizes;
 * SKIPs (exit 0) when the app cannot be launched.
 * Run: node tests/editor-codemirror-performance.test.mjs
 */
import { launchElectronApp, createNewDocument, sleep } from './helpers/electron-app.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const SIZES = (process.env.PERF_LINES || '10000,50000').split(',').map((n) => Number(n)).filter((n) => n > 0);
const LIMITS = { medianMs: 60, p95Ms: 150, longTasks: 20, loadMs: 3000, domLines: 500 };

const WORDS = 'the quick brown fox jumps over the lazy dog while the operator checks the cluster node status and restarts the failed pod before the deadline'.split(' ');
function makeDoc(lines) {
  const out = ['# Title', '', 'helo wrld in prose', '', '```bash', 'helo wrld in a fenced block', '```', '', 'inline `helo inline` span, a [[toc]] directive, a link [text](https://exmaple.com/wrld) and https://exmaple.com/autolnk', ''];
  let w = 0;
  for (let i = out.length; i < lines; i++) {
    if (i % 40 === 0) out.push(`## Section ${i / 40}`);
    else if (i % 40 === 1) out.push('');
    else if (i % 40 >= 30 && i % 40 < 36) out.push(i % 40 === 30 ? '```bash' : i % 40 === 35 ? '```' : `oc get pods -n openshift-monitoring --field-selector status.phase!=Running | grep -v Completed # ${i}`);
    else { const parts = []; for (let k = 0; k < 14; k++) parts.push(WORDS[(w++) % WORDS.length]); out.push((i % 7 === 0 ? '- ' : '') + parts.join(' ') + '.'); }
  }
  return out.join('\n');
}
const TYPED = 'Ths is a smple sentence with a few mispeled words and some corect ones to typ. ';
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const fmt = (n) => Math.round(n * 10) / 10;

const launched = await launchElectronApp({ profilePrefix: 'electron-cm-perf-' });
if (launched.skip) { console.log(`SKIP: ${launched.skip}`); process.exit(0); }
const { page, close } = launched;
const SURFACE_EXPR = "((document.querySelector('.sc-editor-cm') && document.querySelector('.sc-editor-cm').editorSurface) || null)";

async function measure(lines) {
  const doc = makeDoc(lines);
  // the whole document in one go, as a document switch or a paste would set it
  const loadMs = await page.evaluate(async ([expr, text]) => {
    const s = eval(expr);
    s.focus();
    const t0 = performance.now();
    s.value = text;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  }, [SURFACE_EXPR, doc]);
  await sleep(1500);
  // the caret at the end, the probe armed: keydown -> the frame after the input event; long tasks counted
  await page.evaluate((expr) => {
    const s = eval(expr);
    const end = s.value.length;
    s.focus();
    s.setSelectionRange(end, end);
    s.scrollToPos(end);
    const el = s.contentDOM;
    window.__lat = []; window.__long = []; let t = 0;
    el.addEventListener('keydown', () => { t = performance.now(); }, true);
    el.addEventListener('input', () => { requestAnimationFrame(() => { window.__lat.push(performance.now() - t); }); }, true);
    try { window.__obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }); window.__obs.observe({ entryTypes: ['longtask'] }); } catch { /* n/a */ }
  }, SURFACE_EXPR);
  await sleep(300);
  await page.keyboard.type(TYPED + TYPED, { delay: 30 });
  await sleep(1000);
  const probe = await page.evaluate((expr) => { const s = eval(expr); try { window.__obs && window.__obs.disconnect(); } catch { /* n/a */ } return { lat: window.__lat, long: window.__long, dom: document.querySelectorAll('.cm-line').length, length: s.value.length }; }, SURFACE_EXPR);
  return { lines, chars: doc.length, loadMs: fmt(loadMs), keys: probe.lat.length, medianMs: fmt(pct(probe.lat, 0.5)), p95Ms: fmt(pct(probe.lat, 0.95)), maxMs: fmt(Math.max(0, ...probe.lat)), longTasks: probe.long.length, longTotalMs: probe.long.reduce((a, b) => a + b, 0), domLines: probe.dom, typedOk: probe.length === doc.length + (TYPED + TYPED).length };
}

try {
  check('a document was created', await createNewDocument(page));
  await page.waitForFunction((expr) => !!eval(expr), SURFACE_EXPR, { timeout: 20000 });
  for (const lines of SIZES) {
    const row = await measure(lines);
    console.log(`INFO: ${JSON.stringify(row)}`);
    check(`${lines} lines (${Math.round(row.chars / 1024)} KB): every keystroke landed`, row.typedOk && row.keys >= (TYPED.length * 2) * 0.9, JSON.stringify(row));
    check(`${lines} lines: keystroke-to-frame median under ${LIMITS.medianMs} ms, p95 under ${LIMITS.p95Ms} ms`, row.medianMs < LIMITS.medianMs && row.p95Ms < LIMITS.p95Ms, `median ${row.medianMs} ms, p95 ${row.p95Ms} ms, max ${row.maxMs} ms`);
    check(`${lines} lines: at most ${LIMITS.longTasks} long tasks while typing`, row.longTasks <= LIMITS.longTasks, `${row.longTasks} long task(s), ${row.longTotalMs} ms`);
    check(`${lines} lines: the document set in under ${LIMITS.loadMs} ms, under ${LIMITS.domLines} lines in the DOM`, row.loadMs < LIMITS.loadMs && row.domLines < LIMITS.domLines, `${row.loadMs} ms, ${row.domLines} DOM lines`);
  }
} catch (error) {
  check('the test ran to the end', false, error?.stack || String(error));
} finally {
  await close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
