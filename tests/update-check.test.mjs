/**
 * The desktop app's release check (electron/update-check.cjs), without
 * GitHub: a fake fetch records every request, a temp store file stands in
 * for the profile's update-check.json, and a fake clock drives the once-a-day
 * rule.
 *
 * Proves:
 *   - version parsing and comparison (vX.Y.Z and X.Y.Z, numeric order);
 *   - the GitHub answer is reduced to published vX.Y.Z releases, newest
 *     first - drafts, pre-releases and odd tags are dropped;
 *   - the notes shown are every version between the running one and the
 *     newest, newest first, with their dates;
 *   - dismissal: "Skip 3.2.0" hides 3.2.0; a 3.2.1 shows up again;
 *   - the download picked per platform (dmg on macOS, AppImage when running
 *     as one, deb/rpm by distro, the releases page otherwise);
 *   - the request carries no identifying data: the fixed URL and exactly the
 *     Accept and User-Agent headers, no version, no query, no credentials;
 *   - the automatic check is OFF by default and makes no request; turned on,
 *     it makes one request a day and no more; the manual check works while it
 *     is off; turning it off stops the scheduled checks;
 *   - offline / GitHub failing: no throw, nothing shown, the failure recorded
 *     and the next scheduled check waits for its turn.
 *
 * Run:  node tests/update-check.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const uc = require('../electron/update-check.cjs');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`);
}

const DAY = 24 * 60 * 60 * 1000;
const release = (tag, extra = {}) => ({
  tag_name: tag, name: `Jacarium ${tag.slice(1)}`, body: `notes for ${tag}`, draft: false, prerelease: false,
  published_at: `2026-10-${String(10 + Number(tag.split('.')[2])).padStart(2, '0')}T10:00:00Z`,
  html_url: `https://github.com/jacarium/jacarium/releases/tag/${tag}`,
  assets: [
    { name: `Jacarium-${tag.slice(1)}-arm64.dmg`, browser_download_url: `https://dl/${tag}/mac-arm64.dmg`, size: 1 },
    { name: `Jacarium-${tag.slice(1)}-arm64.AppImage`, browser_download_url: `https://dl/${tag}/arm64.AppImage`, size: 1 },
    { name: `Jacarium-${tag.slice(1)}.AppImage`, browser_download_url: `https://dl/${tag}/x64.AppImage`, size: 1 },
    { name: `jacarium_${tag.slice(1)}_amd64.deb`, browser_download_url: `https://dl/${tag}/amd64.deb`, size: 1 },
    { name: `jacarium-${tag.slice(1)}.x86_64.rpm`, browser_download_url: `https://dl/${tag}/x86_64.rpm`, size: 1 },
    { name: 'SHA256SUMS.txt', browser_download_url: `https://dl/${tag}/SHA256SUMS.txt`, size: 1 }
  ],
  ...extra
});

// ---------- versions ----------
check('parseVersion accepts v3.1.9 and 3.1.9, rejects the rest', JSON.stringify(uc.parseVersion('v3.1.9')) === '[3,1,9]' && JSON.stringify(uc.parseVersion('3.10.0')) === '[3,10,0]' && uc.parseVersion('3.1') === null && uc.parseVersion('v3.1.9-rc1') === null && uc.parseVersion('') === null);
check('compareVersions orders numerically (3.1.10 > 3.1.9 > 3.0.99)', uc.compareVersions('3.1.10', '3.1.9') > 0 && uc.compareVersions('3.1.9', '3.0.99') > 0 && uc.compareVersions('3.1.9', 'v3.1.9') === 0 && uc.compareVersions('garbage', '0.0.1') < 0);

// ---------- normalisation ----------
const raw = [
  release('v3.2.0'), release('v3.1.9'),
  release('v3.3.0', { draft: true }), release('v3.4.0-beta.1', { prerelease: true }), release('nightly-2026'), { tag_name: 'v9.9.9', draft: false, prerelease: true },
  release('v3.2.1'), release('v2.6.0')
];
const releases = uc.normalizeReleases(raw);
check('normalizeReleases keeps published vX.Y.Z releases only, newest first', releases.map((r) => r.version).join(',') === '3.2.1,3.2.0,3.1.9,2.6.0', releases.map((r) => r.version).join(','));
check('...with name, body, date, url and assets', releases[0].name === 'Jacarium 3.2.1' && releases[0].body === 'notes for v3.2.1' && releases[0].publishedAt.startsWith('2026-10-11') && /releases\/tag\/v3\.2\.1$/.test(releases[0].url) && releases[0].assets.length === 6);
check('normalizeReleases tolerates garbage', uc.normalizeReleases(null).length === 0 && uc.normalizeReleases({ message: 'rate limited' }).length === 0 && uc.normalizeReleases([null, 1, 'x']).length === 0);

// ---------- what is newer, and the notes ----------
check('releasesNewerThan 3.1.9 = 3.2.1, 3.2.0', uc.releasesNewerThan(releases, '3.1.9').map((r) => r.version).join(',') === '3.2.1,3.2.0');
check('releasesNewerThan 3.2.1 = nothing', uc.releasesNewerThan(releases, '3.2.1').length === 0);
const notes = uc.notesSince(releases, '3.1.9');
check('notesSince: every version in between, newest first, with dates and bodies', /^## Version 3\.2\.1 \(2026-10-11\)\n\nnotes for v3\.2\.1\n\n## Version 3\.2\.0 \(2026-10-10\)\n\nnotes for v3\.2\.0\n$/.test(notes), JSON.stringify(notes));
check('notesSince: nothing newer -> empty', uc.notesSince(releases, '3.2.1') === '');
check('notesSince: an empty body gets a placeholder', /_No release notes\._/.test(uc.notesSince(uc.normalizeReleases([release('v3.2.0', { body: '' })]), '3.1.9')));

// ---------- dismissal ----------
check('shouldShowUpdate: newer and nothing skipped -> show', uc.shouldShowUpdate({ latestVersion: '3.2.0', currentVersion: '3.1.9', dismissedVersion: null }) === true);
check('shouldShowUpdate: skipped 3.2.0 -> hidden', uc.shouldShowUpdate({ latestVersion: '3.2.0', currentVersion: '3.1.9', dismissedVersion: '3.2.0' }) === false);
check('shouldShowUpdate: skipped 3.2.0, 3.2.1 out -> shown again', uc.shouldShowUpdate({ latestVersion: '3.2.1', currentVersion: '3.1.9', dismissedVersion: '3.2.0' }) === true);
check('shouldShowUpdate: running the latest -> hidden', uc.shouldShowUpdate({ latestVersion: '3.1.9', currentVersion: '3.1.9', dismissedVersion: null }) === false && uc.shouldShowUpdate({ latestVersion: null, currentVersion: '3.1.9' }) === false);

// ---------- the once-a-day rule ----------
check('isCheckDue: never checked -> due; 23h ago -> not due; 24h ago -> due', uc.isCheckDue(null, 1e12) && !uc.isCheckDue(1e12 - 23 * 3600e3, 1e12) && uc.isCheckDue(1e12 - DAY, 1e12));

// ---------- the download for this installation ----------
const assets = releases[0].assets;
check('pickDownload: macOS arm64 -> the arm64 dmg', uc.pickDownload({ assets, platform: 'darwin', arch: 'arm64' }).url === 'https://dl/v3.2.1/mac-arm64.dmg');
check('pickDownload: Linux as an AppImage (APPIMAGE set) -> the AppImage of the architecture', uc.pickDownload({ assets, platform: 'linux', arch: 'x64', appImage: true }).url === 'https://dl/v3.2.1/x64.AppImage' && uc.pickDownload({ assets, platform: 'linux', arch: 'arm64', appImage: true }).url === 'https://dl/v3.2.1/arm64.AppImage');
check('pickDownload: Linux installed from a deb / rpm -> that package', uc.pickDownload({ assets, platform: 'linux', arch: 'x64', linuxPackage: 'deb' }).url === 'https://dl/v3.2.1/amd64.deb' && uc.pickDownload({ assets, platform: 'linux', arch: 'x64', linuxPackage: 'rpm' }).url === 'https://dl/v3.2.1/x86_64.rpm');
check('pickDownload: no matching asset / other platform -> the releases page', uc.pickDownload({ assets: [], platform: 'darwin', arch: 'arm64', releaseUrl: 'https://rel' }).url === 'https://rel' && uc.pickDownload({ assets, platform: 'win32', arch: 'x64' }).url === uc.RELEASES_PAGE_URL);

// ---------- the request itself ----------
{
  const req = uc.buildRequest();
  check('the request is the fixed releases URL with per_page only', req.url === 'https://api.github.com/repos/jacarium/jacarium/releases?per_page=30');
  check('...and exactly Accept + a version-less User-Agent, nothing identifying', Object.keys(req.headers).sort().join(',') === 'Accept,User-Agent' && req.headers['User-Agent'] === 'jacarium-update-check' && !/\d/.test(req.headers['User-Agent']));
}

// ---------- the checker, with a fake GitHub, store and clock ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'update-check-test-'));
const storePath = path.join(tmp, 'update-check.json');
let clock = 1_800_000_000_000;
const requests = [];
let answer = () => ({ ok: true, status: 200, json: async () => [release('v3.2.0'), release('v3.1.9')] });
const fetch = async (url, init) => { requests.push({ url, init }); return answer(); };
const shown = [];
const checker = uc.createUpdateChecker({
  currentVersion: '3.1.9', fetch, storePath, platform: 'linux', arch: 'x64', env: { APPIMAGE: '/tmp/Jacarium.AppImage' },
  now: () => clock, onUpdate: (s) => shown.push(s.latestVersion)
});

const s0 = checker.status();
check('default: automatic checks off, nothing known, nothing shown', s0.autoCheck === false && s0.updateAvailable === false && s0.shouldShow === false && s0.lastCheckedAt === null);
await checker.tick();
check('default: the scheduled tick makes NO request', requests.length === 0);

const manual = await checker.check({ manual: true });
check('manual check with the setting off: ONE request, finds 3.2.0, asks to show it', requests.length === 1 && manual.updateAvailable && manual.latestVersion === '3.2.0' && manual.shouldShow && shown.length === 1);
check('...the request went to the fixed URL with the fixed headers, no credentials', requests[0].url === uc.RELEASES_API_URL && requests[0].init.credentials === 'omit' && Object.keys(requests[0].init.headers).sort().join(',') === 'Accept,User-Agent');
check('...and reports the AppImage download and the notes', manual.download.url === 'https://dl/v3.2.0/x64.AppImage' && /## Version 3\.2\.0/.test(manual.notes) && manual.releases.length === 1);
check('the result is persisted in the store file', JSON.parse(fs.readFileSync(storePath, 'utf8')).releases.length === 2);
await checker.tick();
check('still off: the next tick makes no request', requests.length === 1);

checker.dismiss('3.2.0');
check('Skip this version: 3.2.0 no longer asks to be shown', checker.status().shouldShow === false && checker.status().dismissedVersion === '3.2.0' && checker.status().updateAvailable === true);

checker.setAutoCheck(true);
clock += 1000;
await checker.tick();
check('turned on: a tick right after a check waits (once a day)', requests.length === 1);
clock += DAY;
answer = () => ({ ok: true, status: 200, json: async () => [release('v3.2.1'), release('v3.2.0'), release('v3.1.9')] });
await checker.tick();
check('turned on, a day later: one request', requests.length === 2);
check('3.2.1 is out: shown again although 3.2.0 was skipped', checker.status().latestVersion === '3.2.1' && checker.status().shouldShow === true && shown[shown.length - 1] === '3.2.1');
clock += DAY / 2;
await checker.tick();
check('half a day later: no request', requests.length === 2);
clock += DAY;
const s = checker.status();
check('a tick exactly a day later: one more request; not two', await checker.tick() && requests.length === 3);
check('status keeps the settings and the result together', s.autoCheck === true && s.currentVersion === '3.1.9' && s.releasesPage === uc.RELEASES_PAGE_URL);

checker.setAutoCheck(false);
clock += 2 * DAY;
await checker.tick();
check('turned off again: no request however much time passes', requests.length === 3 && checker.status().autoCheck === false);

// ---------- failures ----------
checker.setAutoCheck(true);
clock += DAY;
answer = () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); };
const offline = await checker.tick();
check('offline: no throw, the error recorded, the last good result kept', !!offline && /ENOTFOUND/.test(offline.lastError) && offline.latestVersion === '3.2.1');
clock += 1000;
await checker.tick();
check('offline: the failed check counts as today\'s; no retry storm', requests.length === 4);
clock += DAY;
answer = () => ({ ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }) });
const limited = await checker.tick();
check('GitHub rate limit (403): recorded, nothing thrown', requests.length === 5 && /403/.test(limited.lastError));
clock += DAY;
answer = () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
const garbage = await checker.tick();
check('garbage answer: recorded, nothing thrown', requests.length === 6 && /bad json/.test(garbage.lastError));
clock += DAY;
answer = () => ({ ok: true, status: 200, json: async () => [release('v3.2.1'), release('v3.1.9')] });
await checker.tick();
check('back online: the error clears', checker.status().lastError === null);

fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
