import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Edit, Loader, Timer, X, Copy, AlertCircle } from 'lucide-react';
import { getTemplates, getCategories, deleteTemplate, saveTemplate, updateTemplate, renameCategory } from '../templates/jqlTemplates';
import { getEngineTemplates, getEngineCategories, createEngineTemplate, updateEngineTemplate, deleteEngineTemplate } from '../utils/engineTemplates';
import { useImportFlow } from '../hooks/useImportFlow';
import { useNotifications } from '../contexts/NotificationContext';
import { useLocalStorage } from '../hooks/useLocalStorage';
import ResizableSidebar from './ResizableSidebar';
import { useMobile } from '../contexts/MobileContext';
import { isMobileLayout } from '../utils/mobile';
import MobilePageHeader from './mobile/MobilePageHeader';
import EngineTemplateModal from './features/search/EngineTemplateModal';
import EngineInputModal from './features/search/EngineInputModal';
import JQLTemplateSidebar from './features/search/JQLTemplateSidebar';
import EngineTemplateSidebar from './features/search/EngineTemplateSidebar';
import ImportFlow from './common/ImportFlow';
import ConfirmationModal from './common/ConfirmationModal';
import VerticalResizableDivider from './VerticalResizableDivider';
import { MenuItemIcon } from './common/menus/MenuItemIcon';

// Session persistence
const restoreSearchPageSession = () => {
  try {
    const saved = localStorage.getItem('search-page-session');
    if (saved) {
      const session = JSON.parse(saved);
      console.log('[SearchPage] Restored session:', session);
      return session;
    }
  } catch (error) {
    console.error('[SearchPage] Failed to restore session:', error);
  }
  return null;
};

export default function SearchPage({
  children,
  onTemplateSelect,
  onEditTemplate,
  onRefresh,
  onNewTemplate,
  activeTemplateId,
  templateRefreshKey,
  jiraStatus,
  loadingMetadata,
  cooldown,
  selectedEngineTemplate,
  onEngineTemplateProcessed
}) {
  const [templates, setTemplates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [expandedCategories, setExpandedCategories] = useState([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [hadSavedSession, setHadSavedSession] = useState(false);
  const [statusBannerDismissed, setStatusBannerDismissed] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState(null);
  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, type: null, target: null });
  const [editingCategory, setEditingCategory] = useState(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [showChangeCategoryModal, setShowChangeCategoryModal] = useState(false);
  const [templateToChangeCategory, setTemplateToChangeCategory] = useState(null);
  const [selectedNewCategory, setSelectedNewCategory] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  // The phone layout: the templates are a drawer under a page header
  const { isMobile } = useMobile();
  const [innerSidebarVisible, setInnerSidebarVisible] = useState(() => {
    const saved = localStorage.getItem('innerSidebarVisible');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const contextMenuRef = useRef(null);

  // Engine templates state
  const [engineTemplates, setEngineTemplates] = useState([]);
  const [engineCategories, setEngineCategories] = useState([]);
  const [expandedEngineCategories, setExpandedEngineCategories] = useState([]);
  const [showEngineModal, setShowEngineModal] = useState(false);
  const [editingEngineTemplate, setEditingEngineTemplate] = useState(null);
  const [showEngineDeleteModal, setShowEngineDeleteModal] = useState(false);
  const [engineTemplateToDelete, setEngineTemplateToDelete] = useState(null);
  const [showEngineInputModal, setShowEngineInputModal] = useState(false);
  const [currentEngineTemplate, setCurrentEngineTemplate] = useState(null);
  const [engineSidebarCollapsed, setEngineSidebarCollapsed] = useLocalStorage('engineSidebarCollapsed', false);

  const { addNotification } = useNotifications();

  // Import flow for JQL templates (with custom validated handler to unwrap templates array)
  const jqlTemplateImportFlowBase = useImportFlow({
    validateFn: (data) => {
      if (!data.templates || !Array.isArray(data.templates)) {
        return 'Invalid format: Expected {templates: [...]} structure';
      }
      if (data.templates.length === 0) {
        return 'No templates to import';
      }
      return true;
    },
    onImportItem: async (template) => {
      await saveTemplate({
        name: template.name || 'Untitled',
        description: template.description || '',
        category: template.category || 'General',
        icon: template.icon || 'Bookmark',
        rootGroup: template.rootGroup,
        sortFields: template.sortFields || [],
      });
      await loadTemplates();
      if (onRefresh) onRefresh();
    },
  });

  // Custom validated handler to unwrap the templates array
  const jqlTemplateImportFlow = {
    ...jqlTemplateImportFlowBase,
    handleInputValidated: (data) => {
      // Unwrap the templates array before passing to the flow
      jqlTemplateImportFlowBase.handleInputValidated(data.templates);
    },
  };

  // Import flow for engine templates
  const engineTemplateImportFlow = useImportFlow({
    validateFn: (data) => {
      if (!Array.isArray(data)) {
        return 'Invalid format: Expected an array of search engines';
      }
      if (data.length === 0) {
        return 'No search engines to import';
      }
      return true;
    },
    onImportItem: async (engine) => {
      await createEngineTemplate(engine);
      await loadEngineTemplates();
    },
  });

  // Restore session on mount (once)
  useEffect(() => {
    const savedSession = restoreSearchPageSession();
    if (savedSession) {
      // Intentional mount-only restore of persisted UI state
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHadSavedSession(true);
      if (savedSession.expandedCategories) {
        setExpandedCategories(savedSession.expandedCategories);
      }
      if (savedSession.expandedEngineCategories) {
        setExpandedEngineCategories(savedSession.expandedEngineCategories);
      }
      // If savedSession exists but expandedCategories is empty array, respect that
    }
    setIsInitialized(true);
  }, []);

  // Listen for inner sidebar visibility changes
  useEffect(() => {
    function handleInnerSidebarVisibilityChange(event) {
      setInnerSidebarVisible(event.detail.visible);
    }

    window.addEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
    return () => window.removeEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
  }, []);

  useEffect(() => {
    loadTemplates();
    loadEngineTemplates();
    // templateRefreshKey is the deliberate reload trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateRefreshKey]);

  // Handle engine template selection from command palette
  useEffect(() => {
    if (selectedEngineTemplate) {
      // Intentional prop-to-state handoff from the command palette
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentEngineTemplate(selectedEngineTemplate);
      setShowEngineInputModal(true);
      // Notify parent that we've processed the selection
      if (onEngineTemplateProcessed) {
        onEngineTemplateProcessed();
      }
    }
  }, [selectedEngineTemplate, onEngineTemplateProcessed]);

  // Save session when expandedCategories changes (only after initialization)
  useEffect(() => {
    if (!isInitialized) {
      console.log('[SearchPage] Skipping save - not initialized yet');
      return;
    }

    const session = {
      expandedCategories,
      expandedEngineCategories,
      timestamp: Date.now()
    };
    localStorage.setItem('search-page-session', JSON.stringify(session));
    console.log('[SearchPage] Saved session:', session);
  }, [expandedCategories, expandedEngineCategories, isInitialized]);

  // Reset banner dismissed state when status changes
  useEffect(() => {
    // Intentional reset tied to external-status transitions
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatusBannerDismissed(false);
  }, [jiraStatus, loadingMetadata, cooldown]);

  // Close context menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target)) {
        setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
      }
    }

    if (contextMenu.visible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [contextMenu.visible]);

  // Reposition context menu after render using its actual measured size
  useLayoutEffect(() => {
    if (!contextMenu.visible || !contextMenuRef.current) return;
    // on a phone the menu is a bottom sheet placed by the stylesheet (src/mobile.css), not by x/y
    if (isMobileLayout()) return;
    const menuRect = contextMenuRef.current.getBoundingClientRect();
    const margin = 10;
    let x = contextMenu.x;
    let y = contextMenu.y;
    if (menuRect.right > window.innerWidth - margin) {
      x = Math.max(margin, x - (menuRect.right - window.innerWidth + margin));
    }
    if (menuRect.bottom > window.innerHeight - margin) {
      y = Math.max(margin, y - (menuRect.bottom - window.innerHeight + margin));
    }
    if (x !== contextMenu.x || y !== contextMenu.y) {
      setContextMenu((prev) => ({ ...prev, x, y }));
    }
  }, [contextMenu.visible, contextMenu.x, contextMenu.y]);

  async function loadTemplates() {
    const allTemplates = await getTemplates();
    const allCategories = await getCategories();
    setTemplates(allTemplates);
    setCategories(allCategories);

    // Only auto-expand first category on very first load when there was no saved session
    if (isInitialized && !hadSavedSession && allCategories.length > 0 && expandedCategories.length === 0) {
      console.log('[SearchPage] No saved session - auto-expanding first category');
      setExpandedCategories([allCategories[0]]);
    }
  }

  async function loadEngineTemplates() {
    const allEngineTemplates = await getEngineTemplates();
    const allEngineCategories = await getEngineCategories();
    setEngineTemplates(allEngineTemplates);
    setEngineCategories(allEngineCategories);
  }

  function toggleEngineCategory(category) {
    setExpandedEngineCategories(prev =>
      prev.includes(category)
        ? prev.filter(c => c !== category)
        : [...prev, category]
    );
  }

  async function handleSaveEngineTemplate(template) {
    try {
      if (editingEngineTemplate) {
        await updateEngineTemplate(editingEngineTemplate.id, template);
      } else {
        await createEngineTemplate(template);
      }
      await loadEngineTemplates();
      setShowEngineModal(false);
      setEditingEngineTemplate(null);
    } catch (error) {
      console.error('Failed to save engine template:', error);
      addNotification({
        type: 'error',
        title: 'Save Failed',
        message: 'Failed to save engine template: ' + error.message
      });
    }
  }

  async function handleDuplicateEngineTemplate(template) {
    try {
      await createEngineTemplate({
        name: `${template.name} (Copy)`,
        urlTemplate: template.urlTemplate,
        category: template.category,
        description: template.description
      });
      await loadEngineTemplates();
      setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
    } catch (error) {
      console.error('Failed to duplicate engine template:', error);
      addNotification({
        type: 'error',
        title: 'Duplicate Failed',
        message: 'Failed to duplicate engine template: ' + error.message
      });
    }
  }

  async function handleDeleteEngineTemplate(template) {
    setEngineTemplateToDelete(template);
    setShowEngineDeleteModal(true);
  }

  async function confirmDeleteEngineTemplate() {
    if (!engineTemplateToDelete) return;

    try {
      await deleteEngineTemplate(engineTemplateToDelete.id);
      await loadEngineTemplates();
      setShowEngineDeleteModal(false);
      setEngineTemplateToDelete(null);
      setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
    } catch (error) {
      console.error('Failed to delete engine template:', error);
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: 'Failed to delete engine template: ' + error.message
      });
    }
  }

  function handleEngineTemplateClick(template) {
    setCurrentEngineTemplate(template);
    setShowEngineInputModal(true);
  }

  function handleImportEngineTemplates() {
    engineTemplateImportFlow.startImport();
  }

  async function handleExportAllEngineTemplates() {
    try {
      const data = JSON.stringify(engineTemplates, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `search-engines-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export search engines:', error);
      addNotification({
        type: 'error',
        title: 'Export Failed',
        message: 'Failed to export search engines: ' + error.message
      });
    }
  }

  async function handleExportEngineCategory(categoryName) {
    try {
      const categoryEngines = engineTemplates.filter(t => (t.category || 'General') === categoryName);
      const data = JSON.stringify(categoryEngines, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeCategoryName = categoryName.replace(/[/\\?%*:|"<>]/g, '-');
      a.download = `search-engines-${safeCategoryName}-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export category:', error);
      addNotification({
        type: 'error',
        title: 'Export Failed',
        message: 'Failed to export category: ' + error.message
      });
    }
  }

  function toggleCategory(category) {
    setExpandedCategories(prev =>
      prev.includes(category)
        ? prev.filter(c => c !== category)
        : [...prev, category]
    );
  }

  function handleTemplateClick(template) {
    onTemplateSelect(template);
  }

  function handleTemplateContextMenu(e, template) {
    e.preventDefault();

    // Position at cursor; the layout effect below corrects overflow
    // using the menu's actual measured size after render
    const x = e.clientX;
    const y = e.clientY;

    setContextMenu({
      visible: true,
      x,
      y,
      type: 'template',
      target: template
    });
  }

  function handleCategoryContextMenu(e, categoryName) {
    e.preventDefault();

    // Position at cursor; the layout effect above corrects overflow
    // using the menu's actual measured size after render
    const x = e.clientX;
    const y = e.clientY;

    setContextMenu({
      visible: true,
      x,
      y,
      type: 'category',
      target: categoryName
    });
  }

  function handleEdit(template, e) {
    e.stopPropagation();
    if (onEditTemplate) {
      onEditTemplate(template);
    }
  }

  async function handleDelete(templateId, e) {
    e.stopPropagation();
    const template = templates.find(t => t.id === templateId);
    setTemplateToDelete(template);
    setShowDeleteModal(true);
  }

  function handleChangeCategory(template, e) {
    e.stopPropagation();
    setTemplateToChangeCategory(template);
    setSelectedNewCategory(template.category || '');
    setNewCategoryName('');
    setShowChangeCategoryModal(true);
  }

  async function confirmChangeCategory() {
    if (!templateToChangeCategory || !selectedNewCategory) return;

    await updateTemplate(templateToChangeCategory.id, {
      category: selectedNewCategory
    });

    setShowChangeCategoryModal(false);
    setTemplateToChangeCategory(null);
    setSelectedNewCategory('');
    setNewCategoryName('');
    loadTemplates();
  }

  async function handleCreateAndApplyCategory() {
    if (!templateToChangeCategory || !newCategoryName.trim()) return;

    await updateTemplate(templateToChangeCategory.id, {
      category: newCategoryName.trim()
    });

    setShowChangeCategoryModal(false);
    setTemplateToChangeCategory(null);
    setSelectedNewCategory('');
    setNewCategoryName('');
    loadTemplates();
  }

  async function confirmDeleteTemplate() {
    if (!templateToDelete) return;

    await deleteTemplate(templateToDelete.id);
    loadTemplates();
    if (onRefresh) onRefresh();

    setShowDeleteModal(false);
    setTemplateToDelete(null);
  }

  async function handleCategoryRename() {
    if (!editingCategory || !editingCategoryName.trim()) {
      setEditingCategory(null);
      setEditingCategoryName('');
      return;
    }

    const newName = editingCategoryName.trim();
    const oldName = editingCategory;

    if (newName === oldName) {
      setEditingCategory(null);
      setEditingCategoryName('');
      return;
    }

    try {
      await renameCategory(oldName, newName);
      await loadTemplates();
      if (onRefresh) onRefresh();

      // Update expanded categories
      setExpandedCategories(prev =>
        prev.map(cat => cat === oldName ? newName : cat)
      );

      setEditingCategory(null);
      setEditingCategoryName('');
    } catch (error) {
      console.error('Failed to rename category:', error);
      addNotification({
        type: 'error',
        title: 'Rename Failed',
        message: 'Failed to rename category: ' + error.message
      });
      setEditingCategory(null);
      setEditingCategoryName('');
    }
  }

  async function handleExportAllTemplates() {
    if (templates.length === 0) {
      addNotification({
        type: 'alert',
        title: 'No Templates',
        message: 'No templates to export'
      });
      return;
    }

    try {
      // Create export data
      const exportData = {
        version: '1.0',
        exportDate: new Date().toISOString(),
        templates: templates.map(t => ({
          name: t.name,
          description: t.description,
          category: t.category,
          icon: t.icon,
          rootGroup: t.rootGroup,
          sortFields: t.sortFields,
        }))
      };

      const json = JSON.stringify(exportData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jql-templates-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export templates:', error);
      addNotification({
        type: 'error',
        title: 'Export Failed',
        message: 'Failed to export templates: ' + error.message
      });
    }
  }

  function handleImportTemplates() {
    jqlTemplateImportFlow.startImport();
  }

  async function handleImportToCategory(categoryName, event) {
    event.stopPropagation();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.templates || !Array.isArray(data.templates)) {
          throw new Error('Invalid template file format');
        }

        let importedCount = 0;
        for (const template of data.templates) {
          try {
            await saveTemplate({
              name: template.name || 'Untitled',
              description: template.description || '',
              category: categoryName, // Force category to the selected one
              icon: template.icon || 'Bookmark',
              rootGroup: template.rootGroup,
              sortFields: template.sortFields || [],
            });
            importedCount++;
          } catch (error) {
            console.error('Failed to import template:', template.name, error);
          }
        }

        addNotification({
          type: 'success',
          title: 'Templates Imported',
          message: `Successfully imported ${importedCount} template(s) into "${categoryName}"`
        });
        loadTemplates();
        if (onRefresh) onRefresh();
      } catch (error) {
        console.error('Failed to import templates:', error);
        addNotification({
          type: 'error',
          title: 'Import Failed',
          message: 'Failed to import templates: ' + error.message
        });
      }
    };

    input.click();
  }

  async function handleExportCategory(categoryName, event) {
    event.stopPropagation();

    const categoryTemplates = templates.filter(t => t.category === categoryName);

    if (categoryTemplates.length === 0) {
      addNotification({
        type: 'alert',
        title: 'No Templates',
        message: 'No templates in this category to export'
      });
      return;
    }

    try {
      // Create export data for this category
      const exportData = {
        version: '1.0',
        exportDate: new Date().toISOString(),
        category: categoryName,
        templates: categoryTemplates.map(t => ({
          name: t.name,
          description: t.description,
          category: t.category,
          icon: t.icon,
          rootGroup: t.rootGroup,
          sortFields: t.sortFields,
        }))
      };

      const json = JSON.stringify(exportData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Sanitize category name for filename
      const safeCategoryName = categoryName.replace(/[/\\?%*:|"<>]/g, '-');
      a.download = `jql-templates-${safeCategoryName}-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export category:', error);
      addNotification({
        type: 'error',
        title: 'Export Failed',
        message: 'Failed to export category: ' + error.message
      });
    }
  }

  return (
    <div className="flex h-full">
      {/* Templates Sidebar */}
      {(innerSidebarVisible || isMobile) && (
      <ResizableSidebar
        defaultWidth={288}
        minWidth={200}
        maxWidth={500}
        storageKey="searchPage-templateSidebar-width"
        position="right"
        className="bg-os-card flex flex-col"
      >
      {(width) => (
      <VerticalResizableDivider
        defaultTopHeight={60}
        minTopHeight={20}
        maxTopHeight={80}
        storageKey="searchPage-templateSplit"
        bottomCollapsed={engineSidebarCollapsed}
        topContent={
          <JQLTemplateSidebar
            templates={templates}
            categories={categories}
            expandedCategories={expandedCategories}
            onToggleCategory={toggleCategory}
            activeTemplateId={activeTemplateId}
            editingCategory={editingCategory}
            editingCategoryName={editingCategoryName}
            onEditingCategoryNameChange={setEditingCategoryName}
            onEditingCategoryChange={setEditingCategory}
            onTemplateClick={handleTemplateClick}
            onTemplateContextMenu={handleTemplateContextMenu}
            onCategoryContextMenu={handleCategoryContextMenu}
            onCategoryRename={handleCategoryRename}
            onImport={handleImportTemplates}
            onExport={handleExportAllTemplates}
            onNewTemplate={onNewTemplate}
            jiraStatus={jiraStatus}
            loadingMetadata={loadingMetadata}
            cooldown={cooldown}
            width={width}
          />
        }
        bottomContent={
          <EngineTemplateSidebar
            engineTemplates={engineTemplates}
            engineCategories={engineCategories}
            expandedEngineCategories={expandedEngineCategories}
            onToggleCategory={toggleEngineCategory}
            onEngineTemplateClick={handleEngineTemplateClick}
            onEngineContextMenu={(e, template) => {
              e.preventDefault();

              // Position at cursor; the layout effect corrects overflow
              // using the menu's actual measured size after render
              const x = e.clientX;
              const y = e.clientY;

              setContextMenu({
                visible: true,
                x,
                y,
                type: 'engine',
                target: template
              });
            }}
            onEngineCategoryContextMenu={(e, cat) => {
              e.preventDefault();

              // Position at cursor; the layout effect corrects overflow
              // using the menu's actual measured size after render
              const x = e.clientX;
              const y = e.clientY;

              setContextMenu({
                visible: true,
                x,
                y,
                type: 'engineCategory',
                target: cat
              });
            }}
            onNewEngine={() => {
              setEditingEngineTemplate(null);
              setShowEngineModal(true);
            }}
            onImport={handleImportEngineTemplates}
            onExport={handleExportAllEngineTemplates}
            isCollapsed={engineSidebarCollapsed}
            onCollapsedChange={setEngineSidebarCollapsed}
          />
        }
      />
      )}
      </ResizableSidebar>
      )}

      {/* Main Content Area */}
      <div className={`flex-1 bg-os-card overflow-hidden flex flex-col ${isMobile ? 'min-w-0' : ''}`}>
        {isMobile && <MobilePageHeader title="JQL Search" subtitle="Jira" />}
        {/* Jira Status Banner */}
        {!statusBannerDismissed && (
          <>
            {loadingMetadata ? (
              <div className="bg-blue-50 border-b border-blue-200 px-6 py-3">
                <div className="flex items-start gap-3">
                  <Loader size={20} className="text-blue-600 shrink-0 mt-0.5 animate-spin" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-blue-800">Syncing with Jira</p>
                    <p className="text-xs text-blue-700 mt-1">
                      Fetching latest metadata from Jira...
                    </p>
                  </div>
                  <button
                    onClick={() => setStatusBannerDismissed(true)}
                    className="p-1 hover:bg-blue-100 rounded-sm transition-colors"
                    title="Dismiss"
                  >
                    <X size={16} className="text-blue-600" />
                  </button>
                </div>
              </div>
            ) : cooldown > 0 ? (
              <div className="bg-yellow-50 border-b border-yellow-200 px-6 py-3">
                <div className="flex items-start gap-3">
                  <Timer size={20} className="text-yellow-600 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-yellow-800">Rate Limit Cooldown</p>
                    <p className="text-xs text-yellow-700 mt-1">
                      API calls are paused. Please wait <span className="font-semibold">{cooldown}</span> seconds before trying again.
                    </p>
                  </div>
                  <button
                    onClick={() => setStatusBannerDismissed(true)}
                    className="p-1 hover:bg-yellow-100 rounded-sm transition-colors"
                    title="Dismiss"
                  >
                    <X size={16} className="text-yellow-600" />
                  </button>
                </div>
              </div>
            ) : jiraStatus === 'error' ? (
              <div className="bg-red-50 dark:bg-red-900/20 px-6 py-3">
                <div className="flex items-start gap-3">
                  <AlertCircle size={20} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-red-800 dark:text-red-200">Disconnected from Jira</p>
                    <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                      Unable to connect to Jira. Please check your connection and authentication.
                    </p>
                  </div>
                  <button
                    onClick={() => setStatusBannerDismissed(true)}
                    className="p-1 hover:bg-red-100 rounded-sm transition-colors"
                    title="Dismiss"
                  >
                    <X size={16} className="text-red-600" />
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {children}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={showDeleteModal && !!templateToDelete}
        onClose={() => {
          setShowDeleteModal(false);
          setTemplateToDelete(null);
        }}
        onConfirm={confirmDeleteTemplate}
        title="Delete Template"
        message={`Are you sure you want to delete "${templateToDelete?.name}"?\n\nThis action cannot be undone.`}
        confirmText="Delete"
        dangerous={true}
      />

      {/* Change Category Modal */}
      {showChangeCategoryModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => {
            setShowChangeCategoryModal(false);
            setTemplateToChangeCategory(null);
            setSelectedNewCategory('');
            setNewCategoryName('');
          }}
        >
          <div
            className="bg-os-card rounded-lg shadow-xl w-full max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-os-border">
              <h3 className="text-lg font-semibold text-os-text-primary">Change Category</h3>
            </div>
            <div className="px-6 py-4">
              <p className="text-sm text-os-text-primary mb-4">
                Change category for <strong>"{templateToChangeCategory?.name}"</strong>
              </p>

              <div className="mb-4">
                <label className="block text-sm text-os-text-primary mb-2">
                  Select Existing Category
                </label>
                <select
                  value={selectedNewCategory}
                  onChange={(e) => {
                    setSelectedNewCategory(e.target.value);
                    setNewCategoryName(''); // Clear new category input when selecting existing
                  }}
                  className="w-full px-3 py-2 border border-os-input-border rounded-sm bg-os-card text-sm focus:outline-hidden focus:border-os-blue transition-colors"
                >
                  <option value="">-- Select Category --</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div className="border-t border-os-border pt-4">
                <label className="block text-sm text-os-text-primary mb-2">
                  Or Create New Category
                </label>
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => {
                    setNewCategoryName(e.target.value);
                    setSelectedNewCategory(''); // Clear dropdown when typing new category
                  }}
                  placeholder="Enter new category name"
                  className="w-full px-3 py-2 text-sm border border-os-input-border rounded-sm bg-os-card outline-hidden focus:border-os-blue transition-colors"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newCategoryName.trim()) {
                      handleCreateAndApplyCategory();
                    }
                  }}
                />
                {newCategoryName.trim() && (
                  <button
                    onClick={handleCreateAndApplyCategory}
                    className="mt-2 w-full px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors rounded-sm"
                  >
                    Create & Apply "{newCategoryName.trim()}"
                  </button>
                )}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-os-border flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowChangeCategoryModal(false);
                  setTemplateToChangeCategory(null);
                  setSelectedNewCategory('');
                  setNewCategoryName('');
                }}
                className="px-4 py-2 text-sm bg-os-card-secondary hover:bg-os-divider text-os-text-primary rounded-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmChangeCategory}
                disabled={!selectedNewCategory}
                className="px-4 py-2 text-sm bg-os-blue hover:bg-os-blue-hover text-white rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Apply Selected
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Engine Template Modal */}
      <EngineTemplateModal
        isOpen={showEngineModal}
        template={editingEngineTemplate}
        categories={engineCategories}
        onSave={handleSaveEngineTemplate}
        onCancel={() => {
          setShowEngineModal(false);
          setEditingEngineTemplate(null);
        }}
      />

      {/* Engine Input Modal */}
      <EngineInputModal
        isOpen={showEngineInputModal}
        template={currentEngineTemplate}
        onSearch={() => {
          setShowEngineInputModal(false);
          setCurrentEngineTemplate(null);
        }}
        onCancel={() => {
          setShowEngineInputModal(false);
          setCurrentEngineTemplate(null);
        }}
      />

      {/* Engine Delete Modal */}
      <ConfirmationModal
        isOpen={showEngineDeleteModal && !!engineTemplateToDelete}
        onClose={() => {
          setShowEngineDeleteModal(false);
          setEngineTemplateToDelete(null);
        }}
        onConfirm={confirmDeleteEngineTemplate}
        title="Delete Search Query"
        message={`Are you sure you want to delete "${engineTemplateToDelete?.name}"?\n\nThis action cannot be undone.`}
        confirmText="Delete"
        dangerous={true}
      />

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="sc-context-menu fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          {contextMenu.type === 'category' && (
            <>
              <button
                onClick={(e) => {
                  handleImportToCategory(contextMenu.target, e);
                  setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="import" />
                Import to Category
              </button>
              <button
                onClick={(e) => {
                  handleExportCategory(contextMenu.target, e);
                  setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="export" />
                Export Category
              </button>
            </>
          )}
          {contextMenu.type === 'template' && (
            <>
              <button
                onClick={(e) => {
                  handleEdit(contextMenu.target, e);
                  setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="edit" />
                Edit Template
              </button>
              <button
                onClick={(e) => {
                  handleChangeCategory(contextMenu.target, e);
                  setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="moveToCategory" />
                Change Category
              </button>
              <div className="border-t border-os-border my-1"></div>
              <button
                onClick={(e) => {
                  handleDelete(contextMenu.target.id, e);
                  setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="delete" danger />
                Delete Template
              </button>
            </>
          )}
          {contextMenu.type === 'engine' && (
            <>
              <button
                onClick={() => {
                  setEditingEngineTemplate(contextMenu.target);
                  setShowEngineModal(true);
                  setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="edit" />
                Edit Search
              </button>
              <button
                onClick={() => handleDuplicateEngineTemplate(contextMenu.target)}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="duplicate" />
                Duplicate
              </button>
              <div className="border-t border-os-border my-1"></div>
              <button
                onClick={() => {
                  handleDeleteEngineTemplate(contextMenu.target);
                }}
                className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="delete" danger />
                Delete Search
              </button>
            </>
          )}
          {contextMenu.type === 'engineCategory' && (
            <>
              <button
                onClick={() => {
                  setEditingEngineTemplate(null);
                  setShowEngineModal(true);
                  setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="new" />
                Add New Search Query
              </button>
              <div className="border-t border-os-border my-1"></div>
              <button
                onClick={() => {
                  handleImportEngineTemplates();
                  setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="import" />
                Import Category
              </button>
              <button
                onClick={() => {
                  handleExportEngineCategory(contextMenu.target);
                  setContextMenu({ visible: false, x: 0, y: 0, type: null, target: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="export" />
                Export Category
              </button>
            </>
          )}
        </div>
      )}

      {/* Import Flow for JQL Templates */}
      <ImportFlow
        isInputOpen={jqlTemplateImportFlow.showInputModal}
        isProgressOpen={jqlTemplateImportFlow.showProgressModal}
        onInputClose={jqlTemplateImportFlow.handleInputClose}
        onProgressClose={jqlTemplateImportFlow.handleProgressClose}
        onValidated={jqlTemplateImportFlow.handleInputValidated}
        importData={jqlTemplateImportFlow.importData}
        title="Import JQL Templates"
        placeholder="Paste your JQL templates JSON here..."
        validateFn={jqlTemplateImportFlow.validateFn}
        onImportItem={jqlTemplateImportFlow.onImportItem}
        exampleFormat={`{
  "templates": [
    {
      "name": "Template Name",
      "description": "Description",
      "category": "General",
      "icon": "Bookmark",
      "rootGroup": {...},
      "sortFields": [...]
    }
  ]
}`}
        exampleData={{
          templates: [
            {
              name: 'Example JQL Template',
              description: 'An example JQL template',
              category: 'General',
              icon: 'Bookmark',
              rootGroup: {
                operator: 'AND',
                conditions: []
              },
              sortFields: []
            }
          ]
        }}
      />

      {/* Import Flow for Engine Templates */}
      <ImportFlow
        isInputOpen={engineTemplateImportFlow.showInputModal}
        isProgressOpen={engineTemplateImportFlow.showProgressModal}
        onInputClose={engineTemplateImportFlow.handleInputClose}
        onProgressClose={engineTemplateImportFlow.handleProgressClose}
        onValidated={engineTemplateImportFlow.handleInputValidated}
        importData={engineTemplateImportFlow.importData}
        title="Import Search Engines"
        placeholder="Paste your search engines JSON here..."
        validateFn={engineTemplateImportFlow.validateFn}
        onImportItem={engineTemplateImportFlow.onImportItem}
        exampleFormat={`[
  {
    "name": "Engine Name",
    "urlTemplate": "https://example.com/search?q={{query}}",
    "category": "General",
    "description": "Description"
  }
]`}
        exampleData={[
          {
            name: 'Example Search Engine',
            urlTemplate: 'https://example.com/search?q={{query}}',
            category: 'General',
            description: 'An example search engine'
          },
          {
            name: 'Another Engine',
            urlTemplate: 'https://another.com/q={{query}}',
            category: 'Custom',
            description: 'Another example'
          }
        ]}
      />

    </div>
  );
}
