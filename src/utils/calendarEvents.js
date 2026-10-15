import { db } from '../db/database';
import { getBackendUrl, apiFetch } from './backendUrl';

/**
 * Calendar Events Utilities
 *
 * Provides functions for managing calendar events:
 * - CRUD operations (create, read, update, delete)
 * - Caching events in IndexedDB
 * - Search and filtering
 * - Event formatting and parsing
 */

/**
 * Parse event start/end times to extract timestamp and check if all-day
 * @param {Object} event - Google Calendar event object
 * @returns {Object} Parsed times with startDateTime, endDateTime, isAllDay
 */
function parseEventTimes(event) {
  const isAllDay = !!(event.start?.date && event.end?.date);

  let startDateTime = null;
  let endDateTime = null;

  if (isAllDay) {
    // All-day event: use date field
    // Parse date in LOCAL timezone, not UTC
    // "2026-06-01" should be June 1st 00:00 LOCAL, not UTC
    const [startYear, startMonth, startDay] = event.start.date.split('-').map(Number);
    const [endYear, endMonth, endDay] = event.end.date.split('-').map(Number);

    startDateTime = new Date(startYear, startMonth - 1, startDay, 0, 0, 0, 0).getTime();
    endDateTime = new Date(endYear, endMonth - 1, endDay, 0, 0, 0, 0).getTime();
  } else {
    // Timed event: use dateTime field
    startDateTime = event.start?.dateTime ? new Date(event.start.dateTime).getTime() : null;
    endDateTime = event.end?.dateTime ? new Date(event.end.dateTime).getTime() : null;
  }

  return {
    startDateTime,
    endDateTime,
    isAllDay
  };
}

/**
 * Cache events in IndexedDB
 * @param {string} calendarId - Google calendar ID
 * @param {Array} events - Array of Google Calendar event objects
 * @param {string|null} timeMin - ISO timestamp for start of synced range (optional)
 * @param {string|null} timeMax - ISO timestamp for end of synced range (optional)
 * @returns {Promise<void>}
 */
export async function cacheEvents(calendarId, events, timeMin = null, timeMax = null) {
  try {
    const now = Date.now();

    // Remove old cached events for this calendar ONLY in the synced time range
    if (timeMin && timeMax) {
      // Delete only events that fall within the synced range
      const timeMinMs = new Date(timeMin).getTime();
      const timeMaxMs = new Date(timeMax).getTime();

      await db.calendarEvents
        .where('calendarId')
        .equals(calendarId)
        .filter(event => {
          // Delete if event overlaps with the synced range
          const eventStart = event.startDateTime;
          const eventEnd = event.endDateTime;
          return eventEnd >= timeMinMs && eventStart <= timeMaxMs;
        })
        .delete();

      console.log('[calendarEvents] Deleted events in range:', timeMin, 'to', timeMax);
    } else {
      // No time range specified - delete all events for this calendar (legacy behavior)
      await db.calendarEvents.where('calendarId').equals(calendarId).delete();
      console.log('[calendarEvents] Deleted all events for calendar');
    }

    // Insert new events
    const eventData = events.map(event => {
      const { startDateTime, endDateTime, isAllDay } = parseEventTimes(event);

      return {
        id: `${calendarId}_${event.id}`, // Composite key
        calendarId,
        eventId: event.id,
        summary: event.summary || '(No title)',
        description: event.description || '',
        start: event.start,
        end: event.end,
        location: event.location || '',
        attendees: event.attendees || [],
        recurrence: event.recurrence || null,
        creator: event.creator || null,
        organizer: event.organizer || null,
        status: event.status || 'confirmed',
        htmlLink: event.htmlLink || '',
        lastFetched: now,
        startDateTime,
        endDateTime,
        isAllDay
      };
    });

    if (eventData.length > 0) {
      await db.calendarEvents.bulkPut(eventData);
    }

    console.log('[calendarEvents] Cached events for calendar:', calendarId, 'Count:', eventData.length);
  } catch (error) {
    console.error('[calendarEvents] Error caching events:', error);
    throw error;
  }
}

/**
 * Get events from IndexedDB cache
 * @param {string} calendarId - Google calendar ID
 * @param {string|null} timeMin - ISO timestamp for start of range (optional)
 * @param {string|null} timeMax - ISO timestamp for end of range (optional)
 * @returns {Promise<Array>} Array of cached events
 */
export async function getEvents(calendarId, timeMin = null, timeMax = null) {
  try {
    let query = db.calendarEvents.where('calendarId').equals(calendarId);

    let events = await query.toArray();

    // Filter by time range if specified
    if (timeMin || timeMax) {
      const minTime = timeMin ? new Date(timeMin).getTime() : null;
      const maxTime = timeMax ? new Date(timeMax).getTime() : null;

      events = events.filter(event => {
        if (minTime && event.endDateTime < minTime) return false;
        if (maxTime && event.startDateTime > maxTime) return false;
        return true;
      });
    }

    // Sort by start time
    events.sort((a, b) => a.startDateTime - b.startDateTime);

    return events;
  } catch (error) {
    console.error('[calendarEvents] Error getting events:', error);
    return [];
  }
}

/**
 * Get a single event from IndexedDB cache
 * @param {string} eventId - Google event ID
 * @param {string} calendarId - Google calendar ID
 * @returns {Promise<Object|null>} Event object or null
 */
export async function getEvent(eventId, calendarId) {
  try {
    const compositeKey = `${calendarId}_${eventId}`;
    const event = await db.calendarEvents.get(compositeKey);
    return event || null;
  } catch (error) {
    console.error('[calendarEvents] Error getting event:', error);
    return null;
  }
}

/**
 * Create a new calendar event
 * @param {Object} eventData - Event data object
 * @param {string} eventData.calendarId - Google calendar ID
 * @param {string} eventData.summary - Event title
 * @param {string} eventData.startTime - ISO timestamp for start
 * @param {string} eventData.endTime - ISO timestamp for end
 * @param {string} eventData.timezone - IANA timezone
 * @param {string} eventData.description - Event description (optional)
 * @param {string} eventData.location - Event location (optional)
 * @param {Array} eventData.guests - Array of guest email addresses (optional)
 * @param {boolean} eventData.recurring - Is recurring event (optional)
 * @param {string} eventData.frequency - Recurrence frequency: 'daily'|'weekly'|'monthly' (optional)
 * @param {string} eventData.recurrenceEndDate - ISO date for recurrence end (optional)
 * @returns {Promise<Object>} Created event object
 */
export async function createEvent(eventData) {
  try {
    console.log('[calendarEvents] Creating event:', eventData.summary);

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/calendar/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventData)
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to create event');
    }

    const data = await response.json();
    const createdEvent = data.event;

    // Add to cache
    const { startDateTime, endDateTime, isAllDay } = parseEventTimes(createdEvent);

    const cachedEvent = {
      id: `${eventData.calendarId}_${createdEvent.id}`,
      calendarId: eventData.calendarId,
      eventId: createdEvent.id,
      summary: createdEvent.summary || '(No title)',
      description: createdEvent.description || '',
      start: createdEvent.start,
      end: createdEvent.end,
      location: createdEvent.location || '',
      attendees: createdEvent.attendees || [],
      recurrence: createdEvent.recurrence || null,
      creator: createdEvent.creator || null,
      organizer: createdEvent.organizer || null,
      status: createdEvent.status || 'confirmed',
      htmlLink: createdEvent.htmlLink || '',
      lastFetched: Date.now(),
      startDateTime,
      endDateTime,
      isAllDay
    };

    await db.calendarEvents.put(cachedEvent);

    // Update calendar event count
    const calendar = await db.syncedCalendars.get(eventData.calendarId);
    if (calendar) {
      calendar.eventCount = (calendar.eventCount || 0) + 1;
      await db.syncedCalendars.put(calendar);
    }

    console.log('[calendarEvents] Event created:', createdEvent.id);
    return cachedEvent;
  } catch (error) {
    console.error('[calendarEvents] Error creating event:', error);
    throw error;
  }
}

/**
 * Update an existing calendar event
 * @param {string} eventId - Google event ID
 * @param {string} calendarId - Google calendar ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated event object
 */
export async function updateEvent(eventId, calendarId, updates) {
  try {
    console.log('[calendarEvents] Updating event:', eventId);

    const backendUrl = await getBackendUrl();
    const params = new URLSearchParams({ calendarId });
    const response = await apiFetch(`${backendUrl}/api/calendar/events/${eventId}?${params.toString()}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to update event');
    }

    const data = await response.json();
    const updatedEvent = data.event;

    // Update cache
    const { startDateTime, endDateTime, isAllDay } = parseEventTimes(updatedEvent);

    const cachedEvent = {
      id: `${calendarId}_${updatedEvent.id}`,
      calendarId,
      eventId: updatedEvent.id,
      summary: updatedEvent.summary || '(No title)',
      description: updatedEvent.description || '',
      start: updatedEvent.start,
      end: updatedEvent.end,
      location: updatedEvent.location || '',
      attendees: updatedEvent.attendees || [],
      recurrence: updatedEvent.recurrence || null,
      creator: updatedEvent.creator || null,
      organizer: updatedEvent.organizer || null,
      status: updatedEvent.status || 'confirmed',
      htmlLink: updatedEvent.htmlLink || '',
      lastFetched: Date.now(),
      startDateTime,
      endDateTime,
      isAllDay
    };

    await db.calendarEvents.put(cachedEvent);

    console.log('[calendarEvents] Event updated:', updatedEvent.id);
    return cachedEvent;
  } catch (error) {
    console.error('[calendarEvents] Error updating event:', error);
    throw error;
  }
}

/**
 * Delete a calendar event
 * @param {string} eventId - Google event ID
 * @param {string} calendarId - Google calendar ID
 * @returns {Promise<void>}
 */
export async function deleteEvent(eventId, calendarId) {
  try {
    console.log('[calendarEvents] Deleting event:', eventId);

    const backendUrl = await getBackendUrl();
    const params = new URLSearchParams({ calendarId });
    const response = await apiFetch(`${backendUrl}/api/calendar/events/${eventId}?${params.toString()}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to delete event');
    }

    // Remove from cache
    const compositeKey = `${calendarId}_${eventId}`;
    await db.calendarEvents.delete(compositeKey);

    // Update calendar event count
    const calendar = await db.syncedCalendars.get(calendarId);
    if (calendar && calendar.eventCount > 0) {
      calendar.eventCount = calendar.eventCount - 1;
      await db.syncedCalendars.put(calendar);
    }

    console.log('[calendarEvents] Event deleted:', eventId);
  } catch (error) {
    console.error('[calendarEvents] Error deleting event:', error);
    throw error;
  }
}

/**
 * Reschedule an event (update start and end times)
 * @param {string} eventId - Google event ID
 * @param {string} calendarId - Google calendar ID
 * @param {string} newStartTime - ISO timestamp for new start
 * @param {string} newEndTime - ISO timestamp for new end
 * @param {string} timezone - IANA timezone
 * @returns {Promise<Object>} Updated event object
 */
export async function rescheduleEvent(eventId, calendarId, newStartTime, newEndTime, timezone) {
  try {
    console.log('[calendarEvents] Rescheduling event:', eventId);

    // Get existing event to determine if all-day
    const existingEvent = await getEvent(eventId, calendarId);
    if (!existingEvent) {
      throw new Error('Event not found');
    }

    const updates = {
      startTime: newStartTime,
      endTime: newEndTime,
      timezone
    };

    return await updateEvent(eventId, calendarId, updates);
  } catch (error) {
    console.error('[calendarEvents] Error rescheduling event:', error);
    throw error;
  }
}

/**
 * Search events by query string
 * @param {string} calendarId - Google calendar ID (or null for all calendars)
 * @param {string} query - Search query
 * @returns {Promise<Array>} Filtered events
 */
export async function searchEvents(calendarId, query) {
  try {
    let events;

    if (calendarId) {
      events = await db.calendarEvents.where('calendarId').equals(calendarId).toArray();
    } else {
      events = await db.calendarEvents.toArray();
    }

    if (!query || query.trim() === '') {
      return events;
    }

    const lowerQuery = query.toLowerCase();

    const filtered = events.filter(event => {
      // Search in summary, description, location
      if (event.summary?.toLowerCase().includes(lowerQuery)) return true;
      if (event.description?.toLowerCase().includes(lowerQuery)) return true;
      if (event.location?.toLowerCase().includes(lowerQuery)) return true;

      // Search in attendee emails
      if (event.attendees && Array.isArray(event.attendees)) {
        const attendeeMatch = event.attendees.some(attendee =>
          attendee.email?.toLowerCase().includes(lowerQuery)
        );
        if (attendeeMatch) return true;
      }

      return false;
    });

    return filtered;
  } catch (error) {
    console.error('[calendarEvents] Error searching events:', error);
    return [];
  }
}

/**
 * Filter events by criteria
 * @param {Array} events - Events to filter
 * @param {Object} filters - Filter criteria
 * @param {string|null} filters.timeMin - ISO timestamp for start of range
 * @param {string|null} filters.timeMax - ISO timestamp for end of range
 * @param {string|null} filters.status - Event status ('upcoming', 'past', 'all')
 * @param {Array|null} filters.calendarIds - Array of calendar IDs to include
 * @returns {Array} Filtered events
 */
export function filterEvents(events, filters = {}) {
  let filtered = [...events];

  // Filter by time range
  if (filters.timeMin) {
    const minTime = new Date(filters.timeMin).getTime();
    filtered = filtered.filter(event => event.endDateTime >= minTime);
  }

  if (filters.timeMax) {
    const maxTime = new Date(filters.timeMax).getTime();
    filtered = filtered.filter(event => event.startDateTime <= maxTime);
  }

  // Filter by status (upcoming/past)
  if (filters.status) {
    const now = Date.now();
    if (filters.status === 'upcoming') {
      filtered = filtered.filter(event => event.startDateTime >= now);
    } else if (filters.status === 'past') {
      filtered = filtered.filter(event => event.endDateTime < now);
    }
    // 'all' = no filtering
  }

  // Filter by calendar IDs
  if (filters.calendarIds && Array.isArray(filters.calendarIds) && filters.calendarIds.length > 0) {
    filtered = filtered.filter(event => filters.calendarIds.includes(event.calendarId));
  }

  return filtered;
}

/**
 * Format event time for display
 * @param {Object} event - Event object
 * @returns {string} Formatted time string
 */
export function formatEventTime(event) {
  if (event.isAllDay) {
    // All-day event
    const startDate = new Date(event.startDateTime);
    const endDate = new Date(event.endDateTime);

    // Check if single day or multi-day
    const daysDiff = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));

    if (daysDiff === 1) {
      // Single day
      return startDate.toLocaleDateString();
    } else {
      // Multi-day
      return `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
    }
  } else {
    // Timed event
    const startDate = new Date(event.startDateTime);
    const endDate = new Date(event.endDateTime);

    const timeOptions = { hour: 'numeric', minute: '2-digit' };
    const startTime = startDate.toLocaleTimeString([], timeOptions);
    const endTime = endDate.toLocaleTimeString([], timeOptions);

    // Check if same day
    if (startDate.toDateString() === endDate.toDateString()) {
      return `${startDate.toLocaleDateString()} ${startTime} - ${endTime}`;
    } else {
      return `${startDate.toLocaleString()} - ${endDate.toLocaleString()}`;
    }
  }
}

/**
 * Parse RRULE string to human-readable format
 * @param {Array|null} recurrence - Array of RRULE strings
 * @returns {string} Human-readable recurrence description
 */
export function parseRecurrence(recurrence) {
  if (!recurrence || !Array.isArray(recurrence) || recurrence.length === 0) {
    return 'Does not repeat';
  }

  const rrule = recurrence[0]; // Usually first element is the RRULE

  if (rrule.includes('FREQ=DAILY')) {
    return 'Daily';
  } else if (rrule.includes('FREQ=WEEKLY')) {
    return 'Weekly';
  } else if (rrule.includes('FREQ=MONTHLY')) {
    return 'Monthly';
  } else if (rrule.includes('FREQ=YEARLY')) {
    return 'Yearly';
  } else {
    return 'Custom recurrence';
  }
}

/**
 * Get events for a specific date range (useful for calendar views)
 * @param {string} calendarId - Google calendar ID (or null for all calendars)
 * @param {Date} startDate - Start of range
 * @param {Date} endDate - End of range
 * @returns {Promise<Array>} Events in range
 */
export async function getEventsInRange(calendarId, startDate, endDate) {
  try {
    const timeMin = startDate.toISOString();
    const timeMax = endDate.toISOString();

    if (calendarId) {
      return await getEvents(calendarId, timeMin, timeMax);
    } else {
      // Get events from all calendars
      const allEvents = await db.calendarEvents.toArray();
      return filterEvents(allEvents, { timeMin, timeMax });
    }
  } catch (error) {
    console.error('[calendarEvents] Error getting events in range:', error);
    return [];
  }
}
