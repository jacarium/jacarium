/**
 * Central server client: the team features (shared documents, boards,
 * workflows, presence, chat, games) through the central server that comes
 * WITH the home server.
 *
 * There is nothing to configure. The home server fronts the central server
 * at `<home server origin>/central` (deploy/Caddyfile), announces it in its
 * capabilities (`central: { provided, path, accountSignIn }`) and mints a
 * short-lived account ticket for a signed-in user (POST
 * /api/auth/central-ticket). The app derives the URL from that - `<page
 * origin>/central` in a browser, `<home server URL>/central` on a linked
 * desktop profile - and presents the ticket (X-Account-Ticket on REST,
 * `account_ticket` on the socket). A signed-out browser or an unlinked
 * desktop profile has no central server: getCentralServerUrl() is '' and
 * the pages show a "sign in / link this profile" hint
 * (src/utils/centralAvailability.js) instead of errors.
 */

import { updateDocument } from './documents';
import { updateWorkflow } from './workflows';
import { updateInstance } from './taskwarriorInstances';
import { generateUUID } from './uuid';
import { getBackendInfo, platformReady } from './platform';

// Cache machine ID
let cachedMachineId = null;

/**
 * Fetch with timeout
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 10000)
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  // On a linked desktop the central server (/central/*) is reached through
  // the main process - the home server's pinned certificate, no Sec-Fetch
  // headers, no second pin (electron/home-server.cjs).
  const provided = providedCentralCache;
  if (provided && provided.desktop && String(url).startsWith(provided.url)) {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    const pathName = String(url).slice(provided.homeServerUrl.length);
    const answer = await api.homeServerFetch(pathName, { method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    if (!answer || answer.status === 0) {
      throw new TypeError(`Failed to fetch: ${(() => { try { return JSON.parse(answer?.text || '{}').error; } catch { return ''; } })() || 'the home server did not answer'}`);
    }
    const text = answer.text || '';
    return {
      ok: !!answer.ok,
      status: answer.status,
      headers: { get: () => null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout - central server not reachable');
    }
    throw error;
  }
}

// ============================================================================
// The central server the home server provides
// ============================================================================

let providedCentralCache;          // undefined = not resolved; null = none
let providedCentralPromise = null;
// why there is none, when there is none (centralAvailability.js words it):
// 'signed-out' (browser without an account) | 'not-linked' (desktop profile)
// | 'no-central' (the home server provides none) | 'no-account-sign-in'
// (provided, but the home server holds no ticket key)
let providedCentralReason = null;

/**
 * { url, path, desktop, homeServerUrl } when this app can use a central
 * server - the home server provides one, accepts account sign-in for it,
 * and this app is signed in (browser) or linked (desktop) - else null.
 * Resolved once per page load (resetIdentityCache() forgets it).
 */
export async function providedCentralServer() {
  if (providedCentralCache !== undefined) return providedCentralCache;
  if (!providedCentralPromise) {
    providedCentralPromise = (async () => {
      let result = null;
      let reason = null;
      try {
        const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
        if (api?.homeServerStatus) {
          const status = await api.homeServerStatus();
          if (!(status?.linked && status.url && api.homeServerFetch)) {
            reason = 'not-linked';
          } else {
            const answer = await api.homeServerFetch('/api/version', { method: 'GET', headers: {} });
            let body = null;
            try { body = answer?.ok ? JSON.parse(answer.text) : null; } catch { body = null; }
            const central = body?.capabilities?.central;
            if (!central?.provided) reason = 'no-central';
            else if (!central.accountSignIn) reason = 'no-account-sign-in';
            else {
              const base = String(status.url).replace(/\/+$/, '');
              const centralPath = typeof central.path === 'string' ? central.path : '/central';
              result = { url: `${base}${centralPath}`, path: centralPath, desktop: true, homeServerUrl: base };
            }
          }
        } else if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
          try { await platformReady(); } catch { /* no backend answer */ }
          const central = getBackendInfo()?.capabilities?.central;
          if (!central?.provided) reason = 'no-central';
          else if (!central.accountSignIn) reason = 'no-account-sign-in';
          else if (!(await accountIdentity())) reason = 'signed-out';
          else {
            const centralPath = typeof central.path === 'string' ? central.path : '/central';
            result = { url: `${location.origin}${centralPath}`, path: centralPath, desktop: false, homeServerUrl: location.origin };
          }
        } else {
          reason = 'no-central';
        }
      } catch (error) {
        console.warn('[cloudCentralSync] provided central server unknown:', error.message);
        reason = reason || 'no-central';
      }
      providedCentralCache = result;
      providedCentralReason = result ? null : reason;
      if (result) console.log('[cloudCentralSync] Central server provided by the home server:', result.url);
      else console.log(`[cloudCentralSync] No central server (${reason})`);
      return result;
    })().finally(() => { providedCentralPromise = null; });
  }
  return providedCentralPromise;
}

/** The provided server as resolved so far (null before providedCentralServer() answered). */
export function providedCentralServerSync() {
  return providedCentralCache || null;
}

/** Why there is no central server ('' while unknown or when there is one). */
export function centralUnavailableReason() {
  return providedCentralCache === undefined ? '' : (providedCentralReason || '');
}

/**
 * The central server URL in use: the one the home server provides, or ''
 * when this app has none (signed out, not linked, none provided). Known
 * once providedCentralServer() has answered; '' before.
 */
export function getCentralServerUrl() {
  return providedCentralCache ? providedCentralCache.url : '';
}

/**
 * Where Socket.IO connects for a server URL: the origin, and the engine
 * path under the URL's own path (`https://pi.console/central` ->
 * path `/central/socket.io`, the proxy strips the prefix).
 */
export function socketTargetFor(serverUrl) {
  const u = new URL(String(serverUrl));
  const prefix = u.pathname.replace(/\/+$/, '');
  return { url: u.origin, path: `${prefix}/socket.io` };
}

// ============================================================================
// Account identity: one cloud identity for every device of an account
// ============================================================================
//
// Signed in to a home server (the browser deployment's accounts, or a
// desktop profile linked to it), the identity on the central server IS the
// account: `<username>@account-<id>`. It is the same in every browser and
// desktop profile of the account, and the account ticket is its proof -
// nothing is paired, nothing is stored.

let accountIdentityCache;        // undefined = not resolved yet; null = no account

/** The central-server identity of an account: `<username>@account-<id prefix>`. */
export function accountMachineIdFor(user) {
  const tag = String(user.id).replace(/[^0-9a-zA-Z]/g, '').slice(0, 12).toLowerCase();
  return `${user.username}@account-${tag}`;
}

/** True when this identity is an account's (the same on every device of it). */
export function isAccountIdentity(machineId) {
  return /@account-[0-9a-z]+$/.test(String(machineId || ''));
}

/**
 * The signed-in account, when there is one: { userId, username,
 * displayName, machineId } - from the backend's capabilities in a browser,
 * from the home-server link (electron/home-server.cjs) on the desktop.
 * Resolved once per page load.
 */
export async function accountIdentity() {
  if (accountIdentityCache !== undefined) return accountIdentityCache;
  let user = null;
  try {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (api?.homeServerStatus) {
      const status = await api.homeServerStatus();
      if (status?.linked) {
        if (status.userId) {
          user = { id: status.userId, username: status.username, displayName: status.displayName || '' };
        } else if (api.homeServerFetch) {
          // a link made before the record carried the account: ask the server
          const answer = await api.homeServerFetch('/api/auth/me', { method: 'GET', headers: {} });
          let body = null;
          try { body = answer?.ok ? JSON.parse(answer.text) : null; } catch { body = null; }
          if (body?.user?.id) user = body.user;
        }
      }
    } else {
      try { await platformReady(); } catch { /* no backend answer: no account */ }
      const auth = getBackendInfo()?.auth;
      if (auth?.mode === 'accounts' && auth.user?.id) user = auth.user;
    }
  } catch (error) {
    console.warn('[cloudCentralSync] account identity unavailable:', error.message);
  }
  accountIdentityCache = user
    ? { userId: user.id, username: user.username, displayName: user.displayName || '', machineId: accountMachineIdFor(user) }
    : null;
  return accountIdentityCache;
}

/** Forget what was resolved (after sign-in/out or a link change; tests). */
export function resetIdentityCache() {
  accountIdentityCache = undefined;
  cachedMachineId = null;
  providedCentralCache = undefined;
  providedCentralPromise = null;
  providedCentralReason = null;
  accountTicketCache = null;
  accountTicketPromise = null;
}

// ============================================================================
// Account tickets: how the central server recognises this app
// ============================================================================
//
// POST /api/auth/central-ticket on the home server (session cookie in a
// browser, device token through the main process on the desktop) answers a
// short-lived signed ticket naming the account's identity on the central
// server; it goes in the X-Account-Ticket header (REST) and as
// `account_ticket` in the socket's 'authenticate' payload. Renewed before it
// runs out; never stored.

let accountTicketCache = null;   // { ticket, expiresAt (s), identity }
let accountTicketPromise = null;
const TICKET_RENEW_MARGIN_SECONDS = 90;

/** A current ticket of the signed-in account (cached until shortly before it expires). */
export async function accountTicket() {
  const now = Date.now() / 1000;
  if (accountTicketCache && accountTicketCache.expiresAt - now > TICKET_RENEW_MARGIN_SECONDS) return accountTicketCache.ticket;
  if (!accountTicketPromise) {
    accountTicketPromise = (async () => {
      const answer = await accountRequest('/api/auth/central-ticket', { method: 'POST', body: '{}' });
      const body = await answer.json();
      if (!answer.ok || !body?.ticket) {
        const error = new Error(body?.error || `The home server issued no central-server ticket (HTTP ${answer.status})`);
        error.code = body?.code || 'ACCOUNT_TICKET_UNAVAILABLE';
        throw error;
      }
      accountTicketCache = { ticket: body.ticket, expiresAt: Number(body.expiresAt) || (now + 60), identity: body.identity };
      return body.ticket;
    })().finally(() => { accountTicketPromise = null; });
  }
  return accountTicketPromise;
}

/**
 * What authenticates this app at the central server: { kind: 'ticket',
 * value }. Throws (code NO_CENTRAL_SERVER) when this app has none.
 */
export async function centralCredentials(serverUrl = getCentralServerUrl()) {
  const provided = await providedCentralServer();
  if (!provided || !serverUrl) {
    throw noCentralError();
  }
  return { kind: 'ticket', value: await accountTicket() };
}

/** A request to the home server as the account (session cookie in a browser, device token on the desktop). */
async function accountRequest(path, { method = 'GET', body } = {}) {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (api?.homeServerFetch) {
    const answer = await api.homeServerFetch(path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body });
    return { ok: !!answer?.ok, status: answer?.status, json: async () => { try { return JSON.parse(answer.text); } catch { return null; } } };
  }
  const { getBackendUrl, apiFetch } = await import('./backendUrl');
  const base = await getBackendUrl();
  const response = await apiFetch(`${base}${path}`, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body, credentials: 'include' });
  return { ok: response.ok, status: response.status, json: async () => { try { return await response.json(); } catch { return null; } } };
}

/**
 * The auth header for requests to the central server (X-Account-Ticket).
 */
export async function getCentralAuthHeaders(serverUrl = getCentralServerUrl()) {
  const credentials = await centralCredentials(serverUrl);
  return { 'X-Account-Ticket': credentials.value };
}

/** The error every central-server call throws when this app has no central server. */
export function noCentralError() {
  const error = new Error('No central server: sign in to a home server (or link this profile to one) to use the team features.');
  error.code = 'NO_CENTRAL_SERVER';
  return error;
}

// ============================================================================
// Identity (machine_id and display name)
// ============================================================================
//
// The desktop app is identified as `username@hostname` from the OS (the
// Electron main process), optionally overridden by MACHINE_ID in
// development / testing builds; signed in to a home server (browser) or
// linked to one (desktop) the identity is the account's (above), which is
// what the central server knows. A browser without an account has no OS
// identity: `browser-<8 random hex>@<host>` is generated once and kept in
// localStorage. It never changes afterwards - documents, boards and
// workflows are owned by this id on every teammate's copy, so renaming it
// would orphan them. What the user can change is the display name, which is
// only a label shown to others (chat, cursors, challenges, the
// connected-users list).

const BROWSER_MACHINE_ID_KEY = 'cloudBrowserMachineId';
const DISPLAY_NAME_KEY = 'cloudDisplayName';
export const BROWSER_MACHINE_ID_RE = /^browser-[0-9a-f]{8}@[a-z0-9][a-z0-9.-]{0,62}$/;
export const DISPLAY_NAME_MAX_LENGTH = 32;
// Letters (any script), digits, space and . _ - ; no "@" (it would read
// like a machine_id), no control characters.
const DISPLAY_NAME_RE = /^[\p{L}\p{N} ._-]+$/u;
let sessionBrowserMachineId = null; // when storage is unavailable: unique for this page load

function safeStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeStorageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    return true;
  } catch { return false; }
}

function randomHex8() {
  try {
    const c = globalThis.crypto;
    if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 8);
    if (c?.getRandomValues) {
      return Array.from(c.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fall through */ }
  return Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
}

/**
 * The host part of a browser identity: the container's hostname as the
 * backend reports it (GET /api/capabilities) when the deployment gave it a
 * name (deploy-podman.sh does; a bare container id is 12 hex digits and
 * says nothing), otherwise the host in the address bar, otherwise
 * "browser". A label only - the random part is what makes the id unique.
 */
export function browserHostLabel(reportedHostname = getBackendInfo()?.hostname, locationHostname = globalThis.location?.hostname) {
  for (const candidate of [reportedHostname, locationHostname]) {
    if (typeof candidate !== 'string') continue;
    const label = candidate.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 63);
    if (label && !/^[0-9a-f]{12}$/.test(label)) return label;
  }
  return 'browser';
}

async function browserMachineId() {
  const stored = safeStorageGet(BROWSER_MACHINE_ID_KEY);
  if (stored && BROWSER_MACHINE_ID_RE.test(stored)) return stored;
  if (sessionBrowserMachineId) return sessionBrowserMachineId;
  // Let the startup capabilities probe finish so the host part can be the
  // container's name (platformReady() is null when startup never began it).
  try { await platformReady(); } catch { /* no backend: use the address bar */ }
  const id = `browser-${randomHex8()}@${browserHostLabel()}`;
  if (!safeStorageSet(BROWSER_MACHINE_ID_KEY, id)) {
    console.warn('[getMachineId] localStorage unavailable - this browser identity lasts for this session only');
    sessionBrowserMachineId = id;
  }
  console.log('[getMachineId] ✓ Generated browser identity:', id);
  return id;
}

/**
 * Get machine ID: the OS identity under Electron, the per-browser identity
 * otherwise (see above). Never "unknown@unknown".
 */
export async function getMachineId() {
  // Check for environment variable override (for multi-user testing)
  if (window.electronAPI?.getMachineIdOverride) {
    const override = await window.electronAPI.getMachineIdOverride();
    if (override) {
      console.log('[getMachineId] ✓ Using environment variable override:', override);
      return override;
    }
  }

  // Check cache
  if (cachedMachineId) {
    return cachedMachineId;
  }

  // Signed in to a home server: the identity is the account's
  const account = await accountIdentity();
  if (account) {
    cachedMachineId = account.machineId;
    console.log('[getMachineId] ✓ Using the account identity:', cachedMachineId);
    return cachedMachineId;
  }

  if (window.electronAPI) {
    // Generate from username/hostname
    const username = await window.electronAPI.getUsername();
    const hostname = await window.electronAPI.getHostname();
    cachedMachineId = `${username}@${hostname}`;
  } else {
    cachedMachineId = await browserMachineId();
  }

  return cachedMachineId;
}

/** True when this app's identity is a generated per-browser one. */
export function isBrowserIdentity(machineId) {
  return BROWSER_MACHINE_ID_RE.test(machineId || '');
}

/**
 * Check a display name the user typed. Returns { ok, value, error }: value
 * is the cleaned name ('' means "use the default", the name part of the
 * machine_id).
 */
export function validateDisplayName(name) {
  const value = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return { ok: true, value: '', error: null };
  if (value.length > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, value, error: `Use at most ${DISPLAY_NAME_MAX_LENGTH} characters` };
  }
  if (!DISPLAY_NAME_RE.test(value)) {
    return { ok: false, value, error: 'Use letters, digits, spaces, dots, underscores or dashes (no "@")' };
  }
  return { ok: true, value, error: null };
}

/** The display name the user chose for this browser ('' when none). */
export function getStoredDisplayName() {
  const { ok, value } = validateDisplayName(safeStorageGet(DISPLAY_NAME_KEY));
  return ok ? value : '';
}

/** Window event fired after setDisplayName() (useDisplayName re-reads). */
export const DISPLAY_NAME_EVENT = 'jacarium:display-name';

/**
 * Store (or with '' clear) the display name of this browser identity.
 * Throws on an invalid name. Desktop identities keep their OS username.
 */
export function setDisplayName(name) {
  const { ok, value, error } = validateDisplayName(name);
  if (!ok) throw new Error(error);
  if (!safeStorageSet(DISPLAY_NAME_KEY, value || null)) {
    throw new Error('Could not save the name: browser storage is unavailable');
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof Event !== 'undefined') {
      window.dispatchEvent(new Event(DISPLAY_NAME_EVENT));
    }
  } catch { /* no DOM events here (tests) */ }
  return value;
}

/**
 * The name to show for ANOTHER user: the display name the server reported
 * for that machine_id (the `names` map of the connected-users event), else
 * the user part of the id - the desktop's OS username, a browser's
 * generated name.
 */
export function displayNameFor(machineId, names = {}) {
  const id = String(machineId || '');
  const reported = names && typeof names === 'object' ? names[id] : undefined;
  return (typeof reported === 'string' && reported) || id.split('@')[0] || id;
}

/**
 * The name shown to teammates: the OS username on the desktop (the part of
 * the machine_id before "@", as always), the chosen display name in a
 * browser, or the generated name part when none was chosen.
 */
export async function getDisplayName() {
  const machineId = await getMachineId();
  const fallback = machineId.split('@')[0];
  const account = await accountIdentity();
  if (account && account.machineId === machineId) return account.displayName || fallback;
  if (!isBrowserIdentity(machineId)) return fallback;
  return getStoredDisplayName() || fallback;
}

/**
 * Upload document to central server
 */
export async function uploadDocumentToCentral(document) {
  const serverUrl = getCentralServerUrl();
  if (!serverUrl) {
    throw noCentralError();
  }

  const machineId = await getMachineId();
  const cloudLastUpdated = Date.now();

  // Generate cloudDocumentId if this is the first upload
  const cloudDocumentId = document.cloudDocumentId || generateUUID();

  // Update document with cloud metadata
  const cloudDocument = {
    ...document,
    inCloud: true,
    ownerId: document.ownerId || machineId,
    cloudDocumentId,
    cloudLastUpdated,
    updatedAt: new Date()
  };

  console.log('[cloudCentralSync] Uploading document with cloud metadata:', {
    id: cloudDocument.id,
    title: cloudDocument.title,
    inCloud: cloudDocument.inCloud,
    ownerId: cloudDocument.ownerId,
    machineId
  });

  // Update locally first
  await updateDocument(document.id, cloudDocument);

  console.log('[cloudCentralSync] Document updated in IndexedDB with cloud metadata');

  // Try WebSocket first, fallback to HTTP
  try {
    const { isWebSocketConnected, uploadDocumentViaWebSocket } = await import('./cloudWebSocket');

    if (isWebSocketConnected()) {
      console.log('[cloudCentralSync] Using WebSocket for upload');
      const result = await uploadDocumentViaWebSocket(cloudDocument);
      return result;
    } else {
      console.log('[cloudCentralSync] WebSocket not connected, falling back to HTTP');
    }
  } catch (error) {
    console.log('[cloudCentralSync] WebSocket upload failed, falling back to HTTP:', error.message);
  }

  // Fallback to HTTP
  const response = await fetchWithTimeout(`${serverUrl}/api/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await getCentralAuthHeaders(serverUrl))
    },
    body: JSON.stringify({
      machine_id: machineId,
      document: cloudDocument
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload document: ${error}`);
  }

  return await response.json();
}

/**
 * Upload workflow to central server
 */
export async function uploadWorkflowToCentral(workflow) {
  const serverUrl = getCentralServerUrl();
  if (!serverUrl) {
    throw noCentralError();
  }

  const machineId = await getMachineId();
  const cloudLastUpdated = Date.now();

  // Update workflow with cloud metadata
  const cloudWorkflow = {
    ...workflow,
    inCloud: true,
    ownerId: workflow.ownerId || machineId,
    cloudLastUpdated
  };

  // Update locally first
  await updateWorkflow(workflow.id, cloudWorkflow);

  // Try WebSocket first, fallback to HTTP
  try {
    const { isWebSocketConnected, uploadWorkflowViaWebSocket } = await import('./cloudWebSocket');

    if (isWebSocketConnected()) {
      console.log('[cloudCentralSync] Using WebSocket for workflow upload');
      const result = await uploadWorkflowViaWebSocket(cloudWorkflow);
      return result;
    }
  } catch (error) {
    console.log('[cloudCentralSync] WebSocket workflow upload failed, falling back to HTTP:', error.message);
  }

  // Fallback to HTTP
  const response = await fetchWithTimeout(`${serverUrl}/api/workflows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await getCentralAuthHeaders(serverUrl))
    },
    body: JSON.stringify({
      machine_id: machineId,
      workflow: cloudWorkflow
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload workflow: ${error}`);
  }

  return await response.json();
}

/**
 * Upload task instance to central server
 */
export async function uploadTaskInstanceToCentral(instance) {
  const serverUrl = getCentralServerUrl();
  if (!serverUrl) {
    throw noCentralError();
  }

  const machineId = await getMachineId();
  const cloudLastUpdated = Date.now();

  // Generate cloudDocumentId if this is the first upload
  const cloudDocumentId = instance.cloudDocumentId || generateUUID();

  // Update instance with cloud metadata
  const cloudInstance = {
    ...instance,
    inCloud: true,
    ownerId: instance.ownerId || machineId,
    cloudDocumentId,
    cloudLastUpdated
  };

  console.log('[cloudCentralSync] Uploading task instance with cloud metadata:', {
    id: cloudInstance.id,
    name: cloudInstance.name,
    inCloud: cloudInstance.inCloud,
    ownerId: cloudInstance.ownerId,
    machineId
  });

  // Update locally first
  await updateInstance(instance.id, {
    inCloud: 1,
    ownerId: cloudInstance.ownerId,
    cloudDocumentId,
    cloudLastUpdated
  });

  console.log('[cloudCentralSync] Task instance updated in IndexedDB with cloud metadata');

  // Try WebSocket first, fallback to HTTP
  try {
    const { isWebSocketConnected, uploadTaskInstanceViaWebSocket } = await import('./cloudWebSocket');

    if (isWebSocketConnected() && uploadTaskInstanceViaWebSocket) {
      console.log('[cloudCentralSync] Using WebSocket for task instance upload');
      const result = await uploadTaskInstanceViaWebSocket(cloudInstance);
      return result;
    }
  } catch (error) {
    console.log('[cloudCentralSync] WebSocket task instance upload failed, falling back to HTTP:', error.message);
  }

  // Fallback to HTTP
  const response = await fetchWithTimeout(`${serverUrl}/api/taskwarrior/instances`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await getCentralAuthHeaders(serverUrl))
    },
    body: JSON.stringify({
      machine_id: machineId,
      instance: cloudInstance
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload task instance: ${error}`);
  }

  return await response.json();
}

/**
 * Poll central server for pending documents
 */
export async function pollCentralForDocuments() {
  const serverUrl = getCentralServerUrl();
  console.log('[pollCentralForDocuments] Central server URL:', serverUrl);

  if (!serverUrl) {
    console.log('[pollCentralForDocuments] No server URL configured');
    return { documents: [], workflows: [] };
  }

  const machineId = await getMachineId();
  console.log('[pollCentralForDocuments] Using machine ID:', machineId);

  const pollUrl = `${serverUrl}/api/pending?machine_id=${encodeURIComponent(machineId)}`;
  console.log('[pollCentralForDocuments] Polling URL:', pollUrl);

  const response = await fetchWithTimeout(pollUrl, {
    headers: await getCentralAuthHeaders(serverUrl)
  });

  if (!response.ok) {
    console.error('[pollCentralForDocuments] Poll failed with status:', response.status);
    throw new Error(`Poll failed: ${response.status}`);
  }

  const data = await response.json();
  console.log('[pollCentralForDocuments] Server response:', {
    documents: data.documents?.length || 0,
    workflows: data.workflows?.length || 0,
    documentsDetails: data.documents?.map(d => ({ title: d.title, ownerId: d.ownerId }))
  });

  return data;
}

/**
 * Process incoming document from central server
 */
export async function receiveDocumentFromCentral(incomingDoc) {
  // getDocumentsMetadata: this function only looks up existing docs by
  // ownerId/title and compares cloud timestamps - it never reads their
  // content. The removal path spreads the metadata object into
  // updateDocument(), which is safe because the `content` key is absent
  // (not undefined) and updateDocument merges over the stored record.
  const { getDocumentsMetadata, createDocument, updateDocument, deleteDocument } = await import('./documents');
  const machineId = await getMachineId();

  // Check if this is a removal message
  if (incomingDoc._type === 'removal') {
    console.log('[CentralSync] Receiving document removal:', {
      title: incomingDoc.title,
      ownerId: incomingDoc.ownerId
    });

    // Find existing document by ownerId and title
    const allDocs = await getDocumentsMetadata();
    const existing = allDocs.find(d =>
      d.ownerId === incomingDoc.ownerId &&
      d.title === incomingDoc.title
    );

    if (existing && existing.inCloud) {
      // Check if we're the owner
      const isOwner = existing.ownerId === machineId;

      if (isOwner) {
        // We're the owner - just clear cloud metadata
        const localDoc = {
          ...existing,
          inCloud: false,
          ownerId: undefined,
          cloudLastUpdated: undefined
        };
        await updateDocument(existing.id, localDoc);
        console.log('[CentralSync] Removed cloud metadata from owned document');
        return { action: 'removed_metadata', documentId: existing.id };
      } else {
        // We're not the owner - delete the document
        await deleteDocument(existing.id);
        console.log('[CentralSync] Deleted cloud document from central server');
        return { action: 'deleted', documentId: existing.id };
      }
    }
    return { action: 'ignored', reason: 'Document not found or not in cloud' };
  }

  // Regular document update
  console.log('[receiveDocumentFromCentral] Receiving document:', {
    title: incomingDoc.title,
    ownerId: incomingDoc.ownerId,
    inCloud: incomingDoc.inCloud,
    cloudLastUpdated: incomingDoc.cloudLastUpdated
  });

  // Find existing document by ownerId and title
  const allDocs = await getDocumentsMetadata();
  console.log('[receiveDocumentFromCentral] Searching in', allDocs.length, 'local documents');

  const existing = allDocs.find(d =>
    d.ownerId === incomingDoc.ownerId &&
    d.title === incomingDoc.title
  );

  if (existing) {
    console.log('[receiveDocumentFromCentral] Found existing document:', {
      id: existing.id,
      title: existing.title,
      existingTime: existing.cloudLastUpdated,
      incomingTime: incomingDoc.cloudLastUpdated
    });

    // Update if newer
    const existingTime = existing.cloudLastUpdated || 0;
    const incomingTime = incomingDoc.cloudLastUpdated || 0;

    if (existing.ownerId === incomingDoc.ownerId && incomingTime > existingTime) {
      const updatedDoc = {
        ...incomingDoc,
        id: existing.id,
        inCloud: true,
        updatedAt: new Date()
      };
      console.log('[receiveDocumentFromCentral] Updating document with newer version');
      await updateDocument(existing.id, updatedDoc);
      console.log('[receiveDocumentFromCentral] ✓ Document updated successfully');
      return { action: 'updated', documentId: existing.id };
    }
    console.log('[receiveDocumentFromCentral] ✗ Rejected: Owner mismatch or older timestamp');
    return { action: 'rejected', reason: 'Owner mismatch or older timestamp' };
  } else {
    // Create new
    console.log('[receiveDocumentFromCentral] No existing document found, creating new');
    const newDocData = {
      ...incomingDoc,
      inCloud: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    console.log('[receiveDocumentFromCentral] Creating document:', {
      title: newDocData.title,
      ownerId: newDocData.ownerId,
      inCloud: newDocData.inCloud
    });
    const newDocId = await createDocument(newDocData);
    console.log('[receiveDocumentFromCentral] ✓ Document created with ID:', newDocId);
    return { action: 'created', documentId: newDocId };
  }
}

/**
 * Process incoming workflow from central server
 */
export async function receiveWorkflowFromCentral(incomingWorkflow) {
  const { getWorkflows, createWorkflow, updateWorkflow, deleteWorkflow } = await import('./workflows');
  const machineId = await getMachineId();

  // Check if this is a removal message
  if (incomingWorkflow._type === 'removal') {
    console.log('[CentralSync] Receiving workflow removal:', {
      title: incomingWorkflow.title,
      ownerId: incomingWorkflow.ownerId
    });

    // Find existing workflow by ownerId and title
    const allWorkflows = await getWorkflows();
    const existing = allWorkflows.find(w =>
      w.ownerId === incomingWorkflow.ownerId &&
      w.title === incomingWorkflow.title
    );

    if (existing && existing.inCloud) {
      // Check if we're the owner
      const isOwner = existing.ownerId === machineId;

      if (isOwner) {
        // We're the owner - just clear cloud metadata
        const localWorkflow = {
          ...existing,
          inCloud: false,
          ownerId: undefined,
          cloudLastUpdated: undefined
        };
        await updateWorkflow(existing.id, localWorkflow);
        console.log('[CentralSync] Removed cloud metadata from owned workflow');
        return { action: 'removed_metadata', workflowId: existing.id };
      } else {
        // We're not the owner - delete the workflow
        await deleteWorkflow(existing.id);
        console.log('[CentralSync] Deleted cloud workflow from central server');
        return { action: 'deleted', workflowId: existing.id };
      }
    }
    return { action: 'ignored', reason: 'Workflow not found or not in cloud' };
  }

  // Regular workflow update
  console.log('[CentralSync] Receiving workflow:', {
    title: incomingWorkflow.title,
    ownerId: incomingWorkflow.ownerId
  });

  // Find existing workflow by ownerId and title
  const allWorkflows = await getWorkflows();
  const existing = allWorkflows.find(w =>
    w.ownerId === incomingWorkflow.ownerId &&
    w.title === incomingWorkflow.title
  );

  if (existing) {
    // Update if newer
    const existingTime = existing.cloudLastUpdated || 0;
    const incomingTime = incomingWorkflow.cloudLastUpdated || 0;

    if (existing.ownerId === incomingWorkflow.ownerId && incomingTime > existingTime) {
      const updatedWorkflow = {
        ...incomingWorkflow,
        id: existing.id,
        inCloud: true
      };
      await updateWorkflow(existing.id, updatedWorkflow);
      return { action: 'updated', workflowId: existing.id };
    }
    return { action: 'rejected', reason: 'Owner mismatch or older timestamp' };
  } else {
    // Create new
    const newWorkflowData = {
      ...incomingWorkflow,
      inCloud: true
    };
    const newWorkflowId = await createWorkflow(newWorkflowData);
    return { action: 'created', workflowId: newWorkflowId };
  }
}

/**
 * Remove document from central server
 */
export async function removeDocumentFromCentral(document) {
  const serverUrl = getCentralServerUrl();
  if (!serverUrl) {
    throw noCentralError();
  }

  const machineId = await getMachineId();

  // Security check
  if (document.ownerId && document.ownerId !== machineId) {
    throw new Error('Permission denied: Only the document owner can remove it');
  }

  // Try WebSocket first, fallback to HTTP
  try {
    const { isWebSocketConnected, removeDocumentViaWebSocket } = await import('./cloudWebSocket');

    if (isWebSocketConnected()) {
      console.log('[cloudCentralSync] Using WebSocket for document removal');
      await removeDocumentViaWebSocket(document.ownerId, document.title);

      // Update locally
      const localDocument = {
        ...document,
        inCloud: false,
        ownerId: undefined,
        cloudLastUpdated: undefined
      };
      await updateDocument(document.id, localDocument);

      return { success: true };
    }
  } catch (error) {
    console.log('[cloudCentralSync] WebSocket removal failed, falling back to HTTP:', error.message);
  }

  // Fallback to HTTP
  const response = await fetchWithTimeout(`${serverUrl}/api/documents/${document.ownerId}/${encodeURIComponent(document.title)}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(await getCentralAuthHeaders(serverUrl))
    },
    body: JSON.stringify({ machine_id: machineId })
  });

  if (!response.ok) {
    throw new Error('Failed to remove document from central server');
  }

  // Update locally
  const localDocument = {
    ...document,
    inCloud: false,
    ownerId: undefined,
    cloudLastUpdated: undefined
  };
  await updateDocument(document.id, localDocument);

  return { success: true };
}

/**
 * Remove workflow from central server
 */
export async function removeWorkflowFromCentral(workflow) {
  const serverUrl = getCentralServerUrl();
  if (!serverUrl) {
    throw noCentralError();
  }

  const machineId = await getMachineId();

  // Security check
  if (workflow.ownerId && workflow.ownerId !== machineId) {
    throw new Error('Permission denied: Only the workflow owner can remove it');
  }

  // Try WebSocket first, fallback to HTTP
  try {
    const { isWebSocketConnected, removeWorkflowViaWebSocket } = await import('./cloudWebSocket');

    if (isWebSocketConnected()) {
      console.log('[cloudCentralSync] Using WebSocket for workflow removal');
      await removeWorkflowViaWebSocket(workflow.ownerId, workflow.title);

      // Update locally
      const localWorkflow = {
        ...workflow,
        inCloud: false,
        ownerId: undefined,
        cloudLastUpdated: undefined
      };
      await updateWorkflow(workflow.id, localWorkflow);

      return { success: true };
    }
  } catch (error) {
    console.log('[cloudCentralSync] WebSocket workflow removal failed, falling back to HTTP:', error.message);
  }

  // Fallback to HTTP
  const response = await fetchWithTimeout(`${serverUrl}/api/workflows/${workflow.ownerId}/${encodeURIComponent(workflow.title)}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(await getCentralAuthHeaders(serverUrl))
    },
    body: JSON.stringify({ machine_id: machineId })
  });

  if (!response.ok) {
    throw new Error('Failed to remove workflow from central server');
  }

  // Update locally
  const localWorkflow = {
    ...workflow,
    inCloud: false,
    ownerId: undefined,
    cloudLastUpdated: undefined
  };
  await updateWorkflow(workflow.id, localWorkflow);

  return { success: true };
}
