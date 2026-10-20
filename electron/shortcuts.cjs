// The main process's side of the keyboard shortcuts: the user's overrides
// kept in the profile's ui-settings.json (read-merge-write through
// electron/ui-settings.cjs, never clobbering zoom or the debug bar), their
// validation against the registry's rules, and the accelerators the
// application menu takes from them (electron/main.cjs rebuilds the menu
// with Menu.setApplicationMenu whenever they change).
//
// Electron-free on purpose (callers pass the file path and the platform),
// so tests/shortcuts-main.test.mjs runs the real code under plain Node.
// The registry itself is electron/shortcuts-registry.cjs, generated from
// src/shortcuts/registry.js.
const { readUiSettings, persistUiSettings } = require('./ui-settings.cjs');
const registry = require('./shortcuts-registry.cjs');

const UI_SETTINGS_KEY = 'shortcuts';

/** 'mac' | 'win' | 'linux' from process.platform. */
function osOf(platform) {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';
}

/**
 * The stored overrides, cleaned (unknown ids, bad chords and fixed actions
 * dropped): { version, overrides }. A missing or corrupt file or an older
 * schema yields no overrides.
 */
function readShortcutOverrides(filePath) {
  const stored = readUiSettings(filePath)[UI_SETTINGS_KEY];
  if (!stored || typeof stored !== 'object' || stored.version !== registry.SCHEMA_VERSION) return { version: registry.SCHEMA_VERSION, overrides: {} };
  return { version: registry.SCHEMA_VERSION, overrides: registry.normalizeOverrides(stored.overrides).overrides };
}

/** Persist the overrides (only the differences from the defaults) with the schema version. */
function writeShortcutOverrides(filePath, overrides) {
  const cleaned = registry.normalizeOverrides(overrides).overrides;
  persistUiSettings(filePath, { [UI_SETTINGS_KEY]: { version: registry.SCHEMA_VERSION, overrides: cleaned } });
  return cleaned;
}

/**
 * Check a whole override map the way the Settings tab checks one binding:
 * every chord must be allowed for its action on this OS in the desktop
 * build, against the other bindings (a conflict is an error here - the
 * renderer resolves conflicts before sending). { ok, errors: [{ id,
 * message }], overrides } with the cleaned map.
 */
function validateShortcutOverrides(raw, platform) {
  const os = osOf(platform);
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: [{ id: null, message: 'Overrides must be an object of action ids to chords.' }], overrides: {} };
  const { overrides, dropped } = registry.normalizeOverrides(raw);
  for (const id of dropped) errors.push({ id, message: 'Unknown action, fixed action or unusable chord.' });
  const bindings = registry.resolveBindings(overrides, registry.platformOf(os));
  for (const [id, chord] of Object.entries(overrides)) {
    if (chord === null) continue;
    const others = { ...bindings, [id]: null };
    const result = registry.validateChord(chord, { actionId: id, os, build: 'desktop', bindings: others });
    if (!result.ok) errors.push({ id, message: result.message });
  }
  return { ok: errors.length === 0, errors, overrides };
}

/**
 * The menu's accelerators for these overrides: { actionId: { accelerator,
 * aliases } } for every menu-owned, rebindable action with a chord
 * (aliases: the hidden twin items, Zoom in's Shift+=). Roles keep
 * Electron's own accelerators and are not listed.
 */
function menuAccelerators(overrides, platform) {
  const os = osOf(platform);
  const p = registry.platformOf(os);
  const bindings = registry.resolveBindings(overrides, p);
  const out = {};
  for (const action of registry.ACTIONS) {
    if (action.owner !== 'menu' || action.role) continue;
    const accelerator = bindings[action.id] ? registry.toAccelerator(bindings[action.id]) : null;
    const aliases = registry.aliasesOf(action, p).map(registry.toAccelerator).filter(Boolean);
    if (accelerator || aliases.length) out[action.id] = { accelerator, aliases };
  }
  return out;
}

module.exports = { UI_SETTINGS_KEY, osOf, readShortcutOverrides, writeShortcutOverrides, validateShortcutOverrides, menuAccelerators };
