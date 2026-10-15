/**
 * TaskWarrior Instances Management
 * Provides CRUD operations for TaskWarrior instances in IndexedDB
 */

import { db } from '../db/database';
import { getBackendUrl, apiFetch } from './backendUrl';

/**
 * Get all TaskWarrior instances
 */
export async function getAllInstances() {
  try {
    const instances = await db.taskwarriorInstances.toArray();
    return instances.sort((a, b) => {
      // Active instance first
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      // Then by name
      return a.name.localeCompare(b.name);
    });
  } catch (error) {
    console.error('Error getting instances:', error);
    throw error;
  }
}

/**
 * Get active TaskWarrior instance
 */
export async function getActiveInstance() {
  try {
    const instance = await db.taskwarriorInstances
      .where('isActive')
      .equals(1)
      .first();
    return instance || null;
  } catch (error) {
    console.error('Error getting active instance:', error);
    throw error;
  }
}

/**
 * Get instance by ID
 */
export async function getInstance(id) {
  try {
    const instance = await db.taskwarriorInstances.get(id);
    return instance || null;
  } catch (error) {
    console.error('Error getting instance:', error);
    throw error;
  }
}

/**
 * Create a new TaskWarrior instance
 */
export async function createInstance(instanceData) {
  try {
    const now = new Date().toISOString();

    const instance = {
      name: instanceData.name || 'New Instance',
      category: instanceData.category || 'General',
      description: instanceData.description || '',
      rcPath: instanceData.rcPath || '',
      dataPath: instanceData.dataPath || '',
      isActive: instanceData.isActive ? 1 : 0,
      inCloud: instanceData.inCloud ? 1 : 0,
      ownerId: instanceData.ownerId || null,
      permissions: instanceData.permissions || null,
      cloudDocumentId: instanceData.cloudDocumentId || null,
      createdAt: now,
      updatedAt: now,
    };

    // If this instance is set as active, deactivate all others
    if (instance.isActive) {
      await db.taskwarriorInstances
        .where('isActive')
        .equals(1)
        .modify({ isActive: 0 });
    }

    const id = await db.taskwarriorInstances.add(instance);
    return { ...instance, id };
  } catch (error) {
    console.error('Error creating instance:', error);
    throw error;
  }
}

/**
 * Update an existing TaskWarrior instance
 */
export async function updateInstance(id, updates) {
  try {
    const updateData = {
      ...updates,
    };

    // Only update timestamp if this is a meaningful change (not just isActive)
    const meaningfulKeys = Object.keys(updates).filter(k => k !== 'isActive');
    if (meaningfulKeys.length > 0) {
      updateData.updatedAt = new Date().toISOString();
    }

    // If setting this instance as active, deactivate all others first
    if (updateData.isActive) {
      await db.taskwarriorInstances
        .where('isActive')
        .equals(1)
        .modify({ isActive: 0 });
    }

    await db.taskwarriorInstances.update(id, updateData);

    return await getInstance(id);
  } catch (error) {
    console.error('Error updating instance:', error);
    throw error;
  }
}

/**
 * Delete a TaskWarrior instance
 */
export async function deleteInstance(id) {
  try {
    // Check if this is the active instance
    const instance = await getInstance(id);

    await db.taskwarriorInstances.delete(id);

    // Also delete all tasks and reports associated with this instance
    await db.tasks.where('instanceId').equals(id).delete();
    await db.taskwarriorReports.where('instanceId').equals(id).delete();

    // If we deleted the active instance, activate the first remaining instance
    if (instance && instance.isActive) {
      const remainingInstances = await getAllInstances();
      if (remainingInstances.length > 0) {
        await updateInstance(remainingInstances[0].id, { isActive: 1 });
      }
    }

    return true;
  } catch (error) {
    console.error('Error deleting instance:', error);
    throw error;
  }
}

/**
 * Set an instance as active
 */
export async function setActiveInstance(id) {
  try {
    // Deactivate all instances
    await db.taskwarriorInstances
      .where('isActive')
      .equals(1)
      .modify({ isActive: 0 });

    // Activate the selected instance using modify() to avoid updating timestamp
    await db.taskwarriorInstances
      .where('id')
      .equals(id)
      .modify({ isActive: 1 });

    return await getInstance(id);
  } catch (error) {
    console.error('Error setting active instance:', error);
    throw error;
  }
}

/**
 * Initialize a new TaskWarrior instance on the backend
 */
export async function initializeInstance(dataPath, rcPath = '', config = {}) {
  try {
    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/instances/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dataPath,
        rcPath,
        config,
      }),
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || 'Failed to initialize instance');
    }

    return result;
  } catch (error) {
    console.error('Error initializing instance:', error);
    throw error;
  }
}

/**
 * Validate a TaskWarrior instance configuration
 */
export async function validateInstance(rcPath, dataPath) {
  try {
    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/instances/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rcPath,
        dataPath,
      }),
    });

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Error validating instance:', error);
    throw error;
  }
}

/**
 * Get statistics for a TaskWarrior instance
 */
export async function getInstanceStats(rcPath, dataPath) {
  try {
    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/instances/stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rcPath,
        dataPath,
      }),
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || 'Failed to get instance stats');
    }

    return result.stats;
  } catch (error) {
    console.error('Error getting instance stats:', error);
    throw error;
  }
}

/**
 * Get tasks for a specific instance from IndexedDB
 */
export async function getInstanceTasks(instanceId) {
  try {
    const tasks = await db.tasks
      .where('instanceId')
      .equals(instanceId)
      .toArray();
    return tasks;
  } catch (error) {
    console.error('Error getting instance tasks:', error);
    throw error;
  }
}

/**
 * Get reports for a specific instance
 */
export async function getInstanceReports(instanceId) {
  try {
    const reports = await db.taskwarriorReports
      .where('instanceId')
      .equals(instanceId)
      .toArray();
    return reports;
  } catch (error) {
    console.error('Error getting instance reports:', error);
    throw error;
  }
}

/**
 * Create a custom report for an instance
 */
export async function createReport(reportData) {
  try {
    const now = new Date().toISOString();

    const report = {
      instanceId: reportData.instanceId,
      name: reportData.name || 'New Report',
      description: reportData.description || '',
      filter: reportData.filter || '',
      columns: reportData.columns || 'id,description,project,tags,due',
      sort: reportData.sort || 'priority-,due+',
      isBuiltIn: false,
      createdAt: now,
      updatedAt: now,
    };

    const id = await db.taskwarriorReports.add(report);
    return { ...report, id };
  } catch (error) {
    console.error('Error creating report:', error);
    throw error;
  }
}

/**
 * Update a custom report
 */
export async function updateReport(id, updates) {
  try {
    const now = new Date().toISOString();

    const updateData = {
      ...updates,
      updatedAt: now,
    };

    await db.taskwarriorReports.update(id, updateData);

    const report = await db.taskwarriorReports.get(id);
    return report;
  } catch (error) {
    console.error('Error updating report:', error);
    throw error;
  }
}

/**
 * Delete a custom report
 */
export async function deleteReport(id) {
  try {
    await db.taskwarriorReports.delete(id);
    return true;
  } catch (error) {
    console.error('Error deleting report:', error);
    throw error;
  }
}

/**
 * Execute a report against TaskWarrior CLI
 */
export async function executeReport(reportName, instanceId, filterArgs = []) {
  try {
    const instance = await getInstance(instanceId);

    if (!instance) {
      throw new Error('Instance not found');
    }

    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/reports/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reportName,
        rcPath: instance.rcPath || null,
        dataPath: instance.dataPath || null,
        filter: filterArgs,
        format: 'json',
      }),
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || 'Failed to execute report');
    }

    return result.tasks || [];
  } catch (error) {
    console.error('Error executing report:', error);
    throw error;
  }
}
