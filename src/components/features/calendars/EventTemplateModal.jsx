import { useState, useEffect } from 'react';
import BaseModal from '../../common/modals/BaseModal';
import { Bookmark, X } from 'lucide-react';
import { useNotifications } from '../../../contexts/NotificationContext';
import { db } from '../../../db/database';

/**
 * EventTemplateModal - Create/edit event templates
 *
 * Templates store:
 * - name: Template name
 * - defaultSummary: Pre-filled event name
 * - defaultDescription: Pre-filled description
 * - defaultLocation: Pre-filled location
 * - defaultGuests: Pre-filled guests (comma-separated)
 */
export default function EventTemplateModal({ isOpen, onClose, template = null, onTemplateSaved }) {
  const { addNotification } = useNotifications();
  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    defaultSummary: '',
    defaultDescription: '',
    defaultLocation: '',
    defaultGuests: ''
  });

  useEffect(() => {
    if (isOpen && template) {
      // Edit mode - load template data
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFormData({
        name: template.name || '',
        defaultSummary: template.defaultSummary || '',
        defaultDescription: template.defaultDescription || '',
        defaultLocation: template.defaultLocation || '',
        defaultGuests: template.defaultGuests || ''
      });
    } else if (!isOpen) {
      // Reset form when modal closes
      setFormData({
        name: '',
        defaultSummary: '',
        defaultDescription: '',
        defaultLocation: '',
        defaultGuests: ''
      });
    }
  }, [isOpen, template]);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      addNotification({
        type: 'error',
        title: 'Validation Error',
        message: 'Please enter a template name'
      });
      return;
    }

    try {
      setLoading(true);

      const templateData = {
        name: formData.name.trim(),
        defaultSummary: formData.defaultSummary.trim(),
        defaultDescription: formData.defaultDescription.trim(),
        defaultLocation: formData.defaultLocation.trim(),
        defaultGuests: formData.defaultGuests.trim(),
        updatedAt: Date.now()
      };

      if (template?.id) {
        // Update existing template
        await db.calendarEventTemplates.update(template.id, templateData);
        addNotification({
          type: 'success',
          title: 'Template Updated',
          message: `Template "${templateData.name}" updated successfully.`
        });
      } else {
        // Create new template
        templateData.createdAt = Date.now();
        await db.calendarEventTemplates.add(templateData);
        addNotification({
          type: 'success',
          title: 'Template Created',
          message: `Template "${templateData.name}" created successfully.`
        });
      }

      if (onTemplateSaved) {
        onTemplateSaved();
      }

      onClose();
    } catch (error) {
      console.error('[EventTemplateModal] Error saving template:', error);
      addNotification({
        type: 'error',
        title: 'Save Failed',
        message: error.message || 'Failed to save template.'
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} className="max-w-3xl rounded-lg w-full">
        {/* Header */}
        <div className="px-6 py-4 border-b border-os-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bookmark size={20} className="text-os-blue" />
            <h2 className="text-lg font-semibold text-os-text-primary">
              {template ? 'Edit Template' : 'New Event Template'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-os-text-muted hover:text-os-text-primary transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Template Name */}
          <div>
            <label className="block text-sm text-os-text-primary mb-1">
              Template Name *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="e.g., Team Meeting, Customer Call, etc."
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
              required
              autoFocus
            />
          </div>

          {/* Default Event Name */}
          <div>
            <label className="block text-sm text-os-text-primary mb-1">
              Default Event Name
            </label>
            <input
              type="text"
              value={formData.defaultSummary}
              onChange={(e) => handleChange('defaultSummary', e.target.value)}
              placeholder="e.g., [Team][Meeting type][Topic]"
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
            />
          </div>

          {/* Default Location */}
          <div>
            <label className="block text-sm text-os-text-primary mb-1">
              Default Location
            </label>
            <input
              type="text"
              value={formData.defaultLocation}
              onChange={(e) => handleChange('defaultLocation', e.target.value)}
              placeholder="e.g., Conference Room, Zoom, etc."
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
            />
          </div>

          {/* Default Guests */}
          <div>
            <label className="block text-sm text-os-text-primary mb-1">
              Default Guests
            </label>
            <input
              type="text"
              value={formData.defaultGuests}
              onChange={(e) => handleChange('defaultGuests', e.target.value)}
              placeholder="john@example.com, jane@example.com"
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
            />
            <p className="text-xs text-os-text-muted mt-1">
              Comma-separated email addresses
            </p>
          </div>

          {/* Default Description */}
          <div>
            <label className="block text-sm text-os-text-primary mb-1">
              Default Description
            </label>
            <textarea
              value={formData.defaultDescription}
              onChange={(e) => handleChange('defaultDescription', e.target.value)}
              rows={3}
              placeholder="Additional details..."
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary resize-none"
            />
          </div>

          {/* Buttons */}
          <div className="flex justify-end gap-2 pt-4 border-t border-os-border">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-os-text-primary hover:bg-os-card-secondary rounded-sm"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary px-4 py-2 text-sm"
            >
              {loading ? 'Saving...' : (template ? 'Update Template' : 'Create Template')}
            </button>
          </div>
        </form>
    </BaseModal>
  );
}
