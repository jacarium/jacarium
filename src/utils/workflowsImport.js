/**
 * "Import from JSON" on the Workflows page: the workflows a file or a paste
 * holds - an array, the format of the JSON exports (workflowTransfer.js) -
 * run through src/utils/jsonImportMerge.js:
 *
 *   merge off  one createWorkflow() per item with the importer's defaults
 *              (title "Imported Workflow", category "General", empty nodes
 *              and edges), as the page's file picker and the Base64 import
 *              always did (useWorkflowLibraryActions importWorkflowList);
 *   merge on   a workflow already here (same syncId, else the same title
 *              and category) is updated - title, category, nodes, edges -
 *              when the file's copy is newer (updatedAt), completed when
 *              the local one has blank fields, skipped when older or
 *              identical; the rest are added. Cloud fields (inCloud,
 *              ownerId, permissions) are this device's and stay as they are.
 */
import { db } from '../db/database';
import { createWorkflow } from './workflows';
import { keyPart, joinKey } from './mergeCore';
import { runJsonImport } from './jsonImportMerge';

export { validateWorkflowsImport } from './workflowTransfer';

const workflowKey = (w) => joinKey(keyPart(w.title, 'Imported Workflow'), keyPart(w.category, 'General'));
const workflowLabel = (w) => `${keyPart(w.title, 'Imported Workflow')} / ${keyPart(w.category, 'General')}`;

/** The fields the importer takes from a file item (importWorkflowList's rule). */
export function importedWorkflowFields(rest) {
  return {
    title: rest.title || 'Imported Workflow',
    category: rest.category || 'General',
    nodes: Array.isArray(rest.nodes) ? rest.nodes : [],
    edges: Array.isArray(rest.edges) ? rest.edges : [],
  };
}

/** Runs the import (or its dry run): { kind, mode: 'workflows', summary, totals }. */
export function runWorkflowsImport(items, { dryRun = false, mergeMode = false } = {}) {
  return runJsonImport(items, {
    dryRun, mergeMode, type: 'workflows', table: db.workflows, keyOf: workflowKey, labelOf: workflowLabel,
    prepare: (rest, local) => {
      const fields = importedWorkflowFields(rest);
      if (!mergeMode) return fields;
      return {
        ...fields,
        inCloud: local?.inCloud ?? false,
        ownerId: local?.ownerId ?? null,
        cloudLastUpdated: local?.cloudLastUpdated ?? null,
        ...(local?.permissions !== undefined ? { permissions: local.permissions } : {}),
        ...(rest.syncId ? { syncId: rest.syncId } : {}),
        createdAt: local?.createdAt ?? rest.createdAt ?? Date.now(),
        updatedAt: rest.updatedAt ?? Date.now(),
      };
    },
    createOne: (record) => createWorkflow(record),
  });
}
