import { SecretInput } from '../SecretInput';
import { Code, Field, Section, TextArea, TextInput } from '../ui';

export default function SSHAISettings({ settings, handleChange }) {
  return (
    <Section title="AI Over SSH Configuration" description="Configure SSH connection for remote AI tools like Gemini CLI">
      <Field label="Display Name" hint="Name shown in the model dropdown">
        <TextInput value={settings.SSH_AI_DISPLAY_NAME || ''} onChange={(e) => handleChange('SSH_AI_DISPLAY_NAME', e.target.value)} placeholder="e.g., Gemini CLI" />
      </Field>
      <Field label="SSH Hostname" hint="Remote server hostname or IP address">
        <TextInput mono value={settings.SSH_AI_HOST || ''} onChange={(e) => handleChange('SSH_AI_HOST', e.target.value)} placeholder="example.com" />
      </Field>
      <Field label="SSH Username" hint="SSH login username">
        <TextInput mono value={settings.SSH_AI_USER || ''} onChange={(e) => handleChange('SSH_AI_USER', e.target.value)} placeholder="username" />
      </Field>
      <Field label="SSH Password (Optional)" hint="Optional - leave empty to use SSH key authentication">
        <SecretInput settingKey="SSH_AI_PASSWORD" value={settings.SSH_AI_PASSWORD} onChange={(e) => handleChange('SSH_AI_PASSWORD', e.target.value)} placeholder="Leave empty for key-based auth" />
      </Field>
      <Field label="Initial Message Command Template" hint={<>Command for the first message in a conversation. Use <Code>{'{{MESSAGE}}'}</Code> for the prompt and <Code>{'{{SESSION_ID}}'}</Code> for session tracking.</>}>
        <TextArea value={settings.SSH_AI_COMMAND_INITIAL || ''} onChange={(e) => handleChange('SSH_AI_COMMAND_INITIAL', e.target.value)} placeholder='gemini -p "{{MESSAGE}}" -o json --session-id {{SESSION_ID}} | jq -r .response' />
      </Field>
      <Field label="Follow-up Message Command Template" hint={<>Command for subsequent messages in a conversation. Use <Code>{'{{MESSAGE}}'}</Code> for the prompt and <Code>{'{{SESSION_ID}}'}</Code> to resume the session.</>}>
        <TextArea value={settings.SSH_AI_COMMAND_FOLLOWUP || ''} onChange={(e) => handleChange('SSH_AI_COMMAND_FOLLOWUP', e.target.value)} placeholder='gemini -p "{{MESSAGE}}" -o json --resume {{SESSION_ID}} | jq -r .response' />
      </Field>
    </Section>
  );
}
