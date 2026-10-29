/**
 * The PDF export's fonts (src/utils/pdfExportNative.js collectExportStyles,
 * src/utils/bundledFonts.js), with plain Node and esbuild - no browser:
 *
 *   THE BUG: the export used to re-fetch every @font-face source by the
 *   string the stylesheet wrote, and fetch() resolves a relative string
 *   against the DOCUMENT. The built stylesheet lives in dist/assets/ and says
 *   url(./red-hat-text-...woff2) while the document is dist/index.html, so in
 *   the packaged app every font fetch missed, every @font-face was dropped,
 *   and the PDF printed in the OS fallback: Helvetica on macOS (heavier than
 *   Red Hat Text - "the text looks bold"), Liberation / DejaVu on Linux. In
 *   dev the sources are absolute, which is why the dev export was fine.
 *
 *   - resolveFontSourceUrl resolves a relative source against the
 *     stylesheet's href, leaves absolute and data: sources alone, falls
 *     back to the document's base when the sheet has no href;
 *   - inlineFontFace fetches the RESOLVED url (recorded by a fetch stub),
 *     never the string as written, and returns the rule with a data: src;
 *   - collectExportStylesWithFonts keeps the app's rules, replaces the
 *     bundled families' @font-face rules with the build-time data: URLs of
 *     bundledFonts.js (nothing fetched for them), inlines any other family's
 *     face through the resolver, drops one that cannot be read, leaves no
 *     url(./...) behind, and reports what it embedded for the export log;
 *   - the bundled set is the eleven faces (Red Hat Text 400/500/600/700 and
 *     italic 400/700, Red Hat Mono 400/500, Sora 400/500/600), each a
 *     real woff2, and exactly what src/main.jsx loads for the app;
 *   - the main process lays the export page out and loads every face
 *     before waiting for document.fonts.ready and printing; the export
 *     hands Mermaid the reading font; the preview's code uses the bundled
 *     code font (so the PDF's code is not the OS's monospace).
 *
 * Run: node tests/pdf-export-fonts.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(REPO, 'package.json'));
const esbuild = require('esbuild');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

// Vite's `?inline` yields a base64 data: URL with the file's MIME type (the same plugin tests/diagnostics-frame-fonts.test.mjs uses).
const inlinePlugin = {
  name: 'vite-inline-query',
  setup(build) {
    build.onResolve({ filter: /\?inline$/ }, (args) => ({ path: require.resolve(args.path.replace(/\?inline$/, '')), namespace: 'inline' }));
    build.onLoad({ filter: /.*/, namespace: 'inline' }, (args) => {
      const mime = args.path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
      return { contents: `export default ${JSON.stringify(`data:${mime};base64,${fs.readFileSync(args.path).toString('base64')}`)};`, loader: 'js' };
    });
  },
};
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-export-fonts-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `export { resolveFontSourceUrl, inlineFontFace, collectExportStylesWithFonts, collectExportStyles } from ${JSON.stringify(path.join(REPO, 'src/utils/pdfExportNative.js'))};\nexport * as bundled from ${JSON.stringify(path.join(REPO, 'src/utils/bundledFonts.js'))};\n`);
const BUNDLE = path.join(WORK, 'bundle.cjs');
await esbuild.build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' }, resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], logLevel: 'warning',
  plugins: [inlinePlugin, { name: 'resolve', setup(b) { b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => { if (isBuiltin(args.path)) return { path: args.path, external: true }; try { return { path: require.resolve(args.path) }; } catch { return null; } }); } }],
});
// what the inliner needs from a browser: fetch (stubbed, recording), FileReader (a shim over Blob)
const fetched = [];
let failUrl = null;
globalThis.fetch = async (url) => { fetched.push(String(url)); if (failUrl && String(url).includes(failUrl)) return { ok: false, status: 404 }; return { ok: true, status: 200, blob: async () => new Blob([Buffer.from('wOF2' + url)], { type: 'font/woff2' }) }; };
globalThis.FileReader = class { readAsDataURL(blob) { blob.arrayBuffer().then((buf) => { this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`; this.onload && this.onload(); }).catch((e) => { this.error = e; this.onerror && this.onerror(); }); } };
const mod = require(BUNDLE);
fs.rmSync(WORK, { recursive: true, force: true });
const { resolveFontSourceUrl, inlineFontFace, collectExportStylesWithFonts, bundled } = mod;

// ---- the resolver ----
const SHEET = 'file:///Applications/Example.app/Contents/Resources/app.asar/dist/assets/index-abc123.css';
const DOC = 'file:///Applications/Example.app/Contents/Resources/app.asar/dist/index.html';
check('a relative source resolves against the stylesheet, not the document', resolveFontSourceUrl('./red-hat-text-latin-400-normal-CU14VBGs.woff2', SHEET, DOC) === 'file:///Applications/Example.app/Contents/Resources/app.asar/dist/assets/red-hat-text-latin-400-normal-CU14VBGs.woff2', resolveFontSourceUrl('./x.woff2', SHEET, DOC));
check('a parent-relative source resolves against the stylesheet (../webfonts/...)', resolveFontSourceUrl('../webfonts/fa-solid-900.woff2', 'http://localhost:5173/vendor/fontawesome/css/all.min.css', 'http://localhost:5173/') === 'http://localhost:5173/vendor/fontawesome/webfonts/fa-solid-900.woff2');
check('an absolute source is left as it is', resolveFontSourceUrl('http://localhost:5173/node_modules/@fontsource/sora/files/sora-latin-400-normal.woff2', null, DOC) === 'http://localhost:5173/node_modules/@fontsource/sora/files/sora-latin-400-normal.woff2');
check('a data: source is left as it is', resolveFontSourceUrl('data:font/woff2;base64,AAAA', SHEET, DOC) === 'data:font/woff2;base64,AAAA');
check('without a stylesheet href (a <style> element) the document base applies', resolveFontSourceUrl('./x.woff2', null, 'http://localhost:5173/app/') === 'http://localhost:5173/app/x.woff2');
check('an unresolvable source is returned unchanged rather than thrown', resolveFontSourceUrl('./x.woff2', null, undefined) === './x.woff2');

// ---- a fake CSSOM: rules with style.getPropertyValue and a parentStyleSheet ----
const rule = (family, src, href, extra = {}) => ({ type: 5, cssText: `@font-face { font-family: ${family}; src: ${src}; }`, parentStyleSheet: { href }, style: { getPropertyValue: (n) => ({ 'font-family': family, 'font-style': 'normal', 'font-weight': '400', 'font-display': 'swap', src, ...extra })[n] || '' } });
const plain = (cssText) => ({ type: 1, cssText, style: null });
const doc = (sheets, baseURI = DOC) => ({ baseURI, styleSheets: sheets.map((cssRules) => ({ cssRules })) });

// ---- inlineFontFace fetches the resolved url ----
fetched.length = 0;
const other = await inlineFontFace(rule('"Other Font"', 'url(./other-400.woff2) format("woff2")', SHEET), DOC);
check('inlineFontFace asked fetch for the url resolved against the stylesheet, never the string as written', fetched.length === 1 && fetched[0] === 'file:///Applications/Example.app/Contents/Resources/app.asar/dist/assets/other-400.woff2', fetched.join(', '));
check('...and returned the rule with a data: src and its descriptors', /^@font-face \{ font-family: "Other Font"; font-style: normal; font-weight: 400; font-display: swap;\s+src: url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\) format\("woff2"\); \}$/.test(other), other.slice(0, 160));

// ---- collectExportStylesWithFonts ----
fetched.length = 0;
const d = doc([
  [plain('.markdown-preview { font-family: "Red Hat Text", Roboto, sans-serif; }'), rule('"Red Hat Text"', 'url(./red-hat-text-latin-400-normal-CU14VBGs.woff2) format("woff2")', SHEET, { 'unicode-range': 'U+0000-00FF' }), rule('Sora', 'url(./sora-latin-600-normal-abc.woff2) format("woff2")', SHEET)],
  [rule('"Other Font"', 'url(./other-400.woff2) format("woff2")', 'http://localhost:5173/vendor/other/css/other.css'), plain('.other-rule { color: red; }')],
]);
const out = await collectExportStylesWithFonts(d);
check('the app rules are kept', out.css.includes('.markdown-preview { font-family: "Red Hat Text", Roboto, sans-serif; }') && out.css.includes('.other-rule { color: red; }'));
check('the bundled families\' @font-face rules are not fetched (their data: URLs come from the build)', !fetched.some((u) => /red-hat-text|sora/.test(u)), fetched.join(', '));
check('the other family\'s face is fetched at the resolved url and inlined', fetched.length === 1 && fetched[0] === 'http://localhost:5173/vendor/other/css/other-400.woff2' && /font-family: "Other Font";[^}]*src: url\(data:font\/woff2;base64,/.test(out.css), fetched.join(', '));
check('every bundled face is in the output as a data: URL', bundled.BUNDLED_FONTS.every((f) => out.css.includes(`font-family: '${f.family}'; font-style: ${f.style}; font-weight: ${f.weight}; font-display: swap; src: url(data:font/woff2;base64,`)));
const leftover = Array.from(out.css.matchAll(/url\(\s*["']?([^"')]+)/g)).map((m) => m[1]).filter((u) => !u.startsWith('data:'));
check('no url() other than data: remains - nothing for the export window to fetch', leftover.length === 0, leftover.join(', '));
check('the report names the bundled set and counts the rest', out.fonts.bundledFacesReplaced === 2 && out.fonts.otherInlined === 1 && out.fonts.otherDropped === 0 && /Red Hat Text 400\/500\/600\/700 \+ italic 400\/700/.test(out.fonts.bundled) && /Red Hat Mono 400\/500/.test(out.fonts.bundled) && /Sora 400\/500\/600/.test(out.fonts.bundled), JSON.stringify(out.fonts));
failUrl = 'missing-400';
fetched.length = 0;
const d2 = doc([[rule('"Red Hat Text"', 'url(./red-hat-text-latin-400-normal-CU14VBGs.woff2) format("woff2")', SHEET), rule('Sora', 'url(./sora-latin-600-normal-abc.woff2) format("woff2")', SHEET)], [rule('"Other Font"', 'url(./missing-400.woff2) format("woff2")', 'http://localhost:5173/vendor/other/css/other.css')]]);
const out2 = await collectExportStylesWithFonts(d2);
check('a face that cannot be read is dropped and counted (the fallback applies to it alone)', out2.fonts.otherDropped === 1 && out2.fonts.otherInlined === 0 && !/Other Font/.test(out2.css) && out2.css.includes("font-family: 'Red Hat Text'"), JSON.stringify(out2.fonts));
failUrl = null;
check('collectExportStyles returns the same css', (await mod.collectExportStyles(d)) === out.css);

// ---- the bundled set ----
const faces = bundled.BUNDLED_FONTS;
const want = [['Sora', 400, 'normal'], ['Sora', 500, 'normal'], ['Sora', 600, 'normal'], ['Red Hat Text', 400, 'normal'], ['Red Hat Text', 500, 'normal'], ['Red Hat Text', 600, 'normal'], ['Red Hat Text', 700, 'normal'], ['Red Hat Text', 400, 'italic'], ['Red Hat Text', 700, 'italic'], ['Red Hat Mono', 400, 'normal'], ['Red Hat Mono', 500, 'normal']];
check('the bundled set is the eleven faces', faces.length === want.length && want.every(([family, weight, style]) => faces.some((f) => f.family === family && f.weight === weight && f.style === style)), faces.map((f) => `${f.family} ${f.weight} ${f.style}`).join(', '));
check('every face is a real woff2 (wOF2 magic, > 1 KB) as a data: URL', faces.every((f) => f.data.startsWith('data:font/woff2;base64,') && Buffer.from(f.data.slice('data:font/woff2;base64,'.length), 'base64').subarray(0, 4).toString('latin1') === 'wOF2' && f.data.length > 1400));
check('isBundledFamily recognises the three families, quoted or not', bundled.isBundledFamily('"Red Hat Text"') && bundled.isBundledFamily("'Sora'") && bundled.isBundledFamily('Red Hat Mono') && !bundled.isBundledFamily('"Other Font"') && !bundled.isBundledFamily(''));
const mainJsx = fs.readFileSync(path.join(REPO, 'src', 'main.jsx'), 'utf8');
const mainFaces = Array.from(mainJsx.matchAll(/@fontsource\/([a-z-]+)\/(\d{3})(-italic)?\.css/g)).map((m) => `${m[1]}/${m[2]}/${m[3] ? 'italic' : 'normal'}`).sort();
const byPackage = { 'Sora': 'sora', 'Red Hat Text': 'red-hat-text', 'Red Hat Mono': 'red-hat-mono' };
const bundledKeys = faces.map((f) => `${byPackage[f.family]}/${f.weight}/${f.style}`).sort();
check('the bundled set is exactly what src/main.jsx loads for the app (700 and the italics included)', JSON.stringify(mainFaces) === JSON.stringify(bundledKeys), `${mainFaces} vs ${bundledKeys}`);

// ---- the rest of the fix, statically ----
const main = fs.readFileSync(path.join(REPO, 'electron', 'pdf-export.cjs'), 'utf8');
const loadFn = main.slice(main.indexOf('const load = async (file) => {'), main.indexOf('// 1. Bands'));
check('the main process lays the export page out, loads every declared face and waits for fonts.ready (and the images) before any print', /document\.body\.offsetHeight/.test(loadFn) && /faces\.map\(\(f\) => f\.load\(\)/.test(loadFn) && /document\.fonts\.ready/.test(loadFn) && /img\.decode\(\)/.test(loadFn) && main.indexOf('const load = async') < main.indexOf('printToPDF('));
check('...and logs how many faces loaded', /font face\(s\) loaded/.test(loadFn));
const native = fs.readFileSync(path.join(REPO, 'src', 'utils', 'pdfExportNative.js'), 'utf8');
check('the export hands Mermaid the reading font (embedded), not its Trebuchet MS default', /renderMermaidDiagrams\(container, \{ theme: 'default', fontFamily: '"Red Hat Text"/.test(native));
check('the export log names the embedded fonts', /Fonts embedded from the app's bundle/.test(native));
const css = fs.readFileSync(path.join(REPO, 'src', 'index.css'), 'utf8');
const previewCode = css.slice(css.indexOf('.markdown-preview code {'), css.indexOf('}', css.indexOf('.markdown-preview code {'))).replace(/\/\*[^]*?\*\//g, '');
check('the preview\'s code uses the bundled code font (--font-mono), so the PDF\'s code is the same on every OS', /font-family: var\(--font-mono\)/.test(previewCode) && !/Menlo|ui-monospace/.test(previewCode));
check('no markdown-preview rule names the OS monospace stack any more', !/\.markdown-preview[^{]*\{[^}]*ui-monospace/.test(css.replace(/\/\*[^]*?\*\//g, '').replace(/\n/g, ' ')));
const frame = fs.readFileSync(path.join(REPO, 'src', 'components', 'features', 'diagnostics', 'diagnosticsFrameStyles.js'), 'utf8');
check('the diagnostics frame shares the same bundled set', /from '\.\.\/\.\.\/\.\.\/utils\/bundledFonts'/.test(frame) && /DIAGNOSTICS_FRAME_FONT_CSS = BUNDLED_FONT_CSS/.test(frame));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
