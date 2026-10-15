// How the desktop decides to trust the home server's certificate
// (electron/home-server.cjs for the main-process requests, the
// 'certificate-error' handler in electron/main.cjs for the renderer's
// WebSocket to <home server>/central).
//
// A certificate the operating system trusts (a public CA, or the home
// server's local CA installed in the keychain) passes normal validation:
// nothing here runs and nothing is pinned. Otherwise the server runs its
// own CA - Caddy's `tls internal`, whose leaf renews about every 12 hours
// and whose intermediate about weekly, or Jacarium's own self-signed
// certificate - and the desktop pins the ROOT of that CA: fetched once from
// the home server (GET /api/tls/root.crt, served from the data volume) at
// link time, trusted on first use like the certificate itself was, and
// from then on every presented chain is verified cryptographically against
// it: the leaf names the host and is signed by the presented intermediate,
// the intermediate (any number of them) is signed by the pinned root, every
// certificate is within its dates. A renewed leaf or intermediate passes
// without a prompt; a chain from another CA is a mismatch and is refused
// with the warning that offers to trust it (electron/main.cjs). When the
// server serves no root (404: the proxy's CA was not copied into the data
// dir), the leaf is pinned as before 3.2 and Settings says so.
//
// Pin store (electron/central-cert-pins.cjs): per "hostname[:port]" either
// the 3.0/3.1 shape { fingerprint: "sha256/<leaf>" } or the root shape
// { type: "root", fingerprint: "sha256/<root>", rootPem, pinnedAt }.
// A leaf pin is upgraded to the root pin the first time the presented leaf
// still matches it and the server serves a root the chain verifies against
// (the rotation has not happened yet, so the pin proves the server); a
// leaf that already rotated is a mismatch and the user is asked once - a
// root is pinned on "Trust new certificate" when the chain verifies against
// the served root, the new leaf otherwise.
//
// Node's crypto.X509Certificate does the signature and name checks; no
// dependency. Electron-free; unit-tested with a synthetic CA in
// tests/home-server-tls-trust.test.mjs.
const { X509Certificate } = require('crypto');
const { readPins, updateCertificatePin } = require('./central-cert-pins.cjs');

const PEM_RE = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g;

/** "sha256/<base64>" - the form Electron's certificate.fingerprint has and the pin store keeps. */
function fingerprintOf(cert) {
  const hex = String(cert.fingerprint256 || '').replace(/:/g, '');
  return /^[0-9a-fA-F]{64}$/.test(hex) ? `sha256/${Buffer.from(hex, 'hex').toString('base64')}` : '';
}

/** Parse one PEM string (one or several certificates) or a DER buffer into X509Certificate objects. */
function parseCertificates(input) {
  if (!input) return [];
  if (Buffer.isBuffer(input)) return [new X509Certificate(input)];
  const text = String(input);
  const blocks = text.match(PEM_RE) || [];
  return blocks.map((b) => new X509Certificate(b));
}

/** The chain a TLS socket presented, leaf first, as PEM strings (the root is never sent by Caddy; a self-signed leaf is its own root). */
function chainFromSocket(socket) {
  const chain = [];
  let cert = socket.getPeerCertificate(true);
  const seen = new Set();
  while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
    seen.add(cert.fingerprint256);
    chain.push(new X509Certificate(cert.raw).toString());
    if (!cert.issuerCertificate || cert.issuerCertificate === cert) break;
    cert = cert.issuerCertificate;
  }
  return chain;
}

/** The chain Electron's 'certificate-error' handed over (certificate.data, .issuerCert ...), leaf first, as PEM strings. */
function chainFromElectronCertificate(certificate) {
  const chain = [];
  let cert = certificate;
  let guard = 0;
  while (cert && typeof cert.data === 'string' && guard++ < 10) {
    chain.push(cert.data);
    if (!cert.issuerCert || cert.issuerCert === cert || cert.issuerCert.data === cert.data) break;
    cert = cert.issuerCert;
  }
  return chain;
}

function withinDates(cert, now) {
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && from <= now && now <= to;
}

function nameMatches(leaf, hostname) {
  const name = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!name) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$|:/.test(name)) return !!leaf.checkIP(name);
  return !!leaf.checkHost(name, { subject: 'default' });
}

/**
 * Verify `chainPems` (leaf first, as the server presented it) against
 * `rootPem`: names, dates, every signature up to the root. Returns
 * { ok, reason }. Never throws.
 */
function verifyChain(chainPems, rootPem, hostname, now = Date.now()) {
  try {
    const chain = chainPems.flatMap((p) => parseCertificates(p));
    const roots = parseCertificates(rootPem);
    if (!chain.length) return { ok: false, reason: 'no certificate presented' };
    if (roots.length !== 1) return { ok: false, reason: 'no pinned root' };
    const root = roots[0];
    const leaf = chain[0];
    if (!nameMatches(leaf, hostname)) return { ok: false, reason: `the certificate is not for ${hostname}` };
    for (const cert of chain) if (!withinDates(cert, now)) return { ok: false, reason: `a certificate in the chain is not valid now (${cert.subject.replace(/\n/g, ', ')})` };
    if (!withinDates(root, now)) return { ok: false, reason: 'the pinned root certificate is not valid now' };
    for (let i = 0; i < chain.length; i++) {
      const cert = chain[i];
      const issuer = chain[i + 1];
      if (cert.fingerprint256 === root.fingerprint256) return { ok: true, reason: i === 0 ? 'the pinned root itself' : 'chains to the pinned root' };
      if (issuer) {
        if (i > 0 && !cert.ca) return { ok: false, reason: 'an intermediate certificate is not a CA' };
        if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) return { ok: false, reason: `the certificate "${cert.subject.replace(/\n/g, ', ')}" was not signed by the next one in the chain` };
        continue;
      }
      // the last presented certificate must be signed by the pinned root
      if (cert.checkIssued(root) && cert.verify(root.publicKey)) return { ok: true, reason: 'chains to the pinned root' };
      return { ok: false, reason: 'the chain does not end at the pinned root' };
    }
    return { ok: false, reason: 'the chain does not end at the pinned root' };
  } catch (error) {
    return { ok: false, reason: `unreadable certificate: ${error.message}` };
  }
}

/** A pin store entry in its two shapes. */
function pinEntry(pinsPath, host) {
  const pins = readPins(pinsPath);
  const raw = pins[String(host || '').trim().toLowerCase()];
  if (!raw) return null;
  if (typeof raw === 'string') return { type: 'leaf', fingerprint: raw.trim() };
  if (raw.type === 'root' && raw.rootPem) return { type: 'root', fingerprint: String(raw.fingerprint || ''), rootPem: raw.rootPem, pinnedAt: raw.pinnedAt };
  return { type: 'leaf', fingerprint: String(raw.fingerprint || '').trim(), pinnedAt: raw.pinnedAt };
}

function pinRoot(pinsPath, host, rootPem) {
  const root = parseCertificates(rootPem)[0];
  const entry = updateCertificatePin(pinsPath, host, fingerprintOf(root), { type: 'root', rootPem: root.toString(), subject: root.subject.replace(/\n/g, ', ') });
  return entry;
}

/**
 * The decision for a presented chain, synchronously from the store:
 *   { decision: 'system' }                      the OS trusts it: no pin involved
 *   { decision: 'match', kind: 'root'|'leaf' }  accepted by the pin
 *   { decision: 'upgrade-candidate' }           a leaf pin that still matches the presented leaf
 *                                               (the caller may fetch the root and upgrade)
 *   { decision: 'unpinned' }                    nothing pinned yet (the caller pins on first use)
 *   { decision: 'mismatch', expected, kind }    refused; `expected` for the warning
 *   { decision: 'invalid', reason }             nothing usable was presented
 * `authorized`: what the TLS layer said (socket.authorized / no certificate-error).
 */
function decideTrust({ pinsPath, host, hostname, chainPems, authorized = false, now = Date.now() }) {
  if (authorized) return { decision: 'system', host };
  let leaf;
  try { leaf = parseCertificates(chainPems[0])[0]; } catch { leaf = null; }
  if (!leaf) return { decision: 'invalid', host, reason: 'no certificate presented', fingerprint: '' };
  const fingerprint = fingerprintOf(leaf);
  const entry = pinEntry(pinsPath, host);
  if (!entry) return { decision: 'unpinned', host, fingerprint };
  if (entry.type === 'root') {
    const v = verifyChain(chainPems, entry.rootPem, hostname, now);
    if (v.ok) return { decision: 'match', kind: 'root', host, fingerprint, expected: entry.fingerprint };
    return { decision: 'mismatch', kind: 'root', host, fingerprint, expected: entry.fingerprint, reason: v.reason };
  }
  if (entry.fingerprint === fingerprint) return { decision: 'upgrade-candidate', kind: 'leaf', host, fingerprint, expected: entry.fingerprint };
  return { decision: 'mismatch', kind: 'leaf', host, fingerprint, expected: entry.fingerprint, reason: 'the certificate differs from the one recorded on first connection' };
}

module.exports = {
  fingerprintOf,
  parseCertificates,
  chainFromSocket,
  chainFromElectronCertificate,
  verifyChain,
  pinEntry,
  pinRoot,
  decideTrust,
};
