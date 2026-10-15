import { useState, useEffect } from 'react';
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
import { Button, Note, ModalHeader } from './settings/ui';
import { accountsEnabled, currentUser, isAdmin, setRemoteAccount, setStepUpPrompt } from '../../../utils/auth';
import { adminAccess } from '../../../utils/adminAccess';
import StepUpModal from './settings/StepUpModal';
import { desktopOnly } from '../../../utils/platform';
import { loadSettings as loadSettings_, saveSettings, settingsStoreAvailable, settingsStoreHost } from '../../../services/settingsStore';
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
  useEffect(() => {
    // the opener's tab wins each time the dialog opens
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isOpen) setActiveTab(initialTab || 'general');
  }, [isOpen, initialTab]);
  // With sign-in: whose settings the Integrations / AI tabs edit - the
  // account's own, or (administrators) the server defaults every account
  // inherits. Keys the account has not set show their inherited value.
  const [scope, setScope] = useState('own');
  const [inherited, setInherited] = useState({});
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
      const { values, secrets, inherited: inheritedValues } = await loadSettings_({ scope });
      setSettings(prev => {
        const next = { ...prev };
        Object.keys(next).forEach(key => { next[key] = ''; });
        return { ...next, ...values };
      });
      setStoredSecrets(secrets || {});
      setInherited(inheritedValues || {});
      setTypedSecrets({});
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

      const saved = await saveSettings({ values, secrets, scope });
      setStoredSecrets(saved.secrets || {});
      setTypedSecrets({});
      setSettings(prev => {
        const next = { ...prev, ...(saved.values || {}) };
        Object.keys(next).forEach(key => { if (isSecretKey(key)) next[key] = ''; });
        return next;
      });

      addNotification({
        type: 'success',
        title: 'Settings Saved',
        message: settingsStoreHost() === 'backend'
          ? 'Settings saved successfully! They apply to the server right away.'
          : 'Settings saved successfully! Please restart the application for changes to take effect.'
      });
    } catch (err) {
      setError('Failed to save settings: ' + err.message);
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
  }

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
    >
      <div data-testid="settings-modal">
      <ModalHeader title="Application Settings" onClose={onClose} />
      <StepUpModal request={stepUpRequest} server={access.server} onDone={() => setStepUpRequest(null)} />

      {/* Body - Two column layout (the category rail folds above the content on a narrow window) */}
      <div className="flex flex-col sm:flex-row bg-os-modal h-[70vh]">
        {/* Left Sidebar - Categories */}
        <div className="sm:w-48 border-b sm:border-b-0 sm:border-r border-os-border bg-os-canvas p-3 shrink-0 overflow-x-auto sm:overflow-y-auto">
          <div className="flex sm:flex-col gap-1" role="tablist">
            {[
              { id: 'general', label: 'General' },
              { id: 'integrations', label: 'Integrations' },
              { id: 'ai', label: 'AI Providers' },
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

              {envTab && accounts && admin && (
                <div className="mb-4 flex flex-wrap items-center gap-2 text-xs" data-testid="settings-scope">
                  <span className="text-os-text-secondary">These settings:</span>
                  {[['own', 'my account'], ['server', 'server defaults (every account)']].map(([id, label]) => (
                    <button key={id} type="button" onClick={() => setScope(id)}
                      className={`sc-btn sc-btn-segment px-2 py-1 rounded-sm border text-xs transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40 ${scope === id ?'bg-blue-600 border-blue-600 text-white':'border-os-input-border text-os-text-secondary hover:bg-os-card-secondary'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {envTab && accounts && scope === 'own' && Object.keys(inherited).length > 0 && (
                <p className="mb-4 text-xs text-os-text-muted">
                  Inherited from the server defaults until you set your own: {Object.keys(inherited).sort().join(', ')}.
                </p>
              )}

              {envTab && !envSettingsSupported && (
                <Note tone="warning" icon={AlertCircle} className="mb-4">
                  {desktopOnly('Editing the integration and AI provider settings')} or when the backend service is running: they live in the env file (~/.jacarium.env) that the app writes for you.
                </Note>
              )}

              <SecretStatusContext.Provider value={{ stored: storedSecrets, onClear: handleClearSecret }}>
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
              </SecretStatusContext.Provider>
            </>
          )}
        </div>
      </div>

      {/* Footer: Save applies to the Integrations / AI Providers fields; everything else applies as you go */}
      <div className="p-4 border-t border-os-border bg-os-modal flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-os-text-muted">{envTab ? 'Save writes the Integrations and AI Providers fields.' : 'Changes on this tab apply as you make them.'}</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="lg" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="lg" onClick={handleSave} disabled={saving || loading || !envSettingsSupported} title={envSettingsSupported ? undefined : desktopOnly('Saving these settings')} data-testid="settings-save">
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
        </div>
      </div>
      </div>
    </BaseModal>
  );
}
