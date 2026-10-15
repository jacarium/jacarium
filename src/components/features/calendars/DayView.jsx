import { useMemo, useState, useRef } from 'react';

/**
 * Calculate if a hex color is light or dark
 * Returns true if the color is light (needs dark text)
 */
function isLightColor(hexColor) {
  // Remove # if present
  const hex = hexColor.replace('#', '');

  // Convert to RGB
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);

  // Calculate relative luminance (ITU-R BT.709)
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  // Return true if light (luminance > 0.5)
  return luminance > 0.5;
}

/**
 * DayView - Single day timeline calendar view
 *
 * Displays a single day with:
 * - All-day events section at the very top (conditionally rendered)
 * - Hourly slots (scrollable) below all-day section
 * - Timed events positioned in hourly grid (00:00 to 23:00)
 * - Proper dark theme support
 */
export default function DayView({
  currentDate,
  events = [],
  calendars = [],
  showAllDayEvents = true,
  onEventClick,
  onEventRightClick,
  onEmptySlotDoubleClick,
  onDragCreateEvent
}) {
  // Drag-to-create state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartMinute, setDragStartMinute] = useState(null);
  const [dragEndMinute, setDragEndMinute] = useState(null);
  const timelineRef = useRef(null);
  // Get calendar color mapping
  const calendarColors = useMemo(() => {
    const colors = {};
    calendars.forEach(cal => {
      colors[cal.id] = cal.backgroundColor || '#4285f4';
    });
    return colors;
  }, [calendars]);

  // Group events by type (all-day vs timed)
  // For multi-day events, clip them to the current day's boundaries
  const groupedEvents = useMemo(() => {
    const allDay = [];
    const timed = [];

    const dayStart = new Date(currentDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(currentDate);
    dayEnd.setHours(23, 59, 59, 999);

    events.forEach(event => {
      const eventStart = new Date(event.startDateTime);
      const eventEnd = new Date(event.endDateTime);

      // For all-day events, Google Calendar uses exclusive end dates
      // (e.g., June 1-2 means only June 1st). Subtract 1ms to make it inclusive.
      const eventEndInclusive = event.isAllDay
        ? new Date(event.endDateTime - 1)
        : eventEnd;

      // Check if event overlaps with the current day
      if (eventStart <= dayEnd && eventEndInclusive >= dayStart) {
        // Clip event to this day's boundaries
        const clippedStart = eventStart > dayStart ? eventStart : dayStart;
        const clippedEnd = eventEnd < dayEnd ? eventEnd : dayEnd;

        // Check if the clipped event spans the entire day (or very close to it)
        const clippedStartHour = clippedStart.getHours();
        const clippedStartMinute = clippedStart.getMinutes();
        const clippedEndHour = clippedEnd.getHours();
        const clippedEndMinute = clippedEnd.getMinutes();

        const spansFullDay = (
          (clippedStartHour === 0 && clippedStartMinute === 0) &&
          (clippedEndHour === 23 && clippedEndMinute === 59)
        );

        const clippedEvent = {
          ...event,
          startDateTime: clippedStart.getTime(),
          endDateTime: clippedEnd.getTime(),
          // Treat as all-day if it originally was OR if it spans this full day
          isAllDay: event.isAllDay || spansFullDay
        };

        if (clippedEvent.isAllDay) {
          allDay.push(clippedEvent);
        } else {
          timed.push(clippedEvent);
        }
      }
    });

    return { allDay, timed };
  }, [events, currentDate]);

  // Check if current date is today
  const isTodayView = useMemo(() => {
    const today = new Date();
    return currentDate.getDate() === today.getDate() &&
      currentDate.getMonth() === today.getMonth() &&
      currentDate.getFullYear() === today.getFullYear();
  }, [currentDate]);

  // Hours (0-23)
  const hours = Array.from({ length: 24 }, (_, i) => i);

  // Format hour label
  const formatHour = (hour) => {
    if (hour === 0) return '12 AM';
    if (hour === 12) return '12 PM';
    return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
  };

  // Check if two events overlap
  const eventsOverlap = (event1, event2) => {
    return event1.startDateTime < event2.endDateTime && event1.endDateTime > event2.startDateTime;
  };

  // Calculate layout for overlapping events
  const calculateEventLayout = (events) => {
    if (events.length === 0) return [];

    const sortedEvents = [...events].sort((a, b) => a.startDateTime - b.startDateTime);
    const columns = [];
    const layout = [];

    // Step 1: Assign each event to a column
    sortedEvents.forEach(event => {
      // Find a column where this event doesn't overlap with any event
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const column = columns[i];
        const hasOverlap = column.some(e => eventsOverlap(e, event));
        if (!hasOverlap) {
          column.push(event);
          layout.push({ event, column: i, totalColumns: 0 });
          placed = true;
          break;
        }
      }

      // If no column found, create a new one
      if (!placed) {
        columns.push([event]);
        layout.push({ event, column: columns.length - 1, totalColumns: 0 });
      }
    });

    // Step 2: Calculate totalColumns based on transitive overlap groups
    // Build overlap groups (events that share column space)
    const overlapGroups = [];
    const eventToGroup = new Map();

    layout.forEach(item => {
      // Find all events that directly overlap with this one
      const directOverlaps = sortedEvents.filter(e => eventsOverlap(item.event, e));

      // Find if any of these events are already in a group
      let targetGroup = null;
      directOverlaps.forEach(e => {
        const existingGroup = eventToGroup.get(e.id);
        if (existingGroup) {
          if (!targetGroup) {
            targetGroup = existingGroup;
          } else if (targetGroup !== existingGroup) {
            // Merge groups
            existingGroup.forEach(evt => {
              targetGroup.add(evt);
              eventToGroup.set(evt.id, targetGroup);
            });
          }
        }
      });

      // Add current event to the group
      if (!targetGroup) {
        targetGroup = new Set();
        overlapGroups.push(targetGroup);
      }
      targetGroup.add(item.event);
      eventToGroup.set(item.event.id, targetGroup);
    });

    // Calculate totalColumns for each group
    overlapGroups.forEach(group => {
      let maxColumn = 0;
      group.forEach(event => {
        const eventLayout = layout.find(l => l.event.id === event.id);
        if (eventLayout && eventLayout.column > maxColumn) {
          maxColumn = eventLayout.column;
        }
      });
      const totalColumns = maxColumn + 1;

      // Apply to all events in the group
      group.forEach(event => {
        const eventLayout = layout.find(l => l.event.id === event.id);
        if (eventLayout) {
          eventLayout.totalColumns = totalColumns;
        }
      });
    });

    // Debug logging
    if (layout.some(item => item.totalColumns > 1)) {
      console.log('[DayView] Layout calculation:', layout.map(item => ({
        summary: item.event.summary,
        start: new Date(item.event.startDateTime).toLocaleTimeString(),
        end: new Date(item.event.endDateTime).toLocaleTimeString(),
        column: item.column,
        totalColumns: item.totalColumns
      })));

      // Log the overlap groups
      console.log('[DayView] Overlap groups:', overlapGroups.map(group =>
        Array.from(group).map(e => ({
          summary: e.summary,
          start: new Date(e.startDateTime).toLocaleTimeString(),
          end: new Date(e.endDateTime).toLocaleTimeString()
        }))
      ));
    }

    return layout;
  };

  // Calculate event position, height, width, and left offset
  const getEventStyle = (event, eventLayout) => {
    const startDate = new Date(event.startDateTime);
    const endDate = new Date(event.endDateTime);

    const startHour = startDate.getHours();
    const startMinutes = startDate.getMinutes();
    const endHour = endDate.getHours();
    const endMinutes = endDate.getMinutes();

    // Position from top (in pixels, assuming 60px per hour)
    const top = (startHour * 60) + startMinutes;

    // Duration in minutes
    const durationMinutes = (endHour - startHour) * 60 + (endMinutes - startMinutes);
    const height = Math.max(durationMinutes, 30); // Minimum 30px height

    // Calculate width and left offset for overlapping events
    const widthPercent = eventLayout ? (100 / eventLayout.totalColumns) : 100;
    const leftPercent = eventLayout ? (eventLayout.column * widthPercent) : 0;

    return {
      top: `${top}px`,
      height: `${height}px`,
      width: `${widthPercent}%`,
      left: `${leftPercent}%`
    };
  };

  // Render timed event
  const renderTimedEvent = (event, eventLayout) => {
    const color = calendarColors[event.calendarId] || '#4285f4';
    const textColor = isLightColor(color) ? '#000000' : '#ffffff';
    const style = getEventStyle(event, eventLayout);
    const startDate = new Date(event.startDateTime);
    const endDate = new Date(event.endDateTime);
    const startTimeStr = startDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const endTimeStr = endDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    // Debug logging
    if (eventLayout && eventLayout.totalColumns > 1) {
      console.log('[DayView] Event:', event.summary, 'Column:', eventLayout.column, 'TotalColumns:', eventLayout.totalColumns, 'Style:', style);
    }

    return (
      <div
        key={event.id}
        className="px-2 py-2 text-sm rounded-lg cursor-pointer hover:opacity-80 transition-opacity overflow-hidden shadow-md"
        style={{
          position: 'absolute',
          ...style,
          backgroundColor: color,
          color: textColor,
          zIndex: 10,
          boxSizing: 'border-box'
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onEventClick && onEventClick(event);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEventRightClick && onEventRightClick(event, e);
        }}
        title={`${startTimeStr} - ${endTimeStr}: ${event.summary}`}
      >
        <div className="font-semibold truncate">{event.summary}</div>
        <div className="text-xs opacity-90">{startTimeStr} - {endTimeStr}</div>
        {event.location && (
          <div className="text-xs opacity-80 truncate mt-1">{event.location}</div>
        )}
      </div>
    );
  };

  // Render all-day event
  const renderAllDayEvent = (event) => {
    const color = calendarColors[event.calendarId] || '#4285f4';
    const textColor = isLightColor(color) ? '#000000' : '#ffffff';

    return (
      <div
        key={event.id}
        className="px-3 py-2 mb-2 text-sm rounded-lg cursor-pointer hover:opacity-80 transition-opacity shadow-xs"
        style={{
          backgroundColor: color,
          color: textColor
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onEventClick && onEventClick(event);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEventRightClick && onEventRightClick(event, e);
        }}
        title={event.summary}
      >
        <div className="font-semibold truncate">{event.summary}</div>
        {event.location && (
          <div className="text-xs opacity-80 truncate mt-1">{event.location}</div>
        )}
      </div>
    );
  };

  // Get current time indicator position
  const getCurrentTimePosition = () => {
    if (!isTodayView) return null;

    const now = new Date();
    const hour = now.getHours();
    const minutes = now.getMinutes();
    const top = (hour * 60) + minutes;

    return top;
  };

  const currentTimeTop = getCurrentTimePosition();

  // Calculate layout for overlapping events
  const eventLayouts = calculateEventLayout(groupedEvents.timed);
  const layoutMap = new Map(eventLayouts.map(item => [item.event.id, item]));

  // Convert mouse Y position to minute of day
  const getMinuteFromMouseY = (clientY) => {
    if (!timelineRef.current) return null;

    const rect = timelineRef.current.getBoundingClientRect();
    const y = clientY - rect.top + timelineRef.current.scrollTop;

    // Each pixel = 1 minute (24 hours * 60 minutes = 1440px)
    const minute = Math.floor(y);

    // Snap to 15-minute increments
    const snappedMinute = Math.round(minute / 15) * 15;

    return Math.max(0, Math.min(1440, snappedMinute)); // Clamp to 0-1440
  };

  // Handle drag start
  const handleMouseDown = (e) => {
    if (e.button !== 0) return; // Only left click
    if (!onDragCreateEvent) return;

    const minute = getMinuteFromMouseY(e.clientY);
    if (minute === null) return;

    setIsDragging(true);
    setDragStartMinute(minute);
    setDragEndMinute(minute);

    e.preventDefault();
  };

  // Handle drag move
  const handleMouseMove = (e) => {
    if (!isDragging) return;

    const minute = getMinuteFromMouseY(e.clientY);
    if (minute === null) return;

    setDragEndMinute(minute);
  };

  // Handle drag end
  const handleMouseUp = () => {
    if (!isDragging) return;
    if (dragStartMinute === null || dragEndMinute === null) {
      setIsDragging(false);
      setDragStartMinute(null);
      setDragEndMinute(null);
      return;
    }

    // Calculate start and end times
    const start = Math.min(dragStartMinute, dragEndMinute);
    const end = Math.max(dragStartMinute, dragEndMinute);

    // Create Date objects - normalize to midnight first
    const startDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
    startDate.setHours(Math.floor(start / 60), start % 60, 0, 0);

    let endDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
    endDate.setHours(Math.floor(end / 60), end % 60, 0, 0);

    // Ensure minimum 30 minutes
    if (end - start < 30) {
      endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
    }

    // Call the create event callback
    if (onDragCreateEvent) {
      onDragCreateEvent(startDate, endDate);
    }

    // Reset drag state
    setIsDragging(false);
    setDragStartMinute(null);
    setDragEndMinute(null);
  };

  // Calculate drag preview style
  const getDragPreviewStyle = () => {
    if (!isDragging || dragStartMinute === null || dragEndMinute === null) {
      return null;
    }

    const start = Math.min(dragStartMinute, dragEndMinute);
    const end = Math.max(dragStartMinute, dragEndMinute);
    const height = Math.max(end - start, 30); // Minimum 30 minutes

    return {
      top: `${start}px`,
      height: `${height}px`,
      left: 0,
      right: 0,
      position: 'absolute',
      backgroundColor: 'rgba(66, 133, 244, 0.3)',
      border: '2px solid #4285f4',
      borderRadius: 'var(--radius-xs)',
      pointerEvents: 'none',
      zIndex: 5
    };
  };

  const dragPreviewStyle = getDragPreviewStyle();

  return (
    <div className="h-full flex flex-col bg-os-background text-os-text-primary overflow-hidden">
      {/* Day header */}
      <div className="border-b border-os-border px-6 py-4 bg-os-card">
        <div className="text-sm text-os-text-secondary">
          {currentDate.toLocaleDateString([], { weekday: 'long' })}
        </div>
        <div className={`text-3xl font-bold ${isTodayView ?'text-blue-600 dark:text-blue-400':'text-os-text-primary'}`}>
          {currentDate.getDate()}
        </div>
        <div className="text-sm text-os-text-secondary">
          {currentDate.toLocaleDateString([], { month: 'long', year: 'numeric' })}
        </div>
      </div>

      {/* All-day events section */}
      {showAllDayEvents && groupedEvents.allDay.length > 0 && (
        <div className="border-b border-os-border px-6 py-4 bg-os-card-secondary">
          <div className="text-xs font-semibold text-os-text-secondary uppercase tracking-wide mb-2">
            All-day events
          </div>
          <div>
            {groupedEvents.allDay.map(event => renderAllDayEvent(event))}
          </div>
        </div>
      )}

      {/* Hourly grid */}
      <div
        className="flex-1 overflow-auto"
        ref={timelineRef}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          if (isDragging) {
            handleMouseUp({ clientY: 0 });
          }
        }}
      >
        <div
          className="relative px-6"
          style={{ height: `${24 * 60}px` }}
          onMouseDown={handleMouseDown}
        >
          {/* Hour grid lines and labels */}
          {hours.map(hour => (
            <div
              key={hour}
              className="h-[60px] border-b border-os-border flex"
              onDoubleClick={() => {
                if (onEmptySlotDoubleClick) {
                  const clickedDate = new Date(currentDate);
                  clickedDate.setHours(hour, 0, 0, 0);
                  onEmptySlotDoubleClick(clickedDate);
                }
              }}
            >
              {/* Time label */}
              <div className="w-20 pr-4 text-xs text-os-text-secondary -mt-2">
                {formatHour(hour)}
              </div>

              {/* Event area */}
              <div className="flex-1 relative"></div>
            </div>
          ))}

          {/* Timed events */}
          <div className="absolute top-0 left-24 right-6 bottom-0">
            {groupedEvents.timed.map(event => renderTimedEvent(event, layoutMap.get(event.id)))}

            {/* Drag preview */}
            {dragPreviewStyle && (
              <div style={dragPreviewStyle}>
                <div className="px-2 py-1 text-xs text-blue-600 dark:text-blue-400 font-medium">
                  New Event
                </div>
              </div>
            )}
          </div>

          {/* Current time indicator (red line) */}
          {currentTimeTop !== null && (
            <div
              className="absolute left-0 right-0 flex items-center pointer-events-none z-20"
              style={{ top: `${currentTimeTop}px` }}
            >
              <div className="w-3 h-3 rounded-full bg-red-500"></div>
              <div className="flex-1 h-0.5 bg-red-500"></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
