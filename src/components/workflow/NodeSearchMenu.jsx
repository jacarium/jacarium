import { useState, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';
import { rankNodes } from './nodeSearch';
import useScrollSelectedIntoView from '../../hooks/useScrollSelectedIntoView';

/**
 * A floating "pick a node type" menu with a search box: the list behind the
 * connection menu (a wire dropped on empty canvas) and the quick-add palette
 * (right-click / double-click / Tab on empty canvas).
 *
 * Without a query the nodes are grouped by category; with one they are a
 * flat list, best match first (nodeSearch.js rankNodes), so Enter adds the
 * node the user most likely meant. Arrow keys move the highlight and keep
 * it scrolled into view; Escape closes; the backdrop click closes.
 *
 * @param {{x, y}}   position      - screen position of the menu's top-left
 * @param {Array}    categories    - the node categories to offer
 * @param {Function} onSelect      - called with the chosen node type
 * @param {Function} onClose
 * @param {string}   [placeholder] - the search box's placeholder
 */
export default function NodeSearchMenu({ position, categories, onSelect, onClose, placeholder = 'Search nodes...' }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const searchInputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    // Auto-focus search input when menu opens
    searchInputRef.current?.focus();
  }, []);

  useScrollSelectedIntoView(listRef, selectedIndex);

  if (!position) return null;

  const query = searchQuery.trim();
  // Every visible node in display order, numbered: `index` is what the arrow
  // keys walk and what useScrollSelectedIntoView looks up
  const groups = query
    ? [{ category: null, nodes: rankNodes(categories, query) }]
    : categories.map(category => ({ category: category.category, nodes: category.nodes })).filter(g => g.nodes.length > 0);
  const flat = [];
  const rows = [];
  for (const group of groups) {
    const entries = [];
    for (const node of group.nodes) {
      entries.push({ node, index: flat.length });
      flat.push(node);
    }
    rows.push({ category: group.category, entries });
  }

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && flat[selectedIndex]) {
      e.preventDefault();
      onSelect(flat[selectedIndex].type);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
      />

      {/* Menu */}
      <div
        className="fixed z-50 bg-os-card rounded-lg shadow-xl border border-os-border flex flex-col"
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
          width: '300px',
          maxHeight: '500px'
        }}
      >
        {/* Search Input */}
        <div className="p-3 border-b border-os-border shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-os-text-secondary" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                // Reset keyboard selection whenever the search changes
                setSelectedIndex(0);
              }}
              placeholder={placeholder}
              role="combobox"
              aria-expanded="true"
              aria-controls="workflow-node-search-list"
              aria-activedescendant={flat[selectedIndex] ? `workflow-node-option-${flat[selectedIndex].type}` : undefined}
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-os-border rounded-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue focus:border-transparent bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted"
              onKeyDown={handleKeyDown}
            />
          </div>
        </div>

        {/* Node List */}
        <div ref={listRef} id="workflow-node-search-list" role="listbox" className="overflow-y-auto flex-1">
          {flat.length === 0 ? (
            <div className="p-4 text-center text-sm text-os-text-secondary">
              {query ? 'No matching nodes' : 'No compatible nodes'}
            </div>
          ) : (
            <div className="py-2">
              {rows.map((group) => (
                <div key={group.category ?? 'results'}>
                  {group.category && (
                    <div className="px-4 py-2 text-xs font-semibold text-os-text-secondary uppercase tracking-wide bg-os-input-bg">
                      {group.category}
                    </div>
                  )}
                  <div>
                    {group.entries.map(({ node, index }) => {
                      const Icon = node.icon;
                      const isSelected = index === selectedIndex;
                      return (
                        <button
                          key={node.type}
                          id={`workflow-node-option-${node.type}`}
                          role="option"
                          aria-selected={isSelected}
                          data-index={index}
                          onClick={() => onSelect(node.type)}
                          className={`w-full px-4 py-2 flex items-center gap-3 transition-colors text-left scroll-m-2 ${
 isSelected ?'bg-os-blue text-white':'hover:bg-os-card-secondary'
 }`}
                        >
                          <div className={`p-1.5 rounded-sm ${isSelected ?'bg-white/20':`bg-${node.color}-50`}`}>
                            {Icon && <Icon size={16} className={isSelected ?'text-white':`text-${node.color}-600`} />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className={`text-sm font-medium ${isSelected ?'text-white':'text-os-text-primary'}`}>
                              {node.label}
                            </div>
                            <div className={`text-xs truncate ${isSelected ?'text-white' :'text-os-text-secondary/80'}`}>
                              {query && node.category ? `${node.category} · ${node.description}` : node.description}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
