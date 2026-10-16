/**
 * Settings > About > Updates: the release check.
 *
 * Desktop: the main process checks (electron/update-check.cjs). Off by
 * default: nothing contacts GitHub unless the toggle is on - then one
 * request a day. "Check now" is one request on this click and works with
 * the toggle off. The result opens the "A new version is available"
 * window (UpdateAvailable) when a newer release is out.
 *
 * Browser on a self-hosted server: the SERVER checks (backend/update_check.py)
 * when an administrator turned it on; only administrators see this section,
 * with the server's result and how to update it. Ordinary users' browsers
 * never contact GitHub, and the section is not shown to them.
 */
import { useEffect, useState } from 'react';
import { Section, Toggle, Button, ExternalLink } from './ui';
import { isDesktopApp, getBackendInfo } from '../../../../utils/platform';
import { apiFetch, getBackendUrl } from '../../../../utils/backendUrl';
import { UPDATE_AVAILABLE_EVENT } from '../../../../utils/updateNotes';

const PRIVACY_HINT = 'Once a day, asks GitHub (api.github.com) for the latest release. Nothing about you or this app is sent - GitHub sees the request\'s IP address, nothing else. Off by default.';
const SERVER_UPDATE_DOC = 'https://github.com/jacarium/jacarium/blob/main/docs/SELF_HOSTING.md#updating';

/** The server stores seconds, the desktop milliseconds. */
function formatWhen(value) {
  if (!value) return 'never';
  const n = Number(value);
  const date = new Date(n < 1e11 ? n * 1000 : n);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

function resultLine(status, checking) {
  if (checking) return 'Checking...';
  if (!status) return '';
  if (status.lastError) return `Last check ${formatWhen(status.lastCheckedAt)}: could not reach GitHub (${status.lastError}).`;
  if (!status.lastCheckedAt) return 'Not checked yet.';
  if (status.updateAvailable) return `Last check ${formatWhen(status.lastCheckedAt)}: version ${status.latestVersion} is available.`;
  return `Last check ${formatWhen(status.lastCheckedAt)}: you have the latest version.`;
}

async function fetchStatus(desktop) {
  if (desktop) return window.electronAPI.updateCheckStatus();
  const r = await apiFetch(`${await getBackendUrl()}/api/update-check`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export default function UpdateSettings() {
  const desktop = isDesktopApp();
  // a browser shows the section to the server's administrators only
  const shown = desktop || !!getBackendInfo()?.auth?.admin;
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!shown) return undefined;
    let cancelled = false;
    fetchStatus(desktop)
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { if (!cancelled) setUnavailable(true); });
    return () => { cancelled = true; };
  }, [desktop, shown]);

  async function setAuto(enabled) {
    try {
      if (desktop) {
        setStatus(await window.electronAPI.updateCheckSetAuto(enabled));
      } else {
        const r = await apiFetch(`${await getBackendUrl()}/api/update-check/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoCheck: enabled }) });
        if (r.ok) setStatus(await r.json());
      }
    } catch { /* the toggle keeps showing the stored value */ }
  }

  async function checkNow() {
    setChecking(true);
    try {
      let next;
      if (desktop) {
        next = await window.electronAPI.updateCheckRun();
      } else {
        const r = await apiFetch(`${await getBackendUrl()}/api/update-check/run`, { method: 'POST' });
        next = r.ok ? await r.json() : null;
      }
      if (next) {
        setStatus(next);
        if (desktop && next.updateAvailable) window.dispatchEvent(new CustomEvent(UPDATE_AVAILABLE_EVENT, { detail: next }));
      }
    } catch { /* the status line says what the last check found */ } finally {
      setChecking(false);
    }
  }

  if (!shown || unavailable) return null;

  return (
    <Section title="Updates" description={desktop ? undefined : 'The server checks for new releases; its administrators see the result here.'} testId="about-updates">
      <div className="space-y-3 px-3 py-2.5">
        <Toggle
          checked={!!status?.autoCheck}
          onChange={(enabled) => setAuto(enabled)}
          disabled={!status || !!status.autoCheckFromEnvironment}
          label={desktop ? 'Check for updates automatically' : 'Check for server updates automatically'}
          hint={status?.autoCheckFromEnvironment ? `${PRIVACY_HINT} Turned on by JACARIUM_UPDATE_CHECK in the server's environment.` : PRIVACY_HINT}
          testId="update-auto-check"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={checkNow} disabled={checking} title="One request to GitHub, now. Works with the automatic check off." data-testid="update-check-now">
            {checking ? 'Checking...' : 'Check now'}
          </Button>
          {desktop && status?.updateAvailable && (
            <Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent(UPDATE_AVAILABLE_EVENT, { detail: status }))} data-testid="update-show">
              Show version {status.latestVersion}
            </Button>
          )}
          <span className="text-xs text-os-text-secondary" data-testid="update-status">{resultLine(status, checking)}</span>
        </div>
        {!desktop && status?.updateAvailable && (
          <div className="text-xs text-os-text-secondary space-y-1" data-testid="server-update-notice">
            <p className="text-os-text-primary">This server runs {status.currentVersion}; version {status.latestVersion} is available.</p>
            <p>Update it from the machine it runs on: pull the new image and recreate the container with the same flags, or run <code className="font-mono">deploy/deploy-to-host.sh</code> again if that is how it was deployed - see <ExternalLink href={SERVER_UPDATE_DOC}>Updating</ExternalLink> in the self-hosting guide. Release notes: <ExternalLink href={status.releases?.[0]?.url || status.releasesPage}>version {status.latestVersion}</ExternalLink>.</p>
          </div>
        )}
      </div>
    </Section>
  );
}
