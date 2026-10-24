"""System > Scheduler Debug: the kernel's scheduler debug dump of a
sosreport (per-CPU run queues, the cfs / rt / dl queue stats and the
runnable tasks), from the first of

  sys/kernel/debug/sched/debug   kernel 5.14+ (RHEL 9/10, sos 4.3+)
  sys/kernel/debug/sched_debug   kernel 5.x before 5.14
  proc/sched_debug               RHEL 7 and 8 (kernel 3.10 / 4.18)

The runnable-tasks line has nine columns up to kernel 5.13 (state, task,
PID, tree-key, switches, prio, wait-time, sum-exec, sum-sleep, then the
cgroup path) and a tenth, sum-block, from 5.14: both forms are parsed,
sum_block is 0.0 where the kernel printed none.
"""
import os
import re
from collections import defaultdict

from parsers.findings import finding, no_data, sort_findings, human_count

from ._common import first_existing, read_text, report_root

CAPTURES = ('sys/kernel/debug/sched/debug', 'sys/kernel/debug/sched_debug', 'proc/sched_debug')

def summarize_cpu_tasks(tasks, cpu_info):
    summary = {
        'total_tasks': len(tasks),
        'total_switches': sum(t['switches'] for t in tasks),
        'state_counts': defaultdict(int),
        'top_exec_tasks': [],
        'high_wait_tasks': [],
        'cpu_info': {},
    }

    for t in tasks:
        summary['state_counts'][t['state']] += 1

    summary['top_exec_tasks'] = sorted(tasks, key=lambda x: x['sum_exec'], reverse=True)[:5]
    summary['top_switch_tasks'] = sorted(tasks, key=lambda x: x['switches'], reverse=True)[:5]
    summary['high_wait_tasks'] = [t for t in tasks if t['wait_time'] >= 1.0]   # a millisecond and more (the old 0.1 ms flagged almost every task)

    summary['cpu_info'] = {
        'curr_pid': cpu_info.get('curr->pid', '0'),
    }
    return summary


def parse_sched_debug(text):
    parsed = {
        'per_cpu': defaultdict(lambda: {
            'cpu_info': {},
            'cfs_rq': defaultdict(dict),
            'rt_rq': {},
            'dl_rq': {},
            'tasks': []
        }),
        'summary': {},
        'error': None,
    }

    lines = text.splitlines()

    cpu_re = re.compile(r'^cpu#(\d+),')
    cfs_rq_re = re.compile(r'^cfs_rq\[(\d+)]:(.*)')
    rt_rq_re = re.compile(r'^rt_rq\[(\d+)]')
    dl_rq_re = re.compile(r'^dl_rq\[(\d+)]')
    key_val_re = re.compile(r'^\s*\.(.+?)\s*:\s*(.+)$')

    task_line_re = re.compile(
        r'^\s*((?:>R|[RSIDTtZXxW])\s*)'
        r'(\S+)\s+'
        r'(\d+)\s+'
        r'([-.\d]+)\s+'
        r'(\d+)\s+'
        r'(\d+)\s+'
        r'([-.\d]+)\s+'
        r'([-.\d]+)\s+'
        r'([-.\d]+)'
        r'(?:\s+([-.\d]+))?'      # sum-block: kernel 5.14+ only
        r'(?:\s+(\S.*))?$'        # the cgroup path (CONFIG_CGROUP_SCHED)
    )


    current_cpu = None
    current_group = None
    current_section = None
    in_tasks = False

    for line in lines:
        line = line.strip()

        if not line:
            continue

        if 'runnable tasks:' in line:
            in_tasks = True
            continue

        if line.startswith('---'):
            continue

        if in_tasks and current_cpu is not None:
            m = task_line_re.match(line)
            if m:
                state, name, pid, tree_key, switches, prio, wait_time, sum_exec, sum_sleep, sum_block, group = m.groups()
                task = {
                    'state': state.strip(),
                    'name': name.strip(),
                    'pid': int(pid),
                    'tree_key': float(tree_key),
                    'switches': int(switches),
                    'prio': int(prio),
                    'wait_time': float(wait_time),
                    'sum_exec': float(sum_exec),
                    'sum_sleep': float(sum_sleep),
                    'sum_block': float(sum_block) if sum_block is not None else 0.0,
                    'group': (group or '').strip(),
                }
                parsed['per_cpu'][current_cpu]['tasks'].append(task)
                continue

        m = cpu_re.match(line)
        if m:
            current_cpu = int(m.group(1))
            current_group = None
            current_section = 'cpu_info'
            in_tasks = False
            continue

        m = cfs_rq_re.match(line)
        if m:
            cpu_id = int(m.group(1))
            group = m.group(2).strip() or "/"
            current_cpu = cpu_id
            current_group = group
            current_section = 'cfs_rq'
            in_tasks = False
            continue

        m = rt_rq_re.match(line)
        if m:
            current_cpu = int(m.group(1))
            current_section = 'rt_rq'
            in_tasks = False
            continue

        m = dl_rq_re.match(line)
        if m:
            current_cpu = int(m.group(1))
            current_section = 'dl_rq'
            in_tasks = False
            continue

        m = key_val_re.match(line)
        if m:
            key = m.group(1).strip()
            val = m.group(2).strip()

            try:
                if '.' in val or 'e' in val.lower():
                    val = float(val)
                else:
                    val = int(val)
            except ValueError:
                pass

            if current_section == 'cpu_info':
                parsed['per_cpu'][current_cpu]['cpu_info'][key] = val
            elif current_section == 'cfs_rq':
                parsed['per_cpu'][current_cpu]['cfs_rq'][current_group][key] = val
            elif current_section == 'rt_rq':
                parsed['per_cpu'][current_cpu]['rt_rq'][key] = val
            elif current_section == 'dl_rq':
                parsed['per_cpu'][current_cpu]['dl_rq'][key] = val

    for cpu_id, cpu_data in parsed['per_cpu'].items():
        cpu_data['summary'] = summarize_cpu_tasks(cpu_data['tasks'], cpu_data['cpu_info'])

    return parsed


def parse(directory):
    result = {}

    root = report_root(directory)
    sched_debug_path = first_existing(root, *CAPTURES)
    if sched_debug_path:
        sched_data = parse_sched_debug(read_text(sched_debug_path))
        sched_data['source'] = os.path.relpath(sched_debug_path, root)
        result["sched"] = sched_data
        result['findings'] = findings_for(sched_data)
    else:
        result["sched"] = {"error": "no scheduler debug capture in this report (looked for " + ", ".join(CAPTURES) + ")"}
        result['findings'] = [no_data('No scheduler debug capture in this report', list(CAPTURES), 'sos collects it from debugfs (kernel 5.14+) or proc/sched_debug; a container host or a trimmed report may lack it')]

    return result

KERNEL_RT = re.compile(r'^(migration|ksoftirqd|watchdog|rcu|kworker|cpuhp|idle_inject|irq/|posixcputmr|ktimers)')


def _median(values):
    vals = sorted(values)
    return vals[len(vals) // 2] if vals else 0


def mark_outliers(per_cpu, out):
    """The CPUs far from the others: context switches over three times the median (and over 10,000), four or more
    runnable tasks, an average idle time under a tenth of the median. Each CPU's cpu_info gets an `outlier` dict
    (the page colours those bars in the warn colour); each class is one WARN finding naming the CPUs."""
    def num(info, key):
        try:
            return float(info.get('cpu_info', {}).get(key, 0) or 0)
        except (TypeError, ValueError):
            return 0.0
    if len(per_cpu) < 4:
        return
    sw = {c: num(i, 'nr_switches') for c, i in per_cpu.items()}
    idle = {c: num(i, 'avg_idle') for c, i in per_cpu.items()}
    run = {c: num(i, 'nr_running') for c, i in per_cpu.items()}
    sw_med, idle_med = _median(sw.values()), _median(idle.values())
    hot = [c for c, v in sw.items() if sw_med > 0 and v > 3 * sw_med and v > 10000]
    busy = [c for c, v in run.items() if v >= 4]
    sleepless = [c for c, v in idle.items() if idle_med > 0 and v < 0.1 * idle_med]
    for c, info in per_cpu.items():
        info.setdefault('cpu_info', {})['outlier'] = {'switches': c in hot, 'running': c in busy, 'idle': c in sleepless}
    if hot:
        hot.sort(key=lambda c: -sw[c])
        out.append(finding('warn', f"{len(hot)} CPU{'s' if len(hot) != 1 else ''} with context switches far above the median", ', '.join(f"cpu{c}: {human_count(sw[c])} vs {human_count(sw_med)} median" for c in hot[:6]) + (' …' if len(hot) > 6 else '') + ': an interrupt or a thread pinned there', count=len(hot)))
    if sleepless:
        sleepless.sort(key=lambda c: idle[c])
        out.append(finding('warn', f"{len(sleepless)} CPU{'s' if len(sleepless) != 1 else ''} with near-zero idle time", ', '.join(f"cpu{c}: {idle[c]:g} vs {idle_med:g} median" for c in sleepless[:6]) + (' …' if len(sleepless) > 6 else '') + ': the scheduler never finds them idle', count=len(sleepless)))


def findings_for(parsed):
    """The Findings strip: CPUs with four or more runnable tasks, the tasks that waited longest for a CPU (the top
    decile of wait-time, at least 1 ms; the threshold is kept in parsed['wait_threshold_ms']), tasks in D (linked to
    the hung-task reports), real-time tasks outside the kernel's own."""
    out = []
    per_cpu = parsed.get('per_cpu') or {}
    deep, all_tasks = [], []
    mark_outliers(per_cpu, out)
    for cpu, info in per_cpu.items():
        try:
            nr = int(info.get('cpu_info', {}).get('nr_running', 0))
        except (TypeError, ValueError):
            nr = 0
        if nr >= 4:
            deep.append((cpu, nr))
        all_tasks.extend((cpu, t) for t in info.get('tasks', []))
    if deep:
        deep.sort(key=lambda x: -x[1])
        out.append(finding('bad' if deep[0][1] >= 8 else 'warn', f"{len(deep)} CPU{'s' if len(deep) != 1 else ''} with 4+ runnable tasks", ', '.join(f"cpu{c}: {n}" for c, n in deep[:8]) + (' …' if len(deep) > 8 else ''), count=len(deep)))
    waits = sorted(t.get('wait_time', 0) for _, t in all_tasks)
    if waits:
        p90 = waits[int(len(waits) * 0.9)] if len(waits) >= 10 else waits[-1]
        threshold = max(p90, 1.0)
        parsed['wait_threshold_ms'] = round(threshold, 2)
        long_wait = sorted(((c, t) for c, t in all_tasks if t.get('wait_time', 0) >= threshold), key=lambda x: -x[1].get('wait_time', 0))
        if long_wait:
            out.append(finding('bad' if long_wait[0][1]['wait_time'] >= 100 else 'warn', f"{len(long_wait)} task{'s' if len(long_wait) != 1 else ''} waited {threshold:.0f}+ ms for a CPU",
                               ', '.join(f"{t['name']} (pid {t['pid']}, cpu{c}, {t['wait_time']:.1f} ms)" for c, t in long_wait[:5]) + (' …' if len(long_wait) > 5 else ''), count=len(long_wait)))
    dstate = [(c, t) for c, t in all_tasks if t.get('state') == 'D']
    if dstate:
        out.append(finding('warn', f"{len(dstate)} task{'s' if len(dstate) != 1 else ''} in uninterruptible sleep", ', '.join(f"{t['name']} (pid {t['pid']})" for _, t in dstate[:5]), tab='kernel', sub_tab='kernel_hung_task', count=len(dstate)))
    rt = [(c, t) for c, t in all_tasks if isinstance(t.get('prio'), int) and t['prio'] < 100 and not KERNEL_RT.match(t.get('name', ''))]
    if rt:
        out.append(finding('info', f"{len(rt)} real-time task{'s' if len(rt) != 1 else ''}", ', '.join(f"{t['name']} (pid {t['pid']}, prio {t['prio']})" for _, t in rt[:5]) + (' …' if len(rt) > 5 else ''), count=len(rt)))
    if per_cpu and not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"No deep run queue, long CPU wait or D-state task on {len(per_cpu)} CPUs"))
    return sort_findings(out)
