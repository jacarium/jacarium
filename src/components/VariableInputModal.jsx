import { useState, useEffect } from 'react';
import { X, FileText, AlertCircle } from 'lucide-react';

export default function VariableInputModal({ isOpen, onClose, onApply, variables, templateName }) {
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (isOpen && variables) {
      // Initialize with empty values
      const initialValues = {};
      variables.forEach(varName => {
        initialValues[varName] = '';
      });
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValues(initialValues);
      setErrors({});
    }
  }, [isOpen, variables]);

  function handleChange(varName, value) {
    setValues(prev => ({
      ...prev,
      [varName]: value
    }));
    // Clear error for this field
    if (errors[varName]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[varName];
        return newErrors;
      });
    }
  }

  function handleApply() {
    // Validate all variables are filled
    const newErrors = {};
    variables.forEach(varName => {
      if (!values[varName] || !values[varName].trim()) {
        newErrors[varName] = 'Required';
      }
    });

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    onApply(values);
    onClose();
  }

  function handleSkip() {
    onApply({});
    onClose();
  }

  if (!isOpen || !variables || variables.length === 0) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 font-text">
      <div className="bg-os-modal shadow-lg max-w-2xl w-full border border-os-border rounded-sm max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <FileText size={20} className="text-os-blue" />
            <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
              Template Variables
            </h2>
          </div>
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
              <strong>{templateName || 'This template'}</strong> contains variables. Please provide values below.
            </div>
          </div>

          <div className="space-y-4">
            {Array.from(variables).map(varName => (
              <div key={varName}>
                <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
                  {varName.replace(/_/g, ' ')}
                  <span className="text-status-danger ml-1">*</span>
                </label>
                <input
                  type="text"
                  value={values[varName] || ''}
                  onChange={(e) => handleChange(varName, e.target.value)}
                  placeholder={`Enter value for {{${varName}}}`}
                  className={`w-full px-3 py-2 border ${
 errors[varName] ?'border-red-500':'border-os-input-border'
 } focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted font-mono`}
                />
                {errors[varName] && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-1">{errors[varName]}</p>
                )}
                <p className="text-xs text-os-text-muted mt-1">
                  Variable placeholder: <code className="bg-os-card-secondary px-1 py-0.5 rounded-sm">{`{{${varName}}}`}</code>
                </p>
              </div>
            ))}
          </div>

          <div className="bg-os-card-secondary border border-os-border rounded-sm p-3">
            <p className="text-xs text-os-text-secondary">
              <strong>Tip:</strong> You can use JIRA functions like <code className="bg-os-card-secondary px-1 py-0.5 rounded-sm">currentUser()</code>,
              relative dates like <code className="bg-os-card-secondary px-1 py-0.5 rounded-sm">-7d</code>, or specific values.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-between sticky bottom-0">
          <button
            onClick={handleSkip}
            className="px-4 py-2 text-os-text-secondary text-sm hover:text-os-text-primary transition-colors"
          >
            Skip (Use Placeholders)
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              className="btn btn-primary px-4 py-2 text-sm"
            >
              Apply Template
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
