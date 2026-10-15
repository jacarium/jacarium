"""
WHOIS lookup for the app in a browser: the same raw port-43 query the
desktop app makes from the Electron main process ('whois-lookup' in
electron/main.cjs) - TLD -> registry server map, one referral hop, 10 s
timeout. Strict domain validation.
"""
import re
import socket

from flask import Blueprint, jsonify, request

whois_api = Blueprint('whois_api', __name__)

_DOMAIN_RE = re.compile(r'^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
_SERVER_RE = re.compile(r'^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
_TIMEOUT_SECONDS = 10
_MAX_BYTES = 256 * 1024

WHOIS_SERVERS = {
    'com': 'whois.verisign-grs.com', 'net': 'whois.verisign-grs.com', 'org': 'whois.pir.org',
    'info': 'whois.afilias.net', 'biz': 'whois.biz', 'us': 'whois.nic.us', 'uk': 'whois.nic.uk',
    'io': 'whois.nic.io', 'dev': 'whois.nic.google', 'app': 'whois.nic.google', 'ai': 'whois.nic.ai',
    'me': 'whois.nic.me', 'tv': 'whois.nic.tv', 'cc': 'whois.nic.cc', 'de': 'whois.denic.de',
    'fr': 'whois.nic.fr', 'eu': 'whois.eu', 'ru': 'whois.tcinet.ru', 'nl': 'whois.domain-registry.nl',
    'br': 'whois.registro.br', 'au': 'whois.auda.org.au', 'cn': 'whois.cnnic.cn', 'jp': 'whois.jprs.jp',
    'kr': 'whois.kr', 'in': 'whois.registry.in', 'ca': 'whois.cira.ca',
}
_REFERRAL_RE = re.compile(r'(?:Registrar WHOIS Server|refer|ReferralServer):\s*(?:whois://)?(\S+)', re.IGNORECASE)


def validate_domain(domain):
    text = (domain or '').strip().lower().rstrip('.')
    if not _DOMAIN_RE.match(text):
        raise ValueError('enter a domain name such as example.com')
    return text


def server_for(domain):
    tld = domain.rsplit('.', 1)[-1]
    return WHOIS_SERVERS.get(tld, 'whois.iana.org')


def query(server, domain, timeout=_TIMEOUT_SECONDS):
    chunks = []
    total = 0
    with socket.create_connection((server, 43), timeout=timeout) as sock:
        sock.sendall(f'{domain}\r\n'.encode('ascii'))
        while True:
            data = sock.recv(4096)
            if not data:
                break
            total += len(data)
            if total > _MAX_BYTES:
                break
            chunks.append(data)
    return b''.join(chunks).decode('utf-8', 'replace')


def lookup(domain):
    clean = validate_domain(domain)
    server = server_for(clean)
    result = query(server, clean)
    match = _REFERRAL_RE.search(result)
    if match:
        referral = match.group(1).strip().lower().rstrip('/')
        referral = referral.split('/')[0].split(':')[0]
        if referral != server and _SERVER_RE.match(referral):
            try:
                detail = query(referral, clean)
                if detail.strip():
                    result = f'{result}\n\n% Referral from {server} to {referral}\n\n{detail}'
            except (OSError, socket.timeout):
                pass
    return result


@whois_api.route('/api/whois', methods=['POST'])
def whois_route():
    body = request.get_json(silent=True) or {}
    try:
        clean = validate_domain(body.get('domain'))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    try:
        return jsonify({'domain': clean, 'result': lookup(clean)})
    except socket.timeout:
        return jsonify({'error': 'WHOIS query timed out'}), 504
    except OSError as exc:
        return jsonify({'error': f'WHOIS query failed: {exc.__class__.__name__}'}), 502
