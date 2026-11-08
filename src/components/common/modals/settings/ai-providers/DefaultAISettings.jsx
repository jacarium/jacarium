import { Settings } from 'lucide-react';
import { Section, Select, TextInput } from '../ui';
import { Field } from '../fields';

export default function DefaultAISettings({ settings, handleChange }) {
  return (
    <Section title="Default AI Settings" description="Used by Quick AI, Ask AI features, and new AI Chat conversations">
      <Field forKey="DEFAULT_AI_PROVIDER">
        <Select value={settings.DEFAULT_AI_PROVIDER || ''} onChange={(e) => handleChange('DEFAULT_AI_PROVIDER', e.target.value)}>
          <option value="">Not configured</option>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI (GPT)</option>
          <option value="gemini">Google (Gemini)</option>
          <option value="ollama">Ollama</option>
        </Select>
      </Field>
      <Field forKey="DEFAULT_AI_MODEL" hint="Model identifier for the selected provider">
        <TextInput mono value={settings.DEFAULT_AI_MODEL || ''} onChange={(e) => handleChange('DEFAULT_AI_MODEL', e.target.value)} placeholder="e.g., claude-sonnet-4-5@20250929" />
      </Field>
      <Field forKey="DEFAULT_AI_TEMPERATURE" hint="Creativity (0 = focused, 1 = creative; default 0). Used by OpenAI, Gemini and Ollama. Claude (API key, Vertex AI) uses its own default: the Anthropic SDK no longer sends it">
        <TextInput value={settings.DEFAULT_AI_TEMPERATURE || ''} onChange={(e) => handleChange('DEFAULT_AI_TEMPERATURE', e.target.value)} placeholder="0" />
      </Field>
      <Field forKey="DEFAULT_AI_MAX_TOKENS" hint="The longest reply, in tokens, for every AI feature (the chat, Quick AI, the generators): 256 to 200000, default 4096; a reply that hits it says so and offers Continue. Ollama's reasoning models get their thinking budgeted on top.">
        <TextInput inputMode="numeric" value={settings.DEFAULT_AI_MAX_TOKENS || ''} onChange={(e) => handleChange('DEFAULT_AI_MAX_TOKENS', e.target.value.replace(/[^0-9]/g, ''))} placeholder="4096" />
      </Field>
    </Section>
  );
}
