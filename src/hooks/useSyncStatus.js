import { useEffect, useState } from 'react';
import { getSyncStatus, subscribeSyncStatus } from '../sync/syncEngine';

/**
 * React view of the synchronisation with the home server
 * (src/sync/syncEngine.js): { enabled, syncing, lastPullAt, lastPushAt,
 * lastError, lastErrorStatus, pending, conflicts, serverSkewMs, paused }. Live.
 */
export function useSyncStatus() {
  const [status, setStatus] = useState(() => getSyncStatus());
  useEffect(() => subscribeSyncStatus(setStatus), []);
  return status;
}
