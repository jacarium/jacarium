import { forwardRef, useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { createPortal } from 'react-dom';
import ErrorBoundary from '../ErrorBoundary';
import { MenuItemIcon } from './MenuItemIcon';
import { usePopupPosition } from '../../../hooks/usePopupPosition.js';
import { isMobileLayout } from '../../../utils/mobile';

/**
 * ContextMenu - Right-click context menu component
 *
 * Features:
 * - Portal rendering at cursor position
 * - Menu item groups with dividers
 * - Icon support
 * - Hover states
 * - Keyboard: the menu is a role="menu" of role="menuitem" buttons; the first
 *   enabled item takes focus when the menu opens, Arrow Down / Up move
 *   between the enabled items (wrapping), Home / End jump, Enter / Space
 *   activate (the button's own click), Escape calls onClose; when the menu
 *   goes away while it holds the focus, the element that had it before gets
 *   it back (the editor, the button, ... that opened it)
 * - Auto-close on click outside
 *
 * Usage with useContextMenu hook:
 * const { contextMenu, contextMenuRef, openContextMenu, closeContextMenu } = useContextMenu();
 *
 * @param {boolean} isVisible - Whether menu is visible
 * @param {number} x - X position (clientX)
 * @param {number} y - Y position (clientY)
 * @param {ReactNode} children - Menu items
 * @param {number} zIndex - Z-index for menu (default: 2147483647)
 * @param {string} className - Additional CSS classes
 * @param {function} onClose - Escape closes the menu through this
 * @param {string} label - the menu's accessible name
 * @param {boolean} autoFocus - focus the first enabled item on open (default: true)
 */
const ContextMenu = forwardRef(function ContextMenu(
  {
    isVisible,
    x,
    y,
    children,
    zIndex = 2147483647,
    className = '',
    onClose,
    label = 'Context menu',
    autoFocus = true,
    testId,
  },
  ref
) {
  return isVisible ? (
    <ContextMenuSurface ref={ref} x={x} y={y} zIndex={zIndex} className={className} onClose={onClose} label={label} autoFocus={autoFocus} testId={testId}>
      {children}
    </ContextMenuSurface>
  ) : null;
});

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';

const ContextMenuSurface = forwardRef(function ContextMenuSurface({ x, y, zIndex, className, onClose, label, autoFocus, testId, children }, ref) {
  const inner = useRef(null);
  const setRefs = (node) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  // Focus the first enabled item on open (the menu itself when none is enabled, so the keys still reach it);
  // Escape closes from anywhere on the page while the menu is open; give the focus back on close when the
  // menu still holds it. onClose is read through a ref: the effect runs once per open, whatever the parent
  // re-renders with (a re-run would hand the focus back and forth).
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  // Inside the window, whatever the menu's real height (the spelling suggestions arrive after it opened, the font and
  // the text size vary): below and to the right of the pointer when it fits, flipped above / to the left when it does
  // not, else clamped with a capped height and scrolling inside; re-placed on resize, scroll and size changes
  // (src/hooks/usePopupPosition.js). On a phone MobileMenuChrome places it instead.
  usePopupPosition(inner, { open: true, anchor: () => ({ left: x, top: y }), deps: [x, y] });
  useEffect(() => {
    const opener = typeof document !== 'undefined' ? document.activeElement : null;
    const node = inner.current;
    if (autoFocus && node) {
      const first = node.querySelector(ITEM_SELECTOR);
      (first || node).focus();
    }
    const onDocumentKey = (e) => {
      if (e.key === 'Escape' && onCloseRef.current) { e.preventDefault(); e.stopPropagation(); onCloseRef.current(); }
    };
    document.addEventListener('keydown', onDocumentKey, true);
    return () => {
      document.removeEventListener('keydown', onDocumentKey, true);
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (node && opener && opener !== document.body && (active === document.body || (active && node.contains(active)) || active === null) && typeof opener.focus === 'function') {
        try { opener.focus(); } catch { /* the opener is gone */ }
      }
    };
  }, [autoFocus]);

  const onKeyDown = (e) => {
    const node = inner.current;
    if (!node) return;
    if (e.key === 'Escape') return;   // handled on the document while the menu is open
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(node.querySelectorAll(ITEM_SELECTOR));
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement);
    let next = 0;
    if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else if (e.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    else if (e.key === 'End') next = items.length - 1;
    items[next].focus();
  };

  const menuContent = (
    <div
      ref={setRefs}
      role="menu"
      aria-label={label}
      data-testid={testId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={`sc-context-menu fixed bg-os-card border border-os-border shadow-lg rounded-lg py-1.5 min-w-[200px] ${className}`}
      style={{
        left: `${x}px`,
        top: `${y}px`,
        zIndex,
      }}
    >
      {children}
    </div>
  );

  return createPortal(<ErrorBoundary scope="popup" label="This menu">{menuContent}</ErrorBoundary>, document.body);
});

/**
 * ContextMenuItem - Individual menu item
 *
 * @param {string} label - Item label
 * @param {function} onClick - Click handler
 * @param {Component} icon - lucide icon rendered before the label, normally
 *   one of MENU_ICONS so the same action looks the same in every menu
 * @param {boolean} danger - Red styling for dangerous actions (default: false)
 * @param {boolean} disabled - Disabled state (default: false): the item stays
 *   in the menu, greyed, announced as disabled, and does nothing
 * @param {string} shortcut - the keyboard shortcut shown at the right (⌘C,
 *   Ctrl+C: src/utils/shortcuts.js formats one for the platform) and
 *   announced through aria-keyshortcuts
 * @param {string} action - a MENU_ICONS key, instead of `icon`
 * @param {string} className - Additional CSS classes
 * @param {string} testId - data-testid
 */
export function ContextMenuItem({
  label,
  onClick,
  icon,
  action,
  danger = false,
  disabled = false,
  shortcut,
  className = '',
  testId,
}) {
  const handleClick = (e) => {
    if (disabled) return;
    e.stopPropagation();
    onClick(e);
  };

  const baseClasses = 'w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary flex items-center gap-2 transition-colors focus:outline-hidden focus-visible:bg-os-card-secondary';
  const colorClasses = danger
    ? 'text-(--chart-bad)'
    : 'text-os-text-primary';
  const disabledClasses = disabled
    ? 'opacity-50 cursor-not-allowed'
    : 'cursor-pointer';

  return (
    <button
      type="button"
      role="menuitem"
      onClick={handleClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={shortcut || undefined}
      data-testid={testId}
      className={`${baseClasses} ${colorClasses} ${disabledClasses} ${className}`}
    >
      <MenuItemIcon icon={icon} action={action} danger={danger} />
      <span className="flex-1">{label}</span>
      {shortcut && <span className="ml-6 text-xs text-os-text-muted" aria-hidden="true">{shortcut}</span>}
    </button>
  );
}

/**
 * ContextSubmenu - a row of a context menu that opens a submenu beside it (hover, a click, Arrow Right; Arrow Left
 * closes it and the row has the focus again). Its children are the submenu's rows: ContextMenuItem,
 * ContextMenuLabel, ContextMenuDivider.
 *
 * The submenu is its OWN popup: position: fixed, placed by the shared placement beside the row - at the row's right,
 * at its left when the window has no room there, moved up when the window is short, its height capped (it scrolls
 * inside). It is not laid out inside the menu's box, so opening it never changes the size the menu is placed by:
 * the menu stays exactly where it is. (A submenu positioned absolute inside the menu overflowed it; the placement
 * measured that overflow as the menu's height and moved the whole menu up the window.) It stays a DOM child of
 * the row, so the menu's click-outside handling and its Arrow keys treat it as part of the menu.
 *
 * @param {string} label - the row's label
 * @param {Component} [icon] - lucide icon before the label (one of MENU_ICONS)
 * @param {string} [action] - a MENU_ICONS key, instead of `icon`
 * @param {string} [submenuLabel] - the submenu's accessible name (default: the label)
 * @param {number} [cap=300] - the height the submenu never exceeds (it scrolls inside)
 * @param {string} [testId] - data-testid of the row; the submenu gets `${testId}-submenu`
 */
export function ContextSubmenu({ label, icon, action, submenuLabel, cap = 300, testId, children }) {
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState({ x: 0, y: 0 });   // the first paint (and a phone's place); the placement takes over
  const rowRef = useRef(null);
  const submenuRef = useRef(null);
  // the anchor is the row as it is now, read at each placement
  usePopupPosition(submenuRef, {
    open,
    anchor: () => (rowRef.current && rowRef.current.isConnected ? rowRef.current.getBoundingClientRect() : null),
    side: 'right', gap: 0, cap,
  });
  const show = () => {
    const row = rowRef.current;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    if (isMobileLayout()) {
      // a phone: full width (src/mobile.css .sc-submenu) under the row, above it when there is no room below
      const half = Math.min(cap, window.innerHeight * 0.5);
      let y = rect.bottom + 4;
      if (y + half > window.innerHeight - 70) y = Math.max(10, rect.top - 4 - half);
      setFirst({ x: 12, y });
    } else {
      setFirst({ x: rect.right, y: rect.top });
    }
    setOpen(true);
  };
  const hide = () => setOpen(false);
  const onRowKey = (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); show(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); hide(); }
  };
  const onSubmenuKey = (e) => {
    if (e.key !== 'ArrowLeft') return;
    e.preventDefault();
    hide();
    if (rowRef.current) rowRef.current.focus();
  };
  return (
    <div onMouseEnter={show} onMouseLeave={hide}>
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); if (open) hide(); else show(); }}
        onKeyDown={onRowKey}
        data-testid={testId}
        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 transition-colors cursor-pointer focus:outline-hidden focus-visible:bg-os-card-secondary"
      >
        <MenuItemIcon icon={icon} action={action} />
        <span className="flex-1">{label}</span>
        <ChevronRight size={14} className="text-os-text-muted" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={submenuRef}
          role="menu"
          aria-label={submenuLabel || label}
          data-testid={testId ? `${testId}-submenu` : undefined}
          onKeyDown={onSubmenuKey}
          className="sc-submenu fixed bg-os-card border border-os-border rounded-sm shadow-lg py-1 min-w-[200px] z-60"
          style={{ left: `${first.x}px`, top: `${first.y}px` }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * ContextMenuDivider - Separator between menu groups
 */
export function ContextMenuDivider() {
  return <div role="separator" className="border-t border-os-border my-1" />;
}

/**
 * ContextMenuLabel - Section label (non-clickable)
 *
 * @param {string} label - Label text
 */
export function ContextMenuLabel({ label }) {
  return (
    <div className="px-4 py-2 text-xs font-semibold text-os-text-secondary uppercase tracking-wider">
      {label}
    </div>
  );
}

export default ContextMenu;
