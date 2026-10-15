// Trust-on-first-use certificate pinning for the home server the desktop
// links to (electron/home-server.cjs and the 'certificate-error' handler in
// main.cjs; the central server lives behind that same origin at /central).
//
// The home server ships with a self-signed certificate (deploy/entrypoint.sh),
// so Electron's normal chain validation fails for it and main.cjs has to
// intervene in 'certificate-error'. Accepting ANY certificate for that host
// would make the TLS layer worthless against an active attacker on the path:
// whoever could answer for that hostname (DNS/ARP spoofing, a hostile Wi-Fi,
// a compromised router) could present their own self-signed cert and read
// every synced document, the device token and the Yjs traffic.
//
// This module mirrors the SSH known_hosts TOFU model the backend already
// uses for SSH targets (backend/extensions.py KNOWN_HOSTS_PATH):
//   - the FIRST time an untrusted certificate is seen for the host, its
//     SHA-256 fingerprint is recorded (no human is present to compare
//     fingerprints at link time, and the device token exchange happens over
//     that same first connection anyway);
//   - every later connection to that host must present the SAME
//     fingerprint. A different one is rejected and surfaced to the user with
//     the same "this may be a machine-in-the-middle; if the server was
//     legitimately reinstalled, reset the pin" guidance the SSH path gives.
//   - a certificate that passes normal chain validation (e.g. Let's Encrypt)
//     never reaches 'certificate-error' and is not pinned - full validation
//     already applies.
//
// Pins live in a small JSON file under Electron's userData dir (the same
// place as ui-settings.json), keyed by "hostname[:port]":
//   { "<host>": { "fingerprint": "sha256/...", "pinnedAt": "<iso>" } }
// Since 3.1.1 the pin is normally the server's own CA ROOT rather than its
// leaf (electron/tls-trust.cjs: `type: "root"` with the root's PEM next to
// its fingerprint), so the leaf and intermediate certificates a local CA
// such as Caddy's `tls internal` renews every few hours or days pass
// without a prompt; the leaf shape stays for a server that serves no root
// and for pins recorded by earlier versions until they are upgraded.
//
// Kept free of Electron imports (callers pass the file path in) so the
// decision logic is unit-testable with plain Node - see
// tests/central-cert-pinning.test.mjs.

const fs = require('fs');
const path = require('path');

// Returns the parsed pin map, or {} if the file is missing/corrupt. Never throws.
function readPins(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data;
    }
  } catch {
    // Missing or corrupt file: no pins.
  }
  return {};
}

function writePins(filePath, pins) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(pins, null, 2) + '\n', { mode: 0o600 });
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase();
}

function normalizeFingerprint(fingerprint) {
  return String(fingerprint || '').trim();
}

/**
 * Evaluate a certificate presented by `host` against the pin store.
 *
 * Returns { decision, host, fingerprint, expected }:
 *   'pinned'   - first sighting; the fingerprint has been recorded and the
 *                connection should be ACCEPTED (trust on first use)
 *   'match'    - fingerprint equals the stored pin; ACCEPT
 *   'mismatch' - fingerprint differs from the stored pin; REJECT (`expected`
 *                carries the stored fingerprint for the user-facing warning)
 *   'invalid'  - no usable host/fingerprint; REJECT
 */
function checkCertificatePin(filePath, host, fingerprint) {
  const key = normalizeHost(host);
  const actual = normalizeFingerprint(fingerprint);
  if (!key || !actual) {
    return { decision: 'invalid', host: key, fingerprint: actual, expected: null };
  }

  const pins = readPins(filePath);
  const existing = pins[key];
  const expected = existing && typeof existing === 'object'
    ? normalizeFingerprint(existing.fingerprint)
    : normalizeFingerprint(existing);

  if (!expected) {
    pins[key] = { fingerprint: actual, pinnedAt: new Date().toISOString() };
    writePins(filePath, pins);
    return { decision: 'pinned', host: key, fingerprint: actual, expected: null };
  }
  if (expected === actual) {
    return { decision: 'match', host: key, fingerprint: actual, expected };
  }
  return { decision: 'mismatch', host: key, fingerprint: actual, expected };
}

/**
 * Replace (or create) the pin for `host` - the explicit "trust the new
 * certificate" action after a mismatch, equivalent to removing the host's
 * line from known_hosts and reconnecting.
 */
function updateCertificatePin(filePath, host, fingerprint, extra = {}) {
  const key = normalizeHost(host);
  const actual = normalizeFingerprint(fingerprint);
  if (!key || !actual) {
    throw new Error('host and fingerprint are required');
  }
  const pins = readPins(filePath);
  pins[key] = { ...extra, fingerprint: actual, pinnedAt: new Date().toISOString() };
  writePins(filePath, pins);
  return pins[key];
}

/** Remove the pin for `host` (no-op if absent). */
function forgetCertificatePin(filePath, host) {
  const key = normalizeHost(host);
  const pins = readPins(filePath);
  if (!(key in pins)) return false;
  delete pins[key];
  writePins(filePath, pins);
  return true;
}

module.exports = {
  readPins,
  checkCertificatePin,
  updateCertificatePin,
  forgetCertificatePin
};
