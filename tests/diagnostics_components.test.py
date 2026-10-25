#!/usr/bin/env python3
"""
The parser side of the shared Diagnostics components (the chart / meter /
table / Findings work on fix/chart-height-loop), on synthetic fixtures only:

 1. ps: `ps auxwwwm` thread lines (PID "-") attach to their process; the
    states count processes (threads secondary); the state counts agree with
    the Findings' totals; the plain `ps auxwww`, `ps -elfL`, `ps alxwww` and
    `ps axo` captures are read; PPID comes from `ps -ef` / `-elf` by PID.
 2. sar: the sos 4 long names (sar_-A_-f_.var.log.sa.saDD), the sa2 cron
    job's compressed sarDD.xz, the var/log/sa text, every one parsed; a
    binary-only report (saDD without text) and a report without sysstat get
    the INFO finding, never a GOOD.
 3. The global rule: for every parser of both report types, an empty report
    yields at least one finding and no GOOD (a check has to run on data).
 4. Thresholds: the meter roles of Disk Usage / LVM / Services are the
    severities of their Findings (parsers/findings.level, one table).
 5. PCI: the verbose lines parsed into fields; a downgraded link is a warn
    finding; the error flags of the Status line are flagged; vendor / model.
 6. Services: the structured unit fields (states, since / ago, main PID,
    tasks and memory with their limits, the drop-in files, the cgroup lines).
 7. PDBs: blocking / unhealthy / empty / healthy budgets -> the states, the
    Findings (GOOD only when none blocks), the counts.
 8. Pods per node: a 3-node and a 60-node cluster -> sorted most pods first,
    the phases sum to the count, short names and roles, capacity and the
    "N% of its pod limit" findings.

Needs the backend venv (PyYAML); run-all.sh picks it up as a .test.py.
"""
import importlib
import lzma
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.join(REPO, "tests", "fixtures", "diagnostics-mock"))

import yaml  # noqa: E402

import log_viewer as lv  # noqa: E402
from parsers import findings as F  # noqa: E402
from parsers.sosreport import _common, disk_lvm, disk_usage, pci_devices, processes, sar_cpu, sar_memory, services  # noqa: E402
from parsers.mustgather import pdb as pdb_mod, pod as pod_mod  # noqa: E402

WORK = tempfile.mkdtemp(prefix="diag-components-")
results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok)))
    print(("  ok    " if ok else "  FAIL  ") + label + (f": {detail}" if detail and not ok else ""))


def write(root, rel, body, mode="w"):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, mode) as f:
        f.write(body)
    return p


def sosreport(name):
    root = os.path.join(WORK, name)
    write(root, "sos_commands/date/date", "Tue Oct 13 12:00:00 UTC 2026\n")
    write(root, "version.txt", "sosreport: 4.7.0\n")
    return root


def titles(items):
    return [f["title"] for f in items]


def sev(items, s):
    return [f for f in items if f["severity"] == s]


PS_HEAD = "USER         PID %CPU %MEM      VSZ    RSS TTY      STAT START   TIME COMMAND"


def ps_line(user, pid, cpu, mem, vsz, rss, stat, cmd):
    return f"{user:<10} {pid:>5} {cpu:>4} {mem:>4} {vsz:>8} {rss:>6} ?        {stat:<4} Sep19    0:00 {cmd}"


def thread_line(cpu, stat, user="apache"):
    # a `ps m` thread line: the user, '-' for the per-process columns, the thread's own %CPU, STAT and TIME
    return f"{user:<10}     - {cpu:>4}    -        -      - -        {stat:<4} Sep19    0:01 -"


def main():
    # 1. ps -------------------------------------------------------------------------
    root = sosreport("ps")
    lines = [PS_HEAD,
             ps_line("root", 1, 0.0, 0.1, 170000, 12000, "Ss", "/usr/lib/systemd/systemd --switched-root"),
             ps_line("root", 2, 0.0, 0.0, 0, 0, "S", "[kthreadd]"),
             ps_line("apache", 4311, 42.0, 3.5, 900000, 300000, "Sl", "/usr/sbin/httpd -DFOREGROUND"),
             thread_line(20.0, "Rl"), thread_line(15.0, "Rl"), thread_line(7.0, "Dl"), thread_line(0.0, "Sl"),
             ps_line("root", 4400, 0.0, 0.0, 0, 0, "Z", "[defunct] <defunct>"),
             ps_line("root", 4500, 1.0, 0.2, 200000, 20000, "R", "/usr/bin/top")]
    write(root, "sos_commands/process/ps_auxwwwm", "\n".join(lines) + "\n")
    write(root, "sos_commands/process/ps_-ef", "UID          PID    PPID  C STIME TTY          TIME CMD\nroot           1       0  0 Sep19 ?        00:00:05 /usr/lib/systemd/systemd\nroot           2       0  0 Sep19 ?        00:00:00 [kthreadd]\napache      4311       1 42 Sep19 ?        01:00:00 /usr/sbin/httpd -DFOREGROUND\nroot        4400    4311  0 Sep19 ?        00:00:00 [defunct]\nroot        4500       1  1 Sep19 pts/0    00:00:01 top\n")
    r = processes.parse(root)
    ds = r["ps_auxwwwm"]
    procs = ds["processes"]
    httpd = next(p for p in procs if p["PID"] == "4311")
    check("ps auxwwwm: 5 processes, the 4 thread lines attached to httpd with their %CPU", len(procs) == 5 and httpd["thread_count"] == 4 and [t["%CPU"] for t in httpd["threads"]] == ["20.0", "15.0", "7.0", "0.0"], (len(procs), httpd.get("thread_count")))
    check("ps auxwwwm: the dataset counts 5 processes and 4 threads (has_threads)", ds["summary"]["process_count"] == 5 and ds["summary"]["thread_count"] == 4 and ds["has_threads"], ds["summary"])
    states = {s["state"]: s["count"] for s in ds["summary"]["states"]}
    check("ps auxwwwm: the states count processes (S 3, R 1, Z 1), the threads apart (R 2, D 1, S 1)", states == {"S": 3, "R": 1, "Z": 1} and {t["state"]: t["count"] for t in ds["summary"]["thread_states"]} == {"R": 2, "D": 1, "S": 1}, (states, ds["summary"].get("thread_states")))
    check("ps auxwwwm: the roles of the states (R ok, D warn, Z error)", {s["state"]: s["role"] for s in ds["summary"]["states"]}["Z"] == "error" and processes.STATE_ROLES["D"] == "warn" and processes.STATE_ROLES["R"] == "ok")
    check("ps auxwwwm: PPID joined from ps -ef (httpd's parent 1, the zombie's parent httpd)", httpd["PPID"] == "1" and next(p for p in procs if p["PID"] == "4400")["PPID"] == "4311", [(p["PID"], p["PPID"]) for p in procs])
    f = r["findings"]
    totals = next((t for t in titles(f) if t.startswith("5 processes")), "")
    check("ps findings: the totals line counts the processes and threads and agrees with the state chart (1 running, 1 zombie)", "5 processes" in totals and "4 threads" in totals and any("1 running" in x["detail"] and "1 zombie" in x["detail"] for x in f if x["title"] == totals), [(x["title"], x["detail"]) for x in f])
    check("ps findings: the top CPU rows use process totals (httpd 42%, not a thread's 20%)", ds["summary"]["top_cpu"]["rows"][0]["pid"] == "4311" and ds["summary"]["top_cpu"]["rows"][0]["value"] == 42.0, ds["summary"]["top_cpu"])
    check("ps findings: the D-state thread is a warning (uninterruptible sleep) that names httpd in its detail", any("uninterruptible" in x["title"] and "httpd" in (x["title"] + x["detail"]) for x in sev(f, "warn")), [(x["title"], x["detail"]) for x in f])
    # the other forms
    root2 = sosreport("ps-plain")
    write(root2, "sos_commands/process/ps_auxwww", "\n".join([PS_HEAD, ps_line("root", 1, 0.0, 0.1, 170000, 12000, "Ss", "/usr/lib/systemd/systemd"), ps_line("root", 77, 0.5, 0.1, 100000, 9000, "S", "/usr/sbin/crond -n")]) + "\n")
    write(root2, "sos_commands/process/ps_-elfL", "F S UID          PID    PPID     LWP  C NLWP PRI  NI ADDR SZ WCHAN  STIME TTY          TIME CMD\n4 S root           1       0       1  0    1  80   0 -  42000 do_epo Sep19 ?        00:00:05 /usr/lib/systemd/systemd\n4 S root          77       1      77  0    2  80   0 -  25000 hrtime Sep19 ?        00:00:00 /usr/sbin/crond -n\n1 S root          77       1      78  0    2  80   0 -  25000 hrtime Sep19 ?        00:00:00 /usr/sbin/crond -n\n")
    r2 = processes.parse(root2)
    ds2 = r2["ps_auxwwwm"]
    check("ps auxwww (no threads): 2 processes, has_threads off, PPID from ps -elfL (crond's parent 1, one entry per process)", len(ds2["processes"]) == 2 and not ds2["has_threads"] and next(p for p in ds2["processes"] if p["PID"] == "77")["PPID"] == "1", [(p["PID"], p["PPID"]) for p in ds2["processes"]])
    pp = _common.ppid_map(root2)
    check("ppid_map: ps -elfL's LWP rows collapse to one entry per PID", pp == {"1": "0", "77": "1"}, pp)
    root3 = sosreport("ps-alx")
    write(root3, "sos_commands/process/ps_auxwww", "\n".join([PS_HEAD, ps_line("root", 1, 0.0, 0.1, 170000, 12000, "Ss", "/usr/lib/systemd/systemd"), ps_line("root", 99, 0.0, 0.1, 100000, 9000, "S", "/usr/sbin/sshd -D")]) + "\n")
    write(root3, "sos_commands/process/ps_alxwww", "F   UID     PID    PPID PRI  NI    VSZ   RSS WCHAN  STAT TTY        TIME COMMAND\n4     0       1       0  20   0 170000 12000 -      Ss   ?          0:05 /usr/lib/systemd/systemd\n4     0      99       1  20   0 100000  9000 -      Ss   ?          0:00 /usr/sbin/sshd -D\n")
    check("ps alxwww: PPID read by PID (sshd's parent 1)", _common.ppid_map(root3).get("99") == "1", _common.ppid_map(root3))
    root4 = sosreport("ps-axo")
    write(root4, "sos_commands/process/ps_auxwww", "\n".join([PS_HEAD, ps_line("root", 1, 0.0, 0.1, 170000, 12000, "Ss", "/usr/lib/systemd/systemd"), ps_line("root", 55, 0.0, 0.1, 100000, 9000, "S", "/usr/sbin/chronyd")]) + "\n")
    write(root4, "sos_commands/process/ps_axo_pid_ppid_user_group_lwp_nlwp_start_time_comm_cgroup", "    PID    PPID USER     GROUP        LWP NLWP  STARTED     TIME COMMAND         CGROUP\n      1       0 root     root           1    1 Sep19 00:00:05 systemd         0::/init.scope\n     55       1 chrony   chrony        55    1 Sep19 00:00:00 chronyd         0::/system.slice/chronyd.service\n")
    check("ps axo: PPID read by PID (chronyd's parent 1)", _common.ppid_map(root4).get("55") == "1", _common.ppid_map(root4))

    # 2. sar ------------------------------------------------------------------------
    mock_sos = importlib.import_module("mock_sosreport")
    import random

    class T:
        def __init__(self, root):
            self.root = root

        def write(self, rel, body):
            write(self.root, rel, body)

    base = sosreport("sar-src")
    mock_sos.write_sar(T(base), random.Random(1))
    days = dict(_common.sar_files(base))
    check("sar: the mock's var/log/sa/sarDD text files are found (3 days)", sorted(days) == ["10", "11", "12"], days)
    # sos 4 long names under sos_commands/sar, a compressed sarDD.xz, a binary-only day
    sos4 = sosreport("sar-sos4")
    with open(os.path.join(base, "var/log/sa/sar10")) as fh:
        text10 = fh.read()
    write(sos4, "sos_commands/sar/sar_-A_-f_.var.log.sa.sa10", text10.replace("10/10/2026", "10/10/2026"))
    src = _common.sar_sources(sos4)
    check("sar: the sos 4 long name sar_-A_-f_.var.log.sa.sa10 is day 10's text", [d for d, _ in src["text"]] == ["10"] and not src["binary"], src)
    parsed = sar_cpu.parse(sos4)
    check("sar: the long-name file parses into the CPU series (day 10 with CPU all and 8 CPUs)", "day_10" in parsed and len(parsed["day_10"]) >= 9, list(parsed.keys()))
    xz = sosreport("sar-xz")
    os.makedirs(os.path.join(xz, "var/log/sa"), exist_ok=True)
    with lzma.open(os.path.join(xz, "var/log/sa/sar11.xz"), "wt") as fh:
        with open(os.path.join(base, "var/log/sa/sar11")) as src11:
            fh.write(src11.read())
    write(xz, "var/log/sa/sa11", "binary", mode="w")
    check("sar: a compressed sar11.xz is read as day 11 (the saDD next to it is not 'binary-only')", dict(_common.sar_files(xz)).keys() == {"11"} and not _common.sar_sources(xz)["binary"] and "day_11" in sar_cpu.parse(xz), _common.sar_sources(xz))
    fm = sar_memory.findings(xz)
    check("sar memory on the xz day: a verdict from the data (no INFO 'no sar data')", fm and not any("No sar data" in t for t in titles(fm)), titles(fm))
    binonly = sosreport("sar-bin")
    write(binonly, "var/log/sa/sa12", "\x00\x01binary")
    write(binonly, "var/log/sa/sa13", "\x00\x01binary")
    fb = sar_cpu.findings(binonly)
    check("sar binary-only: one INFO naming the 2 saDD files and `sar -A -f`, no GOOD", len(fb) == 1 and fb[0]["severity"] == "info" and "binary" in fb[0]["title"] and "2 saDD" in fb[0]["detail"] and "sar -A -f" in fb[0]["detail"], fb)
    nosys = sosreport("sar-none")
    fn = sar_cpu.findings(nosys)
    check("sar without sysstat: one INFO with the paths looked for and the reason (RHCOS), no GOOD", len(fn) == 1 and fn[0]["severity"] == "info" and "No sar data" in fn[0]["title"] and "var/log/sa/sarDD" in fn[0]["detail"] and "RHCOS" in fn[0]["detail"], fn)

    # 3. the global rule: an empty report gives no GOOD, at least one finding --------
    empty_sos = sosreport("empty")
    empty_mg = os.path.join(WORK, "must-gather.local.empty")
    os.makedirs(empty_mg, exist_ok=True)

    def every(reg):
        for key, v in reg.items():
            yield key, v["module"]
            for sk, sv in (v.get("sub_tabs") or {}).items():
                yield sk, sv["module"]

    for rtype, root_dir in (("sosreport", empty_sos), ("mustgather", empty_mg)):
        bad = []
        for key, module_path in every(lv.PARSERS[rtype]):
            try:
                mod = importlib.import_module(module_path)
                if hasattr(mod, "findings"):
                    items = mod.findings(root_dir) or []
                else:
                    data = mod.parse(root_dir)
                    items = (data.get("findings") if isinstance(data, dict) else None) or []
            except Exception as e:  # noqa: BLE001
                bad.append(f"{key}: raised {type(e).__name__}: {str(e)[:60]}")
                continue
            if not items:
                bad.append(f"{key}: no finding")
            elif any(x["severity"] == "good" for x in items):
                bad.append(f"{key}: GOOD without data: {[x['title'] for x in items if x['severity'] == 'good']}")
        check(f"{rtype}: every parser on an empty report gives 1+ finding and never a GOOD ({sum(1 for _ in every(lv.PARSERS[rtype]))} tabs)", not bad, "; ".join(bad)[:600])

    # the wording of a trimmed must-gather: "looked for <paths>; trimmed gather", never "audit-only", on every rendered tab
    import subprocess
    out_dir = os.path.join(WORK, "render-empty-mg")
    keys = [k for k, _ in every(lv.PARSERS["mustgather"])]
    ren = subprocess.run([sys.executable, "-I", os.path.join(REPO, "tests", "helpers", "diagnostics-render.py"), "--out", out_dir, "--fixture", empty_mg, "--report-type", "mustgather", "--tabs"] + keys, capture_output=True, text=True)
    pages = {k: open(os.path.join(out_dir, f"{k}.html"), encoding="utf-8").read() for k in keys if os.path.isfile(os.path.join(out_dir, f"{k}.html"))}
    check(f"every must-gather tab renders over an empty gather ({len(pages)} of {len(keys)})", ren.returncode == 0 and len(pages) == len(keys), ren.stderr[-300:])
    hits = [k for k, html in pages.items() if "audit-only" in html or "audit only" in html]
    check("no rendered must-gather tab says 'audit-only' (the wording is 'looked for ...; trimmed gather')", not hits, hits)
    shaped = [k for k, html in pages.items() if "trimmed gather" in html and "looked for " not in html]
    check("every 'trimmed gather' finding names the paths it looked for", not shaped, shaped)

    # 4. thresholds -----------------------------------------------------------------
    check("findings.level: the disk thresholds are 90 warn / 95 bad, 89 ok, None muted", F.level(89) == "ok" and F.level(90) == "warn" and F.level(94) == "warn" and F.level(95) == "bad" and F.level(100) == "bad" and F.level(None) == "muted" and F.THRESHOLDS["pods"] == (80, 95))
    dk = sosreport("disk")
    write(dk, "sos_commands/filesys/df_-al_-x_autofs", "Filesystem     1K-blocks     Used Available Use% Mounted on\n/dev/sda1       52403200 49783040   2620160  95% /\n/dev/sdb1      104806400 98518016   6288384  94% /var\n/dev/sdc1      209612800 153016344  56596456  73% /data\n/dev/sdd1      209612800 209612800         0 100% /mnt/backup\ntmpfs            8000000   120000   7880000   2% /run\n")
    d = disk_usage.parse(dk)
    roles = {e["mounted"]: e["role"] for e in d["df"]["df"]}
    check("disk usage: the roles follow the thresholds (/ 95 bad, /var 94 warn, /data 73 ok, /mnt/backup 100 bad, /run ok)", roles == {"/": "bad", "/var": "warn", "/data": "ok", "/mnt/backup": "bad", "/run": "ok"}, roles)
    f = d["findings"]
    check("disk usage: the Findings carry the same severities (bad for / and /mnt/backup, warn for /var, none for /data)", sorted(x["title"].split(" ")[0] for x in sev(f, "bad")) == ["/", "/mnt/backup"] and [x["title"].split(" ")[0] for x in sev(f, "warn")] == ["/var"] and not any("/data" in t for t in titles(f) if "full" in t), titles(f))
    check("disk usage: no inode table -> the entries have no inode role and the INFO says so", all(e["irole"] == "muted" for e in d["df"]["df"]) and not d["df"]["inodes"] and any("No inode table" in t for t in titles(f)), titles(f))
    lvroot = sosreport("lvm")
    write(lvroot, "sos_commands/lvm2/lvs_-a_-o_lv_tags_devices_lv_kernel_read_ahead_lv_read_ahead_stripes_stripesize_--config_global_locking_type_0_metadata_use_lvmetad_0", "  LV    VG   Attr       LSize  Pool Origin Data%  Meta%  Move Log Cpy%Sync Convert LV Tags Devices       KRahead Rahead #Str Stripe\n  pool0 vg0  twi-aotz-- 10.00g             96.50  12.00                                   pool0_tdata(0) 128.00k auto   1    0\n  thin1 vg0  Vwi-aotz-- 20.00g pool0        40.00\n")
    lr = disk_lvm.parse(lvroot)
    lvs = {lv["LV"]: lv for lv in lr["lvm"]["lvs"]} if lr.get("lvm") else {}
    check("lvm: the thin pool's data role is bad at 96.5%, the volume's ok at 40%, and the Finding is bad", lvs.get("pool0", {}).get("data_role") == "bad" and lvs.get("thin1", {}).get("data_role") == "ok" and any("pool0" in t for t in titles(sev(lr["findings"], "bad"))), (list(lvs), titles(lr["findings"])))

    # 5. PCI -----------------------------------------------------------------------
    pci = sosreport("pci")
    write(pci, "sos_commands/pci/lspci_-nnvv", """00:00.0 Host bridge [0600]: Intel Corporation Xeon E7 v4/Xeon E5 v4/Xeon E3 v4/Xeon D DMI2 [8086:6f00] (rev 01)
\tSubsystem: Dell PowerEdge R730 [1028:0600]
\tControl: I/O- Mem+ BusMaster+ SpecCycle- MemWINV- VGASnoop- ParErr- Stepping- SERR- FastB2B- DisINTx-
\tStatus: Cap+ 66MHz- UDF- FastB2B- ParErr- DEVSEL=fast >TAbort- <TAbort- <MAbort- >SERR- <PERR- INTx-
\tNUMA node: 0
\tIOMMU group: 1

03:00.0 Ethernet controller [0200]: Mellanox Technologies MT27800 Family [ConnectX-5] [15b3:1017]
\tSubsystem: Mellanox Technologies Device [15b3:0007]
\tPhysical Slot: 2
\tControl: I/O- Mem+ BusMaster+ SpecCycle- MemWINV- VGASnoop- ParErr- Stepping- SERR+ FastB2B- DisINTx+
\tStatus: Cap+ 66MHz- UDF- FastB2B- ParErr- DEVSEL=fast >TAbort- <TAbort- <MAbort+ >SERR+ <PERR- INTx-
\tLatency: 0
\tInterrupt: pin A routed to IRQ 40
\tNUMA node: 1
\tIOMMU group: 23
\tRegion 0: Memory at e0000000 (64-bit, prefetchable) [size=32M]
\tExpansion ROM at e2000000 [disabled] [size=1M]
\tCapabilities: [60] Express (v2) Endpoint, MSI 00
\t\tLnkCap:\tPort #0, Speed 8GT/s, Width x16, ASPM not supported
\t\tLnkSta:\tSpeed 2.5GT/s (downgraded), Width x1 (downgraded)
\tKernel driver in use: mlx5_core
\tKernel modules: mlx5_core
""")
    pr = pci_devices.parse(pci)
    nic = next(d for d in pr["lspci"] if d["slot"] == "03:00.0")
    check("pci: vendor / model split (Mellanox Technologies / MT27800 Family [ConnectX-5]), the subsystem, slot, NUMA, IOMMU group, interrupt, modules", nic["vendor"] == "Mellanox Technologies" and nic["model"].startswith("MT27800") and nic["subsystem"].startswith("Mellanox") and nic["physical_slot"] == "2" and nic["numa_node"] == "1" and nic["iommu_group"] == "23" and nic["interrupt"].startswith("pin A") and nic["modules"] == "mlx5_core", {k: nic.get(k) for k in ("vendor", "model", "subsystem", "physical_slot", "numa_node", "iommu_group", "interrupt")})
    check("pci: the link capability vs status (8GT/s x16 capable, running 2.5GT/s x1) is a downgrade", nic["link"] and nic["link"]["downgraded"] and nic["link"]["cap_text"] == "8GT/s x16" and nic["link"]["text"] == "2.5GT/s x1", nic.get("link"))
    check("pci: the regions with their sizes (32M, 1M)", [r["size"] for r in nic["regions"]] == ["32M", "1M"], nic["regions"])
    check("pci: the Status error flags set (<MAbort+, >SERR+) are flagged bad; Control's SERR+ is just on", nic["error_flags"] == ["<MAbort", ">SERR"] and any(x["name"] == "SERR" and x["on"] and not x["bad"] for x in nic["control"]) and any(x["name"] == "<MAbort" and x["bad"] for x in nic["status"]), (nic["error_flags"], nic["control"][:3]))
    f = pr["findings"]
    check("pci findings: the downgraded link is a warning naming the slot and the speeds, the error flags another; no GOOD", any("03:00.0" in t and "downgraded" in t for t in titles(sev(f, "warn"))) and any("error flags" in t for t in titles(sev(f, "warn"))) and any("8GT/s x16 capable, running 2.5GT/s x1" in x["detail"] for x in f) and not sev(f, "good"), titles(f))
    pci2 = sosreport("pci-clean")
    write(pci2, "sos_commands/pci/lspci_-nnvv", "03:00.0 Ethernet controller [0200]: Intel Corporation I350 Gigabit Network Connection [8086:1521] (rev 01)\n\tSubsystem: Intel Corporation Ethernet Server Adapter I350-T2 [8086:00a2]\n\tControl: I/O+ Mem+ BusMaster+ SpecCycle- MemWINV- VGASnoop- ParErr- Stepping- SERR- FastB2B- DisINTx+\n\tStatus: Cap+ 66MHz- UDF- FastB2B- ParErr- DEVSEL=fast >TAbort- <TAbort- <MAbort- >SERR- <PERR- INTx-\n\t\tLnkCap:\tPort #0, Speed 5GT/s, Width x4, ASPM L0s L1\n\t\tLnkSta:\tSpeed 5GT/s, Width x4\n\tKernel driver in use: igb\n")
    f2 = pci_devices.parse(pci2)["findings"]
    check("pci findings: a clean device (link at capability, no error flag, a driver) gives the GOOD line", any(x["severity"] == "good" for x in f2) and not sev(f2, "warn"), titles(f2))

    # 6. Services -------------------------------------------------------------------
    sv = sosreport("services")
    write(sv, "sos_commands/systemd/systemctl_status_--all", """● httpd.service - The Apache HTTP Server
     Loaded: loaded (/usr/lib/systemd/system/httpd.service; enabled; preset: disabled)
    Drop-In: /etc/systemd/system/httpd.service.d
             └─10-limits.conf, 20-env.conf
     Active: active (running) since Tue 2026-10-13 08:01:02 UTC; 2 days ago
       Docs: man:httpd.service(8)
   Main PID: 4311 (httpd)
      Tasks: 95 (limit: 100)
     Memory: 1.9G (max: 2.0G)
        CPU: 1h 2min 3.456s
     CGroup: /system.slice/httpd.service
             ├─4311 /usr/sbin/httpd -DFOREGROUND
             └─4312 /usr/sbin/httpd -DFOREGROUND

× example-backup.service - Nightly backup
     Loaded: loaded (/etc/systemd/system/example-backup.service; enabled; preset: disabled)
     Active: failed (Result: exit-code) since Mon 2026-10-12 02:00:10 UTC; 1 day 10h ago
   Main PID: 9999 (code=exited, status=1/FAILURE)

○ chronyd.service - NTP client/server
     Loaded: loaded (/usr/lib/systemd/system/chronyd.service; enabled; preset: enabled)
     Active: inactive (dead)
""")
    sr = services.parse(sv)
    units = {u["name"]: u for u in sr["systemctl"]["units"]}
    h = units["httpd.service"]
    check("services: the unit's states (active / running), since and ago, the unit file and enablement, the main PID", h["active_state"] == "active" and h["sub_state"] == "running" and h["since"].startswith("Tue 2026-10-13") and h["ago"] == "2 days ago" and h["unit_file"] == "/usr/lib/systemd/system/httpd.service" and h["enablement"] == "enabled" and h["pid"] == "4311", {k: h.get(k) for k in ("active_state", "sub_state", "since", "ago", "unit_file", "enablement", "pid")})
    check("services: tasks 95 of 100 -> 95% bad; memory 1.9G of 2.0G -> 95% bad (the shared thresholds)", h["tasks_used"] == 95 and h["tasks_limit"] == 100 and h["tasks_role"] == "bad" and h["memory_limit"] == 2 * 1024 ** 3 and h["memory_role"] == "bad", {k: h.get(k) for k in ("tasks_used", "tasks_limit", "tasks_pct", "tasks_role", "memory_pct", "memory_role")})
    check("services: the drop-in files are listed with their folder, the cgroup lines kept", h["drop_ins"] == ["/etc/systemd/system/httpd.service.d/10-limits.conf, 20-env.conf"] or h["drop_ins"][0].startswith("/etc/systemd/system/httpd.service.d/"), h["drop_ins"]) and check("services: the cgroup process tree lines", len(h["cgroup_lines"]) == 3, h["cgroup_lines"])
    fb = units["example-backup.service"]
    check("services: the failed unit (failed / exit-code), the inactive one (inactive / dead, no limits -> muted roles)", fb["active_state"] == "failed" and fb["sub_state"] == "Result: exit-code" and units["chronyd.service"]["tasks_role"] == "muted" and units["chronyd.service"]["memory_role"] == "muted")
    f = sr["findings"]
    check("services findings: the failed unit bad first, httpd's tasks and memory both bad with links to the Services page, no GOOD", f[0]["title"] == "example-backup.service failed" and any("95 of 100 tasks" in t for t in titles(sev(f, "bad"))) and any("memory limit" in t and x["link"]["sub_tab"] == "services" for t, x in zip(titles(sev(f, "bad")), sev(f, "bad"))) and not sev(f, "good"), titles(f))

    # 7. PDBs -----------------------------------------------------------------------
    mg = os.path.join(WORK, "must-gather.local.pdb")

    def pdb_item(ns, name, min_available, healthy, desired, expected, allowed):
        return {"apiVersion": "policy/v1", "kind": "PodDisruptionBudget", "metadata": {"name": name, "namespace": ns, "creationTimestamp": "2026-10-01T00:00:00Z"},
                "spec": {"minAvailable": min_available, "selector": {"matchLabels": {"app": name}}},
                "status": {"conditions": [{"type": "DisruptionAllowed", "status": "True" if allowed else "False", "reason": "SufficientPods" if allowed else "InsufficientPods"}],
                           "currentHealthy": healthy, "desiredHealthy": desired, "disruptionsAllowed": allowed, "expectedPods": expected}}

    def write_pdbs(ns, items):
        p = os.path.join(mg, "namespaces", ns, "policy", "poddisruptionbudgets.yaml")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as fh:
            yaml.safe_dump({"apiVersion": "policy/v1", "kind": "PodDisruptionBudgetList", "items": items}, fh)

    write_pdbs("app-a", [pdb_item("app-a", "blocking-pdb", 2, 2, 2, 2, 0), pdb_item("app-a", "healthy-pdb", 1, 3, 1, 3, 2)])
    write_pdbs("app-b", [pdb_item("app-b", "unhealthy-pdb", 2, 1, 2, 2, 0), pdb_item("app-b", "empty-pdb", 1, 0, 0, 0, 0)])
    os.makedirs(os.path.join(mg, "namespaces", "app-c"), exist_ok=True)
    pr = pdb_mod.parse(mg)
    f = pdb_mod.findings(mg)
    states = {name: d.get("_state") for ns, items in pr.items() if isinstance(items, dict) for name, d in items.items() if isinstance(d, dict)}
    check("pdbs: the states (blocking, unhealthy, empty, ok)", states == {"blocking-pdb": "blocking", "healthy-pdb": "ok", "unhealthy-pdb": "unhealthy", "empty-pdb": "empty"}, states)
    check("pdbs findings: the blocking budget is a warning saying a drain will hang, the unhealthy one bad, the empty one info, no GOOD", any("blocking-pdb allows 0 disruptions" in t and "drain will hang" in t for t in titles(sev(f, "warn"))) and any("unhealthy-pdb" in t for t in titles(sev(f, "bad"))) and any("empty-pdb" in t for t in titles(sev(f, "info"))) and not sev(f, "good"), titles(f))
    mg2 = os.path.join(WORK, "must-gather.local.pdb-ok")
    p = os.path.join(mg2, "namespaces", "app-a", "policy", "poddisruptionbudgets.yaml")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        yaml.safe_dump({"apiVersion": "policy/v1", "kind": "PodDisruptionBudgetList", "items": [pdb_item("app-a", "healthy-pdb", 1, 3, 1, 3, 2)]}, fh)
    f2 = pdb_mod.findings(mg2)
    check("pdbs findings: budgets that all allow a disruption -> the GOOD line with the count", any(x["severity"] == "good" and "1" in x["title"] for x in f2) and not sev(f2, "warn") and not sev(f2, "bad"), titles(f2))
    mg3 = os.path.join(WORK, "must-gather.local.pdb-none")
    os.makedirs(os.path.join(mg3, "namespaces", "app-a"), exist_ok=True)
    f3 = pdb_mod.findings(mg3)
    check("pdbs findings: no budget at all -> INFO, never GOOD", f3 and not sev(f3, "good"), titles(f3))

    # 8. Pods per node ----------------------------------------------------------------
    def cluster(name, n_nodes, pods_per_node, capacity=250, roles=None):
        root_dir = os.path.join(WORK, name)
        for i in range(n_nodes):
            node = f"ip-{'192-0-2' if i < 250 else '198-51-100'}-{i % 250}.us-east-2.compute.internal"   # the documentation ranges
            role = (roles or (["master"] * 3 + ["worker"] * 200))[i]
            os.makedirs(os.path.join(root_dir, "cluster-scoped-resources", "core", "nodes"), exist_ok=True)
            with open(os.path.join(root_dir, "cluster-scoped-resources", "core", "nodes", f"{node}.yaml"), "w") as fh:
                yaml.safe_dump({"apiVersion": "v1", "kind": "Node", "metadata": {"name": node, "labels": {f"node-role.kubernetes.io/{role}": ""}}, "status": {"allocatable": {"pods": str(capacity)}, "capacity": {"pods": str(capacity)}}}, fh)
            for k in range(pods_per_node(i)):
                phase = "Running" if k % 7 else "Pending"
                pod_name = f"app-{i}-{k}"
                pdir = os.path.join(root_dir, "namespaces", "app", "pods", pod_name)
                os.makedirs(pdir, exist_ok=True)
                with open(os.path.join(pdir, f"{pod_name}.yaml"), "w") as fh:
                    yaml.safe_dump({"apiVersion": "v1", "kind": "Pod", "metadata": {"name": pod_name, "namespace": "app", "creationTimestamp": "2026-10-01T00:00:00Z"}, "spec": {"nodeName": node, "containers": [{"name": "c", "image": "x"}]},
                                    "status": {"phase": phase, "conditions": [{"type": "Ready", "status": "True" if phase == "Running" else "False"}], "containerStatuses": [{"name": "c", "ready": phase == "Running", "restartCount": 0, "state": {"running": {}} if phase == "Running" else {"waiting": {"reason": "ContainerCreating"}}}]}}, fh)
        return root_dir

    small = cluster("must-gather.local.3nodes", 3, lambda i: [12, 30, 5][i])
    r = pod_mod.parse(small)
    nodes = r["_nodes"]["rows"]
    check("pods per node (3 nodes): sorted most pods first, the short names without the cloud suffix, the roles", [n["count"] for n in nodes] == [30, 12, 5] and nodes[0]["short"] == "ip-192-0-2-1" and nodes[0]["role"] == "master" and nodes[2]["role"] == "master", [(n["short"], n["count"], n["role"]) for n in nodes])
    check("pods per node (3 nodes): the phases sum to the count on every row, the capacity read from allocatable", all(sum(n["phases"].values()) == n["count"] for n in nodes) and all(n["capacity"] == 250 for n in nodes), [(n["phases"], n["capacity"]) for n in nodes])
    big = cluster("must-gather.local.60nodes", 60, lambda i: 240 if i == 7 else (205 if i == 9 else 20 + (i % 5)), capacity=250)
    r = pod_mod.parse(big)
    nodes = r["_nodes"]["rows"]
    f = pod_mod.findings(big)
    check("pods per node (60 nodes): 60 rows, the fullest first (240 of 250), the counts descending", len(nodes) == 60 and nodes[0]["count"] == 240 and all(nodes[i]["count"] >= nodes[i + 1]["count"] for i in range(59)), [n["count"] for n in nodes[:5]])
    check("pods per node (60 nodes): the node at 96% of its pod limit is a bad finding, the one at 82% a warning", any("ip-192-0-2-7" in t and "96%" in t and "pod limit" in t for t in titles(sev(f, "bad"))) and any("ip-192-0-2-9" in t and "82%" in t for t in titles(sev(f, "warn"))), [t for t in titles(f) if "limit" in t])

    # 13. Buttons without a size class (the detail pages' Back, hidden until a row opens, so the render probe never sees them)
    with open(os.path.join(BACKEND, "static", "styles.css"), encoding="utf-8") as fh:
        css = fh.read()
    import re
    rule = re.search(r"#diagnostics-content \.btn:not\(\.btn-sm\):not\(\.btn-md\):not\(\.btn-lg\)\s*\{([^}]*)\}", css)
    check("a .btn without a size class gets the control size in the frame (height 30px, horizontal padding)", bool(rule) and "height: 30px" in rule.group(1) and re.search(r"padding:\s*0\s+1[02]px", rule.group(1)) is not None, rule.group(1) if rule else "no default-size rule")

    failed = [l for l, ok in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
