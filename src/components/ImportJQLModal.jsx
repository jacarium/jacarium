import { useState } from 'react';
import { X, AlertCircle } from 'lucide-react';
import { parseJQL } from '../utils/jqlParser';

export default function ImportJQLModal({ isOpen, onClose, onImport }) {
  const [jqlText, setJqlText] = useState('');
  const [error, setError] = useState('');

  function handleImport() {
    setError('');

    if (!jqlText.trim()) {
      setError('Please enter a JQL query');
      return;
    }

    try {
      const group = parseJQL(jqlText);
      onImport(group);
      setJqlText('');
      onClose();
    } catch (err) {
      setError(err.message);
    }
  }

  function handleClose() {
    setJqlText('');
    setError('');
    onClose();
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 font-text">
      <div className="bg-os-modal shadow-lg max-w-2xl w-full border border-os-border rounded-sm">
        {/* Header */}
        <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between">
          <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">Import JQL</h2>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-os-sidebar-hover transition-colors"
          >
            <X size={20} className="text-os-text-secondary" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 bg-os-modal">
          <div>
            <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
              JQL Query
            </label>
            <textarea
              value={jqlText}
              onChange={(e) => setJqlText(e.target.value)}
              placeholder='project = PROJ AND status = "In Progress" OR priority = High'
              rows={6}
              className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted font-mono"
            />
            <p className="text-xs text-os-text-muted mt-1">
              Paste your JQL query here. The builder will parse it and create rules and groups automatically.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div>{error}</div>
            </div>
          )}

          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-sm p-3">
            <p className="text-xs text-blue-800 dark:text-blue-200">
              <strong>Supported features:</strong>
              <br />
              • Nested groups with parentheses: <span className="font-mono">(A AND B) OR (C AND D)</span>
              <br />
              • Quoted field names: <span className="font-mono">"Customer Name" = "value"</span>
              <br />
              • Multi-value operators: <span className="font-mono">status IN (Open, "In Progress")</span>
              <br />
              • All standard JQL operators and functions
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-end gap-3">
          <button
            onClick={handleClose}
            className="px-4 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            className="flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors shadow-xs"
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
