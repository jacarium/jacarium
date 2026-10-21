import { useState, useEffect, useRef } from 'react';
import { Trello, Copy, Trash } from 'lucide-react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import useSyncedOpenTabs from '../hooks/useSyncedOpenTabs';
import { db as database } from '../db/database';
import { useDisplayName } from '../hooks/useDisplayName';
import { useYjsBoard } from '../hooks/useYjsBoard';
import ResizableSidebar from './ResizableSidebar';
import TabBar from './features/documents/TabBar';
import { getBoards, getCards, createCard, updateCard, deleteCard, moveCard, reorderCards, createBoard, updateBoard, deleteBoard, getBoard, renameCategory, updateBoardCategory } from '../utils/kanban';
import { uploadBoardToCentral, removeBoardFromCentral, isBoardOwner } from '../utils/cloudKanban';
import { getMachineId } from '../utils/cloudCentralSync';
import { onConnectionStatusChange, getSocket } from '../utils/cloudWebSocket';
import { getUserColor } from '../utils/userColors';
import KanbanBoardList from './kanban/KanbanBoardList';
import KanbanColumn from './kanban/KanbanColumn';
import KanbanCard from './kanban/KanbanCard';
import ConfirmationModal from './common/ConfirmationModal';
import ImportJsonModal from './common/ImportJsonModal';
import JsonImportStats from './common/JsonImportStats';
import { validateBoardsImport, runBoardsImport } from '../utils/kanbanImport';
import { jsonMergeLabel, jsonMergeHint, jsonImportMessage } from '../utils/jsonImportMerge';
import FormModal from './common/modals/FormModal';
import { useNotifications } from '../contexts/NotificationContext';
import { MenuItemIcon } from './common/menus/MenuItemIcon';
import { useMobile } from '../contexts/MobileContext';

export default function KanbanPage() {
  const { addNotification } = useNotifications();
  // The phone layout: one column per screen, swiped, with the dots above
  const { isMobile } = useMobile();
  const columnsScrollRef = useRef(null);
  const [boards, setBoards] = useState([]);
  const [currentBoardId, setCurrentBoardId] = useLocalStorage('currentKanbanBoardId', null);
  const [currentBoard, setCurrentBoard] = useState(null);
  const [openTabs, setOpenTabs] = useLocalStorage('kanbanOpenTabs', []);
  // the board tabs follow the account's devices
  useSyncedOpenTabs({
    page: 'kanban', tabs: openTabs, setTabs: setOpenTabs,
    itemOf: async (tab) => (await database.kanbanBoards.get(tab.id))?.syncId || null,
    titleOf: (tab) => tab.title || 'Untitled',
    resolve: async (item) => {
      const board = await database.kanbanBoards.where('syncId').equals(item).first();
      if (!board) return null;
      // the page's list must know it before the tab appears: the restore
      // effect below drops tabs of boards the list does not have (the list
      // alone - loadBoards would open the first board itself when no tab is open)
      if (!boardsRef.current.some((b) => b.id === board.id)) setBoards(await getBoards());
      return { id: board.id, title: board.title, category: board.category || 'General', inCloud: board.inCloud || false, type: 'board' };
    },
    onClose: (tab) => handleTabClose(tab.id),
    onOpen: (tab) => handleTabClick(tab),
    active: currentBoardId ?? null,
    itemCollection: 'kanbanBoards',
  });
  const [localCards, setLocalCards] = useState([]); // For local/non-cloud boards
  const [draggedCard, setDraggedCard] = useState(null);
  const [draggedOverColumn, setDraggedOverColumn] = useState(null);
  const [draggedColumn, setDraggedColumn] = useState(null);
  const [draggedOverColumnPosition, setDraggedOverColumnPosition] = useState(null);
  const [showTabContextMenu, setShowTabContextMenu] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false); // the list menu's "Import from JSON"
  const [isCreatingColumn, setIsCreatingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');
  const [tabContextMenuPosition, setTabContextMenuPosition] = useState({ x: 0, y: 0 });
  const [tabContextMenuTarget, setTabContextMenuTarget] = useState(null);
  const [innerSidebarVisible, setInnerSidebarVisible] = useLocalStorage('innerSidebarVisible', true);
  const [currentMachineId, setCurrentMachineId] = useState(null);
  // What teammates see for us in the board's presence: the OS username on
  // the desktop, the name chosen in Settings in a browser
  const currentDisplayName = useDisplayName(currentMachineId);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedBoards, setSelectedBoards] = useState([]);
  const [centralServerStatus, setCentralServerStatus] = useState(null);
  const [sortBy, setSortBy] = useLocalStorage('kanbanSortBy', 'date');
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: null,
    dangerous: false
  });
  const [showMoveCategoryModal, setShowMoveCategoryModal] = useState(false);
  const [moveCategoryName, setMoveCategoryName] = useState('');

  // Yjs collaborative board (for cloud boards only)
  const yjsEnabled = !!(currentBoard && currentBoard.inCloud && currentBoard.cloudBoardId);

  // Debug board cloud status
  useEffect(() => {
    if (currentBoard) {
      console.log('[KanbanPage] Current board cloud status:', {
        id: currentBoard.id,
        title: currentBoard.title,
        inCloud: currentBoard.inCloud,
        cloudBoardId: currentBoard.cloudBoardId,
        yjsEnabled
      });
    }
  }, [currentBoard, yjsEnabled]);

  const yjs = useYjsBoard(
    yjsEnabled ? currentBoard.cloudBoardId : null,
    yjsEnabled ? getSocket() : null,
    localCards, // Pass localCards so Yjs can initialize from IndexedDB when offline
    currentBoard,
    null, // onCardsChange - not needed, we use yjs.cards directly
    (updatedBoard) => {
      console.log('[KanbanPage] Yjs board updated:', updatedBoard);
      setCurrentBoard(updatedBoard);
    }
  );

  // Use Yjs cards for cloud boards (even offline - Yjs CRDT will sync when reconnected)
  // Only fall back to localCards for non-cloud boards
  const cards = yjsEnabled ? yjs.cards : localCards;

  // For cloud boards, use Yjs board directly; for local boards, use currentBoard
  // This ensures changes are visible immediately and work offline with CRDT sync
  const displayBoard = (yjsEnabled && yjs.board) ? yjs.board : currentBoard;

  // Get connected users for assignee suggestions (only for cloud boards)
  const connectedUsers = yjsEnabled ? (yjs.connectedUsers || []) : [];

  // DEBUG: Only log when cards actually change
  const cardsLengthRef = useRef(0);
  useEffect(() => {
    if (cards.length !== cardsLengthRef.current) {
      console.log('[DEBUG] Cards changed:', {
        yjsEnabled,
        'yjs.cards': yjs.cards?.length,
        localCards: localCards.length,
        'cards (computed)': cards.length,
        'cards detail': cards
      });
      cardsLengthRef.current = cards.length;
    }
    // debug-only length-change logger; cards itself is deliberately not a dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.length, yjsEnabled, yjs.cards?.length, localCards.length]);

  // Refs for current state in event handlers
  const currentBoardRef = useRef(null);
  const openTabsRef = useRef([]);
  const currentBoardIdRef = useRef(null);
  const tabContextMenuRef = useRef(null);
  const boardsRef = useRef([]);

  // Load machine ID
  useEffect(() => {
    async function loadMachineId() {
      const machineId = await getMachineId();
      setCurrentMachineId(machineId);
    }
    loadMachineId();
  }, []);

  // Check board permissions and online status
  useEffect(() => {
    async function checkPermissions() {
      if (!currentBoard) {
        setIsReadOnly(false);
        return;
      }

      // Cloud boards require online connection for editing
      if (currentBoard.inCloud && !isOnline) {
        setIsReadOnly(true);
        console.log('[KanbanPage] Cloud board is READ-ONLY - offline (cloud boards require online connection)');
        return;
      }

      // The server has the last word: a refused edit means no write access
      // whatever the local copy's permissions say
      const hasWritePermission = (await isBoardOwner(currentBoard)) && !yjs.writeRejected;
      setIsReadOnly(!hasWritePermission);

      if (!hasWritePermission) {
        console.log('[KanbanPage] Board is READ-ONLY - user does not have write permissions');
      }
    }

    checkPermissions();
  }, [currentBoard, isOnline, yjs.writeRejected]);

  // The server refused this identity's edit to the board: say so once (the
  // hook has already resynced the board from the server, dropping the edit)
  useEffect(() => {
    if (!yjs.writeRejected) return;
    addNotification({
      type: 'warning',
      title: 'Read-only',
      message: 'You can view this board but not edit it.'
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yjs.writeRejected]);

  // Set user info for Yjs awareness (only when board or machine ID changes)
  useEffect(() => {
    if (!yjsEnabled || !yjs.setUserInfo || !currentMachineId) return;

    const userColor = getUserColor(currentMachineId);
    const username = currentDisplayName || currentMachineId.split('@')[0] || currentMachineId;

    console.log('[KanbanPage] Setting Yjs user info - username:', username, 'color:', userColor);
    yjs.setUserInfo(username, userColor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yjsEnabled, currentMachineId, currentDisplayName, currentBoard?.cloudBoardId]); // Only re-run when board, machine or name changes

  // Keep refs in sync with state
  useEffect(() => {
    currentBoardRef.current = currentBoard;
  }, [currentBoard]);

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  useEffect(() => {
    currentBoardIdRef.current = currentBoardId;
  }, [currentBoardId]);

  useEffect(() => {
    boardsRef.current = boards;
  }, [boards]);

  // Load boards
  useEffect(() => {
    loadBoards();
    // Intentional mount-only load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for cloud sync events
  useEffect(() => {
    function handleCloudBoardsReceived() {
      console.log('[KanbanPage] Cloud boards received, reloading boards');
      loadBoards();
    }

    async function handleBoardUploadedToCloud(event) {
      console.log('[KanbanPage] Board uploaded to cloud event received:', event.detail);
      const uploadedBoardId = event.detail?.boardId;

      // Reload boards to refresh cloud status in UI
      console.log('[KanbanPage] Reloading boards...');
      await loadBoards();
      console.log('[KanbanPage] Boards reloaded');

      // If the uploaded board is currently active, reload it to get cloud metadata
      if (uploadedBoardId && currentBoardIdRef.current === uploadedBoardId) {
        console.log('[KanbanPage] Uploaded board is current, reloading board data...');
        await loadBoardData(uploadedBoardId);
        console.log('[KanbanPage] Current board reloaded with cloud metadata');
      }
    }

    async function handleBoardRemovedFromCloud(event) {
      console.log('[KanbanPage] Board removed from cloud event received:', event.detail);
      const removedBoardId = event.detail?.boardId;

      // Reload boards to refresh cloud status in UI
      console.log('[KanbanPage] Reloading boards...');
      await loadBoards();
      console.log('[KanbanPage] Boards reloaded');

      // If the removed board is currently active, reload it to clear cloud metadata
      if (removedBoardId && currentBoardIdRef.current === removedBoardId) {
        console.log('[KanbanPage] Removed board is current, reloading board data...');
        await loadBoardData(removedBoardId);
        console.log('[KanbanPage] Current board reloaded without cloud metadata');
      }
    }

    async function handleBoardRenamed(event) {
      console.log('[KanbanPage] Board renamed event received:', event.detail);
      const renamedBoardId = event.detail?.boardId;

      // Reload boards to refresh the renamed board in the UI
      await loadBoards();

      // If the renamed board is currently active, reload it and update tabs
      if (renamedBoardId && currentBoardIdRef.current === renamedBoardId) {
        await loadBoardData(renamedBoardId);
      }
    }

    function handleOpenBoardFromChat(event) {
      const boardId = event.detail?.boardId;
      if (!boardId) return;

      console.log('[KanbanPage] Opening board from chat:', boardId);

      // Find the board in the list
      const board = boardsRef.current.find(b => b.id === boardId);
      if (!board) {
        console.log('[KanbanPage] Board not found:', boardId);
        return;
      }

      // Open the board (same as clicking on it in the sidebar)
      handleBoardClick(board);
    }

    window.addEventListener('cloudKanbanBoardsReceived', handleCloudBoardsReceived);
    window.addEventListener('boardUploadedToCloud', handleBoardUploadedToCloud);
    window.addEventListener('boardRemovedFromCloud', handleBoardRemovedFromCloud);
    window.addEventListener('boardRenamed', handleBoardRenamed);
    window.addEventListener('openBoard', handleOpenBoardFromChat);

    return () => {
      window.removeEventListener('cloudKanbanBoardsReceived', handleCloudBoardsReceived);
      window.removeEventListener('boardUploadedToCloud', handleBoardUploadedToCloud);
      window.removeEventListener('boardRemovedFromCloud', handleBoardRemovedFromCloud);
      window.removeEventListener('boardRenamed', handleBoardRenamed);
      window.removeEventListener('openBoard', handleOpenBoardFromChat);
    };
    // Intentional mount-only subscriptions; handlers read live state via refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen to WebSocket connection status
  useEffect(() => {
    // Subscribe to WebSocket connection status changes
    const unsubscribe = onConnectionStatusChange(({ connected }) => {
      setCentralServerStatus(connected ? 'online' : 'offline');
      // (the Working Offline / Back Online notifications are the app's,
      // src/hooks/useConnectionNotices.js, so a page switch never loses one)
      setIsOnline(connected);
    });

    return unsubscribe;
  }, []);

  // Close tab context menu on outside click
  useEffect(() => {
    if (!showTabContextMenu) return;

    function handleClickOutside(event) {
      if (tabContextMenuRef.current && !tabContextMenuRef.current.contains(event.target)) {
        setShowTabContextMenu(false);
      }
    }

    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside, true);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside, true);
    };
  }, [showTabContextMenu]);

  // Restore open tabs on mount
  useEffect(() => {
    if (boards.length === 0) return;

    if (openTabs.length > 0) {
      // Validate tabs still exist and update their data from boards
      const updatedTabs = openTabs
        .map(tab => {
          const board = boards.find(b => b.id === tab.id);
          if (!board) return null; // Board no longer exists

          // Update tab with latest board data
          return {
            id: board.id,
            title: board.title,
            category: board.category || 'General',
            inCloud: board.inCloud || false,
            type: 'board'
          };
        })
        .filter(Boolean); // Remove null entries

      // Update tabs if they changed
      const tabsChanged = updatedTabs.length !== openTabs.length ||
        updatedTabs.some((tab, i) =>
          tab.title !== openTabs[i]?.title ||
          tab.category !== openTabs[i]?.category ||
          tab.inCloud !== openTabs[i]?.inCloud
        );

      if (tabsChanged) {
        setOpenTabs(updatedTabs);
      }

      // If current board is not in valid tabs, select first valid tab
      if (currentBoardId && !updatedTabs.find(tab => tab.id === currentBoardId)) {
        if (updatedTabs.length > 0) {
          setCurrentBoardId(updatedTabs[0].id);
        } else {
          setCurrentBoardId(null);
        }
      }
    } else if (currentBoardId) {
      // No tabs but there's a selected board - add it to tabs
      const board = boards.find(b => b.id === currentBoardId);
      if (board) {
        const newTab = {
          id: board.id,
          title: board.title,
          category: board.category || 'General',
          inCloud: board.inCloud || false,
          type: 'board'
        };
        setOpenTabs([newTab]);
      }
    }
    // Tab reconciliation deliberately runs only when boards change;
    // currentBoardId/openTabs are read as current-state guards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards]);

  // Load current board and cards when selection changes. The cleanup clears
  // the loaded board when the selection goes away (or on unmount) so a
  // no-board state never shows another board's cards.
  useEffect(() => {
    if (!currentBoardId) return undefined;

    loadBoardData(currentBoardId);

    return () => {
      setCurrentBoard(null);
      setLocalCards([]);
    };
    // loadBoardData is recreated per render; currentBoardId is the trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBoardId]);

  // Listen for sidebar visibility changes
  useEffect(() => {
    function handleVisibilityChange(event) {
      setInnerSidebarVisible(event.detail.visible);
    }
    window.addEventListener('innerSidebarVisibilityChange', handleVisibilityChange);
    return () => window.removeEventListener('innerSidebarVisibilityChange', handleVisibilityChange);
  }, [setInnerSidebarVisible]);

  async function loadBoards() {
    try {
      const allBoards = await getBoards();
      setBoards(allBoards);

      // If no board selected and boards exist, select first and open it in a tab
      if (!currentBoardId && allBoards.length > 0 && openTabsRef.current.length === 0) {
        const firstBoard = allBoards[0];
        const newTab = {
          id: firstBoard.id,
          title: firstBoard.title,
          category: firstBoard.category || 'General',
          inCloud: firstBoard.inCloud || false,
          type: 'board'
        };
        setOpenTabs([newTab]);
        setCurrentBoardId(firstBoard.id);
      }
    } catch (error) {
      console.error('Error loading boards:', error);
      addNotification({
        type: 'error',
        title: 'Load Error',
        message: 'Failed to load kanban boards'
      });
    }
  }

  async function loadBoardData(boardId) {
    try {
      // Fetch board directly from database instead of using stale state
      const board = await getBoard(boardId);
      if (!board) {
        console.error('Board not found:', boardId);
        return;
      }

      setCurrentBoard(board);

      const boardCards = await getCards(boardId);

      // Store cards in localCards - Yjs will use this for initialization
      // The cards variable will be computed from yjs.cards or localCards
      setLocalCards(boardCards);

      if (board.inCloud && board.cloudBoardId) {
        console.log('[KanbanPage] Cloud board detected, using Yjs for sync');
      } else {
        console.log('[KanbanPage] Local board, using direct state');
      }
    } catch (error) {
      console.error('Error loading board:', error);
      addNotification({
        type: 'error',
        title: 'Load Error',
        message: 'Failed to load kanban board'
      });
    }
  }

  async function handleCreateCard(columnId) {
    if (isReadOnly) {
      addNotification({
        type: 'warning',
        title: 'Read-Only Mode',
        message: 'You do not have permission to edit this board'
      });
      return;
    }

    try {
      // Calculate position for new card
      const maxPosition = cards
        .filter(c => c.status === columnId)
        .reduce((max, c) => Math.max(max, c.position || 0), -1);

      // Create card with default values immediately
      const newCard = await createCard({
        title: 'New Card',
        description: '',
        boardId: currentBoard.id,
        status: columnId,
        position: maxPosition + 1,
        assignee: '',
        priority: '',
        dueDate: '',
        tags: []
      });

      // Add to Yjs if cloud board
      if (yjsEnabled && yjs.addCard && newCard) {
        yjs.addCard(newCard);
      }

      // Reload for non-cloud boards
      if (!yjsEnabled) {
        await loadBoardData(currentBoardId);
      }
    } catch (error) {
      console.error('Error creating card:', error);
      addNotification({
        type: 'error',
        title: 'Create Error',
        message: 'Failed to create card'
      });
    }
  }

  async function handleDeleteCard(cardId) {
    if (isReadOnly) return;

    try {
      // Delete from IndexedDB
      await deleteCard(cardId);

      // Delete from Yjs if cloud board
      if (yjsEnabled && yjs.deleteCard) {
        yjs.deleteCard(cardId);
      }

      addNotification({
        type: 'success',
        title: 'Card Deleted',
        message: 'Card deleted successfully'
      });

      // Reload for non-cloud boards
      if (!yjsEnabled) {
        await loadBoardData(currentBoardId);
      }
    } catch (error) {
      console.error('Error deleting card:', error);
      addNotification({
        type: 'error',
        title: 'Delete Error',
        message: 'Failed to delete card'
      });
    }
  }

  async function handleRenameCard(cardId, newTitle) {
    if (isReadOnly) return;

    try {
      await updateCard(cardId, { title: newTitle });

      // Update in Yjs if cloud board
      if (yjsEnabled && yjs.updateCard) {
        yjs.updateCard(cardId, { title: newTitle });
      }

      addNotification({
        type: 'success',
        title: 'Card Renamed',
        message: 'Card renamed successfully'
      });

      // Only reload for non-cloud boards
      if (!yjsEnabled) {
        await loadBoardData(currentBoardId);
      }
    } catch (error) {
      console.error('Error renaming card:', error);
      addNotification({
        type: 'error',
        title: 'Rename Error',
        message: 'Failed to rename card'
      });
    }
  }

  async function handleUpdateCardDescription(cardId, newDescription) {
    if (isReadOnly) return;

    try {
      await updateCard(cardId, { description: newDescription });

      // Update in Yjs if cloud board
      if (yjsEnabled && yjs.updateCard) {
        yjs.updateCard(cardId, { description: newDescription });
      }

      addNotification({
        type: 'success',
        title: 'Description Updated',
        message: 'Card description updated successfully'
      });

      // Only reload for non-cloud boards
      if (!yjsEnabled) {
        await loadBoardData(currentBoardId);
      }
    } catch (error) {
      console.error('Error updating description:', error);
      addNotification({
        type: 'error',
        title: 'Update Error',
        message: 'Failed to update description'
      });
    }
  }

  async function handleUpdateCard(cardId, updates) {
    if (isReadOnly) return;

    console.log(`[KanbanPage] handleUpdateCard called - cardId: ${cardId}, updates:`, updates, 'yjsEnabled:', yjsEnabled);

    try {
      await updateCard(cardId, updates);
      console.log(`[KanbanPage] IndexedDB updated for card ${cardId}`);

      // Update in Yjs if cloud board
      if (yjsEnabled && yjs.updateCard) {
        console.log(`[KanbanPage] Calling yjs.updateCard for card ${cardId}`);
        yjs.updateCard(cardId, updates);
      } else {
        console.log(`[KanbanPage] NOT calling yjs.updateCard - yjsEnabled: ${yjsEnabled}, yjs.updateCard exists: ${!!yjs.updateCard}`);
      }

      // Only reload for non-cloud boards
      if (!yjsEnabled) {
        await loadBoardData(currentBoardId);
      }
    } catch (error) {
      console.error('Error updating card:', error);
      addNotification({
        type: 'error',
        title: 'Update Error',
        message: 'Failed to update card'
      });
    }
  }

  async function handleRenameColumn(columnId, newTitle) {
    if (!currentBoard || isReadOnly) return;

    try {
      const updatedColumns = displayBoard.columns.map(col =>
        col.id === columnId ? { ...col, title: newTitle } : col
      );

      // Update in IndexedDB
      await updateBoard(currentBoard.id, {
        ...currentBoard,
        columns: updatedColumns
      });

      // Update in Yjs if cloud board
      if (yjsEnabled && yjs.updateBoardColumns) {
        yjs.updateBoardColumns(updatedColumns);
      }

      addNotification({
        type: 'success',
        title: 'Column Renamed',
        message: 'Column renamed successfully'
      });

      // Reload board data for non-cloud boards
      if (!yjsEnabled) {
        await loadBoardData(currentBoardId);
      }

      // Refresh boards list so sidebar has updated board
      await loadBoards();
    } catch (error) {
      console.error('Error renaming column:', error);
      addNotification({
        type: 'error',
        title: 'Rename Error',
        message: 'Failed to rename column'
      });
    }
  }

  async function handleUpdateColumnColor(columnId, newColor) {
    if (!currentBoard || isReadOnly) return;

    try {
      const updatedColumns = displayBoard.columns.map(col =>
        col.id === columnId ? { ...col, color: newColor } : col
      );

      // Update in IndexedDB
      await updateBoard(currentBoard.id, {
        ...currentBoard,
        columns: updatedColumns
      });

      // Update in Yjs if cloud board
      if (yjsEnabled && yjs.updateBoardColumns) {
        yjs.updateBoardColumns(updatedColumns);
      }

      // Reload board data for non-cloud boards
      if (!yjsEnabled) {
        await loadBoardData(currentBoardId);
      }

      // Refresh boards list so sidebar has updated board
      await loadBoards();
    } catch (error) {
      console.error('Error updating column color:', error);
      addNotification({
        type: 'error',
        title: 'Update Error',
        message: 'Failed to update column color'
      });
    }
  }

  async function handleDeleteColumn(columnId) {
    if (!currentBoard || isReadOnly) return;

    try {
      const updatedColumns = displayBoard.columns.filter(col => col.id !== columnId);

      // Delete all cards in this column
      const columnCards = cards.filter(c => c.status === columnId);
      for (const card of columnCards) {
        await deleteCard(card.id);
        if (yjsEnabled && yjs.deleteCard) {
          yjs.deleteCard(card.id);
        }
      }

      // Update in IndexedDB
      await updateBoard(currentBoard.id, {
        ...currentBoard,
        columns: updatedColumns
      });

      // Update in Yjs if cloud board
      if (yjsEnabled && yjs.updateBoardColumns) {
        yjs.updateBoardColumns(updatedColumns);
      }

      addNotification({
        type: 'success',
        title: 'Column Deleted',
        message: 'Column and its cards deleted successfully'
      });

      // Reload board data for non-cloud boards
      if (!yjsEnabled) {
        await loadBoardData(currentBoardId);
      }

      // Refresh boards list so sidebar has updated board
      await loadBoards();
    } catch (error) {
      console.error('Error deleting column:', error);
      addNotification({
        type: 'error',
        title: 'Delete Error',
        message: 'Failed to delete column'
      });
    }
  }

  async function handleCreateColumn() {
    if (!currentBoard || isReadOnly) return;
    setIsCreatingColumn(true);
  }

  async function handleSaveNewColumn() {
    if (!newColumnName.trim()) {
      setIsCreatingColumn(false);
      setNewColumnName('');
      return;
    }

    try {
      const newColumn = {
        id: `column-${Date.now()}`,
        title: newColumnName.trim(),
        color: '#3b82f6'
      };

      const updatedColumns = [...displayBoard.columns, newColumn];

      // Update in IndexedDB
      await updateBoard(currentBoard.id, {
        ...currentBoard,
        columns: updatedColumns
      });

      // Update in Yjs if cloud board
      if (yjsEnabled && yjs.updateBoardColumns) {
        yjs.updateBoardColumns(updatedColumns);
      }

      addNotification({
        type: 'success',
        title: 'Column Created',
        message: 'New column added successfully'
      });

      // Reload board data for non-cloud boards
      if (!yjsEnabled) {
        await loadBoardData(currentBoardId);
      }

      // Refresh boards list so sidebar has updated board with new column
      await loadBoards();

      setIsCreatingColumn(false);
      setNewColumnName('');
    } catch (error) {
      console.error('Error creating column:', error);
      addNotification({
        type: 'error',
        title: 'Create Error',
        message: 'Failed to create column'
      });
      setIsCreatingColumn(false);
      setNewColumnName('');
    }
  }

  function handleCancelNewColumn() {
    setIsCreatingColumn(false);
    setNewColumnName('');
  }

  function handleDragStart(card) {
    if (isReadOnly) return;

    setDraggedCard(card);

    // Set user interaction awareness for Yjs
    if (yjsEnabled && yjs.setUserInteraction) {
      yjs.setUserInteraction(card.id, 'dragging');
    }
  }

  function handleColumnDragStart(column) {
    setDraggedColumn(column);
  }

  function handleColumnDragOver(e, targetColumn) {
    e.preventDefault();
    if (draggedColumn && draggedColumn.id !== targetColumn.id) {
      setDraggedOverColumnPosition(targetColumn.id);
    }
  }

  async function handleColumnDrop(e, targetColumn) {
    e.preventDefault();
    setDraggedOverColumnPosition(null);

    if (!draggedColumn || !currentBoard || draggedColumn.id === targetColumn.id) {
      setDraggedColumn(null);
      return;
    }

    try {
      const columns = [...displayBoard.columns];
      const draggedIndex = columns.findIndex(col => col.id === draggedColumn.id);
      const targetIndex = columns.findIndex(col => col.id === targetColumn.id);

      if (draggedIndex === -1 || targetIndex === -1) {
        setDraggedColumn(null);
        return;
      }

      // Remove dragged column and insert at target position
      const [removed] = columns.splice(draggedIndex, 1);
      columns.splice(targetIndex, 0, removed);

      // Update in IndexedDB
      await updateBoard(currentBoard.id, {
        ...currentBoard,
        columns
      });

      // Update in Yjs if cloud board
      if (yjsEnabled && yjs.updateBoardColumns) {
        yjs.updateBoardColumns(columns);
      }

      addNotification({
        type: 'success',
        title: 'Column Moved',
        message: 'Column reordered successfully'
      });

      // Reload board data for non-cloud boards
      if (!yjsEnabled) {
        await loadBoardData(currentBoardId);
      }

      // Refresh boards list so sidebar has updated board
      await loadBoards();

      setDraggedColumn(null);
    } catch (error) {
      console.error('Error reordering columns:', error);
      addNotification({
        type: 'error',
        title: 'Reorder Error',
        message: 'Failed to reorder columns'
      });
      setDraggedColumn(null);
    }
  }

  function handleDragOver(e, columnId) {
    e.preventDefault();
    setDraggedOverColumn(columnId);
  }

  function handleDragLeave() {
    setDraggedOverColumn(null);
  }

  async function handleDrop(e, columnId) {
    e.preventDefault();
    setDraggedOverColumn(null);

    if (!draggedCard) return;

    // Clear user interaction awareness
    if (yjsEnabled && yjs.clearUserInteraction) {
      yjs.clearUserInteraction();
    }

    // Handle trash drop - delete the card
    if (columnId === '__trash__') {
      try {
        // Delete from IndexedDB
        await deleteCard(draggedCard.id);

        // Delete from Yjs if cloud board
        if (yjsEnabled && yjs.deleteCard) {
          yjs.deleteCard(draggedCard.id);
        }

        addNotification({
          type: 'success',
          title: 'Card Deleted',
          message: 'Card deleted successfully'
        });

        // Reload for non-cloud boards
        if (!yjsEnabled) {
          await loadBoardData(currentBoardId);
        }
        setDraggedCard(null);
      } catch (error) {
        console.error('Error deleting card:', error);
        addNotification({
          type: 'error',
          title: 'Delete Error',
          message: 'Failed to delete card'
        });
      }
      return;
    }

    try {
      // Get cards in target column
      const columnCards = cards.filter(c => c.status === columnId);
      const newPosition = columnCards.length;

      // Update in IndexedDB
      await moveCard(draggedCard.id, columnId, newPosition);
      await reorderCards(currentBoard.id, columnId, [...columnCards.map(c => c.id), draggedCard.id]);

      // Update in Yjs if cloud board
      if (yjsEnabled && yjs.moveCard) {
        yjs.moveCard(draggedCard.id, columnId, newPosition);
      }

      // Reload for non-cloud boards
      if (!yjsEnabled) {
        await loadBoardData(currentBoardId);
      }
      setDraggedCard(null);
    } catch (error) {
      console.error('Error moving card:', error);
      addNotification({
        type: 'error',
        title: 'Move Error',
        message: 'Failed to move card'
      });
    }
  }

  async function handleCreateBoard() {
    try {
      const newBoard = await createBoard({
        title: 'Untitled Board',
        category: 'General',
        columns: []
      });

      // Add to tabs and select
      const newTab = {
        id: newBoard.id,
        title: newBoard.title,
        category: newBoard.category || 'General',
        inCloud: newBoard.inCloud || false,
        type: 'board'
      };
      setOpenTabs(prev => (prev.some(t => t.id === newTab.id) ? prev : [...prev, newTab]));
      setCurrentBoardId(newBoard.id);

      addNotification({
        type: 'success',
        title: 'Board Created',
        message: 'Board created successfully'
      });

      await loadBoards();
    } catch (error) {
      console.error('Error creating board:', error);
      addNotification({
        type: 'error',
        title: 'Create Error',
        message: 'Failed to create board'
      });
    }
  }

  async function handleDeleteBoard(board) {
    setConfirmDialog({
      isOpen: true,
      title: 'Delete Board',
      message: `Are you sure you want to delete "${board.title}"?\n\nThis action cannot be undone.`,
      dangerous: true,
      onConfirm: async () => {
        try {
          await deleteBoard(board.id);
      addNotification({
        type: 'success',
        title: 'Board Deleted',
        message: 'Board deleted successfully'
      });

      // Remove from tabs if open
      const newTabs = openTabsRef.current.filter(tab => tab.id !== board.id);
      setOpenTabs(newTabs);

      // If deleted board was selected, clear selection or switch to another tab
      if (currentBoardId === board.id) {
        if (newTabs.length > 0) {
          setCurrentBoardId(newTabs[0].id);
        } else {
          setCurrentBoardId(null);
          setCurrentBoard(null);
          setLocalCards([]);
        }
      }

          await loadBoards();
        } catch (error) {
          console.error('Error deleting board:', error);
          addNotification({
            type: 'error',
            title: 'Delete Error',
            message: 'Failed to delete board'
          });
        }
      }
    });
  }

  async function handleDuplicateBoard(board) {
    try {
      const { duplicateBoard } = await import('../utils/kanban');
      const newBoard = await duplicateBoard(board.id);

      addNotification({
        type: 'success',
        title: 'Board Duplicated',
        message: `"${board.title}" has been duplicated`
      });

      await loadBoards();

      // Open the duplicated board in a new tab
      const newTab = {
        id: newBoard.id,
        title: newBoard.title,
        category: newBoard.category || 'General',
        inCloud: false,
        type: 'board'
      };
      setOpenTabs(prev => (prev.some(t => t.id === newTab.id) ? prev : [...prev, newTab]));
      setCurrentBoardId(newBoard.id);
    } catch (error) {
      console.error('Error duplicating board:', error);
      addNotification({
        type: 'error',
        title: 'Duplicate Error',
        message: 'Failed to duplicate board'
      });
    }
  }

  function handleBoardClick(board) {
    // Check if board is already in tabs
    const existingTab = openTabsRef.current.find(tab => tab.id === board.id);

    if (existingTab) {
      // Board already open, just switch to it
      setCurrentBoardId(board.id);
    } else {
      // Add board to tabs
      const newTab = {
        id: board.id,
        title: board.title,
        category: board.category || 'General',
        inCloud: board.inCloud || false,
        type: 'board'
      };
      setOpenTabs(prev => (prev.some(t => t.id === newTab.id) ? prev : [...prev, newTab]));
      setCurrentBoardId(board.id);
    }
  }

  function handleTabClick(tab) {
    setCurrentBoardId(tab.id);
  }

  function handleTabClose(tabId) {
    const tabIndex = openTabsRef.current.findIndex(tab => tab.id === tabId);
    const newTabs = openTabsRef.current.filter(tab => tab.id !== tabId);
    setOpenTabs(newTabs);

    // If closing current tab, switch to adjacent tab
    if (currentBoardIdRef.current === tabId) {
      if (newTabs.length === 0) {
        setCurrentBoardId(null);
        setCurrentBoard(null);
        setLocalCards([]);
      } else {
        // Switch to the tab that was to the left, or the new leftmost tab
        const newIndex = Math.max(0, tabIndex - 1);
        setCurrentBoardId(newTabs[newIndex].id);
      }
    }
  }

  function handleTabContextMenu(e, tabId) {
    e.preventDefault();
    e.stopPropagation();

    setTabContextMenuTarget(tabId);
    setTabContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowTabContextMenu(true);
  }

  async function handleAddKanbanAsAIContext() {
    if (!tabContextMenuTarget) return;

    const board = await getBoard(tabContextMenuTarget);
    if (board) {
      // Get cards for this board
      const cards = await getCards(board.id);

      // Open AI Chat sidebar first
      window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', {
        detail: { isOpen: true }
      }));

      // Add context after a short delay to ensure sidebar is mounted
      setTimeout(async () => {
        const { kanbanContextPayload } = await import('../utils/aiContext');
        window.dispatchEvent(new CustomEvent('addAIContext', {
          detail: { contextData: kanbanContextPayload(board, cards) }
        }));
      }, 100);
    }

    setShowTabContextMenu(false);
    setTabContextMenuTarget(null);
  }

  function handleCloseTabsToLeft(tabId) {
    const tabIndex = openTabsRef.current.findIndex(t => t.id === tabId);
    if (tabIndex > 0) {
      const newTabs = openTabsRef.current.slice(tabIndex);
      setOpenTabs(newTabs);
    }
    setShowTabContextMenu(false);
  }

  function handleCloseTabsToRight(tabId) {
    const tabIndex = openTabsRef.current.findIndex(t => t.id === tabId);
    if (tabIndex < openTabsRef.current.length - 1) {
      const newTabs = openTabsRef.current.slice(0, tabIndex + 1);
      setOpenTabs(newTabs);

      // If current tab was closed, switch to the target tab
      if (!newTabs.find(tab => tab.id === currentBoardIdRef.current)) {
        setCurrentBoardId(tabId);
      }
    }
    setShowTabContextMenu(false);
  }

  function handleCloseOtherTabs(tabId) {
    const targetTab = openTabsRef.current.find(tab => tab.id === tabId);
    if (targetTab) {
      setOpenTabs([targetTab]);
      setCurrentBoardId(tabId);
    }
    setShowTabContextMenu(false);
  }

  function handleCloseAllTabs() {
    setOpenTabs([]);
    setCurrentBoardId(null);
    setCurrentBoard(null);
    setLocalCards([]);
    setShowTabContextMenu(false);
  }

  async function handleBoardUpload(board) {
    try {
      const wasShared = !!board.inCloud;
      await uploadBoardToCentral(board);
      addNotification(wasShared
        ? { type: 'success', title: 'Changes Synced', message: `Your changes to "${board.title}" are now with the team` }
        : { type: 'success', title: 'Shared with the Team', message: `"${board.title}" is now shared with your team` });

      // Trigger board reload to update cloud status in UI
      // Use setTimeout to ensure IndexedDB transaction completes
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('boardUploadedToCloud', {
          detail: { boardId: board.id }
        }));
      }, 200);
    } catch (error) {
      console.error('Error uploading board:', error);
      addNotification({
        type: 'error',
        title: 'Upload Error',
        message: `Failed to upload board: ${error.message}`
      });
    }
  }

  async function handleBoardRemoveFromCloud(board) {
    try {
      await removeBoardFromCentral(board);
      addNotification({
        type: 'success',
        title: 'Stopped Sharing',
        message: `"${board.title}" is no longer shared`
      });

      // Trigger board reload to update cloud status in UI
      // Use setTimeout to ensure IndexedDB transaction completes
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('boardRemovedFromCloud', {
          detail: { boardId: board.id }
        }));
      }, 200);
    } catch (error) {
      console.error('Error removing board from cloud:', error);
      addNotification({
        type: 'error',
        title: 'Remove Error',
        message: `Failed to remove board: ${error.message}`
      });
    }
  }

  async function handleRenameCategory(oldName, newName) {
    try {
      await renameCategory(oldName, newName);
      await loadBoards();
      addNotification({
        type: 'success',
        title: 'Category Renamed',
        message: `Category "${oldName}" renamed to "${newName}"`
      });
    } catch (error) {
      console.error('Error renaming category:', error);
      addNotification({
        type: 'error',
        title: 'Rename Error',
        message: 'Failed to rename category'
      });
    }
  }

  async function handleUpdateBoardCategory(board, newCategory) {
    try {
      await updateBoardCategory(board.id, newCategory);

      // Update tab category if board is open
      const tabIndex = openTabsRef.current.findIndex(tab => tab.id === board.id);
      if (tabIndex !== -1) {
        const newTabs = [...openTabsRef.current];
        newTabs[tabIndex] = {
          ...newTabs[tabIndex],
          category: newCategory || 'General'
        };
        setOpenTabs(newTabs);
      }

      await loadBoards();
      if (currentBoardId === board.id) {
        await loadBoardData(board.id);
      }
      addNotification({
        type: 'success',
        title: 'Board Moved',
        message: `"${board.title}" moved to "${newCategory}"`
      });
    } catch (error) {
      console.error('Error moving board:', error);
      addNotification({
        type: 'error',
        title: 'Move Error',
        message: 'Failed to move board'
      });
    }
  }

  function handleToggleSelectionMode() {
    setSelectionMode(!selectionMode);
    setSelectedBoards([]);
  }

  function handleToggleBoardSelection(boardId) {
    setSelectedBoards(prev =>
      prev.includes(boardId)
        ? prev.filter(id => id !== boardId)
        : [...prev, boardId]
    );
  }

  async function handleBulkDelete() {
    if (selectedBoards.length === 0) return;

    const count = selectedBoards.length;
    const plural = count !== 1 ? 's' : '';

    setConfirmDialog({
      isOpen: true,
      title: 'Delete Boards',
      message: `Are you sure you want to delete ${count} board${plural}?\n\nThis action cannot be undone.`,
      dangerous: true,
      onConfirm: async () => {
        try {
          for (const boardId of selectedBoards) {
            await deleteBoard(boardId);
          }

          addNotification({
            type: 'success',
            title: 'Boards Deleted',
            message: `${count} board${plural} deleted successfully`
          });

          setSelectedBoards([]);
          setSelectionMode(false);
          await loadBoards();
        } catch (error) {
          console.error('Error deleting boards:', error);
          addNotification({
            type: 'error',
            title: 'Delete Error',
            message: 'Failed to delete boards'
          });
        }
      }
    });
  }

  function handleBulkMove() {
    if (selectedBoards.length === 0) return;

    setMoveCategoryName('');
    setShowMoveCategoryModal(true);
  }

  async function performBulkMove() {
    const category = moveCategoryName;
    if (!category) return;

    setShowMoveCategoryModal(false);

    try {
      for (const boardId of selectedBoards) {
        await updateBoardCategory(boardId, category);
      }

      addNotification({
        type: 'success',
        title: 'Boards Moved',
        message: `${selectedBoards.length} board${selectedBoards.length !== 1 ? 's' : ''} moved to "${category}"`
      });

      setSelectedBoards([]);
      setSelectionMode(false);
      await loadBoards();
    } catch (error) {
      console.error('Error moving boards:', error);
      addNotification({
        type: 'error',
        title: 'Move Error',
        message: 'Failed to move boards'
      });
    }
  }

  function handleSortChange(newSortBy) {
    setSortBy(newSortBy);
  }

  // "Import from JSON" opens the shared ImportJsonModal (paste or file, Dry
  // Run); the boards it validates are created as the old file picker did
  function handleImport() {
    setShowImportModal(true);
  }

  async function importBoardsFromJson(items, { mergeMode = false } = {}) {
    try {
      const result = await runBoardsImport(items, { mergeMode });
      addNotification({
        type: result.totals.invalid && !(result.totals.created + result.totals.updated + result.totals.filled) ? 'error' : 'success',
        title: result.totals.invalid ? 'Import Finished With Errors' : 'Import Successful',
        message: jsonImportMessage(result, { noun: 'board', plural: 'boards' })
      });
      await loadBoards();
    } catch (error) {
      console.error('Import failed:', error);
      addNotification({
        type: 'error',
        title: 'Import Failed',
        message: error.message
      });
    }
  }

  function handleExport() {
    try {
      const dataStr = JSON.stringify(boards, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `kanban-boards-${new Date().toISOString().split('T')[0]}.json`;
      link.click();
      URL.revokeObjectURL(url);

      addNotification({
        type: 'success',
        title: 'Export Successful',
        message: `Exported ${boards.length} board${boards.length !== 1 ? 's' : ''}`
      });
    } catch (error) {
      console.error('Export failed:', error);
      addNotification({
        type: 'error',
        title: 'Export Failed',
        message: 'Failed to export boards'
      });
    }
  }

  // Sort boards based on sortBy
  const sortedBoards = [...boards].sort((a, b) => {
    if (sortBy === 'title') {
      return a.title.localeCompare(b.title);
    } else {
      // Sort by date (updatedAt)
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    }
  });

  return (
    <div className="flex h-full overflow-hidden font-text">
      {/* Board List Sidebar */}
      {(innerSidebarVisible || isMobile) && (
        <ResizableSidebar
          defaultWidth={250}
          minWidth={200}
          maxWidth={400}
          storageKey="kanban-sidebar-width"
        >
          <KanbanBoardList
            boards={sortedBoards}
            currentBoardId={currentBoardId}
            onBoardClick={handleBoardClick}
            onBoardCreate={handleCreateBoard}
            onBoardDelete={handleDeleteBoard}
            onBoardDuplicate={handleDuplicateBoard}
            onBoardUpload={handleBoardUpload}
            onBoardSync={handleBoardUpload}
            onBoardRemoveFromCloud={handleBoardRemoveFromCloud}
            onRenameCategory={handleRenameCategory}
            onUpdateBoardCategory={handleUpdateBoardCategory}
            currentMachineId={currentMachineId}
            selectionMode={selectionMode}
            selectedBoards={selectedBoards}
            onToggleSelectionMode={handleToggleSelectionMode}
            onToggleBoardSelection={handleToggleBoardSelection}
            onBulkDelete={handleBulkDelete}
            onBulkMove={handleBulkMove}
            centralServerStatus={centralServerStatus}
            sortBy={sortBy}
            onSortChange={handleSortChange}
            onImport={handleImport}
            onExport={handleExport}
            currentBoardIsReadOnly={isReadOnly}
          />
        </ResizableSidebar>
      )}

      {/* Main Board Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Tab Bar (on a phone it is the page header, tabs or not) */}
        {(openTabs.length > 0 || isMobile) && (
          <TabBar
            tabs={openTabs}
            activeTabId={currentBoardId}
            onTabClick={handleTabClick}
            onTabClose={handleTabClose}
            onTabContextMenu={handleTabContextMenu}
            pageTitle="Kanban"
          />
        )}

        {/* Read-only banner for boards shared by someone else */}
        {isReadOnly && currentBoard?.inCloud && !isOnline && (
          <div className="px-4 py-2 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-200 text-sm flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" />
            </svg>
            <span className="font-medium">Offline - Read Only</span>
            <span>Shared boards require an online connection for editing. Reconnect to make changes.</span>
          </div>
        )}

        {isReadOnly && currentBoard?.inCloud && isOnline && (
          <div className="px-4 py-2 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-200 text-sm flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span className="font-medium">Read-only:</span>
            <span>This board is shared by another team member. You can view but not edit.</span>
          </div>
        )}

        {/* Tab Context Menu */}
        {showTabContextMenu && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setShowTabContextMenu(false)}
            />
            <div
              ref={tabContextMenuRef}
              className="fixed z-20 bg-os-card border border-os-border shadow-lg rounded-md py-1 min-w-[180px]"
              style={{
                top: `${tabContextMenuPosition.y}px`,
                left: `${tabContextMenuPosition.x}px`
              }}
            >
              {/* Add as AI Context */}
              <button
                onClick={handleAddKanbanAsAIContext}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="aiContext" />
                Add as AI Context
              </button>

              <div className="border-t border-os-border my-1"></div>

              {/* Copy Name */}
              <button
                onClick={() => {
                  const tab = openTabsRef.current.find(t => t.id === tabContextMenuTarget);
                  if (tab) {
                    navigator.clipboard.writeText(tab.title || '');
                  }
                  setShowTabContextMenu(false);
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="copyText" />
                Copy Name
              </button>

              <div className="border-t border-os-border my-1"></div>

              {/* Tab Close Options */}
              <button
                onClick={() => {
                  handleTabClose(tabContextMenuTarget);
                  setShowTabContextMenu(false);
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="closeTab" />
                Close This Tab
              </button>
              <button
                onClick={() => handleCloseTabsToLeft(tabContextMenuTarget)}
                disabled={openTabsRef.current.findIndex(t => t.id === tabContextMenuTarget) === 0}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <MenuItemIcon action="closeTab" />
                Close Tabs to Left
              </button>
              <button
                onClick={() => handleCloseTabsToRight(tabContextMenuTarget)}
                disabled={openTabsRef.current.findIndex(t => t.id === tabContextMenuTarget) === openTabsRef.current.length - 1}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <MenuItemIcon action="closeTab" />
                Close Tabs to Right
              </button>
              <button
                onClick={() => handleCloseOtherTabs(tabContextMenuTarget)}
                disabled={openTabsRef.current.length === 1}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <MenuItemIcon action="closeTab" />
                Close Other Tabs
              </button>
              <button
                onClick={() => handleCloseAllTabs()}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="closeTab" />
                Close All Tabs
              </button>
            </div>
          </>
        )}

        {openTabs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Trello size={64} className="text-os-text-muted mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-os-text-primary mb-2">
                No Boards Open
              </h2>
              <p className="text-os-text-muted mb-4">
                {boards.length === 0
                  ? 'Create a new board to get started'
                  : 'Select a board from the sidebar to open it'}
              </p>
              {boards.length === 0 && (
                <button
                  onClick={handleCreateBoard}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover rounded-sm transition-colors shadow-xs"
                >
                  Create Board
                </button>
              )}
            </div>
          </div>
        ) : !currentBoard ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Trello size={64} className="text-os-text-muted mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-os-text-primary mb-2">
                Loading Board...
              </h2>
            </div>
          </div>
        ) : (
          <>
            {/* Kanban Columns (on a phone one per screen, swiped: scroll-snap in
                src/mobile.css, the next column peeking in at the right edge) */}
            <div ref={columnsScrollRef} className="sc-kanban-columns flex-1 overflow-x-auto overflow-y-hidden p-6 bg-os-card-secondary">
              <div className="flex gap-4 h-full min-w-max">
                {displayBoard.columns.map(column => {
                  const columnCards = cards
                    .filter(c => c.status === column.id)
                    .sort((a, b) => (a.position || 0) - (b.position || 0));

                  return (
                    <KanbanColumn
                      key={column.id}
                      column={column}
                      cards={columnCards}
                      onCreateCard={() => handleCreateCard(column.id)}
                      onDeleteCard={handleDeleteCard}
                      onRenameCard={handleRenameCard}
                      onUpdateCardDescription={handleUpdateCardDescription}
                      onUpdateCard={handleUpdateCard}
                      onDragStart={handleDragStart}
                      onDragOver={(e) => handleDragOver(e, column.id)}
                      onDragLeave={handleDragLeave}
                      onDrop={(e) => handleDrop(e, column.id)}
                      isDraggedOver={draggedOverColumn === column.id}
                      onRenameColumn={handleRenameColumn}
                      onUpdateColumnColor={handleUpdateColumnColor}
                      onDeleteColumn={handleDeleteColumn}
                      onColumnDragStart={handleColumnDragStart}
                      onColumnDragOver={handleColumnDragOver}
                      onColumnDrop={handleColumnDrop}
                      isColumnDraggedOver={draggedOverColumnPosition === column.id}
                      userInteractions={yjsEnabled ? yjs.userInteractions : {}}
                      connectedUsers={connectedUsers}
                      isReadOnly={isReadOnly}
                    />
                  );
                })}

                {/* Add Column Button and Trash Column */}
                <div className="w-80 shrink-0 flex flex-col gap-4">
                  {/* Add Column Button or Input */}
                  {!isReadOnly && (
                    isCreatingColumn ? (
                      <div className="bg-os-card-secondary rounded-lg border border-os-border p-4">
                        <input
                          type="text"
                          value={newColumnName}
                          onChange={(e) => setNewColumnName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleSaveNewColumn();
                            } else if (e.key === 'Escape') {
                              handleCancelNewColumn();
                            }
                          }}
                          onBlur={handleSaveNewColumn}
                          autoFocus
                          placeholder="Enter column name..."
                          className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-input-border rounded-sm focus:ring-1 focus:ring-purple-500 focus:border-purple-500 outline-hidden text-os-text-primary"
                        />
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={handleSaveNewColumn}
                            className="flex-1 px-3 py-1.5 bg-os-card border border-os-border text-sm rounded-sm hover:bg-os-card-secondary text-os-text-primary"
                          >
                            Add
                          </button>
                          <button
                            onClick={handleCancelNewColumn}
                            className="flex-1 px-3 py-1.5 bg-os-card border border-os-border text-sm rounded-sm hover:bg-os-card-secondary text-os-text-secondary"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={handleCreateColumn}
                        className="bg-os-card-secondary hover:bg-os-card-secondary border-2 border-dashed border-os-border hover:border-os-text-secondary transition-all p-4 flex items-center justify-center gap-2 text-os-text-secondary hover:text-os-text-primary"
                      >
                        <span className="font-medium">Add Column</span>
                      </button>
                    )
                  )}

                  {/* Trash Column */}
                  <div
                  onDragOver={(e) => handleDragOver(e, '__trash__')}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, '__trash__')}
                  className={`flex-1 bg-os-card-secondary rounded-lg border-2 border-dashed transition-all ${
 draggedOverColumn ==='__trash__'
 ?'border-red-400 bg-os-card-secondary'
 :'border-os-border'
 }`}
                >
                  <div className="p-4 border-b border-os-border bg-os-card">
                    <div className="flex items-center justify-center gap-2">
                      <Trash size={16} className="text-os-text-secondary" />
                      <h3 className="font-semibold text-sm text-os-text-primary">Delete Card</h3>
                    </div>
                  </div>
                  <div className="p-4 h-full flex items-center justify-center">
                    <div className="text-center text-os-text-muted">
                      <Trash size={48} className="mx-auto mb-2 opacity-30" />
                      <p className="text-sm font-medium">Drop here to delete</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            </div>
          </>
        )}
      </div>

      {/* Confirmation Modal */}
      <ConfirmationModal
        isOpen={confirmDialog.isOpen}
        onClose={() => setConfirmDialog({ ...confirmDialog, isOpen: false })}
        onConfirm={confirmDialog.onConfirm}
        title={confirmDialog.title}
        message={confirmDialog.message}
        dangerous={confirmDialog.dangerous}
      />

      {/* Bulk Move Category Modal (replaces native prompt) */}
      <FormModal
        isOpen={showMoveCategoryModal}
        onClose={() => setShowMoveCategoryModal(false)}
        title="Move Boards"
        size="sm"
        onSubmit={performBulkMove}
        footer={
          <>
            <button
              onClick={() => setShowMoveCategoryModal(false)}
              className="px-4 py-2 text-sm bg-os-card hover:bg-os-card-secondary text-os-text-secondary border border-os-border rounded-sm transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={performBulkMove}
              disabled={!moveCategoryName}
              className="px-4 py-2 text-sm bg-os-blue hover:bg-os-blue-hover text-white rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Move
            </button>
          </>
        }
      >
        <div>
          <label className="block text-xs text-os-text-secondary mb-1">
            Enter category name:
          </label>
          <input
            type="text"
            value={moveCategoryName}
            onChange={(e) => setMoveCategoryName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && moveCategoryName) {
                e.preventDefault();
                performBulkMove();
              }
            }}
            className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-os-blue"
            placeholder="e.g., Work"
            autoFocus
          />
        </div>
      </FormModal>

      {/* Import from JSON (the board list's menu) */}
      <ImportJsonModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        title="Import Boards"
        description={'Upload a JSON file or paste JSON data: an array of boards, as "Export All (JSON)" writes it. Dry Run checks the data and shows what would be imported without writing anything.'}
        importLabel="Import Boards"
        validateFn={validateBoardsImport}
        onDryRun={(items, { mergeMode }) => runBoardsImport(items, { dryRun: true, mergeMode })}
        renderStats={(result) => <JsonImportStats result={result} noun="board" importLabel="Import Boards" />}
        onValidated={(items, { mergeMode }) => { importBoardsFromJson(items, { mergeMode }); }}
        mergeLabel={jsonMergeLabel('boards')}
        mergeHint={(checked) => jsonMergeHint(checked, { noun: 'board', plural: 'boards', keyLabel: 'title and category' })}
        exampleData={[
          { title: 'Example Board', category: 'General', columns: [{ id: 'todo', title: 'To Do' }, { id: 'doing', title: 'In Progress' }, { id: 'done', title: 'Done' }] },
        ]}
      />
    </div>
  );
}
