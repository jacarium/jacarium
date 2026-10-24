#!/usr/bin/env python3
"""
The Disk / Control Groups / Network / SAR group's Findings (Phase 2, group 2
of the diagnostics review): a synthetic sosreport with planted problems,
parsed and rendered through the real Flask blueprint.

 1. Disk Usage: df from sos_commands/filesys when the root `df` is missing,
    human sizes, the inode table (df -ali), a filesystem at 96% (bad) and 91%
    (warn), inodes at 93% (warn), the pseudo filesystems after the real ones.
 2. LVM: a partial volume group (missing PV, bad), an inactive logical
    volume (warn), a thin pool at 92% (warn), a VG without free space (info).
 3. Control Groups: the cgroup v2 tree (memory.current / memory.max,
    cpu.max, cpu.stat) parsed into the v1 shape the pages read; a cgroup at
    98% of its memory limit (bad, linked to the OOM reports), a throttled
    cgroup (warn); the v1 tree still parses.
 4. Network: a bond with a slave down (bad), an interface with RX drops
    (warn), a DOWN interface carrying an address (warn), the addresses and
    the driver from ethtool -i, the VLAN interface name (eth0.100@eth0).
 5. SAR: per day, I/O wait over 20% (warn, linked to the disk tab), steal
    over 5%, a disk with await over 50 ms, an interface at 80% of its line
    rate, the EDEV drops; the findings() entry point keeps parse()'s day
    keys untouched.
 6. Every page of the group renders the strip (ui-findings) through the
    loader's `findings` variable; Disk Usage shows the Inodes column, the
    tints and the pseudo mark; Network shows the bond card and the address line.

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
from parsers.sosreport import cgroups_cpu, cgroups_memory, disk_lvm, disk_usage, network_stats, sar_cpu, sar_disk, sar_memory, sar_network  # noqa: E402

WORK = tempfile.mkdtemp(prefix="diag-findings2-")
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
    app.secret_key = "diagnostics-findings2-test"
    return app.test_client()


def render(c, directory, tab, sub_tab=None):
    body = {"directory": directory, "report_type": "sosreport", "tab": tab}
    if sub_tab:
        body["sub_tab"] = sub_tab
    r = c.post("/load_tab", json=body)
    return r.status_code, (r.get_json() or {}).get("html", "")


def titles(items):
    return [f["title"] for f in items]


def sev(items, s):
    return [f for f in items if f["severity"] == s]


def lvm_report(headers, rows, right):
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    fmt = lambda cells: "  " + " ".join((c.rjust(widths[i]) if headers[i] in right else c.ljust(widths[i])) for i, c in enumerate(cells)).rstrip() + "\n"  # noqa: E731
    return fmt(headers) + "".join(fmt(r) for r in rows)


def main():
    root = os.path.join(WORK, "sosreport-planted")
    os.makedirs(os.path.join(root, "sos_commands"), exist_ok=True)
    write(root, "date", "Mon Oct 12 14:30:01 UTC 2026\n")
    # 1. df ------------------------------------------------------------------------
    write(root, "sos_commands/filesys/df_-al_-x_autofs", (
        "Filesystem              1K-blocks      Used Available Use% Mounted on\n"
        "devtmpfs                     4096         0      4096   0% /dev\n"
        "tmpfs                    16384000  15728640    655360  96% /dev/shm\n"
        "/dev/mapper/rhel-root    52403200  47680000   4723200  91% /\n"
        "/dev/mapper/rhel-data   104806400  10480640  94325760  10% /data\n"
        "/dev/sda1                 1038336    250000    788336  25% /boot\n"))
    write(root, "sos_commands/filesys/df_-ali_-x_autofs", (
        "Filesystem               Inodes   IUsed    IFree IUse% Mounted on\n"
        "devtmpfs                4000000     500  3999500    1% /dev\n"
        "tmpfs                   4000000       5  3999995    1% /dev/shm\n"
        "/dev/mapper/rhel-root   3276800 3047424   229376   93% /\n"
        "/dev/mapper/rhel-data   6553600   10000  6543600    1% /data\n"
        "/dev/sda1                 65536     300    65236    1% /boot\n"))
    r = disk_usage.parse(root)
    f = r["findings"]
    rows = r["df"]["df"]
    check("df: read from sos_commands/filesys when the root df is missing; sizes human, inodes joined, the real filesystems first by use, pseudo after",
          r["df"]["source"].endswith("df_-al_-x_autofs") and [e["mounted"] for e in rows] == ["/", "/boot", "/data", "/dev/shm", "/dev"] and rows[0]["size_text"] == "50.0 GiB" and rows[0]["ipct"] == 93 and rows[3]["pseudo"], repr([(e["mounted"], e["size_text"], e["ipct"]) for e in rows]))
    check("df: /dev/shm at 96% is bad (pseudo noted), / at 91% a warning, its inodes at 93% a warning, worst first",
          titles(f)[0].startswith("/dev/shm (tmpfs) is 96% full") and "pseudo" in f[0]["detail"] and any(t.startswith("/ (/dev/mapper/rhel-root) is 91% full") for t in titles(sev(f, "warn"))) and any("93% of its inodes" in t for t in titles(sev(f, "warn"))), titles(f))
    bare = os.path.join(WORK, "bare")
    os.makedirs(os.path.join(bare, "sos_commands"), exist_ok=True)
    check("df: a report without df gives no rows and the no-data finding (info, never good)", disk_usage.parse(bare)["df"]["df"] == [] and [f["severity"] for f in disk_usage.parse(bare)["findings"]] == ["info"])

    # 2. LVM ------------------------------------------------------------------------
    S = {"PSize", "PFree", "DevSize", "PMdaFree", "PMdaSize", "#PMda", "#PMdaUse", "1st PE", "Ext", "#PV", "#LV", "#SN", "VSize", "VFree", "#VMda", "VMdaFree", "VMdaSize", "#VMdaUse", "LSize", "Data%", "Meta%", "Cpy%Sync", "KRahead", "Rahead", "#Str", "Stripe"}
    write(root, "sos_commands/lvm2/vgs_-v", lvm_report(disk_lvm.VGS_HEADERS, [
        ["rhel", "wz-pn-", "4.00m", "2", "3", "0", "<200.00g", "0", "oooooo-pppp", "", "2", "507.50k", "1020.00k", "1", "", ""],
        ["data", "wz--n-", "4.00m", "1", "1", "0", "1.82t", "1.00t", "aaaaaa-bbbb", "", "1", "507.50k", "1020.00k", "1", "", ""]], S))
    write(root, "sos_commands/lvm2/pvs_-a_-v", lvm_report(disk_lvm.PVS_HEADERS, [
        ["/dev/sda2", "rhel", "lvm2", "a--", "<100.00g", "0", "<100.00g", "cccccc-dddd", "507.50k", "1020.00k", "1", "1", "1.00m"],
        ["[unknown]", "rhel", "lvm2", "a-m", "<100.00g", "0", "<100.00g", "eeeeee-ffff", "507.50k", "1020.00k", "1", "1", "1.00m"],
        ["/dev/sdb", "data", "lvm2", "a--", "1.82t", "1.00t", "1.82t", "gggggg-hhhh", "507.50k", "1020.00k", "1", "1", "1.00m"]], S))
    write(root, "sos_commands/lvm2/lvs_-a_-o_lv_tags", lvm_report(disk_lvm.LVS_HEADERS, [
        ["root", "rhel", "-wi-ao----", "<95.00g", "", "", "", "", "", "", "", "", "/dev/sda2(0)", "128.00k", "auto", "1", "0"],
        ["old", "rhel", "-wi-------", "4.00g", "", "", "", "", "", "", "", "", "[unknown](0)", "128.00k", "auto", "1", "0"],
        ["pool0", "data", "twi-aotz--", "800.00g", "", "", "92.10", "41.00", "", "", "", "", "pool0_tdata(0)", "128.00k", "auto", "1", "0"],
        ["vm1", "data", "Vwi-aotz--", "500.00g", "pool0", "", "80.00", "", "", "", "", "", "", "128.00k", "auto", "1", "0"]], S))
    f = disk_lvm.parse(root)["findings"]
    check("lvm: the partial VG and the missing PV are bad, the inactive LV and the 92% thin pool warnings, the VG without free space informational",
          any("Volume group rhel is partial" in t for t in titles(sev(f, "bad"))) and any("Physical volume [unknown] is missing" == t for t in titles(sev(f, "bad")))
          and any("rhel/old is not active" in t for t in titles(sev(f, "warn"))) and any("Thin pool data/pool0 is 92.1% full" == t for t in titles(sev(f, "warn"))) and any("rhel has no free space" in t for t in titles(sev(f, "info"))), titles(f))
    check("lvm: a report without lvm2 says so (info), not an error", disk_lvm.parse(bare)["findings"][0]["severity"] == "info")

    # 3. cgroups v2 ---------------------------------------------------------------------
    v2 = os.path.join(WORK, "sosreport-v2")
    os.makedirs(os.path.join(v2, "sos_commands"), exist_ok=True)
    write(v2, "sys/fs/cgroup/cgroup.controllers", "cpuset cpu io memory pids\n")
    write(v2, "sys/fs/cgroup/memory.current", "0\n")
    write(v2, "sys/fs/cgroup/memory.max", "max\n")
    write(v2, "sys/fs/cgroup/cpu.max", "max 100000\n")
    write(v2, "sys/fs/cgroup/cpu.stat", "usage_usec 1\nnr_periods 0\nnr_throttled 0\n")
    write(v2, "sys/fs/cgroup/system.slice/memory.current", "4000000000\n")
    write(v2, "sys/fs/cgroup/system.slice/memory.max", "max\n")
    write(v2, "sys/fs/cgroup/system.slice/cpu.max", "max 100000\n")
    write(v2, "sys/fs/cgroup/system.slice/app.service/memory.current", "4200000000\n")
    write(v2, "sys/fs/cgroup/system.slice/app.service/memory.max", "4294967296\n")
    write(v2, "sys/fs/cgroup/system.slice/app.service/cpu.max", "200000 100000\n")
    write(v2, "sys/fs/cgroup/system.slice/app.service/cpu.stat", "usage_usec 99\nnr_periods 1000\nnr_throttled 400\nthrottled_usec 50\n")
    write(v2, "sys/fs/cgroup/system.slice/app.service/cpuset.cpus.effective", "0-3\n")
    write(v2, "sos_commands/memory/free_-m", "               total        used        free      shared  buff/cache   available\nMem:           16384        8000        4000         100        4384        8000\nSwap:              0           0           0\n")
    write(v2, "sos_commands/process/ps_auxwwwm", "USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\nroot 1 0.0 0.1 1 1 ? Ss Oct12 1:23 /usr/lib/systemd/systemd\n")
    m = cgroups_memory.parse(v2)
    mf = cgroups_memory.findings(v2)
    node = m["ps_auxwwwm"]["cgroup_data"]["system.slice"]["app.service"]
    check("cgroups memory v2: the unified tree is read into the v1 shape (usage, limit, percent), the version noted on the dataset, the 98% cgroup is bad and links to the OOM reports",
          m["ps_auxwwwm"]["cgroup_version"] == 2 and node["memory.usage_in_bytes"] == 4200000000 and node["memory.limit_in_bytes"] == 4294967296 and node["memory.usage_percent"] > 97
          and any("/system.slice/app.service at 97.8% of its memory limit" == t for t in titles(sev(mf, "bad"))) and mf[0]["link"]["sub_tab"] == "kernel_oom_killer" and "findings" not in m, repr((list(m), titles(mf))))
    c = cgroups_cpu.parse(v2)
    cf = cgroups_cpu.findings(v2)
    cnode = c["ps_auxwwwm"]["cgroup_data"]["system.slice"]["app.service"]
    check("cgroups cpu v2: cpu.max -> quota / period, the effective cpuset, the throttled cgroup (40% of the periods) is bad",
          c["ps_auxwwwm"]["cgroup_version"] == 2 and cnode["cpu.cfs_quota_us"] == 200000 and cnode["cpu.cfs_period_us"] == 100000 and cnode["cpuset.cpus"] == "0-3"
          and any("/system.slice/app.service was throttled in 400 periods (40%)" == t for t in titles(sev(cf, "bad"))) and "findings" not in c, repr((cnode, titles(cf))))
    write(root, "sys/fs/cgroup/memory/memory.usage_in_bytes", "0\n")
    write(root, "sys/fs/cgroup/memory/memory.limit_in_bytes", "9223372036854771712\n")
    write(root, "sys/fs/cgroup/memory/system.slice/memory.usage_in_bytes", "1000\n")
    write(root, "sys/fs/cgroup/memory/system.slice/memory.limit_in_bytes", "2000\n")
    write(root, "sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us", "-1\n")
    write(root, "sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us", "100000\n")
    write(root, "sys/fs/cgroup/cpu,cpuacct/cpuacct.usage_percpu", "1 2 3 4\n")
    write(root, "sys/fs/cgroup/cpuset/cpuset.cpus", "0-3\n")
    write(root, "sos_commands/memory/free_-m", "               total        used        free      shared  buff/cache   available\nMem:           16384        8000        4000         100        4384        8000\nSwap:              0           0           0\n")
    write(root, "sos_commands/process/ps_auxwwwm", "USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\nroot 1 0.0 0.1 1 1 ? Ss Oct12 1:23 /usr/lib/systemd/systemd\n")
    m1 = cgroups_memory.parse(root)
    check("cgroups v1: still read (version 1), the 50% cgroup is not flagged, the strip says no cgroup near its limit", m1["ps_auxwwwm"]["cgroup_version"] == 1 and any(t.startswith("No cgroup near") for t in titles(cgroups_memory.findings(root))), titles(cgroups_memory.findings(root)))

    # 4. network ---------------------------------------------------------------------------
    write(root, "sos_commands/networking/ip_-s_-d_link", (
        "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n"
        "    RX:  bytes packets errors dropped  missed   mcast\n       1000 10 0 0 0 0\n    TX:  bytes packets errors dropped carrier collsns\n       1000 10 0 0 0 0\n"
        "2: eth0: <BROADCAST,MULTICAST,SLAVE,UP,LOWER_UP> mtu 1500 qdisc fq_codel master bond0 state UP mode DEFAULT group default qlen 1000\n    link/ether 02:00:00:aa:00:01 brd ff:ff:ff:ff:ff:ff\n"
        "    RX:  bytes packets errors dropped  missed   mcast\n       98765432100 1000000 0 20000 0 123\n    TX:  bytes packets errors dropped carrier collsns\n       45678901234 900000 0 0 0 0\n"
        "3: eth1: <BROADCAST,MULTICAST,SLAVE> mtu 9000 qdisc fq_codel master bond0 state DOWN mode DEFAULT group default qlen 1000\n    link/ether 02:00:00:aa:00:02 brd ff:ff:ff:ff:ff:ff\n"
        "    RX:  bytes packets errors dropped  missed   mcast\n       0 0 0 0 0 0\n    TX:  bytes packets errors dropped carrier collsns\n       0 0 0 0 0 0\n"
        "4: bond0: <BROADCAST,MULTICAST,MASTER,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\n    link/ether 02:00:00:aa:00:01 brd ff:ff:ff:ff:ff:ff\n"
        "    RX:  bytes packets errors dropped  missed   mcast\n       98765432100 1000000 0 0 0 123\n    TX:  bytes packets errors dropped carrier collsns\n       45678901234 900000 0 0 0 0\n"
        "5: eth0.100@eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\n    link/ether 02:00:00:aa:00:01 brd ff:ff:ff:ff:ff:ff\n"
        "    RX:  bytes packets errors dropped  missed   mcast\n       100 1 0 0 0 0\n    TX:  bytes packets errors dropped carrier collsns\n       100 1 0 0 0 0\n"
        "6: eth2: <BROADCAST,MULTICAST> mtu 1500 qdisc fq_codel state DOWN mode DEFAULT group default qlen 1000\n    link/ether 02:00:00:aa:00:03 brd ff:ff:ff:ff:ff:ff\n"
        "    RX:  bytes packets errors dropped  missed   mcast\n       0 0 0 0 0 0\n    TX:  bytes packets errors dropped carrier collsns\n       0 0 0 0 0 0\n"))
    write(root, "sos_commands/networking/ip_-d_address", (
        "4: bond0: <BROADCAST,MULTICAST,MASTER,UP,LOWER_UP> mtu 1500 state UP\n    inet 192.0.2.10/24 brd 192.0.2.255 scope global bond0\n    inet6 fe80::1/64 scope link\n"
        "6: eth2: <BROADCAST,MULTICAST> mtu 1500 state DOWN\n    inet 198.51.100.7/24 brd 198.51.100.255 scope global eth2\n"))
    write(root, "proc/net/bonding/bond0", "Ethernet Channel Bonding Driver: v4.18\n\nBonding Mode: fault-tolerance (active-backup)\nMII Status: up\n\nSlave Interface: eth0\nMII Status: up\nSpeed: 10000 Mbps\nLink Failure Count: 0\n\nSlave Interface: eth1\nMII Status: down\nSpeed: Unknown\nLink Failure Count: 5\n")
    write(root, "sos_commands/networking/ethtool_-i_eth0", "driver: ixgbe\nversion: 5.1.0-k\nfirmware-version: 0x800003e7\nbus-info: 0000:3b:00.0\n")
    n = network_stats.parse(root)
    f = n["findings"]
    check("network: the bond's slave down is bad (with the failures and the MTU mismatch as warnings), eth0's 2% RX drops bad, eth2 DOWN with an address a warning",
          any("bond0: slave eth1 down" == t for t in titles(sev(f, "bad"))) and any("eth0:" in t and "RX drops" in t for t in titles(sev(f, "bad"))) and any("eth2 is DOWN but configured" == t for t in titles(sev(f, "warn")))
          and any("link failures on eth1 (5)" in t for t in titles(sev(f, "warn"))) and any("different MTUs (1500, 9000)" in t for t in titles(sev(f, "warn"))), titles(f))
    check("network: the VLAN name, the master, the addresses and the ethtool driver are on the interfaces",
          "eth0.100" in n["ip_info"] and n["ip_info"]["eth0"]["master"] == "bond0" and n["ip_info"]["bond0"]["addresses"] == ["192.0.2.10/24"] and n["ip_info"]["eth0"]["ethtool"]["driver"] == "ixgbe" and n["bonds"]["bond0"]["slaves"][1]["mii_status"] == "down", repr(n["ip_info"].get("eth0")))

    # 5. sar ----------------------------------------------------------------------------------
    head = "Linux 5.14.0 (host.example.test) \t10/12/2026 \t_x86_64_\t(4 CPU)\n\n"
    cpu = ["00:00:01        CPU      %usr     %nice      %sys   %iowait    %steal      %irq     %soft    %guest    %gnice     %idle"]
    mem = ["00:00:01    kbmemfree   kbavail kbmemused  %memused kbbuffers  kbcached  kbcommit   %commit  kbactive   kbinact   kbdirty"]
    net = ["00:00:01        IFACE   rxpck/s   txpck/s    rxkB/s    txkB/s   rxcmp/s   txcmp/s  rxmcst/s   %ifutil"]
    edev = ["00:00:01        IFACE   rxerr/s   txerr/s    coll/s  rxdrop/s  txdrop/s  txcarr/s  rxfram/s  rxfifo/s  txfifo/s"]
    disk = ["00:00:01          DEV       tps     rkB/s     wkB/s     dkB/s   areq-sz    aqu-sz     await     %util"]
    for i in range(6):
        ts = f"{i:02d}:10:01"
        iow, steal = (30.0, 6.0) if i in (2, 3) else (0.5, 0.0)
        cpu.append(f"{ts}        all     20.00      0.00      5.00     {iow:>5.2f}      {steal:>4.2f}      0.10      0.25      0.00      0.00     {100 - 25 - iow - steal:>5.2f}")
        mem.append(f"{ts}       400000    600000  16000000     97.50    100000   2000000  40000000    125.00  25000000   3000000      2000")
        net.append(f"{ts}       eth0   90000.00  70000.00 1200000.00 900000.00      0.00      0.00     10.00     {95.0 if i == 4 else 20.0:>5.2f}")
        edev.append(f"{ts}       eth0      0.00      0.00      0.00     {3.0 if i == 1 else 0.0:>5.2f}      0.00      0.00      0.00      0.00      0.00")
        disk.append(f"{ts}       sda     10.00    300.00    700.00      0.00    100.00      0.01     {250.0 if i == 2 else 1.4:>6.2f}      7.30")
    body = head + "\n".join(cpu) + "\nAverage:        all     20.00      0.00      5.00      1.00      0.00      0.10      0.25      0.00      0.00     73.65\n\n" + "\n".join(mem) + "\nAverage:       400000    600000  16000000     97.50    100000   2000000  40000000    125.00  25000000   3000000      2000\n\n" + "\n".join(net) + "\nAverage:         eth0   90000.00  70000.00 1200000.00 900000.00      0.00      0.00     10.00     32.50\n\n" + "\n".join(edev) + "\nAverage:         eth0      0.00      0.00      0.00      0.50      0.00      0.00      0.00      0.00      0.00\n\n" + "\n".join(disk) + "\nAverage:          sda     10.00    300.00    700.00      0.00    100.00      0.01     42.83      7.30\n"
    write(root, "sos_commands/sar/sar12", body)
    fc = sar_cpu.findings(root)
    check("sar cpu: I/O wait over 20% in 2 of 6 samples (warn, peak 30% at 02:10:01, linked to the disk tab) and steal over 5%",
          any(t.startswith("day 12: I/O wait over 20% in 2 of 6 samples (peak 30% at 02:10:01)") and x["link"]["sub_tab"] == "sar_disk" for t, x in zip(titles(fc), fc)) and any("CPU steal over 5% in 2 of 6" in t for t in titles(fc)), titles(fc))
    check("sar cpu: parse() keeps its day keys only (no findings key among the days)", list(sar_cpu.parse(root)) == ["day_12"])
    fm = sar_memory.findings(root)
    check("sar memory: under 5% available in every sample is bad (kbavail), linked to the memory cgroups", fm[0]["severity"] == "bad" and "under 5% of memory available in 6 of 6" in fm[0]["title"] and fm[0]["link"]["sub_tab"] == "cgroups_memory", titles(fm))
    fn = sar_network.findings(root)
    check("sar network: eth0 at 80%+ of its line rate (1 of 6), the EDEV drops in 1 of 6 samples", any("eth0 at 80%+ of its line rate in 1 of 6" in t for t in titles(fn)) and any("eth0 dropped or errored packets in 1 of 6" in t for t in titles(fn)), titles(fn))
    fd = sar_disk.findings(root)
    check("sar disk: sda at 250 ms is bad (over 200), linked to the CPU tab", fd[0]["severity"] == "bad" and "sda answered in 50+ ms in 1 of 6 samples (peak 250 ms at 02:10:01)" in fd[0]["title"] and fd[0]["link"]["sub_tab"] == "sar_cpu", titles(fd))

    # 6. the pages -------------------------------------------------------------------------------
    c = client()
    for tab, sub in (("disk", "disk_usage"), ("disk", "disk_lvm"), ("cgroups", "cgroups_cpu"), ("cgroups", "cgroups_memory"), ("network", "network_stats"), ("sar", "sar_cpu"), ("sar", "sar_memory"), ("sar", "sar_network"), ("sar", "sar_disk")):
        status, html = render(c, root, tab, sub)
        check(f"page {sub}: renders with the Findings strip", status == 200 and 'class="ui-findings"' in html and html.count('class="ui-finding ') >= 1, f"status {status}")
    status, html = render(c, root, "disk", "disk_usage")
    check("page disk_usage: the Inodes column, the human sizes, the row tints and the pseudo mark", "Inodes" in html and "50.0 GiB" in html and 'class="ui-row-bad' in html and 'class="ui-row-warn' in html and "(pseudo)" in html and "93%" in html)
    status, html = render(c, root, "network", "network_stats")
    check("page network_stats: the bond card with its slaves, the address line, the driver", "bond0 - fault-tolerance (active-backup)" in html and "192.0.2.10/24" in html and "ixgbe 5.1.0-k" in html and "slave of bond0" in html)
    status, html = render(c, v2, "cgroups", "cgroups_memory")
    check("page cgroups_memory (v2): renders", status == 200 and 'class="ui-findings"' in html)

    shutil.rmtree(WORK, ignore_errors=True)
    failed = [l for l, ok in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
