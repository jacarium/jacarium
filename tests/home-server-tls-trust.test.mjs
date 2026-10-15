/**
 * Guards how the desktop trusts the home server's certificate
 * (electron/tls-trust.cjs, the trusted agent in electron/home-server.cjs,
 * the pin store electron/central-cert-pins.cjs) - the fix for a home
 * server behind Caddy's `tls internal`, whose leaf certificate renews about
 * every 12 hours and whose intermediate about weekly: the desktop used to
 * pin the leaf, so every renewal looked like a changed certificate.
 *
 * A synthetic CA (openssl: root -> intermediate -> leaf, plus an impostor
 * CA with a leaf for the same name) and a local HTTPS server that presents
 * leaf + intermediate only (as Caddy does), serves GET /api/tls/root.crt
 * (or 404) and rotates its certificate without restarting. Proves:
 *   1. first contact: the connection is trusted on first use, the ROOT the
 *      server serves is fetched over that very connection and pinned (type
 *      root) once the presented chain verifies against it; the leaf is not;
 *   2. a renewed leaf from the same CA passes with no prompt; a new
 *      intermediate too (both rotated); the pin file is not rewritten;
 *   3. a chain from another CA for the same name is refused: the request
 *      fails, onPinMismatch gets host, expected (the root's fingerprint),
 *      the presented fingerprint and the reason, nothing is pinned;
 *   4. a 3.1 leaf pin that still matches the presented leaf is upgraded to
 *      the root pin silently; a leaf pin whose leaf already rotated is a
 *      mismatch (asked once), and "trust the new certificate" then pins the
 *      root when the served root verifies the chain (the leaf otherwise);
 *   5. a server that serves no root (404): the leaf is pinned as before,
 *      marked rootUnavailable for Settings; renewals then prompt as in 3.1;
 *   6. a certificate the system trusts (NODE_EXTRA_CA_CERTS carries the
 *      synthetic root in a child process) passes with NO pin written;
 *   7. decideTrust on the shape Electron's 'certificate-error' hands over
 *      (certificate.data / issuerCert) gives the same answers, and the
 *      verifier refuses an expired chain, a wrong host and a leaf alone.
 *
 * Synthetic certificates and keys only, loopback only. Needs openssl.
 * Run: node tests/home-server-tls-trust.test.mjs
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(import.meta.url);
if (spawnSync('openssl', ['version'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: openssl is not installed'); process.exit(0); }
const trust = req(path.join(REPO, 'electron', 'tls-trust.cjs'));
const homeServer = req(path.join(REPO, 'electron', 'home-server.cjs'));
const pins = req(path.join(REPO, 'electron', 'central-cert-pins.cjs'));

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 260) : ''}`); if (!ok) failed++; };

// ---- the synthetic CA ----
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-trust-'));
const ssl = (...args) => execFileSync('openssl', args, { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'] });
const pem = (f) => fs.readFileSync(path.join(WORK, f), 'utf8');
function ca(name, cn, days = 30) {
  ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-sha256', '-days', String(days), '-keyout', `${name}.key`, '-out', `${name}.pem`, '-subj', `/CN=${cn}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
}
function intermediate(name, cn, rootName) {
  ssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`);
  fs.writeFileSync(path.join(WORK, `${name}.ext`), 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
  ssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${rootName}.pem`, '-CAkey', `${rootName}.key`, '-CAcreateserial', '-days', '7', '-sha256', '-extfile', `${name}.ext`, '-out', `${name}.pem`);
}
function leaf(name, issuer, { days = 1, host = 'localhost' } = {}) {
  ssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${host}`);
  fs.writeFileSync(path.join(WORK, `${name}.ext`), `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${host},IP:127.0.0.1\n`);
  ssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-CAcreateserial', '-days', String(days), '-sha256', '-extfile', `${name}.ext`, '-out', `${name}.pem`);
}
ca('root', 'Synthetic Local Authority - Root');
intermediate('int1', 'Synthetic Local Authority - Intermediate 1', 'root');
intermediate('int2', 'Synthetic Local Authority - Intermediate 2', 'root');
leaf('leafA', 'int1'); leaf('leafB', 'int1'); leaf('leafC', 'int2'); leaf('leafOther', 'int1', { host: 'other.example.test' });
ca('evil', 'Impostor Authority');
leaf('evil-leaf', 'evil');
const fpOf = (f) => trust.fingerprintOf(new X509Certificate(pem(f)));

// ---- the server: leaf + intermediate, the root at /api/tls/root.crt, rotating certificates ----
let serveRoot = pem('root.pem');
const hits = [];
const server = https.createServer({ key: fs.readFileSync(path.join(WORK, 'leafA.key')), cert: pem('leafA.pem') + pem('int1.pem') }, (rq, rs) => {
  hits.push(rq.url);
  if (rq.url === '/api/tls/root.crt') { if (!serveRoot) { rs.statusCode = 404; return rs.end('{"error":"no root"}'); } rs.setHeader('Content-Type', 'application/x-pem-file'); return rs.end(serveRoot); }
  rs.setHeader('Content-Type', 'application/json'); rs.end(JSON.stringify({ app: '3.1.1', protocol: 2, path: rq.url, authorization: rq.headers.authorization || null }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `https://localhost:${PORT}`;
const HOST = `localhost:${PORT}`;
const present = (leafName, intName) => server.setSecureContext({ key: fs.readFileSync(path.join(WORK, `${leafName}.key`)), cert: pem(`${leafName}.pem`) + (intName ? pem(`${intName}.pem`) : '') });
const pinsPath = path.join(WORK, 'profile', 'central-server-cert-pins.json');
const mismatches = [];
const ctx = { pinsPath, onPinMismatch: (r) => mismatches.push(r) };
const request = async (p = '/api/version') => { try { const r = await homeServer.serverRequest(BASE, p, ctx); return { ok: r.status === 200, status: r.status }; } catch (e) { return { ok: false, error: e.message }; } };
const entry = () => pins.readPins(pinsPath)[HOST];

try {
  // ---- 1. first contact ----
  let r = await request();
  check('1. first contact succeeds (trusted on first use)', r.ok, JSON.stringify(r));
  check('1. ...the root was fetched over that connection and pinned (type root), not the leaf', entry()?.type === 'root' && entry().fingerprint === fpOf('root.pem') && /BEGIN CERTIFICATE/.test(entry().rootPem || '') && hits.includes('/api/tls/root.crt'), JSON.stringify({ type: entry()?.type, fp: entry()?.fingerprint?.slice(0, 20) }));
  check('1. the pin file is private (0600)', (fs.statSync(pinsPath).mode & 0o777) === 0o600);
  // ---- 2. renewals ----
  const fileBefore = fs.readFileSync(pinsPath, 'utf8');
  present('leafB', 'int1');
  r = await request();
  check('2. a renewed leaf from the same CA passes with no prompt', r.ok && mismatches.length === 0, JSON.stringify(r));
  present('leafC', 'int2');
  r = await request('/api/auth/me');
  check('2. a new intermediate AND leaf (both rotated) pass too', r.ok && mismatches.length === 0, JSON.stringify(r));
  check('2. ...and the pin file was not rewritten', fs.readFileSync(pinsPath, 'utf8') === fileBefore);
  check('2. the root was fetched once (first contact), never again', hits.filter((h) => h === '/api/tls/root.crt').length === 1, hits.join(','));
  // ---- 3. impostor ----
  present('evil-leaf');
  const hitsBefore = hits.length;
  r = await request('/api/auth/me');
  check('3. a chain from another CA is refused: the request fails before anything is sent', !r.ok && /not the one recorded/.test(r.error || '') && hits.length === hitsBefore, JSON.stringify(r));
  check('3. ...onPinMismatch got host, the pinned root as expected, the presented fingerprint and the reason', mismatches.length === 1 && mismatches[0].host === HOST && mismatches[0].expected === fpOf('root.pem') && mismatches[0].fingerprint === fpOf('evil-leaf.pem') && /does not end at the pinned root/.test(mismatches[0].reason) && mismatches[0].url === BASE, JSON.stringify(mismatches[0] && { ...mismatches[0], chain: undefined, rootPem: undefined }));
  check('3. ...and the pin is untouched', entry()?.type === 'root' && entry().fingerprint === fpOf('root.pem'));
  present('leafOther', 'int1');
  r = await request();
  check('3. a certificate of the right CA for another name is refused as well', !r.ok && /not for localhost/.test(mismatches[mismatches.length - 1]?.reason || ''), mismatches[mismatches.length - 1]?.reason);
  mismatches.length = 0;
  // ---- 4. the 3.1 leaf pin ----
  present('leafA', 'int1');
  pins.updateCertificatePin(pinsPath, HOST, fpOf('leafA.pem'));   // what 3.0/3.1 recorded
  r = await request();
  check('4. a leaf pin that still matches is upgraded to the root pin silently', r.ok && mismatches.length === 0 && entry()?.type === 'root' && entry().fingerprint === fpOf('root.pem'), JSON.stringify({ r, type: entry()?.type }));
  fs.writeFileSync(pinsPath, JSON.stringify({ [HOST]: { fingerprint: fpOf('leafA.pem'), pinnedAt: '2026-01-01T00:00:00.000Z' } }));
  present('leafB', 'int1');
  r = await request();
  check('4. a leaf pin whose leaf already rotated is a mismatch (asked once), nothing changed', !r.ok && mismatches.length === 1 && mismatches[0].kind === 'leaf' && mismatches[0].expected === fpOf('leafA.pem') && entry()?.fingerprint === fpOf('leafA.pem') && !entry()?.type, JSON.stringify(mismatches[0] && { kind: mismatches[0].kind }));
  const trusted = await homeServer.trustPresented({ pinsPath, host: HOST, url: mismatches[0].url, chain: mismatches[0].chain, fingerprint: mismatches[0].fingerprint });
  r = await request();
  check('4. "trust the new certificate" pins the served root (the chain verifies against it) and the request works', trusted.type === 'root' && entry()?.type === 'root' && r.ok, JSON.stringify({ trusted: trusted.type, r }));
  mismatches.length = 0;
  // ---- 5. no root served ----
  serveRoot = '';
  fs.writeFileSync(pinsPath, '{}');
  r = await request();
  check('5. with no root served (404) the leaf is pinned as before, marked rootUnavailable', r.ok && !entry()?.type && entry()?.fingerprint === fpOf('leafB.pem') && entry()?.rootUnavailable === true, JSON.stringify(entry()));
  present('leafC', 'int2');
  r = await request();
  check('5. ...and a renewal then prompts as in 3.1 (mismatch of the leaf pin)', !r.ok && mismatches.length === 1 && mismatches[0].kind === 'leaf');
  const trustedLeaf = await homeServer.trustPresented({ pinsPath, host: HOST, url: mismatches[0].url, chain: mismatches[0].chain, fingerprint: mismatches[0].fingerprint });
  check('5. "trust the new certificate" without a served root pins the new leaf', trustedLeaf.type === 'leaf' && entry()?.fingerprint === fpOf('leafC.pem') && (await request()).ok);
  // a served root the chain does not verify against is not pinned either (never pin what does not prove the server)
  serveRoot = pem('evil.pem');
  fs.writeFileSync(pinsPath, '{}');
  r = await request();
  check('5. a served root the presented chain does not chain to is ignored (leaf pinned, rootRejected)', r.ok && !entry()?.type && entry()?.rootRejected === true, JSON.stringify(entry()));
  serveRoot = pem('root.pem');
  mismatches.length = 0;
  // ---- 6. system trust: nothing pinned ----
  fs.writeFileSync(pinsPath, '{}');
  present('leafA', 'int1');
  // (an async spawn: the server answering the child runs in THIS process)
  const child = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', `
      const hs = require(${JSON.stringify(path.join(REPO, 'electron', 'home-server.cjs'))});
      hs.serverRequest(${JSON.stringify(BASE)}, '/api/version', { pinsPath: ${JSON.stringify(pinsPath)}, onPinMismatch: () => console.log('MISMATCH') })
        .then((r) => console.log('status', r.status), (e) => console.log('error', e.message));
    `], { env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(WORK, 'root.pem') } });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { p.kill(); resolve({ stdout, stderr: stderr + ' (timeout)' }); }, 20000);
    p.on('close', () => { clearTimeout(t); resolve({ stdout, stderr }); });
  });
  check('6. a certificate the system trusts (the root installed) passes normal validation', /status 200/.test(child.stdout), child.stdout + child.stderr);
  check('6. ...and NO pin is written for it', !entry(), JSON.stringify(pins.readPins(pinsPath)));
  // ---- 7. the Electron shape and the verifier's refusals ----
  const electronCert = (leafName, intName) => ({ data: pem(`${leafName}.pem`), fingerprint: fpOf(`${leafName}.pem`), issuerCert: intName ? { data: pem(`${intName}.pem`), fingerprint: fpOf(`${intName}.pem`) } : undefined });
  pins.updateCertificatePin(pinsPath, HOST, fpOf('root.pem'), { type: 'root', rootPem: pem('root.pem') });
  let d = trust.decideTrust({ pinsPath, host: HOST, hostname: 'localhost', chainPems: trust.chainFromElectronCertificate(electronCert('leafB', 'int1')) });
  check('7. the renderer\'s certificate-error shape: a renewed leaf matches the root pin', d.decision === 'match' && d.kind === 'root', JSON.stringify(d));
  d = trust.decideTrust({ pinsPath, host: HOST, hostname: 'localhost', chainPems: trust.chainFromElectronCertificate(electronCert('evil-leaf')) });
  check('7. ...an impostor is a mismatch with the root\'s fingerprint as expected', d.decision === 'mismatch' && d.expected === fpOf('root.pem'), JSON.stringify(d));
  d = trust.decideTrust({ pinsPath, host: HOST, hostname: 'localhost', chainPems: ['garbage'] });
  check('7. ...garbage is invalid, never trusted', d.decision === 'invalid');
  check('7. system-trusted (no certificate-error) is never pinned', trust.decideTrust({ pinsPath, host: 'x', hostname: 'x', chainPems: [], authorized: true }).decision === 'system' && !pins.readPins(pinsPath).x);
  const chainA = [pem('leafA.pem'), pem('int1.pem')];
  check('7. verifyChain: ok for the chain, refused for a wrong host, a leaf alone, an expired chain, another root', trust.verifyChain(chainA, pem('root.pem'), 'localhost').ok
    && !trust.verifyChain(chainA, pem('root.pem'), 'other.example.test').ok
    && !trust.verifyChain([pem('leafA.pem')], pem('root.pem'), 'localhost').ok
    && !trust.verifyChain(chainA, pem('root.pem'), 'localhost', Date.now() + 3 * 86400e3).ok
    && !trust.verifyChain(chainA, pem('evil.pem'), 'localhost').ok
    && trust.verifyChain(chainA, pem('root.pem'), '127.0.0.1').ok);
  check('7. the status reports the kind of pin for Settings', JSON.stringify(trust.pinEntry(pinsPath, HOST)).includes('"type":"root"'));
} catch (error) {
  check('the scenario ran to the end', false, error.stack || error.message);
} finally {
  server.close();
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
