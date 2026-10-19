import { SecretInput } from '../SecretInput';
import { Section, TextInput } from '../ui';
import { Field } from '../fields';

export default function JiraSettings({ settings, handleChange }) {
  return (
    <Section title="Jira">
      <Field forKey="JIRA_URL" label="Jira URL" hint="Your Jira site as an https:// address without a path. Nothing is configured until you set it.">
        <TextInput type="url" mono value={settings.JIRA_URL || ''} onChange={(e) => handleChange('JIRA_URL', e.target.value)} placeholder="https://your-company.atlassian.net" />
      </Field>
      <Field forKey="JIRA_EMAIL" label="Jira Email Address" hint="Your Atlassian Cloud email address (required for Basic Authentication)">
        <TextInput type="email" mono value={settings.JIRA_EMAIL || ''} onChange={(e) => handleChange('JIRA_EMAIL', e.target.value)} placeholder="you@example.com" />
      </Field>
      <Field forKey="JIRA_PAT" label="Jira API Token" hint="An API token from your Atlassian account (Account settings > Security > API tokens), or a personal access token on Jira Data Center.">
        <SecretInput settingKey="JIRA_PAT" value={settings.JIRA_PAT} onChange={(e) => handleChange('JIRA_PAT', e.target.value)} placeholder="Enter your Jira token..." />
      </Field>
    </Section>
  );
}
