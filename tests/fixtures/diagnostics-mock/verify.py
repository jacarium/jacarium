#!/usr/bin/env python3
"""Check the generated mocks against the REAL Diagnostics backend (no app needed).

    backend/venv/bin/python tests/fixtures/diagnostics-mock/verify.py [--out DIR]

Builds a Flask app around backend/log_viewer.py (the blueprint the Diagnostics
page talks to), points it at out/<report>, and for every tab/sub-tab the page
offers: POST /get_tab_data (the parser's JSON) and POST /load_tab (the rendered
fragment). Then it asserts that each panel came back non-empty and that every
planted finding (README.md) is present in the parsed data. Finally it streams
the Log Viewer over the journal's date range the way the tab does.

Not a *.test.* file on purpose: it needs the generated out/ tree and is run by
hand after generate.py. Exit 0 = all checks passed.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)

try:
    from flask import Flask
    import yaml
except ImportError:
    print("Run with the backend venv: backend/venv/bin/python tests/fixtures/diagnostics-mock/verify.py")
    sys.exit(1)

import log_viewer as lv  # noqa: E402

failures = []
passes = 0
# Tabs that answer 500 because of the PARSER, not the mock. Empty since the
# Security overview and the DPDK guard were added; kept so a regression is
# reported as "known" only when listed here deliberately.
KNOWN_PARSER_BUGS = set()
known = []


def check(label, ok, detail=""):
    global passes
    if ok:
        passes += 1
        print(f"  ok    {label}")
    else:
        failures.append(label)
        print(f"  FAIL  {label}" + (f": {detail}" if detail else ""))


def make_client():
    app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
    app.register_blueprint(lv.log_viewer)
    app.secret_key = "verify"
    return app.test_client()


def walk_tabs(client, report_type, directory):
    """Every (tab, sub_tab) the page would offer, with parsed data and fragment status."""
    r = client.post("/get_tabs", json={"report_type": report_type, "directory": directory})
    check(f"{report_type}: /get_tabs answers 200", r.status_code == 200, r.get_data(as_text=True)[:200])
    results = {}
    for tab in r.get_json()["tabs"]:
        combos = [(tab["tab_name"], None)] + [(tab["tab_name"], st["tab_name"]) for st in tab["sub_tabs"]]
        for t, st in combos:
            key = st or t
            payload = {"report_type": report_type, "directory": directory, "tab": t, "sub_tab": st}
            d = client.post("/get_tab_data", json=payload)
            h = client.post("/load_tab", json=payload)
            data = d.get_json().get("data") if d.status_code == 200 else None
            results[key] = {"data": data, "data_status": d.status_code, "html_status": h.status_code,
                            "error": (d.get_json() or {}).get("error") if d.status_code != 200 else (h.get_json() or {}).get("error") if h.status_code != 200 else None,
                            "html_len": len((h.get_json() or {}).get("html", "")) if h.status_code == 200 else 0}
    return results


def check_tabs(report_type, res):
    for key, r in res.items():
        ok = r["data_status"] == 200 and r["html_status"] == 200
        label = f"{report_type} tab '{key}' parses and renders (data {r['data_status']}, html {r['html_status']}, {r['html_len']} chars)"
        if not ok and (report_type, key) in KNOWN_PARSER_BUGS:
            known.append(f"{report_type}/{key}: {r['error']}")
            print(f"  known {label}: {r['error']} (parser bug, see KNOWN_PARSER_BUGS)")
            continue
        check(label, ok, r["error"] or "")


def verify_sosreport(client, directory):
    print(f"\n== sosreport: {directory}")
    res = walk_tabs(client, "sosreport", directory)
    check_tabs("sosreport", res)
    d = {k: v["data"] for k, v in res.items()}

    sysd = d["system"] or {}
    check("System: hostname web-01.example.test", sysd.get("hostnamectl", {}).get("Static hostname") == "web-01.example.test")
    check("System: kernel 5.14.0-427.13.1.el9_4", "5.14.0-427.13.1.el9_4" in sysd.get("hostnamectl", {}).get("Kernel", ""))
    check("System: 8 CPUs from lscpu", sysd.get("cpuinfo", {}).get("CPU(s)") == "8")
    la = sysd.get("uptime", {}).get("load_average", {})
    check("System: high load average 18.42 on 8 CPUs (planted)", la.get("1min") == 18.42, str(la))
    fm = sysd.get("free_memory", {})
    check("System: memory nearly exhausted (available ~2.3 GiB of 31)", fm.get("total", 0) > 30 and fm.get("available", 99) < 3, str(fm))

    procs = (d["processes"] or {}).get("ps_auxwwwm", {}).get("processes", [])
    check(f"Processes: {len(procs)} rows from ps auxwwwm incl. threads", len(procs) >= 25)
    check("Processes: example-worker pid 4311 at 88.6% CPU / 61.2% MEM (planted)",
          any(p["PID"] == "4311" and p["%CPU"] == "88.6" and p["%MEM"] == "61.2" for p in procs))
    zprocs = (d["processes"] or {}).get("ps_auxZww", {}).get("processes", [])
    check("Processes: ps auxZww carries SELinux labels (httpd_t)", any("httpd_t" in p.get("LABEL", "") for p in zprocs))

    pci = (d["pci_devices"] or {}).get("lspci", [])
    check(f"PCI Devices: {len(pci)} devices with class/vendor parsed", len(pci) >= 10 and all(dev.get("vendor_id") for dev in pci))

    dmi = (d["dmidecode"] or {}).get("dmidecode", [])
    psu = [e for e in dmi if e["type_lc"] == "system power supply"]
    # PSU2 says "Status: Present, Non-Critical" (dmidecode wording) -> WARN, not ERROR.
    check("System Information: 2 PSUs, PSU2 WARN (Non-Critical, planted)", len(psu) == 2 and psu[0]["status"] == "OK" and psu[1]["status"] == "WARN", str([e.get("status") for e in psu]))
    check("System Information: boot status OK, 2 of 4 DIMM slots populated",
          any(e["type_lc"] == "system boot information" and e["status"] == "OK" for e in dmi)
          and sum(1 for e in dmi if e["type_lc"] == "memory device" and e["summary_info"].get("Size")) == 2)

    sched = (d["sched_debug"] or {}).get("sched", {})
    percpu = sched.get("per_cpu", {})
    check(f"Scheduler Debug: {len(percpu)} CPUs parsed with runnable tasks", len(percpu) == 8 and all(c["tasks"] for c in percpu.values()))
    check("Scheduler Debug: example-worker running on cpu#3 with high wait time (planted)",
          any(t["name"] == "example-worker" and t["wait_time"] > 0.1 for t in percpu.get("3", {}).get("tasks", [])))

    units = (d["services"] or {}).get("systemctl", {}).get("units", [])
    names = {u["name"]: u for u in units}
    check(f"Services: {len(units)} units parsed", len(units) >= 20)
    check("Services: example-backup.service failed (planted)", names.get("example-backup.service", {}).get("active", "").startswith("failed"))
    check("Services: example-worker.service Tasks 4600 (limit: 5000) -> 92% (planted)", names.get("example-worker.service", {}).get("tasks") == "4600 (limit: 5000)")

    cst = d["cstates"] or {}
    check(f"C States: driver {cst.get('driver')!r}, {len(cst.get('cpus', {}))} CPUs, states {cst.get('state_names')}",
          cst.get("driver") == "intel_idle" and len(cst.get("cpus", {})) == 8 and cst.get("state_names", []) == ["POLL", "C1", "C1E", "C6"])

    ost = d["openstack"] or {}
    check("OpenStack: no rhosp-release -> tab renders N/A (host is not an overcloud node)", ost.get("rhosp_release") in ({}, None) and ost.get("hostnamectl"))

    lvm = (d["disk_lvm"] or {}).get("lvm", {})
    check("LVM: 2 VGs, 2 PVs, 7 LVs", (len(lvm.get("vgs", [])), len(lvm.get("pvs", [])), len(lvm.get("lvs", []))) == (2, 2, 7), str({k: len(v) for k, v in lvm.items()}))
    pool = next((lv for lv in lvm.get("lvs", []) if lv["LV"] == "pool00"), {})
    check("LVM: thin pool pool00 Data% 91.50 (planted)", pool.get("Data%") == "91.50", str(pool))

    df = (d["disk_usage"] or {}).get("df", {}).get("df", [])
    var = next((e for e in df if e.get("mounted") == "/var"), {})
    check("Disk Usage: /var at 94% (planted, red bar)", var.get("used_percent") == "94%", str(var))
    check("Disk Usage: / at 73% (yellow) and NFS /mnt/backup at 100%",
          any(e.get("mounted") == "/" and e.get("used_percent") == "73%" for e in df) and any(e.get("mounted") == "/mnt/backup" and e.get("used_percent") == "100%" for e in df))

    cg = (d["cgroups_cpu"] or {}).get("ps_auxwwwm", {})
    check("Control Groups CPU: cgroup v1 detected with system.slice tree", cg.get("cgroup_version") == "cgroup" and "system.slice" in cg.get("cgroup_data", {}))
    worker_cg = cg.get("cgroup_data", {}).get("system.slice", {}).get("example-worker.service", {})
    check("Control Groups CPU: example-worker.service has a CFS quota (600000/100000 = 6 cores) and 3 processes",
          worker_cg.get("cpu.cfs_quota_us") == "600000" and len(worker_cg.get("_processes", [])) == 3, str({k: v for k, v in worker_cg.items() if k != "_processes"}))
    cgm = (d["cgroups_memory"] or {})
    mem_worker = cgm.get("ps_auxwwwm", {}).get("cgroup_data", {}).get("system.slice", {}).get("example-worker.service", {})
    check("Control Groups Memory: example-worker.service at ~97% of its 24 GiB limit (planted)",
          96 < mem_worker.get("memory.usage_percent", 0) < 98, str(mem_worker.get("memory.usage_percent")))

    net = (d["network_stats"] or {}).get("ip_info", {})
    check("Network Interface Statistics: lo, eth0, eth1, eth2 parsed", set(net) == {"lo", "eth0", "eth1", "eth2"}, str(list(net)))
    check("Network Interface Statistics: eth1 RX errors 48213 / dropped 1203456, MTU 9000 (planted)",
          net.get("eth1", {}).get("RX", {}).get("errors") == 48213 and net.get("eth1", {}).get("RX", {}).get("dropped") == 1203456 and net.get("eth1", {}).get("MTU") == 9000)
    check("Network Interface Statistics: eth2 state DOWN", net.get("eth2", {}).get("State") == "DOWN")

    for sub, inner in (("sar_cpu", "all"), ("sar_memory", None), ("sar_network", "eth1"), ("sar_disk", "vdb")):
        sar = d[sub] or {}
        days = sorted(sar)
        ok = days == ["day_10", "day_11", "day_12"]
        if ok:
            day12 = sar["day_12"]
            series = day12 if inner is None else day12.get(inner, [])
            ok = len(series) >= 80
        check(f"SAR {sub}: three days (sar10-sar12), >=80 samples/day", ok, str(days))
    cpu12 = (d["sar_cpu"] or {}).get("day_12", {}).get("all", [])
    spike = [p for p in cpu12 if "09:00:01" <= p["time"] <= "11:00:01"]
    check("SAR CPU: 09:00-11:00 on day 12 is ~90% busy (planted)", spike and min(p["%usr"] for p in spike) > 60, str([p.get("%usr") for p in spike[:3]]))
    mem12 = (d["sar_memory"] or {}).get("day_12", [])
    check("SAR Memory: %memused climbs above 90 on day 12", any(p.get("%memused", 0) > 90 for p in mem12))
    disk12 = (d["sar_disk"] or {}).get("day_12", {}).get("vdb", [])
    check("SAR Disk: vdb await > 40ms during the spike (planted)", any(p.get("await", 0) > 40 for p in disk12))

    traces = (d["kernel_stack_traces"] or {}).get("stack_traces", {}).get("traces", [])
    check("Kernel Stack Traces: 1 WARNING from example_fastpath.c:412 on tainted kernel (planted)",
          len(traces) == 1 and traces[0]["file"] == "drivers/example/example_fastpath.c:412" and traces[0]["comm"] == "example-worker" and len(traces[0]["call_trace"]) >= 5, str(traces[:1])[:300])
    hung = (d["kernel_hung_task"] or {}).get("hung_tasks", [])
    check("Kernel Hung Tasks: example-worker:4311 blocked (122s and 245s, planted), pid/ppid from both the padded and the tight kernel line",
          len(hung) == 2 and all(h["details"]["pid"] == "4311" and h["details"]["ppid"] == "4200" and h["details"]["state"] == "D" for h in hung)
          and len(hung[0]["details"]["call_trace"]) >= 10, str([(h.get("task_line"), h["details"].get("ppid")) for h in hung]))
    oom = (d["kernel_oom_killer"] or {}).get("oom_killer", [])
    check("Kernel OOM Killer: 2 OOM kills of example-worker (planted)", len(oom) == 2 and all("Killed process" in b and "example-worker" in b for b in oom), str(len(oom)))

    lvd = d["log_viewer"] or {}
    logs = {l["name"]: l for l in lvd.get("available_logs", [])}
    check(f"Log Viewer: {len(logs)} log files listed, system journal first", "journalctl (system)" in logs and logs["journalctl (system)"]["type"] == "system")
    for expect in ("journalctl (boot)", "audit/audit.log", "dnf.log", "rhsm/rhsm.log", "example-app/app.log"):
        check(f"Log Viewer: lists {expect}", expect in logs, str(sorted(logs)))
    dr = lvd.get("date_range", {})
    check("Log Viewer: journal date range 2026-10-09 .. 2026-10-12", (dr.get("start") or "").startswith("2026-10-09") and (dr.get("end") or "").startswith("2026-10-12"), str(dr))
    check("Log Viewer: no unavailable logs", lvd.get("unavailable_logs") == [])

    # Stream the journal the way the tab does (full range), count severities and detected issues
    r = client.post("/parse_log_viewer_stream", json={"directory": directory, "start_date": dr.get("start"), "end_date": dr.get("end"),
                                                      "log_paths": [logs["journalctl (system)"]["path"]]})
    check("Log Viewer: /parse_log_viewer_stream answers 200", r.status_code == 200, r.get_data(as_text=True)[:200])
    entries, sev, issues, done = [], {}, {}, False
    for chunk in r.get_data(as_text=True).split("\n\n"):
        if not chunk.startswith("data: "):
            continue
        obj = json.loads(chunk[6:])
        if obj.get("done"):
            done = True
        for e in obj.get("entries", []):
            entries.append(e)
            sev[e["severity"]] = sev.get(e["severity"], 0) + 1
            for i in e.get("issues", []):
                issues[i] = issues.get(i, 0) + 1
    check(f"Log Viewer stream: {len(entries)} entries, done event received", done and len(entries) >= 2500, str(len(entries)))
    check(f"Log Viewer stream: every severity present {sev}", all(sev.get(s) for s in ("critical", "error", "warning", "info", "debug")))
    check(f"Log Viewer stream: issue detectors fire {issues}",
          all(issues.get(i) for i in ("oom_killer", "segfault", "disk_error", "network_error", "service_failed", "authentication_failure")))
    check("Log Viewer stream: entries sorted by time", all(a["timestamp_obj"] <= b["timestamp_obj"] for a, b in zip(entries, entries[1:]) if a["timestamp_obj"] and b["timestamp_obj"]))
    procs_seen = {e["process"] for e in entries}
    check("Log Viewer stream: processes sshd, kernel, example-worker, chronyd, setroubleshoot, httpd present", {"sshd", "kernel", "example-worker", "chronyd", "setroubleshoot", "httpd"} <= procs_seen, str(sorted(procs_seen)))
    # A narrow window: only day 11 09:00-10:00 should contain the kernel WARNING trace
    r = client.post("/parse_log_viewer_stream", json={"directory": directory, "start_date": "2026-10-11T09:00:00", "end_date": "2026-10-11T10:00:00",
                                                      "log_paths": [logs["journalctl (system)"]["path"]]})
    window = [e for chunk in r.get_data(as_text=True).split("\n\n") if chunk.startswith("data: ") for e in json.loads(chunk[6:]).get("entries", [])]
    check(f"Log Viewer stream: 1-hour window returns a slice ({len(window)} entries) incl. the WARNING trace",
          0 < len(window) < len(entries) and any("cut here" in e["message"] for e in window) and all(e["timestamp"].startswith("Oct 11 09") for e in window))
    # Other log formats stream too
    for name in ("audit/audit.log", "dnf.log", "rhsm/rhsm.log", "example-app/app.log"):
        r = client.post("/get_log_date_range", json={"directory": directory, "log_paths": [logs[name]["path"]]})
        rng = (r.get_json() or {}).get("date_range", {})
        r2 = client.post("/parse_log_viewer_stream", json={"directory": directory, "start_date": rng.get("start"), "end_date": rng.get("end"), "log_paths": [logs[name]["path"]]})
        n = sum(len(json.loads(c[6:]).get("entries", [])) for c in r2.get_data(as_text=True).split("\n\n") if c.startswith("data: "))
        check(f"Log Viewer: {name} has a date range and streams {n} entries", r.status_code == 200 and n > 10, str(rng))


def verify_mustgather(client, directory):
    print(f"\n== must-gather: {directory}")
    # Every YAML the generator wrote must load with PyYAML (the parsers' loader)
    bad = []
    n = 0
    for root, _, files in os.walk(directory):
        for f in files:
            if f.endswith(".yaml"):
                n += 1
                try:
                    with open(os.path.join(root, f)) as fh:
                        obj = yaml.safe_load(fh)
                    if not isinstance(obj, dict) or "kind" not in obj:
                        bad.append(f)
                except Exception as exc:
                    bad.append(f"{f}: {exc}")
    check(f"must-gather: all {n} YAML files load with yaml.safe_load and carry a kind", not bad, str(bad[:5]))

    res = walk_tabs(client, "mustgather", directory)
    check_tabs("mustgather", res)
    d = {k: v["data"] for k, v in res.items()}

    sysd = d["system"] or {}
    check("Cluster: version 4.16.12 on channel stable-4.16", sysd.get("cluster_version", {}).get("version") == "4.16.12" and sysd.get("cluster_version", {}).get("channel") == "stable-4.16", str(sysd.get("cluster_version")))
    check("Cluster: kubelet v1.29.8, OVNKubernetes, BareMetal, UPI", (sysd.get("kubernetes_version"), sysd.get("network_type"), sysd.get("platform"), sysd.get("install_method")) == ("v1.29.8+f10c92d", "OVNKubernetes", "BareMetal", "UPI"), str(sysd)[:300])
    check("Cluster: collection timestamps read from the top-level timestamp file", (sysd.get("collection_timestamps", {}).get("first") or "").startswith("2026-10-12 14:40:12"))
    check("Cluster: proxy configured (proxy.example.test:3128)", sysd.get("proxy_config", {}).get("configured") is True)
    ops = {o["metadata"]["name"]: o for o in sysd.get("cluster_operators", [])}

    def cstat(op, ctype):
        return next((c["status"] for c in ops.get(op, {}).get("status", {}).get("conditions", []) if c["type"] == ctype), None)
    check(f"Cluster: {len(ops)} cluster operators; monitoring Degraded=True (planted)", len(ops) == 19 and cstat("monitoring", "Degraded") == "True")
    check("Cluster: machine-config Progressing=True, others Available and not degraded",
          cstat("machine-config", "Progressing") == "True" and all(cstat(o, "Available") == "True" for o in ops) and sum(1 for o in ops if cstat(o, "Degraded") == "True") == 1)

    ev = d["events"] or {}
    total = sum(len(v) for v in ev.values())
    warnings = [e for v in ev.values() for e in v if e.get("type") == "Warning"]
    check(f"Events: {total} events across {len(ev)} namespaces, {len(warnings)} Warning", total >= 20 and len(warnings) >= 8, str({k: len(v) for k, v in ev.items()}))
    reasons = {e["reason"] for e in warnings}
    check("Events: BackOff, Unhealthy, NodeNotReady, SystemOOM, FailedUpdate, SlowRequest warnings (planted)", {"BackOff", "Unhealthy", "NodeNotReady", "SystemOOM", "FailedUpdate", "SlowRequest"} <= reasons, str(sorted(reasons)))

    al = d["alerts"] or {}
    firing = {a["name"] for a in al.get("firing", [])}
    check(f"Firing Alerts: {len(al.get('firing', []))} firing of {len(al.get('all', []))} rules", len(al.get("firing", [])) == 11 and len(al.get("all", [])) == 14, str(sorted(firing)))
    check("Firing Alerts: KubePodCrashLooping, KubeNodeNotReady, KubeletDown (critical), ClusterOperatorDegraded, etcdHighFsyncDurations, TargetDown",
          {"KubePodCrashLooping", "KubeNodeNotReady", "KubeletDown", "ClusterOperatorDegraded", "etcdHighFsyncDurations", "TargetDown"} <= firing)
    check("Firing Alerts: ages computed relative to the collection time (KubePodCrashLooping ~22s old eval)",
          all(0 <= a["age_seconds"] < 120 for a in al.get("firing", [])), str([a["age_seconds"] for a in al.get("firing", [])][:5]))

    nodes = d["nodes"] or {}

    def ready(n):
        return next((c["status"] for c in nodes.get(n, {}).get("status", {}).get("conditions", []) if c["type"] == "Ready"), None)
    check("Nodes: 5 nodes (3 control-plane, 2 workers)", len(nodes) == 5 and sum(1 for n in nodes.values() if "node-role.kubernetes.io/worker" in n["metadata"]["labels"]) == 2, str(sorted(nodes)))
    check("Nodes: worker-1 Ready=Unknown with unreachable taints (planted), others Ready=True",
          ready("worker-1") == "Unknown" and all(ready(n) == "True" for n in nodes if n != "worker-1") and nodes["worker-1"]["spec"].get("taints"))
    check("Nodes: InternalIP 10.0.0.x, kubelet v1.29.8, RHCOS osImage",
          all(any(a["type"] == "InternalIP" and a["address"].startswith("10.0.0.") for a in n["status"]["addresses"]) and n["status"]["nodeInfo"]["osImage"].startswith("Red Hat Enterprise Linux CoreOS") for n in nodes.values()))

    mcp = {m["name"]: m for m in (d["mcp"] or [])}
    check("Machine Config Pools: master Updated, worker Degraded with 1 degraded / 1 unavailable (planted)",
          mcp.get("master", {}).get("updated") == "True" and mcp.get("worker", {}).get("degraded") == "True" and mcp.get("worker", {}).get("degraded_machine_count") == 1 and mcp.get("worker", {}).get("unavailable_machine_count") == 1, str({k: (v.get("updated"), v.get("degraded")) for k, v in mcp.items()}))

    pods = d["pod"] or {}
    allpods = {name: p for ns in pods.values() for name, p in ns.items()}
    check(f"Pods: {len(allpods)} pods in {len(pods)} namespaces, ages computed", len(allpods) >= 18 and all("_age_seconds" in p for p in allpods.values()), str({k: len(v) for k, v in pods.items()}))
    crash = allpods.get("payments-worker-7b8c9d0e1-efghi", {})
    cs = crash.get("status", {}).get("containerStatuses", [{}])[0]
    check("Pods: payments-worker CrashLoopBackOff, 42 restarts, previous.log with traceback (planted)",
          cs.get("state", {}).get("waiting", {}).get("reason") == "CrashLoopBackOff" and cs.get("restartCount") == 42
          and os.path.getsize(os.path.join(directory, mock_image_dir(directory), "namespaces/payments-demo/pods/payments-worker-7b8c9d0e1-efghi/worker/worker/logs/previous.log")) > 500)
    oomp = allpods.get("payments-api-5f6d7c8b9-zabcd", {})
    cs = oomp.get("status", {}).get("containerStatuses", [{}])[0]
    check("Pods: payments-api-...-zabcd lastState OOMKilled (exit 137), 7 restarts (planted)",
          cs.get("lastState", {}).get("terminated", {}).get("reason") == "OOMKilled" and cs.get("lastState", {}).get("terminated", {}).get("exitCode") == 137 and cs.get("restartCount") == 7)
    notready = allpods.get("demo-web-7d9f8b6c5-klmno", {})
    check("Pods: demo-web-...-klmno on worker-1 is Running but Not Ready (planted)",
          notready.get("spec", {}).get("nodeName") == "worker-1" and notready.get("status", {}).get("phase") == "Running" and not notready["status"]["containerStatuses"][0]["ready"])
    for ns, pod_name, cont in (("demo-app", "demo-web-7d9f8b6c5-abcde", "web"), ("openshift-etcd", "etcd-master-0", "etcd")):
        p = os.path.join(directory, mock_image_dir(directory), f"namespaces/{ns}/pods/{pod_name}/{cont}/{cont}/logs/current.log")
        check(f"Pods: {ns}/{pod_name} has {cont} current.log in the must-gather layout", os.path.isfile(p) and os.path.getsize(p) > 100)

    dep = d["deployment"] or {}
    pw = dep.get("payments-demo", {}).get("payments-worker", {})
    check("Deployments: payments-worker 0/1 available, Progressing=False ProgressDeadlineExceeded (planted)",
          pw.get("status", {}).get("availableReplicas", 0) == 0 and any(c["type"] == "Progressing" and c["reason"] == "ProgressDeadlineExceeded" for c in pw.get("status", {}).get("conditions", [])), str(pw.get("status"))[:200])
    check("Deployments: demo-web 2/3 available (one replica on the NotReady node)", dep.get("demo-app", {}).get("demo-web", {}).get("status", {}).get("availableReplicas") == 2)
    rs = d["replicaset"] or {}
    check("Replica Sets: 4 replicasets across demo-app and payments-demo", sum(len(v) for v in rs.values()) == 4, str({k: list(v) for k, v in rs.items()}))
    ds = d["daemonset"] or {}
    ne = ds.get("openshift-monitoring", {}).get("node-exporter", {}).get("status", {})
    check("Daemon Sets: node-exporter desired 5, ready 4, unavailable 1 (planted)", (ne.get("desiredNumberScheduled"), ne.get("numberReady"), ne.get("numberUnavailable")) == (5, 4, 1), str(ne))
    ss = d["statefulset"] or {}
    pk = ss.get("openshift-monitoring", {}).get("prometheus-k8s", {}).get("status", {})
    check("Stateful Sets: prometheus-k8s 1/2 ready (planted), postgres-demo 1/1", pk.get("readyReplicas") == 1 and pk.get("replicas") == 2 and ss.get("payments-demo", {}).get("postgres-demo", {}).get("status", {}).get("readyReplicas") == 1)
    pdbs = d["pdb"] or {}
    pa = pdbs.get("payments-demo", {}).get("payments-api-pdb", {}).get("status", {})
    check("Pod Disruption Budgets: payments-api-pdb disruptionsAllowed 0 (planted), demo-web-pdb allows 1",
          pa.get("disruptionsAllowed") == 0 and pdbs.get("demo-app", {}).get("demo-web-pdb", {}).get("status", {}).get("disruptionsAllowed") == 1)

    csrs = d["csr"] or []
    pending = [c for c in csrs if c["status"] == "Pending"]
    check(f"CSRs: {len(csrs)} requests, 2 Pending for system:node:worker-1 (planted)", len(csrs) == 6 and len(pending) == 2 and all(c["username"] == "system:node:worker-1" for c in pending), str([(c["name"], c["status"]) for c in csrs]))
    tls = d["tls_secrets"] or []
    by_status = {}
    for s in tls:
        by_status.setdefault(s["status"], []).append(s["name"])
    check(f"TLS Secrets: {len(tls)} certificates - 1 Expired (thanos-querier-tls), 3 Expiring Soon, 3 Valid (planted)",
          by_status.get("Expired") == ["thanos-querier-tls"] and len(by_status.get("Expiring Soon", [])) == 3 and len(by_status.get("Valid", [])) == 3, str(by_status))
    check("TLS Secrets: node-exporter-tls has 20 days left (relative to collection time, not today)",
          any(s["name"] == "node-exporter-tls" and 19.9 < s["days_left"] < 20.1 for s in tls), str([(s["name"], round(s["days_left"], 1)) for s in tls]))


def mock_image_dir(directory):
    for e in os.listdir(directory):
        if e.startswith("quay-io") and os.path.isdir(os.path.join(directory, e)):
            return e
    return ""


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--large", action="store_true", help="also walk every tab of the --large sosreport (no finding checks)")
    args = ap.parse_args(argv)
    out = os.path.abspath(os.path.expanduser(args.out))
    sos = os.path.join(out, "sosreport-web-01-2026-10-13-abcdef")
    mg = os.path.join(out, "must-gather.local.1234567890")
    if not (os.path.isdir(sos) and os.path.isdir(mg)):
        print(f"Generate first: python3 {os.path.join(HERE, 'generate.py')}")
        return 1

    client = make_client()
    # The report list the page shows for this folder
    r = client.post("/list_reports", json={"directory": out})
    listed = {x["name"]: x["type"] for x in (r.get_json() or {}).get("reports", [])}
    print(f"== /list_reports for {out}")
    check("list_reports: both mocks are found with the right type", listed.get(os.path.basename(sos)) == "sosreport" and listed.get(os.path.basename(mg)) == "mustgather", str(listed))

    verify_sosreport(client, sos)
    verify_mustgather(client, mg)
    if args.large:
        large = os.path.join(out, "sosreport-web-02-2026-10-13-bigjrnl")
        if os.path.isdir(large):
            print(f"\n== large sosreport: {large}")
            import time
            t0 = time.time()
            res = walk_tabs(client, "sosreport", large)
            check_tabs("sosreport", res)
            lvd = res["log_viewer"]["data"]
            jpath = next(l["path"] for l in lvd["available_logs"] if l["type"] == "system")
            t1 = time.time()
            rr = client.post("/parse_log_viewer_stream", json={"directory": large, "start_date": lvd["date_range"]["start"], "end_date": lvd["date_range"]["end"], "log_paths": [jpath]})
            n = sum(len(json.loads(c[6:]).get("entries", [])) for c in rr.get_data(as_text=True).split("\n\n") if c.startswith("data: "))
            check(f"large: journal streams {n} entries in {time.time() - t1:.1f}s (all tabs parsed in {t1 - t0:.1f}s)", n >= 40000)
        else:
            print("(no --large sosreport generated; skipping)")

    print(f"\n{passes} checks passed, {len(failures)} failed, {len(known)} known parser bugs")
    for f in failures:
        print(f"  - {f}")
    for k in known:
        print(f"  known: {k}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
