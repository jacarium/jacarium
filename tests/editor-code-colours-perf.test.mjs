#!/usr/bin/env node
/**
 * Syntax colours inside fenced code in the editor (codemirror/codeColours.js):
 * the viewport-only behaviour and the cost, measured in the REAL surface in
 * headless Chromium (playwright-core, the surface bundled by esbuild with the
 * editor's own rules from src/index.css; no server, no port):
 *
 *   - viewport-only: a document with a python fence at the top and one far
 *     below - the top one is coloured, the far one is not until scrolled to;
 *   - typing latency in a 200,000-line mixed document (headings, prose, lists,
 *     python / bash / yaml fences): the time of a keystroke (dispatch + the
 *     frame) in prose and inside a visible fence, with the colours and
 *     without (codeColours: false) - the colours must not add more than a
 *     few milliseconds (the bar: within 2x and +5 ms of the plain surface);
 *   - a 2,000-line python block (the cap): the first highlight's time, the
 *     cost of a keystroke inside it, the debounced re-highlight's time;
 *   - the cache's size and estimated memory after it all.
 * The numbers are printed for the report.
 *
 * SKIPs without esbuild / playwright-core / Chromium. Run: node tests/editor-code-colours-perf.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'code-colours-perf-'));
let build = null, pw = null;
try { ({ build } = await import(req.resolve('esbuild'))); } catch { build = null; }
try { pw = req('playwright-core'); } catch { pw = null; }
if (!build || !pw) { console.log('SKIP: esbuild or playwright-core is not installed'); process.exit(0); }

const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  import { CodeMirrorSurface } from ${JSON.stringify(path.join(REPO, 'src/components/features/documents/codemirror/CodeMirrorSurface.js'))};
  import { colourDecorations, coloursField, stats, cacheStats, clearCache, CAP, DEBOUNCE_MS } from ${JSON.stringify(path.join(REPO, 'src/components/features/documents/codemirror/codeColours.js'))};
  window.CAP = CAP; window.DEBOUNCE_MS = DEBOUNCE_MS; window.stats = stats; window.cacheStats = cacheStats; window.clearCache = clearCache;
  window.colourDecorations = colourDecorations; window.coloursField = coloursField;
  window.makeSurface = (doc, opts = {}) => { const host = document.getElementById('host'); host.innerHTML = ''; if (window.surface) window.surface.destroy(); window.surface = new CodeMirrorSurface({ parent: host, doc, ...opts }); window.view = window.surface.view; return window.view.state.doc.lines; };
  window.markCount = () => { let n = 0; const f = window.view.state.field(window.coloursField, false); if (f) f.between(0, window.view.state.doc.length, () => { n += 1; }); return n; };
  window.domMarks = () => window.view.contentDOM.querySelectorAll('[class*="hljs-"]').length;
  // the cost of a keystroke: the dispatch and the frame it paints in
  window.typeAt = async (pos, text, n) => { const times = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); window.view.dispatch({ changes: { from: pos + i, insert: text }, selection: { anchor: pos + i + 1 }, userEvent: 'input.type' }); await new Promise((r) => requestAnimationFrame(() => r())); times.push(performance.now() - t0); } times.sort((a, b) => a - b); return { avg: times.reduce((a, b) => a + b, 0) / times.length, median: times[times.length >> 1], max: times[times.length - 1] }; };
`);
const BUNDLE = path.join(WORK, 'bundle.js');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'iife', platform: 'browser', logLevel: 'error',
  nodePaths: [path.join(REPO, 'node_modules')], conditions: ['browser', 'import', 'default'], mainFields: ['browser', 'module', 'main'],
  plugins: [{ name: 'node-builtins', setup(b) { b.onResolve({ filter: /^node:/ }, (a) => (isBuiltin(a.path) ? { path: a.path, external: true } : null)); } }],
});
const css = read('src/index.css');
const start = css.indexOf('.sc-editor-cm-host {');
const end = css.indexOf('.sc-editor-cm .cm-ySelectionCaret:hover');
const editorCss = start !== -1 && end !== -1 ? css.slice(start, css.indexOf('\n', end)) : '';
const blocksCss = css.slice(css.indexOf('.sc-editor-cm .cm-line.cm-code-block {'));
const hljsCss = css.slice(css.indexOf('.markdown-preview .hljs-keyword,'), css.indexOf('.markdown-preview .hljs-emphasis {') + 60);
const PAGE = path.join(WORK, 'index.html');
fs.writeFileSync(PAGE, `<!doctype html><html><head><meta charset="utf-8"><title>code colours</title><style>
  html, body { margin: 0; height: 100%; } #host { height: 100vh; }
  :root { --os-card: #fff; --os-text-primary: #111; --os-text-muted: #777; --os-text-secondary: #555; --os-terminal-selection: #cce; --font-mono: ui-monospace, Menlo, monospace; --chart-warn: #e9a; --os-border: #ddd; --os-card-secondary: #f5f5f5; --radius-sm: 8px; --radius-xs: 0; --radius-chip: 0; --os-code-bg: #f6f8fa; --os-blue: #06c;
    --os-code-keyword: #cf222e; --os-code-string: #0a3069; --os-code-number: #0550ae; --os-code-comment: #6e7781; --os-code-title: #8250df; --os-code-attr: #953800; --os-code-builtin: #0550ae; --os-code-variable: #24292f; --os-code-meta: #116329; }
  ${editorCss}
  ${blocksCss}
  ${hljsCss}
</style></head><body><div id="host" class="sc-editor-cm-host"></div><script src="bundle.js"></script></body></html>`);

// the documents
const PY = (n) => Array.from({ length: n }, (_, i) => (i % 4 === 0 ? `def f${i}(x):` : i % 4 === 1 ? `    """doc ${i}"""` : i % 4 === 2 ? `    return x + ${i}  # c` : '')).join('\n');
const section = (s) => [`## Section ${s}`, '', `Paragraph ${s} with some prose for the mixed document, long enough to read.`, '', `- item a ${s}`, `- item b ${s}`, '', '```python', `def f${s}(x):`, `    return x * ${s}  # comment`, '```', '', '```bash', `echo "s ${s}" | grep s`, '```', '', '```yaml', `key${s}: value`, `list:`, `  - ${s}`, '```', ''];
const MIXED = []; for (let s = 1; MIXED.length < 200000; s++) MIXED.push(...section(s));
const MIXED_DOC = MIXED.join('\n');
const NEAR_FAR = ['```python', PY(8), '```', '', ...Array.from({ length: 3000 }, (_, i) => `filler line ${i}`), '', '```python', PY(12), '```', ''].join('\n');

let browser = null;
try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP: no Chromium for playwright-core: ${e.message.slice(0, 100)}`); process.exit(0); }
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.goto('file://' + PAGE);
const settle = async () => { await sleep(400); };

try {
  console.log('\n--- viewport-only ---');
  await page.evaluate((doc) => window.makeSurface(doc), NEAR_FAR);
  await settle();
  let m = await page.evaluate(() => ({ marks: window.markCount(), dom: window.domMarks(), highlights: window.stats.highlights }));
  check('the fence at the top is coloured, the one 3,000 lines below is not (one highlight)', m.marks > 0 && m.highlights === 1, JSON.stringify(m));
  await page.evaluate(() => { const s = window.view.scrollDOM; s.scrollTop = s.scrollHeight; });
  await settle();
  const m2 = await page.evaluate(() => ({ marks: window.markCount(), dom: window.domMarks(), highlights: window.stats.highlights, hits: window.stats.cacheHits }));
  check('scrolled to the end: the far fence is coloured now (a second highlight), the first is out of the viewport', m2.highlights === 2 && m2.dom > 0, JSON.stringify(m2));

  console.log('\n--- typing in a 200,000-line mixed document ---');
  const results = {};
  for (const colours of [false, true]) {
    const lines = await page.evaluate(([doc, on]) => { window.clearCache(); return window.makeSurface(doc, { codeColours: on }); }, [MIXED_DOC, colours]);
    await settle();
    const prosePos = MIXED_DOC.indexOf('Paragraph 2 with');
    const codePos = MIXED_DOC.indexOf('return x * 2  #') + 'return x * 2  #'.length;
    const prose = await page.evaluate(([pos]) => window.typeAt(pos, 'a', 40), [prosePos]);
    await sleep(400);
    const code = await page.evaluate(([pos]) => window.typeAt(pos, 'b', 40), [codePos]);
    await sleep(400);
    const after = await page.evaluate(() => ({ marks: window.markCount(), highlights: window.stats.highlights }));
    results[colours ? 'on' : 'off'] = { lines, prose, code, after };
    console.log(`  colours ${colours ? 'ON ' : 'OFF'}: ${lines.toLocaleString('en')} lines; a keystroke in prose avg ${prose.avg.toFixed(2)} ms (median ${prose.median.toFixed(2)}, max ${prose.max.toFixed(1)}); in a visible fence avg ${code.avg.toFixed(2)} ms (median ${code.median.toFixed(2)}, max ${code.max.toFixed(1)})${colours ? `; marks ${after.marks}, highlights so far ${after.highlights}` : ''}`);
  }
  const bar = (on, off) => on.median <= Math.max(off.median * 2, off.median + 5);
  check('the colours cost at most 2x / +5 ms on the median keystroke, in prose and in a fence', bar(results.on.prose, results.off.prose) && bar(results.on.code, results.off.code), JSON.stringify({ on: { prose: results.on.prose.median, code: results.on.code.median }, off: { prose: results.off.prose.median, code: results.off.code.median } }));
  check('typing in the mixed document coloured only the fences on screen (a handful of highlights, not thousands)', results.on.after.highlights < 60, String(results.on.after.highlights));

  console.log('\n--- a 2,000-line python block ---');
  const BIG = '```python\n' + PY(1999) + '\n```\n';
  await page.evaluate(() => window.clearCache());
  const first = await page.evaluate((doc) => { window.makeSurface(doc, { codeColours: true }); const t0 = performance.now(); const d = window.colourDecorations(window.view.state, [{ from: 0, to: window.view.state.doc.length }]); let n = 0; d.between(0, window.view.state.doc.length, () => { n += 1; }); return { ms: performance.now() - t0, marks: n, lines: window.view.state.doc.lines, bytes: window.view.state.doc.length }; }, BIG);
  await settle();
  const cached = await page.evaluate(() => { const t0 = performance.now(); window.colourDecorations(window.view.state, [{ from: 0, to: window.view.state.doc.length }]); return performance.now() - t0; });
  const bigPos = BIG.indexOf('return x + 2  # c') + 'return x + 2  #'.length;
  const bigTyping = await page.evaluate(([pos]) => window.typeAt(pos, 'z', 20), [bigPos]);
  await sleep(400);
  const rehighlight = await page.evaluate(() => { const t0 = performance.now(); window.colourDecorations(window.view.state, [{ from: 0, to: window.view.state.doc.length }]); return performance.now() - t0; });
  console.log(`  ${first.lines.toLocaleString('en')} lines / ${first.bytes.toLocaleString('en')} bytes (under the cap of ${await page.evaluate(() => window.CAP.lines)} / ${await page.evaluate(() => window.CAP.bytes)}): first highlight ${first.ms.toFixed(1)} ms for ${first.marks} marks; from the cache ${cached.toFixed(2)} ms; a keystroke inside it avg ${bigTyping.avg.toFixed(2)} ms (median ${bigTyping.median.toFixed(2)}, max ${bigTyping.max.toFixed(1)}); the debounced re-highlight after the edit ${rehighlight.toFixed(1)} ms`);
  check('the 2,000-line block is coloured (under the cap) and its first highlight takes under a second', first.marks > 1000 && first.ms < 1000, JSON.stringify(first));
  check('a keystroke inside it stays cheap (median under 30 ms) - the re-highlight is debounced off the keystroke', bigTyping.median < 30, JSON.stringify(bigTyping));
  const over = await page.evaluate((doc) => { window.makeSurface(doc, { codeColours: true }); return new Promise((r) => setTimeout(() => r({ marks: window.markCount(), cap: window.stats.skippedCap }), window.DEBOUNCE_MS + 200)); }, '```python\n' + PY(2100) + '\n```\n');
  check('a 2,100-line block is past the cap: no marks', over.marks === 0 && over.cap >= 1, JSON.stringify(over));

  console.log('\n--- the cache ---');
  const cs = await page.evaluate(() => window.cacheStats());
  console.log(`  cache: ${cs.blocks} blocks, ${cs.tokens.toLocaleString('en')} tokens, about ${(cs.approxBytes / 1024).toFixed(0)} KB`);
  check('the cache stays small (at most 64 blocks, under 4 MB estimated)', cs.blocks <= 64 && cs.approxBytes < 4 * 1024 * 1024, JSON.stringify(cs));
  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
