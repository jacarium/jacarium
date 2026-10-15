import { Key } from 'lucide-react';
import { SecretInput } from '../SecretInput';
import { Field, Section } from '../ui';

export default function OpenAISettings({ settings, handleChange }) {
  return (
    <Section title="OpenAI Configuration">
      <Field label="OpenAI API Key" hint="For GPT-3.5, GPT-4, etc.">
        <SecretInput settingKey="OPENAI_API_KEY" value={settings.OPENAI_API_KEY} onChange={(e) => handleChange('OPENAI_API_KEY', e.target.value)} placeholder="sk-..." />
      </Field>
    </Section>
  );
}
