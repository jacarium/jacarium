// Navigation and window-open guards for every BrowserWindow.
//
// Without these, anything that can inject a link or script into a renderer
// (a synced document with an <a href>, an <iframe>, a window.open() call,
// a form action, ...) could navigate the privileged window - the one that
// has preload.cjs / window.electronAPI attached - to an arbitrary remote
// origin, or pop up a new Electron window with the same preload. Electron's
// own security checklist (#13 / #14) asks for exactly the two handlers
// installed here.
//
// Policy (same for the main window and the standalone page windows):
//   - will-navigate / will-redirect: navigation is allowed only to the app's
//     own entry document (the packaged dist/index.html via file://, or the
//     Vite dev-server origin in development). Anything else is cancelled;
//     http(s)/mailto targets are handed to the OS default browser through
//     the same shell.openExternal path the renderer already uses for
//     external links, everything else (javascript:, file:, data:, custom
//     schemes) is dropped.
//   - setWindowOpenHandler: no new BrowserWindow is ever created from the
//     renderer. http(s)/mailto targets go to the OS browser, everything
//     else is denied.
//   - will-attach-webview: <webview> tags are refused outright.
//
// No legitimate flow needs in-app remote navigation: Google Calendar OAuth
// runs in the backend via InstalledAppFlow.run_local_server (system
// browser), Jira uses API tokens over IPC/proxy, and every "open link"
// site in src/ already calls electronAPI.openExternal (falling back to
// window.open, which this handler now also routes to the OS browser).
//
// Kept free of Electron imports (callers pass webContents + openExternal
// in) so the policy is unit-testable with plain Node - see
// tests/electron-navigation-guard.test.mjs.

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function parseUrl(url) {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

/**
 * True when `targetUrl` is the app itself: for a file:// entry the exact
 * same document (query/hash may differ, e.g. ?standalone=tools), for an
 * http(s) dev-server entry the same origin.
 */
function isAppNavigation(targetUrl, appEntryUrl) {
  const target = parseUrl(targetUrl);
  const entry = parseUrl(appEntryUrl);
  if (!target || !entry) return false;
  if (target.protocol !== entry.protocol) return false;
  if (entry.protocol === 'file:') {
    return target.pathname === entry.pathname;
  }
  return target.origin === entry.origin;
}

/** True for URLs that may be handed to the OS default browser/mail client. */
function isExternalUrl(url) {
  const parsed = parseUrl(url);
  return Boolean(parsed) && EXTERNAL_PROTOCOLS.has(parsed.protocol);
}

/**
 * Decide what to do with a renderer-initiated navigation or window.open:
 *   'allow'    - in-app navigation, let it proceed (navigation only)
 *   'external' - cancel, open in the OS browser
 *   'block'    - cancel, drop silently
 */
function classifyNavigation(targetUrl, appEntryUrl) {
  if (isAppNavigation(targetUrl, appEntryUrl)) return 'allow';
  if (isExternalUrl(targetUrl)) return 'external';
  return 'block';
}

function classifyWindowOpen(targetUrl) {
  return isExternalUrl(targetUrl) ? 'external' : 'block';
}

/**
 * Install the guards on one webContents.
 * @param {object} webContents      Electron WebContents (or a test double
 *                                  with on() and setWindowOpenHandler()).
 * @param {object} options
 * @param {string} options.appEntryUrl   URL the window was loaded with.
 * @param {function} options.openExternal  async (url) => void (shell.openExternal).
 * @param {function} [options.log]         (message) => void.
 */
function installNavigationGuards(webContents, { appEntryUrl, openExternal, log = () => {} }) {
  const handOff = (url, what) => {
    Promise.resolve()
      .then(() => openExternal(url))
      .catch((error) => log(`[NavigationGuard] openExternal failed for ${what} ${url}: ${error && error.message}`));
  };

  const onNavigate = (eventName) => (event, url) => {
    const decision = classifyNavigation(url, appEntryUrl);
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') {
      log(`[NavigationGuard] ${eventName} to ${url} cancelled - opening in the system browser`);
      handOff(url, eventName);
    } else {
      log(`[NavigationGuard] ${eventName} to ${url} blocked`);
    }
  };

  webContents.on('will-navigate', onNavigate('will-navigate'));
  webContents.on('will-redirect', onNavigate('will-redirect'));

  webContents.setWindowOpenHandler(({ url }) => {
    if (classifyWindowOpen(url) === 'external') {
      log(`[NavigationGuard] window.open(${url}) denied - opening in the system browser`);
      handOff(url, 'window.open');
    } else {
      log(`[NavigationGuard] window.open(${url}) denied`);
    }
    return { action: 'deny' };
  });

  webContents.on('will-attach-webview', (event) => {
    log('[NavigationGuard] <webview> attachment blocked');
    event.preventDefault();
  });
}

module.exports = {
  isAppNavigation,
  isExternalUrl,
  classifyNavigation,
  classifyWindowOpen,
  installNavigationGuards
};
