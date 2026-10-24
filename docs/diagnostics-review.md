# Diagnostics plugins: review (Phase 1)

A review of every Diagnostics plugin (sosreport and must-gather) for parser
correctness, usefulness for troubleshooting and performance, with the bugs
found and the improvements proposed, prioritised P1 (must) / P2 (should) /
P3 (nice). Everything below was established from the parser sources, the
file formats they consume (sos 3.x/4.x layouts, RHEL 7/8/9/10 output
differences, OCP 4.x must-gathers), the synthetic mock reports
(`tests/fixtures/diagnostics-mock`) and a read-only run against the lab
must-gather (aggregates and timings only; it is a trimmed gather with the audit logs only, so most
must-gather parsers take the empty / missing paths there).

Phase 2 implements every proposal below (P1, P2 and P3), plugin group by
plugin group, each on its own branch; the items under "Deferred: needs the
user" are the ones that need a product decision.

## How the review was run

- Read-only run of every must-gather parser against the lab must-gather
  (a trimmed gather, audit logs only): 18 parsers, all
  pass, 5.2 s in total (the Audit scan 5.17 s for the 239 aggregate items
  it builds, every other parser 0.00-0.01 s on the empty / missing paths,
  resident memory +4 MB for Audit, +1 MB for Cluster). No names or values
  were read beyond what the parsers aggregate.
- Every sosreport parser against the large synthetic sosreport (50k-line
  journal, 570 files): 33 parsers, all pass, 0.14 s in total (the kernel
  scan 0.08 s; sar CPU 3,375 points, sar disk 1,875, sar network 1,500).
- Every sosreport parser against the two manifest-only synthetic
  sosreports (an old-format one and an OCP master one, i.e. a report with
  most plugins missing): two parsers crash with `FileNotFoundError`
  (`disk_lvm`, `openstack_dpdk`); the rest return their empty state.
- The mock reports and new targeted edge-case snippets (RHEL 7 `free`,
  12-hour `sar`, RHEL 8 `sched_debug`, `lspci` without `-nn`, right-aligned
  `lvs` columns) are the fixtures of the Phase 1 fixes.

## Bugs found (clear, fixed in Phase 1 with a test each)

All thirteen are fixed on `feature/diagnostics-parsers-phase1`, each with a
check in `tests/diagnostics_parsers_edge.test.py`; the shared pieces live in
`backend/parsers/sosreport/_common.py`.

| # | Plugin | Severity | Bug |
|---|--------|----------|-----|
| B1 | Disk > LVM | P1 | `parse()` calls `os.listdir(sos_commands/lvm2)` without checking the directory exists: a report without the lvm2 plugin (or an old layout) raises `FileNotFoundError` and the tab fails instead of showing the empty state. |
| B2 | OpenStack > DPDK | P1 | Same: `parse_cmdline(proc/cmdline)` opens the file without a check; a report without `proc/cmdline` (older sos, a partial report) raises and the tab fails instead of showing what is missing. |
| B3 | System > System Information | P1 | `free -m` on RHEL 7 (procps 3.3.10-) prints `total used free shared buffers cached` (no `available`): `fields[6]` raises `IndexError` and the whole tab fails. RHEL 8/9/10 unaffected. |
| B4 | System > PCI Devices | P1 | The header regex requires the `-nn` form (`[0300]: ... [8086:1234]`), but the parser reads only `sos_commands/hardware/lspci_-vvv` and the root `lspci` symlink: sos 4 writes the capture under `sos_commands/pci/` (`lspci_-nnvv`, `lspci`, `lspci_-tv`) and older sos wrote `lspci_-nvv` (numeric ids only) and a plain `lspci` (no ids). Result: an empty page on current reports and on every plain capture. |
| B5 | SAR (all four) | P1 | `sar` text in a US locale carries a 12-hour clock (`12:00:01 AM`): the `AM`/`PM` token shifts every column (CPU id / interface / device become `AM`, the first value fails `float()`), so every line is skipped and the tabs are empty. |
| B6 | SAR (all four) | P1 | Only `var/log/sa/sarDD` (the text files the `sa2` cron job writes) are read; the files sos itself always writes, `sos_commands/sar/sarDD` (and `sar_-A_...`), are ignored, so a host without `sa2` output (the default on RHEL 9, where `sa2` is off) shows no data. |
| B7 | System > Scheduler Debug | P1 | Only `sys/kernel/debug/sched/debug` (kernel 5.14+) is read; RHEL 7/8 (`proc/sched_debug`) gives "file not found". And the task-line regex requires ten numeric columns (the RHEL 9 `sum-block` column): on RHEL 8 (nine columns) no task is parsed at all. |
| B8 | SAR > Network | P2 | The `IFACE` header matches both the `DEV` block (`rxpck/s ...`) and the `EDEV` block (`rxerr/s ...`); their rows merge into one series per interface with alternating keys, so the chart shows holes and wrong values. |
| B9 | Disk > LVM | P2 | Columns are sliced from the header's start to the next header's start; lvm right-aligns numeric columns, so a value wider than its header (`<100.00g` under `PSize`) loses its first characters (`0.00g`). |
| B10 | OpenStack > HAProxy | P2 | Log timestamps get the current wall-clock year, not the report's year: a December report read in January dates every line a year too late, and the charts' time axis is wrong. |
| B11 | System > Processes | P2 | `open(ps_path)` without `errors='replace'`: one non-UTF-8 byte in a command line (not unusual) raises, is swallowed by the broad `except` and the page shows an error with no processes. The same copy of `parse_ps_file` lives in cgroups CPU and cgroups Memory (three copies). |
| B12 | SAR > CPU | P3 | The header test needs `%usr`; a `sar -u` capture (no `ALL`) prints `%user` and is skipped. |
| B13 | every sosreport parser | P2 | The nested-directory heuristic (`len(os.listdir(dir)) == 1` -> descend) descends into a report whose only top-level entry is the report's own `sos_commands` (or `proc`), and every parser then looks in the wrong place; each parser carried its own copy of it. One shared `report_root` (markers first, then the single nested directory) replaces the copies. |

## Per plugin

### sosreport: System group

**Processes** (`processes.py`, `sosreport_processes.html`)
- Correctness: B11; the thread (`-` PID) handling and the LABEL column of
  `ps auxZww` are right; `ps_auxwww`/`ps_-elfL` (what sos writes when
  `auxwwwm` is absent, sos < 4.0) are not consulted (P2).
- Usefulness: P1 a Findings strip (zombie count, D-state tasks, the top
  CPU and memory consumers, processes with thousands of threads); P1 sort
  by %CPU descending by default, numeric sorting on every numeric column;
  P2 cross-links: a process to its cgroup (Control Groups) and to its unit
  (Services), a PID to the OOM / hung-task reports (Kernel); P3 the
  STAT legend table is noise on top of the page: fold it into a tooltip.
- Performance: one pass, fine (10k lines in 20 ms).

**PCI Devices** (`pci_devices.py`)
- Correctness: B4. Also `lspci -tv` / `lspci -nnk` (driver in use) are not
  read: the kernel driver and module are the most useful fields for support
  (P2).
- Usefulness: P2 group by class (network, storage, GPU), show the driver,
  link a NIC to its interface (Network Interface Statistics); P3 hide the
  raw details behind an expander.

**System Information** (`system.py`)
- Correctness: B3; the uptime regex only matches English `up ..., N users`
  (P3: a localized or `up 3 min` form falls back to empty).
- Usefulness: P2 show kernel taints (`/proc/sys/kernel/tainted`,
  `sos_commands/kernel/sysctl_-a`), selinux mode, the boot command line,
  the load average against the CPU count (load / cores) with a warning,
  memory pressure (available vs total) as a Findings strip; P3 the
  `hostnamectl` table has no value for troubleshooting beyond the hostname,
  OS and kernel: keep those four.

**Scheduler Debug** (`sched_debug.py`)
- Correctness: B7. The summary uses a fixed `wait_time > 0.1` for "high
  wait" (0.1 ms): on busy hosts almost every task qualifies (P2: use the
  distribution, e.g. the top decile).
- Usefulness: P1 a Findings strip (CPUs with the deepest runqueues,
  tasks with the longest wait, real-time tasks starving others); P2 per
  CPU: the current task, nr_running, load; P3 the all-tasks table is very
  wide: nowrap cells in a scrolling wrapper (now shared) and a column
  picker.
- Performance: fine (one pass over a few MB); the page renders every task
  of every CPU into the DOM (thousands of rows) before paginating (P2:
  paginate server-side or build rows on demand).

**Services** (`services.py`)
- Correctness: the block parser handles `systemctl status --all` of
  systemd 219-255; a unit without a description (`● foo.service` alone)
  is skipped (P3); `Memory: 812.4M (peak: 1.2G swap: 0B)` (systemd 252+)
  is parsed as text, and the template's memory bar parses only the first
  number (right by luck). `CPU: 1min 2.345s` (new form) is not summed (P3).
- Usefulness: P1 Findings: failed units first, units whose `Tasks` are
  near their limit, units restarting (`Active: activating (auto-restart)`),
  units with a huge memory footprint; P1 sort by state (failed, activating,
  active) then memory; P2 cross-link a unit to the Log Viewer with the
  unit's name as the process filter; P3 the second table (details) repeats
  the first: fold into one expandable row.
- Performance: fine.

**C-States** (`cstates.py`)
- Correctness: right for sysfs captures; `cpu0/online` is normally absent
  (handled). A host without `cpuidle` gives an empty page without saying
  why (P3: say "no cpuidle driver captured").
- Usefulness: P2 a one-line verdict (deepest state used, share of time in
  C0 vs deep states, cpufreq governor), P3 the per-CPU table is wide: the
  shared scrolling wrapper fixes the overflow.

### sosreport: OpenStack group

**DPDK** (`openstack_dpdk.py`)
- Correctness: B2. The parser reads `var/lib/config-data/puppet-generated/
  nova_libvirt/etc/nova/nova.conf` (OSP 13-17 containerised layout) and
  `etc/libvirt/qemu/*.xml`; a non-containerised or OSP 18 (podified)
  host has neither (P2: fall back to `etc/nova/nova.conf` and say what was
  looked for).
- Usefulness: P2 Findings: PMD threads over 90% busy, rx queues over 80%,
  NUMA mismatches between a VM's vCPUs and its physnet; the eight tables
  gain from the shared stacked rows on narrow screens.

**HAProxy** (`haproxy.py`)
- Correctness: B10. The `error` / `timeout` patterns are plain words, so
  every log line that contains "error" counts as an issue (noise, P2:
  match HAProxy's own forms: `SC`, `sH`, `PR` termination states and
  `Connect() failed`). Only `var/log/containers/haproxy/haproxy.log*` (the
  OSP container layout) is looked at; a plain RHEL HAProxy logs to
  `var/log/haproxy.log` or `var/log/messages` (P2).
- Usefulness: P1 Findings: backends with no server, servers DOWN, the
  5xx share per backend; P2 a per-backend / per-frontend table with the
  request count, the error rate and the p95 of `Tr`; P3 the config view
  could show the servers with their `check` state.
- Performance: a 1 GB log is read line by line but every match keeps the
  whole line in memory (capped at 100 per kind, fine); the time series is
  built in Python per minute: fine up to ~10M lines (P3: a budget like the
  Audit scan's).

**Pacemaker** (`pacemaker.py`)
- Correctness: `pcs status --full` of pcs 0.9 (RHEL 7) and 0.10/0.11
  differ ("Online:" vs "Node List:"); both forms are handled for nodes, but
  the resource lines of pcs 0.9 (`resource (ocf::heartbeat:IPaddr2): Started node1`)
  are parsed with the 0.10 regexes only (P2). Failed actions parsing
  depends on `Failed Resource Actions:` (0.10+) and misses `Failed
  Actions:` (0.9) (P2).
- Usefulness: P1 Findings: offline / standby nodes, stopped or failed
  resources, fencing history entries, quorum lost; P2 cross-link a
  resource failure to the Log Viewer at its time.

### sosreport: Disk, Control Groups, Network, SAR

**LVM** (`disk_lvm.py`): B1, B9. P2 derive VG free space and thin-pool
data% / metadata% warnings (over 90%) for the Findings strip.

**Disk Usage** (`disk_usage.py`): sizes are raw 1K blocks shown as numbers
(P2 human sizes, sort by use% descending, highlight >90% and >95%); `df -i`
(inode exhaustion, a classic) is not read (P2: `sos_commands/filesys/df_-ali`).
Pseudo filesystems (tmpfs, overlay) dominate the list (P3: group them
after the real mounts).

**Control Groups CPU / Memory** (`cgroups_cpu.py`, `cgroups_memory.py`)
- Correctness: cgroup v1 only (`sys/fs/cgroup/cpu,cpuacct`,
  `sys/fs/cgroup/memory`); RHEL 9 and OCP nodes use cgroup v2 (`cpu.stat`,
  `cpu.max`, `memory.current`, `memory.max` under one tree), so both tabs
  are empty there (P1 in Phase 2: v2 support). `detect_cgroup_version`
  is computed and never used. `cpuacct.usage_percpu` is shown as "core
  usage" but it is the cgroup's own usage split across cores (a share, not
  a utilisation) and `calculate_percpu_usage_percent` keeps module-level
  state between reports (dead code, P3 remove). B11 applies (the ps copy).
- Usefulness: P1 Findings: cgroups at their memory limit (usage_percent
  near 100), throttled cgroups (`cpu.stat nr_throttled`), the biggest
  consumers; P2 link a cgroup to its processes (present) and to the unit.

**Network Interface Statistics** (`network_stats.py`): correct for
`ip -s -d link` of iproute2 4.x-6.x (the `missed`/`overrun` column name
difference is handled generically). P1 Findings: interfaces with RX/TX
errors or drops, DOWN interfaces that carry an address, bonding slaves
down (`proc/net/bonding/*`, not read, P2), MTU mismatches on a bond; P2
read `ethtool_-S_*` for NIC-level counters and `ethtool_-i_*` for the
driver/firmware; P3 the cards could become one table.

**Flow Visualization** (`network_flow.py`): an empty parser and an empty
page (P2: either the OVS flow table / `nft list ruleset` / `iptables`
summary, or drop the tab; see Deferred).

**SAR CPU / Memory / Network / Disk**: B5, B6, B8, B12. P2 derive the
interval from the data instead of a fixed 10-minute bucket; P2 Findings:
iowait over 20%, steal over 5%, memory used over 90% with swap activity,
an interface at line rate, a disk with await over 50 ms; P3 the metric
toggles are twelve checkboxes: a legend click (now shared) does the same.

### sosreport: Kernel, Log Collection, Sos Report

**Kernel (Stack Traces, Hung Tasks, OOM Killer)** (`kernel_log.py` and
the three tabs): reviewed last round, streamed with caps and a cache, the
RHEL 7/8/9/10 forms covered by tests. P2 Findings on the Kernel group page
(the three tabs' counts, the last incident time), P3 cross-link an OOM
victim to Processes / Control Groups.

**Log Collection / Log Viewer** (`log_collection.py`, `log_viewer.py`):
the listing is light (no file read). The viewer's date-range read reads
every selected file twice (range, then load) (P3: cache the range per
file size+mtime). P2 a severity breakdown per unit in the Findings strip
(errors per unit in the window), P2 link a unit's errors to Services.

**Sos Report / Blame** (`sos_report.py`, `blame.py`): sound (sos 4.0-4.8
manifests). P3 a note when the run hit a timeout.

### must-gather

**Cluster** (`system.py`, `mustgather_system.html`)
- Correctness: `networks.yaml` read as a list `items[0]` (an empty list
  raises, P3); the install-method heuristic (VIP in `cluster-config-v1`
  or metal3 pods = IPI) is a guess (P3: say "likely IPI").
- Usefulness: P1 Findings: degraded / progressing / unavailable cluster
  operators first (with their message and since when), the cluster
  version vs desired, an update in progress, a proxy configured; P2 link
  an operator to its namespace's pods and events.

**Events** (`events.py`): the raw EventList per namespace goes to the
page, which sorts in JS. P1 sort by last timestamp descending and show
Warning events first; P1 Findings: the top warning reasons (FailedScheduling,
BackOff, Unhealthy, FailedMount, OOMKilling) with counts; P2 cross-link an
event to its pod. Performance: `events.yaml` of a large cluster is tens of
MB per namespace; PyYAML's pure-Python loader takes ~1 s per 10 MB (P2:
`yaml.CSafeLoader` when available, and read only the fields the page
needs).

**Firing Alerts** (`alerts.py`): sound. P1 severity ordering (critical,
warning, info) and firing first; P2 link to the namespace / pod the
alert's labels name; P3 the runbook link as a button.

**Nodes** (`nodes.py`): the raw node YAML. P1 Findings: NotReady nodes,
pressure conditions (Memory/Disk/PID), unschedulable (cordoned) nodes,
nodes whose kubelet version differs; P2 capacity vs allocatable, taints.

**Machine Config Pools** (`mcp.py`): sound. P1 degraded / updating pools
first with their counts (present in the data).

**Pod / Deployment / ReplicaSet / DaemonSet / StatefulSet / PDB**: the
same template per kind, raw YAML per namespace, age from the collection
`timestamp` (the time-zone arithmetic is right). P1 Findings on the
Workloads group page: pods not Running/Completed, CrashLoopBackOff,
OOMKilled containers (`lastState.terminated.reason`), restarts over 5,
Pending for long, DaemonSets with unavailable pods, Deployments below
their replicas, PDBs with `disruptionsAllowed: 0`; P1 sort worst first;
P2 cross-link a pod to its events and (when present) its container logs
in `namespaces/*/pods/*/*/logs`. Performance: each tab re-reads the
whole namespaces tree (`pod.py` loads every pod YAML, thousands of files)
on every open and the five workload tabs load the same files again (P2:
one cached index per report, built once; `CSafeLoader`).

**Security & Certificates** (`security.py`, `csr.py`, `tls_secrets.py`):
sound; the 60-day "expiring soon" threshold is fixed (P3: show 30/60/90).

**Audit**: the explorer reviewed and reworked over the last rounds.

**Log Collection** (`log_collection.py`): sound.

## Phase 2 status

- Group 1 (sosreport System: System Information, Processes, Services,
  Scheduler Debug, PCI Devices, C-States): done on
  `feature/diagnostics-findings-system` - the shared Findings strip
  (`parsers/findings.py`, the `findings()` macro, `.ui-findings`), the
  cross-links with a search term (`diagLinks`, `data-ui-search`), and the
  P1/P2/P3 items of the six pages (problems first, worst-first sorting, the
  legends out of the way, the driver column, the verdict line). Left for a
  later group: the Services details table folded into the main table (P3),
  the Scheduler Debug all-tasks table rendered on demand (P2 performance),
  the per-process cross-link to the OOM / hung-task reports by PID.
- Group 2 (Disk Usage, LVM, Control Groups CPU / Memory, Network Interface
  Statistics, SAR CPU / Memory / Network / Disk): done on
  `feature/diagnostics-findings-storage-network` - the Findings strip on
  the nine pages; Disk Usage reads `df -ali` too, shows human sizes, the
  inode column, the rows over 90% / 95% tinted, the pseudo filesystems
  after the real ones; LVM flags a partial VG / missing PV, an inactive LV,
  a thin pool near full; the Control Groups tabs read cgroup v2
  (memory.current / memory.max, cpu.max, cpu.stat) and flag cgroups at
  their memory limit and throttled quotas; Network reads the addresses,
  the bonds (proc/net/bonding) and ethtool -i, flags errors / drops, a
  slave down, a DOWN interface with an address, MTU mismatches; the SAR
  tabs flag I/O wait, steal, saturation, memory pressure, slow disks,
  saturated interfaces and EDEV drops per day. Left: the SAR interval
  derived from the data (the 10-minute bucket stays), the metric toggles
  as a legend (P3), proc/net/dev as a fallback (P3).
- Groups 3-5 follow in this order: OpenStack, Kernel / Log Collection /
  Blame, must-gather.

## Noise to remove (proposed)

- The Processes STAT legend table (into a tooltip), the Services details
  table (into expandable rows), the raw `hostnamectl` key/value dump, the
  per-kind YAML viewers that repeat the table (keep one "raw" expander).

## Performance summary

Every sosreport parser runs under 0.1 s on the large mock; the kernel
scan is the only one that streams a large file and it is capped and
cached. On a real must-gather the cost is in YAML: the workload tabs
re-read every pod file per tab (P2 above); the Audit scan is cached by
the files' sizes and mtimes already.

## Deferred: needs the user

- Flow Visualization: what should it show (OVS flows, nftables, conntrack
  top talkers), or should the tab go?
- The must-gather `event-filter.html` that `oc adm must-gather` ships:
  link to it, embed it, or ignore it?
- Thresholds for the Findings strips (load per core, memory used %,
  iowait %, restarts): defaults proposed above; the user may want them
  configurable in Settings.
- The install-method and cgroup-version wording ("likely") and whether
  the C-States and PCI tabs are worth keeping in the System group.

## Phase 2 status, groups 3-5

- Group 3 (OpenStack: Pacemaker, HAProxy, DPDK) on
  `feature/diagnostics-findings-openstack`: the Findings strip on the three
  pages; Pacemaker reads pcs 0.9 (RHEL 7) and 0.10+ status forms and the
  standby / maintenance / unclean nodes, flags nodes down, resources stopped
  or failed, failed actions, quorum lost, fencing disabled or used; HAProxy
  reads a plain host's config and log too and the termination state past
  the captured cookies (it never matched before), flags backends without a
  server, servers down, the 5xx share, abnormal terminations; DPDK flags
  busy PMDs and hot receive queues. Left: the VM-NUMA vs physnet check
  (deferred: needs the instance XML's numatune and the physnet map), the
  HAProxy time series budget on huge logs (P3).
- Group 4 (Kernel, Log Collection, Blame) on
  `feature/diagnostics-findings-kernel-logs`: the Kernel group page (it was
  empty) with the Findings over the three tabs and a card per tab; Log
  Collection's and Blame's strips; the D-state finding hands the task's
  name to the hung-task search. Left: per-PID links into the OOM / hung
  reports from Processes (P3), the Log Collection severity breakdown per
  unit (needs a log read on the group page: deferred).
- Group 5 (must-gather) on `feature/diagnostics-findings-mustgather`: the
  Findings strip on every must-gather page; Cluster flags degraded /
  unavailable / progressing operators (linked to their pods) and overrides;
  Events sort Warning first and newest first and name the top warning
  reasons; Alerts sort firing / critical first; Nodes flag NotReady,
  pressure, cordoned and version skew; MachineConfigPools degraded /
  updating / paused; Pods crash-looping, OOMKilled, Pending, restarting;
  Deployments, DaemonSets, StatefulSets, ReplicaSets and PDBs below their
  wanted state; CSRs pending (sorted first); TLS secrets expired / expiring
  (sorted by expiry); every YAML goes through one shared loader (libyaml's
  CSafeLoader when present). Left: one cached index per report shared by
  the workload tabs (each still reads its own files; P2 performance), the
  shipped event-filter.html (deferred: needs the user), the 30/60/90-day
  choice for TLS (deferred).

