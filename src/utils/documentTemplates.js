/**
 * Document Templates Manager
 * Manages document templates stored in IndexedDB using Dexie
 */

import { db } from '../db/database';

/**
 * Get all document templates from database
 * @returns {Promise<Array>} - Array of template objects
 */
export async function getDocumentTemplates() {
  try {
    const templates = await db.documentTemplates.orderBy('name').toArray();
    return templates;
  } catch (error) {
    console.error('Failed to get document templates:', error);
    return [];
  }
}

/**
 * Get a single document template by ID
 * @param {number} id - Template ID
 * @returns {Promise<Object|null>} - Template object or null
 */
export async function getDocumentTemplate(id) {
  try {
    const template = await db.documentTemplates.get(id);
    return template || null;
  } catch (error) {
    console.error('Failed to get document template:', error);
    return null;
  }
}

/**
 * Search document templates by tag
 * @param {string} tag - Tag to search for
 * @returns {Promise<Array>} - Array of matching template objects
 */
export async function searchDocumentTemplatesByTag(tag) {
  try {
    if (!tag || tag.trim() === '') {
      return await getDocumentTemplates();
    }

    const searchTag = tag.toLowerCase().trim();
    const templates = await db.documentTemplates
      .where('tags')
      .equals(searchTag)
      .toArray();

    return templates;
  } catch (error) {
    console.error('Failed to search document templates:', error);
    return [];
  }
}

/**
 * Search document templates by name, description, or tag
 * @param {string} query - Search query
 * @returns {Promise<Array>} - Array of matching template objects
 */
export async function searchDocumentTemplates(query) {
  try {
    if (!query || query.trim() === '') {
      return await getDocumentTemplates();
    }

    const searchQuery = query.toLowerCase().trim();
    const allTemplates = await db.documentTemplates.toArray();

    // Filter templates that match name, description, or any tag
    const matches = allTemplates.filter(template => {
      const nameMatch = template.name.toLowerCase().includes(searchQuery);
      const descriptionMatch = template.description && template.description.toLowerCase().includes(searchQuery);
      const tagMatch = template.tags && template.tags.some(tag =>
        tag.toLowerCase().includes(searchQuery)
      );
      return nameMatch || descriptionMatch || tagMatch;
    });

    return matches;
  } catch (error) {
    console.error('Failed to search document templates:', error);
    return [];
  }
}

/**
 * Create a new document template
 * @param {Object} template - Template object {name, content, tags, category, description}
 * @returns {Promise<Object>} - Created template object
 */
export async function createDocumentTemplate(template) {
  try {
    const newTemplate = {
      name: template.name || 'Untitled Template',
      content: template.content || '',
      tags: template.tags || [],
      category: template.category || 'General',
      description: template.description || '',
      updatedAt: Date.now(),
    };

    const id = await db.documentTemplates.add(newTemplate);
    newTemplate.id = id;

    return newTemplate;
  } catch (error) {
    console.error('Failed to create document template:', error);
    throw error;
  }
}

/**
 * Update an existing document template
 * @param {number} id - Template ID
 * @param {Object} updates - Updates to apply {name?, content?, tags?, category?}
 * @returns {Promise<Object|null>} - Updated template object or null
 */
export async function updateDocumentTemplate(id, updates) {
  try {
    const existing = await db.documentTemplates.get(id);

    if (!existing) {
      console.error('Document template not found:', id);
      return null;
    }

    const updated = {
      ...existing,
      ...updates,
      id, // Preserve ID
      updatedAt: Date.now(),
    };

    await db.documentTemplates.put(updated);
    return updated;
  } catch (error) {
    console.error('Failed to update document template:', error);
    return null;
  }
}

/**
 * Delete a document template
 * @param {number} id - Template ID
 * @returns {Promise<boolean>} - Success status
 */
export async function deleteDocumentTemplate(id) {
  try {
    await db.documentTemplates.delete(id);
    return true;
  } catch (error) {
    console.error('Failed to delete document template:', error);
    return false;
  }
}

/**
 * Get all template categories
 * @returns {Promise<Array<string>>} - Array of unique categories
 */
export async function getTemplateCategories() {
  try {
    const templates = await db.documentTemplates.toArray();
    const categories = [...new Set(templates.map(t => t.category || 'General'))];
    return categories.sort();
  } catch (error) {
    console.error('Failed to get template categories:', error);
    return ['General'];
  }
}

/**
 * Rename a template category
 * @param {string} oldName - Old category name
 * @param {string} newName - New category name
 * @returns {Promise<boolean>} - Success status
 */
export async function renameTemplateCategory(oldName, newName) {
  try {
    const templates = await db.documentTemplates
      .filter(t => t.category === oldName)
      .toArray();

    for (const template of templates) {
      await db.documentTemplates.update(template.id, { category: newName });
    }

    return true;
  } catch (error) {
    console.error('Failed to rename template category:', error);
    return false;
  }
}
