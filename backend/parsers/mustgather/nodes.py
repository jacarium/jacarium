import os
import yaml

from parsers.findings import finding, recall, remember, sort_findings, no_data
from parsers.mustgather._common import resolve_data_dir, safe_load, safe_load_all, collection_time, unreadable, unreadable_finding
from parsers.mustgather import detail

def parse(directory):
    result = {}

    gather_time = collection_time(directory)   # the gather's own time, for the ages and 'n min before the gather'
    directory = resolve_data_dir(directory)

    nodes_path = os.path.join(directory, "cluster-scoped-resources", "core", "nodes")
    if not os.path.exists(nodes_path):
        return result

    for filename in os.listdir(nodes_path):
        if not filename.endswith(".yaml"):
            continue

        file_path = os.path.join(nodes_path, filename)
        try:
            with open(file_path, "r") as f:
                node_content = safe_load(f)

            if isinstance(node_content, dict) and "metadata" in node_content:
                node_name = node_content["metadata"].get("name", filename.replace(".yaml", ""))
                # the detail page's data (findings, capacity meters, conditions, the pods on the node, field ownership)
                node_content['_detail'] = detail.node_detail(node_content, directory, gather_time)
                result[node_name] = node_content
            elif node_content is None:
                continue   # an empty file: nothing to list, not an unreadable file
            else:
                result[filename] = {"kind": "Error", "message": "not a Node document (no metadata)", "file": os.path.relpath(file_path, directory)}

        except Exception as e:   # a broken file: a readable reason, never the raw exception
            result[filename] = {"kind": "Error", "message": unreadable(file_path, e, directory)['reason'], "file": unreadable(file_path, e, directory)['file']}

    remember(('nodes', directory), findings_for(result))
    return result


def findings(directory):
    # the parser's list, or the one way to say the gather holds nothing of this (never a GOOD without data)
    return recall(('nodes', resolve_data_dir(directory)), lambda: parse(directory)) or [no_data('No nodes in this must-gather', ['cluster-scoped-resources/core/nodes'], 'trimmed gather')]

def _cond(node, kind):
    for c in (node.get("status") or {}).get("conditions") or []:
        if c.get("type") == kind:
            return c
    return {}


def findings_for(result):
    """The Findings strip: nodes NotReady or Unknown (bad), pressure conditions (warn), cordoned nodes (warn), a kubelet
    version skew across the nodes (info), the counts by role when nothing is wrong."""
    out = []
    bf = unreadable_finding([{'file': v.get('file') or n, 'reason': v.get('message') or ''} for n, v in result.items() if isinstance(v, dict) and v.get('kind') == 'Error'], 'node')
    if bf:
        out.append(bf)
    nodes = [(n, v) for n, v in result.items() if isinstance(v, dict) and v.get("kind") != "Error"]
    versions = {}
    for name, node in nodes:
        ready = _cond(node, "Ready")
        if ready.get("status") != "True":
            unknown = ready.get("status") != "False"   # Unknown: the kubelet stopped reporting (kubectl shows NotReady for both)
            out.append(finding("bad", f"Node {name} is NotReady", ("the kubelet stopped reporting; " if unknown else "") + (ready.get("message") or ready.get("reason") or "")[:200] + (f" (since {ready.get('lastTransitionTime')})" if ready.get("lastTransitionTime") else ""), tab="workloads", sub_tab="pod", query=name))
        for kind in ("MemoryPressure", "DiskPressure", "PIDPressure"):
            c = _cond(node, kind)
            if c.get("status") == "True":
                out.append(finding("warn", f"Node {name} has {kind}", (c.get("message") or c.get("reason") or "")[:200]))
        if (node.get("spec") or {}).get("unschedulable"):
            out.append(finding("warn", f"Node {name} is cordoned", "unschedulable: no new pod lands on it"))
        v = ((node.get("status") or {}).get("nodeInfo") or {}).get("kubeletVersion")
        if v:
            versions.setdefault(v, []).append(name)
    if len(versions) > 1:
        out.append(finding("info", f"{len(versions)} kubelet versions across the nodes", "; ".join(f"{v}: {len(ns)} node{'s' if len(ns) != 1 else ''}" for v, ns in sorted(versions.items())) + " (an upgrade in progress, or a node left behind)"))
    if not nodes:
        out.append(finding("info", "No nodes in this must-gather", "cluster-scoped-resources/core/nodes is missing"))
    elif not any(f["severity"] in ("bad", "warn") for f in out):
        roles = {}
        for name, node in nodes:
            labels = (node.get("metadata") or {}).get("labels") or {}
            role = next((k.split("/", 1)[1] for k in labels if k.startswith("node-role.kubernetes.io/")), "worker")
            roles[role] = roles.get(role, 0) + 1
        out.append(finding("good", f"{len(nodes)} nodes Ready, none under pressure", ", ".join(f"{n} {r}" for r, n in sorted(roles.items()))))
    return sort_findings(out)
