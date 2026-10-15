import os
import yaml
import glob
import re
from datetime import datetime, timezone, timedelta

from parsers.mustgather._common import resolve_data_dir

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
        deployment_files = glob.glob(os.path.join(ns_path, "deployments.yaml"))

        deployment_json = {}

        if deployment_files:
            for filepath in deployment_files:
                try:
                    with open(filepath, "r") as f:
                        yaml_content = yaml.safe_load(f)

                    if yaml_content.get("kind") == "DeploymentList" and "items" in yaml_content:
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
                                deployment_json[name] = item
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
                            deployment_json[name] = yaml_content

                except Exception as e:
                    deployment_json["error"] = {"error": str(e)}

        result[namespace] = deployment_json

    return result
