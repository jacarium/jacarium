import { useState, useEffect } from 'react';
import BaseModal from '../../common/modals/BaseModal';
import { X, Search } from 'lucide-react';

/**
 * EngineInputModal - Modal for entering search query for engine templates
 *
 * Features:
 * - Input field for error message/search query
 * - Live URL preview
 * - Keyboard shortcuts (Ctrl+Enter to search, Escape to cancel)
 * - Opens search in new tab
 * - Supports pre-filled text from document selection
 *
 * @param {boolean} isOpen - Whether modal is visible
 * @param {object} template - Engine template to use
 * @param {string} prefilledText - Pre-filled text for the search query
 * @param {function} onSearch - Callback when searching (receives URL)
 * @param {function} onCancel - Callback when canceling
 */
export default function EngineInputModal({
  isOpen,
  template,
  prefilledText = '',
  onSearch,
  onCancel,
}) {
  const [errorMessage, setErrorMessage] = useState('');

  // Reset error message when template changes or set prefilled text
  useEffect(() => {
    if (template) {
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setErrorMessage(prefilledText || '');
    }
  }, [template, prefilledText]);

  function handleSearch() {
    if (!template || !errorMessage.trim()) return;

    // Replace placeholder in URL template with error message
    const url = template.urlTemplate.replace('{error}', encodeURIComponent(errorMessage.trim()));

    // Open in default browser if running in Electron, otherwise new tab
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }

    // Callback and reset
    if (onSearch) {
      onSearch(url);
    }

    setErrorMessage('');
    onCancel();
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && e.ctrlKey && errorMessage.trim()) {
      handleSearch();
    }
  }

  // Generate URL preview
  const urlPreview = template && errorMessage.trim()
    ? template.urlTemplate.replace('{error}', encodeURIComponent(errorMessage.trim()))
    : '';

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onCancel}
      className="max-w-lg w-full"
    >
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between">
        <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
          Search: {template?.name}
        </h2>
        <button
          onClick={onCancel}
          className="p-1 hover:bg-os-sidebar-hover transition-colors"
        >
          <X size={20} className="text-os-text-secondary" />
        </button>
      </div>

      {/* Body */}
      <div className="p-6 space-y-4 bg-os-modal">
        <div>
          <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
            Error Message / Search Query *
          </label>
          <textarea
            value={errorMessage}
            onChange={(e) => setErrorMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter error message or search query..."
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden resize-none text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
            rows={4}
            autoFocus
          />
        </div>

        {/* URL Preview */}
        {urlPreview && (
          <div className="bg-os-card-secondary p-3 border border-os-border rounded-sm">
            <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
              URL Preview
            </label>
            <code className="text-xs text-os-text-secondary font-mono break-all">
              {urlPreview}
            </code>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-between">
        <div className="text-xs text-os-text-secondary">
          Press Ctrl+Enter to search
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-os-modal border border-os-input-border rounded-sm text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSearch}
            disabled={!errorMessage.trim()}
            className="btn btn-primary flex items-center gap-2 px-4 py-2 text-sm"
          >
            Search
          </button>
        </div>
      </div>
    </BaseModal>
  );
}
