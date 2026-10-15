/**
 * Workflows as a JSON file: what "Export ... (JSON)" writes and "Import from
 * JSON" reads. The file is always an ARRAY of workflow objects - also for a
 * single workflow - so any exported file re-imports as it is.
 */
import { dateStamp } from './exportHelpers';

/** The JSON text of an export (pretty-printed, as "Export All" always was). */
export function serializeWorkflows(workflows) {
  return JSON.stringify(workflows, null, 2);
}

/**
 * The workflows in an exported file's text, or null when the text is not a
 * JSON array (the importer reports that as an invalid format). Malformed
 * JSON throws, as JSON.parse does.
 */
export function parseWorkflowsExport(text) {
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : null;
}

/** A filesystem-safe version of a title: lower-case, dashes, no punctuation. */
export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * The file name for an export: one workflow -> its title (`my-workflow.json`,
 * `workflow.json` when the title is empty); a category ->
 * `<category>-workflows-YYYY-MM-DD.json`; anything else ->
 * `workflows-export-YYYY-MM-DD.json`.
 */
export function workflowExportFileName({ workflows, category = null }) {
  if (category) {
    return `${slugify(category) || 'category'}-workflows-${dateStamp()}.json`;
  }
  if (workflows.length === 1) {
    return `${slugify(workflows[0].title) || 'workflow'}.json`;
  }
  return `workflows-export-${dateStamp()}.json`;
}
