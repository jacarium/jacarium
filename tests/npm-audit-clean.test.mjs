/**
 * Guards the dependency hygiene of the root app: `npm audit` reports no
 * high or critical vulnerability, and the lock file resolves
 * http-cache-semantics to 4.3.0 or later (GHSA-ch52-4w7c-c8xp, reached
 * through electron-builder > @electron/get > got > cacheable-request; the
 * fix stays inside package-lock.json - no override, no electron-builder
 * bump). The audit needs the npm registry: skips cleanly offline.
 * Run: node tests/npm-audit-clean.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 240) : ''}`); if (!ok) failed++; };
const atLeast = (version, wanted) => { const a = version.split('.').map(Number); const b = wanted.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); } return true; };

// the lock file, offline: every resolution of http-cache-semantics is fixed
const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
const resolutions = Object.entries(lock.packages || {}).filter(([k]) => /(^|\/)node_modules\/http-cache-semantics$/.test(k)).map(([k, v]) => `${k}@${v.version}`);
check('package-lock.json resolves http-cache-semantics to 4.3.0 or later everywhere (GHSA-ch52-4w7c-c8xp)', resolutions.length > 0 && resolutions.every((r) => atLeast(r.split('@').pop(), '4.3.0')), resolutions.join(', '));

// the audit itself (registry needed)
const r = spawnSync('npm', ['audit', '--json', '--audit-level=high'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
let report = null;
try { report = JSON.parse(r.stdout || '{}'); } catch { report = null; }
if (!report || !report.metadata || (report.error && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network/i.test(JSON.stringify(report.error)))) {
  console.log(`SKIP: npm audit could not reach the registry (${(r.stderr || '').trim().slice(0, 120) || 'no report'})`);
} else {
  const v = report.metadata.vulnerabilities || {};
  check('npm audit: no high or critical vulnerability in the root app', (v.high || 0) === 0 && (v.critical || 0) === 0, JSON.stringify(v));
  const named = Object.entries(report.vulnerabilities || {}).filter(([, x]) => x.severity === 'high' || x.severity === 'critical').map(([n, x]) => `${n} (${x.severity}, ${x.range})`);
  if (named.length) console.log('  ' + named.join('\n  '));
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
