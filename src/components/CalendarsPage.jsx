import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useContextMenu } from '../hooks/useContextMenu';
import ResizableSidebar from './ResizableSidebar';
import VerticalResizableDivider from './VerticalResizableDivider';
import CalendarSidebar from './features/calendars/CalendarSidebar';
import EventTemplateSidebar from './features/calendars/EventTemplateSidebar';
import TabBar from './features/calendars/TabBar';
import CalendarToolbar from './features/calendars/CalendarToolbar';
import CalendarView from './features/calendars/CalendarView';
import CalendarEventModal from './common/modals/CalendarEventModal';
import EventDetailsModal from './features/calendars/EventDetailsModal';
import EventTemplateModal from './features/calendars/EventTemplateModal';
import AddCalendarModal from './features/calendars/AddCalendarModal';
import ConfirmationModal from './common/ConfirmationModal';
import CalendarConnectState, { CalendarConnectBanner } from './features/calendars/CalendarConnectState';
import { Calendar } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';
import { getBackendUrl, apiFetch } from '../utils/backendUrl';
import {
  getCalendarAuthStatus,
  calendarConnectionState,
  calendarStateMessage,
  connectGoogleCalendar,
  isCalendarNotConnectedError
} from '../utils/calendarAuth';
import {
  getCalendars,
  syncCalendar,
  syncAllCalendars,
  getSyncStatus,
  getOverallSyncStatus,
  fetchCalendarsFromGoogle
} from '../utils/calendarSync';
import {
  getEventsInRange,
  deleteEvent
} from '../utils/calendarEvents';
import { MenuItemIcon } from './common/menus/MenuItemIcon';

/**
 * CalendarsPage - Main calendars page with tab-based navigation
 *
 * Features:
 * - Resizable sidebar with calendars list and templates
 * - Tab bar for open calendars
 * - Sync status bar with auto-sync toggle
 * - Toolbar with search, view switcher, navigation
 * - Calendar view (month/week/day)
 * - Event creation/editing via CalendarEventModal
 */
export default function CalendarsPage() {
  const { addNotification } = useNotifications();

  // State
  const [calendars, setCalendars] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [openCalendarTabs, setOpenCalendarTabs] = useLocalStorage('calendarOpenTabs', []);
  const [activeCalendarTab, setActiveCalendarTab] = useLocalStorage('activeCalendarTab', null);
  const [calendarEvents, setCalendarEvents] = useState({}); // calendarId → events array
  const [syncStatus, setSyncStatus] = useState({}); // calendarId → { status: 'synced'|'syncing'|'error', lastSynced }
  const [overallSyncStatus, setOverallSyncStatus] = useState({ status: 'synced', lastSynced: null });
  const [viewMode, setViewMode] = useLocalStorage('calendarViewMode', 'month');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [searchQuery, setSearchQuery] = useState('');
  const [autoSyncEnabled] = useLocalStorage('calendarAutoSync', true);
  const [showAllDayEvents, setShowAllDayEvents] = useLocalStorage('calendarShowAllDay', true);
  const [templateSidebarCollapsed, setTemplateSidebarCollapsed] = useLocalStorage('calendarTemplateSidebarCollapsed', false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [innerSidebarVisible, setInnerSidebarVisible] = useLocalStorage('innerSidebarVisible', true);

  // Google Calendar is optional (src/utils/calendarAuth.js): the backend's
  // auth status, read once (again after a settings save or a sign-in),
  // decides what the page does. Nothing syncs and no toast appears unless
  // the state is 'connected'.
  const [calendarStatus, setCalendarStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const connectionState = useMemo(() => calendarConnectionState(calendarStatus), [calendarStatus]);
  const connectionStateRef = useRef('unknown');
  useEffect(() => { connectionStateRef.current = connectionState; }, [connectionState]);
  const isConnected = connectionState === 'connected';

  const refreshCalendarStatus = useCallback(async ({ refresh = true } = {}) => {
    const status = await getCalendarAuthStatus({ refresh });
    setCalendarStatus(status);
    return status;
  }, []);

  useEffect(() => {
    const onSettingsSaved = () => { refreshCalendarStatus().catch(() => {}); };
    window.addEventListener('settingsSaved', onSettingsSaved);
    return () => { window.removeEventListener('settingsSaved', onSettingsSaved); };
  }, [refreshCalendarStatus]);

  // Listen for inner sidebar visibility changes
  useEffect(() => {
    function handleInnerSidebarVisibilityChange(event) {
      setInnerSidebarVisible(event.detail.visible);
    }

    window.addEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
    return () => window.removeEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
  }, [setInnerSidebarVisible]);

  // Calendar event modal state
  const [showEventModal, setShowEventModal] = useState(false);
  const [eventModalMode, setEventModalMode] = useState('create');
  const [eventModalData, setEventModalData] = useState(null);

  // Event details modal state
  const [showEventDetailsModal, setShowEventDetailsModal] = useState(false);
  const [eventDetailsData, setEventDetailsData] = useState(null);

  // Add calendar modal state
  const [showAddCalendarModal, setShowAddCalendarModal] = useState(false);

  // Template modal state
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);

  // Template delete confirmation state
  const [showTemplateDeleteConfirmation, setShowTemplateDeleteConfirmation] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState(null);

  // Context menu
  const {
    contextMenu,
    contextMenuRef,
    openContextMenu,
    closeContextMenu
  } = useContextMenu();

  // Confirmation modal state
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [calendarToDelete, setCalendarToDelete] = useState(null);

  // Event delete confirmation state
  const [showEventDeleteConfirmation, setShowEventDeleteConfirmation] = useState(false);
  const [eventToDelete, setEventToDelete] = useState(null);

  // Auto-sync interval ref
  const autoSyncIntervalRef = useRef(null);

  // Load templates
  useEffect(() => {
    async function loadTemplates() {
      try {
        const { db } = await import('../db/database');
        const allTemplates = await db.calendarEventTemplates.toArray();
        setTemplates(allTemplates);
      } catch (error) {
        console.error('[CalendarsPage] Error loading templates:', error);
      }
    }

    loadTemplates();
  }, []);

  // Calculate date range for fetching events
  const getDateRange = (date, mode) => {
    const start = new Date(date);
    const end = new Date(date);

    if (mode === 'month') {
      // Start of month to end of month
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setMonth(end.getMonth() + 1, 0);
      end.setHours(23, 59, 59, 999);
    } else if (mode === 'week') {
      // Start of week (Sunday) to end of week (Saturday)
      start.setDate(start.getDate() - start.getDay());
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() - end.getDay() + 6);
      end.setHours(23, 59, 59, 999);
    } else {
      // Single day
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    }

    return { start, end };
  };

  // Tab operations
  const openCalendarTab = useCallback((calendarId) => {
    // Add to open tabs (no-op if already open) and make it active
    setOpenCalendarTabs(prev => prev.includes(calendarId) ? prev : [...prev, calendarId]);
    setActiveCalendarTab(calendarId);
  }, [setOpenCalendarTabs, setActiveCalendarTab]);

  const closeCalendarTab = useCallback((calendarId) => {
    const newTabs = openCalendarTabs.filter(id => id !== calendarId);
    setOpenCalendarTabs(newTabs);

    // If closing active tab, switch to another tab
    if (activeCalendarTab === calendarId) {
      if (newTabs.length > 0) {
        // Switch to the tab before the closed one, or the first tab
        const closedIndex = openCalendarTabs.indexOf(calendarId);
        const newActiveIndex = closedIndex > 0 ? closedIndex - 1 : 0;
        setActiveCalendarTab(newTabs[newActiveIndex]);
      } else {
        setActiveCalendarTab(null);
      }
    }

    // Clean up events for closed tab
    setCalendarEvents(prev => {
      const newEvents = { ...prev };
      delete newEvents[calendarId];
      return newEvents;
    });
  }, [openCalendarTabs, activeCalendarTab, setOpenCalendarTabs, setActiveCalendarTab]);

  const switchCalendarTab = useCallback((calendarId) => {
    setActiveCalendarTab(calendarId);
  }, [setActiveCalendarTab]);

  // A sync asked for while not connected: one calm notice with the reason
  // (the manual buttons); the automatic syncs never get this far.
  const explainNotConnected = (state = connectionStateRef.current) => {
    addNotification({
      type: 'alert',
      title: 'Google Calendar not connected',
      message: calendarStateMessage(state)
    });
  };

  // Sync operations
  const handleSyncCalendar = async (calendarId) => {
    if (!calendarId) return;
    if (connectionStateRef.current !== 'connected') {
      explainNotConnected();
      return;
    }

    try {
      setIsSyncing(true);
      setSyncStatus(prev => ({
        ...prev,
        [calendarId]: { status: 'syncing', lastSynced: prev[calendarId]?.lastSynced || null }
      }));

      const { start, end } = getDateRange(currentDate, viewMode);
      await syncCalendar(calendarId, start.toISOString(), end.toISOString());

      // Reload events
      const events = await getEventsInRange(calendarId, start, end);
      setCalendarEvents(prev => ({
        ...prev,
        [calendarId]: events
      }));

      // Update sync status
      const status = await getSyncStatus(calendarId);
      setSyncStatus(prev => ({
        ...prev,
        [calendarId]: status
      }));

      addNotification({
        type: 'success',
        title: 'Calendar Synced',
        message: 'Calendar events have been synced from Google.'
      });
    } catch (error) {
      if (isCalendarNotConnectedError(error)) {
        // the state changed under us (token revoked)
        setSyncStatus(prev => ({
          ...prev,
          [calendarId]: { status: 'pending', lastSynced: prev[calendarId]?.lastSynced || null }
        }));
        refreshCalendarStatus().catch(() => {});
        explainNotConnected(error.state);
        return;
      }
      console.error('[CalendarsPage] Sync error:', error);
      setSyncStatus(prev => ({
        ...prev,
        [calendarId]: { status: 'error', lastSynced: prev[calendarId]?.lastSynced || null }
      }));
      addNotification({
        type: 'error',
        title: 'Sync Failed',
        message: error.message || 'Failed to sync calendar events.'
      });
    } finally {
      setIsSyncing(false);
    }
  };

  // `manual` is the sidebar's Sync All button; the auto-sync timer calls
  // it without, and is silent when the calendar is not connected.
  const handleSyncAll = async ({ manual = false } = {}) => {
    if (connectionStateRef.current !== 'connected') {
      if (manual) explainNotConnected();
      return;
    }
    try {
      setIsSyncing(true);
      setOverallSyncStatus(prev => ({ ...prev, status: 'syncing' }));

      const { start, end } = getDateRange(currentDate, viewMode);
      const result = await syncAllCalendars(start.toISOString(), end.toISOString());

      // Reload calendars
      const cals = await getCalendars();
      setCalendars(cals);

      // Reload events for active calendar
      if (activeCalendarTab) {
        const events = await getEventsInRange(activeCalendarTab, start, end);
        setCalendarEvents(prev => ({
          ...prev,
          [activeCalendarTab]: events
        }));
      }

      // Update overall sync status
      const overall = await getOverallSyncStatus();
      setOverallSyncStatus(overall);

      if (result.error > 0) {
        addNotification({
          type: 'warning',
          title: 'Sync Completed with Errors',
          message: `Synced ${result.success}/${result.total} calendars. ${result.error} failed.`
        });
      } else {
        addNotification({
          type: 'success',
          title: 'All Calendars Synced',
          message: `Synced ${result.success} calendar${result.success !== 1 ? 's' : ''}.`
        });
      }
    } catch (error) {
      if (isCalendarNotConnectedError(error)) {
        setOverallSyncStatus(prev => ({ ...prev, status: 'pending' }));
        refreshCalendarStatus().catch(() => {});
        if (manual) explainNotConnected(error.state);
        return;
      }
      console.error('[CalendarsPage] Sync all error:', error);
      setOverallSyncStatus(prev => ({ ...prev, status: 'error' }));
      addNotification({
        type: 'error',
        title: 'Sync Failed',
        message: error.message || 'Failed to sync calendars.'
      });
    } finally {
      setIsSyncing(false);
    }
  };

  // Load calendars on mount
  useEffect(() => {
    async function loadCalendars() {
      try {
        // The backend's auth status decides: only a connected calendar is
        // fetched from Google - the cached calendars are shown either way.
        const status = await refreshCalendarStatus({ refresh: false });
        const state = calendarConnectionState(status);
        if (state === 'connected') {
          try {
            await fetchCalendarsFromGoogle();
          } catch (error) {
            console.warn('[CalendarsPage] Could not fetch from Google, using cached calendars:', error);
          }
        } else {
          console.log(`[CalendarsPage] Google Calendar ${state}: showing cached calendars only`);
        }
      } catch (error) {
        console.warn('[CalendarsPage] Could not check auth status:', error);
      }

      // Load from IndexedDB (includes newly synced or previously cached)
      const cals = await getCalendars();
      setCalendars(cals);

      // If no active tab but we have calendars, open the first one
      if (!activeCalendarTab && cals.length > 0) {
        const primaryCalendar = cals.find(cal => cal.primary) || cals[0];
        openCalendarTab(primaryCalendar.id);
      }

      // Load overall sync status
      const overall = await getOverallSyncStatus();
      setOverallSyncStatus(overall);
    }

    loadCalendars();
    // Intentional mount-only load: activeCalendarTab is read once to decide
    // whether to open a default tab, and openCalendarTab is a stable callback.
    // Re-running this on tab changes would re-fetch calendars from Google.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch events for active calendar when it changes or date range changes
  useEffect(() => {
    if (!activeCalendarTab) return;

    async function fetchEvents() {
      try {
        // Calculate date range based on view mode
        const { start, end } = getDateRange(currentDate, viewMode);

        // Fetch events from cache (instant UI update)
        const events = await getEventsInRange(activeCalendarTab, start, end);
        setCalendarEvents(prev => ({
          ...prev,
          [activeCalendarTab]: events
        }));

        // Update sync status for this calendar
        const status = await getSyncStatus(activeCalendarTab);
        setSyncStatus(prev => ({
          ...prev,
          [activeCalendarTab]: status
        }));

        // Trigger background sync from Google (don't await, don't block UI)
        // - only while connected; otherwise the cached events are all there is
        if (!isConnected) return;
        syncCalendar(activeCalendarTab, start.toISOString(), end.toISOString())
          .then(async () => {
            // Reload events after sync completes
            const updatedEvents = await getEventsInRange(activeCalendarTab, start, end);
            setCalendarEvents(prev => ({
              ...prev,
              [activeCalendarTab]: updatedEvents
            }));

            // Update sync status
            const updatedStatus = await getSyncStatus(activeCalendarTab);
            setSyncStatus(prev => ({
              ...prev,
              [activeCalendarTab]: updatedStatus
            }));
          })
          .catch(error => {
            console.warn('[CalendarsPage] Background sync failed:', error);
            // Don't show error notification for background syncs
          });
      } catch (error) {
        console.error('[CalendarsPage] Error fetching events:', error);
      }
    }

    fetchEvents();
  }, [activeCalendarTab, currentDate, viewMode, isConnected]);

  // Keep a ref to the latest handleSyncAll so the auto-sync interval always
  // syncs the currently-viewed range (avoiding a stale closure) without
  // re-arming the 5-minute timer on every render.
  const syncAllRef = useRef(null);
  useEffect(() => {
    syncAllRef.current = handleSyncAll;
  });

  // Auto-sync on interval - armed only while the calendar is connected
  // (not configured / not connected / the browser deployment: nothing to
  // sync, and nothing that would fail)
  useEffect(() => {
    if (!autoSyncEnabled || !isConnected) {
      if (autoSyncIntervalRef.current) {
        clearInterval(autoSyncIntervalRef.current);
        autoSyncIntervalRef.current = null;
      }
      return;
    }

    const runSync = () => { syncAllRef.current?.(); };

    // Initial sync, then every 5 minutes
    runSync();
    autoSyncIntervalRef.current = setInterval(runSync, 5 * 60 * 1000);

    return () => {
      if (autoSyncIntervalRef.current) {
        clearInterval(autoSyncIntervalRef.current);
      }
    };
  }, [autoSyncEnabled, isConnected]);

  // Event handlers
  const handleEventClick = (event) => {
    // Open event details modal
    setEventDetailsData({ eventId: event.eventId, calendarId: event.calendarId });
    setShowEventDetailsModal(true);
  };

  const handleEventRightClick = (event, e) => {
    // Show context menu with delete option
    openContextMenu(e, 'event', { eventId: event.eventId, calendarId: event.calendarId, summary: event.summary });
  };

  const handleDeleteEvent = async (eventId, calendarId) => {
    try {
      await deleteEvent(eventId, calendarId);

      // Reload events for active calendar
      if (activeCalendarTab) {
        const { start, end } = getDateRange(currentDate, viewMode);
        const events = await getEventsInRange(activeCalendarTab, start, end);
        setCalendarEvents(prev => ({
          ...prev,
          [activeCalendarTab]: events
        }));
      }

      addNotification({
        type: 'success',
        title: 'Event Deleted',
        message: 'Event has been successfully deleted.'
      });
    } catch (error) {
      console.error('[CalendarsPage] Delete event error:', error);
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: error.message || 'Failed to delete event.'
      });
    }
  };

  const handleEmptySlotDoubleClick = (date) => {
    console.log('[CalendarsPage] Empty slot double-clicked:', date);
    // Create new event at this time
    setEventModalMode('create');
    setEventModalData({
      calendarId: activeCalendarTab,
      initialData: {
        startTime: date.toISOString(),
        endTime: new Date(date.getTime() + 60 * 60 * 1000).toISOString() // 1 hour later
      }
    });
    setShowEventModal(true);
  };

  const handleDragCreateEvent = (startDate, endDate) => {
    console.log('[CalendarsPage] Drag create event:', startDate, endDate);
    // Create new event with dragged time range
    setEventModalMode('create');
    setEventModalData({
      calendarId: activeCalendarTab,
      initialData: {
        startTime: startDate.toISOString(),
        endTime: endDate.toISOString()
      }
    });
    setShowEventModal(true);
  };

  const handleNewEvent = () => {
    setEventModalMode('create');
    setEventModalData({ calendarId: activeCalendarTab });
    setShowEventModal(true);
  };

  const handleEventCreated = async () => {
    setShowEventModal(false);
    setEventModalData(null);

    // Reload events for active calendar
    if (activeCalendarTab) {
      const { start, end } = getDateRange(currentDate, viewMode);
      const events = await getEventsInRange(activeCalendarTab, start, end);
      setCalendarEvents(prev => ({
        ...prev,
        [activeCalendarTab]: events
      }));
    }
  };

  const handleEventUpdated = async () => {
    setShowEventModal(false);
    setEventModalData(null);

    // Reload events for active calendar
    if (activeCalendarTab) {
      const { start, end } = getDateRange(currentDate, viewMode);
      const events = await getEventsInRange(activeCalendarTab, start, end);
      setCalendarEvents(prev => ({
        ...prev,
        [activeCalendarTab]: events
      }));
    }
  };

  const handleRemoveCalendar = async (calendarId) => {
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/calendar/calendars/${calendarId}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to remove calendar');
      }

      // Close any tabs for this calendar
      if (openCalendarTabs.includes(calendarId)) {
        closeCalendarTab(calendarId);
      }

      // Remove from calendars list
      setCalendars(prev => prev.filter(cal => cal.id !== calendarId));

      // Remove from IndexedDB
      const { db } = await import('../db/database');
      await db.syncedCalendars.delete(calendarId);
      await db.calendarEvents.where('calendarId').equals(calendarId).delete();

      addNotification({
        type: 'success',
        title: 'Calendar Removed',
        message: 'Calendar has been removed from your list.'
      });
    } catch (error) {
      console.error('[CalendarsPage] Remove calendar error:', error);
      addNotification({
        type: 'error',
        title: 'Remove Failed',
        message: error.message || 'Failed to remove calendar.'
      });
    }
  };

  const handleCalendarAdded = async (newCalendar) => {
    try {
      // Add to IndexedDB
      const { db } = await import('../db/database');
      await db.syncedCalendars.put({
        id: newCalendar.id,
        summary: newCalendar.summary,
        description: newCalendar.description || '',
        backgroundColor: newCalendar.backgroundColor || '#4285f4',
        foregroundColor: newCalendar.foregroundColor || '#ffffff',
        accessRole: newCalendar.accessRole || 'reader',
        primary: newCalendar.primary || false,
        syncEnabled: true,
        lastSynced: Date.now(),
        syncStatus: 'synced',
        eventCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      // Add to calendars list
      setCalendars(prev => [...prev, newCalendar]);

      // Open in a new tab
      openCalendarTab(newCalendar.id);

      // Sync the new calendar
      const { start, end } = getDateRange(currentDate, viewMode);
      await syncCalendar(newCalendar.id, start.toISOString(), end.toISOString());
    } catch (error) {
      console.error('[CalendarsPage] Error adding calendar to DB:', error);
      addNotification({
        type: 'error',
        title: 'Calendar Added with Errors',
        message: 'Calendar was added but could not be synced. Try refreshing manually.'
      });
    }
  };

  // Date navigation
  const handleToday = () => {
    setCurrentDate(new Date());
  };

  const handlePrevious = () => {
    const newDate = new Date(currentDate);
    if (viewMode === 'month') {
      newDate.setMonth(newDate.getMonth() - 1);
    } else if (viewMode === 'week') {
      newDate.setDate(newDate.getDate() - 7);
    } else {
      newDate.setDate(newDate.getDate() - 1);
    }
    setCurrentDate(newDate);
  };

  const handleNext = () => {
    const newDate = new Date(currentDate);
    if (viewMode === 'month') {
      newDate.setMonth(newDate.getMonth() + 1);
    } else if (viewMode === 'week') {
      newDate.setDate(newDate.getDate() + 7);
    } else {
      newDate.setDate(newDate.getDate() + 1);
    }
    setCurrentDate(newDate);
  };

  // Sign in with Google (src/utils/calendarAuth.js): the backend starts
  // the flow and answers at once; "complete the sign-in in your browser"
  // is shown only then, and the page waits for the token.
  const handleAuthenticate = async () => {
    if (connecting) return;
    const state = connectionStateRef.current;
    if (state === 'offline' || state === 'unconfigured' || state === 'unavailable') {
      explainNotConnected(state);
      return;
    }
    setConnecting(true);
    try {
      await connectGoogleCalendar({
        onBrowserOpened: (message) => {
          addNotification({
            type: 'info',
            title: 'Complete the sign-in in your browser',
            message: message || 'Complete the Google sign-in in the browser window that just opened.'
          });
        }
      });
      await refreshCalendarStatus();
      addNotification({
        type: 'success',
        title: 'Google Calendar connected',
        message: 'Signed in with Google. Syncing calendars...'
      });

      // Fetch calendars after successful authentication
      await fetchCalendarsFromGoogle();
      const cals = await getCalendars();
      setCalendars(cals);

      // Open first calendar
      if (cals.length > 0) {
        const primaryCalendar = cals.find(cal => cal.primary) || cals[0];
        openCalendarTab(primaryCalendar.id);
      }
    } catch (error) {
      console.warn('[CalendarsPage] Google sign-in failed:', error?.message || error);
      refreshCalendarStatus().catch(() => {});
      addNotification({
        type: 'error',
        title: 'Authentication Failed',
        message: error?.message || 'Failed to authenticate with Google Calendar.'
      });
    } finally {
      setConnecting(false);
    }
  };

  // Template handlers
  const handleTemplateClick = (template) => {
    console.log('[CalendarsPage] Template clicked:', template);
    // Open event modal with template data
    setEventModalMode('create');
    setEventModalData({
      calendarId: activeCalendarTab,
      initialData: {
        summary: template.defaultSummary || '',
        guests: template.defaultGuests || '',
        description: template.defaultDescription || '',
        location: template.defaultLocation || ''
      }
    });
    setShowEventModal(true);
  };

  const handleCreateTemplate = () => {
    setEditingTemplate(null);
    setShowTemplateModal(true);
  };

  const handleTemplateSaved = async () => {
    // Reload templates
    try {
      const { db } = await import('../db/database');
      const allTemplates = await db.calendarEventTemplates.toArray();
      setTemplates(allTemplates);
    } catch (error) {
      console.error('[CalendarsPage] Error reloading templates:', error);
    }
  };

  const handleEditTemplate = (template) => {
    setEditingTemplate(template);
    setShowTemplateModal(true);
  };

  const handleDeleteTemplate = async (template) => {
    setTemplateToDelete(template);
    setShowTemplateDeleteConfirmation(true);
  };

  const confirmDeleteTemplate = async () => {
    if (!templateToDelete) return;

    try {
      const { db } = await import('../db/database');
      await db.calendarEventTemplates.delete(templateToDelete.id);

      // Reload templates
      const allTemplates = await db.calendarEventTemplates.toArray();
      setTemplates(allTemplates);

      addNotification({
        type: 'success',
        title: 'Template Deleted',
        message: `Template "${templateToDelete.name}" deleted successfully.`
      });
    } catch (error) {
      console.error('[CalendarsPage] Error deleting template:', error);
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: error.message || 'Failed to delete template.'
      });
    } finally {
      setShowTemplateDeleteConfirmation(false);
      setTemplateToDelete(null);
    }
  };

  // Get events for active calendar
  const activeEvents = activeCalendarTab ? (calendarEvents[activeCalendarTab] || []) : [];

  // Get sync status for active calendar (map to same values as Documents Central Server)
  const mapSyncStatus = (status) => {
    if (status === 'syncing') return 'checking';
    if (status === 'synced') return 'online';
    if (status === 'error') return 'offline';
    return 'online'; // default
  };

  const activeSyncStatus = activeCalendarTab
    ? mapSyncStatus(syncStatus[activeCalendarTab]?.status || 'synced')
    : mapSyncStatus(overallSyncStatus.status);

  return (
    <div className="flex h-full bg-os-background">
      {/* Resizable Sidebar */}
      {innerSidebarVisible && (
        <ResizableSidebar
          defaultWidth={280}
          minWidth={200}
          maxWidth={500}
          storageKey="calendarSidebarWidth"
          position="right"
          className="border-r border-os-border"
        >
          <VerticalResizableDivider
            defaultTopHeight={60}
            minTopHeight={30}
            maxTopHeight={80}
            storageKey="calendar-sidebar-vertical-split"
            bottomCollapsed={templateSidebarCollapsed}
            topContent={
              <CalendarSidebar
                calendars={calendars}
                openTabs={openCalendarTabs}
                activeTab={activeCalendarTab}
                syncStatus={activeSyncStatus}
                isSyncing={isSyncing}
                onCalendarClick={openCalendarTab}
                onCalendarRightClick={(calendarId, e) => {
                  openContextMenu(e, 'calendar', calendarId);
                }}
                onNewEvent={handleNewEvent}
                onSyncCalendar={() => activeCalendarTab && handleSyncCalendar(activeCalendarTab)}
                onSyncAll={() => handleSyncAll({ manual: true })}
                onAddCalendar={() => setShowAddCalendarModal(true)}
              />
            }
            bottomContent={
              <EventTemplateSidebar
                templates={templates}
                loading={false}
                onLoadTemplate={handleTemplateClick}
                onCreateTemplate={handleCreateTemplate}
                onEditTemplate={handleEditTemplate}
                onDeleteTemplate={handleDeleteTemplate}
                isCollapsed={templateSidebarCollapsed}
                onCollapsedChange={setTemplateSidebarCollapsed}
              />
            }
          />
        </ResizableSidebar>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Tab Bar */}
        <TabBar
          calendars={calendars}
          openTabs={openCalendarTabs}
          activeTab={activeCalendarTab}
          onTabClick={switchCalendarTab}
          onTabClose={closeCalendarTab}
          onTabRightClick={(calendarId) => {
            console.log('[CalendarsPage] Tab right-clicked:', calendarId);
            // TODO: Show context menu (Close, Close Others, Close All)
          }}
        />

        {/* Not connected: the slim strip above a cached calendar */}
        {activeCalendarTab && (
          <CalendarConnectBanner state={connectionState} onConnect={handleAuthenticate} connecting={connecting} />
        )}

        {/* Toolbar */}
        {activeCalendarTab && (
          <CalendarToolbar
            viewMode={viewMode}
            currentDate={currentDate}
            searchQuery={searchQuery}
            showAllDayEvents={showAllDayEvents}
            onViewModeChange={setViewMode}
            onSearchChange={setSearchQuery}
            onShowAllDayEventsToggle={setShowAllDayEvents}
            onNewEvent={handleNewEvent}
            onToday={handleToday}
            onPrevious={handlePrevious}
            onNext={handleNext}
          />
        )}

        {/* Calendar View */}
        {activeCalendarTab ? (
          <CalendarView
            viewMode={viewMode}
            currentDate={currentDate}
            events={activeEvents}
            calendars={calendars}
            searchQuery={searchQuery}
            showAllDayEvents={showAllDayEvents}
            onEventClick={handleEventClick}
            onEventRightClick={handleEventRightClick}
            onEmptySlotDoubleClick={handleEmptySlotDoubleClick}
            onDragCreateEvent={handleDragCreateEvent}
          />
        ) : isConnected || (calendars.length > 0 && connectionState === 'unknown') ? (
          <div className="flex-1 flex items-center justify-center bg-os-background">
            <div className="text-center">
              <Calendar size={64} className="text-os-text-muted mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-os-text-primary mb-2">
                No Calendar Selected
              </h2>
              <p className="text-sm text-os-text-secondary mb-4">
                {calendars.length === 0 ? 'Press Sync All to list your Google calendars' : 'Select a calendar from the sidebar to view events'}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-os-background" data-testid="calendar-connect-state" data-state={connectionState}>
            <CalendarConnectState state={connectionState} onConnect={handleAuthenticate} connecting={connecting} />
          </div>
        )}
      </div>

      {/* Calendar Event Modal */}
      {showEventModal && (
        <CalendarEventModal
          isOpen={showEventModal}
          onClose={() => {
            setShowEventModal(false);
            setEventModalData(null);
          }}
          mode={eventModalMode}
          eventId={eventModalData?.eventId}
          initialData={{
            calendarId: eventModalData?.calendarId,
            ...eventModalData?.initialData
          }}
          onEventCreated={handleEventCreated}
          onEventUpdated={handleEventUpdated}
        />
      )}

      {/* Add Calendar Modal */}
      {showAddCalendarModal && (
        <AddCalendarModal
          isOpen={showAddCalendarModal}
          onClose={() => setShowAddCalendarModal(false)}
          onCalendarAdded={(newCalendar) => {
            handleCalendarAdded(newCalendar);
            setShowAddCalendarModal(false);
          }}
        />
      )}

      {/* Event Template Modal */}
      {showTemplateModal && (
        <EventTemplateModal
          isOpen={showTemplateModal}
          onClose={() => {
            setShowTemplateModal(false);
            setEditingTemplate(null);
          }}
          template={editingTemplate}
          onTemplateSaved={handleTemplateSaved}
        />
      )}

      {/* Event Details Modal */}
      {showEventDetailsModal && eventDetailsData && (
        <EventDetailsModal
          isOpen={showEventDetailsModal}
          onClose={() => {
            setShowEventDetailsModal(false);
            setEventDetailsData(null);
          }}
          eventId={eventDetailsData.eventId}
          calendarId={eventDetailsData.calendarId}
          onEdit={(eventId, calendarId) => {
            setShowEventDetailsModal(false);
            setEventDetailsData(null);
            setEventModalMode('edit');
            setEventModalData({ eventId, calendarId });
            setShowEventModal(true);
          }}
          onDelete={(eventId, calendarId) => {
            setShowEventDetailsModal(false);
            const event = activeEvents.find(e => e.eventId === eventId && e.calendarId === calendarId);
            setEventToDelete({ eventId, calendarId, summary: event?.summary || 'this event' });
            setShowEventDeleteConfirmation(true);
          }}
        />
      )}

      {/* Context Menu - Calendar */}
      {contextMenu.visible && contextMenu.type === 'calendar' && (
        <div
          ref={contextMenuRef}
          className="fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px]"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          <button
            onClick={() => {
              const calendar = calendars.find(cal => cal.id === contextMenu.target);
              setCalendarToDelete(calendar);
              setShowDeleteConfirmation(true);
              closeContextMenu();
            }}
            className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="removeFromList" danger />
            Remove from List
          </button>
        </div>
      )}

      {/* Context Menu - Event */}
      {contextMenu.visible && contextMenu.type === 'event' && (
        <div
          ref={contextMenuRef}
          className="fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px]"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          <button
            onClick={() => {
              setEventToDelete({
                eventId: contextMenu.target.eventId,
                calendarId: contextMenu.target.calendarId,
                summary: contextMenu.target.summary || 'this event'
              });
              setShowEventDeleteConfirmation(true);
              closeContextMenu();
            }}
            className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="delete" danger />
            Delete Event
          </button>
        </div>
      )}

      {/* Remove Confirmation Modal */}
      {showDeleteConfirmation && calendarToDelete && (
        <ConfirmationModal
          isOpen={showDeleteConfirmation}
          onClose={() => {
            setShowDeleteConfirmation(false);
            setCalendarToDelete(null);
          }}
          onConfirm={() => {
            handleRemoveCalendar(calendarToDelete.id);
            setShowDeleteConfirmation(false);
            setCalendarToDelete(null);
          }}
          title="Remove Calendar"
          message={`Are you sure you want to remove "${calendarToDelete.summary}" from your calendar list?\n\nThis will stop showing this calendar in your view but will NOT delete the calendar itself.`}
          confirmText="Remove"
          cancelText="Cancel"
          dangerous={true}
        />
      )}

      {/* Event Delete Confirmation Modal */}
      {showEventDeleteConfirmation && eventToDelete && (
        <ConfirmationModal
          isOpen={showEventDeleteConfirmation}
          onClose={() => {
            setShowEventDeleteConfirmation(false);
            setEventToDelete(null);
          }}
          onConfirm={() => {
            handleDeleteEvent(eventToDelete.eventId, eventToDelete.calendarId);
            setShowEventDeleteConfirmation(false);
            setEventToDelete(null);
          }}
          title="Delete Event"
          message={`Are you sure you want to delete "${eventToDelete.summary}"?\n\nThis action cannot be undone.`}
          confirmText="Delete"
          cancelText="Cancel"
          dangerous={true}
        />
      )}

      {/* Template Delete Confirmation Modal */}
      {showTemplateDeleteConfirmation && templateToDelete && (
        <ConfirmationModal
          isOpen={showTemplateDeleteConfirmation}
          onClose={() => {
            setShowTemplateDeleteConfirmation(false);
            setTemplateToDelete(null);
          }}
          onConfirm={confirmDeleteTemplate}
          title="Delete Template"
          message={`Are you sure you want to delete the template "${templateToDelete.name}"?\n\nThis action cannot be undone.`}
          confirmText="Delete"
          cancelText="Cancel"
          dangerous={true}
        />
      )}
    </div>
  );
}
