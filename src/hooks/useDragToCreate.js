import { useState, useCallback, useRef } from 'react';

/**
 * useDragToCreate - Hook for click-and-drag event creation
 *
 * Returns:
 * - isDragging: boolean - whether user is currently dragging
 * - dragStart: object - start position/time
 * - dragEnd: object - current end position/time
 * - handleMouseDown: function - start drag
 * - handleMouseMove: function - update drag
 * - handleMouseUp: function - complete drag
 * - resetDrag: function - cancel drag
 */
export function useDragToCreate(onCreateEvent) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  const dragStartRef = useRef(null);

  const handleMouseDown = useCallback((startTime, startDate) => {
    setIsDragging(true);
    const dragData = { time: startTime, date: startDate };
    setDragStart(dragData);
    setDragEnd(dragData);
    dragStartRef.current = dragData;
  }, []);

  const handleMouseMove = useCallback((endTime, endDate) => {
    if (!isDragging || !dragStartRef.current) return;

    setDragEnd({ time: endTime, date: endDate });
  }, [isDragging]);

  const resetDrag = useCallback(() => {
    setIsDragging(false);
    setDragStart(null);
    setDragEnd(null);
    dragStartRef.current = null;
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!isDragging || !dragStart || !dragEnd) {
      resetDrag();
      return;
    }

    // Calculate start and end times
    let startDateTime = new Date(dragStart.date);
    if (dragStart.time !== undefined) {
      startDateTime.setHours(Math.floor(dragStart.time / 60), dragStart.time % 60, 0, 0);
    }

    let endDateTime = new Date(dragEnd.date);
    if (dragEnd.time !== undefined) {
      endDateTime.setHours(Math.floor(dragEnd.time / 60), dragEnd.time % 60, 0, 0);
    }

    // Ensure end is after start
    if (endDateTime <= startDateTime) {
      // Add minimum 1 hour for timed events, or 1 day for all-day
      if (dragStart.time !== undefined) {
        endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000); // 1 hour
      } else {
        endDateTime = new Date(startDateTime.getTime() + 24 * 60 * 60 * 1000); // 1 day
      }
    }

    // Call the create event callback
    if (onCreateEvent) {
      onCreateEvent(startDateTime, endDateTime);
    }

    resetDrag();
  }, [isDragging, dragStart, dragEnd, onCreateEvent, resetDrag]);

  return {
    isDragging,
    dragStart,
    dragEnd,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    resetDrag
  };
}
