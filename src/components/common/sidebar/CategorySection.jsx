import { useState } from 'react';
import { ChevronRight, Cloud } from 'lucide-react';
import InlineEdit from '../inputs/InlineEdit';
import ItemList from './ItemList';
import { getCategoryIcon } from '../../../utils/categoryIcons';

/**
 * CategorySection - Collapsible category with items
 *
 * Features:
 * - Collapsible header with chevron
 * - Item count badge
 * - Inline category rename
 * - Context menu support
 * - Drag and drop target
 * - Item list rendering
 *
 * @param {string} categoryName - Category name
 * @param {array} items - Items in this category
 * @param {boolean} isExpanded - Whether category is expanded
 * @param {function} onToggle - Toggle expansion
 * @param {function} onRename - Rename callback (newName)
 * @param {function} onContextMenu - Context menu handler
 * @param {boolean} isEditing - Whether category is being renamed
 * @param {function} onEditingChange - Editing state change callback
 * @param {boolean} isDragOver - Drag over state
 * @param {function} onDragOver - Drag over handler
 * @param {function} onDragLeave - Drag leave handler
 * @param {function} onDrop - Drop handler
 * @param {object} itemListProps - Props to pass to ItemList
 * @param {string} className - Additional CSS classes
 */
export default function CategorySection({
  categoryName,
  items = [],
  isExpanded,
  onToggle,
  onRename,
  onContextMenu,
  isEditing = false,
  onEditingChange,
  isDragOver = false,
  onDragOver,
  onDragLeave,
  onDrop,
  itemListProps = {},
  className = '',
  isCloudCategory = false,
  categoryIcon = null,  // Icon name (e.g., 'briefcase', 'robot')
}) {
  const [isHovered, setIsHovered] = useState(false);
  const handleCategoryClick = () => {
    if (!isEditing && onToggle) {
      onToggle();
    }
  };

  const handleContextMenu = (e) => {
    if (onContextMenu) {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(categoryName, e);
    }
  };

  return (
    <div className={className}>
      {/* Category Header */}
      <div
        className={`
 px-2 py-2 transition-colors
 ${isDragOver ?'bg-os-blue/20':'hover:bg-os-card-secondary'}
`}
        onContextMenu={handleContextMenu}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div
          className="flex items-center gap-2"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {/* Icon or Chevron */}
          <button
            onClick={handleCategoryClick}
            className="p-0.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {!isHovered && categoryIcon ? (
              (() => {
                const Icon = getCategoryIcon(categoryIcon);
                return Icon ? <Icon size={14} className="text-os-text-secondary" /> : (
                  <ChevronRight
                    size={14}
                    className={`text-os-text-muted transition-transform ${
 isExpanded ?'rotate-90':''
 }`}
                  />
                );
              })()
            ) : (
              <ChevronRight
                size={14}
                className={`text-os-text-muted transition-transform ${
 isExpanded ?'rotate-90':''
 }`}
              />
            )}
          </button>

          {/* Category Name */}
          {isEditing ? (
            <InlineEdit
              value={categoryName}
              onSave={onRename}
              onCancel={() => onEditingChange && onEditingChange(false)}
              isEditing={true}
              onEditingChange={onEditingChange}
              className="flex-1"
              inputClassName="text-sm"
            />
          ) : (
            <button
              onClick={handleCategoryClick}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (onEditingChange) {
                  onEditingChange(true);
                }
              }}
              className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {isCloudCategory && (
                  <Cloud size={12} className="text-purple-600 shrink-0" />
                )}
                <span className={`text-sm font-medium truncate ${isCloudCategory ?'text-purple-700':'text-os-text-primary'}`}>
                  {categoryName}
                </span>
              </div>
              <span className="text-xs text-os-text-muted shrink-0">
                {items.length}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Items */}
      {isExpanded && (
        <ItemList items={items} {...itemListProps} />
      )}
    </div>
  );
}

/**
 * CategorySectionHeader - Standalone category header (without items)
 * Useful for custom layouts
 */
export function CategorySectionHeader({
  categoryName,
  itemCount = 0,
  isExpanded,
  onToggle,
  onContextMenu,
  isEditing = false,
  onRename,
  onEditingChange,
  isDragOver = false,
  className = '',
}) {
  const handleCategoryClick = () => {
    if (!isEditing && onToggle) {
      onToggle();
    }
  };

  const handleContextMenu = (e) => {
    if (onContextMenu) {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(categoryName, e);
    }
  };

  return (
    <div
      className={`
 px-2 py-2 transition-colors
 ${isDragOver ?'bg-os-blue/20':'hover:bg-os-card-secondary'}
 ${className}
`}
      onContextMenu={handleContextMenu}
    >
      <div className="flex items-center gap-2">
        {/* Chevron */}
        <button
          onClick={handleCategoryClick}
          className="p-0.5 hover:bg-os-card-secondary rounded-sm transition-colors"
        >
          <ChevronRight
            size={14}
            className={`text-os-text-muted transition-transform ${
 isExpanded ?'rotate-90':''
 }`}
          />
        </button>

        {/* Name */}
        {isEditing ? (
          <InlineEdit
            value={categoryName}
            onSave={onRename}
            onCancel={() => onEditingChange && onEditingChange(false)}
            isEditing={true}
            onEditingChange={onEditingChange}
            className="flex-1"
            inputClassName="text-sm"
          />
        ) : (
          <button
            onClick={handleCategoryClick}
            className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left"
          >
            <span className="text-sm text-os-text-primary font-medium truncate">
              {categoryName}
            </span>
            <span className="text-xs text-os-text-muted shrink-0">{itemCount}</span>
          </button>
        )}
      </div>
    </div>
  );
}
