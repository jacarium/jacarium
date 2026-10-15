
import ContextMenu from '../common/menus/ContextMenu';
import CategorySubmenu from '../common/menus/CategorySubmenu';
import { MENU_ICONS } from '../common/menus/menuIcons';

/**
 * TaskContextMenu - right-click menu for a task row on the Tasks page.
 *
 * One entry today: "Create Document In", which opens the same category
 * side submenu as the Documents sidebar's "Move to Category" (shared
 * CategorySubmenu: search box, viewport flipping, theme tokens). Picking a
 * category creates a document titled with the task's text in it and opens
 * it on the Documents page (see TasksPage.handleCreateDocumentFromTask).
 *
 * Driven by the useContextMenu() hook, which owns open/close, click-outside
 * and Escape handling and nudges the menu back into the viewport.
 *
 * @param {object} contextMenu - state from useContextMenu()
 * @param {object} menuRef - contextMenuRef from useContextMenu()
 * @param {string[]} categories - document categories, in sidebar order
 * @param {function} onCreateDocumentIn - (task, category) => void
 */
export default function TaskContextMenu({ contextMenu, menuRef, categories = [], onCreateDocumentIn }) {
  const visible = !!contextMenu?.visible && contextMenu.type === 'task' && !!contextMenu.target;
  return (
    <ContextMenu ref={menuRef} isVisible={visible} x={contextMenu.x} y={contextMenu.y} className="min-w-[220px]">
      <div data-testid="task-context-menu">
        <CategorySubmenu
          testId="task-create-document-in"
          label="Create Document In"
          icon={MENU_ICONS.newDocument}
          categories={categories}
          onSelect={(category) => onCreateDocumentIn && onCreateDocumentIn(contextMenu.target, category)}
        />
      </div>
    </ContextMenu>
  );
}
