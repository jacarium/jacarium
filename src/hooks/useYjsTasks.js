/**
 * React Hook for Yjs Tasks Synchronization
 * Provides real-time collaborative editing for TaskWarrior tasks with CRDT conflict resolution
 */

import { useState, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { getYjsProvider, cleanupYjsProvider } from '../utils/yjsProvider';
import { isWebSocketConnected, onConnectionStatusChange } from '../utils/cloudWebSocket';
import { updateTask as updateTaskInDB, createTask as createTaskInDB, deleteTask as deleteTaskInDB, getTasks } from '../utils/tasks';

/**
 * Hook to synchronize tasks with Yjs collaborative state
 *
 * @param {string} cloudTasksId - The cloud tasks ID (UUID) to sync
 * @param {object} socket - Socket.io instance
 * @param {array} initialTasks - Initial tasks if new
 * @param {function} onTasksChange - Callback when tasks change
 * @returns {object} - { tasks, userInteractions, updateTask, addTask, deleteTask, setUserInteraction }
 */
// Pure converter from the Yjs map into a plain array (module scope so the
// sync effect can use it without ordering constraints)
function tasksMapToArray(ytasks) {
  const tasksArray = [];
  ytasks.forEach((taskMap, taskId) => {
    const task = { id: parseInt(taskId) };
    taskMap.forEach((value, key) => {
      // Parse JSON arrays
      if (key === 'tags' || key === 'depends' || key === 'annotations') {
        try {
          task[key] = typeof value === 'string' ? JSON.parse(value) : value;
        } catch {
          task[key] = [];
        }
      } else {
        task[key] = value;
      }
    });
    tasksArray.push(task);
  });
  return tasksArray;
}


export function useYjsTasks(cloudTasksId, socket, initialTasks = [], onTasksChange) {
  const [tasks, setTasks] = useState(initialTasks);
  const [userInteractions, setUserInteractions] = useState({}); // { userId: { taskId, action } }
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [isConnected, setIsConnected] = useState(false);

  const ytasksRef = useRef(null); // Y.Map of tasks
  const awarenessRef = useRef(null);
  const isLocalChangeRef = useRef(false);
  const currentTasksIdRef = useRef(cloudTasksId);
  const isReadyRef = useRef(false);
  const tasksDataRef = useRef(initialTasks);

  // Update tasks when initialTasks changes
  // BUT: Only if Yjs is not yet ready. Once Yjs is initialized, it's the source of truth
  useEffect(() => {
    if (currentTasksIdRef.current === cloudTasksId && !isReadyRef.current) {
      console.log(`[useYjsTasks] Setting tasks from initialTasks (${initialTasks.length} tasks) - Yjs not ready yet`);
      setTasks(initialTasks);
      tasksDataRef.current = initialTasks;
    } else if (currentTasksIdRef.current === cloudTasksId && isReadyRef.current) {
      console.log(`[useYjsTasks] Ignoring initialTasks change - Yjs is ready and is source of truth`);
    }
  }, [initialTasks, cloudTasksId]);

  // Keep tasksDataRef in sync with tasks state
  useEffect(() => {
    tasksDataRef.current = tasks;
  }, [tasks]);

  // Monitor WebSocket connection status
  useEffect(() => {
    if (!cloudTasksId || !socket) return;

    const checkConnection = () => {
      const connected = isWebSocketConnected();
      setIsConnected(connected);
      console.log(`[useYjsTasks] WebSocket connection status: ${connected}`);
    };

    checkConnection();
    const unsubscribe = onConnectionStatusChange(checkConnection);
    return unsubscribe;
  }, [cloudTasksId, socket]);

  useEffect(() => {
    // Clear refs when tasks ID changes
    if (currentTasksIdRef.current !== cloudTasksId) {
      console.log(`[useYjsTasks] Tasks ID changed from ${currentTasksIdRef.current} to ${cloudTasksId}`);
      isReadyRef.current = false;
      ytasksRef.current = null;
      awarenessRef.current = null;
      setUserInteractions({});
      currentTasksIdRef.current = cloudTasksId;
      tasksDataRef.current = initialTasks;
      setTasks(initialTasks);
    } else {
      // ID hasn't changed, just update refs
      tasksDataRef.current = initialTasks;
    }

    if (!cloudTasksId || !socket) {
      console.log(`[useYjsTasks] Skipping setup - tasksId: ${!!cloudTasksId}, socket: ${!!socket}`);
      isReadyRef.current = false;
      return;
    }

    console.log(`[useYjsTasks] Setting up for tasks: ${cloudTasksId}, connected: ${isConnected}`);

    // Get Yjs provider
    const { ydoc, awareness, provider } = getYjsProvider(cloudTasksId, socket);
    const ytasks = ydoc.getMap('tasks');

    ytasksRef.current = ytasks;
    awarenessRef.current = awareness;

    console.log(`[useYjsTasks] Registering whenSynced callback for ${cloudTasksId}`);

    // Initialize function - used both for sync and offline mode
    const initializeYjsDocument = () => {
      // Don't re-initialize if already ready - let Yjs CRDT handle sync
      if (isReadyRef.current) {
        console.log(`[useYjsTasks] Already initialized, skipping re-initialization (CRDT will merge)`);
        return;
      }

      if (currentTasksIdRef.current !== cloudTasksId) {
        console.log(`[useYjsTasks] Tasks ID changed during initialization, ignoring`);
        return;
      }

      // Mark as ready IMMEDIATELY to prevent race condition
      isReadyRef.current = true;

      // Check if server had tasks
      if (ytasks.size > 0) {
        // Server has tasks - use them
        const serverTasks = tasksMapToArray(ytasks);
        console.log(`[useYjsTasks] Using server tasks (${serverTasks.length} tasks)`);
        setTasks(serverTasks);
        tasksDataRef.current = serverTasks;

        // Sync server tasks to IndexedDB so offline mode has latest content
        const syncTasksToIndexedDB = async () => {
          try {
            const existingTasks = await getTasks();
            const yjsTaskIds = new Set(serverTasks.map(t => t.id));

            // Update or create tasks from server
            for (const task of serverTasks) {
              const existing = existingTasks.find(t => t.id === task.id);
              if (existing) {
                await updateTaskInDB(task.id, task);
              } else {
                await createTaskInDB(task);
              }
            }

            // Delete tasks that are no longer on server
            for (const existing of existingTasks) {
              if (existing.inCloud && !yjsTaskIds.has(existing.id)) {
                await deleteTaskInDB(existing.id, true);
              }
            }

            console.log(`[useYjsTasks] Saved ${serverTasks.length} server tasks to IndexedDB`);
          } catch (error) {
            console.error('[useYjsTasks] Error saving server tasks to IndexedDB:', error);
          }
        };
        syncTasksToIndexedDB();
      } else {
        // Server is empty - initialize with current tasks
        const currentTasks = tasksDataRef.current;
        if (currentTasks && currentTasks.length > 0) {
          console.log(`[useYjsTasks] Server empty, initializing with current tasks (${currentTasks.length} tasks)`);
          ydoc.transact(() => {
            currentTasks.forEach(task => {
              const taskMap = new Y.Map();
              Object.entries(task).forEach(([key, value]) => {
                if (value !== undefined) {
                  // Handle arrays (tags, depends, annotations)
                  if (Array.isArray(value)) {
                    taskMap.set(key, JSON.stringify(value));
                  } else {
                    taskMap.set(key, value);
                  }
                }
              });
              ytasks.set(String(task.id), taskMap);
            });
          });
        }
      }

      console.log(`[useYjsTasks] ✓ Yjs READY for tasks ${cloudTasksId}`);
    };

    // Wait for initial sync when online
    provider.whenSynced(() => {
      console.log(`[useYjsTasks] Initial sync completed for ${cloudTasksId}`);
      initializeYjsDocument();
    });

    // If offline, initialize immediately after a short delay
    const offlineInitTimeout = setTimeout(() => {
      if (!isReadyRef.current) {
        console.log(`[useYjsTasks] Sync timeout - initializing in offline mode`);
        initializeYjsDocument();
      }
    }, 500);

    // Listen to task changes (deep observation for nested Y.Map changes)
    const handleTasksChange = async () => {
      const newTasks = tasksMapToArray(ytasks);
      const changeType = isLocalChangeRef.current ? 'LOCAL' : 'REMOTE';
      console.log(`[useYjsTasks] ${changeType} tasks change detected, new count: ${newTasks.length}`);

      setTasks(newTasks);

      // Sync to IndexedDB (for both local and remote changes)
      if (isReadyRef.current) {
        try {
          const existingTasks = await getTasks();
          const yjsTaskIds = new Set(newTasks.map(t => t.id));

          // Update or create tasks from Yjs
          for (const task of newTasks) {
            const existing = existingTasks.find(t => t.id === task.id);
            if (existing) {
              await updateTaskInDB(task.id, task);
            } else {
              await createTaskInDB(task);
            }
          }

          // Delete cloud tasks that are no longer in Yjs
          for (const existing of existingTasks) {
            if (existing.inCloud && !yjsTaskIds.has(existing.id)) {
              await deleteTaskInDB(existing.id, true);
            }
          }

          console.log(`[useYjsTasks] Synced ${newTasks.length} tasks to IndexedDB`);
        } catch (error) {
          console.error('[useYjsTasks] Error syncing tasks to IndexedDB:', error);
        }
      }

      // Notify parent component
      if (onTasksChange && !isLocalChangeRef.current) {
        onTasksChange(newTasks);
      }

      isLocalChangeRef.current = false;
    };

    // Use observeDeep to catch changes in nested Y.Maps (task properties)
    ytasks.observeDeep(handleTasksChange);
    console.log(`[useYjsTasks] Deep observer registered for tasks changes`);

    // Listen to awareness changes (user interactions)
    const handleAwarenessChange = () => {
      const states = awareness.getStates();
      const interactions = {};
      const users = [];

      states.forEach((state, clientId) => {
        if (clientId === awareness.clientID) return; // Skip own awareness

        // Collect all connected users
        if (state.user?.name) {
          users.push(state.user.name);
        }

        // Collect active interactions
        if (state.interaction) {
          const userId = state.user?.name || clientId;
          interactions[userId] = {
            taskId: state.interaction.taskId,
            action: state.interaction.action,
            color: state.user?.color || '#666'
          };
        }
      });

      setUserInteractions(interactions);
      setConnectedUsers(users);
    };

    awareness.on('change', handleAwarenessChange);

    // Cleanup
    return () => {
      console.log(`[useYjsTasks] Cleaning up for tasks ${cloudTasksId}`);
      clearTimeout(offlineInitTimeout);
      isReadyRef.current = false;
      ytasks.unobserveDeep(handleTasksChange);
      awareness.off('change', handleAwarenessChange);
      cleanupYjsProvider(cloudTasksId);
    };
    // Intentionally keyed only on the tasks identity and socket: initialTasks/
    // onTasksChange are read as snapshots/latest-callbacks and Yjs handles
    // reconnection, so re-running on their identity changes would tear down
    // the live doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudTasksId, socket]);

  /**
   * Convert Y.Map of tasks to array
   */
  /**
   * Update a task
   */
  const updateTask = (taskId, updates) => {
    if (!isReadyRef.current || !ytasksRef.current) {
      console.log('[useYjsTasks] Cannot update task - not ready');
      return;
    }

    const ytasks = ytasksRef.current;
    const taskKey = String(taskId);

    console.log(`[useYjsTasks] Updating task ${taskId}:`, updates);

    isLocalChangeRef.current = true;

    ytasks.doc.transact(() => {
      if (!ytasks.has(taskKey)) {
        console.warn(`[useYjsTasks] Task ${taskId} not found in Yjs map`);
        return;
      }

      const taskMap = ytasks.get(taskKey);
      Object.entries(updates).forEach(([key, value]) => {
        if (value !== undefined) {
          // Handle arrays
          if (Array.isArray(value)) {
            taskMap.set(key, JSON.stringify(value));
          } else {
            taskMap.set(key, value);
          }
        }
      });
    });

    // The observer will handle updating the state
  };

  /**
   * Add a new task
   */
  const addTask = (task) => {
    if (!isReadyRef.current || !ytasksRef.current) {
      console.log('[useYjsTasks] Cannot add task - not ready');
      return;
    }

    const ytasks = ytasksRef.current;
    const taskKey = String(task.id);

    console.log(`[useYjsTasks] Adding task ${task.id}:`, task);

    isLocalChangeRef.current = true;

    ytasks.doc.transact(() => {
      const taskMap = new Y.Map();
      Object.entries(task).forEach(([key, value]) => {
        if (value !== undefined) {
          // Handle arrays
          if (Array.isArray(value)) {
            taskMap.set(key, JSON.stringify(value));
          } else {
            taskMap.set(key, value);
          }
        }
      });
      ytasks.set(taskKey, taskMap);
    });

    // The observer will handle updating the state
  };

  /**
   * Delete a task
   */
  const deleteTask = (taskId) => {
    if (!isReadyRef.current || !ytasksRef.current) {
      console.log('[useYjsTasks] Cannot delete task - not ready');
      return;
    }

    const ytasks = ytasksRef.current;
    const taskKey = String(taskId);

    console.log(`[useYjsTasks] Deleting task ${taskId}`);

    isLocalChangeRef.current = true;

    ytasks.doc.transact(() => {
      ytasks.delete(taskKey);
    });

    // The observer will handle updating the state
  };

  /**
   * Set user interaction (for awareness)
   */
  const setUserInteraction = (taskId, action) => {
    if (!awarenessRef.current) return;

    awarenessRef.current.setLocalStateField('interaction', {
      taskId,
      action // 'editing', 'viewing', etc.
    });
  };

  /**
   * Clear user interaction
   */
  const clearUserInteraction = () => {
    if (!awarenessRef.current) return;

    awarenessRef.current.setLocalStateField('interaction', null);
  };

  /**
   * Set user info (name, color)
   */
  const setUserInfo = (name, color) => {
    if (!awarenessRef.current) {
      setTimeout(() => {
        if (awarenessRef.current) {
          console.log(`[useYjsTasks] Retry: Setting user info: ${name}, ${color}`);
          awarenessRef.current.setLocalStateField('user', { name, color });
        }
      }, 100);
      return;
    }

    console.log(`[useYjsTasks] Setting user info: ${name}, ${color}`);
    awarenessRef.current.setLocalStateField('user', { name, color });
  };

  return {
    tasks,
    userInteractions,
    connectedUsers,
    isConnected,
    updateTask,
    addTask,
    deleteTask,
    setUserInteraction,
    clearUserInteraction,
    setUserInfo
  };
}
