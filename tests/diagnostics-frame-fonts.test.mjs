/**
 * Guards the web font loading (Sora, Red Hat Text, Red Hat Mono) inside the sandboxed diagnostics iframe
 * (src/components/features/diagnostics/diagnosticsFrameStyles.js, used by
 * DiagnosticsPage.jsx's buildDiagnosticsSrcDoc).
 *
 * THE BUG: DevTools showed every red-hat-* font request as "blocked:other"
 * with initiator about:srcdoc, and the Diagnostics tabs rendered in the
 * fallback fonts. The srcdoc frame (sandbox="allow-scripts", opaque origin)
 * inlines the parent's stylesheets by serializing document.styleSheets, and
 * the @fontsource @font-face rules came along with their url() sources -
 * file://.../dist/assets/red-hat-*.woff2 in the packaged app. Chromium
 * refuses file:// subresource loads for an opaque origin, hence
 * blocked:other. The fonts were already bundled; only the reference was
 * unusable from inside the frame.
 *
 * THE FIX: the parent's @font-face rules are dropped from the serialization
 * and replaced by @font-face rules whose src is a data: URL, produced at
 * build time by Vite `?inline` imports of the same @fontsource woff2 files
 * src/main.jsx loads. No request of any kind leaves the frame for fonts.
 *
 * What this test proves (real module bundled with esbuild, `?inline`
 * resolved to a base64 data: URL exactly as Vite does, run under jsdom):
 *   - serializeParentStyles keeps ordinary rules and drops @font-face rules,
 *     including one whose src is a file:// URL;
 *   - the emitted font CSS has one @font-face per family/weight main.jsx
 *     loads (Display 400-700, Text 400-600, Mono 400-500), every src is a
 *     data:font/woff2 URL and decodes to a real woff2 file (wOF2 magic);
 *   - buildDiagnosticsFrameStyles output contains no url() other than
 *     data: - nothing for the frame to fetch;
 *   - DiagnosticsPage.jsx uses buildDiagnosticsFrameStyles for the srcdoc
 *     <style> and no longer serializes document.styleSheets itself.
 *
 * Needs jsdom (not in package.json - see run-all.sh):
 *   npm install --no-save jsdom
 *
 *   node tests/diagnostics-frame-fonts.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const require = createRequire(path.join(REPO, 'package.json'));

function requireResolvable(name, hint) {
  try {
    require.resolve(name);
  } catch {
    console.error(`Missing dependency "${name}". ${hint}`);
    process.exit(1);
  }
}
requireResolvable('esbuild', 'Run: npm install');
requireResolvable('jsdom', 'Run: npm install --no-save jsdom');

const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

// Vite's `?inline` yields a base64 data: URL with the file's MIME type.
const inlinePlugin = {
  name: 'vite-inline-query',
  setup(build) {
    build.onResolve({ filter: /\?inline$/ }, (args) => ({
      path: require.resolve(args.path.replace(/\?inline$/, '')),
      namespace: 'inline'
    }));
    build.onLoad({ filter: /.*/, namespace: 'inline' }, (args) => {
      const mime = args.path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
      const data = fs.readFileSync(args.path).toString('base64');
      return { contents: `export default ${JSON.stringify(`data:${mime};base64,${data}`)};`, loader: 'js' };
    });
  }
};

const MODULE = path.join(REPO, 'src', 'components', 'features', 'diagnostics', 'diagnosticsFrameStyles.js');
const result = await esbuild.build({
  entryPoints: [MODULE],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [inlinePlugin],
  logLevel: 'silent'
});
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-frame-fonts-'));
const bundlePath = path.join(scratch, 'diagnosticsFrameStyles.mjs');
fs.writeFileSync(bundlePath, result.outputFiles[0].text);
const mod = await import(pathToFileURL(bundlePath).href);
fs.rmSync(scratch, { recursive: true, force: true });

console.log('\n--- serializeParentStyles ---');
const dom = new JSDOM(`<!doctype html><html><head>
<style>
@font-face { font-family: "Red Hat Text"; font-style: normal; font-weight: 400; src: url(file:///Applications/Example.app/dist/assets/red-hat-text-latin-400-normal-abc123.woff2) format("woff2"); }
.example-rule { color: rgb(1, 2, 3); }
</style>
<style id="diagnostics-styles">.dark #diagnostics-content .other-rule { margin: 0px; }</style>
</head><body></body></html>`);
const doc = dom.window.document;
check('fixture: jsdom parsed the @font-face rule', Array.from(doc.styleSheets[0].cssRules).some((r) => mod.isFontFaceRule(r)));
const serialized = mod.serializeParentStyles(doc);
check('ordinary rule kept', serialized.includes('.example-rule'));
check('rule from a second <style> kept', serialized.includes('.other-rule'));
check('@font-face rule dropped', !/@font-face/i.test(serialized));
check('file:// font URL gone', !serialized.includes('file://'));
check('isFontFaceRule: null/other rules are false', !mod.isFontFaceRule(null) && !mod.isFontFaceRule({ type: 1, cssText: '.a { }' }));
check('isFontFaceRule: recognizes by cssText when type is missing', mod.isFontFaceRule({ cssText: '@font-face { }' }));

console.log('\n--- inlined font faces ---');
const fontCss = mod.DIAGNOSTICS_FRAME_FONT_CSS;
const faces = fontCss.match(/@font-face\s*\{[^}]*\}/g) || [];
const expected = [
  ['Sora', 400, 'normal'], ['Sora', 500, 'normal'], ['Sora', 600, 'normal'],
  ['Red Hat Text', 400, 'normal'], ['Red Hat Text', 500, 'normal'], ['Red Hat Text', 600, 'normal'], ['Red Hat Text', 700, 'normal'],
  ['Red Hat Text', 400, 'italic'], ['Red Hat Text', 700, 'italic'],
  ['Red Hat Mono', 400, 'normal'], ['Red Hat Mono', 500, 'normal']
];
check(`one @font-face per family/weight/style main.jsx loads (${expected.length})`, faces.length === expected.length, `${faces.length}`);
for (const [family, weight, style] of expected) {
  const face = faces.find((f) => f.includes(`font-family: '${family}'`) && f.includes(`font-weight: ${weight}`) && f.includes(`font-style: ${style}`));
  check(`${family} ${weight} ${style}: present`, Boolean(face));
  if (!face) continue;
  const src = face.match(/src:\s*url\(([^)]+)\)\s*format\('woff2'\)/);
  check(`${family} ${weight} ${style}: src is a data:font/woff2 URL`, Boolean(src) && src[1].startsWith('data:font/woff2;base64,'));
  if (src) {
    const bytes = Buffer.from(src[1].slice('data:font/woff2;base64,'.length), 'base64');
    check(`${family} ${weight} ${style}: payload is a woff2 file (wOF2 magic, >1 KB)`, bytes.subarray(0, 4).toString('latin1') === 'wOF2' && bytes.length > 1024, `${bytes.length} bytes`);
  }
}
// Matches src/main.jsx so the frame never lags behind the app's font set.
const mainJsx = fs.readFileSync(path.join(REPO, 'src', 'main.jsx'), 'utf8');
const mainFaces = Array.from(mainJsx.matchAll(/@fontsource\/([a-z-]+)\/(\d{3})\.css/g)).map((m) => `${m[1]}/${m[2]}`).sort();
const moduleSrc = fs.readFileSync(path.join(REPO, 'src', 'utils', 'bundledFonts.js'), 'utf8');   // the shared set the frame and the PDF export use
const moduleFaces = Array.from(moduleSrc.matchAll(/@fontsource\/([a-z-]+)\/files\/[a-z-]+-latin-(\d{3})-normal\.woff2\?inline/g)).map((m) => `${m[1]}/${m[2]}`).sort();
check('src/utils/bundledFonts.js inlines exactly the family/weight set main.jsx imports', JSON.stringify(mainFaces) === JSON.stringify(moduleFaces), `${mainFaces} vs ${moduleFaces}`);
check('the frame module takes its font faces from that shared set', /import \{ BUNDLED_FONT_CSS \} from '\.\.\/\.\.\/\.\.\/utils\/bundledFonts'/.test(fs.readFileSync(MODULE, 'utf8')) && /DIAGNOSTICS_FRAME_FONT_CSS = BUNDLED_FONT_CSS/.test(fs.readFileSync(MODULE, 'utf8')));

console.log('\n--- buildDiagnosticsFrameStyles ---');
const styles = mod.buildDiagnosticsFrameStyles(doc);
check('contains the app rules', styles.includes('.example-rule') && styles.includes('.other-rule'));
check('contains the inlined font faces', styles.includes(fontCss));
const nonDataUrls = Array.from(styles.matchAll(/url\(\s*["']?([^"')]+)/g)).map((m) => m[1]).filter((u) => !u.startsWith('data:'));
check('no url() other than data: - nothing for the frame to fetch', nonDataUrls.length === 0, nonDataUrls.slice(0, 3).join(', '));
check('output is safe to embed in a <style> tag', !styles.includes('</style'));

console.log('\n--- DiagnosticsPage wiring ---');
const diag = fs.readFileSync(path.join(REPO, 'src', 'components', 'DiagnosticsPage.jsx'), 'utf8');
check('DiagnosticsPage imports buildDiagnosticsFrameStyles', /import \{ buildDiagnosticsFrameStyles \} from '\.\/features\/diagnostics\/diagnosticsFrameStyles'/.test(diag));
check('srcdoc <style> is fed by buildDiagnosticsFrameStyles(document)', /const appStyles = buildDiagnosticsFrameStyles\(document\);/.test(diag) && /<style>\$\{appStyles\}<\/style>/.test(diag));
check('DiagnosticsPage no longer serializes document.styleSheets itself', !/document\.styleSheets/.test(diag.replace(/\/\/[^\n]*/g, '')));

console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
