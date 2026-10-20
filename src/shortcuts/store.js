/**
 * The bindings in force on this device: the registry's defaults
 * (src/shortcuts/registry.js) under the user's overrides. One store for
 * the whole renderer: the keydown dispatcher (useShortcut.js), the Settings
 * > Shortcuts tab and every tooltip read it; `subscribe` tells them about a
 * change.
 *
 * Persistence is per device, never part of the settings scopes (This
 * device / My account / Everyone) and never in the env file: the desktop
 * keeps the overrides in the profile's ui-settings.json through the main
 * process (which also rebuilds the menu's accelerators), a browser keeps
 * them in localStorage. Only the differences from the defaults are stored,
 * as { version, overrides: { actionId: chord | null } } (null = unassigned
 * on purpose), so a release's new defaults apply by themselves.
 */
import { ACTIONS, SCHEMA_VERSION, STORAGE_KEY, actionById, defaultChord, formatChord, normalizeOverrides, platformOf, resolveBindings } from './registry.js';

let overrides = {};
let loaded = false;
let recording = false;   // the Settings recorder is capturing a chord: the dispatcher stays out
let bindings = null;
const listeners = new Set();

function emit() {
  bindings = null;
  for (const fn of listeners) fn();
}

/** 'mac' | 'linux' | 'win' - Electron's process.platform when available, else the browser's. */
export function detectOs() {
  if (typeof window !== 'undefined' && window.electronAPI?.platform) {
    const p = window.electronAPI.platform;
    return p === 'darwin' ? 'mac' : p === 'win32' ? 'win' : 'linux';
  }
  if (typeof navigator === 'undefined') return 'linux';
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/Mac|iPhone|iPad|iPod/i.test(platform)) return 'mac';
  if (/Win/i.test(platform)) return 'win';
  if (platform) return 'linux';
  if (/Mac OS X|Macintosh/i.test(navigator.userAgent || '')) return 'mac';
  if (/Windows/i.test(navigator.userAgent || '')) return 'win';
  return 'linux';
}

export const isMacOs = () => detectOs() === 'mac';
/** 'desktop' when the Electron bridge is present, else 'web'. */
export const buildKind = () => (typeof window !== 'undefined' && window.electronAPI ? 'desktop' : 'web');
const bridge = () => (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.getShortcuts === 'function' ? window.electronAPI : null);

export function getOverrides() {
  return overrides;
}

/** { actionId: chord | null } for this device. */
export function getBindings() {
  if (!bindings) bindings = resolveBindings(overrides, platformOf(detectOs()));
  return bindings;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Replace the overrides in memory (no persistence); returns the ids dropped as invalid. */
export function setOverrides(raw) {
  const cleaned = normalizeOverrides(raw);
  overrides = cleaned.overrides;
  loaded = true;
  emit();
  return cleaned.dropped;
}

function readLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return raw && typeof raw === 'object' ? raw.overrides : null;
  } catch { return null; }
}

function writeLocal(next) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, overrides: next })); } catch { /* storage unavailable */ }
}

/**
 * Load this device's overrides: from the main process on the desktop (and
 * follow its 'shortcuts-changed' broadcasts: another window, or a reset),
 * from localStorage in a browser. Safe to call more than once.
 */
let unsubscribeBridge = null;
export async function loadOverrides() {
  const api = bridge();
  if (api) {
    try {
      const state = await api.getShortcuts();
      setOverrides(state?.overrides || {});
    } catch { setOverrides({}); }
    if (!unsubscribeBridge && typeof api.onShortcutsChanged === 'function') {
      unsubscribeBridge = api.onShortcutsChanged((state) => setOverrides(state?.overrides || {}));
    }
  } else {
    setOverrides(readLocal() || {});
  }
  return overrides;
}

export function isLoaded() {
  return loaded;
}

/** While the Settings > Shortcuts recorder captures a chord, no shortcut fires. */
export function setRecording(on) {
  recording = !!on;
}
export function isRecording() {
  return recording;
}

/**
 * Persist new overrides for this device. The desktop's main process
 * validates them again, writes ui-settings.json and rebuilds the menu; a
 * browser writes localStorage. Resolves to { ok, errors } - on a refusal
 * the store keeps the previous overrides.
 */
export async function saveOverrides(next) {
  const cleaned = normalizeOverrides(next).overrides;
  const api = bridge();
  if (api) {
    const result = await api.setShortcuts(cleaned);
    if (result && result.ok === false) return result;
    setOverrides(result?.overrides || cleaned);
    return { ok: true };
  }
  writeLocal(cleaned);
  setOverrides(cleaned);
  return { ok: true };
}

/** Bind one action (chord, or null to unassign); `alsoUnassign` clears the action whose chord it takes over. */
export async function bindAction(actionId, chord, { alsoUnassign = null } = {}) {
  const action = actionById(actionId);
  if (!action) return { ok: false, errors: ['unknown action'] };
  const platform = platformOf(detectOs());
  const next = { ...overrides };
  if (chord === defaultChord(action, platform)) delete next[actionId]; else next[actionId] = chord;
  if (alsoUnassign && alsoUnassign !== actionId) {
    const other = actionById(alsoUnassign);
    if (other) { if (defaultChord(other, platform) === null) delete next[alsoUnassign]; else next[alsoUnassign] = null; }
  }
  return saveOverrides(next);
}

export async function resetAction(actionId) {
  const next = { ...overrides };
  delete next[actionId];
  return saveOverrides(next);
}

export async function resetAll() {
  return saveOverrides({});
}

/** The label of an action's current chord ('' when unassigned). */
export function labelFor(actionId, layout = null) {
  return formatChord(getBindings()[actionId], { mac: isMacOs(), layout });
}

export { ACTIONS };
