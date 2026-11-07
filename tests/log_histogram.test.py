#!/usr/bin/env python3
"""Log Collection > Histogram: the engine (backend/parsers/log_histogram.py), the adapters
(parsers/sosreport/log_histogram.py, parsers/mustgather/log_histogram.py), the shared time helpers
(parsers/logtime.py) and the routes (/log_histogram_stream, /log_histogram_cancel, /get_tab_data, /load_tab), over
SYNTHETIC logs with planted anomalies (tests/fixtures/diagnostics-mock/mock_log_anomalies.py).

  - the normaliser: numbers, documentation addresses, times, hex ids and durations become <*>; words stay;
  - the planted journal: each planted anomaly found, of its kind, at its time, with its text; the flat control:
    none; the ranking puts them first;
  - incident folding (a kernel trace is one row, headed by its error line); no duplicate burst for a new message;
  - a template is judged within its sources' span (a short previous log has no "burst" against the day);
  - the window limits the analysis; byte ranges never lose or double a line; parallel == serial, whatever the
    chunking; .gz logs; the per-item template cap; the cross-link query (its grammar and its length budget);
  - the adapters: the sosreport's system journal and the must-gather's budgeted default selection (previous logs
    first), paths outside the report or not listed refused; the must-gather links name ns/pod/container;
  - the routes: the event stream (progress, then the result), the cache, the validation, the cancel, the AI
    context exclusion, both tabs render (the controls, the escaping), the registry and the frame's allow-lists;
  - the moved helpers stay importable from where they were (audit_logs.bucket_plan, the must-gather viewer's
    _timestamp_of);
  - a performance guard: the 50k-line journal of generate.py --large analysed in a few seconds.
Run with the backend venv's Python: backend/venv/bin/python tests/log_histogram.test.py
"""
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.join(HERE, "fixtures", "diagnostics-mock"))

import contextlib  # noqa: E402
import io  # noqa: E402

from flask import Flask  # noqa: E402
import log_viewer as routes  # noqa: E402
import mock_log_anomalies as mla  # noqa: E402
from parsers import log_histogram as eng  # noqa: E402
from parsers import logtime  # noqa: E402
from parsers.sosreport import log_histogram as sosh  # noqa: E402
from parsers.mustgather import log_histogram as mgh  # noqa: E402

FAILED = 0


def check(name, ok, info=""):
    global FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {name}" + (f" | {str(info)[:700]}" if not ok and info else ""))
    if not ok:
        FAILED += 1


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


WORK = tempfile.mkdtemp(prefix="log-histogram-test-")


def analyse_report(root, workers=1, start=None, end=None):
    page = quiet(sosh.parse, root)
    sel = [s["path"] for s in page["available_logs"] if s["checked"]]
    srcs, err = quiet(sosh.sources_for, root, sel)
    assert not err, err
    return eng.analyse(eng.plan_items(srcs, start, end, workers=workers), start, end, workers=workers)


def by_kind(res, kind, text=""):
    return [a for a in res["anomalies"] if a["kind"] == kind and text in (a.get("template") or "") + a["title"]]


# ---------------------------------------------------------------- the normaliser
n = eng.normalise
check("the normaliser: a documentation address with its port, a time, a duration, a pid become <*>; words stay", n("Accepted publickey for core from 192.0.2.17 port 40022 ssh2") == "Accepted publickey for core from <*> port <*> ssh<*>" and n("took 1500ms at 10:00:01.123") == "took <*>ms at <*>" and n("child exited pid=4321") == "child exited pid=<*>", n("Accepted publickey for core from 192.0.2.17 port 40022 ssh2"))
check("the normaliser: hex ids, 0x values and a UUID that hold a digit become <*>; a host name keeps its dots; hex-letter words stay", n("container 3fa2b9c0d1e2f3a4b5c6d7e8f9a0b1c2 started") == "container <*> started" and n("id 123e4567-e89b-12d3-a456-426614174000 done") == "id <*> done" and n("at daddr 0x1f len 8") == "at daddr <*> len <*>" and n("nfs: server nfs01.example.test not responding") == "nfs: server nfs<*>.example.test not responding" and n("deadbeef cafe accede") == "deadbeef cafe accede", (n("container 3fa2b9c0d1e2f3a4b5c6d7e8f9a0b1c2 started"), n("id 123e4567-e89b-12d3-a456-426614174000 done"), n("at daddr 0x1f len 8")))
check("the normaliser leaves a message without digits as it is", n("Started Session of User core.") == "Started Session of User core.")

# ---------------------------------------------------------------- the planted journal
sos, truth = mla.planted_sosreport(WORK)
flat, _ = mla.planted_sosreport(WORK, flat=True)
res = analyse_report(sos)
kinds = [a["kind"] for a in res["anomalies"]]
for p in truth:
    # a spike (volume / errors) is over all lines: no template; the others carry the planted text
    has_text = p["text"] and p["kind"] not in ("volume", "errors")
    hits = [a for a in res["anomalies"] if a["kind"] == p["kind"] and a["from"][11:16] <= p["at"] < a["to"][11:16].replace("00:00", "24:00")
            and (not has_text or p["text"] in (a.get("template") or "") + (a.get("sample") or ""))]
    check(f"planted {p['kind']} at {p['at']} ({p['text'] or 'all lines'}) is found", len(hits) >= 1, [(a["kind"], a["when"], (a.get("template") or "")[:50]) for a in res["anomalies"]])
check("the planted anomalies are the top of the ranking (the first eight rows are all planted)", len(res["anomalies"]) <= 9 and all(k in ("errors", "volume", "burst", "new", "stopped", "rare") for k in kinds[:8]), kinds)
res_flat = analyse_report(flat)
check("the flat control (the same routine traffic, nothing planted): no anomaly, a 'good' finding", res_flat["anomalies"] == [] and any(f["severity"] == "good" for f in res_flat["findings"]), [(a["kind"], a["title"]) for a in res_flat["anomalies"]][:5])
check("no duplicate burst for a new message: the XFS errors are one 'new' row, not also a burst", len(by_kind(res, "new", "XFS")) == 1 and not by_kind(res, "burst", "XFS"), [(a["kind"], a["title"][:60]) for a in res["anomalies"]])
bursts = by_kind(res, "burst", "nfs")
check("the nfs burst: its window, its peak against its usual rate, its score", bursts and bursts[0]["from"] == "2026-10-12T14:00" and bursts[0]["to"] == "2026-10-12T14:20" and bursts[0]["peak"] >= 400 and bursts[0]["baseline"] < 5 and bursts[0]["score"] >= 50, bursts[:1])
st = res["stats"]
check("the stats: every line read, the timestamped ones counted, the header line without a time", st["lines"] == sum(1 for _ in open(os.path.join(sos, "sos_commands", "logs", "journalctl_--no-pager"))) and st["matched"] == st["lines"] - 1 and st["undated"] == 1, st)
tl = res["timeline"]
check("the timeline: 10-minute buckets over the day, the counts by level adding up, bands for the top anomalies", tl["step_seconds"] == 600 and len([b for b in tl["buckets"] if not b["gap"]]) == 144 and sum(b["n"] for b in tl["buckets"] if not b["gap"]) == st["matched"] and all(b["n"] == sum(b[s] for s in eng.SEVERITIES) for b in tl["buckets"] if not b["gap"]) and 1 <= len(tl["bands"]) <= eng.LIMITS["max_bands"], {k: tl[k] for k in ("step_seconds", "bands")})
fs = res["findings"]
links = [f["link"] for f in fs if f.get("link")]
check("the Findings: a summary line and the top anomalies (at most 5), each linking to the Log Viewer with its query", 2 <= len(fs) <= 6 and len(links) == min(5, len(res["anomalies"])) and all(lk["tab"] == "log_collection" and lk["sub_tab"] == "log_viewer" and lk["query"].startswith("sources=") for lk in links), fs)

# ---------------------------------------------------------------- incidents, spans
inc = os.path.join(WORK, "incident")
lines = []
for m in range(0, 600):
    lines.append(f"Oct 12 {m // 60:02d}:{m % 60:02d}:10 node-01.example.test sshd[{1000 + m}]: Accepted publickey for core from 192.0.2.{m % 250 + 1} port {40000 + m} ssh2")
    lines.append(f"Oct 12 {m // 60:02d}:{m % 60:02d}:20 node-01.example.test kernel: IPv4: martian source 198.51.100.{m % 200 + 1} from 203.0.113.{m % 100 + 1}, on dev eth0")
    if m == 400:
        lines += ["Oct 12 06:40:30 node-01.example.test kernel: CPU: 3 PID: 4242 Comm: example-worker Tainted: G OE 5.14.0-1.el9.x86_64 #1",
                  "Oct 12 06:40:30 node-01.example.test kernel: Hardware name: Example Systems ExampleServer X1/EX-MB-1, BIOS 1.2.3 01/01/2026",
                  "Oct 12 06:40:30 node-01.example.test kernel: Call Trace:",
                  "Oct 12 06:40:30 node-01.example.test kernel: Out of memory: Killed process 4242 (example-worker) total-vm:812345kB, anon-rss:654321kB",
                  "Oct 12 06:40:30 node-01.example.test kernel: oom_reaper: reaped process 4242 (example-worker), now anon-rss:0kB"]
os.makedirs(os.path.join(inc, "sos_commands", "logs"), exist_ok=True)
with open(os.path.join(inc, "sos_commands", "logs", "journalctl_--no-pager"), "w") as f:
    f.write("\n".join(lines) + "\n")
with open(os.path.join(inc, "date"), "w") as f:
    f.write("Mon Oct 12 23:59:59 UTC 2026\n")
ri = analyse_report(inc)
incs = [a for a in ri["anomalies"] if a["kind"] == "incident"]
check("a kernel report of five new lines in one minute is ONE incident with five members, not five rows", len(incs) == 1 and len(incs[0]["members"]) == 5 and not [a for a in ri["anomalies"] if a["kind"] in ("new", "rare") and a["group"] == "kernel" and a["from"][11:13] == "06"], [(a["kind"], a["title"][:70]) for a in ri["anomalies"]])
check("... headed by the line that names what happened (Out of memory), not its context ('CPU: ...', 'Call Trace:')", incs and "Out of memory" in incs[0]["template"] and incs[0]["title"].startswith("Incident: Out of memory"), incs[:1])
check("... while a one-off new line alone is no anomaly (the 'oom_reaper' line folds in, no row of its own)", not [a for a in ri["anomalies"] if a["kind"] != "incident"], [(a["kind"], a["title"][:60]) for a in ri["anomalies"]])
mg, mtruth = mla.planted_mustgather(WORK)
page = quiet(mgh.parse, mg)
srcs, err = mgh.sources_for(mg, [s["path"] for s in page["available_logs"]])
rm = eng.analyse(eng.plan_items(srcs, workers=1), workers=1)
prev = [a for a in rm["anomalies"] if "(previous)" in (a.get("group") or "")]
check("a template is judged within its sources' span: the 40-second previous log has no burst against the day; its panic is a rare critical", [a["kind"] for a in prev] == ["rare"] and prev[0]["severity"] == "critical" and "panic" in prev[0]["template"], [(a["kind"], a["group"], a["title"][:60]) for a in rm["anomalies"]])
for p in mtruth:
    hits = [a for a in rm["anomalies"] if a["kind"] in ("new", "burst", "incident") and p["text"] in (a.get("template") or "") + (a.get("sample") or "") and a["group"] == p["source"] and a["from"][11:16] <= p["at"]]
    check(f"must-gather: the planted {p['text']} in {p['source']} from {p['at']} is found", len(hits) >= 1, [(a["kind"], a["group"], a["title"][:60]) for a in rm["anomalies"]])
check("must-gather links name the container (ns/pod/container) and a minute window", any(a["link"].startswith("sources=demo-app%2Fapi-0%2Fapi&from=2026-10-12T09:00&to=") for a in rm["anomalies"]), [a["link"][:90] for a in rm["anomalies"]])

# ---------------------------------------------------------------- the window, ranges, parallel, gz, caps
from datetime import datetime  # noqa: E402
rw = analyse_report(sos, start=datetime(2026, 10, 12, 13, 0), end=datetime(2026, 10, 12, 15, 0))
check("the window limits the analysis: only its lines, the rest counted as outside; the nfs burst is found in it", rw["stats"]["outside"] > 90000 and rw["stats"]["matched"] + rw["stats"]["outside"] == st["matched"] and [a["kind"] for a in rw["anomalies"]] == ["burst"] and rw["window"] == {"start": "2026-10-12T13:00", "end": "2026-10-12T15:00"}, (rw["stats"], [a["title"] for a in rw["anomalies"]]))
saved = dict(eng.LIMITS)
try:
    eng.LIMITS["min_chunk_bytes"] = 300_000
    eng.LIMITS["chunk_bytes"] = 1_000_000
    page = quiet(sosh.parse, sos)
    srcs, _ = quiet(sosh.sources_for, sos, [s["path"] for s in page["available_logs"] if s["checked"]])
    items = eng.plan_items(srcs, workers=8)
    rp = eng.analyse(items, workers=3)
    rs = eng.analyse(eng.plan_items(srcs, workers=1), workers=1)
finally:
    eng.LIMITS.clear()
    eng.LIMITS.update(saved)
strip = lambda r: json.dumps({k: v for k, v in r.items() if k not in ("stats", "findings")}, sort_keys=True)  # noqa: E731
check(f"byte ranges ({len(items)} of them) never lose or double a line: the same line count as one pass", len(items) >= 10 and rp["stats"]["lines"] == rs["stats"]["lines"] == st["lines"], (len(items), rp["stats"]["lines"], rs["stats"]["lines"]))
check("parallel over byte ranges == serial in one pass: the same templates, timeline, anomalies and links", strip(rp) == strip(rs) and rp["stats"]["run"]["mode"] == "parallel", rp["stats"]["run"])
gz = os.path.join(WORK, "gz")
shutil.copytree(sos, gz)
src = os.path.join(gz, "sos_commands", "logs", "journalctl_--no-pager")
gzsrc = [{"path": src + ".gz", "size": 0, "kind": "auto", "prefix": "", "label": "journal.gz", "link": "journal.gz", "year": 2026, "ref": None}]
with open(src, "rb") as fi, gzip.open(src + ".gz", "wb") as fo:
    fo.write(fi.read())
gzsrc[0]["size"] = os.path.getsize(src + ".gz")
rg = eng.analyse(eng.plan_items(gzsrc, workers=1), workers=1)
check("a .gz log is read through gzip, whole (never split), with the same counts", len(eng.plan_items(gzsrc, workers=8)) == 1 and rg["stats"]["matched"] == st["matched"] and len(rg["anomalies"]) == len(res["anomalies"]), rg["stats"])
saved = dict(eng.LIMITS)
try:
    eng.LIMITS["max_templates_per_item"] = 5
    rc = eng.analyse(eng.plan_items(srcs, workers=1), workers=1)
finally:
    eng.LIMITS.clear()
    eng.LIMITS.update(saved)
check("past the per-item template cap the rest counts in one '(template limit)' row per source; the totals stay", rc["stats"]["overflow"] > 0 and rc["stats"]["matched"] == st["matched"] and any("template limit" in t["template"] for t in rc["templates"]), rc["stats"])
q = eng.viewer_query({"journalctl (system)"}, eng._minute(datetime(2026, 10, 12, 14, 0)), eng._minute(datetime(2026, 10, 12, 14, 20)), "not responding, still")
check("the cross-link query: sources, from, to (ISO minutes), q last, URI-encoded", q == "sources=journalctl%20%28system%29&from=2026-10-12T14:00&to=2026-10-12T14:20&q=not%20responding%2C%20still", q)
many = {f"payments-demo/payments-{i}/gateway-container-with-a-long-name" for i in range(200)}
q2 = eng.viewer_query(many, 0, 10, "x" * 50)
check("a query naming many sources stays within the frame bridge's budget (it names as many as fit)", len(q2) <= eng.LIMITS["max_link_chars"] and q2.count("%2C") >= 5 and q2.endswith("&q=" + "x" * 50), len(q2))
check("the literal piece of a template for the search: the longest between the <*>, no comma", eng._fragment("nfs: server nfs<*>.example.test not responding, still trying") == ".example.test not responding" and eng._fragment("<*> <*>") == "", eng._fragment("nfs: server nfs<*>.example.test not responding, still trying"))

# ---------------------------------------------------------------- the two lines that used to stop a Log Viewer read
# A line with a bare CR and the word 'ſegfault' (classify_severity raised a KeyError on it: the patterns fold the long
# s, str.lower() does not) - the analysis reads every line and classifies the long-s line as an error.
odd = os.path.join(WORK, "odd.log")
with open(odd, "wb") as f:
    for k in range(300):
        f.write(f"Oct 12 10:{k // 60:02d}:{k % 60:02d} node-01.example.test app[1]: routine {k}\n".encode())
        if k == 100:
            f.write(b"Oct 12 10:01:40 node-01.example.test kernel: \xc5\xbfegfault at 0 ip 0 sp 0 error 4\n")
            f.write(b"Oct 12 10:01:41 node-01.example.test app[1]: a bare CR\rin the middle\n")
osrc = [{"path": odd, "size": os.path.getsize(odd), "kind": "auto", "prefix": "", "label": "odd", "link": "odd", "year": 2026, "ref": None}]
for w in (1, 3):
    ro = eng.analyse(eng.plan_items(osrc, workers=w), workers=w)
    longs = [t for t in ro["templates"] if "\u017fegfault" in t["template"]]
    check(f"a log with a 'ſegfault' line and a bare CR is analysed whole ({w} worker{'s' if w > 1 else ''}): every dated line counted, the long-s line an error template", ro["stats"]["matched"] == 302 and longs and longs[0]["severity"] == "error", (ro["stats"], [(t["template"], t["severity"]) for t in longs]))

# ---------------------------------------------------------------- the adapters
page = quiet(sosh.parse, sos)
check("sosreport: the Log Viewer's listing, the system journal selected, the before-analysis finding", [s["name"] for s in page["available_logs"] if s["checked"]] == ["journalctl (system)"] and page["date_range"]["start"].startswith("2026-10-12") and "selected" in page["findings"][0]["title"], page["findings"])
check("sosreport: a path outside the report, or a file it does not list, is refused", quiet(sosh.sources_for, sos, ["/etc/passwd"])[1] == "none of the selected logs is one this report lists" and quiet(sosh.sources_for, sos, [os.path.join(sos, "date")])[1] == "none of the selected logs is one this report lists" and quiet(sosh.sources_for, sos, [])[1] == "no log selected")
big_mg, _ = mla.planted_mustgather(WORK, pods=40, lines_per_pod=12000, name="must-gather.local.3333333333")
bpage = quiet(mgh.parse, big_mg)
chosen = [s for s in bpage["available_logs"] if s["checked"]]
check("must-gather: the default selection stays within the budget (~20 MB), the previous log first, more available", sum(s["size"] for s in chosen) <= mgh.DEFAULT_BUDGET and len(chosen) < len(bpage["available_logs"]) and chosen and any(s["kind"] == "previous" for s in chosen) and bpage["default_bytes"] == sum(s["size"] for s in chosen), (len(chosen), len(bpage["available_logs"]), bpage["default_bytes"]))
first = mgh.default_selection(bpage["available_logs"])[0][0]
check("... the previous log is the first chosen", first.endswith("previous.log"), first)
check("must-gather: a path outside the gather is refused", mgh.sources_for(big_mg, ["/etc/passwd"])[1] == "none of the selected logs is one this must-gather lists")

# ---------------------------------------------------------------- the moved helpers
from parsers.mustgather import audit_logs, log_viewer as mglv  # noqa: E402
check("the moved helpers stay where they were: audit_logs.bucket_plan / step_text / human_duration, the must-gather viewer's _timestamp_of and line patterns", audit_logs.bucket_plan is logtime.bucket_plan and audit_logs.step_text(300) == "5 min" and audit_logs.human_duration(90) == "1 h 30 min" and mglv._timestamp_of("2026-10-12T10:00:00Z stdout F x", 2026) == datetime(2026, 10, 12, 10, 0) and mglv.CONTAINER_LINE is logtime.CONTAINER_LINE)

# ---------------------------------------------------------------- the routes
app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
app.register_blueprint(routes.log_viewer)
app.secret_key = "log-histogram-test"
c = app.test_client()
journal = os.path.join(sos, "sos_commands", "logs", "journalctl_--no-pager")


def events(r):
    return [json.loads(b[6:]) for b in r.get_data(as_text=True).split("\n\n") if b.startswith("data: ")]


r = quiet(c.post, "/log_histogram_stream", json={"directory": sos, "report_type": "sosreport", "paths": [journal]})
ev = events(r)
check("the stream: text/event-stream, progress events, then the result", r.status_code == 200 and r.mimetype == "text/event-stream" and all("progress" in e for e in ev[:-1]) and len(ev) >= 2 and "result" in ev[-1] and ev[-1]["result"]["stats"]["matched"] == st["matched"], [list(e) for e in ev])
r2 = quiet(c.post, "/log_histogram_stream", json={"directory": sos, "report_type": "sosreport", "paths": [journal]})
check("the same selection and window again: from the cache", events(r2)[-1]["result"].get("cached") is True)
bad = [quiet(c.post, "/log_histogram_stream", json=b) for b in (
    {"directory": sos, "report_type": "sosreport", "paths": ["/etc/passwd"]},
    {"directory": sos, "report_type": "nope", "paths": [journal]},
    {"directory": sos, "report_type": "sosreport", "paths": [journal], "start": "yesterday"},
    {"directory": sos, "report_type": "sosreport", "paths": [journal], "start": "2026-10-12T10:00", "end": "2026-10-12T09:00"},
    {"directory": os.path.join(WORK, "missing"), "report_type": "sosreport", "paths": [journal]})]
check("the validation: a path outside, an unknown report type, a bad date, an end before the start, a missing directory are 400s", [b.status_code for b in bad] == [400, 400, 400, 400, 400], [(b.status_code, b.get_json()) for b in bad])
check("/log_histogram_cancel answers ok; a missing directory is a 400", c.post("/log_histogram_cancel", json={"directory": sos}).get_json() == {"ok": True} and c.post("/log_histogram_cancel", json={"directory": os.path.join(WORK, "missing")}).status_code == 400)
ai = c.post("/get_tab_data", json={"directory": sos, "report_type": "sosreport", "tab": "log_histogram"}).get_json()
ai_mg = c.post("/get_tab_data", json={"directory": mg, "report_type": "mustgather", "tab": "log_collection", "sub_tab": "log_histogram"}).get_json()
check("/get_tab_data never hands the Histogram to the AI context (both report types, by its id or under its group)", ai["data"] is None and ai_mg["data"] is None and "AI context" in ai["excluded"])
for rt, d in (("sosreport", sos), ("mustgather", mg)):
    t = quiet(c.post, "/load_tab", json={"directory": d, "report_type": rt, "tab": "log_histogram"})
    html = (t.get_json() or {}).get("html", "")
    check(f"/load_tab renders the {rt} Histogram: the Log Viewer's date range and picker, Get Date Range, Analyze, the hidden results, the mount", t.status_code == 200 and 'id="date-slider-start"' in html and 'id="log-file-dropdown-btn"' in html and 'id="get-range-btn"' in html and 'id="lh-analyze"' in html and 'id="lh-results" hidden' in html and f"reportType: '{rt}'" in html, (t.status_code, html[:200]))
evil = os.path.join(WORK, "evil")
os.makedirs(os.path.join(evil, "sos_commands", "logs"))
with open(os.path.join(evil, "date"), "w") as f:   # a report root holds more than one entry (one alone is a wrapper the parser unwraps)
    f.write("Mon Oct 12 23:59:59 UTC 2026\n")
with open(os.path.join(evil, "sos_commands", "logs", "journalctl_--no-pager<img src=x onerror=alert(1)>"), "w") as f:
    f.write("Oct 12 10:00:00 node-01.example.test kernel: hello\n")
eh = quiet(c.post, "/load_tab", json={"directory": evil, "report_type": "sosreport", "tab": "log_histogram"}).get_json().get("html", "")
check("a log name holding HTML is escaped in the page", "<img src=x" not in eh and "&lt;img src=x onerror=alert(1)&gt;" in eh, eh[eh.find("journalctl"):eh.find("journalctl") + 200])
reg = routes.PARSERS
check("the registry: Log Collection holds the Log Viewer then the Histogram, for both report types, with the same label and icon", [list(reg[t]["log_collection"]["sub_tabs"]) for t in ("sosreport", "mustgather")] == [["log_viewer", "log_histogram"]] * 2 and reg["sosreport"]["log_collection"]["sub_tabs"]["log_histogram"]["label"] == reg["mustgather"]["log_collection"]["sub_tabs"]["log_histogram"]["label"] == "Histogram" and routes._resolve_tab("mustgather", "log_histogram", None) == ("log_collection", "log_histogram"))
page_jsx = open(os.path.join(REPO, "src", "components", "DiagnosticsPage.jsx"), encoding="utf-8").read()
check("the frame allow-lists /log_histogram_stream (a stream) and /log_histogram_cancel", "'/log_histogram_stream'" in page_jsx.split("DIAGNOSTICS_API_STREAM_ALLOWLIST = new Set(")[1].split(")")[0] and "'/log_histogram_cancel'" in page_jsx.split("DIAGNOSTICS_API_ALLOWLIST = new Set(")[1].split(")")[0])

# ---------------------------------------------------------------- performance guard
gen = subprocess.run([sys.executable, os.path.join(HERE, "fixtures", "diagnostics-mock", "generate.py"), "--out", os.path.join(WORK, "mock"), "--no-archives", "--large"], capture_output=True, text=True)
large = os.path.join(WORK, "mock", "sosreport-web-02-2026-10-13-bigjrnl")
if gen.returncode == 0 and os.path.isdir(large):
    t0 = time.monotonic()
    rl = analyse_report(large, workers=1)
    took = time.monotonic() - t0
    print(f"  (the --large journal: {rl['stats']['lines']:,} lines analysed serially in {took:.2f} s, {rl['stats']['templates']} templates, {len(rl['anomalies'])} anomalies)")
    check("performance guard: the 50k-line --large journal is analysed serially in under 5 s (about 0.6 s on a laptop)", took < 5 and rl["stats"]["lines"] > 50000, took)
    check("... and its planted incidents surface (the OOM trace folded, the failed backup)", any(a["kind"] == "incident" for a in rl["anomalies"]) and any("backup" in (a.get("template") or "") for a in rl["anomalies"]), [(a["kind"], a["title"][:60]) for a in rl["anomalies"]])
else:
    check("the --large mock generates", False, gen.stderr[-300:])

shutil.rmtree(WORK, ignore_errors=True)
print(f"\n{'FAIL' if FAILED else 'OK'}: {FAILED} failed")
sys.exit(1 if FAILED else 0)
