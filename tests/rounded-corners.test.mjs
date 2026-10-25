/**
 * The corner radius scale, statically: the tokens in src/index.css @theme
 * carry the approved values (xs 6, sm/bare 8, md 10, lg 14, xl 16, 2xl 20,
 * 3xl 28), the components use the rounded-* utilities (no arbitrary
 * `rounded-[...]`, no inline border radii outside the allow-list), every
 * hand-written border-radius in index.css is a token, 0 or a full round, and
 * the square exceptions (the tabs of a tab strip, the SubTabs buttons, table
 * cells, the editor textarea, scrollbar thumbs) are declared. The computed values in the
 * browser are checked by tests/tailwind-visual-regression.test.mjs.
 *
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const css = read('src/index.css');
const theme = css.slice(css.indexOf('@theme {'), css.indexOf('\n}', css.indexOf('@theme {')));
const SCALE = { '--radius-xs': '6px', '--radius-sm': '8px', '--radius': '8px', '--radius-md': '10px', '--radius-lg': '14px', '--radius-xl': '16px', '--radius-2xl': '20px', '--radius-3xl': '28px' };
for (const [token, value] of Object.entries(SCALE)) {
  const m = new RegExp(`^\\s*${token}:\\s*([^;]+);`, 'm').exec(theme);
  check(`@theme ${token} is ${value}`, m && m[1].trim() === value, m ? m[1] : 'missing');
}

// a radius token's value in px: the scale itself, or a control token (--radius-control: var(--radius-sm)) followed to it
const resolveRadius = (token, depth = 0) => {
  if (SCALE[token]) return SCALE[token];
  const m = new RegExp(`^\\s*${token}:\\s*([^;]+);`, 'm').exec(css);
  if (!m || depth > 4) return null;
  const val = m[1].trim();
  const ref = /^var\((--radius(?:-\w+)?)\)$/.exec(val);
  return ref ? resolveRadius(ref[1], depth + 1) : val;
};

// hand-written radii in index.css: tokens (with or without their fallback), 0, or a full round; 2px for the
// inline text highlight (<mark>) is the one literal
const literal = [];
css.split('\n').forEach((line, i) => {
  const m = /border-radius:\s*([^;]+);/.exec(line);
  if (!m) return;
  const v = m[1].trim();
  // a token may carry its px fallback (var(--radius-sm, 8px): a sheet loaded on its own still rounds), and the
  // fallback must be the token's own value, so it cannot drift from the scale
  const tokens = v.replace(/ 0\b/g, '').split(/\s+(?=var\()/);
  if (tokens.every((t) => { const tm = /^var\((--radius(?:-\w+)?)(?:, (\d+px))?\)$/.exec(t); return tm && (!tm[2] || tm[2] === resolveRadius(tm[1])); }) || v === '0' || /^(9999px|50%|calc\(infinity \* 1px\))$/.test(v)) return;
  if (/\.markdown-preview mark/.test(css.split('\n').slice(Math.max(0, i - 6), i).join('\n')) && v === '2px') return;
  literal.push(`${i + 1}: ${v}`);
});
check('every hand-written border-radius in index.css is a token, 0 or a full round', literal.length === 0, literal.join(' ; '));
const subTabs = (/export function SubTabs[\s\S]*?\n\}\n/.exec(read('src/components/ui/primitives.jsx')) || [''])[0];
check('the SubTabs primitive squares its tab buttons (rounded-none on the border-b-2 button: a straight underline with square ends)', /<button[\s\S]*?className=\{`[^`]*\bborder-b-2\b[^`]*\brounded-none\b/.test(subTabs), subTabs.slice(0, 200));
check('the exceptions are declared: tab strips square (every tab of .sc-tab-strip, the document tabs by test id), table cells square, the editor textarea square, scrollbar thumbs square',
  /\.sc-tab-strip > \*, \[data-testid="document-tab"\] \{ border-radius: 0; \}/.test(css)
  && /td, th, td\[class\], th\[class\] \{ border-radius: 0; \}/.test(css)
  && /textarea\.resize-none\.h-full \{ border-radius: 0; \}/.test(css)
  && /\*::-webkit-scrollbar-thumb \{[^}]*border-radius: 0;/.test(css));

// the components: utilities only
const files = execFileSync('git', ['ls-files', 'src'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => /\.(jsx?|mjs|css)$/.test(f) && f !== 'src/index.css');
const arbitrary = []; const inline = [];
const INLINE_ALLOW = {
  'src/components/features/tools/CssFormatterTool.jsx': /border-radius:/,   // the sample CSS the formatter demonstrates on
};
for (const f of files) {
  const s = read(f);
  s.split('\n').forEach((line, i) => {
    if (/rounded-\[/.test(line)) arbitrary.push(`${f}:${i + 1}`);
    const m = /border(?:-r|R)adius:\s*['"`]?([^,;'"`}]+)/.exec(line);
    if (m && !/var\(--radius/.test(m[1]) && !(INLINE_ALLOW[f] && INLINE_ALLOW[f].test(line))) inline.push(`${f}:${i + 1}: ${m[1].trim()}`);
  });
}
check('no arbitrary rounded-[...] utility in the components', arbitrary.length === 0, arbitrary.slice(0, 6).join(', '));
check('inline border radii use the tokens (var(--radius-*)) outside the allow-list', inline.length === 0, inline.slice(0, 6).join(' ; '));

// the whole scale is in use somewhere, and rounded-full stays for pills
const all = files.map(read).join('\n');
for (const u of ['rounded-xs', 'rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-full']) check(`${u} is used by the components`, new RegExp(`\\b${u}\\b`).test(all));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
