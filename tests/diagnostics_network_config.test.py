#!/usr/bin/env python3
"""
Network > Network Configuration (backend/parsers/sosreport/network_config.py, the template
tabs/sosreport_network_config.html, the extended bonding parser in network_stats.py), on synthetic inputs and on
the mock sosreport (tests/fixtures/diagnostics-mock), through the real Flask blueprint:

 1. proc/net/bonding: an active-backup bond with its primary and the currently active slave (the roles
    primary / secondary, the active mark, a failover), MII polling and delays, per slave MII / speed / duplex /
    failures / permanent HW address; an 802.3ad bond with the aggregator id, actor / partner keys, the partner MAC
    and per-slave aggregator ids; network_stats keeps its summary keys (mode, mii_status, slaves).
 2. NetworkManager profiles: `nmcli connection show` (tabular, a name with a space), the per-connection dumps
    (type, interface, controller / port type, bond options, VLAN, IP method / addresses / gateway / DNS, MTU,
    autoconnect), a keyfile, a legacy ifcfg (bond master / slave, VLAN, static IP); secrets (psk, password, secret,
    private-key) are masked in every representation, the -flags keys are not.
 3. Runtime: ip -d link kinds (bond with its mode, vlan with id and parent, bridge, openvswitch, the slaves' masters),
    routes, ethtool, `bridge link`; Open vSwitch (ovs-vsctl show: bridges, ports, interface types, patch options;
    list interface) and the membership "bond0 -> br-ex (OVS)", a Linux bridge's members.
 4. Configured vs runtime: the configured primary not active (warn), a configured bond port missing (bad), a profile
    MTU differing (warn), a profile's bridge membership not seen at runtime (warn); an OVS port under ovs-system is
    no mismatch; the quiet variant says "agree".
 5. Absent data: no capture at all -> the no_data findings, no crash; a report without OVS or bonds says so.
 6. The mock report renders through /load_tab: the bonds with primary / active marks, the bridges (br-ex with bond0
    as uplink), the interfaces table with the member-of column and the markers, the profiles with the masked badge,
    the collected nmcli tables and key/value blocks; the PSK value appears nowhere in the HTML; the network group
    page lists the tab's findings.

Needs the backend venv (Flask); run-all.sh picks it up as a .test.py.
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

from flask import Flask  # noqa: E402

import log_viewer as lv  # noqa: E402
import mock_sosreport  # noqa: E402
from parsers.sosreport import network_config as nc, network_stats as ns  # noqa: E402

WORK = tempfile.mkdtemp(prefix="diag-netconfig-")
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
    app.secret_key = "diagnostics-netconfig-test"
    return app.test_client()


def render(c, directory, tab, sub_tab=None):
    body = {"directory": directory, "report_type": "sosreport", "tab": tab}
    if sub_tab:
        body["sub_tab"] = sub_tab
    r = c.post("/load_tab", json=body)
    return r.status_code, (r.get_json() or {}).get("html", "")


BOND_AB = """Ethernet Channel Bonding Driver: v5.14.0-427.el9.x86_64

Bonding Mode: fault-tolerance (active-backup)
Primary Slave: eth3 (primary_reselect always)
Currently Active Slave: eth4
MII Status: up
MII Polling Interval (ms): 100
Up Delay (ms): 200
Down Delay (ms): 200
Peer Notification Delay (ms): 0

Slave Interface: eth3
MII Status: down
Speed: Unknown
Duplex: Unknown
Link Failure Count: 3
Permanent HW addr: 02:00:00:aa:00:04
Slave queue ID: 0

Slave Interface: eth4
MII Status: up
Speed: 10000 Mbps
Duplex: full
Link Failure Count: 0
Permanent HW addr: 02:00:00:aa:00:05
Slave queue ID: 0
"""

BOND_LACP = """Ethernet Channel Bonding Driver: v5.14.0-427.el9.x86_64

Bonding Mode: IEEE 802.3ad Dynamic link aggregation
Transmit Hash Policy: layer3+4 (1)
MII Status: up
MII Polling Interval (ms): 100
Up Delay (ms): 0
Down Delay (ms): 0
Peer Notification Delay (ms): 0

802.3ad info
LACP active: on
LACP rate: fast
Min links: 0
Aggregator selection policy (ad_select): stable
System priority: 65535
System MAC address: 02:00:00:aa:00:06
Active Aggregator Info:
\tAggregator ID: 2
\tNumber of ports: 2
\tActor Key: 9
\tPartner Key: 33
\tPartner Mac Address: 02:00:00:bb:00:01

Slave Interface: eth5
MII Status: up
Speed: 1000 Mbps
Duplex: full
Link Failure Count: 0
Permanent HW addr: 02:00:00:aa:00:06
Slave queue ID: 0
Aggregator ID: 2
Actor Churn State: none
Partner Churn State: none

Slave Interface: eth6
MII Status: up
Speed: 1000 Mbps
Duplex: full
Link Failure Count: 1
Permanent HW addr: 02:00:00:aa:00:07
Slave queue ID: 0
Aggregator ID: 2
"""


def main():
    # 1. bonding ---------------------------------------------------------------------
    root = os.path.join(WORK, "sosreport-bonds")
    write(root, "proc/net/bonding/bond0", BOND_AB)
    write(root, "proc/net/bonding/bond1", BOND_LACP)
    bonds = ns.parse_bonding(root)
    b0, b1 = bonds["bond0"], bonds["bond1"]
    check("1. active-backup: mode, primary eth3, active eth4 (a failover), MII up, polling 100 ms, delays 200/200",
          b0["mode"].startswith("fault-tolerance") and b0["primary"] == "eth3" and b0["active"] == "eth4" and b0["mii_status"] == "up" and b0["mii_polling_ms"] == 100 and b0["up_delay_ms"] == 200 and b0["down_delay_ms"] == 200, json.dumps(b0)[:300])
    check("1. the slaves: MII down / up, speed, duplex, failures 3 / 0, permanent HW addresses (the summary keys network_stats always had kept)",
          [s["name"] for s in b0["slaves"]] == ["eth3", "eth4"] and b0["slaves"][0]["mii_status"] == "down" and b0["slaves"][0]["failures"] == 3 and b0["slaves"][0]["hw_addr"] == "02:00:00:aa:00:04"
          and b0["slaves"][1]["speed"] == "10000 Mbps" and b0["slaves"][1]["duplex"] == "full" and all(k in b0["slaves"][1] for k in ("name", "mii_status", "speed", "failures")), json.dumps(b0["slaves"]))
    check("1. 802.3ad: LACP active fast, aggregator 2, 2 ports, actor key 9 / partner key 33, the partner MAC; per slave the aggregator id; no primary / active",
          b1["lacp"].get("rate") == "fast" and b1["lacp"].get("active") == "on" and b1["lacp"].get("aggregator_id") == "2" and b1["lacp"].get("number_of_ports") == "2" and b1["lacp"].get("actor_key") == "9"
          and b1["lacp"].get("partner_key") == "33" and b1["lacp"].get("partner_mac_address") == "02:00:00:bb:00:01" and all(s["aggregator_id"] == "2" for s in b1["slaves"]) and b1["primary"] == "" and b1["active"] == "", json.dumps(b1["lacp"]))
    write(root, "sos_commands/networking/ip_-s_-d_link", "2: eth3: <NO-CARRIER,BROADCAST,MULTICAST,SLAVE,UP> mtu 9000 qdisc mq master bond0 state DOWN mode DEFAULT group default qlen 1000\n    link/ether 02:00:00:aa:00:04 brd ff:ff:ff:ff:ff:ff\n    RX:  bytes packets errors dropped  missed   mcast\n    0 0 0 0 0 0\n    TX:  bytes packets errors dropped carrier collsns\n    0 0 0 0 0 0\n")
    stats = ns.parse(root)
    check("1. network_stats still reads the same capture (its Findings name the slave down, its bond summary keeps the keys the card reads)", any("eth3" in f["title"] and "down" in f["title"] for f in stats["findings"]) and stats["bonds"]["bond0"]["slaves"][0]["mii_status"] == "down", json.dumps(stats["findings"]))

    # 2. profiles --------------------------------------------------------------------
    table = nc.parse_nmcli_table("NAME             UUID                                  TYPE            DEVICE\nbond0            0ea1bd55-0000-4000-8000-000000000001  bond            bond0\nWi-Fi lab        0ea1bd55-0000-4000-8000-000000000009  wifi            --\n")
    check("2. nmcli connection show: the columns by header position, a NAME with a space kept whole", len(table) == 2 and table[1]["NAME"] == "Wi-Fi lab" and table[1]["DEVICE"] == "--" and table[0]["TYPE"] == "bond", json.dumps(table))
    dump = ("connection.id:                          bond0\nconnection.uuid:                        0ea1bd55-0000-4000-8000-000000000001\nconnection.type:                        bond\n"
            "connection.interface-name:              bond0\nconnection.autoconnect:                 yes\nbond.options:                           mode=active-backup,miimon=100,primary=eth3\n"
            "802-3-ethernet.mtu:                     9000\nipv4.method:                            manual\nipv4.addresses:                         192.0.2.20/24, 192.0.2.21/24\nipv4.gateway:                           192.0.2.1\n"
            "ipv4.dns:                               192.0.2.53,192.0.2.54\nipv6.method:                            disabled\nGENERAL.STATE:                          activated\n")
    p = nc.profile_from_nmcli(nc.parse_nmcli_kv(dump))
    check("2. a per-connection dump: type, interface, bond options as a dict (mode, miimon, primary), MTU, ipv4 manual with two addresses, the gateway, two DNS; the GENERAL.* lines are not settings",
          p["type"] == "bond" and p["interface"] == "bond0" and p["bond_options"] == {"mode": "active-backup", "miimon": "100", "primary": "eth3"} and p["mtu"] == "9000" and p["ipv4"]["method"] == "manual"
          and p["ipv4"]["addresses"] == ["192.0.2.20/24", "192.0.2.21/24"] and p["ipv4"]["gateway"] == "192.0.2.1" and p["ipv4"]["dns"] == ["192.0.2.53", "192.0.2.54"] and not any(k.startswith("GENERAL") for k, _ in p["raw"]), json.dumps(p)[:400])
    port = nc.profile_from_nmcli(nc.parse_nmcli_kv("connection.id:  bond0-port-eth3\nconnection.type:  802-3-ethernet\nconnection.interface-name:  eth3\nconnection.master:  bond0\nconnection.slave-type:  bond\n"))
    check("2. a bond port profile: controller bond0, port type bond", port["controller"] == "bond0" and port["port_type"] == "bond" and port["type"] == "802-3-ethernet")
    wifi_dump = ("connection.id:  Wi-Fi lab\nconnection.type:  802-11-wireless\nconnection.interface-name:  wlan0\n802-11-wireless.ssid:  lab-net\n802-11-wireless-security.key-mgmt:  wpa-psk\n"
                 "802-11-wireless-security.psk:  example-psk-must-never-show\n802-11-wireless-security.psk-flags:  0 (none)\n802-1x.password:  example-password-never\nvpn.secrets.password:  s3cret-example\n")
    pairs = nc.parse_nmcli_kv(wifi_dump)
    d = dict(pairs)
    check("2. masking: psk, 802-1x.password and vpn.secrets.* are <redacted>, the -flags key and the SSID are not",
          d["802-11-wireless-security.psk"] == nc.MASK and d["802-1x.password"] == nc.MASK and d["vpn.secrets.password"] == nc.MASK and d["802-11-wireless-security.psk-flags"] == "0 (none)" and d["802-11-wireless.ssid"] == "lab-net", json.dumps(d))
    wp = nc.profile_from_nmcli(pairs)
    check("2. ...and the profile knows it holds a secret (the badge) without holding the value", wp["wifi"]["secret"] == nc.MASK and "must-never-show" not in json.dumps(wp))
    kf = nc.parse_keyfile("[connection]\nid=Wi-Fi lab\ntype=wifi\ninterface-name=wlan0\nautoconnect=false\n\n[wifi]\nssid=lab-net\n\n[wifi-security]\nkey-mgmt=wpa-psk\npsk=example-psk-must-never-show\n\n[ipv4]\nmethod=auto\naddress1=192.0.2.30/24,192.0.2.1\ndns=192.0.2.53;\n")
    kp = nc.profile_from_keyfile(kf, "Wi-Fi lab")
    check("2. a keyfile: sections become section.key, the psk is masked, autoconnect false -> no, address1 gives the address and gateway, dns split",
          kf["wifi-security.psk"] == nc.MASK and kp["type"] == "wifi" and kp["autoconnect"] == "no" and kp["ipv4"]["addresses"] == ["192.0.2.30/24"] and kp["ipv4"]["gateway"] == "192.0.2.1" and kp["ipv4"]["dns"] == ["192.0.2.53"], json.dumps(kp)[:300])
    ifcfg_bond = nc.profile_from_ifcfg(nc.parse_ifcfg('DEVICE=bond2\nNAME=bond2\nTYPE=Bond\nBONDING_MASTER=yes\nBONDING_OPTS="mode=active-backup miimon=100 primary=eth8"\nBOOTPROTO=none\nIPADDR=203.0.113.10\nPREFIX=24\nGATEWAY=203.0.113.1\nDNS1=192.0.2.53\nONBOOT=yes\nMTU=9000\n'), "ifcfg-bond2")
    ifcfg_slave = nc.profile_from_ifcfg(nc.parse_ifcfg("DEVICE=eth8\nTYPE=Ethernet\nMASTER=bond2\nSLAVE=yes\nONBOOT=yes\nBOOTPROTO=none\n"), "ifcfg-eth8")
    ifcfg_vlan = nc.profile_from_ifcfg(nc.parse_ifcfg("DEVICE=bond2.200\nVLAN=yes\nPHYSDEV=bond2\nBOOTPROTO=dhcp\nONBOOT=no\nWIRELESS_PSK=example-never\n"), "ifcfg-bond2.200")
    check("2. ifcfg: a bond master with space-separated BONDING_OPTS, static IP with prefix, gateway, DNS, MTU; a slave with MASTER / SLAVE; a VLAN by VLAN=yes / PHYSDEV (id from the name), dhcp -> auto, ONBOOT=no -> autoconnect no; a *_PSK key masked",
          ifcfg_bond["type"] == "bond" and ifcfg_bond["bond_options"] == {"mode": "active-backup", "miimon": "100", "primary": "eth8"} and ifcfg_bond["ipv4"]["addresses"] == ["203.0.113.10/24"] and ifcfg_bond["ipv4"]["gateway"] == "203.0.113.1" and ifcfg_bond["mtu"] == "9000"
          and ifcfg_slave["controller"] == "bond2" and ifcfg_slave["port_type"] == "bond" and ifcfg_vlan["type"] == "vlan" and ifcfg_vlan["vlan"] == {"id": "200", "parent": "bond2"} and ifcfg_vlan["ipv4"]["method"] == "auto" and ifcfg_vlan["autoconnect"] == "no"
          and dict(ifcfg_vlan["raw"])["WIRELESS_PSK"] == nc.MASK, json.dumps([ifcfg_bond, ifcfg_slave, ifcfg_vlan])[:500])

    # 3. runtime, OVS, bridges ---------------------------------------------------------
    links = nc.parse_ip_d_link(
        "2: eth3: <NO-CARRIER,BROADCAST,MULTICAST,SLAVE,UP> mtu 9000 qdisc mq master bond0 state DOWN mode DEFAULT group default qlen 1000\n    link/ether 02:00:00:aa:00:04 brd ff:ff:ff:ff:ff:ff promiscuity 0 minmtu 68 maxmtu 9702\n    bond_slave state BACKUP mii_status DOWN link_failure_count 3 perm_hwaddr 02:00:00:aa:00:04 queue_id 0\n"
        "5: bond0: <BROADCAST,MULTICAST,MASTER,UP,LOWER_UP> mtu 9000 qdisc noqueue master ovs-system state UP mode DEFAULT group default qlen 1000\n    link/ether 02:00:00:aa:00:05 brd ff:ff:ff:ff:ff:ff promiscuity 1 minmtu 68 maxmtu 65535\n    bond mode active-backup miimon 100 updelay 200 downdelay 200 primary eth3\n    openvswitch_slave\n"
        "6: bond0.100@bond0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9000 qdisc noqueue master br0 state UP mode DEFAULT group default qlen 1000\n    link/ether 02:00:00:aa:00:05 brd ff:ff:ff:ff:ff:ff promiscuity 1\n    vlan protocol 802.1Q id 100 <REORDER_HDR>\n    bridge_slave state forwarding priority 32 cost 100\n"
        "7: br0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9000 qdisc noqueue state UP mode DEFAULT group default qlen 1000\n    link/ether 02:00:00:aa:00:05 brd ff:ff:ff:ff:ff:ff promiscuity 0\n    bridge forward_delay 1500 hello_time 200 stp_state 0\n"
        "8: br-ex: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9000 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\n    link/ether 02:00:00:aa:00:05 brd ff:ff:ff:ff:ff:ff promiscuity 1\n    openvswitch\n")
    check("3. ip -d link: a bond slave (master, slave kind), the bond with its mode under the OVS datapath, the VLAN with id 100 on bond0 under br0, the Linux bridge, the OVS internal interface",
          links["eth3"]["master"] == "bond0" and links["eth3"]["slave_kind"] == "bond" and links["eth3"]["state"] == "DOWN" and links["bond0"]["kind"] == "bond" and links["bond0"]["bond_mode"] == "active-backup" and links["bond0"]["master"] == "ovs-system"
          and links["bond0.100"]["kind"] == "vlan" and links["bond0.100"]["vlan_id"] == 100 and links["bond0.100"]["parent"] == "bond0" and links["bond0.100"]["master"] == "br0" and links["br0"]["kind"] == "bridge" and links["br-ex"]["kind"] == "openvswitch", json.dumps(links)[:400])
    ovs = nc.parse_ovs_vsctl_show("0f1e2d3c-0000-4000-8000-000000000001\n    Bridge br-ex\n        fail_mode: standalone\n        Port br-ex\n            Interface br-ex\n                type: internal\n        Port bond0\n            Interface bond0\n                type: system\n        Port patch-br-ex_to_br-int\n            Interface patch-br-ex_to_br-int\n                type: patch\n                options: {peer=patch-br-int_to_br-ex}\n    Bridge br-int\n        fail_mode: secure\n        Port br-int\n            Interface br-int\n                type: internal\n    ovs_version: \"3.3.2\"\n")
    mem = nc.ovs_membership(ovs)
    check("3. ovs-vsctl show: two bridges, br-ex's ports (internal br-ex, the system uplink bond0, the patch port with its peer), the fail mode; the membership bond0 -> br-ex as the system uplink",
          set(ovs) == {"br-ex", "br-int"} and [p["name"] for p in ovs["br-ex"]["ports"]] == ["br-ex", "bond0", "patch-br-ex_to_br-int"] and ovs["br-ex"]["ports"][2]["interfaces"][0]["type"] == "patch" and "peer=patch-br-int_to_br-ex" in ovs["br-ex"]["ports"][2]["interfaces"][0]["options"]
          and ovs["br-ex"]["fail_mode"] == "standalone" and mem["bond0"] == {"bridge": "br-ex", "type": "system", "port": "bond0", "tag": ""} and mem["br-ex"]["type"] == "internal", json.dumps(ovs)[:400])
    routes = nc.parse_routes("default via 192.0.2.1 dev eth0 proto static metric 100\n192.0.2.0/24 dev eth0 proto kernel scope link src 192.0.2.10 metric 100\nlocal 192.0.2.10 dev eth0 table local proto kernel scope host src 192.0.2.10\nbroadcast 192.0.2.255 dev eth0 table local proto kernel scope link src 192.0.2.10\n")
    check("3. ip route: the main table's routes (default via, the connected route with its source), the local table skipped", len(routes) == 2 and routes[0]["via"] == "192.0.2.1" and routes[0]["dev"] == "eth0" and routes[1]["src"] == "192.0.2.10", json.dumps(routes))
    check("3. bridge link: member -> bridge", nc.parse_bridge_link("9: bond0.100@bond0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9000 master br0 state forwarding priority 32 cost 100\n") == {"bond0.100": "br0"})

    # 4 + 6. the mock sosreport, parsed and rendered -----------------------------------------
    mock = os.path.join(WORK, "sosreport-mock-2026-10-13-abcdef")
    mock_sosreport.build(mock)
    r = nc.parse(mock)
    by_name = {i["name"]: i for i in r["interfaces"]}
    sev_titles = [(f["severity"], f["title"]) for f in r["findings"]]
    check("4. the mock: bond0 active-backup (primary eth3 down, active eth4 - failed over), bond1 802.3ad; the roles on the slaves",
          r["bonds"]["bond0"]["primary"] == "eth3" and r["bonds"]["bond0"]["active"] == "eth4" and [(s["name"], s["role"], s["is_active"]) for s in r["bonds"]["bond0"]["slaves"]] == [("eth3", "primary", False), ("eth4", "secondary", True)] and r["bonds"]["bond1"]["lacp"]["aggregator_id"] == "2", json.dumps(r["bonds"])[:300])
    check("4. bond0 is the uplink of br-ex (OVS) and bond0.100 a member of br0 (Linux); br-ex and br0 are listed as bridges with their members",
          by_name["bond0"]["member_of"] == {"name": "br-ex", "kind": "OVS", "via": "", "type": "system"} and by_name["bond0.100"]["member_of"]["name"] == "br0" and {(b["name"], b["kind"]) for b in r["bridges"]} == {("br-ex", "OVS"), ("br-int", "OVS"), ("br0", "Linux")}
          and [m["name"] for m in next(b for b in r["bridges"] if b["name"] == "br0")["members"]] == ["bond0.100"], json.dumps([by_name["bond0"]["member_of"], [b["name"] for b in r["bridges"]]]))
    check("4. the markers: eth7 configured as a bond1 port but no slave (bad), the primary eth3 not active (warn), eth5 profile MTU 9000 vs 1500 (warn), eth2 under br-ex by profile but standalone (warn); bond0 under ovs-system is NOT a mismatch",
          ("bad", "bond1: the configured port eth7 is not a slave at runtime") in sev_titles and ("warn", "bond0: the primary eth3 is not the active slave") in sev_titles and by_name["eth5"]["markers"] == ["profile MTU 9000, running 1500"]
          and by_name["eth2"]["markers"] == ["profile says port of br-ex, running standalone"] and by_name["bond0"]["markers"] == [] and by_name["br-ex"]["markers"] == [], json.dumps(sev_titles))
    check("4. the profiles: 18 (the nmcli dumps, the keyfile only adds its path to the nmcli profile, the ifcfg eth1), one with masked secrets, no PSK anywhere in the parsed data; no profile named after a flag (--active)",
          len(r["profiles"]) == 18 and [p["name"] for p in r["profiles"] if p["secrets_masked"]] == ["Wi-Fi lab"] and "must-never-show" not in json.dumps(r) and any(p["source"].startswith("etc/sysconfig") for p in r["profiles"])
          and not any(p["name"].startswith("-") for p in r["profiles"]), str([p["name"] for p in r["profiles"]]))
    by_pname = {p["name"]: p for p in r["profiles"]}
    check("4. the --active lists mark the profiles: bond0 (the ovs-port), ovs-if-bond0, the port profiles active; Wi-Fi lab, bond0-legacy and the ifcfg eth1 (unknown to NetworkManager) inactive",
          by_pname["bond0"]["active"] is True and by_pname["ovs-if-bond0"]["active"] is True and by_pname["bond0-port-eth3"]["active"] is True and by_pname["Wi-Fi lab"]["active"] is False and by_pname["bond0-legacy"]["active"] is False and by_pname["eth1"]["active"] is False
          and r["nm"]["active_known"] and len(r["nm"]["active"]) == 15, json.dumps({k: v["active"] for k, v in by_pname.items()}))
    check("4. the OpenShift OVS pattern on bond0 (the ovs-port profile named bond0 under br-ex; ovs-if-bond0 a bond-type profile with controller / master bond0, port-type ovs-port; bond0-legacy inactive): no \"bond0 is not a slave\" finding, bond0 a member of br-ex (OVS), its profile ovs-if-bond0, its configured ports eth3 / eth4 only",
          not any("bond0 is not a slave" in f["title"] or "port bond0 is not" in f["title"] for f in r["findings"]) and r["bonds"]["bond0"]["configured_ports"] == ["eth3", "eth4"] and r["bonds"]["bond0"]["profile"] == "ovs-if-bond0"
          and by_name["bond0"]["member_of"] == {"name": "br-ex", "kind": "OVS", "via": "", "type": "system"} and by_name["bond0"]["markers"] == [] and by_name["eth3"]["markers"] == [] and by_name["eth4"]["markers"] == [], json.dumps([(f["severity"], f["title"]) for f in r["findings"]]))
    check("4. ...while the genuine case (bond1-port-eth7: port-type bond, controller bond1, no such slave) is still flagged, and the inactive profiles are an info line",
          ("bad", "bond1: the configured port eth7 is not a slave at runtime") in sev_titles and ("info", "3 inactive profiles") in sev_titles, json.dumps(sev_titles))
    check("4. the collected nmcli: general status, device status, 13 device blocks, the plain connection list (17 rows), the -f all list, 17 per-connection dumps; the two non-nmcli files apart",
          r["nm"]["general"] and r["nm"]["devices"] and len(r["nm"]["device_show"]) == 13 and len(r["nm"]["connections"]) == 17 and len(r["nm"]["connections_all"]) == 17 and len(r["nm"]["connection_show"]) == 17 and len(r["nm"]["captures"]) == 25 and len(r["nm"]["other"]) == 2,
          json.dumps({k: (len(v) if hasattr(v, "__len__") else v) for k, v in r["nm"].items()}))
    cmds = {c["command"]: c for c in r["nm"]["captures"]}
    check("4. the lists read as what they are: nmcli con, nmcli -f all con, nmcli con show --active / nmcli connection show --active (the active lists), never a profile; a dump reads nmcli connection show <id>",
          cmds["nmcli con"]["kind"] == "connections" and cmds["nmcli -f all con"]["kind"] == "connections" and cmds["nmcli -f all con"]["fields"] == "all" and cmds["nmcli con show --active"]["active"] and cmds["nmcli connection show --active"]["active"]
          and cmds["nmcli connection show Wi-Fi lab"]["kind"] == "connection" and "--active" not in r["nm"]["connection_show"], json.dumps(sorted(cmds)))
    other = {c["kind"]: c for c in r["nm"]["other"]}
    check("4. NetworkManager --print-config: its own command, sectioned key / value with the comments dropped and the psk masked; the journal: its own command, 39 lines, the last 25 kept, a Log Viewer source",
          other["config"]["command"] == "NetworkManager --print-config" and [sec for sec, _ in other["config"]["sections"]] == ["main", "logging", "connectivity", "keyfile", "device", "connection-example"] and dict(other["config"]["sections"][-1][1])["wifi-sec.psk"] == nc.MASK
          and other["config"]["secrets_masked"] and "config-psk-never-show" not in json.dumps(r) and other["journal"]["command"] == "journalctl --no-pager --unit NetworkManager" and other["journal"]["line_count"] == 39 and len(other["journal"]["tail"]) == 25
          and other["journal"]["log_source"] == "journalctl (unit_NetworkManager)" and other["journal"]["log_query"] == "sources=journalctl%20%28unit_NetworkManager%29", json.dumps([(c["command"], c["kind"], c["entries"]) for c in r["nm"]["other"]]))
    # the classifier on the real file shapes, and an unknown file
    cls = lambda n, txt="NAME  UUID  TYPE  DEVICE\nx  y  z  w\n": nc.classify_nm_file(n, txt)  # noqa: E731
    check("4. classify: the program from the first token; nmcli lists vs dumps (a flag is never an id; id / uuid / path dropped; -t --order name a list; -f all recorded); device status / show; general; another subcommand is other",
          [(cls(n)["kind"], cls(n)["target"], cls(n)["command"]) for n in ("nmcli_con", "nmcli_con_show", "nmcli_con_show_--active", "nmcli_con_show_-t_--order_name", "nmcli_-f_all_con", "nmcli_connection_show_uuid_0ea1bd55-0000-4000-8000-000000000001", "nmcli_con_show_id_Wi-Fi_lab", "nmcli_dev_status", "nmcli_dev_show", "nmcli_dev_show_eth0", "nmcli_general_status", "nmcli_networking_connectivity")]
          == [("connections", "", "nmcli con"), ("connections", "", "nmcli con show"), ("connections", "", "nmcli con show --active"), ("connections", "", "nmcli con show -t --order name"), ("connections", "", "nmcli -f all con"),
              ("connection", "0ea1bd55-0000-4000-8000-000000000001", "nmcli connection show 0ea1bd55-0000-4000-8000-000000000001"), ("connection", "Wi-Fi_lab", "nmcli connection show Wi-Fi_lab"), ("devices", "", "nmcli dev status"), ("device", "", "nmcli dev show"), ("device", "eth0", "nmcli dev show eth0"), ("general", "", "nmcli general status"), ("other", "", "nmcli networking connectivity")],
          json.dumps([(cls(n)["kind"], cls(n)["target"], cls(n)["command"]) for n in ("nmcli_con", "nmcli_con_show_-t_--order_name", "nmcli_connection_show_uuid_0ea1bd55-0000-4000-8000-000000000001", "nmcli_networking_connectivity")]))
    check("4. classify: a dump's connection.id names the target when the dump has it; NetworkManager --print-config is config, journalctl a journal, anything else a file by its raw name - never prefixed nmcli",
          cls("nmcli_con_show_id_Wi-Fi_lab", "connection.id:   Wi-Fi lab\nconnection.type:  wifi\n")["target"] == "Wi-Fi lab" and cls("nmcli_con_show_id_Wi-Fi_lab", "connection.id:   Wi-Fi lab\n")["command"] == "nmcli connection show Wi-Fi lab"
          and cls("NetworkManager_--print-config", "[main]\na=1\n")["kind"] == "config" and cls("journalctl_--no-pager_--unit_NetworkManager", "x\n")["kind"] == "journal" and cls("strange_file", "a\nb\n") == dict(cls("strange_file", "a\nb\n"), kind="file", command="strange_file", program="strange", entries=2)
          and not cls("NetworkManager_--print-config", "")["command"].startswith("nmcli"))
    odd = os.path.join(WORK, "sosreport-odd")
    write(odd, "sos_commands/networkmanager/strange_file", "whatever\n")
    write(odd, "sos_commands/networkmanager/nmcli_con_show_--active", "NAME  UUID  TYPE  DEVICE\nx     y     z     w\n")
    ro = nc.parse(odd)
    check("4. a report with only an unknown file and an --active list: no crash, no profile, the unknown file under other by its name, the active list a capture",
          ro["profiles"] == [] and [c["command"] for c in ro["nm"]["other"]] == ["strange_file"] and [c["command"] for c in ro["nm"]["captures"]] == ["nmcli con show --active"], json.dumps(ro["nm"]["other"]))
    quiet = os.path.join(WORK, "sosreport-quiet-2026-10-13-nothing")
    mock_sosreport.build(quiet, quiet=True)
    rq = nc.parse(quiet)
    check("4. the quiet report: no bad / warn, the good line says configuration and runtime agree", not [f for f in rq["findings"] if f["severity"] in ("bad", "warn")] and any(f["severity"] == "good" and "agree" in f["title"] for f in rq["findings"]), json.dumps([(f["severity"], f["title"]) for f in rq["findings"]]))

    # 5. absent data -------------------------------------------------------------------
    empty = os.path.join(WORK, "sosreport-empty")
    write(empty, "date", "Mon Oct 12 14:30:01 UTC 2026\n")
    re_ = nc.parse(empty)
    check("5. an empty report: no crash, the no_data findings name the captures (interfaces, bonds, profiles, OVS), nothing good claimed",
          re_["interfaces"] == [] and not re_["bonds"] and {f["severity"] for f in re_["findings"]} == {"info"} and any("No interface capture" in f["title"] for f in re_["findings"]) and any("No Open vSwitch" in f["title"] for f in re_["findings"]), json.dumps([f["title"] for f in re_["findings"]]))
    c = client()
    status, html = render(c, mock, "network", "network_config")
    def rows_of(table_id):
        return html.count(f'data-nc-table="{table_id}"')
    check("6. the mock renders (200) with the Findings strip first, then the bonds table (one row per bond: bond0 failed over to eth4 with the primary eth3, bond1 802.3ad) with the port table and the LACP block in the panel",
          status == 200 and html.index('class="ui-findings"') < html.index('id="nc-bonds"') and rows_of("nc-bonds") == 2 and ">failed over<" in html and "Currently Active Slave\">eth4<" in html and "Actor / partner key" in html and ">primary<" in html and ">secondary<" in html, html[:300] if status != 200 else "")
    check("6. the bridges table (br-ex OVS with the bond0 uplink, br-int, br0 Linux) with the member table and its role badges in the panel",
          rows_of("nc-bridges") == 3 and "system (uplink)" in html and ">internal<" in html and ">patch<" in html and ">Linux port<" in html and ">OVS<" in html and ">Linux<" in html, "")
    check("6. the interfaces table with the member-of column and the markers; the profiles with the masked badge and the Active column (16 active, 3 inactive); the PSK values appear nowhere",
          rows_of("nc-table") == 13 and "Configured vs running" in html and "profile MTU 9000, running 1500" in html and rows_of("nc-profiles") == 18 and "secrets masked" in html
          and html.count(">active<") == 16 and html.count(">inactive<") == 3 and "must-never-show" not in html and "config-psk-never-show" not in html and "&lt;redacted&gt;" in html, str((html.count(">active<"), html.count(">inactive<"))))
    check("6. the other NetworkManager files in their own table (the configuration as sectioned key / value, the journal as a 25-line tail with the Log Viewer link), the nmcli table real nmcli commands only",
          rows_of("nc-nmfiles") == 2 and "Other NetworkManager files" in html and "NetworkManager --print-config" in html and ">journalctl --no-pager --unit NetworkManager<" in html and ">configuration<" in html and ">journal<" in html and "[connectivity]" in html
          and 'data-sub-tab="log_viewer" data-query="sources=journalctl%20%28unit_NetworkManager%29"' in html and "The last 25 of 39 lines" in html and "nmcli NetworkManager" not in html and "nmcli journalctl" not in html
          and "nmcli con show --active" in html and ">nmcli -f all con<" in html and ">active list<" in html, "")
    check("6. the nmcli captures as a table: one row per collected file with the readable command, the kind, the target linked to its profile / interface, the entry count; the output in the panel; no file-name paragraph",
          rows_of("nc-nmcli") == len(r["nm"]["captures"]) and "nmcli general status" in html and "nmcli dev status" in html and ">nmcli con show<" in html and "nmcli connection show Wi-Fi lab" in html and "nmcli device show" in html
          and 'data-nc-jump="nc-profiles" data-nc-key="Wi-Fi lab"' in html and ">connection list<" in html and ">device list<" in html and "sos_commands/networkmanager: nmcli_con_show" not in html, "")
    check("6. the nmcli rows: a connection dump's keys and values, the general status columns, the per-file captures in the parsed data (kinds, targets, entries, the masked one)",
          [c["kind"] for c in r["nm"]["captures"]][:3] == ["connections", "connections", "connections"] and any(c["command"] == "nmcli connection show Wi-Fi lab" and c["target"] == "Wi-Fi lab" and c["secrets_masked"] and c["entries"] > 5 for c in r["nm"]["captures"])
          and any(c["kind"] == "general" and c["rows"] for c in r["nm"]["captures"]) and any(c["kind"] == "device" and c["target"] == "" and c["entries"] > 50 for c in r["nm"]["captures"]) and sum(1 for c in r["nm"]["captures"] if c["secrets_masked"]) == 1, json.dumps([(c["command"], c["kind"], c["target"], c["entries"]) for c in r["nm"]["captures"]])[:600])
    check("6. every table of the page sorts by its headers (data-key) and has its own Expand all; one search over the page",
          html.count('data-xrow-all="open"') == 6 and all(f'data-table="#{t}"' in html for t in ("nc-bonds", "nc-bridges", "nc-table", "nc-profiles", "nc-nmcli", "nc-nmfiles")) and html.count('data-ui-search') == 1 and 'data-key="bond"' in html and 'data-key="command"' in html, "")
    check("6. no reconstructed nmcli command anywhere (display of the collected output only)", "nmcli connection add" not in html and "nmcli connection modify" not in html)
    status2, html2 = render(c, mock, "network")
    check("6. the network group page lists the tab's findings, linked to it", status2 == 200 and "network_config: bond1: the configured port eth7" in html2 and 'data-sub-tab="network_config"' in html2)
    status3, html3 = render(c, empty, "network", "network_config")
    check("6. the empty report renders (200) with the no_data lines and no table", status3 == 200 and "No interface capture" in html3 and "<table" not in html3)

    failed = [l for l, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    shutil.rmtree(WORK, ignore_errors=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
