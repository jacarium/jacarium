import { Key } from 'lucide-react';
import { SecretInput } from '../SecretInput';
import { Section, TextInput } from '../ui';
import { Field } from '../fields';

export default function CustomAISettings({ settings, handleChange }) {
  return (
    <Section title="Ollama / Custom AI Endpoint" description="Use Ollama for local LLMs or connect to a custom OpenAI-compatible API">
      <Field forKey="CUSTOM_AI_ENDPOINT" hint={<>Ollama: http://localhost:11434/api/chat (no API key needed)<br />Custom: https://api.example.com/v1/chat<br />
        <span data-testid="endpoint-localhost-hint">Shared by every device of your account when set under My account: &quot;localhost&quot; is the device that makes the call - this device&apos;s own Ollama here, the server&apos;s own on your phone. Use an address they can all reach (http://ollama.lan:11434/api/chat) to share one Ollama.</span></>}>
        <TextInput mono value={settings.CUSTOM_AI_ENDPOINT || ''} onChange={(e) => handleChange('CUSTOM_AI_ENDPOINT', e.target.value)} placeholder="http://localhost:11434/api/chat" />
      </Field>
      <Field forKey="CUSTOM_API_KEY" hint="Not needed for Ollama running locally">
        <SecretInput settingKey="CUSTOM_API_KEY" value={settings.CUSTOM_API_KEY} onChange={(e) => handleChange('CUSTOM_API_KEY', e.target.value)} placeholder="Leave empty for Ollama, or enter API key for custom endpoint" />
      </Field>
    </Section>
  );
}
