"""metadata.managedFields, read for a detail page's "Field ownership" section: who wrote which fields of an object,
and when - the server-side apply bookkeeping Kubernetes keeps on every object (one entry per manager and
operation, with the time of its last write and a fieldsV1 tree of the fields it owns).

    entries(obj, gather_time)  ->  [entry, ...], newest first
        entry = {
            'manager': 'kubectl-edit', 'operation': 'Update', 'subresource': '' | 'status' | 'scale' | ...,
            'api_version': 'apps/v1', 'time': '2026-10-12T14:20:11Z', 'when': '2026-10-12 14:20:11',
            'relative': '12 min before the gather' | '' , 'seconds_before': 720 | None,
            'human': True | False,            # a person or a CLI / console / GitOps tool, not a controller
            'kind': 'human' | 'controller' | 'status',
            'fields': ['spec.replicas', 'spec.template.spec.containers[name=web].image', ...],   # readable paths
            'fields_total': 14,               # before the cap
        }
    summary(entries)           ->  the latest human edit, or None: {'manager', 'relative', 'when', 'fields'}
    finding_for(entries, ...)  ->  an INFO finding for a recent human edit (within RECENT_SECONDS of the gather), or None

The fieldsV1 tree: 'f:<name>' a field, 'k:{"name":"web"}' a list item by its merge key, 'v:<json>' a set item by its
value, 'i:<n>' a list item by index, '.' the entry itself. A path is the chain of names, list items written as
[key=value] (or [=value] / [n]). What managedFields does NOT hold: the old values - the Audit request bodies do.
"""
import json
import re
from datetime import datetime, timezone

HUMAN = re.compile(r'^(kubectl\b.*|oc\b.*|kubectl-[a-z-]+|Mozilla.*|helm.*|argocd.*|flux.*|terraform.*|ansible.*|pulumi.*|openshift-console.*|console)$', re.I)
STATUS_SUBRESOURCES = ('status',)
MAX_PATHS = 60
RECENT_SECONDS = 24 * 3600


def _parse_time(value):
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None


def relative(seconds):
    """'12 min before the gather', '3 h 5 min before the gather', '2 d before the gather'; '' when unknown."""
    if seconds is None:
        return ''
    if seconds < 0:
        return 'after the gather time'
    if seconds < 60:
        return f'{int(seconds)} s before the gather'
    minutes = int(seconds // 60)
    if minutes < 60:
        return f'{minutes} min before the gather'
    hours, minutes = divmod(minutes, 60)
    if hours < 48:
        return f'{hours} h' + (f' {minutes} min' if minutes else '') + ' before the gather'
    days, hours = divmod(hours, 24)
    return f'{days} d' + (f' {hours} h' if hours else '') + ' before the gather'


def _item_label(key):
    """'k:{"name":"web"}' -> '[name=web]', 'v:"abc"' -> '[=abc]', 'i:3' -> '[3]'."""
    if key.startswith('k:'):
        try:
            d = json.loads(key[2:])
        except ValueError:
            return '[' + key[2:][:40] + ']'
        if isinstance(d, dict):
            parts = [f'{k}={d[k]}' for k in sorted(d) if not isinstance(d[k], (dict, list))]
            return '[' + ','.join(parts)[:80] + ']'
        return '[' + str(d)[:40] + ']'
    if key.startswith('v:'):
        raw = key[2:]
        try:
            raw = json.loads(raw)
        except ValueError:
            pass
        return '[=' + str(raw)[:40] + ']'
    if key.startswith('i:'):
        return '[' + key[2:] + ']'
    return '[' + key[:40] + ']'


def flatten(tree, prefix='', out=None, limit=MAX_PATHS * 4):
    """The fieldsV1 tree as readable paths: the leaves (a field with no owned children of its own) and the
    containers that the entry owns as a whole ('.' marks)."""
    if out is None:
        out = []
    if not isinstance(tree, dict) or len(out) >= limit:
        return out
    for key, sub in tree.items():
        if len(out) >= limit:
            break
        if key == '.':
            continue
        if key.startswith('f:'):
            path = (prefix + '.' if prefix else '') + key[2:]
        elif key[:2] in ('k:', 'v:', 'i:'):
            path = prefix + _item_label(key)
        else:
            path = (prefix + '.' if prefix else '') + key
        children = sub if isinstance(sub, dict) else {}
        owned = [k for k in children if k != '.']
        if owned:
            flatten(children, path, out, limit)
        else:
            out.append(path)
    return out


def classify(manager, subresource, operation):
    """'human' for a person's tool (kubectl, oc, the console, helm, GitOps), 'status' for a status / scale write,
    'controller' for the rest (kube-controller-manager, kubelet, an operator)."""
    if subresource in STATUS_SUBRESOURCES:
        return 'status'
    if manager and HUMAN.match(manager):
        return 'human'
    return 'controller'


def entries(obj, gather_time=None):
    """The managedFields of an object (a dict with metadata), newest first; [] when there are none."""
    meta = (obj or {}).get('metadata') if isinstance(obj, dict) else None
    raw = (meta or {}).get('managedFields') if isinstance(meta, dict) else None
    if not isinstance(raw, list):
        return []
    gather = gather_time if isinstance(gather_time, datetime) else _parse_time(gather_time)
    out = []
    for i, e in enumerate(raw):
        if not isinstance(e, dict):
            continue
        manager = str(e.get('manager') or '?')[:80]
        operation = str(e.get('operation') or '')[:20]
        subresource = str(e.get('subresource') or '')[:40]
        t = _parse_time(e.get('time'))
        seconds = None
        if t and gather:
            seconds = int((gather - t).total_seconds())
        paths = flatten(e.get('fieldsV1') if isinstance(e.get('fieldsV1'), dict) else {})
        kind = classify(manager, subresource, operation)
        out.append({
            'manager': manager, 'operation': operation, 'subresource': subresource, 'api_version': str(e.get('apiVersion') or '')[:40],
            'time': e.get('time') if isinstance(e.get('time'), str) else '', 'when': t.strftime('%Y-%m-%d %H:%M:%S') if t else '',
            'relative': relative(seconds), 'seconds_before': seconds, 'human': kind == 'human', 'kind': kind,
            'fields': paths[:MAX_PATHS], 'fields_total': len(paths), 'index': i,
        })
    # newest first (the latest write time), entries without a time last in their original order
    out.sort(key=lambda x: (0 if x['time'] else 1, -_ts(x['time']) if x['time'] else 0, x['index']))
    return out


def _ts(value):
    t = _parse_time(value)
    return t.timestamp() if t else 0.0


def summary(items):
    """The latest human edit of the list, or None."""
    for e in items:
        if e['human']:
            return {'manager': e['manager'], 'relative': e['relative'], 'when': e['when'], 'fields': e['fields'][:6], 'fields_total': e['fields_total'], 'operation': e['operation']}
    return None


def finding_for(items, what='the object'):
    """An INFO finding for a human edit within RECENT_SECONDS of the gather: 'Edited by kubectl-edit 12 min before
    the gather: spec.replicas, spec.template...image'. None otherwise."""
    from parsers.findings import finding
    s = summary(items)
    if not s:
        return None
    e = next(x for x in items if x['human'])
    if e['seconds_before'] is None or e['seconds_before'] < 0 or e['seconds_before'] > RECENT_SECONDS:
        return None
    fields = ', '.join(s['fields']) + (f" +{s['fields_total'] - len(s['fields'])}" if s['fields_total'] > len(s['fields']) else '')
    return finding('info', f"Edited by {s['manager']} {s['relative']}", f"{what}: {fields} (managedFields records which fields a manager owns and when it last wrote them, not the old values; the Audit request bodies have those)")


def audit_query(obj):
    """The Audit page's search for the writes to this object: its name (the search field), the page's own filters
    take the namespace and the verbs."""
    meta = (obj or {}).get('metadata') if isinstance(obj, dict) else None
    if not isinstance(meta, dict):
        return ''
    return str(meta.get('name') or '')
