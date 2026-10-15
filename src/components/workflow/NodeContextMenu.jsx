import { useEffect, useRef } from 'react';
import { BringToFront, SendToBack, ChevronUp, ChevronDown, Unplug, Unlink } from 'lucide-react';

const MENU_WIDTH = 200;
const MENU_HEIGHT = 250;

/** Layer actions, top to bottom; `action` values are those of reorderNode(). */
const LAYER_ACTIONS = [
  { action: 'front', label: 'Bring to Front', icon: BringToFront },
  { action: 'forward', label: 'Bring Forward', icon: ChevronUp },
  { action: 'backward', label: 'Send Backward', icon: ChevronDown },
  { action: 'back', label: 'Send to Back', icon: SendToBack }
];

/** Pin actions; `enabledProp` names the prop that says whether there is anything to clear. */
const PIN_ACTIONS = [
  { action: 'clear-exec', label: 'Clear Execution Pins', icon: Unplug, enabledProp: 'hasExecPins' },
  { action: 'clear-data', label: 'Clear Data Pins', icon: Unlink, enabledProp: 'hasDataPins' }
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
 * Right-click menu for a canvas node: layer order, then pin clearing. Styled
 * after the tab context menu in WorkflowBuilder; closes on outside click or
 * Escape. Pin actions are disabled when the node has no edge of that type.
 */
export default function NodeContextMenu({ position, onAction, onClose, hasExecPins = false, hasDataPins = false }) {
  const menuRef = useRef(null);
  const enabled = { hasExecPins, hasDataPins };

  useEffect(() => {
    function handleMouseDown(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        onClose();
      }
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    // Delay so the right-click that opened the menu doesn't immediately close it
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleMouseDown, true);
      document.addEventListener('keydown', handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Keep the menu inside the viewport
  const left = Math.max(0, Math.min(position.x, window.innerWidth - MENU_WIDTH));
  const top = Math.max(0, Math.min(position.y, window.innerHeight - MENU_HEIGHT));

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="node-context-menu"
      className="fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px]"
      style={{ left: `${left}px`, top: `${top}px` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {LAYER_ACTIONS.map(({ action, label, icon }) => (
        <MenuItem key={action} icon={icon} label={label} onClick={() => onAction(action)} />
      ))}

      <div className="border-t border-os-border my-1"></div>

      {PIN_ACTIONS.map(({ action, label, icon, enabledProp }) => (
        <MenuItem key={action} icon={icon} label={label} disabled={!enabled[enabledProp]} onClick={() => onAction(action)} />
      ))}
    </div>
  );
}
