#!/usr/bin/env python3
"""
Guards the reserved-name rule of the Settings store (backend/settings_store.py,
mirrored by electron/settings-store.cjs - see settings-reserved-keys.test.mjs).

THE BUG: PUT /api/settings accepted any KEY matching ^[A-Z][A-Z0-9_]{0,63}$,
wrote it to the env file and mirrored it into os.environ, which the `task`
and `ssh` subprocesses inherit. So a settings write could set TASKDATA (where
Taskwarrior keeps its data), HTTPS_PROXY (every outbound request - with the
Jira PAT and API keys in it - through a proxy of the caller's choice),
SSL_CERT_FILE / REQUESTS_CA_BUNDLE (which CA to trust), LD_PRELOAD,
PYTHONPATH, PATH, JACARIUM_* (the backend's own configuration) and
more. In the browser deployment (no sign-in) anyone on the network could.

THE FIX: is_reserved_key() refuses those names and prefixes on PUT (plain
values and secrets alike); the keys the dialog knows (KNOWN_KEYS) are never
affected, an unknown harmless key still works, and a line the operator
wrote into the file by hand is preserved.

What this test proves (merge_update directly, then the route through the
Flask test client in auth mode "none", synthetic values only):
  - reserved names and prefixes are refused as plain values and as secrets;
  - known keys (AWS_REGION, HF_TOKEN, HF_EMBEDDING_MODEL, ...) still save;
  - an unknown harmless key still saves;
  - an operator-written reserved line survives a save of other keys;
  - PUT with a reserved key answers 400, writes nothing, and os.environ is
    untouched.

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/settings_reserved_keys.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import sys
import tempfile
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-settings-reserved-')
ENV_FILE = os.path.join(TMP, 'jacarium.env')
os.environ['JACARIUM_AUTH_MODE'] = 'none'
os.environ['JACARIUM_ENV_FILE'] = ENV_FILE
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(TMP, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(TMP, 'known_hosts')
for key in ('TASKDATA', 'TASKRC', 'HTTPS_PROXY', 'LD_PRELOAD', 'MY_CUSTOM_SETTING'):
    os.environ.pop(key, None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402
import settings_store  # noqa: E402

client = app_module.app.test_client()
results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def refused(plain=None, secrets=None):
    try:
        settings_store.merge_update(OrderedDict(), plain or {}, secrets or {})
        return False
    except ValueError as exc:
        return 'cannot be set' in str(exc)


# --- the rule -----------------------------------------------------------------
for key in ('TASKDATA', 'TASKRC', 'PATH', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
            'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
            'PYTHONPATH', 'PYTHONSTARTUP', 'JACARIUM_TASK_ROOT', 'JACARIUM_AUTH_MODE', 'FLASK_DEBUG',
            'GUNICORN_THREADS', 'APP_AUTH_TOKEN', 'PORT', 'SSHPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'NODE_OPTIONS',
            'HF_HUB_OFFLINE', 'TLS_CERT_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_SHARED_CREDENTIALS_FILE', 'GIT_SSH_COMMAND'):
    check(f'{key} is refused as a plain value', refused(plain={key: '/x'}))
for key in ('JACARIUM_SETUP_TOKEN', 'LD_PRELOAD_KEY', 'PYTHON_SECRET', 'SSH_ASKPASS'):
    check(f'{key} is refused as a secret', refused(secrets={key: 'synthetic'}))

merged = settings_store.merge_update(OrderedDict(), {'AWS_REGION': 'eu-west-1', 'HF_EMBEDDING_MODEL': 'synthetic/model', 'MY_CUSTOM_SETTING': 'yes'},
                                     {'HF_TOKEN': 'hf_synthetic', 'SSH_AI_PASSWORD': 'synthetic-pass'})
check('known keys and an unknown harmless key still save',
      merged.get('AWS_REGION') == 'eu-west-1' and merged.get('HF_EMBEDDING_MODEL') == 'synthetic/model'
      and merged.get('MY_CUSTOM_SETTING') == 'yes' and merged.get('HF_TOKEN') == 'hf_synthetic' and merged.get('SSH_AI_PASSWORD') == 'synthetic-pass',
      dict(merged))

current = OrderedDict([('PATH', '/operator/bin'), ('JIRA_EMAIL', 'someone@example.test')])
merged = settings_store.merge_update(current, {'DEFAULT_AI_PROVIDER': 'anthropic'}, {})
check('an operator-written reserved line in the file survives a save of other keys',
      merged.get('PATH') == '/operator/bin' and merged.get('DEFAULT_AI_PROVIDER') == 'anthropic', dict(merged))

# --- the route ----------------------------------------------------------------
r = client.put('/api/settings', json={'values': {'JIRA_EMAIL': 'someone@example.test'}})
check('a normal PUT works', r.status_code == 200 and os.path.exists(ENV_FILE), r.get_data(as_text=True)[:120])
before = open(ENV_FILE).read()
for payload in ({'values': {'TASKDATA': os.path.join(TMP, 'elsewhere')}},
                {'values': {'HTTPS_PROXY': 'http://proxy.example.test:3128'}},
                {'secrets': {'LD_PRELOAD_KEY': 'synthetic'}},
                {'values': {'JIRA_EMAIL': 'other@example.test', 'PYTHONPATH': '/x'}}):
    r = client.put('/api/settings', json=payload)
    check(f'PUT {payload!r} answers 400 and writes nothing',
          r.status_code == 400 and 'cannot be set' in (r.get_json() or {}).get('error', '') and open(ENV_FILE).read() == before,
          f'{r.status_code} {r.get_data(as_text=True)[:100]}')
check('os.environ did not pick up any refused key',
      all(key not in os.environ for key in ('TASKDATA', 'HTTPS_PROXY', 'LD_PRELOAD_KEY', 'PYTHONPATH'))
      and os.environ.get('JIRA_EMAIL') == 'someone@example.test')

failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
