"""Audit: an on-demand search over the must-gather's audit files (the
/audit_events_search route behind tabs/mustgather_audit.html), so any
event can be browsed, the successes too, not only the aggregates and the
capped samples of the scan.

Nothing is preloaded or stored: every search streams the files again,
newest file first (by the last timestamp the scan or an earlier search
noted per file), keeps the N newest matches in a bounded heap and counts
the rest. Files wholly outside the time range are skipped. Once N matches
are in hand and no remaining file can hold a newer one, the rest is
counting only, under a time budget: a search that runs out of budget
reports a partial count and the caller may ask to count all. A plain
substring test on the raw line (user, namespace, resource ...) spares the
JSON parse of lines that cannot match.

"Load older" is a cursor: the oldest returned event's (timestamp,
auditID); the next page takes only events strictly older than it, with
the same filters, and skips the count.

Every returned event is masked like the scan's samples (credential values
as bullets with a byte count); the unmasked bodies of the returned events
stay in a bounded in-memory store for the Reveal route, never in a
response's initial payload. One search runs per directory: a new one
cancels the running one; four searches at most run at once.
"""
import base64
import heapq
import json
import re
import threading
import time
from collections import Counter, OrderedDict
from datetime import datetime, timedelta

from parsers.mustgather._common import resolve_data_dir
from parsers.mustgather import audit_logs, audit_bodies

LIMIT_DEFAULT = 200
LIMIT_MAX = 1000
BUDGET_SECONDS = 20.0         # the count phase stops here (partial) unless count_all
COUNT_ALL_SECONDS = 300.0     # the hard stop even for count_all
MAX_TEXT = 300
MAX_SLOTS = 4                 # searches running at once, across directories
BODY_STORE = 1000             # unmasked bodies kept per directory for Reveal
MAX_DIFFS_OUT = 200           # diff rows returned per event
CHECK_EVERY = 4000            # lines between cancellation / budget checks

VERBS = ('get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', 'post', 'put', 'head', 'options', 'connect', 'proxy')
STATUS_CLASSES = ('2xx', '3xx', '4xx', '5xx', 'ok', 'error')
# The Category select's categories (the same rules as the scan's classification in audit_logs._consume); 'changes' = successful writes with bodies
PRESETS = ('forbidden', 'throttled', 'sensitive_deletes', 'rbac_changes', 'secret_reads', 'impersonation', 'deprecated', 'changes')
STATE_OBJECTS = 500           # objects whose latest state a search remembers, for the "old" side of a diff

RE_SAFE_NEEDLE = re.compile(r'^[a-z0-9._:/@-]+$')
RE_CURSOR = re.compile(r'^[A-Za-z0-9_=-]{1,800}$')
# the sorts: field -> (default direction, the status line's words for desc / asc)
SORTS = {'time': ('desc', 'newest first', 'oldest first'), 'latency': ('desc', 'slowest first', 'fastest first'), 'status': ('desc', 'highest status first', 'lowest status first'),
         'user': ('asc', 'user Z to A', 'user A to Z'), 'verb': ('asc', 'verb Z to A', 'verb A to Z'), 'object': ('asc', 'object Z to A', 'object A to Z')}
RE_CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')
RE_FULL_TS = re.compile(r'^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?Z?$')
RE_HHMM = re.compile(r'^(\d{1,2}):(\d{2})(?::(\d{2}))?$')

_lock = threading.Lock()
_generation = {}        # root -> the generation of the search allowed to run
_slots = threading.BoundedSemaphore(MAX_SLOTS)
_bodies = {}            # root -> OrderedDict(audit_id -> (request_object, response_object))


class Cancelled(Exception):
    pass


# ---------------------------------------------------------------------------
# Validation: a query is a dict of plain strings, a list of known verbs and
# small integers; regexes are never interpreted, every text filter is a
# substring test on lowercased text.
# ---------------------------------------------------------------------------
def _text(raw, key, limit=MAX_TEXT):
    v = raw.get(key)
    if v is None or v == '':
        return ''
    if not isinstance(v, str):
        raise ValueError(f"{key} must be text")
    if len(v) > limit:
        raise ValueError(f"{key}: at most {limit} characters")
    if RE_CONTROL.search(v):
        raise ValueError(f"{key}: control characters are not allowed")
    return v.strip()


MAX_VALUES = 20


def split_values(text, limit=MAX_TEXT):
    """'create,delete' / '"system:serviceaccount:a b","cannot list"' -> the
    values: split on commas outside quotes, trimmed, unquoted (a \\" inside
    quotes stays a quote), empties dropped; at most MAX_VALUES values of
    `limit` characters (ValueError beyond). Plain text, never a regex."""
    out, cur, quoted, i = [], [], False, 0
    while i < len(text):
        c = text[i]
        if quoted:
            if c == '\\' and i + 1 < len(text) and text[i + 1] == '"':
                cur.append('"'); i += 2; continue
            if c == '"':
                quoted = False; i += 1; continue
            cur.append(c)
        elif c == '"':
            quoted = True
        elif c == ',':
            out.append(''.join(cur)); cur = []
        else:
            cur.append(c)
        i += 1
    out.append(''.join(cur))
    values = []
    for v in out:
        v = v.strip()
        if not v or v in values:
            continue
        if len(v) > limit:
            raise ValueError(f"a value is longer than {limit} characters")
        values.append(v)
    if len(values) > MAX_VALUES:
        raise ValueError(f"at most {MAX_VALUES} values")
    return values


def _values(raw, key, limit=MAX_TEXT):
    """The lowercased values of a multi-value text filter: a list in the JSON,
    or one string split as split_values() does."""
    v = raw.get(key)
    if v is None or v == '' or v == []:
        return []
    try:
        if isinstance(v, list):
            if len(v) > MAX_VALUES:
                raise ValueError(f"at most {MAX_VALUES} values")
            values = []
            for item in v:
                if not isinstance(item, str):
                    raise ValueError('must be text')
                if len(item) > limit:
                    raise ValueError(f"a value is longer than {limit} characters")
                if RE_CONTROL.search(item):
                    raise ValueError('control characters are not allowed')
                item = item.strip()
                if item and item.lower() not in values:
                    values.append(item.lower())
            return values
        if not isinstance(v, str):
            raise ValueError('must be text')
        if len(v) > (limit + 3) * MAX_VALUES:
            raise ValueError(f"at most {MAX_VALUES} values of {limit} characters")
        if RE_CONTROL.search(v):
            raise ValueError('control characters are not allowed')
        return [x.lower() for x in split_values(v, limit)]
    except ValueError as exc:
        raise ValueError(f"{key}: {exc}")


def _choices(raw, key, allowed, label):
    """A multi-value pick from a fixed list (verbs, categories, change types): a list or a comma string, lowercased, each in `allowed`."""
    v = raw.get(key)
    if v is None or v == '' or v == []:
        return []
    if isinstance(v, str):
        v = [x for x in v.split(',') if x.strip()]
    if not isinstance(v, list) or len(v) > MAX_VALUES:
        raise ValueError(f"{key}: a list of at most {MAX_VALUES} {label}")
    out = []
    for item in v:
        if not isinstance(item, str) or item.strip().lower() not in allowed:
            raise ValueError(f"{key}: unknown {label[:-1] if label.endswith('s') else label}")
        if item.strip().lower() not in out:
            out.append(item.strip().lower())
    return out


def _bool(raw, key):
    v = raw.get(key)
    if v in (None, '', False, 0, '0', 'false', 'no'):
        return False
    if v in (True, 1, '1', 'true', 'yes'):
        return True
    raise ValueError(f"{key} must be true or false")


def _when(text, key, base_day):
    """(datetime, seconds_given) from a full 'YYYY-MM-DD HH:MM[:SS]' stamp or
    'HH:MM[:SS]' on the capture's first day; (None, False) for no text."""
    if not text:
        return None, False
    m = RE_FULL_TS.match(text)
    if m:
        y, mo, d, h, mi, s = m.groups()
        try:
            return datetime(int(y), int(mo), int(d), int(h), int(mi), int(s or 0)), s is not None
        except ValueError:
            raise ValueError(f"{key}: not a valid date and time")
    m = RE_HHMM.match(text)
    if m:
        if base_day is None:
            raise ValueError(f"{key}: give a full date and time (the capture's day is unknown)")
        h, mi, s = m.groups()
        if int(h) > 23 or int(mi) > 59 or int(s or 0) > 59:
            raise ValueError(f"{key}: not a valid time")
        return base_day.replace(hour=int(h), minute=int(mi), second=int(s or 0), microsecond=0), s is not None
    raise ValueError(f"{key}: use HH:MM or YYYY-MM-DD HH:MM")


def validate(raw, base_day=None, first_ts=None):
    """(query, None) or (None, 'what is wrong'). base_day: the capture's first
    day at 00:00 for HH:MM times; first_ts: the capture's first timestamp, so
    an HH:MM before it means the next day."""
    if not isinstance(raw, dict):
        return None, 'the query must be an object'
    try:
        q = {}
        # every text filter takes several values (OR within the field, AND across fields): plain substrings, lowercased
        q['user'] = _values(raw, 'user')
        q['verbs'] = set(_choices(raw, 'verbs', VERBS, 'verbs'))
        q['resource'] = _values(raw, 'resource')
        q['namespace'] = _values(raw, 'namespace')
        q['name'] = _values(raw, 'name')
        # status: classes (2xx, 3xx, 4xx, 5xx, ok, error) and codes, any of them
        q['status'] = []
        q['code'] = []
        for status in _values(raw, 'status', 10):
            if status == 'any':
                continue
            if status in STATUS_CLASSES:
                q['status'].append(status)
            elif status.isdigit() and 100 <= int(status) <= 599:
                q['code'].append(int(status))
            else:
                raise ValueError('status: any, 2xx, 3xx, 4xx, 5xx, ok, error or a status code')
        for key in ('from', 'to'):
            text = _text(raw, key, 40)
            dt, seconds = _when(text, key, base_day)
            if dt is not None and first_ts is not None and RE_HHMM.match(text) and dt < first_ts.replace(microsecond=0):
                dt += timedelta(days=1)   # the capture crossed midnight
            if dt is not None and key == 'to' and not seconds:
                dt = dt.replace(second=59, microsecond=999999)   # "to 13:51" means the whole minute
            q[key] = dt
        if q['from'] and q['to'] and q['from'] > q['to']:
            raise ValueError('from is after to')
        q['ip'] = _values(raw, 'ip', 64)
        q['agent'] = _values(raw, 'agent')
        q['apiserver'] = [v for v in (raw.get('apiserver') if isinstance(raw.get('apiserver'), list) else split_values(_text(raw, 'apiserver', 2000), 100)) if isinstance(v, str) and v.strip()][:MAX_VALUES]
        q['node'] = [v for v in (raw.get('node') if isinstance(raw.get('node'), list) else split_values(_text(raw, 'node', 5000), 253)) if isinstance(v, str) and v.strip()][:MAX_VALUES]
        stage = _text(raw, 'stage', 20).lower() or 'complete'
        if stage not in ('complete', 'all'):
            raise ValueError('stage: complete or all')
        q['stage_all'] = stage == 'all'
        q['text'] = _values(raw, 'text')
        q['q'] = _values(raw, 'q')   # one box over time, user, verb, resource, namespace, name, IP, agent, reason, URI
        presets = _choices(raw, 'preset', PRESETS, 'presets') or _choices(raw, 'category', PRESETS, 'categories')   # the Category select: server-side categories, any of them
        q['preset'] = presets[0] if len(presets) == 1 else ''
        q['presets'] = presets
        q['has_body'] = _bool(raw, 'has_body') or 'changes' in presets
        q['changed_field'] = _values(raw, 'changed_field', 200)
        q['change_types'] = set(_choices(raw, 'change_types', audit_bodies.CHANGE_TYPES, 'types'))
        q['want_changes'] = bool(q['changed_field'] or q['change_types'] or q['has_body'])
        limit = raw.get('limit', LIMIT_DEFAULT)
        if isinstance(limit, str) and limit.isdigit():
            limit = int(limit)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= LIMIT_MAX:
            raise ValueError(f"limit: 1 to {LIMIT_MAX}")
        q['limit'] = limit
        sort = _text(raw, 'sort', 20).lower() or 'time'
        field, _, direction = sort.partition('_')
        if field not in SORTS or direction not in ('', 'asc', 'desc'):
            raise ValueError('sort: time, latency, status, user, verb or object, with _asc or _desc')
        q['sort'] = field
        q['sort_asc'] = (direction or SORTS[field][0]) == 'asc'
        cursor = _text(raw, 'cursor', 800)
        q['cursor'] = None
        if cursor:
            q['cursor'] = _decode_cursor(cursor, field, q['sort_asc'])
            if q['cursor'] is None:
                raise ValueError('cursor: not a cursor from an earlier search with this sort')
        q['count'] = _bool(raw, 'count') if 'count' in raw else not q['cursor']   # a page after the first skips the count
        q['count_all'] = _bool(raw, 'count_all')
        return q, None
    except ValueError as exc:
        return None, str(exc)


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Sorting: a key per event such that the "best" rows (the ones the page shows
# first) compare as the largest; the bounded heap keeps the largest N and the
# cursor carries the last shown key, so the next page takes strictly smaller
# keys with the same filters. The time + auditID tie-break makes every key
# unique. Rows without a latency (and watches, whose minutes-long latency is
# the watch itself, not a slow request) sort last for the latency sort.
# ---------------------------------------------------------------------------
def _sort_key(q, fields, ev, ts_key, audit_id):
    user, verb, group, resource, sub, ns, name, code, ts, ip, agent = fields
    asc = q['sort_asc']
    sign = -1 if asc else 1
    tie = (_Rev(ts_key) if asc else ts_key, _Rev(audit_id) if asc else audit_id)
    field = q['sort']
    if field == 'time':
        return tie
    if field == 'latency':
        received = audit_logs.parse_ts(ev.get('requestReceivedTimestamp'))
        done = audit_logs.parse_ts(ev.get('stageTimestamp'))
        ms = (done - received).total_seconds() * 1000 if received and done and verb != 'watch' else None
        return (1 if ms is not None else 0, sign * (ms or 0)) + tie
    if field == 'status':
        return (sign * code,) + tie
    text = user if field == 'user' else verb if field == 'verb' else (f"{group}/{resource}" if group else resource) + '/' + ns + '/' + name + ('/' + sub if sub else '') if field == 'object' else ''
    text = text.lower()
    return (text if asc is False else _Rev(text),) + tie


class _Rev:
    """A value that compares the other way round (an ascending sort in a heap that keeps the largest)."""
    __slots__ = ('v',)

    def __init__(self, v):
        self.v = v

    def __lt__(self, other):
        return self.v > other.v

    def __gt__(self, other):
        return self.v < other.v

    def __eq__(self, other):
        return isinstance(other, _Rev) and self.v == other.v

    def __le__(self, other):
        return self.v >= other.v

    def __ge__(self, other):
        return self.v <= other.v


def _plain(key):
    """The key with _Rev wrappers unwrapped, for the cursor."""
    return [k.v if isinstance(k, _Rev) else k for k in key]


def _encode_cursor(q, key):
    raw = json.dumps({'s': q['sort'], 'a': q['sort_asc'], 'k': _plain(key)}, separators=(',', ':'))
    return base64.urlsafe_b64encode(raw.encode('utf-8')).decode('ascii').rstrip('=')


def _decode_cursor(text, field, asc):
    """The key tuple of an earlier answer's cursor, in this sort's own comparison shape; None when it is not one."""
    if not RE_CURSOR.match(text):
        return None
    try:
        raw = json.loads(base64.urlsafe_b64decode(text + '=' * (-len(text) % 4)).decode('utf-8'))
    except (ValueError, TypeError):
        return None
    if not isinstance(raw, dict) or raw.get('s') != field or raw.get('a') != asc or not isinstance(raw.get('k'), list):
        return None
    k = raw['k']
    if field == 'time':
        shape = (str, str)
    elif field == 'latency':
        shape = (int, (int, float), str, str)
    elif field == 'status':
        shape = ((int, float), str, str)
    else:
        shape = (str, str, str)
    if len(k) != len(shape) or not all(isinstance(v, t) and not isinstance(v, bool) for v, t in zip(k, shape)):
        return None
    # the wrappers back on, exactly where _sort_key puts them
    if field == 'time':
        return (_Rev(k[0]) if asc else k[0], _Rev(k[1]) if asc else k[1])
    if field in ('latency', 'status'):
        head = tuple(k[:-2])
    else:
        head = (_Rev(k[0]) if asc else k[0],)
    return head + (_Rev(k[-2]) if asc else k[-2], _Rev(k[-1]) if asc else k[-1])


def _needles(q):
    """Groups of lowercase strings: a matching raw line must contain one of
    every group (a cheap test before the JSON parse). A field joins only when
    all its values are plain needles, since JSON may escape anything else."""
    groups = []
    for values in (q['user'], [v.rsplit('/', 1)[-1] for v in q['resource']], q['namespace'], q['name'], q['ip'], q['agent'], q['text'], q['q']):
        if values and all(RE_SAFE_NEEDLE.match(v) for v in values):
            groups.append(list(values))
    if q['preset'] == 'throttled':
        groups.append(['429'])
    elif q['preset'] == 'impersonation':
        groups.append(['impersonateduser'])
    elif q['preset'] == 'deprecated':
        groups.append(['k8s.io/deprecated'])
    if q['verbs']:
        groups.append(['"verb":"%s"' % v for v in q['verbs']])
    return groups


def _status_ok(q, code):
    if not q['status'] and not q['code']:
        return True
    if code in q['code']:
        return True
    for st in q['status']:
        if st == 'ok' and code < 400:
            return True
        if st == 'error' and code >= 400:
            return True
        if st[1:] == 'xx' and (code // 100 if code else 0) == int(st[0]):
            return True
    return False


def _preset_ok(preset, ev, fields):
    user, verb, group, resource, sub, ns, name, code, ts, ip, agent = fields
    if preset == 'forbidden':
        ann = ev.get('annotations') if isinstance(ev.get('annotations'), dict) else {}
        return code == 403 or ann.get('authorization.k8s.io/decision') == 'forbid'
    if preset == 'throttled':
        return code == 429
    if preset == 'sensitive_deletes':
        return verb in audit_logs.DELETE_VERBS and resource in audit_logs.SENSITIVE_RESOURCES
    if preset == 'rbac_changes':
        return resource in audit_logs.RBAC_RESOURCES and verb in audit_logs.WRITE_VERBS
    if preset == 'secret_reads':
        return resource == 'secrets' and verb in audit_logs.READ_VERBS and not user.startswith('system:') and code < 400
    if preset == 'impersonation':
        imp = ev.get('impersonatedUser')
        return isinstance(imp, dict) and bool(imp.get('username'))
    if preset == 'deprecated':
        ann = ev.get('annotations') if isinstance(ev.get('annotations'), dict) else {}
        return 'k8s.io/deprecated' in ann
    if preset == 'changes':
        return verb in audit_logs.WRITE_VERBS and code < 400 and (isinstance(ev.get('requestObject'), (dict, list)) or isinstance(ev.get('responseObject'), dict))
    return True


def _haystack(ev, fields):
    """What the one search box matches: the time as the page shows it, who,
    verb, resource, namespace, name, IP, agent, the reason, the URI, the code."""
    user, verb, group, resource, sub, ns, name, code, ts, ip, agent = fields
    ann = ev.get('annotations') if isinstance(ev.get('annotations'), dict) else {}
    status = ev.get('responseStatus') if isinstance(ev.get('responseStatus'), dict) else {}
    imp = ev.get('impersonatedUser') if isinstance(ev.get('impersonatedUser'), dict) else {}
    parts = (ts.strftime('%Y-%m-%d %H:%M:%S') if ts else '', user, str(imp.get('username') or ''), verb, (f"{group}/{resource}" if group else resource) + (f"/{sub}" if sub else ''),
             ns, name, ip, agent, str(ann.get('authorization.k8s.io/reason') or ''), str(status.get('message') or ''), str(ev.get('requestURI') or ''), str(code))
    return ' '.join(parts).lower()


def _has_body(ev):
    return isinstance(ev.get('requestObject'), (dict, list)) or isinstance(ev.get('responseObject'), dict)


def _any_in(values, hay):
    return any(v in hay for v in values)


def _user_via(ev, user, values):
    """How the user filter matched the event: 'username', 'group <name>',
    'impersonated <name>' (the impersonated identity or its groups), or '' for
    no match. The username, the groups and the impersonation always count."""
    if _any_in(values, user.lower()):
        return 'username'
    uo = ev.get('user') if isinstance(ev.get('user'), dict) else {}
    for g in (uo.get('groups') if isinstance(uo.get('groups'), list) else []):
        if _any_in(values, str(g).lower()):
            return f"group {g}"
    imp = ev.get('impersonatedUser') if isinstance(ev.get('impersonatedUser'), dict) else {}
    if imp:
        name = str(imp.get('username') or '')
        if _any_in(values, name.lower()):
            return f"impersonated {name}"
        for g in (imp.get('groups') if isinstance(imp.get('groups'), list) else []):
            if _any_in(values, str(g).lower()):
                return f"impersonated group {g}"
    return ''


def _match(ev, q, fields):
    user, verb, group, resource, sub, ns, name, code, ts, ip, agent = fields
    if q['presets'] and not any(_preset_ok(p, ev, fields) for p in q['presets']):
        return False
    if q['has_body'] and not _has_body(ev):
        return False
    if q['verbs'] and verb not in q['verbs']:
        return False
    if not _status_ok(q, code):
        return False
    if q['from'] and (ts is None or ts < q['from']):
        return False
    if q['to'] and (ts is None or ts > q['to']):
        return False
    if q['namespace'] and not _any_in(q['namespace'], ns.lower()):
        return False
    if q['name'] and not _any_in(q['name'], name.lower()):
        return False
    if q['resource']:
        key = ((f"{group}/{resource}" if group else resource) + (f"/{sub}" if sub else '')).lower()
        if not _any_in(q['resource'], key):
            return False
    if q['ip'] and not _any_in(q['ip'], ip.lower()):
        return False
    if q['agent'] and not _any_in(q['agent'], agent.lower()):
        return False
    if q['user'] and not _user_via(ev, user, q['user']):
        return False
    if q['text'] and not _any_in(q['text'], str(ev.get('requestURI') or '').lower()):
        return False
    if q['q'] and not _any_in(q['q'], _haystack(ev, fields)):
        return False
    return True


class _Counts:
    """The status codes and verbs of the matches (every match counted within
    the budget, not only the returned page): the page's slim bars."""

    def __init__(self):
        self.codes = Counter()
        self.verbs = Counter()
        self.verb_errors = Counter()

    def add(self, fields):
        verb, code = fields[1], fields[7]
        self.codes[code] += 1
        self.verbs[verb] += 1
        if code >= 400:
            self.verb_errors[verb] += 1

    def out(self):
        return ({'codes': [{'name': str(c), 'count': n} for c, n in sorted(self.codes.items())],
                 'verbs': [{'name': v, 'count': n, 'errors': self.verb_errors.get(v, 0)} for v, n in self.verbs.most_common(20)]})


def _fields(ev):
    user_obj = ev.get('user') if isinstance(ev.get('user'), dict) else {}
    user = str(user_obj.get('username') or '') or 'anonymous'
    verb = str(ev.get('verb') or '').lower()
    ref = ev.get('objectRef') if isinstance(ev.get('objectRef'), dict) else {}
    status = ev.get('responseStatus') if isinstance(ev.get('responseStatus'), dict) else {}
    code = status.get('code')
    code = int(code) if isinstance(code, int) else 0
    ips = ev.get('sourceIPs') if isinstance(ev.get('sourceIPs'), list) else []
    ts = audit_logs.parse_ts(ev.get('requestReceivedTimestamp')) or audit_logs.parse_ts(ev.get('stageTimestamp'))
    return (user, verb, str(ref.get('apiGroup') or ''), str(ref.get('resource') or ''), str(ref.get('subresource') or ''), str(ref.get('namespace') or ''),
            str(ref.get('name') or ''), code, ts, str(ips[0]) if ips else '', str(ev.get('userAgent') or ''))


def _brief(ev, fields):
    """The few summary fields build_record needs, without the pretty JSON."""
    user, verb, group, resource, sub, ns, name, code, ts, ip, agent = fields
    imp = ev.get('impersonatedUser') if isinstance(ev.get('impersonatedUser'), dict) else {}
    return {'ts': ts.strftime('%Y-%m-%d %H:%M:%S') if ts else '', 'ts_sort': _ts_key(ts) if ts else '', 'user': user, 'impersonated': str(imp.get('username') or ''),
            'namespace': ns, 'name': name, 'subresource': sub, 'resource': f"{group}/{resource}" if group else resource, 'code': code}


def _summary(ev, fields, apiserver, node):
    """The event for the page, shaped like the scan's samples: masked raw JSON,
    masked body texts, the latency; the unmasked bodies go to the store."""
    user, verb, group, resource, sub, ns, name, code, ts, ip, agent = fields
    received = audit_logs.parse_ts(ev.get('requestReceivedTimestamp'))
    done = audit_logs.parse_ts(ev.get('stageTimestamp'))
    ms = (done - received).total_seconds() * 1000 if received and done else None
    ann = ev.get('annotations') if isinstance(ev.get('annotations'), dict) else {}
    reason = str(ann.get('authorization.k8s.io/reason') or '')
    s = audit_logs._summary(ev, user, verb, group, resource, ns, name, sub, code, apiserver, node, ts, ms, reason, audit_logs._pretty(ev, resource))
    s['stage'] = str(ev.get('stage') or '')
    s['level'] = str(ev.get('level') or '')
    s['uri'] = str(ev.get('requestURI') or '')[:2000]
    s['audit_id'] = str(ev.get('auditID') or '')
    s['decision'] = str(ann.get('authorization.k8s.io/decision') or '')
    s['has_request_body'] = isinstance(ev.get('requestObject'), (dict, list))
    s['has_response_body'] = isinstance(ev.get('responseObject'), dict)
    s['request_body'], s['request_truncated'] = audit_bodies.body_text(ev.get('requestObject'), resource) if s['has_request_body'] else ('', False)
    s['response_body'], s['response_truncated'] = audit_bodies.body_text(ev.get('responseObject'), resource) if s['has_response_body'] else ('', False)
    s['patch_type'] = audit_bodies.patch_paths(ev.get('requestObject'), None, resource)[0] if verb == 'patch' and s['has_request_body'] else ''
    return s


def _histogram(seconds, errors=None):
    """Matches (and the 4xx/5xx among them) per bucket on the broken time
    axis of audit_logs.bucket_plan, over the matches' own span: the step
    (1 s ... 1 d) from the active time of the matches, every bucket in
    between zero-filled, a gap item where the matches leave a hole."""
    if not seconds:
        return {'step_minutes': 0, 'step_seconds': 1, 'step_text': '', 'buckets': [], 'windows': [], 'gaps': [], 'active_seconds': 0, 'active_minutes': 0}
    plan = audit_logs.bucket_plan(sorted(seconds))
    by_key, err_key = Counter(), Counter()
    for t, n in seconds.items():
        by_key[plan['key_of'](t)] += n
    for t, n in (errors or {}).items():
        err_key[plan['key_of'](t)] += n
    buckets = []
    for it in plan['items']:
        if it['gap']:
            buckets.append({'gap': True, 'from': it['from'], 'to': it['to'], 'minutes': it['minutes'], 'seconds': it['seconds'], 'label': it['label'], 't': '', 'n': None, 'errors': None})
        else:
            buckets.append({'gap': False, 't': it['t'].strftime('%Y-%m-%dT%H:%M:%S'), 'label': it['label'], 'n': by_key.get(it['t'], 0), 'errors': err_key.get(it['t'], 0), 'window': it['window'], 'start': it['start']})
    return {'step_minutes': plan['step'], 'step_seconds': plan['step_seconds'], 'step_text': audit_logs.step_text(plan['step_seconds']), 'buckets': buckets, 'gaps': plan['gaps'],
            'active_seconds': plan['active_seconds'], 'active_minutes': plan['active_minutes'], 'wall_seconds': plan['wall_seconds'], 'wall_minutes': plan['wall_minutes'],
            'windows': [{'first': a.strftime('%Y-%m-%d %H:%M:%S'), 'last': b.strftime('%Y-%m-%d %H:%M:%S'), 'seconds': int((b - a).total_seconds()) + 1, 'minutes': int((b - a).total_seconds() // 60) + 1} for a, b in plan['windows']]}


# ---------------------------------------------------------------------------
# The search
# ---------------------------------------------------------------------------
def _begin(root):
    with _lock:
        _generation[root] = _generation.get(root, 0) + 1
        return _generation[root]


def _current(root, mine):
    return _generation.get(root) == mine


def cancel(directory):
    """Stop the running search of a directory (a new search does this itself)."""
    _begin(resolve_data_dir(directory))


def _remember_bodies(root, kept):
    store = _bodies.setdefault(root, OrderedDict())
    for audit_id, req, resp in kept:
        if not audit_id:
            continue
        store[audit_id] = (req, resp)
        store.move_to_end(audit_id)
        while len(store) > BODY_STORE:
            store.popitem(last=False)


def stored_body(directory, audit_id, part):
    """The unmasked request / response body of an event a search returned
    (for the Reveal route), or None."""
    store = _bodies.get(resolve_data_dir(directory))
    hit = store.get(str(audit_id or '')) if store else None
    if not hit:
        return None
    obj = hit[0] if part == 'request' else hit[1]
    if obj is None:
        return None
    try:
        return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False)
    except (TypeError, ValueError):
        return None


def capture_bounds(directory):
    """(the first day at 00:00, the first timestamp) from the per-file time
    index, so HH:MM filters resolve; (None, None) without known files."""
    root = resolve_data_dir(directory)
    spans = audit_logs.file_spans(audit_logs.find_files(root))
    firsts = [s[0] for s in spans.values() if s and s[0]]
    if not firsts:
        return None, None
    first = min(firsts)
    return first.replace(hour=0, minute=0, second=0, microsecond=0), first


def _ts_key(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S.%f')


def search(directory, q, _after_file=None):
    """The newest q['limit'] matches, newest first, plus the count: see the
    module docstring. _after_file(path) is a test hook called after each file."""
    root = resolve_data_dir(directory)
    files = audit_logs.find_files(root)
    spans = audit_logs.file_spans(files)
    mine = _begin(root)
    if not _slots.acquire(blocking=False):
        return {'ok': False, 'error': 'busy', 'message': f"{MAX_SLOTS} searches are already running; try again in a moment"}
    t0 = time.monotonic()
    deadline = t0 + (COUNT_ALL_SECONDS if q['count_all'] else BUDGET_SECONDS)   # for the count phase, once the newest N are in hand
    hard_deadline = t0 + COUNT_ALL_SECONDS                                      # for everything
    limit, cursor, needles = q['limit'], q['cursor'], _needles(q)
    heap = []                 # ((ts_key, audit_id), seq, event, apiserver, node): the newest `limit` matches
    seq = total = scanned = skipped = lines = 0
    seconds = Counter()        # the matches per second (the histogram picks its step from their span afterwards)
    sec_errors = Counter()
    counts = _Counts()
    partial = cancelled = counting_only = False
    state = OrderedDict()     # (ns, resource, name) -> the object's latest state seen in THIS search (the "old" side of a diff)
    want_changes = q['want_changes']

    def newest_last(f):
        s = spans.get(f[0])
        return s[1] if s and s[1] else datetime.max   # a file without a known span is read like the newest
    time_sort = q['sort'] == 'time'
    oldest_first = time_sort and q['sort_asc']
    if want_changes:
        # the "old" side of a diff is the object's earlier state seen in this search: a node's rotated file must come before
        # its current one, so the files of a stream (apiserver, node) go oldest first, the streams themselves newest first
        stream_last = {}
        for f in files:
            stream_last[(f[1], f[2])] = max(stream_last.get((f[1], f[2]), datetime.min), newest_last(f))
        ordered = sorted(files, key=lambda f: (spans.get(f[0]) or (None, None))[0] or datetime.min)   # oldest first within a stream
        ordered.sort(key=lambda f: stream_last[(f[1], f[2])], reverse=True)                            # the newest stream first (a stable sort keeps the order above)
    elif oldest_first:
        ordered = sorted(files, key=lambda f: (spans.get(f[0]) or (None, None))[0] or datetime.min)
    else:
        ordered = sorted(files, key=newest_last, reverse=True)
    try:
        for f in ordered:
            path, apiserver, node, _rotated, gz, size, mtime = f
            if (q['apiserver'] and apiserver not in q['apiserver']) or (q['node'] and node not in q['node']):
                skipped += 1
                continue
            first_ts, last_ts = spans.get(path) or (None, None)
            if (q['from'] and last_ts and last_ts < q['from']) or (q['to'] and first_ts and first_ts > q['to']):
                skipped += 1   # the whole file lies outside the time range
                continue
            if cursor and time_sort and first_ts and last_ts:
                # every event of the file lies on the shown side of the page's cursor
                if (not oldest_first and _ts_key(first_ts) > cursor[0]) or (oldest_first and _ts_key(last_ts) < cursor[0].v):
                    skipped += 1
                    continue
            if time_sort and len(heap) >= limit and last_ts and first_ts and not want_changes:
                worst = heap[0][0][0]
                if (not oldest_first and _ts_key(last_ts) < worst) or (oldest_first and _ts_key(first_ts) > worst.v):
                    counting_only = True   # no remaining file can hold a better match
            if counting_only and not q['count']:
                break
            if not _current(root, mine):
                raise Cancelled()
            now = time.monotonic()
            if ((counting_only or not time_sort) and now > deadline) or now > hard_deadline:
                partial = True   # a non-time sort has no early exit: the budget applies to the whole stream
                break
            f_first = f_last = None
            stopped = False
            for line in audit_logs.iter_lines(path, gz):
                lines += 1
                if lines % CHECK_EVERY == 0:
                    if not _current(root, mine):
                        raise Cancelled()
                    now = time.monotonic()
                    if ((counting_only or not time_sort) and now > deadline) or now > hard_deadline:
                        partial = stopped = True
                        break
                s = line.strip()
                if not s:
                    continue
                if needles:
                    low = s.lower()
                    if any(not any(n in low for n in group) for group in needles):
                        continue
                try:
                    ev = json.loads(s)
                except ValueError:
                    continue
                if not isinstance(ev, dict) or ev.get('kind') != 'Event' or 'verb' not in ev:
                    continue
                if not q['stage_all'] and ev.get('stage') in ('ResponseStarted', 'RequestReceived'):
                    continue
                fields = _fields(ev)
                ts = fields[8]
                if ts:
                    f_first = ts if f_first is None or ts < f_first else f_first
                    f_last = ts if f_last is None or ts > f_last else f_last
                if not _match(ev, q, fields):
                    continue
                # a write with a body: the object's earlier state is the old side of its diff; the record is built now only when a
                # change filter or the change breakdowns need it, else at the end for the returned events only
                old = rec = None
                change_event = fields[1] in audit_logs.WRITE_VERBS and fields[7] < 400 and _has_body(ev)
                if change_event:
                    resource, sub = fields[3], fields[4]
                    okey = audit_bodies.object_key({'namespace': fields[5], 'name': fields[6]}, resource, ev.get('responseObject'))
                    old = state.get(okey)
                    if want_changes:
                        try:
                            rec = audit_bodies.build_record(_brief(ev, fields), ev, resource, fields[1], old)
                        except Exception:
                            rec = None
                    audit_bodies.next_state(state, okey, ev, fields[1], sub, old)
                if q['changed_field'] and not (rec and any(v in p.lower() for p in rec['paths'] for v in q['changed_field'])):
                    continue
                if q['change_types'] and not (rec and q['change_types'] & set(rec['types'])):
                    continue
                key = _sort_key(q, fields, ev, _ts_key(ts) if ts else '', str(ev.get('auditID') or ''))
                if cursor and not key < cursor:
                    continue   # the page shows strictly the rows after the cursor, in the sort's order
                total += 1
                if ts:
                    second = ts.replace(microsecond=0)
                    seconds[second] += 1
                    if fields[7] >= 400:
                        sec_errors[second] += 1
                counts.add(fields)
                if counting_only:
                    continue
                seq += 1
                if len(heap) < limit:
                    heapq.heappush(heap, (key, seq, ev, apiserver, node, old, rec))
                elif key > heap[0][0]:
                    heapq.heapreplace(heap, (key, seq, ev, apiserver, node, old, rec))
            scanned += 1
            if stopped:
                break   # the budget ran out inside this file
            if f_first and f_last and not q['stage_all']:
                audit_logs.remember_span(path, size, mtime, f_first, f_last)
            if _after_file:
                _after_file(path)
    except Cancelled:
        cancelled = True
    finally:
        _slots.release()
    if cancelled:
        return {'ok': False, 'cancelled': True, 'error': 'cancelled', 'message': 'a newer search replaced this one'}
    hits = sorted(heap, key=lambda e: e[0], reverse=True)   # the best first
    last_key = hits[-1][0] if hits else None
    events, kept = [], []
    for _key, _seq, ev, apiserver, node, old, rec in hits:
        fields = _fields(ev)
        s = _summary(ev, fields, apiserver, node)
        s['matched_via'] = _user_via(ev, fields[0], q['user']) if q['user'] else ''   # 'group …' / 'impersonated …': the row says why it matched
        if fields[1] in audit_logs.WRITE_VERBS and fields[7] < 400 and _has_body(ev):
            if rec is None:
                try:
                    rec = audit_bodies.build_record(s, ev, fields[3], fields[1], old)
                except Exception:
                    rec = None
            if rec:
                s['change'] = {'key': rec['key'], 'kind': rec['kind'], 'chips': rec['chips'], 'types': rec['types'], 'severity': rec['severity'], 'patch_type': rec['patch_type'],
                               'old_known': rec['old_known'], 'highlights': rec['highlights'], 'diffs': rec['diffs'][:MAX_DIFFS_OUT], 'diffs_total': len(rec['diffs']), 'delete_options': rec.get('delete_options', '')}
        events.append(s)
        if s['has_request_body'] or s['has_response_body']:
            kept.append((s['audit_id'], ev.get('requestObject') if s['has_request_body'] else None, ev.get('responseObject') if s['has_response_body'] else None))
    _remember_bodies(root, kept)
    return {
        'ok': True, 'events': events, 'returned': len(events), 'limit': limit,
        'total': total, 'partial': partial, 'counted': q['count'],
        'has_more': total > len(events) or ((partial or not q['count']) and len(events) >= limit),
        'cursor': _encode_cursor(q, last_key) if last_key else '',
        'sort': q['sort'] + ('_asc' if q['sort_asc'] else '_desc'), 'sort_text': 'sorted by ' + q['sort'] + ', ' + SORTS[q['sort']][2 if q['sort_asc'] else 1],
        'files': len(files), 'scanned_files': scanned, 'skipped_files': skipped, 'lines': lines, 'seconds': round(time.monotonic() - t0, 2),
        'budget_seconds': COUNT_ALL_SECONDS if q['count_all'] else BUDGET_SECONDS,
        'histogram': _histogram(seconds, sec_errors),
        **counts.out(),
        'preset': q['preset'], 'stage': 'all' if q['stage_all'] else 'complete',
        'from': q['from'].strftime('%Y-%m-%d %H:%M:%S') if q['from'] else '', 'to': q['to'].strftime('%Y-%m-%d %H:%M:%S') if q['to'] else '',
    }
