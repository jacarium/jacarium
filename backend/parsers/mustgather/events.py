import os
import yaml

from parsers.findings import finding, recall, remember, sort_findings, no_data
from parsers.mustgather._common import resolve_data_dir, safe_load, safe_load_all, list_items, unreadable, unreadable_finding

def parse(directory):
    result = {}

    directory = resolve_data_dir(directory)

    namespaces_path = os.path.join(directory, "namespaces")
    if not os.path.exists(namespaces_path):
        return result

    namespaces = os.listdir(namespaces_path)

    for namespace in namespaces:
        events_path = os.path.join(namespaces_path, namespace, "core", "events.yaml")
        events_json = []

        if os.path.exists(events_path):
            try:
                with open(events_path, "r") as f:
                    events_content = safe_load(f)

                # an EventList (items may be null or empty: a quiet namespace), a single Event, or an empty document
                events_json = list_items(events_content, 'Event')

            except Exception as e:   # a broken file: a readable reason, never the raw exception
                events_json = [{"kind": "Error", "message": unreadable(events_path, e, directory)['reason'], "file": unreadable(events_path, e, directory)['file'], "metadata": {"namespace": namespace}}]

        # Warning events first, then the newest first: what the reader looks for sits on top
        events_json.sort(key=lambda e: (0 if (e.get('type') == 'Warning') else 1, str(e.get('lastTimestamp') or e.get('eventTime') or (e.get('metadata') or {}).get('creationTimestamp') or '')), reverse=False)
        events_json.sort(key=lambda e: str(e.get('lastTimestamp') or e.get('eventTime') or (e.get('metadata') or {}).get('creationTimestamp') or ''), reverse=True)
        events_json.sort(key=lambda e: 0 if (e.get('type') == 'Warning') else 1)
        result[namespace] = events_json

    remember(('events', directory), findings_for(result))
    return result


def findings(directory):
    # the parser's list, or the one way to say the gather holds nothing of this (never a GOOD without data)
    return recall(('events', resolve_data_dir(directory)), lambda: parse(directory)) or [no_data('No events in this must-gather', ['namespaces/*/core/events.yaml'], 'trimmed gather')]

SERIOUS = {'OOMKilling', 'FailedScheduling', 'BackOff', 'FailedMount', 'FailedAttachVolume', 'NodeNotReady', 'Unhealthy', 'Failed', 'FailedCreate', 'Evicted', 'FailedKillPod', 'NetworkNotReady'}


def findings_for(result):
    """The Findings strip: the Warning reasons with their counts (the serious ones - OOMKilling, FailedScheduling,
    BackOff, FailedMount, NodeNotReady, Unhealthy ... - as warnings, the rest informational), the totals."""
    out = []
    reasons = {}
    total = 0
    warnings = 0
    broken = []
    for ns, events in result.items():
        for e in events:
            if isinstance(e, dict) and e.get('kind') == 'Error':
                broken.append({'file': e.get('file') or f'namespaces/{ns}/core/events.yaml', 'reason': e.get('message') or 'could not be parsed'})
            if not isinstance(e, dict) or e.get('kind') == 'Error':
                continue
            total += 1
            if e.get('type') != 'Warning':
                continue
            warnings += 1
            r = e.get('reason') or '?'
            entry = reasons.setdefault(r, {'count': 0, 'objects': set(), 'namespaces': set()})
            entry['count'] += int(e.get('count') or 1)
            obj = e.get('involvedObject') or {}
            if obj.get('name'):
                entry['objects'].add(obj.get('name'))
            entry['namespaces'].add(ns)
    for r, entry in sorted(reasons.items(), key=lambda kv: -kv[1]['count'])[:8]:
        objs = sorted(entry['objects'])
        out.append(finding('warn' if r in SERIOUS else 'info', f"{r}: {entry['count']} warning event{'s' if entry['count'] != 1 else ''}", f"{len(entry['objects'])} object{'s' if len(entry['objects']) != 1 else ''} in {', '.join(sorted(entry['namespaces'])[:3])}" + (' …' if len(entry['namespaces']) > 3 else '') + (": " + ', '.join(objs[:3]) + (' …' if len(objs) > 3 else '') if objs else ''), tab='workloads', sub_tab='pod', query=objs[0] if len(objs) == 1 else None, count=entry['count']))
    bf = unreadable_finding(broken, 'events')
    if bf:
        out.append(bf)
    if total and not warnings:
        out.append(finding('good', f"{total} events, none of type Warning"))
    elif not total:
        out.append(finding('info', 'No events in this must-gather', 'namespaces/*/core/events.yaml is missing or empty'))
    return sort_findings(out)
