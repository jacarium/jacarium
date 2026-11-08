#!/usr/bin/env node
/**
 * ```latex blocks as maths (src/utils/latexBlocks.js, the renderer's
 * placeholder in src/utils/interactiveMarkdown.js), under jsdom with the
 * real KaTeX:
 *
 *   1. the renderer: ```latex becomes an inert .latex-block placeholder with
 *      the escaped source (through the usual DOMPurify pass); $...$ and
 *      $$...$$ stay text; ```tex and ```math are ordinary code blocks;
 *   2. rendering: display mode with HTML + MathML, blank-line-separated
 *      formulas as separate displays, aligned / \\ inside one;
 *   3. errors: a readable box with KaTeX's message (escaped), never a throw;
 *   4. limits: the expansion budget stops a macro bomb quickly, sizes are
 *      clamped, an over-long block and too many parts are refused;
 *   5. trust off: \href, \url, \includegraphics, \htmlClass, \htmlStyle,
 *      \htmlData never reach the output (no <a>, href, javascript:, url());
 *      HTML-ish source is text;
 *   6. the sanitizer: crafted output loses scripts, links, images, event
 *      handlers, annotation-xml, <use>; style attributes keep only KaTeX's
 *      sizing properties with plain values;
 *   7. renderLatexBlocks on a DOM: states, output, abort, a load failure;
 *   8. the wiring: the preview effect, the PDF export, the stylesheet, the
 *      credits, the dependency (0.19.x, no install scripts), fonts bundled.
 *
 * Needs esbuild and jsdom. Run: node tests/latex-blocks.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
for (const dep of ['esbuild', 'jsdom', 'katex']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} is not installed`); process.exit(0); } }

// ---------------------------------------------------------------- the bundle under jsdom
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-blocks-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  import * as latex from '@worktree/src/utils/latexBlocks.js';
  import { processInteractiveMarkdown } from '@worktree/src/utils/interactiveMarkdown.js';
  import katex from 'katex';
  window.__harness = { ...latex, processInteractiveMarkdown, katex };
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'iife', platform: 'browser',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty', '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }], logLevel: 'error',
});
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DOMParser', 'MutationObserver', 'NodeFilter', 'Text', 'DocumentFragment', 'HTMLTemplateElement', 'HTMLFormElement', 'NamedNodeMap', 'Attr']) define(key, window[key]);
window.eval(fs.readFileSync(BUNDLE, 'utf8'));
const H = window.__harness;
const { katex } = H;
const parse = (html) => { const d = window.document.createElement('div'); d.innerHTML = html; return d; };

try {
  // ---- 1. the renderer
  const out = parse(H.processInteractiveMarkdown('Before\n\n```latex\nE = mc^2 & <b>\n```\n\nInline $x^2$ and $$y$$ stay text.\n\n```tex\n\\alpha\n```\n'));
  const block = out.querySelector('.latex-block');
  check('1. ```latex becomes a .latex-block placeholder, data-latex="pending", the source as an escaped code block (through DOMPurify)', !!block && block.dataset.latex === 'pending' && block.querySelector('pre > code.language-latex')?.textContent === 'E = mc^2 & <b>' && !block.querySelector('b'), block ? block.outerHTML.slice(0, 200) : 'none');
  check('1. $...$ and $$...$$ are plain text (no inline maths), ```tex is an ordinary code block', /Inline \$x\^2\$ and \$\$y\$\$ stay text\./.test(out.textContent) && out.querySelectorAll('.latex-block').length === 1 && !!out.querySelector('code.language-tex') && !out.querySelector('code.language-tex').closest('.latex-block'));

  // ---- 2. rendering
  const simple = H.renderLatexSource(katex, 'E = mc^2');
  const simpleDom = parse(simple.html);
  check('2. a formula renders in display mode with HTML and MathML (one .katex-display, one <math>, the TeX annotation)', !simple.error && simpleDom.querySelectorAll('.katex-display').length === 1 && simpleDom.querySelectorAll('math').length === 1 && simpleDom.querySelector('annotation')?.textContent === 'E = mc^2', simple.html.slice(0, 200));
  const two = H.renderLatexSource(katex, '\\int_0^1 x\\,dx\n\n\\sum_n a_n\n\n\n');
  check('2. blank-line-separated formulas become separate displays (two), trailing blank lines ignored', !two.error && parse(two.html).querySelectorAll('.katex-display').length === 2 && H.splitFormulas('a\n\nb\n  \nc\n').join('|') === 'a|b|c');
  const aligned = H.renderLatexSource(katex, '\\begin{aligned}\na &= b \\\\\n  &= c\n\\end{aligned}');
  check('2. a multi-line aligned environment is one display', !aligned.error && parse(aligned.html).querySelectorAll('.katex-display').length === 1 && /mtable/.test(aligned.html));

  // ---- 3. errors
  const broken = H.renderLatexSource(katex, '\\frac{1}{ <b>x</b>');
  const brokenDom = parse(broken.html);
  check('3. a formula that does not parse becomes an error box with KaTeX\'s message, the message escaped (no <b> element), nothing thrown', !!broken.error && !!brokenDom.querySelector('.latex-block-error.mermaid-diagram-error') && /Expected|group/i.test(brokenDom.querySelector('.mermaid-diagram-error-message').textContent) && !brokenDom.querySelector('b'), broken.html.slice(0, 300));

  // ---- 4. limits
  const t0 = Date.now();
  const bomb = H.renderLatexSource(katex, '\\def\\a{\\a\\a}\\a');
  const bombMs = Date.now() - t0;
  check(`4. a macro bomb stops at the expansion budget (${H.MAX_EXPAND}) with an error box, quickly (${bombMs} ms)`, !!bomb.error && /expansion|Too many/i.test(bomb.error) && bombMs < 3000, bomb.error);
  const t1 = Date.now();
  const bomb2 = H.renderLatexSource(katex, '\\newcommand{\\x}[1]{#1#1#1#1#1#1#1#1}\\x{\\x{\\x{\\x{\\x{\\x{\\x{\\x{a}}}}}}}}');
  check(`4. an exponential macro is cut off too (${Date.now() - t1} ms)`, (bomb2.error ? /expansion|Too many|length/i.test(bomb2.error) : parse(bomb2.html).textContent.length < 200000) && Date.now() - t1 < 3000, bomb2.error || 'rendered');
  const rule = H.renderLatexSource(katex, '\\rule{9999em}{2em}');
  const widths = [...rule.html.matchAll(/width:\s*([\d.]+)em/g)].map((m) => Number(m[1]));
  check(`4. a size beyond maxSize (${H.MAX_SIZE_EM} em) is clamped (widths ${widths.join('/')})`, !rule.error && widths.length > 0 && widths.every((w) => w <= H.MAX_SIZE_EM), rule.html.slice(0, 200));
  const long = H.renderLatexSource(katex, 'x+'.repeat(H.MAX_SOURCE_CHARS));
  check('4. an over-long block is refused with a box (not parsed)', long.error === 'too long' && /characters long/.test(long.html));
  const many = H.renderLatexSource(katex, Array.from({ length: H.MAX_PARTS + 1 }, (_, i) => `x_{${i}}`).join('\n\n'));
  check('4. too many blank-line parts are refused with a box', many.error === 'too many parts');

  // ---- 5. trust off and hostile source
  const hostile = {
    href: '\\href{javascript:alert(1)}{click}',
    url: '\\url{javascript:alert(1)}',
    graphics: '\\includegraphics[height=1em]{javascript:alert(1)}',
    htmlClass: '\\htmlClass{evil-class}{x}',
    htmlStyle: '\\htmlStyle{background:url(javascript:alert(1))}{x}',
    htmlData: '\\htmlData{foo=bar}{x}',
    htmlId: '\\htmlId{pwn}{x}',
    html: '<img src=x onerror=alert(1)> \\text{<script>alert(1)</script>}',
    color: '\\color{red} x \\textcolor{#00ff00}{y}',
  };
  for (const [name, src] of Object.entries(hostile)) {
    const r = H.renderLatexSource(katex, src);
    const d = parse(r.html);
    // the MathML annotation carries the TeX source as text (harmless); the markup around it is what matters
    for (const a of d.querySelectorAll('annotation')) a.remove();
    const html = d.innerHTML;
    const attrs = Array.from(d.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes).map((at) => `${at.name}=${at.value}`));
    const clean = !d.querySelector('a, img, script, iframe, [href], [src], [onerror], [onclick]') && !attrs.some((a) => /javascript:|url\(|expression\(/i.test(a)) && !/evil-class|data-foo|id="pwn"/.test(html) && !/javascript:/i.test(html.replace(/<mtext>[^<]*<\/mtext>|<span class="mord[^"]*">[^<]*<\/span>/g, ''));
    check(`5. ${name}: ${r.error ? 'an error box' : 'rendered (KaTeX shows an untrusted command as red text)'}, nothing hostile in the markup`, clean, html.slice(0, 300));
  }
  check('5. \\color still colours (plain colour values pass the style filter)', /color:\s*(red|#00ff00)/.test(H.renderLatexSource(katex, '\\color{red} x').html));

  // ---- 6. the sanitizer on crafted output
  const crafted = '<span class="katex" style="height:1.2em;background:url(javascript:alert(1));width:expression(1);color:#ff0000" onclick="alert(1)"><a href="javascript:alert(1)">x</a><img src="x"><script>1</script><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation><annotation-xml encoding="text/html"><p>h</p></annotation-xml></semantics></math><svg width="1em" viewBox="0 0 1 1"><use href="#x"/><path d="M0 0h1"/><foreignObject><div>f</div></foreignObject></svg><iframe src="x"></iframe></span>';
  const s = H.sanitizeLatexHtml(crafted);
  const sd = parse(s);
  check('6. crafted output loses the link, image, script, iframe, foreignObject, <use>, annotation-xml and the event handler; keeps the span, math, annotation, svg path', !sd.querySelector('a, img, script, iframe, foreignObject, use, annotation-xml, [onclick], [href], [src]') && !!sd.querySelector('span.katex') && !!sd.querySelector('math annotation') && !!sd.querySelector('svg path[d]'), s);
  check('6. the style attribute is reduced to KaTeX\'s own properties with plain values (height, color), url() and expression() gone', sd.querySelector('span.katex').getAttribute('style') === 'height:1.2em;color:#ff0000', sd.querySelector('span.katex').getAttribute('style'));
  check('6. sanitizeStyle: lengths, colours, transforms kept; url(), expression(), unknown properties dropped; nothing left means no attribute', H.sanitizeStyle('height:1.2em;vertical-align:-0.3em;top:-2.5px;margin-left:0.1em;transform:scale(0.5,1);color:rgb(1, 2, 3);background:url(x);width:expression(1);behavior:url(a);font-size:1.21em') === 'height:1.2em;vertical-align:-0.3em;top:-2.5px;margin-left:0.1em;transform:scale(0.5,1);color:rgb(1, 2, 3);font-size:1.21em' && H.sanitizeStyle('background:url(x)') === '', H.sanitizeStyle('height:1.2em;vertical-align:-0.3em;top:-2.5px;margin-left:0.1em;transform:scale(0.5,1);color:rgb(1, 2, 3);background:url(x);width:expression(1);behavior:url(a);font-size:1.21em'));

  // ---- 7. renderLatexBlocks on a DOM
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  container.innerHTML = H.processInteractiveMarkdown('```latex\nE=mc^2\n```\n\n```latex\n\\frac{1}{\n```\n');
  const res = await H.renderLatexBlocks(container, { load: async () => katex });
  const blocks = container.querySelectorAll('.latex-block');
  check('7. renderLatexBlocks: one rendered, one error; the output inserted before the kept source; states set', res.rendered === 1 && res.failed === 1 && blocks[0].dataset.latex === 'rendered' && blocks[1].dataset.latex === 'error' && blocks[0].firstElementChild.classList.contains('latex-block-output') && !!blocks[0].querySelector('pre > code') && !!blocks[1].querySelector('.latex-block-error'), JSON.stringify(res));
  check('7. a second pass finds nothing pending', H.findLatexTargets(container).length === 0 && (await H.renderLatexBlocks(container, { load: async () => katex })).rendered === 0);
  container.innerHTML = H.processInteractiveMarkdown('```latex\nx\n```\n');
  const ac = new window.AbortController ? new window.AbortController() : new AbortController();
  ac.abort();
  await H.renderLatexBlocks(container, { signal: ac.signal, load: async () => katex });
  check('7. an aborted render leaves the placeholder pending (nothing written)', container.querySelector('.latex-block').dataset.latex === 'pending' && !container.querySelector('.latex-block-output'));
  const failing = await H.renderLatexBlocks(container, { load: async () => { throw new Error('offline'); } });
  check('7. a KaTeX load failure becomes an error box ("could not be loaded"), not a throw', failing.failed === 1 && /could not be loaded: offline/.test(container.querySelector('.latex-block-error')?.textContent || ''));

  // ---- 8. the wiring
  const editor = read('src/components/features/documents/DocumentEditor.jsx');
  check('8. the preview effect renders the blocks like the mermaid one (lazy, aborted on unmount, the observer for rebuilds)', /renderLatexBlocks\(container, \{ signal: controller\.signal \}\)/.test(editor) && /container\.querySelector\(LATEX_PENDING_SELECTOR\)/.test(editor));
  const pdf = read('src/utils/pdfExportNative.js');
  check('8. the PDF export renders the blocks after the diagrams, before the stylesheet (with KaTeX\'s @font-face rules) is collected', /await renderLatexBlocks\(container, \{ signal: signal \|\| undefined \}\);/.test(pdf) && pdf.indexOf('renderLatexBlocks(container') < pdf.indexOf('collectExportStylesWithFonts(document)'));
  const css = read('src/index.css');
  check('8. index.css: the rendered source hidden, the display centred in the text colour, scrolling inside its box', /\.latex-block\[data-latex="rendered"\] > pre[\s\S]*display: none/.test(css) && /\.latex-block-output \.katex-display \{[^}]*overflow-x: auto/.test(css) && /\.latex-block-output \{[^}]*color: inherit/.test(css));
  check('8. About credits KaTeX (MIT) with its fonts', /name: 'KaTeX'/.test(read('src/components/common/modals/settings/AboutSettings.jsx')));
  const pkg = JSON.parse(read('package.json'));
  const katexPkg = JSON.parse(read('node_modules/katex/package.json'));
  check(`8. katex ^0.19.1 is a dependency (installed ${katexPkg.version}), the override agrees, the package has no install scripts`, pkg.dependencies.katex === '^0.19.1' && pkg.overrides.katex === '^0.19.1' && /^0\.19\./.test(katexPkg.version) && !['preinstall', 'install', 'postinstall'].some((k) => katexPkg.scripts && katexPkg.scripts[k]));
  const katexCss = read('node_modules/katex/dist/katex.min.css');
  check('8. KaTeX\'s stylesheet references its fonts by relative paths only (bundled by Vite), no http(s) URL', /url\(fonts\/KaTeX_Main-Regular\.woff2\)/.test(katexCss) && !/https?:\/\//.test(katexCss) && fs.existsSync(path.join(REPO, 'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2')));
  check('8. the lazy import loads KaTeX and its stylesheet together, once', /import\('katex'\), import\('katex\/dist\/katex\.min\.css'\)/.test(read('src/utils/latexBlocks.js')));
  check('8. the AI chat keeps its own renderer (```latex is a code block there, not maths)', !/latexBlocks|interactiveMarkdown/.test(read('src/components/common/AIMessageMarkdown.jsx')));
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
