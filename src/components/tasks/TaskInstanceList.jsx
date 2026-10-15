import { useState, useEffect } from 'react';
import { Database, Cloud, CheckSquare, Edit, Upload, Crown } from 'lucide-react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useCategories } from '../../hooks/useCategories';
import { useContextMenu, useDropdownMenu } from '../../hooks/useContextMenu';
import { useImportExport } from '../../hooks/useImportExport';
import SidebarHeader from '../common/sidebar/SidebarHeader';
import CategoryList from '../common/sidebar/CategoryList';
import HamburgerMenu, { HamburgerMenuItem, HamburgerMenuDivider } from '../common/menus/HamburgerMenu';
import TaskInstanceModal from './TaskInstanceModal';
import DocumentPermissionsModal from '../common/modals/DocumentPermissionsModal';
import ConfirmationModal from '../common/modals/ConfirmationModal';
import { useConfirmation } from '../../hooks/useConfirmation';
import {
  createInstance,
  updateInstance,
  deleteInstance,
  setActiveInstance,
  validateInstance,
  initializeInstance,
} from '../../utils/taskwarriorInstances';
import { getMachineId, uploadTaskInstanceToCentral, removeDocumentFromCentral } from '../../utils/cloudCentralSync';
import { getUserBorderStyle } from '../../utils/userColors';
import { useNotifications } from '../../contexts/NotificationContext';
import { EmptyState } from '../ui';
import { MenuItemIcon } from '../common/menus/MenuItemIcon';
import { MENU_ICONS } from '../common/menus/menuIcons';

export default function TaskInstanceList({
  instances,
  activeInstance,
  onInstanceClick,
  onInstanceCreate,
  onInstanceUpdate,
  onInstanceDelete,
  onInstanceSetActive,
  onRefresh,
  taskWarriorInstalled = true,
  checkingInstallation = false,
  sortBy = 'date',
  onSortChange,
}) {
  const { addNotification } = useNotifications();
  const { confirm, confirmationProps } = useConfirmation();
  const [showModal, setShowModal] = useState(false);
  const [editingInstance, setEditingInstance] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [expandedCategories, setExpandedCategories] = useLocalStorage('expandedTaskInstanceCategories', []);
  const [currentMachineId, setCurrentMachineId] = useState(null);
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [permissionsInstance, setPermissionsInstance] = useState(null);

  // Category utilities
  const {
    editingCategory,
    startEditingCategory,
    cancelEditingCategory,
    getCategoriesFromItems,
    getItemsByCategory,
  } = useCategories([], null);

  // Context menu
  const {
    contextMenu,
    contextMenuRef,
    openContextMenu,
    closeContextMenu,
  } = useContextMenu();

  // Dropdown menu (hamburger)
  const {
    isOpen: menuOpen,
    position: menuPosition,
    menuRef,
    openMenu,
    closeMenu,
  } = useDropdownMenu();

  // Import/Export
  const { exportToJSON, importFromJSON } = useImportExport();

  // Toggle category expansion
  const toggleCategory = (categoryName) => {
    setExpandedCategories(prev =>
      prev.includes(categoryName)
        ? prev.filter(c => c !== categoryName)
        : [...prev, categoryName]
    );
  };

  // Get machine ID for cloud features
  useEffect(() => {
    getMachineId().then(id => setCurrentMachineId(id));
  }, []);

  // Listen for event to open the modal from the main area
  useEffect(() => {
    const handleOpenForm = () => {
      setShowModal(true);
      setEditingInstance(null);
    };

    window.addEventListener('openTaskInstanceForm', handleOpenForm);
    return () => window.removeEventListener('openTaskInstanceForm', handleOpenForm);
  }, []);

  const handleSubmit = async (formData, editingInst) => {
    if (editingInst) {
      await updateInstance(editingInst.id, formData);
      onInstanceUpdate && onInstanceUpdate();
    } else {
      // Validate before creating
      if (formData.dataPath) {
        const validation = await validateInstance(
          formData.rcPath || null,
          formData.dataPath
        );

        if (!validation.valid && validation.errors.length > 0) {
          // Ask user if they want to initialize
          if (await confirm({
            title: 'Instance Validation Failed',
            message: `Instance validation failed:\n${validation.errors.join('\n')}\n\nDo you want to initialize this instance?`,
            type: 'warning',
            confirmLabel: 'Initialize',
          })) {
            await initializeInstance(
              formData.dataPath,
              formData.rcPath || '',
              {}
            );
          } else {
            throw new Error('Validation failed');
          }
        }
      }

      await createInstance(formData);
      onInstanceCreate && onInstanceCreate();
    }

    onRefresh && onRefresh();
  };

  const handleEdit = (e, instance) => {
    if (e) e.stopPropagation();
    setEditingInstance(instance);
    setShowModal(true);
  };

  const handleDelete = async (e, instance) => {
    if (e) e.stopPropagation();
    if (await confirm({
      title: 'Delete Instance',
      message: `Delete instance "${instance.name}"? This will also delete all associated tasks and reports.`,
      type: 'danger',
      confirmLabel: 'Delete',
    })) {
      try {
        await deleteInstance(instance.id);
        onInstanceDelete && onInstanceDelete();
        onRefresh && onRefresh();
      } catch (error) {
        console.error('Error deleting instance:', error);
        addNotification({
          type: 'error',
          title: 'Delete Failed',
          message: `Error: ${error.message}`
        });
      }
    }
  };

  const handleInstanceClick = async (instance) => {
    try {
      // Set as active instance in database
      await setActiveInstance(instance.id);

      // First open the tab to set currentInstanceId
      if (onInstanceClick) {
        onInstanceClick(instance);
      }

      // Then refresh to reload with the new currentInstanceId and active status
      // This ensures handleInstanceRefresh uses the correct currentInstanceId
      if (onInstanceSetActive) {
        await onInstanceSetActive();
      }
    } catch (error) {
      console.error('Error setting active instance:', error);
      addNotification({
        type: 'error',
        title: 'Activation Failed',
        message: `Error: ${error.message}`
      });
    }
  };

  const handleCloudSync = async () => {
    setIsSyncing(true);
    try {
      // Refresh instances and tasks
      if (onRefresh) {
        await onRefresh();
      }
    } catch (error) {
      console.error('Cloud sync failed:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleRenameCategory = async (oldName, newName) => {
    if (!newName || newName.trim() === '') return;
    if (oldName === newName) return;

    try {
      // Find all instances in the old category and update them
      const instancesInCategory = instances.filter(
        inst => (inst.category || 'General') === oldName
      );

      // Update each instance's category
      for (const instance of instancesInCategory) {
        await updateInstance(instance.id, { category: newName });
      }

      // Update expanded categories
      setExpandedCategories(prev => {
        const updated = prev.map(cat => cat === oldName ? newName : cat);
        return updated;
      });

      onRefresh && onRefresh();
    } catch (error) {
      console.error('Error renaming category:', error);
      addNotification({
        type: 'error',
        title: 'Rename Failed',
        message: `Error: ${error.message}`
      });
    }
  };

  const handleUploadToCloud = async (instance) => {
    try {
      closeContextMenu();

      if (!currentMachineId) {
        addNotification({ type: 'error', title: 'Cloud Upload Failed', message: 'Unable to get machine ID' });
        return;
      }

      // Upload to central server using dedicated task instance function
      await uploadTaskInstanceToCentral({
        ...instance,
        ownerId: currentMachineId,
      });

      addNotification({ type: 'success', title: 'Uploaded to Cloud', message: `Instance "${instance.name}" uploaded to cloud` });
      onRefresh && onRefresh();
    } catch (error) {
      console.error('Error uploading to cloud:', error);
      addNotification({ type: 'error', title: 'Cloud Upload Failed', message: `Failed to upload: ${error.message}` });
    }
  };

  const handleRemoveFromCloud = async (instance) => {
    try {
      closeContextMenu();

      // Validate instance has required cloud metadata
      if (!instance.ownerId) {
        addNotification({ type: 'error', title: 'Cannot Remove', message: 'Cannot remove: Instance has no owner ID' });
        return;
      }

      if (instance.ownerId !== currentMachineId) {
        addNotification({ type: 'error', title: 'Cannot Remove', message: 'Cannot remove: Only the owner can remove this instance from cloud' });
        return;
      }

      if (!(await confirm({
        title: 'Remove from Cloud',
        message: `Remove "${instance.name}" from cloud? This will only remove it from the cloud server, not from your local database.`,
        type: 'warning',
        confirmLabel: 'Remove',
      }))) {
        return;
      }

      // Remove from central server
      // Pass the instance object with required fields: ownerId, title (name), id
      await removeDocumentFromCentral({
        id: instance.id,
        ownerId: instance.ownerId,
        title: instance.name,
        cloudDocumentId: instance.cloudDocumentId
      });

      // Update local instance
      await updateInstance(instance.id, {
        inCloud: 0,
        ownerId: null,
        cloudDocumentId: null,
      });

      addNotification({ type: 'success', title: 'Removed from Cloud', message: `Instance "${instance.name}" removed from cloud` });
      onRefresh && onRefresh();
    } catch (error) {
      console.error('Error removing from cloud:', error);
      addNotification({ type: 'error', title: 'Cloud Removal Failed', message: `Failed to remove from cloud: ${error.message}` });
    }
  };

  const handleSavePermissions = async (permissions) => {
    if (!permissionsInstance) return;

    try {
      await updateInstance(permissionsInstance.id, {
        permissions: permissions
      });

      // Get the updated instance and sync to cloud if it's a cloud instance
      if (permissionsInstance.inCloud && permissionsInstance.ownerId === currentMachineId) {
        const { getInstance } = await import('../../utils/taskwarriorInstances');
        const updatedInstance = await getInstance(permissionsInstance.id);
        if (updatedInstance) {
          await uploadTaskInstanceToCentral(updatedInstance);
        }
      }

      addNotification({ type: 'success', title: 'Permissions Updated', message: `Permissions for "${permissionsInstance.name}" have been updated` });
      onRefresh && onRefresh();
    } catch (error) {
      console.error('Failed to update permissions:', error);
      addNotification({ type: 'error', title: 'Permissions Update Failed', message: `Failed to update permissions: ${error.message}` });
    }
  };

  const handleExportInstance = (instance) => {
    exportToJSON([instance], `task-instance-${instance.name}`);
    closeContextMenu();
  };

  const handleExportCategory = (categoryName) => {
    const categoryInstances = instances.filter(inst => (inst.category || 'General') === categoryName);
    exportToJSON(categoryInstances, `task-instances-${categoryName}`);
    closeContextMenu();
  };

  const handleImportInstances = async () => {
    closeMenu();
    try {
      const imported = await importFromJSON();
      if (imported && Array.isArray(imported)) {
        for (const inst of imported) {
          const { id: _id, ...instanceData } = inst;
          await createInstance(instanceData);
        }
        addNotification({ type: 'success', title: 'Instances Imported', message: `Imported ${imported.length} instance(s)` });
        onRefresh && onRefresh();
      }
    } catch (error) {
      console.error('Error importing instances:', error);
      addNotification({ type: 'error', title: 'Import Failed', message: `Failed to import: ${error.message}` });
    }
  };

  const handleExportInstances = () => {
    exportToJSON(instances, 'task-instances');
    closeMenu();
  };

  // Get status for header
  const getStatus = () => {
    if (checkingInstallation) return 'checking';
    return taskWarriorInstalled ? 'online' : 'offline';
  };

  const getStatusTitle = () => {
    if (checkingInstallation) return 'Checking TaskWarrior installation...';
    return taskWarriorInstalled ? 'TaskWarrior is installed' : 'TaskWarrior is not installed';
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-os-card">
      {/* Header */}
      <SidebarHeader
        title="TASKS"
        icon={CheckSquare}
        status={getStatus()}
        statusTitle={getStatusTitle()}
        onMenuClick={(e) => openMenu(e, { align: 'right' })}
        onAddClick={() => {
          setEditingInstance(null);
          setShowModal(true);
        }}
        actions={
          <button
            onClick={handleCloudSync}
            disabled={isSyncing}
            className="p-1.5 rounded-sm transition-colors hover:bg-os-card-secondary disabled:opacity-50"
            title="Check for cloud updates"
          >
          </button>
        }
      />

      {/* Instance List */}
      <div className="flex-1 overflow-y-auto bg-os-card">
        {instances.length === 0 ? (
          <EmptyState compact icon={CheckSquare} title="No instances yet" description="Create your first TaskWarrior instance" />
        ) : (
          <CategoryList
            categories={getCategoriesFromItems(instances)}
            items={instances}
            getItemsByCategory={(cat) => getItemsByCategory(instances, cat)}
            expandedCategories={expandedCategories}
            onToggleCategory={toggleCategory}
            onRenameCategory={handleRenameCategory}
            editingCategory={editingCategory}
            onEditingCategoryChange={(cat) => {
              cat ? startEditingCategory(cat) : cancelEditingCategory();
            }}
            itemListProps={{
              onItemClick: (instance) => handleInstanceClick(instance),
              onItemContextMenu: (instance, e) => {
                openContextMenu(e, 'instance', instance);
              },
              renderItem: (instance) => {
                const isActive = activeInstance?.id === instance.id;
                const isCloudInstance = instance.inCloud === 1;

                return (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Database
                        size={14}
                        className={`shrink-0 ${
 isCloudInstance && isActive
 ?'text-purple-700'
 : isActive
 ?'text-os-blue'
 :'text-os-text-muted'
 }`}
                      />
                      <span className={`text-sm truncate ${
 isCloudInstance && isActive
 ?'text-purple-700'
 : isActive
 ?'text-os-blue font-medium'
 :'text-os-text-primary'
 }`}>
                        {instance.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isCloudInstance && (
                        <div className="flex items-center gap-0.5" title={instance.ownerId === currentMachineId ? `Your cloud task instance\nOwner: ${instance.ownerId || 'Unknown'}` : `Cloud task instance\nOwner: ${instance.ownerId || 'Unknown'}`}>
                          {instance.ownerId === currentMachineId && (
                            <Crown size={10} className="text-purple-600" />
                          )}
                          <Cloud size={12} className="text-purple-600" />
                        </div>
                      )}
                    </div>
                  </div>
                );
              },
              getItemClassName: (instance) => {
                const isActive = activeInstance?.id === instance.id;
                const isCloudInstance = instance.inCloud === 1;

                // Cloud instances
                if (isCloudInstance) {
                  if (isActive) {
                    // Active cloud instance: darker purple background
                    return 'group relative px-4 py-3 cursor-pointer transition-colors border-l-4 bg-purple-100 hover:bg-purple-200';
                  } else {
                    // Inactive cloud instance: lighter purple background, colored border from style
                    return 'group relative px-4 py-3 cursor-pointer transition-colors border-l-4 bg-purple-50 hover:bg-purple-100';
                  }
                }

                // Non-cloud instances
                return `
                  group relative px-4 py-3 cursor-pointer transition-colors border-l-4
                  ${
                    isActive
                      ? 'bg-os-card-secondary'
                      : 'border-transparent hover:bg-os-card-secondary'
                  }
                `;
              },
              getItemStyle: (instance) => {
                const isCloudInstance = instance.inCloud === 1;

                // Add dynamic border color based on owner (for all items, not just active)
                const style = {};
                if (isCloudInstance && instance.ownerId) {
                  // Cloud instances: use their ownerId
                  Object.assign(style, getUserBorderStyle(instance.ownerId));
                } else if (!isCloudInstance && currentMachineId) {
                  // Local instances: use current machine ID
                  Object.assign(style, getUserBorderStyle(currentMachineId));
                }

                return Object.keys(style).length > 0 ? style : undefined;
              },
            }}
          />
        )}
      </div>

      {/* Hamburger Menu */}
      <HamburgerMenu
        isOpen={menuOpen}
        position={menuPosition}
        onClose={closeMenu}
        ref={menuRef}
      >
        <HamburgerMenuItem
          icon={MENU_ICONS.new}
          label="New Instance"
          onClick={() => {
            setEditingInstance(null);
            setShowModal(true);
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
                onSortChange && onSortChange('name');
                closeMenu();
              }}
              className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
 sortBy ==='name'?'bg-os-blue text-white':'hover:bg-os-card-secondary'
 }`}
            >
              <MenuItemIcon action="sortByTitle" className={sortBy === 'name' ? 'text-white' : 'text-os-text-secondary'} />
              Name (A-Z)
            </button>
          </div>
        </div>
        <HamburgerMenuDivider />
        <HamburgerMenuItem
          icon={MENU_ICONS.import}
          label="Import from JSON"
          onClick={handleImportInstances}
        />
        <HamburgerMenuDivider />
        <HamburgerMenuItem
          icon={MENU_ICONS.exportJson}
          label="Export All (JSON)"
          onClick={handleExportInstances}
        />
      </HamburgerMenu>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px]"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          {contextMenu.type === 'instance' && contextMenu.target && (
            <>
              <button
                onClick={() => {
                  handleEdit(null, contextMenu.target);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="edit" />
                Edit Instance
              </button>
              {contextMenu.target.inCloud !== 1 && (
                <button
                  onClick={() => handleUploadToCloud(contextMenu.target)}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="uploadToCloud" />
                  Upload to Cloud
                </button>
              )}
              {contextMenu.target.inCloud === 1 && contextMenu.target.ownerId === currentMachineId && (
                <>
                  <button
                    onClick={() => handleUploadToCloud(contextMenu.target)}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="syncToCloud" />
                    Sync to Cloud
                  </button>
                  <button
                    onClick={() => handleRemoveFromCloud(contextMenu.target)}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="removeFromCloud" />
                    Remove from Cloud
                  </button>
                  <button
                    onClick={() => {
                      setPermissionsInstance(contextMenu.target);
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
                onClick={() => handleExportInstance(contextMenu.target)}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="exportJson" />
                Export Instance (JSON)
              </button>
              <div className="border-t border-os-border my-1"></div>
              <button
                onClick={() => {
                  handleDelete(null, contextMenu.target);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="delete" danger />
                Delete Instance
              </button>
            </>
          )}

          {contextMenu.type === 'category' && (
            <>
              <button
                onClick={() => handleExportCategory(contextMenu.target)}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="exportJson" />
                Export Category (JSON)
              </button>
            </>
          )}
        </div>
      )}

      {/* Task Instance Modal */}
      <TaskInstanceModal
        isOpen={showModal}
        onClose={() => {
          setShowModal(false);
          setEditingInstance(null);
        }}
        onSubmit={handleSubmit}
        editingInstance={editingInstance}
      />

      {/* Permissions Modal */}
      <DocumentPermissionsModal
        isOpen={showPermissionsModal}
        onClose={() => {
          setShowPermissionsModal(false);
          setPermissionsInstance(null);
        }}
        document={permissionsInstance}
        onSave={handleSavePermissions}
      />

      {/* Confirmation Modal (replaces native window.confirm) */}
      <ConfirmationModal {...confirmationProps} />
    </div>
  );
}
