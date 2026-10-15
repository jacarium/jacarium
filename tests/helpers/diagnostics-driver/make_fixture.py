#!/usr/bin/env python3
"""Build a fully SYNTHETIC sosreport-shaped directory for live UI testing.

Every value below is fabricated (example-daemon commands, sequential pids,
round numbers). Nothing is copied from any real system or customer report.
"""
import os, shutil

BASE = "/tmp/diag-reports/sosreport-synthetic-2026"
NPROC = 700
NCORES = 126  # a 126-core system
# Long, kubepods-style nested cgroup paths (synthetic hex)
def _hex(seed):
    return (f"{seed:02x}" * 32)[:64]
SLICES = [
    f"kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod{_hex(i)}.slice/crio-{_hex(i + 100)}.scope"
    for i in range(3)
]

if os.path.exists(BASE):
    shutil.rmtree(BASE)

def w(rel, content):
    p = os.path.join(BASE, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(content)

# proc/mounts -> cgroup v1
w("proc/mounts", "cgroup /sys/fs/cgroup/cpu,cpuacct cgroup rw 0 0\n"
                 "cgroup /sys/fs/cgroup/memory cgroup rw 0 0\n")

pids = [str(1000 + i) for i in range(NPROC)]
slice_of = {pid: SLICES[i % len(SLICES)] for i, pid in enumerate(pids)}

# sys/fs/cgroup trees
for s in SLICES:
    members = "\n".join(p for p in pids if slice_of[p] == s) + "\n"
    w(f"sys/fs/cgroup/cpu,cpuacct/{s}/cpu.cfs_quota_us", "-1\n")
    w(f"sys/fs/cgroup/cpu,cpuacct/{s}/cpu.cfs_period_us", "100000\n")
    w(f"sys/fs/cgroup/cpu,cpuacct/{s}/cpuacct.usage_percpu",
      " ".join(["2500000000"] * NCORES) + "\n")
    w(f"sys/fs/cgroup/cpu,cpuacct/{s}/cgroup.procs", members)
    w(f"sys/fs/cgroup/cpuset/{s}/cpuset.cpus", f"0-{NCORES - 1}\n")
    w(f"sys/fs/cgroup/memory/{s}/memory.usage_in_bytes", str(256 * 1024 * 1024) + "\n")
    w(f"sys/fs/cgroup/memory/{s}/memory.limit_in_bytes", str(1024 * 1024 * 1024) + "\n")
    w(f"sys/fs/cgroup/memory/{s}/cgroup.procs", members)

# proc/<pid>/cgroup
for pid in pids:
    s = slice_of[pid]
    w(f"proc/{pid}/cgroup",
      f"4:memory:/{s}\n3:cpu,cpuacct:/{s}\n2:cpuset:/{s}\n")

# ps auxwwwm
lines = ["USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND"]
for i, pid in enumerate(pids):
    cpu = round((i % 40) * 0.11, 2)
    mem = round((i % 25) * 0.13, 2)
    # Very long, realistic-shaped (but synthetic) command line: java-style flag
    # soup plus a long classpath-ish token, ~600 chars per process.
    long_args = " ".join(f"--example-flag-{j}=value{j}" for j in range(20))
    long_path_token = "/opt/example/lib/" + "-".join(f"module{j}" for j in range(15)) + ".jar"
    cmd = (f"/usr/bin/example-daemon-{i:03d} --worker --loglevel=info "
           f"{long_args} -classpath {long_path_token} "
           f"--config=/etc/example/conf.d/example-daemon-{i:03d}.yaml")
    lines.append(f"svcuser {pid} {cpu} {mem} 123456 7890 ? Ssl Jan01 0:0{i % 10} {cmd}")
w("sos_commands/process/ps_auxwwwm", "\n".join(lines) + "\n")

# free -m
w("sos_commands/memory/free_-m",
  "              total        used        free      shared  buff/cache   available\n"
  "Mem:          16000        8000        4000        1000        3000        6000\n"
  "Swap:          2048           0        2048\n")

# journalctl (for the Log Viewer tab - streaming + severity classification +
# its INNER scrolling log output panel). Fully synthetic entries.
SEVERITY_MSGS = [
    "info: example-daemon heartbeat ok, queue depth 3",
    "warning: example-cache nearing capacity (80 percent)",
    "error: example-worker failed to connect to 192.0.2.10:9999",
    "debug: example-scheduler trace tick 42",
    "notice: example-updater applied synthetic profile",
]
jlines = ["-- Logs begin at Thu 2026-01-01 00:00:00 UTC. --"]
for i in range(200):
    hh, mm, ss = (i // 3600) % 24, (i // 60) % 60, i % 60
    jlines.append(
        f"Jan {1 + (i % 5):2d} {hh:02d}:{mm:02d}:{ss:02d} synthetic-host "
        f"example-daemon-{i % 20:03d}[{1000 + i}]: {SEVERITY_MSGS[i % len(SEVERITY_MSGS)]}"
    )
w("sos_commands/logs/journalctl_--no-pager", "\n".join(jlines) + "\n")

# systemctl status --all (for the already-paginated Services tab)
units = []
for i in range(320):
    units.append(
        f"* example-{i:03d}.service - Synthetic example service {i:03d}\n"
        f"     Loaded: loaded (/usr/lib/systemd/system/example-{i:03d}.service; enabled)\n"
        f"     Active: active (running) since Thu 2026-01-01 00:00:00 UTC\n"
        f"      Tasks: 5 (limit: 100)\n"
        f"     Memory: 10.0M\n"
        f"        CPU: 100ms\n"
        f"         IO: 1.0M read, 1.0M written\n"
    )
w("sos_commands/systemd/systemctl_status_--all", "\n".join(units))

print("fixture at", BASE)
