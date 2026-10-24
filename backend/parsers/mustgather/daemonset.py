import os
import yaml
import glob
import re
from datetime import datetime, timezone, timedelta

from parsers.findings import finding, recall, remember, sort_findings, no_data
from parsers.mustgather._common import resolve_data_dir, safe_load, safe_load_all

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
        ns_path = os.path.join(namespaces_path, namespace, "apps")
        daemonset_files = glob.glob(os.path.join(ns_path, "daemonsets.yaml"))

        daemonset_json = {}

        if daemonset_files:
            for filepath in daemonset_files:
                try:
                    with open(filepath, "r") as f:
                        yaml_content = safe_load(f)

                    if yaml_content.get("kind") == "DaemonSetList" and "items" in yaml_content:
                        for item in yaml_content["items"]:
                            name = item.get("metadata", {}).get("name")
                            if name:
                                # Calculate age
                                created = item.get("metadata", {}).get("creationTimestamp")
                                if created:
                                    try:
                                        created_time = datetime.fromisoformat(created.replace('Z', '+00:00'))
                                        age_diff = collection_time - created_time
                                        item["_age_seconds"] = int(age_diff.total_seconds())
                                    except:
                                        item["_age_seconds"] = 0
                                daemonset_json[name] = item
                    else:
                        name = yaml_content.get("metadata", {}).get("name")
                        if name:
                            # Calculate age
                            created = yaml_content.get("metadata", {}).get("creationTimestamp")
                            if created:
                                try:
                                    created_time = datetime.fromisoformat(created.replace('Z', '+00:00'))
                                    age_diff = collection_time - created_time
                                    yaml_content["_age_seconds"] = int(age_diff.total_seconds())
                                except:
                                    yaml_content["_age_seconds"] = 0
                            daemonset_json[name] = yaml_content

                except Exception as e:
                    daemonset_json["error"] = {"error": str(e)}

        result[namespace] = daemonset_json

    remember(('daemonset', directory), findings_for(result))
    return result


def findings(directory):
    # the parser's list, or the one way to say the gather holds nothing of this (never a GOOD without data)
    return recall(('daemonset', resolve_data_dir(directory)), lambda: parse(directory)) or [no_data('No daemonsets in this must-gather', ['namespaces/*/apps/daemonsets.yaml'], 'trimmed gather')]


def findings_for(result):
    """The Findings strip: daemonsets with pods unavailable (warn; bad when none is available) or misscheduled, the counts."""
    out = []
    total = 0
    for ns, items in result.items():
        for name, d in items.items():
            if not isinstance(d, dict) or d.get("error") or d.get("kind") not in (None, "DaemonSet"):
                continue
            total += 1
            status = d.get("status") or {}
            want = int(status.get("desiredNumberScheduled") or 0)
            avail = int(status.get("numberAvailable") or 0)
            if want and avail == 0:
                out.append(finding("bad", f"{ns}/{name}: 0 of {want} pods available", "the daemonset runs nowhere", tab="workloads", sub_tab="pod", query=name, count=want))
            elif want and avail < want:
                out.append(finding("warn", f"{ns}/{name}: {avail} of {want} pods available", f"{int(status.get('numberUnavailable') or (want - avail))} unavailable: a node missing it, often a NotReady or cordoned one", tab="workloads", sub_tab="pod", query=name, count=want - avail))
            if int(status.get("numberMisscheduled") or 0):
                out.append(finding("warn", f"{ns}/{name}: {status['numberMisscheduled']} pods misscheduled", "running on nodes they should not be on"))
    if not total:
        out.append(finding("info", "No daemonsets in this must-gather"))
    elif not any(f["severity"] in ("bad", "warn") for f in out):
        out.append(finding("good", f"{total} daemonsets fully available"))
    return sort_findings(out)
