import os
import yaml
import glob

from parsers.mustgather._common import resolve_data_dir

def parse(directory):
    result = []

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
                docs = yaml.safe_load_all(f)

                for doc in docs:
                    if not doc:
                        continue

                    # Handle both single MCP and MachineConfigPoolList
                    if doc.get("kind") == "MachineConfigPoolList" and "items" in doc:
                        for item in doc["items"]:
                            if item.get("kind") == "MachineConfigPool":
                                result.append(parse_mcp(item))
                    elif doc.get("kind") == "MachineConfigPool":
                        result.append(parse_mcp(doc))

        except Exception as e:
            result.append({"error": str(e), "file": filepath})

    return result


def parse_mcp(mcp):
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
        "raw": mcp
    }
