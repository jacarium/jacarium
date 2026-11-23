/**
 * Sign-in for the browser deployment with accounts
 * (JACARIUM_AUTH_MODE=accounts, backend/auth.py).
 *
 * The backend's /api/capabilities answer carries `auth`:
 *   { mode: 'accounts', setupRequired, user: {id, username, displayName,
 *     role, hasPassword, sso: {issuer, subject} | null} | null, admin,
 *     sso: { enabled, buttonLabel, passwordLogin, issuer, autoCreate } }
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

/** Single sign-on on this server ({ enabled, buttonLabel, passwordLogin, issuer, autoCreate }), or null when it is off. */
export function ssoState() {
  const sso = accountsEnabled() ? getAuthState().sso : null;
  return sso && sso.enabled ? sso : null;
}

// What the page says for each code the server's SSO landing carries (backend/auth.py: the provider's own words
// never reach the page - an administrator finds the detail in the server log and the audit log).
const SSO_MESSAGES = {
  no_account: 'No account on this server is linked to that identity. Ask an administrator, or sign in with your password and link single sign-on in Settings.',
  link_required: 'An account with that username exists, but it is not linked to your identity. Sign in with its password and link single sign-on in Settings > General.',
  disabled: 'This account is disabled.',
  not_allowed_group: 'Your identity is not in a group that may use this server.',
  not_allowed_domain: 'Your email domain may not use this server.',
  email_not_verified: 'The identity provider has not verified your email address, which this server requires.',
  missing_claim: 'Your identity lacks the permission this server requires.',
  denied: 'The sign-in was cancelled or refused at the identity provider.',
  state: 'The sign-in did not start in this browser, took too long, or was already completed. Try again.',
  stale: 'The identity provider did not ask you to sign in again. Try again.',
  token: 'The identity provider\'s answer could not be verified.',
  provider: 'The identity provider could not be reached or answered with an error.',
  config: 'Single sign-on is not set up correctly on this server.',
  identity_in_use: 'That identity is already linked to another account.',
  wrong_session: 'The session that started this ended meanwhile. Sign in and try again.',
  mismatch: 'You confirmed with another identity than the one linked to this account.',
};
export const ssoMessage = (code) => SSO_MESSAGES[code] || 'Single sign-on did not complete.';

const SSO_RESULT_KEY = 'jacarium-sso-result';
/**
 * The outcome the SSO landing left in the address (?sso=signed-in|linked|confirmed or ?sso_error=<code>): taken out
 * of the address at once and returned as { ok, what } / { ok: false, code, message }; null when there is none.
 */
export function takeSsoResult(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return null;
  try {
    const params = new URLSearchParams(win.location.search);
    const what = params.get('sso');
    const code = params.get('sso_error');
    if (!what && !code) return null;
    params.delete('sso'); params.delete('sso_error');
    const query = params.toString();
    win.history.replaceState({}, '', `${win.location.pathname}${query ? `?${query}` : ''}${win.location.hash || ''}`);
    if (code) return { ok: false, code: /^[a-z_]{1,40}$/.test(code) ? code : 'provider', message: ssoMessage(code) };
    return ['signed-in', 'linked', 'confirmed'].includes(what) ? { ok: true, what } : null;
  } catch {
    return null;
  }
}
/**
 * Keep the outcome for the Settings dialog that shows it once the app has loaded. It crosses the page load in
 * sessionStorage (main.jsx stores it before the app renders), is taken out of there at the first read, and then
 * stays for this page's lifetime: Settings may mount more than once, a reload forgets it.
 */
let ssoOutcome;   // undefined: not read yet
export function rememberSsoResult(result) {
  if (!result) return;
  ssoOutcome = result;
  try { sessionStorage.setItem(SSO_RESULT_KEY, JSON.stringify(result)); } catch { /* no storage: this page still has it */ }
}
export function recallSsoResult() {
  try {
    const raw = sessionStorage.getItem(SSO_RESULT_KEY);
    if (raw !== null) {
      sessionStorage.removeItem(SSO_RESULT_KEY);
      ssoOutcome = JSON.parse(raw);
    }
  } catch { /* no storage, or not ours: what this page remembers stands */ }
  if (ssoOutcome === undefined) ssoOutcome = null;
  return ssoOutcome;
}

let ssoCueTaken = false;
/** True once per page load when a round-trip that Settings > General started has come back (the dialog opens for it). */
export function takeSsoSettingsCue() {
  if (ssoCueTaken || !recallSsoResult()) return false;
  ssoCueTaken = true;
  return true;
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

/** A request to the account's server as the auth calls make it (the linked home server from the desktop, with the step-up retry; the backend in a browser). */
export const request = (method, path, body) => call(method, path, body);

/** Confirm the password for the next administrative action (desktop over a device token). */
export const stepUp = (password) => call('POST', '/api/auth/step-up', { password }, { retried: true });

export const me = () => call('GET', '/api/auth/me');
export const login = (username, password) => call('POST', '/api/auth/login', { username, password });
export const logout = () => call('POST', '/api/auth/logout');
export const setup = ({ setupCode, username, password, displayName }) => call('POST', '/api/auth/setup', { setupCode, username, password, displayName });
export const changePassword = (currentPassword, newPassword) => call('POST', '/api/auth/password', { currentPassword, newPassword });
export const updateProfile = (displayName) => call('POST', '/api/auth/profile', { displayName });

/** Where the page goes next (one seam for the two navigations below; tests replace its functions). */
export const navigation = {
  assign: (url) => window.location.assign(url),
  reload: () => window.location.reload(),
};

/** Single sign-on round-trips: the server answers where to go (the identity provider) and the browser goes there. */
export const sso = {
  /** purpose: 'login' | 'link' (with the account's password) | 'confirm' (a fresh sign-in, before a first password). */
  async begin(purpose = 'login', password) {
    const answer = await call('POST', '/api/auth/sso/begin', { purpose, ...(password ? { password } : {}) });
    navigation.assign(answer.url);
    return answer;
  },
  unlink: (password) => call('POST', '/api/auth/sso/unlink', { password }),
};

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
  createUser: ({ username, password, displayName, role, ssoEmail }) => call('POST', '/api/admin/users', { username, password, displayName, role, ...(ssoEmail ? { ssoEmail } : {}) }),
  ssoUnlink: (id) => call('POST', `/api/admin/users/${encodeURIComponent(id)}/sso`, { action: 'unlink' }),
  ssoInvite: (id, email) => call('POST', `/api/admin/users/${encodeURIComponent(id)}/sso`, { action: 'invite', email: email || '' }),
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
  let onward = null;
  try { onward = (await logout())?.ssoLogoutUrl || null; } catch { /* the cookie is cleared server-side either way on the next load */ }
  // an SSO session may end at the identity provider too (JACARIUM_OIDC_END_SESSION): it sends the browser back here
  if (onward) navigation.assign(onward); else navigation.reload();
}
