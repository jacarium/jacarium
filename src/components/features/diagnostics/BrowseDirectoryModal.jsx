import { useState } from 'react';
import BaseModal from '../../common/modals/BaseModal';
import { X, FolderOpen, Info, Terminal } from 'lucide-react';

/**
 * BrowseDirectoryModal - Modal for selecting diagnostic reports directory
 *
 * Features:
 * - Manual path input
 * - Common shortcuts (Downloads, Documents, Desktop)
 * - Path examples and help
 */
export default function BrowseDirectoryModal({
  isOpen,
  currentDirectory,
  onConfirm,
  onCancel,
}) {
  const [directory, setDirectory] = useState(currentDirectory || 'Downloads');

  function handleConfirm() {
    if (directory.trim()) {
      onConfirm(directory.trim());
    }
  }

  function handleShortcut(shortcut) {
    setDirectory(shortcut);
  }

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onCancel}
      className="max-w-lg w-full"
    >
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderOpen size={18} className="text-os-text-secondary" />
          <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
            Browse Reports Directory
          </h2>
        </div>
        <button
          onClick={onCancel}
          className="p-1 hover:bg-os-sidebar-hover transition-colors"
        >
          <X size={20} className="text-os-text-secondary" />
        </button>
      </div>

      {/* Body */}
      <div className="p-6 space-y-4 bg-os-modal">
        {/* Info */}
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 flex items-start gap-3">
          <Info size={16} className="text-blue-600 shrink-0 mt-0.5" />
          <div className="text-xs text-blue-800 dark:text-blue-200">
            <p className="mb-2">
              Enter the directory path where your diagnostic reports (sosreport, must-gather, inspect) are located.
            </p>
            <p className="font-medium">
              Use the quick shortcuts below or type the path manually.
            </p>
          </div>
        </div>

        {/* Directory Input */}
        <div>
          <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
            Directory Path
          </label>
          <input
            type="text"
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
            placeholder="e.g., Downloads, ~/Documents, or /home/user/reports"
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted font-mono"
            autoFocus
          />
          <p className="text-xs text-os-text-muted mt-2">
            Use relative paths (e.g., "Downloads"), home paths (e.g., "~/Documents"), or absolute paths (e.g., "/home/user/reports")
          </p>
        </div>

        {/* How to find path */}
        <div className="bg-os-card-secondary border border-os-border rounded-lg p-3">
          <div className="flex items-start gap-2 mb-2">
            <Terminal size={14} className="text-os-text-secondary mt-0.5" />
            <p className="text-xs font-semibold text-os-text-primary">Tips:</p>
          </div>
          <ul className="text-xs text-os-text-secondary space-y-1 ml-5 list-disc">
            <li><strong>Tilde shorthand:</strong> Use <code className="bg-os-card-secondary px-1 py-0.5 rounded-sm font-mono text-xs">~</code> for your home directory (e.g., <code className="bg-os-card-secondary px-1 py-0.5 rounded-sm font-mono text-xs">~/Downloads</code>)</li>
            <li><strong>Find path:</strong> Open terminal, navigate to folder, run <code className="bg-os-card-secondary px-1 py-0.5 rounded-sm font-mono text-xs">pwd</code></li>
            <li><strong>File Manager:</strong> Right-click the folder and copy path (or check properties)</li>
          </ul>
        </div>

        {/* Quick Shortcuts */}
        <div>
          <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
            Quick Shortcuts
          </label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Downloads', value: 'Downloads' },
              { label: 'Documents', value: 'Documents' },
              { label: 'Desktop', value: 'Desktop' },
              { label: '~/Downloads', value: '~/Downloads' },
              { label: '~/Documents', value: '~/Documents' },
              { label: '~/ (Home)', value: '~' },
            ].map((shortcut) => (
              <button
                key={shortcut.value}
                onClick={() => handleShortcut(shortcut.value)}
                className={`px-3 py-2 text-sm border transition-colors ${
 directory === shortcut.value
 ?'bg-os-blue text-white border-os-blue'
 :'bg-os-card text-os-text-primary border-os-input-border hover:bg-os-card-secondary'
 }`}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
        </div>

        {/* Current Selection */}
        <div className="bg-os-card-secondary border border-os-border rounded-lg p-3">
          <p className="text-xs text-os-text-secondary mb-1">Current selection:</p>
          <p className="text-sm font-mono text-os-text-primary break-all">
            {directory || '(not set)'}
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-end gap-3">
        <button
          onClick={onCancel}
          className="px-4 py-2 bg-os-modal border border-os-input-border rounded-sm text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={!directory.trim()}
          className="flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Set Directory
        </button>
      </div>
    </BaseModal>
  );
}
