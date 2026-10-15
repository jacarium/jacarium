import os
import yaml

from parsers.mustgather._common import resolve_data_dir

def parse(directory):
    result = {}

    directory = resolve_data_dir(directory)

    namespaces_path = os.path.join(directory, "namespaces")
    if not os.path.exists(namespaces_path):
        return result

    namespaces = os.listdir(namespaces_path)

    for namespace in namespaces:
        events_path = os.path.join(namespaces_path, namespace, "core", "events.yaml")
        events_json = []

        if os.path.exists(events_path):
            try:
                with open(events_path, "r") as f:
                    events_content = yaml.safe_load(f)

                if events_content.get("kind") == "EventList" and "items" in events_content:
                    events_json = events_content["items"]
                else:
                    events_json = [events_content]

            except Exception as e:
                events_json = [{
                    "kind": "Error",
                    "message": f"Failed to parse events.yaml: {str(e)}",
                    "metadata": {"namespace": namespace},
                }]

        result[namespace] = events_json

    return result
