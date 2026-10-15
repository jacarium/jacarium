# How to Add a New Page

Simple step-by-step guide to add a new page to Jacarium.

## Steps

### 1. Create Page Component

Create a new file: `src/components/YourPage.jsx`

```jsx
export default function YourPage() {
  return (
    <div className="h-full flex flex-col bg-os-background">
      <div className="flex-1 overflow-auto p-6">
        <h1 className="text-2xl font-bold text-os-text-primary mb-4">
          Your Page Title
        </h1>
        
        <div className="max-w-4xl">
          {/* Your page content here */}
          <p className="text-os-text-secondary">
            Your page content goes here...
          </p>
        </div>
      </div>
    </div>
  );
}
```

### 2. Import Page in JQLBuilder

Open `src/components/JQLBuilder.jsx`:

**Add import at the top:**
```javascript
import YourPage from './YourPage';
```

### 3. Add Page to Render Logic

In `JQLBuilder.jsx`, find the section where pages are rendered (around line 1230):

**Add your page condition:**
```javascript
{currentPage === 'your-page' ? (
  <YourPage />
) : currentPage === 'documents' ? (
  <DocumentsPage ... />
) : currentPage === 'calendars' ? (
  // ... other pages
```

### 4. Add Navigation Item

Open `src/components/CompactSidebar.jsx`:

**Import icon at the top:**
```javascript
import { YourIcon } from 'lucide-react';
```

**Add to navItems array (around line 777):**
```javascript
const navItems = [
  { icon: FileText, label: 'Documents', page: 'documents' },
  { icon: Calendar, label: 'Calendars', page: 'calendars' },
  { icon: YourIcon, label: 'Your Page', page: 'your-page' },  // Add this
  // ... rest of items
];
```

### 5. Done!

Your page is now accessible from the sidebar navigation.

## Tips

### Page with State Management

```jsx
import { useState } from 'react';

export default function YourPage() {
  const [data, setData] = useState([]);
  
  return (
    <div className="h-full flex flex-col bg-os-background">
      {/* ... */}
    </div>
  );
}
```

### Page with Database Access

```jsx
import { useEffect, useState } from 'react';
import { db } from '../db/database';

export default function YourPage() {
  const [items, setItems] = useState([]);
  
  useEffect(() => {
    async function loadData() {
      const data = await db.yourTable.toArray();
      setItems(data);
    }
    loadData();
  }, []);
  
  return (
    <div className="h-full flex flex-col bg-os-background">
      {/* ... */}
    </div>
  );
}
```

### Page with Navigation Handler

Some pages need to handle navigation (like returning to a different page):

```jsx
export default function YourPage({ onNavigate }) {
  const handleGoBack = () => {
    if (onNavigate) {
      onNavigate('documents');
    }
  };
  
  return (
    <div className="h-full flex flex-col bg-os-background">
      <button onClick={handleGoBack}>Go Back</button>
      {/* ... */}
    </div>
  );
}
```

Then in `JQLBuilder.jsx`:
```javascript
{currentPage === 'your-page' ? (
  <YourPage onNavigate={handlePageChange} />
) : ...
```

### Open Page in External Window

To allow your page to open in an external window (like Tools/Diagnostics/Search):

**In `src/App.jsx`**, add a standalone check:
```javascript
// Standalone YourPage window
if (standalone === 'your-page') {
  return (
    <ThemeProvider>
      <NotificationProvider>
        <div className="h-screen w-screen overflow-hidden bg-os-background">
          <YourPage />
        </div>
        <ToastNotifications />
      </NotificationProvider>
    </ThemeProvider>
  );
}
```

**In `CompactSidebar.jsx`**, add context menu handling (see Tools/Diagnostics examples around line 800+).

## Icons

Find icons at: https://lucide.dev/icons/

Common page icons:
- `FileText` - Documents, Text
- `Calendar` - Calendar, Events
- `Trello` - Kanban, Boards
- `CheckSquare` - Tasks, Todos
- `Workflow` - Workflows, Processes
- `Activity` - Diagnostics, Stats
- `Search` - Search, Query
- `Wrench` - Tools, Settings

## Examples

Check these existing pages for reference:
- `src/components/DocumentsPage.jsx` - Complex page with DB
- `src/components/CalendarsPage.jsx` - Page with state
- `src/components/ToolsPage.jsx` - Page with categories
- `src/components/DiagnosticsPage.jsx` - Page with navigation handler
