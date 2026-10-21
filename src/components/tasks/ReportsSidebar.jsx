import { useState, useEffect } from 'react';
import { Filter, ChevronRight, AlertCircle, Menu, Edit } from 'lucide-react';
import { useNotifications } from '../../contexts/NotificationContext';
import { getCustomReports, createCustomReport, updateCustomReport, deleteCustomReport } from '../../utils/customReports';
import { useDropdownMenu, useContextMenu } from '../../hooks/useContextMenu';
import { useCategories } from '../../hooks/useCategories';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import HamburgerMenu, { HamburgerMenuItem, HamburgerMenuDivider } from '../common/menus/HamburgerMenu';
import CategoryList from '../common/sidebar/CategoryList';
import CustomReportModal from './CustomReportModal';
import ConfirmationModal from '../common/modals/ConfirmationModal';
import { useConfirmation } from '../../hooks/useConfirmation';
import { MenuItemIcon } from '../common/menus/MenuItemIcon';
import { MENU_ICONS } from '../common/menus/menuIcons';

export default function ReportsSidebar({
  activeInstance,
  onFilterApply,
  onFilterClear,
  activeFilter,
  isCollapsed,
  onCollapsedChange,
}) {
  const { addNotification } = useNotifications();
  const { confirm, confirmationProps } = useConfirmation();
  const [customReports, setCustomReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [executingReportId] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [editingReport, setEditingReport] = useState(null);
  const [expandedCategories, setExpandedCategories] = useLocalStorage('expandedReportCategories', []);

  // Category utilities
  const {
    editingCategory,
    startEditingCategory,
    cancelEditingCategory,
    getCategoriesFromItems,
    getItemsByCategory,
  } = useCategories([], null);

  // Dropdown menu for hamburger
  const {
    isOpen: menuOpen,
    position: menuPosition,
    menuRef,
    openMenu,
    closeMenu,
  } = useDropdownMenu();

  // Context menu for right-click
  const {
    contextMenu,
    contextMenuRef,
    openContextMenu,
    closeContextMenu,
  } = useContextMenu();

  const loadReports = async () => {
    try {
      setLoading(true);
      const reports = await getCustomReports();
      setCustomReports(reports);
    } catch (error) {
      console.error('Error loading custom reports:', error);
    } finally {
      setLoading(false);
    }
  };

  // Load custom reports on mount. loadReports flips the loading flag
  // synchronously on purpose so the sidebar shows its spinner immediately.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadReports();
  }, []);

  const handleSubmit = async (formData, editingRpt) => {
    if (editingRpt) {
      await updateCustomReport(editingRpt.id, formData);
    } else {
      await createCustomReport(formData);
    }
    await loadReports();
    setShowModal(false);
    setEditingReport(null);
  };

  const handleEdit = (report) => {
    setEditingReport(report);
    setShowModal(true);
  };

  const handleDelete = async (report) => {
    if (await confirm({
      title: 'Delete Filter',
      message: `Delete filter "${report.name}"?`,
      type: 'danger',
      confirmLabel: 'Delete',
    })) {
      try {
        await deleteCustomReport(report.id);
        await loadReports();
        addNotification('Filter deleted', 'success');
      } catch (error) {
        console.error('Error deleting filter:', error);
        addNotification(`Failed to delete filter: ${error.message}`, 'error');
      }
    }
  };

  const toggleCategory = (categoryName) => {
    setExpandedCategories(prev =>
      prev.includes(categoryName)
        ? prev.filter(c => c !== categoryName)
        : [...prev, categoryName]
    );
  };

  const handleRenameCategory = async (oldName, newName) => {
    if (!newName || newName.trim() === '') return;
    if (oldName === newName) return;

    try {
      // Find all reports in the old category and update them
      const reportsInCategory = customReports.filter(
        report => (report.category || 'General') === oldName
      );

      // Update each report's category
      for (const report of reportsInCategory) {
        await updateCustomReport(report.id, { category: newName });
      }

      // Update expanded categories
      setExpandedCategories(prev => {
        const updated = prev.map(cat => cat === oldName ? newName : cat);
        return updated;
      });

      await loadReports();
    } catch (error) {
      console.error('Error renaming category:', error);
      addNotification(`Failed to rename category: ${error.message}`, 'error');
    }
  };

  const handleExecuteReport = async (report) => {
    if (!activeInstance) {
      addNotification('No active instance', 'error');
      return;
    }

    // Check if this filter is already active
    const isActive = activeFilter && activeFilter.reportId === report.id;

    if (isActive) {
      // If active, clear the filter
      if (onFilterClear) {
        onFilterClear();
      }
    } else {
      // If not active, apply the filter
      if (onFilterApply) {
        onFilterApply({
          filterName: report.name,
          filter: report.filter,
          reportId: report.id,
        });
      }
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden border-t border-os-border bg-os-card">
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-card shrink-0">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => onCollapsedChange?.(!isCollapsed)}
            className="flex items-center gap-2 min-w-0 flex-1 hover:bg-os-card-secondary transition-colors px-2 py-1 rounded-none"
          >
            <ChevronRight size={16} className={`text-os-text-secondary shrink-0 transition-transform ${isCollapsed ?'':'rotate-90'}`} />
            <span className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
              Filters
            </span>
          </button>
          {!isCollapsed && (
            <button
              onClick={(e) => openMenu(e, { align: 'right' })}
              className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors shrink-0"
              title="Filters menu"
            >
              <Menu size={16} className="text-os-text-secondary" />
            </button>
          )}
        </div>
      </div>

      {/* Reports List - Only show when not collapsed */}
      {!isCollapsed && (
        <div className="flex-1 overflow-y-auto bg-os-card">
          {!activeInstance ? (
            <div className="p-4 text-center">
              <AlertCircle size={24} className="text-os-text-muted mx-auto mb-2 opacity-50" />
              <p className="text-xs text-os-text-secondary">No instance selected</p>
            </div>
          ) : loading ? (
            <div className="p-4 text-center">
              <p className="text-xs text-os-text-secondary">Loading reports...</p>
            </div>
          ) : customReports.length === 0 ? (
            <div className="p-4 text-center">
              <Filter size={32} className="text-os-text-muted mx-auto mb-2 opacity-50" />
              <p className="text-xs text-os-text-secondary">No custom filters</p>
            </div>
          ) : (
            <CategoryList
              categories={getCategoriesFromItems(customReports)}
              items={customReports}
              getItemsByCategory={(cat) => getItemsByCategory(customReports, cat)}
              expandedCategories={expandedCategories}
              onToggleCategory={toggleCategory}
              onRenameCategory={handleRenameCategory}
              editingCategory={editingCategory}
              onEditingCategoryChange={(cat) => {
                cat ? startEditingCategory(cat) : cancelEditingCategory();
              }}
              itemListProps={{
                onItemClick: (report) => handleExecuteReport(report),
                onItemContextMenu: (report, e) => {
                  openContextMenu(e, 'report', report);
                },
                renderItem: (report) => {
                  const isActiveFilter = activeFilter && activeFilter.reportId === report.id;
                  return (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <Filter size={14} className={isActiveFilter ?"text-purple-600":"text-os-text-muted"} />
                        <div className="flex-1 min-w-0">
                          <span className={`text-sm block truncate ${isActiveFilter ?"text-purple-600":"text-os-text-primary"}`}>
                            {report.name}
                          </span>
                          {report.filter && (
                            <span className={`text-xs block truncate font-mono ${isActiveFilter ?"text-purple-500":"text-os-text-muted"}`}>
                              {report.filter}
                            </span>
                          )}
                        </div>
                      </div>
                      {executingReportId === report.id && (
                        <div className="w-4 h-4 border-2 border-os-blue border-t-transparent rounded-full animate-spin shrink-0" />
                      )}
                    </div>
                  );
                },
                getItemClassName: (report) => {
                  const isActiveFilter = activeFilter && activeFilter.reportId === report.id;
                  return `group relative px-4 py-2.5 cursor-pointer transition-colors border-l-4 ${
                    isActiveFilter
                      ? 'border-purple-600 bg-purple-50 dark:bg-purple-900/20'
                      : 'border-transparent hover:bg-os-card-secondary'
                  }`;
                },
              }}
            />
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
          label="New Filter"
          onClick={() => {
            setEditingReport(null);
            setShowModal(true);
            closeMenu();
          }}
        />
      </HamburgerMenu>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="sc-context-menu fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px]"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          {contextMenu.type === 'report' && contextMenu.target && (
            <>
              <button
                onClick={() => {
                  handleExecuteReport(contextMenu.target);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="applyFilter" />
                Apply Filter
              </button>
              <div className="border-t border-os-border my-1"></div>
              <button
                onClick={() => {
                  handleEdit(contextMenu.target);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="edit" />
                Edit Filter
              </button>
              <div className="border-t border-os-border my-1"></div>
              <button
                onClick={() => {
                  handleDelete(contextMenu.target);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="delete" danger />
                Delete Filter
              </button>
            </>
          )}
        </div>
      )}

      {/* Custom Report Modal */}
      <CustomReportModal
        isOpen={showModal}
        onClose={() => {
          setShowModal(false);
          setEditingReport(null);
        }}
        onSubmit={handleSubmit}
        editingReport={editingReport}
      />

      {/* Confirmation Modal (replaces native window.confirm) */}
      <ConfirmationModal {...confirmationProps} />
    </div>
  );
}
