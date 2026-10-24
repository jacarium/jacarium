import { useState, useEffect } from 'react';
import { X, Search, ChevronRight, ChevronDown, Database, Loader2 } from 'lucide-react';
import { getDocuments } from '../../utils/documents';
import { getDocumentCategories } from '../../utils/documentCategories';
import { getBackendUrl, apiFetch } from '../../utils/backendUrl';

export default function DatasetSelectionModal({ isOpen, onClose, selectedDocumentIds, onSave }) {
  const [documents, setDocuments] = useState([]);
  const [, setCategories] = useState([]);
  const [selectedDocs, setSelectedDocs] = useState(new Set(selectedDocumentIds));
  const [selectedCategories, setSelectedCategories] = useState(new Set());
  const [expandedCategories, setExpandedCategories] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexingProgress, setIndexingProgress] = useState('');

  useEffect(() => {
    if (!isOpen) return;

    // Snapshot of the current conversation's selection, taken on open.
    const currentSelection = new Set(selectedDocumentIds);

    async function loadData() {
      // Re-sync selection from the prop on every open: the modal stays mounted
      // and is shared across conversations, so without this reset a reopen
      // would show (and then save) the previous conversation's selection.
      setSelectedDocs(currentSelection);
      setSelectedCategories(new Set());

      try {
        const [allDocs, allCategories] = await Promise.all([
          getDocuments(),
          getDocumentCategories()
        ]);

        setDocuments(allDocs);
        setCategories(allCategories);

        // Auto-expand categories that have selected documents
        const categoriesToExpand = new Set();
        allDocs.forEach(doc => {
          if (currentSelection.has(doc.id)) {
            categoriesToExpand.add(doc.category || 'Uncategorized');
          }
        });
        setExpandedCategories(categoriesToExpand);
      } catch (error) {
        console.error('Failed to load documents:', error);
      }
    }

    loadData();
    // Intentionally load once per open: the selection is read as a snapshot
    // (currentSelection) to decide which categories start expanded; re-running
    // on every toggle would refetch and reset the expansion state under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const filteredDocs = documents.filter(doc =>
    doc.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const docsByCategory = filteredDocs.reduce((acc, doc) => {
    const cat = doc.category || 'Uncategorized';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(doc);
    return acc;
  }, {});

  function toggleDocument(docId) {
    const newSelected = new Set(selectedDocs);
    if (newSelected.has(docId)) {
      newSelected.delete(docId);
    } else {
      newSelected.add(docId);
    }
    setSelectedDocs(newSelected);
  }

  function toggleCategory(categoryName) {
    const newSelectedCategories = new Set(selectedCategories);
    const categoryDocs = docsByCategory[categoryName] || [];
    const newSelectedDocs = new Set(selectedDocs);

    if (newSelectedCategories.has(categoryName)) {
      // Deselect category and all its documents
      newSelectedCategories.delete(categoryName);
      categoryDocs.forEach(doc => newSelectedDocs.delete(doc.id));
    } else {
      // Select category and all its documents
      newSelectedCategories.add(categoryName);
      categoryDocs.forEach(doc => newSelectedDocs.add(doc.id));
    }

    setSelectedCategories(newSelectedCategories);
    setSelectedDocs(newSelectedDocs);
  }

  function toggleCategoryExpand(categoryName) {
    const newExpanded = new Set(expandedCategories);
    if (newExpanded.has(categoryName)) {
      newExpanded.delete(categoryName);
    } else {
      newExpanded.add(categoryName);
    }
    setExpandedCategories(newExpanded);
  }

  async function handleSave() {
    setIsIndexing(true);
    setIndexingProgress('Preparing documents...');

    try {
      // Get full document content for selected docs
      const docsToIndex = documents.filter(doc => selectedDocs.has(doc.id)).map(doc => ({
        id: doc.id,
        title: doc.title,
        content: doc.content || '',
        category: doc.category || 'Uncategorized'
      }));

      if (docsToIndex.length > 0) {
        setIndexingProgress(`Indexing ${docsToIndex.length} documents...`);

        const backendUrl = await getBackendUrl();
        const response = await apiFetch(`${backendUrl}/api/embeddings/index`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documents: docsToIndex })
        });

        const result = await response.json();

        if (result.success) {
          setIndexingProgress(`Indexed ${result.indexed} documents (${result.chunks_created} chunks)`);
          setTimeout(() => {
            onSave(Array.from(selectedDocs));
            setIsIndexing(false);
            setIndexingProgress('');
          }, 1000);
        } else {
          throw new Error(result.error || 'Indexing failed');
        }
      } else {
        onSave(Array.from(selectedDocs));
        setIsIndexing(false);
      }
    } catch (error) {
      console.error('Indexing error:', error);
      setIndexingProgress('Error: ' + error.message);
      setTimeout(() => {
        setIsIndexing(false);
        setIndexingProgress('');
      }, 3000);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-os-card rounded-lg shadow-xl w-full max-w-2xl max-h-[70vh] flex flex-col border border-os-border">
        {/* Header */}
        <div className="px-4 py-3 border-b border-os-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database size={20} className="text-blue-500" />
            <h2 className="text-base font-semibold text-os-text-primary">Select Datasets</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            <X size={18} className="text-os-text-muted" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-os-border">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-os-text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search documents..."
              className="w-full pl-10 pr-4 py-2 border border-os-input-border rounded-sm text-sm bg-os-input-bg text-os-text-primary focus:ring-2 focus:ring-blue-500 outline-hidden"
            />
          </div>
        </div>

        {/* Document List */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {Object.entries(docsByCategory).map(([categoryName, docs]) => {
            const allDocsSelected = docs.every(doc => selectedDocs.has(doc.id));
            const someDocsSelected = docs.some(doc => selectedDocs.has(doc.id)) && !allDocsSelected;

            return (
              <div key={categoryName} className="mb-2">
                <div className="flex items-center gap-2 py-1.5 hover:bg-os-card-secondary rounded-sm px-2 transition-colors">
                  <button
                    onClick={() => toggleCategoryExpand(categoryName)}
                    className="p-0.5"
                  >
                    {expandedCategories.has(categoryName) ? (
                      <ChevronDown size={14} className="text-os-text-muted" />
                    ) : (
                      <ChevronRight size={14} className="text-os-text-muted" />
                    )}
                  </button>
                  <input
                    type="checkbox"
                    checked={allDocsSelected}
                    ref={input => {
                      if (input) input.indeterminate = someDocsSelected;
                    }}
                    onChange={() => toggleCategory(categoryName)}
                    className="w-3.5 h-3.5 rounded-sm border-os-input-border"
                  />
                  <span className="text-sm font-medium text-os-text-primary cursor-pointer flex-1" onClick={() => toggleCategoryExpand(categoryName)}>
                    {categoryName}
                  </span>
                  <span className="text-xs text-os-text-muted">
                    ({docs.length})
                  </span>
                </div>

                {expandedCategories.has(categoryName) && (
                  <div className="ml-7 mt-1 space-y-0.5">
                    {docs.map(doc => (
                      <div
                        key={doc.id}
                        className="flex items-center gap-2 py-1.5 px-2 hover:bg-os-card-secondary rounded-sm cursor-pointer transition-colors"
                        onClick={() => toggleDocument(doc.id)}
                      >
                        <input
                          type="checkbox"
                          checked={selectedDocs.has(doc.id)}
                          onChange={() => toggleDocument(doc.id)}
                          className="w-3.5 h-3.5 rounded-sm border-os-input-border"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="text-xs text-os-text-primary truncate">
                          {doc.title}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {Object.keys(docsByCategory).length === 0 && (
            <div className="text-center py-8 text-os-text-muted">
              {searchQuery ? 'No documents match your search' : 'No documents available'}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-os-border flex items-center justify-between">
          <div className="text-xs text-os-text-muted">
            {isIndexing ? (
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-blue-500" />
                <span>{indexingProgress}</span>
              </div>
            ) : (
              <span>{selectedDocs.size} dataset{selectedDocs.size !== 1 ? 's' : ''} selected</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={isIndexing}
              className="px-3 py-1.5 text-xs border border-os-border rounded-sm hover:bg-os-card-secondary transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isIndexing}
              className="btn btn-primary px-3 py-1.5 text-xs flex items-center gap-2"
            >
              
              Add ({selectedDocs.size})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
