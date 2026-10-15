import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * FloatingWindow - draggable, resizable, always-on-top window chrome.
 *
 * The same chrome FloatingSSHTerminal / FloatingQuiz hand-roll (header drag
 * handle, east/south/south-east resize handles, os-* theme tokens, the
 * "always on top" z-index tier documented in BaseModal.jsx), factored out
 * so new floating tools (Find in Files) do not add another copy. Non-modal:
 * there is no backdrop, the page behind stays interactive.
 *
 * Position and size are persisted under `storageKey` (localStorage) and
 * clamped to the viewport on mount and on window resize.
 *
 * @param {boolean} open
 * @param {function} onClose - also called on Escape (when `closeOnEscape`)
 * @param {ReactNode} title - header content (text or nodes)
 * @param {ReactNode} icon - lucide icon element for the header
 * @param {ReactNode} headerExtra - nodes placed right of the title
 * @param {string} storageKey - localStorage key for position/size
 * @param {{width:number,height:number}} defaultSize
 * @param {number} minWidth / minHeight
 * @param {boolean} closeOnEscape (default true)
 * @param {number} zIndex (default 2147483647)
 * @param {string} className - extra classes for the window box
 */
export default function FloatingWindow({
  open,
  onClose,
  title,
  icon = null,
  headerExtra = null,
  storageKey,
  defaultSize = { width: 720, height: 520 },
  minWidth = 420,
  minHeight = 300,
  closeOnEscape = true,
  zIndex = 2147483647,
  className = '',
  children,
}) {
  const readSaved = () => {
    if (!storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved.top === 'number' && typeof saved.left === 'number') return saved;
    } catch {
      // ignore unreadable storage
    }
    return null;
  };

  const [size, setSize] = useState(() => {
    const saved = readSaved();
    if (saved?.width && saved?.height) {
      // Saved geometry wins over the default size
      return { width: Math.max(minWidth, saved.width), height: Math.max(minHeight, saved.height) };
    }
    // Default size, clamped so the window never opens larger than the viewport
    const vw = typeof window !== 'undefined' ? window.innerWidth : Infinity;
    const vh = typeof window !== 'undefined' ? window.innerHeight : Infinity;
    return {
      width: Math.max(minWidth, Math.min(defaultSize.width, vw - 32)),
      height: Math.max(minHeight, Math.min(defaultSize.height, vh - 32)),
    };
  });
  const [position, setPosition] = useState(() => {
    const saved = readSaved();
    if (saved) return { top: saved.top, left: saved.left };
    const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const h = typeof window !== 'undefined' ? window.innerHeight : 800;
    return {
      top: Math.max(16, Math.round((h - defaultSize.height) / 3)),
      left: Math.max(16, Math.round((w - defaultSize.width) / 2)),
    };
  });
  const [isDragging, setIsDragging] = useState(false);
  const [resizeDirection, setResizeDirection] = useState(null);
  const dragStartRef = useRef({ top: 0, left: 0, x: 0, y: 0 });
  const resizeStartRef = useRef({ width: 0, height: 0, x: 0, y: 0 });

  const clampToViewport = useCallback((pos, sz) => ({
    left: Math.max(0, Math.min(pos.left, Math.max(0, window.innerWidth - sz.width))),
    top: Math.max(0, Math.min(pos.top, Math.max(0, window.innerHeight - Math.min(sz.height, 80)))),
  }), []);

  // Keep the window reachable when the viewport shrinks
  useEffect(() => {
    if (!open) return undefined;
    const ensureVisible = () => setPosition((pos) => {
      const next = clampToViewport(pos, size);
      return next.left !== pos.left || next.top !== pos.top ? next : pos;
    });
    ensureVisible();
    window.addEventListener('resize', ensureVisible);
    return () => window.removeEventListener('resize', ensureVisible);
  }, [open, size, clampToViewport]);

  // Persist position/size (not while dragging/resizing)
  useEffect(() => {
    if (!storageKey || !open || isDragging || resizeDirection) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ ...position, ...size }));
    } catch {
      // storage unavailable - the window still works
    }
  }, [storageKey, open, position, size, isDragging, resizeDirection]);

  // Drag
  useEffect(() => {
    if (!isDragging) return undefined;
    function handleMouseMove(e) {
      e.preventDefault();
      const next = {
        left: dragStartRef.current.left + (e.clientX - dragStartRef.current.x),
        top: dragStartRef.current.top + (e.clientY - dragStartRef.current.y),
      };
      setPosition(clampToViewport(next, size));
    }
    function handleMouseUp(e) {
      e.preventDefault();
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, size, clampToViewport]);

  // Resize
  useEffect(() => {
    if (!resizeDirection) return undefined;
    function handleMouseMove(e) {
      e.preventDefault();
      const deltaX = e.clientX - resizeStartRef.current.x;
      const deltaY = e.clientY - resizeStartRef.current.y;
      let { width, height } = resizeStartRef.current;
      if (resizeDirection.includes('e')) width = Math.max(minWidth, width + deltaX);
      if (resizeDirection.includes('s')) height = Math.max(minHeight, height + deltaY);
      setSize({ width, height });
    }
    function handleMouseUp(e) {
      e.preventDefault();
      setResizeDirection(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizeDirection, minWidth, minHeight]);

  // Escape closes (only when focus is inside the window or nowhere special)
  useEffect(() => {
    if (!open || !closeOnEscape) return undefined;
    function handleKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose && onClose();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;

  function handleDragStart(e) {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, a, select, textarea')) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = { top: position.top, left: position.left, x: e.clientX, y: e.clientY };
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }

  function handleResizeStart(direction, e) {
    e.preventDefault();
    e.stopPropagation();
    setResizeDirection(direction);
    resizeStartRef.current = { width: size.width, height: size.height, x: e.clientX, y: e.clientY };
    document.body.style.cursor = { e: 'ew-resize', s: 'ns-resize', se: 'nwse-resize' }[direction];
    document.body.style.userSelect = 'none';
  }

  return createPortal(
    <div
      role="dialog"
      aria-label={typeof title === 'string' ? title : undefined}
      data-floating-window={storageKey || true}
      className={`fixed bg-os-card border border-os-border rounded-lg shadow-2xl flex flex-col text-os-text-primary ${className}`}
      style={{
        width: `${size.width}px`,
        height: `${size.height}px`,
        top: `${position.top}px`,
        left: `${position.left}px`,
        maxWidth: '100vw',
        maxHeight: '100vh',
        zIndex,
        pointerEvents: 'auto',
      }}
    >
      {/* Draggable header */}
      <div
        className="px-3 py-2 border-b border-os-border flex items-center justify-between gap-2 bg-os-card-secondary rounded-t-lg select-none cursor-grab active:cursor-grabbing shrink-0"
        onMouseDown={handleDragStart}
        data-floating-window-header="true"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {icon && <span className="text-os-text-secondary shrink-0 flex items-center">{icon}</span>}
          <span className="text-sm font-semibold text-os-text-primary truncate">{title}</span>
          {headerExtra}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 hover:bg-os-card rounded-sm transition-colors text-os-text-secondary shrink-0"
          title="Close"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {children}
      </div>

      {/* Resize handles */}
      <div className="absolute top-0 right-0 w-1 h-full cursor-ew-resize hover:bg-[color-mix(in_srgb,var(--os-blue)_50%,transparent)]" style={{ zIndex: 10 }} onMouseDown={(e) => handleResizeStart('e', e)} />
      <div className="absolute bottom-0 left-0 w-full h-1 cursor-ns-resize hover:bg-[color-mix(in_srgb,var(--os-blue)_50%,transparent)]" style={{ zIndex: 10 }} onMouseDown={(e) => handleResizeStart('s', e)} />
      <div className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize hover:bg-os-blue rounded-br-lg" style={{ zIndex: 11 }} onMouseDown={(e) => handleResizeStart('se', e)} />
    </div>,
    document.body
  );
}
