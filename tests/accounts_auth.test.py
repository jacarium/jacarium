#!/usr/bin/env python3
"""
Guards sign-in for the browser deployment (JACARIUM_AUTH_MODE=accounts:
backend/accounts.py, backend/auth.py, the seam in backend/extensions.py).

What this test proves (Flask test client over https://console.test, a
throwaway HOME as the data volume, synthetic accounts only):
  - first run: a setup code exists on disk (0600); API routes answer 401
    with setupRequired; /api/capabilities says so without a session;
  - /api/auth/setup: wrong code -> 403; right code creates the admin, a
    session cookie (__Host-, Secure, HttpOnly, SameSite=Strict), removes
    the code file; a second setup -> 409 (and two concurrent setups can
    only ever create one admin: create_user(require_empty) is atomic);
  - CSRF: a state-changing request without X-Requested-With -> 403, even
    with a valid session; GET needs no header;
  - login: wrong password 401, disabled account 401, success sets the
    cookie; /api/auth/me reflects it; logout ends it (the old cookie is
    dead afterwards);
  - rate limit: repeated failures for one username -> 429 with Retry-After;
  - sessions expire: idle and absolute limits (timestamps edited in the DB);
  - password change needs the current password, ends the other sessions;
  - admin routes: a plain user gets 403; the admin creates / disables /
    enables / resets; the last admin cannot be disabled; a user cannot
    disable themselves;
  - a signed-in user reaches an ordinary API route (Taskwarrior /check).

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/accounts_auth.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import sqlite3
import stat
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-accounts-')
HOME = os.path.join(TMP, 'data')
os.makedirs(HOME)
os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'accounts'
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(HOME, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, '.ssh', 'known_hosts')
os.environ.pop('JACARIUM_ENV_FILE', None)
os.environ.pop('JACARIUM_ACCOUNTS_DB', None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402
import accounts  # noqa: E402

BASE = 'https://console.test'
HDR = {'X-Requested-With': 'Jacarium'}
results = []


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


def cookie_of(client):
    return client.get_cookie('__Host-jacarium_session', domain='console.test')


# --- first run ---------------------------------------------------------------
code_path = os.path.join(HOME, 'setup-code')
check('a setup code was written on start', os.path.isfile(code_path) and stat.S_IMODE(os.stat(code_path).st_mode) == 0o600)
code = open(code_path).read().strip()
check('the code has the expected shape', len(code) == 20 and code.count('-') == 2, code)

anon = new_client()
r = get(anon, '/api/taskwarrior/check')
check('an API route without a session answers 401 + setupRequired', r.status_code == 401 and body(r).get('setupRequired') is True and body(r).get('authMode') == 'accounts', r.get_data(as_text=True)[:120])
r = get(anon, '/api/capabilities')
caps = body(r)
check('/api/capabilities is reachable and reports setupRequired, no user', r.status_code == 200 and caps.get('authMode') == 'accounts' and caps['auth']['setupRequired'] is True and caps['auth']['user'] is None, str(caps.get('auth')))
r = get(anon, '/health')
check('/health needs nothing', r.status_code == 200)
r = post(anon, '/api/auth/login', {'username': 'nobody', 'password': 'whatever1'})
check('login before setup says setupRequired (409)', r.status_code == 409 and body(r).get('setupRequired') is True)

# --- setup ---------------------------------------------------------------------
r = post(anon, '/api/auth/setup', {'setupCode': 'wrong-code-x', 'username': 'alice', 'password': 'correct horse battery'})
check('setup with a wrong code is refused (403) and creates nothing', r.status_code == 403 and accounts.user_count() == 0)
r = anon.post('/api/auth/setup', json={'setupCode': code, 'username': 'alice', 'password': 'correct horse battery'}, base_url=BASE)
check('setup without the CSRF header is refused (403)', r.status_code == 403 and accounts.user_count() == 0, r.get_data(as_text=True)[:80])
r = post(anon, '/api/auth/setup', {'setupCode': code, 'username': 'Alice', 'password': 'short'})
check('setup with a too-short password is refused (400)', r.status_code == 400 and accounts.user_count() == 0)
admin = new_client()
r = post(admin, '/api/auth/setup', {'setupCode': code.upper(), 'username': 'Alice', 'password': 'correct horse battery', 'displayName': 'Alice A.'})
created = body(r)
check('setup with the code creates the admin (201) and signs them in',
      r.status_code == 201 and created.get('user', {}).get('username') == 'alice' and created['user']['role'] == 'admin' and created['user']['displayName'] == 'Alice A.',
      r.get_data(as_text=True)[:200])
set_cookie = r.headers.get('Set-Cookie', '')
check('the session cookie is __Host-, Secure, HttpOnly, SameSite=Strict, Path=/',
      set_cookie.startswith('__Host-jacarium_session=') and 'Secure' in set_cookie and 'HttpOnly' in set_cookie and 'SameSite=Strict' in set_cookie and 'Path=/' in set_cookie, set_cookie[:160])
check('the setup code file is gone', not os.path.exists(code_path))
check('migration report included (nothing to adopt in an empty data dir)', isinstance(created.get('migration'), dict) and created['migration'].get('copied') == [], str(created.get('migration'))[:200])
r = post(new_client(), '/api/auth/setup', {'setupCode': code, 'username': 'bob', 'password': 'another password'})
check('a second setup is refused (409)', r.status_code == 409 and accounts.user_count() == 1)
try:
    accounts.create_user('eve', 'password-eve-1', role='admin', require_empty=True)
    check('create_user(require_empty) refuses once a user exists (the race guard)', False)
except accounts.AccountsError:
    check('create_user(require_empty) refuses once a user exists (the race guard)', True)

# --- the signed-in admin -------------------------------------------------------
r = get(admin, '/api/auth/me')
check('/api/auth/me returns the user', r.status_code == 200 and body(r)['user']['username'] == 'alice')
r = get(admin, '/api/taskwarrior/check')
check('an ordinary API route works with the session', r.status_code == 200)
r = get(admin, '/api/capabilities')
check('capabilities now carry the user and admin=true', body(r)['auth']['user']['username'] == 'alice' and body(r)['auth']['admin'] is True and body(r)['auth']['setupRequired'] is False)
r = admin.put('/api/settings', json={'values': {'JIRA_EMAIL': 'a@example.test'}}, base_url=BASE)
check('a state-changing request without X-Requested-With is refused (403) even when signed in', r.status_code == 403)
r = admin.put('/api/settings', json={'values': {'JIRA_EMAIL': 'a@example.test'}}, headers=HDR, base_url=BASE)
check('...and accepted with it', r.status_code == 200, r.get_data(as_text=True)[:100])

# --- users: create / login / disable -----------------------------------------
r = post(admin, '/api/admin/users', {'username': 'bob', 'password': 'bobs password 1', 'displayName': 'Bob'})
bob_id = body(r).get('user', {}).get('id')
check('the admin creates a user (201)', r.status_code == 201 and bob_id, r.get_data(as_text=True)[:120])
r = post(admin, '/api/admin/users', {'username': 'bob', 'password': 'bobs password 1'})
check('a duplicate username is refused (409)', r.status_code == 409)
r = post(admin, '/api/admin/users', {'username': 'Bad Name!', 'password': 'bobs password 1'})
check('an invalid username is refused (400)', r.status_code == 400)

bob = new_client()
r = post(bob, '/api/auth/login', {'username': 'bob', 'password': 'wrong password'})
check('wrong password -> 401', r.status_code == 401 and not cookie_of(bob))
r = post(bob, '/api/auth/login', {'username': 'BOB', 'password': 'bobs password 1'})
check('login works (username case-insensitive) and sets the cookie', r.status_code == 200 and body(r)['user']['username'] == 'bob' and cookie_of(bob))
r = get(bob, '/api/admin/users')
check('a plain user gets 403 on admin routes', r.status_code == 403)
r = post(bob, '/api/admin/users', {'username': 'carol', 'password': 'carols password'})
check('...for writes too', r.status_code == 403 and accounts.get_user_by_username('carol') is None)

r = post(admin, f'/api/admin/users/{bob_id}/disable')
check('the admin disables bob', r.status_code == 200 and body(r)['user']['disabled'] is True)
r = get(bob, '/api/auth/me')
check("bob's existing session is ended by the disable", r.status_code == 401)
r = post(new_client(), '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'})
check('a disabled account cannot sign in (401)', r.status_code == 401)
r = post(admin, f'/api/admin/users/{bob_id}/enable')
check('the admin enables bob again', r.status_code == 200 and body(r)['user']['disabled'] is False)
admin_id = created['user']['id']
r = post(admin, f'/api/admin/users/{admin_id}/disable')
check('an admin cannot disable themselves (400)', r.status_code == 400)
r = post(admin, '/api/admin/users/no-such-id/disable')
check('an unknown user id is 404', r.status_code == 404)

# --- rate limit ------------------------------------------------------------------
import auth as auth_module  # noqa: E402
auth_module.login_user_limiter.reset()
auth_module.login_ip_limiter.reset()
statuses = []
for _ in range(10):
    r = post(new_client(), '/api/auth/login', {'username': 'bob', 'password': 'nope nope nope'})
    statuses.append(r.status_code)
check('repeated failures for one username become 429 with Retry-After',
      statuses[:8] == [401] * 8 and statuses[8] == 429 and r.headers.get('Retry-After'), str(statuses))
auth_module.login_user_limiter.reset()
auth_module.login_ip_limiter.reset()

# --- logout / sessions ----------------------------------------------------------------
bob = new_client()
post(bob, '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'})
raw_cookie = cookie_of(bob).value
r = post(bob, '/api/auth/logout')
check('logout answers ok and clears the cookie', r.status_code == 200 and 'Max-Age=0' in r.headers.get('Set-Cookie', ''))
bob2 = new_client()
bob2.set_cookie('__Host-jacarium_session', raw_cookie, domain='console.test')
r = get(bob2, '/api/auth/me')
check('the old cookie is dead after logout', r.status_code == 401)

bob = new_client()
post(bob, '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'})
conn = sqlite3.connect(accounts.db_path())
conn.execute('UPDATE sessions SET last_seen = ? WHERE user_id = ?', (time.time() - accounts.SESSION_IDLE_SECONDS - 10, bob_id))
conn.commit()
r = get(bob, '/api/auth/me')
check('an idle session (30 days unused) is expired', r.status_code == 401)
bob = new_client()
post(bob, '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'})
conn.execute('UPDATE sessions SET created_at = ? WHERE user_id = ?', (time.time() - accounts.SESSION_MAX_AGE_SECONDS - 10, bob_id))
conn.commit()
r = get(bob, '/api/auth/me')
check('a session older than the absolute limit (90 days) is expired', r.status_code == 401)
conn.close()

# --- password change --------------------------------------------------------------------
bob = new_client()
post(bob, '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'})
other = new_client()
post(other, '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'})
r = post(bob, '/api/auth/password', {'currentPassword': 'wrong', 'newPassword': 'bobs new password'})
check('password change needs the current password (403)', r.status_code == 403)
r = post(bob, '/api/auth/password', {'currentPassword': 'bobs password 1', 'newPassword': 'bobs new password'})
check('password change works', r.status_code == 200)
check('...keeps this session', get(bob, '/api/auth/me').status_code == 200)
check('...and ends the other session', get(other, '/api/auth/me').status_code == 401)
r = post(new_client(), '/api/auth/login', {'username': 'bob', 'password': 'bobs new password'})
check('the new password signs in', r.status_code == 200)
r = post(admin, f'/api/admin/users/{bob_id}/password', {'newPassword': 'reset by admin'})
check('the admin resets a password', r.status_code == 200 and post(new_client(), '/api/auth/login', {'username': 'bob', 'password': 'reset by admin'}).status_code == 200)
bob = new_client()  # (the admin's reset ended bob's sessions)
post(bob, '/api/auth/login', {'username': 'bob', 'password': 'reset by admin'})
r = post(bob, '/api/auth/profile', {'displayName': 'Robert'})
check('a user changes their display name', r.status_code == 200 and body(r)['user']['displayName'] == 'Robert')

# (the account's central-server pairing routes of 3.0/3.1 are gone: the
# central server recognises accounts by ticket, nothing is paired)
r = get(admin, '/api/auth/central')
check('central pairing routes are gone (404)', r.status_code == 404)

# --- the store itself ----------------------------------------------------------------
check('passwords are stored as scrypt hashes, not plain text',
      sqlite3.connect(accounts.db_path()).execute('SELECT password_hash FROM users').fetchone()[0].startswith('scrypt$')
      and 'reset by admin' not in open(accounts.db_path(), 'rb').read().decode('latin-1'))
check('session ids are stored hashed (the cookie value is not in the DB)', raw_cookie not in open(accounts.db_path(), 'rb').read().decode('latin-1'))
check('the accounts DB is 0600', stat.S_IMODE(os.stat(accounts.db_path()).st_mode) == 0o600)

failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
