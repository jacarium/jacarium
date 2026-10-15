/**
 * Guards Mermaid diagram support in the Documents preview / PDF export
 * (src/utils/interactiveMarkdown.js renderer.code +
 *  src/utils/mermaidDiagrams.js, wired by
 *  src/components/features/documents/DocumentEditor.jsx and
 *  src/hooks/useImportExport.js).
 *
 * THE FEATURE: a ```mermaid fenced block in a document renders as a diagram
 * in the preview (and the PDF export) instead of a code block. Requirements
 * this file pins down:
 *   - routing: only ```mermaid fences become .mermaid-diagram placeholders
 *     (source kept as an escaped code block); every other fence, inline
 *     code and the rest of the markdown pipeline are untouched;
 *   - security: hostile diagram source can never inject markup through the
 *     placeholder; mermaid is initialized with securityLevel 'strict' and
 *     htmlLabels off; its SVG is DOMPurify-sanitized (no <script>, no
 *     event handlers, no <foreignObject>) before insertion; error messages
 *     are inserted as text;
 *   - errors: invalid source becomes an inline error box with the parse
 *     error, the source stays visible, sibling diagrams still render, and
 *     nothing throws;
 *   - stability: unique render ids per diagram, memoized SVG by
 *     source+theme, theme changes re-render only rendered diagrams, an
 *     aborted or unmounted render never writes into the DOM and leaves the
 *     placeholders re-renderable, a failed mermaid load degrades to error
 *     boxes;
 *   - wiring (source scans): mermaid is only ever reached through a
 *     dynamic import(); the editor passes an AbortSignal and re-renders on
 *     theme change; the PDF export awaits the diagrams before printing
 *     and treats .mermaid-diagram as an atomic block; index.css hides the
 *     source only once rendered.
 *
 * Real mermaid needs browser layout (getBBox), so it is replaced here by a
 * fake module (esbuild alias over 'mermaid') that records initialize()/
 * render() calls and returns a deliberately hostile SVG. Real rendering,
 * theming and the PDF are covered by tests/documents-mermaid-live.test.mjs
 * (headless Chrome). The bundle placement (lazy chunk, entry untouched) is
 * covered by tests/bundle-code-splitting.test.mjs.
 *
 * Run:  node tests/documents-mermaid-preview.test.mjs
 * Preconditions (checked at startup):
 *   - repo deps installed:   npm install
 *   - test-only deps:        npm install --no-save jsdom
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

function requireResolvable(name, hint) {
  try { req.resolve(name); } catch { console.error(`Missing dependency "${name}". ${hint}`); process.exit(1); }
}
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('marked', 'Run: npm install');
requireResolvable('dompurify', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-mermaid-preview-'));

// ---------- fake mermaid (aliased over the real package in the bundle) ----------
// Returns an SVG that carries everything the sanitizer must strip, so the
// checks below prove the output was sanitized rather than trusted.
const FAKE_MERMAID = path.join(WORKDIR, 'fake-mermaid.js');
fs.writeFileSync(FAKE_MERMAID, `
export const calls = { initialize: [], render: [] };
export const control = { delayMs: 0 };
const api = {
  initialize(config) { calls.initialize.push(config); },
  async render(id, text) {
    calls.render.push({ id, text });
    if (control.delayMs) await new Promise((r) => setTimeout(r, control.delayMs));
    if (/boom/.test(text)) {
      throw new Error('Parse error on line 2:\\n' + text.split('\\n')[1] + '\\nExpecting <b>NODE_STRING</b>, got "boom"');
    }
    const label = (text.split('\\n')[1] || 'label').trim();
    return {
      svg: '<svg id="' + id + '" xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 120 40" style="max-width: 120px;" role="graphics-document document">'
        + '<style>#' + id + ' .node rect{fill:#ececff;stroke:#9370db;}</style>'
        + '<g class="node"><rect x="1" y="1" width="100" height="30" rx="4"></rect><text x="10" y="20">' + label + '</text></g>'
        + '<script>window.__pwned = 1;</script>'
        + '<image href="x" onload="window.__pwned = 2"></image>'
        + '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml" onclick="window.__pwned = 3">html label</div></foreignObject>'
        + '</svg>',
    };
  },
};
export default api;
`);

// ---------- harness entry (bundled with the REAL modules) ----------
const ENTRY = path.join(WORKDIR, 'entry.js');
fs.writeFileSync(ENTRY, `
import { processInteractiveMarkdown, extractDocumentHeadings } from '@worktree/src/utils/interactiveMarkdown.js';
import * as mermaidDiagrams from '@worktree/src/utils/mermaidDiagrams.js';
import fakeMermaid, { calls, control } from 'mermaid';
window.__harness = { processInteractiveMarkdown, extractDocumentHeadings, ...mermaidDiagrams, fakeMermaid, calls, control };
`);

const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY],
  bundle: true,
  outfile: BUNDLE,
  format: 'cjs',
  platform: 'node',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
  nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{
    name: 'alias',
    setup(b) {
      b.onResolve({ filter: /^mermaid$/ }, () => ({ path: FAKE_MERMAID }));
      b.onResolve({ filter: /^@worktree\// }, (args) => ({
        path: path.join(REPO, args.path.replace(/^@worktree\//, '')),
      }));
      b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => {
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        try { return { path: req.resolve(args.path) }; } catch { return null; }
      });
    },
  }],
  logLevel: 'warning',
});

// ---------- jsdom environment (globals must exist before dompurify loads) ----------
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
define('window', window);
define('document', window.document);
define('navigator', window.navigator);
define('HTMLElement', window.HTMLElement);
define('Element', window.Element);
define('Node', window.Node);
define('DOMParser', window.DOMParser);
define('MutationObserver', window.MutationObserver);

createRequire(import.meta.url)(BUNDLE);
const H = window.__harness;
const { document } = window;

const fence = (lang, body) => '```' + lang + '\n' + body + '\n```';
const parse = (html) => { const div = document.createElement('div'); div.innerHTML = html; return div; };
const mount = (html) => { const div = parse(html); div.className = 'markdown-preview'; document.body.appendChild(div); return div; };

const SRC_A = 'graph TD\n  Alpha[Intake queue] --> Beta[Triage]';
const SRC_B = 'sequenceDiagram\n  Client->>Server: ping';
const SRC_BAD = 'graph TD\n  A --> boom oops';

let exitCode = 1;
try {
  // =====================================================================
  // Section 1: markdown routing (processInteractiveMarkdown)
  // =====================================================================
  {
    const md = ['# Title', '', fence('mermaid', SRC_A), '', fence('js', 'const x = 1;'), '', fence('', 'plain'), '', 'inline `code` here', ''].join('\n');
    const out = parse(H.processInteractiveMarkdown(md));
    const placeholders = out.querySelectorAll('.mermaid-diagram[data-mermaid="pending"]');
    check('section 1: a ```mermaid fence becomes exactly one pending .mermaid-diagram placeholder', placeholders.length === 1);
    const code = placeholders[0] && placeholders[0].querySelector('pre > code.language-mermaid');
    check('section 1: the placeholder keeps the diagram source as a plain code block (textContent === source)',
      !!code && code.textContent === SRC_A, code ? JSON.stringify(code.textContent) : 'no code element');
    const js = out.querySelector('pre > code.language-js');
    check('section 1: a ```js fence is untouched (marked\'s own <pre><code class="language-js">, not a placeholder)',
      !!js && !js.closest('.mermaid-diagram') && js.parentElement.outerHTML === '<pre><code class="language-js">const x = 1;\n</code></pre>',
      js ? js.parentElement.outerHTML : 'missing');
    const plain = Array.from(out.querySelectorAll('pre > code')).find((c) => !c.className);
    check('section 1: a fence without a language is untouched', !!plain && plain.textContent === 'plain\n' && !plain.closest('.mermaid-diagram'));
    check('section 1: inline code is untouched', out.querySelector('p > code') && out.querySelector('p > code').textContent === 'code');
    check('section 1: the rest of the document still renders (heading present)', out.querySelector('h1') && out.querySelector('h1').textContent === 'Title');

    const variants = { 'Mermaid': true, 'MERMAID': true, 'mermaid title="x"': true, 'mermaidjs': false, 'mermaid-ish': false, 'js': false };
    for (const [lang, expected] of Object.entries(variants)) {
      const v = parse(H.processInteractiveMarkdown(fence(lang, SRC_A)));
      check(`section 1: info string ${JSON.stringify(lang)} ${expected ? 'IS' : 'is NOT'} routed to the diagram placeholder`,
        (v.querySelectorAll('.mermaid-diagram').length === 1) === expected);
    }

    // Hostile source: the placeholder must escape it like any code block
    const hostile = 'graph TD\n  A["<img src=x onerror=alert(1)>"] --> B\n</code></pre></div><script>window.__pwned = 9</script><b>bold</b>';
    const h = parse(H.processInteractiveMarkdown(fence('mermaid', hostile)));
    const hCode = h.querySelector('.mermaid-diagram code');
    check('section 1: hostile diagram source cannot inject markup (no img/script/b elements; source is literal text)',
      h.querySelectorAll('.mermaid-diagram').length === 1 && !h.querySelector('img, script, b') && !!hCode && hCode.textContent === hostile,
      hCode ? hCode.textContent.slice(0, 80) : 'no code');
    check('section 1: a mermaid block is one placeholder even with a fake closing tag inside',
      h.querySelectorAll('pre').length === 1);

    // Headings inside a mermaid fence are not document headings
    const heads = H.extractDocumentHeadings('# Real\n\n' + fence('mermaid', 'graph TD\n  %% # not a heading\n  A --> B'));
    check('section 1: extractDocumentHeadings ignores "#" lines inside a mermaid fence', heads.length === 1 && heads[0].id === 'real');
  }

  // =====================================================================
  // Section 2: rendering into the placeholders (fake mermaid)
  // =====================================================================
  const c1 = mount(H.processInteractiveMarkdown([fence('mermaid', SRC_A), '', 'para', '', fence('mermaid', SRC_B)].join('\n')));
  {
    check('section 2: findMermaidTargets lists every pending placeholder', H.findMermaidTargets(c1, 'default').length === 2);
    const r = await H.renderMermaidDiagrams(c1, { theme: 'default' });
    check('section 2: both diagrams rendered, none failed', r.rendered === 2 && r.failed === 0, JSON.stringify(r));
    const els = Array.from(c1.querySelectorAll('.mermaid-diagram'));
    check('section 2: placeholders are marked rendered with the theme recorded',
      els.every((el) => el.getAttribute('data-mermaid') === 'rendered' && el.getAttribute('data-mermaid-theme') === 'default'));
    const svgs = els.map((el) => el.querySelector('.mermaid-diagram-output > svg'));
    check('section 2: each placeholder got an SVG output block inserted before the (kept) source <pre>',
      svgs.every(Boolean) && els.every((el) => el.firstElementChild.classList.contains('mermaid-diagram-output') && el.querySelector('pre > code.language-mermaid')));
    check('section 2: diagram labels came through as SVG <text>',
      svgs[0].querySelector('text').textContent.includes('Alpha') && svgs[1].querySelector('text').textContent.includes('Client'));
    check('section 2: render ids are unique per diagram and namespaced',
      H.calls.render.length === 2 && H.calls.render[0].id !== H.calls.render[1].id && H.calls.render.every((c) => /^mermaid-diagram-/.test(c.id)),
      H.calls.render.map((c) => c.id).join(', '));
    check('section 2: render ids are what the SVGs carry (no id collision between two diagrams in one document)',
      svgs[0].id !== svgs[1].id && svgs[0].id === H.calls.render[0].id);
    check('section 2: SVG output is sanitized - no <script>, no event handler attributes, no <foreignObject>',
      !c1.querySelector('script') && !c1.querySelector('[onload], [onclick]') && !c1.querySelector('foreignObject, foreignobject') && window.__pwned === undefined);
    check('section 2: mermaid\'s scoped <style> survives sanitization (theming is inside the SVG)',
      svgs.every((s) => s.querySelector('style') && s.querySelector('style').textContent.includes('#' + s.id)));
    const init = H.calls.initialize;
    check('section 2: mermaid.initialize called once with securityLevel strict, htmlLabels off, startOnLoad off, error graphic suppressed',
      init.length === 1 && init[0].securityLevel === 'strict' && init[0].htmlLabels === false && init[0].flowchart?.htmlLabels === false
        && init[0].startOnLoad === false && init[0].suppressErrorRendering === true && init[0].theme === 'default',
      JSON.stringify(init[0]));
    check('section 2: after rendering nothing is pending (no re-render loop fuel)', H.findMermaidTargets(c1, 'default').length === 0);
  }

  // =====================================================================
  // Section 3: errors never break the preview
  // =====================================================================
  const c3 = mount(H.processInteractiveMarkdown([fence('mermaid', SRC_BAD), '', fence('mermaid', 'graph LR\n  Ok --> Fine')].join('\n')));
  {
    let threw = null;
    let r = null;
    try { r = await H.renderMermaidDiagrams(c3, { theme: 'default' }); } catch (e) { threw = e; }
    check('section 3: invalid source does not throw out of renderMermaidDiagrams', !threw && r && r.rendered === 1 && r.failed === 1, threw ? String(threw) : JSON.stringify(r));
    const bad = c3.querySelector('.mermaid-diagram');
    const good = c3.querySelectorAll('.mermaid-diagram')[1];
    check('section 3: the invalid block is marked error and keeps its source code block visible',
      bad.getAttribute('data-mermaid') === 'error' && !!bad.querySelector('pre > code.language-mermaid') && !bad.querySelector('svg'));
    const box = bad.querySelector('.mermaid-diagram-error');
    const msg = box && box.querySelector('.mermaid-diagram-error-message');
    check('section 3: an inline error box with the parse error precedes the source',
      !!box && bad.firstElementChild === box && box.querySelector('.mermaid-diagram-error-title').textContent.length > 0
        && !!msg && /Parse error on line 2/.test(msg.textContent) && msg.textContent.includes('boom oops'),
      msg ? msg.textContent : 'no message');
    check('section 3: the error message is inserted as text, never markup', !!msg && !msg.querySelector('*') && msg.textContent.includes('<b>NODE_STRING</b>'));
    check('section 3: the sibling diagram in the same document still rendered', good.getAttribute('data-mermaid') === 'rendered' && !!good.querySelector('svg'));

    const none = mount('<p>no diagrams</p>');
    const r0 = await H.renderMermaidDiagrams(none, { theme: 'default', load: async () => { throw new Error('must not load'); } });
    check('section 3: a document without diagrams never loads mermaid', r0.rendered === 0 && r0.failed === 0);
  }

  // =====================================================================
  // Section 4: memoization by source + theme
  // =====================================================================
  {
    const before = H.calls.render.length;
    const c4 = mount(H.processInteractiveMarkdown(fence('mermaid', SRC_A)));
    const r = await H.renderMermaidDiagrams(c4, { theme: 'default' });
    check('section 4: the same source rendered again (e.g. preview re-opened) is served from the cache - no mermaid.render call',
      r.rendered === 1 && H.calls.render.length === before && !!c4.querySelector('svg'));
  }

  // =====================================================================
  // Section 5: theme change re-renders rendered diagrams only
  // =====================================================================
  {
    const darkTargets = H.findMermaidTargets(c3, 'dark');
    check('section 5: with a new theme, rendered diagrams are targets again but error blocks are not',
      darkTargets.length === 1 && darkTargets[0].getAttribute('data-mermaid') === 'rendered');
    const before = H.calls.render.length;
    const initBefore = H.calls.initialize.length;
    const r = await H.renderMermaidDiagrams(c1, { theme: 'dark' });
    const els = Array.from(c1.querySelectorAll('.mermaid-diagram'));
    check('section 5: theme change re-renders both diagrams with the new theme (cache is per theme)',
      r.rendered === 2 && H.calls.render.length === before + 2 && els.every((el) => el.getAttribute('data-mermaid-theme') === 'dark'));
    check('section 5: mermaid re-initialized with the dark theme exactly once',
      H.calls.initialize.length === initBefore + 1 && H.calls.initialize.at(-1).theme === 'dark');
    check('section 5: the old SVG output is replaced, not stacked', els.every((el) => el.querySelectorAll('.mermaid-diagram-output').length === 1));
    const back = await H.renderMermaidDiagrams(c1, { theme: 'default' });
    check('section 5: switching back is a pure cache hit', back.rendered === 2 && H.calls.render.length === before + 2);
  }

  // =====================================================================
  // Section 6: abort (preview closed / document switched mid-render)
  // =====================================================================
  {
    H.control.delayMs = 30;
    const c6 = mount(H.processInteractiveMarkdown(fence('mermaid', 'graph TD\n  Six --> Aborted')));
    const el = c6.querySelector('.mermaid-diagram');
    const controller = new AbortController();
    const p = H.renderMermaidDiagrams(c6, { theme: 'default', signal: controller.signal });
    check('section 6: a placeholder is claimed synchronously (state "rendering") so a concurrent call cannot double-render it',
      el.getAttribute('data-mermaid') === 'rendering' && H.findMermaidTargets(c6, 'default').length === 0);
    await sleep(5);
    controller.abort();
    check('section 6: abort synchronously releases the unfinished placeholder back to "pending"', el.getAttribute('data-mermaid') === 'pending');
    let threw = null;
    let r = null;
    try { r = await p; } catch (e) { threw = e; }
    await sleep(60);
    check('section 6: the aborted call resolves without throwing and writes nothing into the DOM',
      !threw && r && r.rendered === 0 && !c6.querySelector('.mermaid-diagram-output') && el.getAttribute('data-mermaid') === 'pending', threw ? String(threw) : '');
    const again = await H.renderMermaidDiagrams(c6, { theme: 'default' });
    check('section 6: a later call renders the released placeholder normally', again.rendered === 1 && !!c6.querySelector('svg'));

    const pre = new AbortController();
    pre.abort();
    const c6b = mount(H.processInteractiveMarkdown(fence('mermaid', 'graph TD\n  Already --> Aborted')));
    const rb = await H.renderMermaidDiagrams(c6b, { theme: 'default', signal: pre.signal });
    check('section 6: an already-aborted signal is a no-op that leaves the placeholder pending',
      rb.rendered === 0 && c6b.querySelector('.mermaid-diagram').getAttribute('data-mermaid') === 'pending');
    H.control.delayMs = 0;
  }

  // =====================================================================
  // Section 7: container unmounted mid-render (no signal)
  // =====================================================================
  {
    H.control.delayMs = 30;
    const c7 = mount(H.processInteractiveMarkdown(fence('mermaid', 'graph TD\n  Seven --> Detached')));
    const p = H.renderMermaidDiagrams(c7, { theme: 'default' });
    await sleep(5);
    c7.remove();
    let threw = null;
    try { await p; } catch (e) { threw = e; }
    check('section 7: removing the preview container mid-render neither throws nor writes into the detached tree',
      !threw && !c7.querySelector('.mermaid-diagram-output') && c7.querySelector('.mermaid-diagram').getAttribute('data-mermaid') === 'pending', threw ? String(threw) : '');
    H.control.delayMs = 0;
  }

  // =====================================================================
  // Section 8: mermaid chunk fails to load
  // =====================================================================
  {
    const c8 = mount(H.processInteractiveMarkdown([fence('mermaid', 'graph TD\n  Load --> Fails'), '', fence('mermaid', 'graph TD\n  Also --> Fails')].join('\n')));
    let threw = null;
    let r = null;
    try { r = await H.renderMermaidDiagrams(c8, { theme: 'default', load: async () => { throw new Error('Failed to fetch dynamically imported module'); } }); } catch (e) { threw = e; }
    const boxes = c8.querySelectorAll('.mermaid-diagram[data-mermaid="error"] .mermaid-diagram-error-message');
    check('section 8: a failed mermaid load degrades every diagram to an error box (source kept) instead of throwing',
      !threw && r && r.failed === 2 && boxes.length === 2 && Array.from(boxes).every((b) => b.textContent.includes('Failed to fetch')), threw ? String(threw) : JSON.stringify(r));
  }

  // =====================================================================
  // Section 9: source-level wiring guards
  // =====================================================================
  {
    const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
    const util = read('src/utils/mermaidDiagrams.js');
    const editor = read('src/components/features/documents/DocumentEditor.jsx');
    const exporter = read('src/hooks/useImportExport.js');
    const css = read('src/index.css');
    const md = read('src/utils/interactiveMarkdown.js');

    check('section 9: mermaidDiagrams.js reaches mermaid only through a dynamic import()',
      /import\(\s*['"]mermaid['"]\s*\)/.test(util) && !/^\s*import\s[^;]*from\s+['"]mermaid['"]/m.test(util));
    const walk = (dir, out = []) => {
      for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel, out);
        else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(rel);
      }
      return out;
    };
    const staticImporters = walk('src').filter((f) => /^\s*import\s[^;]*from\s+['"]mermaid['"]/m.test(read(f)));
    check('section 9: no file under src/ statically imports mermaid (it must stay a lazy chunk)', staticImporters.length === 0, staticImporters.join(', '));
    check('section 9: mermaid runs with securityLevel strict and SVG-text labels, output passes DOMPurify\'s SVG profile',
      /securityLevel:\s*'strict'/.test(util) && /htmlLabels:\s*false/.test(util) && /USE_PROFILES:\s*\{\s*svg:\s*true/.test(util));
    check('section 9: interactiveMarkdown.js routes only the "mermaid" language and escapes the source',
      /lang === 'mermaid'/.test(md) && /escapeHtml\(token\.text\)/.test(md));
    check('section 9: DocumentEditor renders diagrams with an AbortSignal, re-runs on preview HTML and theme changes',
      /renderMermaidDiagrams\(container,\s*\{\s*theme:\s*mermaidTheme,\s*signal:\s*controller\.signal\s*\}\)/.test(editor)
        && /\},\s*\[isPreviewActive,\s*previewHtml,\s*mermaidTheme\]\)/.test(editor) && /controller\.abort\(\)/.test(editor));
    check('section 9: DocumentEditor watches the <html> class for theme changes',
      /attributeFilter:\s*\['class'\]/.test(editor) && /setMermaidTheme\(mermaidThemeForApp\(\)\)/.test(editor));
    // The PDF export (Electron printToPDF): the renderer side renders the
    // diagrams in the light theme and awaits them before handing the DOM to
    // the main process, keeps them as inline SVG (never rasterized), and the
    // print stylesheet keeps .mermaid-diagram unbreakable across pages.
    const native = read('src/utils/pdfExportNative.js');
    const printMain = read('electron/pdf-export.cjs');
    const renderIdx = native.indexOf('await renderMermaidDiagrams(container');
    const handOverIdx = native.indexOf('window.electronAPI.exportPdf(payload)');
    check('section 9: PDF export awaits the diagrams (light theme) before handing the document to the print engine',
      renderIdx > 0 && handOverIdx > renderIdx && /theme:\s*'default'/.test(native.slice(renderIdx, renderIdx + 200)));
    check('section 9: PDF export keeps the rendered SVGs inline (no rasterization step anywhere)',
      !/rasterizeMermaidDiagrams|html2canvas/.test(native) && !/rasterizeMermaidDiagrams/.test(exporter) && !/rasterizeMermaidDiagrams/.test(util));
    check('section 9: the print stylesheet treats .mermaid-diagram as an atomic block (never split across pages)',
      /\.pdf-export-root \.mermaid-diagram[^{]*\{[^}]*break-inside:\s*avoid/.test(printMain.replace(/\n\s*/g, ' ')));
    check('section 9: index.css hides the source only once rendered and keeps the block unbreakable',
      /\.mermaid-diagram\[data-mermaid="rendered"\]\s*>\s*pre\s*\{\s*display:\s*none/.test(css) && /\.mermaid-diagram\s*\{[^}]*break-inside:\s*avoid/.test(css));
    check('section 9: index.css styles the error box for light and dark themes',
      /\.markdown-preview \.mermaid-diagram-error\s*\{/.test(css) && /\.dark \.markdown-preview \.mermaid-diagram-error\s*\{/.test(css));
    const pkg = JSON.parse(read('package.json'));
    check('section 9: mermaid is a bundled (npm) dependency; the renderer references no remote URL or script tag',
      // (the W3C namespace names used when serializing an exported SVG are identifiers, not fetches)
      typeof pkg.dependencies.mermaid === 'string' && !/https?:\/\/(?!www\.w3\.org\/)/i.test(util) && !/<script/i.test(util));
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.log('FAIL: unexpected error |', err && err.stack ? err.stack : err);
  exitCode = 1;
} finally {
  try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(exitCode);
