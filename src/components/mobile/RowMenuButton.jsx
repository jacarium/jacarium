import { ChevronDown } from 'lucide-react';
import { useMobile } from '../../contexts/MobileContext';
import { announceRowMenu } from './rowMenuAnchor';

/**
 * A phone has no right-click: on a phone every sidebar row gets this
 * chevron at its right edge, which opens the row's existing context menu
 * (the very handler the desktop right-click calls, so the actions are the
 * same ones) as a dropdown under the row (MobileMenuChrome places it from
 * the row's rectangle announced here). The 44px target swallows the tap so
 * the row itself is not opened or selected. Renders nothing on the desktop
 * and in the desktop app.
 */
export default function RowMenuButton({ onOpen, label = 'More actions', className = '' }) {
  const { isMobile } = useMobile();
  if (!isMobile || typeof onOpen !== 'function') return null;
  const open = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const row = e.currentTarget.closest('.sc-row, [data-drawer-pick], [role="button"]') || e.currentTarget;
    announceRowMenu(row.getBoundingClientRect());
    onOpen(e);
  };
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      data-testid="row-menu-button"
      onClick={open}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={open}
      className={`sc-row-menu shrink-0 min-w-11 min-h-11 -my-2 -mr-3 flex items-center justify-center text-os-text-secondary ${className}`}
    >
      <ChevronDown size={18} />
    </button>
  );
}
