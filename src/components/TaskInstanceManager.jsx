import React, { useState, useEffect } from 'react';
import { isDesktopApp } from '../utils/platform';
import { X, Check, Edit2, Trash2, Database, FolderOpen, FileText, AlertCircle, CheckCircle } from 'lucide-react';
import ConfirmationModal from './common/modals/ConfirmationModal';
import { useConfirmation } from '../hooks/useConfirmation';
import { useNotifications } from '../contexts/NotificationContext';
import {
  getAllInstances,
  getActiveInstance,
  createInstance,
  updateInstance,
  deleteInstance,
  setActiveInstance,
  initializeInstance,
  validateInstance,
  getInstanceStats,
} from '../utils/taskwarriorInstances';

export default function TaskInstanceManager({ isOpen, onClose }) {
  const { addNotification } = useNotifications();
  const { confirm, confirmationProps } = useConfirmation();
  const [instances, setInstances] = useState([]);
  const [activeInstance, setActive] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editingInstance, setEditingInstance] = useState(null);
  const [loading, setLoading] = useState(false);
  const [validationStatus, setValidationStatus] = useState(null);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    rcPath: '',
    dataPath: '',
    isActive: false,
  });

  // Load instances
  const loadInstances = async () => {
    try {
      const allInstances = await getAllInstances();
      const active = await getActiveInstance();
      setInstances(allInstances);
      setActive(active);
    } catch (error) {
      console.error('Error loading instances:', error);
    }
  };

  useEffect(() => {
    if (isOpen) {
      // async loader; sets state only after awaits
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadInstances();
    }
  }, [isOpen]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (editingInstance) {
        await updateInstance(editingInstance.id, formData);
      } else {
        // Validate before creating
        if (formData.dataPath) {
          const validation = await validateInstance(
            formData.rcPath || null,
            formData.dataPath
          );

          if (!validation.valid && validation.errors.length > 0) {
            // Ask user if they want to initialize
            if (await confirm({
              title: 'Instance Validation Failed',
              message: `Instance validation failed:\n${validation.errors.join('\n')}\n\nDo you want to initialize this instance?`,
              type: 'warning',
              confirmLabel: 'Initialize',
            })) {
              await initializeInstance(
                formData.dataPath,
                formData.rcPath || '',
                {}
              );
            } else {
              setLoading(false);
              return;
            }
          }
        }

        await createInstance(formData);
      }

      setShowForm(false);
      setEditingInstance(null);
      setFormData({
        name: '',
        description: '',
        rcPath: '',
        dataPath: '',
        isActive: false,
      });
      setValidationStatus(null);
      await loadInstances();
    } catch (error) {
      console.error('Error saving instance:', error);
      addNotification({
        type: 'error',
        title: 'Save Failed',
        message: `Error: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (instance) => {
    setEditingInstance(instance);
    setFormData({
      name: instance.name,
      description: instance.description || '',
      rcPath: instance.rcPath || '',
      dataPath: instance.dataPath || '',
      isActive: instance.isActive === 1,
    });
    setShowForm(true);
  };

  const handleDelete = async (instance) => {
    if (await confirm({
      title: 'Delete Instance',
      message: `Delete instance "${instance.name}"? This will also delete all associated tasks and reports.`,
      type: 'danger',
      confirmLabel: 'Delete',
    })) {
      try {
        await deleteInstance(instance.id);
        await loadInstances();
      } catch (error) {
        console.error('Error deleting instance:', error);
        addNotification({
          type: 'error',
          title: 'Delete Failed',
          message: `Error: ${error.message}`
        });
      }
    }
  };

  const handleSetActive = async (instance) => {
    try {
      await setActiveInstance(instance.id);
      await loadInstances();
    } catch (error) {
      console.error('Error setting active instance:', error);
      addNotification({
        type: 'error',
        title: 'Activation Failed',
        message: `Error: ${error.message}`
      });
    }
  };

  const handleValidate = async () => {
    if (!formData.dataPath) {
      addNotification({
        type: 'alert',
        title: 'Data Path Required',
        message: 'Please enter a data path first'
      });
      return;
    }

    setLoading(true);
    try {
      const result = await validateInstance(
        formData.rcPath || null,
        formData.dataPath
      );
      setValidationStatus(result);
    } catch (error) {
      console.error('Error validating instance:', error);
      setValidationStatus({
        valid: false,
        errors: [error.message],
        warnings: [],
      });
    } finally {
      setLoading(false);
    }
  };

  const handleInitialize = async () => {
    if (!formData.dataPath) {
      addNotification({
        type: 'alert',
        title: 'Data Path Required',
        message: 'Please enter a data path first'
      });
      return;
    }

    if (!(await confirm({
      title: 'Initialize Instance',
      message: `Initialize new TaskWarrior instance at:\n\nData: ${formData.dataPath}\nRC: ${formData.rcPath || '(default)'}\n\nThis will create necessary files and directories.`,
      type: 'info',
      confirmLabel: 'Initialize',
    }))) {
      return;
    }

    setLoading(true);
    try {
      await initializeInstance(
        formData.dataPath,
        formData.rcPath || '',
        {}
      );
      addNotification({
        type: 'success',
        title: 'Instance Initialized',
        message: 'Instance initialized successfully!'
      });
      // Revalidate
      await handleValidate();
    } catch (error) {
      console.error('Error initializing instance:', error);
      addNotification({
        type: 'error',
        title: 'Initialization Failed',
        message: `Error: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-os-card rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-os-border">
          <h2 className="text-lg font-semibold text-os-text-primary flex items-center gap-2">
            TaskWarrior Instances
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            <X className="w-5 h-5 text-os-text-secondary" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {!showForm ? (
            <>
              {/* Instance List */}
              <div className="space-y-2 mb-4">
                {instances.length === 0 ? (
                  <div className="text-center py-8 text-os-text-secondary">
                    <Database className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>No instances configured</p>
                    <p className="text-sm mt-1">Create your first TaskWarrior instance to get started</p>
                  </div>
                ) : (
                  instances.map((instance) => (
                    <InstanceCard
                      key={instance.id}
                      instance={instance}
                      isActive={activeInstance?.id === instance.id}
                      onEdit={() => handleEdit(instance)}
                      onDelete={() => handleDelete(instance)}
                      onSetActive={() => handleSetActive(instance)}
                    />
                  ))
                )}
              </div>

              {/* Add Button */}
              <button
                onClick={() => setShowForm(true)}
                className="w-full py-3 px-4 bg-os-card-secondary hover:bg-os-card-secondary text-os-text-primary transition-colors flex items-center justify-center gap-2"
              >
                Add New Instance
              </button>
            </>
          ) : (
            /* Instance Form */
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-os-text-primary mb-1">
                  Instance Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 bg-os-card-secondary border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-blue-500"
                  placeholder="e.g., Personal Tasks, Work Projects"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-os-text-primary mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 bg-os-card-secondary border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-blue-500 resize-none"
                  placeholder="Optional description"
                  rows={2}
                />
              </div>

              <div>
                <label className="block text-sm text-os-text-primary mb-1">
                  Data Path *
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={formData.dataPath}
                    onChange={(e) => setFormData({ ...formData, dataPath: e.target.value })}
                    className="flex-1 px-3 py-2 bg-os-card-secondary border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-blue-500"
                    placeholder="e.g., ~/.task-personal or ~/tasks/work"
                    required
                  />
                  <button
                    type="button"
                    onClick={handleValidate}
                    disabled={loading}
                    className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-os-text-primary rounded-sm transition-colors disabled:opacity-50"
                  >
                    Validate
                  </button>
                </div>
                <p className="text-xs text-os-text-muted mt-1">
                  Directory where TaskWarrior will store task data
                </p>
              </div>

              <div>
                <label className="block text-sm text-os-text-primary mb-1">
                  RC File Path (optional)
                </label>
                <input
                  type="text"
                  value={formData.rcPath}
                  onChange={(e) => setFormData({ ...formData, rcPath: e.target.value })}
                  className="w-full px-3 py-2 bg-os-card-secondary border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-blue-500"
                  placeholder="e.g., ~/.taskrc-personal (leave empty for default)"
                />
                <p className="text-xs text-os-text-muted mt-1">
                  Custom taskrc configuration file
                  {!isDesktopApp() && ' - on this server instances live under ~/.task/<name> (rc file ~/.task/<name>/taskrc); ~ is your account\'s home'}
                </p>
              </div>

              {/* Validation Status */}
              {validationStatus && (
                <div className={`p-3 rounded-lg ${
 validationStatus.valid
 ?'bg-green-900/20 border border-green-700'
 :'bg-red-900/20 border border-red-700'
 }`}>
                  <div className="flex items-start gap-2">
                    {validationStatus.valid ? (
                      <CheckCircle className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1">
                      <p className="font-medium text-sm">
                        {validationStatus.valid ? 'Valid Configuration' : 'Validation Failed'}
                      </p>
                      {validationStatus.errors.length > 0 && (
                        <ul className="text-sm mt-1 space-y-1">
                          {validationStatus.errors.map((error, idx) => (
                            <li key={idx} className="text-red-300">• {error}</li>
                          ))}
                        </ul>
                      )}
                      {validationStatus.warnings.length > 0 && (
                        <ul className="text-sm mt-1 space-y-1">
                          {validationStatus.warnings.map((warning, idx) => (
                            <li key={idx} className="text-yellow-300">• {warning}</li>
                          ))}
                        </ul>
                      )}
                      {validationStatus.stats && (
                        <div className="text-sm mt-2 text-os-text-primary">
                          <p>Tasks: {validationStatus.stats.total} total, {validationStatus.stats.pending} pending, {validationStatus.stats.completed} completed</p>
                        </div>
                      )}
                      {!validationStatus.valid && (
                        <button
                          type="button"
                          onClick={handleInitialize}
                          disabled={loading}
                          className="mt-2 px-3 py-1 bg-blue-600 hover:bg-blue-700 text-os-text-primary text-sm rounded-sm transition-colors disabled:opacity-50"
                        >
                          Initialize Instance
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={formData.isActive}
                  onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                  className="w-4 h-4 bg-os-card-secondary border-os-border rounded-sm"
                />
                <label htmlFor="isActive" className="text-sm text-os-text-primary">
                  Set as active instance
                </label>
              </div>

              {/* Form Actions */}
              <div className="flex gap-2 pt-4 border-t border-os-border">
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    setEditingInstance(null);
                    setValidationStatus(null);
                    setFormData({
                      name: '',
                      description: '',
                      rcPath: '',
                      dataPath: '',
                      isActive: false,
                    });
                  }}
                  className="px-4 py-2 bg-os-card-secondary hover:bg-os-card-secondary text-os-text-primary rounded-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-os-text-primary rounded-sm transition-colors disabled:opacity-50"
                >
                  {loading ? 'Saving...' : editingInstance ? 'Update Instance' : 'Create Instance'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* Confirmation Modal (replaces native window.confirm) */}
      <ConfirmationModal {...confirmationProps} />
    </div>
  );
}

function InstanceCard({ instance, isActive, onEdit, onDelete, onSetActive }) {
  const [stats, setStats] = useState(null);
  const [, setLoadingStats] = useState(false);

  const loadStats = async () => {
    setLoadingStats(true);
    try {
      const instanceStats = await getInstanceStats(
        instance.rcPath || null,
        instance.dataPath || null
      );
      setStats(instanceStats);
    } catch (error) {
      console.error('Error loading stats:', error);
    } finally {
      setLoadingStats(false);
    }
  };

  useEffect(() => {
    if (isActive) {
      // async loader; the sync setLoadingStats(true) is the spinner arm
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadStats();
    }
    // loadStats is recreated per render but only reads instance.id, which
    // is fixed for this card; isActive is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  return (
    <div className={`p-4 rounded-lg border ${
 isActive
 ?'bg-blue-900/20 border-blue-700'
 :'bg-os-card-secondary border-os-border'
 }`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-os-text-primary">{instance.name}</h3>
            {isActive && (
              <span className="px-2 py-0.5 bg-blue-600 text-os-text-primary text-xs rounded-sm">
                Active
              </span>
            )}
            {instance.inCloud === 1 && (
              <span className="px-2 py-0.5 bg-purple-600 text-os-text-primary text-xs rounded-sm">
                Cloud
              </span>
            )}
          </div>
          {instance.description && (
            <p className="text-sm text-os-text-secondary mt-1">{instance.description}</p>
          )}
          <div className="flex items-center gap-4 mt-2 text-xs text-os-text-muted">
            <span className="flex items-center gap-1">
              <FolderOpen className="w-3 h-3" />
              {instance.dataPath || 'Default'}
            </span>
            {instance.rcPath && (
              <span className="flex items-center gap-1">
                <FileText className="w-3 h-3" />
                {instance.rcPath}
              </span>
            )}
          </div>
          {stats && (
            <div className="flex items-center gap-4 mt-2 text-xs text-os-text-secondary">
              <span>{stats.total} total</span>
              <span>{stats.pending} pending</span>
              <span>{stats.completed} completed</span>
              {stats.projects > 0 && <span>{stats.projects} projects</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!isActive && (
            <button
              onClick={onSetActive}
              className="p-2 hover:bg-os-card-secondary rounded-sm transition-colors"
              title="Set as active"
            >
              <Check className="w-4 h-4 text-os-text-secondary" />
            </button>
          )}
          <button
            onClick={onEdit}
            className="p-2 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Edit"
          >
            <Edit2 className="w-4 h-4 text-os-text-secondary" />
          </button>
          <button
            onClick={onDelete}
            className="p-2 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4 text-red-400" />
          </button>
        </div>
      </div>
    </div>
  );
}
