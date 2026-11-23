#!/usr/bin/env python3
"""
Single sign-on is opt-in: a server without JACARIUM_OIDC_* settings behaves
as it did before the feature existed, an upgrade of such a server changes no
data, and turning single sign-on off again after it was used breaks nothing.

  1. unconfigured (accounts mode): /api/capabilities says single sign-on is
     off and otherwise has the shape it had; the SSO routes answer 404;
     setup, password sign-in, the session cookie, password change (current
     password required), profile, device tokens, step-up, sign-out and the
     administration answer as before; nothing of the SSO machinery is even
     imported (PyJWT) and no sealing key is created;
  2. an accounts database of the previous release, upgraded without any SSO
     setting: every row of every table reads back identical in the columns
     that existed, the old password / session / device token work, the new
     columns are empty;
  3. enabled, used, then disabled: an account with a password signs in with
     it as always; an SSO-only account's live session goes on; it cannot
     sign in with a password until an administrator sets one (then it can);
     a session fresh from its last SSO round-trip may still set its first
     password itself; unlinking works; the routes are 404 again;
  4. side by side (configured, default): passwords sign everyone in;
  5. the other modes: with JACARIUM_AUTH_MODE=none and on the desktop
     (app-token) the capabilities carry no SSO block, the routes are not
     reachable, and PyJWT is never imported.

Run: backend/venv/bin/python tests/accounts_sso_optin.test.py
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix='jacarium-sso-optin-')
HOME = os.path.join(TMP, 'data')
os.makedirs(HOME)
for key in [k for k in os.environ if k.startswith('JACARIUM_OIDC_')] + ['JACARIUM_ENV_FILE', 'JACARIUM_ACCOUNTS_DB', 'JACARIUM_PUBLIC_URL']:
    os.environ.pop(key, None)
os.environ.update({'HOME': HOME, 'JACARIUM_AUTH_MODE': 'accounts', 'JACARIUM_REPORTS_ROOT': os.path.join(HOME, 'reports'),
                   'JACARIUM_KNOWN_HOSTS': os.path.join(HOME, '.ssh', 'known_hosts')})
sys.path.insert(0, os.path.join(REPO, 'backend'))
os.chdir(os.path.join(REPO, 'backend'))

import accounts  # noqa: E402
import app as app_module  # noqa: E402
import oidc  # noqa: E402

failures = []
count = [0]


def check(name, ok, detail=''):
    count[0] += 1
    print(f"{'PASS' if ok else 'FAIL'}: {name}{'' if ok else ' | ' + str(detail)[:500]}")
    if not ok:
        failures.append(name)


BASE = 'https://console.example.test'
HDR = {'X-Requested-With': 'Jacarium'}
PASSWORD = 'correct horse battery staple'
SSO_ENV = {'JACARIUM_OIDC_ISSUER': 'https://idp.example.test/realms/demo', 'JACARIUM_OIDC_CLIENT_ID': 'jacarium',
           'JACARIUM_OIDC_CLIENT_SECRET': 'synthetic-client-secret', 'JACARIUM_PUBLIC_URL': BASE}
browser = lambda: app_module.app.test_client()  # noqa: E731
post = lambda c, path, payload=None, headers=None: c.post(path, json=payload or {}, headers={**HDR, **(headers or {})}, base_url=BASE)  # noqa: E731
get = lambda c, path, headers=None: c.get(path, headers=headers or {}, base_url=BASE)  # noqa: E731
caps = lambda c=None: get(c or browser(), '/api/capabilities').get_json()  # noqa: E731

# ---- 1. unconfigured --------------------------------------------------------
auth_block = caps()['auth']
check('unconfigured: capabilities carry the auth block as before plus "sso: off"', {k: v for k, v in auth_block.items() if k != 'sso'} == {'mode': 'accounts', 'setupRequired': True, 'user': None, 'admin': False}
      and auth_block['sso'] == {'enabled': False, 'passwordLogin': True}, auth_block)
check('unconfigured: the SSO routes answer 404 (begin, callback), unlink needs a session like any account route',
      post(browser(), '/api/auth/sso/begin').status_code == 404 and get(browser(), '/api/auth/sso/callback?code=c&state=s').status_code == 404 and post(browser(), '/api/auth/sso/unlink').status_code == 401)
check('unconfigured: the start-up line says it is off', 'single sign-on: off' in oidc.startup_summary())
admin = browser()
setup = post(admin, '/api/auth/setup', {'setupCode': open(os.path.join(HOME, 'setup-code')).read().strip(), 'username': 'admin', 'password': PASSWORD, 'displayName': 'Admin'})
user = setup.get_json()['user']
check('unconfigured: the setup code creates the administrator; the account has a password and no identity', setup.status_code == 201 and user['role'] == 'admin' and user['hasPassword'] is True and user['sso'] is None and user['ssoInviteEmail'] is None)
cookie = [h for h in setup.headers.getlist('Set-Cookie') if h.startswith('__Host-jacarium_session')]
check('unconfigured: the session cookie is what it was (__Host-, Secure, HttpOnly, SameSite=Strict) and no SSO cookie is set', len(cookie) == 1 and all(w in cookie[0] for w in ('Secure', 'HttpOnly', 'SameSite=Strict'))
      and not any(h.startswith(oidc.STATE_COOKIE) for h in setup.headers.getlist('Set-Cookie')))
created = post(admin, '/api/admin/users', {'username': 'bob', 'password': PASSWORD})
check('unconfigured: the administrator creates an account with a password; one without a password is refused', created.status_code == 201 and post(admin, '/api/admin/users', {'username': 'nopw', 'ssoEmail': 'nopw@example.test'}).status_code == 400
      and post(admin, '/api/admin/users', {'username': 'nopw'}).status_code == 400 and accounts.get_user_by_username('nopw') is None)
bob = browser()
signed = post(bob, '/api/auth/login', {'username': 'bob', 'password': PASSWORD})
check('unconfigured: password sign-in works; a wrong password is 401', signed.status_code == 200 and post(browser(), '/api/auth/login', {'username': 'bob', 'password': 'wrong password'}).status_code == 401)
check('unconfigured: changing the password needs the current one', post(bob, '/api/auth/password', {'newPassword': 'another long password'}).status_code == 403
      and post(bob, '/api/auth/password', {'currentPassword': PASSWORD, 'newPassword': 'another long password'}).status_code == 200
      and post(browser(), '/api/auth/login', {'username': 'bob', 'password': 'another long password'}).status_code == 200)
device = post(bob, '/api/auth/devices', {'password': 'another long password', 'name': 'laptop'})
token = (device.get_json() or {}).get('token')
bearer = {'Authorization': f'Bearer {token}'}
check('unconfigured: a browser session mints a device token, which signs requests', device.status_code in (200, 201) and bool(token) and get(browser(), '/api/auth/me', bearer).get_json()['user']['username'] == 'bob', device.get_data(as_text=True)[:200])
check('unconfigured: step-up over the device token takes the password', post(browser(), '/api/auth/step-up', {'password': 'wrong password'}, bearer).status_code == 403 and post(browser(), '/api/auth/step-up', {'password': 'another long password'}, bearer).status_code == 200)
out = post(bob, '/api/auth/logout')
check('unconfigured: signing out answers exactly {"ok": true} and ends the session', out.get_json() == {'ok': True} and get(bob, '/api/auth/me').status_code == 401)
check('unconfigured: the administration lists the accounts', [u['username'] for u in get(admin, '/api/admin/users').get_json()['users']] == ['admin', 'bob'])
check('unconfigured: nothing of single sign-on was loaded or created (PyJWT not imported, no sealing key, no state kept)', 'jwt' not in sys.modules
      and accounts.connection().execute('SELECT COUNT(*) FROM server_keys').fetchone()[0] == 0 and not oidc._used_states and not oidc._discovery_cache)
check('unconfigured: no audit line mentions single sign-on', not any(e['action'].startswith('sso-') for e in accounts.read_audit(2000)))

# ---- 2. an upgrade without any SSO setting ------------------------------------
OLD_SCHEMA = """
CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0, oidc_subject TEXT, created_at REAL NOT NULL,
    password_changed_at REAL NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at REAL NOT NULL, last_seen REAL NOT NULL, user_agent TEXT);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE device_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at REAL NOT NULL, last_seen REAL, revoked INTEGER NOT NULL DEFAULT 0);
"""
old_path = os.path.join(TMP, 'old', 'accounts.sqlite')
os.makedirs(os.path.dirname(old_path))
conn = sqlite3.connect(old_path, isolation_level=None)
conn.executescript(OLD_SCHEMA)
now = time.time()
for i, (name, role, disabled) in enumerate([('admin', 'admin', 0), ('bob', 'user', 0), ('carol', 'user', 1)]):
    conn.execute('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)', (f'u{i}', name, name.title(), accounts.hash_password(PASSWORD), role, disabled, now - i, now - i, 1 if name == 'bob' else 0))
conn.execute("INSERT INTO sessions VALUES (?, 'u0', ?, ?, 'old browser')", (accounts._session_hash('old-session'), now, now))
conn.execute("INSERT INTO device_tokens VALUES ('t1', 'u1', 'laptop', ?, ?, NULL, 0)", (accounts._token_hash('old-token'), now))
conn.execute("INSERT INTO device_tokens VALUES ('t2', 'u1', 'old laptop', ?, ?, ?, 1)", (accounts._token_hash('revoked-token'), now, now))
conn.close()


def dump(path, columns=None):
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    out = {}
    for table in ('users', 'sessions', 'device_tokens'):
        names = (columns or {}).get(table) or [r['name'] for r in c.execute(f'PRAGMA table_info({table})')]
        out[table] = (names, [tuple(r[n] for n in names) for r in c.execute(f'SELECT * FROM {table} ORDER BY id')])
    c.close()
    return out


before = dump(old_path)
os.environ['JACARIUM_ACCOUNTS_DB'] = old_path
accounts.reset_for_tests()
accounts.connection()
after = dump(old_path, {t: before[t][0] for t in before})
check('upgrade without SSO settings: every row of users, sessions and device tokens is identical in every column that existed', after == before)
full = dump(old_path)
new_columns = {t: [n for n in full[t][0] if n not in before[t][0]] for t in full}
check('...the only change is three empty columns and an empty key table', new_columns == {'users': ['oidc_issuer', 'sso_invite_email'], 'sessions': ['sso_at'], 'device_tokens': []}
      and all(row[full['users'][0].index('oidc_issuer')] is None and row[full['users'][0].index('sso_invite_email')] is None for row in full['users'][1])
      and all(row[full['sessions'][0].index('sso_at')] is None for row in full['sessions'][1]) and accounts.connection().execute('SELECT COUNT(*) FROM server_keys').fetchone()[0] == 0, new_columns)
accounts.reset_for_tests()
accounts.connection()
check('...a second start touches nothing', dump(old_path) == full)
check('...a copy of the database as it was sits next to it (accounts.sqlite.before-sso)', dump(old_path + '.before-sso') == before)
check('...the old password, session, device token, the disabled account and the pending password change behave as before', accounts.check_login('admin', PASSWORD)['role'] == 'admin' and accounts.validate_session('old-session')['username'] == 'admin'
      and accounts.validate_device_token('old-token')['username'] == 'bob' and accounts.validate_device_token('revoked-token') is None and accounts.check_login('carol', PASSWORD) is None
      and accounts.get_user('u1')['mustChangePassword'] is True and all(u['hasPassword'] and u['sso'] is None for u in accounts.list_users()))
os.environ.pop('JACARIUM_ACCOUNTS_DB')
accounts.reset_for_tests()

# ---- 4. side by side (configured, default) ------------------------------------
os.environ.update(SSO_ENV)
c = caps()['auth']['sso']
check('configured: single sign-on is on and password sign-in stays on (the default)', c['enabled'] is True and c['passwordLogin'] is True)
check('configured: users and administrators still sign in with their passwords', post(browser(), '/api/auth/login', {'username': 'bob', 'password': 'another long password'}).status_code == 200
      and post(browser(), '/api/auth/login', {'username': 'admin', 'password': PASSWORD}).status_code == 200)
# accounts as single sign-on leaves them
issuer = SSO_ENV['JACARIUM_OIDC_ISSUER']
dana = accounts.create_sso_user('dana', 'Dana', issuer=issuer, subject='subject-dana')
erin = accounts.create_sso_user('erin', 'Erin', issuer=issuer, subject='subject-erin')
accounts.link_identity(accounts.get_user_by_username('bob')['id'], issuer, 'subject-bob')
dana_browser, erin_browser = browser(), browser()
dana_browser.set_cookie('__Host-jacarium_session', accounts.create_session(dana['id'], 'browser', sso=True), domain='console.example.test', secure=True)
erin_raw = accounts.create_session(erin['id'], 'browser', sso=True)
erin_browser.set_cookie('__Host-jacarium_session', erin_raw, domain='console.example.test', secure=True)
accounts.connection().execute('UPDATE sessions SET sso_at = ? WHERE id = ?', (time.time() - 3600, accounts._session_hash(erin_raw)))

# ---- 3. ...and turned off again ------------------------------------------------
for key in SSO_ENV:
    os.environ.pop(key)
oidc.reset_for_tests()
check('turned off: capabilities say off, the routes are 404 again', caps()['auth']['sso'] == {'enabled': False, 'passwordLogin': True} and post(browser(), '/api/auth/sso/begin').status_code == 404
      and get(browser(), '/api/auth/sso/callback?code=c&state=s').status_code == 404)
check('turned off: the live sessions of SSO-only accounts go on', get(dana_browser, '/api/auth/me').get_json()['user']['username'] == 'dana' and get(erin_browser, '/api/auth/me').get_json()['user']['hasPassword'] is False)
check('turned off: an account with a password and a linked identity signs in with the password; the identity is still shown', post(browser(), '/api/auth/login', {'username': 'bob', 'password': 'another long password'}).status_code == 200
      and accounts.get_user_by_username('bob')['sso']['subject'] == 'subject-bob')
check('turned off: an SSO-only account cannot sign in with any password', post(browser(), '/api/auth/login', {'username': 'erin', 'password': ''}).status_code == 401 and post(browser(), '/api/auth/login', {'username': 'erin', 'password': PASSWORD}).status_code == 401)
check('turned off: a session fresh from single sign-on may still set its first password itself', post(dana_browser, '/api/auth/password', {'newPassword': 'dana picks a password'}).status_code == 200
      and post(browser(), '/api/auth/login', {'username': 'dana', 'password': 'dana picks a password'}).status_code == 200)
refusal = post(erin_browser, '/api/auth/password', {'newPassword': 'erin picks a password'})
check('turned off: an older session cannot (SSO_CONFIRM_REQUIRED)...', refusal.status_code == 403 and refusal.get_json().get('code') == 'SSO_CONFIRM_REQUIRED')
reset = post(admin, f"/api/admin/users/{erin['id']}/password", {'newPassword': 'set by the administrator'})
check('...the administrator sets a password for it, and it signs in', reset.status_code == 200 and post(browser(), '/api/auth/login', {'username': 'erin', 'password': 'set by the administrator'}).status_code == 200, reset.get_data(as_text=True)[:200])
recovered = accounts.recover_password('dana')
check('turned off: the host-side recovery works for such an account too', bool(recovered) and accounts.get_user_by_username('dana')['mustChangePassword'] is True)
bob = browser()
post(bob, '/api/auth/login', {'username': 'bob', 'password': 'another long password'})
check('turned off: unlinking still works with the password', post(bob, '/api/auth/sso/unlink', {'password': 'another long password'}).status_code == 200 and accounts.get_user_by_username('bob')['sso'] is None)
check('turned off: every account is listed, with what it has', {u['username']: (u['hasPassword'], bool(u['sso'])) for u in get(admin, '/api/admin/users').get_json()['users']}
      == {'admin': (True, False), 'bob': (True, False), 'dana': (True, True), 'erin': (True, True)})

# ---- 5. the other modes ----------------------------------------------------------
PROBE = r'''
import json, os, sys, tempfile
home = tempfile.mkdtemp(prefix='jacarium-sso-mode-')
for key in [k for k in os.environ if k.startswith('JACARIUM_')]:
    os.environ.pop(key)
os.environ.update({'HOME': home, 'JACARIUM_REPORTS_ROOT': os.path.join(home, 'reports'), 'JACARIUM_KNOWN_HOSTS': os.path.join(home, 'known_hosts')})
mode, token = sys.argv[2], 'synthetic-app-token'
if mode == 'none':
    os.environ['JACARIUM_AUTH_MODE'] = 'none'
else:
    os.environ['APP_AUTH_TOKEN'] = token
# what the single sign-on settings would be: they must change nothing outside accounts mode
os.environ.update({'JACARIUM_OIDC_ISSUER': 'https://idp.example.test', 'JACARIUM_OIDC_CLIENT_ID': 'x', 'JACARIUM_OIDC_CLIENT_SECRET': 'y', 'JACARIUM_PUBLIC_URL': 'https://console.example.test'})
sys.path.insert(0, sys.argv[1]); os.chdir(sys.argv[1])
import app as app_module
c = app_module.app.test_client()
h = {'X-Requested-With': 'Jacarium', **({'X-App-Token': token, 'Authorization': 'Bearer ' + token} if mode != 'none' else {})}
caps = c.get('/api/capabilities', headers=h)
begin = c.post('/api/auth/sso/begin', json={}, headers=h)
back = c.get('/api/auth/sso/callback?code=c&state=s', headers=h)
print(json.dumps({'caps': caps.status_code, 'auth': (caps.get_json() or {}).get('auth'), 'begin': begin.status_code, 'callback': back.status_code,
                  'jwt': 'jwt' in sys.modules, 'db': os.path.exists(os.path.join(home, 'accounts.sqlite'))}))
'''
for mode in ('none', 'app-token'):
    run = subprocess.run([sys.executable, '-c', PROBE, os.path.join(REPO, 'backend'), mode], capture_output=True, text=True, timeout=180)
    try:
        answer = json.loads(run.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        answer = {'error': (run.stdout + run.stderr)[-400:]}
    check(f'mode {mode} (even with the SSO settings present): no SSO block in the capabilities, the routes are not there, PyJWT is not imported, no accounts database',
          answer.get('auth') is not None and 'sso' not in (answer.get('auth') or {}) and answer.get('begin') in (401, 403, 404) and answer.get('callback') in (401, 403, 404)
          and answer.get('begin') != 200 and answer.get('jwt') is False and answer.get('db') is False, answer)

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{count[0] - len(failures)}/{count[0]} checks passed")
if failures:
    print('FAILED (' + str(len(failures)) + ' failed)')
    sys.exit(1)
print('All checks passed')
