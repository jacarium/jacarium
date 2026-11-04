/**
 * Settings > About's facts that are not components: the security and
 * verification links (built once from brand.js's repository URL), the
 * runtime versions as the app learns them (the desktop's from the preload's
 * frozen value, a server's from /api/version, each checked to be a version
 * string) and the plain text "Copy version info" copies.
 */
import { brandRepository } from '../brand/brand';

/** The project's OpenSSF Best Practices entry. */
export const BEST_PRACTICES_PROJECT = 15975;

/**
 * The public repository's security policy and private vulnerability
 * reporting, the Best Practices entry, and the README's "Verify this
 * release" section (the signatures, the provenance, the SBOM).
 */
export const SECURITY_LINKS = Object.freeze({
  policy: `${brandRepository()}/blob/main/SECURITY.md`,
  report: `${brandRepository()}/security/advisories/new`,
  bestPractices: `https://www.bestpractices.dev/projects/${BEST_PRACTICES_PROJECT}`,
  verify: `${brandRepository()}#security--supply-chain`,
});

const VERSION_STRING = /^\d+\.\d+(\.\d+)?([a-z0-9.+-]{0,20})?$/;

/** The runtimes a server reported ({ python, node }), as version strings only; an older server reports none. */
export function serverRuntimes(raw) {
  const out = {};
  for (const key of ['python', 'node']) {
    const value = raw && raw[key];
    if (typeof value === 'string' && VERSION_STRING.test(value)) out[key] = value;
  }
  return out;
}

/** The desktop app's runtimes from the preload's frozen value ({ electron, chrome, node }), or null in a browser. */
export function desktopRuntimes(api = typeof window !== 'undefined' ? window.electronAPI : null) {
  const v = api?.runtimeVersions;
  if (!v || typeof v !== 'object') return null;
  const pick = (k) => (typeof v[k] === 'string' && VERSION_STRING.test(v[k]) ? v[k] : '');
  const out = { electron: pick('electron'), chrome: pick('chrome'), node: pick('node') };
  return out.electron || out.chrome || out.node ? out : null;
}

/** "Electron 42.11.17 · Chromium 148.0 · Node 22.21.1" - the parts that are known. */
export function runtimeLine(parts) {
  return parts.filter(([, v]) => v).map(([name, v]) => `${name} ${v}`).join(' · ');
}

/** The platform at the level the preload / navigator.userAgentData expose: an OS name, nothing of the machine. */
export function platformLabel(api = typeof window !== 'undefined' ? window.electronAPI : null, nav = typeof navigator !== 'undefined' ? navigator : null) {
  const names = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  if (api?.platform) return names[api.platform] || String(api.platform);
  if (nav?.userAgentData?.platform) return String(nav.userAgentData.platform);
  return nav?.platform ? String(nav.platform) : '';
}

/**
 * The plain text "Copy version info" copies: the app, the protocol, the
 * desktop runtimes or "browser", the platform, the home server's version and
 * runtimes. No hostname, address, username or path: the server's URL and the
 * profile stay out on purpose.
 */
export function versionInfoText({ app, protocol, desktop, server, platform }) {
  const lines = [`Jacarium ${app}`, `Sync protocol ${protocol}`];
  if (desktop) lines.push(`Desktop runtime: ${runtimeLine([['Electron', desktop.electron], ['Chromium', desktop.chrome], ['Node', desktop.node]])}`);
  else lines.push('Runs in a browser');
  if (platform) lines.push(`Platform: ${platform}`);
  if (server) {
    const runtimes = runtimeLine([['Python', server.runtimes?.python], ['Node', server.runtimes?.node]]);
    lines.push(`Home server: Jacarium ${server.app} (protocol ${server.protocol ?? '?'})${runtimes ? ` · ${runtimes}` : ''}`);
  } else lines.push(desktop ? 'Home server: not linked' : 'Home server: this server');
  return lines.join('\n');
}
