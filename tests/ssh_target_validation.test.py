#!/usr/bin/env python3
"""
Guards the SSH argv-injection fix in backend/ssh_exec.py (/api/execute-ssh).

THE BUG: the ssh command line was built as
    ['ssh', ..., '-p', str(port), f'{username}@{host}', command]
with the user-supplied username/host placed verbatim. OpenSSH parses argv with
getopt, so a destination that STARTS WITH '-' is read as an option instead:
a username of "-oProxyCommand=<cmd>" yields the argv token
"-oProxyCommand=<cmd>@host", and ssh runs <cmd> LOCALLY on the backend
machine. That sidestepped the _sanitize_ssh_options allowlist (which only
filters the separate sshOptions field) and turned the route into local
command execution for anyone who can call it - including a hostile synced
workflow whose SSH node carries such a username.

THE FIX: _validate_ssh_target() checks username, host and port against strict
allowlists BEFORE any argv is assembled, and the route answers 400 on
failure. Legitimate values are unchanged: hostnames, FQDNs, IPv4/IPv6
literals and POSIX usernames (dots, underscores, mid-string hyphens) pass.
ssh_interactive.py needs no change: it drives paramiko with keyword
arguments (hostname=..., username=...) and never builds an argv.

What this test proves:
  Part A (validator): every injection shape starting with '-' is rejected for
    both username and host; whitespace/quotes/'@'/'/' are rejected; ports
    outside 1-65535 or non-numeric are rejected; a broad set of realistic
    usernames/hosts/ports is accepted.
  Part B (route, Flask test client, ssh stubbed): a '-o...' username and a
    '-o...' host get 400 and NEVER reach ssh (the stub records every call and
    a canary file that the injected ProxyCommand would create must not
    exist); a normal request still reaches ssh with the exact argv shape the
    route always produced (`user@host` after the options, command last).
  Part C: the pre-existing validation errors (missing fields, unknown auth
    method) are unchanged.

Self-contained, no test framework: run with the backend's own venv
interpreter (see tests/run-all.sh).

  backend/venv/bin/python tests/ssh_target_validation.test.py

Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

try:
    from flask import Flask
except ImportError:
    print('Missing dependency "flask" (backend/ssh_exec.py imports it).')
    print('Run this test with the backend venv: backend/venv/bin/python tests/ssh_target_validation.test.py')
    sys.exit(1)

import ssh_exec as se  # noqa: E402

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


# ---------------------------------------------------------------------------
# Part A - validator
# ---------------------------------------------------------------------------
print('\n--- Part A: _validate_ssh_target ---')

INJECTIONS = [
    '-oProxyCommand=touch /tmp/pwned',
    '-o ProxyCommand=id',
    '-oLocalCommand=id',
    '-F/etc/evil',
    '-i/etc/shadow',
    '-',
    '--',
    '-v',
]
for bad in INJECTIONS:
    err, _ = se._validate_ssh_target('host.example', 22, bad)
    check(f'username {bad!r} rejected', err is not None and 'username' in err.lower())
    err, _ = se._validate_ssh_target(bad, 22, 'user')
    check(f'host {bad!r} rejected', err is not None and 'host' in err.lower())

for bad in ['user name', 'user@host', 'user/x', "user'x", 'user"x', 'user;id', 'user$(id)', '', 'ü']:
    err, _ = se._validate_ssh_target('host.example', 22, bad)
    check(f'username {bad!r} rejected', err is not None)
for bad in ['host name', 'host/x', 'host;id', 'host$(id)', '', 'a b.example', 'host@x']:
    err, _ = se._validate_ssh_target(bad, 22, 'user')
    check(f'host {bad!r} rejected', err is not None)

for bad_port in [0, -1, 65536, 'abc', '22; id', '', None, '1e3']:
    err, _ = se._validate_ssh_target('host.example', bad_port, 'user')
    check(f'port {bad_port!r} rejected', err is not None and 'port' in err.lower())

GOOD_USERS = ['root', 'ec2-user', 'svc_user', 'john.doe', 'user-1', 'a', '_svc', 'User123', 'x' * 64]
for good in GOOD_USERS:
    err, _ = se._validate_ssh_target('host.example', 22, good)
    check(f'username {good!r} accepted', err is None, err or '')
GOOD_HOSTS = ['localhost', 'db-01', 'db-01.example.com', 'a.b.c.d.example.co.uk', '10.0.0.1',
              '192.168.1.254', '::1', 'fe80::1', '2001:db8::dead:beef', 'host_1', 'HOST.Example.COM']
for good in GOOD_HOSTS:
    err, _ = se._validate_ssh_target(good, 22, 'user')
    check(f'host {good!r} accepted', err is None, err or '')
for good_port in [22, '22', 2222, '65535', 1, ' 22 ']:
    err, num = se._validate_ssh_target('host.example', good_port, 'user')
    check(f'port {good_port!r} accepted as int', err is None and isinstance(num, int) and 1 <= num <= 65535)

# ---------------------------------------------------------------------------
# Part B - route with ssh stubbed out
# ---------------------------------------------------------------------------
print('\n--- Part B: /api/execute-ssh with ssh stubbed ---')

canary = os.path.join(tempfile.mkdtemp(), 'pwned')
ssh_calls = []


class _Result:
    stdout = 'stub-out'
    stderr = ''
    returncode = 0


def fake_run(cmd, *args, **kwargs):
    ssh_calls.append(list(cmd))
    return _Result()


real_run = subprocess.run
subprocess.run = fake_run  # the route does `import subprocess` locally, so this is what it sees
# the route looks sshpass up with shutil.which (no `which` binary: the container image has none); this machine
# may lack sshpass, so the lookup is answered here and the password path reaches the fake ssh
real_which = shutil.which
shutil.which = lambda name, *a, **k: '/usr/bin/sshpass' if name == 'sshpass' else real_which(name, *a, **k)
try:
    app = Flask(__name__)
    app.register_blueprint(se.ssh_exec)
    client = app.test_client()

    def post(payload):
        return client.post('/api/execute-ssh', json=payload)

    r = post({'host': 'host.example', 'username': f'-oProxyCommand=touch {canary}', 'command': 'id'})
    check('injected username -> 400', r.status_code == 400, f'{r.status_code} {r.get_json()}')
    check('injected username never reached ssh', not any('ssh' in c[0] for c in ssh_calls))
    check('injected ProxyCommand did not run (no canary file)', not os.path.exists(canary))

    ssh_calls.clear()
    r = post({'host': f'-oProxyCommand=touch {canary}', 'username': 'user', 'command': 'id'})
    check('injected host -> 400', r.status_code == 400, f'{r.status_code}')
    check('injected host never reached ssh', not ssh_calls)

    ssh_calls.clear()
    r = post({'host': 'host.example', 'username': 'user', 'port': '-oProxyCommand=id', 'command': 'id'})
    check('injected port -> 400', r.status_code == 400, f'{r.status_code}')
    check('injected port never reached ssh', not ssh_calls)

    ssh_calls.clear()
    r = post({'host': 'host.example', 'username': 'user', 'command': 'id', 'authMethod': 'password',
              'password': 'x', 'sshOptions': '-o ConnectTimeout=5'})
    check('password auth path validates target the same way (normal -> 200)', r.status_code == 200, f'{r.status_code}')

    ssh_calls.clear()
    r = post({'host': 'db-01.example.com', 'username': 'svc_user.name-1', 'port': 2222, 'command': 'uptime',
              'sshOptions': '-o ConnectTimeout=5 -o ProxyCommand=evil'})
    check('normal request -> 200', r.status_code == 200, f'{r.status_code} {r.get_json()}')
    argv = ssh_calls[-1] if ssh_calls else []
    check('normal request reached ssh', bool(argv) and argv[0] == 'ssh', str(argv))
    dest_index = argv.index('svc_user.name-1@db-01.example.com') if 'svc_user.name-1@db-01.example.com' in argv else -1
    check('argv: user@host present and command is last', dest_index > 0 and argv[-1] == 'uptime')
    check('argv: -p with validated port precedes destination', '-p' in argv and argv[argv.index('-p') + 1] == '2222' and argv.index('-p') < dest_index)
    check('argv: allowlisted -o option kept before destination', 'ConnectTimeout=5' in argv and argv.index('ConnectTimeout=5') < dest_index)
    check('argv: ProxyCommand from sshOptions still dropped', not any('ProxyCommand' in a for a in argv))
    check('argv: no token starts with "-" except real flags',
          all(a.startswith('-') is False or a in ('-F', '-o', '-p') for a in argv[1:] if not a.startswith('-o') or a == '-o'))
    check('response carries stubbed stdout', r.get_json().get('stdout') == 'stub-out')

    # ---------------------------------------------------------------------
    # Part C - pre-existing validation unchanged
    # ---------------------------------------------------------------------
    print('\n--- Part C: existing validation ---')
    r = post({'host': 'h', 'username': 'u'})
    check('missing command -> 400 (unchanged)', r.status_code == 400 and 'required' in r.get_json()['error'])
    r = post({'host': 'h', 'username': 'u', 'command': 'id', 'authMethod': 'bogus'})
    check('unknown auth method -> 400 (unchanged)', r.status_code == 400 and 'Unknown auth method' in r.get_json()['error'])
finally:
    subprocess.run = real_run
    shutil.which = real_which
    try:
        os.rmdir(os.path.dirname(canary))
    except OSError:
        pass

failed = [name for name, passed in results if not passed]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
