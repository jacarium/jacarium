import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Search, ChevronRight, Menu, Link2 } from 'lucide-react';
import { EmptyState } from '../../ui';
import { MenuItemIcon } from '../../common/menus/MenuItemIcon';

/**
 * EngineTemplateSidebar - Search engine template sidebar
 *
 * Features:
 * - Engine template list with categories
 * - Context menus for templates and categories
 * - Import/Export
 */
export default function EngineTemplateSidebar({
  engineTemplates = [],
  engineCategories = [],
  expandedEngineCategories = [],
  onToggleCategory,
  onEngineTemplateClick,
  onEngineContextMenu,
  onEngineCategoryContextMenu,
  onNewEngine,
  onImport,
  onExport,
  isCollapsed = false,
  onCollapsedChange,
}) {
  const [showEngineMenu, setShowEngineMenu] = useState(false);
  const [engineMenuPosition, setEngineMenuPosition] = useState({ top: 0, right: 0 });
  const engineMenuRef = useRef(null);
  const dropdownMenuRef = useRef(null);

  // Close menu on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (engineMenuRef.current && !engineMenuRef.current.contains(event.target)) {
        setShowEngineMenu(false);
      }
    }
    if (showEngineMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showEngineMenu]);

  function handleMenuClick(e) {
    const rect = e.currentTarget.getBoundingClientRect();

    // Position below the button initially; the layout effect below measures the
    // real rendered menu and flips it above the button only if it overflows.
    setEngineMenuPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right, buttonTop: rect.top });
    setShowEngineMenu(!showEngineMenu);
  }

  // Correct dropdown menu position using the real rendered menu size
  useLayoutEffect(() => {
    if (!showEngineMenu || !dropdownMenuRef.current) return;
    const menuRect = dropdownMenuRef.current.getBoundingClientRect();
    const margin = 10;
    let { top, right } = engineMenuPosition;
    if (menuRect.bottom > window.innerHeight - margin) {
      top = engineMenuPosition.buttonTop - menuRect.height - 4;
    }
    if (menuRect.left < margin) {
      right = window.innerWidth - menuRect.width - margin;
    }
    if (top !== engineMenuPosition.top || right !== engineMenuPosition.right) {
      setEngineMenuPosition((prev) => ({ ...prev, top, right }));
    }
  }, [showEngineMenu, engineMenuPosition]);

  return (
    <div className="flex flex-col h-full overflow-hidden border-t border-os-border bg-os-card">
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-card shrink-0">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => onCollapsedChange?.(!isCollapsed)}
            className="flex items-center gap-2 min-w-0 flex-1 hover:bg-os-card-secondary transition-colors px-2 py-1 rounded-none"
          >
            <ChevronRight size={16} className={`text-os-text-secondary shrink-0 transition-transform ${isCollapsed ?'':'rotate-90'}`} />
            <span className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
              Search
            </span>
          </button>
          <div className="flex items-center gap-1 shrink-0">
            <div className="relative" ref={engineMenuRef}>
              <button
                onClick={handleMenuClick}
                className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
                title="Search menu"
              >
                <Menu size={16} className="text-os-text-secondary" />
              </button>

              {/* Dropdown Menu */}
              {showEngineMenu && (
                <div
                  ref={dropdownMenuRef}
                  className="fixed bg-os-card border border-os-border shadow-lg rounded-lg z-50 py-1.5 min-w-[180px]"
                  style={{
                    top: `${engineMenuPosition.top}px`,
                    right: `${engineMenuPosition.right}px`
                  }}
                >
                  <button
                    onClick={() => {
                      setShowEngineMenu(false);
                      onNewEngine?.();
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="new" />
                    Add New Search Query
                  </button>
                  <div className="border-t border-os-border my-1"></div>
                  <button
                    onClick={() => {
                      setShowEngineMenu(false);
                      onImport?.();
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="import" />
                    Import
                  </button>
                  <button
                    onClick={() => {
                      setShowEngineMenu(false);
                      onExport?.();
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="export" />
                    Export All
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Engine Template List */}
      {!isCollapsed && (
      <div className="py-2 flex-1 overflow-y-auto">
        {engineCategories.length === 0 ? (
          <EmptyState compact icon={Search} title="No search engines yet" description="Create your first search engine" />
        ) : (
          engineCategories.map(cat => {
            const isExpanded = expandedEngineCategories.includes(cat);
            const categoryEngineTemplates = engineTemplates.filter(t => (t.category || 'General') === cat);

            return (
              <div key={cat}>
                <div className="px-2">
                  <div
                    className="w-full px-3 py-2 flex items-center justify-between hover:bg-os-card-secondary transition-colors group"
                    onContextMenu={(e) => onEngineCategoryContextMenu?.(e, cat)}
                  >
                    <button
                      onClick={() => onToggleCategory?.(cat)}
                      className="flex-1 flex items-center justify-between text-left"
                    >
                      <span className="text-sm text-os-text-primary font-medium">{cat}</span>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-os-text-muted">{categoryEngineTemplates.length}</span>
                        <ChevronRight
                          size={14}
                          className={`text-os-text-secondary transition-transform ${
 isExpanded ?'rotate-90':''
 }`}
                        />
                      </div>
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-2">
                    {categoryEngineTemplates.map(template => (
                      <div
                        key={template.id}
                        onClick={() => onEngineTemplateClick?.(template)}
                        onContextMenu={(e) => onEngineContextMenu?.(e, template)}
                        className="px-3 py-2 ml-3 hover:bg-os-card-secondary transition-colors group cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <Link2 size={14} className="text-os-text-muted shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-os-text-primary truncate">
                                {template.name}
                              </div>
                              {template.description && (
                                <div className="text-xs text-os-text-muted truncate mt-0.5">
                                  {template.description}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      )}
    </div>
  );
}
