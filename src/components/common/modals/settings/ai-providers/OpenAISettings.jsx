import { Key } from 'lucide-react';
import { SecretInput } from '../SecretInput';
import { Section } from '../ui';
import { Field } from '../fields';

export default function OpenAISettings({ settings, handleChange }) {
  return (
    <Section title="OpenAI Configuration">
      <Field forKey="OPENAI_API_KEY" hint="For GPT-3.5, GPT-4, etc.">
        <SecretInput settingKey="OPENAI_API_KEY" value={settings.OPENAI_API_KEY} onChange={(e) => handleChange('OPENAI_API_KEY', e.target.value)} placeholder="sk-..." />
      </Field>
    </Section>
  );
}
