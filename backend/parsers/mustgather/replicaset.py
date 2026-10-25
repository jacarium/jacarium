import os
import yaml
import glob
import re
from datetime import datetime, timezone, timedelta

from parsers.findings import finding, recall, remember, sort_findings, no_data
from parsers.mustgather._common import resolve_data_dir, safe_load, safe_load_all, collection_time as gather_time_of, list_items, unreadable, unreadable_finding
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

    gather_time = collection_time
    directory = resolve_data_dir(directory)

    namespaces_path = os.path.join(directory, "namespaces")
    if not os.path.exists(namespaces_path):
        return result

    namespaces = os.listdir(namespaces_path)

    for namespace in namespaces:
        ns_path = os.path.join(namespaces_path, namespace, "apps")
        replicaset_files = glob.glob(os.path.join(ns_path, "replicasets.yaml"))

        replicaset_json = {}

        if replicaset_files:
            for filepath in replicaset_files:
                try:
                    with open(filepath, "r") as f:
                        yaml_content = safe_load(f)

                    # a List (items may be null or empty: an empty namespace), a single object, or an empty document
                    for item in list_items(yaml_content, 'ReplicaSet'):
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
                                replicaset_json[name] = item

                except Exception as e:   # a broken file: a readable reason (never the raw exception), kept out of the namespace
                    result.setdefault('_unreadable', []).append(unreadable(filepath, e, directory))

        # the detail page's data: conditions, the object's events, field ownership
        if replicaset_json:
            events = detail.namespace_events(directory, namespace)
            for name, d in replicaset_json.items():
                if isinstance(d, dict) and 'spec' in d:
                    d['_detail'] = detail.generic_detail(d, events, gather_time, 'the replicaset')
        result[namespace] = replicaset_json

    remember(('replicaset', directory), findings_for(result))
    return result


def findings(directory):
    # the parser's list, or the one way to say the gather holds nothing of this (never a GOOD without data)
    return recall(('replicaset', resolve_data_dir(directory)), lambda: parse(directory)) or [no_data('No replicasets in this must-gather', ['namespaces/*/apps/replicasets.yaml'], 'trimmed gather')]


def findings_for(result):
    """The Findings strip: replicasets whose pods are not all available (warn), the counts; the old ones a rollout
    left behind (0 wanted) are not a finding."""
    out = []
    total, active = 0, 0
    bf = unreadable_finding(result.get('_unreadable') or [], 'replicaset')
    if bf:
        out.append(bf)
    for ns, items in result.items():
        if ns.startswith('_') or not isinstance(items, dict):
            continue
        for name, d in items.items():
            if not isinstance(d, dict) or d.get("error") or d.get("kind") not in (None, "ReplicaSet"):
                continue
            total += 1
            spec, status = d.get("spec") or {}, d.get("status") or {}
            want = int(spec.get("replicas") if spec.get("replicas") is not None else 0)
            if not want:
                continue
            active += 1
            avail = int(status.get("availableReplicas") or 0)
            if avail < want:
                out.append(finding("bad" if avail == 0 else "warn", f"{ns}/{name}: {avail} of {want} pods available", "its deployment's rollout is stuck or its pods fail", tab="workloads", sub_tab="pod", query=name, count=want - avail))
    if not total:
        out.append(finding("info", "No replicasets in this must-gather"))
    elif not any(f["severity"] in ("bad", "warn") for f in out):
        out.append(finding("good", f"{active} active replicasets fully available ({total - active} retired by rollouts)"))
    return sort_findings(out)
