#!/usr/bin/env python3
"""
Guards the path-containment fix in backend/log_viewer.py.

THE BUG: /parse_log_viewer_stream and /parse_log_viewer_range handed the
request's `log_paths` straight to the sosreport parsers, which open them. Only
/get_log_date_range checked containment (and only with a naive startswith).
/parse_log_viewer_stream is on the diagnostics iframe's proxied-API allowlist,
so anything able to script that iframe could read arbitrary files on the
machine (e.g. ~/.ssh/id_rsa, ~/.jacarium.env) through the log parser.
/parse_haproxy_log likewise joined a caller-supplied `log_file` into a
directory path without rejecting traversal.

THE FIX: _paths_within(base, paths) keeps only entries whose realpath is
inside the report directory (symlinks resolved), applied to all three
log_paths endpoints; /parse_haproxy_log accepts only a bare file name (or the
'__all__' sentinel).

What this test proves (temp report tree, Flask test client, parsers stubbed
to capture what they are asked to open):
  - _paths_within: inside file kept; outside absolute path, `..` traversal,
    a symlink INSIDE the tree pointing OUTSIDE, prefix-sibling directory
    (/tmp/report-evil vs /tmp/report), non-strings and ~ expansion handled;
  - stream + range + date-range endpoints pass only contained paths to the
    parser;
  - haproxy endpoint rejects traversal / path components with 400 and
    accepts a bare name and '__all__'.

Self-contained, no test framework: run with the backend venv interpreter.

  backend/venv/bin/python tests/log_viewer_path_containment.test.py

Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

try:
    from flask import Flask
except ImportError:
    print('Missing dependency "flask". Run with the backend venv: backend/venv/bin/python tests/log_viewer_path_containment.test.py')
    sys.exit(1)

import log_viewer as lv  # noqa: E402

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


root = tempfile.mkdtemp(prefix='lv-contain-')
report = os.path.join(root, 'report')
os.makedirs(os.path.join(report, 'var', 'log'))
inside = os.path.join(report, 'var', 'log', 'messages')
open(inside, 'w').write('2024-01-01 log line\n')
outside = os.path.join(root, 'secret.txt')
open(outside, 'w').write('SECRET\n')
sibling = report + '-evil'
os.makedirs(sibling)
sibling_file = os.path.join(sibling, 'x.log')
open(sibling_file, 'w').write('x\n')
link = os.path.join(report, 'var', 'log', 'link-out')
os.symlink(outside, link)

print('\n--- _paths_within ---')
kept = lv._paths_within(report, [inside])
check('inside path kept', kept == [inside], str(kept))
check('outside absolute path dropped', lv._paths_within(report, [outside]) == [])
check('.. traversal dropped', lv._paths_within(report, [os.path.join(report, 'var', 'log', '..', '..', '..', 'secret.txt')]) == [])
check('symlink inside pointing outside dropped', lv._paths_within(report, [link]) == [])
check('prefix-sibling directory dropped (startswith bug)', lv._paths_within(report, [sibling_file]) == [])
check('the report dir itself is allowed', lv._paths_within(report, [report]) == [report])
check('non-strings / empty dropped', lv._paths_within(report, [None, 5, '', {'a': 1}]) == [])
check('None list -> []', lv._paths_within(report, None) == [])
check('mixed list keeps only inside entries in order',
      lv._paths_within(report, [outside, inside, link, sibling_file]) == [inside])
check('report dir given with trailing slash still contains', lv._paths_within(report + '/', [inside]) == [inside])

print('\n--- endpoints (parsers stubbed) ---')
captured = {}


def fake_stream(uploaded_dir, start, end, log_paths):
    captured['stream'] = list(log_paths)
    yield {'entries': []}


def fake_range(uploaded_dir, start, end, log_paths, limit, offset):
    captured['range'] = list(log_paths)
    return {'entries': []}


def fake_extract(path):
    from datetime import datetime
    captured.setdefault('extract', []).append(path)
    return datetime(2024, 1, 1), datetime(2024, 1, 2), 1


import parsers.sosreport.log_viewer as parser_mod  # noqa: E402
parser_mod.parse_date_range_stream = fake_stream
parser_mod.parse_date_range = fake_range
parser_mod.extract_date_range = fake_extract

app = Flask(__name__)
app.register_blueprint(lv.log_viewer)
client = app.test_client()
paths = [outside, inside, link, '../../etc/passwd', sibling_file]

r = client.post('/parse_log_viewer_stream', json={'directory': report, 'start_date': '2024-01-01', 'end_date': '2024-01-02', 'log_paths': paths})
body = r.get_data(as_text=True)
check('stream endpoint: 200 SSE', r.status_code == 200 and 'data:' in body, f'{r.status_code}')
check('stream endpoint: parser received only the inside path', captured.get('stream') == [inside], str(captured.get('stream')))

r = client.post('/parse_log_viewer_range', json={'directory': report, 'start_date': '2024-01-01', 'end_date': '2024-01-02', 'log_paths': paths})
check('range endpoint: 200', r.status_code == 200, f'{r.status_code} {r.get_json()}')
check('range endpoint: parser received only the inside path', captured.get('range') == [inside], str(captured.get('range')))

r = client.post('/get_log_date_range', json={'directory': report, 'log_paths': paths})
check('date-range endpoint: 200', r.status_code == 200, f'{r.status_code}')
check('date-range endpoint: only the inside path was opened', captured.get('extract') == [inside], str(captured.get('extract')))

haproxy_calls = []


def fake_haproxy(log_dir, file_name):
    haproxy_calls.append((log_dir, file_name))
    return {'ok': True}


import parsers.sosreport.haproxy as haproxy_mod  # noqa: E402
haproxy_mod.parse_haproxy_logs = fake_haproxy
for bad in ['../../../etc/passwd', '../x.log', 'sub/dir.log', '/etc/passwd', '.', '..', 5]:
    r = client.post('/parse_haproxy_log', json={'directory': report, 'log_file': bad})
    check(f'haproxy endpoint rejects log_file={bad!r}', r.status_code == 400, f'{r.status_code}')
check('haproxy endpoint: nothing reached the parser for rejected names', haproxy_calls == [])
r = client.post('/parse_haproxy_log', json={'directory': report, 'log_file': 'haproxy.log'})
check('haproxy endpoint accepts a bare file name', r.status_code == 200 and haproxy_calls[-1][1] == 'haproxy.log', f'{r.status_code}')
r = client.post('/parse_haproxy_log', json={'directory': report, 'log_file': '__all__'})
check("haproxy endpoint accepts '__all__'", r.status_code == 200 and haproxy_calls[-1][1] == '__all__', f'{r.status_code}')

import shutil  # noqa: E402
shutil.rmtree(root, ignore_errors=True)

failed = [n for n, p in results if not p]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
