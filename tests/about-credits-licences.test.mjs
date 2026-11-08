/**
 * Settings > About's Credits and "All open-source licences"
 * (src/components/common/modals/settings/AboutSettings.jsx,
 * scripts/generate-licences.mjs, public/licences.json):
 *
 *   static: every credit has a name, what it is, a url, a licence and a
 *     licence url, no version number; React, Electron, Node.js, Lucide, Yjs,
 *     Font Awesome Free (the CC BY 4.0 attribution, OFL fonts, MIT code) and
 *     the three dictionary entries (the licences of
 *     electron/spellcheck-dictionaries-NOTICE.txt) are there; the README's
 *     Licence section names the same things; the build runs the generator
 *     (--strict) and npm's postinstall runs it; the file is git-ignored;
 *   the generator: run here (it writes public/licences.json); every
 *     production entry of package-lock.json and every entry of
 *     jacarium-central's lock is in the list at its locked version, no
 *     dev-only package is (eslint, electron-builder, vite, playwright-core),
 *     the Python packages of backend/venv are in it when the venv is there,
 *     at least 95 % of the npm entries carry a licence text, the size is
 *     printed and under 4 MB;
 *   the Python side (scripts/licences-python.py), per build type, without
 *     podman: a throwaway venv carrying a synthetic distribution for every
 *     entry of backend/requirements.lock whose marker applies - the
 *     container (--mode image: every locked package and Python itself,
 *     merged into the UI's list; --strict fails on a missing or
 *     differently-versioned one), the installers (--mode frozen through
 *     generate-licences.mjs: exactly the distributions a PyInstaller
 *     analysis bundles, Python and the bootloader; --strict fails on a
 *     bundled file no distribution owns, and on a missing analysis), the dev
 *     checkout (backend/venv: the locked packages and Python);
 *   jsdom, the REAL About: the Credits rows render with a licence link each,
 *     "View all licences" fetches the list (a stub returning a small one),
 *     shows the count and the packages, the filter narrows them, Close
 *     folds it; a missing file shows the warning note.
 *
 * Run: node tests/about-credits-licences.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// static: the credits
// ---------------------------------------------------------------------------
const about = read('src/components/common/modals/settings/AboutSettings.jsx');
const creditsSrc = about.slice(about.indexOf('const CREDITS = ['), about.indexOf('];', about.indexOf('const CREDITS = [')));
const credits = [...creditsSrc.matchAll(/\{ name: '([^']+)', what: '((?:[^'\\]|\\.)*)', url: '([^']+)', (?:\.\.\.OFL|licence: '([^']+)', licenceUrl: ([^ ]+)) \}/g)].map((m) => ({ name: m[1], what: m[2], url: m[3], licence: m[4] || 'SIL Open Font License', licenceUrl: m[5] || 'https://openfontlicense.org' }));
// (a licence's own version - CC BY 4.0, GPL-2.0 - is part of its name; a package version is what must not be there)
check(`every credit (${credits.length}) has a name, what it is, a url, a licence and a licence url, and no package version number`, credits.length >= 14 && credits.every((c) => c.name && c.what && /^https?:\/\//.test(c.url) && c.licence && c.licenceUrl) && !/\d+\.\d+/.test(credits.map((c) => c.name + ' ' + c.what).join(' ')), credits.map((c) => c.name).join(', '));
const by = (n) => credits.find((c) => c.name === n);
check('Python is credited as the backend\'s runtime under the PSF License Version 2, linking the PSF licence', by('Python')?.what === "the backend\\'s runtime" && by('Python')?.licence === 'PSF License Version 2' && /docs\.python\.org\/3\/license\.html/.test(by('Python')?.licenceUrl || ''), JSON.stringify(by('Python')));
check('React (MIT), Electron (MIT), Node.js (MIT, the nodejs/node LICENSE), Lucide (ISC), Yjs (MIT) are credited', by('React')?.licence === 'MIT' && by('Electron')?.licence === 'MIT' && by('Node.js')?.licence === 'MIT' && /github\.com\/nodejs\/node\/blob\/main\/LICENSE/.test(about) && by('Lucide')?.licence === 'ISC' && by('Yjs')?.licence === 'MIT');
check('Font Awesome Free is credited with the CC BY 4.0 icons, the OFL fonts and the MIT code, linking its licence', /CC BY 4\.0 icons, SIL OFL 1\.1 fonts, MIT code/.test(by('Font Awesome Free')?.licence || '') && /fontawesome\.com\/license\/free/.test(about));
const notice = read('electron/spellcheck-dictionaries-NOTICE.txt');
check('the dictionaries are credited with the licences of the NOTICE: SCOWL English (the SCOWL notice, BSD affix rules, WordNet), Czech GPL-2.0, Slovak GPL-2.0 / LGPL-2.1 / MPL-1.1', /SCOWL/.test(by('SCOWL English dictionaries')?.licence || '') && by('Czech dictionary')?.licence === 'GPL-2.0' && /GPL-2\.0, LGPL-2\.1 or MPL-1\.1/.test(by('Slovak dictionary')?.licence || '') && /GNU General Public License, version 2/.test(notice) && /Mozilla Public License 1\.1/.test(notice) && /SCOWL/.test(notice) && credits.filter((c) => /dictionar/.test(c.name)).every((c) => /Windows and Linux builds/.test(c.what)));
const readme = read('README.md');
const licenceSection = readme.slice(readme.indexOf('## Licence'));
check('the README\'s Licence section names the same things (React, Lucide, Electron, Node.js, Yjs, Font Awesome Free with the three licences, the dictionaries with the NOTICE, the generated list)', ['React', 'Lucide', 'Electron', 'Node.js', 'Python', 'PSF License Version 2', 'PyInstaller', 'Yjs', 'Font Awesome Free', 'CC BY 4.0', 'SIL OFL', 'SCOWL', 'GPL-2.0', 'MPL-1.1', 'spellcheck-dictionaries-NOTICE.txt', 'All open-source licences'].every((w) => licenceSection.includes(w)));
check('the build generates the list (--strict) and npm\'s postinstall generates it; the file is git-ignored', /node scripts\/generate-licences\.mjs --strict/.test(read('scripts/build-ui.sh')) && /"postinstall": "node scripts\/vendor-assets\.mjs && node scripts\/generate-licences\.mjs"/.test(read('package.json')) && /^public\/licences\.json$/m.test(read('.gitignore')));
check('the container installs the central server\'s packages before the UI build, so the list has them', (() => { const c = read('deploy/Containerfile'); return c.indexOf('RUN JACARIUM_LICENCES_CENTRAL=1 JACARIUM_LICENCES_PYTHON=image npm run build') > 0 && c.indexOf('cd jacarium-central && npm ci --omit=dev') < c.indexOf('RUN JACARIUM_LICENCES_CENTRAL=1 JACARIUM_LICENCES_PYTHON=image npm run build'); })());
check('the About view loads the list from the app\'s own origin on demand (no network, nothing hard-coded) with the shared Button, TextInput and Note', /fetch\('licences\.json', \{ cache: 'no-cache' \}\)/.test(about) && /data-testid="about-licences-open"/.test(about) && /<TextInput value=\{filter\}/.test(about) && /<Note tone="warning" testId="about-licences-error">/.test(about));

// ---------------------------------------------------------------------------
// the generator
// ---------------------------------------------------------------------------
// the desktop installers' list (the default): no central server, which they do not ship
const desktopGen = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'generate-licences.mjs'), '--check'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, JACARIUM_LICENCES_CENTRAL: '' } });
check('the default (desktop installers) list leaves the central server out and needs only the root install', desktopGen.status === 0 && !/jacarium-central/.test(desktopGen.stderr), (desktopGen.stderr || desktopGen.stdout).slice(-300));
{
  const d = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'generate-licences.mjs')], { cwd: REPO, encoding: 'utf8', env: { ...process.env, JACARIUM_LICENCES_CENTRAL: '' } });
  const doc = d.status === 0 ? JSON.parse(read('public/licences.json')) : null;
  check('...no entry of the default list is marked as the central server\'s', !!doc && !doc.packages.some((p) => p.where === 'central') && /not part of this build/.test(doc.generatedFrom.centralLock), d.stderr.slice(-200));
}
check('the container build opts in to the central server\'s packages and leaves the Python side to the runtime stage (JACARIUM_LICENCES_CENTRAL=1 JACARIUM_LICENCES_PYTHON=image npm run build)', /RUN JACARIUM_LICENCES_CENTRAL=1 JACARIUM_LICENCES_PYTHON=image npm run build/.test(read('deploy/Containerfile')));
{
  const cf = read('deploy/Containerfile');
  const runtime = cf.slice(cf.lastIndexOf('\nFROM '));
  check('the image\'s runtime stage merges the Python side with its own Python, --strict, after the lock is installed and the UI copied', /RUN python -I \/tmp\/licences-python\.py --mode image --lock \/app\/backend\/requirements\.lock --strict --merge \/app\/ui\/licences\.json/.test(runtime) && runtime.indexOf('licences-python.py --mode image') > runtime.indexOf('pip install --no-cache-dir --no-compile -r /app/backend/requirements.txt') && runtime.indexOf('licences-python.py --mode image') > runtime.indexOf('COPY --from=ui /src/dist /app/ui'));
  check('the installers\' builds read the frozen backend: rebuild.sh exports JACARIUM_LICENCES_PYTHON=frozen after the backend build, deploy-to-host publish-desktop --build sets it', /build_backend\n[\s\S]{0,400}Analysis-00\.toc \]; then\n\s+export JACARIUM_LICENCES_PYTHON=frozen/.test(read('rebuild.sh')) && read('rebuild.sh').indexOf('JACARIUM_LICENCES_PYTHON=frozen') < read('rebuild.sh').indexOf('bash scripts/build-ui.sh "${UI_BUILD_ARGS') && /npm run backend:build && JACARIUM_LICENCES_PYTHON=frozen npm run build/.test(read('deploy/deploy-to-host.sh')));
}
// the container's list: with the central server
const gen = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'generate-licences.mjs'), '--with-central'], { cwd: REPO, encoding: 'utf8' });
check('the generator runs and writes public/licences.json', gen.status === 0 && fs.existsSync(path.join(REPO, 'public', 'licences.json')), (gen.stderr || gen.stdout).slice(-300));
if (gen.status === 0) {
  const doc = JSON.parse(read('public/licences.json'));
  const size = fs.statSync(path.join(REPO, 'public', 'licences.json')).size;
  console.log(`  licences.json: ${doc.packages.length} packages (${doc.counts.npm} npm, ${doc.counts.pypi} pypi, ${doc.counts.withText} with text), ${(size / 1024).toFixed(0)} KB`);
  const ids = new Set(doc.packages.map((p) => `${p.ecosystem}:${p.name}@${p.version}`));
  const lock = JSON.parse(read('package-lock.json'));
  const prod = Object.entries(lock.packages).filter(([k, v]) => k && !v.dev && !v.devOptional && !v.link).map(([k, v]) => ({ name: k.slice(k.lastIndexOf('node_modules/') + 13), version: v.version, optional: !!v.optional }));
  const prodMissing = prod.filter((p) => !ids.has(`npm:${p.name}@${p.version}`) && !p.optional);
  check(`every production entry of package-lock.json (${prod.length}) is in the list at its locked version`, prodMissing.length === 0, prodMissing.slice(0, 6).map((p) => `${p.name}@${p.version}`).join(', '));
  const central = JSON.parse(read('jacarium-central/package-lock.json'));
  const centralEntries = Object.entries(central.packages).filter(([k, v]) => k && !v.link).map(([k, v]) => ({ name: k.slice(k.lastIndexOf('node_modules/') + 13), version: v.version, optional: !!v.optional }));
  const centralMissing = centralEntries.filter((p) => !ids.has(`npm:${p.name}@${p.version}`) && !p.optional);
  check(`every entry of the central server's lock (${centralEntries.length}) is in the list`, centralMissing.length === 0, centralMissing.slice(0, 6).map((p) => `${p.name}@${p.version}`).join(', '));
  const devOnly = ['eslint', 'electron-builder', 'vite', 'playwright-core', 'esbuild', 'globals'];
  const devPresent = devOnly.filter((n) => doc.packages.some((p) => p.ecosystem === 'npm' && p.name === n && p.where !== 'central'));
  check('no dev-only package is in the list (eslint, electron-builder, vite, playwright-core, esbuild, globals)', devPresent.length === 0, devPresent.join(', '));
  const venv = fs.existsSync(path.join(REPO, 'backend', 'venv', 'lib'));
  check(`the dev checkout: the backend's Python packages are in the list when the venv is there (${venv ? doc.counts.pypi + ' found' : 'no venv here'}), the build tools of the venv are not, Python itself is with its licence text`, !venv || (doc.counts.pypi > 50 && doc.packages.some((p) => p.ecosystem === 'pypi' && /^flask$/i.test(p.name)) && !doc.packages.some((p) => p.ecosystem === 'pypi' && /^(pyinstaller|pip)$/i.test(p.name)) && doc.packages.some((p) => p.ecosystem === 'runtime' && p.name === 'Python' && p.licence === 'PSF-2.0' && /PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2/.test(p.texts[0]?.text || ''))));
  const npmWithText = doc.packages.filter((p) => p.ecosystem === 'npm' && p.texts.length).length;
  check(`at least 95 % of the npm entries carry a licence text (${npmWithText} of ${doc.counts.npm})`, npmWithText / doc.counts.npm >= 0.95);
  check('the size stays sane (under 4 MB)', size < 4 * 1024 * 1024, `${size} bytes`);
  check('the entries are in a deterministic order (ecosystem, name, version)', doc.packages.every((p, i) => i === 0 || `${doc.packages[i - 1].ecosystem}${doc.packages[i - 1].name}`.localeCompare(`${p.ecosystem}${p.name}`) <= 0));
}

// the container's UI build stage: npm ci (and the postinstall) runs before the rest of the tree is copied,
// so jacarium-central's lock is not there yet - the generator must warn and go on, and only --strict refuses
{
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'licences-stage-'));
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(REPO, f), path.join(stage, f));
  fs.mkdirSync(path.join(stage, 'scripts'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'generate-licences.mjs'), path.join(stage, 'scripts', 'generate-licences.mjs'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(stage, 'node_modules'));
  const env = { ...process.env, JACARIUM_LICENCES_CENTRAL: '1' };
  const plain = spawnSync(process.execPath, [path.join(stage, 'scripts', 'generate-licences.mjs')], { cwd: stage, encoding: 'utf8', env });
  const strict = spawnSync(process.execPath, [path.join(stage, 'scripts', 'generate-licences.mjs'), '--strict'], { cwd: stage, encoding: 'utf8', env });
  // the installer build: the root's npm ci only, no central server - --strict passes
  const installer = spawnSync(process.execPath, [path.join(stage, 'scripts', 'generate-licences.mjs'), '--strict', '--check'], { cwd: stage, encoding: 'utf8', env: { ...process.env, JACARIUM_LICENCES_CENTRAL: '' } });
  check('the installer build (no jacarium-central installed) passes --strict: its list does not include the central server', installer.status === 0, (installer.stderr || installer.stdout).slice(-300));
  check('without jacarium-central\'s lock (the UI build stage before COPY . .) the postinstall run warns and still writes the list', plain.status === 0 && /not present/.test(plain.stderr) && fs.existsSync(path.join(stage, 'public', 'licences.json')), (plain.stderr + plain.stdout).slice(-300));
  check('...and --strict (the build itself) refuses that state', strict.status === 1 && /must not ship a list with holes/.test(strict.stderr), strict.stderr.slice(-200));
  fs.rmSync(stage, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// the Python side per build type, without podman: a throwaway venv of the backend's Python with a synthetic
// distribution (dist-info with METADATA, RECORD and a LICENSE, and one module file) for every lock entry
// ---------------------------------------------------------------------------
const PY = [path.join(REPO, 'backend', 'venv', 'bin', 'python3'), path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')].find((p) => fs.existsSync(p));
if (!PY) console.log('SKIP: the Python side (no backend/venv)');
else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'licences-python-'));
  const backend = path.join(tmp, 'backend');
  fs.mkdirSync(backend);
  const mk = spawnSync(PY, ['-I', '-m', 'venv', '--without-pip', path.join(backend, 'venv')], { encoding: 'utf8' });
  const vpy = [path.join(backend, 'venv', 'bin', 'python3'), path.join(backend, 'venv', 'Scripts', 'python.exe')].find((p) => fs.existsSync(p));
  const site = vpy && spawnSync(vpy, ['-I', '-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8' }).stdout.trim();
  check('a throwaway venv for the Python side', mk.status === 0 && !!site, mk.stderr);
  // the lock entries whose marker applies to this Python (the script's own evaluation, asked through image mode's empty run)
  const lockText = read('backend/requirements.lock');
  fs.writeFileSync(path.join(backend, 'requirements.lock'), lockText);
  const markerOk = (m) => spawnSync(vpy, ['-I', '-c', `import importlib.util,sys; s=importlib.util.spec_from_file_location('lp', sys.argv[1]); lp=importlib.util.module_from_spec(s); s.loader.exec_module(lp); print(lp.marker_applies(sys.argv[2]))`, path.join(REPO, 'scripts', 'licences-python.py'), m], { encoding: 'utf8' }).stdout.trim() === 'True';
  const locked = [...lockText.matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)\s*(?:;\s*(.+))?$/gm)].filter((m) => !m[3] || markerOk(m[3])).map((m) => ({ name: m[1], version: m[2] }));
  const distInfo = (name, version, licenceFile = 'LICENSE') => {
    const mod = name.toLowerCase().replace(/[-.]/g, '_');
    const info = path.join(site, `${mod}-${version}.dist-info`);
    fs.mkdirSync(info, { recursive: true });
    fs.writeFileSync(path.join(info, 'METADATA'), `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\nLicense-Expression: MIT\nHome-page: https://example.test/${mod}\n`);
    fs.writeFileSync(path.join(info, licenceFile), `Licence of ${name} (synthetic)`);
    fs.writeFileSync(path.join(site, `${mod}.py`), '');
    fs.writeFileSync(path.join(info, 'RECORD'), `${mod}.py,,\n${mod}-${version}.dist-info/METADATA,,\n${mod}-${version}.dist-info/RECORD,,\n`);
    return path.join(site, `${mod}.py`);
  };
  const files = locked.map((p) => distInfo(p.name, p.version));
  distInfo('pyinstaller', '6.0.0', 'COPYING.txt');
  const script = path.join(REPO, 'scripts', 'licences-python.py');
  const lockPath = path.join(backend, 'requirements.lock');
  // the container: the UI stage's list (no Python side), then the runtime stage's merge
  const uiDoc = path.join(tmp, 'licences.json');
  const ui = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'generate-licences.mjs'), '--check'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, JACARIUM_LICENCES_CENTRAL: '1', JACARIUM_LICENCES_PYTHON: 'image' } });
  check('the container\'s UI stage (JACARIUM_LICENCES_PYTHON=image, no Python there) writes the npm side and leaves Python to the runtime stage', ui.status === 0 && /, 0 pypi, 0 runtime;/.test(ui.stdout), ui.stdout + ui.stderr);
  fs.writeFileSync(uiDoc, JSON.stringify({ generatedFrom: { python: 'merged in by the runtime stage' }, counts: { npm: 1, pypi: 0, runtime: 0, withText: 1 }, packages: [{ ecosystem: 'npm', name: 'alpha-lib', version: '1.0.0', licence: 'MIT', url: '', texts: [{ file: 'LICENSE', text: 'MIT' }] }] }));
  const img = spawnSync(vpy, ['-I', script, '--mode', 'image', '--lock', lockPath, '--strict', '--merge', uiDoc], { encoding: 'utf8' });
  const merged = img.status === 0 ? JSON.parse(fs.readFileSync(uiDoc, 'utf8')) : null;
  const pyIds = new Set((merged?.packages || []).filter((p) => p.ecosystem === 'pypi').map((p) => `${p.name.toLowerCase().replace(/[-_.]+/g, '-')}@${p.version}`));
  const lockMissing = locked.filter((p) => !pyIds.has(`${p.name.toLowerCase().replace(/[-_.]+/g, '-')}@${p.version}`));
  check(`the container (--mode image --strict --merge): every applicable requirements.lock entry (${locked.length}) is in the list at its locked version, with its licence text; the npm side kept`, !!merged && lockMissing.length === 0 && merged.packages.filter((p) => p.ecosystem === 'pypi').every((p) => p.licence === 'MIT' && p.texts.length === 1) && merged.packages.some((p) => p.ecosystem === 'npm' && p.name === 'alpha-lib'), (img.stderr || '') + lockMissing.slice(0, 5).map((p) => p.name).join(', '));
  console.log(`  container (synthetic, from the lock): ${merged?.counts.pypi} Python packages, ${merged?.counts.runtime} runtime`);
  check('...Python itself is there (PSF-2.0, its LICENSE text), the bootloader is not (the image has none); counts.pypi / counts.runtime say so', !!merged && merged.packages.some((p) => p.ecosystem === 'runtime' && p.name === 'Python' && p.licence === 'PSF-2.0' && /PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2/.test(p.texts[0]?.text || '')) && !merged.packages.some((p) => /bootloader/.test(p.name)) && merged.counts.pypi === pyIds.size && merged.counts.runtime === 1 && /\/opt\/app-root/.test(merged.generatedFrom.python));
  // --strict: a locked package that is not installed, or at another version
  const victim = locked.find((p) => /^flask$/i.test(p.name)) || locked[0];
  const vinfo = path.join(site, `${victim.name.toLowerCase().replace(/[-.]/g, '_')}-${victim.version}.dist-info`);
  fs.renameSync(vinfo, vinfo + '.off');
  const miss = spawnSync(vpy, ['-I', script, '--mode', 'image', '--lock', lockPath, '--strict'], { encoding: 'utf8' });
  fs.renameSync(vinfo + '.off', vinfo);
  check(`...--strict fails when a locked package (${victim.name}) is not installed, and names it`, miss.status === 1 && miss.stderr.includes(`${victim.name}==${victim.version} (requirements.lock) is not installed`), miss.stderr.slice(-300));
  const meta = fs.readFileSync(path.join(vinfo, 'METADATA'), 'utf8');
  fs.writeFileSync(path.join(vinfo, 'METADATA'), meta.replace(`Version: ${victim.version}`, 'Version: 0.0.1'));
  const ver = spawnSync(vpy, ['-I', script, '--mode', 'image', '--lock', lockPath, '--strict'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(vinfo, 'METADATA'), meta);
  check('...and when one is installed at another version than the lock\'s', ver.status === 1 && /is installed at 0\.0\.1, requirements\.lock says/.test(ver.stderr), ver.stderr.slice(-300));
  // the installers: generate-licences.mjs with JACARIUM_LICENCES_PYTHON=frozen and a PyInstaller analysis bundling a subset
  const bundled = locked.filter((_, i) => i % 3 === 0);
  const toc = (paths) => { const f = path.join(tmp, 'Analysis-00.toc'); fs.writeFileSync(f, `([${JSON.stringify(path.join(REPO, 'backend', 'app_standalone.py'))}], [], [${paths.map((p, i) => `('m${i}', ${JSON.stringify(p)}, 'PYMODULE')`).join(', ')}], [('os', '/usr/lib/python3/os.py', 'PYMODULE')])`); return f; };
  const fenv = (tocFile) => ({ ...process.env, JACARIUM_LICENCES_CENTRAL: '', JACARIUM_LICENCES_PYTHON: 'frozen', JACARIUM_LICENCES_BACKEND: backend, JACARIUM_LICENCES_TOC: tocFile });
  const fr = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'generate-licences.mjs'), '--strict', '--python-only'], { cwd: REPO, encoding: 'utf8', env: fenv(toc(locked.map((p, i) => (i % 3 === 0 ? files[i] : null)).filter(Boolean))) });
  const side = fr.status === 0 ? JSON.parse(fr.stdout) : null;
  const names = new Set((side?.packages || []).map((p) => p.name));
  check(`the installers (JACARIUM_LICENCES_PYTHON=frozen --strict): exactly the ${bundled.length} distributions the PyInstaller analysis bundles, not the others`, !!side && names.size === bundled.length && bundled.every((p) => names.has(p.name)), (fr.stderr || '').slice(-300) + ` got ${names.size}`);
  console.log(`  installers (synthetic analysis): ${side?.packages.length} Python packages, ${side?.runtime.length} runtime`);
  check('...plus Python (PSF-2.0) and the PyInstaller bootloader (GPL-2.0-or-later with its exception, the COPYING text), the build tools themselves not as packages', !!side && side.runtime.some((r) => r.name === 'Python' && r.licence === 'PSF-2.0' && r.texts.length) && side.runtime.some((r) => r.name === 'PyInstaller bootloader' && /GPL-2\.0-or-later WITH/.test(r.licence) && ['licenses/COPYING.txt', 'COPYING.txt'].includes(r.texts[0]?.file)) && !names.has('pyinstaller'));
  const orphan = path.join(site, 'stray_module.py');
  fs.writeFileSync(orphan, '');
  const frOrphan = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'generate-licences.mjs'), '--strict', '--check'], { cwd: REPO, encoding: 'utf8', env: fenv(toc([files[0], orphan])) });
  check('...--strict fails when the bundle carries a site-packages file no distribution owns (a shipped package without an entry)', frOrphan.status === 1 && /belong to no installed distribution: .*stray_module\.py/.test(frOrphan.stderr) && /must not ship Python packages without their entries/.test(frOrphan.stderr), frOrphan.stderr.slice(-300));
  const frNone = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'generate-licences.mjs'), '--strict', '--check'], { cwd: REPO, encoding: 'utf8', env: fenv(path.join(tmp, 'no-such.toc')) });
  check('...and when the frozen backend\'s analysis is missing', frNone.status === 1 && /needs the PyInstaller analysis/.test(frNone.stderr), frNone.stderr.slice(-300));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// jsdom: the real About
// ---------------------------------------------------------------------------
for (const dep of ['esbuild', 'jsdom']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} is not installed`); process.exit(failed ? 1 : 0); } }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'about-credits-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  export { default as AboutSettings } from '@worktree/src/components/common/modals/settings/AboutSettings.jsx';
  export * as React from 'react';
  export { createRoot } from 'react-dom/client';
  export { act } from 'react';
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }], logLevel: 'error',
});
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'localStorage']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const small = { counts: { npm: 2, pypi: 1, runtime: 1, withText: 3 }, packages: [
  { ecosystem: 'npm', name: 'alpha-lib', version: '1.2.3', licence: 'MIT', url: 'https://example.test/alpha', texts: [{ file: 'LICENSE', text: 'MIT License\nCopyright (c) Example' }] },
  { ecosystem: 'npm', name: 'beta-lib', version: '0.1.0', licence: 'ISC', url: '', texts: [], where: 'central' },
  { ecosystem: 'pypi', name: 'gamma', version: '2.0', licence: 'BSD-3-Clause', url: '', texts: [{ file: 'licenses/LICENSE', text: 'BSD' }] },
  { ecosystem: 'runtime', name: 'Python', version: '3.14.0', licence: 'PSF-2.0', url: 'https://docs.python.org/3/license.html', note: 'the backend\'s runtime: CPython and its standard library', texts: [{ file: 'LICENSE', text: 'PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2' }] },
] };
let fetchMode = 'ok';
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const stubFetch = async (url) => { const u = String(url); if (/licences\.json/.test(u)) return fetchMode === 'ok' ? json(small) : json({ error: 'missing' }, 404); if (/\/api\/version/.test(u)) return json({ app: '0.0.0', protocol: 2 }); return json({ error: 'not mocked' }, 404); };
Object.defineProperty(globalThis, 'fetch', { value: stubFetch, configurable: true, writable: true }); dom.window.fetch = stubFetch;
const origErr = console.error; console.error = (...a) => { if (/Warning:|act\(|not mocked/.test(String(a[0] ?? ''))) return; origErr(...a); };
const { AboutSettings, React, createRoot, act } = createRequire(import.meta.url)(BUNDLE);
const { document } = dom.window;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const root = createRoot(document.getElementById('root'));
const render = async () => { await act(async () => { root.render(React.createElement(AboutSettings, {})); }); await act(async () => { await sleep(40); }); };
const click = async (el) => { await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await sleep(40); }); };
await render();
const rows = $$('[data-testid="about-credit"]');
check(`the Credits section renders every credit (${rows.length}) with a licence link in each row`, rows.length === credits.length && rows.every((r) => r.querySelectorAll('button').length >= 2));
check('...Python among them, as the backend\'s runtime with the PSF licence', rows.some((r) => /Python/.test(r.textContent) && /the backend's runtime/.test(r.textContent) && /PSF License Version 2/.test(r.textContent)));
check('the licences section offers "View all licences" and is closed', !!$('[data-testid="about-licences-open"]') && !$('[data-testid="about-licences"]'));
await click($('[data-testid="about-licences-open"]'));
check('"View all licences" loads the list: the count line (npm, Python, runtime) and one entry per package, the central one, the Python one and the runtime marked', /4 packages \(2 npm, 1 Python, 1 runtime\), 3 with their licence text/.test($('[data-testid="about-licences-count"]')?.textContent || '') && $$('[data-testid="about-licence-package"]').length === 4 && /3\.14\.0 · runtime/.test($('[data-testid="about-licences-list"]').textContent) && /CPython and its standard library/.test($('[data-testid="about-licences-list"]').textContent) && /central server/.test($('[data-testid="about-licences-list"]').textContent) && /Python/.test($('[data-testid="about-licences-list"]').textContent), $('[data-testid="about-licences-count"]')?.textContent);
check('...a package without a licence file says so, one with it shows the text', /No licence file in the package/.test($('[data-testid="about-licences-list"]').textContent) && /MIT License\nCopyright \(c\) Example/.test($('[data-testid="about-licences-list"]').textContent));
await act(async () => { const input = $('[data-testid="about-licences-filter"]'); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'bsd'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await sleep(30); });
check('the filter narrows the list by name or licence', $$('[data-testid="about-licence-package"]').length === 1 && /gamma/.test($('[data-testid="about-licences-list"]').textContent));
await click($('[data-testid="about-licences-close"]'));
check('Close folds the list back to the button', !!$('[data-testid="about-licences-open"]') && !$('[data-testid="about-licences"]'));
fetchMode = 'missing';
await click($('[data-testid="about-licences-open"]'));
check('a build without the file shows the warning note instead of a list', !!$('[data-testid="about-licences-error"]') && /HTTP 404/.test($('[data-testid="about-licences-error"]').textContent));
await act(async () => { root.render(null); });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
