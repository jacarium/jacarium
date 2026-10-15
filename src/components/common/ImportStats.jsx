import { AlertCircle, Database, FlaskConical } from 'lucide-react';

/**
 * ImportStats - per-type statistics of a dry run or a finished import,
 * shared by the database import (ImportDBModal) and the Documents
 * "Import from JSON / Base64" flow.
 *
 * `result` is { kind: 'dry-run' | 'import', mode, summary, totals } where
 * summary is keyed by entity type and each entry is a
 * src/utils/importDatabase.js newSummary() ({ created, updated, filled,
 * skipped, deleted, invalid, errors: [{ label, reason }], samples: {...} }
 * plus optional `label` (row name), `note` (a line under the row) and the
 * TaskWarrior fields); totals is mergeTotals(summary).
 *
 * Only types with at least one counted record are listed; invalid records
 * are explained underneath with their reasons, and a short sample of
 * affected record names is shown for new / replaced / completed rows.
 * Theme tokens only, so it reads the same in light and dark mode.
 *
 * Without the optional props it renders exactly the database import's
 * wording; a host passes `title` / `headline` / `hint` / `emptyText` for its
 * own, `typeLabels` to name its summary keys and `columnLabels` to rename
 * the count columns.
 */

// Summary keys of the form "tasks:<instance name>" are one TaskWarrior
// instance's tasks (format-2 backups); "tasks" alone is an older file's flat
// task list.
function taskRowName(type) {
  if (type === 'tasks') return 'Tasks';
  return type.startsWith('tasks:') ? `Tasks: ${type.slice('tasks:'.length)}` : null;
}

// "3 new, 1 updated (newer), 4 unchanged, 1 deleted (tombstone applied),
// 1 skipped (deleted here)" - the per-instance breakdown under a task row.
function describeTaskRow(s, isDry) {
  const would = isDry ? 'would be ' : '';
  const parts = [];
  const created = s.created || 0;
  const updated = (s.updated || 0) - (s.tombstoned || 0);
  const unchanged = (s.skipped || 0) - (s.purgedHere || 0);
  if (created) parts.push(`${created} new`);
  if (updated > 0) parts.push(`${updated} updated (newer)`);
  if (s.filled) parts.push(`${s.filled} completed (empty fields filled in)`);
  if (unchanged > 0) parts.push(`${unchanged} unchanged`);
  if (s.tombstoned) parts.push(`${s.tombstoned} deleted (tombstone ${would}applied)`);
  if (s.purgedHere) parts.push(`${s.purgedHere} skipped (deleted here)`);
  if (s.deleted) parts.push(`${s.deleted} cached ${would}wiped`);
  if (s.invalid) parts.push(`${s.invalid} invalid`);
  return parts.join(', ');
}

function taskRowTransport(s) {
  if (s.cacheOnly) return 'app task cache only - TaskWarrior data files untouched';
  if (s.via === 'cli') return 'via TaskWarrior CLI';
  if (s.needsDataPath) return 'needs a data path - kept in the app task cache';
  if (s.via === 'db') return s.cliError ? 'offline fallback (app task cache) - TaskWarrior CLI not reachable' : 'app task cache';
  return null;
}

// Display names for the per-type summary keys runImport() returns.
const TYPE_LABELS = {
  documentCategories: 'Document categories',
  documents: 'Documents',
  documentTemplates: 'Document templates',
  jqlTemplates: 'JQL templates',
  engineTemplates: 'Search engine templates',
  workflows: 'Workflows',
  kanbanBoards: 'Kanban boards',
  kanbanCards: 'Kanban cards',
  tasks: 'Tasks',
  taskwarriorInstances: 'TaskWarrior instances',
  taskwarriorReports: 'TaskWarrior reports',
  customReports: 'Custom reports',
  calendarEventTemplates: 'Calendar event templates',
  sshCommands: 'SSH commands',
  openshiftTemplates: 'OpenShift templates',
  gtfobinsExecutables: 'GTFOBins executables',
  gtfobinsFunctions: 'GTFOBins functions',
  gtfobinsContexts: 'GTFOBins contexts',
  customGrids: 'Custom grids',
  customQuizzes: 'Custom quizzes',
  media: 'Media files',
  localStorage: 'UI settings (localStorage)',
};

// [summary key, column header]
const COLUMNS = [
  ['created', 'New'],
  ['updated', 'Replaced'],
  ['filled', 'Completed'],
  ['skipped', 'Unchanged'],
  ['deleted', 'Deleted'],
  ['invalid', 'Invalid'],
];

function databaseTitle(isDry, mode) {
  const modeLabel = mode === 'merge' ? 'keep existing data' : 'replace';
  return isDry ? `Dry run (${modeLabel} mode) - nothing was written` : `Import complete (${modeLabel} mode)`;
}

function databaseHeadline(mode, totals, would) {
  return mode === 'merge'
    ? `${totals.created || 0} ${would}added, ${totals.updated || 0} ${would}replaced by newer copies, ` +
      `${totals.filled || 0} ${would}completed (empty fields filled in), ${totals.skipped || 0} unchanged` +
      (totals.invalid ? `, ${totals.invalid} invalid` : '')
    : `${totals.deleted || 0} existing records ${would}deleted, ${totals.created || 0} ${would}created from the file` +
      (totals.invalid ? `, ${totals.invalid} invalid` : '');
}

export default function ImportStats({
  result,
  title,
  headline,
  hint,
  emptyText = 'The file contains no records to import.',
  typeLabels = {},
  columnLabels = {},
}) {
  const { kind, mode, summary = {}, totals = {} } = result;
  const isDry = kind === 'dry-run';
  const labels = { ...TYPE_LABELS, ...typeLabels };
  const columns = COLUMNS.map(([key, header]) => [key, columnLabels[key] || header]);
  const rows = Object.entries(summary).filter(([, s]) =>
    s && columns.some(([key]) => (s[key] || 0) > 0));
  const visibleColumns = columns.filter(([key]) => (totals[key] || 0) > 0);
  const errors = rows.flatMap(([type, s]) =>
    (s.errors || []).map((e) => ({ type, typeLabel: s.label || labels[type] || type, ...e })));
  const would = isDry ? 'would be ' : '';
  const titleText = title ?? databaseTitle(isDry, mode);
  const headlineText = headline ?? databaseHeadline(mode, totals, would);
  const hintText = hint ?? (isDry ? 'Review the numbers below, then click Import Database to apply exactly this plan.' : null);

  return (
    <div
      data-testid="import-stats"
      className="border border-os-border rounded-lg bg-os-card-secondary p-4 space-y-3"
    >
      <div className="flex items-start gap-2">
        {isDry
          ? <FlaskConical size={18} className="text-os-text-secondary shrink-0 mt-0.5" />
          : <Database size={18} className="text-os-text-secondary shrink-0 mt-0.5" />}
        <div>
          <p className="text-sm font-medium text-os-text-primary">{titleText}</p>
          <p className="text-xs text-os-text-secondary mt-1">{headlineText}</p>
          {hintText && (
            <p className="text-xs text-os-text-secondary mt-1">{hintText}</p>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-os-text-secondary">{emptyText}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-os-text-primary">
            <thead>
              <tr className="text-os-text-secondary border-b border-os-divider">
                <th className="text-left font-medium py-1 pr-3">Type</th>
                {visibleColumns.map(([key, header]) => (
                  <th key={key} className="text-right font-medium py-1 px-2">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([type, s]) => {
                const samples = ['created', 'updated', 'filled']
                  .flatMap((k) => s.samples?.[k] || [])
                  .slice(0, 5);
                const taskRow = taskRowName(type);
                const transport = taskRow ? taskRowTransport(s) : null;
                return (
                  <tr key={type} className="border-b border-os-divider last:border-b-0 align-top" data-testid={taskRow ? 'import-stats-task-row' : undefined}>
                    <td className="py-1.5 pr-3">
                      <span>{taskRow || s.label || labels[type] || type}</span>
                      {taskRow && (
                        <span className="block text-os-text-secondary max-w-xs whitespace-normal" data-testid="import-stats-task-detail">
                          {transport ? `${transport}: ` : ''}{describeTaskRow(s, isDry)}
                          {s.needsDataPath && s.cliError ? ` (${s.cliError})` : ''}
                          {s.syncError ? ` - re-sync from the CLI failed: ${s.syncError}` : ''}
                        </span>
                      )}
                      {samples.length > 0 && (
                        <span className="block text-os-text-secondary truncate max-w-xs" title={samples.join(', ')}>
                          e.g. {samples.join(', ')}
                        </span>
                      )}
                      {s.note && (
                        <span data-testid="import-stats-note" className="block text-os-text-secondary max-w-xs whitespace-normal">
                          {s.note}
                        </span>
                      )}
                    </td>
                    {visibleColumns.map(([key]) => (
                      <td key={key} className={`text-right py-1.5 px-2 tabular-nums ${s[key] ?'':'text-os-text-secondary'}`}>
                        {s[key] || 0}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {errors.length > 0 && (
        <div className="border-t border-os-divider pt-2">
          <p className="text-xs font-medium text-os-text-primary flex items-center gap-1">
            <AlertCircle size={14} className="text-os-text-secondary" />
            {totals.invalid} record{totals.invalid === 1 ? '' : 's'} cannot be imported
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-os-text-secondary max-h-32 overflow-y-auto">
            {errors.slice(0, 50).map((e, i) => (
              <li key={i}>
                <span className="text-os-text-secondary">{e.typeLabel}:</span>{' '}
                <span className="text-os-text-primary">{e.label}</span> - {e.reason}
              </li>
            ))}
            {totals.invalid > errors.length && (
              <li className="text-os-text-secondary">...and {totals.invalid - errors.length} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
