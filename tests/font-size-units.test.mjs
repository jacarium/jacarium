#!/usr/bin/env node
/**
 * Font sizes in the renderer are rem, never px, so they follow the root size
 * (Accessibility > Text size with "Scale the interface too" scales the root
 * rem; a px size would stay small under the Low vision profile). Guards:
 *  - no text-[Npx] class, inline fontSize number / px string or stylesheet
 *    font-size: Npx in src/, except the allow-list below with its reasons;
 *  - the small sizes are the theme tokens text-2xs / 3xs / 4xs (11 / 10 / 9 px
 *    at the 16px root), declared in src/index.css @theme without line-height
 *    tokens (the inherited line-height stays, as with the classes they replaced).
 *
 * Run: node tests/font-size-units.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1500) : ''}`); if (!ok) failed++; };

// px font sizes that stay, each with its reason
const ALLOW = [
  { file: 'src/components/game-shared/ScoreGraph.jsx', pattern: /fontSize="10"/g, why: 'SVG text in user units: the chart scales with its viewBox, not the root font' },
];

const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(jsx?|css)$/.test(e.name)) out.push(p); } return out; };
const files = walk(path.join(REPO, 'src'));
const PX = [
  [/\btext-\[\d+(?:\.\d+)?px\]/g, 'text-[Npx] class'],
  [/\bfontSize:\s*(?:\d+(?:\.\d+)?|['"]\d+(?:\.\d+)?(?:px)?['"])/g, 'inline fontSize in px'],
  [/\bfontSize=["']\d+(?:px)?["']/g, 'fontSize attribute in px'],
  [/\bfont-size:\s*\d+(?:\.\d+)?px/g, 'stylesheet font-size in px'],
];
const offences = [];
for (const f of files) {
  const rel = path.relative(REPO, f);
  let text = fs.readFileSync(f, 'utf8');
  for (const a of ALLOW) if (a.file === rel) text = text.replace(a.pattern, '');
  for (const [re, what] of PX) for (const m of text.matchAll(re)) offences.push(`${rel}: ${what} (${m[0]})`);
}
check(`no px font size in src/ (${files.length} files; the allow-list: ${ALLOW.map((a) => `${a.file} - ${a.why}`).join('; ')})`, offences.length === 0, offences.slice(0, 20).join(' ; '));
for (const a of ALLOW) check(`the allow-list entry is still in use: ${a.file}`, (fs.readFileSync(path.join(REPO, a.file), 'utf8').match(a.pattern) || []).length > 0);

const css = fs.readFileSync(path.join(REPO, 'src', 'index.css'), 'utf8');
const theme = css.slice(css.indexOf('@theme {'), css.indexOf('\n}', css.indexOf('@theme {')));
check('src/index.css @theme declares --text-2xs 0.6875rem, --text-3xs 0.625rem, --text-4xs 0.5625rem (11 / 10 / 9 px at the 16px root) and no line-height token for them', /--text-2xs: 0\.6875rem;/.test(theme) && /--text-3xs: 0\.625rem;/.test(theme) && /--text-4xs: 0\.5625rem;/.test(theme) && !/--text-[234]xs--line-height/.test(theme));
const used = { 'text-2xs': 0, 'text-3xs': 0, 'text-4xs': 0 };
for (const f of files) { const t = fs.readFileSync(f, 'utf8'); for (const k of Object.keys(used)) used[k] += (t.match(new RegExp(`\\b${k}\\b`, 'g')) || []).length; }
check(`the small sizes are used through the tokens (${JSON.stringify(used)})`, used['text-2xs'] > 20 && used['text-3xs'] > 10 && used['text-4xs'] > 0);
check('the profile card descriptions (Settings > Accessibility) use text-2xs', /text-2xs leading-snug text-os-text-secondary">\{profile\.description\}/.test(fs.readFileSync(path.join(REPO, 'src/components/common/modals/settings/ProfileGallery.jsx'), 'utf8')));
check('src/mobile.css sets its font sizes and the editor line-height in rem', !/font-size:\s*\d+(?:\.\d+)?px|line-height:\s*\d+px/.test(fs.readFileSync(path.join(REPO, 'src', 'mobile.css'), 'utf8')));
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
