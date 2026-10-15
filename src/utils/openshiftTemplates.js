/**
 * OpenShift Templates Manager
 * Manages OpenShift/Kubernetes YAML templates stored in IndexedDB
 */

import { db } from '../db/database';

/**
 * Get all OpenShift templates
 * @returns {Promise<Array>} Array of template objects
 */
export async function getOpenshiftTemplates() {
  try {
    const templates = await db.openshiftTemplates.orderBy('name').toArray();
    return templates;
  } catch (error) {
    console.error('Failed to get OpenShift templates:', error);
    return [];
  }
}

/**
 * Get OpenShift templates by category
 * @param {string} category - Category name
 * @returns {Promise<Array>} Array of template objects
 */
export async function getOpenshiftTemplatesByCategory(category) {
  try {
    const templates = await db.openshiftTemplates
      .where('category')
      .equals(category)
      .toArray();
    return templates;
  } catch (error) {
    console.error('Failed to get OpenShift templates by category:', error);
    return [];
  }
}


/**
 * Get a single OpenShift template by ID
 * @param {number} id - Template ID
 * @returns {Promise<Object|null>} Template object or null
 */
export async function getOpenshiftTemplate(id) {
  try {
    const template = await db.openshiftTemplates.get(id);
    return template || null;
  } catch (error) {
    console.error('Failed to get OpenShift template:', error);
    return null;
  }
}

/**
 * Create a new OpenShift template
 * @param {Object} template - Template object {name, category, yaml, icon, description}
 * @returns {Promise<number>} Created template ID
 */
export async function createOpenshiftTemplate(template) {
  try {
    const newTemplate = {
      name: template.name || 'Untitled Template',
      category: template.category || 'General',
      yaml: template.yaml || '',
      icon: template.icon || 'FileCode',
      description: template.description || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const id = await db.openshiftTemplates.add(newTemplate);
    return id;
  } catch (error) {
    console.error('Failed to create OpenShift template:', error);
    throw error;
  }
}

/**
 * Update an existing OpenShift template
 * @param {number} id - Template ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<number>} Number of updated records
 */
export async function updateOpenshiftTemplate(id, updates) {
  try {
    const updateData = {
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    const count = await db.openshiftTemplates.update(id, updateData);
    return count;
  } catch (error) {
    console.error('Failed to update OpenShift template:', error);
    throw error;
  }
}

/**
 * Delete an OpenShift template
 * @param {number} id - Template ID
 * @returns {Promise<void>}
 */
export async function deleteOpenshiftTemplate(id) {
  try {
    await db.openshiftTemplates.delete(id);
  } catch (error) {
    console.error('Failed to delete OpenShift template:', error);
    throw error;
  }
}

/**
 * Get all categories used by OpenShift templates
 * @returns {Promise<Array>} Array of unique category names
 */
export async function getOpenshiftTemplateCategories() {
  try {
    const templates = await db.openshiftTemplates.toArray();
    const categories = [...new Set(templates.map(t => t.category))];
    return categories.sort();
  } catch (error) {
    console.error('Failed to get OpenShift template categories:', error);
    return [];
  }
}
