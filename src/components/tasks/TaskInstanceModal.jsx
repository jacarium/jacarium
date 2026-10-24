import { useState, useEffect } from 'react';
import { isDesktopApp } from '../../utils/platform';
import FormModal from '../common/modals/FormModal';
import ConfirmationModal from '../common/modals/ConfirmationModal';
import { useConfirmation } from '../../hooks/useConfirmation';
import { useNotifications } from '../../contexts/NotificationContext';
import {
  validateInstance,
  initializeInstance,
} from '../../utils/taskwarriorInstances';

export default function TaskInstanceModal({
  isOpen,
  onClose,
  onSubmit,
  editingInstance = null,
}) {
  const { addNotification } = useNotifications();
  const { confirm, confirmationProps } = useConfirmation();
  const [loading, setLoading] = useState(false);
  const [validationStatus, setValidationStatus] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    category: 'General',
    description: '',
    rcPath: '',
    dataPath: '',
    isActive: false,
  });

  // Reset form when modal opens/closes or when editingInstance changes
  useEffect(() => {
    if (isOpen && editingInstance) {
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFormData({
        name: editingInstance.name,
        category: editingInstance.category || 'General',
        description: editingInstance.description || '',
        rcPath: editingInstance.rcPath || '',
        dataPath: editingInstance.dataPath || '',
        isActive: editingInstance.isActive === 1,
      });
    } else if (isOpen && !editingInstance) {
      setFormData({
        name: '',
        category: 'General',
        description: '',
        rcPath: '~/.taskrc',
        dataPath: '~/.task',
        isActive: false,
      });
    }
    setValidationStatus(null);
  }, [isOpen, editingInstance]);

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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      await onSubmit(formData, editingInstance);
      onClose();
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

  return (
    <>
    <FormModal
      isOpen={isOpen}
      onClose={onClose}
      title={editingInstance ? 'Edit Instance' : 'New Instance'}
      size="md"
      onSubmit={handleSubmit}
      footerHint="Press Ctrl+Enter to save"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm bg-os-card hover:bg-os-card-secondary text-os-text-secondary border border-os-border rounded-sm transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            onClick={handleSubmit}
            disabled={loading}
            className="btn btn-primary px-4 py-2 text-sm"
          >
            {loading ? 'Saving...' : editingInstance ? 'Update' : 'Create'}
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs text-os-text-secondary mb-1">
            Instance Name *
          </label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-os-blue"
            placeholder="e.g., Personal Tasks"
            required
            autoFocus
          />
        </div>

        <div>
          <label className="block text-xs text-os-text-secondary mb-1">
            Category *
          </label>
          <input
            type="text"
            value={formData.category}
            onChange={(e) => setFormData({ ...formData, category: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-os-blue"
            placeholder="General"
            required
          />
        </div>

        <div>
          <label className="block text-xs text-os-text-secondary mb-1">
            Description
          </label>
          <textarea
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-os-blue resize-none"
            placeholder="Optional description"
            rows={3}
          />
        </div>

        <div>
          <label className="block text-xs text-os-text-secondary mb-1">
            Data Path *
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={formData.dataPath}
              onChange={(e) => setFormData({ ...formData, dataPath: e.target.value })}
              className="flex-1 px-3 py-2 text-sm bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-os-blue"
              placeholder="~/.task"
              required
            />
            <button
              type="button"
              onClick={handleValidate}
              disabled={loading}
              className="btn btn-primary px-3 py-2 text-sm"
            >
              Check
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs text-os-text-secondary mb-1">
            RC File Path *
          </label>
          <input
            type="text"
            value={formData.rcPath}
            onChange={(e) => setFormData({ ...formData, rcPath: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-os-blue"
            placeholder="~/.taskrc"
            required
          />
        </div>

        {!isDesktopApp() && (
          <p className="text-xs text-os-text-muted" data-testid="task-paths-hint">
            On this server every account has its own Taskwarrior directory: instances live under
            <code className="mx-1 font-mono">~/.task/&lt;name&gt;</code> with their rc file at
            <code className="mx-1 font-mono">~/.task/&lt;name&gt;/taskrc</code> (the default instance is
            <code className="mx-1 font-mono">~/.task</code> + <code className="mx-1 font-mono">~/.taskrc</code>);
            <code className="mx-1 font-mono">~</code> is your account's home there.
          </p>
        )}

        {/* Validation Status */}
        {validationStatus && (
          <div className={`p-3 rounded text-sm ${
 validationStatus.valid
 ?'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-200'
 :'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-200'
 }`}>
            <p className="font-medium">
              {validationStatus.valid ? '✓ Valid' : '✗ Invalid'}
            </p>
            {validationStatus.errors.length > 0 && (
              <ul className="mt-2 space-y-1">
                {validationStatus.errors.map((error, idx) => (
                  <li key={idx}>• {error}</li>
                ))}
              </ul>
            )}
            {!validationStatus.valid && (
              <button
                type="button"
                onClick={handleInitialize}
                disabled={loading}
                className="btn btn-primary mt-3 px-3 py-2 text-sm"
              >
                Initialize
              </button>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="isActive"
            checked={formData.isActive}
            onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
            className="w-4 h-4"
          />
          <label htmlFor="isActive" className="text-sm text-os-text-secondary">
            Set as active instance
          </label>
        </div>
      </form>
    </FormModal>
    <ConfirmationModal {...confirmationProps} />
    </>
  );
}
