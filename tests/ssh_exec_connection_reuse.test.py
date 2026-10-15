#!/usr/bin/env python3
"""
Guards the SSH connection-reuse fix for the Workflow Editor's /api/execute-ssh route.

THE BUG: backend/ssh_exec.py shells out to a fresh `ssh` (or `sshpass ... ssh`)
process for EVERY call -- full TCP connect + key exchange + auth handshake, one
command, process exits, connection gone. src/utils/workflowExecution.js calls this
route once per SSH node execution, and a `forloop` node re-invokes its body once per
array element, so an SSH node inside a loop over 50 hosts paid 50 sequential full
handshakes (realistically 200ms-2s EACH on a real network) in pure setup overhead.

THE FIX: OpenSSH ControlMaster multiplexing, applied at the subprocess/CLI layer the
route already uses (works identically for both `agent` and `password`/sshpass auth,
without changing auth mechanism, stdout/stderr/exitCode semantics, the 30s timeout,
sshOptions passthrough, or TOFU host-key checking). The first ssh call to a target
forks a background master holding the authenticated connection on a control socket
under ~/.jacarium/ssh-mux/ (0700, path hashed per auth+user+host+port to stay
under the ~104-byte AF_UNIX socket path limit -- ssh exits 255 without running the
command if ControlPath is too long). Subsequent calls to the same target reuse it
near-instantly; ControlPersist auto-closes idle masters so nothing leaks. Anything
off (opt-out env, win32, caller-supplied ControlMaster/ControlPath in sshOptions,
socket dir not creatable, path too long) degrades to [] = the exact pre-fix
one-handshake-per-command command line.

This test is self-contained with NO test framework:
  Part A (always runs, no SSH server needed):
    - control-socket path generation is deterministic, collision-safe across every
      key field (authMethod/username/host/port, incl. field-boundary ambiguity),
      and short enough for the AF_UNIX limit;
    - _mux_options creates the socket dir with 0700 perms and returns the three
      ControlMaster/ControlPath/ControlPersist flags;
    - every degradation path returns [] (opt-out env var, user-supplied
      ControlMaster/ControlPath in sshOptions, un-creatable socket dir, overlong
      control path);
    - the route's existing validation errors are unchanged (400s).
  Part B (runs only if a throwaway sshd can be started):
    - generates disposable host/client keys, starts `sshd` on an ephemeral
      127.0.0.1 port plus a throwaway `ssh-agent` holding the client key (since
      commit 8983ee5 the route allowlists sshOptions to safe `-o Name=Value`
      pairs, so a `-i keyfile` flag would be dropped -- authMethod 'agent' now
      genuinely means the key comes from the agent, which the route's ssh
      subprocess inherits via SSH_AUTH_SOCK), and calls the REAL Flask route
      (blueprint mounted on a bare app, per tests/taskwarrior_purge.test.py
      convention) several times;
    - asserts correct stdout / stderr / exitCode passthrough (incl. nonzero exit),
      that the control socket appears at the predicted path, that ONE master
      serves all calls (stable master pid via `ssh -O check`), and -- direct
      handshake counting -- that sshd's log shows exactly ONE accepted publickey
      auth for N route calls;
    - asserts a stale socket (master SIGKILLed) still yields a correct response
      (graceful fallback to a direct connection);
    - asserts the idle master self-terminates after ControlPersist (no leak).
  If no usable sshd binary exists or it fails to start in this environment, Part B
  prints SKIP lines with the reason instead of fabricating results -- Part A still
  exercises everything that does not require a live SSH server.

ENVIRONMENT NOTE: written/verified on macOS where `sshd -f <cfg>` can run unprivileged
and authenticate the current user via a throwaway authorized_keys (StrictModes no).
Machines without /usr/sbin/sshd (or where the sandbox blocks it) exercise Part A only.

Run:  backend/venv/bin/python tests/ssh_exec_connection_reuse.test.py
Exit code 0 = all non-skipped checks passed, 1 = failure (details on stdout).
"""
import getpass
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print('%s: %s%s' % ('PASS' if cond else 'FAIL', name, (' | ' + str(detail)) if detail else ''))


def skip(name, why):
    print('SKIP: %s | %s' % (name, why))


# ---------- precondition ----------
try:
    import flask  # noqa: F401
except ImportError:
    print('Missing dependency "flask". Run with the backend venv: '
          'backend/venv/bin/python tests/ssh_exec_connection_reuse.test.py')
    sys.exit(1)

os.environ.setdefault('APP_AUTH_TOKEN', 'test-token')  # silence extensions.py warning
import ssh_exec as mod  # noqa: E402  (imports backend/extensions transitively)
from flask import Flask  # noqa: E402

exit_code = 1
tmp = tempfile.mkdtemp(prefix='scmux-', dir='/tmp')  # /tmp: AF_UNIX paths must stay <104B
sshd_proc = None
agent_pid = None
saved_auth_sock = os.environ.get('SSH_AUTH_SOCK')
saved_mux_dir = mod.MUX_DIR
try:
    # =====================================================================
    # Part A: mux plumbing, no SSH server required
    # =====================================================================

    # --- determinism / collision safety of the control-socket path ---
    p1 = mod._mux_control_path('h1', 22, 'alice', 'agent')
    check('control path is deterministic',
          p1 == mod._mux_control_path('h1', 22, 'alice', 'agent'), p1)
    variants = {
        mod._mux_control_path('h1', 22, 'alice', 'agent'),
        mod._mux_control_path('h2', 22, 'alice', 'agent'),      # host differs
        mod._mux_control_path('h1', 2222, 'alice', 'agent'),    # port differs
        mod._mux_control_path('h1', 22, 'bob', 'agent'),        # user differs
        mod._mux_control_path('h1', 22, 'alice', 'password'),   # auth differs
    }
    check('host/port/username/authMethod each get distinct sockets', len(variants) == 5)
    check('field boundaries cannot alias (ab+c vs a+bc)',
          mod._mux_control_path('bc', 22, 'a', 'agent')
          != mod._mux_control_path('c', 22, 'ab', 'agent'))
    check('default control path fits the AF_UNIX limit with headroom',
          len(p1.encode()) <= mod._MUX_MAX_CONTROL_PATH_BYTES,
          '%d bytes' % len(p1.encode()))
    check('control path lives under MUX_DIR',
          os.path.dirname(p1) == mod.MUX_DIR, mod.MUX_DIR)

    # --- _mux_options happy path (redirect MUX_DIR into our temp dir) ---
    mod.MUX_DIR = os.path.join(tmp, 'mux')
    opts = mod._mux_options('h1', 22, 'alice', 'agent', '')
    check('_mux_options enables multiplexing',
          'ControlMaster=auto' in opts
          and any(o.startswith('ControlPath=') for o in opts)
          and any(o.startswith('ControlPersist=') for o in opts), opts)
    mode = stat.S_IMODE(os.stat(mod.MUX_DIR).st_mode)
    check('socket dir created with 0700 perms', mode == 0o700, oct(mode))
    check('every mux flag is a -o option (cannot be mistaken for command/host)',
          opts[::2] == ['-o'] * (len(opts) // 2))

    # --- degradation paths must all return [] (i.e. pre-fix behavior) ---
    os.environ['JACARIUM_DISABLE_SSH_MUX'] = '1'
    check('opt-out env var disables multiplexing',
          mod._mux_options('h1', 22, 'alice', 'agent', '') == [])
    del os.environ['JACARIUM_DISABLE_SSH_MUX']

    check('caller-supplied ControlPath in sshOptions wins (no double mux)',
          mod._mux_options('h1', 22, 'alice', 'agent', '-o ControlPath=/tmp/x') == [])
    check('caller-supplied ControlMaster in sshOptions wins',
          mod._mux_options('h1', 22, 'alice', 'agent', '-o ControlMaster=no') == [])

    blocker = os.path.join(tmp, 'not-a-dir')
    with open(blocker, 'w') as fh:
        fh.write('x')
    mod.MUX_DIR = os.path.join(blocker, 'mux')  # makedirs must fail: parent is a file
    check('un-creatable socket dir degrades to no-mux',
          mod._mux_options('h1', 22, 'alice', 'agent', '') == [])

    mod.MUX_DIR = os.path.join(tmp, 'x' * 200)  # would exceed AF_UNIX limit
    check('overlong control path degrades to no-mux (ssh would exit 255)',
          mod._mux_options('h1', 22, 'alice', 'agent', '') == [])

    mod.MUX_DIR = os.path.join(tmp, 'mux')

    # --- route-level validation errors unchanged (bare app, no auth gate) ---
    app = Flask(__name__)
    app.register_blueprint(mod.ssh_exec)
    client = app.test_client()

    r = client.post('/api/execute-ssh', json={'host': '', 'username': 'u', 'command': 'x'})
    check('missing host still 400', r.status_code == 400, r.get_json())
    r = client.post('/api/execute-ssh',
                    json={'host': 'h', 'username': 'u', 'command': 'x', 'authMethod': 'bogus'})
    check('unknown authMethod still 400', r.status_code == 400, r.get_json())
    r = client.post('/api/execute-ssh',
                    json={'host': 'h', 'username': 'u', 'command': 'x',
                          'authMethod': 'password', 'password': ''})
    check('password auth without password still 400', r.status_code == 400, r.get_json())

    # =====================================================================
    # Part B: real end-to-end reuse against a throwaway local sshd
    # =====================================================================
    sshd_bin = shutil.which('sshd') or (
        '/usr/sbin/sshd' if os.path.exists('/usr/sbin/sshd') else None)
    keygen = shutil.which('ssh-keygen')
    ssh_bin = shutil.which('ssh')
    agent_bin = shutil.which('ssh-agent')
    add_bin = shutil.which('ssh-add')
    user = getpass.getuser()

    sshd_ok = False
    port = None
    sshd_log = os.path.join(tmp, 'sshd.log')
    if not (sshd_bin and keygen and ssh_bin and agent_bin and add_bin):
        skip('end-to-end SSH reuse', 'sshd/ssh-keygen/ssh/ssh-agent/ssh-add not all '
             'available (sshd=%s keygen=%s ssh=%s agent=%s add=%s)'
             % (sshd_bin, keygen, ssh_bin, agent_bin, add_bin))
    else:
        hostkey = os.path.join(tmp, 'hostkey')
        clientkey = os.path.join(tmp, 'clientkey')
        subprocess.run([keygen, '-q', '-t', 'ed25519', '-f', hostkey, '-N', ''], check=True)
        subprocess.run([keygen, '-q', '-t', 'ed25519', '-f', clientkey, '-N', ''], check=True)
        authorized = os.path.join(tmp, 'authorized_keys')
        shutil.copy(clientkey + '.pub', authorized)
        os.chmod(authorized, 0o600)

        # Throwaway agent for the client key: the route's `ssh` subprocess
        # inherits our environment, so pointing SSH_AUTH_SOCK at it is how
        # authMethod 'agent' gets the disposable key (the sshOptions allowlist
        # added in commit 8983ee5 drops bare flags like `-i keyfile`).
        agent_env = subprocess.run([agent_bin, '-s'], capture_output=True,
                                   text=True, check=True).stdout
        auth_sock = re.search(r'SSH_AUTH_SOCK=([^;]+);', agent_env).group(1)
        agent_pid = int(re.search(r'SSH_AGENT_PID=(\d+);', agent_env).group(1))
        os.environ['SSH_AUTH_SOCK'] = auth_sock
        subprocess.run([add_bin, clientkey], check=True, capture_output=True)

        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
        s.close()

        cfg = os.path.join(tmp, 'sshd_config')
        with open(cfg, 'w') as fh:
            fh.write('\n'.join([
                'Port %d' % port,
                'ListenAddress 127.0.0.1',
                'HostKey %s' % hostkey,
                'PidFile %s' % os.path.join(tmp, 'sshd.pid'),
                'AuthorizedKeysFile %s' % authorized,
                'PasswordAuthentication no',
                'KbdInteractiveAuthentication no',
                'PubkeyAuthentication yes',
                # ssh may also offer the user's real default identities before
                # the throwaway agent key; leave room so a keyful machine never
                # hits "Too many authentication failures".
                'MaxAuthTries 20',
                'UsePAM no',
                'StrictModes no',
                'LogLevel VERBOSE',  # logs one "Accepted publickey" per real handshake
            ]) + '\n')

        sshd_proc = subprocess.Popen(
            [sshd_bin, '-D', '-f', cfg, '-E', sshd_log],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                probe = socket.create_connection(('127.0.0.1', port), timeout=0.5)
                probe.close()
                sshd_ok = True
                break
            except OSError:
                if sshd_proc.poll() is not None:
                    break
                time.sleep(0.1)
        if not sshd_ok:
            log_tail = ''
            if os.path.exists(sshd_log):
                with open(sshd_log) as fh:
                    log_tail = fh.read()[-300:]
            skip('end-to-end SSH reuse',
                 'throwaway sshd failed to start in this environment: %s' % log_tail)

    if sshd_ok:
        # Keep the route away from the user's real known_hosts.
        mod.KNOWN_HOSTS_PATH = os.path.join(tmp, 'known_hosts')
        mod._ensure_known_hosts_dir = lambda: None

        # sshOptions carries an allowlisted `-o` pair so Part B also exercises
        # the sanitize-and-passthrough path; auth comes from the throwaway
        # agent (see above), not from a -i flag the allowlist would drop.
        target = {'host': '127.0.0.1', 'port': port, 'username': user,
                  'authMethod': 'agent',
                  'sshOptions': '-o ConnectionAttempts=1'}

        def call(command):
            t0 = time.time()
            resp = client.post('/api/execute-ssh', json={**target, 'command': command})
            return resp, time.time() - t0

        r, dt1 = call('echo mux-one')
        body = r.get_json()
        check('call 1 executes over real SSH',
              r.status_code == 200 and body.get('stdout') == 'mux-one\n'
              and body.get('exitCode') == 0, '%s in %.0fms' % (body, dt1 * 1000))
        check('response shape unchanged (stdout/stderr/exitCode)',
              set(body.keys()) == {'stdout', 'stderr', 'exitCode'}, sorted(body.keys()))
        check('route returns promptly despite persisting master (no pipe hang)',
              dt1 < 15, '%.1fs' % dt1)

        ctl = mod._mux_control_path('127.0.0.1', port, user, 'agent')
        check('control socket exists at the predicted path', os.path.exists(ctl), ctl)

        def master_pid():
            chk = subprocess.run(
                [ssh_bin, '-F', '/dev/null', '-o', 'ControlPath=%s' % ctl,
                 '-O', 'check', '-p', str(port), '%s@127.0.0.1' % user],
                capture_output=True, text=True)
            m = re.search(r'pid=(\d+)', chk.stderr)
            return int(m.group(1)) if m else None

        pid_a = master_pid()
        check('mux master is alive after call 1', pid_a is not None, 'pid=%s' % pid_a)

        times = []
        for i in range(3):
            r, dt = call('echo mux-again-%d' % i)
            b = r.get_json()
            check('call %d correct over reused connection' % (i + 2),
                  r.status_code == 200 and b.get('stdout') == 'mux-again-%d\n' % i
                  and b.get('exitCode') == 0, '%.0fms' % (dt * 1000))
            times.append(dt)
        pid_b = master_pid()
        check('same master served all calls (stable pid = no re-handshake)',
              pid_a is not None and pid_a == pid_b, 'pid %s -> %s' % (pid_a, pid_b))
        print('INFO: call1 %.0fms (handshake), calls 2-4 %s ms (reused)'
              % (dt1 * 1000, [int(t * 1000) for t in times]))

        # nonzero exit + stderr passthrough over the reused connection
        r, _ = call('echo oops 1>&2; exit 7')
        b = r.get_json()
        check('nonzero exitCode passes through unchanged',
              r.status_code == 200 and b.get('exitCode') == 7, b)
        check('stderr passes through unchanged', 'oops' in (b.get('stderr') or ''), b)

        # direct handshake count from sshd's own log: 5 route calls, 1 auth
        with open(sshd_log) as fh:
            accepted = fh.read().count('Accepted publickey')
        check('sshd saw exactly ONE publickey handshake for 5 route calls',
              accepted == 1, '%d handshake(s)' % accepted)

        # stale socket (dead master) must degrade to a working direct connection
        os.kill(pid_a, signal.SIGKILL)
        time.sleep(0.5)
        r, _ = call('echo after-stale')
        b = r.get_json()
        check('stale control socket degrades to a working connection',
              r.status_code == 200 and b.get('stdout') == 'after-stale\n'
              and b.get('exitCode') == 0, b)

        # idle cleanup: shrink ControlPersist and verify the master self-exits
        saved_persist = mod.MUX_PERSIST_SECONDS
        mod.MUX_PERSIST_SECONDS = 2
        try:
            # fresh socket so the new master is created with the 2s persist
            shutil.rmtree(mod.MUX_DIR, ignore_errors=True)
            r, _ = call('echo persist-probe')
            check('call under short ControlPersist still correct',
                  r.status_code == 200 and r.get_json().get('stdout') == 'persist-probe\n')
            pid_c = master_pid()
            # Wait WITHOUT polling: each `ssh -O check` is itself a mux client
            # connection and resets the master's ControlPersist idle timer.
            time.sleep(mod.MUX_PERSIST_SECONDS + 3)
            gone = master_pid() is None
            if not gone:  # one generous retry for slow machines
                time.sleep(mod.MUX_PERSIST_SECONDS + 3)
                gone = master_pid() is None
            check('idle master self-terminates after ControlPersist (no leak)',
                  gone, 'was pid=%s' % pid_c)
        finally:
            mod.MUX_PERSIST_SECONDS = saved_persist

    passed = sum(1 for _, ok in results if ok)
    print('\nSUMMARY: %d/%d passed' % (passed, len(results)))
    exit_code = 0 if passed == len(results) else 1
except Exception:  # noqa: BLE001
    import traceback
    print('TEST DRIVER ERROR:')
    traceback.print_exc()
finally:
    mod.MUX_DIR = saved_mux_dir
    if agent_pid is not None:
        try:
            os.kill(agent_pid, signal.SIGTERM)
        except OSError:
            pass
    if saved_auth_sock is None:
        os.environ.pop('SSH_AUTH_SOCK', None)
    else:
        os.environ['SSH_AUTH_SOCK'] = saved_auth_sock
    if sshd_proc is not None and sshd_proc.poll() is None:
        sshd_proc.terminate()
        try:
            sshd_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            sshd_proc.kill()
    shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(exit_code)
