/**
 * Custom Fields Manager
 * Manages user-defined custom JIRA fields stored in IndexedDB using Dexie
 */

import { db } from '../db/database';

/**
 * Get all custom fields from database
 * @returns {Promise<Array>} - Array of custom field objects
 */
export async function getCustomFields() {
  try {
    const fields = await db.customFields.toArray();
    return fields;
  } catch (error) {
    console.error('Failed to get custom fields:', error);
    return [];
  }
}

/**
 * Add a new custom field
 * @param {Object} field - Field object {id, name, type, operators}
 * @returns {Promise<Object>} - Saved field object
 */
export async function addCustomField(field) {
  try {
    // Check if field with this ID already exists
    const existing = await db.customFields.get(field.id);
    if (existing) {
      throw new Error(`Field with ID "${field.id}" already exists`);
    }

    const newField = {
      id: field.id,
      name: field.name,
      type: field.type || 'text',
      operators: field.operators || ['=', '!=', '~', '!~'],
      useNameInJQL: field.useNameInJQL || false,
      isCustom: true,
      createdAt: Date.now(),
    };

    await db.customFields.add(newField);
    return newField;
  } catch (error) {
    console.error('Failed to add custom field:', error);
    throw error;
  }
}

/**
 * Remove a custom field
 * @param {string} id - Field ID
 * @returns {Promise<boolean>} - Success status
 */
export async function removeCustomField(id) {
  try {
    await db.customFields.delete(id);
    return true;
  } catch (error) {
    console.error('Failed to remove custom field:', error);
    return false;
  }
}

/**
 * Clear all custom fields
 */
export async function clearCustomFields() {
  try {
    await db.customFields.clear();
    console.log('All custom fields cleared');
  } catch (error) {
    console.error('Failed to clear custom fields:', error);
  }
}

/**
 * Default operators for different field types
 */
export const defaultOperatorsByType = {
  text: ['=', '!=', '~', '!~', 'IS EMPTY', 'IS NOT EMPTY'],
  select: ['=', '!=', 'IN', 'NOT IN'],
  date: ['=', '!=', '>', '>=', '<', '<='],
  number: ['=', '!=', '>', '>=', '<', '<='],
};
