import { useState, useEffect, useRef } from 'react';

/**
 * ResizableSidebar - A reusable sidebar component with mouse-draggable resize functionality
 *
 * @param {object} props
 * @param {React.ReactNode | function} props.children - Sidebar content or render function that receives width
 * @param {number} props.defaultWidth - Initial width in pixels (default: 300)
 * @param {number} props.minWidth - Minimum width in pixels (default: 200)
 * @param {number} props.maxWidth - Maximum width in pixels (default: 600)
 * @param {string} props.storageKey - Unique key for localStorage persistence
 * @param {'left' | 'right'} props.position - Position of resize handle (default: 'right')
 * @param {string} props.className - Additional CSS classes for the sidebar
 */
export default function ResizableSidebar({
  children,
  defaultWidth = 300,
  minWidth = 200,
  maxWidth = 600,
  storageKey,
  position = 'right',
  className = ''
}) {
  // Load saved width from localStorage or use default
  const [width, setWidth] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = parseInt(saved);
        // Ensure saved value is within constraints
        return Math.min(Math.max(parsed, minWidth), maxWidth);
      }
    }
    return defaultWidth;
  });

  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ width: 0, x: 0 });

  // Save width to localStorage when it changes
  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, width.toString());
    }
  }, [width, storageKey]);

  // Handle resize drag
  useEffect(() => {
    if (!isResizing) return;

    function handleMouseMove(e) {
      const deltaX = position === 'right'
        ? e.clientX - resizeStartRef.current.x
        : resizeStartRef.current.x - e.clientX;

      const newWidth = resizeStartRef.current.width + deltaX;

      // Constrain width within min/max bounds
      const constrainedWidth = Math.min(Math.max(newWidth, minWidth), maxWidth);
      setWidth(constrainedWidth);
    }

    function handleMouseUp() {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // Set cursor style while resizing
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, minWidth, maxWidth, position]);

  function handleResizeStart(e) {
    setIsResizing(true);
    resizeStartRef.current = {
      width: width,
      x: e.clientX
    };
  }

  return (
    <>
      {/* Backdrop during resize to prevent interference */}
      {isResizing && (
        <div
          className="fixed inset-0"
          style={{
            zIndex: 2147483646,
            cursor: 'col-resize'
          }}
        />
      )}

      <div
        className={`shrink-0 relative ${className}`}
        style={{ width: `${width}px` }}
      >
        {/* Sidebar content */}
        {typeof children === 'function' ? children(width) : children}

        {/* Resize handle */}
        <div
          onMouseDown={handleResizeStart}
          onContextMenu={(e) => e.preventDefault()}
          className={`absolute top-0 bottom-0 cursor-col-resize hover:border-blue-400 transition-colors select-none ${
 position ==='right'?'right-0 border-r':'left-0 border-l'
 } border-os-border`}
          style={{
            zIndex: isResizing ? 2147483647 : 10,
            userSelect: 'none',
            WebkitUserSelect: 'none',
            MozUserSelect: 'none',
            msUserSelect: 'none'
          }}
        />
      </div>
    </>
  );
}
