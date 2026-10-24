import os
import yaml
import glob

from parsers.findings import finding, no_data, recall, remember, sort_findings
from parsers.mustgather._common import resolve_data_dir, safe_load, safe_load_all

def parse(directory):
    result = {}

    directory = resolve_data_dir(directory)

    namespaces_path = os.path.join(directory, "namespaces")
    if not os.path.exists(namespaces_path):
        return result

    namespaces = os.listdir(namespaces_path)

    for namespace in namespaces:
        ns_path = os.path.join(namespaces_path, namespace, "policy")
        pdb_files = glob.glob(os.path.join(ns_path, "poddisruptionbudgets.yaml"))

        pdb_json = {}

        if pdb_files:
            for filepath in pdb_files:
                try:
                    with open(filepath, "r") as f:
                        yaml_content = safe_load(f)

                    if yaml_content.get("kind") == "PodDisruptionBudgetList" and "items" in yaml_content:
                        for item in yaml_content["items"]:
                            name = item.get("metadata", {}).get("name")
                            if name:
                                pdb_json[name] = item
                    else:
                        name = yaml_content.get("metadata", {}).get("name")
                        if name:
                            pdb_json[name] = yaml_content

                except Exception as e:
                    pdb_json["error"] = {"error": str(e)}

        result[namespace] = pdb_json

    remember(('pdb', directory), findings_for(result))
    return result


def findings(directory):
    # the parser's list, or the one way to say the gather holds nothing of this (never a GOOD without data)
    return recall(('pdb', resolve_data_dir(directory)), lambda: parse(directory)) or [no_data('No PodDisruptionBudgets in this must-gather', ['namespaces/*/policy/poddisruptionbudgets.yaml'], 'none defined, or a trimmed gather')]


def pdb_state(d):
    """('blocking' | 'unhealthy' | 'empty' | 'ok', why) of a PodDisruptionBudget from its status."""
    status = d.get("status") or {}
    allowed = status.get("disruptionsAllowed")
    healthy, desired = int(status.get("currentHealthy") or 0), int(status.get("desiredHealthy") or 0)
    expected = status.get("expectedPods")
    if expected is not None and int(expected or 0) == 0:
        return 'empty', 'selects no pod: it protects nothing'
    if desired and healthy < desired:
        return 'unhealthy', f"{healthy} of {desired} pods healthy: under the budget already"
    if allowed == 0:
        return 'blocking', f"allows 0 disruptions ({healthy} healthy, {desired} wanted): a node drain will hang on it"
    return 'ok', f"allows {allowed if allowed is not None else '?'} disruption{'s' if allowed != 1 else ''}"


def findings_for(result):
    """The Findings strip: budgets under their minimum (bad), budgets that allow no disruption (warn: a drain blocks on
    them), budgets that select no pod (info), GOOD only when there are budgets and none blocks; the counts."""
    out = []
    total = 0
    blocking = 0
    for ns, items in result.items():
        if ns.startswith('_') or not isinstance(items, dict):
            continue
        for name, d in items.items():
            if not isinstance(d, dict) or d.get("error") or d.get("kind") not in (None, "PodDisruptionBudget"):
                continue
            total += 1
            state, why = pdb_state(d)
            d['_state'] = state
            if state == 'unhealthy':
                out.append(finding("bad", f"{ns}/{name}: {why}", "the application is degraded; a drain cannot proceed either", tab="workloads", sub_tab="pod", query=name, count=2))
                blocking += 1
            elif state == 'blocking':
                out.append(finding("warn", f"{ns}/{name} {why}", "raise the replicas or lower minAvailable before an upgrade or a drain", count=1))
                blocking += 1
            elif state == 'empty':
                out.append(finding("info", f"{ns}/{name} {why}", "a stale selector or a scaled-to-zero workload"))
    if not total:
        out.append(no_data("No PodDisruptionBudgets in this must-gather", ['namespaces/*/policy/poddisruptionbudgets.yaml'], 'none defined, or a trimmed gather'))
    elif not blocking:
        out.append(finding("good", f"{total} budget{'s' if total != 1 else ''}, none blocks a disruption"))
    return sort_findings(out)
