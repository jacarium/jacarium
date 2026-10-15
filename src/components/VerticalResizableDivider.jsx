import { useState, useEffect, useRef } from 'react';

/**
 * VerticalResizableDivider - Allows vertical resizing of two sections
 *
 * Usage:
 * <VerticalResizableDivider
 *   defaultTopHeight={60}  // percentage (0-100)
 *   storageKey="my-divider"
 *   topContent={<div>Top Section</div>}
 *   bottomContent={<div>Bottom Section</div>}
 * />
 *
 * By default the drag handle is an invisible 8px strip over the boundary.
 * `handleContent` replaces it with a VISIBLE band rendered at the top of the
 * bottom section (in normal flow, above `bottomContent`); the whole band is
 * the drag handle. Callers that do not pass it keep the invisible strip.
 */
export default function VerticalResizableDivider({
  topContent,
  bottomContent,
  defaultTopHeight = 60, // percentage (0-100)
  minTopHeight = 20, // percentage
  maxTopHeight = 80, // percentage
  storageKey,
  bottomCollapsed = false, // whether bottom section is collapsed
  bottomCollapsedHeight = 61, // height in pixels when collapsed (header height)
  handleContent = null, // optional visible drag band (see above)
  handleClassName = '', // extra classes for that band
}) {
  const [topHeight, setTopHeight] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      return saved ? parseFloat(saved) : defaultTopHeight;
    }
    return defaultTopHeight;
  });

  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef(null);

  // Save to localStorage when height changes
  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, topHeight.toString());
    }
  }, [topHeight, storageKey]);

  // Handle mouse move during drag
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e) => {
      if (!containerRef.current) return;

      const containerRect = containerRef.current.getBoundingClientRect();
      const containerHeight = containerRect.height;
      const mouseY = e.clientY - containerRect.top;

      // Calculate new height as percentage
      const newHeightPercent = (mouseY / containerHeight) * 100;

      // Clamp between min and max
      const clampedHeight = Math.min(Math.max(newHeightPercent, minTopHeight), maxTopHeight);

      setTopHeight(clampedHeight);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, minTopHeight, maxTopHeight]);

  const handleMouseDown = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-os-card">
      {/* Top Section */}
      <div
        className={`overflow-hidden flex flex-col shrink-0 relative ${!isDragging ?'transition-all duration-300':''}`}
        style={{ height: bottomCollapsed ? `calc(100% - ${bottomCollapsedHeight}px)` : `${topHeight}%` }}
      >
        {topContent}
        {/* Draggable border area - positioned at the bottom of top section */}
        {!bottomCollapsed && !handleContent && (
        <div
          onMouseDown={handleMouseDown}
          className="absolute inset-x-0 cursor-row-resize select-none"
          style={{ height: '8px', bottom: '-4px', zIndex: 10, background: 'transparent', border: 'none', pointerEvents: 'auto' }}
          title="Drag to resize"
        />
        )}
      </div>

      {/* Bottom Section */}
      <div
        className={`overflow-hidden flex flex-col shrink-0 ${!isDragging ?'transition-all duration-300':''}`}
        style={{ height: bottomCollapsed ? `${bottomCollapsedHeight}px` : `${100 - topHeight}%` }}
      >
        {handleContent && (
          <div
            onMouseDown={bottomCollapsed ? undefined : handleMouseDown}
            className={`shrink-0 select-none ${bottomCollapsed ?'':'cursor-row-resize'} ${handleClassName}`}
            title={bottomCollapsed ? undefined : 'Drag to resize'}
            data-resize-handle="band"
          >
            {handleContent}
          </div>
        )}
        {bottomContent}
      </div>
    </div>
  );
}
