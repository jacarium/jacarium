/**
 * Settings > General: the state of the team features (the central server
 * that comes with the home server) - read-only.
 *
 * It sits where the home server itself is described: in the Home server
 * section on the desktop (the server this profile is linked to provides
 * it), in the Account section in a browser (the server the page is signed
 * in to provides it). Shown: connected / connecting / version mismatch, the identity teammates see this app as and the display name;
 * or, when this app has no central server, why (src/utils/
 * centralAvailability.js). Nothing to configure: the home server is the
 * gateway (src/utils/cloudCentralSync.js).
 */
import { useEffect, useState } from 'react';
import { isDesktopApp } from '../../../../utils/platform';
import { isWebSocketConnected, onConnectionStatusChange } from '../../../../utils/cloudSync';
import { getLastVersionCheck, subscribeVersionCheck } from '../../../../utils/homeServer';
import { providedCentralServer, getDisplayName, getMachineId } from '../../../../utils/cloudCentralSync';
import { centralHint } from '../../../../utils/centralAvailability';

const hostOf = (url) => { try { const u = new URL(url); return `${u.host}${u.pathname.replace(/\/+$/, '')}`; } catch { return String(url || ''); } };

export default function CentralStatus() {
  const desktop = isDesktopApp();
  const [provided, setProvided] = useState(undefined);   // undefined: asking; null: none
  const [connected, setConnected] = useState(() => isWebSocketConnected());
  const [versionCheck, setVersionCheck] = useState(() => getLastVersionCheck());
  const [identity, setIdentity] = useState({ machineId: '', displayName: '' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let served = null;
      try { served = await providedCentralServer(); } catch { served = null; }
      if (cancelled) return;
      setProvided(served);
      if (served) {
        try {
          const [machineId, displayName] = await Promise.all([getMachineId(), getDisplayName().catch(() => '')]);
          if (!cancelled) setIdentity({ machineId, displayName: displayName || '' });
        } catch { /* identity unavailable: the row stays without it */ }
      }
    })();
    const unsubscribe = onConnectionStatusChange((data) => setConnected(!!(data && typeof data === 'object' ? data.connected : data)));
    const unsubscribeVersion = subscribeVersionCheck(setVersionCheck);
    return () => { cancelled = true; unsubscribe?.(); unsubscribeVersion?.(); };
  }, []);

  // connected / connecting / version mismatch / unavailable / asking
  const connection = (() => {
    if (provided === undefined) return { state: 'asking', text: 'Checking...', tone: 'muted' };
    if (!provided) return { state: 'unavailable', text: centralHint('use the team features').message, tone: 'muted' };
    if (desktop && versionCheck?.paused) return { state: 'version-mismatch', text: `Not connected - ${versionCheck.title}`, tone: 'warn' };
    if (connected) return { state: 'connected', text: `Connected to ${hostOf(provided.url)}`, tone: 'ok' };
    return { state: 'connecting', text: `Connecting to ${hostOf(provided.url)}...`, tone: 'muted' };
  })();
  const toneClass = connection.tone === 'ok' ? 'text-green-700 dark:text-green-300' : connection.tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : 'text-os-text-secondary';

  return (
    <div className="text-xs space-y-1" data-testid="central-status" data-state={connection.state}>
      <p className="font-medium text-os-text-primary">Team features (shared documents, boards, workflows, chat, games)</p>
      <p className={toneClass} data-testid="central-connection">{connection.text}</p>
      {provided && identity.machineId && (
        <p className="text-os-text-muted" data-testid="central-identity">
          Teammates see you as <span className="font-medium text-os-text-secondary">{identity.displayName || identity.machineId.split('@')[0]}</span>
          {' '}(<span className="font-mono break-all">{identity.machineId}</span>{desktop ? ', this profile\'s account on the home server' : ', your account'}).
        </p>
      )}
    </div>
  );
}
