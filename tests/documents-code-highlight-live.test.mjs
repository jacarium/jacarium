/**
 * Real-browser check of fenced-code syntax highlighting in the Documents
 * preview and PDF export (src/utils/codeHighlight.js,
 * src/utils/interactiveMarkdown.js renderer.code, the --os-code-* tokens
 * and .hljs-* rules in src/index.css, DocumentEditor.jsx preview memo,
 * useImportExport.js exportDocumentToPDF).
 *
 * tests/documents-code-highlight.test.mjs proves the routing, escaping and
 * the palette's contrast MATH in jsdom. This file drives the REAL Electron app
 * (Playwright, Vite dev server, throwaway profile) and proves what the user
 * actually sees:
 *   - a document with ```python / ```go / ```bash / ```yaml / ```json
 *     fences shows each as a code block with highlight tokens whose text
 *     equals the source; a bare ``` fence and a ```rust fence render as
 *     plain text (no spans, the block's base code colour); a hostile
 *     python block creates no elements; a ```mermaid fence in the same
 *     document still renders as an SVG diagram;
 *   - LIGHT theme: every token's computed colour measures >= 4.5:1 (WCAG
 *     AA) against the code block's computed background, and at least three
 *     distinct token colours are in use per language (it is really
 *     highlighted, not one colour);
 *   - DARK theme (the `dark` class ThemeContext puts on <html>): the SAME
 *     code elements stay connected (a theme switch recolours via CSS
 *     variables, it does not rebuild the preview DOM), every token again
 *     measures >= 4.5:1 against the now-dark block background, the palette
 *     changed, and the plain blocks use the dark base code colour;
 *   - an unrelated window resize while in preview leaves the code DOM
 *     untouched (no needless re-render);
 *   - "Export PDF" produces a PDF whose drawn text contains the code
 *     (highlighted blocks still export as real text, not images) and the
 *     export container's blocks carried the highlight spans;
 *   - no uncaught exception in the page throughout.
 *
 * Synthetic content only, fresh throwaway Chrome profile (its own empty
 * IndexedDB - never the user's documents).
 *
 * SKIPS (exit 0, "SKIP:" line) when no Chrome/Chromium binary is found or
 * SKIP_BROWSER_TESTS=1 is set, like the other real-browser tests. Set
 * Skips (exit 0) when the Electron app cannot be launched here.
 *
 * Run:  node tests/documents-code-highlight-live.test.mjs
 * Environment: SKIP_ELECTRON_TESTS, PDF_OUT (optional path
 * to also write the generated PDF to for inspection), SHOTS_DIR (optional
 * directory; when set, a PNG of the preview is saved per theme for
 * eyeballing: code-highlight-light.png / code-highlight-dark.png).
 * Exit code 0 = all checks passed (or skipped), 1 = a check failed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inspectPdf } from './helpers/pdf-inspect.mjs';
import { launchElectronDocumentsApp } from './helpers/electron-app.mjs';
import {
  createNewDocument, setEditorContent, clickPreviewButton, exportDocumentPdf, sleep,
} from './helpers/live-documents-app.mjs';


const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}

// Relative luminance of an "rgb(r, g, b)" string (for the dark-background check).
function lum(rgb) {
  const m = rgb.match(/(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return 1;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
}

// ---------- synthetic document ----------
const fence = (lang, body) => '```' + lang + '\n' + body + '\n```';
const SAMPLES = {
  python: 'import os\n\ndef greet_zq(name: str) -> str:\n    # say hello\n    count = 42\n    return f"hello {name}" * count',
  go: 'package main\n\nimport "fmt"\n\n// entry point\nfunc mainzq() {\n\tvar n int = 7\n\tfmt.Println("hello", n)\n}',
  bash: '#!/usr/bin/env bash\n# list things\nfor f in *.txt; do\n  echo "file: $f" >&2\ndone\nexit 0',
  yaml: '# service definition\napiVersionzq: v1\nkind: Service\nmetadata:\n  name: demo\n  replicas: 3\n  enabled: true',
  json: '{\n  "namezq": "demo",\n  "replicas": 3,\n  "enabled": true,\n  "tags": ["web", null]\n}',
};
const PLAIN_SRC = 'def plain_zq():\n    return "not highlighted"';
const RUST_SRC = 'fn rust_zq() { println!("plain"); }';
const HOSTILE_SRC = 'x = "<script>window.__pwned = 1</script>"\n# <img src=x onerror="window.__pwned = 2">';
const MERMAID_SRC = 'graph TD\n  Alpha[Intake queue] --> Beta[Triage]';
const DOC = [
  '# Highlight check (synthetic)', '',
  fence('python', SAMPLES.python), '',
  fence('go', SAMPLES.go), '',
  fence('bash', SAMPLES.bash), '',
  fence('yaml', SAMPLES.yaml), '',
  fence('json', SAMPLES.json), '',
  fence('', PLAIN_SRC), '',
  fence('rust', RUST_SRC), '',
  fence('python', HOSTILE_SRC), '',
  fence('mermaid', MERMAID_SRC), '',
  'Trailing paragraph.', '',
].join('\n');

// Runs in the page: computed colours of every hljs token in every code
// block, the block's computed background, WCAG contrast per token, plus a
// stable per-element marker so a later snapshot can tell whether the DOM
// was rebuilt.
const INSPECT = `(() => {
  const toRgb = (s) => { const m = s && s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map((v) => parseFloat(v)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const bgOf = (el) => { let n = el; while (n) { const c = toRgb(getComputedStyle(n).backgroundColor); if (c && c.a >= 0.99) return c; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const preview = document.querySelector('.markdown-preview');
  if (!preview) return null;
  window.__probeSeq = window.__probeSeq || 0;
  const blocks = Array.from(preview.querySelectorAll('pre > code')).map((code) => {
    if (!code.__probe) code.__probe = ++window.__probeSeq;
    const bg = bgOf(code);
    const base = toRgb(getComputedStyle(code).color);
    const tokens = Array.from(code.querySelectorAll('span[class*="hljs-"]')).map((s) => {
      const c = toRgb(getComputedStyle(s).color);
      return { cls: s.className, color: c ? 'rgb(' + c.r + ', ' + c.g + ', ' + c.b + ')' : null, contrast: c ? contrast(c, bg) : 0 };
    });
    return {
      cls: code.className, probe: code.__probe, connected: code.isConnected,
      text: code.textContent, children: code.children.length, nonSpan: code.querySelectorAll(':not(span)').length,
      bg: 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')', base: base ? 'rgb(' + base.r + ', ' + base.g + ', ' + base.b + ')' : null,
      baseContrast: base ? contrast(base, bg) : 0,
      tokens, distinct: new Set(tokens.map((t) => t.color)).size,
      inMermaid: !!code.closest('.mermaid-diagram'),
    };
  });
  const mermaid = Array.from(preview.querySelectorAll('.mermaid-diagram')).map((d) => ({ state: d.dataset.mermaid, theme: d.dataset.mermaidTheme, svg: !!d.querySelector('svg') }));
  return { dark: document.documentElement.classList.contains('dark'), blocks, mermaid, pwned: window.__pwned, forbidden: preview.querySelectorAll('script, img:not(.attachment-image), b').length };
})()`;

async function screenshot(name) {
  if (!process.env.SHOTS_DIR) return;
  mkdirSync(process.env.SHOTS_DIR, { recursive: true });
  // A fresh profile shows the "What's New" dialog over the editor; dismiss it
  // so the screenshot shows the preview.
  await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Got it!'); if (b) b.click(); })()`);
  await sleep(400);
  const shot = await app.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) writeFileSync(path.join(process.env.SHOTS_DIR, `code-highlight-${name}.png`), Buffer.from(shot.result.data, 'base64'));
}

const byLang = (snap, lang) => snap.blocks.find((b) => !b.inMermaid && b.cls.includes('language-' + lang));
const worst = (b) => (b.tokens.length ? Math.min(...b.tokens.map((t) => t.contrast)) : 0);
const fmtTokens = (b) => JSON.stringify(b.tokens.filter((t) => t.contrast < 4.5).slice(0, 4).map((t) => [t.cls, t.color, t.contrast.toFixed(2)]));

// The real Electron app (the PDF export only exists there), behind the same
// driver shape the headless-Chrome version used
const app = await launchElectronDocumentsApp({ profilePrefix: 'doc-code-highlight-' });
if (app.skip) {
  console.log(`SKIP: ${app.skip}`);
  process.exit(0);
}

let exitCode = 1;
try {
  // ---------- 1. type the document, open the preview ----------
  check('Documents page shows the empty-state New Document button on a fresh profile', await createNewDocument(app));
  check('typed the synthetic document', (await setEditorContent(app, DOC)) === DOC);
  check('Preview turned on', await clickPreviewButton(app));
  const light = await app.waitFor(`(() => { const s = ${INSPECT}; return s && s.blocks.length >= 9 && s.mermaid.length === 1 && s.mermaid[0].state !== 'pending' ? s : null; })()`, 30000);
  check('preview rendered every block and the mermaid diagram', !!light, light ? '' : 'timed out waiting for the preview');
  if (!light) throw new Error('preview did not render');
  check('the app is in its light theme for the first pass', !light.dark);
  await screenshot('light');

  // ---------- 2. light theme: tokens, fidelity, contrast ----------
  for (const [lang, src] of Object.entries(SAMPLES)) {
    const b = byLang(light, lang);
    check(`light: \`\`\`${lang} is a highlighted block (code.hljs.language-${lang} with token spans, only spans inside)`,
      !!b && /\bhljs\b/.test(b.cls) && b.tokens.length > 0 && b.nonSpan === 0, b ? `${b.cls} tokens=${b.tokens.length}` : 'missing');
    if (!b) continue;
    check(`light: \`\`\`${lang} text equals the source`, b.text === src + '\n', JSON.stringify(b.text.slice(0, 50)));
    check(`light: \`\`\`${lang} uses >= 3 distinct token colours (really highlighted)`, b.distinct >= 3, `distinct=${b.distinct}`);
    check(`light: \`\`\`${lang} every token >= 4.5:1 against the block background ${b.bg} (worst ${worst(b).toFixed(2)})`, worst(b) >= 4.5, fmtTokens(b));
    check(`light: \`\`\`${lang} base code text >= 4.5:1 against the block background`, b.baseContrast >= 4.5, `${b.base} on ${b.bg} = ${b.baseContrast.toFixed(2)}`);
  }
  const plain = light.blocks.find((b) => b.text === PLAIN_SRC + '\n');
  const rust = light.blocks.find((b) => b.cls === 'language-rust');
  check('light: the bare ``` fence is plain text (no class, no child elements)', !!plain && plain.cls === '' && plain.children === 0, plain ? plain.cls : 'missing');
  check('light: the ```rust fence is plain text (language-rust only, no child elements, source intact)', !!rust && rust.children === 0 && rust.text === RUST_SRC + '\n', rust ? JSON.stringify(rust) : 'missing');
  const hostile = light.blocks.find((b) => b.text === HOSTILE_SRC + '\n');
  check('light: the hostile python block kept its source as text and created no script/img/b elements; nothing executed',
    !!hostile && hostile.nonSpan === 0 && light.forbidden === 0 && light.pwned === undefined, JSON.stringify({ forbidden: light.forbidden, pwned: light.pwned }));
  check('light: the ```mermaid fence rendered as an SVG diagram in the same document', light.mermaid[0].state === 'rendered' && light.mermaid[0].svg && light.mermaid[0].theme === 'default', JSON.stringify(light.mermaid));

  // ---------- 3. unrelated resize: no rebuild ----------
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  await app.send('Emulation.clearDeviceMetricsOverride');
  await sleep(600);
  const afterResize = await app.evaluate(INSPECT);
  check('a viewport resize while in preview leaves the same code elements connected (no rebuild)',
    afterResize && afterResize.blocks.every((b, i) => b.probe === light.blocks[i].probe && b.connected), JSON.stringify(afterResize && afterResize.blocks.map((b) => b.probe)));

  // ---------- 4. dark theme ----------
  await app.evaluate(`document.documentElement.classList.add('dark')`);
  const dark = await app.waitFor(`(() => { const s = ${INSPECT}; return s && s.dark && s.mermaid[0] && s.mermaid[0].theme === 'dark' ? s : null; })()`, 30000);
  check('switched the app to the dark theme (mermaid re-rendered with its dark theme)', !!dark, dark ? '' : 'timed out');
  if (!dark) throw new Error('dark theme did not apply');
  await screenshot('dark');
  check('dark: the SAME code elements are still connected (theme switch recolours via CSS variables, no preview rebuild)',
    dark.blocks.every((b, i) => b.probe === light.blocks[i].probe && b.connected), JSON.stringify(dark.blocks.map((b) => b.probe)));
  for (const lang of Object.keys(SAMPLES)) {
    const b = byLang(dark, lang);
    const lb = byLang(light, lang);
    check(`dark: \`\`\`${lang} block background is dark now`, !!b && b.bg !== lb.bg && lum(b.bg) < 0.1, b ? `${lb.bg} -> ${b.bg}` : 'missing');
    if (!b) continue;
    check(`dark: \`\`\`${lang} every token >= 4.5:1 against the dark block background ${b.bg} (worst ${worst(b).toFixed(2)})`, worst(b) >= 4.5, fmtTokens(b));
    check(`dark: \`\`\`${lang} token colours changed with the theme`, b.tokens.some((t, i) => t.color !== lb.tokens[i].color) && b.distinct >= 3, `distinct=${b.distinct}`);
    check(`dark: \`\`\`${lang} base code text >= 4.5:1`, b.baseContrast >= 4.5, `${b.base} on ${b.bg} = ${b.baseContrast.toFixed(2)}`);
  }
  const darkPlain = dark.blocks.find((b) => b.text === PLAIN_SRC + '\n');
  const darkRust = dark.blocks.find((b) => b.cls === 'language-rust');
  check('dark: plain and ```rust blocks stay plain and readable', !!darkPlain && !!darkRust && darkPlain.children === 0 && darkRust.children === 0 && darkPlain.baseContrast >= 4.5 && darkRust.baseContrast >= 4.5,
    JSON.stringify(darkPlain && [darkPlain.base, darkPlain.bg, darkPlain.baseContrast.toFixed(2)]));
  await app.evaluate(`document.documentElement.classList.remove('dark')`);
  await sleep(800);

  // ---------- 5. PDF export keeps the code as text ----------
  await app.evaluate(`(() => {
    window.__exportBlocks = null;
    const mo = new MutationObserver(() => {
      const root = document.querySelector('.pdf-export-root');
      if (root && !window.__exportBlocks) {
        const blocks = Array.from(root.querySelectorAll('pre > code'));
        if (blocks.length >= 9) window.__exportBlocks = blocks.map((c) => ({ cls: c.className, spans: c.querySelectorAll('span[class*="hljs-"]').length }));
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  })()`);
  const pdf = await exportDocumentPdf(app);
  check('Export PDF produced a PDF', !!pdf && pdf.subarray(0, 5).toString('latin1') === '%PDF-', pdf ? `${pdf.length} bytes` : 'no blob captured');
  if (pdf) {
    if (process.env.PDF_OUT) writeFileSync(process.env.PDF_OUT, pdf);
    const info = await inspectPdf(pdf);
    const pages = info.pages;
    const text = info.pageTexts.join(' ');
    const expectedRuns = ['greet_zq', 'mainzq', 'apiVersionzq', 'namezq', 'plain_zq', 'rust_zq', 'things'];
    const found = expectedRuns.filter((s) => text.includes(s));
    check(`PDF (${pages} page(s)) draws the code of every block as text (highlighted blocks export as text, not images)`,
      found.length === expectedRuns.length, `found ${found.length}/${expectedRuns.length}: missing ${JSON.stringify(expectedRuns.filter((s) => !found.includes(s)))}`);
    check('PDF draws the mermaid diagram as vector text (its labels are text, its source is not)', text.includes('Intake queue') && !text.includes('graph TD'));
  }
  const exportBlocks = await app.evaluate(`window.__exportBlocks`);
  check('the export container rendered the five highlighted blocks with token spans and the plain/rust blocks without',
    Array.isArray(exportBlocks) && exportBlocks.filter((b) => /\bhljs\b/.test(b.cls) && b.spans > 0).length === 6
      && exportBlocks.filter((b) => !/\bhljs\b/.test(b.cls) && b.spans === 0).length >= 3,
    JSON.stringify(exportBlocks));

  check('no uncaught exceptions in the page', app.errors.length === 0, app.errors.slice(0, 3).join(' || '));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.log('FAIL: unexpected error |', err && err.stack ? err.stack : err);
  exitCode = 1;
} finally {
  await app.close();
}
process.exit(exitCode);
