#!/usr/bin/env python3
"""
Guards per-account isolation in accounts mode (backend/user_context.py and
the modules that resolve ``~`` through it: settings_store, task_paths,
extensions.known_hosts_path / get_vector_db, reports_root, ssh_exec,
google_calendar, ai_chat).

What this test proves (Flask test client, two synthetic accounts alice
(admin) and bob, subprocess.run replaced by a recorder, the vector DB
replaced by a fake that records its directory):
  - settings: each account has its own file under its home; alice's PUT is
    invisible to bob; a server default (admin: /api/admin/settings) is
    inherited by both and reported as inherited; a secret's value never
    reaches either; bob cannot touch the server defaults (403); nothing of
    a user's file lands in os.environ; setting() resolves user -> defaults;
  - Taskwarrior: "~/.task" maps into each account's own home; bob cannot
    name alice's directory (refused before the CLI runs); init writes the
    taskrc under bob's home only;
  - SSH: the known_hosts file the ssh argv names is the account's own;
    the ControlMaster socket dir is per account; with sign-in only the
    account's own identities are offered (IdentitiesOnly, -i per key);
  - RAG: each account gets its own index directory; the embedding model is
    loaded once and shared;
  - reports: each account's default root is its own ~/reports, the shared
    root is browsable too, alice's own root is refused for bob;
  - Google Calendar: the token path is per account;
  - /api/ai/models never returns SSH_AI_PASSWORD.

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/accounts_isolation.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-isolation-')
HOME = os.path.join(TMP, 'data')
SHARED_REPORTS = os.path.join(HOME, 'reports')
os.makedirs(os.path.join(SHARED_REPORTS, 'sosreport-shared-node-2026-10-11'))
os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'accounts'
os.environ['JACARIUM_REPORTS_ROOT'] = SHARED_REPORTS
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, '.ssh', 'known_hosts')
for key in ('JACARIUM_ENV_FILE', 'JACARIUM_ACCOUNTS_DB', 'JACARIUM_TASK_ROOT', 'JIRA_EMAIL', 'JIRA_PAT', 'OPENAI_API_KEY', 'SSH_AI_HOST', 'SSH_AI_PASSWORD'):
    os.environ.pop(key, None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402
import accounts  # noqa: E402
import extensions  # noqa: E402
import taskwarrior  # noqa: E402
import settings_store  # noqa: E402
import ssh_exec  # noqa: E402
import google_calendar  # noqa: E402
from user_context import user_home_for  # noqa: E402

BASE = 'https://console.test'
HDR = {'X-Requested-With': 'Jacarium'}
results = []
calls = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def body(response):
    try:
        return response.get_json() or {}
    except Exception:
        return {}


class _Completed:
    returncode = 0
    stdout = '[]'
    stderr = ''


def _recording_run(cmd, *args, **kwargs):
    calls.append(list(cmd))
    return _Completed()


subprocess.run = _recording_run
taskwarrior.check_taskwarrior_installed = lambda: True


class FakeVectorDB:
    instances = []

    def __init__(self, db_path=None, embedding_model=None):
        self.db_path = db_path
        self.embedding_model = embedding_model or object()
        FakeVectorDB.instances.append(self)
        self.indexed = []

    def index_document(self, doc_id, title, content, category='Uncategorized'):
        self.indexed.append(doc_id)
        return {'indexed': True, 'checksum': 'x', 'chunks': 1}

    def search(self, *a, **k):
        return []


import vector_db  # noqa: E402
vector_db.VectorDBManager = FakeVectorDB

code = open(os.path.join(HOME, 'setup-code')).read().strip()


def client_for(username, password, *, setup=False):
    c = app_module.app.test_client()
    if setup:
        r = c.post('/api/auth/setup', json={'setupCode': code, 'username': username, 'password': password}, headers=HDR, base_url=BASE)
    else:
        r = c.post('/api/auth/login', json={'username': username, 'password': password}, headers=HDR, base_url=BASE)
    assert r.status_code in (200, 201), r.get_data(as_text=True)
    return c, body(r)['user']['id']


alice, alice_id = client_for('alice', 'alices password', setup=True)
r = alice.post('/api/admin/users', json={'username': 'bob', 'password': 'bobs password'}, headers=HDR, base_url=BASE)
bob, bob_id = client_for('bob', 'bobs password')
alice_home, bob_home = user_home_for(alice_id), user_home_for(bob_id)
check('each account has a home under <data>/users/<id>', alice_home.startswith(os.path.join(HOME, 'users')) and bob_home != alice_home and os.path.isdir(bob_home))
check('the homes are 0700', oct(os.stat(alice_home).st_mode & 0o777) == '0o700')


def put_settings(c, values=None, secrets=None, path='/api/settings'):
    return c.put(path, json={'values': values or {}, 'secrets': secrets or {}}, headers=HDR, base_url=BASE)


# --- settings ---------------------------------------------------------------------
r = put_settings(alice, {'JIRA_EMAIL': 'alice@example.test'}, {'JIRA_PAT': 'alice-synthetic-pat'})
check("alice saves her settings", r.status_code == 200 and os.path.isfile(os.path.join(alice_home, '.jacarium.env')), r.get_data(as_text=True)[:100])
r = bob.get('/api/settings', base_url=BASE)
check("bob does not see alice's values or secrets", r.status_code == 200 and body(r)['values'].get('JIRA_EMAIL') is None and body(r)['secrets'].get('JIRA_PAT') is None, r.get_data(as_text=True)[:150])
check('nothing of a user file landed in os.environ', os.environ.get('JIRA_EMAIL') is None and os.environ.get('JIRA_PAT') is None)
r = put_settings(bob, {'DEFAULT_AI_PROVIDER': 'ollama'}, path='/api/admin/settings')
check('bob cannot write the server defaults (403)', r.status_code == 403)
r = put_settings(alice, {'DEFAULT_AI_PROVIDER': 'ollama', 'JIRA_URL': 'https://jira.example.test'}, {'OPENAI_API_KEY': 'server-synthetic-key'}, path='/api/admin/settings')
check('the admin writes the server defaults', r.status_code == 200 and os.path.isfile(os.path.join(HOME, 'settings.env')), r.get_data(as_text=True)[:100])
r = bob.get('/api/settings', base_url=BASE)
inherited = body(r).get('inherited', {})
check('bob inherits the defaults (reported as inherited, secrets only as true)', inherited.get('DEFAULT_AI_PROVIDER') == 'ollama' and inherited.get('OPENAI_API_KEY') is True and 'server-synthetic-key' not in r.get_data(as_text=True), json.dumps(inherited))
from user_context import set_current_user  # noqa: E402


def as_user(user_id, fn):
    # one request = one user (setting() caches the user's file per request)
    with app_module.app.test_request_context(base_url=BASE):
        set_current_user(accounts.get_user(user_id))
        return fn()


check("setting(): bob's own value is absent -> the server default", as_user(bob_id, lambda: settings_store.setting('JIRA_URL')) == 'https://jira.example.test')
check("setting(): alice's own JIRA_PAT wins, her JIRA_URL falls back to the default",
      as_user(alice_id, lambda: settings_store.setting('JIRA_PAT')) == 'alice-synthetic-pat' and as_user(alice_id, lambda: settings_store.setting('JIRA_URL')) == 'https://jira.example.test')
put_settings(bob, {'JIRA_URL': 'https://bob.example.test'})
check("setting(): bob's own value overrides the server default", as_user(bob_id, lambda: settings_store.setting('JIRA_URL')) == 'https://bob.example.test')
check("...without affecting alice", as_user(alice_id, lambda: settings_store.setting('JIRA_URL')) == 'https://jira.example.test')

# --- Taskwarrior -------------------------------------------------------------------
calls.clear()
r = bob.post('/api/taskwarrior/export', json={'dataPath': '~/.task', 'rcPath': '~/.taskrc'}, headers=HDR, base_url=BASE)
check('"~/.task" resolves into bob\'s own home', r.status_code == 200 and calls and calls[-1][1] == f'rc:{os.path.realpath(os.path.join(bob_home, ".taskrc"))}' and calls[-1][2] == f'rc.data.location={os.path.realpath(os.path.join(bob_home, ".task"))}', json.dumps(calls[-1:]))
calls.clear()
r = bob.post('/api/taskwarrior/export', json={'dataPath': os.path.join(alice_home, '.task')}, headers=HDR, base_url=BASE)
check("bob cannot name alice's task directory (refused, nothing runs)", r.status_code == 500 and 'must be inside' in body(r).get('error', '') and not calls)
r = bob.post('/api/taskwarrior/instances/init', json={'rcPath': '~/.task/work/taskrc', 'dataPath': '~/.task/work', 'config': {'color': 'off'}}, headers=HDR, base_url=BASE)
check("init writes bob's taskrc under bob's home only", r.status_code == 200 and os.path.isfile(os.path.join(bob_home, '.task', 'work', 'taskrc')) and not os.path.exists(os.path.join(alice_home, '.task')), r.get_data(as_text=True)[:120])

# --- SSH -----------------------------------------------------------------------------
os.makedirs(os.path.join(bob_home, '.ssh'), mode=0o700, exist_ok=True)
with open(os.path.join(bob_home, '.ssh', 'id_ed25519'), 'w') as fh:
    fh.write('synthetic private key\n')
with open(os.path.join(bob_home, '.ssh', 'id_ed25519.pub'), 'w') as fh:
    fh.write('synthetic public key\n')
calls.clear()
r = bob.post('/api/execute-ssh', json={'host': 'host.example.test', 'username': 'someone', 'command': 'id', 'authMethod': 'agent'}, headers=HDR, base_url=BASE)
argv = calls[-1] if calls else []
check("ssh argv names bob's own known_hosts", r.status_code == 200 and f'UserKnownHostsFile={os.path.join(bob_home, ".ssh", "known_hosts")}' in argv, json.dumps(argv))
# (a macOS temp dir is too long for any AF_UNIX ControlPath, so the
# multiplexing directory is checked directly: short, under the server home,
# different per account)
bob_mux, alice_mux = as_user(bob_id, ssh_exec.mux_dir), as_user(alice_id, ssh_exec.mux_dir)
check('the ControlMaster socket directory is per account and short',
      bob_mux != alice_mux and bob_mux.startswith(os.path.join(HOME, '.ssh-mux') + os.sep) and len(os.path.relpath(bob_mux, HOME)) < 20, f'{bob_mux} {alice_mux}')
check("...and only bob's identity (IdentitiesOnly, -i his key, no agent)", 'IdentitiesOnly=yes' in argv and os.path.join(bob_home, '.ssh', 'id_ed25519') in argv and 'IdentityAgent=none' in argv and os.path.join(bob_home, '.ssh', 'id_ed25519.pub') not in argv, json.dumps(argv))
calls.clear()
r = alice.post('/api/execute-ssh', json={'host': 'host.example.test', 'username': 'someone', 'command': 'id', 'authMethod': 'agent'}, headers=HDR, base_url=BASE)
argv = calls[-1] if calls else []
check("alice's ssh never sees bob's key", not any('id_ed25519' in a for a in argv) and f'UserKnownHostsFile={os.path.join(alice_home, ".ssh", "known_hosts")}' in argv, json.dumps(argv))

# --- RAG -----------------------------------------------------------------------------
r = alice.post('/api/embeddings/index', json={'documents': [{'id': 1, 'title': 'A', 'content': 'alice text ' * 20}]}, headers=HDR, base_url=BASE)
r2 = bob.post('/api/embeddings/index', json={'documents': [{'id': 1, 'title': 'B', 'content': 'bob text ' * 20}]}, headers=HDR, base_url=BASE)
dirs = [m.db_path for m in FakeVectorDB.instances]
check('each account gets its own vector DB directory',
      r.status_code == 200 and r2.status_code == 200 and len(FakeVectorDB.instances) == 2
      and dirs[0] == os.path.join(alice_home, '.jacarium', 'vector_db') and dirs[1] == os.path.join(bob_home, '.jacarium', 'vector_db'),
      f'{r.status_code} {r2.status_code} {dirs}')
check('the embedding model is shared between them', len(FakeVectorDB.instances) == 2 and FakeVectorDB.instances[0].embedding_model is FakeVectorDB.instances[1].embedding_model)
check("alice's doc id 1 and bob's doc id 1 went to different indexes", FakeVectorDB.instances[0].indexed == [1] and FakeVectorDB.instances[1].indexed == [1])

# --- reports --------------------------------------------------------------------------
r = bob.get('/api/capabilities', base_url=BASE)
caps = body(r)
check("bob's default reports root is his own ~/reports; the shared root is announced",
      caps.get('reportsRoot') == os.path.realpath(os.path.join(bob_home, 'reports')) and caps.get('sharedReportsRoot') == os.path.realpath(SHARED_REPORTS), json.dumps({k: caps.get(k) for k in ('reportsRoot', 'sharedReportsRoot')}))
os.makedirs(os.path.join(bob_home, 'reports', 'sosreport-bob-2026-10-11'), exist_ok=True)
os.makedirs(os.path.join(alice_home, 'reports', 'sosreport-alice-2026-10-11'), exist_ok=True)
r = bob.post('/list_reports', json={}, headers=HDR, base_url=BASE)
names = [x['name'] for x in body(r).get('reports', [])]
check("bob lists his own reports by default", r.status_code == 200 and names == ['sosreport-bob-2026-10-11'], str(names))
r = bob.post('/list_reports', json={'directory': SHARED_REPORTS}, headers=HDR, base_url=BASE)
names = [x['name'] for x in body(r).get('reports', [])]
check('the shared root is browsable', r.status_code == 200 and names == ['sosreport-shared-node-2026-10-11'], str(names))
r = bob.post('/list_reports', json={'directory': os.path.join(alice_home, 'reports')}, headers=HDR, base_url=BASE)
check("alice's reports are refused for bob (403)", r.status_code == 403)

# --- calendar token, SSH-AI password -----------------------------------------------------
check('the Google Calendar token path is per account', as_user(bob_id, google_calendar.token_file) == os.path.join(bob_home, '.jacarium-gcal-token.pickle'))
put_settings(bob, {'SSH_AI_HOST': 'ai.example.test', 'SSH_AI_USER': 'bot'}, {'SSH_AI_PASSWORD': 'synthetic-ssh-ai-password'})
# the inherited synthetic OpenAI key must not make the model listing call out
import types as _types
sys.modules['openai'] = _types.SimpleNamespace(models=_types.SimpleNamespace(list=lambda: (_ for _ in ()).throw(RuntimeError('no network in tests'))))
r = bob.get('/api/ai/models', base_url=BASE)
text = r.get_data(as_text=True)
check('/api/ai/models lists the SSH AI provider without its password', r.status_code == 200 and 'ai.example.test' in text and 'synthetic-ssh-ai-password' not in text, text[:200])
check('os.environ still holds no user setting', all(os.environ.get(k) is None for k in ('SSH_AI_HOST', 'SSH_AI_PASSWORD', 'JIRA_EMAIL', 'JIRA_PAT')))

failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
