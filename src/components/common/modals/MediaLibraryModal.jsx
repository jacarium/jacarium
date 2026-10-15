import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Upload, Search, Image as ImageIcon, Download, MoreHorizontal, Check, Tag, FileText, CheckSquare, Square } from 'lucide-react';
import {
  uploadMedia, getAllMedia, deleteMedia, updateMediaTags, getMediaUsage
} from '../../../utils/media';
import { useNotifications } from '../../../contexts/NotificationContext';
import ConfirmationModal from '../ConfirmationModal';
import { MenuItemIcon } from '../../common/menus/MenuItemIcon';

const UNTAGGED = '__untagged__';

function formatSize(bytes) {
  if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(filename) {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0 || idx === filename.length - 1) return 'other';
  return filename.slice(idx + 1).toLowerCase();
}

/**
 * MediaLibraryModal - Modal for managing document images
 * Two tabs: Browse and Upload
 * Browse supports search (filename + tags), type/usage/tag filters, sorting,
 * multi-select bulk delete, per-image tags, and usage (orphan) detection
 * computed by scanning documents for attachment: references.
 * Shows insert affordances when an onSelectImage callback is provided.
 */
export default function MediaLibraryModal({ isOpen, onClose, onSelectImage }) {
  const [media, setMedia] = useState([]);
  const [usage, setUsage] = useState(new Map()); // filename -> [{id, title}]
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const [usageFilter, setUsageFilter] = useState('all'); // 'all' | 'used' | 'unused'
  const [typeFilter, setTypeFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);
  const [activeTab, setActiveTab] = useState('browse'); // 'browse' or 'upload'
  const [recentlyUploaded, setRecentlyUploaded] = useState([]); // media records from the latest upload batch
  const [contextMenu, setContextMenu] = useState(null); // { x, y, item }
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [mediaToDelete, setMediaToDelete] = useState(null); // { id, filename }
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [tagEditor, setTagEditor] = useState(null); // { item, value }
  const fileInputRef = useRef(null);
  const { addNotification } = useNotifications();

  useEffect(() => {
    if (isOpen) {
      loadMedia();
      loadUsage();
      // Reset to browse tab when opening
      // Intentional external-system sync in an effect; the setState here is
      // the subscription/measurement result, not derived render state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveTab('browse');
      setRecentlyUploaded([]);
      setSelectedIds(new Set());
      setSearchQuery('');
    }
  }, [isOpen]);

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [contextMenu]);

  async function loadMedia() {
    const allMedia = await getAllMedia();
    setMedia(allMedia);
    return allMedia;
  }

  async function loadUsage() {
    try {
      setUsage(await getMediaUsage());
    } catch (error) {
      console.error('[MediaLibrary] Failed to compute usage:', error);
    }
  }

  const usedBy = (filename) => usage.get(filename) || [];

  // All distinct tags and file types present in the library (for filter menus)
  const allTags = useMemo(() => {
    const tags = new Set();
    for (const item of media) {
      for (const tag of item.tags || []) tags.add(tag);
    }
    return [...tags].sort((a, b) => a.localeCompare(b));
  }, [media]);

  const allTypes = useMemo(() => {
    const types = new Set();
    for (const item of media) types.add(fileExtension(item.filename));
    return [...types].sort();
  }, [media]);

  const totalSize = useMemo(
    () => media.reduce((sum, item) => sum + (item.size || 0), 0),
    [media]
  );

  const filteredMedia = useMemo(() => {
    let result = media;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((item) =>
        item.filename.toLowerCase().includes(q) ||
        (item.tags || []).some((tag) => tag.toLowerCase().includes(q))
      );
    }
    if (typeFilter !== 'all') {
      result = result.filter((item) => fileExtension(item.filename) === typeFilter);
    }
    if (usageFilter !== 'all') {
      result = result.filter((item) => {
        const used = usedBy(item.filename).length > 0;
        return usageFilter === 'used' ? used : !used;
      });
    }
    if (tagFilter !== 'all') {
      result = result.filter((item) =>
        tagFilter === UNTAGGED
          ? (item.tags || []).length === 0
          : (item.tags || []).includes(tagFilter)
      );
    }

    const byNewest = (a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt);
    const sorted = [...result];
    switch (sortBy) {
      case 'oldest':
        sorted.sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));
        break;
      case 'name':
        sorted.sort((a, b) => a.filename.localeCompare(b.filename));
        break;
      case 'size':
        sorted.sort((a, b) => (b.size || 0) - (a.size || 0));
        break;
      case 'usage':
        sorted.sort((a, b) =>
          usedBy(b.filename).length - usedBy(a.filename).length || byNewest(a, b)
        );
        break;
      case 'newest':
      default:
        sorted.sort(byNewest);
        break;
    }
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, usage, searchQuery, typeFilter, usageFilter, tagFilter, sortBy]);

  async function handleFileUpload(files) {
    setUploading(true);
    setRecentlyUploaded([]); // Only reflect the latest batch
    const uploaded = [];
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) {
          addNotification({
            type: 'error',
            title: 'Invalid File',
            message: `${file.name} is not an image file`
          });
          continue;
        }

        try {
          uploaded.push(await uploadMedia(file));
        } catch (error) {
          addNotification({
            type: 'error',
            title: 'Upload Failed',
            message: `${file.name}: ${error.message}`
          });
        }
      }

      if (uploaded.length > 0) {
        addNotification({
          type: 'success',
          title: 'Upload Complete',
          message: `Uploaded ${uploaded.length} image(s)`
        });

        const refreshed = await loadMedia();
        const uploadedIds = new Set(uploaded.map((item) => item.id));
        setRecentlyUploaded(refreshed.filter((item) => uploadedIds.has(item.id)));
      }
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Upload Failed',
        message: error.message
      });
    } finally {
      setUploading(false);
    }
  }

  function handleDelete(id, filename) {
    setMediaToDelete({ id, filename });
    setShowDeleteModal(true);
    setContextMenu(null);
  }

  async function handleDeleteConfirm() {
    if (!mediaToDelete) return;

    try {
      await deleteMedia(mediaToDelete.id);
      addNotification({
        type: 'success',
        title: 'Deleted',
        message: `${mediaToDelete.filename} deleted`
      });
      loadMedia();
      setSelectedIds((prev) => {
        if (!prev.has(mediaToDelete.id)) return prev;
        const next = new Set(prev);
        next.delete(mediaToDelete.id);
        return next;
      });
      setPreviewImage(null); // Close lightbox if deleting from there
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: error.message
      });
    } finally {
      setShowDeleteModal(false);
      setMediaToDelete(null);
    }
  }

  function handleDeleteCancel() {
    setShowDeleteModal(false);
    setMediaToDelete(null);
  }

  async function handleBulkDeleteConfirm() {
    const ids = [...selectedIds];
    let deleted = 0;
    for (const id of ids) {
      try {
        await deleteMedia(id);
        deleted += 1;
      } catch (error) {
        console.error('[MediaLibrary] Bulk delete failed for id', id, error);
      }
    }
    addNotification({
      type: deleted === ids.length ? 'success' : 'error',
      title: 'Bulk Delete',
      message: `Deleted ${deleted} of ${ids.length} image(s)`
    });
    setSelectedIds(new Set());
    setShowBulkDeleteModal(false);
    loadMedia();
  }

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedIds(new Set(filteredMedia.map((item) => item.id)));
  }

  function openTagEditor(item) {
    setTagEditor({ item, value: (item.tags || []).join(', ') });
    setContextMenu(null);
  }

  async function handleTagEditorSave() {
    if (!tagEditor) return;
    try {
      const tags = tagEditor.value.split(',');
      const normalized = await updateMediaTags(tagEditor.item.id, tags);
      setMedia((prev) => prev.map((item) =>
        item.id === tagEditor.item.id ? { ...item, tags: normalized } : item
      ));
      setPreviewImage((prev) =>
        prev && prev.id === tagEditor.item.id ? { ...prev, tags: normalized } : prev
      );
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Tag Update Failed',
        message: error.message
      });
    } finally {
      setTagEditor(null);
    }
  }

  function handleDownload(dataUrl, filename) {
    try {
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = filename;
      link.click();
      addNotification({
        type: 'success',
        title: 'Downloaded',
        message: `${filename} downloaded`
      });
    } catch (error) {
      addNotification({
        type: 'error',
        title: 'Download Failed',
        message: error.message
      });
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    setDragOver(false);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    handleFileUpload(files);
  }

  function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    handleFileUpload(files);
  }

  function handleContextMenu(e, item) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      item
    });
  }

  function handleSelectImage(filename) {
    if (onSelectImage) {
      onSelectImage(filename);
      onClose();
    }
  }

  function deleteMessage(item) {
    const docs = usedBy(item.filename);
    let message = `Are you sure you want to delete "${item.filename}"?`;
    if (docs.length > 0) {
      const titles = docs.slice(0, 5).map((doc) => `• ${doc.title}`).join('\n');
      const more = docs.length > 5 ? `\n…and ${docs.length - 5} more` : '';
      message += `\n\nWarning: this image is still used by ${docs.length} document(s):\n${titles}${more}\n\nThose references will show a broken image.`;
    }
    message += '\n\nThis action cannot be undone.';
    return message;
  }

  const selectedInUse = useMemo(() => {
    if (selectedIds.size === 0) return 0;
    let count = 0;
    for (const item of media) {
      if (selectedIds.has(item.id) && usedBy(item.filename).length > 0) count += 1;
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, media, usage]);

  if (!isOpen) return null;

  const hasActiveFilters = searchQuery || typeFilter !== 'all' ||
    usageFilter !== 'all' || tagFilter !== 'all';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-os-modal rounded-lg shadow-xl max-w-6xl w-full h-[85vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-os-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ImageIcon size={18} className="text-blue-600" />
            <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
              Media Library
            </h2>
            {media.length > 0 && (
              <span className="text-xs text-os-text-muted ml-2">
                {media.length} image{media.length === 1 ? '' : 's'} · {formatSize(totalSize)}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-sidebar-hover transition-colors"
          >
            <X size={20} className="text-os-text-secondary" />
          </button>
        </div>

        {/* Tabs - Always show Browse and Upload */}
        <div className="border-b border-os-border">
          <div className="flex px-4">
            <button
              onClick={() => {
                setActiveTab('browse');
                // Preview reflects only the latest action; clear it when leaving the Upload tab
                setRecentlyUploaded([]);
              }}
              className={`px-4 py-3 text-sm border-b-2 transition-colors ${
 activeTab ==='browse'
 ?'border-blue-600 text-blue-600'
 :'border-transparent text-os-text-secondary hover:text-os-text-primary hover:border-os-border'
 }`}
            >
              Browse
            </button>
            <button
              onClick={() => setActiveTab('upload')}
              className={`px-4 py-3 text-sm border-b-2 transition-colors ${
 activeTab ==='upload'
 ?'border-blue-600 text-blue-600'
 :'border-transparent text-os-text-secondary hover:text-os-text-primary hover:border-os-border'
 }`}
            >
              Upload
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'upload' ? (
            // Upload Tab
            <div className="flex flex-col items-center justify-center min-h-full gap-6">
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`rounded-lg p-12 text-center transition-colors w-full max-w-2xl ${
 dragOver
 ?'bg-blue-50 dark:bg-blue-900/20'
 :''
 }`}
              >
                <Upload size={64} className="mx-auto mb-4 text-os-text-muted" />
                <p className="text-lg font-medium text-os-text-primary mb-2">
                  Upload Images
                </p>
                <p className="text-sm text-os-text-secondary mb-4">
                  Drag and drop images here, or
                </p>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="px-6 py-2 bg-blue-600 text-white rounded-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {uploading ? 'Uploading...' : 'Browse Files'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <p className="text-xs text-os-text-muted mt-4">
                  Supports: JPG, PNG, GIF, WebP
                </p>
              </div>

              {/* Just-uploaded preview */}
              {recentlyUploaded.length > 0 && (
                <div className="w-full max-w-2xl">
                  <div className="flex items-center gap-2 mb-2">
                    <Check size={14} className="text-green-600" />
                    <p className="text-sm font-medium text-os-text-primary">
                      Uploaded {recentlyUploaded.length} image{recentlyUploaded.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                    {recentlyUploaded.map((item) => (
                      <div
                        key={item.id}
                        className="border border-os-border rounded-lg overflow-hidden"
                      >
                        <div className="aspect-square bg-os-card-secondary dark:bg-os-sidebar">
                          <img
                            src={item.data}
                            alt={item.filename}
                            loading="lazy"
                            decoding="async"
                            className="w-full h-full object-cover"
                          />
                        </div>
                        <div className="p-1.5 bg-os-modal flex items-center gap-1">
                          <Check size={12} className="text-green-600 shrink-0" />
                          <p className="text-xs text-os-text-primary truncate" title={item.filename}>
                            {item.filename}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            // Browse Tab
            <>
              {/* Search + Filters */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[200px]">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-os-text-muted" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by filename or tag..."
                    className="w-full pl-10 pr-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-modal text-os-text-primary"
                  />
                </div>
                <select
                  value={usageFilter}
                  onChange={(e) => setUsageFilter(e.target.value)}
                  className="px-2 py-2 border border-os-input-border rounded-sm text-sm bg-os-modal text-os-text-primary outline-hidden focus:ring-2 focus:ring-blue-500"
                  title="Filter by usage in documents"
                >
                  <option value="all">All images</option>
                  <option value="used">In use</option>
                  <option value="unused">Unused</option>
                </select>
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="px-2 py-2 border border-os-input-border rounded-sm text-sm bg-os-modal text-os-text-primary outline-hidden focus:ring-2 focus:ring-blue-500"
                  title="Filter by file type"
                >
                  <option value="all">All types</option>
                  {allTypes.map((type) => (
                    <option key={type} value={type}>{type.toUpperCase()}</option>
                  ))}
                </select>
                {(allTags.length > 0 || tagFilter !== 'all') && (
                  <select
                    value={tagFilter}
                    onChange={(e) => setTagFilter(e.target.value)}
                    className="px-2 py-2 border border-os-input-border rounded-sm text-sm bg-os-modal text-os-text-primary outline-hidden focus:ring-2 focus:ring-blue-500"
                    title="Filter by tag"
                  >
                    <option value="all">All tags</option>
                    <option value={UNTAGGED}>Untagged</option>
                    {allTags.map((tag) => (
                      <option key={tag} value={tag}>{tag}</option>
                    ))}
                  </select>
                )}
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="px-2 py-2 border border-os-input-border rounded-sm text-sm bg-os-modal text-os-text-primary outline-hidden focus:ring-2 focus:ring-blue-500"
                  title="Sort order"
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="name">Name A–Z</option>
                  <option value="size">Largest first</option>
                  <option value="usage">Most used</option>
                </select>
              </div>

              {/* Media Grid */}
              {media.length === 0 ? (
                <div className="text-center py-12 text-os-text-muted">
                  <ImageIcon size={48} className="mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No images uploaded yet</p>
                </div>
              ) : filteredMedia.length === 0 ? (
                <div className="text-center py-12 text-os-text-muted">
                  <Search size={48} className="mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No images match your search or filters</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {filteredMedia.map((item) => {
                const docs = usedBy(item.filename);
                const isSelected = selectedIds.has(item.id);
                return (
                <div
                  key={item.id}
                  className={`group relative border rounded-lg overflow-hidden transition-colors cursor-pointer ${
 isSelected
 ?'border-blue-600 ring-1 ring-blue-600'
 :'border-os-border hover:border-blue-500'
 }`}
                >
                  {/* Image */}
                  <div
                    className="aspect-square bg-os-card-secondary dark:bg-os-sidebar relative"
                    onClick={() => setPreviewImage(item)}
                  >
                    <img
                      src={item.data}
                      alt={item.filename}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                    />

                    {/* Selection checkbox */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelected(item.id);
                      }}
                      className={`absolute top-1.5 left-1.5 p-0.5 bg-black/40 text-white transition-opacity ${
 isSelected ?'opacity-100':'opacity-0 group-hover:opacity-100'
 }`}
                      title={isSelected ? 'Deselect' : 'Select'}
                    >
                      {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                    </button>

                    {/* Usage badge */}
                    <span
                      className={`absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${
 docs.length > 0
 ?'bg-green-600/90 text-white'
 :'bg-amber-500/90 text-white'
 }`}
                      title={
                        docs.length > 0
                          ? `Used by: ${docs.map((doc) => doc.title).join(', ')}`
                          : 'Not referenced by any document'
                      }
                    >
                      {docs.length > 0 ? `Used ×${docs.length}` : 'Unused'}
                    </span>

                    {/* Insert overlay (insert mode only) */}
                    {onSelectImage && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectImage(item.filename);
                          }}
                          className="pointer-events-auto px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-sm shadow-sm"
                        >
                          Insert
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="p-2 bg-os-modal">
                    <p className="text-xs font-medium text-os-text-primary truncate" title={item.filename}>
                      {item.filename}
                    </p>
                    {(item.tags || []).length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {item.tags.slice(0, 2).map((tag) => (
                          <span
                            key={tag}
                            className="px-1 py-0.5 bg-os-card-secondary rounded-sm text-[9px] text-os-text-secondary truncate max-w-[80px]"
                            title={tag}
                          >
                            {tag}
                          </span>
                        ))}
                        {item.tags.length > 2 && (
                          <span className="text-[9px] text-os-text-muted">
                            +{item.tags.length - 2}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex items-center justify-between mt-1">
                      <p className="text-[10px] text-os-text-muted">
                        {new Date(item.uploadedAt).toLocaleDateString()} · {formatSize(item.size)}
                      </p>
                      {/* Three-dot menu button */}
                      <button
                        onClick={(e) => handleContextMenu(e, item)}
                        className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
                        title="Actions"
                      >
                        <MoreHorizontal size={14} className="text-os-text-secondary" />
                      </button>
                    </div>
                  </div>
                </div>
                );
              })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-os-border flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-sm">
            {activeTab === 'browse' && media.length > 0 && (
              selectedIds.size > 0 ? (
                <>
                  <span className="text-os-text-secondary">
                    {selectedIds.size} selected
                  </span>
                  <button
                    onClick={() => setShowBulkDeleteModal(true)}
                    className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-700 rounded-sm transition-colors flex items-center gap-1.5"
                  >
                    Delete Selected
                  </button>
                  <button
                    onClick={() => setSelectedIds(new Set())}
                    className="px-3 py-1.5 text-sm text-os-text-secondary hover:bg-os-card-secondary rounded-sm transition-colors"
                  >
                    Clear
                  </button>
                </>
              ) : (
                <button
                  onClick={selectAllFiltered}
                  className="px-3 py-1.5 text-sm text-os-text-secondary hover:bg-os-card-secondary rounded-sm transition-colors"
                  disabled={filteredMedia.length === 0}
                >
                  Select all{hasActiveFilters ? ' (filtered)' : ''}
                </button>
              )
            )}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-os-text-secondary hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed bg-os-modal border border-os-border rounded-lg shadow-xl py-1 z-50 min-w-[160px]"
          style={{
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {onSelectImage && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleSelectImage(contextMenu.item.filename);
                setContextMenu(null);
              }}
              className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
            >
              <MenuItemIcon action="insert" />
              Insert into Document
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setPreviewImage(contextMenu.item);
              setContextMenu(null);
            }}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="preview" />
            Preview
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openTagEditor(contextMenu.item);
            }}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="editTags" />
            Edit Tags
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDownload(contextMenu.item.data, contextMenu.item.filename);
              setContextMenu(null);
            }}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="download" />
            Download
          </button>
          <div className="border-t border-os-border my-1"></div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(contextMenu.item.id, contextMenu.item.filename);
              setContextMenu(null);
            }}
            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"
          >
            <MenuItemIcon action="delete" danger />
            Delete
          </button>
        </div>
      )}

      {/* Image Preview Lightbox */}
      {previewImage && (
        <div
          className="fixed inset-0 bg-black/90 flex items-center justify-center z-60"
          onClick={() => setPreviewImage(null)}
        >
          {/* Close Button - Top Right */}
          <button
            onClick={() => setPreviewImage(null)}
            className="absolute top-4 right-4 p-2 bg-os-card hover:bg-white/30/20 rounded-full transition-colors"
          >
            <X size={24} className="text-white" />
          </button>

          {/* Image Info - Top Left */}
          <div className="absolute top-4 left-4 bg-black/50 px-4 py-2 rounded-sm text-white max-w-sm">
            <p className="text-sm font-medium">{previewImage.filename}</p>
            <p className="text-xs text-white/70">
              {new Date(previewImage.uploadedAt).toLocaleString()} · {formatSize(previewImage.size)}
            </p>
            {(previewImage.tags || []).length > 0 && (
              <p className="text-xs text-white/70 mt-1 flex items-center gap-1">
                <Tag size={12} className="shrink-0" />
                <span className="truncate">{previewImage.tags.join(', ')}</span>
              </p>
            )}
            {usedBy(previewImage.filename).length > 0 ? (
              <p className="text-xs text-white/70 mt-1 flex items-start gap-1">
                <FileText size={12} className="shrink-0 mt-0.5" />
                <span>
                  Used by: {usedBy(previewImage.filename).map((doc) => doc.title).join(', ')}
                </span>
              </p>
            ) : (
              <p className="text-xs text-amber-300 mt-1">Not used by any document</p>
            )}
          </div>

          {/* Insert Button - Bottom Center (insert mode only) */}
          {onSelectImage && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleSelectImage(previewImage.filename);
              }}
              className="absolute bottom-6 left-1/2 -translate-x-1/2 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-sm shadow-lg"
            >
              Insert into Document
            </button>
          )}

          {/* Image */}
          <img
            src={previewImage.data}
            alt={previewImage.filename}
            className="max-w-[90vw] max-h-[90vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Tag Editor */}
      {tagEditor && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-70"
          onClick={() => setTagEditor(null)}
        >
          <div
            className="bg-os-modal rounded-lg shadow-xl w-96 max-w-[90vw] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <Tag size={16} className="text-blue-600" />
              <h3 className="text-sm font-semibold text-os-text-primary truncate">
                Tags for {tagEditor.item.filename}
              </h3>
            </div>
            <input
              type="text"
              value={tagEditor.value}
              onChange={(e) => setTagEditor({ ...tagEditor, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleTagEditorSave();
                if (e.key === 'Escape') setTagEditor(null);
              }}
              placeholder="e.g. screenshots, networking, openshift"
              autoFocus
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-modal text-os-text-primary"
            />
            <p className="text-xs text-os-text-muted mt-2">
              Separate tags with commas
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setTagEditor(null)}
                className="px-3 py-1.5 text-sm text-os-text-secondary hover:bg-os-card-secondary rounded-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleTagEditorSave}
                className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-sm transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && mediaToDelete && (
        <ConfirmationModal
          isOpen={showDeleteModal}
          onConfirm={handleDeleteConfirm}
          onClose={handleDeleteCancel}
          title="Delete Image"
          message={deleteMessage(mediaToDelete)}
          confirmText="Delete"
          dangerous={true}
        />
      )}

      {/* Bulk Delete Confirmation Modal */}
      {showBulkDeleteModal && (
        <ConfirmationModal
          isOpen={showBulkDeleteModal}
          onConfirm={handleBulkDeleteConfirm}
          onClose={() => setShowBulkDeleteModal(false)}
          title="Delete Selected Images"
          message={`Are you sure you want to delete ${selectedIds.size} image(s)?${
            selectedInUse > 0
              ? `\n\nWarning: ${selectedInUse} of them are still used by documents. Those references will show a broken image.`
              : ''
          }\n\nThis action cannot be undone.`}
          confirmText={`Delete ${selectedIds.size}`}
          dangerous={true}
        />
      )}
    </div>
  );
}
