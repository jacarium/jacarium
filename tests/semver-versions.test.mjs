#!/usr/bin/env node
/**
 * Semantic Versioning across every consumer of a version: parts of any size (3.4.10, 3.10.0, 10.0.0) compare
 * numerically and order correctly everywhere a version is compared or produced:
 *   - scripts/release.cjs: nextVersion (patch / minor / major, the explicit target rule) and compareVersions;
 *   - electron/update-check.cjs: parseVersion, compareVersions, normalizeReleases' ordering, releasesNewerThan
 *     (a 3.4.10 release is newer than 3.4.9, not older by string order);
 *   - src/whats-new/categories.js: compareVersions (the "unseen" marker) and majorLinesOf (10 before 9);
 *   - scripts/publish-release.sh passes --minor / --major through to the release command and refuses them
 *     with an exact version or with --resume (static);
 *   - nothing left assumes single-digit parts: the version-consistency guard accepts 3.4.10.
 * The What's New window's import names (v3_4_10) and file names (v3.4.10.js) are checked to be valid.
 *
 * Run: node tests/semver-versions.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = require(path.join(REPO, 'scripts', 'release.cjs'));
const uc = require(path.join(REPO, 'electron', 'update-check.cjs'));
const categories = await import(path.join(REPO, 'src', 'whats-new', 'categories.js'));

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || !detail ? '' : ' | ' + String(detail).slice(0, 300)}`); if (!ok) failed++; };

// ---- release.cjs ----
check('patch: 3.4.9 -> 3.4.10, 3.4.99 -> 3.4.100 (no cap)', release.nextVersion('3.4.9', null) === '3.4.10' && release.nextVersion('3.4.99', null, 'patch') === '3.4.100');
check('minor: 3.9.9 -> 3.10.0; major: 9.9.9 -> 10.0.0', release.nextVersion('3.9.9', null, 'minor') === '3.10.0' && release.nextVersion('9.9.9', null, 'major') === '10.0.0');
check('an explicit 3.10.0 after 3.9.9 is accepted, 3.4.9 after 3.4.10 refused (numeric, not string order)', release.nextVersion('3.9.9', '3.10.0') === '3.10.0' && (() => { try { release.nextVersion('3.4.10', '3.4.9'); return false; } catch (e) { return /not greater/.test(e.message); } })());
check('compareVersions: 3.4.10 > 3.4.9, 3.10.0 > 3.9.99, 10.0.0 > 9.99.99', release.compareVersions('3.4.10', '3.4.9') > 0 && release.compareVersions('3.10.0', '3.9.99') > 0 && release.compareVersions('10.0.0', '9.99.99') > 0);
check('an unknown bump is refused', (() => { try { release.nextVersion('3.4.9', null, 'huge'); return false; } catch (e) { return /Unknown bump/.test(e.message); } })());

// ---- the update check ----
check('update-check parseVersion reads multi-digit parts', JSON.stringify(uc.parseVersion('v3.4.10')) === '[3,4,10]' && JSON.stringify(uc.parseVersion('10.0.0')) === '[10,0,0]');
check('update-check compareVersions: 3.4.10 > 3.4.9, 3.10.0 > 3.9.9, 10.0.0 > 9.9.9', uc.compareVersions('3.4.10', '3.4.9') > 0 && uc.compareVersions('3.10.0', '3.9.9') > 0 && uc.compareVersions('10.0.0', '9.9.9') > 0);
const rel = (tag) => ({ tag_name: tag, name: `Jacarium ${tag.slice(1)}`, body: '', published_at: '2026-10-27T00:00:00Z', html_url: `https://example.test/${tag}`, assets: [], draft: false, prerelease: false });
const releases = uc.normalizeReleases([rel('v3.4.9'), rel('v3.4.10'), rel('v3.10.0'), rel('v10.0.0'), rel('v3.9.9')]);
check('normalizeReleases orders 10.0.0, 3.10.0, 3.9.9, 3.4.10, 3.4.9 (newest first, numerically)', releases.map((r) => r.version).join(',') === '10.0.0,3.10.0,3.9.9,3.4.10,3.4.9', releases.map((r) => r.version).join(','));
check('releasesNewerThan 3.4.9 includes 3.4.10 and the rest; newer than 10.0.0 nothing', uc.releasesNewerThan(releases, '3.4.9').map((r) => r.version).join(',') === '10.0.0,3.10.0,3.9.9,3.4.10' && uc.releasesNewerThan(releases, '10.0.0').length === 0);
check('shouldShowUpdate: 3.4.10 is an update for 3.4.9 and not for 3.4.10; a dismissed 3.4.10 stays quiet, a newer 3.4.11 shows again', uc.shouldShowUpdate({ latestVersion: '3.4.10', currentVersion: '3.4.9', dismissedVersion: null }) === true && uc.shouldShowUpdate({ latestVersion: '3.4.10', currentVersion: '3.4.10', dismissedVersion: null }) === false && uc.shouldShowUpdate({ latestVersion: '3.4.10', currentVersion: '3.4.9', dismissedVersion: '3.4.10' }) === false && uc.shouldShowUpdate({ latestVersion: '3.4.11', currentVersion: '3.4.9', dismissedVersion: '3.4.10' }) === true);

// ---- What's New ----
check("What's New compareVersions: 3.4.10 > 3.4.9 (the unseen marker), 3.10.0 > 3.9.9", categories.compareVersions('3.4.10', '3.4.9') > 0 && categories.compareVersions('3.10.0', '3.9.9') > 0 && categories.compareVersions('3.4.10', '3.4.10') === 0);
check('majorLinesOf lists 10 before 9 before 3', categories.majorLinesOf([{ version: '3.4.10' }, { version: '10.0.0' }, { version: '9.1.0' }, { version: '3.9.9' }]).join(',') === '10,9,3');
check('a What\'s New entry for 3.4.10 would be v3_4_10 / v3.4.10.js (valid identifier and file name)', /^[A-Za-z_]\w*$/.test('v' + '3.4.10'.replace(/\./g, '_')) && fs.readFileSync(path.join(REPO, 'scripts', 'whats-new-from-git.cjs'), 'utf8').includes("replace(/\\./g, '_')"));

// ---- publish-release.sh (static) ----
const pub = fs.readFileSync(path.join(REPO, 'scripts', 'publish-release.sh'), 'utf8');
check('publish-release.sh accepts --minor / --major, hands the bump to nextVersion and to the release command', /--minor\) BUMP=minor/.test(pub) && /--major\) BUMP=major/.test(pub) && /nextVersion\(process\.argv\[2\], process\.argv\[3\] \|\| null, process\.argv\[4\]\)/.test(pub) && /release_args\+=\("--\$BUMP"\)/.test(pub));
check('publish-release.sh refuses an exact version with --minor / --major, and --resume with them', /\[ -n "\$VERSION_ARG" \] && \[ "\$BUMP" != patch \]/.test(pub) && /\$RESUME_ARG && \[ "\$BUMP" != patch \]/.test(pub));
check('publish-release.sh accepts a multi-digit exact version (3.4.10, 3.10.0, 10.0.0 match its argument pattern)', ['3.4.10', '3.10.0', '10.0.0'].every((v) => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)) && /\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*\)/.test(pub));

// ---- the guards themselves ----
const consistency = fs.readFileSync(path.join(REPO, 'tests', 'app-version-consistency.test.mjs'), 'utf8');
check('the version-consistency guard accepts multi-digit parts', /\^\\d\+\\\.\\d\+\\\.\\d\+\$/.test(consistency) && !/\^\\d\\\.\\d\\\.\\d\$/.test(consistency));
const stale = ['docs/HOW_TO_RELEASE.md', 'src/whats-new/README.md', 'scripts/publish-release.sh', 'scripts/release.cjs'].filter((f) => /(every part|parts|digit|patch|minor) 0-9\b|rolls? over|rolling over|2\.9\.9 -> 3\.0\.0/.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
check('no release document still describes the 0-9 rollover', stale.length === 0, stale.join(', '));

console.log(`\n${failed ? `${failed} check(s) failed` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
