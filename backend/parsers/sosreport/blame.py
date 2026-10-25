"""Sos Report / Blame: where the sos report's own collection time went.

Reads the report's sos_reports/manifest.json (sos 4.x writes one with
the run's cmdline, start/end/run_time and, under components.report.
plugins, every plugin's run_time, timeout, timeout_hit and the commands it
ran with their return codes and run times) and ranks the plugins by run
time, with their commands sorted by run time, a return-code histogram, the
timeouts and the share of the whole run.

Ported from the sosblame CLI's logic (to_seconds for sos's timedelta
strings including "N days,", plugin ranking, commands sorted by run_time,
rc histograms, timeout_hit, cmdline, start/end/total, the short node
label). The tab shows the one loaded, already extracted report; collector
bundles with several nodes stay a CLI concern (a node picker would list
each node's manifest found one level down).

Like the other sosreport parsers: parse(directory) returns a dict for the
template, the single-wrapper-directory unwrap applies, a missing or partial
manifest gives an empty-state result (never an exception), and the Flask
layer caches the result per directory and tab.
"""
from parsers.findings import finding, sort_findings

import json
import os
import re
from collections import Counter
from datetime import datetime

MAX_PLUGINS = 400
MAX_COMMANDS_PER_PLUGIN = 3000
MAX_MANIFEST_BYTES = 64 * 1024 * 1024

RE_TIMEDELTA = re.compile(r'(?:(\d+) days?, )?(\d+):(\d+):(\d+(?:\.\d+)?)')
RE_IP_NODE = re.compile(r'ip-\d+-\d+-\d+-\d+')


def to_seconds(value):
    """sos's str(timedelta): '0:02:47.041000' or '1 day, 0:00:01' -> seconds;
    a bare number is taken as seconds; 0.0 for anything else."""
    if value is None or value == '':
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    m = RE_TIMEDELTA.search(str(value))
    if not m:
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0
    d, h, mn, sec = m.groups()
    return (int(d) if d else 0) * 86400 + int(h) * 3600 + int(mn) * 60 + float(sec)


def short_node_label(node):
    """'sosreport-ip-192-0-2-46-master-cluster-example-master-2026-...' ->
    'ip-192-0-2-46 [master]'; anything else comes back as it is."""
    m = RE_IP_NODE.search(node or '')
    base = m.group(0) if m else (node or '')
    low = (node or '').lower()
    role = 'master' if 'master' in low else 'worker' if 'worker' in low else ''
    return f"{base} [{role}]" if role else base


def rc_histogram(commands):
    """{return code: count}, most frequent first (None = no code recorded)."""
    hist = Counter(c.get('return_code') for c in commands)
    return dict(sorted(hist.items(), key=lambda kv: kv[1], reverse=True))


def parse_time(value):
    if not value:
        return None
    s = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s[:26], fmt)
        except ValueError:
            continue
    return None


def _report_root(directory):
    try:
        entries = os.listdir(directory)
    except OSError:
        return directory
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            return inner
    return directory


def load_manifest(directory):
    """(manifest dict | None, reason). The reason names what is missing."""
    path = os.path.join(directory, 'sos_reports', 'manifest.json')
    if not os.path.isfile(path):
        return None, 'This report has no sos_reports/manifest.json (sos 4.0 and later write one).'
    try:
        if os.path.getsize(path) > MAX_MANIFEST_BYTES:
            return None, 'The manifest is too large to read here.'
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            manifest = json.load(f)
    except (OSError, ValueError) as exc:
        return None, f'The manifest could not be read: {exc.__class__.__name__}.'
    if not isinstance(manifest, dict):
        return None, 'The manifest is not a JSON object.'
    return manifest, ''


def parse(directory):
    directory = _report_root(directory)
    manifest, reason = load_manifest(directory)
    node = os.path.basename(directory.rstrip('/'))
    result = {
        'available': False, 'reason': reason, 'node': node, 'node_label': short_node_label(node),
        'version': '', 'cmdline': '', 'policy': '', 'preset': '', 'hostname': '', 'kernel': '',
        'start': '', 'end': '', 'total_seconds': 0.0, 'total': '',
        'summary': {}, 'plugins': [], 'rc_codes': [], 'gantt': False, 'notes': [],
    }
    if manifest is None:
        return {'blame': result, 'findings': [finding('info', 'No sos manifest in this report', reason or 'sos_reports/manifest.json is missing (sos before 4.0, or a trimmed report): nothing to blame')]}
    report = (manifest.get('components') or {}).get('report') if isinstance(manifest.get('components'), dict) else None
    sysinfo = (report or {}).get('sysinfo') if isinstance(report, dict) else None
    result.update({
        'available': True,
        'version': str(manifest.get('version') or ''),
        'cmdline': ('sos ' + str(manifest['cmdline'])) if manifest.get('cmdline') else '',
        'policy': str(manifest.get('policy') or ''),
        'preset': str((manifest.get('preset') or {}).get('name') or '') if isinstance(manifest.get('preset'), dict) else str(manifest.get('preset') or ''),
        'hostname': str((sysinfo or {}).get('hostname') or ''),
        'kernel': str((sysinfo or {}).get('kernel') or ''),
        'start': str(manifest.get('start_time') or ''),
        'end': str(manifest.get('end_time') or ''),
    })
    start_dt, end_dt = parse_time(manifest.get('start_time')), parse_time(manifest.get('end_time'))
    total = to_seconds(manifest.get('run_time'))
    if not total and start_dt and end_dt:
        total = max(0.0, (end_dt - start_dt).total_seconds())
    result['total_seconds'] = round(total, 3)
    result['total'] = fmt_seconds(total)

    plugins_raw = (report or {}).get('plugins') if isinstance(report, dict) else None
    if not isinstance(plugins_raw, dict) or not plugins_raw:
        result['available'] = False
        result['reason'] = ('The manifest has no per-plugin timings (components.report.plugins): this sos version '
                            f'({result["version"] or "unknown"}) did not record them.')
        return {'blame': result, 'findings': [finding('info', 'No plugin timings in this manifest', result['reason'])]}

    plugins = []
    for name, info in list(plugins_raw.items())[:MAX_PLUGINS]:
        if not isinstance(info, dict):
            info = {}
        plugins.append(_plugin(str(name), info, start_dt))
    if len(plugins_raw) > MAX_PLUGINS:
        result['notes'].append(f'Only the first {MAX_PLUGINS} of {len(plugins_raw)} plugins are shown.')
    plugins.sort(key=lambda p: -p['seconds'])  # a stable sort: ties keep the manifest's order, like the CLI
    plugin_total = sum(p['seconds'] for p in plugins)
    running = 0.0
    for rank, p in enumerate(plugins, 1):
        p['rank'] = rank
        p['share'] = round(100.0 * p['seconds'] / total, 1) if total else 0.0
        running += p['seconds']
        p['cumulative'] = round(100.0 * running / total, 1) if total else 0.0

    commands = sum(p['commands_count'] for p in plugins)
    failed = sum(p['failed'] for p in plugins)
    not_found = sum(p['rc_counts'].get(127, 0) for p in plugins)
    timeouts = [p['name'] for p in plugins if p['timeout_hit']]
    rc_all = Counter()
    for p in plugins:
        rc_all.update(p['rc_counts'])
    slowest = plugins[0] if plugins else None
    result['summary'] = {
        'plugins': len(plugins), 'commands': commands, 'failed': failed, 'not_found': not_found,
        'timeouts': len(timeouts), 'timeout_names': timeouts,
        'slowest': slowest['name'] if slowest else '', 'slowest_seconds': slowest['seconds'] if slowest else 0.0, 'slowest_time': slowest['time'] if slowest else '',
        'slowest_share': slowest['share'] if slowest else 0.0,
        'plugin_seconds': round(plugin_total, 3), 'plugin_time': fmt_seconds(plugin_total),
        'command_seconds': round(sum(c['seconds'] for p in plugins for c in p['commands']), 3),
        'top3_share': round(sum(p['share'] for p in plugins[:3]), 1),
        'rc_histogram': [{'rc': _rc_label(rc), 'count': n} for rc, n in sorted(rc_all.items(), key=lambda kv: -kv[1])],
    }
    result['plugins'] = plugins
    result['rc_codes'] = [_rc_label(rc) for rc, _ in sorted(rc_all.items(), key=lambda kv: -kv[1])]
    result['gantt'] = any(p['offset_start'] is not None for p in plugins)
    if plugin_total > total * 1.05 and total:
        result['notes'].append('The plugins\' times add up to more than the run: sos collects several plugins at once (--threads).')
    return {'blame': result, 'findings': findings_for(result['summary'], plugins)}


def _plugin(name, info, run_start):
    raw_cmds = info.get('commands') if isinstance(info.get('commands'), list) else []
    commands = []
    for c in raw_cmds[:MAX_COMMANDS_PER_PLUGIN]:
        if not isinstance(c, dict):
            continue
        secs = to_seconds(c.get('run_time'))
        rc = c.get('return_code')
        commands.append({
            'exec': str(c.get('exec') or ''), 'rc': rc if isinstance(rc, int) else (None if rc is None else str(rc)),
            'rc_label': _rc_label(rc), 'seconds': round(secs, 3), 'time': fmt_seconds(secs),
            'filepath': str(c.get('filepath') or ''), 'failed': rc not in (0, None) or rc is None,
            'start': parse_time(c.get('start_time')), 'end': parse_time(c.get('end_time')),
        })
    # the histogram in the manifest's order (ties keep it, like the CLI), the list by run time
    rc_counts = rc_histogram([{'return_code': c['rc']} for c in commands])
    commands.sort(key=lambda c: -c['seconds'])
    seconds = to_seconds(info.get('run_time'))
    setup_seconds = to_seconds(info.get('setup_time'))
    start, end = parse_time(info.get('start_time')), parse_time(info.get('end_time'))
    if (start is None or end is None) and commands:
        starts = [c['start'] for c in commands if c['start']]
        ends = [c['end'] for c in commands if c['end']]
        if starts and ends:
            start, end = min(starts), max(ends)
    if start is not None and end is None and seconds:
        from datetime import timedelta
        end = start + timedelta(seconds=seconds)
    offset_start = offset_end = None
    if run_start and start and end:
        offset_start = round((start - run_start).total_seconds(), 3)
        offset_end = round((end - run_start).total_seconds(), 3)
    for c in commands:
        c['start'] = c['start'].strftime('%H:%M:%S.%f')[:-3] if c['start'] else ''
        c['end'] = c['end'].strftime('%H:%M:%S.%f')[:-3] if c['end'] else ''
    files = info.get('files') if isinstance(info.get('files'), list) else []
    timeout = info.get('timeout')
    return {
        'name': name, 'seconds': round(seconds, 3), 'time': fmt_seconds(seconds), 'setup_seconds': round(setup_seconds, 3),
        'timeout': timeout if isinstance(timeout, (int, float)) else None, 'timeout_hit': bool(info.get('timeout_hit')),
        'commands_count': len(raw_cmds), 'commands': commands, 'files_count': len(files),
        'failed': sum(1 for c in commands if c['failed']), 'ok': sum(1 for c in commands if not c['failed']),
        'rc_counts': rc_counts, 'rc': [{'rc': _rc_label(rc), 'count': n} for rc, n in rc_counts.items()],
        'rc_text': '{' + ','.join(f"{_rc_label(rc)}:{n}" for rc, n in rc_counts.items()) + '}' if rc_counts else '',
        'start': start.strftime('%H:%M:%S') if start else '', 'end': end.strftime('%H:%M:%S') if end else '',
        'offset_start': offset_start, 'offset_end': offset_end,
        'no_commands': not raw_cmds,
    }


def _rc_label(rc):
    return 'none' if rc is None else str(rc)


def fmt_seconds(secs):
    """189.93 -> '3 min 9.9 s', 0.034 -> '34 ms', 7.5 -> '7.5 s'."""
    try:
        secs = float(secs)
    except (TypeError, ValueError):
        return ''
    if secs < 1:
        return f"{secs * 1000:.0f} ms"
    if secs < 60:
        return f"{secs:.1f} s"
    if secs < 3600:
        return f"{int(secs // 60)} min {secs % 60:.1f} s"
    return f"{int(secs // 3600)} h {int(secs % 3600 // 60)} min"

def findings_for(summary, plugins):
    """The Findings strip: plugins that hit their timeout (warn: their captures are incomplete), commands that failed
    (info), the one plugin that took over half of the run (info), the totals when nothing is wrong."""
    out = []
    if summary.get('timeouts'):
        names = summary.get('timeout_names') or []
        out.append(finding('warn', f"{summary['timeouts']} plugin{'s' if summary['timeouts'] != 1 else ''} hit the timeout", ', '.join(names[:6]) + (' …' if len(names) > 6 else '') + ": their captures stop where sos gave up; a tab fed by them may be short", count=summary['timeouts']))
    if summary.get('failed'):
        out.append(finding('info', f"{summary['failed']} command{'s' if summary['failed'] != 1 else ''} failed", f"{summary.get('not_found', 0)} not found (a tool missing on the host)", count=summary['failed']))
    if summary.get('slowest') and summary.get('slowest_share', 0) >= 50:
        out.append(finding('info', f"{summary['slowest']} took {summary['slowest_share']:g}% of the run ({summary['slowest_time']})", 'one plugin dominated the collection time'))
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"{summary.get('plugins', 0)} plugins, {summary.get('commands', 0)} commands, no timeout"))
    return sort_findings(out)
