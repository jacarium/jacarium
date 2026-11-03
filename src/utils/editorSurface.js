/**
 * Whether the Documents editor checks spelling: Settings > Editor.
 * The native checker (Chromium's, the OS's on macOS) runs on the editor's
 * content; the Markdown code, URLs and directives are marked for it to
 * skip (src/components/features/documents/codemirror/spellcheckSkip.js). A
 * plain localStorage key, like the other per-device settings
 * (src/utils/openTabsSync.js), with a window event so an open editor
 * follows a change made in Settings without a reload.
 */

export const SPELLCHECK_SETTING = 'documentsSpellcheck';
export const SPELLCHECK_CHANGED_EVENT = 'documentsSpellcheckChanged';

const storage = () => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
};

/** Spell checking in the editor: on unless switched off. */
export function isSpellcheckEnabled() {
  return storage()?.getItem(SPELLCHECK_SETTING) !== 'false';
}

export function setSpellcheckEnabled(on) {
  try { storage()?.setItem(SPELLCHECK_SETTING, on ? 'true' : 'false'); } catch { /* storage unavailable: the choice lasts the session */ }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent(SPELLCHECK_CHANGED_EVENT));
}
