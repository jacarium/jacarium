import { X } from 'lucide-react';

/**
 * Collect a value for each {{VARIABLE}} of a saved command before it is
 * inserted into the terminal input. `values` maps variable name -> text.
 */
export default function SSHCommandVariablesModal({ command, values, onChange, onSubmit, onClose }) {
  const names = Object.keys(values);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-os-card rounded-lg shadow-2xl w-full max-w-md border border-os-border">
        <div className="px-4 py-3 border-b border-os-border flex items-center justify-between">
          <span className="text-sm font-medium text-os-text-primary">
            Enter Variable Values
          </span>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            <X size={16} className="text-os-text-secondary" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="text-xs text-os-text-muted mb-3">
            Command: <span className="font-mono text-os-text-primary">{command.name}</span>
          </div>
          {names.map(varName => (
            <div key={varName}>
              <label className="block text-xs text-os-text-primary mb-1">
                {varName}
              </label>
              <input
                type="text"
                value={values[varName]}
                onChange={(e) => onChange(varName, e.target.value)}
                className="w-full px-3 py-1.5 bg-os-input-bg text-os-text-primary border border-os-input-border rounded-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue text-xs font-mono"
                placeholder={`Enter ${varName}...`}
                autoFocus={varName === names[0]}
              />
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-os-card-secondary hover:bg-os-card border border-os-border text-os-text-primary rounded-sm transition-colors text-xs"
            >
              Cancel
            </button>
            <button
              onClick={onSubmit}
              disabled={Object.values(values).some(v => !v.trim())}
              className="px-3 py-1.5 bg-os-blue hover:bg-blue-600 text-white rounded-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-xs"
            >
              Insert Command
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
