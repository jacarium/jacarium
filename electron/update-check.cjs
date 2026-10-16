// Release check against GitHub, for the desktop app's main process.
//
// What it does: ask https://api.github.com/repos/jacarium/jacarium/releases
// for the published releases, keep the ones that are newer than the running
// version (tags vX.Y.Z; drafts and pre-releases ignored), and hand the
// renderer what it shows: the newest version, the release notes of every
// version in between (the GitHub release bodies, Markdown from
// CHANGELOG.md) and the download for this platform.
//
// Privacy: the request is a plain unauthenticated GET with two headers
// (Accept, a fixed User-Agent without the version - GitHub refuses requests
// without one). No version, identifier or cookie goes out; GitHub sees the
// request's IP address and nothing else. The automatic check is OFF by
// default: nothing is sent unless the user turns it on in Settings > About,
// and then at most once a day (CHECK_INTERVAL_MS). "Check now" is one
// request on an explicit click and works with the automatic check off.
// Failures (offline, a proxy that refuses, GitHub down, the 60/hour limit)
// are recorded and otherwise silent: nothing is shown, the next check waits
// for its turn.
//
// Dismissal: "Skip this version" remembers that version; a NEWER release
// shows the window again. Everything is kept in update-check.json under the
// profile's userData (one file per profile, like ui-settings.json).
//
// Kept free of Electron imports: main.cjs passes the fetch (Electron's
// net.fetch, so the system proxy applies), the store path, the platform and
// a clock in, which is what makes tests/update-check.test.mjs possible
// without GitHub.
const { readUiSettings, persistUiSettings } = require('./ui-settings.cjs');

const RELEASES_API_URL = 'https://api.github.com/repos/jacarium/jacarium/releases?per_page=30';
const RELEASES_PAGE_URL = 'https://github.com/jacarium/jacarium/releases';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** [major, minor, patch] of "3.1.9" / "v3.1.9", or null. */
function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Semver order of two X.Y.Z strings: negative, zero or positive; an unparsable version sorts lowest. */
function compareVersions(a, b) {
  const pa = parseVersion(a) || [-1, -1, -1];
  const pb = parseVersion(b) || [-1, -1, -1];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * The GitHub /releases answer reduced to what the app needs, newest first:
 * published releases with a vX.Y.Z tag only (no drafts, no pre-releases).
 */
function normalizeReleases(json) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const r of json) {
    if (!r || typeof r !== 'object' || r.draft || r.prerelease) continue;
    const m = RELEASE_TAG.exec(String(r.tag_name || ''));
    if (!m) continue;
    out.push({
      version: `${m[1]}.${m[2]}.${m[3]}`,
      tag: r.tag_name,
      name: typeof r.name === 'string' ? r.name : '',
      body: typeof r.body === 'string' ? r.body : '',
      publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
      url: typeof r.html_url === 'string' ? r.html_url : RELEASES_PAGE_URL,
      assets: Array.isArray(r.assets)
        ? r.assets
          .filter((a) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
          .map((a) => ({ name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 }))
        : []
    });
  }
  return out.sort((x, y) => compareVersions(y.version, x.version));
}

/** The releases newer than `currentVersion`, newest first. */
function releasesNewerThan(releases, currentVersion) {
  return releases.filter((r) => compareVersions(r.version, currentVersion) > 0);
}

/**
 * The release notes to show: one section per version newer than the running
 * one, newest first (everything the user missed, not only the latest).
 * GitHub release bodies are Markdown (the CHANGELOG section of the version);
 * the renderer sanitises them before rendering.
 */
function notesSince(releases, currentVersion) {
  return releasesNewerThan(releases, currentVersion)
    .map((r) => {
      const date = r.publishedAt ? ` (${r.publishedAt.slice(0, 10)})` : '';
      const body = r.body.trim() || '_No release notes._';
      return `## Version ${r.version}${date}\n\n${body}\n`;
    })
    .join('\n');
}

/**
 * Whether the window should open: the newest release is newer than the
 * running version, and newer than the version the user skipped (if any) -
 * a skipped version stays quiet, the next one speaks up again.
 */
function shouldShowUpdate({ latestVersion, currentVersion, dismissedVersion }) {
  if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) return false;
  if (dismissedVersion && compareVersions(latestVersion, dismissedVersion) <= 0) return false;
  return true;
}

/** True when the automatic check has not run for CHECK_INTERVAL_MS (or never). */
function isCheckDue(lastCheckedAt, now, intervalMs = CHECK_INTERVAL_MS) {
  const last = Number(lastCheckedAt) || 0;
  return now - last >= intervalMs;
}

/**
 * The download for this installation among a release's assets, or the
 * releases page when nothing fits:
 *   darwin        the .dmg for the architecture (arm64 today)
 *   linux         the AppImage when running as one (APPIMAGE is set by the
 *                 AppImage runtime), else the .deb on Debian/Ubuntu, the .rpm
 *                 on Fedora/RHEL, else the AppImage
 *   anything else the releases page
 */
function pickDownload({ assets = [], platform, arch, appImage = false, linuxPackage = null, releaseUrl = RELEASES_PAGE_URL }) {
  // electron-builder names the x64 file without an architecture
  // (Jacarium-3.1.9.AppImage) and the others with one (-arm64, .aarch64,
  // _amd64 for the deb): a match on this architecture's token first, then,
  // for x64, a file that names no other architecture, then the first.
  const OTHER = ['arm64', 'aarch64', 'armv7l', 'armhf', 'i386', 'ia32'];
  const archTokens = arch === 'arm64' ? ['arm64', 'aarch64'] : ['x64', 'x86_64', 'amd64'];
  const forArch = (list) => list.find((a) => archTokens.some((t) => a.name.toLowerCase().includes(t)))
    || (arch !== 'arm64' ? list.find((a) => !OTHER.some((t) => a.name.toLowerCase().includes(t))) : null)
    || list[0];
  const byExt = (ext) => assets.filter((a) => a.name.toLowerCase().endsWith(ext));
  let asset = null;
  let label = 'Open the releases page';
  if (platform === 'darwin') {
    asset = forArch(byExt('.dmg'));
    label = 'Download for macOS';
  } else if (platform === 'linux') {
    const order = appImage ? ['.appimage'] : linuxPackage === 'deb' ? ['.deb', '.appimage'] : linuxPackage === 'rpm' ? ['.rpm', '.appimage'] : ['.appimage'];
    for (const ext of order) {
      asset = forArch(byExt(ext));
      if (asset) {
        label = `Download the ${ext === '.appimage' ? 'AppImage' : ext.slice(1)}`;
        break;
      }
    }
  }
  return asset ? { url: asset.url, label, name: asset.name } : { url: releaseUrl, label, name: null };
}

/** The one request the check makes: fixed URL, fixed headers, nothing else. */
function buildRequest() {
  return {
    url: RELEASES_API_URL,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'jacarium-update-check'
    }
  };
}

/**
 * The checker the main process runs.
 * @param {object} deps
 * @param {string}   deps.currentVersion   app.getVersion()
 * @param {function} deps.fetch            fetch-compatible (Electron's net.fetch: system proxy)
 * @param {string}   deps.storePath        update-check.json of this profile
 * @param {string}   deps.platform         process.platform
 * @param {string}   deps.arch             process.arch
 * @param {object}   [deps.env]            process.env (APPIMAGE)
 * @param {function} [deps.linuxPackage]   () => 'deb' | 'rpm' | null, how the app was installed
 * @param {function} [deps.now]            Date.now
 * @param {function} [deps.onUpdate]       called with status() when a check finds a release to show
 * @param {function} [deps.log]            console.log-like
 */
function createUpdateChecker(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const env = deps.env || {};
  const readStore = () => readUiSettings(deps.storePath);
  const writeStore = (partial) => { try { persistUiSettings(deps.storePath, partial); } catch (error) { log(`[UpdateCheck] could not save ${deps.storePath}: ${error.message}`); } };
  let inFlight = null;

  function status() {
    const store = readStore();
    const releases = Array.isArray(store.releases) ? store.releases : [];
    const newer = releasesNewerThan(releases, deps.currentVersion);
    const latest = newer[0] || null;
    const download = latest
      ? pickDownload({ assets: latest.assets, platform: deps.platform, arch: deps.arch, appImage: !!env.APPIMAGE, linuxPackage: deps.linuxPackage ? deps.linuxPackage() : null, releaseUrl: latest.url })
      : { url: RELEASES_PAGE_URL, label: 'Open the releases page', name: null };
    return {
      currentVersion: deps.currentVersion,
      autoCheck: store.autoCheck === true,
      lastCheckedAt: store.lastCheckedAt || null,
      lastError: store.lastError || null,
      latestVersion: latest ? latest.version : null,
      updateAvailable: !!latest,
      shouldShow: shouldShowUpdate({ latestVersion: latest && latest.version, currentVersion: deps.currentVersion, dismissedVersion: store.dismissedVersion }),
      dismissedVersion: store.dismissedVersion || null,
      releases: newer.map((r) => ({ version: r.version, name: r.name, publishedAt: r.publishedAt, url: r.url })),
      notes: notesSince(releases, deps.currentVersion),
      download,
      releasesPage: RELEASES_PAGE_URL
    };
  }

  /**
   * One request. `manual` (the button, the menu) always runs; the scheduled
   * check only when the user turned it on. Resolves to status(); never throws.
   */
  async function check({ manual = false } = {}) {
    const store = readStore();
    if (!manual && store.autoCheck !== true) return status();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const { url, headers } = buildRequest();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
      if (timer && typeof timer.unref === 'function') timer.unref();
      try {
        const response = await deps.fetch(url, { method: 'GET', headers, signal: controller ? controller.signal : undefined, credentials: 'omit', cache: 'no-store' });
        if (!response || !response.ok) throw new Error(`GitHub answered ${response ? response.status : 'nothing'}`);
        const releases = normalizeReleases(await response.json());
        writeStore({ lastCheckedAt: now(), lastError: null, releases });
        log(`[UpdateCheck] ${releases.length} release(s); newest ${releases[0] ? releases[0].version : 'none'}, running ${deps.currentVersion}`);
      } catch (error) {
        // Offline, a proxy in the way, GitHub unreachable or rate-limited:
        // remember why, show nothing, try again next time.
        writeStore({ lastCheckedAt: now(), lastError: String(error && error.message || error) });
        log(`[UpdateCheck] check failed: ${error && error.message}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const result = status();
      if (result.shouldShow && deps.onUpdate) {
        try { deps.onUpdate(result); } catch (error) { log(`[UpdateCheck] onUpdate failed: ${error.message}`); }
      }
      return result;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }

  /** The scheduled check: only when turned on and a day has passed. */
  async function tick() {
    const store = readStore();
    if (store.autoCheck !== true) return null;
    if (!isCheckDue(store.lastCheckedAt, now())) return null;
    return check();
  }

  function setAutoCheck(enabled) {
    writeStore({ autoCheck: enabled === true });
    return status();
  }

  function dismiss(version) {
    if (parseVersion(version)) writeStore({ dismissedVersion: String(version).replace(/^v/, '') });
    return status();
  }

  return { status, check, tick, setAutoCheck, dismiss };
}

module.exports = {
  RELEASES_API_URL,
  RELEASES_PAGE_URL,
  CHECK_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  parseVersion,
  compareVersions,
  normalizeReleases,
  releasesNewerThan,
  notesSince,
  shouldShowUpdate,
  isCheckDue,
  pickDownload,
  buildRequest,
  createUpdateChecker
};
