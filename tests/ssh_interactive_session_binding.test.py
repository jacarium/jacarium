#!/usr/bin/env python3
"""
Guards the per-connection binding of interactive SSH sessions
(backend/ssh_interactive.py, Socket.IO namespace /ws/ssh-interactive).

THE BUG: sessions were kept in a module-level dict with no link to the
Socket.IO connection that opened them. `input` messages were routed to
"the first connected session" regardless of sender, and every byte of
output was emitted to the WHOLE namespace. Two terminal windows (or two
users of one backend) cross-wired: keystrokes typed in one landed in the
other's shell and each saw the other's output.

THE FIX: on 'connect' the session records the opener's Socket.IO sid and
joins a private room named after the session id; the monitor thread emits
output/errors/exit only to that room; 'input' is accepted only for a session
owned by the sending sid (an optional sessionId must also belong to it); a
socket disconnect tears down only its own sessions.

What this test proves (real handlers, Flask-SocketIO test clients, paramiko
stubbed with a fake client/channel so no network is involved):
  - two clients each open a session and get distinct session ids;
  - input from client B reaches ONLY B's channel, input from A only A's;
  - output produced by A's channel is delivered ONLY to A;
  - input naming another client's sessionId is refused with an error and
    sends nothing;
  - a client with no session gets an error instead of driving someone
    else's shell;
  - disconnecting A closes A's session but leaves B's working.

Self-contained, no test framework: run with the backend venv interpreter.

  backend/venv/bin/python tests/ssh_interactive_session_binding.test.py

Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)
TOKEN = 'ssh-binding-test-token'
os.environ['APP_AUTH_TOKEN'] = TOKEN

try:
    import flask_socketio  # noqa: F401
    import paramiko
except ImportError as e:
    print(f'Missing dependency ({e}). Run with the backend venv: backend/venv/bin/python tests/ssh_interactive_session_binding.test.py')
    sys.exit(1)

import extensions  # noqa: E402
import ssh_interactive  # noqa: E402  (registers the handlers)

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


# --- paramiko stub -----------------------------------------------------------
channels = []


class FakeChannel:
    def __init__(self, label):
        self.label = label
        self.sent = []
        self.outbox = []
        self.closed = False

    def settimeout(self, t):
        pass

    def recv_ready(self):
        return bool(self.outbox)

    def recv(self, n):
        return self.outbox.pop(0)

    def recv_stderr_ready(self):
        return False

    def exit_status_ready(self):
        return False

    def send(self, data):
        self.sent.append(data)

    def close(self):
        self.closed = True


class FakeSSHClient:
    def __init__(self):
        self.closed = False

    def load_host_keys(self, path):
        pass

    def set_missing_host_key_policy(self, policy):
        pass

    def connect(self, **kwargs):
        self.kwargs = kwargs

    def invoke_shell(self, **kwargs):
        ch = FakeChannel(f'chan{len(channels) + 1}')
        channels.append(ch)
        return ch

    def close(self):
        self.closed = True


paramiko.SSHClient = FakeSSHClient  # handler does `import paramiko` per call -> sees this

NS = '/ws/ssh-interactive'
app = extensions.app
socketio = extensions.socketio


def _payload(pkt):
    # The Flask-SocketIO test client returns a single dict argument as the
    # `args` value itself; multiple arguments come back as a list.
    args = pkt.get('args')
    if isinstance(args, list):
        return args[0] if args else {}
    return args or {}


def messages(client, kind=None):
    out = []
    for pkt in client.get_received(NS):
        if pkt['name'] != 'message':
            continue
        payload = _payload(pkt)
        if isinstance(payload, dict) and (kind is None or payload.get('type') == kind):
            out.append(payload)
    return out


def session_id_of(client):
    for pkt in client.get_received(NS):
        payload = _payload(pkt)
        if pkt['name'] == 'connected' and isinstance(payload, dict) and payload.get('sessionId'):
            return payload['sessionId']
    return None


connect_msg = {'type': 'connect', 'host': 'host.example', 'port': 22, 'username': 'u', 'authMethod': 'agent'}

a = socketio.test_client(app, namespace=NS, auth={'token': TOKEN})
b = socketio.test_client(app, namespace=NS, auth={'token': TOKEN})
check('both clients connected with the token', a.is_connected(NS) and b.is_connected(NS))
bad = socketio.test_client(app, namespace=NS, auth={'token': 'wrong'})
check('wrong token is rejected', not bad.is_connected(NS))

a.emit('message', connect_msg, namespace=NS)
time.sleep(0.2)
sid_a = session_id_of(a)
b.emit('message', connect_msg, namespace=NS)
time.sleep(0.2)
sid_b = session_id_of(b)
check('A got a session id', bool(sid_a))
check('B got a distinct session id', bool(sid_b) and sid_b != sid_a)
check('two channels created', len(channels) == 2)
chan_a, chan_b = channels[0], channels[1]
check('sessions record their owner sid + room', all(
    ssh_interactive.ssh_sessions[s].get('sid') and ssh_interactive.ssh_sessions[s].get('room') == s for s in (sid_a, sid_b)))

# input routing
b.emit('message', {'type': 'input', 'data': 'from-b\n'}, namespace=NS)
a.emit('message', {'type': 'input', 'data': 'from-a\n'}, namespace=NS)
time.sleep(0.2)
check("B's input reached only B's channel", chan_b.sent == ['from-b\n'] and 'from-b\n' not in chan_a.sent, f'a={chan_a.sent} b={chan_b.sent}')
check("A's input reached only A's channel", chan_a.sent == ['from-a\n'], f'a={chan_a.sent}')

# input naming someone else's session
a.get_received(NS)
a.emit('message', {'type': 'input', 'data': 'steal\n', 'sessionId': sid_b}, namespace=NS)
time.sleep(0.2)
errs = messages(a, 'error')
check("A cannot drive B's session by sessionId", 'steal\n' not in chan_b.sent and any('No active SSH session' in e.get('error', '') for e in errs), f'{errs}')

# output routing
a.get_received(NS)
b.get_received(NS)
chan_a.outbox.append(b'only-for-a\n')
time.sleep(0.4)
out_a = [m['data'] for m in messages(a, 'output')]
out_b = [m['data'] for m in messages(b, 'output')]
check("A's output delivered to A", any('only-for-a' in d for d in out_a), f'{out_a}')
check("A's output NOT delivered to B", not any('only-for-a' in d for d in out_b), f'{out_b}')

# a socket with no session cannot type into anyone's shell
c = socketio.test_client(app, namespace=NS, auth={'token': TOKEN})
c.get_received(NS)
c.emit('message', {'type': 'input', 'data': 'ghost\n'}, namespace=NS)
time.sleep(0.2)
check('session-less socket gets an error and sends nothing',
      'ghost\n' not in chan_a.sent and 'ghost\n' not in chan_b.sent
      and any('No active SSH session' in e.get('error', '') for e in messages(c, 'error')))
c.disconnect(namespace=NS)

# disconnect tears down only the owner's session
a.disconnect(namespace=NS)
time.sleep(0.5)
check("A's session removed after disconnect", sid_a not in ssh_interactive.ssh_sessions and chan_a.closed)
check("B's session survives A's disconnect", sid_b in ssh_interactive.ssh_sessions and not chan_b.closed)
b.emit('message', {'type': 'input', 'data': 'still-b\n'}, namespace=NS)
time.sleep(0.2)
check('B still receives its input after A left', chan_b.sent[-1] == 'still-b\n', f'{chan_b.sent}')
b.disconnect(namespace=NS)
time.sleep(0.5)
check("B's session removed after its own disconnect", sid_b not in ssh_interactive.ssh_sessions)

failed = [n for n, p in results if not p]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
