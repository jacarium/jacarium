import { Search, Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * CalendarToolbar - Toolbar above calendar view
 *
 * Left section:
 * - "+ New Event" button
 * - Search bar with filter icon
 * - All-day events toggle (checkbox)
 *
 * Center section:
 * - View mode switcher (Day | Week | Month)
 *
 * Right section:
 * - "Today" button
 * - Date navigation arrows (prev/next)
 * - Current date/range display
 */
export default function CalendarToolbar({
  viewMode = 'month',
  currentDate,
  searchQuery = '',
  showAllDayEvents = true,
  onViewModeChange,
  onSearchChange,
  onShowAllDayEventsToggle,
  onToday,
  onPrevious,
  onNext
}) {
  // Format current date/range display
  const getDateRangeDisplay = () => {
    if (viewMode === 'month') {
      // "May 2026"
      return currentDate.toLocaleDateString([], { month: 'long', year: 'numeric' });
    } else if (viewMode === 'week') {
      // "May 7-13, 2026"
      const startOfWeek = new Date(currentDate);
      startOfWeek.setDate(currentDate.getDate() - currentDate.getDay());
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);

      const startDay = startOfWeek.getDate();
      const endDay = endOfWeek.getDate();
      const month = startOfWeek.toLocaleDateString([], { month: 'long' });
      const year = startOfWeek.getFullYear();

      return `${month} ${startDay}-${endDay}, ${year}`;
    } else {
      // "May 7, 2026"
      return currentDate.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
    }
  };

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-os-card border-b border-os-border">
      {/* Left section */}
      <div className="flex items-center gap-2">
        {/* Search bar */}
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-os-text-muted pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange && onSearchChange(e.target.value)}
            placeholder="Search events..."
            className="pl-7 pr-2 py-1 w-48 border border-os-input-border rounded-sm bg-os-input-bg text-os-text-primary text-xs placeholder:text-os-text-muted focus:outline-hidden focus:border-os-blue focus:ring-1 focus:ring-os-blue"
          />
        </div>

        {/* All-day events toggle */}
        <label className="flex items-center gap-1.5 cursor-pointer select-none ml-1">
          <input
            type="checkbox"
            checked={showAllDayEvents}
            onChange={(e) => onShowAllDayEventsToggle && onShowAllDayEventsToggle(e.target.checked)}
            className="w-3.5 h-3.5 rounded-sm border-os-input-border text-os-blue focus:ring-1 focus:ring-os-blue focus:ring-offset-0 bg-os-input-bg cursor-pointer"
          />
          <span className="text-xs text-os-text-secondary">All-day events</span>
        </label>
      </div>

      {/* Center section: View mode switcher */}
      <div className="flex items-center gap-0 border border-os-border rounded-sm overflow-hidden">
        <button
          onClick={() => onViewModeChange && onViewModeChange('day')}
          className={`px-3 py-1 text-xs transition-colors border-r border-os-border ${
 viewMode ==='day'
 ?'btn-selected'
 :'bg-os-card text-os-text-primary hover:bg-os-card-hover'
 }`}
        >
          Day
        </button>
        <button
          onClick={() => onViewModeChange && onViewModeChange('week')}
          className={`px-3 py-1 text-xs transition-colors border-r border-os-border ${
 viewMode ==='week'
 ?'btn-selected'
 :'bg-os-card text-os-text-primary hover:bg-os-card-hover'
 }`}
        >
          Week
        </button>
        <button
          onClick={() => onViewModeChange && onViewModeChange('month')}
          className={`px-3 py-1 text-xs transition-colors ${
 viewMode ==='month'
 ?'btn-selected'
 :'bg-os-card text-os-text-primary hover:bg-os-card-hover'
 }`}
        >
          Month
        </button>
      </div>

      {/* Right section: Navigation */}
      <div className="flex items-center gap-2">
        {/* Today button */}
        <button
          onClick={onToday}
          className="px-3 py-1 border border-os-border rounded-sm bg-os-card text-os-text-primary text-xs hover:bg-os-card-hover transition-colors"
        >
          Today
        </button>

        {/* Navigation arrows */}
        <div className="flex items-center gap-1">
          <button
            onClick={onPrevious}
            className="p-1 rounded-sm hover:bg-os-card-hover transition-colors"
            title={`Previous ${viewMode}`}
          >
            <ChevronLeft size={16} className="text-os-text-secondary" />
          </button>
          <button
            onClick={onNext}
            className="p-1 rounded-sm hover:bg-os-card-hover transition-colors"
            title={`Next ${viewMode}`}
          >
            <ChevronRight size={16} className="text-os-text-secondary" />
          </button>
        </div>

        {/* Current date/range display */}
        <div className="flex items-center gap-1.5 min-w-[140px]">
          <Calendar size={14} className="text-os-text-muted" />
          <span className="text-xs font-medium text-os-text-primary">
            {getDateRangeDisplay()}
          </span>
        </div>
      </div>
    </div>
  );
}
