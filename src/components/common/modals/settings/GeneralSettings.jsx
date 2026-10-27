import { useEffect, useState } from 'react';
import { Download, Cloud, Laptop, Archive } from 'lucide-react';
import { useSyncStatus } from '../../../../hooks/useSyncStatus';
import { useConfirmation } from '../../../../hooks/useConfirmation';
import ConfirmationModal from '../ConfirmationModal';
import { changePassword, devices as deviceApi, sessions as sessionApi, accountData, signOutAndReload, updateProfile } from '../../../../utils/auth';
import { getBackendInfo, isDesktopApp } from '../../../../utils/platform';
import { getLastVersionCheck, subscribeVersionCheck } from '../../../../utils/homeServer';
import { GRADIENT_THEMES, DARK_THEMES } from '../../../../contexts/ThemeContext';
import { DISPLAY_NAME_EVENT, DISPLAY_NAME_MAX_LENGTH, getStoredDisplayName, isAccountIdentity, isBrowserIdentity, resetIdentityCache, setDisplayName, validateDisplayName } from '../../../../utils/cloudCentralSync';
import { sendDisplayNameUpdate } from '../../../../utils/cloudWebSocket';
import { stopCloudSync } from '../../../../utils/cloudSync';
import { isOpenTabsSyncEnabled, setOpenTabsSyncEnabled } from '../../../../utils/openTabsSync';
import { Button, Checkbox, Field, InfoRow, InfoRows, Note, PasswordInput, Section, Select, StatusLine, TextInput, Toggle, Code } from './ui';
import CentralStatus from './CentralStatus';

/**
 * Name field for a browser identity (browser-xxxxxxxx@host, see
 * cloudCentralSync.js): the label teammates see in chat, on cursors and in
 * challenges. The machine ID itself never changes, so saving a name needs
 * no re-pairing with the central server. Saved on blur / Enter; '' means
 * the generated name. Not shown on the desktop, whose name is the OS user.
 */
function DisplayNameField({ machineId }) {
  const [value, setValue] = useState(() => getStoredDisplayName());
  const [saved, setSaved] = useState(value);
  const [error, setError] = useState(null);
  const fallback = machineId.split('@')[0];
  const save = () => {
    const result = validateDisplayName(value);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    try {
      setDisplayName(result.value);
    } catch (e) {
      setError(e.message);
      return;
    }
    setError(null);
    setValue(result.value);
    if (result.value !== saved) {
      setSaved(result.value);
      sendDisplayNameUpdate(); // teammates see the new name without a reconnect
    }
  };
  return (
    <Field label="Your name" htmlFor="cloud-display-name" error={error}
      hint={<>Shown to teammates in chat, on cursors and in challenges (empty: <span className="font-mono">{fallback}</span>). Your machine ID below stays the same, so changing the name keeps your documents yours.</>}>
      <TextInput id="cloud-display-name" value={value} maxLength={DISPLAY_NAME_MAX_LENGTH} placeholder={fallback}
        onChange={(e) => { setValue(e.target.value); setError(null); }} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
        data-testid="cloud-display-name" className="max-w-xs" />
      {error && <span className="sr-only" data-testid="cloud-display-name-error">{error}</span>}
    </Field>
  );
}

// Available zoom factors (1 = 100%). Must stay in sync with ZOOM_STEPS in
// electron/main.cjs, which owns the actual zoom state.
const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

// The current factor can land between our steps (e.g. after clamping or a
// value written by an older version), so snap the dropdown to the closest
// step rather than showing a blank selection.
function closestZoomLevel(factor) {
  return ZOOM_LEVELS.reduce((best, level) =>
    Math.abs(level - factor) < Math.abs(best - factor) ? level : best
  );
}

const when = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleString() : 'never');

/**
 * Account section on a server with sign-in: who is signed in, the display
 * name, sign out, change the password, the account's sessions and linked
 * devices, the pre-sign-in database offered once per browser, and the
 * "Delete all my data on the server" action (backend/account_data.py).
 */
function AccountSection({ account, remoteServer = null }) {
  const { confirm, confirmationProps } = useConfirmation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [legacyExists, setLegacyExists] = useState(null);
  const [devices, setDevices] = useState([]);
  const [sessionList, setSessionList] = useState([]);

  async function loadDevices() {
    try {
      const data = await deviceApi.list();
      setDevices(data.devices || []);
    } catch {
      setDevices([]);
    }
    try {
      const data = await sessionApi.list();
      setSessionList(data.sessions || []);
    } catch {
      setSessionList([]);
    }
  }
  useEffect(() => {
    // the lists arrive after an await; nothing is set synchronously here
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDevices();
  }, []);

  async function revokeDevice(id) {
    if (!(await confirm({ title: 'Revoke this device?', message: 'It will have to be linked again with your password.', type: 'warning', confirmLabel: 'Revoke' }))) return;
    try {
      await deviceApi.revoke(id);
      await loadDevices();
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    }
  }

  async function endSession(id) {
    try {
      await sessionApi.end(id);
      await loadDevices();
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    }
  }

  async function endOtherSessions() {
    if (!(await confirm({ title: 'Sign out everywhere else?', message: 'Every other browser signed in to this account is signed out; this one stays.', type: 'warning', confirmLabel: 'Sign out the others' }))) return;
    try {
      const r = await sessionApi.endOthers();
      setMessage({ ok: true, text: `${r.ended} other session(s) signed out.` });
      await loadDevices();
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMessage(null);
    try {
      await changePassword(current, next);
      setCurrent(''); setNext('');
      setMessage({ ok: true, text: 'Password changed. Your other sessions were signed out.' });
      await loadDevices();
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    // the old pre-sign-in database: only in a browser signed in to an account, only when it holds user data
    import('../../../../utils/legacyImport')
      .then(({ shouldOfferLegacyDelete }) => shouldOfferLegacyDelete(account?.id))
      .then((exists) => { if (!cancelled) setLegacyExists(exists); })
      .catch(() => { if (!cancelled) setLegacyExists(false); });
    return () => { cancelled = true; };
    // the answer is per account (the "deleted" marker is keyed by the user id): re-check when the account changes
  }, [account?.id]);

  // the account's display name: the label teammates see for this account's
  // identity on the central server (the same from every device)
  const [displayName, setDisplayNameState] = useState(account.displayName || '');
  const [nameDraft, setNameDraft] = useState(account.displayName || '');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMessage, setNameMessage] = useState(null);
  async function saveDisplayName(event) {
    event.preventDefault();
    const result = validateDisplayName(nameDraft);
    if (!result.ok) { setNameMessage({ ok: false, text: result.error }); return; }
    setNameBusy(true);
    setNameMessage(null);
    try {
      const answer = await updateProfile(result.value);
      const saved = answer?.user?.displayName ?? result.value;
      setDisplayNameState(saved);
      setNameDraft(saved);
      const info = getBackendInfo();
      if (info?.auth?.user) info.auth.user.displayName = saved;   // what accountIdentity() reads
      resetIdentityCache();
      try { window.dispatchEvent(new Event(DISPLAY_NAME_EVENT)); } catch { /* no DOM events here */ }
      sendDisplayNameUpdate();
      setNameMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setNameMessage({ ok: false, text: err.message });
    } finally {
      setNameBusy(false);
    }
  }

  async function deleteLegacy() {
    if (!(await confirm({ title: 'Delete the old data?', message: 'The data this browser kept from before sign-in is deleted. This cannot be undone. (Anything you imported into your account stays.)', type: 'danger', confirmLabel: 'Delete old data' }))) return;
    const { deleteLegacyDatabase } = await import('../../../../utils/legacyImport');
    await deleteLegacyDatabase(account?.id);
    setLegacyExists(false);
  }

  const liveDevices = devices.filter((d) => !d.revoked);
  return (
    <Section title={remoteServer ? `Account on ${remoteServer}` : 'Account'} testId="account-section"
      actions={<Button onClick={() => signOutAndReload({ before: stopCloudSync })} data-testid="sign-out">Sign out</Button>}>
      <p className="text-xs text-os-text-primary">
        Signed in as <span className="font-medium">{displayName || account.username}</span>
        <span className="text-os-text-muted"> ({account.username}{account.role === 'admin' ? ', administrator' : ''})</span>
      </p>
      <form onSubmit={saveDisplayName} className="flex flex-wrap items-end gap-2" data-testid="account-display-name-form">
        <Field label="Your name" hint="What teammates see, on every device of this account" className="flex-1 min-w-[12rem] max-w-sm">
          <TextInput value={nameDraft} maxLength={DISPLAY_NAME_MAX_LENGTH} onChange={(e) => setNameDraft(e.target.value)} placeholder={account.username} data-testid="account-display-name" />
        </Field>
        <Button type="submit" disabled={nameBusy || nameDraft.trim() === (displayName || '')} className="mb-5">Save name</Button>
        <StatusLine status={nameMessage} testId="account-display-name-message" />
      </form>
      {!remoteServer && <CentralStatus />}
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Current password">
            <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password (8+ characters)">
            <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy || next.length < 8 || !current}>Change password</Button>
          <StatusLine status={message} />
        </div>
      </form>

      <div className="text-xs space-y-1" data-testid="sessions">
        <div className="flex items-center justify-between gap-3">
          <p className="font-medium text-os-text-primary">Where you are signed in</p>
          {sessionList.length > 1 && <Button onClick={endOtherSessions} data-testid="sign-out-others">Sign out everywhere else</Button>}
        </div>
        <ul className="space-y-1">
          {sessionList.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 text-os-text-secondary" data-testid="session-row">
              <span className="min-w-0 truncate">
                {s.current ? <span className="font-medium text-os-text-primary">This browser</span> : (s.userAgent || 'Browser').slice(0, 80)}
                {` - last seen ${when(s.lastSeen)}`}
              </span>
              {!s.current && <Button className="px-2 py-0.5" onClick={() => endSession(s.id)}>Sign out</Button>}
            </li>
          ))}
        </ul>
      </div>
      {liveDevices.length > 0 && (
        <div className="text-xs space-y-1" data-testid="linked-devices">
          <p className="font-medium text-os-text-primary flex items-center gap-1"><Laptop size={12} /> Linked devices (the desktop app signed in to this server)</p>
          <ul className="space-y-1">
            {liveDevices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 text-os-text-secondary">
                <span>{d.name}{d.lastSeen ? ` - last seen ${when(d.lastSeen)}` : ' - never used'}</span>
                <Button className="px-2 py-0.5" onClick={() => revokeDevice(d.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {legacyExists && (
        <Note tone="warning" icon={null}>
          <div className="flex items-center justify-between gap-3">
            <span>This browser still holds the data from before sign-in (the old shared database).</span>
            <Button onClick={deleteLegacy}>Delete old data</Button>
          </div>
        </Note>
      )}
      <ConfirmationModal {...confirmationProps} />
    </Section>
  );
}

/**
 * "Delete all my data on the server" - the opposite of Wipe Database (this
 * device only). The server backs the account up first (Export Database
 * format, under the account, downloadable here), empties the account's
 * synchronised records and tells every device to empty itself at its next
 * synchronisation (src/sync/syncEngine.js). A fresh password and the typed
 * username are required; the per-account files on the server are an
 * explicit, separate choice.
 */
function DangerZone({ account, remoteServer = null }) {
  const status = useSyncStatus();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [includeFiles, setIncludeFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [backups, setBackups] = useState([]);

  async function loadBackups() {
    try {
      const data = await accountData.backups();
      setBackups(data.backups || []);
    } catch {
      setBackups([]);
    }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadBackups();
  }, []);

  async function download(name) {
    const url = await accountData.backupUrl(name);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  }

  async function run(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const { deleteAllServerData } = await import('../../../../sync/syncEngine');
      const answer = await deleteAllServerData({ password, confirmUsername: typed, includeFiles });
      setResult({ ok: true, text: `Done. ${answer.deleted?.records ?? 0} record(s) were removed from the server${includeFiles ? ` and ${answer.deleted?.files?.length || 0} file set(s)` : ''}; this browser emptied itself; every other device will at its next synchronisation. Backup: ${answer.backups?.[0] || ''}.` });
      setPassword(''); setTyped(''); setOpen(false);
      await loadBackups();
    } catch (err) {
      setResult({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  if (!status.enabled) return null;
  return (
    <Section title={remoteServer ? `Delete all my data on ${remoteServer}` : 'Delete all my data on the server'} tone="danger" testId="danger-zone">
      {remoteServer && (
        <Note tone="info" testId="danger-zone-remote">
          A linked device cannot delete the account's data on the server (its device token is deliberately limited to that): sign in to {remoteServer} in a browser to do it. The backups are listed here; download them from the browser as well.
        </Note>
      )}
      <p className="text-xs text-os-text-muted">
        Wipe Database (above) resets only this device - the data comes back from the server. This removes your
        synchronised data <span className="font-medium text-os-text-primary">from the server, for every device</span>:
        every browser and linked desktop profile of your account empties those records at its next synchronisation
        instead of uploading them again (a device that is offline now does so when it reconnects). A backup is written
        first and kept with your account (the last 3); restore one with Settings &gt; General &gt; Import Database.
      </p>
      {backups.length > 0 && (
        <div className="text-xs space-y-1" data-testid="server-backups">
          <p className="font-medium text-os-text-primary flex items-center gap-1"><Archive size={12} /> Backups on the server</p>
          <ul className="space-y-1">
            {backups.map((b) => (
              <li key={b.name} className="flex items-center justify-between gap-3 text-os-text-secondary">
                <span className="font-mono truncate">{b.name} <span className="font-sans">({Math.max(1, Math.round(b.bytes / 1024))} KB)</span></span>
                <Button className="px-2 py-0.5" onClick={() => download(b.name)}>Download</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!open ? (
        <Button variant="danger" onClick={() => { setOpen(true); setResult(null); }} data-testid="delete-all-open">Delete all my data on the server...</Button>
      ) : (
        <form onSubmit={run} className="space-y-3" data-testid="delete-all-form">
          <Note tone="danger">
            This removes your documents, boards, tasks, templates and settings data from the server and from every device of
            your account. It cannot be undone except by importing the backup. Type your username and your password to confirm.
          </Note>
          <Checkbox label="Also delete my files on the server" checked={includeFiles} onChange={setIncludeFiles} testId="delete-all-files"
            hint="Taskwarrior data, SSH keys and known_hosts, the settings file with the API keys, the calendar token, the RAG index and the reports directory. They are archived next to the backup first. Off by default: only the synchronised app data is deleted." />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={<>Type your username (<span className="font-mono">{account.username}</span>)</>}>
              <TextInput mono value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-testid="delete-all-username" />
            </Field>
            <Field label="Your password">
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" data-testid="delete-all-password" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="dangerSolid" disabled={busy || typed.trim().toLowerCase() !== account.username || !password} data-testid="delete-all-confirm">
              {busy ? 'Deleting...' : 'Delete all my data on the server'}
            </Button>
            <Button onClick={() => { setOpen(false); setPassword(''); setTyped(''); }}>Cancel</Button>
          </div>
        </form>
      )}
      <StatusLine status={result} testId="delete-all-result" />
    </Section>
  );
}

/**
 * Synchronisation with the home server (src/sync/syncEngine.js): status,
 * "sync now", and the snapshots taken before a first reconciliation
 * (downloadable in the Export Database format).
 */
function SyncSection() {
  const status = useSyncStatus();
  const [snapshots, setSnapshots] = useState([]);
  useEffect(() => {
    if (!status.enabled) return undefined;
    let cancelled = false;
    import('../../../../sync/syncEngine').then(({ listSnapshots }) => listSnapshots()).then((list) => { if (!cancelled) setSnapshots(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, [status.enabled, status.snapshotCount]);
  if (!status.enabled) return null;
  async function download(id) {
    const { getSnapshotJson } = await import('../../../../sync/syncEngine');
    const json = await getSnapshotJson(id);
    if (!json) return;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jacarium-snapshot-${id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function syncNow() {
    const { syncNow: run } = await import('../../../../sync/syncEngine');
    await run();
  }
  return (
    <Section title="Synchronisation with this server" testId="sync-section"
      actions={<Button onClick={syncNow} disabled={status.syncing} data-testid="sync-now" className={status.syncing ?'[&>svg]:animate-spin':''}>Sync now</Button>}>
      <p className="text-xs text-os-text-primary">
        Your documents, boards, tasks, templates and settings data are kept on this server and follow your account to every device.
        {status.paused || status.lastError
          ? ` Not synchronised right now${status.lastPullAt ? ` (last success ${new Date(status.lastPullAt).toLocaleString()})` : ''}.`
          : status.lastPullAt ? ` Last synchronised ${new Date(status.lastPullAt).toLocaleString()}.` : ''}
        {status.pending > 0 ? ` ${status.pending} change(s) waiting to be sent.` : ''}
        {status.conflicts > 0 ? ` ${status.conflicts} conflict(s) this session: a newer edit from another device replaced yours; your version was kept as a "conflict copy" document.` : ''}
        {Math.abs(status.serverSkewMs) > 120000 ? ` Note: this device's clock differs from the server's by ${Math.round(status.serverSkewMs / 60000)} min.` : ''}
      </p>
      <StatusLine status={status.paused ? { ok: false, text: `Paused: ${status.paused}` } : status.lastError ? { ok: false, text: `Last error: ${status.lastError}` } : null} testId="sync-error" />
      {snapshots.length > 0 && (
        <ul className="divide-y divide-os-border rounded-sm border border-os-border" data-testid="sync-snapshots">
          {snapshots.map((snap) => (
            <li key={snap.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs" data-testid="sync-snapshot-row" title={snap.reason}>
              <span className="text-os-text-primary truncate">{snap.label}</span>
              <span className="flex items-center gap-3 shrink-0 text-os-text-secondary">
                <span>{snap.bytes >= 1048576 ? `${(snap.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(snap.bytes / 1024))} KB`}</span>
                <Button variant="link" onClick={() => download(snap.id)} data-testid="sync-snapshot-download">Download</Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-os-text-muted">
        A snapshot of this device&apos;s data is saved (Export Database format) once before it is first reconciled with the server, and before it empties itself after a server-side deletion; the three newest are kept. Import Database restores one if ever needed.
      </p>
    </Section>
  );
}

/**
 * The open tabs following the account (src/utils/openTabsSync.js): one
 * toggle, on unless switched off, taking effect at once on this device
 * (the pages listen for the change). Without synchronisation (local-only,
 * signed out) it is shown disabled and says what it needs.
 */
function OpenTabsSection() {
  const status = useSyncStatus();
  const [on, setOn] = useState(() => isOpenTabsSyncEnabled());
  const ready = !!status.enabled;
  return (
    <Section title="Open tabs on your devices" testId="open-tabs-section">
      <Toggle label="Sync open tabs across devices" checked={on} disabled={!ready} testId="sync-open-tabs"
        onChange={(next) => { setOpenTabsSyncEnabled(next); setOn(next); }}
        hint={ready
          ? 'Tabs you open or close on one device open or close on your other devices signed in to this server.'
          : 'Needs synchronisation with a server: sign in to your self-hosted Jacarium (or link this desktop to it) first.'} />
    </Section>
  );
}

/**
 * Desktop: link this profile to a home server (a browser deployment with
 * accounts). The password is used once in the main process to mint a
 * device token; afterwards the profile's data synchronises with that
 * account (src/utils/homeServer.js).
 */
function HomeServerSection({ runScope = null, onCopySettings = null, onLinked = null }) {
  const { confirm, confirmationProps } = useConfirmation();
  const [status, setStatus] = useState(null);
  const [versions, setVersions] = useState(() => getLastVersionCheck());
  useEffect(() => subscribeVersionCheck(setVersions), []);
  const [url, setUrl] = useState('https://pi.console');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  async function refresh() {
    const { getHomeServerStatus, checkHomeServerVersion } = await import('../../../../utils/homeServer');
    const next = await getHomeServerStatus();
    setStatus(next);
    if (next?.url) setUrl(next.url);
    if (next?.linked) checkHomeServerVersion().catch(() => {});
  }
  useEffect(() => {
    // the status arrives after an await; nothing is set synchronously here
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch(() => setStatus({ linked: false }));
  }, []);

  async function link(e) {
    e.preventDefault();
    setBusy(true); setMessage(null);
    try {
      // a profile synchronises with one account: refuse another before linking
      const { syncAccountId } = await import('../../../../sync/syncEngine');
      const { linkHomeServer, unlinkHomeServer } = await import('../../../../utils/homeServer');
      const result = await linkHomeServer({ url, username, password });
      setPassword('');
      const previous = await syncAccountId();
      if (previous && result.user?.id && previous !== result.user.id) {
        await unlinkHomeServer();
        throw new Error(`This profile's data belongs to another account it synchronised with before. Use a separate profile for ${result.username} (Switch Profile), or wipe this profile's database first.`);
      }
      setMessage({ ok: true, text: `Linked as ${result.username}. Synchronisation starts now.${result.encrypted ? '' : ' (The OS keychain is not available here: the device token is stored unencrypted in the profile.)'}` });
      await refresh();
      // the one-time offer to copy this device's settings to the account
      if (onLinked) setTimeout(() => onLinked(), 0);
      // the cloud identity is the account's now: forget the old one and reconnect
      const { setAccountScope } = await import('../../../../utils/accountStorage');
      setAccountScope(result.user?.id || null);
      resetIdentityCache();
      const { stopCloudSync: stopCloud, startCloudSync } = await import('../../../../utils/cloudSync');
      stopCloud();
      startCloudSync().catch(() => { /* no central server configured */ });
      const { startSync } = await import('../../../../sync/syncEngine');
      const { startTaskwarriorFollow } = await import('../../../../sync/taskwarriorFollow');
      const { homeServerTransport, homeServerSyncGate } = await import('../../../../utils/homeServer');
      startTaskwarriorFollow();
      await startSync({ transport: homeServerTransport(), accountId: result.user?.id || null, gate: homeServerSyncGate });
    } catch (err) {
      setMessage({ ok: false, text: err.message.replace(/^Error invoking remote method '[^']+': Error: /, '') });
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!(await confirm({ title: 'Unlink this profile?', message: 'Its data stays here and on the server; synchronisation stops.', type: 'warning', confirmLabel: 'Unlink' }))) return;
    setBusy(true);
    try {
      const { unlinkHomeServer } = await import('../../../../utils/homeServer');
      await unlinkHomeServer();
      const { stopSync } = await import('../../../../sync/syncEngine');
      stopSync();
      // back to this machine's own cloud identity: drop the account's and reconnect
      const { setAccountScope } = await import('../../../../utils/accountStorage');
      setAccountScope(null);
      resetIdentityCache();
      const { stopCloudSync: stopCloud, startCloudSync } = await import('../../../../utils/cloudSync');
      stopCloud();
      startCloudSync().catch(() => { /* no central server configured */ });
      setMessage({ ok: true, text: 'Unlinked.' });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <Section title="Home server" testId="home-server-section">
      {status?.linked ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-os-text-primary">
            Linked to <span className="font-mono">{status.url}</span> as <span className="font-medium">{status.username}</span>
            <span className="text-os-text-muted"> (device &quot;{status.deviceName}&quot;{status.encrypted ? ', token in the OS keychain' : ', token stored unencrypted'})</span>
          </p>
          <Button onClick={unlink} disabled={busy} data-testid="home-server-unlink">Unlink</Button>
        </div>
      ) : null}
      {status?.linked && versions && versions.state !== 'not-linked' && (
        <p className="text-xs text-os-text-secondary" data-testid="home-server-versions">
          Desktop <span className="font-mono">{versions.desktop?.app}</span>, home server <span className="font-mono">{versions.server?.legacy ? 'before 3.0.0' : versions.server?.app || 'unknown'}</span>
          {versions.state === 'same' ? ' - the same version.' : versions.state === 'unreachable' ? ' - not reachable right now.' : ` - ${versions.message}`}
          {versions.downloadsUrl && versions.state !== 'unreachable' && (
            <> <button type="button" onClick={() => (window.electronAPI?.openExternal ? window.electronAPI.openExternal(versions.downloadsUrl) : window.open(versions.downloadsUrl, '_blank', 'noopener'))} className="text-blue-600 dark:text-blue-400 hover:underline">Desktop downloads on the server</button></>
          )}
        </p>
      )}
      {status?.linked && status.tls && (
        <p className="text-xs text-os-text-muted" data-testid="home-server-tls" data-pin={status.tls.pin || 'none'}>
          {status.tls.pin === 'root'
            ? <>Certificate: the server&apos;s certificate authority{status.tls.subject ? <> (<span className="font-mono">{status.tls.subject}</span>)</> : ''} is recorded, so its renewed certificates are accepted without a prompt.</>
            : status.tls.pin === 'leaf'
              ? <>Certificate: the server&apos;s certificate itself is recorded{status.tls.rootUnavailable ? ' - the server publishes no certificate authority (deploy/deploy-to-host.sh --proxy-ca-from <container> adds it), so a renewed certificate asks to be trusted again' : status.tls.rootRejected ? ' - the certificate authority the server publishes did not issue the certificate it presents, so it was not recorded' : ''}.</>
              : <>Certificate: trusted by the operating system (no pin needed).</>}
        </p>
      )}
      {status?.linked && (
        <p className="text-xs text-os-text-secondary" data-testid="home-server-settings-scope">
          Settings: this device uses {runScope?.scope === 'account' ? <>your account&apos;s settings</> : <>its own settings</>} (the switch is at the top of Integrations and AI Providers).
          {onCopySettings && <> <button type="button" className="underline" onClick={onCopySettings} data-testid="home-server-copy-settings">Copy settings to my account…</button></>}
        </p>
      )}
      {status?.linked && <CentralStatus />}
      {!status?.linked && (
        <form onSubmit={link} className="space-y-3" data-testid="home-server-form">
          <p className="text-xs text-os-text-muted">
            Sign this profile in to your Jacarium server (the browser deployment with accounts): its documents, boards, tasks and settings data then follow your account to every device, and the team features (shared documents, boards and workflows, chat, presence, games) come with it - nothing else to set up. The password is used once; the server gives this device its own revocable token.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <TextInput mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://pi.console" autoComplete="off" required />
            <TextInput value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoComplete="username" required />
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" autoComplete="current-password" required />
          </div>
          <Button type="submit" variant="primary" disabled={busy || !url || !username || !password} data-testid="home-server-link">Link this profile</Button>
        </form>
      )}
      <StatusLine status={message} />
      <ConfirmationModal {...confirmationProps} />
    </Section>
    <TaskwarriorSection />
    </>
  );
}

/** Settings > General > Taskwarrior: re-apply the account's tasks to this device's Taskwarrior (idempotent). */
function TaskwarriorSection() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  async function reapply() {
    setBusy(true); setResult(null);
    try {
      const { reapplyAll } = await import('../../../../sync/taskwarriorFollow');
      const r = await reapplyAll();
      const text = r.unavailable && r.imported === 0 && r.initialised === 0
        ? 'Taskwarrior was not found on this device (the task command); the tasks stay in the app until it is installed.'
        : `${r.instances} instance(s) checked, ${r.initialised} initialised here, ${r.imported} task(s) imported into Taskwarrior, ${r.skipped} already there${r.errors.length ? `; ${r.errors.length} error(s): ${r.errors.join(' / ')}` : ''}.`;
      setResult({ ok: r.errors.length === 0, text });
    } catch (err) {
      setResult({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Taskwarrior" testId="taskwarrior-section" description="Tasks synchronised from the account or restored by Import Database are applied to this device's Taskwarrior as they arrive. If some are missing there (an import or a link made with an earlier version, or Taskwarrior not installed at the time), re-apply them: instances are created under ~/.task/<name> when missing and only tasks Taskwarrior does not have yet are imported - nothing is duplicated.">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={reapply} disabled={busy} data-testid="taskwarrior-reapply">{busy ? 'Re-applying...' : 'Re-apply tasks to Taskwarrior'}</Button>
        <StatusLine status={result} testId="taskwarrior-reapply-status" />
      </div>
    </Section>
  );
}


export default function GeneralSettings({ remoteServer = null, runScope = null, onCopySettings = null, onLinked = null, theme, setTheme, machineId, zoomFactor, setZoomFactor, debugBarEnabled, setDebugBarEnabled, account = null, onExportDatabase, onImportDatabase, onWipeDatabase, onShowWhatsNew }) {
  // Zoom is only controllable in the desktop app (it goes through
  // webContents in the Electron main process); hide it in web mode.
  const zoomSupported = typeof window !== 'undefined' && !!window.electronAPI?.setZoomFactor;
  // Same for the debug status bar: its metrics come from the Electron main
  // process, so the toggle is meaningless in web mode.
  const debugBarSupported = typeof window !== 'undefined' && !!window.electronAPI?.setDebugBarEnabled;
  // The desktop profile this window belongs to (null in a browser)
  const [profileName, setProfileName] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.getProfileName) return undefined;
    api.getProfileName().then((name) => { if (!cancelled) setProfileName(name || null); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return (
    <div className="space-y-6">
      {account && <AccountSection account={account} remoteServer={remoteServer} />}
      {typeof window !== 'undefined' && window.electronAPI?.homeServerStatus && <HomeServerSection runScope={runScope} onCopySettings={onCopySettings} onLinked={onLinked} />}
      <SyncSection />
      <OpenTabsSection />

      <Section title="Appearance & Behavior">
        <Field label="Color Scheme" hint="Auto follows the system and uses Jacaranda as its dark theme; Dark (neutral) is the grey dark theme. Themed sidebars apply a colorful gradient background.">
          <Select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="auto">Auto (System)</option>
            <option value="light">Light</option>
            {Object.entries(DARK_THEMES).map(([key, config]) => (
              <option key={key} value={key}>{config.name}</option>
            ))}
            <optgroup label="Themes">
              {Object.entries(GRADIENT_THEMES).map(([key, config]) => (
                <option key={key} value={key}>{config.name}</option>
              ))}
            </optgroup>
          </Select>
          {theme.startsWith('gradient-') && GRADIENT_THEMES[theme] && (
            <div className="mt-2 p-3 rounded-sm border border-os-border">
              <p className="text-xs font-medium text-os-text-primary mb-2">Preview:</p>
              <div className="h-16 rounded-sm shadow-inner" style={{ background: GRADIENT_THEMES[theme].gradient }}></div>
            </div>
          )}
        </Field>
        {zoomSupported && (
          <Field label="UI Scale" hint="Applied immediately to all windows and remembered across restarts. The Cmd/Ctrl +, - and 0 keyboard shortcuts change the same setting.">
            <Select value={String(closestZoomLevel(zoomFactor ?? 0.9))} onChange={(e) => setZoomFactor(Number(e.target.value))}>
              {ZOOM_LEVELS.map((level) => (
                <option key={level} value={String(level)}>{Math.round(level * 100)}%</option>
              ))}
            </Select>
          </Field>
        )}
        {debugBarSupported && (
          <Toggle label="Show debug status bar" checked={debugBarEnabled === true} onChange={setDebugBarEnabled}
            hint="Live FPS plus CPU and memory usage (this window and the app as a whole) in a small overlay in the bottom-right corner of every window. Applied immediately - no restart needed - and remembered across restarts." />
        )}
      </Section>

      {/* Database and What's New: File > Database and Help > What's New in the
          desktop app's menu; offered here as well so a browser (no menu) has
          them. The callbacks come from CompactSidebar, which owns the flows. */}
      {(onExportDatabase || onImportDatabase || onWipeDatabase || onShowWhatsNew) && (
        <Section title="Database">
          <div className="flex flex-wrap gap-2">
            {onExportDatabase && <Button onClick={onExportDatabase}>Export Database</Button>}
            {onImportDatabase && <Button onClick={onImportDatabase}>Import Database</Button>}
            {onWipeDatabase && <Button variant="danger" onClick={onWipeDatabase}>Wipe Database</Button>}
          </div>
          <p className="text-xs text-os-text-muted">
            Export writes every document, task, board and setting to a file; Import merges or replaces from one; Wipe asks for confirmation first{account ? ' and resets this device only - your data comes back from the server' : ''}.
          </p>
          <div className="flex flex-wrap gap-2">
            {onShowWhatsNew && <Button onClick={onShowWhatsNew}>What&apos;s New</Button>}
            {!isDesktopApp() && <Button onClick={() => window.open('/api/downloads/', '_blank', 'noopener')} data-testid="download-desktop">Download the desktop app</Button>}
          </div>
          {!isDesktopApp() && <p className="text-xs text-os-text-muted">The desktop app (macOS, and others when published) links to this server and keeps the same account data offline; the downloads page lists the installers published here with their version and SHA-256.</p>}
        </Section>
      )}

      {account && <DangerZone account={account} remoteServer={remoteServer} />}

      {/* Informational (non-setting) details: one quiet card with divided rows. */}
      <InfoRows>
        <InfoRow>
          <p className="mb-1">Settings are stored in <Code>~/.jacarium.env</Code></p>
          <p className="font-medium">Application restart required for changes to take effect.</p>
        </InfoRow>
        {profileName && (
          <InfoRow testId="profile-row">
            <div className="flex items-center justify-between gap-3">
              <span>
                <span className="font-medium">Profile:</span> {profileName}
                <span className="text-os-text-secondary"> - its own documents, tasks, settings and sharing identity{profileName === 'default' ? '' : ` (${machineId || ''})`}</span>
              </span>
              <Button className="px-2 py-1" onClick={() => window.electronAPI?.switchProfile?.()}>Switch profile...</Button>
            </div>
          </InfoRow>
        )}
        <InfoRow>
          {isBrowserIdentity(machineId) && <div className="mb-3"><DisplayNameField machineId={machineId} /></div>}
          <p className="font-medium mb-1">Machine ID</p>
          <p className="font-mono bg-os-modal px-2 py-1 rounded-sm border border-os-border break-all" data-testid="machine-id">{machineId || 'Loading...'}</p>
          <p className="mt-1 text-os-text-secondary">
            {isAccountIdentity(machineId)
              ? 'This ID is used for document permissions and sharing. It is your account\'s identity: the same in every browser and linked desktop profile of the account, and the home server vouches for it to the central server - clearing this browser\'s site data does not change it.'
              : isBrowserIdentity(machineId)
                ? 'This ID is used for document permissions and sharing. It was generated once for this browser and is kept in its site storage; clearing that storage makes this browser a new identity that no longer owns its earlier documents. Sharing with teammates needs an account on a home server.'
                : 'This ID is used for document permissions and sharing. Sharing with teammates needs this profile linked to a home server (above).'}
          </p>
        </InfoRow>
      </InfoRows>
    </div>
  );
}
