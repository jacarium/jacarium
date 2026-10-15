import { useState, useEffect } from 'react';
import { X, Save, Bug, CheckSquare, ShieldAlert, Lock, FileText, AlertCircle, Zap, Star, Bookmark, Flag, Target, AlertTriangle } from 'lucide-react';
import { availableIcons } from '../templates/jqlTemplates';
import { useNotifications } from '../contexts/NotificationContext';

// Icon mapping for templates
const iconMap = {
  Bug,
  CheckSquare,
  ShieldAlert,
  Lock,
  FileText,
  AlertCircle,
  Zap,
  Star,
  Bookmark,
  Flag,
  Target,
  AlertTriangle,
};

export default function EditTemplateModal({ isOpen, onClose, onSave, template, existingCategories }) {
  const { addNotification } = useNotifications();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [icon, setIcon] = useState('Bookmark');
  const [saving, setSaving] = useState(false);
  const [showNewCategory, setShowNewCategory] = useState(false);

  // Load template data when modal opens
  useEffect(() => {
    if (isOpen && template) {
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(template.name || '');
      setDescription(template.description || '');
      setCategory(template.category || '');
      setIcon(template.icon || 'Bookmark');
      setNewCategory('');
      setShowNewCategory(false);
    }
  }, [isOpen, template]);

  function handleSave() {
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
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

    setSaving(true);

    try {
      onSave({
        name: trimmedName,
        description: trimmedDescription,
        category: finalCategory,
        icon,
      });
      onClose();
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Update Failed',
        message: 'Failed to update template: ' + error.message
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

  if (!isOpen || !template) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 font-text">
      <div className="bg-os-modal shadow-lg max-w-lg w-full border border-os-border rounded-sm max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between sticky top-0 z-10">
          <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">Edit Template</h2>
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
              placeholder="e.g., Critical Bugs"
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
              placeholder="Brief description of what this template does"
              className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden resize-none text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
              rows="3"
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
                  className="flex items-center gap-2 px-3 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors"
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

          {/* Icon Selection */}
          <div>
            <label className="block text-xs font-text text-os-text-primary mb-2 uppercase tracking-wide">
              Icon
            </label>
            <div className="grid grid-cols-6 gap-2">
              {availableIcons.map(iconName => {
                const IconComponent = iconMap[iconName];
                return (
                  <button
                    key={iconName}
                    onClick={() => setIcon(iconName)}
                    className={`p-3 border transition-all bg-os-modal flex items-center justify-center ${
 icon === iconName
 ?'border-os-blue bg-blue-50 dark:bg-blue-900/20'
 :'border-os-input-border hover:border-os-blue hover:bg-os-card-secondary'
 }`}
                    title={iconName}
                  >
                    {IconComponent && (
                      <IconComponent
                        size={20}
                        className={icon === iconName ?'text-os-blue':'text-os-text-muted'}
                      />
                    )}
                  </button>
                );
              })}
            </div>
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
              disabled={saving || !name.trim() || (!category && !newCategory.trim())}
              className="flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
