/**
 * The Settings dialog's storage (Integrations / AI Providers: the
 * ~/.jacarium.env file), with write-only secrets.
 *
 * Two hosts, one contract:
 *   desktop  window.electronAPI.readSettings / writeSettings
 *            (electron/settings-store.cjs in the main process)
 *   browser  GET / PUT /api/settings on the backend
 *            (backend/settings_store.py)
 *
 *   loadSettings()  -> { values: {KEY: 'plain value'}, secrets: {KEY: true|false} }
 *   saveSettings({ values, secrets })
 *       values   plain settings; '' removes the key
 *       secrets  only the secrets the user typed; '' (or absent) keeps
 *                the stored one, null clears it
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

/** Which host holds the settings: 'desktop', 'backend' or null. */
export function settingsStoreHost() {
  if (desktopApi()) return 'desktop';
  return can('envSettings') ? 'backend' : null;
}

// With sign-in an administrator can edit the server defaults every account
// inherits ('server' scope: /api/admin/settings) besides their own ('own').
function settingsPath(scope) {
  return scope === 'server' ? '/api/admin/settings' : '/api/settings';
}

export async function loadSettings({ scope = 'own' } = {}) {
  const api = desktopApi();
  if (api) {
    const result = await api.readSettings();
    return { values: result?.values || {}, secrets: result?.secrets || {}, inherited: {} };
  }
  if (!can('envSettings')) {
    throw new Error('Settings storage is not available here');
  }
  const backendUrl = await getBackendUrl();
  const response = await apiFetch(`${backendUrl}${settingsPath(scope)}`);
  if (!response.ok) {
    throw new Error(`Backend refused to read the settings (HTTP ${response.status})`);
  }
  const data = await response.json();
  return { values: data.values || {}, secrets: data.secrets || {}, inherited: data.inherited || {} };
}

/** Tell the modules that cache a setting (Jira, see src/services/jiraApi.js) that the settings changed. */
function announceSaved() {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new Event('settingsSaved')); } catch { /* no DOM events here */ }
}

export async function saveSettings({ values = {}, secrets = {}, scope = 'own' }) {
  const api = desktopApi();
  if (api) {
    const result = await api.writeSettings({ values, secrets });
    announceSaved();
    return { values: result?.values || {}, secrets: result?.secrets || {} };
  }
  if (!can('envSettings')) {
    throw new Error('Settings storage is not available here');
  }
  const backendUrl = await getBackendUrl();
  const response = await apiFetch(`${backendUrl}${settingsPath(scope)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values, secrets }),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.error || `Backend refused to save the settings (HTTP ${response.status})`);
  }
  announceSaved();
  return { values: data?.values || {}, secrets: data?.secrets || {} };
}
