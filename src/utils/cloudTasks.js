/**
 * Cloud Tasks Utility
 * Provides helper functions for cloud task metadata and identification
 */

import { getMachineId } from './cloudCentralSync';

// Re-export the canonical machine ID helper for existing call sites that
// import it from this module.
export { getMachineId };

/**
 * Check if a task is in the cloud
 */
export function isTaskInCloud(task) {
  return task && task.inCloud === true;
}

/**
 * Check if current user is owner of cloud task or has write permissions
 */
export async function isTaskOwner(task) {
  if (!task || !task.inCloud) {
    return true; // Local tasks are always editable
  }

  const machineId = await getMachineId();

  // Check if user is the owner
  if (task.ownerId === machineId) {
    return true;
  }

  // Check if user has write permissions
  if (task.permissions && typeof task.permissions === 'object') {
    return task.permissions[machineId] === 'write';
  }

  return false;
}

/**
 * Get cloud tasks only
 */
export async function getCloudTasks() {
  try {
    const { getTasks } = await import('./tasks');
    const allTasks = await getTasks();
    return allTasks.filter(task => task.inCloud === true);
  } catch (error) {
    console.error('Failed to get cloud tasks:', error);
    return [];
  }
}

/**
 * Get projects that were created by cloud tasks
 */
export async function getCloudProjects() {
  try {
    const cloudTasks = await getCloudTasks();
    const projects = new Set();

    cloudTasks.forEach(task => {
      if (task.project) {
        projects.add(task.project);
      }
    });

    return Array.from(projects);
  } catch (error) {
    console.error('Failed to get cloud projects:', error);
    return [];
  }
}
