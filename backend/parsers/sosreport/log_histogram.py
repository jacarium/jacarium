"""The sosreport side of the Log Collection Histogram (parsers/log_histogram.py is the engine).

    parse(directory) -> the page's data: the Log Viewer's own listing (the same logs in the same picker, the same
        initial date range), the system journal selected by default, and the Findings strip before an analysis.
    sources_for(directory, paths) -> (engine sources, error): the selected paths that the listing names and that
        resolve inside the report, as the engine's source dicts.

Reading: a journal line (the journal captures and the syslog-format files of var/log) groups by its process; a
container log (var/log/pods, var/log/containers: CRI lines) and any other dated format group by the file's name.
The year-less journal forms take the year of the report's `date` capture, as the Log Viewer does.
"""
import os

from parsers.findings import finding, human_bytes, no_data, sort_findings
from parsers.sosreport import log_viewer as lv


def _container_log(path):
    return lv.ContainerLogParser().can_parse(path)


def parse(directory):
    base = lv._parse(directory)
    logs = base['available_logs']
    default = [s for s in logs if s['type'] == 'system']
    if not default:
        # no system journal: the syslog file stands in (var/log/messages), else nothing is preselected
        default = [s for s in logs if s['name'] in ('messages', 'syslog')][:1]
    chosen = {s['path'] for s in default}
    for s in logs:
        s['checked'] = s['path'] in chosen
    result = {
        'available_logs': logs,
        'unavailable_logs': base['unavailable_logs'],
        'date_range': base['date_range'],
        'default_bytes': sum(s['size'] for s in default),
        'default_count': len(default),
    }
    result['findings'] = findings_for(result)
    return result


def findings_for(result):
    logs = result['available_logs']
    if not logs:
        return [no_data('No readable log in this report', ['sos_commands/logs/journalctl*', 'var/log/**/*.log'], 'a report collected without the logs plugin')]
    out = [finding('info', f"{len(logs)} log{'s' if len(logs) != 1 else ''} to analyze; "
                   + (f"{result['default_count']} selected ({human_bytes(result['default_bytes'])})" if result['default_count'] else 'none selected'),
                   'pick the logs and the dates, then Analyze: the lines per time bucket and what stands out - spikes, bursts, new, stopped and rare messages')]
    return sort_findings(out)


def sources_for(directory, paths):
    """The selected paths the listing names and that resolve inside the report, as engine sources."""
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
        return None, 'no log selected'
    root = os.path.realpath(directory)
    listed = {s['path']: s for s in lv._parse(directory)['available_logs']}
    out = []
    seen = set()
    for p in paths:
        real = os.path.realpath(os.path.expanduser(p))
        if not (real == root or real.startswith(root + os.sep)):
            continue
        s = listed.get(p) or listed.get(os.path.expanduser(p))
        if not s or s['path'] in seen:
            continue
        seen.add(s['path'])
        ref = lv.report_capture_time(s['path'])
        out.append({'path': s['path'], 'size': s['size'], 'kind': 'container' if _container_log(s['path']) else 'auto', 'prefix': '',
                    'label': s['name'], 'link': s['name'], 'year': ref.year if ref else None, 'ref': ref.isoformat() if ref else None})
    if not out:
        return None, 'none of the selected logs is one this report lists'
    return out, None
