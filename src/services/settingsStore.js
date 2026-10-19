/**
 * The Settings dialog's storage (Integrations / AI Providers: the
 * KEY=VALUE settings file), with write-only secrets, in three scopes:
 *
 *   'device'   the desktop profile's own ~/.jacarium.env
 *              (window.electronAPI.readSettings / writeSettings,
 *              electron/settings-store.cjs). The desktop's default, and the
 *              only scope while the profile is not linked to a home server.
 *   'account'  the account's settings on the server: in a browser signed in
 *              there, GET / PUT /api/settings (backend/settings_store.py);
 *              on a linked desktop, the main process's copy of them
 *              (electron/account-settings.cjs - it fetches them with the
 *              device token, secrets to the OS keychain, and runs the local
 *              backend on them when this is the chosen scope).
 *   'server'   "Everyone": the server defaults every account inherits -
 *              GET / PUT /api/admin/settings, editable by administrators
 *              (over a device token with the step-up password).
 *
 *   loadSettings({ scope })  -> { values, secrets, inherited, sources, revision, revisions, meta }
 *       values     plain settings
 *       secrets    {KEY: true|false} - stored or not; a value never arrives
 *       inherited  (account scope in a browser) keys taken from the server defaults
 *       sources    (account scope) {KEY: 'account'|'everyone'} where each value comes from
 *       revisions  {KEY: n} - sent back as ifRevision so a key another device
 *                  changed since is refused (409) instead of overwritten
 *       meta       { lastSynced, offline, available, linked } on the desktop
 *   saveSettings({ scope, values, secrets, ifRevision })
 *       values   plain settings; '' removes the key
 *       secrets  only the secrets the user typed; '' (or absent) keeps the
 *                stored one, null clears it
 *
 * A credential is never returned to the UI: the dialog shows whether one
 * is stored and lets the user replace or clear it.
 */
import { getBackendUrl, apiFetch } from '../utils/backendUrl';
import { can } from '../utils/platform';

function desktopApi() {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  return api && typeof api.readSettings === 'function' && typeof api.writeSettings === 'function' ? api : null;
}

/** True when either host can store these settings. */
export function settingsStoreAvailable() {
  return can('envSettings');
}

/** Which host holds the device settings: 'desktop', 'backend' or null. */
export function settingsStoreHost() {
  if (desktopApi()) return 'desktop';
  return can('envSettings') ? 'backend' : null;
}

/** The desktop's scope controller, when this is the desktop app with the link feature. */
function accountApi() {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  return api && typeof api.accountSettingsState === 'function' ? api : null;
}

/** The scope the desktop RUNS on ('device' | 'account') with the controller's state; null in a browser. */
export async function getSettingsScopeState() {
  const api = accountApi();
  if (!api) return null;
  return api.accountSettingsState();
}

/** Switch the scope the desktop runs on; the local backend follows at once. */
export async function setSettingsScope(scope) {
  const api = accountApi();
  if (!api) throw new Error('Only the desktop app has a settings scope');
  return api.accountSettingsSetScope(scope);
}

// With sign-in an administrator can edit the server defaults every account
// inherits ('server' scope: /api/admin/settings) besides their own ('account').
function settingsPath(scope) {
  return scope === 'server' ? '/api/admin/settings' : '/api/settings';
}

/** A request to the account's server: the linked home server from the desktop (with the step-up retry), the backend in a browser. */
async function serverRequest(method, path, body) {
  const { request } = await import('../utils/auth');
  return request(method, path, body);
}

function withStatus(error, data, fallback) {
  const err = error instanceof Error ? error : new Error(data?.error || fallback);
  if (data?.conflicts) err.conflicts = data.conflicts;
  return err;
}

export async function loadSettings({ scope = 'device' } = {}) {
  const api = desktopApi();
  if (scope === 'device') {
    if (api) {
      const result = await api.readSettings();
      return { values: result?.values || {}, secrets: result?.secrets || {}, inherited: {}, sources: {}, revision: 0, revisions: {}, meta: {} };
    }
    // a browser without sign-in: the one file is the device's
    if (!can('envSettings')) throw new Error('Settings storage is not available here');
    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/settings`);
    if (!response.ok) throw new Error(`Backend refused to read the settings (HTTP ${response.status})`);
    const data = await response.json();
    return { values: data.values || {}, secrets: data.secrets || {}, inherited: data.inherited || {}, sources: {}, revision: data.revision || 0, revisions: data.revisions || {}, meta: {} };
  }
  if (scope === 'account' && accountApi()) {
    const state = await accountApi().accountSettingsState();
    return {
      values: state.values || {}, secrets: state.secrets || {}, inherited: {}, sources: state.sources || {},
      revision: state.revision || 0, revisions: state.revisions || {},
      meta: { lastSynced: state.lastSynced, offline: !!state.offline, available: !!state.available, linked: !!state.linked, error: state.error || null },
    };
  }
  // a browser signed in (account / server), or the desktop's Everyone view
  const data = await serverRequest('GET', settingsPath(scope));
  const sources = {};
  if (scope === 'account') {
    for (const key of Object.keys(data.values || {})) if (data.values[key] !== '') sources[key] = 'account';
    for (const key of Object.keys(data.secrets || {})) if (data.secrets[key]) sources[key] = 'account';
    for (const key of Object.keys(data.inherited || {})) if (!sources[key]) sources[key] = 'everyone';
  }
  return { values: data.values || {}, secrets: data.secrets || {}, inherited: data.inherited || {}, sources, revision: data.revision || 0, revisions: data.revisions || {}, meta: {} };
}

/** Tell the modules that cache a setting (Jira, see src/services/jiraApi.js) that the settings changed. */
function announceSaved() {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new Event('settingsSaved')); } catch { /* no DOM events here */ }
}

export async function saveSettings({ values = {}, secrets = {}, scope = 'device', ifRevision = null }) {
  const api = desktopApi();
  if (scope === 'device') {
    if (api) {
      const result = await api.writeSettings({ values, secrets });
      announceSaved();
      return { values: result?.values || {}, secrets: result?.secrets || {} };
    }
    if (!can('envSettings')) throw new Error('Settings storage is not available here');
    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values, secrets, ...(ifRevision ? { ifRevision } : {}) }),
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) throw withStatus(null, data, `Backend refused to save the settings (HTTP ${response.status})`);
    announceSaved();
    return { values: data?.values || {}, secrets: data?.secrets || {}, revision: data?.revision, revisions: data?.revisions };
  }
  if (scope === 'account' && accountApi()) {
    const state = await accountApi().accountSettingsWrite({ values, secrets, ifRevision });
    announceSaved();
    return { values: state.values || {}, secrets: state.secrets || {}, revision: state.revision, revisions: state.revisions };
  }
  try {
    const data = await serverRequest('PUT', settingsPath(scope), { values, secrets, ...(ifRevision ? { ifRevision } : {}) });
    announceSaved();
    return { values: data?.values || {}, secrets: data?.secrets || {}, revision: data?.revision, revisions: data?.revisions };
  } catch (error) {
    throw withStatus(error, error?.data, 'The server refused to save the settings');
  }
}

/** The migration: what the device file holds (plain values, secret NAMES) - read by the main process. */
export async function deviceSettingsSummary() {
  const api = accountApi();
  if (!api) return { values: {}, secretKeys: [] };
  return api.accountSettingsDeviceSummary();
}

/** Copy chosen keys of the device file to the account (the main process sends them; secrets never pass here). */
export async function copyDeviceSettingsToAccount({ plainKeys = [], secretKeys = [] }) {
  const api = accountApi();
  if (!api) throw new Error('Only the desktop app can copy its settings');
  return api.accountSettingsCopyFromDevice({ plainKeys, secretKeys });
}
