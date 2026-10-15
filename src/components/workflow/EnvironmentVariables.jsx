import { useState, useEffect } from 'react';
import { Settings, Trash2, Save, X, Eye, EyeOff } from 'lucide-react';
import { getEnvironmentVariables, setEnvironmentVariable, deleteEnvironmentVariable } from '../../utils/workflows';
import { useNotifications } from '../../contexts/NotificationContext';
import ConfirmationModal from '../common/modals/ConfirmationModal';
import { useConfirmation } from '../../hooks/useConfirmation';
import { EmptyState } from '../ui';

export default function EnvironmentVariables({ onClose }) {
  const { addNotification } = useNotifications();
  const { confirm, confirmationProps } = useConfirmation();
  const [variables, setVariables] = useState({});
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState(null);
  const [editingValue, setEditingValue] = useState('');
  const [showValues, setShowValues] = useState({});

  useEffect(() => {
    loadVariables();
  }, []);

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

  async function handleUpdateVariable(key) {
    try {
      await setEnvironmentVariable(key, editingValue);
      await loadVariables();
      setEditingKey(null);
      setEditingValue('');
    } catch (error) {
      console.error('Failed to update variable:', error);
      addNotification({
        type: 'error',
        title: 'Update Failed',
        message: 'Failed to update variable.'
      });
    }
  }

  async function handleDeleteVariable(key) {
    if (!(await confirm({
      title: 'Delete Environment Variable',
      message: `Delete environment variable "${key}"?`,
      type: 'danger',
      confirmLabel: 'Delete',
    }))) return;

    try {
      await deleteEnvironmentVariable(key);
      await loadVariables();
    } catch (error) {
      console.error('Failed to delete variable:', error);
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: 'Failed to delete variable.'
      });
    }
  }

  function startEditing(key, value) {
    setEditingKey(key);
    setEditingValue(value);
  }

  function cancelEditing() {
    setEditingKey(null);
    setEditingValue('');
  }

  function toggleValueVisibility(key) {
    setShowValues(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  }

  const variableKeys = Object.keys(variables);

  return (
    <div className="h-full flex flex-col bg-os-bg">
      {/* Header */}
      <div className="bg-os-card border-b border-os-border px-6 py-4 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings size={24} className="text-os-text-secondary" />
            <div>
              <h1 className="text-xl font-semibold text-os-text-primary">
                Environment Variables
              </h1>
              <p className="text-sm text-os-text-secondary mt-0.5">
                Configure variables for use in workflow nodes
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-sm text-os-text-secondary">
              {variableKeys.length} variable{variableKeys.length !== 1 ? 's' : ''}
            </div>
            {onClose && (
              <button
                onClick={onClose}
                className="p-1.5 text-os-text-secondary hover:bg-os-card-secondary rounded-sm transition-colors"
                title="Close"
              >
                <X size={18} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto">
          {/* Info Card */}
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg p-4 mb-6">
            <div className="flex items-start gap-3">
              <Settings size={20} className="text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-200 mb-1">
                  How to use environment variables
                </h3>
                <p className="text-sm text-blue-800 dark:text-blue-300">
                  Use <code className="bg-blue-100 dark:bg-blue-800 px-1.5 py-0.5 rounded-sm font-mono text-xs">{'{{VARIABLE_NAME}}'}</code> in your workflow nodes.
                  For example: <code className="bg-blue-100 dark:bg-blue-800 px-1.5 py-0.5 rounded-sm font-mono text-xs">{'{{BASE_URL}}/api/users'}</code>
                </p>
              </div>
            </div>
          </div>

          {/* Add New Variable */}
          <div className="bg-os-card border border-os-border rounded-lg mb-6">
            <div className="px-4 py-3 border-b border-os-border">
              <h2 className="text-sm font-semibold text-os-text-primary">
                Add New Variable
              </h2>
            </div>
            <div className="p-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-os-text-secondary mb-1.5">
                    Key
                  </label>
                  <input
                    type="text"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="e.g., BASE_URL"
                    className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue text-sm font-mono bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddVariable();
                    }}
                  />
                </div>
                <div>
                  <label className="block text-xs text-os-text-secondary mb-1.5">
                    Value
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newValue}
                      onChange={(e) => setNewValue(e.target.value)}
                      placeholder="e.g., https://api.example.com"
                      className="flex-1 px-3 py-2 border border-os-input-border rounded-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue text-sm bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAddVariable();
                      }}
                    />
                    <button
                      onClick={handleAddVariable}
                      disabled={!newKey.trim()}
                      className="flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Variables List */}
          <div className="bg-os-card border border-os-border rounded-lg">
            <div className="px-4 py-3 border-b border-os-border">
              <h2 className="text-sm font-semibold text-os-text-primary">
                Existing Variables
              </h2>
            </div>
            <div className="divide-y divide-os-border">
              {variableKeys.length === 0 ? (
                <EmptyState compact icon={Settings} title="No environment variables configured" description="Add your first variable above to get started" />
              ) : (
                variableKeys.map((key) => (
                  <div key={key} className="p-4 hover:bg-os-card-secondary transition-colors">
                    {editingKey === key ? (
                      // Edit mode
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-os-text-secondary mb-1.5">
                            Key
                          </label>
                          <div className="px-3 py-2 bg-os-input-bg border border-os-input-border rounded-sm text-sm font-mono text-os-text-secondary">
                            {key}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-os-text-secondary mb-1.5">
                            Value
                          </label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              className="flex-1 px-3 py-2 border border-os-input-border rounded-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue text-sm bg-os-input-bg text-os-text-primary"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleUpdateVariable(key);
                                if (e.key === 'Escape') cancelEditing();
                              }}
                            />
                            <button
                              onClick={() => handleUpdateVariable(key)}
                              className="p-2 bg-os-blue text-white rounded-sm hover:bg-os-blue-hover transition-colors"
                              title="Save"
                            >
                              <Save size={16} />
                            </button>
                            <button
                              onClick={cancelEditing}
                              className="p-2 bg-os-card border border-os-input-border text-os-text-primary rounded-sm hover:bg-os-card-secondary transition-colors"
                              title="Cancel"
                            >
                              <X size={16} />
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      // View mode
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex-1 grid grid-cols-2 gap-4">
                          <div>
                            <div className="text-xs font-medium text-os-text-secondary mb-1">
                              Key
                            </div>
                            <div className="text-sm font-mono text-os-text-primary bg-os-input-bg px-3 py-1.5 rounded-sm border border-os-input-border">
                              {key}
                            </div>
                          </div>
                          <div>
                            <div className="text-xs font-medium text-os-text-secondary mb-1">
                              Value
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="flex-1 text-sm text-os-text-primary bg-os-input-bg px-3 py-1.5 rounded-sm border border-os-input-border font-mono">
                                {showValues[key] ? variables[key] : '••••••••'}
                              </div>
                              <button
                                onClick={() => toggleValueVisibility(key)}
                                className="p-1.5 text-os-text-secondary hover:bg-os-card-secondary rounded-sm transition-colors"
                                title={showValues[key] ? 'Hide value' : 'Show value'}
                              >
                                {showValues[key] ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => startEditing(key, variables[key])}
                            className="px-3 py-1.5 text-sm text-os-text-primary border border-os-input-border rounded-sm hover:bg-os-card-secondary transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteVariable(key)}
                            className="p-1.5 text-red-600 hover:bg-red-50 rounded-sm transition-colors"
                            title="Delete variable"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Usage Examples */}
          <div className="bg-os-card border border-os-border rounded-lg mt-6">
            <div className="px-4 py-3 border-b border-os-border">
              <h2 className="text-sm font-semibold text-os-text-primary">
                Usage Examples
              </h2>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <div className="text-xs font-medium text-os-text-secondary mb-1">
                  REST API Node - URL
                </div>
                <code className="block bg-os-input-bg px-3 py-2 rounded-sm border border-os-input-border text-xs font-mono text-os-text-primary">
                  {'{{BASE_URL}}/api/v1/users'}
                </code>
              </div>
              <div>
                <div className="text-xs font-medium text-os-text-secondary mb-1">
                  REST API Node - Headers
                </div>
                <code className="block bg-os-input-bg px-3 py-2 rounded-sm border border-os-input-border text-xs font-mono text-os-text-primary">
                  {'Authorization: Bearer {{API_TOKEN}}'}
                </code>
              </div>
              <div>
                <div className="text-xs font-medium text-os-text-secondary mb-1">
                  Transformation Node - JavaScript
                </div>
                <code className="block bg-os-input-bg px-3 py-2 rounded-sm border border-os-input-border text-xs font-mono text-os-text-primary">
                  {'const endpoint = "{{API_ENDPOINT}}";'}
                </code>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation Modal (replaces native confirm) */}
      <ConfirmationModal {...confirmationProps} />
    </div>
  );
}
