#!/usr/bin/env node
/**
 * The accent is one colour everywhere: nothing in src/ paints the accent
 * with a stock Tailwind blue. Focus rings, selected / active borders, solid
 * accent fills, accent text and native controls go through the token
 * (ring-os-blue, border-os-blue, bg-os-blue, text-os-blue, accent-os-blue,
 * the --btn-* tokens), so the colour-vision palettes (which replace the
 * accent) and the themes reach them. The stock blue tints with a role of
 * their own (the info banners' bg-blue-50 / text-blue-700, the blue badge,
 * the brand gradient) are not accent and stay allowed.
 *
 * Also static: each colour-vision palette block in src/index.css sets the
 * primary button, the selected and quiet buttons and the accent's hover
 * shade from its accent, and the shared alias block derives the focus ring
 * and the ghost / quiet / selected tints from it.
 *
 * Also the colour-role sweep: every stock colour class still painting UI is
 * counted per file against tests/fixtures/colour-roles-baseline.json (they
 * are covered by the palette / high-contrast family overrides); a new one
 * fails unless the baseline is refreshed on purpose with --write-baseline.
 *
 * Run: node tests/accent-classes.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(jsx?|mjs|css)$/.test(e.name)) out.push(p); } return out; };
const files = walk(path.join(REPO, 'src'));

// the accent-role shapes: rings and outlines, the native accent, selected / focused borders, solid fills, accent text
const ACCENT = /\b(?:[a-z-]+:)*(?:ring|accent|caret|outline|shadow)-blue-\d+(?:\/\d+)?\b|\b(?:[a-z-]+:)*border-blue-(?:400|500|600|700)\b|\b(?:[a-z-]+:)*bg-blue-(?:500|600|700)\b(?!\/)|\b(?:[a-z-]+:)*text-blue-500\b/g;
// stock blue with a role of its own: the brand gradient (from-blue-500 to-purple-600) is not an accent use
const ALLOW = [/from-blue-500 to-purple-600/, /'border-blue-600',\s+\/\/ Blue/, /^\.dark \.border-blue-400 \{/];   // the brand gradient; a collaborator colour (userColors.js)
const hits = [];
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  s.split('\n').forEach((line, i) => {
    if (ALLOW.some((a) => a.test(line))) return;
    const m = line.match(ACCENT);
    if (m) hits.push(`${path.relative(REPO, f)}:${i + 1}: ${m.join(' ')}`);
  });
}
check(`no stock blue paints the accent in src/ (${files.length} files): rings, outlines, native accent, selected borders, solid fills, accent text go through the os-blue token`, hits.length === 0, hits.slice(0, 20).join(' ; '));

const css = fs.readFileSync(path.join(REPO, 'src', 'index.css'), 'utf8');
for (const kind of ['protanopia', 'deuteranopia', 'tritanopia']) {
  for (const sel of [`html.ra-cv-${kind} body`, `html.dark.ra-cv-${kind} body`]) {
    const i = css.indexOf(`\n${sel} {`);
    const body = i < 0 ? '' : css.slice(i, css.indexOf('\n}', i));
    const has = (re) => re.test(body);
    check(`${sel}: the palette sets the accent's hover shade, the primary button (bg from the accent, hover / active mixed from it, white text), the selected and quiet buttons from it`, i >= 0 && has(/--os-blue-hover: color-mix\(in srgb, var\(--os-blue\) (78%, black|80%, white)\)/) && has(/--btn-primary-bg: #[0-9a-f]{6}; --btn-primary-bg-hover: color-mix\(in srgb, #[0-9a-f]{6} 85%, black\); --btn-primary-bg-active: color-mix\(in srgb, #[0-9a-f]{6} 72%, black\); --btn-primary-fg: #ffffff;/) && has(/--btn-selected-bg: var\(--btn-primary-bg\); --btn-selected-bg-hover: var\(--btn-primary-bg-hover\); --btn-selected-fg: #ffffff; --btn-selected-text: var\(--(btn-primary-bg|os-blue-hover)\);/) && has(/--btn-quiet-fg: var\(--(btn-primary-bg|os-blue-hover)\);/), body.slice(0, 300));
  }
}
check('the shared alias block derives the focus ring and the ghost / quiet / selected shades from the accent (not from a transparent button background)', /--btn-ghost-ring: color-mix\(in srgb, var\(--os-blue\) 40%, transparent\); --btn-quiet-ring: color-mix\(in srgb, var\(--os-blue\) 40%, transparent\);/.test(css) && /--btn-quiet-bg-hover: color-mix\(in srgb, var\(--os-blue\) 10%, transparent\)/.test(css) && /--btn-selected-tint: color-mix\(in srgb, var\(--btn-selected-bg\) 12%, transparent\)/.test(css) && /--default-ring-color: color-mix\(in srgb, var\(--os-blue\) 50%, transparent\)/.test(css) && !/--btn-ghost-ring: color-mix\(in srgb, var\(--btn-ghost-bg\)/.test(css));

// ---- the colour-role sweep: the stock Tailwind colour utilities still in src/ (blue, green, red, amber, purple and
//      their siblings) are covered by the palette / high-contrast overrides of src/index.css (by hue family onto the
//      status-family tokens), and their number is frozen per file in tests/fixtures/colour-roles-baseline.json: a new
//      one fails here unless the baseline is refreshed on purpose (node tests/accent-classes.test.mjs --write-baseline)
const ROLE = /\b(?:[a-z-]+:)*(?:bg|text|border|ring|from|to|via|fill|stroke|divide|shadow|outline)-(?:blue|sky|indigo|cyan|violet|purple|fuchsia|pink|green|emerald|teal|lime|red|rose|amber|yellow|orange)-[0-9]{2,3}(?:\/[0-9]+)?\b/g;
const counts = {};
for (const f of files) {
  const rel = path.relative(REPO, f);
  if (rel === 'src/index.css') continue;   // the stylesheet's own role rules and the theme blocks
  const n = (fs.readFileSync(f, 'utf8').match(ROLE) || []).length;
  if (n) counts[rel] = n;
}
const baselinePath = path.join(REPO, 'tests', 'fixtures', 'colour-roles-baseline.json');
if (process.argv.includes('--write-baseline')) { fs.writeFileSync(baselinePath, JSON.stringify(counts, null, 2) + '\n'); console.log(`wrote ${baselinePath} (${Object.keys(counts).length} files)`); }
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : {};
const grown = Object.entries(counts).filter(([f, n]) => n > (baseline[f] || 0)).map(([f, n]) => `${f}: ${n} (baseline ${baseline[f] || 0})`);
check(`the colour-role sweep: no file in src/ paints UI with more stock colour classes than its baseline (${Object.keys(counts).length} files, ${Object.values(counts).reduce((a, b) => a + b, 0)} uses, all covered by the palette / high-contrast family overrides); route new colours through the status-family or chart-cat tokens`, grown.length === 0, grown.slice(0, 15).join(' ; '));
check('the shared primitives paint their roles from the tokens (Note, Badge, StatusLine), the collaborator colours from the chart categories, the workflow node states from the roles, the brand gradient from the accent and brand tokens', /info: 'border-\(--status-info-border\) bg-\(--status-info-bg\) text-\(--status-info-fg\)'/.test(fs.readFileSync(path.join(REPO, 'src/components/ui/primitives.jsx'), 'utf8')) && /purple: 'bg-\(--status-brand-bg\)/.test(fs.readFileSync(path.join(REPO, 'src/components/ui/primitives.jsx'), 'utf8')) && /border-\(--chart-cat-\$\{n\}\)/.test(fs.readFileSync(path.join(REPO, 'src/utils/userColors.js'), 'utf8')) && /border-\(--os-status-success\)/.test(fs.readFileSync(path.join(REPO, 'src/components/workflow/nodes/nodeStyles.js'), 'utf8')) && !/from-blue-500 to-purple-600/.test(fs.readFileSync(path.join(REPO, 'src/components/AIChatPage.jsx'), 'utf8')));
const cssText = fs.readFileSync(path.join(REPO, 'src', 'index.css'), 'utf8');
check('the stylesheet maps every stock hue family onto the status-family tokens under the palettes and high contrast (text, background and border), and a gradient rail takes the palette rail', ['info', 'success', 'warning', 'danger', 'brand'].every((r) => cssText.includes(`{ color: var(--status-${r}-fg); }`) && cssText.includes(`{ background-color: var(--status-${r}-bg); }`) && cssText.includes(`{ border-color: var(--status-${r}-border); }`)) && /html:is\(\.ra-cv-protanopia, \.ra-cv-deuteranopia, \.ra-cv-tritanopia\) \.sc-rail \{ background: var\(--os-rail\) !important/.test(cssText) && /--status-info-fg: #1e40af; --status-info-bg: #eff6ff; --status-info-border: #bfdbfe;/.test(cssText));
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
