"""
Single sign-on with OpenID Connect for the browser deployment
(``JACARIUM_AUTH_MODE=accounts``): Authorization Code + PKCE against one
identity provider, found through discovery. Requested in
https://github.com/jacarium/jacarium/issues/46.

Configured by the deployment's environment only, never from the UI (every
value may also come from the file named by ``<NAME>_FILE``, for container
secrets):

    JACARIUM_OIDC_ISSUER          the provider's issuer URL (https)
    JACARIUM_OIDC_CLIENT_ID
    JACARIUM_OIDC_CLIENT_SECRET
    JACARIUM_PUBLIC_URL           this server's public origin (the redirect
                                  URI is <it>/api/auth/sso/callback)
  optional
    JACARIUM_OIDC_SCOPES          default "openid profile email"
    JACARIUM_OIDC_BUTTON_LABEL    default "Sign in with SSO"
    JACARIUM_OIDC_USERNAME_CLAIM  default preferred_username (new accounts)
    JACARIUM_OIDC_GROUPS_CLAIM    default groups
  who gets in (default: only accounts that are already linked)
    JACARIUM_OIDC_AUTO_CREATE     1: an allowed identity without an account
                                  gets one at its first sign-in (role user)
    JACARIUM_OIDC_ALLOWED_GROUPS  comma list: membership of one is required
    JACARIUM_OIDC_ALLOWED_EMAIL_DOMAINS  comma list: the VERIFIED email's
                                  domain must be one of them
    JACARIUM_OIDC_REQUIRED_CLAIM  name=value: that claim must hold that value
    JACARIUM_OIDC_ADMIN_GROUPS    comma list: a member is made administrator
                                  at sign-in (never demoted by SSO)
  other
    JACARIUM_OIDC_DISABLE_PASSWORD_LOGIN  1: passwords sign in administrators
                                  only (the way back in when the provider is
                                  down); everyone else uses SSO
    JACARIUM_OIDC_END_SESSION     1: signing out also ends the provider's
                                  session (its end_session_endpoint)
    JACARIUM_OIDC_ALLOW_INSECURE_LOCALHOST  1: accept http:// for a provider
                                  on localhost / 127.0.0.1 (development)

What an account is matched by: the pair (issuer, subject) and nothing else
(backend/accounts.py). A username or an email in a token never selects an
existing account; linking happens from a signed-in account's settings, or
through an administrator's one-time approval for a verified email.

The flow keeps no server-side state. state, nonce, the PKCE verifier, the
purpose (sign in / link / confirm) and the account that asked are sealed
(Fernet: AES-CBC + HMAC-SHA256, with a key this server generates once and
keeps in accounts.sqlite) into a short-lived HttpOnly cookie, so the callback
only completes in the browser that started it, on any worker, across a
restart. A state that was used once is remembered for its lifetime and
refused again (bounded; per process - the provider refuses a second use of
the code anyway).

The ID token is verified with PyJWT: RS256, PS256 or ES256 only, the key
picked by ``kid`` from the provider's JWKS (fetched again, rate limited, when
the kid is unknown: key rotation), issuer, audience, ``azp``, expiry and
issue time with a minute of leeway, and the nonce.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import threading
import time
import urllib.parse

import requests

# PyJWT and cryptography are imported where they are used: this module is loaded with the backend in every mode
# (the desktop app and servers without single sign-on included), and they must cost those nothing.

FLOW_SECONDS = 600                 # the state cookie's life: time to sign in at the provider
FRESH_SECONDS = 600                # how long "a fresh SSO round-trip" lasts for a session
DISCOVERY_TTL_SECONDS = 3600
JWKS_TTL_SECONDS = 3600
JWKS_REFETCH_SECONDS = 60          # an unknown kid refetches the keys at most this often
HTTP_TIMEOUT = 10
MAX_RESPONSE_BYTES = 512 * 1024
CLOCK_SKEW_SECONDS = 60
ALGORITHMS = ('RS256', 'PS256', 'ES256')
USED_STATES_MAX = 4096
PURPOSES = ('login', 'link', 'confirm')
STATE_COOKIE = '__Host-jacarium_sso'
CALLBACK_PATH = '/api/auth/sso/callback'

_lock = threading.Lock()
_discovery_cache = {}   # issuer -> (document, expiry)
_jwks_cache = {}        # jwks_uri -> (keys by kid, expiry, fetched at)
_used_states = {}       # sha256(state) -> expiry


class OidcError(Exception):
    """A refusal, with a short code the login page maps to its own text (never the provider's free text)."""

    def __init__(self, code, detail=''):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail or code


# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------
def _env(name, default=''):
    """NAME, or the contents of the file NAME_FILE names (container secrets)."""
    file_path = (os.environ.get(f'{name}_FILE') or '').strip()
    if file_path:
        try:
            with open(file_path, 'r', encoding='utf-8') as fh:
                return fh.read().strip()
        except OSError as exc:
            raise OidcError('config', f'cannot read {name}_FILE: {exc.strerror or exc}') from exc
    return (os.environ.get(name) or default).strip()


def _truthy(value):
    return str(value or '').strip().lower() in ('1', 'true', 'yes', 'on')


def _list(value):
    return [item.strip() for item in str(value or '').split(',') if item.strip()]


def _local_host(host):
    if host == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def check_url(url, label):
    """An https URL - or, with the development override, http on localhost. Returned without a trailing slash."""
    parsed = urllib.parse.urlparse(str(url or ''))
    if parsed.scheme == 'https' and parsed.hostname:
        return str(url).rstrip('/')
    if parsed.scheme == 'http' and parsed.hostname and _local_host(parsed.hostname) and _truthy(_env('JACARIUM_OIDC_ALLOW_INSECURE_LOCALHOST')):
        return str(url).rstrip('/')
    raise OidcError('config', f'{label} must be an https URL')


def config():
    """The settings, read at every call (a test or a redeploy changes the environment). OidcError when incomplete."""
    issuer = _env('JACARIUM_OIDC_ISSUER')
    client_id = _env('JACARIUM_OIDC_CLIENT_ID')
    client_secret = _env('JACARIUM_OIDC_CLIENT_SECRET')
    public_url = _env('JACARIUM_PUBLIC_URL')
    missing = [name for name, value in (('JACARIUM_OIDC_ISSUER', issuer), ('JACARIUM_OIDC_CLIENT_ID', client_id),
                                        ('JACARIUM_OIDC_CLIENT_SECRET', client_secret), ('JACARIUM_PUBLIC_URL', public_url)) if not value]
    if missing:
        raise OidcError('config', 'not set: ' + ', '.join(missing))
    required = _env('JACARIUM_OIDC_REQUIRED_CLAIM')
    if required and '=' not in required:
        raise OidcError('config', 'JACARIUM_OIDC_REQUIRED_CLAIM must be name=value')
    return {
        'issuer': check_url(issuer, 'JACARIUM_OIDC_ISSUER'),
        'client_id': client_id,
        'client_secret': client_secret,
        'public_url': check_url(public_url, 'JACARIUM_PUBLIC_URL'),
        'scopes': _env('JACARIUM_OIDC_SCOPES') or 'openid profile email',
        'button_label': (_env('JACARIUM_OIDC_BUTTON_LABEL') or 'Sign in with SSO')[:60],
        'username_claim': _env('JACARIUM_OIDC_USERNAME_CLAIM') or 'preferred_username',
        'groups_claim': _env('JACARIUM_OIDC_GROUPS_CLAIM') or 'groups',
        'auto_create': _truthy(_env('JACARIUM_OIDC_AUTO_CREATE')),
        'allowed_groups': _list(_env('JACARIUM_OIDC_ALLOWED_GROUPS')),
        'allowed_domains': [d.lower().lstrip('@') for d in _list(_env('JACARIUM_OIDC_ALLOWED_EMAIL_DOMAINS'))],
        'required_claim': tuple(part.strip() for part in required.split('=', 1)) if required else None,
        'admin_groups': _list(_env('JACARIUM_OIDC_ADMIN_GROUPS')),
        'password_login': not _truthy(_env('JACARIUM_OIDC_DISABLE_PASSWORD_LOGIN')),
        'end_session': _truthy(_env('JACARIUM_OIDC_END_SESSION')),
    }


def enabled():
    try:
        config()
        return True
    except OidcError:
        return False


def configured_but_broken():
    """A message when some of the settings are there but they do not add up (logged at start), else None."""
    names = ('JACARIUM_OIDC_ISSUER', 'JACARIUM_OIDC_CLIENT_ID', 'JACARIUM_OIDC_CLIENT_SECRET')
    if not any(os.environ.get(n) or os.environ.get(f'{n}_FILE') for n in names):
        return None
    try:
        config()
        return None
    except OidcError as exc:
        return exc.detail


def startup_summary():
    """One log line at the start: off, misconfigured (why), or who gets in."""
    broken = configured_but_broken()
    if broken:
        return f'[Accounts] single sign-on: NOT active - {broken}'
    if not enabled():
        return '[Accounts] single sign-on: off (JACARIUM_OIDC_ISSUER, _CLIENT_ID, _CLIENT_SECRET and JACARIUM_PUBLIC_URL are not all set)'
    cfg = config()
    rules = [f"groups {', '.join(cfg['allowed_groups'])}"] if cfg['allowed_groups'] else []
    rules += [f"verified email domains {', '.join(cfg['allowed_domains'])}"] if cfg['allowed_domains'] else []
    rules += [f"claim {cfg['required_claim'][0]}={cfg['required_claim'][1]}"] if cfg['required_claim'] else []
    who = 'linked accounts only' if not cfg['auto_create'] else 'accounts are created at the first sign-in'
    line = f"[Accounts] single sign-on: on, issuer {cfg['issuer']}; {who}; allow-list: {'; '.join(rules) if rules else 'none'}"
    if cfg['auto_create'] and not rules:
        line += ' - WARNING: every identity of that provider gets an account (set an allow-list unless the provider is yours alone)'
    if cfg['admin_groups']:
        line += f"; administrators by group: {', '.join(cfg['admin_groups'])}"
    if not cfg['password_login']:
        line += '; passwords sign in administrators only'
    return line


def password_login_allowed():
    """False when passwords are for administrators only (the provider is the way in for everyone else)."""
    try:
        return config()['password_login']
    except OidcError:
        return True


def capabilities():
    """What the login page and Settings need to know (no secret, no endpoint)."""
    try:
        cfg = config()
    except OidcError:
        return {'enabled': False, 'passwordLogin': True}
    return {
        'enabled': True,
        'buttonLabel': cfg['button_label'],
        'passwordLogin': cfg['password_login'],
        'issuer': cfg['issuer'],
        'autoCreate': cfg['auto_create'],
    }


def redirect_uri(cfg):
    return cfg['public_url'] + CALLBACK_PATH


# ---------------------------------------------------------------------------
# the provider's documents
# ---------------------------------------------------------------------------
def _fetch_json(url, *, method='GET', data=None):
    """A JSON document from the provider: no redirects followed, a timeout, a size cap."""
    try:
        if method == 'POST':
            response = requests.post(url, data=data, timeout=HTTP_TIMEOUT, allow_redirects=False, headers={'Accept': 'application/json'})
        else:
            response = requests.get(url, timeout=HTTP_TIMEOUT, allow_redirects=False, headers={'Accept': 'application/json'})
    except requests.RequestException as exc:
        raise OidcError('provider', f'the identity provider could not be reached ({type(exc).__name__})') from exc
    if response.status_code != 200:
        raise OidcError('provider', f'the identity provider answered HTTP {response.status_code}')
    body = response.content if isinstance(getattr(response, 'content', None), (bytes, bytearray)) else None
    if body is not None and len(body) > MAX_RESPONSE_BYTES:
        raise OidcError('provider', 'the identity provider sent an oversized document')
    try:
        document = response.json()
    except ValueError as exc:
        raise OidcError('provider', 'the identity provider did not answer with JSON') from exc
    if not isinstance(document, dict):
        raise OidcError('provider', 'the identity provider did not answer with a JSON object')
    return document


def discovery(cfg):
    issuer = cfg['issuer']
    now = time.time()
    with _lock:
        cached = _discovery_cache.get(issuer)
        if cached and cached[1] > now:
            return cached[0]
    document = _fetch_json(issuer + '/.well-known/openid-configuration')
    if str(document.get('issuer') or '').rstrip('/') != issuer:
        raise OidcError('provider', 'the discovery document names another issuer than JACARIUM_OIDC_ISSUER')
    for key in ('authorization_endpoint', 'token_endpoint', 'jwks_uri'):
        document[key] = check_url(document.get(key), f'the provider\'s {key}')
    if document.get('end_session_endpoint'):
        try:
            document['end_session_endpoint'] = check_url(document['end_session_endpoint'], 'end_session_endpoint')
        except OidcError:
            document.pop('end_session_endpoint')
    with _lock:
        _discovery_cache[issuer] = (document, now + DISCOVERY_TTL_SECONDS)
    return document


def _load_jwks(jwks_uri, now):
    document = _fetch_json(jwks_uri)
    keys = {}
    for entry in document.get('keys') if isinstance(document.get('keys'), list) else []:
        if isinstance(entry, dict) and entry.get('use', 'sig') == 'sig' and entry.get('kty') in ('RSA', 'EC'):
            keys[str(entry.get('kid') or '')] = entry
    if not keys:
        raise OidcError('provider', 'the identity provider publishes no signing key')
    with _lock:
        _jwks_cache[jwks_uri] = (keys, now + JWKS_TTL_SECONDS, now)
    return keys


def signing_key(jwks_uri, kid):
    """The JWK for kid. An unknown kid fetches the keys again (rotation), at most once a minute."""
    now = time.time()
    with _lock:
        cached = _jwks_cache.get(jwks_uri)
    keys = cached[0] if cached and cached[1] > now else _load_jwks(jwks_uri, now)
    wanted = str(kid or '')
    if wanted not in keys and not (not wanted and len(keys) == 1):
        fetched_at = cached[2] if cached else now
        if cached and now - fetched_at >= JWKS_REFETCH_SECONDS:
            keys = _load_jwks(jwks_uri, now)
    if wanted in keys:
        return keys[wanted]
    if not wanted and len(keys) == 1:
        return next(iter(keys.values()))
    raise OidcError('token', 'the ID token is signed with a key the provider does not publish')


# ---------------------------------------------------------------------------
# the ID token
# ---------------------------------------------------------------------------
def verify_id_token(token, *, cfg, jwks_uri, nonce):
    """The verified claims. Anything that does not check out is an OidcError('token')."""
    import jwt
    if not isinstance(token, str) or token.count('.') != 2 or len(token) > 16384:
        raise OidcError('token', 'the provider returned no usable ID token')
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise OidcError('token', 'the ID token could not be read') from exc
    alg = header.get('alg')
    if alg not in ALGORITHMS:
        raise OidcError('token', f'the ID token uses {alg!r}: only RS256, PS256 and ES256 are accepted')
    jwk = signing_key(jwks_uri, header.get('kid'))
    if (jwk.get('kty') == 'RSA') != (alg in ('RS256', 'PS256')) or (jwk.get('alg') and jwk['alg'] != alg):
        raise OidcError('token', 'the ID token\'s algorithm does not fit its key')
    try:
        key = jwt.PyJWK(jwk, algorithm=alg).key
        claims = jwt.decode(
            token, key, algorithms=[alg], audience=cfg['client_id'], issuer=cfg['issuer'], leeway=CLOCK_SKEW_SECONDS,
            options={'require': ['exp', 'iat', 'iss', 'aud', 'sub'], 'verify_signature': True, 'verify_exp': True,
                     'verify_iat': True, 'verify_aud': True, 'verify_iss': True})
    except jwt.ExpiredSignatureError as exc:
        raise OidcError('token', 'the ID token has expired') from exc
    except jwt.InvalidAudienceError as exc:
        raise OidcError('token', 'the ID token is for another client') from exc
    except jwt.InvalidIssuerError as exc:
        raise OidcError('token', 'the ID token comes from another issuer') from exc
    except jwt.InvalidSignatureError as exc:
        raise OidcError('token', 'the ID token\'s signature is wrong') from exc
    except (jwt.PyJWTError, ValueError, TypeError) as exc:
        raise OidcError('token', f'the ID token was refused ({type(exc).__name__})') from exc
    audiences = claims['aud'] if isinstance(claims['aud'], list) else [claims['aud']]
    azp = claims.get('azp')
    if azp is not None and azp != cfg['client_id']:
        raise OidcError('token', 'the ID token was issued to another party (azp)')
    if len(audiences) > 1 and azp != cfg['client_id']:
        raise OidcError('token', 'the ID token has several audiences and no azp naming this client')
    if not isinstance(claims.get('nonce'), str) or not hmac.compare_digest(claims['nonce'], nonce):
        raise OidcError('token', 'the ID token does not carry this sign-in\'s nonce')
    if not isinstance(claims.get('sub'), str) or not claims['sub'].strip() or len(claims['sub']) > 255:
        raise OidcError('token', 'the ID token has no usable subject')
    return claims


# ---------------------------------------------------------------------------
# the flow: everything it needs travels in a sealed cookie
# ---------------------------------------------------------------------------
def _fernet():
    import accounts
    from cryptography.fernet import Fernet
    return Fernet(accounts.server_key('sso-state', lambda: Fernet.generate_key().decode('ascii')).encode('ascii'))


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def begin(purpose, *, user_id=None, session=None):
    """
    Start a round-trip to the provider. Returns (authorization URL, the sealed cookie value).
    purpose: 'login'; 'link' (attach the identity to user_id); 'confirm' (a fresh sign-in for `session`).
    """
    if purpose not in PURPOSES:
        raise OidcError('request', 'unknown purpose')
    cfg = config()
    document = discovery(cfg)
    verifier = _b64url(secrets.token_bytes(32))
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    sealed = _fernet().encrypt(json.dumps({
        's': state, 'n': nonce, 'v': verifier, 'p': purpose, 'u': user_id,
        # the session that asked, as its hash: a link / confirm only completes in that very session
        'h': hashlib.sha256(session.encode('utf-8')).hexdigest() if session else None,
    }).encode('utf-8')).decode('ascii')
    query = urllib.parse.urlencode({
        'response_type': 'code', 'client_id': cfg['client_id'], 'redirect_uri': redirect_uri(cfg), 'scope': cfg['scopes'],
        'state': state, 'nonce': nonce,
        'code_challenge': _b64url(hashlib.sha256(verifier.encode('ascii')).digest()), 'code_challenge_method': 'S256',
        # link and confirm must show who is signing in at the provider, not ride a silent session
        **({'prompt': 'login', 'max_age': '0'} if purpose in ('link', 'confirm') else {}),
    })
    return f"{document['authorization_endpoint']}{'&' if '?' in document['authorization_endpoint'] else '?'}{query}", sealed


def open_flow(sealed, state):
    """The flow a callback belongs to: the cookie of this browser, unexpired, for exactly this state, used once."""
    if not sealed or not isinstance(sealed, str) or not state or not isinstance(state, str) or len(state) > 128:
        raise OidcError('state', 'this browser did not start the sign-in (no state cookie)')
    from cryptography.fernet import InvalidToken
    try:
        flow = json.loads(_fernet().decrypt(sealed.encode('ascii'), ttl=FLOW_SECONDS))
    except (InvalidToken, ValueError, UnicodeError) as exc:
        raise OidcError('state', 'the sign-in took too long or its cookie is not this server\'s') from exc
    if not isinstance(flow, dict) or flow.get('p') not in PURPOSES or not hmac.compare_digest(str(flow.get('s') or ''), state):
        raise OidcError('state', 'the answer does not belong to the sign-in this browser started')
    digest = hashlib.sha256(state.encode('utf-8')).hexdigest()
    now = time.time()
    with _lock:
        for key in [k for k, expiry in _used_states.items() if expiry <= now]:
            del _used_states[key]
        if digest in _used_states:
            raise OidcError('state', 'this sign-in was already completed')
        if len(_used_states) >= USED_STATES_MAX:
            del _used_states[min(_used_states, key=_used_states.get)]
        _used_states[digest] = now + FLOW_SECONDS
    return flow


def finish(code, state, sealed):
    """Complete the round-trip: (verified claims, the flow dict with p / u / h)."""
    cfg = config()
    flow = open_flow(sealed, state)
    if not isinstance(code, str) or not code or len(code) > 4096:
        raise OidcError('request', 'the provider sent no authorization code')
    document = discovery(cfg)
    body = _fetch_json(document['token_endpoint'], method='POST', data={
        'grant_type': 'authorization_code', 'code': code, 'redirect_uri': redirect_uri(cfg),
        'client_id': cfg['client_id'], 'client_secret': cfg['client_secret'], 'code_verifier': flow['v'],
    })
    claims = verify_id_token(body.get('id_token'), cfg=cfg, jwks_uri=document['jwks_uri'], nonce=flow['n'])
    if flow['p'] in ('link', 'confirm'):
        # asked for with max_age=0: the provider must have authenticated the person just now
        auth_time = claims.get('auth_time')
        if isinstance(auth_time, (int, float)) and time.time() - auth_time > FRESH_SECONDS + CLOCK_SKEW_SECONDS:
            raise OidcError('stale', 'the provider did not ask for a fresh sign-in')
    return claims, flow


def end_session_url():
    """Where signing out continues at the provider (JACARIUM_OIDC_END_SESSION and the provider offers it), else None."""
    try:
        cfg = config()
        if not cfg['end_session']:
            return None
        endpoint = discovery(cfg).get('end_session_endpoint')
    except OidcError:
        return None
    if not endpoint:
        return None
    query = urllib.parse.urlencode({'client_id': cfg['client_id'], 'post_logout_redirect_uri': cfg['public_url'] + '/'})
    return f"{endpoint}{'&' if '?' in endpoint else '?'}{query}"


# ---------------------------------------------------------------------------
# who gets in, and as what
# ---------------------------------------------------------------------------
def _groups(claims, cfg):
    value = claims.get(cfg['groups_claim'])
    if isinstance(value, str):
        return [value]
    return [g for g in value if isinstance(g, str)] if isinstance(value, list) else []


def verified_email(claims):
    """The email, only when the provider says it verified it."""
    email = claims.get('email')
    if isinstance(email, str) and '@' in email and claims.get('email_verified') is True:
        return email.strip().lower()
    return None


def access(claims, cfg=None):
    """
    {'allowed': bool, 'reason': code, 'admin': bool}: the allow-lists every SSO sign-in must pass (each one that
    is configured), and whether the identity is in an administrator group.
    """
    cfg = cfg or config()
    groups = _groups(claims, cfg)
    reason = None
    if cfg['allowed_groups'] and not set(groups) & set(cfg['allowed_groups']):
        reason = 'not_allowed_group'
    if reason is None and cfg['allowed_domains']:
        email = verified_email(claims)
        if email is None:
            reason = 'email_not_verified'
        elif email.rsplit('@', 1)[1] not in cfg['allowed_domains']:
            reason = 'not_allowed_domain'
    if reason is None and cfg['required_claim']:
        name, wanted = cfg['required_claim']
        value = claims.get(name)
        values = value if isinstance(value, list) else [value]
        if wanted not in [str(v) for v in values if isinstance(v, (str, int, float, bool))] and not (value is True and wanted.lower() == 'true'):
            reason = 'missing_claim'
    return {'allowed': reason is None, 'reason': reason, 'admin': bool(cfg['admin_groups'] and set(groups) & set(cfg['admin_groups']))}


_USERNAME_JUNK = re.compile(r'[^a-z0-9._-]+')


def new_username(claims, cfg=None):
    """A username for a NEW account from the configured claim (never a way to find an existing one)."""
    from accounts import AccountsError, normalize_username
    cfg = cfg or config()
    value = claims.get(cfg['username_claim'])
    candidates = [value] if isinstance(value, str) else []
    email = verified_email(claims)
    if email:
        candidates.append(email.split('@', 1)[0])
    for raw in candidates:
        cleaned = _USERNAME_JUNK.sub('-', raw.strip().lower()).strip('.-_')[:32]
        try:
            return normalize_username(cleaned)
        except AccountsError:
            continue
    return 'u' + hashlib.sha256(f"{cfg['issuer']}\n{claims['sub']}".encode('utf-8')).hexdigest()[:12]


def display_name(claims, fallback):
    from accounts import AccountsError, clean_display_name
    value = claims.get('name')
    try:
        return clean_display_name(value if isinstance(value, str) else '', fallback)
    except AccountsError:
        return fallback


def reset_for_tests():
    with _lock:
        _discovery_cache.clear()
        _jwks_cache.clear()
        _used_states.clear()
