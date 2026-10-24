import os
from collections import defaultdict

from parsers.findings import finding, human_bytes, sort_findings

from ._common import parse_free, parse_ps_file, report_root  # noqa: F401 - shared with Processes and System

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

    directory = report_root(directory)
    memory_path = os.path.join(directory, "sys/fs/cgroup/memory")
    unified = os.path.join(directory, "sys/fs/cgroup")
    if os.path.isdir(memory_path):
        memory_data = parse_cgroup_dir(memory_path, {"memory.usage_in_bytes", "memory.limit_in_bytes"})
        cgroup_version = 1
    elif os.path.isfile(os.path.join(unified, 'cgroup.controllers')):
        # cgroup v2 (RHEL 9+, OCP nodes): one tree, memory.current / memory.max, mapped onto the v1 names the page reads
        memory_data = parse_cgroup2_memory(unified)
        cgroup_version = 2
    else:
        _FINDINGS[directory] = [finding('info', 'No memory cgroup tree in this report', 'sys/fs/cgroup/memory (v1) and sys/fs/cgroup/cgroup.controllers (v2) are both missing')]
        return result

    result['free_memory'] = parse_free(os.path.join(directory, 'sos_commands', 'memory', 'free_-m'))
    memory_data = calculate_memory_usage_stats(memory_data)
    # the page reads the result as {dataset: {...}, free_memory}: the strip is served by findings() (the loader asks)
    _FINDINGS[directory] = findings_for(memory_data, result['free_memory'])

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
            "cgroup_version": cgroup_version,
        }

    return result


_FINDINGS = {}


def findings(directory):
    """The Findings strip of the page (the loader calls it after parse(); on a cache hit parse() runs again)."""
    root = report_root(directory)
    if root not in _FINDINGS:
        parse(directory)
    return _FINDINGS.get(root, [])

def parse_cgroup2_memory(base_dir):
    """The unified hierarchy's memory accounting as the v1 shape: memory.current -> memory.usage_in_bytes,
    memory.max ('max' = no limit -> -1) -> memory.limit_in_bytes, nested like the directories."""
    def walk(d):
        node = {}
        cur = read_cgroup_file(os.path.join(d, 'memory.current'))
        mx = read_cgroup_file(os.path.join(d, 'memory.max'))
        if cur is not None and cur.isdigit():
            node['memory.usage_in_bytes'] = int(cur)
        if mx is not None:
            node['memory.limit_in_bytes'] = int(mx) if mx.isdigit() else -1
        try:
            children = sorted(e for e in os.listdir(d) if os.path.isdir(os.path.join(d, e)))
        except OSError:
            children = []
        for e in children:
            node[e] = walk(os.path.join(d, e))
        return node
    return walk(base_dir)


def findings_for(memory_data, free_memory):
    """The Findings strip: cgroups at 90% (warn) / 97% (bad) of their memory limit, the largest consumers under a
    limit, the host's own pressure from `free`."""
    out = []
    rows = []

    def recurse(node, path):
        for k, v in node.items():
            if isinstance(v, dict):
                recurse(v, f"{path}/{k}" if path else f"/{k}")
        usage, limit, pct = node.get('memory.usage_in_bytes'), node.get('memory.limit_in_bytes'), node.get('memory.usage_percent')
        if isinstance(usage, int) and isinstance(limit, int) and limit > 0 and pct is not None:
            rows.append((path or '/', usage, limit, pct))
    recurse(memory_data, '')
    rows.sort(key=lambda r: -r[3])
    near = [r for r in rows if r[3] >= 90]
    for path, usage, limit, pct in near[:8]:
        out.append(finding('bad' if pct >= 97 else 'warn', f"{path} at {pct:.1f}% of its memory limit", f"{human_bytes(usage)} of {human_bytes(limit)}: the next allocation over the limit is reclaimed or OOM-killed inside the cgroup", tab='kernel', sub_tab='kernel_oom_killer', count=int(pct)))
    if len(near) > 8:
        out.append(finding('warn', f"{len(near) - 8} more cgroups over 90% of their limit", ', '.join(r[0] for r in near[8:14]) + (' …' if len(near) > 14 else ''), count=len(near) - 8))
    limited = [r for r in rows if r[3] < 90]
    if limited:
        out.append(finding('info', f"{len(rows)} cgroups with a memory limit", "the largest: " + ', '.join(f"{p} ({human_bytes(u)}, {pct:g}%)" for p, u, l, pct in limited[:3])))
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', "No cgroup near its memory limit"))
    return sort_findings(out)
