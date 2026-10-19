import { apiFetch, getBackendUrl } from './backendUrl';
import { resolveModelOption } from './aiDefaults';

/**
 * The provider and model a one-off AI request runs on - Quick AI ("/ai"),
 * Ask AI, Quick Notes' two AI panels, the quiz and grid generators.
 *
 * Those paths used to take a hard-coded {provider: 'anthropic', model:
 * claude...} (behind a localStorage key nothing writes), or, in the
 * generators, DEFAULT_AI_PROVIDER from Electron's env file only - so on the
 * desktop and the web alike "/ai" sent provider "anthropic" whatever
 * Settings > Default AI said, and failed with "ANTHROPIC_API_KEY not found".
 *
 * Every entry point now resolves the same way Robin does: the configured
 * model list and the Settings defaults come from /api/ai/models (the backend
 * reads them through its settings store - the profile's env file on the
 * desktop, the server's on the web), then resolveModelOption picks a saved
 * choice if it is configured, else DEFAULT_AI_MODEL, else the first model
 * of DEFAULT_AI_PROVIDER, else the first configured model. Nothing
 * configured -> null, and the caller shows NO_AI_PROVIDER_MESSAGE instead
 * of the backend's error.
 */

export const NO_AI_PROVIDER_MESSAGE = 'No AI provider configured - set one in Settings > AI.';

/** The flat option list the chat UIs build from /api/ai/models: [{ provider, model, label, sshConfig? }]. */
export function buildModelOptions(models) {
  const m = models || {};
  const named = (provider, prefix) => (list) => (list || []).map((model) => (
    typeof model === 'object' && model && model.id
      ? { provider, model: model.id, label: `${prefix} - ${model.label || model.id}` }
      : { provider, model, label: `${prefix} - ${model}` }
  ));
  return [
    ...named('anthropic', 'Anthropic')(m.anthropic),
    ...named('openai', 'OpenAI')(m.openai),
    ...named('gemini', 'Gemini')(m.gemini),
    ...named('ollama', 'Ollama')(m.ollama),
    ...(m.ssh || []).map((model) => ({ provider: 'ssh', model: model.id, label: `SSH - ${model.label} (Remote)`, sshConfig: model.config })),
  ];
}

// /api/ai/models probes every configured provider; a few seconds of reuse
// keeps a burst of quick requests from probing again and again.
const CACHE_MS = 15000;
let cache = null;

/** The configured model options and the Settings defaults, from the backend (cached briefly). */
export async function loadAiModelChoice({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const backendUrl = await getBackendUrl();
  const response = await apiFetch(`${backendUrl}/api/ai/models`);
  if (!response.ok) throw new Error(`Could not load the AI models (${response.status})`);
  const models = await response.json();
  const value = { options: buildModelOptions(models), defaults: { provider: models.defaults?.provider || '', model: models.defaults?.model || '' } };
  cache = { at: Date.now(), value };
  return value;
}

/** Forget the cached list (tests, or right after the settings were saved). */
export function forgetAiModelChoice() {
  cache = null;
}

/**
 * The settings for one request: { provider, model, temperature, maxTokens,
 * sshConfig? } - or null when no provider is configured at all. `saved`
 * is an optional earlier choice ({ provider, model }) honoured only when it
 * is still configured.
 */
export async function resolveAiRequestSettings({ saved = null, temperature = 0, maxTokens = 2000 } = {}) {
  const { options, defaults } = await loadAiModelChoice();
  const option = resolveModelOption(options, saved, defaults);
  if (!option) return null;
  const settings = { provider: option.provider, model: option.model, temperature, maxTokens };
  if (option.sshConfig) settings.sshConfig = option.sshConfig;
  return settings;
}

/** The AI chat settings an earlier version kept in localStorage, if any (nothing writes the key today). */
export function savedAiChatSettings() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('aiChatSettings') : null;
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && parsed.provider && parsed.model ? parsed : null;
  } catch {
    return null;
  }
}
