import { useState } from 'react';
import { X, Save } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';

export default function SaveQueryModal({ isOpen, onClose, onSave, currentJQL }) {
  const { addNotification } = useNotifications();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  function handleSave() {
    const trimmedName = name.trim();

    if (!trimmedName) {
      addNotification({
        type: 'alert',
        title: 'Name Required',
        message: 'Please enter a name for this query.'
      });
      return;
    }

    setSaving(true);

    try {
      onSave(trimmedName);
      setName('');
      onClose();
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Save Failed',
        message: 'Failed to save query: ' + error.message
      });
    } finally {
      setSaving(false);
    }
  }

  function handleKeyPress(e) {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 font-text">
      <div className="bg-os-modal shadow-xl max-w-md w-full border-4 border-rh-red">
        {/* Header */}
        <div className="p-4 border-b-2 border-rh-border bg-rh-gray flex items-center justify-between">
          <h2 className="text-lg font-semibold text-os-text-primary">Save Query</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-card-secondary transition-colors"
          >
            <X size={20} className="text-os-text-primary" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          <div className="mb-4">
            <label className="block text-sm font-display text-os-text-primary mb-2">
              Query Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="e.g., Open bugs in RHEL"
              className="w-full px-3 py-2 border-2 border-rh-border focus:ring-2 focus:ring-rh-red focus:border-rh-red outline-hidden"
              autoFocus
            />
          </div>

          <div className="bg-rh-gray p-3 border-2 border-rh-border">
            <label className="block text-xs font-display text-os-text-primary mb-2">
              JQL Preview
            </label>
            <code className="text-xs text-os-text-primary font-mono break-all">
              {currentJQL || 'No query built yet'}
            </code>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t-2 border-rh-border bg-rh-gray flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border-2 border-rh-black text-rh-black hover:bg-os-card-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-rh-red text-white hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save Query'}
          </button>
        </div>
      </div>
    </div>
  );
}
