#!/usr/bin/env python3
"""
Guards OpenID Connect sign-in for accounts mode (backend/oidc.py,
backend/auth.py, backend/accounts.py).

What this test proves (Flask test client, throwaway HOME, a synthetic RSA
IdP stubbed through ``requests``):
  - /api/capabilities reports oidc.enabled / buttonLabel / passwordLogin;
  - /api/auth/oidc/start redirects to the IdP with state, nonce and PKCE;
  - callback with a valid code creates a JIT user (no password), sets the
    session cookie, and a second login matches by oidc_subject;
  - an existing username without oidc_subject is linked on first SSO;
  - a disabled account is refused; bad state is refused;
  - JACARIUM_OIDC_DISABLE_PASSWORD_LOGIN blocks /api/auth/login;
  - an OIDC-only user can set a first password without a current one.

Self-contained: run with a Python that has the backend deps
(cryptography, requests, Flask):
  python3 tests/accounts_oidc.test.py
  # or: backend/venv/bin/python tests/accounts_oidc.test.py
"""
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import time
import urllib.parse
from unittest import mock

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-oidc-')
HOME = os.path.join(TMP, 'data')
os.makedirs(HOME)
os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'accounts'
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(HOME, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, '.ssh', 'known_hosts')
os.environ['JACARIUM_PUBLIC_URL'] = 'https://console.test'
os.environ['JACARIUM_OIDC_ISSUER'] = 'https://idp.example.com'
os.environ['JACARIUM_OIDC_CLIENT_ID'] = 'jacarium-test'
os.environ['JACARIUM_OIDC_CLIENT_SECRET'] = 'test-secret'
os.environ.pop('JACARIUM_ENV_FILE', None)
os.environ.pop('JACARIUM_ACCOUNTS_DB', None)
os.environ.pop('JACARIUM_OIDC_DISABLE_PASSWORD_LOGIN', None)
os.environ.pop('JACARIUM_OIDC_BUTTON_LABEL', None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402
import accounts  # noqa: E402
import oidc  # noqa: E402

BASE = 'https://console.test'
HDR = {'X-Requested-With': 'Jacarium'}
results = []

PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PUBLIC_NUMBERS = PRIVATE_KEY.public_key().public_numbers()


def _b64url_uint(value):
    raw = value.to_bytes((value.bit_length() + 7) // 8, 'big')
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _b64url(data: bytes):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


JWKS = {
    'keys': [{
        'kty': 'RSA',
        'kid': 'test-key',
        'use': 'sig',
        'alg': 'RS256',
        'n': _b64url_uint(PUBLIC_NUMBERS.n),
        'e': _b64url_uint(PUBLIC_NUMBERS.e),
    }]
}

DISCOVERY = {
    'issuer': 'https://idp.example.com',
    'authorization_endpoint': 'https://idp.example.com/authorize',
    'token_endpoint': 'https://idp.example.com/token',
    'jwks_uri': 'https://idp.example.com/jwks',
    'response_types_supported': ['code'],
    'subject_types_supported': ['public'],
    'id_token_signing_alg_values_supported': ['RS256'],
}


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def body(response):
    try:
        return response.get_json() or {}
    except Exception:
        return {}


def new_client():
    return app_module.app.test_client()


def post(client, path, payload=None, headers=None):
    return client.post(path, json=payload or {}, headers={**HDR, **(headers or {})}, base_url=BASE)


def get(client, path, headers=None):
    return client.get(path, headers=headers or {}, base_url=BASE)


def mint_id_token(*, sub, nonce, preferred_username=None, email=None, name=None, exp_delta=3600):
    header = {'alg': 'RS256', 'kid': 'test-key', 'typ': 'JWT'}
    now = int(time.time())
    payload = {
        'iss': 'https://idp.example.com',
        'aud': 'jacarium-test',
        'sub': sub,
        'nonce': nonce,
        'iat': now,
        'exp': now + exp_delta,
    }
    if preferred_username is not None:
        payload['preferred_username'] = preferred_username
    if email is not None:
        payload['email'] = email
    if name is not None:
        payload['name'] = name
    header_b64 = _b64url(json.dumps(header, separators=(',', ':')).encode('utf-8'))
    payload_b64 = _b64url(json.dumps(payload, separators=(',', ':')).encode('utf-8'))
    signing_input = f'{header_b64}.{payload_b64}'.encode('ascii')
    signature = PRIVATE_KEY.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f'{header_b64}.{payload_b64}.{_b64url(signature)}'


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def json(self):
        return self._payload


class _IdpStubs:
    """Context manager: stub IdP HTTP and snapshot PKCE nonces for the token POST."""

    def __init__(self, id_token_factory):
        self.id_token_factory = id_token_factory
        self.verifier_nonces = {}
        self._patches = []

    def __enter__(self):
        verifier_nonces = self.verifier_nonces
        factory = self.id_token_factory
        real_begin = oidc.begin_login

        def tracking_begin():
            url = real_begin()
            with oidc._pending_lock:
                for pending in oidc._pending.values():
                    verifier_nonces[pending['code_verifier']] = pending['nonce']
            return url

        def fake_get(url, **kwargs):
            if url.endswith('/.well-known/openid-configuration'):
                return FakeResponse(DISCOVERY)
            if url.endswith('/jwks'):
                return FakeResponse(JWKS)
            raise AssertionError(f'unexpected GET {url}')

        def fake_post(url, data=None, **kwargs):
            if url != DISCOVERY['token_endpoint']:
                raise AssertionError(f'unexpected POST {url}')
            data = data or {}
            nonce = verifier_nonces.get(data.get('code_verifier'))
            if not nonce:
                return FakeResponse({'error': 'invalid_grant'}, status=400)
            token = factory(nonce=nonce, code=data.get('code'))
            return FakeResponse({'id_token': token, 'access_token': 'at', 'token_type': 'Bearer'})

        self._patches = [
            mock.patch.object(oidc, 'begin_login', tracking_begin),
            mock.patch.object(oidc.requests, 'get', fake_get),
            mock.patch.object(oidc.requests, 'post', fake_post),
        ]
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in reversed(self._patches):
            p.stop()
        return False


def install_idp_stubs(id_token_factory):
    return _IdpStubs(id_token_factory)


# --- bootstrap admin (OIDC does not create the first account) ---------------
code = open(os.path.join(HOME, 'setup-code')).read().strip()
admin_client = new_client()
r = post(admin_client, '/api/auth/setup', {
    'setupCode': code,
    'username': 'admin',
    'password': 'admin-password-1',
    'displayName': 'Admin',
})
check('setup creates the administrator', r.status_code == 201 and body(r).get('user', {}).get('username') == 'admin', r.get_data(as_text=True)[:160])

# --- capabilities ------------------------------------------------------------
anon = new_client()
caps = body(get(anon, '/api/capabilities'))
oidc_caps = (caps.get('auth') or {}).get('oidc') or {}
check('capabilities reports OIDC enabled', oidc_caps.get('enabled') is True, oidc_caps)
check('capabilities default passwordLogin true', oidc_caps.get('passwordLogin') is True, oidc_caps)
check('capabilities has a button label', bool(oidc_caps.get('buttonLabel')), oidc_caps)

# --- start redirects with PKCE ----------------------------------------------
oidc.reset_for_tests()
with install_idp_stubs(lambda **kw: mint_id_token(sub='sub-1', preferred_username='alice', name='Alice', **{k: kw[k] for k in ('nonce',) if k in kw})):
    r = get(anon, '/api/auth/oidc/start')
check('oidc/start redirects to the IdP', r.status_code in (302, 303), str(r.status_code))
location = r.headers.get('Location', '')
parsed = urllib.parse.urlparse(location)
qs = urllib.parse.parse_qs(parsed.query)
check('start hits the authorization endpoint', location.startswith(DISCOVERY['authorization_endpoint']), location[:120])
check('start sends state, nonce, PKCE S256', all(k in qs for k in ('state', 'nonce', 'code_challenge')) and qs.get('code_challenge_method') == ['S256'], qs)
state = qs['state'][0]
nonce = qs['nonce'][0]

# --- callback JIT creates alice ---------------------------------------------
def token_for_alice(*, nonce, code=None):
    return mint_id_token(sub='sub-alice', preferred_username='alice', name='Alice Example', nonce=nonce)


oidc.reset_for_tests()
# re-begin so pending matches
with install_idp_stubs(token_for_alice):
    r = get(new_client(), '/api/auth/oidc/start')
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers['Location']).query)
    state = qs['state'][0]
    login_client = new_client()
    r = get(login_client, f'/api/auth/oidc/callback?code=authcode-1&state={urllib.parse.quote(state)}')
check('callback redirects home', r.status_code in (302, 303) and (r.headers.get('Location') or '').endswith('/'), r.headers.get('Location'))
cookie = login_client.get_cookie('__Host-jacarium_session', domain='console.test')
check('callback sets the session cookie', cookie is not None and bool(cookie.value))
me = body(get(login_client, '/api/auth/me'))
user = me.get('user') or {}
check('JIT user is alice without a password', user.get('username') == 'alice' and user.get('hasPassword') is False and user.get('oidcLinked') is True, user)
check('JIT user is not an admin', user.get('role') == 'user', user)

# second SSO login finds the same account
oidc.reset_for_tests()
with install_idp_stubs(token_for_alice):
    r = get(new_client(), '/api/auth/oidc/start')
    state = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers['Location']).query)['state'][0]
    again = new_client()
    r = get(again, f'/api/auth/oidc/callback?code=authcode-2&state={urllib.parse.quote(state)}')
me2 = body(get(again, '/api/auth/me')).get('user') or {}
check('second SSO login reuses the same user id', me2.get('id') == user.get('id'), me2)

# --- link existing username -------------------------------------------------
accounts.create_user('bob', 'bob-password-1', display_name='Bob Local')
check('pre-created bob has no oidc link', accounts.get_user_by_username('bob').get('oidcLinked') is False)


def token_for_bob(*, nonce, code=None):
    return mint_id_token(sub='sub-bob', preferred_username='bob', name='Bob SSO', nonce=nonce)


oidc.reset_for_tests()
with install_idp_stubs(token_for_bob):
    r = get(new_client(), '/api/auth/oidc/start')
    state = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers['Location']).query)['state'][0]
    bob_client = new_client()
    r = get(bob_client, f'/api/auth/oidc/callback?code=authcode-bob&state={urllib.parse.quote(state)}')
bob_me = body(get(bob_client, '/api/auth/me')).get('user') or {}
check('SSO links existing bob by username', bob_me.get('username') == 'bob' and bob_me.get('oidcLinked') is True and bob_me.get('hasPassword') is True, bob_me)

# --- disabled user refused --------------------------------------------------
bob_id = bob_me['id']
accounts.set_user_disabled(bob_id, True)
oidc.reset_for_tests()
with install_idp_stubs(token_for_bob):
    r = get(new_client(), '/api/auth/oidc/start')
    state = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers['Location']).query)['state'][0]
    r = get(new_client(), f'/api/auth/oidc/callback?code=authcode-bob2&state={urllib.parse.quote(state)}')
loc = r.headers.get('Location') or ''
check('disabled account SSO redirects with error', 'oidc_error=' in loc, loc)
accounts.set_user_disabled(bob_id, False)

# --- bad state --------------------------------------------------------------
oidc.reset_for_tests()
with install_idp_stubs(token_for_alice):
    r = get(new_client(), f'/api/auth/oidc/callback?code=x&state=not-a-real-state')
check('bad state redirects with error', 'oidc_error=' in (r.headers.get('Location') or ''), r.headers.get('Location'))

# --- password login disable -------------------------------------------------
os.environ['JACARIUM_OIDC_DISABLE_PASSWORD_LOGIN'] = '1'
# capabilities re-reads env each call
caps = body(get(new_client(), '/api/capabilities'))
check('passwordLogin false when disabled', (caps.get('auth') or {}).get('oidc', {}).get('passwordLogin') is False, caps.get('auth'))
r = post(new_client(), '/api/auth/login', {'username': 'admin', 'password': 'admin-password-1'})
check('password login refused when disabled', r.status_code == 403 and body(r).get('code') == 'PASSWORD_LOGIN_DISABLED', body(r))
os.environ.pop('JACARIUM_OIDC_DISABLE_PASSWORD_LOGIN', None)

# --- OIDC user sets first password ------------------------------------------
alice = accounts.get_user_by_username('alice')
raw = accounts.create_session(alice['id'], 'test')
pw_client = new_client()
pw_client.set_cookie('__Host-jacarium_session', raw, domain='console.test')
r = post(pw_client, '/api/auth/password', {'newPassword': 'alice-password-1'})
check('OIDC user can set a first password without current', r.status_code == 200 and body(r).get('user', {}).get('hasPassword') is True, body(r))
r = post(new_client(), '/api/auth/login', {'username': 'alice', 'password': 'alice-password-1'})
check('alice can then sign in with the password', r.status_code == 200, body(r))

# --- audit labels exist for the actions we emitted --------------------------
audit = accounts.read_audit(50)
actions = {e['action'] for e in audit}
check('audit contains oidc-user-created', 'oidc-user-created' in actions, actions)
check('audit contains oidc-user-linked', 'oidc-user-linked' in actions, actions)
check('audit contains oidc-login', 'oidc-login' in actions, actions)

failed = [name for name, ok in results if not ok]
print()
if failed:
    print(f'{len(failed)} FAILED: {", ".join(failed)}')
    sys.exit(1)
print(f'All {len(results)} checks passed.')
sys.exit(0)
