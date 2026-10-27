#!/usr/bin/env python3
"""
Guards the backend outbound-request guard (backend/safe_url.py) and its two
callers: /api/fetch-url (url_fetch.py) and the workflow REST node
(workflow_executor.py).

THE BUG: url_fetch.py resolved the hostname once, rejected private/loopback
addresses, then called requests.get() which FOLLOWED REDIRECTS without
re-checking each hop - a public URL that 302s to http://169.254.169.254/ or
http://127.0.0.1:8080/ sailed through - and parsed an unbounded body with
BeautifulSoup. The workflow REST node had no private-range restriction at all,
so a hostile synced workflow could use the user's machine as a proxy into
loopback/intranet services (SSRF).

THE FIX: one shared guard. validate_url() rejects bad schemes, embedded
credentials, localhost names and every resolved address that is loopback,
link-local, unspecified, multicast, reserved or documentation space (always)
or RFC1918/ULA/CGNAT (unless allow_private - workflow nodes honor
JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS=1). safe_request() disables
automatic redirects, re-validates every hop (max 5), and streams the body
with a hard 10 MB cap. The Electron side has the same guard in
electron/safe-url.cjs (tests/safe-url-guard.test.mjs).

What this test proves:
  Part A: address classification (v4/v6, mapped, NAT64) and validate_url
    rejections/acceptances incl. allow_private.
  Part B (local HTTP server, test-only allow_loopback hook): happy path,
    redirect to internal/private rejected, same-origin redirect followed,
    303 POST->GET, redirect loop cut off, oversize body aborted, cap is
    configurable, non-2xx not raised.
  Part C (routes): /api/fetch-url returns 400 for loopback/private/metadata
    targets and for a public-looking hostname that resolves nowhere, without
    performing any request; the workflow REST node raises "REST API error"
    for an internal URL without performing any request, and does perform it
    when the private opt-in is set (verified against the local server).

Self-contained, no test framework: run with the backend venv interpreter.

  backend/venv/bin/python tests/safe_url_guard.test.py

Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)
os.environ.setdefault('APP_AUTH_TOKEN', 'test-token')

try:
    import requests  # noqa: F401
    from flask import Flask
except ImportError:
    print('Missing dependency "flask"/"requests". Run with the backend venv: backend/venv/bin/python tests/safe_url_guard.test.py')
    sys.exit(1)

import safe_url as su  # noqa: E402

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


# ---------------------------------------------------------------------------
# Part A - classification + validate_url
# ---------------------------------------------------------------------------
print('\n--- Part A: classification / validate_url ---')
CASES = {
    '127.0.0.1': 'loopback', '::1': 'loopback', '::ffff:127.0.0.1': 'loopback', '64:ff9b::7f00:1': 'loopback',
    '0.0.0.0': 'blocked', '169.254.169.254': 'blocked', '224.0.0.1': 'blocked', '255.255.255.255': 'blocked',
    '240.0.0.1': 'blocked', '192.0.2.10': 'blocked', '198.18.0.1': 'blocked', '203.0.113.7': 'blocked',
    '::': 'blocked', 'fe80::1': 'blocked', 'ff02::1': 'blocked', '2001:db8::1': 'blocked',
    '10.0.0.1': 'private', '172.16.0.1': 'private', '172.31.255.255': 'private', '192.168.1.1': 'private',
    '100.64.0.1': 'private', 'fd00::1': 'private', '::ffff:10.0.0.1': 'private',
    '8.8.8.8': 'public', '1.1.1.1': 'public', '172.32.0.1': 'public', '100.128.0.1': 'public',
    '2606:4700::1': 'public', '::ffff:8.8.8.8': 'public', '64:ff9b::808:808': 'public',
    'not-an-ip': 'invalid', '': 'invalid', '999.1.1.1': 'invalid',
}
for ip, expected in CASES.items():
    got = su.classify_address(ip)
    check(f'classify {ip!r} -> {expected}', got == expected, got)


def rejects(url, why='', **kw):
    try:
        su.validate_url(url, **kw)
        check(f'validate_url rejects {url} {why}', False, 'accepted')
    except su.UnsafeUrlError as e:
        check(f'validate_url rejects {url} {why}', True, str(e)[:60])


rejects('ftp://example.com/x', 'scheme')
rejects('file:///etc/passwd', 'scheme')
rejects('http://user:pw@8.8.8.8/', 'credentials')
rejects('http://localhost:8080/api', 'localhost')
rejects('http://foo.localhost/', '.localhost')
rejects('http://127.0.0.1:8080/api/execute-ssh', 'loopback')
rejects('http://127.0.0.1:8080/', 'loopback even with allow_private', allow_private=True)
rejects('http://[::1]/', 'v6 loopback')
rejects('http://169.254.169.254/latest/meta-data/', 'metadata')
rejects('http://169.254.169.254/', 'metadata even with allow_private', allow_private=True)
rejects('http://10.1.2.3/', 'RFC1918 default')
rejects('http://[fd00::1]/', 'ULA default')
rejects('http://[::ffff:127.0.0.1]/', 'mapped loopback')
rejects('http://0.0.0.0:8080/', 'unspecified')
rejects('http://this-host-does-not-exist.invalid/', 'unresolvable')
rejects('http://8.8.8.8:99999/', 'bad port')

parsed, addrs = su.validate_url('https://8.8.8.8/dns-query')
check('validate_url accepts public literal', parsed.hostname == '8.8.8.8' and addrs == ['8.8.8.8'])
parsed, addrs = su.validate_url('http://10.1.2.3/', allow_private=True)
check('validate_url accepts RFC1918 with allow_private', addrs == ['10.1.2.3'])

# ---------------------------------------------------------------------------
# Part B - safe_request against a local server
# ---------------------------------------------------------------------------
print('\n--- Part B: safe_request ---')
BIG = 11 * 1024 * 1024
seen = {'hosts': [], 'paths': []}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _serve(self):
        seen['hosts'].append(self.headers.get('Host'))
        seen['paths'].append(self.path)
        p = self.path.split('?', 1)[0]
        if p == '/ok':
            body = json.dumps({'hello': 'world', 'method': self.command}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif p == '/html':
            body = b'<html><head><title>T</title></head><body><main><h1>Hi</h1><p>para</p></main></body></html>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif p in ('/redirect-internal', '/redirect-private', '/redirect-ok', '/redirect-loop', '/see-other'):
            target = {
                '/redirect-internal': 'http://169.254.169.254/latest/meta-data/',
                '/redirect-private': 'http://10.0.0.1/',
                '/redirect-ok': '/ok',
                '/redirect-loop': '/redirect-loop',
                '/see-other': '/ok',
            }[p]
            self.send_response(303 if p == '/see-other' else 302)
            self.send_header('Location', target)
            self.send_header('Content-Length', '0')
            self.end_headers()
        elif p == '/big':
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(BIG))
            self.end_headers()
            chunk = b'a' * (1024 * 1024)
            try:
                for _ in range(BIG // len(chunk)):
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif p == '/big-chunked':
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            chunk = b'a' * (1024 * 1024)
            try:
                for _ in range(BIG // len(chunk)):
                    self.wfile.write(b'%x\r\n' % len(chunk) + chunk + b'\r\n')
                self.wfile.write(b'0\r\n\r\n')
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self.send_response(404)
            self.send_header('Content-Length', '0')
            self.end_headers()

    do_GET = _serve
    do_POST = _serve


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{port}'


def expect_raises(fn, exc, pattern, name):
    try:
        fn()
        check(name, False, 'did not raise')
    except exc as e:
        check(name, pattern in str(e), f'{type(e).__name__}: {e}'[:90])
    except Exception as e:  # noqa: BLE001
        check(name, False, f'wrong exception {type(e).__name__}: {e}'[:90])


try:
    expect_raises(lambda: su.safe_request('GET', f'{base}/ok'), su.UnsafeUrlError, 'not allowed',
                  'safe_request: loopback rejected by default (no test hook)')
    expect_raises(lambda: su.safe_request('GET', f'{base}/ok', allow_private=True), su.UnsafeUrlError, 'not allowed',
                  'safe_request: loopback rejected even with allow_private')

    r = su.safe_request('GET', f'{base}/ok', allow_loopback=True)
    check('safe_request: happy path', r.ok and r.status_code == 200 and r.json()['hello'] == 'world')
    check('safe_request: Host header carries URL host', seen['hosts'][-1] == f'127.0.0.1:{port}', seen['hosts'][-1])
    r = su.safe_request('POST', f'{base}/ok', data='{"a":1}', headers={'Content-Type': 'application/json'}, allow_loopback=True)
    check('safe_request: POST delivered', r.ok and r.json()['method'] == 'POST')

    expect_raises(lambda: su.safe_request('GET', f'{base}/redirect-internal', allow_loopback=True), su.UnsafeUrlError,
                  'Redirect target rejected', 'safe_request: redirect to link-local metadata rejected')
    expect_raises(lambda: su.safe_request('GET', f'{base}/redirect-private', allow_loopback=True), su.UnsafeUrlError,
                  'Redirect target rejected', 'safe_request: redirect to RFC1918 rejected')
    check('safe_request: the rejected redirect target was never requested',
          not any('meta-data' in p for p in seen['paths']))
    r = su.safe_request('GET', f'{base}/redirect-ok', allow_loopback=True)
    check('safe_request: same-origin redirect followed', r.ok and r.url.endswith('/ok') and r.json()['hello'] == 'world')
    r = su.safe_request('POST', f'{base}/see-other', data='x', allow_loopback=True)
    check('safe_request: 303 switches POST to GET', r.ok and r.json()['method'] == 'GET')
    expect_raises(lambda: su.safe_request('GET', f'{base}/redirect-loop', allow_loopback=True), ValueError,
                  'Too many redirects', 'safe_request: redirect loop cut off')
    expect_raises(lambda: su.safe_request('GET', f'{base}/big', allow_loopback=True), ValueError,
                  'exceeded', 'safe_request: declared 11 MB body rejected at 10 MB cap')
    expect_raises(lambda: su.safe_request('GET', f'{base}/big-chunked', allow_loopback=True), ValueError,
                  'exceeded', 'safe_request: undeclared (chunked) 11 MB body aborted at 10 MB cap')
    r = su.safe_request('GET', f'{base}/big', allow_loopback=True, max_bytes=20 * 1024 * 1024)
    check('safe_request: cap configurable (20 MB accepts 11 MB)', r.ok and len(r.content) == BIG)
    r = su.safe_request('GET', f'{base}/missing', allow_loopback=True)
    check('safe_request: non-2xx returned, not raised', r.status_code == 404 and not r.ok)
    expect_raises(r.raise_for_status, Exception, '404', 'safe_request: raise_for_status works on the wrapper')

    # -----------------------------------------------------------------------
    # Part C - routes
    # -----------------------------------------------------------------------
    print('\n--- Part C: routes ---')
    import url_fetch as uf
    app = Flask(__name__)
    app.register_blueprint(uf.url_fetch)
    client = app.test_client()
    seen['paths'].clear()
    for target in ['http://127.0.0.1:8080/api/execute-ssh', 'http://localhost/', 'http://169.254.169.254/latest/',
                   'http://10.0.0.5/', 'http://[::1]/', 'file:///etc/passwd', 'http://this-host-does-not-exist.invalid/']:
        resp = client.post('/api/fetch-url', json={'url': target})
        check(f'/api/fetch-url {target} -> 400', resp.status_code == 400, f'{resp.status_code} {resp.get_json()}')
    check('/api/fetch-url: nothing was requested from the local server', seen['paths'] == [])

    import workflow_executor as we

    def run_rest(url):
        node = {'id': 'r', 'type': 'restapi', 'data': {'url': url, 'method': 'GET', 'headers': '{}'}}
        return we.execute_node(node, {}, {}, [], {'r': node})

    # Workflow-node policy: private ON by default (fresh install, env unset)
    os.environ.pop('JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS', None)
    check('workflow policy: ON with env unset', su.workflow_private_urls_allowed() is True)
    os.environ['JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS'] = ''
    check('workflow policy: empty value counts as unset (ON)', su.workflow_private_urls_allowed() is True)
    os.environ['JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS'] = '1'
    check('workflow policy: "1" keeps it ON', su.workflow_private_urls_allowed() is True)
    for off in ('0', 'false', 'FALSE', 'no', 'off'):
        os.environ['JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS'] = off
        check(f'workflow policy: {off!r} turns it OFF', su.workflow_private_urls_allowed() is False)
    os.environ.pop('JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS', None)

    seen['paths'].clear()
    for target in [f'{base}/ok', 'http://localhost:9/', 'http://169.254.169.254/latest/', 'http://[::1]/',
                   'http://[fe80::1]/', 'http://0.0.0.0:9/', 'http://[::ffff:127.0.0.1]/']:
        try:
            run_rest(target)
            check(f'workflow REST node (default policy) {target} rejected', False, 'no error')
        except Exception as e:  # noqa: BLE001
            check(f'workflow REST node (default policy) {target} rejected',
                  'REST API error' in str(e) and 'not allowed' in str(e), str(e)[:90])
    check('workflow REST node: nothing was requested from the local server', seen['paths'] == [])
    try:
        run_rest('http://10.255.255.1:9/')  # unroutable; must pass validation and fail on connect
        check('workflow REST node (default policy): RFC1918 target passes validation (connect attempted)', False, 'unexpected success')
    except Exception as e:  # noqa: BLE001
        check('workflow REST node (default policy): RFC1918 target passes validation (connect attempted)',
              'not allowed' not in str(e), str(e)[:90])

    os.environ['JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS'] = '0'
    try:
        try:
            run_rest('http://10.255.255.1:9/')
            check('workflow REST node: RFC1918 rejected when opted out', False, 'no error')
        except Exception as e:  # noqa: BLE001
            check('workflow REST node: RFC1918 rejected when opted out', 'not allowed' in str(e), str(e)[:90])
        try:
            run_rest(f'{base}/ok')
            check('workflow REST node: loopback rejected when opted out too', False, 'no error')
        except Exception as e:  # noqa: BLE001
            check('workflow REST node: loopback rejected when opted out too', 'not allowed' in str(e), str(e)[:90])
    finally:
        del os.environ['JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS']

    # /api/fetch-url stays strict regardless of the workflow policy
    resp = client.post('/api/fetch-url', json={'url': 'http://10.0.0.5/'})
    check('/api/fetch-url still rejects RFC1918 with the workflow default ON', resp.status_code == 400, f'{resp.status_code}')

    # -----------------------------------------------------------------------
    # Part D - DNS-rebinding pin: the connection goes to the address that was
    # validated, never to a re-resolution of the name.
    # -----------------------------------------------------------------------
    print('\n--- Part D: connection pinning (DNS rebinding) ---')
    real_getaddrinfo = su.socket.getaddrinfo
    resolver_calls = {'count': 0, 'names': []}

    def fake_getaddrinfo(host, port, *args, **kwargs):
        # Only the validator resolves 'rebind.test'; it maps to the local test
        # server. The real connect never resolves this name (it connects to the
        # pinned IP), so a second lookup here would mean the pin failed.
        if host == 'rebind.test':
            resolver_calls['count'] += 1
            resolver_calls['names'].append(host)
            return [(su.socket.AF_INET, su.socket.SOCK_STREAM, su.socket.IPPROTO_TCP, '', ('127.0.0.1', port))]
        return real_getaddrinfo(host, port, *args, **kwargs)

    su.socket.getaddrinfo = fake_getaddrinfo
    try:
        seen['hosts'].clear()
        # 'rebind.test' resolves (in the validator only) to the loopback test
        # server; the pin must connect there, carrying the hostname as Host/SNI.
        r = su.safe_request('GET', f'http://rebind.test:{port}/ok', allow_loopback=True)
        check('pin: a hostname only the validator can resolve still reaches the validated address',
              r.ok and r.json()['hello'] == 'world', f'{r.status_code}')
        check('pin: the Host header carries the hostname, not the pinned IP',
              seen['hosts'] and seen['hosts'][-1] == f'rebind.test:{port}', seen['hosts'][-1] if seen['hosts'] else None)
        check('pin: the name was resolved exactly once (the connect did not look it up again)',
              resolver_calls['count'] == 1, resolver_calls['count'])
        # A name the validator resolves to a blocked address is still refused,
        # and no connection (hence no pin) is attempted.
        def _blocked(host, port, *a, **k):
            return [(su.socket.AF_INET, su.socket.SOCK_STREAM, su.socket.IPPROTO_TCP, '', ('169.254.169.254', port))]
        su.socket.getaddrinfo = _blocked
        expect_raises(lambda: su.safe_request('GET', 'http://metadata.test/latest/', allow_loopback=True),
                      su.UnsafeUrlError, 'not allowed', 'pin: a name resolving to link-local is refused before any connect')
    finally:
        su.socket.getaddrinfo = real_getaddrinfo
finally:
    server.shutdown()

failed = [n for n, p in results if not p]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
