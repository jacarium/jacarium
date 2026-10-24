"""Build a fully SYNTHETIC OpenShift must-gather directory (openshift/must-gather layout).

Cluster demo.example.test: 3 control-plane + 2 worker nodes (worker-1 NotReady),
cluster operators (monitoring Degraded), namespaces demo-app / payments-demo /
openshift-* with pods (one CrashLoopBackOff with previous logs, one OOMKilled),
events, firing alerts, MCPs, CSRs, TLS secrets and an etcd section. Every
name, ID, address and log line is invented. Layout:

    must-gather.local.<digits>/
        timestamp
        event-filter.html
        quay-io-openshift-release-dev-ocp-v4-0-art-dev-sha256-<hex>/
            timestamp, version
            cluster-scoped-resources/<group>/<kind>/<name>.yaml
            namespaces/<ns>/{core,apps,policy}/<kind>.yaml
            namespaces/<ns>/pods/<pod>/<pod>.yaml
            namespaces/<ns>/pods/<pod>/<container>/<container>/logs/{current,previous}.log
            monitoring/prometheus/rules.json
            etcd_info/*.json

YAML is written by a tiny emitter (standard library only); it stays valid for
PyYAML's safe_load, which is what backend/parsers/mustgather/* use.
"""
import json
import os
import random

import mock_audit_logs
import re
from datetime import datetime, timedelta, timezone

CLUSTER = "demo"
DOMAIN = "example.test"
CLUSTER_ID = "11111111-2222-4333-8444-555555555555"
OCP_VERSION = "4.16.12"
KUBELET = "v1.29.8+f10c92d"
OS_IMAGE = "Red Hat Enterprise Linux CoreOS 416.94.202609241500-0"
KERNEL = "5.14.0-427.37.1.el9_4.x86_64"
CRIO = "cri-o://1.29.8-5.rhaos4.16.gitd7a7bbf.el9"
IMAGE_DIR = "quay-io-openshift-release-dev-ocp-v4-0-art-dev-sha256-" + "ab12cd34ef56" * 5 + "ab12"
COLLECTED = datetime(2026, 10, 12, 14, 40, 12, tzinfo=timezone.utc)

NODES = [
    # name, role, cpu, mem_ki, ip, ready
    ("master-0", "control-plane", 8, 32 * 1024 * 1024, "10.0.0.11", True),
    ("master-1", "control-plane", 8, 32 * 1024 * 1024, "10.0.0.12", True),
    ("master-2", "control-plane", 8, 32 * 1024 * 1024, "10.0.0.13", True),
    ("worker-0", "worker", 16, 64 * 1024 * 1024, "10.0.0.21", True),
    ("worker-1", "worker", 16, 64 * 1024 * 1024, "10.0.0.22", False),  # planted: NotReady
]
NODE_FQDN = {n[0]: f"{n[0]}.{CLUSTER}.{DOMAIN}" for n in NODES}


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def ago(**kw):
    return iso(COLLECTED - timedelta(**kw))


# ---------------------------------------------------------------- YAML emitter

# kubectl quotes anything YAML would otherwise type (timestamps, numbers, booleans)
_TYPED_LOOKING = re.compile(r"^\d{4}-\d{2}-\d{2}")


def _scalar(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    s = str(v)
    bare_ok = (s and not s[0] in "-?:,[]{}#&*!|>'\"%@` " and not s[-1] == " " and ": " not in s and " #" not in s
               and "\n" not in s and s.lower() not in ("true", "false", "null", "yes", "no", "on", "off", "~")
               and not s.startswith("0") and not _looks_numeric(s) and not s.endswith(":") and not _TYPED_LOOKING.match(s))
    return s if bare_ok else json.dumps(s)


def _looks_numeric(s):
    try:
        float(s)
        return True
    except ValueError:
        return False


def to_yaml(obj, indent=0):
    pad = "  " * indent
    out = []
    if isinstance(obj, dict):
        if not obj:
            return pad + "{}"
        for k, v in obj.items():
            key = _scalar(k)
            if isinstance(v, dict) and v:
                out.append(f"{pad}{key}:")
                out.append(to_yaml(v, indent + 1))
            elif isinstance(v, list) and v:
                out.append(f"{pad}{key}:")
                out.append(to_yaml(v, indent))
            else:
                out.append(f"{pad}{key}: {_scalar(v) if not isinstance(v, (dict, list)) else ('{}' if isinstance(v, dict) else '[]')}")
        return "\n".join(out)
    if isinstance(obj, list):
        if not obj:
            return pad + "[]"
        for item in obj:
            if isinstance(item, dict) and item:
                body = to_yaml(item, indent + 1)
                first, _, rest = body.partition("\n")
                out.append(f"{pad}- {first.lstrip()}" + ("\n" + rest if rest else ""))
            elif isinstance(item, list):
                out.append(f"{pad}-")
                out.append(to_yaml(item, indent + 1))
            else:
                out.append(f"{pad}- {_scalar(item)}")
        return "\n".join(out)
    return pad + _scalar(obj)


class Tree:
    def __init__(self, base):
        self.base = base

    def write_bytes(self, rel, data):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)

    def write(self, rel, content):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)

    def yaml(self, rel, obj):
        self.write(rel, to_yaml(obj) + "\n")


def meta(name, namespace=None, labels=None, annotations=None, created=None, uid_seed=1, extra=None):
    m = {"name": name}
    if namespace:
        m["namespace"] = namespace
    m["uid"] = f"{uid_seed:08x}-aaaa-4bbb-8ccc-{uid_seed:012x}"
    m["resourceVersion"] = str(100000 + uid_seed)
    m["creationTimestamp"] = created or ago(days=30)
    if labels:
        m["labels"] = labels
    if annotations:
        m["annotations"] = annotations
    if extra:
        m.update(extra)
    return m


def cond(ctype, status, reason="", message="", when=None):
    c = {"type": ctype, "status": status, "lastTransitionTime": when or ago(days=7)}
    if reason:
        c["reason"] = reason
    if message:
        c["message"] = message
    return c


# ---------------------------------------------------------------- cluster-scoped

def write_cluster_scoped(t, rnd):
    csr_dir = "cluster-scoped-resources"
    t.yaml(f"{csr_dir}/config.openshift.io/clusterversions/version.yaml", {
        "apiVersion": "config.openshift.io/v1", "kind": "ClusterVersion",
        "metadata": meta("version", created=ago(days=200), uid_seed=11),
        "spec": {"channel": "stable-4.16", "clusterID": CLUSTER_ID,
                 "desiredUpdate": {"version": OCP_VERSION, "image": f"quay.io/openshift-release-dev/ocp-release@sha256:{'0f' * 32}"}},
        "status": {
            "availableUpdates": [{"version": "4.16.14", "image": f"quay.io/openshift-release-dev/ocp-release@sha256:{'1e' * 32}"}],
            "conditions": [
                cond("Available", "True", "", f"Done applying {OCP_VERSION}", ago(days=20)),
                cond("Failing", "False", "", "", ago(days=20)),
                cond("Progressing", "False", "", f"Cluster version is {OCP_VERSION}", ago(days=20)),
                cond("RetrievedUpdates", "True", "", "", ago(minutes=3)),
                cond("Upgradeable", "False", "ClusterOperatorDegraded", "Cluster operator monitoring is degraded", ago(hours=2)),
            ],
            "desired": {"version": OCP_VERSION, "image": f"quay.io/openshift-release-dev/ocp-release@sha256:{'0f' * 32}", "channels": ["candidate-4.16", "fast-4.16", "stable-4.16"]},
            "history": [
                {"state": "Completed", "startedTime": ago(days=21), "completionTime": ago(days=20), "version": OCP_VERSION, "image": f"quay.io/openshift-release-dev/ocp-release@sha256:{'0f' * 32}", "verified": True},
                {"state": "Completed", "startedTime": ago(days=200), "completionTime": ago(days=199, hours=23), "version": "4.16.8", "image": f"quay.io/openshift-release-dev/ocp-release@sha256:{'2d' * 32}", "verified": False},
            ],
            "observedGeneration": 2, "versionHash": "EXAMPLEhash0=",
        }})
    t.yaml(f"{csr_dir}/config.openshift.io/infrastructures/cluster.yaml", {
        "apiVersion": "config.openshift.io/v1", "kind": "Infrastructure", "metadata": meta("cluster", created=ago(days=200), uid_seed=12),
        "spec": {"cloudConfig": {"name": ""}, "platformSpec": {"type": "BareMetal"}},
        "status": {"apiServerInternalURI": f"https://api-int.{CLUSTER}.{DOMAIN}:6443", "apiServerURL": f"https://api.{CLUSTER}.{DOMAIN}:6443",
                   "controlPlaneTopology": "HighlyAvailable", "cpuPartitioning": "None", "etcdDiscoveryDomain": "",
                   "infrastructureName": f"{CLUSTER}-x7k2p", "infrastructureTopology": "HighlyAvailable", "platform": "BareMetal",
                   "platformStatus": {"baremetal": {"apiServerInternalIP": "10.0.0.5", "ingressIP": "10.0.0.7"}, "type": "BareMetal"}}})
    t.yaml(f"{csr_dir}/config.openshift.io/networks.yaml", {
        "apiVersion": "v1", "kind": "List", "metadata": {"resourceVersion": ""},
        "items": [{"apiVersion": "config.openshift.io/v1", "kind": "Network", "metadata": meta("cluster", created=ago(days=200), uid_seed=13),
                   "spec": {"clusterNetwork": [{"cidr": "10.128.0.0/14", "hostPrefix": 23}], "externalIP": {"policy": {}},
                            "networkType": "OVNKubernetes", "serviceNetwork": ["172.30.0.0/16"]},
                   "status": {"clusterNetwork": [{"cidr": "10.128.0.0/14", "hostPrefix": 23}], "clusterNetworkMTU": 1400,
                              "networkType": "OVNKubernetes", "serviceNetwork": ["172.30.0.0/16"]}}]})
    t.yaml(f"{csr_dir}/config.openshift.io/proxies/cluster.yaml", {
        "apiVersion": "config.openshift.io/v1", "kind": "Proxy", "metadata": meta("cluster", created=ago(days=200), uid_seed=14),
        "spec": {"httpProxy": "http://proxy.example.test:3128", "httpsProxy": "http://proxy.example.test:3128",
                 "noProxy": ".example.test,10.0.0.0/16", "trustedCA": {"name": "user-ca-bundle"}},
        "status": {"httpProxy": "http://proxy.example.test:3128", "httpsProxy": "http://proxy.example.test:3128",
                   "noProxy": f".cluster.local,.example.test,.svc,10.0.0.0/16,10.128.0.0/14,127.0.0.1,169.254.169.254,172.30.0.0/16,api-int.{CLUSTER}.{DOMAIN},localhost"}})
    t.yaml(f"{csr_dir}/config.openshift.io/dnses/cluster.yaml", {
        "apiVersion": "config.openshift.io/v1", "kind": "DNS", "metadata": meta("cluster", created=ago(days=200), uid_seed=15),
        "spec": {"baseDomain": f"{CLUSTER}.{DOMAIN}"}, "status": {}})

    # Cluster operators. monitoring is Degraded (planted); machine-config Progressing because worker-1 is stuck.
    operators = [
        ("authentication", True, False, False, "", ""), ("console", True, False, False, "", ""),
        ("dns", True, False, False, "", ""), ("etcd", True, False, False, "", ""), ("image-registry", True, False, False, "", ""),
        ("ingress", True, False, False, "", ""), ("kube-apiserver", True, False, False, "", ""),
        ("kube-controller-manager", True, False, False, "", ""), ("kube-scheduler", True, False, False, "", ""),
        ("machine-api", True, False, False, "", ""),
        ("machine-config", True, True, False, "", "Working towards 4.16.12: 1 of 2 worker nodes updated; worker-1 is unreachable"),
        ("monitoring", True, False, True, "UpdatingPrometheusK8sFailed",
         "Failed to rollout the stack. Error: updating prometheus-k8s: waiting for Prometheus object changes failed: waiting for Prometheus openshift-monitoring/k8s: expected 2 replicas, got 1 updated replicas (node-exporter on worker-1 is unreachable)"),
        ("network", True, False, False, "", ""), ("node-tuning", True, False, False, "", ""),
        ("openshift-apiserver", True, False, False, "", ""), ("openshift-controller-manager", True, False, False, "", ""),
        ("operator-lifecycle-manager", True, False, False, "", ""), ("service-ca", True, False, False, "", ""),
        ("storage", True, False, False, "", ""),
    ]
    for i, (name, avail, prog, degr, reason, msg) in enumerate(operators, start=20):
        when = ago(hours=2) if (degr or prog) else ago(days=20)
        t.yaml(f"{csr_dir}/config.openshift.io/clusteroperators/{name}.yaml", {
            "apiVersion": "config.openshift.io/v1", "kind": "ClusterOperator", "metadata": meta(name, created=ago(days=200), uid_seed=i),
            "spec": {},
            "status": {
                "conditions": [
                    cond("Degraded", "True" if degr else "False", reason if degr else "AsExpected", msg if degr else "", when),
                    cond("Progressing", "True" if prog else "False", "", msg if prog else "", when),
                    cond("Available", "True" if avail else "False", "AsExpected", "", ago(days=20)),
                    cond("Upgradeable", "False" if degr else "True", reason if degr else "", "", when),
                ],
                "extension": None, "relatedObjects": [{"group": "", "name": f"openshift-{name}", "resource": "namespaces"}],
                "versions": [{"name": "operator", "version": OCP_VERSION}],
            }})

    # Nodes
    for i, (name, role, cpu, mem_ki, ip, ready) in enumerate(NODES, start=40):
        labels = {"beta.kubernetes.io/arch": "amd64", "beta.kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64",
                  "kubernetes.io/hostname": name, "kubernetes.io/os": "linux", "node.openshift.io/os_id": "rhcos",
                  f"node-role.kubernetes.io/{role}": "", "node-role.kubernetes.io/master": ""} if role == "control-plane" else \
                 {"beta.kubernetes.io/arch": "amd64", "beta.kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64",
                  "kubernetes.io/hostname": name, "kubernetes.io/os": "linux", "node.openshift.io/os_id": "rhcos",
                  "node-role.kubernetes.io/worker": ""}
        when_ok = ago(days=20)
        when_bad = ago(hours=3, minutes=12)
        node = {
            "apiVersion": "v1", "kind": "Node",
            "metadata": meta(name, labels=labels, created=ago(days=200), uid_seed=i, annotations={
                "machineconfiguration.openshift.io/currentConfig": f"rendered-{'master' if role == 'control-plane' else 'worker'}-{'c0ffee' * 7}",
                "machineconfiguration.openshift.io/desiredConfig": f"rendered-{'master' if role == 'control-plane' else 'worker'}-{'c0ffee' * 7}",
                "machineconfiguration.openshift.io/state": "Done" if ready else "Working",
                "machineconfiguration.openshift.io/reason": "" if ready else "failed to drain node: context deadline exceeded",
                "volumes.kubernetes.io/controller-managed-attach-detach": "true"}),
            "spec": {"podCIDR": f"10.128.{i - 40}.0/23", "podCIDRs": [f"10.128.{i - 40}.0/23"]},
            "status": {
                "addresses": [{"address": ip, "type": "InternalIP"}, {"address": name, "type": "Hostname"}],
                "allocatable": {"cpu": str(cpu * 1000 - 500) + "m", "ephemeral-storage": "122000000Ki", "hugepages-1Gi": "0", "hugepages-2Mi": "0",
                                "memory": f"{mem_ki - 1536 * 1024}Ki", "pods": "250"},
                "capacity": {"cpu": str(cpu), "ephemeral-storage": "125293548Ki", "hugepages-1Gi": "0", "hugepages-2Mi": "0", "memory": f"{mem_ki}Ki", "pods": "250"},
                "conditions": [
                    cond("MemoryPressure", "False" if ready else "Unknown", "KubeletHasSufficientMemory" if ready else "NodeStatusUnknown",
                         "kubelet has sufficient memory available" if ready else "Kubelet stopped posting node status.", when_ok if ready else when_bad),
                    cond("DiskPressure", "False" if ready else "Unknown", "KubeletHasNoDiskPressure" if ready else "NodeStatusUnknown",
                         "kubelet has no disk pressure" if ready else "Kubelet stopped posting node status.", when_ok if ready else when_bad),
                    cond("PIDPressure", "False" if ready else "Unknown", "KubeletHasSufficientPID" if ready else "NodeStatusUnknown",
                         "kubelet has sufficient PID available" if ready else "Kubelet stopped posting node status.", when_ok if ready else when_bad),
                    cond("Ready", "True" if ready else "Unknown", "KubeletReady" if ready else "NodeStatusUnknown",
                         "kubelet is posting ready status" if ready else "Kubelet stopped posting node status.", when_ok if ready else when_bad),
                ],
                "daemonEndpoints": {"kubeletEndpoint": {"Port": 10250}},
                "images": [{"names": [f"quay.io/openshift-release-dev/ocp-v4.0-art-dev@sha256:{'3c' * 32}"], "sizeBytes": 512345678}],
                "nodeInfo": {"architecture": "amd64", "bootID": f"{i:08x}-b007-4000-8000-{i:012x}", "containerRuntimeVersion": CRIO,
                             "kernelVersion": KERNEL, "kubeProxyVersion": KUBELET, "kubeletVersion": KUBELET,
                             "machineID": f"{i:032x}", "operatingSystem": "linux", "osImage": OS_IMAGE, "systemUUID": f"{i:08x}-5e5e-4000-8000-{i:012x}"},
            }}
        if not ready:
            node["spec"]["taints"] = [{"effect": "NoSchedule", "key": "node.kubernetes.io/unreachable", "timeAdded": when_bad},
                                      {"effect": "NoExecute", "key": "node.kubernetes.io/unreachable", "timeAdded": when_bad}]
        t.yaml(f"{csr_dir}/core/nodes/{name}.yaml", node)

    # MachineConfigPools (worker Degraded: worker-1 stuck draining)
    for name, mc, deg, upd, count, ready_n, updated_n, degraded_n, unavail in (
            ("master", "master", False, True, 3, 3, 3, 0, 0), ("worker", "worker", True, False, 2, 1, 1, 1, 1)):
        rendered = f"rendered-{mc}-{'c0ffee' * 7}"
        t.yaml(f"{csr_dir}/machineconfiguration.openshift.io/machineconfigpools/{name}.yaml", {
            "apiVersion": "machineconfiguration.openshift.io/v1", "kind": "MachineConfigPool",
            "metadata": meta(name, labels={"machineconfiguration.openshift.io/mco-built-in": "", "pools.operator.machineconfiguration.openshift.io/" + name: ""},
                             created=ago(days=200), uid_seed=50 if name == "master" else 51),
            "spec": {"configuration": {"name": rendered, "source": [{"apiVersion": "machineconfiguration.openshift.io/v1", "kind": "MachineConfig", "name": f"00-{mc}"},
                                                                      {"apiVersion": "machineconfiguration.openshift.io/v1", "kind": "MachineConfig", "name": f"01-{mc}-container-runtime"},
                                                                      {"apiVersion": "machineconfiguration.openshift.io/v1", "kind": "MachineConfig", "name": f"01-{mc}-kubelet"},
                                                                      {"apiVersion": "machineconfiguration.openshift.io/v1", "kind": "MachineConfig", "name": f"99-{mc}-generated-registries"},
                                                                      {"apiVersion": "machineconfiguration.openshift.io/v1", "kind": "MachineConfig", "name": f"99-{mc}-ssh"}]},
                     "machineConfigSelector": {"matchLabels": {"machineconfiguration.openshift.io/role": mc}},
                     "nodeSelector": {"matchLabels": {f"node-role.kubernetes.io/{mc}": ""}}, "paused": False},
            "status": {"conditions": [
                cond("RenderDegraded", "False", "", "", ago(days=20)),
                cond("Updated", "True" if upd else "False", "", f"All nodes are updated with {rendered}" if upd else "", ago(days=20) if upd else ago(hours=3)),
                cond("Updating", "False" if upd else "True", "", "" if upd else f"All nodes are updating to {rendered}", ago(days=20) if upd else ago(hours=3)),
                cond("NodeDegraded", "True" if deg else "False", "1 nodes are reporting degraded status on sync" if deg else "",
                     "Node worker-1 is reporting: \"failed to drain node: context deadline exceeded: node is unreachable\"" if deg else "", ago(hours=2) if deg else ago(days=20)),
                cond("Degraded", "True" if deg else "False", "", "", ago(hours=2) if deg else ago(days=20)),
            ], "configuration": {"name": rendered, "source": [{"apiVersion": "machineconfiguration.openshift.io/v1", "kind": "MachineConfig", "name": f"00-{mc}"}]},
                "degradedMachineCount": degraded_n, "machineCount": count, "observedGeneration": 5, "readyMachineCount": ready_n,
                "unavailableMachineCount": unavail, "updatedMachineCount": updated_n}})

    # CSRs: approved kubelet-serving renewals, one Pending for worker-1 (kubelet down)
    csrs = [("csr-7k2m9", "worker-0", True, ago(days=3)), ("csr-9x1qp", "master-0", True, ago(days=5)),
            ("csr-2b8nr", "master-1", True, ago(days=5)), ("csr-5t4vz", "master-2", True, ago(days=5)),
            ("csr-f8q3w", "worker-1", False, ago(hours=1, minutes=50)), ("csr-h2n7c", "worker-1", False, ago(minutes=35))]
    for i, (name, node, approved, created) in enumerate(csrs, start=60):
        obj = {"apiVersion": "certificates.k8s.io/v1", "kind": "CertificateSigningRequest",
               "metadata": meta(name, created=created, uid_seed=i),
               "spec": {"expirationSeconds": 2592000, "groups": ["system:nodes", "system:authenticated"],
                        "request": "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURSBSRVFVRVNULS0tLS0KRVhBTVBMRS1TWU5USEVUSUMtQ1NSLUJPRFkKLS0tLS1FTkQgQ0VSVElGSUNBVEUgUkVRVUVTVC0tLS0tCg==",
                        "signerName": "kubernetes.io/kubelet-serving", "usages": ["digital signature", "server auth"],
                        "username": f"system:node:{node}"},
               "status": {}}
        if approved:
            obj["status"] = {"certificate": "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCkVYQU1QTEUtU1lOVEhFVElDLUNFUlQKLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=",
                             "conditions": [{"lastTransitionTime": created, "lastUpdateTime": created, "message": "This CSR was approved by the Node CSR Approver (cluster-machine-approver)",
                                             "reason": "NodeCSRApprove", "status": "True", "type": "Approved"}]}
        t.yaml(f"{csr_dir}/certificates.k8s.io/certificatesigningrequests/{name}.yaml", obj)


# ---------------------------------------------------------------- namespaces

def container_status(name, image, ready, restarts, state, last_state=None, started=None):
    cs = {"containerID": f"cri-o://{'ab' * 32}", "image": image, "imageID": f"{image.split('@')[0].split(':')[0]}@sha256:{'cd' * 32}",
          "lastState": last_state or {}, "name": name, "ready": ready, "restartCount": restarts, "started": ready, "state": state}
    return cs


def pod(ns, name, node, ip, containers, phase="Running", created=None, uid_seed=100, owner=None, conditions_ready=True, qos="Burstable",
        labels=None, started=None):
    created = created or ago(days=9)
    started = started or created
    spec_containers = []
    statuses = []
    for c in containers:
        spec_containers.append({"name": c["name"], "image": c["image"], "imagePullPolicy": "IfNotPresent",
                                "ports": [{"containerPort": c.get("port", 8080), "name": "http", "protocol": "TCP"}],
                                "resources": c.get("resources", {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"cpu": "500m", "memory": "512Mi"}}),
                                "terminationMessagePath": "/dev/termination-log", "terminationMessagePolicy": "File",
                                "volumeMounts": [{"mountPath": "/var/run/secrets/kubernetes.io/serviceaccount", "name": "kube-api-access-x1y2z", "readOnly": True}],
                                **({"livenessProbe": c["liveness"]} if "liveness" in c else {}),
                                **({"env": c["env"]} if "env" in c else {})})
        statuses.append(container_status(c["name"], c["image"], c.get("ready", True), c.get("restarts", 0),
                                         c.get("state", {"running": {"startedAt": started}}), c.get("last_state")))
    ready_state = "True" if conditions_ready else "False"
    obj = {"apiVersion": "v1", "kind": "Pod",
           "metadata": meta(name, ns, labels=labels or {"app": name.rsplit("-", 2)[0]}, created=created, uid_seed=uid_seed,
                            annotations={"k8s.ovn.org/pod-networks": json.dumps({"default": {"ip_addresses": [ip + "/23"], "mac_address": "0a:58:0a:80:01:0f"}}),
                                         "openshift.io/scc": "restricted-v2"},
                            extra={"ownerReferences": [owner]} if owner else None),
           "spec": {"containers": spec_containers, "dnsPolicy": "ClusterFirst", "enableServiceLinks": True, "nodeName": node,
                    "preemptionPolicy": "PreemptLowerPriority", "priority": 0, "restartPolicy": "Always", "schedulerName": "default-scheduler",
                    "securityContext": {"runAsNonRoot": True, "seccompProfile": {"type": "RuntimeDefault"}}, "serviceAccount": "default",
                    "serviceAccountName": "default", "terminationGracePeriodSeconds": 30,
                    "tolerations": [{"effect": "NoExecute", "key": "node.kubernetes.io/not-ready", "operator": "Exists", "tolerationSeconds": 300},
                                    {"effect": "NoExecute", "key": "node.kubernetes.io/unreachable", "operator": "Exists", "tolerationSeconds": 300}],
                    "volumes": [{"name": "kube-api-access-x1y2z", "projected": {"defaultMode": 420, "sources": [{"serviceAccountToken": {"expirationSeconds": 3607, "path": "token"}}]}}]},
           "status": {"conditions": [cond("PodReadyToStartContainers", "True", when=started), cond("Initialized", "True", when=started),
                                     cond("Ready", ready_state, "" if conditions_ready else "ContainersNotReady",
                                          "" if conditions_ready else f"containers with unready status: [{containers[0]['name']}]", started if conditions_ready else ago(hours=3)),
                                     cond("ContainersReady", ready_state, "" if conditions_ready else "ContainersNotReady", "", started if conditions_ready else ago(hours=3)),
                                     cond("PodScheduled", "True", when=created)],
                      "containerStatuses": statuses, "hostIP": {n[0]: n[4] for n in NODES}.get(node, "10.0.0.21"), "phase": phase, "podIP": ip,
                      "podIPs": [{"ip": ip}], "qosClass": qos, "startTime": started}}
    return obj


def container_log_lines(rnd, start, n, fmt_fn):
    out = []
    for i in range(n):
        dt = start + timedelta(seconds=i * 7 + rnd.randint(0, 6))
        out.append(f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}.{rnd.randint(0, 999999999):09d}+00:00 {fmt_fn(i, rnd)}")
    return "\n".join(out) + "\n"


def write_workload_namespaces(t, rnd):
    img = {"web": "quay.io/example-org/demo-web@sha256:" + "11" * 32, "cache": "quay.io/example-org/demo-cache@sha256:" + "22" * 32,
           "api": "quay.io/example-org/payments-api@sha256:" + "33" * 32, "worker": "quay.io/example-org/payments-worker@sha256:" + "44" * 32,
           "pg": "quay.io/example-org/postgres-demo@sha256:" + "55" * 32}

    def owner(kind, name, seed):
        return {"apiVersion": "apps/v1", "blockOwnerDeletion": True, "controller": True, "kind": kind, "name": name, "uid": f"{seed:08x}-aaaa-4bbb-8ccc-{seed:012x}"}

    # ---- demo-app: healthy web + cache, one pod stuck on the NotReady node
    ns = "demo-app"
    pods = [
        pod(ns, "demo-web-7d9f8b6c5-abcde", "worker-0", "10.128.6.15", [{"name": "web", "image": img["web"]}], owner=owner("ReplicaSet", "demo-web-7d9f8b6c5", 201), uid_seed=301),
        pod(ns, "demo-web-7d9f8b6c5-fghij", "master-2", "10.128.4.22", [{"name": "web", "image": img["web"]}], owner=owner("ReplicaSet", "demo-web-7d9f8b6c5", 201), uid_seed=302),
        # planted: on worker-1 (NotReady) -> Running but Not Ready
        pod(ns, "demo-web-7d9f8b6c5-klmno", "worker-1", "10.128.8.31", [{"name": "web", "image": img["web"], "ready": False}],
            owner=owner("ReplicaSet", "demo-web-7d9f8b6c5", 201), uid_seed=303, conditions_ready=False),
        pod(ns, "demo-cache-6c8d7f9b4-pqrst", "worker-0", "10.128.6.16", [{"name": "cache", "image": img["cache"], "port": 6379}],
            owner=owner("ReplicaSet", "demo-cache-6c8d7f9b4", 202), uid_seed=304, labels={"app": "demo-cache"}),
    ]
    for p in pods:
        name = p["metadata"]["name"]
        t.yaml(f"namespaces/{ns}/pods/{name}/{name}.yaml", p)
        cname = p["spec"]["containers"][0]["name"]
        if cname == "web":
            t.write(f"namespaces/{ns}/pods/{name}/web/web/logs/current.log", container_log_lines(
                rnd, COLLECTED - timedelta(hours=6), 120,
                lambda i, r: f"stdout F 10.128.{r.randint(0, 9)}.{r.randint(1, 254)} - - [{(COLLECTED - timedelta(hours=6, seconds=-i * 7)).strftime('%d/%b/%Y:%H:%M:%S')} +0000] \"GET /{r.choice(['', 'api/items', 'healthz', 'static/app.js'])} HTTP/1.1\" {r.choice([200, 200, 200, 304, 404])} {r.randint(120, 9000)}"))
        else:
            t.write(f"namespaces/{ns}/pods/{name}/cache/cache/logs/current.log", container_log_lines(
                rnd, COLLECTED - timedelta(hours=6), 40, lambda i, r: f"stdout F 1:M {i:02d} * DB saved on disk, {r.randint(100, 900)} keys"))
    t.yaml(f"namespaces/{ns}/core/events.yaml", {"apiVersion": "v1", "kind": "EventList", "metadata": {"resourceVersion": ""}, "items": [
        event(ns, "demo-web-7d9f8b6c5-klmno.17f2a1", "Warning", "NodeNotReady", "Node is not ready", "Pod", "demo-web-7d9f8b6c5-klmno", ago(hours=3, minutes=10), 1, "node-controller", 401),
        event(ns, "demo-web-7d9f8b6c5-klmno.17f2a2", "Normal", "TaintManagerEviction", "Marking for deletion Pod demo-app/demo-web-7d9f8b6c5-klmno", "Pod", "demo-web-7d9f8b6c5-klmno", ago(hours=3, minutes=5), 1, "taint-controller", 402),
        event(ns, "demo-web-7d9f8b6c5-abcde.17f2a3", "Normal", "Scheduled", "Successfully assigned demo-app/demo-web-7d9f8b6c5-abcde to worker-0", "Pod", "demo-web-7d9f8b6c5-abcde", ago(days=9), 1, "default-scheduler", 403),
        event(ns, "demo-web-7d9f8b6c5-abcde.17f2a4", "Normal", "Pulled", "Container image already present on machine", "Pod", "demo-web-7d9f8b6c5-abcde", ago(days=9), 1, "kubelet", 404),
        event(ns, "demo-web-7d9f8b6c5-abcde.17f2a5", "Normal", "Started", "Started container web", "Pod", "demo-web-7d9f8b6c5-abcde", ago(days=9), 1, "kubelet", 405),
        event(ns, "demo-web.17f2a6", "Normal", "ScalingReplicaSet", "Scaled up replica set demo-web-7d9f8b6c5 to 3", "Deployment", "demo-web", ago(days=9), 1, "deployment-controller", 406),
        event(ns, "demo-cache-6c8d7f9b4-pqrst.17f2a7", "Warning", "Unhealthy", "Readiness probe failed: dial tcp 10.128.6.16:6379: i/o timeout", "Pod", "demo-cache-6c8d7f9b4-pqrst", ago(hours=5), 3, "kubelet", 407),
    ]})
    t.yaml(f"namespaces/{ns}/apps/deployments.yaml", {"apiVersion": "apps/v1", "kind": "DeploymentList", "metadata": {"resourceVersion": ""}, "items": [
        deployment(ns, "demo-web", 3, 2, 3, img["web"], "web", 201), deployment(ns, "demo-cache", 1, 1, 1, img["cache"], "cache", 202)]})
    t.yaml(f"namespaces/{ns}/apps/replicasets.yaml", {"apiVersion": "apps/v1", "kind": "ReplicaSetList", "metadata": {"resourceVersion": ""}, "items": [
        replicaset(ns, "demo-web-7d9f8b6c5", "demo-web", 3, 2, 201), replicaset(ns, "demo-cache-6c8d7f9b4", "demo-cache", 1, 1, 202)]})
    t.yaml(f"namespaces/{ns}/policy/poddisruptionbudgets.yaml", {"apiVersion": "policy/v1", "kind": "PodDisruptionBudgetList", "metadata": {"resourceVersion": ""}, "items": [
        pdb(ns, "demo-web-pdb", "demo-web", 1, 2, 3, 1, 203)]})
    t.yaml(f"namespaces/{ns}/core/services.yaml", {"apiVersion": "v1", "kind": "ServiceList", "metadata": {"resourceVersion": ""}, "items": [
        {"apiVersion": "v1", "kind": "Service", "metadata": meta("demo-web", ns, uid_seed=204), "spec": {"clusterIP": "172.30.41.7", "ports": [{"port": 80, "targetPort": 8080, "protocol": "TCP"}], "selector": {"app": "demo-web"}, "type": "ClusterIP"}, "status": {"loadBalancer": {}}}]})
    t.write(f"namespaces/{ns}/{ns}.yaml", to_yaml({"apiVersion": "v1", "kind": "Namespace", "metadata": meta(ns, labels={"kubernetes.io/metadata.name": ns}, uid_seed=200), "spec": {"finalizers": ["kubernetes"]}, "status": {"phase": "Active"}}) + "\n")

    # ---- payments-demo: OOMKilled api, CrashLoopBackOff worker, statefulset postgres
    ns = "payments-demo"
    oom_pod = pod(ns, "payments-api-5f6d7c8b9-zabcd", "worker-0", "10.128.6.40",
                  [{"name": "api", "image": img["api"], "restarts": 7,
                    "resources": {"requests": {"cpu": "250m", "memory": "256Mi"}, "limits": {"cpu": "1", "memory": "256Mi"}},
                    "last_state": {"terminated": {"containerID": f"cri-o://{'ef' * 32}", "exitCode": 137, "finishedAt": ago(minutes=42), "reason": "OOMKilled", "startedAt": ago(hours=1, minutes=30)}},
                    "state": {"running": {"startedAt": ago(minutes=41)}}}],
                  owner=owner("ReplicaSet", "payments-api-5f6d7c8b9", 211), uid_seed=311, started=ago(minutes=41), created=ago(days=2))
    crash_pod = pod(ns, "payments-worker-7b8c9d0e1-efghi", "master-1", "10.128.2.77",
                    [{"name": "worker", "image": img["worker"], "ready": False, "restarts": 42,
                      "env": [{"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"key": "url", "name": "postgres-demo-credentials"}}}],
                      "last_state": {"terminated": {"containerID": f"cri-o://{'12' * 32}", "exitCode": 1, "finishedAt": ago(minutes=4), "reason": "Error", "startedAt": ago(minutes=4, seconds=3)}},
                      "state": {"waiting": {"message": "back-off 5m0s restarting failed container=worker pod=payments-worker-7b8c9d0e1-efghi_payments-demo(0000013b-aaaa-4bbb-8ccc-00000000013b)", "reason": "CrashLoopBackOff"}}}],
                    owner=owner("ReplicaSet", "payments-worker-7b8c9d0e1", 212), uid_seed=315, conditions_ready=False, created=ago(hours=4))
    pods = [
        pod(ns, "payments-api-5f6d7c8b9-uvwxy", "master-0", "10.128.0.55", [{"name": "api", "image": img["api"], "restarts": 1,
            "resources": {"requests": {"cpu": "250m", "memory": "256Mi"}, "limits": {"cpu": "1", "memory": "256Mi"}}}],
            owner=owner("ReplicaSet", "payments-api-5f6d7c8b9", 211), uid_seed=310, created=ago(days=2)),
        oom_pod, crash_pod,
        pod(ns, "postgres-demo-0", "worker-0", "10.128.6.41", [{"name": "postgres", "image": img["pg"], "port": 5432}],
            owner={"apiVersion": "apps/v1", "blockOwnerDeletion": True, "controller": True, "kind": "StatefulSet", "name": "postgres-demo", "uid": "000000d5-aaaa-4bbb-8ccc-0000000000d5"},
            uid_seed=316, labels={"app": "postgres-demo", "statefulset.kubernetes.io/pod-name": "postgres-demo-0"}, created=ago(days=30)),
    ]
    for p in pods:
        name = p["metadata"]["name"]
        t.yaml(f"namespaces/{ns}/pods/{name}/{name}.yaml", p)
    api_fmt = lambda i, r: (f"stderr F {{\"level\":\"warn\",\"msg\":\"heap near limit\",\"heap_mb\":{200 + i * 2},\"limit_mb\":256}}" if i % 9 == 8
                            else f"stdout F {{\"level\":\"info\",\"msg\":\"POST /v1/charge\",\"status\":{r.choice([200, 200, 201, 402])},\"ms\":{r.randint(20, 900)},\"request_id\":\"req-{r.randint(100000, 999999)}\"}}")
    t.write(f"namespaces/{ns}/pods/payments-api-5f6d7c8b9-uvwxy/api/api/logs/current.log", container_log_lines(rnd, COLLECTED - timedelta(hours=5), 150, api_fmt))
    t.write(f"namespaces/{ns}/pods/payments-api-5f6d7c8b9-zabcd/api/api/logs/current.log", container_log_lines(rnd, COLLECTED - timedelta(minutes=41), 60, api_fmt))
    prev = container_log_lines(rnd, COLLECTED - timedelta(hours=1, minutes=30), 100, api_fmt)
    prev += f"{(COLLECTED - timedelta(minutes=42)).strftime('%Y-%m-%dT%H:%M:%S')}.000000000+00:00 stderr F {{\"level\":\"error\",\"msg\":\"runtime: out of memory: cannot allocate 67108864-byte block (268435456 in use)\"}}\n"
    prev += f"{(COLLECTED - timedelta(minutes=42)).strftime('%Y-%m-%dT%H:%M:%S')}.100000000+00:00 stderr F fatal error: out of memory\n"
    t.write(f"namespaces/{ns}/pods/payments-api-5f6d7c8b9-zabcd/api/api/logs/previous.log", prev)
    worker_start = COLLECTED - timedelta(minutes=4, seconds=3)
    crash_log = "\n".join([
        f"{worker_start.strftime('%Y-%m-%dT%H:%M:%S')}.012345678+00:00 stdout F INFO payments-worker 2.3.1 starting (queue=payments, concurrency=4)",
        f"{worker_start.strftime('%Y-%m-%dT%H:%M:%S')}.512345678+00:00 stdout F INFO connecting to postgres-demo.payments-demo.svc:5432",
        f"{(worker_start + timedelta(seconds=2)).strftime('%Y-%m-%dT%H:%M:%S')}.612345678+00:00 stderr F Traceback (most recent call last):",
        f"{(worker_start + timedelta(seconds=2)).strftime('%Y-%m-%dT%H:%M:%S')}.612345679+00:00 stderr F   File \"/app/worker.py\", line 88, in <module>",
        f"{(worker_start + timedelta(seconds=2)).strftime('%Y-%m-%dT%H:%M:%S')}.612345680+00:00 stderr F     main()",
        f"{(worker_start + timedelta(seconds=2)).strftime('%Y-%m-%dT%H:%M:%S')}.612345681+00:00 stderr F   File \"/app/worker.py\", line 41, in main",
        f"{(worker_start + timedelta(seconds=2)).strftime('%Y-%m-%dT%H:%M:%S')}.612345682+00:00 stderr F     conn = db.connect(os.environ[\"DATABASE_URL\"])",
        f"{(worker_start + timedelta(seconds=2)).strftime('%Y-%m-%dT%H:%M:%S')}.612345683+00:00 stderr F   File \"/app/db.py\", line 17, in connect",
        f"{(worker_start + timedelta(seconds=2)).strftime('%Y-%m-%dT%H:%M:%S')}.612345684+00:00 stderr F     raise ConfigError(\"DATABASE_URL is empty: secret postgres-demo-credentials has no key 'url'\")",
        f"{(worker_start + timedelta(seconds=2)).strftime('%Y-%m-%dT%H:%M:%S')}.612345685+00:00 stderr F app.errors.ConfigError: DATABASE_URL is empty: secret postgres-demo-credentials has no key 'url'",
    ]) + "\n"
    t.write(f"namespaces/{ns}/pods/payments-worker-7b8c9d0e1-efghi/worker/worker/logs/current.log", "")
    t.write(f"namespaces/{ns}/pods/payments-worker-7b8c9d0e1-efghi/worker/worker/logs/previous.log", crash_log)
    t.write(f"namespaces/{ns}/pods/payments-worker-7b8c9d0e1-efghi/worker/worker/logs/previous.insecure.log", crash_log)
    t.write(f"namespaces/{ns}/pods/postgres-demo-0/postgres/postgres/logs/current.log", container_log_lines(
        rnd, COLLECTED - timedelta(hours=6), 30, lambda i, r: f"stderr F {(COLLECTED - timedelta(hours=6, seconds=-i * 7)).strftime('%Y-%m-%d %H:%M:%S')}.{r.randint(100, 999)} UTC [{r.randint(100, 999)}] LOG:  checkpoint complete: wrote {r.randint(10, 900)} buffers"))
    t.yaml(f"namespaces/{ns}/core/events.yaml", {"apiVersion": "v1", "kind": "EventList", "metadata": {"resourceVersion": ""}, "items": [
        event(ns, "payments-worker-7b8c9d0e1-efghi.17f3b1", "Warning", "BackOff", "Back-off restarting failed container worker in pod payments-worker-7b8c9d0e1-efghi_payments-demo(0000013b-aaaa-4bbb-8ccc-00000000013b)", "Pod", "payments-worker-7b8c9d0e1-efghi", ago(minutes=2), 42, "kubelet", 411),
        event(ns, "payments-worker-7b8c9d0e1-efghi.17f3b2", "Normal", "Pulled", "Container image \"quay.io/example-org/payments-worker@sha256:" + "44" * 32 + "\" already present on machine", "Pod", "payments-worker-7b8c9d0e1-efghi", ago(minutes=4), 43, "kubelet", 412),
        event(ns, "payments-api-5f6d7c8b9-zabcd.17f3b3", "Warning", "Unhealthy", "Liveness probe failed: HTTP probe failed with statuscode: 503", "Pod", "payments-api-5f6d7c8b9-zabcd", ago(minutes=43), 5, "kubelet", 413),
        event(ns, "payments-api-5f6d7c8b9-zabcd.17f3b4", "Normal", "Killing", "Container api failed liveness probe, will be restarted", "Pod", "payments-api-5f6d7c8b9-zabcd", ago(minutes=43), 2, "kubelet", 414),
        event(ns, "payments-api-5f6d7c8b9-zabcd.17f3b5", "Normal", "Started", "Started container api", "Pod", "payments-api-5f6d7c8b9-zabcd", ago(minutes=41), 8, "kubelet", 415),
        event(ns, "payments-api.17f3b6", "Normal", "ScalingReplicaSet", "Scaled up replica set payments-api-5f6d7c8b9 to 2", "Deployment", "payments-api", ago(days=2), 1, "deployment-controller", 416),
        event(ns, "payments-worker.17f3b7", "Normal", "ScalingReplicaSet", "Scaled up replica set payments-worker-7b8c9d0e1 to 1", "Deployment", "payments-worker", ago(hours=4), 1, "deployment-controller", 417),
        event(ns, "postgres-demo.17f3b8", "Normal", "SuccessfulCreate", "create Pod postgres-demo-0 in StatefulSet postgres-demo successful", "StatefulSet", "postgres-demo", ago(days=30), 1, "statefulset-controller", 418),
    ]})
    t.yaml(f"namespaces/{ns}/apps/deployments.yaml", {"apiVersion": "apps/v1", "kind": "DeploymentList", "metadata": {"resourceVersion": ""}, "items": [
        deployment(ns, "payments-api", 2, 2, 2, img["api"], "api", 211), deployment(ns, "payments-worker", 1, 0, 1, img["worker"], "worker", 212)]})
    t.yaml(f"namespaces/{ns}/apps/replicasets.yaml", {"apiVersion": "apps/v1", "kind": "ReplicaSetList", "metadata": {"resourceVersion": ""}, "items": [
        replicaset(ns, "payments-api-5f6d7c8b9", "payments-api", 2, 2, 211), replicaset(ns, "payments-worker-7b8c9d0e1", "payments-worker", 1, 0, 212)]})
    t.yaml(f"namespaces/{ns}/apps/statefulsets.yaml", {"apiVersion": "apps/v1", "kind": "StatefulSetList", "metadata": {"resourceVersion": ""}, "items": [
        {"apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": meta("postgres-demo", ns, labels={"app": "postgres-demo"}, created=ago(days=30), uid_seed=213),
         "spec": {"podManagementPolicy": "OrderedReady", "replicas": 1, "revisionHistoryLimit": 10, "selector": {"matchLabels": {"app": "postgres-demo"}},
                  "serviceName": "postgres-demo", "template": {"metadata": {"labels": {"app": "postgres-demo"}}, "spec": {"containers": [{"name": "postgres", "image": img["pg"], "ports": [{"containerPort": 5432, "name": "pg"}]}]}},
                  "updateStrategy": {"rollingUpdate": {"partition": 0}, "type": "RollingUpdate"},
                  "volumeClaimTemplates": [{"metadata": {"name": "data"}, "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": "20Gi"}}, "storageClassName": "example-block"}}]},
         "status": {"availableReplicas": 1, "collisionCount": 0, "currentReplicas": 1, "currentRevision": "postgres-demo-6f5d4c3b2", "observedGeneration": 1,
                    "readyReplicas": 1, "replicas": 1, "updateRevision": "postgres-demo-6f5d4c3b2", "updatedReplicas": 1}}]})
    t.yaml(f"namespaces/{ns}/policy/poddisruptionbudgets.yaml", {"apiVersion": "policy/v1", "kind": "PodDisruptionBudgetList", "metadata": {"resourceVersion": ""}, "items": [
        pdb(ns, "payments-api-pdb", "payments-api", 2, 2, 2, 0, 214),  # planted: disruptionsAllowed 0 (minAvailable == replicas)
        pdb(ns, "postgres-demo-pdb", "postgres-demo", 1, 1, 1, 0, 215)]})
    t.yaml(f"namespaces/{ns}/core/secrets.yaml", {"apiVersion": "v1", "kind": "SecretList", "metadata": {"resourceVersion": ""}, "items": [
        {"apiVersion": "v1", "kind": "Secret", "metadata": meta("postgres-demo-credentials", ns, uid_seed=216), "type": "Opaque",
         "data": {"username": "ZGVtbw==", "password": "UkVEQUNURUQ="}},  # no 'url' key: the planted cause of the CrashLoopBackOff
        {"apiVersion": "v1", "kind": "Secret", "metadata": meta("payments-api-tls", ns, uid_seed=217, annotations={
            "auth.openshift.io/certificate-not-after": iso(COLLECTED + timedelta(days=24)), "auth.openshift.io/certificate-not-before": iso(COLLECTED - timedelta(days=341)),
            "auth.openshift.io/certificate-issuer": "openshift-service-serving-signer@1700000000"}),
         "type": "kubernetes.io/tls", "data": {"tls.crt": "UkVEQUNURUQ=", "tls.key": "UkVEQUNURUQ="}},
    ]})
    t.write(f"namespaces/{ns}/{ns}.yaml", to_yaml({"apiVersion": "v1", "kind": "Namespace", "metadata": meta(ns, labels={"kubernetes.io/metadata.name": ns}, uid_seed=210), "spec": {"finalizers": ["kubernetes"]}, "status": {"phase": "Active"}}) + "\n")


def event(ns, name, etype, reason, message, kind, obj_name, when, count, component, seed):
    return {"apiVersion": "v1", "kind": "Event", "metadata": meta(name, ns, created=when, uid_seed=seed),
            "count": count, "eventTime": None, "firstTimestamp": when, "lastTimestamp": when,
            "involvedObject": {"apiVersion": "v1" if kind == "Pod" else "apps/v1", "kind": kind, "name": obj_name, "namespace": ns, "uid": f"{seed:08x}-0b1e-4000-8000-{seed:012x}"},
            "message": message, "reason": reason, "reportingComponent": component, "reportingInstance": "", "source": {"component": component}, "type": etype}


def deployment(ns, name, replicas, available, updated, image, cname, seed):
    unavailable = replicas - available
    return {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": meta(name, ns, labels={"app": name}, created=ago(days=9), uid_seed=seed,
                                                                           annotations={"deployment.kubernetes.io/revision": "3"}),
            "spec": {"progressDeadlineSeconds": 600, "replicas": replicas, "revisionHistoryLimit": 10, "selector": {"matchLabels": {"app": name}},
                     "strategy": {"rollingUpdate": {"maxSurge": "25%", "maxUnavailable": "25%"}, "type": "RollingUpdate"},
                     "template": {"metadata": {"labels": {"app": name}}, "spec": {"containers": [{"name": cname, "image": image, "ports": [{"containerPort": 8080}]}]}}},
            "status": {"availableReplicas": available, "conditions": [
                cond("Available", "True" if available > 0 else "False", "MinimumReplicasAvailable" if available > 0 else "MinimumReplicasUnavailable",
                     "Deployment has minimum availability." if available > 0 else "Deployment does not have minimum availability.", ago(days=9) if available == replicas else ago(hours=3)),
                cond("Progressing", "True" if available == replicas else "False", "NewReplicaSetAvailable" if available == replicas else "ProgressDeadlineExceeded",
                     f"ReplicaSet \"{name}-7d9f8b6c5\" has successfully progressed." if available == replicas else f"ReplicaSet \"{name}-7b8c9d0e1\" has timed out progressing.", ago(days=9) if available == replicas else ago(hours=3))],
                "observedGeneration": 3, "readyReplicas": available, "replicas": replicas, "updatedReplicas": updated, **({"unavailableReplicas": unavailable} if unavailable else {})}}


def replicaset(ns, name, owner_name, replicas, ready, seed):
    return {"apiVersion": "apps/v1", "kind": "ReplicaSet", "metadata": meta(name, ns, labels={"app": owner_name, "pod-template-hash": name.rsplit("-", 1)[1]}, created=ago(days=9), uid_seed=seed,
                                                                           annotations={"deployment.kubernetes.io/desired-replicas": str(replicas), "deployment.kubernetes.io/max-replicas": str(replicas + 1), "deployment.kubernetes.io/revision": "3"},
                                                                           extra={"ownerReferences": [{"apiVersion": "apps/v1", "blockOwnerDeletion": True, "controller": True, "kind": "Deployment", "name": owner_name, "uid": f"{seed:08x}-aaaa-4bbb-8ccc-{seed:012x}"}]}),
            "spec": {"replicas": replicas, "selector": {"matchLabels": {"app": owner_name, "pod-template-hash": name.rsplit("-", 1)[1]}}, "template": {"metadata": {"labels": {"app": owner_name}}, "spec": {"containers": [{"name": owner_name.split("-")[-1], "image": "quay.io/example-org/" + owner_name}]}}},
            "status": {"availableReplicas": ready, "fullyLabeledReplicas": replicas, "observedGeneration": 3, "readyReplicas": ready, "replicas": replicas}}


def pdb(ns, name, app, min_available, current_healthy, expected, allowed, seed):
    return {"apiVersion": "policy/v1", "kind": "PodDisruptionBudget", "metadata": meta(name, ns, created=ago(days=9), uid_seed=seed),
            "spec": {"minAvailable": min_available, "selector": {"matchLabels": {"app": app}}},
            "status": {"conditions": [cond("DisruptionAllowed", "True" if allowed else "False", "SufficientPods" if allowed else "InsufficientPods", "", ago(hours=3))],
                       "currentHealthy": current_healthy, "desiredHealthy": min_available, "disruptionsAllowed": allowed, "expectedPods": expected, "observedGeneration": 1}}


def write_platform_namespaces(t, rnd):
    ocp_img = f"quay.io/openshift-release-dev/ocp-v4-0-art-dev@sha256:{'66' * 32}"
    # openshift-monitoring: node-exporter daemonset (worker-1 pod not ready), prometheus statefulset, TLS secrets
    ns = "openshift-monitoring"
    pods = []
    for i, (node, *_r) in enumerate(NODES):
        ready = node != "worker-1"
        p = pod(ns, f"node-exporter-{'abcde'[i] * 5}", node, NODES[i][4], [{"name": "node-exporter", "image": ocp_img, "port": 9100, "ready": ready},
                                                                           {"name": "kube-rbac-proxy", "image": ocp_img, "port": 9100, "ready": ready}],
                owner={"apiVersion": "apps/v1", "blockOwnerDeletion": True, "controller": True, "kind": "DaemonSet", "name": "node-exporter", "uid": "000000e1-aaaa-4bbb-8ccc-0000000000e1"},
                uid_seed=500 + i, conditions_ready=ready, labels={"app.kubernetes.io/name": "node-exporter"}, created=ago(days=20))
        p["spec"]["hostNetwork"] = True
        pods.append(p)
    for i in range(2):
        pods.append(pod(ns, f"prometheus-k8s-{i}", "worker-0" if i == 0 else "worker-1", "10.128.6.9" if i == 0 else "10.128.8.9",
                        [{"name": "prometheus", "image": ocp_img, "port": 9090, "ready": i == 0}, {"name": "config-reloader", "image": ocp_img, "ready": i == 0},
                         {"name": "thanos-sidecar", "image": ocp_img, "ready": i == 0}, {"name": "kube-rbac-proxy", "image": ocp_img, "ready": i == 0}],
                        owner={"apiVersion": "apps/v1", "blockOwnerDeletion": True, "controller": True, "kind": "StatefulSet", "name": "prometheus-k8s", "uid": "000000e2-aaaa-4bbb-8ccc-0000000000e2"},
                        uid_seed=510 + i, conditions_ready=(i == 0), labels={"app.kubernetes.io/name": "prometheus", "prometheus": "k8s"}, created=ago(days=20)))
    pods.append(pod(ns, "alertmanager-main-0", "master-0", "10.128.0.12", [{"name": "alertmanager", "image": ocp_img, "port": 9093}],
                    uid_seed=520, labels={"app.kubernetes.io/name": "alertmanager"}, created=ago(days=20)))
    for p in pods:
        name = p["metadata"]["name"]
        t.yaml(f"namespaces/{ns}/pods/{name}/{name}.yaml", p)
        c0 = p["spec"]["containers"][0]["name"]
        t.write(f"namespaces/{ns}/pods/{name}/{c0}/{c0}/logs/current.log", container_log_lines(
            rnd, COLLECTED - timedelta(hours=2), 25, lambda i, r: f"stderr F ts={ (COLLECTED - timedelta(hours=2, seconds=-i * 7)).strftime('%Y-%m-%dT%H:%M:%S.000Z') } caller=main.go:{r.randint(100, 999)} level={'warn' if i % 7 == 6 else 'info'} msg=\"{'Error on ingesting samples that are too old' if i % 7 == 6 else 'Completed loading of configuration file'}\""))
    t.yaml(f"namespaces/{ns}/apps/daemonsets.yaml", {"apiVersion": "apps/v1", "kind": "DaemonSetList", "metadata": {"resourceVersion": ""}, "items": [
        {"apiVersion": "apps/v1", "kind": "DaemonSet", "metadata": meta("node-exporter", ns, labels={"app.kubernetes.io/name": "node-exporter"}, created=ago(days=200), uid_seed=225),
         "spec": {"selector": {"matchLabels": {"app.kubernetes.io/name": "node-exporter"}}, "template": {"metadata": {"labels": {"app.kubernetes.io/name": "node-exporter"}}, "spec": {"containers": [{"name": "node-exporter", "image": ocp_img}], "hostNetwork": True}},
                  "updateStrategy": {"rollingUpdate": {"maxSurge": 0, "maxUnavailable": "10%"}, "type": "RollingUpdate"}},
         "status": {"currentNumberScheduled": 5, "desiredNumberScheduled": 5, "numberAvailable": 4, "numberMisscheduled": 0, "numberReady": 4, "numberUnavailable": 1, "observedGeneration": 4, "updatedNumberScheduled": 5}}]})
    t.yaml(f"namespaces/{ns}/apps/statefulsets.yaml", {"apiVersion": "apps/v1", "kind": "StatefulSetList", "metadata": {"resourceVersion": ""}, "items": [
        {"apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": meta("prometheus-k8s", ns, labels={"app.kubernetes.io/name": "prometheus"}, created=ago(days=200), uid_seed=226),
         "spec": {"podManagementPolicy": "Parallel", "replicas": 2, "selector": {"matchLabels": {"app.kubernetes.io/name": "prometheus", "prometheus": "k8s"}}, "serviceName": "prometheus-operated",
                  "template": {"metadata": {"labels": {"app.kubernetes.io/name": "prometheus", "prometheus": "k8s"}}, "spec": {"containers": [{"name": "prometheus", "image": ocp_img}]}}, "updateStrategy": {"type": "RollingUpdate"}},
         "status": {"availableReplicas": 1, "collisionCount": 0, "currentReplicas": 2, "currentRevision": "prometheus-k8s-5c4d3e2f1", "observedGeneration": 6, "readyReplicas": 1, "replicas": 2, "updateRevision": "prometheus-k8s-5c4d3e2f1", "updatedReplicas": 2}},
        {"apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": meta("alertmanager-main", ns, labels={"app.kubernetes.io/name": "alertmanager"}, created=ago(days=200), uid_seed=227),
         "spec": {"replicas": 1, "selector": {"matchLabels": {"app.kubernetes.io/name": "alertmanager"}}, "serviceName": "alertmanager-operated", "template": {"metadata": {"labels": {"app.kubernetes.io/name": "alertmanager"}}, "spec": {"containers": [{"name": "alertmanager", "image": ocp_img}]}}},
         "status": {"availableReplicas": 1, "currentReplicas": 1, "observedGeneration": 2, "readyReplicas": 1, "replicas": 1, "updatedReplicas": 1}}]})
    t.yaml(f"namespaces/{ns}/apps/deployments.yaml", {"apiVersion": "apps/v1", "kind": "DeploymentList", "metadata": {"resourceVersion": ""}, "items": [
        deployment(ns, "cluster-monitoring-operator", 1, 1, 1, ocp_img, "cluster-monitoring-operator", 228), deployment(ns, "prometheus-operator", 1, 1, 1, ocp_img, "prometheus-operator", 229)]})
    t.yaml(f"namespaces/{ns}/policy/poddisruptionbudgets.yaml", {"apiVersion": "policy/v1", "kind": "PodDisruptionBudgetList", "metadata": {"resourceVersion": ""}, "items": [
        pdb(ns, "prometheus-k8s", "prometheus", 1, 1, 2, 0, 230), pdb(ns, "alertmanager-main", "alertmanager", 1, 1, 1, 0, 231)]})
    secrets = []
    for i, (name, not_after) in enumerate([
            ("prometheus-k8s-tls", COLLECTED + timedelta(days=700)), ("alertmanager-main-tls", COLLECTED + timedelta(days=700)),
            ("node-exporter-tls", COLLECTED + timedelta(days=20)),          # planted: Expiring Soon
            ("thanos-querier-tls", COLLECTED - timedelta(days=12)),         # planted: Expired
            ("kube-state-metrics-tls", COLLECTED + timedelta(days=58)),     # planted: Expiring Soon (boundary)
            ("metrics-client-certs", COLLECTED + timedelta(days=330))], start=240):
        secrets.append({"apiVersion": "v1", "kind": "Secret", "metadata": meta(name, ns, uid_seed=i, created=iso(not_after - timedelta(days=730)), annotations={
            "auth.openshift.io/certificate-not-after": iso(not_after), "auth.openshift.io/certificate-not-before": iso(not_after - timedelta(days=730)),
            "auth.openshift.io/certificate-issuer": "openshift-service-serving-signer@1700000000",
            "service.beta.openshift.io/originating-service-name": name.replace("-tls", ""), "service.beta.openshift.io/expiry": iso(not_after)}),
            "type": "kubernetes.io/tls", "data": {"tls.crt": "UkVEQUNURUQ=", "tls.key": "UkVEQUNURUQ="}})
    secrets.append({"apiVersion": "v1", "kind": "Secret", "metadata": meta("grafana-datasources", ns, uid_seed=250), "type": "Opaque", "data": {"datasources.yaml": "UkVEQUNURUQ="}})
    t.yaml(f"namespaces/{ns}/core/secrets.yaml", {"apiVersion": "v1", "kind": "SecretList", "metadata": {"resourceVersion": ""}, "items": secrets})
    t.yaml(f"namespaces/{ns}/core/events.yaml", {"apiVersion": "v1", "kind": "EventList", "metadata": {"resourceVersion": ""}, "items": [
        event(ns, "prometheus-k8s-1.17f4c1", "Warning", "NodeNotReady", "Node is not ready", "Pod", "prometheus-k8s-1", ago(hours=3, minutes=10), 1, "node-controller", 421),
        event(ns, "node-exporter-eeeee.17f4c2", "Warning", "NodeNotReady", "Node is not ready", "Pod", "node-exporter-eeeee", ago(hours=3, minutes=10), 1, "node-controller", 422),
        event(ns, "prometheus-k8s.17f4c3", "Warning", "FailedUpdate", "Prometheus openshift-monitoring/k8s: expected 2 replicas, got 1 updated replicas", "StatefulSet", "prometheus-k8s", ago(hours=2), 14, "prometheus-operator", 423),
    ]})

    # openshift-etcd: the three etcd pods with logs (etcd section)
    ns = "openshift-etcd"
    for i in range(3):
        name = f"etcd-master-{i}"
        p = pod(ns, name, f"master-{i}", NODES[i][4], [{"name": "etcd", "image": ocp_img, "port": 2379}, {"name": "etcdctl", "image": ocp_img, "port": 2379},
                                                    {"name": "etcd-metrics", "image": ocp_img, "port": 9979}, {"name": "etcd-readyz", "image": ocp_img, "port": 9980}],
                uid_seed=530 + i, labels={"app": "etcd", "etcd": "true", "k8s-app": "etcd", "revision": "7"}, created=ago(days=20), qos="Burstable")
        p["spec"]["hostNetwork"] = True
        p["spec"]["priorityClassName"] = "system-node-critical"
        t.yaml(f"namespaces/{ns}/pods/{name}/{name}.yaml", p)
        t.write(f"namespaces/{ns}/pods/{name}/etcd/etcd/logs/current.log", container_log_lines(
            rnd, COLLECTED - timedelta(hours=1), 60,
            lambda j, r, i=i: "stderr F " + json.dumps({"level": "warn" if j % 5 == 4 else "info", "ts": (COLLECTED - timedelta(hours=1, seconds=-j * 7)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                                                        "caller": "etcdserver/util.go:170" if j % 5 == 4 else "mvcc/kvstore_compaction.go:66",
                                                        "msg": "apply request took too long" if j % 5 == 4 else "finished scheduled compaction",
                                                        **({"took": f"{r.randint(120, 900)}.{r.randint(0, 999):03d}ms", "expected-duration": "100ms", "prefix": "read-only range ",
                                                            "request": "key:\"/kubernetes.io/pods/\" range_end:\"/kubernetes.io/pods0\" limit:500 "} if j % 5 == 4 else {"compact-revision": 48000000 + j * 500, "took": f"{r.randint(10, 90)}.{r.randint(0, 999):03d}ms"})}, separators=(",", ":"))))
    t.yaml(f"namespaces/{ns}/core/events.yaml", {"apiVersion": "v1", "kind": "EventList", "metadata": {"resourceVersion": ""}, "items": [
        event(ns, "etcd-master-1.17f5d1", "Warning", "SlowRequest", "etcd member master-1 reported 14 slow requests (>100ms) in the last 5 minutes", "Pod", "etcd-master-1", ago(minutes=12), 14, "etcd-operator", 431)]})
    t.yaml(f"namespaces/{ns}/core/configmaps.yaml", {"apiVersion": "v1", "kind": "ConfigMapList", "metadata": {"resourceVersion": ""}, "items": [
        {"apiVersion": "v1", "kind": "ConfigMap", "metadata": meta("etcd-endpoints", ns, uid_seed=260), "data": {f"{i:08x}": NODES[i][4] for i in range(3)}}]})

    # kube-system: cluster-config-v1 (no VIP -> UPI), default: node OOM events
    t.yaml("namespaces/kube-system/configmaps/cluster-config-v1.yaml", {
        "apiVersion": "v1", "kind": "ConfigMap", "metadata": meta("cluster-config-v1", "kube-system", created=ago(days=200), uid_seed=270),
        "data": {"install-config": f"apiVersion: v1\nbaseDomain: {DOMAIN}\ncompute:\n- name: worker\n  replicas: 0\ncontrolPlane:\n  name: master\n  replicas: 3\nmetadata:\n  name: {CLUSTER}\nnetworking:\n  clusterNetwork:\n  - cidr: 10.128.0.0/14\n    hostPrefix: 23\n  networkType: OVNKubernetes\n  serviceNetwork:\n  - 172.30.0.0/16\nplatform:\n  none: {{}}\npublish: External\n"}})
    t.yaml("namespaces/kube-system/core/events.yaml", {"apiVersion": "v1", "kind": "EventList", "metadata": {"resourceVersion": ""}, "items": []})
    t.yaml("namespaces/default/core/events.yaml", {"apiVersion": "v1", "kind": "EventList", "metadata": {"resourceVersion": ""}, "items": [
        {**event("default", "worker-0.17f6e1", "Warning", "SystemOOM", "System OOM encountered, victim process: api, pid: 24817", "Node", "worker-0", ago(minutes=42), 1, "kubelet", 441),
         "involvedObject": {"apiVersion": "v1", "kind": "Node", "name": "worker-0", "uid": "worker-0"}},
        {**event("default", "worker-1.17f6e2", "Normal", "NodeNotReady", "Node worker-1 status is now: NodeNotReady", "Node", "worker-1", ago(hours=3, minutes=12), 1, "node-controller", 442),
         "involvedObject": {"apiVersion": "v1", "kind": "Node", "name": "worker-1", "uid": "worker-1"}},
        {**event("default", "worker-1.17f6e3", "Warning", "NodeNotReady", "Node worker-1 has been unreachable for 3h12m (kubelet stopped posting node status)", "Node", "worker-1", ago(minutes=1), 1, "node-controller", 443),
         "involvedObject": {"apiVersion": "v1", "kind": "Node", "name": "worker-1", "uid": "worker-1"}}]})


# ---------------------------------------------------------------- monitoring, etcd_info, top-level files

def write_monitoring(t):
    def rule(group, name, severity, state, duration, query, summary, description, alerts, since_minutes=0, runbook=True):
        return {"state": state, "name": name, "query": query, "duration": duration, "keepFiringFor": 0,
                "labels": {"severity": severity}, "annotations": {"summary": summary, "description": description,
                                                                  **({"runbook_url": f"https://github.com/openshift/runbooks/blob/master/alerts/{group}/{name}.md"} if runbook else {})},
                "alerts": [{"labels": {"alertname": name, "severity": severity, **a}, "annotations": {"summary": summary, "description": description},
                            "state": "firing", "activeAt": ago(minutes=since_minutes), "value": "1e+00"} for a in alerts],
                "health": "ok", "evaluationTime": 0.0021, "lastEvaluation": ago(seconds=22), "type": "alerting"}

    groups = [
        {"name": "kubernetes-apps", "file": "/etc/prometheus/rules/prometheus-k8s-rulefiles-0/openshift-monitoring-kubernetes-monitoring-rules.yaml", "interval": 30, "limit": 0, "rules": [
            rule("kubernetes-apps", "KubePodCrashLooping", "warning", "firing", 900,
                 'max_over_time(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff", job="kube-state-metrics", namespace=~"(openshift-.*|kube-.*|default)"}[5m]) >= 1',
                 "Pod is crash looping.", "Pod payments-demo/payments-worker-7b8c9d0e1-efghi (worker) is in waiting state (reason: \"CrashLoopBackOff\").",
                 [{"namespace": "payments-demo", "pod": "payments-worker-7b8c9d0e1-efghi", "container": "worker"}], since_minutes=225),
            rule("kubernetes-apps", "KubePodNotReady", "warning", "firing", 900,
                 'sum by (namespace, pod) (max by(namespace, pod) (kube_pod_status_phase{job="kube-state-metrics", phase=~"Pending|Unknown"})) > 0',
                 "Pod has been in a non-ready state for more than 15 minutes.", "Pod demo-app/demo-web-7d9f8b6c5-klmno has been in a non-ready state for longer than 15 minutes.",
                 [{"namespace": "demo-app", "pod": "demo-web-7d9f8b6c5-klmno"}, {"namespace": "openshift-monitoring", "pod": "prometheus-k8s-1"}], since_minutes=175),
            rule("kubernetes-apps", "KubeContainerWaiting", "warning", "firing", 3600,
                 'sum by (namespace, pod, container) (kube_pod_container_status_waiting_reason{job="kube-state-metrics"}) > 0',
                 "Pod container waiting longer than 1 hour", "pod/payments-worker-7b8c9d0e1-efghi in namespace payments-demo on container worker has been in waiting state for longer than 1 hour.",
                 [{"namespace": "payments-demo", "pod": "payments-worker-7b8c9d0e1-efghi", "container": "worker"}], since_minutes=165),
            rule("kubernetes-apps", "KubeDeploymentReplicasMismatch", "warning", "inactive", 900,
                 'kube_deployment_spec_replicas{job="kube-state-metrics"} > kube_deployment_status_replicas_available{job="kube-state-metrics"}',
                 "Deployment has not matched the expected number of replicas.", "Deployment has not matched the expected number of replicas for longer than 15 minutes.", []),
        ]},
        {"name": "kubernetes-system", "file": "/etc/prometheus/rules/prometheus-k8s-rulefiles-0/openshift-monitoring-kubernetes-monitoring-rules.yaml", "interval": 30, "limit": 0, "rules": [
            rule("kubernetes-system", "KubeNodeNotReady", "warning", "firing", 900, 'kube_node_status_condition{job="kube-state-metrics",condition="Ready",status="true"} == 0',
                 "Node is not ready.", "worker-1 has been unready for more than 15 minutes.", [{"node": "worker-1", "condition": "Ready", "status": "true"}], since_minutes=177),
            rule("kubernetes-system", "KubeNodeUnreachable", "warning", "firing", 900,
                 '(kube_node_spec_taint{job="kube-state-metrics",key="node.kubernetes.io/unreachable",effect="NoSchedule"} unless ignoring(key,value) kube_node_spec_taint{job="kube-state-metrics",key=~"ToBeDeletedByClusterAutoscaler|cloud.google.com/impending-node-termination|aws-node-termination-handler/spot-itn"}) == 1',
                 "Node is unreachable.", "worker-1 is unreachable and some workloads may be rescheduled.", [{"node": "worker-1", "effect": "NoSchedule"}], since_minutes=177),
            rule("kubernetes-system", "KubeletDown", "critical", "firing", 900, 'absent(up{job="kubelet", metrics_path="/metrics"} == 1)',
                 "Target disappeared from Prometheus target discovery.", "Kubelet on worker-1 has disappeared from Prometheus target discovery.", [{"node": "worker-1"}], since_minutes=180),
            rule("kubernetes-system", "KubeVersionMismatch", "warning", "inactive", 900, 'count by (cluster) (count by (git_version, cluster) (label_replace(kubernetes_build_info{job!~"kube-dns|coredns"},"git_version","$1","git_version","(v[0-9]*.[0-9]*).*"))) > 1',
                 "Different semantic versions of Kubernetes components running.", "There are 1 different semantic versions of Kubernetes components running.", []),
        ]},
        {"name": "cluster-version", "file": "/etc/prometheus/rules/prometheus-k8s-rulefiles-0/openshift-cluster-version-operator-cluster-version-operator.yaml", "interval": 30, "limit": 0, "rules": [
            rule("cluster-version", "ClusterOperatorDegraded", "warning", "firing", 1800,
                 'max by (namespace, name, reason) ((cluster_operator_conditions{job="cluster-version-operator", condition="Degraded"} or on (namespace, name) group by (namespace, name) (cluster_operator_up{job="cluster-version-operator"})) == 1)',
                 "Cluster operator has been degraded for 30 minutes.", "The monitoring operator is degraded because UpdatingPrometheusK8sFailed, and the components it manages may have reduced quality of service.",
                 [{"name": "monitoring", "namespace": "openshift-cluster-version", "reason": "UpdatingPrometheusK8sFailed"}], since_minutes=95),
            rule("cluster-version", "ClusterNotUpgradeable", "info", "firing", 3600, 'max by (namespace, name, condition, endpoint) (cluster_operator_conditions{name="version", condition="Upgradeable", endpoint="metrics"} == 0)',
                 "One or more cluster operators have been blocking minor version cluster upgrades for at least an hour.", "In most cases, you will still be able to apply patch releases. Reason ClusterOperatorDegraded.",
                 [{"name": "version", "condition": "Upgradeable", "endpoint": "metrics", "namespace": "openshift-cluster-version"}], since_minutes=60),
        ]},
        {"name": "etcd", "file": "/etc/prometheus/rules/prometheus-k8s-rulefiles-0/openshift-etcd-operator-etcd-prometheus-rules.yaml", "interval": 30, "limit": 0, "rules": [
            rule("etcd", "etcdHighFsyncDurations", "warning", "firing", 600, 'histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket{job=~".*etcd.*"}[5m])) > 0.5',
                 "etcd cluster 99th percentile fsync durations are too high.", "etcd cluster \"etcd\": 99th percentile fsync durations are 0.61s on etcd instance 10.0.0.12:9979.",
                 [{"instance": "10.0.0.12:9979", "job": "etcd", "pod": "etcd-master-1", "namespace": "openshift-etcd"}], since_minutes=12),
            rule("etcd", "etcdMembersDown", "critical", "inactive", 600, 'max without (endpoint) (sum without (instance) (up{job=~".*etcd.*"} == bool 0) or count without (To) (sum without (instance) (rate(etcd_network_peer_sent_failures_total{job=~".*etcd.*"}[2m])) > 0.01)) > 0',
                 "etcd cluster members are down.", "etcd cluster \"etcd\": members are down.", []),
        ]},
        {"name": "general.rules", "file": "/etc/prometheus/rules/prometheus-k8s-rulefiles-0/openshift-monitoring-kubernetes-monitoring-rules.yaml", "interval": 30, "limit": 0, "rules": [
            rule("general.rules", "TargetDown", "warning", "firing", 900, '100 * ((1 - sum by (job, namespace, service) (up and on (namespace, pod) kube_pod_info) / count by (job, namespace, service) (up and on (namespace, pod) kube_pod_info)) or (count by (job, namespace, service) (up == 0) / count by (job, namespace, service) (up))) > 10',
                 "Some targets were not reachable from the monitoring server for an extended period of time.", "20% of the node-exporter/node-exporter targets in Namespace openshift-monitoring namespace have been unreachable for more than 15 minutes. This may be a symptom of network connectivity issues, down nodes, or failures within these components.",
                 [{"job": "node-exporter", "namespace": "openshift-monitoring", "service": "node-exporter"}], since_minutes=178),
            rule("general.rules", "Watchdog", "none", "firing", 0, "vector(1)", "An alert that should always be firing to certify that Alertmanager is working properly.",
                 "This is an alert meant to ensure that the entire alerting pipeline is functional.", [{"namespace": "openshift-monitoring"}], since_minutes=28000, runbook=False),
        ]},
    ]
    t.write("monitoring/prometheus/rules.json", json.dumps({"status": "success", "data": {"groups": groups}}, indent=2) + "\n")
    t.write("monitoring/alertmanager/alerts.json", json.dumps({"status": "success", "data": [
        {"labels": {"alertname": "KubePodCrashLooping", "namespace": "payments-demo", "pod": "payments-worker-7b8c9d0e1-efghi", "severity": "warning"}, "startsAt": ago(minutes=225), "endsAt": "0001-01-01T00:00:00Z", "status": {"state": "active", "silencedBy": [], "inhibitedBy": []}},
        {"labels": {"alertname": "KubeNodeNotReady", "node": "worker-1", "severity": "warning"}, "startsAt": ago(minutes=177), "endsAt": "0001-01-01T00:00:00Z", "status": {"state": "active", "silencedBy": [], "inhibitedBy": []}},
        {"labels": {"alertname": "ClusterOperatorDegraded", "name": "monitoring", "severity": "warning"}, "startsAt": ago(minutes=95), "endsAt": "0001-01-01T00:00:00Z", "status": {"state": "active", "silencedBy": [], "inhibitedBy": []}}]}, indent=2) + "\n")


def write_etcd_and_top(t):
    members = [{"ID": 1000000000000000001 + i, "name": f"master-{i}", "peerURLs": [f"https://{NODES[i][4]}:2380"], "clientURLs": [f"https://{NODES[i][4]}:2379"]} for i in range(3)]
    t.write("etcd_info/member_list.json", json.dumps({"header": {"cluster_id": 2000000000000000001, "member_id": 1000000000000000001, "raft_term": 17}, "members": members}, indent=2) + "\n")
    t.write("etcd_info/endpoint_health.json", json.dumps([{"endpoint": f"https://{NODES[i][4]}:2379", "health": True, "took": f"{[9, 41, 11][i]}.{123 + i}ms"} for i in range(3)], indent=2) + "\n")
    t.write("etcd_info/endpoint_status.json", json.dumps([{"Endpoint": f"https://{NODES[i][4]}:2379", "Status": {
        "header": {"cluster_id": 2000000000000000001, "member_id": 1000000000000000001 + i, "revision": 48123456, "raft_term": 17},
        "version": "3.5.14", "dbSize": 412340224 + i * 1000, "dbSizeInUse": 198765432, "leader": 1000000000000000001, "raftIndex": 51234567, "raftTerm": 17, "raftAppliedIndex": 51234567,
        "errors": ["memberID:1000000000000000002 alarm:NOSPACE"] if False else []}} for i in range(3)], indent=2) + "\n")
    t.write("etcd_info/etcd_version", "etcd Version: 3.5.14\nGit SHA: Not provided (use ./build instead of go build)\nGo Version: go1.21.11\nGo OS/Arch: linux/amd64\n")

    stamp = COLLECTED.strftime("%Y-%m-%d %H:%M:%S.123456789 +0000 UTC m=+0.052191348")
    end = (COLLECTED + timedelta(minutes=2, seconds=41)).strftime("%Y-%m-%d %H:%M:%S.987654321 +0000 UTC m=+161.916409880")
    t.write("timestamp", f"{stamp}\n{end}\n")
    t.write("version", f"ClusterID: {CLUSTER_ID}\nClusterVersion: Stable at \"{OCP_VERSION}\"\nClusterOperators:\n"
                       "\tclusteroperator/machine-config is progressing: Working towards 4.16.12: 1 of 2 worker nodes updated; worker-1 is unreachable\n"
                       "\tclusteroperator/monitoring is degraded because UpdatingPrometheusK8sFailed\n")
    t.write("cluster-scoped-resources/core/nodes/.gitkeep", "")


def write_logs(t, rnd):
    """host_service_logs/ (the kubelet and crio journals per role), audit_logs/
    (the API servers' audit logs, gzip-named but plain here) and
    network_logs/ (ovs / ovn / iptables dumps), with sizes that differ enough
    for the Log Collection tab to rank them."""
    def lines(n, fmt):
        out = []
        at = COLLECTED - timedelta(hours=6)
        for i in range(n):
            at += timedelta(seconds=rnd.uniform(0.5, 30))
            out.append(fmt(at, i))
        return "\n".join(out) + "\n"
    kubelet = lambda at, i: f"{at:%b %d %H:%M:%S} master-0 kubenswrapper[2271]: I{at:%m%d %H:%M:%S.%f} {2271 + i % 7} kubelet.go:2385] \"SyncLoop (PLEG): event for pod\" pod=\"demo-app/demo-web-6d5c7b8f9-{'abcde'[i % 5]}xyz\" event={{\"ID\":\"{i:08x}\",\"Type\":\"ContainerStarted\"}}"
    crio = lambda at, i: f"{at:%b %d %H:%M:%S} master-0 crio[1961]: time=\"{at:%Y-%m-%dT%H:%M:%S}Z\" level=info msg=\"Pulled image: quay.io/example-org/demo-web@sha256:{'%064x' % (i * 7919)}\" id={i:08x}"
    t.write("host_service_logs/masters/kubelet_service.log", lines(900, kubelet))
    t.write("host_service_logs/masters/crio_service.log", lines(240, crio))
    t.write("host_service_logs/workers/kubelet_service.log", lines(1400, kubelet))
    t.write("host_service_logs/workers/crio_service.log", lines(120, crio))
    # audit_logs/: the API servers' audit logs in the real layout and schema (mock_audit_logs.py); "Mixed":
    # master-2 records write bodies (the custom rule below), the other masters only metadata
    mock_audit_logs.write(t, rnd_seed=20261013, collected=COLLECTED, profile="Mixed")
    # the cluster APIServer config the Audit tabs read the audit profile from
    t.yaml("cluster-scoped-resources/config.openshift.io/apiservers/cluster.yaml", {
        "apiVersion": "config.openshift.io/v1", "kind": "APIServer", "metadata": meta("cluster", created=ago(days=200), uid_seed=77),
        "spec": {"audit": {"profile": "Default", "customRules": [{"group": "system:authenticated:oauth", "profile": "WriteRequestBodies"}]},
                 "encryption": {"type": ""}, "tlsSecurityProfile": {"intermediate": {}, "type": "Intermediate"}}, "status": {}})
    t.write("network_logs/ovs-vsctl_show_master-0", "Bridge br-int\n    fail_mode: secure\n" + "".join(f"    Port {name}\n        Interface {name}\n            type: internal\n" for name in [f"veth{i:04x}" for i in range(40)]))
    t.write("network_logs/iptables-save_master-0", "# Generated by iptables-save\n*filter\n:INPUT ACCEPT [0:0]\n" + "".join(f"-A KUBE-SERVICES -d 172.30.{i // 256}.{i % 256}/32 -p tcp -m tcp --dport 443 -j KUBE-SVC-{i:08X}\n" for i in range(300)) + "COMMIT\n")
    t.write("network_logs/ovnkube-trace_demo-app", "ovn-trace: demo-app/demo-web -> demo-app/demo-cache: reachable (2 hops)\n")


def build(base, rnd_seed=20261013):
    """Write the whole must-gather under `base` (basename must contain 'must-gather')."""
    rnd = random.Random(rnd_seed)
    top = Tree(base)
    stamp = COLLECTED.strftime("%Y-%m-%d %H:%M:%S.123456789 +0000 UTC m=+0.052191348")
    end = (COLLECTED + timedelta(minutes=2, seconds=41)).strftime("%Y-%m-%d %H:%M:%S.987654321 +0000 UTC m=+161.916409880")
    top.write("timestamp", f"{stamp}\n{end}\n")
    top.write("event-filter.html", "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>must-gather event filter</title></head>\n"
                                   "<body><p>Synthetic must-gather for the Jacarium Diagnostics page. Events are under namespaces/*/core/events.yaml.</p></body></html>\n")
    inner = Tree(os.path.join(base, IMAGE_DIR))
    write_cluster_scoped(inner, rnd)
    write_workload_namespaces(inner, rnd)
    write_platform_namespaces(inner, rnd)
    write_monitoring(inner)
    write_etcd_and_top(inner)
    write_logs(inner, rnd)
    os.remove(os.path.join(inner.base, "cluster-scoped-resources/core/nodes/.gitkeep"))
    return base
