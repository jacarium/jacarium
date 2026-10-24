import { useState, useEffect } from 'react';
import { X, Trash2, Settings } from 'lucide-react';
import { getEnvironmentVariables, setEnvironmentVariable, deleteEnvironmentVariable } from '../../../utils/workflows';
import { useNotifications } from '../../../contexts/NotificationContext';

/**
 * EnvVariablesModal - Modal for managing workflow environment variables
 *
 * Variables can be used in workflow nodes with {{VAR_NAME}} syntax
 */
export default function EnvVariablesModal({ isOpen, onClose }) {
  const { addNotification } = useNotifications();
  const [variables, setVariables] = useState({});
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadVariables();
    }
  }, [isOpen]);

  async function loadVariables() {
    const vars = await getEnvironmentVariables();
    setVariables(vars);
  }

  async function handleAddVariable() {
    if (!newKey.trim()) return;

    try {
      await setEnvironmentVariable(newKey.trim(), newValue);
      await loadVariables();
      setNewKey('');
      setNewValue('');
    } catch (error) {
      console.error('Failed to add variable:', error);
      addNotification({
        type: 'error',
        title: 'Add Failed',
        message: 'Failed to add variable.'
      });
    }
  }

  async function handleRemoveVariable(key) {
    try {
      await deleteEnvironmentVariable(key);
      await loadVariables();
    } catch (error) {
      console.error('Failed to remove variable:', error);
      addNotification({
        type: 'error',
        title: 'Remove Failed',
        message: 'Failed to remove variable.'
      });
    }
  }

  async function handleUpdateVariable(key, value) {
    try {
      await setEnvironmentVariable(key, value);
      await loadVariables();
    } catch (error) {
      console.error('Failed to update variable:', error);
      addNotification({
        type: 'error',
        title: 'Update Failed',
        message: 'Failed to update variable.'
      });
    }
  }

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-os-modal rounded-lg shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-os-border">
            <div className="flex items-center gap-2">
              <Settings size={20} className="text-purple-600" />
              <h2 className="text-lg font-semibold">Environment Variables</h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="mb-4 text-sm text-os-text-secondary">
              <p className="mb-2">
                Define variables that can be used in workflow nodes with <code className="bg-os-card-secondary px-1 rounded-sm">{'{{VAR_NAME}}'}</code> syntax.
              </p>
              <p className="text-xs text-os-text-muted">
                Example: Set <code className="bg-os-card-secondary px-1 rounded-sm">API_URL</code> to <code className="bg-os-card-secondary px-1 rounded-sm">https://api.example.com</code>,
                then use <code className="bg-os-card-secondary px-1 rounded-sm">{'{{API_URL}}/users'}</code> in your nodes.
              </p>
            </div>

            {/* Variable List */}
            <div className="space-y-2 mb-4">
              {Object.entries(variables).map(([key, value]) => (
                <div key={key} className="flex items-start gap-2 p-3 bg-os-card-secondary rounded-sm border border-os-border">
                  <div className="flex-1 grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-xs text-os-text-muted mb-1">Variable Name</div>
                      <div className="font-mono text-sm font-semibold">{key}</div>
                    </div>
                    <div>
                      <div className="text-xs text-os-text-muted mb-1">Value</div>
                      <input
                        type="text"
                        value={value}
                        onChange={(e) => handleUpdateVariable(key, e.target.value)}
                        className="w-full px-2 py-1 text-sm border border-os-input-border rounded-sm focus:outline-hidden focus:border-purple-500 font-mono"
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemoveVariable(key)}
                    className="btn btn-danger-ghost p-1.5"
                    title="Remove variable"
                  >
                    <Trash2 size={16} className="text-red-600" />
                  </button>
                </div>
              ))}

              {Object.keys(variables).length === 0 && (
                <div className="text-center py-8 text-os-text-muted text-sm">
                  No environment variables defined yet
                </div>
              )}
            </div>

            {/* Add New Variable */}
            <div className="border-t border-os-border pt-4">
              <div className="text-sm font-medium text-os-text-primary mb-2">Add New Variable</div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleAddVariable()}
                  placeholder="Variable name (e.g., API_URL)"
                  className="flex-1 px-3 py-2 text-sm border border-os-input-border rounded-sm focus:outline-hidden focus:border-purple-500 font-mono"
                />
                <input
                  type="text"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleAddVariable()}
                  placeholder="Value"
                  className="flex-1 px-3 py-2 text-sm border border-os-input-border rounded-sm focus:outline-hidden focus:border-purple-500 font-mono"
                />
                <button
                  onClick={handleAddVariable}
                  disabled={!newKey.trim()}
                  className="btn btn-brand px-4 py-2 flex items-center gap-2"
                >
                  Add
                </button>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 p-4 border-t border-os-border">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-os-divider text-os-text-primary rounded-sm hover:bg-os-border transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
