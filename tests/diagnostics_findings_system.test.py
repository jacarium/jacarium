#!/usr/bin/env python3
"""
The System group's Findings (Phase 2 of the diagnostics review): a synthetic
sosreport with planted problems, parsed and rendered through the real Flask
blueprint, must surface each of them in the shared Findings strip
(parsers/findings.py, tabs/_ui.html findings()), worst first, with the
cross-link that opens the plugin that shows more.

 1. parsers/findings.py: the builders, the order (bad, warn, info, good), the
    human formatting.
 2. System Information: load per core (bad at 2x), memory under 10% (bad),
    swap over half used, a kernel taint with a fault bit (bad, D), SELinux
    permissive, a boot under a day ago, RHEL 7's estimated `available`.
 3. Processes: a zombie, a D-state task (linked to the hung-task reports), a
    CPU hog, a memory hog, a 1000-thread process; the totals; the STAT
    legend table is gone and the search field carries data-ui-search.
 4. Services: a failed unit first (linked to the Log Viewer with its name), a
    unit in auto-restart, a unit at its task limit, the units sorted worst
    first, a unit without a description parsed.
 5. Scheduler Debug: a CPU with a deep run queue, the long-wait tasks on the
    1 ms threshold, a D task, a real-time task.
 6. PCI: a NIC without a driver (warn), the Driver column, the devices
    grouped by class.
 7. C-States: the verdict line; every deep state disabled -> the latency note.
 8. Every page of the group renders the strip markup (ui-findings) and marks
    its main search field (data-ui-search); the mock reports render too.

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
from parsers import findings as F  # noqa: E402
from parsers.sosreport import cstates, pci_devices, processes, sched_debug, services, system  # noqa: E402

WORK = tempfile.mkdtemp(prefix="diag-findings-")
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
    app.secret_key = "diagnostics-findings-test"
    return app.test_client()


def render(c, directory, tab, sub_tab=None):
    body = {"directory": directory, "report_type": "sosreport", "tab": tab}
    if sub_tab:
        body["sub_tab"] = sub_tab
    r = c.post("/load_tab", json=body)
    return r.status_code, (r.get_json() or {}).get("html", "")


def sev(items, severity):
    return [f for f in items if f["severity"] == severity]


def titles(items):
    return [f["title"] for f in items]


def main():
    # 1. the builders -----------------------------------------------------------
    items = [F.finding("info", "i"), F.finding("good", "g"), F.finding("bad", "b1", count=2), F.finding("warn", "w"), F.finding("bad", "b2", count=5, tab="system", sub_tab="processes", query="httpd")]
    s = F.sort_findings(items)
    check("findings: sorted worst first, larger counts first, the link carries tab / sub_tab / query", titles(s) == ["b2", "b1", "w", "i", "g"] and s[0]["link"] == {"tab": "system", "sub_tab": "processes", "query": "httpd"} and "link" not in s[1], titles(s))
    check("findings: an unknown severity becomes info; summary counts", F.finding("nope", "x")["severity"] == "info" and F.summary(items) == {"bad": 2, "warn": 1, "info": 1, "good": 1, "total": 5})
    check("findings: human formatting", F.human_bytes(1536) == "1.5 KiB" and F.human_bytes(3 * 1024 ** 3) == "3.0 GiB" and F.human_bytes(2048, kib=True) == "2.0 MiB" and F.human_pct(1, 3) == "33%" and F.human_count(1234567) == "1 234 567")

    # the planted report --------------------------------------------------------
    root = os.path.join(WORK, "sosreport-planted")
    write(root, "uptime", " 14:30:01 up  3:12,  2 users,  load average: 9.50, 8.00, 6.00\n")
    write(root, "sos_commands/processor/lscpu", "Architecture:        x86_64\nCPU(s):              4\nModel name:          Example CPU\n")
    write(root, "sos_commands/host/hostnamectl_status", "   Static hostname: host.example.test\n  Operating System: Example Linux 7.9\n            Kernel: Linux 3.10.0-1160.el7.x86_64\n      Architecture: x86-64\n")
    write(root, "sos_commands/memory/free_-m", "              total        used        free      shared     buffers      cached\nMem:          16384       15000         300          10         100         984\n-/+ buffers/cache:       13916        2468\nSwap:          4096        3000        1096\n")
    write(root, "proc/sys/kernel/tainted", "4224\n")   # 128 (D: oops) + 4096 (O)
    write(root, "sos_commands/selinux/sestatus_-b", "SELinux status:                 enabled\nCurrent mode:                   permissive\nMode from config file:          enforcing\n")
    ps = ["USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
          "root           1  0.0  0.1 171000 12000 ?        Ss   Oct12   1:23 /usr/lib/systemd/systemd",
          "app          200 95.0  2.0 400000 50000 ?        Rl   Oct12   9:00 /opt/app/bin/busy",
          "app          300  1.0 40.0 900000 7000000 ?      Sl   Oct12   9:00 /opt/app/bin/hog",
          "app          400  0.0  0.1 100000 1000 ?         D    Oct12   0:01 /opt/app/bin/stuck",
          "app          401  0.0  0.0      0     0 ?        Z    Oct12   0:00 [defunct] <defunct>",
          "app          500  2.0  1.0 800000 20000 ?        Sl   Oct12   3:00 /opt/app/bin/threaded"]
    ps += ["app            -  0.0    -      -     - -        Sl   Oct12   0:00 -"] * 1200
    write(root, "sos_commands/process/ps_auxwwwm", "\n".join(ps) + "\n")
    write(root, "sos_commands/systemd/systemctl_status_--all", (
        "● httpd.service - The Apache HTTP Server\n   Loaded: loaded (/usr/lib/systemd/system/httpd.service; enabled)\n   Active: active (running) since Mon 2026-10-12 02:00:07 UTC; 12h ago\n    Tasks: 95 (limit: 100)\n   Memory: 3.2G\n      CPU: 1min 2.345s\n\n"
        "● example-backup.service - Nightly backup\n   Loaded: loaded (/etc/systemd/system/example-backup.service; enabled)\n   Active: failed (Result: exit-code) since Mon 2026-10-12 02:00:07 UTC; 12h ago\n  Process: 4001 ExecStart=/usr/local/bin/backup (code=exited, status=1/FAILURE)\n\n"
        "● example-agent.service - Telemetry agent\n   Loaded: loaded (/etc/systemd/system/example-agent.service; enabled)\n   Active: activating (auto-restart) (Result: exit-code) since Mon 2026-10-12 14:29:50 UTC; 11s ago\n\n"
        "● nodesc.service\n   Loaded: loaded (/etc/systemd/system/nodesc.service; static)\n   Active: inactive (dead)\n\n"
        "● sshd.service - OpenSSH server daemon\n   Loaded: loaded (/usr/lib/systemd/system/sshd.service; enabled)\n   Active: active (running) since Mon 2026-10-12 02:00:07 UTC; 12h ago\n    Tasks: 1 (limit: 4915)\n   Memory: 5.2M\n"))
    write(root, "proc/sched_debug", (
        "Sched Debug Version: v0.11, 3.10.0-1160.el7.x86_64 #1\n\n"
        "cpu#0, 2400.000 MHz\n  .nr_running                    : 9\n  .nr_switches                   : 100\n  .curr->pid                     : 200\n\n"
        "cfs_rq[0]:/\n  .nr_running                    : 9\n\nrt_rq[0]:\n  .rt_nr_running                 : 1\n\n"
        "runnable tasks:\n S           task   PID         tree-key  switches  prio     wait-time             sum-exec        sum-sleep\n----\n"
        " S         systemd     1      1234.567890      1000   120         0.500000        100.000000       2000.000000 /\n"
        ">R            busy   200     98765.432100     50000   120       250.000000      90000.000000      10000.000000 /system.slice/app.service\n"
        " D           stuck   400       100.000000       500   120         0.010000         10.000000         50.000000 /\n"
        " R         rtprio   600       100.000000       500    50         3.000000         10.000000         50.000000 /\n"
        " S          waiter   700       100.000000       500   120        12.500000         10.000000         50.000000 /\n"
        "cpu#1, 2400.000 MHz\n  .nr_running                    : 1\n\nrunnable tasks:\n S           task   PID         tree-key  switches  prio     wait-time             sum-exec        sum-sleep\n----\n"
        " S         kworker    12       100.000000       500   120         0.010000         10.000000         50.000000 /\n"))
    write(root, "sos_commands/pci/lspci_-nnvv", (
        "00:1f.2 SATA controller [0106]: Example Silicon SATA [1ab8:2922] (rev 02)\n\tKernel driver in use: ahci\n\tKernel modules: ahci\n\n"
        "00:03.0 Ethernet controller [0200]: Example Silicon NIC [1ab8:1000]\n\tSubsystem: Example [1ab8:0001]\n\n"
        "00:04.0 Ethernet controller [0200]: Example Silicon NIC [1ab8:1000]\n\tKernel driver in use: virtio-pci\n\n"
        "00:00.0 Host bridge [0600]: Example Silicon Host Bridge [1ab8:0001]\n\tSubsystem: Example [1ab8:1100]\n"))
    for cpu in range(2):
        base = f"sys/devices/system/cpu/cpu{cpu}/cpuidle"
        write(root, f"{base}/current_driver", "intel_idle\n")
        write(root, f"{base}/current_governor_ro", "menu\n")
        for i, (name, time_us, usage, disable, residency, latency) in enumerate([("POLL", 1000, 10, 0, 0, 0), ("C1", 500000, 500, 0, 2, 2), ("C6", 0, 0, 1, 300, 100)]):
            for k, v in (("name", name), ("time", time_us), ("usage", usage), ("disable", disable), ("residency", residency), ("latency", latency), ("desc", name)):
                write(root, f"{base}/state{i}/{k}", f"{v}\n")

    # 2. System ----------------------------------------------------------------
    r = system.parse(root)
    f = r["findings"]
    check("system: load 9.5 on 4 CPUs is bad (2.4 per core) and links to Processes", any("Load 9.5 on 4 CPUs" in t for t in titles(sev(f, "bad"))) and any(x.get("link", {}).get("sub_tab") == "processes" for x in sev(f, "bad")), titles(f))
    check("system: 1.25 of 16 GiB available (8%) is bad; the RHEL 7 estimate is noted; swap 73% used is a warning",
          any("available (8%)" in t for t in titles(sev(f, "bad"))) and any("estimate" in t for t in titles(sev(f, "info"))) and any("Swap:" in t and "73%" in t for t in titles(sev(f, "warn"))), titles(f))
    check("system: the taint with the oops bit is bad and names the flags; SELinux permissive and the boot 3.2 h ago are informational",
          any("tainted by a fault: kernel oops / BUG" in t for t in titles(sev(f, "bad"))) and any("SELinux is permissive" == t for t in titles(f)) and any("Booted 3.2 h before" in t for t in titles(f)), titles(f))
    check("system: the strip is sorted worst first and the facts are on the result (taint flags, selinux, uptime seconds)",
          [x["severity"] for x in f] == sorted([x["severity"] for x in f], key=lambda s: F.ORDER[s]) and [t["letter"] for t in r["taint"]] == ["D", "O"] and r["selinux"] == "permissive" and r["uptime"]["uptime_seconds"] == 3 * 3600 + 12 * 60, repr((r["taint"], r["uptime"])))

    # 3. Processes ---------------------------------------------------------------
    f = processes.parse(root)["findings"]
    check("processes: the zombie, the D task (linked to the hung-task reports), the CPU hog, the memory hog and the 1200-thread process are found",
          any("1 zombie process" == t for t in titles(f)) and any("uninterruptible sleep (D)" in t and x.get("link", {}).get("sub_tab") == "kernel_hung_task" for t, x in zip(titles(f), f))
          and any("over 50% CPU" in t for t in titles(f)) and any("over 25% of memory" in t for t in titles(f)) and any("1000+ threads" in t for t in titles(f)), titles(f))
    check("processes: the totals line counts 6 processes and 1200 threads", any(t.startswith("6 processes, 1") and "threads" in t for t in titles(f)), titles(f))

    # 4. Services ----------------------------------------------------------------
    r = services.parse(root)
    f, units = r["findings"], r["systemctl"]["units"]
    check("services: the failed unit is the first finding (bad) and links to the Log Viewer with its name; auto-restart is a warning and the task limit at 95% is bad (the shared thresholds)",
          f[0]["title"] == "example-backup.service failed" and f[0]["link"] == {"tab": "log_collection", "sub_tab": "log_viewer", "query": "example-backup"}
          and any("keeps restarting" in t for t in titles(sev(f, "warn"))) and any("httpd.service at 95 of 100 tasks" == t for t in titles(sev(f, "bad"))), titles(f))
    check("services: the units come sorted worst first (failed, activating, active by memory, inactive) and the unit without a description is parsed",
          [u["name"] for u in units] == ["example-backup.service", "example-agent.service", "httpd.service", "sshd.service", "nodesc.service"], [u["name"] for u in units])

    # 5. Scheduler Debug --------------------------------------------------------
    r = sched_debug.parse(root)
    f = r["findings"]
    check("sched: cpu0's run queue of 9 is bad; the long waits (250 ms, 12.5 ms) over the threshold; the D task links to the hung-task reports; the rt task is informational",
          any("1 CPU with 4+ runnable tasks" == t for t in titles(sev(f, "bad"))) and any("waited" in t and "ms for a CPU" in t for t in titles(sev(f, "bad")))
          and any("uninterruptible sleep" in t and x.get("link", {}).get("sub_tab") == "kernel_hung_task" for t, x in zip(titles(f), f)) and any("1 real-time task" == t for t in titles(sev(f, "info"))), titles(f))
    check("sched: the wait threshold is on the result and the per-CPU high-wait list uses 1 ms (not 0.1)", r["sched"].get("wait_threshold_ms") >= 1.0 and [t["name"] for t in r["sched"]["per_cpu"][0]["summary"]["high_wait_tasks"]] == ["busy", "rtprio", "waiter"], repr(r["sched"].get("wait_threshold_ms")))

    # 6. PCI ---------------------------------------------------------------------
    r = pci_devices.parse(root)
    f = r["findings"]
    check("pci: the NIC without a driver is a warning, the drivers are read, the classes counted", any("1 network / storage device without a kernel driver" == t for t in titles(sev(f, "warn")))
          and [d["driver"] for d in r["lspci"]] == ["ahci", "", "virtio-pci", ""] and r["by_class"]["Ethernet controller"] == 2, repr((titles(f), [d["driver"] for d in r["lspci"]])))

    # 7. C-States -----------------------------------------------------------------
    r = cstates.parse(root)
    check("cstates: the verdict (driver, governor, deepest state in use C1, the disabled C6) and the latency note", r["verdict"]["deepest"] == "C1" and r["verdict"]["disabled"] == ["C6"] and any("Every deep C-state is disabled" == t for t in titles(r["findings"])), repr((r["verdict"], titles(r["findings"]))))

    # 8. the pages --------------------------------------------------------------
    c = client()
    for tab, sub in (("system", None), ("system", "processes"), ("system", "services"), ("system", "sched_debug"), ("system", "pci_devices"), ("system", "cstates")):
        status, html = render(c, root, tab, sub)
        name = sub or tab
        check(f"page {name}: renders with the Findings strip (ui-findings, a badge per row) and the search field marked data-ui-search",
              status == 200 and 'class="ui-findings"' in html and html.count('class="ui-finding ') >= 1 and ("data-ui-search" in html or name == "system"), f"status {status}, strip {'ui-findings' in html}")
    status, html = render(c, root, "system", "processes")
    check("page processes: the STAT legend table is gone (the STAT cell explains its letters in a tooltip)", "Process State Legend" not in html and "describeStat" in html)
    status, html = render(c, root, "system", "services")
    check("page services: the failed unit is the first row, its state a badge, the Open button links to the Log Viewer", html.index("example-backup.service") < html.index("httpd.service") and 'ui-badge ui-badge-bad' in html and 'data-tab="log_collection" data-sub-tab="log_viewer" data-query="example-backup"' in html)
    status, html = render(c, root, "system", "pci_devices")
    check("page pci: a Driver column, the devices grouped by class (the Ethernet controllers before the Host bridge)", "<th>Driver</th>" in html and html.index("Ethernet controller [0200]") < html.index("Host bridge [0600]"))
    status, html = render(c, root, "system", "cstates")
    check("page cstates: the legend is a details element, open on load", '<details class="panel rounded-lg shadow-sm ui-details" id="cstates-legend" open>' in html)

    shutil.rmtree(WORK, ignore_errors=True)
    failed = [l for l, ok in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
