import { GRADIENT_THEMES, DARK_THEMES } from '../../../../contexts/ThemeContext';
import { Field, Section, Select } from './ui';

// Available zoom factors (1 = 100%). Must stay in sync with ZOOM_STEPS in
// electron/main.cjs, which owns the actual zoom state (Cmd/Ctrl +, - and 0
// walk the same list there).
const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

// The current factor can land between our steps (e.g. after clamping or a
// value written by an older version), so snap the dropdown to the closest
// step rather than showing a blank selection.
function closestZoomLevel(factor) {
  return ZOOM_LEVELS.reduce((best, level) =>
    Math.abs(level - factor) < Math.abs(best - factor) ? level : best, ZOOM_LEVELS[0]);
}

/**
 * Settings > Theme: the colour scheme (ThemeContext; applies at once and is
 * remembered) and, in the desktop app, the UI scale (the Electron main
 * process owns and persists it, applied live to every window; a browser has
 * no such control). Both apply as you make them - nothing here goes
 * through Save Settings. The props come from SettingsModal, which keeps the
 * same state it kept when these lived under General.
 */
export default function ThemeSettings({ theme, setTheme, zoomFactor, setZoomFactor }) {
  // Zoom is only controllable in the desktop app (it goes through
  // webContents in the Electron main process); hide it in web mode.
  const zoomSupported = typeof window !== 'undefined' && !!window.electronAPI?.setZoomFactor;
  return (
    <Section title="Theme" testId="theme-section">
      <Field label="Color Scheme" hint="Auto follows the system and uses Jacaranda as its dark theme; Dark (neutral) is the grey dark theme. Themed sidebars apply a colorful gradient background.">
        <Select value={theme} onChange={(e) => setTheme(e.target.value)} data-testid="theme-color-scheme">
          <option value="auto">Auto (System)</option>
          <option value="light">Light</option>
          {Object.entries(DARK_THEMES).map(([key, config]) => (
            <option key={key} value={key}>{config.name}</option>
          ))}
          <optgroup label="Themes">
            {Object.entries(GRADIENT_THEMES).map(([key, config]) => (
              <option key={key} value={key}>{config.name}</option>
            ))}
          </optgroup>
        </Select>
        {theme.startsWith('gradient-') && GRADIENT_THEMES[theme] && (
          <div className="mt-2 p-3 rounded-sm border border-os-border">
            <p className="text-xs font-medium text-os-text-primary mb-2">Preview:</p>
            <div className="h-16 rounded-sm shadow-inner" style={{ background: GRADIENT_THEMES[theme].gradient }}></div>
          </div>
        )}
      </Field>
      {zoomSupported && (
        <Field label="UI Scale" hint="Applied immediately to all windows and remembered across restarts. The Cmd/Ctrl +, - and 0 keyboard shortcuts change the same setting.">
          <Select value={String(closestZoomLevel(zoomFactor ?? 0.9))} onChange={(e) => setZoomFactor(Number(e.target.value))} data-testid="theme-ui-scale">
            {ZOOM_LEVELS.map((level) => (
              <option key={level} value={String(level)}>{Math.round(level * 100)}%</option>
            ))}
          </Select>
        </Field>
      )}
    </Section>
  );
}
