/**
 * Jira is optional (src/services/jiraApi.js): with no Jira URL configured
 * nothing Jira-related runs - no request through the desktop bridge, the
 * backend proxy or the Vite proxy, no error logged - and the pages show a
 * calm "Jira isn't set up" state with a button to Settings > Integrations.
 *
 * Real module over jsdom with a mocked settings bridge:
 *   - isJiraConfigured() is false with no JIRA_URL; fetchAllJiraData()
 *     answers the empty structure without any fetch; a fetcher
 *     (fetchStatuses) rejects with code JIRA_NOT_CONFIGURED without a
 *     network call and without console.error;
 *   - once the settings carry a JIRA_URL and the save is announced
 *     ('settingsSaved'), isJiraConfigured() is true and the fetcher goes
 *     out through the bridge (no restart);
 *   - the bridge's own 412 "not configured" answer is turned into the same
 *     typed error, not a logged exception;
 *   - statically: the JQL builder gates its loads on isJiraConfigured and
 *     renders the empty state with openAppSettings('integrations');
 *     settingsStore announces saves.
 * Run: node tests/jira-optional.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
for (const dep of ['fake-indexeddb', 'esbuild', 'dexie', 'jsdom']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} missing (npm install --no-save jsdom fake-indexeddb)`); process.exit(0); } }
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

// ---- static: the page and the settings store ----
const jql = fs.readFileSync(path.join(REPO, 'src/components/JQLBuilder.jsx'), 'utf8');
check('JQLBuilder imports isJiraConfigured and loads Jira data only when configured', /isJiraConfigured/.test(jql) && /if \(!(?:await )?isJiraConfigured\(\)|jiraConfigured === false|!configured/.test(jql));
const notConfigured = fs.readFileSync(path.join(REPO, 'src/components/common/IntegrationNotConfigured.jsx'), 'utf8');
check("JQLBuilder renders the 'Jira isn't set up' state with a button to Settings > Integrations (the shared IntegrationNotConfigured)", /testId="jira-unconfigured"/.test(jql) && /<IntegrationNotConfigured/.test(jql) && /openAppSettings\('integrations', \{ section \}\)/.test(notConfigured) && /section="jira"/.test(jql) && /isn't set up/.test(notConfigured));
check('JQLBuilder re-checks after a settings save (no restart)', /settingsSaved/.test(jql));
const store = fs.readFileSync(path.join(REPO, 'src/services/settingsStore.js'), 'utf8');
check("settingsStore announces a save ('settingsSaved') for the desktop and the backend path", (store.match(/new Event\('settingsSaved'\)/g) || []).length >= 1);

// ---- the service in jsdom ----
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://console.test/' });
for (const key of ['window', 'document', 'CustomEvent', 'Event']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
await import(req.resolve('fake-indexeddb/auto'));
dom.window.indexedDB = globalThis.indexedDB; dom.window.IDBKeyRange = globalThis.IDBKeyRange;
const settings = { values: {}, secrets: {} };
const bridgeCalls = [];
globalThis.window.electronAPI = {
  readSettings: async () => ({ values: { ...settings.values }, secrets: { ...settings.secrets } }),
  writeSettings: async (p) => { Object.assign(settings.values, p.values || {}); return { values: settings.values, secrets: settings.secrets }; },
  jiraFetch: async (endpoint) => { bridgeCalls.push(endpoint); return { ok: true, status: 200, statusText: 'OK', data: [{ id: '1', name: 'Open', description: '' }] }; },
  getBackendPort: async () => 8080,
  getAppToken: async () => 'synthetic',
};
const fetchCalls = [];
globalThis.fetch = async (url) => { fetchCalls.push(String(url)); return { ok: false, status: 599, text: async () => '', json: async () => ({}) }; };
const errors = [];
const realError = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ')); };
const realLog = console.log; console.log = () => {};

const { build } = await import(req.resolve('esbuild'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-optional-'));
const OUT = path.join(WORK, 'jira.cjs');
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `export * from ${JSON.stringify(path.join(REPO, 'src/services/jiraApi.js'))};`);
await build({ entryPoints: [ENTRY], bundle: true, outfile: OUT, format: 'cjs', platform: 'node', logLevel: 'silent', define: { 'import.meta.env': '{}' } });
const jira = req(OUT);
console.log = realLog;

check('isJiraConfigured() is false with no Jira URL', (await jira.isJiraConfigured()) === false);
const empty = await jira.fetchAllJiraData(false);
check('fetchAllJiraData answers the empty structure without any request', empty && Array.isArray(empty.projects) && empty.projects.length === 0 && bridgeCalls.length === 0 && fetchCalls.length === 0, JSON.stringify({ bridgeCalls, fetchCalls }));
let rejected = null;
try { await jira.fetchStatuses(true); } catch (e) { rejected = e; }
check('a fetcher rejects with the typed error and no request', rejected && rejected.code === 'JIRA_NOT_CONFIGURED' && bridgeCalls.length === 0 && fetchCalls.length === 0, rejected && rejected.message);
check('...and nothing was logged as an error', errors.length === 0, errors.join(' | '));

// the owner sets the URL in Settings: the save is announced, the service re-reads, requests go out
settings.values.JIRA_URL = 'https://example.atlassian.net';
settings.secrets.JIRA_PAT = true;
globalThis.window.dispatchEvent(new globalThis.window.Event('settingsSaved'));
check('after the save isJiraConfigured() is true (no restart)', (await jira.isJiraConfigured()) === true);
const statuses = await jira.fetchStatuses(true);
check('the fetcher now goes out through the desktop bridge', bridgeCalls.length === 1 && bridgeCalls[0] === '/status' && statuses.length === 1, JSON.stringify(bridgeCalls));

// the bridge answering 412 (main found no configuration): the same typed error, nothing logged as an exception
globalThis.window.electronAPI.jiraFetch = async () => ({ ok: false, status: 412, statusText: 'Jira not configured', data: { error: 'JIRA_URL not configured', code: 'JIRA_NOT_CONFIGURED' } });
errors.length = 0; rejected = null;
try { await jira.fetchStatuses(true); } catch (e) { rejected = e; }
check("the bridge's 412 becomes the typed error", rejected && rejected.code === 'JIRA_NOT_CONFIGURED', rejected && rejected.message);
check('...without a console.error', errors.length === 0, errors.join(' | '));

console.error = realError;
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
