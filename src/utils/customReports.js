import { db } from '../db/database';

/**
 * Custom TaskWarrior Reports
 * Similar to templates, but for TaskWarrior filter views
 */

export async function getCustomReports() {
  try {
    const reports = await db.customReports.toArray();
    return reports;
  } catch (error) {
    console.error('[CustomReports] Error getting reports:', error);
    return [];
  }
}

export async function getCustomReport(id) {
  try {
    return await db.customReports.get(id);
  } catch (error) {
    console.error('[CustomReports] Error getting report:', error);
    return null;
  }
}

export async function createCustomReport(report) {
  try {
    const id = await db.customReports.add({
      ...report,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return id;
  } catch (error) {
    console.error('[CustomReports] Error creating report:', error);
    throw error;
  }
}

export async function updateCustomReport(id, updates) {
  try {
    await db.customReports.update(id, {
      ...updates,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[CustomReports] Error updating report:', error);
    throw error;
  }
}

export async function deleteCustomReport(id) {
  try {
    await db.customReports.delete(id);
  } catch (error) {
    console.error('[CustomReports] Error deleting report:', error);
    throw error;
  }
}
