"""Kernel Stack Traces: the WARNING / BUG / Oops / lockup / RCU stall /
panic traces of a sosreport's kernel logs, grouped for the incident board.

The scanning (every journal, dmesg and messages file, every timestamp
format, dedupe across sources) is kernel_log.scan(); this module shapes
its trace events for tabs/sosreport_kernel_stack_traces.html:

  stack_traces.summary  counts by type, first/last, modules and processes,
                        taint, the events-over-time buckets, the sources
  stack_traces.groups   identical traces (same type, same reliable frames)
                        as one row: count, occurrences, a representative
  stack_traces.traces   the flat per-event list in the shape the earlier
                        template and the tests read (kept as is)
"""
from collections import Counter

from . import kernel_log as kl


def parse(directory):
    scan = kl.scan(directory)
    events = scan['traces']
    groups = _groups(events)
    summary = _summary(events, groups, scan)
    legacy = [_legacy(e) for e in events]
    return {'stack_traces': {'traces': legacy, 'summary': summary, 'groups': groups}}


def _groups(events):
    by_key = {}
    order = []
    for ev in events:
        key = ev['group_key']
        if key not in by_key:
            by_key[key] = []
            order.append(key)
        by_key[key].append(ev)
    groups = []
    for key in order:
        evs = by_key[key]
        first, last = evs[0], evs[-1]
        rep = first
        groups.append({
            'id': '',
            'type_key': rep['type_key'], 'type_label': rep['type_label'], 'severity': rep['severity'],
            'title': rep['title'], 'count': len(evs),
            'first': kl.fmt_ts(first), 'last': kl.fmt_ts(last), 'ts': kl.sort_ts(last),
            'occurrences': [{'ts': kl.fmt_ts(e), 'source': ', '.join(e['sources'])} for e in evs[:60]],
            'event': {
                'header': rep['header'], 'cpu': rep['cpu'], 'pid': rep['pid'], 'comm': rep['comm'], 'kernel': rep['kernel'],
                'hardware': rep['hardware'], 'taint': rep['taint']['flags'], 'taint_text': rep['taint']['text'],
                'file': rep['file'], 'line': rep['line'], 'function': rep['function'], 'modules': rep['modules'],
                'rip': rep['rip'], 'workqueue': rep['workqueue'],
                'frames': [{'text': f['text'], 'unreliable': f['unreliable'], 'fault': f['fault'], 'module': f['module']} for f in rep['frames']],
                'code': rep['code'], 'registers': rep['registers'], 'raw': rep['raw'],
            },
        })
    groups.sort(key=lambda g: (-g['count'], g['ts']), reverse=False)
    groups.sort(key=lambda g: g['ts'], reverse=True)
    groups.sort(key=lambda g: -g['count'])
    for i, g in enumerate(groups, 1):
        g['id'] = f"g{i}"
    return groups


def _summary(events, groups, scan):
    if not events:
        return {'total': 0, 'groups': 0, 'first': '', 'last': '', 'types': [], 'modules': [], 'comms': [],
                'taint': {'flags': '', 'text': ''}, 'timeline': None, 'sources': scan['sources'], 'capped': scan['capped']}
    types = Counter(e['type_key'] for e in events)
    type_order = ['warning', 'bug', 'oops', 'soft_lockup', 'hard_lockup', 'rcu_stall', 'panic', 'mce', 'netdev_wait', 'other']
    modules = Counter()
    for e in events:
        seen = set()
        for f in e['frames']:
            if f['module'] and f['module'] not in seen and not f['unreliable']:
                seen.add(f['module'])
                modules[f['module']] += 1
        if e['rip'] and e['function'].endswith(']'):
            mod = e['function'].rsplit('[', 1)[1].rstrip(']')
            if mod not in seen:
                modules[mod] += 1
    comms = Counter(e['comm'] for e in events if e['comm'])
    return {
        'total': len(events), 'groups': len(groups),
        'first': kl.fmt_ts(events[0]), 'last': kl.fmt_ts(events[-1]),
        'types': [{'key': k, 'label': kl.TYPE_LABELS.get(k, k), 'count': types[k], 'severity': kl.TYPE_SEVERITY.get(k, 'info')}
                  for k in type_order if types.get(k)],
        'modules': kl.top(modules), 'comms': kl.top(comms),
        'taint': kl.taint_summary(events),
        'timeline': kl.timeline(events, 'Traces per day' if _span_days(events) > 2 else 'Traces per hour'),
        'sources': scan['sources'], 'capped': scan['capped'],
    }


def _span_days(events):
    stamps = [e['ts'] for e in events if e['ts']]
    if len(stamps) < 2:
        return 0
    return (max(stamps) - min(stamps)).total_seconds() / 86400


def _legacy(ev):
    return {
        'timestamp': kl.fmt_ts(ev),
        'warning': ev['header'],
        'cpu': ev['cpu'], 'pid': ev['pid'],
        'file': f"{ev['file']}:{ev['line']}" if ev['file'] and ev['line'] else ev['file'],
        'function': ev['function'],
        'code': ['Code: ' + ' '.join(p['text'] for p in ev['code'])] if ev['code'] else [],
        'call_trace': [f['text'].strip() for f in ev['frames']],
        'comm': ev['comm'], 'kernel_version': ev['kernel'], 'hardware': ev['hardware'],
        'type': ev['type_key'], 'sources': ev['sources'],
    }
