/**
 * Cut / Copy / Paste for the Documents editor's right-click menu
 * (src/components/features/documents/TextSelectionMenu.jsx), behaving like
 * Cmd/Ctrl+X / C / V on the editor. The editor is the CodeMirror surface
 * (src/components/features/documents/codemirror/CodeMirrorSurface.js),
 * addressed through the textarea API it answers - `value`, the selection,
 * `focus`, `readOnly` - so a plain textarea works here too:
 *
 *   - whether each item is enabled is decided here from three facts: is
 *     there a selection, is the editor editable (not read-only), and what
 *     the clipboard holds - 'text', 'empty', or 'unknown' when the browser
 *     will not say (permission denied, no Clipboard API): then Paste stays
 *     enabled and an empty clipboard pastes nothing, rather than hiding a
 *     working Paste;
 *   - the clipboard is read through the async Clipboard API (readText) - no
 *     preload bridge: Electron's renderer has the same API and grants it.
 *     While the menu opens it is only read where that shows nothing
 *     (peekClipboardState); Paste itself reads, and a browser may then ask;
 *   - Cut and Copy run the editor's own commands on the restored selection
 *     (document.execCommand('cut' / 'copy') - what the keys do: the same
 *     clipboard write, the same `input` event with inputType deleteByCut,
 *     the same undo entry for Cut); Paste inserts the clipboard's text at
 *     the selection with execCommand('insertText'), the same `input` path
 *     Cmd/Ctrl+V takes into the editor's onChange (and so into Yjs for a
 *     live document) and the same native undo stack. Where execCommand is
 *     not available (jsdom) the surface's own insertText does the edit (a
 *     typed change: onChange, history), or a textarea's value is edited and
 *     `input` dispatched, so the editor still sees the change.
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

/**
 * The same question, asked while the menu OPENS - so only where asking is silent. A clipboard read is not silent
 * in every browser: Safari and Firefox answer a page's read with a "Paste" button of their own at the pointer
 * (and wait for it), and Chromium asks for the permission the first time. Opening our menu must never bring
 * that up - it would stand where the menu is. So:
 *   - the desktop app reads (its renderer is granted the clipboard; nothing is shown);
 *   - a browser reads only when it says the permission is already granted (Chromium, once the user allowed it);
 *   - otherwise 'unknown': Paste stays enabled, and choosing it is the user's own request to read.
 */
export async function peekClipboardState({ nav = typeof navigator !== 'undefined' ? navigator : null, win = typeof window !== 'undefined' ? window : undefined } = {}) {
  if (win && win.electronAPI) return readClipboardState(nav);
  const permissions = nav && nav.permissions;
  if (!permissions || typeof permissions.query !== 'function') return 'unknown';
  try {
    const status = await permissions.query({ name: 'clipboard-read' });
    if (!status || status.state !== 'granted') return 'unknown';
  } catch {
    return 'unknown';   // the browser does not know this permission (Safari, Firefox): reading would show its Paste button
  }
  return readClipboardState(nav);
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

// The edit as the editor notices it: the surface's insertText over the selection, or a textarea's value
// through the prototype's setter followed by `input`, with the caret after the edit
function setValue(textarea, value, caret, inputType) {
  if (typeof textarea.insertText === 'function') {
    const from = textarea.selectionStart;
    const to = textarea.selectionEnd;
    textarea.insertText(inputType === 'deleteByCut' ? '' : value.slice(from, caret));
    try { textarea.setSelectionRange(caret, caret); } catch { /* best effort */ }
    void to;
    return;
  }
  const proto = Object.getPrototypeOf(textarea);
  const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(textarea, value); else textarea.value = value;
  try { textarea.setSelectionRange(caret, caret); } catch { /* best effort */ }
  const win = textarea.ownerDocument && textarea.ownerDocument.defaultView;
  const EventCtor = (win && typeof win.InputEvent === 'function') ? win.InputEvent : (typeof InputEvent === 'function' ? InputEvent : (win && win.Event) || Event);
  textarea.dispatchEvent(new EventCtor('input', { bubbles: true, inputType }));
}
