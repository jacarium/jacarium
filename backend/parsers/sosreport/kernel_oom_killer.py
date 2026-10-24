"""Kernel OOM Killer: the out-of-memory kills in a sosreport's kernel
logs, one row per kill, for the incident board.

kernel_log.scan() collects each "invoked oom-killer" block (the trigger,
the Mem-Info, the cgroup usage/limit, the task dump, the oom-kill
constraint line and the "Killed process" line, in the RHEL 7 to RHEL 10
forms). This module shapes them for tabs/sosreport_kernel_oom_killer.html:

  oom_summary  kills, first/last, the largest victim, victims / cgroups /
               constraints, the timeline
  oom_events   per kill: the victim with its rss figures, the trigger and
               allocation, the constraint in plain words, the memory state,
               the top memory users of the task dump
  oom_killer   the raw blocks, one string each, as the earlier template and
               the tests read them (kept as is)
"""
from parsers.findings import finding, no_data, sort_findings
from collections import Counter

from . import kernel_log as kl

TOP_TASKS = 30


def parse(directory):
    scan = kl.scan(directory)
    blocks = scan['oom']
    events = []
    for b in blocks:
        for kill in b['kills']:
            events.append(_event(b, kill))
    events.sort(key=lambda e: e['ts_sort'], reverse=True)
    for i, e in enumerate(events, 1):
        e['id'] = f"o{i}"
    return {
        'oom_killer': ['\n'.join(b['raw']) + '\n' for b in blocks],
        'oom_summary': _summary(blocks, events, scan),
        'findings': findings_for(_summary(blocks, events, scan), scan),
        'oom_events': events,
    }


def _event(b, kill):
    c = b['constraint'] or {}
    mem = b['mem']
    memcg = b['memcg']
    pid = kill.get('pid', '')
    tasks = []
    for row in b['tasks']:
        rss_kb = _pages_kb(row.get('rss'))
        tasks.append({
            'pid': row['pid'], 'uid': row.get('uid', ''), 'name': row.get('name', ''),
            'rss': kl.human_kb(rss_kb), 'rss_kb': rss_kb,
            'total_vm': kl.human_kb(_pages_kb(row.get('total_vm'))), 'total_vm_kb': _pages_kb(row.get('total_vm')),
            'swap': kl.human_kb(_pages_kb(row.get('swapents'))), 'swap_kb': _pages_kb(row.get('swapents')),
            'oom_score_adj': row.get('oom_score_adj', ''),
            'killed': str(row['pid']) == str(pid),
        })
    tasks.sort(key=lambda t: -(t['rss_kb'] or 0))
    victim_row = next((t for t in tasks if t['killed']), None)
    tasks = tasks[:TOP_TASKS]
    if victim_row and victim_row not in tasks:
        tasks.append(victim_row)

    free_kb = mem.get('pages_free', mem.get('node_free'))  # the Mem-Info total, else the zones' sum
    swap_total = mem.get('swap_total_kb')
    swap_free = mem.get('swap_free_kb')
    anon_active = mem.get('node_active_anon', mem.get('pages_active_anon'))
    anon_inactive = mem.get('node_inactive_anon', mem.get('pages_inactive_anon'))
    file_kb = _sum(mem.get('node_active_file', mem.get('pages_active_file')), mem.get('node_inactive_file', mem.get('pages_inactive_file')))
    slab_kb = _sum(mem.get('node_slab_reclaimable', mem.get('pages_slab_reclaimable')), mem.get('node_slab_unreclaimable', mem.get('pages_slab_unreclaimable')))
    shmem_kb = mem.get('node_shmem', mem.get('pages_shmem'))
    if not anon_active and memcg.get('stat_anon') is not None:
        anon_active = memcg['stat_anon']
    if not file_kb and memcg.get('stat_file') is not None:
        file_kb = memcg['stat_file']

    name = c.get('name', '')
    cgroup = c.get('cgroup') or memcg.get('path') or ''
    text = kl.CONSTRAINT_TEXT.get(name, '')
    if name == 'CONSTRAINT_NONE' and (free_kb is not None or swap_total is not None):
        bits = []
        if free_kb is not None:
            bits.append(f"{kl.human_kb(free_kb)} free")
        if swap_total:
            bits.append(f"swap {kl.human_kb(swap_free or 0)} free of {kl.human_kb(swap_total)}")
        elif swap_total == 0:
            bits.append("no swap")
        text += f" At the time: {', '.join(bits)}."
    elif name == 'CONSTRAINT_MEMCG' and memcg.get('limit_kb'):
        text = text.replace('hit its own limit', f"hit its own limit ({kl.human_kb(memcg.get('usage_kb'))} used of {kl.human_kb(memcg['limit_kb'])})")
    elif not name and b.get('choice'):
        text = 'An older kernel (RHEL 7 style) without the constraint line: the kernel chose the task with the highest badness score.'
    if c.get('rest') and 'oom_group' in c['rest']:
        text += " The cgroup has memory.oom.group set, so every task in it was killed together."

    if b.get('no_kill'):
        text = (text + ' ' if text else '') + 'No "Killed process" line follows this invocation: either no killable process was found or the log was cut short.'
    return {
        'id': '', 'ts': kl.fmt_ts(b), 'ts_sort': kl.sort_ts(b), 'severity': 'critical' if not b.get('no_kill') else 'warning', 'sources': b['sources'], 'no_kill': bool(b.get('no_kill')),
        'victim': {
            'comm': kill.get('comm', ''), 'pid': pid, 'uid': kill.get('uid', ''),
            'total_vm': kl.human_kb(kill.get('total-vm')), 'anon_rss': kl.human_kb(kill.get('anon-rss')), 'anon_rss_kb': kill.get('anon-rss'),
            'file_rss': kl.human_kb(kill.get('file-rss')), 'shmem_rss': kl.human_kb(kill.get('shmem-rss')), 'pgtables': kl.human_kb(kill.get('pgtables')),
            'oom_score_adj': kill.get('oom_score_adj', ''),
        },
        'trigger': b['trigger'],
        'constraint': {
            'name': name, 'text': text, 'cgroup': cgroup, 'cpuset': c.get('cpuset', ''), 'mems': c.get('mems', ''),
            'memcg_usage': kl.human_kb(memcg.get('usage_kb')), 'memcg_limit': kl.human_kb(memcg.get('limit_kb')) if memcg.get('limit_kb', 0) < 10 ** 12 else '',
            'oom_group': bool(c.get('rest') and 'oom_group' in c['rest']), 'global': c.get('global', False),
        },
        'mem': {
            'ram': kl.human_kb(mem.get('ram_kb')), 'free': kl.human_kb(free_kb),
            'swap_free': kl.human_kb(swap_free) if swap_total else '', 'swap_total': kl.human_kb(swap_total) if swap_total else '',
            'active_anon': kl.human_kb(anon_active), 'inactive_anon': kl.human_kb(anon_inactive),
            'file': kl.human_kb(file_kb), 'slab': kl.human_kb(slab_kb), 'shmem': kl.human_kb(shmem_kb),
        },
        'tasks': tasks, 'tasks_total': b['tasks_total'],
        'frames': [{'text': f['text'], 'unreliable': f['unreliable'], 'fault': False, 'module': f['module']} for f in b['frames']],
        'kernel': b['kernel'], 'hardware': b['hardware'], 'taint': b['taint']['flags'], 'taint_text': b['taint']['text'],
        'raw': b['raw'],
    }


def _pages_kb(value):
    try:
        return int(value) * 4
    except (TypeError, ValueError):
        return None


def _sum(a, b):
    if a is None and b is None:
        return None
    return (a or 0) + (b or 0)


def short_cgroup(path):
    """A long cgroup path (kubepods) keeps its first and last component."""
    if not path or len(path) <= 60:
        return path
    parts = [p for p in path.split('/') if p]
    last = parts[-1]
    if len(last) > 28:  # a crio-<64 hex>.scope: keep its head and tail
        last = last[:12] + '...' + last[-10:]
    if len(parts) <= 2:
        return f"/{parts[0]}/{last}" if len(parts) == 2 else path
    return f"/{parts[0]}/.../{last}"


def _summary(blocks, events, scan):
    if not events:
        return {'kills': 0, 'first': '', 'last': '', 'largest': '', 'victims': [], 'cgroups': [], 'constraints': [], 'timeline': None,
                'sources': scan['sources'], 'capped': scan['capped']}
    victims = Counter(e['victim']['comm'] for e in events if e['victim']['comm'])
    cgroups = Counter(short_cgroup(e['constraint']['cgroup']) for e in events if e['constraint']['cgroup'])
    constraints = Counter(e['constraint']['name'] for e in events if e['constraint']['name'])
    largest = max((e['victim']['anon_rss_kb'] or 0) for e in events)
    stamps = [b['ts'] for b in blocks if b['ts']]
    per_day = stamps and (max(stamps) - min(stamps)).total_seconds() > 2 * 86400
    ordered = sorted(events, key=lambda e: e['ts_sort'])
    return {
        'kills': len(events), 'first': ordered[0]['ts'], 'last': ordered[-1]['ts'], 'largest': kl.human_kb(largest) if largest else '',
        'victims': kl.top(victims), 'cgroups': kl.top(cgroups), 'constraints': kl.top(constraints),
        'timeline': kl.timeline(blocks, 'Kills per day' if per_day else 'Kills per hour'),
        'sources': scan['sources'], 'capped': scan['capped'],
    }

def findings_for(summary, scan):
    """The Findings strip: the OOM kills (bad) with the victims and the cgroups, the largest victim and the last
    kill; none (good, with the sources scanned); no kernel log (info)."""
    if not scan['sources']:
        return [no_data('No kernel log in this report', ['sos_commands/logs/journalctl*', 'sos_commands/kernel/dmesg*', 'var/log/messages*', 'var/log/dmesg*'], 'no journal capture, dmesg or syslog: the kernel tabs have nothing to read')]
    out = []
    if summary.get('kills'):
        victims = ', '.join(f"{v.get('name', '?')} ({v.get('count', '')}x)" for v in (summary.get('victims') or [])[:4])
        out.append(finding('bad', f"{summary['kills']} OOM kill{'s' if summary['kills'] != 1 else ''}", f"the last at {summary.get('last', '')}; victims: {victims or '?'}" + (f"; the largest {summary['largest']}" if summary.get('largest') else ''), tab='cgroups', sub_tab='cgroups_memory', count=summary['kills']))
    if summary.get('capped'):
        out.append(finding('info', 'The kernel log scan was capped', 'more kills than the scan keeps: the oldest are not counted'))
    if not out:
        out.append(finding('good', 'No OOM kill in the kernel logs', 'scanned: ' + ', '.join(scan['sources'])))
    return sort_findings(out)
