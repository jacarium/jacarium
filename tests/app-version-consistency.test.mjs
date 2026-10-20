/**
 * Guards that the app's version is the same everywhere it is stored or
 * shown: package.json, package-lock.json (root + packages[""]), the newest
 * What's New entry (src/whats-new/versions: index.js order, the entry file
 * and its name), changelog.json's first entry and README.md's first
 * "What's New in v..." heading. Electron's app.getVersion() and the window
 * title read package.json, the window reads versions/index.js, so a
 * mismatch here means the app would show two different versions.
 *
 * Also checks the version format the release command enforces (parts 0-9)
 * for the CURRENT version only - older entries such as v2.4.20 predate the
 * rule and keep displaying.
 *
 * Run:  node tests/app-version-consistency.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ' | ' + detail : ''}`);
}

const pkg = JSON.parse(read('package.json'));
{
  const protocol = JSON.parse(read('protocol.json')).protocol;
  const fallback = Number((read('electron/main.cjs').match(/const PROTOCOL_FALLBACK = (\d+);/) || [])[1]);
  check('electron/main.cjs PROTOCOL_FALLBACK equals protocol.json (a build that lost the file still speaks the right protocol)', fallback === protocol, `${fallback} vs ${protocol}`);
}
const lock = JSON.parse(read('package-lock.json'));
const version = pkg.version;
console.log(`package.json version: ${version}`);

check('package.json version is X.Y.Z with every part 0-9 (release rule)', /^\d\.\d\.\d$/.test(version), version);
check('package-lock.json root version matches', lock.version === version, lock.version);
check('package-lock.json packages[""] version matches', lock.packages && lock.packages[''] && lock.packages[''].version === version, lock.packages?.['']?.version);

// versions/index.js and the entry files are read as text (the window tests
// bundle them with esbuild instead)
const VERSIONS_DIR = path.join(REPO, 'src', 'whats-new', 'versions');
const indexSrc = read('src/whats-new/versions/index.js');
const imports = Object.fromEntries(Array.from(indexSrc.matchAll(/^import \* as (v[\d_]+) from '\.\/(v[\d.]+)\.js';/gm)).map((m) => [m[1], m[2]]));
const arrayBody = (/export const versions = \[([\s\S]*?)\];/.exec(indexSrc) || [])[1] || '';
const order = arrayBody.split(',').map((t) => t.trim()).filter(Boolean).map((name) => imports[name]);
const entryVersion = (file) => (/export const version = '([^']+)'/.exec(fs.readFileSync(path.join(VERSIONS_DIR, `${file}.js`), 'utf8')) || [])[1];
const versionsMod = { versions: order.map((file) => ({ file, version: entryVersion(file) })) };
versionsMod.latestVersion = versionsMod.versions[0]?.version;
check('versions/index.js: every array entry is an imported file', order.length > 0 && order.every(Boolean), order.join(','));
check('versions/index.js latestVersion (first entry) matches', versionsMod.latestVersion === version, versionsMod.latestVersion);
check(`versions/v${version}.js exists and exports that version`, fs.existsSync(path.join(VERSIONS_DIR, `v${version}.js`)) && entryVersion(`v${version}`) === version);
check('versions[] is sorted newest first and every entry file name matches its exported version', versionsMod.versions.every((v, i, arr) => (i === 0 || cmp(arr[i - 1].version, v.version) > 0) && v.file === `v${v.version}`), versionsMod.versions.map((v) => v.version).join(','));
check('every entry file declares a features array', versionsMod.versions.every((v) => /export const features = \[/.test(fs.readFileSync(path.join(VERSIONS_DIR, `${v.file}.js`), 'utf8'))));

const changelog = JSON.parse(read('src/whats-new/versions/changelog.json'));
check('changelog.json first entry matches', changelog[0].version === version, changelog[0].version);
check('changelog.json lists the same versions as versions/index.js, same order', changelog.map((e) => e.version).join(',') === versionsMod.versions.map((v) => v.version).join(','), changelog.map((e) => e.version).join(','));

const changelogMd = read('CHANGELOG.md');
const heading = (/^## What's New in v(\S+)/m.exec(changelogMd) || [])[1];
check('CHANGELOG.md first "What\'s New in v..." heading matches', heading === version, heading);
check('CHANGELOG.md has no raw "<" (a tag name in a note would open HTML and hide the rest of the file)', !changelogMd.includes('<'), (changelogMd.split('\n').find((l) => l.includes('<')) || '').slice(0, 80));
check('README.md carries no release notes (they live in CHANGELOG.md)', !/^## What's New in v/m.test(read('README.md')));

// The AppStream metadata (Linux desktop files) carries the version too, and
// its license must agree with package.json and the LICENSE file.
const metainfo = read('com.jacarium.app.metainfo.xml');
const metaRelease = (/<release version="([^"]+)" date="(\d{4}-\d{2}-\d{2})"/.exec(metainfo) || []);
check('metainfo.xml <release version> matches (the release command updates it)', metaRelease[1] === version, metaRelease[1]);
const metaLicense = (/<project_license>([^<]+)<\/project_license>/.exec(metainfo) || [])[1];
check('metainfo.xml project_license equals package.json license and the LICENSE file is that license', metaLicense === pkg.license && pkg.license === 'AGPL-3.0-only' && /^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3,/.test(read('LICENSE')), `${metaLicense} / ${pkg.license}`);

// The COPR spec's fallback version (a build by hand; COPR itself builds
// the tag's version) and the newest %changelog entry follow the release.
const spec = read('packaging/copr/jacarium.spec');
const specVersion = (/^%\{!\?jacarium_version: %global jacarium_version ([^}]*)\}$/m.exec(spec) || [])[1];
check('packaging/copr/jacarium.spec fallback version matches (the release command updates it)', specVersion === version, specVersion);
const specChangelog = (/^%changelog\n\* \w{3} \w{3} \d{2} \d{4} [^\n]* - (\S+)-1$/m.exec(spec) || [])[1];
check('packaging/copr/jacarium.spec newest %changelog entry is this version', specChangelog === version, specChangelog);

// What's New ships text only: no entry imports an image and no image or
// carousel block is left (a screenshot of a working profile shows real data).
check('no What\'s New entry imports an image or has image/carousel blocks', versionsMod.versions.every((v) => { const s = fs.readFileSync(path.join(VERSIONS_DIR, `${v.file}.js`), 'utf8'); return !/\.(png|jpe?g|gif|webp|svg)['"]/.test(s) && !/type:\s*'(image|carousel)'/.test(s); }));

const src = ['src/components/WhatsNew.jsx', 'electron/main.cjs', 'electron/preload.cjs', 'src/App.jsx'].map(read).join('\n');
check('no source file hard-codes the version (Electron uses app.getVersion(), the window uses versions/index.js)', !new RegExp(`['"\`]${version.replace(/\./g, '\\.')}['"\`]`).test(src) && /app\.getVersion\(\)/.test(read('electron/main.cjs')) && /latestVersion/.test(read('src/components/WhatsNew.jsx')));

function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('Failed:'); for (const f of failed) console.log(`  - ${f.name}`); }
process.exit(failed.length ? 1 : 0);
