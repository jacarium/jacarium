import { useEffect } from 'react';
import { onConnectionStatusChange } from '../utils/cloudWebSocket';
import { createConnectionNoticeTracker } from '../utils/connectionNotices';

/**
 * The "Working Offline" / "Back Online" notifications for the central
 * server's connection, once for the whole app. Called from the main shell
 * (JQLBuilder), which stays mounted across pages, so switching page never
 * loses track of a drop - see src/utils/connectionNotices.js for when a
 * report counts as a drop or a return.
 */
export default function useConnectionNotices(addNotification, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    const next = createConnectionNoticeTracker();
    return onConnectionStatusChange(({ connected }) => {
      const notice = next(connected);
      if (notice === 'offline') {
        addNotification({
          type: 'warning',
          title: 'Working Offline',
          message: 'Connection to central server lost. Shared documents and boards are now read-only.'
        });
      } else if (notice === 'online') {
        addNotification({
          type: 'success',
          title: 'Back Online',
          message: 'Connected to central server. Syncing your changes...'
        });
      }
    });
  }, [addNotification, enabled]);
}
