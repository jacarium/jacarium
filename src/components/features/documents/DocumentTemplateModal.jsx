import { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';
import { useNotifications } from '../../../contexts/NotificationContext';

export default function DocumentTemplateModal({ isOpen, onClose, onSave, template, existingCategories }) {
  const { addNotification } = useNotifications();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [showNewCategory, setShowNewCategory] = useState(false);

  // Load template data when modal opens
  useEffect(() => {
    if (isOpen) {
      if (template) {
        // Intentional prop-to-state sync when the modal (re)opens; a keyed
        // remount would be the deeper fix, but this matches every other modal.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setName(template.name || '');
        setDescription(template.description || '');
        setContent(template.content || '');
        setCategory(template.category || '');
        setTags(template.tags ? template.tags.join(', ') : '');
      } else {
        // Creating new template
        setName('');
        setDescription('');
        setContent('');
        setCategory('');
        setTags('');
      }
      setNewCategory('');
      setShowNewCategory(false);
    }
  }, [isOpen, template]);

  function handleSave() {
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedContent = content.trim();
    const finalCategory = showNewCategory ? newCategory.trim() : category;

    if (!trimmedName) {
      addNotification({
        type: 'alert',
        title: 'Name Required',
        message: 'Please enter a name for this template.'
      });
      return;
    }

    if (!finalCategory) {
      addNotification({
        type: 'alert',
        title: 'Category Required',
        message: 'Please select or create a category.'
      });
      return;
    }

    if (!trimmedContent) {
      addNotification({
        type: 'alert',
        title: 'Content Required',
        message: 'Please enter template content.'
      });
      return;
    }

    setSaving(true);

    try {
      const tagsArray = tags
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0);

      onSave({
        ...(template ? { id: template.id } : {}),
        name: trimmedName,
        description: trimmedDescription,
        content: trimmedContent,
        category: finalCategory,
        tags: tagsArray,
      });
      onClose();
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Save Failed',
        message: 'Failed to save template: ' + error.message
      });
    } finally {
      setSaving(false);
    }
  }

  function handleKeyPress(e) {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSave();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 font-text">
      <div className="bg-os-modal shadow-lg max-w-2xl w-full border border-os-border rounded-sm max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between sticky top-0 z-10">
          <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
            {template ? 'Edit Template' : 'New Template'}
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
          {/* Template Name */}
          <div>
            <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
              Template Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="e.g., Meeting Notes"
              className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
              autoFocus
            />
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
              placeholder="Brief description of this template"
              className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden resize-none text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
              rows="2"
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
                  className="flex-1 px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary"
                >
                  <option value="">Select category...</option>
                  {existingCategories.map(cat => (
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
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  onKeyDown={handleKeyPress}
                  placeholder="Enter new category name"
                  className="flex-1 px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
                />
                <button
                  onClick={() => {
                    setShowNewCategory(false);
                    setNewCategory('');
                  }}
                  className="px-3 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* Tags */}
          <div>
            <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
              Tags
            </label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="e.g., work, personal (comma-separated)"
              className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
            />
          </div>

          {/* Content */}
          <div>
            <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
              Template Content *
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Enter your template content here... (supports Markdown)"
              className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden resize-none text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted font-mono"
              rows="12"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-between sticky bottom-0">
          <div className="text-xs text-os-text-secondary">
            Press Ctrl+Enter to save
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !name.trim() || (!category && !newCategory.trim()) || !content.trim()}
              className="btn btn-primary flex items-center gap-2 px-4 py-2 text-sm"
            >
              {saving ? 'Saving...' : template ? 'Save Changes' : 'Save Template'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
