import { useState } from 'react';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { NODE_CATEGORIES } from './workflowNodeCategories';
import { filterCategories } from './nodeSearch';

/** localStorage key for per-category collapse state (same mechanism as the sidebar width / nodeLibraryCollapsed). */
const EXPANDED_CATEGORIES_STORAGE_KEY = 'workflowNodeLibraryExpandedCategories';

export default function WorkflowNodeLibrary({ onDragStart, width = 288, isCollapsed = false, onCollapsedChange }) {
  // Only explicit choices are stored ({ [category]: boolean }); a category the
  // user never toggled stays open, and the choice survives navigation and
  // app restarts.
  const [expandedCategories, setExpandedCategories] = useLocalStorage(EXPANDED_CATEGORIES_STORAGE_KEY, {});
  const [filter, setFilter] = useState('');
  const filtering = filter.trim().length > 0;
  // While filtering, every matching category is open regardless of its
  // stored collapse state (which is left untouched)
  const isExpanded = (category) => filtering || (expandedCategories[category] ?? true);
  const categories = filtering ? filterCategories(NODE_CATEGORIES, filter) : NODE_CATEGORIES;

  const handleDragStart = (event, nodeType) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
    if (onDragStart) {
      onDragStart(nodeType);
    }
  };

  const toggleCategory = (category) => {
    if (filtering) return;
    setExpandedCategories(prev => ({
      ...prev,
      [category]: !(prev[category] ?? true)
    }));
  };

  return (
    // Fill the (resizable) pane we are placed in: the header keeps its size and
    // the list below becomes the scroll region bounded by the pane, so the
    // scroll range always ends at the last card and nothing is clipped.
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-os-card border-t border-os-border">
      {/* Header */}
      <div className="shrink-0 p-4 border-b border-os-border bg-os-card">
        <button
          onClick={() => onCollapsedChange?.(!isCollapsed)}
          className="w-full flex items-center gap-2 hover:bg-os-card-secondary transition-colors px-2 py-1 rounded-none"
        >
          <ChevronRight size={16} className={`text-os-text-secondary shrink-0 transition-transform ${isCollapsed ?'':'rotate-90'}`} />
          {width > 280 ? (
            <span className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
              Node Library
            </span>
          ) : width > 220 ? (
            <span className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
              Nodes
            </span>
          ) : null}
        </button>
      </div>

      {!isCollapsed && (
        <>
          {/* Filter box (Escape clears it) */}
          <div className="shrink-0 px-3 py-2 border-b border-os-border">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-os-text-muted pointer-events-none" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setFilter(''); e.currentTarget.blur(); } }}
                placeholder="Filter nodes..."
                aria-label="Filter nodes"
                data-testid="node-library-filter"
                className="w-full pl-8 pr-7 py-1.5 text-sm border border-os-input-border rounded-sm bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue focus:border-transparent"
              />
              {filtering && (
                <button
                  type="button"
                  onClick={() => setFilter('')}
                  title="Clear filter"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-os-text-muted hover:text-os-text-primary hover:bg-os-card-secondary"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Node List */}
          <div data-testid="node-library-list" className="flex-1 min-h-0 overflow-y-auto py-1">
            {categories.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-os-text-muted">No matching nodes</div>
            )}
            {categories.map((category) => (
              <div key={category.category}>
                {/* Category Header */}
                <button
                  onClick={() => toggleCategory(category.category)}
                  className="w-full flex items-center gap-2 text-xs text-os-text-secondary uppercase tracking-wide px-4 py-2 rounded-none hover:bg-os-card-secondary hover:text-os-text-primary transition-colors"
                >
                  {isExpanded(category.category) ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                  {category.category}
                  <span className="text-xs font-normal normal-case text-os-text-muted ml-auto">
                    {category.nodes.length}
                  </span>
                </button>

                {/* Category Nodes */}
                {isExpanded(category.category) && (
                  <div>
                    {category.nodes.map((node) => {
                      const Icon = node.icon;
                      return (
                        <div
                          key={node.type}
                          draggable
                          onDragStart={(e) => handleDragStart(e, node.type)}
                          className="group cursor-grab active:cursor-grabbing px-4 py-2 hover:bg-os-card-secondary transition-colors"
                        >
                          <div className="flex items-start gap-3">
                            <Icon size={16} className={`text-${node.color}-600 shrink-0 mt-0.5`} />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-os-text-primary flex items-center gap-1.5">
                                {node.label}
                              </div>
                              <div className="text-xs text-os-text-secondary mt-0.5 truncate">
                                {node.description}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
