#!/usr/bin/env python3
"""
Edge cases of the sosreport parsers against real-world layouts the mock
reports do not carry (synthetic snippets, built into a scratch directory):

 1. Disk > LVM: a report without the lvm2 plugin gives empty lists, not a
    FileNotFoundError; a right-aligned size wider than its header
    (`<100.00g` under PSize) stays whole; the two-word headers (PV UUID,
    VG Tags) come through by name.
 2. OpenStack > DPDK: a report without proc/cmdline renders (it raised).
 3. System: `free -m` of procps 3.3.10 (RHEL 7: buffers / cached, no
    `available`) parses with an estimated available; the modern layout
    keeps its real one; values in GiB.
 4. PCI: sos 4's sos_commands/pci/lspci_-nnvv is found; a plain `lspci`
    capture (no ids) and a numeric `-nvv` one list their devices too.
 5. SAR: sos_commands/sar/sarDD is read when var/log/sa has no text file; a
    12-hour clock (`12:10:01 AM`, `01:10:01 PM`) lands on 24-hour times
    in all four parsers; `%user` counts as `%usr`; the EDEV error block is
    not merged into the DEV series.
 6. Scheduler Debug: proc/sched_debug (RHEL 8) with nine-column task lines
    parses its tasks; the error names the paths looked for.
 7. HAProxy: the log's year comes from the report's `date` capture.
 8. Processes: a non-UTF-8 byte in a command line does not fail the tab;
    `ps auxwww` (sos < 4) is read when the -m capture is missing; the three
    tabs share one ps parser.

Needs the backend venv for nothing beyond the standard library; run-all.sh
picks it up as a .test.py.
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(REPO, "backend"))

from parsers.sosreport import _common, cgroups_cpu, cgroups_memory, disk_lvm, haproxy, openstack_dpdk, pci_devices, processes, sar_cpu, sar_disk, sar_memory, sar_network, sched_debug, system  # noqa: E402

WORK = tempfile.mkdtemp(prefix="diag-edge-")
results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok)))
    print(("  ok    " if ok else "  FAIL  ") + label + (f": {detail}" if detail and not ok else ""))


def report(name, files):
    """A synthetic report directory: {relative path: text or bytes}."""
    root = os.path.join(WORK, name)
    for rel, body in files.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        mode = "wb" if isinstance(body, bytes) else "w"
        with open(p, mode) as f:
            f.write(body)
    os.makedirs(root, exist_ok=True)
    return root


def lvm_report(headers, rows, right):
    """Text the way lvm prints a report: every column as wide as its widest
    value or header, text left-aligned, sizes and counts (the `right` set)
    right-aligned to the header's end, one space between columns, two
    leading spaces."""
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    def fmt(cells, is_header=False):
        out = []
        for i, c in enumerate(cells):
            if headers[i] in right and not is_header:
                out.append(c.rjust(widths[i]))
            elif headers[i] in right:
                out.append(c.rjust(widths[i]))
            else:
                out.append(c.ljust(widths[i]))
        return "  " + " ".join(out).rstrip() + "\n"
    return fmt(headers, True) + "".join(fmt(r) for r in rows)


def main():
    # 1. LVM ------------------------------------------------------------------
    bare = report("bare", {"uptime": " 09:31:55 up 3 days,  2:10,  1 user,  load average: 0.10, 0.20, 0.30\n"})
    try:
        out = disk_lvm.parse(bare)
        check("lvm: a report without sos_commands/lvm2 gives empty lists", out["lvm"] == {"vgs": [], "pvs": [], "lvs": []}, repr(out))
    except Exception as e:  # noqa: BLE001
        check("lvm: a report without sos_commands/lvm2 gives empty lists", False, repr(e))
    SIZES = {"PSize", "PFree", "DevSize", "PMdaFree", "PMdaSize", "#PMda", "#PMdaUse", "1st PE", "Ext", "#PV", "#LV", "#SN", "VSize", "VFree", "#VMda", "VMdaFree", "VMdaSize", "#VMdaUse", "LSize", "Data%", "Meta%", "Cpy%Sync", "KRahead", "Rahead", "#Str", "Stripe"}
    lvm = report("lvm", {
        "sos_commands/lvm2/pvs_-a_-v_-o_pv_mda_free_pv_mda_size_pv_mda_count_pv_mda_used_count_pe_start_--config_global_locking_type_0": lvm_report(
            disk_lvm.PVS_HEADERS,
            [["/dev/sda2", "rhel", "lvm2", "a--", "<100.00g", "4.00m", "<100.00g", "aaaaaa-bbbb-cccc-dddd-eeee-ffff-gggggg", "507.50k", "1020.00k", "1", "1", "1.00m"],
             ["/dev/sdb", "data", "lvm2", "a--", "1.82t", "1.82t", "1.82t", "hhhhhh-iiii-jjjj-kkkk-llll-mmmm-nnnnnn", "507.50k", "1020.00k", "1", "1", "1.00m"]], SIZES),
        "sos_commands/lvm2/vgs_-v_-o_vg_mda_count_vg_mda_free_vg_mda_size_vg_mda_used_count_vg_tags_systemid_--config_global_locking_type_0": lvm_report(
            disk_lvm.VGS_HEADERS,
            [["rhel", "wz--n-", "4.00m", "1", "2", "0", "<100.00g", "4.00m", "oooooo-pppp-qqqq-rrrr-ssss-tttt-uuuuuu", "", "1", "507.50k", "1020.00k", "1", "prod", ""]], SIZES),
        "sos_commands/lvm2/lvs_-a_-o_lv_tags_devices_lv_kernel_read_ahead_lv_read_ahead_stripes_stripesize_--config_global_locking_type_0": lvm_report(
            disk_lvm.LVS_HEADERS,
            [["root", "rhel", "-wi-ao----", "<95.00g", "", "", "", "", "", "", "", "", "/dev/sda2(0)", "128.00k", "auto", "1", "0"],
             ["swap", "rhel", "-wi-ao----", "4.00g", "", "", "", "", "", "", "", "", "/dev/sda2(24320)", "128.00k", "auto", "1", "0"]], SIZES),
    })
    out = disk_lvm.parse(lvm)["lvm"]
    pv = out["pvs"][0]
    check("lvm: a right-aligned size wider than its header stays whole (PSize <100.00g, PFree 4.00m, DevSize <100.00g)", pv["PSize"] == "<100.00g" and pv["PFree"] == "4.00m" and pv["DevSize"] == "<100.00g", repr(pv))
    check("lvm: the two-word headers land by name (PV UUID, 1st PE; VG Tags, System ID)", pv["PV UUID"].startswith("aaaaaa-") and pv["1st PE"] == "1.00m" and out["vgs"][0]["VG Tags"] == "prod" and out["vgs"][0]["System ID"] == "" and out["vgs"][0]["VSize"] == "<100.00g", repr((pv, out["vgs"][0])))
    check("lvm: lvs rows keep LSize / Devices / Attr and empty columns stay empty", out["lvs"][0]["LSize"] == "<95.00g" and out["lvs"][0]["Devices"] == "/dev/sda2(0)" and out["lvs"][0]["Attr"] == "-wi-ao----" and out["lvs"][0]["Pool"] == "" and out["lvs"][1]["LSize"] == "4.00g", repr(out["lvs"]))

    # 2. DPDK ------------------------------------------------------------------
    try:
        out = openstack_dpdk.parse(bare)
        check("dpdk: a report without proc/cmdline renders (cmdline empty)", isinstance(out, dict) and out.get("cmdline") == {}, repr(out.get("cmdline")))
    except Exception as e:  # noqa: BLE001
        check("dpdk: a report without proc/cmdline renders (cmdline empty)", False, repr(e))

    # 3. free -m ---------------------------------------------------------------
    rhel7 = report("rhel7", {"sos_commands/memory/free_-m": (
        "              total        used        free      shared     buffers      cached\n"
        "Mem:          32768       20480        4096         512        1024        7168\n"
        "-/+ buffers/cache:       12288       20480\n"
        "Swap:          4095           0        4095\n")})
    rhel9 = report("rhel9", {"sos_commands/memory/free_-m": (
        "               total        used        free      shared  buff/cache   available\n"
        "Mem:           32768       20480        4096         512        8192       11264\n"
        "Swap:           4095           0        4095\n")})
    try:
        m7 = system.parse(rhel7)["free_memory"]
        check("free: RHEL 7's six columns parse (buff_cache = buffers + cached, available estimated as free + buff_cache, GiB)",
              m7["total"] == 32.0 and m7["buff_cache"] == 8.0 and m7["available"] == 12.0 and m7["available_estimated"] is True, repr(m7))
    except Exception as e:  # noqa: BLE001
        check("free: RHEL 7's six columns parse", False, repr(e))
    m9 = system.parse(rhel9)["free_memory"]
    check("free: the modern layout keeps its real available (11 GiB) and is not flagged", m9["available"] == 11.0 and m9["available_estimated"] is False and m9["buff_cache"] == 8.0, repr(m9))
    check("free: the cgroups Memory tab reads the same file in MiB through the shared parser", _common.parse_free(os.path.join(rhel7, "sos_commands/memory/free_-m"))["total"] == 32768 and cgroups_memory.parse_free is _common.parse_free)

    # 4. lspci -----------------------------------------------------------------
    nn = report("pci-nn", {"sos_commands/pci/lspci_-nnvv": (
        "00:00.0 Host bridge [0600]: Example Silicon Host Bridge [1ab8:0001] (rev 02)\n\tSubsystem: Example Systems Device [1ab8:1100]\n\n"
        "0000:3b:00.0 Ethernet controller [0200]: Example Silicon 10GbE Adapter [1ab8:10fb] (rev 01)\n\tKernel driver in use: ixgbe\n")})
    out = pci_devices.parse(nn)
    check("pci: sos 4's sos_commands/pci/lspci_-nnvv is read (slot, class id, vendor:device, revision, details)",
          out.get("source") == "sos_commands/pci/lspci_-nnvv" and len(out["lspci"]) == 2 and out["lspci"][1]["slot"] == "0000:3b:00.0" and out["lspci"][1]["class_id"] == "0200"
          and out["lspci"][1]["vendor_id"] == "1ab8" and out["lspci"][1]["device_id"] == "10fb" and out["lspci"][1]["revision"] == "01" and out["lspci"][1]["details"] == ["\tKernel driver in use: ixgbe"], repr(out))
    plain = report("pci-plain", {"sos_commands/hardware/lspci": (
        "00:00.0 Host bridge: Example Silicon Host Bridge (rev 02)\n"
        "00:03.0 Ethernet controller: Example Silicon Virtio network device\n"
        "00:1f.2 SATA controller: Example Silicon 6 port SATA Controller [AHCI mode] (rev 02)\n")})
    out = pci_devices.parse(plain)["lspci"]
    check("pci: a plain lspci capture (no ids) lists its devices with class and description", len(out) == 3 and out[1]["class"] == "Ethernet controller" and out[1]["description"] == "Example Silicon Virtio network device" and out[1]["vendor_id"] == ""
          and out[2]["description"] == "Example Silicon 6 port SATA Controller [AHCI mode]" and out[2]["revision"] == "02" and out[0]["revision"] == "02", repr(out))
    numeric = report("pci-n", {"sos_commands/hardware/lspci_-nvv": "00:03.0 0200: 1ab8:1000\n\tSubsystem: 1ab8:0001\n\n00:1f.2 0106: 1ab8:2922 (rev 02)\n"})
    out = pci_devices.parse(numeric)["lspci"]
    check("pci: a numeric -nvv capture lists its devices with the ids", len(out) == 2 and out[0]["class_id"] == "0200" and out[0]["vendor_id"] == "1ab8" and out[0]["device_id"] == "1000" and out[1]["revision"] == "02", repr(out))
    check("pci: a report without any lspci capture gives no devices and the no-data finding", "lspci" not in pci_devices.parse(bare) and pci_devices.parse(bare)["findings"][0]["severity"] == "info")

    # 5. sar -------------------------------------------------------------------
    sar12 = (
        "Linux 4.18.0-553.el8_10.x86_64 (host.example.test) \t10/12/2026 \t_x86_64_\t(4 CPU)\n\n"
        "12:00:01 AM     CPU     %user     %nice   %system   %iowait    %steal     %idle\n"
        "12:10:01 AM     all      5.00      0.00      1.00      0.50      0.00     93.50\n"
        "12:10:01 AM       0      6.00      0.00      1.00      0.50      0.00     92.50\n"
        "01:10:01 PM     all     25.00      0.00      3.00      1.50      0.00     70.50\n"
        "01:10:01 PM       0     26.00      0.00      3.00      1.50      0.00     69.50\n"
        "Average:        all     15.00      0.00      2.00      1.00      0.00     82.00\n\n"
        "12:00:01 AM kbmemfree   kbavail kbmemused  %memused kbbuffers  kbcached  kbcommit   %commit  kbactive   kbinact   kbdirty\n"
        "12:10:01 AM   4000000   6000000  28000000     87.50    100000   2000000  40000000    125.00  25000000   3000000      2000\n"
        "01:10:01 PM   3000000   5000000  29000000     90.60    100000   2000000  41000000    128.00  26000000   3000000      2100\n"
        "Average:      3500000   5500000  28500000     89.05    100000   2000000  40500000    126.50  25500000   3000000      2050\n\n"
        "12:00:01 AM     IFACE   rxpck/s   txpck/s    rxkB/s    txkB/s   rxcmp/s   txcmp/s  rxmcst/s   %ifutil\n"
        "12:10:01 AM      eth0   1000.00    700.00   1300.00    900.00      0.00      0.00     10.00      1.00\n"
        "01:10:01 PM      eth0   2000.00   1400.00   2600.00   1800.00      0.00      0.00     20.00      2.00\n"
        "Average:         eth0   1500.00   1050.00   1950.00   1350.00      0.00      0.00     15.00      1.50\n\n"
        "12:00:01 AM     IFACE   rxerr/s   txerr/s    coll/s  rxdrop/s  txdrop/s  txcarr/s  rxfram/s  rxfifo/s  txfifo/s\n"
        "12:10:01 AM      eth0      0.00      0.00      0.00      3.00      0.00      0.00      0.00      0.00      0.00\n"
        "01:10:01 PM      eth0      0.00      0.00      0.00      4.00      0.00      0.00      0.00      0.00      0.00\n"
        "Average:         eth0      0.00      0.00      0.00      3.50      0.00      0.00      0.00      0.00      0.00\n\n"
        "12:00:01 AM       DEV       tps     rkB/s     wkB/s     dkB/s   areq-sz    aqu-sz     await     %util\n"
        "12:10:01 AM       sda     10.00    300.00    700.00      0.00    100.00      0.01      1.40      7.30\n"
        "01:10:01 PM       sda     20.00    600.00   1400.00      0.00    100.00      0.02      2.80     14.60\n"
        "Average:          sda     15.00    450.00   1050.00      0.00    100.00      0.02      2.10     10.95\n")
    sar = report("sar", {"sos_commands/sar/sar12": sar12, "var/log/sa/sa12": b"\x00\x01binary"})
    cpu = sar_cpu.parse(sar)
    check("sar cpu: sos_commands/sar/sarDD is read, the 12-hour clock lands on 24-hour times, %user counts as %usr",
          list(cpu) == ["day_12"] and [p["time"] for p in cpu["day_12"]["all"]] == ["00:10:01", "13:10:01"] and cpu["day_12"]["all"][1]["%usr"] == 25.0 and cpu["day_12"]["0"][0]["%idle"] == 92.5, repr(cpu))
    mem = sar_memory.parse(sar)
    check("sar memory: the 12-hour clock lands on 24-hour times", [p["time"] for p in mem["day_12"]] == ["00:10:01", "13:10:01"] and mem["day_12"][1]["%memused"] == 90.6, repr(mem))
    net = sar_network.parse(sar)
    check("sar network: the DEV series only (two points for eth0, rxpck/s present, no rxerr/s mixed in), on 24-hour times",
          [p["time"] for p in net["day_12"]["eth0"]] == ["00:10:01", "13:10:01"] and all("rxpck/s" in p and "rxerr/s" not in p for p in net["day_12"]["eth0"]), repr(net))
    edev = sar_network.parse_sar_iface(os.path.join(sar, "sos_commands/sar/sar12"), block="EDEV")
    check("sar network: the EDEV block is available apart (rxdrop/s 3.0 then 4.0)", [p["rxdrop/s"] for p in edev["eth0"]] == [3.0, 4.0], repr(edev))
    disk = sar_disk.parse(sar)
    check("sar disk: the 12-hour clock lands on 24-hour times", [p["time"] for p in disk["day_12"]["sda"]] == ["00:10:01", "13:10:01"] and disk["day_12"]["sda"][1]["await"] == 2.8, repr(disk))
    both = report("sar-both", {"sos_commands/sar/sar12": sar12, "var/log/sa/sar12": sar12.replace("01:10:01 PM     all     25.00", "01:10:01 PM     all     35.00")})
    check("sar: var/log/sa/sarDD wins over sos_commands/sar/sarDD for the same day", sar_cpu.parse(both)["day_12"]["all"][1]["%usr"] == 35.0)
    check("sar: a report without sar files gives the empty state (no exception)", sar_cpu.parse(bare) == {} and sar_disk.parse(bare) == {})

    # 6. sched_debug -------------------------------------------------------------
    rhel8 = report("sched8", {"proc/sched_debug": (
        "Sched Debug Version: v0.11, 4.18.0-553.el8_10.x86_64 #1\n"
        "ktime                                   : 1000.000000\n\n"
        "cpu#0, 2400.000 MHz\n  .nr_running                    : 1\n  .nr_switches                   : 100\n  .curr->pid                     : 4311\n\n"
        "cfs_rq[0]:/\n  .exec_clock                    : 0.000000\n  .nr_running                    : 1\n\n"
        "rt_rq[0]:\n  .rt_nr_running                 : 0\n\n"
        "runnable tasks:\n"
        " S           task   PID         tree-key  switches  prio     wait-time             sum-exec        sum-sleep\n"
        "-----------------------------------------------------------------------------------------------------------\n"
        " S         systemd     1      1234.567890      1000   120         0.500000        100.000000       2000.000000 /\n"
        ">R  example-worker  4311     98765.432100     50000   120         2.250000      90000.000000      10000.000000 /system.slice/example-worker.service\n"
        " S      kworker/0:1    12       100.000000       500   120         0.010000         10.000000         50.000000\n\n")})
    out = sched_debug.parse(rhel8)["sched"]
    tasks = out["per_cpu"][0]["tasks"] if out.get("per_cpu") else []
    check("sched: proc/sched_debug (RHEL 8) is read and its nine-column task lines parse (sum_block 0.0, the group kept, a line without a group too)",
          out.get("source") == "proc/sched_debug" and len(tasks) == 3 and tasks[1]["name"] == "example-worker" and tasks[1]["state"] == ">R" and tasks[1]["wait_time"] == 2.25 and tasks[1]["sum_exec"] == 90000.0
          and tasks[1]["sum_block"] == 0.0 and tasks[1]["group"] == "/system.slice/example-worker.service" and tasks[2]["group"] == "" and tasks[0]["group"] == "/", repr(tasks))
    rhel9_line = " S         systemd     1      1234.567890      1000   120         0.500000        100.000000       2000.000000         0.000000 /\n"
    out9 = sched_debug.parse_sched_debug("cpu#0, 2400.000 MHz\n\nrunnable tasks:\n S task PID tree-key switches prio wait-time sum-exec sum-sleep sum-block\n----\n" + rhel9_line)
    check("sched: the ten-column RHEL 9 line still parses with its sum_block", len(out9["per_cpu"][0]["tasks"]) == 1 and out9["per_cpu"][0]["tasks"][0]["sum_block"] == 0.0 and out9["per_cpu"][0]["tasks"][0]["group"] == "/", repr(out9["per_cpu"][0]["tasks"]))
    err = sched_debug.parse(bare)["sched"]
    check("sched: a report without a capture names the three paths looked for", "proc/sched_debug" in err.get("error", "") and "sys/kernel/debug/sched/debug" in err["error"], repr(err))

    # 7. haproxy year --------------------------------------------------------------
    hap = report("haproxy", {
        "date": "Mon Dec 15 10:00:00 UTC 2025\n",
        "var/log/containers/haproxy/haproxy.log": (
            "Dec 15 10:00:01 host haproxy[1234]: 10.0.0.1:50000 [15/Dec/2025:10:00:01.000] fe be/srv1 0/0/1/2/3 200 1000 - - ---- 1/1/0/0/0 0/0 \"GET / HTTP/1.1\"\n"
            "Dec 15 10:00:02 host haproxy[1234]: Server be/srv2 is DOWN, reason: Layer4 timeout\n"),
    })
    check("haproxy: the report's year comes from the `date` capture", _common.report_year(hap) == 2025 and _common.report_year(bare) >= 2024)
    data = haproxy.parse_haproxy_logs(os.path.join(hap, "var/log/containers/haproxy"), "haproxy.log", _common.report_year(hap))
    check("haproxy: the log timestamps carry the report's year (2025), the server-down line is an issue", data and all(t.year == 2025 for t in data["timestamps"]) and len(data["issues"]["server_down"]) == 1, repr(data and [t.isoformat() for t in data["timestamps"]]))

    # 8. ps ---------------------------------------------------------------------------
    ps = report("ps", {"sos_commands/process/ps_auxwwwm": (
        "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n"
        "root           1  0.0  0.1 171000 12000 ?        Ss   Oct12   1:23 /usr/lib/systemd/systemd --switched-root\n"
        "root           -  0.0    -      -     - -        Ss   Oct12   1:23 -\n").encode() + b"app         2305  1.2  0.5 400000 50000 ?        Sl   Oct12   9:00 /opt/app/bin/worker --name=caf\xe9\n"})
    out = processes.parse(ps)["ps_auxwwwm"]
    check("ps: a non-UTF-8 byte in a command line does not fail the tab (two processes, the thread line attached to its process)",
          "error" not in out and len(out["processes"]) == 2 and out["processes"][0]["thread_count"] == 1 and out["processes"][0]["threads"][0]["PID"] == "1" and out["processes"][1]["COMMAND"].startswith("/opt/app/bin/worker"), repr(out)[:300])
    old = report("ps-old", {"sos_commands/process/ps_auxwww": "USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\nroot 1 0.0 0.1 1 1 ? Ss Oct12 1:23 /sbin/init\n"})
    check("ps: sos < 4's ps_auxwww is read when ps_auxwwwm is missing", processes.parse(old)["ps_auxwwwm"]["processes"][0]["COMMAND"] == "/sbin/init")
    # the thread ids: a busy process at 28.5% whose threads carry their own averages (one short-lived thread at 95%)
    psm = ("USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n"
           "svcuser    18130 28.5 61.2 601000 20000 ?        -    Sep19   0:00 /usr/libexec/example-worker --queue payments\n"
           "svcuser        - 12.0    -      -     - -        Sl   Sep19 120:00 -\n"
           "svcuser        - 95.0    -      -     - -        Rl   14:01   0:57 -\n"
           "svcuser        -  3.1    -      -     - -        Sl   Sep19  31:00 -\n")
    axo = ("18130 1 svcuser svcuser 18130 3 Sep19 example-worker 0::/system.slice/example-worker.service\n"
           "18130 1 svcuser svcuser 18131 3 14:01 worker-thread 0::/system.slice/example-worker.service\n"
           "18130 1 svcuser svcuser 18132 3 Sep19 example-worker 0::/system.slice/example-worker.service\n")
    joined = report("ps-tids", {"sos_commands/process/ps_auxwwwm": psm, "sos_commands/process/ps_axo_pid_ppid_user_group_lwp_nlwp_start_time_comm_cgroup": axo})
    out = processes.parse(joined)["ps_auxwwwm"]
    proc = out["processes"][0]
    threads = proc["threads"]
    check("ps: the thread ids are joined from the ps axo ... lwp capture (by position, the counts agreeing)", out.get("thread_ids") is True and [t.get("TID") for t in threads] == ["18130", "18131", "18132"] and threads[1].get("NAME") == "worker-thread", [(t.get("TID"), t.get("NAME")) for t in threads])
    check("ps: the process %CPU stays the lifetime average (28.5) while a thread shows 95", proc["%CPU"] == "28.5" and threads[1]["%CPU"] == "95.0")
    elfl = ("F S UID        PID  PPID   LWP  C NLWP PRI  NI ADDR SZ WCHAN  STIME TTY          TIME CMD\n"
            "4 S svcuser  18130     1 18130  0    3  80   0 -  1500 -      Sep19 ?        00:00:00 /usr/libexec/example-worker\n"
            "1 R svcuser  18130     1 18131 95    3  80   0 -  1500 -      14:01 ?        00:00:57 /usr/libexec/example-worker\n"
            "1 S svcuser  18130     1 18132  3    3  80   0 -  1500 -      Sep19 ?        00:31:00 /usr/libexec/example-worker\n")
    joined2 = report("ps-elfl", {"sos_commands/process/ps_auxwwwm": psm, "sos_commands/process/ps_-elfL": elfl})
    t2 = processes.parse(joined2)["ps_auxwwwm"]["processes"][0]["threads"]
    check("ps: ps -elfL serves the thread ids when the axo capture is missing", [t.get("TID") for t in t2] == ["18130", "18131", "18132"], [t.get("TID") for t in t2])
    alone = report("ps-notids", {"sos_commands/process/ps_auxwwwm": psm})
    out3 = processes.parse(alone)["ps_auxwwwm"]
    check("ps: without a thread-level capture the dataset says the ids were not captured", out3.get("thread_ids") is False and all(not t.get("TID") for t in out3["processes"][0]["threads"]))
    check("ps: the CPU hog finding says the figure is averaged since start", any("averaged since start" in f["title"] for f in processes.parse(report("ps-hog", {"sos_commands/process/ps_auxwwwm": psm.replace("28.5", "88.6")}))["findings"]))
    check("ps: the three tabs share one parser", processes.parse_ps_file is _common.parse_ps_file and cgroups_cpu.parse_ps_file is _common.parse_ps_file and cgroups_memory.parse_ps_file is _common.parse_ps_file)

    shutil.rmtree(WORK, ignore_errors=True)
    failed = [l for l, ok in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
