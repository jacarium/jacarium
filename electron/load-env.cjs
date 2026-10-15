const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Load environment variables from multiple sources, in order (later files
 * override earlier ones):
 * 1. ~/.jacarium.env (user home directory - written by Settings)
 * 2. /etc/jacarium.env (system-wide on Linux/Mac)
 * 3. <devEnvDir>/.env - optional developer overrides. Only read when the
 *    caller passes `devEnvDir` (main.cjs passes the checkout root in
 *    development and nothing in packaged builds). This used to be
 *    `process.cwd()/.env`, i.e. whatever directory the app happened to be
 *    launched from - an untrusted directory could have supplied settings
 *    (API endpoints, tokens) without the user's knowledge.
 *
 * @param {object} [options]
 * @param {string|null} [options.devEnvDir]  directory holding a dev `.env`
 * @returns {string[]} the files that were actually loaded (for logging/tests)
 */
function loadEnvironmentVariables(options = {}) {
  // A named desktop profile has its own settings file (electron/profiles.cjs);
  // the default profile reads ~/.jacarium.env as always.
  const envFiles = [
    (options && options.userEnvFile) || path.join(os.homedir(), '.jacarium.env'),
    '/etc/jacarium.env'
  ];
  if (options && options.devEnvDir) {
    envFiles.push(path.join(options.devEnvDir, '.env'));
  }

  const loaded = [];
  for (const envFile of envFiles) {
    if (fs.existsSync(envFile)) {
      console.log(`Loading environment from: ${envFile}`);
      try {
        const content = fs.readFileSync(envFile, 'utf8');
        const lines = content.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();

          // Skip comments and empty lines
          if (!trimmed || trimmed.startsWith('#')) continue;

          // Parse KEY=VALUE
          const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
          if (match) {
            const [, key, value] = match;
            // Remove quotes if present
            const cleanValue = value.replace(/^["']|["']$/g, '');
            process.env[key] = cleanValue;
            console.log(`Loaded env var: ${key}`);
          }
        }
        loaded.push(envFile);
      } catch (err) {
        console.error(`Error reading ${envFile}:`, err.message);
      }
    }
  }
  return loaded;
}

module.exports = { loadEnvironmentVariables };
