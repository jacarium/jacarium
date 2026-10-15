import { useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { MenuItemIcon } from './MenuItemIcon';

/**
 * CategorySubmenu - a context-menu row that opens a side submenu listing
 * categories, with a search box and an optional "Create New" footer.
 *
 * Extracted verbatim from the Documents sidebar's "Move to Category" row so
 * every other context menu that needs to pick a document category (the Tasks
 * page's "Create Document In") renders the identical submenu: same hover
 * open/close, same viewport flipping (opens to the left of the row when it
 * would overflow the right edge, clamps to the bottom edge), same search
 * filtering and empty state, same theme tokens.
 *
 * Meant to be rendered INSIDE a context menu container (the fixed submenu is
 * a child of the row, so the menu's click-outside handling treats it as part
 * of the menu). Local state lives here and is discarded with the menu.
 *
 * @param {string} label - Row label
 * @param {Component} [icon] - lucide icon in front of the label (one of
 *   MENU_ICONS, e.g. moveToCategory); the chevron stays on the right
 * @param {string[]} categories - Category names to list, in display order
 * @param {function} onSelect - Called with the chosen category name
 * @param {function} [onCreateNew] - When given, a "Create New" footer calls it
 *   with the current search text (the Documents sidebar prefills its
 *   New Category modal with it)
 * @param {string} [emptyMessage] - Shown when no category matches the search
 * @param {string} [testId] - data-testid for the row wrapper; the submenu gets
 *   `${testId}-submenu`
 */
export default function CategorySubmenu({
  label,
  icon,
  categories = [],
  onSelect,
  onCreateNew,
  emptyMessage = 'No categories found',
  testId,
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [query, setQuery] = useState('');

  function openAt(rowElement) {
    const rect = rowElement.getBoundingClientRect();
    const submenuWidth = 200; // min-width 180px + margin for safety
    const submenuHeight = 300; // conservative: search input + scrollable category list

    let x = rect.right;
    // If opening to the right would overflow, open to the left of the parent item
    if (x + submenuWidth > window.innerWidth - 10) {
      x = rect.left - submenuWidth;
    }
    if (x < 10) {
      x = 10;
    }

    let y = rect.top;
    // Adjust if would overflow bottom edge
    if (y + submenuHeight > window.innerHeight - 10) {
      y = window.innerHeight - submenuHeight - 10;
    }
    if (y < 10) {
      y = 10;
    }

    setPos({ x, y });
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery('');
  }

  const visible = categories.filter(
    cat => !query || cat.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div
      data-testid={testId}
      onMouseEnter={(e) => openAt(e.currentTarget)}
      onMouseLeave={close}
    >
      <button
        type="button"
        // Hover opens it (as before); a click on the row also opens it so
        // keyboard/touch users are not left out. Never toggles closed.
        onClick={(e) => openAt(e.currentTarget.parentElement)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
      >
        <MenuItemIcon icon={icon} />
        {label}
        <ChevronRight size={14} className="text-os-text-secondary ml-auto" />
      </button>
      {open && (
        <div
          role="menu"
          data-testid={testId ? `${testId}-submenu` : undefined}
          className="fixed bg-os-card border border-os-border rounded-sm shadow-lg py-1 z-60"
          style={{ left: `${pos.x}px`, top: `${pos.y}px`, minWidth: '180px' }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={close}
        >
          <div className="relative">
            <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-os-text-muted" />
            <input
              type="text"
              placeholder="Search categories..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="field-inline w-full pl-8 pr-3 py-2 text-sm bg-transparent text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden"
              autoFocus
            />
          </div>
          <div className="border-t border-os-border my-1"></div>
          <div style={{ maxHeight: '224px', overflowY: 'auto' }}>
            {visible.map(cat => (
              <button
                key={cat}
                type="button"
                role="menuitem"
                onClick={() => onSelect && onSelect(cat)}
                className="w-full px-4 py-1.5 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                {cat}
              </button>
            ))}
            {visible.length === 0 && (
              <div className="px-4 py-1.5 text-xs text-os-text-muted italic">{emptyMessage}</div>
            )}
          </div>
          {onCreateNew && (
            <>
              <div className="border-t border-os-border my-1"></div>
              <button
                type="button"
                role="menuitem"
                onClick={() => onCreateNew(query)}
                className="w-full px-4 py-1.5 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="new" />
                Create New
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
