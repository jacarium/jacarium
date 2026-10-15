import { useState, useEffect } from 'react';
import { X, Trash2 } from 'lucide-react';
import { getCustomFields, addCustomField, removeCustomField, defaultOperatorsByType } from '../utils/customFields';
import ConfirmationModal from './common/modals/ConfirmationModal';
import { useConfirmation } from '../hooks/useConfirmation';

export default function CustomFieldsModal({ isOpen, onClose, onFieldsChanged }) {
  const { confirm, confirmationProps } = useConfirmation();
  const [customFields, setCustomFields] = useState([]);
  const [fieldId, setFieldId] = useState('');
  const [fieldName, setFieldName] = useState('');
  const [fieldType, setFieldType] = useState('text');
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadCustomFields();
    }
  }, [isOpen]);

  async function loadCustomFields() {
    const fields = await getCustomFields();
    setCustomFields(fields);
  }

  async function handleAdd() {
    setError('');

    const trimmedId = fieldId.trim();
    const trimmedName = fieldName.trim();

    if (!trimmedName) {
      setError('Field Name is required');
      return;
    }

    // Validate ID format if provided - allow letters, numbers, underscores, and brackets for cf[12345] format
    if (trimmedId && !/^[a-zA-Z0-9_[\]]+$/.test(trimmedId)) {
      setError('Field ID can only contain letters, numbers, underscores, and brackets []. Example: cf[12345]');
      return;
    }

    try {
      const newField = {
        id: trimmedId || trimmedName, // Use name as fallback ID if not provided
        name: trimmedName,
        type: fieldType,
        operators: defaultOperatorsByType[fieldType] || defaultOperatorsByType.text,
        useNameInJQL: !trimmedId, // Flag to indicate we should use name in JQL instead of ID
      };

      await addCustomField(newField);
      loadCustomFields();

      // Clear form
      setFieldId('');
      setFieldName('');
      setFieldType('text');
      setError('');

      // Notify parent
      if (onFieldsChanged) {
        onFieldsChanged();
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRemove(id) {
    if (await confirm({
      title: 'Remove Custom Field',
      message: 'Are you sure you want to remove this custom field?',
      type: 'danger',
      confirmLabel: 'Remove',
    })) {
      await removeCustomField(id);
      loadCustomFields();

      // Notify parent
      if (onFieldsChanged) {
        onFieldsChanged();
      }
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 font-text">
      <div className="bg-os-modal shadow-lg max-w-2xl w-full border border-os-border rounded-sm max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between sticky top-0 z-10">
          <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">Manage Custom Fields</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-sidebar-hover transition-colors"
          >
            <X size={20} className="text-os-text-secondary" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6 bg-os-modal">
          {/* Add Custom Field Form */}
          <div className="bg-os-card-secondary border border-os-border rounded-sm p-4">
            <h3 className="text-sm font-semibold text-os-text-primary mb-2">Add Custom Field</h3>
            <p className="text-xs text-os-text-secondary mb-4">
              Add custom JIRA fields. Provide Field ID (e.g., "cf[12345]") for exact JQL, or leave empty to use the field name in quotes like "Story Points".
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
                  Field ID (Optional)
                </label>
                <input
                  type="text"
                  value={fieldId}
                  onChange={(e) => setFieldId(e.target.value)}
                  placeholder="cf[12345]"
                  className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
                />
                <p className="text-xs text-os-text-muted mt-1">If empty, uses "Field Name" format</p>
              </div>

              <div>
                <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
                  Field Name *
                </label>
                <input
                  type="text"
                  value={fieldName}
                  onChange={(e) => setFieldName(e.target.value)}
                  placeholder="Story Points"
                  className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
                />
                <p className="text-xs text-os-text-muted mt-1">Used as "Field Name" in JQL if no ID</p>
              </div>

              <div>
                <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
                  Field Type
                </label>
                <select
                  value={fieldType}
                  onChange={(e) => setFieldType(e.target.value)}
                  className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary"
                >
                  <option value="text">Text</option>
                  <option value="select">Select</option>
                  <option value="date">Date</option>
                  <option value="number">Number</option>
                </select>
                <p className="text-xs text-os-text-muted mt-1">Data type</p>
              </div>
            </div>

            {error && (
              <div className="mt-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm p-2">
                {error}
              </div>
            )}

            <div className="mt-4">
              <button
                onClick={handleAdd}
                className="flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors shadow-xs"
              >
                Add Field
              </button>
            </div>
          </div>

          {/* Custom Fields List */}
          <div>
            <h3 className="text-sm font-semibold text-os-text-primary mb-3">Your Custom Fields</h3>

            {customFields.length === 0 ? (
              <div className="text-center py-8 text-os-text-muted text-sm border border-os-border rounded-sm bg-os-card-secondary">
                No custom fields yet. Add one above to get started.
              </div>
            ) : (
              <div className="space-y-2">
                {customFields.map(field => (
                  <div
                    key={field.id}
                    className="flex items-center justify-between p-3 border border-os-border rounded-sm bg-os-modal hover:bg-os-card-secondary transition-colors"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <span className="font-semibold text-os-text-primary">{field.name}</span>
                        <span className="text-xs px-2 py-0.5 bg-os-divider text-os-text-secondary rounded-sm font-mono">
                          {field.useNameInJQL ? `"${field.name}"` : field.id}
                        </span>
                        <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 dark:text-blue-300 rounded-sm">
                          {field.type}
                        </span>
                      </div>
                      <div className="text-xs text-os-text-muted mt-1">
                        Operators: {field.operators.join(', ')}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemove(field.id)}
                      className="p-2 text-status-danger hover:bg-red-50 dark:bg-red-900/20 dark:hover:bg-red-900/20 rounded-sm transition-colors"
                      title="Remove field"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-end sticky bottom-0">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors shadow-xs"
          >
            Done
          </button>
        </div>
      </div>

      {/* Confirmation Modal (replaces native confirm) */}
      <ConfirmationModal {...confirmationProps} />
    </div>
  );
}
