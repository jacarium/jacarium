/**
 * JQL Query Templates
 * User-defined templates stored in IndexedDB using Dexie
 */

import { db } from '../db/database';

/**
 * Get all templates from database
 * @returns {Promise<Array>} - Array of template objects
 */
export async function getTemplates() {
  try {
    const templates = await db.templates.orderBy('createdAt').reverse().toArray();
    return templates;
  } catch (error) {
    console.error('Failed to get templates:', error);
    return [];
  }
}

/**
 * Save a new template
 * @param {Object} template - Template object {name, description, category, icon, rules, logic}
 * @returns {Promise<Object>} - Saved template object
 */
export async function saveTemplate(template) {
  try {
    const newTemplate = {
      ...template,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const id = await db.templates.add(newTemplate);
    newTemplate.id = id;

    return newTemplate;
  } catch (error) {
    console.error('Failed to save template:', error);
    throw error;
  }
}

/**
 * Update an existing template
 * @param {string|number} id - Template ID
 * @param {Object} updates - Updates to apply {name, description, category, icon, rules, logic}
 * @returns {Promise<Object|null>} - Updated template object or null
 */
export async function updateTemplate(id, updates) {
  try {
    const existing = await db.templates.get(id);

    if (!existing) {
      console.error('Template not found:', id);
      return null;
    }

    const updated = {
      ...existing,
      ...updates,
      id, // Preserve ID
      createdAt: existing.createdAt, // Preserve creation date
      updatedAt: Date.now(),
    };

    await db.templates.put(updated);
    return updated;
  } catch (error) {
    console.error('Failed to update template:', error);
    return null;
  }
}

/**
 * Delete a template
 * @param {string|number} id - Template ID
 * @returns {Promise<boolean>} - Success status
 */
export async function deleteTemplate(id) {
  try {
    await db.templates.delete(id);
    return true;
  } catch (error) {
    console.error('Failed to delete template:', error);
    return false;
  }
}

/**
 * Get templates by category
 * @param {string} category - Category name
 * @returns {Promise<Array>} - Filtered templates
 */
export async function getTemplatesByCategory(category) {
  try {
    const templates = await db.templates.where('category').equals(category).toArray();
    return templates;
  } catch (error) {
    console.error('Failed to get templates by category:', error);
    return [];
  }
}

/**
 * Get all unique categories
 * @returns {Promise<Array>} - Array of category names
 */
export async function getCategories() {
  try {
    const templates = await db.templates.toArray();
    const categories = [...new Set(templates.map(t => t.category))];
    return categories;
  } catch (error) {
    console.error('Failed to get categories:', error);
    return [];
  }
}

/**
 * Rename a category across all templates
 * @param {string} oldName - Current category name
 * @param {string} newName - New category name
 * @returns {Promise<number>} - Number of templates updated
 */
export async function renameCategory(oldName, newName) {
  try {
    const templates = await db.templates.where('category').equals(oldName).toArray();

    await Promise.all(
      templates.map(template =>
        db.templates.update(template.id, { category: newName, updatedAt: Date.now() })
      )
    );

    return templates.length;
  } catch (error) {
    console.error('Failed to rename category:', error);
    throw error;
  }
}

/**
 * Get template by ID
 * @param {string|number} id - Template ID
 * @returns {Promise<Object|null>} - Template object or null
 */
export async function getTemplateById(id) {
  try {
    const template = await db.templates.get(id);
    return template || null;
  } catch (error) {
    console.error('Failed to get template by ID:', error);
    return null;
  }
}

/**
 * Available icon names for templates
 */
export const availableIcons = [
  'Bug',
  'CheckSquare',
  'ShieldAlert',
  'Lock',
  'FileText',
  'AlertCircle',
  'Zap',
  'Star',
  'Bookmark',
  'Flag',
  'Target',
  'AlertTriangle',
];
