import { useState, useRef, useEffect } from 'react';
import { Terminal, X, Minus, Maximize2 } from 'lucide-react';
import InteractiveSSHTerminal from './InteractiveSSHTerminal';

const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;
const MINIMIZED_SIZE = { width: 300, height: 40 };
const RESIZE_CURSORS = { e: 'ew-resize', s: 'ns-resize', se: 'nwse-resize' };

/**
 * Draggable, resizable floating window hosting the interactive SSH terminal
 * an SSH node opens mid-execution. Owns its own position/size/minimised state;
 * the parent only supplies the session config and completion callbacks.
 */
export default function FloatingSSHTerminal({ sshConfig, onComplete, onCancel }) {
  const [position, setPosition] = useState({ top: 100, left: 100 });
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [isMinimized, setIsMinimized] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [resizeDirection, setResizeDirection] = useState(null);
  const dragStartRef = useRef({ top: 0, left: 0, x: 0, y: 0 });
  const resizeStartRef = useRef({ width: 0, height: 0, x: 0, y: 0 });

  // Drag handling
  useEffect(() => {
    if (!isDragging) return;

    function handleMouseMove(e) {
      e.preventDefault();
      const { width, height } = isMinimized ? MINIMIZED_SIZE : size;
      const newLeft = dragStartRef.current.left + (e.clientX - dragStartRef.current.x);
      const newTop = dragStartRef.current.top + (e.clientY - dragStartRef.current.y);
      setPosition({
        left: Math.max(0, Math.min(newLeft, window.innerWidth - width)),
        top: Math.max(0, Math.min(newTop, window.innerHeight - height))
      });
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
  }, [isDragging, size, isMinimized]);

  // Resize handling
  useEffect(() => {
    if (!resizeDirection) return;

    function handleMouseMove(e) {
      e.preventDefault();
      const deltaX = e.clientX - resizeStartRef.current.x;
      const deltaY = e.clientY - resizeStartRef.current.y;
      let { width, height } = resizeStartRef.current;

      if (resizeDirection.includes('e')) width = Math.max(MIN_WIDTH, width + deltaX);
      if (resizeDirection.includes('s')) height = Math.max(MIN_HEIGHT, height + deltaY);

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
  }, [resizeDirection]);

  function handleDragStart(e) {
    // Don't drag if clicking on interactive elements
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'A') {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

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
    document.body.style.cursor = RESIZE_CURSORS[direction];
    document.body.style.userSelect = 'none';
  }

  const sessionLabel = `${sshConfig.username}@${sshConfig.host}`;

  return (
    <>
      {/* Minimized bar */}
      {isMinimized && (
        <div
          className="fixed bg-os-card border border-os-border rounded-sm shadow-lg flex items-center gap-2 px-3 py-2 cursor-grab active:cursor-grabbing select-none"
          style={{ top: `${position.top}px`, left: `${position.left}px`, zIndex: 2147483647, pointerEvents: 'auto' }}
          onMouseDown={handleDragStart}
        >
          <Terminal size={14} className="text-os-text-secondary" />
          <span className="text-xs font-medium text-os-text-primary">SSH Terminal</span>
          <span className="text-xs text-os-text-muted">{sessionLabel}</span>
          <div className="flex items-center gap-0.5 ml-2">
            <button
              onClick={() => setIsMinimized(false)}
              className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors text-os-text-secondary"
              title="Maximize"
            >
              <Maximize2 size={12} />
            </button>
            <button
              onClick={onCancel}
              className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors text-os-text-secondary"
              title="Cancel session"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Floating window - kept mounted while minimized so the session survives */}
      <div
        className="fixed bg-os-card border border-os-border rounded-lg shadow-2xl flex-col"
        style={{
          width: `${size.width}px`,
          height: `${size.height}px`,
          top: `${position.top}px`,
          left: `${position.left}px`,
          zIndex: 2147483647,
          pointerEvents: 'auto',
          display: isMinimized ? 'none' : 'flex'
        }}
      >
        {/* Draggable header */}
        <div
          className="px-3 py-2 border-b border-os-border flex items-center justify-between bg-os-card-secondary rounded-t-lg select-none"
          style={{ cursor: 'grab' }}
          onMouseDown={handleDragStart}
        >
          <div className="flex items-center gap-2">
            <Terminal size={16} className="text-os-text-secondary" />
            <span className="text-sm font-medium text-os-text-primary">SSH Terminal</span>
            <span className="text-xs text-os-text-muted">{sessionLabel}</span>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setIsMinimized(true)}
              className="p-1 hover:bg-os-card rounded-sm transition-colors text-os-text-secondary"
              title="Minimize"
            >
              <Minus size={14} />
            </button>
            <button
              onClick={onCancel}
              className="p-1 hover:bg-os-card rounded-sm transition-colors text-os-text-secondary"
              title="Cancel session"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Terminal content */}
        <div className="flex-1 overflow-hidden flex flex-col">
          <InteractiveSSHTerminal
            sshConfig={sshConfig}
            onComplete={onComplete}
            onCancel={onCancel}
            floatingMode={true}
          />
        </div>

        {/* Resize handles */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-ew-resize hover:bg-os-blue/50"
          onMouseDown={(e) => handleResizeStart('e', e)}
          style={{ zIndex: 10 }}
        />
        <div
          className="absolute bottom-0 left-0 w-full h-1 cursor-ns-resize hover:bg-os-blue/50"
          onMouseDown={(e) => handleResizeStart('s', e)}
          style={{ zIndex: 10 }}
        />
        <div
          className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize hover:bg-os-blue"
          onMouseDown={(e) => handleResizeStart('se', e)}
          style={{ zIndex: 11 }}
        />
      </div>
    </>
  );
}
