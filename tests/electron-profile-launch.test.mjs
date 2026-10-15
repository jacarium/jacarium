/**
 * Guards desktop profiles in the REAL Electron app (electron/main.cjs +
 * electron/profiles.cjs): a named profile opens on its own data, and with
 * several profiles and no choice the picker window opens instead.
 *
 * Launched like the other Electron tests (tests/helpers/electron-app.mjs:
 * Vite dev server + Playwright on throwaway directories; the profile root
 * and the seed home are redirected to temp dirs, so the user's own
 * ~/.config and ~/.jacarium.env are never read or written).
 *
 * What this test proves:
 *   - `--profile synthetic` (with a throwaway JACARIUM_PROFILES_ROOT):
 *     the window's userData is <root>/jacarium-synthetic, the cloud
 *     username is user+synthetic, the backend port answers, the profile
 *     got a backend home with the seed settings file copied, and
 *     profile.json exists;
 *   - with --profile-picker (what File > Switch Profile relaunches with)
 *     the first window is the profile picker listing the default and both
 *     named profiles (no app window, no backend started).
 *
 * Skips (exit 0 with a SKIP line) like the other Electron tests.
 * Run:  node tests/electron-profile-launch.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectronApp } from './helpers/electron-app.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`); if (!ok) failed++; };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-root-'));
const SEED = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-seed-'));
fs.writeFileSync(path.join(SEED, '.jacarium.env'), 'JIRA_URL=https://jira.example.test\nJIRA_PAT=synthetic-seed-pat\n');
const env = { JACARIUM_PROFILES_ROOT: ROOT, JACARIUM_PROFILE_SEED_HOME: SEED, PORT: '' };

// ---- 1. a named profile ----
let launched = await launchElectronApp({ profilePrefix: 'profile-launch-', args: ['--profile', 'synthetic'], env });
if (launched.skip) { console.log('SKIP: ' + launched.skip); process.exit(0); }
try {
  const { page } = launched;
  const profileDir = path.join(ROOT, 'jacarium-synthetic');
  const appPath = await page.evaluate(() => window.electronAPI.getAppPath());
  check('the window runs on the named profile\'s userData', path.resolve(appPath) === path.resolve(profileDir), appPath);
  const name = await page.evaluate(() => window.electronAPI.getProfileName());
  check('the app knows its profile name', name === 'synthetic', String(name));
  const username = await page.evaluate(() => window.electronAPI.getUsername());
  check('the cloud username carries the profile (user+synthetic)', /\+synthetic$/.test(username), username);
  const port = await page.evaluate(() => window.electronAPI.getBackendPort());
  check('a backend port was chosen', /^\d+$/.test(String(port)), String(port));
  check('the profile has a backend home with the seed settings copied', fs.readFileSync(path.join(profileDir, 'backend', '.jacarium.env'), 'utf8').includes('synthetic-seed-pat'));
  check('profile.json was written', fs.existsSync(path.join(profileDir, 'profile.json')));
  const settings = await page.evaluate(() => window.electronAPI.readSettings());
  check('Settings read the profile\'s own file (plain value visible, secret only as stored)', settings?.values?.JIRA_URL === 'https://jira.example.test' && settings?.secrets?.JIRA_PAT === true, JSON.stringify(settings));
} catch (error) {
  check('the named-profile run completed', false, error.message);
} finally {
  await launched.close();
}

// ---- 2. the picker ----
fs.mkdirSync(path.join(ROOT, 'jacarium-second'), { recursive: true });
// (the driver's userData override means "the default profile" by itself, so
// the picker is asked for explicitly - as File > Switch Profile does)
launched = await launchElectronApp({ profilePrefix: 'profile-picker-', args: ['--profile-picker'], env, expectWindow: (w) => /profile-picker\.html/.test(w.url()) });
if (launched.skip) { console.log('SKIP (picker): ' + launched.skip); }
else {
  try {
    const { app, page } = launched;
    await page.waitForSelector('[data-testid="profile-list"] button', { timeout: 20000 });
    const names = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="profile-list"] button')).map((b) => b.dataset.profile));
    check('the picker lists the default profile and both named ones', names.join(',') === 'default,second,synthetic', names.join(','));
    const appWindows = app.windows().filter((w) => /localhost:5173/.test(w.url()));
    check('no app window was opened (nothing of a profile touched)', appWindows.length === 0, String(app.windows().map((w) => w.url())));
    await page.fill('#name', 'Bad Name');
    await page.click('#create-button');
    await page.waitForFunction(() => document.getElementById('error').textContent.length > 0, null, { timeout: 10000 });
    check('an invalid new name is refused in the picker', /Profile name/.test(await page.evaluate(() => document.getElementById('error').textContent)));
  } catch (error) {
    check('the picker run completed', false, error.message);
  } finally {
    await launched.close();
  }
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(SEED, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
