#!/usr/bin/env python3
"""
Guards the closing of two command-execution holes in backend/taskwarrior.py.

THE BUG: `task` finds its command by scanning argv for a command name (or a
unique abbreviation of one), and Taskwarrior's `execute` command runs its
arguments in a shell. Two routes put client text in that position:

  - POST /api/taskwarrior/command split a string into argv and ran it, i.e.
    `task execute id` for whoever could reach the backend - in the browser
    deployment (no sign-in) that is everyone on the network. Nothing in the
    app called it.
  - POST /api/taskwarrior/reports/execute put the custom report's free-text
    filter BEFORE the command, so a filter of "execute id" ran `id`; its
    "text" format also put the report name in the command slot.

THE FIX: /command is gone (404). /reports/execute accepts only the JSON
form, validates the report name, and accepts a filter term only when it is
unambiguously a filter: an attribute (name:value), a tag (+x / -x), an id,
range or UUID, a /pattern/, the operators ( ) and or xor, or a bare word
that is not a prefix of any task command or built-in report. rc.* / rc:
overrides and --flags are refused. /reports/config validates its name.

What this test proves (Flask test client in auth mode "none", subprocess.run
replaced by a recorder so nothing is ever executed, synthetic data only):
  - /command answers 404;
  - every dangerous filter (execute, exec, ex, _get, import, ed, del,
    rc.data.location=, rc:, --version) is refused with 400 before the CLI
    is invoked;
  - every 2+ character prefix of every known command / report is refused;
  - format "text" and a malformed report name are refused;
  - a report named "execute" never reaches argv (the name only maps to a
    status filter; the command is always `export`);
  - ordinary filters (attributes, tags, ids, patterns, parentheses glued to
    terms, plain words) pass and produce exactly the expected argv;
  - /reports/config refuses an rc-looking name and passes a real one.

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python tests/taskwarrior_command_rce.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(os.path.dirname(HERE), 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-task-rce-')
ROOT = os.path.join(TMP, 'task-root')
os.makedirs(ROOT)
os.environ['JACARIUM_AUTH_MODE'] = 'none'
os.environ['JACARIUM_ENV_FILE'] = os.path.join(TMP, 'jacarium.env')
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(TMP, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(TMP, 'known_hosts')
os.environ['JACARIUM_TASK_ROOT'] = ROOT

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)

import app as app_module  # noqa: E402  (registers the blueprints)
import taskwarrior  # noqa: E402

calls = []


class _Completed:
    returncode = 0
    stdout = '[]'
    stderr = ''


def _recording_run(cmd, *args, **kwargs):
    calls.append(list(cmd))
    return _Completed()


subprocess.run = _recording_run          # taskwarrior.py calls subprocess.run
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


def execute(filter_value, report_name='next', fmt='json', data_path='inst'):
    calls.clear()
    payload = {'reportName': report_name, 'filter': filter_value, 'format': fmt, 'dataPath': data_path}
    return client.post('/api/taskwarrior/reports/execute', json=payload)


# --- the run-anything route is gone ---------------------------------------
r = client.post('/api/taskwarrior/command', json={'command': 'execute id'})
check('POST /api/taskwarrior/command no longer exists', r.status_code == 404 and not calls, str(r.status_code))

# --- dangerous filter terms never reach the CLI ---------------------------
for bad in ('execute id', ['execute', 'id'], 'exec', 'ex', '_get', 'import', 'ed', 'del', 'edit',
            'rc.data.location=/tmp/x', 'rc:/tmp/x', 'RC.data.location=/x', '--version', '(execute)'):
    r = execute(bad)
    check(f'filter {bad!r} is refused before the CLI runs',
          r.status_code == 400 and not calls and 'not allowed' in body(r).get('error', ''),
          f'{r.status_code} {body(r).get("error", "")[:80]} calls={calls}')

prefix_failures = []
for name in sorted(taskwarrior._TASK_COMMANDS):
    for length in range(2, len(name) + 1):
        prefix = name[:length]
        try:
            taskwarrior.validate_filter_tokens([prefix])
            prefix_failures.append(prefix)
        except ValueError:
            pass
check('every 2+ character prefix of every task command / built-in report is refused', not prefix_failures, ', '.join(prefix_failures[:10]))

r = execute('status:pending', fmt='text')
check('the text format (report name in the command slot) is refused', r.status_code == 400 and not calls)
r = execute('status:pending', report_name='next execute')
check('a malformed report name is refused', r.status_code == 400 and not calls)
r = execute([], report_name='execute')
check('a report named "execute" never reaches argv (always `export`)',
      r.status_code == 200 and calls and calls[-1][-1] == 'export' and 'execute' not in calls[-1], str(calls))
r = execute(123)
check('a non-string / non-list filter is refused', r.status_code == 400 and not calls)

# --- ordinary filters work and produce exactly the expected argv ----------
# (the data path is confined under JACARIUM_TASK_ROOT and comes back
# as a real path - /private/var/... for a macOS temp dir)
DATA_ARG = f'rc.data.location={os.path.join(os.path.realpath(ROOT), "inst")}'
r = execute('project:Work +urgent -later due.before:eom 12 3-5,9 /meeting/ meeting with bob')
expected = ['task', DATA_ARG,
            'project:Work', '+urgent', '-later', 'due.before:eom', '12', '3-5,9', '/meeting/', 'meeting', 'with', 'bob',
            'status:pending', 'export']
check('attributes, tags, ids, patterns and plain words pass through unchanged', r.status_code == 200 and calls == [expected], json.dumps(calls))
r = execute('(project:A or project:B) and status.not:deleted', report_name='all')
expected = ['task', DATA_ARG, '(', 'project:A', 'or', 'project:B', ')', 'and', 'status.not:deleted', 'export']
check('parentheses glued to terms become operator tokens; "all" adds no status', r.status_code == 200 and calls == [expected], json.dumps(calls))
# A token with a colon can never be read as a command (verified against the
# real CLI: `task exe: id export` is an empty export, `task execute id` runs
# `id`), so an attribute with an empty value - `project:` means "no
# project" - stays allowed.
r = execute('project: exe:')
check('an attribute with an empty value is a filter term, not a command', r.status_code == 200 and calls[-1][2:4] == ['project:', 'exe:'], json.dumps(calls))
r = execute('status:completed', report_name='next')
check('an explicit status filter is not overridden by the report mapping', r.status_code == 200 and calls[-1].count('status:completed') == 1 and 'status:pending' not in calls[-1], json.dumps(calls))
r = execute('', report_name='completed')
check('"completed" maps to status:completed', r.status_code == 200 and calls[-1][-2:] == ['status:completed', 'export'], json.dumps(calls))
uuid = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'
r = execute([uuid, 'abcdef12'])
check('full and short UUIDs are accepted', r.status_code == 200 and calls[-1][2:4] == [uuid, 'abcdef12'], json.dumps(calls))

# --- /reports/config ------------------------------------------------------
calls.clear()
r = client.post('/api/taskwarrior/reports/config', json={'reportName': 'rc.data.location=/x'})
check('/reports/config refuses an rc-looking report name', r.status_code == 400 and not calls, str(r.status_code))
r = client.post('/api/taskwarrior/reports/config', json={'reportName': 'next', 'dataPath': 'inst'})
check('/reports/config shows a real report', calls and calls[-1][-2:] == ['show', 'report.next'], json.dumps(calls))

failed = [name for name, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
