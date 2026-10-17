import { useEffect, useState } from 'react';
import SettingsModal from '../common/modals/SettingsModal';

/**
 * Settings on a phone. On the desktop the icon rail (CompactSidebar) owns
 * the Settings dialog and listens for the 'openAppSettings' event
 * (src/utils/openSettings.js); the rail is not rendered on a phone, so the
 * shell hosts the dialog itself, answering the same event - the "More"
 * sheet, the home-server hints and the pages' own links all go through it.
 * The database export/import/wipe buttons stay desktop-only (their flows
 * live in the rail).
 */
export default function MobileSettingsHost() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('general');
  const [section, setSection] = useState(null);
  useEffect(() => {
    const onOpen = (event) => { setTab(event?.detail?.tab || 'general'); setSection(event?.detail?.section || null); setOpen(true); };
    window.addEventListener('openAppSettings', onOpen);
    return () => window.removeEventListener('openAppSettings', onOpen);
  }, []);
  return (
    <SettingsModal
      isOpen={open}
      initialTab={tab}
      initialSection={section}
      onClose={() => setOpen(false)}
      onShowWhatsNew={() => { setOpen(false); window.dispatchEvent(new Event('toggleWhatsNew')); }}
    />
  );
}
