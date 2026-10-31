/**
 * Home / End in the Documents editor move to the start / end of the current
 * line, as on Windows, Linux and in code editors (a macOS textarea would
 * scroll to the start / end of the whole document instead; Cmd/Ctrl+Home/End
 * still do that).
 *
 * "Line" is the logical line, up to the next newline. Home is a smart Home:
 * the first press goes to the line's first non-blank character, a second
 * press (already there) to column 0 - so an indented list item or code line
 * is one keypress from its text. A blank or unindented line goes to column 0.
 *
 * Pure: takes the text and the selection, returns the new selection, so the
 * editor applies it and the tests check it without a DOM.
 */

/** The bounds [start, end) of the logical line that contains position `pos`. */
export function lineAt(text, pos) {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const nl = text.indexOf('\n', pos);
  return [start, nl === -1 ? text.length : nl];
}

/**
 * The selection after Home / End.
 * key: 'Home' | 'End'; shift: extend the selection from its anchor.
 * selection: { start, end, direction } as a textarea reports them.
 * Returns { start, end, direction }.
 */
export function homeEndSelection(text, key, shift, { start, end, direction }) {
  // the end the user is moving (the focus) and the end that stays (the anchor)
  const backward = direction === 'backward';
  const focus = backward ? start : end;
  const anchor = backward ? end : start;
  const [lineStart, lineEnd] = lineAt(text, focus);
  let target;
  if (key === 'End') {
    target = lineEnd;
  } else {
    const indent = text.slice(lineStart, lineEnd).match(/^[ \t]*/)[0].length;
    const firstText = lineStart + indent;
    // a blank line, or already at the first character of the text: column 0
    target = firstText === lineEnd || focus === firstText ? lineStart : firstText;
  }
  if (!shift) return { start: target, end: target, direction: 'none' };
  return target < anchor
    ? { start: target, end: anchor, direction: 'backward' }
    : { start: anchor, end: target, direction: 'forward' };
}
