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
 * MonthView - Month grid calendar view
 *
 * Displays a month grid with:
 * - All-day events section at top of each day cell (conditionally rendered)
 * - Timed events below all-day section
 * - Click handlers for event interaction
 * - Double-click empty cell to create event
 * - Proper dark theme support
 */
export default function MonthView({
  currentDate,
  events = [],
  calendars = [],
  showAllDayEvents = true,
  onEventClick,
  onEventRightClick,
  onEmptySlotDoubleClick
}) {
  // Get calendar color mapping
  const calendarColors = useMemo(() => {
    const colors = {};
    calendars.forEach(cal => {
      colors[cal.id] = cal.backgroundColor || '#4285f4';
    });
    return colors;
  }, [calendars]);

  // Track expanded cells (using date key as identifier)
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

  // Generate month grid
  const monthGrid = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    // First day of month
    const firstDay = new Date(year, month, 1);
    const firstDayOfWeek = firstDay.getDay(); // 0 = Sunday

    // Last day of month
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();

    // Days from previous month
    const prevMonthDays = firstDayOfWeek;
    const prevMonth = new Date(year, month, 0);
    const prevMonthLastDay = prevMonth.getDate();

    // Days from next month to fill grid
    const totalCells = Math.ceil((prevMonthDays + daysInMonth) / 7) * 7;
    const nextMonthDays = totalCells - prevMonthDays - daysInMonth;

    const grid = [];

    // Previous month days
    for (let i = prevMonthLastDay - prevMonthDays + 1; i <= prevMonthLastDay; i++) {
      grid.push({
        day: i,
        month: month - 1,
        year: month === 0 ? year - 1 : year,
        isCurrentMonth: false,
        date: new Date(month === 0 ? year - 1 : year, month === 0 ? 11 : month - 1, i)
      });
    }

    // Current month days
    for (let i = 1; i <= daysInMonth; i++) {
      grid.push({
        day: i,
        month,
        year,
        isCurrentMonth: true,
        date: new Date(year, month, i)
      });
    }

    // Next month days
    for (let i = 1; i <= nextMonthDays; i++) {
      grid.push({
        day: i,
        month: month + 1,
        year: month === 11 ? year + 1 : year,
        isCurrentMonth: false,
        date: new Date(month === 11 ? year + 1 : year, month === 11 ? 0 : month + 1, i)
      });
    }

    return grid;
  }, [currentDate]);

  // Group events by date
  const eventsByDate = useMemo(() => {
    const grouped = {};

    events.forEach(event => {
      const startDate = new Date(event.startDateTime);
      const dateKey = `${startDate.getFullYear()}-${startDate.getMonth()}-${startDate.getDate()}`;

      if (!grouped[dateKey]) {
        grouped[dateKey] = {
          allDay: [],
          timed: []
        };
      }

      if (event.isAllDay) {
        grouped[dateKey].allDay.push(event);
      } else {
        grouped[dateKey].timed.push(event);
      }
    });

    return grouped;
  }, [events]);

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

  // Render event item
  const renderEvent = (event) => {
    const color = calendarColors[event.calendarId] || '#4285f4';
    const textColor = isLightColor(color) ? '#000000' : '#ffffff';
    const startDate = new Date(event.startDateTime);
    const timeStr = event.isAllDay ? '' : startDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    return (
      <div
        key={event.id}
        className="px-1 py-0.5 mb-0.5 text-xs rounded-sm cursor-pointer hover:opacity-80 transition-opacity overflow-hidden"
        style={{
          backgroundColor: color,
          color: textColor
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
        <div className="truncate">
          {timeStr && <span className="font-semibold">{timeStr}</span>} {event.summary}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-os-background text-os-text-primary">
      {/* Week day headers */}
      <div className="grid grid-cols-7 border-b border-os-border">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
          <div key={day} className="px-2 py-2 text-center text-sm font-semibold text-os-text-secondary border-r border-os-border last:border-r-0">
            {day}
          </div>
        ))}
      </div>

      {/* Month grid */}
      <div className="flex-1 flex flex-col overflow-auto">
        {Array.from({ length: Math.ceil(monthGrid.length / 7) }, (_, rowIndex) => {
          const rowCells = monthGrid.slice(rowIndex * 7, (rowIndex + 1) * 7);

          return (
            <div key={rowIndex} className="flex border-b border-os-border">
              {rowCells.map((cell, cellIndex) => {
                const dayEvents = getEventsForDate(cell.date);
                const isTodayCell = isToday(cell.date);
                const dateKey = `${cell.year}-${cell.month}-${cell.day}`;
                const isExpanded = expandedCells.has(dateKey);

                return (
                  <div
                    key={cellIndex}
                    className={`border-r border-os-border last:border-r-0 p-1 pb-2 flex flex-col ${
 !cell.isCurrentMonth ?'bg-os-card-secondary text-os-text-muted':''
 } ${isTodayCell ?'bg-blue-50 dark:bg-blue-900/20':''}`}
                    style={{ width: 'calc(100% / 7)', minHeight: '100px' }}
                    onDoubleClick={() => {
                      if (cell.isCurrentMonth && onEmptySlotDoubleClick) {
                        onEmptySlotDoubleClick(cell.date);
                      }
                    }}
                  >
                    {/* Day number */}
                    <div className={`text-sm font-medium mb-1 shrink-0 ${isTodayCell ?'text-blue-600 dark:text-blue-400 font-bold':''}`}>
                      {cell.day}
                    </div>

                    {/* All-day events section */}
                    {showAllDayEvents && dayEvents.allDay.length > 0 && (
                      <div className="mb-1 shrink-0">
                        {isExpanded
                          ? dayEvents.allDay.map(event => renderEvent(event))
                          : dayEvents.allDay.slice(0, 2).map(event => renderEvent(event))
                        }
                        {dayEvents.allDay.length > 2 && (
                          <div
                            className="px-1 text-xs text-blue-600 dark:text-blue-400 cursor-pointer hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleCellExpansion(dateKey);
                            }}
                          >
                            {isExpanded ? 'Show less' : `+${dayEvents.allDay.length - 2} more`}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Timed events */}
                    <div className="shrink-0">
                      {isExpanded
                        ? dayEvents.timed.map(event => renderEvent(event))
                        : dayEvents.timed.slice(0, 3).map(event => renderEvent(event))
                      }
                      {dayEvents.timed.length > 3 && (
                        <div
                          className="px-1 text-xs text-blue-600 dark:text-blue-400 cursor-pointer hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCellExpansion(dateKey);
                          }}
                        >
                          {isExpanded ? 'Show less' : `+${dayEvents.timed.length - 3} more`}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
