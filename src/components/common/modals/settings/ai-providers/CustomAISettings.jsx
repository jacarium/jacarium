import { Key } from 'lucide-react';
import { SecretInput } from '../SecretInput';
import { Field, Section, TextInput } from '../ui';

export default function CustomAISettings({ settings, handleChange }) {
  return (
    <Section title="Ollama / Custom AI Endpoint" description="Use Ollama for local LLMs or connect to a custom OpenAI-compatible API">
      <Field label="Custom Endpoint URL" hint={<>Ollama: http://localhost:11434/api/chat (no API key needed)<br />Custom: https://api.example.com/v1/chat</>}>
        <TextInput mono value={settings.CUSTOM_AI_ENDPOINT || ''} onChange={(e) => handleChange('CUSTOM_AI_ENDPOINT', e.target.value)} placeholder="http://localhost:11434/api/chat" />
      </Field>
      <Field label="Custom API Key (Optional)" hint="Not needed for Ollama running locally">
        <SecretInput settingKey="CUSTOM_API_KEY" value={settings.CUSTOM_API_KEY} onChange={(e) => handleChange('CUSTOM_API_KEY', e.target.value)} placeholder="Leave empty for Ollama, or enter API key for custom endpoint" />
      </Field>
    </Section>
  );
}
