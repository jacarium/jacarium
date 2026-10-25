#!/usr/bin/env python3
"""The data behind the must-gather detail pages (backend/parsers/mustgather/detail.py, managed_fields.py): the
planted CrashLoopBackOff pod (its badge, the Findings with the last state's reason and exit code, the restarts, the
events linked, the container logs listed with their sizes, the field ownership newest first with the person's
edit flagged), the OOMKilled pod, a node's capacity / allocatable meters and the pods on it, the NotReady node,
the deployment that cannot roll out (its ReplicaSets, the planted kubectl edit), the generic detail of the other
kinds (a budget's condition, a Secret's ownership), the quantity and time helpers, the managedFields reader, and
the empty cases (no status, no logs, no metadata) that must never raise.

The synthetic gather comes from tests/fixtures/diagnostics-mock (generate.py), so every expectation below is a
value that generator plants. Run with the backend venv's Python: backend/venv/bin/python tests/mustgather_detail.test.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)

from parsers.mustgather import detail, managed_fields, pod, nodes, deployment, pdb, tls_secrets, mcp, system  # noqa: E402

FAILED = 0


def check(name, ok, info=""):
    global FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {name}" + (f" | {str(info)[:400]}" if not ok and info else ""))
    if not ok:
        FAILED += 1


WORK = tempfile.mkdtemp(prefix="mg-detail-")
gen = subprocess.run([sys.executable, os.path.join(HERE, "fixtures", "diagnostics-mock", "generate.py"), "--out", WORK, "--no-archives"], capture_output=True, text=True)
check("the synthetic gather generates", gen.returncode == 0, gen.stderr[-300:])
GATHER = os.path.join(WORK, "must-gather.local.1234567890")
CRASH = "payments-worker-7b8c9d0e1-efghi"
OOM = "payments-api-5f6d7c8b9-zabcd"

# ---------------------------------------------------------------- the helpers
check("quantity: cpu millicores, binary and decimal units, plain numbers", detail.quantity("500m") == 0.5 and detail.quantity("16Gi") == 16 * 1024 ** 3 and detail.quantity("122000000Ki") == 122000000 * 1024 and detail.quantity("3") == 3.0 and detail.quantity("2k") == 2000.0)
check("quantity: unreadable values give None, never raise", detail.quantity(None) is None and detail.quantity("abc") is None and detail.quantity("1x") is None and detail.quantity("") is None)
check("human_bytes / human_cpu read like the console", detail.human_bytes(32 * 1024 ** 3) == "32.0 GiB" and detail.human_bytes(994) == "994 B" and detail.human_cpu(0.5) == "500m" and detail.human_cpu(8) == "8")
check("duration: seconds, minutes, hours, days", detail.duration(45) == "45 s" and detail.duration(240) == "4 min" and detail.duration(3600 * 2 + 600) == "2 h 10 min" and detail.duration(86400 * 3 + 7200) == "3 d 2 h" and detail.duration(None) == "")
check("relative: '12 min before the gather' from the two timestamps", detail.relative("2026-10-12T14:28:12Z", "2026-10-12T14:40:12Z") == "12 min before the gather" and detail.relative("bad", "2026-10-12T14:40:12Z") == "")
check("managed_fields.relative covers seconds, hours and days, and a time after the gather", managed_fields.relative(30) == "30 s before the gather" and managed_fields.relative(3 * 3600 + 300) == "3 h 5 min before the gather" and managed_fields.relative(3 * 86400) == "3 d before the gather" and managed_fields.relative(-5) == "after the gather time")
tree = {"f:metadata": {"f:labels": {".": {}, "f:app": {}}}, "f:spec": {"f:containers": {'k:{"name":"web"}': {".": {}, "f:image": {}, "f:env": {'k:{"name":"X"}': {".": {}, "f:value": {}}}}}, "f:replicas": {}}}
paths = managed_fields.flatten(tree)
check("managed_fields.flatten: readable paths, list items by their merge key, '.' marks skipped", paths == ["metadata.labels.app", "spec.containers[name=web].image", "spec.containers[name=web].env[name=X].value", "spec.replicas"], paths)
check("managed_fields.classify: kubectl / oc / the console are a person's tools, status writes are status, the rest controllers",
      managed_fields.classify("kubectl-edit", "", "Update") == "human" and managed_fields.classify("oc", "", "Update") == "human" and managed_fields.classify("Mozilla/5.0", "", "Update") == "human"
      and managed_fields.classify("kubelet", "status", "Update") == "status" and managed_fields.classify("kube-controller-manager", "", "Update") == "controller")
check("managed_fields.entries: no metadata, no managedFields, a malformed list all give []", managed_fields.entries({}) == [] and managed_fields.entries({"metadata": {}}) == [] and managed_fields.entries({"metadata": {"managedFields": "nope"}}) == [] and managed_fields.entries(None) == [])

# ---------------------------------------------------------------- the pods
pods = pod.parse(GATHER)
crash = pods["payments-demo"][CRASH]
d = crash["_detail"]
check("the pod parser attaches _detail to every pod", all("_detail" in p for ns, ps in pods.items() if not ns.startswith("_") for p in ps.values() if "error" not in p))
check("the crash pod's badge is the waiting reason, in the bad role", d["badge"] == {"kind": "bad", "text": "CrashLoopBackOff"}, d["badge"])
sev = {f["title"]: f["severity"] for f in d["findings"]}
crash_f = next((f for f in d["findings"] if f["title"] == "worker is in CrashLoopBackOff"), None)
check("Findings: the container in CrashLoopBackOff (bad) names the last run's exit code and reason", crash_f and crash_f["severity"] == "bad" and "exit code 1 (Error)" in crash_f["detail"] and "4 min before the gather" in crash_f["detail"], crash_f)
check("Findings: the crash finding links to the Events page searched for the pod", crash_f and crash_f.get("link", {}).get("tab") == "system" and crash_f["link"].get("sub_tab") == "events" and crash_f["link"].get("query") == CRASH, crash_f and crash_f.get("link"))
check("Findings: 42 restarts (warn), Ready False (warn), the person's edit 12 min before the gather (info)", sev.get("worker restarted 42 times") == "warn" and sev.get("Ready is False: ContainersNotReady") == "warn" and sev.get("Edited by oc 12 min before the gather") == "info", sev)
check("Findings: worst first", [f["severity"] for f in d["findings"]] == sorted((f["severity"] for f in d["findings"]), key=lambda s: {"bad": 0, "warn": 1, "info": 2, "good": 3}[s]))
c = d["containers"][0]
check("Containers: the card carries the waiting state with its reason and message, the last state's exit code and reason, the restarts, not ready",
      c["name"] == "worker" and c["state"]["kind"] == "waiting" and c["state"]["reason"] == "CrashLoopBackOff" and "back-off" in c["state"]["message"] and c["last_state"]["kind"] == "terminated" and c["last_state"]["exit_code"] == 1 and c["last_state"]["reason"] == "Error" and c["restarts"] == 42 and c["ready"] is False, c)
check("Containers: resources in readable units, the port, the mount, the env from a secret (its name only)", c["requests"] == {"cpu": "100m", "memory": "128 MiB"} and c["limits"]["memory"] == "512 MiB" and c["ports"] == ["8080/TCP (http)"] and c["mounts"] and c["env"] == [{"name": "DATABASE_URL", "from": "secret postgres-demo-credentials/url", "value": None, "masked": False}], c)
check("Events: the pod's own, newest first, with the count and the relative time", [e["reason"] for e in d["events"]] == ["BackOff", "Pulled"] and d["events"][0]["count"] == 42 and d["events"][0]["type"] == "Warning" and d["events"][0]["relative"] == "2 min before the gather", d["events"])
check("Logs: the container logs the gather holds, with their sizes, the empty current log flagged", [(l["container"], l["kind"], l["bytes"], l["empty"]) for l in d["logs"]] == [("worker", "current", 0, True), ("worker", "previous", 994, False), ("worker", "previous.insecure", 994, False)] and d["logs"][1]["size"] == "994 B" and d["logs"][1]["path"].endswith("/worker/worker/logs/previous.log"), d["logs"])
own = d["ownership"]
check("Field ownership: the entries newest first, the kinds told apart, the person's edit summarised", [(e["manager"], e["kind"]) for e in own["entries"]] == [("kubelet", "status"), ("oc", "human"), ("kube-controller-manager", "controller")] and own["latest_human"]["manager"] == "oc" and own["latest_human"]["relative"] == "12 min before the gather" and own["total"] == 3, own)
check("Field ownership: the paths read like kubectl explains them", "spec.containers[name=worker].env[name=DATABASE_URL].valueFrom" in own["entries"][2]["fields"] and own["entries"][1]["fields"] == ["metadata.labels.debug"], own["entries"][2]["fields"])
s = d["summary"]
check("Summary: node, phase, state, QoS, IP, owner, service account, ready / restarts, age", s["node"] == "master-1" and s["phase"] == "Running" and s["state"] == "CrashLoopBackOff" and s["qos"] == "Burstable" and s["ip"] == "10.128.2.77" and s["owner"] == {"kind": "ReplicaSet", "name": "payments-worker-7b8c9d0e1", "controller": True} and s["service_account"] == "default" and s["ready"] == "0/1" and s["restarts"] == 42 and s["age"] == "4 h", s)
check("Conditions: the five pod conditions with Ready False and its reason", len(d["conditions"]) == 5 and any(x["type"] == "Ready" and x["status"] == "False" and x["reason"] == "ContainersNotReady" for x in d["conditions"]), d["conditions"])
check("Volumes and scheduling read from the spec", d["volumes"] and d["volumes"][0]["kind"] in ("projected", "secret", "emptyDir", "persistentVolumeClaim", "configMap") and d["scheduling"]["restart_policy"] == "Always", (d["volumes"], d["scheduling"]))
oom = pods["payments-demo"][OOM]["_detail"]
oom_f = next((f for f in oom["findings"] if f["title"].startswith("api was OOMKilled")), None)
check("the OOMKilled pod: a bad finding with the exit code 137, the memory limit and the time; the badge stays Running", oom_f and oom_f["severity"] == "bad" and "exit code 137" in oom_f["detail"] and "256Mi" in oom_f["detail"] and "42 min before the gather" in oom_f["title"] and oom["badge"]["text"] == "Running", (oom_f, oom["badge"]))
check("the OOMKilled pod: 7 restarts flagged, its last state on the card", any(f["title"] == "api restarted 7 times" and f["severity"] == "warn" for f in oom["findings"]) and oom["containers"][0]["last_state"]["reason"] == "OOMKilled" and oom["containers"][0]["last_state"]["exit_code"] == 137)
check("the OOMKilled pod's events: the failed liveness probe is a finding", any(f["title"].startswith("Unhealthy") and "Liveness probe failed" in f["detail"] for f in oom["findings"]), [f["title"] for f in oom["findings"]])
healthy = next(p for ns, ps in pods.items() if ns == "openshift-etcd" for p in ps.values())["_detail"]
check("a healthy pod: one GOOD line (running, ready, no restart), a Running badge", [f["severity"] for f in healthy["findings"]] == ["good"] and healthy["badge"] == {"kind": "ok", "text": "Running"}, healthy["findings"])
check("the page's own Findings strip still reads the same pods (the _detail key is invisible to it)", any("CrashLoopBackOff" in f["title"] for f in pod.findings(GATHER)))

# ---------------------------------------------------------------- the nodes
nd = nodes.parse(GATHER)
m0 = nd["master-0"]["_detail"]
meters = {m["resource"]: m for m in m0["meters"]}
check("the node parser attaches _detail to every node", all("_detail" in n for n in nd.values() if n.get("kind") != "Error"))
check("Capacity: cpu 7.5 allocatable of 8 (93.8%), memory and pods in readable units, the share of the capacity", meters["cpu"]["allocatable"] == "7.5" and meters["cpu"]["capacity"] == "8" and meters["cpu"]["share"] == 93.8 and meters["memory"]["capacity"] == "32.0 GiB" and meters["pods"]["allocatable"] == "250" and meters["pods"]["share"] == 100.0 and meters["ephemeral-storage"]["allocatable_raw"] > 0, meters)
check("Pods on this node: counted from every pod manifest, by phase, with their namespaces", m0["pods"]["count"] == 4 and m0["pods"]["phases"] == {"Running": 4} and {p["namespace"] for p in m0["pods"]["rows"]} >= {"openshift-etcd", "payments-demo"}, m0["pods"])
check("master-0: Ready badge, a GOOD finding, the roles, the kubelet and the addresses", m0["badge"] == {"kind": "ok", "text": "Ready"} and m0["findings"][0]["severity"] == "good" and "control-plane" in m0["summary"]["roles"] and m0["summary"]["kubelet"].startswith("v1.") and any(a["type"] == "InternalIP" for a in m0["summary"]["addresses"]), (m0["badge"], m0["findings"], m0["summary"]["roles"]))
bad_node = next((n for n in nd.values() if isinstance(n, dict) and n.get("_detail") and n["_detail"]["badge"]["kind"] == "bad"), None)
check("a NotReady node: a bad badge and a NotReady finding that links to its pods", bad_node and bad_node["_detail"]["findings"][0]["severity"] == "bad" and bad_node["_detail"]["findings"][0]["title"].startswith("NotReady") and bad_node["_detail"]["findings"][0]["link"]["sub_tab"] == "pod", bad_node and bad_node["_detail"]["findings"])
check("pods_by_node is cached per gather and empty for an unknown directory", detail.pods_by_node(GATHER) is detail.pods_by_node(GATHER) and detail.pods_by_node(os.path.join(WORK, "nowhere")) == {})

# ---------------------------------------------------------------- the deployments
dp = deployment.parse(GATHER)
w = dp["payments-demo"]["payments-worker"]["_detail"]
check("the deployment parser attaches _detail to every deployment", all("_detail" in x for ns in dp.values() for x in ns.values() if isinstance(x, dict) and "spec" in x))
check("payments-worker: 0/1 available badge, the bad / warn / info findings", w["badge"] == {"kind": "bad", "text": "0/1 available"} and [f["severity"] for f in w["findings"]] == ["bad", "warn", "info"] and w["findings"][1]["title"].startswith("The rollout is not progressing") and w["findings"][2]["title"] == "Edited by kubectl-edit 12 min before the gather", w["findings"])
check("payments-worker: its ReplicaSet with the revision, replicas and readiness", [(r["name"], r["revision"], r["replicas"], r["ready"]) for r in w["replicasets"]] == [("payments-worker-7b8c9d0e1", "3", 1, 0)], w["replicasets"])
check("payments-worker: the summary (replicas, strategy, revision, selector) and the pod template's container", w["summary"]["replicas"] == 1 and w["summary"]["available"] == 0 and w["summary"]["strategy"] == "RollingUpdate" and w["summary"]["max_surge"] == "25%" and w["summary"]["revision"] == "3" and w["summary"]["selector"] == {"app": "payments-worker"} and w["containers"][0]["name"] == "worker" and w["containers"][0]["state"] is None, w["summary"])
check("payments-worker: the ownership entries newest first, the kubectl-edit of the env summarised", [e["manager"] for e in w["ownership"]["entries"]] == ["kube-controller-manager", "kubectl-edit", "kubectl-create"] and w["ownership"]["latest_human"]["manager"] == "kubectl-edit" and w["ownership"]["latest_human"]["fields"][0].startswith("spec.template.spec.containers[name=worker].env[name=DATABASE_URL]"), w["ownership"])
api = dp["payments-demo"]["payments-api"]["_detail"]
check("payments-api: 2/2 available, a GOOD finding", api["badge"] == {"kind": "ok", "text": "2/2 available"} and [f["severity"] for f in api["findings"]] == ["good"], api["findings"])

# ---------------------------------------------------------------- the other kinds
pb = pdb.parse(GATHER)
blocked = next(x["_detail"] for ns in pb.values() for x in ns.values() if isinstance(x, dict) and x.get("_detail") and x["_detail"]["findings"])
check("a budget: the DisruptionAllowed False condition is a warn finding, the conditions table filled", blocked["findings"][0]["severity"] == "warn" and blocked["findings"][0]["title"].startswith("DisruptionAllowed is False") and blocked["conditions"][0]["type"] == "DisruptionAllowed", blocked)
tl = tls_secrets.parse(GATHER)
sec = next(x for x in tl if "raw" in x)
check("a TLS secret record carries its detail (kind, age, ownership, no conditions)", sec["detail"]["kind"] == "Secret" and sec["detail"]["conditions"] == [] and "ownership" in sec["detail"] and sec["detail"]["age"], sec["detail"])
pools = mcp.parse(GATHER)
worker_pool = next(x for x in pools if x.get("name") == "worker")
check("the degraded MachineConfigPool: Degraded True and Updated False as findings on its detail", {f["title"] for f in worker_pool["detail"]["findings"]} >= {"Degraded is True", "Updated is False"} and len(worker_pool["detail"]["conditions"]) == 5, worker_pool["detail"]["findings"])
sysd = system.parse(GATHER)
ops = sysd["cluster_operators"]
check("every cluster operator carries its detail with its conditions", ops and all("_detail" in o and o["_detail"]["conditions"] for o in ops))
degraded_op = next((o for o in ops if any(c.get("type") == "Degraded" and c.get("status") == "True" for c in (o.get("status") or {}).get("conditions") or [])), None)
check("a Degraded operator: the condition is a warn finding on its detail", degraded_op is None or any(f["title"].startswith("Degraded is True") for f in degraded_op["_detail"]["findings"]), degraded_op and degraded_op["_detail"]["findings"])

# ---------------------------------------------------------------- the empty cases
gather_time = datetime(2026, 10, 12, 14, 40, 12, tzinfo=timezone.utc)
bare = detail.pod_detail({"metadata": {"name": "x", "namespace": "ns"}, "spec": {"containers": [{"name": "c", "image": "i"}]}}, [], None, gather_time)
check("a pod without status: a muted badge, no crash, the card without a state, no logs", bare["badge"]["kind"] in ("muted", "warn") and bare["containers"][0]["state"] is None and bare["logs"] == [] and not any(f["severity"] == "bad" for f in bare["findings"]), bare["badge"])
check("pod_logs on a missing directory gives []", detail.pod_logs(os.path.join(WORK, "nowhere"), "ns", "pod") == [])
check("node_detail without status or spec never raises", detail.node_detail({"metadata": {"name": "n"}}, None, gather_time)["badge"]["kind"] == "bad")
check("deployment_detail without status: 0 available of 1, no ReplicaSets", detail.deployment_detail({"metadata": {"name": "d", "namespace": "ns"}, "spec": {}}, [], [], gather_time)["badge"]["text"] == "0/1 available")
check("generic_detail of an object without metadata gives an empty, well-formed record", detail.generic_detail({}, [], gather_time)["findings"] == [] and detail.generic_detail({}, [], gather_time)["ownership"]["entries"] == [])
check("object_events ignores malformed entries and caps the list", detail.object_events([None, "x", {"kind": "Error"}] + [{"involvedObject": {"kind": "Pod", "name": "p"}, "lastTimestamp": f"2026-10-12T14:{i:02d}:00Z"} for i in range(30)], "Pod", "p")[0]["last"] == "2026-10-12T14:29:00Z" and len(detail.object_events([{"involvedObject": {"kind": "Pod", "name": "p"}}] * 30, "Pod", "p")) == detail.EVENTS_MAX)
check("namespace_events / namespace_list on a missing file give []", detail.namespace_events(WORK, "nowhere") == [] and detail.namespace_list(WORK, "nowhere", "apps", "x.yaml") == [])

shutil.rmtree(WORK, ignore_errors=True)
print(f"\n{'FAILED' if FAILED else 'All checks passed'} ({FAILED} failed)")
sys.exit(1 if FAILED else 0)
