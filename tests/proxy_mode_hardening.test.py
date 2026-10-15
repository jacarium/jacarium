#!/usr/bin/env python3
"""
Guards two browser-deployment (auth mode "none") fixes in the backend.

1. SSH connection reuse is off (backend/ssh_exec.py, _mux_options).
   THE BUG: /api/execute-ssh reused an OpenSSH ControlMaster socket keyed
   by (auth method, user, host, port) under the process's home directory.
   The container serves every user of the proxy with one process and one
   home, so an authenticated session opened by one request (root@host via
   a password) was reused by the next request from anyone for the same
   target - no credentials needed. THE FIX: no multiplexing unless the
   backend runs in the desktop's app-token mode (one user, one token).

2. /api/ai/models reloads the configured settings file (backend/ai_chat.py).
   THE BUG: it re-read ~/.jacarium.env directly, ignoring
   JACARIUM_ENV_FILE; it only worked in the container because HOME
   is /data there. THE FIX: it loads settings_store.env_file_path().

What this test proves (Flask test client in auth mode "none", a throwaway
HOME with no ~/.jacarium.env, synthetic values only):
  - _mux_options() returns [] in auth mode "none";
  - in app-token mode (a child interpreter) it returns ControlMaster
    options on platforms that support them;
  - GET /api/ai/models picks up a value written to the JACARIUM_ENV_FILE
    path, with no ~/.jacarium.env present.

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/proxy_mode_hardening.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-proxy-mode-')
HOME = os.path.join(TMP, 'home')
os.makedirs(HOME)
ENV_FILE = os.path.join(TMP, 'elsewhere', 'jacarium.env')
os.makedirs(os.path.dirname(ENV_FILE))
with open(ENV_FILE, 'w') as fh:
    fh.write('DEFAULT_AI_MODEL=synthetic-model-42\n')

os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'none'
os.environ['JACARIUM_ENV_FILE'] = ENV_FILE
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(TMP, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(TMP, 'known_hosts')
os.environ.pop('DEFAULT_AI_MODEL', None)
os.environ.pop('JACARIUM_DISABLE_SSH_MUX', None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402
import ssh_exec  # noqa: E402

client = app_module.app.test_client()
results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


# --- 1. no ControlMaster reuse in auth mode "none" --------------------------------
check('auth mode none: _mux_options returns no ControlMaster options',
      ssh_exec._mux_options('host.example.test', 22, 'someone', 'agent') == [])
check('auth mode none: ...for password logins too',
      ssh_exec._mux_options('host.example.test', 22, 'someone', 'password') == [])

# The control socket path has a hard length limit (AF_UNIX): a macOS temp
# dir is far too long, so the child gets a short HOME under /tmp.
short_home = tempfile.mkdtemp(prefix='sc-mux-', dir='/tmp' if os.path.isdir('/tmp') else None)
child = subprocess.run(
    [sys.executable, '-c',
     'import sys, os; sys.path.insert(0, %r); os.chdir(%r); import ssh_exec; '
     'print(len(ssh_exec._mux_options("host.example.test", 22, "someone", "agent")))' % (BACKEND, BACKEND)],
    env={**os.environ, 'HOME': short_home, 'JACARIUM_AUTH_MODE': 'app-token', 'APP_AUTH_TOKEN': 'synthetic-token'},
    capture_output=True, text=True, timeout=120)
count = child.stdout.strip().splitlines()[-1] if child.stdout.strip() else ''
if sys.platform == 'win32':
    check('app-token mode (child interpreter): no multiplexing on Windows', count == '0', child.stderr[-200:])
else:
    check('app-token mode (child interpreter): ControlMaster options are still produced', count == '6', f'stdout={count!r} stderr={child.stderr[-200:]}')

# --- 2. /api/ai/models honours JACARIUM_ENV_FILE --------------------------
check('no ~/.jacarium.env exists in the throwaway HOME', not os.path.exists(os.path.join(HOME, '.jacarium.env')))
r = client.get('/api/ai/models')
check('GET /api/ai/models answers', r.status_code == 200, r.get_data(as_text=True)[:120])
check('...and loaded the configured settings file', os.environ.get('DEFAULT_AI_MODEL') == 'synthetic-model-42', str(os.environ.get('DEFAULT_AI_MODEL')))

import shutil  # noqa: E402
shutil.rmtree(short_home, ignore_errors=True)
shutil.rmtree(TMP, ignore_errors=True)
failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
