"""System > Processes: the `ps auxwwwm` and `ps auxZww` captures of a
sosreport (the thread lines of -m attached to their process, the SELinux
label of -Z), parsed by _common.parse_ps_file; sos before 4.0 wrote
`ps auxwww` (no thread lines), read when the -m capture is missing. The
parent PID, which ps aux lacks, is joined from the first ps form that has
it (ps -elfL / -elf / -ef / alxwww / axo, see _common.ppid_map).

Each dataset carries what the page draws: the processes by state (the
threads by state apart), the top CPU and memory consumers (the command's
basename, its PID, the full command line) with the rest summed as
"other", the counts. The Findings strip: zombies, D-state processes
(linked to the hung-task reports with the task's name), CPU and memory
hogs, thread-heavy processes, the totals; no ps capture (info).
"""
import os

from parsers.findings import finding, human_count, no_data, sort_findings

from ._common import PS_HEADERS, parse_ps_file, ppid_map, report_root

PS_SOURCES = [
    ("ps_auxwwwm", ("sos_commands/process/ps_auxwwwm", "sos_commands/process/ps_auxwww")),
    ("ps_auxZww", ("sos_commands/selinux/ps_auxZww",)),
]
STATE_LABELS = {'R': 'running', 'S': 'sleeping', 'D': 'uninterruptible', 'I': 'idle', 'Z': 'zombie', 'T': 'stopped', 't': 'traced', 'X': 'dead', 'W': 'paging', 'P': 'parked'}
# the chart colours of the states: running = ok (the accent), D and stopped = warn, zombie = bad, sleeping and idle on
# their own categorical colours (cat2, cat3: never the accent's blue, so they read apart from R)
STATE_ROLES = {'R': 'ok', 'S': 'cat2', 'D': 'warn', 'Z': 'error', 'I': 'cat3', 'T': 'warn', 't': 'warn'}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _basename(command):
    first = (command or '').split()[0] if (command or '').split() else ''
    if first.startswith('[') and first.endswith(']'):
        return first                       # a kernel thread: [kworker/0:1]
    return os.path.basename(first) or first or '?'


def summarise(ps):
    """The page's data for one dataset: states, the top consumers, the counts."""
    procs = ps.get('processes') or []
    states, thread_states = {}, {}
    for p in procs:
        st = (p.get('STAT') or '-')[:1]
        if st != '-':
            states[st] = states.get(st, 0) + 1
        for t in p.get('threads') or []:
            ts = (t.get('STAT') or '-')[:1]
            if ts != '-':
                thread_states[ts] = thread_states.get(ts, 0) + 1
    def top(key, limit=5):
        ranked = sorted(procs, key=lambda p: -_num(p.get(key)))
        rows = [{'name': _basename(p.get('COMMAND')), 'pid': p.get('PID'), 'user': p.get('USER'), 'command': p.get('COMMAND'), 'value': _num(p.get(key)), 'rss': _num(p.get('RSS'))} for p in ranked[:limit] if _num(p.get(key)) > 0]
        # the same basename twice: the PID tells them apart
        names = {}
        for r in rows:
            names[r['name']] = names.get(r['name'], 0) + 1
        for r in rows:
            r['label'] = f"{r['name']} ({r['pid']})" if names[r['name']] > 1 else r['name']
        other = sum(_num(p.get(key)) for p in ranked[limit:])
        return {'rows': rows, 'other': round(other, 1)}
    return {
        'process_count': len(procs), 'thread_count': ps.get('thread_count') or 0, 'has_threads': bool(ps.get('has_threads')),
        'states': [{'state': k, 'label': STATE_LABELS.get(k, k), 'count': v, 'role': STATE_ROLES.get(k, 'series')} for k, v in sorted(states.items(), key=lambda kv: -kv[1])],
        'thread_states': [{'state': k, 'label': STATE_LABELS.get(k, k), 'count': v} for k, v in sorted(thread_states.items(), key=lambda kv: -kv[1])],
        'top_cpu': top('%CPU'), 'top_mem': top('%MEM'),
    }


def parse(directory):
    root = report_root(directory)
    ppids = ppid_map(root)
    result = {}
    for name, rel_paths in PS_SOURCES:
        ps_path = next((p for p in (os.path.join(root, r) for r in rel_paths) if os.path.isfile(p)), None)
        if ps_path:
            result[name] = parse_ps_file(ps_path, variant=name, ppids=ppids)
            result[name]['source'] = os.path.relpath(ps_path, root)
        else:
            result[name] = {"headers": list(PS_HEADERS), "processes": [], "thread_count": 0, "has_threads": False, "source": ""}
        result[name]['summary'] = summarise(result[name])
    primary = result['ps_auxwwwm'] if result['ps_auxwwwm']['processes'] else result['ps_auxZww']
    result['findings'] = findings_for(primary)
    return result


def findings_for(ps):
    """The Findings strip, on processes (a thread is not a process): zombies, processes in uninterruptible sleep
    (linked to the hung-task reports with the task's name), the processes over 50% CPU or 25% of memory, processes
    with 1000+ threads, the totals with the threads' states; no ps capture (info)."""
    procs = ps.get('processes') or []
    if not procs:
        return [no_data('No process listing in this report', ['sos_commands/process/ps_auxwwwm', 'ps_auxwww', 'sos_commands/selinux/ps_auxZww'], 'sos ran without the process plugin, or the captures are empty')]
    out = []

    def names(items, extra):
        return ', '.join(f"{_basename(r.get('COMMAND'))} (pid {r.get('PID')}{extra(r)})" for r in items)

    zombies = [r for r in procs if 'Z' in (r.get('STAT') or '')]
    if zombies:
        out.append(finding('warn', f"{len(zombies)} zombie process{'es' if len(zombies) != 1 else ''}", "terminated but not reaped by the parent: " + names(zombies[:5], lambda r: '') + (' \u2026' if len(zombies) > 5 else ''), count=len(zombies)))
    dstate = [r for r in procs if (r.get('STAT') or '').startswith('D') or any((t.get('STAT') or '').startswith('D') for t in r.get('threads') or [])]
    if dstate:
        out.append(finding('bad' if len(dstate) >= 5 else 'warn', f"{len(dstate)} process{'es' if len(dstate) != 1 else ''} in uninterruptible sleep (D)",
                           "waiting on I/O or a lock: " + names(dstate[:5], lambda r: '') + (' \u2026' if len(dstate) > 5 else '') + "; the kernel's hung-task reports name the ones blocked for long",
                           tab='kernel', sub_tab='kernel_hung_task', query=_basename(dstate[0].get('COMMAND'))[:15], count=len(dstate)))
    hogs = sorted((r for r in procs if _num(r.get('%CPU')) >= 50), key=lambda r: -_num(r.get('%CPU')))
    if hogs:
        out.append(finding('warn', f"{len(hogs)} process{'es' if len(hogs) != 1 else ''} over 50% CPU", names(hogs[:3], lambda r: f", {_num(r.get('%CPU')):g}%") + (' \u2026' if len(hogs) > 3 else ''), count=len(hogs)))
    big = sorted((r for r in procs if _num(r.get('%MEM')) >= 25), key=lambda r: -_num(r.get('%MEM')))
    if big:
        out.append(finding('warn', f"{len(big)} process{'es' if len(big) != 1 else ''} over 25% of memory", names(big[:3], lambda r: f", {_num(r.get('%MEM')):g}%") + (' \u2026' if len(big) > 3 else ''), tab='cgroups', sub_tab='cgroups_memory', count=len(big)))
    heavy = sorted((r for r in procs if (r.get('thread_count') or 0) >= 1000), key=lambda r: -(r.get('thread_count') or 0))
    if heavy:
        out.append(finding('warn', f"{len(heavy)} process{'es' if len(heavy) != 1 else ''} with 1000+ threads", names(heavy[:3], lambda r: f", {human_count(r.get('thread_count'))} threads"), count=len(heavy)))
    summary = summarise(ps)
    running = sum(s['count'] for s in summary['states'] if s['state'] == 'R')
    trunning = sum(s['count'] for s in summary['thread_states'] if s['state'] == 'R')
    totals = f"{human_count(len(procs))} processes" + (f", {human_count(summary['thread_count'])} threads" if summary['has_threads'] else '')
    detail = f"{running} running, {len(dstate)} in D, {len(zombies)} zombie" + (f"; threads: {trunning} running" if summary['has_threads'] else '') + (" (the listing has no thread lines: `ps auxwww`)" if not summary['has_threads'] and ps.get('source', '').endswith('ps_auxwww') else '')
    out.append(finding('info', totals, detail))
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"No zombie, no D-state process, no CPU or memory hog among {human_count(len(procs))} processes"))
    return sort_findings(out)
