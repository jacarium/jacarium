/**
 * Why the team features are not available, in words the pages show.
 *
 * The central server (shared documents, boards, workflows, presence, chat,
 * games) comes with the home server: a signed-in browser and a linked
 * desktop profile have it, nothing else does (src/utils/cloudCentralSync.js
 * providedCentralServer). When getCentralServerUrl() is '', a page calls
 * notifyCentralUnavailable() instead of showing an error: a calm hint that
 * says what to do - sign in, or link this profile to a home server (Settings
 * > General > Home server on the desktop, with a button that opens it).
 */
import { isDesktopApp } from './platform';
import { centralUnavailableReason } from './cloudCentralSync';
import { openAppSettings } from './openSettings';

/**
 * { title, message, action } for `feature` (e.g. "share documents"). `action`
 * is 'settings' when Settings > General is where the user links the profile
 * (desktop, not linked), else null.
 */
export function centralHint(feature = 'use the team features') {
  const desktop = isDesktopApp();
  const reason = centralUnavailableReason();
  const title = 'Team features need a home server';
  if (reason === 'no-central') {
    return { title, message: `Your home server provides no central server, so you cannot ${feature} from here. The team features arrive with the server's browser deployment (deploy/deploy-to-host.sh).`, action: null };
  }
  if (reason === 'no-account-sign-in') {
    return { title, message: `The central server behind your home server accepts no account sign-in (the server has no ticket key), so you cannot ${feature} from here. Redeploy the server (deploy/deploy-to-host.sh) to fix it.`, action: null };
  }
  if (desktop) {
    return { title, message: `Link this profile to your home server (Settings > General > Home server) to ${feature} with teammates. Shared documents, boards, workflows, presence, chat and games all come with it.`, action: 'settings' };
  }
  return { title, message: `Sign in to a home server to ${feature} with teammates. Shared documents, boards, workflows, presence, chat and games all come with it.`, action: null };
}

/**
 * Show the hint as a notification. On the desktop, when linking is the fix,
 * it is a confirm with "Open Settings"; otherwise an informative notice.
 */
export function notifyCentralUnavailable(addNotification, feature) {
  const hint = centralHint(feature);
  if (hint.action === 'settings') {
    addNotification({
      type: 'confirm',
      title: hint.title,
      message: hint.message,
      onConfirm: () => openAppSettings('general'),
      confirmLabel: 'Open Settings',
      cancelLabel: 'Not now',
    });
    return hint;
  }
  addNotification({ type: 'info', title: hint.title, message: hint.message });
  return hint;
}
