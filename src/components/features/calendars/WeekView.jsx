import { useMemo, useState } from 'react';

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
 * WeekView - Week timeline calendar view
 *
 * Displays a week with:
 * - All-day events section at the very top (conditionally rendered)
 * - 7 columns (days) with hourly rows below all-day section
 * - Time slot rendering (00:00 to 23:00)
 * - Timed events positioned in hourly grid
 * - Proper dark theme support
 */
export default function WeekView({
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
  const [dragDayIndex, setDragDayIndex] = useState(null);
  // Get calendar color mapping
  const calendarColors = useMemo(() => {
    const colors = {};
    calendars.forEach(cal => {
      colors[cal.id] = cal.backgroundColor || '#4285f4';
    });
    return colors;
  }, [calendars]);

  // Track expanded day cells (using date key as identifier)
  const [expandedCells, setExpandedCells] = useState(new Set());

  // Toggle cell expansion
  const toggleCellExpansion = (dateKey) => {
    setExpandedCells(prev => {
      const newSet = new Set(prev);
      if (newSet.has(dateKey)) {
        newSet.delete(dateKey);
      } else {
        newSet.add(dateKey);
      }
      return newSet;
    });
  };

  // Generate week days
  const weekDays = useMemo(() => {
    const days = [];
    const startOfWeek = new Date(currentDate);
    startOfWeek.setDate(currentDate.getDate() - currentDate.getDay()); // Start on Sunday

    for (let i = 0; i < 7; i++) {
      const day = new Date(startOfWeek);
      day.setDate(startOfWeek.getDate() + i);
      days.push(day);
    }

    return days;
  }, [currentDate]);

  // Group events by date and type (all-day vs timed)
  // For multi-day events, clip them to each day's boundaries
  const eventsByDate = useMemo(() => {
    const grouped = {};

    weekDays.forEach(day => {
      const dateKey = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
      grouped[dateKey] = {
        allDay: [],
        timed: []
      };
    });

    events.forEach(event => {
      const eventStart = new Date(event.startDateTime);
      const eventEnd = new Date(event.endDateTime);

      // For all-day events, Google Calendar uses exclusive end dates
      // (e.g., June 1-2 means only June 1st). Subtract 1ms to make it inclusive.
      const eventEndInclusive = event.isAllDay
        ? new Date(event.endDateTime - 1)
        : eventEnd;

      // Check each day in the week to see if this event falls on it
      weekDays.forEach(day => {
        const dayStart = new Date(day);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(day);
        dayEnd.setHours(23, 59, 59, 999);

        // Check if event overlaps with this day
        if (eventStart <= dayEnd && eventEndInclusive >= dayStart) {
          const dateKey = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;

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
            grouped[dateKey].allDay.push(clippedEvent);
          } else {
            grouped[dateKey].timed.push(clippedEvent);
          }
        }
      });
    });

    return grouped;
  }, [events, weekDays]);

  // Get events for a specific date
  const getEventsForDate = (date) => {
    const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    return eventsByDate[dateKey] || { allDay: [], timed: [] };
  };

  // Check if date is today
  const isToday = (date) => {
    const today = new Date();
    return date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear();
  };

  // Hours (0-23)
  const hours = Array.from({ length: 24 }, (_, i) => i);

  // Format hour label
  const formatHour = (hour) => {
    if (hour === 0) return '12 AM';
    if (hour === 12) return '12 PM';
    return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
  };

  // Get current time indicator position
  const getCurrentTimePosition = () => {
    const now = new Date();
    const hour = now.getHours();
    const minutes = now.getMinutes();
    const top = (hour * 60) + minutes;
    return top;
  };

  const currentTimeTop = getCurrentTimePosition();

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
      console.log('[WeekView] Layout calculation:', layout.map(item => ({
        summary: item.event.summary,
        start: new Date(item.event.startDateTime).toLocaleTimeString(),
        end: new Date(item.event.endDateTime).toLocaleTimeString(),
        column: item.column,
        totalColumns: item.totalColumns
      })));

      // Log the overlap groups
      console.log('[WeekView] Overlap groups:', overlapGroups.map(group =>
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
  const renderTimedEvent = (event, dayIndex, eventLayout) => {
    const color = calendarColors[event.calendarId] || '#4285f4';
    const textColor = isLightColor(color) ? '#000000' : '#ffffff';
    const style = getEventStyle(event, eventLayout);
    const startDate = new Date(event.startDateTime);
    const timeStr = startDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    // Debug logging
    if (eventLayout && eventLayout.totalColumns > 1) {
      console.log('[WeekView] Event:', event.summary, 'Column:', eventLayout.column, 'TotalColumns:', eventLayout.totalColumns, 'Style:', style);
    }

    return (
      <div
        key={event.id}
        className="px-1 py-1 text-xs rounded-sm cursor-pointer hover:opacity-80 transition-opacity overflow-hidden"
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
        title={`${timeStr} ${event.summary}`}
      >
        <div className="font-semibold truncate">{timeStr}</div>
        <div className="truncate">{event.summary}</div>
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
        className="px-2 py-1 mb-1 text-xs rounded-sm truncate cursor-pointer hover:opacity-80 transition-opacity"
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
        {event.summary}
      </div>
    );
  };

  // Drag-to-create handlers
  const handleMouseDown = (e, dayIndex) => {
    if (e.button !== 0) return; // Only left click
    if (!onDragCreateEvent) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const minute = Math.round(y / 15) * 15; // Snap to 15-minute increments

    setIsDragging(true);
    setDragStartMinute(minute);
    setDragEndMinute(minute);
    setDragDayIndex(dayIndex);

    e.preventDefault();
  };

  const handleMouseMove = (e, dayIndex) => {
    if (!isDragging || dragDayIndex !== dayIndex) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const minute = Math.round(y / 15) * 15; // Snap to 15-minute increments

    setDragEndMinute(Math.max(0, Math.min(1440, minute)));
  };

  const handleMouseUp = (dayIndex) => {
    if (!isDragging || dragDayIndex !== dayIndex) return;
    if (dragStartMinute === null || dragEndMinute === null) {
      resetDrag();
      return;
    }

    // Calculate start and end times
    const start = Math.min(dragStartMinute, dragEndMinute);
    const end = Math.max(dragStartMinute, dragEndMinute);

    // Create Date objects - normalize to midnight first
    const day = weekDays[dayIndex];
    const startDate = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    startDate.setHours(Math.floor(start / 60), start % 60, 0, 0);

    let endDate = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    endDate.setHours(Math.floor(end / 60), end % 60, 0, 0);

    // Ensure minimum 30 minutes
    if (end - start < 30) {
      endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
    }

    // Call the create event callback
    if (onDragCreateEvent) {
      onDragCreateEvent(startDate, endDate);
    }

    resetDrag();
  };

  const resetDrag = () => {
    setIsDragging(false);
    setDragStartMinute(null);
    setDragEndMinute(null);
    setDragDayIndex(null);
  };

  // Calculate drag preview style
  const getDragPreviewStyle = (dayIndex) => {
    if (!isDragging || dragDayIndex !== dayIndex || dragStartMinute === null || dragEndMinute === null) {
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

  return (
    <div className="h-full flex flex-col bg-os-background text-os-text-primary overflow-hidden">
      {/* All-day events section */}
      {showAllDayEvents && (
        <div className="border-b border-os-border">
          <div className="grid grid-cols-8">
            {/* Time label column */}
            <div className="border-r border-os-border px-2 py-2 text-xs font-semibold text-os-text-secondary">
              All-day
            </div>

            {/* All-day events for each day */}
            {weekDays.map((day, index) => {
              const dayEvents = getEventsForDate(day);
              const isTodayCell = isToday(day);
              const dateKey = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
              const isExpanded = expandedCells.has(dateKey);

              return (
                <div
                  key={index}
                  className={`border-r border-os-border last:border-r-0 px-1 py-1 min-h-[60px] ${
 isTodayCell ?'bg-blue-50 dark:bg-blue-900/20':''
 }`}
                >
                  {isExpanded
                    ? dayEvents.allDay.map(event => renderAllDayEvent(event))
                    : dayEvents.allDay.slice(0, 3).map(event => renderAllDayEvent(event))
                  }
                  {dayEvents.allDay.length > 3 && (
                    <div
                      className="px-2 text-xs text-blue-600 dark:text-blue-400 cursor-pointer hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCellExpansion(dateKey);
                      }}
                    >
                      {isExpanded ? 'Show less' : `+${dayEvents.allDay.length - 3} more`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Week day headers */}
      <div className="grid grid-cols-8 border-b border-os-border sticky top-0 bg-os-background z-20">
        {/* Empty corner */}
        <div className="border-r border-os-border"></div>

        {/* Day headers */}
        {weekDays.map((day, index) => {
          const isTodayCell = isToday(day);
          const dayName = day.toLocaleDateString([], { weekday: 'short' });
          const dayNum = day.getDate();

          return (
            <div
              key={index}
              className={`px-2 py-2 text-center border-r border-os-border last:border-r-0 ${
 isTodayCell ?'bg-blue-50 dark:bg-blue-900/20':''
 }`}
            >
              <div className="text-xs text-os-text-secondary">{dayName}</div>
              <div className={`text-lg font-semibold ${isTodayCell ?'text-blue-600 dark:text-blue-400':'text-os-text-primary'}`}>
                {dayNum}
              </div>
            </div>
          );
        })}
      </div>

      {/* Hourly grid */}
      <div className="flex-1 overflow-auto">
        <div className="relative grid grid-cols-8" style={{ height: `${24 * 60}px` }}>
          {/* Time labels column */}
          <div className="border-r border-os-border">
            {hours.map(hour => (
              <div
                key={hour}
                className="h-[60px] px-2 py-1 text-xs text-os-text-secondary border-b border-os-border"
              >
                {formatHour(hour)}
              </div>
            ))}
          </div>

          {/* Day columns with events */}
          {weekDays.map((day, dayIndex) => {
            const dayEvents = getEventsForDate(day);
            const isTodayCell = isToday(day);

            // Calculate layout for overlapping events
            const eventLayouts = calculateEventLayout(dayEvents.timed);
            const layoutMap = new Map(eventLayouts.map(item => [item.event.id, item]));

            return (
              <div
                key={dayIndex}
                className={`relative border-r border-os-border last:border-r-0 ${
 isTodayCell ?'bg-blue-50 dark:bg-blue-900/20':''
 }`}
                style={{ height: `${24 * 60}px` }}
                onMouseDown={(e) => handleMouseDown(e, dayIndex)}
                onMouseMove={(e) => handleMouseMove(e, dayIndex)}
                onMouseUp={() => handleMouseUp(dayIndex)}
                onMouseLeave={() => {
                  if (isDragging && dragDayIndex === dayIndex) {
                    handleMouseUp(dayIndex);
                  }
                }}
                onDoubleClick={(e) => {
                  if (onEmptySlotDoubleClick) {
                    // Calculate clicked time based on Y position
                    const rect = e.currentTarget.getBoundingClientRect();
                    const y = e.clientY - rect.top;
                    const hour = Math.floor(y / 60);
                    const minutes = Math.floor((y % 60));

                    const clickedDate = new Date(day);
                    clickedDate.setHours(hour, minutes, 0, 0);

                    onEmptySlotDoubleClick(clickedDate);
                  }
                }}
              >
                {/* Hour grid lines */}
                {hours.map(hour => (
                  <div
                    key={hour}
                    className="h-[60px] border-b border-os-border"
                    style={{ position: 'absolute', top: `${hour * 60}px`, left: 0, right: 0 }}
                  />
                ))}

                {/* Timed events */}
                {dayEvents.timed.map(event => renderTimedEvent(event, dayIndex, layoutMap.get(event.id)))}

                {/* Drag preview */}
                {(() => {
                  const previewStyle = getDragPreviewStyle(dayIndex);
                  if (!previewStyle) return null;
                  return (
                    <div style={previewStyle}>
                      <div className="px-2 py-1 text-xs text-blue-600 dark:text-blue-400 font-medium">
                        New Event
                      </div>
                    </div>
                  );
                })()}

                {/* Current time indicator (red line) - only show for today */}
                {isTodayCell && (
                  <div
                    className="absolute left-0 right-0 flex items-center pointer-events-none z-20"
                    style={{ top: `${currentTimeTop}px` }}
                  >
                    <div className="w-2 h-2 rounded-full bg-red-500"></div>
                    <div className="flex-1 h-0.5 bg-red-500"></div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
