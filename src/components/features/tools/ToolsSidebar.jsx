import { useState, useMemo } from 'react';
import { Wrench, Search } from 'lucide-react';
import SidebarHeader from '../../common/sidebar/SidebarHeader';
import CategoryList from '../../common/sidebar/CategoryList';

/**
 * ToolsSidebar - Sidebar with categorized tools list
 *
 * Shows tools organized by category with expand/collapse functionality
 */
export default function ToolsSidebar({
  tools = [],
  categories = [],
  activeTool,
  openTabs = [],
  expandedCategories = [],
  onSelectTool,
  onToggleCategory,
  loading = false
}) {
  const [searchQuery, setSearchQuery] = useState('');

  // Filter tools by search query — match name and description (tool descriptions
  // are short keyword-rich strings, e.g. "Calculate MD5, SHA1, SHA256 hashes")
  const filteredTools = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return tools.filter(tool =>
      tool.name.toLowerCase().includes(query) ||
      (tool.description || '').toLowerCase().includes(query)
    );
  }, [tools, searchQuery]);

  // Auto-expand categories with search results (same behavior as DocumentSidebar)
  const effectiveExpandedCategories = searchQuery.trim()
    ? Array.from(new Set(filteredTools.map(tool => tool.category)))
    : expandedCategories;

  // Get tools by category (from the search-filtered list)
  const getToolsByCategory = (categoryName) => {
    return filteredTools.filter(tool => tool.category === categoryName);
  };

  return (
    <div className="h-full flex flex-col bg-os-card border-r border-os-border">
      {/* Header */}
      <SidebarHeader
        title="Tools"
        icon={Wrench}
      />

      {/* Tools List */}
      <div className="flex-1 overflow-y-auto bg-os-card">
        {/* Search — sticky inside the scroll container; the wrapper band is transparent so
            list content stays visible around the pill, while the opaque pill occludes it */}
        <div className="sticky top-0 z-10 px-3 pt-2 pb-2 pointer-events-none">
          <div className="relative pointer-events-auto">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-os-text-muted pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tools..."
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-full border border-os-input-border bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted shadow-md outline-hidden focus:border-os-blue focus:ring-2 focus:ring-os-blue transition-all"
            />
          </div>
        </div>
        {categories.length === 0 && !loading ? (
          <div className="p-4 text-center text-sm text-os-text-muted">
            No tools available
          </div>
        ) : searchQuery.trim() && filteredTools.length === 0 ? (
          <div className="p-8 text-center text-xs text-os-text-muted">
            No tools match your search
          </div>
        ) : (
          <CategoryList
            categories={categories}
            items={filteredTools}
            getItemsByCategory={getToolsByCategory}
            expandedCategories={effectiveExpandedCategories}
            onToggleCategory={onToggleCategory}
            showEmptyCategories={false}
            sortCategories={(a, b) => a.localeCompare(b)}
            itemListProps={{
              renderItem: (tool) => {
                const isActive = activeTool === tool.id;
                const Icon = tool.icon;

                return (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Icon
                        size={14}
                        className={`shrink-0 ${
 isActive ?'text-os-blue':'text-os-text-muted'
 }`}
                      />
                      <span className={`text-sm truncate ${
 isActive ?'text-os-blue':'text-os-text-primary'
 }`}>
                        {tool.name}
                      </span>
                    </div>
                  </div>
                );
              },
              getItemClassName: (tool) => {
                const isActive = activeTool === tool.id;
                const isOpen = openTabs.includes(tool.id);

                return `
                  group relative px-4 py-3 cursor-pointer transition-colors border-l-4
                  ${
                    isActive
                      ? 'bg-os-blue/10 border-os-blue'
                      : isOpen
                      ? 'border-transparent hover:bg-os-card-secondary'
                      : 'border-transparent hover:bg-os-card-secondary'
                  }
                `;
              },
              onItemClick: (tool) => onSelectTool(tool.id),
              isItemActive: (tool) => activeTool === tool.id,
            }}
          />
        )}
      </div>
    </div>
  );
}
