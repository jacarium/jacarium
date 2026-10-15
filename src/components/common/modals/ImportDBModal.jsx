import { useState } from 'react';
import BaseModal from './BaseModal';
import { Upload, X, FileJson, Database, FileText, Search, AlertCircle, Workflow, Trello, Bookmark, Terminal, FileCode, CheckSquare, Folder, Grid3x3, Brain, Image } from 'lucide-react';
import ImportStats from '../ImportStats';
import ImportFooter from '../ImportFooter';
import MergeModeOption from '../MergeModeOption';

/**
 * ImportDBModal - Modal for importing database backup
 *
 * Features:
 * - File upload with drag and drop
 * - Preview of import data
 * - Validation
 * - Merge ("keep existing data") vs replace mode
 * - Dry run: runs the selected mode's real import code without writing
 *   anything and shows per-type statistics (new / replaced / completed /
 *   unchanged / deleted / invalid with reasons) so the user can decide
 *   whether to import. The real import shows the same statistics afterwards.
 * - TaskWarrior tasks (format-2 backups) get one statistics row per
 *   instance ("tasks:<name>" summary keys) with the transport used (CLI /
 *   app task cache / needs a data path) and the breakdown line.
 *
 * Props:
 *   onImport(importData, mergeMode)  -> Promise<result | { error }>
 *   onDryRun(importData, mergeMode)  -> Promise<result | { error }>
 *   where result is what src/utils/importDatabase.js runImport() returns
 *   ({ mode, dryRun, summary, totals }).
 */
export default function ImportDBModal({
  isOpen,
  onClose,
  onImport,
  onDryRun,
}) {
  const [importData, setImportData] = useState(null);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);
  // 'import' | 'dry-run' while a run is in flight
  const [busy, setBusy] = useState(null);
  // { kind: 'import' | 'dry-run', mode, summary, totals } of the last run
  const [result, setResult] = useState(null);

  function handleFileSelect(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);

        // Validate structure - workflows, kanbanBoards, and kanbanCards are optional for backward compatibility
        if (!data.version || !data.documents || !data.documentTemplates || !data.jqlTemplates || !data.engineTemplates) {
          setError('Invalid database export file. Missing required fields.');
          setImportData(null);
          return;
        }

        // Add empty arrays if not present (for backward compatibility)
        if (!data.workflows) {
          data.workflows = [];
        }
        if (!data.kanbanBoards) {
          data.kanbanBoards = [];
        }
        if (!data.kanbanCards) {
          data.kanbanCards = [];
        }
        if (!data.calendarEventTemplates) {
          data.calendarEventTemplates = [];
        }
        if (!data.media) {
          data.media = [];
        }

        setImportData(data);
        setError('');
      } catch (err) {
        setError('Failed to parse JSON file: ' + err.message);
        setImportData(null);
      }
    };

    reader.onerror = () => {
      setError('Failed to read file');
      setImportData(null);
    };

    reader.readAsText(file);
  }

  function handleFileInputChange(e) {
    const file = e.target.files[0];
    handleFileSelect(file);
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/json') {
      handleFileSelect(file);
    } else {
      setError('Please drop a JSON file');
    }
  }

  async function runAction(kind, action) {
    if (!importData || busy || !action) return;
    setBusy(kind);
    try {
      const outcome = await action(importData, mergeMode);
      if (outcome && !outcome.error) {
        setResult({ kind, ...outcome });
      } else {
        setResult(null);
        if (outcome?.error) setError(outcome.error);
      }
    } finally {
      setBusy(null);
    }
  }

  function handleImport() {
    runAction('import', onImport);
  }

  function handleDryRun() {
    runAction('dry-run', onDryRun);
  }

  const imported = result?.kind === 'import';

  async function handleCancel() {
    setImportData(null);
    setError('');
    setIsDragging(false);
    setMergeMode(false);
    setResult(null);
    onClose();
    if (!imported) return;
    // The imported Taskwarrior instances and tasks go to this device's
    // Taskwarrior now (instances initialised under ~/.task/<name> when
    // missing, only tasks it does not have are imported - no duplicates;
    // without the task command they stay in the app). Then the database
    // changed under the running app: reload so every list picks up the
    // imported records.
    try {
      const { reapplyAll } = await import('../../../sync/taskwarriorFollow');
      await reapplyAll();
    } catch (error) {
      console.warn('[Import] applying the imported tasks to Taskwarrior failed:', error?.message || error);
    }
    window.location.reload();
  }

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleCancel}
      className="max-w-2xl w-full"
    >
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database size={18} className="text-os-text-secondary" />
          <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
            Import Database
          </h2>
        </div>
        <button
          onClick={handleCancel}
          className="p-1 hover:bg-os-sidebar-hover transition-colors"
        >
          <X size={20} className="text-os-text-secondary" />
        </button>
      </div>

      {/* Body */}
      <div className="p-6 space-y-4 bg-os-modal max-h-[70vh] overflow-y-auto">
        {/* File Upload Area */}
        {!importData && (
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
 isDragging
 ?'border-os-blue bg-blue-50 dark:bg-blue-900/20'
 :'border-os-input-border hover:border-os-text-muted'
 }`}
          >
            <FileJson size={48} className="text-os-text-muted mx-auto mb-4" />
            <p className="text-sm text-os-text-primary mb-2">
              Drag and drop your database export file here
            </p>
            <p className="text-xs text-os-text-secondary mb-4">or</p>
            <label className="inline-flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover rounded-sm transition-colors cursor-pointer">
              <Upload size={16} />
              Choose File
              <input
                type="file"
                accept="application/json"
                onChange={handleFileInputChange}
                className="hidden"
              />
            </label>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle size={20} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-900 dark:text-red-200">Import Error</p>
              <p className="text-sm text-red-700 dark:text-red-300 mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Preview */}
        {importData && (
          <div className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <p className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-2">
                Import Summary:
              </p>
              <div className="space-y-2 text-sm text-blue-800 dark:text-blue-200">
                <div className="flex items-center gap-2">
                  <FileText size={14} />
                  <span>{importData.documents?.length || 0} documents</span>
                </div>
                <div className="flex items-center gap-2">
                  <Folder size={14} />
                  <span>{importData.documentCategories?.length || 0} explicit category folders</span>
                </div>
                <div className="flex items-center gap-2">
                  <FileText size={14} />
                  <span>{importData.documentTemplates?.length || 0} document templates</span>
                </div>
                <div className="flex items-center gap-2">
                  <Search size={14} />
                  <span>{importData.jqlTemplates?.length || 0} JQL templates</span>
                </div>
                <div className="flex items-center gap-2">
                  <Search size={14} />
                  <span>{importData.engineTemplates?.length || 0} search engine templates</span>
                </div>
                <div className="flex items-center gap-2">
                  <Workflow size={14} />
                  <span>{importData.workflows?.length || 0} workflows</span>
                </div>
                <div className="flex items-center gap-2">
                  <Trello size={14} />
                  <span>{importData.kanbanBoards?.length || 0} kanban boards</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckSquare size={14} />
                  <span>{describeTaskCount(importData)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Terminal size={14} />
                  <span>{importData.taskwarriorInstances?.length || 0} TaskWarrior instances</span>
                </div>
                <div className="flex items-center gap-2">
                  <FileText size={14} />
                  <span>{importData.customReports?.length || 0} custom reports</span>
                </div>
                <div className="flex items-center gap-2">
                  <Bookmark size={14} />
                  <span>{importData.calendarEventTemplates?.length || 0} calendar event templates</span>
                </div>
                <div className="flex items-center gap-2">
                  <Terminal size={14} />
                  <span>{importData.sshCommands?.length || 0} SSH commands</span>
                </div>
                <div className="flex items-center gap-2">
                  <Grid3x3 size={14} />
                  <span>{importData.customGrids?.length || 0} custom grids</span>
                </div>
                <div className="flex items-center gap-2">
                  <Brain size={14} />
                  <span>{importData.customQuizzes?.length || 0} custom quizzes</span>
                </div>
                <div className="flex items-center gap-2">
                  <FileCode size={14} />
                  <span>{importData.openshiftTemplates?.length || 0} OpenShift templates</span>
                </div>
                <div className="flex items-center gap-2">
                  <Image size={14} />
                  <span>{importData.media?.length || 0} media files</span>
                </div>
              </div>
              {importData.exportDate && (
                <p className="text-xs text-blue-700 dark:text-blue-300 mt-3">
                  Exported on: {new Date(importData.exportDate).toLocaleString()}
                </p>
              )}
            </div>

            {/* Merge mode toggle (shared with the Documents import modals) */}
            <MergeModeOption
              checked={mergeMode}
              disabled={imported || busy !== null}
              onChange={(checked) => { setMergeMode(checked); setResult(null); }}
              label="Keep existing data and merge newer records"
              hint="Nothing is deleted. Imported records that match an existing one keep your current values and only fill in fields that are empty locally (a newer imported copy replaces the record); everything else is added alongside your current data."
            />

            {mergeMode ? (
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 flex items-start gap-3">
                <AlertCircle size={20} className="text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-blue-900 dark:text-blue-100">Merge Mode</p>
                  <p className="text-sm text-blue-800 dark:text-blue-200 mt-1">
                    Your existing data will be kept. Matching records have their empty
                    fields filled in from the import (and are replaced only when the
                    imported version is newer); new records are added.
                  </p>
                  {hasTaskwarriorTasks(importData) && (
                    <p className="text-sm text-blue-800 dark:text-blue-200 mt-1">
                      TaskWarrior tasks are matched to your instances by name and applied
                      through the TaskWarrior CLI where it answers (new and newer tasks are
                      imported by uuid; tasks you deleted here are never brought back). Where
                      the CLI is not reachable they go into the app's task cache only.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 flex items-start gap-3">
                <AlertCircle size={20} className="text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-yellow-900 dark:text-yellow-100">Warning</p>
                  <p className="text-sm text-yellow-800 dark:text-yellow-200 mt-1">
                    This will replace all existing data with the imported database. This action cannot be undone.
                  </p>
                  <p className="text-sm text-yellow-800 dark:text-yellow-200 mt-1">
                    TaskWarrior tasks: only the app's local task cache is replaced. Nothing is
                    deleted, purged or imported in your TaskWarrior data files; the Tasks page
                    re-syncs from the CLI when an instance opens.
                  </p>
                </div>
              </div>
            )}

            {result && <ImportStats result={result} />}
          </div>
        )}
      </div>

      {/* Footer (shared with the Documents import modals) */}
      <ImportFooter
        imported={imported}
        busy={busy}
        onCancel={handleCancel}
        onClose={handleCancel}
        onReload={handleCancel}
        onDryRun={onDryRun ? handleDryRun : null}
        onImport={handleImport}
        disabled={!importData}
        importLabel="Import Database"
        dryRunTitle="Run the selected mode without writing anything and show what would change"
      />
    </BaseModal>
  );
}

// Format-2 backups (src/utils/taskwarriorBackup.js) carry tasks per
// instance as TaskWarrior JSON under `taskwarriorTasks`; older files carry
// a flat `tasks` array of app rows.
function hasTaskwarriorTasks(importData) {
  const t = importData?.taskwarriorTasks;
  return t !== null && typeof t === 'object' && !Array.isArray(t);
}

function describeTaskCount(importData) {
  if (!hasTaskwarriorTasks(importData)) return `${importData.tasks?.length || 0} tasks`;
  const perInstance = Object.values(importData.taskwarriorTasks);
  const total = perInstance.reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
  const tombstones = Array.isArray(importData.taskTombstones) ? importData.taskTombstones.length : 0;
  return `${total} TaskWarrior tasks in ${perInstance.length} instance${perInstance.length === 1 ? '' : 's'}` +
    (tombstones ? `, ${tombstones} deleted-task tombstone${tombstones === 1 ? '' : 's'}` : '');
}
