import os
import re


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

    # Handle single-entry subdirectory (common sosreport structure)
    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    cpu_base = os.path.join(directory, 'sys', 'devices', 'system', 'cpu')
    if not os.path.isdir(cpu_base):
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

    return result
