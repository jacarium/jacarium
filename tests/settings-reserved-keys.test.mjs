/**
 * Guards the reserved-name rule of the desktop Settings store
 * (electron/settings-store.cjs; the backend twin is
 * backend/settings_store.py, tested by settings_reserved_keys.test.py).
 *
 * THE RULE: ~/.jacarium.env is loaded into the Electron process
 * environment (load-env.cjs) and the backend's os.environ, which the
 * `task` and `ssh` subprocesses inherit. A Settings save must therefore
 * never set a name that steers a process - TASKDATA / TASKRC, the *_PROXY
 * variables, CA bundle overrides, LD_* / DYLD_* / PYTHON*, PATH, the
 * app's own JACARIUM_* configuration - while every key the dialog
 * knows keeps working.
 *
 * What this test proves:
 *   - isReservedKey: reserved names and prefixes true, known keys and an
 *     unknown harmless key false;
 *   - mergeSettings refuses a reserved plain value and a reserved secret,
 *     and leaves the stored map untouched;
 *   - mergeLegacyEnvData (the flat write-env-file payload) refuses too;
 *   - an operator-written reserved line survives a save of other keys.
 *
 * Run:  node tests/settings-reserved-keys.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const store = require('../electron/settings-store.cjs');

let failed = 0;
function check(name, pass, detail = '') {
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

for (const key of ['TASKDATA', 'TASKRC', 'PATH', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'JACARIUM_TASK_ROOT',
  'FLASK_DEBUG', 'APP_AUTH_TOKEN', 'PORT', 'SSHPASS', 'SSH_ASKPASS', 'NODE_OPTIONS', 'HF_HUB_OFFLINE', 'TLS_CERT_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GIT_SSH_COMMAND', 'LD_PRELOAD_KEY']) {
  check(`${key} is reserved`, store.isReservedKey(key) === true);
}
for (const key of ['JIRA_PAT', 'JIRA_EMAIL', 'AWS_REGION', 'HF_TOKEN', 'HF_EMBEDDING_MODEL', 'SSH_AI_PASSWORD',
  'SSH_AI_HOST', 'DEFAULT_AI_PROVIDER', 'GOOGLE_CALENDAR_CLIENT_SECRET', 'MY_CUSTOM_SETTING']) {
  check(`${key} is not reserved`, store.isReservedKey(key) === false);
}

const current = { PATH: '/operator/bin', JIRA_EMAIL: 'someone@example.test', JIRA_PAT: 'synthetic-pat' };

function throwsCannotSet(fn) {
  try { fn(); return false; } catch (error) { return /cannot be set/.test(error.message); }
}
check('mergeSettings refuses a reserved plain value', throwsCannotSet(() => store.mergeSettings(current, { values: { TASKDATA: '/x' } })));
check('mergeSettings refuses a reserved secret', throwsCannotSet(() => store.mergeSettings(current, { secrets: { LD_PRELOAD_KEY: 'synthetic' } })));
check('mergeSettings refuses HTTPS_PROXY among valid keys', throwsCannotSet(() => store.mergeSettings(current, { values: { JIRA_EMAIL: 'other@example.test', HTTPS_PROXY: 'http://proxy.example.test' } })));
check('mergeLegacyEnvData refuses a reserved key too', throwsCannotSet(() => store.mergeLegacyEnvData(current, { TASKRC: '/x' })));
check('the stored map is untouched by a refused save', current.PATH === '/operator/bin' && current.JIRA_EMAIL === 'someone@example.test' && current.JIRA_PAT === 'synthetic-pat');

const merged = store.mergeSettings(current, { values: { DEFAULT_AI_PROVIDER: 'anthropic', AWS_REGION: 'eu-west-1', MY_CUSTOM_SETTING: 'yes' }, secrets: { HF_TOKEN: 'hf_synthetic' } });
check('known keys and an unknown harmless key still save', merged.DEFAULT_AI_PROVIDER === 'anthropic' && merged.AWS_REGION === 'eu-west-1' && merged.MY_CUSTOM_SETTING === 'yes' && merged.HF_TOKEN === 'hf_synthetic');
check('an operator-written reserved line survives a save of other keys', merged.PATH === '/operator/bin' && merged.JIRA_PAT === 'synthetic-pat');

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
