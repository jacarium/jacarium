/**
 * The "Rendering preview of N lines..." state of a huge document
 * (src/hooks/useDeferredPreview.js, src/utils/previewChunks.js hugePreview,
 * DocumentEditor's preview area): above HUGE_PREVIEW_LINES / _CHARS the
 * Preview toggle paints the indicator first and runs the synchronous render
 * only after a frame; below it the preview renders exactly as before, with
 * no indicator; leaving the preview while a render is waiting cancels it,
 * and nothing stale is shown.
 *
 *   static: the editor's wiring (the hook with the threshold, the
 *     module-level render, the indicator from the shared Note with the
 *     spinner and the line count, the `pending` branch before the content);
 *   unit: hugePreview() and the constants;
 *   hook (jsdom + React, a fake render):
 *     a small document renders synchronously in render, no pending;
 *     a huge one is pending first and renders after a frame + a macrotask;
 *     closing the preview before the frame cancels the render (never run);
 *     a later version within one opening keeps the HTML on screen and stays
 *     silent (no pending) until the new HTML lands; re-opening starts from
 *     the indicator again;
 *   browser (playwright-core Chromium, no server): a page with the real hook
 *     and a render that blocks for ~600 ms records when the indicator was
 *     painted (a frame after it mounted) and when the render started - the
 *     paint comes first; the indicator, rendered with the real Note and the
 *     app's built stylesheet (dist/assets, when a build is there), is
 *     screenshotted in light and dark into PREVIEW_SHOTS_DIR.
 *
 * Run: node tests/preview-rendering-indicator.test.mjs
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
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-indicator-'));

// ---------------------------------------------------------------------------
// static
// ---------------------------------------------------------------------------
const editor = read('src/components/features/documents/DocumentEditor.jsx');
check('DocumentEditor renders the preview through useDeferredPreview with the threshold decision and a module-level render', /const previewSize = useMemo\(\(\) => \(isPreviewActive \? hugePreview\(previewSource\)/.test(editor) && /useDeferredPreview\(\{\s*active: isPreviewActive, source: previewSource, huge: previewSize\.huge, documentKey: documentId, render: renderPreviewHtml, version: previewVersion,/.test(editor) && /^function renderPreviewHtml\(text\) \{/m.test(editor));
check('the indicator comes before the content: the pending branch renders the shared Note (info) with the spinning Loader2 and the line count, in the preview area', /\{isPreviewActive && previewPending \? \(/.test(editor) && /data-testid="preview-rendering" aria-busy="true"/.test(editor) && /<Note tone="info" icon=\{null\} testId="preview-rendering-note">/.test(editor) && /<Loader2 size=\{14\} className="animate-spin" aria-hidden="true" \/>/.test(editor) && /Rendering preview of \{previewSize\.lines\.toLocaleString\(\)\} lines&hellip;/.test(editor) && editor.indexOf('data-testid="preview-rendering"') < editor.indexOf('dangerouslySetInnerHTML={previewInnerHtml}'));

// ---------------------------------------------------------------------------
// unit
// ---------------------------------------------------------------------------
const chunks = await import(path.join(REPO, 'src/utils/previewChunks.js'));
check('the threshold is one named pair: 500,000 lines or 20,000,000 characters', chunks.HUGE_PREVIEW_LINES === 500000 && chunks.HUGE_PREVIEW_CHARS === 20000000);
const small = chunks.hugePreview('a\nb\nc');
const manyLines = chunks.hugePreview('x\n'.repeat(500001));
const manyChars = chunks.hugePreview('y'.repeat(20000001));
check('hugePreview: 3 lines are not huge (count 3); 500,002 lines are; 20,000,001 characters on one line are; an empty text is one line', !small.huge && small.lines === 3 && manyLines.huge && manyLines.lines === 500002 && manyChars.huge && manyChars.lines === 1 && chunks.hugePreview('').lines === 1 && !chunks.hugePreview('').huge);

// ---------------------------------------------------------------------------
// the hook under jsdom
// ---------------------------------------------------------------------------
let jsdomOk = true;
try { req.resolve('jsdom'); } catch { jsdomOk = false; }
let build = null, pw = null;
try { ({ build } = await import(req.resolve('esbuild'))); } catch { build = null; }
try { pw = req('playwright-core'); } catch { pw = null; }
if (!jsdomOk || !build) console.log(`SKIP (hook): ${!build ? 'esbuild' : 'jsdom'} is not installed`);
else {
  const ENTRY = path.join(WORK, 'hook-entry.mjs');
  fs.writeFileSync(ENTRY, `
    export { useDeferredPreview } from ${JSON.stringify(path.join(REPO, 'src/hooks/useDeferredPreview.js'))};
    export * as React from 'react';
    export { createRoot } from 'react-dom/client';
    export { act } from 'react';
  `);
  const BUNDLE = path.join(WORK, 'hook.cjs');
  await build({ entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')], define: { 'process.env.NODE_ENV': '"development"' } });
  const { JSDOM } = await import(req.resolve('jsdom'));
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { useDeferredPreview, React, createRoot, act } = req(BUNDLE);
  const renders = [];
  const render = (source) => { renders.push(source); return `<p>${source.length}</p>`; };
  let last = null;
  function Probe(props) { last = useDeferredPreview({ ...props, render }); return React.createElement('div', { id: 'out' }, last.pending ? 'PENDING' : (last.html || '')); }
  const root = createRoot(document.getElementById('root'));
  const show = async (props) => { await act(async () => { root.render(React.createElement(Probe, props)); }); };
  const frames = async () => { await act(async () => { await sleep(60); }); };   // a frame (16 ms in jsdom) and the macrotask after it

  await show({ active: true, source: 'small', huge: false, documentKey: 'd1' });
  check('a small document: the HTML is there in the same render, nothing pending, the render ran once synchronously', last.html === '<p>5</p>' && last.pending === false && renders.length === 1);
  renders.length = 0;
  await show({ active: true, source: 'HUGE-A', huge: true, documentKey: 'd2' });
  check('a huge document: pending first, with no HTML and the render not yet run', last.pending === true && last.html === null && renders.length === 0);
  await frames();
  check('...after a frame and a macrotask the HTML is there and pending is over', last.pending === false && last.html === '<p>6</p>' && renders.length === 1, JSON.stringify(last));
  // a later version within the opening: silent
  await show({ active: true, source: 'HUGE-AB', huge: true, documentKey: 'd2', version: 1 });
  check('a later version within one opening: the old HTML stays on screen, pending stays false while the new render waits', last.pending === false && last.html === '<p>6</p>' && renders.length === 1);
  await frames();
  check('...and the new HTML replaces it', last.html === '<p>7</p>' && renders.length === 2);
  // closing before the frame cancels
  renders.length = 0;
  await show({ active: true, source: 'HUGE-C', huge: true, documentKey: 'd3' });
  check('a new document: pending again', last.pending === true && renders.length === 0);
  await show({ active: false, source: 'HUGE-C', huge: true, documentKey: 'd3' });
  await frames();
  check('closing the preview before the frame cancels the render: it never ran, nothing is shown', renders.length === 0 && last.html === null && last.pending === false);
  // re-opening starts from the indicator
  await show({ active: true, source: 'HUGE-AB', huge: true, documentKey: 'd2' });
  check('re-opening the preview of a document rendered in an earlier opening starts from the indicator (its earlier HTML is not shown)', last.pending === true && last.html === null);
  await frames();
  check('...and renders again', last.pending === false && last.html === '<p>7</p>');
  await act(async () => { root.render(null); });
}

// ---------------------------------------------------------------------------
// browser: painted before the blocking render; the indicator's look
// ---------------------------------------------------------------------------
if (!build || !pw) console.log(`SKIP (browser): ${!build ? 'esbuild' : 'playwright-core'} is not installed`);
else if (process.env.SKIP_BROWSER_TESTS) console.log('SKIP (browser): SKIP_BROWSER_TESTS is set');
else {
  const ENTRY = path.join(WORK, 'page-entry.jsx');
  fs.writeFileSync(ENTRY, `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Loader2 } from 'lucide-react';
    import { useDeferredPreview } from ${JSON.stringify(path.join(REPO, 'src/hooks/useDeferredPreview.js'))};
    import { Note } from ${JSON.stringify(path.join(REPO, 'src/components/ui/primitives.jsx'))};
    window.marks = {};
    const blockingRender = (source) => { window.marks.renderStart = performance.now(); const until = performance.now() + 600; while (performance.now() < until) { /* the synchronous pipeline */ } return '<p>rendered ' + source.length + '</p>'; };
    function Indicator({ lines }) {
      return (
        <div className="markdown-preview h-full px-6 py-4 overflow-y-auto bg-os-card" data-testid="preview-rendering" aria-busy="true" ref={(el) => { if (el && !window.marks.mounted) { window.marks.mounted = performance.now(); requestAnimationFrame(() => { window.marks.painted = performance.now(); }); } }}>
          <Note tone="info" icon={null} testId="preview-rendering-note">
            <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden="true" />Rendering preview of {lines.toLocaleString()} lines&hellip;</span>
          </Note>
        </div>
      );
    }
    function App() {
      const [active, setActive] = useState(false);
      const [still, setStill] = useState(false);   // the indicator on its own, for the screenshots (a blocked main thread cannot be screenshotted)
      window.setActive = setActive; window.showIndicator = setStill;
      const { html, pending } = useDeferredPreview({ active, source: 'x\\n'.repeat(1000), huge: true, documentKey: 'doc', render: blockingRender });
      if (still) return <Indicator lines={2000000} />;
      return active ? (pending ? <Indicator lines={2000000} /> : <div className="markdown-preview h-full px-6 py-4 overflow-y-auto bg-os-card" data-testid="preview-content" dangerouslySetInnerHTML={{ __html: html }} />) : <div data-testid="editor">editor</div>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `);
  const BUNDLE = path.join(WORK, 'page.js');
  await build({
    entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'iife', platform: 'browser', logLevel: 'error', jsx: 'automatic',
    nodePaths: [path.join(REPO, 'node_modules')], conditions: ['browser', 'import', 'default'], mainFields: ['browser', 'module', 'main'],
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    plugins: [{ name: 'node-builtins', setup(b) { b.onResolve({ filter: /^node:/ }, (a) => (isBuiltin(a.path) ? { path: a.path, external: true } : null)); } }],
  });
  // the app's built stylesheet (the theme tokens and the utilities the Note uses), when a build is there
  const builtCss = fs.existsSync(path.join(REPO, 'dist', 'assets')) ? fs.readdirSync(path.join(REPO, 'dist', 'assets')).find((f) => /^index-.*\.css$/.test(f)) : null;
  if (builtCss) fs.copyFileSync(path.join(REPO, 'dist', 'assets', builtCss), path.join(WORK, 'app.css'));
  else console.log('  (no dist/assets build: the screenshots use the fallback tokens only)');
  const PAGE = path.join(WORK, 'index.html');
  fs.writeFileSync(PAGE, `<!doctype html><html><head><meta charset="utf-8"><title>preview</title>${builtCss ? '<link rel="stylesheet" href="app.css">' : ''}<style>html, body { margin: 0; height: 100%; } #root { height: 100vh; } body { background: var(--os-card, #fff); }</style></head><body><div id="root"></div><script src="page.js"></script></body></html>`);
  let browser = null;
  try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP (browser): no Chromium for playwright-core: ${e.message.slice(0, 100)}`); }
  if (browser) {
    const shots = process.env.PREVIEW_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'preview-indicator-shots-'));
    fs.mkdirSync(shots, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 400 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await page.goto('file://' + PAGE);
    await page.waitForSelector('[data-testid="editor"]');
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); window.marks = {}; window.setActive(false); window.showIndicator(true); }, theme);
      await page.waitForSelector('[data-testid="preview-rendering-note"]', { timeout: 5000 });
      await sleep(150);
      const text = await page.textContent('[data-testid="preview-rendering-note"]');
      const spinner = await page.$('[data-testid="preview-rendering-note"] .animate-spin');
      await page.screenshot({ path: path.join(shots, `preview-rendering-${theme}.png`) });
      check(`${theme}: the indicator says "Rendering preview of 2,000,000 lines…" with the spinner, in the shared Note`, /Rendering preview of 2,000,000 lines…/.test(text) && spinner !== null, text);
      // then the real flow: open the preview - the indicator mounts, a frame is painted, only then the blocking render, then the content
      await page.evaluate(() => { window.showIndicator(false); window.marks = {}; });
      await sleep(50);
      await page.evaluate(() => window.setActive(true));
      await page.waitForSelector('[data-testid="preview-content"]', { timeout: 10000 });
      const marks = await page.evaluate(() => window.marks);
      check(`${theme}: the indicator was mounted and painted (a frame) before the blocking render started, and the content followed`, marks.mounted > 0 && marks.painted > marks.mounted && marks.renderStart > marks.painted, JSON.stringify(marks));
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
    console.log(`  screenshots in ${shots}`);
    await browser.close();
  }
}
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
