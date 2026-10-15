/**
 * Pure helpers for the Tasks page's "Create Document In" action: turn a
 * TaskWarrior task into the record handed to createDocument().
 */

/** Title used when a task has no usable text (the Documents page's own default). */
export const UNTITLED_DOCUMENT_TITLE = 'Untitled Document';

/**
 * Longest title we mint from a task. Document titles are single-line labels
 * (sidebar rows, tabs, exports); TaskWarrior descriptions are normally a
 * sentence, but nothing stops a very long one, so cut it rather than
 * produce an unusable title. The user can retitle in the editor.
 */
export const MAX_TASK_DOCUMENT_TITLE_LENGTH = 200;

/**
 * Document title for a task: its description trimmed, inner whitespace
 * (including newlines) collapsed to single spaces, cut to
 * MAX_TASK_DOCUMENT_TITLE_LENGTH with an ellipsis, and falling back to
 * "Untitled Document" when empty. Duplicate titles are allowed - the
 * Documents page never enforces unique titles (documents are identified
 * by id), so two tasks with the same text simply produce two documents.
 *
 * @param {string|null|undefined} description
 * @returns {string}
 */
export function documentTitleFromTask(description) {
  const text = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';
  if (!text) return UNTITLED_DOCUMENT_TITLE;
  if (text.length <= MAX_TASK_DOCUMENT_TITLE_LENGTH) return text;
  return `${text.slice(0, MAX_TASK_DOCUMENT_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * The record for createDocument(): title from the task, an empty body (a
 * new document on the Documents page starts empty too) and the chosen
 * category. No task metadata is written into the document - see the
 * feature notes; linking is a separate decision.
 *
 * @param {{ description?: string }} task
 * @param {string} category
 * @returns {{ title: string, content: string, category: string }}
 */
export function buildDocumentFromTask(task, category) {
  return {
    title: documentTitleFromTask(task && task.description),
    content: '',
    category: (typeof category === 'string' && category.trim()) || 'General',
  };
}
