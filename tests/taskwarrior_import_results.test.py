#!/usr/bin/env python3
"""
POST /api/taskwarrior/import (backend/taskwarrior.py import_tasks) must report
WHICH tasks TaskWarrior added and which it modified, not just echo the number
of tasks it was handed.

The database backup import (src/utils/importDatabase.js, format-2 files from
src/utils/taskwarriorBackup.js) pushes only the new and newer tasks of a backup
through this route and then confirms its planned statistics against the
result: a pushed uuid TaskWarrior neither added nor modified is reported as
invalid instead of being counted as imported. `task import` prints one line
per task it touched, " add  <uuid> <description>" or " mod  <uuid>
<description>" (TaskWarrior 3.4.2; same two-word prefix in 2.6), surrounded
by chatter that depends on rc.verbose - parse_import_output() extracts the
uuids from those lines.

Self-contained, no test framework:
  - creates its OWN temporary TASKDATA dir + taskrc (never touches real task data),
  - calls the REAL Flask route through a test client (blueprint on a bare app),
  - imports two synthetic tasks (both `added`), re-imports one with a change
    (`modified`, and the change is visible in a fresh `task export`),
  - imports an older copy of a task and shows TaskWarrior still overwrote it
    (the upsert-regardless-of-modified behaviour the frontend relies on
    doing its own `modified` comparison for),
  - unit-checks parse_import_output on verbose and quiet output samples.

Run:  backend/venv/bin/python tests/taskwarrior_import_results.test.py
Requires: TaskWarrior installed (`task --version`).
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print('%s: %s%s' % ('PASS' if cond else 'FAIL', name, (' | ' + str(detail)) if detail else ''))


TASK_BIN = shutil.which('task')
if not TASK_BIN:
    print('TaskWarrior is not installed ("task" not on PATH).')
    print('Install it with: brew install task  (macOS) / sudo apt install taskwarrior (Debian)')
    sys.exit(1)
try:
    import flask  # noqa: F401
except ImportError:
    print('Missing dependency "flask". Run with the backend venv:')
    print('  backend/venv/bin/python tests/taskwarrior_import_results.test.py')
    sys.exit(1)

from flask import Flask

WORKDIR = tempfile.mkdtemp(prefix='taskwarrior-import-results-')
DATA_DIR = os.path.join(WORKDIR, 'data')
TASKRC = os.path.join(WORKDIR, 'taskrc')
os.makedirs(DATA_DIR, exist_ok=True)
with open(TASKRC, 'w') as fh:
    fh.write('data.location=%s\n' % DATA_DIR)
    fh.write('confirmation=no\n')
    fh.write('hooks=0\n')
print('temp task data: %s' % WORKDIR)

UUID_A = '0000000a-0000-4000-8000-00000000000a'
UUID_B = '0000000b-0000-4000-8000-00000000000b'


def task_cli(*args):
    return subprocess.run(
        [TASK_BIN, 'rc:' + TASKRC, 'rc.data.location=' + DATA_DIR] + list(args),
        capture_output=True, text=True, stdin=subprocess.DEVNULL,
    )


def export():
    out = task_cli('rc.report.export.filter=status.any:', 'export').stdout.strip()
    return {t['uuid']: t for t in (json.loads(out) if out else [])}


exit_code = 1
try:
    import taskwarrior as tw_module

    app = Flask(__name__)
    app.register_blueprint(tw_module.taskwarrior)
    client = app.test_client()

    def post_import(tasks):
        resp = client.post('/api/taskwarrior/import',
                           json={'tasks': tasks, 'rcPath': TASKRC, 'dataPath': DATA_DIR})
        return resp, resp.get_json()

    # ---------- unit: parse_import_output ----------
    verbose = (
        "Importing 'STDIN'\n"
        " add  %s alpha synthetic\n"
        "Modifying task 0000000b 'bravo synthetic'.\n"
        " mod  %s bravo synthetic\n"
        "TASKRC override: /tmp/x/taskrc\n"
        "Imported 2 tasks.\n" % (UUID_A, UUID_B)
    )
    parsed = tw_module.parse_import_output(verbose)
    check('parse_import_output: add/mod uuids extracted from verbose output',
          parsed == {'added': [UUID_A], 'modified': [UUID_B]}, parsed)
    quiet = " add  %s one\n add  %s two\n" % (UUID_A.upper(), UUID_A)
    parsed_q = tw_module.parse_import_output(quiet)
    check('parse_import_output: quiet output, uuids lower-cased and de-duplicated',
          parsed_q == {'added': [UUID_A], 'modified': []}, parsed_q)
    check('parse_import_output: empty / None output -> empty lists',
          tw_module.parse_import_output('') == {'added': [], 'modified': []} and
          tw_module.parse_import_output(None) == {'added': [], 'modified': []})

    # ---------- route: two new tasks -> both added ----------
    resp1, body1 = post_import([
        {'uuid': UUID_A, 'description': 'alpha synthetic', 'status': 'pending',
         'entry': '20250101T000000Z', 'modified': '20250101T000000Z'},
        {'uuid': UUID_B, 'description': 'bravo synthetic', 'status': 'pending',
         'entry': '20250101T000000Z', 'modified': '20250101T000000Z'},
    ])
    check('import route: 200 + success', resp1.status_code == 200 and body1.get('success') is True, body1)
    check('import route: count still echoes the number of tasks handed in (compat)', body1.get('count') == 2, body1)
    check('import route: both uuids listed under added, none under modified',
          sorted(body1.get('added', [])) == sorted([UUID_A, UUID_B]) and body1.get('modified') == [], body1)
    check('tasks are really in the data files', set(export().keys()) == {UUID_A, UUID_B})

    # ---------- route: re-import one with a change -> modified ----------
    resp2, body2 = post_import([
        {'uuid': UUID_A, 'description': 'alpha synthetic (changed)', 'status': 'pending',
         'entry': '20250101T000000Z', 'modified': '20250102T000000Z'},
    ])
    check('re-import of an existing uuid is reported under modified only',
          body2.get('added') == [] and body2.get('modified') == [UUID_A], body2)
    check('the change is visible in a fresh export', export()[UUID_A]['description'] == 'alpha synthetic (changed)')

    # ---------- route: an OLDER copy still overwrites (upsert regardless of modified) ----------
    resp3, body3 = post_import([
        {'uuid': UUID_B, 'description': 'bravo synthetic (older copy)', 'status': 'pending',
         'entry': '20250101T000000Z', 'modified': '20240101T000000Z'},
    ])
    check('an older copy is still applied by `task import` (the frontend must compare modified itself)',
          body3.get('modified') == [UUID_B] and export()[UUID_B]['description'] == 'bravo synthetic (older copy)', body3)

    # ---------- route: nothing to import ----------
    resp4, body4 = post_import([])
    check('empty task list: success with count 0', resp4.status_code == 200 and body4.get('count') == 0, body4)

    passed = sum(1 for _, ok in results if ok)
    print('\nSUMMARY: %d/%d passed' % (passed, len(results)))
    exit_code = 0 if passed == len(results) else 1
except Exception:
    import traceback
    print('TEST DRIVER ERROR:')
    traceback.print_exc()
finally:
    shutil.rmtree(WORKDIR, ignore_errors=True)
    sys.exit(exit_code)
