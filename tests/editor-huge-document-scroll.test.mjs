/**
 * Scrolling a huge document in the editor (the 3.8.0 report: a document of
 * ~2,000,000 lines, scrolled to the end, then back up - from a few hundred
 * lines above the end the editor showed nothing, and scrolling further the
 * position jumped back down).
 *
 * The cause is upstream: once a document is taller than 7,000,000 px
 * (@codemirror/view's VP.MaxDOMHeight) CodeMirror scales its height map
 * down and works from estimates, and in that regime drawSelection()'s cursor
 * layer - which measures the cursor with coordsAtPos() on every view update,
 * in or out of the viewport - breaks the scrolling, with a bare
 * @codemirror/view 6.43.15 editor too (the newest release). The surface
 * (src/components/features/documents/codemirror/CodeMirrorSurface.js) keeps
 * the drawn selection off for a document that tall (isHugeDocument: the lines
 * times the line height, with room for wrapped lines) and switches it when a
 * document grows or shrinks across the line; the browser's own caret and
 * selection colour show there instead.
 *
 *   unit: isHugeDocument's threshold;
 *   static: the surface wires drawSelection() through its compartment, for
 *     the first state, replaceDocument() and document changes;
 *   browser (playwright-core Chromium, the REAL surface bundled by esbuild
 *     with the editor's own CSS from src/index.css; no server, no port):
 *     a 2,000,000-line document shaped like CodeMirror's huge-document
 *     example (a short HTML snippet repeated, with a line that wraps),
 *     scrolled to the end and back up 150 steps: every step renders lines in
 *     the viewport (never empty), the scroll position never moves back
 *     towards the end, the top line keeps rising and ends thousands of lines
 *     above the end; the cursor layer is absent on that document, present
 *     on a 50,000-line one, and goes when a small document grows past the
 *     line. Screenshots at the end and after the climb go to
 *     HUGE_DOC_SHOTS_DIR (default: a temporary directory).
 *
 * SKIPs the browser part without esbuild / playwright-core / Chromium.
 * Run: node tests/editor-huge-document-scroll.test.mjs
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

// ---------------------------------------------------------------------------
// static + unit
// ---------------------------------------------------------------------------
const surfaceSource = read('src/components/features/documents/codemirror/CodeMirrorSurface.js');
check('the surface exports isHugeDocument and HUGE_DOCUMENT_HEIGHT, and wires drawSelection() through a compartment', /export function isHugeDocument\(/.test(surfaceSource) && /export const HUGE_DOCUMENT_HEIGHT = 5000000/.test(surfaceSource) && /this\._selectionDrawing\.of\(this\._selectionDrawingFor\(text\)\)/.test(surfaceSource) && !/^\s+drawSelection\(\),$/m.test(surfaceSource));
check('replaceDocument() builds the next state with its own document\'s decision, and a document change re-decides and reconfigures', /this\._extensions\(String\(text \?\? ''\)\)/.test(surfaceSource) && /this\._selectionDrawing\.reconfigure\(huge \? \[\] : drawSelection\(\)\)/.test(surfaceSource));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'huge-doc-'));
let build = null, pw = null;
try { ({ build } = await import(req.resolve('esbuild'))); } catch { build = null; }
try { pw = req('playwright-core'); } catch { pw = null; }
if (!build) { console.log('SKIP: esbuild is not installed (npm install)'); }
else {
  // the module alone, for the unit checks (bundled: it imports @codemirror/*)
  const UNIT = path.join(WORK, 'unit.cjs');
  await build({ entryPoints: [path.join(REPO, 'src/components/features/documents/codemirror/CodeMirrorSurface.js')], bundle: true, outfile: UNIT, format: 'cjs', platform: 'node', logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')] });
  const { isHugeDocument, HUGE_DOCUMENT_HEIGHT } = req(UNIT);
  check(`isHugeDocument: ${HUGE_DOCUMENT_HEIGHT.toLocaleString('en')} px is the line - 200,000 lines at 22.4 px are under it, 250,000 are over, 2,000,000 far over; without a measured line height 24 px is assumed`, !isHugeDocument({ lines: 200000 }, 22.4) && isHugeDocument({ lines: 250000 }, 22.4) && isHugeDocument({ lines: 2000000 }, 22.4) && isHugeDocument({ lines: 210000 }, 0) && !isHugeDocument({ lines: 50000 }, 0));
}

// ---------------------------------------------------------------------------
// browser
// ---------------------------------------------------------------------------
if (build && !pw) console.log('SKIP (browser): playwright-core is not installed');
if (build && pw && !process.env.SKIP_BROWSER_TESTS) {
  const ENTRY = path.join(WORK, 'entry.mjs');
  fs.writeFileSync(ENTRY, `
    import { CodeMirrorSurface } from ${JSON.stringify(path.join(REPO, 'src/components/features/documents/codemirror/CodeMirrorSurface.js'))};
    const SNIPPET = ['<!doctype html>', '<meta charset="utf8">', '<body>', '  <h1>A heading in a huge document</h1>',
      '  <p>Some paragraph text that is long enough to wrap when the editor is narrow, repeated many times to save memory on the generator side.</p>',
      '  <ul>', '    <li>one</li>', '    <li>two</li>', '  </ul>', '  <pre>  code   with   spaces  </pre>'];
    window.makeDoc = (n) => { const lines = []; for (let i = 0; lines.length < n; i++) lines.push(SNIPPET[i % SNIPPET.length]); lines.push('</body>', ''); return lines.join('\\n'); };
    window.makeSurface = (doc) => { const host = document.getElementById('host'); host.innerHTML = ''; window.surface = new CodeMirrorSurface({ parent: host, doc }); window.view = window.surface.view; return window.view.state.doc.lines; };
  `);
  const BUNDLE = path.join(WORK, 'bundle.js');
  await build({
    entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'iife', platform: 'browser', logLevel: 'error',
    nodePaths: [path.join(REPO, 'node_modules')], conditions: ['browser', 'import', 'default'], mainFields: ['browser', 'module', 'main'],
    plugins: [{ name: 'node-builtins', setup(b) { b.onResolve({ filter: /^node:/ }, (a) => (isBuiltin(a.path) ? { path: a.path, external: true } : null)); } }],
  });
  // the editor's own rules from the app stylesheet (the .sc-editor-cm* block), with the tokens they use
  const css = read('src/index.css');
  const start = css.indexOf('.sc-editor-cm-host {');
  const end = css.indexOf('.sc-editor-cm .cm-ySelectionCaret:hover');
  const editorCss = start !== -1 && end !== -1 ? css.slice(start, css.indexOf('\n', end)) : '';
  check('the editor\'s stylesheet block was found in src/index.css for the page', editorCss.length > 500 && /line-height: 1\.6/.test(editorCss));
  const PAGE = path.join(WORK, 'index.html');
  fs.writeFileSync(PAGE, `<!doctype html><html><head><meta charset="utf-8"><title>huge document</title><style>
    html, body { margin: 0; height: 100%; } #host { height: 100vh; }
    :root { --os-card: #fff; --os-text-primary: #111; --os-text-muted: #777; --os-text-secondary: #555; --os-terminal-selection: #cce; --font-mono: ui-monospace, Menlo, monospace; --chart-warn: #e9a; --os-border: #ddd; --os-card-secondary: #f5f5f5; --radius-sm: 8px; }
    ${editorCss}
  </style></head><body><div id="host" class="sc-editor-cm-host"></div><script src="bundle.js"></script></body></html>`);

  let browser = null;
  try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP (browser): no Chromium for playwright-core: ${e.message.slice(0, 100)}`); }
  if (browser) {
    const shots = process.env.HUGE_DOC_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'huge-doc-shots-'));
    fs.mkdirSync(shots, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await page.goto('file://' + PAGE);
    const SNAP = `(() => { const v = window.view; const s = v.scrollDOM; const rect = s.getBoundingClientRect();
      const visible = [...v.contentDOM.querySelectorAll('.cm-line')].filter((l) => { const r = l.getBoundingClientRect(); return r.bottom > rect.top && r.top < rect.bottom; });
      return { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, visible: visible.length, topLine: visible[0] ? v.state.doc.lineAt(v.posAtDOM(visible[0])).number : null, cursorLayer: !!v.dom.querySelector('.cm-cursorLayer') }; })()`;
    try {
      // 1. the huge document
      const lines = await page.evaluate((n) => window.makeSurface(window.makeDoc(n)), 2000000);
      await sleep(400);
      let snap = await page.evaluate(SNAP);
      // (the scroll height is CodeMirror's 7,000,000 px cap plus the content's padding and the gutter's: the scaled regime)
      check(`a ${lines.toLocaleString('en')}-line document in the real surface: the drawn selection is off (no cursor layer), the height is capped at ${snap.scrollHeight} px (CodeMirror's scaled regime, far below the ${(lines * 22.4 / 1e6).toFixed(0)} M px of its real height)`, lines > 2000000 && !snap.cursorLayer && snap.scrollHeight < 7100000, JSON.stringify(snap));
      await page.evaluate(() => { const s = window.view.scrollDOM; s.scrollTop = s.scrollHeight; });
      await sleep(400);
      const atEnd = await page.evaluate(SNAP);
      await page.screenshot({ path: path.join(shots, 'huge-doc-end.png') });
      check('scrolled to the end: the last lines are rendered', atEnd.visible > 10 && atEnd.topLine > 1999900, JSON.stringify(atEnd));
      let prev = atEnd; const bad = [];
      for (let i = 1; i <= 150; i++) {
        await page.evaluate(() => { const s = window.view.scrollDOM; s.scrollTop = Math.max(0, s.scrollTop - s.clientHeight * 0.8); });
        await sleep(60);
        snap = await page.evaluate(SNAP);
        if (snap.visible === 0 || snap.scrollTop > prev.scrollTop + 1 || (snap.topLine !== null && prev.topLine !== null && snap.topLine > prev.topLine)) bad.push({ step: i, ...snap, prevTop: prev.scrollTop, prevLine: prev.topLine });
        if (bad.length === 1 && bad[0].step === i) await page.screenshot({ path: path.join(shots, `huge-doc-anomaly-${i}.png`) });
        prev = snap;
      }
      await page.screenshot({ path: path.join(shots, 'huge-doc-after-climb.png') });
      check('150 steps back up: lines rendered at every step (never empty), the scroll position never moved back towards the end, the top line never went down', bad.length === 0, bad.slice(0, 3).map((b) => JSON.stringify(b)).join(' || '));
      check(`...and the climb got well above the end (top line ${snap.topLine} after 150 steps, more than 3,000 lines up)`, snap.topLine !== null && snap.topLine < atEnd.topLine - 3000, JSON.stringify(snap));
      // 2. a normal document keeps the drawn selection
      await page.evaluate((n) => window.makeSurface(window.makeDoc(n)), 50000);
      await sleep(200);
      snap = await page.evaluate(SNAP);
      check('a 50,000-line document keeps the drawn selection (the cursor layer is there)', snap.cursorLayer, JSON.stringify(snap));
      // 3. a document that grows past the line loses it after the change, and gets it back when it shrinks
      const grown = await page.evaluate(async () => {
        const v = window.view; const n = v.state.doc.lines;
        v.dispatch({ changes: { from: v.state.doc.length, insert: window.makeDoc(300000) } });
        await new Promise((r) => setTimeout(r, 100));
        const after = { lines: v.state.doc.lines, cursorLayer: !!v.dom.querySelector('.cm-cursorLayer') };
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'short again' } });
        await new Promise((r) => setTimeout(r, 100));
        return { before: n, after, back: !!v.dom.querySelector('.cm-cursorLayer') };
      });
      check('a document that grows past the line loses the drawn selection after that change, and gets it back when it shrinks', grown.after.lines > 300000 && !grown.after.cursorLayer && grown.back, JSON.stringify(grown));
      check('no page errors', errors.length === 0, errors.join(' | '));
      console.log(`  screenshots in ${shots}`);
    } finally {
      await browser.close();
    }
  }
}
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
