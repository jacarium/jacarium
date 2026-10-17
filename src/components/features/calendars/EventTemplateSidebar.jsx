import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { BookTemplate, ChevronRight, Menu, Calendar } from 'lucide-react';
import { useContextMenu } from '../../../hooks/useContextMenu';
import { EmptyState } from '../../ui';
import { MenuItemIcon } from '../../common/menus/MenuItemIcon';

/**
 * EventTemplateSidebar - Bottom sidebar for event templates
 *
 * Similar to Documents TemplateSidebar but for calendar event templates
 */
export default function EventTemplateSidebar({
  templates = [],
  onLoadTemplate,
  onCreateTemplate,
  onEditTemplate,
  onDeleteTemplate,
  isCollapsed = false,
  onCollapsedChange
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });
  const menuRef = useRef(null);
  const dropdownMenuRef = useRef(null);

  // Context menu state (shared hook handles clamping, outside-click, and Escape)
  const { contextMenu, contextMenuRef, openContextMenu, closeContextMenu } = useContextMenu();

  // Close menu on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowMenu(false);
      }
    }
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showMenu]);

  function handleMenuClick(e) {
    const rect = e.currentTarget.getBoundingClientRect();

    // Position below the button initially; the layout effect below measures the
    // real rendered menu and flips it above the button only if it overflows.
    setMenuPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right, buttonTop: rect.top });
    setShowMenu(!showMenu);
  }

  // Correct dropdown menu position using the real rendered menu size
  useLayoutEffect(() => {
    if (!showMenu || !dropdownMenuRef.current) return;
    const menuRect = dropdownMenuRef.current.getBoundingClientRect();
    const margin = 10;
    let { top, right } = menuPosition;
    if (menuRect.bottom > window.innerHeight - margin) {
      top = menuPosition.buttonTop - menuRect.height - 4;
    }
    if (menuRect.left < margin) {
      right = window.innerWidth - menuRect.width - margin;
    }
    if (top !== menuPosition.top || right !== menuPosition.right) {
      setMenuPosition((prev) => ({ ...prev, top, right }));
    }
  }, [showMenu, menuPosition]);

  function handleTemplateRightClick(e, template) {
    openContextMenu(e, 'template', template);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden border-t border-os-border bg-os-card">
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-card shrink-0">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => onCollapsedChange?.(!isCollapsed)}
            className="flex items-center gap-2 min-w-0 flex-1 hover:bg-os-card-secondary transition-colors px-2 py-1 rounded-none"
          >
            <ChevronRight
              size={16}
              className={`text-os-text-secondary shrink-0 transition-transform ${isCollapsed ?'':'rotate-90'}`}
            />
            <span className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
              Templates
            </span>
          </button>
          <div className="flex items-center gap-1 shrink-0">
            <div className="relative" ref={menuRef}>
              <button
                onClick={handleMenuClick}
                className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
                title="Template menu"
              >
                <Menu size={16} className="text-os-text-secondary" />
              </button>

              {/* Dropdown Menu */}
              {showMenu && (
                <div
                  ref={dropdownMenuRef}
                  className="fixed bg-os-card border border-os-border shadow-lg rounded-lg z-50 py-1.5 min-w-[180px]"
                  style={{
                    top: `${menuPosition.top}px`,
                    right: `${menuPosition.right}px`
                  }}
                >
                  <button
                    onClick={() => {
                      setShowMenu(false);
                      onCreateTemplate?.();
                    }}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="new" />
                    New Template
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Template List */}
      {!isCollapsed && (
        <div className="py-2 flex-1 overflow-y-auto bg-os-card">
          {templates.length === 0 ? (
            <EmptyState compact icon={BookTemplate} title="No event templates yet" description="Create your first template" />
          ) : (
            <div className="space-y-1">
              {templates.map(template => (
                <div
                  key={template.id}
                  className="px-4 py-2 cursor-pointer hover:bg-os-card-hover transition-colors"
                  onClick={() => onLoadTemplate && onLoadTemplate(template)}
                  onContextMenu={(e) => handleTemplateRightClick(e, template)}
                >
                  <div className="flex items-center gap-2">
                    <Calendar size={14} className="text-os-text-muted shrink-0" />
                    <span className="text-sm text-os-text-primary truncate">
                      {template.name}
                    </span>
                  </div>
                  {template.defaultSummary && (
                    <div className="text-xs text-os-text-muted mt-1 truncate pl-6">
                      {template.defaultSummary}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="sc-context-menu fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px]"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          <button
            onClick={() => {
              const template = contextMenu.target;
              closeContextMenu();
              onEditTemplate && onEditTemplate(template);
            }}
            className="w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary flex items-center gap-2 text-os-text-primary"
          >
            <MenuItemIcon action="edit" />
            Edit Template
          </button>
          <button
            onClick={() => {
              const template = contextMenu.target;
              closeContextMenu();
              onDeleteTemplate && onDeleteTemplate(template);
            }}
            className="w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary flex items-center gap-2 text-red-600 dark:text-red-400"
          >
            <MenuItemIcon action="delete" danger />
            Delete Template
          </button>
        </div>
      )}
    </div>
  );
}
