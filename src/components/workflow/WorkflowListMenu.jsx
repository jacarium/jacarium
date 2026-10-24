import { useState, useLayoutEffect, useRef } from 'react';
import { MenuItemIcon } from '../common/menus/MenuItemIcon';

const ITEM_CLASS = 'w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2';
const Divider = () => <div className="border-t border-os-border my-1"></div>;

/**
 * The hamburger menu of the workflow list. With workflows selected it only
 * offers the bulk actions; otherwise variables, new workflow, sort order and
 * the import/export entries. Every item runs its action and closes the menu.
 *
 * Positioned below the button (`anchorRect`), flipped above it when it
 * would overflow the window, measured from the real rendered menu.
 */
export default function WorkflowListMenu({
  anchorRect,
  onClose,
  selectionMode,
  hasSelection,
  onBulkMove,
  onBulkDelete,
  onOpenVariables,
  onNewWorkflow,
  sortBy,
  onSortChange,
  onImport,
  onImportBase64,
  onExportAll,
  onExportBase64,
  // the phone layout: the sort order and the exports only (no variables,
  // no new workflow, no imports)
  readOnly = false
}) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ top: anchorRect.bottom + 4, right: window.innerWidth - anchorRect.right });

  // Correct dropdown menu position using the real rendered menu size
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const menuRect = menuRef.current.getBoundingClientRect();
    const margin = 10;
    let { top, right } = position;
    if (menuRect.bottom > window.innerHeight - margin) {
      top = anchorRect.top - menuRect.height - 4;
    }
    if (menuRect.left < margin) {
      right = window.innerWidth - menuRect.width - margin;
    }
    if (top !== position.top || right !== position.right) {
      setPosition({ top, right });
    }
  }, [position, anchorRect]);

  const run = (action) => () => {
    action?.();
    onClose();
  };

  const sortButtonClass = (value) => `w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
 sortBy === value ?'btn-selected':'hover:bg-os-card-secondary'
 }`;

  return (
    <div
      ref={menuRef}
      className="fixed bg-os-card border border-os-border shadow-lg rounded-lg z-50 py-1.5 min-w-[180px]"
      style={{
        top: `${position.top}px`,
        right: `${position.right}px`
      }}
    >
      {selectionMode && hasSelection ? (
        <>
          <button onClick={run(onBulkMove)} className={ITEM_CLASS}>
            <MenuItemIcon action="moveToCategory" />
            Move to Category
          </button>
          <button
            onClick={run(onBulkDelete)}
            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="delete" danger />
            Delete Selected
          </button>
        </>
      ) : (
        <>
          {!readOnly && (
            <>
          <button onClick={run(onOpenVariables)} className={ITEM_CLASS}>
            <MenuItemIcon action="variables" />
            Variables
          </button>
          <Divider />
          <button onClick={run(onNewWorkflow)} className={ITEM_CLASS} data-testid="workflow-menu-new">
            <MenuItemIcon action="new" />
            New Workflow
          </button>
          <Divider />
            </>
          )}
          <div className="px-4 py-2">
            <div className="text-xs font-semibold text-os-text-secondary uppercase tracking-wide mb-2">Sort by</div>
            <div className="space-y-1">
              <button onClick={run(() => onSortChange?.('date'))} className={sortButtonClass('date')}>
                <MenuItemIcon action="sortByDate" className={sortBy === 'date' ? 'text-white' : 'text-os-text-secondary'} />
                Date Modified
              </button>
              <button onClick={run(() => onSortChange?.('title'))} className={sortButtonClass('title')}>
                <MenuItemIcon action="sortByTitle" className={sortBy === 'title' ? 'text-white' : 'text-os-text-secondary'} />
                Title (A-Z)
              </button>
            </div>
          </div>
          <Divider />
          {!readOnly && (
            <>
          <button onClick={run(onImport)} className={ITEM_CLASS}>
            <MenuItemIcon action="import" />
            Import from JSON
          </button>
          <button onClick={run(onImportBase64)} className={ITEM_CLASS}>
            <MenuItemIcon action="import" />
            Import from Base64
          </button>
          <Divider />
            </>
          )}
          <button onClick={run(onExportAll)} className={ITEM_CLASS}>
            <MenuItemIcon action="exportJson" />
            Export All (JSON)
          </button>
          <button onClick={run(onExportBase64)} className={ITEM_CLASS}>
            <MenuItemIcon action="exportBase64" />
            Export All as Base64
          </button>
        </>
      )}
    </div>
  );
}
