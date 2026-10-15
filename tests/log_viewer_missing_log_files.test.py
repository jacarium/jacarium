#!/usr/bin/env python3
"""
Guards the missing-log-file handling in the sosreport Log Viewer parser
(backend/parsers/sosreport/log_viewer.py, parse()).

THE BUG: opening the Diagnostics page's Log Viewer tab (POST /load_tab)
answered HTTP 500 with "[Errno 2] No such file or directory:
'.../var/log/containers/<name>.log'". parse() walks var/log with os.walk(),
which lists a dangling symlink as a file, and then called os.path.getsize()
on every entry. sosreports routinely contain such links:
var/log/containers/*.log are symlinks into var/log/pods/... which the
collector does not always capture. The FileNotFoundError escaped parse(),
load_tab() turned it into a 500, and the whole tab - including every log
file that WAS readable - became unusable. The same unguarded getsize() sat
in the sos_commands journalctl walk.

THE FIX: _readable_file_size() returns None for anything that is not a
readable regular file; such entries are listed under a new
`unavailable_logs` key (name/path/type) instead of aborting, and the tab
template shows them as "N log files unavailable (not captured in this
report)" in the Log Files dropdown.

What this test proves (temp report tree with made-up names only, Flask
test client rendering the REAL tab template):
  - _readable_file_size: real file -> size; dangling symlink, missing path
    and directory -> None;
  - parse() on a tree with a dangling var/log/containers link and a
    dangling journalctl link does not raise, lists the readable files under
    available_logs and the dangling ones under unavailable_logs;
  - POST /load_tab for the log_viewer tab answers 200 with the rendered
    fragment naming the readable file and the unavailable-files note;
  - a tree with no dangling links yields an empty unavailable_logs and no
    note in the fragment (no regression for the common case).

Self-contained, no test framework: run with the backend venv interpreter.

  backend/venv/bin/python tests/log_viewer_missing_log_files.test.py

Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

try:
    from flask import Flask
except ImportError:
    print('Missing dependency "flask". Run with the backend venv: backend/venv/bin/python tests/log_viewer_missing_log_files.test.py')
    sys.exit(1)

import log_viewer as lv  # noqa: E402
import parsers.sosreport.log_viewer as parser_mod  # noqa: E402

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)


def make_report(root, with_dangling):
    """A sosreport-shaped tree. All names are synthetic."""
    report = os.path.join(root, 'report')
    write(os.path.join(report, 'sos_commands', 'logs', 'journalctl_--no-pager'),
          'Jan 02 03:04:05 example-host example-proc[1]: synthetic entry one\n'
          'Jan 02 03:04:06 example-host example-proc[1]: synthetic entry two\n')
    write(os.path.join(report, 'var', 'log', 'example-app.log'),
          'synthetic application log line\n')
    if with_dangling:
        # var/log/containers/<pod>_<ns>_<container>-<id>.log -> ../pods/... that was never collected
        containers = os.path.join(report, 'var', 'log', 'containers')
        os.makedirs(containers)
        os.symlink(os.path.join('..', 'pods', 'example-ns_example-pod_0000', 'example-container', '0.log'),
                   os.path.join(containers, 'example-pod_example-ns_example-container-0000.log'))
        # A dangling per-unit journalctl capture as well
        os.symlink(os.path.join('..', 'missing', 'journalctl_--no-pager_-u_example-unit'),
                   os.path.join(report, 'sos_commands', 'logs', 'journalctl_--no-pager_-u_example-unit'))
    return report


root = tempfile.mkdtemp(prefix='lv-missing-')
try:
    report = make_report(os.path.join(root, 'a'), with_dangling=True)
    dangling_container = os.path.join(report, 'var', 'log', 'containers', 'example-pod_example-ns_example-container-0000.log')
    dangling_journal = os.path.join(report, 'sos_commands', 'logs', 'journalctl_--no-pager_-u_example-unit')
    real_app_log = os.path.join(report, 'var', 'log', 'example-app.log')

    print('\n--- fixture sanity ---')
    check('container link is dangling (os.path.exists False, islink True)',
          os.path.islink(dangling_container) and not os.path.exists(dangling_container))
    raised = False
    try:
        os.path.getsize(dangling_container)
    except OSError:
        raised = True
    check('os.path.getsize on the dangling link raises (what the old code did)', raised)

    print('\n--- _readable_file_size ---')
    check('real file -> its size', parser_mod._readable_file_size(real_app_log) == os.path.getsize(real_app_log))
    check('dangling symlink -> None', parser_mod._readable_file_size(dangling_container) is None)
    check('missing path -> None', parser_mod._readable_file_size(os.path.join(report, 'nope.log')) is None)
    check('directory -> None', parser_mod._readable_file_size(os.path.join(report, 'var', 'log')) is None)

    print('\n--- parse() with dangling links ---')
    data = None
    error = None
    try:
        data = parser_mod.parse(report)
    except Exception as e:  # noqa: BLE001
        error = e
    check('parse() does not raise', error is None, repr(error))
    if data is not None:
        avail = {log['name']: log for log in data['available_logs']}
        unavail = {log['name']: log for log in data.get('unavailable_logs', [])}
        check('readable app log listed as available', 'example-app.log' in avail and avail['example-app.log']['size'] > 0, str(sorted(avail)))
        check('main journalctl listed as available (system)', avail.get('journalctl (system)', {}).get('type') == 'system')
        check('dangling container log NOT in available_logs',
              'containers/example-pod_example-ns_example-container-0000.log' not in avail)
        check('dangling container log listed as unavailable with its path',
              unavail.get('containers/example-pod_example-ns_example-container-0000.log', {}).get('path') == dangling_container,
              str(sorted(unavail)))
        check('dangling journalctl capture listed as unavailable',
              unavail.get('journalctl (u_example-unit)', {}).get('type') == 'journal', str(sorted(unavail)))
        check('unavailable entries carry no size (nothing to stat)',
              all('size' not in log for log in data['unavailable_logs']))
        check('every available entry has a size', all(isinstance(log['size'], int) for log in data['available_logs']))

    print('\n--- POST /load_tab renders the real template ---')
    app = Flask(__name__, template_folder=os.path.join(BACKEND, 'templates'))
    app.register_blueprint(lv.log_viewer)
    client = app.test_client()
    lv.parsed_cache.clear()

    r = client.post('/load_tab', json={'report_type': 'sosreport', 'tab': 'log_viewer', 'directory': report})
    body = r.get_json() or {}
    check('load_tab answers 200 (was 500)', r.status_code == 200, f'{r.status_code} {body.get("error")}')
    html = body.get('html', '')
    check('fragment lists the readable log file', 'example-app.log' in html)
    check('fragment shows the unavailable-files note with the count',
          'id="log-file-unavailable"' in html and '2 log files unavailable' in html)
    check('fragment names the unavailable files in the note tooltip',
          'containers/example-pod_example-ns_example-container-0000.log' in html)
    check('dangling file is not offered as a selectable checkbox',
          f'data-path="{dangling_container}"' not in html)

    r = client.post('/get_tab_data', json={'report_type': 'sosreport', 'tab': 'log_viewer', 'directory': report})
    payload = (r.get_json() or {}).get('data') or {}
    check('get_tab_data answers 200 and carries unavailable_logs',
          r.status_code == 200 and len(payload.get('unavailable_logs', [])) == 2, f'{r.status_code}')

    print('\n--- clean tree: no unavailable entries, no note ---')
    clean = make_report(os.path.join(root, 'b'), with_dangling=False)
    lv.parsed_cache.clear()
    data = parser_mod.parse(clean)
    check('clean tree -> unavailable_logs is an empty list', data.get('unavailable_logs') == [])
    r = client.post('/load_tab', json={'report_type': 'sosreport', 'tab': 'log_viewer', 'directory': clean})
    html = (r.get_json() or {}).get('html', '')
    check('clean tree -> 200 and no unavailable note in the fragment',
          r.status_code == 200 and 'id="log-file-unavailable"' not in html, f'{r.status_code}')
finally:
    shutil.rmtree(root, ignore_errors=True)

failed = [n for n, p in results if not p]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
