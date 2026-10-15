#!/usr/bin/env node
/**
 * Local, offline release. Nothing here pushes, publishes or talks to a
 * remote - the repository has none.
 *
 *   npm run release                 prepare the next version: step by one,
 *                                   each digit 0-9 rolling over
 *                                   (2.6.0 -> 2.6.1 ... 2.6.9 -> 2.7.0 ... 2.9.9 -> 3.0.0)
 *   npm run release -- 2.7.0        prepare that exact version (must be greater
 *                                   than the current one, parts 0-9)
 *   npm run release -- --dry-run    show what would change, write nothing
 *   npm run release:tag             commit the prepared release and create
 *                                   the local annotated tag vX.Y.Z
 *   ... --trailer "Key: value"      append a trailer line (e.g. a
 *                                   Co-Authored-By) to the release commit
 *
 * "prepare" does, in this order:
 *   1. finds the previous release: tag v<current version> when it exists,
 *      otherwise the commit that last set <current version> in package.json;
 *   2. writes the What's New entry from `git log <previous>..HEAD` (one line
 *      per commit subject, grouped by category - see whats-new-from-git.cjs;
 *      merges and bump/release commits are left out and listed) into
 *      src/whats-new/versions/v<new>.js, and adds it to versions/index.js and
 *      changelog.json;
 *   3. bumps the version in package.json and package-lock.json;
 *   4. regenerates CHANGELOG.md from changelog.json (one section per
 *      version, newest first; the README itself is the project's pitch and
 *      carries no release notes);
 *   5. prints a summary and offers to run the "tag" step straight away.
 *
 * Review/edit src/whats-new/versions/v<new>.js before tagging if you want to
 * tidy the notes - "tag" only commits what is in the working tree.
 *
 * Testing hook: --repo <dir> runs against another checkout (the tests use a
 * throwaway repository); --yes skips the prompts.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');
const whatsNew = require('./whats-new-from-git.cjs');

function usage() {
  console.error('Usage: node scripts/release.cjs [<X.Y.Z>] [--dry-run] [--yes] [--trailer <line>] [--repo <dir>]');
  console.error('       node scripts/release.cjs tag [--yes] [--trailer <line>] [--repo <dir>] [--skip-privacy-scan]');
}

function parseArgs(argv) {
  const args = { command: 'prepare', target: null, dryRun: false, yes: false, trailers: [], repo: path.resolve(__dirname, '..'), skipPrivacyScan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'tag') args.command = 'tag';
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-privacy-scan') args.skipPrivacyScan = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--repo') args.repo = path.resolve(argv[++i]);
    else if (a === '--trailer') args.trailers.push(argv[++i]);
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (/^\d+\.\d+\.\d+$/.test(a)) args.target = a;
    else { console.error(`Unknown argument: ${a}`); usage(); process.exit(2); }
  }
  return args;
}

const git = (repo, ...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/**
 * The next version. Without an explicit target: step by one, every digit
 * 0-9 and rolling over into the next one (2.6.9 -> 2.7.0, 2.9.9 -> 3.0.0).
 * An explicit X.Y.Z must be greater than the current version and keep every
 * part in 0-9.
 */
function nextVersion(current, target) {
  if (target) {
    if (!/^\d+\.\d+\.\d+$/.test(target)) throw new Error(`Invalid version "${target}" - use X.Y.Z`);
    if (target.split('.').some((p) => Number(p) > 9)) throw new Error(`Version ${target}: every part must be 0-9 (versions step 2.6.9 -> 2.7.0 -> ... -> 2.9.9 -> 3.0.0)`);
    if (compareVersions(target, current) <= 0) throw new Error(`New version ${target} is not greater than the current ${current}`);
    return target;
  }
  let [major, minor, patch] = current.split('.').map(Number);
  patch += 1;
  if (patch > 9) { patch = 0; minor += 1; }
  if (minor > 9) { minor = 0; major += 1; }
  return `${major}.${minor}.${patch}`;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Where the previous release is: its tag when there is one, otherwise the
 * commit that last set the current version in package.json (the first
 * release of this offline flow has no tag yet).
 */
function findPreviousRelease(repo, currentVersion) {
  const tag = `v${currentVersion}`;
  if (git(repo, 'tag', '-l', tag) === tag) return { ref: tag, how: 'tag' };
  const sha = git(repo, 'log', '-1', '--format=%H', `-S"version": "${currentVersion}"`, '--', 'package.json');
  if (sha) return { ref: sha, how: `commit that set ${currentVersion} in package.json` };
  throw new Error(`Cannot find where version ${currentVersion} started: no tag ${tag} and no package.json commit with it`);
}

/**
 * CHANGELOG.md: regenerate the What's New sections from changelog.json - one
 * section per version (its date under the heading), the changes grouped by
 * category ("### [CATEGORY]"; a hand-written entry keeps its own title after
 * the tag). The header above the first What's New (the title and the
 * introduction) is kept. A "<" in the notes is written as "&lt;": a
 * commit subject naming a tag ("Close unclosed <script> tag") would
 * otherwise open raw HTML and swallow the rest of the file when rendered.
 */
const escapeMarkdownHtml = (text) => String(text).replace(/</g, '&lt;');

function renderChangelog(changelog, existing) {
  const firstNotes = existing.search(/^## What's New in v/m);
  const header = firstNotes > 0 ? existing.slice(0, firstNotes) : '# Changelog\n\n';
  let out = header.endsWith('\n\n') ? header : header.replace(/\n*$/, '\n\n');
  for (const { version, date, features } of changelog) {
    out += `## What's New in v${version}\n\n`;
    if (date) out += `_${date}_\n\n`;
    for (const feature of features) {
      const tag = feature.category ? `[${feature.category}]` : '';
      const heading = escapeMarkdownHtml([tag, feature.title].filter(Boolean).join(' '));
      out += `### ${heading}\n\n`;
      for (const line of feature.description) out += `${escapeMarkdownHtml(line)}\n\n`;
    }
    out += '\n';
  }
  return out.replace(/\n+$/, '\n');
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

async function prepare(args) {
  const { repo } = args;
  const pkgFile = path.join(repo, 'package.json');
  const lockFile = path.join(repo, 'package-lock.json');
  const changelogFile = path.join(repo, 'CHANGELOG.md');
  const versionsDir = path.join(repo, 'src', 'whats-new', 'versions');
  const pkg = readJson(pkgFile);
  const current = pkg.version;
  const version = nextVersion(current, args.target);
  if (fs.existsSync(path.join(versionsDir, `v${version}.js`))) throw new Error(`src/whats-new/versions/v${version}.js already exists - is ${version} already prepared? (npm run release:tag finishes it)`);
  if (git(repo, 'tag', '-l', `v${version}`)) throw new Error(`Tag v${version} already exists`);

  const dirty = git(repo, 'status', '--porcelain');
  if (dirty && !args.dryRun) throw new Error(`The working tree has uncommitted changes - commit or stash them first:\n${dirty}`);

  const previous = findPreviousRelease(repo, current);
  const commits = whatsNew.readCommits({ repo, from: previous.ref, to: 'HEAD' });
  const { kept, skipped, groups, date } = whatsNew.collect(commits, new RegExp(whatsNew.DEFAULT_SKIP, 'i'));
  if (kept.length === 0) throw new Error(`No commits since ${previous.ref} (${previous.how}) - nothing to release`);

  const versionSrc = whatsNew.renderVersionFile(version, groups, previous.ref.slice(0, previous.how === 'tag' ? undefined : 7), 'HEAD', date);
  const index = whatsNew.updateIndex(fs.readFileSync(path.join(versionsDir, 'index.js'), 'utf8'), version);
  const changelogJson = whatsNew.updateChangelog(fs.readFileSync(path.join(versionsDir, 'changelog.json'), 'utf8'), version, groups, date);
  const changelogMd = renderChangelog(JSON.parse(changelogJson), fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, 'utf8') : '');

  const log = (m) => console.error(m);
  log(`Release ${current} -> ${version}${args.dryRun ? ' (dry run, nothing written)' : ''}`);
  log(`  notes from ${previous.ref.slice(0, 12)}..HEAD (${previous.how}): ${commits.length} commits, ${kept.length} kept in ${groups.length} categories`);
  for (const s of skipped) log(`  left out ${s.sha.slice(0, 7)} ${s.date} "${s.subject}" (${s.reason})`);
  for (const c of kept) log(`  ${c.category.padEnd(11)} ${c.sha.slice(0, 7)} "${c.subject}" (${c.how})`);
  const suspicious = kept.filter((c) => /^(wip|fixup!|squash!|tmp|test)\b|^Revert "/i.test(c.subject) || c.subject.length < 12);
  for (const c of suspicious) log(`  check    ${c.sha.slice(0, 7)} ${c.date} "${c.subject}" (kept - may not belong in a What's New)`);
  log('  files: package.json, package-lock.json, CHANGELOG.md, src/whats-new/versions/{v' + version + '.js, index.js, changelog.json}');

  if (args.dryRun) {
    process.stdout.write(versionSrc);
    return { version, written: false };
  }

  fs.writeFileSync(path.join(versionsDir, `v${version}.js`), versionSrc);
  if (index.changed) fs.writeFileSync(path.join(versionsDir, 'index.js'), index.src);
  fs.writeFileSync(path.join(versionsDir, 'changelog.json'), changelogJson);
  pkg.version = version;
  writeJson(pkgFile, pkg);
  if (fs.existsSync(lockFile)) {
    const lock = readJson(lockFile);
    lock.version = version;
    if (lock.packages && lock.packages['']) lock.packages[''].version = version;
    writeJson(lockFile, lock);
  }
  fs.writeFileSync(changelogFile, changelogMd);
  updateMetainfo(repo, version);
  log(`Prepared ${version}. Review src/whats-new/versions/v${version}.js (edit freely), then finish with: npm run release:tag`);

  const answer = args.yes ? 'y' : await ask(`Commit and create the local tag v${version} now? [y/N] `);
  if (answer === 'y' || answer === 'yes') return tag({ ...args, yes: true });
  return { version, written: true, tagged: false };
}

/**
 * The AppStream metadata's <release> entry (Linux desktop files) follows the
 * version; tests/app-version-consistency.test.mjs checks they agree.
 */
function updateMetainfo(repo, version) {
  const file = path.join(repo, 'com.jacarium.app.metainfo.xml');
  if (!fs.existsSync(file)) return false;
  const date = new Date().toISOString().slice(0, 10);
  const src = fs.readFileSync(file, 'utf8');
  const out = src.replace(/<release version="[^"]*" date="[^"]*">/, `<release version="${version}" date="${date}">`);
  if (out !== src) fs.writeFileSync(file, out);
  return out !== src;
}

/**
 * Before anything is tagged (the tag is what `git archive` publishes as the
 * source tarball): scripts/privacy-scan.sh over the tracked files. A finding
 * stops the release; --skip-privacy-scan bypasses it deliberately. A repo
 * without the script (the tests' throwaway repositories) is not scanned.
 */
function privacyScan(repo) {
  const script = path.join(repo, 'scripts', 'privacy-scan.sh');
  if (!fs.existsSync(script)) return;
  console.error('Privacy scan of the tracked files (scripts/privacy-scan.sh)...');
  const r = spawnSync('bash', [script, '--tracked'], { cwd: repo, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('the privacy scan found something - fix it before tagging (or pass --skip-privacy-scan on purpose)');
}

async function tag(args) {
  const { repo } = args;
  const version = readJson(path.join(repo, 'package.json')).version;
  const tagName = `v${version}`;
  if (!fs.existsSync(path.join(repo, 'src', 'whats-new', 'versions', `v${version}.js`))) throw new Error(`src/whats-new/versions/v${version}.js is missing - run "npm run release" first`);
  if (git(repo, 'tag', '-l', tagName)) throw new Error(`Tag ${tagName} already exists`);
  const status = git(repo, 'status', '--porcelain');
  if (!status) throw new Error('Nothing to commit - the release looks committed already; create the tag by hand if it is missing: git tag -a ' + tagName);
  console.error(`Will commit these changes as "Release ${tagName}" and tag ${tagName} (local only):\n${status}`);
  const answer = args.yes ? 'y' : await ask('Proceed? [y/N] ');
  if (answer !== 'y' && answer !== 'yes') { console.error('Not committed.'); return { version, tagged: false }; }
  if (!args.skipPrivacyScan) privacyScan(repo);
  git(repo, 'add', '-A');
  const trailers = (args.trailers || []).filter(Boolean);
  const message = trailers.length ? `Release ${tagName}\n\n${trailers.join('\n')}` : `Release ${tagName}`;
  git(repo, 'commit', '-m', message);
  git(repo, 'tag', '-a', tagName, '-m', `Release ${version}`);
  console.error(`Committed and tagged ${tagName} (no remote, nothing pushed).`);
  return { version, tagged: true };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  (args.command === 'tag' ? tag(args) : prepare(args)).catch((err) => {
    console.error(`release: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { nextVersion, compareVersions, findPreviousRelease, renderChangelog, updateMetainfo, prepare, tag };
