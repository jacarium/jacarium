import { X } from 'lucide-react';

/**
 * Export / import workflows as one Base64 string (the clipboard-friendly way
 * to hand a workflow to someone). In export mode the encoded data is shown
 * read-only (it was already copied to the clipboard); in import mode the
 * user pastes it and confirms.
 */
export default function Base64TransferModal({ mode, data, onDataChange, onClose, onImport }) {
  const copyAgain = async () => {
    try {
      await navigator.clipboard.writeText(data);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-os-card rounded-lg shadow-xl w-full max-w-3xl mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-os-text-primary">
            {mode === 'export' ? 'Base64 Export' : 'Base64 Import'}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            <X size={20} className="text-os-text-secondary" />
          </button>
        </div>

        <div className="mb-4">
          <label className="block text-sm text-os-text-secondary mb-2">
            {mode === 'export' ? 'Base64 Encoded Data (copied to clipboard):' : 'Paste Base64 Encoded Data:'}
          </label>
          <textarea
            value={data}
            onChange={(e) => onDataChange(e.target.value)}
            readOnly={mode === 'export'}
            className="w-full h-64 px-3 py-2 border border-os-input-border rounded-sm font-mono text-xs resize-none outline-hidden focus:border-os-blue focus:ring-2 focus:ring-os-blue bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted"
            placeholder={mode === 'import' ? 'Paste your Base64 encoded data here...' : ''}
          />
        </div>

        {mode === 'export' && (
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={copyAgain}
              className="px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors rounded-sm"
            >
              Copy Again
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors rounded-sm"
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
              className="px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors rounded-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Import
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
