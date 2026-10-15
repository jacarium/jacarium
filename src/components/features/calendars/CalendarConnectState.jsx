/**
 * What the Calendars page shows while Google Calendar is not connected
 * (src/utils/calendarAuth.js decides the state):
 *
 *   unconfigured  "Google Calendar isn't set up" - the shared
 *                 IntegrationNotConfigured state (the one the JQL builder
 *                 shows for Jira) with its button to Settings > Integrations
 *                 > Google Calendar (where the panel explains the OAuth client);
 *   disconnected  "Connect Google Calendar" - the sign-in button;
 *   unavailable   the browser deployment: sign-in needs the desktop app;
 *   unknown       the backend has not answered (nothing to do yet).
 *
 * CalendarConnectState is the full-area empty state (no calendar open);
 * CalendarConnectBanner the slim strip above a calendar that still shows
 * cached events. Both are plain: no toast, nothing fired on mount.
 */
import { Calendar, CalendarOff, MonitorSmartphone } from 'lucide-react';
import { Button, EmptyState } from '../../ui';
import NoticeBanner, { NoticeBannerAction } from '../../common/NoticeBanner';
import IntegrationNotConfigured from '../../common/IntegrationNotConfigured';
import { openAppSettings } from '../../../utils/openSettings';
import { calendarStateMessage } from '../../../utils/calendarAuth';

const openCalendarSettings = () => openAppSettings('integrations', { section: 'calendar' });

const NOT_SET_UP = 'Add your Google OAuth client in Settings > Integrations > Google Calendar to see and sync your calendars here.';

export default function CalendarConnectState({ state, onConnect, connecting = false }) {
  switch (state) {
    case 'unconfigured':
      return (
        <IntegrationNotConfigured
          name="Google Calendar"
          section="calendar"
          testId="calendar-unconfigured"
          buttonTestId="calendar-open-settings"
          icon={Calendar}
          description={NOT_SET_UP}
        />
      );
    case 'disconnected':
      return (
        <EmptyState
          testId="calendar-disconnected"
          icon={Calendar}
          title="Connect Google Calendar"
          description="Sign in with Google to list your calendars and sync their events here. A browser window opens for the sign-in; nothing is contacted until then."
          action={<Button variant="primary" size="lg" onClick={onConnect} disabled={connecting} data-testid="calendar-connect">{connecting ? 'Waiting for the sign-in…' : 'Connect Google Calendar'}</Button>}
        />
      );
    case 'unavailable':
      return (
        <EmptyState
          testId="calendar-unavailable"
          icon={MonitorSmartphone}
          title="Connect Google Calendar from the desktop app"
          description={`${calendarStateMessage('unavailable')} The sign-in opens a browser on the machine that runs the backend, which on the home server is the container.`}
        />
      );
    case 'unknown':
      return (
        <EmptyState
          testId="calendar-unknown"
          icon={CalendarOff}
          title="Google Calendar status unknown"
          description="The backend has not answered yet. Cached calendars and events stay readable."
        />
      );
    default:
      return null;
  }
}

/** The strip above an open (cached) calendar while not connected. */
export function CalendarConnectBanner({ state, onConnect, connecting = false }) {
  if (!state || state === 'connected' || state === 'unknown') return null;
  if (state === 'unconfigured') {
    return (
      <NoticeBanner tone="warning" title="Google Calendar isn't set up:" testId="calendar-banner-unconfigured">
        showing cached events. Add your Google OAuth client in Settings &gt; Integrations &gt; Google Calendar.{' '}
        <NoticeBannerAction onClick={openCalendarSettings} testId="calendar-banner-open-settings">Open settings</NoticeBannerAction>
      </NoticeBanner>
    );
  }
  if (state === 'unavailable') {
    return (
      <NoticeBanner tone="warning" title="Not connected:" testId="calendar-banner-unavailable">
        showing cached events. {calendarStateMessage('unavailable')}
      </NoticeBanner>
    );
  }
  return (
    <NoticeBanner tone="warning" title="Google Calendar is not connected:" testId="calendar-banner-disconnected">
      showing cached events.{' '}
      <NoticeBannerAction onClick={onConnect} busy={connecting} testId="calendar-banner-connect">{connecting ? 'Waiting for the sign-in…' : 'Connect Google Calendar'}</NoticeBannerAction>
    </NoticeBanner>
  );
}
