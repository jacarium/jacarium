import { useState, useCallback } from 'react';

/**
 * Custom hook for running an export under the shared Export Progress modal.
 * Mirrors useImportFlow: the hook owns the "is a job showing" state, the
 * modal (ExportProgressModal) owns the running job's progress/log state.
 *
 * A job is a plain object:
 *   {
 *     title:        string   - modal heading, e.g. 'Export Document'
 *     description:  string   - one-line subtitle, e.g. '"My doc" -> PDF'
 *     run:          async (onProgress) => result
 *                            - does the work; calls onProgress(update) with
 *                              { step, steps, label, current, total, percent,
 *                                indeterminate, log, logType } (all optional)
 *     onSuccess?:   (result) => void   - after run resolves
 *     onError?:     (error) => void    - after run rejects
 *     cancel?:      () => void         - stops the job: the modal shows a
 *                              "Cancel export" button while running; run
 *                              must then reject with an AbortError
 *     onCancel?:    () => void         - after a cancelled run settles
 *   }
 *
 * @example
 *   const exportFlow = useExportFlow();
 *   ...
 *   exportFlow.startExport({
 *     title: 'Export Documents',
 *     description: `${docs.length} documents -> JSON`,
 *     run: (onProgress) => exportToJSON(docs, 'documents', { onProgress }),
 *   });
 *   ...
 *   <ExportProgressModal
 *     isOpen={exportFlow.isOpen}
 *     job={exportFlow.job}
 *     onClose={exportFlow.handleClose}
 *   />
 *
 * @returns {{ isOpen: boolean, job: object|null, startExport: Function, handleClose: Function }}
 */
export function useExportFlow() {
  const [job, setJob] = useState(null);

  const startExport = useCallback((nextJob) => {
    // A fresh object per call so the modal's effect restarts even when the
    // same export is triggered twice in a row
    setJob({ ...nextJob });
  }, []);

  const handleClose = useCallback(() => {
    setJob(null);
  }, []);

  return {
    isOpen: job !== null,
    job,
    startExport,
    handleClose,
  };
}
