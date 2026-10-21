import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useShortcut } from '../shortcuts/useShortcut';
import { useLocalStorage } from '../hooks/useLocalStorage';
import useSyncedOpenTabs from '../hooks/useSyncedOpenTabs';
import { db as database } from '../db/database';
import { BUILTIN_COMMANDS } from '../utils/slashCommands';
import ResizableSidebar from './ResizableSidebar';
import { useMobile } from '../contexts/MobileContext';
import VerticalResizableDivider from './VerticalResizableDivider';
import TemplateSidebar from './features/documents/TemplateSidebar';
import DocumentSidebar from './features/documents/DocumentSidebar';
import DocumentEditor from './features/documents/DocumentEditor';
import TabBar from './features/documents/TabBar';
import FindInFilesWindow from './features/documents/FindInFilesWindow';
import DocumentTemplateModal from './features/documents/DocumentTemplateModal';
import { requestEditorJumpToLine } from '../utils/openDocument';
import { isSyncStarted, pullNow } from '../sync/syncEngine';
import ConfirmationModal from './common/ConfirmationModal';
import IconPickerModal from './modals/IconPickerModal';
import { FileText, Copy, Edit, Trash2, Lock, Unlock } from 'lucide-react';
import {
  getDocumentsMetadata,
  getDocument,
  createDocument,
  updateDocument,
  deleteDocument,
  getCategories,
  renameCategory,
  toggleDocumentLock,
  updateDocumentCategory,
} from '../utils/documents';
import {
  getDocumentCategories,
  updateDocumentCategory as updateCategoryIcon,
  createDocumentCategory,
  DUPLICATE_CATEGORY,
} from '../utils/documentCategories';
import {
  getDocumentTemplates,
  createDocumentTemplate,
  updateDocumentTemplate,
  deleteDocumentTemplate,
  getTemplateCategories,
} from '../utils/documentTemplates';
import { uploadDocumentToCentral } from '../utils/cloudCentralSync';
import { onConnectionStatusChange } from '../utils/cloudWebSocket';
import { isDocumentOwner, getMachineId } from '../utils/cloudDocuments';
import { useNotifications } from '../contexts/NotificationContext';
import { getEngineTemplates } from '../utils/engineTemplates';
import EngineInputModal from './features/search/EngineInputModal';
import { EmptyState, Button } from './ui';
import { MenuItemIcon } from './common/menus/MenuItemIcon';

/**
 * DocumentsPage - Refactored version using Phase 1-3 components
 *
 * Reduced from 7,349 lines to ~400 lines (95% reduction!)
 *
 * Uses:
 * - Phase 1 hooks: useLocalStorage, useSessionPersistence
 * - Phase 2 components: Modals (in child components)
 * - Phase 3 components: TemplateSidebar, DocumentSidebar, DocumentEditor
 */
export default function DocumentsPage({
  selectedDocumentId,
  onDocumentOpened,
  createNewDocument: externalCreateNew,
  onDocumentCreated,
}) {
  const { addNotification } = useNotifications();
  // The phone layout: the document list is a drawer, the tabs a header
  const { isMobile } = useMobile();

  // State - drastically reduced from 40+ useState
  const [documents, setDocuments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [documentTemplates, setDocumentTemplates] = useState([]);
  // the editor's "/" popup: the built-in commands (callouts, Quick Workflow / AI / Task) first, then the templates
  const slashTemplates = useMemo(() => [...BUILTIN_COMMANDS, ...documentTemplates], [documentTemplates]);
  const [templateCategories, setTemplateCategories] = useState([]);
  const [currentDocument, setCurrentDocument] = useState(null);
  const [centralServerStatus, setCentralServerStatus] = useState(null); // null, 'checking', 'online', 'offline'
  const [currentMachineId, setCurrentMachineId] = useState(null);
  const [isOnline, setIsOnline] = useState(true);

  // Engine templates for "Search In" feature
  const [engineTemplates, setEngineTemplates] = useState([]);
  const [showEngineInputModal, setShowEngineInputModal] = useState(false);
  const [currentEngineTemplate, setCurrentEngineTemplate] = useState(null);
  const [prefilledSearchText, setPrefilledSearchText] = useState('');

  // Debug: Log whenever currentDocument changes
  useEffect(() => {
    console.log('[DocumentsPage] currentDocument changed:', currentDocument?.id, currentDocument?.title);
  }, [currentDocument]);

  // Document selection mode
  const [documentSelectionMode, setDocumentSelectionMode] = useState(false);
  const [selectedDocuments, setSelectedDocuments] = useState([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('General');
  const [loading, setLoading] = useState(false);

  // Tab context menu state
  const [showTabContextMenu, setShowTabContextMenu] = useState(false);
  const [tabContextMenuPosition, setTabContextMenuPosition] = useState({ x: 0, y: 0 });
  const [tabContextMenuTarget, setTabContextMenuTarget] = useState(null);
  const [tabContextMenuPane, setTabContextMenuPane] = useState(null); // 'left' or 'right'
  const tabContextMenuRef = useRef(null);

  // Template modal state
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);

  // Template sidebar state
  const [expandedTemplateCategories, setExpandedTemplateCategories] = useLocalStorage('expandedTemplateCategories', []);
  const [templateSelectionMode, setTemplateSelectionMode] = useState(false);
  const [selectedTemplates, setSelectedTemplates] = useState([]);
  const [templateSidebarCollapsed, setTemplateSidebarCollapsed] = useLocalStorage('templateSidebarCollapsed', false);

  // Template context menu state
  const [templateContextMenu, setTemplateContextMenu] = useState({
    visible: false,
    x: 0,
    y: 0,
    type: null,
    template: null,
    category: null
  });
  const templateContextMenuRef = useRef(null);

  // Template delete modal state
  const [showTemplateDeleteModal, setShowTemplateDeleteModal] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState(null);
  const [showBulkTemplateDeleteModal, setShowBulkTemplateDeleteModal] = useState(false);

  // Document delete modal state
  const [showBulkDocumentDeleteModal, setShowBulkDocumentDeleteModal] = useState(false);
  const [bulkDeleteConfirmText, setBulkDeleteConfirmText] = useState('');
  const [showBulkMoveModal, setShowBulkMoveModal] = useState(false);
  const [bulkMoveCategory, setBulkMoveCategory] = useState('');
  const [bulkMoveNewCategory, setBulkMoveNewCategory] = useState('');
  const [showBulkMoveNewCategory, setShowBulkMoveNewCategory] = useState(false);
  const [documentSortBy, setDocumentSortBy] = useLocalStorage('documentSortBy', 'date');

  // Icon picker modal state
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [editingCategoryForIcon, setEditingCategoryForIcon] = useState(null);
  const [editingCategoryName, setEditingCategoryName] = useState(null); // Store category name separately
  const [documentCategoryData, setDocumentCategoryData] = useState([]);

  // Tabs - persist across app restarts
  const [openTabs, setOpenTabs] = useLocalStorage('documentOpenTabs', []);
  // the left pane's tabs follow the account's devices (the right pane stays here)
  useSyncedOpenTabs({
    page: 'documents', tabs: openTabs, setTabs: setOpenTabs,
    itemOf: async (tab) => (await database.documents.get(tab.id))?.stableId || null,
    titleOf: (tab) => tab.title || 'Untitled',
    resolve: async (item) => {
      const doc = await database.documents.where('stableId').equals(item).first();
      if (!doc) return null;
      // the page's list must know it before the tab appears: the restore
      // effect below drops tabs of documents the list does not have
      if (!documentsRef.current.some((d) => d.id === doc.id)) await loadDocuments();
      return { id: doc.id, title: doc.title, category: doc.category || 'General', inCloud: doc.inCloud };
    },
    onClose: (tab) => handleTabClose(tab.id),
    onOpen: (tab) => handleSelectDocument({ id: tab.id }),
    active: currentDocument?.id ?? null,
    itemCollection: 'documents',
  });
  const documentsRef = useRef([]);
  useEffect(() => { documentsRef.current = documents; }, [documents]);

  // Split view - persist across app restarts
  const [splitViewEnabled, setSplitViewEnabled] = useLocalStorage('documentSplitViewEnabled', false);
  const [splitPosition, setSplitPosition] = useLocalStorage('document-split-position', 50); // Percentage
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  // writeDebounceMs=400: rightPane.content updates on every right-pane keystroke; debounce the
  // full-document JSON.stringify + synchronous localStorage write so typing doesn't pay for it.
  // React state still updates synchronously (controlled textarea + 1s autosave effect unaffected),
  // and the hook flushes pending writes on unmount/beforeunload so nothing is lost.
  const [rightPane, setRightPane] = useLocalStorage('documentRightPane', {
    currentDocument: null,
    title: '',
    content: '',
    category: 'General',
    openTabs: [],
  }, 400);

  // Session persistence
  const [innerSidebarVisible, setInnerSidebarVisible] = useLocalStorage('innerSidebarVisible', true);

  // "Find in Files" floating window: { open, scope } where scope is
  // { category } (category context menu) or null (search everywhere)
  const [findInFiles, setFindInFiles] = useState({ open: false, scope: null });
  const openFindInFiles = (scope = null) => setFindInFiles({ open: true, scope: scope || null });
  const closeFindInFiles = () => setFindInFiles((prev) => ({ ...prev, open: false }));

  // The Find in Files shortcut (app.findInFiles in src/shortcuts/registry.js,
  // Ctrl/Cmd+Shift+F by default) anywhere on this page, the editor included
  useShortcut('app.findInFiles', () => openFindInFiles(null));

  // Listen for inner sidebar visibility changes
  useEffect(() => {
    function handleInnerSidebarVisibilityChange(event) {
      setInnerSidebarVisible(event.detail.visible);
    }

    window.addEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
    return () => window.removeEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
  }, [setInnerSidebarVisible]);

  // Note: Document opening from chat mentions is handled via selectedDocumentId prop from JQLBuilder
  // The prop-based approach prevents duplicate document tabs
  // Auto-save timers
  const autoSaveTimerRef = useRef(null);
  const rightAutoSaveTimerRef = useRef(null);
  const lastSavedRef = useRef({ title: '', content: '', category: '' });
  const lastSavedRightRef = useRef({ title: '', content: '', category: '' });

  // Track handled props to prevent duplicates
  const lastSelectedDocumentIdRef = useRef(null);
  const lastCreateNewRef = useRef(null);

  // Persist current document ID across app restarts
  const [currentDocumentId, setCurrentDocumentId] = useLocalStorage('currentDocumentId', null);

  // Refs for always getting current state in event handlers (fixes closure bug)
  const currentDocumentRef = useRef(null);
  const openTabsRef = useRef([]);
  const currentDocumentIdRefValue = useRef(null);
  const rightPaneRef = useRef(null);
  const categoriesRef = useRef([]);

  // Keep refs in sync with state
  useEffect(() => {
    currentDocumentRef.current = currentDocument;
  }, [currentDocument]);

  useEffect(() => {
    categoriesRef.current = categories;
  }, [categories]);

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  useEffect(() => {
    currentDocumentIdRefValue.current = currentDocumentId;
  }, [currentDocumentId]);

  useEffect(() => {
    rightPaneRef.current = rightPane;
  }, [rightPane]);

  // Listen to WebSocket connection status
  useEffect(() => {
    // The central server (if this app has one: the home server provides it,
    // src/utils/cloudCentralSync.js) reports its connection here; without one
    // nothing ever arrives and the status stays null (no indicator).
    const unsubscribe = onConnectionStatusChange((data) => {
      const connected = data.connected;
      setCentralServerStatus(connected ? 'online' : 'offline');
      // (the Working Offline / Back Online notifications are the app's,
      // src/hooks/useConnectionNotices.js, so a page switch never loses one)
      setIsOnline(connected);
    });

    return unsubscribe;
  }, []);

  // Load documents and templates on mount - run once only
  useEffect(() => {
    loadDocuments();
    loadTemplates();
    loadEngineTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array - run once on mount only

  // Local first: a document opens from IndexedDB at once; the home server's
  // changes arrive in the background (pullNow right after the open, then the
  // engine's own cycles) and show in the editor's notice strip (the
  // NoticeBanner under the toolbar, like the offline / read-only notices)
  // when they touch the open document - never as a wait or a pop-up.
  // { kind: 'info' | 'warning', text, copyId?, copyTitle? } while visible:
  // an info notice goes by itself after a few seconds, a conflict stays
  // until dismissed (it carries "Open conflict copy").
  const [syncNotice, setSyncNotice] = useState(null);
  const syncNoticeTimer = useRef(null);
  const showSyncNotice = (text, kind = 'info', extra = {}) => {
    // keyed to the document it is about: another document opens clean
    setSyncNotice({ text, kind, docId: currentDocumentIdRefValue.current, ...extra });
    if (syncNoticeTimer.current) clearTimeout(syncNoticeTimer.current);
    syncNoticeTimer.current = kind === 'info' ? setTimeout(() => setSyncNotice(null), 6000) : null;
  };
  const dismissSyncNotice = () => { if (syncNoticeTimer.current) clearTimeout(syncNoticeTimer.current); setSyncNotice(null); };
  const openDocumentById = async (id) => {
    const doc = await getDocument(id);
    if (doc) { dismissSyncNotice(); await handleSelectDocument(doc); }
  };
  // The editor's live title/content for the sync refresh below (an effect
  // registered once must not read stale state)
  const editorRef = useRef({ title: '', content: '' });
  useEffect(() => { editorRef.current = { title, content }; }, [title, content]);

  // Changes applied from the home server (src/sync/syncEngine.js): refresh
  // the list, and the open document when it changed on the server and the
  // editor holds no unsaved edits (an edit in progress is kept: it is newer
  // and will be sent).
  useEffect(() => {
    async function onSyncApplied(event) {
      const collections = event?.detail?.collections || [];
      if (!collections.includes('documents') && !collections.includes('documentCategories')) return;
      await loadDocuments();
      const id = currentDocumentIdRefValue.current;
      if (id == null) return;
      const fresh = await getDocument(id);
      if (!fresh) return;
      const last = lastSavedRef.current;
      const editorClean = last && last.title === editorRef.current.title && last.content === editorRef.current.content;
      if (!editorClean) return;
      if (fresh.content !== last.content || fresh.title !== last.title || (fresh.category || 'General') !== last.category) {
        // untouched since it opened: update it in place (the editor keeps its scroll and caret)
        setCurrentDocument(fresh);
        setTitle(fresh.title);
        setContent(fresh.content || '');
        setCategory(fresh.category || 'General');
        lastSavedRef.current = { title: fresh.title, content: fresh.content || '', category: fresh.category || 'General' };
        showSyncNotice('Updated from another device');
      }
    }
    // the engine resolved a concurrent edit of the open document (newer wins, the loser is kept as a conflict copy)
    function onSyncConflict(event) {
      const d = event?.detail;
      if (!d || d.table !== 'documents' || d.id !== currentDocumentIdRefValue.current) return;
      if (d.outcome === 'remote-won') showSyncNotice(`A newer version arrived from another device - this is it; yours was kept as the conflict copy "${d.copyTitle || 'conflict copy'}".`, 'warning', { copyId: d.copyId, copyTitle: d.copyTitle });
      else showSyncNotice('A concurrent edit arrived from another device; your newer version was kept.', 'warning');
    }
    window.addEventListener('syncApplied', onSyncApplied);
    window.addEventListener('syncConflict', onSyncConflict);
    return () => { window.removeEventListener('syncApplied', onSyncApplied); window.removeEventListener('syncConflict', onSyncConflict); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load machine ID on mount
  useEffect(() => {
    async function loadMachineId() {
      const machineId = await getMachineId();
      setCurrentMachineId(machineId);
    }
    loadMachineId();
  }, []);

  // Event handlers for cloud sync - needs current document references
  useEffect(() => {
    // Listen for cloud documents received event
    async function handleCloudDocumentsReceived(event) {
      // Use refs to get current values (fixes closure bug with empty dependency array)
      const currentDoc = currentDocumentRef.current;
      const tabs = openTabsRef.current;
      const currentDocId = currentDocumentIdRefValue.current;
      const rPane = rightPaneRef.current;

      console.log('[DocumentsPage] Cloud documents received:', event.detail);
      console.log('[DocumentsPage] Current state:', {
        currentDocumentId: currentDoc?.id,
        currentDocumentTitle: currentDoc?.title,
        persistedDocumentId: currentDocId,
        openTabsCount: tabs.length,
        openTabIds: tabs.map(t => ({ id: t.id, title: t.title }))
      });

      // Targeted update: cloudSync's processDocumentQueue reports exactly
      // which local documents each incoming message affected
      // ({action, documentId} per result), so update just those documents in
      // state instead of reloading the entire list + category data + open
      // documents on every peer's change (the old full-reload hotspot).
      // Same merge-instead-of-refetch philosophy as handleCloudUploadSuccess.
      const results = Array.isArray(event.detail?.results) ? event.detail.results : null;
      if (!results) {
        // Unknown event shape (no per-document results) - fall back to a
        // full reload so nothing is missed.
        await loadDocuments();
        return;
      }

      // Removals were already applied to IndexedDB by
      // receiveDocumentFromCentral: 'deleted' (we are not the owner - local
      // copy removed) or 'removed_metadata' (we own it - it became local-only).
      const deletedIds = results
        .filter(r => r.action === 'deleted' && r.documentId != null)
        .map(r => r.documentId);
      const changedIds = [...new Set(results
        .filter(r => (r.action === 'created' || r.action === 'updated' || r.action === 'removed_metadata') && r.documentId != null)
        .map(r => r.documentId))];

      if (deletedIds.length === 0 && changedIds.length === 0) {
        return; // every message was rejected/ignored - nothing changed locally
      }

      // Fetch fresh copies of just the affected documents (single-row reads)
      const freshDocs = new Map();
      for (const id of changedIds) {
        const freshDoc = await getDocument(id);
        if (freshDoc) freshDocs.set(id, freshDoc);
      }

      // Update the documents list in place. The list state is metadata-only
      // (see loadDocuments), so strip `content` before merging; freshDocs
      // keeps the full copies for the editor-pane updates further down.
      setDocuments(prev => {
        const next = prev.filter(d => !deletedIds.includes(d.id));
        for (const [id, fresh] of freshDocs) {
          const { content: _content, ...freshMeta } = fresh;
          const idx = next.findIndex(d => d.id === id);
          if (idx >= 0) next[idx] = freshMeta;
          else next.push(freshMeta);
        }
        return next;
      });

      // Refresh category state only when this batch can actually change it:
      // a document was created/deleted, or an update carries a category we
      // don't have yet.
      const needCategoryRefresh =
        deletedIds.length > 0 ||
        results.some(r => r.action === 'created') ||
        [...freshDocs.values()].some(d => d.category && !categoriesRef.current.includes(d.category));
      if (needCategoryRefresh) {
        setCategories(await getCategories());
        setDocumentCategoryData(await getDocumentCategories());
      }

      // Deleted-tab cleanup (kept from the full-reload era, now driven by the
      // removal results instead of a before/after list diff)
      const deletedTabIds = deletedIds.filter(id =>
        tabs.some(t => t.id === id) || rPane?.openTabs?.some(t => t.id === id)
      );

      if (deletedTabIds.length > 0) {
        console.log('[DocumentsPage] Documents deleted by central server removal:', deletedTabIds);
      }

      // Remove deleted tabs and switch if necessary
      if (deletedTabIds.length > 0) {
        const remainingTabs = tabs.filter(t => !deletedTabIds.includes(t.id));
        setOpenTabs(remainingTabs);

        // Also clean up right pane tabs
        const remainingRightTabs = rPane?.openTabs?.filter(t => !deletedTabIds.includes(t.id)) || [];
        if (remainingRightTabs.length !== rPane?.openTabs?.length) {
          if (remainingRightTabs.length === 0) {
            // No tabs left in right pane, close split view
            console.log('[DocumentsPage] Right pane has no tabs left, closing split view');
            setRightPane({
              currentDocument: null,
              title: '',
              content: '',
              category: 'General',
              openTabs: []
            });
            setSplitViewEnabled(false);
          } else {
            // Some tabs remain, just update the tab list
            setRightPane(prev => ({
              ...prev,
              openTabs: remainingRightTabs
            }));
          }
        }

        // If current document was deleted, switch to another tab
        if (currentDoc && deletedTabIds.includes(currentDoc.id)) {
          console.log('[DocumentsPage] Current document was deleted, switching tabs');

          if (remainingTabs.length > 0) {
            // Switch to the last remaining tab
            const nextTab = remainingTabs[remainingTabs.length - 1];
            const nextDoc = await getDocument(nextTab.id);
            if (nextDoc) {
              setCurrentDocument(nextDoc);
              setCurrentDocumentId(nextDoc.id);
              setTitle(nextDoc.title);
              setContent(nextDoc.content || '');
              setCategory(nextDoc.category || 'General');

              lastSavedRef.current = {
                title: nextDoc.title,
                content: nextDoc.content || '',
                category: nextDoc.category || 'General',
              };
            }
          } else {
            // No tabs left, clear everything
            setCurrentDocument(null);
            setCurrentDocumentId(null);
            setTitle('');
            setContent('');
            setCategory('General');
          }
        }
      }

      // Refresh open tabs that were actually affected by this batch
      let currentDocWasUpdated = false;

      if (tabs.length > 0) {
        console.log('[DocumentsPage] Checking open tabs for updates...');

        // Update tab metadata only for tabs whose document changed
        for (const tab of tabs) {
          if (deletedTabIds.includes(tab.id)) continue; // Skip deleted tabs

          const updatedDoc = freshDocs.get(tab.id);
          if (updatedDoc) {
            console.log(`[DocumentsPage] Tab ${tab.id} (${tab.title}) - found update, inCloud:`, updatedDoc.inCloud);

            // Always update tab metadata (for cloud icons, styling, etc.)
            setOpenTabs(prev => prev.map(t =>
              t.id === updatedDoc.id
                ? { ...t, title: updatedDoc.title, category: updatedDoc.category, inCloud: updatedDoc.inCloud, ownerId: updatedDoc.ownerId }
                : t
            ));

            // Only update editor content if this document is CURRENTLY VISIBLE AND ACTIVE
            // We ONLY check currentDoc.id - if it's null, we don't update content
            // This prevents using stale persisted state to switch tabs unexpectedly
            const isCurrentlyVisible = currentDoc?.id === updatedDoc.id;

            if (isCurrentlyVisible) {
              // Check if there are unsaved local changes
              const hasUnsavedChanges =
                title !== lastSavedRef.current.title ||
                content !== lastSavedRef.current.content ||
                category !== lastSavedRef.current.category;

              if (hasUnsavedChanges) {
                console.log('[DocumentsPage] Document has unsaved local changes - keeping local version');
                // Update metadata but keep the content
                setCurrentDocument(prev => ({ ...prev, ...updatedDoc, title, content, category }));
              } else {
                console.log('[DocumentsPage] Document is currently active - updating content:', updatedDoc.title);
                setCurrentDocument(updatedDoc);
                setTitle(updatedDoc.title);
                setContent(updatedDoc.content || '');
                setCategory(updatedDoc.category || 'General');

                lastSavedRef.current = {
                  title: updatedDoc.title,
                  content: updatedDoc.content || '',
                  category: updatedDoc.category || 'General',
                };
              }

              currentDocWasUpdated = true;
            } else {
              console.log(`[DocumentsPage] Document ${updatedDoc.title} updated in background - tab metadata only`);
            }
          }
        }
      }

      // Fallback: Only refresh current document if it wasn't already handled in the tabs loop above
      // This handles edge cases where document is open but not in a tab
      if (currentDoc?.id && !currentDocWasUpdated && tabs.length === 0) {
        console.log('[DocumentsPage] No tabs open - refreshing current document as fallback');
        const updatedDoc = freshDocs.get(currentDoc.id);
        if (updatedDoc) {
          // Check if there are unsaved local changes
          const hasUnsavedChanges =
            title !== lastSavedRef.current.title ||
            content !== lastSavedRef.current.content ||
            category !== lastSavedRef.current.category;

          if (hasUnsavedChanges) {
            console.log('[DocumentsPage] Document has unsaved local changes - keeping local version');
            // Update metadata but keep the content
            setCurrentDocument(prev => ({ ...prev, ...updatedDoc, title, content, category }));
          } else {
            setCurrentDocument(updatedDoc);
            setTitle(updatedDoc.title);
            setContent(updatedDoc.content || '');
            setCategory(updatedDoc.category || 'General');

            lastSavedRef.current = {
              title: updatedDoc.title,
              content: updatedDoc.content || '',
              category: updatedDoc.category || 'General',
            };

            console.log('[DocumentsPage] Refreshed current document:', updatedDoc.title);
          }
        }
      }

      // Handle right pane if document was deleted
      if (rPane?.currentDocument?.id && deletedTabIds.includes(rPane.currentDocument.id)) {
        console.log('[DocumentsPage] Right pane document was deleted, switching');

        const remainingRightTabs = rPane.openTabs.filter(t => !deletedTabIds.includes(t.id));

        if (remainingRightTabs.length > 0) {
          // Switch to another tab in right pane
          const nextTab = remainingRightTabs[remainingRightTabs.length - 1];
          const nextDoc = await getDocument(nextTab.id);
          if (nextDoc) {
            setRightPane(prev => ({
              ...prev,
              currentDocument: nextDoc,
              title: nextDoc.title,
              content: nextDoc.content || '',
              category: nextDoc.category || 'General',
              openTabs: remainingRightTabs
            }));

            lastSavedRightRef.current = {
              title: nextDoc.title,
              content: nextDoc.content || '',
              category: nextDoc.category || 'General',
            };
          }
        } else {
          // No tabs left in right pane, close it
          setRightPane({
            currentDocument: null,
            title: '',
            content: '',
            category: 'General',
            openTabs: []
          });
          setSplitViewEnabled(false);
        }
      }
      // Refresh right pane document if open, not deleted, and affected
      else if (rPane?.currentDocument?.id) {
        const updatedDoc = freshDocs.get(rPane.currentDocument.id);
        if (updatedDoc) {
          // Check if there are unsaved local changes in right pane
          const hasUnsavedChanges =
            rPane.title !== lastSavedRightRef.current.title ||
            rPane.content !== lastSavedRightRef.current.content ||
            rPane.category !== lastSavedRightRef.current.category;

          if (hasUnsavedChanges) {
            console.log('[DocumentsPage] Right pane has unsaved local changes - keeping local version');
            // Update metadata but keep the content
            setRightPane(prev => ({
              ...prev,
              currentDocument: { ...updatedDoc, title: prev.title, content: prev.content, category: prev.category },
              openTabs: prev.openTabs.map(tab =>
                tab.id === updatedDoc.id
                  ? { ...tab, title: updatedDoc.title, category: updatedDoc.category, inCloud: updatedDoc.inCloud, ownerId: updatedDoc.ownerId }
                  : tab
              ),
            }));
          } else {
            setRightPane(prev => ({
              ...prev,
              currentDocument: updatedDoc,
              title: updatedDoc.title,
              content: updatedDoc.content || '',
              category: updatedDoc.category || 'General',
              openTabs: prev.openTabs.map(tab =>
                tab.id === updatedDoc.id
                  ? { ...tab, title: updatedDoc.title, category: updatedDoc.category, inCloud: updatedDoc.inCloud, ownerId: updatedDoc.ownerId }
                  : tab
              ),
            }));

            lastSavedRightRef.current = {
              title: updatedDoc.title,
              content: updatedDoc.content || '',
              category: updatedDoc.category || 'General',
            };

            console.log('[DocumentsPage] Refreshed right pane document:', updatedDoc.title);
          }
        }
      }
    }

    // Listen for local document upload to cloud
    async function handleDocumentUploadedToCloud(event) {
      console.log('[DocumentsPage] Document uploaded to cloud event received:', event.detail);
      // Reload documents to refresh cloud status in UI
      console.log('[DocumentsPage] Reloading documents...');
      await loadDocuments();
      console.log('[DocumentsPage] Documents reloaded');

      // Note: loadDocuments() already handles refreshing the currentDocument metadata
      // We don't need to do it again here
    }

    // Listen for document updates (from FloatingDraft or other components)
    async function handleDocumentUpdated(event) {
      const updatedDoc = event.detail;
      if (!updatedDoc || !updatedDoc.id) return;

      console.log('[DocumentsPage] Document updated event received:', updatedDoc.title);

      // Refresh documents list to update metadata
      await loadDocuments();

      // Update tabs in both panes
      setOpenTabs(prev => prev.map(tab =>
        tab.id === updatedDoc.id
          ? { ...tab, title: updatedDoc.title, category: updatedDoc.category }
          : tab
      ));

      setRightPane(prev => ({
        ...prev,
        openTabs: prev.openTabs.map(tab =>
          tab.id === updatedDoc.id
            ? { ...tab, title: updatedDoc.title, category: updatedDoc.category }
            : tab
        )
      }));

      // Update currently open document if it's the one that was updated
      // This allows changes from FloatingDraft to appear in DocumentEditor
      if (currentDocument && updatedDoc.id === currentDocument.id) {
        console.log('[DocumentsPage] Updating current document from FloatingDraft changes');
        setTitle(updatedDoc.title);
        setContent(updatedDoc.content || '');
        setCategory(updatedDoc.category || 'General');
        // Update lastSavedRef to prevent auto-save from triggering
        lastSavedRef.current = {
          title: updatedDoc.title,
          content: updatedDoc.content || '',
          category: updatedDoc.category || 'General'
        };
      }

      // Update right pane document if it's the one that was updated
      if (rightPane.currentDocument && updatedDoc.id === rightPane.currentDocument.id) {
        console.log('[DocumentsPage] Updating right pane document from FloatingDraft changes');
        setRightPane(prev => ({
          ...prev,
          title: updatedDoc.title,
          content: updatedDoc.content || '',
          category: updatedDoc.category || 'General'
        }));
        // Update lastSavedRef to prevent auto-save from triggering
        lastSavedRightRef.current = {
          title: updatedDoc.title,
          content: updatedDoc.content || '',
          category: updatedDoc.category || 'General'
        };
      }
    }

    // The central server refused an edit to a shared document (no Read &
    // Write grant): the editor is read-only and resynced; tell the user why.
    function handleSharedWriteRejected(event) {
      if (event.detail?.kind !== 'document') return;
      const title = event.detail?.title;
      addNotification({
        type: 'warning',
        title: 'Read-only',
        message: `You can view ${title ? `"${title}"` : 'this document'} but not edit it.`
      });
    }

    window.addEventListener('cloudDocumentsReceived', handleCloudDocumentsReceived);
    window.addEventListener('documentUploadedToCloud', handleDocumentUploadedToCloud);
    window.addEventListener('documentUpdated', handleDocumentUpdated);
    window.addEventListener('sharedWriteRejected', handleSharedWriteRejected);

    return () => {
      // Remove event listeners (WebSocket cleanup is handled by first useEffect)
      window.removeEventListener('cloudDocumentsReceived', handleCloudDocumentsReceived);
      window.removeEventListener('documentUploadedToCloud', handleDocumentUploadedToCloud);
      window.removeEventListener('documentUpdated', handleDocumentUpdated);
      window.removeEventListener('sharedWriteRejected', handleSharedWriteRejected);
    };
    // Cloud-sync handlers re-bind when the open panes change; the loaders
    // they call are recreated per render and intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDocument, rightPane]);

  // Restore open tabs and current document on mount
  useEffect(() => {
    if (documents.length > 0 && openTabs.length > 0) {
      // Restore left pane tabs by reloading documents
      const validTabs = openTabs.filter(tab => documents.find(doc => doc.id === tab.id));
      if (validTabs.length !== openTabs.length) {
        setOpenTabs(validTabs);
      }

      // Restore current document if it exists. Skipped while an external
      // open request (selectedDocumentId: chat citation, Tasks page
      // "Create Document In") is still in flight: its handleSelectDocument
      // started before this list load finished, and restoring the persisted
      // id here would race it and could win, leaving the wrong document open.
      if (currentDocumentId && !currentDocument && !selectedDocumentId) {
        const doc = documents.find(d => d.id === currentDocumentId);
        if (doc) {
          handleSelectDocument({ id: currentDocumentId });
        } else {
          setCurrentDocumentId(null);
        }
      }

      // Restore right pane tabs
      if (rightPane.openTabs.length > 0) {
        const validRightTabs = rightPane.openTabs.filter(tab => documents.find(doc => doc.id === tab.id));
        if (validRightTabs.length !== rightPane.openTabs.length) {
          setRightPane(prev => ({ ...prev, openTabs: validRightTabs }));
        }

        // Restore right pane current document
        if (rightPane.currentDocument && !documents.find(d => d.id === rightPane.currentDocument.id)) {
          setRightPane(prev => ({
            ...prev,
            currentDocument: null,
            title: '',
            content: '',
            category: 'General'
          }));
        } else if (rightPane.currentDocument) {
          // Reload right pane document. The documents list is metadata-only,
          // so fetch the full body for the editor.
          const docMeta = documents.find(d => d.id === rightPane.currentDocument.id);
          if (docMeta) {
            (async () => {
              const doc = await getDocument(docMeta.id);
              if (doc) {
                setRightPane(prev => ({
                  ...prev,
                  currentDocument: doc,
                  title: doc.title,
                  content: doc.content || '',
                  category: doc.category || 'General'
                }));
              }
            })();
          }
        }
      }
    }
    // Tab restoration deliberately runs only when documents arrive; openTabs
    // and the pane state are reconciliation targets, not triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents]);

  // Load selected document from props
  useEffect(() => {
    if (selectedDocumentId) {
      // Always open the document when selectedDocumentId changes
      lastSelectedDocumentIdRef.current = selectedDocumentId;
      handleSelectDocument({ id: selectedDocumentId });
    } else {
      // Reset the ref when selectedDocumentId is cleared
      lastSelectedDocumentIdRef.current = null;
    }
    // handleSelectDocument is recreated per render; the prop is the trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDocumentId]);

  // Handle external create request
  useEffect(() => {
    if (externalCreateNew && externalCreateNew !== lastCreateNewRef.current) {
      lastCreateNewRef.current = externalCreateNew;
      handleCreateDocument();
    }
    // handleCreateDocument is recreated per render; the prop is the trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalCreateNew]);

  // Handle interactive template submission
  useEffect(() => {
    async function handleCreateFromTemplate(event) {
      const { templateName, values } = event.detail;

      try {
        // Find template by name
        const template = documentTemplates.find(t => t.name === templateName);

        if (!template) {
          addNotification({
            type: 'error',
            title: 'Template Not Found',
            message: `Template "${templateName}" not found!`
          });
          return;
        }

        // Replace all {placeholder} values in the template content
        let filledContent = template.content;
        Object.keys(values).forEach(key => {
          const placeholder = `{${key}}`;
          const value = values[key];
          while (filledContent.indexOf(placeholder) !== -1) {
            filledContent = filledContent.replace(placeholder, value);
          }
        });

        // Create new document with filled content
        const newDocId = await createDocument({
          title: `${template.name} - ${new Date().toLocaleString()}`,
          content: filledContent,
          category: 'General'
        });

        // Fetch the full document
        const newDoc = await getDocument(newDocId);

        // Add to documents list (metadata-only state - drop the body;
        // handleSelectDocument below re-fetches the full document anyway)
        const { content: _content, ...newDocMeta } = newDoc;
        setDocuments(prevDocs => [newDocMeta, ...prevDocs]);

        // Refresh categories
        const cats = await getCategories();
        setCategories(cats);

        // Open the new document
        handleSelectDocument({ id: newDoc.id });
      } catch (error) {
        console.error('Error creating document from template:', error);
        addNotification({
          type: 'error',
          title: 'Creation Failed',
          message: 'Failed to create document from template.'
        });
      }
    }

    window.addEventListener('createDocumentFromTemplate', handleCreateFromTemplate);

    return () => {
      window.removeEventListener('createDocumentFromTemplate', handleCreateFromTemplate);
    };
    // The template-create handler reads current templates/documents (the
    // listed deps); its helper fns are recreated per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentTemplates, documents]);

  // Auto-save when content changes (left pane)
  useEffect(() => {
    if (!currentDocument) return;

    // Clear existing timer
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    // Set new timer
    autoSaveTimerRef.current = setTimeout(() => {
      handleAutoSave();
    }, 1000); // 1 second debounce

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, content, category]); // Removed currentDocument from deps - only trigger on content changes

  // Auto-save when right pane content changes
  useEffect(() => {
    if (!rightPane.currentDocument) return;

    // Clear existing timer
    if (rightAutoSaveTimerRef.current) {
      clearTimeout(rightAutoSaveTimerRef.current);
    }

    // Set new timer
    rightAutoSaveTimerRef.current = setTimeout(() => {
      handleRightPaneAutoSave();
    }, 1000);

    return () => {
      if (rightAutoSaveTimerRef.current) {
        clearTimeout(rightAutoSaveTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightPane.title, rightPane.content, rightPane.category]); // Removed rightPane.currentDocument from deps

  // Load documents
  async function loadDocuments() {
    console.log('[DocumentsPage] loadDocuments() called');
    try {
      setLoading(true);
      // Metadata-only projection: the `documents` list state feeds the
      // sidebar/tabs/sort/bulk-op filters, none of which read `content`.
      // Every path that opens a document in an editor pane fetches the full
      // body itself via getDocument(id).
      const docs = await getDocumentsMetadata();

      console.log('[DocumentsPage] Loaded documents:', {
        total: docs.length,
        cloudDocs: docs.filter(d => d.inCloud === true).length
      });

      // Debug: Log cloud documents
      const cloudDocs = docs.filter(d => d.inCloud === true);
      if (cloudDocs.length > 0) {
        console.log('[DocumentsPage] Cloud documents details:', cloudDocs.map(d => ({
          id: d.id,
          title: d.title,
          inCloud: d.inCloud,
          ownerId: d.ownerId,
          cloudDocumentId: d.cloudDocumentId
        })));
      }

      setDocuments(docs);
      console.log('[DocumentsPage] ✓ Documents state updated');

      const cats = await getCategories();
      setCategories(cats);

      // Load category data with icons
      const categoryData = await getDocumentCategories();
      setDocumentCategoryData(categoryData);

      // Refresh currently open document if it exists (to pick up cloudDocumentId and other metadata changes)
      if (currentDocument) {
        const updatedDoc = await getDocument(currentDocument.id);
        if (updatedDoc) {
          // Check if document metadata changed (especially cloudDocumentId, inCloud, or locked)
          if (updatedDoc.cloudDocumentId !== currentDocument.cloudDocumentId ||
              updatedDoc.inCloud !== currentDocument.inCloud ||
              updatedDoc.locked !== currentDocument.locked) {
            console.log('[DocumentsPage] Refreshing current document metadata (not content):', {
              title: updatedDoc.title,
              hadCloudId: !!currentDocument.cloudDocumentId,
              nowHasCloudId: !!updatedDoc.cloudDocumentId,
              locked: updatedDoc.locked
            });
            // Only update the document object with metadata, don't touch content/title/category states
            // Those are being actively edited by the user
            setCurrentDocument(updatedDoc);
          }
        }
      }

      // Refresh right pane document if it exists
      if (rightPane.currentDocument) {
        const updatedDoc = await getDocument(rightPane.currentDocument.id);
        if (updatedDoc) {
          if (updatedDoc.cloudDocumentId !== rightPane.currentDocument.cloudDocumentId ||
              updatedDoc.inCloud !== rightPane.currentDocument.inCloud ||
              updatedDoc.locked !== rightPane.currentDocument.locked) {
            console.log('[DocumentsPage] Refreshing right pane document metadata (not content):', {
              title: updatedDoc.title,
              hadCloudId: !!rightPane.currentDocument.cloudDocumentId,
              nowHasCloudId: !!updatedDoc.cloudDocumentId,
              locked: updatedDoc.locked
            });
            // Only update the document object with metadata
            setRightPane(prev => ({
              ...prev,
              currentDocument: updatedDoc
            }));
          }
        }
      }
    } catch (error) {
      console.error('[DocumentsPage] Failed to load documents:', error);
    } finally {
      setLoading(false);
    }
  }

  // Sort documents based on selected option (memoized — this component re-renders on every
  // editor keystroke, and the sort only depends on documents/sort mode/machine id)
  const sortedDocuments = useMemo(() => [...documents].sort((a, b) => {
    if (documentSortBy === 'title') {
      return a.title.localeCompare(b.title);
    } else if (documentSortBy === 'date') {
      return (b.updatedAt || 0) - (a.updatedAt || 0); // Newest first
    } else if (documentSortBy === 'cloud') {
      // Categorize documents
      const aIsOtherCloud = a.inCloud && a.ownerId !== currentMachineId;
      const bIsOtherCloud = b.inCloud && b.ownerId !== currentMachineId;

      // If one is other's cloud and one isn't, prioritize the non-other-cloud
      if (aIsOtherCloud && !bIsOtherCloud) return 1;  // a goes down
      if (!aIsOtherCloud && bIsOtherCloud) return -1; // b goes down

      // Within same category, sort by date (newest first)
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    }
    return 0;
  }), [documents, documentSortBy, currentMachineId]);

  // Load templates
  async function loadTemplates() {
    try {
      const templates = await getDocumentTemplates();
      setDocumentTemplates(templates);

      const cats = await getTemplateCategories();
      setTemplateCategories(cats);
    } catch (error) {
      console.error('Failed to load templates:', error);
    }
  }

  async function loadEngineTemplates() {
    try {
      const templates = await getEngineTemplates();
      setEngineTemplates(templates);
    } catch (error) {
      console.error('Failed to load engine templates:', error);
    }
  }

  function handleSearchInEngine(template, selectedText) {
    setCurrentEngineTemplate(template);
    setPrefilledSearchText(selectedText);
    setShowEngineInputModal(true);
  }

  // Template management functions
  async function handleCreateTemplate() {
    setEditingTemplate(null);
    setShowTemplateModal(true);
  }

  async function handleEditTemplate(template) {
    setEditingTemplate(template);
    setShowTemplateModal(true);
  }

  async function handleSaveTemplate(templateData) {
    try {
      if (editingTemplate) {
        await updateDocumentTemplate(editingTemplate.id, templateData);
      } else {
        await createDocumentTemplate(templateData);
      }
      await loadTemplates();
      setShowTemplateModal(false);
      setEditingTemplate(null);
    } catch (error) {
      console.error('Failed to save template:', error);
      addNotification({
        type: 'error',
        title: 'Save Failed',
        message: 'Failed to save template.'
      });
    }
  }

  async function handleDeleteTemplate(templateId) {
    const template = documentTemplates.find(t => t.id === templateId);
    setTemplateToDelete(template);
    setShowTemplateDeleteModal(true);
  }

  async function confirmDeleteTemplate() {
    if (!templateToDelete) return;

    try {
      await deleteDocumentTemplate(templateToDelete.id);
      await loadTemplates();
      setShowTemplateDeleteModal(false);
      setTemplateToDelete(null);
    } catch (error) {
      console.error('Failed to delete template:', error);
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: 'Failed to delete template.'
      });
    }
  }

  function toggleTemplateCategory(category) {
    setExpandedTemplateCategories(prev => {
      if (prev.includes(category)) {
        return prev.filter(c => c !== category);
      } else {
        return [...prev, category];
      }
    });
  }

  function toggleTemplateSelectionMode() {
    setTemplateSelectionMode(!templateSelectionMode);
    setSelectedTemplates([]);
  }

  function toggleTemplateSelection(templateId) {
    setSelectedTemplates(prev => {
      if (prev.includes(templateId)) {
        return prev.filter(id => id !== templateId);
      } else {
        return [...prev, templateId];
      }
    });
  }

  async function handleDuplicateTemplate(template) {
    try {
      await createDocumentTemplate({
        ...template,
        id: undefined,
        name: `${template.name} (Copy)`,
      });
      await loadTemplates();
    } catch (error) {
      console.error('Failed to duplicate template:', error);
      addNotification({
        type: 'error',
        title: 'Duplicate Failed',
        message: 'Failed to duplicate template.'
      });
    }
  }

  // Import a single template
  async function handleImportTemplate(templateData) {
    try {
      const newTemplate = await createDocumentTemplate({
        name: templateData.name || 'Untitled Template',
        content: templateData.content || '',
        tags: templateData.tags || [],
        category: templateData.category || 'General',
        description: templateData.description || '',
      });

      await loadTemplates();
      return newTemplate;
    } catch (error) {
      console.error('Failed to import template:', error);
      throw error;
    }
  }

  async function handleExportTemplates() {
    try {
      const dataStr = JSON.stringify(documentTemplates, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'document-templates.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export templates:', error);
      addNotification({
        type: 'error',
        title: 'Export Failed',
        message: 'Failed to export templates.'
      });
    }
  }

  function handleTemplateContextMenu(e, template) {
    e.preventDefault();

    // Open at the cursor; a useLayoutEffect measures the rendered menu and
    // nudges it on-screen only if it actually overflows the viewport.
    const x = e.clientX;
    const y = e.clientY;

    // If in selection mode and templates are selected, show bulk actions
    if (templateSelectionMode && selectedTemplates.length > 0) {
      setTemplateContextMenu({
        visible: true,
        x,
        y,
        type: 'bulk'
      });
    } else {
      setTemplateContextMenu({
        visible: true,
        x,
        y,
        type: 'template',
        template: template
      });
    }
  }

  function handleCategoryContextMenu(e, category) {
    e.preventDefault();

    // Open at the cursor; a useLayoutEffect measures the rendered menu and
    // nudges it on-screen only if it actually overflows the viewport.
    const x = e.clientX;
    const y = e.clientY;

    setTemplateContextMenu({
      visible: true,
      x,
      y,
      type: 'category',
      category: category
    });
  }

  async function handleBulkTemplateDelete() {
    if (selectedTemplates.length === 0) return;
    setShowBulkTemplateDeleteModal(true);
  }

  async function confirmBulkTemplateDelete() {
    if (selectedTemplates.length === 0) return;

    try {
      for (const templateId of selectedTemplates) {
        await deleteDocumentTemplate(templateId);
      }
      await loadTemplates();
      setSelectedTemplates([]);
      setTemplateSelectionMode(false);
      setShowBulkTemplateDeleteModal(false);
    } catch (error) {
      console.error('Failed to delete templates:', error);
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: 'Failed to delete templates.'
      });
    }
  }

  // Document selection handlers
  function toggleDocumentSelectionMode() {
    setDocumentSelectionMode(!documentSelectionMode);
    setSelectedDocuments([]);
  }

  function toggleDocumentSelection(docId) {
    setSelectedDocuments(prev => {
      if (prev.includes(docId)) {
        return prev.filter(id => id !== docId);
      } else {
        return [...prev, docId];
      }
    });
  }

  async function handleBulkDocumentDelete() {
    if (selectedDocuments.length === 0) return;
    setBulkDeleteConfirmText('');
    setShowBulkDocumentDeleteModal(true);
  }

  async function confirmBulkDocumentDelete() {
    if (selectedDocuments.length === 0) return;

    // Check if any selected documents are locked
    const selectedDocs = documents.filter(doc => selectedDocuments.includes(doc.id));
    const lockedDocs = selectedDocs.filter(doc => doc.locked);

    if (lockedDocs.length > 0 && bulkDeleteConfirmText !== 'I REALLY DO') {
      addNotification({
        type: 'alert',
        title: 'Confirmation Required',
        message: 'You must type "I REALLY DO" to delete locked documents.'
      });
      return;
    }

    try {
      // Check if current documents are being deleted
      const leftPaneDocDeleted = currentDocument && selectedDocuments.includes(currentDocument.id);
      const rightPaneDocDeleted = rightPane.currentDocument && selectedDocuments.includes(rightPane.currentDocument.id);

      // Find next documents for each pane before deletion
      let nextDocIdLeft = null;
      let nextDocIdRight = null;

      if (leftPaneDocDeleted) {
        const remainingLeftTabs = openTabs.filter(t => !selectedDocuments.includes(t.id));
        if (remainingLeftTabs.length > 0) {
          nextDocIdLeft = remainingLeftTabs[0].id;
        }
      }

      if (rightPaneDocDeleted) {
        const remainingRightTabs = rightPane.openTabs.filter(t => !selectedDocuments.includes(t.id));
        if (remainingRightTabs.length > 0) {
          nextDocIdRight = remainingRightTabs[0].id;
        }
      }

      // Delete documents
      for (const docId of selectedDocuments) {
        await deleteDocument(docId);
      }

      const updatedDocs = await getDocumentsMetadata();
      setDocuments(updatedDocs);

      // Remove from tabs
      setOpenTabs(prev => prev.filter(t => !selectedDocuments.includes(t.id)));
      setRightPane(prev => ({
        ...prev,
        openTabs: prev.openTabs.filter(t => !selectedDocuments.includes(t.id)),
      }));

      // Handle left pane
      if (leftPaneDocDeleted) {
        if (nextDocIdLeft) {
          const nextDoc = updatedDocs.find(d => d.id === nextDocIdLeft);
          if (nextDoc) {
            await handleSelectDocument(nextDoc);
          } else {
            setCurrentDocument(null);
            setCurrentDocumentId(null);
            setTitle('');
            setContent('');
            setCategory('General');
          }
        } else {
          setCurrentDocument(null);
          setCurrentDocumentId(null);
          setTitle('');
          setContent('');
          setCategory('General');
        }
      }

      // Handle right pane
      if (rightPaneDocDeleted) {
        const remainingRightTabs = rightPane.openTabs.filter(t => !selectedDocuments.includes(t.id));

        if (nextDocIdRight) {
          // List state is metadata-only - fetch the full body for the editor
          const nextDoc = await getDocument(nextDocIdRight);
          if (nextDoc) {
            setRightPane({
              currentDocument: nextDoc,
              title: nextDoc.title,
              content: nextDoc.content || '',
              category: nextDoc.category || 'General',
              openTabs: remainingRightTabs,
            });

            lastSavedRightRef.current = {
              title: nextDoc.title,
              content: nextDoc.content || '',
              category: nextDoc.category || 'General',
            };
          } else {
            setRightPane({
              currentDocument: null,
              title: '',
              content: '',
              category: 'General',
              openTabs: remainingRightTabs,
            });
          }
        } else {
          setRightPane({
            currentDocument: null,
            title: '',
            content: '',
            category: 'General',
            openTabs: remainingRightTabs,
          });
        }

        // Close split view if no more tabs in right pane
        if (remainingRightTabs.length === 0) {
          setSplitViewEnabled(false);
        }
      }

      setSelectedDocuments([]);
      setDocumentSelectionMode(false);
      setShowBulkDocumentDeleteModal(false);
      setBulkDeleteConfirmText('');
    } catch (error) {
      console.error('Failed to delete documents:', error);
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: 'Failed to delete documents.'
      });
    }
  }

  function handleBulkDocumentMove() {
    setShowBulkMoveModal(true);
    setBulkMoveCategory('');
    setBulkMoveNewCategory('');
    setShowBulkMoveNewCategory(false);
  }

  async function handleBulkMoveConfirm() {
    const targetCategory = showBulkMoveNewCategory ? bulkMoveNewCategory.trim() : bulkMoveCategory;

    if (!targetCategory) {
      addNotification({
        type: 'alert',
        title: 'No Category Selected',
        message: 'Please select or enter a category.'
      });
      return;
    }

    if (selectedDocuments.length === 0) return;

    try {
      for (const docId of selectedDocuments) {
        await updateDocumentCategory(docId, targetCategory);
      }
      await loadDocuments();
      setSelectedDocuments([]);
      setDocumentSelectionMode(false);
      setShowBulkMoveModal(false);
      setBulkMoveCategory('');
      setBulkMoveNewCategory('');
      setShowBulkMoveNewCategory(false);
    } catch (error) {
      console.error('Failed to move documents:', error);
      addNotification({
        type: 'error',
        title: 'Move Failed',
        message: 'Failed to move documents.'
      });
    }
  }

  function handleBulkMoveCancel() {
    setShowBulkMoveModal(false);
    setBulkMoveCategory('');
    setBulkMoveNewCategory('');
    setShowBulkMoveNewCategory(false);
  }

  // Create new document
  async function handleCreateDocument(category) {
    try {
      // Determine the category for the new document:
      // 1. If category is explicitly provided, use it
      // 2. If currentDocument exists, use its category
      // 3. Otherwise, default to 'General'
      const targetCategory = category || (currentDocument && currentDocument.category) || 'General';

      const newDocId = await createDocument({
        title: 'Untitled Document',
        content: '',
        category: targetCategory,
      });

      await loadDocuments();

      // Switch to the newly created document
      await handleSelectDocument({ id: newDocId });

      // Dispatch event to notify other components
      window.dispatchEvent(new CustomEvent('documentUpdated', {
        detail: {
          id: newDocId,
          title: 'Untitled Document',
          content: '',
          category: targetCategory
        }
      }));

      if (onDocumentCreated) {
        onDocumentCreated(newDocId);
      }
    } catch (error) {
      console.error('Failed to create document:', error);
      addNotification({
        type: 'error',
        title: 'Creation Failed',
        message: 'Failed to create document.'
      });
    }
  }

  // Select document
  async function handleSelectDocument(doc) {
    if (!doc || !doc.id) return;

    // If document is already the current document, do nothing
    if (currentDocument && currentDocument.id === doc.id) {
      console.log('[DocumentsPage] Document already open and active');
      return;
    }

    // Save current document before switching
    if (currentDocument && currentDocument.id !== doc.id) {
      await saveCurrentDocument();
    }

    try {
      // Local first: the copy in IndexedDB opens now. With a home server the
      // latest changes are fetched in the background right away (the pull
      // goes first in that cycle); if they touch this document the handler
      // above updates it in place or reports the conflict - nothing waits.
      if (isSyncStarted()) pullNow({ timeout: 0 }).catch(() => {});
      const fullDoc = await getDocument(doc.id);
      console.log('[DocumentsPage] Opening document:', {
        id: fullDoc?.id,
        title: fullDoc?.title,
        contentLength: fullDoc?.content?.length || 0,
        hasContent: !!fullDoc?.content,
        inCloud: fullDoc?.inCloud,
        ownerId: fullDoc?.ownerId
      });
      if (fullDoc) {
        // Check if document is already open in left pane tabs
        const isInLeftPane = openTabs.find(t => t.id === fullDoc.id);

        if (isInLeftPane) {
          // Just switch to it (it's already in tabs)
          console.log('[DocumentsPage] Switching to existing tab in left pane');
          setCurrentDocument(fullDoc);
          setCurrentDocumentId(fullDoc.id);
          setTitle(fullDoc.title);
          setContent(fullDoc.content || '');
          setCategory(fullDoc.category || 'General');

          lastSavedRef.current = {
            title: fullDoc.title,
            content: fullDoc.content || '',
            category: fullDoc.category || 'General',
          };
          return;
        }

        // Check if document is already open in right pane
        const isInRightPane = rightPane.openTabs.find(t => t.id === fullDoc.id);

        if (isInRightPane) {
          // Move it from right pane to left pane
          setCurrentDocument(fullDoc);
          setCurrentDocumentId(fullDoc.id);
          setTitle(fullDoc.title);
          setContent(fullDoc.content || '');
          setCategory(fullDoc.category || 'General');

          lastSavedRef.current = {
            title: fullDoc.title,
            content: fullDoc.content || '',
            category: fullDoc.category || 'General',
          };

          // Add to left pane tabs if not already there (checked on the list as it is now, not
          // on this render's copy: a tab synced in meanwhile must not be added a second time)
          setOpenTabs(prev => (prev.some(t => t.id === fullDoc.id) ? prev : [...prev, { id: fullDoc.id, title: fullDoc.title, category: fullDoc.category || 'General', inCloud: fullDoc.inCloud }]));

          // Remove from right pane
          const wasActiveInRight = rightPane.currentDocument?.id === fullDoc.id;
          setRightPane(prev => ({
            ...prev,
            openTabs: prev.openTabs.filter(t => t.id !== fullDoc.id)
          }));

          // If it was active in right pane, switch to another tab or close split view
          if (wasActiveInRight) {
            const remainingTabs = rightPane.openTabs.filter(t => t.id !== fullDoc.id);
            if (remainingTabs.length > 0) {
              const nextDoc = await getDocument(remainingTabs[remainingTabs.length - 1].id);
              if (nextDoc) {
                setRightPane(prev => ({
                  ...prev,
                  currentDocument: nextDoc,
                  title: nextDoc.title,
                  content: nextDoc.content || '',
                  category: nextDoc.category || 'General'
                }));
                lastSavedRightRef.current = {
                  title: nextDoc.title,
                  content: nextDoc.content || '',
                  category: nextDoc.category || 'General'
                };
              }
            } else {
              // Right pane is now empty - close split view
              setRightPane({
                currentDocument: null,
                title: '',
                content: '',
                category: 'General',
                openTabs: []
              });
              setSplitViewEnabled(false);
            }
          }
        } else {
          // Normal flow - open in left pane
          setCurrentDocument(fullDoc);
          setCurrentDocumentId(fullDoc.id);
          setTitle(fullDoc.title);
          setContent(fullDoc.content || '');
          setCategory(fullDoc.category || 'General');

          lastSavedRef.current = {
            title: fullDoc.title,
            content: fullDoc.content || '',
            category: fullDoc.category || 'General',
          };

          // Add to tabs if not already there (checked on the list as it is now, not on this
          // render's copy: a tab synced in meanwhile must not be added a second time)
          setOpenTabs(prev => (prev.some(t => t.id === fullDoc.id) ? prev : [...prev, { id: fullDoc.id, title: fullDoc.title, category: fullDoc.category || 'General', inCloud: fullDoc.inCloud }]));

          // If right pane has content, enable split view
          if (rightPane.openTabs.length > 0 && !splitViewEnabled) {
            setSplitViewEnabled(true);
          }
        }

        if (onDocumentOpened) {
          onDocumentOpened(fullDoc.id);
        }
      }
    } catch (error) {
      console.error('Failed to load document:', error);
      addNotification({
        type: 'error',
        title: 'Load Failed',
        message: 'Failed to load document.'
      });
    }
  }

  // Find in Files result -> open the document in the left pane (its own tab,
  // or the existing one) and jump the editor to the matched line. When the
  // document is already the active one no switch happens, so the jump is
  // broadcast to the showing editor instead of left in the pending store.
  async function handleOpenFindResult(docId, line, range) {
    const alreadyActive = currentDocument?.id === docId;
    if (!alreadyActive) {
      await handleSelectDocument({ id: docId });
    }
    requestEditorJumpToLine(docId, { line, range, broadcast: alreadyActive });
  }

  // Move document to right pane
  async function handleOpenInRightPane(doc) {
    if (!doc || !doc.id) return;

    // Save right pane document before switching
    if (rightPane.currentDocument && rightPane.currentDocument.id !== doc.id) {
      await saveRightPaneDocument();
    }

    try {
      const fullDoc = await getDocument(doc.id);
      if (fullDoc) {
        // Calculate new right pane tabs
        const newRightTabs = rightPane.openTabs.find(t => t.id === fullDoc.id)
          ? rightPane.openTabs
          : [...rightPane.openTabs, { id: fullDoc.id, title: fullDoc.title, category: fullDoc.category || 'General', inCloud: fullDoc.inCloud }];

        // Open in right pane
        setSplitViewEnabled(true);
        setRightPane({
          currentDocument: fullDoc,
          title: fullDoc.title,
          content: fullDoc.content || '',
          category: fullDoc.category || 'General',
          openTabs: newRightTabs,
        });

        lastSavedRightRef.current = {
          title: fullDoc.title,
          content: fullDoc.content || '',
          category: fullDoc.category || 'General',
        };

        // Remove from left pane
        const wasActiveInLeft = currentDocument?.id === fullDoc.id;
        const remainingLeftTabs = openTabs.filter(t => t.id !== fullDoc.id);
        setOpenTabs(remainingLeftTabs);

        // If it was active in left pane, switch to another tab or clear
        if (wasActiveInLeft) {
          if (remainingLeftTabs.length > 0) {
            handleSelectDocument({ id: remainingLeftTabs[remainingLeftTabs.length - 1].id });
          } else {
            // Left pane is now empty - just clear it, right pane has content
            setCurrentDocument(null);
            setCurrentDocumentId(null);
            setTitle('');
            setContent('');
            setCategory('General');
          }
        }
      }
    } catch (error) {
      console.error('Failed to move document to right pane:', error);
    }
  }

  // Tab management
  function handleTabClick(tab) {
    handleSelectDocument({ id: tab.id });
  }

  function handleTabClose(tabId) {
    setOpenTabs(prev => {
      const newTabs = prev.filter(t => t.id !== tabId);
      // If closing active tab, switch to last tab. The shown document is the
      // stored currentDocumentId as much as the loaded currentDocument: a tab
      // closed (from another device) while this page was still loading left
      // currentDocumentId on a document with no tab, and the next load then
      // reopened it from that id while the synced row opened it too.
      if ((currentDocument?.id === tabId || currentDocumentId === tabId) && newTabs.length > 0) {
        handleSelectDocument({ id: newTabs[newTabs.length - 1].id });
      } else if (newTabs.length === 0) {
        // Left pane is now empty - just clear it
        setCurrentDocument(null);
        setCurrentDocumentId(null);
        setTitle('');
        setContent('');
        setCategory('General');
        // Right pane stays open if it has content
      }
      return newTabs;
    });
  }

  async function handleRightTabClick(tab) {
    // Just switch to this tab in the right pane (don't move it)
    if (!tab || !tab.id) return;

    // Save right pane document before switching
    if (rightPane.currentDocument && rightPane.currentDocument.id !== tab.id) {
      await saveRightPaneDocument();
    }

    try {
      const fullDoc = await getDocument(tab.id);
      if (fullDoc) {
        setRightPane(prev => ({
          ...prev,
          currentDocument: fullDoc,
          title: fullDoc.title,
          content: fullDoc.content || '',
          category: fullDoc.category || 'General',
        }));

        lastSavedRightRef.current = {
          title: fullDoc.title,
          content: fullDoc.content || '',
          category: fullDoc.category || 'General',
        };
      }
    } catch (error) {
      console.error('Failed to load document in right pane:', error);
    }
  }

  function handleRightTabClose(tabId) {
    setRightPane(prev => {
      const newTabs = prev.openTabs.filter(t => t.id !== tabId);
      // If closing active tab in right pane
      if (prev.currentDocument?.id === tabId) {
        if (newTabs.length > 0) {
          // Switch to last tab (just switch, don't move)
          handleRightTabClick({ id: newTabs[newTabs.length - 1].id });
        } else {
          // Close split view
          setSplitViewEnabled(false);
          return {
            currentDocument: null,
            title: '',
            content: '',
            category: 'General',
            openTabs: [],
          };
        }
      }
      return { ...prev, openTabs: newTabs };
    });
  }

  // Auto-save (left pane)
  async function handleAutoSave() {
    // Use ref to get latest currentDocument value
    const doc = currentDocumentRef.current;
    if (!doc) return;

    // Check what changed
    const titleChanged = title !== lastSavedRef.current.title;
    const contentChanged = content !== lastSavedRef.current.content;
    const categoryChanged = category !== lastSavedRef.current.category;

    if (!titleChanged && !contentChanged && !categoryChanged) return;

    // When the document has live Yjs sync (inCloud + cloudDocumentId), the
    // BODY is owned by the Yjs channel: DocumentEditor routes body typing
    // through yjs.updateContent (which persists to IndexedDB itself) and
    // never updates the React `content` state, so `content` here can be
    // stale (frozen at doc-open time). Don't write it back over the
    // Yjs-fresh IndexedDB copy, and don't upload a full snapshot unless the
    // title/category - which do NOT travel over Yjs - actually changed.
    const yjsLive = !!(doc.inCloud && doc.cloudDocumentId);

    if (yjsLive && !titleChanged && !categoryChanged) {
      lastSavedRef.current = { title, content, category };
      return;
    }

    try {
      await updateDocument(doc.id, {
        title: title || 'Untitled',
        category,
        // Yjs-live docs: leave `content` to the Yjs observer (partial
        // updates merge, so the stored body is untouched)
        ...(yjsLive ? {} : { content }),
      });

      lastSavedRef.current = { title, content, category };

      // Update tab title and category
      setOpenTabs(prev =>
        prev.map(tab =>
          tab.id === doc.id ? { ...tab, title, category } : tab
        )
      );

      // Note: Don't call loadDocuments() here - it causes infinite loop because
      // updating currentDocument triggers this useEffect again
      // Documents list will be refreshed when needed (e.g., on cloud sync events)

      // Auto-sync to cloud if document is in cloud and user has write permissions
      if (doc.inCloud) {
        const hasWritePermission = await isDocumentOwner(doc);
        if (hasWritePermission) {
          try {
            // Get the latest version of the document (for Yjs-live docs this
            // carries the Yjs-fresh body, so the snapshot is never stale)
            const latestDoc = await getDocument(doc.id);
            if (latestDoc) {
              console.log('[AutoSave] Syncing to cloud:', latestDoc.title);
              await uploadDocumentToCentral(latestDoc);
              console.log('[AutoSave] ✓ Cloud sync successful');
              // If this upload just assigned the document its cloudDocumentId
              // (first cloud write happened via autosave), merge the new
              // cloud metadata into the open editor state - same pattern as
              // the explicit "Upload to Cloud" path - so live Yjs sync
              // engages and later body typing stops re-uploading full
              // snapshots on every debounce.
              if (!doc.cloudDocumentId) {
                const uploadedDoc = await getDocument(doc.id);
                if (uploadedDoc?.cloudDocumentId) {
                  handleCloudUploadSuccess(uploadedDoc);
                }
              }
            }
          } catch (error) {
            console.error('[AutoSave] Cloud sync failed:', error);
            // Don't show notification for auto-sync failures to avoid spam
          }
        }
      }
    } catch (error) {
      console.error('Failed to save document:', error);
    }
  }

  // Save current document if there are unsaved changes
  async function saveCurrentDocument() {
    // Use ref to get latest currentDocument value
    const doc = currentDocumentRef.current;
    if (!doc) return;

    // Check if anything changed
    const hasChanges =
      title !== lastSavedRef.current.title ||
      content !== lastSavedRef.current.content ||
      category !== lastSavedRef.current.category;

    if (!hasChanges) return;

    try {
      await updateDocument(doc.id, {
        title: title || 'Untitled',
        category,
        // Yjs-live docs: `content` state can be stale (body is owned by the
        // Yjs channel, which persists to IndexedDB itself) - don't write it
        // back over the Yjs-fresh copy. See handleAutoSave.
        ...((doc.inCloud && doc.cloudDocumentId) ? {} : { content }),
      });

      lastSavedRef.current = { title, content, category };

      // Update tab title and category
      setOpenTabs(prev =>
        prev.map(tab =>
          tab.id === doc.id ? { ...tab, title, category } : tab
        )
      );

      // Note: Don't call loadDocuments() here - documents list will be refreshed when needed
    } catch (error) {
      console.error('Failed to save document:', error);
    }
  }

  // Auto-save (right pane)
  async function handleRightPaneAutoSave() {
    // Use ref to get latest rightPane value
    const rPane = rightPaneRef.current;
    if (!rPane || !rPane.currentDocument) return;

    const titleChanged = rPane.title !== lastSavedRightRef.current.title;
    const contentChanged = rPane.content !== lastSavedRightRef.current.content;
    const categoryChanged = rPane.category !== lastSavedRightRef.current.category;

    if (!titleChanged && !contentChanged && !categoryChanged) return;

    // See handleAutoSave: for Yjs-live docs the body is owned by the Yjs
    // channel and `rPane.content` can be stale - only title/category edits
    // (which don't travel over Yjs) warrant a save + snapshot upload.
    const yjsLive = !!(rPane.currentDocument.inCloud && rPane.currentDocument.cloudDocumentId);

    if (yjsLive && !titleChanged && !categoryChanged) {
      lastSavedRightRef.current = {
        title: rPane.title,
        content: rPane.content,
        category: rPane.category,
      };
      return;
    }

    try {
      await updateDocument(rPane.currentDocument.id, {
        title: rPane.title || 'Untitled',
        category: rPane.category,
        ...(yjsLive ? {} : { content: rPane.content }),
      });

      lastSavedRightRef.current = {
        title: rPane.title,
        content: rPane.content,
        category: rPane.category,
      };

      // Update right pane tab titles and category
      setRightPane(prev => ({
        ...prev,
        openTabs: prev.openTabs.map(tab =>
          tab.id === prev.currentDocument.id ? { ...tab, title: prev.title, category: prev.category } : tab
        ),
      }));

      // Note: Don't call loadDocuments() here - it causes infinite loop
      // Documents list will be refreshed when needed (e.g., on cloud sync events)

      // Auto-sync to cloud if document is in cloud and user has write permissions
      if (rPane.currentDocument.inCloud) {
        const hasWritePermission = await isDocumentOwner(rPane.currentDocument);
        if (hasWritePermission) {
          try {
            // Get the latest version of the document
            const latestDoc = await getDocument(rPane.currentDocument.id);
            if (latestDoc) {
              console.log('[AutoSave Right Pane] Syncing to cloud:', latestDoc.title);
              await uploadDocumentToCentral(latestDoc);
              console.log('[AutoSave Right Pane] ✓ Cloud sync successful');
              // First cloud write via autosave: feed the assigned
              // cloudDocumentId back into the open editor so Yjs engages
              // (see handleAutoSave for details).
              if (!rPane.currentDocument.cloudDocumentId) {
                const uploadedDoc = await getDocument(rPane.currentDocument.id);
                if (uploadedDoc?.cloudDocumentId) {
                  handleCloudUploadSuccess(uploadedDoc);
                }
              }
            }
          } catch (error) {
            console.error('[AutoSave Right Pane] Cloud sync failed:', error);
            // Don't show notification for auto-sync failures to avoid spam
          }
        }
      }
    } catch (error) {
      console.error('Failed to save right pane document:', error);
    }
  }

  // Save right pane document if there are unsaved changes
  async function saveRightPaneDocument() {
    // Use ref to get latest rightPane value
    const rPane = rightPaneRef.current;
    if (!rPane || !rPane.currentDocument) return;

    const hasChanges =
      rPane.title !== lastSavedRightRef.current.title ||
      rPane.content !== lastSavedRightRef.current.content ||
      rPane.category !== lastSavedRightRef.current.category;

    if (!hasChanges) return;

    try {
      await updateDocument(rPane.currentDocument.id, {
        title: rPane.title || 'Untitled',
        category: rPane.category,
        // Yjs-live docs: content state can be stale - see handleAutoSave.
        ...((rPane.currentDocument.inCloud && rPane.currentDocument.cloudDocumentId) ? {} : { content: rPane.content }),
      });

      lastSavedRightRef.current = {
        title: rPane.title,
        content: rPane.content,
        category: rPane.category,
      };

      // Update right pane tab titles and category
      setRightPane(prev => ({
        ...prev,
        openTabs: prev.openTabs.map(tab =>
          tab.id === prev.currentDocument.id ? { ...tab, title: prev.title, category: prev.category } : tab
        ),
      }));

      // Refresh documents list
      await loadDocuments();
    } catch (error) {
      console.error('Failed to save right pane document:', error);
    }
  }

  // Delete document
  async function handleDeleteDocument(docId) {
    try {
      // Find next tab ID to select if current is being deleted (based on tabs, not all documents)
      let nextDocIdLeft = null;
      let nextDocIdRight = null;

      // Left pane: Find next tab in openTabs
      if (currentDocument?.id === docId) {
        const currentTabIndex = openTabs.findIndex(t => t.id === docId);
        if (currentTabIndex !== -1) {
          // Try next tab first, then previous, then null
          if (currentTabIndex < openTabs.length - 1) {
            nextDocIdLeft = openTabs[currentTabIndex + 1].id;
          } else if (currentTabIndex > 0) {
            nextDocIdLeft = openTabs[currentTabIndex - 1].id;
          }
        }
      }

      // Right pane: Find next tab in rightPane.openTabs
      if (rightPane.currentDocument?.id === docId) {
        const currentTabIndex = rightPane.openTabs.findIndex(t => t.id === docId);
        if (currentTabIndex !== -1) {
          // Try next tab first, then previous, then null
          if (currentTabIndex < rightPane.openTabs.length - 1) {
            nextDocIdRight = rightPane.openTabs[currentTabIndex + 1].id;
          } else if (currentTabIndex > 0) {
            nextDocIdRight = rightPane.openTabs[currentTabIndex - 1].id;
          }
        }
      }

      await deleteDocument(docId);
      const updatedDocs = await getDocumentsMetadata();
      setDocuments(updatedDocs);

      // Remove from tabs
      setOpenTabs(prev => prev.filter(t => t.id !== docId));
      setRightPane(prev => ({
        ...prev,
        openTabs: prev.openTabs.filter(t => t.id !== docId),
      }));

      // Select next document or clear if it was deleted (left pane)
      if (currentDocument?.id === docId) {
        if (nextDocIdLeft) {
          const nextDoc = updatedDocs.find(d => d.id === nextDocIdLeft);
          if (nextDoc) {
            await handleSelectDocument(nextDoc);
          } else {
            setCurrentDocument(null);
            setCurrentDocumentId(null);
            setTitle('');
            setContent('');
            setCategory('General');
          }
        } else {
          setCurrentDocument(null);
          setCurrentDocumentId(null);
          setTitle('');
          setContent('');
          setCategory('General');
        }
      }

      // Select next document or clear if it was deleted (right pane)
      if (rightPane.currentDocument?.id === docId) {
        const remainingRightTabs = rightPane.openTabs.filter(t => t.id !== docId);

        if (nextDocIdRight) {
          // List state is metadata-only - fetch the full body for the editor
          const nextDoc = await getDocument(nextDocIdRight);
          if (nextDoc) {
            // Switch to next document
            setRightPane({
              currentDocument: nextDoc,
              title: nextDoc.title,
              content: nextDoc.content || '',
              category: nextDoc.category || 'General',
              openTabs: remainingRightTabs,
            });

            lastSavedRightRef.current = {
              title: nextDoc.title,
              content: nextDoc.content || '',
              category: nextDoc.category || 'General',
            };
          } else {
            // Next doc not found, clear right pane
            setRightPane({
              currentDocument: null,
              title: '',
              content: '',
              category: 'General',
              openTabs: remainingRightTabs,
            });
          }
        } else {
          // No next document, clear right pane
          setRightPane({
            currentDocument: null,
            title: '',
            content: '',
            category: 'General',
            openTabs: remainingRightTabs,
          });
        }

        // Close split view if no more tabs in right pane
        if (remainingRightTabs.length === 0) {
          setSplitViewEnabled(false);
        }
      }
    } catch (error) {
      console.error('Failed to delete document:', error);
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: 'Failed to delete document.'
      });
    }
  }

  // Duplicate document
  async function handleDuplicateDocument(doc) {
    try {
      const original = await getDocument(doc.id);
      if (original) {
        const newDocId = await createDocument({
          title: `${original.title} (Copy)`,
          content: original.content,
          category: original.category,
        });

        await loadDocuments();
        await handleSelectDocument({ id: newDocId });
      }
    } catch (error) {
      console.error('Failed to duplicate document:', error);
      addNotification({
        type: 'error',
        title: 'Duplicate Failed',
        message: 'Failed to duplicate document.'
      });
    }
  }

  // Rename document
  async function handleRenameDocument(docId, newTitle) {
    try {
      await updateDocument(docId, { title: newTitle });
      await loadDocuments();

      // Update current document title if it's the one being renamed
      if (currentDocument?.id === docId) {
        setTitle(newTitle);
      }

      // Update right pane title if it's the one being renamed
      if (rightPane.currentDocument?.id === docId) {
        setRightPane(prev => ({ ...prev, title: newTitle }));
      }

      // Update tabs
      setOpenTabs(prev => prev.map(tab => tab.id === docId ? { ...tab, title: newTitle } : tab));
      setRightPane(prev => ({
        ...prev,
        openTabs: prev.openTabs.map(tab => tab.id === docId ? { ...tab, title: newTitle } : tab)
      }));
    } catch (error) {
      console.error('Failed to rename document:', error);
      addNotification({
        type: 'error',
        title: 'Rename Failed',
        message: 'Failed to rename document.'
      });
    }
  }

  // Toggle lock
  async function handleToggleLock(doc) {
    try {
      // Toggle the locked state (flip the boolean)
      const newLockedState = !doc.locked;
      await toggleDocumentLock(doc.id, newLockedState);

      // Reload documents - this will automatically refresh currentDocument
      // with the updated locked state via the metadata check in loadDocuments()
      await loadDocuments();
    } catch (error) {
      console.error('Failed to toggle lock:', error);
    }
  }

  // Preview document
  async function handlePreview(doc) {
    try {
      // Dispatch event to toggle preview mode for the document
      // The DocumentEditor will handle it based on documentId
      window.dispatchEvent(new CustomEvent('togglePreviewMode', {
        detail: {
          documentId: doc.id
        }
      }));
    } catch (error) {
      console.error('Failed to preview document:', error);
    }
  }

  // Rename category
  async function handleRenameCategory(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;

    try {
      await renameCategory(oldName, newName);
      await loadDocuments();

      // Update current document category if needed
      if (category === oldName) {
        setCategory(newName);
      }
    } catch (error) {
      if (error?.code === DUPLICATE_CATEGORY) {
        addNotification({
          type: 'alert',
          title: 'Duplicate Category',
          message: `Category "${newName}" already exists.`
        });
        return;
      }
      console.error('Failed to rename category:', error);
      addNotification({
        type: 'error',
        title: 'Rename Failed',
        message: 'Failed to rename category.'
      });
    }
  }

  // Load template into editor
  function handleLoadTemplate() {
    // Disabled: Templates can only be inserted via slash commands
    return;
  }

  // Update document category (for drag and drop)
  async function handleUpdateDocumentCategory(doc, newCategory) {
    try {
      await updateDocumentCategory(doc.id, newCategory);

      // Refresh documents list
      await loadDocuments();

      // If this is the current document, update local state
      if (currentDocument?.id === doc.id) {
        setCategory(newCategory);
      }

      // If this is in the right pane, update that too
      if (rightPane.currentDocument?.id === doc.id) {
        setRightPane(prev => ({ ...prev, category: newCategory }));
      }
    } catch (error) {
      console.error('Failed to update document category:', error);
      addNotification({
        type: 'error',
        title: 'Move Failed',
        message: 'Failed to move document.'
      });
    }
  }

  // Tab drag and drop handlers
  function handleTabReorder(fromIndex, toIndex) {
    setOpenTabs(prev => {
      const newTabs = [...prev];
      const [removed] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, removed);
      return newTabs;
    });
  }

  function handleRightTabReorder(fromIndex, toIndex) {
    setRightPane(prev => {
      const newTabs = [...prev.openTabs];
      const [removed] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, removed);
      return { ...prev, openTabs: newTabs };
    });
  }

  function handleTabDrop(tabId, fromPane, toIndex) {
    if (fromPane === 'left') {
      // Moving from left to right
      const tab = openTabs.find(t => t.id === tabId);
      if (!tab) return;

      const wasActiveInLeft = currentDocument?.id === tabId;
      const existsInRight = rightPane.openTabs.find(t => t.id === tabId);

      // Remove from left
      setOpenTabs(prev => prev.filter(t => t.id !== tabId));

      // Add to right at specific index only if it doesn't already exist
      if (!existsInRight) {
        setRightPane(prev => {
          const newTabs = [...prev.openTabs];
          newTabs.splice(toIndex, 0, tab);
          return { ...prev, openTabs: newTabs };
        });
      } else {
        // If it exists, just reorder it
        setRightPane(prev => {
          const newTabs = prev.openTabs.filter(t => t.id !== tabId);
          newTabs.splice(toIndex, 0, tab);
          return { ...prev, openTabs: newTabs };
        });
      }

      // Enable split view if not already enabled
      if (!splitViewEnabled) {
        setSplitViewEnabled(true);
      }

      // If this was the current document in left pane, load it in right pane
      if (wasActiveInLeft) {
        // Load document directly without using handleOpenInRightPane to avoid duplicate tab
        getDocument(tabId).then(fullDoc => {
          if (fullDoc) {
            setRightPane(prev => ({
              ...prev,
              currentDocument: fullDoc,
              title: fullDoc.title,
              content: fullDoc.content || '',
              category: fullDoc.category || 'General',
            }));

            lastSavedRightRef.current = {
              title: fullDoc.title,
              content: fullDoc.content || '',
              category: fullDoc.category || 'General',
            };
          }
        });

        // Switch to another tab in left pane if available
        const remainingTabs = openTabs.filter(t => t.id !== tabId);
        if (remainingTabs.length > 0) {
          handleSelectDocument({ id: remainingTabs[0].id });
        } else {
          // No more tabs in left, clear it
          setCurrentDocument(null);
          setTitle('');
          setContent('');
          setCategory('General');
        }
      }
    } else {
      // Moving from right to left
      const tab = rightPane.openTabs.find(t => t.id === tabId);
      if (!tab) return;

      const wasActiveInRight = rightPane.currentDocument?.id === tabId;
      const existsInLeft = openTabs.find(t => t.id === tabId);

      // Remove from right
      setRightPane(prev => ({
        ...prev,
        openTabs: prev.openTabs.filter(t => t.id !== tabId),
      }));

      // Add to left at specific index only if it doesn't already exist
      if (!existsInLeft) {
        setOpenTabs(prev => {
          const newTabs = [...prev];
          newTabs.splice(toIndex, 0, tab);
          return newTabs;
        });
      } else {
        // If it exists, just reorder it
        setOpenTabs(prev => {
          const newTabs = prev.filter(t => t.id !== tabId);
          newTabs.splice(toIndex, 0, tab);
          return newTabs;
        });
      }

      // If this was the current document in right pane, load it in left pane
      if (wasActiveInRight) {
        // Load document directly without using handleSelectDocument to avoid duplicate tab
        getDocument(tabId).then(fullDoc => {
          if (fullDoc) {
            setCurrentDocument(fullDoc);
            setCurrentDocumentId(fullDoc.id);
            setTitle(fullDoc.title);
            setContent(fullDoc.content || '');
            setCategory(fullDoc.category || 'General');

            lastSavedRef.current = {
              title: fullDoc.title,
              content: fullDoc.content || '',
              category: fullDoc.category || 'General',
            };
          }
        });

        // Switch to another tab in right pane if available
        const remainingRightTabs = rightPane.openTabs.filter(t => t.id !== tabId);
        if (remainingRightTabs.length > 0) {
          // Load the next tab in right pane
          getDocument(remainingRightTabs[0].id).then(fullDoc => {
            if (fullDoc) {
              setRightPane(prev => ({
                ...prev,
                currentDocument: fullDoc,
                title: fullDoc.title,
                content: fullDoc.content || '',
                category: fullDoc.category || 'General',
              }));

              lastSavedRightRef.current = {
                title: fullDoc.title,
                content: fullDoc.content || '',
                category: fullDoc.category || 'General',
              };
            }
          });
        } else {
          // Close split view if no more tabs in right pane
          setRightPane({
            currentDocument: null,
            title: '',
            content: '',
            category: 'General',
            openTabs: []
          });
          setSplitViewEnabled(false);
        }
      }
    }
  }

  // Tab context menu handlers
  function handleTabContextMenu(e, tabId, pane = 'left') {
    e.preventDefault();
    e.stopPropagation();

    // Open at the cursor; a useLayoutEffect measures the rendered menu and
    // nudges it on-screen only if it actually overflows the viewport.
    const x = e.clientX;
    const y = e.clientY;

    setTabContextMenuTarget(tabId);
    setTabContextMenuPane(pane);
    setTabContextMenuPosition({ x, y });
    setShowTabContextMenu(true);
  }

  async function handleAddDocumentAsAIContext() {
    if (!tabContextMenuTarget) return;

    const doc = await getDocument(tabContextMenuTarget);
    if (doc) {
      // Open AI Chat sidebar first
      window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', {
        detail: { isOpen: true }
      }));

      // Add context after a short delay to ensure sidebar is mounted
      setTimeout(async () => {
        const { documentContextPayload } = await import('../utils/aiContext');
        window.dispatchEvent(new CustomEvent('addAIContext', {
          detail: { contextData: documentContextPayload(doc) }
        }));
      }, 100);
    }

    setShowTabContextMenu(false);
    setTabContextMenuTarget(null);
    setTabContextMenuPane(null);
  }

  async function handleMoveTabToRightPane() {
    if (!tabContextMenuTarget) return;

    const doc = await getDocument(tabContextMenuTarget);
    if (doc) {
      // Calculate new right pane tabs
      const newRightTabs = rightPane.openTabs.find(tab => tab.id === doc.id)
        ? rightPane.openTabs
        : [...rightPane.openTabs, { id: doc.id, title: doc.title, category: doc.category || 'General', inCloud: doc.inCloud }];

      // Open in right pane
      setSplitViewEnabled(true);
      setRightPane({
        currentDocument: doc,
        title: doc.title,
        content: doc.content || '',
        category: doc.category || 'General',
        openTabs: newRightTabs
      });
      lastSavedRightRef.current = {
        title: doc.title,
        content: doc.content || '',
        category: doc.category || 'General'
      };

      // Remove from left pane
      const wasActiveInLeft = currentDocument?.id === doc.id;
      const remainingLeftTabs = openTabs.filter(t => t.id !== doc.id);
      setOpenTabs(remainingLeftTabs);

      // If it was active in left pane, switch to another tab or clear
      if (wasActiveInLeft) {
        if (remainingLeftTabs.length > 0) {
          handleSelectDocument({ id: remainingLeftTabs[remainingLeftTabs.length - 1].id });
        } else {
          // Left pane is now empty - just clear it, right pane has content
          setCurrentDocument(null);
          setTitle('');
          setContent('');
          setCategory('General');
        }
      }
    }
    setShowTabContextMenu(false);
    setTabContextMenuTarget(null);
    setTabContextMenuPane(null);
  }

  async function handleMoveTabToLeftPane() {
    if (!tabContextMenuTarget) return;

    const doc = await getDocument(tabContextMenuTarget);
    if (doc) {
      // Open in left pane
      setCurrentDocument(doc);
      setCurrentDocumentId(doc.id);
      setTitle(doc.title);
      setContent(doc.content || '');
      setCategory(doc.category || 'General');

      // Add to left pane tabs if not already there (checked on the list as it is now)
      setOpenTabs(prev => (prev.some(tab => tab.id === doc.id) ? prev : [...prev, { id: doc.id, title: doc.title, category: doc.category || 'General', inCloud: doc.inCloud }]));

      lastSavedRef.current = {
        title: doc.title,
        content: doc.content || '',
        category: doc.category || 'General'
      };

      // Remove from right pane
      const wasActiveInRight = rightPane.currentDocument?.id === doc.id;
      setRightPane(prev => ({
        ...prev,
        openTabs: prev.openTabs.filter(t => t.id !== doc.id)
      }));

      // If it was active in right pane, switch to another tab or close split view
      if (wasActiveInRight) {
        const remainingTabs = rightPane.openTabs.filter(t => t.id !== doc.id);
        if (remainingTabs.length > 0) {
          // Load the last remaining tab in right pane directly
          const nextDoc = await getDocument(remainingTabs[remainingTabs.length - 1].id);
          if (nextDoc) {
            setRightPane(prev => ({
              ...prev,
              currentDocument: nextDoc,
              title: nextDoc.title,
              content: nextDoc.content || '',
              category: nextDoc.category || 'General'
            }));
            lastSavedRightRef.current = {
              title: nextDoc.title,
              content: nextDoc.content || '',
              category: nextDoc.category || 'General'
            };
          }
        } else {
          // Right pane is now empty - close split view
          setRightPane({
            currentDocument: null,
            title: '',
            content: '',
            category: 'General',
            openTabs: []
          });
          setSplitViewEnabled(false);
        }
      }
    }
    setShowTabContextMenu(false);
    setTabContextMenuTarget(null);
    setTabContextMenuPane(null);
  }

  function handleCloseTabsToLeft(tabId, pane = 'left') {
    const tabs = pane === 'left' ? openTabs : rightPane.openTabs;
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex > 0) {
      const newTabs = tabs.slice(tabIndex);
      if (pane === 'left') {
        setOpenTabs(newTabs);
        // Note: newTabs will always have at least 1 tab (the target tab), so no need to check for empty
      } else {
        setRightPane(prev => ({ ...prev, openTabs: newTabs }));
      }
    }
    setShowTabContextMenu(false);
  }

  function handleCloseTabsToRight(tabId, pane = 'left') {
    const tabs = pane === 'left' ? openTabs : rightPane.openTabs;
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex < tabs.length - 1) {
      const newTabs = tabs.slice(0, tabIndex + 1);
      if (pane === 'left') {
        setOpenTabs(newTabs);
        // Note: newTabs will always have at least 1 tab (the target tab), so no need to check for empty
      } else {
        setRightPane(prev => ({ ...prev, openTabs: newTabs }));
      }
    }
    setShowTabContextMenu(false);
  }

  function handleCloseOtherTabs(tabId, pane = 'left') {
    const tabs = pane === 'left' ? openTabs : rightPane.openTabs;
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      if (pane === 'left') {
        setOpenTabs([tab]);
        // Note: We're keeping one tab, so no need to check for empty
      } else {
        setRightPane(prev => ({ ...prev, openTabs: [tab] }));
      }
    }
    setShowTabContextMenu(false);
  }

  function handleCloseAllTabs(pane = 'left') {
    if (pane === 'left') {
      // Check if right pane has content
      if (rightPane.openTabs.length > 0) {
        // Move right pane to left pane
        setOpenTabs(rightPane.openTabs);
        setCurrentDocument(rightPane.currentDocument);
        setCurrentDocumentId(rightPane.currentDocument?.id || null);
        setTitle(rightPane.title);
        setContent(rightPane.content);
        setCategory(rightPane.category);

        // Clear right pane
        setRightPane({
          currentDocument: null,
          title: '',
          content: '',
          category: 'General',
          openTabs: []
        });
        setSplitViewEnabled(false);
      } else {
        setOpenTabs([]);
        setCurrentDocument(null);
        setCurrentDocumentId(null);
        setTitle('');
        setContent('');
        setCategory('General');
      }
    } else {
      setRightPane(prev => ({
        ...prev,
        openTabs: [],
        currentDocument: null,
        title: '',
        content: '',
        category: 'General'
      }));
      setSplitViewEnabled(false);
    }
    setShowTabContextMenu(false);
  }

  // Close tab context menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (tabContextMenuRef.current && !tabContextMenuRef.current.contains(event.target)) {
        setShowTabContextMenu(false);
        setTabContextMenuTarget(null);
        setTabContextMenuPane(null);
      }
    }

    if (showTabContextMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showTabContextMenu]);

  // Keep the tab menu on-screen: measure its actual rendered size once open and
  // nudge left/up only if it truly overflows the viewport, instead of
  // pre-guessing a worst-case size (which caused it to render far from the
  // cursor for small menu variants).
  useLayoutEffect(() => {
    if (!showTabContextMenu || !tabContextMenuRef.current) return;
    const menuRect = tabContextMenuRef.current.getBoundingClientRect();
    const margin = 10;
    let x = tabContextMenuPosition.x;
    let y = tabContextMenuPosition.y;
    if (menuRect.right > window.innerWidth - margin) {
      x = Math.max(margin, x - (menuRect.right - window.innerWidth + margin));
    }
    if (menuRect.bottom > window.innerHeight - margin) {
      y = Math.max(margin, y - (menuRect.bottom - window.innerHeight + margin));
    }
    if (x !== tabContextMenuPosition.x || y !== tabContextMenuPosition.y) {
      setTabContextMenuPosition((prev) => ({ ...prev, x, y }));
    }
  }, [showTabContextMenu, tabContextMenuPosition.x, tabContextMenuPosition.y]);

  // Close template context menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (templateContextMenuRef.current && !templateContextMenuRef.current.contains(event.target)) {
        setTemplateContextMenu({ visible: false, x: 0, y: 0, type: null, template: null, category: null });
      }
    }

    if (templateContextMenu.visible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [templateContextMenu.visible]);

  // Keep the menu on-screen: measure its actual rendered size once open and
  // nudge left/up only if it truly overflows the viewport, instead of
  // pre-guessing a worst-case size (which caused it to render far from the
  // cursor for small menu variants).
  useLayoutEffect(() => {
    if (!templateContextMenu.visible || !templateContextMenuRef.current) return;
    const menuRect = templateContextMenuRef.current.getBoundingClientRect();
    const margin = 10;
    let x = templateContextMenu.x;
    let y = templateContextMenu.y;
    if (menuRect.right > window.innerWidth - margin) {
      x = Math.max(margin, x - (menuRect.right - window.innerWidth + margin));
    }
    if (menuRect.bottom > window.innerHeight - margin) {
      y = Math.max(margin, y - (menuRect.bottom - window.innerHeight + margin));
    }
    if (x !== templateContextMenu.x || y !== templateContextMenu.y) {
      setTemplateContextMenu((prev) => ({ ...prev, x, y }));
    }
  }, [templateContextMenu.visible, templateContextMenu.x, templateContextMenu.y]);

  // Split view drag handlers
  useEffect(() => {
    if (!isDraggingSplit) return;

    function handleMouseMove(e) {
      const container = document.getElementById('editor-container');
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percentage = (x / rect.width) * 100;

      // Constrain between 20% and 80%
      const constrainedPercentage = Math.min(Math.max(percentage, 20), 80);
      setSplitPosition(constrainedPercentage);
    }

    function handleMouseUp() {
      setIsDraggingSplit(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDraggingSplit, setSplitPosition]);

  function handleSplitDragStart(e) {
    e.preventDefault();
    setIsDraggingSplit(true);
  }

  // Cloud document handlers
  // Called after a document is successfully uploaded/synced to the central server.
  // Merges ONLY the cloud metadata from the freshly-updated document into the open
  // editor state (left and/or right pane, matched by id) so `yjsEnabled` flips to
  // true immediately and the still-open editor starts live Yjs sync without the
  // user having to close/reopen the document or run a second manual sync.
  // Content/title are deliberately NOT touched: they may be ahead of the DB copy
  // if the user typed while the upload was in flight. Uses functional updates so
  // no stale-closure state can be re-applied. The sidebar list itself is refreshed
  // separately via onRefreshDocuments/loadDocuments by each upload path.
  function handleCloudUploadSuccess(updatedDoc) {
    if (!updatedDoc || updatedDoc.id == null) return;
    const cloudFields = {
      inCloud: updatedDoc.inCloud,
      cloudDocumentId: updatedDoc.cloudDocumentId,
      ownerId: updatedDoc.ownerId,
      cloudLastUpdated: updatedDoc.cloudLastUpdated,
    };
    if (updatedDoc.permissions !== undefined) {
      cloudFields.permissions = updatedDoc.permissions;
    }
    setCurrentDocument(prev =>
      prev && prev.id === updatedDoc.id ? { ...prev, ...cloudFields } : prev
    );
    setRightPane(prev =>
      prev.currentDocument && prev.currentDocument.id === updatedDoc.id
        ? { ...prev, currentDocument: { ...prev.currentDocument, ...cloudFields } }
        : prev
    );
  }

  return (
    <div className="flex h-full overflow-hidden font-text">
      {/* Combined Sidebar (Documents + Templates) */}

      {(innerSidebarVisible || isMobile) && (
        <ResizableSidebar
          defaultWidth={250}
          minWidth={200}
          maxWidth={400}
          storageKey="document-sidebar-width"
        >
          <VerticalResizableDivider
            defaultTopHeight={60}
            minTopHeight={30}
            maxTopHeight={80}
            storageKey="document-sidebar-vertical-split"
            bottomCollapsed={templateSidebarCollapsed}
            topContent={
              <DocumentSidebar
                documents={sortedDocuments}
                categories={categories}
                categoryData={documentCategoryData}
                currentDocument={currentDocument}
                rightPaneDocument={rightPane.currentDocument}
                onSelectDocument={handleSelectDocument}
                onCreateDocument={handleCreateDocument}
                onDeleteDocument={handleDeleteDocument}
                onDuplicateDocument={handleDuplicateDocument}
                onRenameDocument={handleRenameDocument}
                onToggleLock={handleToggleLock}
                onPreview={handlePreview}
                onRenameCategory={handleRenameCategory}
                onOpenInRightPane={handleOpenInRightPane}
                onUpdateDocumentCategory={handleUpdateDocumentCategory}
                onRefreshDocuments={loadDocuments}
                onCloudUploadSuccess={handleCloudUploadSuccess}
                onEditCategoryIcon={(categoryName) => {
                  const categoryInfo = documentCategoryData.find(c => c.name === categoryName);
                  setEditingCategoryForIcon(categoryInfo || null);
                  setEditingCategoryName(categoryName);
                  setShowIconPicker(true);
                }}
                loading={loading}
                selectionMode={documentSelectionMode}
                selectedDocuments={selectedDocuments}
                onToggleSelectionMode={toggleDocumentSelectionMode}
                onToggleDocumentSelection={toggleDocumentSelection}
                onBulkDelete={handleBulkDocumentDelete}
                onBulkMove={handleBulkDocumentMove}
                sortBy={documentSortBy}
                onSortChange={setDocumentSortBy}
                centralServerStatus={centralServerStatus}
                onFindInFiles={openFindInFiles}
              />
            }
            bottomContent={
              <TemplateSidebar
                templates={slashTemplates}
                categories={templateCategories}
                loading={false}
                expandedCategories={expandedTemplateCategories}
                onToggleCategory={toggleTemplateCategory}
                onLoadTemplate={handleLoadTemplate}
                onCreateTemplate={handleCreateTemplate}
                onEditTemplate={handleEditTemplate}
                onDeleteTemplate={handleDeleteTemplate}
                onDuplicateTemplate={handleDuplicateTemplate}
                onImportTemplate={handleImportTemplate}
                onExport={handleExportTemplates}
                selectionMode={templateSelectionMode}
                selectedTemplates={selectedTemplates}
                onToggleTemplateSelection={toggleTemplateSelection}
                onToggleSelectionMode={toggleTemplateSelectionMode}
                onTemplateContextMenu={handleTemplateContextMenu}
                onCategoryContextMenu={handleCategoryContextMenu}
                isCollapsed={templateSidebarCollapsed}
                onCollapsedChange={setTemplateSidebarCollapsed}
              />
            }
          />
        </ResizableSidebar>
      )}

      {/* Main Editor Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Editor Content */}
        {!currentDocument && openTabs.length === 0 && !splitViewEnabled && isMobile ? (
          <div className="flex-1 flex flex-col">
            {/* a phone still needs the header (its sidebar button) with nothing open */}
            <TabBar tabs={[]} pageTitle="Documents" />
            <div className="flex-1 flex items-center justify-center">
              <EmptyState icon={FileText} title="No Document Selected" description="Create a new document or select one from the list" action={<Button variant="primary" size="lg" onClick={() => handleCreateDocument()}>New Document</Button>} />
            </div>
          </div>
        ) : !currentDocument && openTabs.length === 0 && !splitViewEnabled ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState icon={FileText} title="No Document Selected" description="Create a new document or select one from the list" action={<Button variant="primary" size="lg" onClick={() => handleCreateDocument()}>New Document</Button>} />
          </div>
        ) : (
          <div id="editor-container" className="flex-1 flex overflow-hidden relative">
          {/* Backdrop during split resize */}
          {isDraggingSplit && (
            <div
              className="fixed inset-0"
              style={{
                zIndex: 2147483646,
                cursor: 'col-resize'
              }}
            />
          )}

          {/* Left Pane - Only show if it has tabs */}
          {openTabs.length > 0 && (
            <>
              <div
                className="flex flex-col h-full overflow-hidden min-w-0"
                style={{ width: splitViewEnabled ? `${splitPosition}%` : '100%' }}
              >
                {/* Tabs */}
                <TabBar
                  pageTitle="Documents"
                  tabs={openTabs}
                  activeTabId={currentDocument?.id}
                  onTabClick={handleTabClick}
                  onTabClose={handleTabClose}
                  onTabReorder={handleTabReorder}
                  onTabDrop={handleTabDrop}
                  onTabContextMenu={handleTabContextMenu}
                  paneId="left"
                />

                {/* Editor */}
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                  <DocumentEditor
                    documentId={currentDocument?.id}
                    document={currentDocument}
                    title={title}
                    content={content}
                    category={category}
                    onTitleChange={(e) => setTitle(e.target.value)}
                    onContentChange={(e) => setContent(e.target.value)}
                    onCategoryChange={(e) => setCategory(e.target.value)}
                    templates={slashTemplates}
                    locked={currentDocument?.locked}
                    categories={categories}
                    isOnline={isOnline}
                    engineTemplates={engineTemplates}
                    onSearchInEngine={handleSearchInEngine}
                    syncNotice={syncNotice && syncNotice.docId === currentDocument?.id ? syncNotice : null}
                    onDismissSyncNotice={dismissSyncNotice}
                    onOpenDocumentById={openDocumentById}
                  />
                </div>
              </div>

              {/* Draggable Divider - Only show if split view is enabled */}
              {splitViewEnabled && (
                <div
                  onMouseDown={handleSplitDragStart}
                  className="shrink-0 border-l border-os-border cursor-col-resize hover:border-blue-400 transition-colors"
                  style={{
                    zIndex: isDraggingSplit ? 2147483647 : 10
                  }}
                />
              )}
            </>
          )}

          {/* Right Pane - Show when split view enabled or when left pane is empty */}
          {(splitViewEnabled || openTabs.length === 0) && rightPane.openTabs.length > 0 && (
            <div
              className="flex flex-col h-full overflow-hidden min-w-0"
              style={{ width: splitViewEnabled && openTabs.length > 0 ? `${100 - splitPosition}%` : '100%' }}
            >
              {/* Right Tabs */}
              <TabBar
                tabs={rightPane.openTabs}
                activeTabId={rightPane.currentDocument?.id}
                onTabClick={handleRightTabClick}
                onTabClose={handleRightTabClose}
                onTabReorder={handleRightTabReorder}
                onTabDrop={handleTabDrop}
                onTabContextMenu={handleTabContextMenu}
                paneId="right"
              />

              {/* Right Editor */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <DocumentEditor
                  documentId={rightPane.currentDocument?.id}
                  document={rightPane.currentDocument}
                  title={rightPane.title}
                  content={rightPane.content}
                  category={rightPane.category}
                  onTitleChange={(e) => setRightPane(prev => ({ ...prev, title: e.target.value }))}
                  onContentChange={(e) => setRightPane(prev => ({ ...prev, content: e.target.value }))}
                  onCategoryChange={(e) => setRightPane(prev => ({ ...prev, category: e.target.value }))}
                  templates={slashTemplates}
                  locked={rightPane.currentDocument?.locked}
                  categories={categories}
                  isOnline={isOnline}
                  engineTemplates={engineTemplates}
                  onSearchInEngine={handleSearchInEngine}
                />
              </div>
            </div>
          )}
          </div>
        )}

      </div>

      {/* Tab Context Menu */}
      {showTabContextMenu && (
        <div
          ref={tabContextMenuRef}
          className="fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 max-h-[90vh] overflow-y-auto"
          style={{ left: `${tabContextMenuPosition.x}px`, top: `${tabContextMenuPosition.y}px` }}
        >
          {/* Pane switching option */}
          {tabContextMenuPane === 'left' && (
            <button
              onClick={handleMoveTabToRightPane}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
            >
              <MenuItemIcon action="openRight" />
              Open in Right Side
            </button>
          )}
          {tabContextMenuPane === 'right' && (
            <button
              onClick={handleMoveTabToLeftPane}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
            >
              <MenuItemIcon action="openLeft" />
              Open in Left Side
            </button>
          )}

          {/* Divider */}
          {tabContextMenuPane && <div className="border-t border-os-border my-1"></div>}

          {/* Add as AI Context */}
          <button
            onClick={handleAddDocumentAsAIContext}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="aiContext" />
            Add as AI Context
          </button>

          {/* Preview */}
          <button
            onClick={() => {
              const doc = documents.find(d => d.id === tabContextMenuTarget);
              if (doc) {
                handlePreview(doc, tabContextMenuPane);
              }
              setShowTabContextMenu(false);
            }}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="preview" />
            Preview
          </button>

          {/* Lock/Unlock */}
          {(() => {
            const doc = documents.find(d => d.id === tabContextMenuTarget);
            return doc ? (
              doc.locked ? (
                <button
                  onClick={() => {
                    handleToggleLock(doc);
                    setShowTabContextMenu(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="unlock" />
                  Unlock
                </button>
              ) : (
                <button
                  onClick={() => {
                    handleToggleLock(doc);
                    setShowTabContextMenu(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="lock" />
                  Lock
                </button>
              )
            ) : null;
          })()}

          <div className="border-t border-os-border my-1"></div>

          {/* Copy Name */}
          <button
            onClick={() => {
              const tabs = tabContextMenuPane === 'left' ? openTabs : rightPane.openTabs;
              const tab = tabs.find(t => t.id === tabContextMenuTarget);
              if (tab) {
                navigator.clipboard.writeText(tab.title || '');
              }
              setShowTabContextMenu(false);
            }}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="copyText" />
            Copy Name
          </button>

          <div className="border-t border-os-border my-1"></div>

          {/* Tab Close Options */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (tabContextMenuPane === 'left') {
                handleTabClose(tabContextMenuTarget);
              } else {
                handleRightTabClose(tabContextMenuTarget);
              }
              setShowTabContextMenu(false);
            }}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="closeTab" />
            Close This Tab
          </button>
          <button
            onClick={() => handleCloseTabsToLeft(tabContextMenuTarget, tabContextMenuPane)}
            disabled={
              tabContextMenuPane === 'left'
                ? openTabs.findIndex(t => t.id === tabContextMenuTarget) === 0
                : rightPane.openTabs.findIndex(t => t.id === tabContextMenuTarget) === 0
            }
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MenuItemIcon action="closeTab" />
            Close Tabs to Left
          </button>
          <button
            onClick={() => handleCloseTabsToRight(tabContextMenuTarget, tabContextMenuPane)}
            disabled={
              tabContextMenuPane === 'left'
                ? openTabs.findIndex(t => t.id === tabContextMenuTarget) === openTabs.length - 1
                : rightPane.openTabs.findIndex(t => t.id === tabContextMenuTarget) === rightPane.openTabs.length - 1
            }
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MenuItemIcon action="closeTab" />
            Close Tabs to Right
          </button>
          <button
            onClick={() => handleCloseOtherTabs(tabContextMenuTarget, tabContextMenuPane)}
            disabled={
              tabContextMenuPane === 'left' ? openTabs.length === 1 : rightPane.openTabs.length === 1
            }
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MenuItemIcon action="closeTab" />
            Close Other Tabs
          </button>
          <button
            onClick={() => handleCloseAllTabs(tabContextMenuPane)}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="closeTab" />
            Close All Tabs
          </button>
        </div>
      )}

      {/* Template Context Menu */}
      {templateContextMenu.visible && (
        <div
          ref={templateContextMenuRef}
          className="fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px] max-h-[90vh] overflow-y-auto"
          style={{ left: `${templateContextMenu.x}px`, top: `${templateContextMenu.y}px` }}
        >
          {templateContextMenu.type === 'template' && (
            <>
              <button
                onClick={() => {
                  handleEditTemplate(templateContextMenu.template);
                  setTemplateContextMenu({ visible: false, x: 0, y: 0, type: null, template: null, category: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="edit" />
                Edit Template
              </button>
              <button
                onClick={() => {
                  handleDuplicateTemplate(templateContextMenu.template);
                  setTemplateContextMenu({ visible: false, x: 0, y: 0, type: null, template: null, category: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="duplicate" />
                Duplicate
              </button>
              <div className="border-t border-os-border my-1"></div>
              <button
                onClick={() => {
                  handleDeleteTemplate(templateContextMenu.template.id);
                  setTemplateContextMenu({ visible: false, x: 0, y: 0, type: null, template: null, category: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="delete" danger />
                Delete Template
              </button>
            </>
          )}

          {templateContextMenu.type === 'bulk' && (
            <>
              <div className="px-4 py-2 text-xs font-medium text-os-text-secondary border-b border-os-border">
                {selectedTemplates.length} template{selectedTemplates.length !== 1 ? 's' : ''} selected
              </div>
              <button
                onClick={() => {
                  handleBulkTemplateDelete();
                  setTemplateContextMenu({ visible: false, x: 0, y: 0, type: null, template: null, category: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="delete" danger />
                Delete Selected
              </button>
            </>
          )}

          {templateContextMenu.type === 'category' && (
            <>
              <button
                onClick={() => {
                  const categoryTemplates = documentTemplates.filter(t => t.category === templateContextMenu.category);
                  const dataStr = JSON.stringify(categoryTemplates, null, 2);
                  const dataBlob = new Blob([dataStr], { type: 'application/json' });
                  const url = URL.createObjectURL(dataBlob);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = `${templateContextMenu.category}-templates.json`;
                  link.click();
                  URL.revokeObjectURL(url);
                  setTemplateContextMenu({ visible: false, x: 0, y: 0, type: null, template: null, category: null });
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="exportJson" />
                Export Category
              </button>
            </>
          )}
        </div>
      )}

      {/* Template Delete Modal */}
      <ConfirmationModal
        isOpen={showTemplateDeleteModal && !!templateToDelete}
        onClose={() => {
          setShowTemplateDeleteModal(false);
          setTemplateToDelete(null);
        }}
        onConfirm={confirmDeleteTemplate}
        title="Delete Template"
        message={`Are you sure you want to delete "${templateToDelete?.name}"?\n\nThis action cannot be undone.`}
        confirmText="Delete Template"
        dangerous={true}
      />

      {/* Bulk Template Delete Modal */}
      <ConfirmationModal
        isOpen={showBulkTemplateDeleteModal}
        onClose={() => setShowBulkTemplateDeleteModal(false)}
        onConfirm={confirmBulkTemplateDelete}
        title="Delete Templates"
        message={`Are you sure you want to delete ${selectedTemplates.length} template${selectedTemplates.length !== 1 ? 's' : ''}?\n\nThis action cannot be undone.`}
        confirmText="Delete Templates"
        dangerous={true}
      />

      {/* Bulk Document Delete Modal */}
      {showBulkDocumentDeleteModal && (() => {
        const selectedDocs = documents.filter(doc => selectedDocuments.includes(doc.id));
        const lockedDocs = selectedDocs.filter(doc => doc.locked);
        const hasLockedDocs = lockedDocs.length > 0;

        // If no locked docs, use ConfirmationModal
        if (!hasLockedDocs) {
          return (
            <ConfirmationModal
              isOpen={true}
              onClose={() => {
                setShowBulkDocumentDeleteModal(false);
                setBulkDeleteConfirmText('');
              }}
              onConfirm={confirmBulkDocumentDelete}
              title="Delete Documents"
              message={`Are you sure you want to delete ${selectedDocuments.length} document${selectedDocuments.length !== 1 ? 's' : ''}?\n\nThis action cannot be undone.`}
              confirmText="Delete Documents"
              dangerous={true}
            />
          );
        }

        // For locked docs, show custom modal with text input
        return (
          <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
            onClick={() => {
              setShowBulkDocumentDeleteModal(false);
              setBulkDeleteConfirmText('');
            }}
          >
            <div
              className="bg-os-modal rounded-lg shadow-xl w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6">
                <div className="flex items-start gap-4 mb-4">
                  <div className="p-3 rounded-full bg-red-100 dark:bg-red-900/30 shrink-0">
                    <Trash2 size={24} className="text-red-600" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-os-text-primary mb-2">
                      Delete Documents?
                    </h3>
                    <div className="text-sm text-os-text-secondary mb-4">
                      <p className="mb-2">
                        You are about to delete <strong>{selectedDocuments.length} document{selectedDocuments.length !== 1 ? 's' : ''}</strong>.
                      </p>
                      <p className="mb-2">
                        <strong className="text-orange-600 dark:text-orange-400">{lockedDocs.length} {lockedDocs.length === 1 ? 'is' : 'are'} 🔒 LOCKED</strong>.
                      </p>
                      <p className="mb-2">
                        This action cannot be undone.
                      </p>
                      <p className="font-semibold">
                        To confirm, type <code className="bg-red-100 dark:bg-red-900/30 px-2 py-1 rounded-sm text-red-700 dark:text-red-300">I REALLY DO</code> below:
                      </p>
                    </div>
                    <input
                      type="text"
                      value={bulkDeleteConfirmText}
                      onChange={(e) => setBulkDeleteConfirmText(e.target.value)}
                      placeholder="Type: I REALLY DO"
                      className="w-full px-3 py-2 border border-os-input-border rounded-sm outline-hidden bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted focus:border-red-500 focus:ring-2 focus:ring-red-500"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && bulkDeleteConfirmText === 'I REALLY DO') {
                          confirmBulkDocumentDelete();
                        } else if (e.key === 'Escape') {
                          setShowBulkDocumentDeleteModal(false);
                          setBulkDeleteConfirmText('');
                        }
                      }}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 mt-6">
                  <button
                    onClick={() => {
                      setShowBulkDocumentDeleteModal(false);
                      setBulkDeleteConfirmText('');
                    }}
                    className="px-4 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors rounded-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmBulkDocumentDelete}
                    disabled={bulkDeleteConfirmText !== 'I REALLY DO'}
                    className="px-4 py-2 bg-red-600 text-white text-sm hover:bg-red-700 transition-colors rounded-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Delete Documents
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Bulk Document Move Modal */}
      {showBulkMoveModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={handleBulkMoveCancel}
        >
          <div
            className="bg-os-card rounded-lg shadow-xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-os-border">
              <h3 className="text-lg font-semibold text-os-text-primary">Move Documents to Category</h3>
            </div>
            <div className="px-6 py-4 space-y-4">
              <p className="text-sm text-os-text-secondary">
                Move <strong>{selectedDocuments.length} document{selectedDocuments.length !== 1 ? 's' : ''}</strong> to:
              </p>

              {!showBulkMoveNewCategory ? (
                <div className="flex gap-2">
                  <select
                    value={bulkMoveCategory}
                    onChange={(e) => setBulkMoveCategory(e.target.value)}
                    className="flex-1 px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary"
                    autoFocus
                  >
                    <option value="">Select category...</option>
                    {categories.map(cat => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setShowBulkMoveNewCategory(true)}
                    className="flex items-center gap-2 px-3 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors"
                    title="Create new category"
                  >
                    New
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={bulkMoveNewCategory}
                    onChange={(e) => setBulkMoveNewCategory(e.target.value)}
                    placeholder="Enter new category name"
                    className="flex-1 px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && bulkMoveNewCategory.trim()) {
                        handleBulkMoveConfirm();
                      } else if (e.key === 'Escape') {
                        setShowBulkMoveNewCategory(false);
                        setBulkMoveNewCategory('');
                      }
                    }}
                  />
                  <button
                    onClick={() => {
                      setShowBulkMoveNewCategory(false);
                      setBulkMoveNewCategory('');
                    }}
                    className="px-3 py-2 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-os-border flex justify-end gap-2">
              <button
                onClick={handleBulkMoveCancel}
                className="px-4 py-2 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkMoveConfirm}
                disabled={!bulkMoveCategory && !bulkMoveNewCategory.trim()}
                className="px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Move Documents
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template Modal */}
      <DocumentTemplateModal
        isOpen={showTemplateModal}
        template={editingTemplate}
        existingCategories={templateCategories.length > 0 ? templateCategories : ['General']}
        onSave={handleSaveTemplate}
        onClose={() => {
          setShowTemplateModal(false);
          setEditingTemplate(null);
        }}
      />

      {/* Engine Input Modal for Search In feature */}
      <EngineInputModal
        isOpen={showEngineInputModal}
        template={currentEngineTemplate}
        prefilledText={prefilledSearchText}
        onSearch={() => {
          setShowEngineInputModal(false);
          setCurrentEngineTemplate(null);
          setPrefilledSearchText('');
        }}
        onCancel={() => {
          setShowEngineInputModal(false);
          setCurrentEngineTemplate(null);
          setPrefilledSearchText('');
        }}
      />

      {/* Find in Files (floating, non-modal) */}
      <FindInFilesWindow
        open={findInFiles.open}
        scope={findInFiles.scope}
        onScopeChange={(scope) => setFindInFiles((prev) => ({ ...prev, scope }))}
        categories={categories}
        documents={documents}
        onClose={closeFindInFiles}
        onOpenDocument={handleOpenFindResult}
      />

      {/* Icon Picker Modal */}
      <IconPickerModal
        isOpen={showIconPicker}
        onClose={() => {
          setShowIconPicker(false);
          setEditingCategoryForIcon(null);
          setEditingCategoryName(null);
        }}
        onSelect={async (iconName) => {
          try {
            if (editingCategoryForIcon) {
              // Category exists in DB, update it
              await updateCategoryIcon(editingCategoryForIcon.id, { icon: iconName });
              addNotification('Category icon updated', 'success');
            } else if (editingCategoryName) {
              // Category doesn't exist in DB, create it. createDocumentCategory
              // is idempotent by name: if a row appeared in the meantime it is
              // returned instead (created: false), so set the icon on it.
              const created = await createDocumentCategory({
                name: editingCategoryName,
                icon: iconName
              });
              if (created.created === false) {
                await updateCategoryIcon(created.id, { icon: iconName });
              }
              addNotification('Category created with icon', 'success');
            }

            // Reload category data
            const categoryData = await getDocumentCategories();
            setDocumentCategoryData(categoryData);
          } catch (error) {
            console.error('Error saving category icon:', error);
            addNotification('Failed to save category icon', 'error');
          }

          setShowIconPicker(false);
          setEditingCategoryForIcon(null);
          setEditingCategoryName(null);
        }}
        currentIcon={editingCategoryForIcon?.icon}
      />
    </div>
  );
}
