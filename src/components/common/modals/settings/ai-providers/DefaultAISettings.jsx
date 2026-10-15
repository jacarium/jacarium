import { Settings } from 'lucide-react';
import { Field, Section, Select, TextInput } from '../ui';

export default function DefaultAISettings({ settings, handleChange }) {
  return (
    <Section title="Default AI Settings" description="Used by Quick AI, Ask AI features, and new AI Chat conversations">
      <Field label="Default AI Provider">
        <Select value={settings.DEFAULT_AI_PROVIDER || ''} onChange={(e) => handleChange('DEFAULT_AI_PROVIDER', e.target.value)}>
          <option value="">Not configured</option>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI (GPT)</option>
          <option value="gemini">Google (Gemini)</option>
          <option value="ollama">Ollama</option>
        </Select>
      </Field>
      <Field label="Default AI Model" hint="Model identifier for the selected provider">
        <TextInput mono value={settings.DEFAULT_AI_MODEL || ''} onChange={(e) => handleChange('DEFAULT_AI_MODEL', e.target.value)} placeholder="e.g., claude-sonnet-4-5@20250929" />
      </Field>
      <Field label="Default Temperature" hint="Creativity level (0 = focused, 1 = creative, default: 0.7)">
        <TextInput value={settings.DEFAULT_AI_TEMPERATURE || ''} onChange={(e) => handleChange('DEFAULT_AI_TEMPERATURE', e.target.value)} placeholder="0.7" />
      </Field>
      <Field label="Default Max Tokens" hint="Maximum response length (default: 2000)">
        <TextInput value={settings.DEFAULT_AI_MAX_TOKENS || ''} onChange={(e) => handleChange('DEFAULT_AI_MAX_TOKENS', e.target.value)} placeholder="2000" />
      </Field>
    </Section>
  );
}
