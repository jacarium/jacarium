import { Calendar } from 'lucide-react';
import { SecretInput } from '../SecretInput';
import { ExternalLink, Note, Section, TextInput } from '../ui';
import { Field } from '../fields';

export default function GoogleCalendarSettings({ settings, handleChange }) {
  return (
    <Section title="Google Calendar Configuration" testId="gcal-settings">
      <Note tone="info">
        <p className="font-semibold mb-1">How to get OAuth credentials:</p>
        <ol className="list-decimal list-inside space-y-1 ml-2">
          <li>Go to <ExternalLink href="https://console.cloud.google.com/apis/credentials" className="underline">Google Cloud Console</ExternalLink></li>
          <li>Enable the Google Calendar API in your project</li>
          <li>Create an OAuth 2.0 Client ID of the <span className="font-semibold">Desktop app</span> type (the sign-in opens a browser on this machine)</li>
          <li>Copy the Client ID and Client Secret to the fields below, save, then press Connect Google Calendar on the Calendars page</li>
        </ol>
        <p className="mt-2">The sign-in is not available in a browser on the home server yet: connect from the desktop app.</p>
      </Note>
      <Field forKey="GOOGLE_CALENDAR_CLIENT_ID" hint="OAuth 2.0 Client ID from Google Cloud Console">
        <TextInput mono value={settings.GOOGLE_CALENDAR_CLIENT_ID || ''} onChange={(e) => handleChange('GOOGLE_CALENDAR_CLIENT_ID', e.target.value)} placeholder="1234567890-abcdefghijklmnop.apps.googleusercontent.com" data-testid="gcal-client-id" />
      </Field>
      <Field forKey="GOOGLE_CALENDAR_CLIENT_SECRET" hint="OAuth 2.0 Client Secret from Google Cloud Console">
        <SecretInput settingKey="GOOGLE_CALENDAR_CLIENT_SECRET" value={settings.GOOGLE_CALENDAR_CLIENT_SECRET} onChange={(e) => handleChange('GOOGLE_CALENDAR_CLIENT_SECRET', e.target.value)} placeholder="GOCSPX-xxxxx" />
      </Field>
    </Section>
  );
}
