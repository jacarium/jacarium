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

/**
 * The "Import from JSON" modal's validation of parsed data: true, or the
 * message the importer always raised for a non-array.
 */
export function validateWorkflowsImport(data) {
  if (!Array.isArray(data)) return 'Invalid workflow file format. Expected an array of workflows.';
  if (data.length === 0) return 'Array is empty: No workflows to import';
  const notObjects = data.map((w, i) => (w && typeof w === 'object' && !Array.isArray(w) ? null : i + 1)).filter(Boolean);
  if (notObjects.length) return `Invalid workflow structure: Items at positions ${notObjects.join(', ')} are not workflow objects`;
  return true;
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
