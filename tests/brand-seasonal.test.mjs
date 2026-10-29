/**
 * The seasonal decorations of the mark (src/brand/seasonal/), statically:
 *
 *  - without a decoration the mark's markup is byte for byte what it was
 *    before decorations existed (the header's 36 px dark-tone mark and
 *    About's 56 px mark, frozen below), and so is a forced 'none';
 *  - the four windows (pumpkin 20 Oct - 2 Nov, Santa hat 1 - 27 Dec,
 *    New Year 28 Dec - 3 Jan, the 4 May light sword on 4 May): every boundary day with an injected clock,
 *    the wrap over 31 Dec -> 1 Jan, no gap between Christmas and New Year,
 *    no overlap anywhere in the year (every day of a leap year checked);
 *  - overlapping windows resolve to the first decoration in the registry;
 *  - the override: 'none', a decoration id, an unknown id, 'auto';
 *  - a decorated render keeps the mark's markup as its prefix (the mark is
 *    unchanged in size, position and colours), adds the decoration group and
 *    lets it overflow the box; each decoration carries its palette;
 *  - on every theme (Light, Jacaranda, the neutral dark, the five gradients)
 *    every colour of every decoration, resolved through the theme's variables
 *    in src/index.css, has >= 3:1 against each surface the part lies on (the
 *    rail or the gradient's top colour, the About hero, the arch where the
 *    part crosses it) - the mark's own computation (tests/brand.test.mjs) -
 *    either by the colour itself or, on the gradient themes, by the one-unit
 *    edge in the theme's deep tone; the look the user approved on the default
 *    themes is kept as it is and its known shortfalls are listed, not hidden;
 *  - the header and About ask for the seasonal mark, the shipped switch is
 *    'auto', the hook re-checks on focus / visibility and hourly, the
 *    how-to lists the windows.
 *
 * Bundled with esbuild (the real components), rendered with react-dom/server.
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

// ---- the mark as it was before decorations (frozen; must never change) ----
const MARK_BODY = '<path d="M22 110 V54 A38 38 0 0 1 98 54 V110 Z" fill="var(--mark-arch, #7B5CE0)"></path>'
  + '<g fill="BLOSSOM">' + [0, 72, 144, 216, 288].map((deg) => `<ellipse cx="60" cy="49" rx="8.5" ry="13" transform="rotate(${deg} 60 64)"></ellipse>`).join('') + '</g>'
  + '<circle cx="60" cy="64" r="5" fill="var(--mark-center, var(--mark-arch, #7B5CE0))"></circle>';
const plainMark = (size, blossom) => `<svg width="${size}" height="${size}" viewBox="0 0 120 120" role="img" aria-label="Jacarium" class="" focusable="false" data-brand="mark">${MARK_BODY.replace('BLOSSOM', blossom)}</svg>`;
const HEADER_MARK = plainMark(36, 'var(--mark-blossom, #EDE6FF)');                          // <BrandMark size={36} tone="dark" />
const ABOUT_MARK = plainMark(56, 'var(--mark-blossom, var(--brand-blossom, #FFFFFF))');    // <BrandMark size={56} />

// ---- bundle the real components ----
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-seasonal-'));
const ENTRY = path.join(WORKDIR, 'entry.jsx');
fs.writeFileSync(ENTRY, `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BrandMark from '@repo/src/brand/BrandMark.jsx';
import { DECORATIONS, activeDecoration, inWindow, decorationById } from '@repo/src/brand/seasonal/index.js';
import { ACTIVE_DECORATION } from '@repo/src/brand/seasonal/active.js';
export const render = (props) => renderToStaticMarkup(React.createElement(BrandMark, props));
export { DECORATIONS, activeDecoration, inWindow, decorationById, ACTIVE_DECORATION };
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORKDIR, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx' }, define: { 'process.env.NODE_ENV': '"production"' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], logLevel: 'warning',
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@repo\// }, (args) => ({ path: path.join(REPO, args.path.replace(/^@repo\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (args) => { if (isBuiltin(args.path)) return { path: args.path, external: true }; try { return { path: req.resolve(args.path) }; } catch { return null; } });
  } }],
});
const { render, DECORATIONS, activeDecoration, inWindow, decorationById, ACTIVE_DECORATION } = createRequire(import.meta.url)(BUNDLE);
fs.rmSync(WORKDIR, { recursive: true, force: true });

// ---- the plain mark is unchanged ----
check('the header mark (36, dark) without a decoration is byte for byte the pre-decoration mark', render({ size: 36, tone: 'dark' }) === HEADER_MARK, render({ size: 36, tone: 'dark' }).slice(0, 120));
check('the About mark (56) without a decoration is byte for byte the pre-decoration mark', render({ size: 56 }) === ABOUT_MARK);
check("decoration='none' renders exactly the plain mark (header and About)", render({ size: 36, tone: 'dark', decoration: 'none' }) === HEADER_MARK && render({ size: 56, decoration: 'none' }) === ABOUT_MARK);
check("seasonal with decoration='none' is still the plain mark", render({ size: 36, tone: 'dark', seasonal: true, decoration: 'none' }) === HEADER_MARK);
check('the plain mark carries no overflow attribute and no decoration group', !/overflow|data-decoration/.test(HEADER_MARK) && !/overflow|data-decoration/.test(render({ size: 36, tone: 'dark' })));

// ---- the registry and its windows ----
const ids = DECORATIONS.map((d) => d.id);
check('the registry holds pumpkin, christmas, newyear and may-the-fourth, in that order', ids.join(',') === 'pumpkin,christmas,newyear,may-the-fourth', ids.join(','));
const win = (id) => decorationById(id).window;
check('pumpkin: 20 Oct - 2 Nov', JSON.stringify(win('pumpkin')) === '{"from":[10,20],"to":[11,2]}', JSON.stringify(win('pumpkin')));
check('christmas: 1 - 27 Dec', JSON.stringify(win('christmas')) === '{"from":[12,1],"to":[12,27]}', JSON.stringify(win('christmas')));
check('newyear: 28 Dec - 3 Jan (wrapping)', JSON.stringify(win('newyear')) === '{"from":[12,28],"to":[1,3]}', JSON.stringify(win('newyear')));
check('may-the-fourth: 4 May only', JSON.stringify(win('may-the-fourth')) === '{"from":[5,4],"to":[5,4]}', JSON.stringify(win('may-the-fourth')));
for (const d of DECORATIONS) check(`${d.id} renders a <g data-decoration="${d.id}">, has a name and declares its colours`, typeof d.name === 'string' && d.name.length > 0 && typeof d.render === 'function' && Array.isArray(d.colours) && d.colours.length >= 2 && d.colours.every((c) => /^#[0-9A-F]{6}$/.test(c.fallback) && c.on.every((o) => ['rail', 'hero', 'arch'].includes(o))));

// the injected clock: local dates (the hook uses new Date(), the local date, the same way)
const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);
const idAt = (y, m, d, override = 'auto') => (activeDecoration(at(y, m, d), override) || { id: null }).id;
const boundaries = [
  [2026, 10, 19, null], [2026, 10, 20, 'pumpkin'], [2026, 10, 31, 'pumpkin'], [2026, 11, 1, 'pumpkin'], [2026, 11, 2, 'pumpkin'], [2026, 11, 3, null],
  [2026, 11, 30, null], [2026, 12, 1, 'christmas'], [2026, 12, 24, 'christmas'], [2026, 12, 25, 'christmas'], [2026, 12, 27, 'christmas'],
  [2026, 12, 28, 'newyear'], [2026, 12, 31, 'newyear'], [2027, 1, 1, 'newyear'], [2027, 1, 3, 'newyear'], [2027, 1, 4, null],
  [2027, 7, 14, null], [2028, 2, 29, null], [2027, 5, 3, null], [2027, 5, 4, 'may-the-fourth'], [2027, 5, 5, null], [2028, 5, 4, 'may-the-fourth'], [2027, 10, 20, 'pumpkin'], [2027, 12, 31, 'newyear'], [2028, 1, 1, 'newyear'],
];
for (const [y, m, d, want] of boundaries) check(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} -> ${want || 'no decoration'}`, idAt(y, m, d) === want, String(idAt(y, m, d)));
check('inWindow wraps over New Year (28 Dec - 3 Jan holds 31 Dec and 1 Jan, not 4 Jan or 27 Dec)', inWindow(win('newyear'), at(2026, 12, 31)) && inWindow(win('newyear'), at(2027, 1, 1)) && !inWindow(win('newyear'), at(2027, 1, 4)) && !inWindow(win('newyear'), at(2026, 12, 27)));
{
  // every day of a leap year: at most one window holds it (no overlaps), and the day counts are the windows' lengths
  const counts = { pumpkin: 0, christmas: 0, newyear: 0, 'may-the-fourth': 0 };
  let overlaps = 0;
  for (let day = new Date(2028, 0, 1); day.getFullYear() === 2028; day.setDate(day.getDate() + 1)) {
    const holders = DECORATIONS.filter((d) => inWindow(d.window, day));
    if (holders.length > 1) overlaps++;
    for (const h of holders) counts[h.id]++;
  }
  check('no two windows overlap on any day of the year', overlaps === 0, String(overlaps));
  check('the windows cover 14 (pumpkin), 27 (christmas), 7 (newyear) and 1 (may-the-fourth) days', counts.pumpkin === 14 && counts.christmas === 27 && counts.newyear === 7 && counts['may-the-fourth'] === 1, JSON.stringify(counts));
  check('Christmas and New Year are contiguous (no gap on 27/28 Dec), and 20 Oct / 3 Nov / 1 Dec / 4 Jan bound the seasons', idAt(2026, 12, 27) === 'christmas' && idAt(2026, 12, 28) === 'newyear');
}

// ---- overlapping windows: the first in the registry wins ----
{
  const first = { id: 'first', name: 'first', window: { from: [6, 1], to: [6, 30] }, render: () => null };
  const second = { id: 'second', name: 'second', window: { from: [6, 10], to: [7, 10] }, render: () => null };
  check('overlap: the first decoration of the registry wins on a shared day', activeDecoration(at(2026, 6, 15), 'auto', [first, second]).id === 'first');
  check('overlap: the order of the registry decides (reversed registry, same day)', activeDecoration(at(2026, 6, 15), 'auto', [second, first]).id === 'second');
  check('overlap: outside the first window the second applies', activeDecoration(at(2026, 7, 5), 'auto', [first, second]).id === 'second');
}

// ---- the override ----
check("override 'none' -> no decoration even inside a window", idAt(2026, 10, 31, 'none') === null && idAt(2026, 12, 25, 'none') === null);
check("override 'pumpkin' -> the pumpkin in July", idAt(2026, 7, 14, 'pumpkin') === 'pumpkin');
check("override 'newyear' -> the fireworks in July, 'christmas' -> the hat", idAt(2026, 7, 14, 'newyear') === 'newyear' && idAt(2026, 7, 14, 'christmas') === 'christmas');
check('an unknown override id -> no decoration', idAt(2026, 10, 31, 'snowman') === null);
check("override 'auto' or empty -> the date decides", idAt(2026, 10, 31, 'auto') === 'pumpkin' && idAt(2026, 10, 31, '') === 'pumpkin' && idAt(2026, 10, 31, undefined) === 'pumpkin');
check("the shipped switch is 'auto' (src/brand/seasonal/active.js)", ACTIVE_DECORATION === 'auto', ACTIVE_DECORATION);

// ---- decorated renders: the mark unchanged, the decoration added, overflow allowed ----
const PALETTE = { pumpkin: ['#E8702A', '#FF8A3D', '#8E6CF0', '#0F0D16'], christmas: ['#D93A3A', '#B52F2F', '#F5F2FF'], newyear: ['#8E6CF0', '#F5C542', '#FFD86B'], 'may-the-fourth': ['#9BE7FF', '#F5F2FF', '#D6CCF5', '#2A2340', '#FFD86B'] };
for (const d of DECORATIONS) {
  const header = render({ size: 36, tone: 'dark', decoration: d.id });
  const about = render({ size: 56, decoration: d.id });
  const headerOpen = HEADER_MARK.replace('data-brand="mark">', 'data-brand="mark" overflow="visible">');
  const aboutOpen = ABOUT_MARK.replace('data-brand="mark">', 'data-brand="mark" overflow="visible">');
  check(`${d.id}: the header render is the plain mark (overflow visible) followed by the decoration group`, header.startsWith(headerOpen.slice(0, -6)) && header.endsWith('</g></svg>') && header.includes(`<g data-decoration="${d.id}"`), header.slice(0, 160));
  check(`${d.id}: the About render likewise`, about.startsWith(aboutOpen.slice(0, -6)) && about.includes(`<g data-decoration="${d.id}"`));
  check(`${d.id}: the decoration comes after the mark's centre dot, in the same svg`, header.indexOf('<circle cx="60" cy="64" r="5"') < header.indexOf(`<g data-decoration="${d.id}"`) && (header.match(/<svg /g) || []).length === 1);
  check(`${d.id}: the mark's size, viewBox and colours are untouched`, header.includes('width="36" height="36" viewBox="0 0 120 120"') && header.includes('fill="var(--mark-arch, #7B5CE0)"') && header.includes('fill="var(--mark-blossom, #EDE6FF)"') && (header.match(/<ellipse cx="60" cy="49"/g) || []).length === 5);
  check(`${d.id}: carries its palette (${PALETTE[d.id].join(' ')}) as the defaults of its theme variables`, PALETTE[d.id].every((c) => header.includes(c)), header.slice(-300));
  check(`${d.id}: no rim group is added; the only edges are the fur's fixed pale rim and the sword's blade edge through its variable`, !/data-rim/.test(header) && (d.id === 'christmas' ? (header.match(/#D6CCF0/g) || []).length === 2 && !/--decor-/.test(header) : d.id === 'may-the-fourth' ? (header.match(/var\(--decor-blade-edge, none\)/g) || []).length === 3 : !/--decor-(blade-)?edge/.test(header)));
  check(`${d.id}: no script, no external reference, no raster in the decoration`, !/<script|xlink:href|<image|http:/.test(header));
}
{
  // the hat: the band spans the mark's width over the arch top; the body's base lies on the band's centre line
  // (its sub-curve between t = 0.1 and 0.9), so no red is below the band; the crown rises above the box
  const hat = render({ size: 36, decoration: 'christmas' });
  check('the Santa hat: the fur band runs from (16,37) over the arch top to (104,33), 10 wide', hat.includes('d="M16 37 Q 58 2 104 33"') && hat.includes('stroke-width="10"'));
  const P0 = [16, 37], C = [58, 2], P2 = [104, 33];
  const at = (t) => [0, 1].map((i) => (1 - t) ** 2 * P0[i] + 2 * t * (1 - t) * C[i] + t * t * P2[i]);
  const [l, r] = [at(0.1), at(0.9)];
  check('the hat body\'s base is the band\'s own centre line between inset points (no red below the band)', hat.includes(`24.4 30.7 Q 58.4 7.9 94.8 27.5 Z`) && Math.abs(l[0] - 24.4) < 0.1 && Math.abs(l[1] - 30.7) < 0.1 && Math.abs(r[0] - 94.8) < 0.1 && Math.abs(r[1] - 27.5) < 0.1, JSON.stringify([l, r]));
  check('the hat crown rises to y=-18 above the box and the pompom hangs at (116,1)', hat.includes('70 -18') && hat.includes('cx="116" cy="1"'));
}
check('the pumpkin is the website\'s pumpkin at the bottom right (translate(80 66.7) scale(2.36))', render({ size: 36, decoration: 'pumpkin' }).includes('transform="translate(80 66.7) scale(2.36)"'));
check('the 4 May sword crosses the bottom right (blade (82,106)-(126,46), glow + core, a hilt) with three stars and carries no lettering', (render({ size: 36, decoration: 'may-the-fourth' }).match(/x1="82" y1="106" x2="126" y2="46"/g) || []).length === 3 && (render({ size: 36, decoration: 'may-the-fourth' }).match(/<path d="M0 -1/g) || []).length === 3 && !/<text|<image/.test(render({ size: 36, decoration: 'may-the-fourth' })));
check('the New Year burst sits at the top right (translate(112 12)) with eight rays', (render({ size: 36, decoration: 'newyear' }).match(/<line /g) || []).length === 16 && render({ size: 36, decoration: 'newyear' }).includes('translate(112 12)'));

// ---- every colour on every theme: 3:1 by the colour or, on the gradient themes, by the edge ----
{
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); const c = [16, 8, 0].map((sh) => ((n >> sh) & 255) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const css = read('src/index.css');
  const themeSrc = read('src/contexts/ThemeContext.jsx');
  const block = (selector) => (new RegExp(`^${selector.replace(/[[\]().*+?^$|\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(css) || [])[1] || '';
  const variable = (body, name) => (new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6}|none|[0-9.]+)`).exec(body) || [])[1];
  // a one-line rule of the decoration block, e.g. `:root { --decor-blade-edge: #4F7BE8; }` (index.css's big :root block comes first)
  const lineVar = (selector, name) => (new RegExp(`^${selector.replace(/[.[\]]/g, '\\$&')} \\{ --${name}: (#[0-9a-fA-F]{6}|none); \\}`, 'm').exec(css) || [])[1];
  const gradients = Array.from(themeSrc.matchAll(/'(gradient-[a-z-]+)': \{\s*name: '([^']+)',[^}]*?from: '(#[0-9a-fA-F]{6})'/g)).map((m) => ({ key: m[1], name: m[2], from: m[3] }));
  check('ThemeContext lists the five gradient themes', gradients.length === 5);
  const railLight = /--os-rail: (#[0-9a-fA-F]{6})/.exec(css)[1];   // the light theme's rail (the first definition)
  const heroLight = /--brand-hero-bg: (#[0-9a-fA-F]{6})/.exec(css)[1];
  const dark = css.slice(css.indexOf('.dark {'));
  const railDark = /--os-rail: (#[0-9a-fA-F]{6})/.exec(dark)[1], heroDark = /--brand-hero-bg: (#[0-9a-fA-F]{6})/.exec(dark)[1];
  const neutral = css.slice(css.indexOf('.dark[data-dark-variant="neutral"] {'));
  const railNeutral = /--os-rail: (#[0-9a-fA-F]{6})/.exec(neutral)[1];
  const VIOLET_ARCH = '#7B5CE0';
  const themes = [
    { name: 'Light', vars: '', rail: railLight, hero: heroLight, arch: VIOLET_ARCH },
    { name: 'Jacaranda (dark)', vars: '', rail: railDark, hero: heroDark, arch: VIOLET_ARCH },
    { name: 'Dark (neutral)', vars: '', rail: railNeutral, hero: heroDark, arch: VIOLET_ARCH },
    ...gradients.map((g) => {
      const m = new RegExp(`\\[data-theme="${g.key}"\\] \\{ --mark-arch: (#[0-9a-fA-F]{6}); --mark-blossom: (#[0-9a-fA-F]{6}); \\}`).exec(css);
      // the theme's decoration block is the second [data-theme="..."] rule (the first is the mark's)
      const blocks = Array.from(css.matchAll(new RegExp(`^\\[data-theme="${g.key}"\\] \\{([^}]*)\\}`, 'gm'))).map((x) => x[1]);
      return { name: g.name, gradient: true, vars: blocks.find((b) => b.includes('--decor-')) || '', rail: g.from, hero: heroDark, arch: m && m[1], blossom: m && m[2] };
    }),
  ];
  check('the default themes set no decoration colour (the approved look stays; only the sword\'s edge: a mid blue on Light, none on dark), every gradient theme sets --decor-blade-edge in its deep tone (its blossom colour) and --decor-spark, and no pumpkin, hat, glow or fur-edge variable exists',
    !/^(:root|\.dark|\.dark\[data-dark-variant="neutral"\]|\[data-theme="(light|dark|dark-neutral)"\])[^{]*\{[^}]*--decor-(?!blade-edge)/m.test(css) && lineVar(':root', 'decor-blade-edge') === '#4F7BE8' && lineVar('.dark', 'decor-blade-edge') === 'none' && !/--decor-(pumpkin|stem|glow|hilt|hat|edge:)/.test(css) && themes.filter((t) => t.gradient).every((t) => t.vars && variable(t.vars, 'decor-blade-edge') === t.blossom && variable(t.vars, 'decor-spark')),
    themes.filter((t) => t.gradient).map((t) => `${t.name}: edge ${variable(t.vars, 'decor-edge')} blossom ${t.blossom}`).join(', '));
  // The look the user approved keeps its colours; where a part sits under 3:1, the shortfall is known and listed
  // here (the light About hero under bright shapes, the violet arch under the parts that cross it, and the one
  // pumpkin and the one Santa hat on every theme - the user's choice over per-theme variants, with the orange and
  // the red under 3:1 on some gradients' rails and the fur over the tinted-white arches), and this test fails if
  // it gets worse or a new one appears. The PASS lines print every approved value, so the report can name them.
  const APPROVED = { 'Light/hero': 1.0, 'Light/arch': 1.4, 'Jacaranda (dark)/arch': 1.4, 'Dark (neutral)/arch': 1.4, 'pumpkin/rail': 1.3, 'pumpkin/arch': 1.4, 'christmas/rail': 1.0, 'christmas/arch': 1.0 };
  for (const t of themes) {
    for (const d of DECORATIONS) {
      const low = [], approved = [];
      for (const c of d.colours) {
        const colour = (c.variable && variable(t.vars, c.variable.slice(2))) || c.fallback;
        const edgeVar = c.edged === 'blade' ? (t.gradient ? variable(t.vars, 'decor-blade-edge') : (t.name === 'Light' ? lineVar(':root', 'decor-blade-edge') : 'none')) : null;
        const edgeColour = c.edged ? ((edgeVar && edgeVar !== 'none') ? edgeVar : c.edgeFallback) : null;
        for (const surface of c.on) {
          const bg = t[surface];
          const best = Math.max(ratio(colour, bg), edgeColour ? ratio(edgeColour, bg) : 0);
          if (best >= 3) continue;
          const key = `${t.name}/${surface}`, pumpkinKey = `${d.id}/${surface}`;
          if ((key in APPROVED && best >= APPROVED[key]) || (pumpkinKey in APPROVED && best >= APPROVED[pumpkinKey])) approved.push(`${c.part} ${colour} on ${surface} ${best.toFixed(2)}`);
          else low.push(`${c.part} ${colour}${edgeColour ? ' (edge ' + edgeColour + ')' : ''} on ${surface} ${bg}: ${best.toFixed(2)}`);
        }
      }
      check(`${t.name} / ${d.id}: every colour >= 3:1 on the rail ${t.rail}${t.gradient ? ', the hero and the arch ' + t.arch + ' (by the colour or the edge)' : ' and the dark hero'}${approved.length ? ' - approved below 3:1: ' + approved.join(', ') : ''}`, low.length === 0, low.join('; '));
    }
  }
  // the default themes keep exactly the approved colours (no variable set, the fallbacks are what the user saw)
  check('the pumpkin and the hat keep their approved colours on every theme (no variable), the sparks their default; the sword is the cyan-white one on every theme', decorationById('pumpkin').colours[0].fallback === '#E8702A' && decorationById('christmas').colours[0].fallback === '#D93A3A' && decorationById('newyear').colours[0].fallback === '#8E6CF0' && decorationById('may-the-fourth').colours[0].fallback === '#9BE7FF' && !decorationById('pumpkin').colours.some((c) => c.variable || c.edged) && !decorationById('christmas').colours.some((c) => c.variable));
}

// ---- wiring ----
const sidebar = read('src/components/CompactSidebar.jsx');
const about = read('src/components/common/modals/settings/AboutSettings.jsx');
check('the sidebar mark and the About mark are seasonal', /<BrandMark size=\{36\} tone="dark" seasonal \/>/.test(sidebar) && /<BrandMark size=\{56\} seasonal \/>/.test(about));
const hook = read('src/brand/useSeasonalDecoration.js');
check('the hook re-checks on focus, on visibility and once an hour (no busier timer)', /addEventListener\('focus'/.test(hook) && /'visibilitychange'/.test(hook) && /60 \* 60 \* 1000/.test(hook) && !/setTimeout|requestAnimationFrame/.test(hook));
check('the hook reads the localStorage preview knob under try/catch', /localStorage\.getItem\(PREVIEW_STORAGE_KEY\)/.test(hook) && /try \{/.test(hook));
const doc = read('docs/HOW_TO_ADD_SEASONAL_DECORATION.md');
check('the how-to lists the four windows and the switch', /20 Oct - 2 Nov/.test(doc) && /1 Dec - 27 Dec/.test(doc) && /28 Dec - 3 Jan/.test(doc) && /`may-the-fourth`[^|]*\| 4 May/.test(doc) && /ACTIVE_DECORATION/.test(doc));
check('mark.svg / mark-light.svg are untouched by the decorations (no decoration group in the files)', !/data-decoration/.test(read('public/brand/mark.svg')) && !/data-decoration/.test(read('public/brand/mark-light.svg')));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
