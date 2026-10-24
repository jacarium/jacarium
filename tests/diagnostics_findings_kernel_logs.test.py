#!/usr/bin/env python3
"""
The Kernel / Log Collection / Blame group's Findings (Phase 2, group 4 of the
diagnostics review), on the mock sosreport (its planted OOM kills, hung tasks
and stack traces, its timed-out plugin) and synthetic directories:

 1. Kernel: the group page's parser counts the three kinds from the shared
    scan, each finding links to its tab, the first / last incident is set;
    a report without a kernel log says so.
 2. Log Collection: the group page flags a missing journal, unreadable
    files and files over 1 GiB; the mock's listing is "good".
 3. Blame: the mock's timed-out plugin is a warning naming it; the failed
    commands are informational.
 4. Processes: the D-state finding hands the task's name to the hung-task
    page's search (query).
 5. The three pages render the strip (and the Kernel page its three cards).

Needs the backend venv (Flask); run-all.sh picks it up as a .test.py.
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BACKEND = os.path.join(REPO, "backend")
MOCK = os.path.join(HERE, "fixtures", "diagnostics-mock")
sys.path.insert(0, BACKEND)
sys.path.insert(0, MOCK)

from flask import Flask  # noqa: E402

import log_viewer as lv  # noqa: E402
import generate as mock_generate  # noqa: E402
from parsers.sosreport import blame, kernel, log_collection, processes  # noqa: E402

WORK = tempfile.mkdtemp(prefix="diag-findings4-")
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
    app.secret_key = "diagnostics-findings4-test"
    return app.test_client()


def titles(items):
    return [f["title"] for f in items]


def sev(items, s):
    return [f for f in items if f["severity"] == s]


def main():
    out = os.path.join(WORK, "mock")
    mock_generate.main(["--out", out, "--no-archives"])
    sos = os.path.join(out, mock_generate.SOS_NAME)

    # 1. Kernel -------------------------------------------------------------------
    r = kernel.parse(sos)
    f = r["findings"]
    cards = {c["key"]: c for c in r["kernel"]["cards"]}
    check("kernel: the group page counts the planted OOM kills, hung tasks and stack traces with their first / last", cards["oom"]["count"] >= 1 and cards["hung"]["count"] >= 1 and cards["traces"]["count"] >= 1 and all(c["first"] and c["last"] for c in cards.values()), repr(cards))
    check("kernel: OOM kills and hung tasks are bad, stack traces a warning, each linked to its tab, worst first",
          f[0]["severity"] == "bad" and {x["link"]["sub_tab"] for x in f if x.get("link")} >= {"kernel_oom_killer", "kernel_hung_task", "kernel_stack_traces"} and any(x["severity"] == "warn" and x["link"]["sub_tab"] == "kernel_stack_traces" for x in f), titles(f))
    bare = os.path.join(WORK, "bare")
    os.makedirs(os.path.join(bare, "sos_commands"), exist_ok=True)
    rb = kernel.parse(bare)
    check("kernel: a report without a kernel log says so (info) and shows empty cards", rb["findings"][0]["severity"] == "info" and all(c["count"] == 0 for c in rb["kernel"]["cards"]), titles(rb["findings"]))

    # 2. Log Collection ---------------------------------------------------------------
    f = log_collection.parse(sos)["findings"]
    check("log collection: the mock's listing (journal present, every file readable) is good", any(x["severity"] == "good" and "the journal captured" in x["title"] for x in f), titles(f))
    nj = os.path.join(WORK, "nojournal")
    write(nj, "var/log/messages", "Oct 12 09:31:55 host kernel: hello\n")
    os.makedirs(os.path.join(nj, "sos_commands"), exist_ok=True)
    os.symlink("/nonexistent/target", os.path.join(nj, "var/log/broken.log"))
    with open(os.path.join(nj, "var/log/huge.log"), "wb") as fh:
        fh.seek(1024 ** 3)
        fh.write(b"\0")
    f = log_collection.parse(nj)["findings"]
    check("log collection: no journal (info, linked to the Log Viewer), an unreadable file (warn), a file over 1 GiB (info)",
          any("No journal capture" == t for t in titles(sev(f, "info"))) and any("1 log file unreadable" == t for t in titles(sev(f, "warn"))) and any("1 log file over 1 GiB" == t for t in titles(sev(f, "info"))), titles(f))

    # 3. Blame ----------------------------------------------------------------------
    b = blame.parse(sos)
    f = b["findings"]
    check("blame: the mock's timed-out plugin is a warning that names it", b["blame"]["summary"]["timeouts"] >= 1 and any(x["severity"] == "warn" and "hit the timeout" in x["title"] and b["blame"]["summary"]["timeout_names"][0] in x["detail"] for x in f), repr((b["blame"]["summary"].get("timeouts"), titles(f))))

    # 4. Processes ------------------------------------------------------------------
    f = processes.parse(sos)["findings"]
    d = [x for x in f if "uninterruptible sleep" in x["title"]]
    check("processes: the D-state finding hands the task's name to the hung-task page's search", d and d[0]["link"]["sub_tab"] == "kernel_hung_task" and d[0]["link"]["query"] and len(d[0]["link"]["query"]) <= 15, repr(d and d[0]["link"]))

    # 5. the pages ------------------------------------------------------------------
    c = client()
    for tab, sub in (("kernel", None), ("log_collection", None), ("sos_report", "blame")):
        rr = c.post("/load_tab", json={"directory": sos, "report_type": "sosreport", "tab": tab, "sub_tab": sub})
        html = (rr.get_json() or {}).get("html", "")
        check(f"page {sub or tab}: renders with the Findings strip", rr.status_code == 200 and 'class="ui-findings"' in html and html.count('class="ui-finding ') >= 1, f"status {rr.status_code}")
    rr = c.post("/load_tab", json={"directory": sos, "report_type": "sosreport", "tab": "kernel"})
    html = (rr.get_json() or {}).get("html", "")
    check("page kernel: three cards, each with a link to its tab", html.count('class="ui-card"') == 3 and 'data-tab="kernel" data-sub-tab="kernel_oom_killer"' in html and "OOM kills" in html and "Hung tasks" in html and "Stack traces" in html)

    shutil.rmtree(WORK, ignore_errors=True)
    failed = [l for l, ok in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
