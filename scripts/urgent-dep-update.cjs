#!/usr/bin/env node
// An urgent dependency update that bypasses .npmrc's min-release-age for
// the named packages only, with the supply-chain checks done first and the
// paper trail written after. Used only when the user asks for it (an
// advisory whose fix is younger than seven days); never from a script.
//
//   npm run deps:urgent -- body-parser@1.20.9 fast-uri@3.1.9 --reason "GHSA-27r3-jxmh-p828, GHSA-w74x-v6f9-j3xg"
//   npm run deps:urgent -- electron@42.11.16 --reason "GHSA-jr5w-w6x2-84p9" --dry-run
//
// It refuses without explicit name@version specs and a --reason. For each
// spec it reports, before anything is installed:
//   - the publisher (_npmUser) against the installed version's (a change is
//     a red flag);
//   - dist.signatures present;
//   - SLSA provenance present and its source repository = the package's
//     repository (missing where the installed version had it = red flag);
//   - the tarball diffed against the installed copy: the changed files, new
//     or changed dependencies, new install scripts, new child_process / fs /
//     net / eval / env usage in the changed source files (red flags);
//   - the version's age.
// A red flag stops the run unless --force is given. The install passes
// --min-release-age=0 to npm for exactly these specs (an override for a
// transitive dependency, the right dependency field for a direct one);
// .npmrc is never edited and min-release-age=7 is asserted afterwards. Then
// the lockfile diff is checked (only the named packages' own entries changed,
// their integrity equal to the registry's), npm audit and npm audit
// signatures run, the test-only packages (jsdom, fake-indexeddb,
// playwright-core at the locked version) are reinstalled with --no-save
// behind a lockfile backup, docs/security/urgent-updates.md gets the note
// and the suggested commit message is printed. --dry-run runs every check
// and installs nothing.
//
// The registry, the shell and the clock are injectable (the test feeds a
// fake registry and records the commands); nothing here needs the network
// when those are supplied.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync, spawnSync } = require('child_process');

const DANGEROUS = [
  { name: 'child_process', rx: /child_process|\bexecSync\(|\bspawnSync\(|\bexecFile(Sync)?\(|\bspawn\(/ },
  { name: 'fs', rx: /require\(['"](node:)?fs(\/promises)?['"]\)|from ['"](node:)?fs['"]/ },
  { name: 'network', rx: /require\(['"](node:)?(net|http|https|dns|tls|dgram)['"]\)|\bfetch\(|XMLHttpRequest|WebSocket\(/ },
  { name: 'eval', rx: /\beval\(|new Function\(|\bvm\.(run|compile)|require\(['"](node:)?vm['"]\)/ },
  { name: 'env', rx: /process\.env\b/ },
];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare'];
const SOURCE_FILE = /\.(c?js|mjs|ts|cts|mts|json|sh)$/;

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { specs: [], reason: '', force: false, dryRun: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reason') { out.reason = String(argv[++i] || '').trim(); continue; }
    if (a.startsWith('--reason=')) { out.reason = a.slice('--reason='.length).trim(); continue; }
    if (a === '--force') { out.force = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a.startsWith('--')) { out.errors.push(`unknown option ${a}`); continue; }
    const m = /^(@?[^@]+)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(a);
    if (!m) { out.errors.push(`"${a}" is not an explicit name@x.y.z spec (ranges, tags and "update everything" are refused)`); continue; }
    out.specs.push({ name: m[1], version: m[2], raw: a });
  }
  if (!out.specs.length) out.errors.push('at least one explicit name@version spec is required');
  if (!out.reason) out.errors.push('--reason "<GHSA / CVE ...>" is required');
  return out;
}

// ---------------------------------------------------------------------------
// the registry (the real one over https / npm; the test injects an object with the same shape)
// ---------------------------------------------------------------------------
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function realRegistry(repoDir) {
  const base = 'https://registry.npmjs.org';
  return {
    /** the packument (versions, time) */
    packument: (name) => fetchJson(`${base}/${name.replace('/', '%2F')}`),
    /** the attestations of one version, or null */
    attestations: (name, version) => fetchJson(`${base}/-/npm/v1/attestations/${encodeURIComponent(name + '@' + version)}`).catch(() => null),
    /** the unpacked tarball of one version: the path of its package/ directory */
    unpack: (name, version) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urgent-dep-'));
      execFileSync('npm', ['pack', `${name}@${version}`, '--min-release-age=0', '--pack-destination', dir, '--silent'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
      const tgz = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
      execFileSync('tar', ['-xzf', path.join(dir, tgz), '-C', dir]);
      return path.join(dir, 'package');
    },
  };
}

// ---------------------------------------------------------------------------
// the checks
// ---------------------------------------------------------------------------
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function installedPackageDir(repoDir, name) {
  const dir = path.join(repoDir, 'node_modules', ...name.split('/'));
  return fs.existsSync(path.join(dir, 'package.json')) ? dir : null;
}

function publisherOf(versionDoc) {
  const u = versionDoc && versionDoc._npmUser;
  if (!u) return '';
  if (typeof u === 'string') return u;
  return [u.name, u.email ? `<${u.email}>` : ''].filter(Boolean).join(' ');
}

function repoSlug(repository) {
  const url = typeof repository === 'string' ? repository : (repository && repository.url) || '';
  const m = /github\.com[/:]([^/]+)\/([^/#.]+?)(?:\.git)?(?:[/#].*)?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : '';
}

/** The SLSA provenance of an attestation bundle: { repository, ref, workflow } or null. */
function provenanceOf(attestations) {
  if (!attestations || !Array.isArray(attestations.attestations)) return null;
  for (const a of attestations.attestations) {
    if (!/slsa\.dev\/provenance/.test(a.predicateType || '')) continue;
    try {
      const payload = JSON.parse(Buffer.from(a.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
      const ext = (((payload.predicate || {}).buildDefinition || {}).externalParameters || {});
      const wf = ext.workflow || {};
      return { repository: wf.repository || '', ref: wf.ref || '', workflow: wf.path || '', builder: ((((payload.predicate || {}).runDetails || {}).builder) || {}).id || '' };
    } catch {
      return { repository: '', ref: '', workflow: '', builder: '', unreadable: true };
    }
  }
  return null;
}

function listFiles(dir, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * The difference between the installed copy and the new tarball: the files
 * added / removed / changed, dependency and script changes, and the dangerous
 * usage that is new in a changed or added source file.
 */
function diffPackages(oldDir, newDir) {
  const oldFiles = new Set(oldDir ? listFiles(oldDir) : []);
  const newFiles = new Set(listFiles(newDir));
  const added = [...newFiles].filter((f) => !oldFiles.has(f));
  const removed = [...oldFiles].filter((f) => !newFiles.has(f));
  const changed = [...newFiles].filter((f) => oldFiles.has(f) && !fs.readFileSync(path.join(oldDir, f)).equals(fs.readFileSync(path.join(newDir, f))));
  const oldPkg = oldDir ? readJson(path.join(oldDir, 'package.json'), {}) : {};
  const newPkg = readJson(path.join(newDir, 'package.json'), {});
  const depChanges = [];
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
    const o = oldPkg[field] || {}, n = newPkg[field] || {};
    const names = new Set([...Object.keys(o), ...Object.keys(n)]);
    for (const dep of names) {
      if (!(dep in o)) depChanges.push(`${field}: + ${dep}@${n[dep]}`);
      else if (!(dep in n)) depChanges.push(`${field}: - ${dep}`);
      else if (o[dep] !== n[dep]) depChanges.push(`${field}: ${dep} ${o[dep]} -> ${n[dep]}`);
    }
  }
  const scriptChanges = [];
  for (const s of INSTALL_SCRIPTS) {
    const o = (oldPkg.scripts || {})[s], n = (newPkg.scripts || {})[s];
    if (n && n !== o) scriptChanges.push(`${s}: ${o ? `"${o}" -> ` : '+ '}"${n}"`);
  }
  const dangerous = [];
  for (const f of [...added, ...changed]) {
    if (!SOURCE_FILE.test(f) || /^(test|tests|__tests__|docs?|examples?)\//.test(f) || /\.d\.ts$/.test(f)) continue;
    const after = fs.readFileSync(path.join(newDir, f), 'utf8');
    const before = oldFiles.has(f) ? fs.readFileSync(path.join(oldDir, f), 'utf8') : '';
    for (const d of DANGEROUS) {
      const n = (after.match(new RegExp(d.rx.source, 'g')) || []).length;
      const o = (before.match(new RegExp(d.rx.source, 'g')) || []).length;
      if (n > o) dangerous.push(`${f}: ${d.name} usage ${o} -> ${n}`);
    }
  }
  return { added, removed, changed, depChanges, scriptChanges, dangerous, oldVersion: oldPkg.version || '', newVersion: newPkg.version || '' };
}

function daysBetween(a, b) { return Math.round((b - a) / 86400000 * 10) / 10; }

/**
 * Every check for one spec against the registry: { report: [lines], flags: [red flags], facts }.
 */
async function assess(spec, { registry, repoDir, now = Date.now() }) {
  const report = [];
  const flags = [];
  const packument = await registry.packument(spec.name);
  if (!packument || !packument.versions || !packument.versions[spec.version]) {
    flags.push(`${spec.raw}: not in the registry`);
    return { report: [`${spec.raw}: not in the registry`], flags, facts: {} };
  }
  const doc = packument.versions[spec.version];
  const installedDir = installedPackageDir(repoDir, spec.name);
  const installedVersion = installedDir ? readJson(path.join(installedDir, 'package.json'), {}).version : '';
  const prevDoc = installedVersion && packument.versions[installedVersion] ? packument.versions[installedVersion] : null;
  const publishedAt = packument.time && packument.time[spec.version] ? Date.parse(packument.time[spec.version]) : NaN;
  const ageDays = Number.isFinite(publishedAt) ? daysBetween(publishedAt, now) : null;
  report.push(`== ${spec.raw}  (installed: ${installedVersion || 'not installed'})`);
  report.push(`   published ${packument.time && packument.time[spec.version] ? packument.time[spec.version] : 'unknown'}${ageDays !== null ? ` (${ageDays} days old${ageDays < 7 ? ', younger than min-release-age' : ''})` : ''}`);

  // the publisher
  const publisher = publisherOf(doc), prevPublisher = publisherOf(prevDoc);
  report.push(`   publisher ${publisher || 'unknown'}${prevDoc ? ` (installed ${installedVersion}: ${prevPublisher || 'unknown'})` : ''}`);
  if (prevDoc && publisher !== prevPublisher) flags.push(`${spec.raw}: the publisher changed: "${prevPublisher}" -> "${publisher}"`);

  // signatures
  const sigs = (doc.dist && Array.isArray(doc.dist.signatures)) ? doc.dist.signatures : [];
  report.push(`   dist.signatures ${sigs.length ? `${sigs.length} (${sigs.map((s) => s.keyid).join(', ')})` : 'NONE'}`);
  if (!sigs.length) flags.push(`${spec.raw}: no registry signature on the tarball`);

  // provenance
  const prov = provenanceOf(await registry.attestations(spec.name, spec.version));
  const prevProv = prevDoc ? provenanceOf(await registry.attestations(spec.name, installedVersion)) : null;
  const pkgRepo = repoSlug(doc.repository);
  if (prov) {
    const provRepo = repoSlug(prov.repository);
    report.push(`   provenance ${prov.repository || 'unreadable'} ${prov.ref} ${prov.workflow} (builder ${prov.builder || '?'})`);
    if (!pkgRepo || provRepo !== pkgRepo) flags.push(`${spec.raw}: the provenance repository (${prov.repository || '?'}) is not the package's (${(doc.repository && doc.repository.url) || doc.repository || '?'})`);
  } else {
    report.push(`   provenance none${prevProv ? ' (the installed version HAD provenance)' : ''}`);
    if (prevProv) flags.push(`${spec.raw}: no SLSA provenance where ${installedVersion} had it`);
  }

  // the tarball against the installed copy
  const newDir = await registry.unpack(spec.name, spec.version);
  const d = diffPackages(installedDir, newDir);
  report.push(`   files: ${d.changed.length} changed, ${d.added.length} added, ${d.removed.length} removed${installedDir ? '' : ' (no installed copy to compare: every file counts as added)'}`);
  for (const f of d.changed) report.push(`     ~ ${f}`);
  for (const f of d.added) report.push(`     + ${f}`);
  for (const f of d.removed) report.push(`     - ${f}`);
  for (const c of d.depChanges) { report.push(`   dependency change: ${c}`); flags.push(`${spec.raw}: dependency change (${c})`); }
  for (const c of d.scriptChanges) { report.push(`   install script: ${c}`); flags.push(`${spec.raw}: new or changed install script (${c})`); }
  for (const c of d.dangerous) { report.push(`   new usage: ${c}`); flags.push(`${spec.raw}: new ${c}`); }
  return { report, flags, facts: { installedVersion, publisher, prevPublisher, ageDays, provenance: prov, signatures: sigs.length, integrity: doc.dist && doc.dist.integrity, diff: d, direct: directField(repoDir, spec.name) } };
}

/** 'dependencies' | 'devDependencies' | null (a transitive dependency) */
function directField(repoDir, name) {
  const pkg = readJson(path.join(repoDir, 'package.json'), {});
  if ((pkg.dependencies || {})[name]) return 'dependencies';
  if ((pkg.devDependencies || {})[name]) return 'devDependencies';
  return null;
}

// ---------------------------------------------------------------------------
// the install and what follows it
// ---------------------------------------------------------------------------
function npmrcHasAge(repoDir) {
  const text = fs.existsSync(path.join(repoDir, '.npmrc')) ? fs.readFileSync(path.join(repoDir, '.npmrc'), 'utf8') : '';
  return /^\s*min-release-age\s*=\s*7\s*$/m.test(text);
}

function lockPackages(repoDir) {
  return (readJson(path.join(repoDir, 'package-lock.json'), {}).packages) || {};
}

/** The lockfile entries that differ between two package maps. */
function lockDiff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const k of keys) {
    const a = JSON.stringify(before[k] || null), b = JSON.stringify(after[k] || null);
    if (a !== b) changed.push(k);
  }
  return changed.sort();
}

/** The lock entries a spec may change: its own paths (hoisted or nested) and the root entry (overrides / the dependency field). */
function allowedLockKeys(specs) {
  return (key) => key === '' || specs.some((s) => key === `node_modules/${s.name}` || key.endsWith(`/node_modules/${s.name}`));
}

function run(exec, cmd, args, opts) {
  return exec(cmd, args, opts);
}

function defaultExec(repoDir) {
  return (cmd, args, { allowFailure = false, capture = false } = {}) => {
    const r = spawnSync(cmd, args, { cwd: repoDir, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: { ...process.env, NPM_CONFIG_FUND: 'false' } });
    if (r.status !== 0 && !allowFailure) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})${capture ? `\n${(r.stderr || '').slice(-600)}` : ''}`);
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

function installSpecs(specs, assessments, { repoDir, exec }) {
  const pkgPath = path.join(repoDir, 'package.json');
  const pkg = readJson(pkgPath, {});
  const direct = [];
  let overridesChanged = false;
  for (const s of specs) {
    const field = assessments[s.raw].facts.direct;
    if (field) direct.push({ spec: s, field });
    else {
      pkg.overrides = pkg.overrides || {};
      pkg.overrides[s.name] = `^${s.version}`;
      overridesChanged = true;
    }
  }
  if (overridesChanged) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  for (const field of ['dependencies', 'devDependencies']) {
    const names = direct.filter((d) => d.field === field).map((d) => `${d.spec.name}@^${d.spec.version}`);
    if (names.length) run(exec, 'npm', ['install', ...names, field === 'devDependencies' ? '--save-dev' : '--save', '--min-release-age=0']);
  }
  if (overridesChanged) run(exec, 'npm', ['install', '--min-release-age=0']);
}

function reinstallTestOnly({ repoDir, exec }) {
  const lockPath = path.join(repoDir, 'package-lock.json');
  const before = fs.readFileSync(lockPath, 'utf8');
  const locked = (lockPackages(repoDir)['node_modules/playwright-core'] || {}).version;
  const pw = locked ? `playwright-core@${locked}` : 'playwright-core';
  run(exec, 'npm', ['install', '--no-save', 'jsdom', 'fake-indexeddb', pw]);
  const after = fs.readFileSync(lockPath, 'utf8');
  if (after !== before) { fs.writeFileSync(lockPath, before); return { restored: true, pw }; }
  return { restored: false, pw };
}

function auditNote({ repoDir, specs, reason, assessments, results, now = new Date() }) {
  const file = path.join(repoDir, 'docs', 'security', 'urgent-updates.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const head = fs.existsSync(file) ? '' : '# Urgent dependency updates\n\nEvery run of `npm run deps:urgent` (scripts/urgent-dep-update.cjs): a dependency installed past `.npmrc`\'s `min-release-age` on the user\'s explicit request, with the checks that were run first.\n';
  const lines = [head, `## ${now.toISOString().slice(0, 10)} - ${specs.map((s) => s.raw).join(', ')}`, '', `Reason: ${reason}`, ''];
  for (const s of specs) {
    const a = assessments[s.raw];
    const f = a.facts;
    lines.push(`- ${s.raw}: installed ${f.installedVersion || 'none'} -> ${s.version}, ${f.ageDays !== null && f.ageDays !== undefined ? `${f.ageDays} days old` : 'age unknown'}, publisher ${f.publisher || '?'}${f.prevPublisher && f.prevPublisher !== f.publisher ? ` (was ${f.prevPublisher})` : ''}, signatures ${f.signatures || 0}, provenance ${f.provenance ? f.provenance.repository + ' ' + f.provenance.ref : 'none'}, files ${f.diff ? `${f.diff.changed.length} changed / ${f.diff.added.length} added / ${f.diff.removed.length} removed` : '?'}${a.flags.length ? `; FLAGS: ${a.flags.join('; ')}` : ''}`);
  }
  lines.push('', `Checks after the install: ${results.join('; ')}`, '');
  fs.appendFileSync(file, lines.join('\n') + '\n');
  return file;
}

function commitMessage(specs, reason, assessments) {
  const title = `Security: ${specs.map((s) => s.raw).join(', ')} (${reason})`;
  const body = specs.map((s) => { const f = assessments[s.raw].facts; return `${s.name} ${f.installedVersion || 'none'} -> ${s.version}: ${f.ageDays !== null && f.ageDays !== undefined ? `${f.ageDays} days old, ` : ''}publisher ${f.publisher || '?'}, ${f.signatures || 0} signature(s), provenance ${f.provenance ? f.provenance.repository : 'none'}, ${f.diff ? f.diff.changed.length + ' file(s) changed' : ''}.`; }).join('\n');
  return `${title}\n\nInstalled past .npmrc's min-release-age=7 on the user's request (scripts/urgent-dep-update.cjs); the\nchecks are in docs/security/urgent-updates.md.\n${body}`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(argv, deps = {}) {
  const repoDir = deps.repoDir || path.resolve(__dirname, '..');
  const log = deps.log || ((s) => process.stdout.write(s + '\n'));
  const exec = deps.exec || defaultExec(repoDir);
  const registry = deps.registry || realRegistry(repoDir);
  const now = deps.now || Date.now();
  const args = parseArgs(argv);
  if (args.errors.length) {
    for (const e of args.errors) log(`refused: ${e}`);
    log('usage: npm run deps:urgent -- <name@x.y.z> [...] --reason "<GHSA / CVE ...>" [--dry-run] [--force]');
    return { ok: false, refused: true, errors: args.errors, installed: false };
  }
  if (!npmrcHasAge(repoDir)) { log('refused: .npmrc does not carry min-release-age=7 (this script only bypasses it for the named packages)'); return { ok: false, refused: true, installed: false }; }

  const assessments = {};
  const flags = [];
  for (const s of args.specs) {
    const a = await assess(s, { registry, repoDir, now });
    assessments[s.raw] = a;
    for (const line of a.report) log(line);
    flags.push(...a.flags);
  }
  if (flags.length) {
    log('');
    for (const f of flags) log(`RED FLAG: ${f}`);
    if (!args.force) { log(`stopped: ${flags.length} red flag(s); re-run with --force only after reading them`); return { ok: false, flags, assessments, installed: false }; }
    log('--force given: going on despite the red flags');
  } else log('\nno red flag');
  if (args.dryRun) { log('--dry-run: nothing installed'); return { ok: true, flags, assessments, installed: false, dryRun: true }; }

  const lockBefore = lockPackages(repoDir);
  installSpecs(args.specs, assessments, { repoDir, exec });
  const results = [];
  if (!npmrcHasAge(repoDir)) throw new Error('.npmrc lost min-release-age=7 during the install: restore it before anything else');
  results.push('.npmrc still min-release-age=7');

  const lockAfter = lockPackages(repoDir);
  const changed = lockDiff(lockBefore, lockAfter);
  const allowed = allowedLockKeys(args.specs);
  const unexpected = changed.filter((k) => !allowed(k));
  if (unexpected.length) throw new Error(`the lockfile changed outside the named packages: ${unexpected.join(', ')}`);
  for (const s of args.specs) {
    const entry = lockAfter[`node_modules/${s.name}`] || Object.entries(lockAfter).find(([k]) => k.endsWith(`/node_modules/${s.name}`))?.[1];
    const want = assessments[s.raw].facts.integrity;
    if (!entry || entry.version !== s.version) throw new Error(`${s.raw} is not what the lockfile holds (${entry ? entry.version : 'missing'})`);
    if (want && entry.integrity !== want) throw new Error(`${s.raw}: the lockfile integrity differs from the registry's`);
  }
  results.push(`lockfile: ${changed.length} entr${changed.length === 1 ? 'y' : 'ies'} changed, all the named packages' own, integrity = registry`);

  const audit = run(exec, 'npm', ['audit', '--json'], { allowFailure: true, capture: true });
  let vulns = null;
  try { vulns = JSON.parse(audit.stdout || '{}').metadata.vulnerabilities.total; } catch { vulns = null; }
  results.push(`npm audit: ${vulns === null ? 'unreadable' : vulns + ' vulnerabilit' + (vulns === 1 ? 'y' : 'ies')}`);
  const sig = run(exec, 'npm', ['audit', 'signatures'], { allowFailure: true, capture: true });
  results.push(`npm audit signatures: ${sig.status === 0 ? 'ok' : 'FAILED'}`);
  const testOnly = reinstallTestOnly({ repoDir, exec });
  results.push(`test-only packages reinstalled (${testOnly.pw})${testOnly.restored ? ', the lockfile they touched was restored' : ', lockfile untouched'}`);

  const note = auditNote({ repoDir, specs: args.specs, reason: args.reason, assessments, results, now: new Date(now) });
  log('');
  for (const r of results) log(`after the install: ${r}`);
  log(`note appended to ${path.relative(repoDir, note)}`);
  log('\nsuggested commit message:\n');
  log(commitMessage(args.specs, args.reason, assessments));
  return { ok: vulns === 0 && sig.status === 0, flags, assessments, installed: true, results, vulns, signatures: sig.status === 0 };
}

module.exports = { parseArgs, assess, diffPackages, provenanceOf, publisherOf, repoSlug, lockDiff, allowedLockKeys, installSpecs, reinstallTestOnly, auditNote, commitMessage, npmrcHasAge, main, DANGEROUS, INSTALL_SCRIPTS };

if (require.main === module) {
  main(process.argv.slice(2)).then((r) => { process.exit(r.ok ? 0 : 1); }).catch((e) => { console.error(e.message || e); process.exit(1); });
}
