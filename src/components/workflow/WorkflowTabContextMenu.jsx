import { useEffect, useRef } from 'react';
import { MenuItemIcon } from '../common/menus/MenuItemIcon';

const ITEM_CLASS = 'w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2';

/**
 * Right-click menu of a workflow tab: hand the workflow to the AI chat as
 * context, or close tabs relative to this one. Closes on any outside
 * mousedown; the parent keeps `position` ({ x, y }) and decides what each
 * action does.
 */
export default function WorkflowTabContextMenu({
  position,
  onAddAIContext,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCloseAllTabs,
  onClose
}) {
  const menuRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        onClose();
      }
    }

    // Delay adding listener to avoid immediate trigger from the click that opened the menu
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside, true); // Use capture phase
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px]"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
    >
      {/* Add as AI Context */}
      <button onClick={onAddAIContext} className={ITEM_CLASS}>
        <MenuItemIcon action="aiContext" />
        Add as AI Context
      </button>

      <div className="border-t border-os-border my-1"></div>

      <button onClick={onCloseTabsToLeft} className={ITEM_CLASS}>
        <MenuItemIcon action="closeTab" />
        Close Tabs to Left
      </button>
      <button onClick={onCloseTabsToRight} className={ITEM_CLASS}>
        <MenuItemIcon action="closeTab" />
        Close Tabs to Right
      </button>
      <button onClick={onCloseOtherTabs} className={ITEM_CLASS}>
        <MenuItemIcon action="closeTab" />
        Close Other Tabs
      </button>
      <div className="border-t border-os-border my-1"></div>
      <button onClick={onCloseAllTabs} className={ITEM_CLASS}>
        <MenuItemIcon action="closeTab" />
        Close All Tabs
      </button>
    </div>
  );
}
