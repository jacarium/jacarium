import os
from collections import defaultdict

def read_cgroup_file(path):
    try:
        with open(path, 'r') as f:
            return f.read().strip()
    except Exception:
        return None

def parse_cgroup_dir(base_dir, keys_of_interest):
    result = {}

    for entry in os.listdir(base_dir):
        full_path = os.path.join(base_dir, entry)

        if os.path.isdir(full_path):
            sub_dict = parse_cgroup_dir(full_path, keys_of_interest)
            if sub_dict:
                result[entry] = sub_dict
        elif entry in keys_of_interest:
            value = read_cgroup_file(full_path)
            if value is not None:
                try:
                    result[entry] = int(value)
                except ValueError:
                    result[entry] = value
    return result

def calculate_memory_usage_stats(cgroup_dict):
    def recurse(node):
        if isinstance(node, dict):
            mem_usage = node.get('memory.usage_in_bytes')
            mem_limit = node.get('memory.limit_in_bytes')
            if isinstance(mem_usage, int) and isinstance(mem_limit, int) and mem_limit > 0:
                node['memory.usage_percent'] = round((mem_usage / mem_limit) * 100, 2)
            for child in node.values():
                recurse(child)

    recurse(cgroup_dict)
    return cgroup_dict

def merge_dicts(d1, d2):
    result = {}
    keys = set(d1.keys()).union(d2.keys())
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
    base_path = os.path.join(directory, "sys/fs/cgroup/memory")
    pid_to_cgroup = {}

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
    return pid_to_cgroup

def get_processes_per_cgroup_from_ps(directory, ps_path, proc_root):
    parsed_result = parse_ps_file(ps_path)
    if "error" in parsed_result:
        return defaultdict(list)

    processes = parsed_result.get("processes", [])
    pid_to_cgroup = build_sysfs_cgroup_pid_index(directory)
    mapping = defaultdict(list)

    for proc in processes:
        pid = proc.get("PID", "-")
        if not pid.isdigit():
            continue

        cgroup_path = pid_to_cgroup.get(pid, "/")
        mapping[cgroup_path].append({
            'proc_pid': pid,
            'proc_cmd': proc.get("COMMAND", "-"),
            'proc_mem': float(proc.get("%MEM", 0.0)),
            'proc_rss': int(proc.get("RSS", 0) or 0),
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

def enrich_processes_with_cgroup(data, path=""):
    for key, value in data.items():
        full_path = f"{path}/{key}" if path else f"/{key}"
        if isinstance(value, dict):
            if '_processes' in value:
                for proc in value['_processes']:
                    proc['cgroup_name'] = full_path
            enrich_processes_with_cgroup(value, full_path)

def parse(directory):
    result = {}

    def read_lines(path):
        try:
            with open(path, 'r') as f:
                return f.readlines()
        except Exception:
            return []

    def parse_free(path):
        lines = read_lines(path)
        for line in lines:
            if line.startswith("Mem:"):
                fields = line.split()
                return {
                    "total": round(int(fields[1])),
                    "used": round(int(fields[2])),
                    "free": round(int(fields[3])),
                    "shared": round(int(fields[4])),
                    "buff_cache": round(int(fields[5])),
                    "available": round(int(fields[6]))
                }
        return {}

    memory_path = os.path.join(directory, "sys/fs/cgroup/memory")
    if not os.path.exists(memory_path):
        return result

    result['free_memory'] = parse_free(os.path.join(directory, 'sos_commands', 'memory', 'free_-m'))
    memory_data = parse_cgroup_dir(memory_path, {"memory.usage_in_bytes", "memory.limit_in_bytes"})
    memory_data = calculate_memory_usage_stats(memory_data)

    ps_variants = {
        "ps_auxwwwm": "sos_commands/process/ps_auxwwwm",
        "ps_auxZww": "sos_commands/selinux/ps_auxZww"
    }

    for variant, ps_relpath in ps_variants.items():
        ps_path = os.path.join(directory, ps_relpath)
        if not os.path.isfile(ps_path):
            continue

        proc_map = get_processes_per_cgroup_from_ps(directory, ps_path, os.path.join(directory, "proc"))
        enriched = replace_with_processes(memory_data, proc_map)
        enrich_processes_with_cgroup(enriched)

        result[variant] = {
            "cgroup_data": enriched,
        }

    return result
