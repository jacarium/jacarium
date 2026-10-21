import { useState, useEffect, useRef, useContext } from 'react';
import { useMobile, DrawerScopeContext } from '../contexts/MobileContext';
import MobileDrawer from './mobile/MobileDrawer';

/**
 * ResizableSidebar - A reusable sidebar component with mouse-draggable resize functionality
 *
 * In the phone layout (src/utils/mobile.js) the sidebar is not a column at
 * all: it is a drawer over the page (MobileDrawer), opened from the page
 * header, with the same content; a panel mounted inside a ForcedDrawerScope
 * (Team Chat, Notifications from "More") fills the screen instead.
 *
 * @param {object} props
 * @param {React.ReactNode | function} props.children - Sidebar content or render function that receives width
 * @param {number} props.defaultWidth - Initial width in pixels (default: 300)
 * @param {number} props.minWidth - Minimum width in pixels (default: 200)
 * @param {number} props.maxWidth - Maximum width in pixels (default: 600)
 * @param {string} props.storageKey - Unique key for localStorage persistence
 *   (a sidebar on the right keeps its own width under `<storageKey>Right`)
 * @param {'left' | 'right'} props.side - Which side of the window the sidebar
 *   sits on (default: 'left'). A right-hand sidebar is drawn after the page
 *   (flex `order-last`, so its place in the DOM - and React's state - do not
 *   change when a panel moves sides), with the handle on its left edge.
 * @param {'left' | 'right'} props.position - Position of resize handle
 *   (default: the inner edge - 'right' on the left side, 'left' on the right)
 * @param {number|null} props.canvasMinWidth - When given, the page beside the
 *   sidebars never gets narrower than this: a drag stops there, and a sidebar
 *   that opens into too little room gives the difference back. The panels
 *   (AI Chat, Quick Notes, Team Chat) pass 480; a page's own list sidebar
 *   passes nothing (default null) and keeps its plain min / max widths
 * @param {string} props.className - Additional CSS classes for the sidebar
 * @param {string} props.testId - data-testid of the sidebar's column
 */
/**
 * The page beside the sidebars: the width of the row's flex-1 column
 * (JQLBuilder's main canvas) next to `column`; null when there is none or
 * it is not laid out yet (0 in a test DOM: unknown, not "no room").
 */
function pageWidthBeside(column) {
  const row = column?.parentElement;
  const canvas = row ? Array.from(row.children).find((el) => el !== column && el.classList.contains('flex-1')) : null;
  return canvas && canvas.clientWidth > 0 ? canvas.clientWidth : null;
}

export default function ResizableSidebar({
  children,
  defaultWidth = 300,
  minWidth = 200,
  maxWidth = 600,
  storageKey,
  side = 'left',
  position = side === 'right' ? 'left' : 'right',
  canvasMinWidth = null,
  className = '',
  testId
}) {
  // the width is remembered per side: `<storageKey>` on the left, `<storageKey>Right` on the right
  const widthKey = storageKey ? (side === 'right' ? `${storageKey}Right` : storageKey) : null;
  const savedWidth = (key) => {
    if (key) {
      const saved = localStorage.getItem(key);
      if (saved) {
        const parsed = parseInt(saved);
        // Ensure saved value is within constraints
        return Math.min(Math.max(parsed, minWidth), maxWidth);
      }
    }
    return defaultWidth;
  };
  // Load saved width from localStorage or use default
  const [width, setWidth] = useState(() => savedWidth(widthKey));
  const columnRef = useRef(null);
  // moving to the other side: that side's remembered width
  const lastKeyRef = useRef(widthKey);
  useEffect(() => {
    if (lastKeyRef.current === widthKey) return;
    lastKeyRef.current = widthKey;
    setWidth(savedWidth(widthKey)); // the other side's stored width replaces this one's
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthKey]);

  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ width: 0, x: 0 });
  const { isMobile, sidebarOpen, closeSidebar } = useMobile();
  const drawerScope = useContext(DrawerScopeContext);

  // Save width to localStorage when it changes
  useEffect(() => {
    if (widthKey) {
      localStorage.setItem(widthKey, width.toString());
    }
  }, [width, widthKey]);

  // Opening into too little room: give the page its floor back
  useEffect(() => {
    if (canvasMinWidth == null) return;
    const cw = pageWidthBeside(columnRef.current);
    if (cw == null || cw >= canvasMinWidth) return;
    setWidth((w) => Math.max(minWidth, w - (canvasMinWidth - cw))); // measured after layout, once per side
  }, [widthKey, canvasMinWidth, minWidth]);

  // Handle resize drag
  useEffect(() => {
    if (!isResizing) return;

    function handleMouseMove(e) {
      const deltaX = position === 'right'
        ? e.clientX - resizeStartRef.current.x
        : resizeStartRef.current.x - e.clientX;

      const newWidth = resizeStartRef.current.width + deltaX;

      // Constrain width within min/max bounds, and never past the page's floor
      // (the page shrinks by what this sidebar grows)
      const roomForPage = resizeStartRef.current.canvas == null ? Infinity : resizeStartRef.current.width + Math.max(0, resizeStartRef.current.canvas - canvasMinWidth);
      const constrainedWidth = Math.min(Math.max(newWidth, minWidth), maxWidth, roomForPage);
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
  }, [isResizing, minWidth, maxWidth, position, canvasMinWidth]);

  function handleResizeStart(e) {
    setIsResizing(true);
    resizeStartRef.current = {
      width: width,
      x: e.clientX,
      canvas: canvasMinWidth == null ? null : pageWidthBeside(columnRef.current)
    };
  }

  if (isMobile) {
    const forced = !!drawerScope?.forced;
    const drawerWidth = forced ? (typeof window !== 'undefined' ? window.innerWidth : 390) : 324;
    return (
      <MobileDrawer open={forced || sidebarOpen} onClose={forced ? (drawerScope.onBack || (() => {})) : closeSidebar} full={forced}>
        {typeof children === 'function' ? children(drawerWidth) : children}
      </MobileDrawer>
    );
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
        ref={columnRef}
        className={`shrink-0 relative ${side === 'right' ? 'order-last' : ''} ${className}`}
        style={{ width: `${width}px` }}
        data-testid={testId}
        data-side={side}
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
