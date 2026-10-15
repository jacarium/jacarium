import { Key } from 'lucide-react';
import { SecretInput } from '../SecretInput';
import { Code, Field, Group, Section, Select, TextArea, TextInput } from '../ui';

export default function AnthropicSettings({ settings, handleChange }) {
  return (
    <Section title="Anthropic (Claude) Configuration">
      <Field label="Anthropic API Key" hint="Direct API key (Option 1)">
        <SecretInput settingKey="ANTHROPIC_API_KEY" value={settings.ANTHROPIC_API_KEY} onChange={(e) => handleChange('ANTHROPIC_API_KEY', e.target.value)} placeholder="sk-ant-..." />
      </Field>
      <Group title="AWS Bedrock (Option 2)">
        <Field label="Use AWS Bedrock">
          <Select value={settings.ANTHROPIC_USE_BEDROCK || ''} onChange={(e) => handleChange('ANTHROPIC_USE_BEDROCK', e.target.value)}>
            <option value="">Not configured</option>
            <option value="true">True</option>
            <option value="false">False</option>
          </Select>
        </Field>
        <Field label="AWS Region" hint={<>Requires: <Code>aws configure</Code></>}>
          <TextInput mono value={settings.AWS_REGION || ''} onChange={(e) => handleChange('AWS_REGION', e.target.value)} placeholder="e.g., us-east-1" />
        </Field>
      </Group>
      <Group title="Google Cloud Vertex AI (Option 3)">
        <Field label="Use Vertex AI">
          <Select value={settings.ANTHROPIC_USE_VERTEX || ''} onChange={(e) => handleChange('ANTHROPIC_USE_VERTEX', e.target.value)}>
            <option value="">Not configured</option>
            <option value="true">True</option>
            <option value="false">False</option>
          </Select>
        </Field>
        <Field label="GCP Project ID">
          <TextInput mono value={settings.ANTHROPIC_GCP_PROJECT_ID || ''} onChange={(e) => handleChange('ANTHROPIC_GCP_PROJECT_ID', e.target.value)} placeholder="e.g., my-gcp-project" />
        </Field>
        <Field label="GCP Location">
          <TextInput mono value={settings.ANTHROPIC_GCP_LOCATION || ''} onChange={(e) => handleChange('ANTHROPIC_GCP_LOCATION', e.target.value)} placeholder="e.g., us-east5" />
        </Field>
        <Field label="Available Models" hint={<>Comma-separated list. Format: <Code>model-id:Display Name</Code> or just <Code>model-id</Code>. Requires: <Code>gcloud auth application-default login</Code></>}>
          <TextArea value={settings.ANTHROPIC_VERTEX_MODELS || ''} onChange={(e) => handleChange('ANTHROPIC_VERTEX_MODELS', e.target.value)} placeholder="claude-3-5-sonnet-v2@20241022:Claude 3.5 Sonnet v2,claude-3-opus@20240229:Claude 3 Opus" />
        </Field>
      </Group>
    </Section>
  );
}
