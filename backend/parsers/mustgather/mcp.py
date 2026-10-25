import os
import yaml
import glob

from parsers.findings import finding, recall, remember, sort_findings, no_data
from parsers.mustgather._common import resolve_data_dir, safe_load, safe_load_all, collection_time as gather_time_of, list_items, unreadable, unreadable_finding
from parsers.mustgather import detail

def parse(directory):
    result = []

    gather_time = gather_time_of(directory)   # the gather's own time, for the ages and 'n min before the gather'
    directory = resolve_data_dir(directory)

    # Look for cluster-scoped-resources/machineconfiguration.openshift.io/machineconfigpools/*.yaml
    mcp_path = os.path.join(directory, "cluster-scoped-resources", "machineconfiguration.openshift.io", "machineconfigpools")

    if not os.path.exists(mcp_path):
        return result

    # Find all YAML files in the machineconfigpools directory
    yaml_files = glob.glob(os.path.join(mcp_path, "*.yaml"))

    for filepath in yaml_files:
        try:
            with open(filepath, "r") as f:
                # YAML files may contain multiple documents (separated by ---)
                docs = safe_load_all(f)

                for doc in docs:
                    # a List (items may be null or empty), a single object, or an empty document
                    for item in list_items(doc, 'MachineConfigPool'):
                        result.append(parse_mcp(item, gather_time))

        except Exception as e:   # a broken file: a readable reason, never the raw exception
            result.append(unreadable(filepath, e, directory))

    # degraded pools first, then the ones updating
    result.sort(key=lambda p: (0 if p.get('degraded') == 'True' else (1 if p.get('updating') == 'True' else 2), p.get('name', '')))
    remember(('mcp', directory), findings_for(result))
    return result


def findings(directory):
    # the parser's list, or the one way to say the gather holds nothing of this (never a GOOD without data)
    return recall(('mcp', resolve_data_dir(directory)), lambda: parse(directory)) or [no_data('No MachineConfigPools in this must-gather', ['cluster-scoped-resources/machineconfiguration.openshift.io/machineconfigpools'], 'trimmed gather')]


def parse_mcp(mcp, gather_time=None):
    """Parse a single MachineConfigPool object"""
    metadata = mcp.get("metadata", {})
    spec = mcp.get("spec", {})
    status = mcp.get("status", {})

    name = metadata.get("name", "")
    config_name = status.get("configuration", {}).get("name", "")
    paused = spec.get("paused", False)

    # Extract condition statuses
    conditions = status.get("conditions", [])
    condition_map = {}
    for cond in conditions:
        cond_type = cond.get("type", "")
        cond_status = cond.get("status", "Unknown")
        condition_map[cond_type] = cond_status

    updated_status = condition_map.get("Updated", "Unknown")
    updating_status = condition_map.get("Updating", "Unknown")
    degraded_status = condition_map.get("Degraded", "Unknown")

    # Extract machine counts
    machine_count = status.get("machineCount", 0)
    ready_machine_count = status.get("readyMachineCount", 0)
    updated_machine_count = status.get("updatedMachineCount", 0)
    degraded_machine_count = status.get("degradedMachineCount", 0)
    unavailable_machine_count = status.get("unavailableMachineCount", 0)

    return {
        "name": name,
        "config_name": config_name,
        "paused": paused,
        "updated": updated_status,
        "updating": updating_status,
        "degraded": degraded_status,
        "machine_count": machine_count,
        "ready_machine_count": ready_machine_count,
        "updated_machine_count": updated_machine_count,
        "degraded_machine_count": degraded_machine_count,
        "unavailable_machine_count": unavailable_machine_count,
        "conditions": conditions,
        "configuration_sources": status.get("configuration", {}).get("source", []),
        "raw": mcp,
        # the detail page's data: conditions and field ownership
        "detail": detail.generic_detail(mcp, [], gather_time, "the pool"),
    }

def findings_for(pools):
    """The Findings strip: degraded pools (bad, with the degraded machines and the NodeDegraded message), pools
    updating (info, with the progress), paused pools (warn), the pools' state when nothing is wrong."""
    out = []
    for p in pools:
        if p.get('error'):
            continue   # the unreadable files are one finding below
            continue
        name = p.get('name', '?')
        if p.get('degraded') == 'True':
            msg = next((c.get('message') for c in p.get('conditions', []) if c.get('type') in ('NodeDegraded', 'RenderDegraded') and c.get('status') == 'True' and c.get('message')), '')
            out.append(finding('bad', f"MachineConfigPool {name} is Degraded", f"{p.get('degraded_machine_count', 0)} of {p.get('machine_count', 0)} machines degraded" + (f": {msg[:200]}" if msg else ''), tab='compute', sub_tab='nodes', count=p.get('degraded_machine_count', 0)))
        elif p.get('updating') == 'True':
            out.append(finding('info', f"MachineConfigPool {name} is updating", f"{p.get('updated_machine_count', 0)} of {p.get('machine_count', 0)} machines updated, {p.get('unavailable_machine_count', 0)} unavailable"))
        if p.get('paused'):
            out.append(finding('warn', f"MachineConfigPool {name} is paused", 'no machine config rolls out to it while paused'))
    if not pools:
        out.append(finding('info', 'No MachineConfigPools in this must-gather'))
    elif not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"{len(pools)} pools updated and not degraded"))
    broken = unreadable_finding([p for p in pools if p.get('error')], 'MachineConfigPool')
    if broken:
        out.append(broken)
    return sort_findings(out)
