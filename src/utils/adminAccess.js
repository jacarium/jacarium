/**
 * Which parts of Settings administer a server, and for whom.
 *
 * In the browser the backend is the server: the signed-in account's role
 * decides (src/utils/auth.js). In the desktop app the local backend has no
 * accounts; the administration is the LINKED HOME SERVER's, shown when the
 * linked account is an administrator there (electron/home-server.cjs keeps
 * the role with the link and refreshes it from /api/auth/me) and the server
 * is new enough to let a linked device administer it (GET /api/version
 * capabilities.desktopAdmin). Every call then goes through the main process
 * with the device token; state-changing actions ask for the password once
 * (the step-up in backend/auth.py).
 */

/**
 * @param {object} p
 * @param {boolean} p.accountsMode   the backend itself has accounts (browser)
 * @param {boolean} p.admin          the signed-in browser account is an admin
 * @param {object|null} p.remote     the linked home server's account, or null:
 *                                   { url, username, role, capabilities }
 * @returns {{ account: boolean, admin: boolean, remote: boolean, server: string|null, unsupported: boolean }}
 *   account: an account section applies (own sessions, devices, backups);
 *   admin: the Users and Audit categories show;
 *   remote: the server is the linked home server (labels say so);
 *   unsupported: linked as admin to a server too old for desktop administration.
 */
export function adminAccess({ accountsMode = false, admin = false, remote = null } = {}) {
  if (accountsMode) return { account: true, admin: !!admin, remote: false, server: null, unsupported: false };
  if (!remote || !remote.url) return { account: false, admin: false, remote: false, server: null, unsupported: false };
  const isAdmin = remote.role === 'admin';
  const supported = !!(remote.capabilities && remote.capabilities.desktopAdmin);
  return { account: true, admin: isAdmin && supported, remote: true, server: serverLabel(remote.url), unsupported: isAdmin && !supported };
}

/** "pi.console" from "https://pi.console/" (host, plus a non-default port). */
export function serverLabel(url) {
  try { const u = new URL(url); return u.port ? `${u.hostname}:${u.port}` : u.hostname; } catch { return String(url || ''); }
}
