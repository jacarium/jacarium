#!/usr/bin/env python3
"""The kernel diagnostics tabs' parsers (backend/parsers/sosreport/
kernel_log.py, kernel_stack_traces.py, kernel_hung_task.py,
kernel_oom_killer.py) and their templates, rendered through the Flask test
client the way POST /load_tab renders them.

THE REWORK: the three tabs used to read one file (the journal), one
timestamp format (syslog), found WARNINGs only (no BUG, Oops, lockup, RCU
stall), dumped a 50-line window per hung task, kept each OOM as a raw
string, and could not tell the same event in the journal, the boot
journal and dmesg apart. Now one streaming scan (kernel_log.scan) covers
every kernel log of a report, every prefix format, the RHEL 7 to RHEL 10
line forms, dedupes across sources, groups identical events and caps its
work; the templates render the result on the app's tokens with every
piece of report text escaped by Jinja.

Everything here runs on temp report trees with made-up content (the
diagnostics mock's generator and small hand-written logs); nothing real.
Run with the backend venv's Python: backend/venv/bin/python tests/kernel_tabs_parsers.test.py
"""
import contextlib
import gzip
import io
import os
import shutil
import sys
import tempfile
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.join(HERE, "fixtures", "diagnostics-mock"))

from flask import Flask, render_template  # noqa: E402
import generate as mock_generate  # noqa: E402
from parsers.sosreport import kernel_log as kl  # noqa: E402
from parsers.sosreport import kernel_stack_traces, kernel_hung_task, kernel_oom_killer  # noqa: E402

FAILED = 0
WORKDIR = tempfile.mkdtemp(prefix="kernel-tabs-")
KERNEL = "5.14.0-427.13.1.el9_4.x86_64"


def check(label, ok, detail=""):
    global FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {label}" + (f" | {detail[:400]}" if not ok and detail else ""))
    if not ok:
        FAILED += 1


def report(name, files, date="Mon Oct 12 14:30:00 UTC 2026", uptime=" 14:30:01 up 23 days,  4:12,  2 users,  load average: 1.00, 1.00, 1.00"):
    """A tiny report tree: files = {relative path: text (or bytes for .gz)}.
    Every tree gets `date` and `uptime` (the parsers map dmesg seconds
    through them) and a second top-level entry so the single-entry unwrap
    does not kick in."""
    root = os.path.join(WORKDIR, name)
    os.makedirs(root, exist_ok=True)
    for rel, content in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if rel.endswith(".gz"):
            with gzip.open(path, "wt", encoding="utf-8") as f:
                f.write(content)
        else:
            with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
                f.write(content)
    with open(os.path.join(root, "version.txt"), "w") as f:
        f.write("sosreport: 4.7.0\n")
    if date is not None:
        with open(os.path.join(root, "date"), "w") as f:
            f.write(date + "\n")
    if uptime is not None:
        with open(os.path.join(root, "uptime"), "w") as f:
            f.write(uptime + "\n")
    return root


K = "web-01 kernel: "


def warning_lines(prefix, fn="example_fastpath_poll+0x1a2/0x2f0", extra_frame=""):
    lines = [
        "------------[ cut here ]------------",
        f"WARNING: CPU: 3 PID: 4311 at drivers/example/example_fastpath.c:412 {fn} [example_fastpath]",
        "Modules linked in: example_fastpath(OE) xfs libcrc32c",
        f"CPU: 3 PID: 4311 Comm: example-worker Tainted: G           OE     -------  ---  {KERNEL} #1",
        "Hardware name: Example Systems ExampleServer X1/EX-MB-100, BIOS 2.1.7 03/14/2026",
        f"RIP: 0010:{fn} [example_fastpath]",
        "Code: 48 8b 45 d0 e8 ab 2e <0f> 0b e9 61 fe ff ff",
        "Call Trace:", " <TASK>", f" {fn} [example_fastpath]", " ? __schedule+0x2d1/0x870",
        " example_fastpath_ioctl+0x8e/0x1c0 [example_fastpath]", " do_syscall_64+0x5c/0x90",
    ]
    if extra_frame:
        lines.append(f" {extra_frame}")
    lines += [" </TASK>", "---[ end trace 4a5b6c7d8e9f0a1b ]---"]
    return [prefix + l for l in lines]


def hung_lines(prefix, comm="example-worker", pid=4311, secs=122, task_line=None, markers=True):
    task_line = task_line or f"task:{comm}  state:D stack:0 pid: {pid} ppid:  4200 flags:0x00004080"
    lines = [f"INFO: task {comm}:{pid} blocked for more than {secs} seconds.",
             f"      Tainted: G           OE     -------  ---  {KERNEL} #1",
             "\"echo 0 > /proc/sys/kernel/hung_task_timeout_secs\" disables this message.",
             task_line, "Call Trace:"]
    if markers:
        lines.append(" <TASK>")
    lines += [" __schedule+0x2d1/0x870", " schedule+0x55/0xf0", " rpc_wait_bit_killable+0x24/0xa0 [sunrpc]",
              " nfs_wait_on_request+0x5a/0x70 [nfs]", " nfs_updatepage+0x1d9/0x980 [nfs]", " vfs_write+0x2cf/0x3f0", " do_syscall_64+0x5c/0x90"]
    if markers:
        lines.append(" </TASK>")
    return [prefix + l for l in lines]


def oom_lines(prefix, pid=4311, comm="example-worker", memcg=False):
    lines = [f"{comm} invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0",
             f"CPU: 3 PID: {pid} Comm: {comm} Tainted: G           OE     -------  ---  {KERNEL} #1",
             "Call Trace:", " <TASK>", " dump_stack_lvl+0x34/0x48", " out_of_memory+0xed/0x2e0", " </TASK>"]
    if memcg:
        lines += ["memory: usage 8388608kB, limit 8388608kB, failcnt 418", "Memory cgroup stats for /kubepods.slice/pod-a/crio-b.scope:", "anon 8583872512"]
    else:
        lines += ["Mem-Info:", "active_anon:7012345 inactive_anon:812345 isolated_anon:0", " free:38912 free_pcp:0 free_cma:0",
                  "Node 0 active_anon:28049380kB inactive_anon:3249380kB active_file:4936kB inactive_file:9380kB shmem:419840kB",
                  "Node 0 DMA free:15360kB min:28kB low:40kB high:52kB active_anon:0kB inactive_anon:0kB",
                  "Node 0 Normal free:140288kB min:28kB low:40kB high:52kB active_anon:28049380kB inactive_anon:3249380kB",
                  "Free swap  = 0kB", "Total swap = 4193280kB", "8388608 pages RAM"]
    lines += ["Tasks state (memory values in pages):",
              "[  pid  ]   uid  tgid total_vm      rss pgtables_bytes swapents oom_score_adj name",
              "[   2305]    48  2305    90250    12345   409600      210             0 httpd",
              "[   4200]  1001  4200    41000     8200   204800      100             0 example worker helper",
              f"[   {pid}]  1001  {pid}  5013500  7280864  41943040  1048320             0 {comm}"]
    if memcg:
        lines += [f"oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/kubepods.slice/pod-a/crio-b.scope,task_memcg=/kubepods.slice/pod-a/crio-b.scope,task={comm},pid={pid},uid=1000",
                  f"Memory cgroup out of memory: Killed process {pid} ({comm}) total-vm:9800000kB, anon-rss:7912300kB, file-rss:2048kB, shmem-rss:0kB, UID:1000 pgtables:20480kB oom_score_adj:999"]
    else:
        lines += [f"oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/system.slice/example-worker.service,task={comm},pid={pid},uid=1001",
                  f"Out of memory: Killed process {pid} ({comm}) total-vm:20054000kB, anon-rss:29123456kB, file-rss:1024kB, shmem-rss:0kB, UID:1001 pgtables:40960kB oom_score_adj:0"]
    return [prefix + l for l in lines]


def main():
    print("--- 1. the synthetic sosreport (every kind, every source) ---")
    out = os.path.join(WORKDIR, "mock")
    mock_generate.main(["--out", out, "--no-archives"])
    sos = os.path.join(out, mock_generate.SOS_NAME)
    scan = kl.scan(sos)
    check("scan reads the journal, the boot journal, dmesg, dmesg -T, messages and the rotated .gz",
          scan["sources"] == ["journal", "journal (boot)", "dmesg", "dmesg -T", "messages", "messages (rotated)"], str(scan["sources"]))
    check("boot time comes from date + uptime (Sep 19 10:18, to the minute)", scan["boot_time"] is not None and scan["boot_time"].strftime("%Y-%m-%d %H:%M") == "2026-09-19 10:18", str(scan["boot_time"]))
    traces = scan["traces"]
    check("6 traces, each seen in the journal and in dmesg once (deduped across sources, the dmesg stamp mapped through the boot time)",
          len(traces) == 6 and all("journal" in t["sources"] and "dmesg" in t["sources"] for t in traces), str([(t["type_key"], t["sources"]) for t in traces]))
    check("the dmesg copy did not add events: types = 2 WARNING, 1 BUG, 2 soft lockup, 1 RCU stall",
          sorted(t["type_key"] for t in traces) == ["bug", "rcu_stall", "soft_lockup", "soft_lockup", "warning", "warning"], str(sorted(t["type_key"] for t in traces)))
    st = kernel_stack_traces.parse(sos)["stack_traces"]
    check("Stack Traces: 4 groups (the two WARNINGs are one row with x2, the two soft lockups one row despite '22s'/'48s')",
          st["summary"]["groups"] == 4 and [(g["type_key"], g["count"]) for g in st["groups"]][:2] == [("warning", 2), ("soft_lockup", 2)], str([(g["type_key"], g["count"]) for g in st["groups"]]))
    w = st["groups"][0]
    check("the WARNING row: file, line, function, comm, kernel, taint G OE with its text, 13 modules, the faulting frame marked, the ? frame unreliable, <0f> the faulting byte",
          w["event"]["file"] == "drivers/example/example_fastpath.c" and w["event"]["line"] == "412" and w["event"]["function"].startswith("example_fastpath_poll+0x1a2/0x2f0")
          and w["event"]["comm"] == "example-worker" and w["event"]["kernel"] == KERNEL and w["event"]["taint"] == "G OE" and "out-of-tree" in w["event"]["taint_text"]
          and len(w["event"]["modules"]) == 13 and w["event"]["modules"][0] == {"name": "example_fastpath", "flags": "OE"}
          and [f["fault"] for f in w["event"]["frames"]][0] and w["event"]["frames"][1]["unreliable"] and w["event"]["frames"][1]["text"].startswith("? ")
          and [p["text"] for p in w["event"]["code"] if p["fault"]] == ["<0f>"], str(w["event"])[:600])
    check("the WARNING row's occurrences carry both timestamps and their sources", [o["ts"] for o in w["occurrences"]] == ["Oct 11 09:14:02", "Oct 12 14:01:55"] and "dmesg" in w["occurrences"][0]["source"], str(w["occurrences"]))
    bug = next(g for g in st["groups"] if g["type_key"] == "bug")
    check("the BUG row: title is the message, severity critical, comm example-cgi, RIP frame marked, <IRQ> frames collected",
          bug["title"] == "kernel NULL pointer dereference, address: 0000000000000010" and bug["severity"] == "critical" and bug["event"]["comm"] == "example-cgi"
          and bug["event"]["rip"].startswith("example_fastpath_rx") and any(f["fault"] for f in bug["event"]["frames"]) and len(bug["event"]["frames"]) == 9, str(bug)[:400])
    rcu = next(g for g in st["groups"] if g["type_key"] == "rcu_stall")
    check("the RCU stall row: title names the CPU and the jiffies", rcu["title"] == "rcu_sched self-detected stall on CPU 5 (t=60002 jiffies)", rcu["title"])
    check("summary: first/last, types in order, modules and processes counted, a timeline with buckets",
          st["summary"]["first"] == "Oct 11 09:14:02" and st["summary"]["last"] == "Oct 12 14:01:55" and [t["key"] for t in st["summary"]["types"]] == ["warning", "bug", "soft_lockup", "rcu_stall"]
          and st["summary"]["modules"][0]["name"] == "example_fastpath" and st["summary"]["timeline"]["max"] >= 1 and len(st["summary"]["timeline"]["buckets"]) >= 2, str(st["summary"])[:400])
    check("the legacy traces list keeps its shape (file:line, comm, call_trace, code)", st["traces"][0]["file"] == "drivers/example/example_fastpath.c:412" and len(st["traces"][0]["call_trace"]) == 7 and st["traces"][0]["code"][0].startswith("Code: 48 8b"), str(st["traces"][0])[:300])

    h = kernel_hung_task.parse(sos)
    check("Hung Tasks: 4 reports of 3 tasks, grouped by blocking function (nfs x2, jbd2, xfs), longest 245 s",
          h["hung_summary"]["reports"] == 4 and h["hung_summary"]["tasks"] == 3 and [g["function"] for g in h["hung_groups"]] == ["nfs_wait_on_request", "jbd2_log_wait_commit", "xlog_wait"]
          and h["hung_summary"]["longest"] == 245, str([(g["function"], g["module"], g["count"]) for g in h["hung_groups"]]))
    nfs = h["hung_groups"][0]["tasks"][0]
    check("the re-reported task is one entry: durations 122 -> 245, the stack from the first report, 'blocked here' on nfs_wait_on_request",
          nfs["durations"] == [122, 245] and nfs["duration_max"] == 245 and len(nfs["frames"]) == 16 and [f["text"] for f in nfs["frames"] if f["blocked"]] == ["  nfs_wait_on_request+0x5a/0x70 [nfs]"], str(nfs)[:400])
    r7 = next(t for g in h["hung_groups"] for t in g["tasks"] if t["comm"] == "kworker/u16:3")
    check("the RHEL 7 style report: pid/ppid/state/flags from the 'comm D addr' line, [<addr>] frames, the hex dump skipped",
          (r7["pid"], r7["ppid"], r7["state"], r7["flags"], len(r7["frames"])) == ("8821", "2", "D", "0x00000080", 8), str(r7)[:300])
    r8 = next(t for g in h["hung_groups"] for t in g["tasks"] if t["comm"] == "example-backup")
    check("the RHEL 8 style report (no <TASK> markers, 'Not tainted'): frames collected, kernel version, no taint",
          len(r8["frames"]) == 10 and r8["kernel"] == "4.18.0-553.el8_10.x86_64" and r8["taint"] == "" and r8["taint_text"] == "not tainted" and r8["ppid"] == "1", str(r8)[:300])
    check("hung_tasks (legacy) keeps task/pid/ppid/state/flags/call_trace", h["hung_tasks"][2]["details"]["pid"] == "4311" and h["hung_tasks"][2]["details"]["ppid"] == "4200" and len(h["hung_tasks"][2]["details"]["call_trace"]) == 16, str(h["hung_tasks"][2]["details"])[:200])

    o = kernel_oom_killer.parse(sos)
    check("OOM: 4 kills newest first, the one from messages-20261005.gz included, victims and constraints counted",
          o["oom_summary"]["kills"] == 4 and [e["ts"] for e in o["oom_events"]] == ["Oct 12 06:03:14", "Oct 11 22:45:09", "Oct 10 03:12:41", "Oct 05 03:00:00"]
          and o["oom_events"][-1]["sources"] == ["messages (rotated)"] and o["oom_summary"]["constraints"] == [{"name": "CONSTRAINT_NONE", "count": 3}, {"name": "CONSTRAINT_MEMCG", "count": 1}],
          str([(e["ts"], e["sources"]) for e in o["oom_events"]]))
    g = o["oom_events"][1]
    check("the global kill: victim figures in human units, trigger gfp flags, memory state (32 GB RAM, 152 MB free, swap 0 of 4 GB), the task table by rss with the victim marked",
          g["victim"]["comm"] == "example-worker" and g["victim"]["anon_rss"] == "29.1 GB" and g["victim"]["uid"] == "1001" and g["trigger"]["gfp_flags"] == "GFP_HIGHUSER_MOVABLE | __GFP_COMP"
          and g["mem"]["ram"] == "32.0 GB" and g["mem"]["free"] == "152 MB" and g["mem"]["swap_free"] == "0 kB" and g["mem"]["swap_total"] == "4.0 GB"
          and g["tasks"][0]["killed"] and g["tasks"][0]["name"] == "example-worker" and g["tasks"][0]["rss_kb"] == 30512000 and not g["tasks"][1]["killed"], str(g)[:600])
    check("the global kill's plain-words line names the machine-wide cause and the free/swap figures", "whole machine" in g["constraint"]["text"] and "152 MB free" in g["constraint"]["text"], g["constraint"]["text"])
    m = o["oom_events"][0]
    check("the cgroup kill: CONSTRAINT_MEMCG, the cgroup path, usage 8.0 GB of 8.0 GB, anon from the cgroup stats, the plain-words line says it is the container's limit",
          m["constraint"]["name"] == "CONSTRAINT_MEMCG" and m["constraint"]["cgroup"].startswith("/kubepods.slice/") and m["constraint"]["memcg_usage"] == "8.0 GB" and m["constraint"]["memcg_limit"] == "8.0 GB"
          and m["mem"]["active_anon"] == "8.0 GB" and "cgroup" in m["constraint"]["text"] and "8.0 GB used of 8.0 GB" in m["constraint"]["text"], str(m["constraint"]))
    check("oom_killer (legacy) is the raw blocks, one string each, with the Killed line", len(o["oom_killer"]) == 4 and all("Killed process" in b for b in o["oom_killer"]), str(len(o["oom_killer"])))
    check("the scan is cached per directory (the three parsers share one pass)", kl.scan(sos) is scan)

    print("\n--- 2. prefix formats, dmesg mapping, dedupe ---")
    iso = report("iso", {"sos_commands/logs/journalctl_--no-pager": "\n".join("2026-10-12T09:31:55+0000 web-01 kernel: " + l[len(K):] for l in hung_lines(K)) + "\n"})
    ev = kl.scan(iso)["hung"]
    check("ISO (short-iso) journal stamps are read", len(ev) == 1 and kl.fmt_ts(ev[0]) == "Oct 12 09:31:55" and ev[0]["ppid"] == "4200", str(ev and kl.fmt_ts(ev[0])))
    precise = report("precise", {"sos_commands/logs/journalctl_--no-pager": "\n".join("Oct 12 09:31:55.123456 web-01 kernel: " + l[len(K):] for l in warning_lines(K)) + "\n"})
    ev = kl.scan(precise)["traces"]
    check("short-precise stamps (microseconds) are read", len(ev) == 1 and kl.fmt_ts(ev[0]) == "Oct 12 09:31:55", str(ev and kl.fmt_ts(ev[0])))
    facility = report("facility", {"var/log/messages": "\n".join("Oct 12 09:31:55 web-01 kernel: <4>[ 1234.567890] " + l[len(K):] for l in warning_lines(K)) + "\n"})
    ev = kl.scan(facility)["traces"]
    check("a syslog line with a facility and a printk stamp ('<4>[ 1234.5]') is normalised", len(ev) == 1 and ev[0]["function"].startswith("example_fastpath_poll") and len(ev[0]["frames"]) == 4, str(ev and ev[0]["frames"]))
    dmesg_only = report("dmesg-only", {"sos_commands/kernel/dmesg": "\n".join(f"[{2000000.5 + i:12.6f}] " + l[len(K):] for i, l in enumerate(warning_lines(K))) + "\n"})
    ev = kl.scan(dmesg_only)["traces"]
    check("dmesg-only report (no journal): the trace is found and its seconds map to wall time through date - uptime (Sep 19 10:18 + 2,000,000 s = Oct 12 13:51)",
          len(ev) == 1 and kl.fmt_ts(ev[0]) == "Oct 12 13:51:20" and ev[0]["sources"] == ["dmesg"], str(ev and (kl.fmt_ts(ev[0]), ev[0]["sources"])))
    no_boot = report("dmesg-no-boot", {"sos_commands/kernel/dmesg": "\n".join(f"[{2000000.5 + i:12.6f}] " + l[len(K):] for i, l in enumerate(warning_lines(K))) + "\n"}, date=None, uptime=None)
    ev = kl.scan(no_boot)["traces"]
    check("dmesg without a boot time: the event keeps its seconds as the timestamp instead of a guess", len(ev) == 1 and kl.fmt_ts(ev[0]) == "[2000000.500]" and ev[0]["ts"] is None, str(ev and kl.fmt_ts(ev[0])))
    dmesg_t = report("dmesg-T", {"sos_commands/kernel/dmesg_-T": "\n".join("[Mon Oct 12 09:31:55 2026] " + l[len(K):] for l in warning_lines(K)) + "\n"})
    ev = kl.scan(dmesg_t)["traces"]
    check("dmesg -T stamps are read", len(ev) == 1 and kl.fmt_ts(ev[0]) == "Oct 12 09:31:55", str(ev and kl.fmt_ts(ev[0])))
    both = report("both", {"sos_commands/logs/journalctl_--no-pager": "\n".join("Oct 12 09:31:55 " + l for l in warning_lines(K)) + "\n",
                           "sos_commands/kernel/dmesg": "\n".join(f"[{1984355.0 + i:12.6f}] " + l[len(K):] for i, l in enumerate(warning_lines(K))) + "\n",
                           "var/log/messages": "\n".join("Oct 12 09:31:55 " + l for l in warning_lines(K)) + "\n" + "\n".join("Oct 12 10:00:00 " + l for l in warning_lines(K)) + "\n"})
    ev = kl.scan(both)["traces"]
    check("the same trace in the journal, dmesg (stamp within the boot-time tolerance) and messages is ONE event listing three sources; the later copy in messages is a second event",
          len(ev) == 2 and ev[0]["sources"] == ["journal", "dmesg", "messages"] and ev[1]["sources"] == ["messages"] and kl.fmt_ts(ev[0]) == "Oct 12 09:31:55", str([(kl.fmt_ts(e), e["sources"]) for e in ev]))
    year = report("year", {"sos_commands/logs/journalctl_--no-pager": "\n".join("Dec 30 23:59:59 " + l for l in warning_lines(K)) + "\n"}, date="Sat Jan 10 08:00:00 UTC 2026")
    ev = kl.scan(year)["traces"]
    check("a December stamp in a January report belongs to the previous year", len(ev) == 1 and ev[0]["ts"].year == 2025, str(ev and ev[0]["ts"]))

    print("\n--- 3. line forms and grouping ---")
    tight = report("tight", {"sos_commands/logs/journalctl_--no-pager": "\n".join("Oct 12 09:34:00 " + l for l in hung_lines(K, task_line="task:example-worker  state:D stack:0 pid:4311 ppid:4200 flags:0x00004080")) + "\n"})
    ev = kl.scan(tight)["hung"]
    check("the tight legacy task: line (pid:4311 ppid:4200)", len(ev) == 1 and (ev[0]["pid"], ev[0]["ppid"]) == ("4311", "4200"), str(ev and (ev[0]["pid"], ev[0]["ppid"])))
    tgid = report("tgid", {"sos_commands/logs/journalctl_--no-pager": "\n".join("Oct 12 09:34:00 " + l for l in hung_lines(K, task_line="task:example-worker  state:D stack:0     pid:4311  tgid:4311  ppid:4200 flags:0x00004002")) + "\n"})
    ev = kl.scan(tgid)["hung"]
    check("the 6.x task: line with tgid", len(ev) == 1 and (ev[0]["pid"], ev[0]["tgid"], ev[0]["ppid"], ev[0]["flags"]) == ("4311", "4311", "4200", "0x00004002"), str(ev and ev[0]))
    old = report("rhel7-task", {"var/log/messages": "\n".join("Oct 12 09:34:00 " + l for l in hung_lines(K, task_line="task: ffff880855dd1f60 ti: ffff8808546b0000 task.ti: ffff8808546b0000", markers=False)) + "\n"})
    ev = kl.scan(old)["hung"]
    check("the oldest 'task: addr ti: addr' form: pid from the INFO line, state D, the stack still collected", len(ev) == 1 and ev[0]["pid"] == "4311" and ev[0]["state"] == "D" and len(ev[0]["frames"]) == 7, str(ev and ev[0]))
    two = report("two-hung", {"sos_commands/logs/journalctl_--no-pager": "\n".join("Oct 12 09:31:55 " + l for l in hung_lines(K)) + "\n" + "\n".join("Oct 12 09:34:00 " + l for l in hung_lines(K, secs=245)) + "\n"
                              + "\n".join("Oct 12 09:35:00 " + l for l in hung_lines(K, comm="other", pid=77)) + "\n"})
    g = kernel_hung_task.parse(two)["hung_groups"]
    check("two back-to-back reports do not bleed into each other (7 frames each), the same pid is one task with two durations, another pid in the same function joins the group",
          len(g) == 1 and g[0]["count"] == 3 and [(t["pid"], t["durations"], len(t["frames"])) for t in g[0]["tasks"]] == [("4311", [122, 245], 7), ("77", [122], 7)], str(g))
    old_oom = report("rhel7-oom", {"var/log/messages": "\n".join("Oct 12 09:34:00 " + K + l for l in [
        "httpd invoked oom-killer: gfp_mask=0x201da, order=0, oom_score_adj=0",
        "httpd cpuset=/ mems_allowed=0",
        f"CPU: 1 PID: 2305 Comm: httpd Not tainted 3.10.0-1160.el7.x86_64 #1",
        "Call Trace:", " [<ffffffff81186a0e>] dump_stack+0x19/0x1b", " [<ffffffff81181c7e>] out_of_memory+0x4b6/0x4f0",
        "Mem-Info:", "active_anon:1000000 inactive_anon:1000 isolated_anon:0", " free:5000 free_pcp:0 free_cma:0",
        "Free swap  = 0kB", "Total swap = 0kB", "2097152 pages RAM",
        "[ pid ]   uid  tgid total_vm      rss nr_ptes swapents oom_score_adj name",
        "[ 2305]    48  2305    90250   900000     200        0             0 httpd",
        "Out of memory: Kill process 2305 (httpd) score 900 or sacrifice child",
        "Killed process 2305 (httpd) total-vm:361000kB, anon-rss:3600000kB, file-rss:0kB, shmem-rss:0kB"]) + "\n"})
    o = kernel_oom_killer.parse(old_oom)["oom_events"]
    check("a RHEL 7 OOM (no constraint line, 'Kill process ... or sacrifice child' + 'Killed process'): victim, rss, the task table with its own columns, no swap",
          len(o) == 1 and o[0]["victim"]["comm"] == "httpd" and o[0]["victim"]["anon_rss"] == "3.4 GB" and o[0]["tasks"][0]["rss_kb"] == 3600000 and o[0]["mem"]["swap_total"] == ""
          and "older kernel" in o[0]["constraint"]["text"], str(o)[:500])
    no_kill = report("oom-no-kill", {"var/log/messages": "\n".join("Oct 12 09:34:00 " + K + l for l in [
        "httpd invoked oom-killer: gfp_mask=0x201da, order=0, oom_score_adj=0", "Mem-Info:", "Out of memory and no killable processes..."]) + "\n"})
    o = kernel_oom_killer.parse(no_kill)
    check("an OOM without a kill ('no killable processes') is still one event, flagged no_kill, with an empty victim and the trigger kept",
          o["oom_summary"]["kills"] == 1 and o["oom_events"][0]["no_kill"] and o["oom_events"][0]["victim"]["comm"] == "" and o["oom_events"][0]["trigger"]["comm"] == "httpd", str(o["oom_events"]))
    lockup = lambda secs: ["watchdog: BUG: soft lockup - CPU#2 stuck for " + secs + "s! [example-worker:4311]", "Modules linked in: xfs", f"CPU: 2 PID: 4311 Comm: example-worker Not tainted {KERNEL} #1",
                           "RIP: 0010:example_spin+0x10/0x20", "Call Trace:", " <TASK>", " example_spin+0x10/0x20", " </TASK>"]
    soft = report("soft", {"var/log/messages": "\n".join("Oct 12 09:34:00 " + K + l for l in lockup("23")) + "\n" + "\n".join("Oct 12 09:35:00 " + K + l for l in lockup("45")) + "\n"
                           + "\n".join("Oct 12 09:36:00 " + K + l for l in [
        "NMI watchdog: Watchdog detected hard LOCKUP on cpu 3", f"CPU: 3 PID: 0 Comm: swapper/3 Not tainted {KERNEL} #1", "Call Trace:", " <NMI>", " example_irq+0x1/0x2", " </NMI>",
        "Kernel panic - not syncing: Fatal exception in interrupt", "Call Trace:", " panic+0x1/0x2", "---[ end Kernel panic - not syncing: Fatal exception in interrupt ]---"]) + "\n"})
    st = kernel_stack_traces.parse(soft)["stack_traces"]
    check("soft lockups at 23s and 45s group into one row (x2); a hard lockup and a panic are their own critical rows",
          [(g["type_key"], g["count"], g["severity"]) for g in st["groups"]] == [("soft_lockup", 2, "critical"), ("hard_lockup", 1, "critical"), ("panic", 1, "critical")], str([(g["type_key"], g["count"]) for g in st["groups"]]))
    check("a BUG header inside the soft lockup line does not make it a BUG", st["groups"][0]["type_label"] == "soft lockup" and st["groups"][0]["title"] == "CPU#2 stuck for 23s! [example-worker:4311]", st["groups"][0]["title"])

    print("\n--- 4. malformed, huge, missing ---")
    junk = report("junk", {"sos_commands/logs/journalctl_--no-pager": "Oct 12 09:31:55 web-01 kernel: INFO: task :: blocked for more than seconds\n"
                           "Oct 12 09:31:55 web-01 kernel: WARNING: \n" "garbage \xff\xfe line\n" "Oct 12 09:31:55 web-01 kernel: task:\n" "Oct 12 09:31:55 web-01 kernel: Out of memory: Killed process (x)\n"
                           "Oct 12 09:31:55 web-01 kernel: oom-kill:constraint=\n" "Oct 32 25:61:61 web-01 kernel: WARNING: CPU: x PID: y at z\n" "\n" "-- Reboot --\n"})
    try:
        r = {k: v for k, v in kl.scan(junk).items() if k in ("traces", "hung", "oom")}
        check("malformed lines never raise (an empty WARNING, a broken INFO line, a bad date, invalid UTF-8)", True)
        for name in ("kernel_stack_traces", "kernel_hung_task", "kernel_oom_killer"):
            mod = {"kernel_stack_traces": kernel_stack_traces, "kernel_hung_task": kernel_hung_task, "kernel_oom_killer": kernel_oom_killer}[name]
            mod.parse(junk)
        check("the three parsers survive the same input", True)
    except Exception:
        check("malformed lines never raise", False, traceback.format_exc()[-400:])
    missing = report("missing", {"sos_commands/logs/other": "nothing\n"})
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        empties = (kernel_stack_traces.parse(missing), kernel_hung_task.parse(missing), kernel_oom_killer.parse(missing))
    check("a report without any kernel log: empty results with no sources, nothing printed",
          empties[0]["stack_traces"]["groups"] == [] and empties[0]["stack_traces"]["summary"]["sources"] == [] and empties[1]["hung_groups"] == [] and empties[2]["oom_events"] == [] and empties[2]["oom_killer"] == []
          and "Failed" not in buf.getvalue() and "Traceback" not in buf.getvalue(), buf.getvalue()[-200:])
    big_lines = []
    for i in range(1200):
        big_lines += ["Oct 12 09:31:55 " + l for l in warning_lines(K, fn=f"example_fn_{i}+0x1/0x2")]
    big = report("big", {"sos_commands/logs/journalctl_--no-pager": "\n".join(big_lines) + "\n"})
    import time
    t0 = time.time()
    st = kernel_stack_traces.parse(big)["stack_traces"]
    took = time.time() - t0
    check(f"1,200 distinct traces (19k lines): capped at {kl.MAX_EVENTS_PER_KIND} events, the summary says so, in {took:.1f}s",
          st["summary"]["total"] == kl.MAX_EVENTS_PER_KIND and st["summary"]["capped"] is True and took < 10, str((st["summary"]["total"], st["summary"]["capped"], took)))
    wrapped = os.path.join(WORKDIR, "wrapped")
    os.makedirs(wrapped)
    shutil.copytree(sos, os.path.join(wrapped, os.path.basename(sos)))
    check("a report extracted into a single wrapper directory is unwrapped like the other parsers do", kernel_oom_killer.parse(wrapped)["oom_summary"]["kills"] == 4)

    print("\n--- 5. the templates through Flask (escaping, empty states, no utility classes the frame lacks) ---")
    app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
    nasty = report("nasty", {"sos_commands/logs/journalctl_--no-pager": "\n".join("Oct 12 09:31:55 " + l for l in warning_lines(K, extra_frame="<script>alert(1)</script>+0x1/0x2"))
                             .replace("Comm: example-worker", "Comm: <img src=x onerror=alert(2)>") + "\n"
                             + "\n".join("Oct 12 09:34:00 " + l for l in hung_lines(K, comm="<b>bold</b>", pid=99, task_line="task:<b>bold</b>  state:D stack:0 pid: 99 ppid:  1 flags:0x1")) + "\n"
                             + "\n".join("Oct 12 09:35:00 " + l for l in oom_lines(K, pid=5, comm="</pre><script>x</script>")) + "\n"})
    with app.app_context():
        pages = {name: render_template(f"tabs/sosreport_{name}.html", data=mod.parse(nasty), directory=nasty)
                 for name, mod in (("kernel_stack_traces", kernel_stack_traces), ("kernel_hung_task", kernel_hung_task), ("kernel_oom_killer", kernel_oom_killer))}
        empty_pages = {name: render_template(f"tabs/sosreport_{name}.html", data=mod.parse(missing), directory=missing)
                       for name, mod in (("kernel_stack_traces", kernel_stack_traces), ("kernel_hung_task", kernel_hung_task), ("kernel_oom_killer", kernel_oom_killer))}
    for name, html in pages.items():
        check(f"{name}: report text is escaped (no <script>, <img onerror>, <b> or </pre> from the log reaches the page)",
              "<script>alert(1)" not in html and "<img src=x" not in html and "</pre><script>x" not in html and "<b>bold</b>" not in html and "&lt;" in html, html[:200])
        check(f"{name}: the page renders the data (a row, the strip, the filters)", 'class="kd-row' in html and 'kd-strip' in html and 'kd-search' in html)
    for name, html in empty_pages.items():
        check(f"{name}: the empty state (no 'None' printed, no rows)", "kd-empty" in html and "None" not in html.replace("No kernel", "").replace("No hung", "").replace("No OOM", "") and 'class="kd-row' not in html, html[-300:])
    tabs_dir = os.path.join(BACKEND, "templates", "tabs")
    for name in ("sosreport_kernel_stack_traces.html", "sosreport_kernel_hung_task.html", "sosreport_kernel_oom_killer.html", "_kernel_diag.html", "_kernel_diag_macros.html"):
        src = open(os.path.join(tabs_dir, name)).read()
        check(f"{name}: no |safe, no Font Awesome <i class=\"fas\">, no &nbsp;, no utility grid/colour classes the frame does not compile",
              "|safe" not in src and "| safe" not in src and 'class="fas' not in src and "&nbsp;" not in src
              and not any(c in src for c in ("grid-cols-", "col-span-", "bg-gray-", "text-gray-", "md:", "whitespace-pre-wrap", "shadow-md")), name)

    print(f"\n{'All checks passed' if not FAILED else str(FAILED) + ' check(s) failed'}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        shutil.rmtree(WORKDIR, ignore_errors=True)
    sys.exit(code)
