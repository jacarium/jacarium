import { StrictMode } from 'react'
import StartupError from './components/StartupError.jsx';
import { clearChunkReloadFlag, recoverFromChunkLoadError } from './utils/chunkReload.js';
import { createRoot } from 'react-dom/client'
// The app font (Sora) and the reading and code fonts (Red Hat Text, Red Hat
// Mono), bundled from the @fontsource packages - nothing is loaded from a
// font CDN (tests/no-remote-assets.test.mjs). The diagnostics frame inlines
// the same set (src/components/features/diagnostics/diagnosticsFrameStyles.js).
import '@fontsource/sora/400.css'
import '@fontsource/sora/500.css'
import '@fontsource/sora/600.css'
import '@fontsource/red-hat-text/400.css'
import '@fontsource/red-hat-text/500.css'
import '@fontsource/red-hat-text/600.css'
import '@fontsource/red-hat-mono/400.css'
import '@fontsource/red-hat-mono/500.css'
import './index.css'
import { initializeBackendUrl } from './utils/backendUrl'
import { initializePlatform, isDesktopApp } from './utils/platform'
import { databaseNameFor } from './utils/auth'

console.log('=== App starting ===');
console.log('Environment:', import.meta.env.PROD ? 'PRODUCTION' : 'DEVELOPMENT');

// Initialize backend URL early
initializeBackendUrl();
// Outside the desktop app, ask the backend what it provides (Settings,
// Jira / HTTP proxies, whois, and whether it wants a sign-in) - see
// src/utils/platform.js.
const platform = initializePlatform();

const root = createRoot(document.getElementById('root'));

function render(element) {
  root.render(<StrictMode>{element}</StrictMode>);
}

// The app's database (src/db/database.js) is opened the moment that module
// loads, and with sign-in its name is the account's. So the app bundle is
// imported only once it is known who is signed in: the desktop app and a
// server without accounts load it right away (the one 'Jacarium'
// database); a server with accounts first shows the sign-in page.
async function start() {
  let info = null;
  if (!isDesktopApp()) {
    try { info = await platform; } catch { info = null; }
  }
  const auth = info?.auth;
  if (auth?.mode === 'accounts') {
    if (!auth.user) {
      const { default: AuthGate } = await import('./components/auth/AuthGate.jsx');
      render(<AuthGate setupRequired={auth.setupRequired === true} />);
      return;
    }
    if (auth.user.mustChangePassword) {
      // signed in with a temporary password (host-side recovery): the
      // server refuses everything else until a new one is chosen
      const { default: AuthGate } = await import('./components/auth/AuthGate.jsx');
      render(<AuthGate changePasswordFor={auth.user} />);
      return;
    }
    globalThis.__JACARIUM_DB_NAME = databaseNameFor(auth.user);
    const { shouldOfferLegacyImport } = await import('./utils/legacyImport.js');
    if (await shouldOfferLegacyImport(auth.user.id)) {
      const { default: AuthGate } = await import('./components/auth/AuthGate.jsx');
      render(<AuthGate legacyImportFor={auth.user} />);
      return;
    }
  }
  // The desktop app: with a home server linked (Settings > General), the
  // profile belongs to that account - its browser-local storage is scoped
  // to it (src/utils/accountStorage.js) before anything reads it
  let homeStatus = null;
  if (isDesktopApp()) {
    try {
      const { homeServerSupported, getHomeServerStatus } = await import('./utils/homeServer.js');
      if (homeServerSupported()) homeStatus = await getHomeServerStatus();
    } catch (error) {
      console.error('[Sync] home server status:', error);
    }
    if (homeStatus?.linked && homeStatus.userId) {
      const { setAccountScope } = await import('./utils/accountStorage.js');
      setAccountScope(homeStatus.userId);
    }
  }
  const { default: App } = await import('./App.jsx');
  render(<App />);
  // The account's data synchronises with this server (src/sync/syncEngine.js)
  if (auth?.mode === 'accounts' && auth.user && info?.capabilities?.sync) {
    const { startSync } = await import('./sync/syncEngine.js');
    const { startTaskwarriorFollow } = await import('./sync/taskwarriorFollow.js');
    startTaskwarriorFollow();
    startSync({ accountId: auth.user.id }).catch((error) => console.error('[Sync] could not start:', error));
  }
  // ...and the linked desktop profile's data synchronises with the account
  // there through the main process (src/utils/homeServer.js)
  if (homeStatus?.linked) {
    import('./utils/homeServer.js').then(async ({ homeServerTransport, homeServerSyncGate }) => {
      const { startSync } = await import('./sync/syncEngine.js');
      const { startTaskwarriorFollow } = await import('./sync/taskwarriorFollow.js');
      startTaskwarriorFollow();
      // the versions are compared before every cycle: a protocol mismatch pauses synchronisation
      await startSync({ transport: homeServerTransport(), accountId: homeStatus.userId || null, gate: homeServerSyncGate });
      // the account's role as the server has it now (the main process keeps it with the link; Settings reads it)
      homeServerTransport().fetch('/api/auth/me').catch(() => {});
    }).catch((error) => console.error('[Sync] home server link:', error));
  }
}

// A chunk that no longer exists (the page outlived a redeploy): reload once,
// then show the error screen (src/utils/chunkReload.js). Vite reports a
// failed preload as 'vite:preloadError'; a failed lazy page import as an
// unhandled rejection; a failed startup import through start()'s catch.
function recover(error) {
  const outcome = recoverFromChunkLoadError(error);
  if (outcome === 'reloaded') console.warn('[App] a code chunk could not be loaded (the server was updated?) - reloading once');
  return outcome;
}
window.addEventListener('vite:preloadError', (event) => {
  if (recover(event.payload || event) !== 'not-chunk') event.preventDefault();
});
window.addEventListener('unhandledrejection', (event) => {
  const outcome = recover(event.reason);
  if (outcome === 'reloaded') event.preventDefault();
  else if (outcome === 'failed') { event.preventDefault(); root.render(<StartupError error={event.reason} staleChunk />); }
});

start().then(() => clearChunkReloadFlag()).catch((error) => {
  console.error('[App] startup failed:', error);
  const outcome = recover(error);
  if (outcome === 'reloaded') return;
  root.render(<StartupError error={error} staleChunk={outcome === 'failed'} />);
});
