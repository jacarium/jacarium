import { useState } from 'react';

/**
 * "Move to Category" for the workflows selected in the list: pick one of the
 * existing categories or type a new one. The choice is handed to onConfirm
 * as the category name ('' when nothing was picked - the caller reports
 * that); the modal keeps no state across openings because it unmounts.
 */
export default function BulkMoveCategoryModal({ categories, onClose, onConfirm }) {
  const [category, setCategory] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [showNewCategory, setShowNewCategory] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-os-card rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-os-text-primary mb-4">Move to Category</h3>
          <div className="mb-4">
            <label className="block text-sm text-os-text-secondary mb-2">
              Select Category
            </label>
            {!showNewCategory ? (
              <>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue text-sm"
                >
                  <option value="">Select category...</option>
                  {categories.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                <button
                  onClick={() => setShowNewCategory(true)}
                  className="mt-2 text-sm text-os-blue hover:underline"
                >
                  + Create new category
                </button>
              </>
            ) : (
              <>
                <input
                  type="text"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="Enter new category name"
                  className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue text-sm"
                  autoFocus
                />
                <button
                  onClick={() => {
                    setShowNewCategory(false);
                    setNewCategory('');
                  }}
                  className="mt-2 text-sm text-os-text-secondary hover:underline"
                >
                  ← Back to existing categories
                </button>
              </>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-os-text-primary bg-os-card border border-os-input-border rounded-sm hover:bg-os-card-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm(showNewCategory ? newCategory.trim() : category)}
              className="btn btn-primary px-4 py-2 text-sm"
            >
              Move
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
