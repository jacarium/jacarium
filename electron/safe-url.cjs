// Outbound-request guard shared by every place the app fetches a
// user-supplied URL from a privileged process:
//   - the 'workflow-http-request' IPC handler in main.cjs (workflow REST nodes)
//   - the workflow REST node and legacy P2P broadcast routes in server.cjs
//
// Threat: a URL (or the DNS name behind it, or a redirect it returns) that
// points at loopback / RFC1918 / link-local / cloud-metadata addresses lets
// a hostile synced workflow use the user's machine as a proxy into networks
// the attacker cannot reach (SSRF). The Python backend has the same guard in
// backend/safe_url.py; the two must classify addresses identically.
//
// Two layers:
//   1. classifyAddress()/checkUrl(): scheme must be http(s); the hostname is
//      resolved and EVERY resolved address must be publicly routable.
//      Loopback, link-local, unspecified, multicast, reserved and
//      documentation ranges are always rejected. RFC1918 / ULA / CGNAT are
//      rejected unless the caller passes allowPrivate. Workflow REST nodes
//      pass allowPrivate BY DEFAULT (users legitimately point them at
//      intranet services); JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS=0
//      turns that off. The always-rejected set is not affected by the flag.
//   2. safeRequest(): performs the request with Node's core http/https
//      modules CONNECTED TO THE VALIDATED ADDRESS (SNI/Host still carry the
//      hostname, so TLS verification is unchanged). That closes the classic
//      DNS-rebinding race between "check" and "connect". Redirects are never
//      followed automatically: each hop is re-validated, capped at
//      MAX_REDIRECTS, and the response body is capped at maxBytes.
//
// No Electron imports so it is unit-testable with plain Node - see
// tests/safe-url-guard.test.mjs.

const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inV4Range(ip, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

// Always rejected (never a legitimate public destination)
const V4_ALWAYS_BLOCKED = [
  '0.0.0.0/8',        // "this" network / unspecified
  '169.254.0.0/16',   // link-local incl. cloud metadata 169.254.169.254
  '192.0.0.0/24',     // IETF protocol assignments
  '192.0.2.0/24',     // TEST-NET-1
  '198.18.0.0/15',    // benchmarking
  '198.51.100.0/24',  // TEST-NET-2
  '203.0.113.0/24',   // TEST-NET-3
  '224.0.0.0/4',      // multicast
  '240.0.0.0/4'       // reserved + broadcast
];
// Rejected unless allowPrivate
const V4_PRIVATE = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10'     // CGNAT / shared address space
];

/** Expand an IPv6 textual address to 8 16-bit groups (numbers). */
function expandIpv6(ip) {
  let address = ip;
  // Strip zone id
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  // Embedded IPv4 tail -> two hex groups
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    const n = ipv4ToInt(tail);
    address = `${address.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = address.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  const groups = [...head, ...Array(Math.max(0, missing)).fill('0'), ...rest];
  return groups.map((g) => parseInt(g || '0', 16));
}

function classifyIpv6(ip) {
  const g = expandIpv6(ip);
  const isZero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (isZero(0, 8)) return 'blocked';                                  // ::
  if (isZero(0, 7) && g[7] === 1) return 'loopback';                   // ::1
  if (isZero(0, 5) && g[5] === 0xffff) {                               // ::ffff:a.b.c.d
    return classifyIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && isZero(2, 6)) {              // 64:ff9b::/96 NAT64
    return classifyIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if (isZero(0, 6)) return 'blocked';                                  // ::/96 deprecated compat
  if ((g[0] & 0xffc0) === 0xfe80) return 'blocked';                    // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return 'blocked';                    // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'blocked';            // 2001:db8::/32 documentation
  if ((g[0] & 0xfe00) === 0xfc00) return 'private';                    // fc00::/7 ULA
  return 'public';
}

function classifyIpv4(ip) {
  if (inV4Range(ip, '127.0.0.0/8')) return 'loopback';
  if (V4_ALWAYS_BLOCKED.some((cidr) => inV4Range(ip, cidr))) return 'blocked';
  if (V4_PRIVATE.some((cidr) => inV4Range(ip, cidr))) return 'private';
  return 'public';
}

/**
 * 'public' | 'private' | 'loopback' | 'blocked' | 'invalid' for a literal
 * IP address. 'loopback' and 'blocked' are both always rejected by
 * checkUrl (loopback is only distinguished for the test hook).
 */
function classifyAddress(ip) {
  const family = net.isIP(String(ip));
  if (family === 4) return classifyIpv4(ip);
  if (family === 6) return classifyIpv6(ip);
  return 'invalid';
}

// allowLoopback exists ONLY so the regression tests can run the request
// machinery against a local test server; no product caller passes it.
function isAllowedClass(kind, allowPrivate, allowLoopback = false) {
  if (kind === 'public') return true;
  if (kind === 'private' && Boolean(allowPrivate)) return true;
  return kind === 'loopback' && Boolean(allowLoopback);
}

/**
 * Validate a URL and resolve its host. Resolves to
 *   { ok: true, url: URL, addresses: [{ address, family }] }
 * or
 *   { ok: false, reason }
 */
async function checkUrl(rawUrl, { allowPrivate = false, allowLoopback = false } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http:// and https:// URLs are allowed' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  }
  let hostname = url.hostname;
  if (!hostname) return { ok: false, reason: 'Invalid URL host' };
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (!allowLoopback && (hostname.toLowerCase() === 'localhost' || hostname.toLowerCase().endsWith('.localhost'))) {
    return { ok: false, reason: 'URLs pointing to loopback, private or internal networks are not allowed' };
  }

  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      return { ok: false, reason: 'Could not resolve URL host' };
    }
    if (!addresses || addresses.length === 0) {
      return { ok: false, reason: 'Could not resolve URL host' };
    }
  }
  for (const entry of addresses) {
    const kind = classifyAddress(entry.address);
    if (!isAllowedClass(kind, allowPrivate, allowLoopback)) {
      return {
        ok: false,
        reason: kind === 'private'
          ? 'URLs pointing to private networks are not allowed for this request (workflow nodes allow them unless JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS=0)'
          : 'URLs pointing to loopback, private or internal networks are not allowed'
      };
    }
  }
  return { ok: true, url, addresses };
}

class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeUrlError';
    this.code = 'UNSAFE_URL';
  }
}

function performRequest(url, address, family, options, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const headers = { ...(options.headers || {}) };
    // Host header must carry the real hostname since we connect by IP.
    headers.Host = url.host;
    const requestOptions = {
      host: address,
      family,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: (options.method || 'GET').toUpperCase(),
      headers,
      // SNI + certificate hostname check still use the real hostname.
      ...(isHttps ? { servername: url.hostname.replace(/^\[|\]$/g, '') } : {}),
      // Never reuse pooled sockets bound to another (pinned) address.
      agent: false
    };
    const req = transport.request(requestOptions, (res) => {
      const chunks = [];
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          req.destroy(new Error(`Response exceeded ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          statusText: res.statusMessage || '',
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (options.body !== undefined && options.body !== null && requestOptions.method !== 'GET' && requestOptions.method !== 'HEAD') {
      req.write(typeof options.body === 'string' || Buffer.isBuffer(options.body) ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

/**
 * fetch()-like request that validates the URL (and every redirect hop),
 * connects to the validated address, and caps the response size.
 * Resolves { ok, status, statusText, headers, url, text } or throws
 * UnsafeUrlError / Error.
 */
async function safeRequest(rawUrl, options = {}, {
  allowPrivate = false,
  allowLoopback = false,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = MAX_REDIRECTS
} = {}) {
  let current = rawUrl;
  let method = (options.method || 'GET').toUpperCase();
  let body = options.body;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const verdict = await checkUrl(current, { allowPrivate, allowLoopback });
    if (!verdict.ok) {
      throw new UnsafeUrlError(hop === 0 ? verdict.reason : `Redirect target rejected: ${verdict.reason}`);
    }
    const { url, addresses } = verdict;
    const { address, family } = addresses[0];
    const response = await performRequest(url, address, family, { ...options, method, body }, maxBytes, timeoutMs);

    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      if (hop === maxRedirects) {
        throw new Error(`Too many redirects (limit ${maxRedirects})`);
      }
      current = new URL(response.headers.location, url).href;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      url: url.href,
      text: response.body.toString('utf8')
    };
  }
  throw new Error(`Too many redirects (limit ${maxRedirects})`);
}

/**
 * Whether workflow REST nodes may reach RFC1918 / ULA / CGNAT hosts.
 * ON by default (a fresh install needs no configuration: users point REST
 * nodes at intranet services as well as the internet). Opt out with
 * JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS=0 (or "false"), e.g. in
 * ~/.jacarium.env. Loopback, link-local (cloud metadata),
 * unspecified, multicast and reserved ranges stay blocked either way.
 */
function workflowPrivateUrlsAllowed(env = process.env) {
  const raw = env.JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

module.exports = {
  classifyAddress,
  checkUrl,
  safeRequest,
  workflowPrivateUrlsAllowed,
  UnsafeUrlError,
  MAX_REDIRECTS,
  DEFAULT_MAX_BYTES
};
