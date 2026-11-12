/**
 * Colours that come from data rather than the theme - a collaborator's
 * colour, a calendar's, a Kanban column's, a workflow note's or edge's -
 * painted so that a colour-vision palette or high contrast (Settings >
 * Accessibility) shows them mapped onto the palette's categorical set,
 * while the stored value never changes (exports, sync and other users see
 * the original). Display only, and live: the mapping is a stylesheet rule.
 *
 * paint(stored, ...props) gives a style object for the element: the
 * properties named (backgroundColor, color, borderLeftColor, stroke, ...)
 * read `var(--dc)`, which is the stored colour by default; the element
 * also carries `--dc-cat`, the categorical colour the stored one maps to
 * (--chart-cat-1..8, the nearest by hue among the default set, so the same
 * stored colour always lands on the same category and distinct hues stay
 * distinct where eight buckets allow; greys and muted colours, HSL
 * saturation under 0.25, land on the grey). Under
 * html.ra-cv-* or html.ra-high-contrast the stylesheet makes `--dc` the
 * category colour instead (src/index.css, `[style*="--dc-cat"]`), and
 * since the palettes redefine --chart-cat-N, the colour is the palette's.
 * At the default nothing changes: `--dc` is the stored colour. Text on
 * the colour reads `var(--dc-ink)` (INK): black or white for the stored
 * colour, recomputed by the stylesheet for the palette's colour.
 */
import { parseColor } from './customThemes.js';

/** The default categorical set (src/index.css --chart-cat-1..8): the buckets a data colour maps to. */
export const DATA_CATEGORIES = Object.freeze([
  { n: 1, hex: '#2563eb' }, { n: 2, hex: '#7c3aed' }, { n: 3, hex: '#0d9488' }, { n: 4, hex: '#d97706' },
  { n: 5, hex: '#db2777' }, { n: 6, hex: '#16a34a' }, { n: 7, hex: '#ea580c' }, { n: 8, hex: '#64748b' },
]);

function hsl(c) {
  const r = c.r / 255; const g = c.g / 255; const b = c.b / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s, l };
}
const CATEGORY_HUES = DATA_CATEGORIES.map((c) => ({ n: c.n, ...hsl(parseColor(c.hex)) }));

/** The category (1..8) a stored colour maps to; 8 (the grey) for a colour with no hue, or one that cannot be read. */
export function dataCategory(stored) {
  const c = typeof stored === 'string' ? parseColor(stored.trim()) : null;
  if (!c) return 8;
  const { h, s } = hsl(c);
  if (s < 0.25) return 8;
  let best = 8; let bestDist = Infinity;
  for (const cat of CATEGORY_HUES) {
    if (cat.n === 8) continue;
    const dist = Math.min(Math.abs(cat.h - h), 360 - Math.abs(cat.h - h));
    if (dist < bestDist) { bestDist = dist; best = cat.n; }
  }
  return best;
}

/** Black or white text for a data colour: BT.709 luminance above 0.5 takes black (the calendars' rule). */
export function ink(stored) {
  const c = typeof stored === 'string' ? parseColor(stored.trim()) : null;
  if (!c) return '#ffffff';
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 > 0.5 ? '#000000' : '#ffffff';
}

/** The text colour on an element painted with paint(): its ink, which a palette recomputes for the palette's colour. */
export const INK = 'var(--dc-ink)';

/**
 * The style for an element painted with a data colour: `props` are the CSS properties (camelCase) that take it.
 * Spread or Object.assign it into the element's style; nothing else is needed.
 */
export function paint(stored, ...props) {
  const value = typeof stored === 'string' && stored ? stored : 'transparent';
  const style = { '--dc-stored': value, '--dc-cat': `var(--chart-cat-${dataCategory(value)})`, '--dc': 'var(--dc-stored)', '--dc-ink': ink(value) };
  for (const p of props) style[p] = 'var(--dc)';
  return style;
}
