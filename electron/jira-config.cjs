/**
 * Jira is optional. The main process proxies the renderer's Jira calls
 * ('jira-fetch' in main.cjs) with JIRA_URL / JIRA_PAT / JIRA_EMAIL from the
 * settings file (loaded into process.env). Without a site or a token
 * nothing is requested: the handler answers a clean "not configured" result
 * that the renderer turns into its quiet empty state - no thrown error, no
 * stack trace, one info line per session at most.
 */
const JIRA_NOT_CONFIGURED = 'JIRA_NOT_CONFIGURED';
const SETTINGS_HINT = 'Settings > Integrations > Jira';

/** { configured, origin, reason, invalid } for an environment (process.env or a test's object). */
function jiraConfig(env = process.env) {
  const raw = String(env.JIRA_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return { configured: false, origin: null, invalid: false, reason: `JIRA_URL is not set - add your Jira URL in ${SETTINGS_HINT} (e.g. https://your-company.atlassian.net)` };
  let url = null;
  try { url = new URL(raw); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    return { configured: false, origin: null, invalid: true, reason: `JIRA_URL must be an https:// origin without a path (e.g. https://your-company.atlassian.net) - check ${SETTINGS_HINT}` };
  }
  if (!String(env.JIRA_PAT || '').trim()) return { configured: false, origin: url.origin, invalid: false, reason: `JIRA_PAT is not set - add your Jira API token in ${SETTINGS_HINT}` };
  return { configured: true, origin: url.origin, invalid: false, reason: null };
}

let loggedOnce = false;
/** The handler's answer when Jira is not configured: resolved (never thrown), logged once per session. */
function notConfiguredResult(config, log = console) {
  if (!loggedOnce) {
    loggedOnce = true;
    try { log.info(`[Jira] not configured - Jira features stay off until the ${SETTINGS_HINT} settings are filled (${config.reason})`); } catch { /* no logger */ }
  }
  return { ok: false, status: 412, statusText: 'Jira not configured', data: { error: config.reason, code: JIRA_NOT_CONFIGURED } };
}

module.exports = { jiraConfig, notConfiguredResult, JIRA_NOT_CONFIGURED, SETTINGS_HINT };
