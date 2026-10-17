import { forwardRef } from 'react';
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
 * - Keyboard navigation (future enhancement)
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
 */
const ContextMenu = forwardRef(function ContextMenu(
  {
    isVisible,
    x,
    y,
    children,
    zIndex = 2147483647,
    className = '',
  },
  ref
) {
  if (!isVisible) return null;

  const menuContent = (
    <div
      ref={ref}
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
 * @param {boolean} disabled - Disabled state (default: false)
 * @param {string} className - Additional CSS classes
 */
export function ContextMenuItem({
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

  const baseClasses = 'w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary flex items-center gap-2 transition-colors';
  const colorClasses = danger
    ? 'text-red-600'
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
 * ContextMenuDivider - Separator between menu groups
 */
export function ContextMenuDivider() {
  return <div className="border-t border-os-border my-1" />;
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
