/**
 * One colour toolkit for the tests: every CSS colour a browser can report
 * (rgb / rgba, hex, oklch / oklab, color(srgb ...), color-mix results,
 * transparent) resolved to sRGB, plus WCAG luminance and contrast.
 *
 * Tailwind 4 and the theme tokens write colours in oklch(), and Chrome's
 * getComputedStyle() reports such a colour in the syntax it was given
 * (oklch(...), oklab(...), color(srgb ...)), not as rgb(). A contrast check
 * that only knows rgb() then crashes or silently skips, so no test parses
 * colours on its own any more: in the page it uses COLOR_PROBE (the browser
 * paints the colour on a canvas and reads the pixel back, which handles every
 * syntax), on the Node side parseCssColor (the same spaces converted by hand).
 *
 * In-page (evaluate COLOR_PROBE once, then window.__color):
 *   parse(css)         -> [r, g, b, a] (0-255, a 0-1) or null when unparseable or fully transparent
 *   lum([r, g, b])     -> relative luminance (WCAG 2)
 *   contrast(a, b)     -> the contrast ratio of two opaque colours (unrounded)
 *   over(top, bottom)  -> top composited over bottom (alpha folded in)
 *   effectiveBg(el)    -> the surface under an element: its ancestors' backgrounds composited, white at the root
 *   measure(el, color?, pseudo?) -> { color: [r, g, b], bg: [r, g, b], ratio } of the element's text against its surface
 *   ratioOf(fgCss, bgCss, surfaceCss?) -> the ratio of two colour strings (the fg composited over bg over an opaque surface)
 *
 * Node side: parseCssColor(css) -> [r, g, b, a] or null, luminance, contrast, over, same(cssA, cssB, tolerance).
 */

// The in-page toolkit as source text: tests splice it into their own probe
// (a template string evaluated in the page), so it must not rely on module
// scope. It installs window.__color once and returns it.
export const COLOR_PROBE = `(() => {
  if (window.__color) return window.__color;
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const parse = (s) => {
    if (!s || s === 'transparent' || s === 'none') return null;
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#010203'; ctx.fillStyle = String(s);
    if (ctx.fillStyle === '#010203' && !/^#?0*10203$/i.test(String(s).replace(/\\s/g, ''))) return null;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return d[3] === 0 ? null : [d[0], d[1], d[2], d[3] / 255];
  };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const over = (top, bottom) => { const a = top[3] === undefined ? 1 : top[3]; return [0, 1, 2].map((i) => Math.round(top[i] * a + bottom[i] * (1 - a))).concat([1]); };
  const effectiveBg = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c) { layers.push(c); if (c[3] >= 1) break; } }
    let bg = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const measure = (el, color, pseudo) => {
    const fg = color || parse(getComputedStyle(el, pseudo || null).color) || [0, 0, 0, 1];
    const bg = effectiveBg(el);
    return { color: fg.slice(0, 3), bg: bg.slice(0, 3), ratio: Number(contrast(over(fg, bg), bg).toFixed(2)) };
  };
  const ratioOf = (fgCss, bgCss, surfaceCss) => {
    const surface = parse(surfaceCss) || [255, 255, 255, 1];
    const bg = bgCss ? over(parse(bgCss) || [0, 0, 0, 0], surface) : surface;
    const fg = parse(fgCss); if (!fg) return null;
    return Number(contrast(over(fg, bg), bg).toFixed(2));
  };
  window.__color = { parse, lum, contrast, over, effectiveBg, measure, ratioOf };
  return window.__color;
})()`;

// ---------------------------------------------------------------------------
// Node side
// ---------------------------------------------------------------------------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const gamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const to255 = (v) => Math.round(clamp01(v) * 255);

// OKLab -> sRGB (Björn Ottosson's matrices)
function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [to255(gamma(R)), to255(gamma(G)), to255(gamma(B))];
}

const num = (t, scale = 1) => {
  if (t === undefined || t === 'none') return 0;
  if (/%$/.test(t)) return (parseFloat(t) / 100) * scale;
  return parseFloat(t);
};
const alphaOf = (t) => (t === undefined ? 1 : /%$/.test(t) ? parseFloat(t) / 100 : parseFloat(t));
const args = (inner) => inner.replace(/\//g, ' / ').split(/[\s,]+/).filter(Boolean);

/**
 * A CSS colour string -> [r, g, b, a] (0-255, a 0-1), or null for an
 * unparseable value. Handles rgb()/rgba() (comma and space syntax, percentages),
 * #rgb / #rgba / #rrggbb / #rrggbbaa, oklch(), oklab(), color(srgb ...),
 * hsl()/hsla() and 'transparent' (-> [0, 0, 0, 0]).
 */
export function parseCssColor(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim().toLowerCase();
  if (t === 'transparent') return [0, 0, 0, 0];
  if (t === 'white') return [255, 255, 255, 1];
  if (t === 'black') return [0, 0, 0, 1];
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) { const v = h.split('').map((c) => parseInt(c + c, 16)); return [v[0], v[1], v[2], h.length === 4 ? v[3] / 255 : 1]; }
    if (h.length === 6 || h.length === 8) { const v = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16)); return [v[0], v[1], v[2], h.length === 8 ? v[3] / 255 : 1]; }
    return null;
  }
  m = /^(rgba?|hsla?|oklch|oklab|color)\((.*)\)$/.exec(t);
  if (!m) return null;
  const fn = m[1];
  let a = args(m[2]);
  let alpha = 1;
  const slash = a.indexOf('/');
  if (slash >= 0) { alpha = alphaOf(a[slash + 1]); a = a.slice(0, slash); }
  else if ((fn === 'rgba' || fn === 'hsla' || fn === 'rgb' || fn === 'hsl') && a.length === 4) { alpha = alphaOf(a[3]); a = a.slice(0, 3); }
  if (fn === 'rgb' || fn === 'rgba') return [num(a[0], 255), num(a[1], 255), num(a[2], 255), alpha].map((v, i) => (i < 3 ? Math.round(v) : v));
  if (fn === 'hsl' || fn === 'hsla') {
    const h = (parseFloat(a[0]) % 360 + 360) % 360, sat = num(a[1], 1), l = num(a[2], 1);
    const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), mm = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [to255(r + mm), to255(g + mm), to255(b + mm), alpha];
  }
  if (fn === 'oklab') return [...oklabToRgb(num(a[0], 1), num(a[1], 0.4), num(a[2], 0.4)), alpha];
  if (fn === 'oklch') { const L = num(a[0], 1), C = num(a[1], 0.4), H = a[2] === 'none' ? 0 : parseFloat(a[2]); return [...oklabToRgb(L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)), alpha]; }
  if (fn === 'color') {
    const space = a[0];
    const v = a.slice(1).map((x) => num(x, 1));
    if (space === 'srgb') return [to255(v[0]), to255(v[1]), to255(v[2]), alpha];
    if (space === 'srgb-linear') return [to255(gamma(v[0])), to255(gamma(v[1])), to255(gamma(v[2])), alpha];
    return null;
  }
  return null;
}

export const luminance = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
export const contrast = (a, b) => { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
export const over = (top, bottom) => { const a = top[3] === undefined ? 1 : top[3]; return [0, 1, 2].map((i) => Math.round(top[i] * a + bottom[i] * (1 - a))).concat([1]); };
/** The rgb channels of two colour strings agree within a tolerance (both parsed, any syntax). */
export const same = (cssA, cssB, tolerance = 0) => { const a = parseCssColor(cssA), b = parseCssColor(cssB); return !!a && !!b && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= tolerance); };
