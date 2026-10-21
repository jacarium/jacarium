import { useRef } from 'react';
import { X } from 'lucide-react';
import useWheelScrollsStrip from '../../../hooks/useWheelScrollsStrip';

/**
 * ToolsTabBar - Tab bar for open tools
 *
 * Shows tabs for all open tools with close buttons
 * Matches the exact style of DocumentsPage TabBar
 */
export default function ToolsTabBar({
  tools = [],
  openTabs = [],
  activeTab,
  onTabClick,
  onTabClose,
  onTabContextMenu,
}) {
  const stripRef = useRef(null);
  useWheelScrollsStrip(stripRef); // a plain mouse wheel scrolls the strip sideways

  return (
    <div ref={stripRef} className="sc-tab-strip flex items-center bg-os-card-secondary border-b border-os-border overflow-x-auto">
      {openTabs.map(toolId => {
        const tool = tools.find(t => t.id === toolId);
        if (!tool) return null;

        const isActive = activeTab === toolId;

        return (
          <div
            key={toolId}
            onClick={() => onTabClick(toolId)}
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
                onTabClose(toolId);
              }
            }}
            onContextMenu={(e) => onTabContextMenu && onTabContextMenu(e, toolId)}
            className={`
 group flex items-center gap-2 px-4 py-2 border-r border-os-border border-b-2 transition-colors cursor-pointer
 ${isActive
 ?'bg-os-card text-os-text-primary border-b-os-blue'
 :'bg-os-card-secondary text-os-text-secondary hover:bg-os-card border-b-transparent'
 }
`}
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium whitespace-nowrap">
                {tool.name}
              </span>
              {tool.category && (
                <span className="text-xs text-os-text-muted whitespace-nowrap">
                  {tool.category}
                </span>
              )}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(toolId);
              }}
              className="p-0.5 hover:bg-os-card-secondary rounded-sm opacity-0 group-hover:opacity-100 transition-opacity"
              title="Close tab"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}

      {/* Spacer to fill remaining space */}
      <div className="flex-1 h-full" style={{ minHeight: '38px' }} />
    </div>
  );
}
