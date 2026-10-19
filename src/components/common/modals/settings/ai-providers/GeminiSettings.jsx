import { Key } from 'lucide-react';
import { SecretInput } from '../SecretInput';
import { Code, Group, Section, TextArea, TextInput } from '../ui';
import { Field, Toggle } from '../fields';

export default function GeminiSettings({ settings, handleChange }) {
  return (
    <Section title="Google Gemini Configuration">
      <Field forKey="GEMINI_API_KEY" label="Gemini API Key" hint="Direct API key (Option 1)">
        <SecretInput settingKey="GEMINI_API_KEY" value={settings.GEMINI_API_KEY} onChange={(e) => handleChange('GEMINI_API_KEY', e.target.value)} placeholder="API key..." />
      </Field>
      <Group title="Vertex AI (Option 2)">
        <Toggle forKey="GEMINI_USE_VERTEX" label="Use Vertex AI" hint="Gemini through Google Cloud Vertex AI; needs the project and location below." checked={settings.GEMINI_USE_VERTEX === 'true'}
          onChange={(on) => handleChange('GEMINI_USE_VERTEX', on ? 'true' : '')} testId="toggle-gemini_use_vertex" />
        <Field forKey="GEMINI_PROJECT_ID" label="GCP Project ID">
          <TextInput mono value={settings.GEMINI_PROJECT_ID || ''} onChange={(e) => handleChange('GEMINI_PROJECT_ID', e.target.value)} placeholder="e.g., my-gcp-project" />
        </Field>
        <Field forKey="GEMINI_LOCATION" label="GCP Location">
          <TextInput mono value={settings.GEMINI_LOCATION || ''} onChange={(e) => handleChange('GEMINI_LOCATION', e.target.value)} placeholder="e.g., us-central1" />
        </Field>
        <Field forKey="GEMINI_VERTEX_MODELS" label="Available Models" hint={<>Comma-separated list. Format: <Code>model-id:Display Name</Code> or just <Code>model-id</Code>. Requires: <Code>gcloud auth application-default login</Code></>}>
          <TextArea value={settings.GEMINI_VERTEX_MODELS || ''} onChange={(e) => handleChange('GEMINI_VERTEX_MODELS', e.target.value)} placeholder="gemini-2.0-flash-exp:Gemini 2.0 Flash,gemini-1.5-pro-002:Gemini 1.5 Pro" />
        </Field>
      </Group>
    </Section>
  );
}
