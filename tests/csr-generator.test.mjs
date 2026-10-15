/**
 * Guards the Tools page's CSR generator
 * (src/components/features/tools/CsrGeneratorTool.jsx): the Certificate
 * Signing Request and private key it shows must be real, standards-conform
 * PEM that an independent implementation accepts.
 *
 * Why this exists: the tool's crypto library is being replaced (node-forge,
 * flagged by `npm audit` with no fixed release, -> WebCrypto + pkijs), and
 * the output must stay equivalent. So every check here goes through an
 * INDEPENDENT verifier: the `openssl` CLI when it is installed (subject,
 * SANs, key algorithm/size/curve, signature algorithm, self-signature
 * verification, key <-> CSR public-key match), with a pure-JS fallback that
 * only parses the structure when openssl is missing (printed as SKIP for the
 * openssl-only checks, exit 0).
 *
 * What this proves, with the REAL tool mounted in jsdom (its form filled
 * the way a user would, synthetic subject data only; WebCrypto is node's):
 *   - RSA 2048: PEM CSR + "RSA PRIVATE KEY" PEM, subject C/ST/L/O/OU/CN/
 *     emailAddress in that order, SAN DNS entries for every domain (CN =
 *     the first), 2048-bit RSA key, sha256WithRSAEncryption, self-signature
 *     verifies, the private key belongs to the CSR's public key, the
 *     decoded view lists subject, key type/size, SANs and the algorithm;
 *   - RSA 4096: 4096-bit key;
 *   - ECDSA p256 / p384: a REAL EC key on the named curve (id-ecPublicKey,
 *     prime256v1 / secp384r1), ecdsa-with-SHA256, "PRIVATE KEY" (PKCS#8)
 *     PEM, self-signature verifies, key matches; (the node-forge version
 *     silently generated a 256/384-bit RSA key for these options)
 *   - Generate is disabled without a domain, a domain list without any
 *     domain is refused with the tool's validation message, and optional
 *     subject fields are simply left out.
 *
 * Run:  node tests/csr-generator.test.mjs
 * Preconditions (checked at startup, with instructions printed if missing):
 *   - repo deps installed:               npm install
 *   - test-only deps (not in package.json, install without saving):
 *                                        npm install --no-save jsdom fake-indexeddb
 *   - optional: `openssl` on PATH for the independent verification
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, typeInto, byText, click, waitFor, sleep } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { check, summary } = makeChecker();
const { mod, window, downloads } = await setupDocumentsEnv('csr-generator', { entry: path.join(here, 'helpers', 'csr-generator-entry.mjs') });
const { renderTool, unmountTool } = mod;
const { document } = window;

// ---------- openssl (independent verifier) ----------
let openssl = null;
try {
  openssl = execFileSync('openssl', ['version'], { encoding: 'utf8' }).trim();
  console.log(`openssl: ${openssl}`);
} catch {
  console.log('SKIP: openssl not on PATH - the independent openssl checks are skipped (structure-only checks still run)');
}
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-generator-'));
function run(args, input) {
  try {
    return { ok: true, out: execFileSync('openssl', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}
/** `openssl req -text -verify` + the public keys of CSR and private key. */
function inspect(csrPem, keyPem) {
  if (!openssl) return null;
  const csrFile = path.join(WORK, 'req.pem');
  const keyFile = path.join(WORK, 'key.pem');
  fs.writeFileSync(csrFile, csrPem);
  fs.writeFileSync(keyFile, keyPem);
  const text = run(['req', '-in', csrFile, '-noout', '-text', '-verify']);
  const verify = run(['req', '-in', csrFile, '-noout', '-verify']);
  const csrPub = run(['req', '-in', csrFile, '-noout', '-pubkey']);
  const keyPub = run(['pkey', '-in', keyFile, '-pubout']);
  const keyCheck = run(['pkey', '-in', keyFile, '-noout', '-check']);
  const keyText = run(['pkey', '-in', keyFile, '-noout', '-text']);
  return {
    text: text.out, verifyOk: verify.ok && /verify OK/.test(verify.out), verifyOut: verify.out,
    pubMatch: csrPub.ok && keyPub.ok && csrPub.out.trim() === keyPub.out.trim(),
    keyOk: keyCheck.ok && /is valid/.test(keyCheck.out), keyOut: keyCheck.out, keyText: keyText.out,
  };
}

// ---------- driving the real form ----------
const SUBJECT = { country: 'XX', state: 'Test State', locality: 'Test City', organization: 'Synthetic Org', organizationalUnit: 'Lab Unit', email: 'certs@example.test' };
const DOMAINS = ['alpha.example.test', 'beta.example.test', 'gamma.example.test'];
const field = (placeholder) => document.querySelector(`input[placeholder="${placeholder}"]`);
const inputs = () => Array.from(document.querySelectorAll('input[type="text"], input[type="email"]'));
async function generate({ domains = DOMAINS, keyType = 'RSA-2048', subject = SUBJECT } = {}) {
  unmountTool();
  renderTool();
  await sleep(20);
  typeInto(window, field('example.com, www.example.com (comma separated)'), domains.join(', '));
  const select = document.querySelector('select');
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, keyType);
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  if (subject.country) typeInto(window, field('US'), subject.country);
  if (subject.state) typeInto(window, field('California'), subject.state);
  if (subject.locality) typeInto(window, field('San Francisco'), subject.locality);
  if (subject.organization) typeInto(window, field('My Company'), subject.organization);
  if (subject.organizationalUnit) typeInto(window, field('IT Department'), subject.organizationalUnit);
  if (subject.email) typeInto(window, inputs()[inputs().length - 1], subject.email);
  click(window, byText(document, /^Generate$/, 'button'));
  const pres = await waitFor(() => { const p = Array.from(document.querySelectorAll('pre')); return p.length >= 2 && /BEGIN CERTIFICATE REQUEST/.test(p[0].textContent) ? p : null; }, 120000, 100);
  // The private key is never displayed, only downloaded (Blob + <a download>) - the env captures that
  let keyPem = '';
  if (pres) {
    const before = downloads.length;
    click(window, byText(document, /^Download Private Key$/, 'button'));
    const dl = await waitFor(() => (downloads.length > before ? downloads[downloads.length - 1] : null), 5000);
    keyPem = dl ? (await dl.text()) || '' : '';
    if (dl && dl.name !== 'private-key.pem') keyPem = '';
  }
  // node-forge wrote CRLF PEM; openssl accepts both, the checks normalize to LF
  const lf = (t) => t.replace(/\r\n/g, '\n');
  return { csrPem: pres ? lf(pres[0].textContent) : '', decoded: pres ? pres[pres.length - 1].textContent : '', keyPem: lf(keyPem) };
}
const pemBlocks = (pem) => (pem.match(/-----BEGIN ([A-Z ]+)-----/g) || []).map((b) => b.replace(/-----(BEGIN )?/g, '').trim());
const subjectLine = (text) => (/Subject: (.*)/.exec(text) || [])[1] || '';

/* ================================================================== */
console.log('\n--- 1. RSA 2048 ---');
/* ================================================================== */
{
  const r = await generate({ keyType: 'RSA-2048' });
  check('a PEM certificate request is shown', /^-----BEGIN CERTIFICATE REQUEST-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE REQUEST-----\n?$/.test(r.csrPem.trim() + '\n'), r.csrPem.slice(0, 40));
  check('the private key is PEM too (PKCS#1 "RSA PRIVATE KEY")', pemBlocks(r.keyPem).join(',') === 'RSA PRIVATE KEY', pemBlocks(r.keyPem).join(','));
  check('PEM lines are wrapped at 64 characters', r.csrPem.split('\n').filter((l) => l && !l.startsWith('-----')).every((l) => l.length <= 64));
  check('the decoded view lists the subject, key type/size, SANs and the signature algorithm',
    /Subject:[\s\S]*countryName: XX[\s\S]*stateOrProvinceName: Test State[\s\S]*localityName: Test City[\s\S]*organizationName: Synthetic Org[\s\S]*organizationalUnitName: Lab Unit[\s\S]*commonName: alpha\.example\.test[\s\S]*emailAddress: certs@example\.test/.test(r.decoded)
    && /Type: RSA\nSize: 2048 bits/.test(r.decoded) && /Subject Alternative Names:\nalpha\.example\.test\nbeta\.example\.test\ngamma\.example\.test/.test(r.decoded) && /SHA-256 with RSA/.test(r.decoded), r.decoded.slice(0, 300));
  const o = inspect(r.csrPem, r.keyPem);
  if (o) {
    check('openssl: the CSR self-signature verifies', o.verifyOk, o.verifyOut.trim());
    check('openssl: subject is C, ST, L, O, OU, CN, emailAddress in that order', subjectLine(o.text) === 'C = XX, ST = Test State, L = Test City, O = Synthetic Org, OU = Lab Unit, CN = alpha.example.test, emailAddress = certs@example.test' || subjectLine(o.text) === 'C=XX, ST=Test State, L=Test City, O=Synthetic Org, OU=Lab Unit, CN=alpha.example.test, emailAddress=certs@example.test', subjectLine(o.text));
    check('openssl: SAN carries every domain as a DNS name', /DNS:alpha\.example\.test, DNS:beta\.example\.test, DNS:gamma\.example\.test/.test(o.text));
    check('openssl: 2048-bit RSA public key, sha256WithRSAEncryption', /Public Key Algorithm: rsaEncryption/.test(o.text) && /Public-Key: \(2048 bit\)/.test(o.text) && /Signature Algorithm: sha256WithRSAEncryption/.test(o.text));
    check('openssl: the private key is valid and belongs to the CSR\'s public key', o.keyOk && o.pubMatch, `${o.keyOut.trim()} pubMatch=${o.pubMatch}`);
  }
}

/* ================================================================== */
console.log('\n--- 2. RSA 4096, optional fields left out ---');
/* ================================================================== */
{
  const r = await generate({ keyType: 'RSA-4096', domains: ['solo.example.test'], subject: { organization: 'Only Org' } });
  check('a CSR is produced with only CN and O', /commonName: solo\.example\.test/.test(r.decoded) && /organizationName: Only Org/.test(r.decoded) && !/countryName|emailAddress|stateOrProvinceName/.test(r.decoded), r.decoded.slice(0, 200));
  const o = inspect(r.csrPem, r.keyPem);
  if (o) {
    check('openssl: 4096-bit RSA, verifies, subject "O = Only Org, CN = solo.example.test"', /Public-Key: \(4096 bit\)/.test(o.text) && o.verifyOk && /^O ?= ?Only Org, CN ?= ?solo\.example\.test$/.test(subjectLine(o.text)) && /DNS:solo\.example\.test/.test(o.text), subjectLine(o.text));
    check('openssl: key matches', o.pubMatch);
  }
}

/* ================================================================== */
console.log('\n--- 3. ECDSA p256 / p384 ---');
/* ================================================================== */
for (const [keyType, curve, bits] of [['ECDSA-p256', 'prime256v1', 256], ['ECDSA-p384', 'secp384r1', 384]]) {
  const r = await generate({ keyType, domains: ['ec.example.test'], subject: { organization: 'EC Org' } });
  check(`${keyType}: the decoded view reports an ECDSA key on ${curve === 'prime256v1' ? 'p256' : 'p384'}`, new RegExp(`Type: ECDSA\\nCurve: ${curve === 'prime256v1' ? 'p256' : 'p384'}`).test(r.decoded) && /SHA-256 with ECDSA/.test(r.decoded), r.decoded.slice(0, 200));
  check(`${keyType}: the private key is a PKCS#8 "PRIVATE KEY" PEM`, pemBlocks(r.keyPem).join(',') === 'PRIVATE KEY', pemBlocks(r.keyPem).join(','));
  const o = inspect(r.csrPem, r.keyPem);
  if (o) {
    check(`${keyType}: openssl sees a real EC key on ${curve} (${bits} bit), ecdsa-with-SHA256`, /Public Key Algorithm: id-ecPublicKey/.test(o.text) && new RegExp(`ASN1 OID: ${curve}`).test(o.text) && new RegExp(`Public-Key: \\(${bits} bit\\)`).test(o.text) && /Signature Algorithm: ecdsa-with-SHA256/.test(o.text), (o.text.match(/Public Key Algorithm: .*|ASN1 OID: .*|Public-Key: .*|Signature Algorithm: .*/g) || []).join(' | '));
    check(`${keyType}: openssl: self-signature verifies and the key matches`, o.verifyOk && o.pubMatch && o.keyOk, `${o.verifyOut.trim()} pubMatch=${o.pubMatch}`);
  }
}

/* ================================================================== */
console.log('\n--- 4. validation ---');
/* ================================================================== */
{
  unmountTool();
  renderTool();
  await sleep(20);
  const generateButton = () => byText(document, /^Generate$/, 'button');
  check('with no domain the Generate button is disabled', generateButton().disabled === true);
  typeInto(window, field('example.com, www.example.com (comma separated)'), 'alpha.example.test');
  check('...and enabled once a domain is typed', generateButton().disabled === false);
  // Only separators -> no usable domain: refused with the tool's message, nothing generated
  typeInto(window, field('example.com, www.example.com (comma separated)'), ' , ,');
  click(window, generateButton());
  await waitFor(() => /Domain name is required|Failed to generate/.test(document.body.textContent), 5000);
  check('a domain list without any domain -> "Domain name is required", nothing generated', /Domain name is required/.test(document.body.textContent) && !document.body.textContent.includes('BEGIN CERTIFICATE REQUEST'), document.body.textContent.replace(/\s+/g, ' ').match(/(Domain name is required|Failed to generate[^.]*)/)?.[0] || 'no message');
}

fs.rmSync(WORK, { recursive: true, force: true });
process.exit(summary());
