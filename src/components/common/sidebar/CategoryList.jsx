import CategorySection from './CategorySection';
import { FolderOpen } from 'lucide-react';

/**
 * CategoryList - List of collapsible categories
 *
 * Features:
 * - Renders multiple categories
 * - Groups items by category
 * - Forwards all category/item interactions
 * - Empty state support
 * - Sorting support
 *
 * @param {array} categories - Array of category names
 * @param {array} items - All items (will be grouped by category)
 * @param {function} getItemsByCategory - Function to filter items by category
 * @param {array} expandedCategories - Array of expanded category names
 * @param {function} onToggleCategory - Toggle category expansion (categoryName)
 * @param {function} onRenameCategory - Rename category (oldName, newName)
 * @param {function} onCategoryContextMenu - Category context menu (categoryName, event)
 * @param {string} editingCategory - Currently editing category name
 * @param {function} onEditingCategoryChange - Editing category change callback
 * @param {object} itemListProps - Props to forward to ItemList in each category
 * @param {string} emptyMessage - Message when no categories
 * @param {function} sortCategories - Custom sort function (default: alphabetical)
 * @param {boolean} showEmptyCategories - Show categories even if they have no items (default: false)
 * @param {string} className - Additional CSS classes
 */
export default function CategoryList({
  categories = [],
  items = [],
  getItemsByCategory,
  expandedCategories = [],
  onToggleCategory,
  onRenameCategory,
  onCategoryContextMenu,
  editingCategory = null,
  onEditingCategoryChange,
  categoryProps,
  itemListProps = {},
  emptyMessage = 'No categories',
  sortCategories,
  showEmptyCategories = false,
  className = '',
}) {
  // Default: get items by category using filter
  const defaultGetItemsByCategory = (categoryName) => {
    return items.filter(item => (item.category || 'General') === categoryName);
  };

  const getItems = getItemsByCategory || defaultGetItemsByCategory;

  // Categories are identified by name (React key, expanded state, callbacks),
  // so a repeated name is one category, not two: rendering it twice gives
  // two headers that toggle together and leaks orphan rows on every reorder.
  const uniqueCategories = [...new Set(categories)];

  // Sort categories if sort function provided
  const sortedCategories = sortCategories
    ? uniqueCategories.sort(sortCategories)
    : uniqueCategories;

  if (sortedCategories.length === 0) {
    return (
      <div className="p-8 text-center">
        <FolderOpen size={48} className="text-os-text-muted mx-auto mb-3 opacity-50" />
        <p className="text-sm text-os-text-secondary">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={className}>
      {sortedCategories.map(categoryName => {
        const categoryItems = getItems(categoryName);
        const isExpanded = expandedCategories.includes(categoryName);
        const isEditing = editingCategory === categoryName;

        // Skip empty categories unless showEmptyCategories is enabled
        if (categoryItems.length === 0 && !showEmptyCategories) {
          return null;
        }

        // Get category-specific props if provided
        const extraCategoryProps = categoryProps ? categoryProps(categoryName) : {};

        return (
          <CategorySection
            key={categoryName}
            categoryName={categoryName}
            items={categoryItems}
            isExpanded={isExpanded}
            onToggle={() => onToggleCategory && onToggleCategory(categoryName)}
            onRename={(newName) => onRenameCategory && onRenameCategory(categoryName, newName)}
            onContextMenu={onCategoryContextMenu}
            isEditing={isEditing}
            onEditingChange={(editing) => {
              if (onEditingCategoryChange) {
                onEditingCategoryChange(editing ? categoryName : null);
              }
            }}
            itemListProps={itemListProps}
            {...extraCategoryProps}
          />
        );
      })}
    </div>
  );
}
