import { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext(null);

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

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    // Load theme from localStorage or default to 'auto' (System)
    const savedTheme = localStorage.getItem('app-theme');
    return savedTheme || 'auto';
  });

  useEffect(() => {
    const applyTheme = (themeMode) => {
      let actualTheme = themeMode;
      let isGradientTheme = false;

      // Check if it's a gradient theme
      if (themeMode.startsWith('gradient-')) {
        isGradientTheme = true;
        actualTheme = 'dark'; // Gradient themes use dark mode base
      }

      // Handle 'auto' mode
      if (themeMode === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        actualTheme = prefersDark ? 'dark' : 'light';
      }
      if (themeMode === 'dark-neutral') actualTheme = 'dark';

      // Apply theme class to document
      if (actualTheme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }

      document.documentElement.setAttribute('data-theme', themeMode);
      // Jacaranda is the plain .dark; the neutral dark and the gradient themes
      // switch the tokens with the variant attribute
      if (actualTheme === 'dark' && (themeMode === 'dark-neutral' || isGradientTheme)) {
        document.documentElement.setAttribute('data-dark-variant', 'neutral');
      } else {
        document.documentElement.removeAttribute('data-dark-variant');
      }

      // Store gradient info for components to use
      if (isGradientTheme && GRADIENT_THEMES[themeMode]) {
        document.documentElement.setAttribute('data-gradient', GRADIENT_THEMES[themeMode].gradient);
      } else {
        document.documentElement.removeAttribute('data-gradient');
      }
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
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
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
