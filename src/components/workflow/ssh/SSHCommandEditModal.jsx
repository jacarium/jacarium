import { X } from 'lucide-react';

const INPUT_CLASS = 'w-full px-3 py-1.5 bg-os-input-bg text-os-text-primary border border-os-input-border rounded-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue text-xs';

/**
 * Add or edit a saved SSH command (name, command text with optional
 * {{VARIABLE}} placeholders, description). `command` is the one being
 * edited, or null for a new one.
 */
export default function SSHCommandEditModal({ command, onSave, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-os-card rounded-lg shadow-2xl w-full max-w-lg border border-os-border">
        <div className="px-4 py-3 border-b border-os-border flex items-center justify-between">
          <span className="text-sm font-medium text-os-text-primary">
            {command ? 'Edit Command' : 'Add Command'}
          </span>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            <X size={16} className="text-os-text-secondary" />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            onSave({
              name: formData.get('name'),
              command: formData.get('command'),
              description: formData.get('description'),
            });
          }}
          className="p-4 space-y-3"
        >
          <div>
            <label className="block text-xs text-os-text-primary mb-1">
              Name
            </label>
            <input
              name="name"
              type="text"
              defaultValue={command?.name}
              required
              className={INPUT_CLASS}
              placeholder="e.g., Analyze sosreport"
            />
          </div>
          <div>
            <label className="block text-xs text-os-text-primary mb-1">
              Command
            </label>
            <textarea
              name="command"
              defaultValue={command?.command}
              required
              rows={3}
              className={`${INPUT_CLASS} font-mono`}
              placeholder="e.g., cd {{SOSREPORT}} && ls -la"
            />
            <p className="text-xs text-os-text-muted mt-1">
              Use {'{{'} VARIABLE_NAME {'}'} for variables
            </p>
          </div>
          <div>
            <label className="block text-xs text-os-text-primary mb-1">
              Description (optional)
            </label>
            <input
              name="description"
              type="text"
              defaultValue={command?.description}
              className={INPUT_CLASS}
              placeholder="e.g., Navigate to sosreport directory"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 bg-os-card-secondary hover:bg-os-card border border-os-border text-os-text-primary rounded-sm transition-colors text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary px-3 py-1.5 text-xs"
            >
              {command ? 'Update' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
