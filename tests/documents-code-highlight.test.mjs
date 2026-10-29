/**
 * Guards syntax highlighting of fenced code blocks in the Documents
 * preview / PDF export (src/utils/codeHighlight.js, wired into
 * src/utils/interactiveMarkdown.js renderer.code; token colours in
 * src/index.css as --os-code-* variables applied to the .hljs-* classes).
 *
 * THE FEATURE: a ```python / ```go / ```bash / ```yaml / ```json fence in a
 * document renders with syntax-highlight tokens (<span class="hljs-*">)
 * inside the usual <pre><code class="language-X"> block. Requirements this
 * file pins down:
 *   - routing: exactly those five languages (plus the documented aliases
 *     py/python3, golang, sh/shell/zsh, yml) are highlighted; a bare ```
 *     fence and every other language tag (rust, js, mermaidjs, ...) render
 *     as plain escaped text with NO highlight markup, byte-for-byte what
 *     marked emits on its own; ```mermaid still becomes the diagram
 *     placeholder;
 *   - no auto-detection: highlight.js is loaded from lib/core with the five
 *     grammars registered by name, highlightAuto is never called, and a
 *     fence whose tag is unknown is never guessed at even when its content
 *     is obviously one of the five languages;
 *   - security: HTML/script inside a highlighted block stays escaped text
 *     (no elements created, textContent equals the source), for every one
 *     of the five languages; the only elements inside the block are hljs
 *     spans; the DOMPurify pass keeps those spans;
 *   - fidelity: the highlighted block's textContent equals the source
 *     (highlighting never alters the code), inline code and the rest of
 *     the pipeline (headings, extractDocumentHeadings) are untouched;
 *   - stability: highlighting the same block twice returns identical HTML
 *     (memoized), the renderer is synchronous;
 *   - theming: index.css defines every --os-code-* token on :root AND
 *     .dark, every token colour is >= 4.5:1 (WCAG AA) against the code
 *     block background of its theme (#f6f8fa light, #161b22 dark), the
 *     .hljs-* colour rules read those variables (no fixed-theme
 *     stylesheet), and the dark-mode "strip inline colours in code"
 *     override excludes the hljs spans;
 *   - bundle: the only highlight.js imports in src/ are lib/core plus the
 *     five language modules (no `highlight.js` barrel, no highlight.js CSS
 *     theme import).
 *
 * Real rendering (computed colours in both themes, PDF export) is covered
 * by tests/documents-code-highlight-live.test.mjs (headless Chrome).
 *
 * Run:  node tests/documents-code-highlight.test.mjs
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
requireResolvable('highlight.js/lib/core', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
}
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-code-highlight-'));

// ---------- harness entry (bundled with the REAL modules) ----------
// A tiny spy over highlight.js core records whether highlightAuto() is ever
// reached and which languages were registered.
const SPY = path.join(WORKDIR, 'hljs-spy.js');
fs.writeFileSync(SPY, `
import real from ${JSON.stringify(req.resolve('highlight.js/lib/core'))};
export const spy = { autoCalls: 0, registered: [] };
const origAuto = real.highlightAuto.bind(real);
real.highlightAuto = (...args) => { spy.autoCalls++; return origAuto(...args); };
const origRegister = real.registerLanguage.bind(real);
real.registerLanguage = (name, def) => { spy.registered.push(name); return origRegister(name, def); };
export default real;
`);
const ENTRY = path.join(WORKDIR, 'entry.js');
fs.writeFileSync(ENTRY, `
import { processInteractiveMarkdown, extractDocumentHeadings } from '@worktree/src/utils/interactiveMarkdown.js';
import * as codeHighlight from '@worktree/src/utils/codeHighlight.js';
import hljs, { spy } from 'highlight.js/lib/core';
window.__harness = { processInteractiveMarkdown, extractDocumentHeadings, ...codeHighlight, hljs, spy };
`);

const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY],
  bundle: true,
  outfile: BUNDLE,
  format: 'cjs',
  platform: 'node',
  loader: { '.woff2': 'dataurl', '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'],
  nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{
    name: 'alias',
    setup(b) {
      b.onResolve({ filter: /^highlight\.js\/lib\/core$/ }, () => ({ path: SPY }));
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
const tokenClasses = (code) => Array.from(code.querySelectorAll('[class]')).map((el) => el.className);
const hasToken = (code, ...names) => names.some((n) => !!code.querySelector(`.hljs-${n}`));

// Synthetic samples, one per language, each carrying a comment, a string,
// a keyword-ish construct and a number so several token kinds show up.
const SAMPLES = {
  python: 'import os\n\ndef greet(name: str) -> str:\n    # say hello\n    count = 42\n    return f"hello {name}" * count',
  go: 'package main\n\nimport "fmt"\n\n// entry point\nfunc main() {\n\tvar n int = 7\n\tfmt.Println("hello", n)\n}',
  bash: '#!/usr/bin/env bash\n# list things\nfor f in *.txt; do\n  echo "file: $f" >&2\ndone\nexit 0',
  yaml: '# service definition\napiVersion: v1\nkind: Service\nmetadata:\n  name: demo\n  replicas: 3\n  enabled: true\n  tags:\n    - web\n    - "edge"',
  json: '{\n  "name": "demo",\n  "replicas": 3,\n  "enabled": true,\n  "tags": ["web", null]\n}',
};
// Token kinds that MUST appear for each sample (any of the listed names).
const EXPECTED_TOKENS = {
  python: [['keyword'], ['string'], ['number'], ['comment'], ['title', 'title function_']],
  go: [['keyword'], ['string'], ['number'], ['comment'], ['title', 'title function_', 'built_in', 'type']],
  bash: [['keyword'], ['string'], ['comment'], ['built_in', 'variable', 'meta']],
  yaml: [['attr'], ['string'], ['number'], ['comment'], ['literal', 'bullet']],
  json: [['attr'], ['string'], ['number'], ['literal'], ['punctuation']],
};

let exitCode = 1;
try {
  // =====================================================================
  // Section 1: each supported language produces highlight tokens
  // =====================================================================
  for (const [lang, src] of Object.entries(SAMPLES)) {
    const out = parse(H.processInteractiveMarkdown(fence(lang, src)));
    const code = out.querySelector(`pre > code.language-${lang}`);
    check(`section 1: \`\`\`${lang} renders as <pre><code class="hljs language-${lang}">`,
      !!code && code.classList.contains('hljs') && out.querySelectorAll('pre').length === 1 && !code.closest('.mermaid-diagram'),
      code ? code.className : 'no code element');
    if (!code) continue;
    const spans = code.querySelectorAll('span');
    check(`section 1: \`\`\`${lang} block contains hljs token spans and nothing else`,
      spans.length > 0 && Array.from(code.querySelectorAll('*')).every((el) => el.tagName === 'SPAN' && /(^|\s)hljs-/.test(el.className)),
      `spans=${spans.length} classes=${tokenClasses(code).slice(0, 6).join(',')}`);
    for (const names of EXPECTED_TOKENS[lang]) {
      check(`section 1: \`\`\`${lang} has a ${names.join('|')} token`, hasToken(code, ...names.map((n) => n.replace(/ /g, '.'))),
        tokenClasses(code).join(','));
    }
    check(`section 1: \`\`\`${lang} textContent equals the source exactly (+ marked's trailing newline)`,
      code.textContent === src + '\n', JSON.stringify(code.textContent.slice(0, 60)));
  }

  // =====================================================================
  // Section 2: plain fences and unknown languages stay plain text
  // =====================================================================
  {
    const PLAIN_SRC = 'def not_highlighted():\n    return "x"  # looks like python';
    const plainCases = ['', 'rust', 'js', 'javascript', 'text', 'pythonic', 'go-template', 'bash-ish', 'mermaidjs', 'c', 'toml'];
    for (const lang of plainCases) {
      const html = H.processInteractiveMarkdown(fence(lang, PLAIN_SRC));
      const out = parse(html);
      const code = out.querySelector('pre > code');
      const expectedClass = lang ? `language-${lang}` : '';
      check(`section 2: ${lang ? '```' + lang : 'bare ```'} fence is plain escaped text with no highlight markup`,
        !!code && code.className === expectedClass && code.children.length === 0 && !html.includes('hljs') && code.textContent === PLAIN_SRC + '\n',
        code ? `class="${code.className}" children=${code.children.length}` : 'no code element');
    }
    // Byte-for-byte what marked itself emits for an unsupported language.
    const { Marked } = await import(req.resolve('marked'));
    const ours = H.processInteractiveMarkdown(fence('rust', 'fn main() { println!("hi <b>"); }'));
    const theirs = new Marked().parse(fence('rust', 'fn main() { println!("hi <b>"); }'));
    // (compared as DOM: DOMPurify re-serializes text nodes, so `"` comes back
    // unescaped where marked wrote &quot; - same document, different spelling)
    check('section 2: an unsupported language renders exactly as stock marked does', parse(ours).innerHTML === parse(theirs).innerHTML, `ours=${JSON.stringify(ours)} marked=${JSON.stringify(theirs)}`);
    check('section 2: highlightAuto was never called (no auto-detection)', H.spy.autoCalls === 0, `calls=${H.spy.autoCalls}`);
    check('section 2: only the five supported grammars are registered',
      H.spy.registered.slice().sort().join(',') === 'bash,go,json,python,yaml', H.spy.registered.join(','));
    check('section 2: highlightCode() refuses unregistered languages (returns null rather than guessing)',
      H.highlightCode('let x = 1;', 'javascript') === null && H.highlightCode('{"a":1}', 'rust') === null && H.highlightCode('x', '') === null);
  }

  // =====================================================================
  // Section 3: aliases and info-string variants
  // =====================================================================
  {
    const variants = {
      'Python': 'python', 'py': 'python', 'python3': 'python', 'PY': 'python',
      'golang': 'go', 'Go': 'go',
      'sh': 'bash', 'shell': 'bash', 'zsh': 'bash', 'Bash': 'bash',
      'yml': 'yaml', 'YAML': 'yaml',
      'JSON': 'json', 'json title="x"': 'json', 'python {linenos}': 'python',
    };
    for (const [info, canonical] of Object.entries(variants)) {
      check(`section 3: info string ${JSON.stringify(info)} resolves to ${canonical}`, H.resolveHighlightLanguage(info) === canonical, String(H.resolveHighlightLanguage(info)));
      const code = parse(H.processInteractiveMarkdown(fence(info, SAMPLES[canonical]))).querySelector('pre > code');
      check(`section 3: \`\`\`${info} is highlighted as ${canonical}`,
        !!code && code.classList.contains('hljs') && code.classList.contains(`language-${canonical}`) && code.querySelectorAll('span').length > 0);
    }
    for (const info of ['', 'mermaid', 'jsonc', 'json5', 'pyx', 'shellscript', 'yaml-ish', 'go2']) {
      check(`section 3: info string ${JSON.stringify(info)} is NOT a highlight language`, H.resolveHighlightLanguage(info) === null, String(H.resolveHighlightLanguage(info)));
    }
    check('section 3: HIGHLIGHT_LANGUAGES lists exactly the five supported languages',
      Array.isArray(H.HIGHLIGHT_LANGUAGES) && H.HIGHLIGHT_LANGUAGES.slice().sort().join(',') === 'bash,go,json,python,yaml', String(H.HIGHLIGHT_LANGUAGES));
  }

  // =====================================================================
  // Section 4: security - hostile code content stays text
  // =====================================================================
  {
    const HOSTILE = {
      python: 'x = "<script>window.__pwned = 1</script>"\n# <img src=x onerror="window.__pwned = 2">\nprint("</code></pre><b>bold</b>" + \'<a href="javascript:alert(1)">l</a>\')',
      go: 'var s = "<script>window.__pwned = 1</script>" // <img src=x onerror=alert(1)>\nfmt.Println("</code></pre><b>b</b>")',
      bash: 'echo "<script>window.__pwned = 1</script>" # <img src=x onerror=alert(1)>\ncat <<EOF\n</code></pre><b>bold</b>\nEOF',
      yaml: 'name: "<script>window.__pwned = 1</script>"\n# <img src=x onerror=alert(1)>\nhtml: </code></pre><b>bold</b>',
      json: '{"a": "<script>window.__pwned = 1</script>", "b": "<img src=x onerror=alert(1)>", "c": "</code></pre><b>bold</b>"}',
    };
    for (const [lang, src] of Object.entries(HOSTILE)) {
      const html = H.processInteractiveMarkdown(fence(lang, src));
      const out = parse(html);
      const code = out.querySelector('pre > code');
      const forbidden = out.querySelector('script, img, b, a');
      check(`section 4: hostile ${lang} content creates no script/img/b/a elements`, !forbidden && out.querySelectorAll('pre').length === 1, forbidden ? forbidden.outerHTML.slice(0, 80) : '');
      check(`section 4: hostile ${lang} content is preserved verbatim as text`, !!code && code.textContent === src + '\n', code ? JSON.stringify(code.textContent.slice(0, 80)) : 'no code');
      check(`section 4: hostile ${lang} content: every element inside the block is an hljs span`,
        !!code && Array.from(code.querySelectorAll('*')).every((el) => el.tagName === 'SPAN' && /(^|\s)hljs-/.test(el.className)));
      check(`section 4: hostile ${lang} content: raw output opens no script/img/b/a tag and no element carries any attribute but class`,
        !/<(script|img|b|a)\b/i.test(html) && Array.from(out.querySelectorAll('*')).every((el) => Array.from(el.attributes).every((a) => a.name === 'class')));
      check(`section 4: hostile ${lang} content: raw output escapes every angle bracket of the source`,
        (html.match(/&lt;/g) || []).length >= (src.match(/</g) || []).length && (html.match(/&gt;/g) || []).length >= (src.match(/>/g) || []).length);
    }
    // Pre-escaped entities in the source must not be double-decoded into markup.
    const entity = parse(H.processInteractiveMarkdown(fence('json', '{"e": "&lt;script&gt;alert(1)&lt;/script&gt;"}'))).querySelector('pre > code');
    check('section 4: entity text in code stays literal (&lt; is text, not a tag)', !!entity && entity.textContent.includes('&lt;script&gt;') && !entity.querySelector('script'));
    check('section 4: nothing was executed in the harness window', window.__pwned === undefined);
    // DOMPurify keeps the spans (class attribute is allowed).
    check('section 4: the DOMPurify pass keeps the highlight spans',
      parse(H.processInteractiveMarkdown(fence('python', 'import os'))).querySelectorAll('span.hljs-keyword').length === 1);
  }

  // =====================================================================
  // Section 5: mermaid and the rest of the pipeline are untouched
  // =====================================================================
  {
    const MERMAID_SRC = 'graph TD\n  Alpha[Intake] --> Beta[Triage]';
    // ("Overview", not "Title": DOMPurify's DOM-clobbering guard strips
    // id="title" because document.title exists - pre-existing, unrelated)
    const md = ['# Overview', '', fence('mermaid', MERMAID_SRC), '', fence('python', SAMPLES.python), '', fence('', 'plain'), '', 'inline `code` here', '', '## Second', ''].join('\n');
    const out = parse(H.processInteractiveMarkdown(md));
    const placeholders = out.querySelectorAll('.mermaid-diagram[data-mermaid="pending"]');
    const mermaidCode = placeholders[0] && placeholders[0].querySelector('pre > code.language-mermaid');
    check('section 5: ```mermaid still becomes exactly one pending .mermaid-diagram placeholder', placeholders.length === 1);
    check('section 5: the mermaid placeholder keeps the source as plain text with no highlight spans',
      !!mermaidCode && mermaidCode.textContent === MERMAID_SRC && mermaidCode.children.length === 0 && !mermaidCode.classList.contains('hljs'));
    check('section 5: the python block next to it is highlighted', out.querySelectorAll('code.hljs.language-python span').length > 0);
    check('section 5: bare fence next to it is plain', Array.from(out.querySelectorAll('pre > code')).some((c) => !c.className && c.children.length === 0 && c.textContent === 'plain\n'));
    check('section 5: inline code is untouched', out.querySelector('p > code') && out.querySelector('p > code').textContent === 'code' && out.querySelector('p > code').children.length === 0);
    check('section 5: headings still render with ids', out.querySelector('h1#overview') && out.querySelector('h2#second'));
    const heads = H.extractDocumentHeadings(md);
    check('section 5: extractDocumentHeadings ignores "#" comment lines inside highlighted fences (bash/python comments)',
      heads.length === 2 && heads[0].id === 'overview' && heads[1].id === 'second', JSON.stringify(heads));
    // A fence whose content is obviously python but tagged unknown: not guessed.
    const guess = parse(H.processInteractiveMarkdown(fence('unknownlang', SAMPLES.python))).querySelector('pre > code');
    check('section 5: an unknown tag over obvious python content is NOT highlighted (no guessing)', !!guess && guess.children.length === 0 && guess.className === 'language-unknownlang');
  }

  // =====================================================================
  // Section 6: stability / memoization
  // =====================================================================
  {
    const a = H.processInteractiveMarkdown(fence('go', SAMPLES.go));
    const b = H.processInteractiveMarkdown(fence('go', SAMPLES.go));
    check('section 6: rendering the same block twice yields identical HTML', a === b);
    const h1 = H.highlightCode(SAMPLES.yaml, 'yaml');
    const h2 = H.highlightCode(SAMPLES.yaml, 'yaml');
    check('section 6: highlightCode is memoized (same string instance for the same input)', typeof h1 === 'string' && h1 === h2);
    check('section 6: the renderer is synchronous (returns a string, not a promise)', typeof a === 'string');
    check('section 6: highlightCode on empty source returns a string (empty block renders)', typeof H.highlightCode('', 'json') === 'string');
  }

  // =====================================================================
  // Section 7: theming - tokens in index.css, contrast in both themes
  // =====================================================================
  {
    const css = fs.readFileSync(path.join(REPO, 'src/index.css'), 'utf8');
    const block = (selector) => {
      const m = css.match(new RegExp('(^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
      return m ? m[2] : '';
    };
    const vars = (text) => Object.fromEntries(Array.from(text.matchAll(/--os-code-([a-z]+):\s*(#[0-9a-fA-F]{6})/g)).map((m) => [m[1], m[2].toLowerCase()]));
    const light = vars(block(':root'));
    const dark = vars(block('.dark'));
    const NAMES = ['keyword', 'string', 'number', 'comment', 'title', 'attr', 'builtin', 'variable', 'meta'];
    check('section 7: :root defines every --os-code-* token', NAMES.every((n) => light[n]), JSON.stringify(light));
    check('section 7: .dark defines every --os-code-* token', NAMES.every((n) => dark[n]), JSON.stringify(dark));
    check('section 7: the dark palette differs from the light one', NAMES.some((n) => light[n] !== dark[n]));

    const lum = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    // the code block background: a literal in the light theme, the --os-code-bg token in the dark
    // themes (Jacaranda in .dark, the neutral greys under the variant attribute)
    const tokenOf = (text, name) => (text.match(new RegExp(name + ':\\s*(#[0-9a-fA-F]{6})')) || [])[1];
    const resolveBg = (selector, tokenBlock) => { const raw = (block(selector).match(/background-color:\s*([^;]+);/) || [])[1] || ''; const literal = raw.match(/#[0-9a-fA-F]{6}/); if (literal) return literal[0]; const v = raw.match(/var\((--[\w-]+)\)/); return v ? tokenOf(tokenBlock, v[1]) : undefined; };
    const lightBg = resolveBg('.markdown-preview pre', block(':root'));
    const darkBg = resolveBg('.dark .markdown-preview pre', block('.dark'));
    const neutralBg = resolveBg('.dark .markdown-preview pre', block('.dark[data-dark-variant="neutral"]'));
    check('section 7: found the light and dark code block backgrounds in index.css', !!lightBg && !!darkBg && !!neutralBg, `${lightBg} / ${darkBg} / ${neutralBg}`);
    for (const n of NAMES) {
      const cl = light[n] && lightBg ? contrast(light[n], lightBg) : 0;
      const cd = dark[n] && darkBg ? contrast(dark[n], darkBg) : 0;
      const cn = dark[n] && neutralBg ? contrast(dark[n], neutralBg) : 0;
      check(`section 7: --os-code-${n} light ${light[n]} on ${lightBg} >= 4.5:1 (${cl.toFixed(2)})`, cl >= 4.5);
      check(`section 7: --os-code-${n} dark ${dark[n]} on ${darkBg} (Jacaranda) >= 4.5:1 (${cd.toFixed(2)})`, cd >= 4.5);
      check(`section 7: --os-code-${n} dark ${dark[n]} on ${neutralBg} (neutral) >= 4.5:1 (${cn.toFixed(2)})`, cn >= 4.5);
    }
    // The .hljs-* rules read the variables (theme-following), scoped to the preview.
    const hljsRules = Array.from(css.matchAll(/\.markdown-preview \.hljs-[a-z_]+[^{]*\{([^}]*)\}/g));
    check('section 7: index.css has .markdown-preview .hljs-* colour rules', hljsRules.length >= 6, `rules=${hljsRules.length}`);
    check('section 7: every .hljs-* colour comes from a --os-code-* variable (no fixed-theme colours)',
      hljsRules.every((m) => !/color:\s*#|color:\s*rgb/.test(m[1])) && hljsRules.filter((m) => /color:\s*var\(--os-code-/.test(m[1])).length >= 6);
    for (const cls of ['keyword', 'string', 'number', 'comment', 'attr', 'built_in', 'title', 'literal', 'variable', 'meta']) {
      check(`section 7: .hljs-${cls} has a colour rule`, new RegExp('\\.markdown-preview \\.hljs-' + cls + '(?![a-z_])[^{]*\\{[^}]*color:\\s*var\\(--os-code-').test(css));
    }
    check('section 7: the dark-mode "strip colours inside code" override excludes hljs spans',
      /\.dark \.markdown-preview pre code \*:not\(\[class\*="hljs-"\]\)/.test(css) && /\.dark \.markdown-preview pre code span:not\(\[class\*="hljs-"\]\)/.test(css)
        && !/\.dark \.markdown-preview pre code \*\s*[,{]/.test(css) && !/\.dark \.markdown-preview pre code span\s*[,{]/.test(css));
    // the font is the bundled Red Hat Mono (--font-mono) since the PDF export embeds the app's own fonts on every OS
    check('section 7: the code block styling (background, padding, the bundled mono font) is unchanged',
      /\.markdown-preview pre\s*\{[^}]*padding:\s*16px/.test(css) && /\.markdown-preview pre\s*\{[^}]*background-color:\s*#f6f8fa/.test(css) && /\.markdown-preview pre\s*\{[^}]*font-family:\s*var\(--font-mono\)/.test(css) && /--font-mono:\s*"Red Hat Mono"/.test(css));
  }

  // =====================================================================
  // Section 8: bundle hygiene - core + five grammars only, no theme CSS
  // =====================================================================
  {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : (/\.(jsx?|css|mjs)$/.test(e.name) ? [p] : []);
    });
    const files = walk(path.join(REPO, 'src'));
    const imports = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:from\s+|import\s*\(?\s*|@import\s+)['"]([^'"]*highlight\.js[^'"]*)['"]/g)) imports.push([path.relative(REPO, f), m[1]]);
    }
    const allowed = new Set(['highlight.js/lib/core', ...['python', 'go', 'bash', 'yaml', 'json'].map((l) => `highlight.js/lib/languages/${l}`)]);
    check('section 8: src/ imports highlight.js only as lib/core + the five grammars (no barrel, no other languages, no theme stylesheet)',
      imports.length === 6 && imports.every(([, spec]) => allowed.has(spec)) && new Set(imports.map(([, s]) => s)).size === 6, JSON.stringify(imports));
    check('section 8: all highlight.js imports live in src/utils/codeHighlight.js', imports.every(([f]) => f === 'src/utils/codeHighlight.js'));
    const util = fs.readFileSync(path.join(REPO, 'src/utils/codeHighlight.js'), 'utf8');
    check('section 8: codeHighlight.js never calls highlightAuto', !/hljs\.highlightAuto/.test(util));
    check('section 8: codeHighlight.js highlights with an explicit language and ignoreIllegals', /hljs\.highlight\([^)]*\{\s*language[^}]*ignoreIllegals:\s*true/.test(util));
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    check('section 8: highlight.js is a bundled (npm) dependency', typeof pkg.dependencies['highlight.js'] === 'string');
    const renderer = fs.readFileSync(path.join(REPO, 'src/utils/interactiveMarkdown.js'), 'utf8');
    check('section 8: the renderer keeps the DOMPurify pass after marked', /DOMPurify\.sanitize\(html\)/.test(renderer));
    check('section 8: the renderer still routes mermaid first and falls back to marked\'s own code renderer',
      /lang === 'mermaid'/.test(renderer) && /originalCodeRenderer\(token\)/.test(renderer));
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
