import { useState, useEffect } from 'react';
import BaseModal from '../../common/modals/BaseModal';
import { X, Save } from 'lucide-react';
import { useNotifications } from '../../../contexts/NotificationContext';

/**
 * EngineTemplateModal - Modal for creating/editing engine templates
 *
 * Features:
 * - Create or edit engine template (search query URL)
 * - Name, URL template, description, and category
 * - New category creation
 * - Keyboard shortcuts (Ctrl+Enter to save, Escape to cancel)
 *
 * @param {boolean} isOpen - Whether modal is visible
 * @param {object} template - Template to edit (null for new)
 * @param {array} categories - Available categories
 * @param {function} onSave - Callback when saving (receives template object)
 * @param {function} onCancel - Callback when canceling
 */
export default function EngineTemplateModal({
  isOpen,
  template,
  categories = [],
  onSave,
  onCancel,
}) {
  const { addNotification } = useNotifications();
  const [name, setName] = useState('');
  const [urlTemplate, setUrlTemplate] = useState('');
  const [category, setCategory] = useState('General');
  const [description, setDescription] = useState('');
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  // Reset form when modal opens or template changes
  useEffect(() => {
    if (isOpen) {
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(template?.name || '');
      setUrlTemplate(template?.urlTemplate || '');
      setCategory(template?.category || 'General');
      setDescription(template?.description || '');
      setShowNewCategory(false);
      setNewCategoryName('');
    }
  }, [isOpen, template]);

  function handleSave() {
    if (!name.trim() || !urlTemplate.trim()) {
      addNotification({
        type: 'alert',
        title: 'Required Fields',
        message: 'Name and URL template are required.'
      });
      return;
    }

    const finalCategory = showNewCategory ? newCategoryName.trim() : category;

    if (!finalCategory) {
      addNotification({
        type: 'alert',
        title: 'Category Required',
        message: 'Please select or create a category.'
      });
      return;
    }

    onSave({
      name: name.trim(),
      urlTemplate: urlTemplate.trim(),
      category: finalCategory,
      description: description.trim()
    });
  }

  function handleKeyPress(e) {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSave();
    }
  }

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onCancel}
      className="max-w-lg w-full max-h-[90vh] overflow-y-auto"
    >
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between sticky top-0 z-10">
        <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
          {template ? 'Edit Search Query' : 'New Search Query'}
        </h2>
        <button
          onClick={onCancel}
          className="p-1 hover:bg-os-sidebar-hover transition-colors"
        >
          <X size={20} className="text-os-text-secondary" />
        </button>
      </div>

      {/* Body */}
      <div className="p-6 space-y-4 bg-os-modal">
        {/* Name */}
        <div>
          <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
            Name *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="e.g., Google Search"
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
            autoFocus
          />
        </div>

        {/* URL Template */}
        <div>
          <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
            URL Template *
          </label>
          <input
            type="text"
            value={urlTemplate}
            onChange={(e) => setUrlTemplate(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="e.g., https://www.google.com/search?q={error}"
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted font-mono"
          />
          <p className="text-xs text-os-text-muted mt-2">
            Use <code className="bg-os-card-secondary px-1.5 py-0.5 rounded-sm border border-os-input-border">{'{error}'}</code> as placeholder for the error message
          </p>
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="Brief description of what this search does"
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden resize-none text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
            rows={3}
          />
        </div>

        {/* Category Selection */}
        <div>
          <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
            Category *
          </label>
          {!showNewCategory ? (
            <div className="flex gap-2">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="flex-1 px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary"
              >
                <option value="">Select category...</option>
                {categories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              <button
                onClick={() => setShowNewCategory(true)}
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
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder="Enter new category name"
                className="flex-1 px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
              />
              <button
                onClick={() => {
                  setShowNewCategory(false);
                  setNewCategoryName('');
                }}
                className="px-3 py-2 bg-os-modal border border-os-input-border rounded-sm text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-between sticky bottom-0">
        <div className="text-xs text-os-text-secondary">
          Press Ctrl+Enter to save
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-os-modal border border-os-input-border rounded-sm text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || !urlTemplate.trim() || (!category && !newCategoryName.trim())}
            className="btn btn-primary flex items-center gap-2 px-4 py-2 text-sm"
          >
            {template ? 'Save Changes' : 'Create Search'}
          </button>
        </div>
      </div>
    </BaseModal>
  );
}
