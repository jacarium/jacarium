import ImportStats from './ImportStats';

/* eslint-disable react-refresh/only-export-components -- the wording belongs with the block */
/**
 * The shared ImportStats block (the Documents import's and the database
 * import's) with the wording of a Kanban / Tasks / Workflows "Import from
 * JSON" run (src/utils/jsonImportMerge.js runJsonImport): one row per
 * summary type with the New / Updated / Completed / Skipped / Invalid
 * counts, the first records of each outcome ("e.g. ...") and the invalid
 * records with their reasons; the same block for a dry run and after the
 * real import.
 */
export function describeJsonImport(result, { noun, plural, importLabel }) {
  const isDry = result.kind === 'dry-run' || (result.kind == null && result.dryRun);
  const would = isDry ? 'would be ' : '';
  const t = result.totals || {};
  const n = (k) => t[k] || 0;
  const count = (k) => `${n(k)} ${n(k) === 1 ? noun : plural}`;
  const parts = result.mergeMode
    ? [`${count('created')} ${would}added`, `${n('updated')} updated (newer)`]
    : [`${count('created')} ${would}added`];
  if (result.mergeMode && n('filled')) parts.push(`${n('filled')} completed (empty fields filled in)`);
  if (result.mergeMode) parts.push(`${n('skipped')} skipped (older or identical)`);
  if (result.mergeMode || n('invalid')) parts.push(`${n('invalid')} error${n('invalid') === 1 ? '' : 's'}`);
  const modeLabel = result.mergeMode ? `merge into existing ${plural}` : `add as new ${plural}`;
  return {
    title: isDry ? `Dry run (${modeLabel}) - nothing was written` : `Import complete (${modeLabel})`,
    headline: parts.join(', '),
    hint: isDry ? `Review the numbers below, then click ${importLabel} to apply exactly this plan.` : null,
  };
}

export default function JsonImportStats({ result, noun, plural = `${noun}s`, importLabel, typeLabels = {} }) {
  const text = describeJsonImport(result, { noun, plural, importLabel });
  const merge = result.mergeMode === true;
  return (
    <ImportStats
      result={result}
      title={text.title}
      headline={text.headline}
      hint={text.hint}
      emptyText={`The file contains no ${plural} to import.`}
      typeLabels={typeLabels}
      columnLabels={merge
        ? { created: 'New', updated: 'Updated', filled: 'Completed', skipped: 'Skipped', invalid: 'Invalid' }
        : { created: 'New', invalid: 'Invalid' }}
    />
  );
}
