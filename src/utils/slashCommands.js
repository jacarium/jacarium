/**
 * The built-in entries of the Documents editor's "/" popup
 * (src/components/features/documents/DocumentEditor.jsx): the five callouts
 * (src/utils/callouts.js) and the three Quick panels. They sit above the
 * user's templates in the one popup, filtered by what is typed after the
 * slash (the name, the label, the aliases), and nothing runs on typing
 * alone: Enter or a click runs the highlighted entry, Escape leaves the
 * typed text as it was.
 *
 * An entry with `content` is inserted where the command was typed (like a
 * template); an entry with `action` opens its panel ('workflow', 'ai',
 * 'task' - the editor's own handlers), the typed command staying in the
 * text until the panel's result replaces it, as before.
 */
import { CALLOUT_COMMANDS } from './callouts.js';

export const QUICK_COMMANDS = Object.freeze([
  Object.freeze({ id: 'quick-workflow', name: '/wf', label: 'Quick Workflow', description: 'Run a workflow and insert its result', aliases: ['wf', 'workflow'], action: 'workflow', builtin: true }),
  Object.freeze({ id: 'quick-ai', name: '/ai', label: 'Quick AI', description: 'Ask the assistant and insert its answer', aliases: ['ai', 'assistant'], action: 'ai', builtin: true }),
  Object.freeze({ id: 'quick-task', name: '/task', label: 'Quick Task', description: 'Create a task from here', aliases: ['task', 'tasks', 'todo'], action: 'task', builtin: true }),
]);

/** Every built-in entry, in the order the popup lists them. */
export const BUILTIN_COMMANDS = Object.freeze([
  ...CALLOUT_COMMANDS.map((c) => Object.freeze({ ...c, label: `${c.description.replace(/ callout$/, '')} callout`, aliases: [c.type] })),
  ...QUICK_COMMANDS,
]);

/**
 * Does `entry` (a built-in or a template) match what was typed after the
 * slash? Case-insensitive; the name ("/wf" or "wf"), the label, the
 * description, the aliases and the tags all count, as the template filter
 * always did. An empty query matches everything.
 */
export function matchesSlashQuery(entry, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const fields = [entry.name, entry.label, entry.description, ...(entry.aliases || []), ...(entry.tags || [])]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase().replace(/^\//, ''));
  return fields.some((v) => v.includes(q));
}

/**
 * Where a "/" opens the popup: the slash starts a word (the line's start or
 * after whitespace), nothing but word characters follow it up to the
 * cursor, and the cursor is not inside a fenced code block or inline code.
 * Returns the query (the text after the slash) or null.
 */
export function slashQueryAt(textBeforeCursor) {
  const m = /(?:^|\s)\/(\w*)$/.exec(textBeforeCursor);
  if (!m) return null;
  if (isInsideCode(textBeforeCursor)) return null;
  return m[1];
}

/** Inside a ``` fence (an odd number of fence lines above), or inside inline code on the current line (an odd number of backticks before the cursor)? */
export function isInsideCode(textBeforeCursor) {
  const fences = (textBeforeCursor.match(/^[ \t]*(```|~~~)/gm) || []).length;
  if (fences % 2 === 1) return true;
  const line = textBeforeCursor.slice(textBeforeCursor.lastIndexOf('\n') + 1);
  const ticks = (line.match(/`/g) || []).length;
  return ticks % 2 === 1;
}
