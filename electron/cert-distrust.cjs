// A distrust list for the TLS chains that Node's TLS verifies on this app's
// behalf: the requests the main process makes for the user (the workflow URL
// fetches of electron/safe-url.cjs, the Jira fetch in electron/main.cjs and
// the home-server client in electron/home-server.cjs) go through
// checkServerIdentity() here.
//
// Why it stays after the Electron 42.11.16 update: GHSA-jr5w-w6x2-84p9 is
// Chromium's mitigation for the compromised eMudhra intermediate
// certificates, and it covers Chromium's verification only - the renderer
// sessions and Electron's net module. Node's TLS (what https.request and
// tls.connect use in the main process) verifies against Node's own root
// store with no such list, so a chain through one of those intermediates
// would still pass there. This list refuses any chain that carries an
// eMudhra / emSign certificate as an issuer or an intermediate. That is
// broader than Chromium's list (which names the compromised intermediates
// by key): nothing this app talks to (the user's home server, Jira, GitHub,
// the LLM APIs) chains to that CA, so the whole brand is refused rather than
// trusting a chain whose intermediate may be one of the compromised ones.
// The renderer sessions are not touched: Chromium's own list applies there.
//
// The matching is on names only (the issuer's organisation / common name,
// and the subject's for every certificate but the leaf): the key hashes of
// the compromised intermediates were not published with the advisory.
'use strict';

const tls = require('tls');

/** The CA brands refused as an issuer or an intermediate (a leaf's own subject is never matched). */
const DISTRUSTED_NAME_PATTERNS = [/\bemudhra\b/i, /\bemsign\b/i];

function fieldText(name) {
  if (!name) return '';
  if (typeof name === 'string') return name;
  // Node's getPeerCertificate() gives { O, CN, OU }, Electron's Certificate gives { organizations: [], commonName, organizationUnits: [] }
  const parts = [];
  for (const key of ['O', 'CN', 'OU', 'commonName']) if (name[key]) parts.push(String(name[key]));
  for (const key of ['organizations', 'organizationUnits']) if (Array.isArray(name[key])) parts.push(name[key].join(' '));
  return parts.join(' ');
}

function matches(text) {
  return DISTRUSTED_NAME_PATTERNS.some((rx) => rx.test(text || ''));
}

/**
 * The reason a chain is refused, or null. `chain` is leaf first, each entry
 * { subject, issuer } where subject / issuer are the name objects of Node's
 * getPeerCertificate() ({ O, CN }), Electron's Certificate
 * ({ organizations, commonName }) or plain strings.
 */
function distrustReason(chain) {
  if (!Array.isArray(chain)) return null;
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    if (!cert) continue;
    const issuer = fieldText(cert.issuer);
    if (matches(issuer)) return `issued by a distrusted CA (${issuer.trim()})`;
    if (i > 0) {   // an intermediate or a root presented by the server
      const subject = fieldText(cert.subject);
      if (matches(subject)) return `the chain carries a distrusted intermediate (${subject.trim()})`;
    }
  }
  return null;
}

/** Node's getPeerCertificate(true) object (with issuerCertificate links) as a chain, leaf first. */
function chainFromNodeCertificate(cert) {
  const chain = [];
  const seen = new Set();
  let c = cert;
  while (c && typeof c === 'object' && Object.keys(c).length) {
    const key = c.fingerprint256 || c.fingerprint || chain.length;
    if (seen.has(key)) break;
    seen.add(key);
    chain.push({ subject: c.subject, issuer: c.issuer });
    if (!c.issuerCertificate || c.issuerCertificate === c) break;
    c = c.issuerCertificate;
  }
  return chain;
}

/** Electron's Certificate (with issuerCert links) as a chain, leaf first. */
function chainFromElectronCertificate(cert) {
  const chain = [];
  let c = cert;
  for (let i = 0; c && i < 16; i++) {
    chain.push({ subject: c.subject, issuer: c.issuer });
    if (!c.issuerCert || c.issuerCert === c) break;
    c = c.issuerCert;
  }
  return chain;
}

/**
 * checkServerIdentity for Node's https / tls options: Node's own hostname
 * check first, then the distrust list over the presented chain.
 */
function checkServerIdentity(hostname, cert) {
  const err = tls.checkServerIdentity(hostname, cert);
  if (err) return err;
  const reason = distrustReason(chainFromNodeCertificate(cert));
  if (reason) {
    const e = new Error(`The certificate of ${hostname} is refused: ${reason}`);
    e.code = 'ERR_TLS_CERT_DISTRUSTED';
    return e;
  }
  return undefined;
}

module.exports = {
  DISTRUSTED_NAME_PATTERNS,
  distrustReason,
  chainFromNodeCertificate,
  chainFromElectronCertificate,
  checkServerIdentity,
};
