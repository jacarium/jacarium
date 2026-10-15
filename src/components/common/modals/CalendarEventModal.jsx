import { useState, useEffect } from 'react';
import BaseModal from './BaseModal';
import { Calendar, Users, MapPin, X } from 'lucide-react';
import { useNotifications } from '../../../contexts/NotificationContext';
import { getBackendUrl, apiFetch } from '../../../utils/backendUrl';
import DatePicker from '../inputs/DatePicker';
import { getEvent } from '../../../utils/calendarEvents';

/**
 * CalendarEventModal - Reusable modal for creating/editing calendar events
 *
 * Used in both Documents page and Calendars page.
 * Handles Google Calendar authentication and event creation/editing.
 *
 * @param {boolean} isOpen - Whether modal is open
 * @param {function} onClose - Callback when modal closes
 * @param {string} mode - 'create' or 'edit'
 * @param {string} eventId - Event ID (for edit mode)
 * @param {object} initialData - Pre-fill form data (for templates or time slot clicks)
 * @param {function} onEventCreated - Callback after successful creation
 * @param {function} onEventUpdated - Callback after successful edit
 */
export default function CalendarEventModal({
  isOpen,
  onClose,
  mode = 'create',
  eventId = null,
  initialData = {},
  onEventCreated = () => {},
  onEventUpdated = () => {},
}) {
  const { addNotification } = useNotifications();

  // State machine: checking | not-configured | not-authenticated | form
  const [state, setState] = useState('checking');

  // Form data
  const [formData, setFormData] = useState({
    calendarId: '',
    summary: '',
    description: '',
    location: '',
    startDate: '',
    startTime: '',
    endDate: '',
    endTime: '',
    timezone: '',
    guests: '',
    recurring: false,
    frequency: 'weekly',
    recurrenceEndDate: '',
  });

  // UI state
  const [loading, setLoading] = useState(false);
  const [calendars, setCalendars] = useState([]);
  const [timezones, setTimezones] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [authenticating, setAuthenticating] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // Only check auth status if we haven't already
      if (state === 'checking') {
        checkAuthStatus();
      }
      detectTimezone();

      // Load event data in edit mode
      if (mode === 'edit' && eventId && initialData?.calendarId) {
        loadEventData(eventId, initialData.calendarId);
      } else if (initialData?.startTime) {
        // Pre-fill from initialData if provided (create mode with time range)
        const start = new Date(initialData.startTime);
        const end = new Date(initialData.endTime || start.getTime() + 3600000); // Default 1 hour

        // Extract non-time fields from initialData
        const { startTime: _st, endTime: _et, ...otherInitialData } = initialData;

        // eslint-disable-next-line react-hooks/set-state-in-effect
        setFormData(prev => ({
          ...prev,
          ...otherInitialData,
          startDate: start.toISOString().split('T')[0],
          startTime: start.toTimeString().slice(0, 5),
          endDate: end.toISOString().split('T')[0],
          endTime: end.toTimeString().slice(0, 5),
        }));
      } else if (initialData?.calendarId) {
        // If only calendarId is provided (no time range)
        setFormData(prev => ({
          ...prev,
          ...initialData,
        }));
      }
    } else {
      // Reset state when modal closes
      setState('checking');
      // Reset form data
      setFormData({
        calendarId: '',
        summary: '',
        description: '',
        location: '',
        startDate: '',
        startTime: '',
        endDate: '',
        endTime: '',
        timezone: '',
        guests: '',
        recurring: false,
        frequency: 'weekly',
        recurrenceEndDate: '',
      });
    }
    // initialData/state are intentionally read as open-time snapshots and
    // checkAuthStatus/loadEventData are stable per open; re-running on their
    // identities would clobber in-progress form edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, eventId]);

  // Auto-detect timezone
  function detectTimezone() {
    try {
      const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setFormData(prev => ({ ...prev, timezone: detectedTz }));
    } catch {
      setFormData(prev => ({ ...prev, timezone: 'UTC' }));
    }
  }

  async function checkAuthStatus() {
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/calendar/auth-status`);
      const data = await response.json();

      if (!data.configured) {
        setState('not-configured');
      } else if (!data.authenticated) {
        setState('not-authenticated');
      } else {
        setState('form');
        loadCalendars();
        loadTimezones();
        loadTemplates();
      }
    } catch (error) {
      console.error('Error checking auth status:', error);
      addNotification({
        type: 'error',
        title: 'Auth Check Failed',
        message: 'Failed to check authentication status'
      });
      setState('not-configured');
    }
  }

  async function loadEventData(eventId, calendarId) {
    try {
      setLoading(true);
      const event = await getEvent(eventId, calendarId);

      if (!event) {
        throw new Error('Event not found');
      }

      // Parse event times
      const start = new Date(event.startDateTime);
      const end = new Date(event.endDateTime);

      // Parse guests (attendees)
      const guests = event.attendees
        ? event.attendees.map(a => a.email).join(', ')
        : '';

      // Parse recurrence
      let recurring = false;
      let frequency = 'weekly';
      let recurrenceEndDate = '';

      if (event.recurrence && event.recurrence.length > 0) {
        recurring = true;
        const rrule = event.recurrence[0];
        if (rrule.includes('FREQ=DAILY')) frequency = 'daily';
        else if (rrule.includes('FREQ=WEEKLY')) frequency = 'weekly';
        else if (rrule.includes('FREQ=MONTHLY')) frequency = 'monthly';

        // Extract UNTIL date if present
        const untilMatch = rrule.match(/UNTIL=(\d{8})/);
        if (untilMatch) {
          const untilStr = untilMatch[1];
          const year = untilStr.substring(0, 4);
          const month = untilStr.substring(4, 6);
          const day = untilStr.substring(6, 8);
          recurrenceEndDate = `${year}-${month}-${day}`;
        }
      }

      setFormData({
        calendarId: calendarId,
        summary: event.summary || '',
        description: event.description || '',
        location: event.location || '',
        startDate: start.toISOString().split('T')[0],
        startTime: start.toTimeString().slice(0, 5),
        endDate: end.toISOString().split('T')[0],
        endTime: end.toTimeString().slice(0, 5),
        timezone: event.start?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        guests: guests,
        recurring: recurring,
        frequency: frequency,
        recurrenceEndDate: recurrenceEndDate,
      });
    } catch (error) {
      console.error('[CalendarEventModal] Error loading event:', error);
      addNotification({
        type: 'error',
        title: 'Load Failed',
        message: error.message || 'Failed to load event data.'
      });
    } finally {
      setLoading(false);
    }
  }

  async function loadCalendars() {
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/calendar/calendars`);
      const data = await response.json();

      if (data.calendars) {
        setCalendars(data.calendars);
        // Auto-select primary calendar only if no calendar was provided in initialData
        const primary = data.calendars.find(cal => cal.primary);
        if (primary && !formData.calendarId && !initialData?.calendarId) {
          setFormData(prev => ({ ...prev, calendarId: primary.id }));
        } else if (initialData?.calendarId && !formData.calendarId) {
          // Set calendarId from initialData if not already set
          setFormData(prev => ({ ...prev, calendarId: initialData.calendarId }));
        }
      }
    } catch (error) {
      console.error('Error loading calendars:', error);
      addNotification({
        type: 'error',
        title: 'Load Failed',
        message: 'Failed to load calendars'
      });
    }
  }

  async function loadTimezones() {
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/calendar/timezones`);
      const data = await response.json();

      if (data.timezones) {
        setTimezones(data.timezones);
      }
    } catch (error) {
      console.error('Error loading timezones:', error);
    }
  }

  async function loadTemplates() {
    try {
      const { db } = await import('../../../db/database');
      const allTemplates = await db.calendarEventTemplates.toArray();
      setTemplates(allTemplates);
    } catch (error) {
      console.error('Error loading templates:', error);
    }
  }

  async function handleAuthenticate() {
    setAuthenticating(true);

    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/calendar/authenticate`, {
        method: 'POST',
      });

      const data = await response.json();

      if (data.success) {
        addNotification({
          type: 'success',
          title: 'Authentication Successful',
          message: 'Successfully authenticated with Google Calendar'
        });
        setState('form');
        loadCalendars();
        loadTimezones();
        loadTemplates();
      } else {
        addNotification({
          type: 'error',
          title: 'Authentication Failed',
          message: data.message || 'Authentication failed'
        });
      }
    } catch (error) {
      console.error('Error authenticating:', error);
      addNotification({
        type: 'error',
        title: 'Authentication Failed',
        message: 'Authentication failed'
      });
    } finally {
      setAuthenticating(false);
    }
  }

  function handleChange(field, value) {
    setFormData(prev => ({ ...prev, [field]: value }));
  }

  function handleTemplateSelect(templateId) {
    if (!templateId) return;

    const template = templates.find(t => t.id === parseInt(templateId));
    if (!template) return;

    setFormData(prev => ({
      ...prev,
      summary: template.defaultSummary || '',
      description: template.defaultDescription || '',
      location: template.defaultLocation || '',
      guests: template.defaultGuests || ''
    }));
  }

  function validateForm() {
    if (!formData.calendarId) {
      addNotification({
        type: 'error',
        title: 'Validation Error',
        message: 'Please select a calendar'
      });
      return false;
    }

    if (!formData.summary.trim()) {
      addNotification({
        type: 'error',
        title: 'Validation Error',
        message: 'Please enter an event name'
      });
      return false;
    }

    if (!formData.startDate || !formData.startTime) {
      addNotification({
        type: 'error',
        title: 'Validation Error',
        message: 'Please enter start date and time'
      });
      return false;
    }

    if (!formData.endDate || !formData.endTime) {
      addNotification({
        type: 'error',
        title: 'Validation Error',
        message: 'Please enter end date and time'
      });
      return false;
    }

    // Validate start before end
    const startDateTime = new Date(`${formData.startDate}T${formData.startTime}`);
    const endDateTime = new Date(`${formData.endDate}T${formData.endTime}`);

    if (startDateTime >= endDateTime) {
      addNotification({
        type: 'error',
        title: 'Validation Error',
        message: 'End time must be after start time'
      });
      return false;
    }

    // Validate recurring event
    if (formData.recurring && formData.recurrenceEndDate) {
      const recurrenceEnd = new Date(formData.recurrenceEndDate);
      if (recurrenceEnd <= startDateTime) {
        addNotification({
          type: 'error',
          title: 'Validation Error',
          message: 'Recurrence end date must be after start date'
        });
        return false;
      }
    }

    // Validate guest emails
    if (formData.guests) {
      const emails = formData.guests.split(',').map(e => e.trim()).filter(e => e);
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      for (const email of emails) {
        if (!emailRegex.test(email)) {
          addNotification({
            type: 'error',
            title: 'Validation Error',
            message: `Invalid email address: ${email}`
          });
          return false;
        }
      }
    }

    return true;
  }

  async function handleSubmit(e) {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    setLoading(true);

    try {
      const backendUrl = await getBackendUrl();

      // Prepare event data
      const startDateTime = new Date(`${formData.startDate}T${formData.startTime}`);
      const endDateTime = new Date(`${formData.endDate}T${formData.endTime}`);

      const eventData = {
        calendarId: formData.calendarId,
        summary: formData.summary,
        description: formData.description,
        location: formData.location,
        startTime: startDateTime.toISOString(),
        endTime: endDateTime.toISOString(),
        timezone: formData.timezone || 'UTC',
        guests: formData.guests ? formData.guests.split(',').map(e => e.trim()).filter(e => e) : [],
        recurring: formData.recurring,
        frequency: formData.frequency,
        recurrenceEndDate: formData.recurrenceEndDate,
      };

      const url = mode === 'edit' && eventId
        ? `${backendUrl}/api/calendar/events/${eventId}?calendarId=${formData.calendarId}`
        : `${backendUrl}/api/calendar/events`;

      const response = await apiFetch(url, {
        method: mode === 'edit' ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventData),
      });

      const data = await response.json();

      if (data.success || response.ok) {
        addNotification({
          type: 'success',
          title: mode === 'edit' ? 'Event Updated' : 'Event Created',
          message: mode === 'edit' ? 'Event updated successfully!' : 'Event created successfully!'
        });

        if (mode === 'create') {
          onEventCreated(data);
        } else {
          onEventUpdated(data);
        }

        onClose();
      } else {
        addNotification({
          type: 'error',
          title: 'Save Failed',
          message: data.error || 'Failed to save event'
        });
      }
    } catch (error) {
      console.error('Error saving event:', error);
      addNotification({
        type: 'error',
        title: 'Save Failed',
        message: 'Failed to save event'
      });
    } finally {
      setLoading(false);
    }
  }

  function renderContent() {
    if (state === 'checking') {
      return (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-os-blue mx-auto mb-3"></div>
            <p className="text-sm text-os-text-secondary">Checking authentication...</p>
          </div>
        </div>
      );
    }

    if (state === 'not-configured') {
      return (
        <div className="py-8 text-center">
          <Calendar size={48} className="text-os-text-muted mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-os-text-primary mb-2">
            Google Calendar Not Configured
          </h3>
          <p className="text-sm text-os-text-secondary mb-4">
            Please configure your Google Calendar OAuth credentials in Settings.
          </p>
          <button
            onClick={() => {
              onClose();
              // Open settings modal - this would need to be passed as a prop or handled differently
            }}
            className="px-4 py-2 bg-os-blue text-white rounded-sm hover:bg-os-blue-hover text-sm"
          >
            Go to Settings
          </button>
        </div>
      );
    }

    if (state === 'not-authenticated') {
      return (
        <div className="py-8 text-center">
          <Calendar size={48} className="text-os-text-muted mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-os-text-primary mb-2">
            Sign in to Google Calendar
          </h3>
          <p className="text-sm text-os-text-secondary mb-4">
            Authenticate with your Google account to create calendar events.
          </p>
          <button
            onClick={handleAuthenticate}
            disabled={authenticating}
            className="px-4 py-2 bg-os-blue text-white rounded-sm hover:bg-os-blue-hover text-sm disabled:opacity-50"
          >
            {authenticating ? 'Authenticating...' : 'Sign in with Google'}
          </button>
        </div>
      );
    }

    return (
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Calendar Selection */}
        <div>
          <label className="block text-xs text-os-text-primary mb-1">
            Calendar *
          </label>
          <select
            value={formData.calendarId}
            onChange={(e) => handleChange('calendarId', e.target.value)}
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
            required
          >
            <option value="" className="bg-os-input-bg text-os-text-primary">Select a calendar</option>
            {calendars.map(cal => (
              <option key={cal.id} value={cal.id} className="bg-os-input-bg text-os-text-primary">
                {cal.summary} {cal.primary ? '(Primary)' : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Template Selection */}
        {mode === 'create' && templates.length > 0 && (
          <div>
            <label className="block text-xs text-os-text-primary mb-1">
              Use Template (Optional)
            </label>
            <select
              onChange={(e) => handleTemplateSelect(e.target.value)}
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
            >
              <option value="" className="bg-os-input-bg text-os-text-primary">None - Start from scratch</option>
              {templates.map(template => (
                <option key={template.id} value={template.id} className="bg-os-input-bg text-os-text-primary">
                  {template.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Event Name */}
        <div>
          <label className="block text-xs text-os-text-primary mb-1">
            Event Name *
          </label>
          <input
            type="text"
            value={formData.summary}
            onChange={(e) => handleChange('summary', e.target.value)}
            placeholder="Meeting with customer"
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
            required
          />
        </div>

        {/* Timezone */}
        <div>
          <label className="block text-xs text-os-text-primary mb-1">
            Timezone
          </label>
          <select
            value={formData.timezone}
            onChange={(e) => handleChange('timezone', e.target.value)}
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
          >
            {timezones.map(tz => (
              <option key={tz.id} value={tz.id} className="bg-os-input-bg text-os-text-primary">
                {tz.name}
              </option>
            ))}
          </select>
        </div>

        {/* Start Date & Time */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-os-text-primary mb-1">
              Start Date *
            </label>
            <DatePicker
              value={formData.startDate}
              onChange={(date) => handleChange('startDate', date)}
              placeholder="Select start date"
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary hover:bg-os-card-secondary transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-os-text-primary mb-1">
              Start Time *
            </label>
            <input
              type="time"
              value={formData.startTime}
              onChange={(e) => handleChange('startTime', e.target.value)}
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary scheme-light dark:scheme-dark"
              required
            />
          </div>
        </div>

        {/* End Date & Time */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-os-text-primary mb-1">
              End Date *
            </label>
            <DatePicker
              value={formData.endDate}
              onChange={(date) => handleChange('endDate', date)}
              placeholder="Select end date"
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary hover:bg-os-card-secondary transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-os-text-primary mb-1">
              End Time *
            </label>
            <input
              type="time"
              value={formData.endTime}
              onChange={(e) => handleChange('endTime', e.target.value)}
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary scheme-light dark:scheme-dark"
              required
            />
          </div>
        </div>

        {/* Recurring Event */}
        <div className="border border-os-border rounded-lg p-3 bg-os-card-secondary">
          <div className="flex items-center gap-2 mb-3">
            <input
              type="checkbox"
              id="recurring"
              checked={formData.recurring}
              onChange={(e) => handleChange('recurring', e.target.checked)}
              className="rounded-sm"
            />
            <label htmlFor="recurring" className="text-sm text-os-text-primary cursor-pointer">
              Recurring Event
            </label>
          </div>

          {formData.recurring && (
            <div className="space-y-3 pl-6">
              <div>
                <label className="block text-xs text-os-text-primary mb-1">
                  Frequency
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm text-os-text-primary cursor-pointer">
                    <input
                      type="radio"
                      name="frequency"
                      value="daily"
                      checked={formData.frequency === 'daily'}
                      onChange={(e) => handleChange('frequency', e.target.value)}
                    />
                    Daily
                  </label>
                  <label className="flex items-center gap-2 text-sm text-os-text-primary cursor-pointer">
                    <input
                      type="radio"
                      name="frequency"
                      value="weekly"
                      checked={formData.frequency === 'weekly'}
                      onChange={(e) => handleChange('frequency', e.target.value)}
                    />
                    Weekly
                  </label>
                  <label className="flex items-center gap-2 text-sm text-os-text-primary cursor-pointer">
                    <input
                      type="radio"
                      name="frequency"
                      value="monthly"
                      checked={formData.frequency === 'monthly'}
                      onChange={(e) => handleChange('frequency', e.target.value)}
                    />
                    Monthly
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs text-os-text-primary mb-1">
                  Recurrence End Date
                </label>
                <DatePicker
                  value={formData.recurrenceEndDate}
                  onChange={(date) => handleChange('recurrenceEndDate', date)}
                  placeholder="Select end date"
                  className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary hover:bg-os-card-secondary transition-colors"
                />
              </div>
            </div>
          )}
        </div>

        {/* Guests */}
        <div>
          <label className="block text-xs text-os-text-primary mb-1">
            <Users size={14} className="inline mr-1" />
            Guests (comma-separated emails)
          </label>
          <input
            type="text"
            value={formData.guests}
            onChange={(e) => handleChange('guests', e.target.value)}
            placeholder="john@example.com, jane@example.com"
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
          />
        </div>

        {/* Location */}
        <div>
          <label className="block text-xs text-os-text-primary mb-1">
            <MapPin size={14} className="inline mr-1" />
            Location
          </label>
          <input
            type="text"
            value={formData.location}
            onChange={(e) => handleChange('location', e.target.value)}
            placeholder="Conference Room A"
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs text-os-text-primary mb-1">
            Description
          </label>
          <textarea
            value={formData.description}
            onChange={(e) => handleChange('description', e.target.value)}
            rows={3}
            placeholder="Additional details..."
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary resize-none"
          />
        </div>

        {/* Submit Buttons */}
        <div className="flex justify-end gap-2 pt-4 border-t border-os-border">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-os-text-primary hover:bg-os-card-secondary rounded-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 bg-os-blue text-white rounded-sm hover:bg-os-blue-hover text-sm disabled:opacity-50"
          >
            {loading ? 'Saving...' : (mode === 'edit' ? 'Update Event' : 'Create Event')}
          </button>
        </div>
      </form>
    );
  }

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onClose}
      className="max-w-2xl w-full"
    >
      <div className="bg-os-modal rounded-lg shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-os-border">
          <div className="flex items-center gap-2">
            <Calendar size={20} className="text-os-blue" />
            <h2 className="text-lg font-semibold text-os-text-primary">
              {mode === 'edit' ? 'Edit Calendar Event' : 'New Calendar Event'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-os-text-secondary hover:text-os-text-primary"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 max-h-[calc(100vh-200px)] overflow-y-auto">
          {renderContent()}
        </div>
      </div>
    </BaseModal>
  );
}
