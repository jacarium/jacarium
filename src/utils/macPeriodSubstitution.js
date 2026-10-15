/**
 * Guard against macOS "Add period with double-space" in a plain-text editor.
 *
 * WHAT HAPPENS: with the macOS setting System Settings > Keyboard > Text
 * Input > Input Sources > Edit... > "Add period with double-space" turned on
 * (NSAutomaticPeriodSubstitutionEnabled, on by default), typing
 * `<char><space><space>` in ANY Chromium/Electron text field ends up as
 * `<char>.<space>`: AppKit's key-event interpretation asks the focused
 * NSTextInputClient (Chromium's RenderWidgetHostViewCocoa) to replace the
 * first space with ". " via -insertText:replacementRange:. Chromium forwards
 * that as an IME commit with a replacement range, which Blink applies with
 * InputMethodController::ReplaceTextAndMoveCaret(): it first moves the
 * selection onto the range being replaced (the existing space), then
 * dispatches a cancelable `beforeinput` with inputType "insertText" and
 * data ". ", then inserts. Nothing in the page's own keydown/keypress path
 * is involved, and `autocorrect="off"` / `spellcheck="false"` only gate
 * Chromium's separate NSSpellChecker substitutions (smart quotes/dashes,
 * text shortcuts), not this one.
 *
 * In a Markdown editor that is destructive: two trailing spaces are the
 * Markdown hard line break, and code blocks/tables rely on literal runs of
 * spaces. This guard cancels exactly that replacement and re-inserts the
 * space the keystroke was meant to type, so `a␣␣` stays `a␣␣`.
 *
 * It is deliberately narrow:
 *   - only `beforeinput` / inputType "insertText" / data ". " (a keyboard
 *     never delivers two characters in one insertText event);
 *   - only while the selection is a NON-EMPTY run of spaces (the range the OS
 *     is replacing). A user typing "." then " " arrives as two separate
 *     events with a collapsed selection and is left alone; so is a user who
 *     selected a space and typed "." (data "."), or any IME composition
 *     (isComposing / insertCompositionText).
 *   - the replacement space is inserted with document.execCommand('insertText')
 *     so it lands on the browser's native undo stack like a typed character
 *     (Cmd+Z still works). Where execCommand is unavailable (jsdom) it falls
 *     back to splicing the value and firing an `input` event so React's
 *     onChange still runs.
 *
 * Alternative for the user: turn the macOS setting off (affects every app),
 * or `defaults write <bundle id> NSAutomaticPeriodSubstitutionEnabled -bool
 * false` for this app only.
 */

const SUBSTITUTION_DATA = '. ';

/**
 * True when `event` (a `beforeinput` on `textarea`) is the macOS double-space
 * period substitution: an "insertText" of ". " replacing a selected run of
 * spaces. Read-only; does not touch the event.
 */
export function isMacPeriodSubstitution(event, textarea) {
  if (!event || !textarea) return false;
  if (event.inputType !== 'insertText' || event.isComposing) return false;
  if (event.data !== SUBSTITUTION_DATA) return false;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return false;
  const replaced = String(textarea.value).slice(start, end);
  return /^ +$/.test(replaced);
}

function insertSpaceAtCaret(textarea) {
  const doc = textarea.ownerDocument;
  let inserted = false;
  try {
    inserted = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, ' ') === true;
  } catch {
    inserted = false;
  }
  if (inserted) return 'execCommand';

  // Fallback (no execCommand): splice the value through the native setter so
  // React's value tracker sees the change, then notify listeners.
  const pos = textarea.selectionEnd;
  const value = String(textarea.value);
  const proto = Object.getPrototypeOf(textarea);
  const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  const next = value.slice(0, pos) + ' ' + value.slice(pos);
  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(textarea, next);
  } else {
    textarea.value = next;
  }
  textarea.setSelectionRange(pos + 1, pos + 1);
  const view = doc.defaultView || globalThis;
  const InputEventCtor = view.InputEvent || view.Event;
  textarea.dispatchEvent(new InputEventCtor('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
  return 'fallback';
}

/**
 * `beforeinput` handler. When the event is the macOS period substitution it
 * cancels it, collapses the selection after the space(s) the OS wanted to
 * replace and inserts the one space the keystroke stood for. Returns true
 * when it intervened, false when the event was left untouched.
 */
export function handleMacPeriodSubstitution(event) {
  const textarea = event && (event.currentTarget || event.target);
  if (!textarea || event.defaultPrevented) return false;
  if (!isMacPeriodSubstitution(event, textarea)) return false;

  event.preventDefault();
  const end = textarea.selectionEnd;
  textarea.setSelectionRange(end, end);
  insertSpaceAtCaret(textarea);
  return true;
}

/**
 * Attach the guard to a textarea (native listener - React's onBeforeInput
 * polyfill does not expose inputType). Returns the detach function.
 */
export function attachMacPeriodSubstitutionGuard(textarea) {
  if (!textarea || typeof textarea.addEventListener !== 'function') return () => {};
  textarea.addEventListener('beforeinput', handleMacPeriodSubstitution);
  return () => textarea.removeEventListener('beforeinput', handleMacPeriodSubstitution);
}
