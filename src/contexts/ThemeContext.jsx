import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { isStarterScheme, starterSchemeTheme } from '../utils/themeStarters';
import {
  CUSTOM_THEME_PREFIX, deriveTokens, loadCustomThemes, saveCustomThemes, schemeThemeId, validateCustomTheme, MAX_CUSTOM_THEMES,
} from '../utils/customThemes';

const ThemeContext = createContext();

// Available gradient themes
// Provider + companion export intentionally share this module (splitting
// would churn every consumer import for a hot-reload-only benefit).
// eslint-disable-next-line react-refresh/only-export-components
export const GRADIENT_THEMES = {
  'gradient-red-purple': {
    name: 'Magma',
    gradient: 'linear-gradient(180deg, #991b1b 0%, #6b21a8 100%)',
    from: '#991b1b',
    to: '#6b21a8'
  },
  'gradient-blue-purple': {
    name: 'Nebula',
    gradient: 'linear-gradient(180deg, #1e40af 0%, #7e22ce 100%)',
    from: '#1e40af',
    to: '#7e22ce'
  },
  'gradient-green-blue': {
    name: 'Vulkan',
    gradient: 'linear-gradient(180deg, #047857 0%, #0369a1 100%)',
    from: '#047857',
    to: '#0369a1'
  },
  'gradient-orange-red': {
    name: 'Sunset',
    gradient: 'linear-gradient(180deg, #c2410c 0%, #991b1b 100%)',
    from: '#c2410c',
    to: '#991b1b'
  },
  'gradient-pink-purple': {
    name: 'Aurora',
    gradient: 'linear-gradient(180deg, #be185d 0%, #7e22ce 100%)',
    from: '#be185d',
    to: '#7e22ce'
  }
};

/* The dark themes: 'dark' is Jacaranda (the default dark, also what Auto
   picks on a dark system), 'dark-neutral' the neutral greys from before.
   Both add the .dark class; the neutral one (and the gradient themes, which
   paint their rail over neutral surfaces) also set data-dark-variant="neutral"
   on <html>, which src/index.css keys its tokens on. */
// eslint-disable-next-line react-refresh/only-export-components
export const DARK_THEMES = {
  dark: { name: 'Jacaranda (dark)' },
  'dark-neutral': { name: 'Dark (neutral)' },
};

/* The custom themes (src/utils/customThemes.js): the user's own colour
   schemes, kept in localStorage (jacarium-custom-themes) beside the chosen
   scheme (app-theme), chosen as 'custom-<id>'. One starts from a base
   (light or dark: that base's class and block of src/index.css), and its
   derived tokens are set inline on <html> (style.setProperty, validated
   values only), which everything that reads the tokens follows - the
   pages, the editor, the Diagnostics frame (DiagnosticsPage.jsx forwards
   the inline custom properties). Switching away removes exactly the
   properties the theme set. */
// eslint-disable-next-line react-refresh/only-export-components
export const isCustomScheme = (scheme) => typeof scheme === 'string' && scheme.startsWith(CUSTOM_THEME_PREFIX);
/** A scheme painted from derived tokens (a custom theme or a palette) rather than the stylesheet's own blocks. */
// eslint-disable-next-line react-refresh/only-export-components
export const isTokenScheme = (scheme) => isCustomScheme(scheme) || isStarterScheme(scheme);

function setCustomTokens(root, tokens, previous) {
  for (const name of previous) if (!(name in tokens)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  return Object.keys(tokens);
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    // Load theme from localStorage or default to 'auto' (System)
    const savedTheme = localStorage.getItem('app-theme');
    return savedTheme || 'auto';
  });
  const [customThemes, setCustomThemes] = useState(() => loadCustomThemes());
  // a theme being edited: applied to the app while the editor is open, instead of the chosen one
  const [previewTheme, setPreviewTheme] = useState(null);
  const customNamesRef = useRef([]);

  useEffect(() => {
    const applyTheme = (themeMode) => {
      let actualTheme = themeMode;
      let isGradientTheme = false;
      const root = document.documentElement;

      // the custom theme chosen (or previewed): its base decides the class, its tokens go inline
      let custom = previewTheme;
      if (!custom && isCustomScheme(themeMode)) {
        const id = schemeThemeId(themeMode);
        custom = customThemes.find((t) => t.id === id) || null;
        if (!custom) themeMode = 'auto';   // a theme deleted elsewhere (another tab, an import): back to the system
      }
      // a palette chosen as it is ('starter-nord'): the template's tokens, nothing stored
      if (!custom && isStarterScheme(themeMode)) {
        custom = starterSchemeTheme(themeMode);
        if (!custom) themeMode = 'auto';
      }
      if (custom) actualTheme = custom.base;

      // Check if it's a gradient theme
      if (themeMode.startsWith('gradient-')) {
        isGradientTheme = true;
        actualTheme = 'dark'; // Gradient themes use dark mode base
      }

      // Handle 'auto' mode
      if (themeMode === 'auto' && !custom) {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        actualTheme = prefersDark ? 'dark' : 'light';
      }
      if (themeMode === 'dark-neutral') actualTheme = 'dark';

      // Apply theme class to document
      if (actualTheme === 'dark') {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }

      root.setAttribute('data-theme', custom ? (previewTheme ? `${CUSTOM_THEME_PREFIX}${custom.id}` : themeMode) : themeMode);
      // Jacaranda is the plain .dark; the neutral dark and the gradient themes
      // switch the tokens with the variant attribute
      // (a custom theme's mode is 'custom-<id>': neither, so it never gets the variant)
      if (actualTheme === 'dark' && (themeMode === 'dark-neutral' || isGradientTheme)) {
        document.documentElement.setAttribute('data-dark-variant', 'neutral');
      } else {
        document.documentElement.removeAttribute('data-dark-variant');
      }

      // Store gradient info for components to use
      if (isGradientTheme && GRADIENT_THEMES[themeMode]) {
        root.setAttribute('data-gradient', GRADIENT_THEMES[themeMode].gradient);
      } else {
        root.removeAttribute('data-gradient');
      }

      // the custom tokens inline, or none (the previous theme's removed)
      customNamesRef.current = setCustomTokens(root, custom ? deriveTokens(custom) : {}, customNamesRef.current);
    };

    applyTheme(theme);
    localStorage.setItem('app-theme', theme);

    // Listen for system theme changes if in 'auto' mode
    if (theme === 'auto') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = () => applyTheme(theme);
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, [theme, customThemes, previewTheme]);

  /** Save a theme (new or changed: by id); returns the stored copy, or null when it is not a valid theme or the list is full. */
  const saveCustomTheme = (candidate) => {
    const v = validateCustomTheme({ ...candidate, updatedAt: new Date().toISOString() });
    if (!v.ok) return null;
    let stored = null;
    setCustomThemes((list) => {
      const i = list.findIndex((t) => t.id === v.theme.id);
      if (i < 0 && list.length >= MAX_CUSTOM_THEMES) return list;
      const next = i >= 0 ? list.map((t, k) => (k === i ? v.theme : t)) : [...list, v.theme];
      saveCustomThemes(next);
      stored = v.theme;
      return next;
    });
    return stored || v.theme;
  };
  /** Remove a theme; a scheme that used it falls back to the system theme. */
  const deleteCustomTheme = (id) => {
    setCustomThemes((list) => { const next = list.filter((t) => t.id !== id); saveCustomThemes(next); return next; });
    if (theme === `${CUSTOM_THEME_PREFIX}${id}`) setTheme('auto');
  };
  /** Replace the list (an import's merge result). */
  const replaceCustomThemes = (list) => {
    const valid = [];
    for (const t of list || []) { const v = validateCustomTheme(t); if (v.ok) valid.push(v.theme); }
    saveCustomThemes(valid);
    setCustomThemes(valid);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, customThemes, saveCustomTheme, deleteCustomTheme, replaceCustomThemes, previewTheme, setPreviewTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

// Provider + companion export intentionally share this module (splitting
// would churn every consumer import for a hot-reload-only benefit).
// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}

/** The context, or null outside a ThemeProvider (a panel rendered on its own, as in a test). */
// eslint-disable-next-line react-refresh/only-export-components
export function useThemeOptional() {
  return useContext(ThemeContext) || null;
}
