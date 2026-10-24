import { useState } from 'react';
import BaseModal from '../../common/modals/BaseModal';
import { Calendar, Info } from 'lucide-react';
import { useNotifications } from '../../../contexts/NotificationContext';
import { getBackendUrl, apiFetch } from '../../../utils/backendUrl';

/**
 * AddCalendarModal - Modal for subscribing to a calendar
 *
 * Allows users to add/subscribe to calendars by entering the calendar ID
 * (usually an email address).
 */
export default function AddCalendarModal({ isOpen, onClose, onCalendarAdded }) {
  const { addNotification } = useNotifications();
  const [calendarId, setCalendarId] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!calendarId.trim()) {
      addNotification({
        type: 'error',
        title: 'Invalid Input',
        message: 'Please enter a calendar ID.'
      });
      return;
    }

    try {
      setLoading(true);
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/calendar/calendars`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ calendarId: calendarId.trim() })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to add calendar');
      }

      addNotification({
        type: 'success',
        title: 'Calendar Added',
        message: `Successfully subscribed to "${data.calendar.summary}".`
      });

      if (onCalendarAdded) {
        onCalendarAdded(data.calendar);
      }

      setCalendarId('');
      onClose();
    } catch (error) {
      console.error('[AddCalendarModal] Error adding calendar:', error);
      addNotification({
        type: 'error',
        title: 'Add Failed',
        message: error.message || 'Failed to add calendar.'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setCalendarId('');
    onClose();
  };

  return (
    <BaseModal isOpen={isOpen} onClose={handleClose} className="max-w-md">
      <div className="bg-os-modal rounded-lg shadow-xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-os-border">
          <div className="flex items-center gap-2">
            <Calendar size={20} className="text-os-blue" />
            <h2 className="text-lg font-semibold text-os-text-primary">
              Subscribe to Calendar
            </h2>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Info Box */}
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 flex items-start gap-2">
            <Info size={14} className="text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <div className="text-xs text-blue-800 dark:text-blue-200">
              <p>
                Enter the calendar ID to subscribe to a shared calendar.
              </p>
            </div>
          </div>

          {/* Calendar ID Input */}
          <div>
            <label className="block text-sm text-os-text-primary mb-1">
              Calendar ID *
            </label>
            <input
              type="text"
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
              placeholder="Calendar ID"
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
              required
              autoFocus
            />
            <p className="text-xs text-os-text-muted mt-1">
              The calendar must be shared with you for this to work.
            </p>
          </div>

          {/* Buttons */}
          <div className="flex justify-end gap-2 pt-4 border-t border-os-border">
            <button
              type="button"
              onClick={handleClose}
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
              {loading ? 'Adding...' : 'Add Calendar'}
            </button>
          </div>
        </form>
      </div>
    </BaseModal>
  );
}
