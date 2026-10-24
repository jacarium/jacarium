const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const certDistrust = require('./cert-distrust.cjs');
const path = require('path');

// The icon of every window (title bar, task switcher and the docks that do
// not go through a .desktop file - X11; Wayland only shows the icon of the
// matched .desktop entry). build/icons/ is packaged as it is (package.json
// build.files), so the same path works in development and inside app.asar;
// unlike dist/icon.png it does not depend on the Vite build having run.
const WINDOW_ICON = path.join(__dirname, '../build/icons/512x512.png');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { loadEnvironmentVariables } = require('./load-env.cjs');
const { readUiSettings, persistUiSettings } = require('./ui-settings.cjs');
const { readShortcutOverrides, writeShortcutOverrides, validateShortcutOverrides, menuAccelerators } = require('./shortcuts.cjs');
const { createUpdateChecker } = require('./update-check.cjs');
const { installNavigationGuards } = require('./navigation-guard.cjs');
const { installPdfExport } = require('./pdf-export.cjs');

// Test only: point userData (IndexedDB, ui-settings.json, cert pins,
// profile.json) at a throwaway directory so Electron-driven tests
// (tests/helpers/electron-app.mjs, tests/helpers/packaged-app.mjs) never
// touch the user's own data - in packaged builds too, because a packaged
// app on macOS keys its data directory off ~/Library, not HOME, and a test
// that launched one without this override once opened the real profile.
// The override only relocates the data directory; when it cannot take
// effect the app refuses to run rather than fall back to the real one.
const PACKAGED_USER_DATA_OVERRIDE = true;   // marker the packaged-app driver looks for
if (process.env.JACARIUM_USER_DATA_DIR) {
  const wanted = path.resolve(process.env.JACARIUM_USER_DATA_DIR);
  app.setPath('userData', wanted);
  app.setPath('sessionData', wanted);
  if (path.resolve(app.getPath('userData')) !== wanted) {
    console.error(`[Startup] JACARIUM_USER_DATA_DIR=${wanted} could not be applied (userData is ${app.getPath('userData')}); refusing to run against the real data directory`);
    app.exit(97);
  }
}
void PACKAGED_USER_DATA_OVERRIDE;

// Documents PDF export via printToPDF ('export-pdf' / 'export-pdf-cancel')
installPdfExport({ ipcMain, BrowserWindow, session: require('electron').session, app }, {
  log: (line) => console.warn(line),
});
const { decideTrust, chainFromElectronCertificate } = require('./tls-trust.cjs');
const { safeRequest, workflowPrivateUrlsAllowed } = require('./safe-url.cjs');
const { sanitizeEnvData } = require('./env-file.cjs');
const { parseEnvFile, publicView, withoutSecrets, mergeSettings, mergeLegacyEnvData, isSecretKey } = require('./settings-store.cjs');

// Generate a fresh shared-secret token for this app launch. This token is
// known only to this main process, the backend child process it spawns
// (via an environment variable, never a CLI arg or a file), and this app's
// own renderer (via a one-time IPC call through the contextBridge preload).
// The backend requires this token (X-App-Token header) on every sensitive
// request, so an arbitrary web page open in the user's regular browser
// cannot cause the local backend (SSH execution, URL fetch proxy, etc.) to
// do anything, even though the backend listens on 127.0.0.1 with no other
// authentication.
const appAuthToken = crypto.randomBytes(32).toString('hex');

// Determine build mode (production or testing)
let buildMode = 'production';
if (!app.isPackaged) {
  // Development mode - use environment variable
  buildMode = process.env.BUILD_MODE || 'development';
} else {
  // Packaged build - read from build-mode.cjs
  try {
    const buildConfig = require('../build-mode.cjs');
    buildMode = buildConfig.buildMode || 'production';
  } catch (err) {
    // build-mode.cjs doesn't exist, assume production
    buildMode = 'production';
  }
}

// Disable console logging in production builds only
if (app.isPackaged && buildMode === 'production') {
  console.log = () => {};
  console.debug = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
}

// ---------------------------------------------------------------------------
// Profiles (electron/profiles.cjs): which set of data this launch opens.
// The default profile is Electron's own userData directory (unchanged for
// a single-user installation); a named one (--profile <name>, the old
// INSTANCE_NAME, or the picker) lives at ~/.config/jacarium-<name>
// with its own backend home. Decided here, before anything reads userData
// or the settings file. With several profiles and no choice given, the
// picker window opens instead of the app (and relaunches with the choice).
// ---------------------------------------------------------------------------
const profiles = require('./profiles.cjs');
const { withCliPath } = require('./cli-path.cjs');
const { jiraConfig, notConfiguredResult } = require('./jira-config.cjs');
const PROFILES_ROOT = profiles.profilesRoot(process.env, app.getPath('home'));
const DEFAULT_PROFILE_DIR = app.getPath('userData');
// The development/test userData override above is an explicit choice of
// where to run: it means the default profile, never the picker (the
// Electron tests must not depend on the profiles of the developer's machine).
const profileArgv = (!app.isPackaged && process.env.JACARIUM_USER_DATA_DIR && !profiles.profileArgs(process.argv).name && !profiles.profileArgs(process.argv).picker)
  ? [...process.argv, '--profile', profiles.DEFAULT_PROFILE]
  : process.argv;
const profileSelection = profiles.resolveProfileSelection({
  argv: profileArgv,
  env: process.env,
  profiles: profiles.listProfiles(PROFILES_ROOT, DEFAULT_PROFILE_DIR),
  settings: profiles.readProfilesSettings(PROFILES_ROOT)
});
let activeProfile = null;
let activeProfileDir = DEFAULT_PROFILE_DIR;
if (profileSelection.ask) {
  // The picker runs on a throwaway userData so no profile is touched.
  app.setPath('userData', path.join(app.getPath('temp'), 'jacarium-profile-picker'));
} else {
  activeProfile = profileSelection.name;
  activeProfileDir = profiles.profileDir(PROFILES_ROOT, activeProfile, DEFAULT_PROFILE_DIR);
  if (activeProfile !== profiles.DEFAULT_PROFILE) {
    app.setPath('userData', activeProfileDir);
  }
  const prepared = profiles.prepareProfile(activeProfileDir, activeProfile, {
    seed: profiles.seedHome(process.env, app.getPath('home'))
  });
  if (!app.isPackaged) {
    console.log(`[Profiles] ${activeProfile} (${profileSelection.reason}) -> ${activeProfileDir}${prepared.copied.length ? ` (copied ${prepared.copied.join(', ')})` : ''}`);
  }
}
// The settings file of this profile (~/.jacarium.env for the default one)
const PROFILE_ENV_FILE = activeProfile ? profiles.envFilePathFor(activeProfileDir, activeProfile, app.getPath('home')) : null;

// Load environment variables from config files. The optional developer
// .env is read from the checkout root (next to package.json) in development
// only - never from the process working directory, which an untrusted
// launch location could control.
loadEnvironmentVariables({
  devEnvDir: app.isPackaged ? null : path.join(__dirname, '..'),
  userEnvFile: PROFILE_ENV_FILE
});

// Extract a normalized "hostname[:port]" from a URL string, or null if it
// cannot be parsed. Default ports are normalized away by the URL parser
// (e.g. "https://example.com:443" and "https://example.com" both yield
// "example.com"), so both sides of the comparison below are consistent.
function extractUrlHost(rawUrl) {
  try {
    const host = new URL(String(rawUrl)).host.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

// Self-signed certificates are tolerated ONLY for the linked home server
// (deploy/entrypoint.sh generates one), and even there only under
// trust-on-first-use pinning (electron/central-cert-pins.cjs): the first
// certificate seen for the host is recorded, and any later connection must
// present the same fingerprint or it is rejected and the user is warned -
// the same model as the backend's SSH known_hosts handling. The central
// server lives behind the home server (/central), so its renderer socket
// meets that same certificate. Every other TLS connection made by any
// window (JIRA API, AI chat URL fetches, update checks, embedded content)
// keeps full certificate validation: callback(false) preserves Electron's
// default rejection.
function centralCertPinsPath() {
  // Resolved lazily so the profile's userData is honored. The file keeps its
  // 3.0 name: it holds the home server's pin, recorded by earlier versions
  // under the same key.
  return path.join(app.getPath('userData'), 'central-server-cert-pins.json');
}

// "host|fingerprint" pairs already shown to the user this run, so a
// reconnecting socket does not re-open the warning on every attempt.
const certMismatchPrompted = new Set();

function warnCertificateMismatch(host, result) {
  const key = `${host}|${result.fingerprint}`;
  if (certMismatchPrompted.has(key)) return;
  certMismatchPrompted.add(key);

  const pinsPath = centralCertPinsPath();
  const recorded = result.kind === 'root' ? 'the certificate authority recorded when this profile was linked' : 'the certificate recorded on first connection';
  const options = {
    type: 'warning',
    title: 'Home server certificate changed',
    message: `The certificate presented by the home server "${host}" was not issued by ${recorded}.`,
    detail:
      'This may indicate a machine-in-the-middle attack. The connection has been blocked.\n\n'
      + (result.reason ? `Reason: ${result.reason}\n` : '')
      + `Recorded fingerprint:  ${result.expected}${result.kind === 'root' ? ' (CA root)' : ''}\n`
      + `Presented fingerprint: ${result.fingerprint}\n\n`
      + 'If the server was legitimately reinstalled with a new certificate authority, '
      + 'choose "Trust new certificate": its CA root is recorded instead (or the certificate itself when the server publishes no root), '
      + `or remove the host from ${pinsPath} and reconnect.`,
    buttons: ['Keep blocking', 'Trust new certificate'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const shown = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  shown.then(async ({ response }) => {
    if (response === 1) {
      // the root the server serves when the presented chain verifies against
      // it, the presented leaf otherwise (electron/home-server.cjs)
      const url = result.url || `https://${host}`;
      const pinned = await require('./home-server.cjs').trustPresented({ pinsPath, host, url, chain: result.chain || [], fingerprint: result.fingerprint });
      certMismatchPrompted.delete(key);
      console.log(`[CertPin] Pin for ${host} replaced by user: ${pinned.type} ${pinned.fingerprint}`);
    }
  }).catch((error) => {
    console.error('[CertPin] Failed to show certificate warning:', error);
  });
}

// The linked home server's host ("hostname[:port]"): its certificate is
// pinned by the main-process requests (electron/home-server.cjs) under the
// same store; the renderer's socket to <home server>/central/socket.io
// meets that same certificate here.
function linkedHomeServerHost() {
  try {
    const record = require('./home-server.cjs').readLink(path.join(app.getPath('userData'), require('./home-server.cjs').STORE_FILE));
    return record && record.url ? extractUrlHost(record.url) : null;
  } catch {
    return null;
  }
}

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  const requestHost = extractUrlHost(url);
  const homeHost = linkedHomeServerHost();
  if (!(requestHost && homeHost && requestHost === homeHost)) {
    callback(false);
    return;
  }

  // The chain as presented (Electron hands the leaf with its issuers):
  // verified against the pin the main process recorded at link time
  // (electron/tls-trust.cjs) - the CA root normally, so the renewed leaf and
  // intermediate of a local CA pass without a prompt. Nothing is pinned
  // from here: the link (electron/home-server.cjs) does that; a socket that
  // meets no pin is refused.
  let result;
  let chain = [];
  try {
    chain = chainFromElectronCertificate(certificate);
    result = decideTrust({ pinsPath: centralCertPinsPath(), host: requestHost, hostname: new URL(url).hostname, chainPems: chain });
  } catch (pinError) {
    console.error(`[CertPin] Could not evaluate certificate for ${requestHost}:`, pinError);
    callback(false);
    return;
  }

  if (result.decision === 'match' || result.decision === 'upgrade-candidate') {
    // (an upgrade-candidate is a 3.1 leaf pin the presented leaf still matches:
    // the main process upgrades it to the root on its next request)
    event.preventDefault();
    callback(true);
    return;
  }

  callback(false);
  if (result.decision === 'mismatch') {
    console.error(`[CertPin] REJECTED ${requestHost}: ${result.reason || 'the certificate does not match the pin'} (${result.fingerprint} vs ${result.expected})`);
    warnCertificateMismatch(requestHost, { ...result, url: new URL(url).origin, chain });
  } else if (result.decision === 'unpinned') {
    console.error(`[CertPin] REJECTED ${requestHost}: no certificate pin for the home server yet (link the profile first)`);
  } else {
    console.error(`[CertPin] REJECTED ${requestHost}: certificate has no usable fingerprint (${error})`);
  }
});

// (INSTANCE_NAME used to set userData here; it is a profile name now - see
// the Profiles block above.)

let mainWindow;
let serverProcess;
// The backend's port: PORT when set, else 8080 or the next free port (two
// profiles may run at the same time) - chosen in app.whenReady.
let backendPort = process.env.PORT || null;

// Vite dev-server origin (development only); the packaged app loads
// dist/index.html over file://.
const DEV_SERVER_URL = 'http://localhost:5173';

// ---------------------------------------------------------------------------
// UI zoom (persisted)
//
// The main process owns the app-wide zoom factor: webContents.setZoomFactor()
// is a main-process API, so both ways of changing zoom (the View-menu
// keyboard shortcuts below and the Settings > General "UI Scale" dropdown,
// which calls in over the 'set-zoom-factor' IPC channel) funnel through
// applyZoomFactor() here - a single source of truth that can't desync.
// The chosen factor is persisted to ui-settings.json under userData (NOT
// ~/.jacarium.env - that file is rebuilt from a whitelist of API-key
// style settings by 'write-env-file' and is tied to the restart-required
// Save flow, while zoom applies live) and re-applied to every window on
// 'did-finish-load', so the next launch starts at the saved zoom with no
// flash of 100%.
//
// ZOOM_STEPS must stay in sync with ZOOM_LEVELS in
// src/components/common/modals/settings/GeneralSettings.jsx.
// ---------------------------------------------------------------------------
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

// Two deliberately distinct constants:
// - INITIAL_DEFAULT_ZOOM is the zoom on a fresh install, before the user
//   has ever picked a value (no ui-settings.json yet).
// - RESET_ZOOM is what Cmd/Ctrl+0 ("Actual Size") resets to. Reset-to-100%
//   is the standard, browser-like behavior and stays 1.0 regardless of the
//   first-run default or the currently saved factor.
const INITIAL_DEFAULT_ZOOM = 0.9;
const RESET_ZOOM = 1;

function uiSettingsPath() {
  // Resolved lazily so the INSTANCE_NAME userData override above is honored.
  return path.join(app.getPath('userData'), 'ui-settings.json');
}

function loadSavedZoomFactor() {
  const factor = Number(readUiSettings(uiSettingsPath()).zoomFactor);
  if (Number.isFinite(factor) && factor >= MIN_ZOOM && factor <= MAX_ZOOM) {
    return factor;
  }
  // Missing or corrupt file/value: fall back to the first-run default.
  return INITIAL_DEFAULT_ZOOM;
}

let currentZoomFactor = loadSavedZoomFactor();

// Merge the given keys into ui-settings.json. Always go through this (i.e.
// through persistUiSettings' read-merge-write) rather than writing the file
// directly: a wholesale write of one setting silently deletes the others.
function saveUiSettings(partial) {
  try {
    persistUiSettings(uiSettingsPath(), partial);
  } catch (err) {
    // The setting still applies for this session; it just won't survive a
    // restart.
    console.error('Failed to persist UI settings:', err.message);
  }
}

// Clamp and apply a zoom factor to every open window, remember it for
// windows opened later, persist it for the next launch, and notify every
// renderer so an open Settings dialog shows the current value even when the
// change came from a keyboard shortcut.
function applyZoomFactor(factor) {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor));
  currentZoomFactor = clamped;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.setZoomFactor(clamped);
      win.webContents.send('zoom-factor-changed', clamped);
    }
  }
  saveUiSettings({ zoomFactor: clamped });
  return clamped;
}

// Move one step up (+1) or down (-1) the ZOOM_STEPS ladder from whichever
// step is closest to the current factor.
function stepZoomFactor(direction) {
  let index = 0;
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i] - currentZoomFactor) < Math.abs(ZOOM_STEPS[index] - currentZoomFactor)) {
      index = i;
    }
  }
  index = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
  return applyZoomFactor(ZOOM_STEPS[index]);
}

// Apply the persisted UI zoom whenever a window's page is ready. Attached
// per-window at creation; did-finish-load also covers reloads, which reset
// the webContents zoom.
function applyZoomOnLoad(win) {
  const { webContents } = win;
  webContents.on('did-finish-load', () => {
    webContents.setZoomFactor(currentZoomFactor);
  });
}

ipcMain.handle('get-zoom-factor', () => currentZoomFactor);

ipcMain.handle('set-zoom-factor', (event, factor) => {
  const parsed = Number(factor);
  if (!Number.isFinite(parsed)) {
    throw new Error('Invalid zoom factor: ' + factor);
  }
  return applyZoomFactor(parsed);
});

// ---------------------------------------------------------------------------
// Debug status bar (persisted toggle + metrics push)
//
// Same single-source-of-truth pattern as zoom above: the main process owns
// the on/off state for the renderer's debug status bar. The Settings toggle
// calls in over 'set-debug-bar-enabled', the state is persisted to
// ui-settings.json (merged via saveUiSettings - never clobbering zoomFactor),
// and every window is notified via 'debug-bar-changed' so all windows (main
// shell + standalone Tools/Diagnostics/etc.) show or hide the bar together.
// Windows opened later pick the state up themselves: DebugStatusBar invokes
// 'get-debug-bar-enabled' on mount.
//
// While enabled and at least one window is open, a single 1s interval calls
// app.getAppMetrics() ONCE per tick and broadcasts the numbers to every
// window over 'debug-metrics'. Renderer-driven polling would cost N invokes
// and N getAppMetrics() calls for N windows; pushing keeps the cost constant
// and every window's numbers consistent. When the bar is off the interval
// does not exist at all - a debug tool that taxes the CPU while switched off
// would defeat its own purpose.
// ---------------------------------------------------------------------------
const DEBUG_METRICS_INTERVAL_MS = 1000;

let debugBarEnabled = readUiSettings(uiSettingsPath()).debugBarEnabled === true;
let debugMetricsTimer = null;
// getAppMetrics()'s percentCPUUsage is the delta since the PREVIOUS call, so
// the first sample after (re)starting the timer is meaningless - discard it.
let debugMetricsPrimed = false;

function broadcastDebugMetrics() {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  if (windows.length === 0) {
    // No windows left (macOS keeps the app alive after the last close):
    // stop measuring until a window exists again.
    stopDebugMetricsTimer();
    return;
  }

  const metrics = app.getAppMetrics();
  if (!debugMetricsPrimed) {
    debugMetricsPrimed = true;
    return;
  }

  // App-wide totals across every Chromium process (browser, renderers, GPU,
  // utility). CPU is percent of a single core, so totals can exceed 100.
  // Memory is workingSetSize in kilobytes. NOTE: the spawned Flask backend
  // is a plain child process, NOT part of Chromium's process tree, so it is
  // not included here (deliberately out of scope for now).
  let totalCpuPercent = 0;
  let totalMemoryKB = 0;
  const byPid = new Map();
  for (const proc of metrics) {
    const cpuPercent = proc.cpu ? proc.cpu.percentCPUUsage || 0 : 0;
    const memoryKB = proc.memory ? proc.memory.workingSetSize || 0 : 0;
    totalCpuPercent += cpuPercent;
    totalMemoryKB += memoryKB;
    byPid.set(proc.pid, { cpuPercent, memoryKB });
  }

  // Each window also gets its own renderer's numbers so the bar can show
  // "this window" next to the app total.
  for (const win of windows) {
    win.webContents.send('debug-metrics', {
      totalCpuPercent,
      totalMemoryKB,
      processCount: metrics.length,
      window: byPid.get(win.webContents.getOSProcessId()) || null
    });
  }
}

function startDebugMetricsTimer() {
  if (debugMetricsTimer) {
    return;
  }
  debugMetricsPrimed = false;
  debugMetricsTimer = setInterval(broadcastDebugMetrics, DEBUG_METRICS_INTERVAL_MS);
}

function stopDebugMetricsTimer() {
  if (debugMetricsTimer) {
    clearInterval(debugMetricsTimer);
    debugMetricsTimer = null;
  }
}

function setDebugBarEnabled(enabled) {
  debugBarEnabled = enabled === true;
  saveUiSettings({ debugBarEnabled });
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('debug-bar-changed', debugBarEnabled);
    }
  }
  if (debugBarEnabled && BrowserWindow.getAllWindows().length > 0) {
    startDebugMetricsTimer();
  } else {
    stopDebugMetricsTimer();
  }
  return debugBarEnabled;
}

// Covers both app launch with the toggle already on (persisted from a
// previous session - the timer starts when the first window appears) and a
// new window opening after the timer stopped because none were left.
app.on('browser-window-created', () => {
  if (debugBarEnabled) {
    startDebugMetricsTimer();
  }
});

ipcMain.handle('get-debug-bar-enabled', () => debugBarEnabled);

ipcMain.handle('set-debug-bar-enabled', (event, enabled) => setDebugBarEnabled(enabled));

// ---------------------------------------------------------------------------
// Keyboard shortcuts (electron/shortcuts.cjs, the registry in
// electron/shortcuts-registry.cjs)
//
// The user's overrides live in ui-settings.json (per profile, never in the
// env file or the settings scopes). The renderer's Settings > Shortcuts tab
// sends the whole override map; the main process validates it against the
// registry's rules again, persists it, rebuilds the application menu so
// the menu-owned actions (Settings, Toggle Sidebar, zoom, the Pages) carry
// the new accelerators, and tells every window. The renderer's own
// handlers never fire a menu-owned action on the desktop, so a chord
// never fires twice.
// ---------------------------------------------------------------------------
let shortcutOverrides = readShortcutOverrides(uiSettingsPath()).overrides;

function shortcutState() {
  return { version: 1, overrides: shortcutOverrides, platform: process.platform };
}

function setShortcutOverrides(raw) {
  const result = validateShortcutOverrides(raw, process.platform);
  if (!result.ok) return { ok: false, errors: result.errors };
  try {
    shortcutOverrides = writeShortcutOverrides(uiSettingsPath(), result.overrides);
  } catch (err) {
    return { ok: false, errors: [{ id: null, message: 'Could not save the shortcuts: ' + err.message }] };
  }
  createApplicationMenu();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('shortcuts-changed', shortcutState());
  }
  return { ok: true, ...shortcutState() };
}

ipcMain.handle('get-shortcuts', () => shortcutState());
ipcMain.handle('set-shortcuts', (event, overrides) => setShortcutOverrides(overrides));

// Start the backend server (Flask in production, Node.js in development)
function startBackendServer() {
  const isDevelopment = process.env.NODE_ENV === 'development' || !app.isPackaged;

  let backendPath;
  let backendArgs = [];
  let backendType;

  if (isDevelopment) {
    // Development: use Node.js backend
    backendPath = 'node';
    backendArgs = [path.join(__dirname, 'server.cjs')];
    backendType = 'Node.js';
  } else {
    // Production: use bundled Flask backend
    const platform = process.platform;
    let binaryName;

    if (platform === 'win32') {
      binaryName = 'flask-backend.exe';
    } else {
      binaryName = 'flask-backend';
    }

    // PyInstaller onedir layout: the launcher executable lives inside the
    // flask-backend/ directory (next to its _internal/ dependencies), i.e.
    // Resources/flask-backend/flask-backend in a packaged app.
    // Check in resources directory (where electron-builder puts extraResources)
    backendPath = path.join(process.resourcesPath, 'flask-backend', binaryName);

    // Fallback: check in app directory
    if (!fs.existsSync(backendPath)) {
      backendPath = path.join(__dirname, '..', 'backend', 'dist', 'flask-backend', binaryName);
    }

    // Make sure the binary is executable on Unix systems
    if (platform !== 'win32' && fs.existsSync(backendPath)) {
      try {
        fs.chmodSync(backendPath, 0o755);
      } catch (err) {
        console.warn('Could not set executable permissions:', err.message);
      }
    }

    backendType = 'Flask (Python)';
  }

  console.log(`Starting ${backendType} backend: ${backendPath}`);

  if (!isDevelopment && !fs.existsSync(backendPath)) {
    console.error(`Backend binary not found at: ${backendPath}`);
    console.error('Falling back to Node.js backend...');
    backendPath = 'node';
    backendArgs = [path.join(__dirname, 'server.cjs')];
  }

  const port = String(backendPort || process.env.PORT || '8080');
  serverProcess = spawn(backendPath, backendArgs, {
    stdio: 'inherit',
    // Pass the shared-secret token via an environment variable rather than a
    // CLI argument (which would be visible to any local user via `ps`) or a
    // file (which could have weak permissions or linger on disk).
    env: {
      // the login session's PATH plus the usual tool directories (Homebrew ...), so `task` is found
      ...withCliPath(process.env),
      PORT: port,
      APP_AUTH_TOKEN: appAuthToken,
      // A named profile's own backend home, settings file and known_hosts
      // (nothing for the default profile: the real home, as always).
      ...profiles.backendEnvForProfile(activeProfileDir, activeProfile)
    }
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start backend server:', err);
  });

  serverProcess.on('exit', (code) => {
    console.log(`Backend server exited with code ${code}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      // webSecurity is enabled. Two things that used to require disabling it
      // are handled without it:
      //   1. the packaged build's file:// origin (and the dev server origin)
      //      fetching the local backend at http://127.0.0.1:8080 works
      //      because backend/extensions.py sends CORS headers permitting
      //      this app's origins (including "null", which is what Chromium
      //      sends as Origin for file://);
      //   2. src/utils/workflowExecution.js's HTTP-request workflow steps
      //      fetch arbitrary user-configured URLs - proxied through the
      //      main process via the 'workflow-http-request' IPC handler
      //      (main-process Node isn't subject to renderer CORS), instead
      //      of a direct renderer fetch().
      // src/services/jiraApi.js was also listed here previously, but doesn't
      // actually need this: packaged builds already go through IPC
      // ('jira-fetch'), and dev mode only ever hits Vite's own same-origin
      // proxy.
      // Note this flag does NOT affect TLS certificate validation - invalid
      // certificates are handled (and rejected, except for the configured
      // central server) by the 'certificate-error' handler at the top of
      // this file.
      webSecurity: true
    },
    icon: WINDOW_ICON
  });

  applyZoomOnLoad(mainWindow);

  const indexPath = path.join(__dirname, '../dist/index.html');

  // Only the app's own entry document may ever be loaded in this window;
  // external links go to the OS browser and new windows are never created
  // from the renderer (see electron/navigation-guard.cjs).
  installNavigationGuards(mainWindow.webContents, {
    appEntryUrl: app.isPackaged ? pathToFileURL(indexPath).href : DEV_SERVER_URL,
    openExternal: openExternalUrl,
    log: (message) => console.log(message)
  });

  // In development, load from Vite dev server
  if (!app.isPackaged) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    // In production, load from built files
    mainWindow.loadFile(indexPath);

    // Open DevTools automatically for testing builds
    if (buildMode === 'testing') {
      mainWindow.webContents.openDevTools();
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createApplicationMenu() {
  const isMac = process.platform === 'darwin';
  // The accelerators of the menu-owned actions come from the shortcut
  // registry under the user's overrides (electron/shortcuts.cjs); an
  // unassigned action (the Pages by default) gets none. A fixed role
  // (reload, togglefullscreen) keeps Electron's own.
  const accelerators = menuAccelerators(shortcutOverrides, process.platform);
  const accel = (id) => (accelerators[id]?.accelerator ? { accelerator: accelerators[id].accelerator } : {});
  // hidden twins so an alias chord (Zoom in's Shift+=) works too
  const aliasItems = (id, item) => (accelerators[id]?.aliases || []).map((accelerator) => ({ ...item, label: `${item.label} (Alternate)`, accelerator, visible: false, acceleratorWorksWhenHidden: true }));

  const template = [
    // App Menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),

    // File Menu
    {
      label: 'File',
      submenu: [
        {
          label: 'Database',
          submenu: [
            {
              label: 'Import',
              click: () => {
                if (mainWindow) {
                  mainWindow.webContents.send('import-database');
                }
              }
            },
            {
              label: 'Export',
              click: () => {
                if (mainWindow) {
                  mainWindow.webContents.send('export-database');
                }
              }
            },
            { type: 'separator' },
            {
              label: 'Wipe',
              click: () => {
                if (mainWindow) {
                  mainWindow.webContents.send('wipe-database');
                }
              }
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'Settings',
          ...accel('app.settings'),
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('open-settings');
            }
          }
        },
        {
          label: 'Switch Profile...',
          click: () => switchProfile()
        },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          ...accel('app.toggleSidebar'),
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('toggle-sidebar');
            }
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },

    // Pages Menu - the pages by name, with NO accelerators: the former
    // Ctrl/Cmd+Shift+<letter> chords (Shift+C for Calendars...) collided with
    // terminal and GTK conventions on Linux (Ctrl+Shift+C is copy there), so
    // a mistyped copy switched the page. Pages are switched from the rail.
    {
      label: 'Pages',
      submenu: [
        {
          label: 'Documents',
          ...accel('page.documents'),
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('navigate-to-page', 'documents');
            }
          }
        },
        {
          label: 'Calendars',
          ...accel('page.calendars'),
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('navigate-to-page', 'calendars');
            }
          }
        },
        {
          label: 'Kanban',
          ...accel('page.kanban'),
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('navigate-to-page', 'kanban');
            }
          }
        },
        {
          label: 'Tasks',
          ...accel('page.tasks'),
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('navigate-to-page', 'tasks');
            }
          }
        },
        {
          label: 'Workflow Builder',
          ...accel('page.workflow'),
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('navigate-to-page', 'workflow');
            }
          }
        },
        {
          label: 'Diagnostics',
          ...accel('page.diagnostics'),
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('navigate-to-page', 'diagnostics');
            }
          }
        },
        {
          label: 'JQL Search',
          ...accel('page.search'),
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('navigate-to-page', 'search');
            }
          }
        },
        {
          label: 'Tools',
          ...accel('page.tools'),
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('navigate-to-page', 'tools');
            }
          }
        }
      ]
    },

    // Edit Menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ])
      ]
    },

    // View Menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        // Custom zoom items instead of the resetZoom/zoomIn/zoomOut roles:
        // the roles only touch the focused window's webContents, while these
        // route through applyZoomFactor() so keyboard shortcuts, the
        // Settings > General "UI Scale" dropdown, and persistence all share
        // one source of truth across every window. The accelerators come
        // from the registry (Cmd/Ctrl+0, += with a hidden Shift+= twin, +-
        // by default, as Electron assigns to the roles).
        {
          label: 'Actual Size',
          ...accel('app.zoomReset'),
          click: () => applyZoomFactor(RESET_ZOOM)
        },
        {
          label: 'Zoom In',
          ...accel('app.zoomIn'),
          click: () => stepZoomFactor(1)
        },
        ...aliasItems('app.zoomIn', { label: 'Zoom In', click: () => stepZoomFactor(1) }),
        {
          label: 'Zoom Out',
          ...accel('app.zoomOut'),
          click: () => stepZoomFactor(-1)
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },

    // Window Menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    },

    // Help Menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'What\'s New',
          click: () => {
            // Send event to renderer to show What's New window
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (focusedWindow) {
              focusedWindow.webContents.send('show-whats-new');
            }
          }
        },
        {
          // One request to GitHub on this click (works with the automatic
          // check off); the renderer runs it and shows the result.
          label: 'Check for Updates...',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) win.webContents.send('check-for-updates');
          }
        },
        {
          label: 'Give Feedback',
          click: () => {
            const { dialog } = require('electron');

            // The contact is package.json's author (a project address, no
            // person): the same thing `npm pkg get author` shows.
            const author = require('../package.json').author || {};
            const contact = typeof author === 'string' ? author : [author.name, author.email && `Email: ${author.email}`].filter(Boolean).join('\n');

            dialog.showMessageBox({
              type: 'info',
              title: 'Give Feedback',
              message: 'Contact',
              detail: (contact ? contact + '\n\n' : '') +
                      'We appreciate your feedback, bug reports, and feature suggestions!\n\n' +
                      'You can also:\n' +
                      '• Request new features\n' +
                      '• Report bugs or problems\n' +
                      '• Share your ideas for improvements',
              buttons: ['OK']
            });
          }
        },
        { type: 'separator' },
        {
          label: `Version ${app.getVersion()}`,
          enabled: false
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Linux Chromium lays out classic scrollbars that take horizontal space
// (~10px for the app's `scrollbar-width: thin`), so every scrollable list -
// e.g. the Documents sidebar once a category is expanded - lost that strip
// on its right edge, while macOS overlay scrollbars take none. Opt Linux into
// Chromium's overlay scrollbars so the hidden-until-hover scrollbar styling
// in src/index.css behaves the same on every platform. Must run before
// `ready`; merged with any enable-features already on the command line.
if (process.platform === 'linux') {
  const enabledFeatures = app.commandLine.getSwitchValue('enable-features');
  app.commandLine.appendSwitch(
    'enable-features',
    [enabledFeatures, 'OverlayScrollbar'].filter(Boolean).join(',')
  );
}

// ---------------------------------------------------------------------------
// Profile picker window + the relaunch with the chosen profile
// ---------------------------------------------------------------------------
let pickerWindow = null;

function createProfilePickerWindow() {
  pickerWindow = new BrowserWindow({
    width: 560,
    height: 520,
    resizable: false,
    title: 'Choose a profile - Jacarium',
    icon: WINDOW_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'profile-picker-preload.cjs'),
      // in-memory session: the picker stores nothing
      partition: 'picker'
    }
  });
  const pickerPath = path.join(__dirname, 'profile-picker.html');
  installNavigationGuards(pickerWindow.webContents, {
    appEntryUrl: pathToFileURL(pickerPath).href,
    openExternal: openExternalUrl,
    log: (message) => console.log(message)
  });
  pickerWindow.loadFile(pickerPath);
  pickerWindow.on('closed', () => { pickerWindow = null; });
}

/** Start the app again with a profile chosen (or the picker, with no name). */
function relaunchWithProfile(name) {
  const args = profiles.stripProfileArgs(process.argv.slice(1));
  args.push(name ? '--profile' : '--profile-picker');
  if (name) args.push(name);
  app.relaunch({ args });
  app.exit(0);
}

function switchProfile() {
  relaunchWithProfile(null);
}

ipcMain.handle('profiles:list', () => profiles.listProfiles(PROFILES_ROOT, DEFAULT_PROFILE_DIR)
  .map(({ name, displayName, isDefault, lastUsedAt, exists }) => ({ name, displayName, isDefault, lastUsedAt, exists })));

ipcMain.handle('profiles:create', (event, name) => {
  const checked = profiles.validateProfileName(name);
  if (!checked.ok) throw new Error(checked.error);
  const dir = profiles.profileDir(PROFILES_ROOT, checked.value, DEFAULT_PROFILE_DIR);
  if (fs.existsSync(dir)) throw new Error(`A profile named "${checked.value}" already exists`);
  profiles.prepareProfile(dir, checked.value, { seed: profiles.seedHome(process.env, app.getPath('home')) });
  return { name: checked.value, dir };
});

ipcMain.handle('profiles:choose', (event, name, remember) => {
  const checked = name === profiles.DEFAULT_PROFILE ? { ok: true, value: name } : profiles.validateProfileName(name);
  if (!checked.ok) throw new Error(checked.error);
  profiles.writeProfilesSettings(PROFILES_ROOT, { defaultProfile: remember ? checked.value : null });
  relaunchWithProfile(checked.value);
  return true;
});

ipcMain.handle('get-profile-name', () => activeProfile);
ipcMain.handle('switch-profile', () => { switchProfile(); return true; });

// ---------------------------------------------------------------------------
// Home server link (electron/home-server.cjs): this profile's data
// synchronises with an account on a browser-deployment server. The token
// lives in userData, encrypted with safeStorage; requests go through this
// process with the token, pinned TLS, no Sec-Fetch headers.
// ---------------------------------------------------------------------------
const homeServer = require('./home-server.cjs');

function homeServerContext() {
  const { safeStorage } = require('electron');
  return {
    storePath: path.join(app.getPath('userData'), homeServer.STORE_FILE),
    pinsPath: centralCertPinsPath(),
    safeStorage,
    onPinMismatch: (result) => warnCertificateMismatch(result.host, result),
  };
}

ipcMain.handle('home-server:status', () => homeServer.homeServerStatus(homeServerContext()));

// The home server is the user's own machine on their own network. These
// requests go out from this process (electron/home-server.cjs), not through
// the renderer's session.
ipcMain.handle('home-server:link', async (event, { url, username, password } = {}) => {
  const result = await homeServer.linkHomeServer({
    url, username, password,
    deviceName: `${require('os').hostname()} (${profiles.machineUsernameForProfile(require('os').userInfo().username, activeProfile)})`,
    ...homeServerContext(),
  });
  return result;
});

ipcMain.handle('home-server:unlink', async () => {
  // the account's settings leave with the link (cache, overlay, scope)
  try { await getAccountSettings().wipe({ reason: 'unlink' }); } catch (error) { console.warn('[Settings] wipe on unlink:', error.message); }
  return homeServer.unlinkHomeServer(homeServerContext());
});

// ---------------------------------------------------------------------------
// Settings scope (electron/account-settings.cjs): this profile runs on its
// own settings file or, as a whole, on its account's settings from the
// home server - fetched here with the device token, secrets kept in the
// OS keychain, handed to the local backend over the loopback as an
// in-memory overlay. The renderer sees plain values and set / not set.
// ---------------------------------------------------------------------------
let accountSettingsController = null;
function getAccountSettings() {
  if (!accountSettingsController) {
    const { safeStorage } = require('electron');
    const { createAccountSettings } = require('./account-settings.cjs');
    accountSettingsController = createAccountSettings({
      dir: app.getPath('userData'),
      safeStorage,
      homeServer: {
        fetch: (pathName, init) => homeServer.homeServerFetch(pathName, init, homeServerContext()),
        linked: () => !!homeServer.homeServerStatus(homeServerContext()).linked,
      },
      localBackend: {
        post: async (pathName, body) => {
          const port = backendPort || process.env.PORT || '8080';
          const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': appAuthToken, 'X-Requested-With': 'Jacarium' }, body: JSON.stringify(body),
          });
          return { ok: response.ok, status: response.status, text: await response.text() };
        },
      },
      log: (message) => console.log(message),
      onChange: (state) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('account-settings:changed', state);
        }
      },
    });
  }
  return accountSettingsController;
}
ipcMain.handle('account-settings:state', () => getAccountSettings().state());
ipcMain.handle('account-settings:set-scope', (event, scope) => getAccountSettings().setScope(String(scope || 'device')));
ipcMain.handle('account-settings:refresh', () => getAccountSettings().refresh());
ipcMain.handle('account-settings:write', (event, payload) => getAccountSettings().write(payload || {}));
// the migration: the device file is read HERE (its secrets never cross to the renderer)
ipcMain.handle('account-settings:device-summary', () => {
  const values = readEnvValues();
  const summary = { values: {}, secretKeys: [] };
  for (const [key, value] of Object.entries(values)) {
    if (value === '') continue;
    if (isSecretKey(key)) summary.secretKeys.push(key); else summary.values[key] = value;
  }
  return summary;
});
ipcMain.handle('account-settings:copy-from-device', (event, { plainKeys = [], secretKeys = [] } = {}) =>
  getAccountSettings().copyFromDevice({ deviceValues: readEnvValues(), plainKeys: plainKeys.map(String), secretKeys: secretKeys.map(String) }));

// This desktop's version/protocol and the linked (or given) server's - the
// renderer decides what the difference means (src/utils/homeServer.js)
// The protocol this build speaks (protocol.json is packaged next to
// package.json; tests/electron-package-files.test.mjs makes sure of it). A
// build that lost the file must not stop synchronising over it: the value
// below is what protocol.json says at the time of writing
// (tests/app-version-consistency.test.mjs keeps the two equal).
const PROTOCOL_FALLBACK = 2;
function desktopProtocol() {
  try {
    return Number(require(path.join(__dirname, '..', 'protocol.json')).protocol) || PROTOCOL_FALLBACK;
  } catch (error) {
    console.warn('[HomeServer] protocol.json is missing from this build; assuming protocol', PROTOCOL_FALLBACK, '-', error.message);
    return PROTOCOL_FALLBACK;
  }
}
ipcMain.handle('home-server:version', async (event, url) => {
  const desktop = { app: app.getVersion(), protocol: desktopProtocol() };
  const server = await homeServer.homeServerVersion({ ...(url ? { url: String(url) } : {}), ...homeServerContext() });
  return { desktop, server };
});
ipcMain.handle('get-app-version', () => app.getVersion());

// Release check (electron/update-check.cjs): OFF unless the user turns it on
// in Settings > About, then one request a day; "Check now" (About, Help
// menu) any time. It runs here, in the main process, through Electron's
// net.fetch, so the system proxy applies and there is no CORS. The state
// (setting, last result, the version skipped) is update-check.json of the
// profile.
let updateChecker = null;
function detectLinuxPackage() {
  // How the Linux app was installed decides the download offered: an
  // AppImage (the runtime sets APPIMAGE), else the deb on Debian/Ubuntu or
  // the rpm on Fedora/RHEL, else the AppImage.
  if (process.platform !== 'linux' || process.env.APPIMAGE) return null;
  if (fs.existsSync('/etc/debian_version')) return 'deb';
  if (fs.existsSync('/etc/redhat-release') || fs.existsSync('/etc/fedora-release')) return 'rpm';
  return null;
}
function getUpdateChecker() {
  if (!updateChecker) {
    const { net } = require('electron');
    updateChecker = createUpdateChecker({
      currentVersion: app.getVersion(),
      fetch: (url, init) => net.fetch(url, init),
      storePath: path.join(app.getPath('userData'), 'update-check.json'),
      platform: process.platform,
      arch: process.arch,
      env: process.env,
      linuxPackage: detectLinuxPackage,
      log: (message) => console.log(message),
      onUpdate: (status) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('update-available', status);
        }
      }
    });
  }
  return updateChecker;
}
ipcMain.handle('update-check:status', () => getUpdateChecker().status());
ipcMain.handle('update-check:run', () => getUpdateChecker().check({ manual: true }));
ipcMain.handle('update-check:set-auto', (event, enabled) => getUpdateChecker().setAutoCheck(enabled === true));
ipcMain.handle('update-check:dismiss', (event, version) => getUpdateChecker().dismiss(String(version || '')));

ipcMain.handle('home-server:fetch', async (event, pathName, init) => {
  return homeServer.homeServerFetch(String(pathName || ''), init || {}, homeServerContext());
});

app.whenReady().then(async () => {
  // The About panel (macOS app menu / Linux Help menu): the brand's words
  // from package.json, the sync protocol, and the website - a plain link the
  // OS opens in the browser, nothing is fetched from it.
  try {
    const pkg = require('../package.json');
    const protocol = (() => { try { return require('../protocol.json').protocol; } catch { return 1; } })();
    app.setAboutPanelOptions({
      applicationName: 'Jacarium',
      applicationVersion: app.getVersion(),
      version: `sync protocol ${protocol}`,
      credits: `${pkg.description || ''}\n${pkg.homepage || 'https://jacarium.com'} (opens in your browser)${pkg.repository?.url ? `\nSource code: ${pkg.repository.url}` : ''}${[].concat(pkg.funding || []).map((f) => `\nSupport Jacarium: ${typeof f === 'string' ? f : f.url}`).join('')}`,
      website: pkg.homepage || 'https://jacarium.com',
      iconPath: WINDOW_ICON,
      copyright: 'Copyright © 2026 Robin Cernin - AGPL-3.0 licence',
    });
  } catch (err) {
    console.warn('[Startup] about panel not set:', err.message);
  }
  // Set custom application menu
  createApplicationMenu();

  if (profileSelection.ask) {
    console.log(`[Profiles] asking (${profileSelection.reason})`);
    createProfilePickerWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createProfilePickerWindow();
    });
    return;
  }

  if (!backendPort) {
    try {
      backendPort = await profiles.pickFreePort(8080);
    } catch (error) {
      console.error('[Profiles] could not find a free port, using 8080:', error.message);
      backendPort = 8080;
    }
  }
  startBackendServer();
  // the account's settings, if this profile runs on them: fetched once the
  // local backend can take the overlay (it answers /health within seconds)
  setTimeout(() => { getAccountSettings().refresh().catch((error) => console.warn('[Settings] first refresh:', error.message)); }, 4000);
  createWindow();

  // The scheduled release check: a tick shortly after start and then every
  // hour; each tick does nothing unless the check is turned on and a day
  // has passed (update-check.cjs).
  const tickUpdateCheck = () => { getUpdateChecker().tick().catch(() => {}); };
  const firstTick = setTimeout(tickUpdateCheck, 20 * 1000);
  const hourlyTick = setInterval(tickUpdateCheck, 60 * 60 * 1000);
  if (typeof firstTick.unref === 'function') firstTick.unref();
  if (typeof hourlyTick.unref === 'function') hourlyTick.unref();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

// IPC handlers (if needed for direct Electron-React communication)
ipcMain.handle('get-app-path', () => {
  return app.getPath('userData');
});

// Check if app is packaged (production build)
ipcMain.handle('is-packaged', () => {
  return app.isPackaged;
});

// Open URL in default system browser
// Open a URL in the OS default browser / mail client - only http(s) and
// mailto ever reach shell.openExternal. Shared by the 'open-external' IPC
// channel and by the navigation guards on every window.
async function openExternalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    return;
  }
  // The URL is never loaded inside an app window (navigation-guard.cjs
  // cancels remote navigation and window.open); the OS browser or mail
  // client gets it.
  await shell.openExternal(url);
}

ipcMain.handle('open-external', async (event, url) => {
  await openExternalUrl(url);
});

// Get local network IPs
ipcMain.handle('get-local-ips', async () => {
  try {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    const allIps = [];

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip internal (loopback) and non-IPv4 addresses
        if (iface.family === 'IPv4' && !iface.internal) {
          allIps.push({
            interface: name,
            address: iface.address,
            priority: getInterfacePriority(name)
          });
        }
      }
    }

    // Sort by priority (higher priority first)
    allIps.sort((a, b) => b.priority - a.priority);

    // Filter out home wifi (wlp) if there are better options
    const hasHigherPriority = allIps.some(ip => ip.priority > 1);
    const filteredIps = hasHigherPriority
      ? allIps.filter(ip => ip.priority > 1)
      : allIps;

    // Remove priority field before returning
    return filteredIps.map(({ interface: iface, address }) => ({
      interface: iface,
      address
    }));
  } catch (error) {
    console.error('Error getting local IPs:', error);
    return [];
  }
});

// Helper function to determine interface priority
function getInterfacePriority(interfaceName) {
  const name = interfaceName.toLowerCase();

  // Highest priority: VPN/work network (tun, tap, vpn)
  if (name.startsWith('tun') || name.startsWith('tap') || name.includes('vpn')) {
    return 10;
  }

  // High priority: Wired ethernet (eth, en, eno, enp, ens)
  if (name.startsWith('eth') || name.startsWith('en')) {
    return 5;
  }

  // Medium priority: Generic wired
  if (name.startsWith('em')) {
    return 4;
  }

  // Low priority: Wireless (wlan, wifi)
  if (name.startsWith('wlan') || name.startsWith('wifi')) {
    return 2;
  }

  // Lowest priority: Home wifi (wlp)
  if (name.startsWith('wlp')) {
    return 1;
  }

  // Default priority for unknown interfaces
  return 3;
}

// Get username
ipcMain.handle('get-username', async () => {
  try {
    const os = require('os');
    // user+<profile> for a named profile: each profile is its own cloud identity
    return profiles.machineUsernameForProfile(os.userInfo().username, activeProfile);
  } catch (error) {
    console.error('Error getting username:', error);
    return 'unknown';
  }
});

// Get hostname
ipcMain.handle('get-hostname', async () => {
  try {
    const os = require('os');
    return os.hostname();
  } catch (error) {
    console.error('Error getting hostname:', error);
    return 'unknown';
  }
});

// Get machine ID override from environment variable (development and testing builds)
ipcMain.handle('get-machine-id-override', async () => {
  // Allow machine ID override in development
  if (!app.isPackaged) {
    return process.env.MACHINE_ID || null;
  }

  // In packaged builds, check if this is a testing build
  try {
    const buildConfig = require('../build-mode.cjs');
    if (buildConfig.buildMode === 'testing') {
      console.log('[Testing Mode] Allowing MACHINE_ID override:', process.env.MACHINE_ID);
      return process.env.MACHINE_ID || null;
    }
  } catch (err) {
    // build-mode.cjs doesn't exist, assume production
  }

  return null;
});

// Get backend port
ipcMain.handle('get-backend-port', async () => {
  return String(backendPort || process.env.PORT || '8080');
});

// Get the shared-secret auth token the renderer must send as the
// X-App-Token header on every backend request. This is only reachable via
// the isolated preload/contextBridge channel, never via a `window` global,
// so an arbitrary web page cannot obtain it.
ipcMain.handle('get-app-token', async () => {
  return appAuthToken;
});

// Read environment file
ipcMain.handle('read-env-file', async () => {
  // The dialog's secrets (API keys, tokens, passwords) never reach the
  // renderer: this returns the plain settings only. The Settings dialog
  // uses 'read-settings' (plain values + which secrets are stored).
  try {
    return withoutSecrets(readEnvValues());
  } catch (error) {
    console.error('Error reading env file:', error);
    throw new Error('Failed to read settings file: ' + error.message);
  }
});

function envFilePath() {
  const os = require('os');
  // the profile's own settings file (~/.jacarium.env for the default one)
  return PROFILE_ENV_FILE || path.join(os.homedir(), '.jacarium.env');
}

/** The KEY=VALUE pairs of ~/.jacarium.env ({} when it does not exist). */
function readEnvValues() {
  const envPath = envFilePath();
  if (!fs.existsSync(envPath)) return {};
  return parseEnvFile(fs.readFileSync(envPath, 'utf8'));
}

/** Serialize + write the file (sectioned, commented) and return true. */
function writeEnvValues(envData) {
  const envPath = envFilePath();
  const content = buildEnvFileContent(envData);
  fs.writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 });
  console.log('Environment file saved:', envPath);
  return true;
}

// The Settings dialog's contract (electron/settings-store.cjs): plain
// values + which secrets are stored; a save changes a secret only when a
// new value is typed (null clears it), so saving never wipes one.
ipcMain.handle('read-settings', async () => {
  try {
    return publicView(readEnvValues());
  } catch (error) {
    console.error('Error reading settings:', error);
    throw new Error('Failed to read settings file: ' + error.message);
  }
});

/** The settings file back into process.env after a save: what the main process reads (Jira, the AI keys) follows the dialog without a restart. */
function reloadEnvironment() {
  try {
    loadEnvironmentVariables({ devEnvDir: app.isPackaged ? null : path.join(__dirname, '..'), userEnvFile: PROFILE_ENV_FILE });
  } catch (error) {
    console.warn('[Settings] could not re-read the settings file:', error.message);
  }
}

ipcMain.handle('write-settings', async (event, payload) => {
  try {
    const merged = mergeSettings(readEnvValues(), payload || {});
    writeEnvValues(merged);
    reloadEnvironment();
    return publicView(merged);
  } catch (error) {
    console.error('Error writing settings:', error);
    throw new Error('Failed to save settings file: ' + error.message);
  }
});

// Write environment file (legacy flat-object contract). Secrets the
// payload leaves empty keep their stored value - see settings-store.cjs.
ipcMain.handle('write-env-file', async (event, envData) => {
  try {
    // Never let a value carry a line break into the KEY=VALUE file (it would
    // inject extra settings on read-back) - see electron/env-file.cjs.
    envData = sanitizeEnvData(envData);
    const merged = mergeLegacyEnvData(readEnvValues(), envData);
    const written = writeEnvValues(merged);
    reloadEnvironment();
    return written;
  } catch (error) {
    console.error('Error writing env file:', error);
    throw new Error('Failed to save settings file: ' + error.message);
  }
});

/** The sectioned, commented ~/.jacarium.env text for the given values. */
function buildEnvFileContent(envData) {
    // Never let a value carry a line break into the KEY=VALUE file (it would
    // inject extra settings on read-back) - see electron/env-file.cjs.
    envData = sanitizeEnvData(envData);

    // Build file content
    let content = '# Jacarium settings\n';
    content += '# This file is auto-generated by the Settings dialog\n';
    content += '# Configure the API keys and tokens for the services you want to use\n\n';

    // Add JIRA section if anything of it is set
    if (envData.JIRA_PAT || envData.JIRA_EMAIL || envData.JIRA_URL) {
      content += '# JIRA Configuration\n';
      content += '# JIRA_URL is your Jira site (an https:// origin, no path) - there is no default.\n';
      content += '# For Atlassian Cloud, you need both your email and API token:\n';
      content += '# 1. Get your API Token from: https://id.atlassian.com/manage-profile/security/api-tokens\n';
      content += '# 2. Use the email address associated with your Atlassian account\n';
      if (envData.JIRA_URL) {
        content += `JIRA_URL=${envData.JIRA_URL}\n`;
      } else {
        content += '# JIRA_URL=https://your-company.atlassian.net\n';
      }
      if (envData.JIRA_EMAIL) {
        content += `JIRA_EMAIL=${envData.JIRA_EMAIL}\n`;
      } else {
        content += '# JIRA_EMAIL=you@example.com\n';
      }
      if (envData.JIRA_PAT) {
        content += `JIRA_PAT=${envData.JIRA_PAT}\n`;
      }
      content += '\n';
    }

    // Add OpenAI section if key present
    if (envData.OPENAI_API_KEY) {
      content += '# OpenAI Configuration\n';
      content += `OPENAI_API_KEY=${envData.OPENAI_API_KEY}\n\n`;
    }

    // Add Anthropic (Claude) section if any keys present
    const anthropicKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_USE_BEDROCK', 'AWS_REGION', 'ANTHROPIC_USE_VERTEX', 'ANTHROPIC_GCP_PROJECT_ID', 'ANTHROPIC_GCP_LOCATION', 'ANTHROPIC_VERTEX_MODELS'];
    const hasAnthropicKeys = anthropicKeys.some(key => envData[key]);
    if (hasAnthropicKeys) {
      content += '# Anthropic (Claude) Configuration\n';

      if (envData.ANTHROPIC_API_KEY) {
        content += '# Option 1: Use API Key (default)\n';
        content += `ANTHROPIC_API_KEY=${envData.ANTHROPIC_API_KEY}\n\n`;
      }

      const bedrockKeys = ['ANTHROPIC_USE_BEDROCK', 'AWS_REGION'];
      if (bedrockKeys.some(key => envData[key])) {
        content += '# Option 2: Use AWS Bedrock with AWS credentials\n';
        content += '# Set ANTHROPIC_USE_BEDROCK=true to use AWS Bedrock instead of API key\n';
        content += '# Make sure you\'re authenticated with AWS CLI: aws configure\n';
        if (envData.ANTHROPIC_USE_BEDROCK) content += `ANTHROPIC_USE_BEDROCK=${envData.ANTHROPIC_USE_BEDROCK}\n`;
        if (envData.AWS_REGION) content += `AWS_REGION=${envData.AWS_REGION}\n`;
        content += '\n';
      }

      const vertexKeys = ['ANTHROPIC_USE_VERTEX', 'ANTHROPIC_GCP_PROJECT_ID', 'ANTHROPIC_GCP_LOCATION', 'ANTHROPIC_VERTEX_MODELS'];
      if (vertexKeys.some(key => envData[key])) {
        content += '# Option 3: Use Google Cloud Vertex AI with gcloud authentication\n';
        content += '# Set ANTHROPIC_USE_VERTEX=true to use Vertex AI instead of API key\n';
        content += '# Make sure you\'re authenticated with: gcloud auth application-default login\n';
        if (envData.ANTHROPIC_USE_VERTEX) content += `ANTHROPIC_USE_VERTEX=${envData.ANTHROPIC_USE_VERTEX}\n`;
        if (envData.ANTHROPIC_GCP_PROJECT_ID) content += `ANTHROPIC_GCP_PROJECT_ID=${envData.ANTHROPIC_GCP_PROJECT_ID}\n`;
        if (envData.ANTHROPIC_GCP_LOCATION) content += `ANTHROPIC_GCP_LOCATION=${envData.ANTHROPIC_GCP_LOCATION}\n`;
        if (envData.ANTHROPIC_VERTEX_MODELS) content += `ANTHROPIC_VERTEX_MODELS=${envData.ANTHROPIC_VERTEX_MODELS}\n`;
        content += '\n';
      }
    }

    // Add Google Gemini section if any keys present
    const geminiKeys = ['GEMINI_API_KEY', 'GEMINI_USE_VERTEX', 'GEMINI_PROJECT_ID', 'GEMINI_LOCATION', 'GEMINI_VERTEX_MODELS'];
    const hasGeminiKeys = geminiKeys.some(key => envData[key]);
    if (hasGeminiKeys) {
      content += '# Google Gemini Configuration\n';

      if (envData.GEMINI_API_KEY) {
        content += '# Option 1: Use API Key (default)\n';
        content += `GEMINI_API_KEY=${envData.GEMINI_API_KEY}\n\n`;
      }

      const geminiVertexKeys = ['GEMINI_USE_VERTEX', 'GEMINI_PROJECT_ID', 'GEMINI_LOCATION', 'GEMINI_VERTEX_MODELS'];
      if (geminiVertexKeys.some(key => envData[key])) {
        content += '# Option 2: Use Vertex AI with gcloud authentication\n';
        content += '# Set GEMINI_USE_VERTEX=true to use Vertex AI instead of API key\n';
        content += '# Make sure you\'re authenticated with: gcloud auth application-default login\n';
        if (envData.GEMINI_USE_VERTEX) content += `GEMINI_USE_VERTEX=${envData.GEMINI_USE_VERTEX}\n`;
        if (envData.GEMINI_PROJECT_ID) content += `GEMINI_PROJECT_ID=${envData.GEMINI_PROJECT_ID}\n`;
        if (envData.GEMINI_LOCATION) content += `GEMINI_LOCATION=${envData.GEMINI_LOCATION}\n`;
        if (envData.GEMINI_VERTEX_MODELS) content += `GEMINI_VERTEX_MODELS=${envData.GEMINI_VERTEX_MODELS}\n`;
        content += '\n';
      }
    }

    // Add Google Calendar section if any keys present
    const googleCalendarKeys = ['GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET'];
    const hasGoogleCalendarKeys = googleCalendarKeys.some(key => envData[key]);
    if (hasGoogleCalendarKeys) {
      content += '# Google Calendar Configuration\n';
      content += '# OAuth 2.0 credentials for Google Calendar API\n';
      content += '# 1. Go to: https://console.cloud.google.com/apis/credentials\n';
      content += '# 2. Create OAuth 2.0 Client ID (Desktop application)\n';
      content += '# 3. Copy the Client ID and Client Secret below\n';
      if (envData.GOOGLE_CALENDAR_CLIENT_ID) {
        content += `GOOGLE_CALENDAR_CLIENT_ID=${envData.GOOGLE_CALENDAR_CLIENT_ID}\n`;
      }
      if (envData.GOOGLE_CALENDAR_CLIENT_SECRET) {
        content += `GOOGLE_CALENDAR_CLIENT_SECRET=${envData.GOOGLE_CALENDAR_CLIENT_SECRET}\n`;
      }
      content += '\n';
    }

    // Add HuggingFace section if any keys present
    const huggingfaceKeys = ['HF_TOKEN', 'HF_EMBEDDING_MODEL'];
    const hasHuggingfaceKeys = huggingfaceKeys.some(key => envData[key]);
    if (hasHuggingfaceKeys) {
      content += '# HuggingFace Configuration\n';
      content += '# Used for RAG embedding model downloads\n';
      content += '# Get your token from: https://huggingface.co/settings/tokens\n';
      if (envData.HF_TOKEN) {
        content += `HF_TOKEN=${envData.HF_TOKEN}\n`;
      }
      if (envData.HF_EMBEDDING_MODEL) {
        content += '# Embedding model for RAG (default: BAAI/bge-small-en-v1.5)\n';
        content += '# See supported models: https://qdrant.github.io/fastembed/examples/Supported_Models/\n';
        content += `HF_EMBEDDING_MODEL=${envData.HF_EMBEDDING_MODEL}\n`;
      }
      content += '\n';
    }

    // Add Custom AI Endpoint section if any keys present
    const customKeys = ['CUSTOM_AI_ENDPOINT', 'CUSTOM_API_KEY'];
    const hasCustomKeys = customKeys.some(key => envData[key]);
    if (hasCustomKeys) {
      content += '# Custom AI Endpoint (optional)\n';
      customKeys.forEach(key => {
        if (envData[key]) {
          content += `${key}=${envData[key]}\n`;
        }
      });
      content += '\n';
    }

    // Add Default AI Settings section if any keys present
    const defaultAiKeys = ['DEFAULT_AI_PROVIDER', 'DEFAULT_AI_MODEL', 'DEFAULT_AI_TEMPERATURE', 'DEFAULT_AI_MAX_TOKENS'];
    const hasDefaultAiKeys = defaultAiKeys.some(key => envData[key]);
    if (hasDefaultAiKeys) {
      content += '# Default AI Settings\n';
      content += '# Used by Quick AI, Ask AI features, and new AI Chat conversations\n';
      defaultAiKeys.forEach(key => {
        if (envData[key]) {
          content += `${key}=${envData[key]}\n`;
        }
      });
      content += '\n';
    }

    // Add SSH AI Configuration section if any keys present
    const sshKeys = ['SSH_AI_DISPLAY_NAME', 'SSH_AI_HOST', 'SSH_AI_USER', 'SSH_AI_PASSWORD', 'SSH_AI_COMMAND_INITIAL', 'SSH_AI_COMMAND_FOLLOWUP'];
    const hasSSHKeys = sshKeys.some(key => envData[key]);
    if (hasSSHKeys) {
      content += '# SSH AI Configuration\n';
      content += '# For using gemini-cli or other AI tools over SSH\n';
      if (envData.SSH_AI_DISPLAY_NAME) {
        content += `SSH_AI_DISPLAY_NAME=${envData.SSH_AI_DISPLAY_NAME}\n`;
      }
      if (envData.SSH_AI_HOST) {
        content += `SSH_AI_HOST=${envData.SSH_AI_HOST}\n`;
      }
      if (envData.SSH_AI_USER) {
        content += `SSH_AI_USER=${envData.SSH_AI_USER}\n`;
      }
      if (envData.SSH_AI_PASSWORD) {
        content += `SSH_AI_PASSWORD=${envData.SSH_AI_PASSWORD}\n`;
      }
      if (envData.SSH_AI_COMMAND_INITIAL) {
        content += `SSH_AI_COMMAND_INITIAL=${envData.SSH_AI_COMMAND_INITIAL}\n`;
      }
      if (envData.SSH_AI_COMMAND_FOLLOWUP) {
        content += `SSH_AI_COMMAND_FOLLOWUP=${envData.SSH_AI_COMMAND_FOLLOWUP}\n`;
      }
      content += '\n';
    }

    return content;
}

// WHOIS lookup using direct TCP connection to WHOIS servers
ipcMain.handle('whois-lookup', async (event, domain) => {
  const net = require('net');

  // Get the appropriate WHOIS server for the domain
  const getWhoisServer = (domain) => {
    const tld = domain.split('.').pop().toLowerCase();

    // Map of TLD to WHOIS servers
    const whoisServers = {
      'com': 'whois.verisign-grs.com',
      'net': 'whois.verisign-grs.com',
      'org': 'whois.pir.org',
      'info': 'whois.afilias.net',
      'biz': 'whois.biz',
      'us': 'whois.nic.us',
      'uk': 'whois.nic.uk',
      'co.uk': 'whois.nic.uk',
      'io': 'whois.nic.io',
      'dev': 'whois.nic.google',
      'app': 'whois.nic.google',
      'ai': 'whois.nic.ai',
      'me': 'whois.nic.me',
      'tv': 'whois.nic.tv',
      'cc': 'whois.nic.cc',
      'de': 'whois.denic.de',
      'fr': 'whois.nic.fr',
      'eu': 'whois.eu',
      'ru': 'whois.tcinet.ru',
      'nl': 'whois.domain-registry.nl',
      'br': 'whois.registro.br',
      'au': 'whois.auda.org.au',
      'cn': 'whois.cnnic.cn',
      'jp': 'whois.jprs.jp',
      'kr': 'whois.kr',
      'in': 'whois.registry.in',
      'ca': 'whois.cira.ca'
    };

    return whoisServers[tld] || 'whois.iana.org';
  };

  const queryWhois = (server, domain) => {
    return new Promise((resolve, reject) => {
      const client = net.createConnection({ port: 43, host: server }, () => {
        client.write(domain + '\r\n');
      });

      let data = '';
      client.on('data', (chunk) => {
        data += chunk.toString();
      });

      client.on('end', () => {
        resolve(data);
      });

      client.on('error', (err) => {
        reject(err);
      });

      // Timeout after 10 seconds
      client.setTimeout(10000, () => {
        client.destroy();
        reject(new Error('WHOIS query timed out'));
      });
    });
  };

  try {
    console.log('[Electron whois-lookup] Looking up domain:', domain);

    const server = getWhoisServer(domain);
    console.log('[Electron whois-lookup] Using WHOIS server:', server);

    let result = await queryWhois(server, domain);

    // Check if we need to follow a referral
    const referralMatch = result.match(/Registrar WHOIS Server:\s*(\S+)/i) ||
                         result.match(/refer:\s*(\S+)/i) ||
                         result.match(/ReferralServer:\s*whois:\/\/(\S+)/i);

    if (referralMatch && referralMatch[1]) {
      const referralServer = referralMatch[1].replace('whois://', '');
      console.log('[Electron whois-lookup] Following referral to:', referralServer);

      try {
        const referralResult = await queryWhois(referralServer, domain);
        // Append referral result to original
        result += '\n\n--- Detailed Information from ' + referralServer + ' ---\n\n' + referralResult;
      } catch (err) {
        console.warn('[Electron whois-lookup] Referral query failed:', err.message);
        // Continue with original result
      }
    }

    console.log('[Electron whois-lookup] Success, result length:', result.length);
    return result;
  } catch (error) {
    console.error('[Electron whois-lookup] Error:', error);
    throw new Error(error.message || 'WHOIS lookup failed');
  }
});

// Shared helper for the standalone page windows (no sidebar) opened by the
// 'open-*-window' IPC handlers below.
async function openStandaloneWindow({ width, height, title, standaloneMode, errorLabel }) {
  try {
    const standaloneWindow = new BrowserWindow({
      width,
      height,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.cjs'),
        // See the webSecurity comment on the main window in createWindow().
        webSecurity: true
      },
      icon: WINDOW_ICON,
      title
    });

    applyZoomOnLoad(standaloneWindow);

    const indexPath = path.join(__dirname, '../dist/index.html');

    // Same navigation policy as the main window (electron/navigation-guard.cjs).
    installNavigationGuards(standaloneWindow.webContents, {
      appEntryUrl: app.isPackaged ? pathToFileURL(indexPath).href : DEV_SERVER_URL,
      openExternal: openExternalUrl,
      log: (message) => console.log(message)
    });

    // Load the app in the requested standalone mode (no sidebar)
    if (!app.isPackaged) {
      // Development: load from Vite dev server with standalone parameter
      await standaloneWindow.loadURL(`${DEV_SERVER_URL}/?standalone=${standaloneMode}`);
    } else {
      // Production: load index.html with standalone parameter
      await standaloneWindow.loadFile(indexPath, { query: { standalone: standaloneMode } });
    }

    return { success: true };
  } catch (error) {
    console.error(`Error opening ${errorLabel} window:`, error);
    return { success: false, error: error.message };
  }
}

ipcMain.handle('open-tools-window', () =>
  openStandaloneWindow({ width: 1200, height: 800, title: 'Tools - Jacarium', standaloneMode: 'tools', errorLabel: 'Tools' })
);

ipcMain.handle('open-diagnostics-window', () =>
  openStandaloneWindow({ width: 1400, height: 900, title: 'Diagnostics - Jacarium', standaloneMode: 'diagnostics', errorLabel: 'Diagnostics' })
);

ipcMain.handle('open-search-window', () =>
  openStandaloneWindow({ width: 1400, height: 900, title: 'JQL Search - Jacarium', standaloneMode: 'search', errorLabel: 'Search' })
);

ipcMain.handle('open-ai-chat-window', () =>
  openStandaloneWindow({ width: 1400, height: 900, title: 'Robin - Jacarium', standaloneMode: 'ai-chat', errorLabel: 'AI Chat' })
);

ipcMain.handle('open-calendar-window', () =>
  openStandaloneWindow({ width: 1400, height: 900, title: 'Calendar - Jacarium', standaloneMode: 'calendars', errorLabel: 'Calendar' })
);

ipcMain.handle('open-kanban-window', () =>
  openStandaloneWindow({ width: 1600, height: 900, title: 'Kanban - Jacarium', standaloneMode: 'kanban', errorLabel: 'Kanban' })
);

ipcMain.handle('open-workflow-window', () =>
  openStandaloneWindow({ width: 1600, height: 900, title: 'Workflow Builder - Jacarium', standaloneMode: 'workflow', errorLabel: 'Workflow Builder' })
);

ipcMain.handle('open-tasks-window', () =>
  openStandaloneWindow({ width: 1400, height: 900, title: 'Tasks - Jacarium', standaloneMode: 'tasks', errorLabel: 'Tasks' })
);

// Generic HTTP request proxy for workflow "restapi" nodes. Runs in the main
// process, which is not subject to the renderer's CORS/webSecurity
// restrictions, so workflow HTTP-request steps can still reach arbitrary
// user-configured URLs now that webSecurity is enabled on BrowserWindows.
// Mirrors the exact fetch()-based logic that used to run directly in the
// renderer (src/utils/workflowExecution.js's 'restapi' case).
// Workflow REST nodes run URLs that may have arrived in a synced workflow, so
// the request is guarded (electron/safe-url.cjs): scheme/host validated and
// resolved, loopback/link-local (cloud metadata)/unspecified/multicast always
// rejected, intranet (RFC1918) hosts allowed by default because users target
// them legitimately (JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS=0 disables),
// connection pinned to the validated address, every redirect hop
// re-validated, body capped at 10 MB.
ipcMain.handle('workflow-http-request', async (event, url, options = {}) => {
  const response = await safeRequest(url, options, {
    allowPrivate: workflowPrivateUrlsAllowed()
  });
  const contentType = response.headers['content-type'];
  const isJson = !!(contentType && contentType.includes('application/json'));
  let body = response.text;
  if (isJson) {
    try {
      body = JSON.parse(response.text);
    } catch {
      // Declared JSON but unparsable: hand back the raw text as before.
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    body
  };
});

// JIRA API proxy for production builds
// The Jira site comes from Settings > Integrations > Jira (JIRA_URL in the
// env file, loaded into process.env like the other settings): an https://
// origin without a path. There is no built-in default - without it the
// request fails with a message that names the setting.

ipcMain.handle('jira-fetch', async (event, endpoint, options = {}) => {
  // Jira is optional: without a site or a token nothing is requested and
  // nothing is thrown or traced - a clean result the renderer shows as its
  // "Jira isn't set up" state (electron/jira-config.cjs).
  const config = jiraConfig(process.env);
  if (!config.configured) return notConfiguredResult(config, console);
  try {
    const https = require('https');
    const { URL } = require('url');

    console.log('[Electron jira-fetch] Request to:', endpoint);

    // Get JIRA credentials and site from environment
    const JIRA_PAT = process.env.JIRA_PAT;
    const JIRA_EMAIL = process.env.JIRA_EMAIL;
    const JIRA_BASE = config.origin;

    // Build the full URL - endpoint already has /api prefix, so we need to map it
    // /api/project/search -> <JIRA_URL>/rest/api/3/project/search
    const apiPath = endpoint.replace(/^\/api/, '');  // Remove /api prefix
    const fullUrl = `${JIRA_BASE}/rest/api/3${apiPath}`;

    console.log('[Electron jira-fetch] Full URL:', fullUrl);

    const url = new URL(fullUrl);

    // Atlassian Cloud uses Basic Auth with email:token (base64 encoded)
    // If JIRA_EMAIL is not set, try Bearer token as fallback
    let authHeader;
    if (JIRA_EMAIL) {
      const credentials = `${JIRA_EMAIL}:${JIRA_PAT}`;
      const base64Credentials = Buffer.from(credentials).toString('base64');
      authHeader = `Basic ${base64Credentials}`;
      console.log('[Electron jira-fetch] Using Basic Auth with email:', JIRA_EMAIL);
    } else {
      authHeader = `Bearer ${JIRA_PAT}`;
      console.log('[Electron jira-fetch] Using Bearer Auth (no email configured)');
    }

    const requestOptions = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      checkServerIdentity: certDistrust.checkServerIdentity,   // the distrust list (electron/cert-distrust.cjs)
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...options.headers
      }
    };

    console.log('[Electron jira-fetch] Request options:', {
      hostname: requestOptions.hostname,
      path: requestOptions.path,
      method: requestOptions.method,
      headers: { ...requestOptions.headers, Authorization: authHeader.split(' ')[0] + ' ***' }
    });

    return new Promise((resolve, reject) => {
      const req = https.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          // Debug output deliberately omits the response headers (Set-Cookie,
          // rate-limit tokens, tracing ids) and the body (issue content) -
          // status, content-type and size carry the diagnostic value.
          console.log('[Electron jira-fetch] Response status:', res.statusCode,
            'content-type:', res.headers['content-type'], 'bytes:', data.length);

          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const jsonData = JSON.parse(data);
              console.log('[Electron jira-fetch] Success! Response keys:', Object.keys(jsonData));
              resolve({
                ok: true,
                status: res.statusCode,
                statusText: res.statusMessage,
                data: jsonData
              });
            } catch (error) {
              console.error('[Electron jira-fetch] JSON parse error:', error);
              reject(new Error(`Failed to parse JSON response: ${error.message}`));
            }
          } else {
            console.error('[Electron jira-fetch] HTTP error:', res.statusCode);
            console.error('[Electron jira-fetch] Error response body:', data);
            try {
              const errorData = JSON.parse(data);
              console.error('[Electron jira-fetch] Parsed error:', errorData);
              const errorMsg = errorData.errorMessages?.[0] || errorData.message || `HTTP ${res.statusCode}`;
              reject(new Error(errorMsg + (errorData.errors ? ` - ${JSON.stringify(errorData.errors)}` : '')));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          }
        });
      });

      req.on('error', (error) => {
        console.error('[Electron jira-fetch] Request error:', error);
        reject(error);
      });

      // Write body if provided
      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }

      req.end();
    });
  } catch (error) {
    console.error('[Electron jira-fetch] Exception:', error);
    throw error;
  }
});
