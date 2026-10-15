#!/usr/bin/env python3
"""
Guards against two bugs in backend/taskwarrior.py's POST /api/taskwarrior/purge-deleted
(purge_deleted_tasks), which is supposed to permanently remove every soft-deleted task.

1. WRONG VERB (the real bug - it never purged anything). The route ran
   `task rc.confirmation=off <uuid> delete`. In TaskWarrior, `delete` transitions a task
   *to* status=deleted; run against a task that is ALREADY deleted it refuses with
   "Task <id> '<desc>' is not deletable." and reports "Deleted 0 tasks."  So the route
   reported purged_count = N while removing nothing - the deleted tasks were all still
   in the database afterwards. The correct verb is `purge`, which taskwarrior(1)
   documents as "Permanently removes the specified tasks from the data files. Only tasks
   that are already deleted can be purged." The sibling single-task /purge route in the
   same file already used `purge` correctly; only this route was wrong.

2. ONE SUBPROCESS PER TASK. The route looped over the deleted tasks and spawned a
   separate `task` CLI process for each one - hundreds of process spawns for what
   TaskWarrior can do in a single invocation, since it ORs together multiple IDs/UUIDs
   given in the filter position. The fix collects the UUIDs and issues ONE command:
   `task [rc:...] [rc.data.location=...] rc.confirmation=off rc.bulk=0 <uuid...> purge`.

3. THE BULK PROMPT (only reachable once (2) batches the call). taskrc(5) `bulk` defaults
   to 3: "When this number or greater of tasks are modified in a single command,
   confirmation will be required, REGARDLESS of the value of confirmation variable."
   So a batched purge of >= 3 tasks prompts "Permanently remove task X? (yes/no/all/quit)"
   even with rc.confirmation=off. run_task_command() inherits stdin, so the prompt is
   answered by whatever stdin holds (EOF -> abort): the command returns success with the
   prompt as its stdout and purges NOTHING. `rc.bulk=0` means infinity, disabling it.
   This is why the test below deletes exactly 3 tasks - one or two would not trip it.

This test is self-contained with NO test framework:
  - creates its OWN temporary TASKDATA dir + taskrc (never touches real task data),
  - adds real tasks and soft-deletes some of them via the real `task` CLI,
  - calls the REAL Flask route through a test client (blueprint mounted on a bare app,
    so no backend auth middleware is involved),
  - asserts purged_count / remaining_tasks / message are the documented shape,
  - asserts via a fresh `task status:deleted export` that the tasks are ACTUALLY gone,
  - asserts the non-deleted tasks were left untouched,
  - counts `task` process spawns (by shimming subprocess.run) to prove the purge is
    batched into a single invocation rather than one per task,
  - covers the edge cases: nothing to purge, and exported tasks with no uuid field.

Run:  backend/venv/bin/python tests/taskwarrior_purge.test.py
Requires: TaskWarrior installed (`task --version`; developed against 3.4.2).
          `purge` requires TaskWarrior >= 2.5.2.
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


# ---------- precondition checks ----------
TASK_BIN = shutil.which('task')
if not TASK_BIN:
    print('TaskWarrior is not installed ("task" not on PATH).')
    print('Install it with: brew install task  (macOS) / sudo apt install taskwarrior (Debian)')
    sys.exit(1)
try:
    import flask  # noqa: F401
except ImportError:
    print('Missing dependency "flask". Run with the backend venv:')
    print('  backend/venv/bin/python tests/taskwarrior_purge.test.py')
    sys.exit(1)

from flask import Flask

TASK_VERSION = subprocess.run([TASK_BIN, '--version'], capture_output=True, text=True).stdout.strip()
print('taskwarrior: %s (%s)' % (TASK_VERSION, TASK_BIN))

WORKDIR = tempfile.mkdtemp(prefix='taskwarrior-purge-test-')
DATA_DIR = os.path.join(WORKDIR, 'data')
TASKRC = os.path.join(WORKDIR, 'taskrc')
os.makedirs(DATA_DIR, exist_ok=True)
with open(TASKRC, 'w') as fh:
    # Keep the sandbox hermetic: no hooks, no context, no colour/paging noise.
    fh.write('data.location=%s\n' % DATA_DIR)
    fh.write('confirmation=no\n')
    fh.write('hooks=0\n')
    fh.write('verbose=nothing\n')
print('temp task data: %s' % WORKDIR)


def task_cli(*args):
    """Run the real task CLI against the sandbox only."""
    return subprocess.run(
        [TASK_BIN, 'rc:' + TASKRC, 'rc.data.location=' + DATA_DIR] + list(args),
        capture_output=True, text=True, stdin=subprocess.DEVNULL,
    )


def export(*filters):
    out = task_cli(*(list(filters) + ['export'])).stdout.strip()
    return json.loads(out) if out else []


exit_code = 1
try:
    import taskwarrior as tw_module

    app = Flask(__name__)
    app.register_blueprint(tw_module.taskwarrior)
    client = app.test_client()

    def purge_deleted():
        resp = client.post('/api/taskwarrior/purge-deleted',
                           json={'rcPath': TASKRC, 'dataPath': DATA_DIR})
        return resp, resp.get_json()

    # ---------- scenario: 5 tasks, soft-delete 3 ----------
    for desc in ['alpha', 'bravo', 'charlie', 'delta', 'echo']:
        task_cli('add', desc)
    all_tasks = export()
    check('sandbox has 5 tasks', len(all_tasks) == 5, len(all_tasks))

    doomed = [t['uuid'] for t in all_tasks if t['description'] in ('alpha', 'charlie', 'echo')]
    for uuid in doomed:
        task_cli('rc.confirmation=off', uuid, 'delete')
    check('3 tasks are soft-deleted (status=deleted)', len(export('status:deleted')) == 3,
          len(export('status:deleted')))
    check('2 tasks remain active', len(export('status.not:deleted')) == 2,
          len(export('status.not:deleted')))

    # ---------- count `task` spawns so we can prove the purge is batched ----------
    real_run = subprocess.run
    spawns = []

    def counting_run(cmd, *a, **kw):
        if isinstance(cmd, (list, tuple)):
            spawns.append(list(cmd))
        return real_run(cmd, *a, **kw)

    tw_module.subprocess.run = counting_run
    try:
        resp, body = purge_deleted()
    finally:
        tw_module.subprocess.run = real_run

    # ---------- response shape (must not have changed) ----------
    check('route returns HTTP 200', resp.status_code == 200, resp.status_code)
    check('response success is True', body.get('success') is True, body)
    check('purged_count == 3', body.get('purged_count') == 3, body.get('purged_count'))
    check('remaining_tasks == 2', body.get('remaining_tasks') == 2, body.get('remaining_tasks'))
    check('message field preserved', body.get('message') == 'Purged 3 deleted tasks', body.get('message'))
    check('response keys unchanged',
          set(body.keys()) == {'success', 'purged_count', 'remaining_tasks', 'message'}, sorted(body.keys()))

    # ---------- THE bug: the tasks must actually be gone ----------
    still_deleted = export('status:deleted')
    check('deleted tasks are ACTUALLY purged from the database (not just reported)',
          len(still_deleted) == 0, '%d still present: %s' % (
              len(still_deleted), [t.get('description') for t in still_deleted]))
    survivors = sorted(t['description'] for t in export())
    check('active tasks untouched by the purge', survivors == ['bravo', 'delta'], survivors)

    # ---------- batching: one purge invocation, not one per task ----------
    purge_cmds = [c for c in spawns if 'purge' in c]
    delete_cmds = [c for c in spawns if c and c[-1] == 'delete']
    check('purge issued exactly ONE task invocation for all 3 uuids',
          len(purge_cmds) == 1, '%d purge invocation(s): %s' % (len(purge_cmds), purge_cmds))
    check('no per-task `delete` invocations remain', not delete_cmds, delete_cmds)
    if purge_cmds:
        cmd = purge_cmds[0]
        check('purge command uses the `purge` verb last', cmd[-1] == 'purge', ' '.join(cmd[-2:]))
        check('purge command passes rc.confirmation=off', 'rc.confirmation=off' in cmd, ' '.join(cmd))
        check('purge command passes rc.bulk=0 (bulk prompt ignores confirmation=off)',
              'rc.bulk=0' in cmd, ' '.join(cmd))
        check('all 3 uuids are in the single purge command',
              all(u in cmd for u in doomed), ' '.join(cmd))
        check('uuids sit between the rc overrides and the verb',
              cmd.index('rc.confirmation=off') < min(cmd.index(u) for u in doomed) < cmd.index('purge'),
              ' '.join(cmd))

    # ---------- edge case: nothing to purge ----------
    spawns.clear()
    tw_module.subprocess.run = counting_run
    try:
        resp2, body2 = purge_deleted()
    finally:
        tw_module.subprocess.run = real_run
    check('purging with zero deleted tasks succeeds', body2.get('success') is True, body2)
    check('purged_count is 0 when nothing is deleted', body2.get('purged_count') == 0, body2.get('purged_count'))
    check('remaining_tasks still correct when nothing is deleted',
          body2.get('remaining_tasks') == 2, body2.get('remaining_tasks'))
    check('no purge command issued when there is nothing to purge',
          not [c for c in spawns if 'purge' in c], [c for c in spawns if 'purge' in c])

    # ---------- edge case: exported task with no uuid is skipped, not crashed on ----------
    real_rtc = tw_module.run_task_command
    issued = []

    def fake_rtc(args, **kw):
        issued.append(list(args))
        if args[-1] == 'export' and 'status:deleted' in args:
            return {'success': True, 'output': json.dumps([
                {'description': 'no-uuid-here'},          # missing uuid entirely
                {'uuid': '', 'description': 'empty'},     # falsy uuid
            ])}
        if args[-1] == 'export':
            return {'success': True, 'output': '[]'}
        if args[-1] == 'count':
            return {'success': True, 'output': '2\n'}
        return {'success': True, 'output': ''}

    tw_module.run_task_command = fake_rtc
    try:
        resp3, body3 = purge_deleted()
    finally:
        tw_module.run_task_command = real_rtc
    check('uuid-less tasks do not crash the route', body3.get('success') is True, body3)
    check('uuid-less tasks are silently skipped (no purge command built)',
          not [a for a in issued if 'purge' in a], [a for a in issued if 'purge' in a])

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
