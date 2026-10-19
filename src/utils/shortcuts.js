/**
 * Keyboard shortcut labels that match the user's platform.
 *
 * macOS has no Alt key (it is Option) and its main modifier is Command, so
 * "Ctrl+Alt+1" is wrong there: a Mac shows the symbols, in Apple's order -
 * control, option, shift, command, then the key (⌥⌘1, ⌘B, ⇧⇥). Windows and
 * Linux show "Ctrl+Alt+1", "Ctrl+B", "Shift+Tab".
 *
 * A shortcut is written platform-free: "Mod+B", "Mod+Alt+1", "Shift+Tab",
 * "Tab". "Mod" is Command on a Mac and Ctrl elsewhere; "Alt" is Option on a
 * Mac. The handlers that bind these chords check metaKey on a Mac and
 * ctrlKey elsewhere (isMac), and a chord with Alt by e.code, because Option
 * changes e.key on a Mac (⌥1 gives "¡").
 */

const MAC_KEYS = { Tab: '⇥', Enter: '↩', Escape: '⎋', Backspace: '⌫', Delete: '⌦', Space: '␣', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const MAC_MODS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod'];
const OTHER_MODS = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Mod: 'Ctrl' };
const OTHER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'];

/** Is this a Mac (or an iOS device)? Electron's process.platform (exposed by the preload as electronAPI.platform) when available, else the browser's platform. */
export function isMac() {
  if (typeof window !== 'undefined' && window.electronAPI?.platform) return window.electronAPI.platform === 'darwin';
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/Mac|iPhone|iPad|iPod/i.test(platform)) return true;
  if (platform) return false;
  return /Mac OS X|Macintosh/i.test(navigator.userAgent || '');
}

/**
 * The label of a platform-free chord ("Mod+Alt+1", "Shift+Tab") for the
 * current platform, or for `mac` when given (tests).
 */
export function formatShortcut(chord, mac = isMac()) {
  const parts = String(chord).split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mac) {
    const ordered = MAC_ORDER.filter((m) => mods.includes(m)).map((m) => MAC_MODS[m]);
    const k = MAC_KEYS[key] || (key.length === 1 ? key.toUpperCase() : key);
    return ordered.join('') + k;
  }
  const ordered = OTHER_ORDER.filter((m) => mods.includes(m)).map((m) => OTHER_MODS[m]);
  const k = key.length === 1 ? key.toUpperCase() : key;
  return [...ordered, k].join('+');
}

/** Does the keyboard event carry the platform's main modifier (Command on a Mac, Ctrl elsewhere) - and only that one? */
export function hasMod(e, mac = isMac()) {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
