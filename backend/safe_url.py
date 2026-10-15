"""Outbound-request guard for user-supplied URLs (SSRF protection).

Shared by every backend route that fetches a URL chosen by the caller:
  - url_fetch.py  (/api/fetch-url: page -> markdown for the AI context)
  - workflow_executor.py (workflow REST nodes)

Threat: a URL, the DNS name behind it, or a redirect it returns can point at
loopback / RFC1918 / link-local / cloud-metadata addresses, turning the
user's machine into a proxy into networks the attacker cannot reach. The
Electron side has the same guard in electron/safe-url.cjs; both classify
addresses identically.

  validate_url(url, allow_private=False)
      scheme must be http(s); no embedded credentials; the hostname is
      resolved and EVERY resolved address must be publicly routable.
      Loopback, link-local, unspecified, multicast, reserved and
      documentation ranges are always rejected; RFC1918 / ULA / CGNAT only
      when allow_private is False. Workflow REST nodes pass allow_private
      BY DEFAULT (users legitimately target intranet services);
      JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS=0 turns that off. The
      always-rejected set is not affected by the flag.

  safe_request(method, url, ...)
      performs the request with redirects DISABLED, re-validates every
      redirect hop (max MAX_REDIRECTS) and streams the body with a hard
      size cap (max_bytes) so an oversized response is aborted before it is
      parsed or handed to the AI context.

Residual risk: `requests` cannot pin the TCP connection to the address that
was validated, so a DNS name that flips to an internal address between the
check and the connect (DNS rebinding with a very low TTL) is not fully
prevented here; the Electron-side guard does pin. Keep timeouts short.
"""
import ipaddress
import os
import socket
from urllib.parse import urlparse, urljoin

MAX_REDIRECTS = 5
DEFAULT_MAX_BYTES = 10 * 1024 * 1024
_ENV_ALLOW_PRIVATE = 'JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS'


class UnsafeUrlError(ValueError):
    """Raised when a URL (or a redirect target) must not be fetched."""


def workflow_private_urls_allowed():
    """Whether workflow REST nodes may reach RFC1918 / ULA / CGNAT hosts.

    ON by default (a fresh install needs no configuration: users point REST
    nodes at intranet services as well as the internet). Opt out with
    JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS=0 (or "false"), e.g. in
    ~/.jacarium.env. Loopback, link-local (cloud metadata),
    unspecified, multicast and reserved ranges stay blocked either way.
    """
    raw = os.environ.get(_ENV_ALLOW_PRIVATE)
    if raw is None or not raw.strip():
        return True
    return raw.strip().lower() not in ('0', 'false', 'no', 'off')


def classify_address(ip_text):
    """'public' | 'private' | 'loopback' | 'blocked' | 'invalid' for a literal IP.

    'loopback' and 'blocked' are both always rejected by validate_url;
    loopback is only distinguished for the allow_loopback test hook.
    """
    try:
        ip = ipaddress.ip_address(str(ip_text).split('%', 1)[0])
    except ValueError:
        return 'invalid'
    if ip.is_loopback:
        return 'loopback'
    # Unwrap IPv4-mapped / NAT64 addresses and judge the embedded IPv4.
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return classify_address(str(ip.ipv4_mapped))
        if ip in ipaddress.ip_network('64:ff9b::/96'):
            return classify_address(str(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)))
        if ip in ipaddress.ip_network('::/96'):
            return 'blocked'
    if ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
        return 'blocked'
    if isinstance(ip, ipaddress.IPv4Address):
        for cidr in ('192.0.0.0/24', '192.0.2.0/24', '198.18.0.0/15', '198.51.100.0/24',
                     '203.0.113.0/24', '240.0.0.0/4'):
            if ip in ipaddress.ip_network(cidr):
                return 'blocked'
        if ip in ipaddress.ip_network('100.64.0.0/10'):
            return 'private'
    else:
        if ip in ipaddress.ip_network('2001:db8::/32'):
            return 'blocked'
    if ip.is_private:
        return 'private'
    return 'public'


def _rejection_message(kind):
    if kind == 'private':
        return ('URLs pointing to private networks are not allowed for this request '
                f'(workflow nodes allow them unless {_ENV_ALLOW_PRIVATE}=0)')
    return 'URLs pointing to loopback, private or internal networks are not allowed'


def validate_url(url, allow_private=False, allow_loopback=False):
    """Return (parsed_url, [resolved addresses]) or raise UnsafeUrlError.

    allow_loopback exists ONLY so the regression tests can exercise the
    request machinery against a local test server; no route passes it.
    """
    try:
        parsed = urlparse(str(url))
    except ValueError:
        raise UnsafeUrlError('Invalid URL')
    if parsed.scheme not in ('http', 'https'):
        raise UnsafeUrlError('Only http:// and https:// URLs are allowed')
    if parsed.username or parsed.password:
        raise UnsafeUrlError('URLs with embedded credentials are not allowed')
    hostname = parsed.hostname
    if not hostname:
        raise UnsafeUrlError('Invalid URL host')
    lowered = hostname.lower()
    if not allow_loopback and (lowered == 'localhost' or lowered.endswith('.localhost')):
        raise UnsafeUrlError(_rejection_message('blocked'))
    try:
        port = parsed.port
    except ValueError:
        raise UnsafeUrlError('Invalid URL port')

    addresses = []
    if classify_address(hostname) != 'invalid':
        addresses = [hostname]
    else:
        try:
            infos = socket.getaddrinfo(hostname, port or (443 if parsed.scheme == 'https' else 80),
                                       proto=socket.IPPROTO_TCP)
        except (socket.gaierror, UnicodeError, ValueError):
            raise UnsafeUrlError('Could not resolve URL host')
        addresses = sorted({info[4][0] for info in infos})
        if not addresses:
            raise UnsafeUrlError('Could not resolve URL host')

    for address in addresses:
        kind = classify_address(address)
        if kind == 'public' or (kind == 'private' and allow_private) \
                or (kind == 'loopback' and allow_loopback):
            continue
        raise UnsafeUrlError(_rejection_message(kind))
    return parsed, addresses


class SafeResponse:
    """Minimal response object returned by safe_request()."""

    def __init__(self, status_code, reason, headers, content, url):
        self.status_code = status_code
        self.reason = reason
        self.headers = headers
        self.content = content
        self.url = url

    @property
    def ok(self):
        return 200 <= self.status_code < 300

    @property
    def text(self):
        encoding = None
        content_type = self.headers.get('content-type', '') if self.headers else ''
        if 'charset=' in content_type:
            encoding = content_type.split('charset=', 1)[1].split(';', 1)[0].strip().strip('"\'')
        for candidate in (encoding, 'utf-8'):
            if not candidate:
                continue
            try:
                return self.content.decode(candidate)
            except (LookupError, UnicodeDecodeError):
                continue
        return self.content.decode('utf-8', errors='replace')

    def json(self):
        import json
        return json.loads(self.text)

    def raise_for_status(self):
        if not self.ok:
            import requests
            raise requests.exceptions.HTTPError(
                f'{self.status_code} Error for url: {self.url}', response=self)


def safe_request(method, url, headers=None, data=None, timeout=30, allow_private=False,
                 max_bytes=DEFAULT_MAX_BYTES, max_redirects=MAX_REDIRECTS,
                 allow_loopback=False):
    """Guarded HTTP request. Raises UnsafeUrlError, ResponseTooLarge (as
    ValueError) or requests exceptions."""
    import requests

    current = str(url)
    current_method = method.upper()
    body = data
    session = requests.Session()
    session.trust_env = False  # never route through ambient proxies
    try:
        for hop in range(max_redirects + 1):
            try:
                validate_url(current, allow_private=allow_private, allow_loopback=allow_loopback)
            except UnsafeUrlError as e:
                if hop == 0:
                    raise
                raise UnsafeUrlError(f'Redirect target rejected: {e}')

            response = session.request(
                current_method, current, headers=headers, data=body, timeout=timeout,
                allow_redirects=False, stream=True)
            try:
                location = response.headers.get('location')
                if response.status_code in (301, 302, 303, 307, 308) and location:
                    if hop == max_redirects:
                        raise ValueError(f'Too many redirects (limit {max_redirects})')
                    current = urljoin(current, location)
                    if response.status_code == 303 or (
                            response.status_code in (301, 302) and current_method == 'POST'):
                        current_method = 'GET'
                        body = None
                    continue

                declared = response.headers.get('content-length')
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise ValueError(f'Response exceeded {max_bytes} bytes')
                chunks = []
                received = 0
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if not chunk:
                        continue
                    received += len(chunk)
                    if received > max_bytes:
                        raise ValueError(f'Response exceeded {max_bytes} bytes')
                    chunks.append(chunk)
                return SafeResponse(response.status_code, response.reason,
                                    response.headers, b''.join(chunks), current)
            finally:
                response.close()
        raise ValueError(f'Too many redirects (limit {max_redirects})')
    finally:
        session.close()
