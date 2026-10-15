import { useState, useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';

/**
 * InlineEdit - Inline text editing component
 *
 * Features:
 * - Click to edit mode
 * - Enter to save, Escape to cancel
 * - Click outside to save (optional)
 * - Icon buttons for save/cancel (optional)
 * - Auto-focus on edit
 * - Validation support
 *
 * @param {string} value - Current value
 * @param {function} onSave - Callback when value is saved (receives new value)
 * @param {function} onCancel - Callback when editing is cancelled (optional)
 * @param {boolean} isEditing - External control of edit state (optional)
 * @param {function} onEditingChange - Callback when edit state changes (optional)
 * @param {boolean} showButtons - Show save/cancel buttons (default: false)
 * @param {boolean} saveOnBlur - Save on click outside (default: true)
 * @param {string} className - CSS classes for display mode
 * @param {string} inputClassName - CSS classes for input
 * @param {string} placeholder - Placeholder text
 * @param {function} validate - Validation function (returns true if valid)
 * @param {string} invalidMessage - Message to show if invalid
 */
export default function InlineEdit({
  value,
  onSave,
  onCancel,
  isEditing: controlledIsEditing,
  onEditingChange,
  showButtons = false,
  saveOnBlur = true,
  className = '',
  inputClassName = '',
  placeholder = '',
  validate,
  invalidMessage = 'Invalid value',
}) {
  const [internalIsEditing, setInternalIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isInvalid, setIsInvalid] = useState(false);
  const inputRef = useRef(null);

  // Use controlled or internal editing state
  const isEditing = controlledIsEditing !== undefined ? controlledIsEditing : internalIsEditing;
  const setIsEditing = (newState) => {
    if (onEditingChange) {
      onEditingChange(newState);
    } else {
      setInternalIsEditing(newState);
    }
  };

  // Update edit value when value prop changes
  useEffect(() => {
    // Intentional prop-to-state sync when the modal (re)opens; a keyed
    // remount would be the deeper fix, but this matches every other modal.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditValue(value);
  }, [value]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    const trimmedValue = editValue.trim();

    // Validate if validation function provided
    if (validate && !validate(trimmedValue)) {
      setIsInvalid(true);
      return;
    }

    // Only save if value changed
    if (trimmedValue !== value && trimmedValue !== '') {
      onSave(trimmedValue);
    }

    setIsEditing(false);
    setIsInvalid(false);
  };

  const handleCancel = () => {
    setEditValue(value);
    setIsEditing(false);
    setIsInvalid(false);

    if (onCancel) {
      onCancel();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  const handleBlur = (e) => {
    // Don't save on blur if clicking save/cancel buttons
    if (showButtons && e.relatedTarget?.closest('.inline-edit-buttons')) {
      return;
    }

    if (saveOnBlur) {
      handleSave();
    } else {
      handleCancel();
    }
  };

  if (!isEditing) {
    return (
      <div
        onClick={() => setIsEditing(true)}
        className={`cursor-text hover:bg-os-card-secondary px-2 py-1 rounded-sm ${className}`}
        title="Click to edit"
      >
        {value || <span className="text-os-text-muted italic">{placeholder || 'Click to edit'}</span>}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="flex-1">
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => {
            setEditValue(e.target.value);
            setIsInvalid(false);
          }}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={placeholder}
          className={`w-full px-2 py-1 border ${isInvalid ?'border-red-500':'border-os-input-border'} rounded-sm outline-hidden focus:ring-2 focus:ring-os-blue bg-os-input-bg text-os-text-primary ${inputClassName}`}
        />
        {isInvalid && (
          <p className="text-xs text-red-600 mt-1">{invalidMessage}</p>
        )}
      </div>

      {showButtons && (
        <div className="inline-edit-buttons flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleSave}
            className="p-1 hover:bg-green-100 rounded-sm text-green-600 transition-colors"
            title="Save (Enter)"
          >
            <Check size={16} />
          </button>
          <button
            type="button"
            onClick={handleCancel}
            className="p-1 hover:bg-red-100 rounded-sm text-red-600 transition-colors"
            title="Cancel (Esc)"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
