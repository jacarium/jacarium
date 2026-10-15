// Engine Templates Storage
// Manages search URL templates with placeholders for error messages
// Now uses the main Jacarium Dexie database

import { db } from '../db/database';

// Get all engine templates
export async function getEngineTemplates() {
  try {
    return await db.engineTemplates.toArray();
  } catch (error) {
    console.error('Error getting engine templates:', error);
    return [];
  }
}

// Get a single engine template by ID
export async function getEngineTemplate(id) {
  try {
    return await db.engineTemplates.get(id);
  } catch (error) {
    console.error('Error getting engine template:', error);
    return null;
  }
}

// Create a new engine template
export async function createEngineTemplate(template) {
  try {
    const templateData = {
      name: template.name,
      urlTemplate: template.urlTemplate,
      category: template.category || 'General',
      description: template.description || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const id = await db.engineTemplates.add(templateData);
    return id;
  } catch (error) {
    console.error('Error creating engine template:', error);
    throw error;
  }
}

// Update an existing engine template
export async function updateEngineTemplate(id, updates) {
  try {
    const template = await db.engineTemplates.get(id);
    if (!template) {
      throw new Error('Template not found');
    }

    const updatedTemplate = {
      ...template,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    await db.engineTemplates.put(updatedTemplate);
    return updatedTemplate;
  } catch (error) {
    console.error('Error updating engine template:', error);
    throw error;
  }
}

// Delete an engine template
export async function deleteEngineTemplate(id) {
  try {
    await db.engineTemplates.delete(id);
  } catch (error) {
    console.error('Error deleting engine template:', error);
    throw error;
  }
}

// Get all unique categories
export async function getEngineCategories() {
  try {
    const templates = await getEngineTemplates();
    const categories = [...new Set(templates.map(t => t.category || 'General'))];
    return categories.sort();
  } catch (error) {
    console.error('Error getting engine categories:', error);
    return [];
  }
}

// Rename a category
export async function renameEngineCategory(oldName, newName) {
  try {
    const templates = await getEngineTemplates();
    const templatesToUpdate = templates.filter(t => t.category === oldName);

    for (const template of templatesToUpdate) {
      await updateEngineTemplate(template.id, { category: newName });
    }
  } catch (error) {
    console.error('Error renaming engine category:', error);
    throw error;
  }
}

// Search engine templates
export async function searchEngineTemplates(query) {
  try {
    const templates = await getEngineTemplates();
    const lowerQuery = query.toLowerCase();

    return templates.filter(t =>
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description?.toLowerCase().includes(lowerQuery) ||
      t.category?.toLowerCase().includes(lowerQuery)
    );
  } catch (error) {
    console.error('Error searching engine templates:', error);
    return [];
  }
}
