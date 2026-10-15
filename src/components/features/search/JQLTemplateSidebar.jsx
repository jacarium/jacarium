import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Library, Bookmark, ChevronRight, Menu, Loader, Bug, CheckSquare, ShieldAlert, Lock, FileText, AlertCircle, Zap, Star, Flag, Target, AlertTriangle } from 'lucide-react';
import { EmptyState } from '../../ui';
import { MenuItemIcon } from '../../common/menus/MenuItemIcon';

// Icon mapping for templates
const iconMap = {
  Bug,
  CheckSquare,
  ShieldAlert,
  Lock,
  FileText,
  AlertCircle,
  Zap,
  Star,
  Bookmark,
  Flag,
  Target,
  AlertTriangle,
};

/**
 * JQLTemplateSidebar - JQL template management sidebar
 *
 * Features:
 * - Template list with categories
 * - Context menus for templates and categories
 * - Active template highlighting
 * - Inline category renaming
 * - Jira connection status indicators
 * - Import/Export
 */
export default function JQLTemplateSidebar({
  templates = [],
  categories = [],
  expandedCategories = [],
  onToggleCategory,
  activeTemplateId,
  editingCategory,
  editingCategoryName,
  onEditingCategoryNameChange,
  onEditingCategoryChange,
  onTemplateClick,
  onTemplateContextMenu,
  onCategoryContextMenu,
  onCategoryRename,
  onImport,
  onExport,
  onNewTemplate,
  jiraStatus = 'unknown',
  loadingMetadata = false,
  cooldown = 0,
  width = 288,
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });
  const menuRef = useRef(null);
  const dropdownMenuRef = useRef(null);

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

  function handleCategoryRename() {
    if (editingCategory && editingCategoryName.trim() && editingCategoryName !== editingCategory) {
      onCategoryRename?.(editingCategory, editingCategoryName.trim());
    }
    onEditingCategoryChange?.(null);
    onEditingCategoryNameChange?.('');
  }

  function handleCategoryDoubleClick(category, e) {
    e.stopPropagation();
    onEditingCategoryChange?.(category);
    onEditingCategoryNameChange?.(category);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-os-card">
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-card">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Library size={16} className="text-os-text-secondary shrink-0" />
            {width > 240 && (
              <span className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
                Templates
              </span>
            )}
            {loadingMetadata && (
              <Loader size={12} className="animate-spin text-os-text-muted shrink-0" />
            )}
            {!loadingMetadata && jiraStatus === 'connected' && (
              <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Connected to Jira" />
            )}
            {!loadingMetadata && jiraStatus === 'error' && (
              <div className="w-2 h-2 rounded-full bg-red-500 shrink-0" title="Disconnected from Jira" />
            )}
            {!loadingMetadata && cooldown > 0 && (
              <div className="w-2 h-2 rounded-full bg-yellow-500 shrink-0" title={`Rate limit cooldown: ${cooldown}s`} />
            )}
          </div>
          <div className="relative shrink-0" ref={menuRef}>
            <button
              onClick={handleMenuClick}
              className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
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
                    onNewTemplate?.();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="new" />
                  New Template
                </button>
                <div className="border-t border-os-border my-1"></div>
                <button
                  onClick={() => {
                    setShowMenu(false);
                    onImport?.();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="import" />
                  Import
                </button>
                <button
                  onClick={() => {
                    setShowMenu(false);
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

      {/* Template List */}
      <div className="flex-1 overflow-y-auto">
        {categories.length === 0 ? (
          <EmptyState compact icon={Bookmark} title="No templates yet" description="Save queries to get started" />
        ) : (
          <div className="py-2">
            {categories.map(category => {
              const isExpanded = expandedCategories.includes(category);
              const categoryTemplates = templates.filter(t => t.category === category);

              return (
                <div key={category}>
                  <div className="px-2">
                    <div
                      className="w-full px-3 py-2 flex items-center justify-between hover:bg-os-card-secondary transition-colors group"
                      onContextMenu={(e) => onCategoryContextMenu?.(e, category)}
                    >
                      <button
                        onClick={() => onToggleCategory?.(category)}
                        className="flex-1 flex items-center justify-between text-left"
                      >
                        {editingCategory === category ? (
                          <input
                            type="text"
                            value={editingCategoryName}
                            onChange={(e) => onEditingCategoryNameChange?.(e.target.value)}
                            onBlur={handleCategoryRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleCategoryRename();
                              else if (e.key === 'Escape') {
                                onEditingCategoryChange?.(null);
                                onEditingCategoryNameChange?.('');
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                            className="flex-1 px-2 py-1 text-sm border border-os-blue rounded-sm outline-hidden bg-os-card"
                          />
                        ) : (
                          <span
                            className="text-sm text-os-text-primary font-medium"
                            onDoubleClick={(e) => handleCategoryDoubleClick(category, e)}
                          >
                            {category}
                          </span>
                        )}
                        <ChevronRight
                          size={14}
                          className={`text-os-text-muted transition-transform ${isExpanded ?'rotate-90':''}`}
                        />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div>
                      {categoryTemplates.map(template => {
                        const IconComponent = iconMap[template.icon];
                        const isActive = template.id === activeTemplateId;
                        return (
                          <div
                            key={template.id}
                            onClick={() => onTemplateClick?.(template)}
                            onContextMenu={(e) => onTemplateContextMenu?.(e, template)}
                            className={`group relative px-4 py-3 cursor-pointer transition-colors ${
 isActive
 ?'bg-blue-50 border-l-4 border-os-blue'
 :'hover:bg-os-card-secondary border-l-4 border-transparent'
 }`}
                          >
                            <div className="flex items-start gap-3">
                              {IconComponent && (
                                <IconComponent
                                  size={16}
                                  className={`shrink-0 mt-0.5 ${
 isActive ?'text-os-blue':'text-os-text-muted'
 }`}
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className={`text-sm font-medium truncate ${
 isActive ?'text-os-blue':'text-os-text-primary'
 }`}>
                                  {template.name}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
