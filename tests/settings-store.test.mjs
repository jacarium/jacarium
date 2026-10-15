/**
 * Guards the desktop side of write-only Settings secrets
 * (electron/settings-store.cjs, used by the 'read-env-file',
 * 'write-env-file', 'read-settings' and 'write-settings' handlers in
 * electron/main.cjs; mirrored by backend/settings_store.py).
 *
 * THE RULE: a credential in ~/.jacarium.env (Jira PAT, API keys,
 * client secrets, passwords) is never handed to the renderer - the dialog
 * only learns whether one is stored - and saving the dialog without
 * typing a secret again must not wipe it.
 *
 * What this test proves:
 *   - parseEnvFile: KEY=VALUE lines, comments / blanks / odd keys skipped,
 *     '=' inside a value preserved;
 *   - publicView: plain values returned, every secret only as true/false
 *     (by name and by suffix), and the value string appears nowhere;
 *   - withoutSecrets: the legacy read-env-file answer has no secret key;
 *   - mergeSettings: a typed secret replaces, '' / absent keeps, null
 *     clears; a plain '' removes the key; a secret sent as a plain value
 *     is refused; control characters are refused (env-file.cjs);
 *   - mergeLegacyEnvData: the old flat payload with blank secrets keeps
 *     the stored ones.
 *
 * Run:  node tests/settings-store.test.mjs
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

// Synthetic values only.
const FILE = [
  '# Jacarium settings',
  '',
  'JIRA_EMAIL=someone@example.test',
  'JIRA_PAT=synthetic-jira-pat-000',
  'ANTHROPIC_API_KEY=sk-synthetic-anthropic',
  'DEFAULT_AI_PROVIDER=anthropic',
  'CUSTOM_AI_ENDPOINT=http://localhost:11434/v1?x=1',
  'MY_SERVICE_TOKEN=synthetic-by-suffix',
  'not a key=ignored',
  'lowercase=ignored',
  '',
].join('\n');

const values = store.parseEnvFile(FILE);
check('parseEnvFile reads KEY=VALUE pairs', values.JIRA_EMAIL === 'someone@example.test' && values.DEFAULT_AI_PROVIDER === 'anthropic');
check('parseEnvFile keeps "=" inside a value', values.CUSTOM_AI_ENDPOINT === 'http://localhost:11434/v1?x=1');
check('parseEnvFile skips comments, blanks and non-KEY names', !('not a key' in values) && !('lowercase' in values) && Object.keys(values).length === 6);

const view = store.publicView(values);
const viewText = JSON.stringify(view);
check('publicView returns the plain values', view.values.JIRA_EMAIL === 'someone@example.test' && view.values.DEFAULT_AI_PROVIDER === 'anthropic');
check('publicView reports secrets only as stored', view.secrets.JIRA_PAT === true && view.secrets.ANTHROPIC_API_KEY === true);
check('publicView classifies by suffix too (MY_SERVICE_TOKEN)', view.secrets.MY_SERVICE_TOKEN === true && !('MY_SERVICE_TOKEN' in view.values));
check('no secret value appears anywhere in the view', !viewText.includes('synthetic-jira-pat') && !viewText.includes('sk-synthetic') && !viewText.includes('synthetic-by-suffix'), viewText);
check('secrets that are not stored are reported false', store.publicView({ JIRA_PAT: '' }).secrets.JIRA_PAT === false);

const legacy = store.withoutSecrets(values);
check('withoutSecrets (read-env-file) carries no secret key', !('JIRA_PAT' in legacy) && !('ANTHROPIC_API_KEY' in legacy) && !('MY_SERVICE_TOKEN' in legacy) && legacy.JIRA_EMAIL === 'someone@example.test');

// mergeSettings
let merged = store.mergeSettings(values, { values: { JIRA_EMAIL: 'other@example.test' }, secrets: {} });
check('plain value replaced; untouched secrets kept', merged.JIRA_EMAIL === 'other@example.test' && merged.JIRA_PAT === 'synthetic-jira-pat-000' && merged.ANTHROPIC_API_KEY === 'sk-synthetic-anthropic');
merged = store.mergeSettings(values, { values: {}, secrets: { JIRA_PAT: '' } });
check('"" for a secret keeps the stored one', merged.JIRA_PAT === 'synthetic-jira-pat-000');
merged = store.mergeSettings(values, { values: {}, secrets: { JIRA_PAT: 'synthetic-new-pat' } });
check('a typed secret replaces the stored one', merged.JIRA_PAT === 'synthetic-new-pat');
merged = store.mergeSettings(values, { values: {}, secrets: { JIRA_PAT: null } });
check('null clears a secret', !('JIRA_PAT' in merged) && merged.ANTHROPIC_API_KEY === 'sk-synthetic-anthropic');
merged = store.mergeSettings(values, { values: { DEFAULT_AI_PROVIDER: '' }, secrets: {} });
check('an empty plain value removes the key', !('DEFAULT_AI_PROVIDER' in merged));
merged = store.mergeSettings(values, { values: { DEFAULT_AI_MAX_TOKENS: ' 4096\n' }, secrets: { OPENAI_API_KEY: ' sk-pasted\n' } });
check('values are trimmed (pasted token with a trailing newline)', merged.DEFAULT_AI_MAX_TOKENS === '4096' && merged.OPENAI_API_KEY === 'sk-pasted');

let threw = false;
try { store.mergeSettings(values, { values: { OPENAI_API_KEY: 'x' } }); } catch (e) { threw = /secret/.test(e.message); }
check('a secret sent as a plain value is refused', threw);
threw = false;
try { store.mergeSettings(values, { secrets: { JIRA_PAT: 'abc\nJIRA_EMAIL=evil' } }); } catch (e) { threw = /line break|control/.test(e.message); }
check('a secret with a line break is refused (env-file.cjs rule)', threw);
threw = false;
try { store.mergeSettings(values, { values: { 'bad key': 'x' } }); } catch (e) { threw = /Invalid setting name/.test(e.message); }
check('an invalid key name is refused', threw);

// Legacy flat payload: the dialog used to send the whole form, secrets
// blank when the user did not retype them.
merged = store.mergeLegacyEnvData(values, { JIRA_EMAIL: 'someone@example.test', JIRA_PAT: '', ANTHROPIC_API_KEY: '', DEFAULT_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-typed' });
check('legacy payload: blank secrets keep the stored ones, typed one saved, plain values applied', merged.JIRA_PAT === 'synthetic-jira-pat-000' && merged.ANTHROPIC_API_KEY === 'sk-synthetic-anthropic' && merged.OPENAI_API_KEY === 'sk-typed' && merged.DEFAULT_AI_PROVIDER === 'openai');

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
