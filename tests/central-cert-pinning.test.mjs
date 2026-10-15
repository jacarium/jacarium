/**
 * Guards the trust-on-first-use certificate pinning for the central P2P sync
 * server (electron/central-cert-pins.cjs, used by the 'certificate-error'
 * handler in electron/main.cjs).
 *
 * THE BUG: the central server uses a self-signed certificate, so main.cjs
 * had to intervene in Electron's 'certificate-error' - and it accepted ANY
 * certificate for the configured central host. TLS therefore gave no server
 * identity at all: whoever could answer for that hostname (DNS/ARP spoofing,
 * hostile Wi-Fi, compromised router) could present their own self-signed
 * cert and read every synced document, the pairing secret and Yjs traffic.
 *
 * THE FIX mirrors the backend's SSH known_hosts TOFU model: the first
 * certificate seen for a host is recorded (fingerprint + timestamp) under
 * userData/central-server-cert-pins.json; every later connection must
 * present the same fingerprint or it is rejected and the user is warned
 * with a "may be a machine-in-the-middle; if the server was legitimately
 * reinstalled, trust the new certificate / reset the pin" dialog.
 *
 * What this test proves (real module, temp pin file, plain Node):
 *   - first sighting -> 'pinned', the pin file is created (0600, dir 0700)
 *     and holds the fingerprint;
 *   - same fingerprint again -> 'match' (file unchanged);
 *   - a DIFFERENT fingerprint -> 'mismatch' carrying the expected pin, and
 *     the stored pin is NOT silently replaced;
 *   - updateCertificatePin() (the explicit "trust new certificate" action)
 *     replaces the pin, after which the new fingerprint matches;
 *   - forgetCertificatePin() removes it so the next sighting pins afresh;
 *   - hosts are independent of each other and case/whitespace-normalized;
 *   - a missing/empty fingerprint is 'invalid' (never trusted);
 *   - a corrupt pin file is treated as empty instead of throwing;
 *   - a legacy "host": "fingerprint" string entry is still honored.
 *
 * Run:  node tests/central-cert-pinning.test.mjs
 * Preconditions: none (plain Node, the module has no Electron imports).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  readPins,
  checkCertificatePin,
  updateCertificatePin,
  forgetCertificatePin
} = require(path.join(here, '..', 'electron', 'central-cert-pins.cjs'));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-pins-test-'));
const pinsFile = path.join(workdir, 'nested', 'central-server-cert-pins.json');

const HOST = 'sync.example.test:3443';
const FP_A = 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const FP_B = 'sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

try {
  let r = checkCertificatePin(pinsFile, HOST, FP_A);
  check('first sighting -> pinned', r.decision === 'pinned' && r.fingerprint === FP_A && r.expected === null, JSON.stringify(r));
  check('pin file created', fs.existsSync(pinsFile));
  const stored = readPins(pinsFile);
  check('pin file holds the fingerprint + pinnedAt', stored[HOST] && stored[HOST].fingerprint === FP_A && typeof stored[HOST].pinnedAt === 'string');
  if (process.platform !== 'win32') {
    const fileMode = fs.statSync(pinsFile).mode & 0o777;
    const dirMode = fs.statSync(path.dirname(pinsFile)).mode & 0o777;
    check('pin file is 0600 and its dir 0700', fileMode === 0o600 && dirMode === 0o700, `file=${fileMode.toString(8)} dir=${dirMode.toString(8)}`);
  }

  const before = fs.readFileSync(pinsFile, 'utf8');
  r = checkCertificatePin(pinsFile, HOST, FP_A);
  check('same fingerprint -> match', r.decision === 'match' && r.expected === FP_A, JSON.stringify(r));
  check('match does not rewrite the file', fs.readFileSync(pinsFile, 'utf8') === before);

  r = checkCertificatePin(pinsFile, HOST, FP_B);
  check('different fingerprint -> mismatch with expected pin', r.decision === 'mismatch' && r.expected === FP_A && r.fingerprint === FP_B, JSON.stringify(r));
  check('mismatch does NOT replace the stored pin', readPins(pinsFile)[HOST].fingerprint === FP_A);
  r = checkCertificatePin(pinsFile, HOST, FP_B);
  check('mismatch is stable on retry (still rejected)', r.decision === 'mismatch');

  updateCertificatePin(pinsFile, HOST, FP_B);
  r = checkCertificatePin(pinsFile, HOST, FP_B);
  check('after explicit trust, new fingerprint matches', r.decision === 'match' && r.expected === FP_B);
  r = checkCertificatePin(pinsFile, HOST, FP_A);
  check('after explicit trust, OLD fingerprint now mismatches', r.decision === 'mismatch' && r.expected === FP_B);

  check('forget returns true for a known host', forgetCertificatePin(pinsFile, HOST) === true);
  check('forget returns false for an unknown host', forgetCertificatePin(pinsFile, 'nope.test') === false);
  r = checkCertificatePin(pinsFile, HOST, FP_A);
  check('after forget, next sighting pins afresh', r.decision === 'pinned' && readPins(pinsFile)[HOST].fingerprint === FP_A);

  // Host independence + normalization
  r = checkCertificatePin(pinsFile, 'other.example.test', FP_B);
  check('a second host pins independently', r.decision === 'pinned');
  check('first host unaffected by second host', checkCertificatePin(pinsFile, HOST, FP_A).decision === 'match');
  check('host lookup is case-insensitive', checkCertificatePin(pinsFile, HOST.toUpperCase(), FP_A).decision === 'match');
  check('host lookup trims whitespace', checkCertificatePin(pinsFile, `  ${HOST} `, FP_A).decision === 'match');
  check('fingerprint whitespace is normalized', checkCertificatePin(pinsFile, HOST, ` ${FP_A}\n`).decision === 'match');

  // Never trust without a fingerprint
  check('missing fingerprint -> invalid', checkCertificatePin(pinsFile, HOST, undefined).decision === 'invalid');
  check('empty fingerprint -> invalid', checkCertificatePin(pinsFile, HOST, '').decision === 'invalid');
  check('missing host -> invalid', checkCertificatePin(pinsFile, '', FP_A).decision === 'invalid');
  let threw = false;
  try { updateCertificatePin(pinsFile, HOST, ''); } catch { threw = true; }
  check('updateCertificatePin refuses an empty fingerprint', threw);
  check('invalid inputs did not touch the stored pin', readPins(pinsFile)[HOST].fingerprint === FP_A);

  // Corrupt file -> treated as empty, recovers on next write
  fs.writeFileSync(pinsFile, '{not json');
  check('corrupt pin file reads as {}', JSON.stringify(readPins(pinsFile)) === '{}');
  r = checkCertificatePin(pinsFile, HOST, FP_B);
  check('corrupt pin file: next sighting pins and repairs the file', r.decision === 'pinned' && readPins(pinsFile)[HOST].fingerprint === FP_B);
  fs.writeFileSync(pinsFile, '[1,2,3]');
  check('array pin file reads as {}', JSON.stringify(readPins(pinsFile)) === '{}');

  // Legacy plain-string entry
  fs.writeFileSync(pinsFile, JSON.stringify({ [HOST]: FP_A }));
  check('legacy string entry -> match', checkCertificatePin(pinsFile, HOST, FP_A).decision === 'match');
  check('legacy string entry -> mismatch on other fingerprint', checkCertificatePin(pinsFile, HOST, FP_B).decision === 'mismatch');
} catch (error) {
  check('unexpected error', false, error.stack || String(error));
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
