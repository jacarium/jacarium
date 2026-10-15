/**
 * Jira is optional in the desktop app (electron/jira-config.cjs, used by
 * main.cjs's 'jira-fetch' handler): without JIRA_URL (or the token) the
 * handler answers a clean "not configured" result - no request, no thrown
 * error, no stack trace, one info line per session at most - and an
 * invalid JIRA_URL is reported the same way.
 *
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const { jiraConfig, notConfiguredResult, JIRA_NOT_CONFIGURED } = req(path.join(REPO, 'electron', 'jira-config.cjs'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

let c = jiraConfig({});
check('no JIRA_URL: not configured, with the setting named and no origin', c.configured === false && /JIRA_URL/.test(c.reason) && c.origin === null);
c = jiraConfig({ JIRA_URL: 'https://example.atlassian.net/', JIRA_PAT: 'synthetic-token' });
check('JIRA_URL + token: configured, the origin without the trailing slash', c.configured === true && c.origin === 'https://example.atlassian.net' && c.reason === null);
c = jiraConfig({ JIRA_URL: 'https://example.atlassian.net' });
check('JIRA_URL without a token: not configured (the token is named)', c.configured === false && /JIRA_PAT/.test(c.reason));
c = jiraConfig({ JIRA_URL: 'http://example.atlassian.net', JIRA_PAT: 'x' });
check('a non-https JIRA_URL: not configured, reported as invalid', c.configured === false && /https/.test(c.reason) && c.invalid === true);
c = jiraConfig({ JIRA_URL: 'https://example.atlassian.net/jira?x=1', JIRA_PAT: 'x' });
check('a JIRA_URL with a path or query: invalid', c.configured === false && c.invalid === true);

// the handler's answer: a resolved result the renderer understands, never a throw; one log line per session
const logs = [];
const log = { info: (m) => logs.push(m) };
const first = notConfiguredResult(jiraConfig({}), log);
const second = notConfiguredResult(jiraConfig({}), log);
check('the not-configured result is a clean 412 with the code and the message', first.ok === false && first.status === 412 && first.data?.code === JIRA_NOT_CONFIGURED && /Settings > Integrations > Jira/.test(first.data.error), JSON.stringify(first));
check('...logged once per session, not on every request', logs.length === 1 && second.status === 412, JSON.stringify(logs));

// main.cjs uses it before anything else in the handler
const main = fs.readFileSync(path.join(REPO, 'electron', 'main.cjs'), 'utf8');
check("main.cjs's jira-fetch answers notConfiguredResult before credentials or any request", /ipcMain\.handle\('jira-fetch'[\s\S]{0,400}const config = jiraConfig\(process\.env\);\s*if \(!config\.configured\) return notConfiguredResult\(config, console\);/.test(main));
check('main.cjs re-reads the settings file after a save, so a Jira URL set in Settings applies without a restart', /ipcMain\.handle\('write-settings'[\s\S]{0,400}reloadEnvironment\(\)/.test(main));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
