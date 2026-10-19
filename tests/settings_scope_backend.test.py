#!/usr/bin/env python3
"""
The settings scope, server side (backend/settings_store.py, auth.py,
sync_api.py): what lets a linked desktop run on its account's settings.

Accounts mode (Flask test client, a throwaway HOME, synthetic accounts):
  1. GET /api/settings/effective is for device tokens only: a browser
     session gets 403 (even the account's own), a device token 200; the
     answer is the account file over the server defaults with a source per
     key; secret VALUES only with ?secrets=1; another account's token never
     sees this account's keys; the fetch is audited by key name (never a
     value) and rate-limited (429 with Retry-After);
  2. revisions: every save bumps a per-key and a file revision, GET returns
     them, PUT with ifRevision for a key that changed since answers 409 with
     the key's current value (a secret as set / not set) and writes nothing;
     a matching ifRevision saves;
  3. a save is audited ('settings-saved', scope + key names), the server
     defaults' save as scope=server; PUT is rate-limited;
  4. /api/sync/status carries settingsRevision and serverSettingsRevision.
App-token mode (a second client in the same process, the mode switched):
  5. POST /api/internal/settings installs the overlay: setting() answers
     from it alone (a key the file sets but the overlay does not is unset -
     the scope is whole), /api/ai/models skips the env-file re-read, GET
     shows the state; {active:false} returns the file; a non-loopback
     address is refused; the route does not exist with accounts.

Run:  backend/venv/bin/python tests/settings_scope_backend.test.py
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')
TMP = tempfile.mkdtemp(prefix='jacarium-settings-scope-')
HOME = os.path.join(TMP, 'data')
os.makedirs(HOME)
os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'accounts'
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(HOME, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, '.ssh', 'known_hosts')
os.environ.pop('JACARIUM_ENV_FILE', None)
os.environ.pop('JACARIUM_ACCOUNTS_DB', None)
os.environ.pop('ANTHROPIC_API_KEY', None)
os.environ.pop('DEFAULT_AI_PROVIDER', None)
sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402
import accounts  # noqa: E402
import settings_store  # noqa: E402
import user_context  # noqa: E402

BASE = 'https://console.test'
HDR = {'X-Requested-With': 'Jacarium'}
results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({str(detail)[:300]})' if detail and not passed else ''}")


def body(r):
    try:
        return r.get_json() or {}
    except Exception:
        return {}


def client():
    return app_module.app.test_client()


def post(c, path, payload=None, headers=None):
    return c.post(path, json=payload or {}, headers={**HDR, **(headers or {})}, base_url=BASE)


def put(c, path, payload=None, headers=None):
    return c.put(path, json=payload or {}, headers={**HDR, **(headers or {})}, base_url=BASE)


def get(c, path, headers=None):
    return c.get(path, headers=headers or {}, base_url=BASE)


def audit_text():
    try:
        return open(accounts.audit_log_path(), encoding='utf-8').read()
    except OSError:
        return ''


exit_code = 1
try:
    # ---- accounts: alice (admin) and bob, a session each, a device token each ----
    setup_code = open(os.path.join(HOME, 'setup-code')).read().strip()
    alice = client()
    r = post(alice, '/api/auth/setup', {'setupCode': setup_code, 'username': 'alice', 'password': 'alices password'})
    check('setup creates the admin', r.status_code == 201, r.status_code)
    r = post(alice, '/api/admin/users', {'username': 'bob', 'password': 'bobs password!'})
    check('the admin creates bob', r.status_code == 201, body(r))
    bob = client()
    post(bob, '/api/auth/login', {'username': 'bob', 'password': 'bobs password!'})
    alice_token = body(post(alice, '/api/auth/devices', {'name': 'alices mac'}))['token']
    bob_token = body(post(bob, '/api/auth/devices', {'name': 'bobs mac'}))['token']
    DEV_A = {'Authorization': f'Bearer {alice_token}'}
    DEV_B = {'Authorization': f'Bearer {bob_token}'}

    # the server defaults (admin) and alice's own file
    r = put(alice, '/api/admin/settings', {'values': {'DEFAULT_AI_PROVIDER': 'anthropic', 'DEFAULT_AI_TEMPERATURE': '0.2'}, 'secrets': {'OPENAI_API_KEY': 'sk-everyone'}})
    check('the admin sets server defaults (a plain value and a secret)', r.status_code == 200, body(r))
    r = put(alice, '/api/settings', {'values': {'DEFAULT_AI_PROVIDER': 'ollama', 'DEFAULT_AI_MODEL': 'qwen3:30b'}, 'secrets': {'ANTHROPIC_API_KEY': 'sk-ant-alice'}})
    check('alice sets her own (provider overrides the default, a secret of her own)', r.status_code == 200 and body(r).get('revision') == 1, body(r))
    rev1 = body(r)['revisions']
    check('the save answers with per-key revisions', rev1.get('DEFAULT_AI_PROVIDER') == 1 and rev1.get('ANTHROPIC_API_KEY') == 1, rev1)

    # ---- 1. the effective endpoint ----
    r = get(alice, '/api/settings/effective?secrets=1')
    check('effective: a browser session is refused (403), even the account\'s own', r.status_code == 403, r.status_code)
    r = get(client(), '/api/settings/effective?secrets=1', headers=DEV_A)
    eff = body(r)
    check('effective: alice\'s device token gets the resolved settings', r.status_code == 200 and eff.get('values', {}).get('DEFAULT_AI_PROVIDER') == 'ollama' and eff['values'].get('DEFAULT_AI_TEMPERATURE') == '0.2', eff)
    check('...with the source of each key (account over everyone)', eff.get('sources', {}).get('DEFAULT_AI_PROVIDER') == 'account' and eff['sources'].get('DEFAULT_AI_TEMPERATURE') == 'everyone' and eff['sources'].get('OPENAI_API_KEY') == 'everyone', eff.get('sources'))
    check('...and the secret VALUES with ?secrets=1 (hers and the inherited one)', eff.get('secretValues', {}).get('ANTHROPIC_API_KEY') == 'sk-ant-alice' and eff['secretValues'].get('OPENAI_API_KEY') == 'sk-everyone' and 'ANTHROPIC_API_KEY' not in eff.get('values', {}), eff.get('secretValues'))
    r = get(client(), '/api/settings/effective', headers=DEV_A)
    check('without ?secrets=1 the secrets are set / not set only', r.status_code == 200 and 'secretValues' not in body(r) and body(r).get('secrets', {}).get('ANTHROPIC_API_KEY') is True, body(r))
    r = get(client(), '/api/settings/effective?secrets=1', headers=DEV_B)
    check('bob\'s device token sees bob\'s settings: the inherited default, none of alice\'s keys', r.status_code == 200 and body(r)['values'].get('DEFAULT_AI_PROVIDER') == 'anthropic' and 'ANTHROPIC_API_KEY' not in body(r).get('secretValues', {}), body(r))
    log = audit_text()
    check('the fetch with secrets is audited by key name, never a value', 'settings-fetched-with-secrets' in log and 'user=alice' in log and 'by=device-token' in log and 'ANTHROPIC_API_KEY' in log and 'sk-ant-alice' not in log, log[-300:])
    statuses = [get(client(), '/api/settings/effective', headers=DEV_B).status_code for _ in range(25)]
    check('the effective endpoint is rate-limited (429 after 20 a minute, with Retry-After)', 429 in statuses and statuses[-1] == 429, statuses)
    settings_store.effective_limiter.clear('user:%s' % body(get(bob, '/api/auth/me'))['user']['id'])
    r = get(client(), '/api/settings/effective')
    check('no credentials at all: 401 from the session check', r.status_code == 401, r.status_code)

    # ---- 2. revisions and 409 ----
    r = get(alice, '/api/settings')
    check('GET /api/settings returns the revision and the per-key revisions', body(r).get('revision') == 1 and body(r).get('revisions', {}).get('DEFAULT_AI_MODEL') == 1, body(r))
    # the phone changes the model
    r = put(alice, '/api/settings', {'values': {'DEFAULT_AI_PROVIDER': 'ollama', 'DEFAULT_AI_MODEL': 'llama3'}, 'secrets': {}})
    check('a second save bumps the file revision to 2 and only the changed key', body(r).get('revision') == 2 and body(r)['revisions'].get('DEFAULT_AI_MODEL') == 2 and body(r)['revisions'].get('DEFAULT_AI_PROVIDER') == 1, body(r))
    # the desktop saves with what it saw before (model rev 1): refused
    r = put(client(), '/api/settings', {'values': {'DEFAULT_AI_MODEL': 'qwen3:30b', 'DEFAULT_AI_PROVIDER': 'ollama'}, 'secrets': {}, 'ifRevision': {'DEFAULT_AI_MODEL': 1, 'DEFAULT_AI_PROVIDER': 1}}, headers=DEV_A)
    conflict = body(r)
    check('a save with a stale ifRevision answers 409 with the key\'s current value and revision, and writes nothing', r.status_code == 409 and conflict.get('conflicts') == [{'key': 'DEFAULT_AI_MODEL', 'revision': 2, 'current': 'llama3'}] and settings_store.read_env_file(os.path.join(HOME, 'users', body(get(alice, '/api/auth/me'))['user']['id'], '.jacarium.env')).get('DEFAULT_AI_MODEL') == 'llama3', conflict)
    r = put(client(), '/api/settings', {'values': {'DEFAULT_AI_PROVIDER': 'ollama', 'DEFAULT_AI_MODEL': 'llama3'}, 'secrets': {}, 'ifRevision': {'ANTHROPIC_API_KEY': 0}}, headers=DEV_A)
    check('a stale check on a secret reports it as set / not set, never the value', r.status_code == 409 and body(r)['conflicts'] == [{'key': 'ANTHROPIC_API_KEY', 'revision': 1, 'current': True}], body(r))
    r = put(client(), '/api/settings', {'values': {'DEFAULT_AI_PROVIDER': 'ollama', 'DEFAULT_AI_MODEL': 'qwen3:30b'}, 'secrets': {}, 'ifRevision': {'DEFAULT_AI_MODEL': 2}}, headers=DEV_A)
    check('a save over the device token with a matching ifRevision is accepted (revision 3)', r.status_code == 200 and body(r).get('revision') == 3, body(r))
    r = put(alice, '/api/settings', {'values': {'DEFAULT_AI_PROVIDER': 'ollama', 'DEFAULT_AI_MODEL': 'qwen3:30b'}, 'secrets': {}})
    check('a save that changes nothing keeps the revision', body(r).get('revision') == 3, body(r))

    # ---- 3. audit + rate limit on saves ----
    log = audit_text()
    check("saves are audited: 'settings-saved scope=own keys=...' by session and by device-token, and the server defaults as scope=server", 'settings-saved' in log and 'scope=own' in log and 'scope=server' in log and 'keys=DEFAULT_AI_MODEL' in log and 'by=device-token' in log, log[-500:])
    check('no secret value ever reaches the audit log', 'sk-ant-alice' not in log and 'sk-everyone' not in log)
    statuses = [put(bob, '/api/settings', {'values': {'DEFAULT_AI_MODEL': 'm%d' % i}, 'secrets': {}}).status_code for i in range(65)]
    check('PUT /api/settings is rate-limited (429 after 60 a minute)', 429 in statuses, statuses[-3:])

    # ---- 4. sync status ----
    r = get(alice, '/api/sync/status')
    check('/api/sync/status carries settingsRevision (3) and serverSettingsRevision (1)', body(r).get('settingsRevision') == 3 and body(r).get('serverSettingsRevision') == 1, body(r))

    # ---- internal route is absent with accounts ----
    r = post(alice, '/api/internal/settings', {'active': False})
    check('/api/internal/settings does not exist with sign-in (404)', r.status_code == 404, r.status_code)

    # ---- 5. app-token mode: the overlay ----
    os.environ['JACARIUM_AUTH_MODE'] = 'app-token'
    import extensions
    extensions.AUTH_MODE = 'app-token'
    extensions.APP_AUTH_TOKEN = 'test-app-token'
    user_context._AUTH_MODE_ENV = user_context._AUTH_MODE_ENV  # (reads os.environ per call)
    TOK = {'X-App-Token': 'test-app-token'}
    local = app_module.app.test_client()
    os.environ['ANTHROPIC_API_KEY'] = 'sk-file'          # what the profile file would have loaded
    os.environ['DEFAULT_AI_PROVIDER'] = 'anthropic'
    with app_module.app.test_request_context():
        check('before the overlay setting() reads the environment (the file)', settings_store.setting('ANTHROPIC_API_KEY') == 'sk-file' and settings_store.setting('DEFAULT_AI_PROVIDER') == 'anthropic')
    r = local.post('/api/internal/settings', json={'active': True, 'values': {'DEFAULT_AI_PROVIDER': 'ollama', 'CUSTOM_AI_ENDPOINT': 'http://ollama.lan:11434/api/chat', 'OPENAI_API_KEY': 'sk-account'}}, headers=TOK, environ_base={'REMOTE_ADDR': '127.0.0.1'})
    check('the main process installs the overlay over the loopback with the app token', r.status_code == 200 and body(r).get('active') is True and body(r).get('keys') == ['CUSTOM_AI_ENDPOINT', 'DEFAULT_AI_PROVIDER', 'OPENAI_API_KEY'], body(r))
    with app_module.app.test_request_context():
        check('setting() now answers from the overlay alone: the account\'s provider and key...', settings_store.setting('DEFAULT_AI_PROVIDER') == 'ollama' and settings_store.setting('OPENAI_API_KEY') == 'sk-account')
        check('...and a key the file set but the account does not is UNSET (the scope is whole, no mixing)', settings_store.setting('ANTHROPIC_API_KEY') is None and settings_store.setting('ANTHROPIC_API_KEY', 'd') == 'd')
    r = local.get('/api/internal/settings', headers=TOK, environ_base={'REMOTE_ADDR': '127.0.0.1'})
    check('GET shows the overlay state (active, key names only)', body(r).get('active') is True and 'OPENAI_API_KEY' in body(r).get('keys', []) and 'sk-account' not in r.get_data(as_text=True), body(r))
    r = local.get('/api/ai/models', headers=TOK, environ_base={'REMOTE_ADDR': '127.0.0.1'})
    check('/api/ai/models reports the account defaults while the overlay is active (no env-file re-read)', r.status_code == 200 and body(r).get('defaults', {}).get('provider') == 'ollama', body(r).get('defaults'))
    r = local.post('/api/internal/settings', json={'active': True, 'values': {'PATH': '/evil'}}, headers=TOK, environ_base={'REMOTE_ADDR': '127.0.0.1'})
    check('a reserved key is refused (400)', r.status_code == 400, body(r))
    r = local.post('/api/internal/settings', json={'active': False}, headers=TOK, environ_base={'REMOTE_ADDR': '10.0.0.5'})
    check('a non-loopback caller is refused (403)', r.status_code == 403, r.status_code)
    r = local.post('/api/internal/settings', json={'active': False}, headers=TOK, environ_base={'REMOTE_ADDR': '127.0.0.1'})
    with app_module.app.test_request_context():
        check('{active:false} drops the overlay: the file (environment) is in force again at once', r.status_code == 200 and settings_store.setting('ANTHROPIC_API_KEY') == 'sk-file' and settings_store.setting('DEFAULT_AI_PROVIDER') == 'anthropic')
    r = local.post('/api/internal/settings', json={'active': True, 'values': {}}, environ_base={'REMOTE_ADDR': '127.0.0.1'})
    check('without the app token the route is refused like any other (401)', r.status_code == 401, r.status_code)

    exit_code = 0 if all(ok for _, ok in results) else 1
except Exception as e:  # noqa: BLE001
    import traceback
    traceback.print_exc()
    results.append(('UNEXPECTED ERROR: %s' % e, False))
    exit_code = 1

failed = [n for n, ok in results if not ok]
print('\n%d/%d checks passed' % (len(results) - len(failed), len(results)))
if failed:
    print('Failed:')
    for n in failed:
        print('  - ' + n)
sys.exit(exit_code)
