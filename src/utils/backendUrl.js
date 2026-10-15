/**
 * Backend URL Utility
 * Provides a consistent way to get the backend server URL, and to attach
 * the per-launch auth token the backend requires on every request.
 */

let cachedPort = null;

// The backend requires a shared-secret token (X-App-Token header) on every
// request. The token is generated fresh per launch by the Electron main
// process and handed to this renderer over the isolated contextBridge/IPC
// channel (window.electronAPI.getAppToken) -- never via a plain `window`
// global that arbitrary loaded web content could read. We fetch it once and
// cache the in-flight promise so concurrent callers share one IPC round trip.
let tokenPromise = null;

/**
 * Get the backend base URL
 * In Electron: Uses the PORT environment variable (customizable)
 * In browser/dev: Uses localhost:8080
 */
export async function getBackendUrl() {
  // In Electron app
  if (window.electronAPI?.getBackendPort) {
    // Cache the port for performance
    if (!cachedPort) {
      cachedPort = await window.electronAPI.getBackendPort();
    }
    return `http://localhost:${cachedPort}`;
  }

  return browserBackendUrl();
}

/**
 * Outside Electron: the Vite dev server talks to a backend started by hand
 * on localhost:8080; a built app served by the container's reverse proxy
 * talks to its own origin (the proxy forwards the API to Flask).
 */
function browserBackendUrl() {
  // test seam: a bundled client pointed at a backend of the test's choosing
  if (typeof globalThis !== 'undefined' && globalThis.__JACARIUM_BACKEND_URL) {
    return globalThis.__JACARIUM_BACKEND_URL;
  }
  // (import.meta.env is Vite's; absent when a test bundles this with esbuild)
  if (import.meta.env?.DEV) {
    return 'http://localhost:8080';
  }
  const location = typeof window !== 'undefined' ? window.location : undefined;
  if (location && /^https?:$/.test(location.protocol || '')) {
    return location.origin;
  }
  return 'http://localhost:8080';
}

/**
 * Get backend URL synchronously (for cases where we already have the port cached)
 * Falls back to default if not cached
 */
export function getBackendUrlSync() {
  if (window.electronAPI?.getBackendPort && cachedPort) {
    return `http://localhost:${cachedPort}`;
  }
  return browserBackendUrl();
}

/**
 * Get (and cache) the shared-secret app auth token from the Electron main
 * process. Returns null outside Electron (e.g. plain browser/dev preview),
 * in which case the backend will reject requests unless it too was started
 * without APP_AUTH_TOKEN set.
 */
export async function getAppToken() {
  if (!window.electronAPI?.getAppToken) {
    return null;
  }
  if (!tokenPromise) {
    tokenPromise = window.electronAPI.getAppToken();
  }
  return tokenPromise;
}

/**
 * Get the cached app auth token synchronously, if it has already been
 * fetched (e.g. via initializeBackendUrl() at startup). Returns null if not
 * yet available -- callers needing a guarantee should use getAppToken().
 */
let cachedTokenSync = null;
export function getAppTokenSync() {
  return cachedTokenSync;
}

/**
 * Pre-fetch and cache the backend port and auth token (call this early in
 * app initialization).
 */
export async function initializeBackendUrl() {
  if (window.electronAPI?.getBackendPort) {
    cachedPort = await window.electronAPI.getBackendPort();
    console.log('[BackendUrl] Initialized with port:', cachedPort);
  }
  if (window.electronAPI?.getAppToken) {
    cachedTokenSync = await getAppToken();
  }
}

/**
 * Drop-in replacement for fetch() that talks to the local backend: it
 * attaches the X-App-Token header (required by the backend's before_request
 * auth check) to every request, merging with any headers the caller passed.
 *
 * Usage is identical to fetch(): apiFetch(url, options)
 */
export async function apiFetch(url, options = {}) {
  const token = await getAppToken();
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers['X-App-Token'] = token;
  }
  // With sign-in (the browser deployment's accounts mode) the backend
  // refuses state-changing requests without this header: a cross-site
  // page cannot add it without a CORS preflight. Harmless elsewhere.
  headers['X-Requested-With'] = 'Jacarium';
  // the session cookie travels with every request to the backend: same
  // origin behind the deployment's proxy, cross-origin (localhost:5173 ->
  // localhost:8080, same site) in development
  return fetch(url, { credentials: 'include', ...options, headers });
}
