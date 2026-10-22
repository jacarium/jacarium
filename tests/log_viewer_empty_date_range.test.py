#!/usr/bin/env python3
"""
Guards the Log Viewer tab against an unknown initial date range and against
the journalctl capture being unreadable or spelled with a doubled separator
(backend/parsers/sosreport/log_viewer.py parse() / extract_date_range(),
backend/templates/tabs/sosreport_log_viewer.html).

THE BUG: after unreadable log files started being skipped instead of failing
load_tab, the tab crashed one step later with

    <span id="date-start-label">{{ data.date_range.start[:10] }}</span>
    TypeError: 'NoneType' object is not subscriptable

parse() only ever set date_range from sos_commands/logs/journalctl_--no-pager.
The user's report simply had NO journal capture at all; other var/log files
still populated available_logs, so the template took the "has logs" branch
and sliced None. The same happened when the capture was a directory /
dangling symlink or had no parseable timestamps, and a doubled-separator
spelling (journalctl__--no-pager) was missed by the literal comparisons.
os.path.exists() also let a DIRECTORY at that path through to the parsers,
which printed a full traceback ("Is a directory") before the TypeError. The
"Failed to read <journal path>: [Errno 2] No such file or directory" console
line comes from the Kernel OOM Killer tab's parser
(backend/parsers/sosreport/kernel_oom_killer.py) opening the same
hard-coded path; it never raised, it was just alarming wording.

THE FIX: _find_main_journal() matches journalctl_+--no-pager and lists an
unreadable main capture under unavailable_logs; the journal walk uses the
same pattern; _initial_date_range() tries the system journal first and falls
back to every other readable log; extract_date_range() answers (None, None,
0) with one log line for anything that is not a readable regular file; the
template renders "unknown" labels and passes null (via tojson) to the JS,
which treats an unknown range as a single point and asks for "Get Date
Range" before loading.

What this test proves (temp report trees with made-up names only, Flask test
client rendering the REAL tab template):
  - every candidate unreadable (journal is a directory, app log dangling) ->
    parse() does not raise, date_range is None/None, /load_tab answers 200
    with the empty state and the unavailable count, no Traceback printed;
  - readable logs without timestamps -> 200, labels read "unknown", the JS
    receives null (never the string 'None');
  - journalctl__--no-pager (double underscore) is found, listed once as the
    system journal and drives the date range; its per-unit siblings are
    listed as journal logs with the right suffix;
  - mixed readable/unreadable -> date range spans the readable files only
    (journal-style + container-style timestamps), /get_log_date_range skips
    a directory path without a traceback and answers from the readable file;
  - the canonical layout still yields the same range as before (no regression).

Self-contained, no test framework: run with the backend venv interpreter.

  backend/venv/bin/python tests/log_viewer_empty_date_range.test.py

Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import contextlib
import io
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

try:
    from flask import Flask
except ImportError:
    print('Missing dependency "flask". Run with the backend venv: backend/venv/bin/python tests/log_viewer_empty_date_range.test.py')
    sys.exit(1)

import log_viewer as lv  # noqa: E402
import parsers.sosreport.log_viewer as parser_mod  # noqa: E402

results = []
YEAR = datetime.now().year


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)


JOURNAL_TEXT = (
    'Jan 02 03:04:05 example-host example-proc[1]: synthetic entry one\n'
    'Jan 02 03:04:06 example-host example-proc[1]: synthetic entry two\n'
    'Jan 03 04:05:06 example-host example-proc[1]: synthetic entry three\n'
)
CONTAINER_TEXT = (
    f'{YEAR}-03-05T10:00:00.000000000+00:00 stdout F synthetic container line one\n'
    f'{YEAR}-03-06T11:00:00.000000000+00:00 stdout F synthetic container line two\n'
)


def new_report(name):
    """Report root with a second top-level entry, like every real sosreport:
    parse() descends into a lone top-level directory (archive wrapper dir), so
    a fixture with only sos_commands/ or only var/ would be mis-rooted."""
    report = os.path.join(root, name, 'report')
    write(os.path.join(report, 'version.txt'), 'sosreport: synthetic fixture\n')
    return report


def parse_quiet(report):
    """parse() with captured stdout so the checks can assert on the log lines."""
    buf = io.StringIO()
    error = None
    data = None
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        try:
            data = parser_mod.parse(report)
        except Exception as e:  # noqa: BLE001
            error = e
    return data, error, buf.getvalue()


def make_app():
    app = Flask(__name__, template_folder=os.path.join(BACKEND, 'templates'))
    app.register_blueprint(lv.log_viewer)
    return app.test_client()


def load_tab(client, report):
    lv.parsed_cache.clear()
    r = client.post('/load_tab', json={'report_type': 'sosreport', 'tab': 'log_viewer', 'directory': report})
    body = r.get_json() or {}
    return r.status_code, body.get('html', ''), body.get('error')


def label(html, which):
    m = re.search(rf'<span id="date-{which}-label">([^<]*)</span>', html)
    return m.group(1) if m else None


def js_const(html, name):
    m = re.search(rf'const {name} = (.*?);', html)
    return m.group(1) if m else None


root = tempfile.mkdtemp(prefix='lv-daterange-')
client = make_app()
try:
    # ------------------------------------------------------------------
    print('\n--- 1. every candidate log unreadable ---')
    report = new_report('all-unreadable')
    # The main journal capture is a DIRECTORY, not a file (extraction quirk)
    os.makedirs(os.path.join(report, 'sos_commands', 'logs', 'journalctl_--no-pager'))
    # The only var/log candidate is a dangling symlink
    containers = os.path.join(report, 'var', 'log', 'containers')
    os.makedirs(containers)
    os.symlink(os.path.join('..', 'pods', 'example-ns_example-pod_0000', 'example-container', '0.log'),
               os.path.join(containers, 'example-pod_example-ns_example-container-0000.log'))

    data, error, out = parse_quiet(report)
    check('parse() does not raise', error is None, repr(error))
    check('no traceback printed while parsing', 'Traceback' not in out and 'Is a directory' not in out, out.strip()[-200:])
    if data is not None:
        check('available_logs is empty', data['available_logs'] == [], str(data['available_logs']))
        names = sorted(log['name'] for log in data['unavailable_logs'])
        check('journal directory and dangling link listed as unavailable',
              names == ['containers/example-pod_example-ns_example-container-0000.log', 'journalctl (system)'], str(names))
        check('date_range is a consistent {start: None, end: None}',
              data['date_range'] == {'start': None, 'end': None}, str(data['date_range']))
        check('total_lines is 0', data['total_lines'] == 0)

    status, html, err = load_tab(client, report)
    check('POST /load_tab answers 200 (was 500 TypeError)', status == 200, f'{status} {err}')
    check('fragment shows the empty state', 'No Readable Log Files Found' in html)
    check('fragment reports the unavailable count', '2 log files present but unavailable' in html)
    check("rendered fragment never contains the string 'None'", "'None'" not in html and '>None<' not in html)

    # ------------------------------------------------------------------
    print('\n--- 2. readable logs but no parseable timestamps ---')
    report = new_report('no-timestamps')
    write(os.path.join(report, 'var', 'log', 'example-app.log'),
          'synthetic line without a timestamp\nanother synthetic line\n')

    data, error, out = parse_quiet(report)
    check('parse() does not raise', error is None, repr(error))
    if data is not None:
        check('the app log is available', [log['name'] for log in data['available_logs']] == ['example-app.log'])
        check('date_range stays None/None', data['date_range'] == {'start': None, 'end': None}, str(data['date_range']))

    status, html, err = load_tab(client, report)
    check('POST /load_tab answers 200', status == 200, f'{status} {err}')
    check('start/end labels read "unknown"', label(html, 'start') == 'unknown' and label(html, 'end') == 'unknown',
          f'{label(html, "start")!r} {label(html, "end")!r}')
    check('JS receives null for the bounds (not the string None)',
          js_const(html, 'minDateStr') == 'null' and js_const(html, 'maxDateStr') == 'null',
          f'{js_const(html, "minDateStr")!r} {js_const(html, "maxDateStr")!r}')
    check('the log list is still rendered (tab is usable)', 'data-name="example-app.log"' in html)

    # ------------------------------------------------------------------
    print('\n--- 3. journalctl__--no-pager (double underscore) ---')
    report = new_report('double-underscore')
    main_path = os.path.join(report, 'sos_commands', 'logs', 'journalctl__--no-pager')
    unit_path = os.path.join(report, 'sos_commands', 'logs', 'journalctl__--no-pager_-u_example-unit')
    write(main_path, JOURNAL_TEXT)
    write(unit_path, JOURNAL_TEXT)

    check('_find_main_journal resolves the double-underscore spelling',
          parser_mod._find_main_journal(report) == main_path, str(parser_mod._find_main_journal(report)))

    data, error, out = parse_quiet(report)
    check('parse() does not raise', error is None, repr(error))
    if data is not None:
        by_path = {log['path']: log for log in data['available_logs']}
        check('listed exactly once as the system journal',
              by_path.get(main_path, {}).get('type') == 'system'
              and sum(1 for log in data['available_logs'] if log['path'] == main_path) == 1,
              str(sorted(by_path)))
        check('system entry keeps the display name journalctl (system)', by_path.get(main_path, {}).get('name') == 'journalctl (system)')
        check('per-unit sibling listed as journal with the suffix',
              by_path.get(unit_path, {}).get('type') == 'journal'
              and by_path[unit_path]['name'] == 'journalctl (u_example-unit)', str(by_path.get(unit_path)))
        check('nothing listed as unavailable', data['unavailable_logs'] == [])
        check('date range comes from the journal',
              (data['date_range']['start'] or '').startswith(f'{YEAR}-01-02T03:04:05')
              and (data['date_range']['end'] or '').startswith(f'{YEAR}-01-03T04:05:06'), str(data['date_range']))
        check('total_lines estimated (> 0)', data['total_lines'] > 0, str(data['total_lines']))

    status, html, err = load_tab(client, report)
    check('POST /load_tab answers 200 with real labels', status == 200 and label(html, 'start') == f'{YEAR}-01-02', f'{status} {label(html, "start")}')
    check('system journal is pre-checked in the dropdown',
          re.search(rf'data-path="{re.escape(main_path)}"[^>]*checked', html) is not None)

    # Default log_paths for the stream/range parsers also resolve to it
    entries_from_default = parser_mod.parse_date_range(report, f'{YEAR}-01-01T00:00', f'{YEAR}-12-31T23:59')
    check('parse_date_range default log path uses the double-underscore journal',
          entries_from_default.get('total_count', 0) == 3 or len(entries_from_default.get('entries', [])) == 3,
          str({k: v for k, v in entries_from_default.items() if k != 'entries'}))

    # ------------------------------------------------------------------
    print('\n--- 4. mixed readable / unreadable ---')
    report = new_report('mixed')
    journal_dir = os.path.join(report, 'sos_commands', 'logs', 'journalctl_--no-pager')
    os.makedirs(journal_dir)  # unreadable: a directory
    syslog_style = os.path.join(report, 'var', 'log', 'example-app.log')
    write(syslog_style, JOURNAL_TEXT)  # falls back to the journalctl-style parser
    container_log = os.path.join(report, 'var', 'log', 'containers', 'example-pod_example-ns_example-container-0000.log')
    write(container_log, CONTAINER_TEXT)
    os.symlink(os.path.join('..', 'missing', 'journalctl_--no-pager_-u_example-unit'),
               os.path.join(report, 'sos_commands', 'logs', 'journalctl_--no-pager_-u_example-unit'))

    data, error, out = parse_quiet(report)
    check('parse() does not raise', error is None, repr(error))
    check('no traceback printed for the directory / dangling link', 'Traceback' not in out, out.strip()[-200:])
    if data is not None:
        avail = sorted(log['name'] for log in data['available_logs'])
        unavail = sorted(log['name'] for log in data['unavailable_logs'])
        check('readable files available', avail == ['containers/example-pod_example-ns_example-container-0000.log', 'example-app.log'], str(avail))
        check('directory journal and dangling unit capture unavailable',
              unavail == ['journalctl (system)', 'journalctl (u_example-unit)'], str(unavail))
        check('date range start = earliest readable timestamp (syslog-style, Jan 02)',
              (data['date_range']['start'] or '').startswith(f'{YEAR}-01-02T03:04:05'), str(data['date_range']))
        check('date range end = latest readable timestamp (container, Mar 06)',
              (data['date_range']['end'] or '').startswith(f'{YEAR}-03-06T11:00:00'), str(data['date_range']))

    status, html, err = load_tab(client, report)
    check('POST /load_tab answers 200 with the computed labels',
          status == 200 and label(html, 'start') == f'{YEAR}-01-02' and label(html, 'end') == f'{YEAR}-03-06',
          f'{status} {label(html, "start")} {label(html, "end")}')

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        rng = parser_mod.extract_date_range(journal_dir)
    check('extract_date_range(directory) -> (None, None, 0) without a traceback',
          rng == (None, None, 0) and 'Traceback' not in buf.getvalue(), f'{rng} {buf.getvalue().strip()[-120:]}')

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        r = client.post('/get_log_date_range', json={'directory': report, 'log_paths': [journal_dir, container_log]})
    body = r.get_json() or {}
    check('/get_log_date_range skips the directory and answers from the readable file',
          r.status_code == 200 and (body.get('date_range') or {}).get('start', '').startswith(f'{YEAR}-03-05'),
          f'{r.status_code} {body}')
    check('/get_log_date_range printed no traceback', 'Traceback' not in buf.getvalue())

    # ------------------------------------------------------------------
    print('\n--- 5. canonical layout unchanged ---')
    report = new_report('canonical')
    write(os.path.join(report, 'sos_commands', 'logs', 'journalctl_--no-pager'), JOURNAL_TEXT)
    write(os.path.join(report, 'sos_commands', 'logs', 'journalctl_--no-pager_-u_example-unit'), JOURNAL_TEXT)
    write(os.path.join(report, 'var', 'log', 'containers', 'example-pod_example-ns_example-container-0000.log'), CONTAINER_TEXT)
    data, error, out = parse_quiet(report)
    check('parse() does not raise', error is None, repr(error))
    if data is not None:
        check('system journal alone decides the range (container dates not merged in)',
              (data['date_range']['start'] or '').startswith(f'{YEAR}-01-02')
              and (data['date_range']['end'] or '').startswith(f'{YEAR}-01-03'), str(data['date_range']))
        names = sorted((log['name'], log['type']) for log in data['available_logs'])
        check('system, journal and application entries listed once each',
              names == [('containers/example-pod_example-ns_example-container-0000.log', 'application'),
                        ('journalctl (system)', 'system'),
                        ('journalctl (u_example-unit)', 'journal')], str(names))
    status, html, err = load_tab(client, report)
    check('POST /load_tab answers 200 and labels the journal range', status == 200 and label(html, 'start') == f'{YEAR}-01-02', f'{status}')

    # ------------------------------------------------------------------
    print('\n--- 6. no journal capture at all, readable var/log logs with timestamps ---')
    report = new_report('no-journal-with-logs')
    write(os.path.join(report, 'sos_commands', 'logs', 'other_command'), 'synthetic output\n')  # logs/ exists, no journalctl
    syslog_style = os.path.join(report, 'var', 'log', 'example-app.log')
    write(syslog_style, JOURNAL_TEXT)
    container_log = os.path.join(report, 'var', 'log', 'containers', 'example-pod_example-ns_example-container-0000.log')
    write(container_log, CONTAINER_TEXT)
    missing_journal = os.path.join(report, 'sos_commands', 'logs', 'journalctl_--no-pager')

    check('_find_main_journal -> None', parser_mod._find_main_journal(report) is None)
    data, error, out = parse_quiet(report)
    check('parse() does not raise', error is None, repr(error))
    check('nothing printed about a failed read or a traceback',
          'Traceback' not in out and 'Failed to' not in out and 'No such file' not in out, out.strip()[-200:])
    if data is not None:
        types = sorted(log['type'] for log in data['available_logs'])
        check('both var/log files available, no system entry', types == ['application', 'application'], str(types))
        check('nothing listed as unavailable (a missing journal is not an unavailable file)', data['unavailable_logs'] == [])
        check('date range spans the var/log files',
              (data['date_range']['start'] or '').startswith(f'{YEAR}-01-02T03:04:05')
              and (data['date_range']['end'] or '').startswith(f'{YEAR}-03-06T11:00:00'), str(data['date_range']))

    status, html, err = load_tab(client, report)
    check('POST /load_tab answers 200 with labels from var/log',
          status == 200 and label(html, 'start') == f'{YEAR}-01-02' and label(html, 'end') == f'{YEAR}-03-06',
          f'{status} {label(html, "start")} {label(html, "end")}')
    check('no checkbox pre-checked (only the system journal is auto-selected)',
          re.search(r'class="log-file-checkbox"[^>]*checked', html) is None)
    check('the missing journal path is not offered anywhere in the fragment', missing_journal not in html)

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        r = client.post('/get_log_date_range', json={'directory': report, 'log_paths': [syslog_style, container_log]})
    body = r.get_json() or {}
    check('Get Date Range over the var/log files answers 200 with the merged range',
          r.status_code == 200 and (body.get('date_range') or {}).get('start', '').startswith(f'{YEAR}-01-02')
          and body['date_range']['end'].startswith(f'{YEAR}-03-06'), f'{r.status_code} {body}')

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        r = client.post('/parse_log_viewer_stream', json={
            'directory': report, 'log_paths': [syslog_style, container_log],
            'start_date': f'{YEAR}-01-01T00:00', 'end_date': f'{YEAR}-12-31T23:59'})
        stream_body = r.get_data(as_text=True)
    check('Load Logs (stream) over the var/log files answers 200 and completes',
          r.status_code == 200 and '"done": true' in stream_body.replace('"done":true', '"done": true'), f'{r.status_code}')
    check('stream carries the 5 synthetic entries',
          re.search(r'"total_count":\s*5', stream_body) is not None, re.findall(r'"total_count":\s*\d+', stream_body)[-1:].__str__())
    check('stream printed no traceback', 'Traceback' not in buf.getvalue())

    # Empty log_paths falls back to the (absent) journal: must skip, not raise
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        chunks = list(parser_mod.parse_date_range_stream(report, f'{YEAR}-01-01T00:00', f'{YEAR}-12-31T23:59', []))
    check('stream with no log_paths and no journal yields only a done chunk, no traceback',
          chunks and chunks[-1].get('done') is True and chunks[-1]['total_count'] == 0 and 'Traceback' not in buf.getvalue(),
          f'{len(chunks)} {buf.getvalue().strip()[-120:]}')

    # The Kernel OOM Killer tab reads the same hard-coded journal path; its
    # "Failed to read ...: [Errno 2] No such file or directory" line was the
    # only message in the repo resembling the one reported.
    import parsers.sosreport.kernel_oom_killer as oom_mod
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        oom = oom_mod.parse(report)
    check('kernel_oom_killer.parse() without a journal -> empty result, no "Failed to read"',
          oom.get('oom_killer') == [] and oom.get('oom_events') == [] and 'Failed to read' not in buf.getvalue() and 'No such file' not in buf.getvalue(),
          buf.getvalue().strip()[-120:])

    # ------------------------------------------------------------------
    print('\n--- 7. no journal capture and no other log file at all ---')
    report = new_report('no-journal-no-logs')
    write(os.path.join(report, 'sos_commands', 'logs', 'other_command'), 'synthetic output\n')
    os.makedirs(os.path.join(report, 'var', 'log'))  # present but empty

    data, error, out = parse_quiet(report)
    check('parse() does not raise', error is None, repr(error))
    check('no traceback / failed-read noise', 'Traceback' not in out and 'Failed to' not in out, out.strip()[-200:])
    if data is not None:
        check('available_logs and unavailable_logs both empty',
              data['available_logs'] == [] and data['unavailable_logs'] == [])
        check('date_range None/None, total_lines 0',
              data['date_range'] == {'start': None, 'end': None} and data['total_lines'] == 0)

    status, html, err = load_tab(client, report)
    check('POST /load_tab answers 200 with the empty state', status == 200 and 'No Readable Log Files Found' in html, f'{status} {err}')
    check('no unavailable note when nothing was present', 'id="log-file-unavailable"' not in html)
    check("no 'None' leaks into the fragment", '>None<' not in html and "'None'" not in html)
finally:
    shutil.rmtree(root, ignore_errors=True)

failed = [n for n, p in results if not p]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
