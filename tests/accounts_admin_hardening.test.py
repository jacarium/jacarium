#!/usr/bin/env python3
"""
Guards the administration hardening (backend/auth.py, backend/accounts.py):
  - last-administrator protection: the last admin can be neither disabled,
    demoted nor deleted (the lockout of a forgotten password must not be
    recreated by a click); a second admin may be demoted/deleted
  - role changes (promote / demote) and account deletion with a typed
    username; deleting oneself is refused; the home directory stays
  - sessions: one's own are listed (the current one marked), ended one by
    one or "everywhere else"; an administrator lists and ends anyone's
    sessions and revokes anyone's linked devices
  - the audit log view: sign-ins, failed attempts, password changes/resets,
    user administration, device and session events - administrators only,
    newest first, never a secret

Flask test client over https://console.test, synthetic accounts in a temp
directory. Run: backend/venv/bin/python tests/accounts_admin_hardening.test.py
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')
TMP = tempfile.mkdtemp(prefix='jacarium-admin-')
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


def client(agent='test'):
    c = app_module.app.test_client()
    c.environ_base['HTTP_USER_AGENT'] = agent
    return c


def post(c, path, payload=None):
    return c.post(path, json=payload or {}, headers=HDR, base_url=BASE)


def get(c, path):
    return c.get(path, base_url=BASE)


def delete(c, path, payload=None):
    return c.delete(path, json=payload or {}, headers=HDR, base_url=BASE)


code = open(os.path.join(HOME, 'setup-code')).read().strip()
alice = client('alice-laptop')
check('admin alice exists', post(alice, '/api/auth/setup', {'setupCode': code, 'username': 'alice', 'password': 'alices password', 'displayName': 'Alice'}).status_code == 201)
alice_id = body(get(alice, '/api/auth/me'))['user']['id']
bob_id = body(post(alice, '/api/admin/users', {'username': 'bob', 'password': 'bobs password 1', 'displayName': 'Bob'}))['user']['id']
bob = client('bob-phone')
check('bob signs in', post(bob, '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'}).status_code == 200)

# --- last-admin protection -------------------------------------------------------------
r = post(alice, f'/api/admin/users/{alice_id}/role', {'role': 'user'})
check('the last administrator cannot be demoted', r.status_code == 400 and 'last administrator' in body(r)['error'], body(r).get('error'))
r = post(alice, f'/api/admin/users/{alice_id}/disable')
check('...nor disabled (it is also herself)', r.status_code == 400)
r = delete(alice, f'/api/admin/users/{alice_id}', {'confirmUsername': 'alice'})
check('...nor deleted', r.status_code == 400, body(r).get('error'))
r = post(alice, f'/api/admin/users/{bob_id}/role', {'role': 'admin'})
check('bob is promoted to administrator', r.status_code == 200 and body(r)['user']['role'] == 'admin')
r = post(alice, f'/api/admin/users/{alice_id}/role', {'role': 'user'})
check('with two admins alice could be demoted (refused only for the LAST one) - she is, then promoted back', r.status_code == 200 and body(r)['user']['role'] == 'user')
check('...bob (admin) promotes alice again', post(bob, f'/api/admin/users/{alice_id}/role', {'role': 'admin'}).status_code == 200)
r = post(bob, f'/api/admin/users/{bob_id}/role', {'role': 'nonsense'})
check('an unknown role is refused', r.status_code == 400)
r = post(bob, f'/api/admin/users/{bob_id}/role', {'role': 'user'})
check('bob demotes himself (alice remains admin)', r.status_code == 200 and body(r)['user']['role'] == 'user')
check('bob is no administrator now', get(bob, '/api/admin/users').status_code == 403)
r = post(bob, f'/api/admin/users/{alice_id}/role', {'role': 'user'})
check('a non-admin cannot change roles', r.status_code == 403)

# --- sessions ----------------------------------------------------------------------------
bob2 = client('bob-tablet')
post(bob2, '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'})
r = get(bob, '/api/auth/sessions')
sessions = body(r)['sessions']
check('bob sees his two sessions, the current one marked, with their user agents', r.status_code == 200 and len(sessions) == 2 and sum(1 for s in sessions if s['current']) == 1 and {s['userAgent'] for s in sessions} == {'bob-phone', 'bob-tablet'}, str(sessions)[:200])
check('...session ids are the stored hashes, not cookie values', all(len(s['id']) == 64 for s in sessions))
other = next(s for s in sessions if not s['current'])
r = delete(bob, f'/api/auth/sessions/{other["id"]}')
check('bob ends his other session', r.status_code == 200 and get(bob2, '/api/auth/me').status_code == 401)
post(bob2, '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'})
r = delete(bob, '/api/auth/sessions')
check('"sign out everywhere else" ends the others and keeps this one', r.status_code == 200 and body(r)['ended'] == 1 and get(bob, '/api/auth/me').status_code == 200 and get(bob2, '/api/auth/me').status_code == 401)
r = delete(bob, f'/api/auth/sessions/{other["id"]}')
check('ending an unknown session is 404', r.status_code == 404)
# an admin over bob's sessions and devices
post(bob2, '/api/auth/login', {'username': 'bob', 'password': 'bobs password 1'})
tok = body(post(bob, '/api/auth/devices', {'name': 'bobs desktop'}))
r = get(alice, f'/api/admin/users/{bob_id}/sessions')
listing = body(r)
check('an admin lists bob\'s sessions and devices (nothing marked current)', r.status_code == 200 and len(listing['sessions']) == 2 and not any(s['current'] for s in listing['sessions']) and listing['devices'][0]['name'] == 'bobs desktop', str(listing)[:200])
victim = next(s for s in listing['sessions'] if s['userAgent'] == 'bob-tablet')
r = delete(alice, f'/api/admin/users/{bob_id}/sessions/{victim["id"]}')
check('...and ends one of them', r.status_code == 200 and get(bob2, '/api/auth/me').status_code == 401 and get(bob, '/api/auth/me').status_code == 200)
r = delete(alice, f'/api/admin/users/{bob_id}/devices/{listing["devices"][0]["id"]}')
check('...and revokes bob\'s device', r.status_code == 200 and client().get('/api/auth/me', headers={'Authorization': f'Bearer {tok["token"]}', **HDR}, base_url=BASE).status_code == 401)
check('a non-admin cannot list another user\'s sessions', get(bob, f'/api/admin/users/{alice_id}/sessions').status_code == 403)

# --- deletion ----------------------------------------------------------------------------
carol_id = body(post(alice, '/api/admin/users', {'username': 'carol', 'password': 'carols password', 'displayName': 'Carol'}))['user']['id']
carol_home = os.path.join(HOME, 'users', carol_id)
check('carol has a home directory', os.path.isdir(carol_home))
r = delete(alice, f'/api/admin/users/{carol_id}', {'confirmUsername': 'wrong'})
check('deleting needs the typed username', r.status_code == 400)
r = delete(alice, f'/api/admin/users/{carol_id}', {'confirmUsername': 'carol'})
check('carol is deleted; her home directory stays on the volume', r.status_code == 200 and get(alice, f'/api/admin/users/{carol_id}/sessions').status_code == 404 and os.path.isdir(carol_home))
check('...and cannot sign in', post(client(), '/api/auth/login', {'username': 'carol', 'password': 'carols password'}).status_code == 401)
check('deleting oneself is refused', delete(alice, f'/api/admin/users/{alice_id}', {'confirmUsername': 'alice'}).status_code == 400)
check('a non-admin cannot delete', delete(bob, f'/api/admin/users/{alice_id}', {'confirmUsername': 'alice'}).status_code == 403)

# --- a linked device (device token) administering the server -----------------------------
# The desktop app signs with a device token: reading the administration is allowed for an
# admin's token, every state-changing action needs the password once (step-up), audited.
dev = body(post(alice, '/api/auth/devices', {'name': 'alices desktop'}))
DEV = {'Authorization': f'Bearer {dev["token"]}', **HDR}
anon = client('alice-desktop')
r = anon.get('/api/admin/users', headers=DEV, base_url=BASE)
check('device token: an admin lists the users', r.status_code == 200 and any(u['username'] == 'bob' for u in body(r)['users']), r.status_code)
r = anon.get('/api/admin/audit?limit=5', headers=DEV, base_url=BASE)
check('device token: ...and reads the audit log', r.status_code == 200 and 'entries' in body(r), r.status_code)
r = anon.get(f'/api/admin/users/{bob_id}/sessions', headers=DEV, base_url=BASE)
check("device token: ...and a user's sessions and devices", r.status_code == 200 and 'sessions' in body(r))
bobdev = body(post(bob, '/api/auth/devices', {'name': 'bobs desktop'}))
BOBDEV = {'Authorization': f'Bearer {bobdev["token"]}', **HDR}
r = anon.get('/api/admin/users', headers=BOBDEV, base_url=BASE)
check("device token: a non-admin's token is refused (403)", r.status_code == 403)
r = anon.post('/api/admin/users', json={'username': 'carol', 'password': 'carols password 1'}, headers=DEV, base_url=BASE)
check('device token: creating a user WITHOUT the step-up is refused with STEP_UP_REQUIRED', r.status_code == 403 and body(r).get('code') == 'STEP_UP_REQUIRED', body(r))
check('...and nothing was created', not any(u['username'] == 'carol' for u in body(anon.get('/api/admin/users', headers=DEV, base_url=BASE))['users']))
r = anon.post('/api/auth/step-up', json={'password': 'not her password'}, headers=DEV, base_url=BASE)
check('step-up with the wrong password is refused', r.status_code == 403)
r = post(alice, '/api/auth/step-up', {'password': 'alices password'})
check('step-up over a password session is pointless and says so (400)', r.status_code == 400)
r = anon.post('/api/auth/step-up', json={'password': 'alices password'}, headers=DEV, base_url=BASE)
check('step-up with the right password is accepted', r.status_code == 200 and body(r).get('ok') is True, body(r))
r = anon.post('/api/admin/users', json={'username': 'carol', 'password': 'carols password 1'}, headers=DEV, base_url=BASE)
carol_id = body(r).get('user', {}).get('id')
check('...then the user is created over the device token', r.status_code == 201 and carol_id, body(r))
r = anon.post(f'/api/admin/users/{carol_id}/disable', json={}, headers=DEV, base_url=BASE)
check('the step-up is single use: the next action needs a new one', r.status_code == 403 and body(r).get('code') == 'STEP_UP_REQUIRED')
anon.post('/api/auth/step-up', json={'password': 'alices password'}, headers=DEV, base_url=BASE)
r = anon.post(f'/api/admin/users/{alice_id}/role', json={'role': 'user'}, headers=DEV, base_url=BASE)
check('last-admin protection holds over the device token route (alice is the only admin again)', r.status_code == 400 and 'last administrator' in body(r).get('error', ''), body(r))
anon.post('/api/auth/step-up', json={'password': 'alices password'}, headers=DEV, base_url=BASE)
r = anon.delete(f'/api/admin/users/{carol_id}', json={'confirmUsername': 'carol'}, headers=DEV, base_url=BASE)
check('with a fresh step-up the deletion goes through', r.status_code == 200, body(r))
raw_audit = open(os.path.join(HOME, 'accounts-audit.log')).read() if os.path.exists(os.path.join(HOME, 'accounts-audit.log')) else ''
check('the step-ups and the failed one are audited', 'step-up' in raw_audit and 'step-up-failed' in raw_audit and 'user-created' in raw_audit and 'user-deleted' in raw_audit)
check('...and the password never', 'alices password' not in raw_audit and 'not her password' not in raw_audit)
r = anon.post('/api/account/data/delete', json={'password': 'alices password', 'confirmUsername': 'alice', 'includeFiles': False}, headers=DEV, base_url=BASE)
check('"Delete all my data" still refuses a device token', r.status_code in (401, 403), r.status_code)
# bob's test device goes again so the device checks below see only what they create
r = anon.delete(f'/api/auth/devices/{bobdev["id"]}', headers=BOBDEV, base_url=BASE)
check("bob's desktop token is revoked again (by itself)", r.status_code == 200, r.status_code)

# --- the audit view ----------------------------------------------------------------------
post(client(), '/api/auth/login', {'username': 'bob', 'password': 'nope nope nope'})
r = get(alice, '/api/admin/audit?limit=100')
entries = body(r)['entries']
actions = [e['action'] for e in entries]
check('the admin reads the audit log, newest first', r.status_code == 200 and entries[0]['action'] == 'sign-in-failed' and entries[0]['fields'].get('user') == 'bob', str(entries[:2])[:200])
for action in ['sign-in', 'sign-in-failed', 'user-created', 'role-changed', 'session-ended', 'sessions-ended', 'device-linked', 'device-revoked', 'user-deleted']:
    check(f'...it records {action}', action in actions)
check('...entries carry who did it', any(e['action'] == 'user-deleted' and e['fields'].get('by') == 'alice' and e['fields'].get('user') == 'carol' for e in entries))
raw = open(os.path.join(HOME, 'accounts-audit.log')).read()
check('...and no password or token ever', 'alices password' not in raw and 'bobs password' not in raw and tok['token'] not in raw and 'scrypt' not in raw)
check('a non-admin cannot read it', get(bob, '/api/admin/audit').status_code == 403)

failed = [n for n, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
