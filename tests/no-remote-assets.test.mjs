/**
 * Guards the "no CDN assets" invariant.
 *
 * THE REQUIREMENT: the application works without internet access and makes
 * no outbound connection for its own assets. index.html used to load the Red Hat fonts from
 * Google Fonts and Chart.js from jsdelivr, the diagnostics frames reused that
 * CDN URL, and the Flask templates loaded Chart.js, Tailwind and FontAwesome
 * from CDNs - all unreachable without internet, so fonts fell back and Diagnostics
 * charts did not render.
 *
 * THE FIX: fonts come from the @fontsource packages (src/main.jsx, bundled by
 * Vite), Chart.js is inlined into the diagnostics frames from the chart.js
 * package (src/components/DiagnosticsPage.jsx), and the pages Vite does not
 * build reference /static/vendor/... files that scripts/vendor-assets.mjs
 * copies from node_modules (run from postinstall and every build script).
 *
 * What this test proves:
 *   - no <script src>, stylesheet <link>, @import or url() in index.html,
 *     src/**\/*.css, backend/templates/** or templates/** points at a remote
 *     http(s) host (plain hyperlinks are not assets and are ignored);
 *   - src/main.jsx imports the same families/weights the old Google Fonts
 *     request carried, and each @fontsource file exists;
 *   - DiagnosticsPage inlines chart.js from the package (?raw import) and no
 *     longer falls back to a CDN URL; the inlined source contains no
 *     "</script" that would terminate the inline tag early;
 *   - scripts/vendor-assets.mjs runs and produces every file the templates
 *     reference under backend/static/vendor/;
 *   - the vendor step is hooked into postinstall, the Vite build scripts and
 *     backend/build_backend.sh, and backend/static is packaged by PyInstaller.
 *
 * Run:  node tests/no-remote-assets.test.mjs
 * Preconditions: npm install (devDependencies provide the packages).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

function walk(dir, exts, out = []) {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
      walk(rel, exts, out);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(rel);
    }
  }
  return out;
}

// Asset-loading references only: <script src>, <link href> (stylesheet/font/
// preconnect/preload), CSS @import / url(). Anchors (<a href>) are hyperlinks
// the user may open, not something the app fetches.
const REMOTE_ASSET_PATTERNS = [
  /<script[^>]*\ssrc\s*=\s*["']\s*(https?:)?\/\/[^"']+/gi,
  /<link[^>]*\shref\s*=\s*["']\s*(https?:)?\/\/[^"']+/gi,
  /@import\s+(url\()?\s*["']?\s*(https?:)?\/\/[^"')\s]+/gi,
  /url\(\s*["']?\s*(https?:)?\/\/[^"')\s]+/gi
];

const files = [
  'index.html',
  ...walk('src', ['.css', '.html']),
  ...walk('backend/templates', ['.html']),
  ...walk('backend/static', ['.css', '.html']),
  ...walk('templates', ['.css', '.html']),
  ...walk('public', ['.css', '.html'])
];
let offenders = [];
for (const file of files) {
  const text = read(file);
  for (const pattern of REMOTE_ASSET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      offenders.push(`${file}: ${match[0].slice(0, 100)}`);
    }
  }
}
check(`no remote asset reference in ${files.length} html/css files`, offenders.length === 0, offenders.join(' | '));

// ---------- fonts ----------
const main = read('src/main.jsx');
const EXPECTED_FONTS = [
  ['sora', [400, 500, 600]],
  ['red-hat-text', [400, 500, 600]],
  ['red-hat-mono', [400, 500]]
];
for (const [family, weights] of EXPECTED_FONTS) {
  for (const weight of weights) {
    const spec = `@fontsource/${family}/${weight}.css`;
    const imported = main.includes(`import '${spec}'`);
    const exists = fs.existsSync(path.join(REPO, 'node_modules', spec));
    check(`main.jsx imports ${spec} and it exists`, imported && exists, `${imported ? 'imported' : 'NOT imported'}, ${exists ? 'present' : 'MISSING'}`);
  }
}
check('index.html no longer references Google Fonts', !/fonts\.(googleapis|gstatic)\.com/.test(read('index.html')));

// ---------- Chart.js in the diagnostics frame ----------
const diag = read('src/components/DiagnosticsPage.jsx');
check('DiagnosticsPage inlines chart.js from the package (?raw import)', /from '(\.\.\/)+node_modules\/chart\.js\/dist\/chart\.umd\.js\?raw'/.test(diag) && /<script>\$\{chartUmdSource\}<\/script>/.test(diag));
check('DiagnosticsPage has no CDN fallback', !/cdn\.jsdelivr\.net|cdnjs|unpkg/.test(diag.replace(/\/\/[^\n]*/g, '')));
const chartPkg = path.join(REPO, 'node_modules', 'chart.js', 'package.json');
const chartVersion = fs.existsSync(chartPkg) ? JSON.parse(fs.readFileSync(chartPkg, 'utf8')).version : null;
check('chart.js 4.x installed (templates were written against 4.4)', typeof chartVersion === 'string' && chartVersion.startsWith('4.'), String(chartVersion));
const chartSrc = fs.existsSync(path.join(REPO, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'))
  ? fs.readFileSync(path.join(REPO, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'), 'utf8') : '';
check('inlined chart.umd.js contains no "</script" (would close the inline tag)', chartSrc.length > 0 && !/<\/script/i.test(chartSrc));
check('chart.umd.js defines the global Chart (UMD)', /typeof exports/.test(chartSrc) && /Chart/.test(chartSrc));

// ---------- vendored files for the Flask-served pages ----------
let vendorOk = true;
let vendorOut = '';
try {
  vendorOut = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'vendor-assets.mjs')], { encoding: 'utf8' });
} catch (e) {
  vendorOk = false;
  vendorOut = (e.stdout || '') + (e.stderr || '') + e.message;
}
check('scripts/vendor-assets.mjs runs', vendorOk, vendorOut.trim().slice(0, 160));
const templateText = walk('backend/templates', ['.html']).map(read).join('\n');
const referenced = [...new Set([...templateText.matchAll(/["']\/static\/vendor\/([^"']+)["']/g)].map((m) => m[1]))];
check('templates reference vendored files', referenced.length >= 3, referenced.join(', '));
for (const rel of referenced) {
  check(`vendored file present: ${rel}`, fs.existsSync(path.join(REPO, 'backend', 'static', 'vendor', rel)));
}
check('fontawesome webfonts vendored next to its css', fs.existsSync(path.join(REPO, 'backend', 'static', 'vendor', 'fontawesome', 'webfonts', 'fa-solid-900.woff2')));

// ---------- build wiring ----------
const pkg = JSON.parse(read('package.json'));
check('package.json postinstall runs the vendor step', /vendor-assets\.mjs/.test(pkg.scripts.postinstall || ''));
check('package.json "vendor" script exists', /vendor-assets\.mjs/.test(pkg.scripts.vendor || ''));
for (const script of ['scripts/build-ui.sh', 'backend/build_backend.sh']) {
  check(`${script} runs the vendor step`, /vendor-assets\.mjs|npm run vendor/.test(read(script)));
}
check('PyInstaller spec packages backend/static', /\('static',\s*'static'\)/.test(read('backend/flask-backend.spec')));
check('backend/static/vendor is git-ignored', /^backend\/static\/vendor\/$/m.test(read('.gitignore')));
check('no Tailwind v4 browser build (v3 semantics must be preserved)', !pkg.devDependencies?.['@tailwindcss/browser'] && !pkg.dependencies?.['@tailwindcss/browser'] && !/tailwind-browser/.test(templateText));
check('tailwindcss v4 devDependency compiles the legacy stylesheet (scripts/tailwind.legacy.css, via @tailwindcss/node)', /^\^?4\./.test(pkg.devDependencies?.tailwindcss || '') && /@tailwindcss\/node/.test(read('scripts/vendor-assets.mjs')));
const tailwindCss = fs.existsSync(path.join(REPO, 'backend', 'static', 'vendor', 'tailwind.css'))
  ? fs.readFileSync(path.join(REPO, 'backend', 'static', 'vendor', 'tailwind.css'), 'utf8') : '';
check('compiled tailwind.css has the utilities the templates rely on (bg-black/50 overlays, hidden, rounded-md)',
  /\.bg-black\\\/50\{/.test(tailwindCss) && /\.hidden\{display:none\}/.test(tailwindCss) && /\.rounded-md\{/.test(tailwindCss));
check('compiled tailwind.css restores the v3 defaults the templates were written against (gray-200 borders, gray-400 placeholders, pointer buttons, 3px blue ring, ungated hover:)',
  /::file-selector-button\{border-color:var\(--color-gray-200/.test(tailwindCss) && /textarea::placeholder\{color:var\(--color-gray-400\)\}/.test(tailwindCss)
  && /button:not\(:disabled\),\[role=button\]:not\(:disabled\)\{cursor:pointer\}/.test(tailwindCss) && /#3b82f680|rgb\(59 130 246 ?\/ ?\.5\)/.test(tailwindCss) && !/@media \(hover: ?hover\)/.test(tailwindCss));
check('compiled tailwind.css includes the JS-added safelist classes', /\.bg-red-500\{/.test(tailwindCss) && /\.hover\\:bg-red-600:hover\{/.test(tailwindCss));
check('templates link the compiled stylesheet, not a runtime compiler', /\/static\/vendor\/tailwind\.css/.test(templateText));
check('vendor step: build scripts run it with --strict, postinstall without', ['scripts/build-ui.sh', 'backend/build_backend.sh'].every((f) => /vendor-assets\.mjs --strict/.test(read(f))) && !/--strict/.test(pkg.scripts.postinstall));
for (const dep of ['chart.js', '@fontsource/sora', '@fontsource/red-hat-text', '@fontsource/red-hat-mono', 'tailwindcss', '@fortawesome/fontawesome-free']) {
  check(`${dep} is a devDependency (bundled/vendored at build, not shipped as node_modules)`, Boolean(pkg.devDependencies?.[dep]) && !pkg.dependencies?.[dep]);
}

// postinstall mode (no --strict) must not fail a production-only install:
// run a copy of the script from a temp checkout whose node_modules is empty.
{
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-assets-nostrict-'));
  fs.mkdirSync(path.join(tmp, 'scripts'));
  fs.mkdirSync(path.join(tmp, 'node_modules'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'vendor-assets.mjs'), path.join(tmp, 'scripts', 'vendor-assets.mjs'));
  const { spawnSync } = await import('node:child_process');
  const runMode = (args) => {
    const r = spawnSync(process.execPath, [path.join(tmp, 'scripts', 'vendor-assets.mjs'), ...args], { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const lax = runMode([]);
  check('vendor-assets without --strict and without devDependencies: warns, exit 0', lax.code === 0 && /WARNING/.test(lax.out), `exit ${lax.code}`);
  const strict = runMode(['--strict']);
  check('vendor-assets --strict without devDependencies: fails', strict.code !== 0 && /ERROR/.test(strict.out), `exit ${strict.code}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nSUMMARY: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
