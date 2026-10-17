import { ChevronDown, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useMobile } from '../../../contexts/MobileContext';
import MobilePageHeader from '../../mobile/MobilePageHeader';
import { useCloseDrawerOn } from '../../../hooks/useCloseDrawerOn';

/**
 * TabBar - Document tabs component
 *
 * Features:
 * - Multiple open tabs
 * - Active tab highlighting
 * - Close button on each tab
 * - Click to switch tabs
 * - Drag and drop to reorder tabs
 * - Drag tabs between panes
 * - The strip scrolls inside itself (never widens the page) and keeps the
 *   active tab in view; on phones an "N open" menu lists every tab once
 *   the strip overflows (desktop widths keep their previous look)
 * - On phones (max-md) tabs truncate to a fixed width and the close button
 *   is always visible with a 32px touch target
 * - In the phone layout (src/utils/mobile.js) there is no strip at all: the
 *   bar becomes the page header (MobilePageHeader) naming the active tab,
 *   with the "N open" menu in its right slot and the sidebar button on the
 *   left; `pageTitle` is what the header says while nothing is open
 */
export default function TabBar({
  tabs = [],
  activeTabId,
  onTabClick,
  onTabClose,
  onTabReorder,
  onTabDrop,
  onTabContextMenu,
  paneId = 'left',
  className = '',
  pageTitle = '',
}) {
  const { isMobile } = useMobile();
  // choosing another item from the drawer changes the active tab: the drawer closes
  useCloseDrawerOn(activeTabId);
  const [draggedTab, setDraggedTab] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [dragOverEnd, setDragOverEnd] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const stripRef = useRef(null);
  const menuRef = useRef(null);

  // Keep the active tab visible: only the strip scrolls, never the page.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || activeTabId == null) return;
    // CSS.escape is missing in some embedding environments (jsdom); the ids
    // are numbers or UUIDs, so escaping the two attribute delimiters is enough
    const id = String(activeTabId);
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    const tab = strip.querySelector(`[data-tab-id="${escaped}"]`);
    if (!tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < strip.scrollLeft) {
      strip.scrollLeft = left;
    } else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth;
    }
  }, [activeTabId, tabs.length]);

  // The "N open" menu only appears when the tabs do not all fit.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const measure = () => setOverflowing(strip.scrollWidth > strip.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [tabs]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  if (tabs.length === 0) {
    return isMobile ? <MobilePageHeader title={pageTitle} /> : null;
  }

  const handleDragStart = (tab, index, e) => {
    setDraggedTab({ tab, index, paneId });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ tabId: tab.id, fromPane: paneId }));
  };

  const handleDragEnd = () => {
    setDraggedTab(null);
    setDragOverIndex(null);
    setDragOverEnd(false);
  };

  const handleDragOver = (index, e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
    setDragOverEnd(false);
  };

  const handleDragLeave = (e) => {
    // Only clear if we're actually leaving the element, not just moving to a child
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOverIndex(null);
    }
  };

  const handleEndZoneDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverEnd(true);
    setDragOverIndex(null);
  };

  const handleEndZoneDragLeave = (e) => {
    // Only clear if we're actually leaving the element, not just moving to a child
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOverEnd(false);
    }
  };

  const handleEndZoneDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverEnd(false);

    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      const { tabId, fromPane } = data;

      if (fromPane === paneId) {
        // Same pane - reorder to end
        if (onTabReorder) {
          const draggedIndex = tabs.findIndex(t => t.id === tabId);
          if (draggedIndex !== -1 && draggedIndex !== tabs.length - 1) {
            onTabReorder(draggedIndex, tabs.length - 1);
          }
        }
      } else {
        // Different pane - move tab to end
        if (onTabDrop) {
          onTabDrop(tabId, fromPane, tabs.length);
        }
      }
    } catch (error) {
      console.error('Failed to handle tab drop at end:', error);
    }

    setDraggedTab(null);
  };

  const handleDrop = (targetIndex, e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverIndex(null);

    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      const { tabId, fromPane } = data;

      if (fromPane === paneId) {
        // Same pane - reorder
        if (onTabReorder) {
          const draggedIndex = tabs.findIndex(t => t.id === tabId);
          if (draggedIndex !== -1 && draggedIndex !== targetIndex) {
            onTabReorder(draggedIndex, targetIndex);
          }
        }
      } else {
        // Different pane - move tab
        if (onTabDrop) {
          onTabDrop(tabId, fromPane, targetIndex);
        }
      }
    } catch (error) {
      console.error('Failed to handle tab drop:', error);
    }

    setDraggedTab(null);
  };

  const activeEdge = (tab) => (tab.inCloud === true
    ? 'border-l-purple-600'
    : paneId === 'right' ? 'border-l-green-600' : 'border-l-os-blue');

  // The "N open" menu: every tab, the active one marked, each closable.
  // On the desktop it appears beside the strip once the tabs overflow; on a
  // phone it is the header's right slot.
  const openTabsMenu = (
    <div ref={menuRef} className={`relative shrink-0 flex ${isMobile ? '' : 'bg-os-card border-b border-l border-os-border md:hidden'}`}>
      <button
        type="button"
        data-testid="tabs-overflow"
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={isMobile
          ? 'flex items-center gap-1 h-10 px-2 text-[13px] text-os-text-secondary whitespace-nowrap'
          : 'flex items-center gap-1 px-2 min-w-8 min-h-8 text-xs text-os-text-secondary hover:bg-os-card-secondary transition-colors whitespace-nowrap'}
        title="All open documents"
      >
        <span>{tabs.length} open</span>
        <ChevronDown size={14} />
      </button>
      {menuOpen && (
        <div
          role="menu"
          data-testid="tabs-overflow-menu"
          className={`absolute right-0 top-full z-50 mt-px min-w-[220px] max-w-[calc(100vw-16px)] max-h-[60vh] overflow-y-auto bg-os-card border border-os-border shadow-lg py-1 ${isMobile ? 'rounded-none' : 'rounded-sm'}`}
        >
          {tabs.map((tab) => {
            const isActive = activeTabId === tab.id;
            return (
              <div key={tab.id} role="none" className="flex items-stretch">
                <button
                  type="button"
                  role="menuitem"
                  data-testid="tabs-overflow-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onTabClick(tab);
                  }}
                  className={`flex-1 min-w-0 text-left px-3 py-2 hover:bg-os-card-secondary transition-colors border-l-2 ${isMobile ? 'rounded-none' : ''} ${isActive ?`${activeEdge(tab)} text-os-text-primary`:'border-l-transparent text-os-text-secondary'}`}
                >
                  <span className="block text-sm font-medium truncate">{tab.title || 'Untitled'}</span>
                  {tab.category && (
                    <span className="block text-xs text-os-text-muted truncate">{tab.category}</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                  className={`shrink-0 min-w-8 flex items-center justify-center px-2 text-os-text-muted hover:text-os-text-primary hover:bg-os-card-secondary transition-colors ${isMobile ? 'rounded-none' : ''}`}
                  title="Close tab"
                  aria-label={`Close ${tab.title || 'Untitled'}`}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  if (isMobile) {
    const active = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
    return <MobilePageHeader title={active.title || 'Untitled'} subtitle={active.category || pageTitle} right={openTabsMenu} />;
  }

  return (
    <div className={`relative flex shrink-0 min-w-0 ${className}`}>
      <div
        ref={stripRef}
        data-testid="document-tabs"
        className="sc-tab-strip bg-os-card border-b border-os-border flex items-center overflow-x-auto shrink-0 flex-1 min-w-0"
      >
      {tabs.map((tab, index) => {
        const isActive = activeTabId === tab.id;
        const isDragging = draggedTab?.tab.id === tab.id;
        const isDragOver = dragOverIndex === index;
        const isCloudDoc = tab.inCloud === true;

        return (
          <div
            key={tab.id}
            data-testid="document-tab"
            data-tab-id={tab.id}
            data-active={isActive ? 'true' : 'false'}
            draggable
            onDragStart={(e) => handleDragStart(tab, index, e)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(index, e)}
            onDragLeave={(e) => handleDragLeave(e)}
            onDrop={(e) => handleDrop(index, e)}
            onClick={() => onTabClick(tab)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
              }
            }}
            onMouseUp={(e) => {
              // Middle-click paste (X11 primary selection) is a mouseup default
              // action resolved against the focused element; it can only be
              // suppressed by preventDefault during mouseup dispatch itself.
              if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                onTabClose(tab.id);
              }
            }}
            onContextMenu={(e) => onTabContextMenu && onTabContextMenu(e, tab.id, paneId)}
            className={`
 group flex items-center gap-2 px-4 py-2 border-r border-os-border border-b-2 transition-colors cursor-pointer
 max-md:shrink-0 max-md:max-w-[200px] max-md:pl-3 max-md:pr-1 max-md:gap-1
 ${isActive && isCloudDoc
 ?'bg-os-card text-os-text-primary border-b-purple-600'
 : isActive
 ?`bg-os-card text-os-text-primary ${paneId ==='right'?'border-b-green-600':'border-b-os-blue'}`
 :'bg-os-card-secondary text-os-text-secondary hover:bg-os-card border-b-transparent'
 }
 ${isDragging ?'opacity-50':''}
 ${isDragOver ?`border-l-2 ${isCloudDoc ?'border-l-purple-600': paneId ==='right'?'border-l-green-600':'border-l-os-blue'}`:''}
`}
          >
            <div className="flex flex-col gap-0.5 max-md:min-w-0">
              <span className="text-sm font-medium whitespace-nowrap max-md:block max-md:truncate">
                {tab.title || 'Untitled'}
              </span>
              {tab.category && (
                <span className="text-xs text-os-text-muted whitespace-nowrap max-md:block max-md:truncate">
                  {tab.category}
                </span>
              )}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
              }}
              className="p-0.5 hover:bg-os-card-secondary rounded-sm opacity-0 group-hover:opacity-100 transition-opacity max-md:opacity-100 max-md:shrink-0 max-md:min-w-8 max-md:min-h-8 max-md:flex max-md:items-center max-md:justify-center"
              title="Close tab"
              aria-label={`Close ${tab.title || 'Untitled'}`}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}

      {/* Drop zone at the end - extends to fill remaining space */}
      <div
        onDragOver={handleEndZoneDragOver}
        onDragLeave={(e) => handleEndZoneDragLeave(e)}
        onDrop={handleEndZoneDrop}
        className={`
 flex-1 h-full flex items-center justify-center transition-colors
 ${dragOverEnd ? (draggedTab?.tab.inCloud
 ?'bg-purple-50 border-l-2 border-l-purple-600'
 : paneId ==='right'
 ?'bg-green-50 border-l-2 border-l-green-600'
 :'bg-os-blue/10 border-l-2 border-l-os-blue') :''}
`}
        style={{ minHeight: '38px' }}
      />
      </div>

      {overflowing && tabs.length > 1 && openTabsMenu}
    </div>
  );
}
