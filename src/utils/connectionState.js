/**
 * The connection indicator's state (src/components/common/ConnectionIndicator.jsx)
 * from the sync engine's status, the home-server version check, the browser's
 * network state and whether this is the desktop app. Pure, so it is unit-tested
 * directly:
 *
 *   state   'online' | 'syncing' | 'pending' | 'offline' | 'update-required'
 *   reason  for 'offline': 'no-network' | 'not-linked' | 'signed-out' | 'auth' | 'unreachable'
 *   title   the tooltip, saying why
 */
const KEPT_LOCALLY = 'changes are kept on this device and sync when you reconnect';

/** Pure: the indicator's state from the live inputs (exported for tests). */
export function connectionState({ sync, versionCheck = null, networkOnline = true, desktop = false }) {
  if (!networkOnline) {
    return { state: 'offline', reason: 'no-network', title: `Offline - no network connection; ${KEPT_LOCALLY}` };
  }
  if (!sync?.enabled) {
    return desktop
      ? { state: 'offline', reason: 'not-linked', title: `Not linked to a home server (Settings > General > Home server) - ${KEPT_LOCALLY}` }
      : { state: 'offline', reason: 'signed-out', title: `Not connected to your home server - ${KEPT_LOCALLY}` };
  }
  if (sync.paused || versionCheck?.paused) {
    return { state: 'update-required', reason: 'version-mismatch', title: `Update required - synchronisation paused: ${sync.paused || versionCheck.title}` };
  }
  if (sync.syncing) {
    return { state: 'syncing', reason: null, title: 'Synchronising with your home server...' };
  }
  if (sync.lastError || versionCheck?.state === 'unreachable') {
    if (sync.lastErrorStatus === 401 || sync.lastErrorStatus === 403) {
      return { state: 'offline', reason: 'auth', title: `${desktop ? 'This profile is no longer signed in to its home server (Settings > General > Home server)' : 'Your session on the home server has expired - sign in again'}; ${KEPT_LOCALLY}` };
    }
    const detail = sync.lastError || versionCheck?.message || '';
    return { state: 'offline', reason: 'unreachable', title: `Home server unreachable - ${KEPT_LOCALLY}${detail ? ` (${detail}; click to retry)` : ' (click to retry)'}` };
  }
  if (sync.pending > 0) {
    return { state: 'pending', reason: null, title: `${sync.pending} change(s) waiting to be sent to your home server (click to send now)` };
  }
  return { state: 'online', reason: null, title: `Connected to your home server - in sync${sync.lastPullAt ? ` (${new Date(sync.lastPullAt).toLocaleTimeString()})` : ''}` };
}
