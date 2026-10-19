/**
 * The Claude model the frontend falls back to when NOTHING is configured
 * (no DEFAULT_AI_MODEL in the settings, no saved chat settings): the direct
 * API's alias, which the backend's own per-path fallback also uses. A
 * configured model always wins - the Vertex "@date" ids, Bedrock ids and
 * other providers' ids all come from the settings.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5';

/** The model to send: the configured default, else the alias. */
export function defaultAiModel(envVars) {
  return (envVars && envVars.DEFAULT_AI_MODEL) || DEFAULT_CLAUDE_MODEL;
}

/**
 * The model option a chat runs on, from the configured list (/api/ai/models
 * as the chat UIs build it: [{ provider, model, label, ... }]) - one order
 * for Robin's page and the AI chat sidebar, on the desktop and the web:
 *   1. the conversation's saved provider/model, when it is in the list;
 *   2. DEFAULT_AI_MODEL (Settings > Default AI), when it is in the list
 *      (of DEFAULT_AI_PROVIDER when that is set too);
 *   3. else the first model of DEFAULT_AI_PROVIDER in the list;
 *   4. else the first model in the list.
 * `defaults` is the `defaults` member of the /api/ai/models answer
 * ({ provider, model }, either may be empty). Returns null for an empty list.
 */
export function resolveModelOption(modelOptions, saved, defaults) {
  const options = modelOptions || [];
  const provider = (defaults && defaults.provider) || '';
  const model = (defaults && defaults.model) || '';
  if (saved && saved.provider && saved.model) {
    const own = options.find((o) => o.provider === saved.provider && o.model === saved.model);
    if (own) return own;
  }
  if (model) {
    const byModel = options.find((o) => o.model === model && (!provider || o.provider === provider));
    if (byModel) return byModel;
  }
  if (provider) {
    const byProvider = options.find((o) => o.provider === provider);
    if (byProvider) return byProvider;
  }
  return options[0] || null;
}
