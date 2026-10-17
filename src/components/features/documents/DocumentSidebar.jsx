import { useState, useEffect, useRef } from 'react';
import { openAppSettings } from '../../../utils/openSettings';
import { useCategories } from '../../../hooks/useCategories';
import { useLocalStorage } from '../../../hooks/useLocalStorage';
import { useContextMenu, useDropdownMenu } from '../../../hooks/useContextMenu';
import { useImportExport } from '../../../hooks/useImportExport';
import { can, desktopOnly, isDesktopApp } from '../../../utils/platform';
import { useImportFlow } from '../../../hooks/useImportFlow';
import { useExportFlow } from '../../../hooks/useExportFlow';
import SidebarHeader from '../../common/sidebar/SidebarHeader';
import CategoryList from '../../common/sidebar/CategoryList';
import InlineEdit from '../../common/inputs/InlineEdit';
import HamburgerMenu, { HamburgerMenuItem, HamburgerMenuDivider } from '../../common/menus/HamburgerMenu';
import CategorySubmenu from '../../common/menus/CategorySubmenu';
import ConfirmationModal from '../../common/ConfirmationModal';
import BaseModal from '../../common/modals/BaseModal';
import TypedConfirmationModal from '../../common/modals/ConfirmationModal';
import ImportFlow from '../../common/ImportFlow';
import ExportProgressModal from '../../common/ExportProgressModal';
import PdfExportOptionsModal from '../../common/modals/PdfExportOptionsModal';
import DocumentPermissionsModal from '../../common/modals/DocumentPermissionsModal';
import CalendarEventModal from '../../common/modals/CalendarEventModal';
import MediaLibraryModal from '../../common/modals/MediaLibraryModal';
import { useNotifications } from '../../../contexts/NotificationContext';
import { FileText, Edit, Upload, Copy, Lock, Unlock, CheckSquare, X, Calendar, Cloud, Crown, AlertCircle } from 'lucide-react';
import { isDocumentInCloud, getMachineId } from '../../../utils/cloudDocuments';
import { uploadDocumentToCentral, removeDocumentFromCentral, getCentralServerUrl } from '../../../utils/cloudCentralSync';
import { getUserBorderStyle } from '../../../utils/userColors';
import { createDocumentCategory, deleteDocumentCategory, getDocumentCategories } from '../../../utils/documentCategories';
import { validateDocumentsImport, runDocumentsImport } from '../../../utils/documentImport';
import { attachReferencedMedia } from '../../../utils/documentAttachments';
import ImportFooter from '../../common/ImportFooter';
import MergeModeOption from '../../common/MergeModeOption';
import { DOCUMENTS_MERGE_LABEL, documentsMergeHint } from './DocumentsImportStats';
import DocumentsImportStats from './DocumentsImportStats';
import { notifyCentralUnavailable } from '../../../utils/centralAvailability';
import { MenuItemIcon } from '../../common/menus/MenuItemIcon';
import { MENU_ICONS } from '../../common/menus/menuIcons';

/**
 * DocumentSidebar - Document management sidebar
 *
 * Features:
 * - Document list with categories
 * - Context menus
 * - Import/Export
 * - Selection mode
 * - Lock/Read-only indicators
 * - Central server status indicator
 */
export default function DocumentSidebar({
  documents = [],
  categories = [],
  categoryData = [],
  currentDocument,
  rightPaneDocument,
  onSelectDocument,
  onCreateDocument,
  onDeleteDocument,
  onDuplicateDocument,
  onRenameDocument,
  onToggleLock,
  onPreview,
  onRenameCategory,
  onOpenInRightPane,
  onUpdateDocumentCategory,
  onRefreshDocuments,
  onCloudUploadSuccess,
  onEditCategoryIcon,
  selectionMode = false,
  selectedDocuments = [],
  onToggleSelectionMode,
  onToggleDocumentSelection,
  onBulkDelete,
  onBulkMove,
  sortBy = 'date',
  onSortChange,
  centralServerStatus = null,
  // Open the "Find in Files" window: ({ category }) scopes it to one
  // category (category context menu), null searches everywhere (document
  // context menu, hamburger menu).
  onFindInFiles,
}) {
  // Use localStorage for expandedCategories to persist across app restarts (like WorkflowList does)
  const [expandedCategories, setExpandedCategories] = useLocalStorage('expandedDocumentCategories', []);

  // Toggle category expansion
  const toggleCategory = (categoryName) => {
    setExpandedCategories(prev =>
      prev.includes(categoryName)
        ? prev.filter(c => c !== categoryName)
        : [...prev, categoryName]
    );
  };

  // Use other category utilities from the hook (without storage)
  const {
    editingCategory,
    startEditingCategory,
    cancelEditingCategory,
    getItemsByCategory,
  } = useCategories([], null);

  const {
    contextMenu,
    contextMenuRef,
    openContextMenu,
    closeContextMenu,
  } = useContextMenu();

  const {
    isOpen: menuOpen,
    position: menuPosition,
    menuRef,
    openMenu,
    closeMenu,
  } = useDropdownMenu();

  const { exportToJSON, loadDocumentsWithContent, exportCategory, exportAllToZip, exportCategoryToZip, exportDocumentToZip, exportDocumentToPDF, exportToBase64, importFromBase64 } = useImportExport();
  // Every export below runs as a job under the shared Export Progress modal
  const exportFlow = useExportFlow();

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [documentToDelete, setDocumentToDelete] = useState(null);
  const [draggedDocument, setDraggedDocument] = useState(null);
  const [dragOverCategory, setDragOverCategory] = useState(null);
  const [editingDocumentId, setEditingDocumentId] = useState(null);
  const [currentMachineId, setCurrentMachineId] = useState(null);
  const [showBase64Modal, setShowBase64Modal] = useState(false);
  const [base64Data, setBase64Data] = useState('');
  const [base64Mode, setBase64Mode] = useState('export'); // 'export' or 'import'
  const [base64Busy, setBase64Busy] = useState(null); // 'dry-run' | 'import' | null
  const [base64Result, setBase64Result] = useState(null); // ImportStats result of the last run
  const [base64Error, setBase64Error] = useState(null);
  const [base64Merge, setBase64Merge] = useState(false); // same default as ImportDBModal (not remembered)
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [moveDocAfterCategoryCreate, setMoveDocAfterCategoryCreate] = useState(null);
  const [permissionsDocument, setPermissionsDocument] = useState(null);
  const [permissionsDocuments, setPermissionsDocuments] = useState(null); // For bulk operations
  const [showNewCategoryModal, setShowNewCategoryModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const creatingCategoryRef = useRef(false); // in-flight guard for handleCreateCategory
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [showMediaLibrary, setShowMediaLibrary] = useState(false);
  const { addNotification } = useNotifications();

  // Load machine ID on mount and when documents change
  useEffect(() => {
    console.log('[DocumentSidebar] MOUNT - Starting to load machine ID');
    async function loadMachineId() {
      console.log('[DocumentSidebar] Calling getMachineId()...');
      const id = await getMachineId();
      console.log('[DocumentSidebar] ✓ Machine ID loaded:', id);
      setCurrentMachineId(id);
      console.log('[DocumentSidebar] ✓ State updated with machine ID:', id);
    }
    loadMachineId();
  }, []);

  // Debug: Log when documents array changes (commented out to prevent spam)
  // useEffect(() => {
  //   console.log('[DocumentSidebar] Documents array changed:', {
  //     totalDocs: documents.length,
  //     cloudDocs: documents.filter(d => d.inCloud === true).length,
  //     currentMachineId: currentMachineId
  //   });
  // }, [documents]);

  // Debug: Log when currentMachineId changes
  useEffect(() => {
    if (!currentMachineId) return;

    console.log('[DocumentSidebar] currentMachineId state changed to:', currentMachineId);

    const cloudDocs = documents.filter(d => d.inCloud === true);
    if (cloudDocs.length > 0) {
      console.log('[DocumentSidebar] Rechecking cloud document ownership with new machine ID:');
      cloudDocs.forEach(d => {
        const isOwner = d.ownerId === currentMachineId;
        console.log(`  - ${d.title}:`, {
          ownerId: d.ownerId,
          currentMachineId: currentMachineId,
          isOwner: isOwner,
          match: d.ownerId === currentMachineId ? '✓ MATCH' : '✗ NO MATCH'
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMachineId]); // Only re-run when currentMachineId changes, not on every documents change

  // Import flow hook
  // Import from JSON: validation (nothing is written until it passes) and
  // the one runner for the dry run and the real import live in
  // src/utils/documentImport.js.
  const refreshAfterImport = async () => {
    if (onRefreshDocuments) await onRefreshDocuments();
  };
  const importFlow = useImportFlow({
    validateFn: validateDocumentsImport,
    onRun: runDocumentsImport,
    onComplete: refreshAfterImport,
  });
  const renderImportStats = (result) => <DocumentsImportStats result={result} />;

  // Drag and drop handlers
  const handleDragStart = (doc, e) => {
    setDraggedDocument(doc);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', doc.id);
  };

  const handleDragEnd = () => {
    setDraggedDocument(null);
    setDragOverCategory(null);
  };

  const handleDragOver = (categoryName, e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverCategory(categoryName);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setDragOverCategory(null);
  };

  const handleDrop = async (categoryName, e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverCategory(null);

    if (!draggedDocument || draggedDocument.category === categoryName) {
      setDraggedDocument(null);
      return;
    }

    // Update document category
    try {
      if (onUpdateDocumentCategory) {
        await onUpdateDocumentCategory(draggedDocument, categoryName);
      }
    } catch (error) {
      console.error('Failed to move document:', error);
    } finally {
      setDraggedDocument(null);
    }
  };

  // Handlers
  const handleImport = () => {
    importFlow.startImport();
    closeMenu();
  };

  // ---- Export helpers (all routed through the Export Progress modal) ----
  const countLabel = (n) => `${n} document${n !== 1 ? 's' : ''}`;
  const docLabel = (doc) => `"${doc.title || 'Untitled'}"`;
  const notifyExportError = (what) => (error) => {
    addNotification({
      type: 'error',
      title: 'Export Failed',
      message: `Failed to export ${what}: ${error.message}`,
    });
  };

  // `documents` is the metadata-only sidebar list (no content), so every
  // JSON/Base64 export re-reads the records from the DB first, then embeds
  // the images the documents reference (per-document `media`, see
  // src/utils/documentAttachments.js) so Import from JSON / Base64 on
  // another machine shows them again.
  const loadDocumentsWithImages = async (docs, onProgress) => {
    const { docs: withImages } = await attachReferencedMedia(
      await loadDocumentsWithContent(docs, onProgress),
      onProgress
    );
    return withImages;
  };

  const handleExport = () => {
    closeMenu();
    exportFlow.startExport({
      title: 'Export Documents',
      description: `${countLabel(documents.length)} → JSON with images`,
      run: async (onProgress) => exportToJSON(
        await loadDocumentsWithImages(documents, onProgress),
        'documents',
        { onProgress }
      ),
      onError: notifyExportError('documents to JSON'),
    });
  };

  const handleExportZip = () => {
    closeMenu();
    exportFlow.startExport({
      title: 'Export Documents',
      description: `${countLabel(documents.length)} → ZIP`,
      run: (onProgress) => exportAllToZip(documents, 'documents', onProgress),
      onError: notifyExportError('documents to ZIP'),
    });
  };

  /**
   * Export a list of documents (single, selected, ...) to a JSON file
   * @param {Array} docs
   * @param {string} filename - base filename (no extension)
   * @param {string} description - modal subtitle
   */
  const handleExportDocumentsJSON = (docs, filename, description) => {
    exportFlow.startExport({
      title: docs.length === 1 ? 'Export Document' : 'Export Documents',
      description,
      run: async (onProgress) => exportToJSON(
        await loadDocumentsWithImages(docs, onProgress),
        filename,
        { onProgress }
      ),
      onError: notifyExportError('to JSON'),
    });
  };

  const handleSavePermissions = async (permissions) => {
    // Handle both single and bulk operations
    const targetDocs = permissionsDocuments || (permissionsDocument ? [permissionsDocument] : []);
    if (targetDocs.length === 0) return;

    const isBulk = permissionsDocuments && permissionsDocuments.length > 1;

    try {
      // Import updateDocument from utils
      const { updateDocument, getDocument } = await import('../../../utils/documents');

      let successCount = 0;
      let failCount = 0;

      for (const doc of targetDocs) {
        try {
          await updateDocument(doc.id, {
            permissions: permissions
          });

          // Get the updated document and sync to cloud if it's a cloud document
          if (doc.inCloud && doc.ownerId === currentMachineId) {
            const updatedDoc = await getDocument(doc.id);
            if (updatedDoc) {
              await uploadDocumentToCentral(updatedDoc);
              // Keep the open editor's cloud metadata (incl. permissions) in sync
              if (onCloudUploadSuccess) {
                const syncedDoc = await getDocument(doc.id);
                if (syncedDoc) {
                  onCloudUploadSuccess(syncedDoc);
                }
              }
            }
          }
          successCount++;
        } catch (error) {
          console.error(`Failed to update permissions for ${doc.title}:`, error);
          failCount++;
        }
      }

      if (successCount > 0) {
        addNotification({
          type: 'success',
          title: 'Permissions Updated',
          message: isBulk
            ? `Permissions updated for ${successCount} document${successCount !== 1 ? 's' : ''}${failCount > 0 ? ` (${failCount} failed)` : ''}.`
            : `Permissions for "${targetDocs[0].title}" have been updated.`
        });
      }

      if (failCount > 0 && successCount === 0) {
        addNotification({
          type: 'error',
          title: 'Update Failed',
          message: 'Failed to update document permissions.'
        });
      }

      // Refresh documents list
      if (onRefreshDocuments) {
        await onRefreshDocuments();
      }
    } catch (error) {
      console.error('Failed to update permissions:', error);
      addNotification({
        type: 'error',
        title: 'Update Failed',
        message: 'Failed to update document permissions.'
      });
    }
  };

  // Category cloud operation handlers
  const handleCategoryUploadOrSyncToCloud = async (categoryName) => {
    const serverUrl = getCentralServerUrl();
    if (!serverUrl) {
      notifyCentralUnavailable(addNotification, 'share documents');
      return;
    }

    const categoryDocs = documents.filter(doc => (doc.category || 'General') === categoryName);
    const ownedOrLocalDocs = categoryDocs.filter(doc =>
      !doc.inCloud || doc.ownerId === currentMachineId
    );

    if (ownedOrLocalDocs.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Nothing to Share',
        message: 'No documents available to sync in this category.'
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const doc of ownedOrLocalDocs) {
      try {
        const { getDocument } = await import('../../../utils/documents');
        const freshDoc = await getDocument(doc.id);
        if (freshDoc) {
          await uploadDocumentToCentral(freshDoc);
          // If this document is open in an editor pane, push the new cloud metadata
          // into its live state so Yjs collaboration engages immediately
          if (onCloudUploadSuccess) {
            const uploadedDoc = await getDocument(doc.id);
            if (uploadedDoc) {
              onCloudUploadSuccess(uploadedDoc);
            }
          }
          successCount++;
        }
      } catch (error) {
        console.error(`Failed to sync ${doc.title}:`, error);
        failCount++;
      }
    }

    if (successCount > 0) {
      addNotification({
        type: 'success',
        title: 'Changes Synced',
        message: `${successCount} document${successCount !== 1 ? 's' : ''} synced with the team${failCount > 0 ? ` (${failCount} failed)` : ''}.`
      });
    }

    if (failCount > 0 && successCount === 0) {
      addNotification({
        type: 'error',
        title: 'Sync Failed',
        message: 'Failed to sync the documents\' changes with the team.'
      });
    }

    if (onRefreshDocuments) {
      await onRefreshDocuments();
    }
  };

  const handleCategoryRemoveFromCloud = async (categoryName) => {
    const categoryDocs = documents.filter(doc => (doc.category || 'General') === categoryName);
    const ownedCloudDocs = categoryDocs.filter(doc =>
      doc.inCloud && doc.ownerId === currentMachineId
    );

    if (ownedCloudDocs.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Nothing to Stop Sharing',
        message: 'No document in this category is shared by you.'
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const doc of ownedCloudDocs) {
      try {
        await removeDocumentFromCentral(doc);
        successCount++;
      } catch (error) {
        console.error(`Failed to remove ${doc.title}:`, error);
        failCount++;
      }
    }

    if (successCount > 0) {
      addNotification({
        type: 'success',
        title: 'Stopped Sharing',
        message: `${successCount} document${successCount !== 1 ? 's' : ''} no longer shared${failCount > 0 ? ` (${failCount} failed)` : ''}.`
      });
    }

    if (failCount > 0 && successCount === 0) {
      addNotification({
        type: 'error',
        title: "Couldn't Stop Sharing",
        message: 'Failed to stop sharing the documents.'
      });
    }

    if (onRefreshDocuments) {
      await onRefreshDocuments();
    }
  };

  // Bulk cloud operation handlers
  const handleBulkSyncToCloud = async () => {
    if (selectedDocuments.length === 0) return;

    const serverUrl = getCentralServerUrl();
    if (!serverUrl) {
      notifyCentralUnavailable(addNotification, 'share documents');
      return;
    }

    const selectedDocs = documents.filter(doc => selectedDocuments.includes(doc.id));
    const ownedOrLocalDocs = selectedDocs.filter(doc =>
      !doc.inCloud || doc.ownerId === currentMachineId
    );

    if (ownedOrLocalDocs.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Nothing to Share',
        message: 'No documents available to sync.'
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const doc of ownedOrLocalDocs) {
      try {
        const { getDocument } = await import('../../../utils/documents');
        const freshDoc = await getDocument(doc.id);
        if (freshDoc) {
          await uploadDocumentToCentral(freshDoc);
          // If this document is open in an editor pane, push the new cloud metadata
          // into its live state so Yjs collaboration engages immediately
          if (onCloudUploadSuccess) {
            const uploadedDoc = await getDocument(doc.id);
            if (uploadedDoc) {
              onCloudUploadSuccess(uploadedDoc);
            }
          }
          successCount++;
        }
      } catch (error) {
        console.error(`Failed to sync ${doc.title}:`, error);
        failCount++;
      }
    }

    if (successCount > 0) {
      addNotification({
        type: 'success',
        title: 'Changes Synced',
        message: `${successCount} document${successCount !== 1 ? 's' : ''} synced with the team${failCount > 0 ? ` (${failCount} failed)` : ''}.`
      });
    }

    if (failCount > 0 && successCount === 0) {
      addNotification({
        type: 'error',
        title: 'Sync Failed',
        message: 'Failed to sync the documents\' changes with the team.'
      });
    }

    if (onRefreshDocuments) {
      await onRefreshDocuments();
    }
  };

  const handleBulkRemoveFromCloud = async () => {
    if (selectedDocuments.length === 0) return;

    const selectedDocs = documents.filter(doc => selectedDocuments.includes(doc.id));
    const ownedCloudDocs = selectedDocs.filter(doc =>
      doc.inCloud && doc.ownerId === currentMachineId
    );

    if (ownedCloudDocs.length === 0) {
      addNotification({
        type: 'alert',
        title: 'Nothing to Stop Sharing',
        message: 'None of the selected documents is shared by you.'
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const doc of ownedCloudDocs) {
      try {
        await removeDocumentFromCentral(doc);
        successCount++;
      } catch (error) {
        console.error(`Failed to remove ${doc.title}:`, error);
        failCount++;
      }
    }

    if (successCount > 0) {
      addNotification({
        type: 'success',
        title: 'Stopped Sharing',
        message: `${successCount} document${successCount !== 1 ? 's' : ''} no longer shared${failCount > 0 ? ` (${failCount} failed)` : ''}.`
      });
    }

    if (failCount > 0 && successCount === 0) {
      addNotification({
        type: 'error',
        title: "Couldn't Stop Sharing",
        message: 'Failed to stop sharing the documents.'
      });
    }

    if (onRefreshDocuments) {
      await onRefreshDocuments();
    }
  };

  /**
   * Export documents as a Base64 string (clipboard + result modal)
   * @param {Array} data - documents
   * @param {string} description - modal subtitle
   */
  const handleExportBase64 = (data, description) => {
    exportFlow.startExport({
      title: 'Export as Base64',
      description,
      run: async (onProgress) => exportToBase64(
        await loadDocumentsWithImages(data, onProgress),
        false,
        onProgress
      ),
      onSuccess: (base64) => {
        // Hand off from the progress modal to the Base64 result modal
        exportFlow.handleClose();
        setBase64Data(base64);
        setBase64Mode('export');
        setShowBase64Modal(true);
        addNotification({
          type: 'success',
          title: 'Exported to Base64',
          message: 'Base64 data copied to clipboard and displayed in modal.'
        });
      },
      onError: notifyExportError('to Base64'),
    });
  };

  const closeBase64Modal = () => {
    setShowBase64Modal(false);
    setBase64Data('');
    setBase64Busy(null);
    setBase64Result(null);
    setBase64Error(null);
    setBase64Merge(false);
  };

  const handleImportBase64 = () => {
    setBase64Data('');
    setBase64Mode('import');
    setBase64Result(null);
    setBase64Error(null);
    setBase64Merge(false);
    setShowBase64Modal(true);
  };

  /**
   * Import from Base64: decode + validate (errors shown in place, nothing
   * written), then the same runner as Import from JSON - a dry run shows
   * the statistics, the real import shows the same block afterwards.
   */
  const runBase64Import = async (dryRun) => {
    if (base64Busy) return;
    setBase64Error(null);
    setBase64Result(null);
    let data;
    try {
      data = importFromBase64(base64Data);
    } catch (error) {
      setBase64Error(`Invalid Base64 data: ${error.message}`);
      return;
    }
    const validation = validateDocumentsImport(data);
    if (validation !== true) {
      setBase64Error(typeof validation === 'string' ? validation : 'Validation failed');
      return;
    }
    setBase64Busy(dryRun ? 'dry-run' : 'import');
    try {
      const outcome = await runDocumentsImport(data, { dryRun, mergeMode: base64Merge });
      setBase64Result({ kind: dryRun ? 'dry-run' : 'import', ...outcome });
      if (!dryRun) {
        await refreshAfterImport();
        addNotification({
          type: 'success',
          title: 'Import Successful',
          message: `Successfully imported ${outcome.summary.documents.created} document${outcome.summary.documents.created !== 1 ? 's' : ''}.`
        });
      }
    } catch (error) {
      console.error('Failed to import from Base64:', error);
      setBase64Error(`${dryRun ? 'Dry run' : 'Import'} failed: ${error.message}`);
    } finally {
      setBase64Busy(null);
    }
  };

  const categoryDocCount = (categoryName) =>
    documents.filter(doc => (doc.category || 'General') === categoryName).length;

  const handleExportCategory = (categoryName) => {
    exportFlow.startExport({
      title: 'Export Category',
      description: `"${categoryName}" (${countLabel(categoryDocCount(categoryName))}) → JSON with images`,
      run: async (onProgress) => exportCategory(
        await loadDocumentsWithImages(
          documents.filter(doc => (doc.category || 'General') === categoryName),
          onProgress
        ),
        categoryName,
        'documents',
        { onProgress }
      ),
      onError: notifyExportError('category to JSON'),
    });
  };

  const handleExportDocumentZip = (doc) => {
    exportFlow.startExport({
      title: 'Export Document',
      description: `${docLabel(doc)} → ZIP`,
      run: (onProgress) => exportDocumentToZip(doc, onProgress),
      onSuccess: () => addNotification({
        type: 'success',
        title: 'Exported to ZIP',
        message: 'Document exported to ZIP with its referenced images.'
      }),
      onError: notifyExportError('document to ZIP'),
    });
  };

  // Export PDF is a two-step flow: the options dialog (page size,
  // orientation; last choice remembered) and then the progress modal
  const [pdfOptionsDoc, setPdfOptionsDoc] = useState(null);
  const handleExportPDF = (doc) => setPdfOptionsDoc(doc);
  const startPdfExport = (doc, pageOptions) => {
    setPdfOptionsDoc(null);
    // Cancellable: the exporter stops its hidden print window on abort
    const controller = new AbortController();
    exportFlow.startExport({
      title: 'Export Document',
      description: `${docLabel(doc)} → PDF`,
      run: (onProgress) => exportDocumentToPDF(doc, onProgress, { signal: controller.signal, ...pageOptions }),
      cancel: () => controller.abort(),
      onSuccess: () => addNotification({
        type: 'success',
        title: 'Exported to PDF',
        message: 'Document exported to PDF as rendered in the preview.'
      }),
      onError: notifyExportError('document to PDF'),
    });
  };

  const handleExportCategoryZip = (categoryName) => {
    exportFlow.startExport({
      title: 'Export Category',
      description: `"${categoryName}" (${countLabel(categoryDocCount(categoryName))}) → ZIP`,
      run: (onProgress) => exportCategoryToZip(documents, categoryName, 'documents', onProgress),
      onError: notifyExportError('category to ZIP'),
    });
  };

  const handleDeleteClick = (doc) => {
    setDocumentToDelete(doc);
    setShowDeleteModal(true);
  };

  const handleDeleteConfirm = () => {
    if (documentToDelete && onDeleteDocument) {
      onDeleteDocument(documentToDelete.id);
    }
    setShowDeleteModal(false);
    setDocumentToDelete(null);
  };

  const handleDeleteCancel = () => {
    setShowDeleteModal(false);
    setDocumentToDelete(null);
  };

  const handleDuplicate = (doc) => {
    if (onDuplicateDocument) {
      onDuplicateDocument(doc);
    }
  };

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) {
      addNotification({
        type: 'alert',
        title: 'Category Name Required',
        message: 'Please enter a category name.'
      });
      return;
    }

    // The modal stays open while the duplicate check below runs, so a second
    // Enter (double-tap, key auto-repeat) or a click on "Create Category"
    // could start a second create before the first has inserted its row.
    if (creatingCategoryRef.current) return;
    creatingCategoryRef.current = true;

    try {
      const categoryName = newCategoryName.trim();

      // Check if category already exists
      const allCategories = await getDocumentCategories();
      const existingCategory = allCategories.find(cat => cat.name === categoryName);

      if (existingCategory) {
        addNotification({
          type: 'alert',
          title: 'Duplicate Category',
          message: `Category "${categoryName}" already exists.`
        });
        return;
      }

      // Also check if any documents use this category name
      if (categories.includes(categoryName)) {
        addNotification({
          type: 'alert',
          title: 'Duplicate Category',
          message: `Category "${categoryName}" already exists.`
        });
        return;
      }

      // Idempotent by name (one readwrite transaction), so even a create that
      // slipped past the checks above cannot add a second row with this name.
      const created = await createDocumentCategory({ name: categoryName });
      if (created.created === false) {
        addNotification({
          type: 'alert',
          title: 'Duplicate Category',
          message: `Category "${categoryName}" already exists.`
        });
        return;
      }

      // Auto-expand the newly created category
      setExpandedCategories(prev => {
        if (!prev.includes(categoryName)) {
          return [...prev, categoryName];
        }
        return prev;
      });

      // Move pending document to the new category if triggered from context menu
      if (moveDocAfterCategoryCreate) {
        await onUpdateDocumentCategory(moveDocAfterCategoryCreate, categoryName);
        setMoveDocAfterCategoryCreate(null);
      }

      setShowNewCategoryModal(false);
      setNewCategoryName('');
      addNotification({
        type: 'success',
        title: 'Category Created',
        message: `Category "${categoryName}" has been created.`
      });

      // Refresh documents to update categories
      if (onRefreshDocuments) {
        await onRefreshDocuments();
      }
    } catch (error) {
      console.error('Failed to create category:', error);
      addNotification({
        type: 'error',
        title: 'Creation Failed',
        message: 'Failed to create category: ' + error.message
      });
    } finally {
      creatingCategoryRef.current = false;
    }
  };

  const handleUploadToCloud = async (doc) => {
    const serverUrl = getCentralServerUrl();
    if (!serverUrl) {
      closeContextMenu();
      notifyCentralUnavailable(addNotification, 'share documents');
      return;
    }

    try {
      // IMPORTANT: Fetch the latest version from IndexedDB before syncing
      // The document list may be stale if auto-save happened recently
      const { getDocument } = await import('../../../utils/documents');
      const latestDoc = await getDocument(doc.id);

      if (!latestDoc) {
        throw new Error('Document not found');
      }

      console.log('[DocumentSidebar] Syncing latest version of document:', latestDoc.title);

      await uploadDocumentToCentral(latestDoc);

      console.log('[DocumentSidebar] Upload complete, document should now have inCloud and ownerId');

      // Push the new cloud metadata (inCloud/cloudDocumentId/ownerId) into the parent's
      // open-editor state so live Yjs sync engages immediately for the still-open editor,
      // without requiring a close/reopen or a second manual "Sync to Cloud"
      if (onCloudUploadSuccess) {
        const uploadedDoc = await getDocument(doc.id);
        if (uploadedDoc) {
          onCloudUploadSuccess(uploadedDoc);
        }
      }

      closeContextMenu();

      // Sync Changes on an already shared document (the owner's, or one a
      // Read & Write member edits) versus the first share
      addNotification(doc.inCloud
        ? { type: 'success', title: 'Changes Synced', message: 'Your changes to the document are now with the team.' }
        : { type: 'success', title: 'Shared with the Team', message: 'The document is now shared with your team.' });

      // Trigger document reload to update cloud status in UI
      // Use setTimeout to ensure IndexedDB transaction completes
      setTimeout(async () => {
        console.log('[DocumentSidebar] Refreshing documents after upload');
        if (onRefreshDocuments) {
          await onRefreshDocuments();
        }
      }, 100);
    } catch (error) {
      console.error('Upload failed:', error);
      closeContextMenu();
      addNotification({
        type: 'error',
        title: 'Sharing Failed',
        message: 'Failed to share the document: ' + error.message
      });
    }
  };

  const handleRemoveFromCloud = async (doc) => {
    try {
      closeContextMenu();

      await removeDocumentFromCentral(doc);

      addNotification({
        type: 'success',
        title: 'Stopped Sharing',
        message: `"${doc.title}" is now a local document.`
      });

      // Trigger document reload to update cloud status in UI
      // Use setTimeout to ensure IndexedDB transaction completes
      setTimeout(async () => {
        console.log('[DocumentSidebar] Refreshing documents after removal');
        if (onRefreshDocuments) {
          await onRefreshDocuments();
        }
      }, 100);
    } catch (error) {
      console.error('Remove from cloud failed:', error);
      addNotification({
        type: 'error',
        title: "Couldn't Stop Sharing",
        message: 'Failed to stop sharing:\n' + error.message
      });
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-os-card border-r border-os-border">
      {/* Header */}
      <SidebarHeader
        title="Documents"
        icon={FileText}
        onMenuClick={(e) => openMenu(e, { align: 'right' })}
        onAddClick={() => onCreateDocument && onCreateDocument()}
        status={centralServerStatus}
        statusTitle={centralServerStatus === 'online' ? 'Central server connected' : centralServerStatus === 'offline' ? 'Central server disconnected' : 'Checking central server...'}
        actions={
          <>
            <button
              onClick={onToggleSelectionMode}
              className={`p-1.5 transition-colors ${
 selectionMode
 ?'bg-os-blue text-white hover:bg-os-blue-hover'
 :'hover:bg-os-card-secondary'
 }`}
              title={selectionMode ? 'Exit selection mode' : 'Select multiple'}
            >
              {selectionMode ? <X size={16} /> : <CheckSquare size={16} className="text-os-text-secondary" />}
            </button>
          </>
        }
      />

      {/* Document List (content search lives in the "Find in Files" window:
          context menus / hamburger menu, or Ctrl/Cmd+Shift+F on the page) */}
      <div className="flex-1 overflow-y-auto bg-os-card" data-document-list="true">
        <CategoryList
            categories={categories}
            items={documents}
            getItemsByCategory={(cat) => getItemsByCategory(documents, cat)}
            expandedCategories={expandedCategories}
            onToggleCategory={toggleCategory}
            onRenameCategory={onRenameCategory}
            onCategoryContextMenu={(cat, e) => openContextMenu(e, 'category', cat)}
            editingCategory={editingCategory}
            onEditingCategoryChange={(cat) => {
              cat ? startEditingCategory(cat) : cancelEditingCategory();
            }}
            showEmptyCategories={true}
            sortCategories={(a, b) => a.localeCompare(b)}
            categoryProps={(categoryName) => {
              const categoryItems = getItemsByCategory(documents, categoryName);
              const hasCloudDocs = categoryItems.some(doc => doc.inCloud === true);
              const categoryInfo = categoryData.find(c => c.name === categoryName);

              return {
                categoryIcon: categoryInfo?.icon || null,
                isDragOver: dragOverCategory === categoryName,
                onDragOver: (e) => handleDragOver(categoryName, e),
                onDragLeave: handleDragLeave,
                onDrop: (e) => handleDrop(categoryName, e),
                isCloudCategory: hasCloudDocs,
              };
            }}
            itemListProps={{
              draggable: !selectionMode,
              onDragStart: handleDragStart,
              onDragEnd: handleDragEnd,
              renderItem: (doc) => {
                const isInLeftPane = currentDocument?.id === doc.id;
                const isInRightPane = rightPaneDocument?.id === doc.id;
                const isInBothPanes = isInLeftPane && isInRightPane;
                const isEditing = editingDocumentId === doc.id;
                const isCloudDoc = doc.inCloud === true;

                if (isEditing) {
                  return (
                    <div className="flex items-center gap-2">
                      <FileText size={14} className="text-os-text-muted shrink-0" />
                      <InlineEdit
                        value={doc.title}
                        onSave={(newTitle) => {
                          if (onRenameDocument) {
                            onRenameDocument(doc.id, newTitle);
                          }
                        }}
                        onCancel={() => setEditingDocumentId(null)}
                        isEditing={true}
                        onEditingChange={(editing) => {
                          if (!editing) {
                            setEditingDocumentId(null);
                          }
                        }}
                        className="flex-1"
                        inputClassName="text-sm"
                      />
                    </div>
                  );
                }

                return (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <FileText
                        size={14}
                        className={`shrink-0 ${
 selectionMode && selectedDocuments.includes(doc.id)
 ?'text-os-text-primary'
 : isCloudDoc && (isInLeftPane || isInRightPane || isInBothPanes) && !selectionMode
 ?'text-purple-700'
 : isInBothPanes && !selectionMode
 ?'text-os-blue'
 : isInRightPane && !selectionMode
 ?'text-green-600'
 : isInLeftPane && !selectionMode
 ?'text-os-blue'
 :'text-os-text-muted'
 }`}
                      />
                      <span title={doc.title} className={`text-sm truncate ${
 selectionMode && selectedDocuments.includes(doc.id)
 ?'text-os-text-primary font-medium'
 : isCloudDoc && (isInLeftPane || isInRightPane || isInBothPanes) && !selectionMode
 ?'text-purple-700'
 : isInBothPanes && !selectionMode
 ?'text-os-blue font-medium'
 : isInRightPane && !selectionMode
 ?'text-green-600'
 : isInLeftPane && !selectionMode
 ?'text-os-blue font-medium'
 :'text-os-text-primary'
 }`}>
                        {doc.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {doc.inCloud && (
                        <div className="flex items-center gap-0.5" title={doc.ownerId === currentMachineId ? 'Shared with the team by you' : `Shared with the team by ${doc.ownerId || 'Unknown'}`}>
                          {doc.ownerId === currentMachineId && (
                            <Crown size={10} className="text-purple-600" />
                          )}
                          <Cloud size={12} className="text-purple-600" />
                        </div>
                      )}
                      {doc.locked && (
                        <Lock size={12} className="text-yellow-600" title="Locked" />
                      )}
                    </div>
                  </div>
                );
              },
              getItemClassName: (doc, { isSelected }) => {
                const isInLeftPane = currentDocument?.id === doc.id;
                const isInRightPane = rightPaneDocument?.id === doc.id;
                const isInBothPanes = isInLeftPane && isInRightPane;
                const isCloudDoc = doc.inCloud === true;

                // Cloud documents get purple background with dynamic border color (unless in selection mode)
                if (isCloudDoc && !selectionMode) {
                  if (isInBothPanes) {
                    return 'group relative px-4 py-3 cursor-pointer transition-colors border-l-4 bg-purple-100 hover:bg-purple-200';
                  } else if (isInLeftPane || isInRightPane) {
                    return 'group relative px-4 py-3 cursor-pointer transition-colors border-l-4 bg-purple-100 hover:bg-purple-200';
                  } else {
                    return 'group relative px-4 py-3 cursor-pointer transition-colors border-l-4 bg-purple-50 hover:bg-purple-100';
                  }
                }

                // In selection mode, selected cloud documents use blue like non-cloud
                if (isCloudDoc && selectionMode && isSelected) {
                  return 'group relative px-4 py-3 cursor-pointer transition-colors border-l-4 bg-os-blue/10 border-os-blue';
                }

                // Cloud documents in selection mode but not selected
                if (isCloudDoc && selectionMode && !isSelected) {
                  return 'group relative px-4 py-3 cursor-pointer transition-colors border-l-4 hover:bg-os-card-secondary border-transparent';
                }

                // Non-cloud documents use normal styling
                return `
                  group relative px-4 py-3 cursor-pointer transition-colors border-l-4
                  ${
                    selectionMode && isSelected
                      ? 'bg-os-blue/10 border-os-blue'
                      : isInBothPanes && !selectionMode
                      ? 'border-os-blue'
                      : isInRightPane && !selectionMode
                      ? 'bg-green-50 border-green-600'
                      : isInLeftPane && !selectionMode
                      ? 'bg-blue-50 border-os-blue'
                      : 'hover:bg-os-card-secondary border-transparent'
                  }
                `;
              },
              getItemStyle: (doc) => {
                const isInLeftPane = currentDocument?.id === doc.id;
                const isInRightPane = rightPaneDocument?.id === doc.id;
                const isInBothPanes = isInLeftPane && isInRightPane;
                const isCloudDoc = doc.inCloud === true;

                // Add dynamic border color based on owner
                const style = {};
                if (isCloudDoc && doc.ownerId) {
                  // Cloud documents: use their ownerId
                  Object.assign(style, getUserBorderStyle(doc.ownerId));
                } else if (!isCloudDoc && currentMachineId) {
                  // Local documents: use current machine ID (they're owned by current user)
                  Object.assign(style, getUserBorderStyle(currentMachineId));
                }

                // Add gradient for both panes
                if (isInBothPanes && !selectionMode) {
                  style.background = 'linear-gradient(to right, rgba(37, 99, 235, 0.1) 50%, rgb(240 253 244) 50%)';
                }

                return Object.keys(style).length > 0 ? style : undefined;
              },
              onItemClick: (doc) => {
                if (selectionMode && onToggleDocumentSelection) {
                  onToggleDocumentSelection(doc.id);
                } else if (onSelectDocument) {
                  onSelectDocument(doc);
                }
              },
              onItemDoubleClick: (doc, e) => {
                e.stopPropagation();
                if (!selectionMode) {
                  // Don't allow editing cloud documents you don't own
                  if (doc.inCloud && doc.ownerId !== currentMachineId) {
                    return;
                  }
                  setEditingDocumentId(doc.id);
                }
              },
              onItemContextMenu: (doc, e) => {
                // If in selection mode and documents are selected, show bulk actions
                if (selectionMode && selectedDocuments.length > 0) {
                  openContextMenu(e, 'bulk', selectedDocuments);
                } else {
                  openContextMenu(e, 'document', doc);
                }
              },
              isItemActive: (doc) => !selectionMode && currentDocument?.id === doc.id,
              isItemSelected: selectionMode ? (doc) => selectedDocuments.includes(doc.id) : undefined,
              selectionMode,
            }}
          />
      </div>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="sc-context-menu fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px] max-h-[90vh] overflow-y-auto"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          {contextMenu.type === 'document' && contextMenu.target && (() => {
            // Get fresh document data from documents array to avoid stale state
            const freshDoc = documents.find(d => d.id === contextMenu.target.id) || contextMenu.target;
            const isInRightPane = rightPaneDocument?.id === freshDoc.id;

            return (
              <>
                {isInRightPane ? (
                  <button
                    onClick={() => {
                      onSelectDocument && onSelectDocument(freshDoc);
                      closeContextMenu();
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="openLeft" />
                    Open in Left Side
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      onOpenInRightPane && onOpenInRightPane(freshDoc);
                      closeContextMenu();
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="openRight" />
                    Open in Right Side
                  </button>
                )}
                <button
                  onClick={() => {
                    handleDuplicate(freshDoc);
                    closeContextMenu();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="duplicate" />
                  Duplicate
                </button>
                <button
                  onClick={() => {
                    onFindInFiles && onFindInFiles(null);
                    closeContextMenu();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="findInFiles" />
                  Find in Files
                </button>
                {/* Move to Category submenu (shared CategorySubmenu - also used by the Tasks page) */}
                <CategorySubmenu
                  label="Move to Category"
                  icon={MENU_ICONS.moveToCategory}
                  categories={categories.filter(cat => cat !== freshDoc.category)}
                  onSelect={async (cat) => {
                    await onUpdateDocumentCategory(freshDoc, cat);
                    closeContextMenu();
                  }}
                  onCreateNew={(query) => {
                    setMoveDocAfterCategoryCreate(freshDoc);
                    setNewCategoryName(query.trim());
                    setShowNewCategoryModal(true);
                    closeContextMenu();
                  }}
                />
                {/* Share: documents not shared yet */}
                {!isDocumentInCloud(freshDoc) && (
                  <button
                    onClick={() => handleUploadToCloud(freshDoc)}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="uploadToCloud" />
                    Share with the Team
                  </button>
                )}
                {/* Sync Changes for owners and users with write permissions */}
                {isDocumentInCloud(freshDoc) && (freshDoc.ownerId === currentMachineId || freshDoc.permissions?.[currentMachineId] === 'write') && (
                  <button
                    onClick={() => handleUploadToCloud(freshDoc)}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="syncToCloud" />
                    Sync Changes
                  </button>
                )}
                {/* Stop Sharing and Manage Permissions - only for owners */}
                {isDocumentInCloud(freshDoc) && freshDoc.ownerId === currentMachineId && (
                  <>
                    <button
                      onClick={() => handleRemoveFromCloud(freshDoc)}
                      className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                    >
                      <MenuItemIcon action="removeFromCloud" />
                      Stop Sharing
                    </button>
                    <button
                      onClick={() => {
                        setPermissionsDocument(freshDoc);
                        setShowPermissionsModal(true);
                        closeContextMenu();
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                    >
                      <MenuItemIcon action="managePermissions" />
                      Manage Permissions
                    </button>
                  </>
                )}
                <div className="border-t border-os-border my-1"></div>
                {contextMenu.target.locked ? (
                  <button
                    onClick={() => {
                      onToggleLock && onToggleLock(contextMenu.target);
                      closeContextMenu();
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="unlock" />
                    Unlock
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      onToggleLock && onToggleLock(contextMenu.target);
                      closeContextMenu();
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                  >
                    <MenuItemIcon action="lock" />
                    Lock
                  </button>
                )}
                <button
                  onClick={() => {
                    // First open the document
                    onSelectDocument && onSelectDocument(contextMenu.target);
                    // Then enable preview after a small delay to ensure DocumentEditor has mounted
                    setTimeout(() => {
                      onPreview && onPreview(contextMenu.target);
                    }, 50);
                    closeContextMenu();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="preview" />
                  Preview
                </button>
                <button
                  onClick={() => {
                    // Open AI Chat sidebar first
                    window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', {
                      detail: { isOpen: true }
                    }));

                    // Add context after a short delay to ensure sidebar is mounted
                    setTimeout(() => {
                      window.dispatchEvent(new CustomEvent('addAIContext', {
                        detail: {
                          contextType: `Document: ${freshDoc.title}`,
                          contextData: freshDoc
                        }
                      }));
                    }, 100);

                    closeContextMenu();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="aiContext" />
                  Add as AI Context
                </button>
                <div className="border-t border-os-border my-1"></div>
                <button
                  onClick={() => {
                    handleExportDocumentsJSON([freshDoc], `document-${freshDoc.title}`, `${docLabel(freshDoc)} → JSON with images`);
                    closeContextMenu();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="exportJson" />
                  Export Document (JSON)
                </button>
                <button
                  onClick={() => {
                    handleExportDocumentZip(freshDoc);
                    closeContextMenu();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="exportZip" />
                  Export Document (ZIP)
                </button>
                <button
                  onClick={() => {
                    handleExportPDF(freshDoc);
                    closeContextMenu();
                  }}
                  // Printed by the Electron main process: in a plain browser
                  // (dev server) there is nothing to print with
                  disabled={!can('pdfExport')}
                  title={can('pdfExport') ? undefined : desktopOnly('PDF export')}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                  <MenuItemIcon action="exportPdf" />
                  Export PDF
                </button>
                <button
                  onClick={() => {
                    handleExportBase64([freshDoc], `${docLabel(freshDoc)} → Base64 with images`);
                    closeContextMenu();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="exportBase64" />
                  Export as Base64
                </button>
                <div className="border-t border-os-border my-1"></div>
                <button
                  onClick={() => {
                    handleDeleteClick(contextMenu.target);
                    closeContextMenu();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="delete" danger />
                  Delete Document
                </button>
              </>
            );
          })()}

          {contextMenu.type === 'bulk' && (
            <>
              <div className="px-4 py-2 text-xs font-medium text-os-text-secondary border-b border-os-border">
                {selectedDocuments.length} document{selectedDocuments.length !== 1 ? 's' : ''} selected
              </div>
              <button
                onClick={() => {
                  const selectedDocs = documents.filter(doc => selectedDocuments.includes(doc.id));
                  handleExportDocumentsJSON(
                    selectedDocs,
                    `documents-export-${selectedDocs.length}-items`,
                    `${countLabel(selectedDocs.length)} selected → JSON with images`
                  );
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="exportJson" />
                Export Selected (JSON)
              </button>
              <button
                onClick={() => {
                  const selectedDocs = documents.filter(doc => selectedDocuments.includes(doc.id));
                  handleExportBase64(selectedDocs, `${countLabel(selectedDocs.length)} selected → Base64 with images`);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="exportBase64" />
                Export as Base64
              </button>
              <button
                onClick={() => {
                  onBulkMove && onBulkMove();
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="moveToCategory" />
                Move to Category
              </button>

              {/* Sharing - only when the user owns at least one shared document or has local documents */}
              {(() => {
                const selectedDocs = documents.filter(doc => selectedDocuments.includes(doc.id));
                const localDocs = selectedDocs.filter(doc => !doc.inCloud);
                const ownedCloudDocs = selectedDocs.filter(doc => doc.inCloud && doc.ownerId === currentMachineId);
                const hasLocalDocs = localDocs.length > 0;
                const hasOwnedCloudDocs = ownedCloudDocs.length > 0;

                return (hasLocalDocs || hasOwnedCloudDocs) && (
                  <>
                    <div className="border-t border-os-border my-1"></div>
                    {hasLocalDocs && (
                      <button
                        onClick={() => {
                          handleBulkSyncToCloud();
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="uploadToCloud" />
                        Share with the Team
                      </button>
                    )}
                    {hasOwnedCloudDocs && (
                      <button
                        onClick={() => {
                          handleBulkSyncToCloud();
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="syncToCloud" />
                        Sync Changes
                      </button>
                    )}
                    {hasOwnedCloudDocs && (
                      <button
                        onClick={() => {
                          handleBulkRemoveFromCloud();
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="removeFromCloud" />
                        Stop Sharing
                      </button>
                    )}
                    {hasOwnedCloudDocs && (
                      <button
                        onClick={() => {
                          setPermissionsDocuments(ownedCloudDocs);
                          setShowPermissionsModal(true);
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="managePermissions" />
                        Manage Permissions
                      </button>
                    )}
                  </>
                );
              })()}

              <div className="border-t border-os-border my-1"></div>
              <button
                onClick={() => {
                  onBulkDelete && onBulkDelete();
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="delete" danger />
                Delete Selected
              </button>
            </>
          )}

          {contextMenu.type === 'category' && (
            <>
              <button
                onClick={() => {
                  onCreateDocument && onCreateDocument(contextMenu.target);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="newDocument" />
                New Document
              </button>
              <button
                onClick={() => {
                  onFindInFiles && onFindInFiles({ category: contextMenu.target });
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="findInFiles" />
                Find in Files
              </button>
              <div className="border-t border-os-border my-1"></div>
              <button
                onClick={() => {
                  onEditCategoryIcon && onEditCategoryIcon(contextMenu.target);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="edit" />
                Edit Category
              </button>
              <div className="border-t border-os-border my-1"></div>
              <button
                onClick={() => {
                  handleExportCategory(contextMenu.target);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="exportJson" />
                Export Category (JSON)
              </button>
              <button
                onClick={() => {
                  const categoryDocs = documents.filter(doc => (doc.category || 'General') === contextMenu.target);
                  handleExportBase64(
                    categoryDocs,
                    `"${contextMenu.target}" (${countLabel(categoryDocs.length)}) → Base64 with images`
                  );
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="exportBase64" />
                Export as Base64
              </button>
              <button
                onClick={() => {
                  handleExportCategoryZip(contextMenu.target);
                  closeContextMenu();
                }}
                className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
              >
                <MenuItemIcon action="exportZip" />
                Export Category (ZIP)
              </button>
              {(() => {
                const categoryDocs = documents.filter(doc => (doc.category || 'General') === contextMenu.target);
                const localDocs = categoryDocs.filter(doc => !doc.inCloud);
                const ownedCloudDocs = categoryDocs.filter(doc => doc.inCloud && doc.ownerId === currentMachineId);
                const hasLocalDocs = localDocs.length > 0;
                const hasOwnedCloudDocs = ownedCloudDocs.length > 0;

                return (hasLocalDocs || hasOwnedCloudDocs) && (
                  <>
                    <div className="h-px bg-os-border my-1" />
                    {hasLocalDocs && (
                      <button
                        onClick={() => {
                          handleCategoryUploadOrSyncToCloud(contextMenu.target);
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="uploadToCloud" />
                        Share with the Team
                      </button>
                    )}
                    {hasOwnedCloudDocs && (
                      <button
                        onClick={() => {
                          handleCategoryUploadOrSyncToCloud(contextMenu.target);
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="syncToCloud" />
                        Sync Changes
                      </button>
                    )}
                    {hasOwnedCloudDocs && (
                      <button
                        onClick={() => {
                          handleCategoryRemoveFromCloud(contextMenu.target);
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="removeFromCloud" />
                        Stop Sharing
                      </button>
                    )}
                    {hasOwnedCloudDocs && (
                      <button
                        onClick={() => {
                          setPermissionsDocuments(ownedCloudDocs);
                          setShowPermissionsModal(true);
                          closeContextMenu();
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        <MenuItemIcon action="managePermissions" />
                        Manage Permissions
                      </button>
                    )}
                  </>
                );
              })()}
              {(() => {
                const categoryDocs = documents.filter(doc => (doc.category || 'General') === contextMenu.target);
                const isEmpty = categoryDocs.length === 0;
                const isGeneral = contextMenu.target === 'General';

                // Show delete option for empty categories (except General)
                return isEmpty && !isGeneral && (
                  <>
                    <div className="h-px bg-os-border my-1" />
                    <button
                      onClick={async () => {
                        try {
                          console.log('[DocumentSidebar] Attempting to delete category:', contextMenu.target);
                          // Find the category in the database
                          const allCategories = await getDocumentCategories();
                          console.log('[DocumentSidebar] All categories:', allCategories);
                          const category = allCategories.find(cat => cat.name === contextMenu.target);
                          console.log('[DocumentSidebar] Found category:', category);

                          if (category) {
                            await deleteDocumentCategory(category.id);
                            addNotification({
                              type: 'success',
                              title: 'Category Deleted',
                              message: `Category "${contextMenu.target}" has been deleted.`
                            });
                            if (onRefreshDocuments) {
                              await onRefreshDocuments();
                            }
                          } else {
                            addNotification({
                              type: 'error',
                              title: 'Delete Failed',
                              message: `Category "${contextMenu.target}" not found in database.`
                            });
                          }
                        } catch (error) {
                          console.error('Failed to delete category:', error);
                          addNotification({
                            type: 'error',
                            title: 'Delete Failed',
                            message: 'Failed to delete category: ' + error.message
                          });
                        }
                        closeContextMenu();
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
                    >
                      <MenuItemIcon action="delete" danger />
                      Delete Empty Category
                    </button>
                  </>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* Hamburger Menu */}
      <HamburgerMenu
        isOpen={menuOpen}
        position={menuPosition}
        onClose={closeMenu}
        ref={menuRef}
      >
        <HamburgerMenuItem
          icon={MENU_ICONS.newDocument}
          label="New Document"
          onClick={() => {
            onCreateDocument && onCreateDocument();
            closeMenu();
          }}
        />
        <HamburgerMenuItem
          icon={MENU_ICONS.newCategory}
          label="New Category"
          onClick={() => {
            setShowNewCategoryModal(true);
            closeMenu();
          }}
        />
        <HamburgerMenuItem
          icon={MENU_ICONS.newCalendarEntry}
          label="New Calendar Entry"
          onClick={() => {
            setShowCalendarModal(true);
            closeMenu();
          }}
        />
        <HamburgerMenuItem
          icon={MENU_ICONS.mediaLibrary}
          label="Media Library"
          onClick={() => {
            setShowMediaLibrary(true);
            closeMenu();
          }}
        />
        <HamburgerMenuDivider />
        <HamburgerMenuItem
          icon={MENU_ICONS.findInFiles}
          label="Find in Files"
          onClick={() => {
            onFindInFiles && onFindInFiles(null);
            closeMenu();
          }}
        />
        {!isDesktopApp() && (
          <>
            <HamburgerMenuDivider />
            {/* The desktop app opens Settings from its application menu; in a
                browser it opens from here, over this page (CompactSidebar
                listens for the event and shows the dialog). */}
            <HamburgerMenuItem
              icon={MENU_ICONS.settings}
              label="Settings"
              onClick={() => {
                closeMenu();
                openAppSettings('general');
              }}
            />
          </>
        )}
        <HamburgerMenuDivider />
        <div className="px-4 py-2">
          <div className="text-xs font-semibold text-os-text-secondary uppercase tracking-wide mb-2">Sort by</div>
          <div className="space-y-1">
            <button
              onClick={() => {
                onSortChange && onSortChange('date');
                closeMenu();
              }}
              className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
 sortBy ==='date'?'bg-os-blue text-white':'hover:bg-os-card-secondary'
 }`}
            >
              <MenuItemIcon action="sortByDate" className={sortBy === 'date' ? 'text-white' : 'text-os-text-secondary'} />
              Date Modified
            </button>
            <button
              onClick={() => {
                onSortChange && onSortChange('title');
                closeMenu();
              }}
              className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
 sortBy ==='title'?'bg-os-blue text-white':'hover:bg-os-card-secondary'
 }`}
            >
              <MenuItemIcon action="sortByTitle" className={sortBy === 'title' ? 'text-white' : 'text-os-text-secondary'} />
              Title (A-Z)
            </button>
            <button
              onClick={() => {
                onSortChange && onSortChange('cloud');
                closeMenu();
              }}
              className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
 sortBy ==='cloud'?'bg-os-blue text-white':'hover:bg-os-card-secondary'
 }`}
            >
              <MenuItemIcon action="sortByCloud" className={sortBy === 'cloud' ? 'text-white' : 'text-os-text-secondary'} />
              Shared Documents
            </button>
          </div>
        </div>
        <HamburgerMenuDivider />
        <HamburgerMenuItem
          icon={MENU_ICONS.import}
          label="Import from JSON"
          onClick={handleImport}
        />
        <HamburgerMenuItem
          icon={MENU_ICONS.import}
          label="Import from Base64"
          onClick={handleImportBase64}
        />
        <HamburgerMenuDivider />
        <HamburgerMenuItem
          icon={MENU_ICONS.exportJson}
          label="Export All (JSON)"
          onClick={handleExport}
        />
        <HamburgerMenuItem
          icon={MENU_ICONS.exportBase64}
          label="Export All as Base64"
          onClick={() => {
            closeMenu();
            handleExportBase64(documents, `${countLabel(documents.length)} → Base64 with images`);
          }}
        />
        <HamburgerMenuItem
          icon={MENU_ICONS.exportZip}
          label="Export All (ZIP)"
          onClick={handleExportZip}
        />
      </HamburgerMenu>

      {/* Delete Confirmation */}
      {showDeleteModal && !documentToDelete?.locked && (
        <ConfirmationModal
          isOpen={showDeleteModal}
          onConfirm={handleDeleteConfirm}
          onClose={handleDeleteCancel}
          title="Delete Document"
          message={`Are you sure you want to delete "${documentToDelete?.title}"?\n\nThis action cannot be undone.`}
          confirmText="Delete"
          dangerous={true}
        />
      )}

      {/* Locked Document Delete Confirmation - Requires typing "I REALLY DO" */}
      {showDeleteModal && documentToDelete?.locked && (
        <TypedConfirmationModal
          isOpen={showDeleteModal}
          onConfirm={handleDeleteConfirm}
          onCancel={handleDeleteCancel}
          title="Delete Locked Document?"
          type="danger"
          confirmLabel="Delete Locked Document"
          confirmPhrase="I REALLY DO"
          message={
            <div>
              <p className="mb-2">
                You are about to delete <strong>"{documentToDelete?.title}"</strong> which is <strong className="text-orange-600">🔒 LOCKED</strong>.
              </p>
              <p>
                This action cannot be undone.
              </p>
            </div>
          }
        />
      )}

      {/* Export PDF: page size / orientation, then the progress modal below */}
      {pdfOptionsDoc && (
        <PdfExportOptionsModal
          isOpen
          onClose={() => setPdfOptionsDoc(null)}
          onExport={(pageOptions) => startPdfExport(pdfOptionsDoc, pageOptions)}
          documentTitle={docLabel(pdfOptionsDoc)}
        />
      )}

      {/* Export Progress (shared by every export action above) */}
      <ExportProgressModal
        isOpen={exportFlow.isOpen}
        job={exportFlow.job}
        onClose={exportFlow.handleClose}
      />

      {/* Import Flow */}
      <ImportFlow
        isInputOpen={importFlow.showInputModal}
        isProgressOpen={importFlow.showProgressModal}
        onInputClose={importFlow.handleInputClose}
        onProgressClose={importFlow.handleProgressClose}
        onValidated={importFlow.handleInputValidated}
        importData={importFlow.importData}
        importOptions={importFlow.importOptions}
        title="Import Documents"
        placeholder="Paste your JSON array of documents here..."
        validateFn={importFlow.validateFn}
        onRun={importFlow.onRun}
        onComplete={importFlow.onComplete}
        renderStats={renderImportStats}
        importLabel="Import Documents"
        mergeLabel={DOCUMENTS_MERGE_LABEL}
        mergeHint={documentsMergeHint}
        exampleData={[
          {
            title: 'Example Document 1',
            content: 'This is example content',
            category: 'General',
            locked: false
          },
          {
            title: 'Example Document 2',
            content: 'Another example',
            category: 'Examples',
            locked: false
          }
        ]}
      />

      {/* Base64 Export/Import Modal */}
      {showBase64Modal && (
        <BaseModal
          isOpen={showBase64Modal}
          onClose={closeBase64Modal}
          className="max-w-3xl w-full rounded-lg"
        >
          <div className="p-6 max-h-[75vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-os-text-primary">
                {base64Mode === 'export' ? 'Base64 Export' : 'Import from Base64'}
              </h3>
              <button
                onClick={closeBase64Modal}
                className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
              >
                <X size={20} className="text-os-text-secondary" />
              </button>
            </div>

            <div className="mb-4">
              <label className="block text-sm text-os-text-secondary mb-2">
                {base64Mode === 'export' ? 'Base64 Encoded Data (copied to clipboard):' : 'Paste Base64 Encoded Data:'}
              </label>
              <textarea
                value={base64Data}
                onChange={(e) => {
                  setBase64Data(e.target.value);
                  setBase64Result(null);
                  setBase64Error(null);
                }}
                readOnly={base64Mode === 'export' || base64Result?.kind === 'import'}
                className="os-terminal w-full h-64 px-3 py-2 border border-os-input-border rounded-sm font-mono text-xs resize-none outline-hidden focus:border-os-blue focus:ring-2 focus:ring-os-blue"
                placeholder={base64Mode === 'import' ? 'Paste your Base64 encoded data here...' : ''}
              />
            </div>

            {base64Mode === 'import' && (
              <div className="mb-4">
                <MergeModeOption
                  checked={base64Merge}
                  disabled={base64Busy !== null || base64Result?.kind === 'import'}
                  onChange={(checked) => { setBase64Merge(checked); setBase64Result(null); setBase64Error(null); }}
                  label={DOCUMENTS_MERGE_LABEL}
                  hint={documentsMergeHint(base64Merge)}
                />
              </div>
            )}

            {base64Mode === 'import' && base64Error && (
              <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm flex items-start gap-2">
                <AlertCircle size={16} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-red-800 dark:text-red-200 mb-1">Validation Error</div>
                  <div className="text-sm text-red-700 dark:text-red-300">{base64Error}</div>
                </div>
              </div>
            )}

            {base64Mode === 'import' && base64Result && (
              <div className="mb-4"><DocumentsImportStats result={base64Result} /></div>
            )}

            {base64Mode === 'export' && (
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(base64Data);
                      addNotification({
                        type: 'success',
                        title: 'Copied',
                        message: 'Base64 data copied to clipboard.'
                      });
                    } catch {
                      addNotification({
                        type: 'error',
                        title: 'Copy Failed',
                        message: 'Failed to copy to clipboard.'
                      });
                    }
                  }}
                  className="px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors rounded-sm"
                >
                  Copy Again
                </button>
                <button
                  onClick={closeBase64Modal}
                  className="px-4 py-2 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors rounded-sm"
                >
                  Close
                </button>
              </div>
            )}
          </div>

          {base64Mode === 'import' && (
            <ImportFooter
              imported={base64Result?.kind === 'import'}
              busy={base64Busy}
              onCancel={closeBase64Modal}
              onClose={closeBase64Modal}
              onDryRun={() => runBase64Import(true)}
              onImport={() => runBase64Import(false)}
              disabled={!base64Data.trim()}
              importLabel="Import Documents"
            />
          )}
        </BaseModal>
      )}

      {/* Permissions Modal */}
      <DocumentPermissionsModal
        isOpen={showPermissionsModal}
        onClose={() => {
          setShowPermissionsModal(false);
          setPermissionsDocument(null);
          setPermissionsDocuments(null);
        }}
        document={permissionsDocument}
        documents={permissionsDocuments}
        onSave={handleSavePermissions}
      />

      {/* New Category Modal */}
      {showNewCategoryModal && (
        <BaseModal
          isOpen={showNewCategoryModal}
          onClose={() => {
            setShowNewCategoryModal(false);
            setNewCategoryName('');
            setMoveDocAfterCategoryCreate(null);
          }}
          className="max-w-md w-full rounded-lg"
        >
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-os-text-primary">
                New Category
              </h3>
              <button
                onClick={() => {
                  setShowNewCategoryModal(false);
                  setNewCategoryName('');
                  setMoveDocAfterCategoryCreate(null);
                }}
                className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
              >
                <X size={20} className="text-os-text-secondary" />
              </button>
            </div>

            <div className="mb-4">
              <label className="block text-sm text-os-text-secondary mb-2">
                Category Name
              </label>
              <input
                type="text"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="Enter category name..."
                className="w-full px-3 py-2 border border-os-input-border rounded-sm outline-hidden focus:border-os-blue focus:ring-2 focus:ring-os-blue bg-os-input-bg text-os-text-primary"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCreateCategory();
                  } else if (e.key === 'Escape') {
                    setShowNewCategoryModal(false);
                    setNewCategoryName('');
                    setMoveDocAfterCategoryCreate(null);
                  }
                }}
              />
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  setShowNewCategoryModal(false);
                  setNewCategoryName('');
                  setMoveDocAfterCategoryCreate(null);
                }}
                className="px-4 py-2 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors rounded-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateCategory}
                disabled={!newCategoryName.trim()}
                className="px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors rounded-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Category
              </button>
            </div>
          </div>
        </BaseModal>
      )}

      {/* Calendar Event Modal */}
      {showCalendarModal && (
        <CalendarEventModal
          isOpen={showCalendarModal}
          onClose={() => setShowCalendarModal(false)}
          mode="create"
          onEventCreated={() => {
            setShowCalendarModal(false);
            addNotification({
              type: 'success',
              title: 'Event Created',
              message: 'Calendar event has been created successfully.'
            });
          }}
        />
      )}

      {/* Media Library Modal */}
      <MediaLibraryModal
        isOpen={showMediaLibrary}
        onClose={() => setShowMediaLibrary(false)}
      />
    </div>
  );
}
