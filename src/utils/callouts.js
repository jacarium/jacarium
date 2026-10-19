/**
 * The GitHub-style callouts of Documents markdown, as the editor offers
 * them: the five types the preview renders (src/utils/interactiveMarkdown.js
 * renderer.blockquote) and the slash-menu entries that insert them.
 *
 *   > [!NOTE]      > [!TIP]      > [!IMPORTANT]      > [!WARNING]      > [!CAUTION]
 *
 * A plain data module (no components in it): the editor pairs each type
 * with its lucide icon itself.
 */

/** The types in the order the menus list them. */
export const CALLOUT_TYPES = Object.freeze([
  { type: 'note', label: 'Note' },
  { type: 'tip', label: 'Tip' },
  { type: 'important', label: 'Important' },
  { type: 'warning', label: 'Warning' },
  { type: 'caution', label: 'Caution' },
]);

/** The markdown a new callout of `type` starts with (the marker line, an empty quoted line to type into). */
export function calloutMarkdown(type) {
  return `> [!${String(type).toUpperCase()}]\n> `;
}

/**
 * Slash-menu entries ("/note" ... "/caution"), shaped like the document
 * templates the menu lists, so they are filtered and inserted the same way
 * (insertTemplate puts `content` where the command was typed).
 */
export const CALLOUT_COMMANDS = Object.freeze(CALLOUT_TYPES.map((c) => Object.freeze({
  id: `callout-${c.type}`,
  type: c.type,
  name: `/${c.type}`,
  description: `${c.label} callout`,
  content: calloutMarkdown(c.type),
  builtin: true,
})));
