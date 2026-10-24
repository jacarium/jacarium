import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useNotifications } from '../../contexts/NotificationContext';

export default function CustomReportModal({ isOpen, onClose, onSubmit, editingReport }) {
  const { addNotification } = useNotifications();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('General');
  const [description, setDescription] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (editingReport) {
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(editingReport.name || '');
      setCategory(editingReport.category || 'General');
      setDescription(editingReport.description || '');
      setFilter(editingReport.filter || '');
    } else {
      setName('');
      setCategory('General');
      setDescription('');
      setFilter('');
    }
  }, [editingReport, isOpen]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!name.trim()) {
      addNotification({
        type: 'alert',
        title: 'Name Required',
        message: 'Please enter a report name'
      });
      return;
    }

    try {
      await onSubmit(
        {
          name: name.trim(),
          category: category.trim() || 'General',
          description: description.trim(),
          filter: filter.trim(),
        },
        editingReport
      );

      // Close modal
      onClose();
    } catch (error) {
      console.error('Error saving report:', error);
      addNotification({
        type: 'error',
        title: 'Save Failed',
        message: `Error: ${error.message}`
      });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-os-card border border-os-border rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-os-border">
          <h2 className="text-lg font-semibold text-os-text-primary">
            {editingReport ? 'Edit Filter' : 'New Filter'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            <X size={20} className="text-os-text-secondary" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6">
          <div className="space-y-4">
            {/* Name */}
            <div>
              <label className="block text-sm text-os-text-primary mb-1">
                Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., High Priority This Week"
                className="w-full px-3 py-2 border border-os-border rounded-sm bg-os-input-bg text-os-text-primary focus:outline-hidden focus:border-os-blue"
                autoFocus
                required
              />
            </div>

            {/* Category */}
            <div>
              <label className="block text-sm text-os-text-primary mb-1">
                Category
              </label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="General"
                className="w-full px-3 py-2 border border-os-border rounded-sm bg-os-input-bg text-os-text-primary focus:outline-hidden focus:border-os-blue"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm text-os-text-primary mb-1">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description"
                className="w-full px-3 py-2 border border-os-border rounded-sm bg-os-input-bg text-os-text-primary focus:outline-hidden focus:border-os-blue"
              />
            </div>

            {/* Filter */}
            <div>
              <label className="block text-sm text-os-text-primary mb-1">
                TaskWarrior Filter
              </label>
              <textarea
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="e.g., status:pending priority:H +WEEK"
                rows={4}
                className="w-full px-3 py-2 border border-os-border rounded-sm bg-os-input-bg text-os-text-primary focus:outline-hidden focus:border-os-blue font-mono text-sm resize-none"
              />
              <p className="text-xs text-os-text-muted mt-1">
                Use TaskWarrior filter syntax. Examples:
              </p>
              <ul className="text-xs text-os-text-muted mt-1 space-y-1 ml-4">
                <li>• <code className="bg-os-card-secondary px-1 rounded-sm">status:pending priority:H</code> - High priority pending tasks</li>
                <li>• <code className="bg-os-card-secondary px-1 rounded-sm">+WEEK</code> - Tasks due this week</li>
                <li>• <code className="bg-os-card-secondary px-1 rounded-sm">project:Work status:pending</code> - Pending work tasks</li>
                <li>• <code className="bg-os-card-secondary px-1 rounded-sm">+home +urgent</code> - Tasks tagged home and urgent</li>
              </ul>
            </div>
          </div>
        </form>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-6 border-t border-os-border">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-os-text-secondary hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            onClick={handleSubmit}
            className="btn btn-primary px-4 py-2 text-sm"
          >
            {editingReport ? 'Save Changes' : 'Create Filter'}
          </button>
        </div>
      </div>
    </div>
  );
}
