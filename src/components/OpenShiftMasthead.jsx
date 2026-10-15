import BrandMark, { BrandWordmark } from '../brand/BrandMark';
import { useState, useEffect, useRef } from 'react';
import { Menu, User, HelpCircle, Bell, FileText, Bot, Brain } from 'lucide-react';
import ImportDBModal from './common/modals/ImportDBModal';
import { useNotifications } from '../contexts/NotificationContext';
import { MenuItemIcon } from './common/menus/MenuItemIcon';

export default function OpenShiftMasthead({ onToggleSidebar }) {
  const [isDraftOpen, setIsDraftOpen] = useState(false);
  const [isAIChatOpen, setIsAIChatOpen] = useState(false);
  const [isQuizOpen, setIsQuizOpen] = useState(false);
  const [showHamburgerMenu, setShowHamburgerMenu] = useState(false);
  const [hamburgerMenuPosition, setHamburgerMenuPosition] = useState({ x: 0, y: 0 });
  const [showImportModal, setShowImportModal] = useState(false);
  const [isNotificationSidebarOpen, setIsNotificationSidebarOpen] = useState(false);
  const [innerSidebarVisible, setInnerSidebarVisible] = useState(() => {
    const saved = localStorage.getItem('innerSidebarVisible');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const hamburgerMenuRef = useRef(null);
  const { history, addNotification } = useNotifications();

  useEffect(() => {
    function handleDraftStateChange(event) {
      setIsDraftOpen(event.detail.isOpen);
    }

    function handleAIChatStateChange(event) {
      setIsAIChatOpen(event.detail.isOpen);
    }

    function handleQuizStateChange(event) {
      setIsQuizOpen(event.detail.isOpen);
    }

    function handleNotificationSidebarStateChange(event) {
      setIsNotificationSidebarOpen(event.detail.isOpen);
    }

    window.addEventListener('draftSidebarStateChange', handleDraftStateChange);
    window.addEventListener('aiChatSidebarStateChange', handleAIChatStateChange);
    window.addEventListener('quizStateChange', handleQuizStateChange);
    window.addEventListener('notificationSidebarStateChange', handleNotificationSidebarStateChange);

    return () => {
      window.removeEventListener('draftSidebarStateChange', handleDraftStateChange);
      window.removeEventListener('aiChatSidebarStateChange', handleAIChatStateChange);
      window.removeEventListener('quizStateChange', handleQuizStateChange);
      window.removeEventListener('notificationSidebarStateChange', handleNotificationSidebarStateChange);
    };
  }, []);

  // Save inner sidebar visibility and dispatch event
  useEffect(() => {
    localStorage.setItem('innerSidebarVisible', JSON.stringify(innerSidebarVisible));
    window.dispatchEvent(new CustomEvent('innerSidebarVisibilityChange', { detail: { visible: innerSidebarVisible } }));
  }, [innerSidebarVisible]);

  // Close hamburger menu on outside click
  useEffect(() => {
    if (!showHamburgerMenu) return;

    function handleClickOutside(e) {
      if (hamburgerMenuRef.current && !hamburgerMenuRef.current.contains(e.target)) {
        setShowHamburgerMenu(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showHamburgerMenu]);

  function handleToggleFloatingDraft() {
    window.dispatchEvent(new CustomEvent('toggleDraftSidebar'));
  }

  function handleToggleAIChat() {
    window.dispatchEvent(new CustomEvent('toggleAIChatSidebar'));
  }

  function handleToggleQuiz() {
    window.dispatchEvent(new CustomEvent('toggleQuiz'));
  }

  function handleToggleNotifications() {
    window.dispatchEvent(new CustomEvent('toggleNotificationSidebar'));
  }

  function handleHamburgerContextMenu(e) {
    e.preventDefault();

    // Calculate menu position to keep it within viewport
    const menuWidth = 180;
    const menuHeight = 150;
    let x = e.clientX;
    let y = e.clientY;

    // Adjust if would overflow right edge
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 10;
    }

    // Adjust if would overflow bottom edge
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 10;
    }

    setHamburgerMenuPosition({ x, y });
    setShowHamburgerMenu(true);
  }

  function handleToggleInnerSidebar() {
    setInnerSidebarVisible(!innerSidebarVisible);
    setShowHamburgerMenu(false);
  }

  async function handleExportDB() {
    try {
      // Gather all data from IndexedDB
      const { getDocuments } = await import('../utils/documents');
      const { getDocumentTemplates } = await import('../utils/documentTemplates');
      const { getTemplates } = await import('../templates/jqlTemplates');
      const { getEngineTemplates } = await import('../utils/engineTemplates');
      const { getWorkflows } = await import('../utils/workflows');
      const { db } = await import('../db/database');

      const [documents, documentTemplates, jqlTemplates, engineTemplates, workflows, calendarEventTemplates] = await Promise.all([
        getDocuments(),
        getDocumentTemplates(),
        getTemplates(),
        getEngineTemplates(),
        getWorkflows(),
        db.calendarEventTemplates.toArray()
      ]);

      // Gather relevant localStorage data
      const localStorageData = {};
      const relevantKeys = [
        'innerSidebarVisible',
        'aiChatSettings',
        'expandedDocumentCategories',
        'expandedTemplateCategories',
        'expandedJQLCategories',
        'expandedEngineCategories',
        'expandedWorkflowCategories',
        'documentPreviewModes'
      ];

      relevantKeys.forEach(key => {
        const value = localStorage.getItem(key);
        if (value !== null) {
          try {
            localStorageData[key] = JSON.parse(value);
          } catch {
            localStorageData[key] = value;
          }
        }
      });

      const exportData = {
        version: '1.0',
        exportDate: new Date().toISOString(),
        documents,
        documentTemplates,
        jqlTemplates,
        engineTemplates,
        workflows,
        calendarEventTemplates,
        localStorage: localStorageData
      };

      // Create and download JSON file
      const dataStr = JSON.stringify(exportData, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `jacarium-db-${new Date().toISOString().split('T')[0]}.json`;
      link.click();
      URL.revokeObjectURL(url);

      setShowHamburgerMenu(false);
    } catch (error) {
      console.error('Failed to export database:', error);
      addNotification({
        type: 'error',
        title: 'Export Failed',
        message: 'Failed to export database: ' + error.message
      });
    }
  }

  function handleImportDB() {
    setShowHamburgerMenu(false);
    setShowImportModal(true);
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

  return (
    <header className="bg-[#151515] h-14 flex items-center px-4" style={{ zIndex: 100 }}>
      {/* Left Section */}
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleSidebar}
          onContextMenu={handleHamburgerContextMenu}
          className="p-1.5 hover:bg-gray-700 rounded-sm transition-colors text-white"
          title="Toggle navigation"
        >
          <Menu size={18} />
        </button>

        <span className="flex items-center gap-2"><BrandMark size={28} tone="dark" /><BrandWordmark size={18} className="text-white" /></span>
      </div>

      {/* Hamburger Context Menu */}
      {showHamburgerMenu && (
        <div
          ref={hamburgerMenuRef}
          className="fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px]"
          style={{ left: `${hamburgerMenuPosition.x}px`, top: `${hamburgerMenuPosition.y}px` }}
        >
          <button
            onClick={handleToggleInnerSidebar}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action={innerSidebarVisible ? 'hideSidebar' : 'showSidebar'} />
            {innerSidebarVisible ? 'Hide Inner Sidebar' : 'Show Inner Sidebar'}
          </button>
          <div className="border-t border-os-border my-1"></div>
          <button
            onClick={handleExportDB}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="export" />
            Export DB
          </button>
          <button
            onClick={handleImportDB}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="import" />
            Import DB
          </button>
        </div>
      )}

      {/* Right Section */}
      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={handleToggleQuiz}
          className={`p-1.5 hover:bg-gray-700 transition-colors ${
            isQuizOpen ? 'bg-gray-700 text-white' : 'text-gray-300 hover:text-white'
          }`}
          title="Quiz"
        >
          <Brain size={18} />
        </button>
        <button
          onClick={handleToggleAIChat}
          className={`p-1.5 hover:bg-gray-700 transition-colors ${
            isAIChatOpen ? 'bg-gray-700 text-white' : 'text-gray-300 hover:text-white'
          }`}
          title="AI Chat"
        >
          <Bot size={18} />
        </button>
        <button
          onClick={handleToggleFloatingDraft}
          className={`p-1.5 hover:bg-gray-700 transition-colors ${
            isDraftOpen ? 'bg-gray-700 text-white' : 'text-gray-300 hover:text-white'
          }`}
          title="Quick Notes"
        >
          <FileText size={18} />
        </button>
        <button
          onClick={handleToggleNotifications}
          className={`p-1.5 hover:bg-gray-700 transition-colors relative ${
            isNotificationSidebarOpen ? 'bg-gray-700 text-white' : 'text-gray-300 hover:text-white'
          }`}
          title="Notifications"
        >
          <Bell size={18} />
          {history.length > 0 && (
            <span className="absolute top-0 right-0 w-2 h-2 bg-purple-500 rounded-full"></span>
          )}
        </button>
        <button
          className="p-1.5 hover:bg-gray-700 rounded-sm transition-colors text-gray-300"
          title="Help"
        >
          <HelpCircle size={18} />
        </button>
        <button
          className="p-1.5 hover:bg-gray-700 rounded-sm transition-colors text-gray-300"
          title="User"
        >
          <User size={18} />
        </button>
      </div>

      {/* Import DB Modal */}
      <ImportDBModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImport={handleConfirmImport}
        onDryRun={handleDryRunImport}
      />
    </header>
  );
}
