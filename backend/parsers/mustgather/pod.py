import os
import yaml
import glob
import re
from datetime import datetime, timezone, timedelta

from parsers.findings import finding, no_data, recall, remember, sort_findings
from parsers.mustgather._common import resolve_data_dir, safe_load, safe_load_all, unreadable, unreadable_finding
from parsers.mustgather import detail

def parse(directory):
    result = {}

    # Get collection timestamp from must-gather
    original_directory = directory
    timestamp_file = os.path.join(original_directory, "timestamp")
    collection_time = None

    if os.path.exists(timestamp_file):
        try:
            with open(timestamp_file, 'r') as f:
                lines = f.readlines()
                if len(lines) >= 1:
                    first_line = lines[0].strip()
                    datetime_match = re.match(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.?\d* ([+-]\d{4})', first_line)
                    if datetime_match:
                        dt_str = datetime_match.group(1)
                        tz_str = datetime_match.group(2)

                        tz_sign = 1 if tz_str[0] == '+' else -1
                        tz_hours = int(tz_str[1:3])
                        tz_minutes = int(tz_str[3:5])
                        tz_offset = timedelta(hours=tz_sign * tz_hours, minutes=tz_sign * tz_minutes)

                        naive_dt = datetime.fromisoformat(dt_str.replace(' ', 'T'))
                        collection_time = naive_dt.replace(tzinfo=timezone.utc) - tz_offset
        except:
            pass

    if not collection_time:
        collection_time = datetime.now(timezone.utc)

    directory = resolve_data_dir(directory)

    namespaces_path = os.path.join(directory, "namespaces")
    if not os.path.exists(namespaces_path):
        return result

    namespaces = os.listdir(namespaces_path)

    for namespace in namespaces:
        ns_path = os.path.join(namespaces_path, namespace, "pods")
        pod_files = glob.glob(os.path.join(ns_path, "*", "*.yaml"))

        pods_json = {}

        for filepath in pod_files:
            pod_name = os.path.basename(filepath).replace(".yaml", "")
            try:
                with open(filepath, "r") as f:
                    yaml_content = safe_load(f)
                if not isinstance(yaml_content, dict):
                    raise ValueError(f"not a pod manifest: {filepath}")

                # Calculate age
                created = yaml_content.get("metadata", {}).get("creationTimestamp")
                if created:
                    try:
                        created_time = datetime.fromisoformat(created.replace('Z', '+00:00'))
                        age_diff = collection_time - created_time
                        yaml_content["_age_seconds"] = int(age_diff.total_seconds())
                    except:
                        yaml_content["_age_seconds"] = 0

                # the detail page's data (findings, containers, events, logs, field ownership)
                yaml_content['_detail'] = detail.pod_detail(yaml_content, detail.namespace_events(directory, namespace), directory, collection_time)
                pods_json[pod_name] = yaml_content
            except Exception as e:
                # the pod stays in the list with a readable reason (never the raw exception) instead of failing the namespace
                pods_json[pod_name] = {"error": unreadable(filepath, e, directory)['reason'], "file": unreadable(filepath, e, directory)['file']}

        result[namespace] = pods_json
    result['_nodes'] = per_node(result, directory)
    remember(('pod', directory), findings_for(result, collection_time))

    return result


def findings(directory):
    # the parser's list, or the one way to say the gather holds nothing of this (never a GOOD without data)
    return recall(('pod', resolve_data_dir(directory)), lambda: parse(directory)) or [no_data('No pods in this must-gather', ['namespaces/*/pods/*/*.yaml'], 'trimmed gather')]

def _pod_state(pod):
    """('phase or waiting reason', restarts, oom_killed_containers) of a pod from its status."""
    status = pod.get("status") or {}
    phase = status.get("phase") or "?"
    restarts = 0
    oom = []
    waiting = ""
    for c in (status.get("containerStatuses") or []) + (status.get("initContainerStatuses") or []):
        restarts += int(c.get("restartCount") or 0)
        w = (c.get("state") or {}).get("waiting") or {}
        if w.get("reason") and w.get("reason") not in ("ContainerCreating", "PodInitializing"):
            waiting = w["reason"]
        for st in ((c.get("state") or {}).get("terminated"), (c.get("lastState") or {}).get("terminated")):
            if st and st.get("reason") == "OOMKilled":
                oom.append(c.get("name") or "?")
    return (waiting or phase), restarts, sorted(set(oom))


def findings_for(result, collection_time):
    """The Findings strip: pods in CrashLoopBackOff / Error / ImagePullBackOff (bad), containers OOMKilled (bad), pods
    Pending for over ten minutes (warn), pods with five or more restarts (warn), Failed pods (warn), the counts."""
    out = []
    crash, oomed, pending, restarting, failed = [], [], [], [], []
    broken = []
    total = 0
    for ns, pods in result.items():
        if ns.startswith('_') or not isinstance(pods, dict):
            continue
        for name, pod in pods.items():
            if isinstance(pod, dict) and pod.get('error'):
                broken.append({'file': pod.get('file') or f'{ns}/{name}', 'reason': pod.get('error')})
            if not isinstance(pod, dict) or pod.get("error"):
                continue
            total += 1
            state, restarts, oom = _pod_state(pod)
            label = f"{ns}/{name}"
            if state in ("CrashLoopBackOff", "Error", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError", "RunContainerError", "InvalidImageName"):
                crash.append((label, state, name))
            if oom:
                oomed.append((label, oom, name))
            if state == "Pending" and (pod.get("_age_seconds") or 0) >= 600:
                pending.append((label, pod.get("_age_seconds") or 0, name))
            if state == "Failed":
                failed.append((label, name))
            if restarts >= 5:
                restarting.append((label, restarts, name))
    for label, state, name in crash[:10]:
        out.append(finding("bad", f"{label} is in {state}", "the container fails to start or exits at once: its previous logs say why", tab="log_collection", sub_tab="log_viewer", query=f"sources={label}", count=3))
    if len(crash) > 10:
        out.append(finding("bad", f"{len(crash) - 10} more pods failing to start", ", ".join(l for l, _, _ in crash[10:16]) + (" …" if len(crash) > 16 else ""), count=len(crash) - 10))
    for label, oom, name in oomed[:10]:
        out.append(finding("bad", f"{label}: container {', '.join(oom)} OOMKilled", "the container hit its memory limit and was killed; raise the limit or find the leak", tab="log_collection", sub_tab="log_viewer", query=f"sources={label}", count=2))
    for label, age, name in pending[:8]:
        out.append(finding("warn", f"{label} Pending for {age // 60} min", "unschedulable (no node fits, a volume missing) or waiting for its images: the events say which", tab="system", sub_tab="events", query=name, count=age // 60))
    for label, n, name in sorted(restarting, key=lambda x: -x[1])[:8]:
        out.append(finding("warn", f"{label} restarted {n} times", "a container that keeps dying: its logs and the OOM / crash reasons above", tab="log_collection", sub_tab="log_viewer", query=f"sources={label}", count=n))
    for label, name in failed[:5]:
        out.append(finding("warn", f"{label} Failed", "the pod ended with an error (an evicted pod, a job that failed)", query=name))
    for n in (result.get('_nodes') or {}).get('rows', []):
        if n.get('capacity') and n['count'] / n['capacity'] >= 0.8:
            share = 100.0 * n['count'] / n['capacity']
            out.append(finding('bad' if share >= 95 else 'warn', f"{n['name']} at {share:.0f}% of its pod limit ({n['count']} of {n['capacity']})", 'the kubelet refuses new pods at the limit (max-pods)', query=n['name'], count=int(share)))
    bf = unreadable_finding(broken, 'pod')
    if bf:
        out.append(bf)
    if not total:
        out.append(no_data("No pods in this must-gather", ['namespaces/*/pods/*/*.yaml'], 'trimmed gather'))
    elif not any(f["severity"] in ("bad", "warn") for f in out):
        out.append(finding("good", f"{total} pods, none crash-looping, OOM-killed, stuck Pending or restarting"))
    return sort_findings(out)

DOMAIN_SUFFIXES = ('.compute.internal', '.ec2.internal', '.internal', '.local')
PHASE_ROLE = {'Running': 'ok', 'Succeeded': 'other', 'Completed': 'other', 'Pending': 'warn', 'Failed': 'error', 'Unknown': 'error', 'CrashLoopBackOff': 'error'}


def short_node(name):
    """ip-192-0-2-9.us-east-2.compute.internal -> ip-192-0-2-9 (the common cloud suffixes and the region go)."""
    n = name
    for suf in DOMAIN_SUFFIXES:
        if n.endswith(suf):
            n = n[:-len(suf)]
    parts = n.split('.')
    return parts[0] if len(parts) > 1 and parts[0] else n


def per_node(result, directory):
    """The pods per node for the page's chart: one row per node, the pods by phase (Running / Pending / Failed /
    Succeeded, a crash-looping pod counted as Failed), sorted most pods first, the node's role and its pod capacity
    (status.allocatable.pods, else capacity.pods) from cluster-scoped-resources/core/nodes."""
    rows = {}
    for ns, pods in result.items():
        if ns.startswith('_') or not isinstance(pods, dict):
            continue
        for name, pod in pods.items():
            if not isinstance(pod, dict) or pod.get('error'):
                continue
            node = (pod.get('spec') or {}).get('nodeName') or '(unscheduled)'
            state, restarts, oom = _pod_state(pod)
            phase = (pod.get('status') or {}).get('phase') or 'Unknown'
            if state in ('CrashLoopBackOff', 'Error', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError'):
                phase = 'Failed'
            r = rows.setdefault(node, {'name': node, 'short': short_node(node), 'count': 0, 'phases': {}, 'role': '', 'capacity': None})
            r['count'] += 1
            r['phases'][phase] = r['phases'].get(phase, 0) + 1
    nodes_dir = os.path.join(directory, 'cluster-scoped-resources', 'core', 'nodes')
    if os.path.isdir(nodes_dir):
        for fn in os.listdir(nodes_dir):
            if not fn.endswith('.yaml'):
                continue
            try:
                with open(os.path.join(nodes_dir, fn), 'r') as f:
                    node = safe_load(f) or {}
            except Exception:  # noqa: BLE001
                continue
            name = (node.get('metadata') or {}).get('name')
            if not name:
                continue
            r = rows.setdefault(name, {'name': name, 'short': short_node(name), 'count': 0, 'phases': {}, 'role': '', 'capacity': None})
            labels = (node.get('metadata') or {}).get('labels') or {}
            roles = sorted(k.split('/', 1)[1] for k in labels if k.startswith('node-role.kubernetes.io/') and k.split('/', 1)[1])
            # one role tag: master wins over infra over worker, else the first custom role
            r['role'] = next((x for x in ('master', 'control-plane', 'infra', 'worker') if x in roles), roles[0] if roles else 'worker')
            status = node.get('status') or {}
            cap = (status.get('allocatable') or {}).get('pods') or (status.get('capacity') or {}).get('pods')
            try:
                r['capacity'] = int(str(cap)) if cap is not None else None
            except ValueError:
                r['capacity'] = None
    ordered = sorted(rows.values(), key=lambda r: (-r['count'], r['name']))
    phases = []
    for r in ordered:
        for p in r['phases']:
            if p not in phases:
                phases.append(p)
    order = ['Running', 'Pending', 'Failed', 'Unknown', 'Succeeded', 'Completed']
    phases.sort(key=lambda p: (order.index(p) if p in order else len(order), p))
    return {'rows': ordered, 'phases': [{'name': p, 'role': PHASE_ROLE.get(p, 'series')} for p in phases]}
