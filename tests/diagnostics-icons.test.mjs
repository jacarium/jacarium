/**
 * The Font Awesome icons of the Diagnostics pages Flask serves itself
 * (backend/templates/index.html, layout.html and every tab template) against
 * the vendored Font Awesome 7 (scripts/vendor-assets.mjs ->
 * backend/static/vendor/fontawesome).
 *
 *   static (always):
 *   - the package is 7.x, and the vendored copy is the package's: all.min.css,
 *     exactly the webfonts the stylesheet references (7 ships woff2 alone),
 *     no leftover of an older version, the LICENSE.txt;
 *   - EVERY icon class the templates use - the static ones and both branches
 *     of each Jinja-built name (`fa-{% if %}a{% else %}b{% endif %}`) - every
 *     one diagnostics-ui.js builds (including fa-sort-up / fa-sort-down),
 *     every one in log_viewer.py's registry and in DiagnosticsPage.jsx's
 *     icon map is a glyph rule in the vendored stylesheet under its own name
 *     (not only through a v5 alias), and the style prefixes used (fas, far)
 *     are defined there; no v4 / v5 shim stylesheet is used;
 *   - the registry's icon strings and the React map's keys agree on the names
 *     they share (a rename on one side alone would lose the sidebar icon);
 *
 *   live (SKIP without backend/venv, playwright-core or Chromium):
 *   every page of a sosreport and of a must-gather through a real backend on
 *   ICONS_BACKEND_PORT (default 8081), in light and dark
 *   (tests/helpers/diagnostics-icons-shots.mjs): every laid-out icon has its
 *   glyph (a ::before content, the Font Awesome 7 font loaded), none is blank
 *   or tofu; screenshots go to ICONS_OUT (default: a temporary directory)
 *   with the prefix ICONS_LABEL (default "after"); with ICONS_BEFORE_DIR the
 *   same pages' "before-*" screenshots are compared pixel by pixel and the
 *   difference is printed per page (reported, not failing: a new glyph
 *   design is a difference by definition).
 *
 * Run: node tests/diagnostics-icons.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { captureDiagnosticsIcons } from './helpers/diagnostics-icons-shots.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 600) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// ---------------------------------------------------------------------------
// the vendored package
// ---------------------------------------------------------------------------
const VENDOR = path.join(REPO, 'backend', 'static', 'vendor', 'fontawesome');
const pkgVersion = JSON.parse(read('node_modules/@fortawesome/fontawesome-free/package.json')).version;
const wanted = JSON.parse(read('package.json')).devDependencies['@fortawesome/fontawesome-free'];
check(`@fortawesome/fontawesome-free is 7.x (package.json ${wanted}, installed ${pkgVersion})`, /^\^?7\./.test(wanted) && pkgVersion.startsWith('7.'));
const cssPath = path.join(VENDOR, 'css', 'all.min.css');
check('the vendored stylesheet, LICENSE.txt and webfonts are there (run `npm run vendor` after `npm install`)', fs.existsSync(cssPath) && fs.existsSync(path.join(VENDOR, 'LICENSE.txt')) && fs.existsSync(path.join(VENDOR, 'webfonts')));
const css = fs.existsSync(cssPath) ? read('backend/static/vendor/fontawesome/css/all.min.css') : '';
check('the vendored stylesheet is the installed package\'s (byte for byte)', css.length > 0 && css === read('node_modules/@fortawesome/fontawesome-free/css/all.min.css'));
const referencedFonts = [...new Set([...css.matchAll(/url\(\.\.\/webfonts\/([^)?#]+)/g)].map((m) => m[1]))].sort();
const vendoredFonts = fs.existsSync(path.join(VENDOR, 'webfonts')) ? fs.readdirSync(path.join(VENDOR, 'webfonts')).sort() : [];
check(`the webfonts directory holds exactly the files the stylesheet references (${referencedFonts.join(', ')}) - nothing left from an older version`, referencedFonts.length > 0 && JSON.stringify(referencedFonts) === JSON.stringify(vendoredFonts), `vendored: ${vendoredFonts.join(', ')}`);
check('the vendored webfonts are the package\'s (byte for byte)', vendoredFonts.length > 0 && vendoredFonts.every((f) => fs.readFileSync(path.join(VENDOR, 'webfonts', f)).equals(fs.readFileSync(path.join(REPO, 'node_modules/@fortawesome/fontawesome-free/webfonts', f)))));
check('the stylesheet declares the Font Awesome 7 font families', /font-family:"Font Awesome 7 Free"/.test(css) && /font-family:"Font Awesome 7 Brands"/.test(css));

// the glyph rules by name: 5.x `.fa-x:before{content:"\f00c"}`, 6.x / 7.x `.fa-x{--fa:"\f00c"}`
const glyphs = new Set();
for (const m of css.matchAll(/((?:\.fa-[a-z0-9-]+(?:::?before)?,?)+)\{(?:content|--fa):"\\[0-9a-f]+"(?:;--fa--fa:"[^"]*")?\}/g)) for (const n of m[1].matchAll(/\.fa-([a-z0-9-]+)/g)) glyphs.add(n[1]);
const utilities = new Set(['spin', 'pulse', 'fw', 'lg', 'xs', 'sm', 'li', 'ul', 'border', 'inverse', 'stack', 'beat', 'fade', 'bounce', 'flip', 'shake', 'spin-pulse', 'spin-reverse']);
for (const m of css.matchAll(/\.fa-([a-z0-9-]+)\{/g)) utilities.add(m[1]);
check(`the stylesheet has glyph rules (${glyphs.size})`, glyphs.size > 1000);
const prefixes = ['fas', 'far', 'fab', 'fa-solid', 'fa-regular', 'fa-brands'].filter((p) => new RegExp(`(^|[,{}])\\.${p}(?=[,{.:])`).test(css));
check('the style prefixes the templates use (fas, far) are defined in 7.x', prefixes.includes('fas') && prefixes.includes('far'), prefixes.join(', '));

// ---------------------------------------------------------------------------
// every icon name in use
// ---------------------------------------------------------------------------
const uses = new Map();   // name -> [where]
const use = (name, where) => { if (!uses.has(name)) uses.set(name, []); uses.get(name).push(where); };
const TEMPLATES = walk(path.join(REPO, 'backend', 'templates')).filter((f) => f.endsWith('.html'));
let jinjaBuilt = 0;
for (const file of TEMPLATES) {
  const text = fs.readFileSync(file, 'utf8');
  const where = path.relative(REPO, file);
  for (const m of text.matchAll(/\bfa-([a-z0-9-]+)/g)) use(m[1], where);
  // fa-{% if ... %}a{% else %}b{% endif %}: both branches
  for (const m of text.matchAll(/\bfa-\{%\s*if[^%]*%\}([a-z0-9-]+)\{%\s*else\s*%\}([a-z0-9-]+)\{%\s*endif\s*%\}/g)) { jinjaBuilt += 1; use(m[1], `${where} (if branch)`); use(m[2], `${where} (else branch)`); }
  // fa-{{ var }} would be invisible to this test
  check(`${where}: no icon name is built from a variable (fa-{{ ... }}) the test cannot follow`, !/\bfa-\{\{/.test(text));
}
check(`the Jinja-built icon names were found and both branches taken (${jinjaBuilt})`, jinjaBuilt >= 1);
const ui = read('backend/static/diagnostics-ui.js');
for (const m of ui.matchAll(/\bfa-([a-z0-9-]+)(?![a-z0-9-])/g)) if (m[1] !== 'sort-') use(m[1], 'backend/static/diagnostics-ui.js');
check('diagnostics-ui.js builds the sort markers as fa-sort-up / fa-sort-down (followed here)', /fa-sort-\$\{sortAscending \? 'up' : 'down'\}/.test(ui));
use('sort-up', 'backend/static/diagnostics-ui.js (built)'); use('sort-down', 'backend/static/diagnostics-ui.js (built)');
const registry = read('backend/log_viewer.py');
const registryIcons = [...registry.matchAll(/'icon': '([^']+)'/g)].map((m) => m[1]);
for (const icon of registryIcons) for (const m of icon.matchAll(/\bfa-([a-z0-9-]+)/g)) use(m[1], 'backend/log_viewer.py');
const page = read('src/components/DiagnosticsPage.jsx');
const mapKeys = [...page.matchAll(/'(fa[sr] fa-[a-z0-9-]+)': /g)].map((m) => m[1]);
for (const key of mapKeys) for (const m of key.matchAll(/\bfa-([a-z0-9-]+)/g)) use(m[1], 'src/components/DiagnosticsPage.jsx');
const names = [...uses.keys()].filter((n) => !utilities.has(n));
const missing = names.filter((n) => !glyphs.has(n));
check(`every icon name in use (${names.length} names from ${TEMPLATES.length} templates, diagnostics-ui.js, the registry and the React map) is a glyph rule in the vendored 7.x stylesheet`, missing.length === 0, missing.map((n) => `${n} <- ${uses.get(n).slice(0, 2).join(', ')}`).join(' || '));
// the v5 names that 7 keeps as aliases are not what the sources say any more
const V5 = ['check-circle', 'times-circle', 'exclamation-circle', 'info-circle', 'question-circle', 'exclamation-triangle', 'cogs', 'file-alt', 'heartbeat', 'history', 'home', 'sliders-h', 'tachometer-alt', 'tasks', 'tools', 'vote-yea', 'balance-scale', 'hdd', 'project-diagram', 'shield-alt', 'stream'];
const stale = V5.filter((n) => uses.has(n));
check('the sources use the 7.x names, not the v5 ones 7 keeps as aliases (circle-check, gears, file-lines, gauge-high, ...)', stale.length === 0, stale.join(', '));
check('no v4 / v5 shim stylesheet is referenced', !TEMPLATES.some((f) => /v4-shims|v5-font-face|v4-font-face/.test(fs.readFileSync(f, 'utf8'))));
const shared = mapKeys.filter((k) => !registryIcons.includes(k));
check(`the React map's keys (${mapKeys.length}) are all registry icon strings (the two were renamed together)`, shared.length === 0, shared.join(', '));

// ---------------------------------------------------------------------------
// live: every page through the real backend and Chromium
// ---------------------------------------------------------------------------
if (process.env.SKIP_BROWSER_TESTS) console.log('SKIP (live): SKIP_BROWSER_TESTS is set');
else {
  const out = process.env.ICONS_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-icons-'));
  const label = process.env.ICONS_LABEL || 'after';
  const r = await captureDiagnosticsIcons({ out, label, log: (line) => { if (process.env.ICONS_VERBOSE) console.log(line); } });
  if (r.skip) console.log(`SKIP (live): ${r.skip}`);
  else {
    const icons = r.pages.reduce((n, p) => n + p.icons, 0);
    const bad = r.pages.filter((p) => p.missing.length);
    check(`${r.pages.length} pages rendered (light and dark) with ${icons} icons laid out`, r.pages.length >= 100 && icons > 1000);
    check('every icon on every page has its glyph: a ::before content and the Font Awesome font loaded (no blank or tofu icon)', bad.length === 0, bad.slice(0, 6).map((p) => `${p.theme} ${p.type}/${p.tab}: ${p.missing.slice(0, 3).join(' | ')}`).join(' || '));
    const families = {};
    for (const p of r.pages) for (const [f, n] of Object.entries(p.families)) families[f] = (families[f] || 0) + n;
    check('the icons render with the Font Awesome 7 font (the 5 family names are aliases in 7\'s stylesheet, unused by the templates)', Object.keys(families).every((f) => /Font Awesome 7/.test(f)), JSON.stringify(families));
    const errors = r.pages.reduce((n, p) => n + p.errors.length, 0);
    console.log(`  page errors reported by the pages' own scripts: ${errors} (unrelated to the icons; compare with the before run)`);
    console.log(`  screenshots: ${r.pages.length} in ${out} (${label}-<report>-<tab>-<theme>.png)`);
    // the before / after comparison, when a before run is there
    const beforeDir = process.env.ICONS_BEFORE_DIR;
    if (beforeDir && fs.existsSync(beforeDir)) {
      let PNG = null;
      try { ({ PNG } = req('pngjs')); } catch { PNG = null; }
      if (!PNG) console.log('  (pngjs missing: no pixel comparison)');
      else {
        const rows = [];
        for (const p of r.pages) {
          const beforeFile = path.join(beforeDir, path.basename(p.file).replace(new RegExp(`^${label}-`), 'before-'));
          if (!fs.existsSync(beforeFile)) { rows.push(`${p.theme} ${p.type}/${p.tab}: no before screenshot`); continue; }
          const a = PNG.sync.read(fs.readFileSync(beforeFile)), b = PNG.sync.read(fs.readFileSync(p.file));
          if (a.width !== b.width || a.height !== b.height) { rows.push(`${p.theme} ${p.type}/${p.tab}: size differs`); continue; }
          let diff = 0;
          for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 48) diff += 1;
          rows.push(`${p.theme} ${p.type}/${p.tab}: ${(100 * diff / (a.width * a.height)).toFixed(2)}% of pixels differ`);
        }
        console.log('  before / after (the icon glyphs are the expected difference):');
        for (const row of rows) console.log(`    ${row}`);
      }
    }
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
