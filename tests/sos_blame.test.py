#!/usr/bin/env python3
"""Sos Report / Blame (backend/parsers/sosreport/blame.py and the
sos_report / log_collection group pages), the regrouped sidebar registry
and their templates through the Flask test client.

THE CHANGE: the Log Viewer moved under a new "Log Collection" group and a
new "Sos Report" group gained the "Blame" tab, which reads the report's
sos_reports/manifest.json and ranks the sos plugins by the time they took
(the sosblame CLI's logic as a normal sosreport parser: to_seconds for
sos's timedelta strings, plugin ranking, commands by run time, return-code
histograms, timeout_hit, the cmdline, start/end/total, the short node
label). /load_tab and /get_tab_data still accept {"tab": "log_viewer"}.

Runs on the diagnostics mock's synthetic manifests (an RHEL run, an
OpenShift master-like run, an old partial one) and small hand-written
trees; nothing real. Run with the backend venv's Python:
backend/venv/bin/python tests/sos_blame.test.py
"""
import json
import os
import shutil
import sys
import tempfile
from datetime import timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.join(HERE, "fixtures", "diagnostics-mock"))

from flask import Flask  # noqa: E402
import log_viewer as lv  # noqa: E402
import generate as mock_generate  # noqa: E402
import mock_manifests  # noqa: E402
from parsers.sosreport import blame, sos_report, log_collection  # noqa: E402

FAILED = 0
WORKDIR = tempfile.mkdtemp(prefix="sos-blame-")


def check(label, ok, detail=""):
    global FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {label}" + (f" | {str(detail)[:400]}" if not ok and detail else ""))
    if not ok:
        FAILED += 1


def tree(name, manifest=None, extra=None):
    root = os.path.join(WORKDIR, name)
    os.makedirs(os.path.join(root, "sos_reports"), exist_ok=True)
    with open(os.path.join(root, "version.txt"), "w") as f:
        f.write("sosreport: 4.7.0\n")
    if manifest is not None:
        with open(os.path.join(root, "sos_reports", "manifest.json"), "w") as f:
            f.write(manifest if isinstance(manifest, str) else json.dumps(manifest))
    for rel, content in (extra or {}).items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)
    return root


def cli_numbers(manifest):
    """The sosblame CLI's figures for a manifest, computed independently of
    the parser: plugins ranked by run_time, each with its command count,
    rc histogram and timeout flag, and the run's total."""
    def secs(value):
        if not value:
            return 0.0
        days = 0
        s = str(value)
        if "day" in s:
            days, s = s.split(", ", 1)
            days = int(days.split()[0])
        h, m, sec = s.split(":")
        return days * 86400 + int(h) * 3600 + int(m) * 60 + float(sec)
    plugins = manifest["components"]["report"]["plugins"]
    ranked = sorted(plugins.items(), key=lambda kv: secs(kv[1].get("run_time", "")), reverse=True)
    rows = []
    for name, info in ranked:
        cmds = info.get("commands", [])
        hist = {}
        for c in cmds:
            hist[c.get("return_code")] = hist.get(c.get("return_code"), 0) + 1
        rows.append((name, round(secs(info.get("run_time", "")), 3), len(cmds), dict(sorted(hist.items(), key=lambda kv: kv[1], reverse=True)), bool(info.get("timeout_hit"))))
    return rows, secs(manifest.get("run_time"))


def main():
    print("--- 1. to_seconds, labels, histograms ---")
    check("to_seconds: '0:02:47.041000' -> 167.041", abs(blame.to_seconds("0:02:47.041000") - 167.041) < 1e-6, blame.to_seconds("0:02:47.041000"))
    check("to_seconds: '1 day, 0:00:01' -> 86401", blame.to_seconds("1 day, 0:00:01") == 86401.0)
    check("to_seconds: '2 days, 1:02:03.5' -> 176523.5", blame.to_seconds("2 days, 1:02:03.5") == 176523.5)
    check("to_seconds: a number, an empty value and junk", blame.to_seconds(12.5) == 12.5 and blame.to_seconds("") == 0.0 and blame.to_seconds(None) == 0.0 and blame.to_seconds("soon") == 0.0)
    check("short_node_label: the OCP node name collapses to 'ip-10-0-42-46 [master]'", blame.short_node_label(mock_generate.OCP_NAME) == "ip-10-0-42-46 [master]", blame.short_node_label(mock_generate.OCP_NAME))
    check("short_node_label: a worker, and a plain name unchanged", blame.short_node_label("sosreport-ip-10-0-1-2-worker-x") == "ip-10-0-1-2 [worker]" and blame.short_node_label("sosreport-web-01-2026") == "sosreport-web-01-2026")
    check("rc_histogram: most frequent first, None kept", blame.rc_histogram([{"return_code": 1}, {"return_code": 0}, {"return_code": 0}, {}]) == {0: 2, 1: 1, None: 1})
    check("fmt_seconds: ms / s / min", (blame.fmt_seconds(0.034), blame.fmt_seconds(7.5), blame.fmt_seconds(189.93)) == ("34 ms", "7.5 s", "3 min 9.9 s"), (blame.fmt_seconds(0.034), blame.fmt_seconds(7.5), blame.fmt_seconds(189.93)))

    print("\n--- 2. the synthetic manifests against the CLI's numbers ---")
    out = os.path.join(WORKDIR, "mock")
    mock_generate.main(["--out", out, "--no-archives"])
    web = os.path.join(out, mock_generate.SOS_NAME)
    ocp = os.path.join(out, mock_generate.OCP_NAME)
    old = os.path.join(out, mock_generate.OLD_NAME)
    for label, path, manifest in (("web-01 (sos 4.7)", web, mock_manifests.rhel_manifest()), ("OCP master (sos 4.5)", ocp, mock_manifests.ocp_master_manifest())):
        b = blame.parse(path)["blame"]
        rows, total = cli_numbers(json.load(open(os.path.join(path, "sos_reports", "manifest.json"))))
        got = [(p["name"], p["seconds"], p["commands_count"], p["rc_counts"], p["timeout_hit"]) for p in b["plugins"]]
        check(f"{label}: available, every plugin ranked like the CLI (name, seconds, commands, rc histogram, timeout)", b["available"] and got == rows, str(got[:3]) + " vs " + str(rows[:3]))
        check(f"{label}: the run total equals the manifest's run_time ({total:.1f}s)", abs(b["total_seconds"] - total) < 0.01, b["total_seconds"])
        check(f"{label}: commands of the slowest plugin are sorted by run time, longest first", all(a["seconds"] >= c["seconds"] for a, c in zip(b["plugins"][0]["commands"], b["plugins"][0]["commands"][1:])))
        check(f"{label}: shares and the cumulative line are consistent (the last cumulative = sum of shares, within rounding)",
              abs(b["plugins"][-1]["cumulative"] - sum(p["share"] for p in b["plugins"])) < 1.0 and all(b["plugins"][i]["cumulative"] <= b["plugins"][i + 1]["cumulative"] + 1e-9 for i in range(len(b["plugins"]) - 1)),
              (b["plugins"][-1]["cumulative"], sum(p["share"] for p in b["plugins"])))
    b = blame.parse(ocp)["blame"]
    s = b["summary"]
    ebpf = next(p for p in b["plugins"] if p["name"] == "ebpf")
    check("OCP: ebpf is the slowest at 167.04 s with 383 commands, rc {127:317,1:66}, as in the CLI's output", b["plugins"][0]["name"] == "ebpf" and ebpf["seconds"] == 167.04 and ebpf["commands_count"] == 383 and ebpf["rc_text"] == "{127:317,1:66}", (ebpf["seconds"], ebpf["commands_count"], ebpf["rc_text"]))
    net = next(p for p in b["plugins"] if p["name"] == "networking")
    check("OCP: networking 60.81 s with 1,875 commands and a mixed rc histogram led by 0 and 1", net["seconds"] == 60.81 and net["commands_count"] == 1875 and list(net["rc_counts"])[:2] == [0, 1] and 127 in net["rc_counts"], (net["seconds"], net["commands_count"], net["rc_text"]))
    check("OCP: the summary counts 59 plugins, every command, the failed ones, the 127s, no timeout, the slowest and the top-3 share",
          s["plugins"] == 59 and s["commands"] == sum(p["commands_count"] for p in b["plugins"]) and s["failed"] == sum(p["failed"] for p in b["plugins"]) and s["not_found"] >= 317 + 2
          and s["timeouts"] == 0 and s["slowest"] == "ebpf" and s["top3_share"] > 100 and s["slowest_share"] == 88.0, str(s)[:300])
    check("OCP: the plugins' times exceed the run (threads), noted; the Gantt comes from the commands' times (no plugin start/end)", any("threads" in n for n in b["notes"]) and b["gantt"] and ebpf["offset_start"] is not None and ebpf["offset_end"] > ebpf["offset_start"], (b["notes"], ebpf["offset_start"], ebpf["offset_end"]))
    check("OCP: a plugin without commands is flagged (ceph_common) and plugins with no times still rank", any(p["no_commands"] and p["name"] == "ceph_common" for p in b["plugins"]))
    check("OCP: the node label and sysinfo", b["node_label"] == "ip-10-0-42-46 [master]" and b["hostname"] == "ip-10-0-42-46.example.internal" and b["version"] == "4.5.6" and b["cmdline"].startswith("sos report --batch --label=master"), (b["node_label"], b["hostname"], b["cmdline"][:40]))
    b = blame.parse(web)["blame"]
    s = b["summary"]
    check("web-01: 24 plugins in 113 s, example_app timed out at 60 s, the 127s counted, logs the slowest", s["plugins"] == 24 and s["timeouts"] == 1 and s["timeout_names"] == ["example_app"] and s["not_found"] == 5 and b["plugins"][0]["name"] == "example_app" and b["plugins"][1]["name"] == "logs", str(s)[:300])
    check("web-01: plugin start/end times give the Gantt offsets within the run", b["gantt"] and all(0 <= p["offset_start"] <= p["offset_end"] <= b["total_seconds"] + 1 for p in b["plugins"] if p["offset_start"] is not None), str([(p["name"], p["offset_start"], p["offset_end"]) for p in b["plugins"][:3]]))
    check("web-01: a plugin's failed count and rc labels (kernel: 2 x 127, 1 x 1)", next(p for p in b["plugins"] if p["name"] == "kernel")["rc_text"] == "{0:5,127:2,1:1}", next(p for p in b["plugins"] if p["name"] == "kernel")["rc_text"])
    b = blame.parse(old)["blame"]
    check("old sos: no plugin timings -> not available, a reason naming the version, the run's start/end kept", not b["available"] and "4.1.0" in b["reason"] and b["start"].startswith("2026-10-01") and b["plugins"] == [], str(b)[:300])

    print("\n--- 3. missing and partial manifests ---")
    b = blame.parse(tree("no-manifest"))["blame"]
    check("no manifest: not available with a clear reason, no exception", not b["available"] and "manifest.json" in b["reason"])
    b = blame.parse(tree("broken", "{not json"))["blame"]
    check("broken JSON: not available, the reason says it could not be read", not b["available"] and "could not be read" in b["reason"], b["reason"])
    b = blame.parse(tree("list", "[1, 2]"))["blame"]
    check("a JSON list: not available", not b["available"])
    weird = {"version": "9.9", "cmdline": "report", "run_time": "0:00:10", "components": {"report": {"plugins": {
        "good": {"run_time": "0:00:04", "commands": [{"exec": "a", "return_code": 0, "run_time": 1.5}, {"exec": "b", "return_code": "weird", "run_time": "0:00:02"}, "junk", {"exec": None}]},
        "odd": "not a dict", "notime": {"commands": []}, "neg": {"run_time": "-1", "timeout": "abc", "timeout_hit": "yes", "files": "x"}}}}}
    b = blame.parse(tree("weird", weird))["blame"]
    check("unknown shapes never raise: a string plugin, a junk command, a string rc, a missing run_time, a string timeout",
          b["available"] and [p["name"] for p in b["plugins"]][0] == "good" and b["plugins"][0]["commands_count"] == 4 and len(b["plugins"][0]["commands"]) == 3
          and b["plugins"][0]["rc_text"] == "{0:1,weird:1,none:1}" and next(p for p in b["plugins"] if p["name"] == "neg")["timeout"] is None, str(b["plugins"])[:400])
    check("nested wrapper directory unwrapped like the other parsers", blame.parse(os.path.dirname(shutil.copytree(web, os.path.join(WORKDIR, "wrap", os.path.basename(web)))))["blame"]["available"])

    print("\n--- 4. the group pages ---")
    r = sos_report.parse(web)["sos_report"]
    check("Sos Report: version, cmdline, times, policy, plugins, the sos_reports/ files", r["available"] and r["version"] == "4.7.0" and r["cmdline"].startswith("sos report") and r["plugins"] == 24 and r["policy"] == "Red Hat Enterprise Linux" and any(f["name"] == "manifest.json" for f in r["files"]), str(r)[:300])
    r = sos_report.parse(tree("no-manifest"))["sos_report"]
    check("Sos Report without a manifest: the empty state with version.txt", not r["available"] and r["version_txt"] == "sosreport: 4.7.0")
    l = log_collection.parse(web)["log_collection"]
    check("Log Collection: journal captures, dmesg, system and application logs listed with sizes, nothing read",
          [g["key"] for g in l["groups"]] == ["journal", "kernel", "syslog", "app"] and l["journal_present"] and l["total_files"] > 8 and all(f["size"] is not None for g in l["groups"] for f in g["files"]), str([(g["key"], len(g["files"])) for g in l["groups"]]))
    l = log_collection.parse(tree("no-logs"))["log_collection"]
    check("Log Collection on a report without logs: empty groups", l["groups"] == [] and l["total_files"] == 0)

    print("\n--- 5. the registry and the Flask routes ---")
    sos = lv.PARSERS["sosreport"]
    check("the registry: Log Collection -> Log Viewer, Sos Report -> Blame; log_viewer no longer a top-level tab", "log_viewer" not in sos and sos["log_collection"]["sub_tabs"]["log_viewer"]["module"] == "parsers.sosreport.log_viewer"
          and sos["sos_report"]["sub_tabs"]["blame"]["module"] == "parsers.sosreport.blame" and sos["log_collection"]["label"] == "Log Collection" and sos["sos_report"]["label"] == "Sos Report")
    check("_resolve_tab: a sub-tab asked for as a tab resolves to its group; groups and explicit pairs pass through", lv._resolve_tab("sosreport", "log_viewer", None) == ("log_collection", "log_viewer") and lv._resolve_tab("sosreport", "blame", None) == ("sos_report", "blame")
          and lv._resolve_tab("sosreport", "kernel", None) == ("kernel", None) and lv._resolve_tab("sosreport", "kernel", "kernel_oom_killer") == ("kernel", "kernel_oom_killer") and lv._resolve_tab("sosreport", "nope", None) == ("nope", None))
    app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
    app.register_blueprint(lv.log_viewer)
    app.secret_key = "sos-blame-test"
    client = app.test_client()

    def tab(directory, tab_name, sub_tab=None):
        payload = {"report_type": "sosreport", "directory": directory, "tab": tab_name, "sub_tab": sub_tab}
        return client.post("/get_tab_data", json=payload), client.post("/load_tab", json=payload)
    d, h = tab(web, "log_viewer")
    check("/get_tab_data and /load_tab with {tab: log_viewer} (the old address) still answer 200 with the Log Viewer", d.status_code == 200 and h.status_code == 200 and "available_logs" in (d.get_json() or {}).get("data", {}) and 'id="date-slider-container"' in (h.get_json() or {}).get("html", ""), f"{d.status_code}/{h.status_code}")
    d, h = tab(web, "log_collection", "log_viewer")
    check("... and as Log Collection -> Log Viewer", d.status_code == 200 and h.status_code == 200 and 'id="date-slider-container"' in (h.get_json() or {}).get("html", ""))
    d, h = tab(web, "log_collection")
    check("Log Collection group page renders its file list and the Open Log Viewer button", h.status_code == 200 and "log-collection-open-viewer" in (h.get_json() or {}).get("html", "") and "journalctl_--no-pager" in (h.get_json() or {}).get("html", ""))
    d, h = tab(web, "sos_report")
    check("Sos Report group page renders the facts and the Open Blame button", h.status_code == 200 and "sos-report-open-blame" in (h.get_json() or {}).get("html", "") and "4.7.0" in (h.get_json() or {}).get("html", ""))
    d, h = tab(web, "sos_report", "blame")
    html = (h.get_json() or {}).get("html", "")
    check("Blame renders: the strip, the charts' canvases, the table, the cmdline", h.status_code == 200 and 'id="blame-table"' in html and 'id="blame-bars"' in html and 'id="blame-gantt"' in html and 'id="blame-cmdline"' in html and "example_app" in html, f"{h.status_code} {html[:200]}")
    d, h = tab(web, "blame")
    check("Blame by its own id resolves too", h.status_code == 200 and 'id="blame-table"' in (h.get_json() or {}).get("html", ""))
    d, h = tab(old, "sos_report", "blame")
    html = (h.get_json() or {}).get("html", "")
    check("Blame on the old manifest: the empty state names the sos version, no table, no charts", h.status_code == 200 and "No plugin timings" in html and "4.1.0" in html and 'id="blame-table"' not in html and "<canvas" not in html, html[-300:])
    d, h = tab(tree("no-manifest-2"), "sos_report", "blame")
    check("Blame without a manifest: the empty state", h.status_code == 200 and "No plugin timings" in (h.get_json() or {}).get("html", ""))

    print("\n--- 6. escaping ---")
    nasty = mock_manifests.rhel_manifest()
    plugins = nasty["components"]["report"]["plugins"]
    plugins["<script>alert(1)</script>"] = {"run_time": "0:00:01", "commands": [{"exec": "</pre><script>alert(2)</script> --flag=\"<b>x</b>\"", "return_code": 0, "run_time": 0.5}]}
    nasty["cmdline"] = "report --note='<img src=x onerror=alert(3)>'"
    nasty["components"]["report"]["sysinfo"]["hostname"] = "<i>host</i>.example.test"
    d, h = tab(tree("nasty", nasty), "sos_report", "blame")
    html = (h.get_json() or {}).get("html", "")
    check("Blame escapes plugin names, command lines, the cmdline and the hostname (no raw <script>, <img onerror>, <b>, <i> from the manifest)",
          h.status_code == 200 and "<script>alert(1)" not in html and "<script>alert(2)" not in html and "<img src=x" not in html and "<b>x</b>" not in html and "<i>host</i>" not in html and "&lt;script&gt;" in html, html[:200])
    check("... including inside the data the charts read (tojson escapes < and >)", "<script>alert" not in html.split("const B = ")[1][:200000] if "const B = " in html else False)
    d, h = tab(tree("nasty", nasty), "sos_report")
    html = (h.get_json() or {}).get("html", "")
    check("Sos Report escapes the cmdline and the hostname", "<img src=x" not in html and "<i>host</i>" not in html)
    for name in ("sosreport_blame.html", "sosreport_sos_report.html", "sosreport_log_collection.html"):
        src = open(os.path.join(BACKEND, "templates", "tabs", name)).read()
        check(f"{name}: no marked-safe output, no Font Awesome, no &nbsp;, no utility grid/colour classes, no innerHTML", "|safe" not in src and "| safe" not in src and 'class="fas' not in src and "&nbsp;" not in src
              and not any(c in src for c in ("grid-cols-", "col-span-", "bg-gray-", "text-gray-", "md:", "space-y-")) and "innerHTML" not in src and "insertAdjacentHTML" not in src, name)

    print(f"\n{'All checks passed' if not FAILED else str(FAILED) + ' check(s) failed'}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        shutil.rmtree(WORKDIR, ignore_errors=True)
    sys.exit(code)
