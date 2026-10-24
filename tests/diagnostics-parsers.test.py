#!/usr/bin/env python3
"""
Diagnostics parser regressions, checked against the mock sosreport/must-gather
(tests/fixtures/diagnostics-mock, generated into a scratch directory) through the
real Flask blueprint (backend/log_viewer.py), plus synthetic inputs for the edge
cases the mocks do not cover.

1. must-gather "Security & Certificates": clicking the parent header loads
   parsers.mustgather.security + templates/tabs/mustgather_security.html (used to
   500: neither existed). The overview aggregates the two sub-tabs.
2. sosreport "OpenStack > DPDK" answers 200 on a host without Open vSwitch
   (parse_pmd_stats opened the pmd-stats-show capture unguarded).
3. dmidecode: "Status: Present, Non-Critical" is WARN, not ERROR (the Critical
   rule was tested first and matched inside "Non-Critical").
4. kernel_hung_task: pid/ppid parsed from both the padded RHEL 8/9 line
   ("pid: 4311 ppid:  4200") and the tight legacy line ("pid:4311 ppid:4200").
5. cstates: state names in numeric stateN order, not os.listdir order.
6. mustgather pod: an unreadable pod YAML yields {"error": ...} naming the file
   (the except block used `pod_name` before assignment -> NameError).
7. LoadReportModal is gone from the Diagnostics page (folder browser only).

Needs the backend venv (Flask, PyYAML); run-all.sh picks it automatically.
"""
import os
import shutil
import sys
import tempfile
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
MOCK = os.path.join(HERE, "fixtures", "diagnostics-mock")
sys.path.insert(0, BACKEND)
sys.path.insert(0, MOCK)

from flask import Flask  # noqa: E402

import log_viewer as lv  # noqa: E402
import generate as mock_generate  # noqa: E402
from parsers.sosreport import cstates, dmidecode, kernel_hung_task  # noqa: E402
from parsers.mustgather import pod as mg_pod  # noqa: E402

WORKDIR = tempfile.mkdtemp(prefix="diag-parsers-")
results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok)))
    print(("  ok    " if ok else "  FAIL  ") + label + (f": {detail}" if detail and not ok else ""))


def make_client():
    app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
    app.register_blueprint(lv.log_viewer)
    app.secret_key = "diagnostics-parsers-test"
    return app.test_client()


def tab(client, report_type, directory, tab_name, sub_tab=None):
    payload = {"report_type": report_type, "directory": directory, "tab": tab_name, "sub_tab": sub_tab}
    data = client.post("/get_tab_data", json=payload)
    html = client.post("/load_tab", json=payload)
    return data, html


def main():
    out = os.path.join(WORKDIR, "out")
    mock_generate.main(["--out", out, "--no-archives"])
    sos = os.path.join(out, mock_generate.SOS_NAME)
    mg = os.path.join(out, mock_generate.MG_NAME)
    client = make_client()

    # 1. Security & Certificates parent tab
    data, html = tab(client, "mustgather", mg, "security")
    check("Security parent tab: /get_tab_data and /load_tab answer 200",
          data.status_code == 200 and html.status_code == 200,
          f"{data.status_code}/{html.status_code} {(data.get_json() or {}).get('error')} {(html.get_json() or {}).get('error')}")
    sec = (data.get_json() or {}).get("data") or {}
    tls_counts = sec.get("tls", {}).get("counts", {})
    csr_counts = sec.get("csr", {}).get("counts", {})
    check("Security overview: TLS counts 1 Expired / 3 Expiring Soon / 3 Valid (planted in the mock)",
          (tls_counts.get("Expired"), tls_counts.get("Expiring Soon"), tls_counts.get("Valid")) == (1, 3, 3), str(tls_counts))
    check("Security overview: CSR counts 2 Pending of 6", csr_counts.get("Pending") == 2 and sec.get("csr", {}).get("total") == 6, str(csr_counts))
    check("Security overview: attention list starts with the expired secret, pending CSRs listed",
          [s["name"] for s in sec.get("tls", {}).get("attention", [])][:1] == ["thanos-querier-tls"]
          and len(sec.get("csr", {}).get("pending", [])) == 2 and sec.get("needs_attention") == 6,
          str(sec.get("tls", {}).get("attention"))[:200])
    fragment = (html.get_json() or {}).get("html", "")
    check("Security overview renders counts and links to both sub-tabs",
          "thanos-querier-tls" in fragment
          and "diagnosticsOpenTab('security', 'tls_secrets')" in fragment
          and "diagnosticsOpenTab('security', 'csr')" in fragment)
    # The sub-tabs still work on their own
    for st in ("csr", "tls_secrets"):
        d, h = tab(client, "mustgather", mg, "security", st)
        check(f"Security sub-tab {st} still answers 200", d.status_code == 200 and h.status_code == 200)

    # 2. DPDK on a non-OpenStack host
    data, html = tab(client, "sosreport", sos, "openstack", "openstack_dpdk")
    check("DPDK sub-tab answers 200 on a host without Open vSwitch",
          data.status_code == 200 and html.status_code == 200,
          f"{data.status_code}/{html.status_code} {(data.get_json() or {}).get('error')}")
    dpdk = (data.get_json() or {}).get("data") or {}
    check("DPDK: no PMD threads reported (pmd_stats empty, not an exception)", dpdk.get("pmd_stats") == [], str(dpdk.get("pmd_stats"))[:100])
    check("DPDK fragment says in its Findings that the captures are missing (no empty-state block)",
          "No Open vSwitch / DPDK captures in this report" in (html.get_json() or {}).get("html", "") and "No Data Available" not in (html.get_json() or {}).get("html", ""))

    # 3. dmidecode PSU status order
    dmi_path = os.path.join(sos, "sos_commands", "hardware", "dmidecode")
    if not os.path.isfile(dmi_path):
        dmi_path = os.path.join(sos, "dmidecode")
    entries = dmidecode.parse_dmidecode(dmi_path)
    psu = [e for e in entries if e["type_lc"] == "system power supply"]
    check("dmidecode: PSU 'Present, Non-Critical' -> WARN, PSU 'Present, OK' -> OK",
          [e["status"] for e in psu] == ["OK", "WARN"], str([(e.get("status"), e["details"][-6:]) for e in psu]))
    synthetic = os.path.join(WORKDIR, "dmidecode-critical")
    with open(synthetic, "w") as f:
        f.write("# dmidecode 3.3\nHandle 0x0050, DMI type 39, 22 bytes\nSystem Power Supply\n\tLocation: PSU1\n\tStatus: Present, Critical\n\n"
                "Handle 0x0051, DMI type 39, 22 bytes\nSystem Power Supply\n\tLocation: PSU2\n\tStatus: Present, Non-Recoverable\n\n"
                "Handle 0x0052, DMI type 39, 22 bytes\nSystem Power Supply\n\tLocation: PSU3\n\tStatus: Present, Non-Critical\n\n")
    statuses = [e["status"] for e in dmidecode.parse_dmidecode(synthetic) if e["type_lc"] == "system power supply"]
    check("dmidecode: Critical -> ERROR, Non-Recoverable -> ERROR, Non-Critical -> WARN", statuses == ["ERROR", "ERROR", "WARN"], str(statuses))

    # 4. hung task line formats
    # (the parsers treat a single-entry directory as the extracted archive's
    # wrapper, so every synthetic report gets a second top-level file)
    hung_dir = os.path.join(WORKDIR, "hung")
    os.makedirs(os.path.join(hung_dir, "sos_commands", "logs"), exist_ok=True)
    open(os.path.join(hung_dir, "uptime"), "w").close()
    k = "Oct 12 09:31:55 web-01 kernel: "
    lines = [
        k + "INFO: task example-worker:4311 blocked for more than 122 seconds.",
        k + "      Tainted: G           OE     -------  ---  5.14.0-427.13.1.el9_4.x86_64 #1",
        k + "\"echo 0 > /proc/sys/kernel/hung_task_timeout_secs\" disables this message.",
        k + "task:example-worker  state:D stack:0 pid: 4311 ppid:  4200 flags:0x00004080",
        k + "Call Trace:", k + " <TASK>", k + " __schedule+0x2d1/0x870", k + " schedule+0x55/0xf0", k + " </TASK>",
        "Oct 12 09:34:00 web-01 kernel: INFO: task legacy-worker:4312 blocked for more than 245 seconds.",
        "Oct 12 09:34:00 web-01 kernel:       Tainted: G           OE     -------  ---  4.18.0-553.el8_10.x86_64 #1",
        "Oct 12 09:34:00 web-01 kernel: task:legacy-worker  state:D stack:0 pid:4312 ppid:4201 flags:0x00004080",
        "Oct 12 09:34:00 web-01 kernel: Call Trace:", "Oct 12 09:34:00 web-01 kernel:  __schedule+0x2d1/0x870",
    ]
    with open(os.path.join(hung_dir, "sos_commands", "logs", "journalctl_--no-pager"), "w") as f:
        f.write("\n".join(lines) + "\n")
    hung = kernel_hung_task.parse(hung_dir).get("hung_tasks", [])
    got = [(h["details"]["task"], h["details"]["pid"], h["details"]["ppid"], h["details"]["state"], h["details"]["flags"]) for h in hung]
    check("hung task: padded RHEL 8/9 line parsed (task, pid, ppid, state, flags)",
          len(got) >= 1 and got[0] == ("example-worker", "4311", "4200", "D", "0x00004080"), str(got))
    check("hung task: tight legacy line parsed too",
          len(got) == 2 and got[1] == ("legacy-worker", "4312", "4201", "D", "0x00004080"), str(got))
    mock_hung = [h for h in kernel_hung_task.parse(sos).get("hung_tasks", []) if h["details"]["pid"] == "4311"]
    check("hung task: the mock sosreport (real + legacy line) gives pid/ppid for both example-worker:4311 events",
          len(mock_hung) == 2 and all(h["details"]["ppid"] == "4200" for h in mock_hung),
          str([(h["details"].get("pid"), h["details"].get("ppid")) for h in mock_hung]))

    # 5. C-state order: state10 must sort after state9, whatever listdir says
    cst_dir = os.path.join(WORKDIR, "cstates")
    os.makedirs(cst_dir)
    open(os.path.join(cst_dir, "uptime"), "w").close()
    names = [f"S{i}" for i in range(12)]
    for i, name in enumerate(names):
        d = os.path.join(cst_dir, "sys", "devices", "system", "cpu", "cpu0", "cpuidle", f"state{i}")
        os.makedirs(d)
        with open(os.path.join(d, "name"), "w") as f:
            f.write(name + "\n")
    with open(os.path.join(cst_dir, "sys", "devices", "system", "cpu", "cpu0", "cpuidle", "current_driver"), "w") as f:
        f.write("intel_idle\n")
    parsed = cstates.parse(cst_dir)
    check("cstates: state_names in numeric stateN order (state0..state11)", parsed["state_names"] == names, str(parsed["state_names"]))
    check("cstates: per-CPU states ordered too", [s["name"] for s in parsed["cpus"][0]["states"]] == names)
    check("cstates: mock sosreport names POLL, C1, C1E, C6 in that order", cstates.parse(sos)["state_names"] == ["POLL", "C1", "C1E", "C6"])

    # 6. unreadable pod YAML
    bad_mg = os.path.join(WORKDIR, "must-gather.bad")
    pod_dir = os.path.join(bad_mg, "quay-io-example-must-gather-sha256-0000", "namespaces", "demo-ns", "pods", "broken-pod")
    os.makedirs(pod_dir)
    with open(os.path.join(pod_dir, "broken-pod.yaml"), "w") as f:
        f.write("apiVersion: v1\nkind: Pod\nmetadata: [unterminated\n")
    good_dir = os.path.join(bad_mg, "quay-io-example-must-gather-sha256-0000", "namespaces", "demo-ns", "pods", "good-pod")
    os.makedirs(good_dir)
    with open(os.path.join(good_dir, "good-pod.yaml"), "w") as f:
        f.write("apiVersion: v1\nkind: Pod\nmetadata:\n  name: good-pod\n  namespace: demo-ns\nstatus:\n  phase: Running\n")
    try:
        pods = mg_pod.parse(bad_mg)
        ns = pods.get("demo-ns", {})
        check("pod: unreadable YAML is reported per pod with the file name, other pods still parsed",
              "error" in ns.get("broken-pod", {}) and "broken-pod.yaml" in ns["broken-pod"]["error"]
              and ns.get("good-pod", {}).get("status", {}).get("phase") == "Running",
              str(ns)[:300])
    except Exception as e:  # the old NameError path
        check("pod: unreadable YAML is reported per pod with the file name, other pods still parsed", False, f"{type(e).__name__}: {e}")

    # 7. LoadReportModal removed
    page = open(os.path.join(REPO, "src", "components", "DiagnosticsPage.jsx")).read()
    check("DiagnosticsPage: LoadReportModal and showLoadForm are gone",
          "LoadReportModal" not in page and "showLoadForm" not in page)
    check("LoadReportModal.jsx deleted", not os.path.exists(os.path.join(REPO, "src", "components", "features", "diagnostics", "LoadReportModal.jsx")))
    check("DiagnosticsPage: iframe fragments can open a known (sub-)tab via diagnosticsOpenTab",
          "window.diagnosticsOpenTab" in page and "type === 'open-tab'" in page)


exit_code = 1
try:
    main()
    passed = sum(1 for _, ok in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    exit_code = 0 if passed == len(results) else 1
except Exception:
    print("TEST DRIVER ERROR:")
    traceback.print_exc()
finally:
    shutil.rmtree(WORKDIR, ignore_errors=True)
    sys.exit(exit_code)
