/**
 * "Import from JSON" on the Tasks page: the TaskWarrior instances a file
 * or a paste holds - an array, the format of "Export All (JSON)" - run
 * through src/utils/jsonImportMerge.js:
 *
 *   merge off  one createInstance() per item (its id dropped), as the
 *              page's file picker always did;
 *   merge on   an instance already here (same syncId, else the same name)
 *              is updated when the file's copy is newer (updatedAt),
 *              completed when the local one has blank fields, skipped when
 *              older or identical; the rest are added. isActive is this
 *              machine's state: a matched instance keeps its flag, an added
 *              one comes in inactive (the database import's rule), so a
 *              merge never ends with two active instances.
 */
import { db } from '../db/database';
import { createInstance } from './taskwarriorInstances';
import { keyPart, joinKey } from './mergeCore';
import { runJsonImport } from './jsonImportMerge';

/** true, or the message the old picker raised. */
export function validateInstancesImport(data) {
  if (!Array.isArray(data)) return 'Invalid format: Expected an array of task instances';
  if (data.length === 0) return 'Array is empty: No instances to import';
  const notObjects = data.map((b, i) => (b && typeof b === 'object' && !Array.isArray(b) ? null : i + 1)).filter(Boolean);
  if (notObjects.length) return `Invalid instance structure: Items at positions ${notObjects.join(', ')} are not instance objects`;
  return true;
}

const instanceKey = (i) => joinKey(keyPart(i.name, 'New Instance'));
const instanceLabel = (i) => keyPart(i.name, 'New Instance');

// The row createInstance() would store, with the local machine state kept
// on a match (used by the merge; merge off hands the item to createInstance)
function instanceRow(rest, local) {
  const now = new Date().toISOString();
  return {
    name: rest.name || 'New Instance',
    category: rest.category || 'General',
    description: rest.description || '',
    rcPath: rest.rcPath || '',
    dataPath: rest.dataPath || '',
    isActive: local ? local.isActive : 0,
    inCloud: local ? local.inCloud : (rest.inCloud ? 1 : 0),
    ownerId: local ? local.ownerId : (rest.ownerId || null),
    permissions: local ? local.permissions : (rest.permissions || null),
    cloudDocumentId: local ? local.cloudDocumentId : (rest.cloudDocumentId || null),
    ...(rest.syncId ? { syncId: rest.syncId } : {}),
    createdAt: local?.createdAt ?? rest.createdAt ?? now,
    updatedAt: rest.updatedAt ?? now,
  };
}

/** Runs the import (or its dry run): { kind, mode: 'taskwarriorInstances', summary, totals }. */
export function runInstancesImport(items, { dryRun = false, mergeMode = false } = {}) {
  return runJsonImport(items, {
    dryRun, mergeMode, type: 'taskwarriorInstances', table: db.taskwarriorInstances, keyOf: instanceKey, labelOf: instanceLabel,
    prepare: (rest, local) => (mergeMode ? instanceRow(rest, local) : rest),
    createOne: async (record) => (await createInstance(record)).id,
  });
}
