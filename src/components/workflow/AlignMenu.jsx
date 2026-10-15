import { useEffect, useRef } from 'react';
import {
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  AlignHorizontalSpaceBetween, AlignVerticalSpaceBetween
} from 'lucide-react';

/** Align actions (workflowLayout.js alignNodes modes), then distribute. */
const ALIGN_ITEMS = [
  { mode: 'left', label: 'Align left', icon: AlignStartVertical },
  { mode: 'center', label: 'Align centres', icon: AlignCenterVertical },
  { mode: 'right', label: 'Align right', icon: AlignEndVertical },
  { mode: 'top', label: 'Align top', icon: AlignStartHorizontal },
  { mode: 'middle', label: 'Align middles', icon: AlignCenterHorizontal },
  { mode: 'bottom', label: 'Align bottom', icon: AlignEndHorizontal },
];
const DISTRIBUTE_ITEMS = [
  { axis: 'horizontal', label: 'Distribute horizontally', icon: AlignHorizontalSpaceBetween },
  { axis: 'vertical', label: 'Distribute vertically', icon: AlignVerticalSpaceBetween },
];

function MenuItem({ icon: Icon, label, disabled, onClick }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      <Icon size={14} className="text-os-text-secondary" />
      {label}
    </button>
  );
}

/**
 * The toolbar's Align dropdown: align the selected nodes (two or more) on
 * an edge or centre line, or space them evenly (three or more). Closes on
 * an outside click or Escape, and after an action.
 */
export default function AlignMenu({ anchorRef, selectedCount, onAlign, onDistribute, onClose }) {
  const menuRef = useRef(null);

  useEffect(() => {
    function handleMouseDown(event) {
      if (menuRef.current && !menuRef.current.contains(event.target) && !anchorRef?.current?.contains(event.target)) {
        onClose();
      }
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, anchorRef]);

  const run = (action) => () => {
    action();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="workflow-align-menu"
      className="absolute left-0 top-full mt-1 z-50 bg-os-card border border-os-border rounded-lg shadow-lg py-1.5 min-w-[220px]"
    >
      <div className="px-4 py-1 text-xs text-os-text-muted">
        {selectedCount} node{selectedCount !== 1 ? 's' : ''} selected
      </div>
      {ALIGN_ITEMS.map(({ mode, label, icon }) => (
        <MenuItem key={mode} icon={icon} label={label} disabled={selectedCount < 2} onClick={run(() => onAlign(mode))} />
      ))}
      <div className="border-t border-os-border my-1"></div>
      {DISTRIBUTE_ITEMS.map(({ axis, label, icon }) => (
        <MenuItem key={axis} icon={icon} label={label} disabled={selectedCount < 3} onClick={run(() => onDistribute(axis))} />
      ))}
    </div>
  );
}
