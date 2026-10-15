import { useState, useEffect, useRef } from 'react';
import useScrollSelectedIntoView from '../hooks/useScrollSelectedIntoView';
import { Search, FileText, Zap, RefreshCw, ChevronRight, Clock, Hash, Plus, Activity, Link2 } from 'lucide-react';
import { getDocuments } from '../utils/documents';
import { getTemplates } from '../templates/jqlTemplates';
import { getEngineTemplates } from '../utils/engineTemplates';

export default function CommandPalette({ isOpen, onClose, onNavigate, onRefreshJira, onLoadDocument, onLoadTemplate, onCreateDocument, onLoadEngineTemplate }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentTemplates, setRecentTemplates] = useState([]);
  const inputRef = useRef(null);
  // The scrolling results container: the highlighted row is kept in view
  // as the arrow keys move it (and a new query starts back at the top)
  const listRef = useRef(null);
  useScrollSelectedIntoView(listRef, selectedIndex);

  // Focus the input and load recent templates when the palette opens. The
  // cleanup resets the palette on close so the next open starts fresh
  // (nothing renders while closed, so resetting on close is equivalent to
  // the previous reset-on-open).
  useEffect(() => {
    if (!isOpen) return undefined;

    inputRef.current?.focus();

    let cancelled = false;
    (async () => {
      const templates = await getTemplates();
      // Get the 5 most recent templates
      if (!cancelled) setRecentTemplates(templates.slice(0, 5));
    })();

    return () => {
      cancelled = true;
      setQuery('');
      setSelectedIndex(0);
      setResults([]);
    };
  }, [isOpen]);

  // Always points at the latest handleSearch so the debounced call below
  // sees fresh props without re-arming the timer on every render.
  const handleSearchRef = useRef(null);

  // Debounced search trigger. handleSearch() awaits full-content
  // getDocuments() + getTemplates() + getEngineTemplates() and substring-
  // scans every document body (content search is a wanted feature here), so
  // running it on every keystroke did a full-table content scan per
  // character typed. Debounce with the same effect + setTimeout + cleanup
  // pattern as the auto-save timers in DocumentsPage/FloatingDraft (calling
  // through handleSearchRef keeps the closure fresh); the cleanup cancels
  // the pending run on the next keystroke and when the palette
  // closes/unmounts. 200ms sits in the same band as the 300ms search
  // debounce in SearchableCombobox, tuned slightly tighter so the palette
  // stays snappy.
  useEffect(() => {
    if (!query) return undefined;
    const timer = setTimeout(() => {
      handleSearchRef.current?.(query);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  async function handleSearch(searchQuery) {
    const trimmedQuery = searchQuery.trim();

    // Handle slash commands
    if (trimmedQuery.startsWith('/')) {
      const command = trimmedQuery.toLowerCase();
      const commands = [
        {
          id: 'search',
          type: 'command',
          icon: Search,
          title: 'Go to Search',
          subtitle: 'Open Search',
          command: '/search',
          action: () => {
            onNavigate('search');
            onClose();
          }
        },
        {
          id: 'docs',
          type: 'command',
          icon: FileText,
          title: 'Go to Documents',
          subtitle: 'Open Documents',
          command: '/docs',
          action: () => {
            onNavigate('documents');
            onClose();
          }
        },
        {
          id: 'documents',
          type: 'command',
          icon: FileText,
          title: 'Go to Documents',
          subtitle: 'Open Documents',
          command: '/documents',
          action: () => {
            onNavigate('documents');
            onClose();
          }
        },
        {
          id: 'diagnostics',
          type: 'command',
          icon: Activity,
          title: 'Go to Diagnostics',
          subtitle: 'Analyze sosreport and mustgather data',
          command: '/diagnostics',
          action: () => {
            onNavigate('diagnostics');
            onClose();
          }
        },
        {
          id: 'new',
          type: 'command',
          icon: Plus,
          title: 'Create New Document',
          subtitle: 'Create a new intelligence brief',
          command: '/new',
          action: () => {
            onCreateDocument();
            onClose();
          }
        },
        {
          id: 'sync',
          type: 'command',
          icon: RefreshCw,
          title: 'Sync Jira Metadata',
          subtitle: 'Refresh all Jira data',
          command: '/sync',
          action: () => {
            onRefreshJira();
            onClose();
          }
        }
      ];

      const filtered = commands.filter(cmd =>
        cmd.command.startsWith(command) || cmd.title.toLowerCase().includes(command.replace('/', ''))
      );
      setResults(filtered);
      return;
    }

    // Search documents, templates, and engine templates
    const [documents, templates, engineTemplates] = await Promise.all([
      getDocuments(),
      getTemplates(),
      getEngineTemplates()
    ]);
    const searchLower = trimmedQuery.toLowerCase();

    // Search templates by name and description
    const templateResults = templates
      .filter(template =>
        template.name.toLowerCase().includes(searchLower) ||
        (template.description && template.description.toLowerCase().includes(searchLower)) ||
        (template.category && template.category.toLowerCase().includes(searchLower))
      )
      .slice(0, 5)
      .map(template => ({
        id: `template-${template.id}`,
        type: 'template',
        icon: Zap,
        title: template.name,
        subtitle: template.description || template.category || 'Saved template',
        action: () => {
          onLoadTemplate(template);
          onClose();
        }
      }));

    // Search documents by title and content
    const documentResults = documents
      .filter(doc =>
        doc.title.toLowerCase().includes(searchLower) ||
        (doc.content && doc.content.toLowerCase().includes(searchLower))
      )
      .slice(0, 5)
      .map(doc => ({
        id: `document-${doc.id}`,
        type: 'document',
        icon: FileText,
        title: doc.title,
        subtitle: `Updated ${new Date(doc.updatedAt).toLocaleDateString()}`,
        action: () => {
          onLoadDocument(doc.id);
          onClose();
        }
      }));

    // Search engine templates by name and description
    const engineResults = engineTemplates
      .filter(engine =>
        engine.name.toLowerCase().includes(searchLower) ||
        (engine.description && engine.description.toLowerCase().includes(searchLower)) ||
        (engine.category && engine.category.toLowerCase().includes(searchLower))
      )
      .slice(0, 5)
      .map(engine => ({
        id: `engine-${engine.id}`,
        type: 'engine',
        icon: Link2,
        title: engine.name,
        subtitle: engine.description || engine.category || 'Search engine',
        action: () => {
          onLoadEngineTemplate(engine);
          onClose();
        }
      }));

    // Combine results with templates first, then engines, then documents
    setResults([...templateResults, ...engineResults, ...documentResults]);
  }

  // Keep the debounce effect's ref pointed at the latest handleSearch
  useEffect(() => {
    handleSearchRef.current = handleSearch;
  });

  // What the arrow keys walk: the search results, or the recent templates
  // shown while the query is empty
  const listLength = query ? results.length : recentTemplates.length;

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev < listLength - 1 ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : 0));
    } else if (e.key === 'Home' && listLength > 0) {
      e.preventDefault();
      setSelectedIndex(0);
    } else if (e.key === 'End' && listLength > 0) {
      e.preventDefault();
      setSelectedIndex(listLength - 1);
    } else if (e.key === 'Enter' && !query && recentTemplates[selectedIndex]) {
      e.preventDefault();
      handleTemplateClick(recentTemplates[selectedIndex]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length > 0 && results[selectedIndex]) {
        results[selectedIndex].action();
      }
    }
  }

  function handleResultClick(result) {
    result.action();
  }

  function handleTemplateClick(template) {
    onLoadTemplate(template);
    onClose();
  }

  if (!isOpen) return null;

  const showRecentTemplates = !query && recentTemplates.length > 0;
  const activeRowId = listLength > 0 ? `command-palette-option-${selectedIndex}` : undefined;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center pt-[15vh] px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-os-card rounded-lg shadow-2xl overflow-hidden border border-os-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input: a proper boxed field (the app's input surface, border
            and focus ring), so the ring the global input styles draw frames
            padded text rather than hugging it */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-os-border">
          <Search size={20} className="text-os-text-secondary shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // A new query starts at the top of its results (which may be
              // shorter than the last ones)
              setSelectedIndex(0);
              // Clearing the input clears results immediately (the debounce
              // effect only runs for non-empty queries)
              if (!e.target.value) setResults([]);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            role="combobox"
            aria-expanded={listLength > 0}
            aria-controls="command-palette-results"
            aria-activedescendant={activeRowId}
            aria-autocomplete="list"
            className="flex-1 min-w-0 px-3 py-2 text-base rounded-sm border border-os-input-border bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted"
          />
          <kbd className="px-2 py-1 bg-os-card-secondary text-os-text-secondary text-xs rounded-sm border border-os-border">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} id="command-palette-results" role="listbox" className="max-h-96 overflow-y-auto">
          {query && results.length === 0 && (
            <div className="px-4 py-8 text-center text-os-text-muted">
              No results found
            </div>
          )}

          {query && results.length > 0 && (
            <div className="py-2">
              {results.map((result, index) => {
                const IconComponent = result.icon;
                const isSelected = index === selectedIndex;
                return (
                  <div
                    key={result.id}
                    id={`command-palette-option-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    data-index={index}
                    onClick={() => handleResultClick(result)}
                    className={`px-4 py-3 cursor-pointer transition-colors flex items-center gap-3 scroll-m-2 ${
 isSelected ?'bg-os-blue/10':'hover:bg-os-card-secondary'
 }`}
                  >
                    <div className={`p-2 rounded ${
 result.type ==='command'?'bg-purple-100':
 result.type ==='template'?'bg-green-100':
 result.type ==='engine'?'bg-orange-100':
'bg-blue-100'
 }`}>
                      <IconComponent size={16} className={
 result.type ==='command'?'text-purple-600':
 result.type ==='template'?'text-green-600':
 result.type ==='engine'?'text-orange-600':
'text-blue-600'
 } />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-os-text-primary truncate">
                        {result.title}
                      </div>
                      <div className="text-xs text-os-text-secondary truncate">
                        {result.subtitle}
                      </div>
                    </div>
                    {result.type === 'command' && (
                      <div className="text-xs text-os-text-muted font-mono">
                        {result.command}
                      </div>
                    )}
                    {isSelected && (
                      <ChevronRight size={16} className="text-os-text-muted" />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Recent Templates */}
          {showRecentTemplates && (
            <div className="py-2">
              <div className="px-4 py-2 flex items-center gap-2">
                <Clock size={14} className="text-os-text-secondary" />
                <span className="text-xs font-semibold text-os-text-secondary uppercase tracking-wider">
                  Recent Searches
                </span>
              </div>
              {recentTemplates.map((template, index) => {
                const isSelected = index === selectedIndex;
                return (
                  <div
                    key={template.id}
                    id={`command-palette-option-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    data-index={index}
                    onClick={() => handleTemplateClick(template)}
                    className={`px-4 py-3 cursor-pointer transition-colors flex items-center gap-3 scroll-m-2 ${
 isSelected ?'bg-os-blue/10':'hover:bg-os-card-secondary'
 }`}
                  >
                    <div className="p-2 rounded-sm bg-green-100">
                      <Zap size={16} className="text-green-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-os-text-primary truncate">
                        {template.name}
                      </div>
                      <div className="text-xs text-os-text-secondary truncate">
                        {template.description || 'Saved template'}
                      </div>
                    </div>
                    {isSelected && (
                      <ChevronRight size={16} className="text-os-text-muted" />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Quick Commands Help */}
          {!query && recentTemplates.length === 0 && (
            <div className="px-4 py-8">
              <div className="text-sm text-os-text-primary font-medium mb-4">Quick Commands:</div>
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Hash size={16} className="text-os-text-muted" />
                  <span className="text-sm text-os-text-secondary">
                    <code className="text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded-sm">/search</code> - Go to Search
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Hash size={16} className="text-os-text-muted" />
                  <span className="text-sm text-os-text-secondary">
                    <code className="text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded-sm">/docs</code> - Go to Documents
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Hash size={16} className="text-os-text-muted" />
                  <span className="text-sm text-os-text-secondary">
                    <code className="text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded-sm">/diagnostics</code> - Analyze diagnostics data
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Hash size={16} className="text-os-text-muted" />
                  <span className="text-sm text-os-text-secondary">
                    <code className="text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded-sm">/new</code> - Create new document
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Hash size={16} className="text-os-text-muted" />
                  <span className="text-sm text-os-text-secondary">
                    <code className="text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded-sm">/sync</code> - Refresh Jira metadata
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-os-border flex items-center justify-between bg-os-card-secondary">
          <div className="flex items-center gap-4 text-xs text-os-text-secondary">
            <div className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-os-card rounded-sm border border-os-border">↑</kbd>
              <kbd className="px-1.5 py-0.5 bg-os-card rounded-sm border border-os-border">↓</kbd>
              <span>Navigate</span>
            </div>
            <div className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-os-card rounded-sm border border-os-border">⏎</kbd>
              <span>Select</span>
            </div>
          </div>
          <div className="text-xs text-os-text-muted">
            Cmd+K to open
          </div>
        </div>
      </div>
    </div>
  );
}
