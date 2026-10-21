import { useRef } from 'react';
import { X } from 'lucide-react';
import useWheelScrollsStrip from '../../../hooks/useWheelScrollsStrip';

/**
 * TabBar - Tab bar for open calendars
 *
 * Similar to Documents page tabs:
 * - Each tab shows: calendar color, calendar name, close button (X)
 * - Active tab highlighted
 * - Click tab to switch active calendar
 * - Right-click tab for context menu
 * - Tabs persist to localStorage
 */
export default function TabBar({
  calendars = [],
  openTabs = [],
  activeTab = null,
  onTabClick,
  onTabClose,
  onTabRightClick
}) {
  const stripRef = useRef(null);
  useWheelScrollsStrip(stripRef, [openTabs.length > 0]); // a plain mouse wheel scrolls the strip sideways

  // Get calendar by ID
  const getCalendar = (calendarId) => {
    return calendars.find(cal => cal.id === calendarId);
  };

  if (openTabs.length === 0) {
    return null;
  }

  return (
    <div ref={stripRef} className="sc-tab-strip bg-os-card border-b border-os-border flex items-center overflow-x-auto shrink-0">
      {openTabs.map(calendarId => {
        const calendar = getCalendar(calendarId);
        if (!calendar) return null;

        const isActive = activeTab === calendarId;

        return (
          <div
            key={calendarId}
            className={`
 group flex items-center gap-2 px-4 py-2 border-r border-os-border border-b-2 transition-colors cursor-pointer
 ${isActive
 ?'bg-os-card text-os-text-primary border-b-os-blue'
 :'bg-os-card-secondary text-os-text-secondary hover:bg-os-card border-b-transparent'
 }
`}
            onClick={() => onTabClick && onTabClick(calendarId)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
              }
            }}
            onMouseUp={(e) => {
              // Middle-click paste (X11 primary selection) is a mouseup default
              // action resolved against the focused element; it can only be
              // suppressed by preventDefault during mouseup dispatch itself.
              if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                onTabClose && onTabClose(calendarId);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onTabRightClick && onTabRightClick(calendarId, e);
            }}
          >
            {/* Calendar name and description */}
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium whitespace-nowrap">
                {calendar.summary || 'Untitled Calendar'}
              </span>
              <span
                className="text-xs text-os-text-muted truncate"
                style={{ maxWidth: '200px', minHeight: '16px' }}
                title={calendar.description || ''}
              >
                {calendar.description || ''}
              </span>
            </div>

            {/* Close button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTabClose && onTabClose(calendarId);
              }}
              className="p-0.5 hover:bg-os-card-secondary rounded-sm opacity-0 group-hover:opacity-100 transition-opacity"
              title="Close tab"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}

      {/* Empty drop zone to fill remaining space */}
      <div className="flex-1" style={{ minHeight: '38px' }} />
    </div>
  );
}
