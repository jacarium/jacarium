import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { CheckCircle, Circle, Plus, RefreshCw, Search, X, Database, AlertCircle, Download, Trash2, Play, Clock, Check, Filter, ChevronRight, BarChart3 } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';
import { useYjsTasks } from '../hooks/useYjsTasks';
import { useLocalStorage } from '../hooks/useLocalStorage';
import useSyncedOpenTabs from '../hooks/useSyncedOpenTabs';
import { db as database } from '../db/database';
import {
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  getProjects,
  getAllTags,
  syncFromTaskWarrior,
  syncToTaskWarrior,
  startTask,
  stopTask,
  annotateTask,
  denotateTask,
  deleteTaskWarriorTask,
  purgeTaskWarriorTask,
  getOrphanedTasks,
  deleteOrphanedTasks,
  describeOrphanedTasks
} from '../utils/tasks';
import { getMachineId } from '../utils/cloudCentralSync';
import { getSocket } from '../utils/cloudWebSocket';
import { getActiveInstance, getAllInstances, executeReport } from '../utils/taskwarriorInstances';
import { checkTaskWarriorInstalled } from '../utils/taskwarriorCheck';
import ResizableSidebar from './ResizableSidebar';
import VerticalResizableDivider from './VerticalResizableDivider';
import TaskInstanceList from './tasks/TaskInstanceList';
import ReportsSidebar from './tasks/ReportsSidebar';
import TaskItem from './tasks/TaskItem';
import TaskContextMenu from './tasks/TaskContextMenu';
import { useContextMenu } from '../hooks/useContextMenu';
import { createDocument, getCategories as getDocumentCategoryNames } from '../utils/documents';
import { buildDocumentFromTask } from '../utils/taskDocument';
import { openDocumentInEditor, expandDocumentCategoryInSidebar } from '../utils/openDocument';
import TabBar from './features/documents/TabBar';
import ConfirmationModal from './common/ConfirmationModal';
import NoticeBanner, { NoticeBannerAction } from './common/NoticeBanner';
import { useMobile } from '../contexts/MobileContext';
import MobileTaskFilters from './mobile/MobileTaskFilters';
import { announceRowMenu } from './mobile/rowMenuAnchor';

export default function TasksPage() {
  const { addNotification } = useNotifications();
  const { isMobile } = useMobile();

  // Local tasks state
  const [localTasks, setLocalTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  // Instance state
  const [instances, setInstances] = useState([]);
  const [activeInstance, setActiveInstance] = useState(null);
  const [currentInstanceId, setCurrentInstanceId] = useLocalStorage('currentTaskInstanceId', null);
  const [openTabs, setOpenTabs] = useLocalStorage('taskInstanceOpenTabs', []);
  // the task list tabs follow the account's devices
  useSyncedOpenTabs({
    page: 'tasks', tabs: openTabs, setTabs: setOpenTabs,
    itemOf: async (tab) => (tab.type === 'instance' ? (await database.taskwarriorInstances.get(tab.id))?.syncId || null : null),
    titleOf: (tab) => tab.name || 'Untitled',
    resolve: async (item) => { const instance = await database.taskwarriorInstances.where('syncId').equals(item).first(); return instance ? { id: instance.id, instanceId: instance.id, name: instance.name, category: instance.category || 'General', description: instance.description, inCloud: instance.inCloud || false, type: 'instance' } : null; },
    onClose: (tab) => handleTabClose(tab.id),
  });
  const [currentTabId, setCurrentTabId] = useState(null);

  // Report results state
  const [reportResults, setReportResults] = useState({});

  // TaskWarrior installation check
  const [taskWarriorInstalled, setTaskWarriorInstalled] = useState(true);
  const [backendUnreachable, setBackendUnreachable] = useState(false);
  const [checkingInstallation, setCheckingInstallation] = useState(false);
  const [installBannerDismissed, setInstallBannerDismissed] = useState(false);

  // Cached tasks that belong to no TaskWarrior instance (instanceId
  // null / dangling): invisible in every instance, surfaced by a banner
  // with a one-click cleanup. Recomputed by loadTasks/loadInstances, so it
  // follows syncs, instance changes and deletions; a DB import reloads the
  // app, which runs the initial load again.
  const [orphanedTasks, setOrphanedTasks] = useState([]);
  const [cleaningOrphans, setCleaningOrphans] = useState(false);
  const cleaningOrphansRef = useRef(false);

  // Sidebar visibility
  const [innerSidebarVisible, setInnerSidebarVisible] = useLocalStorage('innerSidebarVisible', true);
  const [reportsSidebarCollapsed, setReportsSidebarCollapsed] = useLocalStorage('taskReportsSidebarCollapsed', false);

  // Sort order
  const [sortBy, setSortBy] = useLocalStorage('taskInstancesSortBy', 'date');

  // Auto-sync is always enabled
  const [isSyncing, setIsSyncing] = useState(false);

  // Cloud sharing state
  const [cloudEnabled] = useState(false);
  const [cloudTasksId] = useState(null);
  const [machineId, setMachineId] = useState('');
  // The shared cloud socket. getSocket() is a plain getter for the module
  // singleton (created at app startup), so a lazy initializer replaces the
  // old set-it-in-a-mount-effect pattern with identical behavior.
  const [socket] = useState(() => getSocket());

  // Task row right-click menu ("Create Document In"). The category list is
  // the Documents sidebar's own (getCategories: managed categories in their
  // order, then ad-hoc document categories, then General) and is refreshed
  // every time the menu opens so a category created meanwhile shows up.
  const { contextMenu: taskContextMenu, contextMenuRef: taskContextMenuRef, openContextMenu: openTaskContextMenu, closeContextMenu: closeTaskContextMenu } = useContextMenu();
  const [documentCategories, setDocumentCategories] = useState([]);

  // Filters
  const [statusFilter, setStatusFilter] = useState([]);
  const [projectFilter, setProjectFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [activeFilter, setActiveFilter] = useState(null);
  const [taskWarriorFilteredTasks, setTaskWarriorFilteredTasks] = useState(null);

  // Section collapse state
  const [expandedSections, setExpandedSections] = useLocalStorage('taskExpandedSections', {
    active: true,
    pending: true,
    waiting: true,
    completed: true,
    deleted: true,
  });

  // UI state
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [selectedTasks, setSelectedTasks] = useState([]);

  // Projects and tags for filters
  const [projects, setProjects] = useState([]);
  const [tags, setTags] = useState([]);

  const checkInstallation = async () => {
    setCheckingInstallation(true);
    try {
      const result = await checkTaskWarriorInstalled();
      // Only the backend can tell whether `task` exists: when it did not
      // answer, say so instead of "TaskWarrior Not Installed".
      setBackendUnreachable(result.backendReachable === false);
      setTaskWarriorInstalled(result.backendReachable === false ? true : result.installed);
      if (!result.installed) {
        setInstallBannerDismissed(false);
      }
    } catch (error) {
      console.error('[TasksPage] Error checking installation:', error);
      setBackendUnreachable(true);
      setTaskWarriorInstalled(true);
      setInstallBannerDismissed(false);
    } finally {
      setCheckingInstallation(false);
    }
  };

  const refreshOrphanedTasks = useCallback(async () => {
    try {
      setOrphanedTasks(await getOrphanedTasks());
    } catch (error) {
      console.error('[TasksPage] Error counting orphaned tasks:', error);
    }
  }, []);

  const loadInstances = async () => {
    try {
      const allInstances = await getAllInstances();
      setInstances(allInstances);
      await refreshOrphanedTasks();
    } catch (error) {
      console.error('[TasksPage] Error loading instances:', error);
    }
  };

  const handleCleanOrphanedTasks = async () => {
    // Ref guard: a second click before the first render commits must not
    // start a second delete.
    if (cleaningOrphansRef.current) return;
    cleaningOrphansRef.current = true;
    setCleaningOrphans(true);
    try {
      const removed = await deleteOrphanedTasks();
      await refreshOrphanedTasks();
      addNotification(`Removed ${removed} orphaned task${removed === 1 ? '' : 's'}`, 'success');
    } catch (error) {
      console.error('[TasksPage] Error removing orphaned tasks:', error);
      addNotification('Failed to remove orphaned tasks', 'error');
    } finally {
      cleaningOrphansRef.current = false;
      setCleaningOrphans(false);
    }
  };

  const loadProjectsAndTags = useCallback(async () => {
    try {
      const [projectsList, tagsList] = await Promise.all([
        getProjects(),
        getAllTags()
      ]);
      setProjects(projectsList);
      setTags(tagsList);
    } catch (error) {
      console.error('[TasksPage] Error loading projects/tags:', error);
    }
  }, []);

  const loadTasks = useCallback(async (instance) => {
    try {
      const tasks = await getTasks();
      console.log('[TasksPage] All tasks:', tasks.length);
      console.log('[TasksPage] Loading tasks for instance:', instance?.id, instance?.name);

      // Debug: Show all task instance IDs
      if (tasks.length > 0) {
        console.log('[TasksPage] Task instance IDs:', tasks.map(t => ({ id: t.id, instanceId: t.instanceId, desc: t.description })));
      }

      // Filter by active instance
      const filteredTasks = instance
        ? tasks.filter(t => t.instanceId === instance.id)
        : tasks;

      console.log('[TasksPage] Filtered tasks:', filteredTasks.length);
      setLocalTasks(filteredTasks);
      await refreshOrphanedTasks();
    } catch (error) {
      console.error('[TasksPage] Error loading tasks:', error);
      addNotification('Failed to load tasks', 'error');
    }
  }, [addNotification, refreshOrphanedTasks]);

  const loadInstanceData = useCallback(async (instanceId) => {
    try {
      // Always fetch fresh from database to avoid stale state
      const { getInstance } = await import('../utils/taskwarriorInstances');
      const instance = await getInstance(instanceId);

      console.log('[TasksPage] Loading instance data:', instance);

      if (!instance) {
        console.error('[TasksPage] Instance not found:', instanceId);
        setActiveInstance(null);
        setLocalTasks([]);
        return;
      }

      setActiveInstance(instance);

      // Auto-sync from TaskWarrior when loading instance
      // This ensures tasks from TaskWarrior CLI are always visible
      setIsSyncing(true);
      const syncResult = await syncFromTaskWarrior(
        instanceId,
        instance.rcPath || null,
        instance.dataPath || null
      );
      setIsSyncing(false);

      if (syncResult.success) {
        console.log(`[TasksPage] Auto-synced ${syncResult.count} tasks from TaskWarrior`);
      }

      await loadTasks(instance);
      await loadProjectsAndTags();
    } catch (error) {
      console.error('[TasksPage] Error loading instance data:', error);
      setIsSyncing(false);
    }
  }, [loadTasks, loadProjectsAndTags]);

  // Memoize cloud tasks to prevent re-creating array on every render
  const cloudTasksList = useMemo(() => {
    return localTasks.filter(t => t.inCloud);
  }, [localTasks]);

  // Yjs collaborative tasks
  const {
    // tasks: cloudTasks, // Currently unused - tasks come from localTasks
    // connectedUsers, // Currently unused
    // isConnected: isCloudConnected, // Currently unused
    updateTask: updateCloudTask,
    addTask: addCloudTask,
    deleteTask: deleteCloudTask,
    setUserInfo
  } = useYjsTasks(
    cloudTasksId,
    socket,
    cloudTasksList,
    (updatedTasks) => {
      console.log('[TasksPage] Cloud tasks updated:', updatedTasks.length);
      // Reload current instance data
      if (currentInstanceId) {
        loadInstanceData(currentInstanceId);
      }
    }
  );

  // Initialize
  useEffect(() => {
    const initializePage = async () => {
      try {
        // Check TaskWarrior installation
        await checkInstallation();

        // Get machine ID
        const id = await getMachineId();
        setMachineId(id);

        // Load all instances
        await loadInstances();

        // Load active instance
        const instance = await getActiveInstance();
        setActiveInstance(instance);

        // If no current instance selected but we have one, select it
        if (!currentInstanceId && instance) {
          setCurrentInstanceId(instance.id);
          const newTab = {
            id: instance.id,
            instanceId: instance.id,
            name: instance.name,
            category: instance.category || 'General',
            description: instance.description,
            inCloud: instance.inCloud || false,
            type: 'instance'
          };
          setOpenTabs([newTab]);
          setCurrentTabId(newTab.id);
        } else if (currentInstanceId) {
          // Load tasks for current instance
          const { getInstance } = await import('../utils/taskwarriorInstances');
          const currentInst = await getInstance(currentInstanceId);
          if (currentInst) {
            await loadTasks(currentInst);
          }
        }

        // Load projects and tags
        await loadProjectsAndTags();

        setLoading(false);
      } catch (error) {
        console.error('[TasksPage] Initialization error:', error);
        addNotification('Failed to initialize tasks page', 'error');
        setLoading(false);
      }
    };

    initializePage();
    // Intentional mount-only initialization (adopts the persisted instance
    // selection once; re-running on selection changes would fight the
    // currentInstanceId effect below)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Set user info when socket connects
  useEffect(() => {
    if (socket && cloudEnabled && machineId) {
      setUserInfo(machineId, getRandomColor());
    }
  }, [socket, cloudEnabled, machineId, setUserInfo]);

  // Listen for inner sidebar visibility changes
  useEffect(() => {
    function handleInnerSidebarVisibilityChange(event) {
      setInnerSidebarVisible(event.detail.visible);
    }

    window.addEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
    return () => window.removeEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
  }, [setInnerSidebarVisible]);

  // Load current instance when selection changes. The cleanup clears the
  // loaded data when the selection goes away (or on unmount) so a
  // no-instance state never shows another instance's tasks - equivalent to
  // the previous else-branch reset, without setState in the effect body.
  useEffect(() => {
    if (!currentInstanceId) return undefined;

    // loadInstanceData is an async DB loader; every setState inside it runs
    // after an await, never synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadInstanceData(currentInstanceId);

    return () => {
      setActiveInstance(null);
      setLocalTasks([]);
    };
  }, [currentInstanceId, loadInstanceData]);

  // Sync currentTabId with openTabs on mount. Adopting the first persisted
  // tab must go through setters (setCurrentInstanceId persists to
  // localStorage), so this cannot become a render-time state adjustment.
  useEffect(() => {
    if (!currentTabId && openTabs.length > 0) {
      const firstTab = openTabs[0];
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentTabId(firstTab.id);
      if (firstTab.type === 'instance') {
        setCurrentInstanceId(firstTab.instanceId || firstTab.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTabs]);

  const handleAddTask = async () => {
    try {
      if (!activeInstance) {
        addNotification('Please select a TaskWarrior instance first', 'error');
        return;
      }

      // Create a minimal empty task
      const task = {
        description: 'New Task',
        instanceId: activeInstance.id,
        status: 'pending',
        entry: new Date().toISOString(),
        modified: new Date().toISOString(),
        ...(cloudEnabled && {
          inCloud: true,
          ownerId: machineId,
          cloudDocumentId: cloudTasksId
        })
      };

      const id = await createTask(task);

      if (cloudEnabled && socket) {
        addCloudTask({ ...task, id });
      }

      await loadTasks(activeInstance);
      await loadProjectsAndTags();

      // Auto-sync to TaskWarrior
      await autoSyncToTaskWarrior();

      addNotification('Task created - click to edit', 'success');
    } catch (error) {
      console.error('[TasksPage] Error creating task:', error);
      addNotification('Failed to create task', 'error');
    }
  };

  const handleTaskContextMenu = (e, task) => {
    openTaskContextMenu(e, 'task', task);
    getDocumentCategoryNames()
      .then(setDocumentCategories)
      .catch((error) => {
        console.error('[TasksPage] Failed to load document categories:', error);
        setDocumentCategories(['General']);
      });
  };

  // "Create Document In <category>": one new document titled with the
  // task's text, created through the Documents page's own createDocument()
  // (defaults, stableId, indexed fields), then opened on the Documents page
  // in edit mode with the editor focused. In a standalone Tasks window there
  // is no Documents page to switch to, so the user is told where it went.
  const handleCreateDocumentFromTask = async (task, category) => {
    closeTaskContextMenu();
    if (!task) return;
    try {
      const record = buildDocumentFromTask(task, category);
      const documentId = await createDocument(record);
      expandDocumentCategoryInSidebar(record.category);
      const navigated = openDocumentInEditor(documentId, { focusEditor: true });
      if (!navigated) {
        addNotification({
          type: 'success',
          title: 'Document created',
          message: `"${record.title}" was created in "${record.category}" - open it from the Documents page in the main window.`,
        });
      }
    } catch (error) {
      console.error('[TasksPage] Failed to create document from task:', error);
      addNotification('Failed to create document', 'error');
    }
  };

  const handleUpdateTask = async (taskId, updates) => {
    try {
      await updateTask(taskId, updates);

      if (cloudEnabled && socket) {
        updateCloudTask(taskId, updates);
      }

      // Auto-sync to TaskWarrior
      await autoSyncToTaskWarrior();

      // Only sync back from TaskWarrior if we need updated calculated fields
      // (e.g., urgency calculation, wait status)
      const needsSyncBack = updates.due !== undefined ||
                           updates.priority !== undefined ||
                           updates.tags !== undefined ||
                           updates.wait !== undefined ||
                           updates.project !== undefined;

      if (needsSyncBack && activeInstance) {
        await syncFromTaskWarrior(
          activeInstance.id,
          activeInstance.rcPath || null,
          activeInstance.dataPath || null
        );
      }

      // Single reload at the end
      await loadTasks(activeInstance);
      await loadProjectsAndTags();

      // Don't show notification for routine updates - they're visible in the UI
    } catch (error) {
      console.error('[TasksPage] Error updating task:', error);
      addNotification('Failed to update task', 'error');
    }
  };

  const handleDeleteTask = async (taskId) => {
    try {
      // Get the task to access its UUID
      const { getTask } = await import('../utils/tasks');
      const task = await getTask(taskId);

      if (!task) {
        addNotification('Task not found', 'error');
        return;
      }

      // Delete from TaskWarrior CLI first if task has UUID
      if (task.uuid && activeInstance) {
        let result;

        if (task.status === 'deleted') {
          // Task is already deleted, purge it permanently
          result = await purgeTaskWarriorTask(
            task,
            activeInstance.rcPath || null,
            activeInstance.dataPath || null
          );

          if (!result.success) {
            console.error('[TasksPage] TaskWarrior purge failed:', result.error);
            // Continue with local delete even if TaskWarrior purge fails
          }
        } else {
          // Task is not deleted yet, delete it (soft delete)
          result = await deleteTaskWarriorTask(
            task,
            activeInstance.rcPath || null,
            activeInstance.dataPath || null
          );

          if (!result.success) {
            console.error('[TasksPage] TaskWarrior delete failed:', result.error);
            // Continue with local delete even if TaskWarrior delete fails
          }
        }
      }

      // Delete from local database
      await deleteTask(taskId, true);

      if (cloudEnabled && socket) {
        deleteCloudTask(taskId);
      }

      await loadTasks(activeInstance);
      setDeleteConfirm(null);

      addNotification(task.status === 'deleted' ? 'Task purged' : 'Task deleted', 'success');
    } catch (error) {
      console.error('[TasksPage] Error deleting task:', error);
      addNotification('Failed to delete task', 'error');
    }
  };

  const handleBulkDelete = async () => {
    if (selectedTasks.length === 0) return;

    try {
      const { getTask } = await import('../utils/tasks');

      for (const taskId of selectedTasks) {
        // Get the task to access its UUID
        const task = await getTask(taskId);

        if (!task) {
          console.warn('[TasksPage] Task not found:', taskId);
          continue;
        }

        // Delete from TaskWarrior CLI first if task has UUID
        if (task.uuid && activeInstance) {
          let result;

          if (task.status === 'deleted') {
            // Task is already deleted, purge it permanently
            result = await purgeTaskWarriorTask(
              task,
              activeInstance.rcPath || null,
              activeInstance.dataPath || null
            );

            if (result.success) {
              // Only hard delete if purge succeeded
              await deleteTask(taskId, true);
              if (cloudEnabled && socket) {
                deleteCloudTask(taskId);
              }
            } else {
              console.error('[TasksPage] TaskWarrior purge failed for task:', task.uuid, result.error);
            }
          } else {
            // Task is not deleted yet, delete it (soft delete in TaskWarrior)
            result = await deleteTaskWarriorTask(
              task,
              activeInstance.rcPath || null,
              activeInstance.dataPath || null
            );

            if (result.success) {
              // Don't delete from local DB - let sync handle it
              // Just update local status for immediate feedback
              await updateTask(taskId, { status: 'deleted', end: new Date().toISOString() });
              if (cloudEnabled && socket) {
                updateCloudTask(taskId, { status: 'deleted', end: new Date().toISOString() });
              }
            } else {
              console.error('[TasksPage] TaskWarrior delete failed for task:', task.uuid, result.error);
            }
          }
        } else {
          // No UUID - just delete locally
          await deleteTask(taskId, true);
          if (cloudEnabled && socket) {
            deleteCloudTask(taskId);
          }
        }
      }

      const deletedCount = selectedTasks.length;
      setSelectedTasks([]);
      await loadTasks(activeInstance);

      addNotification(`Deleted ${deletedCount} task${deletedCount > 1 ? 's' : ''}`, 'success');
    } catch (error) {
      console.error('[TasksPage] Bulk delete error:', error);
      addNotification('Failed to delete tasks', 'error');
    }
  };

  const handleToggleTaskSelection = (taskId) => {
    setSelectedTasks(prev =>
      prev.includes(taskId)
        ? prev.filter(id => id !== taskId)
        : [...prev, taskId]
    );
  };

  const handleSelectAll = () => {
    if (selectedTasks.length === filteredTasks.length) {
      setSelectedTasks([]);
    } else {
      setSelectedTasks(filteredTasks.map(t => t.id));
    }
  };

  const handleClearSelection = () => {
    setSelectedTasks([]);
  };

  const handleToggleSectionSelection = (sectionTasks) => {
    const sectionTaskIds = sectionTasks.map(t => t.id);
    const allSelected = sectionTaskIds.every(id => selectedTasks.includes(id));

    if (allSelected) {
      // Deselect all tasks in this section
      setSelectedTasks(prev => prev.filter(id => !sectionTaskIds.includes(id)));
    } else {
      // Select all tasks in this section
      setSelectedTasks(prev => {
        const newSelection = new Set(prev);
        sectionTaskIds.forEach(id => newSelection.add(id));
        return Array.from(newSelection);
      });
    }
  };

  const handleToggleSection = (section) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const handleToggleComplete = async (task) => {
    const newStatus = task.status === 'completed' ? 'pending' : 'completed';
    await handleUpdateTask(task.id, {
      status: newStatus,
      end: newStatus === 'completed' ? new Date().toISOString() : null,
    });
  };

  const handleStartTask = async (task) => {
    if (!activeInstance) return;

    try {
      const result = await startTask(
        task,
        activeInstance.rcPath || null,
        activeInstance.dataPath || null
      );

      if (result.success) {
        await loadTasks(activeInstance);

        // Sync back from TaskWarrior to get updated fields
        await syncFromTaskWarrior(
          activeInstance.id,
          activeInstance.rcPath || null,
          activeInstance.dataPath || null
        );
        await loadTasks(activeInstance);

        addNotification('Task started', 'success');
      } else {
        addNotification(result.error || 'Failed to start task', 'error');
      }
    } catch (error) {
      console.error('[TasksPage] Start task error:', error);
      addNotification('Failed to start task', 'error');
    }
  };

  const handleStopTask = async (task) => {
    if (!activeInstance) return;

    try {
      const result = await stopTask(
        task,
        activeInstance.rcPath || null,
        activeInstance.dataPath || null
      );

      if (result.success) {
        await loadTasks(activeInstance);

        // Sync back from TaskWarrior to get updated fields
        await syncFromTaskWarrior(
          activeInstance.id,
          activeInstance.rcPath || null,
          activeInstance.dataPath || null
        );
        await loadTasks(activeInstance);

        addNotification('Task stopped', 'success');
      } else {
        addNotification(result.error || 'Failed to stop task', 'error');
      }
    } catch (error) {
      console.error('[TasksPage] Stop task error:', error);
      addNotification('Failed to stop task', 'error');
    }
  };

  const handleAnnotateTask = async (task, annotation) => {
    if (!activeInstance) return;

    try {
      // First ensure task is synced to TaskWarrior
      await syncToTaskWarrior(
        activeInstance.id,
        activeInstance.rcPath || null,
        activeInstance.dataPath || null
      );

      const result = await annotateTask(
        task,
        annotation,
        activeInstance.rcPath || null,
        activeInstance.dataPath || null
      );

      if (result.success) {
        await loadTasks(activeInstance);

        // Sync back from TaskWarrior to get updated annotations
        await syncFromTaskWarrior(
          activeInstance.id,
          activeInstance.rcPath || null,
          activeInstance.dataPath || null
        );
        await loadTasks(activeInstance);

        addNotification('Note added', 'success');
      } else {
        addNotification(result.error || 'Failed to add note', 'error');
      }
    } catch (error) {
      console.error('[TasksPage] Annotate task error:', error);
      addNotification('Failed to add note', 'error');
    }
  };

  const handleDenotateTask = async (task, annotation) => {
    if (!activeInstance) return;

    try {
      const result = await denotateTask(
        task,
        annotation,
        activeInstance.rcPath || null,
        activeInstance.dataPath || null
      );

      if (result.success) {
        await loadTasks(activeInstance);

        // Sync back from TaskWarrior to get updated annotations
        await syncFromTaskWarrior(
          activeInstance.id,
          activeInstance.rcPath || null,
          activeInstance.dataPath || null
        );
        await loadTasks(activeInstance);

        addNotification('Note removed', 'success');
      } else {
        addNotification(result.error || 'Failed to remove note', 'error');
      }
    } catch (error) {
      console.error('[TasksPage] Denotate task error:', error);
      addNotification('Failed to remove note', 'error');
    }
  };

  // Auto-sync to TaskWarrior in background
  const autoSyncToTaskWarrior = async () => {
    if (!activeInstance) return;

    try {
      setIsSyncing(true);

      // Check if there are any tasks to sync
      const allTasks = await getTasks();
      const instanceTasks = allTasks.filter(t => t.instanceId === activeInstance.id);

      // If no tasks, just return success (nothing to sync)
      if (instanceTasks.length === 0) {
        console.log('[TasksPage] No tasks to sync - skipping');
        setIsSyncing(false);
        return;
      }

      const result = await syncToTaskWarrior(
        activeInstance.id,
        activeInstance.rcPath || null,
        activeInstance.dataPath || null
      );

      if (!result.success) {
        console.error('[TasksPage] Auto-sync failed:', result.error);
      }
    } catch (error) {
      console.error('[TasksPage] Auto-sync error:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleInstanceClick = (instance) => {
    // Check if instance is already in tabs
    const existingTab = openTabs.find(tab => tab.type === 'instance' && tab.id === instance.id);

    if (existingTab) {
      // Instance already open, just switch to it
      setCurrentTabId(existingTab.id);
      setCurrentInstanceId(instance.id);
    } else {
      // Add instance to tabs
      const newTab = {
        id: instance.id,
        instanceId: instance.id,
        name: instance.name,
        category: instance.category || 'General',
        description: instance.description,
        inCloud: instance.inCloud || false,
        type: 'instance'
      };
      setOpenTabs([...openTabs, newTab]);
      setCurrentTabId(newTab.id);
      setCurrentInstanceId(instance.id);
    }
  };

  const handleFilterApply = async (filterData) => {
    if (!activeInstance) {
      addNotification('No active instance', 'error');
      return;
    }

    try {
      // Parse filter into array of arguments
      const filterArgs = filterData.filter ? filterData.filter.trim().split(/\s+/) : [];

      // Execute the filter to get tasks from TaskWarrior
      const filteredTasksFromTW = await executeReport('export', activeInstance.id, filterArgs);

      // Get UUIDs of filtered tasks
      const filteredUUIDs = new Set(filteredTasksFromTW.map(t => t.uuid).filter(Boolean));

      // Match against local tasks to get editable versions
      const matchedLocalTasks = localTasks.filter(task =>
        task.uuid && filteredUUIDs.has(task.uuid)
      );

      // Set active filter and filtered tasks
      setActiveFilter(filterData);
      setTaskWarriorFilteredTasks(matchedLocalTasks);

      addNotification(`Filter applied: ${matchedLocalTasks.length} tasks`, 'success');
    } catch (error) {
      console.error('[TasksPage] Error applying filter:', error);
      addNotification(`Failed to apply filter: ${error.message}`, 'error');
    }
  };

  const handleClearFilter = () => {
    setActiveFilter(null);
    setTaskWarriorFilteredTasks(null);
    addNotification('Filter cleared', 'info');
  };

  // Re-apply active filter when localTasks changes
  useEffect(() => {
    if (activeFilter && activeInstance) {
      // Re-run the filter silently in the background
      const reapplyFilter = async () => {
        try {
          const filterArgs = activeFilter.filter ? activeFilter.filter.trim().split(/\s+/) : [];
          const filteredTasksFromTW = await executeReport('export', activeInstance.id, filterArgs);
          const filteredUUIDs = new Set(filteredTasksFromTW.map(t => t.uuid).filter(Boolean));
          const matchedLocalTasks = localTasks.filter(task =>
            task.uuid && filteredUUIDs.has(task.uuid)
          );
          setTaskWarriorFilteredTasks(matchedLocalTasks);
        } catch (error) {
          console.error('[TasksPage] Error re-applying filter:', error);
        }
      };
      reapplyFilter();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localTasks, activeFilter]);

  const handleTabClick = (tab) => {
    setCurrentTabId(tab.id);

    // If it's an instance tab, also set currentInstanceId
    if (tab.type === 'instance') {
      setCurrentInstanceId(tab.instanceId || tab.id);
    } else {
      // For report tabs, don't change instance
      setCurrentInstanceId(null);
    }
  };

  const handleTabClose = (tabId) => {
    const tabIndex = openTabs.findIndex(tab => tab.id === tabId);
    const closingTab = openTabs[tabIndex];
    const newTabs = openTabs.filter(tab => tab.id !== tabId);
    setOpenTabs(newTabs);

    // Clean up report results if closing a report tab
    if (closingTab?.type === 'report') {
      setReportResults(prev => {
        const updated = { ...prev };
        delete updated[tabId];
        return updated;
      });
    }

    // If closing current tab, switch to adjacent tab
    if (currentTabId === tabId) {
      if (newTabs.length === 0) {
        setCurrentTabId(null);
        setCurrentInstanceId(null);
        setActiveInstance(null);
        setLocalTasks([]);
      } else {
        // Switch to the tab that was to the left, or the new leftmost tab
        const newIndex = Math.max(0, tabIndex - 1);
        const newTab = newTabs[newIndex];
        setCurrentTabId(newTab.id);

        if (newTab.type === 'instance') {
          setCurrentInstanceId(newTab.instanceId || newTab.id);
        } else {
          setCurrentInstanceId(null);
        }
      }
    }
  };

  const handleInstanceRefresh = async () => {
    await loadInstances();
    // Don't reload instance data here - the useEffect will handle it when currentInstanceId changes
  };

  const handleInstanceDelete = async () => {
    const allInstances = await getAllInstances();
    const instanceIds = new Set(allInstances.map(inst => inst.id));
    await refreshOrphanedTasks();

    // Filter out tabs for deleted instances
    const validTabs = openTabs.filter(tab => instanceIds.has(tab.id));

    if (validTabs.length < openTabs.length) {
      // Some tabs were removed
      setOpenTabs(validTabs);

      // If current instance was deleted, switch to another tab or clear selection
      if (currentInstanceId && !instanceIds.has(currentInstanceId)) {
        if (validTabs.length > 0) {
          setCurrentInstanceId(validTabs[0].id);
        } else {
          setCurrentInstanceId(null);
          setActiveInstance(null);
          setLocalTasks([]);
        }
      }
    }
  };

  // Filter tasks - use TaskWarrior filter if active, otherwise use UI filters
  const filteredTasks = taskWarriorFilteredTasks || localTasks.filter(task => {
    // Status filter (array - can select multiple)
    if (statusFilter.length > 0) {
      let matchesStatus = false;
      for (const status of statusFilter) {
        if (status === 'active') {
          // Active tasks are those with a start timestamp
          if (task.start) {
            matchesStatus = true;
            break;
          }
        } else if (task.status === status) {
          matchesStatus = true;
          break;
        }
      }
      if (!matchesStatus) return false;
    }

    // Project filter
    if (projectFilter && task.project !== projectFilter) return false;

    // Tag filter
    if (tagFilter && (!task.tags || !task.tags.includes(tagFilter))) return false;

    // Search query
    if (searchQuery && !task.description.toLowerCase().includes(searchQuery.toLowerCase())) return false;

    return true;
  });

  // Sort instances (memoized to prevent unnecessary re-renders)
  const sortedInstances = useMemo(() => {
    return [...instances].sort((a, b) => {
      if (sortBy === 'name') {
        return a.name.localeCompare(b.name);
      } else if (sortBy === 'date') {
        // Convert ISO date strings to timestamps for comparison
        const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bTime - aTime; // Newest first
      }
      return 0;
    });
  }, [instances, sortBy]);

  // Group tasks by status
  const now = new Date();

  // Helper function to check if task is waiting (has future wait date or status=waiting)
  const isWaiting = (task) => {
    if (task.status === 'waiting') return true;
    if (task.wait) {
      try {
        const waitDate = new Date(task.wait);
        return waitDate > now;
      } catch {
        return false;
      }
    }
    return false;
  };

  const activeTasks = filteredTasks.filter(t => t.status === 'pending' && t.start && !isWaiting(t));
  const pendingTasks = filteredTasks.filter(t => (t.status === 'pending' || t.status === 'recurring') && !t.start && !isWaiting(t));
  const waitingTasks = filteredTasks.filter(t => isWaiting(t));
  const completedTasks = filteredTasks.filter(t => t.status === 'completed');
  const deletedTasks = filteredTasks.filter(t => t.status === 'deleted');

  // Debug: Log tasks that don't match any category
  const categorizedCount = activeTasks.length + pendingTasks.length + waitingTasks.length + completedTasks.length + deletedTasks.length;
  if (categorizedCount !== filteredTasks.length) {
    const uncategorized = filteredTasks.filter(t =>
      !activeTasks.includes(t) &&
      !pendingTasks.includes(t) &&
      !waitingTasks.includes(t) &&
      !completedTasks.includes(t) &&
      !deletedTasks.includes(t)
    );
    console.warn('[TasksPage] Uncategorized tasks:', uncategorized.map(t => ({ id: t.id, status: t.status, start: t.start, wait: t.wait })));
  }

  return (
    <div className="flex h-full overflow-hidden font-text">
      {/* Instance List Sidebar with Reports */}
      {(innerSidebarVisible || isMobile) && (
        <ResizableSidebar
          defaultWidth={250}
          minWidth={200}
          maxWidth={400}
          storageKey="task-sidebar-width"
        >
          <VerticalResizableDivider
            defaultTopHeight={60}
            minTopHeight={30}
            maxTopHeight={80}
            storageKey="task-sidebar-divider"
            bottomCollapsed={reportsSidebarCollapsed}
            topContent={
              <TaskInstanceList
                instances={sortedInstances}
                activeInstance={activeInstance}
                currentInstanceId={currentInstanceId}
                onInstanceClick={handleInstanceClick}
                onInstanceCreate={handleInstanceRefresh}
                onInstanceUpdate={handleInstanceRefresh}
                onInstanceDelete={handleInstanceDelete}
                onInstanceSetActive={handleInstanceRefresh}
                onRefresh={handleInstanceRefresh}
                taskWarriorInstalled={taskWarriorInstalled}
                checkingInstallation={checkingInstallation}
                sortBy={sortBy}
                onSortChange={setSortBy}
              />
            }
            bottomContent={
              <ReportsSidebar
                activeInstance={activeInstance}
                onFilterApply={handleFilterApply}
                onFilterClear={handleClearFilter}
                activeFilter={activeFilter}
                isCollapsed={reportsSidebarCollapsed}
                onCollapsedChange={setReportsSidebarCollapsed}
              />
            }
          />
        </ResizableSidebar>
      )}

      {/* Main Task Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Tab Bar (on a phone it is the page header, tabs or not) */}
        {(openTabs.length > 0 || isMobile) && (
          <TabBar
            tabs={openTabs.map(tab => ({
              ...tab,
              title: tab.name,
              category: tab.category || 'General'
            }))}
            activeTabId={currentTabId}
            onTabClick={handleTabClick}
            onTabClose={handleTabClose}
            pageTitle="Tasks"
          />
        )}

        {/* TaskWarrior Not Installed Banner */}
        {(backendUnreachable || !taskWarriorInstalled) && !installBannerDismissed && (
          <div className="bg-red-50 dark:bg-red-900/20 px-6 py-3">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-red-800 dark:text-red-200">
                  {backendUnreachable ? 'Backend Service Not Reachable' : 'TaskWarrior Not Installed'}
                </p>
                <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                  {backendUnreachable
                    ? 'The backend service did not answer, so tasks cannot be read or saved. Start it (or check its port) and retry.'
                    : 'Install Taskwarrior (the task command) to keep tasks in sync on this device: the account\'s tasks stay in the app until it is found. On macOS a Homebrew install (/opt/homebrew/bin) is picked up after a restart of the app.'}
                </p>
                {!backendUnreachable && (
                <button
                  onClick={() => {
                    const url = 'https://taskwarrior.org/download/';
                    if (window.electronAPI?.openExternal) {
                      window.electronAPI.openExternal(url);
                    } else {
                      window.open(url, '_blank');
                    }
                  }}
                  className="inline-flex items-center gap-1 mt-2 text-xs text-red-700 dark:text-red-300 hover:text-red-900 dark:hover:text-red-100 underline cursor-pointer"
                >
                  Download TaskWarrior
                </button>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={checkInstallation}
                  disabled={checkingInstallation}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-sm transition-colors disabled:opacity-50"
                >
                  Retry
                </button>
                <button
                  onClick={() => setInstallBannerDismissed(true)}
                  className="p-1 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-sm transition-colors"
                >
                  <X size={16} className="text-red-600 dark:text-red-400" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Orphaned cached tasks (no instance): same notice strip as the
            Documents editor's read-only banners. Counted across ALL
            instances, hidden at zero. */}
        {orphanedTasks.length > 0 && (
          <NoticeBanner tone="warning" testId="orphaned-tasks-banner" className="border-b border-os-border">
            <span>{describeOrphanedTasks(orphanedTasks.length)}</span>
            <NoticeBannerAction onClick={handleCleanOrphanedTasks} busy={cleaningOrphans} testId="orphaned-tasks-clean">
              {cleaningOrphans ? 'Cleaning...' : 'Clean it?'}
            </NoticeBannerAction>
          </NoticeBanner>
        )}

        {/* Toolbar */}
        {currentInstanceId && activeInstance && openTabs.find(tab => tab.id === currentTabId)?.type === 'instance' && (
          <div className="sc-task-toolbar bg-os-card border-b border-os-border px-6 py-3">
            {selectedTasks.length > 0 ? (
              /* Bulk Actions Toolbar */
              <div className="flex items-center gap-3">
                <button
                  onClick={handleClearSelection}
                  className="p-2 hover:bg-os-card-secondary rounded-sm transition-colors"
                  title="Clear selection"
                >
                  <X size={16} className="text-os-text-muted" />
                </button>

                <span className="text-sm font-medium text-os-text-primary">
                  {selectedTasks.length} selected
                </span>

                <div className="flex-1"></div>

                <button
                  onClick={handleSelectAll}
                  className="px-3 py-2 text-sm text-os-text-primary hover:bg-os-card-secondary transition-colors"
                >
                  {selectedTasks.length === filteredTasks.length ? 'Deselect All' : 'Select All'}
                </button>

                <button
                  onClick={handleBulkDelete}
                  className="px-4 py-2 bg-red-600 text-white hover:bg-red-700 flex items-center gap-2 transition-colors"
                >
                  <span className="text-sm font-medium">Delete Selected</span>
                </button>
              </div>
            ) : (
              /* Normal Toolbar */
              <div className="flex items-center gap-2">
                {/* Search */}
                <div className="relative flex-1 max-w-sm">
                  <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-os-text-muted" />
                  <input
                    type="text"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 text-xs border border-os-border rounded-sm bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-os-blue transition-colors"
                  />
                </div>

                {/* Filter Chips */}
                {statusFilter.map(status => (
                  <span key={status} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-os-card-secondary border border-os-border rounded-sm">
                    <span className="text-os-text-secondary">{status}</span>
                    <button onClick={() => setStatusFilter(statusFilter.filter(s => s !== status))} className="hover:text-os-text-primary">
                      <X size={12} />
                    </button>
                  </span>
                ))}
                {projectFilter && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-os-card-secondary border border-os-border rounded-sm">
                    <span className="text-os-text-secondary">{projectFilter}</span>
                    <button onClick={() => setProjectFilter('')} className="hover:text-os-text-primary">
                      <X size={12} />
                    </button>
                  </span>
                )}
                {tagFilter && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-os-card-secondary border border-os-border rounded-sm">
                    <span className="text-os-text-secondary">{tagFilter}</span>
                    <button onClick={() => setTagFilter('')} className="hover:text-os-text-primary">
                      <X size={12} />
                    </button>
                  </span>
                )}
                {activeFilter && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-purple-100 dark:bg-purple-900/30 border border-purple-300 dark:border-purple-700 rounded-sm">
                    <Filter size={12} className="text-purple-600 dark:text-purple-400" />
                    <span className="text-purple-700 dark:text-purple-300 font-medium">{activeFilter.filterName}</span>
                    <button onClick={handleClearFilter} className="hover:text-purple-900 dark:hover:text-purple-100" title="Clear filter">
                      <X size={12} />
                    </button>
                  </span>
                )}

                {/* Filter Button (on a phone it opens the filters as a dropdown
                    under itself - MobileTaskFilters - and carries the count of
                    the filters set; the desktop toggles the inline panel below) */}
                <button
                  onClick={(e) => { if (isMobile && !showFilters) announceRowMenu(e.currentTarget.getBoundingClientRect()); setShowFilters(!showFilters); }}
                  data-testid="tasks-filter-button"
                  aria-haspopup={isMobile ? 'menu' : undefined}
                  aria-expanded={isMobile ? showFilters : undefined}
                  className={`relative p-1.5 rounded-sm transition-colors ${showFilters ?'bg-os-blue text-white':'hover:bg-os-card-secondary text-os-text-secondary'}`}
                  title="Filters"
                >
                  <Filter size={14} />
                  {isMobile && (statusFilter.length + (projectFilter ? 1 : 0) + (tagFilter ? 1 : 0)) > 0 && (
                    <span data-testid="tasks-filter-count" className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-os-blue text-white text-[10px] font-semibold leading-4 text-center">{statusFilter.length + (projectFilter ? 1 : 0) + (tagFilter ? 1 : 0)}</span>
                  )}
                </button>
                {isMobile && showFilters && (
                  <MobileTaskFilters
                    statusFilter={statusFilter} setStatusFilter={setStatusFilter}
                    projectFilter={projectFilter} setProjectFilter={setProjectFilter}
                    tagFilter={tagFilter} setTagFilter={setTagFilter}
                    projects={projects} tags={tags}
                    onClose={() => setShowFilters(false)}
                  />
                )}

                {/* Spacer */}
                <div className="flex-1"></div>

                {/* Results count */}
                <span className="text-xs text-os-text-muted">
                  {filteredTasks.length}
                </span>

                {/* Syncing indicator */}
                {isSyncing && (
                  <RefreshCw size={14} className="text-os-blue animate-spin" />
                )}

                {/* Add Task */}
                <button
                  onClick={handleAddTask}
                  className="p-1.5 bg-os-blue text-white rounded-sm hover:bg-os-blue-hover transition-colors"
                  title="Add Task"
                >
                  <Plus size={14} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Filter Panel (the desktop's; a phone has the dropdown instead) */}
        {!isMobile && currentInstanceId && activeInstance && showFilters && openTabs.find(tab => tab.id === currentTabId)?.type === 'instance' && (
          <div data-testid="tasks-filter-panel" className="bg-os-card border-b border-os-border px-6 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-os-text-secondary uppercase tracking-wide">Filters:</span>

              {/* Status */}
              <div className="flex flex-wrap gap-1">
                {['pending', 'active', 'completed', 'deleted', 'waiting'].map(status => (
                  <button
                    key={status}
                    onClick={() => {
                      if (statusFilter.includes(status)) {
                        setStatusFilter(statusFilter.filter(s => s !== status));
                      } else {
                        setStatusFilter([...statusFilter, status]);
                      }
                    }}
                    className={`px-2 py-1 text-xs transition-colors ${
 statusFilter.includes(status)
 ?'bg-os-blue text-white'
 :'bg-os-card-secondary text-os-text-secondary hover:bg-os-border'
 }`}
                  >
                    {status}
                  </button>
                ))}
              </div>

              {projects.length > 0 && (
                <>
                  <span className="text-os-text-muted">|</span>
                  <div className="flex flex-wrap gap-1">
                    {projects.slice(0, 5).map(project => (
                      <button
                        key={project}
                        onClick={() => setProjectFilter(projectFilter === project ? '' : project)}
                        className={`px-2 py-1 text-xs transition-colors ${
 projectFilter === project
 ?'bg-os-blue text-white'
 :'bg-os-card-secondary text-os-text-secondary hover:bg-os-border'
 }`}
                      >
                        {project}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {tags.length > 0 && (
                <>
                  <span className="text-os-text-muted">|</span>
                  <div className="flex flex-wrap gap-1">
                    {tags.slice(0, 8).map(tag => (
                      <button
                        key={tag}
                        onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
                        className={`px-2 py-1 text-xs transition-colors ${
 tagFilter === tag
 ?'bg-os-blue text-white'
 :'bg-os-card-secondary text-os-text-secondary hover:bg-os-border'
 }`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Task lists */}
        {(() => {
          const currentTab = openTabs.find(tab => tab.id === currentTabId);

          // Report tab - show report results
          if (currentTab?.type === 'report') {
            const reportData = reportResults[currentTabId];
            if (!reportData) {
              return (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <BarChart3 size={48} className="text-os-text-muted mx-auto mb-3 opacity-40" />
                    <p className="text-sm text-os-text-secondary">Report data not found</p>
                  </div>
                </div>
              );
            }

            const reportTasks = reportData.tasks || [];

            return (
              <div className="flex-1 overflow-y-auto">
                <div className="px-6 py-4 border-b border-os-border bg-os-card-secondary/30">
                  <div className="flex items-center gap-3">
                    <BarChart3 size={20} className="text-os-text-secondary" />
                    <div>
                      <h2 className="text-base font-semibold text-os-text-primary">
                        {reportData.reportName}
                      </h2>
                      <p className="text-xs text-os-text-muted">
                        {reportTasks.length} task{reportTasks.length !== 1 ? 's' : ''} • Generated {new Date(reportData.timestamp).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>

                {reportTasks.length === 0 ? (
                  <div className="flex items-center justify-center py-20">
                    <div className="text-center">
                      <Circle className="w-10 h-10 text-os-text-muted mx-auto mb-3 opacity-40" />
                      <p className="text-sm text-os-text-secondary">No tasks in this report</p>
                    </div>
                  </div>
                ) : (
                  <div className="px-6 py-4 space-y-1.5">
                    {reportTasks.map((task) => (
                      <TaskItem
                        key={task.uuid || task.id}
                        task={task}
                        onToggleComplete={() => {}}
                        onDelete={() => {}}
                        onUpdate={() => {}}
                        onStart={() => {}}
                        onStop={() => {}}
                        onAnnotate={() => {}}
                        onDenotate={() => {}}
                        projects={projects}
                        isReadOnly={true}
                        isSelected={false}
                        onToggleSelection={() => {}}
                        onContextMenu={handleTaskContextMenu}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          }

          // Instance tab - show instance tasks
          if (currentInstanceId && activeInstance) {
            return (
              <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <div className="text-center">
                  <RefreshCw className="w-6 h-6 animate-spin text-os-text-muted mx-auto mb-3" />
                  <p className="text-sm text-os-text-secondary">Loading tasks...</p>
                </div>
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <div className="text-center">
                  <Circle className="w-10 h-10 text-os-text-muted mx-auto mb-3 opacity-40" />
                  <p className="text-sm text-os-text-secondary">No tasks found</p>
                  <p className="text-xs text-os-text-muted mt-1">
                    Click "Add Task" to create one
                  </p>
                </div>
              </div>
            ) : (
              <div className="sc-task-list space-y-0">
                {/* Active tasks */}
                {activeTasks.length > 0 && (
                  <div className="px-6 py-4">
                    <div className="flex items-center gap-2 mb-2.5">
                      <button
                        onClick={() => handleToggleSectionSelection(activeTasks)}
                        className={`w-4 h-4 border flex items-center justify-center transition-colors ${
 activeTasks.every(t => selectedTasks.includes(t.id))
 ?'bg-os-blue border-os-blue'
 :'border-os-border/60 hover:border-os-blue'
 }`}
                        title="Select all active tasks"
                      >
                        {activeTasks.every(t => selectedTasks.includes(t.id)) && <Check size={12} className="text-white" />}
                      </button>
                      <Play className="w-3.5 h-3.5 text-green-600" />
                      <button
                        onClick={() => handleToggleSection('active')}
                        className="p-0 hover:bg-os-card-secondary rounded-sm transition-colors flex items-center gap-1"
                        title={expandedSections.active ? "Collapse section" : "Expand section"}
                      >
                        <span className="text-[11px] font-medium text-os-text-muted uppercase tracking-wide">
                          Active ({activeTasks.length})
                        </span>
                        <ChevronRight size={14} className={`text-os-text-secondary transition-transform ${expandedSections.active ?'rotate-90':''}`} />
                      </button>
                    </div>
                    {expandedSections.active && (
                    <div className="space-y-1.5">
                      {activeTasks.map(task => (
                        <TaskItem
                          key={task.id}
                          task={task}
                          onToggleComplete={handleToggleComplete}
                          onDelete={(t) => setDeleteConfirm(t)}
                          onUpdate={handleUpdateTask}
                          onStart={handleStartTask}
                          onStop={handleStopTask}
                          onAnnotate={handleAnnotateTask}
                          onDenotate={handleDenotateTask}
                          projects={projects}
                          isSelected={selectedTasks.includes(task.id)}
                          onToggleSelection={() => handleToggleTaskSelection(task.id)}
                          onContextMenu={handleTaskContextMenu}
                        />
                      ))}
                    </div>
                    )}
                  </div>
                )}

                {/* Pending tasks */}
                {pendingTasks.length > 0 && (
                  <div className={`px-6 py-4 ${activeTasks.length > 0 ?'border-t border-os-border':''}`}>
                    <div className="flex items-center gap-2 mb-2.5">
                      <button
                        onClick={() => handleToggleSectionSelection(pendingTasks)}
                        className={`w-4 h-4 border flex items-center justify-center transition-colors ${
 pendingTasks.every(t => selectedTasks.includes(t.id))
 ?'bg-os-blue border-os-blue'
 :'border-os-border/60 hover:border-os-blue'
 }`}
                        title="Select all pending tasks"
                      >
                        {pendingTasks.every(t => selectedTasks.includes(t.id)) && <Check size={12} className="text-white" />}
                      </button>
                      <Circle className="w-3.5 h-3.5 text-os-text-muted" />
                      <button
                        onClick={() => handleToggleSection('pending')}
                        className="p-0 hover:bg-os-card-secondary rounded-sm transition-colors flex items-center gap-1"
                        title={expandedSections.pending ? "Collapse section" : "Expand section"}
                      >
                        <span className="text-[11px] font-medium text-os-text-muted uppercase tracking-wide">
                          Pending ({pendingTasks.length})
                        </span>
                        <ChevronRight size={14} className={`text-os-text-secondary transition-transform ${expandedSections.pending ?'rotate-90':''}`} />
                      </button>
                    </div>
                    {expandedSections.pending && (
                    <div className="space-y-1.5">
                      {pendingTasks.map(task => (
                        <TaskItem
                          key={task.id}
                          task={task}
                          onToggleComplete={handleToggleComplete}
                          onDelete={(t) => setDeleteConfirm(t)}
                          onUpdate={handleUpdateTask}
                          onStart={handleStartTask}
                          onStop={handleStopTask}
                          onAnnotate={handleAnnotateTask}
                          onDenotate={handleDenotateTask}
                          projects={projects}
                          isSelected={selectedTasks.includes(task.id)}
                          onToggleSelection={() => handleToggleTaskSelection(task.id)}
                          onContextMenu={handleTaskContextMenu}
                        />
                      ))}
                    </div>
                    )}
                  </div>
                )}

                {/* Waiting tasks */}
                {waitingTasks.length > 0 && (
                  <div className={`px-6 py-4 ${(activeTasks.length > 0 || pendingTasks.length > 0) ?'border-t border-os-border':''}`}>
                    <div className="flex items-center gap-2 mb-2.5">
                      <button
                        onClick={() => handleToggleSectionSelection(waitingTasks)}
                        className={`w-4 h-4 border flex items-center justify-center transition-colors ${
 waitingTasks.every(t => selectedTasks.includes(t.id))
 ?'bg-os-blue border-os-blue'
 :'border-os-border/60 hover:border-os-blue'
 }`}
                        title="Select all waiting tasks"
                      >
                        {waitingTasks.every(t => selectedTasks.includes(t.id)) && <Check size={12} className="text-white" />}
                      </button>
                      <Clock className="w-3.5 h-3.5 text-amber-600" />
                      <button
                        onClick={() => handleToggleSection('waiting')}
                        className="p-0 hover:bg-os-card-secondary rounded-sm transition-colors flex items-center gap-1"
                        title={expandedSections.waiting ? "Collapse section" : "Expand section"}
                      >
                        <span className="text-[11px] font-medium text-os-text-muted uppercase tracking-wide">
                          Waiting ({waitingTasks.length})
                        </span>
                        <ChevronRight size={14} className={`text-os-text-secondary transition-transform ${expandedSections.waiting ?'rotate-90':''}`} />
                      </button>
                    </div>
                    {expandedSections.waiting && (
                    <div className="space-y-1.5">
                      {waitingTasks.map(task => (
                        <TaskItem
                          key={task.id}
                          task={task}
                          onToggleComplete={handleToggleComplete}
                          onDelete={(t) => setDeleteConfirm(t)}
                          onUpdate={handleUpdateTask}
                          onStart={handleStartTask}
                          onStop={handleStopTask}
                          onAnnotate={handleAnnotateTask}
                          onDenotate={handleDenotateTask}
                          projects={projects}
                          isSelected={selectedTasks.includes(task.id)}
                          onToggleSelection={() => handleToggleTaskSelection(task.id)}
                          onContextMenu={handleTaskContextMenu}
                        />
                      ))}
                    </div>
                    )}
                  </div>
                )}

                {/* Completed tasks */}
                {completedTasks.length > 0 && (
                  <div className={`px-6 py-4 bg-os-card-secondary/30 ${(activeTasks.length > 0 || pendingTasks.length > 0 || waitingTasks.length > 0) ?'border-t border-os-border':''}`}>
                    <div className="flex items-center gap-2 mb-2.5">
                      <button
                        onClick={() => handleToggleSectionSelection(completedTasks)}
                        className={`w-4 h-4 border flex items-center justify-center transition-colors ${
 completedTasks.every(t => selectedTasks.includes(t.id))
 ?'bg-os-blue border-os-blue'
 :'border-os-border/60 hover:border-os-blue'
 }`}
                        title="Select all completed tasks"
                      >
                        {completedTasks.every(t => selectedTasks.includes(t.id)) && <Check size={12} className="text-white" />}
                      </button>
                      <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                      <button
                        onClick={() => handleToggleSection('completed')}
                        className="p-0 hover:bg-os-card-secondary rounded-sm transition-colors flex items-center gap-1"
                        title={expandedSections.completed ? "Collapse section" : "Expand section"}
                      >
                        <span className="text-[11px] font-medium text-os-text-muted uppercase tracking-wide">
                          Completed ({completedTasks.length})
                        </span>
                        <ChevronRight size={14} className={`text-os-text-secondary transition-transform ${expandedSections.completed ?'rotate-90':''}`} />
                      </button>
                    </div>
                    {expandedSections.completed && (
                    <div className="space-y-1.5">
                      {completedTasks.map(task => (
                        <TaskItem
                          key={task.id}
                          task={task}
                          onToggleComplete={handleToggleComplete}
                          onDelete={(t) => setDeleteConfirm(t)}
                          onUpdate={handleUpdateTask}
                          onStart={handleStartTask}
                          onStop={handleStopTask}
                          onAnnotate={handleAnnotateTask}
                          onDenotate={handleDenotateTask}
                          projects={projects}
                          isSelected={selectedTasks.includes(task.id)}
                          onToggleSelection={() => handleToggleTaskSelection(task.id)}
                          onContextMenu={handleTaskContextMenu}
                        />
                      ))}
                    </div>
                    )}
                  </div>
                )}

                {/* Deleted tasks */}
                {deletedTasks.length > 0 && (
                  <div className={`px-6 py-4 bg-red-50/30 dark:bg-red-900/5 ${(activeTasks.length > 0 || pendingTasks.length > 0 || waitingTasks.length > 0 || completedTasks.length > 0) ?'border-t border-os-border':''}`}>
                    <div className="flex items-center gap-2 mb-2.5">
                      <button
                        onClick={() => handleToggleSectionSelection(deletedTasks)}
                        className={`w-4 h-4 border flex items-center justify-center transition-colors ${
 deletedTasks.every(t => selectedTasks.includes(t.id))
 ?'bg-os-blue border-os-blue'
 :'border-os-border/60 hover:border-os-blue'
 }`}
                        title="Select all deleted tasks"
                      >
                        {deletedTasks.every(t => selectedTasks.includes(t.id)) && <Check size={12} className="text-white" />}
                      </button>
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                      <button
                        onClick={() => handleToggleSection('deleted')}
                        className="p-0 hover:bg-os-card-secondary rounded-sm transition-colors flex items-center gap-1"
                        title={expandedSections.deleted ? "Collapse section" : "Expand section"}
                      >
                        <span className="text-[11px] font-medium text-os-text-muted uppercase tracking-wide">
                          Deleted ({deletedTasks.length})
                        </span>
                        <ChevronRight size={14} className={`text-os-text-secondary transition-transform ${expandedSections.deleted ?'rotate-90':''}`} />
                      </button>
                    </div>
                    {expandedSections.deleted && (
                    <div className="space-y-1.5">
                      {deletedTasks.map(task => (
                        <TaskItem
                          key={task.id}
                          task={task}
                          onToggleComplete={handleToggleComplete}
                          onDelete={(t) => setDeleteConfirm(t)}
                          onUpdate={handleUpdateTask}
                          onStart={handleStartTask}
                          onStop={handleStopTask}
                          onAnnotate={handleAnnotateTask}
                          onDenotate={handleDenotateTask}
                          projects={projects}
                          isSelected={selectedTasks.includes(task.id)}
                          onToggleSelection={() => handleToggleTaskSelection(task.id)}
                          onContextMenu={handleTaskContextMenu}
                        />
                      ))}
                    </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
            );
          }

          // No tab selected
          return (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <Database size={48} className="text-os-text-muted mx-auto mb-3 opacity-40" />
                <h2 className="text-lg font-semibold text-os-text-primary mb-1">
                  No Instance Selected
                </h2>
                <p className="text-sm text-os-text-muted mb-4">
                  {instances.length === 0
                    ? 'Create a TaskWarrior instance to get started'
                    : 'Select an instance from the sidebar'}
                </p>
                {instances.length === 0 && (
                  <button
                    onClick={() => {
                      // Trigger the form in sidebar to open
                      window.dispatchEvent(new CustomEvent('openTaskInstanceForm'));
                    }}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors"
                  >
                    Create Instance
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {/* Task row right-click menu */}
        <TaskContextMenu
          contextMenu={taskContextMenu}
          menuRef={taskContextMenuRef}
          categories={documentCategories}
          onCreateDocumentIn={handleCreateDocumentFromTask}
        />

        {/* Delete confirmation */}
        {deleteConfirm && (
          <ConfirmationModal
            isOpen={true}
            title="Delete Task"
            message={`Are you sure you want to delete "${deleteConfirm.description}"?`}
            confirmText="Delete"
            dangerous={true}
            onConfirm={() => handleDeleteTask(deleteConfirm.id)}
            onClose={() => setDeleteConfirm(null)}
          />
        )}

      </div>
    </div>
  );
}

function getRandomColor() {
  const colors = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6'];
  return colors[Math.floor(Math.random() * colors.length)];
}
