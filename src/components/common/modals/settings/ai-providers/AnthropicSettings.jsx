import { Key } from 'lucide-react';
import { SecretInput } from '../SecretInput';
import { Code, Group, Section, TextArea, TextInput } from '../ui';
import { Field, Toggle } from '../fields';

export default function AnthropicSettings({ settings, handleChange }) {
  return (
    <Section title="Anthropic (Claude) Configuration">
      <Field forKey="ANTHROPIC_API_KEY" hint="Direct API key (Option 1)">
        <SecretInput settingKey="ANTHROPIC_API_KEY" value={settings.ANTHROPIC_API_KEY} onChange={(e) => handleChange('ANTHROPIC_API_KEY', e.target.value)} placeholder="sk-ant-..." />
      </Field>
      <Group title="AWS Bedrock (Option 2)">
        <Toggle forKey="ANTHROPIC_USE_BEDROCK" hint="Claude through Amazon Bedrock instead of the API key; needs the AWS region below." checked={settings.ANTHROPIC_USE_BEDROCK === 'true'}
          onChange={(on) => handleChange('ANTHROPIC_USE_BEDROCK', on ? 'true' : '')} testId="toggle-anthropic_use_bedrock" />
        <Field forKey="AWS_REGION" hint={<>Requires: <Code>aws configure</Code></>}>
          <TextInput mono value={settings.AWS_REGION || ''} onChange={(e) => handleChange('AWS_REGION', e.target.value)} placeholder="e.g., us-east-1" />
        </Field>
      </Group>
      <Group title="Google Cloud Vertex AI (Option 3)">
        <Toggle forKey="ANTHROPIC_USE_VERTEX" hint="Claude through Google Cloud Vertex AI; needs the project and location below." checked={settings.ANTHROPIC_USE_VERTEX === 'true'}
          onChange={(on) => handleChange('ANTHROPIC_USE_VERTEX', on ? 'true' : '')} testId="toggle-anthropic_use_vertex" />
        <Field forKey="ANTHROPIC_GCP_PROJECT_ID">
          <TextInput mono value={settings.ANTHROPIC_GCP_PROJECT_ID || ''} onChange={(e) => handleChange('ANTHROPIC_GCP_PROJECT_ID', e.target.value)} placeholder="e.g., my-gcp-project" />
        </Field>
        <Field forKey="ANTHROPIC_GCP_LOCATION">
          <TextInput mono value={settings.ANTHROPIC_GCP_LOCATION || ''} onChange={(e) => handleChange('ANTHROPIC_GCP_LOCATION', e.target.value)} placeholder="e.g., us-east5" />
        </Field>
        <Field forKey="ANTHROPIC_VERTEX_MODELS" hint={<>Comma-separated list. Format: <Code>model-id:Display Name</Code> or just <Code>model-id</Code>. Requires: <Code>gcloud auth application-default login</Code></>}>
          <TextArea value={settings.ANTHROPIC_VERTEX_MODELS || ''} onChange={(e) => handleChange('ANTHROPIC_VERTEX_MODELS', e.target.value)} placeholder="claude-sonnet-4-5@20250929:Claude Sonnet 4.5" />
        </Field>
      </Group>
    </Section>
  );
}
