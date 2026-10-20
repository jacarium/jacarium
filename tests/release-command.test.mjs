/**
 * Guards scripts/release.cjs - the offline release command
 * (`npm run release` / `npm run release:tag`).
 *
 * On a THROWAWAY git repository built here (synthetic package.json, lock,
 * README, CHANGELOG.md, versions/ and commits; never this repo) it must:
 *   - pick the next version by stepping one with every digit 0-9 and rolling
 *     over (2.6.0 -> 2.6.1, x.y.9 -> x.(y+1).0, x.9.9 -> (x+1).0.0), take an
 *     explicit version instead, and refuse one that is not greater than the
 *     current version or has a part above 9;
 *   - find the previous release at tag v<current> when it exists, else at
 *     the commit that set the current version in package.json;
 *   - with --dry-run print the summary and entry and write nothing;
 *   - refuse to run on a dirty tree, and refuse an already-prepared version;
 *   - prepare: bump package.json + package-lock.json (root and packages[""]),
 *     write versions/v<new>.js, index.js, changelog.json and regenerate the
 *     CHANGELOG.md (its header kept, the README untouched);
 *   - "tag" (after explicit confirmation / --yes): commit "Release vX.Y.Z"
 *     and create the LOCAL annotated tag vX.Y.Z - in the throwaway repo
 *     only; this repository gains no commit and no tag;
 *   - a second release then uses the tag as the previous release.
 *
 * Run:  node tests/release-command.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SCRIPT = path.join(REPO, 'scripts', 'release.cjs');
const req = createRequire(import.meta.url);
const { nextVersion, renderChangelog } = req(SCRIPT);


const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ' | ' + detail : ''}`);
}

// a note naming an HTML tag must not open raw HTML in CHANGELOG.md (it swallowed the rest of the file)
{
  const md = renderChangelog([{ version: '1.0.0', date: '2026-01-01', features: [{ category: 'UI', title: 'A <b> title', description: ['Close unclosed <script> tag'] }] }], '');
  check('renderChangelog writes "<" as "&lt;" in notes and titles', md.includes('Close unclosed &lt;script> tag') && md.includes('A &lt;b> title') && !md.includes('<script>') && !md.includes('<b>'), md);
}

// ---------- 1. the version rule (pure) ----------
console.log('\n--- 1. nextVersion ---');
{
  const threw = (c, t) => { try { nextVersion(c, t); return null; } catch (e) { return e.message; } };
  check('default steps the patch digit: 2.6.0 -> 2.6.1', nextVersion('2.6.0', null) === '2.6.1');
  check('x.y.9 rolls into the minor: 2.6.9 -> 2.7.0', nextVersion('2.6.9', null) === '2.7.0');
  check('x.9.9 rolls into the major: 2.9.9 -> 3.0.0', nextVersion('2.9.9', null) === '3.0.0');
  check('an explicit greater version wins: 2.5.5 + 2.6.0 -> 2.6.0', nextVersion('2.5.5', '2.6.0') === '2.6.0');
  check('an explicit version equal to the current one is rejected', /not greater/.test(threw('2.5.5', '2.5.5') || ''));
  check('an explicit lower version is rejected', /not greater/.test(threw('2.5.5', '2.4.9') || ''));
  check('an explicit version with a part above 9 is rejected', /every part must be 0-9/.test(threw('2.5.5', '2.5.10') || ''));
  check('a malformed version is rejected', /Invalid version/.test(threw('2.5.5', '2.6') || ''));
}

// ---------- throwaway repository ----------
const HOME_TAGS_BEFORE = execFileSync('git', ['-C', REPO, 'tag', '-l'], { encoding: 'utf8' });
const HOME_HEAD_BEFORE = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'release-command-'));
const git = (...a) => execFileSync('git', a, { cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--repo', WORK], { cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
};
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(WORK, f), 'utf8'));
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'tests@example.test');
git('config', 'user.name', 'Synthetic Tester');
git('config', 'commit.gpgsign', 'false');
const VERSIONS = path.join(WORK, 'src', 'whats-new', 'versions');
fs.mkdirSync(VERSIONS, { recursive: true });
function writePackage(version) {
  fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify({ name: 'synthetic-app', version, scripts: { release: 'node scripts/release.cjs' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(WORK, 'package-lock.json'), JSON.stringify({ name: 'synthetic-app', version, lockfileVersion: 3, packages: { '': { name: 'synthetic-app', version }, 'node_modules/left-pad': { version: '1.3.0' } } }, null, 2) + '\n');
}
writePackage('2.5.9');
fs.writeFileSync(path.join(VERSIONS, 'v2.5.9.js'), "export const version = '2.5.9';\nexport const features = [{ id: 1, title: 'Old', content: [{ type: 'text', value: 'Old line' }] }];\n");
fs.writeFileSync(path.join(VERSIONS, 'index.js'), "import * as v2_5_9 from './v2.5.9.js';\n\nexport const versions = [\n  v2_5_9,\n];\n\nexport const latestVersion = versions[0].version;\n");
fs.writeFileSync(path.join(VERSIONS, 'changelog.json'), JSON.stringify([{ version: '2.5.9', features: [{ title: 'Old', description: ['Old line'] }] }], null, 2) + '\n');
fs.writeFileSync(path.join(WORK, 'CHANGELOG.md'), "# Changelog\n\nIntro stays.\n\n## What's New in v2.5.9\n\n### Old\n\nOld line\n");
fs.writeFileSync(path.join(WORK, 'README.md'), "# Jacarium\n\nThe pitch stays as it is.\n");
// the COPR spec: its fallback version and %changelog follow the release
fs.mkdirSync(path.join(WORK, 'packaging', 'copr'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'packaging', 'copr', 'jacarium.spec'), "%{!?jacarium_version: %global jacarium_version 2.5.9}\nName: jacarium\nVersion: %{jacarium_version}\n\n%changelog\n* Mon Feb 02 2026 Robin Cernin - 2.5.9-1\n- Old\n");
let n = 0;
function commit(subject, date) {
  fs.writeFileSync(path.join(WORK, `f${++n}.txt`), `${subject}\n`);
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', subject], { cwd: WORK, env: { ...process.env, GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` } });
  return git('rev-parse', 'HEAD');
}
commit('Baseline snapshot of the synthetic app at 2.5.9', '2026-02-01');
commit('Add the alpha widget', '2026-02-02');
commit('Fix the beta dialog', '2026-02-03');

// ---------- 2. dry run (no tag yet: previous release = the package.json commit) ----------
console.log('\n--- 2. dry run without a tag ---');
{
  const r = run(['--dry-run']);
  check('dry run succeeds', r.ok, r.stderr.slice(0, 300));
  check('the default next version is 2.6.0 (2.5.9 rolls the patch into the minor)', /Release 2\.5\.9 -> 2\.6\.0 \(dry run/.test(r.stderr), r.stderr.split('\n')[0]);
  check('the previous release is the commit that set 2.5.9 in package.json (the baseline commit), so only the 2 later commits are listed', /\(commit that set 2\.5\.9 in package\.json\): 2 commits, 2 kept in \d+ categor/.test(r.stderr), r.stderr.split('\n')[1]);
  check('the baseline commit itself is outside the range (not listed, like 1d2a75b in this repo)', !/Baseline snapshot/.test(r.stdout) && !/Baseline snapshot/.test(r.stderr));
  check('the entry is printed, nothing written, package.json untouched', /export const version = '2\.6\.0'/.test(r.stdout) && !fs.existsSync(path.join(VERSIONS, 'v2.6.0.js')) && readJson('package.json').version === '2.5.9');
  fs.writeFileSync(path.join(WORK, 'dirty.txt'), 'x');
  const dirty = run(['--yes']);
  check('a dirty working tree is refused (nothing written)', !dirty.ok && /uncommitted changes/.test(dirty.stderr) && readJson('package.json').version === '2.5.9', dirty.stderr.split('\n')[0]);
  fs.rmSync(path.join(WORK, 'dirty.txt'));
}

// ---------- 3. prepare with an explicit version, then tag ----------
console.log('\n--- 3. prepare 2.7.0 explicitly, then tag ---');
{
  const r = run(['2.7.0', '--yes']); // --yes also answers the "tag now?" prompt
  check('prepare + tag succeeds', r.ok, r.stderr.slice(0, 400));
  check('package.json and both lock root entries are bumped, other lock entries untouched', readJson('package.json').version === '2.7.0' && readJson('package-lock.json').version === '2.7.0' && readJson('package-lock.json').packages[''].version === '2.7.0' && readJson('package-lock.json').packages['node_modules/left-pad'].version === '1.3.0');
  check('versions/v2.7.0.js, index.js and changelog.json are updated', fs.existsSync(path.join(VERSIONS, 'v2.7.0.js')) && /v2_7_0,\n  v2_5_9/.test(fs.readFileSync(path.join(VERSIONS, 'index.js'), 'utf8')) && readJson('src/whats-new/versions/changelog.json')[0].version === '2.7.0');
  const changelogMd = fs.readFileSync(path.join(WORK, 'CHANGELOG.md'), 'utf8');
  check('CHANGELOG.md gets the 2.7.0 section first (its date, the changes under [CATEGORY] headings), keeps its header and 2.5.9', /^# Changelog\n\nIntro stays\.\n\n## What's New in v2\.7\.0\n\n_2026-02-03_\n\n### \[[A-Z]+\]\n\n/.test(changelogMd) && /### \[UI\]\n\n(Fix the beta dialog|Add the alpha widget)\n/.test(changelogMd) && /Fix the beta dialog\n/.test(changelogMd) && /Add the alpha widget\n/.test(changelogMd) && /## What's New in v2\.5\.9/.test(changelogMd), changelogMd.slice(0, 200));
  check('README.md is not touched by a release', fs.readFileSync(path.join(WORK, 'README.md'), 'utf8') === "# Jacarium\n\nThe pitch stays as it is.\n");
  const spec = fs.readFileSync(path.join(WORK, 'packaging', 'copr', 'jacarium.spec'), 'utf8');
  check('packaging/copr/jacarium.spec: the fallback version is 2.7.0 and %changelog starts with a 2.7.0-1 entry (rpm date format), the old entry kept', /^%\{!\?jacarium_version: %global jacarium_version 2\.7\.0\}$/m.test(spec) && /^%changelog\n\* (Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} \d{2} \d{4} Robin Cernin - 2\.7\.0-1\n- Jacarium 2\.7\.0 [^\n]*\n\n\* Mon Feb 02 2026 Robin Cernin - 2\.5\.9-1\n- Old\n$/m.test(spec), spec.split('%changelog')[1].slice(0, 80));
  const entry270 = fs.readFileSync(path.join(VERSIONS, 'v2.7.0.js'), 'utf8');
  check('the generated entry carries the release date and category groups', /export const date = '2026-02-03';/.test(entry270) && /category: '[A-Z]+'/.test(entry270) && !/title: '2026/.test(entry270) && readJson('src/whats-new/versions/changelog.json')[0].date === '2026-02-03' && readJson('src/whats-new/versions/changelog.json')[0].features.every((f) => typeof f.category === 'string'));
  check('the throwaway repo got the commit "Release v2.7.0" and the annotated tag v2.7.0', git('log', '-1', '--format=%s') === 'Release v2.7.0' && git('tag', '-l', 'v2.7.0') === 'v2.7.0' && git('cat-file', '-t', 'v2.7.0') === 'tag' && git('status', '--porcelain') === '');
  const again = run(['2.7.0', '--dry-run']);
  check('preparing 2.7.0 again is refused', !again.ok && /not greater|already exists/.test(again.stderr), again.stderr.split('\n')[0]);
  const low = run(['2.6.5', '--dry-run']);
  check('a version below the current one is refused', !low.ok && /not greater/.test(low.stderr));
  const tagAgain = run(['tag', '--yes']);
  check('"tag" with nothing to commit is refused', !tagAgain.ok && /Nothing to commit|already exists/.test(tagAgain.stderr), tagAgain.stderr.split('\n')[0]);
}

// ---------- 4. the next release uses the tag ----------
console.log('\n--- 4. next release starts at the tag ---');
{
  commit('Polish the gamma panel', '2026-02-10');
  const r = run(['--dry-run']);
  check('default next version steps to 2.7.1', /Release 2\.7\.0 -> 2\.7\.1/.test(r.stderr), r.stderr.split('\n')[0]);
  check('the previous release is now the tag v2.7.0 and only the new commit is listed', /from v2\.7\.0\.\.HEAD \(tag\): 1 commits, 1 kept/.test(r.stderr) && /Polish the gamma panel/.test(r.stdout) && !/Fix the beta dialog/.test(r.stdout), r.stderr.split('\n')[1]);
  const prep = run(['--yes', '--trailer', 'Reviewed-by: Synthetic Tester <tests@example.test>']);
  check('a tagged prepare of 2.7.1 succeeds and tags v2.7.1', prep.ok && git('tag', '-l', 'v2.7.1') === 'v2.7.1' && readJson('package.json').version === '2.7.1', prep.stderr.slice(0, 200));
  check('--trailer appends a trailer line to the release commit (subject stays "Release v2.7.1")', git('log', '-1', '--format=%s') === 'Release v2.7.1' && git('log', '-1', '--format=%b').trim() === 'Reviewed-by: Synthetic Tester <tests@example.test>', git('log', '-1', '--format=%B'));
  check('the tag message is unchanged ("Release 2.7.1")', /Release 2\.7\.1$/.test(git('tag', '-l', '-n1', 'v2.7.1')), git('tag', '-l', '-n1', 'v2.7.1'));
}

check('THIS repository gained no tag and no commit', execFileSync('git', ['-C', REPO, 'tag', '-l'], { encoding: 'utf8' }) === HOME_TAGS_BEFORE && execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === HOME_HEAD_BEFORE);

fs.rmSync(WORK, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('Failed:'); for (const f of failed) console.log(`  - ${f.name}`); }
process.exit(failed.length ? 1 : 0);
