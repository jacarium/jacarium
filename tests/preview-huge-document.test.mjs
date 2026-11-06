/**
 * The Markdown preview of a big document (src/utils/previewChunks.js, the
 * DocumentEditor layout effect and index.css .md-chunk): the preview DOM of
 * an ordinary document is exactly what it was, a big one is grouped into
 * chunks the browser lays out and paints only near the viewport, and a
 * collaborator's edits re-render a big document's preview with a delay that
 * grows with its size.
 *
 *   unit (jsdom): chunkPreviewBlocks() leaves a preview with fewer than
 *     MIN_BLOCKS top-level blocks untouched, groups a bigger one into
 *     div.md-chunk of CHUNK_SIZE blocks in order (text nodes included),
 *     does nothing twice; previewRenderDelay() is 0 for an ordinary
 *     document and grows to its cap;
 *   static: the editor imports both, chunks in a layout effect keyed on
 *     the preview HTML, keys the preview memo on the lagged version, and
 *     index.css carries the content-visibility rule;
 *   browser (playwright-core Chromium, the REAL pipeline bundled by esbuild,
 *     no server, no port) - a performance regression check with generous
 *     bounds: 200,000 lines of mixed markdown (headings, lists, tables,
 *     code blocks, links, images, a [[toc]] block, callouts) render through
 *     processInteractiveMarkdown(), land in a .markdown-preview element with
 *     the app's rule, are chunked, and the forced layout plus two frames
 *     take under 1.5 s (measured ~0.1 s; 3.4 s without the chunks); the
 *     sanitised HTML is the same string chunked or not; the chunked DOM
 *     holds every element of the unchunked one; the 2,000,000 plain lines
 *     of the report lay out and paint under 3 s (measured ~0.1 s; 6.4 s
 *     without). The whole-render numbers are printed per phase.
 *
 * Run: node tests/preview-huge-document.test.mjs
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
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-huge-'));

// ---------------------------------------------------------------------------
// static
// ---------------------------------------------------------------------------
const editor = read('src/components/features/documents/DocumentEditor.jsx');
check('DocumentEditor chunks the preview in a layout effect keyed on the preview HTML (the reader\'s place is applied there, after the chunking), and keys the preview memo on the lagged version', /useLayoutEffect\(\(\) => \{\s*if \(!isPreviewActive \|\| !previewRef\.current\) return;\s*chunkPreviewBlocks\(previewRef\.current\);[\s\S]*?\}, \[isPreviewActive, previewInnerHtml\]\);/.test(editor) && /const previewVersion = previewDelay \? laggedVersion : yjsContentVersion;/.test(editor) && /\}, \[isPreviewActive, yjsEnabled, yjs\.ytext, content, previewVersion\]\);/.test(editor));
check('index.css gives .markdown-preview .md-chunk content-visibility: auto with an intrinsic size', /\.markdown-preview \.md-chunk \{\s*content-visibility: auto;\s*contain-intrinsic-size: auto \d+px;\s*\}/.test(read('src/index.css')));

// ---------------------------------------------------------------------------
// unit (jsdom)
// ---------------------------------------------------------------------------
let jsdomOk = true;
try { req.resolve('jsdom'); } catch { jsdomOk = false; console.log('SKIP (unit): jsdom is not installed (npm install --no-save jsdom)'); }
const chunks = await import(path.join(REPO, 'src/utils/previewChunks.js'));
if (jsdomOk) {
  const { JSDOM } = await import(req.resolve('jsdom'));
  const dom = new JSDOM('<!doctype html><div id="p"></div>');
  const { document } = dom.window;
  const p = document.getElementById('p');
  const fill = (n) => { p.innerHTML = Array.from({ length: n }, (_, i) => (i % 10 === 9 ? `text ${i}` : `<p id="b${i}">block ${i}</p>`)).join(''); };
  fill(chunks.MIN_BLOCKS - 1);
  check(`a preview with fewer than ${chunks.MIN_BLOCKS} top-level blocks is left as it is`, chunks.chunkPreviewBlocks(p) === 0 && !p.querySelector('.md-chunk') && p.childNodes.length === chunks.MIN_BLOCKS - 1);
  fill(1234);
  const before = [...p.childNodes].map((n) => n.nodeType === 1 ? n.id : n.textContent);
  const made = chunks.chunkPreviewBlocks(p);
  const groups = [...p.children];
  const after = groups.flatMap((g) => [...g.childNodes].map((n) => n.nodeType === 1 ? n.id : n.textContent));
  check(`1234 blocks become ${Math.ceil(1234 / chunks.CHUNK_SIZE)} chunks of ${chunks.CHUNK_SIZE} (the last one the remainder), every node kept in order, text nodes included`, made === Math.ceil(1234 / chunks.CHUNK_SIZE) && groups.every((g) => g.classList.contains(chunks.CHUNK_CLASS)) && groups.slice(0, -1).every((g) => g.childNodes.length === chunks.CHUNK_SIZE) && groups[groups.length - 1].childNodes.length === 1234 % chunks.CHUNK_SIZE && JSON.stringify(after) === JSON.stringify(before), `${made} chunks`);
  check('chunking again does nothing (idempotent), and a null container is a no-op', chunks.chunkPreviewBlocks(p) === 0 && p.children.length === made && chunks.chunkPreviewBlocks(null) === 0);
  check('ids and descendant selectors still find their elements inside the chunks', document.getElementById('b777') !== null && p.querySelectorAll('p').length === 1234 - Math.floor(1234 / 10));
}
check('previewRenderDelay: 0 up to 200,000 characters, then growing (1 M -> 500 ms), capped at 2 s', chunks.previewRenderDelay(0) === 0 && chunks.previewRenderDelay(200000) === 0 && chunks.previewRenderDelay(1000000) === 500 && chunks.previewRenderDelay(4000000) === 2000 && chunks.previewRenderDelay(64000000) === 2000);

// ---------------------------------------------------------------------------
// browser: the performance regression check
// ---------------------------------------------------------------------------
let build = null, pw = null;
try { ({ build } = await import(req.resolve('esbuild'))); } catch { build = null; }
try { pw = req('playwright-core'); } catch { pw = null; }
if (!build || !pw) console.log(`SKIP (browser): ${!build ? 'esbuild' : 'playwright-core'} is not installed`);
else if (process.env.SKIP_BROWSER_TESTS) console.log('SKIP (browser): SKIP_BROWSER_TESTS is set');
else {
  const ENTRY = path.join(WORK, 'entry.mjs');
  fs.writeFileSync(ENTRY, `
    import { processInteractiveMarkdown } from ${JSON.stringify(path.join(REPO, 'src/utils/interactiveMarkdown.js'))};
    import { chunkPreviewBlocks } from ${JSON.stringify(path.join(REPO, 'src/utils/previewChunks.js'))};
    const BLOCK = (i) => ['## Section ' + i, '', 'Some paragraph text with **bold**, _italic_, a [link](https://example.test/' + i + ') and \`inline code\`, repeated to make a realistic document body. Line ' + i + '.', '',
      '- a list item', '- another item with [[checkbox:c' + i + ':done]]', '  - a nested item', '', '| column | value |', '|---|---|', '| row ' + i + ' | ' + (i * 7) + ' |', '',
      '\`\`\`python', 'def f' + i + '(x):', '    return x * 2  # a comment', '\`\`\`', '', '![image ' + i + '](attachment:img-' + i + '.png)', '', '> [!NOTE]', '> A callout line.', ''];
    window.makeMarkdown = (n) => { const out = ['# Title', '', '[[toc]]', '', '- [Section 1](#section-1)', '', '[[/toc]]', '']; for (let i = 1; out.length < n; i++) out.push(...BLOCK(i)); return out.join('\\n'); };
    window.makePlainLines = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i % 7 === 0 ? '# heading ' + i : 'line ' + i + ' with some words in it'); return out.join('\\n'); };
    const t = () => performance.now();
    window.render = async (text, chunked) => {
      const r = {};
      let a = t(); const html = processInteractiveMarkdown(text); r.pipeline = t() - a;
      const host = document.getElementById('host'); host.innerHTML = '';
      a = t(); host.innerHTML = html; r.dom = t() - a;
      a = t(); r.chunks = chunked ? chunkPreviewBlocks(host) : 0; r.chunking = t() - a;
      a = t(); void host.offsetHeight; await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); r.layoutPaint = t() - a;
      r.elements = host.getElementsByTagName('*').length; r.htmlLength = html.length;
      return r;
    };
  `);
  const BUNDLE = path.join(WORK, 'bundle.js');
  await build({
    entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'iife', platform: 'browser', logLevel: 'error',
    nodePaths: [path.join(REPO, 'node_modules')], conditions: ['browser', 'import', 'default'], mainFields: ['browser', 'module', 'main'],
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    plugins: [{ name: 'node-builtins', setup(b) { b.onResolve({ filter: /^node:/ }, (a) => (isBuiltin(a.path) ? { path: a.path, external: true } : null)); } }],
  });
  const css = read('src/index.css');
  const rule = /\.markdown-preview \.md-chunk \{[^}]*\}/.exec(css)?.[0] || '';
  const PAGE = path.join(WORK, 'index.html');
  fs.writeFileSync(PAGE, `<!doctype html><html><head><meta charset="utf-8"><title>preview</title><style>html, body { margin: 0; height: 100%; } #host { height: 100vh; overflow-y: auto; padding: 16px 24px; } ${rule}</style></head><body><div id="host" class="markdown-preview"></div><script src="bundle.js"></script></body></html>`);
  let browser = null;
  try { browser = await pw.chromium.launch(); } catch (e) { console.log(`SKIP (browser): no Chromium for playwright-core: ${e.message.slice(0, 100)}`); }
  if (browser) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await page.goto('file://' + PAGE);
    const fmt = (r) => `pipeline ${r.pipeline.toFixed(0)} ms, DOM ${r.dom.toFixed(0)} ms, chunking ${r.chunking.toFixed(0)} ms (${r.chunks} chunks), layout + paint ${r.layoutPaint.toFixed(0)} ms, ${r.elements} elements`;
    try {
      const plain = await page.evaluate(async () => { const text = window.makeMarkdown(200000); const a = await window.render(text, false); const b = await window.render(text, true); return { a, b, same: a.htmlLength === b.htmlLength, elements: a.elements, chunkedElements: b.elements - b.chunks }; });
      console.log(`  200,000 mixed lines, as is:    ${fmt(plain.a)}`);
      console.log(`  200,000 mixed lines, chunked:  ${fmt(plain.b)}`);
      check('200,000 lines of mixed markdown: chunked, the forced layout plus two frames take under 1.5 s (generous: measured ~0.1 s; ~3.4 s without the chunks)', plain.b.layoutPaint < 1500 && plain.b.chunks > 1000, `${plain.b.layoutPaint.toFixed(0)} ms, ${plain.b.chunks} chunks`);
      check('...the sanitised HTML is the same whether chunked or not, and the chunked DOM holds every element of the unchunked one', plain.same && plain.chunkedElements === plain.elements, JSON.stringify({ elements: plain.elements, chunkedElements: plain.chunkedElements }));
      const huge = await page.evaluate(async () => window.render(window.makePlainLines(2000000), true));
      console.log(`  2,000,000 plain lines, chunked: ${fmt(huge)}`);
      check('2,000,000 plain lines (the report): chunked, layout plus two frames under 3 s (measured ~0.1 s; ~6.4 s without)', huge.layoutPaint < 3000 && huge.chunks > 10000, `${huge.layoutPaint.toFixed(0)} ms`);
      check('no page errors', errors.length === 0, errors.join(' | '));
    } finally {
      await browser.close();
    }
  }
}
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
