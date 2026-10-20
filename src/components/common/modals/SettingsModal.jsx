import { useState, useEffect, useRef } from 'react';
import { getBackendUrl, apiFetch } from '../../../utils/backendUrl';
import BaseModal from './BaseModal';
import { AlertCircle } from 'lucide-react';
import { useNotifications } from '../../../contexts/NotificationContext';
import { useTheme } from '../../../contexts/ThemeContext';
import { getMachineId } from '../../../utils/cloudDocuments';

// Import category components
import GeneralSettings from './settings/GeneralSettings';
import IntegrationsSettings from './settings/IntegrationsSettings';
import AIProvidersSettings from './settings/AIProvidersSettings';
import UsersSettings from './settings/UsersSettings';
import AuditSettings from './settings/AuditSettings';
import AboutSettings from './settings/AboutSettings';
import ShortcutsSettings from './settings/ShortcutsSettings';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { Button, Note, ModalHeader } from './settings/ui';
import { accountsEnabled, currentUser, isAdmin, setRemoteAccount, setStepUpPrompt } from '../../../utils/auth';
import { adminAccess } from '../../../utils/adminAccess';
import StepUpModal from './settings/StepUpModal';
import { desktopOnly } from '../../../utils/platform';
import { loadSettings as loadSettings_, saveSettings, settingsStoreAvailable, settingsStoreHost, getSettingsScopeState, setSettingsScope } from '../../../services/settingsStore';
import { SettingsProvenanceContext, provenanceTag } from './settings/provenanceContext';
import CopySettingsSheet from './settings/CopySettingsSheet';
import { SETTINGS_FIELDS } from './settings/fieldCatalog';
import { serverLabel } from '../../../utils/adminAccess';
import { isSecretKey } from '../../../utils/secretKeys';
import { SecretStatusContext } from './settings/secretStatusContext';

/**
 * SettingsModal - Modal for managing application settings
 */
export default function SettingsModal({
  isOpen,
  onClose,
  // the tab (and its section, e.g. Integrations > Google Calendar) to show
  // when the dialog opens (src/utils/openSettings.js)
  initialTab = 'general',
  initialSection = null,
  // Electron menu items offered from the dialog too (a browser has no menu)
  onExportDatabase = null,
  onImportDatabase = null,
  onWipeDatabase = null,
  onShowWhatsNew = null,
}) {
  const { addNotification } = useNotifications();
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState({
    // JIRA
    JIRA_EMAIL: '',
    JIRA_PAT: '',

    // OpenAI
    OPENAI_API_KEY: '',

    // Anthropic
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_USE_BEDROCK: '',
    AWS_REGION: '',
    ANTHROPIC_USE_VERTEX: '',
    ANTHROPIC_GCP_PROJECT_ID: '',
    ANTHROPIC_GCP_LOCATION: '',
    ANTHROPIC_VERTEX_MODELS: '',

    // Google Gemini
    GEMINI_API_KEY: '',
    GEMINI_USE_VERTEX: '',
    GEMINI_PROJECT_ID: '',
    GEMINI_LOCATION: '',
    GEMINI_VERTEX_MODELS: '',

    // Google Calendar
    GOOGLE_CALENDAR_CLIENT_ID: '',
    GOOGLE_CALENDAR_CLIENT_SECRET: '',

    // HuggingFace
    HF_TOKEN: '',
    HF_EMBEDDING_MODEL: '',

    // Custom AI
    CUSTOM_AI_ENDPOINT: '',
    CUSTOM_API_KEY: '',

    // Default AI Settings
    DEFAULT_AI_PROVIDER: '',
    DEFAULT_AI_MODEL: '',
    DEFAULT_AI_TEMPERATURE: '',
    DEFAULT_AI_MAX_TOKENS: '',

    // SSH AI
    SSH_AI_DISPLAY_NAME: '',
    SSH_AI_HOST: '',
    SSH_AI_USER: '',
    SSH_AI_PASSWORD: '',
    SSH_AI_COMMAND_INITIAL: '',
    SSH_AI_COMMAND_FOLLOWUP: '',
  });
  const [loading, setLoading] = useState(false);
  // The integration / AI provider settings live in the env file: written by
  // the desktop app's main process, or by the backend when the app runs in
  // a browser the backend serves (src/services/settingsStore.js).
  const envSettingsSupported = settingsStoreAvailable();
  // Secrets are write-only: which ones are stored, and what was typed here.
  const [storedSecrets, setStoredSecrets] = useState({});
  const [typedSecrets, setTypedSecrets] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [machineId, setMachineId] = useState('');
  // Placeholder until the real value arrives over IPC; matches the
  // main process's first-run default (INITIAL_DEFAULT_ZOOM in main.cjs).
  const [zoomFactor, setZoomFactorState] = useState(0.9);
  // Debug status bar toggle; default off, mirrored from the main process.
  const [debugBarEnabled, setDebugBarEnabledState] = useState(false);
  const [activeTab, setActiveTab] = useState(initialTab);
  // no keyboard shortcuts to edit on a phone: the Shortcuts tab is not offered there
  const isMobile = useIsMobile();
  useEffect(() => {
    // the opener's tab wins each time the dialog opens
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isOpen) setActiveTab(initialTab || 'general');
  }, [isOpen, initialTab]);
  // The scope of the Integrations / AI Providers tabs (src/services/
  // settingsStore.js): 'device' (this profile's own file), 'account' (the
  // account's settings on the server - what every device of the account
  // uses; on a linked desktop the whole profile RUNS on them while this is
  // the chosen scope), 'server' ("Everyone": the defaults every account
  // inherits, editable by administrators). No mixing: whatever scope the
  // desktop runs on is in force as a whole.
  const [scope, setScopeState] = useState(accountsEnabled() ? 'account' : 'device');
  const [inherited, setInherited] = useState({});
  const [sources, setSources] = useState({});          // KEY -> 'account' | 'everyone' (account scope)
  const [revisions, setRevisions] = useState({});      // KEY -> revision, sent back as ifRevision
  const [scopeMeta, setScopeMeta] = useState({});      // { lastSynced, offline, available, linked }
  const [runScope, setRunScope] = useState(null);      // the desktop controller's state, null in a browser
  const [dirty, setDirty] = useState(false);           // edits since the last load / save
  const [pendingScope, setPendingScope] = useState(null);  // a scope chosen while edits are unsaved
  const [conflicts, setConflicts] = useState(null);    // the keys another device changed (409)
  const [copySheet, setCopySheet] = useState(false);
  // the control that opened the copy sheet (focus goes back to it when the
  // sheet closes; the dialog itself when the sheet opened on its own)
  const copySheetOpener = useRef(null);
  const dialogRef = useRef(null);
  function openCopySheet() {
    copySheetOpener.current = document.activeElement;
    setCopySheet(true);
  }
  // The desktop app linked to a home server: that server's account (role as
  // the server reports it now) and whether it lets a linked device
  // administer it (src/utils/adminAccess.js). The browser needs none of this.
  const [remote, setRemote] = useState(null);
  const [stepUpRequest, setStepUpRequest] = useState(null);   // { resolve } while the password dialog is open
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isOpen || accountsEnabled() || !window.electronAPI?.homeServerStatus) { setRemoteAccount(null); setRemote(null); return; }
      try {
        const status = await window.electronAPI.homeServerStatus();
        if (!status?.linked) { if (!cancelled) { setRemoteAccount(null); setRemote(null); } return; }
        const { homeServerTransport } = await import('../../../utils/homeServer');
        const transport = homeServerTransport();
        const [meAnswer, versionAnswer] = await Promise.all([transport.fetch('/api/auth/me').catch(() => null), transport.fetch('/api/version').catch(() => null)]);
        const me = meAnswer && meAnswer.ok ? (await meAnswer.json())?.user : null;
        const version = versionAnswer && versionAnswer.ok ? await versionAnswer.json() : null;
        const account = { url: status.url, username: me?.username || status.username, userId: me?.id || status.userId, displayName: me?.displayName || status.displayName, role: me?.role || status.role || 'user', capabilities: version?.capabilities || {}, app: version?.app || null };
        if (!cancelled) { setRemoteAccount(account); setRemote(account); }
      } catch { if (!cancelled) { setRemoteAccount(null); setRemote(null); } }
    })();
    return () => { cancelled = true; };
  }, [isOpen]);
  // the desktop's run scope (electron/account-settings.cjs): the dialog opens
  // on it, and follows the main process while open (a wipe on revocation,
  // a refresh after a change on another device)
  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    getSettingsScopeState().then((state) => {
      if (cancelled || !state) return;
      setRunScope(state);
      if (state.linked && (state.scope === 'account' || state.scope === 'device')) setScopeState(state.scope);
      else if (!state.linked) setScopeState('device');
    }).catch(() => {});
    const unsubscribe = window.electronAPI?.onAccountSettingsChanged?.((state) => {
      setRunScope(state);
      if (!state.linked || state.scope === 'device') setScopeState((current) => (current === 'account' ? 'device' : current));
    });
    return () => { cancelled = true; if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [isOpen]);

  // The one-time offer to copy this device's settings to the account: a
  // profile linked before this version runs on "This device" until it is
  // answered (Copy -> My account; Not now -> the banner and this flag). The
  // flag is per profile (each desktop profile has its own storage), not per
  // account: a lookup of the account must not decide whether it was shown.
  const migrationFlag = runScope?.linked ? 'settingsScopeMigrationAnswered' : null;
  function markMigrationAnswered() {
    try { if (migrationFlag) localStorage.setItem(migrationFlag, new Date().toISOString()); } catch { /* storage unavailable */ }
  }
  useEffect(() => {
    if (!isOpen || !runScope?.linked || runScope.scope !== 'device' || !migrationFlag) return;
    let answered = null;
    try { answered = localStorage.getItem(migrationFlag); } catch { answered = 'unknown'; }
    if (answered) return;
    // opened on its own: focus returns to the dialog, no opener to name
    copySheetOpener.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCopySheet(true);
  }, [isOpen, runScope, migrationFlag]);

  // the step-up prompt the account calls use on the desktop (src/utils/auth.js)
  useEffect(() => {
    if (!remote) { setStepUpPrompt(null); return; }
    setStepUpPrompt(() => new Promise((resolve) => setStepUpRequest({ resolve })));
    return () => setStepUpPrompt(null);
  }, [remote]);
  const access = adminAccess({ accountsMode: accountsEnabled(), admin: isAdmin(), remote });
  const accounts = access.account;
  const admin = access.admin;
  // the tabs whose fields live in the env file and go through Save
  const envTab = activeTab === 'integrations' || activeTab === 'ai';
  const [availableModels, setAvailableModels] = useState({
    anthropic: [],
    openai: [],
    gemini: [],
    ollama: []
  });

  async function loadSettings() {
    if (!settingsStoreAvailable()) {
      return;
    }
    try {
      setLoading(true);
      setError('');
      // Plain values arrive as they are; a secret only as stored / not
      // stored (its value never reaches this dialog - settingsStore.js).
      const { values, secrets, inherited: inheritedValues, sources: sourceMap, revisions: revisionMap, meta } = await loadSettings_({ scope });
      setSettings(prev => {
        const next = { ...prev };
        Object.keys(next).forEach(key => { next[key] = ''; });
        return { ...next, ...values };
      });
      setStoredSecrets(secrets || {});
      setInherited(inheritedValues || {});
      setSources(sourceMap || {});
      setRevisions(revisionMap || {});
      setScopeMeta(meta || {});
      setTypedSecrets({});
      setDirty(false);
      setConflicts(null);
    } catch (err) {
      setError('Failed to load settings: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadAvailableModels() {
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/ai/models`);
      if (response.ok) {
        const data = await response.json();
        setAvailableModels(data);
      }
    } catch (err) {
      console.error('[Settings] Error loading models:', err);
    }
  }

  useEffect(() => {
    if (isOpen) {
      // loadSettings flips the loading flag synchronously on purpose so the
      // spinner shows while the env file is read; everything else it sets
      // happens after an await.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadSettings();
      loadAvailableModels();
      getMachineId().then(id => setMachineId(id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, scope]);

  // UI zoom lives in the main process (which owns webContents zoom and
  // persists the chosen factor across restarts). Mirror it here so the
  // General tab shows the live value, and stay subscribed while the modal
  // is open so the Cmd/Ctrl +/-/0 menu shortcuts don't leave the dropdown
  // showing a stale percentage. Unlike the env-file settings above, zoom
  // applies immediately - it does not go through the Save button.
  useEffect(() => {
    if (!isOpen || !window.electronAPI?.getZoomFactor) return;
    window.electronAPI.getZoomFactor()
      .then(setZoomFactorState)
      .catch(() => {});
    const cleanup = window.electronAPI.onZoomFactorChanged?.(setZoomFactorState);
    return cleanup;
  }, [isOpen]);

  async function handleZoomChange(factor) {
    setZoomFactorState(factor);
    try {
      await window.electronAPI?.setZoomFactor?.(factor);
    } catch (err) {
      console.error('[Settings] Failed to set zoom factor:', err);
    }
  }

  // The debug status bar toggle mirrors the zoom pattern above: the main
  // process owns and persists the state, and it applies live to every
  // window - it does not go through the Save button. Stay subscribed while
  // the modal is open so a toggle flipped in another window's Settings
  // dialog is reflected here immediately.
  useEffect(() => {
    if (!isOpen || !window.electronAPI?.getDebugBarEnabled) return;
    window.electronAPI.getDebugBarEnabled()
      .then((value) => setDebugBarEnabledState(value === true))
      .catch(() => {});
    const cleanup = window.electronAPI.onDebugBarChanged?.(
      (value) => setDebugBarEnabledState(value === true)
    );
    return cleanup;
  }, [isOpen]);

  async function handleDebugBarChange(enabled) {
    setDebugBarEnabledState(enabled);
    try {
      await window.electronAPI?.setDebugBarEnabled?.(enabled);
    } catch (err) {
      console.error('[Settings] Failed to set debug status bar:', err);
    }
  }

  async function handleSave() {
    if (!envSettingsSupported) {
      addNotification({
        type: 'alert',
        title: 'Desktop Only Feature',
        message: desktopOnly('Saving these settings') + '.'
      });
      return;
    }

    try {
      setSaving(true);
      setError('');

      // Plain settings: the whole form ('' removes a key). Secrets: only
      // the ones typed in this dialog - an untouched field keeps the
      // stored credential, so saving never wipes one.
      const values = {};
      Object.keys(settings).forEach(key => {
        if (isSecretKey(key)) return;
        const value = settings[key];
        if (typeof value === 'string') {
          values[key] = value.trim();
        } else if (value !== null && value !== undefined) {
          values[key] = String(value);
        }
      });
      const secrets = {};
      Object.keys(typedSecrets).forEach(key => {
        const value = typedSecrets[key];
        if (value === null) {
          secrets[key] = null;
        } else if (typeof value === 'string' && value.trim() !== '') {
          secrets[key] = value.trim();
        }
      });

      const saved = await saveSettings({ values, secrets, scope, ifRevision: scope === 'device' ? null : revisions });
      setStoredSecrets(saved.secrets || {});
      setTypedSecrets({});
      if (saved.revisions) setRevisions(saved.revisions);
      setSettings(prev => {
        const next = { ...prev, ...(saved.values || {}) };
        Object.keys(next).forEach(key => { if (isSecretKey(key)) next[key] = ''; });
        return next;
      });
      setDirty(false);
      setConflicts(null);
      if (scope === 'account') {
        setSources((prev) => { const next = { ...prev }; for (const key of Object.keys(saved.values || {})) next[key] = 'account'; for (const key of Object.keys(saved.secrets || {})) if (saved.secrets[key]) next[key] = 'account'; return next; });
      }

      addNotification({
        type: 'success',
        title: 'Settings Saved',
        message: scope === 'account'
          ? `Saved to your account${access.server ? ` on ${access.server}` : ''}: every device of the account uses them now.`
          : scope === 'server'
            ? 'Saved as the server defaults every account inherits.'
            : settingsStoreHost() === 'backend'
              ? 'Settings saved successfully! They apply to the server right away.'
              : 'Settings saved successfully! Please restart the application for changes to take effect.'
      });
    } catch (err) {
      if (err?.conflicts) {
        setConflicts(err.conflicts);
        setError('Changed on another device since this dialog loaded: ' + err.conflicts.map((c) => c.key).join(', ') + '. Reload to see the current values, then save again.');
      } else {
        setError('Failed to save settings: ' + err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  function handleChange(key, value) {
    if (isSecretKey(key)) {
      setTypedSecrets(prev => ({ ...prev, [key]: value }));
    }
    setSettings(prev => ({
      ...prev,
      [key]: value
    }));
    setDirty(true);
  }

  // ---- the scope switch ----
  const desktopLinked = !!(runScope && runScope.linked);
  const scopeOptions = desktopLinked
    ? [['device', 'This device'], ['account', 'My account'], ['server', admin ? 'Everyone' : 'Everyone (view)']]
    : (accounts && !window.electronAPI ? [['account', 'My account'], ['server', admin ? 'Everyone' : 'Everyone (view)']] : []);
  const readOnly = scope === 'server' && !admin;
  // choosing a scope: on the desktop This device / My account also decide
  // what the profile RUNS on (the main process switches the local backend
  // at once); Everyone is a view (or, for an administrator, an editor)
  async function applyScope(next) {
    setPendingScope(null);
    if (desktopLinked && (next === 'device' || next === 'account')) {
      try {
        const state = await setSettingsScope(next);
        setRunScope(state);
      } catch (err) {
        setError(err.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
        return;
      }
    }
    setScopeState(next);
  }
  function chooseScope(next) {
    if (next === scope) return;
    if (dirty) { setPendingScope(next); return; }
    applyScope(next);
  }
  const provenance = { tagFor: (key) => provenanceTag({ scope, sources, values: settings, secrets: storedSecrets, inherited }, key) };
  const serverName = access.server || (runScope?.linked ? serverLabel(runScope.url || '') : '') || 'your server';

  // Clear a stored credential (the field's "Clear" action): saved as null.
  function handleClearSecret(key) {
    setTypedSecrets(prev => ({ ...prev, [key]: null }));
    setStoredSecrets(prev => ({ ...prev, [key]: false }));
    setSettings(prev => ({ ...prev, [key]: '' }));
  }

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onClose}
      className="max-w-4xl w-full"
      // Esc belongs to the dialog on top while one is stacked over this one
      closeOnEscape={!copySheet && !stepUpRequest}
    >
      {/* inert while the copy sheet is open: nothing in here (the footer's
          Save included) can be reached or clicked until it is answered */}
      <div data-testid="settings-modal" inert={copySheet} ref={dialogRef} tabIndex={-1} className="focus:outline-hidden">
      <ModalHeader title="Application Settings" onClose={onClose} />
      <StepUpModal request={stepUpRequest} server={access.server} onDone={() => setStepUpRequest(null)} />
      {/* its own dialog, stacked above this one (z 55) */}
      <CopySettingsSheet open={copySheet} server={serverName} onClose={() => { setCopySheet(false); markMigrationAnswered(); }}
        returnFocusTo={() => (copySheetOpener.current && dialogRef.current?.contains(copySheetOpener.current) ? copySheetOpener.current : dialogRef.current)}
        onCopied={() => { setCopySheet(false); markMigrationAnswered(); setScopeState('account'); getSettingsScopeState().then((s) => s && setRunScope(s)).catch(() => {}); addNotification({ type: 'success', title: 'Settings copied', message: `Your account on ${serverName} now holds them; this device uses your account's settings.` }); }} />

      {/* Body - Two column layout (the category rail folds above the content on a narrow window) */}
      <div className="flex flex-col sm:flex-row bg-os-modal h-[70vh]">
        {/* Left Sidebar - Categories */}
        <div className="sm:w-48 border-b sm:border-b-0 sm:border-r border-os-border bg-os-canvas p-3 shrink-0 overflow-x-auto sm:overflow-y-auto">
          <div className="flex sm:flex-col gap-1" role="tablist">
            {[
              { id: 'general', label: 'General' },
              { id: 'integrations', label: SETTINGS_FIELDS.integrations.tab },
              { id: 'ai', label: SETTINGS_FIELDS.ai.tab },
              ...(isMobile ? [] : [{ id: 'shortcuts', label: 'Shortcuts' }]),
              ...(accounts && admin ? [{ id: 'users', label: access.remote ? `Users on ${access.server}` : 'Users' }, { id: 'audit', label: 'Audit' }] : []),
              { id: 'about', label: 'About' },
            ].map(category => (
              <button
                key={category.id}
                type="button"
                role="tab"
                aria-selected={activeTab === category.id}
                onClick={() => setActiveTab(category.id)}
                className={`
 sc-rail-tab sm:w-full flex items-center px-3 py-2 text-xs transition-colors rounded-sm whitespace-nowrap focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40
 ${activeTab === category.id
 ?'bg-blue-600 text-white'
 :'text-os-text-secondary hover:text-os-text-primary hover:bg-os-card-secondary dark:hover:bg-os-sidebar-hover'
 }
`}
              >
                {category.label}
              </button>
            ))}
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 p-4 sm:p-6 space-y-6 overflow-y-auto" data-testid="settings-body">
          {/* Error */}
          {error && (
            <Note tone="danger" icon={AlertCircle}>{error}</Note>
          )}

          {loading ? (
            <div className="text-center py-8">
              <p className="text-sm text-os-text-secondary">Loading settings...</p>
            </div>
          ) : (
            <>
              {activeTab === 'general' && (
                <GeneralSettings
                  settings={settings}
                  handleChange={handleChange}
                  theme={theme}
                  setTheme={setTheme}
                  machineId={machineId}
                  zoomFactor={zoomFactor}
                  setZoomFactor={handleZoomChange}
                  debugBarEnabled={debugBarEnabled}
                  setDebugBarEnabled={handleDebugBarChange}
                  account={accounts ? (access.remote ? { id: remote.userId, username: remote.username, displayName: remote.displayName, role: remote.role } : currentUser()) : null}
                  remoteServer={access.remote ? access.server : null}
                  runScope={runScope}
                  onCopySettings={openCopySheet}
                  onLinked={() => { getSettingsScopeState().then((s) => { if (s) setRunScope(s); openCopySheet(); }).catch(() => openCopySheet()); }}
                  onExportDatabase={onExportDatabase}
                  onImportDatabase={onImportDatabase}
                  onWipeDatabase={onWipeDatabase}
                  onShowWhatsNew={onShowWhatsNew}
                />
              )}

              {activeTab === 'users' && accounts && admin && (
                <UsersSettings server={access.remote ? access.server : null} />
              )}
              {activeTab === 'audit' && accounts && admin && (
                <AuditSettings server={access.remote ? access.server : null} />
              )}
              {activeTab === 'general' && access.unsupported && (
                <Note tone="warning" testId="remote-admin-unsupported">
                  You are an administrator on {access.server}, but that server ({remote?.app ? `version ${remote.app}` : 'an earlier version'}) does not let a linked desktop administer it yet. Update the server, or manage users and the audit log from a browser signed in there.
                </Note>
              )}
              {activeTab === 'about' && (
                <AboutSettings onShowWhatsNew={onShowWhatsNew} />
              )}
              {activeTab === 'shortcuts' && !isMobile && (
                <ShortcutsSettings />
              )}

              {envTab && scopeOptions.length > 0 && (
                <div className="mb-4 space-y-2" data-testid="settings-scope">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-os-text-secondary">{desktopLinked ? 'Settings used by this device:' : 'These settings:'}</span>
                    <div role="radiogroup" aria-label="Settings scope" className="flex flex-wrap items-center gap-1">
                      {scopeOptions.map(([id, label]) => (
                        <button key={id} type="button" role="radio" aria-checked={scope === id} data-testid={`scope-${id}`} onClick={() => chooseScope(id)}
                          className={`sc-btn sc-btn-segment px-2 py-1 rounded-sm border text-xs transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40 ${scope === id ?'bg-blue-600 border-blue-600 text-white':'border-os-input-border text-os-text-secondary hover:bg-os-card-secondary'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {scope === 'account' && scopeMeta?.lastSynced && (
                      <span className="text-os-text-muted" data-testid="scope-synced">
                        {scopeMeta.offline ? 'Offline - last known values, synced ' : 'Last synced '}{new Date(scopeMeta.lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} with {serverName}
                      </span>
                    )}
                  </div>
                  {pendingScope && (
                    <Note tone="warning" testId="scope-unsaved">
                      <span className="mr-2">Unsaved changes on this tab.</span>
                      <Button size="sm" variant="primary" onClick={async () => { await handleSave(); applyScope(pendingScope); }} data-testid="scope-save-first">Save, then switch</Button>
                      <Button size="sm" variant="ghost" className="ml-1" onClick={() => applyScope(pendingScope)} data-testid="scope-discard">Discard and switch</Button>
                      <Button size="sm" variant="ghost" className="ml-1" onClick={() => setPendingScope(null)} data-testid="scope-stay">Stay</Button>
                    </Note>
                  )}
                  {desktopLinked && scope === 'device' && (
                    <Note tone="info" testId="scope-device-banner">
                      This device uses its own settings. Your phone uses your account&apos;s.{' '}
                      <button type="button" className="underline" onClick={() => chooseScope('account')} data-testid="scope-use-account">Use my account&apos;s settings</button>
                      {' '}or <button type="button" className="underline" onClick={openCopySheet} data-testid="scope-copy-open">copy this device&apos;s settings to my account</button>.
                    </Note>
                  )}
                  {desktopLinked && scope === 'account' && (
                    <p className="text-xs text-os-text-muted" data-testid="scope-account-note">
                      This device runs on your account&apos;s settings - its own file is not used while this is chosen. Secrets stay in your keychain here and are never shown.
                    </p>
                  )}
                  {scope === 'server' && (
                    <p className="text-xs text-os-text-muted" data-testid="scope-server-note">
                      {admin ? `The defaults every account on ${serverName} inherits; saving asks for your password.` : `Set by the administrator of ${serverName} (read-only). Your account's own values take precedence.`}
                    </p>
                  )}
                  {scope === 'account' && !desktopLinked && Object.keys(inherited).length > 0 && (
                    <p className="text-xs text-os-text-muted">
                      Inherited from the server defaults until you set your own: {Object.keys(inherited).sort().join(', ')}.
                    </p>
                  )}
                  {conflicts && (
                    <Note tone="warning" testId="scope-conflict">
                      <Button size="sm" variant="primary" onClick={() => loadSettings()}>Reload the settings</Button>
                    </Note>
                  )}
                </div>
              )}

              {envTab && !envSettingsSupported && (
                <Note tone="warning" icon={AlertCircle} className="mb-4">
                  {desktopOnly('Editing the integration and AI provider settings')} or when the backend service is running: they live in the env file (~/.jacarium.env) that the app writes for you.
                </Note>
              )}

              <SecretStatusContext.Provider value={{ stored: storedSecrets, onClear: readOnly ? () => {} : handleClearSecret }}>
                <SettingsProvenanceContext.Provider value={provenance}>
                  {/* Everyone, for a non-administrator: a view (a disabled fieldset disables every control in it) */}
                  <fieldset disabled={readOnly} className="contents min-w-0" data-testid={envTab ? `settings-panels-${readOnly ? 'readonly' : 'editable'}` : undefined}>
                    {activeTab === 'integrations' && (
                      <IntegrationsSettings
                        settings={settings}
                        handleChange={handleChange}
                        initialSection={initialSection}
                      />
                    )}

                    {activeTab === 'ai' && (
                      <AIProvidersSettings
                        settings={settings}
                        handleChange={handleChange}
                        availableModels={availableModels}
                      />
                    )}
                  </fieldset>
                </SettingsProvenanceContext.Provider>
              </SecretStatusContext.Provider>
            </>
          )}
        </div>
      </div>

      {/* Footer: Save applies to the Integrations / AI Providers fields; everything else applies as you go */}
      <div className="p-4 border-t border-os-border bg-os-modal flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-os-text-muted">{envTab ? (readOnly ? 'Read-only: the administrator sets these.' : scope === 'account' ? 'Save writes the Integrations and AI Providers fields to your account.' : scope === 'server' ? 'Save writes the defaults every account inherits.' : 'Save writes the Integrations and AI Providers fields.') : 'Changes on this tab apply as you make them.'}</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="lg" onClick={onClose}>Cancel</Button>
          {!(envTab && readOnly) && (
            <Button variant="primary" size="lg" onClick={handleSave} disabled={saving || loading || !envSettingsSupported} title={envSettingsSupported ? undefined : desktopOnly('Saving these settings')} data-testid="settings-save">
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          )}
        </div>
      </div>
      </div>
    </BaseModal>
  );
}
