import os
import yaml

from parsers.mustgather._common import resolve_data_dir

def parse(directory):
    result = {}

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
                node_content = yaml.safe_load(f)

            if node_content and "metadata" in node_content:
                node_name = node_content["metadata"].get("name", filename.replace(".yaml", ""))
                result[node_name] = node_content
            else:
                result[filename] = {"kind": "Error", "message": "Missing metadata", "filename": filename}

        except Exception as e:
            result[filename] = {
                "kind": "Error",
                "message": f"Failed to parse {filename}: {str(e)}",
            }

    return result
