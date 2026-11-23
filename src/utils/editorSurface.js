/**
 * Whether the Documents editor checks spelling: Settings > Editor.
 * The native checker (Chromium's, the OS's on macOS) runs on the editor's
 * content; the Markdown code, URLs and directives are marked for it to
 * skip (src/components/features/documents/codemirror/spellcheckSkip.js). A
 * plain localStorage key, like the other per-device settings
 * (src/utils/openTabsSync.js), with a window event so an open editor
 * follows a change made in Settings without a reload.
 */

import { isMac } from './shortcuts';

export const SPELLCHECK_SETTING = 'documentsSpellcheck';
export const SPELLCHECK_CHANGED_EVENT = 'documentsSpellcheckChanged';

const storage = () => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
};

/** Spell checking in the editor: on unless switched off. */
export function isSpellcheckEnabled() {
  return storage()?.getItem(SPELLCHECK_SETTING) !== 'false';
}

/**
 * Who shows spelling suggestions in an editor's right-click menu. The desktop app's main process reports the
 * flagged word and its suggestions (electronAPI.onEditorContextMenu), and they join OUR menu. A browser tells a
 * page nothing about its spell checker, so there the suggestions only exist in the browser's own menu.
 */
export function browserOwnsSpelling(win = typeof window !== 'undefined' ? window : undefined) {
  return typeof win?.electronAPI?.onEditorContextMenu !== 'function';
}

/**
 * True when this right-click is left to the browser: in a browser, Shift + right-click opens the browser's own
 * menu (with its spelling suggestions) - the handler must then neither preventDefault nor open ours. A plain
 * right-click is ours everywhere, and in the desktop app every right-click is.
 */
export function leavesMenuToBrowser(event, win = typeof window !== 'undefined' ? window : undefined) {
  return browserOwnsSpelling(win) && !!(event && event.shiftKey);
}

/**
 * A press of the right button. Only that: the left button is never looked at here, so Shift + click (extend the
 * selection), Shift + drag and a Mac's Ctrl + click stay exactly what the browser and the editor make of them.
 */
export function isRightPress(event) {
  return !!event && event.button === 2;
}

/**
 * The press of a Shift + RIGHT-click that is left to the browser's own menu (leavesMenuToBrowser), handled on
 * mousedown. Shift + click means "extend the selection" to a browser whatever the button, so that press would
 * select from the old caret to the pointer - and the browser's menu would then be about that range
 * ("Look Up ..."), with no spelling suggestions. The press is therefore taken (preventDefault: no extension):
 *   - inside a non-empty selection, the selection is left untouched (the browser's menu is about it: Copy,
 *     Look Up, ...);
 *   - elsewhere, the caret is put where the pointer is, as a plain right-click leaves it: the browser's menu is
 *     then about the word under the pointer (a Mac's browsers select that word themselves as the menu opens).
 * It is done on the press, not on the contextmenu event: Firefox does not send a page that event for
 * Shift + right-click at all. Nothing else that uses Shift is touched: the left button never gets here.
 * `surface` is the editor (CodeMirrorSurface: view.posAtCoords, the selection, setSelectionRange, focus).
 * Returns true when the press was taken.
 */
export function takeBrowserMenuPress(surface, event, { win = typeof window !== 'undefined' ? window : undefined } = {}) {
  if (!surface || !isRightPress(event) || !leavesMenuToBrowser(event, win)) return false;
  event.preventDefault();
  let pos = null;
  try { pos = surface.view.posAtCoords({ x: event.clientX, y: event.clientY }); } catch { pos = null; }
  if (pos != null) {
    const { selectionStart: from, selectionEnd: to } = surface;
    const insideSelection = to > from && pos >= from && pos <= to;
    if (!insideSelection) surface.setSelectionRange(pos, pos, 'none', { scrollIntoView: false });
  }
  surface.focus();   // the prevented press did not give it the focus
  return true;
}

/** The hint our menu shows in a browser while spell checking is on (the key as the platform writes it). */
export function spellingHintLabel(mac = isMac()) {
  return `Spelling suggestions: ${mac ? '\u21e7' : 'Shift'} + right-click`;
}

export function setSpellcheckEnabled(on) {
  try { storage()?.setItem(SPELLCHECK_SETTING, on ? 'true' : 'false'); } catch { /* storage unavailable: the choice lasts the session */ }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent(SPELLCHECK_CHANGED_EVENT));
}
