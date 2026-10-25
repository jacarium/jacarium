"""The must-gather Log Viewer's data: the sources a gather holds and a paged, cancellable search over them.
The presentation is the shared viewer (tabs/_log_view.html, diagnostics-ui.js diagLogView); this module is the
must-gather adapter's server side.

    parse(directory)  -> {'available_logs': [source, ...], 'unavailable_logs': [], 'date_range': {start, end},
                          'counts': {...}, 'findings': [...]}
        source = {'name': 'ns/pod/container (current)', 'path': '<absolute>', 'size': bytes, 'type': 'container',
                  'group': 'Containers: <ns>', 'kind': 'current' | 'previous' | 'previous.insecure',
                  'namespace', 'pod', 'container'}
        The registry: the container logs (namespaces/<ns>/pods/<pod>/<container>/<container>/logs/*.log), the host
        service logs (host_service_logs/<role>/<service>.log), the node journals (nodes/<node>/*journal*), the
        network logs (network_logs/*.log). Capped at MAX_SOURCES (the largest kept); a finding says so.
    search(directory, params) -> {'ok', 'entries', 'cursor', 'done', 'scanned', 'files', 'seconds', 'truncated'}
        params: paths, start, end, limit, cursor, and the filters applied while scanning - query / exclude (lists of
        plain substrings, any-of / none-of, lower-cased), level, source (the source_key of a row)
        params: paths (inside the gather), start / end (ISO minute strings), cursor (from the last answer),
        limit (rows per page, up to MAX_LIMIT), query / exclude (lists of lower-cased terms, any of them), level.
        One call reads from the cursor until `limit` rows match or BUDGET_SECONDS pass, then answers with the cursor
        to continue from (file index + byte offset): the page keeps asking while the cursor is set, and a cancel()
        (or a newer search over the same gather) stops the running call. A row is the shared viewer's:
        {timestamp, timestamp_obj, severity, hostname (ns/pod or the node), process (container or service), pid,
        message, badges ([{kind, text}] for a previous log, a stderr line)}.
    date_range(directory, sources) -> {'start', 'end', 'files', 'timestamped', 'untimestamped': [names], 'empty': [names]}
        The earliest and latest timestamps of the selected logs from the head and tail of each (SAMPLE_BYTES each,
        .gz read through gzip), with every line format the search knows: the CRI prefix, RFC3339 at the line start,
        klog (I1025 10:00:00.123456), JSON ("ts" / "time" / "timestamp" / "@timestamp", ISO or epoch), logfmt
        (ts= / time=), a journal line in any of journalctl's forms (short, short-precise, short-iso,
        short-iso-precise, short-full: parse_journal_line, shared with the sosreport parser), a [bracketed] ISO
        time. A log with none of them is named in `untimestamped`,
        never an error: the search reads it whole, every line a row without a time, in file order. A log without a
        single non-blank line is named in `empty` instead (a previous run that wrote nothing is the common case).
    chosen_sources(paths, directory) -> (sources, error): the paths that are listed and inside the gather
    cancel(directory)
"""
import gzip
import os
import re
import threading
import time
from datetime import datetime, timezone

from parsers.findings import finding, no_data, recall, remember, sort_findings
from parsers.mustgather._common import resolve_data_dir, collection_time
from parsers.sosreport.log_viewer import classify_severity, parse_journal_line

MAX_SOURCES = 4000
MAX_LIMIT = 5000
BUDGET_SECONDS = 1.5
MAX_LINE = 4000
CHECK_EVERY = 2000
SAMPLE_BYTES = 65536
CONTAINER_LINE = re.compile(r'^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})?\s+(stdout|stderr)\s+([FP])\s?(.*)$')
ISO_LINE = re.compile(r'^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})?\s+(.*)$')
KLOG_LINE = re.compile(r'^[IWEF](\d{2})(\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s+\d+\s+\S+\]\s?(.*)$')
BRACKET_LINE = re.compile(r'^\[(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]\s*(.*)$')
JSON_TS = re.compile(r'"(?:ts|time|timestamp|@timestamp|Timestamp)"\s*:\s*"?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})')
JSON_EPOCH = re.compile(r'"(?:ts|time|timestamp)"\s*:\s*(\d{9,13})(?:\.\d+)?')
LOGFMT_TS = re.compile(r'(?:^|\s)(?:ts|time|timestamp)=\"?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})')
PROBE_LINES = 60

_lock = threading.Lock()
_generation = {}


# ---------------------------------------------------------------- the sources

def _size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return None


def sources_of(directory):
    """Every log the gather holds, as the viewer's picker lists them: the container logs grouped by namespace, then
    the host service logs, the node journals and the network logs. Symlinks are not followed."""
    root = resolve_data_dir(directory)
    out = []
    ns_dir = os.path.join(root, 'namespaces')
    if os.path.isdir(ns_dir):
        for ns in sorted(os.listdir(ns_dir)):
            pods = os.path.join(ns_dir, ns, 'pods')
            if not os.path.isdir(pods):
                continue
            for pod in sorted(os.listdir(pods)):
                pod_dir = os.path.join(pods, pod)
                if not os.path.isdir(pod_dir) or os.path.islink(pod_dir):
                    continue
                for container in sorted(os.listdir(pod_dir)):
                    logs = os.path.join(pod_dir, container, container, 'logs')
                    if not os.path.isdir(logs):
                        continue
                    # current first, then previous, then previous.insecure (the plain sort puts the insecure one before previous)
                    for fn in sorted((f for f in os.listdir(logs) if f.endswith('.log') or f.endswith('.log.gz')), key=lambda f: ({'current.log': 0, 'previous.log': 1}.get(f, 2), f)):
                        p = os.path.join(logs, fn)
                        if os.path.islink(p) or not os.path.isfile(p):
                            continue
                        kind = fn[:-7] if fn.endswith('.gz') else fn[:-4]
                        out.append({'name': f'{ns}/{pod}/{container} ({kind})', 'path': p, 'size': _size(p) or 0, 'type': 'container',
                                    'group': f'Containers: {ns}', 'kind': kind, 'namespace': ns, 'pod': pod, 'container': container})
    host = os.path.join(root, 'host_service_logs')
    if os.path.isdir(host):
        for role in sorted(os.listdir(host)):
            role_dir = os.path.join(host, role)
            if not os.path.isdir(role_dir):
                continue
            for fn in sorted(os.listdir(role_dir)):
                p = os.path.join(role_dir, fn)
                if os.path.islink(p) or not os.path.isfile(p) or not (fn.endswith('.log') or fn.endswith('.log.gz')):
                    continue
                service = (fn[:-7] if fn.endswith('.gz') else fn[:-4]).replace('_service', '')
                out.append({'name': f'{role}/{fn}', 'path': p, 'size': _size(p) or 0, 'type': 'host', 'group': 'Host services', 'kind': 'current',
                            'role': role, 'service': service})
    nodes = os.path.join(root, 'nodes')
    if os.path.isdir(nodes):
        for node in sorted(os.listdir(nodes)):
            node_dir = os.path.join(nodes, node)
            if not os.path.isdir(node_dir):
                continue
            for fn in sorted(os.listdir(node_dir)):
                p = os.path.join(node_dir, fn)
                if os.path.islink(p) or not os.path.isfile(p) or 'journal' not in fn.lower():
                    continue
                out.append({'name': f'{node}/{fn}', 'path': p, 'size': _size(p) or 0, 'type': 'node', 'group': 'Nodes', 'kind': 'current', 'node': node})
    net = os.path.join(root, 'network_logs')
    if os.path.isdir(net):
        for fn in sorted(os.listdir(net)):
            p = os.path.join(net, fn)
            if os.path.islink(p) or not os.path.isfile(p) or not fn.endswith('.log'):
                continue
            out.append({'name': f'network_logs/{fn}', 'path': p, 'size': _size(p) or 0, 'type': 'network', 'group': 'Network', 'kind': 'current'})
    return out


def _open(path):
    """The log as a binary stream (gzip for .gz): tell() / seek() give uncompressed offsets either way."""
    return gzip.open(path, 'rb') if path.endswith('.gz') else open(path, 'rb')


def _bounds(path, year, ref=None):
    """(first, last) timestamps of a log from its head and tail (SAMPLE_BYTES each; a .gz is read through, its last
    SAMPLE_BYTES kept); (None, None) when no line carries one."""
    first = last = None
    try:
        if path.endswith('.gz'):
            with gzip.open(path, 'rb') as f:
                data = f.read(SAMPLE_BYTES)
                head = data.decode('utf-8', 'replace').split('\n')
                last_chunk = data
                while True:
                    chunk = f.read(SAMPLE_BYTES)
                    if not chunk:
                        break
                    last_chunk = chunk if len(chunk) >= SAMPLE_BYTES else (last_chunk + chunk)[-SAMPLE_BYTES:]
                tail = last_chunk.decode('utf-8', 'replace').split('\n')[1:] if last_chunk is not data else head
        else:
            size = os.path.getsize(path)
            with open(path, 'rb') as f:
                head = f.read(SAMPLE_BYTES).decode('utf-8', 'replace').split('\n')
                if size > SAMPLE_BYTES:
                    f.seek(max(0, size - SAMPLE_BYTES))
                    tail = f.read().decode('utf-8', 'replace').split('\n')[1:]
                else:
                    tail = head
    except OSError:
        return None, None
    for line in head:
        t = _timestamp_of(line, year, ref)
        if t:
            first = t
            break
    for line in reversed(tail):
        t = _timestamp_of(line, year, ref)
        if t:
            last = t
            break
    return first, last


def _iso(date, clock):
    try:
        return datetime.strptime(date + 'T' + clock, '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        return None


def _timestamp_of(line, year, ref=None):
    """The time a log line states, in every format the gathers carry; None when it states none."""
    m = CONTAINER_LINE.match(line) or ISO_LINE.match(line) or BRACKET_LINE.match(line)
    if m:
        return _iso(m.group(1), m.group(2))
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
            return _iso(m.group(1), m.group(2))
        m = JSON_EPOCH.search(head)
        if m:
            n = int(m.group(1))
            try:
                return datetime.fromtimestamp(n / 1000 if n > 10 ** 11 else n, tz=timezone.utc).replace(tzinfo=None, microsecond=0)
            except (OverflowError, OSError, ValueError):
                return None
    m = LOGFMT_TS.search(head)
    if m:
        return _iso(m.group(1), m.group(2))
    return None


def chosen_sources(paths, directory):
    """The selected paths that the gather lists and that resolve inside it, as sources; (sources, error)."""
    if not isinstance(paths, list) or not paths:
        return None, 'no log selected'
    root = os.path.realpath(resolve_data_dir(directory))
    known = {src['path']: src for src in sources_of(directory)}
    chosen = []
    for item in paths:
        if not isinstance(item, str):
            continue
        real = os.path.realpath(os.path.expanduser(item))
        if not (real == root or real.startswith(root + os.sep)):
            continue
        src = known.get(os.path.expanduser(item)) or known.get(real)
        if src and src not in chosen:
            chosen.append(src)
    if not chosen:
        return None, 'none of the selected logs is one this must-gather lists'
    return chosen, None


def _has_lines(path):
    """Whether the log holds any non-blank line (its first SAMPLE_BYTES decide)."""
    try:
        with _open(path) as f:
            return bool(f.read(SAMPLE_BYTES).strip())
    except OSError:
        return False


def date_range(directory, sources):
    """The earliest / latest timestamps of the selected logs, and the logs without any: see the module docstring."""
    year = _year_of(directory)
    ref = _ref_of(directory)
    first = last = None
    untimestamped = []
    empty = []
    for src in sources:
        a, b = _bounds(src['path'], year, ref)
        if a is None and b is None:
            (untimestamped if _has_lines(src['path']) else empty).append(src['name'])
            continue
        if a and (first is None or a < first):
            first = a
        if b and (last is None or b > last):
            last = b
        if a and last is None:
            last = a
        if b and first is None:
            first = b
    return {'start': first.isoformat() if first else None, 'end': last.isoformat() if last else None, 'files': len(sources),
            'timestamped': len(sources) - len(untimestamped) - len(empty), 'untimestamped': untimestamped, 'empty': empty}


def _year_of(directory):
    try:
        return collection_time(directory).year
    except Exception:  # noqa: BLE001 - a missing timestamp file: this year
        return datetime.now().year


def _ref_of(directory):
    """The gather's own time (its timestamp file), naive; None without the file. A year-less journal line later
    than it by more than a month is last year's."""
    if not os.path.exists(os.path.join(directory, 'timestamp')):
        return None
    try:
        return collection_time(directory).replace(tzinfo=None)
    except Exception:  # noqa: BLE001 - an unreadable timestamp file
        return None


def parse(directory):
    year = _year_of(directory)
    ref = _ref_of(directory)
    sources = sources_of(directory)
    counts = {'container': 0, 'host': 0, 'node': 0, 'network': 0, 'namespaces': len({s.get('namespace') for s in sources if s['type'] == 'container'}), 'previous': 0}
    for s in sources:
        counts[s['type']] = counts.get(s['type'], 0) + 1
        if s['kind'].startswith('previous'):
            counts['previous'] += 1
    capped = 0
    if len(sources) > MAX_SOURCES:
        # the largest kept, every host / node / network log kept
        keep = [s for s in sources if s['type'] != 'container']
        containers = sorted((s for s in sources if s['type'] == 'container'), key=lambda s: -s['size'])[:max(0, MAX_SOURCES - len(keep))]
        capped = len(sources) - len(keep) - len(containers)
        kept = {s['path'] for s in keep + containers}
        sources = [s for s in sources if s['path'] in kept]
    # the initial slider bounds: the head and tail of the largest few logs
    first = last = None
    for s in sorted(sources, key=lambda s: -s['size'])[:12]:
        a, b = _bounds(s['path'], year, ref)
        if a and (first is None or a < first):
            first = a
        if b and (last is None or b > last):
            last = b
    gather = None
    if os.path.exists(os.path.join(directory, 'timestamp')):   # the gather's own time (collection_time falls back to now without the file: never that)
        try:
            gather = collection_time(directory).replace(tzinfo=None)
        except Exception:  # noqa: BLE001 - an unreadable timestamp file
            gather = None
    if (first is None or last is None) and gather is not None:
        # nothing dated in the sampled logs: the gather's own day stands in (never the day the page is opened)
        first = first or gather.replace(hour=0, minute=0, second=0, microsecond=0)
        last = last or gather
    result = {
        'available_logs': sources,
        'unavailable_logs': [],
        'date_range': {'start': first.isoformat() if first else None, 'end': last.isoformat() if last else None},
        'gather_time': gather.isoformat() if gather else None,
        'counts': counts, 'capped': capped, 'year': year,
    }
    result['findings'] = findings_for(result)
    remember(('mg_log_viewer', resolve_data_dir(directory)), result['findings'])
    return result


def findings(directory):
    return recall(('mg_log_viewer', resolve_data_dir(directory)), lambda: parse(directory)['findings'])


def findings_for(result):
    out = []
    c = result['counts']
    total = len(result['available_logs'])
    if not total:
        out.append(no_data('No container or host logs in this must-gather', ['namespaces/*/pods/*/*/*/logs', 'host_service_logs', 'nodes'], 'trimmed gather'))
        return out
    parts = []
    if c['container']:
        parts.append(f"{c['container']} container log{'s' if c['container'] != 1 else ''} in {c['namespaces']} namespace{'s' if c['namespaces'] != 1 else ''}" + (f" ({c['previous']} previous)" if c['previous'] else ''))
    if c['host']:
        parts.append(f"{c['host']} host service log{'s' if c['host'] != 1 else ''}")
    if c.get('node'):
        parts.append(f"{c['node']} node journal{'s' if c['node'] != 1 else ''}")
    if c.get('network'):
        parts.append(f"{c['network']} network log{'s' if c['network'] != 1 else ''}")
    rng = result['date_range']
    span = f", {rng['start'][:16].replace('T', ' ')} to {rng['end'][:16].replace('T', ' ')}" if rng.get('start') and rng.get('end') else ''
    out.append(finding('info', ', '.join(parts) + span, 'pick the logs (a failing pod\'s previous log first) and a date range, then Load Logs; the search, the level and the container filters work on what is loaded'))
    if result.get('capped'):
        out.append(finding('info', f"{result['capped']} smaller container logs not listed", f'the picker shows the largest {MAX_SOURCES}; the Log Collection page lists every file'))
    out.append(finding('info', 'The API audit logs are on the Audit page', 'audit_logs/ is searched there, by user, verb, resource and time', tab='audit'))
    return sort_findings(out)


# ---------------------------------------------------------------- the search

def _begin(root):
    with _lock:
        _generation[root] = _generation.get(root, 0) + 1
        return _generation[root]


def _current(root, mine):
    return _generation.get(root) == mine


def cancel(directory):
    """Stop the running search of a gather (a new search over it does this itself)."""
    _begin(resolve_data_dir(directory))


def _parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace('Z', ''))
    except ValueError:
        return None


def _container_row(ts, message, source, stderr=False):
    badges = []
    if source['kind'] != 'current':
        badges.append({'kind': 'muted', 'text': source['kind'], 'title': 'the log of the container\'s previous run'})
    if stderr:
        badges.append({'kind': 'muted', 'text': 'stderr'})
    return {'timestamp': ts.strftime('%b %d %H:%M:%S') if ts else '', 'timestamp_obj': ts.isoformat() if ts else '', 'severity': classify_severity(message),
            'hostname': f"{source['namespace']}/{source['pod']}", 'process': source['container'], 'pid': '', 'message': message, 'badges': badges, 'src': 'container'}


def _row(line, source, year, untimestamped=False, ref=None):
    """One log line as the viewer's row, or None when it carries no timestamp (a continuation line is folded into
    the message of the row before it by the caller). In a log without timestamps (untimestamped) every line is a
    row without a time, in file order."""
    if source['type'] == 'container':
        m = CONTAINER_LINE.match(line)
        if m:
            ts = _iso(m.group(1), m.group(2))
            return _container_row(ts, m.group(6), source, m.group(4) == 'stderr')
        # the raw container output (oc adm inspect, kubectl logs): the time in whatever format the program writes
        ts = _timestamp_of(line, year, ref)
        if ts is not None:
            m2 = ISO_LINE.match(line) or BRACKET_LINE.match(line)
            message = m2.group(m2.re.groups) if m2 else line
            return _container_row(ts, message, source)
        if untimestamped and line.strip():
            return _container_row(None, line, source)
        return None
    # a journal line (host service logs, node journals, any of journalctl's forms): the node it names, the service
    # and its pid, the message without the prefix; a line that states no level is info (a journal's normal line)
    j = parse_journal_line(line, year, ref)
    if j:
        sev = classify_severity(j['message'])
        return {'timestamp': j['ts'].strftime('%b %d %H:%M:%S'), 'timestamp_obj': j['ts'].isoformat(), 'severity': 'info' if sev == 'other' else sev,
                'hostname': j['host'], 'process': j['process'], 'pid': j['pid'], 'message': j['message'], 'badges': [], 'src': source['type'],
                'service': source.get('service') or ''}
    ts = _timestamp_of(line, year, ref)
    if ts is not None or (untimestamped and line.strip()):
        m = ISO_LINE.match(line) or BRACKET_LINE.match(line)
        message = m.group(m.re.groups) if m else line
        return {'timestamp': ts.strftime('%b %d %H:%M:%S') if ts else '', 'timestamp_obj': ts.isoformat() if ts else '', 'severity': classify_severity(message),
                'hostname': source.get('node') or source.get('role') or '', 'process': source.get('service') or source.get('name', ''), 'pid': '', 'message': message, 'badges': [], 'src': source['type'],
                'service': source.get('service') or ''}
    return None


def _has_timestamps(path, year, ref=None):
    """Whether the first PROBE_LINES non-empty lines of a log carry a time (a log without one loads whole)."""
    try:
        with _open(path) as f:
            seen = 0
            for raw in f:
                line = raw.decode('utf-8', 'replace').rstrip('\n\r')
                if not line.strip():
                    continue
                if _timestamp_of(line, year, ref) is not None:
                    return True
                seen += 1
                if seen >= PROBE_LINES:
                    break
    except OSError:
        return True
    return False


def validate(params, directory):
    """The search parameters checked field by field: the paths inside the gather and listed by sources_of, the
    dates ISO, the limit capped, the cursor an index + offset pair, the terms lower-cased strings. (query, error)."""
    if not isinstance(params, dict):
        return None, 'a JSON object is expected'
    chosen, err = chosen_sources(params.get('paths') or params.get('log_paths') or [], directory)
    if err:
        return None, err
    start, end = _parse_iso(params.get('start') or params.get('start_date')), _parse_iso(params.get('end') or params.get('end_date'))
    if (params.get('start') or params.get('start_date')) and not start:
        return None, 'the start date is not an ISO timestamp'
    if (params.get('end') or params.get('end_date')) and not end:
        return None, 'the end date is not an ISO timestamp'
    try:
        limit = 2000 if params.get('limit') is None else max(1, min(MAX_LIMIT, int(params.get('limit'))))
    except (TypeError, ValueError):
        return None, 'the limit is not a number'
    cursor = params.get('cursor')
    if cursor is not None:
        if not isinstance(cursor, dict) or not isinstance(cursor.get('file'), int) or not isinstance(cursor.get('offset'), int) or cursor['file'] < 0 or cursor['offset'] < 0:
            return None, 'the cursor is not one this search answered'
        if cursor['file'] >= len(chosen):
            return None, 'the cursor points past the selected logs'
    def terms(key):
        # plain substrings (no pattern), lower-cased, at most 20 of at most 200 characters; None when not strings
        v = params.get(key) or []
        if isinstance(v, str):
            v = [v]
        if not isinstance(v, list) or any(not isinstance(t, str) for t in v):
            return None
        return [t.lower()[:200] for t in v if t.strip()][:20]
    query, exclude = terms('query'), terms('exclude')
    if query is None or exclude is None:
        return None, 'a search term is not a string'
    level = params.get('level') or ''
    if level and level not in ('critical', 'error', 'warning', 'info', 'debug', 'other'):
        return None, 'the level is not one of critical, error, warning, info, debug, other'
    source = params.get('source') or ''
    if not isinstance(source, str) or len(source) > 300:
        return None, 'the source is not a name'
    return {'sources': chosen, 'start': start, 'end': end, 'limit': limit, 'cursor': cursor or {'file': 0, 'offset': 0}, 'query': query, 'exclude': exclude, 'level': level, 'source': source}, None


def source_key(row):
    """The key the viewer groups a row by (its source select and chart): the container's ns/pod/container, a host
    service's host:<service>, a node journal's node:<node>."""
    src = row.get('src')
    if src == 'host':
        return 'host:' + (row.get('service') or row['process'])
    if src == 'node':
        return 'node:' + row['hostname']
    return f"{row['hostname']}/{row['process']}"


def search(directory, q, budget_seconds=BUDGET_SECONDS):
    """One page of the search: see the module docstring."""
    root = resolve_data_dir(directory)
    year = _year_of(directory)
    ref = _ref_of(directory)
    mine = _begin(root)
    t0 = time.monotonic()
    deadline = t0 + budget_seconds
    entries, scanned, lines_read = [], 0, 0
    fi, offset = q['cursor']['file'], q['cursor']['offset']
    sources = q['sources']
    cancelled = False
    truncated = 0
    while fi < len(sources):
        source = sources[fi]
        path = source['path']
        stop_here = False
        try:
            untimestamped = not _has_timestamps(path, year, ref)
            with _open(path) as f:
                f.seek(offset)
                last = None
                while True:
                    raw = f.readline()
                    if not raw:
                        break
                    offset = f.tell()
                    lines_read += 1
                    if lines_read % CHECK_EVERY == 0:
                        if not _current(root, mine):
                            cancelled = True
                            break
                        if time.monotonic() > deadline:
                            stop_here = True
                            break
                    line = raw.decode('utf-8', 'replace').rstrip('\n\r')
                    if len(line) > MAX_LINE:
                        line = line[:MAX_LINE] + ' …'
                        truncated += 1
                    row = _row(line, source, year, untimestamped, ref)
                    if row is None:
                        # a continuation line (a traceback, a wrapped message) belongs to the row before it
                        if last is not None and line.strip():
                            last['message'] += '\n' + line
                        continue
                    last = row
                    # the date range applies to dated rows; a log without timestamps loads whole, in file order
                    if row['timestamp_obj']:
                        if q['start'] and datetime.fromisoformat(row['timestamp_obj']) < q['start']:
                            continue
                        if q['end'] and datetime.fromisoformat(row['timestamp_obj']) > q['end']:
                            continue
                    if q['level'] and row['severity'] != q['level']:
                        continue
                    if q['source'] and source_key(row) != q['source']:
                        continue
                    if q['query'] or q['exclude']:
                        text = (row['hostname'] + ' ' + row['process'] + ' ' + row['message']).lower()
                        if q['query'] and not any(t in text for t in q['query']):
                            continue
                        if q['exclude'] and any(t in text for t in q['exclude']):
                            continue
                    entries.append(row)
                    if len(entries) >= q['limit']:
                        stop_here = True
                        break
        except OSError as e:
            entries.append({'timestamp': '', 'timestamp_obj': '', 'severity': 'error', 'hostname': '', 'process': source['name'], 'pid': '', 'message': f'this log could not be read: {e.strerror or e}', 'badges': [{'kind': 'bad', 'text': 'unreadable'}]})
        if cancelled:
            return {'ok': False, 'cancelled': True, 'error': 'cancelled', 'message': 'a newer search replaced this one', 'entries': [], 'cursor': None, 'done': True}
        if stop_here:
            break
        scanned += 1
        fi += 1
        offset = 0
    done = fi >= len(sources)
    return {'ok': True, 'entries': entries, 'cursor': None if done else {'file': fi, 'offset': offset}, 'done': done, 'scanned': scanned,
            'files': len(sources), 'seconds': round(time.monotonic() - t0, 3), 'lines': lines_read, 'truncated': truncated}
