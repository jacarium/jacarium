import { useState } from 'react';
import { X, AlertCircle } from 'lucide-react';
import { addCustomField, defaultOperatorsByType } from '../utils/customFields';

export default function CreateCustomFieldsModal({ isOpen, onClose, onFieldsCreated, detectedFields }) {
  const [selectedFields, setSelectedFields] = useState({});
  const [fieldTypes, setFieldTypes] = useState({});

  function handleToggleField(fieldName) {
    setSelectedFields(prev => ({
      ...prev,
      [fieldName]: !prev[fieldName]
    }));

    // Set default type when selecting a field
    if (!fieldTypes[fieldName]) {
      setFieldTypes(prev => ({
        ...prev,
        [fieldName]: 'text'
      }));
    }
  }

  function handleTypeChange(fieldName, type) {
    setFieldTypes(prev => ({
      ...prev,
      [fieldName]: type
    }));
  }

  function handleSelectAll() {
    const allSelected = {};
    const allTypes = {};
    detectedFields.forEach(fieldName => {
      allSelected[fieldName] = true;
      allTypes[fieldName] = fieldTypes[fieldName] || 'text';
    });
    setSelectedFields(allSelected);
    setFieldTypes(allTypes);
  }

  function handleDeselectAll() {
    setSelectedFields({});
  }

  async function handleCreate() {
    const fieldsToCreate = detectedFields.filter(fieldName => selectedFields[fieldName]);

    if (fieldsToCreate.length === 0) {
      onFieldsCreated();
      onClose();
      return;
    }

    const createdFields = [];

    for (const fieldName of fieldsToCreate) {
      try {
        const type = fieldTypes[fieldName] || 'text';
        const newField = {
          id: fieldName, // Use name as ID
          name: fieldName,
          type: type,
          operators: defaultOperatorsByType[type] || defaultOperatorsByType.text,
          useNameInJQL: true, // Flag to use quoted name in JQL
        };
        await addCustomField(newField);
        createdFields.push(newField);
      } catch (err) {
        console.error(`Failed to create custom field "${fieldName}":`, err);
      }
    }

    onFieldsCreated(createdFields);
    onClose();
  }

  function handleSkip() {
    onFieldsCreated();
    onClose();
  }

  if (!isOpen || !detectedFields || detectedFields.length === 0) return null;

  const selectedCount = Object.values(selectedFields).filter(Boolean).length;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 font-text">
      <div className="bg-os-modal shadow-lg max-w-2xl w-full border border-os-border rounded-sm max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between sticky top-0 z-10">
          <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
            Unknown Custom Fields Detected
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-sidebar-hover transition-colors"
          >
            <X size={20} className="text-os-text-secondary" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 bg-os-modal">
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-sm p-3 flex items-start gap-2">
            <AlertCircle size={16} className="text-blue-700 dark:text-blue-300 mt-0.5 shrink-0" />
            <div className="text-sm text-blue-800 dark:text-blue-200">
              The imported JQL contains <strong>{detectedFields.length}</strong> custom field{detectedFields.length > 1 ? 's' : ''} that {detectedFields.length > 1 ? "aren't" : "isn't"} in your list.
              Would you like to add {detectedFields.length > 1 ? 'them' : 'it'}?
            </div>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-sm text-os-text-primary font-semibold">
              Select fields to create ({selectedCount} of {detectedFields.length})
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleSelectAll}
                className="text-xs text-os-blue hover:underline"
              >
                Select All
              </button>
              <span className="text-os-text-muted">•</span>
              <button
                onClick={handleDeselectAll}
                className="text-xs text-os-blue hover:underline"
              >
                Deselect All
              </button>
            </div>
          </div>

          <div className="space-y-3 max-h-96 overflow-y-auto border border-os-border rounded-sm p-3 bg-os-card-secondary">
            {detectedFields.map(fieldName => (
              <div key={fieldName} className="bg-os-modal border border-os-border rounded-sm p-3">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selectedFields[fieldName] || false}
                    onChange={() => handleToggleField(fieldName)}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-semibold text-os-text-primary truncate">
                        {fieldName}
                      </span>
                      <code className="text-xs px-2 py-0.5 bg-os-card-secondary text-os-text-secondary rounded-sm font-mono">
                        "{fieldName}"
                      </code>
                    </div>
                    {selectedFields[fieldName] && (
                      <div>
                        <label className="block text-xs font-text text-os-text-primary mb-1 uppercase tracking-wide">
                          Field Type
                        </label>
                        <select
                          value={fieldTypes[fieldName] || 'text'}
                          onChange={(e) => handleTypeChange(fieldName, e.target.value)}
                          className="w-full px-3 py-1.5 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary"
                        >
                          <option value="text">Text</option>
                          <option value="select">Select</option>
                          <option value="date">Date</option>
                          <option value="number">Number</option>
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-between sticky bottom-0">
          <button
            onClick={handleSkip}
            className="px-4 py-2 text-os-text-secondary text-sm hover:text-os-text-primary transition-colors"
          >
            Skip (Don't Create)
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              className="flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors shadow-xs"
            >
              Create {selectedCount > 0 ? `${selectedCount} Field${selectedCount > 1 ? 's' : ''}` : 'Fields'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
