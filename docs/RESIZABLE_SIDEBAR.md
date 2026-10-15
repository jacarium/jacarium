# How to Add a Resizable Sidebar

Step-by-step guide to add a resizable sidebar with categorized lists to your page.

## Overview

Most pages in Jacarium use a resizable sidebar pattern:
- Tools Page - tools organized by category
- Documents Page - documents and templates
- Calendars Page - calendars by type

This guide shows you how to implement the same pattern.

## Structure

```
Page Component
├── ResizableSidebar (wrapper with resize handle)
│   └── YourSidebar (custom sidebar content)
│       ├── SidebarHeader
│       └── CategoryList
│           └── CategorySection (for each category)
│               └── ItemList (items in category)
└── Main Content Area
```

## Step 1: Create Your Page Component

Create `src/components/YourPage.jsx`:

```jsx
import { useState, useEffect } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import ResizableSidebar from './ResizableSidebar';
import YourSidebar from './features/yourfeature/YourSidebar';
import { YourIcon } from 'lucide-react';

export default function YourPage() {
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [activeItem, setActiveItem] = useState(null);
  const [expandedCategories, setExpandedCategories] = useLocalStorage('expandedYourCategories', []);
  
  // Load data on mount
  useEffect(() => {
    async function loadData() {
      // Load your items and categories from database or API
      const loadedItems = []; // Your data loading logic
      const loadedCategories = []; // Your categories
      setItems(loadedItems);
      setCategories(loadedCategories);
    }
    loadData();
  }, []);

  // Select item
  const handleSelectItem = (itemId) => {
    setActiveItem(itemId);
  };

  // Toggle category
  const handleToggleCategory = (categoryName) => {
    setExpandedCategories(prev => {
      if (prev.includes(categoryName)) {
        return prev.filter(name => name !== categoryName);
      } else {
        return [...prev, categoryName];
      }
    });
  };

  return (
    <div className="flex h-full bg-os-background">
      {/* Resizable Sidebar */}
      <ResizableSidebar
        defaultWidth={280}
        minWidth={200}
        maxWidth={500}
        storageKey="your-sidebar-width"
        position="right"
      >
        <YourSidebar
          items={items}
          categories={categories}
          activeItem={activeItem}
          expandedCategories={expandedCategories}
          onSelectItem={handleSelectItem}
          onToggleCategory={handleToggleCategory}
        />
      </ResizableSidebar>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeItem ? (
          <div className="flex-1 overflow-auto p-6">
            <h2 className="text-xl font-bold text-os-text-primary">
              {items.find(i => i.id === activeItem)?.name}
            </h2>
            {/* Your content here */}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <YourIcon size={64} className="text-os-text-muted mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-os-text-primary mb-2">
                No Item Selected
              </h2>
              <p className="text-sm text-os-text-secondary">
                Select an item from the sidebar
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

## Step 2: Create Your Sidebar Component

Create `src/components/features/yourfeature/YourSidebar.jsx`:

```jsx
import { YourIcon } from 'lucide-react';
import SidebarHeader from '../../common/sidebar/SidebarHeader';
import CategoryList from '../../common/sidebar/CategoryList';

export default function YourSidebar({
  items = [],
  categories = [],
  activeItem,
  expandedCategories = [],
  onSelectItem,
  onToggleCategory,
}) {
  // Get items by category
  const getItemsByCategory = (categoryName) => {
    return items.filter(item => item.category === categoryName);
  };

  return (
    <div className="h-full flex flex-col bg-os-card border-r border-os-border">
      {/* Header */}
      <SidebarHeader
        title="Your Items"
        icon={YourIcon}
      />

      {/* Items List */}
      <div className="flex-1 overflow-y-auto bg-os-card">
        {categories.length === 0 ? (
          <div className="p-4 text-center text-sm text-os-text-muted">
            No items available
          </div>
        ) : (
          <CategoryList
            categories={categories}
            items={items}
            getItemsByCategory={getItemsByCategory}
            expandedCategories={expandedCategories}
            onToggleCategory={onToggleCategory}
            sortCategories={(a, b) => a.localeCompare(b)}
            itemListProps={{
              renderItem: (item) => {
                const isActive = activeItem === item.id;
                const Icon = item.icon || YourIcon;

                return (
                  <div className="flex items-center gap-2">
                    <Icon
                      size={14}
                      className={isActive ? 'text-os-blue' : 'text-os-text-muted'}
                    />
                    <span className={`text-sm truncate ${
                      isActive ? 'text-os-blue font-medium' : 'text-os-text-primary'
                    }`}>
                      {item.name}
                    </span>
                  </div>
                );
              },
              getItemClassName: (item) => {
                const isActive = activeItem === item.id;
                return `
                  px-4 py-3 cursor-pointer transition-colors border-l-4
                  ${
                    isActive
                      ? 'bg-os-blue bg-opacity-10 border-os-blue'
                      : 'border-transparent hover:bg-os-card-secondary'
                  }
                `;
              },
              onItemClick: (item) => onSelectItem(item.id),
              isItemActive: (item) => activeItem === item.id,
            }}
          />
        )}
      </div>
    </div>
  );
}
```

## Step 3: Register Your Page

Follow the [How to Add a New Page](./HOW_TO_ADD_PAGE.md) guide to register your page in the app.

## ResizableSidebar Props

```javascript
<ResizableSidebar
  defaultWidth={280}        // Initial width in pixels
  minWidth={200}            // Minimum width
  maxWidth={500}            // Maximum width
  storageKey="unique-key"   // localStorage key for persistence
  position="right"          // "left" or "right" - where resize handle appears
>
  {/* Your sidebar content */}
</ResizableSidebar>
```

## CategoryList Props

```javascript
<CategoryList
  categories={categories}                    // Array of category names
  items={items}                              // All items
  getItemsByCategory={getItemsByCategory}    // Filter function
  expandedCategories={expandedCategories}    // Array of expanded categories
  onToggleCategory={onToggleCategory}        // Toggle callback
  sortCategories={(a, b) => a.localeCompare(b)}  // Sort function
  showEmptyCategories={false}                // Show empty categories?
  itemListProps={{                           // Item rendering props
    renderItem: (item) => { /* JSX */ },     // How to render each item
    getItemClassName: (item) => "...",       // Item CSS classes
    onItemClick: (item) => { },              // Click handler
    isItemActive: (item) => boolean,         // Active state check
  }}
/>
```

## ItemListProps Details

### renderItem

Returns JSX for the item content:

```jsx
renderItem: (item) => (
  <div className="flex items-center gap-2">
    <ItemIcon size={14} className="text-os-text-muted" />
    <span className="text-sm">{item.name}</span>
  </div>
)
```

### getItemClassName

Returns CSS classes for the item container:

```jsx
getItemClassName: (item) => {
  const isActive = activeItem === item.id;
  return `
    px-4 py-3 cursor-pointer border-l-4
    ${isActive 
      ? 'bg-os-blue bg-opacity-10 border-os-blue' 
      : 'border-transparent hover:bg-os-card-secondary'
    }
  `;
}
```

### onItemClick

Handles item clicks:

```jsx
onItemClick: (item) => setActiveItem(item.id)
```

### isItemActive

Checks if item is active:

```jsx
isItemActive: (item) => activeItem === item.id
```

## Adding Context Menus

For right-click menus on items:

```jsx
itemListProps={{
  onItemContextMenu: (item, event) => {
    event.preventDefault();
    setContextMenu({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      item: item
    });
  }
}}
```

Then render the context menu in your page component.

## Adding Search

To add search to your sidebar:

```jsx
<SidebarHeader
  title="Your Items"
  icon={YourIcon}
  showSearch={true}
  searchValue={searchQuery}
  onSearchChange={setSearchQuery}
  searchPlaceholder="Search items..."
/>
```

## Adding Action Buttons

To add action buttons to the header:

```jsx
<SidebarHeader
  title="Your Items"
  icon={YourIcon}
  actions={
    <button
      onClick={handleAddNew}
      className="p-1 rounded hover:bg-os-card-secondary"
    >
      <Plus size={16} className="text-os-text-secondary" />
    </button>
  }
/>
```

## Example: Simple Sidebar Without Categories

If you don't need categories:

```jsx
<div className="h-full flex flex-col bg-os-card border-r border-os-border">
  <SidebarHeader title="Items" icon={YourIcon} />
  
  <div className="flex-1 overflow-y-auto">
    {items.map(item => (
      <div
        key={item.id}
        onClick={() => onSelectItem(item.id)}
        className={`px-4 py-3 cursor-pointer border-l-4 ${
          activeItem === item.id
            ? 'bg-os-blue bg-opacity-10 border-os-blue'
            : 'border-transparent hover:bg-os-card-secondary'
        }`}
      >
        <span className="text-sm">{item.name}</span>
      </div>
    ))}
  </div>
</div>
```

## Common Patterns

### Persist Expanded Categories

```jsx
const [expandedCategories, setExpandedCategories] = useLocalStorage(
  'expandedYourCategories',
  []
);
```

### Persist Sidebar Width

The `storageKey` prop on `ResizableSidebar` handles this automatically.

### Persist Active Item

```jsx
const [activeItem, setActiveItem] = useLocalStorage('activeYourItem', null);
```

## Complete Examples

Check these pages for full implementations:
- `src/components/ToolsPage.jsx` - Tools with tabs
- `src/components/DocumentsPage.jsx` - Documents with split view
- `src/components/CalendarsPage.jsx` - Calendars by type

## Components Reference

- **ResizableSidebar**: `src/components/ResizableSidebar.jsx`
- **SidebarHeader**: `src/components/common/sidebar/SidebarHeader.jsx`
- **CategoryList**: `src/components/common/sidebar/CategoryList.jsx`
- **CategorySection**: `src/components/common/sidebar/CategorySection.jsx`
- **ItemList**: `src/components/common/sidebar/ItemList.jsx`
