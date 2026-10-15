import os
import re
from collections import defaultdict

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
    summary['high_wait_tasks'] = [t for t in tasks if t['wait_time'] > 0.1]

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
        r'([-.\d]+)\s+'
        r'([-.\d]+)\s+'
        r'(.+)'
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
                    'sum_block': float(sum_block),
                    'group': group.strip(),
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

    sched_debug_path = os.path.join(directory, "sys/kernel/debug/sched/debug")
    if os.path.exists(sched_debug_path):
        with open(sched_debug_path, 'r') as f:
            sched_debug_content = f.read()
        sched_data = parse_sched_debug(sched_debug_content)
        result["sched"] = sched_data
    else:
        result["sched"] = {"error": "sched/debug file not found"}

    return result
