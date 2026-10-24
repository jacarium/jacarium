import os
import time
from collections import defaultdict

from parsers.findings import finding, sort_findings

from ._common import parse_ps_file, report_root  # noqa: F401 - the shared ps parser (one copy for Processes and the two cgroups tabs)

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

    directory = report_root(directory)
    cgroup_version = detect_cgroup_version(directory)
    unified = os.path.join(directory, "sys/fs/cgroup")
    if not os.path.exists(unified):
        _FINDINGS[directory] = [finding('info', 'No cgroup tree in this report', 'sys/fs/cgroup is missing')]
        return result

    cpu_path = os.path.join(directory, "sys/fs/cgroup/cpu,cpuacct")
    cpuset_path = os.path.join(directory, "sys/fs/cgroup/cpuset")
    throttled = {}
    if os.path.isdir(cpu_path):
        cpu_data = parse_cgroup_dir(cpu_path, {"cpu.cfs_quota_us", "cpu.cfs_period_us", "cpuacct.usage_percpu", "cpu.stat"})
        cpuset_data = parse_cgroup_dir(cpuset_path, {"cpuset.cpus"}) if os.path.isdir(cpuset_path) else {}
        merged_data = merge_dicts(cpu_data, cpuset_data)
        cgroup_version = 1
    elif os.path.isfile(os.path.join(unified, 'cgroup.controllers')):
        # cgroup v2: cpu.max "quota period" (or "max period"), cpu.stat's nr_throttled, cpuset.cpus.effective; no per-CPU usage
        merged_data = parse_cgroup2_cpu(unified)
        cgroup_version = 2
    else:
        _FINDINGS[directory] = [finding('info', 'No CPU cgroup tree in this report', 'sys/fs/cgroup/cpu,cpuacct (v1) and sys/fs/cgroup/cgroup.controllers (v2) are both missing')]
        return result
    # the page reads the result as {dataset: {...}}: the strip is served by findings() (the loader asks)
    _FINDINGS[directory] = findings_for(merged_data, cgroup_version)

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

_FINDINGS = {}


def findings(directory):
    """The Findings strip of the page (the loader calls it after parse(); on a cache hit parse() runs again)."""
    root = report_root(directory)
    if root not in _FINDINGS:
        parse(directory)
    return _FINDINGS.get(root, [])


def parse_cgroup2_cpu(base_dir):
    """The unified hierarchy's CPU accounting as the v1 shape the page reads: cpu.max -> cpu.cfs_quota_us /
    cpu.cfs_period_us (-1 when 'max'), cpuset.cpus.effective -> cpuset.cpus, cpu.stat kept as text (nr_throttled);
    cpuacct.usage_percpu has no v2 equivalent (an empty list)."""
    def walk(d):
        node = {}
        mx = read_cgroup_file(os.path.join(d, 'cpu.max'))
        if mx:
            parts = mx.split()
            node['cpu.cfs_quota_us'] = -1 if parts[0] == 'max' else (int(parts[0]) if parts[0].isdigit() else -1)
            node['cpu.cfs_period_us'] = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 100000
            node['cpuacct.usage_percpu'] = []
        cpus = read_cgroup_file(os.path.join(d, 'cpuset.cpus.effective'))
        if cpus:
            node['cpuset.cpus'] = cpus
        stat = read_cgroup_file(os.path.join(d, 'cpu.stat'))
        if stat:
            node['cpu.stat'] = stat
        try:
            children = sorted(e for e in os.listdir(d) if os.path.isdir(os.path.join(d, e)))
        except OSError:
            children = []
        for e in children:
            node[e] = walk(os.path.join(d, e))
        return node
    return walk(base_dir)


def _stat_int(text, key):
    for line in str(text or '').splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == key and parts[1].isdigit():
            return int(parts[1])
    return None


def findings_for(data, version):
    """The Findings strip: cgroups with a CPU quota that were throttled (cpu.stat nr_throttled, v1 and v2), the quotas
    in place, the hierarchy version."""
    out = []
    quotas, throttled = [], []

    def recurse(node, path):
        for k, v in node.items():
            if isinstance(v, dict):
                recurse(v, f"{path}/{k}" if path else f"/{k}")
        quota, period = node.get('cpu.cfs_quota_us'), node.get('cpu.cfs_period_us')
        if isinstance(quota, int) and quota > 0 and isinstance(period, int) and period > 0:
            cores = quota / period
            quotas.append((path or '/', cores))
            nt = _stat_int(node.get('cpu.stat'), 'nr_throttled')
            np = _stat_int(node.get('cpu.stat'), 'nr_periods')
            if nt:
                throttled.append((path or '/', cores, nt, np or 0))
    recurse(data, '')
    throttled.sort(key=lambda r: -(r[2] / r[3] if r[3] else r[2]))
    for path, cores, nt, np in throttled[:8]:
        share = (100.0 * nt / np) if np else 0
        out.append(finding('bad' if share >= 25 else 'warn', f"{path} was throttled in {nt:,} periods".replace(',', '\u202f') + (f" ({share:.0f}%)" if np else ''), f"its quota is {cores:g} CPU{'s' if cores != 1 else ''}: the processes inside wait for the next period whenever they use it up", count=int(share)))
    if quotas:
        out.append(finding('info', f"{len(quotas)} cgroup{'s' if len(quotas) != 1 else ''} with a CPU quota (cgroup v{version})", ', '.join(f"{p} ({c:g} CPU{'s' if c != 1 else ''})" for p, c in sorted(quotas, key=lambda q: -q[1])[:4]) + (' …' if len(quotas) > 4 else '')))
    else:
        out.append(finding('info', f"No CPU quota set on any cgroup (cgroup v{version})"))
    if not throttled and quotas:
        out.append(finding('good', "No cgroup was throttled by its CPU quota"))
    return sort_findings(out)
