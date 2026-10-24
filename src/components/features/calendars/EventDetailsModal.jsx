import { useState, useEffect } from 'react';
import BaseModal from '../../common/modals/BaseModal';
import { Calendar, Clock, MapPin, Users, X } from 'lucide-react';
import { getEvent } from '../../../utils/calendarEvents';
import { formatEventTime, parseRecurrence } from '../../../utils/calendarEvents';

/**
 * EventDetailsModal - Display event details with edit/delete actions
 *
 * Props:
 * - isOpen: boolean
 * - onClose: function
 * - eventId: string (Google event ID)
 * - calendarId: string (Google calendar ID)
 * - onEdit: function(eventId, calendarId) - called when Edit is clicked
 * - onDelete: function(eventId, calendarId) - called when Delete is clicked
 */
export default function EventDetailsModal({ isOpen, onClose, eventId, calendarId, onEdit, onDelete }) {
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadEvent() {
      if (!eventId || !calendarId) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const eventData = await getEvent(eventId, calendarId);
        setEvent(eventData);
      } catch (error) {
        console.error('[EventDetailsModal] Error loading event:', error);
      } finally {
        setLoading(false);
      }
    }

    if (isOpen) {
      loadEvent();
    }
  }, [isOpen, eventId, calendarId]);

  if (!isOpen) return null;

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} className="max-w-2xl max-h-[90vh] flex flex-col">
      <div className="bg-os-modal rounded-lg shadow-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-os-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Calendar size={20} className="text-os-blue" />
            <h2 className="text-lg font-semibold text-os-text-primary">
              Event Details
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-os-text-muted hover:text-os-text-primary transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-os-blue"></div>
            </div>
          ) : !event ? (
            <div className="text-center py-8">
              <p className="text-sm text-os-text-muted">Event not found</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Event Title */}
              <div>
                <h3 className="text-xl font-semibold text-os-text-primary mb-2">
                  {event.summary || '(No title)'}
                </h3>
              </div>

              {/* Time */}
              <div className="flex items-start gap-3">
                <Clock size={16} className="text-os-text-muted mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-os-text-primary">
                    {formatEventTime(event)}
                  </p>
                  {event.recurrence && (
                    <p className="text-xs text-os-text-muted mt-1">
                      {parseRecurrence(event.recurrence)}
                    </p>
                  )}
                </div>
              </div>

              {/* Location */}
              {event.location && (
                <div className="flex items-start gap-3">
                  <MapPin size={16} className="text-os-text-muted mt-0.5 shrink-0" />
                  <p className="text-sm text-os-text-primary">{event.location}</p>
                </div>
              )}

              {/* Attendees */}
              {event.attendees && event.attendees.length > 0 && (
                <div className="flex items-start gap-3">
                  <Users size={16} className="text-os-text-muted mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-os-text-primary mb-1">
                      Guests ({event.attendees.length})
                    </p>
                    <div className="space-y-1 max-h-48 overflow-y-auto pr-2">
                      {event.attendees.map((attendee, index) => {
                        const getStatusEmoji = (status) => {
                          switch (status) {
                            case 'accepted':
                              return '✅';
                            case 'declined':
                              return '❌';
                            case 'tentative':
                              return '❓';
                            default:
                              return '';
                          }
                        };

                        const statusEmoji = getStatusEmoji(attendee.responseStatus);

                        return (
                          <div key={index} className="text-xs text-os-text-secondary flex items-center gap-1">
                            <span>{attendee.email}</span>
                            {statusEmoji && (
                              <span className="text-xs">{statusEmoji}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Description */}
              {event.description && (
                <div className="pt-2 border-t border-os-border">
                  <p className="text-sm font-medium text-os-text-primary mb-2">Description</p>
                  <p className="text-sm text-os-text-secondary whitespace-pre-wrap">
                    {event.description}
                  </p>
                </div>
              )}

              {/* Organizer */}
              {event.organizer && (
                <div className="pt-2 border-t border-os-border">
                  <p className="text-xs text-os-text-muted">
                    Organizer: {event.organizer.email}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        {!loading && event && (
          <div className="px-6 py-4 border-t border-os-border flex items-center justify-between shrink-0">
            <button
              onClick={() => onDelete && onDelete(eventId, calendarId)}
              className="btn btn-danger-ghost px-4 py-2 text-sm flex items-center gap-2"
            >
              Delete Event
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-os-text-primary hover:bg-os-card-secondary rounded-sm transition-colors"
              >
                Close
              </button>
              <button
                onClick={() => onEdit && onEdit(eventId, calendarId)}
                className="btn btn-primary px-4 py-2 text-sm flex items-center gap-2"
              >
                Edit Event
              </button>
            </div>
          </div>
        )}
      </div>
    </BaseModal>
  );
}
