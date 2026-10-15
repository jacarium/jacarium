import MonthView from './MonthView';
import WeekView from './WeekView';
import DayView from './DayView';

/**
 * CalendarView - Main calendar view wrapper
 *
 * Renders MonthView, WeekView, or DayView based on viewMode.
 * Handles event click/double-click/right-click and passes to parent.
 * Applies search/filter to displayed events.
 */
export default function CalendarView({
  viewMode = 'month',
  currentDate,
  events = [],
  calendars = [],
  searchQuery = '',
  showAllDayEvents = true,
  onEventClick,
  onEventRightClick,
  onEmptySlotDoubleClick,
  onDragCreateEvent
}) {
  // Filter events by search query
  const filteredEvents = searchQuery
    ? events.filter(event => {
        const lowerQuery = searchQuery.toLowerCase();
        return (
          event.summary?.toLowerCase().includes(lowerQuery) ||
          event.description?.toLowerCase().includes(lowerQuery) ||
          event.location?.toLowerCase().includes(lowerQuery) ||
          (event.attendees && event.attendees.some(a => a.email?.toLowerCase().includes(lowerQuery)))
        );
      })
    : events;

  // Render appropriate view based on viewMode
  const renderView = () => {
    const commonProps = {
      currentDate,
      events: filteredEvents,
      calendars,
      showAllDayEvents,
      onEventClick,
      onEventRightClick,
      onEmptySlotDoubleClick,
      onDragCreateEvent
    };

    switch (viewMode) {
      case 'day':
        return <DayView {...commonProps} />;
      case 'week':
        return <WeekView {...commonProps} />;
      case 'month':
      default:
        return <MonthView {...commonProps} />;
    }
  };

  return (
    <div className="flex-1 overflow-hidden">
      {renderView()}
    </div>
  );
}
