#!/usr/bin/env python3
"""
Guards the Taskwarrior path confinement (backend/task_paths.py, applied in
backend/taskwarrior.py).

THE BUG: every /api/taskwarrior route took the instance's rcPath / dataPath
from the request and handed them to `task` as `rc:<path>` and
`rc.data.location=<path>`; /instances/init wrote a taskrc file at rcPath
with client-chosen `config` lines. In the browser deployment (no sign-in)
that was an arbitrary file write - pointing rcPath at the settings file
replaced it with KEY=VALUE lines of the attacker's choice (the settings
reader skips the "#" and "data.location=" lines) - and an arbitrary data
directory for `pending.data` and friends.

THE FIX: outside the desktop's app-token mode, dataPath must be the
Taskwarrior root or inside it (JACARIUM_TASK_ROOT, default
~/.task), rcPath inside the root or exactly ~/.taskrc; realpath first, so a
symlink cannot point outside; a relative path resolves under the root.
The taskrc `config` lines are validated in every mode: allow-listed key
syntax, no data.location / include / hooks / editor / alias / taskd / ...,
no control characters.

What this test proves (Flask test client in auth mode "none", a throwaway
HOME so the default root is <home>/.task, subprocess.run replaced by a
recorder unless the real CLI is used, synthetic data only):
  - an absolute, a "..", and a symlinked dataPath outside the root are
    refused on /export and nothing runs; a relative one resolves inside;
  - rcPath outside the root is refused; ~/.taskrc and a file under the
    root are accepted;
  - /instances/init refuses to write over the settings file (contents
    unchanged), refuses every dangerous config key and a value with a line
    break, and writes an accepted config exactly;
  - /instances/validate refuses an outside path with 400;
  - desktop semantics (auth mode app-token, no root): paths are only
    ~-expanded, while the config validation still applies;
  - with the real `task` CLI present: an instance under the root
    initializes, takes a task and exports it.

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/taskwarrior_path_containment.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-task-paths-')
HOME = os.path.join(TMP, 'home')
ROOT = os.path.join(HOME, '.task')
OUTSIDE = os.path.join(TMP, 'outside')
os.makedirs(ROOT)
os.makedirs(OUTSIDE)
os.symlink(OUTSIDE, os.path.join(ROOT, 'escape'))
ENV_FILE = os.path.join(HOME, '.jacarium.env')
with open(ENV_FILE, 'w') as fh:
    fh.write('# Jacarium settings\nJIRA_URL=https://jira.example.test\n')

os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'none'
os.environ['JACARIUM_ENV_FILE'] = ENV_FILE
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(TMP, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(TMP, 'known_hosts')
os.environ.pop('JACARIUM_TASK_ROOT', None)
os.environ.pop('TASKRC', None)
os.environ.pop('TASKDATA', None)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402
import taskwarrior  # noqa: E402
import task_paths  # noqa: E402

REAL_RUN = subprocess.run
calls = []


class _Completed:
    returncode = 0
    stdout = '[]'
    stderr = ''


def _recording_run(cmd, *args, **kwargs):
    calls.append(list(cmd))
    return _Completed()


subprocess.run = _recording_run
taskwarrior.check_taskwarrior_installed = lambda: True

client = app_module.app.test_client()
results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def body(response):
    try:
        return response.get_json() or {}
    except Exception:
        return {}


def export(rc_path=None, data_path=None):
    calls.clear()
    return client.post('/api/taskwarrior/export', json={'rcPath': rc_path, 'dataPath': data_path})


check('the default root is ~/.task of the backend\'s HOME', task_paths.task_root() == os.path.realpath(ROOT), task_paths.task_root())

# --- dataPath ---------------------------------------------------------------
for candidate in (OUTSIDE, os.path.join(ROOT, '..', 'outside'), os.path.join(ROOT, 'escape'), '../outside', '~/.ssh', HOME):
    r = export(data_path=candidate)
    check(f'dataPath {candidate!r} outside the root is refused and nothing runs',
          r.status_code == 500 and 'must be inside' in body(r).get('error', '') and not calls,
          f'{r.status_code} {body(r).get("error", "")[:70]}')
r = export(data_path='work')
check('a relative dataPath resolves under the root',
      r.status_code == 200 and calls == [['task', f'rc.data.location={os.path.join(os.path.realpath(ROOT), "work")}', 'rc.report.export.filter=status.any:', 'export']],
      json.dumps(calls))
r = export(data_path='~/.task/personal')
check('~/.task/<name> is accepted', r.status_code == 200 and calls[-1][1].endswith('/.task/personal'), json.dumps(calls))
r = export(data_path='~/.task')
check('the root itself is accepted', r.status_code == 200 and calls[-1][1] == f'rc.data.location={os.path.realpath(ROOT)}', json.dumps(calls))

# --- rcPath -----------------------------------------------------------------
for candidate in (ENV_FILE, os.path.join(OUTSIDE, 'taskrc'), '~/.taskrc-personal', os.path.join(ROOT, 'escape', 'taskrc')):
    r = export(rc_path=candidate, data_path='work')
    check(f'rcPath {candidate!r} outside the root is refused and nothing runs',
          r.status_code == 500 and 'taskrc file must be inside' in body(r).get('error', '') and not calls,
          f'{r.status_code} {body(r).get("error", "")[:70]}')
r = export(rc_path='~/.taskrc', data_path='work')
check('~/.taskrc (the default rc) is accepted', r.status_code == 200 and calls[-1][1] == f'rc:{os.path.realpath(os.path.join(HOME, ".taskrc"))}', json.dumps(calls))
r = export(rc_path='~/.task/personal/taskrc', data_path='~/.task/personal')
check('a taskrc under the root is accepted', r.status_code == 200 and calls[-1][1].endswith('/.task/personal/taskrc'), json.dumps(calls))

# --- /instances/init: no write outside the root, validated config ----------
before = open(ENV_FILE).read()
r = client.post('/api/taskwarrior/instances/init', json={
    'rcPath': ENV_FILE, 'dataPath': '~/.task/x', 'config': {'JIRA_URL': 'https://attacker.example'}})
check('init cannot write the taskrc over the settings file',
      r.status_code == 400 and open(ENV_FILE).read() == before and not os.path.exists(os.path.join(ROOT, 'x')),
      f'{r.status_code} {body(r).get("error", "")[:70]}')
r = client.post('/api/taskwarrior/instances/init', json={'rcPath': '~/.task/p/taskrc', 'dataPath': OUTSIDE})
check('init refuses a data directory outside the root', r.status_code == 400 and not os.path.exists(os.path.join(ROOT, 'p')))

for bad_config in ({'data.location': '/tmp/x'}, {'hooks': 'on'}, {'hooks.location': '/x'}, {'include': '/etc/passwd'},
                   {'alias.rm': 'execute'}, {'editor': '/bin/sh'}, {'taskd.server': 'x:1'}, {'default.command': 'execute id'},
                   {'abbreviation.minimum': '1'}, {'color': 'on\nhooks=on'}, {'Color!': 'x'}, {'rc.color': 'on'},
                   {'color': ['on']}, {'locking': 'off'}, {'sync.server.url': 'x'}):
    calls.clear()
    r = client.post('/api/taskwarrior/instances/init', json={'rcPath': '~/.task/p/taskrc', 'dataPath': '~/.task/p', 'config': bad_config})
    check(f'init refuses config {bad_config!r}',
          r.status_code == 400 and not calls and not os.path.exists(os.path.join(ROOT, 'p', 'taskrc')),
          f'{r.status_code} {body(r).get("error", "")[:70]}')
r = client.post('/api/taskwarrior/instances/init', json={'rcPath': '~/.task/p/taskrc', 'dataPath': '~/.task/p', 'config': 'hooks=on'})
check('init refuses a config that is not an object', r.status_code == 400)

good = {'color': 'off', 'dateformat': 'Y-M-D', 'report.next.columns': 'id,description', 'uda.estimate.type': 'numeric',
        'urgency.user.tag.next.coefficient': 15.0, 'confirmation': False}
r = client.post('/api/taskwarrior/instances/init', json={'rcPath': '~/.task/p/taskrc', 'dataPath': '~/.task/p', 'config': good})
written = open(os.path.join(ROOT, 'p', 'taskrc')).read() if os.path.exists(os.path.join(ROOT, 'p', 'taskrc')) else ''
expected_lines = [f'data.location={os.path.join(os.path.realpath(ROOT), "p")}', 'color=off', 'dateformat=Y-M-D',
                  'report.next.columns=id,description', 'uda.estimate.type=numeric',
                  'urgency.user.tag.next.coefficient=15.0', 'confirmation=off']
check('init writes an accepted config exactly (data.location is the validated directory)',
      r.status_code == 200 and all(line in written.splitlines() for line in expected_lines) and 'hooks' not in written,
      written.replace('\n', ' | ')[:300])

# --- /instances/validate ---------------------------------------------------
r = client.post('/api/taskwarrior/instances/validate', json={'rcPath': ENV_FILE, 'dataPath': '~/.task/p'})
check('validate refuses an outside rc path with 400', r.status_code == 400 and body(r).get('valid') is False and 'must be inside' in ' '.join(body(r).get('errors', [])))

# --- desktop semantics (app-token mode, no root) -----------------------------
os.environ['JACARIUM_AUTH_MODE'] = 'app-token'
try:
    check('desktop: no root', task_paths.task_root() is None)
    check('desktop: dataPath is only ~-expanded', task_paths.resolve_data_path('~/anywhere/tasks') == os.path.join(HOME, 'anywhere', 'tasks'))
    check('desktop: rcPath is only ~-expanded', task_paths.resolve_rc_path('/somewhere/else/taskrc') == '/somewhere/else/taskrc')
    try:
        task_paths.validate_taskrc_config({'hooks': 'on'})
        check('desktop: the taskrc config is still validated', False)
    except task_paths.TaskPathError:
        check('desktop: the taskrc config is still validated', True)
    os.environ['JACARIUM_TASK_ROOT'] = ROOT
    check('desktop: an explicit JACARIUM_TASK_ROOT confines too', task_paths.task_root() == os.path.realpath(ROOT))
    try:
        task_paths.resolve_data_path(OUTSIDE)
        check('desktop with an explicit root: outside refused', False)
    except task_paths.TaskPathError:
        check('desktop with an explicit root: outside refused', True)
finally:
    os.environ.pop('JACARIUM_TASK_ROOT', None)
    os.environ['JACARIUM_AUTH_MODE'] = 'none'

# --- the real CLI, when present ------------------------------------------------
subprocess.run = REAL_RUN
if shutil.which('task'):
    taskwarrior.check_taskwarrior_installed = lambda: True
    r = client.post('/api/taskwarrior/instances/init', json={'rcPath': '~/.task/real/taskrc', 'dataPath': '~/.task/real', 'config': {'confirmation': 'off'}})
    check('real CLI: an instance under the root initializes', r.status_code == 200, body(r).get('error', ''))
    r = client.post('/api/taskwarrior/add', json={'rcPath': '~/.task/real/taskrc', 'dataPath': '~/.task/real', 'description': 'synthetic task'})
    check('real CLI: a task is added', r.status_code == 200, body(r).get('error', ''))
    r = client.post('/api/taskwarrior/export', json={'rcPath': '~/.task/real/taskrc', 'dataPath': '~/.task/real'})
    tasks = r.get_json() if r.status_code == 200 else None
    check('real CLI: the export lists it', isinstance(tasks, list) and len(tasks) == 1 and tasks[0].get('description') == 'synthetic task', r.get_data(as_text=True)[:200])
    check('real CLI: the data landed under the root', os.path.exists(os.path.join(ROOT, 'real', 'pending.data')) or os.path.exists(os.path.join(ROOT, 'real', 'taskchampion.sqlite3')))
else:
    print('SKIP - real `task` CLI not on PATH (the recorder-based checks above still ran)')

shutil.rmtree(TMP, ignore_errors=True)
failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
