/**
 * Guards the spell checker's dictionaries on Windows / Linux
 * (electron/spellcheck.cjs, electron/spellcheck-dictionaries.json,
 * scripts/fetch-spellcheck-dictionaries.mjs).
 *
 * THE PROBLEM: Electron's built-in spell checker uses Hunspell on Windows
 * and Linux and, by default, downloads the dictionary of each language from
 * Google's CDN (redirector.gvt1.com) into <sessionData>/Dictionaries on the
 * first run - an outbound request nothing in the app declared ("offline by
 * default", SECURITY.md).
 *
 * THE FIX: the dictionaries (en-US, en-GB, en-AU, cs-CZ, sk-SK) come from the
 * hunspell_dictionaries.zip asset of the exact Electron release in
 * package-lock.json, pinned by sha256 in the manifest, fetched and checked
 * at build time, packaged as resources/dictionaries for the Linux and
 * Windows targets, checked again and copied into the profile before the
 * session exists; the download URL is pointed at a local file: URL that
 * cannot be fetched. macOS (NSSpellChecker) ships nothing and runs none of it.
 *
 * What this test proves (plain Node, the real module and script, temporary
 * directories; no Electron is launched - tests/electron-spellcheck-live.test.mjs
 * does that):
 *   - the manifest pins the Electron version of package-lock.json, a GitHub
 *     release URL of that version, 64-hex sha256 values and sizes for the zip,
 *     the five dictionaries and the licence files, with a release older than
 *     the dependency policy's 7 days;
 *   - no dictionary binary is tracked in git (the privacy scan's 1 MB rule),
 *     build/dictionaries is git-ignored, and the manifest is packaged;
 *   - package.json packages build/dictionaries as resources/dictionaries for
 *     linux and win only (nothing for mac), rebuild.sh and electron:build fetch
 *     and verify them before electron-builder runs;
 *   - main.cjs sets the checker up first thing in whenReady, before any
 *     window, with no copy for the profile picker, and the picker window has
 *     spellcheck off; no http(s) dictionary download URL appears in electron/;
 *   - installDictionaries: copies files whose sha256 matches, keeps a target
 *     that already matches, replaces one that differs (an earlier CDN copy),
 *     refuses a tampered source (and leaves the target alone), reports a
 *     missing one; nothing happens for darwin in setUp;
 *   - chooseLanguages keeps the configured languages that are shipped and
 *     falls back to en-US;
 *   - the script: --check passes on build/dictionaries when the files are
 *     there (SKIP with the fetch command otherwise), fails naming the file on
 *     a tampered copy, and refuses a manifest whose Electron differs from the
 *     installed one (exercised on a copy of the tree);
 *   - a packaged app of this platform and version, when one is here:
 *     resources/dictionaries holds every file with its pinned hash on Linux,
 *     and no such directory exists on macOS;
 *   - SECURITY.md and docs/security/spellcheck-dictionaries.md say so.
 *
 * Run: node tests/electron-spellcheck-dictionaries.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { testablePackagedApp } from './helpers/packaged-app.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8');
const HEX64 = /^[0-9a-f]{64}$/;

const spellcheck = require(path.join(REPO, 'electron', 'spellcheck.cjs'));
const manifest = JSON.parse(read('electron/spellcheck-dictionaries.json'));
const lock = JSON.parse(read('package-lock.json'));
const pkg = JSON.parse(read('package.json'));

// ---------------------------------------------------------------- the manifest
const lockedElectron = lock.packages['node_modules/electron'].version;
check('the manifest pins the Electron version of package-lock.json', manifest.electron === lockedElectron, `${manifest.electron} vs ${lockedElectron}`);
check('the asset is that release\'s hunspell_dictionaries.zip on github.com', manifest.asset.url === `https://github.com/electron/electron/releases/download/v${manifest.electron}/hunspell_dictionaries.zip` && manifest.asset.release === `https://github.com/electron/electron/releases/tag/v${manifest.electron}`, manifest.asset.url);
check('the zip has a 64-hex sha256, a size and an upload date', HEX64.test(manifest.asset.sha256) && Number.isInteger(manifest.asset.size) && manifest.asset.size > 1e6 && !Number.isNaN(Date.parse(manifest.asset.createdAt)), JSON.stringify(manifest.asset));
const languages = manifest.dictionaries.map((d) => d.language);
check('the five dictionaries: en-US, en-GB, en-AU, cs-CZ, sk-SK', ['en-US', 'en-GB', 'en-AU', 'cs-CZ', 'sk-SK'].every((l) => languages.includes(l)) && languages.length === 5, languages.join(', '));
check('every dictionary file is <language>-<major>-<minor>.bdic with a 64-hex sha256, a size, a label and a licence', manifest.dictionaries.every((d) => new RegExp(`^${d.language}-\\d+-\\d+\\.bdic$`).test(d.file) && HEX64.test(d.sha256) && Number.isInteger(d.size) && d.size > 1000 && d.label && d.licence), JSON.stringify(manifest.dictionaries.map((d) => d.file)));
check('the licence files of the zip are pinned too (LICENSE, COPYING, COPYING.*)', manifest.licences.some((l) => l.file === 'LICENSE') && manifest.licences.some((l) => l.file === 'COPYING') && manifest.licences.every((l) => /^(LICENSE|COPYING(\.[A-Za-z0-9]+)?)$/.test(l.file) && HEX64.test(l.sha256) && Number.isInteger(l.size)), manifest.licences.map((l) => l.file).join(', '));
check('no two entries share a file name or a hash', new Set([...manifest.dictionaries, ...manifest.licences].map((e) => e.file)).size === manifest.dictionaries.length + manifest.licences.length && new Set([...manifest.dictionaries, ...manifest.licences].map((e) => e.sha256)).size === manifest.dictionaries.length + manifest.licences.length);
const ageDays = (Date.now() - Date.parse(manifest.asset.createdAt)) / 86400000;
// 7 days in general; from 2 days when that Electron release came in through the security lane
// (docs/security/urgent-updates.md names it as electron@<version>, the lane's own record)
const pinnedTag = (manifest.asset.release.match(/\/tag\/v([^/]+)$/) || [])[1] || '';
const viaLane = !!pinnedTag && fs.readFileSync(path.join(REPO, 'docs', 'security', 'urgent-updates.md'), 'utf8').includes(`electron@${pinnedTag}`);
check(`the pinned release is at least 7 days old (the dependency policy)${viaLane ? ', or 2 through the security lane' : ''}`, ageDays >= 7 || (viaLane && ageDays >= 2), `${ageDays.toFixed(1)} days${viaLane ? ` (electron@${pinnedTag} through the lane)` : ''}`);
check('the notice shipped beside the dictionaries names each of them and its licence', (() => { const n = read('electron/spellcheck-dictionaries-NOTICE.txt'); return manifest.dictionaries.every((d) => n.includes(d.file)) && /GNU General Public License, version 2/.test(n) && /SCOWL/.test(n) && /Mozilla Public License 1\.1/.test(n); })());

// ---------------------------------------------------------------- git and packaging
const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n');
check('no .bdic dictionary is tracked in git', !tracked.some((f) => f.endsWith('.bdic')), tracked.filter((f) => f.endsWith('.bdic')).join(', '));
check('build/dictionaries/ is git-ignored', /^build\/dictionaries\/$/m.test(read('.gitignore')));
check('the manifest and the notice are tracked and packaged in the asar (build.files electron/**/*)', tracked.includes('electron/spellcheck-dictionaries.json') && tracked.includes('electron/spellcheck-dictionaries-NOTICE.txt') && pkg.build.files.includes('electron/**/*'));
const resourcesOf = (platform) => (pkg.build[platform]?.extraResources || []).filter((r) => r.from === 'build/dictionaries' && r.to === 'dictionaries');
check('package.json packages build/dictionaries as resources/dictionaries for linux and win', resourcesOf('linux').length === 1 && resourcesOf('win').length === 1, JSON.stringify({ linux: pkg.build.linux?.extraResources, win: pkg.build.win?.extraResources }));
check('and not for mac (the system checker; nothing changes there)', resourcesOf('mac').length === 0 && !(pkg.build.extraResources || []).some((r) => /dictionar/i.test(JSON.stringify(r))), JSON.stringify({ mac: pkg.build.mac?.extraResources, top: pkg.build.extraResources }));
const rebuild = read('rebuild.sh');
check('rebuild.sh fetches and verifies the dictionaries before electron-builder, for linux / windows / all', /linux\|windows\|all\)\s*\n\s*log_info[^\n]*\n\s*node scripts\/fetch-spellcheck-dictionaries\.mjs \|\| die/.test(rebuild) && rebuild.indexOf('fetch-spellcheck-dictionaries.mjs') < rebuild.indexOf('npx electron-builder $(electron_targets)'));
check('npm run electron:build does too', /node scripts\/fetch-spellcheck-dictionaries\.mjs && electron-builder/.test(pkg.scripts['electron:build']) && /node scripts\/fetch-spellcheck-dictionaries\.mjs && electron-builder/.test(pkg.scripts['electron:build:full']));

// ---------------------------------------------------------------- main.cjs
const main = read('electron/main.cjs');
check('main.cjs requires electron/spellcheck.cjs', /require\('\.\/spellcheck\.cjs'\)/.test(main));
const ready = main.slice(main.indexOf('app.whenReady().then('));
check('setUp runs first thing in whenReady, before the About panel, the picker and createWindow()', ready.indexOf('spellcheck.setUp(') > 0 && ready.indexOf('spellcheck.setUp(') < ready.indexOf('setAboutPanelOptions') && ready.indexOf('spellcheck.setUp(') < ready.indexOf('createProfilePickerWindow()') && ready.indexOf('spellcheck.setUp(') < ready.indexOf('createWindow()'));
check('the first window waits for the dictionaries: `await spellcheck.ready()` right before createWindow()', /await spellcheck\.ready\(\);\n\s*createWindow\(\);/.test(ready));
check('the profile picker gets no copy (copy: !profileSelection.ask) and its window has spellcheck off', /spellcheck\.setUp\(\{[^}]*copy: !profileSelection\.ask/.test(main) && /partition: 'picker',\s*\n(\s*\/\/[^\n]*\n)*\s*spellcheck: false/.test(main));
const electronSources = fs.readdirSync(path.join(REPO, 'electron')).filter((f) => f.endsWith('.cjs')).map((f) => [f, read(`electron/${f}`)]);
check('no http(s) dictionary download URL in electron/*.cjs (the only one set is the local file: URL)', electronSources.every(([, src]) => !/setSpellCheckerDictionaryDownloadURL\(\s*['"`]https?:/.test(src)) && spellcheck.NO_DOWNLOAD_URL.startsWith('file:///') && /setSpellCheckerDictionaryDownloadURL\(NO_DOWNLOAD_URL\)/.test(read('electron/spellcheck.cjs')));
check('nothing in electron/ names Google\'s dictionary CDN as a URL to use', electronSources.every(([, src]) => !/https?:\/\/[a-z.]*(gvt1\.com|googleapis\.com|google\.com)\/[^\s'"`]*dict/i.test(src)));
check('setUp does nothing on macOS (no copy, no session touched)', (() => {
  let touched = false;
  const session = { get defaultSession() { touched = true; return {}; } };
  const state = spellcheck.setUp({ app: { isPackaged: false, getPath: () => { touched = true; return '/x'; } }, session, platform: 'darwin', log: () => {} });
  return !touched && state.active === false;
})());
check('DICTIONARY_PLATFORMS is win32 + linux', [...spellcheck.DICTIONARY_PLATFORMS].sort().join(',') === 'linux,win32');

// ---------------------------------------------------------------- installDictionaries, on temporary directories
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcheck-dict-test-'));
try {
  const source = path.join(tmp, 'source');
  const target = path.join(tmp, 'target', 'Dictionaries');
  fs.mkdirSync(source, { recursive: true });
  const content = (name) => Buffer.from(`fake dictionary ${name}\n`.repeat(50));
  const fake = { dictionaries: ['en-US-10-1.bdic', 'cs-CZ-3-0.bdic', 'sk-SK-3-0.bdic', 'en-GB-10-1.bdic'].map((file) => ({ file, language: file.split('-').slice(0, 2).join('-'), sha256: null })) };
  for (const d of fake.dictionaries) {
    fs.writeFileSync(path.join(source, d.file), content(d.file));
    d.sha256 = spellcheck.sha256File(path.join(source, d.file));
  }
  fs.writeFileSync(path.join(source, 'sk-SK-3-0.bdic'), 'tampered');          // a source that does not match its hash
  fs.rmSync(path.join(source, 'en-GB-10-1.bdic'));                                // a missing source
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'cs-CZ-3-0.bdic'), 'an earlier download');   // a target to replace
  fs.writeFileSync(path.join(target, 'sk-SK-3-0.bdic'), 'left alone');            // the tampered one's target
  const logs = [];
  const first = spellcheck.installDictionaries({ sourceDir: source, targetDir: target, manifest: fake, log: (l) => logs.push(l) });
  check('installDictionaries copies a verified file and replaces a target that differs', first.installed.sort().join(',') === 'cs-CZ-3-0.bdic,en-US-10-1.bdic' && fs.readFileSync(path.join(target, 'cs-CZ-3-0.bdic')).equals(content('cs-CZ-3-0.bdic')) && fs.readFileSync(path.join(target, 'en-US-10-1.bdic')).equals(content('en-US-10-1.bdic')), JSON.stringify(first));
  check('refuses a source whose sha256 does not match and leaves its target alone', first.skipped.join(',') === 'sk-SK-3-0.bdic' && fs.readFileSync(path.join(target, 'sk-SK-3-0.bdic'), 'utf8') === 'left alone' && logs.some((l) => /sk-SK-3-0\.bdic: sha256 .* is not the pinned/.test(l)), logs.join(' | '));
  check('reports a missing source', first.missing.join(',') === 'en-GB-10-1.bdic');
  check('no partial file is left behind', !fs.readdirSync(target).some((f) => f.includes('.partial')), fs.readdirSync(target).join(', '));
  const second = spellcheck.installDictionaries({ sourceDir: source, targetDir: target, manifest: fake, log: () => {} });
  check('a second run keeps the files that already match (nothing copied again)', second.kept.sort().join(',') === 'cs-CZ-3-0.bdic,en-US-10-1.bdic' && second.installed.length === 0, JSON.stringify(second));
  const fresh = path.join(tmp, 'fresh', 'Dictionaries');
  const third = spellcheck.installDictionaries({ sourceDir: source, targetDir: fresh, manifest: fake, log: () => {} });
  check('creates the Dictionaries directory when the profile has none', fs.existsSync(fresh) && third.installed.length === 2, JSON.stringify(third));

  // setUp on Linux, with a fake app and session: the copy, the URL, the listeners, the languages
  const calls = [];
  const listeners = {};
  const fakeSession = {
    defaultSession: {
      setSpellCheckerDictionaryDownloadURL: (url) => calls.push(['url', url]),
      on: (event, fn) => { listeners[event] = fn; },
      getSpellCheckerLanguages: () => (calls.some((c) => c[0] === 'languages') ? ['en-US'] : ['de-DE']),
      setSpellCheckerLanguages: (langs) => calls.push(['languages', langs]),
    },
  };
  const userData = path.join(tmp, 'linux-profile');
  const state = spellcheck.setUp({ app: { isPackaged: true, getPath: () => userData }, session: fakeSession, platform: 'linux', manifest: fake, sourceDir: source, log: () => {} });
  check('setUp on Linux copies into <sessionData>/Dictionaries, sets the file: download URL and listens for downloads', state.active && state.targetDir === path.join(userData, 'Dictionaries') && state.installed.length === 2 && fs.existsSync(path.join(userData, 'Dictionaries', 'en-US-10-1.bdic')) && calls.some((c) => c[0] === 'url' && c[1] === spellcheck.NO_DOWNLOAD_URL) && ['spellcheck-dictionary-download-begin', 'spellcheck-dictionary-download-failure', 'spellcheck-dictionary-initialized'].every((e) => typeof listeners[e] === 'function'), JSON.stringify({ state, calls }));
  check('a configured language that is not shipped (de-DE) is replaced by en-US', calls.some((c) => c[0] === 'languages' && c[1].join(',') === 'en-US'), JSON.stringify(calls));
  // ready(): the first window waits for the 'initialized' event of every language in use (Chromium hands a
  // dictionary loaded after a renderer was created only to renderers whose process is already up)
  let settled = null;
  spellcheck.ready().then((r) => { settled = r; });
  await new Promise((r) => setTimeout(r, 30));
  check('ready() is pending until the dictionary of the language in use is reported initialized', settled === null && spellcheck.status().wanted.join(',') === 'en-US' && spellcheck.status().ready === false, JSON.stringify(spellcheck.status()));
  listeners['spellcheck-dictionary-download-begin']({}, 'de-DE');
  listeners['spellcheck-dictionary-initialized']({}, 'en-US');
  await new Promise((r) => setTimeout(r, 30));
  check('and resolves with what was initialized once it arrives', settled && settled.initialized.join(',') === 'en-US' && settled.timedOut === false && spellcheck.status().ready === true, JSON.stringify(settled));
  check('status() records what the session reported (and is plain data)', spellcheck.status().downloads.join(',') === 'de-DE' && spellcheck.status().initialized.join(',') === 'en-US' && !('readyPromise' in spellcheck.status()) && JSON.stringify(spellcheck.status()).length > 0);
  check('ready() resolves at once where nothing was set up (macOS)', await Promise.race([spellcheck.ready().then(() => true), new Promise((r) => setTimeout(() => r(false), 50))]));
  check('the wait is capped (READY_TIMEOUT_MS) so a broken file never holds the window back', Number.isInteger(spellcheck.READY_TIMEOUT_MS) && spellcheck.READY_TIMEOUT_MS <= 5000 && /settle\(true\)/.test(read('electron/spellcheck.cjs')), String(spellcheck.READY_TIMEOUT_MS));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- failing closed
{
  // setUp with a copy step that throws (a manifest that cannot be read): the URL is still set
  const calls = [];
  const fakeSession = { defaultSession: { setSpellCheckerDictionaryDownloadURL: (url) => calls.push(['url', url]), on: () => {}, getSpellCheckerLanguages: () => ['en-US'], setSpellCheckerLanguages: () => {} } };
  const broken = { get dictionaries() { throw new Error('manifest unreadable'); } };
  const logs = [];
  const state = spellcheck.setUp({ app: { isPackaged: true, getPath: () => '/nonexistent' }, session: fakeSession, platform: 'linux', manifest: broken, sourceDir: '/nonexistent', log: (l) => logs.push(l) });
  check('a copy step that throws is logged and the local download URL is still set (setUp never skips it)', state.copyError === 'manifest unreadable' && calls.some((c) => c[0] === 'url' && c[1] === spellcheck.NO_DOWNLOAD_URL) && logs.some((l) => /not installed \(manifest unreadable\)/.test(l)), JSON.stringify({ state, calls, logs }));
  // failClosed (main.cjs's catch): the URL once more, else the checker off
  const calls2 = [];
  const session2 = { defaultSession: { setSpellCheckerDictionaryDownloadURL: (url) => calls2.push(['url', url]), setSpellCheckerEnabled: (on) => calls2.push(['enabled', on]) } };
  const s2 = spellcheck.failClosed({ session: session2, platform: 'win32', error: new Error('boom'), log: () => {} });
  check('failClosed sets the local download URL and records the error', s2.setUpError === 'boom' && calls2.length === 1 && calls2[0][1] === spellcheck.NO_DOWNLOAD_URL && s2.disabled === false, JSON.stringify({ s2, calls2 }));
  const calls3 = [];
  const session3 = { defaultSession: { setSpellCheckerDictionaryDownloadURL: () => { throw new Error('no url'); }, setSpellCheckerEnabled: (on) => calls3.push(['enabled', on]) } };
  const s3 = spellcheck.failClosed({ session: session3, platform: 'linux', error: new Error('boom'), log: () => {} });
  check('and turns the checker off when even the URL cannot be set', s3.disabled === true && calls3.length === 1 && calls3[0][1] === false, JSON.stringify({ s3, calls3 }));
  const s4 = spellcheck.failClosed({ session: { get defaultSession() { throw new Error('no session'); } }, platform: 'linux', error: new Error('boom'), log: () => {} });
  check('and survives a session that cannot be reached (logged, ready() resolves)', s4.setUpError === 'boom' && typeof s4.disabled === 'boolean', JSON.stringify(s4));
  let touched = false;
  spellcheck.failClosed({ session: { get defaultSession() { touched = true; return {}; } }, platform: 'darwin', log: () => {} });
  check('failClosed does nothing on macOS', !touched);
  check('main.cjs runs failClosed when setUp throws', /catch \(err\) \{\n(\s*\/\/[^\n]*\n)*\s*spellcheck\.failClosed\(\{ session: require\('electron'\)\.session, error: err/.test(main));
}

// ---------------------------------------------------------------- chooseLanguages
const shipped = spellcheck.shippedLanguages(manifest);
check('chooseLanguages keeps the configured languages that are shipped, in order', spellcheck.chooseLanguages(['cs-CZ', 'de-DE', 'en-GB'], shipped).join(',') === 'cs-CZ,en-GB');
check('falls back to en-US when none is shipped or none is configured', spellcheck.chooseLanguages(['de-DE'], shipped).join(',') === 'en-US' && spellcheck.chooseLanguages([], shipped).join(',') === 'en-US' && spellcheck.chooseLanguages(undefined, shipped).join(',') === 'en-US');
check('and to the first shipped language when en-US is not among them', spellcheck.chooseLanguages(['fr'], ['cs-CZ']).join(',') === 'cs-CZ');

// ---------------------------------------------------------------- the script
const script = path.join(REPO, 'scripts', 'fetch-spellcheck-dictionaries.mjs');
const run = (argv, cwd = REPO) => spawnSync(process.execPath, [script, ...argv], { cwd, encoding: 'utf8' });
const help = run(['--help']);
check('the script answers --help with its usage', help.status === 0 && /--check/.test(help.stdout) && /--repin/.test(help.stdout), help.stderr);
const dictDir = path.join(REPO, 'build', 'dictionaries');
if (fs.existsSync(path.join(dictDir, manifest.dictionaries[0].file))) {
  const ok = run(['--check']);
  check('--check verifies build/dictionaries against the manifest (every file, the notice included)', ok.status === 0 && /no red flag/.test(ok.stdout) && manifest.dictionaries.every((d) => ok.stdout.includes(`${d.file}: sha256 ok`)) && /NOTICE\.txt: sha256 ok/.test(ok.stdout), ok.stdout + ok.stderr);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcheck-dict-copy-'));
  try {
    fs.cpSync(dictDir, copy, { recursive: true });
    fs.appendFileSync(path.join(copy, manifest.dictionaries[1].file), 'x');
    fs.rmSync(path.join(copy, 'LICENSE'));
    const bad = run(['--check', '--dir', copy]);
    check('--check on a tampered copy fails and names the changed and the missing file', bad.status === 1 && bad.stdout.includes(`${manifest.dictionaries[1].file}: ${manifest.dictionaries[1].size + 1} bytes, expected ${manifest.dictionaries[1].size}`) && /LICENSE: missing/.test(bad.stdout) && /RED FLAG/.test(bad.stdout), bad.stdout + bad.stderr);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
} else {
  console.log(`SKIP: build/dictionaries is not populated - node scripts/fetch-spellcheck-dictionaries.mjs fetches the pinned files (network)`);
}
// a manifest for another Electron than the installed one is refused (on a copy of the tree: the script
// reads the manifest, package-lock.json and node_modules/electron next to itself)
{
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'spellcheck-tree-'));
  try {
    fs.mkdirSync(path.join(copy, 'scripts'));
    fs.mkdirSync(path.join(copy, 'electron'));
    fs.mkdirSync(path.join(copy, 'node_modules', 'electron'), { recursive: true });
    fs.copyFileSync(script, path.join(copy, 'scripts', 'fetch-spellcheck-dictionaries.mjs'));
    fs.copyFileSync(path.join(REPO, 'electron', 'spellcheck-dictionaries-NOTICE.txt'), path.join(copy, 'electron', 'spellcheck-dictionaries-NOTICE.txt'));
    fs.writeFileSync(path.join(copy, 'electron', 'spellcheck-dictionaries.json'), JSON.stringify({ ...manifest, electron: '42.0.0' }));
    fs.writeFileSync(path.join(copy, 'node_modules', 'electron', 'package.json'), JSON.stringify({ name: 'electron', version: manifest.electron }));
    fs.writeFileSync(path.join(copy, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/electron': { version: manifest.electron } } }));
    const r = spawnSync(process.execPath, [path.join(copy, 'scripts', 'fetch-spellcheck-dictionaries.mjs'), '--check'], { cwd: copy, encoding: 'utf8' });
    check('a manifest pinned to another Electron than the installed one is refused (--repin is the way)', r.status === 1 && /RED FLAG: the manifest pins Electron 42\.0\.0 but .* is installed: .*--repin/.test(r.stdout), r.stdout + r.stderr);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- a packaged app, when one is here
const { app: packaged, skip } = testablePackagedApp();
if (skip) {
  console.log(`SKIP (packaged app): ${skip}`);
} else {
  const resources = path.dirname(packaged.asar);
  const dir = path.join(resources, 'dictionaries');
  if (packaged.platform === 'linux') {
    const missing = [...manifest.dictionaries, ...manifest.licences].filter((e) => !fs.existsSync(path.join(dir, e.file)) || spellcheck.sha256File(path.join(dir, e.file)) !== e.sha256).map((e) => e.file);
    check('the packaged Linux app carries resources/dictionaries with every pinned file (and the notice)', missing.length === 0 && fs.existsSync(path.join(dir, 'NOTICE.txt')), missing.join(', ') || dir);
  } else {
    check('the packaged macOS app carries no dictionaries directory', !fs.existsSync(dir), dir);
  }
}

// ---------------------------------------------------------------- the documentation
check('SECURITY.md says the dictionaries are shipped and nothing is downloaded for them', /spell/i.test(read('SECURITY.md')) && /spellcheck-dictionaries/.test(read('SECURITY.md')));
check('docs/security/spellcheck-dictionaries.md records the provenance (release, zip sha256, every file)', (() => { const d = read('docs/security/spellcheck-dictionaries.md'); return d.includes(manifest.asset.sha256) && d.includes(`v${manifest.electron}`) && manifest.dictionaries.every((x) => d.includes(x.sha256)); })());

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
