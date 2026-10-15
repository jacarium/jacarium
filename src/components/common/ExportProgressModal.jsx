import { useState, useEffect, useRef } from 'react';
import BaseModal from './modals/BaseModal';
import ConfirmationModal from './modals/ConfirmationModal';
import { useConfirmation } from '../../hooks/useConfirmation';
import { Download, CheckCircle, XCircle } from 'lucide-react';

/**
 * ExportProgressModal - Shared progress dialog for every export
 * (File > Database > Export, Export Document/Category as JSON/ZIP/PDF/
 * Base64, bulk exports). Visual twin of ImportModal.
 *
 * Runs `job.run(onProgress)` when opened with a job (see useExportFlow for
 * the job shape) and renders the progress it reports:
 *
 *   step/steps    - "Step 2 of 4" phase indicator
 *   label         - what is happening right now
 *   current/total - determinate counter ("12 / 40 (30%)")
 *   percent       - explicit percentage (e.g. from JSZip's onUpdate)
 *   indeterminate - animated bar for work that cannot report progress
 *                   (the PDF print pass, the final Blob assembly)
 *   log/logType   - append a line to the log pane
 *
 * Closing while a job is running asks for confirmation (like ImportModal).
 * Closing never aborts: the job runs to completion in the background, the
 * file is still saved, and the job's onSuccess/onError callbacks still fire
 * (they carry the success toasts / Base64 result). Only THIS window's state
 * stops following that job, so a newer job's progress can never be
 * overwritten by an abandoned one. A job that CAN be stopped provides
 * `cancel` (the Electron PDF export does): a "Cancel export" button calls
 * it, the run rejects with an AbortError, the status becomes 'cancelled'
 * and `onCancel` (not onError) fires.
 */
const INITIAL_PROGRESS = {
  step: null,
  steps: null,
  label: '',
  current: null,
  total: null,
  percent: 0,
  indeterminate: false,
};

export default function ExportProgressModal({ isOpen, onClose, job }) {
  const { confirm, confirmationProps } = useConfirmation();
  const [status, setStatus] = useState('idle'); // idle, exporting, success, error
  const [progress, setProgress] = useState(INITIAL_PROGRESS);
  const [logs, setLogs] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  // Increments per started job; a job whose id no longer matches has been
  // abandoned (closed or superseded) and must not touch the UI any more
  const jobIdRef = useRef(0);
  const logEndRef = useRef(null);

  const addLog = (message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { timestamp, message, type }]);
  };

  const applyProgress = (update) => {
    if (!update) return;
    const { log, logType, ...rest } = update;
    if (log) addLog(log, logType);
    if (Object.keys(rest).length === 0) return;

    setProgress(prev => {
      const next = { ...prev, ...rest };
      const hasCounter = 'current' in rest || 'total' in rest;
      const hasPercent = 'percent' in rest;
      if (hasCounter || hasPercent) {
        // Any concrete measurement ends an indeterminate phase unless the
        // update says otherwise
        next.indeterminate = rest.indeterminate ?? false;
      }
      if (hasPercent && !hasCounter) {
        // An explicit percentage replaces a stale counter from an earlier phase
        next.current = null;
        next.total = null;
        next.percent = Math.max(0, Math.min(100, Math.round(rest.percent)));
      } else if (hasCounter) {
        next.percent = next.total > 0
          ? Math.max(0, Math.min(100, Math.round((next.current / next.total) * 100)))
          : 0;
      }
      if (rest.indeterminate) {
        next.current = null;
        next.total = null;
      }
      return next;
    });
  };

  const runJob = async (activeJob) => {
    const id = ++jobIdRef.current;
    const isCurrent = () => jobIdRef.current === id;

    setStatus('exporting');
    setProgress(INITIAL_PROGRESS);
    setLogs([]);
    setErrorMessage('');
    addLog(`Starting ${activeJob.title || 'export'}...`, 'info');

    const onProgress = (update) => {
      if (isCurrent()) applyProgress(update);
    };

    try {
      const result = await activeJob.run(onProgress);
      if (isCurrent()) {
        setProgress(prev => ({
          ...prev,
          indeterminate: false,
          percent: 100,
          current: prev.total > 0 ? prev.total : prev.current,
        }));
        addLog('Export completed successfully.', 'success');
        setStatus('success');
      }
      if (activeJob.onSuccess) activeJob.onSuccess(result);
    } catch (error) {
      // A job that supports cancel (job.cancel, see useExportFlow) rejects
      // with an AbortError once the user cancels: not a failure
      if (error?.name === 'AbortError') {
        if (isCurrent()) {
          addLog('Export cancelled.', 'warning');
          setStatus('cancelled');
        }
        if (activeJob.onCancel) activeJob.onCancel();
        return;
      }
      console.error('Export failed:', error);
      if (isCurrent()) {
        setErrorMessage(error?.message || String(error));
        addLog(`Export failed: ${error?.message || error}`, 'error');
        setStatus('error');
      }
      if (activeJob.onError) activeJob.onError(error);
    }
  };

  const handleCancel = () => {
    if (status !== 'exporting' || typeof job?.cancel !== 'function') return;
    addLog('Cancelling...', 'warning');
    job.cancel();
  };

  useEffect(() => {
    if (isOpen && job) {
      // runJob initializes the progress UI synchronously on purpose, then
      // does all further setState after awaits (same pattern as ImportModal).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runJob(job);
    }
    // runJob is recreated each render but only depends on `job`, which is
    // already a dependency; adding it would restart the export on
    // unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, job]);

  // Keep the newest log line in view
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [logs]);

  const handleClose = async () => {
    if (status === 'exporting') {
      if (!(await confirm({
        title: 'Export in Progress',
        message: 'The export is still running and cannot be stopped. Closing this window only hides the progress - the export will finish in the background. Close anyway?',
        type: 'warning',
        confirmLabel: 'Close',
      }))) {
        return;
      }
    }
    // Detach this window from the running job (see header comment)
    jobIdRef.current += 1;
    setStatus('idle');
    setProgress(INITIAL_PROGRESS);
    setLogs([]);
    setErrorMessage('');
    onClose();
  };

  const title = job?.title || 'Export';
  const heading =
    status === 'exporting' ? `${title}...` :
    status === 'success' ? 'Export Complete' :
    status === 'error' ? 'Export Failed' :
    status === 'cancelled' ? 'Export Cancelled' :
    title;

  const counterText = progress.indeterminate
    ? 'Working...'
    : progress.total > 0
      ? `${progress.current ?? 0} / ${progress.total} (${progress.percent}%)`
      : `${progress.percent}%`;

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleClose}
      className="max-w-2xl w-full rounded-lg"
    >
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start gap-4 mb-4">
          <div className={`p-3 rounded-full shrink-0 ${
 status ==='success'?'bg-green-100':
 status ==='error'?'bg-red-100':
'bg-blue-100'
 }`}>
            {status === 'success' ? (
              <CheckCircle size={24} className="text-green-600" />
            ) : status === 'error' ? (
              <XCircle size={24} className="text-red-600" />
            ) : (
              <Download size={24} className="text-blue-600" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-os-text-primary mb-1">
              {heading}
            </h3>
            {job?.description && (
              <p className="text-sm text-os-text-secondary truncate" title={job.description}>
                {job.description}
              </p>
            )}
          </div>
        </div>

        {/* Progress Bar */}
        {(status === 'exporting' || status === 'success') && (
          <div className="mb-4">
            <div className="flex items-center justify-between gap-4 text-sm text-os-text-secondary mb-2">
              <span className="truncate">
                {progress.step && progress.steps && (
                  <span className="font-medium text-os-text-primary">
                    Step {progress.step} of {progress.steps}
                  </span>
                )}
                {progress.step && progress.steps && progress.label && ' · '}
                {status === 'success' ? 'Done' : (progress.label || 'Preparing...')}
              </span>
              <span className="shrink-0">
                {status === 'success' ? '100%' : counterText}
              </span>
            </div>
            <div className="w-full bg-os-card-secondary rounded-full h-2 overflow-hidden">
              {progress.indeterminate && status === 'exporting' ? (
                <div className="h-full w-full bg-blue-600/60 animate-pulse" />
              ) : (
                <div
                  className={`h-full transition-all duration-300 ${
 status ==='success'?'bg-green-600':'bg-blue-600'
 }`}
                  style={{ width: `${status === 'success' ? 100 : progress.percent}%` }}
                />
              )}
            </div>
          </div>
        )}

        {/* Error Summary */}
        {status === 'error' && errorMessage && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-700 dark:text-red-300 wrap-break-word">
            {errorMessage}
          </div>
        )}

        {/* Log Output */}
        <div className="mb-4">
          <div className="text-sm font-medium text-os-text-secondary mb-2">Export Log</div>
          <div className="os-terminal rounded-sm p-3 h-40 overflow-y-auto font-mono text-xs">
            {logs.length === 0 ? (
              <div className="os-terminal-muted">Waiting to start export...</div>
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
            <div ref={logEndRef} />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3">
          {status === 'exporting' ? (
            <>
              {typeof job?.cancel === 'function' && (
                <button
                  onClick={handleCancel}
                  className="px-4 py-2 bg-os-modal border border-os-input-border text-status-danger text-sm hover:bg-os-card-secondary transition-colors rounded-sm"
                >
                  Cancel export
                </button>
              )}
              <button
                onClick={handleClose}
                className="px-4 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors rounded-sm"
              >
                Close
              </button>
            </>
          ) : (
            <button
              onClick={handleClose}
              className="px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors rounded-sm"
            >
              {status === 'success' ? 'Done' : 'Close'}
            </button>
          )}
        </div>
      </div>

      {/* Confirmation Modal (replaces native confirm) */}
      <ConfirmationModal {...confirmationProps} />
    </BaseModal>
  );
}
