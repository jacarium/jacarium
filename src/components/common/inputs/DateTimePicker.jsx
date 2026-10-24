import { useState, useEffect } from 'react';
import { Calendar, Clock, ChevronLeft, ChevronRight } from 'lucide-react';
import { useDropdownMenu } from '../../../hooks/useContextMenu';

/**
 * DateTimePicker - Custom date and time picker
 *
 * @param {string} value - DateTime value in ISO format
 * @param {function} onChange - Callback when datetime changes
 * @param {string} placeholder - Placeholder text
 * @param {string} className - Additional CSS classes
 * @param {boolean} disabled - Disabled state
 */
export default function DateTimePicker({
  value,
  onChange,
  placeholder = 'Select date and time',
  className = '',
  disabled = false,
  isLive = false,
  onPickerOpen
}) {
  const [viewDate, setViewDate] = useState(new Date());
  const { isOpen, position, menuRef, closeMenu, toggleMenu } = useDropdownMenu();

  // Parse the value prop to a Date object
  const selectedDateTime = value ? new Date(value) : null;

  // Local state for time inputs
  const [hours, setHours] = useState(selectedDateTime ? selectedDateTime.getHours() : 12);
  const [minutes, setMinutes] = useState(selectedDateTime ? selectedDateTime.getMinutes() : 0);
  const [seconds, setSeconds] = useState(selectedDateTime ? selectedDateTime.getSeconds() : 0);
  const [isPM, setIsPM] = useState(selectedDateTime ? selectedDateTime.getHours() >= 12 : false);

  useEffect(() => {
    if (value) {
      const date = new Date(value);
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setViewDate(date);
      setHours(date.getHours());
      setMinutes(date.getMinutes());
      setSeconds(date.getSeconds());
      setIsPM(date.getHours() >= 12);
    }
  }, [value]);

  function formatDateTime(date) {
    if (!date) return '';
    return date.toLocaleString();
  }

  function handleDateSelect(date) {
    // Preserve the time when selecting a new date
    const newDateTime = new Date(date);
    const hour24 = isPM ? (hours === 12 ? 12 : hours + 12) : (hours === 12 ? 0 : hours);
    newDateTime.setHours(hour24, minutes, seconds, 0);
    onChange(newDateTime.toISOString());
  }

  function handleTimeChange() {
    if (!selectedDateTime) {
      // If no date selected, use today
      const newDateTime = new Date();
      const hour24 = isPM ? (hours === 12 ? 12 : hours + 12) : (hours === 12 ? 0 : hours);
      newDateTime.setHours(hour24, minutes, seconds, 0);
      onChange(newDateTime.toISOString());
    } else {
      const newDateTime = new Date(selectedDateTime);
      const hour24 = isPM ? (hours === 12 ? 12 : hours + 12) : (hours === 12 ? 0 : hours);
      newDateTime.setHours(hour24, minutes, seconds, 0);
      onChange(newDateTime.toISOString());
    }
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
      const isSelected = selectedDateTime &&
        date.getFullYear() === selectedDateTime.getFullYear() &&
        date.getMonth() === selectedDateTime.getMonth() &&
        date.getDate() === selectedDateTime.getDate();

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

  function handleTogglePicker(e) {
    if (disabled) return;

    // Notify parent that picker is opening (to stop live updates)
    if (!isOpen && onPickerOpen) {
      onPickerOpen();
    }
    toggleMenu(e, { align: 'left', menuWidth: 340, menuHeight: 480 });
  }

  const display12Hour = hours === 0 ? 12 : (hours > 12 ? hours - 12 : hours);

  return (
    <div className="relative" ref={menuRef}>
      {/* Input */}
      <input
        type="text"
        readOnly
        value={isLive ? 'Live' : (value ? formatDateTime(selectedDateTime) : '')}
        onClick={handleTogglePicker}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
      />

      {/* Picker Dropdown */}
      {isOpen && (
        <div
          className="fixed z-9999 bg-os-card border border-os-border rounded-lg shadow-lg p-3 min-w-[320px]"
          style={{
            top: `${position.top}px`,
            left: `${position.left}px`
          }}
        >
          {/* Calendar Header */}
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
          <div className="grid grid-cols-7 gap-1 mb-3">
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

          {/* Time Picker */}
          <div className="pt-3 border-t border-os-border">
            <div className="flex items-center gap-2 mb-2">
              <Clock size={14} className="text-os-text-secondary" />
              <span className="text-xs font-medium text-os-text-primary">Time</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Hours */}
              <input
                type="number"
                min="1"
                max="12"
                value={display12Hour}
                onChange={(e) => {
                  let val = parseInt(e.target.value) || 1;
                  if (val < 1) val = 1;
                  if (val > 12) val = 12;
                  setHours(val);
                }}
                onBlur={handleTimeChange}
                className="w-16 px-2 py-1.5 text-sm border border-os-border rounded-sm bg-os-modal text-os-text-primary text-center"
              />
              <span className="text-os-text-muted">:</span>
              {/* Minutes */}
              <input
                type="number"
                min="0"
                max="59"
                value={String(minutes).padStart(2, '0')}
                onChange={(e) => {
                  let val = parseInt(e.target.value) || 0;
                  if (val < 0) val = 0;
                  if (val > 59) val = 59;
                  setMinutes(val);
                }}
                onBlur={handleTimeChange}
                className="w-16 px-2 py-1.5 text-sm border border-os-border rounded-sm bg-os-modal text-os-text-primary text-center"
              />
              <span className="text-os-text-muted">:</span>
              {/* Seconds */}
              <input
                type="number"
                min="0"
                max="59"
                value={String(seconds).padStart(2, '0')}
                onChange={(e) => {
                  let val = parseInt(e.target.value) || 0;
                  if (val < 0) val = 0;
                  if (val > 59) val = 59;
                  setSeconds(val);
                }}
                onBlur={handleTimeChange}
                className="w-16 px-2 py-1.5 text-sm border border-os-border rounded-sm bg-os-modal text-os-text-primary text-center"
              />
              {/* AM/PM */}
              <select
                value={isPM ? 'PM' : 'AM'}
                onChange={(e) => {
                  const newIsPM = e.target.value === 'PM';
                  setIsPM(newIsPM);

                  // Immediately apply the change
                  const newDateTime = selectedDateTime ? new Date(selectedDateTime) : new Date();
                  const hour24 = newIsPM ? (hours === 12 ? 12 : hours + 12) : (hours === 12 ? 0 : hours);
                  newDateTime.setHours(hour24, minutes, seconds, 0);
                  onChange(newDateTime.toISOString());
                }}
                className="px-2 py-1.5 text-sm border border-os-border rounded-sm bg-os-modal text-os-text-primary"
              >
                <option value="AM">AM</option>
                <option value="PM">PM</option>
              </select>
            </div>
          </div>

          {/* Action buttons */}
          <div className="mt-3 pt-3 border-t border-os-border flex gap-2">
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                onChange(now.toISOString());
                closeMenu();
              }}
              className="flex-1 px-3 py-1.5 text-xs text-os-text-primary bg-os-card-secondary hover:bg-os-border rounded-sm transition-colors"
            >
              Now
            </button>
            <button
              type="button"
              onClick={closeMenu}
              className="btn btn-quiet flex-1 px-3 py-1.5 text-xs"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
