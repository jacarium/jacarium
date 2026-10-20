/**
 * Keyboard shortcut labels that match the user's platform - the older
 * entry point, kept for callers that format a fixed chord. The registry
 * (src/shortcuts/registry.js) is where chords are defined and matched;
 * a component that shows an ACTION's chord uses useShortcutLabel /
 * useShortcutHint (src/shortcuts/useShortcut.js), which follow the user's
 * bindings.
 *
 * macOS has no Alt key (it is Option) and its main modifier is Command, so
 * "Ctrl+Alt+1" is wrong there: a Mac shows the symbols, in Apple's order -
 * control, option, shift, command, then the key (⌥⌘1, ⌘B, ⇧⇥). Windows and
 * Linux show "Ctrl+Alt+1", "Ctrl+B", "Shift+Tab".
 *
 * A shortcut is written platform-free: "Mod+B", "Mod+Alt+1", "Shift+Tab",
 * "Tab". "Mod" is Command on a Mac and Ctrl elsewhere; "Alt" is Option on a
 * Mac.
 */
import { formatChord, legacyToChord, hasMod as hasModChord } from '../shortcuts/registry.js';
import { detectOs } from '../shortcuts/store.js';

/** Is this a Mac (or an iOS device)? Electron's process.platform (exposed by the preload as electronAPI.platform) when available, else the browser's platform. */
export function isMac() {
  return detectOs() === 'mac';
}

/**
 * The label of a platform-free chord ("Mod+Alt+1", "Shift+Tab") for the
 * current platform, or for `mac` when given (tests).
 */
export function formatShortcut(chord, mac = isMac()) {
  return formatChord(legacyToChord(chord), { mac });
}

/** Does the keyboard event carry the platform's main modifier (Command on a Mac, Ctrl elsewhere) - and only that one? */
export function hasMod(e, mac = isMac()) {
  return hasModChord(e, mac);
}
