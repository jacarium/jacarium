import os
import yaml
import glob

from parsers.mustgather._common import resolve_data_dir

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
                        yaml_content = yaml.safe_load(f)

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

    return result
