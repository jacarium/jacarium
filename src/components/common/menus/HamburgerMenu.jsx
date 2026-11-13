import { forwardRef, useRef } from 'react';
import { createPortal } from 'react-dom';
import ErrorBoundary from '../ErrorBoundary';
import { MenuItemIcon } from './MenuItemIcon';
import { usePopupPosition } from '../../../hooks/usePopupPosition.js';

/**
 * HamburgerMenu - Dropdown menu component
 *
 * Features:
 * - Portal rendering
 * - Position calculation (relative to trigger button)
 * - Backdrop for click-outside detection
 * - Support for left/right alignment
 * - Icon and label support
 *
 * Usage with useDropdownMenu hook:
 * const { isOpen, position, menuRef, openMenu, closeMenu } = useDropdownMenu();
 *
 * @param {boolean} isOpen - Whether menu is visible
 * @param {object} position - Position object { top, left, right }
 * @param {function} onClose - Callback to close menu
 * @param {ReactNode} children - Menu items
 * @param {number} zIndex - Z-index for menu (default: 1000)
 * @param {string} className - Additional CSS classes
 */
const HamburgerMenu = forwardRef(function HamburgerMenu(
  {
    isOpen,
    position,
    onClose,
    children,
    zIndex = 1000,
    className = '',
  },
  ref
) {
  const inner = useRef(null);
  const setRefs = (node) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };
  // Under its button when it fits, above it when it does not, inside the window either way with its height capped
  // and scrolling when neither fits - measured once rendered and again on resize / scroll / size changes
  // (src/hooks/usePopupPosition.js); the position's top / left / right are the first guess until then.
  const anchor = position && position.anchor;
  const align = position && position.align === 'left' ? 'start' : 'end';
  usePopupPosition(inner, {
    open: !!isOpen && !!anchor,
    anchor: () => anchor,
    deps: [anchor && anchor.left, anchor && anchor.top, anchor && anchor.right, anchor && anchor.bottom],
    side: 'below', align, gap: position && position.offset != null ? position.offset : 4,
  });
  if (!isOpen) return null;

  const positionStyles = {
    position: 'fixed',
    top: `${position.top}px`,
    ...(position.left !== undefined && { left: `${position.left}px` }),
    ...(position.right !== undefined && { right: `${position.right}px` }),
    zIndex: zIndex + 1,
  };

  const menuContent = (
    <>
      {/* Transparent backdrop for click detection */}
      <div
        className="fixed inset-0"
        style={{ zIndex }}
        onClick={onClose}
      />

      {/* Menu */}
      <div
        ref={setRefs}
        role="menu"
        className={`sc-menu bg-os-card border border-os-border shadow-lg rounded-lg py-1 min-w-[200px] ${className}`}
        style={positionStyles}
      >
        {children}
      </div>
    </>
  );

  return createPortal(<ErrorBoundary scope="popup" label="This menu">{menuContent}</ErrorBoundary>, document.body);
});

/**
 * HamburgerMenuItem - Individual menu item
 *
 * @param {string} label - Item label
 * @param {function} onClick - Click handler
 * @param {Component} icon - lucide icon rendered before the label, normally
 *   one of MENU_ICONS so the same action looks the same in every menu
 * @param {boolean} danger - Red styling for dangerous actions (default: false)
 * @param {boolean} disabled - Disabled state (default: false)
 * @param {string} className - Additional CSS classes
 */
export function HamburgerMenuItem({
  label,
  onClick,
  icon,
  danger = false,
  disabled = false,
  className = '',
}) {
  const handleClick = (e) => {
    if (disabled) return;
    e.stopPropagation();
    onClick(e);
  };

  // gap-2 like every context menu row, so icon and label line up the same
  // whether the entry sits in a dropdown or a right-click menu
  const baseClasses = 'w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary flex items-center gap-2 transition-colors';
  const colorClasses = danger
    ? 'text-(--chart-bad)'
    : 'text-os-text-primary';
  const disabledClasses = disabled
    ? 'opacity-50 cursor-not-allowed'
    : 'cursor-pointer';

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className={`${baseClasses} ${colorClasses} ${disabledClasses} ${className}`}
    >
      <MenuItemIcon icon={icon} danger={danger} />
      <span>{label}</span>
    </button>
  );
}

/**
 * HamburgerMenuDivider - Separator between menu groups
 */
export function HamburgerMenuDivider() {
  return <div className="border-t border-os-border my-1" />;
}

/**
 * HamburgerMenuLabel - Section label (non-clickable)
 *
 * @param {string} label - Label text
 */
export function HamburgerMenuLabel({ label }) {
  return (
    <div className="px-4 py-2 text-xs font-semibold text-os-text-secondary uppercase tracking-wider">
      {label}
    </div>
  );
}

export default HamburgerMenu;
