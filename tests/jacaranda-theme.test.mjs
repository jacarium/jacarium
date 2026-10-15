/**
 * The Jacaranda dark theme, statically: the token values in src/index.css,
 * the contrast of every text/surface pair the theme relies on (WCAG >= 4.5:1
 * for text, >= 3:1 for the rail's active icon and borders), the theme
 * context's handling of 'dark' (Jacaranda), 'dark-neutral' and the gradient
 * themes, the Color Scheme options, and the navigation rail drawing from the
 * rail tokens instead of hard-coded greys. The computed values in the
 * browser are checked by tests/tailwind-visual-regression.test.mjs and the
 * screens by tests/jacaranda-visual.test.mjs.
 *
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const css = read('src/index.css');
const block = (selector) => { const i = css.indexOf(`\n${selector} {`); if (i < 0) return ''; return css.slice(i, css.indexOf('\n}', i)); };
const tokens = (text) => Object.fromEntries(Array.from(text.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)).map((m) => [m[1], m[2].trim()]));
const jac = tokens(block('.dark'));
const neutral = tokens(block('.dark[data-dark-variant="neutral"]'));
const light = tokens(block(':root'));

const EXPECTED = {
  '--os-canvas': '#0F0D16', '--os-card': '#17141F', '--os-modal': '#17141F', '--os-sidebar': '#15121F',
  '--os-text-primary': '#EDE6FF', '--os-text-secondary': '#B9AFD6', '--os-border': '#2A2438', '--os-input-border': '#3A3350',
  '--os-rail': '#1B1530', '--os-rail-active': '#7B5CE0', '--os-status-success': '#3FA37A',
};
for (const [k, v] of Object.entries(EXPECTED)) check(`.dark ${k} is ${v} (Jacaranda)`, (jac[k] || '').toUpperCase() === v, jac[k]);
check('the neutral variant keeps the previous dark greys', neutral['--os-canvas'] === '#151515' && neutral['--os-card'] === '#1f1f1f' && neutral['--os-text-primary'] === '#f0f0f0' && neutral['--os-rail'] === '#1a1a1a' && (neutral['--os-status-success'] || '').toUpperCase() === '#3E8635', JSON.stringify({ c: neutral['--os-canvas'], t: neutral['--os-text-primary'], r: neutral['--os-rail'] }));
check('the light theme is unchanged (canvas, card, text, blue)', light['--os-canvas'] === '#F5F5F5' && light['--os-card'] === '#FFFFFF' && light['--os-text-primary'] === '#151515' && light['--os-blue'] === '#0066CC');
check('every token the neutral variant overrides exists in the Jacaranda block (no token falls through to a mixed theme)', Object.keys(neutral).every((k) => k in jac), Object.keys(neutral).filter((k) => !(k in jac)).join(','));
check('every surface/text token of the light theme has a Jacaranda value', ['--os-canvas', '--os-card', '--os-card-secondary', '--os-modal', '--os-border', '--os-text-primary', '--os-text-secondary', '--os-text-muted', '--os-divider', '--os-input-bg', '--os-input-border', '--os-rail', '--os-rail-hover', '--os-rail-active', '--os-rail-text', '--os-rail-tooltip', '--os-rail-separator', '--os-terminal-bg', '--os-terminal-text', '--os-status-success', '--os-code-bg'].every((k) => k in jac));
check('the body and the preview follow the tokens in the dark theme', /\.dark body \{\s*background-color: var\(--os-canvas\);\s*color: var\(--os-text-primary\);/.test(css) && /\.dark \.markdown-preview \{\s*color: var\(--os-text-primary\);/.test(css) && /\.dark \.markdown-preview pre \{\s*background-color: var\(--os-code-bg\);/.test(css));
check('the success colour utility draws from the token', /--color-status-success: var\(--os-status-success\);/.test(css));

// ---- contrast ----
const lum = (hex) => { const n = parseInt(hex.replace('#', ''), 16); const c = [16, 8, 0].map((s) => ((n >> s) & 255) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const pairs = [
  ['--os-text-primary', '--os-canvas', 4.5], ['--os-text-primary', '--os-card', 4.5], ['--os-text-primary', '--os-card-secondary', 4.5], ['--os-text-primary', '--os-modal', 4.5], ['--os-text-primary', '--os-input-bg', 4.5],
  ['--os-text-secondary', '--os-canvas', 4.5], ['--os-text-secondary', '--os-card', 4.5], ['--os-text-secondary', '--os-card-secondary', 4.5],
  ['--os-text-muted', '--os-card', 4.5], ['--os-text-muted', '--os-canvas', 4.5],
  ['--os-blue', '--os-card', 4.5], ['--os-blue', '--os-canvas', 4.5],
  ['--os-rail-text', '--os-rail', 4.5], ['--os-rail-text-active', '--os-rail-active', 4.5], ['--os-rail-text-active', '--os-rail-hover', 4.5],
  ['--os-terminal-text', '--os-terminal-bg', 4.5], ['--os-terminal-muted', '--os-terminal-bg', 4.5], ['--os-terminal-success', '--os-terminal-bg', 4.5], ['--os-terminal-error', '--os-terminal-bg', 4.5], ['--os-terminal-warning', '--os-terminal-bg', 4.5],
  ['--os-status-success', '--os-card', 3], ['--os-border', '--os-card', 1.2], ['--os-input-border', '--os-input-bg', 1.3], ['--os-rail-active', '--os-rail', 3],
];
for (const [fg, bg, min] of pairs) {
  const r = jac[fg] && jac[bg] ? ratio(jac[fg], jac[bg]) : 0;
  check(`Jacaranda ${fg} on ${bg} >= ${min}:1`, r >= min, `${r.toFixed(2)}:1 (${jac[fg]} on ${jac[bg]})`);
}
const CODE_BG = jac['--os-code-bg'];
for (const k of ['--os-code-keyword', '--os-code-string', '--os-code-number', '--os-code-comment', '--os-code-title', '--os-code-attr', '--os-code-builtin', '--os-code-meta']) {
  const r = jac[k] ? ratio(jac[k], CODE_BG) : 0;
  check(`Jacaranda code token ${k} on the code block >= 4.5:1`, r >= 4.5, `${r.toFixed(2)}:1`);
}

// ---- the theme context and the setting ----
const ctx = read('src/contexts/ThemeContext.jsx');
check("ThemeContext exports DARK_THEMES with 'dark' = Jacaranda (dark) and 'dark-neutral' = Dark (neutral)", /dark: \{ name: 'Jacaranda \(dark\)' \}/.test(ctx) && /'dark-neutral': \{ name: 'Dark \(neutral\)' \}/.test(ctx));
check("'dark-neutral' adds the .dark class", /if \(themeMode === 'dark-neutral'\) actualTheme = 'dark';/.test(ctx));
check('the neutral dark and the gradient themes set data-dark-variant="neutral"; Jacaranda and Auto remove it', /themeMode === 'dark-neutral' \|\| isGradientTheme\)\) \{\s*document\.documentElement\.setAttribute\('data-dark-variant', 'neutral'\);\s*\} else \{\s*document\.documentElement\.removeAttribute\('data-dark-variant'\);/.test(ctx));
const general = read('src/components/common/modals/settings/GeneralSettings.jsx');
check('the Color Scheme setting offers Auto, Light, the dark themes and the gradient themes', /<option value="auto">Auto \(System\)<\/option>/.test(general) && /<option value="light">Light<\/option>/.test(general) && /Object\.entries\(DARK_THEMES\)\.map/.test(general) && /Object\.entries\(GRADIENT_THEMES\)\.map/.test(general));

// ---- the rail ----
const rail = read('src/components/CompactSidebar.jsx');
const greys = rail.match(/\b(bg|text|border|hover:bg|hover:text)-gray-\d{3}\b|#1a1a1a/g) || [];
check('the navigation rail uses the rail tokens, no hard-coded greys', greys.length === 0, greys.slice(0, 6).join(', '));
check('the rail tokens are Tailwind colours (bg-os-rail, hover:bg-os-rail-hover, text-os-rail-text, ...)', /--color-os-rail: var\(--os-rail\);/.test(css) && /bg-os-rail\b/.test(rail) && /hover:bg-os-rail-hover/.test(rail) && /text-os-rail-text\b/.test(rail) && /bg-os-rail-active/.test(rail) && /bg-os-rail-tooltip/.test(rail));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
