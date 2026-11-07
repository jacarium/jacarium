"""Time in the logs, shared by the Diagnostics parsers: the timestamp a log line states (every line format the
Log Viewers know) and the broken time axis of a chart (the bucket plan the Audit page and the Log Collection
Histogram draw with diagChart.timeSeries).

    timestamp_of(line, year, ref=None) -> datetime | None
        The CRI prefix of a container log, RFC3339 at the line start, a [bracketed] ISO time, klog
        (I1025 10:00:00.123456), a journal line in any of journalctl's forms (parse_journal_line), JSON ("ts" /
        "time" / "timestamp" / "@timestamp", ISO or epoch) and logfmt (ts= / time=). Naive datetimes, to the second.
    bucket_plan(stamps, max_buckets, min_step) -> the step, the capture windows, the gaps between them, the bucket
        items and key_of(t)
    step_text(seconds), human_duration(minutes): the labels

Moved here from parsers/mustgather/log_viewer.py and parsers/mustgather/audit_logs.py (both re-export the names
they had), so a sosreport parser can use them without importing the must-gather package (PyYAML). Standard
library only.
"""
import re
from datetime import datetime, timedelta, timezone

from parsers.sosreport.log_viewer import parse_journal_line

# ---------------------------------------------------------------- the line formats

CONTAINER_LINE = re.compile(r'^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})?\s+(stdout|stderr)\s+([FP])\s?(.*)$')
ISO_LINE = re.compile(r'^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})?\s+(.*)$')
KLOG_LINE = re.compile(r'^[IWEF](\d{2})(\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s+\d+\s+\S+\]\s?(.*)$')
BRACKET_LINE = re.compile(r'^\[(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]\s*(.*)$')
JSON_TS = re.compile(r'"(?:ts|time|timestamp|@timestamp|Timestamp)"\s*:\s*"?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})')
JSON_EPOCH = re.compile(r'"(?:ts|time|timestamp)"\s*:\s*(\d{9,13})(?:\.\d+)?')
LOGFMT_TS = re.compile(r'(?:^|\s)(?:ts|time|timestamp)=\"?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})')


def iso(date, clock):
    try:
        return datetime.strptime(date + 'T' + clock, '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        return None


def timestamp_of(line, year, ref=None):
    """The time a log line states, in every format the gathers carry; None when it states none."""
    m = CONTAINER_LINE.match(line) or ISO_LINE.match(line) or BRACKET_LINE.match(line)
    if m:
        return iso(m.group(1), m.group(2))
    m = KLOG_LINE.match(line)
    if m:
        try:
            return datetime(year, int(m.group(1)), int(m.group(2)), *[int(x) for x in m.group(3).split(':')])
        except ValueError:
            return None
    j = parse_journal_line(line, year, ref)
    if j:
        return j['ts']
    head = line[:400]
    if head.lstrip().startswith('{'):
        m = JSON_TS.search(head)
        if m:
            return iso(m.group(1), m.group(2))
        m = JSON_EPOCH.search(head)
        if m:
            n = int(m.group(1))
            try:
                return datetime.fromtimestamp(n / 1000 if n > 10 ** 11 else n, tz=timezone.utc).replace(tzinfo=None, microsecond=0)
            except (OverflowError, OSError, ValueError):
                return None
    m = LOGFMT_TS.search(head)
    if m:
        return iso(m.group(1), m.group(2))
    return None


# ---------------------------------------------------------------- the broken time axis

def human_duration(minutes):
    minutes = int(round(minutes))
    if minutes < 60:
        return f"{minutes} min"
    h, m = divmod(minutes, 60)
    if h < 48:
        return f"{h} h {m} min" if m else f"{h} h"
    d, h = divmod(h, 24)
    return f"{d} d {h} h" if h else f"{d} d"


def _windows(stamps, gap_seconds):
    """[(first, last)] of the capture windows in a sorted list of timestamps
    with events: a hole longer than `gap_seconds` splits them."""
    wins = []
    start = prev = stamps[0]
    for t in stamps[1:]:
        if (t - prev).total_seconds() > gap_seconds:
            wins.append((start, prev))
            start = t
        prev = t
    wins.append((start, prev))
    return wins


BUCKET_STEPS = (1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400)   # seconds: 1 s ... 1 d
BUCKET_TARGET = 60      # at most this many buckets over the active time (so 30-60 bars as a rule)
GAP_SECONDS = 1800      # a hole without events longer than max(this, 10 buckets) splits the capture into windows


def step_text(seconds):
    """'5 s', '1 min', '2 h', '1 d'."""
    if seconds < 60:
        return f"{seconds} s"
    if seconds < 3600:
        return f"{seconds // 60} min"
    if seconds < 86400:
        return f"{seconds // 3600} h"
    return f"{seconds // 86400} d"


def bucket_plan(stamps, max_buckets=BUCKET_TARGET, min_step=1):
    """The broken time axis of a chart over `stamps` (sorted datetimes, at
    second or minute resolution): the bucket step (1/2/5/10/15/30 s, 1/2/5/
    10/15/30 min, 1/2/3/6/12 h, 1 d) chosen so the ACTIVE time (the capture
    windows added up, not the wall-clock span across a hole) takes at most
    `max_buckets` buckets; the windows; the gaps between them; the bucket
    items (a dict per bucket, zero-filled inside a window, a gap item between
    windows) and key_of(t), the bucket of a timestamp. A capture of a lab
    that was powered off and started again two days later is two windows
    with one gap."""
    wins = _windows(stamps, GAP_SECONDS)
    step = min_step
    for _ in range(2):   # the gap threshold depends on the step, the step on the active time
        active = sum((b - a).total_seconds() + min_step for a, b in wins)
        step = next((st for st in BUCKET_STEPS if st >= min_step and active / st <= max_buckets), BUCKET_STEPS[-1])
        wins = _windows(stamps, max(GAP_SECONDS, 10 * step))
    active = sum((b - a).total_seconds() + min_step for a, b in wins)
    wall = (stamps[-1] - stamps[0]).total_seconds() + min_step
    multi = len(wins) > 1 or wall > 86400
    fmt = '%H:%M:%S' if step < 60 else '%H:%M'
    items, gaps = [], []
    for i, (a, b) in enumerate(wins):
        a = a.replace(microsecond=0)
        if i:
            pb = wins[i - 1][1]
            hole = (a - pb).total_seconds() - min_step
            gap = {'gap': True, 'from': (pb + timedelta(seconds=min_step)).strftime('%Y-%m-%d %H:%M' if min_step >= 60 else '%Y-%m-%d %H:%M:%S'), 'to': a.strftime('%Y-%m-%d %H:%M' if min_step >= 60 else '%Y-%m-%d %H:%M:%S'),
                   'minutes': int(hole // 60), 'seconds': int(hole), 'label': f"no events for {human_duration(hole / 60)}", 'index': len(items)}
            gaps.append(gap)
            items.append(gap)
        t = a
        while t <= b:
            items.append({'t': t, 'gap': False, 'label': t.strftime('%m-%d ' + fmt if multi and t == a else fmt), 'window': i, 'start': t == a})
            t += timedelta(seconds=step)

    def key_of(t):
        for a, b in wins:
            if a <= t <= b:
                a0 = a.replace(microsecond=0)
                return a0 + timedelta(seconds=(int((t - a0).total_seconds()) // step) * step)
        return None
    return {'step_seconds': step, 'step': step // 60, 'windows': wins, 'gaps': gaps, 'items': items, 'key_of': key_of,
            'active_seconds': int(active), 'active_minutes': int(active // 60), 'wall_seconds': int(wall), 'wall_minutes': int(wall // 60)}
