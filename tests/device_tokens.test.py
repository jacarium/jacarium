#!/usr/bin/env python3
"""
Guards device tokens: the desktop app's way of authenticating to a server
with accounts (backend/accounts.py create/validate/list/revoke_device_token,
backend/auth.py /api/auth/devices, the bearer path of the auth seam).

What this test proves (Flask test client, accounts mode, synthetic data):
  - a signed-in session mints a token (shown once; only its hash is stored)
    named after the device; the list shows it without the value;
  - `Authorization: Bearer <token>` authenticates an ordinary API request,
    /api/auth/me and the sync routes as that account;
  - the X-Requested-With header is still required on state-changing
    requests with a bearer token;
  - a bearer token cannot mint another token (password sign-in only);
  - a wrong token -> 401; a revoked token -> 401; a token of a disabled
    account -> 401; another account cannot revoke it (404);
  - the token value never appears in the accounts database.

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/device_tokens.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-device-tokens-')
HOME = os.path.join(TMP, 'data')
os.makedirs(HOME)
os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'accounts'
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(HOME, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, '.ssh', 'known_hosts')
for key in ('JACARIUM_ENV_FILE', 'JACARIUM_ACCOUNTS_DB'):
    os.environ.pop(key, None)

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


code = open(os.path.join(HOME, 'setup-code')).read().strip()
alice = app_module.app.test_client()
r = alice.post('/api/auth/setup', json={'setupCode': code, 'username': 'alice', 'password': 'alices password'}, headers=HDR, base_url=BASE)
assert r.status_code == 201
alice.post('/api/admin/users', json={'username': 'bob', 'password': 'bobs password'}, headers=HDR, base_url=BASE)
bob = app_module.app.test_client()
bob.post('/api/auth/login', json={'username': 'bob', 'password': 'bobs password'}, headers=HDR, base_url=BASE)

r = alice.post('/api/auth/devices', json={'name': 'laptop (robin+work)'}, headers=HDR, base_url=BASE)
minted = body(r)
token = minted.get('token', '')
check('a signed-in session mints a device token (shown once)', r.status_code == 201 and token.startswith('scd_') and minted.get('id'), r.get_data(as_text=True)[:120])
r = alice.get('/api/auth/devices', base_url=BASE)
devices = body(r).get('devices', [])
check('the device list shows the device without the token value', len(devices) == 1 and devices[0]['name'] == 'laptop (robin+work)' and devices[0]['revoked'] is False and token not in r.get_data(as_text=True))
check('only the hash is stored', token not in open(accounts.db_path(), 'rb').read().decode('latin-1'))

device = app_module.app.test_client()   # no cookie: a device
AUTH = {**HDR, 'Authorization': f'Bearer {token}'}
r = device.get('/api/auth/me', headers=AUTH, base_url=BASE)
check('a bearer token authenticates as the account', r.status_code == 200 and body(r)['user']['username'] == 'alice')
r = device.get('/api/taskwarrior/check', headers=AUTH, base_url=BASE)
check('...for an ordinary API route', r.status_code == 200)
r = device.get('/api/sync/status', headers=AUTH, base_url=BASE)
check('...and for the sync routes', r.status_code == 200 and body(r).get('enabled') is True)
r = device.post('/api/sync/push', json={'device': 'laptop', 'changes': []}, headers={'Authorization': f'Bearer {token}'}, base_url=BASE)
check('a state-changing request with a bearer token still needs X-Requested-With (403)', r.status_code == 403)
r = device.post('/api/sync/push', json={'device': 'laptop', 'changes': []}, headers=AUTH, base_url=BASE)
check('...and works with it', r.status_code == 200)
r = device.post('/api/auth/devices', json={'name': 'another'}, headers=AUTH, base_url=BASE)
check('a device cannot mint another device token (403)', r.status_code == 403)
r = device.get('/api/auth/me', headers={**HDR, 'Authorization': 'Bearer scd_wrong'}, base_url=BASE)
check('a wrong token -> 401', r.status_code == 401)
r = device.get('/api/auth/me', headers={**HDR, 'Authorization': 'Basic abc'}, base_url=BASE)
check('a non-bearer Authorization header is ignored (401, no session)', r.status_code == 401)

r = bob.delete(f"/api/auth/devices/{minted['id']}", headers=HDR, base_url=BASE)
check("another account cannot revoke alice's device (404)", r.status_code == 404)
check('...and the token still works', device.get('/api/auth/me', headers=AUTH, base_url=BASE).status_code == 200)
r = alice.delete(f"/api/auth/devices/{minted['id']}", headers=HDR, base_url=BASE)
check('the owner revokes it', r.status_code == 200)
check('a revoked token -> 401', device.get('/api/auth/me', headers=AUTH, base_url=BASE).status_code == 401)
check('the list shows it as revoked', body(alice.get('/api/auth/devices', base_url=BASE))['devices'][0]['revoked'] is True)

r = bob.post('/api/auth/devices', json={'name': 'bobs phone'}, headers=HDR, base_url=BASE)
bob_token = body(r)['token']
bob_id = body(bob.get('/api/auth/me', base_url=BASE))['user']['id']
alice.post(f'/api/admin/users/{bob_id}/disable', headers=HDR, base_url=BASE)
check("a disabled account's token -> 401", device.get('/api/auth/me', headers={**HDR, 'Authorization': f'Bearer {bob_token}'}, base_url=BASE).status_code == 401)

failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
