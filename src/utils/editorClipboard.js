/**
 * Cut / Copy / Paste for the Documents editor's right-click menu
 * (src/components/features/documents/TextSelectionMenu.jsx), behaving like
 * Cmd/Ctrl+X / C / V on the same textarea:
 *
 *   - whether each item is enabled is decided here from three facts: is
 *     there a selection, is the editor editable (not read-only), and what
 *     the clipboard holds - 'text', 'empty', or 'unknown' when the browser
 *     will not say (permission denied, no Clipboard API): then Paste stays
 *     enabled and an empty clipboard pastes nothing, rather than hiding a
 *     working Paste;
 *   - the clipboard is read through the async Clipboard API (readText, then
 *     read() for non-text items) - no preload bridge: Electron's renderer
 *     has the same API and grants it; a browser may ask once;
 *   - Cut and Copy run the editor's own commands on the restored selection
 *     (document.execCommand('cut' / 'copy') - what the keys do: the same
 *     clipboard write, the same `input` event with inputType deleteByCut,
 *     the same undo entry for Cut); Paste inserts the clipboard's text at
 *     the selection with execCommand('insertText'), the same `input` path
 *     Cmd/Ctrl+V takes into the editor's onChange (and so into Yjs for a
 *     live document) and the same native undo stack. Where execCommand is
 *     not available (jsdom) the value is edited and `input` dispatched, so
 *     the editor still sees the change.
 */
import { formatShortcut } from './shortcuts';

/** Which of Cut / Copy / Paste are enabled: { cut, copy, paste }. */
export function clipboardMenuState({ hasSelection = false, editable = true, clipboard = 'unknown' } = {}) {
  return {
    copy: !!hasSelection,
    cut: !!hasSelection && !!editable,
    paste: !!editable && clipboard !== 'empty',
  };
}

/** The labels shown at the items' right, for the platform (⌘X on a Mac, Ctrl+X elsewhere). */
export function clipboardShortcuts(mac) {
  return { cut: formatShortcut('Mod+X', mac), copy: formatShortcut('Mod+C', mac), paste: formatShortcut('Mod+V', mac) };
}

/**
 * What the clipboard holds, for the Paste item: 'text' (something to paste
 * into a textarea), 'empty' (nothing, or only non-text such as an image,
 * which a textarea cannot take), 'unknown' (the API is missing or the
 * browser refused to say - permission denied, no secure context).
 */
export async function readClipboardState(nav = typeof navigator !== 'undefined' ? navigator : null) {
  const clipboard = nav && nav.clipboard;
  if (!clipboard || typeof clipboard.readText !== 'function') return 'unknown';
  try {
    const text = await clipboard.readText();
    if (typeof text === 'string' && text.length > 0) return 'text';
  } catch {
    return 'unknown';
  }
  // readText gave nothing: an image or a file may be there, which a textarea cannot take - still 'empty' for it
  return 'empty';
}

const restoreSelection = (textarea, start, end) => {
  textarea.focus();
  if (typeof start === 'number' && typeof end === 'number') {
    try { textarea.setSelectionRange(start, end); } catch { /* a detached or hidden control */ }
  }
};

const exec = (command, value) => {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  try { return document.execCommand(command, false, value); } catch { return false; }
};

/** Copy the textarea's selection (restored to start..end when given) as Cmd/Ctrl+C would; true when something was copied. */
export async function copySelection(textarea, { start, end, nav = typeof navigator !== 'undefined' ? navigator : null } = {}) {
  if (!textarea) return false;
  restoreSelection(textarea, start, end);
  const text = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
  if (!text) return false;
  if (exec('copy')) return true;
  // no execCommand (jsdom): the Clipboard API, when there is one
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    try { await nav.clipboard.writeText(text); return true; } catch { return false; }
  }
  return false;
}

/** Cut the textarea's selection as Cmd/Ctrl+X would (the editor's input event, the native undo entry); true when something was cut. */
export async function cutSelection(textarea, { start, end, nav = typeof navigator !== 'undefined' ? navigator : null } = {}) {
  if (!textarea || textarea.readOnly || textarea.disabled) return false;
  restoreSelection(textarea, start, end);
  const from = textarea.selectionStart;
  const to = textarea.selectionEnd;
  const text = textarea.value.slice(from, to);
  if (!text) return false;
  if (exec('cut')) return true;
  // no execCommand: write the clipboard, then edit the value and tell the editor
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    try { await nav.clipboard.writeText(text); } catch { /* the clipboard is not ours to write: the text is still removed, as a cut would */ }
  }
  setValue(textarea, textarea.value.slice(0, from) + textarea.value.slice(to), from, 'deleteByCut');
  return true;
}

/**
 * Paste the clipboard's text at the textarea's selection as Cmd/Ctrl+V would;
 * resolves to the text pasted ('' when the clipboard had none or could not
 * be read - nothing happens then).
 */
export async function pasteInto(textarea, { start, end, nav = typeof navigator !== 'undefined' ? navigator : null } = {}) {
  if (!textarea || textarea.readOnly || textarea.disabled) return '';
  const clipboard = nav && nav.clipboard;
  if (!clipboard || typeof clipboard.readText !== 'function') return '';
  let text = '';
  try { text = await clipboard.readText(); } catch { return ''; }
  if (typeof text !== 'string' || !text) return '';
  restoreSelection(textarea, start, end);
  if (exec('insertText', text)) return text;
  const from = textarea.selectionStart;
  const to = textarea.selectionEnd;
  setValue(textarea, textarea.value.slice(0, from) + text + textarea.value.slice(to), from + text.length, 'insertFromPaste');
  return text;
}

// The value set the way React's onChange notices (the prototype's setter, then `input`), with the caret after the edit
function setValue(textarea, value, caret, inputType) {
  const proto = Object.getPrototypeOf(textarea);
  const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(textarea, value); else textarea.value = value;
  try { textarea.setSelectionRange(caret, caret); } catch { /* best effort */ }
  const win = textarea.ownerDocument && textarea.ownerDocument.defaultView;
  const EventCtor = (win && typeof win.InputEvent === 'function') ? win.InputEvent : (typeof InputEvent === 'function' ? InputEvent : (win && win.Event) || Event);
  textarea.dispatchEvent(new EventCtor('input', { bubbles: true, inputType }));
}
