#!/usr/bin/env python3
"""
Guards the TaskWarrior argv-injection fix in backend/taskwarrior.py.

THE BUG: user-supplied strings were placed in positional argv slots of the
`task` CLI: the description of /add, the annotation of /annotate and
/denotate, and the task id/uuid filter of every per-task route. `task`
scans EVERY positional argument for rc overrides (rc.name=value, rc:path)
before it decides what the command is, so a description or uuid such as
"rc.data.location=/somewhere" was applied as configuration - the data
directory is created even when the command itself is then refused (verified
against task 3.x). Token-gated and local-only, but a hostile synced workflow
or a crafted request could redirect or clobber the user's task data.

THE FIX (mirrors taskwarrior(1)):
  - /add emits attributes first, then "--", then the description; /annotate
    and /denotate put "--" before the annotation. After "--" task treats
    everything as literal text. Attributes keep working because their
    attr: prefix already makes them attributes, never overrides; /modify's
    description already goes through the description: attribute.
  - the id/uuid position accepts only a numeric id, a full UUID or an 8-hex
    short uuid (400 otherwise) - applied to all eight per-task routes.

What this test proves against the REAL `task` CLI (throwaway rc + data dir,
Flask test client, real routes):
  - /add with description "rc.data.location=<dir>" creates a task with that
    LITERAL description and does NOT create/redirect the data location;
  - /add attributes (project, priority, due, tags) still land on the task;
  - /annotate and /denotate with rc-looking text are literal;
  - every per-task route rejects an rc-looking or malformed uuid with 400
    and nothing touches the CLI (no data dir created);
  - numeric ids, full UUIDs and short uuids are accepted and /modify,
  /done, /annotate work end to end.

Self-contained, no test framework: run with the backend venv interpreter.
Requires the TaskWarrior CLI (`task`) like taskwarrior_purge.test.py.

  backend/venv/bin/python tests/taskwarrior_argv_injection.test.py

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

if shutil.which('task') is None:
    print('TaskWarrior CLI (`task`) not found on PATH. Install it: brew install task / sudo apt install taskwarrior')
    sys.exit(1)
try:
    from flask import Flask
except ImportError:
    print('Missing dependency "flask". Run with the backend venv: backend/venv/bin/python tests/taskwarrior_argv_injection.test.py')
    sys.exit(1)

import taskwarrior as tw  # noqa: E402

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


root = tempfile.mkdtemp(prefix='tw-inject-')
data_dir = os.path.join(root, 'data')
os.makedirs(data_dir)
rc_path = os.path.join(root, 'taskrc')
with open(rc_path, 'w') as f:
    f.write(f'data.location={data_dir}\nconfirmation=off\nverbose=nothing\n')
evil = os.path.join(root, 'evil')  # must never be created


def export():
    out = subprocess.run(['task', f'rc:{rc_path}', f'rc.data.location={data_dir}', 'rc.verbose=nothing',
                          'rc.json.array=on', 'export'], capture_output=True, text=True)
    return json.loads(out.stdout or '[]')


app = Flask(__name__)
app.register_blueprint(tw.taskwarrior)
client = app.test_client()
base = {'rcPath': rc_path, 'dataPath': data_dir}


def post(route, **payload):
    return client.post(f'/api/taskwarrior/{route}', json={**base, **payload})


try:
    print('\n--- validator ---')
    for good in ['1', '42', '123456789', 'a1b2c3d4', 'A1B2C3D4', '3f2b6a0e-1b4c-4d2e-9f0a-1234567890ab', ' 7 ']:
        check(f'is_valid_task_id accepts {good!r}', tw.is_valid_task_id(good))
    for bad in ['rc.data.location=/x', 'rc:/etc/passwd', '-1', '1 2', '', None, 12, 'abc', 'g1b2c3d4', '1234567890',
                '3f2b6a0e-1b4c-4d2e-9f0a-1234567890ab;rm', '+tag', 'project:x']:
        check(f'is_valid_task_id rejects {bad!r}', not tw.is_valid_task_id(bad))

    print('\n--- /add ---')
    r = post('add', description=f'rc.data.location={evil}')
    check('/add with rc-looking description -> success', r.status_code == 200 and r.get_json()['success'], f'{r.status_code} {r.get_json()}')
    check('/add: evil data dir NOT created', not os.path.exists(evil))
    tasks = export()
    check('/add: description stored literally', any(t['description'] == f'rc.data.location={evil}' for t in tasks), str([t['description'] for t in tasks]))
    check('/add: task went into the real data dir', len(tasks) == 1 and os.path.exists(os.path.join(data_dir, 'taskchampion.sqlite3')) or any(n.endswith('.data') for n in os.listdir(data_dir)))

    r = post('add', description='rc.foo=bar -- plain words --verbose', project='proj1', priority='H', due='2030-01-01', tags=['alpha', 'beta'])
    check('/add with attributes + rc-looking words -> success', r.status_code == 200 and r.get_json()['success'], f'{r.status_code}')
    t = next((t for t in export() if t.get('project') == 'proj1'), None)
    check('/add: attributes applied before "--"', t is not None and t.get('priority') == 'H' and sorted(t.get('tags', [])) == ['alpha', 'beta'] and t.get('due'), str(t))
    check('/add: description literal incl. "--" and "--verbose"', t is not None and t['description'] == 'rc.foo=bar -- plain words --verbose', t and t['description'])
    check('/add: no stray dirs created under root', sorted(os.listdir(root)) == ['data', 'taskrc'], str(os.listdir(root)))

    print('\n--- per-task routes: uuid validation ---')
    uuid = t['uuid']
    for route, extra in [('modify', {'description': 'x'}), ('done', {}), ('start', {}), ('stop', {}),
                         ('annotate', {'annotation': 'n'}), ('denotate', {'annotation': 'n'}), ('delete', {}), ('purge', {})]:
        r = post(route, uuid=f'rc.data.location={evil}', **extra)
        check(f'/{route} with rc-looking uuid -> 400', r.status_code == 400 and 'UUID must be' in r.get_json()['error'], f'{r.status_code} {r.get_json()}')
    check('uuid-position injection: evil dir NOT created', not os.path.exists(evil))
    r = post('modify', uuid='', description='x')
    check('/modify with empty uuid -> 400 (unchanged)', r.status_code == 400 and 'required' in r.get_json()['error'])

    print('\n--- per-task routes: legitimate ids ---')
    r = post('annotate', uuid=uuid, annotation=f'rc.data.location={evil} note text')
    check('/annotate with rc-looking text -> success', r.status_code == 200 and r.get_json()['success'], f'{r.status_code} {r.get_json()}')
    t = next(t for t in export() if t['uuid'] == uuid)
    check('/annotate: annotation stored literally', [a['description'] for a in t.get('annotations', [])] == [f'rc.data.location={evil} note text'], str(t.get('annotations')))
    check('/annotate: evil dir NOT created', not os.path.exists(evil))
    r = post('denotate', uuid=uuid, annotation=f'rc.data.location={evil} note text')
    check('/denotate with rc-looking text -> success and removed', r.status_code == 200 and not next(t for t in export() if t['uuid'] == uuid).get('annotations'))
    r = post('modify', uuid=uuid[:8], description='renamed via short uuid')
    check('/modify with 8-hex short uuid -> success', r.status_code == 200 and r.get_json()['success'], f'{r.status_code} {r.get_json()}')
    check('/modify: description updated', next(t for t in export() if t['uuid'] == uuid)['description'] == 'renamed via short uuid')
    numeric = next(t for t in export() if t['uuid'] == uuid)['id']
    r = post('modify', uuid=str(numeric), project='proj2')
    check('/modify with numeric id -> success', r.status_code == 200 and next(t for t in export() if t['uuid'] == uuid).get('project') == 'proj2', f'{r.status_code}')
    r = post('done', uuid=uuid)
    check('/done with full uuid -> success', r.status_code == 200 and next(t for t in export() if t['uuid'] == uuid)['status'] == 'completed', f'{r.status_code}')
finally:
    shutil.rmtree(root, ignore_errors=True)

failed = [n for n, p in results if not p]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
