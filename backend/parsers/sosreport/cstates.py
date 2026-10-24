import os
import re

from parsers.findings import finding, no_data, sort_findings

from ._common import report_root


def parse(directory):
    result = {
        'driver': '',
        'governor': '',
        'cpus': {},
        'state_names': [],
    }

    def read_file(path):
        try:
            with open(path, 'r') as f:
                return f.read().strip()
        except Exception:
            return ''

    directory = report_root(directory)

    cpu_base = os.path.join(directory, 'sys', 'devices', 'system', 'cpu')
    if not os.path.isdir(cpu_base):
        result['findings'] = [finding('info', 'No CPU sysfs capture in this report', 'sys/devices/system/cpu is missing: the cpuidle states cannot be shown')]
        return result

    # Find all cpuN directories
    cpu_dirs = []
    for entry in os.listdir(cpu_base):
        match = re.match(r'^cpu(\d+)$', entry)
        if match:
            cpu_num = int(match.group(1))
            online = read_file(os.path.join(cpu_base, entry, 'online'))
            if online == '0':
                continue
            cpuidle_path = os.path.join(cpu_base, entry, 'cpuidle')
            has_cpuidle = os.path.isdir(cpuidle_path)
            cpu_dirs.append((cpu_num, cpuidle_path if has_cpuidle else None))

    cpu_dirs.sort(key=lambda x: x[0])

    all_state_names = []

    for cpu_num, cpuidle_path in cpu_dirs:
        states = []

        if cpuidle_path:
            # Read driver and governor from first CPU that has cpuidle
            if not result['driver']:
                result['driver'] = read_file(os.path.join(cpuidle_path, 'current_driver'))
                result['governor'] = read_file(os.path.join(cpuidle_path, 'current_governor_ro'))

            # Find all stateN directories, in numeric order (state0, state1, ...,
            # state10) so the state names are collected in the order the
            # kernel exposes them, not in os.listdir order.
            state_entries = []
            for state_entry in os.listdir(cpuidle_path):
                state_match = re.match(r'^state(\d+)$', state_entry)
                if state_match:
                    state_entries.append((int(state_match.group(1)), state_entry))
            for state_num, state_entry in sorted(state_entries):
                state_dir = os.path.join(cpuidle_path, state_entry)
                if os.path.isdir(state_dir):
                    name = read_file(os.path.join(state_dir, 'name'))
                    time_val = read_file(os.path.join(state_dir, 'time'))
                    latency = read_file(os.path.join(state_dir, 'latency'))
                    usage = read_file(os.path.join(state_dir, 'usage'))
                    disable = read_file(os.path.join(state_dir, 'disable'))
                    desc = read_file(os.path.join(state_dir, 'desc'))
                    residency = read_file(os.path.join(state_dir, 'residency'))
                    above = read_file(os.path.join(state_dir, 'above'))
                    below = read_file(os.path.join(state_dir, 'below'))
                    rejected = read_file(os.path.join(state_dir, 'rejected'))

                    state_data = {
                        'order': state_num,
                        'name': name or f'state{state_num}',
                        'time': int(time_val) if time_val.isdigit() else 0,
                        'latency': int(latency) if latency.isdigit() else 0,
                        'usage': int(usage) if usage.isdigit() else 0,
                        'disable': int(disable) if disable.isdigit() else 0,
                        'desc': desc,
                        'residency': int(residency) if residency.isdigit() else 0,
                        'above': int(above) if above.isdigit() else 0,
                        'below': int(below) if below.isdigit() else 0,
                        'rejected': int(rejected) if rejected.isdigit() else 0,
                    }
                    states.append(state_data)

                    if name and name not in all_state_names:
                        all_state_names.append(name)

        states.sort(key=lambda x: x['order'])

        cpufreq_path = os.path.join(cpu_base, f'cpu{cpu_num}', 'cpufreq')
        cur_freq = read_file(os.path.join(cpufreq_path, 'scaling_cur_freq'))
        max_freq = read_file(os.path.join(cpufreq_path, 'scaling_max_freq'))

        result['cpus'][cpu_num] = {
            'states': states,
            'cur_freq': int(cur_freq) if cur_freq.isdigit() else None,
            'max_freq': int(max_freq) if max_freq.isdigit() else None,
        }

    result['state_names'] = all_state_names
    result['verdict'] = verdict(result)
    result['findings'] = findings_for(result)
    return result

def verdict(result):
    """One line about the host's idle behaviour: the driver and governor, the deepest state in use, the share of
    the idle time spent in the deep states (C3 and deeper: name C3+ or a residency over 100 us), disabled states."""
    cpus = result.get('cpus') or {}
    if not cpus:
        return {}
    total = 0
    deep = 0
    deepest = None
    disabled = set()
    for info in cpus.values():
        for s in info.get('states', []):
            total += s['time']
            is_deep = s['order'] >= 3 or s.get('residency', 0) > 100
            if is_deep:
                deep += s['time']
            if s['usage'] and (deepest is None or s['order'] > deepest['order']):
                deepest = s
            if s.get('disable'):
                disabled.add(s['name'])
    return {
        'driver': result.get('driver', ''), 'governor': result.get('governor', ''),
        'deepest': deepest['name'] if deepest else '', 'deep_share': round(100.0 * deep / total, 1) if total else 0.0,
        'disabled': sorted(disabled), 'cpus': len(cpus), 'states': len(result.get('state_names') or []),
    }


def findings_for(result):
    """The Findings strip: no cpuidle driver (a VM or a tuned profile that pins C0), every deep state disabled
    (latency tuning: more power, lower wake-up latency), else the verdict as an informational line."""
    cpus = result.get('cpus') or {}
    if not cpus:
        return [no_data('No C-state data: this report has no cpuidle driver', ['sys/devices/system/cpu/cpu*/cpuidle'], 'typical for a VM (the hypervisor owns the idle states) or a host tuned to stay in C0')]
    v = result.get('verdict') or {}
    out = []
    if not v.get('driver'):
        out.append(finding('info', 'No cpuidle driver', 'the CPUs have no idle states to enter: typical for a VM, or for a host tuned to stay in C0'))
    names = result.get('state_names') or []
    deep_names = [n for n in names if n not in ('POLL', 'C1', 'C1E', 'C1_ACPI')]
    if deep_names and v.get('disabled') and set(deep_names) <= set(v['disabled']):
        out.append(finding('info', 'Every deep C-state is disabled', 'latency tuning (cpu_dma_latency / a tuned profile): the CPUs never sleep deeper than C1, at the cost of power and heat'))
    elif v.get('disabled'):
        out.append(finding('info', f"{len(v['disabled'])} C-state{'s' if len(v['disabled']) != 1 else ''} disabled", ', '.join(v['disabled'])))
    if v.get('driver'):
        out.append(finding('good' if not out else 'info', f"{v['cpus']} CPUs on {v['driver']} / {v['governor'] or 'default governor'}: deepest state in use {v['deepest'] or 'none'}, {v['deep_share']:g}% of the idle time in deep states"))
    return sort_findings(out)
