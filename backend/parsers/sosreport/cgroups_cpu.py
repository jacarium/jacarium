import os
import time
from collections import defaultdict

_previous_usage_percpu = {}

def read_cgroup_file(path):
    try:
        with open(path, 'r') as f:
            return f.read().strip()
    except Exception:
        return None

def detect_cgroup_version(path):
    try:
        with open(f"{path}/proc/mounts", "r") as f:
            mounts = f.read()
    except Exception as e:
        return f"error: {e}"
    return "cgroup2" if "cgroup2" in mounts else "cgroup"

def parse_cgroup_dir(base_dir, keys_of_interest):
    result = {}

    for entry in os.listdir(base_dir):
        full_path = os.path.join(base_dir, entry)

        if os.path.isdir(full_path):
            sub_dict = parse_cgroup_dir(full_path, keys_of_interest)
            if sub_dict:
                result[entry] = sub_dict
        else:
            if entry in keys_of_interest:
                value = read_cgroup_file(full_path)
                if value is not None:
                    if entry == "cpuacct.usage_percpu":
                        try:
                            parsed = [int(x) for x in value.split()]
                            total = sum(parsed)
                            if total > 0:
                                percent_per_core = [round((core / total) * 100, 2) for core in parsed]
                            else:
                                percent_per_core = [0.0 for _ in parsed]
                            result[entry] = percent_per_core
                        except Exception:
                            result[entry] = value
                    else:
                        result[entry] = value
    return result

def merge_dicts(d1, d2):
    result = {}
    keys = set(d1.keys()).union(set(d2.keys()))
    for key in keys:
        v1 = d1.get(key)
        v2 = d2.get(key)
        if isinstance(v1, dict) and isinstance(v2, dict):
            result[key] = merge_dicts(v1, v2)
        else:
            result[key] = v1 if v2 is None else v2 if v1 is None else (v1, v2)
    return result


def parse_ps_file(ps_path, variant="ps_auxwwwm"):
    processes = []

    standard_headers = [
        "USER", "LABEL", "PID", "PPID", "%CPU", "%MEM", "VSZ", "RSS", "TTY",
        "STAT", "START", "TIME", "COMMAND"
    ]

    try:
        with open(ps_path, "r") as f:
            lines = f.readlines()

        if not lines:
            return {"headers": standard_headers, "processes": []}

        header_line = lines[0].strip()
        raw_headers = header_line.split()

        header_map = {h: i for i, h in enumerate(raw_headers)}
        expected_fields = len(raw_headers)

        for required in ["PID", "%CPU", "COMMAND"]:
            if required not in header_map:
                return {"error": f"Missing expected header: {required}", "headers": standard_headers, "processes": []}

        pid_index = header_map["PID"]
        cpu_index = header_map["%CPU"]
        command_index = header_map["COMMAND"]

        raw_headers.insert(pid_index + 1, "PPID")

        last_pid = None
        last_cmd = None

        for line in lines[1:]:
            line = line.strip()
            if not line:
                continue

            parts = line.split(None, expected_fields - 1)
            if len(parts) < expected_fields:
                parts += ['-'] * (expected_fields - len(parts))

            pid = parts[pid_index]
            cmd = parts[command_index]

            is_thread = pid == '-'

            if not is_thread:
                last_pid = pid
                if cmd != '-':
                    last_cmd = cmd

            ppid = last_pid if is_thread else '-'
            parts.insert(pid_index + 1, ppid)

            if is_thread and (cmd == '-' or not cmd.strip()):
                parts[-1] = last_cmd or '-'

            full_data = dict(zip(raw_headers, parts))
            normalized = {h: full_data.get(h, '-') for h in standard_headers}

            processes.append(normalized)

        return {
            "headers": standard_headers,
            "processes": processes
        }

    except Exception as e:
        return {
            "error": str(e),
            "headers": standard_headers,
            "processes": []
        }



def build_sysfs_cgroup_pid_index(directory):
    base_path = os.path.join(directory, "sys/fs/cgroup/cpu,cpuacct")
    pid_to_cgroup = {}

    try:
        for root, dirs, files in os.walk(base_path):
            if "cgroup.procs" in files:
                cgroup_path = root.replace(base_path, "") or "/"
                procs_file = os.path.join(root, "cgroup.procs")
                try:
                    with open(procs_file) as f:
                        for line in f:
                            pid = line.strip()
                            if pid.isdigit():
                                pid_to_cgroup[pid] = cgroup_path
                except Exception:
                    continue
    except Exception as e:
        print(f"Error while building sysfs cgroup PID index: {e}")
        return {}

    return pid_to_cgroup

def get_processes_per_full_cgroup_from_ps(directory, ps_path, proc_root):
    parsed_result = parse_ps_file(ps_path)

    if "error" in parsed_result:
        print(f"[ERROR] Failed to parse {ps_path}: {parsed_result['error']}")
        return defaultdict(list)

    processes = parsed_result.get("processes", [])

    mapping = defaultdict(list)

    sysfs_pid_to_cgroup = build_sysfs_cgroup_pid_index(directory)

    for proc in processes:
        pid = proc.get("PID", "-")
        if not pid.isdigit():
            continue

        cgroup_path = None
        lines = []
        cgroup_file = os.path.join(proc_root, pid, "cgroup")

        try:
            with open(cgroup_file) as f:
                lines = f.readlines()
        except Exception:
            cgroup_path = sysfs_pid_to_cgroup.get(pid)

        if not cgroup_path and lines:
            cpuacct_match = None
            for line in lines:
                parts = line.strip().split(":")
                if len(parts) == 3:
                    controllers = parts[1].split(",")
                    path = parts[2]
                    if "cpu,cpuacct" in parts[1]:
                        cpuacct_match = path
                        break
                    elif any("cpu" in ctrl for ctrl in controllers) and not cpuacct_match:
                        cpuacct_match = path

            if cpuacct_match:
                cgroup_path = cpuacct_match


        if cgroup_path:
            norm_path = cgroup_path if cgroup_path.startswith("/") else "/" + cgroup_path
            mapping[norm_path].append({
                'proc_pid': pid,
                'proc_cmd': proc.get("COMMAND", "-"),
                'proc_cpu': float(proc.get("%CPU", 0.0)),
                'cgroup_name': norm_path
            })

    return mapping

def replace_with_processes(data, proc_map, path=""):
    new_dict = {}
    for key, val in data.items():
        current_path = f"{path}/{key}" if path else f"/{key}"

        if isinstance(val, dict):
            sub = replace_with_processes(val, proc_map, current_path)
            proc_list = proc_map.get(current_path)
            if proc_list:
                sub['_processes'] = proc_list
            new_dict[key] = sub
        else:
            new_dict[key] = val
    return new_dict

def calculate_percpu_usage_percent(cgroup_path, current_usage_percpu, interval_ns):
    global _previous_usage_percpu

    prev = _previous_usage_percpu.get(cgroup_path)
    if prev is None:
        _previous_usage_percpu[cgroup_path] = current_usage_percpu
        return [0.0] * len(current_usage_percpu)

    delta_percpu = [max(0, cur - p) for cur, p in zip(current_usage_percpu, prev)]
    _previous_usage_percpu[cgroup_path] = current_usage_percpu

    total_delta = sum(delta_percpu)
    if total_delta == 0:
        return [0.0] * len(delta_percpu)

    percpu_percent = [(delta / interval_ns) * 100.0 for delta in delta_percpu]
    return percpu_percent

def scale_core_usage(core_usage, total_cpu):
    total_core = sum(core_usage)
    if total_core == 0:
        return [0.0 for _ in core_usage]

    scale_factor = total_cpu / total_core
    scaled_usage = [round(usage * scale_factor, 2) for usage in core_usage]
    return scaled_usage


def add_scaled_core_usage_and_accumulate(cgroup_dict):
    total_core_usage = []

    def recurse(node):
        nonlocal total_core_usage
        for key, val in node.items():
            if isinstance(val, dict):
                if '_processes' in val:
                    core_usage = val.get('cpuacct.usage_percpu', [])
                    for proc in val['_processes']:
                        proc_cpu = proc.get('proc_cpu', 0.0)
                        proc['scaled_core_usage'] = scale_core_usage(core_usage, proc_cpu)

                        if not total_core_usage:
                            total_core_usage = proc['scaled_core_usage'].copy()
                        else:
                            total_core_usage = [
                                round(x + y, 2) for x, y in zip(total_core_usage, proc['scaled_core_usage'])
                            ]
                recurse(val)

    recurse(cgroup_dict)
    return total_core_usage

def parse(directory):
    result = {}

    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    cgroup_version = detect_cgroup_version(directory)
    if not os.path.exists(os.path.join(directory, "sys/fs/cgroup")):
        return result

    cpu_path = os.path.join(directory, "sys/fs/cgroup/cpu,cpuacct")
    cpuset_path = os.path.join(directory, "sys/fs/cgroup/cpuset")

    if not os.path.exists(cpu_path) or not os.path.exists(cpuset_path):
        return result

    cpu_data = parse_cgroup_dir(cpu_path, {"cpu.cfs_quota_us", "cpu.cfs_period_us", "cpuacct.usage_percpu"})
    cpuset_data = parse_cgroup_dir(cpuset_path, {"cpuset.cpus"})
    merged_data = merge_dicts(cpu_data, cpuset_data)

    root_files = {k: v for k, v in merged_data.items() if not isinstance(v, dict)}
    subdirs     = {k: v for k, v in merged_data.items() if isinstance(v, dict)}
    merged_data = {"": root_files, **subdirs}

    ps_variants = {
        "ps_auxwwwm": "sos_commands/process/ps_auxwwwm",
        "ps_auxZww": "sos_commands/selinux/ps_auxZww"
    }

    for variant, ps_relpath in ps_variants.items():
        ps_path = os.path.join(directory, ps_relpath)
        if not os.path.isfile(ps_path):
            continue

        proc_map = get_processes_per_full_cgroup_from_ps(
            directory,
            ps_path,
            os.path.join(directory, "proc")
        )


        merged_with_procs = replace_with_processes(merged_data, proc_map)

        for cgroup_path, cgroup_data in merged_with_procs.items():
            if isinstance(cgroup_data, dict) and '_processes' in cgroup_data:
                core_usage = cgroup_data.get('cpuacct.usage_percpu', [])
                for proc in cgroup_data['_processes']:
                    proc_cpu = proc.get('proc_cpu', 0.0)
                    proc['scaled_core_usage'] = scale_core_usage(core_usage, proc_cpu)

        total_core_usage = add_scaled_core_usage_and_accumulate(merged_with_procs)
        result[variant] = {
            "cgroup_version": cgroup_version,
            "cgroup_data": merged_with_procs,
            "total_core_usage": total_core_usage
        }

    return result
