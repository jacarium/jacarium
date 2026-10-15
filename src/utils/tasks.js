/**
 * Tasks Manager
 * Manages TaskWarrior tasks stored in IndexedDB using Dexie
 * Provides sync with TaskWarrior CLI and cloud sharing
 */

import { db } from '../db/database';
import { scopedKey } from './accountStorage';
import { getBackendUrl, apiFetch } from './backendUrl';
import { generateUUID } from './uuid';

// Track UUIDs of tasks that have been permanently purged (per account when
// one is signed in - src/utils/accountStorage.js)
const PURGED_TASKS_KEY = 'taskwarrior_purged_uuids';

/**
 * UUIDs of tasks the user permanently deleted on this machine (the local
 * tombstones): syncFromTaskWarrior ignores the CLI's copy of them and a
 * database merge import does not re-create them.
 * @returns {string[]}
 */
export function getPurgedTaskUUIDs() {
  try {
    const purged = localStorage.getItem(scopedKey(PURGED_TASKS_KEY));
    return purged ? JSON.parse(purged) : [];
  } catch (error) {
    console.error('[Tasks] Error reading purged tasks:', error);
    return [];
  }
}

function addPurgedTaskUUID(uuid) {
  addPurgedTaskUUIDs([uuid]);
}

/**
 * Record several uuids as permanently deleted on this machine (tombstones
 * carried by a database backup, see taskwarriorBackup.js). Duplicates are
 * ignored. Returns the number of uuids that were actually new to the list.
 * @param {string[]} uuids
 * @returns {number}
 */
export function addPurgedTaskUUIDs(uuids) {
  try {
    const purged = getPurgedTaskUUIDs();
    let added = 0;
    for (const uuid of uuids || []) {
      if (typeof uuid === 'string' && uuid && !purged.includes(uuid)) {
        purged.push(uuid);
        added += 1;
        console.log('[Tasks] Added to purge list:', uuid);
      }
    }
    if (added > 0) localStorage.setItem(scopedKey(PURGED_TASKS_KEY), JSON.stringify(purged));
    return added;
  } catch (error) {
    console.error('[Tasks] Error adding purged task:', error);
    return 0;
  }
}

/**
 * Replace the purge list wholesale (replace-mode database import: the
 * file's tombstones become this machine's tombstones).
 * @param {string[]} uuids
 */
export function setPurgedTaskUUIDs(uuids) {
  try {
    const clean = [...new Set((uuids || []).filter((u) => typeof u === 'string' && u))];
    localStorage.setItem(scopedKey(PURGED_TASKS_KEY), JSON.stringify(clean));
  } catch (error) {
    console.error('[Tasks] Error replacing purge list:', error);
  }
}

/**
 * Get all tasks from database
 * @returns {Promise<Array>} - Array of task objects
 */
export async function getTasks() {
  try {
    const tasks = await db.tasks.toArray();
    // Sort by urgency (highest first), then by modified date
    return tasks.sort((a, b) => {
      const urgencyA = a.urgency !== null && a.urgency !== undefined ? a.urgency : 0;
      const urgencyB = b.urgency !== null && b.urgency !== undefined ? b.urgency : 0;

      // First sort by urgency (descending)
      if (urgencyB !== urgencyA) {
        return urgencyB - urgencyA;
      }

      // If urgency is the same, sort by modified date (newest first)
      const modifiedA = a.modified ? new Date(a.modified).getTime() : 0;
      const modifiedB = b.modified ? new Date(b.modified).getTime() : 0;
      return modifiedB - modifiedA;
    });
  } catch (error) {
    console.error('Failed to get tasks:', error);
    return [];
  }
}

/**
 * Get tasks filtered by status
 * @param {string} status - Task status (pending, completed, deleted, waiting, recurring)
 * @returns {Promise<Array>} - Array of task objects
 */
export async function getTasksByStatus(status) {
  try {
    const tasks = await db.tasks.where('status').equals(status).toArray();
    return tasks;
  } catch (error) {
    console.error('Failed to get tasks by status:', error);
    return [];
  }
}

/**
 * Get tasks filtered by project
 * @param {string} project - Project name
 * @returns {Promise<Array>} - Array of task objects
 */
export async function getTasksByProject(project) {
  try {
    const tasks = await db.tasks.where('project').equals(project).toArray();
    return tasks;
  } catch (error) {
    console.error('Failed to get tasks by project:', error);
    return [];
  }
}

/**
 * Get tasks filtered by tag
 * @param {string} tag - Tag name
 * @returns {Promise<Array>} - Array of task objects
 */
export async function getTasksByTag(tag) {
  try {
    const tasks = await db.tasks.where('tags').equals(tag).toArray();
    return tasks;
  } catch (error) {
    console.error('Failed to get tasks by tag:', error);
    return [];
  }
}

/**
 * Get a single task by ID
 * @param {number} id - Task ID
 * @returns {Promise<Object|null>} - Task object or null
 */
export async function getTask(id) {
  try {
    const task = await db.tasks.get(id);
    return task || null;
  } catch (error) {
    console.error('Failed to get task:', error);
    return null;
  }
}

/**
 * Get a task by UUID (TaskWarrior UUID)
 * @param {string} uuid - TaskWarrior UUID
 * @returns {Promise<Object|null>} - Task object or null
 */
export async function getTaskByUUID(uuid) {
  try {
    const task = await db.tasks.where('uuid').equals(uuid).first();
    return task || null;
  } catch (error) {
    console.error('Failed to get task by UUID:', error);
    return null;
  }
}

/**
 * Create a new task
 * @param {Object} task - Task object {uuid, description, status, project, tags, priority, etc.}
 * @returns {Promise<number>} - Created task ID
 */
export async function createTask(task) {
  try {
    const newTask = normalizeTaskRow(task);

    console.log('[Tasks] Creating task:', {
      uuid: newTask.uuid,
      description: newTask.description,
      status: newTask.status,
      instanceId: newTask.instanceId,
      inCloud: newTask.inCloud,
      ownerId: newTask.ownerId
    });

    const id = await db.tasks.add(newTask);
    return id;
  } catch (error) {
    console.error('Failed to create task:', error);
    throw error;
  }
}

/**
 * The row createTask() stores for `task`: every field present with the
 * app's defaults (a uuid is minted when missing, entry/modified default to
 * now, dates to null, lists to []). Exported so a database import can build
 * rows of exactly this shape without going through db.tasks.add.
 * @param {Object} task
 * @returns {Object}
 */
export function normalizeTaskRow(task) {
  return {
    uuid: task.uuid || generateUUID(),
    description: task.description || '',
    status: task.status || 'pending',
    project: task.project || '',
    tags: task.tags || [],
    priority: task.priority || '',
    entry: task.entry || new Date().toISOString(),
    modified: task.modified || new Date().toISOString(),
    due: task.due || null,
    wait: task.wait || null,
    until: task.until || null,
    scheduled: task.scheduled || null,
    depends: task.depends || [],
    annotations: task.annotations || [],
    start: task.start || null,
    end: task.end || null,
    urgency: task.urgency || null,
    recur: task.recur || null,
    instanceId: task.instanceId || null,
    // Preserve cloud fields if present
    ...(task.inCloud !== undefined && { inCloud: task.inCloud }),
    ...(task.ownerId && { ownerId: task.ownerId }),
    ...(task.cloudDocumentId && { cloudDocumentId: task.cloudDocumentId }),
    ...(task.permissions && { permissions: task.permissions }),
  };
}

/**
 * Update an existing task
 * @param {number} id - Task ID
 * @param {Object} updates - Updates to apply
 * @returns {Promise<Object|null>} - Updated task object or null
 */
export async function updateTask(id, updates) {
  try {
    const existing = await db.tasks.get(id);

    if (!existing) {
      console.error('Task not found:', id);
      return null;
    }

    const updated = {
      ...existing,
      ...updates,
      id, // Preserve ID
      // a caller that knows the real modification time (the re-read of
      // `task export`) keeps it: a re-read that changes nothing must not
      // make the row look newer, or it would be synchronised to every
      // other device of the account as an "edit" (src/sync/)
      modified: updates.modified || new Date().toISOString(),
    };

    console.log('[Tasks] Updating task:', {
      id,
      uuid: updated.uuid,
      description: updated.description,
      status: updated.status,
      inCloud: updated.inCloud
    });

    await db.tasks.put(updated);
    return updated;
  } catch (error) {
    console.error('Failed to update task:', error);
    throw error;
  }
}

/**
 * Delete a task (mark as deleted in TaskWarrior, or remove from DB)
 * @param {number} id - Task ID
 * @param {boolean} hardDelete - If true, permanently delete. If false, mark as deleted.
 * @returns {Promise<boolean>} - Success status
 */
export async function deleteTask(id, hardDelete = false) {
  try {
    if (hardDelete) {
      // Get task UUID before deleting
      const task = await db.tasks.get(id);
      if (task && task.uuid) {
        // Add to purge list so it won't be re-imported
        addPurgedTaskUUID(task.uuid);
      }
      await db.tasks.delete(id);
      console.log('[Tasks] Hard deleted task:', id);
    } else {
      await updateTask(id, { status: 'deleted' });
      console.log('[Tasks] Soft deleted task (marked as deleted):', id);
    }
    return true;
  } catch (error) {
    console.error('Failed to delete task:', error);
    return false;
  }
}

/**
 * Cached tasks that belong to no TaskWarrior instance: instanceId missing /
 * null, or pointing at an id with no row in db.taskwarriorInstances. The
 * Tasks page lists tasks per instance (t.instanceId === instance.id), so
 * these rows are never visible and are never pushed to any CLI. They come
 * from older imports (instance ids that changed between machines), tasks
 * created before an instance was picked, or rows left behind when an
 * instance disappeared without its tasks (deleteInstance removes them, but
 * a raw row delete or a replace import that dropped the instance does not).
 * @returns {Promise<Array>} db.tasks rows, unsorted
 */
export async function getOrphanedTasks() {
  const instanceIds = new Set((await db.taskwarriorInstances.toArray()).map((i) => i.id));
  const tasks = await db.tasks.toArray();
  return tasks.filter((t) => t.instanceId == null || !instanceIds.has(t.instanceId));
}

/**
 * Remove the orphaned rows (see getOrphanedTasks) from the db.tasks cache.
 * Plain row deletes only: no TaskWarrior CLI / backend call and NO purge-list
 * entry (these are not TaskWarrior deletions - the tasks may well still live
 * in some instance's data files and come back through a sync there).
 * @returns {Promise<number>} rows removed
 */
export async function deleteOrphanedTasks() {
  const orphans = await getOrphanedTasks();
  if (orphans.length > 0) await db.tasks.bulkDelete(orphans.map((t) => t.id));
  return orphans.length;
}

/**
 * The Tasks page's orphaned-tasks banner text for `count` rows.
 * @param {number} count
 * @returns {string}
 */
export function describeOrphanedTasks(count) {
  return `${count} ${count === 1 ? 'Task' : 'Tasks'} in TaskWarrior not belonging to any TaskWarrior instance.`;
}

/**
 * Get all unique projects from tasks
 * @returns {Promise<Array<string>>} - Array of project names
 */
export async function getProjects() {
  try {
    const tasks = await db.tasks.toArray();
    const projects = [...new Set(tasks.map(t => t.project).filter(Boolean))];
    return projects.sort();
  } catch (error) {
    console.error('Failed to get projects:', error);
    return [];
  }
}

/**
 * Get all unique tags from tasks
 * @returns {Promise<Array<string>>} - Array of tag names
 */
export async function getAllTags() {
  try {
    const tasks = await db.tasks.toArray();
    const tags = new Set();
    tasks.forEach(task => {
      if (task.tags && Array.isArray(task.tags)) {
        task.tags.forEach(tag => tags.add(tag));
      }
    });
    return Array.from(tags).sort();
  } catch (error) {
    console.error('Failed to get tags:', error);
    return [];
  }
}

/**
 * Sync tasks from TaskWarrior CLI
 * Fetches all tasks from TaskWarrior and updates local database
 * @param {number} instanceId - TaskWarrior instance ID
 * @param {string} rcPath - Path to taskrc file
 * @param {string} dataPath - Path to task data directory
 * @returns {Promise<Object>} - {success, count, error}
 */
export async function syncFromTaskWarrior(instanceId, rcPath = null, dataPath = null) {
  try {
    console.log('[Tasks] Syncing from TaskWarrior CLI...');

    const tasks = await fetchTaskWarriorTasks(rcPath, dataPath);

    console.log(`[Tasks] Received ${tasks.length} tasks from TaskWarrior`);

    // Get list of permanently purged tasks
    const purgedUUIDs = getPurgedTaskUUIDs();

    // Filter out purged tasks - they've been permanently deleted by the user
    const validTasks = tasks.filter(t => !purgedUUIDs.includes(t.uuid));
    if (validTasks.length < tasks.length) {
      console.log(`[Tasks] Filtered out ${tasks.length - validTasks.length} purged tasks`);
    }

    // Update or create tasks in database
    let importedCount = 0;
    for (const task of validTasks) {
      const existing = await getTaskByUUID(task.uuid);

      // Convert annotation timestamps
      const convertedAnnotations = (task.annotations || []).map(ann => ({
        ...ann,
        entry: convertTaskWarriorTimestamp(ann.entry) || ann.entry
      }));

      if (existing) {
        // Keep the newer modified timestamp (local vs TaskWarrior)
        const taskWarriorModified = convertTaskWarriorTimestamp(task.modified);
        const localModified = existing.modified;
        const newerModified = (taskWarriorModified && localModified && new Date(taskWarriorModified) > new Date(localModified))
          ? taskWarriorModified
          : localModified || taskWarriorModified;

        // Update existing task
        await updateTask(existing.id, {
          instanceId, // Ensure instanceId is set for existing tasks
          description: task.description,
          status: task.status,
          project: task.project,
          tags: task.tags || [],
          priority: task.priority,
          due: convertTaskWarriorTimestamp(task.due),
          wait: convertTaskWarriorTimestamp(task.wait),
          until: convertTaskWarriorTimestamp(task.until),
          scheduled: convertTaskWarriorTimestamp(task.scheduled),
          depends: task.depends || [],
          annotations: convertedAnnotations,
          start: convertTaskWarriorTimestamp(task.start),
          end: convertTaskWarriorTimestamp(task.end),
          urgency: task.urgency || null,
          recur: task.recur || null,
          modified: newerModified,
        });
      } else {
        // Create new task with instanceId
        await createTask(fromTaskWarriorJson(task, instanceId));
      }
      importedCount++;
    }

    // Clean up orphaned deleted tasks - remove local deleted tasks that don't exist in TaskWarrior
    const taskWarriorUUIDs = new Set(validTasks.map(t => t.uuid).filter(Boolean));
    const localTasks = await db.tasks.where('instanceId').equals(instanceId).toArray();

    let cleanedCount = 0;
    for (const localTask of localTasks) {
      // If task has UUID, is deleted, and doesn't exist in TaskWarrior, remove it
      if (localTask.uuid && localTask.status === 'deleted' && !taskWarriorUUIDs.has(localTask.uuid)) {
        await db.tasks.delete(localTask.id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[Tasks] Cleaned up ${cleanedCount} orphaned deleted tasks`);
    }

    console.log(`[Tasks] Synced ${importedCount} tasks from TaskWarrior`);
    return { success: true, count: importedCount };
  } catch (error) {
    console.error('[Tasks] Sync from TaskWarrior failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Sync tasks to TaskWarrior CLI
 * Pushes local tasks to TaskWarrior
 * @param {number} instanceId - TaskWarrior instance ID
 * @param {string} rcPath - Path to taskrc file
 * @param {string} dataPath - Path to task data directory
 * @returns {Promise<Object>} - {success, count, error}
 */
export async function syncToTaskWarrior(instanceId, rcPath = null, dataPath = null) {
  try {
    console.log('[Tasks] Syncing to TaskWarrior CLI...');

    // Get only tasks for this instance
    const allTasks = await getTasks();
    const instanceTasks = allTasks.filter(t => t.instanceId === instanceId);

    // Filter to only include TaskWarrior-compatible fields
    const tasks = instanceTasks.map(toTaskWarriorJson);

    console.log('[Tasks] Filtered tasks for TaskWarrior:', tasks.length);

    const result = await pushTaskWarriorTasks(tasks, rcPath, dataPath);

    console.log(`[Tasks] Synced ${result.count} tasks to TaskWarrior`);
    return { success: true, count: result.count };
  } catch (error) {
    console.error('[Tasks] Sync to TaskWarrior failed:', error);
    return { success: false, error: error.message };
  }
}

// (There is no "run any task command" helper: the backend's former
// POST /api/taskwarrior/command route was removed - it ran whatever string
// it was given, `task execute <shell command>` included. Nothing used it.)

/**
 * Start a task (begin time tracking)
 * @param {Object} task - Task object with uuid
 * @param {string} rcPath - Path to taskrc file
 * @param {string} dataPath - Path to task data directory
 * @returns {Promise<Object>} - {success, error}
 */
export async function startTask(task, rcPath = null, dataPath = null) {
  try {
    console.log('[Tasks] Starting task:', task.uuid);

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid: task.uuid,
        rcPath,
        dataPath,
      })
    });

    if (!response.ok) {
      throw new Error(`Start task failed: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.success) {
      // Update local task with start time
      await updateTask(task.id, {
        start: new Date().toISOString()
      });
    }

    return { success: true };
  } catch (error) {
    console.error('[Tasks] Start task failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Stop a task (pause time tracking)
 * @param {Object} task - Task object with uuid
 * @param {string} rcPath - Path to taskrc file
 * @param {string} dataPath - Path to task data directory
 * @returns {Promise<Object>} - {success, error}
 */
export async function stopTask(task, rcPath = null, dataPath = null) {
  try {
    console.log('[Tasks] Stopping task:', task.uuid);

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid: task.uuid,
        rcPath,
        dataPath,
      })
    });

    if (!response.ok) {
      throw new Error(`Stop task failed: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.success) {
      // Update local task to remove start time
      await updateTask(task.id, {
        start: null
      });
    }

    return { success: true };
  } catch (error) {
    console.error('[Tasks] Stop task failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Add an annotation to a task
 * @param {Object} task - Task object with uuid
 * @param {string} annotation - Annotation text
 * @param {string} rcPath - Path to taskrc file
 * @param {string} dataPath - Path to task data directory
 * @returns {Promise<Object>} - {success, error}
 */
export async function annotateTask(task, annotation, rcPath = null, dataPath = null) {
  try {
    console.log('[Tasks] Adding annotation to task:', task.uuid);

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid: task.uuid,
        annotation,
        rcPath,
        dataPath,
      })
    });

    if (!response.ok) {
      throw new Error(`Annotate task failed: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.success) {
      // Update local task with new annotation
      const currentAnnotations = task.annotations || [];
      await updateTask(task.id, {
        annotations: [...currentAnnotations, {
          entry: new Date().toISOString(),
          description: annotation
        }]
      });
    }

    return { success: true };
  } catch (error) {
    console.error('[Tasks] Annotate task failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Delete a task from TaskWarrior CLI
 * @param {Object} task - Task object with uuid
 * @param {string} rcPath - Path to taskrc file
 * @param {string} dataPath - Path to task data directory
 * @returns {Promise<Object>} - {success, error}
 */
export async function deleteTaskWarriorTask(task, rcPath = null, dataPath = null) {
  try {
    console.log('[Tasks] Deleting task from TaskWarrior:', task.uuid);

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid: task.uuid,
        rcPath,
        dataPath,
      })
    });

    if (!response.ok) {
      throw new Error(`Delete task failed: ${response.statusText}`);
    }

    await response.json();
    return { success: true };
  } catch (error) {
    console.error('[Tasks] Delete task from TaskWarrior failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Permanently purge a task from TaskWarrior (for already-deleted tasks)
 * @param {Object} task - Task object with uuid
 * @param {string} rcPath - Path to taskrc file
 * @param {string} dataPath - Path to task data directory
 * @returns {Promise<Object>} - {success, error}
 */
export async function purgeTaskWarriorTask(task, rcPath = null, dataPath = null) {
  try {
    console.log('[Tasks] Purging task from TaskWarrior:', task.uuid);

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid: task.uuid,
        rcPath,
        dataPath,
      })
    });

    if (!response.ok) {
      throw new Error(`Purge task failed: ${response.statusText}`);
    }

    await response.json();
    return { success: true };
  } catch (error) {
    console.error('[Tasks] Purge task from TaskWarrior failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Remove an annotation from a task
 * @param {Object} task - Task object with uuid
 * @param {string} annotation - Annotation text to remove
 * @param {string} rcPath - Path to taskrc file
 * @param {string} dataPath - Path to task data directory
 * @returns {Promise<Object>} - {success, error}
 */
export async function denotateTask(task, annotation, rcPath = null, dataPath = null) {
  try {
    console.log('[Tasks] Removing annotation from task:', task.uuid);

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/denotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid: task.uuid,
        annotation,
        rcPath,
        dataPath,
      })
    });

    if (!response.ok) {
      throw new Error(`Denotate task failed: ${response.statusText}`);
    }

    await response.json();
    return { success: true };
  } catch (error) {
    console.error('[Tasks] Denotate task failed:', error);
    return { success: false, error: error.message };
  }
}

/* ------------------------------------------------------------------ */
/* TaskWarrior JSON <-> app row, and the two CLI primitives             */
/* (shared by the sync functions above and the database backup:        */
/* src/utils/taskwarriorBackup.js)                                      */
/* ------------------------------------------------------------------ */

/**
 * The TaskWarrior JSON (`task export` shape, TW timestamps) for one app
 * row - exactly what syncToTaskWarrior pushes: only TaskWarrior fields,
 * optional ones only when set, dates converted to YYYYMMDDTHHMMSSZ.
 * @param {Object} task - db.tasks row
 * @returns {Object}
 */
export function toTaskWarriorJson(task) {
  const twTask = {
    uuid: task.uuid,
    description: task.description,
    status: task.status,
    entry: convertToTaskWarriorTimestamp(task.entry) || task.entry,
    modified: convertToTaskWarriorTimestamp(task.modified) || task.modified,
  };

  if (task.project) twTask.project = task.project;
  if (task.tags && task.tags.length > 0) twTask.tags = task.tags;
  if (task.priority) twTask.priority = task.priority;

  for (const field of ['due', 'wait', 'until', 'scheduled', 'start', 'end']) {
    if (task[field]) {
      const converted = convertToTaskWarriorTimestamp(task[field]);
      if (converted) twTask[field] = converted;
    }
  }

  if (task.depends && task.depends.length > 0) twTask.depends = task.depends;

  if (task.annotations && task.annotations.length > 0) {
    twTask.annotations = task.annotations.map(ann => ({
      ...ann,
      entry: convertToTaskWarriorTimestamp(ann.entry) || ann.entry
    }));
  }

  if (task.urgency) twTask.urgency = task.urgency;
  if (task.recur) twTask.recur = task.recur;

  return twTask;
}

/**
 * The app row for one TaskWarrior JSON task - exactly what
 * syncFromTaskWarrior hands to createTask for a task it has not seen
 * before: TW timestamps converted to ISO, annotations converted, the
 * instance attached. TaskWarrior's own numeric `id` is dropped (the app
 * row gets its own auto-increment id).
 * @param {Object} twTask - one element of `task export`
 * @param {number|null} instanceId - local TaskWarrior instance id
 * @returns {Object} normalizeTaskRow()-shaped row (no `id`)
 */
export function fromTaskWarriorJson(twTask, instanceId) {
  const { id: _twId, ...task } = twTask;
  return normalizeTaskRow({
    ...task,
    instanceId,
    entry: convertTaskWarriorTimestamp(task.entry),
    modified: convertTaskWarriorTimestamp(task.modified),
    due: convertTaskWarriorTimestamp(task.due),
    wait: convertTaskWarriorTimestamp(task.wait),
    until: convertTaskWarriorTimestamp(task.until),
    scheduled: convertTaskWarriorTimestamp(task.scheduled),
    start: convertTaskWarriorTimestamp(task.start),
    end: convertTaskWarriorTimestamp(task.end),
    annotations: (task.annotations || []).map(ann => ({
      ...ann,
      entry: convertTaskWarriorTimestamp(ann.entry) || ann.entry
    })),
  });
}

/**
 * `task export` (every status) of one instance through the backend. Throws
 * when the backend or the CLI is unreachable / fails - callers treat that
 * as "no CLI for this instance". Read-only.
 * @param {string|null} rcPath
 * @param {string|null} dataPath
 * @returns {Promise<Object[]>} TaskWarrior JSON tasks
 */
export async function fetchTaskWarriorTasks(rcPath = null, dataPath = null) {
  const backendUrl = await getBackendUrl();
  const response = await apiFetch(`${backendUrl}/api/taskwarrior/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rcPath, dataPath }),
  });

  if (!response.ok) {
    throw new Error(`TaskWarrior export failed: ${response.statusText}`);
  }

  const tasks = await response.json();
  if (!Array.isArray(tasks)) {
    throw new Error(tasks?.error || 'TaskWarrior export returned no task list');
  }
  return tasks;
}

/**
 * `task import` of TaskWarrior JSON tasks through the backend. TaskWarrior
 * upserts by uuid regardless of `modified` (the imported copy always wins
 * and a modified task gets modified=now), so callers decide WHAT to push.
 * Returns the backend's result: { success, count, added: [uuid],
 * modified: [uuid], output }. Throws on transport / CLI failure.
 * @param {Object[]} tasks - TaskWarrior JSON tasks
 * @param {string|null} rcPath
 * @param {string|null} dataPath
 */
export async function pushTaskWarriorTasks(tasks, rcPath = null, dataPath = null) {
  const backendUrl = await getBackendUrl();
  const response = await apiFetch(`${backendUrl}/api/taskwarrior/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks, rcPath, dataPath })
  });

  if (!response.ok) {
    throw new Error(`TaskWarrior import failed: ${response.statusText}`);
  }

  const result = await response.json();
  if (result && result.success === false) {
    throw new Error(result.error || 'TaskWarrior import failed');
  }
  return result;
}

/**
 * Convert TaskWarrior compact timestamp to ISO 8601 format
 * TaskWarrior format: "20260413T112722Z"
 * ISO format: "2026-04-13T11:27:22Z"
 * @param {string} twTimestamp - TaskWarrior timestamp
 * @returns {string|null} - ISO 8601 timestamp or null
 */
export function convertTaskWarriorTimestamp(twTimestamp) {
  if (!twTimestamp || typeof twTimestamp !== 'string') {
    return null;
  }

  // TaskWarrior format: YYYYMMDDTHHmmssZ
  const match = twTimestamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) {
    // Already in ISO format or invalid
    return twTimestamp;
  }

  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

/**
 * Convert ISO 8601 timestamp to TaskWarrior compact format
 * ISO format: "2026-04-13T11:27:22Z" or "2026-04-13T11:27:22.000Z"
 * TaskWarrior format: "20260413T112722Z"
 * @param {string} isoTimestamp - ISO timestamp
 * @returns {string|null} - TaskWarrior timestamp or null
 */
export function convertToTaskWarriorTimestamp(isoTimestamp) {
  if (!isoTimestamp || typeof isoTimestamp !== 'string') {
    return null;
  }

  // Check if already in TaskWarrior format
  if (/^\d{8}T\d{6}Z$/.test(isoTimestamp)) {
    return isoTimestamp;
  }

  try {
    const date = new Date(isoTimestamp);
    if (isNaN(date.getTime())) {
      console.warn('[Tasks] Invalid timestamp, skipping:', isoTimestamp);
      return null;
    }

    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');
    const minute = String(date.getUTCMinutes()).padStart(2, '0');
    const second = String(date.getUTCSeconds()).padStart(2, '0');

    // Validate the components before constructing
    if (isNaN(year) || isNaN(parseInt(month)) || isNaN(parseInt(day))) {
      console.warn('[Tasks] Invalid date components, skipping:', isoTimestamp);
      return null;
    }

    return `${year}${month}${day}T${hour}${minute}${second}Z`;
  } catch (error) {
    console.error('[Tasks] Error converting timestamp:', error);
    return null;
  }
}

/**
 * Permanently purge all deleted tasks from TaskWarrior database
 * @param {string} rcPath - Path to taskrc file
 * @param {string} dataPath - Path to task data directory
 * @returns {Promise<Object>} - {success, purged_count, error}
 */
export async function purgeDeletedTasks(rcPath = null, dataPath = null) {
  try {
    console.log('[Tasks] Purging deleted tasks from TaskWarrior...');

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/purge-deleted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rcPath,
        dataPath,
      })
    });

    if (!response.ok) {
      throw new Error(`Purge failed: ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`[Tasks] Purged ${result.purged_count} deleted tasks from TaskWarrior`);
    return { success: true, purged_count: result.purged_count };
  } catch (error) {
    console.error('[Tasks] Purge deleted tasks failed:', error);
    return { success: false, error: error.message };
  }
}
