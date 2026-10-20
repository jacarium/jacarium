import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { getBackendUrl, apiFetch } from '../utils/backendUrl';
import { NO_AI_PROVIDER_MESSAGE, resolveAiRequestSettings, savedAiChatSettings } from '../utils/aiRequestSettings';
import { createPortal } from 'react-dom';
import { Pencil, X, Minus, Bold, Italic, Code, List, ListOrdered, Link, Table, Quote, Strikethrough, IndentDecrease, IndentIncrease, Tag, Palette, RefreshCw, Eye, Edit3, EyeOff, Bot, Trash2, AlertCircle, Check, Save, Heading1, Heading2, Heading3, FileCode } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getDocumentsMetadata, getDocument, updateDocument } from '../utils/documents';
import { MenuItemIcon } from './common/menus/MenuItemIcon';

// Debounce utility
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

export default function FloatingDraft({ instanceId = 'default' }) {
  console.log('=== FloatingDraft component loaded ===');

  const eventName = `openFloatingDraft${instanceId === 'default' ? '' : instanceId}`;
  const defaultPosition = instanceId === 'default'
    ? { top: 20, left: window.innerWidth - 404 }
    : { top: 60, left: window.innerWidth - 844 }; // Offset for second instance

  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [draftDoc, setDraftDoc] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [, setAllDocuments] = useState([]);
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(`floatingDraftWidth_${instanceId}`);
    return saved ? parseInt(saved) : 384;
  });
  const [height, setHeight] = useState(() => {
    const saved = localStorage.getItem(`floatingDraftHeight_${instanceId}`);
    return saved ? parseInt(saved) : 500;
  });
  const [position, setPosition] = useState(() => {
    const saved = localStorage.getItem(`floatingDraftPosition_${instanceId}`);
    return saved ? JSON.parse(saved) : defaultPosition;
  });
  const [isResizing, setIsResizing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [documentThemes, setDocumentThemes] = useState(() => {
    const saved = localStorage.getItem(`documentThemes_${instanceId}`);
    return saved ? JSON.parse(saved) : {};
  });
  const [appSettings, setAppSettings] = useState(() => {
    const saved = localStorage.getItem('appSettings');
    return saved ? JSON.parse(saved) : {
      defaultTheme: 'light',
      defaultCategory: 'General',
      fontSize: '14',
      lineHeight: '1.5',
      autoSaveDelay: '1000'
    };
  });
  const [documentPreviewModes, setDocumentPreviewModes] = useState(() => {
    const saved = localStorage.getItem(`documentPreviewModes_${instanceId}`);
    return saved ? JSON.parse(saved) : {};
  });
  const [documentFontSizes, setDocumentFontSizes] = useState(() => {
    const saved = localStorage.getItem(`documentFontSizes_${instanceId}`);
    return saved ? JSON.parse(saved) : {};
  });
  const textareaRef = useRef(null);
  const lastSavedRef = useRef({ content: '', title: '' });
  const searchInputRef = useRef(null);
  const resizeStartRef = useRef({ width: 0, height: 0, x: 0, y: 0 });
  const dragStartRef = useRef({ top: 0, left: 0, x: 0, y: 0 });

  // Quick AI command modal
  const [showQuickAI, setShowQuickAI] = useState(false);
  const [quickAIInput, setQuickAIInput] = useState('');
  const [quickAIResponse, setQuickAIResponse] = useState('');
  const [quickAILoading, setQuickAILoading] = useState(false);
  const [quickAICursorPos, setQuickAICursorPos] = useState(null);
  const [quickAIPopupPos, setQuickAIPopupPos] = useState({ x: 0, y: 0 });
  const [quickAISelectedText, setQuickAISelectedText] = useState('');
  const [isDraggingQuickAI, setIsDraggingQuickAI] = useState(false);
  const quickAIDragStartRef = useRef({ top: 0, left: 0, x: 0, y: 0 });
  const quickAIInputRef = useRef(null);
  const quickAIResponseRef = useRef(null);

  // Text selection context menu
  const [selectionMenu, setSelectionMenu] = useState({ visible: false, x: 0, y: 0, text: '' });
  const selectionMenuRef = useRef(null);

  // Editor settings menu
  const [showEditorSettings, setShowEditorSettings] = useState(false);
  const [editorSettingsPos, setEditorSettingsPos] = useState({ x: 0, y: 0 });
  const editorSettingsMenuRef = useRef(null);

  // Reposition the editor settings menu after render using its real measured size
  useLayoutEffect(() => {
    if (!showEditorSettings || !editorSettingsMenuRef.current) return;
    const menuRect = editorSettingsMenuRef.current.getBoundingClientRect();
    const margin = 10;
    let { x, y } = editorSettingsPos;
    if (menuRect.right > window.innerWidth - margin) {
      x = Math.max(margin, x - (menuRect.right - window.innerWidth + margin));
    }
    if (menuRect.bottom > window.innerHeight - margin) {
      y = Math.max(margin, y - (menuRect.bottom - window.innerHeight + margin));
    }
    if (x !== editorSettingsPos.x || y !== editorSettingsPos.y) {
      setEditorSettingsPos({ x, y });
    }
  }, [showEditorSettings, editorSettingsPos]);

  // Backend status
  const [backendStatus, setBackendStatus] = useState('checking');
  const [checkingBackend, setCheckingBackend] = useState(false);

  // Ask AI About This modal
  const [showAskAI, setShowAskAI] = useState(false);
  const [askAIPrompt, setAskAIPrompt] = useState('');
  const [askAISanitizedText, setAskAISanitizedText] = useState('');
  const [askAIResponse, setAskAIResponse] = useState('');
  const [askAILoading, setAskAILoading] = useState(false);
  const [askAISelectedResponse, setAskAISelectedResponse] = useState('');
  const [askAIPopupPos, setAskAIPopupPos] = useState({ x: 0, y: 0 });
  const [askAIPopupSize, setAskAIPopupSize] = useState({ width: 500, height: 600 });
  const [isDraggingAskAI, setIsDraggingAskAI] = useState(false);
  const [isResizingAskAI, setIsResizingAskAI] = useState(false);
  const askAIDragStartRef = useRef({ top: 0, left: 0, x: 0, y: 0 });
  const askAIResizeStartRef = useRef({ width: 0, height: 0, x: 0, y: 0 });
  const askAIPromptRef = useRef(null);
  const askAIResponseRef = useRef(null);

  const debouncedContent = useDebounce(content, parseInt(appSettings.autoSaveDelay) || 1000);
  const debouncedTitle = useDebounce(title, 500);

  // Editor themes configuration
  const editorThemes = {
    light: {
      name: 'Light',
      textColor: 'text-black',
      bgColor: 'bg-white',
      placeholderColor: 'placeholder:text-gray-400'
    },
    dark: {
      name: 'Dark',
      textColor: 'text-gray-100',
      bgColor: 'bg-[#1e1e1e]',
      placeholderColor: 'placeholder:text-gray-500'
    },
    github: {
      name: 'GitHub',
      textColor: 'text-gray-900',
      bgColor: 'bg-[#f6f8fa]',
      placeholderColor: 'placeholder:text-gray-400'
    },
    'solarized-light': {
      name: 'Solarized Light',
      textColor: 'text-[#586e75]',
      bgColor: 'bg-[#fdf6e3]',
      placeholderColor: 'placeholder-[#93a1a1]'
    },
    'solarized-dark': {
      name: 'Solarized Dark',
      textColor: 'text-[#839496]',
      bgColor: 'bg-[#002b36]',
      placeholderColor: 'placeholder-[#586e75]'
    },
    monokai: {
      name: 'Monokai',
      textColor: 'text-[#f8f8f2]',
      bgColor: 'bg-[#272822]',
      placeholderColor: 'placeholder:text-gray-500'
    },
    dracula: {
      name: 'Dracula',
      textColor: 'text-[#f8f8f2]',
      bgColor: 'bg-[#282a36]',
      placeholderColor: 'placeholder-[#6272a4]'
    },
    nord: {
      name: 'Nord',
      textColor: 'text-[#d8dee9]',
      bgColor: 'bg-[#2e3440]',
      placeholderColor: 'placeholder-[#4c566a]'
    }
  };

  // Get current theme for this document
  const getCurrentTheme = () => {
    if (draftDoc?.id) {
      return documentThemes[draftDoc.id] || documentThemes['_default'] || appSettings.defaultTheme;
    }
    return documentThemes['_default'] || appSettings.defaultTheme;
  };

  // Handle theme change
  const handleThemeChange = (newTheme) => {
    const key = draftDoc?.id || '_default';
    const updated = { ...documentThemes, [key]: newTheme };
    setDocumentThemes(updated);
    localStorage.setItem(`documentThemes_${instanceId}`, JSON.stringify(updated));
  };

  // Get preview mode for current document
  const isPreviewMode = () => {
    const key = draftDoc?.id || '_default';
    return documentPreviewModes[key] || false;
  };

  // Toggle preview mode for current document
  const togglePreviewMode = () => {
    const key = draftDoc?.id || '_default';
    const currentMode = documentPreviewModes[key] || false;
    const updated = { ...documentPreviewModes, [key]: !currentMode };
    setDocumentPreviewModes(updated);
    localStorage.setItem(`documentPreviewModes_${instanceId}`, JSON.stringify(updated));
  };

  // Get current font size for this document
  const getCurrentFontSize = () => {
    if (draftDoc?.id) {
      return documentFontSizes[draftDoc.id] || documentFontSizes['_default'] || appSettings.fontSize;
    }
    return documentFontSizes['_default'] || appSettings.fontSize;
  };

  // Handle font size change
  const handleFontSizeChange = (newSize) => {
    const key = draftDoc?.id || '_default';
    const updated = { ...documentFontSizes, [key]: newSize };
    setDocumentFontSizes(updated);
    localStorage.setItem(`documentFontSizes_${instanceId}`, JSON.stringify(updated));
  };

  // Listen for theme, settings, preview mode, and font size changes from localStorage
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === `documentThemes_${instanceId}` && e.newValue) {
        setDocumentThemes(JSON.parse(e.newValue));
      }
      if (e.key === 'appSettings' && e.newValue) {
        setAppSettings(JSON.parse(e.newValue));
      }
      if (e.key === `documentPreviewModes_${instanceId}` && e.newValue) {
        setDocumentPreviewModes(JSON.parse(e.newValue));
      }
      if (e.key === `documentFontSizes_${instanceId}` && e.newValue) {
        setDocumentFontSizes(JSON.parse(e.newValue));
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [instanceId]);

  // Load documents on mount and restore last state for this instance
  useEffect(() => {
    loadAllDocuments();

    // Restore the last document for this instance if it exists
    const savedDocId = localStorage.getItem(`floatingDraftDocId_${instanceId}`);
    if (savedDocId) {
      getDocument(parseInt(savedDocId)).then(doc => {
        if (doc) {
          setDraftDoc(doc);
          setTitle(doc.title);
          setContent(doc.content || '');
          lastSavedRef.current = {
            content: doc.content || '',
            title: doc.title
          };
        } else {
          // Document was deleted, clear the saved ID
          localStorage.removeItem(`floatingDraftDocId_${instanceId}`);
        }
      });
    } else {
      // No saved document, restore unsaved draft content if it exists
      const savedTitle = localStorage.getItem(`floatingDraftTitle_${instanceId}`);
      const savedContent = localStorage.getItem(`floatingDraftContent_${instanceId}`);

      // Intentional restore of unsaved draft from localStorage per instance
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (savedTitle !== null) setTitle(savedTitle);
      if (savedContent !== null) setContent(savedContent);
    }
  }, [instanceId]);

  // Listen for custom event to open specific document or content
  useEffect(() => {
    async function handleOpenFloatingDraft(event) {
      const { documentId, content: newContent, title: newTitle } = event.detail || {};

      // If opening with just content (no document), create a new unsaved draft
      if (newContent !== undefined) {
        setDraftDoc(null);
        setTitle(newTitle || '');
        setContent(newContent || '');
        setIsOpen(true);
        setShowSearch(false);
        lastSavedRef.current = { content: '', title: '' };
        // Clear saved document reference
        localStorage.removeItem(`floatingDraftDocId_${instanceId}`);
        return;
      }

      // Otherwise open existing document by ID
      if (documentId) {
        const doc = await getDocument(documentId);
        if (doc) {
          setDraftDoc(doc);
          setTitle(doc.title);
          setContent(doc.content || '');
          setIsOpen(true);
          setShowSearch(false);
          lastSavedRef.current = {
            content: doc.content || '',
            title: doc.title
          };
          // Persist the current document ID for this instance
          localStorage.setItem(`floatingDraftDocId_${instanceId}`, documentId.toString());
          // Clear unsaved draft since we now have a saved document
          localStorage.removeItem(`floatingDraftTitle_${instanceId}`);
          localStorage.removeItem(`floatingDraftContent_${instanceId}`);
        }
        return;
      }

      // If no document or content specified, just open the window with current state
      setIsOpen(true);
      setIsMinimized(false);
    }

    window.addEventListener(eventName, handleOpenFloatingDraft);
    return () => window.removeEventListener(eventName, handleOpenFloatingDraft);
  }, [eventName, instanceId]);

  // Listen for toggle event from navbar (only for default instance)
  useEffect(() => {
    if (instanceId !== 'default') return;

    function handleToggle() {
      setIsOpen(prev => !prev);
      setIsMinimized(false);
    }

    window.addEventListener('toggleFloatingDraft', handleToggle);
    return () => window.removeEventListener('toggleFloatingDraft', handleToggle);
  }, [instanceId]);

  // Dispatch state change event for navbar (only for default instance)
  useEffect(() => {
    if (instanceId !== 'default') return;

    window.dispatchEvent(new CustomEvent('floatingDraftStateChange', {
      detail: { isOpen: isOpen && !isMinimized }
    }));
  }, [isOpen, isMinimized, instanceId]);

  // Listen for document updates from other components
  useEffect(() => {
    function handleDocumentUpdated(event) {
      const updatedDoc = event.detail;

      // If the updated document is the one currently open, update it
      if (draftDoc && draftDoc.id === updatedDoc.id) {
        setDraftDoc(prev => ({ ...prev, ...updatedDoc }));
      }
    }

    window.addEventListener('documentUpdated', handleDocumentUpdated);
    return () => window.removeEventListener('documentUpdated', handleDocumentUpdated);
  }, [draftDoc]);

  // OLD collaborative editing - REMOVED (FloatingDraft is now for local documents only)

  // Reload documents when opening the floating window
  useEffect(() => {
    if (isOpen) {
      loadAllDocuments();
    }
  }, [isOpen]);

  // Focus search input and reload documents when opening search
  useEffect(() => {
    if (showSearch) {
      loadAllDocuments();
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      }
    }
  }, [showSearch]);

  // Handle resize events
  useEffect(() => {
    if (!isResizing) return;

    function handleMouseMove(e) {
      const deltaX = e.clientX - resizeStartRef.current.x;
      const deltaY = e.clientY - resizeStartRef.current.y;

      const newWidth = Math.min(Math.max(resizeStartRef.current.width + deltaX, 320), 800);
      const newHeight = Math.min(Math.max(resizeStartRef.current.height + deltaY, 400), 800);

      setWidth(newWidth);
      setHeight(newHeight);
    }

    function handleMouseUp() {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Handle drag events
  useEffect(() => {
    if (!isDragging) return;

    function handleMouseMove(e) {
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;

      // Calculate new position
      const newLeft = dragStartRef.current.left + deltaX;
      const newTop = dragStartRef.current.top + deltaY;

      // Keep window within viewport bounds using window dimensions
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const boundedLeft = Math.max(0, Math.min(newLeft, viewportWidth - width));
      const boundedTop = Math.max(0, Math.min(newTop, viewportHeight - height));

      setPosition({ top: boundedTop, left: boundedLeft });
    }

    function handleMouseUp() {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, width, height]);

  // Persist unsaved draft content (only when no saved document)
  useEffect(() => {
    if (!draftDoc) {
      // Only persist draft when there's no saved document
      localStorage.setItem(`floatingDraftTitle_${instanceId}`, title);
      localStorage.setItem(`floatingDraftContent_${instanceId}`, content);
    }
  }, [title, content, draftDoc, instanceId]);

  // Save position to localStorage when it changes
  useEffect(() => {
    if (isOpen) {
      localStorage.setItem(`floatingDraftPosition_${instanceId}`, JSON.stringify(position));
    }
  }, [position, isOpen, instanceId]);

  // Save width and height to localStorage when they change
  useEffect(() => {
    if (isOpen) {
      localStorage.setItem(`floatingDraftWidth_${instanceId}`, width.toString());
      localStorage.setItem(`floatingDraftHeight_${instanceId}`, height.toString());
    }
  }, [width, height, isOpen, instanceId]);

  // Ensure window stays within viewport on resize
  useEffect(() => {
    if (!isOpen) return;

    const ensureVisible = () => {
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;

      const newTop = Math.max(0, Math.min(position.top, viewportHeight - height));
      const newLeft = Math.max(0, Math.min(position.left, viewportWidth - width));

      if (newTop !== position.top || newLeft !== position.left) {
        setPosition({ top: newTop, left: newLeft });
      }
    };

    window.addEventListener('resize', ensureVisible);
    return () => window.removeEventListener('resize', ensureVisible);
  }, [isOpen, height, width, position.top, position.left]);

  // Auto-save disabled for cloud documents - DocumentEditor/DocumentsPage handles it
  // Auto-save also disabled for local documents - they use manual save button
  useEffect(() => {
    if (!draftDoc) return;

    // Skip auto-save - cloud documents handled by DocumentEditor, local documents use manual save
    if (draftDoc.inCloud) {
      console.log('[FloatingDraft] Skipping auto-save for cloud document - DocumentEditor handles it');
      return;
    }

    // For local documents, don't auto-save - they use manual save button
    console.log('[FloatingDraft] Skipping auto-save for local document - using manual save');
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedContent, debouncedTitle]); // Removed draftDoc to prevent infinite loop

  // Check backend health when opening
  useEffect(() => {
    if (isOpen && backendStatus === 'checking') {
      checkBackendHealth();
    }
  }, [isOpen, backendStatus]);

  // Close selection menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (selectionMenuRef.current && !selectionMenuRef.current.contains(event.target)) {
        setSelectionMenu({ visible: false, x: 0, y: 0, text: '' });
      }
    }

    if (selectionMenu.visible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [selectionMenu.visible]);

  // Handle ESC key to close Quick AI popup
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        if (showQuickAI) {
          handleCancelQuickAI();
        } else if (showAskAI) {
          handleCancelAskAI();
        }
      }
    }

    if (showQuickAI || showAskAI) {
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
      };
    }
  }, [showQuickAI, showAskAI]);

  // Handle Quick AI popup dragging
  useEffect(() => {
    if (!isDraggingQuickAI) return;

    function handleMouseMove(e) {
      const deltaX = e.clientX - quickAIDragStartRef.current.x;
      const deltaY = e.clientY - quickAIDragStartRef.current.y;

      const newLeft = quickAIDragStartRef.current.left + deltaX;
      const newTop = quickAIDragStartRef.current.top + deltaY;

      setQuickAIPopupPos({ x: newLeft, y: newTop });
    }

    function handleMouseUp() {
      setIsDraggingQuickAI(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDraggingQuickAI]);

  // Handle Ask AI popup dragging
  useEffect(() => {
    if (!isDraggingAskAI) return;

    function handleMouseMove(e) {
      const deltaX = e.clientX - askAIDragStartRef.current.x;
      const deltaY = e.clientY - askAIDragStartRef.current.y;

      const newLeft = askAIDragStartRef.current.left + deltaX;
      const newTop = askAIDragStartRef.current.top + deltaY;

      setAskAIPopupPos({ x: newLeft, y: newTop });
    }

    function handleMouseUp() {
      setIsDraggingAskAI(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDraggingAskAI]);

  // Handle Ask AI popup resizing
  useEffect(() => {
    if (!isResizingAskAI) return;

    function handleMouseMove(e) {
      const deltaX = e.clientX - askAIResizeStartRef.current.x;
      const deltaY = e.clientY - askAIResizeStartRef.current.y;

      const newWidth = Math.max(300, askAIResizeStartRef.current.width + deltaX);
      const newHeight = Math.max(400, askAIResizeStartRef.current.height + deltaY);

      setAskAIPopupSize({ width: newWidth, height: newHeight });
    }

    function handleMouseUp() {
      setIsResizingAskAI(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingAskAI]);

  async function loadAllDocuments() {
    // Metadata only: this list is just searched/rendered by title/category;
    // opening a document goes through getDocument(id) for the full content.
    const docs = await getDocumentsMetadata();
    setAllDocuments(docs);
  }

  async function saveDraft() {
    if (!draftDoc || draftDoc.readOnly) return;

    setSaving(true);
    try {
      const updatedDoc = await updateDocument(draftDoc.id, {
        title: title.trim() || 'Untitled',
        content: content,
        category: draftDoc.category || 'General',
      });

      if (updatedDoc) {
        lastSavedRef.current = {
          content: content,
          title: title.trim() || 'Untitled'
        };

        // Update local state if title changed
        if (updatedDoc.title !== draftDoc.title) {
          setDraftDoc(updatedDoc);
          await loadAllDocuments();
        }

        // Dispatch event to notify other components (after updating local state to avoid loops)
        window.dispatchEvent(new CustomEvent('documentUpdated', { detail: updatedDoc }));

        // Note: Cloud sync removed - FloatingDraft is for local documents only
        // Cloud documents are edited in DocumentEditor which handles Yjs sync
      }
    } finally {
      setSaving(false);
    }
  }

  // Manual save function for local documents
  async function handleManualSave() {
    if (!draftDoc || draftDoc.readOnly || draftDoc.inCloud) return;

    console.log('[FloatingDraft] Manual save triggered for local document');
    await saveDraft();
  }

  function insertMarkdown(before, after = '', placeholder = 'text') {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end);
    const textToInsert = selectedText || placeholder;
    const newText = content.substring(0, start) + before + textToInsert + after + content.substring(end);

    setContent(newText);

    setTimeout(() => {
      const newCursorPos = start + before.length + textToInsert.length;
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }

  function insertList(ordered = false) {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end);

    let lineStart = start;
    while (lineStart > 0 && content[lineStart - 1] !== '\n') {
      lineStart--;
    }

    const beforeLine = content.substring(0, lineStart);
    const afterSelection = content.substring(end);

    const listMarker = ordered ? '1. ' : '- ';
    const textToInsert = selectedText || 'List item';

    const needsNewlineBefore = beforeLine.length > 0 && !beforeLine.endsWith('\n\n');
    const needsNewlineAfter = afterSelection.length > 0 && !afterSelection.startsWith('\n');

    const prefix = needsNewlineBefore ? '\n\n' : '';
    const suffix = needsNewlineAfter ? '\n\n' : '\n';

    const newText = beforeLine + prefix + listMarker + textToInsert + suffix + afterSelection;
    setContent(newText);

    setTimeout(() => {
      const newCursorPos = beforeLine.length + prefix.length + listMarker.length + textToInsert.length;
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }

  function insertCodeBlock() {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end);

    const beforeSelection = content.substring(0, start);
    const afterSelection = content.substring(end);

    const needsNewlineBefore = beforeSelection.length > 0 && !beforeSelection.endsWith('\n\n');
    const needsNewlineAfter = afterSelection.length > 0 && !afterSelection.startsWith('\n');

    const prefix = needsNewlineBefore ? '\n\n' : '';
    const suffix = needsNewlineAfter ? '\n\n' : '\n';

    const codeText = selectedText || 'code';
    const newText = beforeSelection + prefix + '```\n' + codeText + '\n```' + suffix + afterSelection;
    setContent(newText);

    setTimeout(() => {
      const newCursorPos = beforeSelection.length + prefix.length + 4;
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos + codeText.length);
    }, 0);
  }

  function insertTable() {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const beforeSelection = content.substring(0, start);
    const afterSelection = content.substring(start);

    const needsNewlineBefore = beforeSelection.length > 0 && !beforeSelection.endsWith('\n\n');
    const needsNewlineAfter = afterSelection.length > 0 && !afterSelection.startsWith('\n');

    const prefix = needsNewlineBefore ? '\n\n' : '';
    const suffix = needsNewlineAfter ? '\n\n' : '\n';

    const table = '| Header 1 | Header 2 | Header 3 |\n| -------- | -------- | -------- |\n| Cell 1   | Cell 2   | Cell 3   |';
    const newText = beforeSelection + prefix + table + suffix + afterSelection;
    setContent(newText);

    setTimeout(() => {
      const newCursorPos = beforeSelection.length + prefix.length + 2;
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos + 8);
    }, 0);
  }

  function insertHorizontalRule() {
    insertMarkdown('\n---\n', '');
  }

  function insertLink() {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end);

    const linkText = selectedText || 'link text';
    const beforeSelection = content.substring(0, start);
    const afterSelection = content.substring(end);

    const newText = beforeSelection + '[' + linkText + '](url)' + afterSelection;
    setContent(newText);

    setTimeout(() => {
      const urlStart = beforeSelection.length + linkText.length + 3;
      textarea.focus();
      textarea.setSelectionRange(urlStart, urlStart + 3);
    }, 0);
  }

  function indentText(increase = true) {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    let lineStart = start;
    while (lineStart > 0 && content[lineStart - 1] !== '\n') {
      lineStart--;
    }

    let lineEnd = end;
    while (lineEnd < content.length && content[lineEnd] !== '\n') {
      lineEnd++;
    }

    const beforeLines = content.substring(0, lineStart);
    const selectedLines = content.substring(lineStart, lineEnd);
    const afterLines = content.substring(lineEnd);

    let newLines;
    if (increase) {
      newLines = selectedLines.split('\n').map(line => '  ' + line).join('\n');
    } else {
      newLines = selectedLines.split('\n').map(line => {
        if (line.startsWith('  ')) return line.substring(2);
        if (line.startsWith(' ')) return line.substring(1);
        return line;
      }).join('\n');
    }

    const newText = beforeLines + newLines + afterLines;
    setContent(newText);

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(lineStart, lineStart + newLines.length);
    }, 0);
  }

  // Backend health check
  async function checkBackendHealth() {
    setCheckingBackend(true);
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/ai/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });

      if (response.ok) {
        setBackendStatus('online');
      } else {
        setBackendStatus('offline');
      }
    } catch {
      setBackendStatus('offline');
    } finally {
      setCheckingBackend(false);
    }
  }

  // Handle text selection context menu
  function handleTextSelectionContextMenu(e) {
    e.preventDefault();
    const textarea = textareaRef.current;
    if (!textarea) return;

    const selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);

    setSelectionMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      text: selectedText && selectedText.trim() ? selectedText : ''
    });
  }

  // Sanitize sensitive data
  function detectSensitiveData(text) {
    let sanitized = text;
    let replacementCount = 0;

    // Replace IP addresses
    sanitized = sanitized.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (match) => {
      if (match === '127.0.0.1' || match === '0.0.0.0') {
        return match;
      }
      replacementCount++;
      return `<IP_${replacementCount}>`;
    });

    // Replace hostnames/domains
    sanitized = sanitized.replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi, (match) => {
      if (match === 'localhost' || match === 'example.com') {
        return match;
      }
      replacementCount++;
      return `<HOSTNAME_${replacementCount}>`;
    });

    return sanitized;
  }

  // Open Ask AI About This popup
  function handleAskAIAboutThis() {
    if (!selectionMenu.text) return;

    const sanitized = detectSensitiveData(selectionMenu.text);
    setAskAISanitizedText(sanitized);
    setAskAIPrompt('');
    setAskAIResponse('');
    setAskAISelectedResponse('');

    // Position popup near the selection menu
    setAskAIPopupPos({ x: selectionMenu.x, y: selectionMenu.y });
    setShowAskAI(true);
    setSelectionMenu({ visible: false, x: 0, y: 0, text: '' });

    setTimeout(() => {
      if (askAIPromptRef.current) {
        askAIPromptRef.current.focus();
      }
    }, 100);
  }

  // Submit Ask AI request
  async function handleAskAISubmit() {
    if (!askAISanitizedText.trim()) return;

    setAskAILoading(true);
    setAskAIResponse('');

    // Settings > Default AI through /api/ai/models (src/utils/aiRequestSettings.js)
    let aiSettings = null;
    try {
      aiSettings = await resolveAiRequestSettings({ saved: savedAiChatSettings() });
    } catch (error) {
      setAskAIResponse('Error: ' + error.message);
      setAskAILoading(false);
      return;
    }
    if (!aiSettings) {
      setAskAIResponse(NO_AI_PROVIDER_MESSAGE);
      setAskAILoading(false);
      return;
    }

    const fullMessage = askAIPrompt.trim()
      ? `${askAIPrompt}\n\n${askAISanitizedText}`
      : askAISanitizedText;

    const backendUrl = await getBackendUrl();
    await apiFetch(`${backendUrl}/api/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: fullMessage,
        provider: aiSettings.provider,
        model: aiSettings.model,
        temperature: aiSettings.temperature,
        maxTokens: aiSettings.maxTokens
      }),
      signal: AbortSignal.timeout(30000)
    })
      .then(res => res.json())
      .then(data => {
        if (data.response) {
          setAskAIResponse(data.response);
        } else if (data.error) {
          setAskAIResponse('Error: ' + data.error);
        } else {
          setAskAIResponse('Error: No response from AI');
        }
      })
      .catch(err => {
        setAskAIResponse('Error: ' + err.message);
      })
      .finally(() => {
        setAskAILoading(false);
      });
  }

  function handleAskAIResponseSelection() {
    if (!askAIResponseRef.current) return;

    const textarea = askAIResponseRef.current;
    const selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
    setAskAISelectedResponse(selectedText);
  }

  function handleInsertAskAIResponse(useSelection = false) {
    const textToInsert = useSelection && askAISelectedResponse ? askAISelectedResponse : askAIResponse;

    if (!textToInsert) {
      setShowAskAI(false);
      return;
    }

    // Insert at current cursor position in editor
    const textarea = textareaRef.current;
    if (textarea) {
      const cursorPos = textarea.selectionStart;
      const newContent = content.substring(0, cursorPos) + textToInsert + content.substring(cursorPos);
      setContent(newContent);

      setTimeout(() => {
        textarea.focus();
        const newPos = cursorPos + textToInsert.length;
        textarea.setSelectionRange(newPos, newPos);
      }, 0);
    }

    setShowAskAI(false);
    setAskAIPrompt('');
    setAskAISanitizedText('');
    setAskAIResponse('');
    setAskAISelectedResponse('');
  }

  function handleCancelAskAI() {
    setShowAskAI(false);
    setAskAIPrompt('');
    setAskAISanitizedText('');
    setAskAIResponse('');
    setAskAISelectedResponse('');
  }

  // Quick AI command handlers
  async function handleQuickAISubmit() {
    if (!quickAIInput.trim()) return;

    setQuickAILoading(true);
    setQuickAIResponse('');

    // Settings > Default AI through /api/ai/models (src/utils/aiRequestSettings.js)
    let aiSettings = null;
    try {
      aiSettings = await resolveAiRequestSettings({ saved: savedAiChatSettings() });
    } catch (error) {
      setQuickAIResponse('Error: ' + error.message);
      setQuickAILoading(false);
      return;
    }
    if (!aiSettings) {
      setQuickAIResponse(NO_AI_PROVIDER_MESSAGE);
      setQuickAILoading(false);
      return;
    }

    const systemPrompt = 'You are a code assistant. Respond ONLY with the requested code, command, or text. Do NOT include explanations, markdown formatting, or comments unless specifically requested. Be extremely concise.';

    const backendUrl = await getBackendUrl();
    apiFetch(`${backendUrl}/api/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: quickAIInput,
        systemPrompt: systemPrompt,
        provider: aiSettings.provider,
        model: aiSettings.model,
        temperature: aiSettings.temperature,
        maxTokens: aiSettings.maxTokens
      }),
      signal: AbortSignal.timeout(30000)
    })
      .then(res => res.json())
      .then(data => {
        if (data.response) {
          setQuickAIResponse(data.response);
        } else if (data.error) {
          setQuickAIResponse('Error: ' + data.error);
        } else {
          setQuickAIResponse('Error: No response from AI');
        }
      })
      .catch(err => {
        setQuickAIResponse('Error: ' + err.message);
      })
      .finally(() => {
        setQuickAILoading(false);
      });
  }

  function handleAcceptAIResponse(useSelection = false) {
    const textToInsert = useSelection && quickAISelectedText ? quickAISelectedText : quickAIResponse;

    if (!textToInsert || quickAICursorPos === null || quickAICursorPos === undefined) {
      setShowQuickAI(false);
      return;
    }

    const currentContent = content;
    let insertPos = quickAICursorPos;
    let baseContent = currentContent;

    const textBeforeCursor = currentContent.substring(0, quickAICursorPos);
    if (textBeforeCursor.endsWith('/ai')) {
      baseContent = currentContent.substring(0, quickAICursorPos - 3) + currentContent.substring(quickAICursorPos);
      insertPos = quickAICursorPos - 3;
    }

    const newContent = baseContent.substring(0, insertPos) + textToInsert + baseContent.substring(insertPos);
    setContent(newContent);

    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const newPos = insertPos + textToInsert.length;
        textareaRef.current.setSelectionRange(newPos, newPos);
      }
    }, 0);

    setShowQuickAI(false);
    setQuickAIInput('');
    setQuickAIResponse('');
    setQuickAICursorPos(null);
    setQuickAISelectedText('');
  }

  function handleQuickAIResponseSelection() {
    if (!quickAIResponseRef.current) return;

    const textarea = quickAIResponseRef.current;
    const selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
    setQuickAISelectedText(selectedText);
  }

  function handleCancelQuickAI() {
    setShowQuickAI(false);
    setQuickAIInput('');
    setQuickAIResponse('');
    setQuickAICursorPos(null);
    setQuickAISelectedText('');
  }

  // Quick AI drag handlers
  function handleQuickAIDragStart(e) {
    setIsDraggingQuickAI(true);
    quickAIDragStartRef.current = {
      left: quickAIPopupPos.x,
      top: quickAIPopupPos.y,
      x: e.clientX,
      y: e.clientY
    };
  }

  // Ask AI drag handlers
  function handleAskAIDragStart(e) {
    setIsDraggingAskAI(true);
    askAIDragStartRef.current = {
      left: askAIPopupPos.x,
      top: askAIPopupPos.y,
      x: e.clientX,
      y: e.clientY
    };
  }

  // Ask AI resize handlers
  function handleAskAIResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsResizingAskAI(true);
    askAIResizeStartRef.current = {
      width: askAIPopupSize.width,
      height: askAIPopupSize.height,
      x: e.clientX,
      y: e.clientY
    };
  }

  // Cursor tracking (no longer needed for collaborative editing - FloatingDraft is local only)
  function handleCursorMove() {
    // No-op: FloatingDraft is for local documents only, no cursor sharing needed
  }

  function handleEditorInput() {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = textarea.value.substring(0, cursorPos);

    if (textBeforeCursor.endsWith('/ai') && (cursorPos === 3 || /\s$/.test(textBeforeCursor.substring(0, cursorPos - 3)))) {
      const rect = textarea.getBoundingClientRect();
      const textareaStyle = window.getComputedStyle(textarea);
      const fontSize = parseFloat(textareaStyle.fontSize);
      const lineHeight = parseFloat(textareaStyle.lineHeight) || fontSize * 1.5;

      const textBeforePos = textarea.value.substring(0, cursorPos - 3);
      const lines = textBeforePos.split('\n');
      const currentLine = lines.length;
      const charInLine = lines[lines.length - 1].length;

      const charWidth = fontSize * 0.6;
      // Use absolute position from getBoundingClientRect (already accounts for floating window position)
      const x = rect.left + parseFloat(textareaStyle.paddingLeft) + (charInLine * charWidth);
      const y = rect.top + parseFloat(textareaStyle.paddingTop) + (currentLine * lineHeight) - textarea.scrollTop;

      const popupWidth = 400;
      const popupHeight = 300;
      // Ensure popup stays within viewport
      const adjustedX = Math.min(Math.max(20, x), window.innerWidth - popupWidth - 20);
      const adjustedY = Math.min(Math.max(60, y), window.innerHeight - popupHeight - 20);

      setQuickAIPopupPos({ x: adjustedX, y: adjustedY });
      setQuickAICursorPos(cursorPos);
      setShowQuickAI(true);

      setTimeout(() => {
        if (quickAIInputRef.current) {
          quickAIInputRef.current.focus();
        }
      }, 100);
    }
  }

  if (!isOpen) {
    return null;
  }

  if (isMinimized) {
    return createPortal(
      <div
        className={`fixed rounded-md shadow-lg flex items-center gap-3 px-4 py-2.5 cursor-grab active:cursor-grabbing drag-handle ${
 instanceId ==='converter'?'bg-os-blue':'bg-[#151515]'
 }`}
        style={{
          top: `${position.top}px`,
          left: `${position.left}px`,
          zIndex: 2147483647,
          position: 'fixed',
          isolation: 'isolate',
          pointerEvents: 'auto',
          transform: 'translateZ(0)'
        }}
        onMouseDown={handleDragStart}
      >
        <Pencil size={15} className="text-white shrink-0" />
        <span className="text-sm font-medium text-white max-w-[180px] truncate">{title || draftDoc?.title || 'New Document'}</span>
        {/* Cloud documents: show saving spinner */}
        {draftDoc?.inCloud && saving && <RefreshCw size={12} className="animate-spin text-white/70 shrink-0" />}
        {/* Local documents: show unsaved indicator */}
        {!saving && (
          (draftDoc && !draftDoc.inCloud && (content !== lastSavedRef.current.content || title !== lastSavedRef.current.title)) ||
          (!draftDoc && (content.trim() || title.trim()))
        ) && (
          <span className="text-xs text-orange-400 shrink-0">•</span>
        )}
        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => setIsMinimized(false)}
            className="p-1 hover:bg-white/20 rounded-sm transition-colors"
            title="Maximize"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1 hover:bg-white/20 rounded-sm transition-colors"
            title="Close"
          >
            <X size={14} className="text-white" />
          </button>
        </div>
      </div>,
      document.body
    );
  }

  function handleResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStartRef.current = {
      width,
      height,
      x: e.clientX,
      y: e.clientY
    };
    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
  }

  function handleDragStart(e) {
    // Check if clicking on or inside an interactive element
    let element = e.target;
    while (element) {
      if (element.tagName === 'BUTTON' || element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA') {
        return; // Don't drag if clicking interactive elements
      }
      if (element.classList && element.classList.contains('drag-handle')) {
        break; // Found the drag handle, allow dragging
      }
      element = element.parentElement;
    }

    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      top: position.top,
      left: position.left,
      x: e.clientX,
      y: e.clientY
    };
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }

  return (
    <>
      {createPortal(
        <div
          className="fixed bg-os-card rounded-md shadow-2xl flex flex-col relative border border-os-border"
          style={{
        width: `${width}px`,
        height: `${height}px`,
        top: `${position.top}px`,
        left: `${position.left}px`,
        zIndex: 2147483647,
        position: 'fixed',
        isolation: 'isolate',
        pointerEvents: 'auto',
        transform: 'translateZ(0)'
      }}
    >
      {/* Header */}
      <div
        className="px-4 py-2.5 flex items-center justify-between cursor-grab active:cursor-grabbing drag-handle relative rounded-t-md bg-os-masthead"
        onMouseDown={handleDragStart}
      >
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <Pencil size={15} className="text-white shrink-0" />
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            readOnly={draftDoc?.readOnly}
            onFocus={(e) => {
              if (draftDoc?.readOnly) {
                e.target.blur();
              }
            }}
            placeholder="Untitled document"
            className={`field-inline text-sm bg-transparent border-none outline-hidden ${draftDoc?.readOnly ?'cursor-default':'focus:bg-os-card focus:px-2 focus:py-1 focus:text-os-text-primary'} rounded-sm transition-all flex-1 min-w-0 text-white placeholder:text-gray-300`}
          />
          {draftDoc?.readOnly && (
            <div className="flex items-center gap-1 px-2 py-0.5 bg-white/20 text-white text-xs rounded-sm shrink-0">
              <EyeOff size={12} />
              <span>Read-Only</span>
            </div>
          )}
          {/* For cloud documents: show Saving indicator when saving */}
          {draftDoc?.inCloud && saving && (
            <span className="flex items-center gap-1 text-xs text-white/70 shrink-0">
              <RefreshCw size={11} className="animate-spin" />
              Saving...
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setIsMinimized(true)}
            className="p-1.5 hover:bg-white/20 rounded-sm transition-colors"
            title="Minimize"
          >
            <Minus size={14} className="text-white" />
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1.5 hover:bg-white/20 rounded-sm transition-colors"
            title="Close"
          >
            <X size={14} className="text-white" />
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div
        className={`px-2 py-1.5 border-b border-os-border flex items-center gap-0.5 flex-wrap bg-os-card-secondary ${draftDoc?.readOnly ?'opacity-50 pointer-events-none':''}`}
        onContextMenu={(e) => {
          e.preventDefault();

          setEditorSettingsPos({ x: e.clientX, y: e.clientY });
          setShowEditorSettings(true);
        }}
      >
        {/* Text Formatting */}
        <button
          onClick={() => insertMarkdown('**', '**', 'bold')}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Bold (Ctrl+B)"
        >
          <Bold size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={() => insertMarkdown('*', '*', 'italic')}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Italic (Ctrl+I)"
        >
          <Italic size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={() => insertMarkdown('~~', '~~', 'strikethrough')}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Strikethrough"
        >
          <Strikethrough size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={() => insertMarkdown('`', '`', 'code')}
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

        <div className="w-px h-6 bg-os-border mx-1" />

        {/* Headings */}
        <button
          onClick={() => insertMarkdown('# ', '', 'Heading 1')}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Heading 1"
        >
          <Heading1 size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={() => insertMarkdown('## ', '', 'Heading 2')}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Heading 2"
        >
          <Heading2 size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={() => insertMarkdown('### ', '', 'Heading 3')}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Heading 3"
        >
          <Heading3 size={16} className="text-os-text-primary" />
        </button>

        <div className="w-px h-6 bg-os-border mx-1" />

        {/* Lists */}
        <button
          onClick={() => insertList(false)}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Bullet list"
        >
          <List size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={() => insertList(true)}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Numbered list"
        >
          <ListOrdered size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={() => indentText(false)}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Decrease indent"
        >
          <IndentDecrease size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={() => indentText(true)}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Increase indent"
        >
          <IndentIncrease size={16} className="text-os-text-primary" />
        </button>

        <div className="w-px h-6 bg-os-border mx-1" />

        {/* Insert */}
        <button
          onClick={insertLink}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Insert link"
        >
          <Link size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={insertTable}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Insert table"
        >
          <Table size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={() => insertMarkdown('> ', '', 'quote')}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Quote"
        >
          <Quote size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={insertHorizontalRule}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Horizontal rule"
        >
          <Minus size={16} className="text-os-text-primary" />
        </button>
        <button
          onClick={() => insertMarkdown('#', '', 'tag')}
          className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
          title="Insert tag"
        >
          <Tag size={16} className="text-os-text-primary" />
        </button>

        <div className="w-px h-6 bg-os-border mx-1" />

        {/* Preview Toggle */}
        <button
          onClick={togglePreviewMode}
          className={`p-1.5 transition-colors ${
 isPreviewMode()
 ?'bg-os-blue text-white'
 :'hover:bg-os-card-secondary'
 }`}
          title={isPreviewMode() ? 'Edit' : 'Preview'}
        >
          {isPreviewMode() ? (
            <Edit3 size={16} className="text-white" />
          ) : (
            <Eye size={16} className="text-os-text-primary" />
          )}
        </button>
      </div>

      {/* Editor */}
      {isPreviewMode() ? (
        <div
          className="markdown-preview flex-1 px-4 py-3 overflow-y-auto overflow-x-hidden bg-os-card text-os-text-primary"
          style={{
            fontSize: `${getCurrentFontSize()}px`,
            lineHeight: appSettings.lineHeight
          }}
          dangerouslySetInnerHTML={{
            __html: content ? DOMPurify.sanitize(marked(content)) : '<p class="text-os-text-muted">No content to preview</p>'
          }}
        />
      ) : (
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
            }}
            onInput={handleEditorInput}
            onKeyDown={(e) => {
              // Ctrl+S / Cmd+S to save (for local documents only)
              if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S') && draftDoc && !draftDoc.inCloud && !draftDoc.readOnly) {
                e.preventDefault();
                handleManualSave();
              }
            }}
            onClick={() => {
              showEditorSettings && setShowEditorSettings(false);
              handleCursorMove();
            }}
            onMouseUp={handleCursorMove}
            onKeyUp={handleCursorMove}
            onContextMenu={handleTextSelectionContextMenu}
            readOnly={draftDoc?.readOnly}
            className={`flex-1 w-full h-full px-4 py-3 font-mono resize-none outline-hidden bg-os-card text-os-text-primary placeholder:text-os-text-muted border-0 ${draftDoc?.readOnly ?'cursor-default opacity-75':''}`}
            style={{
              fontSize: `${getCurrentFontSize()}px`,
              lineHeight: appSettings.lineHeight
            }}
            placeholder={draftDoc?.readOnly ? "This document is read-only" : "Write your notes in Markdown..."}
          />
        </div>
      )}

      {/* Resize Handle */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize group hover:bg-os-card-secondary rounded-tl transition-colors"
        title="Drag to resize"
      >
        <svg
          className="absolute bottom-1 right-1 text-os-text-muted group-hover:text-os-text-primary transition-colors pointer-events-none"
          width="12"
          height="12"
          viewBox="0 0 12 12"
        >
          <path
            d="M11 11 L11 8 M11 11 L8 11 M11 5 L11 2 L8 2 M5 11 L2 11 L2 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </div>
    </div>,
    document.body
  )}

  {/* Text Selection Context Menu */}
  {selectionMenu.visible && createPortal(
    <div
      ref={selectionMenuRef}
      className="fixed bg-os-card border border-os-border rounded-sm shadow-lg py-1"
      style={{
        left: `${selectionMenu.x}px`,
        top: `${selectionMenu.y}px`,
        zIndex: 2147483647,
        position: 'fixed',
        pointerEvents: 'auto'
      }}
    >
      {selectionMenu.text && (
        <button
          onClick={handleAskAIAboutThis}
          className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
        >
          <MenuItemIcon action="aiContext" />
          Ask AI About This
        </button>
      )}
      {!selectionMenu.text && (
        <div className="px-4 py-2 text-sm text-os-text-muted italic">
          Select text to use AI features
        </div>
      )}
    </div>,
    document.body
  )}

  {/* Quick AI Command Popup */}
  {showQuickAI && createPortal(
    <>
          <div
            className="fixed inset-0"
            onClick={handleCancelQuickAI}
            style={{
              zIndex: 2147483646,
              position: 'fixed',
              pointerEvents: 'auto'
            }}
          />
          <div
            className="fixed bg-os-card rounded-lg shadow-2xl border border-os-border"
            style={{
              left: `${quickAIPopupPos.x}px`,
              top: `${quickAIPopupPos.y}px`,
              width: '400px',
              maxHeight: '500px',
              zIndex: 2147483647,
              position: 'fixed',
              pointerEvents: 'auto'
            }}
          >
            <div
              className="px-3 py-2 border-b border-os-border flex items-center justify-between bg-linear-to-r from-purple-50 to-purple-100 cursor-grab active:cursor-grabbing"
              onMouseDown={handleQuickAIDragStart}
            >
              <div className="flex items-center gap-2">
                <Bot size={16} className="text-purple-600" />
                <span className="text-sm font-semibold text-purple-900">Quick AI</span>
              </div>
              <div className="flex items-center gap-1">
                {quickAIResponse && !quickAILoading && (
                  <button
                    onClick={() => {
                      setQuickAIResponse('');
                      setQuickAIInput('');
                      setQuickAISelectedText('');
                      setTimeout(() => quickAIInputRef.current?.focus(), 0);
                    }}
                    className="p-1 hover:bg-purple-200 rounded-sm transition-colors"
                    title="Clear response"
                  >
                    <Trash2 size={14} className="text-purple-700" />
                  </button>
                )}
                <button
                  onClick={handleCancelQuickAI}
                  className="p-1 hover:bg-purple-200 rounded-sm transition-colors"
                  title="Close (Esc)"
                >
                  <X size={14} className="text-purple-700" />
                </button>
              </div>
            </div>

            {backendStatus === 'offline' && (
              <div className="bg-red-50 dark:bg-red-900/20 px-3 py-2">
                <div className="flex items-start gap-2">
                  <AlertCircle size={14} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-xs font-medium text-red-800 dark:text-red-200">Backend offline</p>
                  </div>
                  <button
                    onClick={() => {
                      setBackendStatus('checking');
                      checkBackendHealth();
                    }}
                    disabled={checkingBackend}
                    className="p-1 hover:bg-red-100 rounded-sm transition-colors disabled:opacity-50"
                    title="Retry connection"
                    aria-label="Retry connection"
                  >
                    <RefreshCw size={12} className={checkingBackend ? 'animate-spin text-red-600' : 'text-red-600'} />
                  </button>
                </div>
              </div>
            )}

            <div className="px-3 py-3 space-y-3">
              <div>
                <input
                  ref={quickAIInputRef}
                  type="text"
                  value={quickAIInput}
                  onChange={(e) => setQuickAIInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !quickAILoading && backendStatus === 'online') {
                      e.preventDefault();
                      handleQuickAISubmit();
                    } else if (e.key === 'Escape') {
                      handleCancelQuickAI();
                    }
                  }}
                  placeholder="for loop in bash, sort function..."
                  disabled={quickAILoading || backendStatus === 'offline'}
                  className="w-full px-2 py-1.5 text-sm border border-purple-300 rounded-sm bg-os-input-bg text-os-text-primary focus:outline-hidden focus:border-purple-500 focus:ring-1 focus:ring-purple-500 disabled:opacity-60 disabled:cursor-not-allowed"
                />
                <p className="text-xs text-os-text-secondary mt-1">Enter to submit • Esc to cancel</p>
              </div>

              {(quickAIResponse || quickAILoading) && (
                <div>
                  <div className="relative">
                    <textarea
                      ref={quickAIResponseRef}
                      value={quickAILoading ? 'Generating response...' : quickAIResponse}
                      readOnly={quickAILoading}
                      onSelect={handleQuickAIResponseSelection}
                      onMouseUp={handleQuickAIResponseSelection}
                      className="w-full h-48 px-2 py-2 border border-os-border rounded-sm bg-os-card-secondary font-mono text-xs resize-none focus:outline-hidden cursor-text"
                    />
                    {quickAILoading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-white/75 rounded-sm">
                        <RefreshCw size={20} className="text-purple-600 animate-spin" />
                      </div>
                    )}
                  </div>
                  {quickAISelectedText && !quickAILoading && (
                    <p className="text-xs text-purple-600 mt-1">
                      {quickAISelectedText.length} characters selected
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="px-3 py-2 border-t border-os-border flex justify-end gap-2 bg-os-card-secondary">
              {!quickAIResponse ? (
                <button
                  onClick={handleQuickAISubmit}
                  disabled={!quickAIInput.trim() || quickAILoading || backendStatus === 'offline'}
                  className="flex-1 px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded-sm transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={backendStatus === 'offline' ? 'Backend service is not running' : 'Generate (Enter)'}
                >
                  {quickAILoading ? 'Generating...' : 'Generate'}
                </button>
              ) : (
                !quickAILoading && (
                  <button
                    onClick={() => handleAcceptAIResponse(true)}
                    disabled={!quickAISelectedText}
                    className="flex-1 px-3 py-1.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded-sm transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={quickAISelectedText ? 'Insert selected text' : 'Select text in the response to insert'}
                  >
                    <Check size={14} />
                    Insert Selected
                  </button>
                )
              )}
            </div>
          </div>
        </>,
        document.body
      )}

      {/* Ask AI About This Popup */}
      {showAskAI && createPortal(
        <>
          <div
            className="fixed inset-0"
            onClick={handleCancelAskAI}
            style={{
              zIndex: 2147483646,
              position: 'fixed',
              pointerEvents: 'auto'
            }}
          />
          <div
            className="fixed bg-os-card rounded-lg shadow-2xl border border-os-border"
            style={{
              left: `${askAIPopupPos.x}px`,
              top: `${askAIPopupPos.y}px`,
              width: `${askAIPopupSize.width}px`,
              height: `${askAIPopupSize.height}px`,
              zIndex: 2147483647,
              position: 'fixed',
              pointerEvents: 'auto',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div
              className="px-3 py-2 border-b border-os-border flex items-center justify-between bg-linear-to-r from-purple-50 to-purple-100 cursor-grab active:cursor-grabbing shrink-0"
              onMouseDown={handleAskAIDragStart}
            >
              <div className="flex items-center gap-2">
                <Bot size={16} className="text-purple-600" />
                <span className="text-sm font-semibold text-purple-900">Ask AI About This</span>
              </div>
              <div className="flex items-center gap-1">
                {askAIResponse && !askAILoading && (
                  <button
                    onClick={() => {
                      setAskAIResponse('');
                      setAskAIPrompt('');
                      setAskAISelectedResponse('');
                      setTimeout(() => askAIPromptRef.current?.focus(), 0);
                    }}
                    className="p-1 hover:bg-purple-200 rounded-sm transition-colors"
                    title="Clear response"
                  >
                    <Trash2 size={14} className="text-purple-700" />
                  </button>
                )}
                <button
                  onClick={handleCancelAskAI}
                  className="p-1 hover:bg-purple-200 rounded-sm transition-colors"
                  title="Close (Esc)"
                >
                  <X size={14} className="text-purple-700" />
                </button>
              </div>
            </div>

            {backendStatus === 'offline' && (
              <div className="bg-red-50 dark:bg-red-900/20 px-3 py-2 shrink-0">
                <div className="flex items-start gap-2">
                  <AlertCircle size={14} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-xs font-medium text-red-800 dark:text-red-200">Backend offline</p>
                  </div>
                  <button
                    onClick={() => {
                      setBackendStatus('checking');
                      checkBackendHealth();
                    }}
                    disabled={checkingBackend}
                    className="p-1 hover:bg-red-100 rounded-sm transition-colors disabled:opacity-50"
                    title="Retry connection"
                    aria-label="Retry connection"
                  >
                    <RefreshCw size={12} className={checkingBackend ? 'animate-spin text-red-600' : 'text-red-600'} />
                  </button>
                </div>
              </div>
            )}

            <div className="px-3 py-3 flex flex-col gap-3 overflow-y-auto flex-1">
              <div className="shrink-0">
                <label className="block text-xs text-os-text-primary mb-1">Your question or prompt (optional):</label>
                <input
                  ref={askAIPromptRef}
                  type="text"
                  value={askAIPrompt}
                  onChange={(e) => setAskAIPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !askAILoading && backendStatus === 'online') {
                      e.preventDefault();
                      handleAskAISubmit();
                    } else if (e.key === 'Escape') {
                      handleCancelAskAI();
                    }
                  }}
                  placeholder="e.g., Explain this, Fix this code, Summarize..."
                  disabled={askAILoading || backendStatus === 'offline'}
                  className="w-full px-2 py-1.5 text-sm border border-purple-300 rounded-sm bg-os-card focus:outline-hidden focus:border-purple-500 focus:ring-1 focus:ring-purple-500 disabled:bg-os-card-secondary disabled:text-os-text-secondary"
                />
              </div>

              <div className="flex-1 flex flex-col min-h-0">
                <label className="block text-xs text-os-text-primary mb-1 shrink-0">Selected text (sanitized):</label>
                <textarea
                  value={askAISanitizedText}
                  onChange={(e) => setAskAISanitizedText(e.target.value)}
                  disabled={askAILoading}
                  className="w-full h-full px-2 py-2 border border-os-border rounded-sm bg-os-card-secondary font-mono text-xs resize-none focus:outline-hidden focus:border-purple-500 disabled:opacity-75"
                />
              </div>

              {(askAIResponse || askAILoading) && (
                <div className="flex-1 flex flex-col min-h-0">
                  <label className="block text-xs text-os-text-primary mb-1 shrink-0">
                    {askAILoading ? 'Generating response...' : 'Response:'}
                  </label>
                  <div className="relative flex-1">
                    <textarea
                      ref={askAIResponseRef}
                      value={askAILoading ? 'Generating response...' : askAIResponse}
                      readOnly={askAILoading}
                      onSelect={handleAskAIResponseSelection}
                      onMouseUp={handleAskAIResponseSelection}
                      className="w-full h-full px-2 py-2 border border-os-border rounded-sm bg-os-card-secondary font-mono text-xs resize-none focus:outline-hidden cursor-text"
                    />
                    {askAILoading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-white/75 rounded-sm">
                        <RefreshCw size={20} className="text-purple-600 animate-spin" />
                      </div>
                    )}
                  </div>
                  {askAISelectedResponse && !askAILoading && (
                    <p className="text-xs text-purple-600 mt-1 shrink-0">
                      {askAISelectedResponse.length} characters selected
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="px-3 py-2 border-t border-os-border flex justify-end gap-2 bg-os-card-secondary shrink-0">
              {!askAIResponse ? (
                <button
                  onClick={handleAskAISubmit}
                  disabled={!askAISanitizedText.trim() || askAILoading || backendStatus === 'offline'}
                  className="flex-1 px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded-sm transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={backendStatus === 'offline' ? 'Backend service is not running' : 'Ask AI (Enter)'}
                >
                  {askAILoading ? 'Asking...' : 'Ask AI'}
                </button>
              ) : (
                !askAILoading && (
                  <button
                    onClick={() => handleInsertAskAIResponse(true)}
                    disabled={!askAISelectedResponse}
                    className="flex-1 px-3 py-1.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded-sm transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={askAISelectedResponse ? 'Insert selected text' : 'Select text in the response to insert'}
                  >
                    <Check size={14} />
                    Insert Selected
                  </button>
                )
              )}
            </div>

            {/* Resize handle */}
            <div
              onMouseDown={handleAskAIResizeStart}
              className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
              style={{
                background: 'linear-gradient(135deg, transparent 50%, #9333ea 50%)',
                borderBottomRightRadius: '0.5rem'
              }}
              title="Drag to resize"
            />
          </div>
        </>,
        document.body
      )}

      {/* Editor Settings Menu */}
      {showEditorSettings && createPortal(
        <>
          <div
            className="fixed inset-0"
            onClick={() => setShowEditorSettings(false)}
            style={{ zIndex: 2147483646 }}
          />
          <div
            ref={editorSettingsMenuRef}
            className="fixed w-64 bg-os-card border border-os-border rounded-sm shadow-lg"
            style={{
              left: `${editorSettingsPos.x}px`,
              top: `${editorSettingsPos.y}px`,
              zIndex: 2147483647
            }}
          >
            <div className="py-2">
              {/* Theme Selector */}
              <div className="px-4 py-2">
                <label className="block text-xs text-os-text-secondary mb-1.5">
                  Editor Theme
                </label>
                <div className="flex items-center gap-2">
                  <Palette size={14} className="text-os-text-secondary" />
                  <select
                    value={getCurrentTheme()}
                    onChange={(e) => {
                      handleThemeChange(e.target.value);
                      setShowEditorSettings(false);
                    }}
                    className="flex-1 px-2 py-1.5 text-sm border border-os-input-border bg-os-card hover:bg-os-card-secondary transition-colors rounded-sm"
                  >
                    {Object.entries(editorThemes).map(([key, theme]) => (
                      <option key={key} value={key}>{theme.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="border-t border-os-border my-1"></div>

              {/* Font Size Selector */}
              <div className="px-4 py-2">
                <label className="block text-xs text-os-text-secondary mb-1.5">
                  Font Size
                </label>
                <select
                  value={getCurrentFontSize()}
                  onChange={(e) => {
                    handleFontSizeChange(e.target.value);
                    setShowEditorSettings(false);
                  }}
                  className="w-full px-2 py-1.5 text-sm border border-os-input-border bg-os-card hover:bg-os-card-secondary transition-colors rounded-sm"
                >
                  <option value="10">10px</option>
                  <option value="11">11px</option>
                  <option value="12">12px</option>
                  <option value="13">13px</option>
                  <option value="14">14px</option>
                  <option value="16">16px</option>
                  <option value="18">18px</option>
                  <option value="20">20px</option>
                  <option value="22">22px</option>
                  <option value="24">24px</option>
                </select>
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
}
