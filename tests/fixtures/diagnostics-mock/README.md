# Mock sosreport and must-gather for the Diagnostics page

Fully SYNTHETIC reports for trying every Diagnostics panel by hand. Nothing in
them comes from a real system: host `web-01.example.test`, cluster
`demo.example.test`, namespaces `demo-app` / `payments-demo`, RFC 5737 and
RFC 1918 documentation addresses (192.0.2.x, 198.51.100.x, 203.0.113.x,
10.0.0.x), `example-*` services and `quay.io/example-org/*` images, invented
IDs. Only the file *layout* is real: the sos project's for the sosreport and
openshift/must-gather's for the must-gather, because that is what
`backend/parsers/sosreport/*` and `backend/parsers/mustgather/*` read.

Nothing generated is committed. `generate.py` writes to `out/` (git-ignored);
rerun it any time.

## Generate

```sh
python3 tests/fixtures/diagnostics-mock/generate.py             # ~2 s, standard library only
python3 tests/fixtures/diagnostics-mock/generate.py --large     # + a 50k-line-journal sosreport
python3 tests/fixtures/diagnostics-mock/generate.py --copy-to ~/Downloads   # also copy the trees where the page looks by default
```

Output in `tests/fixtures/diagnostics-mock/out/`:

| Path | What it is |
| --- | --- |
| `sosreport-web-01-2026-10-13-abcdef/` | extracted sosreport (569 files) - this is what the app opens |
| `sosreport-web-01-2026-10-13-abcdef.tar.xz` | the same tree archived like `sos report` does (140 KiB) |
| `sosreport-ip-192-0-2-46-master-cluster-example-master-2026-10-01-abcdefg/` | manifest-only sosreport: an OpenShift master-like `sos report` run (59 plugins, `ebpf` failing 383 commands, `networking` with 1,875) for Sos Report > Blame |
| `sosreport-old-01-2026-10-01-oldfmt/` | manifest-only sosreport from an older sos (no per-plugin timings): the Blame tab's empty state |
| `must-gather.local.1234567890/` | extracted must-gather (143 files, incl. host_service_logs/, network_logs/ and the API audit logs under audit_logs/ for the Audit and Log Collection tabs) |
| `must-gather.local.1234567890.tar.gz` | the same tree archived (51 KiB) |
| `sosreport-web-02-2026-10-13-bigjrnl[.tar.xz]` | `--large` only: same host story, ~50 000 journal lines (587 KiB archive) for Log Viewer performance |

Deterministic: fixed seed, fixed timestamps, fixed archive metadata, so a
rerun produces byte-identical files.

## Load them in the Diagnostics page

The page does not upload or extract archives. It browses a folder for
sub-directories whose names contain `sosreport`, `must-gather` or start with
`inspect`, and opens one. So point it at the extracted directories:

**Desktop app (Electron) and the browser build (`npm run dev` / dev server)**

1. Generate (above). Either run with `--copy-to ~/Downloads` or remember the
   `out/` path printed by the generator.
2. Open **Diagnostics** in the sidebar. The empty state scans `Downloads` and
   lists what it finds. If you used `--copy-to ~/Downloads`, both mocks are
   already in the list.
3. Otherwise click **Browse different location**, paste the absolute path of
   the output folder (`<repo>/tests/fixtures/diagnostics-mock/out`, `~` is
   accepted) and confirm. The list now shows
   `sosreport-web-01-2026-10-13-abcdef` (badge `sosreport`) and
   `must-gather.local.1234567890` (badge `mustgather`).
4. Click a report card. The first tab (System / Cluster) loads; the inner
   sidebar lists the other panels (click a header to expand its sub-tabs).
   The **Load different report** link under the report name in that sidebar
   goes back to the list to open the other mock.

**Container / home server** (`JACARIUM_REPORTS_ROOT`, `/data/reports`): copy
the two directories (or extract the archives) into the mounted reports volume
on the host, then in Diagnostics browse to `/data/reports` (with accounts, the
account's own `~/reports` is also browsable). Archives must be extracted there:
`tar -xJf sosreport-web-01-2026-10-13-abcdef.tar.xz` and
`tar -xzf must-gather.local.1234567890.tar.gz`.

## Verify against the real parsers (no app needed)

```sh
backend/venv/bin/python tests/fixtures/diagnostics-mock/verify.py           # 135 checks
backend/venv/bin/python tests/fixtures/diagnostics-mock/verify.py --large   # + walks the large sosreport, times the journal stream
```

`verify.py` wraps `backend/log_viewer.py` (the blueprint the page calls) in a
Flask test client, lists the folder with `/list_reports`, then for every
tab/sub-tab calls `/get_tab_data` and `/load_tab` (the real Jinja templates)
and asserts each planted finding below is in the parsed data. It also streams
the journal through `/parse_log_viewer_stream` the way the Log Viewer does.
It is deliberately not a `*.test.*` file (it needs `out/`), so `run-all.sh`
does not pick it up. Two tabs fail because of the parsers, not the mocks; they
are listed as `known` (see the end of this file).

## What is in the sosreport (`web-01`, RHEL 9.4, 8 CPUs, 32 GB, VM)

Collected Mon 2026-10-12 14:30 UTC; the journal runs Fri 2026-10-09 00:00 to
2026-10-12 14:29 (about 3 100 lines). Files: `uptime`, `hostname`, `uname`,
`df`, `installed-rpms` (46 packages with versions), `etc/{os-release,
redhat-release, hostname, fstab, hosts, resolv.conf, chrony.conf,
selinux/config, sysconfig/sysstat}`, `proc/{meminfo, cmdline, mounts, version,
sys/kernel/tainted, <pid>/cgroup}`, `sys/fs/cgroup/{cpu,cpuacct,memory,cpuset}`
(v1), `sys/kernel/debug/sched/debug`, `sys/devices/system/cpu/cpuN/{cpuidle,
cpufreq}`, `sos_commands/{host,processor,memory,process,selinux,systemd,
kernel,hardware,lvm2,filesys,block,networking,firewalld,chrony,dnf,rpm,date,
logs}/...`, `var/log/sa/sar{10,11,12}`, `var/log/{audit/audit.log, dnf.log,
rhsm/rhsm.log, example-app/app.log, messages, secure, httpd/error_log}`,
`sos_reports/manifest.json`.

### Planted findings - checklist

| Panel | What to look for |
| --- | --- |
| System | load average **18.42 / 15.07 / 9.88** on 8 CPUs; 32 000 MB total, only ~2.4 GB available, swap nearly full; kernel 5.14.0-427.13.1.el9_4, VM (kvm) on "Example Systems ExampleServer X1" |
| System > Processes | `example-worker` pid **4311** at **88.6 % CPU / 61.2 % MEM**, state `Dl`, 20 GB RSS, with 6 threads (ps -m rows); pid 4312 at 42 %; `ps auxZww` tab with SELinux labels (`httpd_t`, `init_t`, `unconfined_t`) |
| System > PCI Devices | 11 virtio/example devices grouped by class and vendor `1ab8` |
| System > System Information (dmidecode) | PSU2 `Status: Present, Non-Critical`, `Plugged: No` (WARN); chassis "Power Supply State: Warning"; 2 of 4 DIMM slots populated (2x16 GB DDR4); boot status OK |
| System > Scheduler Debug | 8 CPUs; `example-worker` is the running task (`>R`) on **cpu#3** and **cpu#5** with wait time 0.5-9 s (high-wait list), `nr_uninterruptible 1` on cpu#3 |
| System > Services | **`example-backup.service` failed** (exit-code 28, "no space left on device", journal excerpt in the unit block); **`example-worker.service` Tasks 4600 (limit: 5000)** = 92 % (red task bar); `example-metrics.service` inactive; 25 units total; a stripped "Unit example-legacy.service could not be found." line |
| System > C States | driver `intel_idle`, governor `menu`, states POLL/C1/C1E/C6; cpu3 and cpu5 at 2.4 GHz max (busy), the others clocked down |
| OpenStack, HAProxy, Pacemaker | not an OpenStack node: render "N/A" / empty cleanly; DPDK shows "DPDK data not available in this report" |
| Disk > Logical Volume Management | VGs `rhel` and `data`; **thin pool `data/pool00` Data% 91.50** (red), `uploads` thin LV 73.2 % (yellow) |
| Disk > Disk Usage | **`/var` 94 %** (red bar), `/` 73 % (yellow), NFS `198.51.100.40:/exports/backup` on `/mnt/backup` **100 %** (the reason the backup failed), `/boot` 31 % |
| Control Groups > CPU Accounting | cgroup v1; `system.slice/example-worker.service` has a **CFS quota 600000/100000 (6 cores)**, 3 processes; httpd/php-fpm unlimited |
| Control Groups > Memory Accounting | **`example-worker.service` at ~97 % of its 24 GiB limit** (25.0 GB used); free -m summary |
| Network > Interface Statistics | `eth1` (MTU 9000, storage net) **48 213 RX errors / 1 203 456 RX dropped**; `eth2` state **DOWN**; `eth0` 12 dropped |
| System Activity Report > CPU / Memory / Network / Disk | 3 days (sar10, sar11, sar12, 10-min samples). On 10/12 **09:00-11:00: ~90 % busy** with iowait 6-10 %, memory climbs above 90 % used, `vdb`/`dm-4` await 45-75 ms, `eth1` ~94 % utilisation; after 11:00 stays at ~55 % |
| Kernel > Stack Traces | 1 trace, **Oct 11 09:14:02**: `WARNING: CPU: 3 PID: 4311 at drivers/example/example_fastpath.c:412 example_fastpath_poll+0x1a2/0x2f0 [example_fastpath]`, kernel **Tainted: G OE** (out-of-tree, unsigned module `example_fastpath`; `proc/sys/kernel/tainted` = 12288), Code: line, 7-frame call trace |
| Kernel > Hung Tasks | 2 entries: `example-worker:4311` blocked **122 s** (Oct 12 09:31:55, state D, pid 4311 ppid 4200, NFS write call trace) and **245 s** (09:34:00) |
| Kernel > OOM Killer | 2 OOM kills of `example-worker`: **Oct 10 03:12:41** (pid 4298, 29 GB anon-rss) and **Oct 11 22:45:09** (pid 4311, 30.5 GB), full Mem-Info / task table, "Out of memory: Killed process" |
| Sos Report | `sos_reports/manifest.json` (sos 4.7): `sos report --batch --case-id=EXAMPLE-0001 --all-logs --plugin-timeout=300`, ran **Oct 12 14:28:10 -> 14:31:10** (3 min), 24 plugins, 689 commands |
| Sos Report > Blame | slowest `example_app` **60 s, timed out** (its `example-ctl dump --all` never returned), `logs` 42.5 s (`journalctl --no-pager` 38 s), `chrony` 31.6 s (three `chronyc -n` commands at 10.5 s each, rc 1); 13 failed commands, 5 `rc 127` (bpftool, devlink, chkconfig); `login` and `crypto` ran no command; plugin start/end times give the timeline |
| Log Collection > Log Viewer | 7 files: `journalctl (system)` (auto-selected, Oct 9-12), `journalctl (boot)`, `audit/audit.log`, `dnf.log`, `rhsm/rhsm.log`, `example-app/app.log`, `dnf.rpm.log`. Severities to filter: critical (example-cgi "critical: ... deprecated"), error, warning, info, debug (`level=debug` lines from example-worker), other. Issue detectors: **oom_killer** (4), **segfault** (`example-cgi[5123]: segfault at 0`, Oct 12 11:02:17), **disk_error** (`blk_update_request: I/O error, dev vdb`, XFS metadata I/O error), **network_error** (connection refused / timeout), **service_failed** (`Failed to start Example nightly backup.`, Oct 12 02:00:07), **authentication_failure** (`Failed password for invalid user admin from 198.51.100.23`). Processes to filter: sshd, kernel, httpd, example-worker, chronyd, setroubleshoot, NetworkManager, php-fpm, sssd_be, rsyslogd. Search ideas: `SELinux is preventing` (setroubleshoot, multi-line), `Can't synchronise` / `System clock wrong by 2.345678 seconds` (chrony drift), `taints kernel`, `RX ring buffer overrun`, `nfs: server 198.51.100.40 not responding`, `pm.max_children`. Time filter: narrow to Oct 11 09:00-10:00 to isolate the kernel WARNING; Oct 12 02:00 for the backup failure |
| audit.log (Log Viewer) | `type=AVC ... avc: denied { write } for pid=2305 comm="httpd" name="uploads" ... httpd_t ... httpd_sys_content_t` (the SELinux denial), USER_AUTH failures for `admin` from 198.51.100.23, ANOM_ABEND sig=11 for example-cgi |
| dnf.log / rhsm.log (Log Viewer) | dnf: daily metadata refresh, an ERROR on 10/11 (`example-tools` repo connection refused), kernel/openssl upgrades; rhsm: INFO with periodic WARNING (entitlement expires in 7 days) and ERROR (timeout) |

Other files to browse (not parsed into a panel): `sos_commands/chrony/chronyc_tracking`
(**2.3 s slow, Leap status Not synchronised, Stratum 0**),
`sos_commands/selinux/ausearch_-m_avc...` (the same denial),
`sos_commands/systemd/systemctl_list-units_--failed`, `sos_commands/kernel/dmesg`
and `dmesg_-T` (all kernel lines), `sos_commands/kernel/modinfo_example_fastpath`,
`installed-rpms`.

## Audit logs (`audit_logs/`, `mock_audit_logs.py`)

The API servers' audit logs in the real layout (`<apiserver>/<node>-audit.log.gz`, a rotated `-audit-<stamp>.log.gz` per master, `-termination.log.gz`, the `.audit_logs_listing` files, a plain `monitoring/<pod>/audit.log`) and the audit.k8s.io/v1 Event schema: 3,048 requests over two hours from three masters, service accounts, nodes and the oauth users `alice`, `bob-admin`, `svc-deployer`; planted: a **spike** of 400 denied (`403`) secret lists from `example-scanner/0.1 (burst)` in one minute, 20 **throttled** (`429`) Prometheus lists, alice denied on `openshift-config` secrets then reading `demo-app/db-credentials` three times, bob-admin **impersonating** the demo-app service account, svc-deployer denied early on an old registry secret (on master-2, outside the scan's first-100 sample: only the Events search finds it), **sensitive deletes** (a namespace, secrets, a configmap, a clusterrolebinding, a CRD) and **RBAC changes**, the **slowest** requests (8.5 s, 6.2 s, 3.2 s ...), long-running watches, deprecated endpoints calls, and 12 **malformed** lines. The cluster `APIServer` config (`cluster-scoped-resources/config.openshift.io/apiservers/cluster.yaml`) sets the audit profile **Default** with a custom rule (`system:authenticated:oauth` → WriteRequestBodies); master-2 records write bodies ("Mixed"): a deployment's image bump, JSON-patch scale 3→5 and scale/ subresource 5→2, resources and env changes, labels, a RoleBinding granted (alice, then bob-admin) and revoked with deleteOptions, a ClusterRole rule added, a ConfigMap key edit (one credential-like key masked), a Secret key rotation with run-time placeholder values (never shown), a node cordon + taint, CRD / webhook / SCC updates — the Audit > Changes page. `mock_audit_logs.generate(profile=...)` also builds the WriteRequestBodies / AllRequestBodies variants the tests use.

## What is in the must-gather (`demo` cluster, OpenShift 4.16.12)

Collected 2026-10-12 14:40:12 UTC (top-level and image-dir `timestamp`;
`version` lists the degraded operators; `event-filter.html` stub). Image dir
`quay-io-openshift-release-dev-ocp-v4-0-art-dev-sha256-<hex>/` holds
`cluster-scoped-resources/{config.openshift.io/{clusterversions,
infrastructures, clusteroperators (19), networks.yaml, proxies, dnses},
core/nodes (5), machineconfiguration.openshift.io/machineconfigpools (2),
certificates.k8s.io/certificatesigningrequests (6)}`, `namespaces/{demo-app,
payments-demo, openshift-monitoring, openshift-etcd, kube-system, default}/`
with `core/events.yaml`, `apps/{deployments,replicasets,daemonsets,statefulsets}.yaml`,
`policy/poddisruptionbudgets.yaml`, `core/secrets.yaml`,
`pods/<pod>/<pod>.yaml` and `pods/<pod>/<container>/<container>/logs/{current,previous}.log`
(19 pods), `monitoring/prometheus/rules.json` and `monitoring/alertmanager/alerts.json`,
and an etcd section: `etcd_info/{member_list,endpoint_health,endpoint_status}.json`,
`etcd_info/etcd_version` plus the three `openshift-etcd/pods/etcd-master-N` pods
with etcd container logs ("apply request took too long" warnings).

### Planted findings - checklist

| Panel | What to look for |
| --- | --- |
| Cluster | version **4.16.12**, channel stable-4.16, Kubernetes v1.29.8+f10c92d, OVNKubernetes, platform BareMetal, install method UPI, proxy `http://proxy.example.test:3128` configured; 19 operators: **`monitoring` Degraded=True** (reason UpdatingPrometheusK8sFailed), **`machine-config` Progressing=True**, Upgradeable=False on both; collection timestamps 14:40:12 - 14:42:53 |
| Cluster > Events | 22 events, 10 Warning: `BackOff` x42 (payments-worker), `Unhealthy` (liveness 503 on payments-api; readiness timeout on demo-cache), `NodeNotReady` (pods on worker-1; node events in `default`), **`SystemOOM`** on worker-0 ("victim process: api"), `FailedUpdate` (prometheus-k8s), `SlowRequest` (etcd-master-1), `TaintManagerEviction`; filters by namespace and reason |
| Cluster > Firing Alerts | **11 firing** of 14 rules: `KubeletDown` (**critical**), `KubePodCrashLooping`, `KubePodNotReady` (2 alerts), `KubeContainerWaiting`, `KubeNodeNotReady`, `KubeNodeUnreachable`, `ClusterOperatorDegraded`, `ClusterNotUpgradeable` (info), `etcdHighFsyncDurations`, `TargetDown`, `Watchdog`; inactive: `KubeDeploymentReplicasMismatch`, `KubeVersionMismatch`, `etcdMembersDown`; runbook links; ages relative to the collection time |
| Compute > Nodes | 5 nodes: master-0..2 (8 CPU / 32 GiB, 10.0.0.11-13), worker-0 and **worker-1** (16 CPU / 64 GiB, 10.0.0.21-22). **worker-1 Ready = Unknown** ("Kubelet stopped posting node status", since 11:28 UTC) with `node.kubernetes.io/unreachable` NoSchedule/NoExecute taints and MCO annotation "failed to drain node"; all RHCOS 416.94, cri-o 1.29.8 |
| Compute > Machine Config Pools | `master` Updated (3/3); **`worker` Degraded=True, Updating, 1 ready / 1 degraded / 1 unavailable of 2**, NodeDegraded message naming worker-1 |
| Workloads > Pod | 19 pods. **`payments-demo/payments-worker-7b8c9d0e1-efghi` CrashLoopBackOff, 42 restarts**, 0/1 ready, lastState Error exit 1; its `previous.log` holds the Python traceback (`ConfigError: DATABASE_URL is empty: secret postgres-demo-credentials has no key 'url'`), `current.log` empty. **`payments-api-5f6d7c8b9-zabcd` lastState OOMKilled (exit 137), 7 restarts**, memory limit 256Mi; its `previous.log` ends with `fatal error: out of memory`. **`demo-app/demo-web-7d9f8b6c5-klmno` on worker-1: Running but Not Ready** (0/1). `prometheus-k8s-1` and `node-exporter-eeeee` on worker-1 not ready. Healthy: demo-web x2, demo-cache, payments-api-...-uvwxy, postgres-demo-0, etcd-master-0..2 (4 containers each), alertmanager-main-0 |
| Workloads > Deployment | **`payments-worker` 0/1 available, Progressing=False (ProgressDeadlineExceeded)**; `payments-api` 2/2 (but one container OOM-restarting); **`demo-web` 2/3 available**; demo-cache, cluster-monitoring-operator, prometheus-operator 1/1 |
| Workloads > Replica Set | demo-web-7d9f8b6c5 (3 desired / 2 ready), demo-cache-6c8d7f9b4, payments-api-5f6d7c8b9, **payments-worker-7b8c9d0e1 (1 / 0 ready)** |
| Workloads > Daemon Set | **`openshift-monitoring/node-exporter` desired 5, ready 4, unavailable 1** |
| Workloads > Stateful Set | **`prometheus-k8s` 1/2 ready**; `alertmanager-main` 1/1; `payments-demo/postgres-demo` 1/1 |
| Workloads > Pod Disruption Budget | **`payments-api-pdb` disruptionsAllowed 0** (minAvailable 2 of 2); `prometheus-k8s` and `alertmanager-main` 0 allowed; `demo-web-pdb` allows 1 |
| Security > Certificate Signing Requests | 6 CSRs (kubelet-serving): 4 Approved (NodeCSRApprove), **2 Pending for `system:node:worker-1`** (csr-f8q3w, csr-h2n7c) |
| Security > TLS Secret Expiration | 7 certificates: **`thanos-querier-tls` Expired (12 days ago)**, **Expiring Soon: `node-exporter-tls` (20 days), `payments-demo/payments-api-tls` (24 days), `kube-state-metrics-tls` (58 days)**; Valid: prometheus-k8s-tls, alertmanager-main-tls (700 days), metrics-client-certs (330 days). Days are relative to the collection time, not today |

Root-cause thread for a guided tour: worker-1's kubelet stopped (NotReady,
taints, 2 pending CSRs, worker MCP degraded, node-exporter 4/5, prometheus-k8s
1/2, monitoring operator degraded, KubeletDown/TargetDown alerts, pods on it
not ready); independently payments-worker crash-loops on a missing secret key
and payments-api is OOM-killed at its 256Mi limit (SystemOOM event on worker-0).

## Parser issues found while verifying (fixed, guarded by tests/diagnostics-parsers.test.py)

1. must-gather "Security & Certificates" header 500ed (no `parsers.mustgather.security`
   module or `mustgather_security.html`); it now renders an overview of both sub-tabs
   (certificate counts by status, expiring certificates, pending CSRs, links).
2. sosreport "OpenStack > DPDK" 500ed on any non-OpenStack host (`parse_pmd_stats()`
   opened the pmd-stats-show capture unguarded); the tab now says the data is not
   available in this report.
3. dmidecode tested `Status.*Critical` before `Non-Critical`, so a PSU reporting
   `Status: Present, Non-Critical` showed ERROR instead of WARN.
4. kernel_hung_task required `pid:4311 ppid:4200`; RHEL 8/9 kernels print
   `pid: 4311 ppid:  4200`. The journal mock now carries the real format plus one
   legacy line.
5. cstates built `state_names` in `os.listdir` order; now numeric state order.
6. mustgather pod referenced `pod_name` before assignment in its `except` branch,
   so an unreadable pod YAML raised NameError instead of reporting the file.
