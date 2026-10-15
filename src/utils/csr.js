/**
 * Certificate Signing Request generation for the Tools page's CSR generator
 * (src/components/features/tools/CsrGeneratorTool.jsx).
 *
 * Keys come from WebCrypto (the browser's / Electron's own implementation),
 * the PKCS#10 structure from pkijs + asn1js. This replaced node-forge, whose
 * last release is flagged by `npm audit` (GHSA-86w9-cpqp-85rv, no fixed
 * version). The output format is the one the forge version produced:
 *   - CSR: PEM "CERTIFICATE REQUEST", subject attributes in the order
 *     C, ST, L, O, OU, CN, emailAddress (only the ones given), a
 *     subjectAltName extension request with a DNS entry per domain, signed
 *     with SHA-256;
 *   - RSA private key: PKCS#1 PEM "RSA PRIVATE KEY" (what forge wrote);
 *   - ECDSA private key: PKCS#8 PEM "PRIVATE KEY" - forge had no ECDSA at
 *     all and quietly generated a 256/384-bit RSA key for those options;
 *     the keys are now real P-256 / P-384 keys.
 */

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

/** Key type option -> WebCrypto parameters (the <select> values of the tool). */
export const KEY_TYPES = {
  'RSA-4096': { type: 'RSA', size: 4096 },
  'RSA-2048': { type: 'RSA', size: 2048 },
  'ECDSA-p256': { type: 'ECDSA', curve: 'p256', namedCurve: 'P-256' },
  'ECDSA-p384': { type: 'ECDSA', curve: 'p384', namedCurve: 'P-384' },
};

/** Subject attribute -> OID and the ASN.1 string type forge used for it. */
const SUBJECT_ATTRIBUTES = [
  { field: 'country', name: 'countryName', oid: '2.5.4.6', String: asn1js.PrintableString },
  { field: 'state', name: 'stateOrProvinceName', oid: '2.5.4.8', String: asn1js.Utf8String },
  { field: 'locality', name: 'localityName', oid: '2.5.4.7', String: asn1js.Utf8String },
  { field: 'organization', name: 'organizationName', oid: '2.5.4.10', String: asn1js.Utf8String },
  { field: 'organizationalUnit', name: 'organizationalUnitName', oid: '2.5.4.11', String: asn1js.Utf8String },
  { field: 'commonName', name: 'commonName', oid: '2.5.4.3', String: asn1js.Utf8String },
  { field: 'email', name: 'emailAddress', oid: '1.2.840.113549.1.9.1', String: asn1js.IA5String },
];

const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_EXTENSION_REQUEST = '1.2.840.113549.1.9.14';

function getCrypto() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (!c || !c.subtle) throw new Error('WebCrypto is not available in this environment');
  return c;
}

let engineReady = false;
function ensureEngine() {
  if (engineReady) return;
  const crypto = getCrypto();
  let current = null;
  try { current = pkijs.getEngine(); } catch { current = null; }
  if (!current || !current.crypto) {
    pkijs.setEngine('webcrypto', new pkijs.CryptoEngine({ name: 'webcrypto', crypto }));
  }
  engineReady = true;
}

/** Split a comma separated domain list into trimmed, non-empty entries. */
export function parseDomains(domainNames) {
  return String(domainNames || '').split(',').map((d) => d.trim()).filter(Boolean);
}

function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  }
  return btoa(binary); // browsers, Electron and node >= 16 all have btoa
}

/** PEM-wrap DER bytes with 64-character lines (LF line endings). */
export function toPem(label, der) {
  const b64 = toBase64(der);
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * PKCS#8 -> PKCS#1 for RSA keys: PKCS#8 wraps the RSAPrivateKey structure
 * in an OCTET STRING (PrivateKeyInfo.privateKey), so unwrapping it IS the
 * PKCS#1 encoding forge used to emit.
 */
export function pkcs8ToPkcs1(pkcs8Der) {
  const parsed = asn1js.fromBER(pkcs8Der);
  if (parsed.offset === -1) throw new Error('Could not parse the PKCS#8 private key');
  const privateKeyOctets = parsed.result.valueBlock.value[2];
  if (!privateKeyOctets || !privateKeyOctets.valueBlock) throw new Error('Unexpected PKCS#8 structure');
  return privateKeyOctets.valueBlock.valueHexView;
}

/**
 * Generate a key pair and a signed CSR.
 *
 * @param {{ domainNames: string, keyType: string, country?: string, state?: string,
 *   locality?: string, organization?: string, organizationalUnit?: string, email?: string }} form
 * @returns {Promise<{ csrPem: string, privateKeyPem: string, domains: string[],
 *   subject: Array<{ name: string, value: string }>, keyInfo: { type: string, size?: number, curve?: string } }>}
 */
export async function generateCsr(form) {
  const domains = parseDomains(form.domainNames);
  if (domains.length === 0) throw new Error('Domain name is required');
  const keyType = KEY_TYPES[form.keyType];
  if (!keyType) throw new Error(`Unknown key type: ${form.keyType}`);

  ensureEngine();
  const { subtle } = getCrypto();

  // 1. key pair
  const algorithm = keyType.type === 'RSA'
    ? { name: 'RSASSA-PKCS1-v1_5', modulusLength: keyType.size, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
    : { name: 'ECDSA', namedCurve: keyType.namedCurve };
  const keys = await subtle.generateKey(algorithm, true, ['sign', 'verify']);

  // 2. subject (same order and string types as before). One RDN (SET) per
  // attribute, the conventional encoding forge produced and the one
  // `openssl req -subject` prints with commas: pkijs's own
  // RelativeDistinguishedNames.toSchema() would put every attribute into a
  // single multi-valued RDN ("C=XX + ST=... + CN=..."), so the Name is
  // encoded here and handed to pkijs pre-encoded.
  const values = { ...form, commonName: domains[0] };
  const subject = [];
  const rdns = [];
  for (const attr of SUBJECT_ATTRIBUTES) {
    const value = values[attr.field];
    if (!value) continue;
    subject.push({ name: attr.name, value });
    const typeAndValue = new pkijs.AttributeTypeAndValue({ type: attr.oid, value: new attr.String({ value }) });
    rdns.push(new asn1js.Set({ value: [typeAndValue.toSchema()] }));
  }
  const nameDer = new asn1js.Sequence({ value: rdns }).toBER(false);
  const csr = new pkijs.CertificationRequest();
  csr.version = 0;
  csr.subject = new pkijs.RelativeDistinguishedNames({ schema: asn1js.fromBER(nameDer).result });

  // 3. public key + subjectAltName extension request (a DNS entry per domain)
  await csr.subjectPublicKeyInfo.importKey(keys.publicKey);
  const altNames = new pkijs.GeneralNames({
    names: domains.map((domain) => new pkijs.GeneralName({ type: 2, value: domain })),
  });
  const extensions = new pkijs.Extensions({
    extensions: [new pkijs.Extension({
      extnID: OID_SUBJECT_ALT_NAME,
      critical: false,
      extnValue: altNames.toSchema().toBER(false),
    })],
  });
  csr.attributes = [new pkijs.Attribute({ type: OID_EXTENSION_REQUEST, values: [extensions.toSchema()] })];

  // 4. sign and encode
  await csr.sign(keys.privateKey, 'SHA-256');
  const csrPem = toPem('CERTIFICATE REQUEST', csr.toSchema(true).toBER(false));

  const pkcs8 = await subtle.exportKey('pkcs8', keys.privateKey);
  const privateKeyPem = keyType.type === 'RSA'
    ? toPem('RSA PRIVATE KEY', pkcs8ToPkcs1(pkcs8))
    : toPem('PRIVATE KEY', pkcs8);

  const keyInfo = keyType.type === 'RSA'
    ? { type: 'RSA', size: keyType.size }
    : { type: 'ECDSA', curve: keyType.curve };

  return { csrPem, privateKeyPem, domains, subject, keyInfo };
}
