#!/usr/bin/env python3
"""
Guards the sign-in boundary of the interactive SSH terminal in accounts mode
(backend/ssh_interactive.py, namespace /ws/ssh-interactive).

THE GAP: in the browser deployment the namespace used to fail closed - it
only knew the desktop's app token, which a browser never has, so the
terminal could not connect at all. With accounts the handshake carries the
session cookie: a socket without a live session is refused; with one, the
account is bound to the socket and every later event acts as that account
(its own known_hosts, its own identities).

What this test proves (Flask-SocketIO test clients, paramiko stubbed with
a fake client so no network is involved, synthetic accounts):
  - a handshake without a cookie is refused;
  - a handshake with a bogus cookie is refused;
  - a handshake with a signed-in user's cookie connects;
  - that socket's 'connect' message loads the account's own known_hosts
    (under the account's home) and offers only the account's identities
    (key_filename = its ~/.ssh/id_*, look_for_keys/allow_agent off);
  - a second account's socket uses its own paths, not the first's;
  - the app-token path is not accepted in accounts mode.

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/ssh_interactive_accounts_auth.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-ssh-accounts-')
HOME = os.path.join(TMP, 'data')
os.makedirs(HOME)
os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'accounts'
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(HOME, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, '.ssh', 'known_hosts')
os.environ['APP_AUTH_TOKEN'] = 'desktop-token-that-must-not-work-here'
for key in ('JACARIUM_ENV_FILE', 'JACARIUM_ACCOUNTS_DB'):
    os.environ.pop(key, None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

try:
    import flask_socketio  # noqa: F401
    import paramiko
except ImportError as e:
    print(f'Missing dependency ({e}). Run with the backend venv: backend/venv/bin/python tests/ssh_interactive_accounts_auth.test.py')
    sys.exit(1)

import app as app_module  # noqa: E402
import accounts  # noqa: E402
import extensions  # noqa: E402
import ssh_interactive  # noqa: E402
from user_context import user_home_for  # noqa: E402

results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


# --- a fake paramiko client that records what it is asked ----------------------
connects = []


class FakeChannel:
    def settimeout(self, *a): pass
    def recv_ready(self): return False
    def recv_stderr_ready(self): return False
    def exit_status_ready(self): return False
    def send(self, data): pass
    def close(self): pass


class FakeSSHClient:
    def __init__(self):
        self.loaded = None
        self.policy = None

    def load_host_keys(self, path):
        self.loaded = path

    def set_missing_host_key_policy(self, policy):
        self.policy = policy

    def connect(self, **kwargs):
        connects.append({'loaded': self.loaded, **kwargs})

    def invoke_shell(self, **kwargs):
        return FakeChannel()

    def close(self): pass


paramiko.SSHClient = FakeSSHClient

# --- accounts ----------------------------------------------------------------------
alice = accounts.create_user('alice', 'alices password', role='admin', require_empty=True)
bob = accounts.create_user('bob', 'bobs password')
alice_home, bob_home = user_home_for(alice['id']), user_home_for(bob['id'])
for home, name in ((alice_home, 'alice'), (bob_home, 'bob')):
    os.makedirs(os.path.join(home, '.ssh'), mode=0o700, exist_ok=True)
    with open(os.path.join(home, '.ssh', 'known_hosts'), 'w') as fh:
        fh.write(f'# {name}\n')
    with open(os.path.join(home, '.ssh', f'id_ed25519'), 'w') as fh:
        fh.write(f'synthetic key of {name}\n')
alice_cookie = accounts.create_session(alice['id'])
bob_cookie = accounts.create_session(bob['id'])
NS = '/ws/ssh-interactive'


def connect(cookie=None, auth=None):
    headers = {'Cookie': f'__Host-jacarium_session={cookie}'} if cookie else None
    client = extensions.socketio.test_client(app_module.app, namespace=NS, headers=headers, auth=auth)
    return client


c = connect()
check('a handshake without a session cookie is refused', not c.is_connected(NS))
c = connect(cookie='not-a-session')
check('a bogus cookie is refused', not c.is_connected(NS))
c = connect(auth={'token': os.environ['APP_AUTH_TOKEN']})
check('the desktop app token is not accepted in accounts mode', not c.is_connected(NS))

a = connect(cookie=alice_cookie)
check('a signed-in account connects', a.is_connected(NS))
a.get_received(NS)
a.emit('message', {'type': 'connect', 'host': 'host.example.test', 'port': 22, 'username': 'someone', 'authMethod': 'agent'}, namespace=NS)
time.sleep(0.2)
received = a.get_received(NS)
names = [r['name'] for r in received]
last = connects[-1] if connects else {}
check("the session opened (connected event) with alice's own known_hosts", 'connected' in names and last.get('loaded') == os.path.join(alice_home, '.ssh', 'known_hosts'), f'{names} {last.get("loaded")}')
check("only alice's identities are offered, no agent, no default keys",
      last.get('key_filename') == [os.path.join(alice_home, '.ssh', 'id_ed25519')] and last.get('look_for_keys') is False and last.get('allow_agent') is False, json.dumps({k: str(v) for k, v in last.items()}))

b = connect(cookie=bob_cookie)
b.get_received(NS)
b.emit('message', {'type': 'connect', 'host': 'host.example.test', 'port': 22, 'username': 'someone', 'authMethod': 'agent'}, namespace=NS)
time.sleep(0.2)
last = connects[-1]
check("bob's socket uses bob's known_hosts and keys, not alice's",
      last.get('loaded') == os.path.join(bob_home, '.ssh', 'known_hosts') and last.get('key_filename') == [os.path.join(bob_home, '.ssh', 'id_ed25519')], f'{last.get("loaded")} {last.get("key_filename")}')

a.disconnect(namespace=NS)
b.disconnect(namespace=NS)
time.sleep(0.2)

failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
