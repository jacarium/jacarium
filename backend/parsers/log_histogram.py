"""The Log Collection Histogram's engine: what happened when in a set of logs, and what stands out.

One streaming pass over the selected logs turns every timestamped line into a TEMPLATE - its source group (a
journal's process, a container, a file) and its message with the variable parts (numbers, addresses, ids, times)
replaced by <*> - counted per minute; nothing else of a line is kept. The minutes go on the broken time axis of
parsers/logtime.bucket_plan, and the counts per bucket are read for anomalies:

  volume    the lines per bucket jump far above the usual (a robust z-score over the buckets: median and MAD)
  errors    the same over the error and critical lines
  burst     one template far above its own usual rate (a Poisson tail against its trimmed mean)
  new       a template first seen well after its sources start (their first part is its baseline)
  stopped   a steady template (present in most buckets of its life) that goes quiet well before its sources end
  rare      an error or critical template seen only a few times
  incident  new / rare templates of one source that appear in the same time bucket, folded into one row (a kernel
            trace is one incident, not twenty "new" lines - its lines may each be one-offs); the headline is its
            most severe line, else the line that names what happened, else its first

A template is judged within the time its own sources cover (their first and last dated line), never against the
whole capture: a container's previous log of a few seconds has no "usual rate" over the day.

Every threshold is in THRESHOLDS below, in one place. Each anomaly carries the cross-link query of the Log Viewer
("sources=...&from=...&to=...&q=...") that loads its sources for its time window with a literal piece of its
template as the search.

The pass runs per work item (a file, or a byte range of a large uncompressed file) through parsers/parallel.run, in
worker processes when there are several items and enough bytes, serially otherwise; a work item returns a summary
(templates with per-minute counts and one sample line), never its lines. The adapters (parsers/sosreport/
log_histogram.py, parsers/mustgather/log_histogram.py) list the sources and build the items; this module is
report-agnostic.

    analyse(items, start=None, end=None, cancelled=None, progress=None, workers=None) -> result
    cancel(directory) / begin(directory): the generation of a directory's running analysis

Standard library only. Everything returned is report content: the templates escape it to HTML (Jinja, textContent).
"""
import math
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta

from parsers import parallel
from parsers.findings import finding, sort_findings
from parsers.logtime import CONTAINER_LINE, ISO_LINE, BRACKET_LINE, KLOG_LINE, bucket_plan, step_text, timestamp_of
from parsers.sosreport.log_viewer import JOURNAL_LINE_RE, _journal_datetime, classify_severity

# ---------------------------------------------------------------- the knobs, in one place

THRESHOLDS = {
    'min_burst': 10,         # a burst / spike bucket holds at least this many lines
    'burst_ratio': 4.0,      # ... and at least this many times the template's usual rate
    'burst_p': 8.0,          # ... and -log10 of its Poisson tail at least this (p <= 1e-8)
    'burst_floor': 0.05,     # the smallest usual rate a template is given (lines per bucket)
    'spike_z': 6.0,          # a volume / error spike: robust z-score (median / MAD) at least this
    'spike_ratio': 2.0,      # ... and at least this many times the median bucket
    'new_after': 0.15,       # "new": first seen after this share of the time its sources cover (the rest is the baseline)
    'new_min': 3,            # ... and seen at least this many times
    'stop_before': 0.10,     # "stopped": silent for at least this share of its sources' buckets before they end (and 3)
    'stop_presence': 0.80,   # ... after being present in at least this share of the buckets of its life
    'stop_min_rate': 0.5,    # ... at at least this many lines per bucket
    'stop_min_life': 10,     # ... over a life of at least this many buckets
    'rare_max': 3,           # "rare": an error / critical template seen at most this many times
    'incident_min': 3,       # this many never-seen messages of one source in one bucket are an incident (each may be a one-off)
    'incident_vs_usual': 4.0,  # ... and at least this many times the one-off messages that source writes per bucket anyway
    'merge_similarity': 0.7,  # two templates of one source with the same token count and this share of equal tokens are one
}
MERGE_MAX_MEMBERS = 2000    # merge_similar: the most frequent templates of a group it folds (the rest stay as they are)
MERGE_MAX_CLUSTERS = 200    # ... each compared with at most this many clusters (a pathological log never goes quadratic)
LIMITS = {
    'max_buckets': 240,           # the time axis: at most this many buckets over the active time
    'chunk_bytes': 64 << 20,      # the largest byte range of one work item (an uncompressed file is split into ranges)
    'min_chunk_bytes': 4 << 20,   # ... and the smallest: a range is about a third of a worker's share, within these
    'parallel_min_bytes': 8 << 20,  # below this many bytes in all, the pass runs serially (a pool costs ~0.1-1 s)
    'max_templates_per_item': 20000,  # a work item's templates beyond this count as one "(template limit)" row
    'max_message': 2000,          # characters of a message that are normalised
    'max_line_bytes': 1 << 20,    # a line is read at most this much at a time (a longer one counts as pieces)
    'sample_chars': 400,          # characters of a template's sample line
    'max_templates_shown': 1000,  # the template table: the most frequent
    'max_anomalies': 200,
    'max_bands': 12,              # anomaly windows shaded on the chart
    'max_link_sources': 40,       # sources a Log Viewer link names
    'max_link_chars': 1800,       # ... while the link stays this short (the frame bridge carries 2000)
    'max_groups': 15,             # the sources chart
}

SEVERITIES = ('critical', 'error', 'warning', 'info', 'debug', 'other')
SEV_RANK = {s: i for i, s in enumerate(SEVERITIES)}
_EPOCH = datetime(1970, 1, 1)

_generation = parallel.Generation()


def begin(directory):
    return _generation.begin(os.path.realpath(directory))


def cancel(directory):
    """Stop the running analysis of a report (a newer one over the same report does this itself)."""
    _generation.cancel(os.path.realpath(directory))


def checker(directory, token):
    return _generation.checker(os.path.realpath(directory), token)


def is_current(directory, token):
    return _generation.current(os.path.realpath(directory), token)


# ---------------------------------------------------------------- templates

_DIGITS = str.maketrans('0123456789', '##########')
_RUN = re.compile(r'#+(?:[.:]#+)*')                        # a number, a dotted address, a time: one placeholder
# after the translate a digit is '#', which is no word character: the edges are lookarounds, not \b
_UUID = re.compile(r'(?<![\w#])[0-9a-fA-F#]{8}-[0-9a-fA-F#]{4}-[0-9a-fA-F#]{4}-[0-9a-fA-F#]{4}-[0-9a-fA-F#]{12}(?![\w#])')
_HEXID = re.compile(r'(?<![\w#])(?=[0-9a-f]*#)[0-9a-f#]{6,}(?![\w#])')   # a hex id (6+) with a digit in it
_HEX0X = re.compile(r'(?<![\w#])#[xX][0-9a-fA-F#]+(?![\w#])')               # 0x1f, 0xffff8a00
_OVERFLOW = '(more distinct messages than the template limit)'


def normalise(message):
    """The template of a message: every digit run (with the dots and colons that join digit runs: an address, a
    time, a version - a dot before a word stays, so nfs01.example.test is nfs<*>.example.test) and every hex id that
    holds a digit becomes <*> (a UUID and a 0x value as one). Cheap on purpose (str.translate, a few small
    patterns behind cheap tests): it runs once per line; merge_similar tidies what it leaves."""
    s = message.translate(_DIGITS)
    if '#' not in s:
        return s
    if s.count('-') >= 4:              # the cheap tests first: most lines hold no UUID and no 0x value
        s = _UUID.sub('<*>', s)
    if '#x' in s or '#X' in s:
        s = _HEX0X.sub('<*>', s)
    return _RUN.sub('<*>', _HEXID.sub('<*>', s))


def _minute(dt):
    return int((dt - _EPOCH).total_seconds() // 60)


def _dt(minute):
    return _EPOCH + timedelta(minutes=minute)


def _iso_minute(minute):
    return _dt(minute).strftime('%Y-%m-%dT%H:%M')


# ---------------------------------------------------------------- the work items

def plan_items(sources, start=None, end=None, workers=None):
    """The work items of a run: one per source, a large uncompressed file split into byte ranges (each range reads
    the lines that START in it) of about a third of a worker's share of the bytes, between min_chunk_bytes and
    chunk_bytes - so a single large journal keeps every worker busy. sources: [{path, size, kind, prefix, label, link,
    year, ref}] from an adapter; start / end: naive datetimes of the analysis window (None: open). Largest first, for
    an even finish. The ranges do not change the result: combine() orders by position, not by schedule."""
    lo = _minute(start) if start else None
    hi = _minute(end) if end else None
    n = parallel.default_workers() if workers is None else max(1, int(workers))
    total = sum(s.get('size') or 0 for s in sources)
    chunk = max(LIMITS['min_chunk_bytes'], min(LIMITS['chunk_bytes'], total // (n * 3) + 1))
    items = []
    for index, s in enumerate(sources):
        size = s.get('size') or 0
        base = {'path': s['path'], 'index': index, 'kind': s.get('kind') or 'auto', 'prefix': s.get('prefix') or '', 'label': s.get('label') or s['path'],
                'link': s.get('link') or '', 'year': s.get('year'), 'ref': s.get('ref'), 'lo': lo, 'hi': hi}
        if s['path'].endswith('.gz') or size <= chunk:
            items.append(dict(base, start=0, end=None, size=size))
            continue
        for off in range(0, size, chunk):
            items.append(dict(base, start=off, end=min(size, off + chunk), size=min(chunk, size - off)))
    items.sort(key=lambda it: (-it['size'], it['index'], it['start']))
    return items


def _open(path):
    if path.endswith('.gz'):
        import gzip
        return gzip.open(path, 'rb')
    return open(path, 'rb')


def scan_item(item):
    """One work item's pass (run in a worker process or inline): {index, start, lines, matched, outside, undated,
    overflow, span: [first, last minute] | None, link, templates: {key: [count, {minute: n}, first_minute, first_offset,
    sample, severity, group, link]}}.
    key = group + '\\x00' + template. Nothing of the lines is kept beyond one sample per template."""
    year = item.get('year') or datetime.now().year
    ref = datetime.fromisoformat(item['ref']) if item.get('ref') else None
    lo, hi = item.get('lo'), item.get('hi')
    prefix, label, link, kind = item['prefix'], item['label'], item['link'], item['kind']
    max_t, max_msg, sample_chars = LIMITS['max_templates_per_item'], LIMITS['max_message'], LIMITS['sample_chars']
    templates = {}
    memo = {}
    lines = matched = outside = undated = overflow = 0
    span_lo = span_hi = None
    journal_re, container_re = JOURNAL_LINE_RE.match, CONTAINER_LINE.match
    start, end = item.get('start') or 0, item.get('end')
    with _open(item['path']) as f:
        if start:
            f.seek(start - 1)
            f.readline()          # the line that straddles the range's start belongs to the range before
        offset = f.tell()
        readline = f.readline
        max_raw = LIMITS['max_line_bytes']
        while True:
            raw = readline(max_raw)   # a line longer than this (a blob) is read in pieces: never all in memory
            if not raw:
                break
            if end is not None and offset >= end:
                break
            here = offset
            offset += len(raw)
            lines += 1
            line = raw.decode('utf-8', 'replace').rstrip('\r\n')
            group = None
            minute = None
            msg = None
            m = container_re(line) if kind == 'container' else None
            if m is not None:
                mk = line[:16]
                minute = memo.get(mk)
                if minute is None:
                    try:
                        minute = memo[mk] = _minute(datetime.strptime(mk, '%Y-%m-%dT%H:%M'))
                    except ValueError:
                        minute = None
                msg, group = m.group(6), label
            else:
                m = journal_re(line) if kind != 'container' else None
                if m is not None:
                    e = m.end('t1') if m.group('t1') else m.end('t2')
                    mk = line[:e - 3]                 # the stamp up to the minute: one datetime per minute, not per line
                    minute = memo.get(mk)
                    if minute is None:
                        ts = _journal_datetime(m, year, ref)
                        minute = memo[mk] = _minute(ts) if ts is not None else None
                    msg, group = m.group('msg'), prefix + m.group('proc')
                else:
                    ts = timestamp_of(line, year, ref)
                    if ts is not None:
                        minute = _minute(ts)
                        m2 = CONTAINER_LINE.match(line)
                        if m2:
                            msg = m2.group(6)
                        else:
                            m2 = ISO_LINE.match(line) or BRACKET_LINE.match(line) or KLOG_LINE.match(line)
                            msg = m2.group(m2.re.groups) if m2 else line
                        group = label
            if minute is None:
                if line.strip():
                    undated += 1      # a continuation line (a traceback, a wrapped message) or a log without times
                continue
            if (lo is not None and minute < lo) or (hi is not None and minute > hi):
                outside += 1
                continue
            matched += 1
            if span_lo is None or minute < span_lo:
                span_lo = minute
            if span_hi is None or minute > span_hi:
                span_hi = minute
            key = group + '\x00' + normalise(msg[:max_msg])
            t = templates.get(key)
            if t is None:
                if len(templates) >= max_t:
                    key = group + '\x00' + _OVERFLOW
                    overflow += 1
                    t = templates.get(key)
                if t is None:
                    t = templates[key] = [0, {}, minute, here, line[:sample_chars], classify_severity(msg[:max_msg]), group, link]
            t[0] += 1
            mins = t[1]
            mins[minute] = mins.get(minute, 0) + 1
            if minute < t[2]:
                t[2] = minute
    return {'index': item['index'], 'start': start, 'lines': lines, 'matched': matched, 'outside': outside, 'undated': undated,
            'overflow': overflow, 'span': [span_lo, span_hi] if span_lo is not None else None, 'link': link, 'templates': templates}


# ---------------------------------------------------------------- combining and merging

class Template:
    __slots__ = ('key', 'group', 'text', 'severity', 'count', 'minutes', 'first', 'order', 'sample', 'links', 'srcs', 'merged', 'id')

    def __init__(self, key, rec, order):
        self.key = key
        self.group, self.text = key.split('\x00', 1)
        self.count, self.minutes, self.first, self.sample, self.severity = rec[0], dict(rec[1]), rec[2], rec[4], rec[5]
        self.order = order
        self.links = {rec[7]} if rec[7] else set()
        self.srcs = {order[1]}          # the indexes of the sources it was read from
        self.merged = 1
        self.id = ''

    @property
    def last(self):
        return max(self.minutes)


def combine(summaries):
    """The work items' summaries as one {key: Template}: counts and minutes added up, the first sample the earliest
    line (by minute, then source order, then position). Deterministic: the same however the items were scheduled."""
    out = {}
    for s in sorted(summaries, key=lambda s: (s['index'], s['start'])):
        for key, rec in s['templates'].items():
            order = (rec[2], s['index'], rec[3])
            t = out.get(key)
            if t is None:
                out[key] = Template(key, rec, order)
                continue
            t.count += rec[0]
            mins = t.minutes
            for mnt, n in rec[1].items():
                mins[mnt] = mins.get(mnt, 0) + n
            if rec[7]:
                t.links.add(rec[7])
            t.srcs.add(s['index'])
            if order < t.order:
                t.order, t.sample, t.severity = order, rec[4], rec[5]
            t.first = min(t.first, rec[2])
    return out


def merge_similar(templates, threshold=None):
    """Templates of one source with the same number of tokens and the same first token whose tokens agree in at
    least `threshold` of the positions are one template (the differing positions become <*>): what the cheap
    normaliser leaves (a hex id without a digit, a host name) is folded here, over the templates, not the lines."""
    threshold = THRESHOLDS['merge_similarity'] if threshold is None else threshold
    groups = defaultdict(list)
    for t in templates.values():
        toks = t.text.split()
        groups[(t.group, len(toks), toks[0] if toks else '')].append((t, toks))
    out = []
    for gkey in sorted(groups):
        members = sorted(groups[gkey], key=lambda x: (-x[0].count, x[0].key))
        clusters = []
        for n, (t, toks) in enumerate(members):
            if t.text == _OVERFLOW or n >= MERGE_MAX_MEMBERS:
                clusters.append([t, toks])
                continue
            for c in clusters[:MERGE_MAX_CLUSTERS]:
                rtoks = c[1]
                if not rtoks or c[0].text == _OVERFLOW:
                    continue
                same = sum(1 for a, b in zip(toks, rtoks) if a == b)
                if same >= threshold * len(toks) and toks[0] == rtoks[0]:
                    c[1] = [a if a == b else '<*>' for a, b in zip(rtoks, toks)]
                    r = c[0]
                    r.count += t.count
                    for mnt, n in t.minutes.items():
                        r.minutes[mnt] = r.minutes.get(mnt, 0) + n
                    r.links |= t.links
                    r.srcs |= t.srcs
                    r.merged += t.merged
                    r.first = min(r.first, t.first)
                    if t.order < r.order:
                        r.order, r.sample = t.order, t.sample
                    if SEV_RANK.get(t.severity, 5) < SEV_RANK.get(r.severity, 5):
                        r.severity = t.severity
                    break
            else:
                clusters.append([t, toks])
        for r, toks in clusters:
            if r.text != _OVERFLOW and toks:
                r.text = ' '.join(toks)
            out.append(r)
    out.sort(key=lambda t: (-t.count, t.group, t.text))
    for i, t in enumerate(out):
        t.id = f't{i + 1}'
    return out


# ---------------------------------------------------------------- statistics

def poisson_tail(k, lam):
    """-log10 P(X >= k) for X ~ Poisson(lam): the upper tail summed in log space (0 when k <= lam)."""
    if k <= 0 or k <= lam:
        return 0.0
    log_lam = math.log(lam)
    term = -lam + k * log_lam - math.lgamma(k + 1)
    top = term
    acc = 0.0
    i = k
    while True:
        acc += math.exp(term - top)
        i += 1
        term += log_lam - math.log(i)
        if term - top < -30 or i > k + 100000:
            break
    return max(0.0, -(top + math.log(acc)) / math.log(10))


def _median(values):
    v = sorted(values)
    n = len(v)
    if not n:
        return 0.0
    return float(v[n // 2]) if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2.0


def _trimmed_mean(values, trim=0.1):
    v = sorted(values)
    k = int(len(v) * trim)
    v = v[:len(v) - k] if k else v
    return sum(v) / len(v) if v else 0.0


def _runs(flags):
    out, i = [], None
    for k, f in enumerate(list(flags) + [False]):
        if f and i is None:
            i = k
        elif not f and i is not None:
            out.append((i, k - 1))
            i = None
    return out


# ---------------------------------------------------------------- the analysis

def _fragment(text):
    """The longest literal piece of a template (between the <*>, no comma: the Log Viewer splits its search on
    commas), at least 4 characters; '' when there is none."""
    best = ''
    for piece in re.split(r'<\*>|,', text):
        piece = piece.strip().strip('"\'[](){}:;=').strip()
        if len(piece) > len(best):
            best = piece
    return best[:120] if len(best) >= 4 else ''


def viewer_query(links, start_minute, end_minute, q=''):
    """The Log Viewer's cross-link query: its sources, the window (ISO minutes, the end exclusive) and a search."""
    from urllib.parse import quote
    tail = []
    if start_minute is not None:
        tail.append('from=' + _iso_minute(start_minute))
    if end_minute is not None:
        tail.append('to=' + _iso_minute(end_minute))
    if q:
        tail.append('q=' + quote(q, safe=''))
    rest = ''.join('&' + p for p in tail)
    # the sources while the query stays within the cross-link's budget (the frame bridge carries up to 2000)
    chosen = []
    for name in sorted(links)[:LIMITS['max_link_sources']]:
        if len('sources=' + quote(','.join(chosen + [name]), safe='') + rest) > LIMITS['max_link_chars']:
            break
        chosen.append(name)
    return 'sources=' + quote(','.join(chosen), safe='') + rest


def analyse(items, start=None, end=None, cancelled=None, progress=None, workers=None, all_links=None):
    """The whole analysis over an adapter's sources: see the module docstring. items: plan_items() output; start /
    end the window (naive datetimes or None); cancelled / progress / workers go to parallel.run. Raises
    parallel.Cancelled when cancelled."""
    run_info = {}
    total_bytes = sum(it['size'] for it in items)
    if workers is None and total_bytes < LIMITS['parallel_min_bytes']:
        workers = 1
    summaries = parallel.run(scan_item, items, workers=workers, cancelled=cancelled, progress=progress, info=run_info)
    stats = {'files': len({it['index'] for it in items}), 'items': len(items), 'bytes': total_bytes,
             'lines': sum(s['lines'] for s in summaries), 'matched': sum(s['matched'] for s in summaries),
             'outside': sum(s['outside'] for s in summaries), 'undated': sum(s['undated'] for s in summaries),
             'overflow': sum(s['overflow'] for s in summaries), 'run': run_info}
    raw = combine(summaries)
    stats['raw_templates'] = len(raw)
    templates = merge_similar(raw)
    stats['templates'] = len(templates)
    links_all = set(all_links or ())
    for t in templates:
        links_all |= t.links
    # the span of every source (its first and last dated line): a template is judged against the time its sources
    # cover, not the whole capture (a previous log of a few seconds has no "usual rate" over the day)
    spans = {}
    for sm in summaries:
        if sm.get('span'):
            lo, hi = sm['span']
            cur = spans.get(sm['index'])
            spans[sm['index']] = [lo, hi] if cur is None else [min(cur[0], lo), max(cur[1], hi)]
    result = {'stats': stats, 'thresholds': dict(THRESHOLDS), 'window': {'start': start.isoformat(timespec='minutes') if start else None,
              'end': end.isoformat(timespec='minutes') if end else None}}
    if not templates:
        result.update({'timeline': None, 'anomalies': [], 'templates': [], 'groups': [], 'findings': _findings(result)})
        return result
    minutes = sorted({m for t in templates for m in t.minutes})
    plan = bucket_plan([_dt(m) for m in minutes], max_buckets=LIMITS['max_buckets'], min_step=60)
    step_min = plan['step_seconds'] // 60
    items_axis = plan['items']
    index_of = {}
    real = []
    for i, it in enumerate(items_axis):
        if not it['gap']:
            index_of[_minute(it['t'])] = i
            real.append(i)
    key_of = plan['key_of']
    bucket_of = {}
    for m in minutes:
        k = key_of(_dt(m))
        bucket_of[m] = index_of[_minute(k)] if k is not None else real[-1]
    nb = len(items_axis)

    def series(t):
        s = [0] * nb
        for m, n in t.minutes.items():
            s[bucket_of[m]] += n
        return s

    # the lines per bucket by level, straight from the minutes (a template's whole series is only built while it is
    # examined: templates x buckets never sits in memory)
    by_sev = {s: [0] * nb for s in SEVERITIES}
    for t in templates:
        sv = by_sev.get(t.severity, by_sev['other'])
        for m, n in t.minutes.items():
            sv[bucket_of[m]] += n
    total = [sum(by_sev[s][i] for s in SEVERITIES) for i in range(nb)]
    errors = [by_sev['critical'][i] + by_sev['error'][i] for i in range(nb)]

    def bucket_start(i):
        return _minute(items_axis[i]['t'])

    def bucket_end(i):
        return bucket_start(i) + step_min

    def span_of(t):
        ss = [spans[i] for i in t.srcs if i in spans]
        if not ss:
            return real[0], real[-1]
        return bucket_of[min(x[0] for x in ss)], bucket_of[max(x[1] for x in ss)]

    anomalies = _detect(templates, series, bucket_of, total, errors, real, nb, bucket_start, bucket_end, links_all, span_of)
    # the timeline: per real bucket the lines by level, a gap item between capture windows
    timeline_buckets = []
    for i, it in enumerate(items_axis):
        if it['gap']:
            timeline_buckets.append({'gap': True, 'from': it['from'], 'to': it['to'], 'minutes': it['minutes'], 'label': it['label'], 't': ''})
            continue
        b = {'t': it['t'].strftime('%Y-%m-%dT%H:%M:%S'), 'label': it['label'], 'gap': False, 'window': it['window'], 'start': it['start'], 'n': total[i]}
        for s in SEVERITIES:
            b[s] = by_sev[s][i]
        timeline_buckets.append(b)
    bands = [{'from': a['first'], 'to': a['last'], 'id': a['id'], 'kind': a['kind'], 'severity': a.get('severity') or ''}
             for a in anomalies[:LIMITS['max_bands']]]
    result['timeline'] = {'buckets': timeline_buckets, 'step_seconds': plan['step_seconds'], 'step_text': step_text(plan['step_seconds']),
                          'gaps': [{'from': g['from'], 'to': g['to'], 'label': g['label'], 'minutes': g['minutes']} for g in plan['gaps']],
                          'windows': [{'first': a.strftime('%Y-%m-%d %H:%M'), 'last': b.strftime('%Y-%m-%d %H:%M')} for a, b in plan['windows']],
                          'first': _iso_minute(minutes[0]), 'last': _iso_minute(minutes[-1]), 'bands': bands, 'max': max(total) if total else 0}
    result['anomalies'] = anomalies
    result['templates'] = [_template_row(t, bucket_of[t.first], bucket_of[t.last], bucket_start, bucket_end) for t in templates[:LIMITS['max_templates_shown']]]
    groups = defaultdict(lambda: [0, 0])
    for t in templates:
        g = groups[t.group]
        g[0] += t.count
        if t.severity in ('critical', 'error'):
            g[1] += t.count
    result['groups'] = [{'name': name, 'key': name, 'count': c, 'errors': e} for name, (c, e) in sorted(groups.items(), key=lambda kv: (-kv[1][0], kv[0]))[:LIMITS['max_groups']]]
    result['group_names'] = sorted(groups)
    result['findings'] = _findings(result)
    return result


def _template_row(t, first_b, last_b, bucket_start, bucket_end):
    return {'id': t.id, 'group': t.group, 'template': t.text, 'severity': t.severity, 'count': t.count, 'merged': t.merged,
            'first': _iso_minute(t.first), 'last': _iso_minute(t.last), 'sample': t.sample,
            'link': viewer_query(t.links, bucket_start(first_b), bucket_end(last_b), _fragment(t.text))}


def _detect(templates, series, bucket_of, total, errors, real, nb, bucket_start, bucket_end, links_all, span_of):
    P = THRESHOLDS
    # a template's series per bucket is built only when it can be a burst or a stopped one (enough lines for either);
    # new, rare and incidents need its first and last bucket alone - a log of 40,000 one-off messages stays cheap
    series_min = min(P['min_burst'], int(P['stop_min_life'] * P['stop_presence']))
    out = []
    nreal = len(real)
    pos = {i: k for k, i in enumerate(real)}          # an axis index -> its place among the real buckets

    def window_label(i, j):
        a, b = _dt(bucket_start(i)), _dt(bucket_end(j))
        return a.strftime('%Y-%m-%d %H:%M') + ' - ' + (b.strftime('%H:%M') if b.date() == a.date() else b.strftime('%Y-%m-%d %H:%M'))

    def base(kind, i, j, score, **kw):
        a = {'kind': kind, 'first': i, 'last': j, 'from': _iso_minute(bucket_start(i)), 'to': _iso_minute(bucket_end(j)),
             'when': window_label(i, j), 'score': round(min(100.0, max(0.0, score)), 1)}
        a.update(kw)
        return a

    # 1. the volume and the error lines per bucket: a robust z-score over the real buckets
    for kind, s in (('volume', total), ('errors', errors)):
        vals = [s[i] for i in real]
        med = _median(vals)
        mad = _median([abs(x - med) for x in vals]) * 1.4826 or 1.0
        flags = [False] * nb
        for i in real:
            x = s[i]
            flags[i] = (x - med) / mad >= P['spike_z'] and x >= P['spike_ratio'] * max(med, 1.0) and x >= P['min_burst']
        for i, j in _runs(flags):
            peak = max(s[i:j + 1])
            what = 'lines' if kind == 'volume' else 'error and critical lines'
            out.append(base(kind, i, j, 10.0 * (peak - med) / mad, title=f"{'Log volume' if kind == 'volume' else 'Error'} spike: {peak:,} {what} in a bucket (usual {med:g})",
                            group='', template='', severity='error' if kind == 'errors' else '', peak=peak, baseline=round(med, 2), count=sum(s[i:j + 1]),
                            sample='', links=sorted(links_all), q=''))
    new_ids = set()
    novel = defaultdict(list)          # (group, first bucket) -> the never-seen templates seen fewer than new_min times
    oneoff_base = defaultdict(int)     # group -> the one-off templates first seen in its baseline (its usual noise)
    base_buckets = defaultdict(int)    # group -> the buckets of its baseline
    for t in templates:
        if t.text == _OVERFLOW:
            continue
        i0, i1 = bucket_of[t.first], bucket_of[t.last]
        s = series(t) if t.count >= series_min else None
        # the template's sources' span, in real buckets: the baseline, the "new" cut and the "stopped" tail are
        # measured within it
        b_lo, b_hi = span_of(t)
        p_lo, p_hi = pos[b_lo], pos[b_hi]
        span = real[p_lo:p_hi + 1]
        k_cut = min(len(span) - 1, int(len(span) * P['new_after']))
        cut = span[k_cut]
        base_buckets[t.group] = max(base_buckets[t.group], k_cut)
        after_cut = i0 >= cut and pos[i0] > p_lo
        is_new = after_cut and t.count >= P['new_min']
        sev_w = {'critical': 3.0, 'error': 2.0, 'warning': 1.5}.get(t.severity, 1.0)

        def common(t=t):
            return {'group': t.group, 'template': t.text, 'severity': t.severity, 'sample': t.sample, 'links': sorted(t.links),
                    'q': _fragment(t.text), 'tid': t.id, 'order': t.order}

        # 3. new: first seen after the baseline part of its sources' time
        if is_new:
            new_ids.add(t.id)
            out.append(base('new', i0, i0, sev_w * 10.0 * math.log2(1 + t.count), title=f"New message: {_short(t.text)}", count=t.count, **common()))
        elif after_cut:
            novel[(t.group, i0)].append((t, sev_w))
        elif t.count < P['new_min']:
            oneoff_base[t.group] += 1
        if s is not None:
            # 2. a burst: a Poisson tail against the template's trimmed rate - over its own life when it is new (a new
            #    template's arrival is the "new" row, not a burst against the zeros before it)
            life = [s[i] for i in span if (not is_new or i >= i0)]
            lam = max(_trimmed_mean(life), P['burst_floor'])
            flags = [False] * nb
            for i in span:
                if is_new and i <= i0:
                    continue
                c = s[i]
                flags[i] = c >= P['min_burst'] and c >= P['burst_ratio'] * lam and poisson_tail(c, lam) >= P['burst_p']
            for i, j in _runs(flags):
                peak = max(s[i:j + 1])
                out.append(base('burst', i, j, poisson_tail(peak, lam), title=f"Burst: {_short(t.text)}", peak=peak, baseline=round(lam, 2),
                                count=sum(s[i:j + 1]), **common()))
            # 4. stopped: steady, then quiet well before its sources end
            life_n = pos[i1] - pos[i0] + 1
            tail = p_hi - pos[i1]
            if life_n >= P['stop_min_life'] and tail >= max(3, int(len(span) * P['stop_before'])):
                seen = sum(1 for i in real[pos[i0]:pos[i1] + 1] if s[i])
                rate = t.count / life_n
                if seen / life_n >= P['stop_presence'] and rate >= P['stop_min_rate']:
                    j = real[pos[i1] + 1]
                    out.append(base('stopped', j, real[p_hi], 10.0 * math.log2(1 + rate * tail), title=f"Stopped: {_short(t.text)} (steady until {_dt(bucket_end(i1)).strftime('%H:%M')})",
                                    rate=round(rate, 2), count=t.count, last_seen=_iso_minute(t.last), **common()))
        # 5. rare: an error / critical template seen a few times (not already "new")
        if t.id not in new_ids and t.count <= P['rare_max'] and t.severity in ('critical', 'error'):
            out.append(base('rare', i0, i1, 40.0 if t.severity == 'critical' else 25.0, title=f"Rare {t.severity}: {_short(t.text)}", count=t.count, **common()))
    # one-off new messages that arrive together (a kernel report: a dozen lines seen once) are an incident when there
    # are enough of them in one bucket of one source - enough against the one-offs that source writes anyway (a source
    # whose every message is unique has no incident in its noise); alone, a one-off line is not an anomaly
    have = defaultdict(int)
    for a in out:
        if a['kind'] in ('new', 'rare'):
            have[(a['group'], a['first'])] += 1
    for (group, i0), members in novel.items():
        usual = oneoff_base[group] / max(1, base_buckets[group])
        if len(members) + have[(group, i0)] < max(P['incident_min'], math.ceil(P['incident_vs_usual'] * usual)):
            continue
        for t, sev_w in members:
            if t.id in new_ids:
                continue
            new_ids.add(t.id)
            out = [x for x in out if not (x['kind'] == 'rare' and x.get('tid') == t.id)]
            out.append(base('new', i0, i0, sev_w * 10.0 * math.log2(1 + t.count), title=f"New message: {_short(t.text)}", count=t.count,
                            group=t.group, template=t.text, severity=t.severity, sample=t.sample, links=sorted(t.links), q=_fragment(t.text), tid=t.id, order=t.order))
    out = _fold_incidents(out)
    out.sort(key=lambda a: (-a['score'], a['from'], a.get('group', ''), a.get('template', '')))
    out = out[:LIMITS['max_anomalies']]
    for k, a in enumerate(out):
        a['id'] = f'a{k + 1}'
        a['link'] = viewer_query(a.get('links') or [], _parse_minute(a['from']), _parse_minute(a['to']), a.get('q') or '')
        a.pop('order', None)
        a['sources'] = len(a.get('links') or [])
        a.pop('links', None)
    return out


def _parse_minute(iso):
    return _minute(datetime.fromisoformat(iso))


def _short(text, n=110):
    return text if len(text) <= n else text[:n - 1] + '…'


# the words that name what an incident is (a kernel report's first lines are its context, not its headline)
_HEADLINE = re.compile(r'out of memory|oom-kill|invoked oom-killer|kernel panic|\bpanic\b|\bBUG\b|\boops\b|segfault|general protection|'
                       r'blocked for more than|soft lockup|hard lockup|i/o error|\bfatal\b', re.IGNORECASE)


def _fold_incidents(anoms):
    """New and rare templates of one source that appear in the same bucket are one incident: the headline is the most
    severe member that says warning or worse, else the member that names what happened (_HEADLINE: out of memory,
    panic, BUG, segfault...), else the earliest line; the severity the worst of them; the score the highest plus a
    little for each further line."""
    keep = []
    groups = defaultdict(list)
    for a in anoms:
        if a['kind'] in ('new', 'rare'):
            groups[(a['group'], a['first'])].append(a)
        else:
            keep.append(a)
    for (_group, _first), members in groups.items():
        if len(members) == 1:
            keep.append(members[0])
            continue
        # the headline: the most severe member when one says warning or worse, else the incident's first line (a
        # kernel report starts with what happened; 'Call Trace:' reads as a debug word and must not win)
        members.sort(key=lambda a: (SEV_RANK[a['severity']] if a['severity'] in ('critical', 'error', 'warning') else 9,
                                    0 if _HEADLINE.search(a['template']) else 1, a['order']))
        head = dict(members[0])
        head['kind'] = 'incident'
        worst = min((a['severity'] for a in members), key=lambda sv: SEV_RANK.get(sv, 5))
        if worst in ('critical', 'error', 'warning'):
            head['severity'] = worst   # else the headline's own level ('Call Trace' reads as debug: not the incident's)
        head['score'] = round(min(100.0, max(a['score'] for a in members) + 2.0 * (len(members) - 1)), 1)
        head['count'] = sum(a.get('count') or 0 for a in members)
        head['last'] = max(a['last'] for a in members)
        head['to'] = max(a['to'] for a in members)
        head['links'] = sorted({lk for a in members for lk in a.get('links') or []})
        head['members'] = [{'template': a['template'], 'severity': a['severity'], 'count': a.get('count') or 0, 'kind': a['kind']} for a in members]
        head['title'] = f"Incident: {_short(head['template'])} (+{len(members) - 1} related line{'s' if len(members) > 2 else ''})"
        keep.append(head)
    return keep


def _findings(result):
    """The Findings strip after an analysis: the top anomalies (at most 5), each with its Log Viewer link, after a
    summary line."""
    st = result['stats']
    out = []
    anoms = result.get('anomalies') or []
    run = st.get('run') or {}
    how = f"{run.get('workers', 1)} worker processes" if run.get('mode') == 'parallel' else 'one process'
    if not st.get('matched'):
        out.append(finding('info', 'No timestamped lines in the selected logs for this window',
                           f"{st.get('lines', 0):,} lines read, {st.get('outside', 0):,} outside the window, {st.get('undated', 0):,} without a time"))
        return out
    out.append(finding('info', f"{st['matched']:,} lines in {st['templates']:,} templates, {len(anoms)} anomal{'y' if len(anoms) == 1 else 'ies'}",
                       f"{st['files']} log{'s' if st['files'] != 1 else ''} read in {run.get('seconds', 0):g} s ({how}); every threshold is listed under Thresholds"))
    for a in anoms[:5]:
        sev = 'bad' if (a.get('severity') in ('critical', 'error') and a['score'] >= 50) or a['kind'] == 'errors' else 'warn'
        detail = a['when'] + (f" · {a['group']}" if a.get('group') else '')
        out.append(finding(sev, a['title'], detail, tab='log_collection', sub_tab='log_viewer', query=a['link']))
    if not anoms:
        out.append(finding('good', 'No anomaly in the selected logs for this window', 'no spike, burst, new, stopped or rare error message by the thresholds'))
    return sort_findings(out)
