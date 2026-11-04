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
check('React (MIT), Electron (MIT), Node.js (MIT, the nodejs/node LICENSE), Lucide (ISC), Yjs (MIT) are credited', by('React')?.licence === 'MIT' && by('Electron')?.licence === 'MIT' && by('Node.js')?.licence === 'MIT' && /github\.com\/nodejs\/node\/blob\/main\/LICENSE/.test(about) && by('Lucide')?.licence === 'ISC' && by('Yjs')?.licence === 'MIT');
check('Font Awesome Free is credited with the CC BY 4.0 icons, the OFL fonts and the MIT code, linking its licence', /CC BY 4\.0 icons, SIL OFL 1\.1 fonts, MIT code/.test(by('Font Awesome Free')?.licence || '') && /fontawesome\.com\/license\/free/.test(about));
const notice = read('electron/spellcheck-dictionaries-NOTICE.txt');
check('the dictionaries are credited with the licences of the NOTICE: SCOWL English (the SCOWL notice, BSD affix rules, WordNet), Czech GPL-2.0, Slovak GPL-2.0 / LGPL-2.1 / MPL-1.1', /SCOWL/.test(by('SCOWL English dictionaries')?.licence || '') && by('Czech dictionary')?.licence === 'GPL-2.0' && /GPL-2\.0, LGPL-2\.1 or MPL-1\.1/.test(by('Slovak dictionary')?.licence || '') && /GNU General Public License, version 2/.test(notice) && /Mozilla Public License 1\.1/.test(notice) && /SCOWL/.test(notice) && credits.filter((c) => /dictionar/.test(c.name)).every((c) => /Windows and Linux builds/.test(c.what)));
const readme = read('README.md');
const licenceSection = readme.slice(readme.indexOf('## Licence'));
check('the README\'s Licence section names the same things (React, Lucide, Electron, Node.js, Yjs, Font Awesome Free with the three licences, the dictionaries with the NOTICE, the generated list)', ['React', 'Lucide', 'Electron', 'Node.js', 'Yjs', 'Font Awesome Free', 'CC BY 4.0', 'SIL OFL', 'SCOWL', 'GPL-2.0', 'MPL-1.1', 'spellcheck-dictionaries-NOTICE.txt', 'All open-source licences'].every((w) => licenceSection.includes(w)));
check('the build generates the list (--strict) and npm\'s postinstall generates it; the file is git-ignored', /node scripts\/generate-licences\.mjs --strict/.test(read('scripts/build-ui.sh')) && /"postinstall": "node scripts\/vendor-assets\.mjs && node scripts\/generate-licences\.mjs"/.test(read('package.json')) && /^public\/licences\.json$/m.test(read('.gitignore')));
check('the container installs the central server\'s packages before the UI build, so the list has them', (() => { const c = read('deploy/Containerfile'); return c.indexOf('cd jacarium-central && npm ci --omit=dev') < c.indexOf('RUN npm run build'); })());
check('the About view loads the list from the app\'s own origin on demand (no network, nothing hard-coded) with the shared Button, TextInput and Note', /fetch\('licences\.json', \{ cache: 'no-cache' \}\)/.test(about) && /data-testid="about-licences-open"/.test(about) && /<TextInput value=\{filter\}/.test(about) && /<Note tone="warning" testId="about-licences-error">/.test(about));

// ---------------------------------------------------------------------------
// the generator
// ---------------------------------------------------------------------------
const gen = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'generate-licences.mjs')], { cwd: REPO, encoding: 'utf8' });
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
  check(`the backend's Python packages are in the list when the venv is there (${venv ? doc.counts.pypi + ' found' : 'no venv here'})`, !venv || (doc.counts.pypi > 50 && doc.packages.some((p) => p.ecosystem === 'pypi' && /^flask$/i.test(p.name))));
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
  const plain = spawnSync(process.execPath, [path.join(stage, 'scripts', 'generate-licences.mjs')], { cwd: stage, encoding: 'utf8' });
  const strict = spawnSync(process.execPath, [path.join(stage, 'scripts', 'generate-licences.mjs'), '--strict'], { cwd: stage, encoding: 'utf8' });
  check('without jacarium-central\'s lock (the UI build stage before COPY . .) the postinstall run warns and still writes the list', plain.status === 0 && /not present/.test(plain.stderr) && fs.existsSync(path.join(stage, 'public', 'licences.json')), (plain.stderr + plain.stdout).slice(-300));
  check('...and --strict (the build itself) refuses that state', strict.status === 1 && /must not ship a list with holes/.test(strict.stderr), strict.stderr.slice(-200));
  fs.rmSync(stage, { recursive: true, force: true });
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
const small = { counts: { npm: 2, pypi: 1, withText: 2 }, packages: [
  { ecosystem: 'npm', name: 'alpha-lib', version: '1.2.3', licence: 'MIT', url: 'https://example.test/alpha', texts: [{ file: 'LICENSE', text: 'MIT License\nCopyright (c) Example' }] },
  { ecosystem: 'npm', name: 'beta-lib', version: '0.1.0', licence: 'ISC', url: '', texts: [], where: 'central' },
  { ecosystem: 'pypi', name: 'gamma', version: '2.0', licence: 'BSD-3-Clause', url: '', texts: [{ file: 'licenses/LICENSE', text: 'BSD' }] },
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
check('the licences section offers "View all licences" and is closed', !!$('[data-testid="about-licences-open"]') && !$('[data-testid="about-licences"]'));
await click($('[data-testid="about-licences-open"]'));
check('"View all licences" loads the list: the count line and one entry per package, the central one and the Python one marked', /3 packages \(2 npm, 1 Python\), 2 with their licence text/.test($('[data-testid="about-licences-count"]')?.textContent || '') && $$('[data-testid="about-licence-package"]').length === 3 && /central server/.test($('[data-testid="about-licences-list"]').textContent) && /Python/.test($('[data-testid="about-licences-list"]').textContent), $('[data-testid="about-licences-count"]')?.textContent);
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
