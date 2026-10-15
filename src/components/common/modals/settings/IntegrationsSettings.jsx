import { useEffect, useState } from 'react';
import JiraSettings from './integrations/JiraSettings';
import GoogleCalendarSettings from './integrations/GoogleCalendarSettings';
import HuggingFaceSettings from './integrations/HuggingFaceSettings';
import { SubTabs } from './ui';

const TABS = [
  { id: 'jira', label: 'JIRA' },
  { id: 'calendar', label: 'Google Calendar' },
  { id: 'huggingface', label: 'HuggingFace' },
];

const isTab = (id) => TABS.some((t) => t.id === id);

// `initialSection`: the sub-tab the opener asked for (openAppSettings
// ('integrations', { section: 'calendar' }) from the Calendars page); Jira
// otherwise. A later opener wins over the user's last click.
export default function IntegrationsSettings({ settings, handleChange, initialSection = null }) {
  const [tab, setTab] = useState(() => (isTab(initialSection) ? initialSection : 'jira'));
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- follows the opener's request
    if (isTab(initialSection)) setTab(initialSection);
  }, [initialSection]);
  return (
    <div className="space-y-6">
      <SubTabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'jira' && <JiraSettings settings={settings} handleChange={handleChange} />}
      {tab === 'calendar' && <GoogleCalendarSettings settings={settings} handleChange={handleChange} />}
      {tab === 'huggingface' && <HuggingFaceSettings settings={settings} handleChange={handleChange} />}
    </div>
  );
}
