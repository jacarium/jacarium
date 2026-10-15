/**
 * CORS origin policy shared by the Express app and the Socket.IO server.
 *
 * CORS_ORIGIN used to default to '*': with no configuration at all, any web
 * page in any browser could issue cross-origin requests against the server
 * (the unauthenticated endpoints in particular - /api/register, /api/games,
 * /api/stats). A wildcard is never needed for the server's own consumers:
 *
 *   - the desktop app (the primary client) runs from file:// when packaged,
 *     for which Chromium sends `Origin: null` (fetch/XHR) or `Origin: file://`
 *     (WebSocket), and from the Vite dev server (http://localhost:5173) in
 *     development;
 *   - non-browser clients (curl, socket.io-client under Node, the test
 *     suite) send no Origin header at all, so CORS does not apply;
 *   - the browser game pages (/quiz, /grid, /tiles) are served BY this server
 *     and are therefore same-origin - CORS never applies to them either.
 *
 * So when CORS_ORIGIN is unset the default now admits exactly the desktop
 * app origins above and nothing else, and server.js logs how to widen it.
 *
 * The app also runs in a browser (deploy/Containerfile serves it at e.g.
 * https://console.example.internal:8443), and that page's origin is what
 * the browser sends; it must be listed in CORS_ORIGIN (one origin or a
 * comma-separated list, each exactly as typed in the address bar). The
 * listed origins are ADDED to the desktop-app origins above, so a team
 * with both desktop and browser users keeps working - listing only the
 * browser origin used to lock the desktop app out. '*' still means any
 * origin.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Origins allowed when CORS_ORIGIN is not configured.
 * @param {string|undefined} origin  value of the request's Origin header
 */
function isDesktopAppOrigin(origin) {
  if (origin === undefined || origin === null || origin === '') {
    return true; // no Origin header: not a browser cross-origin request
  }
  const value = String(origin).trim().toLowerCase();
  if (value === 'null' || value === 'file://') {
    return true; // packaged Electron renderer (file://)
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  return LOOPBACK_HOSTS.has(parsed.hostname === '::1' ? '[::1]' : parsed.hostname);
}

/**
 * Build the `origin` option for the `cors` package (used directly by Express
 * and, with identical semantics, by Socket.IO's `cors` option).
 * @param {string|undefined} configured  raw CORS_ORIGIN env value
 * @returns {{ origin: string|string[]|function, configured: boolean }}
 */
function buildCorsOrigin(configured) {
  const raw = configured === undefined || configured === null ? '' : String(configured).trim();
  if (raw) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.includes('*')) {
      return { origin: '*', configured: true };
    }
    // Origins compare case-insensitively (scheme and host); a trailing slash
    // pasted from the address bar is not part of an origin.
    const allowed = new Set(list.map((o) => o.replace(/\/+$/, '').toLowerCase()));
    return {
      origin: (origin, callback) => callback(null,
        isDesktopAppOrigin(origin) || allowed.has(String(origin || '').replace(/\/+$/, '').toLowerCase())),
      configured: true,
      list
    };
  }
  return {
    origin: (origin, callback) => callback(null, isDesktopAppOrigin(origin)),
    configured: false
  };
}

module.exports = { isDesktopAppOrigin, buildCorsOrigin };
