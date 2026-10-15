import ImportInputModal from '../features/documents/ImportInputModal';
import ImportModal from '../features/documents/ImportModal';

/**
 * ImportFlow - Complete import flow with input and progress modals
 *
 * A reusable component that handles the full import process:
 * 1. Input modal (paste JSON or upload file) with the same footer as the
 *    database import: Cancel / Dry Run / <importLabel>. Validation runs when
 *    one of those is clicked; a dry run shows the statistics in place.
 * 2. Progress modal with logging for the real import, ending in the same
 *    statistics block and a Close button.
 *
 * `onRun(items, { dryRun, mergeMode, onProgress })` is the ONE runner for both (see
 * src/utils/documentImport.js runDocumentsImport); `renderStats(result)`
 * renders the statistics; `onComplete(result)` fires after a real import.
 *
 * @example
 * ```jsx
 * <ImportFlow
 *   isOpen={showImportModal}
 *   onClose={() => setShowImportModal(false)}
 *   title="Import Documents"
 *   validateFn={(data) => {
 *     if (!Array.isArray(data)) return 'Expected an array';
 *     return true;
 *   }}
 *   onRun={(items, opts) => runDocumentsImport(items, opts)}
 *   renderStats={(result) => <DocumentsImportStats result={result} />}
 *   exampleData={[{...}]}
 * />
 * ```
 */
export default function ImportFlow({
  // Modal state
  isInputOpen,
  isProgressOpen,
  onInputClose,
  onProgressClose,
  onValidated,
  importData,
  importOptions = {},

  // Configuration
  title = 'Import Data',
  placeholder = 'Paste your JSON data here...',
  validateFn,
  onRun,
  onComplete = null,
  renderStats = null,
  importLabel = 'Import',
  mergeLabel = null,
  mergeHint = null,
  exampleData = null,
}) {
  return (
    <>
      {/* Step 1: Input Modal (Paste or Upload) */}
      <ImportInputModal
        isOpen={isInputOpen}
        onClose={onInputClose}
        onValidated={onValidated}
        validateFn={validateFn}
        onDryRun={(items, options) => onRun(items, { ...options, dryRun: true })}
        renderStats={renderStats}
        importLabel={importLabel}
        mergeLabel={mergeLabel}
        mergeHint={mergeHint}
        title={title}
        placeholder={placeholder}
        exampleData={exampleData}
      />

      {/* Step 2: Progress Modal (the real import, with logging + statistics) */}
      <ImportModal
        isOpen={isProgressOpen}
        onClose={onProgressClose}
        onRun={onRun}
        onComplete={onComplete}
        renderStats={renderStats}
        importData={importData}
        importOptions={importOptions}
      />
    </>
  );
}
