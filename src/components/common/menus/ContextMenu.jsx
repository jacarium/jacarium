import { forwardRef, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MenuItemIcon } from './MenuItemIcon';

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
 *   it back (the textarea, the button, ... that opened it)
 * - keepFocus: the element that opened the menu keeps the DOM focus (a
 *   textarea's selection is only painted while it is focused), and the same
 *   keys reach the menu from there: the active item is marked
 *   data-active="true" and named by aria-activedescendant on the opener,
 *   Arrow Down / Up, Home / End move it, Enter / Space activate it, Arrow
 *   Right / Left are handed to it (a submenu), Escape closes; nothing to
 *   give back on close, the focus never left
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
 * @param {boolean} keepFocus - the opener keeps the focus, the keys are routed
 *   to the menu (default: false; see above)
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
    keepFocus = false,
    testId,
  },
  ref
) {
  return isVisible ? (
    <ContextMenuSurface ref={ref} x={x} y={y} zIndex={zIndex} className={className} onClose={onClose} label={label} autoFocus={autoFocus} keepFocus={keepFocus} testId={testId}>
      {children}
    </ContextMenuSurface>
  ) : null;
});

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';

const ContextMenuSurface = forwardRef(function ContextMenuSurface({ x, y, zIndex, className, onClose, label, autoFocus, keepFocus, testId, children }, ref) {
  const inner = useRef(null);
  const menuId = useId();
  const setRefs = (node) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  // Focus the first enabled item on open (the menu itself when none is enabled, so the keys still reach it);
  // Escape closes from anywhere on the page while the menu is open; give the focus back on close when the
  // menu still holds it. With keepFocus the opener keeps the focus and the keys are routed here from the
  // document (in the capture phase, before the opener's own handlers): the active item is a DOM mark
  // (data-active, an id named by aria-activedescendant on the opener), not React state, so the items - the
  // children's own elements, a submenu's included - need nothing from the menu.
  useEffect(() => {
    const opener = typeof document !== 'undefined' ? document.activeElement : null;
    const node = inner.current;
    const routed = keepFocus && !!node && !!opener && opener !== document.body;
    if (autoFocus && node && !routed) {
      const first = node.querySelector(ITEM_SELECTOR);
      (first || node).focus();
    }
    const items = () => (node ? Array.from(node.querySelectorAll(ITEM_SELECTOR)) : []);
    const activeIndex = () => items().findIndex((el) => el.getAttribute('data-active') === 'true');
    const setActive = (index) => {
      const list = items();
      list.forEach((el, i) => {
        if (!el.id) el.id = `${menuId}-item-${i}`;
        if (i === index) el.setAttribute('data-active', 'true');
        else el.removeAttribute('data-active');
      });
      if (index >= 0 && list[index]) opener.setAttribute('aria-activedescendant', list[index].id);
      else opener.removeAttribute('aria-activedescendant');
    };
    if (routed) {
      if (!node.id) node.id = `${menuId}-menu`;
      opener.setAttribute('aria-controls', node.id);
    }
    const onDocumentKey = (e) => {
      if (e.key === 'Escape' && onClose) { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (!routed || e.target !== opener) return;   // only the opener's keys are routed (a key handed to an item is the item's)
      const list = items();
      const current = activeIndex();
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        if (list.length === 0) return;
        let next = 0;
        if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % list.length;
        else if (e.key === 'ArrowUp') next = current < 0 ? list.length - 1 : (current - 1 + list.length) % list.length;
        else if (e.key === 'End') next = list.length - 1;
        setActive(next);
        return;
      }
      if (current < 0) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); list[current].click(); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        // a submenu opener handles these itself: the key is handed to the active item
        e.preventDefault();
        e.stopPropagation();
        list[current].dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true, cancelable: true }));
      }
    };
    document.addEventListener('keydown', onDocumentKey, true);
    return () => {
      document.removeEventListener('keydown', onDocumentKey, true);
      if (routed) { opener.removeAttribute('aria-activedescendant'); opener.removeAttribute('aria-controls'); }
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (node && opener && opener !== document.body && (active === document.body || (active && node.contains(active)) || active === null) && typeof opener.focus === 'function') {
        try { opener.focus(); } catch { /* the opener is gone */ }
      }
    };
  }, [autoFocus, keepFocus, onClose, menuId]);

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

  return createPortal(menuContent, document.body);
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

  // (data-active: the item the keys are on while the opener keeps the focus - see keepFocus)
  const baseClasses = 'w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary flex items-center gap-2 transition-colors focus:outline-hidden focus-visible:bg-os-card-secondary data-[active=true]:bg-os-card-secondary';
  const colorClasses = danger
    ? 'text-red-600'
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
