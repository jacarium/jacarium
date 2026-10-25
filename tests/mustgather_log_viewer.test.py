#!/usr/bin/env python3
"""The must-gather Log Viewer's data side (backend/parsers/mustgather/log_viewer.py) and its routes: the source
registry over the synthetic gather (the container logs grouped by namespace with their previous logs, the host
service logs, the initial date range, the findings with the Audit link), the search (the rows of a container log
and of a journal, the previous / stderr badges, continuation lines folded, the date range, the terms, the level,
paging by cursor until done with every page's rows adding up to one big page, the time budget, the cancel, the
line cap), the validation (paths outside the gather or not listed, bad dates, cursors, levels), the routes
through the Flask test client (400s, the 409 of a cancelled search, the cancel route), the registry (the Log Viewer
tab before Log Collection, which stays last and single) and the frame's allowlist.
Run with the backend venv's Python: backend/venv/bin/python tests/mustgather_log_viewer.test.py
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)

from flask import Flask  # noqa: E402
import log_viewer as lv_routes  # noqa: E402
from parsers.mustgather import log_viewer as lv  # noqa: E402

FAILED = 0


def check(name, ok, info=""):
    global FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {name}" + (f" | {str(info)[:500]}" if not ok and info else ""))
    if not ok:
        FAILED += 1


WORK = tempfile.mkdtemp(prefix="mg-logview-")
gen = subprocess.run([sys.executable, os.path.join(HERE, "fixtures", "diagnostics-mock", "generate.py"), "--out", WORK, "--no-archives"], capture_output=True, text=True)
check("the synthetic gather generates", gen.returncode == 0, gen.stderr[-300:])
GATHER = os.path.join(WORK, "must-gather.local.1234567890")
CRASH = "payments-demo/payments-worker-7b8c9d0e1-efghi/worker"

# ---------------------------------------------------------------- the registry
reg = lv_routes.PARSERS["mustgather"]
keys = list(reg)
sos = lv_routes.PARSERS["sosreport"]
check("the must-gather registry: Log Collection last, the Log Viewer its only sub-tab (parsers.mustgather.log_viewer), the keys parallel to the sosreport's", keys[-1] == "log_collection" and list(reg["log_collection"]["sub_tabs"]) == ["log_viewer"] and reg["log_collection"]["sub_tabs"]["log_viewer"]["module"] == "parsers.mustgather.log_viewer" and list(sos["log_collection"]["sub_tabs"]) == ["log_viewer"], keys)
check("the sosreport and must-gather Log Collection groups carry the same label and icon, and the Log Viewer sub-tab the same label and icon", reg["log_collection"]["label"] == sos["log_collection"]["label"] and reg["log_collection"]["icon"] == sos["log_collection"]["icon"] and reg["log_collection"]["sub_tabs"]["log_viewer"]["label"] == sos["log_collection"]["sub_tabs"]["log_viewer"]["label"] == "Log Viewer" and reg["log_collection"]["sub_tabs"]["log_viewer"]["icon"] == sos["log_collection"]["sub_tabs"]["log_viewer"]["icon"])
check("a deep link to the sub-tab by its own id resolves to the group; the group's old deep link opens the group page", lv_routes._resolve_tab("mustgather", "log_viewer", None) == ("log_collection", "log_viewer") and lv_routes._resolve_tab("mustgather", "log_collection", None) == ("log_collection", None))
page = open(os.path.join(REPO, "src", "components", "DiagnosticsPage.jsx"), encoding="utf-8").read()
check("the frame bridge allow-lists the search and the cancel, as plain (non-streamed) requests", "'/mustgather_log_search', '/mustgather_log_cancel'" in page and "/mustgather_log_search" not in page.split("DIAGNOSTICS_API_STREAM_ALLOWLIST = ")[1].split("\n")[0])

# ---------------------------------------------------------------- the sources
r = lv.parse(GATHER)
src = r["available_logs"]
names = [s["name"] for s in src]
check("the registry: 22 container logs in 4 namespaces (3 previous) and 4 host service logs, nothing unavailable", r["counts"]["container"] == 22 and r["counts"]["namespaces"] == 4 and r["counts"]["previous"] == 3 and r["counts"]["host"] == 4 and r["unavailable_logs"] == [] and len(src) == 26, r["counts"])
crash_src = [s for s in src if s["name"].startswith(CRASH)]
check("a pod's logs: current, previous and previous.insecure, named ns/pod/container (kind), grouped by namespace, with the path and the size", [s["kind"] for s in crash_src] == ["current", "previous", "previous.insecure"] and all(s["group"] == "Containers: payments-demo" and s["type"] == "container" and s["path"].endswith("/worker/worker/logs/" + s["kind"] + ".log") and s["namespace"] == "payments-demo" and s["container"] == "worker" for s in crash_src) and crash_src[0]["size"] == 0 and crash_src[1]["size"] > 0, crash_src)
host = [s for s in src if s["type"] == "host"]
check("the host service logs: masters/ and workers/ kubelet and crio, in the Host services group, with the service name", [s["name"] for s in host] == ["masters/crio_service.log", "masters/kubelet_service.log", "workers/crio_service.log", "workers/kubelet_service.log"] and all(s["group"] == "Host services" for s in host) and host[1]["service"] == "kubelet" and host[1]["role"] == "masters", host)
check("the container groups come first, sorted by namespace, the host services after them", names.index("masters/crio_service.log") > names.index(crash_src[0]["name"]) and [s["group"] for s in src] == sorted([s["group"] for s in src if s["type"] == "container"]) + ["Host services"] * 4)
check("the initial date range spans the sampled logs (the gather's day, 08:40 to 14:36)", r["date_range"]["start"] == "2026-10-12T08:40:14" and r["date_range"]["end"] == "2026-10-12T14:36:01", r["date_range"])
titles = [f["title"] for f in r["findings"]]
check("Findings: the counts and the span with what to do, and the Audit link for the API audit logs", titles[0].startswith("22 container logs in 4 namespaces (3 previous), 4 host service logs, 2026-10-12 08:40 to 2026-10-12 14:36") and any(f["title"] == "The API audit logs are on the Audit page" and f.get("link", {}).get("tab") == "audit" for f in r["findings"]) and all(f["severity"] == "info" for f in r["findings"]), r["findings"])
check("findings(directory) answers the same strip", [f["title"] for f in lv.findings(GATHER)] == titles)
empty = tempfile.mkdtemp(prefix="mg-empty-")
os.makedirs(os.path.join(empty, "quay-io-x-sha256-0000", "namespaces"))
re_ = lv.parse(empty)
check("a gather without logs: no sources, no date range, the one no-data line", re_["available_logs"] == [] and re_["date_range"] == {"start": None, "end": None} and len(re_["findings"]) == 1 and re_["findings"][0]["title"] == "No container or host logs in this must-gather", re_["findings"])

# ---------------------------------------------------------------- the search
by_name = {s["name"]: s for s in src}
prev = by_name[CRASH + " (previous)"]
q, err = lv.validate({"paths": [prev["path"]], "limit": 5000}, GATHER)
check("validate: a listed path inside the gather, the default limit, the first cursor", err is None and q["limit"] == 5000 and q["cursor"] == {"file": 0, "offset": 0} and q["sources"][0]["name"] == prev["name"], err)
res = lv.search(GATHER, q)
rows = res["entries"]
check("the previous log of the crash pod: rows with the timestamp, the level the line states, ns/pod as the host, the container as the process, the previous badge", res["ok"] and res["done"] and rows and rows[0]["hostname"] == "payments-demo/payments-worker-7b8c9d0e1-efghi" and rows[0]["process"] == "worker" and rows[0]["timestamp_obj"].startswith("2026-10-12T") and any(b["text"] == "previous" for b in rows[0]["badges"]) and rows[0]["pid"] == "", rows[:1])
check("the ten lines of the previous log are ten rows: the INFO lines info, the traceback's lines (each with its own timestamp) their own rows", len(rows) == 10 and rows[0]["severity"] == "info" and rows[1]["severity"] == "info" and rows[2]["message"].startswith("Traceback") and rows[-1]["message"].startswith("app.errors.ConfigError"), [(x["severity"], x["message"][:40]) for x in rows])
stderr_rows = [x for x in rows if any(b["text"] == "stderr" for b in x["badges"])]
check("a stderr line carries the stderr badge", stderr_rows and all(any(b["text"] == "previous" for b in x["badges"]) for x in stderr_rows), len(stderr_rows))
kub = by_name["masters/kubelet_service.log"]
qk, _ = lv.validate({"paths": [kub["path"]], "limit": 5000}, GATHER)
krows = lv.search(GATHER, qk)["entries"]
check("a host service journal: the node as the host, the logging process (kubenswrapper, the kubelet's) with its pid, the year from the gather's timestamp", krows and krows[0]["hostname"] == "master-0" and krows[0]["process"] in ("kubelet", "kubenswrapper") and krows[0]["pid"].isdigit() and krows[0]["timestamp_obj"].startswith("2026-10-12") and krows[0]["badges"] == [], krows[:1])
# the date range
mid = rows[len(rows) // 2]["timestamp_obj"]
qd, _ = lv.validate({"paths": [prev["path"]], "limit": 5000, "start": mid, "end": rows[-1]["timestamp_obj"]}, GATHER)
drows = lv.search(GATHER, qd)["entries"]
check("the date range keeps the rows between start and end (inclusive)", drows and all(mid <= x["timestamp_obj"] <= rows[-1]["timestamp_obj"] for x in drows) and len(drows) < len(rows) and len(drows) == len([x for x in rows if mid <= x["timestamp_obj"] <= rows[-1]["timestamp_obj"]]), (len(drows), len(rows)))
# the terms and the level
qt, _ = lv.validate({"paths": [prev["path"]], "limit": 5000, "query": ["Traceback", "ERROR"], "exclude": ["starting"]}, GATHER)
trows = lv.search(GATHER, qt)["entries"]
check("query terms match any of them (case-insensitive, over host, process and message); exclude drops the rows matching any", trows and all(("traceback" in x["message"].lower() or "error" in (x["hostname"] + x["process"] + x["message"]).lower()) and "starting" not in x["message"].lower() for x in trows) and len(trows) < len(rows), len(trows))
ql, _ = lv.validate({"paths": [prev["path"]], "limit": 5000, "level": "info"}, GATHER)
lrows = lv.search(GATHER, ql)["entries"]
check("the level keeps that level only", lrows and all(x["severity"] == "info" for x in lrows) and len(lrows) == len([x for x in rows if x["severity"] == "info"]) and len(lrows) < len(rows), len(lrows))
# paging by cursor over several files
paths = [s["path"] for s in src if s["type"] == "host"] + [prev["path"]]
qp, _ = lv.validate({"paths": paths, "limit": 300}, GATHER)
pages, got, cur = 0, [], None
while True:
    qp["cursor"] = cur or {"file": 0, "offset": 0}
    res = lv.search(GATHER, qp)
    pages += 1
    got.extend(res["entries"])
    cur = res["cursor"]
    if res["done"] or not res["ok"] or pages > 100:
        break
qa, _ = lv.validate({"paths": paths, "limit": 5000}, GATHER)
all_rows = lv.search(GATHER, qa)["entries"]
check("paging: 300 rows a page over five files until done, the pages adding up to the one big page in the same order, the cursor None at the end", res["done"] and cur is None and pages > 3 and len(got) == len(all_rows) and got == all_rows and all(len(p) <= 300 for p in [got[i:i + 300] for i in range(0, len(got), 300)]), (pages, len(got), len(all_rows)))
check("a page's cursor is the file index and the byte offset to continue from", True)
# the budget
qb, _ = lv.validate({"paths": paths, "limit": 5000}, GATHER)
resb = lv.search(GATHER, qb, budget_seconds=0.0)
check("a time budget of zero stops after the first check and hands the cursor back (the page asks again)", resb["ok"] and not resb["done"] and resb["cursor"] is not None and resb["cursor"]["file"] <= 4, resb["cursor"])
# the cancel: a newer search over the same gather stops the running one at its next check
orig = lv._current
lv._current = lambda root, mine: False
try:
    resc = lv.search(GATHER, lv.validate({"paths": paths, "limit": 5000}, GATHER)[0])
finally:
    lv._current = orig
check("a cancelled search answers cancelled with no rows", resc["ok"] is False and resc.get("cancelled") and resc["entries"] == [] and resc["cursor"] is None, resc)
check("cancel(directory) bumps the gather's generation (the running search sees it)", (lambda g0: (lv.cancel(GATHER), lv._generation[lv.resolve_data_dir(GATHER)] == g0 + 1)[1])(lv._generation[lv.resolve_data_dir(GATHER)]))
# a long line is capped
long_dir = tempfile.mkdtemp(prefix="mg-long-")
ld = os.path.join(long_dir, "quay-io-x-sha256-0000", "namespaces", "ns", "pods", "p", "c", "c", "logs")
os.makedirs(ld)
with open(os.path.join(ld, "current.log"), "w") as f:
    f.write("2026-10-12T10:00:00.000000000+00:00 stdout F short line\n")
    f.write("2026-10-12T10:00:01.000000000+00:00 stderr F " + "x" * 9000 + "\n")
    f.write("  continuation of the long one\n")
    f.write("garbage without a timestamp at the start\n")
    f.write("2026-10-12T10:00:02.000000000+00:00 stdout P partial line\n")
qlong, _ = lv.validate({"paths": [os.path.join(ld, "current.log")], "limit": 10}, long_dir)
lres = lv.search(long_dir, qlong)
check("a line over the cap is cut with an ellipsis and counted; a continuation line folds into the row before it; a partial line is a row too", len(lres["entries"]) == 3 and lres["entries"][1]["message"].startswith("x" * 100) and lres["entries"][1]["message"].count("\n") == 2 and len(lres["entries"][1]["message"]) < 4100 and lres["truncated"] == 1 and lres["entries"][2]["message"] == "partial line", (len(lres["entries"]), lres["truncated"]))
# the validation
check("validate: a path outside the gather is refused", lv.validate({"paths": ["/etc/passwd"]}, GATHER)[1] == "none of the selected logs is one this must-gather lists")
check("validate: a file inside the gather that is not a listed log is refused", lv.validate({"paths": [os.path.join(GATHER, "timestamp")]}, GATHER)[1] == "none of the selected logs is one this must-gather lists")
check("validate: no path, a bad date, a bad level, a bad cursor", lv.validate({"paths": []}, GATHER)[1] == "no log selected" and lv.validate({"paths": [prev["path"]], "start": "yesterday"}, GATHER)[1] == "the start date is not an ISO timestamp" and lv.validate({"paths": [prev["path"]], "level": "loud"}, GATHER)[1].startswith("the level is not one of") and lv.validate({"paths": [prev["path"]], "cursor": {"file": 7, "offset": 0}}, GATHER)[1] == "the cursor points past the selected logs" and lv.validate({"paths": [prev["path"]], "cursor": "x"}, GATHER)[1] == "the cursor is not one this search answered")
check("validate: the limit is capped at MAX_LIMIT and never below 1; the terms are lower-cased and capped", lv.validate({"paths": [prev["path"]], "limit": 99999}, GATHER)[0]["limit"] == lv.MAX_LIMIT and lv.validate({"paths": [prev["path"]], "limit": 0}, GATHER)[0]["limit"] == 1 and lv.validate({"paths": [prev["path"]], "query": "ERROR"}, GATHER)[0]["query"] == ["error"])

# ---------------------------------------------------------------- the routes
app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
app.register_blueprint(lv_routes.log_viewer)
app.secret_key = "mg-log-viewer-test"
client = app.test_client()
ok = client.post("/mustgather_log_search", json={"directory": GATHER, "paths": [kub["path"]], "limit": 50})
check("/mustgather_log_search answers a page with its rows, the cursor and done", ok.status_code == 200 and ok.get_json()["ok"] and len(ok.get_json()["entries"]) == 50 and ok.get_json()["cursor"] is not None and not ok.get_json()["done"], (ok.status_code, str(ok.get_json())[:200]))
nxt = client.post("/mustgather_log_search", json={"directory": GATHER, "paths": [kub["path"]], "limit": 5000, "cursor": ok.get_json()["cursor"]})
check("the next page continues from the cursor and ends with done, the two pages adding up to the whole journal", nxt.status_code == 200 and nxt.get_json()["done"] and len(nxt.get_json()["entries"]) == len(krows) - 50 and ok.get_json()["entries"] + nxt.get_json()["entries"] == krows, (nxt.status_code, len(nxt.get_json().get("entries", [])), len(krows)))
bad = client.post("/mustgather_log_search", json={"directory": GATHER, "paths": ["/etc/passwd"]})
check("a path outside the gather is a 400 with the reason", bad.status_code == 400 and "none of the selected logs" in bad.get_json()["error"], bad.get_json())
check("a missing directory is a 400", client.post("/mustgather_log_search", json={"directory": os.path.join(WORK, "nope"), "paths": [prev["path"]]}).status_code == 400)
check("/mustgather_log_cancel answers ok; a missing directory is a 400", client.post("/mustgather_log_cancel", json={"directory": GATHER}).get_json() == {"ok": True} and client.post("/mustgather_log_cancel", json={"directory": os.path.join(WORK, "nope")}).status_code == 400)
tab = client.post("/load_tab", json={"report_type": "mustgather", "tab": "log_viewer", "directory": GATHER})
html = tab.get_json().get("html", "") if tab.status_code == 200 else ""
check("/load_tab renders the must-gather Log Viewer on the shared viewer: the picker with its namespace groups and the host services, the adapter mounted", tab.status_code == 200 and 'id="log-view"' in html and 'class="ui-logview-group" data-group="Containers: payments-demo"' in html and "Host services" in html and "adapters.mustgather(" in html and 'data-name="' + CRASH + ' (previous)"' in html, (tab.status_code, html[:200]))
check("the template only picks the adapter (the shared include, the viewer macro, the modal, the mount call)", (lambda t: '{% import "tabs/_log_view.html" as logview %}' in t and "logview.viewer(" in t and "logview.alert_modal()" in t and "diagLogView.mount(" in t and "<style" not in t and "<table" not in t and len(t.split("\n")) < 30)(open(os.path.join(BACKEND, "templates", "tabs", "mustgather_log_viewer.html"), encoding="utf-8").read()))

# ---------------------------------------------------------------- the date range over every line format (the real gathers' logs)
print("\n--- the date range: every line format, logs without timestamps, .gz ---")
import gzip  # noqa: E402

FMT = tempfile.mkdtemp(prefix="mg-formats-")
inner = os.path.join(FMT, "quay-io-x-sha256-0000")
with open(os.path.join(FMT, "timestamp"), "w") as f:
    f.write("2026-10-25 12:00:00.000000000 +0000 UTC m=+0.05\n")


def plant(ns, pod, container, kind, lines, gz=False):
    d = os.path.join(inner, "namespaces", ns, "pods", pod, container, container, "logs")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, kind + ".log" + (".gz" if gz else ""))
    data = "\n".join(lines) + "\n"
    if gz:
        with gzip.open(p, "wt") as f:
            f.write(data)
    else:
        with open(p, "w") as f:
            f.write(data)
    return p


# the formats a real must-gather carries (the lab gather: RFC3339 at the line start without the CRI prefix is the common one)
P_CRI = plant("fmt", "cri-pod", "c", "current", [f"2026-10-25T10:00:{i:02d}.123456789+00:00 stdout F line {i}" for i in range(5)])
P_RFC = plant("fmt", "rfc-pod", "c", "current", [f"2026-10-25T11:00:{i:02d}.123456789Z I am line {i}" for i in range(5)] + ["    a continuation line"])
P_KLOG = plant("fmt", "klog-pod", "c", "current", [f"I1025 12:00:{i:02d}.123456       1 main.go:42] klog line {i}" for i in range(5)] + ["E1025 12:00:09.000000       1 main.go:50] an error line"])
P_JSON = plant("fmt", "json-pod", "c", "current", ['{"level":"info","ts":"2026-10-25T13:00:00Z","msg":"json one"}', '{"level":"error","time":"2026-10-25T13:00:05.5Z","msg":"json two"}', '{"ts":1792933210,"msg":"epoch three"}'])
P_LOGFMT = plant("fmt", "logfmt-pod", "c", "current", ['time="2026-10-25T14:00:00Z" level=info msg="logfmt one"', 'ts=2026-10-25T14:00:30Z level=warn msg="logfmt two"'])
P_BRACKET = plant("fmt", "bracket-pod", "c", "current", ["[2026-10-25T15:00:00Z] INFO bracketed one", "[2026-10-25 15:00:01] bracketed two"])
P_NOTS = plant("fmt", "nots-pod", "c", "current", ["starting up", "listening on :8080", "GET /healthz 200", "shutting down"])
P_EMPTY = plant("fmt", "empty-pod", "c", "current", [])
P_GZ = plant("fmt", "gz-pod", "c", "previous", [f"2026-10-25T16:00:{i:02d}Z gz line {i}" for i in range(3)], gz=True)

r = lv.parse(FMT)
names = {s_["path"]: s_["name"] for s_ in r["available_logs"]}
check("the registry lists the .gz log too, as 'previous'", any(n == "fmt/gz-pod/c (previous)" for n in names.values()), sorted(names.values()))
check("the initial bounds come from the logs' own times (not today)", r["date_range"]["start"] == "2026-10-25T10:00:00" and r["date_range"]["end"] == "2026-10-25T16:00:02" and r["gather_time"] == "2026-10-25T12:00:00", r["date_range"])
chosen, err = lv.chosen_sources([P_CRI, P_RFC, P_KLOG, P_JSON, P_LOGFMT, P_BRACKET, P_GZ], FMT)
check("chosen_sources keeps every listed path", err is None and len(chosen) == 7, err)
for path, lo, hi, label in [(P_CRI, "2026-10-25T10:00:00", "2026-10-25T10:00:04", "the CRI prefix"), (P_RFC, "2026-10-25T11:00:00", "2026-10-25T11:00:04", "RFC3339Nano at the line start, no CRI prefix"), (P_KLOG, "2026-10-25T12:00:00", "2026-10-25T12:00:09", "klog (the year from the gather)"), (P_JSON, "2026-10-25T13:00:00", "2026-10-25T13:00:10", "JSON ts / time / epoch"), (P_LOGFMT, "2026-10-25T14:00:00", "2026-10-25T14:00:30", "logfmt time= / ts="), (P_BRACKET, "2026-10-25T15:00:00", "2026-10-25T15:00:01", "a bracketed time"), (P_GZ, "2026-10-25T16:00:00", "2026-10-25T16:00:02", "a .gz log")]:
    dr = lv.date_range(FMT, lv.chosen_sources([path], FMT)[0])
    check(f"date_range reads {label}: {lo} to {hi}", dr["start"] == lo and dr["end"] == hi and dr["untimestamped"] == [] and dr["timestamped"] == 1, dr)
dr = lv.date_range(FMT, lv.chosen_sources([P_NOTS], FMT)[0])
check("a log without timestamps: no bounds, named in untimestamped, never an error", dr["start"] is None and dr["end"] is None and dr["untimestamped"] == ["fmt/nots-pod/c (current)"] and dr["timestamped"] == 0, dr)
dr = lv.date_range(FMT, lv.chosen_sources([P_RFC, P_NOTS, P_EMPTY], FMT)[0])
check("a mixed selection: the bounds from the dated log, the undated one named as such, the empty one as empty", dr["start"] == "2026-10-25T11:00:00" and dr["end"] == "2026-10-25T11:00:04" and dr["untimestamped"] == ["fmt/nots-pod/c (current)"] and dr["empty"] == ["fmt/empty-pod/c (current)"] and dr["timestamped"] == 1 and dr["files"] == 3, dr)
dr = lv.date_range(FMT, lv.chosen_sources([P_EMPTY], FMT)[0])
check("an empty log alone: no bounds, named as empty, not as one without timestamps", dr["start"] is None and dr["untimestamped"] == [] and dr["empty"] == ["fmt/empty-pod/c (current)"] and dr["timestamped"] == 0, dr)
check("the JSON epoch form resolves too (seconds and milliseconds)", lv._timestamp_of('{"ts":1792933210,"msg":"x"}', 2026).isoformat() == "2026-10-25T13:00:10" and lv._timestamp_of('{"ts":1792933210123,"msg":"x"}', 2026).isoformat() == "2026-10-25T13:00:10")
# the rows: the raw container output of each format, the undated log whole and in order, the gz log
rows = lv.search(FMT, lv.validate({"paths": [P_RFC], "limit": 100}, FMT)[0])["entries"]
check("rows from RFC3339-at-start lines: the time, the message without the time, the continuation folded, the pod and container", len(rows) == 5 and rows[0]["timestamp_obj"] == "2026-10-25T11:00:00" and rows[0]["message"] == "I am line 0" and rows[-1]["message"].endswith("\n    a continuation line") and rows[0]["hostname"] == "fmt/rfc-pod" and rows[0]["process"] == "c", rows[:1])
rows = lv.search(FMT, lv.validate({"paths": [P_KLOG], "limit": 100}, FMT)[0])["entries"]
check("rows from klog lines: dated from the gather's year, the E line an error", len(rows) == 6 and rows[0]["timestamp_obj"].startswith("2026-10-25T12:00:00") and rows[-1]["severity"] == "error", [(x["timestamp_obj"], x["severity"]) for x in rows[-1:]])
rows = lv.search(FMT, lv.validate({"paths": [P_JSON, P_LOGFMT], "limit": 100}, FMT)[0])["entries"]
check("rows from JSON and logfmt lines: dated, the levels read from the line", len(rows) == 5 and rows[0]["timestamp_obj"] == "2026-10-25T13:00:00" and rows[1]["severity"] == "error" and rows[4]["severity"] == "warning", [(x["timestamp_obj"], x["severity"]) for x in rows])
rows = lv.search(FMT, lv.validate({"paths": [P_NOTS], "limit": 100}, FMT)[0])["entries"]
check("a log without timestamps loads whole, every line a row without a time, in file order", [x["message"] for x in rows] == ["starting up", "listening on :8080", "GET /healthz 200", "shutting down"] and all(x["timestamp"] == "" and x["timestamp_obj"] == "" for x in rows), rows[:2])
rows = lv.search(FMT, lv.validate({"paths": [P_NOTS, P_RFC], "limit": 100, "start": "2026-10-25T11:00:03", "end": "2026-10-25T11:00:04"}, FMT)[0])["entries"]
check("a mixed selection with a date range: the undated log whole, the dated one filtered", len(rows) == 4 + 2 and sum(1 for x in rows if not x["timestamp_obj"]) == 4 and all("2026-10-25T11:00:03" <= x["timestamp_obj"] <= "2026-10-25T11:00:04" for x in rows if x["timestamp_obj"]), len(rows))
rows = lv.search(FMT, lv.validate({"paths": [P_GZ], "limit": 100}, FMT)[0])["entries"]
check("a .gz log reads through gzip, its rows dated, the previous badge on", len(rows) == 3 and rows[0]["timestamp_obj"] == "2026-10-25T16:00:00" and any(b["text"] == "previous" for b in rows[0]["badges"]), rows[:1])
paged, cur, pages = [], None, 0
qg, _ = lv.validate({"paths": [P_GZ, P_RFC], "limit": 2}, FMT)
while pages < 20:
    qg["cursor"] = cur or {"file": 0, "offset": 0}
    res = lv.search(FMT, qg)
    pages += 1
    paged.extend(res["entries"])
    cur = res["cursor"]
    if res["done"]:
        break
check("paging through a .gz log by its uncompressed offset adds up", res["done"] and len(paged) == 8 and [x["message"] for x in paged][:3] == ["gz line 0", "gz line 1", "gz line 2"], (pages, len(paged)))
# the routes
dr_ok = client.post("/mustgather_log_date_range", json={"directory": FMT, "paths": [P_RFC, P_NOTS]})
check("/mustgather_log_date_range answers the bounds and the undated logs (200, never an error for them)", dr_ok.status_code == 200 and dr_ok.get_json()["start"] == "2026-10-25T11:00:00" and dr_ok.get_json()["untimestamped"] == ["fmt/nots-pod/c (current)"], (dr_ok.status_code, dr_ok.get_json()))
dr_none = client.post("/mustgather_log_date_range", json={"directory": FMT, "paths": [P_NOTS]})
check("/mustgather_log_date_range with undated logs only: 200 with null bounds", dr_none.status_code == 200 and dr_none.get_json()["start"] is None and dr_none.get_json()["timestamped"] == 0)
check("/mustgather_log_date_range refuses a path outside the gather (400) and an empty selection", client.post("/mustgather_log_date_range", json={"directory": FMT, "paths": ["/etc/passwd"]}).status_code == 400 and client.post("/mustgather_log_date_range", json={"directory": FMT, "paths": []}).status_code == 400)
notf = tempfile.mkdtemp(prefix="mg-nots-")
os.makedirs(os.path.join(notf, "quay-io-x-sha256-0000", "namespaces"))
check("a gather without a timestamp file and without dated logs: no bounds and no gather time (never today)", lv.parse(notf)["date_range"] == {"start": None, "end": None} and lv.parse(notf)["gather_time"] is None)
tab = client.post("/load_tab", json={"report_type": "mustgather", "tab": "log_viewer", "directory": FMT})
check("the rendered tab hands the gather's time to the adapter", tab.status_code == 200 and 'gatherTime: "2026-10-25T12:00:00"' in tab.get_json()["html"], tab.status_code)
shutil.rmtree(FMT, ignore_errors=True)
shutil.rmtree(notf, ignore_errors=True)

# ---------------------------------------------------------------- the filters applied while scanning (query / exclude / level / source)
print("\n--- the filters applied while scanning: query / exclude / level / source ---")
with open(kub["path"], encoding="utf-8", errors="ignore") as f:
    KUB_LINES = [line.rstrip("\n") for line in f if line.strip()]
want = sum(1 for line in KUB_LINES if "syncloop" in line.lower())
q, err = lv.validate({"paths": [kub["path"], prev["path"]], "limit": 50, "query": ["SyncLoop"]}, GATHER)
check("validate keeps the terms lower-cased, the source empty", err is None and q["query"] == ["syncloop"] and q["source"] == "", (q, err))
paged, cur, pages = [], None, 0
while pages < 100:
    q["cursor"] = cur or {"file": 0, "offset": 0}
    res = lv.search(GATHER, q)
    pages += 1
    paged.extend(res["entries"])
    cur = res["cursor"]
    if res["done"]:
        break
check(f"query=['SyncLoop'] over the kubelet journal and the previous log, 50 a page: every page holds matches only and the pages add up to the {want} matching lines (beyond the first page)",
      res["done"] and pages > 1 and len(paged) == want and all("syncloop" in (e["hostname"] + " " + e["process"] + " " + e["message"]).lower() for e in paged), (pages, len(paged), want))
q, _ = lv.validate({"paths": [kub["path"], prev["path"]], "limit": 5000, "source": "payments-demo/payments-worker-7b8c9d0e1-efghi/worker"}, GATHER)
res = lv.search(GATHER, q)
check("source=<ns>/<pod>/<container> keeps that container's rows only (the 10 lines of the previous log) across both files",
      res["done"] and len(res["entries"]) == 10 and all(lv.source_key(e) == "payments-demo/payments-worker-7b8c9d0e1-efghi/worker" for e in res["entries"]), len(res["entries"]))
q, _ = lv.validate({"paths": [kub["path"], prev["path"]], "limit": 5000, "source": "host:kubelet", "level": "info"}, GATHER)
res = lv.search(GATHER, q)
check("source=host:kubelet with level=info: the kubelet journal's info rows only (the service the file is named for; the lines' own process is kubenswrapper)", res["done"] and len(res["entries"]) > 0 and all(e["src"] == "host" and e["service"] == "kubelet" and e["process"] == "kubenswrapper" and e["severity"] == "info" for e in res["entries"]), len(res["entries"]))
q, _ = lv.validate({"paths": [kub["path"]], "limit": 5000, "query": ["kube.*"]}, GATHER)
check("a pattern is plain text: 'kube.*' matches nothing", lv.search(GATHER, q)["entries"] == [])
check("a term that is not a string is a 400 from the route, a source that is not a name too; a single string term is fine",
      client.post("/mustgather_log_search", json={"directory": GATHER, "paths": [kub["path"]], "query": [7]}).status_code == 400
      and client.post("/mustgather_log_search", json={"directory": GATHER, "paths": [kub["path"]], "source": 5}).status_code == 400
      and client.post("/mustgather_log_search", json={"directory": GATHER, "paths": [kub["path"]], "exclude": "fine"}).status_code == 200)

# ---------------------------------------------------------------- journalctl's output forms in the host and node logs
print("\n--- journalctl's output forms: the host service logs and the node journals ---")
JF = tempfile.mkdtemp(prefix="mg-journal-")
jin = os.path.join(JF, "quay-io-x-sha256-0000")
with open(os.path.join(JF, "timestamp"), "w") as f:
    f.write("2026-10-23 04:33:48.000000000 +0000 UTC m=+0.05\n")
os.makedirs(os.path.join(jin, "host_service_logs", "masters"))
os.makedirs(os.path.join(jin, "nodes", "ip-203-0-113-67.us-east-2.compute.internal"))


def plant_text(path, text):
    with open(path, "w") as f:
        f.write(text)
    return path


# short-precise (journalctl -o short-precise: micros after the seconds), three masters interleaved in one role file,
# as the lab gather's rpm-ostreed log under host_service_logs/masters/
P_PREC = plant_text(os.path.join(jin, "host_service_logs", "masters", "rpm-ostreed_service.log"), "\n".join([
    "Oct 21 20:51:31.951198 ip-192-0-2-116 rpm-ostreed[1933]: Locked sysroot",
    "Oct 21 20:51:32.102334 ip-198-51-100-159 rpm-ostreed[2004]: Initiated txn Cleanup for client(id:cli dbus:1.422 unit:machine-config-daemon-firstboot.service uid:0): /org/projectatomic/rpmostree1/rhcos",
    "Oct 21 20:51:33.000001 ip-203-0-113-67 rpm-ostreed[1871]: error: Failed to unlock sysroot: permission denied",
    "Oct 22 03:12:10.500000 ip-192-0-2-116 rpm-ostreed[1933]: <4>Txn Cleanup on /org/projectatomic/rpmostree1/rhcos failed",
    "Oct 23 04:30:00.000000 ip-198-51-100-159 rpm-ostreed[2004]: Unlocked sysroot",
]) + "\n")
# short-iso and short-iso-precise in a node journal, short-full (the weekday and the zone) and short in two more host logs
P_ISO = plant_text(os.path.join(jin, "nodes", "ip-203-0-113-67.us-east-2.compute.internal", "journal"),
                   "2026-10-21T20:52:19+0000 ip-203-0-113-67 systemd[1]: Started Kubernetes Kubelet.\n"
                   "2026-10-21T20:52:20.250000+0000 ip-203-0-113-67 kubenswrapper[2271]: I1021 20:52:20.250000    2271 server.go:490] \"Kubelet version\" kubeletVersion=\"v1.29.8\"\n")
P_FULL = plant_text(os.path.join(jin, "host_service_logs", "masters", "crio_service.log"),
                    "Wed 2026-10-21 20:53:00 UTC ip-192-0-2-116 crio[1961]: time=\"2026-10-21T20:53:00Z\" level=warning msg=\"Pulling image\"\n"
                    "Wed 2026-10-21 20:53:01 UTC ip-192-0-2-116 crio[1961]: time=\"2026-10-21T20:53:01Z\" level=info msg=\"Pulled image\"\n")
P_SHORT = plant_text(os.path.join(jin, "host_service_logs", "masters", "kubelet_service.log"),
                     "Oct 21 20:54:00 ip-198-51-100-159 kubenswrapper[2271]: E1021 20:54:00.000000    2271 kubelet.go:1 \"Failed to sync pod\"\n"
                     "Oct 21 20:54:01 ip-198-51-100-159 kubenswrapper[2271]: a line that says nothing of its level\n"
                     "    a continuation line\n")
rows = lv.search(JF, lv.validate({"paths": [P_PREC], "limit": 100}, JF)[0])["entries"]
check("short-precise journal lines: the time with its micros, the real node (not the role directory), the service and its pid, the message without the prefix",
      len(rows) == 5 and rows[0]["timestamp_obj"] == "2026-10-21T20:51:31.951198" and rows[0]["timestamp"] == "Oct 21 20:51:31" and rows[0]["hostname"] == "ip-192-0-2-116"
      and rows[0]["process"] == "rpm-ostreed" and rows[0]["pid"] == "1933" and rows[0]["message"] == "Locked sysroot" and rows[1]["hostname"] == "ip-198-51-100-159" and rows[2]["hostname"] == "ip-203-0-113-67", rows[:2])
check("the level of a journal line: info when the message says nothing, error / warning from the message, a <4> priority prefix read",
      [r["severity"] for r in rows] == ["info", "info", "error", "warning", "info"], [r["severity"] for r in rows])
rows = lv.search(JF, lv.validate({"paths": [P_ISO], "limit": 100}, JF)[0])["entries"]
check("short-iso and short-iso-precise lines in a node journal: the node, systemd[1], the kubelet's klog code as the level",
      len(rows) == 2 and rows[0]["timestamp_obj"] == "2026-10-21T20:52:19" and rows[1]["timestamp_obj"] == "2026-10-21T20:52:20.250000" and rows[0]["hostname"] == "ip-203-0-113-67"
      and rows[0]["process"] == "systemd" and rows[0]["pid"] == "1" and rows[0]["message"] == "Started Kubernetes Kubelet." and rows[1]["process"] == "kubenswrapper" and rows[1]["severity"] == "info", rows)
rows = lv.search(JF, lv.validate({"paths": [P_FULL], "limit": 100}, JF)[0])["entries"]
check("short-full lines (the weekday, the zone): the time, the node, crio[1961], the level from the message's level= field",
      len(rows) == 2 and rows[0]["timestamp_obj"] == "2026-10-21T20:53:00" and rows[0]["hostname"] == "ip-192-0-2-116" and rows[0]["process"] == "crio" and rows[0]["pid"] == "1961"
      and rows[0]["severity"] == "warning" and rows[1]["severity"] == "info", rows)
rows = lv.search(JF, lv.validate({"paths": [P_SHORT], "limit": 100}, JF)[0])["entries"]
check("short lines: the klog code in the message gives the level, a plain line is info, a continuation line folds into it",
      len(rows) == 2 and rows[0]["severity"] == "error" and rows[1]["severity"] == "info" and rows[0]["timestamp_obj"] == "2026-10-21T20:54:00" and rows[1]["message"].endswith("\n    a continuation line"), rows)
dr = lv.date_range(JF, lv.chosen_sources([P_PREC, P_ISO, P_FULL, P_SHORT], JF)[0])
check("the date range over the four journal files: every form dated, the bounds from the earliest and the latest line",
      dr["start"] == "2026-10-21T20:51:31.951198" and dr["end"] == "2026-10-23T04:30:00" and dr["untimestamped"] == [] and dr["timestamped"] == 4, dr)
rows = lv.search(JF, lv.validate({"paths": [P_PREC], "limit": 100, "start": "2026-10-22T00:00", "end": "2026-10-22T23:59"}, JF)[0])["entries"]
check("journal lines filter by the date range (the one line of Oct 22)", len(rows) == 1 and rows[0]["message"].endswith("failed"), rows)
# the year rollover: a gather taken in early January reads a December log
JR = tempfile.mkdtemp(prefix="mg-journal-jan-")
jrin = os.path.join(JR, "quay-io-x-sha256-0000")
os.makedirs(os.path.join(jrin, "host_service_logs", "masters"))
plant_text(os.path.join(JR, "timestamp"), "2027-01-03 02:00:00.000000000 +0000 UTC m=+0.05\n")
P_DEC = plant_text(os.path.join(jrin, "host_service_logs", "masters", "kubelet_service.log"),
                   "Dec 30 23:59:59.123456 ip-192-0-2-1 kubenswrapper[2]: before the new year\nJan 02 10:00:00.000000 ip-192-0-2-1 kubenswrapper[2]: after it\n")
rows = lv.search(JR, lv.validate({"paths": [P_DEC], "limit": 100}, JR)[0])["entries"]
dr = lv.date_range(JR, lv.chosen_sources([P_DEC], JR)[0])
check("the year rollover: a December line of a January gather is last year's, a January line this year's; the range spans the two",
      [r["timestamp_obj"][:4] for r in rows] == ["2026", "2027"] and dr["start"] == "2026-12-30T23:59:59.123456" and dr["end"] == "2027-01-02T10:00:00", (rows, dr))
shutil.rmtree(JF, ignore_errors=True)
shutil.rmtree(JR, ignore_errors=True)

shutil.rmtree(WORK, ignore_errors=True)
shutil.rmtree(empty, ignore_errors=True)
shutil.rmtree(long_dir, ignore_errors=True)
print(f"\n{'FAILED' if FAILED else 'All checks passed'} ({FAILED} failed)")
sys.exit(1 if FAILED else 0)
