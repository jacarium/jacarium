"""
Account tickets for the central server that runs behind this console
(deploy/Caddyfile forwards /central/* to jacarium-central).

A signed-in user is recognised by the central server through a ticket, and
nothing else: this module mints a short-lived ticket naming the account's
identity on the central server (`<username>@account-<id>`, the formula
src/utils/cloudCentralSync.js uses), signed with a key the two share
(generated at deploy time by deploy/remote-host.sh). jacarium-central/
account-tickets.js verifies exactly this format:

    v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(key, "v1." + payload))>
    payload: { iss, sub, u, n, mid, iat, exp }   (times in seconds)

Environment:
    JACARIUM_CENTRAL_PATH        the path the console forwards to the central
                                 server (set = a central server is provided)
    JACARIUM_CENTRAL_TICKET_KEY  64 hex characters; without it the provided
                                 central server accepts no account sign-in
                                 and the app has no team features
"""
import base64
import hashlib
import hmac
import json
import os
import re
import time

TICKET_SECONDS = 10 * 60
ISSUER = 'jacarium-home'


def central_path():
    """The path of the provided central server ('' when none is provided)."""
    path = os.environ.get('JACARIUM_CENTRAL_PATH', '').strip()
    if not path:
        return ''
    if not re.fullmatch(r'/[A-Za-z0-9._-]+', path):
        return ''
    return path


def _key():
    raw = os.environ.get('JACARIUM_CENTRAL_TICKET_KEY', '').strip()
    if not re.fullmatch(r'[0-9a-fA-F]{64}', raw):
        return None
    return bytes.fromhex(raw)


def central_provided():
    return bool(central_path())


def account_sign_in_available():
    """True when signed-in users are recognised by the provided central server."""
    return central_provided() and _key() is not None


def capabilities():
    """What /api/capabilities and /api/version report under 'central'."""
    if not central_provided():
        return {'provided': False}
    return {'provided': True, 'path': central_path(), 'accountSignIn': _key() is not None}


def machine_id_for(user):
    """The account's identity on the central server: `<username>@account-<id prefix>`."""
    tag = re.sub(r'[^0-9a-zA-Z]', '', str(user['id']))[:12].lower()
    return f"{user['username']}@account-{tag}"


def _b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _b64url_decode(text):
    text = str(text)
    return base64.urlsafe_b64decode(text + '=' * ((4 - len(text) % 4) % 4))


def mint(user, now=None, lifetime=TICKET_SECONDS):
    """A ticket for `user`: (ticket, expires_at, machine_id). Raises RuntimeError without a key."""
    key = _key()
    if key is None:
        raise RuntimeError('no central ticket key configured')
    now = int(time.time() if now is None else now)
    machine_id = machine_id_for(user)
    payload = {
        'iss': ISSUER,
        'sub': str(user['id']),
        'u': user['username'],
        'n': user.get('displayName') or '',
        'mid': machine_id,
        'iat': now,
        'exp': now + int(lifetime),
    }
    body = _b64url(json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8'))
    signature = hmac.new(key, f'v1.{body}'.encode('ascii'), hashlib.sha256).digest()
    return f'v1.{body}.{_b64url(signature)}', payload['exp'], machine_id


def verify(ticket, now=None):
    """The payload of a valid ticket, or None (the central server does the same check in JavaScript)."""
    key = _key()
    if key is None or not isinstance(ticket, str):
        return None
    parts = ticket.split('.')
    if len(parts) != 3 or parts[0] != 'v1':
        return None
    expected = hmac.new(key, f'v1.{parts[1]}'.encode('ascii'), hashlib.sha256).digest()
    try:
        given = _b64url_decode(parts[2])
    except (ValueError, TypeError):
        return None
    if not hmac.compare_digest(given, expected):
        return None
    try:
        payload = json.loads(_b64url_decode(parts[1]).decode('utf-8'))
    except (ValueError, TypeError):
        return None
    now = time.time() if now is None else now
    if not isinstance(payload, dict) or payload.get('iss') != ISSUER or float(payload.get('exp', 0)) <= now:
        return None
    return payload
