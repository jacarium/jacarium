import { forwardRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import ContextMenu, { ContextMenuItem, ContextMenuDivider } from '../../common/menus/ContextMenu';
import { MenuItemIcon } from '../../common/menus/MenuItemIcon';
import { clipboardMenuState, clipboardShortcuts } from '../../../utils/editorClipboard';

/**
 * TextSelectionMenu - the Documents editor's right-click menu, on the shared
 * ContextMenu (keyboard navigation, Escape). The editor keeps the focus
 * while the menu is open (ContextMenu's keepFocus): a textarea's selection
 * is only painted while the textarea is focused, and the user must see what
 * Cut / Copy / Ask AI will act on; the arrow keys reach the menu all the
 * same (the active item is marked and announced through the textarea's
 * aria-activedescendant).
 *
 *   Cut / Copy / Paste, with the platform's shortcuts, enabled as the keys
 *   would be: Cut with a selection in an editable editor, Paste in an
 *   editable editor unless the clipboard is known to be empty
 *   (src/utils/editorClipboard.js). Without a selection the menu is Paste
 *   alone - Cut and Copy are not shown, there is nothing for them to act on
 *   (Cut in a read-only editor with a selection stays, disabled: that is
 *   worth knowing). A read-only editor without a selection still opens the
 *   menu, with its one disabled Paste, so the menu is the same gesture
 *   everywhere and the browser's own menu never takes its place.
 *
 *   With a selection, after a separator: Ask AI About This (opens Quick AI
 *   with the selection as context), Add as AI Context (a new AI Chat with
 *   the selection attached, redacted), Search In (submenu with engine
 *   templates).
 */
const TextSelectionMenu = forwardRef(function TextSelectionMenu({
  visible,
  x,
  y,
  selectedText = '',
  editable = true,
  clipboard = 'unknown',
  mac,
  onCut,
  onCopy,
  onPaste,
  onAskAI,
  onAddAsContext,
  onSearchIn,
  engineTemplates = [],
  onClose,
}, ref) {
  const [showSearchSubmenu, setShowSearchSubmenu] = useState(false);

  if (!visible) return null;

  const hasSelection = !!(selectedText && selectedText.trim());
  const enabled = clipboardMenuState({ hasSelection, editable, clipboard });
  const keys = clipboardShortcuts(mac);

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
    <ContextMenu ref={ref} isVisible={visible} x={x} y={y} zIndex={50} onClose={onClose} label="Editor" testId="editor-context-menu" keepFocus>
      {hasSelection && <ContextMenuItem label="Cut" action="cut" shortcut={keys.cut} disabled={!enabled.cut} onClick={() => onCut?.()} testId="selection-cut" />}
      {hasSelection && <ContextMenuItem label="Copy" action="copy" shortcut={keys.copy} disabled={!enabled.copy} onClick={() => onCopy?.()} testId="selection-copy" />}
      <ContextMenuItem label="Paste" action="paste" shortcut={keys.paste} disabled={!enabled.paste} onClick={() => onPaste?.()} testId="selection-paste" />

      {hasSelection && (
        <>
          <ContextMenuDivider />
          <ContextMenuItem label="Ask AI About This" action="aiContext" onClick={() => onAskAI?.()} testId="selection-ask-ai" />
          {onAddAsContext && (
            <ContextMenuItem label="Add as AI Context" action="aiContext" onClick={() => onAddAsContext?.()} testId="selection-add-context" />
          )}

          {/* Search In with submenu */}
          {engineTemplates.length > 0 && (
            <div
              className="relative"
              onMouseEnter={() => setShowSearchSubmenu(true)}
              onMouseLeave={() => setShowSearchSubmenu(false)}
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={showSearchSubmenu}
                onClick={() => setShowSearchSubmenu((open) => !open)}
                onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); setShowSearchSubmenu(true); } if (e.key === 'ArrowLeft') { e.preventDefault(); setShowSearchSubmenu(false); } }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary focus:outline-hidden focus-visible:bg-os-card-secondary data-[active=true]:bg-os-card-secondary flex items-center justify-between gap-2"
                data-testid="selection-search-in"
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
                  role="menu"
                  aria-label="Search In"
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
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            onSearchIn?.(template);
                            setShowSearchSubmenu(false);
                            onClose?.(); // Close the parent menu as well
                          }}
                          className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary focus:outline-hidden focus-visible:bg-os-card-secondary data-[active=true]:bg-os-card-secondary"
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
        </>
      )}
    </ContextMenu>
  );
});

export default TextSelectionMenu;
