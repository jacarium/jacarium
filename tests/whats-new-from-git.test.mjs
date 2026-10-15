/**
 * Guards scripts/whats-new-from-git.cjs, the What's New entry generator
 * (used by scripts/release.cjs and by hand).
 *
 * Categorisation (unit, no repository):
 *   - the fixed category list equals src/whats-new/categories.js, MISC last;
 *   - path rules: src/sync/** -> SYNC, jacarium-central/** -> TEAM,
 *     deploy/** -> DEPLOY, a tests-only commit -> TESTS, README / lock files
 *     never decide, an app-wide sweep falls through to the subject;
 *   - an explicit "[CATEGORY] " prefix wins and is stripped; an OVERRIDES
 *     entry (sha prefix or exact subject) wins over the files;
 *   - subject keywords when the files decide nothing; MISC as the last resort;
 *   - groups come out in the fixed order, each line exactly once.
 *
 * On a THROWAWAY git repository built here (synthetic commits, never this
 * repo) it must:
 *   - list one line per commit subject in <from>..HEAD, grouped by category
 *     (fixed order; newest first within a group), as `list` blocks in
 *     versions/v<version>.js, with the release date (the newest commit's);
 *   - leave out merge commits and the bump/release/baseline subjects, and
 *     REPORT every one of them on stderr (nothing silently dropped), and
 *     flag "Revert ..." style subjects as worth a look;
 *   - add the version at the top of versions/index.js (import + array) and
 *     prepend the same groups to changelog.json; refuse to overwrite an
 *     existing entry without --force; write nothing with --dry-run;
 *   - escape quotes/backslashes in subjects so the generated module parses.
 *
 * Run:  node tests/whats-new-from-git.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SCRIPT = path.join(REPO, 'scripts', 'whats-new-from-git.cjs');
const gen = createRequire(import.meta.url)(SCRIPT);

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ' | ' + detail : ''}`);
}

// ---------- 0. categorisation rules ----------
console.log('\n--- 0. categorisation ---');
{
  const esm = fs.readFileSync(path.join(REPO, 'src', 'whats-new', 'categories.js'), 'utf8');
  const esmList = JSON.parse((/export const CATEGORIES = (\[[^\]]*\]);/.exec(esm) || [])[1].replace(/'/g, '"'));
  check('the script and src/whats-new/categories.js carry the same fixed category list, MISC last', JSON.stringify(gen.CATEGORIES) === JSON.stringify(esmList) && gen.CATEGORIES[gen.CATEGORIES.length - 1] === 'MISC' && gen.CATEGORIES.length >= 10, gen.CATEGORIES.join(','));
  const cat = (subject, files, sha = 'abcdef0123456789') => gen.categorizeCommit({ subject, files, sha });
  check('src/sync/** -> SYNC', cat('Something', ['src/sync/syncEngine.js', 'README.md']).category === 'SYNC');
  check('jacarium-central/** -> TEAM', cat('Something', ['jacarium-central/server.js']).category === 'TEAM');
  check('deploy/** -> DEPLOY', cat('Something', ['deploy/Containerfile', 'deploy/Caddyfile']).category === 'DEPLOY');
  check('backend accounts / tls trust -> SECURITY', cat('Something', ['backend/accounts.py']).category === 'SECURITY' && cat('Something', ['electron/tls-trust.cjs']).category === 'SECURITY');
  check('src/components/features/documents/** -> DOCUMENTS', cat('Something', ['src/components/features/documents/Editor.jsx']).category === 'DOCUMENTS');
  check('a tests-only commit -> TESTS (and its subject does not matter)', cat('Documents editor regression', ['tests/a.test.mjs', 'tests/helpers/b.mjs']).category === 'TESTS' && cat('x', ['tests/a.test.mjs']).how === 'files');
  check('tests alongside source do not count: the source decides', cat('Something', ['tests/sync.test.mjs', 'tests/other.test.mjs', 'src/sync/a.js']).category === 'SYNC');
  check('README / lock files / the What\'s New data never decide (files -> nothing, keywords decide)', gen.categorizeFiles(['README.md', 'package-lock.json', 'src/whats-new/versions/v1.js']) === null && cat('Document the deploy steps', ['README.md']).category === 'DOCUMENTS' && cat('Document the deploy steps', ['README.md']).how === 'keywords');
  check('the category with the most files wins', cat('Something', ['src/sync/a.js', 'src/sync/b.js', 'deploy/x']).category === 'SYNC');
  check('an app-wide sweep (3+ areas, no majority) falls through to the subject', gen.categorizeFiles(['src/sync/a.js', 'backend/jira_proxy.py', 'deploy/x', 'src/components/ui/p.jsx']) === null && cat('Rounded corners everywhere', ['src/sync/a.js', 'backend/jira_proxy.py', 'deploy/x', 'src/components/ui/p.jsx']).category === 'UI');
  const explicit = cat('[SECURITY] Tighten the thing', ['src/components/features/documents/Editor.jsx']);
  check('an explicit "[CATEGORY] " prefix wins over the files and is stripped from the line', explicit.category === 'SECURITY' && explicit.subject === 'Tighten the thing' && explicit.how === 'explicit');
  check('an unknown prefix is not a category (kept in the line)', cat('[WAT] Odd', ['src/sync/a.js']).category === 'SYNC' && cat('[WAT] Odd', ['src/sync/a.js']).subject === '[WAT] Odd');
  const overrides = { 'Exact subject here': 'KANBAN', 'deadbeef': 'JIRA' };
  check('an OVERRIDES entry by exact subject wins over the files', gen.categorizeCommit({ subject: 'Exact subject here', files: ['src/sync/a.js'], sha: 'abc' }, overrides).category === 'KANBAN' && gen.categorizeCommit({ subject: 'Exact subject here', files: [], sha: 'abc' }, overrides).how === 'override');
  check('...and by sha prefix (7+ characters)', gen.categorizeCommit({ subject: 'Whatever', files: ['src/sync/a.js'], sha: 'deadbeef0123' }, overrides).category === 'JIRA' && gen.categorizeCommit({ subject: 'Whatever', files: ['src/sync/a.js'], sha: 'dead0000' }, overrides).category === 'SYNC');
  check('keywords when the files decide nothing: calendar / jira / kanban / workflow', cat('Google Calendar is optional', []).category === 'CALENDAR' && cat('Jira proxy refuses a bad path', []).category === 'JIRA' && cat('Kanban cards keep their ids', []).category === 'KANBAN' && cat('Workflow REST nodes follow redirects', []).category === 'WORKFLOWS');
  check('...and the result says what decided', cat('Google Calendar is optional', []).how === 'keywords');
  check('nothing matches -> MISC (default)', cat('Bump shell-quote to 1.11.0', ['zzz.txt']).category === 'MISC' && cat('Bump shell-quote to 1.11.0', ['zzz.txt']).how === 'default');
  const groups = gen.groupByCategory([{ category: 'MISC', subject: 'm1' }, { category: 'SYNC', subject: 's1' }, { category: 'DOCUMENTS', subject: 'd1' }, { category: 'SYNC', subject: 's2' }, { category: 'NOPE', subject: 'n1' }]);
  check('groups come out in the fixed order, MISC last, an unknown category under MISC, each line once', groups.map((g) => `${g.category}:${g.subjects.join('+')}`).join(' ') === 'DOCUMENTS:d1 SYNC:s1+s2 MISC:m1+n1', JSON.stringify(groups));
}

// ---------- throwaway repository ----------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'whats-new-from-git-'));
const git = (...a) => execFileSync('git', a, { cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--repo', WORK], { cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
};
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'tests@example.test');
git('config', 'user.name', 'Synthetic Tester');
git('config', 'commit.gpgsign', 'false');
const VERSIONS = path.join(WORK, 'src', 'whats-new', 'versions');
fs.mkdirSync(VERSIONS, { recursive: true });
fs.writeFileSync(path.join(VERSIONS, 'v1.2.3.js'), "export const version = '1.2.3';\nexport const features = [];\n");
fs.writeFileSync(path.join(VERSIONS, 'index.js'), "import * as v1_2_3 from './v1.2.3.js';\n\nexport const versions = [\n  v1_2_3,\n];\n\nexport const latestVersion = versions[0].version;\n");
fs.writeFileSync(path.join(VERSIONS, 'changelog.json'), JSON.stringify([{ version: '1.2.3', features: [{ title: 'Old', description: ['Old line'] }] }], null, 2) + '\n');
let n = 0;
function commit(subject, date, file = null) {
  const target = path.join(WORK, file || `f${++n}.txt`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${subject}\n`);
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', subject], { cwd: WORK, env: { ...process.env, GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` } });
  return git('rev-parse', 'HEAD');
}
const base = commit('Baseline snapshot before the synthetic history', '2026-01-01');
commit('Add the alpha widget', '2026-01-02', 'src/sync/alpha.js');                                   // SYNC by path
commit('Fix the alpha widget\'s "quoted" label \\ backslash', '2026-01-02', 'src/sync/alpha.js');    // SYNC by path
commit('Release v1.2.3', '2026-01-02');
// a merge commit
git('checkout', '-q', '-b', 'topic');
commit('Topic work on beta', '2026-01-03', 'deploy/beta.sh');                                        // DEPLOY by path
git('checkout', '-q', 'main');
commit('Main work on gamma', '2026-01-03', 'tests/gamma.test.mjs');                                  // TESTS (tests only)
execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'Merge branch topic', 'topic'], { cwd: WORK, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-04T12:00:00Z', GIT_COMMITTER_DATE: '2026-01-04T12:00:00Z' } });
commit('Revert "Add the alpha widget"', '2026-01-05', 'src/sync/alpha.js');                          // SYNC by path
commit('Bump version to 1.2.4', '2026-01-05');
commit('[KANBAN] Polish the delta dialog', '2026-01-06');                                            // explicit prefix

// ---------- 1. dry run ----------
console.log('\n--- 1. dry run ---');
{
  const r = run([base, '1.3.0', '--dry-run']);
  check('dry run succeeds and prints the entry on stdout', r.ok && /export const version = '1\.3\.0'/.test(r.stdout), r.stderr.slice(0, 200));
  check('dry run writes nothing', !fs.existsSync(path.join(VERSIONS, 'v1.3.0.js')) && !fs.readFileSync(path.join(VERSIONS, 'index.js'), 'utf8').includes('v1_3_0'));
  check('the summary reports counts: 9 commits, 6 kept in 4 categories, 3 left out', /9 commits, 6 kept in 4 categories, 3 left out/.test(r.stderr), r.stderr.split('\n')[0]);
  check('every kept line is reported with its category and what decided it', /KANBAN\s+[0-9a-f]{7} "Polish the delta dialog" \(explicit\)/.test(r.stderr) && /SYNC\s+[0-9a-f]{7} "Add the alpha widget" \(files\)/.test(r.stderr) && /TESTS\s+[0-9a-f]{7} "Main work on gamma" \(files\)/.test(r.stderr), r.stderr);
  check('the merge commit is left out and REPORTED', /left out [0-9a-f]{7} 2026-01-04 "Merge branch topic" \(merge commit\)/.test(r.stderr));
  check('the Release and Bump commits are left out and reported with the --skip reason', /left out [0-9a-f]{7} 2026-01-02 "Release v1.2.3" \(matches --skip/.test(r.stderr) && /left out [0-9a-f]{7} 2026-01-05 "Bump version to 1.2.4" \(matches --skip/.test(r.stderr));
  check('the Revert commit is KEPT but flagged for a look', /check +[0-9a-f]{7} 2026-01-05 "Revert "Add the alpha widget"" \(kept/.test(r.stderr) && /Revert \\"Add the alpha widget\\"/.test(r.stdout) === false && /Revert "Add the alpha widget"/.test(r.stdout));
  check('the baseline commit itself is outside the range (exclusive <from>)', !/Baseline snapshot/.test(r.stdout));
}

// ---------- 2. real run ----------
console.log('\n--- 2. writing the entry ---');
{
  const r = run([base, '1.3.0']);
  check('the run succeeds', r.ok, r.stderr.slice(0, 300));
  const file = path.join(VERSIONS, 'v1.3.0.js');
  check('versions/v1.3.0.js is written', fs.existsSync(file));
  const mod = await import(`${file}?t=${Date.now()}`);
  check('the module parses and exports version, date (the newest commit\'s) and features', mod.version === '1.3.0' && mod.date === '2026-01-06' && Array.isArray(mod.features));
  check('one feature per category in the fixed order (KANBAN, TEAM? no: KANBAN, SYNC, DEPLOY, TESTS), ids 1..n, no titles', mod.features.map((f) => f.category).join(',') === 'KANBAN,SYNC,DEPLOY,TESTS' && mod.features.map((f) => f.id).join(',') === '1,2,3,4' && mod.features.every((f) => f.title === undefined), mod.features.map((f) => f.category).join(','));
  const byCat = Object.fromEntries(mod.features.map((f) => [f.category, f.content[0].items]));
  check('each category is a single `list` block, newest first within it, the explicit prefix stripped', mod.features.every((f) => f.content.length === 1 && f.content[0].type === 'list')
    && byCat.KANBAN.join('|') === 'Polish the delta dialog' && byCat.SYNC.join('|') === 'Revert "Add the alpha widget"|Fix the alpha widget\'s "quoted" label \\ backslash|Add the alpha widget' && byCat.DEPLOY.join('|') === 'Topic work on beta' && byCat.TESTS.join('|') === 'Main work on gamma', JSON.stringify(byCat));
  check('quotes and backslashes in subjects survive', byCat.SYNC[1] === 'Fix the alpha widget\'s "quoted" label \\ backslash');
  const index = fs.readFileSync(path.join(VERSIONS, 'index.js'), 'utf8');
  check('index.js gets the import and the array entry at the TOP', /^import \* as v1_3_0 from '\.\/v1\.3\.0\.js';\nimport \* as v1_2_3/m.test(index) && /export const versions = \[\n  v1_3_0,\n  v1_2_3,/.test(index), index);
  const changelog = JSON.parse(fs.readFileSync(path.join(VERSIONS, 'changelog.json'), 'utf8'));
  check('changelog.json gets the same groups prepended (version, date, features with category + description)', changelog[0].version === '1.3.0' && changelog[0].date === '2026-01-06' && changelog[1].version === '1.2.3' && changelog[0].features.map((f) => f.category).join(',') === 'KANBAN,SYNC,DEPLOY,TESTS' && changelog[0].features[1].description.join('|') === byCat.SYNC.join('|') && changelog[0].features.every((f) => f.title === undefined));
  const again = run([base, '1.3.0']);
  check('a second run refuses to overwrite without --force', !again.ok && /already exists - pass --force/.test(again.stderr));
  const forced = run([base, '1.3.0', '--force']);
  const index2 = fs.readFileSync(path.join(VERSIONS, 'index.js'), 'utf8');
  check('--force rewrites the entry and keeps index.js/changelog.json with a single 1.3.0', forced.ok && (index2.match(/v1_3_0/g) || []).length === 2 && JSON.parse(fs.readFileSync(path.join(VERSIONS, 'changelog.json'), 'utf8')).filter((e) => e.version === '1.3.0').length === 1);
  const bad = run([base, 'v1.3']);
  check('an invalid version is rejected', !bad.ok && /Invalid version/.test(bad.stderr));
  const noskip = run([base, '1.4.0', '--no-skip', '--dry-run']);
  check('--no-skip keeps the Release/Bump subjects (merges still left out)', noskip.ok && /Release v1\.2\.3/.test(noskip.stdout) && /Bump version to 1\.2\.4/.test(noskip.stdout) && !/Merge branch topic/.test(noskip.stdout));
}

// ---------- 3. this repository's data is in the categorised shape ----------
console.log('\n--- 3. the shipped entries ---');
{
  const dir = path.join(REPO, 'src', 'whats-new', 'versions');
  const files = fs.readdirSync(dir).filter((f) => /^v\d+\.\d+\.\d+\.js$/.test(f));
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/^export const date = ('\d{4}-\d{2}-\d{2}'|null);/m.test(src)) bad.push(`${f}: no date`);
    if (/title: '\d{4}-\d{2}-\d{2}'/.test(src)) bad.push(`${f}: still grouped by day`);
    for (const m of src.matchAll(/category: '([A-Z]+)'/g)) if (!gen.CATEGORIES.includes(m[1])) bad.push(`${f}: unknown category ${m[1]}`);
    if (!/category: '/.test(src) && /features = \[\s*\{/.test(src)) bad.push(`${f}: features without a category`);
  }
  check(`every shipped entry (${files.length}) has a release date and category groups from the fixed list, none grouped by day`, bad.length === 0, bad.join('; '));
  const changelog = JSON.parse(fs.readFileSync(path.join(dir, 'changelog.json'), 'utf8'));
  check('changelog.json carries the same shape (date + category per feature)', changelog.every((e) => 'date' in e && e.features.every((f) => gen.CATEGORIES.includes(f.category) && Array.isArray(f.description))));
  const changelogMd = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');
  const first = changelogMd.slice(changelogMd.indexOf("## What's New in v"), changelogMd.indexOf("## What's New in v", changelogMd.indexOf("## What's New in v") + 10));
  check('CHANGELOG.md\'s newest What\'s New section is grouped by [CATEGORY] with its date', /_\d{4}-\d{2}-\d{2}_/.test(first) && /### \[[A-Z]+\]/.test(first) && !/### \d{4}-\d{2}-\d{2}/.test(first), first.slice(0, 160));
}

check('this repository was not touched (no tag, versions dir untouched)', execFileSync('git', ['-C', REPO, 'tag', '-l', 'v1.3.0'], { encoding: 'utf8' }).trim() === '' && !fs.existsSync(path.join(REPO, 'src', 'whats-new', 'versions', 'v1.3.0.js')));

fs.rmSync(WORK, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('Failed:'); for (const f of failed) console.log(`  - ${f.name}`); }
process.exit(failed.length ? 1 : 0);
