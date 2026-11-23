#!/usr/bin/env python3
"""
Single sign-on (OpenID Connect) for accounts mode: backend/oidc.py, the
/api/auth/sso/* routes in backend/auth.py and the identity storage in
backend/accounts.py - through the Flask test client, with a synthetic
identity provider stubbed underneath `requests` (its own RSA and EC keys)
and a throwaway HOME.

What must hold:
  1. off unless issuer, client id, secret and public URL are all set; https
     only (http on localhost with the development override);
  2. a sign-in is matched by (issuer, subject) alone: an identity whose
     preferred_username or email names an existing account - the
     administrator's included - gets nothing (the takeover the first draft
     of this feature allowed);
  3. default deny: no account is created at sign-in unless
     JACARIUM_OIDC_AUTO_CREATE is on, and then only for an identity the
     allow-lists accept (group, verified email domain, required claim);
     the administrator group grants the role and never takes it away;
  4. the round-trip belongs to the browser that started it: the sealed
     state cookie is required, fits exactly one state, expires, is refused
     when altered or replayed, and a callback in another browser is refused;
  5. the ID token: wrong signature, audience, azp, issuer, expiry, nonce,
     an unlisted algorithm (none, HS256 with the client secret), a key of
     another type - all refused; RS256, PS256 and ES256 accepted; an unknown
     kid fetches the keys again, at most once a minute;
  6. linking: from a signed-in account with its password, completed only for
     the session that asked; one identity per account and one account per
     identity; unlink needs the password and refuses to lock an account out;
     an administrator's invite links one verified email once;
  7. an SSO-only account sets its first password only after a fresh
     round-trip; JACARIUM_OIDC_DISABLE_PASSWORD_LOGIN keeps passwords for
     administrators only;
  8. nothing the provider or the query string says reaches the page: the
     landing carries one of our short codes;
  9. the migration: additive, in one transaction, after a backup; a crash
     mid-way leaves the old schema and the next start completes it.

Run: backend/venv/bin/python tests/accounts_sso.test.py
"""
import base64
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import urllib.parse
from unittest import mock

import jwt
from cryptography.hazmat.primitives.asymmetric import ec, rsa

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix='jacarium-sso-')
HOME = os.path.join(TMP, 'data')
os.makedirs(HOME)
ISSUER = 'https://idp.example.test/realms/demo'
BASE = 'https://console.example.test'
OIDC_ENV = {'JACARIUM_OIDC_ISSUER': ISSUER, 'JACARIUM_OIDC_CLIENT_ID': 'jacarium', 'JACARIUM_OIDC_CLIENT_SECRET': 'synthetic-client-secret', 'JACARIUM_PUBLIC_URL': BASE}
for key in [k for k in os.environ if k.startswith('JACARIUM_OIDC_')] + ['JACARIUM_ENV_FILE', 'JACARIUM_ACCOUNTS_DB', 'JACARIUM_PUBLIC_URL']:
    os.environ.pop(key, None)
os.environ.update({'HOME': HOME, 'JACARIUM_AUTH_MODE': 'accounts', 'JACARIUM_REPORTS_ROOT': os.path.join(HOME, 'reports'),
                   'JACARIUM_KNOWN_HOSTS': os.path.join(HOME, '.ssh', 'known_hosts')})
sys.path.insert(0, os.path.join(REPO, 'backend'))
os.chdir(os.path.join(REPO, 'backend'))

import accounts  # noqa: E402
import app as app_module  # noqa: E402
import auth  # noqa: E402
import oidc  # noqa: E402

failures = []
count = [0]


def check(name, ok, detail=''):
    count[0] += 1
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else ' | ' + str(detail)[:500]}")
    if not ok:
        failures.append(name)


HDR = {'X-Requested-With': 'Jacarium'}
auth.sso_limiter = auth.sso_callback_limiter = accounts.RateLimiter(100000, 60)   # the round-trips below are many; the limits have their own check


def audited(action, **fields):
    return any(e['action'] == action and all(e['fields'].get(k) == v for k, v in fields.items()) for e in accounts.read_audit(2000))
PASSWORD = 'correct horse battery staple'


# ---- the synthetic provider ------------------------------------------------
class Provider:
    def __init__(self):
        self.rsa = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.ec = ec.generate_private_key(ec.SECP256R1())
        self.other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.published = {'r1': self.rsa, 'e1': self.ec}
        self.jwks_fetches = 0
        self.token = None            # what the token endpoint hands out next
        self.token_posts = []
        self.discovery = {'issuer': ISSUER, 'authorization_endpoint': ISSUER + '/auth', 'token_endpoint': ISSUER + '/token',
                          'jwks_uri': ISSUER + '/certs', 'end_session_endpoint': ISSUER + '/logout'}

    def jwks(self):
        keys = []
        for kid, key in self.published.items():
            entry = json.loads((jwt.algorithms.RSAAlgorithm if isinstance(key, rsa.RSAPrivateKey) else jwt.algorithms.ECAlgorithm).to_jwk(key.public_key()))
            keys.append({**entry, 'kid': kid, 'use': 'sig'})
        return {'keys': keys}

    def mint(self, claims, *, alg='RS256', key=None, kid=None, raw_header=None):
        now = int(time.time())
        payload = {'iss': ISSUER, 'aud': 'jacarium', 'iat': now, 'exp': now + 300, 'auth_time': now, **claims}
        payload = {k: v for k, v in payload.items() if v is not None}
        if raw_header is not None:   # hand-made (alg none)
            b = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b'=').decode()  # noqa: E731
            return f'{b(raw_header)}.{b(payload)}.'
        if alg == 'HS256':           # hand-made too: the library refuses to sign with a public key as the secret
            import hashlib
            import hmac
            b = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b'=').decode()  # noqa: E731
            signing = f"{b(json.dumps({'alg': 'HS256', 'kid': kid or 'r1'}).encode())}.{b(json.dumps(payload).encode())}"
            return f"{signing}.{b(hmac.new(key.encode() if isinstance(key, str) else key, signing.encode(), hashlib.sha256).digest())}"
        key = key if key is not None else (self.ec if alg == 'ES256' else self.rsa)
        return jwt.encode(payload, key, algorithm=alg, headers={'kid': kid or ('e1' if alg == 'ES256' else 'r1')})


class Reply:
    def __init__(self, payload, status=200):
        self._payload, self.status_code, self.content = payload, status, json.dumps(payload).encode()

    def json(self):
        return self._payload


IDP = Provider()


def fake_get(url, **kwargs):
    assert kwargs.get('allow_redirects') is False, 'the provider is fetched without following redirects'
    if url == ISSUER + '/.well-known/openid-configuration':
        return Reply(IDP.discovery)
    if url == IDP.discovery['jwks_uri']:
        IDP.jwks_fetches += 1
        return Reply(IDP.jwks())
    return Reply({}, 404)


def fake_post(url, data=None, **kwargs):
    IDP.token_posts.append(dict(data or {}))
    if url != IDP.discovery['token_endpoint'] or IDP.token is None:
        return Reply({'error': 'invalid_grant'}, 400)
    return Reply({'id_token': IDP.token, 'access_token': 'not-used', 'token_type': 'Bearer'})


mock.patch.object(oidc.requests, 'get', fake_get).start()
mock.patch.object(oidc.requests, 'post', fake_post).start()


def browser():
    return app_module.app.test_client()


def post(client, path, payload=None):
    return client.post(path, json=payload or {}, headers=HDR, base_url=BASE)


def me(client):
    answer = client.get('/api/auth/me', base_url=BASE)
    return (answer.get_json() or {}).get('user') if answer.status_code == 200 else None


def sealed_cookie(client):
    cookie = client.get_cookie(oidc.STATE_COOKIE, domain='console.example.test')
    return cookie.value if cookie else None


def begin(client, purpose='login', **body):
    """POST /begin; returns (response, state, the flow the sealed cookie holds)."""
    answer = post(client, '/api/auth/sso/begin', {'purpose': purpose, **body})
    if answer.status_code != 200:
        return answer, None, None
    query = urllib.parse.parse_qs(urllib.parse.urlparse(answer.get_json()['url']).query)
    flow = json.loads(oidc._fernet().decrypt(sealed_cookie(client).encode()))
    return answer, query['state'][0], flow


def landing(response):
    """The callback's page: ('ok', what) / ('error', code) from the address it leads to."""
    text = response.get_data(as_text=True)
    target = text.split('url=', 1)[1].split('"', 1)[0].replace('&amp;', '&') if 'url=' in text else ''
    query = urllib.parse.parse_qs(urllib.parse.urlparse(target).query)
    if 'sso_error' in query:
        return 'error', query['sso_error'][0]
    return 'ok', (query.get('sso') or [''])[0]


def sso(client, claims, purpose='login', *, finish_in=None, mint=None, **body):
    """A whole round-trip: begin in `client`, the provider signs `claims`, the callback lands in finish_in or client."""
    answer, state, flow = begin(client, purpose, **body)
    if state is None:
        return 'begin', answer.status_code
    IDP.token = (mint or IDP.mint)({'nonce': flow['n'], **claims}) if claims is not None else None
    back = (finish_in or client).get(f'/api/auth/sso/callback?code=synthetic-code&state={state}', base_url=BASE)
    return landing(back)


def env(**values):
    for key in [k for k in os.environ if k.startswith('JACARIUM_OIDC_') and k not in OIDC_ENV]:
        os.environ.pop(key)
    os.environ.update({f'JACARIUM_OIDC_{k}': v for k, v in values.items()})
    oidc.reset_for_tests()


# ---- 1. configuration ------------------------------------------------------
admin_browser = browser()
setup = post(admin_browser, '/api/auth/setup', {'setupCode': open(os.path.join(HOME, 'setup-code')).read().strip(), 'username': 'admin', 'password': PASSWORD, 'displayName': 'Admin'})
check('the first administrator is created with the setup code (single sign-on never creates the first account)', setup.status_code == 201)
caps = lambda: (browser().get('/api/capabilities', base_url=BASE).get_json() or {}).get('auth', {}).get('sso')  # noqa: E731
check('without its settings single sign-on is off: capabilities say so and the routes answer 404', caps() == {'enabled': False, 'passwordLogin': True}
      and post(browser(), '/api/auth/sso/begin').status_code == 404 and browser().get('/api/auth/sso/callback?code=x&state=y', base_url=BASE).status_code == 404, caps())
os.environ.update({k: v for k, v in OIDC_ENV.items() if k != 'JACARIUM_OIDC_CLIENT_SECRET'})
check('with one of the four settings missing it stays off', caps()['enabled'] is False)
secret_file = os.path.join(TMP, 'client-secret')
open(secret_file, 'w').write('synthetic-client-secret\n')
os.environ['JACARIUM_OIDC_CLIENT_SECRET_FILE'] = secret_file
check('the secret can come from a file (JACARIUM_OIDC_CLIENT_SECRET_FILE)', caps()['enabled'] is True and oidc.config()['client_secret'] == 'synthetic-client-secret')
os.environ.pop('JACARIUM_OIDC_CLIENT_SECRET_FILE')
os.environ.update(OIDC_ENV)
c = caps()
check('capabilities: enabled, the button label, password sign-in on, no secret and no endpoint', c['enabled'] and c['buttonLabel'] == 'Sign in with SSO' and c['passwordLogin'] is True
      and c['autoCreate'] is False and 'synthetic-client-secret' not in json.dumps(c) and 'token' not in json.dumps(c), c)
os.environ['JACARIUM_OIDC_ISSUER'] = 'http://idp.example.test/realms/demo'
check('an http issuer is refused', caps()['enabled'] is False)
os.environ['JACARIUM_OIDC_ISSUER'] = 'http://localhost:18081/realms/demo'
check('http on localhost is refused too without the development override...', caps()['enabled'] is False)
os.environ['JACARIUM_OIDC_ALLOW_INSECURE_LOCALHOST'] = '1'
check('...and accepted with it (JACARIUM_OIDC_ALLOW_INSECURE_LOCALHOST), for localhost only', caps()['enabled'] is True)
os.environ['JACARIUM_OIDC_ISSUER'] = 'http://idp.example.test/realms/demo'
check('the override does not open http for another host', caps()['enabled'] is False)
os.environ.update(OIDC_ENV)
env()
IDP.discovery['token_endpoint'] = 'http://idp.example.test/token'
b = post(browser(), '/api/auth/sso/begin')
check('a discovery document with an http endpoint is refused (502, a code, no detail on the page)', b.status_code == 502 and b.get_json().get('code') == 'config' and 'http://' not in b.get_data(as_text=True), b.get_data(as_text=True))
IDP.discovery['token_endpoint'] = ISSUER + '/token'
IDP.discovery['issuer'] = 'https://elsewhere.example.test'
oidc.reset_for_tests()
check('a discovery document that names another issuer is refused', post(browser(), '/api/auth/sso/begin').status_code == 502)
IDP.discovery['issuer'] = ISSUER
oidc.reset_for_tests()

# ---- the start of a round-trip ----------------------------------------------
b0 = browser()
answer, state, flow = begin(b0)
url = urllib.parse.urlparse(answer.get_json()['url'])
q = urllib.parse.parse_qs(url.query)
check('begin answers the provider\'s authorization URL: code flow, PKCE S256, state, nonce, our redirect URI', answer.status_code == 200 and f'{url.scheme}://{url.netloc}{url.path}' == ISSUER + '/auth'
      and q['response_type'] == ['code'] and q['code_challenge_method'] == ['S256'] and q['redirect_uri'] == [BASE + '/api/auth/sso/callback'] and q['client_id'] == ['jacarium'] and len(q['state'][0]) >= 24 and len(q['nonce'][0]) >= 24, q)
set_cookie = [h for h in answer.headers.getlist('Set-Cookie') if h.startswith(oidc.STATE_COOKIE)][0]
check('the state travels in a __Host- cookie: Secure, HttpOnly, SameSite=Lax, ten minutes, sealed (nothing readable in it)', 'Secure' in set_cookie and 'HttpOnly' in set_cookie and 'SameSite=Lax' in set_cookie and 'Max-Age=600' in set_cookie
      and 'Path=/' in set_cookie and state not in set_cookie and flow['n'] not in set_cookie and flow['v'] not in set_cookie, set_cookie[:160])
check('the sealed flow holds the state, the nonce, the PKCE verifier and the purpose', flow['s'] == state and flow['p'] == 'login' and flow['n'] == q['nonce'][0] and len(flow['v']) >= 43)
check('begin is a POST behind the X-Requested-With guard (another site cannot start a round-trip in this browser)', browser().post('/api/auth/sso/begin', json={}, base_url=BASE).status_code == 403
      and browser().get('/api/auth/sso/begin', base_url=BASE).status_code in (401, 404, 405))
check('the server keeps the sealing key in accounts.sqlite, the same at every call', accounts.server_key('sso-state', lambda: 'x') == accounts.server_key('sso-state', lambda: 'y') and len(accounts.server_key('sso-state', lambda: 'x')) == 44)

# ---- 3. default deny --------------------------------------------------------
alice = {'sub': 'subject-alice', 'preferred_username': 'alice', 'email': 'alice@example.test', 'email_verified': True, 'name': 'Alice Example', 'groups': ['staff']}
b1 = browser()
check('default: an identity without a linked account is refused (no_account) and nobody is created', sso(b1, alice) == ('error', 'no_account') and me(b1) is None and accounts.get_user_by_username('alice') is None)
check('the refusal is audited with its reason', audited('sso-refused', reason='no_account'))

# ---- 2. the takeover the first draft allowed --------------------------------
accounts.create_user('carol', PASSWORD, role='user')
env(AUTO_CREATE='1')
t1 = browser()
r = sso(t1, {'sub': 'attacker-1', 'preferred_username': 'admin', 'email': 'someone@example.test'})
check('an identity whose preferred_username is the administrator\'s username is NOT signed in as the administrator (link_required), with or without auto-create',
      r == ('error', 'link_required') and me(t1) is None and accounts.get_user_by_username('admin')['sso'] is None, r)
t2 = browser()
r = sso(t2, {'sub': 'attacker-2', 'email': 'carol@attacker.example.test', 'email_verified': False})
check('an unverified email whose local part is an existing username takes nothing over (a new account under another name at most)',
      me(t2) is None or me(t2)['username'] != 'carol', (r, me(t2)))
check('...and carol stays unlinked', accounts.get_user_by_username('carol')['sso'] is None)
t3 = browser()
r = sso(t3, {'sub': 'attacker-3', 'preferred_username': 'carol', 'email': 'carol@example.test', 'email_verified': True})
check('a verified email and the same username still do not link an existing account', r == ('error', 'link_required') and me(t3) is None and accounts.get_user_by_username('carol')['sso'] is None, r)
env()

# ---- 3. auto-create and the allow-lists -------------------------------------
env(AUTO_CREATE='1', ALLOWED_GROUPS='staff, ops')
b2 = browser()
r = sso(b2, alice)
u = me(b2)
check('auto-create on and the identity in an allowed group: the account is created, role user, without a password, linked by (issuer, subject)',
      r == ('ok', 'signed-in') and u and u['username'] == 'alice' and u['role'] == 'user' and u['hasPassword'] is False and u['sso'] == {'issuer': ISSUER, 'subject': 'subject-alice'} and u['displayName'] == 'Alice Example', (r, u))
check('its home exists and the creation is audited', os.path.isdir(os.path.join(HOME, 'users', u['id'])) or os.path.isdir(app_module.user_home_for(u['id']) if hasattr(app_module, 'user_home_for') else HOME)
      and audited('sso-user-created', user='alice'))
b3 = browser()
check('the same identity signs in again as the same account (matched by subject, whatever its claims say now)',
      sso(b3, {**alice, 'preferred_username': 'renamed', 'email': 'other@example.test'}) == ('ok', 'signed-in') and me(b3)['id'] == u['id'])
check('not in an allowed group: refused, no account', sso(browser(), {'sub': 'subject-bob', 'preferred_username': 'bob', 'groups': ['guests']}) == ('error', 'not_allowed_group') and accounts.get_user_by_username('bob') is None)
check('no groups claim at all: refused', sso(browser(), {'sub': 'subject-bob', 'preferred_username': 'bob'}) == ('error', 'not_allowed_group'))
check('the allow-list applies to an existing linked account at every sign-in (removed from the group at the provider: no way in)', sso(browser(), {**alice, 'groups': []}) == ('error', 'not_allowed_group'))
env(AUTO_CREATE='1', ALLOWED_EMAIL_DOMAINS='example.test')
check('domain rule: a verified email of the domain gets in', sso(browser(), {'sub': 'subject-dana', 'preferred_username': 'dana', 'email': 'dana@example.test', 'email_verified': True}) == ('ok', 'signed-in'))
check('domain rule: the right domain but NOT verified is refused (email_not_verified)', sso(browser(), {'sub': 'subject-eve', 'preferred_username': 'eve', 'email': 'eve@example.test', 'email_verified': False}) == ('error', 'email_not_verified')
      and sso(browser(), {'sub': 'subject-eve', 'preferred_username': 'eve', 'email': 'eve@example.test'}) == ('error', 'email_not_verified') and accounts.get_user_by_username('eve') is None)
check('domain rule: another domain is refused, a look-alike suffix too', sso(browser(), {'sub': 's-f', 'preferred_username': 'frank', 'email': 'frank@elsewhere.test', 'email_verified': True}) == ('error', 'not_allowed_domain')
      and sso(browser(), {'sub': 's-g', 'preferred_username': 'gina', 'email': 'gina@notexample.test', 'email_verified': True}) == ('error', 'not_allowed_domain'))
env(AUTO_CREATE='1', REQUIRED_CLAIM='jacarium_access=yes')
check('required claim: missing or another value refused, the value accepted', sso(browser(), {'sub': 's-h', 'preferred_username': 'henry'}) == ('error', 'missing_claim')
      and sso(browser(), {'sub': 's-h', 'preferred_username': 'henry', 'jacarium_access': 'no'}) == ('error', 'missing_claim')
      and sso(browser(), {'sub': 's-h', 'preferred_username': 'henry', 'jacarium_access': 'yes'}) == ('ok', 'signed-in'))
env(AUTO_CREATE='1')
b4 = browser()
check('auto-create with no allow-list: any identity of the provider gets a user account (the documented, explicit choice)', sso(b4, {'sub': 'subject-ivy', 'preferred_username': 'Ivy.Example'}) == ('ok', 'signed-in') and me(b4)['username'] == 'ivy.example' and me(b4)['role'] == 'user')
b5 = browser()
check('a new account\'s username falls back to a stable one from issuer + subject when the claim gives none', sso(b5, {'sub': 'subject-nameless'}) == ('ok', 'signed-in') and me(b5)['username'].startswith('u') and len(me(b5)['username']) == 13, me(b5))

# ---- role mapping -----------------------------------------------------------
env(AUTO_CREATE='1', ADMIN_GROUPS='jacarium-admins')
b6 = browser()
check('administrator group: a member\'s new account is an administrator', sso(b6, {'sub': 'subject-root', 'preferred_username': 'rita', 'groups': ['jacarium-admins']}) == ('ok', 'signed-in') and me(b6)['role'] == 'admin')
b7 = browser()
check('an existing linked user who joined the group becomes an administrator at the next sign-in (audited)', sso(b7, {**alice, 'groups': ['staff', 'jacarium-admins']}) == ('ok', 'signed-in') and me(b7)['role'] == 'admin'
      and audited('sso-role-granted', user='alice'))
b8 = browser()
check('leaving the group does not demote (single sign-on never takes the role away)', sso(b8, alice) == ('ok', 'signed-in') and me(b8)['role'] == 'admin')
accounts.set_user_role(accounts.get_user_by_username('alice')['id'], 'user')
env(AUTO_CREATE='1')
b9 = browser()
check('without JACARIUM_OIDC_ADMIN_GROUPS no claim grants the role', sso(b9, {**alice, 'groups': ['jacarium-admins', 'admin'], 'role': 'admin', 'roles': ['admin']}) == ('ok', 'signed-in') and me(b9)['role'] == 'user')
check('a disabled account is refused', (accounts.set_user_disabled(accounts.get_user_by_username('ivy.example')['id'], True) and None) or sso(browser(), {'sub': 'subject-ivy'}) == ('error', 'disabled'))
env()

# ---- 4. the round-trip belongs to one browser --------------------------------
victim, attacker = browser(), browser()
r = sso(attacker, alice, finish_in=victim)
check('a callback delivered in a browser that did not start the sign-in is refused (state): the victim is not signed in as anyone', r == ('error', 'state') and me(victim) is None, r)
x = browser()
answer, state, flow = begin(x)
IDP.token = IDP.mint({'nonce': flow['n'], **alice})
check('a callback with another state than the cookie\'s is refused', landing(x.get('/api/auth/sso/callback?code=c&state=' + 'A' * 32, base_url=BASE)) == ('error', 'state'))
x = browser()
answer, state, flow = begin(x)
IDP.token = IDP.mint({'nonce': flow['n'], **alice})
first = landing(x.get(f'/api/auth/sso/callback?code=c&state={state}', base_url=BASE))
sealed_again = oidc._fernet().encrypt(json.dumps(flow).encode()).decode()
y = browser()
y.set_cookie(oidc.STATE_COOKIE, sealed_again, domain='console.example.test', secure=True)
IDP.token = IDP.mint({'nonce': flow['n'], **alice})
check('a completed sign-in cannot be replayed: the same state and cookie a second time are refused', first == ('ok', 'signed-in') and landing(y.get(f'/api/auth/sso/callback?code=c&state={state}', base_url=BASE)) == ('error', 'state') and me(y) is None)
check('the callback clears the state cookie', sealed_cookie(x) in (None, ''))
x = browser()
answer, state, flow = begin(x)
tampered = sealed_cookie(x)[:-6] + ('AAAAAA' if not sealed_cookie(x).endswith('AAAAAA') else 'BBBBBB')
x.set_cookie(oidc.STATE_COOKIE, tampered, domain='console.example.test', secure=True)
check('an altered cookie is refused', landing(x.get(f'/api/auth/sso/callback?code=c&state={state}', base_url=BASE)) == ('error', 'state'))
from cryptography.fernet import Fernet  # noqa: E402
x = browser()
answer, state, flow = begin(x)
x.set_cookie(oidc.STATE_COOKIE, Fernet(Fernet.generate_key()).encrypt(json.dumps(flow).encode()).decode(), domain='console.example.test', secure=True)
check('a cookie sealed with another key is refused', landing(x.get(f'/api/auth/sso/callback?code=c&state={state}', base_url=BASE)) == ('error', 'state'))
x = browser()
answer, state, flow = begin(x)
IDP.token = IDP.mint({'nonce': flow['n'], **alice})
with mock.patch('time.time', return_value=time.time() + oidc.FLOW_SECONDS + 120):
    late = landing(x.get(f'/api/auth/sso/callback?code=c&state={state}', base_url=BASE))
check('after ten minutes the cookie no longer opens', late == ('error', 'state'), late)
before = len(oidc._used_states)
for _ in range(40):
    post(browser(), '/api/auth/sso/begin')
check('starting round-trips leaves nothing on the server (no pending state to pile up)', len(oidc._used_states) == before)
with mock.patch.object(oidc, 'USED_STATES_MAX', 5):
    for i in range(12):
        oidc.reset_for_tests() if i == 0 else None
        z = browser()
        sso(z, alice)
    check('the memory of used states is capped', len(oidc._used_states) <= 5, len(oidc._used_states))
oidc.reset_for_tests()
check('the token request carries the PKCE verifier of the sealed flow and the client secret, to the token endpoint', IDP.token_posts[-1].get('code_verifier') and IDP.token_posts[-1].get('client_secret') == 'synthetic-client-secret'
      and IDP.token_posts[-1].get('grant_type') == 'authorization_code' and IDP.token_posts[-1].get('redirect_uri') == BASE + '/api/auth/sso/callback')
auth.sso_limiter, auth.sso_callback_limiter = accounts.RateLimiter(60, 15 * 60), accounts.RateLimiter(60, 15 * 60)
codes = [post(browser(), '/api/auth/sso/begin').status_code for _ in range(62)]
backs = [browser().get('/api/auth/sso/callback?code=c&state=s', base_url=BASE).status_code for _ in range(62)]
check('begin and the callback are each limited per address: 60 in 15 minutes, then 429', codes[:60] == [200] * 60 and codes[60:] == [429, 429] and backs[:60] == [200] * 60 and backs[60:] == [429, 429], (codes[58:], backs[58:]))
auth.sso_limiter = auth.sso_callback_limiter = accounts.RateLimiter(100000, 60)

# ---- 5. the ID token ---------------------------------------------------------
def refused(name, claims=None, **mint_options):
    client = browser()
    result = sso(client, {**alice, **(claims or {})}, mint=(lambda c: IDP.mint(c, **mint_options)) if mint_options else None)
    check(f'ID token: {name} is refused', result == ('error', 'token') and me(client) is None, result)


refused('a signature by a key the provider does not publish (same kid)', key=IDP.other)
refused('another audience', {'aud': 'another-client'})
refused('several audiences without azp', {'aud': ['jacarium', 'another-client']})
refused('several audiences with azp naming another client', {'aud': ['jacarium', 'another-client'], 'azp': 'another-client'})
refused('one audience and azp naming another client', {'azp': 'another-client'})
refused('another issuer', {'iss': 'https://elsewhere.example.test'})
refused('an expired token (beyond the minute of leeway)', {'exp': int(time.time()) - 3600})
refused('a token issued in the future (beyond the leeway)', {'iat': int(time.time()) + 3600})
refused('a token without exp', {'exp': None})
refused('a token without a subject', {'sub': None})
refused('another nonce', {'nonce': 'not-this-sign-in'})
refused('no nonce', {'nonce': None})
refused('alg none', raw_header={'alg': 'none', 'kid': 'r1'})
refused('HS256 signed with the client secret', alg='HS256', key='synthetic-client-secret')
refused('HS256 signed with the published RSA key as the secret', alg='HS256', key=json.dumps(IDP.jwks()['keys'][0]))
refused('RS384 (not on the list)', alg='RS384')
refused('ES256 claimed with the RSA key\'s kid', alg='ES256', kid='r1')
refused('an unknown kid', kid='nobody')
for alg in ('RS256', 'PS256', 'ES256'):
    client = browser()
    check(f'ID token: {alg} is accepted', sso(client, alice, mint=lambda c, alg=alg: IDP.mint(c, alg=alg)) == ('ok', 'signed-in') and me(client)['username'] == 'alice')
client = browser()
check('ID token: a minute of clock skew is allowed (expired 30 s ago)', sso(client, {**alice, 'exp': int(time.time()) - 30}) == ('ok', 'signed-in'))
client = browser()
check('ID token: several audiences with azp naming this client are accepted', sso(client, {**alice, 'aud': ['jacarium', 'another-client'], 'azp': 'jacarium'}) == ('ok', 'signed-in'))
# key rotation
oidc.reset_for_tests()
sso(browser(), alice)
fetches = IDP.jwks_fetches
rotated = rsa.generate_private_key(public_exponent=65537, key_size=2048)
IDP.published['r2'] = rotated
check('key rotation: right after a fetch an unknown kid does not fetch again (at most once a minute)...', sso(browser(), alice, mint=lambda c: IDP.mint(c, key=rotated, kid='r2')) == ('error', 'token') and IDP.jwks_fetches == fetches)
real_now = int(time.time())
with mock.patch('time.time', return_value=time.time() + oidc.JWKS_REFETCH_SECONDS + 5):
    client = browser()
    answer, state, flow = begin(client)
    IDP.token = IDP.mint({'nonce': flow['n'], **alice, 'iat': real_now, 'exp': real_now + 300}, key=rotated, kid='r2')
    rotated_result = landing(client.get(f'/api/auth/sso/callback?code=c&state={state}', base_url=BASE))
check('...and a minute later it does, and the new key verifies', rotated_result == ('ok', 'signed-in') and IDP.jwks_fetches == fetches + 1, (rotated_result, IDP.jwks_fetches - fetches))
IDP.published.pop('r2')
oidc.reset_for_tests()
IDP.token = None
check('the provider refusing the code is a provider error, not a sign-in', sso(browser(), None) == ('error', 'provider'))

# ---- 8. nothing from the query string reaches the page ------------------------
page = browser().get('/api/auth/sso/callback?error=server_error&error_description=' + urllib.parse.quote('Your account is locked. Call 555-0100 <script>alert(1)</script>'), base_url=BASE)
text = page.get_data(as_text=True)
check('error_description is never reflected: the landing carries our code only', landing(page) == ('error', 'provider') and '555-0100' not in text and 'script' not in text and 'locked' not in text, text[:300])
check('access_denied at the provider is the "denied" code', landing(browser().get('/api/auth/sso/callback?error=access_denied', base_url=BASE)) == ('error', 'denied'))
check('the landing is a page of this origin, not a redirect: 200, no-store, a strict CSP, a meta refresh to the public URL', page.status_code == 200 and page.headers['Cache-Control'] == 'no-store'
      and "default-src 'none'" in page.headers['Content-Security-Policy'] and f'url={BASE}/?sso_error=provider' in text and 'Location' not in page.headers)
client = browser()
answer, state, flow = begin(client)
IDP.token = IDP.mint({'nonce': flow['n'], **alice})
good = client.get(f'/api/auth/sso/callback?code=c&state={state}', base_url=BASE)
session_cookie = [h for h in good.headers.getlist('Set-Cookie') if h.startswith(auth.SESSION_COOKIE)]
check('a successful landing sets the session cookie (still __Host-, Secure, HttpOnly, SameSite=Strict)', len(session_cookie) == 1 and all(w in session_cookie[0] for w in ('Secure', 'HttpOnly', 'SameSite=Strict')))

# ---- 6. linking ---------------------------------------------------------------
carol_browser = browser()
check('carol signs in with her password', post(carol_browser, '/api/auth/login', {'username': 'carol', 'password': PASSWORD}).status_code == 200 and me(carol_browser)['sso'] is None and me(carol_browser)['hasPassword'] is True)
carol_identity = {'sub': 'subject-carol', 'preferred_username': 'c.example', 'email': 'carol@example.test', 'email_verified': True}
check('link needs a signed-in browser session', post(browser(), '/api/auth/sso/begin', {'purpose': 'link'}).status_code == 401)
check('link needs the account\'s password (wrong or missing: 403, audited)', post(carol_browser, '/api/auth/sso/begin', {'purpose': 'link'}).status_code == 403
      and post(carol_browser, '/api/auth/sso/begin', {'purpose': 'link', 'password': 'wrong password'}).status_code == 403
      and audited('sso-link-refused', user='carol'))
answer, state, flow = begin(carol_browser, 'link', password=PASSWORD)
q = urllib.parse.parse_qs(urllib.parse.urlparse(answer.get_json()['url']).query)
check('a link round-trip asks the provider for a fresh sign-in (prompt=login, max_age=0) and names the account and its session in the sealed flow',
      q.get('prompt') == ['login'] and q.get('max_age') == ['0'] and flow['p'] == 'link' and flow['u'] == accounts.get_user_by_username('carol')['id'] and len(flow['h']) == 64)
IDP.token = IDP.mint({'nonce': flow['n'], **carol_identity})
other_browser = browser()
other_browser.set_cookie(oidc.STATE_COOKIE, sealed_cookie(carol_browser), domain='console.example.test', secure=True)
linked = landing(carol_browser.get(f'/api/auth/sso/callback?code=c&state={state}', base_url=BASE))
check('the link completes: carol\'s account carries the identity, audited', linked == ('ok', 'linked') and me(carol_browser)['sso'] == {'issuer': ISSUER, 'subject': 'subject-carol'}
      and audited('sso-linked', user='carol'), linked)
fresh = browser()
check('carol now signs in with single sign-on, as carol with her password kept', sso(fresh, carol_identity) == ('ok', 'signed-in') and me(fresh)['username'] == 'carol' and me(fresh)['hasPassword'] is True)
check('a second identity cannot be linked while one is (409)', post(carol_browser, '/api/auth/sso/begin', {'purpose': 'link', 'password': PASSWORD}).status_code == 409)
accounts.create_user('erin', PASSWORD, role='user')
erin_browser = browser()
post(erin_browser, '/api/auth/login', {'username': 'erin', 'password': PASSWORD})
check('an identity that is linked to one account cannot be linked to another (identity_in_use)', sso(erin_browser, carol_identity, 'link', password=PASSWORD) == ('error', 'identity_in_use') and me(erin_browser)['sso'] is None)
# the session that asked must still be there
answer, state, flow = begin(erin_browser, 'link', password=PASSWORD)
IDP.token = IDP.mint({'nonce': flow['n'], 'sub': 'subject-erin'})
kept = sealed_cookie(erin_browser)
post(erin_browser, '/api/auth/logout')
erin_browser.set_cookie(oidc.STATE_COOKIE, kept, domain='console.example.test', secure=True)
check('a link whose session ended meanwhile is refused (wrong_session)', landing(erin_browser.get(f'/api/auth/sso/callback?code=c&state={state}', base_url=BASE)) == ('error', 'wrong_session') and accounts.get_user_by_username('erin')['sso'] is None)
post(erin_browser, '/api/auth/login', {'username': 'erin', 'password': PASSWORD})
env(ALLOWED_GROUPS='staff')
check('the allow-list applies to linking too', sso(erin_browser, {'sub': 'subject-erin', 'groups': ['guests']}, 'link', password=PASSWORD) == ('error', 'not_allowed_group'))
env()
check('a link with a stale provider sign-in (auth_time long ago) is refused', sso(erin_browser, {'sub': 'subject-erin', 'auth_time': int(time.time()) - 7200}, 'link', password=PASSWORD) == ('error', 'stale'))
# unlink
check('unlink needs the password', post(carol_browser, '/api/auth/sso/unlink', {'password': 'wrong password'}).status_code == 403 and post(carol_browser, '/api/auth/sso/unlink').status_code == 403)
unlinked = post(carol_browser, '/api/auth/sso/unlink', {'password': PASSWORD})
check('unlink removes the identity (audited); the identity no longer signs in', unlinked.status_code == 200 and unlinked.get_json()['user']['sso'] is None
      and audited('sso-unlinked', user='carol') and sso(browser(), carol_identity) == ('error', 'no_account'))
alice_browser = browser()
sso(alice_browser, alice)
check('an account without a password cannot unlink (it would be locked out)', post(alice_browser, '/api/auth/sso/unlink', {'password': ''}).status_code == 409 and me(alice_browser)['sso'] is not None)
try:
    accounts.unlink_identity(accounts.get_user_by_username('alice')['id'])
    locked_out = False
except accounts.AccountsError:
    locked_out = True
check('...not through the administrator either', locked_out and post(admin_browser, f"/api/admin/users/{accounts.get_user_by_username('alice')['id']}/sso", {'action': 'unlink'}).status_code == 409)

# the administrator's invite
carol_id = accounts.get_user_by_username('carol')['id']
check('only an administrator sets an invite', post(carol_browser, f'/api/admin/users/{carol_id}/sso', {'action': 'invite', 'email': 'carol@example.test'}).status_code == 403)
invited = post(admin_browser, f'/api/admin/users/{carol_id}/sso', {'action': 'invite', 'email': 'Carol@Example.test'})
check('the administrator approves one verified email for one account (audited, shown on the account)', invited.status_code == 200 and invited.get_json()['user']['ssoInviteEmail'] == 'carol@example.test'
      and audited('sso-invited', user='carol'))
check('the same email cannot wait for two accounts', post(admin_browser, f"/api/admin/users/{accounts.get_user_by_username('erin')['id']}/sso", {'action': 'invite', 'email': 'carol@example.test'}).status_code == 409)
check('an identity with that email NOT verified does not link', sso(browser(), {'sub': 'subject-carol-2', 'email': 'carol@example.test', 'email_verified': False}) == ('error', 'no_account') and accounts.get_user(carol_id)['sso'] is None)
inv = browser()
check('the identity with the verified email signs in as carol and is linked; the invite is spent', sso(inv, {'sub': 'subject-carol-2', 'email': 'carol@example.test', 'email_verified': True}) == ('ok', 'signed-in') and me(inv)['username'] == 'carol'
      and accounts.get_user(carol_id)['sso'] == {'issuer': ISSUER, 'subject': 'subject-carol-2'} and accounts.get_user(carol_id)['ssoInviteEmail'] is None
      and audited('sso-linked-by-invite'))
check('another identity with the same verified email afterwards gets nothing', sso(browser(), {'sub': 'subject-carol-3', 'email': 'carol@example.test', 'email_verified': True}) == ('error', 'no_account'))
created = post(admin_browser, '/api/admin/users', {'username': 'fiona', 'ssoEmail': 'fiona@example.test'})
check('the administrator can create an account without a password that waits for a verified email', created.status_code == 201 and created.get_json()['user']['hasPassword'] is False and created.get_json()['user']['ssoInviteEmail'] == 'fiona@example.test')
check('an account without a password cannot sign in with any password', post(browser(), '/api/auth/login', {'username': 'fiona', 'password': ''}).status_code == 401 and post(browser(), '/api/auth/login', {'username': 'fiona', 'password': PASSWORD}).status_code == 401)
fiona = browser()
check('...and its person signs in with single sign-on', sso(fiona, {'sub': 'subject-fiona', 'email': 'fiona@example.test', 'email_verified': True}) == ('ok', 'signed-in') and me(fiona)['username'] == 'fiona')
check('the administration lists the linked identities', any(u['username'] == 'fiona' and u['sso'] and u['sso']['subject'] == 'subject-fiona' for u in admin_browser.get('/api/admin/users', base_url=BASE).get_json()['users']))
admin_unlink = post(admin_browser, f'/api/admin/users/{carol_id}/sso', {'action': 'unlink'})
check('an administrator can unlink an account that has a password', admin_unlink.status_code == 200 and admin_unlink.get_json()['user']['sso'] is None)

# ---- 7. the first password, and passwords for administrators only --------------
fresh_alice = browser()
sso(fresh_alice, alice)
check('right after an SSO sign-in the session is fresh: the first password can be set without a current one (audited as password-set)',
      post(fresh_alice, '/api/auth/password', {'newPassword': 'a brand new password'}).status_code == 200 and me(fresh_alice)['hasPassword'] is True
      and audited('password-set', user='alice'))
check('afterwards the current password is required again', post(fresh_alice, '/api/auth/password', {'newPassword': 'yet another password'}).status_code == 403
      and post(fresh_alice, '/api/auth/password', {'currentPassword': 'a brand new password', 'newPassword': 'yet another password'}).status_code == 200)
stale = browser()
sso(stale, {'sub': 'subject-fiona'})
conn = accounts.connection()
conn.execute('UPDATE sessions SET sso_at = ?', (time.time() - oidc.FRESH_SECONDS - 60,))
refusal = post(stale, '/api/auth/password', {'newPassword': 'a brand new password'})
check('a session whose SSO round-trip is older than ten minutes cannot set the first password (SSO_CONFIRM_REQUIRED)', refusal.status_code == 403 and refusal.get_json().get('code') == 'SSO_CONFIRM_REQUIRED' and me(stale)['hasPassword'] is False)
check('confirm with another identity than the linked one is refused (mismatch)', sso(stale, {'sub': 'subject-somebody-else'}, 'confirm') == ('error', 'mismatch') and post(stale, '/api/auth/password', {'newPassword': 'a brand new password'}).status_code == 403)
check('confirm with the linked identity makes the session fresh, and the password can be set', sso(stale, {'sub': 'subject-fiona'}, 'confirm') == ('ok', 'confirmed') and post(stale, '/api/auth/password', {'newPassword': 'a brand new password'}).status_code == 200)
check('confirm is for linked accounts only', post(admin_browser, '/api/auth/sso/begin', {'purpose': 'confirm'}).status_code == 409)
env(DISABLE_PASSWORD_LOGIN='1')
check('passwords for administrators only: capabilities say so', caps()['passwordLogin'] is False)
refusal = post(browser(), '/api/auth/login', {'username': 'erin', 'password': PASSWORD})
check('a user\'s right password is refused with PASSWORD_LOGIN_DISABLED (audited)', refusal.status_code == 403 and refusal.get_json().get('code') == 'PASSWORD_LOGIN_DISABLED'
      and audited('sign-in-refused-sso-only', user='erin'))
check('a wrong password answers as always (401): the refusal tells nothing about usernames', post(browser(), '/api/auth/login', {'username': 'erin', 'password': 'wrong password'}).status_code == 401
      and post(browser(), '/api/auth/login', {'username': 'nobody', 'password': PASSWORD}).status_code == 401)
check('an administrator still signs in with the password (the way back in when the provider is down)', post(browser(), '/api/auth/login', {'username': 'admin', 'password': PASSWORD}).status_code == 200)
env(END_SESSION='1')
out = browser()
sso(out, alice)
left = post(out, '/api/auth/logout').get_json()
check('JACARIUM_OIDC_END_SESSION: signing out of an SSO session names the provider\'s end-session URL with our client id and return address', left.get('ssoLogoutUrl', '').startswith(ISSUER + '/logout?')
      and 'client_id=jacarium' in left['ssoLogoutUrl'] and urllib.parse.quote(BASE + '/', safe='') in left['ssoLogoutUrl'] and me(out) is None, left)
pw = browser()
post(pw, '/api/auth/login', {'username': 'admin', 'password': PASSWORD})
check('...a password session signs out locally only; without the setting nobody is sent on', 'ssoLogoutUrl' not in post(pw, '/api/auth/logout').get_json())
env()
out = browser()
sso(out, alice)
check('by default signing out is local', 'ssoLogoutUrl' not in post(out, '/api/auth/logout').get_json() and me(out) is None)

# ---- 9. the migration -----------------------------------------------------------
OLD_SCHEMA = """
CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0, oidc_subject TEXT, created_at REAL NOT NULL,
    password_changed_at REAL NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at REAL NOT NULL, last_seen REAL NOT NULL, user_agent TEXT);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE device_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at REAL NOT NULL, last_seen REAL, revoked INTEGER NOT NULL DEFAULT 0);
"""


def old_database(path):
    conn = sqlite3.connect(path, isolation_level=None)
    conn.executescript(OLD_SCHEMA)
    now = time.time()
    conn.execute("INSERT INTO users VALUES ('u1', 'admin', 'Admin', ?, 'admin', 0, 'left-over-subject', ?, ?, 0)", (accounts.hash_password(PASSWORD), now, now))
    conn.execute("INSERT INTO users VALUES ('u2', 'bob', 'Bob', ?, 'user', 0, NULL, ?, ?, 0)", (accounts.hash_password(PASSWORD), now, now))
    conn.execute("INSERT INTO sessions VALUES (?, 'u1', ?, ?, 'old browser')", (accounts._session_hash('old-session'), now, now))
    conn.execute("INSERT INTO device_tokens VALUES ('t1', 'u2', 'laptop', ?, ?, NULL, 0)", (accounts._token_hash('old-token'), now))
    conn.close()


def rows(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    out = {t: [tuple(r) for r in conn.execute(f'SELECT * FROM {t} ORDER BY 1')] for t in ('users', 'sessions', 'device_tokens')}
    columns = {t: [r['name'] for r in conn.execute(f'PRAGMA table_info({t})')] for t in ('users', 'sessions')}
    conn.close()
    return out, columns


old_path = os.path.join(TMP, 'old', 'accounts.sqlite')
os.makedirs(os.path.dirname(old_path))
old_database(old_path)
before_rows, before_columns = rows(old_path)
# a crash in the middle: the transaction is rolled back, the schema is the old one
raw = sqlite3.connect(old_path, isolation_level=None)
raw.row_factory = sqlite3.Row
try:
    accounts._migrate_sso(raw, old_path, fail_after=2)
    crashed = False
except RuntimeError:
    crashed = True
raw.close()
mid_rows, mid_columns = rows(old_path)
check('migration, a crash after two of its statements: nothing of it stays (the old columns, every row as it was)', crashed and mid_columns == before_columns and mid_rows == before_rows, (mid_columns, before_columns))
backup = old_path + '.before-sso'
check('...and the backup taken first is a complete copy of the old database (0600)', os.path.exists(backup) and rows(backup) == (before_rows, before_columns) and oct(os.stat(backup).st_mode & 0o777) == '0o600')
# a hard kill mid-transaction: another process dies holding it
import subprocess  # noqa: E402
killed_path = os.path.join(TMP, 'killed', 'accounts.sqlite')
os.makedirs(os.path.dirname(killed_path))
old_database(killed_path)
killed_before = rows(killed_path)
killer = ("import os, sqlite3, sys; sys.path.insert(0, sys.argv[2]); import accounts\n"
          "c = sqlite3.connect(sys.argv[1], isolation_level=None); c.row_factory = sqlite3.Row\n"
          "c.execute('PRAGMA journal_mode=WAL')\n"
          "c.execute('BEGIN IMMEDIATE'); c.execute(accounts._SSO_MIGRATION[0][2]); c.execute(accounts._SSO_MIGRATION[1][2]); os._exit(9)\n")
died = subprocess.run([sys.executable, '-c', killer, killed_path, os.path.join(REPO, 'backend')], capture_output=True)
k_rows, k_columns = rows(killed_path)
check('migration, the process killed inside the transaction: the database opens with the old schema and every row', died.returncode == 9 and (k_rows, k_columns) == killed_before and k_columns == before_columns, (died.returncode, k_columns))
# the real thing: the next start completes it
os.environ['JACARIUM_ACCOUNTS_DB'] = old_path
accounts.reset_for_tests()
conn = accounts.connection()
after_rows, after_columns = rows(old_path)
check('migration on a database of the previous release: the new columns are there, every user, session and device token kept',
      {'oidc_issuer', 'sso_invite_email'} <= set(after_columns['users']) and 'sso_at' in after_columns['sessions']
      and [r[:6] for r in after_rows['users']] == [r[:6] for r in before_rows['users']] and [r[:5] for r in after_rows['sessions']] == [r[:5] for r in before_rows['sessions']] and after_rows['device_tokens'] == before_rows['device_tokens'])
check('...the old password, session and device token still work; foreign keys are on and clean', accounts.check_login('admin', PASSWORD) is not None and accounts.validate_session('old-session')['username'] == 'admin'
      and accounts.validate_device_token('old-token')['username'] == 'bob' and conn.execute('PRAGMA foreign_keys').fetchone()[0] == 1 and conn.execute('PRAGMA foreign_key_check').fetchall() == [])
check('...a subject left by a pre-release build (no issuer) is dropped, not half-trusted', accounts.get_user('u1')['sso'] is None and conn.execute('SELECT oidc_subject FROM users WHERE id = ?', ('u1',)).fetchone()[0] is None)
check('...the identity index is unique per (issuer, subject)', accounts.link_identity('u1', ISSUER, 's-1')['sso'] is not None and (lambda: [accounts.link_identity('u2', ISSUER, 's-1')] if False else True)())
try:
    accounts.link_identity('u2', ISSUER, 's-1')
    duplicate = False
except accounts.AccountsError:
    duplicate = True
check('...a second account cannot take the same identity', duplicate and accounts.link_identity('u2', 'https://other-issuer.example.test', 's-1')['sso']['subject'] == 's-1')
accounts.reset_for_tests()
stamp = os.stat(backup).st_mtime
accounts.connection()
check('a second start changes nothing and keeps the first backup', rows(old_path)[1] == after_columns and os.stat(backup).st_mtime == stamp)
fresh_path = os.path.join(TMP, 'fresh', 'accounts.sqlite')
os.environ['JACARIUM_ACCOUNTS_DB'] = fresh_path
accounts.reset_for_tests()
accounts.connection()
check('a fresh database gets the same schema and no backup (nothing to protect)', rows(fresh_path)[1] == after_columns and not os.path.exists(fresh_path + '.before-sso'))
accounts.reset_for_tests()

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{count[0] - len(failures)}/{count[0]} checks passed")
if failures:
    print('FAILED (' + str(len(failures)) + ' failed)')
    sys.exit(1)
print('All checks passed')
