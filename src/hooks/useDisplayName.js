import { useEffect, useState } from 'react';
import { DISPLAY_NAME_EVENT, getDisplayName } from '../utils/cloudCentralSync';

/**
 * The name to show for THIS user next to `machineId` (the component's
 * current machine id): the OS username on the desktop, the name chosen in
 * Settings > General in a browser, the generated name part otherwise (see
 * cloudCentralSync.getDisplayName). Follows a rename live. Until the name
 * is known - or with no id yet - it is the id's user part, which is what
 * every game and the Kanban presence used before.
 */
export function useDisplayName(machineId) {
  const [name, setName] = useState('');
  useEffect(() => {
    if (!machineId) return undefined;
    let active = true;
    const load = () => {
      getDisplayName()
        .then((value) => { if (active) setName(value); })
        .catch(() => { /* keep the fallback */ });
    };
    load();
    window.addEventListener(DISPLAY_NAME_EVENT, load);
    return () => {
      active = false;
      window.removeEventListener(DISPLAY_NAME_EVENT, load);
    };
  }, [machineId]);
  if (!machineId) return '';
  return name || String(machineId).split('@')[0];
}
