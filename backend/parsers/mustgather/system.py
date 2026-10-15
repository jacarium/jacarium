import os
import glob
import yaml

from parsers.mustgather._common import resolve_data_dir


def load_yaml(path):
    try:
        with open(path, 'r') as f:
            return yaml.safe_load(f)
    except Exception:
        return {}

def parse(directory):
    result = {}

    timestamp_file = os.path.join(directory, "timestamp")

    directory = resolve_data_dir(directory)

    def get_collection_timestamps():
        if not os.path.exists(timestamp_file):
            return None, None
        with open(timestamp_file, 'r') as f:
            lines = f.readlines()
            if len(lines) < 2:
                return None, None
            first_line = lines[0].strip()
            last_line = lines[-1].strip()
            return first_line, last_line

    def get_cluster_platform():
        path = os.path.join(directory, "cluster-scoped-resources", "config.openshift.io", "infrastructures", "cluster.yaml")
        data = load_yaml(path)
        platform = data.get("spec", {}).get("platformSpec", {}).get("type")
        return platform

    def get_cluster_version_data():
        path = os.path.join(directory, "cluster-scoped-resources", "config.openshift.io", "clusterversions", "version.yaml")
        data = load_yaml(path)
        overrides = data.get("spec", {}).get("overrides")
        channel = data.get("spec", {}).get("channel")
        version = data.get("status", {}).get("desired", {}).get("version")
        return {
            "overrides": overrides,
            "channel": channel,
            "version": version
        }

    def get_kubernetes_version():
        nodes_glob = os.path.join(directory, "cluster-scoped-resources", "core", "nodes", "*.yaml")
        for node_file in glob.glob(nodes_glob):
            data = load_yaml(node_file)
            if "status" in data:
                return data["status"]["nodeInfo"].get("kubeletVersion")
        return None

    def get_network_type():
        path = os.path.join(directory, "cluster-scoped-resources", "config.openshift.io", "networks.yaml")
        data = load_yaml(path)
        network_type = data.get("items", [{}])[0].get("spec", {}).get("networkType")
        return network_type

    def get_install_method():
        configmap_path = os.path.join(directory, "namespaces", "kube-system", "configmaps", "cluster-config-v1.yaml")
        metal3_pods = glob.glob(os.path.join(directory, "namespaces", "openshift-machine-api", "pods", "metal3*.yaml"))

        cm_data = load_yaml(configmap_path)
        has_vip = any("VIP" in str(val) for val in cm_data.get("data", {}).values())

        return "IPI" if has_vip or metal3_pods else "UPI"

    cluster_version = get_cluster_version_data()

    result["cluster_version"] = cluster_version
    result["kubernetes_version"] = get_kubernetes_version()
    result["network_type"] = get_network_type()
    result["install_method"] = get_install_method()
    result["platform"] = get_cluster_platform()

    first_timestamp, last_timestamp = get_collection_timestamps()
    result["collection_timestamps"] = {
        "first": first_timestamp,
        "last": last_timestamp
    }

    def get_full_operator_data():
        operators_path = os.path.join(directory, "cluster-scoped-resources", "config.openshift.io", "clusteroperators")
        operators = []
        for file in glob.glob(os.path.join(operators_path, "*.yaml")):
            data = load_yaml(file)
            if data:
                operators.append(data)
        return operators

    def get_proxy_config():
        path = os.path.join(directory, "cluster-scoped-resources", "config.openshift.io", "proxies", "cluster.yaml")
        data = load_yaml(path)
        if not data:
            return None

        spec = data.get("spec", {})
        status = data.get("status", {})

        return {
            "http_proxy": spec.get("httpProxy", ""),
            "https_proxy": spec.get("httpsProxy", ""),
            "no_proxy": status.get("noProxy", ""),
            "trusted_ca": spec.get("trustedCA", {}).get("name", ""),
            "configured": bool(spec.get("httpProxy") or spec.get("httpsProxy") or status.get("noProxy"))
        }

    result["cluster_operators"] = get_full_operator_data()
    result["proxy_config"] = get_proxy_config()

    return result