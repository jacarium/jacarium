import { useState, useCallback, useEffect } from 'react';

/**
 * Custom hook for managing templates (JQL, documents, search engines, etc.)
 * @param {object} options - Configuration options
 * @returns {object} Template management state and functions
 */
export function useTemplates(options = {}) {
  const {
    loadFn,           // async function to load all templates
    createFn,         // async function to create a template
    updateFn,         // async function to update a template
    deleteFn,         // async function to delete a template
    getCategoriesFn,  // async function to get categories
    renameCategoryFn, // async function to rename a category
    initialLoad = true, // auto-load on mount
  } = options;

  const [templates, setTemplates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Load all templates
   */
  const loadTemplates = useCallback(async () => {
    if (!loadFn) return;

    try {
      setLoading(true);
      setError(null);
      const data = await loadFn();
      setTemplates(data || []);

      // Load categories if function provided
      if (getCategoriesFn) {
        const cats = await getCategoriesFn();
        setCategories(cats || []);
      }
    } catch (err) {
      console.error('Failed to load templates:', err);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [loadFn, getCategoriesFn]);

  /**
   * Create a new template
   */
  const createTemplate = useCallback(async (templateData) => {
    if (!createFn) {
      throw new Error('Create function not provided');
    }

    try {
      setLoading(true);
      setError(null);
      const result = await createFn(templateData);
      await loadTemplates();
      return result;
    } catch (err) {
      console.error('Failed to create template:', err);
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [createFn, loadTemplates]);

  /**
   * Update an existing template
   */
  const updateTemplate = useCallback(async (templateId, updates) => {
    if (!updateFn) {
      throw new Error('Update function not provided');
    }

    try {
      setLoading(true);
      setError(null);
      const result = await updateFn(templateId, updates);
      await loadTemplates();
      return result;
    } catch (err) {
      console.error('Failed to update template:', err);
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [updateFn, loadTemplates]);

  /**
   * Delete a template
   */
  const deleteTemplate = useCallback(async (templateId) => {
    if (!deleteFn) {
      throw new Error('Delete function not provided');
    }

    try {
      setLoading(true);
      setError(null);
      await deleteFn(templateId);
      await loadTemplates();
    } catch (err) {
      console.error('Failed to delete template:', err);
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [deleteFn, loadTemplates]);

  /**
   * Delete multiple templates
   */
  const deleteTemplates = useCallback(async (templateIds) => {
    if (!deleteFn) {
      throw new Error('Delete function not provided');
    }

    try {
      setLoading(true);
      setError(null);

      for (const id of templateIds) {
        await deleteFn(id);
      }

      await loadTemplates();
    } catch (err) {
      console.error('Failed to delete templates:', err);
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [deleteFn, loadTemplates]);

  /**
   * Duplicate a template
   */
  const duplicateTemplate = useCallback(async (template) => {
    if (!createFn) {
      throw new Error('Create function not provided');
    }

    try {
      setLoading(true);
      setError(null);

      // Create copy with modified name
      const copy = {
        ...template,
        name: `${template.name} (Copy)`,
      };

      // Remove id if present
      delete copy.id;
      delete copy.createdAt;
      delete copy.updatedAt;

      const result = await createFn(copy);
      await loadTemplates();
      return result;
    } catch (err) {
      console.error('Failed to duplicate template:', err);
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [createFn, loadTemplates]);

  /**
   * Rename a category
   */
  const renameCategory = useCallback(async (oldName, newName) => {
    if (!renameCategoryFn) {
      throw new Error('Rename category function not provided');
    }

    try {
      setLoading(true);
      setError(null);
      await renameCategoryFn(oldName, newName);
      await loadTemplates();
    } catch (err) {
      console.error('Failed to rename category:', err);
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [renameCategoryFn, loadTemplates]);

  /**
   * Get templates by category
   */
  const getTemplatesByCategory = useCallback((categoryName) => {
    return templates.filter(t => (t.category || 'General') === categoryName);
  }, [templates]);

  /**
   * Get template by ID
   */
  const getTemplateById = useCallback((templateId) => {
    return templates.find(t => t.id === templateId);
  }, [templates]);

  /**
   * Search templates
   */
  const searchTemplates = useCallback((query) => {
    const lowerQuery = query.toLowerCase();
    return templates.filter(t =>
      t.name?.toLowerCase().includes(lowerQuery) ||
      t.description?.toLowerCase().includes(lowerQuery) ||
      t.category?.toLowerCase().includes(lowerQuery)
    );
  }, [templates]);

  /**
   * Change template category (bulk operation)
   */
  const changeTemplatesCategory = useCallback(async (templateIds, newCategory) => {
    if (!updateFn) {
      throw new Error('Update function not provided');
    }

    try {
      setLoading(true);
      setError(null);

      for (const id of templateIds) {
        await updateFn(id, { category: newCategory });
      }

      await loadTemplates();
    } catch (err) {
      console.error('Failed to change templates category:', err);
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [updateFn, loadTemplates]);

  // Auto-load on mount if enabled
  useEffect(() => {
    if (initialLoad && loadFn) {
      // Intentional external-system sync in an effect; the setState here is
      // the subscription/measurement result, not derived render state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadTemplates();
    }
  }, [initialLoad, loadFn, loadTemplates]);

  return {
    // State
    templates,
    categories,
    loading,
    error,

    // CRUD operations
    loadTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    deleteTemplates,
    duplicateTemplate,

    // Category operations
    renameCategory,
    changeTemplatesCategory,

    // Query operations
    getTemplatesByCategory,
    getTemplateById,
    searchTemplates,

    // Direct state setters (for advanced use)
    setTemplates,
    setCategories,
  };
}

/**
 * Hook for managing template modal state
 * @returns {object} Modal state and functions
 */
export function useTemplateModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);

  const openCreate = useCallback(() => {
    setEditingTemplate(null);
    setIsOpen(true);
  }, []);

  const openEdit = useCallback((template) => {
    setEditingTemplate(template);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setEditingTemplate(null);
  }, []);

  const isEditing = Boolean(editingTemplate);

  return {
    isOpen,
    editingTemplate,
    isEditing,
    openCreate,
    openEdit,
    close,
  };
}

/**
 * Hook for managing template deletion confirmation
 * @returns {object} Delete confirmation state and functions
 */
export function useTemplateDelete() {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState(null);
  const [templatesToDelete, setTemplatesToDelete] = useState([]);

  const confirmDelete = useCallback((template) => {
    setTemplateToDelete(template);
    setTemplatesToDelete([]);
    setShowDeleteModal(true);
  }, []);

  const confirmBulkDelete = useCallback((templates) => {
    setTemplateToDelete(null);
    setTemplatesToDelete(templates);
    setShowDeleteModal(true);
  }, []);

  const cancelDelete = useCallback(() => {
    setShowDeleteModal(false);
    setTemplateToDelete(null);
    setTemplatesToDelete([]);
  }, []);

  const isBulkDelete = templatesToDelete.length > 0;

  return {
    showDeleteModal,
    templateToDelete,
    templatesToDelete,
    isBulkDelete,
    confirmDelete,
    confirmBulkDelete,
    cancelDelete,
  };
}
