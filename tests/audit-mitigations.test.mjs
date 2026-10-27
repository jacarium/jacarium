/**
 * What stays in the code behind the October 2026 npm audit advisories (the reasons: electron/cert-distrust.cjs's header):
 *
 *   electron < 42.11.16 (GHSA-jr5w-w6x2-84p9): the update covers Chromium's verification (the renderer sessions,
 *   Electron's net); Node's TLS in the main process has no such list, so electron/cert-distrust.cjs refuses a
 *   chain issued by or carrying an eMudhra / emSign certificate (distrustReason, checkServerIdentity) on the
 *   Node-side requests: safe-url's workflow fetches, the Jira requests, the home-server client before its pin
 *   decision. No session-level verify proc is installed (Chromium's own list applies there).
 *
 *   fast-uri 3.0.0 - 3.1.8: only reachable through dev dependencies (the packaging's ajv), never from runtime
 *   code.
 *
 *   body-parser < 1.20.9 (GHSA-27r3-jxmh-p828): fixed by the update itself; both Express servers keep their
 *   parsers as they were (a 50 MB limit, no stopgap), checked here so a stopgap does not creep back.
 *
 * Exit code 0 = every check passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const require = createRequire(path.join(REPO, 'package.json'));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ` | ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 1. the certificate distrust list (pure)
// ---------------------------------------------------------------------------
const cd = require('./electron/cert-distrust.cjs');
const clean = [
  { subject: { CN: 'app.example.test', O: 'Example' }, issuer: { CN: 'Example Issuing CA', O: 'Example Trust' } },
  { subject: { CN: 'Example Issuing CA', O: 'Example Trust' }, issuer: { CN: 'Example Root', O: 'Example Trust' } },
];
check('a chain from an ordinary CA is not refused', cd.distrustReason(clean) === null, String(cd.distrustReason(clean)));
const byEmudhra = [{ subject: { CN: 'site.example.test', O: 'Customer' }, issuer: { CN: 'eMudhra Technologies CA 2026', O: 'eMudhra Technologies Limited' } }];
check('a leaf issued by an eMudhra intermediate is refused with the issuer named', /distrusted CA/.test(cd.distrustReason(byEmudhra) || '') && /eMudhra/.test(cd.distrustReason(byEmudhra)), String(cd.distrustReason(byEmudhra)));
const viaIntermediate = [
  { subject: { CN: 'site.example.test', O: 'Customer' }, issuer: { CN: 'Reseller CA', O: 'Reseller' } },
  { subject: { CN: 'Reseller CA', O: 'Reseller' }, issuer: { CN: 'emSign Root CA - G1', O: 'eMudhra Technologies Limited' } },
];
check('a chain through an emSign root is refused', /distrusted/.test(cd.distrustReason(viaIntermediate) || ''), String(cd.distrustReason(viaIntermediate)));
const leafOnly = [{ subject: { CN: 'emudhra-fan.example.test', O: 'eMudhra Fan Club' }, issuer: { CN: 'Example Issuing CA', O: 'Example Trust' } }];
check("a leaf whose own subject carries the name is not refused (only issuers and intermediates count)", cd.distrustReason(leafOnly) === null, String(cd.distrustReason(leafOnly)));
// checkServerIdentity: Node's hostname check first, then the list, over the issuerCertificate links
const nodeLeaf = { subject: { CN: 'site.example.test', O: 'Customer' }, subjectaltname: 'DNS:site.example.test', issuer: { CN: 'Reseller CA', O: 'Reseller' }, fingerprint256: 'AA' };
nodeLeaf.issuerCertificate = { subject: { CN: 'Reseller CA', O: 'Reseller' }, issuer: { CN: 'eMudhra Technologies CA', O: 'eMudhra Technologies Limited' }, fingerprint256: 'BB' };
nodeLeaf.issuerCertificate.issuerCertificate = nodeLeaf.issuerCertificate;   // the root links to itself, as Node does
const refused = cd.checkServerIdentity('site.example.test', nodeLeaf);
check('checkServerIdentity refuses a chain whose intermediate was issued by eMudhra (ERR_TLS_CERT_DISTRUSTED)', refused instanceof Error && refused.code === 'ERR_TLS_CERT_DISTRUSTED', String(refused));
const cleanLeaf = { subject: { CN: 'app.example.test', O: 'Example' }, subjectaltname: 'DNS:app.example.test', issuer: { CN: 'Example Issuing CA', O: 'Example Trust' }, fingerprint256: 'CC' };
cleanLeaf.issuerCertificate = { subject: { CN: 'Example Issuing CA', O: 'Example Trust' }, issuer: { CN: 'Example Root', O: 'Example Trust' }, fingerprint256: 'DD' };
cleanLeaf.issuerCertificate.issuerCertificate = cleanLeaf.issuerCertificate;
check('checkServerIdentity accepts an ordinary chain', cd.checkServerIdentity('app.example.test', cleanLeaf) === undefined);
const wrongHost = cd.checkServerIdentity('other.example.test', cleanLeaf);
check("Node's own hostname check still runs first", wrongHost instanceof Error && wrongHost.code !== 'ERR_TLS_CERT_DISTRUSTED', String(wrongHost && wrongHost.code));

// where it is installed (static)
const main = read('electron/main.cjs');
check("main.cjs installs no session verify proc (Chromium's own list covers the renderer sessions since 42.11.16)", !/setCertificateVerifyProc/.test(main));
check('cert-distrust.cjs says why it stays after the Electron update (Node TLS is not covered by Chromium\'s fix)', /stays after the Electron 42\.11\.16 update/.test(read('electron/cert-distrust.cjs')) && /Node's TLS/.test(read('electron/cert-distrust.cjs')));
check('the Jira request in main.cjs verifies through the distrust list', /checkServerIdentity: certDistrust\.checkServerIdentity/.test(main));
check('safe-url.cjs (workflow URL fetches) verifies through the distrust list', /checkServerIdentity \} = require\('\.\/cert-distrust\.cjs'\)/.test(read('electron/safe-url.cjs')) && /servername: url\.hostname[^\n]*checkServerIdentity/.test(read('electron/safe-url.cjs')));
check('the home-server client refuses a distrusted chain before its pin decision', /distrustReason\(chainFromNodeCertificate\(socket\.getPeerCertificate\(true\)\)\)/.test(read('electron/home-server.cjs')));

// ---------------------------------------------------------------------------
// 2. fast-uri: dev-only paths in the lockfile
// ---------------------------------------------------------------------------
{
  const lock = JSON.parse(read('package-lock.json'));
  const pkgs = lock.packages || {};
  const fastUri = Object.keys(pkgs).filter((k) => /(^|\/)node_modules\/fast-uri$/.test(k));
  const runtimeUsers = Object.entries(pkgs).filter(([k, v]) => k && !v.dev && !v.devOptional && v.dependencies && v.dependencies['fast-uri']).map(([k]) => k);
  check(`fast-uri is a dev-only dependency in the lockfile (${fastUri.length} copies, none required by a production package)`, fastUri.length > 0 && fastUri.every((k) => pkgs[k].dev === true) && runtimeUsers.length === 0, JSON.stringify({ fastUri, runtimeUsers }));
  const own = ['electron', 'src', 'backend', 'jacarium-central', 'scripts'].flatMap((d) => walk(path.join(REPO, d))).filter((f) => /\.(c?js|mjs|ts|jsx|py)$/.test(f) && !f.includes('node_modules'));
  const importers = own.filter((f) => /(require\(|import\(|from\s+)\s*['"]fast-uri['"]|^\s*import\s+['"]fast-uri['"]|from\s+fast_uri|import\s+fast_uri/m.test(fs.readFileSync(f, 'utf8'))); // real imports only: a comment naming the package (e.g. a usage example) is not one
  check('no runtime code of the app, the backend or the central server imports fast-uri', importers.length === 0, importers.join(', '));
}
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === 'venv') ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

// ---------------------------------------------------------------------------
// 3. body-parser: the parsers as they were (the update is the fix; no stopgap crept in)
// ---------------------------------------------------------------------------
check('electron/server.cjs keeps its JSON parser as it was (the 50 MB limit, no Content-Encoding stopgap)', /app\.use\(express\.json\(\{ limit: '50mb' \}\)\);/.test(read('electron/server.cjs')) && !/Content-Encoding/.test(read('electron/server.cjs')));
// (express.json since Express 5: it is body-parser's JSON parser, the separate package is no dependency any more)
check('jacarium-central/server.js keeps its JSON parser as it was', /app\.use\((?:bodyParser|express)\.json\(\{ limit: '50mb' \}\)\);/.test(read('jacarium-central/server.js')) && !/Content-Encoding/.test(read('jacarium-central/server.js')));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
