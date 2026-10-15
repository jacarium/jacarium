/**
 * The one "<integration> isn't set up" state an optional integration shows
 * instead of errors and retries (Jira: the JQL builder; Google Calendar:
 * the Calendars page). An EmptyState with the same wording shape and the
 * same "Open <name> settings" button to the integration's own section of
 * Settings > Integrations (src/utils/openSettings.js). Nothing is contacted
 * while it shows; the caller re-reads its configuration after a settings
 * save ('settingsSaved').
 *
 * Props:
 *   name         "Jira" | "Google Calendar" (the title and the button label)
 *   section      the Integrations sub-tab the button opens ('jira' | 'calendar')
 *   description  one short sentence: what to add where
 *   testId       data-testid of the state; the button gets `${testId}-open-settings`
 *                unless `buttonTestId` says otherwise
 *   icon         optional lucide icon
 *   children     optional extra content under the description (a link)
 */
import { Button, EmptyState } from '../ui';
import { openAppSettings } from '../../utils/openSettings';

export default function IntegrationNotConfigured({ name, section = null, description, testId, buttonTestId = null, icon = null, children = null }) {
  return (
    <EmptyState
      testId={testId}
      icon={icon || undefined}
      title={`${name} isn't set up`}
      description={children ? <>{description} {children}</> : description}
      action={<Button variant="primary" size="lg" onClick={() => openAppSettings('integrations', { section })} data-testid={buttonTestId || `${testId}-open-settings`}>Open {name} settings</Button>}
    />
  );
}
