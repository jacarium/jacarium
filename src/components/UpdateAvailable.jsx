import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import FloatingWindow from './common/FloatingWindow';
import BrandMark from '../brand/BrandMark';
import { Button, ExternalLink } from './ui';
import { isDesktopApp } from '../utils/platform';
import { useNotifications } from '../contexts/NotificationContext';
import { UPDATE_AVAILABLE_EVENT, renderNotes } from '../utils/updateNotes';

/**
 * "A new version is available" - the window the desktop app shows when the
 * release check (electron/update-check.cjs, main process) found a release
 * newer than the running one and not skipped. Same chrome as What's New
 * (FloatingWindow), with the release notes of every version between the
 * running one and the newest (the GitHub release bodies, Markdown from
 * CHANGELOG.md), rendered through marked + DOMPurify like every other
 * Markdown from outside the app (src/utils/updateNotes.js); links open in
 * the browser.
 *
 * Opens when the main process announces a release (onUpdateAvailable: the
 * scheduled check, or "Check now" in Settings), and on the
 * UPDATE_AVAILABLE_EVENT window event (Settings > About, "Show"). "Download"
 * opens the file for this installation (or the releases page); "Later"
 * closes it until the next check; "Skip this version" closes it for that
 * version - the next release opens it again.
 *
 * The automatic check is off unless the user turned it on, so this window
 * only ever follows something the user chose. Desktop only: a browser on a
 * self-hosted server shows the administrator the server's own check in
 * Settings > About instead (UpdateSettings).
 */
export default function UpdateAvailable() {
  const { addNotification } = useNotifications();
  const [status, setStatus] = useState(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isDesktopApp() || !window.electronAPI?.onUpdateAvailable) return undefined;
    const unsubscribe = window.electronAPI.onUpdateAvailable((next) => {
      setStatus(next);
      if (next?.shouldShow) setIsOpen(true);
    });
    return () => { if (unsubscribe) unsubscribe(); };
  }, []);

  // Help > Check for Updates...: one request now; the window when there is
  // something, a short notice otherwise (up to date, or GitHub unreachable)
  useEffect(() => {
    if (!isDesktopApp() || !window.electronAPI?.onCheckForUpdates) return undefined;
    const unsubscribe = window.electronAPI.onCheckForUpdates(async () => {
      try {
        const next = await window.electronAPI.updateCheckRun();
        setStatus(next);
        if (next?.updateAvailable) {
          setIsOpen(true);
        } else if (next?.lastError) {
          addNotification({ type: 'warning', title: 'Could not check for updates', message: `GitHub could not be reached (${next.lastError}).` });
        } else {
          addNotification({ type: 'success', title: 'You have the latest version', message: `Jacarium ${next?.currentVersion || ''} is the newest release.` });
        }
      } catch (error) {
        addNotification({ type: 'warning', title: 'Could not check for updates', message: String(error?.message || error) });
      }
    });
    return () => { if (unsubscribe) unsubscribe(); };
  }, [addNotification]);

  // Settings > About ("Show") hands the status it already has
  useEffect(() => {
    function handleShow(event) {
      const next = event.detail || null;
      if (next) setStatus(next);
      if (next?.updateAvailable) setIsOpen(true);
    }
    window.addEventListener(UPDATE_AVAILABLE_EVENT, handleShow);
    return () => window.removeEventListener(UPDATE_AVAILABLE_EVENT, handleShow);
  }, []);

  const notesHtml = useMemo(() => renderNotes(status?.notes), [status?.notes]);

  if (!status || !status.updateAvailable) return null;

  const openExternal = (url) => {
    if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  };
  const later = () => setIsOpen(false);
  const skip = async () => {
    try {
      const next = await window.electronAPI?.updateCheckDismiss?.(status.latestVersion);
      if (next) setStatus(next);
    } catch { /* the window closes either way */ }
    setIsOpen(false);
  };
  // Sanitised HTML the app built itself from the release notes (renderNotes)
  const notes = { __html: notesHtml };

  return (
    <FloatingWindow
      open={isOpen}
      onClose={later}
      title="A new version is available"
      icon={<BrandMark size={18} />}
      storageKey="updateAvailableWindow"
      defaultSize={{ width: 720, height: 600 }}
      minWidth={420}
      minHeight={320}
    >
      <div className="flex flex-col h-full min-h-0" data-update-available="true">
        <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-os-border shrink-0">
          <p className="text-sm text-os-text-primary">
            Jacarium <strong>{status.latestVersion}</strong> is out - you have {status.currentVersion}.
          </p>
          <p className="text-xs text-os-text-secondary mt-1">
            Updating keeps the app in step with your home server and your team. Here is what changed
            {status.releases.length > 1 ? ` in the ${status.releases.length} releases since your version` : ''}:
          </p>
        </div>
        <div
          tabIndex={0}
          role="region"
          aria-label="Release notes"
          className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-os-blue/40 markdown-preview text-sm"
          data-update-notes="true"
          dangerouslySetInnerHTML={notes}
        />
        <div className="px-4 py-2.5 border-t border-os-border flex flex-wrap items-center justify-between gap-2 shrink-0">
          <ExternalLink href={status.releasesPage} className="text-xs">All releases</ExternalLink>
          <div className="flex items-center gap-2">
            <Button onClick={skip} data-update-skip="true" title="Do not show this version again; the next release will">Skip this version</Button>
            <Button onClick={later} data-update-later="true">Later</Button>
            <Button variant="primary" onClick={() => openExternal(status.download.url)} data-update-download="true" title={status.download.name || status.download.url}>
              <Download size={14} />
              {status.download.label}
            </Button>
          </div>
        </div>
      </div>
    </FloatingWindow>
  );
}
