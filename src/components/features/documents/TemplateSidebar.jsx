import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { BookTemplate, ChevronRight, Menu, X, CheckSquare } from 'lucide-react';
import { useImportFlow } from '../../../hooks/useImportFlow';
import ImportFlow from '../../common/ImportFlow';
import { EmptyState } from '../../ui';
import { MenuItemIcon } from '../../common/menus/MenuItemIcon';
import RowMenuButton from '../../mobile/RowMenuButton';

export default function TemplateSidebar({
  templates = [],
  categories = [],
  expandedCategories = [],
  onToggleCategory,
  onLoadTemplate,
  onCreateTemplate,
  onImportTemplate,
  onExport,
  selectionMode = false,
  selectedTemplates = [],
  onToggleTemplateSelection,
  onToggleSelectionMode,
  onTemplateContextMenu,
  onCategoryContextMenu,
  isCollapsed = false,
  onCollapsedChange,
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });
  const menuRef = useRef(null);
  const dropdownMenuRef = useRef(null);

  // Import flow hook
  const importFlow = useImportFlow({
    validateFn: (data) => {
      if (!Array.isArray(data)) {
        return 'Invalid format: Expected an array of templates';
      }
      if (data.length === 0) {
        return 'Array is empty: No templates to import';
      }
      const invalidTemplates = [];
      data.forEach((template, index) => {
        if (!template.name && !template.content) {
          invalidTemplates.push(index + 1);
        }
      });
      if (invalidTemplates.length > 0) {
        return `Invalid template structure: Templates at positions ${invalidTemplates.join(', ')} are missing both name and content`;
      }
      return true;
    },
    onImportItem: onImportTemplate,
  });

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

  function handleImport() {
    setShowMenu(false);
    importFlow.startImport();
  }

  function handleExport() {
    setShowMenu(false);
    onExport?.();
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
            <ChevronRight size={16} className={`text-os-text-secondary shrink-0 transition-transform ${isCollapsed ?'':'rotate-90'}`} />
            <span className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide truncate">
              Templates
            </span>
          </button>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onToggleSelectionMode}
              className={`p-1.5 transition-colors ${
 selectionMode
 ?'bg-os-blue text-white hover:bg-os-blue-hover'
 :'hover:bg-os-card-secondary'
 }`}
              title={selectionMode ? 'Exit selection mode' : 'Select multiple'}
            >
              {selectionMode ? <X size={16} /> : <CheckSquare size={16} className="text-os-text-secondary" />}
            </button>
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
                  className="sc-context-menu fixed bg-os-card border border-os-border shadow-lg rounded-lg z-50 py-1.5 min-w-[180px]"
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
                  <div className="border-t border-os-border my-1" />
                  <button
                    onClick={handleImport}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="import" />
                    Import
                  </button>
                  <button
                    onClick={handleExport}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary flex items-center gap-2"
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

      {/* Template List */}
      {!isCollapsed && (
      <div className="py-2 flex-1 overflow-y-auto bg-os-card">
        {categories.length === 0 ? (
          <EmptyState compact icon={BookTemplate} title="No templates yet" description="Create your first template" />
        ) : (
          categories.map(cat => {
            const isExpanded = expandedCategories.includes(cat);
            const categoryTemplates = templates.filter(t => (t.category || 'General') === cat);

            return (
              <div key={cat}>
                {/* Category Header */}
                <div className="px-2">
                  <div
                    className="w-full px-3 py-2 flex items-center justify-between hover:bg-os-card-secondary transition-colors group"
                    onContextMenu={(e) => onCategoryContextMenu?.(e, cat)}
                  >
                    <button
                      onClick={() => onToggleCategory?.(cat)}
                      className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left"
                    >
                      <span className="text-sm text-os-text-primary font-medium truncate">{cat}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-xs text-os-text-muted">{categoryTemplates.length}</span>
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

                {/* Templates */}
                {isExpanded && (
                  <div className="px-2">
                    {categoryTemplates.map(template => {
                      const isSelected = selectedTemplates.includes(template.id);
                      return (
                        <div
                          key={template.id}
                          onClick={() => {
                            if (selectionMode) {
                              onToggleTemplateSelection?.(template.id);
                            } else {
                              onLoadTemplate?.(template);
                            }
                          }}
                          onContextMenu={(e) => onTemplateContextMenu?.(e, template)}
                          className={`px-3 py-2 ml-3 transition-colors group ${
 selectionMode && isSelected
 ?'bg-os-blue/10 border-l-4 border-os-blue'
 : selectionMode
 ?'hover:bg-os-card-secondary border-l-4 border-transparent cursor-pointer'
 :'hover:bg-os-card-secondary cursor-pointer'
 }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            {selectionMode && (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => onToggleTemplateSelection?.(template.id)}
                                className="shrink-0"
                                onClick={(e) => e.stopPropagation()}
                              />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-os-text-primary truncate">
                                {template.name}
                              </div>
                              {template.description && (
                                <div className="text-xs text-os-text-muted truncate mt-0.5">
                                  {template.description}
                                </div>
                              )}
                              <RowMenuButton className="float-right" label={`Actions for ${template.name}`} onOpen={(e) => onTemplateContextMenu?.(e, template)} />
                              {template.tags && template.tags.length > 0 && (
                                <div className="flex items-center gap-1 mt-1 flex-wrap">
                                  {template.tags.map((tag, idx) => (
                                    <span
                                      key={idx}
                                      className="text-xs px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded-sm"
                                    >
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      )}

      {/* Import Flow */}
      <ImportFlow
        isInputOpen={importFlow.showInputModal}
        isProgressOpen={importFlow.showProgressModal}
        onInputClose={importFlow.handleInputClose}
        onProgressClose={importFlow.handleProgressClose}
        onValidated={importFlow.handleInputValidated}
        importData={importFlow.importData}
        title="Import Templates"
        placeholder="Paste your JSON array of templates here..."
        validateFn={importFlow.validateFn}
        onImportItem={importFlow.onImportItem}
        exampleFormat={`[
  {
    "name": "Template Name",
    "content": "Template content...",
    "description": "Description",    // optional
    "category": "Category Name",     // optional
    "tags": ["tag1", "tag2"]         // optional
  },
  ...
]`}
        exampleData={[
          {
            name: 'Example Template 1',
            content: 'This is example template content',
            description: 'An example template',
            category: 'General',
            tags: ['example', 'test']
          },
          {
            name: 'Example Template 2',
            content: 'Another template example',
            description: 'Another example',
            category: 'Examples',
            tags: ['sample']
          }
        ]}
      />
    </div>
  );
}
