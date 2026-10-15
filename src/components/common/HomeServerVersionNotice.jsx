import { useEffect, useState } from 'react';
import { AlertTriangle, Download, X } from 'lucide-react';
import { getLastVersionCheck, subscribeVersionCheck } from '../../utils/homeServer';

/**
 * The desktop's version against its home server (src/utils/homeServer.js):
 * nothing when they match; a small dismissible notice when the app versions
 * differ but the protocol is the same (with the server's downloads page);
 * a banner that cannot be dismissed while the protocols differ - sync is
 * paused then and the banner says which side to update.
 */
export default function HomeServerVersionNotice() {
  const [check, setCheck] = useState(() => getLastVersionCheck());
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem('homeServerVersionNoticeDismissed') || ''; } catch { return ''; } });
  useEffect(() => subscribeVersionCheck(setCheck), []);
  if (!check || check.state === 'same' || check.state === 'not-linked' || check.state === 'unreachable') return null;
  const key = `${check.desktop?.app}|${check.server?.app || (check.server?.legacy ? 'legacy' : '')}`;
  if (!check.paused && dismissed === key) return null;
  const open = (url) => { if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url); else window.open(url, '_blank', 'noopener'); };
  const paused = check.paused;
  return (
    <div
      role={paused ? 'alert' : 'status'}
      data-testid="home-server-version-notice"
      data-state={check.state}
      className={`pointer-events-auto max-w-md rounded-sm border px-3 py-2 text-xs shadow-sm ${paused ?'bg-amber-50 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-100':'bg-os-modal border-os-border text-os-text-secondary'}`}
    >
      <div className="flex items-start gap-2">
        {paused && <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-os-text-primary">{check.title}</p>
          <p className="mt-0.5">{check.message}</p>
          {check.downloadsUrl && (check.state === 'server-newer' || (paused && check.server?.protocol > check.desktop?.protocol)) && (
            <button type="button" onClick={() => open(check.downloadsUrl)} className="mt-1 inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline">
               Download the matching desktop app from your home server
            </button>
          )}
        </div>
        {!paused && (
          <button type="button" aria-label="Dismiss" onClick={() => { setDismissed(key); try { localStorage.setItem('homeServerVersionNoticeDismissed', key); } catch { /* no storage */ } }} className="p-0.5 rounded-sm hover:bg-os-card-secondary">
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
