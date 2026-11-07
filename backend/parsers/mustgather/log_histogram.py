"""The must-gather side of the Log Collection Histogram (parsers/log_histogram.py is the engine).

    parse(directory) -> the page's data: the must-gather Log Viewer's own listing (the container logs grouped by
        namespace, the host service logs, the node journals, the network logs; the same picker and initial date
        range), a default selection within DEFAULT_BUDGET bytes, and the Findings strip before an analysis.
    sources_for(directory, paths) -> (engine sources, error): only logs the gather lists, inside its directory.

The default selection: the previous logs first (a container that crashed), then the node journals and the host
service logs, then the largest current container logs, while the total stays within DEFAULT_BUDGET (20 MB); the
picker extends it. Reading: a container log's lines group by its ns/pod/container (a previous log apart); a node
journal's and a host service log's lines by the node or role and the process.
"""
from parsers.findings import finding, human_bytes, no_data, sort_findings
from parsers.mustgather import log_viewer as lv

DEFAULT_BUDGET = 20 << 20
_ORDER = {'node': 1, 'host': 2, 'network': 4}


def default_selection(sources, budget=DEFAULT_BUDGET):
    """The paths selected when the page opens (see the module docstring)."""
    def rank(s):
        if s['type'] == 'container':
            return (0 if s['kind'].startswith('previous') else 3, -s['size'], s['name'])
        return (_ORDER.get(s['type'], 4), -s['size'], s['name'])
    chosen, total = [], 0
    for s in sorted(sources, key=rank):
        if not s['size']:
            continue
        if total + s['size'] > budget and chosen:
            continue
        chosen.append(s['path'])
        total += s['size']
    return chosen, total


def parse(directory):
    base = lv.parse(directory)
    logs = base['available_logs']
    chosen, total = default_selection(logs)
    chosen = set(chosen)
    for s in logs:
        s['checked'] = s['path'] in chosen
    result = {
        'available_logs': logs,
        'unavailable_logs': [],
        'date_range': base['date_range'],
        'gather_time': base.get('gather_time'),
        'default_bytes': total,
        'default_count': len(chosen),
    }
    result['findings'] = findings_for(result)
    return result


def findings_for(result):
    logs = result['available_logs']
    if not logs:
        return [no_data('No container or host logs in this must-gather', ['namespaces/*/pods/*/*/*/logs', 'host_service_logs', 'nodes'], 'trimmed gather')]
    out = [finding('info', f"{len(logs)} log{'s' if len(logs) != 1 else ''} to analyze; {result['default_count']} selected ({human_bytes(result['default_bytes'])}, previous logs first)",
                   'pick the logs and the dates, then Analyze: the lines per time bucket and what stands out - spikes, bursts, new, stopped and rare messages')]
    return sort_findings(out)


def _link(s):
    """The Log Viewer's cross-link name of a source (diagLogView.applyQuery's sources=...)."""
    if s['type'] == 'container':
        return f"{s['namespace']}/{s['pod']}/{s['container']}"
    if s['type'] == 'host':
        return 'host:' + s['name']
    if s['type'] == 'node':
        return 'node:' + s['node']
    return s['name']


def sources_for(directory, paths):
    chosen, error = lv.chosen_sources(paths, directory)
    if error:
        return None, error
    year = lv._year_of(directory)
    ref = lv._ref_of(directory)
    out = []
    for s in chosen:
        if s['type'] == 'container':
            label = f"{s['namespace']}/{s['pod']}/{s['container']}" + ('' if s['kind'] == 'current' else f" ({s['kind']})")
            kind, prefix = 'container', ''
        elif s['type'] == 'node':
            label, kind, prefix = s['name'], 'auto', s['node'] + ' '
        elif s['type'] == 'host':
            label, kind, prefix = s['name'], 'auto', s.get('role', '') + ' '
        else:
            label, kind, prefix = s['name'], 'auto', ''
        out.append({'path': s['path'], 'size': s['size'], 'kind': kind, 'prefix': prefix, 'label': label, 'link': _link(s),
                    'year': year, 'ref': ref.isoformat() if ref else None})
    return out, None
