/**
 * The desktop app's link to a home server (electron/home-server.cjs): the
 * server where this profile's account lives, so its data synchronises
 * there like a signed-in browser's does (src/sync/syncEngine.js).
 *
 * The renderer never sees the device token: linking and every request
 * happen in the main process; this module only wraps the bridge and turns
 * its answers into what the sync engine expects (a Response-like object).
 */
import { can } from './platform';

const api = () => (typeof window !== 'undefined' ? window.electronAPI : undefined);

export function homeServerSupported() {
  return can('homeServer');
}

export function getHomeServerStatus() {
  return api().homeServerStatus();
}

export function linkHomeServer({ url, username, password }) {
  return api().homeServerLink({ url, username, password });
}

export function unlinkHomeServer() {
  return api().homeServerUnlink();
}

/** The sync engine's transport: fetch(path, init) -> Response-like. */
export function homeServerTransport() {
  return {
    fetch: async (path, init = {}) => {
      const answer = await api().homeServerFetch(path, {
        method: init.method || 'GET',
        headers: init.headers || {},
        body: typeof init.body === 'string' ? init.body : init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      return {
        ok: !!answer.ok,
        status: answer.status,
        json: async () => { try { return JSON.parse(answer.text); } catch { return null; } },
        text: async () => answer.text,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// versions: this desktop against the home server
// ---------------------------------------------------------------------------
//
// The server reports its app version (package.json) and its protocol
// (protocol.json) at GET /api/version. Same app version: nothing to say.
// Different app version, same protocol: a dismissible notice with the
// server's downloads page. Different protocol: synchronisation is PAUSED
// (never a wipe or a merge across protocols) and a banner says which side
// to update. A server from before the endpoint is an old server: notice.

const listeners = new Set();
let lastCheck = null;   // { state, title, message, desktop, server, downloadsUrl, checkedAt }

/** Compare two X.Y.Z strings (-1, 0, 1); non-numeric parts compare as 0. */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
}

/**
 * What a version answer means: { state, paused, title, message, downloadsUrl }
 *   state: 'same' | 'server-older' | 'server-newer' | 'incompatible' | 'unreachable' | 'not-linked'
 *   paused: synchronisation must not run (incompatible protocol)
 */
export function evaluateVersions({ desktop, server }) {
  const downloadsUrl = server?.url ? `${server.url.replace(/\/+$/, '')}/api/downloads/` : null;
  if (!server || !server.linked) return { state: 'not-linked', paused: false, title: '', message: '', downloadsUrl, desktop, server };
  if (!server.reachable) return { state: 'unreachable', paused: false, title: 'Home server not reachable', message: server.error || 'The home server did not answer.', downloadsUrl, desktop, server };
  const serverProtocol = server.protocol == null ? 1 : Number(server.protocol);
  if (serverProtocol !== Number(desktop.protocol)) {
    const serverNewer = serverProtocol > Number(desktop.protocol);
    return {
      state: 'incompatible', paused: true,
      title: 'Synchronisation paused: versions do not match',
      message: serverNewer
        ? `The home server speaks protocol ${serverProtocol} (Jacarium ${server.app || 'newer'}); this desktop app (${desktop.app}) speaks protocol ${desktop.protocol}. Update the desktop app: download the matching version from your home server (its downloads page). Until then nothing synchronises and the central server behind it is not used; your local work stays available, nothing is merged or wiped.`
        : `This desktop app (${desktop.app}) speaks protocol ${desktop.protocol}; the home server (Jacarium ${server.legacy ? 'before 3.0.0' : server.app || 'older'}) speaks protocol ${serverProtocol}. Update the home server (deploy/deploy-to-host.sh). Until then nothing synchronises; your local work stays available, nothing is merged or wiped.`,
      downloadsUrl, desktop, server,
    };
  }
  if (server.legacy) {
    return { state: 'server-older', paused: false, title: 'Home server is older', message: `Desktop ${desktop.app}, home server before 3.0.0 (same protocol ${desktop.protocol}, so synchronisation keeps working). Update the home server when convenient.`, downloadsUrl, desktop, server };
  }
  const cmp = compareVersions(desktop.app, server.app);
  if (cmp === 0) return { state: 'same', paused: false, title: '', message: '', downloadsUrl, desktop, server };
  return {
    state: cmp < 0 ? 'server-newer' : 'server-older', paused: false,
    title: 'Versions differ',
    message: cmp < 0
      ? `Desktop ${desktop.app}, home server ${server.app} - compatible (protocol ${desktop.protocol}). Download the matching desktop version from your home server.`
      : `Desktop ${desktop.app}, home server ${server.app} - compatible (protocol ${desktop.protocol}). Update the home server when convenient.`,
    downloadsUrl, desktop, server,
  };
}

/** Ask the main process and remember the result (HomeServerVersionNotice, Settings). `url`: a server not linked yet. */
export async function checkHomeServerVersion(url) {
  if (!api()?.homeServerVersion) return null;
  const answer = await api().homeServerVersion(url);
  const result = { ...evaluateVersions(answer), checkedAt: Date.now() };
  if (!url) {
    lastCheck = result;
    for (const fn of listeners) { try { fn(result); } catch (error) { console.error('[HomeServer] version listener failed:', error); } }
  }
  return result;
}

export function getLastVersionCheck() {
  return lastCheck;
}

export function subscribeVersionCheck(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The sync engine's gate (startSync({ gate })): checked before every cycle,
 * i.e. on every connect/reconnect; incompatible versions pause the cycle.
 */
export async function homeServerSyncGate() {
  const result = await checkHomeServerVersion();
  if (!result) return { ok: true };
  if (result.state === 'unreachable') return { ok: false, reason: result.message, transient: true };
  if (result.paused) return { ok: false, reason: result.title };
  return { ok: true };
}
