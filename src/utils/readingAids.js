/**
 * Reading aids (Settings > Accessibility): the reader's preferences for the
 * whole app - colour and contrast, highlighted links, hidden images, the
 * reading font and spacing for reading text, a reading ruler - plus a few
 * that only make sense in the Documents editor and its Preview (a readable
 * column, justified text, zen mode). They change how things are shown on
 * this device, never the content: documents, exports, sync and other
 * readers are untouched.
 *
 * One mechanism, two surfaces:
 *  - the app surface is <html>: `applyAppReadingAids()` (called from the
 *    shell through useAppReadingAids) puts the app-wide options there as
 *    classes (`ra-app`, `ra-links`, `ra-hide-images`, `ra-high-contrast`,
 *    `ra-cv-*`, `ra-ruler`) and inline `--ra-*` custom properties; the
 *    rules in src/index.css read them with today's values as fallbacks, so
 *    a default setting changes nothing. <html> is where the theme lives
 *    too, so the Diagnostics frame bridge mirrors it into the sandboxed
 *    report frame for free;
 *  - the Documents editor / Preview pane is a `ReadingAidsSurface`
 *    (src/components/common/ReadingAidsSurface.jsx) that carries the
 *    documents-only options (`--ra-max-width`, `--ra-text-align`).
 *
 * Where each option applies (OPTION_SCOPE, shown in the settings):
 *  - `app`: everywhere - high contrast, the colour-vision palette,
 *    saturation, greyscale, highlighted links, hidden images;
 *  - `reading`: reading text everywhere - body copy, descriptions, chat
 *    messages, report text, dialog and toast text, the document editor -
 *    never code, logs, terminals, fixed-width output or controls (labels,
 *    buttons, fields, tabs and the rail keep their sizes): the reading
 *    font, letter and word spacing, line height and paragraph spacing
 *    (every text block), the readable column and the alignment (long-form
 *    text: markdown previews, marked reading areas, dialog paragraphs; the
 *    Documents editor and Preview centre the column), the ruler.
 *  Zen mode is a mode of the moment on every page (JQLBuilder owns it).
 *  The `documents` scope names the Documents surface (ra-surface) alone.
 *
 * Stored in localStorage on this device (READING_AIDS_KEY), like the
 * editor's spell checking: the choices follow the screen and the eyes in
 * front of this device, not the account; only the differences from the
 * defaults are written. A change is announced with
 * READING_AIDS_CHANGED_EVENT on window, so everything follows at once.
 */

export const READING_AIDS_KEY = 'documentsReadingAids';
export const READING_AIDS_CHANGED_EVENT = 'documentsReadingAidsChanged';
export const ZEN_CHANGED_EVENT = 'documentsZenChanged';

/** The legible fonts offered (bundled through @fontsource, SIL OFL 1.1; loaded only when chosen - src/utils/readingFonts.js). */
export const READING_FONTS = Object.freeze({
  default: { label: "The app's own fonts", family: null },
  atkinson: { label: 'Atkinson Hyperlegible', family: '"Atkinson Hyperlegible", "Red Hat Text", sans-serif', pkg: '@fontsource/atkinson-hyperlegible' },
  lexend: { label: 'Lexend', family: 'Lexend, "Red Hat Text", sans-serif', pkg: '@fontsource/lexend' },
  opendyslexic: { label: 'OpenDyslexic', family: 'OpenDyslexic, "Red Hat Text", sans-serif', pkg: '@fontsource/opendyslexic' },
});
/**
 * The code fonts (Settings > Accessibility > Code font): monospaced faces designed to tell similar characters apart,
 * for code blocks and inline code, the editor's code and its line numbers, logs, terminals, the Diagnostics report's
 * monospace parts and kbd - everything that reads --font-mono. Bundled like the reading fonts (@fontsource, OFL),
 * loaded when chosen. OpenDyslexic Mono is not offered: no maintained OFL package of it exists on the registry
 * (@fontsource/opendyslexic ships the proportional faces only).
 */
export const CODE_FONTS = Object.freeze({
  default: { label: "The app's own (Red Hat Mono)", family: null },
  atkinsonMono: { label: 'Atkinson Hyperlegible Mono', family: '"Atkinson Hyperlegible Mono", "Red Hat Mono", Consolas, monospace', pkg: '@fontsource/atkinson-hyperlegible-mono' },
});
export const LINE_HEIGHTS = Object.freeze([0, 1.8, 2, 2.4]);          // 0: each area's own
export const PARAGRAPH_SPACINGS = Object.freeze([0, 1.5, 2, 3]);       // em; 0: each area's own
export const LINE_WIDTHS = Object.freeze([0, 60, 70, 80, 100, 120]);   // ch; 0: the pane's width (in zen too: zen follows this setting)
export const TEXT_ALIGNS = Object.freeze(['left', 'justify', 'justify-hyphens']);
export const COLOR_VISIONS = Object.freeze(['none', 'protanopia', 'deuteranopia', 'tritanopia']);
export const RULER_LINES = Object.freeze([1, 3, 5]);
export const RULER_MODES = Object.freeze(['highlight', 'mask']);
export const TEXT_SCALE_MIN = 90;    // %
export const TEXT_SCALE_MAX = 200;
export const TEXT_SCALE_STEP = 5;    // the slider's and the shortcuts' step; a stored value may sit between steps (an older stop such as 112.5)
export const TEXT_SCALES = Object.freeze([100, 125, 150, 175, 200]);   // the slider's tick marks; 100: today's sizes
export const LETTER_SPACING_MAX = 0.2;   // em
export const WORD_SPACING_MAX = 0.6;     // em
export const SATURATION_MIN = 20;        // %
export const REDUCE_MOTIONS = Object.freeze(['system', 'on', 'off']);   // Reduce motion: follow the OS, on, off

export const DEFAULT_READING_AIDS = Object.freeze({
  lineHeight: 0,
  letterSpacing: 0,
  wordSpacing: 0,
  paragraphSpacing: 0,
  lineWidth: 0,
  textAlign: 'left',
  font: 'default',
  codeFont: 'default',
  ruler: false,
  rulerLines: 1,
  rulerMode: 'highlight',
  textScale: 100,
  scaleChrome: false,
  hideImages: false,
  highlightLinks: false,
  highContrast: false,
  colorVision: 'none',
  saturation: 100,
  greyscale: false,
  reduceMotion: 'system',
});

/** Where each option applies: 'app' (everywhere), 'reading' (reading text everywhere), 'documents' (the editor and Preview). */
export const OPTION_SCOPE = Object.freeze({
  highContrast: 'app', colorVision: 'app', saturation: 'app', greyscale: 'app', highlightLinks: 'app', hideImages: 'app', reduceMotion: 'app',
  font: 'reading', codeFont: 'reading', letterSpacing: 'reading', wordSpacing: 'reading', lineHeight: 'reading', paragraphSpacing: 'reading', ruler: 'reading', rulerLines: 'reading', rulerMode: 'reading', textScale: 'reading', scaleChrome: 'app',
  lineWidth: 'reading', textAlign: 'reading',
});
export const SCOPE_LABELS = Object.freeze({
  app: 'Everywhere',
  reading: 'Reading text everywhere',
});

const num = (v, min, max, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

/** A complete, valid settings object from untrusted input (storage, an old version): unknown keys dropped, values clamped. */
export function normalizeReadingAids(input) {
  const s = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_READING_AIDS;
  return {
    lineHeight: oneOf(Number(s.lineHeight), LINE_HEIGHTS, d.lineHeight),
    letterSpacing: Math.round(num(s.letterSpacing, 0, LETTER_SPACING_MAX, d.letterSpacing) * 100) / 100,
    wordSpacing: Math.round(num(s.wordSpacing, 0, WORD_SPACING_MAX, d.wordSpacing) * 100) / 100,
    paragraphSpacing: oneOf(Number(s.paragraphSpacing), PARAGRAPH_SPACINGS, d.paragraphSpacing),
    lineWidth: oneOf(Number(s.lineWidth), LINE_WIDTHS, d.lineWidth),
    textAlign: oneOf(s.textAlign, TEXT_ALIGNS, d.textAlign),
    font: oneOf(s.font, Object.keys(READING_FONTS), d.font),
    codeFont: oneOf(s.codeFont, Object.keys(CODE_FONTS), d.codeFont),
    ruler: bool(s.ruler, d.ruler),
    rulerLines: oneOf(Number(s.rulerLines), RULER_LINES, d.rulerLines),
    rulerMode: oneOf(s.rulerMode, RULER_MODES, d.rulerMode),
    textScale: Math.round(num(s.textScale, TEXT_SCALE_MIN, TEXT_SCALE_MAX, d.textScale) * 10) / 10,
    scaleChrome: bool(s.scaleChrome, d.scaleChrome),
    hideImages: bool(s.hideImages, d.hideImages),
    highlightLinks: bool(s.highlightLinks, d.highlightLinks),
    highContrast: bool(s.highContrast, d.highContrast),
    colorVision: oneOf(s.colorVision, COLOR_VISIONS, d.colorVision),
    saturation: Math.round(num(s.saturation, SATURATION_MIN, 100, d.saturation)),
    greyscale: bool(s.greyscale, d.greyscale),
    reduceMotion: oneOf(s.reduceMotion, REDUCE_MOTIONS, d.reduceMotion),
  };
}

/** Is every setting at its default (nothing to show, nothing stored)? */
export function isDefaultReadingAids(s) {
  const n = normalizeReadingAids(s);
  return Object.keys(DEFAULT_READING_AIDS).every((k) => n[k] === DEFAULT_READING_AIDS[k]);
}

const storage = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };

/** The stored settings, complete (the defaults fill what is not stored). */
export function loadReadingAids(store = storage()) {
  try {
    const raw = store && store.getItem(READING_AIDS_KEY);
    return normalizeReadingAids(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeReadingAids(null);
  }
}

/** Merge `patch` into the stored settings; only the differences from the defaults are written; the change is announced. */
export function saveReadingAids(patch, store = storage()) {
  const next = normalizeReadingAids({ ...loadReadingAids(store), ...(patch || {}) });
  const diff = {};
  for (const k of Object.keys(DEFAULT_READING_AIDS)) if (next[k] !== DEFAULT_READING_AIDS[k]) diff[k] = next[k];
  try {
    if (store) {
      if (Object.keys(diff).length) store.setItem(READING_AIDS_KEY, JSON.stringify(diff));
      else store.removeItem(READING_AIDS_KEY);
    }
  } catch { /* storage full or absent: the setting still applies for this session */ }
  announce(next);
  return next;
}

/** Back to the defaults. */
export function resetReadingAids(store = storage()) {
  return saveReadingAids({ ...DEFAULT_READING_AIDS }, store);
}

function announce(settings) {
  try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(READING_AIDS_CHANGED_EVENT, { detail: settings })); } catch { /* no window */ }
}

const inScope = (key, scope) => scope === 'all' || OPTION_SCOPE[key] === scope || (scope === 'app' && OPTION_SCOPE[key] === 'reading');

/**
 * The CSS custom properties a surface sets for `settings` - only those away
 * from the defaults, so the rules' fallbacks (today's values) apply to the
 * rest. `scope`: 'app' (the app-wide and reading-text options, for <html>),
 * 'documents' (the documents-only ones, for the editor's surface), 'all'.
 */
export function readingAidsVars(settings, scope = 'all') {
  const s = normalizeReadingAids(settings);
  const vars = {};
  if (inScope('lineHeight', scope) && s.lineHeight) vars['--ra-line-height'] = String(s.lineHeight);
  if (inScope('letterSpacing', scope) && s.letterSpacing) vars['--ra-letter-spacing'] = `${s.letterSpacing}em`;
  if (inScope('wordSpacing', scope) && s.wordSpacing) vars['--ra-word-spacing'] = `${s.wordSpacing}em`;
  if (inScope('paragraphSpacing', scope) && s.paragraphSpacing) vars['--ra-paragraph-spacing'] = `${s.paragraphSpacing}em`;
  if (inScope('lineWidth', scope) && s.lineWidth) vars['--ra-max-width'] = `${s.lineWidth}ch`;
  if (inScope('textAlign', scope) && s.textAlign !== 'left') { vars['--ra-text-align'] = 'justify'; if (s.textAlign === 'justify-hyphens') vars['--ra-hyphens'] = 'auto'; }
  if (inScope('font', scope) && s.font !== 'default') vars['--ra-font-family'] = READING_FONTS[s.font].family;
  if (inScope('codeFont', scope) && s.codeFont !== 'default') vars['--ra-code-font-family'] = CODE_FONTS[s.codeFont].family;   // src/index.css: html.ra-app's --font-mono reads it
  if (inScope('greyscale', scope)) {
    if (s.greyscale) vars['--ra-filter'] = 'grayscale(1)';
    else if (s.saturation < 100) vars['--ra-filter'] = `saturate(${s.saturation}%)`;
  }
  if (inScope('rulerLines', scope) && s.ruler) vars['--ra-ruler-lines'] = String(s.rulerLines);
  if (inScope('textScale', scope) && s.textScale !== 100) vars['--ra-text-scale'] = String(s.textScale / 100);
  return vars;
}

/** Does the OS ask for less motion right now (prefers-reduced-motion)? false without matchMedia (tests, SSR). */
export function systemReducesMotion(win = typeof window !== 'undefined' ? window : null) {
  try { return !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
}

/** Is motion reduced for `settings`: On, or Follow system with the OS asking for it (Off ignores the OS). */
export function reducesMotion(settings, system = systemReducesMotion()) {
  const s = normalizeReadingAids(settings);
  return s.reduceMotion === 'on' || (s.reduceMotion === 'system' && !!system);
}

/**
 * The scroll behaviour for a scrollIntoView / scrollTo that would be smooth: 'auto' while motion is reduced (the
 * one switch on <html>; a script option would otherwise override the stylesheet's scroll-behavior).
 */
export function scrollBehavior(root = typeof document !== 'undefined' ? document.documentElement : null) {
  return root && root.classList && root.classList.contains('ra-reduce-motion') ? 'auto' : 'smooth';
}

/**
 * The classes a surface carries for `settings` in `scope` (the toggles the rules key on). `systemReducedMotion`:
 * the OS query's answer (read live by default), which Follow system turns into the ra-reduce-motion switch.
 */
export function readingAidsClasses(settings, scope = 'all', { systemReducedMotion = systemReducesMotion() } = {}) {
  const s = normalizeReadingAids(settings);
  const out = [];
  if (scope === 'documents' || scope === 'all') out.push('ra-surface');
  if (scope === 'app' || scope === 'all') {
    out.push('ra-app');
    if (s.ruler) out.push('ra-ruler', `ra-ruler-${s.rulerMode}`);
    if (s.scaleChrome && s.textScale !== 100) out.push('ra-scale-chrome');
    if (s.hideImages) out.push('ra-hide-images');
    if (s.highlightLinks) out.push('ra-links');
    if (s.highContrast) out.push('ra-high-contrast');
    if (s.colorVision !== 'none') out.push(`ra-cv-${s.colorVision}`);
    if (reducesMotion(s, systemReducedMotion)) out.push('ra-reduce-motion');   // the one motion switch (src/index.css: the blanket rule)
    // the gates of the app-wide text rules (src/index.css): with a setting off, nothing is touched
    if (s.lineHeight) out.push('ra-line');
    if (s.paragraphSpacing) out.push('ra-para');
    if (s.lineWidth) out.push('ra-width');
    if (s.textAlign !== 'left') out.push('ra-justify');
  }
  return out;
}

/**
 * Put the app-wide options on `root` (<html>): its `ra-*` classes and
 * `--ra-*` inline properties become exactly those of `settings` (stale ones
 * removed). Returns what was applied, for tests.
 */
export function applyAppReadingAids(settings, root = typeof document !== 'undefined' ? document.documentElement : null) {
  if (!root) return null;
  const classes = readingAidsClasses(settings, 'app');
  const vars = readingAidsVars(settings, 'app');
  for (const c of Array.from(root.classList)) if (c.startsWith('ra-') && !classes.includes(c)) root.classList.remove(c);
  for (const c of classes) root.classList.add(c);
  const stale = [];
  for (let i = 0; i < root.style.length; i++) { const n = root.style[i]; if (n.startsWith('--ra-') && !(n in vars)) stale.push(n); }
  for (const n of stale) root.style.removeProperty(n);
  for (const [n, v] of Object.entries(vars)) if (root.style.getPropertyValue(n) !== v) root.style.setProperty(n, v);
  return { classes, vars };
}

// ------------------------------------------------------------------ text size
/** A slider value snapped to the 5 % step and clamped to the range (stored values are left as they are). */
export function snapTextScale(value) {
  const v = num(value, TEXT_SCALE_MIN, TEXT_SCALE_MAX, 100);
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, Math.round(v / TEXT_SCALE_STEP) * TEXT_SCALE_STEP));
}

/** The text size one step (5 %) up (`direction` 1) or down (-1) from `settings`, on the step grid, clamped to the ends. */
export function stepTextScale(settings, direction) {
  const s = normalizeReadingAids(settings);
  return snapTextScale(s.textScale + (direction > 0 ? TEXT_SCALE_STEP : -TEXT_SCALE_STEP));
}

// ------------------------------------------------------------ the ruler's geometry
/**
 * The band for a text line: `lineTop` / `lineHeight` are the line box under
 * the pointer (or the caret), `lines` how many lines tall the band is (1, 3
 * or 5, centred on that line), `areaTop` / `areaBottom` the visible bounds
 * of the reading area the band is clipped to. Returns { top, height } in
 * the same coordinates, or null when the line is outside the area.
 */
export function rulerBand({ lineTop, lineHeight, lines = 1, areaTop = -Infinity, areaBottom = Infinity }) {
  if (!Number.isFinite(lineTop) || !(lineHeight > 0)) return null;
  const n = RULER_LINES.includes(lines) ? lines : 1;
  const top = lineTop - ((n - 1) / 2) * lineHeight;
  const height = n * lineHeight;
  if (top + height <= areaTop || top >= areaBottom) return null;
  return { top, height };
}

/** The line box a pointer at `y` falls in, given a reference line (`baseTop`, `lineHeight`): the band snaps to lines, never between them. */
export function snapToLine(y, baseTop, lineHeight) {
  if (!(lineHeight > 0)) return baseTop;
  return baseTop + Math.floor((y - baseTop) / lineHeight) * lineHeight;
}

// ------------------------------------------------------------------ zen mode
let zenOn = false;
export const zenMode = {
  get on() { return zenOn; },
  set(on) {
    const next = !!on;
    if (next === zenOn) return;
    zenOn = next;
    try {
      if (typeof document !== 'undefined') document.documentElement.classList.toggle('zen-mode', zenOn);
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ZEN_CHANGED_EVENT, { detail: { on: zenOn } }));
    } catch { /* no DOM */ }
    if (!zenOn) zenPanel.set(null);   // leaving zen closes the panel overlay
  },
  toggle() { zenMode.set(!zenOn); },
};

export const ZEN_PANEL_CHANGED_EVENT = 'documentsZenPanelChanged';
let zenPanelId = null;
/**
 * The panel shown as an overlay in zen mode (the Panels button, top right): 'aiChat' | 'draft' | 'chat' |
 * 'notification' | null. ResizableSidebar draws the chosen panel over the page; Esc or a click outside closes it
 * (zen stays); leaving zen closes it.
 */
export const zenPanel = {
  get id() { return zenPanelId; },
  set(id) {
    const next = id || null;
    if (next === zenPanelId) return;
    zenPanelId = next;
    try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ZEN_PANEL_CHANGED_EVENT, { detail: { id: zenPanelId } })); } catch { /* no DOM */ }
  },
};
