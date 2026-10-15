#!/usr/bin/env node
/**
 * Build a What's New entry from the git history.
 *
 *   node scripts/whats-new-from-git.cjs <from-ref> <version> [options]
 *
 * Takes every commit in <from-ref>..HEAD (newest first), one line per
 * commit subject, assigns each a CATEGORY (see below) and writes:
 *   - src/whats-new/versions/v<version>.js   (the window's entry: the
 *                                              release date and one feature
 *                                              per category, a `list` block
 *                                              with the subjects)
 *   - src/whats-new/versions/index.js        (import + versions[] entry at
 *                                              the top, like release.sh does)
 *   - src/whats-new/versions/changelog.json  (same groups, prepended; this
 *                                              feeds CHANGELOG.md through
 *                                              scripts/release.cjs)
 *
 * Categories, in the fixed order the window and CHANGELOG.md show them
 * (CATEGORIES; MISC last). A commit gets its category from, in this order:
 *   1. an explicit "[CATEGORY] " prefix on its subject (stripped from the
 *      shown line) or an entry in OVERRIDES (sha prefix or exact subject);
 *   2. the files it touched (PATH_RULES, the best-scoring category; a
 *      commit that touches only tests/ is TESTS, and tests/, README.md,
 *      the What's New data and the lock files never decide otherwise);
 *   3. keywords in its subject (KEYWORD_RULES);
 *   4. MISC.
 *
 * Merge commits are left out (git log --no-merges) and subjects matching
 * --skip are left out too; everything left out is REPORTED on stderr, never
 * dropped silently. The default --skip covers the version-bump / release /
 * baseline-snapshot commits that should not show in the UI.
 *
 * Options:
 *   --to <ref>          end of the range (default HEAD)
 *   --repo <dir>        git repository to read (default: this repo)
 *   --versions-dir <d>  where the three files live (default src/whats-new/versions)
 *   --skip <regex>      subjects to leave out (default: ^(Bump version\b|Release v?\d|Baseline snapshot\b), case-insensitive)
 *   --no-skip           keep every non-merge subject
 *   --force             overwrite an existing v<version>.js
 *   --dry-run           print what would be written, change nothing
 *
 * Nothing here tags, pushes or publishes.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SKIP = '^(Bump version\\b|Release v?\\d|Baseline snapshot\\b)';

// The fixed order of the groups (src/whats-new/categories.js carries the same
// list for the window; tests/whats-new-from-git.test.mjs keeps them equal).
const CATEGORIES = ['DOCUMENTS', 'TASKS', 'KANBAN', 'WORKFLOWS', 'CALENDAR', 'JIRA', 'AI', 'DIAGNOSTICS', 'TEAM', 'SYNC', 'SECURITY', 'SETTINGS', 'UI', 'DESKTOP', 'DEPLOY', 'TESTS', 'MISC'];

// Files that never decide a category on their own (they accompany a change).
const NOISE_FILES = /^(README\.md|LICENSE|CHANGELOG|docs\/|src\/whats-new\/|package\.json|package-lock\.json|\.gitignore|\.nvmrc|com\.jacarium\.app\.metainfo\.xml)/;
const TEST_FILES = /^tests\//;

// First matching rule per file; the category with the most files wins. A
// file no rule names (most of backend/ and src/) counts for nothing, so the
// subject's keywords decide such commits.
const PATH_RULES = [
  [/^deploy\/|^rebuild\.sh$|^scripts\/(deploy|rebuild|build-backend|build-ui|lib)\b|Containerfile|^backend\/build_backend\.sh$/, 'DEPLOY'],
  [/^jacarium-central\//, 'TEAM'],
  [/^src\/sync\/|^backend\/(sync_store|account_data)\.py$|^src\/utils\/homeServer|^electron\/home-server|^src\/hooks\/useSyncStatus|ConnectionIndicator|connectionState|^electron\/protocol|^protocol\.json$|version_and_downloads|^backend\/version/, 'SYNC'],
  [/^backend\/(accounts|auth|device_tokens|central_ticket|safe_url|user_context|sessions?|csrf|recovery)[^/]*\.py$|^electron\/(tls-trust|safe-url|safe-request|navigation-guard|env-file)\.cjs$|^src\/components\/auth\/|^src\/utils\/(auth|adminAccess|accountStorage)\.js$|^scripts\/privacy-scan|^backend\/ssh_(exec|interactive)\.py$|known_hosts|^electron\/profiles\.cjs$/, 'SECURITY'],
  [/^src\/components\/features\/documents\/|^src\/components\/(Documents|common\/modals\/documents|editor)|^src\/utils\/(documents|markdown|export|import|pdf|mermaid|codeHighlight|findInFiles)|^src\/hooks\/useYjsText|^electron\/pdf|^src\/components\/common\/FindInFiles/, 'DOCUMENTS'],
  [/taskwarrior|Taskwarrior|^src\/components\/Tasks|^src\/components\/features\/tasks\/|useYjsTasks|^backend\/task/, 'TASKS'],
  [/[Kk]anban|useYjsBoard|^src\/components\/features\/kanban\//, 'KANBAN'],
  [/^src\/components\/workflow\/|WorkflowBuilder|workflow_executor|workflowExecution|useWorkflowExecution|^src\/utils\/workflows|^src\/components\/features\/workflow/, 'WORKFLOWS'],
  [/[Cc]alendar|google_calendar/, 'CALENDAR'],
  [/[Jj]ira|JQL|jql/, 'JIRA'],
  [/ai_chat|AIChat|ai-providers|AIProviders|vector_db|embedd|^src\/components\/features\/ai\/|^src\/utils\/ai|rag_|^backend\/rag/, 'AI'],
  [/[Dd]iagnostics|reports_root|sosreport|must-gather|^backend\/(parsers|dashboard)|^backend\/templates\//, 'DIAGNOSTICS'],
  [/cloudWebSocket|cloudCentralSync|cloudSync|centralAvailability|CentralStatus|game-modes|[Qq]uiz|[Gg]ame|TeamChat|ChatSidebar|[Cc]ollab|presence|^src\/components\/features\/(chat|games|team)\//, 'TEAM'],
  [/^src\/components\/common\/modals\/settings\/|^src\/components\/common\/modals\/SettingsModal|settings_store|settings-store|settingsStore|^src\/utils\/openSettings|reserved_keys|^backend\/settings/, 'SETTINGS'],
  [/^electron\//, 'DESKTOP'],
  [/^src\/(components\/ui\/|index\.css|brand\/|components\/common\/(FloatingWindow|NoticeBanner|StatusCorner|DebugStatusBar|ToastNotifications|CompactSidebar)|components\/CompactSidebar|contexts\/ThemeContext|components\/WhatsNew)|tailwind|^public\/brand|^build\/icons|^index\.html$|^vite\.config/, 'UI'],
  [/^scripts\//, 'MISC'],
];

// Subject keywords, when the files decide nothing (or there are none).
const KEYWORD_RULES = [
  [/\bdocuments?\b|\beditor\b|\bmarkdown\b|\bpdf\b|\bmermaid\b|find in files/i, 'DOCUMENTS'],
  [/\btasks?\b|taskwarrior/i, 'TASKS'],
  [/\bkanban\b|\bboards?\b|\bcards?\b/i, 'KANBAN'],
  [/\bworkflows?\b|\bnodes?\b|\bssh node/i, 'WORKFLOWS'],
  [/\bcalendars?\b|google calendar/i, 'CALENDAR'],
  [/\bjira\b|\bjql\b/i, 'JIRA'],
  [/\bai\b|\bollama\b|\banthropic\b|\bgemini\b|\bopenai\b|\brag\b|\bembedding|\bmodels?\b|\bchat\b/i, 'AI'],
  [/\bdiagnostics?\b|sosreport|must-gather/i, 'DIAGNOSTICS'],
  [/\bcentral\b|\bteam\b|\bgames?\b|\bquiz\b|\bcollab|\bpresence\b|\bshare\b|\bmultiplayer\b|\bcloud sync\b|\bwebsocket\b/i, 'TEAM'],
  [/\bsync|home server|\blinked?\b|\bprofiles?\b|\bprotocol\b|\bversion check\b/i, 'SYNC'],
  [/\bsecur|\bcertificate|\btls\b|\bca\b|\bsign-?in\b|\bpassword|\btoken\b|\bauth|\bcsrf\b|cross-site|\bssrf\b|\badmin|\bprivacy|\bharden|\bpin|\baudit\b|\brecovery\b|\baccounts?\b|\bsession/i, 'SECURITY'],
  [/\bsettings?\b|\bdefaults?\b/i, 'SETTINGS'],
  [/\bdeploy|\bcontainer|\bimage\b|\bcaddy|\bpodman\b|\bdocker\b|\bhost\b|\bvolume\b|\bhttps\b/i, 'DEPLOY'],
  [/\bdesktop\b|\belectron\b|\binstaller|\bdmg\b|\bappimage\b|\bmenu\b|\bwindows?\b|\bmacos\b|\blinux\b|\bpackage/i, 'DESKTOP'],
  [/\btests?\b|\bspec\b/i, 'TESTS'],
  [/\btheme|\bfonts?\b|\bcolou?rs?\b|\bsidebar\b|\btabs?\b|\bicons?\b|\blayout\b|\bui\b|\bbrand|\bbutton|\bdialog|\bmodal|\bpage\b|\btooltip|\bwording|\btext\b|\bstyle|\bcorners?\b|\brounded\b|\bradius\b|\blook\b|\bprimitives?\b|\btokens?\b|\bplaceholders?\b|\bneutral\b|\bempty states?\b|\bheadings?\b|\bmenus?\b|\bstrips?\b|\bsquare\b|\bwindow\b|\bphone\b|\bmark\b/i, 'UI'],
];

// Deliberate choices that the rules would get wrong: sha prefix (7+) or the
// exact subject -> category.
const OVERRIDES = {
  'Rounded corners across the app': 'UI',
  'Menu items and fields: the shared look everywhere': 'UI',
  "Brand pages: sign-in hero, About, What's New and downloads headers, sidebar mark": 'UI',
  "Make What's New text only": 'UI',
  "Desktop pins the home server's CA root, not its renewing certificate": 'SECURITY',
  'Add a privacy scan for the source archive; strip icon metadata': 'SECURITY',
  'Connection-status callbacks read the { connected } they are given': 'TEAM',
  'Offline Mode wording matches what it blocks': 'SETTINGS',
  'Neutral wording in comments, tests and examples': 'MISC',
  'Import fixtures from the previous name': 'TESTS',
  'Diagnostics card radius is the token without !important': 'DIAGNOSTICS',
  "What's New is one list per major line, grouped by category": 'UI',
  'Backend integrations work whenever they are configured': 'SETTINGS',
  // hand-written entries of the 2.x line (their titles)
  'Offline Mode': 'SETTINGS',
  'AI Quiz': 'TEAM',
  'Sample Templates Added': 'DOCUMENTS',
  'Tooling Around': 'MISC',
  'Timer Tools Enhancement': 'MISC',
  'New Tools Added': 'MISC',
  'Make it your own!': 'UI',
  'Think Out of the Box': 'DESKTOP',
};

const CATEGORY_PREFIX = /^\[([A-Z]+)\]\s*/;

function parseArgs(argv) {
  const args = { from: null, version: null, to: 'HEAD', repo: path.resolve(__dirname, '..'), versionsDir: null, skip: DEFAULT_SKIP, force: false, dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') args.to = argv[++i];
    else if (a === '--repo') args.repo = path.resolve(argv[++i]);
    else if (a === '--versions-dir') args.versionsDir = path.resolve(argv[++i]);
    else if (a === '--skip') args.skip = argv[++i];
    else if (a === '--no-skip') args.skip = null;
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else rest.push(a);
  }
  [args.from, args.version] = rest;
  if (!args.from || !args.version) { usage(); process.exit(2); }
  if (!/^\d+\.\d+\.\d+$/.test(args.version)) { console.error(`Invalid version "${args.version}" - use X.Y.Z`); process.exit(2); }
  if (!args.versionsDir) args.versionsDir = path.join(args.repo, 'src', 'whats-new', 'versions');
  return args;
}

function usage() {
  console.error('Usage: node scripts/whats-new-from-git.cjs <from-ref> <version> [--to <ref>] [--repo <dir>] [--versions-dir <dir>] [--skip <regex>|--no-skip] [--force] [--dry-run]');
}

/** Commits in from..to, newest first: { sha, date, subject, isMerge, files }. */
function readCommits({ repo, from, to }) {
  const format = '%x1e%H%x1f%ad%x1f%P%x1f%s';
  const out = execFileSync('git', ['log', `--format=${format}`, '--date=short', '--name-only', `${from}..${to}`], { cwd: repo, encoding: 'utf8' });
  return out.split('\x1e').filter((r) => r.trim()).map((record) => {
    const lines = record.split('\n');
    const [sha, date, parents, subject] = lines[0].split('\x1f');
    const files = lines.slice(1).map((l) => l.trim()).filter(Boolean);
    return { sha, date, subject: (subject || '').trim(), isMerge: parents.trim().split(' ').length > 1, files };
  });
}

/** The explicit "[CATEGORY] " prefix of a subject, when it names a known category. */
function explicitCategory(subject) {
  const m = CATEGORY_PREFIX.exec(subject || '');
  if (m && CATEGORIES.includes(m[1])) return { category: m[1], subject: subject.slice(m[0].length).trim() };
  return null;
}

/** The category the touched files point at, or null when they decide nothing. */
function categorizeFiles(files) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return null;
  const deciding = list.filter((f) => !NOISE_FILES.test(f));
  if (!deciding.length) return null;
  if (deciding.every((f) => TEST_FILES.test(f))) return 'TESTS';
  const scores = new Map();
  for (const file of deciding) {
    if (TEST_FILES.test(file)) continue;
    const rule = PATH_RULES.find(([re]) => re.test(file));
    if (!rule) continue;
    scores.set(rule[1], (scores.get(rule[1]) || 0) + 1);
  }
  if (!scores.size) return null;
  let best = null;
  let total = 0;
  for (const category of CATEGORIES) {
    const score = scores.get(category) || 0;
    total += score;
    if (score > 0 && (best === null || score > scores.get(best))) best = category;
  }
  // An app-wide sweep (files in three or more areas, none of them a
  // majority) is not about the area with the most files: the subject decides.
  if (scores.size >= 3 && scores.get(best) / total < 0.5) return null;
  return best;
}

/** The category a subject's words point at, or null. */
function categorizeSubject(subject) {
  for (const [re, category] of KEYWORD_RULES) if (re.test(subject || '')) return category;
  return null;
}

/**
 * One commit -> { category, subject, how }. `how` says which rule decided
 * ('explicit' | 'override' | 'files' | 'keywords' | 'default').
 */
function categorizeCommit({ subject, files = [], sha = '' }, overrides = OVERRIDES) {
  const explicit = explicitCategory(subject);
  if (explicit) return { ...explicit, how: 'explicit' };
  const byOverride = Object.entries(overrides).find(([key, category]) => CATEGORIES.includes(category) && ((sha && key.length >= 7 && sha.startsWith(key)) || key === subject));
  if (byOverride) return { category: byOverride[1], subject, how: 'override' };
  const byFiles = categorizeFiles(files);
  if (byFiles) return { category: byFiles, subject, how: 'files' };
  const byWords = categorizeSubject(subject);
  if (byWords) return { category: byWords, subject, how: 'keywords' };
  return { category: 'MISC', subject, how: 'default' };
}

/** Group lines by category in the fixed order: [{ category, subjects }] (non-empty only). */
function groupByCategory(entries) {
  const groups = new Map();
  for (const e of entries) {
    const category = CATEGORIES.includes(e.category) ? e.category : 'MISC';
    if (!groups.has(category)) groups.set(category, { category, subjects: [] });
    groups.get(category).subjects.push(e.subject);
  }
  return CATEGORIES.filter((c) => groups.has(c)).map((c) => groups.get(c));
}

/**
 * Split into kept / left-out; the kept ones get a category and are grouped
 * by it (fixed order, newest first within a group). `date` is the newest
 * kept commit's date - the release date.
 */
function collect(commits, skipRegex, overrides = OVERRIDES) {
  const kept = [];
  const skipped = [];
  for (const c of commits) {
    if (c.isMerge) { skipped.push({ ...c, reason: 'merge commit' }); continue; }
    if (skipRegex && skipRegex.test(c.subject)) { skipped.push({ ...c, reason: `matches --skip ${skipRegex}` }); continue; }
    if (!c.subject) { skipped.push({ ...c, reason: 'empty subject' }); continue; }
    kept.push({ ...c, ...categorizeCommit(c, overrides) });
  }
  return { kept, skipped, groups: groupByCategory(kept), date: kept[0]?.date || null };
}

const jsString = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function renderVersionFile(version, groups, from, to, date = null) {
  const lines = [];
  lines.push(`// Generated by scripts/whats-new-from-git.cjs from ${from}..${to}: one line per`);
  lines.push('// commit subject, grouped by category (fixed order, MISC last). Regenerate with');
  lines.push(`//   node scripts/whats-new-from-git.cjs ${from} ${version} --force`);
  lines.push(`export const version = '${version}';`);
  lines.push(`export const date = ${date ? jsString(date) : 'null'};`);
  lines.push('');
  lines.push('export const features = [');
  groups.forEach((g, i) => {
    lines.push('  {');
    lines.push(`    id: ${i + 1},`);
    lines.push(`    category: ${jsString(g.category)},`);
    lines.push('    content: [');
    lines.push('      {');
    lines.push("        type: 'list',");
    lines.push('        items: [');
    for (const s of g.subjects) lines.push(`          ${jsString(s)},`);
    lines.push('        ]');
    lines.push('      }');
    lines.push('    ]');
    lines.push(`  }${i < groups.length - 1 ? ',' : ''}`);
  });
  lines.push('];');
  return lines.join('\n') + '\n';
}

/** Add the import and the versions[] entry at the top, the way release.sh does. */
function updateIndex(indexSrc, version) {
  const varName = `v${version.replace(/\./g, '_')}`;
  const importLine = `import * as ${varName} from './v${version}.js';`;
  if (indexSrc.includes(importLine)) return { src: indexSrc, changed: false };
  let src = indexSrc.replace(/^(import \* as v[\d_]+ from '\.\/v[\d.]+\.js';)/m, `${importLine}\n$1`);
  if (!src.includes(importLine)) throw new Error('versions/index.js: could not find the version imports to add to');
  const arrayStart = /^export const versions = \[\n/m;
  if (!arrayStart.test(src)) throw new Error('versions/index.js: could not find "export const versions = ["');
  src = src.replace(arrayStart, (m) => `${m}  ${varName},\n`);
  return { src, changed: true };
}

function updateChangelog(json, version, groups, date = null) {
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error('changelog.json is not an array');
  const entry = { version, date, features: groups.map((g) => ({ category: g.category, description: g.subjects.slice() })) };
  const existing = list.findIndex((e) => e.version === version);
  if (existing !== -1) list[existing] = entry; else list.unshift(entry);
  return JSON.stringify(list, null, 2) + '\n';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const skipRegex = args.skip ? new RegExp(args.skip, 'i') : null;
  const commits = readCommits(args);
  const { kept, skipped, groups, date } = collect(commits, skipRegex);

  const versionFile = path.join(args.versionsDir, `v${args.version}.js`);
  const indexFile = path.join(args.versionsDir, 'index.js');
  const changelogFile = path.join(args.versionsDir, 'changelog.json');
  if (fs.existsSync(versionFile) && !args.force && !args.dryRun) {
    console.error(`${versionFile} already exists - pass --force to overwrite`);
    process.exit(1);
  }

  const versionSrc = renderVersionFile(args.version, groups, args.from, args.to, date);
  const index = updateIndex(fs.readFileSync(indexFile, 'utf8'), args.version);
  const changelog = updateChangelog(fs.readFileSync(changelogFile, 'utf8'), args.version, groups, date);

  console.error(`${args.from}..${args.to}: ${commits.length} commits, ${kept.length} kept in ${groups.length} categories, ${skipped.length} left out`);
  for (const s of skipped) console.error(`  left out ${s.sha.slice(0, 7)} ${s.date} "${s.subject}" (${s.reason})`);
  for (const c of kept) console.error(`  ${c.category.padEnd(11)} ${c.sha.slice(0, 7)} "${c.subject}" (${c.how})`);
  const suspicious = kept.filter((c) => /^(wip|fixup!|squash!|tmp|test)\b|^Revert "/i.test(c.subject) || c.subject.length < 12);
  for (const c of suspicious) console.error(`  check    ${c.sha.slice(0, 7)} ${c.date} "${c.subject}" (kept - looks like it may not belong in a What's New)`);

  if (args.dryRun) {
    process.stdout.write(versionSrc);
    return;
  }
  fs.writeFileSync(versionFile, versionSrc);
  if (index.changed) fs.writeFileSync(indexFile, index.src);
  fs.writeFileSync(changelogFile, changelog);
  console.error(`wrote ${path.relative(args.repo, versionFile)}, ${index.changed ? 'updated' : 'kept'} index.js, updated changelog.json`);
}

if (require.main === module) main();

module.exports = { CATEGORIES, PATH_RULES, KEYWORD_RULES, OVERRIDES, readCommits, explicitCategory, categorizeFiles, categorizeSubject, categorizeCommit, groupByCategory, collect, renderVersionFile, updateIndex, updateChangelog, jsString, DEFAULT_SKIP };
