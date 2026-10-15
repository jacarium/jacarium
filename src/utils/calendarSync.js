import { db } from '../db/database';
import { getBackendUrl, apiFetch } from './backendUrl';
import { ensureCalendarConnected, calendarRefusalError, isCalendarNotConnectedError } from './calendarAuth';

/**
 * Calendar Sync Utilities
 *
 * Provides functions for syncing calendars and events between Google Calendar API
 * and local IndexedDB cache.
 */

/**
 * Get all synced calendars from IndexedDB
 * @returns {Promise<Array>} Array of synced calendar objects
 */
export async function getCalendars() {
  try {
    const calendars = await db.syncedCalendars.toArray();
    return calendars.sort((a, b) => {
      // Primary calendar first, then alphabetically
      if (a.primary && !b.primary) return -1;
      if (!a.primary && b.primary) return 1;
      return (a.summary || '').localeCompare(b.summary || '');
    });
  } catch (error) {
    console.error('[calendarSync] Error fetching calendars from IndexedDB:', error);
    return [];
  }
}

/**
 * Get a single calendar by ID from IndexedDB
 * @param {string} calendarId - Google calendar ID
 * @returns {Promise<Object|null>} Calendar object or null
 */
export async function getCalendar(calendarId) {
  try {
    const calendar = await db.syncedCalendars.get(calendarId);
    return calendar || null;
  } catch (error) {
    console.error('[calendarSync] Error fetching calendar from IndexedDB:', error);
    return null;
  }
}

/**
 * Fetch calendars from Google Calendar API and sync to IndexedDB
 * @returns {Promise<Array>} Array of synced calendar objects
 */
export async function fetchCalendarsFromGoogle() {
  try {
    // Google Calendar is optional: not configured / not connected / Offline
    // Mode is a state, answered here without a request (calendarAuth.js)
    await ensureCalendarConnected();
    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/calendar/calendars`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw calendarRefusalError(response) || new Error(errorData.error || 'Failed to fetch calendars from Google');
    }

    const data = await response.json();
    const calendars = data.calendars || [];

    // Sync calendars to IndexedDB
    const now = Date.now();
    const calendarPromises = calendars.map(async (cal) => {
      const existingCalendar = await db.syncedCalendars.get(cal.id);

      const calendarData = {
        id: cal.id,
        summary: cal.summary || 'Untitled Calendar',
        description: cal.description || '',
        backgroundColor: cal.backgroundColor || '#4285f4',
        foregroundColor: cal.foregroundColor || '#ffffff',
        accessRole: cal.accessRole || 'reader',
        primary: cal.primary || false,
        syncEnabled: existingCalendar?.syncEnabled ?? true,
        lastSynced: existingCalendar?.lastSynced || null,
        syncStatus: existingCalendar?.syncStatus || 'pending',
        eventCount: existingCalendar?.eventCount || 0,
        createdAt: existingCalendar?.createdAt || now,
        updatedAt: now
      };

      await db.syncedCalendars.put(calendarData);
      return calendarData;
    });

    const syncedCalendars = await Promise.all(calendarPromises);
    console.log('[calendarSync] Synced calendars from Google:', syncedCalendars.length);
    return syncedCalendars;
  } catch (error) {
    if (isCalendarNotConnectedError(error)) {
      console.log('[calendarSync] Calendars not fetched:', error.message);
    } else {
      console.error('[calendarSync] Error fetching calendars from Google:', error);
    }
    throw error;
  }
}

/**
 * Add a calendar to the sync list
 * @param {string} calendarId - Google calendar ID
 * @returns {Promise<Object>} Updated calendar object
 */
export async function addCalendar(calendarId) {
  try {
    // Fetch calendar details from Google
    await fetchCalendarsFromGoogle();

    // Enable sync for this calendar
    const calendar = await db.syncedCalendars.get(calendarId);
    if (calendar) {
      calendar.syncEnabled = true;
      calendar.updatedAt = Date.now();
      await db.syncedCalendars.put(calendar);
      return calendar;
    } else {
      throw new Error('Calendar not found');
    }
  } catch (error) {
    console.error('[calendarSync] Error adding calendar:', error);
    throw error;
  }
}

/**
 * Remove a calendar from sync (disable sync)
 * @param {string} calendarId - Google calendar ID
 * @returns {Promise<void>}
 */
export async function removeCalendar(calendarId) {
  try {
    const calendar = await db.syncedCalendars.get(calendarId);
    if (calendar) {
      calendar.syncEnabled = false;
      calendar.syncStatus = 'disabled';
      calendar.updatedAt = Date.now();
      await db.syncedCalendars.put(calendar);

      // Optionally remove cached events for this calendar
      await db.calendarEvents.where('calendarId').equals(calendarId).delete();

      console.log('[calendarSync] Removed calendar from sync:', calendarId);
    }
  } catch (error) {
    console.error('[calendarSync] Error removing calendar:', error);
    throw error;
  }
}

/**
 * Update calendar sync status
 * @param {string} calendarId - Google calendar ID
 * @param {string} status - Sync status ('synced', 'syncing', 'error', 'pending', 'disabled')
 * @param {number|null} lastSynced - Timestamp of last sync (optional)
 * @returns {Promise<void>}
 */
export async function updateCalendarSyncStatus(calendarId, status, lastSynced = null) {
  try {
    const calendar = await db.syncedCalendars.get(calendarId);
    if (calendar) {
      calendar.syncStatus = status;
      if (lastSynced !== null) {
        calendar.lastSynced = lastSynced;
      }
      calendar.updatedAt = Date.now();
      await db.syncedCalendars.put(calendar);
    }
  } catch (error) {
    console.error('[calendarSync] Error updating sync status:', error);
    throw error;
  }
}

/**
 * Get sync status for a calendar
 * @param {string} calendarId - Google calendar ID
 * @returns {Promise<Object>} Sync status object with status, lastSynced, eventCount
 */
export async function getSyncStatus(calendarId) {
  try {
    const calendar = await db.syncedCalendars.get(calendarId);
    if (calendar) {
      return {
        status: calendar.syncStatus || 'pending',
        lastSynced: calendar.lastSynced || null,
        eventCount: calendar.eventCount || 0,
        syncEnabled: calendar.syncEnabled ?? true
      };
    } else {
      return {
        status: 'not_found',
        lastSynced: null,
        eventCount: 0,
        syncEnabled: false
      };
    }
  } catch (error) {
    console.error('[calendarSync] Error getting sync status:', error);
    return {
      status: 'error',
      lastSynced: null,
      eventCount: 0,
      syncEnabled: false
    };
  }
}

/**
 * Sync a single calendar's events from Google Calendar API
 * @param {string} calendarId - Google calendar ID
 * @param {string|null} timeMin - ISO timestamp for start of range (optional)
 * @param {string|null} timeMax - ISO timestamp for end of range (optional)
 * @returns {Promise<Array>} Array of synced events
 */
export async function syncCalendar(calendarId, timeMin = null, timeMax = null) {
  // Not connected: no request, and the calendar keeps its last sync status
  // instead of turning into an error
  await ensureCalendarConnected();
  try {
    console.log('[calendarSync] Starting sync for calendar:', calendarId);

    // Update status to syncing
    await updateCalendarSyncStatus(calendarId, 'syncing');

    // Build query parameters
    const params = new URLSearchParams({ calendarId });
    if (timeMin) params.append('timeMin', timeMin);
    if (timeMax) params.append('timeMax', timeMax);

    // Call backend sync endpoint
    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/calendar/sync?${params.toString()}`, {
      method: 'POST'
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw calendarRefusalError(response) || new Error(errorData.error || 'Failed to sync calendar');
    }

    const data = await response.json();
    const events = data.events || [];

    // Cache events in IndexedDB (handled by calendarEvents utility)
    const { cacheEvents } = await import('./calendarEvents');
    await cacheEvents(calendarId, events, timeMin, timeMax);

    // Update calendar sync status and event count
    const now = Date.now();
    await updateCalendarSyncStatus(calendarId, 'synced', now);

    const calendar = await db.syncedCalendars.get(calendarId);
    if (calendar) {
      calendar.eventCount = events.length;
      calendar.updatedAt = now;
      await db.syncedCalendars.put(calendar);
    }

    console.log('[calendarSync] Synced calendar:', calendarId, 'Events:', events.length);
    return events;
  } catch (error) {
    if (isCalendarNotConnectedError(error)) {
      console.log('[calendarSync] Sync stopped:', error.message);
      await updateCalendarSyncStatus(calendarId, 'pending');
    } else {
      console.error('[calendarSync] Error syncing calendar:', error);
      await updateCalendarSyncStatus(calendarId, 'error');
    }
    throw error;
  }
}

/**
 * Sync all enabled calendars from Google Calendar API
 * @param {string|null} timeMin - ISO timestamp for start of range (optional)
 * @param {string|null} timeMax - ISO timestamp for end of range (optional)
 * @returns {Promise<Object>} Object with success count, error count, and results
 */
export async function syncAllCalendars(timeMin = null, timeMax = null) {
  try {
    console.log('[calendarSync] Starting sync for all calendars');

    // First, fetch latest calendar list from Google
    await fetchCalendarsFromGoogle();

    // Get all enabled calendars
    const allCalendars = await db.syncedCalendars.toArray();
    const calendars = allCalendars.filter(cal => cal.syncEnabled === true);

    if (calendars.length === 0) {
      console.log('[calendarSync] No calendars enabled for sync');
      return {
        success: 0,
        error: 0,
        total: 0,
        results: []
      };
    }

    // Sync each calendar
    const results = await Promise.allSettled(
      calendars.map(cal => syncCalendar(cal.id, timeMin, timeMax))
    );

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const errorCount = results.filter(r => r.status === 'rejected').length;

    console.log('[calendarSync] Sync all complete. Success:', successCount, 'Errors:', errorCount);

    return {
      success: successCount,
      error: errorCount,
      total: calendars.length,
      results: results.map((result, index) => ({
        calendarId: calendars[index].id,
        calendarName: calendars[index].summary,
        status: result.status,
        events: result.status === 'fulfilled' ? result.value.length : 0,
        error: result.status === 'rejected' ? result.reason.message : null
      }))
    };
  } catch (error) {
    if (isCalendarNotConnectedError(error)) {
      console.log('[calendarSync] Sync all stopped:', error.message);
    } else {
      console.error('[calendarSync] Error syncing all calendars:', error);
    }
    throw error;
  }
}

/**
 * Get overall sync status across all calendars
 * @returns {Promise<Object>} Overall sync status with aggregated info
 */
export async function getOverallSyncStatus() {
  try {
    const calendars = await db.syncedCalendars.toArray();

    const enabledCalendars = calendars.filter(cal => cal.syncEnabled);
    const syncingCount = enabledCalendars.filter(cal => cal.syncStatus === 'syncing').length;
    const errorCount = enabledCalendars.filter(cal => cal.syncStatus === 'error').length;
    const syncedCount = enabledCalendars.filter(cal => cal.syncStatus === 'synced').length;

    // Determine overall status
    let overallStatus = 'synced';
    if (syncingCount > 0) {
      overallStatus = 'syncing';
    } else if (errorCount > 0) {
      overallStatus = 'error';
    } else if (syncedCount === 0 && enabledCalendars.length > 0) {
      overallStatus = 'pending';
    }

    // Get most recent sync time
    const lastSyncTimes = enabledCalendars
      .map(cal => cal.lastSynced)
      .filter(time => time !== null)
      .sort((a, b) => b - a);
    const lastSynced = lastSyncTimes.length > 0 ? lastSyncTimes[0] : null;

    // Total event count
    const totalEvents = calendars.reduce((sum, cal) => sum + (cal.eventCount || 0), 0);

    return {
      status: overallStatus,
      lastSynced,
      totalCalendars: calendars.length,
      enabledCalendars: enabledCalendars.length,
      syncingCount,
      errorCount,
      syncedCount,
      totalEvents
    };
  } catch (error) {
    console.error('[calendarSync] Error getting overall sync status:', error);
    return {
      status: 'error',
      lastSynced: null,
      totalCalendars: 0,
      enabledCalendars: 0,
      syncingCount: 0,
      errorCount: 0,
      syncedCount: 0,
      totalEvents: 0
    };
  }
}

/**
 * Auto-sync scheduler (call this on interval)
 * @param {number} intervalMinutes - Sync interval in minutes (default: 5)
 * @returns {Promise<void>}
 */
export async function scheduleAutoSync(intervalMinutes = 5) {
  const intervalMs = intervalMinutes * 60 * 1000;

  const runSync = async () => {
    try {
      console.log('[calendarSync] Auto-sync triggered');
      const result = await syncAllCalendars();
      console.log('[calendarSync] Auto-sync complete:', result);
    } catch (error) {
      console.error('[calendarSync] Auto-sync error:', error);
    }
  };

  // Run initial sync
  await runSync();

  // Schedule periodic syncs
  const intervalId = setInterval(runSync, intervalMs);

  // Return cleanup function
  return () => clearInterval(intervalId);
}
