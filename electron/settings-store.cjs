// The Settings dialog's view of ~/.jacarium.env, with write-only
// secrets - the desktop twin of backend/settings_store.py.
//
// The renderer never receives a credential: readSettings() reports a
// secret as set / not set, and writeSettings() changes a secret only when
// the dialog sends a new non-empty value (null clears it, "" or absent
// keeps what the file holds). Plain values replace as before; an empty
// plain value removes the key.
//
// Kept free of Electron imports so it is unit-testable with plain Node
// (tests/settings-store.test.mjs) and shared by the 'read-env-file' /
// 'write-env-file' / 'read-settings' / 'write-settings' handlers in
// main.cjs.

const { sanitizeEnvData } = require('./env-file.cjs');

// Mirror of SECRET_KEYS / _SECRET_SUFFIX in backend/settings_store.py.
const SECRET_KEYS = new Set([
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
const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// Mirror of KNOWN_KEYS in backend/settings_store.py: the keys the dialog
// knows are never treated as reserved.
const KNOWN_KEYS = new Set([
  'JIRA_URL', 'JIRA_EMAIL', 'JIRA_PAT',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_USE_BEDROCK', 'AWS_REGION',
  'ANTHROPIC_USE_VERTEX', 'ANTHROPIC_GCP_PROJECT_ID', 'ANTHROPIC_GCP_LOCATION', 'ANTHROPIC_VERTEX_MODELS',
  'GEMINI_API_KEY', 'GEMINI_USE_VERTEX', 'GEMINI_PROJECT_ID', 'GEMINI_LOCATION', 'GEMINI_VERTEX_MODELS',
  'GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET',
  'HF_TOKEN', 'HF_EMBEDDING_MODEL',
  'CUSTOM_AI_ENDPOINT', 'CUSTOM_API_KEY',
  'SSH_AI_HOST', 'SSH_AI_USER', 'SSH_AI_PASSWORD', 'SSH_AI_DISPLAY_NAME',
  'SSH_AI_COMMAND_INITIAL', 'SSH_AI_COMMAND_FOLLOWUP',
  'DEFAULT_AI_PROVIDER', 'DEFAULT_AI_MODEL', 'DEFAULT_AI_TEMPERATURE', 'DEFAULT_AI_MAX_TOKENS',
]);

// Mirror of _RESERVED_KEYS / _RESERVED_PREFIXES in backend/settings_store.py:
// the file is loaded into the process environment (load-env.cjs, and the
// backend's os.environ) and inherited by the `task` / `ssh` subprocesses,
// so a save must never set a name that steers the process or a child
// (library paths, proxies, CA bundles, Taskwarrior's data, the backend's
// own configuration).
const RESERVED_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'TMP', 'TEMP',
  'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS', 'NODE_PATH',
  'SSHPASS', 'SSH_AUTH_SOCK', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE',
  'TASKRC', 'TASKDATA',
  'APP_AUTH_TOKEN', 'PORT', 'DEBUG_LOGGING',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
]);
const RESERVED_PREFIXES = [
  'LD_', 'DYLD_', 'PYTHON', 'JACARIUM_', 'FLASK_', 'GUNICORN_',
  'HF_HUB_', 'TRANSFORMERS_', 'GIT_', 'NODE_', 'TLS_',
];

function isSecretKey(key) {
  return SECRET_KEYS.has(key) || SECRET_SUFFIX.test(key);
}

/** True for a name a Settings save must not set (see RESERVED_KEYS). */
function isReservedKey(key) {
  if (KNOWN_KEYS.has(key)) return false;
  return RESERVED_KEYS.has(key) || RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** KEY=VALUE lines -> object (comments and blank lines skipped). */
function parseEnvFile(content) {
  const values = {};
  for (let line of String(content || '').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    values[key] = line.slice(eq + 1).trim();
  }
  return values;
}

/** What the renderer may see: plain values, secrets as set / not set. */
function publicView(values) {
  const plain = {};
  const secrets = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (isSecretKey(key)) {
      secrets[key] = value !== '';
    } else {
      plain[key] = value;
    }
  }
  return { values: plain, secrets };
}

/** The values object without any secret - for the legacy read-env-file bridge. */
function withoutSecrets(values) {
  return publicView(values).values;
}

/**
 * Apply a Settings save to the current file contents. Returns the merged
 * KEY -> VALUE map to serialize. Throws on an invalid key or a value with
 * a control character (env-file.cjs).
 */
function mergeSettings(current, { values = {}, secrets = {} } = {}) {
  const merged = { ...(current || {}) };
  const cleanValues = sanitizeEnvData(values);
  for (const key of Object.keys(values || {})) {
    if (!KEY_RE.test(key)) throw new Error(`Invalid setting name: ${key}`);
    if (isReservedKey(key)) throw new Error(`${key} cannot be set from Settings`);
    if (isSecretKey(key)) throw new Error(`${key} is a secret: send it under "secrets"`);
    const clean = cleanValues[key];
    if (clean === undefined || clean === '') {
      delete merged[key];
    } else {
      merged[key] = clean;
    }
  }
  for (const [key, raw] of Object.entries(secrets || {})) {
    if (!KEY_RE.test(key)) throw new Error(`Invalid setting name: ${key}`);
    if (isReservedKey(key)) throw new Error(`${key} cannot be set from Settings`);
    if (raw === null) {
      delete merged[key];
      continue;
    }
    const clean = sanitizeEnvData({ [key]: raw })[key];
    if (clean === undefined || clean === '') continue; // "" = keep the stored secret
    merged[key] = clean;
  }
  return merged;
}

/**
 * The legacy 'write-env-file' contract (a flat object from the dialog)
 * turned into the same merge: secrets absent or empty in the payload keep
 * their stored value instead of being wiped.
 */
function mergeLegacyEnvData(current, envData) {
  const values = {};
  const secrets = {};
  for (const [key, value] of Object.entries(envData || {})) {
    if (!KEY_RE.test(key)) continue;
    if (isSecretKey(key)) secrets[key] = value;
    else values[key] = value;
  }
  // A plain key the dialog did not send at all is kept (the dialog always
  // sends the full form, so this only matters for keys it does not know).
  return mergeSettings(current, { values, secrets });
}

module.exports = {
  SECRET_KEYS,
  isSecretKey,
  isReservedKey,
  parseEnvFile,
  publicView,
  withoutSecrets,
  mergeSettings,
  mergeLegacyEnvData,
};
