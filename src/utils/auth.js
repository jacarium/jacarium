/**
 * Sign-in for the browser deployment with accounts
 * (JACARIUM_AUTH_MODE=accounts, backend/auth.py).
 *
 * The backend's /api/capabilities answer carries `auth`:
 *   { mode: 'accounts', setupRequired, user: {id, username, displayName,
 *     role} | null, admin }
 * and in the other modes just { mode }. src/main.jsx reads it before the
 * app loads: with accounts and no user it shows the sign-in (or first-run
 * setup) page instead of the app, and once signed in it names the
 * account's own database (Jacarium-<user id>, src/db/database.js).
 *
 * The session is an HttpOnly cookie the browser sends by itself; every
 * request goes through apiFetch (the X-Requested-With header the backend
 * requires). Nothing here holds a credential.
 */
import { getBackendUrl, apiFetch } from './backendUrl';
import { getBackendInfo } from './platform';

/** The auth block of the capabilities answer ({ mode: 'app-token' } on the desktop). */
export function getAuthState() {
  const info = getBackendInfo();
  if (info?.auth) return info.auth;
  return { mode: typeof window !== 'undefined' && window.electronAPI ? 'app-token' : 'none' };
}

export function accountsEnabled() {
  return getAuthState().mode === 'accounts';
}

export function currentUser() {
  return accountsEnabled() ? getAuthState().user || null : null;
}

export function isAdmin() {
  return accountsEnabled() && getAuthState().admin === true;
}

/** The IndexedDB name for this session: one database per account. */
export function databaseNameFor(user) {
  return user?.id ? `Jacarium-${user.id}` : 'Jacarium';
}

// ---------------------------------------------------------------------------
// The desktop app administering its linked home server: the account calls
// below go through the main process with the device token
// (electron/home-server.cjs) instead of the local backend, and a
// state-changing administrative call that the server answers with
// STEP_UP_REQUIRED asks the password once (the registered prompt), confirms
// it at POST /api/auth/step-up and retries that one call.
// ---------------------------------------------------------------------------
let remoteAccount = null;   // { url, username, userId, role, displayName, capabilities } while linked (desktop)
let stepUpPrompt = null;    // async () => password | null

/** The linked home server's account the account calls address (desktop), or null. */
export function getRemoteAccount() { return remoteAccount; }
export function setRemoteAccount(account) { remoteAccount = account && account.url ? { ...account } : null; }
/** The prompt the step-up uses (Settings registers its password dialog). */
export function setStepUpPrompt(fn) { stepUpPrompt = typeof fn === 'function' ? fn : null; }

async function remoteFetch(method, path, body) {
  const { homeServerTransport } = await import('./homeServer');
  return homeServerTransport().fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function call(method, path, body, { retried = false } = {}) {
  const remote = remoteAccount && typeof window !== 'undefined' && window.electronAPI?.homeServerFetch;
  let response;
  if (remote) {
    response = await remoteFetch(method, path, body);
  } else {
    const backendUrl = await getBackendUrl();
    response = await apiFetch(`${backendUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    if (remote && !retried && response.status === 403 && data?.code === 'STEP_UP_REQUIRED' && stepUpPrompt) {
      const password = await stepUpPrompt();
      if (password) {
        const confirmed = await remoteFetch('POST', '/api/auth/step-up', { password });
        if (!confirmed.ok) { const d = await confirmed.json(); throw Object.assign(new Error(d?.error || 'The password was not accepted'), { status: confirmed.status, data: d }); }
        return call(method, path, body, { retried: true });
      }
    }
    const error = new Error(data?.error || `Request failed (HTTP ${response.status})`);
    error.status = response.status;
    error.data = data;
    error.stepUp = data?.code === 'STEP_UP_REQUIRED';
    throw error;
  }
  return data;
}

/** Confirm the password for the next administrative action (desktop over a device token). */
export const stepUp = (password) => call('POST', '/api/auth/step-up', { password }, { retried: true });

export const me = () => call('GET', '/api/auth/me');
export const login = (username, password) => call('POST', '/api/auth/login', { username, password });
export const logout = () => call('POST', '/api/auth/logout');
export const setup = ({ setupCode, username, password, displayName }) => call('POST', '/api/auth/setup', { setupCode, username, password, displayName });
export const changePassword = (currentPassword, newPassword) => call('POST', '/api/auth/password', { currentPassword, newPassword });
export const updateProfile = (displayName) => call('POST', '/api/auth/profile', { displayName });

export const devices = {
  list: () => call('GET', '/api/auth/devices'),
  revoke: (id) => call('DELETE', `/api/auth/devices/${encodeURIComponent(id)}`),
};

/** One's own sessions (the current one is marked). */
export const sessions = {
  list: () => call('GET', '/api/auth/sessions'),
  end: (id) => call('DELETE', `/api/auth/sessions/${encodeURIComponent(id)}`),
  endOthers: () => call('DELETE', '/api/auth/sessions'),
};

/** The account's server-side backups and "Delete all my data on the server" (backend/account_data.py). */
export const accountData = {
  backups: () => call('GET', '/api/account/backups'),
  // a backup is downloaded by the browser itself; a linked desktop has no session for that (null = not offered)
  backupUrl: async (name) => (remoteAccount ? null : `${await getBackendUrl()}/api/account/backups/${encodeURIComponent(name)}`),
  deleteAll: ({ password, confirmUsername, includeFiles }) => call('POST', '/api/account/data/delete', { password, confirmUsername, includeFiles }),
};

export const admin = {
  listUsers: () => call('GET', '/api/admin/users'),
  createUser: ({ username, password, displayName, role }) => call('POST', '/api/admin/users', { username, password, displayName, role }),
  disableUser: (id) => call('POST', `/api/admin/users/${encodeURIComponent(id)}/disable`),
  enableUser: (id) => call('POST', `/api/admin/users/${encodeURIComponent(id)}/enable`),
  resetPassword: (id, newPassword) => call('POST', `/api/admin/users/${encodeURIComponent(id)}/password`, { newPassword }),
  setRole: (id, role) => call('POST', `/api/admin/users/${encodeURIComponent(id)}/role`, { role }),
  deleteUser: (id, confirmUsername) => call('DELETE', `/api/admin/users/${encodeURIComponent(id)}`, { confirmUsername }),
  sessions: (id) => call('GET', `/api/admin/users/${encodeURIComponent(id)}/sessions`),
  endSession: (id, sessionId) => call('DELETE', `/api/admin/users/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`),
  revokeDevice: (id, deviceId) => call('DELETE', `/api/admin/users/${encodeURIComponent(id)}/devices/${encodeURIComponent(deviceId)}`),
  audit: (limit = 200) => call('GET', `/api/admin/audit?limit=${limit}`),
  backups: (id) => call('GET', `/api/admin/users/${encodeURIComponent(id)}/backups`),
  backupUrl: async (id, name) => (remoteAccount ? null : `${await getBackendUrl()}/api/admin/users/${encodeURIComponent(id)}/backups/${encodeURIComponent(name)}`),
  deleteData: (id, { password, confirmUsername, includeFiles }) => call('POST', `/api/admin/users/${encodeURIComponent(id)}/data/delete`, { password, confirmUsername, includeFiles }),
};

/** Sign out and start over (the page reload re-runs the bootstrap in main.jsx). */
export async function signOutAndReload({ before } = {}) {
  // `before` closes what carried this account's identity (the central-server
  // socket, Settings > General passes it) so presence and chat never show
  // the next account as this one; the reload drops every in-memory cache
  if (before) { try { await before(); } catch { /* best effort */ } }
  try { await logout(); } catch { /* the cookie is cleared server-side either way on the next load */ }
  window.location.reload();
}
