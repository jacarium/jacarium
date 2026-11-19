"""
OpenID Connect sign-in for the browser deployment (``JACARIUM_AUTH_MODE=accounts``).

Configured entirely by environment (deploy-time secrets), never from the UI:

    JACARIUM_OIDC_ISSUER              IdP issuer URL (discovery base)
    JACARIUM_OIDC_CLIENT_ID
    JACARIUM_OIDC_CLIENT_SECRET       (or JACARIUM_OIDC_CLIENT_SECRET_FILE)
    JACARIUM_PUBLIC_URL               public origin, for redirect_uri
    JACARIUM_OIDC_SCOPES              default ``openid profile email``
    JACARIUM_OIDC_USERNAME_CLAIM      default ``preferred_username``
    JACARIUM_OIDC_DISPLAY_NAME_CLAIM  default ``name``
    JACARIUM_OIDC_BUTTON_LABEL        default ``Sign in with SSO``
    JACARIUM_OIDC_DISABLE_PASSWORD_LOGIN  when set (1/true/on), hide password login

Off unless issuer, client id, client secret and public URL are all set.
Authorization Code + PKCE (confidential client). Works with Keycloak,
Authelia, Google, VoidAuth and Pocket ID via discovery.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.parse

import requests
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers

PENDING_SECONDS = 600
DISCOVERY_TTL_SECONDS = 3600
JWKS_TTL_SECONDS = 3600
HTTP_TIMEOUT = 15

_pending_lock = threading.Lock()
_pending = {}  # state -> {code_verifier, nonce, exp}

_cache_lock = threading.Lock()
_discovery_cache = {}  # issuer -> {doc, exp}
_jwks_cache = {}  # jwks_uri -> {doc, exp}


class OidcError(ValueError):
    pass


def _env(name, default=''):
    """Read ``NAME``, or the contents of the file at ``NAME_FILE`` when set."""
    file_path = os.environ.get(f'{name}_FILE', '').strip()
    if file_path:
        try:
            with open(file_path, 'r', encoding='utf-8') as fh:
                return fh.read().strip()
        except OSError as exc:
            raise OidcError(f'cannot read {name}_FILE: {exc}') from exc
    return (os.environ.get(name) or default).strip()


def _truthy(value):
    return str(value or '').strip().lower() in ('1', 'true', 'yes', 'on')


def enabled():
    """True when OIDC is fully configured (accounts mode still required by the caller)."""
    try:
        return bool(
            _env('JACARIUM_OIDC_ISSUER')
            and _env('JACARIUM_OIDC_CLIENT_ID')
            and _env('JACARIUM_OIDC_CLIENT_SECRET')
            and _env('JACARIUM_PUBLIC_URL')
        )
    except OidcError:
        return False


def password_login_allowed():
    """Password form on the browser login page (default on)."""
    return not _truthy(_env('JACARIUM_OIDC_DISABLE_PASSWORD_LOGIN'))


def button_label():
    return _env('JACARIUM_OIDC_BUTTON_LABEL') or 'Sign in with SSO'


def capabilities():
    on = enabled()
    return {
        'enabled': on,
        'buttonLabel': button_label() if on else None,
        'passwordLogin': password_login_allowed() if on else True,
    }


def redirect_uri():
    base = _env('JACARIUM_PUBLIC_URL').rstrip('/')
    if not base:
        raise OidcError('JACARIUM_PUBLIC_URL is not set')
    return f'{base}/api/auth/oidc/callback'


def scopes():
    return _env('JACARIUM_OIDC_SCOPES') or 'openid profile email'


def username_claim():
    return _env('JACARIUM_OIDC_USERNAME_CLAIM') or 'preferred_username'


def display_name_claim():
    return _env('JACARIUM_OIDC_DISPLAY_NAME_CLAIM') or 'name'


def _b64url_decode(data):
    if isinstance(data, str):
        data = data.encode('ascii')
    pad = b'=' * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def _b64url_encode(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _pkce_pair():
    verifier = _b64url_encode(secrets.token_bytes(32))
    challenge = _b64url_encode(hashlib.sha256(verifier.encode('ascii')).digest())
    return verifier, challenge


def _require_https(url, label):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or not parsed.netloc:
        raise OidcError(f'{label} must be an https URL')
    return url.rstrip('/')


def _get_json(url):
    response = requests.get(url, timeout=HTTP_TIMEOUT, headers={'Accept': 'application/json'})
    if response.status_code != 200:
        raise OidcError(f'OIDC request to {url} failed (HTTP {response.status_code})')
    try:
        return response.json()
    except ValueError as exc:
        raise OidcError(f'OIDC response from {url} was not JSON') from exc


def discovery():
    issuer = _require_https(_env('JACARIUM_OIDC_ISSUER'), 'JACARIUM_OIDC_ISSUER')
    now = time.time()
    with _cache_lock:
        cached = _discovery_cache.get(issuer)
        if cached and cached['exp'] > now:
            return cached['doc']
    doc = _get_json(f'{issuer}/.well-known/openid-configuration')
    doc_issuer = str(doc.get('issuer') or '').rstrip('/')
    if doc_issuer and doc_issuer != issuer:
        # Google and some IdPs return the issuer without a trailing slash difference only
        if doc_issuer.rstrip('/') != issuer:
            raise OidcError(f'discovery issuer {doc_issuer!r} does not match JACARIUM_OIDC_ISSUER')
    for key in ('authorization_endpoint', 'token_endpoint', 'jwks_uri'):
        if not doc.get(key):
            raise OidcError(f'discovery document missing {key}')
    with _cache_lock:
        _discovery_cache[issuer] = {'doc': doc, 'exp': now + DISCOVERY_TTL_SECONDS}
    return doc


def jwks(jwks_uri):
    now = time.time()
    with _cache_lock:
        cached = _jwks_cache.get(jwks_uri)
        if cached and cached['exp'] > now:
            return cached['doc']
    doc = _get_json(jwks_uri)
    if not isinstance(doc.get('keys'), list) or not doc['keys']:
        raise OidcError('JWKS document has no keys')
    with _cache_lock:
        _jwks_cache[jwks_uri] = {'doc': doc, 'exp': now + JWKS_TTL_SECONDS}
    return doc


def _purge_pending(now=None):
    now = time.time() if now is None else now
    dead = [k for k, v in _pending.items() if v['exp'] <= now]
    for k in dead:
        del _pending[k]


def begin_login():
    """
    Start the authorization-code flow. Returns the IdP authorization URL;
    stores PKCE verifier + nonce under ``state`` until callback or expiry.
    """
    if not enabled():
        raise OidcError('OIDC is not configured')
    doc = discovery()
    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    now = time.time()
    with _pending_lock:
        _purge_pending(now)
        _pending[state] = {'code_verifier': verifier, 'nonce': nonce, 'exp': now + PENDING_SECONDS}
    params = {
        'response_type': 'code',
        'client_id': _env('JACARIUM_OIDC_CLIENT_ID'),
        'redirect_uri': redirect_uri(),
        'scope': scopes(),
        'state': state,
        'nonce': nonce,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
    }
    return doc['authorization_endpoint'] + '?' + urllib.parse.urlencode(params)


def _rsa_key_from_jwk(jwk):
    if jwk.get('kty') != 'RSA':
        raise OidcError('only RSA JWKS keys are supported')
    n = int.from_bytes(_b64url_decode(jwk['n']), 'big')
    e = int.from_bytes(_b64url_decode(jwk['e']), 'big')
    return RSAPublicNumbers(e, n).public_key()


def verify_id_token(token, *, keys, issuer, audience, nonce):
    parts = str(token).split('.')
    if len(parts) != 3:
        raise OidcError('id_token is not a JWT')
    header_b64, payload_b64, sig_b64 = parts
    try:
        header = json.loads(_b64url_decode(header_b64))
        payload = json.loads(_b64url_decode(payload_b64))
        signature = _b64url_decode(sig_b64)
    except (ValueError, json.JSONDecodeError) as exc:
        raise OidcError('id_token could not be decoded') from exc
    alg = header.get('alg')
    if alg != 'RS256':
        raise OidcError(f'unsupported id_token alg {alg!r} (need RS256)')
    kid = header.get('kid')
    candidates = [k for k in keys if not kid or k.get('kid') == kid]
    if not candidates:
        raise OidcError('no matching JWKS key for id_token')
    signed = f'{header_b64}.{payload_b64}'.encode('ascii')
    last_error = None
    for jwk in candidates:
        try:
            _rsa_key_from_jwk(jwk).verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
            last_error = None
            break
        except Exception as exc:  # cryptography raises InvalidSignature
            last_error = exc
    if last_error is not None:
        raise OidcError('id_token signature is invalid') from last_error

    now = time.time()
    token_iss = str(payload.get('iss') or '').rstrip('/')
    if token_iss != issuer.rstrip('/'):
        raise OidcError('id_token issuer mismatch')
    aud = payload.get('aud')
    audiences = aud if isinstance(aud, list) else [aud]
    if audience not in audiences:
        raise OidcError('id_token audience mismatch')
    if int(payload.get('exp') or 0) < now - 30:
        raise OidcError('id_token has expired')
    if int(payload.get('iat') or now) > now + 120:
        raise OidcError('id_token iat is in the future')
    if nonce and payload.get('nonce') != nonce:
        raise OidcError('id_token nonce mismatch')
    if not payload.get('sub'):
        raise OidcError('id_token has no sub')
    return payload


def exchange_code(code, state):
    """
    Finish the flow: validate state, exchange the code, verify the id_token.
    Returns the id_token claims dict.
    """
    if not enabled():
        raise OidcError('OIDC is not configured')
    if not isinstance(code, str) or not code or not isinstance(state, str) or not state:
        raise OidcError('missing code or state')
    now = time.time()
    with _pending_lock:
        _purge_pending(now)
        pending = _pending.pop(state, None)
    if not pending:
        raise OidcError('unknown or expired OIDC state')
    doc = discovery()
    data = {
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': redirect_uri(),
        'client_id': _env('JACARIUM_OIDC_CLIENT_ID'),
        'client_secret': _env('JACARIUM_OIDC_CLIENT_SECRET'),
        'code_verifier': pending['code_verifier'],
    }
    response = requests.post(
        doc['token_endpoint'],
        data=data,
        timeout=HTTP_TIMEOUT,
        headers={'Accept': 'application/json'},
    )
    if response.status_code != 200:
        raise OidcError(f'token endpoint refused the code (HTTP {response.status_code})')
    try:
        body = response.json()
    except ValueError as exc:
        raise OidcError('token endpoint returned non-JSON') from exc
    id_token = body.get('id_token')
    if not id_token:
        raise OidcError('token endpoint returned no id_token')
    keys = jwks(doc['jwks_uri']).get('keys') or []
    return verify_id_token(
        id_token,
        keys=keys,
        issuer=_env('JACARIUM_OIDC_ISSUER'),
        audience=_env('JACARIUM_OIDC_CLIENT_ID'),
        nonce=pending['nonce'],
    )


_USERNAME_FALLBACK_RE = re.compile(r'[^a-z0-9._-]+')


def username_from_claims(claims):
    """
    A Jacarium username from the id_token claims: preferred claim, then
    preferred_username, then the local-part of email, else a stable fallback
    from ``sub``.
    """
    from accounts import USERNAME_RE, normalize_username, AccountsError

    candidates = []
    preferred = claims.get(username_claim())
    if isinstance(preferred, str) and preferred.strip():
        candidates.append(preferred.strip())
    if username_claim() != 'preferred_username':
        pu = claims.get('preferred_username')
        if isinstance(pu, str) and pu.strip():
            candidates.append(pu.strip())
    email = claims.get('email')
    if isinstance(email, str) and '@' in email:
        candidates.append(email.split('@', 1)[0])

    for raw in candidates:
        cleaned = _USERNAME_FALLBACK_RE.sub('-', raw.strip().lower()).strip('.-_')[:32]
        if not cleaned:
            continue
        if cleaned[0] in '.-_':
            cleaned = 'u' + cleaned[1:]
        try:
            return normalize_username(cleaned)
        except AccountsError:
            continue

    digest = hashlib.sha256(str(claims.get('sub')).encode('utf-8')).hexdigest()[:10]
    fallback = f'u{digest}'
    if not USERNAME_RE.match(fallback):
        raise OidcError('could not derive a username from the identity token')
    return fallback


def display_name_from_claims(claims, fallback):
    from accounts import clean_display_name

    value = claims.get(display_name_claim())
    if not isinstance(value, str) or not value.strip():
        value = claims.get('name')
    return clean_display_name(value if isinstance(value, str) else '', fallback)


def reset_for_tests():
    """Drop caches and pending logins (tests)."""
    with _pending_lock:
        _pending.clear()
    with _cache_lock:
        _discovery_cache.clear()
        _jwks_cache.clear()
