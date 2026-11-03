/**
 * The npm audit gate of the root app and of jacarium-central, in two tiers:
 *
 *   1. the shipped product - `npm audit --omit=dev`: what goes into the
 *      installers and the container image must have NOTHING at Moderate or
 *      above (a Low is reported, not failing);
 *   2. the whole tree, dev included - `npm audit`: nothing High or Critical
 *      anywhere; a Moderate or Low that exists only in the build / lint /
 *      test tooling is printed every run - advisory, package@version, the
 *      dependency path from the root, whether the lock marks it dev - but
 *      does not fail (OSV-Scanner on GitHub still sees it in the lock file,
 *      where a VEX decision in vex/decisions.yaml answers it, as with
 *      minimatch; the list says whether one exists).
 *
 * Dev-only means: the full audit reports the advisory for the package and the
 * `--omit=dev` audit does not. A package in both trees counts as shipped. The
 * classification is cross-checked against `npm ls --omit=dev <package>` for
 * one listed package, and the rules are exercised offline against fixture
 * reports (a Moderate in a shipped package fails, a High in a dev package
 * fails, a Moderate in a dev package passes and is listed).
 *
 * Also kept, offline: the lock file resolves http-cache-semantics to 4.3.0 or
 * later (GHSA-ch52-4w7c-c8xp through electron-builder > @electron/get > got >
 * cacheable-request; the fix stays inside package-lock.json - no override, no
 * electron-builder bump), and the minimatch override (GHSA-g3hv-75wg-m249)
 * stays targeted and exact: the 9.x / 10.x copies are 11.0.3, glob 7's 3.1.5
 * and filelist's 5.1.9 untouched (minimatch 11 removed what glob 7 reads).
 *
 * The audits need the npm registry: a project's audit checks skip cleanly
 * offline; the lock, override, `npm ls` and fixture checks run regardless.
 * Run: node tests/npm-audit-clean.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 600) : ''}`); if (!ok) failed++; };
const parseVersion = (v) => String(v).split('-')[0].split('.').map((x) => Number(x) || 0);
const cmp = (a, b) => { const x = parseVersion(a), y = parseVersion(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1; return 0; };
const atLeast = (version, wanted) => cmp(version, wanted) >= 0;
const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

// ---------------------------------------------------------------------------
// the lock file as a graph: every resolved copy of a package, and the path from the root to a lock entry
// ---------------------------------------------------------------------------
const copiesOf = (lock, name) => Object.entries(lock.packages || {}).filter(([k]) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`)).map(([k, v]) => ({ key: k, version: v.version, dev: v.dev === true }));
const entryName = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
/** the lock entry `name` resolves to from `from` (npm's nesting: the nearest node_modules walking up) */
function resolveFrom(lock, from, name) {
  let base = from;
  for (;;) {
    const cand = `${base ? base + '/' : ''}node_modules/${name}`;
    if (lock.packages[cand]) return cand;
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i === -1 ? '' : base.slice(0, i);
  }
}
/** the shortest dependency path from the root to `target`, as names ('a > b > c'); '' when unreachable */
function depPath(lock, target) {
  const seen = new Map([['', null]]);
  const queue = [''];
  while (queue.length) {
    const key = queue.shift();
    if (key === target) {
      const names = [];
      for (let k = key; k; k = seen.get(k)) names.unshift(entryName(k));
      return names.join(' > ');
    }
    const entry = lock.packages[key] || {};
    const deps = { ...(entry.dependencies || {}), ...(entry.optionalDependencies || {}), ...(key === '' ? (entry.devDependencies || {}) : {}) };
    for (const name of Object.keys(deps)) {
      const next = resolveFrom(lock, key, name);
      if (next && !seen.has(next)) { seen.set(next, key); queue.push(next); }
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// the two-tier rule over a full audit report, the --omit=dev report and the lock (pure: the fixtures run it too)
// ---------------------------------------------------------------------------
const advisoryId = (via) => (via.url || '').split('/').pop() || String(via.source || via.title || '');
/** every (advisory, package) the report names directly: the entries whose `via` carries advisory objects */
function advisoriesOf(report) {
  const out = [];
  for (const [name, x] of Object.entries(report.vulnerabilities || {})) {
    for (const via of x.via || []) {
      if (typeof via !== 'object') continue;   // a string names the dependency a finding comes through: its advisory is on that package's own entry
      out.push({ id: advisoryId(via), name, severity: via.severity || x.severity, range: via.range || '', title: via.title || '', nodes: x.nodes || [] });
    }
  }
  return out;
}
/**
 * { failures, listed }: failures are the strings that fail the gate; listed is every finding (advisory, copy,
 * path, tier) for the report. Shipped = named by the --omit=dev audit for the same package.
 */
function evaluate({ full, prod, lock, vexNotAffected = new Set() }) {
  const failures = [];
  const listed = [];
  const shippedKeys = new Set(advisoriesOf(prod).map((a) => `${a.id} ${a.name}`));
  for (const a of advisoriesOf(full)) {
    const shipped = shippedKeys.has(`${a.id} ${a.name}`);
    const rank = RANK[a.severity] || 0;
    const nodes = a.nodes.length ? a.nodes : copiesOf(lock, a.name).map((c) => c.key);
    for (const node of nodes) {
      const entry = (lock.packages || {})[node] || {};
      const item = { id: a.id, severity: a.severity, name: a.name, version: entry.version || '?', node, path: depPath(lock, node) || node, lockDev: entry.dev === true, shipped, vex: vexNotAffected.has(a.id) };
      listed.push(item);
    }
    if (shipped && rank >= RANK.moderate) failures.push(`${a.id} (${a.severity}) in the SHIPPED tree: ${a.name} ${a.range} - the product must have nothing at moderate or above`);
    else if (!shipped && rank >= RANK.high) failures.push(`${a.id} (${a.severity}) in a dev-only package: ${a.name} ${a.range} - nothing high or critical anywhere in the tree`);
  }
  return { failures, listed };
}
const describe = (item) => `${item.id} ${item.severity}  ${item.name}@${item.version}  ${item.path}  [${item.shipped ? 'SHIPPED' : 'dev-only'}${item.lockDev ? ', lock: dev' : item.shipped ? '' : ', lock: NOT marked dev'}${item.vex ? '; VEX not_affected' : '; no VEX decision - OSV-Scanner on GitHub flags it'}]`;

/** the not_affected ids of vex/decisions.yaml (one-line fields; no YAML library) */
function vexNotAffectedIds() {
  const ids = new Set();
  let text = '';
  try { text = fs.readFileSync(path.join(REPO, 'vex', 'decisions.yaml'), 'utf8'); } catch { return ids; }
  for (const block of text.split(/\n(?=  - id: )/)) {
    const id = /^  - id: (\S+)/.exec(block);
    if (!id || !/^    status: not_affected\s*$/m.test(block)) continue;
    ids.add(id[1]);
    const aliases = /^    aliases: \[(.*)\]/m.exec(block);
    if (aliases) for (const a of aliases[1].split(',')) ids.add(a.trim());
  }
  return ids;
}

/** `npm audit --json` (with extra args) in `dir`: the report, or null when the registry is unreachable */
function audit(dir, extra = []) {
  const r = spawnSync('npm', ['audit', '--json', ...extra], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  let report = null;
  try { report = JSON.parse(r.stdout || '{}'); } catch { report = null; }
  if (!report || !report.metadata || (report.error && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network/i.test(JSON.stringify(report.error)))) return { report: null, why: (r.stderr || '').trim().slice(0, 120) || 'no report' };
  return { report };
}

// ---------------------------------------------------------------------------
// 1. the fixture reports (offline): the rule itself
// ---------------------------------------------------------------------------
{
  const lock = { packages: {
    '': { dependencies: { express: '^5' }, devDependencies: { eslint: '^10' } },
    'node_modules/express': { version: '5.0.0', dependencies: { qs: '^6' } },
    'node_modules/qs': { version: '6.0.0' },
    'node_modules/eslint': { version: '10.0.0', dev: true, dependencies: { minimatch: '^10' } },
    'node_modules/minimatch': { version: '10.2.6', dev: true },
  } };
  const adv = (name, severity, id, range) => ({ name, severity, isDirect: false, via: [{ source: 1, name, dependency: name, title: 't', url: `https://github.com/advisories/${id}`, severity, range }], effects: [], range, nodes: [`node_modules/${name}`], fixAvailable: false });
  const chain = (name, severity, via) => ({ name, severity, isDirect: true, via: [via], effects: [], range: '*', nodes: [`node_modules/${name}`], fixAvailable: false });
  const meta = (n) => ({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: n } } });

  // a Moderate in a shipped package (qs, under express) - reported by both audits: fails
  const prodModerate = { ...meta(2), vulnerabilities: { qs: adv('qs', 'moderate', 'GHSA-TEST-0001', '<6.1.0'), express: chain('express', 'moderate', 'qs') } };
  const r1 = evaluate({ full: prodModerate, prod: prodModerate, lock });
  check('fixture: a Moderate in a production dependency (qs under express) fails the shipped tier', r1.failures.length === 1 && /GHSA-TEST-0001 \(moderate\) in the SHIPPED tree: qs/.test(r1.failures[0]) && r1.listed[0].path === 'express > qs' && r1.listed[0].shipped, JSON.stringify(r1));
  // a High in a dev package (minimatch under eslint) - only the full audit reports it: fails
  const devHigh = { ...meta(2), vulnerabilities: { minimatch: adv('minimatch', 'high', 'GHSA-TEST-0002', '<11.0.1'), eslint: chain('eslint', 'high', 'minimatch') } };
  const r2 = evaluate({ full: devHigh, prod: meta(0), lock });
  check('fixture: a High in a dev-only dependency (minimatch under eslint) fails the whole-tree tier', r2.failures.length === 1 && /GHSA-TEST-0002 \(high\) in a dev-only package: minimatch/.test(r2.failures[0]) && r2.listed[0].path === 'eslint > minimatch' && !r2.listed[0].shipped && r2.listed[0].lockDev, JSON.stringify(r2));
  // a Moderate in a dev package - only the full audit reports it: passes, listed
  const devModerate = { ...meta(2), vulnerabilities: { minimatch: adv('minimatch', 'moderate', 'GHSA-TEST-0003', '<11.0.1'), eslint: chain('eslint', 'moderate', 'minimatch') } };
  const r3 = evaluate({ full: devModerate, prod: meta(0), lock });
  check('fixture: a Moderate in a dev-only dependency passes and is listed with its path, marked dev-only', r3.failures.length === 0 && r3.listed.length === 1 && r3.listed[0].path === 'eslint > minimatch' && !r3.listed[0].shipped && r3.listed[0].lockDev && /dev-only, lock: dev/.test(describe(r3.listed[0])), JSON.stringify(r3));
  // the same advisory in both trees counts as shipped
  const both = { ...meta(1), vulnerabilities: { qs: adv('qs', 'low', 'GHSA-TEST-0004', '<6.1.0') } };
  const r4 = evaluate({ full: both, prod: both, lock });
  check('fixture: a Low in a shipped package is reported as SHIPPED, not failing', r4.failures.length === 0 && r4.listed.length === 1 && r4.listed[0].shipped, JSON.stringify(r4));
}

// ---------------------------------------------------------------------------
// 2. the root app: the lock guards (offline), then the two audits
// ---------------------------------------------------------------------------
const rootLock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
{
  const hcs = copiesOf(rootLock, 'http-cache-semantics');
  check('root: package-lock.json resolves http-cache-semantics to 4.3.0 or later everywhere (GHSA-ch52-4w7c-c8xp)', hcs.length > 0 && hcs.every((c) => atLeast(c.version, '4.3.0')), hcs.map((c) => `${c.key}@${c.version}`).join(', '));
  const mm = copiesOf(rootLock, 'minimatch');
  const mmOverride = rootPkg.overrides && rootPkg.overrides['minimatch@>=9.0.0'];
  check('root: package.json overrides minimatch@>=9.0.0 to exactly 11.0.3 (the security-lane install of 2026-11-03; a range would float to a version younger than the lane allows)', mmOverride === '11.0.3', JSON.stringify(mmOverride));
  check('root: every minimatch copy from the 9.x / 10.x lines is 11.0.3, and the 3.x / 5.x copies glob 7, dir-compare and filelist read are untouched', mm.length > 0 && mm.every((c) => c.version === '11.0.3' || c.version.startsWith('3.') || c.version.startsWith('5.')) && mm.some((c) => c.version === '11.0.3'), mm.map((c) => `${c.key}@${c.version}`).join(', '));
  check('root: every minimatch copy is a dev dependency in the lock (nothing shipped uses it)', mm.length > 0 && mm.every((c) => c.dev), mm.filter((c) => !c.dev).map((c) => c.key).join(', '));
}

const vex = vexNotAffectedIds();
function auditProject(label, dir, lock) {
  const full = audit(dir);
  const prod = audit(dir, ['--omit=dev']);
  if (!full.report || !prod.report) { console.log(`SKIP: ${label}: npm audit could not reach the registry (${full.why || prod.why})`); return null; }
  const f = full.report.metadata.vulnerabilities || {}, p = prod.report.metadata.vulnerabilities || {};
  console.log(`${label}: npm audit --omit=dev ${JSON.stringify(p)}; npm audit ${JSON.stringify(f)}`);
  const { failures, listed } = evaluate({ full: full.report, prod: prod.report, lock, vexNotAffected: vex });
  check(`${label}: the shipped tree (--omit=dev) has nothing at moderate or above`, (p.moderate || 0) === 0 && (p.high || 0) === 0 && (p.critical || 0) === 0 && !failures.some((x) => / in the SHIPPED tree/.test(x)), failures.filter((x) => / in the SHIPPED tree/.test(x)).join(' || '));
  check(`${label}: the whole tree (dev included) has nothing high or critical`, (f.high || 0) === 0 && (f.critical || 0) === 0 && !failures.some((x) => / in a dev-only package/.test(x)), failures.filter((x) => / in a dev-only package/.test(x)).join(' || '));
  const shippedLow = listed.filter((x) => x.shipped);
  const devOnly = listed.filter((x) => !x.shipped);
  if (shippedLow.length) { console.log(`  ${label}: shipped findings below moderate (reported, not failing):`); for (const x of shippedLow) console.log(`    ${describe(x)}`); }
  console.log(`  ${label}: dev-only findings (reported, not failing): ${devOnly.length}`);
  for (const x of devOnly) console.log(`    ${describe(x)}`);
  const notMarkedDev = devOnly.filter((x) => !x.lockDev);
  check(`${label}: every dev-only finding sits on a lock entry the lock marks dev (the two audits and the lock agree)`, notMarkedDev.length === 0, notMarkedDev.map(describe).join(' || '));
  return { listed, devOnly };
}

const root = auditProject('root', REPO, rootLock);
if (root && root.devOnly.length) {
  // the classification against npm's own production tree, for one listed package (minimatch when it is there)
  const name = (root.devOnly.find((x) => x.name === 'minimatch') || root.devOnly[0]).name;
  const r = spawnSync('npm', ['ls', '--omit=dev', name, '--json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  let tree = null;
  try { tree = JSON.parse(r.stdout || '{}'); } catch { tree = null; }
  const inProd = tree && tree.dependencies && Object.keys(tree.dependencies).length > 0;
  check(`root: npm ls --omit=dev ${name} agrees that it is not in the production tree`, !!tree && !inProd, tree ? JSON.stringify(tree.dependencies || {}).slice(0, 200) : (r.stderr || '').slice(0, 200));
}

// ---------------------------------------------------------------------------
// 3. jacarium-central: the same two tiers (no devDependencies today, so the two audits coincide)
// ---------------------------------------------------------------------------
{
  const dir = path.join(REPO, 'jacarium-central');
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  auditProject('jacarium-central', dir, lock);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
