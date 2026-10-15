/**
 * Guards the Electron-side outbound-request guard (electron/safe-url.cjs),
 * used by the 'workflow-http-request' IPC handler in main.cjs and by the
 * workflow REST node + legacy P2P broadcast in electron/server.cjs.
 *
 * THE BUG: those sites fetched caller-supplied URLs with a plain fetch():
 * no private-range restriction at all, redirects followed blindly, no size
 * cap. A hostile synced workflow could point a REST node at
 * http://169.254.169.254/ (cloud metadata), http://127.0.0.1:8080/ (this
 * very backend), or an intranet host, or at a public URL that 302s there,
 * using the user's machine as a proxy (SSRF).
 *
 * THE FIX: classifyAddress()/checkUrl() reject loopback, link-local,
 * unspecified, multicast, reserved and documentation ranges always, and
 * RFC1918/ULA/CGNAT unless allowPrivate; every resolved address must pass.
 * safeRequest() connects to the VALIDATED address (SNI/Host keep the real
 * hostname) so a DNS answer cannot change between check and connect, never
 * follows redirects automatically (each hop re-validated, max 5) and caps
 * the body at 10 MB.
 *
 * What this test proves (real module, plain Node, local test HTTP server):
 *   - address classification for v4/v6 incl. mapped/NAT64 forms;
 *   - checkUrl rejects bad schemes, credentials, localhost names and every
 *     internal literal; accepts a public literal; honors allowPrivate;
 *   - safeRequest (with the test-only allowLoopback hook so it can talk to
 *     a 127.0.0.1 server): happy path with pinned Host header, redirect to
 *     an internal address rejected, same-origin redirect followed, redirect
 *     loop cut off, 303 turns POST into GET, oversize body aborted, JSON
 *     content-type surfaced through the main.cjs-style handling;
 *   - product callers never pass allowLoopback: a loopback URL is rejected
 *     by default even when allowPrivate is set;
 *   - workflow-node policy: workflowPrivateUrlsAllowed() is ON with no
 *     configuration (fresh install), off only for "0"/"false"/"no"/"off",
 *     and with that default RFC1918/ULA targets pass while loopback,
 *     localhost, link-local/metadata, unspecified, multicast and mapped
 *     loopback are still rejected.
 *
 * Run:  node tests/safe-url-guard.test.mjs
 * Preconditions: none (plain Node, no network beyond 127.0.0.1).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { classifyAddress, checkUrl, safeRequest, UnsafeUrlError, workflowPrivateUrlsAllowed } = require(path.join(here, '..', 'electron', 'safe-url.cjs'));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

// ---------- classification ----------
const cases = {
  '127.0.0.1': 'loopback', '127.255.255.254': 'loopback', '::1': 'loopback',
  '0.0.0.0': 'blocked', '169.254.169.254': 'blocked', '169.254.1.1': 'blocked', '224.0.0.1': 'blocked',
  '255.255.255.255': 'blocked', '240.0.0.1': 'blocked', '192.0.2.10': 'blocked', '198.18.0.1': 'blocked',
  '203.0.113.7': 'blocked', '::': 'blocked', 'fe80::1': 'blocked', 'ff02::1': 'blocked', '2001:db8::1': 'blocked',
  '10.0.0.1': 'private', '10.255.255.255': 'private', '172.16.0.1': 'private', '172.31.255.255': 'private',
  '192.168.1.1': 'private', '100.64.0.1': 'private', '100.127.255.255': 'private', 'fd00::1': 'private', 'fc00::abcd': 'private',
  '::ffff:10.0.0.1': 'private', '::ffff:127.0.0.1': 'loopback', '::ffff:8.8.8.8': 'public', '64:ff9b::7f00:1': 'loopback',
  '64:ff9b::808:808': 'public',
  '8.8.8.8': 'public', '1.1.1.1': 'public', '172.32.0.1': 'public', '100.128.0.1': 'public', '2606:4700::1': 'public',
  'not-an-ip': 'invalid', '': 'invalid', '999.1.1.1': 'invalid'
};
for (const [ip, expected] of Object.entries(cases)) {
  const got = classifyAddress(ip);
  check(`classify ${ip} -> ${expected}`, got === expected, got);
}

// ---------- checkUrl ----------
const rejects = async (url, opts, why) => {
  const v = await checkUrl(url, opts);
  check(`checkUrl rejects ${url}${opts && opts.allowPrivate ? ' (allowPrivate)' : ''}${why ? ' - ' + why : ''}`, v.ok === false, v.reason || 'accepted');
};
await rejects('ftp://example.com/x', {}, 'scheme');
await rejects('file:///etc/passwd', {}, 'scheme');
await rejects('javascript:alert(1)', {}, 'scheme');
await rejects('not a url', {}, 'invalid');
await rejects('http://user:pw@8.8.8.8/', {}, 'credentials');
await rejects('http://localhost:8080/api', {}, 'localhost name');
await rejects('http://foo.localhost/', {}, '.localhost name');
await rejects('http://127.0.0.1:8080/api/execute-ssh', {}, 'loopback literal');
await rejects('http://127.0.0.1:8080/', { allowPrivate: true }, 'loopback never allowed');
await rejects('http://[::1]/', {}, 'v6 loopback');
await rejects('http://169.254.169.254/latest/meta-data/', {}, 'metadata');
await rejects('http://169.254.169.254/latest/meta-data/', { allowPrivate: true }, 'metadata never allowed');
await rejects('http://10.1.2.3/', {}, 'RFC1918 default');
await rejects('http://192.168.0.1/', {}, 'RFC1918 default');
await rejects('http://[fd00::1]/', {}, 'ULA default');
await rejects('http://[::ffff:127.0.0.1]/', {}, 'mapped loopback');
await rejects('http://0.0.0.0:8080/', {}, 'unspecified');
await rejects('http://this-host-does-not-exist.invalid/', {}, 'unresolvable');

// ---------- workflow-node policy: private ON by default, never loopback/link-local ----------
check('workflow policy: private allowed by default (env unset)', workflowPrivateUrlsAllowed({}) === true);
check('workflow policy: empty value counts as unset', workflowPrivateUrlsAllowed({ JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS: '' }) === true);
check('workflow policy: "1" keeps it on', workflowPrivateUrlsAllowed({ JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS: '1' }) === true);
for (const off of ['0', 'false', 'FALSE', 'no', 'off']) {
  check(`workflow policy: "${off}" turns it off`, workflowPrivateUrlsAllowed({ JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS: off }) === false);
}
check('workflow policy: current process default is ON', workflowPrivateUrlsAllowed() === true);
const defaultOpts = { allowPrivate: workflowPrivateUrlsAllowed({}) };
let v = await checkUrl('http://10.1.2.3/api', defaultOpts);
check('workflow default: RFC1918 target accepted', v.ok === true, v.reason);
v = await checkUrl('http://192.168.10.20:8443/', defaultOpts);
check('workflow default: 192.168.x target accepted', v.ok === true, v.reason);
v = await checkUrl('http://[fd00::1]/', defaultOpts);
check('workflow default: ULA target accepted', v.ok === true, v.reason);
for (const blocked of ['http://127.0.0.1:8080/api/execute-ssh', 'http://localhost:8080/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/',
  'http://[fe80::1]/', 'http://0.0.0.0:8080/', 'http://[::ffff:127.0.0.1]/', 'http://224.0.0.1/']) {
  v = await checkUrl(blocked, defaultOpts);
  check(`workflow default: ${blocked} still blocked`, v.ok === false, v.reason || 'accepted');
}

v = await checkUrl('https://8.8.8.8/dns-query');
check('checkUrl accepts a public literal', v.ok === true && v.addresses[0].address === '8.8.8.8', v.reason);
v = await checkUrl('http://10.1.2.3/', { allowPrivate: true });
check('checkUrl accepts RFC1918 with allowPrivate', v.ok === true, v.reason);
v = await checkUrl('http://[fd00::1]/', { allowPrivate: true });
check('checkUrl accepts ULA with allowPrivate', v.ok === true, v.reason);

// ---------- safeRequest against a local server ----------
const BIG = 11 * 1024 * 1024;
const seenHosts = [];
const server = http.createServer((req, res) => {
  seenHosts.push(req.headers.host);
  const u = new URL(req.url, 'http://x');
  switch (u.pathname) {
    case '/ok':
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world', method: req.method }));
      return;
    case '/text':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('plain text');
      return;
    case '/redirect-internal':
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    case '/redirect-private':
      res.writeHead(302, { location: 'http://10.0.0.1/' });
      res.end();
      return;
    case '/redirect-ok':
      res.writeHead(302, { location: '/ok' });
      res.end();
      return;
    case '/redirect-loop':
      res.writeHead(302, { location: '/redirect-loop' });
      res.end();
      return;
    case '/see-other':
      res.writeHead(303, { location: '/ok' });
      res.end();
      return;
    case '/big': {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(1024 * 1024, 'a');
      let sent = 0;
      const pump = () => {
        while (sent < BIG) {
          sent += chunk.length;
          if (!res.write(chunk)) { res.once('drain', pump); return; }
        }
        res.end();
      };
      pump();
      return;
    }
    default:
      res.writeHead(404);
      res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const loop = { allowLoopback: true };

async function expectThrow(promise, matcher, name) {
  try {
    await promise;
    check(name, false, 'did not throw');
  } catch (e) {
    check(name, matcher(e), `${e.name}: ${e.message}`);
  }
}

try {
  await expectThrow(safeRequest(`${base}/ok`), (e) => e instanceof UnsafeUrlError, 'safeRequest: loopback rejected by default (no test hook)');
  await expectThrow(safeRequest(`${base}/ok`, {}, { allowPrivate: true }), (e) => e instanceof UnsafeUrlError, 'safeRequest: loopback rejected even with allowPrivate');

  let r = await safeRequest(`${base}/ok`, { method: 'GET' }, loop);
  check('safeRequest: happy path', r.ok && r.status === 200 && JSON.parse(r.text).hello === 'world', `${r.status}`);
  check('safeRequest: Host header carries the URL host (pinned connect)', seenHosts.at(-1) === `127.0.0.1:${port}`, seenHosts.at(-1));
  check('safeRequest: content-type header exposed', /application\/json/.test(r.headers['content-type']));

  r = await safeRequest(`${base}/ok`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' }, loop);
  check('safeRequest: POST body delivered', r.ok && JSON.parse(r.text).method === 'POST');

  await expectThrow(safeRequest(`${base}/redirect-internal`, {}, loop), (e) => e instanceof UnsafeUrlError && /Redirect target rejected/.test(e.message), 'safeRequest: redirect to link-local metadata rejected');
  await expectThrow(safeRequest(`${base}/redirect-private`, {}, loop), (e) => e instanceof UnsafeUrlError, 'safeRequest: redirect to RFC1918 rejected');
  r = await safeRequest(`${base}/redirect-private`, {}, { ...loop, allowPrivate: true }).catch((e) => e);
  check('safeRequest: redirect to RFC1918 allowed only with allowPrivate (then fails to connect, not rejected)', !(r instanceof UnsafeUrlError), r && r.message);

  r = await safeRequest(`${base}/redirect-ok`, {}, loop);
  check('safeRequest: same-origin redirect followed', r.ok && r.url.endsWith('/ok') && JSON.parse(r.text).hello === 'world');
  r = await safeRequest(`${base}/see-other`, { method: 'POST', body: 'x' }, loop);
  check('safeRequest: 303 switches POST to GET', r.ok && JSON.parse(r.text).method === 'GET');
  await expectThrow(safeRequest(`${base}/redirect-loop`, {}, loop), (e) => /Too many redirects/.test(e.message), 'safeRequest: redirect loop cut off');
  await expectThrow(safeRequest(`${base}/big`, {}, loop), (e) => /exceeded/.test(e.message), 'safeRequest: 11 MB body aborted at the 10 MB cap');
  r = await safeRequest(`${base}/big`, {}, { ...loop, maxBytes: 20 * 1024 * 1024 });
  check('safeRequest: cap is configurable (20 MB accepts 11 MB)', r.ok && r.text.length === BIG);
  r = await safeRequest(`${base}/text`, {}, loop);
  check('safeRequest: text body', r.ok && r.text === 'plain text');
  r = await safeRequest(`${base}/missing`, {}, loop);
  check('safeRequest: non-2xx reported as ok=false, not thrown', r.ok === false && r.status === 404);
} catch (error) {
  check('unexpected error', false, error.stack || String(error));
} finally {
  server.close();
}

const failed = results.filter((x) => !x.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
