#!/usr/bin/env python3
"""
Guards the host-side password recovery (backend/accounts.py: recover_password
and the `python -m accounts` command line; backend/auth.py + extensions.py:
a session opened with a temporary password may only change the password).

The scenario: the only administrator forgot their password. Whoever can run
commands on the server (the proof of ownership - there is no e-mail) runs
`python -m accounts reset-password <username>` inside the container
(deploy/deploy-to-host.sh <host> reset-password <username> does exactly
that over SSH).

What this test proves (Flask test client + the REAL CLI as a subprocess,
synthetic accounts in a temp directory):
  - list-users prints usernames, roles and state and never a hash/password
  - reset-password for an unknown user is refused with the known names
  - after a reset: the old password fails, the temporary one signs in, the
    user's earlier sessions are gone, device tokens stay (unless
    --revoke-devices), a disabled account is enabled again, --make-admin
    promotes
  - with the temporary password every API call but the password change is
    refused (403 passwordChangeRequired); /api/auth/me says mustChangePassword
  - changing the password clears the flag, the temporary password stops
    working, the new one works, the API is open again
  - the recovery is recorded in the audit log (no secret in it)

Run: backend/venv/bin/python tests/accounts_recovery.test.py
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-recovery-')
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


def body(r):
    try:
        return r.get_json() or {}
    except Exception:
        return {}


def client():
    return app_module.app.test_client()


def post(c, path, payload=None):
    return c.post(path, json=payload or {}, headers=HDR, base_url=BASE)


def get(c, path):
    return c.get(path, base_url=BASE)


def cli(*args):
    """The real command line, as the container runs it: python -m accounts ..."""
    r = subprocess.run([sys.executable, '-m', 'accounts', *args], cwd=BACKEND, env=dict(os.environ), capture_output=True, text=True, timeout=120)
    return r.returncode, r.stdout, r.stderr


# --- the accounts ------------------------------------------------------------------
code = open(os.path.join(HOME, 'setup-code')).read().strip()
admin = client()
r = post(admin, '/api/auth/setup', {'setupCode': code, 'username': 'alice', 'password': 'the forgotten one', 'displayName': 'Alice'})
check('the admin account exists', r.status_code == 201, r.get_data(as_text=True)[:100])
r = post(admin, '/api/admin/users', {'username': 'bob', 'password': 'bobs password 1', 'displayName': 'Bob'})
bob_id = body(r)['user']['id']
r = post(admin, '/api/auth/devices', {'name': 'alices laptop'})
device_token = body(r).get('token')
check('alice has a linked device (token) and an open session', bool(device_token) and get(admin, '/api/auth/me').status_code == 200)
accounts.reset_for_tests()   # the CLI is another process: make sure this one re-reads the file afterwards

# --- list-users ---------------------------------------------------------------------
rc, out, err = cli('list-users')
check('list-users lists the accounts with role and state', rc == 0 and 'alice' in out and 'admin' in out and 'bob' in out and 'active' in out, out.strip()[:200])
check('...without any hash or password', 'scrypt' not in out and 'the forgotten one' not in out and 'bobs password' not in out)

# --- unknown user --------------------------------------------------------------------
rc, out, err = cli('reset-password', 'nobody')
check('reset-password for an unknown user is refused and names the known users', rc == 1 and 'no such user' in err and 'alice' in err and 'bob' in err, err.strip()[:200])

# --- the reset ------------------------------------------------------------------------
rc, out, err = cli('reset-password', 'alice')
temp = next((line.split(':', 1)[1].strip() for line in out.splitlines() if line.startswith('Temporary password for alice:')), None)
check('reset-password prints a one-time temporary password', rc == 0 and temp and len(temp) == 19, out.strip()[:200])
check('...and says sessions ended, devices kept', 'session' in out and 'stay linked' in out)
accounts.reset_for_tests()

r = get(admin, '/api/auth/me')
check('alice\'s earlier session is gone', r.status_code == 401, str(r.status_code))
r = post(client(), '/api/auth/login', {'username': 'alice', 'password': 'the forgotten one'})
check('the old password no longer works', r.status_code == 401)
check('the device token still works (kept by default)', client().get('/api/auth/me', headers={'Authorization': f'Bearer {device_token}', **HDR}, base_url=BASE).status_code == 200)

alice = client()
r = post(alice, '/api/auth/login', {'username': 'alice', 'password': temp})
check('the temporary password signs in and says the password must change', r.status_code == 200 and body(r)['user']['mustChangePassword'] is True, r.get_data(as_text=True)[:160])
r = get(alice, '/api/auth/me')
check('/api/auth/me carries mustChangePassword', r.status_code == 200 and body(r)['user']['mustChangePassword'] is True)
r = get(alice, '/api/capabilities')
check('/api/capabilities does too (the app shows the change page first)', r.status_code == 200 and body(r)['auth']['user']['mustChangePassword'] is True)
r = get(alice, '/api/taskwarrior/check')
check('every other API call is refused until then (403 passwordChangeRequired)', r.status_code == 403 and body(r).get('passwordChangeRequired') is True, r.get_data(as_text=True)[:120])
r = get(alice, '/api/admin/users')
check('...admin routes included', r.status_code == 403 and body(r).get('passwordChangeRequired') is True)
r = post(alice, '/api/auth/password', {'currentPassword': 'wrong', 'newPassword': 'a brand new password'})
check('the change needs the temporary password as the current one', r.status_code == 403)
r = post(alice, '/api/auth/password', {'currentPassword': temp, 'newPassword': 'a brand new password'})
check('changing the password works and clears the flag', r.status_code == 200 and body(r)['user']['mustChangePassword'] is False, r.get_data(as_text=True)[:120])
r = get(alice, '/api/taskwarrior/check')
check('the API is open again in the same session', r.status_code != 403, str(r.status_code))
r = post(client(), '/api/auth/login', {'username': 'alice', 'password': temp})
check('the temporary password stops working', r.status_code == 401)
r = post(client(), '/api/auth/login', {'username': 'alice', 'password': 'a brand new password'})
check('the new password works, without the flag', r.status_code == 200 and body(r)['user']['mustChangePassword'] is False)
rc, out, err = cli('list-users')
check('list-users shows alice active again', rc == 0 and 'must-change' not in out.split('alice')[1].splitlines()[0])

# --- disabled account, --make-admin, --revoke-devices ----------------------------------
r = post(alice, '/api/admin/users/' + bob_id + '/disable')
check('bob is disabled by the admin', r.status_code == 200)
bob = client()
r = post(bob, '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'})
check('...and cannot sign in', r.status_code == 401)
accounts.reset_for_tests()
rc, out, err = cli('reset-password', 'bob', '--make-admin', '--revoke-devices')
temp_bob = next((line.split(':', 1)[1].strip() for line in out.splitlines() if line.startswith('Temporary password for bob:')), None)
check('reset-password on a disabled user with --make-admin --revoke-devices', rc == 0 and temp_bob and 'administrator now' in out and 'revoked' in out, out.strip()[:240])
accounts.reset_for_tests()
r = post(bob, '/api/auth/login', {'username': 'bob', 'password': temp_bob})
check('bob is enabled again, signs in with the temporary password, is an admin', r.status_code == 200 and body(r)['user']['role'] == 'admin' and body(r)['user']['disabled'] is False, r.get_data(as_text=True)[:160])
r = post(bob, '/api/auth/password', {'currentPassword': temp_bob, 'newPassword': 'bobs new password'})
check('bob chooses a new password', r.status_code == 200)
r = get(bob, '/api/admin/users')
check('...and uses the admin routes', r.status_code == 200)

accounts.reset_for_tests()
rc, out, err = cli('reset-password', 'alice', '--revoke-devices')
accounts.reset_for_tests()
check('--revoke-devices revokes the linked devices', rc == 0 and client().get('/api/auth/me', headers={'Authorization': f'Bearer {device_token}', **HDR}, base_url=BASE).status_code == 401)

# --- the audit log -----------------------------------------------------------------------
log_path = os.path.join(HOME, 'accounts-audit.log')
log = open(log_path).read() if os.path.exists(log_path) else ''
check('every recovery is in the audit log (who, what, when)', log.count('password-recovered') == 3 and 'user=alice' in log and 'user=bob' in log and 'by=host-cli' in log and 'made_admin=1' in log, log[:300])
check('...the audit log holds no password', temp not in log and temp_bob not in log and 'a brand new password' not in log)
check('...and is private (0600)', (os.stat(log_path).st_mode & 0o777) == 0o600)
check('the password change after a recovery is recorded too', 'password-changed-after-recovery user=alice' in log)

failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
