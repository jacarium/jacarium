import SidebarHeader from '../../common/sidebar/SidebarHeader';
import HamburgerMenu, { HamburgerMenuItem, HamburgerMenuDivider } from '../../common/menus/HamburgerMenu';
import { Calendar } from 'lucide-react';
import { useDropdownMenu } from '../../../hooks/useContextMenu';
import { MENU_ICONS } from '../../common/menus/menuIcons';
import RowMenuButton from '../../mobile/RowMenuButton';

/**
 * CalendarSidebar - Sidebar for calendars page
 *
 * Features:
 * - Google sync status indicator (same as Central Server in Documents)
 * - Calendars list with color indicators, event counts, click/right-click handlers
 * - Hamburger menu, which also holds "Sync active calendar" (disabled and
 *   reading "Syncing..." while a sync runs)
 */
export default function CalendarSidebar({
  calendars = [],
  activeTab = null,
  syncStatus = 'online',
  isSyncing = false,
  onCalendarClick,
  onCalendarRightClick,
  onNewEvent,
  onSyncCalendar,
  onAddCalendar
}) {
  // Hamburger menu
  const {
    isOpen: menuOpen,
    position: menuPosition,
    menuRef,
    openMenu,
    closeMenu
  } = useDropdownMenu();

  // Context menu
  // Get status title for tooltip
  const getStatusTitle = () => {
    if (syncStatus === 'online') return 'Google Calendar synced';
    if (syncStatus === 'offline') return 'Google Calendar sync failed';
    return 'Syncing Google Calendar...';
  };

  return (
    <div className="flex flex-col h-full bg-os-background">
      {/* Header */}
      <SidebarHeader
        title="Calendars"
        icon={Calendar}
        onMenuClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          openMenu(e, {
            x: rect.left,
            y: rect.bottom + 4
          });
        }}
        status={syncStatus}
        statusTitle={getStatusTitle()}
      />

      {/* Calendars List */}
      <div className="flex-1 overflow-y-auto">
        {calendars.length === 0 ? (
          <div className="px-4 py-8 text-center text-os-text-muted text-sm">
            <Calendar size={32} className="mx-auto mb-2 opacity-50" />
            <p>No calendars synced</p>
          </div>
        ) : (
          <div className="py-2">
            {calendars.map(calendar => {
              const isActive = activeTab === calendar.id;

              return (
                <div
                  key={calendar.id}
                  data-drawer-pick="true"
                  className={`px-4 py-3 cursor-pointer hover:bg-os-card-hover transition-colors border-l-4 ${
 isActive ?'bg-os-card-secondary':''
 }`}
                  style={{
                    borderLeftColor: calendar.backgroundColor || '#4285f4'
                  }}
                  onClick={() => onCalendarClick && onCalendarClick(calendar.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onCalendarRightClick && onCalendarRightClick(calendar.id, e);
                  }}
                >
                  <div className="flex items-center gap-2">
                    {/* Calendar icon */}
                    <Calendar size={14} className={`shrink-0 ${
 isActive ?'text-os-blue':'text-os-text-muted'
 }`} />

                    {/* Calendar name */}
                    <span className={`text-sm flex-1 truncate ${
 isActive ?'text-os-blue font-medium':'text-os-text-primary'
 }`}>
                      {calendar.summary || 'Untitled Calendar'}
                    </span>
                    {onCalendarRightClick && (
                      <RowMenuButton label={`Actions for ${calendar.summary || 'Untitled Calendar'}`} onOpen={(e) => onCalendarRightClick(calendar.id, e)} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Hamburger Menu */}
      <HamburgerMenu
        isOpen={menuOpen}
        position={menuPosition}
        onClose={closeMenu}
        ref={menuRef}
      >
        <HamburgerMenuItem
          icon={MENU_ICONS.new}
          label="New Event"
          onClick={() => {
            onNewEvent && onNewEvent();
            closeMenu();
          }}
        />
        <HamburgerMenuItem
          icon={MENU_ICONS.new}
          label="Add Calendar"
          onClick={() => {
            onAddCalendar && onAddCalendar();
            closeMenu();
          }}
        />
        <HamburgerMenuDivider />
        {/* Sync lives in the menu, not the header: no sidebar header carries
            a sync/refresh button any more (the Documents sidebar set the
            pattern); the header keeps only the Google sync status dot. */}
        <HamburgerMenuItem
          icon={MENU_ICONS.syncToCloud}
          label={isSyncing ? 'Syncing…' : 'Sync active calendar'}
          disabled={isSyncing}
          onClick={() => {
            onSyncCalendar && onSyncCalendar();
            closeMenu();
          }}
        />
      </HamburgerMenu>
    </div>
  );
}
