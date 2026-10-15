import { useState } from 'react';
import { X } from 'lucide-react';

/**
 * Create or edit a custom function (capability type). For built-in functions
 * only the label/description are editable; funcId is immutable because
 * executables reference it.
 */
export default function FunctionEditModal({ func, onSave, onClose }) {
  const isNew = !func;
  const [label, setLabel] = useState(func?.label || '');
  const [description, setDescription] = useState(func?.description || '');
  const [error, setError] = useState('');

  const handleSave = async () => {
    const trimmed = label.trim();
    if (!trimmed) {
      setError('Label is required');
      return;
    }
    try {
      await onSave({ label: trimmed, description: description.trim() });
    } catch (err) {
      setError(err.message || 'Failed to save function');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-os-modal shadow-lg max-w-md w-full border border-os-border rounded-sm">
        <div className="p-4 border-b border-os-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-os-text-primary uppercase tracking-wide">
            {isNew ? 'New Function' : `Edit ${func.label}`}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors">
            <X size={20} className="text-os-text-secondary" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
          <div>
            <label className="block text-xs text-os-text-primary mb-2 uppercase tracking-wide">
              Label *
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g., Kernel module load"
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
              autoFocus
            />
            {!isNew && (
              <p className="text-xs text-os-text-muted mt-1">
                id: <span className="font-mono">{func.funcId}</span> (immutable)
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs text-os-text-primary mb-2 uppercase tracking-wide">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this capability allows an attacker to do"
              rows="3"
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden resize-none text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
            />
          </div>
        </div>
        <div className="p-4 border-t border-os-border flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-os-input-border text-os-text-primary text-sm rounded-sm hover:bg-os-card-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-os-blue text-white text-sm rounded-sm hover:bg-blue-600 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
