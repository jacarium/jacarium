import { useState, useEffect, useRef } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { useDropdownMenu } from '../../../hooks/useContextMenu';

/**
 * DatePicker - Custom theme-aware date picker
 *
 * @param {string} value - Date value in YYYY-MM-DD format
 * @param {function} onChange - Callback when date changes
 * @param {function} onCancel - Callback when calendar is closed without selection
 * @param {string} placeholder - Placeholder text
 * @param {string} className - Additional CSS classes
 * @param {boolean} disabled - Disabled state
 * @param {boolean} autoOpen - Auto-open calendar on mount
 */
export default function DatePicker({ value, onChange, onCancel, placeholder = 'Select date', className = '', disabled = false, autoOpen = false }) {
  const [viewDate, setViewDate] = useState(new Date());
  const buttonRef = useRef(null);
  const { isOpen, position, menuRef, openMenu, closeMenu, toggleMenu } = useDropdownMenu();

  // Parse the value prop to a Date object
  const selectedDate = value ? new Date(value + 'T00:00:00') : null;

  useEffect(() => {
    if (value) {
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setViewDate(new Date(value + 'T00:00:00'));
    }
  }, [value]);

  // Auto-open calendar on mount if autoOpen is true
  useEffect(() => {
    if (autoOpen && buttonRef.current) {
      openMenu({ currentTarget: buttonRef.current }, { align: 'left', menuWidth: 300, menuHeight: 400 });
    }
  }, [autoOpen, openMenu]);

  // useDropdownMenu already closes on outside click / Escape; this only
  // notifies the parent that the calendar was dismissed without a selection.
  useEffect(() => {
    if (!isOpen || !onCancel) return;

    function handleOutsideMouseDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onCancel();
      }
    }

    function handleEscape(e) {
      if (e.key === 'Escape') {
        onCancel();
      }
    }

    document.addEventListener('mousedown', handleOutsideMouseDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onCancel, menuRef]);

  function formatDate(date) {
    if (!date) return '';
    return date.toLocaleDateString();
  }

  function handleDateSelect(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    onChange(dateStr);
    closeMenu();
  }

  function previousMonth() {
    setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
  }

  function nextMonth() {
    setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));
  }

  function renderCalendar() {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();

    // Get first day of month and number of days
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay();

    // Get days from previous month to fill the grid
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    const prevMonthDays = startingDayOfWeek;

    const days = [];

    // Previous month's days
    for (let i = prevMonthDays - 1; i >= 0; i--) {
      const day = prevMonthLastDay - i;
      const date = new Date(year, month - 1, day);
      days.push({
        date,
        isCurrentMonth: false,
        isSelected: false,
        isToday: false
      });
    }

    // Current month's days
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      const isSelected = selectedDate &&
        date.getFullYear() === selectedDate.getFullYear() &&
        date.getMonth() === selectedDate.getMonth() &&
        date.getDate() === selectedDate.getDate();

      const isToday =
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate();

      days.push({
        date,
        isCurrentMonth: true,
        isSelected,
        isToday
      });
    }

    // Next month's days to complete the grid
    const remainingDays = 42 - days.length; // 6 weeks * 7 days
    for (let day = 1; day <= remainingDays; day++) {
      const date = new Date(year, month + 1, day);
      days.push({
        date,
        isCurrentMonth: false,
        isSelected: false,
        isToday: false
      });
    }

    return days;
  }

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function handleToggleCalendar(e) {
    if (disabled) return;
    toggleMenu(e, { align: 'left', menuWidth: 300, menuHeight: 400 });
  }

  return (
    <div className="relative" ref={menuRef}>
      {/* Input */}
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggleCalendar}
        disabled={disabled}
        className={`flex items-center gap-2 ${className}`}
      >
        <Calendar size={12} />
        <span>{value ? formatDate(selectedDate) : placeholder}</span>
      </button>

      {/* Calendar Dropdown */}
      {isOpen && (
        <div
          className="fixed z-9999 bg-os-card border border-os-border rounded-lg shadow-lg p-3 min-w-[280px]"
          style={{
            top: `${position.top}px`,
            left: `${position.left}px`
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <button
              type="button"
              onClick={previousMonth}
              className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
            >
              <ChevronLeft size={16} className="text-os-text-secondary" />
            </button>
            <div className="text-sm font-medium text-os-text-primary">
              {monthNames[viewDate.getMonth()]} {viewDate.getFullYear()}
            </div>
            <button
              type="button"
              onClick={nextMonth}
              className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
            >
              <ChevronRight size={16} className="text-os-text-secondary" />
            </button>
          </div>

          {/* Day names */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {dayNames.map(day => (
              <div key={day} className="text-center text-xs font-medium text-os-text-muted py-1">
                {day}
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="grid grid-cols-7 gap-1">
            {renderCalendar().map((day, index) => (
              <button
                key={index}
                type="button"
                onClick={() => handleDateSelect(day.date)}
                className={`
 p-2 text-xs transition-colors
 ${!day.isCurrentMonth ?'text-os-text-muted opacity-40':'text-os-text-primary'}
 ${day.isSelected
 ?'btn-selected'
 : day.isToday
 ?'bg-os-card-secondary'
 :'hover:bg-os-card-secondary'
 }
`}
              >
                {day.date.getDate()}
              </button>
            ))}
          </div>

          {/* Action buttons */}
          <div className="mt-3 pt-3 border-t border-os-border flex gap-2">
            <button
              type="button"
              onClick={() => handleDateSelect(new Date())}
              className="flex-1 px-3 py-1.5 text-xs text-os-text-primary bg-os-card-secondary hover:bg-os-border rounded-sm transition-colors"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => {
                onChange(null);
                closeMenu();
              }}
              className="btn btn-danger-ghost flex-1 px-3 py-1.5 text-xs"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
