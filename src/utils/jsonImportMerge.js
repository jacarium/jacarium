/**
 * The runner behind the Kanban, Tasks and Workflow "Import from JSON"
 * dialogs (src/components/common/ImportJsonModal.jsx), one per page in
 * kanbanImport.js / taskInstancesImport.js / workflowsImport.js. Mirrors
 * the Documents import (src/utils/documentImport.js runDocumentsImport):
 *
 *   merge off  every item is added as new through the page's own create
 *              function - the behaviour the pages always had;
 *   merge on   the database import's merge over the page's table
 *              (importDatabase.js mergeDexieTable): an item that matches a
 *              local row - by syncId when both carry one, else by the
 *              entity's natural key (board: title + category, instance:
 *              name, workflow: title + category) - is updated when the
 *              file's copy is strictly newer (updatedAt, createdAt as the
 *              fallback), completed when it is older but fills fields that
 *              are blank here, skipped when it is older or identical;
 *              anything unmatched is added.
 *
 * A dry run computes the same plan against the real local data with every
 * write a no-op (createWriter). The result is the ImportStats shape
 * ({ kind, mode, dryRun, mergeMode, summary: { <type>: row }, totals }) so
 * the modal shows it with the same block as Documents (JsonImportStats).
 */

const updatedOrCreated = (row) => row?.updatedAt ?? row?.createdAt;

/**
 * Natural-key matcher with the sync identity first: a renamed copy from the
 * same account still finds its row; a copy from elsewhere (different or no
 * syncId) matches by the key, as the database import matches these tables.
 */
function syncIdFirst(rows, keyOf) {
  const bySyncId = new Map();
  for (const row of rows) {
    if (typeof row.syncId === 'string' && row.syncId && !bySyncId.has(row.syncId)) bySyncId.set(row.syncId, row);
  }
  return (imported, localByKey) => {
    const sid = typeof imported.syncId === 'string' && imported.syncId ? imported.syncId : null;
    if (sid && bySyncId.has(sid)) return bySyncId.get(sid);
    const key = keyOf(imported);
    return key != null ? localByKey.get(key) : undefined;
  };
}

/**
 * @param {Array} items - the validated array from the file
 * @param {object} o
 * @param {boolean} o.dryRun
 * @param {boolean} o.mergeMode
 * @param {string} o.type - the summary key (a TYPE_LABELS key of ImportStats)
 * @param {import('dexie').Table} o.table
 * @param {(row) => string} o.keyOf - the natural key (mergeCore joinKey)
 * @param {(rest, local) => object|null} o.prepare - the row to write (null = invalid)
 * @param {(rest) => Promise} o.createOne - merge off: the page's create function
 * @param {object} [o.createDefaults] - defaults for rows the merge inserts
 * @param {string} [o.timestampField] - the field the table is listed by
 * @param {(imported) => string} [o.labelOf]
 * @param {(imported, localId, outcome) => void} [o.track]
 * @param {(imported, localRow) => void} [o.onCreated] - merge off, after createOne
 */
export async function runJsonImport(items, {
  dryRun = false, mergeMode = false, type, table, keyOf, prepare, createOne,
  createDefaults = {}, timestampField = 'updatedAt', labelOf, track, invalidReason = 'record cannot be imported',
}) {
  const { createWriter, newSummary, tally, tallyInvalid, mergeTotals, mergeDexieTable } = await import('./importDatabase');
  const list = Array.isArray(items) ? items : [];
  const label = (item) => (labelOf ? labelOf(item) : '');
  let row;
  if (mergeMode) {
    const rows = await table.toArray();
    row = await mergeDexieTable(table, list, keyOf, updatedOrCreated, {
      localRows: rows,
      findLocal: syncIdFirst(rows, keyOf),
      prepare, createDefaults, timestampField, labelOf, track, invalidReason,
      writer: createWriter(dryRun),
    });
  } else {
    row = newSummary();
    let nextDryId = -1; // a dry run hands track() a synthetic id, as the merge does
    for (const item of list) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        tallyInvalid(row, '', 'not a record object');
        continue;
      }
      try {
        const { id: _id, ...rest } = item;
        const record = prepare ? prepare(rest, undefined) : rest;
        if (record === null) {
          tallyInvalid(row, label(item), typeof invalidReason === 'function' ? invalidReason(item) : invalidReason);
          continue;
        }
        const id = dryRun ? nextDryId-- : await createOne(record, item);
        tally(row, 'created', label(item));
        track?.(item, id, 'created');
      } catch (error) {
        tallyInvalid(row, label(item), error?.message || String(error));
      }
    }
  }
  const summary = { [type]: row };
  return { kind: dryRun ? 'dry-run' : 'import', mode: type, dryRun, mergeMode, summary, totals: mergeTotals(summary) };
}

/** Label of the merge checkbox: "Keep existing boards and merge newer copies". */
export function jsonMergeLabel(plural) {
  return `Keep existing ${plural} and merge newer copies`;
}

/** Hint under the merge checkbox, in both states (as documentsMergeHint). */
export function jsonMergeHint(checked, { noun, plural, keyLabel }) {
  const Plural = plural.charAt(0).toUpperCase() + plural.slice(1);
  return checked
    ? `${Plural} already here (the same sync id, or the same ${keyLabel}) are kept: a newer copy from the file updates them, an older one only fills in empty fields, an identical one is skipped. Everything else is added.`
    : `Every ${noun} in the file is added as a new ${noun}, even when one with the same ${keyLabel} already exists. Tick to merge into the existing ${plural} instead.`;
}

/** The toast after a real import: "2 added, 1 updated, 1 skipped". */
export function jsonImportMessage(result, { noun, plural }) {
  const t = result.totals || {};
  const n = (k) => t[k] || 0;
  if (!result.mergeMode) return `Imported ${n('created')} ${n('created') === 1 ? noun : plural}${n('invalid') ? `, ${n('invalid')} failed` : ''}`;
  const parts = [`${n('created')} added`, `${n('updated')} updated`];
  if (n('filled')) parts.push(`${n('filled')} completed`);
  parts.push(`${n('skipped')} skipped`);
  if (n('invalid')) parts.push(`${n('invalid')} failed`);
  return `${Plural(plural)}: ${parts.join(', ')}`;
}
const Plural = (s) => s.charAt(0).toUpperCase() + s.slice(1);
