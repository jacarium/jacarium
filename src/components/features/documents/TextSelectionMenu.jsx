import { forwardRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { MenuItemIcon } from '../../common/menus/MenuItemIcon';

/**
 * TextSelectionMenu - Context menu for selected text
 *
 * Features:
 * - Ask AI About This (opens Quick AI with the selection as context)
 * - Add as AI Context (a new AI Chat with the selection attached, redacted)
 * - Search In (submenu with engine templates)
 */
const TextSelectionMenu = forwardRef(function TextSelectionMenu({
  visible,
  x,
  y,
  onAskAI,
  onAddAsContext,
  onSearchIn,
  engineTemplates = [],
  onClose,
}, ref) {
  const [showSearchSubmenu, setShowSearchSubmenu] = useState(false);

  if (!visible) return null;

  // Group templates by category
  const categorizedTemplates = engineTemplates.reduce((acc, template) => {
    const category = template.category || 'General';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(template);
    return acc;
  }, {});

  const categories = Object.keys(categorizedTemplates).sort();

  return (
    <div
      ref={ref}
      className="fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[200px]"
      style={{ left: `${x}px`, top: `${y}px` }}
    >
      <button
        onClick={onAskAI}
        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
        data-testid="selection-ask-ai"
      >
        <MenuItemIcon action="aiContext" />
        Ask AI About This
      </button>
      {onAddAsContext && (
        <button
          onClick={onAddAsContext}
          className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          data-testid="selection-add-context"
        >
          <MenuItemIcon action="aiContext" />
          Add as AI Context
        </button>
      )}

      {/* Search In with submenu */}
      {engineTemplates.length > 0 && (
        <div
          className="relative"
          onMouseEnter={() => setShowSearchSubmenu(true)}
          onMouseLeave={() => setShowSearchSubmenu(false)}
        >
          <button
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center justify-between gap-2"
          >
            <div className="flex items-center gap-2">
              <MenuItemIcon action="searchIn" />
              Search In
            </div>
            <ChevronRight size={14} className="text-os-text-muted" />
          </button>

          {/* Submenu */}
          {showSearchSubmenu && (
            <div
              className="absolute left-full top-0 -ml-px bg-os-card border border-os-border rounded-sm shadow-lg py-1 min-w-[200px] max-h-[300px] overflow-y-auto"
              style={{ zIndex: 100 }}
              onMouseEnter={() => setShowSearchSubmenu(true)}
              onMouseLeave={() => setShowSearchSubmenu(false)}
            >
              {categories.map(category => (
                <div key={category}>
                  <div className="px-4 py-1 text-xs font-semibold text-os-text-muted uppercase tracking-wide">
                    {category}
                  </div>
                  {categorizedTemplates[category].map(template => (
                    <button
                      key={template.id}
                      onClick={() => {
                        onSearchIn?.(template);
                        setShowSearchSubmenu(false);
                        onClose?.(); // Close the parent menu as well
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary"
                    >
                      {template.name}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default TextSelectionMenu;
