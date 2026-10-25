"""Synthetic sos `sos_reports/manifest.json` documents for the Blame tab
(backend/parsers/sosreport/blame.py) and its tests.

Three shapes:
  rhel_manifest()        the web-01 report's own manifest (sos 4.7 layout:
                         plugins with start/end times, commands with return
                         codes and run times, one plugin that hit its
                         timeout, plugins that ran no command)
  ocp_master_manifest()  an OpenShift master-like run: many plugins, the
                         ebpf plugin failing 383 commands (rc 127 / 1),
                         networking with 1,868 commands and a mix of return
                         codes, chrony slow, a timeout, command-level times
                         only (no plugin start/end)
  old_manifest()         an older, partial manifest (no components.report.
                         plugins, no run times): the tab's empty state

Every value is made up (round numbers, example hosts). The command strings
are what sos runs; nothing here came from a real system.
"""
import json
import random
from datetime import datetime, timedelta


def _td(seconds):
    """str(timedelta) the way sos writes run times: '0:01:03.480000'."""
    return str(timedelta(seconds=seconds))


def _ts(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")


def _plugin(start, run_seconds, commands, timeout=300, timeout_hit=False, setup_seconds=0.004, with_times=True, files=None, plugin_times=None):
    """One plugin entry; commands = [(exec, rc, seconds)]. The commands run
    back to back from `start`. with_times: the commands carry start/end
    stamps; plugin_times (default: with_times): the plugin does too."""
    if plugin_times is None:
        plugin_times = with_times
    entry = {
        "setup_start": _ts(start - timedelta(seconds=setup_seconds + 0.5)),
        "setup_time": _td(setup_seconds),
        "timeout": timeout,
        "timeout_hit": timeout_hit,
        "command_timeout": min(timeout, 300),
        "run_time": _td(run_seconds),
        "strings": [],
        "files": files or [],
        "collections": [],
        "commands": [],
    }
    if plugin_times:
        entry["start_time"] = _ts(start)
        entry["end_time"] = _ts(start + timedelta(seconds=run_seconds))
    at = start
    for exec_, rc, secs in commands:
        cmd = {
            "exec": exec_,
            "filepath": "sos_commands/" + exec_.split()[0].rsplit("/", 1)[-1] + "/" + exec_.replace("/", ".").replace(" ", "_")[:80],
            "return_code": rc,
            "run_time": round(secs, 6),
            "priority": 10,
            "tags": [exec_.split()[0].rsplit("/", 1)[-1]],
        }
        if with_times:
            cmd["start_time"] = _ts(at)
            cmd["end_time"] = _ts(at + timedelta(seconds=secs))
        entry["commands"].append(cmd)
        at += timedelta(seconds=secs)
    return entry


def rhel_manifest(hostname="web-01.example.test", kernel="5.14.0-427.13.1.el9_4.x86_64"):
    """The synthetic web-01 report's manifest: a 113 s run of 24 plugins."""
    t0 = datetime(2026, 10, 12, 14, 28, 10, 412000)
    plugins = {}
    at = t0 + timedelta(seconds=6)  # setup of every plugin runs first

    def add(name, run_seconds, commands, **kw):
        nonlocal at
        plugins[name] = _plugin(at, run_seconds, commands, **kw)
        at += timedelta(seconds=run_seconds)

    add("boot", 1.2, [("ls -lanR /boot", 0, 0.03), ("lsinitrd", 0, 1.1)])
    add("chrony", 31.6, [("chronyc tracking", 0, 0.02), ("chronyc sources", 0, 0.01), ("chronyc -n sources", 1, 10.5), ("chronyc -n sourcestats", 1, 10.5), ("chronyc -n activity", 0, 10.5)])
    add("date", 0.1, [("date", 0, 0.01), ("date --utc", 0, 0.01), ("hwclock", 0, 0.05)])
    add("dnf", 9.8, [("dnf -C repolist", 0, 2.2), ("dnf -C updateinfo", 0, 7.5), ("dnf list installed", 0, 0.1)])
    add("filesys", 2.4, [("df -al", 0, 0.1), ("mount -l", 0, 0.01), ("findmnt", 0, 0.02), ("lsof -b +M -n -l -P", 0, 2.2)])
    add("firewalld", 1.9, [("firewall-cmd --list-all-zones", 0, 1.4), ("firewall-cmd --get-active-zones", 0, 0.4)])
    add("hardware", 0.4, [("dmidecode", 0, 0.3), ("lspci -nnvv", 0, 0.1)])
    add("host", 0.1, [("hostname", 0, 0.01), ("hostnamectl status", 0, 0.05), ("uptime", 0, 0.01)])
    add("kernel", 3.1, [("dmesg", 0, 0.1), ("dmesg -T", 0, 0.1), ("lsmod", 0, 0.01), ("modinfo example_fastpath", 0, 0.02), ("sysctl -a", 0, 0.2), ("ls /sys/kernel/debug", 1, 0.01), ("bpftool prog list", 127, 0.01), ("bpftool map list", 127, 0.01)])
    add("logs", 42.5, [("journalctl --no-pager", 0, 38.1), ("journalctl --no-pager --boot", 0, 3.9), ("journalctl --disk-usage", 0, 0.1)], timeout=300)
    add("lvm2", 1.0, [("vgdisplay -vv", 0, 0.4), ("pvs -a -v", 0, 0.3), ("lvs -a -o +devices", 0, 0.3)])
    add("memory", 0.1, [("free", 0, 0.01), ("free -m", 0, 0.01), ("swapon --show", 0, 0.01)])
    add("networking", 6.3, [("ip -o addr", 0, 0.01), ("ip route show table all", 0, 0.01), ("ip -s -d link", 0, 0.02), ("ethtool eth0", 0, 0.02), ("ethtool -i eth0", 0, 0.01),
                            ("ethtool -S eth0", 0, 0.02), ("ethtool eth1", 0, 0.02), ("ethtool -S eth1", 0, 0.02), ("ethtool eth2", 75, 0.01), ("ethtool -S eth2", 75, 0.01),
                            ("nstat -zas", 0, 0.03), ("ss -peaonmi", 0, 0.9), ("nmcli general status", 0, 0.1), ("nmcli con", 0, 0.2), ("nmcli dev", 0, 0.2), ("tc -s qdisc show", 0, 0.01),
                            ("iptables -vnxL", 0, 0.2), ("ip6tables -vnxL", 0, 0.2), ("nft -a list ruleset", 0, 0.05), ("devlink dev", 127, 0.01), ("devlink dev param show", 127, 0.01),
                            ("ip netns", 0, 0.01), ("bridge -s -s -d link show", 0, 0.01), ("traceroute -n 198.51.100.1", 1, 4.2)])
    add("pci", 0.3, [("lspci -nnvv", 0, 0.2), ("lspci -tv", 0, 0.1)])
    add("process", 3.6, [("ps auxwww", 0, 0.1), ("ps -elfL", 0, 0.1), ("ps axo pid,wchan:40,cmd", 0, 0.1), ("pstree -lp", 0, 0.05), ("ps -eo pid,ppid,tid,comm,state", 0, 0.05)] + [(f"cat /proc/{pid}/status", 0, 0.005) for pid in range(1000, 1600)])
    add("processor", 0.5, [("lscpu", 0, 0.05), ("cpupower frequency-info", 0, 0.1), ("cpupower idle-info", 0, 0.1), ("turbostat --quiet -i 5", 1, 0.2)])
    add("rpm", 5.8, [("rpm -qa --qf=...", 0, 1.8), ("rpm -Va", 0, 4.0)])
    add("sar", 0.4, [("sar -A -f /var/log/sa/sa12", 0, 0.4)])
    add("selinux", 1.1, [("sestatus -b", 0, 0.3), ("semanage fcontext -l", 0, 0.7), ("semodule -l", 0, 0.1)])
    add("services", 0.1, [("chkconfig --list", 127, 0.01)])
    add("systemd", 1.9, [("systemctl show --all", 0, 1.1), ("systemctl list-units", 0, 0.2), ("systemctl list-unit-files", 0, 0.3), ("systemd-analyze blame", 0, 0.3)])
    # a plugin that hit its timeout: the plugin timeout is 60 here (the command never came back)
    add("example_app", 60.0, [("example-ctl status", 0, 0.1), ("example-ctl dump --all", -1, 59.8)], timeout=60, timeout_hit=True)
    # plugins that ran no command (file copies only)
    plugins["login"] = _plugin(at, 0.05, [], files=["/etc/login.defs", "/etc/securetty"])
    plugins["crypto"] = _plugin(at, 0.02, [], files=["/proc/crypto", "/etc/crypto-policies"])
    end = at + timedelta(seconds=0.3)
    return {
        "version": "4.7.0",
        "cmdline": "report --batch --case-id=EXAMPLE-0001 --all-logs --plugin-timeout=300",
        "start_time": _ts(t0),
        "end_time": _ts(end),
        "run_time": _td((end - t0).total_seconds()),
        "compression": "xz",
        "tmpdir": "/var/tmp",
        "tmpdir_fs_type": "xfs",
        "policy": "Red Hat Enterprise Linux",
        "preset": {"name": "none", "desc": "", "note": "", "opts": {}},
        "components": {"report": {"sysinfo": {"hostname": hostname, "kernel": kernel}, "plugins": plugins}},
    }


def ocp_master_manifest(seed=7):
    """An OpenShift master-like run of 190 s: 59 plugins, ebpf failing every
    command, networking with 1,868 commands, chrony waiting on DNS. Only the
    commands carry times (sos 4.5 style), the plugins do not."""
    rnd = random.Random(seed)
    t0 = datetime(2026, 10, 1, 4, 18, 22, 137758)
    plugins = {}
    at = t0 + timedelta(seconds=10)

    def add(name, run_seconds, commands, **kw):
        nonlocal at
        plugins[name] = _plugin(at, run_seconds, commands, plugin_times=False, **kw)
        at += timedelta(seconds=run_seconds)

    ebpf_cmds = [(f"bpftool prog dump xlated id {i}", 127, 0.4) for i in range(317)] + [(f"bpftool map dump id {i}", 1, 0.6) for i in range(66)]
    add("ebpf", 167.04, ebpf_cmds, timeout=600)
    add("chrony", 63.48, [("chronyc tracking", 0, 0.02), ("chronyc sources", 0, 0.01), ("chronyc -n sources", 1, 12.6), ("chronyc -n sourcestats", 1, 12.6), ("chronyc activity", 0, 0.02),
                          ("chronyc -n activity", 1, 12.6), ("chronyc ntpdata", 0, 0.1), ("chronyc -n ntpdata", 1, 12.6), ("chronyc serverstats", 0, 0.05), ("chronyc -n clients", 1, 12.6)], timeout=600)
    net = []
    for i in range(1868):
        kind = rnd.random()
        if kind < 0.72:
            net.append((f"ethtool -S veth{i % 400:04x}", 0, 0.015))
        elif kind < 0.94:
            net.append((f"ethtool -i veth{i % 400:04x}", 1, 0.01))
        elif kind < 0.97:
            net.append((f"ethtool -g veth{i % 400:04x}", 94, 0.01))
        elif kind < 0.995:
            net.append((f"ethtool -a veth{i % 400:04x}", 74, 0.01))
        else:
            net.append((f"tc -s class show dev veth{i % 400:04x}", 127, 0.01))
    net.extend([("ip -o addr", 0, 0.02), ("ip route show table all", 0, 0.05), ("ip -d link", 0, 0.02), ("ss -peaonmi", 0, 2.1), ("nstat -zas", 0, 0.1),
                ("iptables -vnxL", 72, 0.01), ("ip6tables -vnxL", 71, 0.01)])
    add("networking", 60.81, net, timeout=600)
    add("openshift", 44.2, [("oc get nodes -o wide", 0, 1.2), ("oc get pods -A -o wide", 0, 3.4), ("oc get events -A", 0, 2.1), ("oc adm top nodes", 1, 10.1), ("oc get clusterversion", 0, 0.8),
                            ("oc get co", 0, 0.9), ("oc describe nodes", 0, 4.6), ("oc get mcp", 0, 0.5), ("oc logs -n openshift-etcd etcd-master-0", 0, 20.2)], timeout=600)
    add("crio", 29.5, [("crictl ps -a", 0, 0.8), ("crictl images", 0, 0.6), ("crictl stats", 0, 1.1), ("crictl info", 0, 0.1)] + [(f"crictl inspect {('%064x' % (i * 7919))[:12]}", 0, 0.06) for i in range(400)]
        + [(f"crictl logs {('%064x' % (i * 104729))[:12]}", 0, 0.02) for i in range(100)], timeout=600)
    add("etcd", 18.3, [("etcdctl endpoint status -w table", 0, 1.1), ("etcdctl endpoint health", 0, 0.9), ("etcdctl member list -w table", 0, 0.6), ("etcdctl alarm list", 0, 0.5), ("etcdctl defrag --cluster", 0, 15.0)], timeout=600)
    add("logs", 15.4, [("journalctl --no-pager", 0, 14.9), ("journalctl --disk-usage", 0, 0.1), ("journalctl --list-boots", 0, 0.3)], timeout=600)
    add("podman", 12.1, [("podman ps -a", 0, 0.9), ("podman images", 0, 0.8), ("podman info", 0, 0.5), ("podman volume ls", 0, 0.3), ("podman network ls", 0, 0.3)] + [(f"podman inspect pod{i}", 125, 0.08) for i in range(100)], timeout=600)
    add("kernel", 9.2, [("dmesg", 0, 0.2), ("dmesg -T", 0, 0.2), ("lsmod", 0, 0.01), ("sysctl -a", 0, 0.3), ("bpftool prog list", 127, 0.01), ("ls /sys/kernel/debug", 1, 0.01)] + [(f"modinfo {m}" , 0, 0.04) for m in ("xfs", "overlay", "br_netfilter", "openvswitch", "vxlan", "geneve", "nf_conntrack", "bonding")], timeout=600)
    add("process", 8.4, [("ps auxwww", 0, 0.3), ("ps -elfL", 0, 0.4), ("pstree -lp", 0, 0.1)] + [(f"cat /proc/{pid}/status", 0, 0.003) for pid in range(1000, 3400)], timeout=600)
    add("openvswitch", 7.7, [("ovs-vsctl show", 0, 0.1), ("ovs-ofctl -O OpenFlow15 dump-flows br-int", 0, 5.2), ("ovs-appctl dpif/show", 0, 0.1), ("ovs-dpctl dump-flows", 0, 2.1), ("ovs-vsctl list Open_vSwitch", 0, 0.1)], timeout=600)
    add("rpm", 6.6, [("rpm -qa", 0, 0.8), ("rpm -Va", 0, 5.8)], timeout=600)
    add("filesys", 5.0, [("df -al", 0, 0.2), ("mount -l", 0, 0.01), ("lsof -b +M -n -l -P", 0, 4.6), ("findmnt", 0, 0.1)], timeout=600)
    add("systemd", 3.3, [("systemctl show --all", 0, 1.9), ("systemctl list-units", 0, 0.4), ("systemctl list-unit-files", 0, 0.5), ("systemd-analyze blame", 0, 0.5)], timeout=600)
    add("selinux", 2.9, [("sestatus -b", 0, 0.5), ("semanage fcontext -l", 0, 2.0), ("semodule -l", 0, 0.4)], timeout=600)
    add("dnf", 2.1, [("dnf -C repolist", 1, 2.0), ("dnf list installed", 0, 0.1)], timeout=600)
    add("lvm2", 1.3, [("vgdisplay -vv", 0, 0.5), ("pvs -a -v", 0, 0.4), ("lvs -a -o +devices", 0, 0.4)], timeout=600)
    add("hardware", 0.9, [("dmidecode", 0, 0.5), ("lspci -nnvv", 0, 0.4)], timeout=600)
    add("date", 0.1, [("date", 0, 0.01), ("date --utc", 0, 0.01), ("hwclock", 0, 0.05)], timeout=600)
    for i, name in enumerate(("auditd", "boot", "cgroups", "cron", "crypto", "dbus", "devices", "firewall_tables", "host", "i18n", "iscsi", "kdump", "keyutils", "libraries",
                              "login", "logrotate", "memory", "multipath", "nvme", "pam", "pci", "processor", "sar", "scsi", "services", "sos_extras", "ssh", "sunrpc", "system",
                              "tuned", "udev", "usb", "vdo", "virsh", "xfs", "yum", "zfs", "block", "console"), 1):
        add(name, round(0.05 + (i % 7) * 0.11, 3), [(f"{name}-info --all", 0, 0.03)] if i % 3 else [], timeout=600)
    plugins["ceph_common"] = _plugin(at, 0.0, [], plugin_times=False, files=["/etc/ceph/ceph.conf"])
    end = t0 + timedelta(seconds=189.9)
    return {
        "version": "4.5.6",
        "cmdline": "report --batch --label=master --plugin-timeout=600 --all-logs --chroot auto -k podman.logs=on,crio.logs=on,openshift.with-api=on",
        "start_time": _ts(t0),
        "end_time": _ts(end),
        "run_time": _td(189.9),
        "compression": "xz",
        "tmpdir": "/var/tmp",
        "policy": "Red Hat CoreOS",
        "preset": {"name": "ocp", "desc": "OpenShift Container Platform", "note": "", "opts": {"all_logs": True, "plugin_timeout": 600}},
        "components": {"report": {"sysinfo": {"hostname": "ip-192-0-2-46.example.internal", "kernel": "5.14.0-284.73.1.el9_2.x86_64"}, "plugins": plugins}},
    }


OCP_MASTER_NODE = "sosreport-ip-192-0-2-46-master-cluster-example-master-2026-10-01-abcdefg"


def old_manifest():
    """A manifest from an older sos: no components.report.plugins, no run
    times: the Blame tab shows its empty state."""
    return {
        "version": "4.1.0",
        "cmdline": "report --batch",
        "start_time": "2026-10-01 04:18:22",
        "end_time": "2026-10-01 04:21:32",
        "components": {"report": {"sysinfo": {"hostname": "old-01.example.test"}}},
    }


def dump(manifest):
    return json.dumps(manifest, indent=2) + "\n"
