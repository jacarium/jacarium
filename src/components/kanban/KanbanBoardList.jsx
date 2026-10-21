import { useState } from 'react';
import { Trello, Crown, Cloud, CheckSquare, X, Upload } from 'lucide-react';
import SidebarHeader from '../common/sidebar/SidebarHeader';
import CategoryList from '../common/sidebar/CategoryList';
import HamburgerMenu, { HamburgerMenuItem, HamburgerMenuDivider } from '../common/menus/HamburgerMenu';
import InlineEdit from '../common/inputs/InlineEdit';
import BoardPermissionsModal from '../common/modals/BoardPermissionsModal';
import { useNotifications } from '../../contexts/NotificationContext';
import { getUserBorderStyle } from '../../utils/userColors';
import { useCategories } from '../../hooks/useCategories';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useContextMenu, useDropdownMenu } from '../../hooks/useContextMenu';
import { EmptyState } from '../ui';
import { notifyCentralUnavailable } from '../../utils/centralAvailability';
import { MenuItemIcon } from '../common/menus/MenuItemIcon';
import { MENU_ICONS } from '../common/menus/menuIcons';

export default function KanbanBoardList({
  boards,
  currentBoardId,
  onBoardClick,
  onBoardCreate,
  onBoardDelete,
  onBoardDuplicate,
  onBoardUpload,
  onBoardSync,
  onBoardRemoveFromCloud,
  onRenameCategory,
  onUpdateBoardCategory,
  currentMachineId,
  selectionMode = false,
  selectedBoards = [],
  onToggleSelectionMode,
  onToggleBoardSelection,
  onBulkDelete,
  onBulkMove,
  centralServerStatus = null,
  sortBy = 'date',
  onSortChange,
  onImport,
  onExport,
}) {
  // Use localStorage for expandedCategories to persist across app restarts
  const [expandedCategories, setExpandedCategories] = useLocalStorage('expandedKanbanCategories', []);

  // Toggle category expansion
  const toggleCategory = (categoryName) => {
    setExpandedCategories(prev =>
      prev.includes(categoryName)
        ? prev.filter(c => c !== categoryName)
        : [...prev, categoryName]
    );
  };

  // Use category utilities from the hook
  const {
    editingCategory,
    startEditingCategory,
    cancelEditingCategory,
    getCategoriesFromItems,
    getItemsByCategory,
  } = useCategories([], null);

  const {
    contextMenu,
    contextMenuRef,
    openContextMenu,
    closeContextMenu,
  } = useContextMenu();

  const {
    isOpen: menuOpen,
    position: menuPosition,
    menuRef,
    openMenu,
    closeMenu,
  } = useDropdownMenu();

  const [draggedBoard, setDraggedBoard] = useState(null);
  const [dragOverCategory, setDragOverCategory] = useState(null);
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [permissionsBoard, setPermissionsBoard] = useState(null);
  const [permissionsBoards, setPermissionsBoards] = useState(null); // For bulk operations
  const [renamingBoardId, setRenamingBoardId] = useState(null);
  const { addNotification } = useNotifications();

  // Drag and drop handlers
  const handleDragStart = (board, e) => {
    setDraggedBoard(board);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', board.id);
  };

  const handleDragEnd = () => {
    setDraggedBoard(null);
    setDragOverCategory(null);
  };

  const handleDragOver = (categoryName, e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverCategory(categoryName);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setDragOverCategory(null);
  };

  const handleDrop = async (categoryName, e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverCategory(null);

    if (!draggedBoard || draggedBoard.category === categoryName) {
      setDraggedBoard(null);
      return;
    }

    // Update board category
    try {
      if (onUpdateBoardCategory) {
        await onUpdateBoardCategory(draggedBoard, categoryName);
      }
    } catch (error) {
      console.error('Failed to move board:', error);
    } finally {
      setDraggedBoard(null);
    }
  };

  const handleRenameSave = async (board, newTitle) => {
    if (!newTitle.trim() || newTitle === board.title) {
      setRenamingBoardId(null);
      return;
    }

    try {
      const { updateBoard, getBoard } = await import('../../utils/kanban');
      await updateBoard(board.id, { title: newTitle.trim() });

      // If it's a cloud board owned by current user, sync to cloud
      if (board.inCloud && board.ownerId === currentMachineId) {
        const updatedBoard = await getBoard(board.id);
        if (updatedBoard) {
          const { uploadBoardToCentral } = await import('../../utils/cloudKanban');
          await uploadBoardToCentral(updatedBoard);
        }
      }

      addNotification({
        type: 'success',
        title: 'Board Renamed',
        message: `Board renamed to "${newTitle.trim()}"`
      });

      setRenamingBoardId(null);

      // Trigger a refresh by dispatching a custom event
      window.dispatchEvent(new CustomEvent('boardRenamed', { detail: { boardId: board.id } }));
    } catch (error) {
      console.error('Failed to rename board:', error);
      addNotification({
        type: 'error',
        title: 'Rename Failed',
        message: 'Failed to rename board'
      });
      setRenamingBoardId(null);
    }
  };

  const handleSavePermissions = async (permissions) => {
    // Handle both single and bulk operations
    const targetBoards = permissionsBoards || (permissionsBoard ? [permissionsBoard] : []);
    if (targetBoards.length === 0) return;

    const isBulk = permissionsBoards && permissionsBoards.length > 1;

    try {
      const { updateBoard, getBoard } = await import('../../utils/kanban');
      const { uploadBoardToCentral } = await import('../../utils/cloudKanban');

      let successCount = 0;
      let failCount = 0;

      for (const board of targetBoards) {
        try {
          await updateBoard(board.id, {
            permissions: permissions
          });

          // Get the updated board and sync to cloud if it's a cloud board
          const updatedBoard = await getBoard(board.id);
          if (updatedBoard && updatedBoard.inCloud && updatedBoard.ownerId === currentMachineId) {
            await uploadBoardToCentral(updatedBoard);
          }
          successCount++;
        } catch (error) {
          console.error(`Failed to update permissions for ${board.title}:`, error);
          failCount++;
        }
      }

      if (successCount > 0) {
        addNotification({
          type: 'success',
          title: 'Permissions Updated',
          message: isBulk
            ? `Permissions updated for ${successCount} board${successCount !== 1 ? 's' : ''}${failCount > 0 ? ` (${failCount} failed)` : ''}.`
            : `Permissions for "${targetBoards[0].title}" have been updated.`
        });
      }

      if (failCount > 0 && successCount === 0) {
        addNotification({
          type: 'error',
          title: 'Update Failed',
          message: 'Failed to update board permissions.'
        });
      }
    } catch (error) {
      console.error('Failed to update permissions:', error);
      addNotification({
        type: 'error',
        title: 'Update Failed',
        message: 'Failed to update board permissions.'
      });
    }
  };

  // Bulk cloud operation handlers
  const handleBulkSyncToCloud = async () => {
    if (selectedBoards.length === 0) return;

    const { getCentralServerUrl } = await import('../../utils/cloudCentralSync');
    const serverUrl = getCentralServerUrl();
    if (!serverUrl) {
      notifyCentralUnavailable(addNotification, 'share boards');
      return;
    }

    const selectedBoardsData = boards.filter(b => selectedBoards.includes(b.id));
    const ownedOrLocalBoards = selectedBoardsData.filter(b =>
      !b.inCloud || b.ownerId === currentMachineId
    );

    if (ownedOrLocalBoards.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Nothing to Share',
        message: 'No boards available to sync.'
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const board of ownedOrLocalBoards) {
      try {
        const { getBoard } = await import('../../utils/kanban');
        const { uploadBoardToCentral } = await import('../../utils/cloudKanban');
        const freshBoard = await getBoard(board.id);
        if (freshBoard) {
          await uploadBoardToCentral(freshBoard);
          successCount++;
        }
      } catch (error) {
        console.error(`Failed to sync ${board.title}:`, error);
        failCount++;
      }
    }

    if (successCount > 0) {
      addNotification({
        type: 'success',
        title: 'Changes Synced',
        message: `${successCount} board${successCount !== 1 ? 's' : ''} synced with the team${failCount > 0 ? ` (${failCount} failed)` : ''}.`
      });
    }

    if (failCount > 0 && successCount === 0) {
      addNotification({
        type: 'error',
        title: 'Sync Failed',
        message: 'Failed to sync the boards\' changes with the team.'
      });
    }

    // Trigger board reload to update cloud status in UI
    if (successCount > 0) {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('boardUploadedToCloud', {
          detail: { boardId: null } // null indicates bulk operation
        }));
      }, 200);
    }
  };

  const handleBulkRemoveFromCloud = async () => {
    if (selectedBoards.length === 0) return;

    const selectedBoardsData = boards.filter(b => selectedBoards.includes(b.id));
    const ownedCloudBoards = selectedBoardsData.filter(b =>
      b.inCloud && b.ownerId === currentMachineId
    );

    if (ownedCloudBoards.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Nothing to Stop Sharing',
        message: 'None of the selected boards is shared by you.'
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const board of ownedCloudBoards) {
      try {
        const { removeBoardFromCentral } = await import('../../utils/cloudKanban');
        await removeBoardFromCentral(board);
        successCount++;
      } catch (error) {
        console.error(`Failed to remove ${board.title}:`, error);
        failCount++;
      }
    }

    if (successCount > 0) {
      addNotification({
        type: 'success',
        title: 'Stopped Sharing',
        message: `${successCount} board${successCount !== 1 ? 's' : ''} no longer shared${failCount > 0 ? ` (${failCount} failed)` : ''}.`
      });
    }

    if (failCount > 0 && successCount === 0) {
      addNotification({
        type: 'error',
        title: "Couldn't Stop Sharing",
        message: 'Failed to stop sharing the boards.'
      });
    }

    // Trigger board reload to update cloud status in UI
    if (successCount > 0) {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('boardRemovedFromCloud', {
          detail: { boardId: null } // null indicates bulk operation
        }));
      }, 200);
    }
  };

  const handleBulkManagePermissions = () => {
    if (selectedBoards.length === 0) return;

    const selectedBoardsData = boards.filter(b => selectedBoards.includes(b.id));
    const ownedCloudBoards = selectedBoardsData.filter(b => b.inCloud && b.ownerId === currentMachineId);

    if (ownedCloudBoards.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Cannot Manage Permissions',
        message: 'You can only manage permissions for boards you shared.'
      });
    } else {
      setPermissionsBoards(ownedCloudBoards);
      setShowPermissionsModal(true);
    }
  };

  // Category cloud operation handlers
  const handleCategoryUploadOrSyncToCloud = async (categoryName) => {
    const { getCentralServerUrl } = await import('../../utils/cloudCentralSync');
    const serverUrl = getCentralServerUrl();
    if (!serverUrl) {
      notifyCentralUnavailable(addNotification, 'share boards');
      return;
    }

    const categoryBoards = boards.filter(b => (b.category || 'General') === categoryName);
    const ownedOrLocalBoards = categoryBoards.filter(b =>
      !b.inCloud || b.ownerId === currentMachineId
    );

    if (ownedOrLocalBoards.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Nothing to Share',
        message: 'No boards available to sync in this category.'
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const board of ownedOrLocalBoards) {
      try {
        const { getBoard } = await import('../../utils/kanban');
        const { uploadBoardToCentral } = await import('../../utils/cloudKanban');
        const freshBoard = await getBoard(board.id);
        if (freshBoard) {
          await uploadBoardToCentral(freshBoard);
          successCount++;
        }
      } catch (error) {
        console.error(`Failed to sync ${board.title}:`, error);
        failCount++;
      }
    }

    if (successCount > 0) {
      addNotification({
        type: 'success',
        title: 'Changes Synced',
        message: `${successCount} board${successCount !== 1 ? 's' : ''} synced with the team${failCount > 0 ? ` (${failCount} failed)` : ''}.`
      });
    }

    if (failCount > 0 && successCount === 0) {
      addNotification({
        type: 'error',
        title: 'Sync Failed',
        message: 'Failed to sync the boards\' changes with the team.'
      });
    }

    // Trigger board reload to update cloud status in UI
    if (successCount > 0) {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('boardUploadedToCloud', {
          detail: { boardId: null } // null indicates category operation
        }));
      }, 200);
    }
  };

  const handleCategoryRemoveFromCloud = async (categoryName) => {
    const categoryBoards = boards.filter(b => (b.category || 'General') === categoryName);
    const ownedCloudBoards = categoryBoards.filter(b =>
      b.inCloud && b.ownerId === currentMachineId
    );

    if (ownedCloudBoards.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Nothing to Stop Sharing',
        message: 'No board in this category is shared by you.'
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const board of ownedCloudBoards) {
      try {
        const { removeBoardFromCentral } = await import('../../utils/cloudKanban');
        await removeBoardFromCentral(board);
        successCount++;
      } catch (error) {
        console.error(`Failed to remove ${board.title}:`, error);
        failCount++;
      }
    }

    if (successCount > 0) {
      addNotification({
        type: 'success',
        title: 'Stopped Sharing',
        message: `${successCount} board${successCount !== 1 ? 's' : ''} no longer shared${failCount > 0 ? ` (${failCount} failed)` : ''}.`
      });
    }

    if (failCount > 0 && successCount === 0) {
      addNotification({
        type: 'error',
        title: "Couldn't Stop Sharing",
        message: 'Failed to stop sharing the boards.'
      });
    }

    // Trigger board reload to update cloud status in UI
    if (successCount > 0) {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('boardRemovedFromCloud', {
          detail: { boardId: null } // null indicates category operation
        }));
      }, 200);
    }
  };

  const handleCategoryManagePermissions = (categoryName) => {
    const categoryBoards = boards.filter(b => (b.category || 'General') === categoryName);
    const ownedCloudBoards = categoryBoards.filter(b => b.inCloud && b.ownerId === currentMachineId);

    if (ownedCloudBoards.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Cannot Manage Permissions',
        message: 'No board in this category is shared by you.'
      });
    } else {
      setPermissionsBoards(ownedCloudBoards);
      setShowPermissionsModal(true);
    }
  };

  return (
    <div className="flex flex-col h-full bg-os-card border-r border-os-border">
      {/* Header */}
      <SidebarHeader
        title="Kanban"
        icon={Trello}
        onMenuClick={(e) => openMenu(e, { align: 'right' })}
        onAddClick={onBoardCreate}
        status={centralServerStatus}
        statusTitle={centralServerStatus === 'online' ? 'Central server connected' : centralServerStatus === 'offline' ? 'Central server disconnected' : 'Checking central server...'}
        actions={
          <>
            <button
              onClick={onToggleSelectionMode}
              className={`p-1.5 transition-colors ${
 selectionMode
 ?'bg-os-blue text-white hover:bg-os-blue-hover'
 :'hover:bg-os-card-secondary'
 }`}
              title={selectionMode ? 'Exit selection mode' : 'Select multiple'}
            >
              {selectionMode ? <X size={16} /> : <CheckSquare size={16} className="text-os-text-secondary" />}
            </button>
          </>
        }
      />

      {/* Board List */}
      <div className="flex-1 overflow-y-auto">
        {boards.length === 0 ? (
          <EmptyState compact icon={Trello} title="No boards yet" description="Create your first Kanban board" />
        ) : (
          <CategoryList
            categories={getCategoriesFromItems(boards)}
            items={boards}
            getItemsByCategory={(cat) => getItemsByCategory(boards, cat)}
            expandedCategories={expandedCategories}
            onToggleCategory={toggleCategory}
            onRenameCategory={onRenameCategory}
            onCategoryContextMenu={(cat, e) => openContextMenu(e, 'category', cat)}
            editingCategory={editingCategory}
            onEditingCategoryChange={(cat) => {
              cat ? startEditingCategory(cat) : cancelEditingCategory();
            }}
            categoryProps={(categoryName) => {
              const categoryItems = getItemsByCategory(boards, categoryName);
              const hasCloudBoards = categoryItems.some(board => board.inCloud === true);

              return {
                isDragOver: dragOverCategory === categoryName,
                onDragOver: (e) => handleDragOver(categoryName, e),
                onDragLeave: handleDragLeave,
                onDrop: (e) => handleDrop(categoryName, e),
                isCloudCategory: hasCloudBoards,
              };
            }}
            itemListProps={{
              draggable: !selectionMode,
              onDragStart: handleDragStart,
              onDragEnd: handleDragEnd,
              renderItem: (board) => {
                const isActive = currentBoardId === board.id;
                const isCloudBoard = board.inCloud === true;
                const isRenaming = renamingBoardId === board.id;

                if (isRenaming) {
                  return (
                    <div className="flex items-center gap-2">
                      <Trello size={14} className="text-os-text-muted shrink-0" />
                      <InlineEdit
                        value={board.title}
                        onSave={(newTitle) => handleRenameSave(board, newTitle)}
                        onCancel={() => setRenamingBoardId(null)}
                        isEditing={true}
                        onEditingChange={(editing) => {
                          if (!editing) {
                            setRenamingBoardId(null);
                          }
                        }}
                        className="flex-1"
                        inputClassName="text-sm"
                      />
                    </div>
                  );
                }

                return (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Trello
                        size={14}
                        className={`shrink-0 ${
 selectionMode && selectedBoards.includes(board.id)
 ?'text-os-text-primary'
 : isCloudBoard && isActive
 ?'text-purple-700'
 : isActive
 ?'text-os-blue'
 :'text-os-text-muted'
 }`}
                      />
                      <span className={`text-sm truncate ${
 selectionMode && selectedBoards.includes(board.id)
 ?'text-os-text-primary'
 : isCloudBoard && isActive
 ?'text-purple-700'
 : isActive
 ?'text-os-blue'
 :'text-os-text-primary'
 }`}>
                        {board.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {board.inCloud && (
                        <div className="flex items-center gap-0.5" title={board.ownerId === currentMachineId ? 'Shared with the team by you' : `Shared with the team by ${board.ownerId || 'Unknown'}`}>
                          {board.ownerId === currentMachineId && (
                            <Crown size={10} className="text-purple-600" />
                          )}
                          <Cloud size={12} className="text-purple-600" />
                        </div>
                      )}
                    </div>
                  </div>
                );
              },
              getItemClassName: (board, { isActive, isSelected }) => {
                const isCloudBoard = board.inCloud === true;

                // Selection mode styling
                if (selectionMode && isSelected) {
                  return 'group relative px-4 py-3 cursor-pointer transition-colors border-l-4 bg-os-blue/10 border-os-blue';
                }

                // Cloud boards get purple background with dynamic border color
                if (isCloudBoard && !selectionMode) {
                  if (isActive) {
                    return 'group relative px-4 py-3 cursor-pointer transition-colors border-l-4 bg-purple-100 hover:bg-purple-200';
                  } else {
                    return 'group relative px-4 py-3 cursor-pointer transition-colors border-l-4 bg-purple-50 hover:bg-purple-100';
                  }
                }

                // Non-cloud boards use normal styling
                return `
                  group relative px-4 py-3 cursor-pointer transition-colors border-l-4
                  ${
                    isActive && !selectionMode
                      ? 'bg-blue-50 border-os-blue'
                      : 'hover:bg-os-card-secondary border-transparent'
                  }
                `;
              },
              getItemStyle: (board) => {
                const isCloudBoard = board.inCloud === true;
                // Add dynamic border color based on owner
                if (isCloudBoard && board.ownerId) {
                  // Cloud boards: use their ownerId
                  return getUserBorderStyle(board.ownerId);
                } else if (!isCloudBoard && currentMachineId) {
                  // Local boards: use current machine ID (they're owned by current user)
                  return getUserBorderStyle(currentMachineId);
                }
                return undefined;
              },
              onItemClick: (board) => {
                if (selectionMode && onToggleBoardSelection) {
                  onToggleBoardSelection(board.id);
                } else if (onBoardClick) {
                  onBoardClick(board);
                }
              },
              onItemDoubleClick: (board, e) => {
                e.stopPropagation();
                if (!selectionMode) {
                  // Don't allow renaming cloud boards you don't own
                  if (board.inCloud && board.ownerId !== currentMachineId) {
                    return;
                  }
                  setRenamingBoardId(board.id);
                }
              },
              onItemContextMenu: (board, e) => {
                // If in selection mode and boards are selected, show bulk actions
                if (selectionMode && selectedBoards.length > 0) {
                  openContextMenu(e, 'bulk', selectedBoards);
                } else {
                  openContextMenu(e, 'board', board);
                }
              },
              isItemActive: (board) => !selectionMode && currentBoardId === board.id,
              isItemSelected: selectionMode ? (board) => selectedBoards.includes(board.id) : undefined,
              selectionMode,
            }}
          />
        )}
      </div>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="sc-context-menu fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px]"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          {contextMenu.type === 'board' && contextMenu.target && (
            <>
              <button
                onClick={async () => {
                  const { getBoard, getCards } = await import('../../utils/kanban');
                  const board = await getBoard(contextMenu.target.id);
                  if (board) {
                    // Get cards for this board
                    const cards = await getCards(board.id);

                    // Open AI Chat sidebar first
                    window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', {
                      detail: { isOpen: true }
                    }));

                    // Add context after a short delay to ensure sidebar is mounted
                    setTimeout(async () => {
                      const { kanbanContextPayload } = await import('../../utils/aiContext');
                      window.dispatchEvent(new CustomEvent('addAIContext', {
                        detail: { contextData: kanbanContextPayload(board, cards) }
                      }));
                    }, 100);
                  }

                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="aiContext" />
                Add as AI Context
              </button>

              <div className="border-t border-os-border my-1"></div>

              {/* Share: boards not shared yet */}
              {!contextMenu.target.inCloud && (
                <button
                  onClick={() => {
                    onBoardUpload?.(contextMenu.target);
                    closeContextMenu();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="uploadToCloud" />
                  Share with the Team
                </button>
              )}

              {/* Sync Changes for owners and users with write permissions */}
              {contextMenu.target.inCloud && (contextMenu.target.ownerId === currentMachineId || contextMenu.target.permissions?.[currentMachineId] === 'write') && (
                <button
                  onClick={() => {
                    onBoardSync?.(contextMenu.target);
                    closeContextMenu();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="syncToCloud" />
                  Sync Changes
                </button>
              )}

              {/* Stop Sharing and Manage Permissions - only for owners */}
              {contextMenu.target.inCloud && contextMenu.target.ownerId === currentMachineId && (
                <>
                  <button
                    onClick={() => {
                      onBoardRemoveFromCloud?.(contextMenu.target);
                      closeContextMenu();
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="removeFromCloud" />
                    Stop Sharing
                  </button>
                  <button
                    onClick={() => {
                      setPermissionsBoard(contextMenu.target);
                      setShowPermissionsModal(true);
                      closeContextMenu();
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="managePermissions" />
                    Manage Permissions
                  </button>
                </>
              )}

              <div className="border-t border-os-border my-1"></div>

              <button
                onClick={() => {
                  onBoardDuplicate?.(contextMenu.target);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="duplicate" />
                Duplicate Board
              </button>

              <button
                onClick={() => {
                  onBoardDelete(contextMenu.target);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="delete" danger />
                Delete Board
              </button>
            </>
          )}

          {contextMenu.type === 'bulk' && (
            <>
              <div className="px-4 py-2 text-xs font-medium text-os-text-secondary border-b border-os-border">
                {selectedBoards.length} board{selectedBoards.length !== 1 ? 's' : ''} selected
              </div>
              <button
                onClick={() => {
                  onBulkMove && onBulkMove();
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="moveToCategory" />
                Move to Category
              </button>

              {/* Sharing */}
              {(() => {
                const selectedBoardsData = boards.filter(board => selectedBoards.includes(board.id));
                const localBoards = selectedBoardsData.filter(board => !board.inCloud);
                const ownedCloudBoards = selectedBoardsData.filter(board => board.inCloud && board.ownerId === currentMachineId);
                const hasLocalBoards = localBoards.length > 0;
                const hasOwnedCloudBoards = ownedCloudBoards.length > 0;

                return (hasLocalBoards || hasOwnedCloudBoards) && (
                  <>
                    <div className="border-t border-os-border my-1"></div>
                    {hasLocalBoards && (
                      <button
                        onClick={() => {
                          handleBulkSyncToCloud();
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="uploadToCloud" />
                        Share with the Team
                      </button>
                    )}
                    {hasOwnedCloudBoards && (
                      <button
                        onClick={() => {
                          handleBulkSyncToCloud();
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="syncToCloud" />
                        Sync Changes
                      </button>
                    )}
                    {hasOwnedCloudBoards && (
                      <button
                        onClick={() => {
                          handleBulkRemoveFromCloud();
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="removeFromCloud" />
                        Stop Sharing
                      </button>
                    )}
                    {hasOwnedCloudBoards && (
                      <button
                        onClick={() => {
                          handleBulkManagePermissions();
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="managePermissions" />
                        Manage Permissions
                      </button>
                    )}
                  </>
                );
              })()}

              <div className="border-t border-os-border my-1"></div>
              <button
                onClick={() => {
                  onBulkDelete && onBulkDelete();
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="delete" danger />
                Delete Selected
              </button>
            </>
          )}

          {contextMenu.type === 'category' && (
            <>
              {(() => {
                const categoryBoards = boards.filter(b => (b.category || 'General') === contextMenu.target);
                const localBoards = categoryBoards.filter(b => !b.inCloud);
                const ownedCloudBoards = categoryBoards.filter(b => b.inCloud && b.ownerId === currentMachineId);
                const hasLocalBoards = localBoards.length > 0;
                const hasOwnedCloudBoards = ownedCloudBoards.length > 0;

                return (hasLocalBoards || hasOwnedCloudBoards) && (
                  <>
                    {hasLocalBoards && (
                      <button
                        onClick={() => {
                          handleCategoryUploadOrSyncToCloud(contextMenu.target);
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="uploadToCloud" />
                        Share with the Team
                      </button>
                    )}
                    {hasOwnedCloudBoards && (
                      <button
                        onClick={() => {
                          handleCategoryUploadOrSyncToCloud(contextMenu.target);
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="syncToCloud" />
                        Sync Changes
                      </button>
                    )}
                    {hasOwnedCloudBoards && (
                      <button
                        onClick={() => {
                          handleCategoryRemoveFromCloud(contextMenu.target);
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="removeFromCloud" />
                        Stop Sharing
                      </button>
                    )}
                    {hasOwnedCloudBoards && (
                      <button
                        onClick={() => {
                          handleCategoryManagePermissions(contextMenu.target);
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="managePermissions" />
                        Manage Permissions
                      </button>
                    )}
                  </>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* Hamburger Menu */}
      <HamburgerMenu
        isOpen={menuOpen}
        position={menuPosition}
        onClose={closeMenu}
        ref={menuRef}
      >
        <HamburgerMenuItem
          icon={MENU_ICONS.new}
          label="New Board"
          onClick={() => {
            onBoardCreate && onBoardCreate();
            closeMenu();
          }}
        />
        <HamburgerMenuDivider />
        <div className="px-4 py-2">
          <div className="text-xs font-semibold text-os-text-secondary uppercase tracking-wide mb-2">Sort by</div>
          <div className="space-y-1">
            <button
              onClick={() => {
                onSortChange && onSortChange('date');
                closeMenu();
              }}
              className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
 sortBy ==='date'?'bg-os-blue text-white':'hover:bg-os-card-secondary'
 }`}
            >
              <MenuItemIcon action="sortByDate" className={sortBy === 'date' ? 'text-white' : 'text-os-text-secondary'} />
              Date Modified
            </button>
            <button
              onClick={() => {
                onSortChange && onSortChange('title');
                closeMenu();
              }}
              className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
 sortBy ==='title'?'bg-os-blue text-white':'hover:bg-os-card-secondary'
 }`}
            >
              <MenuItemIcon action="sortByTitle" className={sortBy === 'title' ? 'text-white' : 'text-os-text-secondary'} />
              Title (A-Z)
            </button>
          </div>
        </div>
        <HamburgerMenuDivider />
        <HamburgerMenuItem
          icon={MENU_ICONS.import}
          label="Import from JSON"
          onClick={() => {
            onImport && onImport();
            closeMenu();
          }}
        />
        <HamburgerMenuDivider />
        <HamburgerMenuItem
          icon={MENU_ICONS.exportJson}
          label="Export All (JSON)"
          onClick={() => {
            onExport && onExport();
            closeMenu();
          }}
        />
      </HamburgerMenu>

      {/* Permissions Modal */}
      <BoardPermissionsModal
        isOpen={showPermissionsModal}
        onClose={() => {
          setShowPermissionsModal(false);
          setPermissionsBoard(null);
          setPermissionsBoards(null);
        }}
        board={permissionsBoard}
        boards={permissionsBoards}
        onSave={handleSavePermissions}
      />
    </div>
  );
}
