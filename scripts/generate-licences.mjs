#!/usr/bin/env node
// The list of every open-source package that SHIPS, with its licence and the
// licence / notice text it provides, for Settings > About > "All open-source
// licences": public/licences.json, generated at build time (scripts/build-ui.sh,
// npm's postinstall so a dev checkout has it too) and never by hand, from
//
//   - the root app's package-lock.json: the production tree (the entries the
//     lock does not mark `dev`), i.e. what the Vite bundle and the desktop
//     app's node_modules carry;
//   - jacarium-central/package-lock.json: the central server's whole tree
//     (it has no devDependencies) - only for a build that ships it, i.e. the
//     container (--with-central, or JACARIUM_LICENCES_CENTRAL=1, which
//     deploy/Containerfile sets); the desktop installers do not carry the
//     central server, so their list leaves it out;
//   - the Python packages of the backend: from the installed site-packages
//     the build has at hand (backend/venv in a checkout, /opt/app-root in the
//     container), their METADATA's licence and the licence files in the
//     dist-info; absent when there is no venv (a browser-only build), and
//     said so;
//
// with the version from the lock, the licence from the package's own
// package.json (`license`, or the legacy `licenses` list) and the text of its
// LICENSE* / LICENCE* / COPYING* / NOTICE* files. Nothing is fetched: a
// package without a licence file is listed with its SPDX id alone. The RPMs
// of the container image are not here - the release's SBOM (CycloneDX,
// attached to every release) lists them with their licences.
//
// Reproducible (a function of the lock files and the installed packages),
// deterministic order (ecosystem, name, version). The file is git-ignored.
//
//   node scripts/generate-licences.mjs            (postinstall) writes public/licences.json; a lock entry whose
//                                                 package is not installed (the central server's tree before its
//                                                 own npm ci, an optional platform package) is listed from the
//                                                 lock alone, with a warning
//   node scripts/generate-licences.mjs --strict   (the build) the same, but a missing production package is an
//                                                 error: a build must not ship a list with holes
//   ... --with-central                            also the central server's tree (the container build)
//   node scripts/generate-licences.mjs --check    prints what it would write (count, size) without writing
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'public', 'licences.json');
const CHECK = process.argv.includes('--check');
const STRICT = process.argv.includes('--strict');
const WITH_CENTRAL = process.argv.includes('--with-central') || process.env.JACARIUM_LICENCES_CENTRAL === '1';
const LICENCE_FILE = /^(licen[sc]e|copying|notice)([-._].*)?$/i;
const MAX_TEXT = 60000;   // one file's text kept at most (the odd 300 KB notice is cut, and says so)

function readLicenceTexts(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => LICENCE_FILE.test(n) && fs.statSync(path.join(dir, n)).isFile()); } catch { return []; }
  return names.sort().map((n) => {
    let text = fs.readFileSync(path.join(dir, n), 'utf8').replace(/\r\n/g, '\n').trim();
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n\n[... cut: the full text is in the package]';
    return { file: n, text };
  });
}

function licenceOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => (typeof l === 'string' ? l : l && l.type)).filter(Boolean).join(' OR ');
  return '';
}

function repoOf(pkg) {
  const r = pkg.repository;
  const url = typeof r === 'string' ? r : r && r.url;
  if (!url) return pkg.homepage || '';
  return String(url).replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/');
}

/** The npm packages of one lock file: production entries of the root app, every entry of the central server. */
function npmPackages(root, lockRel, { productionOnly }) {
  const out = [];
  const missing = [];
  // the container's UI build stage runs npm ci (and so this postinstall) before the rest of the tree is
  // copied in: a lock file that is not there yet is reported, not fatal; the build's --strict run, after
  // `COPY . .` and the central server's own npm ci, has it
  if (!fs.existsSync(path.join(root, lockRel))) { missing.push(`${lockRel} (not present)`); return { packages: out, missing }; }
  const lock = JSON.parse(fs.readFileSync(path.join(root, lockRel), 'utf8'));
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key) continue;
    if (productionOnly && (entry.dev || entry.devOptional)) continue;
    if (entry.link) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const dir = path.join(root, key);
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { pkg = null; }
    if (!pkg) {
      // not installed here: an optional platform package (fsevents on Linux, ...) is simply not shipped; a
      // production package is listed from the lock alone (no licence field or text) and reported
      if (entry.optional) continue;
      missing.push(key);
      out.push({ ecosystem: 'npm', name, version: entry.version || '', licence: '', url: entry.resolved ? '' : '', texts: [] });
      continue;
    }
    out.push({ ecosystem: 'npm', name, version: entry.version || pkg.version || '', licence: licenceOf(pkg), url: repoOf(pkg), texts: readLicenceTexts(dir) });
  }
  return { packages: out, missing };
}

/** The Python packages of an installed site-packages (the dist-info's METADATA and licence files). */
function pythonPackages() {
  const roots = [];
  for (const base of [path.join(REPO, 'backend', 'venv', 'lib'), '/opt/app-root/lib']) {
    try { for (const v of fs.readdirSync(base)) { const sp = path.join(base, v, 'site-packages'); if (fs.existsSync(sp)) roots.push(sp); } } catch { /* no venv here */ }
  }
  const out = [];
  for (const sp of roots) {
    for (const info of fs.readdirSync(sp).filter((n) => n.endsWith('.dist-info'))) {
      const dir = path.join(sp, info);
      let meta = '';
      try { meta = fs.readFileSync(path.join(dir, 'METADATA'), 'utf8'); } catch { continue; }
      const field = (k) => { const m = new RegExp(`^${k}: (.*)$`, 'm').exec(meta); return m ? m[1].trim() : ''; };
      const name = field('Name'), version = field('Version');
      if (!name) continue;
      let licence = field('License-Expression') || field('License');
      if (!licence || licence === 'UNKNOWN' || licence.length > 80) {
        const classifiers = [...meta.matchAll(/^Classifier: License :: (?:OSI Approved :: )?(.+)$/gm)].map((m) => m[1].trim());
        if (classifiers.length) licence = classifiers.join(' / ');
        else if (licence && licence.length > 80) licence = licence.slice(0, 77) + '...';
      }
      const url = field('Home-page') || ((/^Project-URL: (?:Homepage|Source|Repository)[^,]*, (.*)$/m.exec(meta) || [])[1] || '');
      const texts = [];
      for (const sub of ['', 'licenses']) {
        for (const t of readLicenceTexts(path.join(dir, sub))) texts.push(sub ? { ...t, file: `${sub}/${t.file}` } : t);
      }
      out.push({ ecosystem: 'pypi', name, version, licence, url, texts });
    }
    break;   // one site-packages is the truth for a build
  }
  return out;
}

const rootNpm = npmPackages(REPO, 'package-lock.json', { productionOnly: true });
const centralNpm = WITH_CENTRAL
  ? npmPackages(path.join(REPO, 'jacarium-central'), 'package-lock.json', { productionOnly: false })
  : { packages: [], missing: [] };
const python = pythonPackages();
const seen = new Map();
for (const p of [...rootNpm.packages, ...centralNpm.packages.map((p) => ({ ...p, ecosystem: 'npm', where: 'central' })), ...python]) {
  const id = `${p.ecosystem}:${p.name}@${p.version}`;
  if (!seen.has(id)) seen.set(id, p);
}
const packages = [...seen.values()].sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const doc = {
  generatedFrom: { rootLock: 'package-lock.json (production tree)', centralLock: WITH_CENTRAL ? 'jacarium-central/package-lock.json' : 'not part of this build (the desktop installers do not ship the central server)', python: python.length ? 'the installed backend packages (site-packages)' : 'none found at build time' },
  counts: { npm: packages.filter((p) => p.ecosystem === 'npm').length, pypi: python.length, withText: packages.filter((p) => p.texts.length).length },
  packages,
};
const json = JSON.stringify(doc);
const missing = [...rootNpm.missing, ...centralNpm.missing.map((k) => `jacarium-central/${k}`)];
if (missing.length) {
  const note = `[licences] ${missing.length} production entries of the lock files are not installed here, listed without their licence text: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', ...' : ''}`;
  if (STRICT) { console.error(`${note}\n[licences] ERROR: a build must not ship a list with holes - run npm ci in the root${WITH_CENTRAL ? ' and in jacarium-central' : ''} first`); process.exit(1); }
  console.warn(note);
}
if (CHECK) {
  console.log(`[licences] ${packages.length} packages (${doc.counts.npm} npm, ${doc.counts.pypi} pypi; ${doc.counts.withText} with a licence text), ${Math.round(json.length / 1024)} KB`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(`[licences] ${packages.length} packages (${doc.counts.npm} npm, ${doc.counts.pypi} pypi; ${doc.counts.withText} with a licence text) -> ${path.relative(REPO, OUT)} (${Math.round(json.length / 1024)} KB)`);
}
