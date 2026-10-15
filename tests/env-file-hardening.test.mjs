/**
 * Guards two ~/.jacarium.env hardening fixes.
 *
 * L1 - VALUE INJECTION (electron/env-file.cjs, used by 'write-env-file' in
 * main.cjs): settings values were interpolated verbatim into the
 * KEY=VALUE-per-line file, so a value containing "\n" - e.g.
 * "abc\nCUSTOM_AI_ENDPOINT=http://evil" - injected extra settings that both
 * readers (load-env.cjs and python-dotenv) then honored. sanitizeEnvData()
 * trims surrounding whitespace/line breaks (a pasted token with a trailing
 * newline must keep working) and REJECTS any remaining control character
 * with an error naming the key.
 *
 * L2 - .env FROM CWD (electron/load-env.cjs): the loader read
 * `process.cwd()/.env`, i.e. whatever directory the app was launched from,
 * so an untrusted directory could supply API endpoints/tokens. The dev
 * .env is now read only from an explicit `devEnvDir` (main.cjs passes the
 * checkout root in development and nothing when packaged); the fixed
 * locations (~/.jacarium.env, /etc/jacarium.env) are unchanged.
 *
 * What this test proves (real modules, plain Node, temp HOME + temp cwd):
 *   - sanitize: trailing/leading newline and whitespace trimmed; interior
 *     \n, \r, NUL, ESC rejected with the key name; '=', '#', ',', quotes,
 *     spaces and URLs preserved; non-string values stringified; bad keys
 *     dropped; a crafted value can no longer add a key after round-trip
 *     through the REAL loader;
 *   - loader: a hostile .env in the process cwd is NOT loaded; the home
 *     file IS; a dev .env is loaded only when devEnvDir is passed; later
 *     files override earlier ones; the return value lists loaded files.
 *
 * Run:  node tests/env-file-hardening.test.mjs
 * Preconditions: none (plain Node).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const { sanitizeEnvValue, sanitizeEnvData } = require(path.join(REPO, 'electron', 'env-file.cjs'));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

// ---------- L1: sanitize ----------
console.log('--- L1: sanitizeEnvValue / sanitizeEnvData');
check('trailing newline trimmed (pasted token)', sanitizeEnvValue('JIRA_PAT', 'tok3n\n') === 'tok3n');
check('CRLF + spaces trimmed', sanitizeEnvValue('K', '  value\r\n') === 'value');
check('leading newline trimmed', sanitizeEnvValue('K', '\nvalue') === 'value');
const rejects = (label, value) => {
  try { sanitizeEnvValue('CUSTOM_AI_ENDPOINT', value); check(`rejects ${label}`, false, 'accepted'); }
  catch (e) { check(`rejects ${label}`, /CUSTOM_AI_ENDPOINT/.test(e.message) && /line break|control/.test(e.message), e.message); }
};
rejects('interior \\n (key injection)', 'abc\nJIRA_PAT=stolen');
rejects('interior \\r', 'abc\rJIRA_PAT=stolen');
rejects('NUL', 'abc\u0000def');
rejects('ESC', 'abc\u001bdef');
rejects('DEL', 'abc\u007fdef');
rejects('TAB inside', 'abc\tdef');
const preserved = [
  ['ANTHROPIC_VERTEX_MODELS', 'claude-a, claude-b,claude-c'],
  ['CUSTOM_AI_ENDPOINT', 'https://ai.example.com:8443/v1/chat?x=1&y=2'],
  ['JIRA_EMAIL', 'first.last@example.com'],
  ['HF_TOKEN', 'hf_abc=def#ghi'],
  ['DEFAULT_AI_TEMPERATURE', '0.7'],
  ['ANTHROPIC_USE_BEDROCK', 'true'],
  ['K', 'value with spaces inside'],
  ['K', '"quoted"'],
  ['K', 'ünïcödé ✓']
];
for (const [k, v] of preserved) check(`preserves ${JSON.stringify(v)}`, sanitizeEnvValue(k, v) === v);
check('number stringified', sanitizeEnvValue('DEFAULT_AI_MAX_TOKENS', 4096) === '4096');
check('null/undefined -> empty', sanitizeEnvValue('K', null) === '' && sanitizeEnvValue('K', undefined) === '');
const data = sanitizeEnvData({ JIRA_PAT: ' abc\n', 'bad key': 'x', lower: 'y', OPENAI_API_KEY: 'sk-1' });
check('sanitizeEnvData sanitizes values and drops non-KEY names', data.JIRA_PAT === 'abc' && data.OPENAI_API_KEY === 'sk-1' && !('bad key' in data) && !('lower' in data));
check('sanitizeEnvData tolerates non-object', JSON.stringify(sanitizeEnvData(null)) === '{}');

// Round-trip through the REAL loader: before the fix a crafted value added a key.
const { loadEnvironmentVariables } = require(path.join(REPO, 'electron', 'load-env.cjs'));
const rtHome = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-rt-'));
fs.writeFileSync(path.join(rtHome, '.jacarium.env'), `JIRA_PAT=${'abc\nCUSTOM_AI_ENDPOINT=http://evil.example'}\n`);
{
  const r = spawnSync(process.execPath, ['-e', `
    const { loadEnvironmentVariables } = require(${JSON.stringify(path.join(REPO, 'electron', 'load-env.cjs'))});
    loadEnvironmentVariables();
    console.log(JSON.stringify({ pat: process.env.JIRA_PAT, ep: process.env.CUSTOM_AI_ENDPOINT }));
  `], { env: { ...process.env, HOME: rtHome, USERPROFILE: rtHome, CUSTOM_AI_ENDPOINT: '' }, encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  check('control: an UNSANITIZED crafted value would inject a key via the loader', out.ep === 'http://evil.example', JSON.stringify(out));
}
let threw = false;
try { sanitizeEnvData({ JIRA_PAT: 'abc\nCUSTOM_AI_ENDPOINT=http://evil.example' }); } catch { threw = true; }
check('the same crafted value is rejected before it can reach the file', threw);
fs.rmSync(rtHome, { recursive: true, force: true });

// ---------- L2: loader locations ----------
console.log('--- L2: loadEnvironmentVariables locations');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-home-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-cwd-'));
const devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-dev-'));
fs.writeFileSync(path.join(home, '.jacarium.env'), 'FROM_HOME=1\nOVERRIDE_ME=home\n');
fs.writeFileSync(path.join(cwd, '.env'), 'FROM_CWD=1\nCUSTOM_AI_ENDPOINT=http://attacker.example\n');
fs.writeFileSync(path.join(devDir, '.env'), 'FROM_DEV=1\nOVERRIDE_ME=dev\n');

function runLoader(optionsSource) {
  const r = spawnSync(process.execPath, ['-e', `
    const { loadEnvironmentVariables } = require(${JSON.stringify(path.join(REPO, 'electron', 'load-env.cjs'))});
    const loaded = loadEnvironmentVariables(${optionsSource});
    console.log(JSON.stringify({ loaded, FROM_HOME: process.env.FROM_HOME, FROM_CWD: process.env.FROM_CWD, FROM_DEV: process.env.FROM_DEV, OVERRIDE_ME: process.env.OVERRIDE_ME, CUSTOM_AI_ENDPOINT: process.env.CUSTOM_AI_ENDPOINT }));
  `], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, FROM_HOME: '', FROM_CWD: '', FROM_DEV: '', OVERRIDE_ME: '', CUSTOM_AI_ENDPOINT: '' }, encoding: 'utf8' });
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

let out = runLoader('');
check('default call: home file loaded', out.FROM_HOME === '1' && out.loaded.includes(path.join(home, '.jacarium.env')), JSON.stringify(out));
check('default call: .env in process cwd NOT loaded', out.FROM_CWD === '' && out.CUSTOM_AI_ENDPOINT === '', JSON.stringify(out));
check('default call: no dev file', out.FROM_DEV === '' && out.OVERRIDE_ME === 'home');

out = runLoader(`{ devEnvDir: ${JSON.stringify(devDir)} }`);
check('devEnvDir: dev .env loaded and overrides home', out.FROM_DEV === '1' && out.OVERRIDE_ME === 'dev' && out.loaded.length === 2);
check('devEnvDir: cwd .env STILL not loaded', out.FROM_CWD === '' && out.CUSTOM_AI_ENDPOINT === '');

out = runLoader('{ devEnvDir: null }');
check('devEnvDir null (packaged): only fixed locations', out.FROM_DEV === '' && out.FROM_CWD === '' && out.FROM_HOME === '1');

// main.cjs must pass the checkout root (dev) / nothing (packaged), never cwd
const mainSrc = fs.readFileSync(path.join(REPO, 'electron', 'main.cjs'), 'utf8');
check('main.cjs passes devEnvDir = checkout root only when not packaged',
  /loadEnvironmentVariables\(\{\s*devEnvDir:\s*app\.isPackaged\s*\?\s*null\s*:\s*path\.join\(__dirname,\s*'\.\.'\)/.test(mainSrc));
check('load-env.cjs no longer builds a path from process.cwd()', !/path\.join\(process\.cwd\(\)/.test(fs.readFileSync(path.join(REPO, 'electron', 'load-env.cjs'), 'utf8')));
check('main.cjs write-env-file sanitizes before building content',
  /ipcMain\.handle\('write-env-file'[\s\S]{0,400}sanitizeEnvData\(envData\)/.test(mainSrc));

for (const d of [home, cwd, devDir]) fs.rmSync(d, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
