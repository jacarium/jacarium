#!/usr/bin/env python3
"""The must-gather Log Collection tab (backend/parsers/mustgather/
log_collection.py + templates/tabs/mustgather_log_collection.html): what
a must-gather holds, by size.

Unit: a synthetic tree (the image-directory unwrap, top-level recursive
totals, namespaces by size, container logs named ns/pod/container
(current|previous), host service / audit / network logs, largest first in
bytes with ties by name and unknown sizes last, a symlink neither
followed nor counted, the per-section keep cap and the walk cap). Flask:
the rendered order, the hidden rows beyond the top N with "show all",
escaping of file names, the empty state. The registry: the tab is the
last must-gather tab. Run with the backend venv's Python:
backend/venv/bin/python tests/mustgather_log_collection.test.py
"""
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.join(HERE, "fixtures", "diagnostics-mock"))

from flask import Flask  # noqa: E402
import log_viewer as lv  # noqa: E402
import generate as mock_generate  # noqa: E402
from parsers.mustgather import log_collection as mg  # noqa: E402

FAILED = 0
WORKDIR = tempfile.mkdtemp(prefix="mg-log-collection-")
IMAGE = "quay-io-openshift-release-dev-ocp-v4-0-art-dev-sha256-" + "0a" * 32


def check(label, ok, detail=""):
    global FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {label}" + (f" | {str(detail)[:400]}" if not ok and detail else ""))
    if not ok:
        FAILED += 1


def tree(name, files, image=True):
    """files = {relative path under the image dir: byte size}"""
    root = os.path.join(WORKDIR, name)
    base = os.path.join(root, IMAGE) if image else root
    os.makedirs(base, exist_ok=True)
    for rel, size in files.items():
        path = os.path.join(base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"x" * size)
    return root, base


def main():
    print("--- 1. sizes, order, sections ---")
    K = 1024
    root, base = tree("mg", {
        "timestamp": 50, "version": 200, "event-filter.html": 3 * K,
        "cluster-scoped-resources/core/nodes/master-0.yaml": 8 * K, "cluster-scoped-resources/core/nodes/worker-1.yaml": 8 * K,
        "cluster-scoped-resources/config.openshift.io/clusterversions/version.yaml": 2 * K,
        "namespaces/demo-app/core/events.yaml": 40 * K,
        "namespaces/demo-app/pods/demo-web-1/web/web/logs/current.log": 9 * K,
        "namespaces/demo-app/pods/demo-web-1/web/web/logs/previous.log": 12 * 1024 * 1024,
        "namespaces/demo-app/pods/demo-web-2/web/web/logs/current.log": 9 * K,
        "namespaces/payments-demo/pods/payments-api-1/api/api/logs/current.log": 100,
        "namespaces/payments-demo/pods/payments-api-1/api/api/logs/previous.insecure.log": 100,
        "namespaces/openshift-monitoring/core/pods.yaml": 300 * K,
        "host_service_logs/masters/kubelet_service.log": 5 * 1024 * 1024, "host_service_logs/masters/crio_service.log": 700 * K, "host_service_logs/workers/kubelet_service.log": 6 * 1024 * 1024,
        "audit_logs/kube-apiserver/master-0-audit.log": 2 * 1024 * 1024, "audit_logs/openshift-apiserver/master-0-audit.log": 64 * K,
        "network_logs/iptables-save_master-0": 20 * K,
    })
    # a symlink to a huge file outside, and a symlinked directory: neither followed nor counted
    os.symlink("/dev/zero", os.path.join(base, "namespaces", "demo-app", "zero.link"))
    os.symlink(os.path.join(base, "host_service_logs"), os.path.join(base, "network_logs", "host.link"))
    lc = mg.parse(root)["log_collection"]
    sections = {s["key"]: s for s in lc["sections"]}
    check("the image directory is unwrapped and the walk counts the regular files only (19), symlinks neither followed nor counted",
          lc["image_dir"] == IMAGE and lc["total_files"] == 19 and lc["unreadable"] == 0, str((lc["image_dir"][:20], lc["total_files"], lc["unreadable"])))
    expected_total = sum([50, 200, 3 * K, 16 * K, 2 * K, 40 * K, 9 * K, 12 * 1024 * 1024, 9 * K, 200, 300 * K, 5 * 1024 * 1024, 700 * K, 6 * 1024 * 1024, 2 * 1024 * 1024, 64 * K, 20 * K])
    check("the total size is the sum of the regular files' bytes (the symlink to /dev/zero adds nothing)", lc["total_size"] == expected_total and lc["total_size_text"] == mg.human(expected_total) == "26.1 MiB", (lc["total_size"], expected_total, lc["total_size_text"]))
    check("six sections, in the fixed order", list(sections) == ["top", "namespaces", "pod_logs", "host", "audit", "network"], str(list(sections)))
    top = [(i["name"], i["size"]) for i in sections["top"]["rows"]]
    check("top-level entries with recursive totals, largest first: namespaces/ (12.4 MiB), host_service_logs/ (11.7 MiB), audit_logs/, network_logs/ (20 KiB), cluster-scoped-resources/ (18 KiB), then the loose files",
          [n for n, _ in top] == ["namespaces/", "host_service_logs/", "audit_logs/", "network_logs/", "cluster-scoped-resources/", "event-filter.html", "version", "timestamp"]
          and dict(top)["namespaces/"] == 40 * K + 9 * K + 12 * 1024 * 1024 + 9 * K + 200 + 300 * K and dict(top)["host_service_logs/"] == 11 * 1024 * 1024 + 700 * K, str(top))
    check("directories carry their file counts", next(i for i in sections["top"]["rows"] if i["name"] == "namespaces/")["files"] == 7 and next(i for i in sections["top"]["rows"] if i["name"] == "namespaces/")["is_dir"])
    check("namespaces by recursive size: demo-app, openshift-monitoring, payments-demo", [i["name"] for i in sections["namespaces"]["rows"]] == ["demo-app", "openshift-monitoring", "payments-demo"], str(sections["namespaces"]["rows"]))
    pods = [(i["name"], i["size"]) for i in sections["pod_logs"]["rows"]]
    check("container logs named ns/pod/container (file), the 12 MiB previous log first, 9 KiB ties by name, the two 100 B ties by name",
          [n for n, _ in pods] == ["demo-app/demo-web-1/web (previous.log)", "demo-app/demo-web-1/web (current.log)", "demo-app/demo-web-2/web (current.log)",
                                   "payments-demo/payments-api-1/api (current.log)", "payments-demo/payments-api-1/api (previous.insecure.log)"], str(pods))
    check("sizes compare as bytes: the 12 MiB log sorts before 9 KiB ones (not '1' < '9' as text)", pods[0][1] > pods[1][1] and mg.sort_key({"size": 12 * 1024 * 1024, "name": "z"}) < mg.sort_key({"size": 9 * K, "name": "a"}))
    check("host service logs: workers/kubelet 6 MiB, masters/kubelet 5 MiB, masters/crio 700 KiB; audit: kube-apiserver first; network: the iptables dump only (the symlinked dir ignored)",
          [i["name"] for i in sections["host"]["rows"]] == ["workers/kubelet_service.log", "masters/kubelet_service.log", "masters/crio_service.log"]
          and [i["name"] for i in sections["audit"]["rows"]] == ["kube-apiserver/master-0-audit.log", "openshift-apiserver/master-0-audit.log"]
          and [i["name"] for i in sections["network"]["rows"]] == ["iptables-save_master-0"], str([(k, [i["name"] for i in s["rows"]]) for k, s in sections.items()]))
    check("section totals and texts", sections["host"]["total"] == 11 * 1024 * 1024 + 700 * K and sections["host"]["total_text"] == "11.7 MiB" and sections["pod_logs"]["count_all"] == 5)
    check("a plain tree without an image directory works too", mg.parse(tree("flat", {"namespaces/a/core/events.yaml": 10}, image=False)[0])["log_collection"]["total_files"] == 1)
    empty = os.path.join(WORKDIR, "empty"); os.makedirs(empty)
    check("an empty directory: no sections, zero files", mg.parse(empty)["log_collection"]["sections"] == [] and mg.parse(empty)["log_collection"]["total_files"] == 0)
    check("a missing directory never raises", mg.parse(os.path.join(WORKDIR, "nope"))["log_collection"]["total_files"] == 0)

    print("\n--- 2. unknown sizes, caps ---")
    keeper = mg._Keeper(limit=3)
    for name, size in (("a", 5), ("b", None), ("c", 9), ("d", 1), ("e", 9), ("f", 7)):
        keeper.add(mg._item(name, size))
    kept = [(i["name"], i["size"]) for i in keeper.rows()]
    check("the keeper holds the 3 largest (ties by name) plus the unknown-size item last, counts everything", kept == [("c", 9), ("e", 9), ("f", 7), ("b", None)] and keeper.count == 6 and keeper.total == 31, str(kept))
    big_root, big_base = tree("big", {f"host_service_logs/masters/log-{i:04d}.log": (i * 37) % 1000 + 1 for i in range(mg.KEEP + 120)})
    lc = mg.parse(big_root)["log_collection"]
    host = next(s for s in lc["sections"] if s["key"] == "host")
    check(f"a section with {mg.KEEP + 120} files keeps the {mg.KEEP} largest, counts all, says how many rows the page shows first",
          host["count_all"] == mg.KEEP + 120 and host["kept"] == mg.KEEP and host["top"] == mg.TOP and host["more"] == mg.KEEP - mg.TOP and host["rows"][0]["size"] == 1000 and all(i["size"] >= host["rows"][-1]["size"] for i in host["rows"]), str((host["count_all"], host["kept"], host["more"])))
    saved = mg.MAX_ENTRIES
    mg.MAX_ENTRIES = 50
    try:
        lc = mg.parse(big_root)["log_collection"]
        check("the walk cap stops the scan and flags the totals as a lower bound", lc["capped"] and lc["total_files"] <= 50, str((lc["capped"], lc["total_files"])))
    finally:
        mg.MAX_ENTRIES = saved
    unreadable_root, unreadable_base = tree("unreadable", {"host_service_logs/masters/ok.log": 10})
    # a dangling symlink is not followed (skipped); an unreadable size comes from a stat failure, simulated by a file replaced after scandir: covered by _Keeper above

    print("\n--- 3. the registry and the Flask render ---")
    mgr = lv.PARSERS["mustgather"]
    check("the must-gather registry ends with the Log Collection tab, a single tab without sub-tabs", list(mgr)[-1] == "log_collection" and "sub_tabs" not in mgr["log_collection"] and mgr["log_collection"]["label"] == "Log Collection" and mgr["log_collection"]["module"] == "parsers.mustgather.log_collection")
    app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
    app.register_blueprint(lv.log_viewer)
    app.secret_key = "mg-log-collection-test"
    client = app.test_client()

    def tab(directory):
        payload = {"report_type": "mustgather", "directory": directory, "tab": "log_collection", "sub_tab": None}
        return client.post("/get_tab_data", json=payload), client.post("/load_tab", json=payload)
    d, h = tab(root)
    html = (h.get_json() or {}).get("html", "")
    check("/get_tab_data and /load_tab answer 200", d.status_code == 200 and h.status_code == 200, f"{d.status_code}/{h.status_code}")
    rendered = re.findall(r'<tr class="lc-row" data-section="([^"]+)" data-name="([^"]+)" data-size="(-?\d+)"', html)
    sizes = [int(s) for _, _, s in rendered]
    check("the rendered rows: one table largest first across sections (namespaces/ 12.4 MiB first, the 12 MiB previous log before the 9 KiB current ones) with byte sizes",
          rendered[0][:2] == ("top", "namespaces/") and ("pod_logs", "demo-app/demo-web-1/web (previous.log)", str(12 * 1024 * 1024)) in rendered
          and rendered.index(("pod_logs", "demo-app/demo-web-1/web (previous.log)", str(12 * 1024 * 1024))) < rendered.index(("pod_logs", "demo-app/demo-web-1/web (current.log)", str(9 * K)))
          and [s for s in sizes if s >= 0] == sorted([s for s in sizes if s >= 0], reverse=True), str(rendered[:6]))
    check("a container log shows namespace / pod / container as segments with the file as the detail",
          '<span class="lc-seg-muted">demo-app</span><span class="lc-seg-sep">/</span><span class="lc-seg-muted">demo-web-1</span><span class="lc-seg-sep">/</span><span class="">web</span><span class="lc-detail">previous.log</span>' in html, html[html.find("demo-web-1") - 200:html.find("demo-web-1") + 300])
    bars = dict(zip([n for _, n, _ in rendered], [float(w) for w in re.findall(r'<i style="width: ([\d.]+)%"></i>', html)]))
    check("the size bars: files relative to the largest file (the 12 MiB log = 100%, a 9 KiB log 0.1%), directories relative to the largest directory (namespaces/ = 100%, audit_logs/ 16.7%)",
          bars["demo-app/demo-web-1/web (previous.log)"] == 100.0 and bars["demo-app/demo-web-1/web (current.log)"] == 0.1 and bars["namespaces/"] == 100.0 and abs(bars["audit_logs/"] - round(100.0 * (2 * 1024 * 1024 + 64 * K) / (40 * K + 9 * K + 12 * 1024 * 1024 + 9 * K + 200 + 300 * K), 1)) < 0.051, str({k: bars[k] for k in list(bars)[:6]}))
    check("one Name / Size header pair (Size selected), six section chips, the search box, the band with the top-level split and the largest file (the 12 MiB previous log), no Open Log Viewer button, the header line",
          html.count('class="lc-sort lc-sorted" data-key="size"') == 1 and html.count('class="ui-chip lc-chip" data-section=') == 6 and 'id="lc-search"' in html and 'id="lc-stack"' in html
          and "demo-app/demo-web-1/web (previous.log)" in html.split('id="lc-largest"')[1][:400] and "log-collection-open-viewer" not in html and "19 files" in html and "26.1 MiB" in html, html[:300])
    lcd = mg.parse(root)["log_collection"]
    check("the band's split: the top-level entries by size with their share, summing to 100%", [b["label"] for b in lcd["bar"]][:3] == ["namespaces/", "host_service_logs/", "audit_logs/"] and abs(sum(b["pct"] for b in lcd["bar"]) - 100.0) < 0.3 and lcd["largest"]["name"] == "demo-app/demo-web-1/web (previous.log)", str(lcd["bar"]))
    d, h = tab(big_root)
    html = (h.get_json() or {}).get("html", "")
    check(f"beyond the top {mg.TOP} of a section the rows are flagged extra and hidden ({mg.KEEP - mg.TOP} of the {mg.KEEP + 1} rows), with a 'Show all {mg.KEEP + 1}' button",
          html.count('<tr class="lc-row"') == mg.KEEP + 1 and html.count('data-extra="1" hidden') == mg.KEEP - mg.TOP and f'data-all="Show all {mg.KEEP + 1}"' in html and f"Show the top {mg.TOP} per section" in html, str((html.count('<tr class="lc-row"'), html.count('data-extra="1" hidden'))))
    nasty_root, _ = tree("nasty", {"host_service_logs/masters/<script>alert(1)</script>.log": 10, "namespaces/<img src=x onerror=alert(2)>/pods/p/c/c/logs/current.log": 20})
    d, h = tab(nasty_root)
    html = (h.get_json() or {}).get("html", "")
    check("file and namespace names are escaped", "<script>alert(1)" not in html and "<img src=x" not in html and "&lt;script&gt;" in html and "&lt;img" in html, html[-400:])
    d, h = tab(empty)
    html = (h.get_json() or {}).get("html", "")
    check("no logs: the Findings say so, no rows, no empty-state block", h.status_code == 200 and "No logs in this must-gather" in html and 'class="lc-row"' not in html and "Nothing to size" not in html, html[-300:])
    src = open(os.path.join(BACKEND, "templates", "tabs", "mustgather_log_collection.html")).read()
    check("the template: no marked-safe output, no Font Awesome, no &nbsp;, no utility grid/colour classes, no innerHTML, the lc-* classes of the sosreport page",
          "|safe" not in src and 'class="fas' not in src and "&nbsp;" not in src and not any(c in src for c in ("grid-cols-", "col-span-", "bg-gray-", "text-gray-", "md:")) and "innerHTML" not in src and 'import "tabs/_log_collection.html"' in src)

    print("\n--- 4. the mock must-gather ---")
    out = os.path.join(WORKDIR, "mock")
    mock_generate.main(["--out", out, "--no-archives"])
    lc = mg.parse(os.path.join(out, mock_generate.MG_NAME))["log_collection"]
    sections = {s["key"]: s for s in lc["sections"]}
    check("the mock must-gather: all six sections, the workers' kubelet log the largest host service log, a kube-apiserver file the largest audit log, every section largest first",
          list(sections) == ["top", "namespaces", "pod_logs", "host", "audit", "network"] and sections["host"]["rows"][0]["name"] == "workers/kubelet_service.log"
          and sections["audit"]["rows"][0]["name"].startswith("kube-apiserver/") and all([i["size"] for i in s["rows"]] == sorted([i["size"] for i in s["rows"]], reverse=True) for s in sections.values()),
          str([(k, s["rows"][0]["name"]) for k, s in sections.items()]))

    print(f"\n{'All checks passed' if not FAILED else str(FAILED) + ' check(s) failed'}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        shutil.rmtree(WORKDIR, ignore_errors=True)
    sys.exit(code)
