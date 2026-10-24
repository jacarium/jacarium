"""The API audit logs of a must-gather (audit_logs/<apiserver>/<node>-audit*.log[.gz],
audit.k8s.io/v1 Events, one JSON object per line), aggregated for the
Audit page: who did what, what failed, what matters for security.

Streams every file (plain or gzip) line by line, never keeps the events:
everything is a counter or a bounded sample, so a multi-gigabyte
kube-apiserver log costs time, not memory. Only ResponseComplete events
(and Panic) count as requests: the ResponseStarted stage marks a watch
that is still running and would double count it; RequestReceived-only
lines (the server died mid-request) are counted apart. Malformed lines
are counted and skipped. Caps: lines per file, distinct keys per
counter (pruned to the most frequent), events per sample list, the
timeline's buckets (per minute, then thinned to at most 240 for the
chart). The scan is cached per directory while the files keep their
sizes and mtimes, so the page and its searches share one pass.

Like the other must-gather parsers: resolve_data_dir unwraps the image
directory, parse(directory) returns a dict, nothing here raises, a
report without audit_logs gives an empty-state result.
"""
import gzip
import heapq
import json
import os
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from parsers.mustgather._common import resolve_data_dir
from parsers.mustgather import audit_bodies, audit_profile

MAX_LINES_PER_FILE = 20_000_000
MAX_COUNTER_KEYS = 20_000       # a counter beyond this is pruned to KEEP_COUNTER_KEYS
KEEP_COUNTER_KEYS = 5_000
SAMPLE = 100                    # events kept per security list (with their raw JSON, so the pages stay light)
SLOWEST = 50
TOP = 25

RBAC_RESOURCES = {"roles", "rolebindings", "clusterroles", "clusterrolebindings"}
SENSITIVE_RESOURCES = {"namespaces", "secrets", "configmaps", "customresourcedefinitions", "nodes", "persistentvolumes", "persistentvolumeclaims",
                       "serviceaccounts", "oauthclients", "identities", "users", "groups", "machines", "machinesets", "clusteroperators", "clusterversions",
                       "securitycontextconstraints", "validatingwebhookconfigurations", "mutatingwebhookconfigurations", "apiservices", "networkpolicies", "egressfirewalls"} | RBAC_RESOURCES
WRITE_VERBS = {"create", "update", "patch", "delete", "deletecollection"}
DELETE_VERBS = {"delete", "deletecollection"}
READ_VERBS = {"get", "list", "watch"}
RE_AUDIT_FILE = re.compile(r'^(?P<node>.+?)-audit(?:-(?P<stamp>[0-9T:.-]+))?\.log(?P<gz>\.gz)?$')
RE_TS = re.compile(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?')

_cache = {}
_spans = {}   # (path, size, mtime) -> (first, last) requestReceivedTimestamp per file: the scan and the searches fill it, the searches skip files outside their time range by it


def remember_span(path, size, mtime, first, last):
    _spans[(path, size, mtime)] = (first, last)


def file_spans(files):
    """{path: (first, last) or None} for find_files() rows."""
    return {p: _spans.get((p, s, m)) for p, _, _, _, _, s, m in files}


def parse_ts(value):
    """'2026-10-12T12:40:12.123456Z' -> naive UTC datetime, or None."""
    if not isinstance(value, str):
        return None
    m = RE_TS.match(value)
    if not m:
        return None
    y, mo, d, h, mi, s, frac = m.groups()
    try:
        return datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), int((frac or '0').ljust(6, '0')))
    except ValueError:
        return None


def user_kind(username):
    if not username:
        return 'anonymous'
    if username.startswith('system:serviceaccount:'):
        return 'serviceaccount'
    if username.startswith('system:node:'):
        return 'node'
    if username.startswith('system:'):
        return 'system'
    return 'user'


def human_ms(ms):
    if ms is None:
        return ''
    if ms < 1000:
        return f"{ms:.0f} ms"
    if ms < 60000:
        return f"{ms / 1000:.1f} s"
    return f"{ms / 60000:.1f} min"


def human_size(size):
    if size is None:
        return ''
    if size < 1024:
        return f"{size} B"
    if size < 1024 ** 2:
        return f"{size / 1024:.1f} KiB"
    if size < 1024 ** 3:
        return f"{size / 1024 ** 2:.1f} MiB"
    return f"{size / 1024 ** 3:.2f} GiB"


# ---------------------------------------------------------------------------
# Finding the files
# ---------------------------------------------------------------------------
def find_files(root):
    """[(path, apiserver, node, rotated, gz, size, mtime)] of the audit files under audit_logs/."""
    base = os.path.join(root, 'audit_logs')
    found = []
    if not os.path.isdir(base):
        return found
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, base)
        if rel_dir == '.':
            continue
        apiserver = rel_dir.split(os.sep)[0]
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            if os.path.islink(path):
                continue
            m = RE_AUDIT_FILE.match(name)
            if m:
                node, rotated, gz = m.group('node'), bool(m.group('stamp')), bool(m.group('gz'))
            elif name in ('audit.log', 'audit.log.gz') or (name.startswith('audit') and name.endswith(('.log', '.log.gz'))):
                node, rotated, gz = os.path.basename(dirpath) if rel_dir.count(os.sep) else '', False, name.endswith('.gz')
            else:
                continue  # termination logs, locks, listings
            try:
                st = os.stat(path)
            except OSError:
                continue
            found.append((path, apiserver, node, rotated, gz, st.st_size, int(st.st_mtime)))
    return found


def iter_lines(path, gz):
    opener = gzip.open if gz else open
    try:
        with opener(path, 'rt', encoding='utf-8', errors='replace') as f:
            for n, line in enumerate(f, 1):
                if n > MAX_LINES_PER_FILE:
                    return
                yield line
    except (OSError, EOFError, ValueError):
        return


# ---------------------------------------------------------------------------
# The scan
# ---------------------------------------------------------------------------
class _Agg:
    def __init__(self):
        self.events = 0
        self.lines = 0
        self.malformed = 0
        self.started = 0          # ResponseStarted (running watches)
        self.received_only = 0    # RequestReceived
        self.panics = 0
        self.first = None
        self.last = None
        self.minute = defaultdict(lambda: [0, 0, Counter()])   # minute -> [total, errors, per apiserver]
        self.users = Counter(); self.user_errors = Counter(); self.user_kind = {}
        self.agents = Counter(); self.agent_errors = Counter()
        self.ips = Counter(); self.ip_errors = Counter()
        self.verbs = Counter(); self.verb_errors = Counter()
        self.resources = Counter(); self.resource_errors = Counter()
        self.namespaces = Counter(); self.namespace_errors = Counter()
        self.codes = Counter()
        self.fail_user = Counter(); self.fail_resource = Counter(); self.fail_verb = Counter()
        self.forbidden = 0; self.forbidden_reasons = Counter(); self.forbidden_users = Counter(); self.forbidden_sample = []
        self.throttled = 0; self.throttled_users = Counter(); self.throttled_sample = []
        self.sensitive = []; self.sensitive_total = 0
        self.rbac = []; self.rbac_total = 0
        self.secret_reads = 0; self.secret_readers = Counter(); self.secret_sample = []
        self.impersonation = 0; self.impersonation_pairs = Counter(); self.impersonation_sample = []
        self.slowest = []   # heap of (ms, seq, summary)
        self.seq = 0
        self.apiservers = defaultdict(lambda: {'events': 0, 'errors': 0, 'watches': 0, 'nodes': Counter(), 'files': 0, 'bytes': 0})
        self.nodes = Counter()
        self.deprecated = 0
        self.levels = Counter()
        self.server_errors = 0
        # the audit profile: bodies on writes / reads of non-sensitive resources, overall, per apiserver, per half of the capture
        self.profile = Counter()
        self.profile_api = defaultdict(Counter)
        self.profile_window = [Counter(), Counter()]
        self.window_split = None
        self.bodies_total = 0
        self.bodies = audit_bodies.BodyStore()   # the sampled events' unmasked bodies for Reveal (memory only)

    def prune(self):
        for c in (self.users, self.agents, self.ips, self.resources, self.namespaces, self.fail_user, self.fail_resource, self.forbidden_reasons,
                  self.forbidden_users, self.throttled_users, self.secret_readers, self.impersonation_pairs, self.user_errors, self.agent_errors, self.ip_errors,
                  self.resource_errors, self.namespace_errors):
            if len(c) > MAX_COUNTER_KEYS:
                keep = dict(c.most_common(KEEP_COUNTER_KEYS))
                c.clear(); c.update(keep)


def _summary(ev, user, verb, group, resource, ns, name, sub, code, apiserver, node, ts, ms, reason, raw):
    ip = (ev.get('sourceIPs') or [''])[0] if isinstance(ev.get('sourceIPs'), list) else ''
    imp = ev.get('impersonatedUser') if isinstance(ev.get('impersonatedUser'), dict) else None
    return {
        'ts': ts.strftime('%Y-%m-%d %H:%M:%S') if ts else '', 'ts_sort': ts.strftime('%Y-%m-%dT%H:%M:%S.%f') if ts else '',
        'user': user, 'kind': user_kind(user), 'impersonated': (imp or {}).get('username', '') if imp else '',
        'verb': verb, 'resource': f"{group}/{resource}" if group else resource, 'subresource': sub, 'namespace': ns, 'name': name,
        'code': code, 'ip': str(ip) if ip is not None else '', 'agent': str(ev.get('userAgent') or ''), 'apiserver': apiserver, 'node': node,
        'reason': reason, 'latency': human_ms(ms), 'latency_ms': round(ms, 1) if ms is not None else None,
        'raw': raw,
    }


def _pretty(ev, resource=''):
    """The event as pretty JSON, its bodies masked (credential values never reach a page)."""
    try:
        return json.dumps(audit_bodies.mask_body(ev, resource), indent=2, sort_keys=True, ensure_ascii=False)[:20000]
    except (TypeError, ValueError):
        return ''


def _scan(root, files):
    agg = _Agg()
    agg.window_split = _window_split(files)
    for path, apiserver, node, rotated, gz, size, mtime in files:
        api = agg.apiservers[apiserver]
        api['files'] += 1
        api['bytes'] += size
        f_first = f_last = None
        for line in iter_lines(path, gz):
            agg.lines += 1
            s = line.strip()
            if not s:
                continue
            try:
                ev = json.loads(s)
            except ValueError:
                agg.malformed += 1
                continue
            if not isinstance(ev, dict) or ev.get('kind') != 'Event' or 'verb' not in ev:
                agg.malformed += 1
                continue
            ts = parse_ts(ev.get('requestReceivedTimestamp')) or parse_ts(ev.get('stageTimestamp'))
            if ts:
                f_first = ts if f_first is None or ts < f_first else f_first
                f_last = ts if f_last is None or ts > f_last else f_last
            try:
                _consume(agg, ev, apiserver, node)
            except Exception:
                agg.malformed += 1
        if f_first and f_last:
            remember_span(path, size, mtime, f_first, f_last)
        if agg.lines % 200000 == 0:
            agg.prune()
    agg.prune()
    return agg


def _window_split(files):
    """The midpoint between the earliest and the latest requestReceivedTimestamp
    seen in the first and last lines of each file: splits the capture in two
    windows to tell a profile change during the capture."""
    stamps = []
    for path, _, _, _, gz, size, _ in files:
        if size > 64 * 1024 * 1024:
            continue
        first = last = None
        for line in iter_lines(path, gz):
            s = line.strip()
            if not s:
                continue
            try:
                ts = parse_ts(json.loads(s).get('requestReceivedTimestamp'))
            except (ValueError, AttributeError):
                continue
            if ts:
                first = first or ts
                last = ts
            if first and size > 2 * 1024 * 1024:
                break  # a large file: its first stamp is enough
        for ts in (first, last):
            if ts:
                stamps.append(ts)
    if len(stamps) < 2:
        return None
    lo, hi = min(stamps), max(stamps)
    return lo + (hi - lo) / 2 if hi > lo else None


def _consume(agg, ev, apiserver, node):
    stage = ev.get('stage')
    api = agg.apiservers[apiserver]
    if stage == 'ResponseStarted':
        agg.started += 1
        api['watches'] += 1
        return
    if stage == 'RequestReceived':
        agg.received_only += 1
        return
    if stage == 'Panic':
        agg.panics += 1
    agg.events += 1
    api['events'] += 1
    api['nodes'][node] += 1
    agg.nodes[node] += 1
    agg.levels[str(ev.get('level') or '')] += 1
    user_obj = ev.get('user') if isinstance(ev.get('user'), dict) else {}
    user = str(user_obj.get('username') or '') or 'anonymous'
    verb = str(ev.get('verb') or '').lower()
    ref = ev.get('objectRef') if isinstance(ev.get('objectRef'), dict) else {}
    group = str(ref.get('apiGroup') or '')
    resource = str(ref.get('resource') or '')
    sub = str(ref.get('subresource') or '')
    ns = str(ref.get('namespace') or '')
    name = str(ref.get('name') or '')
    status = ev.get('responseStatus') if isinstance(ev.get('responseStatus'), dict) else {}
    code = status.get('code')
    code = int(code) if isinstance(code, int) else 0
    ann = ev.get('annotations') if isinstance(ev.get('annotations'), dict) else {}
    agent = str(ev.get('userAgent') or '')
    ips = ev.get('sourceIPs') if isinstance(ev.get('sourceIPs'), list) else []
    ip = str(ips[0]) if ips else ''
    received = parse_ts(ev.get('requestReceivedTimestamp'))
    done = parse_ts(ev.get('stageTimestamp'))
    ts = received or done
    ms = (done - received).total_seconds() * 1000 if received and done else None
    error = code >= 400
    server_error = code >= 500

    if ts:
        if agg.first is None or ts < agg.first:
            agg.first = ts
        if agg.last is None or ts > agg.last:
            agg.last = ts
        bucket = agg.minute[ts.replace(second=0, microsecond=0)]
        bucket[0] += 1
        if error:
            bucket[1] += 1
        bucket[2][apiserver] += 1
    agg.users[user] += 1
    agg.user_kind[user] = user_kind(user)
    if agent:
        agg.agents[agent] += 1
    if ip:
        agg.ips[ip] += 1
    agg.verbs[verb] += 1
    res_key = (f"{group}/{resource}" if group else resource) + (f"/{sub}" if sub else '') if resource else '(none)'
    agg.resources[res_key] += 1
    if ns:
        agg.namespaces[ns] += 1
    agg.codes[code] += 1
    if 'k8s.io/deprecated' in ann:
        agg.deprecated += 1
    if error:
        api['errors'] += 1
        agg.user_errors[user] += 1
        if agent:
            agg.agent_errors[agent] += 1
        if ip:
            agg.ip_errors[ip] += 1
        agg.verb_errors[verb] += 1
        agg.resource_errors[res_key] += 1
        if ns:
            agg.namespace_errors[ns] += 1
        agg.fail_user[user] += 1
        agg.fail_resource[res_key] += 1
        agg.fail_verb[verb] += 1
        if server_error:
            agg.server_errors += 1
    reason = str(ann.get('authorization.k8s.io/reason') or '')
    has_body = isinstance(ev.get('requestObject'), (dict, list)) or isinstance(ev.get('responseObject'), dict)
    is_write = verb in audit_bodies.WRITE_VERBS
    if has_body:
        agg.bodies_total += 1
    if resource and resource not in audit_profile.EXCLUDED_RESOURCES and verb in audit_bodies.WRITE_VERBS | {'get', 'list', 'watch'}:
        which = 'write' if is_write else 'read'
        for c in (agg.profile, agg.profile_api[apiserver]):
            c[which] += 1
            if has_body:
                c[which + '_bodies'] += 1
        if ts and agg.window_split is not None:
            w = agg.profile_window[0 if ts < agg.window_split else 1]
            w[which] += 1
            if has_body:
                w[which + '_bodies'] += 1
    summary = None

    def summ():
        nonlocal summary
        if summary is None:
            summary = _summary(ev, user, verb, group, resource, ns, name, sub, code, apiserver, node, ts, ms, reason, _pretty(ev, resource))
            summary['level'] = str(ev.get('level') or '')
            summary['has_request_body'] = isinstance(ev.get('requestObject'), (dict, list))
            summary['has_response_body'] = isinstance(ev.get('responseObject'), dict)
            if summary['has_request_body'] or summary['has_response_body']:
                summary['request_body'], summary['request_truncated'] = audit_bodies.body_text(ev.get('requestObject'), resource) if summary['has_request_body'] else ('', False)
                summary['response_body'], summary['response_truncated'] = audit_bodies.body_text(ev.get('responseObject'), resource) if summary['has_response_body'] else ('', False)
                summary['patch_type'] = audit_bodies.patch_paths(ev.get('requestObject'), None, resource)[0] if verb == 'patch' else ''
                summary['audit_id'] = str(ev.get('auditID') or '')
                agg.bodies.keep(summary['audit_id'], ev.get('requestObject'), ev.get('responseObject'))
        return summary

    if code == 403 or ann.get('authorization.k8s.io/decision') == 'forbid':
        agg.forbidden += 1
        agg.forbidden_reasons[reason or status.get('message') or '(no reason recorded)'] += 1
        agg.forbidden_users[user] += 1
        if len(agg.forbidden_sample) < SAMPLE:
            agg.forbidden_sample.append(summ())
    if code == 429:
        agg.throttled += 1
        agg.throttled_users[user] += 1
        if len(agg.throttled_sample) < SAMPLE:
            agg.throttled_sample.append(summ())
    if verb in DELETE_VERBS and resource in SENSITIVE_RESOURCES:
        agg.sensitive_total += 1
        if len(agg.sensitive) < SAMPLE:
            agg.sensitive.append(summ())
    if resource in RBAC_RESOURCES and verb in WRITE_VERBS:
        agg.rbac_total += 1
        if len(agg.rbac) < SAMPLE:
            agg.rbac.append(summ())
    if resource == 'secrets' and verb in READ_VERBS and not user.startswith('system:') and code < 400:
        agg.secret_reads += 1
        agg.secret_readers[user] += 1
        if len(agg.secret_sample) < SAMPLE:
            agg.secret_sample.append(summ())
    imp = ev.get('impersonatedUser')
    if isinstance(imp, dict) and imp.get('username'):
        agg.impersonation += 1
        agg.impersonation_pairs[(user, str(imp.get('username')))] += 1
        if len(agg.impersonation_sample) < SAMPLE:
            agg.impersonation_sample.append(summ())
    if ms is not None and verb != 'watch' and ms > 0:
        agg.seq += 1
        entry = (ms, -agg.seq)
        if len(agg.slowest) < SLOWEST:
            heapq.heappush(agg.slowest, (entry, summ()))
        elif entry > agg.slowest[0][0]:
            heapq.heapreplace(agg.slowest, (entry, summ()))


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def _top(counter, errors=None, n=TOP, kinds=None):
    out = []
    for name, count in counter.most_common(n):
        item = {'name': name, 'count': count}
        if errors is not None:
            item['errors'] = errors.get(name, 0)
        if kinds is not None:
            item['kind'] = kinds.get(name, '')
        out.append(item)
    return out


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


def _timeline(agg):
    if not agg.minute:
        return None
    minutes = sorted(agg.minute)
    plan = bucket_plan(minutes, max_buckets=240, min_step=60)   # the capture's own timeline keeps the minute (spike detection) up to four hours
    step, key_of = plan['step'], plan['key_of']
    apiservers = sorted(agg.apiservers)
    by_key = {}
    for m in minutes:
        total, errors, per = agg.minute[m]
        b = by_key.setdefault(key_of(m), {'total': 0, 'errors': 0, 'per': Counter()})
        b['total'] += total
        b['errors'] += errors
        b['per'].update(per)
    buckets = []
    for it in plan['items']:
        if it['gap']:
            buckets.append({'gap': True, 'from': it['from'], 'to': it['to'], 'minutes': it['minutes'], 'label': it['label'], 't': '', 'total': None, 'errors': None, 'per': {}})
            continue
        v = by_key.get(it['t'], {'total': 0, 'errors': 0, 'per': Counter()})
        buckets.append({'t': it['t'].strftime('%Y-%m-%dT%H:%M:%S'), 'label': it['label'], 'total': v['total'], 'errors': v['errors'], 'per': {a: v['per'].get(a, 0) for a in apiservers},
                        'window': it['window'], 'start': it['start'], 'gap': False})
    real = [b for b in buckets if not b['gap']]
    totals = [b['total'] for b in real]
    n = len(totals)
    mean = sum(totals) / n
    var = sum((t - mean) ** 2 for t in totals) / n
    std = var ** 0.5
    median = sorted(totals)[n // 2]
    spikes = [i for i, b in enumerate(buckets) if not b['gap'] and n >= 5 and b['total'] > mean + 3 * std and b['total'] > 2 * median and b['total'] >= 20]
    return {
        'step_minutes': step, 'step_seconds': plan['step_seconds'], 'buckets': buckets, 'apiservers': apiservers, 'max': max(totals), 'spikes': spikes, 'mean': round(mean, 1),
        'spike_labels': [buckets[i]['t'][11:16] for i in spikes],
        'windows': [{'first': a.strftime('%Y-%m-%d %H:%M'), 'last': b.strftime('%Y-%m-%d %H:%M'), 'minutes': int((b - a).total_seconds() // 60) + 1} for a, b in plan['windows']],
        'gaps': plan['gaps'], 'active_minutes': plan['active_minutes'], 'wall_minutes': plan['wall_minutes'],
    }


def build(agg, files, root, directory):
    first = agg.first.strftime('%Y-%m-%d %H:%M:%S') if agg.first else ''
    last = agg.last.strftime('%Y-%m-%d %H:%M:%S') if agg.last else ''
    span = (agg.last - agg.first).total_seconds() if agg.first and agg.last else 0
    timeline = _timeline(agg)
    # the active time: the capture windows added up (a lab powered off for a day in the middle of the capture counts its minutes of events, not the hole)
    capture_windows = (timeline or {}).get('windows') or []
    active = sum(w['minutes'] for w in capture_windows) * 60 if len(capture_windows) > 1 else span
    codes = sorted(agg.codes.items())
    classes = Counter()
    for code, n in codes:
        classes[f"{code // 100}xx" if code else 'none'] += n
    errors = sum(n for code, n in agg.codes.items() if code >= 400)
    per_api = []
    for name in sorted(agg.apiservers):
        a = agg.apiservers[name]
        per_api.append({'name': name, 'events': a['events'], 'errors': a['errors'], 'watches': a['watches'], 'files': a['files'], 'bytes': a['bytes'], 'size_text': human_size(a['bytes']),
                        'nodes': [{'name': n, 'count': c} for n, c in a['nodes'].most_common()]})
    slowest = [s for _, s in sorted(agg.slowest, key=lambda x: -x[0][0])]
    windows = []
    if agg.window_split is not None:
        windows = [('first half (until ' + agg.window_split.strftime('%H:%M') + ')', agg.profile_window[0]), ('second half', agg.profile_window[1])]
    profile = audit_profile.describe(root, agg.profile, dict(agg.profile_api), windows)
    file_rows = [{'apiserver': a, 'node': n, 'name': os.path.basename(p), 'rotated': r, 'gz': g, 'size': s, 'size_text': human_size(s)} for p, a, n, r, g, s, _ in files]
    return {
        'available': agg.events > 0 or agg.lines > 0, 'reason': '' if files else 'This must-gather has no audit_logs/ directory (gather with --image-stream or the audit-logs gather).',
        'root': os.path.basename(root.rstrip('/')), 'image_dir': os.path.basename(root.rstrip('/')) if root != directory else '',
        'files': file_rows, 'totals': {
            'events': agg.events, 'lines': agg.lines, 'malformed': agg.malformed, 'started': agg.started, 'received_only': agg.received_only, 'panics': agg.panics,
            'files': len(files), 'bytes': sum(f[5] for f in files), 'size_text': human_size(sum(f[5] for f in files)), 'apiservers': len(agg.apiservers), 'nodes': len(agg.nodes),
            'errors': errors, 'error_pct': round(100.0 * errors / agg.events, 1) if agg.events else 0.0, 'server_errors': agg.server_errors,
            'forbidden': agg.forbidden, 'throttled': agg.throttled, 'sensitive': agg.sensitive_total, 'rbac': agg.rbac_total, 'secret_reads': agg.secret_reads,
            'impersonation': agg.impersonation, 'deprecated': agg.deprecated, 'users': len(agg.users), 'agents': len(agg.agents), 'ips': len(agg.ips), 'namespaces': len(agg.namespaces),
            'per_minute': round(agg.events / (active / 60), 1) if active >= 60 else agg.events,
        },
        'time': {'first': first, 'last': last, 'span_seconds': int(span), 'span_text': human_ms(span * 1000) if span else '',
                 'windows': len(capture_windows), 'active_seconds': int(active), 'active_text': human_duration(active / 60) if active else '',
                 'wall_text': human_duration(span / 60) if span else '',
                 'gaps': [{'from': g['from'], 'to': g['to'], 'label': g['label'], 'minutes': g['minutes']} for g in (timeline or {}).get('gaps') or []]},
        'timeline': timeline,
        'users': _top(agg.users, agg.user_errors, kinds=agg.user_kind), 'service_accounts': _top(Counter({u: c for u, c in agg.users.items() if agg.user_kind.get(u) == 'serviceaccount'}), agg.user_errors),
        'humans': _top(Counter({u: c for u, c in agg.users.items() if agg.user_kind.get(u) == 'user'}), agg.user_errors),
        'agents': _top(agg.agents, agg.agent_errors), 'ips': _top(agg.ips, agg.ip_errors), 'verbs': _top(agg.verbs, agg.verb_errors, n=20),
        'resources': _top(agg.resources, agg.resource_errors, n=40), 'namespaces': _top(agg.namespaces, agg.namespace_errors, n=40),
        'codes': [{'code': code, 'count': n, 'cls': f"{code // 100}xx" if code else 'none'} for code, n in codes], 'code_classes': [{'name': k, 'count': v} for k, v in sorted(classes.items())],
        'failures': {'by_user': _top(agg.fail_user, kinds=agg.user_kind), 'by_resource': _top(agg.fail_resource), 'by_verb': _top(agg.fail_verb)},
        'forbidden': {'count': agg.forbidden, 'reasons': _top(agg.forbidden_reasons, n=15), 'users': _top(agg.forbidden_users, kinds=agg.user_kind), 'events': agg.forbidden_sample},
        'throttled': {'count': agg.throttled, 'users': _top(agg.throttled_users, kinds=agg.user_kind), 'events': agg.throttled_sample},
        'sensitive_deletes': {'count': agg.sensitive_total, 'events': agg.sensitive},
        'rbac_changes': {'count': agg.rbac_total, 'events': agg.rbac},
        'secret_reads': {'count': agg.secret_reads, 'users': _top(agg.secret_readers, kinds=agg.user_kind), 'events': agg.secret_sample},
        'impersonation': {'count': agg.impersonation, 'pairs': [{'user': u, 'as': a, 'count': c} for (u, a), c in agg.impersonation_pairs.most_common(TOP)], 'events': agg.impersonation_sample},
        'slowest': slowest,
        'apiservers': per_api, 'nodes': [{'name': n, 'count': c} for n, c in agg.nodes.most_common()],
        'sample': SAMPLE, 'levels': [{'name': k, 'count': v} for k, v in agg.levels.most_common()],
        'profile': profile, 'bodies_total': agg.bodies_total,
    }


def body(directory, audit_id, part):
    """The unmasked request / response body of an event, for the per-event
    Reveal: a sampled event of the scan or an event an Events search
    returned (both keep their bodies in a bounded memory store); served on
    demand, never in a page's initial HTML."""
    root = resolve_data_dir(directory)
    hit = _cache.get(root)
    if not hit:
        scan(directory)
        hit = _cache.get(root)
    store = hit[1].get('_bodies') if hit else None
    if part not in ('request', 'response'):
        return None
    text = store.body(str(audit_id or ''), part) if store is not None else None
    if text is None:
        from parsers.mustgather import audit_search
        text = audit_search.stored_body(directory, audit_id, part)
    return text


def scan(directory):
    """The aggregated audit logs of a must-gather, cached per directory while
    the files keep their sizes and mtimes (the page and the search share it)."""
    root = resolve_data_dir(directory)
    files = find_files(root)
    key = (root, tuple((p, s, m) for p, _, _, _, _, s, m in files))
    hit = _cache.get(root)
    if hit and hit[0] == key:
        return hit[1]
    try:
        agg = _scan(root, files)
        result = build(agg, files, root, directory)
        result['_bodies'] = agg.bodies   # the sampled events' unmasked bodies for Reveal (memory only; the tab modules copy the keys they show)
    except Exception as exc:  # never a 500 for a tab: an empty state with the reason
        result = build(_Agg(), [], root, directory)
        result['available'] = False
        result['reason'] = f'The audit logs could not be read: {exc.__class__.__name__}.'
    _cache.clear()
    _cache[root] = (key, result)
    return result


def parse(directory):
    return {'audit_logs': scan(directory)}
