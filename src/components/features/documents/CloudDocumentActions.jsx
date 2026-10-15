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

      addNotification({
        type: 'success',
        title: 'Upload Successful',
        message: 'Document uploaded to central server successfully.'
      });

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
        title: 'Upload Failed',
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
          className="flex items-center gap-2 px-3 py-1.5 bg-purple-600 text-white text-sm hover:bg-purple-700 rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Sync changes to central server"
        >
          {uploading ? 'Syncing...' : 'Sync to Cloud'}
        </button>
      ) : inCloud && !isOwner ? (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-100 text-purple-700 text-sm font-medium rounded-sm">
          <Cloud size={14} />
          <span>In Cloud (Read-Only)</span>
        </div>
      ) : (
        <button
          onClick={handleUploadToCloud}
          disabled={uploading}
          className="flex items-center gap-2 px-3 py-1.5 bg-purple-600 text-white text-sm hover:bg-purple-700 rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Upload document to central server"
        >
          {uploading ? 'Uploading...' : 'Upload to Cloud'}
        </button>
      )}

    </div>
  );
}
