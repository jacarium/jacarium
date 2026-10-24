import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

/**
 * The one "export / import as text" dialog - the Workflows page's Base64
 * transfer and the "Export ... (JSON)" of Workflows, Kanban and Tasks - in
 * two formats:
 *   - base64 (the clipboard-friendly way to hand a workflow to someone): in
 *     export mode the encoded data is shown read-only (it was already copied
 *     to the clipboard); in import mode the user pastes it and confirms;
 *   - json ("Export Workflow (JSON)", Kanban's and Tasks' "Export All
 *     (JSON)", "Export Instance / Category (JSON)"): the exact text the
 *     file export writes (pretty-printed, so a paste into the page's
 *     "Import from JSON" round-trips),
 *     read-only in a monospace box with its line count, with Copy (a
 *     "Copied" confirmation), Download .json (the same file and name as the
 *     download always was) and Close.
 *
 * Props: mode 'export' | 'import', format 'base64' | 'json', data,
 * onDataChange (import), onClose, onImport (import), onDownload (json
 * export), filename (shown on the download button).
 */
export default function TransferTextModal({ mode = 'export', format = 'base64', data = '', onDataChange, onClose, onImport, onDownload, filename }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const isJson = format === 'json';
  const title = isJson ? 'JSON Export' : mode === 'export' ? 'Base64 Export' : 'Base64 Import';
  const label = isJson
    ? 'The JSON the file export writes - paste it into "Import from JSON" on another device:'
    : mode === 'export' ? 'Base64 Encoded Data (copied to clipboard):' : 'Paste Base64 Encoded Data:';
  const lines = data ? data.split('\n').length : 0;
  const copyLabel = copied ? 'Copied' : (isJson ? 'Copy' : 'Copy Again');
  const downloadLabel = 'Download .json';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data);
      setCopied(true);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" data-testid={`transfer-modal-${format}`}>
      <div className="bg-os-card rounded-lg shadow-xl w-full max-w-3xl mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-os-text-primary">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
            aria-label="Close"
            title="Close"
          >
            <X size={20} className="text-os-text-secondary" />
          </button>
        </div>

        <div className="mb-4">
          <label className="block text-sm text-os-text-secondary mb-2">{label}</label>
          <div className="relative">
            <textarea
              value={data}
              onChange={(e) => onDataChange && onDataChange(e.target.value)}
              readOnly={mode === 'export'}
              spellCheck={false}
              className="w-full h-64 px-3 py-2 border border-os-input-border rounded-sm font-mono text-xs resize-none outline-hidden focus:border-os-blue focus:ring-2 focus:ring-os-blue bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted"
              placeholder={mode === 'import' ? 'Paste your Base64 encoded data here...' : ''}
              data-testid="transfer-text"
            />
            {isJson && (
              <span className="absolute bottom-3 right-3 px-2 py-0.5 text-[11px] rounded-sm bg-os-card-secondary text-os-text-secondary border border-os-border" data-testid="transfer-line-count">
                {lines} {lines === 1 ? 'line' : 'lines'}
              </span>
            )}
          </div>
        </div>

        {mode === 'export' && (
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={copy}
              className="btn btn-primary px-4 py-2 text-sm"
              data-testid="transfer-copy"
              aria-live="polite"
            >
              {copyLabel}
            </button>
            {isJson && onDownload && (
              <button
                onClick={onDownload}
                className="px-4 py-2 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors rounded-sm"
                title={filename ? `Download ${filename}` : 'Download the .json file'}
                data-testid="transfer-download"
              >
                {downloadLabel}
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors rounded-sm"
              data-testid="transfer-close"
            >
              Close
            </button>
          </div>
        )}

        {mode === 'import' && (
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors rounded-sm"
            >
              Cancel
            </button>
            <button
              onClick={onImport}
              disabled={!data.trim()}
              className="btn btn-primary px-4 py-2 text-sm"
            >
              Import
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
