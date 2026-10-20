import { useState, useRef } from 'react';
import BaseModal from '../../common/modals/BaseModal';
import ImportFooter from '../../common/ImportFooter';
import MergeModeOption from '../../common/MergeModeOption';
import { FileJson, AlertCircle, FileUp, X } from 'lucide-react';
import { SubTabs } from '../../ui/primitives';

/**
 * ImportInputModal - Modal for pasting JSON data or uploading a file to
 * import. Same footer as the database import (ImportDBModal): Cancel /
 * Dry Run / <importLabel>. The input is parsed and validated when one of
 * those is clicked (errors shown in place, nothing written); a dry run
 * runs `onDryRun(items, { mergeMode })` and shows `renderStats(result)`
 * under the input without importing; the import button hands the validated
 * data to `onValidated(items, { mergeMode })` (the progress modal). Editing
 * the input or toggling the merge checkbox clears stale results.
 *
 * The merge checkbox is the database import's (MergeModeOption):
 * unchecked, every item becomes a new document; checked, documents already
 * here are merged (see src/utils/documentImport.js runDocumentsImport).
 * `mergeLabel` / `mergeHint(checked)` supply its wording.
 */
export default function ImportInputModal({
  isOpen,
  onClose,
  onValidated,
  validateFn,
  onDryRun = null,
  renderStats = null,
  importLabel = 'Import',
  mergeLabel = null,
  mergeHint = null,
  title = 'Import Documents',
  placeholder = 'Paste your JSON data here...',
  exampleData = null,
}) {
  const [mode, setMode] = useState('paste'); // 'paste' or 'file'
  const [jsonInput, setJsonInput] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [validationError, setValidationError] = useState(null);
  const [busy, setBusy] = useState(null); // 'dry-run' | null
  const [dryRunResult, setDryRunResult] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [mergeMode, setMergeMode] = useState(false); // same default as ImportDBModal (not remembered)
  const fileInputRef = useRef(null);
  // The FileReader of the file being read: a later choose/clear supersedes
  // it, so its result (arriving after the clear) must not repopulate the input
  const readerRef = useRef(null);

  const clearOutcome = () => {
    setValidationError(null);
    setDryRunResult(null);
  };

  // Load a chosen or dropped file into the input (same path for both)
  const loadFile = (file) => {
    if (!file) return;

    setSelectedFile(file);
    setJsonInput('');
    clearOutcome();

    // Read file content
    if (readerRef.current) readerRef.current.abort();
    const reader = new FileReader();
    readerRef.current = reader;
    reader.onload = (event) => {
      if (readerRef.current !== reader) return; // superseded by a later choose/clear
      setJsonInput(event.target.result);
    };
    reader.onerror = () => {
      if (readerRef.current !== reader) return;
      setValidationError('Failed to read file');
    };
    reader.readAsText(file);
  };

  const handleFileSelect = (e) => {
    loadFile(e.target.files[0]);
  };

  const clearFile = () => {
    if (readerRef.current) {
      readerRef.current.abort();
      readerRef.current = null;
    }
    setSelectedFile(null);
    setJsonInput('');
    clearOutcome();
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // The drop zone advertises "or drag and drop": accept a dropped file too
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const isJson = file.type === 'application/json' || /\.json$/i.test(file.name || '');
    if (!isJson) {
      setValidationError('Please drop a JSON file');
      return;
    }
    loadFile(file);
  };

  const handleFileButtonClick = () => {
    fileInputRef.current?.click();
  };

  /**
   * Parse + validate the input. Returns the data when it is importable,
   * otherwise shows the error (as before) and returns null.
   */
  const validate = () => {
    clearOutcome();
    try {
      const data = JSON.parse(jsonInput);
      const validationResult = validateFn(data);
      if (validationResult === true) return data;
      setValidationError(typeof validationResult === 'string' ? validationResult : 'Validation failed');
    } catch (error) {
      if (error instanceof SyntaxError) {
        setValidationError(`Invalid JSON: ${error.message}`);
      } else {
        setValidationError(`Error: ${error.message}`);
      }
    }
    return null;
  };

  const handleDryRun = async () => {
    if (!onDryRun || busy) return;
    const data = validate();
    if (!data) return;
    setBusy('dry-run');
    try {
      const outcome = await onDryRun(data, { mergeMode });
      if (outcome && !outcome.error) {
        setDryRunResult({ kind: 'dry-run', ...outcome });
      } else {
        setValidationError(outcome?.error || 'Dry run failed');
      }
    } catch (error) {
      setValidationError(`Dry run failed: ${error.message}`);
    } finally {
      setBusy(null);
    }
  };

  const handleImport = () => {
    if (busy) return;
    const data = validate();
    if (!data) return;
    onValidated(data, { mergeMode });
    handleClose();
  };

  const handleClose = () => {
    if (readerRef.current) {
      readerRef.current.abort();
      readerRef.current = null;
    }
    setMode('paste');
    setJsonInput('');
    setSelectedFile(null);
    clearOutcome();
    setBusy(null);
    setIsDragging(false);
    setMergeMode(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onClose();
  };

  const handlePasteExample = () => {
    const defaultExample = [
      {
        title: 'Example Document 1',
        content: 'This is example content',
        category: 'General',
        locked: false
      },
      {
        title: 'Example Document 2',
        content: 'Another example',
        category: 'Examples',
        locked: false
      }
    ];

    const example = JSON.stringify(exampleData || defaultExample, null, 2);
    setJsonInput(example);
    clearOutcome();
  };

  const getLineCount = () => {
    return jsonInput.split('\n').length;
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleClose}
      className="max-w-3xl w-full rounded-lg"
    >
      <div className="p-6 max-h-[75vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-4">
          <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/30 shrink-0">
            <FileJson size={24} className="text-blue-600 dark:text-blue-300" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-os-text-primary mb-1">
              {title}
            </h3>
            <p className="text-sm text-os-text-secondary">
              Upload a JSON file or paste JSON data. Dry Run checks the data and shows what would be imported without writing anything.
            </p>
          </div>
        </div>

        {/* Mode Tabs (the app's tab bar, src/components/ui/primitives.jsx) */}
        <SubTabs className="mb-4" active={mode} onChange={setMode}
          tabs={[{ id: 'paste', label: 'Paste JSON', testId: 'import-tab-paste' }, { id: 'file', label: 'Upload File', testId: 'import-tab-file' }]} />

        {/* JSON Input - Paste Mode */}
        {mode === 'paste' && (
          <div className="mb-4 last:mb-0">
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-os-text-secondary">
                JSON Data
              </label>
              <button
                onClick={handlePasteExample}
                className="text-xs text-os-blue hover:underline"
              >
                Paste Example
              </button>
            </div>
            <div className="relative">
              <textarea
                value={jsonInput}
                onChange={(e) => {
                  setJsonInput(e.target.value);
                  clearOutcome();
                }}
                placeholder={placeholder}
                className="os-terminal w-full h-96 px-3 py-2 border border-os-input-border rounded-sm outline-hidden focus:border-os-blue focus:ring-2 focus:ring-os-blue/20 transition-all font-mono text-sm resize-none"
                spellCheck={false}
              />
              <div className="absolute bottom-2 right-2 text-xs text-os-text-secondary bg-os-card-secondary px-2 py-1 rounded-sm border border-os-border">
                {getLineCount()} lines
              </div>
            </div>
          </div>
        )}

        {/* File Upload Mode */}
        {mode === 'file' && (
          <div className="mb-4 last:mb-0">
            <label className="text-sm text-os-text-secondary mb-2 block">
              Upload JSON File
            </label>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleFileSelect}
              className="hidden"
            />

            {/* Chosen file: a compact chip (name + size, clearable) */}
            {selectedFile ? (
              <div className="flex items-center gap-3 p-3 border border-os-input-border rounded-lg bg-os-card-secondary" data-testid="import-file-chip">
                <FileJson size={20} className="text-os-text-secondary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-os-text-primary truncate" title={selectedFile.name}>{selectedFile.name}</p>
                  <p className="text-xs text-os-text-secondary">{(selectedFile.size / 1024).toFixed(2)} KB</p>
                </div>
                <button
                  type="button"
                  onClick={handleFileButtonClick}
                  className="text-xs text-os-blue hover:underline shrink-0"
                >
                  Choose different file
                </button>
                <button
                  type="button"
                  onClick={clearFile}
                  title="Remove file"
                  aria-label="Remove file"
                  className="p-1 rounded-sm hover:bg-os-card text-os-text-secondary hover:text-os-text-primary transition-colors shrink-0"
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
            <div
              onClick={handleFileButtonClick}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              data-testid="import-drop-zone"
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
 isDragging
 ?'border-os-blue bg-blue-50 dark:bg-blue-900/20'
 :'border-os-border hover:border-os-blue bg-os-card-secondary hover:bg-blue-50 dark:hover:bg-blue-900/20'
 }`}
            >
              <FileUp size={48} className="mx-auto mb-3 text-os-text-muted" />
              <div>
                <p className="text-sm font-medium text-os-text-primary mb-1">
                  Click to select a JSON file
                </p>
                <p className="text-xs text-os-text-secondary">
                  or drag and drop
                </p>
              </div>
            </div>
            )}
          </div>
        )}

        {/* Merge mode toggle - the database import's control */}
        {mergeLabel && (
          <div className="mb-4 last:mb-0">
            <MergeModeOption
              checked={mergeMode}
              disabled={busy !== null}
              onChange={(checked) => { setMergeMode(checked); clearOutcome(); }}
              label={mergeLabel}
              hint={mergeHint ? mergeHint(mergeMode) : null}
            />
          </div>
        )}

        {/* Validation Feedback */}
        {validationError && (
          <div className="mb-4 last:mb-0 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm flex items-start gap-2">
            <AlertCircle size={16} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-medium text-red-800 dark:text-red-200 mb-1">Validation Error</div>
              <div className="text-sm text-red-700 dark:text-red-300">{validationError}</div>
            </div>
          </div>
        )}

        {/* Dry run statistics */}
        {dryRunResult && renderStats && (
          <div className="mb-4 last:mb-0">{renderStats(dryRunResult)}</div>
        )}
      </div>

      {/* Actions - same footer as the database import */}
      <ImportFooter
        busy={busy}
        onCancel={handleClose}
        onDryRun={onDryRun ? handleDryRun : null}
        onImport={handleImport}
        disabled={!jsonInput.trim()}
        importLabel={importLabel}
      />
    </BaseModal>
  );
}
