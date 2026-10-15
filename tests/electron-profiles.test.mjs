/**
 * Guards the desktop profiles module (electron/profiles.cjs): several
 * separate sets of data in one installation, replacing INSTANCE_NAME.
 *
 * What this test proves (plain Node, a throwaway root directory, synthetic
 * files only):
 *   - names: valid / invalid / reserved; the default profile is Electron's
 *     userData, a named one ~/.config/jacarium-<name>;
 *   - listing: the default profile is always first (even before its
 *     directory exists), named ones are found and sorted, unrelated
 *     directories are ignored;
 *   - selection: --profile / --profile= / INSTANCE_NAME win; one profile
 *     opens without asking; several ask unless a choice was remembered;
 *     --profile-picker always asks; an invalid name asks;
 *   - prepareProfile: creates the directory and backend home, copies the
 *     real home's settings file and known_hosts ONCE (never over an
 *     existing file), writes profile.json; the default profile gets no
 *     backend home and no copies;
 *   - backendEnvForProfile / envFilePathFor: nothing for the default
 *     profile, the profile's own paths otherwise;
 *   - machineUsernameForProfile: user for default, user+name otherwise;
 *   - stripProfileArgs removes every profile argument for a relaunch;
 *   - pickFreePort returns the preferred port when free and another when
 *     it is taken.
 *
 * Run:  node tests/electron-profiles.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const profiles = require('../electron/profiles.cjs');

let failed = 0;
function check(name, pass, detail = '') {
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-test-'));
const ROOT = path.join(TMP, 'config');
const DEFAULT_DIR = path.join(TMP, 'electron-userdata');
const SEED = path.join(TMP, 'home');
fs.mkdirSync(path.join(SEED, '.jacarium'), { recursive: true });
fs.writeFileSync(path.join(SEED, '.jacarium.env'), 'JIRA_URL=https://jira.example.test\nJIRA_PAT=synthetic-pat\n');
fs.writeFileSync(path.join(SEED, '.jacarium', 'known_hosts'), 'host.example.test ssh-ed25519 AAAAsynthetic\n');

// ---- names and directories ----
check('valid names are lower-cased and accepted', profiles.validateProfileName(' Work ').ok && profiles.validateProfileName(' Work ').value === 'work');
for (const bad of ['', 'Bad Name', '-x', 'a'.repeat(33), 'default', 'picker', 'server', 'x/y', null]) {
  check(`invalid or reserved name refused: ${JSON.stringify(bad)}`, !profiles.validateProfileName(bad).ok);
}
check('the default profile dir is Electron userData', profiles.profileDir(ROOT, 'default', DEFAULT_DIR) === DEFAULT_DIR);
check('a named profile dir is <root>/jacarium-<name>', profiles.profileDir(ROOT, 'work', DEFAULT_DIR) === path.join(ROOT, 'jacarium-work'));
check('profilesRoot honours JACARIUM_PROFILES_ROOT and defaults to ~/.config', profiles.profilesRoot({ JACARIUM_PROFILES_ROOT: ROOT }, '/h') === ROOT && profiles.profilesRoot({}, '/h') === path.join('/h', '.config'));

// ---- listing ----
let list = profiles.listProfiles(ROOT, DEFAULT_DIR);
check('an empty root lists only the (not yet existing) default profile', list.length === 1 && list[0].isDefault && list[0].exists === false, JSON.stringify(list));
fs.mkdirSync(path.join(ROOT, 'jacarium-work'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'jacarium-alice'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'jacarium'), { recursive: true });      // the browser deployment's dir on Linux = the default (ignored as "named")
fs.mkdirSync(path.join(ROOT, 'jacarium-Bad Name'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'other-app'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'jacarium-work', 'profile.json'), JSON.stringify({ displayName: 'Work laptop', lastUsedAt: '2026-10-01T00:00:00Z' }));
list = profiles.listProfiles(ROOT, DEFAULT_DIR);
check('named profiles are listed after the default, sorted, with their metadata; odd dirs ignored',
  list.map((p) => p.name).join(',') === 'default,alice,work' && list[2].displayName === 'Work laptop' && list[2].lastUsedAt === '2026-10-01T00:00:00Z' && list[1].exists, list.map((p) => p.name).join(','));

// ---- selection ----
const sel = (argv, env = {}, settings = {}) => profiles.resolveProfileSelection({ argv, env, profiles: profiles.listProfiles(ROOT, DEFAULT_DIR), settings });
check('--profile <name> wins', sel(['electron', '.', '--profile', 'Work']).name === 'work');
check('--profile=<name> works too', sel(['app', '--profile=alice']).name === 'alice');
check('--profile default names the default profile (no picker)', sel(['app', '--profile', 'default']).name === 'default' && sel(['app', '--profile', 'Default']).name === 'default');
check('INSTANCE_NAME is a profile name', sel([], { INSTANCE_NAME: 'bob' }).name === 'bob');
check('--profile-picker asks', sel(['app', '--profile-picker']).ask === true);
check('an invalid name asks instead of crashing', sel(['app', '--profile', 'Bad Name']).ask === true);
check('several profiles with nothing remembered ask', sel([]).ask === true);
check('a remembered choice opens it', sel([], {}, { defaultProfile: 'work' }).name === 'work');
check('a remembered choice that no longer exists asks', sel([], {}, { defaultProfile: 'gone' }).ask === true);
const ONLY = path.join(TMP, 'only-default');
fs.mkdirSync(ONLY, { recursive: true });
check('one profile opens without asking', profiles.resolveProfileSelection({ argv: [], env: {}, profiles: profiles.listProfiles(ONLY, DEFAULT_DIR), settings: {} }).name === 'default');

// ---- prepareProfile ----
const workDir = profiles.profileDir(ROOT, 'work', DEFAULT_DIR);
let prepared = profiles.prepareProfile(workDir, 'work', { seed: SEED, now: Date.parse('2026-10-11T10:00:00Z') });
const backendHome = path.join(workDir, 'backend');
check('a named profile gets a backend home with the seed settings file and known_hosts copied',
  fs.readFileSync(path.join(backendHome, '.jacarium.env'), 'utf8').includes('synthetic-pat') && fs.readFileSync(path.join(backendHome, '.ssh', 'known_hosts'), 'utf8').includes('AAAAsynthetic') && prepared.copied.join(',') === '.jacarium.env,known_hosts', JSON.stringify(prepared));
check('the copies are private (0600)', (fs.statSync(path.join(backendHome, '.jacarium.env')).mode & 0o777) === 0o600);
check('profile.json keeps the display name and records lastUsedAt', JSON.parse(fs.readFileSync(path.join(workDir, 'profile.json'), 'utf8')).displayName === 'Work laptop' && profiles.readProfileMeta(workDir).lastUsedAt === '2026-10-11T10:00:00.000Z');
fs.writeFileSync(path.join(backendHome, '.jacarium.env'), 'JIRA_URL=https://changed.example.test\n');
prepared = profiles.prepareProfile(workDir, 'work', { seed: SEED });
check('a second run never overwrites the profile\'s own files', prepared.copied.length === 0 && fs.readFileSync(path.join(backendHome, '.jacarium.env'), 'utf8').includes('changed.example.test'));
const newDir = profiles.profileDir(ROOT, 'fresh', DEFAULT_DIR);
prepared = profiles.prepareProfile(newDir, 'fresh', { seed: SEED });
check('a new profile is created on first use', prepared.created && fs.existsSync(newDir) && profiles.readProfileMeta(newDir).createdAt);
prepared = profiles.prepareProfile(DEFAULT_DIR, 'default', { seed: SEED });
check('the default profile gets no backend home and no copies', !fs.existsSync(path.join(DEFAULT_DIR, 'backend')) && prepared.copied.length === 0 && fs.existsSync(path.join(DEFAULT_DIR, 'profile.json')));

// ---- backend env / settings file / identity ----
check('the default profile adds nothing to the backend environment', Object.keys(profiles.backendEnvForProfile(DEFAULT_DIR, 'default')).length === 0);
const env = profiles.backendEnvForProfile(workDir, 'work');
check('a named profile passes its backend home, settings file and known_hosts',
  env.JACARIUM_PROFILE_HOME === backendHome && env.JACARIUM_ENV_FILE === path.join(backendHome, '.jacarium.env') && env.JACARIUM_KNOWN_HOSTS === path.join(backendHome, '.ssh', 'known_hosts'), JSON.stringify(env));
check('envFilePathFor: the real home for default, the profile\'s file otherwise', profiles.envFilePathFor(DEFAULT_DIR, 'default', '/h') === '/h/.jacarium.env' && profiles.envFilePathFor(workDir, 'work', '/h') === path.join(backendHome, '.jacarium.env'));
check('the cloud username is user for default and user+name otherwise', profiles.machineUsernameForProfile('robin', 'default') === 'robin' && profiles.machineUsernameForProfile('robin', null) === 'robin' && profiles.machineUsernameForProfile('robin', 'work') === 'robin+work');
check('stripProfileArgs removes every profile argument', profiles.stripProfileArgs(['.', '--profile', 'work', '--foo', '--profile=x', '--profile-picker']).join(' ') === '. --foo');

// ---- ports ----
const blocker = net.createServer();
await new Promise((resolve) => blocker.listen({ port: 0, host: '127.0.0.1' }, resolve));
const taken = blocker.address().port;
const picked = await profiles.pickFreePort(taken);
check('pickFreePort skips a taken port', picked !== taken && Number.isInteger(picked) && picked > 0, `${taken} -> ${picked}`);
blocker.close();
const free = await profiles.pickFreePort(taken);
check('...and returns the preferred port once it is free', free === taken, `${free}`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
