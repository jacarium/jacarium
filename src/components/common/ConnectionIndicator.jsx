import { useEffect, useState } from 'react';
import { Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { useSyncStatus } from '../../hooks/useSyncStatus';
import { syncNow } from '../../sync/syncEngine';
import { getLastVersionCheck, subscribeVersionCheck } from '../../utils/homeServer';
import { isDesktopApp } from '../../utils/platform';
import { connectionState } from '../../utils/connectionState';

/**
 * The connection indicator in the bottom-right status corner: whether this
 * client is connected to its home server. Online means the account's data
 * is synchronising with it (src/sync/syncEngine.js); offline means it is
 * not - no link (desktop) or no session (browser), the server unreachable,
 * the browser without a network, the session or device token expired - and
 * the tooltip says which. A version mismatch that pauses synchronisation is
 * its own state ("update required"). While a cycle runs the icon spins, and
 * a count shows the changes waiting to be sent; a click synchronises now.
 *
 * Nothing here is a setting: the state is derived from the sync engine, the
 * home-server version check (src/utils/homeServer.js) and the browser's
 * online/offline events.
 */

function useNetworkOnline() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return online;
}

const TONE = {
  online: 'text-green-600 dark:text-green-400',
  syncing: 'text-os-text-secondary',
  pending: 'text-os-text-secondary',
  offline: 'text-amber-600 dark:text-amber-400',
  'update-required': 'text-red-600 dark:text-red-400',
};

export default function ConnectionIndicator() {
  const sync = useSyncStatus();
  const networkOnline = useNetworkOnline();
  const [versionCheck, setVersionCheck] = useState(() => getLastVersionCheck());
  useEffect(() => subscribeVersionCheck(setVersionCheck), []);
  const { state, reason, title } = connectionState({ sync, versionCheck, networkOnline, desktop: isDesktopApp() });
  const Icon = state === 'offline' || state === 'update-required' ? CloudOff : state === 'syncing' ? RefreshCw : Cloud;
  const className = `pointer-events-auto select-none flex items-center gap-1 px-1.5 py-1 rounded-sm text-xs bg-os-card border border-os-border shadow-xs ${TONE[state]}`;
  const content = (
    <>
      <Icon size={14} className={state === 'syncing' ? 'animate-spin' : ''} aria-hidden="true" />
      {sync.pending > 0 && state !== 'syncing' && <span>{sync.pending}</span>}
    </>
  );
  const common = { title, 'aria-label': title, 'data-testid': 'connection-indicator', 'data-state': state, 'data-reason': reason || undefined, className };
  // only a running sync engine can synchronise now; otherwise the badge is a plain status
  if (!sync.enabled) return <div role="status" {...common}>{content}</div>;
  return <button type="button" onClick={() => syncNow()} {...common}>{content}</button>;
}
