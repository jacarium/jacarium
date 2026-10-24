#!/usr/bin/env python3
"""
The OpenStack group's Findings (Phase 2, group 3 of the diagnostics review):
Pacemaker, HAProxy and DPDK on synthetic captures, parsed and rendered
through the real Flask blueprint.

 1. Pacemaker: pcs 0.10 status (bulleted node list, a node UNCLEAN, one in
    standby, a stopped resource, a failed action, quorum lost, fencing
    disabled, a fence history entry) and pcs 0.9 status (RHEL 7: bare
    "Online:" / "OFFLINE:" lines, resources without bullets, "Failed
    Actions:"); the findings with their links to the Log Viewer.
 2. HAProxy: a plain host's var/log/haproxy.log found (the container
    directory missing), a backend without a server, a server DOWN and a
    backend with no server in the log, the 5xx share, the termination
    states; the on-demand route serves the same directory.
 3. DPDK: a PMD thread at 95% busy, a receive queue at 85% of its PMD, an
    idle PMD; no captures -> the informational line.
 4. The three pages render the strip.

Needs the backend venv (Flask); run-all.sh picks it up as a .test.py.
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)

from flask import Flask  # noqa: E402

import log_viewer as lv  # noqa: E402
from parsers.sosreport import haproxy, openstack_dpdk, pacemaker  # noqa: E402

WORK = tempfile.mkdtemp(prefix="diag-findings3-")
results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok)))
    print(("  ok    " if ok else "  FAIL  ") + label + (f": {detail}" if detail and not ok else ""))


def write(root, rel, body):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(body)


def client():
    app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
    app.register_blueprint(lv.log_viewer)
    app.secret_key = "diagnostics-findings3-test"
    return app.test_client()


def titles(items):
    return [f["title"] for f in items]


def sev(items, s):
    return [f for f in items if f["severity"] == s]


PCS10 = """Cluster name: overcloud
Cluster Summary:
  * Stack: corosync
  * Current DC: controller-0 (version 2.1.5) - partition WITHOUT quorum
  * 3 nodes configured
  * 4 resource instances configured

Node List:
  * Node controller-2: UNCLEAN (offline)
  * Node controller-1: standby
  * Online: [ controller-0 ]

Full List of Resources:
  * ip-192.0.2.10	(ocf::heartbeat:IPaddr2):	 Started controller-0
  * openstack-cinder-volume	(systemd:openstack-cinder-volume):	 Stopped
  * Clone Set: haproxy-clone [haproxy]:
    * Started: [ controller-0 ]

Failed Resource Actions:
  * openstack-cinder-volume_start_0 on controller-0 'not running' (7): call=42, status='complete', exitreason='', last-rc-change='2026-10-12 02:00:07Z', queued=0ms, exec=2001ms

Daemon Status:
  corosync: active/enabled
  pacemaker: active/enabled
  pcsd: active/enabled
"""

PCS9 = """Cluster name: rhel7
Stack: corosync
Current DC: node1 (version 1.1.23) - partition with quorum
Last updated: Mon Oct 12 14:30:01 2026

3 nodes configured
3 resources configured

Online: [ node1 node2 ]
OFFLINE: [ node3 ]

Full list of resources:

 vip	(ocf::heartbeat:IPaddr2):	Started node1
 Clone Set: dlm-clone [dlm]
     Started: [ node1 node2 ]
 fs	(ocf::heartbeat:Filesystem):	Stopped

Failed Actions:
* fs_start_0 on node2 'unknown error' (1): call=20, status=complete, exitreason='Couldn't mount device',
    last-rc-change='Mon Oct 12 14:00:00 2026', queued=0ms, exec=50ms

Daemon Status:
  corosync: active/enabled
"""


def main():
    # 1. Pacemaker ----------------------------------------------------------------
    root = os.path.join(WORK, "sosreport-pcs10")
    os.makedirs(os.path.join(root, "sos_commands"), exist_ok=True)
    write(root, "sos_commands/pacemaker/pcs_status_--full", PCS10)
    write(root, "sos_commands/pacemaker/pcs_quorum_status", "Quorum information\n------------------\nNodes:            3\nQuorate:          No\n\nVotequorum information\nExpected votes:   3\nTotal votes:      1\n")
    write(root, "sos_commands/pacemaker/pcs_config", "Cluster Name: overcloud\nCluster Properties:\n cluster-infrastructure: corosync\n stonith-enabled: false\nResources:\n Resource: ip-192.0.2.10 (class=ocf provider=heartbeat type=IPaddr2)\n  Attributes: ip=192.0.2.10\n")
    write(root, "sos_commands/pacemaker/pcs_stonith_history_show", "controller-2 was fenced by controller-0 at Mon Oct 12 02:00:00 2026\n")
    r = pacemaker.parse(root)
    f = r["findings"]
    st = r["status"]
    check("pacemaker 0.10: the bulleted node list is read (controller-2 unclean, controller-1 standby, controller-0 online) and the resources with the stopped one",
          {n["name"]: n["status"] for n in st["nodes"]} == {"controller-2": "unclean", "controller-1": "standby", "controller-0": "online"} and any(x["name"] == "openstack-cinder-volume" and x["status"] == "Stopped" for x in st["resources"]), repr(st["nodes"]))
    check("pacemaker 0.10: the unclean node, the stopped resource, the failed action and the lost quorum are bad (linked to the Log Viewer with the resource's name), standby / fencing disabled / fence history are warnings",
          any("controller-2 is unclean" in t for t in titles(sev(f, "bad"))) and any("openstack-cinder-volume is Stopped" in t and x["link"]["query"] == "openstack-cinder-volume" for t, x in zip(titles(f), f))
          and any("start_0 failed on controller-0" in t for t in titles(sev(f, "bad"))) and any("no quorum" in t for t in titles(sev(f, "bad")))
          and any("controller-1 is in standby" in t for t in titles(sev(f, "warn"))) and any("Fencing is disabled" in t for t in titles(sev(f, "warn"))) and any("Fencing history has 1 entry" == t for t in titles(sev(f, "warn"))), titles(f))
    old = os.path.join(WORK, "sosreport-pcs9")
    os.makedirs(os.path.join(old, "sos_commands"), exist_ok=True)
    write(old, "sos_commands/pacemaker/pcs_status_--full", PCS9)
    r = pacemaker.parse(old)
    st = r["status"]
    check("pacemaker 0.9 (RHEL 7): the uppercase OFFLINE line, the resources without bullets and the Failed Actions parse; node3 offline and fs stopped are bad",
          {n["name"]: n["status"] for n in st["nodes"]} == {"node1": "online", "node2": "online", "node3": "offline"} and [x["name"] for x in st["resources"]][:3] == ["vip", "dlm-clone", "fs"]
          and st["failures"][0]["resource"] == "fs" and any("Node node3 is offline" == t for t in titles(sev(r["findings"], "bad"))) and any("Resource fs is Stopped" == t for t in titles(sev(r["findings"], "bad"))), repr((st["nodes"], [x["name"] for x in st["resources"]], titles(r["findings"]))))
    bare = os.path.join(WORK, "bare")
    os.makedirs(os.path.join(bare, "sos_commands"), exist_ok=True)
    check("pacemaker: a report without captures says so (info)", pacemaker.parse(bare)["findings"][0]["severity"] == "info")

    # 2. HAProxy ----------------------------------------------------------------
    hp = os.path.join(WORK, "sosreport-haproxy")
    os.makedirs(os.path.join(hp, "sos_commands"), exist_ok=True)
    write(hp, "date", "Mon Oct 12 14:30:01 UTC 2026\n")
    write(hp, "etc/haproxy/haproxy.cfg", "global\n    log 127.0.0.1 local0\n\ndefaults\n    mode http\n\nfrontend web\n    bind *:80\n    default_backend app\n\nbackend app\n    balance roundrobin\n    server app1 10.0.0.1:8080 check\n    server app2 10.0.0.2:8080 check\n\nbackend empty\n    balance roundrobin\n")
    lines = ["Oct 12 10:00:01 host haproxy[1234]: Server app/app2 is DOWN, reason: Layer4 timeout, check duration: 2001ms. 1 active and 0 backup servers left.",
             "Oct 12 10:00:02 host haproxy[1234]: backend empty has no server available!"]
    for i in range(100):
        code = 503 if i < 30 else 200
        term = "SC" if code == 503 else "--"
        lines.append(f"Oct 12 10:{i // 60:02d}:{i % 60:02d}.000 host haproxy[1234]: 10.0.0.9:50000 [12/Oct/2026:10:00:{i % 60:02d}.000] web app/app1 0/0/1/2/3 {code} 1000 - - {term}-- 1/1/0/0/0 0/0 \"GET / HTTP/1.1\"")
    write(hp, "var/log/haproxy.log", "\n".join(lines) + "\n")
    r = haproxy.parse(hp)
    f = r["findings"]
    check("haproxy: the plain host's var/log/haproxy.log is found (no container directory)", r.get("log_files") == ["haproxy.log"] and haproxy.haproxy_log_dir(hp) == os.path.join(hp, "var/log"), repr(r.get("log_files")))
    check("haproxy: the backend without a server (config) and the backend with no server left (log) are bad, the server DOWN and the 30% 5xx share are flagged, the SC terminations noted",
          any("Backend empty has no server" == t for t in titles(sev(f, "bad"))) and any("Backend empty had no server available" == t for t in titles(sev(f, "bad")))
          and any("1 server went DOWN" == t for t in titles(f)) and any("30.0% of the answers were 5xx (30 of 100)" == t for t in titles(sev(f, "bad"))) and any("sessions ended abnormally" in t and "SC: 30" in x["detail"] for t, x in zip(titles(f), f)), titles(f))
    c = client()
    rr = c.post("/parse_haproxy_log", json={"directory": hp, "log_file": "haproxy.log"})
    check("haproxy: the on-demand route finds the same directory and dates the lines with the report's year", rr.status_code == 200 and "2026" in str(rr.get_json()["data"]["timestamps"][0]), f"{rr.status_code} {str(rr.get_json())[:120]}")

    # 3. DPDK -------------------------------------------------------------------
    dp = os.path.join(WORK, "sosreport-dpdk")
    os.makedirs(os.path.join(dp, "sos_commands"), exist_ok=True)
    write(dp, "proc/cmdline", "BOOT_IMAGE=/vmlinuz isolcpus=2-7 hugepagesz=1G hugepages=16\n")
    write(dp, "sos_commands/openvswitch/ovs-vsctl_-t_5_get_Open_vSwitch_._other_config", '{dpdk-init="true", pmd-cpu-mask="0xfc"}\n')
    write(dp, "sos_commands/openvswitch/ovs-appctl_dpif-netdev.pmd-stats-show", (
        "pmd thread numa_id 0 core_id 2:\n  packets received: 123456789\n  packet recirculations: 0\n  avg. datapath passes per packet: 1.00\n  idle cycles: 50000 (5.00%)\n  processing cycles: 950000 (95.00%)\n  avg cycles per packet: 100.00 (1000000/10000)\n\n"
        "pmd thread numa_id 0 core_id 3:\n  packets received: 1000\n  idle cycles: 900000 (90.00%)\n  processing cycles: 100000 (10.00%)\n\n"
        "pmd thread numa_id 1 core_id 4:\n  packets received: 0\n  idle cycles: 1000000 (100.00%)\n  processing cycles: 0 (0.00%)\n\nmain thread:\n  packets received: 0\n"))
    write(dp, "sos_commands/openvswitch/ovs-appctl_dpif-netdev.pmd-rxq-show", (
        "pmd thread numa_id 0 core_id 2:\n  isolated : false\n  port: dpdk0             queue-id:  0 (enabled)   pmd usage: 85 %\n  port: vhu1              queue-id:  0 (enabled)   pmd usage: 10 %\n  overhead:  5 %\n"
        "pmd thread numa_id 0 core_id 3:\n  isolated : false\n  port: dpdk1             queue-id:  0 (enabled)   pmd usage: 10 %\n  overhead:  0 %\n"
        "pmd thread numa_id 1 core_id 4:\n  isolated : false\n  overhead:  0 %\n"))
    r = openstack_dpdk.parse(dp)
    f = r["findings"]
    check("dpdk: the PMD at 95% busy (warn), the dpdk0 queue at 85% of its PMD, the idle PMD on numa 1",
          any("1 PMD thread over 90% busy" == t and "core 2: 95%" in x["detail"] for t, x in zip(titles(f), f)) and any("1 receive queue over 80% of a PMD" == t and "dpdk0 q0: 85%" in x["detail"] for t, x in zip(titles(f), f))
          and any("1 PMD thread with no receive queue" == t for t in titles(f)), titles(f))
    check("dpdk: a report without OVS captures gives the informational line", openstack_dpdk.parse(bare)["findings"][0]["severity"] == "info")

    # 4. the pages -----------------------------------------------------------------
    for directory, tab, sub in ((root, "openstack", "pacemaker"), (hp, "openstack", "haproxy"), (dp, "openstack", "openstack_dpdk")):
        rr = c.post("/load_tab", json={"directory": directory, "report_type": "sosreport", "tab": tab, "sub_tab": sub})
        html = (rr.get_json() or {}).get("html", "")
        check(f"page {sub}: renders with the Findings strip", rr.status_code == 200 and 'class="ui-findings"' in html and html.count('class="ui-finding ') >= 1, f"status {rr.status_code}")

    shutil.rmtree(WORK, ignore_errors=True)
    failed = [l for l, ok in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
