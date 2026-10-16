/**
 * Guards the repository's shell scripts after the cleanup that left one entry
 * point per task (run.sh, rebuild.sh, start-backend.sh, scripts/build-ui.sh,
 * deploy/*.sh, jacarium-central/*.sh) sharing scripts/lib.sh.
 *
 * What this test proves (plain Node, the real scripts, no build is run):
 *   - the superseded scripts are gone (run1.sh / run2.sh / rebuild-test.sh /
 *     ollama.sh / backend/start.sh / scripts/build-production.sh,
 *     build-testing.sh, set-build-mode.sh / scripts/test-socket-auth.mjs) and
 *     nothing tracked still refers to them (old What's New text excepted);
 *   - every package.json script that names a file names one that exists, and
 *     the removed npm entries (dev:multi, dev:testing, build:testing,
 *     electron:build:testing, electron:build:full:testing) stay removed;
 *   - every tracked .sh starts with a bash shebang and `set -euo pipefail`
 *     (the deploy scripts and the privacy scan, which report and continue, use `set -uo pipefail`);
 *   - the entry points answer --help with exit 0, a usage text and no side
 *     effect, and rebuild.sh's help still documents what the downloads page and
 *     the README tell people to run (--format deb, --no-container, --testing);
 *   - build-mode.cjs, which scripts/build-ui.sh --testing rewrites, says
 *     production in the working tree and at HEAD, and build-ui.sh --reset puts
 *     it back (run against a copy of the repo root, never this checkout);
 *   - deploy/deploy-to-host.sh defines cv() before its first use (a stored
 *     ENGINE was silently ignored when it did not);
 *   - shellcheck passes for every tracked .sh (warning level and up) when a
 *     shellcheck binary is available (node_modules/.bin or PATH); SKIP otherwise.
 *
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
  if (!ok) failed = 1;
};
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
const tracked = git('ls-files').split('\n').filter(Boolean);
const shellScripts = tracked.filter((f) => f.endsWith('.sh'));

// ---- 1. the superseded scripts are gone, and unreferenced ----------------
const gone = ['run1.sh', 'run2.sh', 'rebuild-test.sh', 'ollama.sh', 'backend/start.sh', 'dev-multi.sh',
  'scripts/build-production.sh', 'scripts/build-testing.sh', 'scripts/set-build-mode.sh', 'scripts/test-socket-auth.mjs'];
check('the superseded scripts are not tracked', gone.every((f) => !tracked.includes(f)), gone.filter((f) => tracked.includes(f)).join(', '));
check('...and not on disk either', gone.every((f) => !fs.existsSync(path.join(REPO, f))), gone.filter((f) => fs.existsSync(path.join(REPO, f))).join(', '));
const stale = [];
const names = /run1\.sh|run2\.sh|rebuild-test\.sh|ollama\.sh|backend\/start\.sh|dev-multi\.sh|build-production\.sh|build-testing\.sh|set-build-mode\.sh|test-socket-auth/;
for (const f of tracked) {
  if (/^src\/whats-new\/|^CHANGELOG\.md$|^tests\/scripts\.test\.mjs$|package-lock\.json$|\.(png|ico|icns|woff2?|ttf|mp3|gz)$/.test(f)) continue;
  const text = fs.readFileSync(path.join(REPO, f), 'utf8');
  if (names.test(text)) stale.push(f);
}
check('no tracked file refers to a removed script (What\'s New history excepted)', stale.length === 0, stale.join(', '));
// (the release history lives in CHANGELOG.md, which may name them; the README is checked like any file above)

// ---- 2. package.json scripts --------------------------------------------
const pkg = JSON.parse(read('package.json'));
// The Linux .rpm carries no /usr/lib/.build-id links: Electron apps ship
// identical binaries, so those links clash between packages (an install
// next to Slack failed with "conflicts with file from package slack")
check('the .rpm is built without /usr/lib/.build-id links (no clash with other Electron apps)', (pkg.build?.rpm?.fpm || []).includes('--rpm-rpmbuild-define=_build_id_links none'), JSON.stringify(pkg.build?.rpm));
const removedNpm = ['dev:multi', 'dev:testing', 'build:testing', 'electron:build:testing', 'electron:build:full:testing'];
check('the removed npm scripts stay removed', removedNpm.every((k) => !(k in pkg.scripts)), removedNpm.filter((k) => k in pkg.scripts).join(', '));
check('npm run build is scripts/build-ui.sh', pkg.scripts.build === 'bash scripts/build-ui.sh', pkg.scripts.build);
const missingFiles = [];
for (const [name, cmd] of Object.entries(pkg.scripts)) {
  const base = (cmd.match(/^cd\s+([\w./-]+)\s*&&/) || [, '.'])[1];   // "cd backend && bash build_backend.sh"
  for (const m of cmd.matchAll(/(?:bash|node)\s+([\w./-]+\.(?:sh|mjs|cjs|js))/g)) {
    if (!fs.existsSync(path.join(REPO, base, m[1]))) missingFiles.push(`${name}: ${m[1]}`);
  }
}
check('every file an npm script runs exists', missingFiles.length === 0, missingFiles.join(', '));

// ---- 3. strict mode, shebang, shared helpers ----------------------------
const selfHandled = new Set(['deploy/deploy-to-host.sh', 'deploy/remote-host.sh', 'deploy/prune-images.sh', 'scripts/privacy-scan.sh', 'tests/run-all.sh']);   // they report and continue
const noStrict = []; const noShebang = [];
for (const f of shellScripts) {
  const text = read(f);
  if (!/^#!\/(?:usr\/)?bin\/(?:env )?bash/.test(text)) noShebang.push(f);
  if (f === 'scripts/lib.sh') continue;   // sourced, never run
  const want = selfHandled.has(f) ? /^set -uo pipefail$/m : /^set -euo pipefail$/m;
  if (!want.test(text)) noStrict.push(f);
}
check(`every tracked .sh (${shellScripts.length}) has a bash shebang`, noShebang.length === 0, noShebang.join(', '));
check('...and set -euo pipefail (scripts that report and continue: set -uo pipefail)', noStrict.length === 0, noStrict.join(', '));
const sharing = ['run.sh', 'rebuild.sh', 'start-backend.sh', 'scripts/build-ui.sh', 'deploy/deploy-podman.sh'];
check('the entry points source scripts/lib.sh', sharing.every((f) => /\blib\.sh"/.test(read(f))), sharing.filter((f) => !/\blib\.sh"/.test(read(f))).join(', '));
check('deploy-to-host.sh and remote-host.sh stay self-contained (no lib.sh)', !/lib\.sh/.test(read('deploy/deploy-to-host.sh')) && !/lib\.sh/.test(read('deploy/remote-host.sh')));

// ---- 4. --help: exit 0, a usage text, no side effects ------------------
const helpers = ['run.sh', 'rebuild.sh', 'start-backend.sh', 'scripts/build-ui.sh', 'scripts/privacy-scan.sh', 'scripts/brand-icons.sh',
  'deploy/deploy-podman.sh', 'deploy/deploy-to-host.sh', 'deploy/prune-images.sh',
  'jacarium-central/run.sh', 'jacarium-central/generate-yjs-key.sh'];
const before = git('status', '--porcelain');
for (const f of helpers) {
  const r = spawnSync('bash', [path.join(REPO, f), '--help'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-help-')) } });
  const out = (r.stdout || '') + (r.stderr || '');
  check(`${f} --help exits 0 with a usage text`, r.status === 0 && /(usage|options|\.\/|\$0|deploy-podman|generate-)/i.test(out) && out.split('\n').length >= 3, `exit ${r.status}: ${out.slice(0, 160)}`);
}
check('--help left the working tree as it was', git('status', '--porcelain') === before);
const rebuildHelp = spawnSync('bash', [path.join(REPO, 'rebuild.sh'), '--help'], { cwd: REPO, encoding: 'utf8' }).stdout;
check('rebuild.sh --help documents --format deb, --no-container and --testing (the downloads page and README quote them)', /--format deb/.test(rebuildHelp) && /--no-container/.test(rebuildHelp) && /--testing/.test(rebuildHelp));
// the package format per platform: rebuild.sh --print-targets resolves the options to electron-builder
// arguments without building anything (the mac build used to get Linux's AppImage default)
const targets = (...args) => { const r = spawnSync('bash', [path.join(REPO, 'rebuild.sh'), ...args, '--print-targets'], { cwd: REPO, encoding: 'utf8' }); return { status: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim().split('\n').pop() }; };
check('rebuild.sh: mac without --format builds the dmg', targets('--platform', 'mac').out === '--mac dmg', JSON.stringify(targets('--platform', 'mac')));
check('rebuild.sh: linux without --format builds the AppImage', targets().out === '--linux AppImage' && targets('--platform', 'linux').out === '--linux AppImage', JSON.stringify(targets()));
check('rebuild.sh: windows without --format builds nsis', targets('--platform', 'windows').out === '--win nsis', JSON.stringify(targets('--platform', 'windows')));
check('rebuild.sh: --format all builds every format of the platform', targets('--platform', 'mac', '--format', 'all').out === '--mac dmg zip' && targets('--platform', 'linux', '--format', 'all').out === '--linux AppImage deb rpm tar.gz' && targets('--platform', 'windows', '--format', 'all').out === '--win nsis portable msi zip');
check('rebuild.sh: an explicit format is passed through, several space separated', targets('--platform', 'linux', '--format', 'deb').out === '--linux deb' && targets('--platform', 'mac', '--format', 'dmg zip').out === '--mac dmg zip');
const macDeb = targets('--platform', 'mac', '--format', 'deb');
check('rebuild.sh: mac + deb is refused before the build, naming the mac formats', macDeb.status !== 0 && /not a mac package format/.test(macDeb.out) && /dmg zip pkg/.test(macDeb.out), JSON.stringify(macDeb));
const linuxDmg = targets('--platform', 'linux', '--format', 'dmg');
check('rebuild.sh: linux + dmg is refused', linuxDmg.status !== 0 && /not a linux package format/.test(linuxDmg.out), JSON.stringify(linuxDmg));
check('rebuild.sh: --platform all builds each platform\'s default (or all with --format all) and refuses another format', targets('--platform', 'all').out === '--linux AppImage --mac dmg --win nsis' && targets('--platform', 'all', '--format', 'all').out === '--linux AppImage deb rpm tar.gz --mac dmg zip --win nsis portable msi zip' && targets('--platform', 'all', '--format', 'deb').status !== 0);
check('rebuild.sh --help lists the per-platform formats and defaults', /Linux:\s+AppImage \(default\), deb, rpm, tar\.gz, dir/.test(rebuildHelp) && /macOS:\s+dmg \(default\), zip, pkg, mas, dir/.test(rebuildHelp) && /Windows:\s+nsis \(default\), portable, msi, zip, dir/.test(rebuildHelp) && /--print-targets/.test(rebuildHelp));
check('--print-targets left the working tree as it was', git('status', '--porcelain') === before);
const downloads = read('backend/downloads.py');
check('the downloads page tells people ./rebuild.sh, --format deb and --no-container', /\.\/rebuild\.sh/.test(downloads) && /--format deb/.test(downloads) && /--no-container/.test(downloads));
const unknown = spawnSync('bash', [path.join(REPO, 'run.sh'), '--no-such-option'], { cwd: REPO, encoding: 'utf8' });
check('run.sh refuses an unknown option', unknown.status !== 0 && /unknown option/.test((unknown.stdout || '') + (unknown.stderr || '')));

// ---- 5. build-mode.cjs: production in the tree and at HEAD; --reset ----
const modeOf = (text) => (text.match(/buildMode:\s*'([^']+)'/) || [])[1];
check('build-mode.cjs says production in the working tree', modeOf(read('build-mode.cjs')) === 'production', modeOf(read('build-mode.cjs')));
check('...and at HEAD', modeOf(git('show', 'HEAD:build-mode.cjs')) === 'production');
check('build-mode.cjs is in electron-builder\'s file list', (pkg.build?.files || []).includes('build-mode.cjs'));
{
  // --reset on a copy of the scripts + build-mode.cjs, never on this checkout
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-ui-reset-'));
  fs.mkdirSync(path.join(tmp, 'scripts'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'build-ui.sh'), path.join(tmp, 'scripts', 'build-ui.sh'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'lib.sh'), path.join(tmp, 'scripts', 'lib.sh'));
  fs.writeFileSync(path.join(tmp, 'build-mode.cjs'), "module.exports = {\n  buildMode: 'testing'\n};\n");
  const r = spawnSync('bash', [path.join(tmp, 'scripts', 'build-ui.sh'), '--reset'], { cwd: tmp, encoding: 'utf8' });
  check('scripts/build-ui.sh --reset rewrites build-mode.cjs to production without building', r.status === 0 && modeOf(fs.readFileSync(path.join(tmp, 'build-mode.cjs'), 'utf8')) === 'production', `exit ${r.status}: ${(r.stdout || '') + (r.stderr || '')}`);
  check('rebuild.sh restores build-mode.cjs after a --testing build (EXIT trap)', /trap restore_build_mode EXIT/.test(read('rebuild.sh')) && /build-ui\.sh --reset/.test(read('rebuild.sh')));
  fs.rmSync(tmp, { recursive: true, force: true });
}
check('electron/main.cjs still reads build-mode.cjs', /require\('\.\.\/build-mode\.cjs'\)/.test(read('electron/main.cjs')));

// ---- 6. deploy-to-host.sh: cv() before its first use --------------------
{
  const text = read('deploy/deploy-to-host.sh');
  const def = text.indexOf('cv() {');
  const use = text.indexOf('$(cv ');
  check('deploy-to-host.sh defines cv() before the first $(cv ...) (a stored ENGINE is honoured)', def >= 0 && use >= 0 && def < use, `defined at ${def}, used at ${use}`);
  check('...and the stored ENGINE is read through it', /ENGINE="\$\(cv ENGINE\)"/.test(text));
}

// ---- 7. shellcheck -------------------------------------------------------
{
  const local = path.join(REPO, 'node_modules', '.bin', 'shellcheck');
  const bin = fs.existsSync(local) ? local : (spawnSync('sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8' }).stdout || '').trim();
  if (!bin) {
    console.log('SKIP: shellcheck not installed (brew install shellcheck, or npm install --no-save shellcheck) - lint not run');
  } else {
    const r = spawnSync(bin, ['-S', 'warning', '-x', ...shellScripts], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    check(`shellcheck -S warning passes for every tracked .sh (${shellScripts.length} files, ${path.basename(bin)})`, r.status === 0, out.split('\n').filter((l) => /^In |SC\d+/.test(l)).slice(0, 12).join(' | '));
  }
}

console.log(failed ? 'FAILED' : 'all checks passed');
process.exit(failed);
