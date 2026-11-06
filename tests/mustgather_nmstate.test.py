#!/usr/bin/env python3
"""
Network > Node Network Config (NNCP) of a must-gather (backend/parsers/mustgather/nmstate.py, the template
tabs/mustgather_nmstate.html, the group page parsers/mustgather/network.py), on synthetic objects and on the mock
must-gather (tests/fixtures/diagnostics-mock), through the real Flask blueprint:

 1. NodeNetworkConfigurationPolicy: the selector, the desired interfaces normalised (bond mode / options / ports,
    VLAN id and base, ovs-bridge / linux-bridge ports, MTU, ipv4 dhcp or static addresses, ipv6), the bridge
    membership (bond0 -> br-ex (ovs-bridge), eth1 -> bond0 (bond)), routes, DNS, the conditions.
 2. NodeNetworkConfigurationEnactment: node and policy from the labels, the state from the conditions (Available /
    Failing with its message / Progressing / Pending / Aborted / Not matching).
 3. NodeNetworkState: the current interfaces with the bond's active port, the bridge mappings.
 4. Desired vs actual: a missing interface, another type / state / MTU, another bond mode, missing or extra bond
    ports, missing bridge ports (an OVS bridge and its internal interface share a name: compared by type), a
    missing static address; a matching node has no mismatch.
 5. The mock: the Degraded policy, the failing enactment, worker-1's mismatches, worker-0 clean; the quiet gather is
    all good; a gather without nmstate -> the one no_data line; a namespaced placement is read too.
 6. Renders through /load_tab (the policies table with the condition badges, the enactments, the node states with
    the mismatch badges); the group page lists the tab's findings.

Needs the backend venv (Flask, PyYAML); run-all.sh picks it up as a .test.py.
"""
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
MOCK = os.path.join(HERE, "fixtures", "diagnostics-mock")
sys.path.insert(0, BACKEND)
sys.path.insert(0, MOCK)

import yaml  # noqa: E402
from flask import Flask  # noqa: E402

import log_viewer as lv  # noqa: E402
import mock_mustgather  # noqa: E402
from parsers.mustgather import nmstate  # noqa: E402

WORK = tempfile.mkdtemp(prefix="diag-nmstate-")
results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok)))
    print(("  ok    " if ok else "  FAIL  ") + label + (f": {detail}" if detail and not ok else ""))


def write_yaml(root, rel, obj):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        yaml.safe_dump(obj, f)


def client():
    app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
    app.register_blueprint(lv.log_viewer)
    app.secret_key = "diagnostics-nmstate-test"
    return app.test_client()


def render(c, directory, tab, sub_tab=None):
    body = {"directory": directory, "report_type": "mustgather", "tab": tab}
    if sub_tab:
        body["sub_tab"] = sub_tab
    r = c.post("/load_tab", json=body)
    return r.status_code, (r.get_json() or {}).get("html", "")


def policy(name, interfaces, degraded=False, routes=None, dns=None):
    return {"apiVersion": "nmstate.io/v1", "kind": "NodeNetworkConfigurationPolicy", "metadata": {"name": name},
            "spec": {"nodeSelector": {"node-role.kubernetes.io/worker": ""}, "desiredState": {"interfaces": interfaces, **({"routes": routes} if routes else {}), **({"dns-resolver": dns} if dns else {})}},
            "status": {"conditions": [{"type": "Available", "status": "False" if degraded else "True", "reason": "FailedToConfigure" if degraded else "SuccessfullyConfigured", "message": "1/2 nodes failed" if degraded else "ok"},
                                      {"type": "Degraded", "status": "True" if degraded else "False", "reason": "FailedToConfigure" if degraded else "", "message": "worker-1: failed to apply" if degraded else ""},
                                      {"type": "Progressing", "status": "False"}]}}


def main():
    bond = {"name": "bond0", "type": "bond", "state": "up", "mtu": 9000, "link-aggregation": {"mode": "active-backup", "port": ["eth1", "eth2"], "options": {"miimon": "100", "primary": "eth1"}}, "ipv4": {"enabled": False}}
    vlan = {"name": "bond0.100", "type": "vlan", "state": "up", "vlan": {"base-iface": "bond0", "id": 100}, "ipv4": {"enabled": True, "dhcp": False, "address": [{"ip": "198.51.100.121", "prefix-length": 24}]}, "ipv6": {"enabled": True, "autoconf": True, "dhcp": True}}
    brex = {"name": "br-ex", "type": "ovs-bridge", "state": "up", "bridge": {"options": {"stp": False}, "port": [{"name": "bond0"}, {"name": "br-ex"}]}}
    brex_if = {"name": "br-ex", "type": "ovs-interface", "state": "up", "mtu": 9000, "ipv4": {"enabled": True, "dhcp": False, "address": [{"ip": "203.0.113.21", "prefix-length": 24}]}}
    eth1 = {"name": "eth1", "type": "ethernet", "state": "up", "mtu": 9000}
    p = nmstate.parse_policy(policy("worker-net", [eth1, bond, vlan, brex, brex_if], routes={"config": [{"destination": "0.0.0.0/0", "next-hop-address": "198.51.100.1", "next-hop-interface": "bond0.100", "metric": 150}]},
                                     dns={"config": {"server": ["192.0.2.53"], "search": ["example.test"]}}))
    by = {(i["name"], i["type"]): i for i in p["interfaces"]}
    check("1. the policy: selector, five desired interfaces, the bond's mode / options / ports, the VLAN id and base, the OVS bridge's ports, the static address, ipv6 autoconf + dhcp",
          p["selector"] == {"node-role.kubernetes.io/worker": ""} and len(p["interfaces"]) == 5 and by[("bond0", "bond")]["bond"] == {"mode": "active-backup", "options": {"miimon": "100", "primary": "eth1"}, "ports": ["eth1", "eth2"]}
          and by[("bond0.100", "vlan")]["vlan"] == {"id": 100, "base": "bond0"} and by[("bond0.100", "vlan")]["ipv4"]["addresses"] == ["198.51.100.121/24"] and by[("bond0.100", "vlan")]["ipv6"]["autoconf"] and by[("br-ex", "ovs-bridge")]["bridge"]["ports"] == ["bond0", "br-ex"], json.dumps(p["interfaces"])[:400])
    check("1. the bridge membership: bond0 -> br-ex (ovs-bridge), the internal br-ex interface -> br-ex (ovs-bridge), eth1 -> bond0 (bond); routes and DNS",
          by[("bond0", "bond")]["member_of"] == "br-ex (ovs-bridge)" and by[("br-ex", "ovs-interface")]["member_of"] == "br-ex (ovs-bridge)" and by[("eth1", "ethernet")]["member_of"] == "bond0 (bond)" and by[("br-ex", "ovs-bridge")]["member_of"] == ""
          and p["routes"][0]["next_hop"] == "198.51.100.1" and p["dns"]["servers"] == ["192.0.2.53"], json.dumps([(i["name"], i["member_of"]) for i in p["interfaces"]]))
    check("1. the conditions", p["available"]["status"] == "True" and p["degraded"]["status"] == "False" and p["available"]["message"] == "ok")
    e = nmstate.parse_enactment({"kind": "NodeNetworkConfigurationEnactment", "metadata": {"name": "worker-1.worker-net", "labels": {"nmstate.io/node": "worker-1", "nmstate.io/policy": "worker-net"}},
                                 "status": {"conditions": [{"type": "Available", "status": "False"}, {"type": "Failing", "status": "True", "reason": "FailedToConfigure", "message": "ovs port bond0 not found"}, {"type": "Matching", "status": "True"}]}})
    check("2. an enactment: node and policy from the labels, Failing with its message (bad)", e["node"] == "worker-1" and e["policy"] == "worker-net" and e["state"] == "Failing" and e["kind"] == "bad" and e["message"] == "ovs port bond0 not found")
    e2 = nmstate.parse_enactment({"kind": "NodeNetworkConfigurationEnactment", "metadata": {"name": "worker-0.worker-net"}, "status": {"conditions": [{"type": "Available", "status": "True"}, {"type": "Failing", "status": "False"}]}})
    e3 = nmstate.parse_enactment({"kind": "NodeNetworkConfigurationEnactment", "metadata": {"name": "master-0.worker-net"}, "status": {"conditions": [{"type": "Matching", "status": "False"}]}})
    check("2. ...Available (good) from the name alone; a node the selector does not match reads Not matching", e2["node"] == "worker-0" and e2["kind"] == "good" and e3["state"] == "Not matching" and e3["kind"] == "muted")
    actual_ifaces = [dict(eth1), dict(bond, **{"link-aggregation": {"mode": "active-backup", "port": ["eth1", "eth2"], "options": {"miimon": "100", "primary": "eth1"}, "active-port": "eth2"}}), dict(vlan), dict(brex), dict(brex_if)]
    s_ok = nmstate.parse_node_state({"kind": "NodeNetworkState", "metadata": {"name": "worker-0"}, "status": {"currentState": {"interfaces": actual_ifaces, "ovn": {"bridge-mappings": [{"localnet": "physnet", "bridge": "br-ex"}]}}}})
    check("3. a node state: the interfaces, the bond's active port eth2, the bridge mapping physnet -> br-ex", len(s_ok["interfaces"]) == 5 and next(i for i in s_ok["interfaces"] if i["type"] == "bond")["bond_active"] == "eth2" and s_ok["bridge_mappings_text"] == "physnet -> br-ex")
    actual = nmstate.actual_index(s_ok["interfaces"])
    texts = lambda rows: [r["text"] for r in rows]  # noqa: E731
    check("4. a node as desired: no mismatch for any interface (the OVS bridge and its internal interface told apart by type)", all(nmstate.compare(d, actual) == [] for d in p["interfaces"]), json.dumps([nmstate.compare(d, actual) for d in p["interfaces"]]))
    broken = [dict(eth1, mtu=1500), dict(bond, mtu=1500, **{"link-aggregation": {"mode": "balance-rr", "port": ["eth1"], "options": {"miimon": "100", "primary": "eth1"}}}),
              dict(vlan, vlan={"base-iface": "bond0", "id": 200}, ipv4={"enabled": True, "dhcp": False, "address": [{"ip": "198.51.100.122", "prefix-length": 24}]}), {"name": "br-ex", "type": "ovs-bridge", "state": "up", "bridge": {"port": [{"name": "br-ex"}]}}]
    bad_actual = nmstate.actual_index(nmstate.parse_node_state({"kind": "NodeNetworkState", "metadata": {"name": "worker-1"}, "status": {"currentState": {"interfaces": broken}}})["interfaces"])
    mism = {d["name"] + "/" + d["type"]: texts(nmstate.compare(d, bad_actual)) for d in p["interfaces"]}
    rows = {d["name"] + "/" + d["type"]: nmstate.compare(d, bad_actual) for d in p["interfaces"]}
    check("4. the mismatches: MTU, bond mode and a missing bond port, VLAN id and a static address, the bridge missing its bond0 port, the internal interface missing",
          mism["eth1/ethernet"] == ["eth1: MTU 9000 desired, 1500 actual"] and "bond0: bond mode active-backup desired, balance-rr actual" in mism["bond0/bond"] and "bond0: bond ports missing eth2" in mism["bond0/bond"]
          and any("VLAN id 100 desired, 200 actual" in m for m in mism["bond0.100/vlan"]) and any("198.51.100.121/24 desired" in m for m in mism["bond0.100/vlan"]) and mism["br-ex/ovs-bridge"] == ["br-ex: bridge ports missing bond0"]
          and mism["br-ex/ovs-interface"] == ["br-ex (ovs-interface) is missing"], json.dumps(mism))
    check("4. ...as rows: the setting, the kind and the two values side by side (MTU differs 9000 / 1500; the bond port eth2 missing on the node; the bridge port bond0 missing)",
          rows["eth1/ethernet"][0] == {"iface": "eth1", "setting": "MTU", "kind": "differs", "desired": "9000", "actual": "1500", "text": "eth1: MTU 9000 desired, 1500 actual"}
          and {"iface": "bond0", "setting": "bond port", "kind": "missing", "desired": "eth2", "actual": "", "text": "bond0: bond ports missing eth2"} in rows["bond0/bond"]
          and rows["br-ex/ovs-bridge"][0]["kind"] == "missing" and rows["br-ex/ovs-bridge"][0]["desired"] == "bond0" and rows["br-ex/ovs-interface"][0]["kind"] == "missing", json.dumps(rows))
    check("4. an interface desired absent that exists is a mismatch (unexpected); one desired absent and gone is not", texts(nmstate.compare({"name": "eth1", "type": "ethernet", "state": "absent"}, actual)) == ["eth1 should be absent but exists"]
          and nmstate.compare({"name": "eth1", "type": "ethernet", "state": "absent"}, actual)[0]["kind"] == "unexpected" and nmstate.compare({"name": "eth9", "type": "ethernet", "state": "absent"}, actual) == [])
    # OVN-managed ports on an OVS bridge: never a mismatch
    check("4. OVN classification: by name (patch-*-to-br-int, patch-br-int-to-*, *_ovn_localnet_port*, br-int, genev_sys_*, ovn-k8s-mp*, ovs-system), by type (a patch port with a peer), not an ordinary port",
          all(nmstate.is_ovn_managed(n) for n in ("patch-br-vm_worker-0-to-br-int", "patch-br-int-to-br-vm_worker-0", "patch-localnet.vlan.br-vm.100.1_ovn_localnet_port-to-br-int", "br-int", "genev_sys_6081", "ovn-k8s-mp0", "ovs-system"))
          and nmstate.is_ovn_managed("odd-name", {"patch": "patch-br-int-to-odd"}) and nmstate.is_ovn_managed("odd-name", {"type": "patch"}) and not nmstate.is_ovn_managed("eth4") and not nmstate.is_ovn_managed("eth4", {"type": "ethernet", "patch": ""}))
    localnet = {"name": "br-vm", "type": "ovs-bridge", "state": "up", "bridge": {"port": [{"name": "br-vm"}, {"name": "eth4"}, {"name": "patch-localnet.vlan.br-vm.100.1_ovn_localnet_port-to-br-int"}, {"name": "patch-localnet.vlan.br-vm.704.1_ovn_localnet_port-to-br-int"}, {"name": "patch-br-vm_w0-to-br-int"}, {"name": "typed-patch"}]}}
    typed_patch = {"name": "typed-patch", "type": "ovs-interface", "state": "up", "patch": {"peer": "patch-br-int-to-typed"}}
    ln_state = nmstate.parse_node_state({"kind": "NodeNetworkState", "metadata": {"name": "w0"}, "status": {"currentState": {"interfaces": [localnet, typed_patch, {"name": "eth4", "type": "ethernet", "state": "up"}, {"name": "br-int", "type": "ovs-bridge", "state": "up", "bridge": {"port": [{"name": "br-int"}, {"name": "genev_sys_6081"}]}}, {"name": "ovn-k8s-mp0", "type": "ovs-interface", "state": "up", "ipv4": {"enabled": True, "address": [{"ip": "10.128.2.2", "prefix-length": 23}]}}]}}})
    ln_actual = nmstate.actual_index(ln_state["interfaces"])
    ln_rows = nmstate.compare({"name": "br-vm", "type": "ovs-bridge", "state": "up", "bridge": {"port": [{"name": "eth3"}, {"name": "br-vm"}]}} | {} if False else nmstate.normalize_interface({"name": "br-vm", "type": "ovs-bridge", "state": "up", "bridge": {"port": [{"name": "eth3"}, {"name": "br-vm"}]}}), ln_actual)
    check("4. a localnet bridge: the OVN patch ports (three by name, one by its type) are no mismatch; the missing eth3 and the unexpected eth4 are",
          [(r["setting"], r["kind"], r["desired"], r["actual"]) for r in ln_rows] == [("bridge port", "missing", "eth3", ""), ("bridge port", "unexpected", "", "eth4")], json.dumps(ln_rows))
    check("4. the node lists its OVN-managed ports apart (bridge, port, peer); br-int / genev_sys / ovn-k8s-mp0, named by no policy, raise nothing",
          [(o["bridge"], o["port"]) for o in nmstate.ovn_ports(ln_state["interfaces"])] == [("br-vm", "patch-localnet.vlan.br-vm.100.1_ovn_localnet_port-to-br-int"), ("br-vm", "patch-localnet.vlan.br-vm.704.1_ovn_localnet_port-to-br-int"), ("br-vm", "patch-br-vm_w0-to-br-int"), ("br-vm", "typed-patch"), ("br-int", "genev_sys_6081")]
          and next(o for o in nmstate.ovn_ports(ln_state["interfaces"]) if o["port"] == "typed-patch")["peer"] == "patch-br-int-to-typed", json.dumps(nmstate.ovn_ports(ln_state["interfaces"])))

    # 5 + 6. the mock must-gather ------------------------------------------------------------
    mock = os.path.join(WORK, "must-gather.local.1234567890")
    mock_mustgather.build(mock)
    r = nmstate.parse(mock)
    sev_titles = [(f["severity"], f["title"]) for f in r["findings"]]
    check("5. the mock: three policies for the workers, worker-br-ex Degraded first; worker-1's br-ex enactment Failing; 6 enactments, 2 node states",
          [p["name"] for p in r["policies"]] == ["worker-br-ex", "worker-bond0", "worker-br-vm"] and r["policies"][0]["degraded"]["status"] == "True" and [(e["node"], e["policy"], e["state"]) for e in r["enactments"]][0] == ("worker-1", "worker-br-ex", "Failing") and len(r["enactments"]) == 6 and len(r["nodes"]) == 2, json.dumps(sev_titles))
    w1 = next(n for n in r["nodes"] if n["node"] == "worker-1")
    w0 = next(n for n in r["nodes"] if n["node"] == "worker-0")
    check("5. worker-1 mismatches the three policies (MTU 1500 on bond0 / eth1 / eth2, the VLAN address, br-ex missing its bond0 port, the br-ex address; br-vm missing eth3 with eth4 unexpected); worker-0 matches although its br-vm carries OVN's patch ports",
          [m["policy"] for m in w1["mismatches"]] == ["worker-bond0", "worker-br-ex", "worker-br-vm"] and any("bond0: MTU 9000 desired, 1500 actual" in m["lines"] for m in w1["mismatches"]) and any("br-ex: bridge ports missing bond0" in m["lines"] for m in w1["mismatches"])
          and next(m for m in w1["mismatches"] if m["policy"] == "worker-br-vm")["lines"] == ["br-vm: bridge ports missing eth3", "br-vm: bridge ports extra eth4"] and w0["mismatches"] == [] and len(w0["ovn_ports"]) == 7 and len(w1["ovn_ports"]) == 7
          and r["policies"][1]["mismatch_counts"] == {"worker-1": 4} and r["policies"][2]["mismatch_counts"] == {"worker-1": 2}, json.dumps([(m["policy"], m["lines"]) for m in w1["mismatches"]]))
    check("5. the findings: the Degraded policy (bad), the Failing enactment (bad), worker-1's three mismatch lines (warn), nothing for worker-0 and nothing about OVN's ports",
          sev_titles[:2] == [("bad", "Policy worker-br-ex is Degraded"), ("bad", "worker-1: enactment of worker-br-ex is Failing")] and [t for s, t in sev_titles if s == "warn"] == ["worker-1: the actual state differs from policy worker-bond0", "worker-1: the actual state differs from policy worker-br-ex", "worker-1: the actual state differs from policy worker-br-vm"]
          and not any("ovn_localnet" in f["detail"] or "patch-" in f["detail"] for f in r["findings"]), json.dumps(sev_titles))
    quiet = os.path.join(WORK, "must-gather.local.9876543210")
    mock_mustgather.build(quiet, quiet=True)
    rq = nmstate.parse(quiet)
    check("5. the quiet gather: one good line, no mismatch (OVN's patch ports on br-vm included)", [(f["severity"], f["title"]) for f in rq["findings"]] == [("good", "3 policies Available on 2 nodes, the actual state matches")], json.dumps([(f["severity"], f["title"]) for f in rq["findings"]]))
    empty = os.path.join(WORK, "must-gather.local.0000000000")
    os.makedirs(os.path.join(empty, "cluster-scoped-resources", "core", "nodes"), exist_ok=True)
    re_ = nmstate.parse(empty)
    check("5. a gather without nmstate: not present, the one no_data line naming where it looked", not re_["present"] and len(re_["findings"]) == 1 and re_["findings"][0]["title"] == "No nmstate data in this must-gather" and "nmstate.io" in re_["findings"][0]["detail"], json.dumps(re_["findings"]))
    ns_dir = os.path.join(WORK, "must-gather.local.5555555555")
    write_yaml(ns_dir, "namespaces/openshift-nmstate/nmstate.io/nodenetworkconfigurationpolicies/policies.yaml", {"apiVersion": "v1", "kind": "List", "items": [policy("ns-policy", [eth1])]})
    rn = nmstate.parse(ns_dir)
    check("5. objects under namespaces/openshift-nmstate (a List file) are read too", [p["name"] for p in rn["policies"]] == ["ns-policy"] and rn["present"])
    c = client()
    status, html = render(c, mock, "network", "nmstate")
    check("6. the mock renders (200): the Findings strip first, the policies with their condition badges, the Degraded message, the enactments table with the failing row, the node states as a table with the mismatch badges, the bonds / bridges columns and the bridge mapping in the panel",
          status == 200 and html.index('class="ui-findings"') < html.index("nn-policies") and "worker-br-ex" in html and ">Degraded<" in html and "ovs port bond0 not found" in html and "nn-enactments" in html and "ui-row-bad" in html
          and html.count('data-nn-table="nn-nodes"') == 2 and ">8 mismatches<" in html and ">matches<" in html and "bond0 <span class=\"ui-muted\">active-backup, active eth2</span>" in html and "br-ex <span class=\"ui-muted\">ovs-bridge</span>" in html
          and "br-ex: bridge ports missing bond0" in html and "physnet -&gt; br-ex" in html and "active</span> <span class=\"ui-mono\">eth2</span>" in html and "Showing" not in html.split('id="nn-nodes"')[0].split('NodeNetworkState')[-1], html[:300] if status != 200 else "")
    check("6. the mismatches read as rows: a count badge per node in the policy row, and in the node panel the setting, the kind and the desired / actual values side by side, grouped by policy; the hint; the OVN ports apart and collapsed; the toggle",
          ">4 mismatches on worker-1<" in html and ">2 mismatches on worker-1<" in html and html.count('class="ui-nested nn-mismatches"') == 3 and ">MTU<" in html and ">bridge port<" in html and ">differs<" in html and ">missing on the node<" in html and ">unexpected on the node<" in html
          and '<td class="ui-mono ui-text" title="9000">9000</td>' in html and ">1500</span>" in html and ">not desired<" in html and "Desired = the NNCP&#39;s desiredState; Actual = the node&#39;s NodeNetworkState; OVN-managed ports are not counted" in html
          and html.count("OVN patch ports, managed by ovn-controller") == 2 and "<details class=\"ui-details nn-ovn\">" in html and 'id="nn-only-mismatch"' in html and 'data-mismatches="8"' in html and 'data-mismatches="0"' in html
          and "patch-localnet.vlan.br-vm.704.1_ovn_localnet_port-to-br-int" in html and "ovn_localnet" not in html.split('class="ui-nested nn-mismatches"')[1].split('</table>')[0], "")
    check("6. the tables sort by their headers (data-key), each with its own Expand all, one search over the page; a Finding's Open query (a node name) lands on the node row (data-nn-key)",
          'data-table="#nn-policies"' in html and 'data-table="#nn-nodes"' in html and html.count('data-ui-search') == 1 and 'data-key="node"' in html and 'data-nn-key="worker-1"' in html and "landed()" in html and all(f["link"]["query"] in ("worker-1", "worker-br-ex") for f in r["findings"] if f.get("link")), "")
    check("6. the desired interfaces show their bridge membership and the bond's ports", "br-ex (ovs-bridge)" in html and "bond0 (bond)" in html and "ports</span> <span class=\"ui-mono\">eth1, eth2</span>" in html)
    status2, html2 = render(c, mock, "network")
    check("6. the group page lists the tab's findings, linked to it", status2 == 200 and "nmstate: Policy worker-br-ex is Degraded" in html2 and 'data-sub-tab="nmstate"' in html2)
    status3, html3 = render(c, empty, "network", "nmstate")
    check("6. a gather without nmstate renders (200) with the one note and no table", status3 == 200 and "No nmstate data" in html3 and "<table" not in html3)

    failed = [l for l, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    shutil.rmtree(WORK, ignore_errors=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
