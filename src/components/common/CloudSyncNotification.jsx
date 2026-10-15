import { useEffect } from 'react';
import { useNotifications } from '../../contexts/NotificationContext';

/**
 * CloudSyncNotification - Listens for cloud sync events and creates notifications
 *
 * Shows when documents are received from central server
 */
export default function CloudSyncNotification() {
  const { addNotification } = useNotifications();

  useEffect(() => {
    function handleCloudDocumentsReceived(event) {
      const { processed } = event.detail;

      if (processed > 0) {
        addNotification({
          type: 'success',
          title: 'Shared documents',
          message: `Received ${processed} shared document${processed > 1 ? 's' : ''} from the team.`
        });
      }
    }

    window.addEventListener('cloudDocumentsReceived', handleCloudDocumentsReceived);
    return () => window.removeEventListener('cloudDocumentsReceived', handleCloudDocumentsReceived);
  }, [addNotification]);

  return null; // This component doesn't render anything, it just listens for events
}
