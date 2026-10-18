#!/usr/bin/env python3
"""
Guards the Log Viewer's date-ranged journal read
(backend/parsers/sosreport/log_viewer.py JournalctlParser.parse_entries_streaming()).

THE BUG: the binary search for the range start returns the START of the
first line in range, and the streaming read then skipped "the partial line"
at that position - a whole, in-range entry. So every date-ranged load lost
its first entry ("Loaded N entries" was one short of the file; a range
covering a single moment found nothing), and the probe used by the binary
search skipped a whole line too whenever it landed exactly on a line start,
so the search could settle one line past the first entry in range.

THE FIX: the read starts at the position as found; the probe skips the rest
of a line only when it landed inside one (the byte before it is not a
newline).

Run: python3 tests/log_viewer_range_boundary.test.py   (no deps beyond the repo)
"""
import contextlib
import io
import os
import shutil
import sys
import tempfile
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, 'backend'))

import parsers.sosreport.log_viewer as lv  # noqa: E402

failed = 0


def check(name, passed, detail=''):
    global failed
    print(f"{'PASS' if passed else 'FAIL'}: {name}{(' | ' + str(detail)[:300]) if detail and not passed else ''}")
    if not passed:
        failed += 1


def stream(path, start, end):
    with contextlib.redirect_stdout(io.StringIO()):
        chunks = list(lv.JournalctlParser().parse_entries_streaming(path, start, end))
    return [x for c in chunks for x in (c if isinstance(c, list) else [c]) if isinstance(x, dict)]


tmp = tempfile.mkdtemp(prefix='lv-range-')
try:
    year = datetime.now().year
    path = os.path.join(tmp, 'journalctl_--no-pager')
    # 5 days x 100 entries, chronological, every line a different length (so probes land anywhere)
    lines = ['-- Logs begin at Thu Jan 01 00:00:00 UTC. --']
    n = 0
    for day in range(1, 6):
        for t in range(100):
            lines.append(f"Jan {day:2d} {t // 3600:02d}:{(t // 60) % 60:02d}:{t % 60:02d} host proc-{n % 7}[{100 + n}]: entry {n} {'x' * (n % 23)}")
            n += 1
    with open(path, 'w') as f:
        f.write('\n'.join(lines) + '\n')

    whole = stream(path, None, None)
    check('no range: every entry', len(whole) == 500 and whole[0]['message'].startswith('entry 0 ') and whole[-1]['message'].startswith('entry 499 '), len(whole))

    ranged = stream(path, datetime(year, 1, 1), datetime(year, 1, 5, 23, 59, 59))
    check('the full range as the slider sends it: every entry, the first one included (was 499: the first entry of the range was skipped)', len(ranged) == 500 and ranged[0]['message'].startswith('entry 0 '), (len(ranged), ranged[0]['message'] if ranged else None))

    for day in range(1, 6):
        one = stream(path, datetime(year, 1, day), datetime(year, 1, day, 23, 59, 59))
        first = (day - 1) * 100
        check(f'Jan {day} alone: 100 entries from entry {first} (the day\'s first entry, at 00:00:00, included)', len(one) == 100 and one[0]['message'].startswith(f'entry {first} ') and one[-1]['message'].startswith(f'entry {first + 99} '), (len(one), one[0]['message'] if one else None, one[-1]['message'] if one else None))

    moment = stream(path, datetime(year, 1, 3), datetime(year, 1, 3, 0, 0, 0))
    check('a range covering a single moment finds the entry at that moment (was: nothing)', len(moment) == 1 and moment[0]['message'].startswith('entry 200 '), [m['message'] for m in moment])

    middle = stream(path, datetime(year, 1, 2, 0, 0, 30), datetime(year, 1, 3, 0, 0, 29))
    check('a range starting mid-day starts at the first entry at or after the start and ends at the last at or before the end', len(middle) == 100 and middle[0]['message'].startswith('entry 130 ') and middle[-1]['message'].startswith('entry 229 '), (len(middle), middle[0]['message'] if middle else None, middle[-1]['message'] if middle else None))

    before = stream(path, datetime(year, 1, 6), datetime(year, 1, 7))
    after = stream(path, datetime(year - 1, 12, 1), datetime(year - 1, 12, 31))
    check('a range after the file, or before it, finds nothing', len(before) == 0 and len(after) == 0, (len(before), len(after)))

    # the probe: landing exactly on a line start must not skip that line
    pattern = lv.re.compile(r'^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})')
    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
        line_start = len(lines[0]) + 1  # the byte after the header line's newline: entry 0 starts here
        ts, pos = lv.JournalctlParser()._find_timestamp_at_position(f, line_start, year, pattern)
        check('a probe landing exactly on a line start reads that line (was: skipped it as "partial")', pos == line_start and ts == datetime(year, 1, 1, 0, 0, 0), (pos, line_start, ts))
        ts2, pos2 = lv.JournalctlParser()._find_timestamp_at_position(f, line_start + 5, year, pattern)
        check('a probe landing inside a line skips the rest of it and reads the next one', pos2 > line_start and ts2 == datetime(year, 1, 1, 0, 0, 1), (pos2, ts2))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print('\nAll checks passed' if not failed else f'\n{failed} check(s) failed')
sys.exit(1 if failed else 0)
