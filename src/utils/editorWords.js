/**
 * The word under a right-click in the Documents editor, for the spelling
 * suggestions of the right-click menu (TextSelectionMenu): a suggestion
 * replaces exactly this range, as an ordinary edit.
 */
// As { from, to, text }, or null: the view resolves the pointer to a
// document position and the word around it is taken. Letters, digits,
// apostrophes and hyphens make a word, as Chromium's checker sees one.
const WORD_CHAR = /[\p{L}\p{N}'\u2019-]/u;
export function wordAtPointer(surface, event) {
  if (!surface) return null;
  const text = surface.value;
  const pos = surface.view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return null;
  let from = pos;
  let to = pos;
  while (from > 0 && WORD_CHAR.test(text[from - 1])) from--;
  while (to < text.length && WORD_CHAR.test(text[to])) to++;
  if (to <= from) return null;
  return { from, to, text: text.slice(from, to) };
}
