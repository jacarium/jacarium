#!/usr/bin/env python3
"""
The Log Viewers' filters applied server-side at load (backend/log_viewer.py /parse_log_viewer_stream for a
sosreport, parsers/mustgather/log_viewer.search for a must-gather): plain substrings - any of `query`, none of
`exclude`, over "host process message", lower-cased - a level, a process / source. The rows that arrive are the
matches across every selected file; a term that is not a string is a 400; a pattern is just text.

Run: backend/venv/bin/python tests/log_viewer_server_filters.test.py
"""
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.join(HERE, 'fixtures', 'diagnostics-mock'))

from flask import Flask  # noqa: E402
import log_viewer as lv_routes  # noqa: E402
import mock_sosreport  # noqa: E402
from parsers.sosreport.log_viewer import parse_journal_line  # noqa: E402

failed = 0


def check(name, passed, detail=''):
    global failed
    print(f"{'PASS' if passed else 'FAIL'}: {name}{(' | ' + str(detail)[:500]) if detail and not passed else ''}")
    if not passed:
        failed += 1


WORK = tempfile.mkdtemp(prefix="sos-server-filters-")
SOS = os.path.join(WORK, "sosreport-web-01-2026-10-13-abcdef")
mock_sosreport.build(SOS)
JOURNAL = os.path.join(SOS, "sos_commands", "logs", "journalctl_--no-pager")
with open(JOURNAL, encoding='utf-8', errors='ignore') as f:
    LINES = [parse_journal_line(line.rstrip('\n'), 2026) for line in f]
ROWS = [j for j in LINES if j]
START, END = "2026-10-01T00:00", "2026-10-13T00:00"


def text_of(j):
    return f"{j['host']} {j['process']} {j['message']}".lower()


app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
app.register_blueprint(lv_routes.log_viewer)
app.secret_key = "server-filters-test"
client = app.test_client()


def stream(**extra):
    body = {"directory": SOS, "start_date": START, "end_date": END, "log_paths": [JOURNAL], **extra}
    res = client.post("/parse_log_viewer_stream", json=body)
    if res.status_code != 200:
        return res.status_code, None, None
    chunks = [json.loads(line[6:]) for line in res.get_data(as_text=True).split("\n") if line.startswith("data: ")]
    entries = [e for c in chunks for e in c.get("entries", [])]
    last = [c for c in chunks if "total_count" in c]
    return 200, entries, (last[-1] if last else {})


status, every, info = stream()
check(f"the stream without filters: every dated line of the journal ({len(every)} rows)", status == 200 and len(every) == len(ROWS) and info.get("total_count") == len(ROWS), (status, len(every), len(ROWS), info))
want = [j for j in ROWS if "example-worker" in text_of(j)]
status, got, info = stream(query=["example-worker"])
check(f"query=['example-worker']: the {len(want)} matching rows only, total_count the matches, scanned the lines read", status == 200 and len(got) == len(want) and all("example-worker" in f"{e['hostname']} {e['process']} {e['message']}".lower() for e in got) and info.get("total_count") == len(want) and info.get("scanned") == len(ROWS), (status, len(got), len(want), info))
want = [j for j in ROWS if ("example-worker" in text_of(j) or "sshd" in text_of(j)) and "session" not in text_of(j)]
status, got, info = stream(query=["example-worker", "SSHD"], exclude=["Session"])
check(f"two terms are any-of, exclude none-of, case-insensitive ({len(want)} rows)", status == 200 and len(got) == len(want), (len(got), len(want)))
want = [j for j in ROWS if j['process'] == 'kernel']
status, got, info = stream(process="kernel")
check(f"process='kernel': that process's rows only ({len(want)})", status == 200 and len(got) == len(want) and all(e['process'] == 'kernel' for e in got), (len(got), len(want)))
status, got, info = stream(level="error")
check("level='error': every row an error, fewer than all", status == 200 and 0 < len(got) < len(ROWS) and all(e['severity'] == 'error' for e in got), (status, len(got)))
status, got, info = stream(query=["a.b*c"])
check("a pattern is plain text: 'a.b*c' matches nothing", status == 200 and got == [] and info == {} or (status == 200 and len(got) == 0), (status, len(got) if got is not None else None))
check("a term that is not a string is a 400", stream(query=[1])[0] == 400 and stream(exclude={"a": 1})[0] == 400 and stream(process=5)[0] == 400)
check("an unknown level is a 400", stream(level="loud")[0] == 400)

shutil.rmtree(WORK, ignore_errors=True)
print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
