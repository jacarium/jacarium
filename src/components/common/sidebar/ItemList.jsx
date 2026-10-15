import { CheckSquare, Lock, EyeOff } from 'lucide-react';
import { ListRow } from './ListRow';

/**
 * ItemList - Generic list of items
 *
 * Features:
 * - Item rendering with icons, badges
 * - Selection support (checkbox or highlight)
 * - Active/focused states
 * - Context menu support
 * - Drag and drop support
 * - Status indicators (locked, hidden, etc.)
 *
 * @param {array} items - Array of items to display
 * @param {function} renderItem - Custom render function (item, options) => ReactNode
 * @param {function} onItemClick - Click handler (item, event)
 * @param {function} onItemContextMenu - Context menu handler (item, event)
 * @param {function} isItemActive - Function to check if item is active
 * @param {function} isItemSelected - Function to check if item is selected
 * @param {boolean} selectionMode - Enable selection mode
 * @param {boolean} showCheckboxes - Show checkboxes in selection mode
 * @param {string} emptyMessage - Message when no items
 * @param {string} className - Additional CSS classes
 */
export default function ItemList({
  items = [],
  renderItem,
  onItemClick,
  onItemContextMenu,
  onItemDoubleClick,
  isItemActive = () => false,
  isItemSelected = () => false,
  isItemFocused = () => false,
  getItemClassName,
  getItemStyle,
  selectionMode = false,
  showCheckboxes = true,
  className = '',
  // Drag and drop
  draggable = false,
  onDragStart,
  onDragEnd,
}) {
  if (items.length === 0) {
    return null;
  }

  const handleItemClick = (item, e) => {
    if (onItemClick) {
      onItemClick(item, e);
    }
  };

  const handleItemContextMenu = (item, e) => {
    if (onItemContextMenu) {
      e.preventDefault();
      onItemContextMenu(item, e);
    }
  };

  const handleItemDoubleClick = (item, e) => {
    if (onItemDoubleClick) {
      onItemDoubleClick(item, e);
    }
  };

  return (
    <div className={`${className}`}>
      {items.map(item => {
        const isActive = isItemActive(item);
        const isSelected = isItemSelected(item);
        const isFocused = isItemFocused(item);

        // Default rendering if no custom render function
        const itemContent = renderItem
          ? renderItem(item, { isActive, isSelected, isFocused, selectionMode })
          : <DefaultItemRenderer item={item} />;

        // Custom or default className
        const itemClassName = getItemClassName
          ? getItemClassName(item, { isActive, isSelected, isFocused, selectionMode })
          : `
              group relative px-4 py-3 cursor-pointer transition-colors
              ${isActive ? 'bg-os-blue/10 border-l-4 border-os-blue' : ''}
              ${isSelected ? 'bg-os-blue/10 border-l-4 border-os-blue' : ''}
              ${isFocused ? 'ring-2 ring-os-blue ring-inset' : ''}
              ${!isActive && !isSelected ? 'hover:bg-os-card-secondary' : ''}
            `;

        // Custom or no style
        const itemStyle = getItemStyle
          ? getItemStyle(item, { isActive, isSelected, isFocused, selectionMode })
          : undefined;

        return (
          <ListRow
            key={item.id}
            draggable={draggable && !selectionMode}
            onDragStart={(e) => onDragStart && onDragStart(item, e)}
            onDragEnd={(e) => onDragEnd && onDragEnd(item, e)}
            onClick={(e) => handleItemClick(item, e)}
            onContextMenu={(e) => handleItemContextMenu(item, e)}
            onDoubleClick={(e) => handleItemDoubleClick(item, e)}
            className={itemClassName}
            style={itemStyle}
          >
            {/* Selection checkbox */}
            {selectionMode && showCheckboxes && (
              <div className="absolute left-2 top-1/2 -translate-y-1/2">
                <CheckSquare
                  size={16}
                  className={isSelected ?'text-os-blue':'text-os-text-muted'}
                />
              </div>
            )}

            {/* Content */}
            <div className={selectionMode && showCheckboxes ?'ml-6':''}>
              {itemContent}
            </div>
          </ListRow>
        );
      })}
    </div>
  );
}

/**
 * DefaultItemRenderer - Default item rendering
 */
function DefaultItemRenderer({ item }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {item.icon && (
          <span className="shrink-0 text-os-text-secondary">
            {item.icon}
          </span>
        )}
        <span className="text-sm text-os-text-primary truncate">
          {item.name || item.title}
        </span>
      </div>

      {/* Status indicators */}
      <div className="flex items-center gap-1 shrink-0">
        {item.locked && (
          <Lock size={12} className="text-os-text-muted" title="Locked" />
        )}
        {item.hidden && (
          <EyeOff size={12} className="text-os-text-muted" title="Hidden" />
        )}
        {item.badge && (
          <span className="px-1.5 py-0.5 text-xs bg-os-divider text-os-text-secondary rounded-sm">
            {item.badge}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * ItemListItem - Standalone item component for custom layouts
 */
export function ItemListItem({
  isActive = false,
  isSelected = false,
  isFocused = false,
  selectionMode = false,
  showCheckbox = true,
  onClick,
  onContextMenu,
  onDoubleClick,
  children,
  className = '',
}) {
  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      className={`
 group relative px-4 py-3 cursor-pointer transition-colors
 ${isActive ?'bg-os-blue/10 border-l-4 border-os-blue':''}
 ${isSelected ?'bg-os-blue/10 border-l-4 border-os-blue':''}
 ${isFocused ?'ring-2 ring-os-blue ring-inset':''}
 ${!isActive && !isSelected ?'hover:bg-os-card-secondary':''}
 ${className}
`}
    >
      {selectionMode && showCheckbox && (
        <div className="absolute left-2 top-1/2 -translate-y-1/2">
          <CheckSquare
            size={16}
            className={isSelected ?'text-os-blue':'text-os-text-muted'}
          />
        </div>
      )}

      <div className={selectionMode && showCheckbox ?'ml-6':''}>
        {children}
      </div>
    </div>
  );
}
