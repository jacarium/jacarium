import { useState, useEffect, useRef, useContext } from 'react';
import ErrorBoundary from './common/ErrorBoundary';
import { useMobile, DrawerScopeContext } from '../contexts/MobileContext';
import MobileDrawer from './mobile/MobileDrawer';
import { useZenMode, useZenPanel } from './common/ReadingAidsSurface';
import ZenEdgeTab from './common/ZenEdgeTab';
import { useShortcutLabel } from '../shortcuts/useShortcut';
import { createPortal } from 'react-dom';
import ZenSideOverlay from './common/ZenSideOverlay';
import { useZenGoToSlot } from './common/zenGoToSlot';

/** The "Show sidebar / sections" shortcut in zen (the shell raises it): the page's sidebar overlay opens or closes. */
export const ZEN_SHOW_SIDEBAR_EVENT = 'zenShowSidebar';

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
 * The column (and the zen overlays) is a reading area for the reading ruler
 * (data-ra-area): the band follows the pointer over the list and snaps to
 * the row or line under it, clipped to the column; the resize handle is a
 * control (data-ra-control), so it keeps the band where it was.
 * @param {string|null} props.zenLabel - In zen mode (Settings > Accessibility)
 *   a page's sidebar steps aside and leaves the page's main content; this
 *   label names the overlay the pull-out tab at the middle of the left
 *   window edge ("Sidebar" on every page) opens, sliding
 *   in from that edge - a click or the shortcut opens it, never a hover;
 *   Esc, a click outside or a pick closes it - so what the sidebar reaches (a report's sections,
 *   the boards, the lists) stays reachable. Default 'Sidebar'; null for no
 *   tab. The panels (those
 *   with a canvasMinWidth: AI Chat, Quick Notes, Team Chat, Notifications)
 *   hide, and come back through the right-edge pull-out tab (ZenPanelsTab)
 *   as an overlay over the page while zen stays: zenPanelId names this
 *   panel there ('aiChat' | 'draft' | 'chat' | 'notification'), zenPanelLabel
 *   is the overlay's accessible name. Esc or a click outside closes the
 *   overlay; leaving zen closes it too.
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

/**
 * The interface scale (Settings > Accessibility, "Scale the interface too"): the column's stored width is in
 * unscaled px and renders at stored x scale (--ra-chrome-scale on <html>), so the drag converts pointer px into
 * stored px and the page's floor is measured on rendered px. Read from the inline property first (a test sets it
 * there), then from the computed style (the stylesheet sets it in the app).
 */
function chromeScale() {
  if (typeof document === 'undefined') return 1;
  const root = document.documentElement;
  const raw = root.style.getPropertyValue('--ra-chrome-scale') || getComputedStyle(root).getPropertyValue('--ra-chrome-scale');
  const v = parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : 1;
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
  testId,
  zenLabel = 'Sidebar',
  zenPanelId = null,
  overlay = false,
  zenCloseOn
}) {
  // the width is remembered per side: `<storageKey>` on the left, `<storageKey>Right` on the right
  const widthKey = storageKey ? (side === 'right' ? `${storageKey}Right` : storageKey) : null;
  const savedWidth = (key) => {
    if (key) {
      const saved = localStorage.getItem(key);
      if (saved) {
        const parsed = parseFloat(saved);
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
  // zen mode: the sidebar steps aside; a page's sidebar can open as an overlay from its compact button
  const zen = useZenMode();
  const zenPanelShown = useZenPanel();
  // a panel in zen shows inside the "Navigation" overlay when chosen there: its content portals into the overlay's slot
  // (src/components/common/zenGoToSlot.js) at the overlay's width
  const slot = useZenGoToSlot();
  const panelInGoTo = zen && !isMobile && zenPanelId != null && zenPanelShown === zenPanelId;
  const [zenOpen, setZenOpen] = useState(false);
  if (!zen && zenOpen) setZenOpen(false);   // leaving zen closes the overlay for the next time (state adjusted during render)
  const showSidebarHint = useShortcutLabel('reading.showSidebar');
  const isPageSidebar = zen && !isMobile && zenPanelId == null && canvasMinWidth == null && zenLabel != null;
  const zenTabRef = useRef(null);
  // the overlay closes when the page says so (zenCloseOn changes: Documents hands over the open document's id)
  const [closeKey, setCloseKey] = useState(zenCloseOn);
  if (closeKey !== zenCloseOn) { setCloseKey(zenCloseOn); if (zenOpen) setZenOpen(false); }   // state adjusted during render
  useEffect(() => {
    if (!isPageSidebar) return undefined;
    const onShortcut = () => setZenOpen((o) => !o);
    window.addEventListener(ZEN_SHOW_SIDEBAR_EVENT, onShortcut);
    return () => window.removeEventListener(ZEN_SHOW_SIDEBAR_EVENT, onShortcut);
  }, [isPageSidebar]);

  // Save width to localStorage when it changes - not while zen mounts a column only for its overlay (a panel chosen in
  // "Navigation"): zen never writes the stored layout; the overlays themselves (`overlay`) keep their own keys
  useEffect(() => {
    if (widthKey && (overlay || !zen)) {
      localStorage.setItem(widthKey, width.toString());
    }
  }, [width, widthKey, overlay, zen]);

  // Opening into too little room: give the page its floor back
  useEffect(() => {
    if (canvasMinWidth == null) return;
    const cw = pageWidthBeside(columnRef.current);
    if (cw == null || cw >= canvasMinWidth) return;
    setWidth((w) => Math.max(minWidth, w - (canvasMinWidth - cw) / chromeScale())); // measured after layout, once per side; the page's shortfall is in rendered px
  }, [widthKey, canvasMinWidth, minWidth]);

  // Handle resize drag
  useEffect(() => {
    if (!isResizing) return;

    function handleMouseMove(e) {
      const deltaX = position === 'right'
        ? e.clientX - resizeStartRef.current.x
        : resizeStartRef.current.x - e.clientX;

      // the pointer moves in rendered px; the width is stored unscaled, so the handle tracks the pointer at any scale
      const scale = resizeStartRef.current.scale || 1;
      const newWidth = resizeStartRef.current.width + deltaX / scale;

      // Constrain width within min/max bounds, and never past the page's floor
      // (the page shrinks by what this sidebar grows, in rendered px)
      const roomForPage = resizeStartRef.current.canvas == null ? Infinity : resizeStartRef.current.width + Math.max(0, resizeStartRef.current.canvas - canvasMinWidth) / scale;
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
      scale: chromeScale(),
      canvas: canvasMinWidth == null ? null : pageWidthBeside(columnRef.current)
    };
  }

  if (isMobile && !overlay) {
    const forced = !!drawerScope?.forced;
    const drawerWidth = forced ? (typeof window !== 'undefined' ? window.innerWidth : 390) : 324;
    return (
      <MobileDrawer open={forced || sidebarOpen} onClose={forced ? (drawerScope.onBack || (() => {})) : closeSidebar} full={forced}>
        {typeof children === 'function' ? children(drawerWidth) : children}
      </MobileDrawer>
    );
  }

  if (!overlay && zen && !isMobile && zenPanelId != null) {
    // a panel in zen: inside the "Navigation" overlay when chosen there, otherwise nothing - the column waits for zen to end
    if (!panelInGoTo || !slot.el) return null;
    return createPortal(<ErrorBoundary scope="popup" label="This panel">{typeof children === 'function' ? children(slot.width) : children}</ErrorBoundary>, slot.el);
  }
  if (!overlay && zen && !isMobile) {
    if (canvasMinWidth != null || zenLabel == null) return null;
    // the page's sidebar in zen: a left-edge pull-out tab opening it as the shared zen side overlay - resizable from its
    // inner edge with its own remembered width (never the column's), instant; a click on the tab or the shortcut opens
    // it (never a hover), the focus moves in; Esc, an outside click or a pick closes it. A temporary view: the column's
    // state is untouched.
    return (
      <>
        <ZenEdgeTab side="left" label="Show sidebar" chip="Sidebar" hint={showSidebarHint} expanded={zenOpen} haspopup="dialog" controls="zen-sidebar-overlay" onOpen={() => setZenOpen((o) => !o)} testId="zen-sidebar-button" buttonRef={zenTabRef} />
        <ZenSideOverlay side="left" label={zenLabel} open={zenOpen} onClose={(how) => { setZenOpen(false); if (how === 'escape' && zenTabRef.current) zenTabRef.current.focus(); }} storageKey={storageKey ? `${storageKey}.zen` : undefined} defaultWidth={width} minWidth={minWidth} maxWidth={maxWidth} testId="zen-sidebar-overlay" className={className}>
          {children}
        </ZenSideOverlay>
      </>
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
        className={`shrink-0 relative ${side === 'right' ? 'order-last sc-slide-in-right' : 'sc-slide-in-left'} ${className}`}
        style={{ width: `calc(${width}px * var(--ra-chrome-scale, 1))` }}   /* the stored width in px, times the interface scale (Settings > Accessibility) */
        data-width={width}
        data-testid={testId}
        data-side={side}
        data-ra-area
      >
        {/* Sidebar content */}
        {typeof children === 'function' ? children(width) : children}

        {/* Resize handle */}
        <div
          onMouseDown={handleResizeStart}
          onContextMenu={(e) => e.preventDefault()}
          data-ra-control
          className={`absolute top-0 bottom-0 cursor-col-resize hover:border-os-blue transition-colors select-none ${
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
