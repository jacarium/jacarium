const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  isPackaged: () => ipcRenderer.invoke('is-packaged'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onNavigateToPage: (callback) => ipcRenderer.on('navigate-to-page', (event, page) => callback(page)),
  onShowWhatsNew: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('show-whats-new', listener);
    // Return cleanup function
    return () => ipcRenderer.removeListener('show-whats-new', listener);
  },
  onExportDatabase: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('export-database', listener);
    return () => ipcRenderer.removeListener('export-database', listener);
  },
  onImportDatabase: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('import-database', listener);
    return () => ipcRenderer.removeListener('import-database', listener);
  },
  onWipeDatabase: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('wipe-database', listener);
    return () => ipcRenderer.removeListener('wipe-database', listener);
  },
  onOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('open-settings', listener);
    return () => ipcRenderer.removeListener('open-settings', listener);
  },
  onToggleSidebar: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('toggle-sidebar', listener);
    return () => ipcRenderer.removeListener('toggle-sidebar', listener);
  },
  platform: process.platform,
  isElectron: true,
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),
  getAppToken: () => ipcRenderer.invoke('get-app-token'),
  // Documents PDF export through Chromium's print engine in the main
  // process (electron/pdf-export.cjs). Progress arrives per jobId; the
  // unsubscribe function returned by onExportPdfProgress must be called
  // when the export settles.
  exportPdf: (payload) => ipcRenderer.invoke('export-pdf', payload),
  cancelExportPdf: (jobId) => ipcRenderer.invoke('export-pdf-cancel', jobId),
  onExportPdfProgress: (callback) => {
    const listener = (event, update) => callback(update);
    ipcRenderer.on('export-pdf-progress', listener);
    return () => ipcRenderer.removeListener('export-pdf-progress', listener);
  },
  getLocalIps: () => ipcRenderer.invoke('get-local-ips'),
  readEnvFile: () => ipcRenderer.invoke('read-env-file'),
  writeEnvFile: (envData) => ipcRenderer.invoke('write-env-file', envData),
  // Settings dialog: plain values + which secrets are stored (never their
  // values); a save changes a secret only when a new one is typed.
  readSettings: () => ipcRenderer.invoke('read-settings'),
  writeSettings: (payload) => ipcRenderer.invoke('write-settings', payload),
  // UI zoom: the main process owns the current zoom factor (it applies it
  // to every window's webContents and persists it across restarts). The
  // changed event fires on every zoom change - menu shortcut or Settings
  // dropdown - so the Settings UI never shows a stale value.
  getZoomFactor: () => ipcRenderer.invoke('get-zoom-factor'),
  setZoomFactor: (factor) => ipcRenderer.invoke('set-zoom-factor', factor),
  onZoomFactorChanged: (callback) => {
    const listener = (event, factor) => callback(factor);
    ipcRenderer.on('zoom-factor-changed', listener);
    return () => ipcRenderer.removeListener('zoom-factor-changed', listener);
  },
  // Debug status bar: like zoom, the main process owns the toggle (persisted
  // to ui-settings.json) and broadcasts changes to every window. While the
  // bar is enabled the main process also pushes CPU/memory numbers to every
  // window on a single shared interval ('debug-metrics'); see the debug-bar
  // section in main.cjs.
  getDebugBarEnabled: () => ipcRenderer.invoke('get-debug-bar-enabled'),
  setDebugBarEnabled: (enabled) => ipcRenderer.invoke('set-debug-bar-enabled', enabled),
  onDebugBarChanged: (callback) => {
    const listener = (event, enabled) => callback(enabled);
    ipcRenderer.on('debug-bar-changed', listener);
    return () => ipcRenderer.removeListener('debug-bar-changed', listener);
  },
  onDebugMetrics: (callback) => {
    const listener = (event, metrics) => callback(metrics);
    ipcRenderer.on('debug-metrics', listener);
    return () => ipcRenderer.removeListener('debug-metrics', listener);
  },
  getUsername: () => ipcRenderer.invoke('get-username'),
  // Desktop profiles (electron/profiles.cjs): the name of the open one and
  // the picker (the app relaunches)
  getProfileName: () => ipcRenderer.invoke('get-profile-name'),
  switchProfile: () => ipcRenderer.invoke('switch-profile'),
  // Home server link (electron/home-server.cjs): the token never reaches
  // this renderer; requests are made by the main process
  homeServerStatus: () => ipcRenderer.invoke('home-server:status'),
  homeServerLink: (details) => ipcRenderer.invoke('home-server:link', details),
  homeServerUnlink: () => ipcRenderer.invoke('home-server:unlink'),
  homeServerFetch: (path, init) => ipcRenderer.invoke('home-server:fetch', path, init),
  homeServerVersion: (url) => ipcRenderer.invoke('home-server:version', url),
  // the settings scope (electron/account-settings.cjs): plain values and
  // set / not set only - a secret value never crosses this bridge
  accountSettingsState: () => ipcRenderer.invoke('account-settings:state'),
  accountSettingsSetScope: (scope) => ipcRenderer.invoke('account-settings:set-scope', scope),
  accountSettingsRefresh: () => ipcRenderer.invoke('account-settings:refresh'),
  accountSettingsWrite: (payload) => ipcRenderer.invoke('account-settings:write', payload),
  accountSettingsDeviceSummary: () => ipcRenderer.invoke('account-settings:device-summary'),
  accountSettingsCopyFromDevice: (choice) => ipcRenderer.invoke('account-settings:copy-from-device', choice),
  onAccountSettingsChanged: (callback) => {
    const listener = (event, state) => callback(state);
    ipcRenderer.on('account-settings:changed', listener);
    return () => ipcRenderer.removeListener('account-settings:changed', listener);
  },
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  // Release check (electron/update-check.cjs): the status, one request now,
  // the automatic-check setting, "Skip this version", and the main process
  // telling the window that a release is to be shown / that the Help menu
  // asked for a check.
  updateCheckStatus: () => ipcRenderer.invoke('update-check:status'),
  updateCheckRun: () => ipcRenderer.invoke('update-check:run'),
  updateCheckSetAuto: (enabled) => ipcRenderer.invoke('update-check:set-auto', enabled),
  updateCheckDismiss: (version) => ipcRenderer.invoke('update-check:dismiss', version),
  onUpdateAvailable: (callback) => {
    const listener = (event, status) => callback(status);
    ipcRenderer.on('update-available', listener);
    return () => ipcRenderer.removeListener('update-available', listener);
  },
  onCheckForUpdates: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('check-for-updates', listener);
    return () => ipcRenderer.removeListener('check-for-updates', listener);
  },
  getHostname: () => ipcRenderer.invoke('get-hostname'),
  getMachineIdOverride: () => ipcRenderer.invoke('get-machine-id-override'),
  jiraFetch: (endpoint, options) => ipcRenderer.invoke('jira-fetch', endpoint, options),
  // Main-process proxy for workflow "restapi" nodes so they can reach
  // arbitrary user-configured URLs regardless of CORS (webSecurity is
  // enabled on all BrowserWindows); see 'workflow-http-request' in main.cjs.
  workflowHttpRequest: (url, options) => ipcRenderer.invoke('workflow-http-request', url, options),
  whoisLookup: (domain) => ipcRenderer.invoke('whois-lookup', domain),
  openToolsWindow: () => ipcRenderer.invoke('open-tools-window'),
  openDiagnosticsWindow: () => ipcRenderer.invoke('open-diagnostics-window'),
  openSearchWindow: () => ipcRenderer.invoke('open-search-window'),
  openAIChatWindow: () => ipcRenderer.invoke('open-ai-chat-window'),
  openCalendarWindow: () => ipcRenderer.invoke('open-calendar-window'),
  openKanbanWindow: () => ipcRenderer.invoke('open-kanban-window'),
  openWorkflowWindow: () => ipcRenderer.invoke('open-workflow-window'),
  openTasksWindow: () => ipcRenderer.invoke('open-tasks-window')
});
