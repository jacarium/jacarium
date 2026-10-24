"""Kernel Hung Tasks: the "INFO: task X:N blocked for more than N seconds"
reports of a sosreport's kernel logs, grouped by the function the tasks
are blocked in, for the incident board.

kernel_log.scan() finds the reports in every kernel log of the report
(RHEL 7's "comm D ffff... pid ppid flags" line, RHEL 8/9's padded
"task:X state:D stack:0 pid: N ppid:  N flags:0x..", the tight legacy
form and 6.x's "pid:N tgid:N ppid:N", stacks with or without <TASK>).
This module shapes them for tabs/sosreport_kernel_hung_task.html:

  hung_summary  reports, distinct tasks, threshold, the longest block,
                first/last, "blocked in" and process counts, the timeline
  hung_groups   one row per blocking function (nfs_wait_on_request [nfs],
                xfs_log_force [xfs], ...) with its tasks; a task the
                kernel re-reports every timeout is one entry with its
                growing durations
  hung_tasks    the flat per-report list in the shape the earlier template
                and the tests read (kept as is)
"""
import os
import re
from parsers.findings import finding, no_data, sort_findings
from collections import Counter

from . import kernel_log as kl

RE_THRESHOLD = re.compile(r'^kernel\.hung_task_timeout_secs\s*=\s*(\d+)', re.M)


def parse(directory):
    scan = kl.scan(directory)
    events = scan['hung']
    tasks = _tasks(events)
    groups = _groups(tasks)
    summary = _summary(events, tasks, groups, scan, _threshold(kl.report_root(directory), events))
    legacy = [_legacy(e) for e in events]
    return {'hung_tasks': legacy, 'hung_summary': summary, 'hung_groups': groups, 'findings': findings_for(summary, groups, scan)}


def _threshold(directory, events):
    """kernel.hung_task_timeout_secs from the captured sysctl, else the
    smallest reported duration (the kernel reports at the timeout)."""
    for rel in ('sos_commands/kernel/sysctl_-a', 'proc/sys/kernel/hung_task_timeout_secs'):
        path = os.path.join(directory, rel)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                for n, line in enumerate(f):
                    if n > 200000:
                        break
                    if rel.endswith('hung_task_timeout_secs') and line.strip().isdigit():
                        return int(line.strip())
                    m = RE_THRESHOLD.match(line)
                    if m:
                        return int(m.group(1))
        except OSError:
            continue
    durations = [e['duration'] for e in events if e['duration']]
    return min(durations) if durations else 0


def _tasks(events):
    """Reports -> one task per (comm, pid), with every report's duration
    and the stack from the first report that carried one."""
    by_key = {}
    order = []
    for ev in events:
        key = (ev['comm'], ev['pid'])
        if key not in by_key:
            order.append(key)
            by_key[key] = {'comm': ev['comm'], 'pid': ev['pid'], 'ppid': ev['ppid'], 'state': ev['state'], 'flags': ev['flags'],
                           'stack_ptr': ev['stack_ptr'], 'kernel': ev['kernel'], 'taint': ev['taint'], 'frames': [], 'blocked_in': None,
                           'raw': ev['raw'], 'reports': [], 'sources': []}
        t = by_key[key]
        t['reports'].append(ev)
        for field in ('ppid', 'flags', 'stack_ptr', 'kernel', 'state'):
            if not t[field] and ev[field]:
                t[field] = ev[field]
        if not t['taint']['flags'] and ev['taint']['flags']:
            t['taint'] = ev['taint']
        if not t['frames'] and ev['frames']:
            t['frames'] = ev['frames']
            t['blocked_in'] = ev['blocked_in']
            t['raw'] = ev['raw']
        for s in ev['sources']:
            if s not in t['sources']:
                t['sources'].append(s)
    tasks = []
    for key in order:
        t = by_key[key]
        reports = sorted(t['reports'], key=lambda e: (e['ts'] or kl.datetime.min, e['duration']))
        durations = [e['duration'] for e in reports]
        t.update({
            'durations': durations, 'duration_min': min(durations), 'duration_max': max(durations),
            'first': kl.fmt_ts(reports[0]), 'last': kl.fmt_ts(reports[-1]), 'ts': kl.sort_ts(reports[-1]),
            'state_text': STATE_TEXT.get(t['state'], ''),
            'taint_text': t['taint']['text'], 'taint_flags': t['taint']['flags'],
        })
        tasks.append(t)
    return tasks


STATE_TEXT = {'D': 'uninterruptible sleep', 'R': 'running', 'S': 'sleeping', 'T': 'stopped', 'Z': 'zombie', 'I': 'idle'}


def _groups(tasks):
    by_key = {}
    order = []
    for t in tasks:
        b = t['blocked_in']
        key = (b['symbol'], b['module']) if b else ('', '')
        if key not in by_key:
            order.append(key)
            by_key[key] = {'function': b['symbol'] if b else 'no stack captured', 'module': b['module'] if b else '', 'tasks': []}
        by_key[key]['tasks'].append(t)
    groups = []
    for key in order:
        g = by_key[key]
        count = sum(len(t['reports']) for t in g['tasks'])
        longest = max(t['duration_max'] for t in g['tasks'])
        stamps = [t['ts'] for t in g['tasks'] if t['ts']]
        firsts = [t['first'] for t in g['tasks']]
        groups.append({
            'id': '', 'function': g['function'], 'module': g['module'],
            'severity': 'critical' if longest >= 600 else 'warning',
            'count': count, 'first': min(firsts) if firsts else '', 'last': max(t['last'] for t in g['tasks']),
            'ts': max(stamps) if stamps else '',
            'tasks': [{
                'comm': t['comm'], 'pid': t['pid'], 'ppid': t['ppid'], 'state': t['state'], 'state_text': t['state_text'],
                'durations': t['durations'], 'duration_min': t['duration_min'], 'duration_max': t['duration_max'],
                'first': t['first'], 'last': t['last'], 'ts': t['ts'], 'flags': t['flags'], 'stack_ptr': t['stack_ptr'],
                'kernel': t['kernel'], 'taint': t['taint_flags'], 'taint_text': t['taint_text'],
                'frames': [{'text': f['text'], 'unreliable': f['unreliable'], 'blocked': f['blocked'], 'module': f['module']} for f in t['frames']],
                'raw': t['raw'], 'sources': t['sources'],
            } for t in sorted(g['tasks'], key=lambda t: -t['duration_max'])],
        })
    groups.sort(key=lambda g: g['ts'], reverse=True)
    groups.sort(key=lambda g: -g['count'])
    for i, g in enumerate(groups, 1):
        g['id'] = f"h{i}"
    return groups


def _summary(events, tasks, groups, scan, threshold):
    if not events:
        return {'reports': 0, 'tasks': 0, 'groups': 0, 'threshold': threshold, 'longest': 0, 'first': '', 'last': '',
                'blocked_in': [], 'comms': [], 'states': [], 'taint': {'flags': '', 'text': ''}, 'timeline': None,
                'sources': scan['sources'], 'capped': scan['capped']}
    blocked = Counter()
    for t in tasks:
        name = (t['blocked_in']['text'] if t['blocked_in'] else 'no stack captured')
        blocked[name] += len(t['reports'])
    comms = Counter()
    for e in events:
        comms[e['comm']] += 1
    states = Counter(e['state'] for e in events)
    span = [e['ts'] for e in events if e['ts']]
    per_day = span and (max(span) - min(span)).total_seconds() > 2 * 86400
    return {
        'reports': len(events), 'tasks': len(tasks), 'groups': len(groups), 'threshold': threshold,
        'longest': max(e['duration'] for e in events),
        'first': kl.fmt_ts(events[0]), 'last': kl.fmt_ts(events[-1]),
        'blocked_in': kl.top(blocked), 'comms': kl.top(comms),
        'states': [{'name': k, 'count': v} for k, v in states.most_common()],
        'taint': kl.taint_summary(events),
        'timeline': kl.timeline(events, 'Reports per day' if per_day else 'Reports per hour'),
        'sources': scan['sources'], 'capped': scan['capped'],
    }


def _legacy(ev):
    return {
        'timestamp': kl.fmt_ts(ev),
        'task_line': f"INFO: task {ev['comm']}:{ev['pid']} blocked for more than {ev['duration']} seconds.",
        'details': {
            'task': ev['comm'], 'pid': ev['pid'], 'ppid': ev['ppid'] or None, 'state': ev['state'], 'stack': ev['stack_ptr'] or None,
            'flags': ev['flags'] or None, 'kernel': ev['kernel'], 'duration': str(ev['duration']),
            'call_trace': [f['text'].strip() for f in ev['frames']],
            'raw': ev['raw'], 'blocked_in': ev['blocked_in']['text'] if ev['blocked_in'] else None, 'sources': ev['sources'],
        },
    }

def findings_for(summary, groups, scan):
    """The Findings strip: the hung-task reports (bad) with the tasks, the blocking functions and the longest block;
    none (good, with the sources scanned); no kernel log (info)."""
    if not scan['sources']:
        return [no_data('No kernel log in this report', ['sos_commands/logs/journalctl*', 'sos_commands/kernel/dmesg*', 'var/log/messages*', 'var/log/dmesg*'], 'no journal capture, dmesg or syslog: the kernel tabs have nothing to read')]
    out = []
    if summary.get('reports'):
        where = ', '.join(f"{g.get('name', g.get('function', '?'))} ({g.get('count', len(g.get('tasks', [])))})" for g in groups[:4]) if groups else ''
        out.append(finding('bad', f"{summary['reports']} hung-task report{'s' if summary['reports'] != 1 else ''} on {summary['tasks']} task{'s' if summary['tasks'] != 1 else ''}", f"blocked for up to {summary.get('longest', 0)} s (timeout {summary.get('threshold', 0)} s), the last at {summary.get('last', '')}" + (f"; blocked in {where}" if where else ''), count=summary['reports']))
    if summary.get('capped'):
        out.append(finding('info', 'The kernel log scan was capped', 'more reports than the scan keeps: the oldest are not counted'))
    if not out:
        out.append(finding('good', 'No hung task: no "blocked for more than N seconds" report in the kernel logs', 'scanned: ' + ', '.join(scan['sources'])))
    return sort_findings(out)
