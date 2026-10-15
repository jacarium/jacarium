import { useState, useCallback } from 'react';
import { useSessionPersistence } from './useLocalStorage';

/**
 * Custom hook for managing category state and operations
 * @param {array} initialExpandedCategories - Initially expanded categories
 * @param {string} storageKey - Optional session storage key for persistence
 * @returns {object} Category management functions and state
 */
export function useCategories(initialExpandedCategories = [], storageKey = null) {
  // useSessionPersistence degrades to plain useState when storageKey is
  // null, so it can be called unconditionally (rules-of-hooks).
  const [expandedCategories, setExpandedCategories] =
    useSessionPersistence(storageKey, initialExpandedCategories);
  const [editingCategory, setEditingCategory] = useState(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');

  /**
   * Toggle category expansion state
   */
  const toggleCategory = useCallback((categoryName) => {
    setExpandedCategories(prev =>
      prev.includes(categoryName)
        ? prev.filter(c => c !== categoryName)
        : [...prev, categoryName]
    );
  }, [setExpandedCategories]);

  /**
   * Expand a specific category
   */
  const expandCategory = useCallback((categoryName) => {
    setExpandedCategories(prev =>
      prev.includes(categoryName) ? prev : [...prev, categoryName]
    );
  }, [setExpandedCategories]);

  /**
   * Collapse a specific category
   */
  const collapseCategory = useCallback((categoryName) => {
    setExpandedCategories(prev => prev.filter(c => c !== categoryName));
  }, [setExpandedCategories]);

  /**
   * Expand all categories
   */
  const expandAll = useCallback((categories) => {
    setExpandedCategories(categories);
  }, [setExpandedCategories]);

  /**
   * Collapse all categories
   */
  const collapseAll = useCallback(() => {
    setExpandedCategories([]);
  }, [setExpandedCategories]);

  /**
   * Check if a category is expanded
   */
  const isCategoryExpanded = useCallback((categoryName) => {
    return expandedCategories.includes(categoryName);
  }, [expandedCategories]);

  /**
   * Start editing a category name
   */
  const startEditingCategory = useCallback((categoryName) => {
    setEditingCategory(categoryName);
    setEditingCategoryName(categoryName);
  }, []);

  /**
   * Cancel category editing
   */
  const cancelEditingCategory = useCallback(() => {
    setEditingCategory(null);
    setEditingCategoryName('');
  }, []);

  /**
   * Update expanded categories after rename
   */
  const updateCategoryName = useCallback((oldName, newName) => {
    setExpandedCategories(prev =>
      prev.map(cat => cat === oldName ? newName : cat)
    );
  }, [setExpandedCategories]);

  /**
   * Remove a category from expanded list (e.g., after deletion)
   */
  const removeCategory = useCallback((categoryName) => {
    setExpandedCategories(prev => prev.filter(c => c !== categoryName));
  }, [setExpandedCategories]);

  /**
   * Get items by category
   */
  const getItemsByCategory = useCallback((items, categoryName) => {
    return items.filter(item => (item.category || 'General') === categoryName);
  }, []);

  /**
   * Get all unique categories from items
   */
  const getCategoriesFromItems = useCallback((items) => {
    const categoriesSet = new Set(items.map(item => item.category || 'General'));
    return Array.from(categoriesSet).sort();
  }, []);

  /**
   * Get count of items in a category
   */
  const getCategoryCount = useCallback((items, categoryName) => {
    return items.filter(item => (item.category || 'General') === categoryName).length;
  }, []);

  /**
   * Group items by category
   */
  const groupItemsByCategory = useCallback((items) => {
    const grouped = {};
    items.forEach(item => {
      const category = item.category || 'General';
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(item);
    });
    return grouped;
  }, []);

  return {
    // State
    expandedCategories,
    setExpandedCategories,
    editingCategory,
    editingCategoryName,
    setEditingCategoryName,

    // Category expansion functions
    toggleCategory,
    expandCategory,
    collapseCategory,
    expandAll,
    collapseAll,
    isCategoryExpanded,

    // Category editing functions
    startEditingCategory,
    cancelEditingCategory,
    updateCategoryName,
    removeCategory,

    // Category utility functions
    getItemsByCategory,
    getCategoriesFromItems,
    getCategoryCount,
    groupItemsByCategory,
  };
}

/**
 * Hook for managing multi-selection within categories
 * @returns {object} Selection management functions and state
 */
export function useCategorySelection() {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedItems, setSelectedItems] = useState([]);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode(prev => !prev);
    if (selectionMode) {
      setSelectedItems([]);
    }
  }, [selectionMode]);

  const toggleItemSelection = useCallback((itemId) => {
    setSelectedItems(prev =>
      prev.includes(itemId)
        ? prev.filter(id => id !== itemId)
        : [...prev, itemId]
    );
  }, []);

  const selectAll = useCallback((items) => {
    setSelectedItems(items.map(item => item.id));
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedItems([]);
  }, []);

  const isItemSelected = useCallback((itemId) => {
    return selectedItems.includes(itemId);
  }, [selectedItems]);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedItems([]);
  }, []);

  return {
    selectionMode,
    selectedItems,
    setSelectionMode,
    setSelectedItems,
    toggleSelectionMode,
    toggleItemSelection,
    selectAll,
    deselectAll,
    isItemSelected,
    exitSelectionMode,
  };
}
