import { useState, useEffect, useRef } from 'react';
import { Pencil, Bold, Italic, Code, List, ListOrdered, Link, Quote, Strikethrough, Save, Eye, Edit3, Search, FilePlus, FileCode } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import SidebarHeader from './sidebar/SidebarHeader';
import ResizableSidebar from '../ResizableSidebar';
import { getDocumentsMetadata, getDocument, createDocument, updateDocument } from '../../utils/documents';

export default function DraftSidebar({ isOpen }) {
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [currentDocumentId, setCurrentDocumentId] = useState(null);
  const [lastSavedContent, setLastSavedContent] = useState('');
  const [lastSavedTitle, setLastSavedTitle] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [allDocuments, setAllDocuments] = useState([]);
  const [previewMode, setPreviewMode] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const textareaRef = useRef(null);
  const searchInputRef = useRef(null);
  const titleInputRef = useRef(null);

  const hasUnsavedChanges = content !== lastSavedContent || title !== lastSavedTitle;

  // Load documents on mount and when sidebar opens
  useEffect(() => {
    if (isOpen) {
      loadDocuments();
    }
  }, [isOpen]);

  // Listen for document updates from other parts of the app
  useEffect(() => {
    function handleDocumentUpdated() {
      loadDocuments();
    }

    window.addEventListener('documentUpdated', handleDocumentUpdated);
    return () => window.removeEventListener('documentUpdated', handleDocumentUpdated);
  }, []);

  // Load draft from localStorage on mount
  useEffect(() => {
    async function loadDraftFromStorage() {
      try {
        const savedDraft = localStorage.getItem('draft-sidebar-state');
        if (savedDraft) {
          const { content: savedContent, title: savedTitle, documentId } = JSON.parse(savedDraft);
          setContent(savedContent || '');
          setTitle(savedTitle || '');
          setCurrentDocumentId(documentId || null);

          // If there's a document ID, check if content matches what's in database
          if (documentId) {
            const doc = await getDocument(documentId);
            if (doc && doc.content === savedContent && doc.title === savedTitle) {
              // Content matches database, no unsaved changes
              setLastSavedContent(savedContent || '');
              setLastSavedTitle(savedTitle || '');
            } else {
              // Content doesn't match database, has unsaved changes
              setLastSavedContent('');
              setLastSavedTitle('');
            }
          } else {
            // New document, not saved yet
            setLastSavedContent('');
            setLastSavedTitle('');
          }
        }
      } catch (error) {
        console.error('Failed to load draft from localStorage:', error);
      }
    }

    loadDraftFromStorage();
  }, []);

  // Save draft to localStorage whenever content, title, or documentId changes
  useEffect(() => {
    try {
      localStorage.setItem('draft-sidebar-state', JSON.stringify({
        content,
        title,
        documentId: currentDocumentId
      }));
    } catch (error) {
      console.error('Failed to save draft to localStorage:', error);
    }
  }, [content, title, currentDocumentId]);

  // Focus search input when search is shown
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  // Focus title input when editing
  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  async function loadDocuments() {
    // Metadata only: this list is just searched/rendered by title;
    // opening a document goes through getDocument(id) for the full content.
    const docs = await getDocumentsMetadata();
    setAllDocuments(docs);
  }

  async function handleSave() {
    if (!hasUnsavedChanges) return;

    try {
      const finalTitle = title.trim() || 'Untitled';
      let docId = currentDocumentId;
      let category = 'Draft';

      if (currentDocumentId) {
        // Update existing document
        const updatedDoc = await updateDocument(currentDocumentId, {
          title: finalTitle,
          content
        });
        category = updatedDoc?.category || 'Draft';
      } else {
        // Create new document only if there's content
        if (!content.trim()) return;

        const id = await createDocument({
          title: finalTitle,
          content,
          category: 'Draft'
        });
        setCurrentDocumentId(id);
        docId = id;
      }

      // Update last saved state
      setLastSavedContent(content);
      setLastSavedTitle(title);

      // Reload documents
      await loadDocuments();

      // Dispatch event to notify DocumentsPage of the update
      window.dispatchEvent(new CustomEvent('documentUpdated', {
        detail: {
          id: docId,
          title: finalTitle,
          content,
          category
        }
      }));
    } catch (error) {
      console.error('Failed to save document:', error);
    }
  }

  function handleNewDocument() {
    setContent('');
    setTitle('');
    setCurrentDocumentId(null);
    setLastSavedContent('');
    setLastSavedTitle('');
  }

  async function handleLoadDocument(doc) {
    const fullDoc = await getDocument(doc.id);
    const loadedContent = fullDoc.content || '';
    const loadedTitle = fullDoc.title;
    setContent(loadedContent);
    setTitle(loadedTitle);
    setCurrentDocumentId(doc.id);
    setLastSavedContent(loadedContent);
    setLastSavedTitle(loadedTitle);
    setShowSearch(false);
    setSearchQuery('');
  }

  function handleTitleDoubleClick() {
    setIsEditingTitle(true);
  }

  function handleTitleBlur() {
    setIsEditingTitle(false);
  }

  function handleTitleKeyDown(e) {
    if (e.key === 'Enter') {
      setIsEditingTitle(false);
    } else if (e.key === 'Escape') {
      setIsEditingTitle(false);
    }
  }

  function insertMarkdown(before, after = '') {
    if (!textareaRef.current) return;

    const textarea = textareaRef.current;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end);
    const newText = content.substring(0, start) + before + selectedText + after + content.substring(end);

    setContent(newText);

    setTimeout(() => {
      textarea.focus();
      const newCursorPos = start + before.length + selectedText.length + after.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }

  function insertCodeBlock() {
    if (!textareaRef.current) return;

    const textarea = textareaRef.current;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end);

    const codeContent = selectedText || 'code here';
    const before = '\n```\n';
    const after = '\n```\n';
    const newText = content.substring(0, start) + before + codeContent + after + content.substring(end);

    setContent(newText);

    setTimeout(() => {
      textarea.focus();
      const newCursorPos = start + before.length + codeContent.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }

  const filteredDocuments = allDocuments.filter(doc =>
    !doc.inCloud && doc.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const renderedMarkdown = previewMode ? DOMPurify.sanitize(marked(content)) : '';

  if (!isOpen) return null;

  return (
    <ResizableSidebar
      defaultWidth={400}
      minWidth={300}
      maxWidth={600}
      storageKey="draft-sidebar-width"
    >
      <div className="flex flex-col h-full bg-os-card border-r border-os-border">
        {/* Header */}
        <SidebarHeader
          title="Draft"
          icon={Pencil}
        />

        {/* Title */}
        <div className="p-3 border-b border-os-border">
          <div className="flex items-center gap-2">
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={handleTitleBlur}
                onKeyDown={handleTitleKeyDown}
                placeholder="Untitled"
                className="flex-1 px-2 py-1 text-sm border border-purple-500 rounded-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-hidden bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted"
              />
            ) : (
              <div
                onDoubleClick={handleTitleDoubleClick}
                className="flex-1 px-2 py-1 text-sm font-semibold text-os-text-primary cursor-text hover:bg-os-card-secondary rounded-sm transition-colors"
                title="Double-click to edit"
              >
                {title || 'Untitled'}
              </div>
            )}
            {hasUnsavedChanges && (
              <span className="text-xs text-orange-600 font-medium">Unsaved</span>
            )}
          </div>
        </div>

        {/* Toolbar */}
        <div className="p-2 border-b border-os-border flex items-center gap-1 flex-wrap bg-os-card">
          <button
            onClick={() => insertMarkdown('**', '**')}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Bold"
          >
            <Bold size={16} className="text-os-text-primary" />
          </button>
          <button
            onClick={() => insertMarkdown('_', '_')}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Italic"
          >
            <Italic size={16} className="text-os-text-primary" />
          </button>
          <button
            onClick={() => insertMarkdown('~~', '~~')}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Strikethrough"
          >
            <Strikethrough size={16} className="text-os-text-primary" />
          </button>
          <button
            onClick={() => insertMarkdown('`', '`')}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Inline code"
          >
            <Code size={16} className="text-os-text-primary" />
          </button>
          <button
            onClick={insertCodeBlock}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Code block"
          >
            <FileCode size={16} className="text-os-text-primary" />
          </button>
          <div className="w-px h-6 bg-os-border mx-1"></div>
          <button
            onClick={() => insertMarkdown('- ')}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Bullet List"
          >
            <List size={16} className="text-os-text-primary" />
          </button>
          <button
            onClick={() => insertMarkdown('1. ')}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Numbered List"
          >
            <ListOrdered size={16} className="text-os-text-primary" />
          </button>
          <button
            onClick={() => insertMarkdown('> ')}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Quote"
          >
            <Quote size={16} className="text-os-text-primary" />
          </button>
          <button
            onClick={() => insertMarkdown('[', '](url)')}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="Link"
          >
            <Link size={16} className="text-os-text-primary" />
          </button>
          <div className="flex-1"></div>
          <button
            onClick={() => setPreviewMode(!previewMode)}
            className={`p-1.5 rounded-sm transition-colors ${previewMode ?'bg-os-blue text-white':'hover:bg-os-card-secondary'}`}
            title={previewMode ? 'Edit' : 'Preview'}
          >
            {previewMode ? <Edit3 size={16} className="text-white" /> : <Eye size={16} className="text-os-text-primary" />}
          </button>
          <button
            onClick={() => setShowSearch(!showSearch)}
            className={`p-1.5 rounded-sm transition-colors ${showSearch ?'bg-os-blue text-white':'hover:bg-os-card-secondary'}`}
            title="Load Document"
          >
          </button>
          <button
            onClick={handleSave}
            disabled={!hasUnsavedChanges}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Save document to Draft category"
          >
            <Save size={16} className="text-os-text-primary" />
          </button>
          <button
            onClick={handleNewDocument}
            className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
            title="New Document"
          >
            <FilePlus size={16} className="text-os-text-primary" />
          </button>
        </div>

        {/* Search Panel */}
        {showSearch && (
          <div className="p-3 border-b border-os-border bg-os-card">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search documents..."
              className="w-full px-3 py-2 text-sm border border-os-input-border rounded-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-hidden mb-2 bg-os-input-bg text-os-text-primary"
            />
            <div className="max-h-48 overflow-y-auto space-y-1">
              {filteredDocuments.map(doc => (
                <button
                  key={doc.id}
                  onClick={() => handleLoadDocument(doc)}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-os-card-secondary rounded-sm flex items-center gap-2"
                >
                  <span className="flex-1 truncate">{doc.title}</span>
                </button>
              ))}
              {filteredDocuments.length === 0 && (
                <p className="text-sm text-os-text-muted text-center py-4">No documents found</p>
              )}
            </div>
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 overflow-hidden">
          {previewMode ? (
            <div
              className="h-full overflow-y-auto prose prose-sm max-w-none p-4"
              dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
            />
          ) : (
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Quick Draft"
              className="w-full h-full px-4 py-3 text-sm outline-hidden resize-none font-mono bg-os-card text-os-text-primary placeholder:text-os-text-muted border-0"
            />
          )}
        </div>
      </div>
    </ResizableSidebar>
  );
}
