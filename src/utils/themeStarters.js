/**
 * The starters a custom theme can begin from (Settings > Theme > New theme):
 * the app's own schemes (Light, Jacaranda, the neutral dark, the five
 * gradient themes) mapped into the editable model, and well-known palettes
 * mapped onto the model's roles from their published colours only. A
 * starter is a read-only template in code: choosing one creates a new
 * custom theme (its own id, the starter's name made unique) that the user
 * edits and saves; the starter never changes and is never exported.
 *
 * Every starter validates against the theme schema and raises no contrast
 * warning (tests/theme-starters.test.mjs runs contrastWarnings over each):
 * the text / surface pairs were chosen within each palette's own colours
 * for WCAG 4.5:1 (3:1 for muted text, status colours and the accent).
 *
 * The palettes and their licences (the colours below are the published
 * values; the names are the palettes' names, nothing else of theirs):
 *   Nord          MIT  https://github.com/nordtheme/nord
 *   Dracula       MIT  https://github.com/dracula/dracula-theme
 *   Solarized     MIT  https://github.com/altercation/solarized
 *   Gruvbox       MIT  https://github.com/morhetz/gruvbox
 *   One Dark      MIT  https://github.com/atom/atom (one-dark-syntax / one-dark-ui)
 *   Tokyo Night   MIT  https://github.com/enkia/tokyo-night-vscode-theme
 *   Catppuccin    MIT  https://github.com/catppuccin/catppuccin (Mocha, Latte)
 *   GitHub        MIT  https://github.com/primer/primitives (the Primer colour primitives)
 */
// the app's gradient themes (src/contexts/ThemeContext.jsx GRADIENT_THEMES: name, from, to - repeated here so this
// module stays plain JavaScript for the tests; tests/theme-starters.test.mjs checks the two agree)
const GRADIENT_THEMES = {
  'gradient-red-purple': { name: 'Magma', from: '#991b1b', to: '#6b21a8' },
  'gradient-blue-purple': { name: 'Nebula', from: '#1e40af', to: '#7e22ce' },
  'gradient-green-blue': { name: 'Vulkan', from: '#047857', to: '#0369a1' },
  'gradient-orange-red': { name: 'Sunset', from: '#c2410c', to: '#991b1b' },
  'gradient-pink-purple': { name: 'Aurora', from: '#be185d', to: '#7e22ce' },
};
import { defaultTheme, validateCustomTheme, newThemeId, uniqueThemeName, themeSchemeId } from './customThemes.js';

const solid = (color) => ({ type: 'solid', color });
const linear = (from, to) => ({ type: 'linear', angle: 180, stops: [{ color: from, at: 0 }, { color: to, at: 100 }] });

// the app's gradient themes: the neutral dark surfaces (src/index.css .dark[data-dark-variant="neutral"]), the rail
// as the gradient, the mark as [data-theme="gradient-*"] paints it
const GRADIENT_MARKS = {
  'gradient-red-purple': { arch: '#ffe4e6', blossom: '#9f1239' },
  'gradient-blue-purple': { arch: '#e0e7ff', blossom: '#3730a3' },
  'gradient-green-blue': { arch: '#d1fae5', blossom: '#065f46' },
  'gradient-orange-red': { arch: '#ffedd5', blossom: '#9a3412' },
  'gradient-pink-purple': { arch: '#fce7f3', blossom: '#9d174d' },
};
const NEUTRAL_DARK = {
  canvas: '#151515', card: '#1f1f1f', cardSecondary: '#2a2a2a', codeBg: '#161b22',
  textPrimary: '#f0f0f0', textSecondary: '#b0b0b0', textMuted: '#808080',
  accent: '#4a9eff', border: '#3a3a3a', success: '#4ade80', warning: '#fbbf24', danger: '#f87171',
  railText: '#9ca3af', sidebar: '#1a1a1a', markArch: '#7b5ce0', markBlossom: '#ede6ff', markCenter: null,
};

function builtIn(id, name, base, colors, rail, extra = {}) {
  return { id, name, group: 'Built-in schemes', scheme: extra.scheme || id, theme: { base, colors, fills: { rail }, logoTone: 'dark' } };
}
/** Jacarium's own showcase schemes: bold gradient rails, every pair past the contrast checks. */
function crazy(id, name, base, colors, rail, logoTone = 'dark') {
  return { id, name, group: 'Crazy', theme: { base, colors, fills: { rail }, logoTone } };
}
function palette(id, name, base, colors, rail, source, extra = {}) {
  return { id, name, group: 'Palettes', source, theme: { base, colors, fills: { rail }, logoTone: extra.logoTone || 'dark' } };
}

const jacaranda = defaultTheme('dark').colors;
const light = defaultTheme('light').colors;

/** The starters, in the order the gallery shows them. */
export const THEME_STARTERS = [
  builtIn('light', 'Light', 'light', light, solid('#1a1a1a')),
  builtIn('dark', 'Jacaranda (dark)', 'dark', jacaranda, solid('#1b1530')),
  builtIn('dark-neutral', 'Dark (neutral)', 'dark', NEUTRAL_DARK, solid('#1a1a1a')),
  ...Object.entries(GRADIENT_THEMES).map(([key, g]) => builtIn(key, g.name, 'dark', { ...NEUTRAL_DARK, markArch: GRADIENT_MARKS[key].arch, markBlossom: GRADIENT_MARKS[key].blossom, railText: '#ffffff' }, linear(g.from, g.to))),

  palette('nord', 'Nord', 'dark', {
    canvas: '#2e3440', card: '#3b4252', cardSecondary: '#434c5e', codeBg: '#2e3440',
    textPrimary: '#eceff4', textSecondary: '#e5e9f0', textMuted: '#d8dee9',
    accent: '#88c0d0', border: '#4c566a', success: '#a3be8c', warning: '#ebcb8b', danger: '#d08770',   // nord12: nord11's red reads under 3:1 on nord1
    railText: '#d8dee9', sidebar: '#3b4252', markArch: '#88c0d0', markBlossom: '#2e3440', markCenter: null,
  }, solid('#2e3440'), { name: 'Nord', url: 'https://github.com/nordtheme/nord', licence: 'MIT' }),

  palette('dracula', 'Dracula', 'dark', {
    canvas: '#282a36', card: '#282a36', cardSecondary: '#44475a', codeBg: '#282a36',
    textPrimary: '#f8f8f2', textSecondary: '#f8f8f2', textMuted: '#6272a4',
    accent: '#bd93f9', border: '#44475a', success: '#50fa7b', warning: '#f1fa8c', danger: '#ff5555',
    railText: '#f8f8f2', sidebar: '#282a36', markArch: '#bd93f9', markBlossom: '#282a36', markCenter: null,
  }, solid('#282a36'), { name: 'Dracula', url: 'https://github.com/dracula/dracula-theme', licence: 'MIT' }),

  palette('solarized-dark', 'Solarized Dark', 'dark', {
    canvas: '#002b36', card: '#002b36', cardSecondary: '#073642', codeBg: '#073642',
    textPrimary: '#eee8d5', textSecondary: '#93a1a1', textMuted: '#839496',
    accent: '#268bd2', border: '#586e75', success: '#859900', warning: '#b58900', danger: '#d33682',   // magenta: the red and the orange read under 3:1 on base03
    railText: '#93a1a1', sidebar: '#073642', markArch: '#2aa198', markBlossom: '#002b36', markCenter: null,
  }, solid('#002b36'), { name: 'Solarized', url: 'https://github.com/altercation/solarized', licence: 'MIT' }),

  palette('solarized-light', 'Solarized Light', 'light', {
    canvas: '#fdf6e3', card: '#fdf6e3', cardSecondary: '#eee8d5', codeBg: '#eee8d5',
    textPrimary: '#073642', textSecondary: '#586e75', textMuted: '#657b83',
    accent: '#268bd2', border: '#93a1a1', success: '#586e75', warning: '#cb4b16', danger: '#dc322f',   // base01 for success and the orange for warning: the green and the yellow read under 3:1 on base3
    railText: '#93a1a1', sidebar: '#002b36', markArch: '#2aa198', markBlossom: '#002b36', markCenter: null,
  }, solid('#002b36'), { name: 'Solarized', url: 'https://github.com/altercation/solarized', licence: 'MIT' }),

  palette('gruvbox-dark', 'Gruvbox Dark', 'dark', {
    canvas: '#282828', card: '#3c3836', cardSecondary: '#504945', codeBg: '#282828',
    textPrimary: '#ebdbb2', textSecondary: '#d5c4a1', textMuted: '#bdae93',
    accent: '#83a598', border: '#665c54', success: '#b8bb26', warning: '#fabd2f', danger: '#fb4934',
    railText: '#d5c4a1', sidebar: '#3c3836', markArch: '#fe8019', markBlossom: '#282828', markCenter: null,
  }, solid('#282828'), { name: 'Gruvbox', url: 'https://github.com/morhetz/gruvbox', licence: 'MIT' }),

  palette('one-dark', 'One Dark', 'dark', {
    canvas: '#21252b', card: '#282c34', cardSecondary: '#3e4451', codeBg: '#21252b',
    textPrimary: '#abb2bf', textSecondary: '#abb2bf', textMuted: '#9da5b4',
    accent: '#61afef', border: '#3e4451', success: '#98c379', warning: '#e5c07b', danger: '#e06c75',
    railText: '#abb2bf', sidebar: '#282c34', markArch: '#c678dd', markBlossom: '#282c34', markCenter: null,
  }, solid('#21252b'), { name: 'One Dark', url: 'https://github.com/atom/atom', licence: 'MIT' }),

  palette('tokyo-night', 'Tokyo Night', 'dark', {
    canvas: '#1a1b26', card: '#1f2335', cardSecondary: '#292e42', codeBg: '#16161e',
    textPrimary: '#c0caf5', textSecondary: '#a9b1d6', textMuted: '#9aa5ce',
    accent: '#7aa2f7', border: '#3b4261', success: '#9ece6a', warning: '#e0af68', danger: '#f7768e',
    railText: '#a9b1d6', sidebar: '#16161e', markArch: '#bb9af7', markBlossom: '#1a1b26', markCenter: null,
  }, solid('#16161e'), { name: 'Tokyo Night', url: 'https://github.com/enkia/tokyo-night-vscode-theme', licence: 'MIT' }),

  palette('catppuccin-mocha', 'Catppuccin Mocha', 'dark', {
    canvas: '#1e1e2e', card: '#181825', cardSecondary: '#313244', codeBg: '#11111b',
    textPrimary: '#cdd6f4', textSecondary: '#bac2de', textMuted: '#a6adc8',
    accent: '#89b4fa', border: '#45475a', success: '#a6e3a1', warning: '#f9e2af', danger: '#f38ba8',
    railText: '#bac2de', sidebar: '#181825', markArch: '#cba6f7', markBlossom: '#1e1e2e', markCenter: null,
  }, solid('#11111b'), { name: 'Catppuccin', url: 'https://github.com/catppuccin/catppuccin', licence: 'MIT' }),

  palette('catppuccin-latte', 'Catppuccin Latte', 'light', {
    canvas: '#eff1f5', card: '#ffffff', cardSecondary: '#e6e9ef', codeBg: '#e6e9ef',
    textPrimary: '#4c4f69', textSecondary: '#5c5f77', textMuted: '#6c6f85',
    accent: '#1e66f5', border: '#bcc0cc', success: '#40a02b', warning: '#e64553', danger: '#d20f39',   // maroon for warning: the yellow and the peach read under 3:1 on the light surfaces
    railText: '#4c4f69', sidebar: '#e6e9ef', markArch: '#8839ef', markBlossom: '#eff1f5', markCenter: null,
  }, solid('#dce0e8'), { name: 'Catppuccin', url: 'https://github.com/catppuccin/catppuccin', licence: 'MIT' }),

  palette('github-dark', 'GitHub Dark', 'dark', {
    canvas: '#0d1117', card: '#161b22', cardSecondary: '#21262d', codeBg: '#0d1117',
    textPrimary: '#e6edf3', textSecondary: '#c9d1d9', textMuted: '#8b949e',
    accent: '#58a6ff', border: '#30363d', success: '#3fb950', warning: '#d29922', danger: '#f85149',
    railText: '#c9d1d9', sidebar: '#161b22', markArch: '#58a6ff', markBlossom: '#0d1117', markCenter: null,
  }, solid('#0d1117'), { name: 'GitHub', url: 'https://github.com/primer/primitives', licence: 'MIT' }),

  palette('github-light', 'GitHub Light', 'light', {
    canvas: '#f6f8fa', card: '#ffffff', cardSecondary: '#f6f8fa', codeBg: '#f6f8fa',
    textPrimary: '#1f2328', textSecondary: '#656d76', textMuted: '#656d76',
    accent: '#0969da', border: '#d0d7de', success: '#1a7f37', warning: '#9a6700', danger: '#cf222e',
    railText: '#d0d7de', sidebar: '#24292f', markArch: '#58a6ff', markBlossom: '#0d1117', markCenter: null,   // the dark palette's blue-400 on the dark rail, its canvas as the blossom
  }, solid('#24292f'), { name: 'GitHub', url: 'https://github.com/primer/primitives', licence: 'MIT' }),

  // ---- Crazy: the showcase schemes (Jacarium's own) ----
  crazy('synthwave-84', 'Synthwave 84', 'dark', {
    canvas: '#120724', card: '#1c0d36', cardSecondary: '#2a1450', codeBg: '#0d0420',
    textPrimary: '#f8e8ff', textSecondary: '#d6b3ff', textMuted: '#a07cc9', accent: '#ff2bd6',
    border: '#4a2580', success: '#3dfcd2', warning: '#ffd23f', danger: '#ff4f6d',
    railText: '#ffffff', sidebar: '#160a2d', markArch: '#3dfcd2', markBlossom: '#5a0a4a',
    markCenter: '#fff6a8',
  }, { type: 'linear', angle: 180, stops: [{ color: '#b0108f', at: 0 }, { color: '#5a1fb8', at: 50 }, { color: '#1b0b3a', at: 100 }] }, 'dark'),
  crazy('aurora-borealis', 'Aurora Borealis', 'dark', {
    canvas: '#06121c', card: '#0b1d2b', cardSecondary: '#112a3d', codeBg: '#050e16',
    textPrimary: '#e6fbff', textSecondary: '#9ee7d8', textMuted: '#6fa9b5', accent: '#36f1b0',
    border: '#1d3f55', success: '#36f1b0', warning: '#f5d76e', danger: '#ff6b81',
    railText: '#ffffff', sidebar: '#081723', markArch: '#36f1b0', markBlossom: '#5b2ea6',
    markCenter: '#e6fbff',
  }, { type: 'radial', stops: [{ color: '#0f7a62', at: 0 }, { color: '#1554a8', at: 50 }, { color: '#3d1f78', at: 100 }] }, 'dark'),
  crazy('lava-lamp', 'Lava Lamp', 'dark', {
    canvas: '#160805', card: '#22100a', cardSecondary: '#331810', codeBg: '#0f0503',
    textPrimary: '#fff1e6', textSecondary: '#ffc6a0', textMuted: '#c98a66', accent: '#ff6a1a',
    border: '#5a2a18', success: '#9be564', warning: '#ffc233', danger: '#ff3b5c',
    railText: '#ffffff', sidebar: '#1b0b06', markArch: '#ffc44d', markBlossom: '#5c0013',
    markCenter: '#fff1e6',
  }, { type: 'linear', angle: 160, stops: [{ color: '#b34700', at: 0 }, { color: '#a3190a', at: 50 }, { color: '#5c0013', at: 100 }] }, 'dark'),
  crazy('deep-ocean', 'Deep Ocean', 'dark', {
    canvas: '#020b1a', card: '#071730', cardSecondary: '#0c2244', codeBg: '#010714',
    textPrimary: '#e3f4ff', textSecondary: '#8ccfff', textMuted: '#5f93bd', accent: '#00b8ff',
    border: '#143a66', success: '#2ee6a6', warning: '#ffd166', danger: '#ff5c7a',
    railText: '#ffffff', sidebar: '#041026', markArch: '#00e5ff', markBlossom: '#001a4d',
    markCenter: '#e3f4ff',
  }, { type: 'linear', angle: 200, stops: [{ color: '#006b8f', at: 0 }, { color: '#0044b3', at: 50 }, { color: '#001a4d', at: 100 }] }, 'dark'),
  crazy('cotton-candy', 'Cotton Candy', 'light', {
    canvas: '#fff7fc', card: '#ffffff', cardSecondary: '#f6eefe', codeBg: '#f3ecfb',
    textPrimary: '#2b1840', textSecondary: '#5b3f7a', textMuted: '#806699', accent: '#c2188a',
    border: '#e6d4f2', success: '#1d7f52', warning: '#9a5b00', danger: '#c2183b',
    railText: '#2b1840', sidebar: '#fbf2fb', markArch: '#9e1170', markBlossom: '#ffffff',
    markCenter: '#ffd1ec',
  }, { type: 'linear', angle: 135, stops: [{ color: '#ffd1ec', at: 0 }, { color: '#e1d6ff', at: 50 }, { color: '#cfeaff', at: 100 }] }, 'dark'),
  crazy('toxic-neon', 'Toxic Neon', 'dark', {
    canvas: '#050805', card: '#0b120b', cardSecondary: '#121d12', codeBg: '#030603',
    textPrimary: '#efffd6', textSecondary: '#c6ff00', textMuted: '#8fb35a', accent: '#c6ff00',
    border: '#2b4a1a', success: '#39ff88', warning: '#ffe600', danger: '#ff3d3d',
    railText: '#c6ff00', sidebar: '#070d07', markArch: '#c6ff00', markBlossom: '#003d1a',
    markCenter: '#efffd6',
  }, { type: 'radial', stops: [{ color: '#1f5c10', at: 0 }, { color: '#0b3d1c', at: 50 }, { color: '#02160a', at: 100 }] }, 'dark'),
];

// read-only templates: frozen through, so a slip in the editor can never write into one
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
deepFreeze(THEME_STARTERS);

/** The starter for the app's own scheme id ('light', 'dark', 'dark-neutral', 'gradient-*'), or null. */
export function starterForScheme(scheme) {
  return THEME_STARTERS.find((s) => s.group === 'Built-in schemes' && s.id === scheme) || null;
}

/**
 * A palette is a scheme of its own: 'starter-nord' is chosen like Light or a custom theme (Settings > Theme's
 * gallery, localStorage 'app-theme') and applied from the template's tokens - nothing is stored until the user
 * saves a customised copy.
 */
export const STARTER_SCHEME_PREFIX = 'starter-';
export const isStarterScheme = (scheme) => typeof scheme === 'string' && scheme.startsWith(STARTER_SCHEME_PREFIX);
export const starterSchemeId = (starter) => `${STARTER_SCHEME_PREFIX}${starter.id}`;
/** The palette (or Crazy) starter behind a 'starter-<id>' scheme, or null (the built-in starters are schemes already). */
export function schemeStarter(scheme) {
  if (!isStarterScheme(scheme)) return null;
  const id = scheme.slice(STARTER_SCHEME_PREFIX.length);
  return THEME_STARTERS.find((s) => (s.group === 'Palettes' || s.group === 'Crazy') && s.id === id) || null;
}
/** The model a scheme is drawn from (the gallery's tiles): a built-in one through its starter (Auto through the system's), a palette, a saved theme. */
export function schemeModel(scheme, customThemes, systemDark = true) {
  if (scheme === 'auto') return starterForScheme(systemDark ? 'dark' : 'light')?.theme || null;
  const builtIn = starterForScheme(scheme);
  if (builtIn) return builtIn.theme;
  const palette = starterSchemeTheme(scheme);
  if (palette) return palette;
  return (customThemes || []).find((t) => themeSchemeId(t) === scheme) || null;
}
const schemeThemes = new Map();
/** The validated theme a 'starter-<id>' scheme applies (one object per starter for the session), or null. */
export function starterSchemeTheme(scheme) {
  const starter = schemeStarter(scheme);
  if (!starter) return null;
  if (!schemeThemes.has(starter.id)) schemeThemes.set(starter.id, Object.freeze(themeFromStarter(starter)));
  return schemeThemes.get(starter.id);
}

/**
 * A new custom theme from a starter: a fresh id and dates, the starter's colours and fill copied, the name made
 * unique among `existing` (with a "copy" suffix). A starter whose theme does not validate throws (a test catches
 * it before a release does).
 */
export function themeFromStarter(starter, existing = [], name = starter.name) {
  const v = validateCustomTheme({ ...starter.theme, id: newThemeId(), name: uniqueThemeName(name, existing, 'copy'), colors: { ...starter.theme.colors }, fills: { ...starter.theme.fills } });
  if (!v.ok) throw new Error(`starter ${starter.id}: ${v.errors.join('; ')}`);
  return v.theme;
}

/** A new custom theme from a saved theme (its own id, "(copy)" name): Duplicate. */
export function themeCopy(theme, existing = []) {
  const v = validateCustomTheme({ ...theme, id: newThemeId(), name: uniqueThemeName(theme.name, existing, 'copy'), colors: { ...theme.colors }, fills: { ...theme.fills } });
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v.theme;
}
