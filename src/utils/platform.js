/**
 * Where is the app running, and what can it do here?
 *
 * The app has two hosts: the Electron desktop app (electron/preload.cjs
 * exposes window.electronAPI) and a plain browser (the Vite dev server, or
 * the container deployment where the backend serves the same features over
 * HTTP). Features that need a privileged process - the env file with the
 * integration secrets, the print engine, whois, the Jira / HTTP proxies,
 * zoom, the debug bar, the OS identity, the pop-out windows - are checked
 * HERE, by capability, instead of scattered `window.electronAPI?.x` tests,
 * so the browser build degrades the same way everywhere: the control is
 * disabled with the same wording, nothing throws, nothing fails silently.
 *
 *   isDesktopApp()            true under Electron
 *   can('pdfExport')          per-feature capability (see CAPABILITIES)
 *   desktopOnly('PDF export') the uniform tooltip / notice text
 *   initializePlatform()      ask the backend what it provides
 *                             (GET /api/capabilities) - main.jsx calls it
 *                             once at startup; until it answers, or when
 *                             there is no backend, only the desktop
 *                             bridge counts.
 */

const api = () => (typeof window !== 'undefined' ? window.electronAPI : undefined);

/** Capability -> the preload method(s) it needs. */
const CAPABILITIES = {
  pdfExport: ['exportPdf'],           // Chromium printToPDF in the main process
  whois: ['whoisLookup'],             // raw whois query from the main process
  envSettings: ['readSettings', 'writeSettings'], // ~/.jacarium.env (integration secrets, AI providers)
  jiraProxy: ['jiraFetch'],           // Jira calls proxied by the main process (no CORS)
  httpProxy: ['workflowHttpRequest'], // workflow HTTP nodes proxied by the main process
  popOutWindows: ['openToolsWindow'], // separate BrowserWindows (the browser opens a tab instead)
  zoom: ['setZoomFactor'],
  debugBar: ['setDebugBarEnabled'],
  machineIdentity: ['getUsername', 'getHostname'], // OS user/host for cloud sync identity
  backendToken: ['getAppToken'],      // the per-launch backend token
  homeServer: ['homeServerStatus', 'homeServerLink', 'homeServerUnlink', 'homeServerFetch'], // link to a browser-deployment server
};

/**
 * Capability -> the flag in the backend's /api/capabilities answer that
 * provides it when there is no desktop bridge (backend/extensions.py).
 */
const BACKEND_CAPABILITIES = {
  envSettings: 'settings',
  jiraProxy: 'jiraProxy',
  httpProxy: 'httpProxy',
  whois: 'whois',
};

let backendInfo = null;          // the parsed /api/capabilities answer
let backendInfoPromise = null;   // in flight (or settled) initializePlatform()
const listeners = new Set();

export function isDesktopApp() {
  return !!api()?.isElectron;
}

/** True when every preload method the capability needs exists. */
function desktopCan(capability) {
  const needed = CAPABILITIES[capability];
  const a = api();
  return !!a && needed.every((m) => typeof a[m] === 'function');
}

/** True when the backend reported it provides the capability. */
export function backendCan(capability) {
  const flag = BACKEND_CAPABILITIES[capability];
  return !!flag && !!backendInfo?.capabilities?.[flag];
}

/** True when the desktop bridge or the backend provides the capability. */
export function can(capability) {
  if (!CAPABILITIES[capability]) throw new Error(`Unknown capability: ${capability}`);
  return desktopCan(capability) || (!isDesktopApp() && backendCan(capability));
}

/** "PDF export is only available in the desktop app" */
export function desktopOnly(feature) {
  return `${feature} is only available in the desktop app`;
}

export const CAPABILITY_NAMES = Object.keys(CAPABILITIES);

/**
 * Ask the backend what it provides. Resolves to the answer (or null when
 * there is no reachable backend); safe to call repeatedly. In the desktop
 * app the Electron bridge already provides everything, so this is a no-op.
 */
export function initializePlatform() {
  if (backendInfoPromise) return backendInfoPromise;
  if (isDesktopApp() || typeof window === 'undefined') {
    backendInfoPromise = Promise.resolve(null);
    return backendInfoPromise;
  }
  backendInfoPromise = (async () => {
    try {
      const { getBackendUrl, apiFetch } = await import('./backendUrl');
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/capabilities`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data || typeof data !== 'object') return null;
      backendInfo = data;
      for (const listener of listeners) {
        try { listener(backendInfo); } catch (error) { console.error('[Platform] listener failed:', error); }
      }
      return backendInfo;
    } catch {
      // No backend here (plain Vite dev, or the service is down): the
      // browser build keeps degrading as before.
      return null;
    }
  })();
  return backendInfoPromise;
}

/**
 * The pending initializePlatform() promise, or null when it was never
 * started - callers that must not probe the network on their own wait on
 * this only when startup began it.
 */
export function platformReady() {
  return backendInfoPromise;
}

/** The backend's /api/capabilities answer once known (null before / without). */
export function getBackendInfo() {
  return backendInfo;
}

/** Subscribe to the backend answer arriving. Returns an unsubscribe function. */
export function onBackendInfo(callback) {
  listeners.add(callback);
  if (backendInfo) callback(backendInfo);
  return () => listeners.delete(callback);
}

/**
 * The pop-out pages (Tools, Diagnostics, ...) open as separate windows in
 * the desktop app; in a browser the same standalone page (App.jsx's
 * ?standalone= modes) opens in a new tab.
 */
export function openStandalonePage(standaloneMode) {
  const url = new URL(window.location.href);
  url.search = `?standalone=${encodeURIComponent(standaloneMode)}`;
  url.hash = '';
  return window.open(url.toString(), '_blank', 'noopener,noreferrer');
}

/** Test hook: forget the backend answer. */
export function __resetPlatformForTests() {
  backendInfo = null;
  backendInfoPromise = null;
}
