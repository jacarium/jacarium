import { useState, useEffect } from 'react';
import { Cloud } from 'lucide-react';
import { isDocumentInCloud, isDocumentOwner } from '../../../utils/cloudDocuments';
import { uploadDocumentToCentral, getCentralServerUrl } from '../../../utils/cloudCentralSync';
import { useNotifications } from '../../../contexts/NotificationContext';
import { notifyCentralUnavailable } from '../../../utils/centralAvailability';

/**
 * CloudDocumentActions - Cloud upload/sync actions for documents
 *
 * Features:
 * - Upload to Cloud button (when not in cloud)
 * - Sync to Cloud button (when in cloud and owner)
 * - Read-only indicator (when in cloud but not owner)
 */
export default function CloudDocumentActions({
  document,
  onUploadSuccess,
}) {
  const [uploading, setUploading] = useState(false);
  const { addNotification } = useNotifications();

  const inCloud = isDocumentInCloud(document);
  const [isOwner, setIsOwner] = useState(true);

  // Check ownership when document changes
  useEffect(() => {
    if (document) {
      isDocumentOwner(document).then(setIsOwner);
    }
  }, [document]);

  async function handleUploadToCloud() {
    const serverUrl = getCentralServerUrl();
    if (!serverUrl) {
      notifyCentralUnavailable(addNotification, 'share this document');
      return;
    }

    setUploading(true);
    try {
      await uploadDocumentToCentral(document);

      addNotification(inCloud
        ? { type: 'success', title: 'Changes Synced', message: 'Your changes to the document are now with the team.' }
        : { type: 'success', title: 'Shared with the Team', message: 'The document is now shared with your team.' });

      // Trigger document reload to update cloud status in UI
      // Use setTimeout to ensure IndexedDB transaction completes
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('documentUploadedToCloud', {
          detail: { documentId: document.id }
        }));
      }, 100);

      onUploadSuccess?.();
    } catch (error) {
      console.error('Upload failed:', error);
      addNotification({
        type: 'error',
        title: 'Sharing Failed',
        message: 'Failed to upload to central server: ' + error.message
      });
    } finally {
      setUploading(false);
    }
  }

  if (!document || !document.id) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      {inCloud && isOwner ? (
        <button
          onClick={handleUploadToCloud}
          disabled={uploading}
          className="btn btn-brand flex items-center gap-2 px-3 py-1.5 text-sm"
          title="Sync your changes with the team"
        >
          {uploading ? 'Syncing...' : 'Sync Changes'}
        </button>
      ) : inCloud && !isOwner ? (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-100 text-purple-700 text-sm font-medium rounded-sm">
          <Cloud size={14} />
          <span>Shared (Read-Only)</span>
        </div>
      ) : (
        <button
          onClick={handleUploadToCloud}
          disabled={uploading}
          className="btn btn-brand flex items-center gap-2 px-3 py-1.5 text-sm"
          title="Share this document with the team"
        >
          {uploading ? 'Sharing...' : 'Share with the Team'}
        </button>
      )}

    </div>
  );
}
