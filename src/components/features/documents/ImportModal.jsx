import { useState, useEffect } from 'react';
import BaseModal from '../../common/modals/BaseModal';
import ConfirmationModal from '../../common/modals/ConfirmationModal';
import ImportFooter from '../../common/ImportFooter';
import { useConfirmation } from '../../../hooks/useConfirmation';
import { Upload, CheckCircle, XCircle } from 'lucide-react';
import { countImportImages } from '../../../utils/documentAttachments';

/**
 * ImportModal - the real import, with progress and a log, ending in the
 * same statistics block a dry run shows (renderStats) and a Close button.
 *
 * `onRun(items, { ...importOptions, dryRun: false, onProgress })` is the one runner shared
 * with the dry run (src/utils/documentImport.js runDocumentsImport); it
 * reports { current, total, log, logType } and resolves with the result
 * ({ summary, totals, ... }). `onComplete(result)` fires when it is done.
 */
export default function ImportModal({
  isOpen,
  onClose,
  onRun,
  onComplete = null,
  renderStats = null,
  importData,
  importOptions = {},
}) {
  const { confirm, confirmationProps } = useConfirmation();
  const [status, setStatus] = useState('idle'); // idle, importing, success, error
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);

  const addLog = (message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { timestamp, message, type }]);
  };

  const startImport = async () => {
    setStatus('importing');
    setLogs([]);
    setProgress({ current: 0, total: importData.length });
    setResult(null);

    try {
      const outcome = await onRun(importData, {
        ...importOptions,
        dryRun: false,
        onProgress: (update) => {
          if (update.log) addLog(update.log, update.logType || 'info');
          if (typeof update.current === 'number') {
            setProgress({ current: update.current, total: update.total ?? importData.length });
          }
        },
      });
      const imported = outcome?.summary?.documents?.created || 0;
      setResult({ kind: 'import', ...outcome });
      setStatus(imported > 0 || !(outcome?.totals?.invalid) ? 'success' : 'error');
      if (onComplete) await onComplete(outcome);
    } catch (error) {
      addLog(`✗ Import failed: ${error.message}`, 'error');
      setStatus('error');
    }
  };

  useEffect(() => {
    if (isOpen && importData) {
      // startImport initializes the progress UI synchronously on purpose,
      // then does all further setState after awaits.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      startImport();
    }
    // startImport is recreated each render but only depends on importData,
    // which is already a dependency; adding it would restart imports on
    // unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, importData]);

  const handleClose = async () => {
    if (status === 'importing') {
      if (!(await confirm({
        title: 'Import in Progress',
        message: 'Import is in progress. Are you sure you want to close?',
        type: 'warning',
        confirmLabel: 'Close',
      }))) {
        return;
      }
    }
    setStatus('idle');
    setLogs([]);
    setProgress({ current: 0, total: 0 });
    setResult(null);
    onClose();
  };

  // Preview of the embedded images the file carries (unique filenames;
  // every Documents JSON/Base64 export embeds referenced images)
  const imageCount = countImportImages(importData);

  const getProgressPercent = () => {
    if (progress.total === 0) return 0;
    return Math.round((progress.current / progress.total) * 100);
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleClose}
      className="max-w-2xl w-full rounded-lg"
    >
      <div className="p-6 max-h-[75vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-4">
          <div className={`p-3 rounded-full shrink-0 ${
 status ==='success'?'bg-green-100 dark:bg-green-900/30':
 status ==='error'?'bg-red-100 dark:bg-red-900/30':
'bg-blue-100 dark:bg-blue-900/30'
 }`}>
            {status === 'success' ? (
              <CheckCircle size={24} className="text-green-600 dark:text-green-400" />
            ) : status === 'error' ? (
              <XCircle size={24} className="text-red-600 dark:text-red-400" />
            ) : (
              <Upload size={24} className="text-blue-600 dark:text-blue-300" />
            )}
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-os-text-primary mb-1">
              {status === 'idle' ? 'Import Documents' :
               status === 'importing' ? 'Importing Documents...' :
               status === 'success' ? 'Import Complete' :
               'Import Failed'}
            </h3>
            {importData && (
              <p className="text-sm text-os-text-secondary">
                {importData.length} document{importData.length !== 1 ? 's' : ''}
                {imageCount > 0 ? `, ${imageCount} image${imageCount !== 1 ? 's' : ''}` : ''} to import
              </p>
            )}
          </div>
        </div>

        {/* Progress Bar */}
        {(status === 'importing' || status === 'success') && (
          <div className="mb-4">
            <div className="flex items-center justify-between text-sm text-os-text-secondary mb-2">
              <span>Progress</span>
              <span>{progress.current} / {progress.total} ({getProgressPercent()}%)</span>
            </div>
            <div className="w-full bg-os-card-secondary rounded-full h-2 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
 status ==='success'?'bg-green-700 dark:bg-green-400':'bg-os-blue'
 }`}
                data-testid="import-progress-fill"
                style={{ width: `${getProgressPercent()}%` }}
              />
            </div>
          </div>
        )}

        {/* Statistics - the same block the dry run showed */}
        {result && renderStats && (
          <div className="mb-4">{renderStats(result)}</div>
        )}

        {/* Log Output */}
        <div>
          <div className="text-sm font-medium text-os-text-secondary mb-2">Import Log</div>
          <div className="os-terminal rounded-sm p-3 h-64 overflow-y-auto font-mono text-xs">
            {logs.length === 0 ? (
              <div className="os-terminal-muted">Waiting to start import...</div>
            ) : (
              logs.map((log, index) => (
                <div
                  key={index}
                  className={`mb-1 ${
 log.type ==='error'?'os-terminal-error':
 log.type ==='success'?'os-terminal-success':
 log.type ==='warning'?'os-terminal-warning':
''
 }`}
                >
                  <span className="os-terminal-muted">[{log.timestamp}]</span> {log.message}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Actions */}
      {status === 'importing' ? (
        <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-end gap-3" data-testid="import-footer">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 bg-os-modal border border-os-input-border rounded-sm text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <ImportFooter imported onClose={handleClose} onCancel={handleClose} onImport={() => {}} />
      )}

      {/* Confirmation Modal (replaces native confirm) */}
      <ConfirmationModal {...confirmationProps} />
    </BaseModal>
  );
}
