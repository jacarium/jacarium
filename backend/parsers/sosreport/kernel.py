"""Kernel: the group page over the three kernel tabs (Stack Traces, Hung
Tasks, OOM Killer), from the shared scan of kernel_log.py (cached, so the
tabs cost nothing more): how many of each kind, the first and the last
incident, the sources read, and the Findings strip - OOM kills and hung
tasks are bad, stack traces a warning, each linked to its tab.
"""
from parsers.findings import finding, sort_findings

from . import kernel_log as kl


def parse(directory):
    scan = kl.scan(directory)
    kinds = {
        'oom': {'label': 'OOM kills', 'sub_tab': 'kernel_oom_killer', 'events': scan['oom']},
        'hung': {'label': 'Hung tasks', 'sub_tab': 'kernel_hung_task', 'events': scan['hung']},
        'traces': {'label': 'Stack traces', 'sub_tab': 'kernel_stack_traces', 'events': scan['traces']},
    }
    cards = []
    for key, k in kinds.items():
        ev = k['events']
        cards.append({'key': key, 'label': k['label'], 'sub_tab': k['sub_tab'], 'count': len(ev),
                      'first': kl.fmt_ts(ev[0]) if ev else '', 'last': kl.fmt_ts(ev[-1]) if ev else ''})
    result = {'kernel': {'cards': cards, 'sources': scan['sources'], 'capped': scan['capped'], 'boot_time': scan.get('boot_time')}}
    result['findings'] = findings_for(cards, scan)
    return result


def findings_for(cards, scan):
    out = []
    by = {c['key']: c for c in cards}
    if not scan['sources']:
        return [finding('info', 'No kernel log in this report', 'no journal capture, dmesg or var/log/messages: the three kernel tabs have nothing to read')]
    oom, hung, traces = by['oom'], by['hung'], by['traces']
    if oom['count']:
        out.append(finding('bad', f"{oom['count']} OOM kill{'s' if oom['count'] != 1 else ''}", f"the last at {oom['last']}: the kernel killed processes for memory", tab='kernel', sub_tab='kernel_oom_killer', count=oom['count']))
    if hung['count']:
        out.append(finding('bad', f"{hung['count']} hung-task report{'s' if hung['count'] != 1 else ''}", f"the last at {hung['last']}: tasks blocked in the kernel for longer than the timeout (I/O, locks, NFS)", tab='kernel', sub_tab='kernel_hung_task', count=hung['count']))
    if traces['count']:
        out.append(finding('warn', f"{traces['count']} kernel stack trace{'s' if traces['count'] != 1 else ''}", f"the last at {traces['last']}: WARNINGs, BUGs or oopses with their call traces", tab='kernel', sub_tab='kernel_stack_traces', count=traces['count']))
    if scan['capped']:
        out.append(finding('info', 'The kernel log scan was capped', 'more events than the scan keeps per kind: the oldest ones are not counted'))
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"No OOM kill, hung task or stack trace in {len(scan['sources'])} kernel log source{'s' if len(scan['sources']) != 1 else ''}"))
    return sort_findings(out)
