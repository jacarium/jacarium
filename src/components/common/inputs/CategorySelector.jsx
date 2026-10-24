import { useState } from 'react';
import { X } from 'lucide-react';

/**
 * CategorySelector - Category dropdown with inline new category creation
 *
 * Features:
 * - Dropdown of existing categories
 * - "New" button to create new category inline
 * - Cancel button when creating new category
 * - Consistent styling
 * - Keyboard support
 *
 * @param {array} categories - Array of existing categories
 * @param {string} value - Selected category value
 * @param {function} onChange - Callback when category changes (receives category name)
 * @param {boolean} required - Show required indicator (default: false)
 * @param {string} placeholder - Placeholder text (default: "Select category...")
 * @param {string} newPlaceholder - Placeholder for new category input (default: "Enter new category name")
 * @param {string} label - Label text (optional)
 * @param {boolean} uppercase - Use uppercase label styling (default: false)
 */
export default function CategorySelector({
  categories = [],
  value,
  onChange,
  required = false,
  placeholder = 'Select category...',
  newPlaceholder = 'Enter new category name',
  label,
  uppercase = false,
}) {
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  const handleCancelNew = () => {
    setIsCreatingNew(false);
    setNewCategoryName('');
  };

  const handleNewCategoryChange = (e) => {
    const name = e.target.value;
    setNewCategoryName(name);
    onChange(name);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      handleCancelNew();
    }
  };

  const labelClasses = uppercase
    ? 'block text-xs font-text font-semibold text-os-text-primary mb-2 uppercase tracking-wide'
    : 'block text-sm font-medium text-os-text-primary mb-2';

  return (
    <div>
      {label && (
        <label className={labelClasses}>
          {label} {required && <span className="text-red-600">*</span>}
        </label>
      )}

      {!isCreatingNew ? (
        <div className="flex gap-2">
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-card text-os-text-primary"
            required={required}
          >
            <option value="">{placeholder}</option>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setIsCreatingNew(true);
              setNewCategoryName('');
              onChange('');
            }}
            className="btn btn-primary flex items-center gap-2 px-3 py-2 text-sm"
            title="Create new category"
          >
            New
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            type="text"
            value={newCategoryName}
            onChange={handleNewCategoryChange}
            onKeyDown={handleKeyDown}
            placeholder={newPlaceholder}
            className="flex-1 px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-card text-os-text-primary placeholder:text-os-text-muted"
            autoFocus
            required={required}
          />
          <button
            type="button"
            onClick={handleCancelNew}
            className="flex items-center gap-2 px-3 py-2 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
            title="Cancel new category"
          >
            <X size={16} />
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
