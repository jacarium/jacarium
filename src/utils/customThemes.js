/**
 * Custom colour schemes (Settings > Theme): what a theme is, how one is
 * checked, derived into the app's tokens, kept, exported and imported.
 * Pure functions, no React; the ThemeContext applies the tokens
 * (style.setProperty on <html>, validated values only) and the settings
 * panel edits them.
 *
 * A theme is a handful of colours, not the eighty-odd --os-* / --btn-* tokens
 * of src/index.css: the user picks the base (light or dark - the built-in
 * block the theme starts from: the syntax colours, the radii, the fonts,
 * the category chart colours stay the base's), the surfaces (the app
 * background, the card, the secondary card, the code background), the text
 * (primary, secondary, muted), the accent (buttons, links, the selection,
 * the rail's active entry), the border, the status colours (success,
 * warning, danger), the navigation (the rail - a solid colour or a gradient,
 * as the gradient themes paint it - the rail's text, the sidebar) and the
 * mark (the arch, the blossom, the centre). deriveTokens() makes the rest:
 * the hover and active shades, the dividers, the input surfaces, the
 * rail's hover / border / separator, the terminal pane, the chart status
 * colours, the button variants, the links, the text on the accent - each
 * one a function of those few, so a change to the accent moves everything
 * that is the accent.
 *
 * Colours: #rgb, #rrggbb, rgb() / rgba() and hsl() / hsla() are accepted
 * and stored as #rrggbb (an alpha is dropped: the tokens are opaque; the
 * selection tint is derived). Nothing else - no url(), no var(), no
 * expression(), no keyword - so a value can go into a style property
 * unescaped. A fill (the rail) is structured data: { type: 'solid', color }
 * or { type: 'linear' | 'radial', angle, stops: [{ color, at }] } with two
 * or three stops, positions 0-100, the angle 0-360; fillToCss() builds the
 * CSS from the validated parts, never from a string in a file.
 *
 * Files: a theme travels as { format: 'jacarium-theme', formatVersion: 1,
 * theme } (one theme, Settings > Theme > Export / Import), and the database
 * export carries every theme as customThemes { formatVersion: 1, themes },
 * merged on import like the custom words: by id, a newer updatedAt wins,
 * nothing is duplicated, an older export without the field imports as
 * before.
 */

export const CUSTOM_THEME_FORMAT_VERSION = 1;
export const CUSTOM_THEME_FILE_FORMAT = 'jacarium-theme';
export const CUSTOM_THEMES_STORAGE_KEY = 'jacarium-custom-themes';
export const CUSTOM_THEME_PREFIX = 'custom-';
export const CUSTOM_THEME_FILENAME_SUFFIX = '.jacarium-theme.json';
export const MAX_THEME_NAME_LENGTH = 60;
export const MAX_CUSTOM_THEMES = 50;
export const MAX_THEME_FILE_BYTES = 64 * 1024;
export const MAX_FILL_STOPS = 3;
export const MIN_FILL_STOPS = 2;

export const BASES = ['dark', 'light'];
export const LOGO_TONES = ['dark', 'light'];
export const FILL_TYPES = ['solid', 'linear', 'radial'];

/** The editable colours, in the order the editor shows them, with the group and a short hint. */
export const COLOR_FIELDS = [
  { key: 'canvas', label: 'Background', group: 'Surfaces', hint: 'the app background behind pages and panels' },
  { key: 'card', label: 'Card', group: 'Surfaces', hint: 'panels, dialogs and cards' },
  { key: 'cardSecondary', label: 'Card (secondary)', group: 'Surfaces', hint: 'table headers, inputs, hover surfaces' },
  { key: 'codeBg', label: 'Code background', group: 'Surfaces', hint: 'code blocks in the editor and the preview, the terminal pane' },
  { key: 'textPrimary', label: 'Text', group: 'Text', hint: 'headings and body text' },
  { key: 'textSecondary', label: 'Text (secondary)', group: 'Text', hint: 'labels and hints' },
  { key: 'textMuted', label: 'Text (muted)', group: 'Text', hint: 'placeholders, timestamps, counts' },
  { key: 'accent', label: 'Accent', group: 'Accent', hint: 'buttons, links, the selection and the active rail entry' },
  { key: 'border', label: 'Border', group: 'Accent', hint: 'borders and dividers' },
  { key: 'success', label: 'Success', group: 'Status', hint: 'good states and charts' },
  { key: 'warning', label: 'Warning', group: 'Status', hint: 'warnings' },
  { key: 'danger', label: 'Danger', group: 'Status', hint: 'errors and destructive actions' },
  { key: 'railText', label: 'Rail text', group: 'Navigation', hint: 'the icons of the navigation rail' },
  { key: 'sidebar', label: 'Sidebar', group: 'Navigation', hint: 'the page sidebars (documents, settings)' },
  { key: 'markArch', label: 'Logo: arch', group: 'Logo', hint: 'the arch of the mark (and its centre, unless set)' },
  { key: 'markBlossom', label: 'Logo: blossom', group: 'Logo', hint: 'the petals' },
  { key: 'markCenter', label: 'Logo: centre', group: 'Logo', hint: 'the centre dot; empty = same as the arch', optional: true },
];
export const COLOR_KEYS = COLOR_FIELDS.map((f) => f.key);
/** The fills: the rail can be a gradient, as the gradient themes paint it. */
export const FILL_FIELDS = [
  { key: 'rail', label: 'Rail', group: 'Navigation', hint: 'the navigation rail: a colour or a gradient' },
];
export const FILL_KEYS = FILL_FIELDS.map((f) => f.key);
const THEME_KEYS = ['id', 'name', 'base', 'colors', 'fills', 'logoTone', 'createdAt', 'updatedAt'];

// the two built-in bases' values (src/index.css :root and .dark), what a new theme starts from
const BASE_DEFAULTS = {
  dark: {
    canvas: '#0f0d16', card: '#17141f', cardSecondary: '#211c30', codeBg: '#141120',
    textPrimary: '#ede6ff', textSecondary: '#b9afd6', textMuted: '#8f84ad',
    accent: '#4a9eff', border: '#2a2438', success: '#3fa37a', warning: '#facc15', danger: '#f87171',
    railText: '#b9afd6', sidebar: '#15121f', markArch: '#7b5ce0', markBlossom: '#ede6ff', markCenter: null,
    rail: '#1b1530',
  },
  light: {
    canvas: '#f5f5f5', card: '#ffffff', cardSecondary: '#f0f0f0', codeBg: '#f6f8fa',
    textPrimary: '#151515', textSecondary: '#6a6e73', textMuted: '#8a8d93',
    accent: '#0066cc', border: '#d2d2d2', success: '#3e8635', warning: '#854d0e', danger: '#b91c1c',
    railText: '#9ca3af', sidebar: '#212427', markArch: '#7b5ce0', markBlossom: '#ffffff', markCenter: null,
    rail: '#1a1a1a',
  },
};

// ----------------------------------------------------------------- colours
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_RE = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*(0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/i;
const HSL_RE = /^hsla?\(\s*(\d{1,3}(?:\.\d+)?)(?:deg)?\s*[, ]\s*(\d{1,3}(?:\.\d+)?)%\s*[, ]\s*(\d{1,3}(?:\.\d+)?)%\s*(?:[,/]\s*(0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/i;

function hslToRgb(h, s, l) {
  const hh = (((h % 360) + 360) % 360) / 360;
  const ss = Math.min(1, Math.max(0, s / 100));
  const ll = Math.min(1, Math.max(0, l / 100));
  if (ss === 0) return [ll, ll, ll].map((v) => Math.round(v * 255));
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const f = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)].map((v) => Math.round(v * 255));
}

/** A colour string as { r, g, b } (0-255), or null when it is not one of the accepted forms. */
export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s.length > 48) return null;
  let m = HEX_RE.exec(s);
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  m = RGB_RE.exec(s);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if ([r, g, b].some((v) => v > 255)) return null;
    return { r, g, b };
  }
  m = HSL_RE.exec(s);
  if (m) {
    const [h, sat, l] = [m[1], m[2], m[3]].map(Number);
    if (sat > 100 || l > 100 || h > 360) return null;
    const [r, g, b] = hslToRgb(h, sat, l);
    return { r, g, b };
  }
  return null;
}

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
/** { r, g, b } as '#rrggbb'. */
export function toHex({ r, g, b }) { return `#${hex2(r)}${hex2(g)}${hex2(b)}`; }
/** An accepted colour string as '#rrggbb' (lower case), or null. */
export function normalizeColor(value) { const c = parseColor(value); return c ? toHex(c) : null; }
export function isColor(value) { return parseColor(value) !== null; }

function channel(v) { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
/** WCAG relative luminance of a colour string (0 for an invalid one). */
export function luminance(value) { const c = parseColor(value); if (!c) return 0; return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b); }
/** WCAG contrast ratio of two colour strings (1 when either is invalid). */
export function contrastRatio(a, b) {
  if (!parseColor(a) || !parseColor(b)) return 1;
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
/** `t` of the way from colour a to colour b (0..1), as hex. */
export function mix(a, b, t) {
  const ca = parseColor(a), cb = parseColor(b);
  if (!ca || !cb) return normalizeColor(a) || '#000000';
  const k = Math.max(0, Math.min(1, t));
  return toHex({ r: ca.r + (cb.r - ca.r) * k, g: ca.g + (cb.g - ca.g) * k, b: ca.b + (cb.b - ca.b) * k });
}
export function lighten(value, t) { return mix(value, '#ffffff', t); }
export function darken(value, t) { return mix(value, '#000000', t); }
export function isDarkColor(value) { return luminance(value) < 0.3; }
/** White or near-black, whichever reads better on the colour (text on a button). */
export function onColor(value) { return contrastRatio(value, '#ffffff') >= contrastRatio(value, '#151515') ? '#ffffff' : '#151515'; }
/** The colour moved towards black (or white) until the text colour reads on it at the ratio. */
export function ensureContrast(value, text, ratio = 4.5, towards = '#000000') {
  let c = normalizeColor(value) || '#000000';
  for (let i = 0; i < 20 && contrastRatio(c, text) < ratio; i++) c = mix(c, towards, 0.08);
  return c;
}
/** An rgba() tint of a colour (the selection highlight). */
export function rgba(value, alpha) { const c = parseColor(value) || { r: 0, g: 0, b: 0 }; return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.max(0, Math.min(1, alpha))})`; }

// ------------------------------------------------------------------- fills
/** A validated fill from untrusted data: { ok, fill, error }. A string is a solid colour. */
export function validateFill(input) {
  if (typeof input === 'string') {
    const color = normalizeColor(input);
    return color ? { ok: true, fill: { type: 'solid', color } } : { ok: false, error: `not a colour: ${String(input).slice(0, 40)}` };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'a fill is a colour or { type, stops }' };
  const type = input.type;
  if (!FILL_TYPES.includes(type)) return { ok: false, error: `unknown fill type: ${String(type).slice(0, 20)}` };
  const extra = Object.keys(input).filter((k) => !['type', 'color', 'angle', 'stops'].includes(k));
  if (extra.length) return { ok: false, error: `unknown fill keys: ${extra.slice(0, 5).join(', ')}` };
  if (type === 'solid') {
    const color = normalizeColor(input.color);
    return color ? { ok: true, fill: { type: 'solid', color } } : { ok: false, error: 'a solid fill needs a colour' };
  }
  const stops = input.stops;
  if (!Array.isArray(stops) || stops.length < MIN_FILL_STOPS || stops.length > MAX_FILL_STOPS) return { ok: false, error: `a gradient has ${MIN_FILL_STOPS} to ${MAX_FILL_STOPS} stops` };
  const out = [];
  for (const s of stops) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: 'a stop is { color, at }' };
    const keys = Object.keys(s).filter((k) => !['color', 'at'].includes(k));
    if (keys.length) return { ok: false, error: `unknown stop keys: ${keys.slice(0, 5).join(', ')}` };
    const color = normalizeColor(s.color);
    if (!color) return { ok: false, error: `a stop is not a colour: ${String(s.color).slice(0, 40)}` };
    const at = s.at === undefined ? null : Number(s.at);
    if (at !== null && (!Number.isFinite(at) || at < 0 || at > 100)) return { ok: false, error: 'a stop position is 0 to 100' };
    out.push({ color, at });
  }
  // missing positions spread evenly; the positions must not go backwards
  out.forEach((s, i) => { if (s.at === null) s.at = Math.round((100 * i) / (out.length - 1)); else s.at = Math.round(s.at); });
  for (let i = 1; i < out.length; i++) if (out[i].at < out[i - 1].at) return { ok: false, error: 'the stop positions must not go backwards' };
  const fill = { type, stops: out };
  if (type === 'linear') {
    const angle = input.angle === undefined ? 180 : Number(input.angle);
    if (!Number.isFinite(angle) || angle < 0 || angle > 360) return { ok: false, error: 'the angle is 0 to 360' };
    fill.angle = Math.round(angle);
  } else if (input.angle !== undefined) {
    return { ok: false, error: 'a radial gradient has no angle' };
  }
  return { ok: true, fill };
}

/** The CSS background for a validated fill, built from its parts (a solid colour as its hex). */
export function fillToCss(fill) {
  const v = validateFill(fill);
  if (!v.ok) return null;
  const f = v.fill;
  if (f.type === 'solid') return f.color;
  const stops = f.stops.map((s) => `${s.color} ${s.at}%`).join(', ');
  return f.type === 'linear' ? `linear-gradient(${f.angle}deg, ${stops})` : `radial-gradient(circle at 50% 0%, ${stops})`;
}
/** Every colour a fill shows (one for a solid, the stops of a gradient), for the contrast checks. */
export function fillColors(fill) {
  const v = validateFill(fill);
  if (!v.ok) return [];
  return v.fill.type === 'solid' ? [v.fill.color] : v.fill.stops.map((s) => s.color);
}
/** The first colour of a fill: what a background-color consumer of the token shows. */
export function fillBaseColor(fill) { return fillColors(fill)[0] || null; }

// ------------------------------------------------------------------- themes
export function newThemeId() {
  const rnd = () => Math.random().toString(16).slice(2, 10);
  const uuid = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${rnd()}-${rnd()}-${rnd()}`;
  return `ct-${uuid}`;
}
const ID_RE = /^ct-[0-9a-z-]{8,48}$/;
export function isCustomThemeId(value) { return typeof value === 'string' && ID_RE.test(value); }
/** The Color Scheme value of a theme ('custom-<id>'), and back. */
export function themeSchemeId(theme) { return CUSTOM_THEME_PREFIX + theme.id; }
export function schemeThemeId(scheme) { return typeof scheme === 'string' && scheme.startsWith(CUSTOM_THEME_PREFIX) ? scheme.slice(CUSTOM_THEME_PREFIX.length) : null; }

function nowIso() { return new Date().toISOString(); }
function normalizeTime(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.length <= 40) { const t = Date.parse(value); if (Number.isFinite(t)) return new Date(t).toISOString(); }
  return fallback;
}
// eslint-disable-next-line no-control-regex
const NAME_BAD_RE = /[\u0000-\u001f\u007f]/;
/** A theme name trimmed to the rules, or null when it is not usable. */
export function normalizeThemeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_THEME_NAME_LENGTH || NAME_BAD_RE.test(name)) return null;
  return name;
}

/** A new theme from one of the built-in bases (what "New theme" starts with). */
export function defaultTheme(base = 'dark', name = 'My theme') {
  const b = BASES.includes(base) ? base : 'dark';
  const d = BASE_DEFAULTS[b];
  const colors = {};
  for (const k of COLOR_KEYS) colors[k] = d[k] ?? null;
  const t = nowIso();
  return { id: newThemeId(), name, base: b, colors, fills: { rail: { type: 'solid', color: d.rail } }, logoTone: 'dark', createdAt: t, updatedAt: t };
}

/**
 * A theme from untrusted data (a file, an export, storage): { ok, theme, errors }. Strict: known keys only,
 * every colour one of the accepted forms, the fills structured, the name within its limit. `theme` is a fresh,
 * normalized copy (colours as #rrggbb, times as ISO) and never the input.
 */
export function validateCustomTheme(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['a theme is an object'] };
  const unknown = Object.keys(input).filter((k) => !THEME_KEYS.includes(k));
  if (unknown.length) errors.push(`unknown keys: ${unknown.slice(0, 8).map((k) => String(k).slice(0, 30)).join(', ')}`);
  const name = normalizeThemeName(input.name);
  if (!name) errors.push(`the name is 1 to ${MAX_THEME_NAME_LENGTH} characters`);
  const base = input.base;
  if (!BASES.includes(base)) errors.push("the base is 'dark' or 'light'");
  const id = isCustomThemeId(input.id) ? input.id : null;
  if (input.id !== undefined && !id) errors.push('the id is not a theme id');
  const colors = {};
  if (!input.colors || typeof input.colors !== 'object' || Array.isArray(input.colors)) {
    errors.push('colors is an object');
  } else {
    const bad = Object.keys(input.colors).filter((k) => !COLOR_KEYS.includes(k));
    if (bad.length) errors.push(`unknown colours: ${bad.slice(0, 8).map((k) => String(k).slice(0, 30)).join(', ')}`);
    for (const f of COLOR_FIELDS) {
      const raw = input.colors[f.key];
      if (raw === undefined || raw === null || raw === '') {
        if (f.optional) colors[f.key] = null;
        else errors.push(`${f.label} is missing`);
        continue;
      }
      const c = normalizeColor(raw);
      if (!c) errors.push(`${f.label}: not a colour (${String(raw).slice(0, 40)})`);
      else colors[f.key] = c;
    }
  }
  const fills = {};
  if (input.fills !== undefined) {
    if (!input.fills || typeof input.fills !== 'object' || Array.isArray(input.fills)) {
      errors.push('fills is an object');
    } else {
      const bad = Object.keys(input.fills).filter((k) => !FILL_KEYS.includes(k));
      if (bad.length) errors.push(`unknown fills: ${bad.slice(0, 8).map((k) => String(k).slice(0, 30)).join(', ')}`);
      for (const f of FILL_FIELDS) {
        if (input.fills[f.key] === undefined) continue;
        const v = validateFill(input.fills[f.key]);
        if (!v.ok) errors.push(`${f.label}: ${v.error}`);
        else fills[f.key] = v.fill;
      }
    }
  }
  for (const f of FILL_FIELDS) if (!fills[f.key]) fills[f.key] = { type: 'solid', color: BASE_DEFAULTS[BASES.includes(base) ? base : 'dark'][f.key] };
  const logoTone = input.logoTone === undefined ? 'dark' : input.logoTone;
  if (!LOGO_TONES.includes(logoTone)) errors.push("logoTone is 'dark' or 'light'");
  if (errors.length) return { ok: false, errors };
  const createdAt = normalizeTime(input.createdAt, nowIso());
  const updatedAt = normalizeTime(input.updatedAt, createdAt);
  return { ok: true, errors: [], theme: { id: id || newThemeId(), name, base, colors, fills, logoTone, createdAt, updatedAt } };
}

/** The tokens a theme sets on <html>: { '--os-canvas': '#...', ... }, every value built from validated colours. */
export function deriveTokens(theme) {
  const v = validateCustomTheme(theme);
  if (!v.ok) return {};
  const t = v.theme;
  const c = t.colors;
  const dark = t.base === 'dark';
  const accentHover = dark ? lighten(c.accent, 0.15) : darken(c.accent, 0.18);
  const accentActive = dark ? lighten(c.accent, 0.3) : darken(c.accent, 0.3);
  const accentFg = onColor(c.accent);
  const rail = fillBaseColor(t.fills.rail) || c.sidebar;
  const railCss = fillToCss(t.fills.rail) || rail;
  const railDark = isDarkColor(rail);
  const tooltipBg = railDark ? darken(rail, 0.2) : darken(rail, 0.6);   // the rail's tooltip, and its text in whichever of black / white reads on it
  // the status families (notes, badges, banners, status lines): the theme's own status colour as text, a tint of it
  // over the card as background, the colour at 40 % as border - the accent stands in for the info and brand roles
  const family = (name, col) => ({ [`--status-${name}-fg`]: col, [`--status-${name}-bg`]: rgba(col, dark ? 0.2 : 0.12), [`--status-${name}-border`]: rgba(col, 0.4) });
  const out = {
    '--os-canvas': c.canvas, '--os-card': c.card, '--os-card-secondary': c.cardSecondary, '--os-modal': c.card,
    '--os-masthead': dark ? darken(c.sidebar, 0.25) : darken(c.sidebar, 0.1),
    '--os-sidebar': c.sidebar, '--os-sidebar-hover': isDarkColor(c.sidebar) ? lighten(c.sidebar, 0.08) : darken(c.sidebar, 0.06),
    '--os-blue': c.accent, '--os-blue-hover': accentHover,
    '--os-border': c.border, '--os-divider': mix(c.border, c.canvas, 0.5),
    '--os-input-bg': dark ? c.cardSecondary : c.card, '--os-input-border': c.border,
    '--os-text-primary': c.textPrimary, '--os-text-secondary': c.textSecondary, '--os-text-muted': c.textMuted,
    '--os-status-success': c.success, '--os-code-bg': c.codeBg,
    '--os-rail': rail, '--os-rail-fill': railCss,
    '--os-rail-border': mix(rail, c.railText, 0.15), '--os-rail-hover': mix(rail, c.railText, 0.12), '--os-rail-active': c.accent,
    '--os-rail-text': c.railText, '--os-rail-text-active': accentFg, '--rail-badge': railBadge(c.accent, t.fills.rail), '--os-rail-tooltip': tooltipBg, '--os-rail-tooltip-text': onColor(tooltipBg), '--os-rail-separator': mix(rail, c.railText, 0.25),
    '--os-terminal-bg': c.codeBg, '--os-terminal-text': c.textPrimary, '--os-terminal-muted': c.textMuted, '--os-terminal-border': c.border,
    '--os-terminal-success': c.success, '--os-terminal-warning': c.warning, '--os-terminal-error': c.danger, '--os-terminal-selection': rgba(c.accent, dark ? 0.35 : 0.22),
    '--chart-ok': c.accent, '--chart-info': c.accent, '--chart-good': c.success, '--chart-warn': c.warning, '--chart-bad': c.danger, '--chart-muted': c.textMuted,
    ...family('info', c.accent), ...family('success', c.success), ...family('warning', c.warning), ...family('danger', c.danger), ...family('brand', c.accent),
    // the categorical set of the charts, legends and collaborator colours: the stock set of the theme's base (src/index.css :root / .dark)
    ...Object.fromEntries((dark ? ['#60a5fa', '#a78bfa', '#2dd4bf', '#fbbf24', '#f472b6', '#4ade80', '#fb923c', '#94a3b8'] : ['#2563eb', '#7c3aed', '#0d9488', '#d97706', '#db2777', '#16a34a', '#ea580c', '#64748b']).map((col, i) => [`--chart-cat-${i + 1}`, col])),
    '--link': dark ? accentHover : c.accent, '--link-hover': dark ? lighten(c.accent, 0.3) : accentHover,
    '--btn-primary-bg': c.accent, '--btn-primary-bg-hover': accentHover, '--btn-primary-bg-active': accentActive, '--btn-primary-fg': accentFg,
    '--btn-selected-bg': c.accent, '--btn-selected-fg': accentFg, '--btn-selected-bg-hover': accentHover, '--btn-selected-text': dark ? accentHover : darken(c.accent, 0.25),
    '--btn-quiet-fg': dark ? accentHover : darken(c.accent, 0.2),
    '--btn-success-bg': ensureContrast(c.success, '#ffffff', 4.5), '--btn-success-bg-hover': ensureContrast(darken(c.success, 0.12), '#ffffff', 4.5), '--btn-success-bg-active': ensureContrast(darken(c.success, 0.24), '#ffffff', 4.5),
    '--btn-warning-bg': ensureContrast(c.warning, '#ffffff', 4.5), '--btn-warning-bg-hover': ensureContrast(darken(c.warning, 0.12), '#ffffff', 4.5), '--btn-warning-bg-active': ensureContrast(darken(c.warning, 0.24), '#ffffff', 4.5),
    '--btn-danger-solid-bg': ensureContrast(c.danger, '#ffffff', 4.5), '--btn-danger-solid-bg-hover': ensureContrast(darken(c.danger, 0.12), '#ffffff', 4.5), '--btn-danger-solid-bg-active': ensureContrast(darken(c.danger, 0.24), '#ffffff', 4.5),
    '--btn-danger-fg': dark ? c.danger : ensureContrast(c.danger, '#ffffff', 4.5), '--btn-danger-border': c.danger,
    '--btn-success-text': dark ? c.success : ensureContrast(c.success, '#ffffff', 4.5), '--btn-warning-text': dark ? c.warning : ensureContrast(c.warning, '#ffffff', 4.5),
    '--mark-arch': c.markArch, '--mark-blossom': c.markBlossom, '--mark-center': c.markCenter || c.markArch, '--brand-blossom': c.markBlossom,
    // the Documents preview (src/index.css .markdown-preview): headings and text in the text colour, the code text
    // nudged until it reads on the code background, links as the app's; the syntax colours (--os-code-*) stay the
    // base's palette - a theme chooses its surfaces and text, the highlighter keeps its own tones
    '--md-text': c.textPrimary, '--md-heading': c.textPrimary, '--md-heading-border': c.border,
    '--md-code-text': codeText(c), '--md-code-bg': c.codeBg, '--md-inline-code-bg': rgba(c.textMuted, 0.25),
    '--md-link': dark ? accentHover : c.accent, '--md-quote-text': c.textSecondary, '--md-border': c.border,
    '--md-surface': c.card, '--md-surface-alt': c.cardSecondary,
    // the AI chat bubbles: the user's on the accent in the on-accent colour (the bubble darkened or lightened until the
    // pair reads), the reply's links nudged until they read on the secondary card
    '--chat-user-bg': ensureContrast(c.accent, accentFg, 4.5, accentFg === '#ffffff' ? '#000000' : '#ffffff'), '--chat-user-text': accentFg,
    '--chat-user-tint': accentFg === '#ffffff' ? 'rgba(0, 0, 0, 0.22)' : 'rgba(255, 255, 255, 0.35)', '--chat-user-line': rgba(accentFg, 0.5),
    '--chat-link': ensureContrast(dark ? accentHover : c.accent, c.cardSecondary, 4.5, dark ? '#ffffff' : '#000000'),
    // the brand hero (the sign-in page): the theme's card and text
    '--brand-hero-bg': c.card, '--brand-hero-text': c.textPrimary, '--brand-hero-muted': c.textSecondary,
    // the seasonal decorations: the dark themes' variant unless the theme asks for the light one
    '--decor-blade-edge': t.logoTone === 'light' ? '#4f7be8' : 'none',
  };
  return out;
}

/**
 * The unread dot on the rail (--rail-badge): the accent, nudged towards white (a dark rail) or black until it
 * reaches 3:1 against every stop of the rail fill - as the rail's icons must (WCAG 1.4.11).
 */
export function railBadge(accent, railFill) {
  const stops = fillColors(railFill);
  if (!stops.length) return normalizeColor(accent) || accent;
  const dark = stops.every((stop) => isDarkColor(stop));
  let c = normalizeColor(accent) || '#a855f7';
  for (let i = 0; i < 20 && stops.some((stop) => contrastRatio(c, stop) < 3); i++) c = mix(c, dark ? '#ffffff' : '#000000', 0.08);
  return c;
}

/** The code text: the text colour, nudged towards white or black until it reads (4.5:1) on the code background. */
export function codeText(c) {
  return ensureContrast(c.textPrimary, c.codeBg, 4.5, isDarkColor(c.codeBg) ? '#ffffff' : '#000000');
}

/** The pairs a theme's readability rests on: [{ what, text, on, ratio, min }], every one below its minimum first. */
export function contrastWarnings(theme) {
  const v = validateCustomTheme(theme);
  if (!v.ok) return [];
  const t = v.theme;
  const c = t.colors;
  const pairs = [
    ['Text and headings on the background', c.textPrimary, c.canvas, 4.5], ['Text on a card', c.textPrimary, c.card, 4.5], ['Text on a secondary card', c.textPrimary, c.cardSecondary, 4.5],
    ['Secondary text on a card', c.textSecondary, c.card, 4.5], ['Muted text on a card', c.textMuted, c.card, 3],
    ['Text on the code background', c.textPrimary, c.codeBg, 4.5], ['Code text on the code background (as derived)', codeText(c), c.codeBg, 4.5],
    ['The accent on a card', c.accent, c.card, 3], ['Text on the accent (buttons)', onColor(c.accent), c.accent, 4.5],
    ['Success on a card', c.success, c.card, 3], ['Warning on a card', c.warning, c.card, 3], ['Danger on a card', c.danger, c.card, 3],
    ['The blossom on the arch', c.markBlossom, c.markArch, 3],
  ];
  fillColors(t.fills.rail).forEach((stop, i, all) => {
    const where = all.length > 1 ? ` (stop ${i + 1})` : '';
    pairs.push([`Rail icons on the rail${where}`, c.railText, stop, 3]);   // the rail shows icons: 3:1 (WCAG 1.4.11)
    pairs.push([`The logo's arch on the rail${where}`, c.markArch, stop, 3]);
  });
  const out = pairs.map(([what, text, on, min]) => ({ what, text, on, min, ratio: Math.round(contrastRatio(text, on) * 100) / 100 }));
  return out.sort((a, b) => (a.ratio < a.min ? 0 : 1) - (b.ratio < b.min ? 0 : 1) || a.ratio - b.ratio);
}

// ------------------------------------------------------------- the file
/** The single-theme file object. */
export function themeFileObject(theme) {
  const v = validateCustomTheme(theme);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return { format: CUSTOM_THEME_FILE_FORMAT, formatVersion: CUSTOM_THEME_FORMAT_VERSION, exportedAt: nowIso(), theme: v.theme };
}
/** A file name for a theme's export. */
export function themeFileName(theme) {
  const slug = String(theme?.name || 'theme').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'theme';
  return `${slug}${CUSTOM_THEME_FILENAME_SUFFIX}`;
}
/**
 * A theme from a file's text (or an already parsed object): { ok, theme, errors }. The size limit first, then the
 * format and version, then the theme itself (validateCustomTheme); nothing of the file reaches a style.
 */
export function readThemeFile(input, { maxBytes = MAX_THEME_FILE_BYTES } = {}) {
  let obj = input;
  if (typeof input === 'string') {
    if (input.length > maxBytes) return { ok: false, errors: [`the file is larger than ${Math.round(maxBytes / 1024)} KB`] };
    try { obj = JSON.parse(input); } catch { return { ok: false, errors: ['not JSON'] }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['not a theme file'] };
  if (obj.format !== CUSTOM_THEME_FILE_FORMAT) return { ok: false, errors: [`not a Jacarium theme file (format ${String(obj.format).slice(0, 30)})`] };
  if (typeof obj.formatVersion !== 'number' || obj.formatVersion > CUSTOM_THEME_FORMAT_VERSION) return { ok: false, errors: [`theme format ${String(obj.formatVersion).slice(0, 10)} is newer than this app understands (${CUSTOM_THEME_FORMAT_VERSION})`] };
  const unknown = Object.keys(obj).filter((k) => !['format', 'formatVersion', 'exportedAt', 'theme'].includes(k));
  if (unknown.length) return { ok: false, errors: [`unknown keys in the file: ${unknown.slice(0, 5).map((k) => String(k).slice(0, 30)).join(', ')}`] };
  return validateCustomTheme(obj.theme);
}
/**
 * The themes an Import JSON input carries, as untrusted data: a theme file ({ format, formatVersion, theme }), a
 * bare theme, an array of either, or a database export (its customThemes section). Returns { themes, errors }:
 * the valid themes (normalized copies) and one message per refused entry ("entry 2: Accent: not a colour ...").
 * `maxBytes` applies when `input` is text.
 */
export function readThemeImport(input, { maxBytes = MAX_THEME_FILE_BYTES } = {}) {
  let obj = input;
  if (typeof input === 'string') {
    if (input.length > maxBytes) return { themes: [], errors: [`the input is larger than ${Math.round(maxBytes / 1024)} KB`] };
    try { obj = JSON.parse(input); } catch { return { themes: [], errors: ['not JSON'] }; }
  }
  if (!obj || typeof obj !== 'object') return { themes: [], errors: ['not a theme file'] };
  let entries;
  if (Array.isArray(obj)) entries = obj;
  else if (obj.format === CUSTOM_THEME_FILE_FORMAT || 'theme' in obj) entries = [obj];
  else if (obj.customThemes !== undefined) entries = readCustomThemesSection(obj) || [];
  else if ('colors' in obj) entries = [obj];
  else return { themes: [], errors: ['not a theme file (no format, theme, customThemes or colors)'] };
  if (entries.length > MAX_CUSTOM_THEMES) return { themes: [], errors: [`more than ${MAX_CUSTOM_THEMES} themes in one file`] };
  const themes = [], errors = [];
  entries.forEach((entry, i) => {
    const label = entries.length > 1 ? `entry ${i + 1}: ` : '';
    const r = entry && typeof entry === 'object' && !Array.isArray(entry) && (entry.format !== undefined || entry.formatVersion !== undefined || entry.theme !== undefined) ? readThemeFile(entry) : validateCustomTheme(entry);
    if (r.ok) themes.push(r.theme);
    else errors.push(label + r.errors.join('; '));
  });
  return { themes, errors };
}

/**
 * What importing `themes` beside `existing` would do (Settings > Theme > Import JSON): every one is added under
 * its own id, renamed "(imported)" on a name clash - [{ name, finalName, renamed }], and the list capped.
 */
export function planThemeImport(themes, existing) {
  const taken = (existing || []).map((t) => ({ name: t.name }));
  const plan = [];
  let room = MAX_CUSTOM_THEMES - (existing || []).length;
  for (const t of themes) {
    if (room <= 0) { plan.push({ name: t.name, finalName: null, renamed: false, skipped: 'the list of custom themes is full' }); continue; }
    const finalName = uniqueThemeName(t.name, taken);
    plan.push({ name: t.name, finalName, renamed: finalName !== t.name });
    taken.push({ name: finalName });
    room -= 1;
  }
  return plan;
}

/** `name`, or "name (imported)", "name (imported 2)" ... until it is unique among `existing`. */
export function uniqueThemeName(name, existing, suffix = 'imported') {
  const taken = new Set((existing || []).map((t) => String(t.name).toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const room = (extra) => name.slice(0, MAX_THEME_NAME_LENGTH - extra.length) + extra;
  let candidate = room(` (${suffix})`);
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = room(` (${suffix} ${n})`);
  return candidate;
}

// ------------------------------------------------- the database export
/** The export's customThemes section: { formatVersion: 1, themes } with valid themes only. */
export function customThemesExportSection(themes) {
  const valid = [];
  for (const t of themes || []) { const v = validateCustomTheme(t); if (v.ok) valid.push(v.theme); }
  return { formatVersion: CUSTOM_THEME_FORMAT_VERSION, themes: valid };
}
/** The candidates of an export's customThemes section (the versioned object, or leniently a bare array), or null for a file without it. */
export function readCustomThemesSection(importData) {
  const section = importData && typeof importData === 'object' ? importData.customThemes : undefined;
  if (section === undefined || section === null) return null;
  if (Array.isArray(section)) return section;
  if (typeof section === 'object' && Array.isArray(section.themes)) return section.themes;
  return [];
}
/**
 * Candidates merged into the existing list: by id - a candidate with a newer updatedAt replaces its namesake, an
 * older or equal one is skipped, an unknown id is added (under a unique name) - never a duplicate, invalid ones
 * counted. Returns { themes, created, updated, skipped, invalid } with the new list (the input untouched).
 */
export function mergeCustomThemes(candidates, existing) {
  const themes = (existing || []).map((t) => ({ ...t }));
  const result = { themes, created: 0, updated: 0, skipped: 0, invalid: 0 };
  for (const raw of candidates || []) {
    const v = validateCustomTheme(raw);
    if (!v.ok) { result.invalid += 1; continue; }
    const t = v.theme;
    const i = themes.findIndex((x) => x.id === t.id);
    if (i >= 0) {
      if (Date.parse(t.updatedAt) > Date.parse(themes[i].updatedAt)) { themes[i] = t; result.updated += 1; } else result.skipped += 1;
      continue;
    }
    if (themes.length >= MAX_CUSTOM_THEMES) { result.skipped += 1; continue; }
    themes.push({ ...t, name: uniqueThemeName(t.name, themes) });
    result.created += 1;
  }
  return result;
}

// ------------------------------------------------------------- storage
/** The themes in storage (localStorage by default), valid ones only; [] when there are none or storage is unavailable. */
export function loadCustomThemes(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  try {
    const raw = storage && storage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const t of list) { const v = validateCustomTheme(t); if (v.ok) out.push(v.theme); }
    return out.slice(0, MAX_CUSTOM_THEMES);
  } catch {
    return [];
  }
}
export function saveCustomThemes(themes, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  try {
    if (!storage) return false;
    storage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(customThemesExportSection(themes).themes));
    return true;
  } catch {
    return false;
  }
}
