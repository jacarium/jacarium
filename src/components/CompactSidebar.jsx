import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Search, FileText, Activity, Workflow, FileText as NotesIcon, Bot, Brain, Bell, MessageSquare, Menu, Trello, CheckSquare, Calendar, Wrench, MoreHorizontal, ExternalLink, PanelLeft, PanelRight, Trash2 } from 'lucide-react';
import { isDesktopApp, openStandalonePage } from '../utils/platform';
import BrandMark from '../brand/BrandMark';
import { openAppSettings } from '../utils/openSettings';

// Utility buttons under the page navigation (the sidebar collapses what
// does not fit the window height behind "More"). Settings is not one of
// them: the desktop app opens it from its menu (Cmd/Ctrl+,), a browser
// from the Documents page's hamburger menu.
const UTILITY_ITEM_COUNT = 6;
import ImportDBModal from './common/modals/ImportDBModal';
import ExportProgressModal from './common/ExportProgressModal';
import SettingsModal from './common/modals/SettingsModal';
import ConfirmationModal from './common/modals/ConfirmationModal';
import { useNotifications } from '../contexts/NotificationContext';
import { useChat } from '../contexts/ChatContext';
import { useTheme, GRADIENT_THEMES } from '../contexts/ThemeContext';
import { useContextMenu } from '../hooks/useContextMenu';
import { useExportFlow } from '../hooks/useExportFlow';

export default function CompactSidebar({ currentPage, onPageChange }) {
  const [isAIChatOpen, setIsAIChatOpen] = useState(false);
  const [isQuizOpen, setIsQuizOpen] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showWipeConfirmModal, setShowWipeConfirmModal] = useState(false);
  const [showAppSettingsModal, setShowAppSettingsModal] = useState(false);
  const [isChatSidebarOpen, setIsChatSidebarOpen] = useState(false);
  const [isNotificationSidebarOpen, setIsNotificationSidebarOpen] = useState(false);
  const [isDraftSidebarOpen, setIsDraftSidebarOpen] = useState(false);
  const [innerSidebarVisible, setInnerSidebarVisible] = useState(() => {
    const saved = localStorage.getItem('innerSidebarVisible');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showUtilityMoreMenu, setShowUtilityMoreMenu] = useState(false);
  // Dropdown anchor positions, captured from the trigger button's rect at
  // open time (reading refs during render is not allowed)
  const [moreMenuPos, setMoreMenuPos] = useState({ left: 0, top: 0 });
  const [utilityMoreMenuPos, setUtilityMoreMenuPos] = useState({ left: 0, top: 0 });
  // Shared right-click context menu for the nav icons; `type` is the item's
  // page id ('tools', 'diagnostics', ...). Clamps to the viewport and handles
  // outside-click/Escape closing internally.
  const { contextMenu, contextMenuRef, openContextMenu, closeContextMenu, isContextMenuType } = useContextMenu();
  const [visibleNavCount, setVisibleNavCount] = useState(9); // Start with all items visible
  const [visibleUtilityCount, setVisibleUtilityCount] = useState(UTILITY_ITEM_COUNT); // Start with all utility items visible

  const settingsMenuRef = useRef(null);
  const settingsButtonRef = useRef(null);
  const moreMenuRef = useRef(null);
  const moreButtonRef = useRef(null);
  const utilityMoreMenuRef = useRef(null);
  const utilityMoreButtonRef = useRef(null);
  const navContainerRef = useRef(null);
  const { history, addNotification, clearHistory } = useNotifications();
  // the bell's right-click: Clear All Notifications, confirmed first
  const [showClearNotificationsModal, setShowClearNotificationsModal] = useState(false);
  const { unreadMentions } = useChat();
  const { theme } = useTheme();
  // File > Database > Export runs under the shared Export Progress modal
  const exportFlow = useExportFlow();

  // Check if current theme is a gradient theme
  const isGradientTheme = theme && theme.startsWith('gradient-');
  const gradientConfig = isGradientTheme ? GRADIENT_THEMES[theme] : null;

  // The side each panel is on, or remembered for its next opening (JQLBuilder
  // sends it with every open state): the menu item reads "Open on the right"
  // or "Move to the left" accordingly
  const [panelSides, setPanelSides] = useState({ aiChat: 'left', draft: 'left', chat: 'left' });
  const noteSide = (key, event) => setPanelSides((prev) => {
    if (!event.detail || !('side' in event.detail)) return prev;
    const side = event.detail.side === 'right' ? 'right' : 'left';
    return prev[key] === side ? prev : { ...prev, [key]: side };
  });
  useEffect(() => {
    function handleAIChatStateChange(event) {
      setIsAIChatOpen(event.detail.isOpen);
      noteSide('aiChat', event);
    }

    function handleQuizStateChange(event) {
      setIsQuizOpen(event.detail.isOpen);
    }

    function handleChatSidebarStateChange(event) {
      setIsChatSidebarOpen(event.detail.isOpen);
      noteSide('chat', event);
    }

    function handleNotificationSidebarStateChange(event) {
      setIsNotificationSidebarOpen(event.detail.isOpen);
    }

    function handleDraftSidebarStateChange(event) {
      setIsDraftSidebarOpen(event.detail.isOpen);
      noteSide('draft', event);
    }

    window.addEventListener('aiChatSidebarStateChange', handleAIChatStateChange);
    window.addEventListener('quizStateChange', handleQuizStateChange);
    window.addEventListener('chatSidebarStateChange', handleChatSidebarStateChange);
    window.addEventListener('notificationSidebarStateChange', handleNotificationSidebarStateChange);
    window.addEventListener('draftSidebarStateChange', handleDraftSidebarStateChange);

    return () => {
      window.removeEventListener('aiChatSidebarStateChange', handleAIChatStateChange);
      window.removeEventListener('quizStateChange', handleQuizStateChange);
      window.removeEventListener('chatSidebarStateChange', handleChatSidebarStateChange);
      window.removeEventListener('notificationSidebarStateChange', handleNotificationSidebarStateChange);
      window.removeEventListener('draftSidebarStateChange', handleDraftSidebarStateChange);
    };
  }, []);

  // Save inner sidebar visibility and dispatch event
  useEffect(() => {
    localStorage.setItem('innerSidebarVisible', JSON.stringify(innerSidebarVisible));
    window.dispatchEvent(new CustomEvent('innerSidebarVisibilityChange', { detail: { visible: innerSidebarVisible } }));
  }, [innerSidebarVisible]);

  // Close settings menu on outside click
  useEffect(() => {
    if (!showSettingsMenu) return;

    function handleClickOutside(e) {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target) &&
          settingsButtonRef.current && !settingsButtonRef.current.contains(e.target)) {
        setShowSettingsMenu(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSettingsMenu]);

  // Close more menu on outside click
  useEffect(() => {
    if (!showMoreMenu) return;

    function handleClickOutside(e) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target) &&
          moreButtonRef.current && !moreButtonRef.current.contains(e.target)) {
        setShowMoreMenu(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMoreMenu]);

  // Keep the More menu on-screen: nudge it left/up if it would overflow the
  // viewport's right or bottom edge, measured against its actual rendered size.
  useLayoutEffect(() => {
    if (!showMoreMenu || !moreMenuRef.current) return;
    const menuRect = moreMenuRef.current.getBoundingClientRect();
    const margin = 8;
    let { left, top } = moreMenuPos;
    if (menuRect.right > window.innerWidth - margin) {
      left = Math.max(margin, left - (menuRect.right - window.innerWidth + margin));
    }
    if (menuRect.bottom > window.innerHeight - margin) {
      top = Math.max(margin, top - (menuRect.bottom - window.innerHeight + margin));
    }
    if (left !== moreMenuPos.left || top !== moreMenuPos.top) {
      setMoreMenuPos({ left, top });
    }
  }, [showMoreMenu, moreMenuPos]);

  // Close utility more menu on outside click
  useEffect(() => {
    if (!showUtilityMoreMenu) return;

    function handleClickOutside(e) {
      if (utilityMoreMenuRef.current && !utilityMoreMenuRef.current.contains(e.target) &&
          utilityMoreButtonRef.current && !utilityMoreButtonRef.current.contains(e.target)) {
        setShowUtilityMoreMenu(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showUtilityMoreMenu]);

  // Keep the utility More menu on-screen: nudge it left/up if it would overflow
  // the viewport's right or bottom edge, measured against its actual rendered size.
  useLayoutEffect(() => {
    if (!showUtilityMoreMenu || !utilityMoreMenuRef.current) return;
    const menuRect = utilityMoreMenuRef.current.getBoundingClientRect();
    const margin = 8;
    let { left, top } = utilityMoreMenuPos;
    if (menuRect.right > window.innerWidth - margin) {
      left = Math.max(margin, left - (menuRect.right - window.innerWidth + margin));
    }
    if (menuRect.bottom > window.innerHeight - margin) {
      top = Math.max(margin, top - (menuRect.bottom - window.innerHeight + margin));
    }
    if (left !== utilityMoreMenuPos.left || top !== utilityMoreMenuPos.top) {
      setUtilityMoreMenuPos({ left, top });
    }
  }, [showUtilityMoreMenu, utilityMoreMenuPos]);

  // Calculate how many nav and utility items can fit based on available height
  useEffect(() => {
    function calculateVisibleItems() {
      if (!navContainerRef.current) return;

      const containerHeight = window.innerHeight;
      const buttonHeight = 48; // h-12 = 48px
      const gap = 4; // gap-1 = 4px
      const padding = 16; // py-4 = 16px top + 16px bottom
      const brandHeight = 56; // the mark (44) + its margin and the separator above the items

      // Total items
      const totalNavItems = 9;
      const totalUtilityItems = UTILITY_ITEM_COUNT; // Quiz, AI Chat, Quick Notes, Team Chat, Notifications, Toggle Sidebar

      // Start by assuming we can show all items
      let navCount = totalNavItems;
      let utilityCount = totalUtilityItems;

      // Calculate minimum required height for all items
      const navHeight = navCount * buttonHeight + (navCount - 1) * gap;
      const utilityHeight = utilityCount * buttonHeight + (utilityCount - 1) * gap;
      const requiredHeight = padding + brandHeight + navHeight + gap + utilityHeight;

      if (requiredHeight > containerHeight) {
        // Not enough space, need to collapse items
        const availableHeight = containerHeight - padding - brandHeight - gap;

        // Try to distribute space between nav and utility sections
        // Priority: Try to keep at least some items in each section
        let currentNavCount = totalNavItems;
        let currentUtilityCount = totalUtilityItems;

        while (currentNavCount > 0 || currentUtilityCount > 0) {
          const navNeedsMore = currentNavCount > 1;
          const utilityNeedsMore = currentUtilityCount > 1;

          // Calculate current height needed
          const navSectionHeight = (currentNavCount > 0 ? currentNavCount : 0) * buttonHeight + Math.max(0, currentNavCount - 1) * gap;
          const utilitySectionHeight = (currentUtilityCount > 0 ? currentUtilityCount : 0) * buttonHeight + Math.max(0, currentUtilityCount - 1) * gap;
          const totalNeeded = navSectionHeight + utilitySectionHeight;

          if (totalNeeded <= availableHeight) {
            // Found a fit
            navCount = currentNavCount;
            utilityCount = currentUtilityCount;
            break;
          }

          // Reduce from the section with more items
          if (navNeedsMore && utilityNeedsMore) {
            // Both need more, reduce from the larger one
            if (currentNavCount >= currentUtilityCount) {
              currentNavCount--;
            } else {
              currentUtilityCount--;
            }
          } else if (navNeedsMore) {
            currentNavCount--;
          } else if (utilityNeedsMore) {
            currentUtilityCount--;
          } else {
            break;
          }
        }

        // If we need to collapse, reserve one spot for More button in each section
        setVisibleNavCount(navCount > 0 && navCount < totalNavItems ? Math.max(1, navCount - 1) : navCount);
        setVisibleUtilityCount(utilityCount > 0 && utilityCount < totalUtilityItems ? Math.max(1, utilityCount - 1) : utilityCount);
      } else {
        // Everything fits
        setVisibleNavCount(totalNavItems);
        setVisibleUtilityCount(totalUtilityItems);
      }
    }

    calculateVisibleItems();
    window.addEventListener('resize', calculateVisibleItems);
    return () => window.removeEventListener('resize', calculateVisibleItems);
  }, []);

  function handleToggleDraft() {
    window.dispatchEvent(new CustomEvent('toggleDraftSidebar'));
  }

  function handleToggleAIChat() {
    window.dispatchEvent(new CustomEvent('toggleAIChatSidebar'));
  }

  function handleToggleQuiz() {
    window.dispatchEvent(new CustomEvent('toggleQuiz'));
  }

  function handleToggleChat() {
    window.dispatchEvent(new CustomEvent('toggleChatSidebar'));
  }

  function handleToggleNotifications() {
    window.dispatchEvent(new CustomEvent('toggleNotificationSidebar'));
  }

  function handleToggleInnerSidebar() {
    setInnerSidebarVisible(prev => !prev);
    setShowSettingsMenu(false);
  }

  // The export itself lives in src/utils/exportDatabase.js; this just runs
  // it as a job under the Export Progress modal so the UI shows live
  // per-table / per-media-file / per-section progress instead of freezing.
  function handleExportDB() {
    setShowSettingsMenu(false);
    exportFlow.startExport({
      title: 'Export Database',
      description: 'Full backup of all local data → JSON',
      run: async (onProgress) => {
        const { exportDatabase } = await import('../utils/exportDatabase');
        return exportDatabase(onProgress);
      },
      onError: (error) => {
        addNotification({
          type: 'error',
          title: 'Export Failed',
          message: 'Failed to export database: ' + error.message
        });
      },
    });
  }

  function handleImportDB() {
    setShowSettingsMenu(false);
    setShowImportModal(true);
  }

  function handleWipeDB() {
    setShowSettingsMenu(false);
    setShowWipeConfirmModal(true);
  }

  // Handle IPC events from Electron menu
  useEffect(() => {
    if (!window.electronAPI) return;

    const cleanupExport = window.electronAPI.onExportDatabase(handleExportDB);
    const cleanupImport = window.electronAPI.onImportDatabase(handleImportDB);
    const cleanupWipe = window.electronAPI.onWipeDatabase(handleWipeDB);
    const cleanupSettings = window.electronAPI.onOpenSettings(() => setShowAppSettingsModal(true));
    const cleanupSidebar = window.electronAPI.onToggleSidebar(handleToggleInnerSidebar);

    return () => {
      cleanupExport();
      cleanupImport();
      cleanupWipe();
      cleanupSettings();
      cleanupSidebar();
    };
    // Intentional mount-only IPC subscription; the handlers only touch
    // state setters (stable) so re-subscribing per render would only churn
    // the Electron listener registrations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function performWipeDB() {
    try {
      // getDocumentsMetadata: wipe only needs document ids, not content
      const { deleteDocument, getDocumentsMetadata } = await import('../utils/documents');
      const { deleteDocumentTemplate, getDocumentTemplates } = await import('../utils/documentTemplates');
      const { deleteTemplate, getTemplates } = await import('../templates/jqlTemplates');
      const { deleteEngineTemplate, getEngineTemplates } = await import('../utils/engineTemplates');
      const { deleteWorkflow, getWorkflows } = await import('../utils/workflows');
      const { deleteBoard, getBoards } = await import('../utils/kanban');
      const { deleteTask, getTasks } = await import('../utils/tasks');
      const { deleteInstance, getAllInstances } = await import('../utils/taskwarriorInstances');
      const { deleteCustomReport, getCustomReports } = await import('../utils/customReports');
      const { deleteDocumentCategory, getDocumentCategories } = await import('../utils/documentCategories');
      const { deleteSSHCommand, getSSHCommands } = await import('../utils/sshCommands');
      const { getAllCustomGrids, getAllCustomQuizzes, deleteCustomGrid, deleteCustomQuiz } = await import('../utils/customContentDB');
      const { getOpenshiftTemplates, deleteOpenshiftTemplate } = await import('../utils/openshiftTemplates');

      // Get all data
      const [documents, documentTemplates, jqlTemplates, engineTemplates, workflows, kanbanBoards, tasks, taskwarriorInstances, customReports, documentCategories, sshCommands, customGrids, customQuizzes, openshiftTemplates] = await Promise.all([
        getDocumentsMetadata(),
        getDocumentTemplates(),
        getTemplates(),
        getEngineTemplates(),
        getWorkflows(),
        getBoards(),
        getTasks(),
        getAllInstances(),
        getCustomReports(),
        getDocumentCategories(),
        getSSHCommands(),
        getAllCustomGrids(),
        getAllCustomQuizzes(),
        getOpenshiftTemplates()
      ]);

      // Delete all documents
      for (const doc of documents) {
        await deleteDocument(doc.id);
      }

      // Delete all document templates
      for (const template of documentTemplates) {
        await deleteDocumentTemplate(template.id);
      }

      // Delete all JQL templates
      for (const template of jqlTemplates) {
        await deleteTemplate(template.id);
      }

      // Delete all engine templates
      for (const template of engineTemplates) {
        await deleteEngineTemplate(template.id);
      }

      // Delete all workflows
      for (const workflow of workflows) {
        await deleteWorkflow(workflow.id);
      }

      // Delete all kanban boards (cards will be deleted automatically)
      for (const board of kanbanBoards) {
        await deleteBoard(board.id);
      }

      // Delete all tasks
      for (const task of tasks) {
        await deleteTask(task.id, true); // true = hard delete
      }

      // Delete all TaskWarrior instances
      for (const instance of taskwarriorInstances) {
        await deleteInstance(instance.id);
      }

      // Delete all custom reports
      for (const report of customReports) {
        await deleteCustomReport(report.id);
      }

      // Delete all document categories
      for (const category of documentCategories) {
        await deleteDocumentCategory(category.id);
      }

      // Delete all SSH commands
      for (const command of sshCommands) {
        await deleteSSHCommand(command.id);
      }

      // Delete all custom grids
      for (const grid of customGrids) {
        await deleteCustomGrid(grid.id);
      }

      // Delete all custom quizzes
      for (const quiz of customQuizzes) {
        await deleteCustomQuiz(quiz.id);
      }

      // Delete all OpenShift templates
      for (const template of openshiftTemplates) {
        await deleteOpenshiftTemplate(template.id);
      }

      // Clear localStorage
      const keysToKeep = ['aiChatSettings']; // Keep AI settings
      const allKeys = Object.keys(localStorage);
      allKeys.forEach(key => {
        if (!keysToKeep.includes(key)) {
          localStorage.removeItem(key);
        }
      });

      addNotification({
        type: 'success',
        title: 'Database Wiped',
        message: 'Database wiped successfully! The page will now reload.'
      });
      setTimeout(() => window.location.reload(), 1000);
    } catch (error) {
      console.error('Failed to wipe database:', error);
      addNotification({
        type: 'error',
        title: 'Wipe Failed',
        message: 'Failed to wipe database: ' + error.message
      });
    }
  }

  // Both strategies live in ../utils/importDatabase (runImport):
  // - replace (default): the historical full wipe + recreate.
  // - merge (opt-in "keep existing data"): never deletes; matches records
  //   by per-type natural keys, fills in blank fields of matched records,
  //   overwrites only when the imported copy is newer, and adds the rest.
  // Both return per-type statistics, which the modal displays; the modal
  // also owns the reload after a real import so the user can read them.
  async function runDatabaseImport(importData, mergeMode, dryRun) {
    try {
      const { runImport } = await import('../utils/importDatabase');
      const result = await runImport(importData, mergeMode, { dryRun });
      if (!dryRun) {
        const { created, updated, filled, skipped, deleted, invalid } = result.totals;
        addNotification({
          type: 'success',
          title: mergeMode ? 'Database Merged' : 'Database Imported',
          message: mergeMode
            ? `Merged: ${created} added, ${updated} replaced by newer copies, ${filled} completed, ${skipped} unchanged${invalid ? `, ${invalid} invalid` : ''}.`
            : `Replaced: ${deleted} deleted, ${created} created${invalid ? `, ${invalid} invalid` : ''}.`
        });
      }
      return result;
    } catch (error) {
      console.error(dryRun ? 'Import dry run failed:' : 'Failed to import database:', error);
      addNotification({
        type: 'error',
        title: dryRun ? 'Dry Run Failed' : 'Import Failed',
        message: (dryRun ? 'Dry run failed: ' : 'Failed to import database: ') + error.message
      });
      return { error: error.message };
    }
  }

  function handleConfirmImport(importData, mergeMode = false) {
    return runDatabaseImport(importData, mergeMode, false);
  }

  function handleDryRunImport(importData, mergeMode = false) {
    return runDatabaseImport(importData, mergeMode, true);
  }

  // Pop-out pages: a separate window in the desktop app (the main process
  // opens it), the same standalone page in a new tab in a browser
  const openPopOut = async (method, standaloneMode, label) => {
    if (window.electronAPI?.[method]) {
      try {
        await window.electronAPI[method]();
      } catch (error) {
        console.error(`Failed to open ${label} in new window:`, error);
      }
      return;
    }
    openStandalonePage(standaloneMode);
  };
  const popOutLabel = isDesktopApp() ? 'Open in External Window' : 'Open in New Tab';
  const clearNotificationsLabel = 'Clear All Notifications';
  const handleOpenToolsInNewWindow = () => openPopOut('openToolsWindow', 'tools', 'Tools');

  const handleOpenDiagnosticsInNewWindow = () => openPopOut('openDiagnosticsWindow', 'diagnostics', 'Diagnostics');

  const handleOpenSearchInNewWindow = () => openPopOut('openSearchWindow', 'search', 'Search');

  const handleOpenAIChatInNewWindow = () => openPopOut('openAIChatWindow', 'ai-chat', 'AI Chat');

  // The rail's panels: their context-menu type, the toggle event JQLBuilder listens to, the side key
  const PANEL_MENUS = {
    'panel-ai-chat': { key: 'aiChat', event: 'toggleAIChatSidebar' },
    'panel-quick-notes': { key: 'draft', event: 'toggleDraftSidebar' },
    'panel-team-chat': { key: 'chat', event: 'toggleChatSidebar' },
  };

  const handleOpenCalendarInNewWindow = () => openPopOut('openCalendarWindow', 'calendars', 'Calendar');

  const handleOpenKanbanInNewWindow = () => openPopOut('openKanbanWindow', 'kanban', 'Kanban');

  const handleOpenWorkflowInNewWindow = () => openPopOut('openWorkflowWindow', 'workflow', 'Workflow');

  const handleOpenTasksInNewWindow = () => openPopOut('openTasksWindow', 'tasks', 'Tasks');

  const NavButton = ({ icon: Icon, label, active, onClick, onContextMenu }) => (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`relative flex items-center justify-center w-12 h-12 transition-all duration-200 group ${
        isGradientTheme
          ? active
            ? 'bg-white/20 backdrop-blur-xs text-white'
            : 'text-white hover:bg-white/10 hover:backdrop-blur-xs'
          : active
            ? 'bg-os-rail-active text-os-rail-text-active'
            : 'text-os-rail-text hover:bg-os-rail-hover hover:text-os-rail-text-active'
      }`}
    >
      <Icon size={20} />
      <div className="absolute left-full ml-2 px-2 py-1 bg-os-rail-tooltip text-white text-xs rounded-sm opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
        {label}
      </div>
    </button>
  );

  const ActionButton = ({ icon: Icon, label, active, onClick, badge, onContextMenu, testId }) => (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      data-testid={testId}
      className={`relative flex items-center justify-center w-12 h-12 transition-all duration-200 group ${
        isGradientTheme
          ? active
            ? 'bg-white/20 backdrop-blur-xs text-white'
            : 'text-white hover:bg-white/10 hover:backdrop-blur-xs'
          : active
            ? 'bg-os-rail-active text-os-rail-text-active'
            : 'text-os-rail-text hover:bg-os-rail-hover hover:text-os-rail-text-active'
      }`}
    >
      <Icon size={20} />
      {badge && (
        <span className="absolute top-2 right-2 w-2 h-2 bg-purple-500 rounded-full"></span>
      )}
      <div className="absolute left-full ml-2 px-2 py-1 bg-os-rail-tooltip text-white text-xs rounded-sm opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
        {label}
      </div>
    </button>
  );

  // Define all navigation items
  const navItems = [
    { icon: FileText, label: 'Documents', page: 'documents' },
    { icon: Calendar, label: 'Calendars', page: 'calendars' },
    { icon: Bot, label: 'Robin', page: 'ai-chat' },
    { icon: Trello, label: 'Kanban', page: 'kanban' },
    { icon: CheckSquare, label: 'Tasks', page: 'tasks' },
    { icon: Workflow, label: 'Workflow Builder', page: 'workflow' },
    { icon: Activity, label: 'Diagnostics', page: 'diagnostics' },
    { icon: Search, label: 'JQL Search', page: 'search' },
    { icon: Wrench, label: 'Tools', page: 'tools' }
  ];

  // Settings opens from the Electron application menu on the desktop; in a
  // browser the Documents page's hamburger menu dispatches this event
  // (the dialog opens over whatever page is showing).
  const [appSettingsTab, setAppSettingsTab] = useState('general');
  const [appSettingsSection, setAppSettingsSection] = useState(null);
  useEffect(() => {
    const open = (event) => { setAppSettingsTab(event?.detail?.tab || 'general'); setAppSettingsSection(event?.detail?.section || null); setShowAppSettingsModal(true); };
    window.addEventListener('openAppSettings', open);
    return () => window.removeEventListener('openAppSettings', open);
  }, []);

  // Define all utility items
  const utilityItems = [
    { icon: Brain, label: 'Quiz', onClick: handleToggleQuiz, active: isQuizOpen },
    // the three panels: right-click offers "Open on the right" / "Move to the left" (PANEL_MENUS)
    { icon: Bot, label: 'AI Chat', onClick: handleToggleAIChat, active: isAIChatOpen, contextMenu: 'panel-ai-chat', testId: 'rail-ai-chat' },
    { icon: NotesIcon, label: 'Quick Notes', onClick: handleToggleDraft, active: isDraftSidebarOpen, contextMenu: 'panel-quick-notes', testId: 'rail-quick-notes' },
    { icon: MessageSquare, label: 'Team Chat', onClick: handleToggleChat, active: isChatSidebarOpen, badge: unreadMentions > 0, contextMenu: 'panel-team-chat', testId: 'rail-team-chat' },
    // the bell: right-click offers "Clear All Notifications" (the same rail menu as the page icons)
    { icon: Bell, label: 'Notifications', onClick: handleToggleNotifications, active: isNotificationSidebarOpen, badge: history.length > 0, contextMenu: 'notifications', testId: 'rail-notifications' },
    { icon: PanelLeft, label: 'Toggle Sidebar', onClick: handleToggleInnerSidebar, active: innerSidebarVisible },
  ];

  const visibleItems = navItems.slice(0, visibleNavCount);
  const collapsedItems = navItems.slice(visibleNavCount);
  const visibleUtilityItems = utilityItems.slice(0, visibleUtilityCount);
  const collapsedUtilityItems = utilityItems.slice(visibleUtilityCount);

  // Auto-close the More menus if a resize makes their collapsed list empty.
  // Guarded setState during render (per react.dev "adjusting state when a prop
  // changes") — re-renders immediately, before the empty dropdown can paint.
  if (collapsedItems.length === 0 && showMoreMenu) {
    setShowMoreMenu(false);
  }
  if (collapsedUtilityItems.length === 0 && showUtilityMoreMenu) {
    setShowUtilityMoreMenu(false);
  }

  return (
    <>
      {/* This nav is a flex item (child of JQLBuilder's `flex h-screen` row), so its
          z-index applies despite `position: static` (CSS Flexbox 4.3: non-auto z-index
          on a flex item creates a stacking context). That stacking context TRAPS every
          descendant's z-index - the hover tooltips, the "More" dropdowns and the
          right-click context menus (all z-50 below) can never paint above outside
          content beyond the nav's own level, no matter how high their values are.
          zIndex 40 = top of the page-chrome tier (see the tier table in
          common/modals/BaseModal.jsx): flyouts beat sticky page content like
          DocumentSidebar's z-10 search pill, while every overlay tier from z-50 up
          (page modals, toasts, floating widgets, dialogs) still covers them. */}
      <nav
        className={`w-16 shrink-0 flex flex-col items-center py-4 gap-1 ${isGradientTheme ? 'border-r border-white/10' : 'border-r border-os-rail-border'} ${!isGradientTheme ? 'bg-os-rail' : ''}`}
        style={{
          zIndex: 40,
          ...(isGradientTheme && gradientConfig ? { background: gradientConfig.gradient } : {})
        }}
      >
        {/* The mark: the rail is dark in every theme, so the blossom is the
            lilac of the dark variant; a click opens Settings (its default category) */}
        <button
          type="button"
          onClick={() => openAppSettings()}
          title="Jacarium - Settings"
          aria-label="Jacarium - Settings"
          data-testid="sidebar-brand-mark"
          className={`flex items-center justify-center w-12 h-11 mb-1 transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 ${isGradientTheme ? 'hover:bg-white/10' : 'hover:bg-os-rail-hover'}`}
        >
          <BrandMark size={36} tone="dark" />
        </button>
        <div className={`w-8 h-px mb-2 shrink-0 ${isGradientTheme ? 'bg-white/20' : 'bg-os-rail-separator'}`} aria-hidden="true" />
        {/* Main Navigation */}
        <div ref={navContainerRef} className="flex flex-col gap-1 flex-1">
          {visibleItems.map(item => (
            <NavButton
              key={item.page}
              icon={item.icon}
              label={item.label}
              active={currentPage === item.page}
              onClick={() => onPageChange(item.page)}
              onContextMenu={
                item.page === 'documents'
                  ? undefined
                  : (e) => openContextMenu(e, item.page)
              }
            />
          ))}
          {collapsedItems.length > 0 && (
            <button
              ref={moreButtonRef}
              onClick={() => {
                const rect = moreButtonRef.current?.getBoundingClientRect();
                if (rect) setMoreMenuPos({ left: rect.right + 8, top: rect.top });
                setShowMoreMenu(!showMoreMenu);
              }}
              className={`relative flex items-center justify-center w-12 h-12 transition-all duration-200 group ${
                isGradientTheme
                  ? showMoreMenu
                    ? 'bg-white/20 backdrop-blur-xs text-white'
                    : 'text-white hover:bg-white/10 hover:backdrop-blur-xs'
                  : showMoreMenu
                    ? 'bg-os-rail-active text-os-rail-text-active'
                    : 'text-os-rail-text hover:bg-os-rail-hover hover:text-os-rail-text-active'
              }`}
            >
              <MoreHorizontal size={20} />
              <div className="absolute left-full ml-2 px-2 py-1 bg-os-rail-tooltip text-white text-xs rounded-sm opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
                More
              </div>
            </button>
          )}
        </div>

        {/* Utility Actions at bottom */}
        <div className="flex flex-col gap-1">
          {visibleUtilityItems.map(item => (
            <ActionButton
              key={item.label}
              icon={item.icon}
              label={item.label}
              active={item.active}
              onClick={item.onClick}
              badge={item.badge}
              testId={item.testId}
              onContextMenu={item.contextMenu ? (e) => openContextMenu(e, item.contextMenu) : undefined}
            />
          ))}
          {collapsedUtilityItems.length > 0 && (
            <button
              ref={utilityMoreButtonRef}
              onClick={() => {
                const rect = utilityMoreButtonRef.current?.getBoundingClientRect();
                if (rect) setUtilityMoreMenuPos({ left: rect.right + 8, top: rect.top });
                setShowUtilityMoreMenu(!showUtilityMoreMenu);
              }}
              className={`relative flex items-center justify-center w-12 h-12 transition-all duration-200 group ${
                isGradientTheme
                  ? showUtilityMoreMenu
                    ? 'bg-white/20 backdrop-blur-xs text-white'
                    : 'text-white hover:bg-white/10 hover:backdrop-blur-xs'
                  : showUtilityMoreMenu
                    ? 'bg-os-rail-active text-os-rail-text-active'
                    : 'text-os-rail-text hover:bg-os-rail-hover hover:text-os-rail-text-active'
              }`}
            >
              <MoreHorizontal size={20} />
              <div className="absolute left-full ml-2 px-2 py-1 bg-os-rail-tooltip text-white text-xs rounded-sm opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
                More
              </div>
            </button>
          )}
        </div>

        {/* More Menu Dropdown */}
        {showMoreMenu && (
          <div
            ref={moreMenuRef}
            className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[200px]"
            style={{
              left: `${moreMenuPos.left}px`,
              top: `${moreMenuPos.top}px`
            }}
          >
            {collapsedItems.map(item => {
              const Icon = item.icon;
              return (
                <button
                  key={item.page}
                  onClick={() => {
                    onPageChange(item.page);
                    setShowMoreMenu(false);
                  }}
                  onContextMenu={
                    item.page === 'documents'
                      ? undefined
                      : (e) => {
                          openContextMenu(e, item.page);
                          setShowMoreMenu(false);
                        }
                  }
                  className={`w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary flex items-center gap-2 ${
                    currentPage === item.page ? 'text-os-blue' : 'text-os-text-primary'
                  }`}
                >
                  <Icon size={14} className={currentPage === item.page ? 'text-os-blue' : 'text-os-text-secondary'} />
                  {item.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Utility More Menu Dropdown */}
        {showUtilityMoreMenu && (
          <div
            ref={utilityMoreMenuRef}
            className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[200px]"
            style={{
              left: `${utilityMoreMenuPos.left}px`,
              top: `${utilityMoreMenuPos.top}px`
            }}
          >
            {collapsedUtilityItems.map(item => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  onClick={() => {
                    item.onClick();
                    setShowUtilityMoreMenu(false);
                  }}
                  onContextMenu={item.contextMenu ? (e) => { openContextMenu(e, item.contextMenu); setShowUtilityMoreMenu(false); } : undefined}
                  className={`w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary flex items-center gap-2 relative ${
                    item.active ? 'text-os-blue' : 'text-os-text-primary'
                  }`}
                >
                  <Icon size={14} className={item.active ? 'text-os-blue' : 'text-os-text-secondary'} />
                  {item.label}
                  {item.badge && (
                    <span className="absolute right-4 w-2 h-2 bg-purple-500 rounded-full"></span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Notifications (the bell) Context Menu: the same menu as the page icons' */}
        {isContextMenuType('notifications') && (
          <div
            ref={contextMenuRef}
            className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[180px]"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`
            }}
            data-testid="rail-notifications-menu"
          >
            <button
              onClick={() => {
                closeContextMenu();
                setShowClearNotificationsModal(true);
              }}
              disabled={history.length === 0}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="rail-clear-notifications"
            >
              <Trash2 size={14} className="text-os-text-secondary" />
              {clearNotificationsLabel}
            </button>
          </div>
        )}
        <ConfirmationModal
          isOpen={showClearNotificationsModal}
          type="danger"
          title="Clear all notifications?"
          message={`${history.length} notification${history.length === 1 ? '' : 's'} will be removed.`}
          confirmLabel="Clear all"
          onConfirm={() => { clearHistory(); setShowClearNotificationsModal(false); }}
          onCancel={() => setShowClearNotificationsModal(false)}
        />

        {/* Tools Context Menu */}
        {isContextMenuType('tools') && (
          <div
            ref={contextMenuRef}
            className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[180px]"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`
            }}
          >
            <button
              onClick={() => {
                handleOpenToolsInNewWindow();
                closeContextMenu();
              }}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
            >
              <ExternalLink size={14} className="text-os-text-secondary" />
              {popOutLabel}
            </button>
          </div>
        )}

        {/* Diagnostics Context Menu */}
        {isContextMenuType('diagnostics') && (
          <div
            ref={contextMenuRef}
            className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[180px]"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`
            }}
          >
            <button
              onClick={() => {
                handleOpenDiagnosticsInNewWindow();
                closeContextMenu();
              }}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
            >
              <ExternalLink size={14} className="text-os-text-secondary" />
              {popOutLabel}
            </button>
          </div>
        )}

        {/* Search Context Menu */}
        {isContextMenuType('search') && (
          <div
            ref={contextMenuRef}
            className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[180px]"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`
            }}
          >
            <button
              onClick={() => {
                handleOpenSearchInNewWindow();
                closeContextMenu();
              }}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
            >
              <ExternalLink size={14} className="text-os-text-secondary" />
              {popOutLabel}
            </button>
          </div>
        )}

        {/* The panels' context menu: open on the right / move back to the left (the rail
            is not rendered in the phone layout, where the panels are drawers) */}
        {PANEL_MENUS[contextMenu.type] && contextMenu.visible && (() => {
          const menu = PANEL_MENUS[contextMenu.type];
          const onRight = panelSides[menu.key] === 'right';
          const sideLabel = onRight ? 'Move to the left' : 'Open on the right';
          return (
            <div
              ref={contextMenuRef}
              className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[180px]"
              style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
              data-testid="rail-panel-menu"
            >
              <button
                onClick={() => {
                  window.dispatchEvent(new CustomEvent(menu.event, { detail: { side: onRight ? 'left' : 'right', open: true } }));
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                data-testid="rail-panel-side"
              >
                <PanelRight size={14} className="text-os-text-secondary" />
                {sideLabel}
              </button>
            </div>
          );
        })()}

        {/* AI Chat Context Menu */}
        {isContextMenuType('ai-chat') && (
          <div
            ref={contextMenuRef}
            className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[180px]"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`
            }}
          >
            <button
              onClick={() => {
                handleOpenAIChatInNewWindow();
                closeContextMenu();
              }}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
            >
              <ExternalLink size={14} className="text-os-text-secondary" />
              {popOutLabel}
            </button>
          </div>
        )}

        {/* Calendar Context Menu */}
        {isContextMenuType('calendars') && (
          <div
            ref={contextMenuRef}
            className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[180px]"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`
            }}
          >
            <button
              onClick={() => {
                handleOpenCalendarInNewWindow();
                closeContextMenu();
              }}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
            >
              <ExternalLink size={14} className="text-os-text-secondary" />
              {popOutLabel}
            </button>
          </div>
        )}

        {/* Kanban Context Menu */}
        {isContextMenuType('kanban') && (
          <div
            ref={contextMenuRef}
            className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[180px]"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`
            }}
          >
            <button
              onClick={() => {
                handleOpenKanbanInNewWindow();
                closeContextMenu();
              }}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
            >
              <ExternalLink size={14} className="text-os-text-secondary" />
              {popOutLabel}
            </button>
          </div>
        )}

        {/* Workflow Builder Context Menu */}
        {isContextMenuType('workflow') && (
          <div
            ref={contextMenuRef}
            className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[180px]"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`
            }}
          >
            <button
              onClick={() => {
                handleOpenWorkflowInNewWindow();
                closeContextMenu();
              }}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
            >
              <ExternalLink size={14} className="text-os-text-secondary" />
              {popOutLabel}
            </button>
          </div>
        )}

        {/* Tasks Context Menu */}
        {isContextMenuType('tasks') && (
          <div
            ref={contextMenuRef}
            className="fixed bg-os-card border border-os-border rounded-lg shadow-xl z-50 py-1 min-w-[180px]"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`
            }}
          >
            <button
              onClick={() => {
                handleOpenTasksInNewWindow();
                closeContextMenu();
              }}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
            >
              <ExternalLink size={14} className="text-os-text-secondary" />
              {popOutLabel}
            </button>
          </div>
        )}
      </nav>

      {/* Import DB Modal */}
      <ImportDBModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImport={handleConfirmImport}
        onDryRun={handleDryRunImport}
      />

      {/* Export DB Progress */}
      <ExportProgressModal
        isOpen={exportFlow.isOpen}
        job={exportFlow.job}
        onClose={exportFlow.handleClose}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={showAppSettingsModal}
        initialTab={appSettingsTab}
        initialSection={appSettingsSection}
        onClose={() => setShowAppSettingsModal(false)}
        // File > Database and Help > What's New are Electron menu items; the
        // dialog offers them too so a browser (no menu) can reach them
        onExportDatabase={() => { setShowAppSettingsModal(false); handleExportDB(); }}
        onImportDatabase={() => { setShowAppSettingsModal(false); handleImportDB(); }}
        onWipeDatabase={() => { setShowAppSettingsModal(false); handleWipeDB(); }}
        onShowWhatsNew={() => { setShowAppSettingsModal(false); window.dispatchEvent(new Event('toggleWhatsNew')); }}
      />

      {/* Wipe Database Confirmation */}
      <ConfirmationModal
        isOpen={showWipeConfirmModal}
        onCancel={() => setShowWipeConfirmModal(false)}
        onConfirm={() => {
          setShowWipeConfirmModal(false);
          performWipeDB();
        }}
        title="Wipe Database?"
        type="danger"
        confirmLabel="Wipe Database"
        confirmPhrase="DELETE EVERYTHING"
        message={
          <div>
            <p className="mb-2 font-medium text-red-600">
              This will permanently delete ALL data!
            </p>
            <p className="mb-1">This includes:</p>
            <ul className="list-disc pl-5 mb-2 space-y-0.5">
              <li>All documents</li>
              <li>All templates</li>
              <li>All workflows</li>
              <li>All kanban boards</li>
              <li>All tasks and TaskWarrior instances</li>
              <li>All custom reports</li>
              <li>All SSH commands</li>
              <li>All custom grids and quizzes</li>
              <li>All OpenShift templates</li>
              <li>All settings</li>
            </ul>
            <p className="font-medium">This action CANNOT be undone!</p>
          </div>
        }
      />
    </>
  );
}
