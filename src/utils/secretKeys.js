/**
 * Which settings are credentials. Mirror of SECRET_KEYS / the suffix rule
 * in backend/settings_store.py and electron/settings-store.cjs: the UI
 * never receives these values, only whether one is stored.
 */
export const SECRET_KEYS = new Set([
  'JIRA_PAT',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CALENDAR_CLIENT_SECRET',
  'HF_TOKEN',
  'CUSTOM_API_KEY',
  'SSH_AI_PASSWORD',
]);

const SECRET_SUFFIX = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_PAT|_PASS)$/;

export function isSecretKey(key) {
  return SECRET_KEYS.has(key) || SECRET_SUFFIX.test(key);
}
